// shared/premiumDiscount.mjs
// Where price sits inside its own range, and which direction that forbids.
//
// This exists because the FEED showed a LONG on GBP/USD while price was at the
// top of its range, and nothing in the app was capable of noticing. The engine
// vote counts how many methods point the same way. Not one of them knows where
// price is. Four engines can agree on "up" while price sits at the ceiling, and
// the vote reports that as a clean aligned read.
//
// The rule is the oldest one in this style of trading and it is not a
// preference: you buy the discount half of a range and sell the premium half.
// A long taken at the top is paying the full width of the range for whatever is
// left above it. The direction can be right and the trade still be bad, which is
// exactly the case the vote could not express.
//
// ── Why three timeframes, and why they are not equal ────────────────────────
//
// A range is only a range relative to a timeframe. Price can sit at 45% of the
// H4 dealing range and at 95% of the leg that has run since this morning. Both
// readings are true and they answer different questions.
//
//   H4   is the dealing range. It decides whether the trade is ALLOWED. This is
//        the one that vetoes, because it is the range the position is sized
//        against and held through.
//
//   M15  is the entry. It does not forbid anything. A long that is fine on H4
//        but stretched on M15 is a good idea at a bad moment, and the honest
//        report of that is "wait", not "no".
//
//   M2   is the fill. Same status as M15, one level finer.
//
// Making all three veto was the obvious design and it is wrong. Price is at the
// top of SOME two-minute leg most of the time, so an M2 veto would block nearly
// everything and the block would carry no information.
//
// ── What this deliberately refuses to answer ────────────────────────────────
//
// When price has left the range entirely — above the last swing high or below
// the last swing low — this returns `outside` rather than calling it an extreme
// premium. Price beyond the high is a breakout, and a breakout is the one case
// where buying above everything is the whole point. Reporting that as premium
// would veto exactly the trades the rule was never aimed at. An unknown that
// stays unknown cannot forbid anything, which is the correct behaviour for a
// measurement that has run out of range to measure against.

import { findSwings, alternate } from './structure.mjs';

/**
 * @typedef {{ t?:number|string, o:number, h:number, l:number, c:number }} Candle
 * @typedef {'premium'|'discount'|'equilibrium'|'outside'} Zone
 * @typedef {{ zone:Zone, pos:number|null, high:number, low:number, eq:number,
 *             above:boolean }} RangeRead
 */

/**
 * How close to the exact middle still counts as neither half.
 *
 * Without it, 50.01% is premium and 49.99% is discount, and a price oscillating
 * across the midpoint flips the verdict bar to bar. Five percent of the range is
 * narrow enough to keep the rule meaningful and wide enough that the answer does
 * not change on noise.
 */
export const EQ_BAND = 0.05;

/**
 * The dealing range: the most recent confirmed swing high and swing low.
 *
 * Confirmed matters. `findSwings` cannot return the last few bars as swings
 * because a swing is not a swing until price has turned away from it, so the
 * range here is one price has already reacted to rather than one drawn to the
 * current bar — which would put price at 100% or 0% of it by construction and
 * make every reading meaningless.
 *
 * @param {Candle[]} cs
 * @returns {{ high:number, low:number }|null} null when there is no completed
 *          swing of each kind, which is not a range and must not be guessed at.
 */
export function dealingRange(cs) {
  if (!cs || cs.length < 20) return null;
  const seq = alternate(findSwings(cs));
  const highs = seq.filter(s => s.kind === 'high');
  const lows = seq.filter(s => s.kind === 'low');
  if (!highs.length || !lows.length) return null;
  const high = highs[highs.length - 1].price;
  const low = lows[lows.length - 1].price;
  if (!(high > low)) return null;
  return { high, low };
}

/**
 * Where the given price sits in that range.
 *
 * `pos` is 0 at the low and 1 at the high, and is reported unclamped so a
 * caller can tell a marginal break from a violent one. `zone` is the decision.
 *
 * @param {Candle[]} cs
 * @param {number} price
 * @returns {RangeRead|null} null when no range can be measured.
 */
export function rangeRead(cs, price) {
  const r = dealingRange(cs);
  if (!r || !Number.isFinite(price)) return null;
  const pos = (price - r.low) / (r.high - r.low);
  const eq = (r.high + r.low) / 2;
  const out = { high: r.high, low: r.low, eq, pos, above: pos > 1, zone: /** @type {Zone} */('equilibrium') };
  if (pos > 1 || pos < 0) out.zone = 'outside';
  else if (pos > 0.5 + EQ_BAND) out.zone = 'premium';
  else if (pos < 0.5 - EQ_BAND) out.zone = 'discount';
  return out;
}

/**
 * Does this reading forbid this direction?
 *
 * Only the two wrong-side cases forbid. Equilibrium is not a forbidden place to
 * trade from, it is merely not an edge, and `outside` is a breakout the rule was
 * never about. A null read forbids nothing at all — a measurement that could not
 * be taken is not evidence against the trade.
 *
 * @param {RangeRead|null} read
 * @param {'up'|'down'|'long'|'short'|null} dir
 */
export function forbids(read, dir) {
  if (!read || !dir) return false;
  const long = dir === 'up' || dir === 'long';
  return long ? read.zone === 'premium' : read.zone === 'discount';
}

/**
 * The full three-timeframe read, and the single veto that comes out of it.
 *
 * @param {{ H4?:Candle[], M15?:Candle[], M2?:Candle[] }} byTf
 * @param {number} price
 * @param {'up'|'down'|'long'|'short'|null} dir
 * @returns {{ veto:string|null, timing:string|null, reads:Record<string,RangeRead|null> }}
 */
export function locationCheck(byTf, price, dir) {
  const reads = {
    H4: rangeRead(byTf.H4 || [], price),
    M15: rangeRead(byTf.M15 || [], price),
    M2: rangeRead(byTf.M2 || [], price),
  };
  const side = dir === 'up' || dir === 'long' ? 'long' : 'short';

  // H4 is the only one that can forbid. See the header.
  const h4 = reads.H4;
  const veto = h4 && forbids(h4, dir)
    ? `${side} at ${pct(h4.pos)} of the H4 range — ${h4.zone}`
    : null;

  // The faster two only ever say "not here, not yet".
  const late = ['M15', 'M2'].filter(tf => forbids(reads[tf], dir));
  const timing = veto || !late.length ? null
    : `${side} is ${reads[late[0]].zone} on ${late.join(' and ')} — the idea is fine, the level is not`;

  return { veto, timing, reads };
}

/** 0.4705 → "47%". Exported because two screens print it and must not round differently. */
export function pct(pos) {
  return Number.isFinite(pos) ? `${Math.round(pos * 100)}%` : '—';
}

// shared/liquidity.mjs
// Where the stops are, whether they were taken, and what confirms the turn.
//
// The model, in one line: a higher-timeframe level gets swept, price refuses to
// stay beyond it, and a two-minute change of character confirms the turn before
// you commit.
//
// ── Why this is a different question from everything measured so far ────────
//
// Every search this project has run asked "does this shape predict the next N
// bars". The answer, across 57 tested ideas and 360 scored conditions on eight
// instruments, was no. This asks something narrower and more answerable: price
// has ALREADY done something specific — it took a level that holds resting
// orders and immediately gave it back — and the only question left is whether
// the turn is confirmed. The direction is not being predicted from a pattern.
// It is being read from a failure that has already happened.
//
// That does not make it profitable. It makes it a different hypothesis, and it
// has not been tested here yet.
//
// ── What counts as a level ──────────────────────────────────────────────────
//
// Only levels that a lot of people can see and that hold orders:
//
//   PDH / PDL   yesterday's high and low
//   PWH / PWL   last week's high and low
//   H4 swings   confirmed four-hour swing highs and lows
//
// Not: round numbers, moving averages, or anything computed from an indicator.
// The premise is resting stops, and stops sit above old highs and below old
// lows because that is where people put them.
//
// ── What a sweep is, and what it is not ─────────────────────────────────────
//
// A sweep is price trading BEYOND the level and then closing back on the
// original side. Both halves are required. Trading beyond it and staying there
// is a breakout, which is the opposite trade, and treating the two as one event
// is how a sweep filter comes to mean nothing.
//
// The reversal direction is fixed by which side was taken. Sweeping a HIGH is
// bearish: the buy stops above it were filled by someone selling into them.
// Sweeping a LOW is bullish. There is no case where a swept high argues for a
// long, and the code has no branch that would allow one.

import { findSwings, alternate, detectBreaks } from './structure.mjs';

/**
 * @typedef {{ t?:number|string, o:number, h:number, l:number, c:number, v?:number }} Candle
 * @typedef {{ kind:string, price:number, side:'high'|'low', label:string }} Level
 * @typedef {{ level:Level, extreme:number, at:number, dir:'long'|'short',
 *             reclaimed:boolean }} Sweep
 * @typedef {{ type:string, direction:string, price:number, index:number,
 *             structure:string, label:string }} Break
 */

/** How many recent H4 swings are worth watching. Older ones have been traded through. */
export const H4_SWINGS = 3;

/**
 * The levels, from completed higher-timeframe candles.
 *
 * "Completed" is the whole point of taking [length - 2]: the last element of a
 * daily series is TODAY, still forming, and its high is wherever price happens
 * to be. Sweeping a level that is still being drawn is not an event, it is
 * arithmetic — today's high is by definition never exceeded by today's price.
 *
 * @param {{ daily?:Candle[], weekly?:Candle[], h4?:Candle[] }} series
 * @returns {Level[]}
 */
export function keyLevels({ daily, weekly, h4 } = {}) {
  /** @type {Level[]} */
  const out = [];
  const prior = cs => (cs && cs.length >= 2 ? cs[cs.length - 2] : null);

  const d = prior(daily);
  if (d) {
    out.push({ kind: 'PDH', price: d.h, side: 'high', label: "yesterday's high" });
    out.push({ kind: 'PDL', price: d.l, side: 'low', label: "yesterday's low" });
  }
  const w = prior(weekly);
  if (w) {
    out.push({ kind: 'PWH', price: w.h, side: 'high', label: "last week's high" });
    out.push({ kind: 'PWL', price: w.l, side: 'low', label: "last week's low" });
  }
  if (h4 && h4.length >= 20) {
    const seq = alternate(findSwings(h4));
    const highs = seq.filter(s => s.kind === 'high').slice(-H4_SWINGS);
    const lows = seq.filter(s => s.kind === 'low').slice(-H4_SWINGS);
    for (const s of highs) out.push({ kind: 'H4H', price: s.price, side: 'high', label: 'H4 swing high' });
    for (const s of lows) out.push({ kind: 'H4L', price: s.price, side: 'low', label: 'H4 swing low' });
  }
  return out;
}

/**
 * Has one of these levels been swept and given back, in the recent window?
 *
 * Scans the last `within` bars of the execution series. A level is swept when
 * some bar in the window traded beyond it AND the latest close is back on the
 * original side. Price still sitting beyond the level is a breakout and returns
 * nothing, which is the correct answer rather than a missing feature.
 *
 * When several levels qualify, the one taken FURTHEST is returned. Taking two
 * levels at once is one event, and the deeper one is the one that ran the stops.
 *
 * @param {Candle[]} cs execution series, newest last
 * @param {Level[]} levels
 * @param {{ within?:number }} [opts]
 * @returns {Sweep|null}
 */
export function findSweep(cs, levels, { within = 60 } = {}) {
  if (!cs || cs.length < 5 || !levels || !levels.length) return null;
  const n = cs.length;
  const from = Math.max(0, n - within);
  const last = cs[n - 1].c;

  /** @type {Sweep|null} */
  let best = null;
  for (const level of levels) {
    const high = level.side === 'high';
    // Price must be back on the original side NOW. This is what separates a
    // sweep from a breakout, and it is checked against the latest close rather
    // than the sweeping bar's own close so that a level taken and reclaimed
    // over several bars still counts.
    if (high ? last >= level.price : last <= level.price) continue;

    let extreme = high ? -Infinity : Infinity, at = -1;
    for (let i = from; i < n; i++) {
      const beyond = high ? cs[i].h > level.price : cs[i].l < level.price;
      if (!beyond) continue;
      const v = high ? cs[i].h : cs[i].l;
      if (high ? v > extreme : v < extreme) { extreme = v; at = i; }
    }
    if (at < 0) continue;

    const depth = Math.abs(extreme - level.price);
    if (!best || depth > Math.abs(best.extreme - best.level.price)) {
      // Sweeping a high is bearish and sweeping a low is bullish. There is no
      // third case: the side taken decides the direction, not a preference.
      best = { level, extreme, at, dir: high ? 'short' : 'long', reclaimed: true };
    }
  }
  return best;
}

/**
 * The confirmation: a break of structure on the execution series, after the
 * sweep, pointing the way the sweep implies.
 *
 * A CHoCH is what this is looking for — the first break against the prevailing
 * move is precisely the signature of a turn. A plain break in a ranging market
 * is accepted too, because "ranging" here means the structure read found no
 * trend to reverse, not that nothing happened. A BOS in the sweep's direction
 * also qualifies: the label depends on what the trend was, and refusing a
 * continuation that happens to point the right way after a sweep would reject
 * the setup on a naming technicality.
 *
 * What is NOT accepted is a break the other way. That is the same defect that
 * lived in the bot for months, and it is checked explicitly here.
 *
 * @param {Candle[]} cs
 * @param {Sweep} sweep
 * @param {{ maxBars?:number }} [opts] how long after the sweep a confirmation
 *        still counts. Beyond this the sweep is stale and the move has gone.
 */
export function confirmation(cs, sweep, { maxBars = 30 } = {}) {
  if (!cs || !sweep) return null;
  const want = sweep.dir === 'long' ? 'bullish' : 'bearish';
  const breaks = detectBreaks(cs, { within: Math.min(maxBars, cs.length - 1), max: 8 });

  // The EARLIEST qualifying break, not the latest.
  //
  // This is the moment the setup triggered, and it is the price a person could
  // actually have got. Taking the most recent break instead reports the trade
  // as available now at whatever the current bar closed at, which is how a move
  // you watched go past turns into a ticket that looks live. `detectBreaks`
  // returns newest first and attaches each broken level to the newest bar that
  // broke it, so the last match in that list is the first one in time.
  /** @type {Break|null} */
  let first = null;
  for (const b of breaks) {
    if (b.index <= sweep.at) continue;      // must come AFTER the liquidity was taken
    if (b.index - sweep.at > maxBars) continue;
    if (b.direction !== want) continue;      // the defect this exists to prevent
    if (!first || b.index < first.index) first = b;
  }
  return first;
}

/**
 * The whole setup, or null.
 *
 * Returns the pieces a ticket needs and nothing else: which way, where to get
 * in, where the idea is wrong. Size is deliberately not computed here — it
 * depends on the account, and shared/position.mjs already owns that.
 *
 * The stop goes BEYOND the swept extreme, not at the level. Price already
 * proved it can reach the extreme; a stop at the level is inside the range of a
 * move that has demonstrably happened, and would be taken by a retest that
 * changes nothing about the idea.
 *
 * @param {{ daily?:Candle[], weekly?:Candle[], h4?:Candle[], exec:Candle[] }} series
 * @param {{ within?:number, maxBars?:number, pad?:number, freshBars?:number }} [opts]
 *        `pad` is the cushion beyond the extreme, as a fraction of the sweep
 *        depth, and is where a caller adds the spread. `freshBars` is how
 *        recently the confirmation must have printed for the entry to still be
 *        available.
 */
export function sweepSetup(series, { within = 60, maxBars = 30, pad = 0.1, freshBars = 3 } = {}) {
  const exec = series?.exec;
  if (!exec || exec.length < 20) return null;

  const levels = keyLevels(series);
  const sweep = findSweep(exec, levels, { within });
  if (!sweep) return null;

  const confirm = confirmation(exec, sweep, { maxBars });
  // `dir` belongs on BOTH returns. Leaving it off this one shipped a live
  // defect: the waiting row read `setup.dir`, got undefined, and its ternary
  // fell to the else branch — so every swept level, high or low, was announced
  // as waiting for a bearish break. A swept LOW is bullish. The direction was
  // correct inside the sweep the whole time and simply never travelled out.
  if (!confirm) return { sweep, levels, confirm: null, ready: false, dir: sweep.dir };

  const depth = Math.abs(sweep.extreme - sweep.level.price);
  const cushion = Math.max(depth * pad, 0);

  // The entry is the CONFIRMATION bar's close, not the latest price.
  //
  // Using the newest bar looks equivalent and is not. If the break happened
  // twenty bars ago, price has travelled, and pricing the entry at today's
  // close while the stop still sits beyond the swept extreme silently widens
  // the risk to cover a move that already happened. The trade was available at
  // the break. Quoting it later at a worse level, with the same stop, invents a
  // fill nobody could have got.
  const entry = exec[confirm.index].c;
  const stop = sweep.dir === 'long' ? sweep.extreme - cushion : sweep.extreme + cushion;

  // And if that break is not recent, the entry is not available any more. This
  // is the honest version of "you missed it", and it is a different state from
  // "there was no setup".
  const age = (exec.length - 1) - confirm.index;
  const fresh = age <= freshBars;

  // A confirmation already the wrong side of its own stop is not an entry, it
  // is a trade whose risk is inverted before it is placed.
  const valid = sweep.dir === 'long' ? entry > stop : entry < stop;

  return {
    sweep, levels, confirm, ready: valid && fresh,
    dir: sweep.dir,
    entry, stop, age, fresh,
    risk: Math.abs(entry - stop),
    reason: `${sweep.level.label} swept and reclaimed, then ${confirm.type} ${sweep.dir === 'long' ? 'up' : 'down'}`
      + (fresh ? '' : ` — ${age} bars ago, the entry has gone`),
  };
}

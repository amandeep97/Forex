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
 * @typedef {{ level:Level, distance:number, atr:number, pct:number }} Approach
 */

/** How many recent H4 swings are worth watching. Older ones have been traded through. */
export const H4_SWINGS = 3;

/**
 * Which levels matter more, when several are in play.
 *
 * This is not decoration. The first version ranked levels by how far price went
 * beyond them, so an H4 swing an inch away beat yesterday's high a mile away,
 * and on the first live run the model reported an H4 swing low on EUR/USD while
 * the daily levels went unmentioned. For an intraday trader the daily high and
 * low are THE liquidity — they are where a whole session's stops sit — and an
 * H4 swing is a lesser landmark that happens to be closer.
 *
 * Depth still breaks ties within a rank. It no longer outranks the level's own
 * importance.
 */
export const LEVEL_RANK = { PDH: 3, PDL: 3, PWH: 2, PWL: 2, H4H: 1, H4L: 1 };

const rankOf = l => LEVEL_RANK[l?.kind] ?? 0;

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
 * When several levels qualify the most IMPORTANT one is returned — yesterday's
 * high and low first, then last week's, then H4 swings — with depth breaking
 * ties inside a rank. Taking two levels at once is one event, and which of them
 * to name is a question about what a trader is watching, not about arithmetic.
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

    // Rank first, depth only to break a tie inside a rank. Yesterday's high
    // beats an H4 swing even when the H4 swing was taken further, because for
    // an intraday trader the daily level is where the session's stops are and
    // the H4 swing is a smaller landmark that happened to be nearer.
    const depth = Math.abs(extreme - level.price);
    const better = !best
      || rankOf(level) > rankOf(best.level)
      || (rankOf(level) === rankOf(best.level) && depth > Math.abs(best.extreme - best.level.price));
    if (better) {
      // Sweeping a high is bearish and sweeping a low is bullish. There is no
      // third case: the side taken decides the direction, not a preference.
      best = { level, extreme, at, dir: high ? 'short' : 'long', reclaimed: true };
    }
  }
  return best;
}

/**
 * Every level's own state, so a screen can put one in each column.
 *
 * findSweep and approach both answer "which ONE level matters most", which is
 * the right question for an alert and the wrong one for a table. Asked for a
 * row per instrument with a column per level — did it hunt the daily high, did
 * it hunt the weekly low — a single best-level answer hides five of the six
 * facts, and which one survives depends on a ranking the reader cannot see.
 *
 * Five states, and the distinction between the first two is the whole model:
 *
 *   swept   crossed the level and came back. Liquidity taken.
 *   through crossed it and STAYED. A breakout, the opposite trade.
 *   behind  beyond it for the entire window — the level is behind price and
 *           nothing happened here recently.
 *   near    within the band, not taken yet. The waiting state.
 *   quiet   far enough away to be no part of today.
 *
 * "Crossed" means price was on BOTH sides inside the window. The first version
 * asked only whether some bar went beyond the level, which is true for any
 * level price has been on the far side of for days, so a level broken last week
 * read exactly like one broken ten minutes ago and the table came out a wall of
 * one colour. It reported where price IS; the table is meant to show what it
 * DID.
 *
 * @param {Candle[]} cs execution series, newest last
 * @param {Level[]} levels
 * @param {number} atr the instrument's own scale
 * @param {{ within?:number, near?:number }} [opts] `within` is how many bars
 *        back a sweep may have happened; `near` is the approach band in ATR.
 * @returns {Array<{kind:string, price:number, label:string, side:string,
 *                  state:'swept'|'through'|'behind'|'near'|'quiet', dir:'long'|'short'|null,
 *                  distance:number, atrPct:number|null, extreme:number|null, at:number|null}>}
 */
export function levelStates(cs, levels, atr, { within = 60, near = 0.5 } = {}) {
  if (!cs || !cs.length || !levels?.length) return [];
  const n = cs.length;
  const from = Math.max(0, n - within);
  const price = cs[n - 1].c;

  return levels.map(level => {
    const high = level.side === 'high';
    const distance = Math.abs(price - level.price);
    const atrPct = atr > 0 ? distance / atr : null;

    // Did price go beyond it at any point in the window, and how far?
    //
    // `wasInside` is the half this originally lacked, and leaving it out turned
    // the whole table purple. Without it, "some bar went beyond the level" is
    // true for any level price has simply been on the far side of for days —
    // every bar in the window is beyond it, so a level broken last Tuesday read
    // exactly like one broken ten minutes ago. That reports where price IS, not
    // what it DID, and the table is meant to show events.
    let extreme = high ? -Infinity : Infinity;
    /** @type {number|null} */
    let at = null;
    let wasInside = false;
    for (let i = from; i < n; i++) {
      const beyond = high ? cs[i].h > level.price : cs[i].l < level.price;
      if (!beyond) { wasInside = true; continue; }
      const v = high ? cs[i].h : cs[i].l;
      if (high ? v > extreme : v < extreme) { extreme = v; at = i; }
    }
    // A crossing needs both: price beyond the level AND price on the original
    // side, inside the same window. One without the other is not an event.
    const crossed = at !== null && wasInside;
    // Back on the original side NOW is what separates a sweep from a breakout.
    const backInside = high ? price < level.price : price > level.price;

    /** @type {'swept'|'through'|'behind'|'near'|'quiet'} */
    let state = 'quiet';
    if (crossed && backInside) state = 'swept';
    else if (crossed) state = 'through';
    // Beyond it for the whole window: the level is behind price and is not an
    // event any more. Worth showing — it says which side of the level you are
    // on — but it must not look like something that just happened.
    else if (at !== null) state = 'behind';
    else if (atrPct !== null && atrPct <= near) state = 'near';

    return {
      kind: level.kind, price: level.price, label: level.label, side: level.side,
      state,
      // Only a sweep implies a direction. "Near" has not decided anything yet
      // and a breakout points the other way from a sweep of the same level.
      dir: state === 'swept' ? (high ? 'short' : 'long') : null,
      distance, atrPct,
      extreme: at !== null ? extreme : null,
      at,
    };
  });
}

/**
 * Price approaching a level it has not taken yet.
 *
 * The other half of the request, and the half that was missing. "Swept or NEAR
 * the daily high or low" is one instruction with two states, and only the sweep
 * was ever reported. Proximity existed in the bot purely as a cost gate —
 * decide whether an instrument is worth a request, then throw the number away —
 * so the screen could never say "price is eight pips under yesterday's high,
 * watch it", which is the state a trader actually waits in.
 *
 * An approach is NOT a trade and carries no direction. Price walking up to
 * yesterday's high may sweep it and reverse, or go through it and run. Which of
 * those happens is exactly what has not been decided yet, and naming a side
 * here would be inventing the answer.
 *
 * @param {Candle[]} cs
 * @param {Level[]} levels
 * @param {number} atr the instrument's own scale — a fixed pip count cannot
 *        serve gold at 4300 and EUR/USD at 1.08
 * @param {{ within?:number }} [opts] how many ATR counts as approaching
 * @returns {{ level:Level, distance:number, atr:number, pct:number }|null}
 */
export function approach(cs, levels, atr, { within = 0.5 } = {}) {
  if (!cs || !cs.length || !levels?.length || !(atr > 0)) return null;
  const price = cs[cs.length - 1].c;
  if (!Number.isFinite(price)) return null;

  /** @type {Approach|null} */
  let best = null;
  for (const level of levels) {
    // Only levels price has NOT gone past. Beyond it is a sweep or a breakout,
    // both of which are other functions' business.
    const untaken = level.side === 'high' ? price < level.price : price > level.price;
    if (!untaken) continue;
    const distance = Math.abs(price - level.price);
    if (distance > atr * within) continue;
    // Same ranking as a sweep: a daily level being approached matters more than
    // an H4 swing being approached, however much closer the H4 swing is.
    const better = !best
      || rankOf(level) > rankOf(best.level)
      || (rankOf(level) === rankOf(best.level) && distance < best.distance);
    if (better) best = { level, distance, atr, pct: distance / atr };
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

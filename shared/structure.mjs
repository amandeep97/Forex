// shared/structure.mjs
// Market structure, and what it means to break it — the one copy.
//
// This existed twice, in vps-bot/src/smc.js and again inside BotConfig.jsx, and
// the two had already drifted apart. The app's version returned a bare boolean
// that was true for a break in EITHER direction; the bot's distinguished a
// break of structure from a change of character. So the preview could explain a
// match the bot refused, and neither screen could say which was right.
//
// ── Three defects this fixes, all of them found by reading rather than by a
//    test failing ──────────────────────────────────────────────────────────
//
// DIRECTION WAS NEVER CHECKED. `bos: !requireBOS || smc.hasBOS` has no
// direction term in it. A long strategy with "Require BOS / CHoCH" set would
// pass on price breaking DOWN through a swing low, which is the opposite of
// what was asked for. bosDirection was computed and used exactly zero times.
//
// CHoCH WAS COMPUTED AND NEVER USED. The switch says "BOS / CHoCH". The bot
// required a BOS specifically and ignored a change of character entirely, so
// the one signal that marks a reversal beginning could not satisfy the control
// named after it.
//
// AND THE TREND WAS DECIDED TWICE, DIFFERENTLY. detectStructure read the last
// two swing highs and lows. detectBOS decided bull-or-bear by comparing the
// LAST swing high in the window to the FIRST one — over two hundred bars that
// is barely a trend measure at all. The two could disagree, and when they did,
// a continuation was labelled a reversal or the reverse.
//
// ── What "higher low" actually requires ─────────────────────────────────────
//
// The old read compared highs[-1] to highs[-2] and lows[-1] to lows[-2] as two
// independent lists, with no regard for the order the four points occurred in.
// Structure is a SEQUENCE: high, low, high, low. Two highs in a row with no low
// between them are one high — the higher of the two — because price never
// turned in between. Cleaning that up before comparing is the difference
// between reading structure and reading two arrays.

/**
 * `t` is optional and may be a string: nothing here reads it, the bot carries
 * epoch milliseconds and the app's OANDA fetch carries an ISO timestamp. Typing
 * it as a required number said this module could not accept the candles the app
 * has been handing it all along, which was a wrong description of working code.
 *
 * @typedef {{ t?:number|string, o:number, h:number, l:number, c:number, v?:number }} Candle
 * @typedef {{ kind:'high'|'low', price:number, idx:number }} Swing
 */

export const SWING_LOOK = 3;

/**
 * Fractal swings: a bar strictly higher (or lower) than `look` bars on BOTH
 * sides.
 *
 * The last `look` bars can never qualify, and that is correct rather than a
 * limitation — a swing is not a swing until price has turned away from it, and
 * anything that called the newest bar a swing would be reading the future.
 *
 * @param {Candle[]} cs
 * @param {number} look
 * @returns {Swing[]} in time order, highs and lows interleaved
 */
export function findSwings(cs, look = SWING_LOOK) {
  /** @type {Swing[]} */
  const out = [];
  if (!cs || cs.length < look * 2 + 1) return out;
  for (let i = look; i < cs.length - look; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= look; j++) {
      if (cs[i].h <= cs[i - j].h || cs[i].h <= cs[i + j].h) hi = false;
      if (cs[i].l >= cs[i - j].l || cs[i].l >= cs[i + j].l) lo = false;
    }
    if (hi) out.push({ kind: 'high', price: cs[i].h, idx: i });
    if (lo) out.push({ kind: 'low', price: cs[i].l, idx: i });
  }
  return out.sort((a, b) => a.idx - b.idx);
}

/**
 * Force the swings to alternate high, low, high, low.
 *
 * Two highs in a row mean price never turned between them, so they are one
 * high: the higher. Two lows in a row are one low: the lower. Without this,
 * "the last two highs" can be two points from the same leg and the comparison
 * says nothing about structure.
 *
 * @param {Swing[]} swings
 * @returns {Swing[]}
 */
export function alternate(swings) {
  /** @type {Swing[]} */
  const out = [];
  for (const s of swings) {
    const last = out[out.length - 1];
    if (!last || last.kind !== s.kind) { out.push(s); continue; }
    const keepNew = s.kind === 'high' ? s.price > last.price : s.price < last.price;
    if (keepNew) out[out.length - 1] = s;
  }
  return out;
}

/**
 * The structure read: bullish, bearish or ranging, with the points it used.
 *
 * Bullish needs a higher high AND a higher low, from an alternating sequence,
 * so "higher low" means the low that actually followed the previous high.
 *
 * @param {Candle[]} cs
 * @param {number} look
 */
export function readStructure(cs, look = SWING_LOOK) {
  const seq = alternate(findSwings(cs, look));
  const highs = seq.filter(s => s.kind === 'high');
  const lows = seq.filter(s => s.kind === 'low');
  const out = {
    structure: 'ranging', seq,
    lastHigh: highs[highs.length - 1] || null,
    prevHigh: highs[highs.length - 2] || null,
    lastLow: lows[lows.length - 1] || null,
    prevLow: lows[lows.length - 2] || null,
    higherHigh: false, higherLow: false, lowerHigh: false, lowerLow: false,
  };
  if (highs.length < 2 || lows.length < 2) return out;

  out.higherHigh = out.lastHigh.price > out.prevHigh.price;
  out.lowerHigh = out.lastHigh.price < out.prevHigh.price;
  out.higherLow = out.lastLow.price > out.prevLow.price;
  out.lowerLow = out.lastLow.price < out.prevLow.price;

  if (out.higherHigh && out.higherLow) out.structure = 'bullish';
  else if (out.lowerHigh && out.lowerLow) out.structure = 'bearish';
  return out;
}

/**
 * A break of structure, or a change of character, WITH its direction.
 *
 * BOS   a close beyond a prior swing in the SAME direction as the trend.
 *       Continuation.
 * CHoCH a close beyond a prior swing AGAINST the trend. The first sign the
 *       trend is over, which is the whole reason the term exists.
 *
 * Which of the two it is depends entirely on what the trend was, so the trend
 * comes from readStructure rather than from a second, different measure. That
 * was the bug: two notions of "bull or bear" in one analysis, free to disagree.
 *
 * A ranging market has no trend to continue or reverse, so a break there is
 * reported with its direction and neither label. Calling it one or the other
 * would be inventing a trend to classify against.
 *
 * @param {Candle[]} cs
 * @param {{ look?:number, within?:number }} [opts] `within` = how many recent
 *        bars may carry the break.
 */
export function detectBreak(cs, { look = 2, within = 15 } = {}) {
  const none = { hasBOS: false, hasCHoCH: false, direction: null, structure: 'ranging', at: null };
  if (!cs || cs.length < 20) return none;
  const n = cs.length;

  // Swings from everything but the last bar, so the bar being judged cannot be
  // part of the level it is breaking.
  const trend = readStructure(cs.slice(0, n - 1), 3).structure;
  const seq = alternate(findSwings(cs.slice(0, n - 1), look));

  // BACKWARD from the newest bar, so the MOST RECENT break wins.
  //
  // Scanning forward returns the oldest break inside the window, which means a
  // break from fifteen bars ago outranks one that happened since — and when
  // the two point opposite ways, the answer is not merely stale, it is the
  // wrong direction. The original scanned forward and had this too.
  const oldest = Math.max(look * 2, n - within);
  for (let i = n - 1; i >= oldest; i--) {
    const c = cs[i];
    // A swing is only usable once it is confirmed, which takes `look` bars
    // after it. Using one sooner is reading the future.
    const usable = seq.filter(s => s.idx + look < i);
    const brokeUp = usable.some(s => s.kind === 'high' && c.c > s.price);
    const brokeDown = usable.some(s => s.kind === 'low' && c.c < s.price);
    if (!brokeUp && !brokeDown) continue;

    // Both in one bar is a range expansion, not a structural statement.
    if (brokeUp && brokeDown) continue;

    const direction = brokeUp ? 'bullish' : 'bearish';
    const withTrend = (trend === 'bullish' && brokeUp) || (trend === 'bearish' && brokeDown);
    const againstTrend = (trend === 'bullish' && brokeDown) || (trend === 'bearish' && brokeUp);
    return {
      hasBOS: withTrend,
      hasCHoCH: againstTrend,
      direction,
      structure: trend,
      at: i,
    };
  }
  return { ...none, structure: trend };
}

/**
 * Does this break satisfy a strategy asking for one, in the direction it trades?
 *
 * The control is labelled "BOS / CHoCH" so it accepts either. What it will NOT
 * accept any more is a break the other way: a long strategy used to pass on
 * price breaking DOWN through a swing low, because the check had no direction
 * term in it at all.
 *
 * @param {{hasBOS:boolean, hasCHoCH:boolean, direction:string|null}} brk
 * @param {'long'|'short'} dir
 */
export function breakSatisfies(brk, dir) {
  if (!brk || (!brk.hasBOS && !brk.hasCHoCH)) return false;
  return brk.direction === (dir === 'long' ? 'bullish' : 'bearish');
}

/**
 * Every recent break, newest first — for a chart or a tag row that wants to
 * show more than the latest one.
 *
 * Same classification as detectBreak, which now delegates here, so the tag on a
 * screener row and the decision the bot makes cannot disagree about whether a
 * break was a continuation or a reversal.
 *
 * @param {Candle[]} cs
 * @param {{ look?:number, within?:number, max?:number }} [opts]
 */
export function detectBreaks(cs, { look = 2, within = 18, max = 6 } = {}) {
  if (!cs || cs.length < 20) return [];
  const n = cs.length;
  const trend = readStructure(cs.slice(0, n - 1), 3).structure;
  const seq = alternate(findSwings(cs.slice(0, n - 1), look));
  const out = [];
  const used = new Set();

  for (let i = n - 1; i >= Math.max(look * 2, n - within) && out.length < max; i--) {
    const c = cs[i];
    const usable = seq.filter(s => s.idx + look < i);
    const hi = usable.find(s => s.kind === 'high' && c.c > s.price && !used.has(`H${s.idx}`));
    const lo = usable.find(s => s.kind === 'low' && c.c < s.price && !used.has(`L${s.idx}`));
    // Both in one bar is a range expansion, not a structural statement.
    if (hi && lo) continue;
    const s = hi || lo;
    if (!s) continue;
    used.add(`${s.kind === 'high' ? 'H' : 'L'}${s.idx}`);
    const direction = hi ? 'bullish' : 'bearish';
    const withTrend = (trend === 'bullish' && hi) || (trend === 'bearish' && lo);
    const against = (trend === 'bullish' && lo) || (trend === 'bearish' && hi);
    // Ranging gets neither label. Forcing one, as the screener used to by
    // having no ranging state at all, means every break in a sideways market is
    // called a continuation or a reversal of a trend that is not there.
    const type = withTrend ? 'BOS' : against ? 'CHoCH' : 'BREAK';
    out.push({
      type, direction, price: s.price, index: i, structure: trend,
      label: `${type} ${hi ? '\u2191' : '\u2193'}`,
    });
  }
  return out;
}


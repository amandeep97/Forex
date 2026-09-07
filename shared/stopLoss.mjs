// shared/stopLoss.mjs
// Where the stop goes, for every method the strategy builder offers.
//
// Pulled out of the bot for two reasons. It is arithmetic worth testing on
// its own, and one of the four methods was silently not implemented: "Order
// Block Base" fell through the if-chain and became an ATR stop, while the note
// under the dropdown said "SL below the base of the entry Order Block". Same
// class of bug as the three dead condition switches — a control that does not
// control anything, which is worse than a missing one because you trust it.
//
// Every method returns { price, why } or null. Null means the method could not
// be computed — no swing found, no order block, no candle — and the caller must
// refuse the trade rather than fall back to something else. A stop quietly
// placed by a different rule than the one chosen is a position sized wrong.

export const SL_METHODS = ['swing', 'ob', 'atr', 'fixed', 'candle'];

/**
 * One pip, in price units.
 *
 * These are the BOT's rules, deliberately, because the bot is what places the
 * order — the app screen mirroring it has to agree with the executor rather
 * than with the Backtester. The Backtester's getPipSize differs on oil and
 * indices (0.01 and 1.0 against 0.0001 here). That difference is real and
 * pre-dates this file; it is left alone rather than "fixed" in passing, because
 * changing it would change live position sizing on those instruments, which is
 * not a thing to do as a side effect of adding a stop method.
 */
export function pipSizeFor(pair) {
  const p = String(pair || '').toUpperCase();
  if (p.includes('JPY')) return 0.01;
  if (p.includes('XAU')) return 0.10;
  if (p.includes('XAG')) return 0.001;
  if (p.includes('BTC') || p.includes('ETH')) return 1;
  return 0.0001;
}

/**
 * Where the stop goes.
 *
 * `price` is the intended entry (mid), `pip` one pip in price units, `candles`
 * complete bars oldest first with the last being the signal candle, and
 * `spread` the CURRENT ask minus bid — or null when it could not be read, which
 * is a refusal rather than a zero.
 *
 * @typedef {{ t:number, o:number, h:number, l:number, c:number, v?:number }} Candle
 * @typedef {{ type:string, top:number, bottom:number, high:number, low:number }} OrderBlock
 *
 * The strategy's risk block. Every field optional because a saved strategy
 * predates most of them; the defaults below are the behaviour that shipped.
 * @typedef {{
 *   slMethod?: 'swing'|'ob'|'atr'|'fixed'|'candle',
 *   slAtr?: number, slPips?: number, slCandles?: number, slBufferPips?: number
 * }} RiskBlock
 *
 * What analyzeSMC hands over. Any of these can be missing on a thin history,
 * which is exactly why every method here returns null rather than guessing.
 * @typedef {{
 *   atr?: number|null,
 *   recentSwingLow?: number|null, recentSwingHigh?: number|null,
 *   activeBullOB?: OrderBlock|null, activeBearOB?: OrderBlock|null
 * }} SmcRead
 *
 * @param {{ dir:'long'|'short', price:number, pip:number,
 *           risk?:RiskBlock, smc?:SmcRead, candles?:Candle[]|null, spread?:number|null }} a
 * @returns {{ price:number, why:string }|null}
 */
export function stopFor({ dir, price, pip, risk = {}, smc = {}, candles = null, spread = null }) {
  const method = risk.slMethod || 'atr';
  const long = dir === 'long';
  const buf = pip * (risk.slBufferPips ?? 3);

  if (method === 'swing') {
    const lvl = long ? smc.recentSwingLow : smc.recentSwingHigh;
    if (lvl == null || !(lvl > 0)) return null;
    return { price: long ? lvl - buf : lvl + buf,
             why: `${(risk.slBufferPips ?? 3)} pips beyond the recent swing ${long ? 'low' : 'high'}` };
  }

  // The base of the order block being entered from — its far edge, the level
  // that has to break for the idea to be wrong.
  if (method === 'ob') {
    const ob = long ? smc.activeBullOB : smc.activeBearOB;
    const lvl = long ? ob?.low : ob?.high;
    if (lvl == null || !(lvl > 0)) return null;
    return { price: long ? lvl - buf : lvl + buf,
             why: `${(risk.slBufferPips ?? 3)} pips beyond the ${long ? 'low' : 'high'} of the entry order block` };
  }

  if (method === 'fixed') {
    const pips = risk.slPips || 20;
    return { price: long ? price - pips * pip : price + pips * pip,
             why: `${pips} pips from entry` };
  }

  // ── The signal candle, with the spread ───────────────────────────────────
  //
  // The stop sits just beyond the low (long) or high (short) of the bar the
  // setup printed on, which is the level that says the read was wrong.
  //
  // The spread is added on top, and that is not cosmetic. Candles here are MID
  // prices, but a long is closed at the BID, which sits half a spread below the
  // mid — so a stop placed exactly at the mid low is already inside the bid's
  // reach and gets taken on a bar that never actually traded through the level.
  // The full spread is used rather than half, deliberately: half is the correct
  // arithmetic at a constant spread, and the spread is not constant. It widens
  // at exactly the moments a stop is nearest.
  //
  // A missing spread is NOT treated as zero. A zero would silently place the
  // stop tighter than asked, which is the failure that costs money, so the
  // method refuses and the caller skips the trade.
  if (method === 'candle') {
    const n = risk.slCandles ?? 1;
    if (!candles?.length || candles.length < n) return null;
    const win = candles.slice(-n);
    const lvl = long ? Math.min(...win.map(c => c.l)) : Math.max(...win.map(c => c.h));
    if (!(lvl > 0)) return null;
    if (spread == null || !Number.isFinite(spread) || spread < 0) return null;
    const pad = spread + buf;
    const bars = n === 1 ? 'the signal candle' : `the last ${n} candles`;
    return {
      price: long ? lvl - pad : lvl + pad,
      why: `${(pad / pip).toFixed(1)} pips beyond the ${long ? 'low' : 'high'} of ${bars}`
         + ` (${(spread / pip).toFixed(1)} of that is the spread)`,
    };
  }

  const mult = risk.slAtr || 1.5;
  const atr = smc.atr;
  if (atr == null || !(atr > 0)) return null;
  return { price: long ? price - atr * mult : price + atr * mult,
           why: `${mult} ATR from entry` };
}

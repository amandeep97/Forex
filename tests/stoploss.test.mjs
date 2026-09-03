// Where the stop goes — shared/stopLoss.mjs.
//
// The bug that motivated pulling this out: "Order Block Base" was a dropdown
// option that fell through the bot's if-chain and became an ATR stop, while the
// note under it said "SL below the base of the entry Order Block". So the
// checks below care most about two things — that each method uses the level it
// names, and that a method which CANNOT be computed returns null so the caller
// skips, rather than silently placing the stop by a different rule.
//
// A stop placed by a different rule than the one chosen is also a position
// sized wrong, since size is derived from the stop distance. It is not a
// cosmetic bug.
import { stopFor, pipSizeFor, SL_METHODS } from '../shared/stopLoss.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

const PIP = 0.0001;
const bar = (o, h, l, c) => ({ o, h, l, c });
const smc = {
  atr: 0.0020,
  recentSwingLow: 1.0900, recentSwingHigh: 1.1100,
  activeBullOB: { type: 'bullish', top: 1.0960, bottom: 1.0940, high: 1.0965, low: 1.0930 },
  activeBearOB: { type: 'bearish', top: 1.1060, bottom: 1.1040, high: 1.1070, low: 1.1035 },
};
const candles = [bar(1.0990, 1.1005, 1.0980, 1.1000), bar(1.1000, 1.1020, 1.0975, 1.1010)];
const ENTRY = 1.1010;

// ── Each method uses the level it names ─────────────────────────────────────
{
  const swing = stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'swing' }, smc });
  check('the swing stop sits below the swing low by the buffer',
    near(swing.price, 1.0900 - 3 * PIP), swing.price.toFixed(5));

  const ob = stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'ob' }, smc });
  check('the order-block stop uses the ORDER BLOCK, not the ATR',
    near(ob.price, 1.0930 - 3 * PIP), ob.price.toFixed(5));
  check('and it is a different price from the ATR stop, which is the whole bug',
    !near(ob.price, stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'atr' }, smc }).price),
    'this option used to fall through and become an ATR stop');

  const atr = stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'atr', slAtr: 2 }, smc });
  check('the ATR stop is the multiple from entry', near(atr.price, ENTRY - 0.0040));

  const fixed = stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'fixed', slPips: 25 }, smc });
  check('the fixed stop is the pip count from entry', near(fixed.price, ENTRY - 25 * PIP));

  check('every method in the list is reachable',
    SL_METHODS.every(m => stopFor({ dir: 'long', price: ENTRY, pip: PIP,
      risk: { slMethod: m }, smc, candles, spread: 0.0002 }) != null),
    SL_METHODS.join(', '));
}

// ── The signal candle, and the spread ───────────────────────────────────────
{
  const spread = 0.0002;   // 2 pips
  const r = stopFor({ dir: 'long', price: ENTRY, pip: PIP,
    risk: { slMethod: 'candle' }, smc, candles, spread });
  check('a long stop sits below the signal candle LOW',
    near(r.price, 1.0975 - spread - 3 * PIP), r.price.toFixed(5));
  check('and the spread is genuinely included, not decoration',
    near(ENTRY - r.price, ENTRY - 1.0975 + spread + 3 * PIP)
    && r.price < 1.0975 - 3 * PIP,
    'a stop at the mid low is already inside the bid’s reach');
  check('the reason says how much of the distance was spread',
    /2\.0 of that is the spread/.test(r.why), r.why);

  const short = stopFor({ dir: 'short', price: 1.0990, pip: PIP,
    risk: { slMethod: 'candle' }, smc, candles, spread });
  check('a short stop sits above the signal candle HIGH',
    near(short.price, 1.1020 + spread + 3 * PIP), short.price.toFixed(5));

  // A wider spread must push the stop further away, never nearer.
  const wide = stopFor({ dir: 'long', price: ENTRY, pip: PIP,
    risk: { slMethod: 'candle' }, smc, candles, spread: 0.0010 });
  check('a wider spread pushes the stop further out',
    wide.price < r.price,
    'a spread widens exactly when the stop is nearest, so it must move away');

  const two = stopFor({ dir: 'long', price: ENTRY, pip: PIP,
    risk: { slMethod: 'candle', slCandles: 2 }, smc, candles, spread });
  check('covering two candles uses the lower of the two lows',
    near(two.price, 1.0975 - spread - 3 * PIP), two.price.toFixed(5));
  const twoShort = stopFor({ dir: 'short', price: 1.0990, pip: PIP,
    risk: { slMethod: 'candle', slCandles: 2 }, smc, candles, spread });
  check('and for a short, the higher of the two highs',
    near(twoShort.price, 1.1020 + spread + 3 * PIP));
}

// ── Not computable means null, never a fallback ─────────────────────────────
//
// The group that matters. Every one of these would otherwise place a stop by a
// rule nobody chose, at a distance nobody sized for.
{
  check('a missing spread refuses the signal-candle stop',
    stopFor({ dir: 'long', price: ENTRY, pip: PIP,
      risk: { slMethod: 'candle' }, smc, candles, spread: null }) === null,
    'treating it as zero would place the stop tighter than asked');
  check('and so does a nonsense spread',
    stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'candle' }, smc, candles, spread: NaN }) === null
    && stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'candle' }, smc, candles, spread: -1 }) === null);
  check('no candles refuses it too',
    stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'candle' }, smc, candles: [], spread: 0.0002 }) === null);
  check('and asking to cover more candles than exist refuses rather than using fewer',
    stopFor({ dir: 'long', price: ENTRY, pip: PIP,
      risk: { slMethod: 'candle', slCandles: 5 }, smc, candles, spread: 0.0002 }) === null,
    'quietly using two when five were asked for is a stop nobody chose');

  check('no order block refuses the order-block stop',
    stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'ob' },
      smc: { ...smc, activeBullOB: null } }) === null,
    'the alternative is the ATR stop wearing the order block’s name');
  check('no swing refuses the swing stop',
    stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'swing' },
      smc: { ...smc, recentSwingLow: 0 } }) === null);
  check('no ATR refuses the ATR stop',
    stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk: { slMethod: 'atr' },
      smc: { ...smc, atr: 0 } }) === null,
    'an ATR of zero would put the stop exactly at entry');
}

// ── Direction is never mixed up ─────────────────────────────────────────────
{
  for (const m of SL_METHODS) {
    const risk = { slMethod: m, slCandles: 1 };
    const l = stopFor({ dir: 'long', price: ENTRY, pip: PIP, risk, smc, candles, spread: 0.0002 });
    const s = stopFor({ dir: 'short', price: 1.0950, pip: PIP, risk, smc, candles, spread: 0.0002 });
    check(`${m}: the long stop is below its reference and the short above`,
      l.price < ENTRY && s.price > 1.0950,
      `${l.price.toFixed(5)} / ${s.price.toFixed(5)}`);
  }
}

// ── The buffer is the one the strategy set ──────────────────────────────────
{
  const wide = stopFor({ dir: 'long', price: ENTRY, pip: PIP,
    risk: { slMethod: 'swing', slBufferPips: 10 }, smc });
  check('a ten pip buffer is ten pips, not the default three',
    near(wide.price, 1.0900 - 10 * PIP), wide.price.toFixed(5));
  const zero = stopFor({ dir: 'long', price: ENTRY, pip: PIP,
    risk: { slMethod: 'swing', slBufferPips: 0 }, smc });
  check('and a zero buffer is honoured rather than falling back to three',
    near(zero.price, 1.0900),
    '?? on a 0 would silently restore the default');
}

// ── Pip sizes match the executor ────────────────────────────────────────────
{
  check('gold, silver, yen and the rest get the bot’s pip sizes',
    pipSizeFor('XAU_USD') === 0.1 && pipSizeFor('XAG_USD') === 0.001
    && pipSizeFor('USD_JPY') === 0.01 && pipSizeFor('EUR_USD') === 0.0001);
  check('and an unknown symbol does not crash',
    pipSizeFor(null) === 0.0001 && pipSizeFor(undefined) === 0.0001);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

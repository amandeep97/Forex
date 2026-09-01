// The indicators the Screener scores instruments with.
//
// RSI was not RSI. It took a plain average of the last fourteen changes instead
// of Wilder's smoothed one, which gives a fixed fourteen-bar window with a cliff
// at the edge: a spike falls out of the window and the reading collapses by
// thirty-five points on a bar where nothing happened. Measured, on the same
// series, spike then quiet:
//
//     13 bars after → 92 (old) vs 85.6 (correct)
//     14 bars after → 44 vs 78.8
//     15 bars after → 53 vs 82.7
//
// The Screener scores RSI against 30/70/45/55. Those numbers are calibrated for
// Wilder's RSI, so fed a different statistic they fire at the wrong times, and
// the cliff makes them fire on nothing.
//
// The correct version was already in the same file, inside detectRSIDivergence.
// Two RSIs, and the cards used the broken one — which is why the first check
// below is that they now agree.
import {
  computeRSI, computeEMA, computeATR, computeMFI, computeMACD,
} from '../src/utils/indicatorCalc.js';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const bar = p => ({ o: p, h: p + 0.2, l: p - 0.2, c: p, v: 100 });
const from = closes => closes.map(bar);

// Wilder's RSI, written out plainly. If the implementation ever drifts back to
// a windowed average, this is the thing it has to disagree with.
function wilder(candles, period = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].c - candles[i - 1].c;
    if (d > 0) g += d; else l -= d;
  }
  g /= period; l /= period;
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (l === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}

let seed = 20260901;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
const walk = (n, spikeAt = -1, spike = 6) => {
  const c = []; let p = 100;
  for (let i = 0; i < n; i++) { p += rnd() * 0.4 + (i === spikeAt ? spike : 0); c.push(bar(p)); }
  return c;
};

// ── RSI is Wilder's ─────────────────────────────────────────────────────────
{
  for (const n of [40, 120, 400]) {
    const c = walk(n);
    check(`over ${n} bars it matches Wilder's to the rounding`,
      Math.abs(computeRSI(c, 14) - Math.round(wilder(c, 14))) <= 1,
      `${computeRSI(c, 14)} vs ${wilder(c, 14).toFixed(1)}`);
  }

  // The bug itself: no cliff at the window edge.
  const at13 = computeRSI(walk(120, 106), 14);
  const at14 = computeRSI(walk(120, 105), 14);
  const at15 = computeRSI(walk(120, 104), 14);
  check('a spike leaving the fourteenth bar does not collapse the reading',
    Math.max(at13, at14, at15) - Math.min(at13, at14, at15) < 20,
    `${at13} / ${at14} / ${at15} — the old code gave 92 / 44 / 53`);

  // Adjacent bars on the SAME series: an ordinary bar cannot move RSI far.
  const c = walk(200, 150);
  let biggest = 0;
  for (let i = 170; i < c.length; i++) {
    const a = computeRSI(c.slice(0, i), 14), b = computeRSI(c.slice(0, i + 1), 14);
    biggest = Math.max(biggest, Math.abs(a - b));
  }
  check('and one more ordinary bar never moves it by more than a few points',
    biggest < 12, `largest single-bar jump ${biggest}`);
}

// ── The ends of the scale ───────────────────────────────────────────────────
{
  check('a market that only rises reads 100',
    computeRSI(from(Array.from({ length: 60 }, (_, i) => 100 + i)), 14) === 100);
  check('a market that only falls reads near zero',
    computeRSI(from(Array.from({ length: 60 }, (_, i) => 200 - i)), 14) <= 1,
    String(computeRSI(from(Array.from({ length: 60 }, (_, i) => 200 - i)), 14)));
  // A flat market has no losses either, and "no losses" alone returns 100.
  check('a market that has not moved is neutral, not overbought',
    computeRSI(from(new Array(60).fill(100)), 14) === 50,
    'zero losses and zero gains is 50, not 100');
}

// ── Unmeasurable is null, and null is not a number ──────────────────────────
// Every one of these used to return something plausible. The EMA one is the
// worst: with fewer than two hundred bars, "EMA200" came back as the current
// price, so the golden-cross filter compared the fifty-period EMA against spot.
{
  check('RSI on too few bars is null, not fifty', computeRSI(from([1, 2, 3]), 14) === null);
  check('EMA on too few bars is null, not the last close',
    computeEMA(from([1, 2, 3]), 20) === null,
    'it returned the last close, which made EMA200 equal to price');
  check('ATR on too few bars is null, not zero',
    computeATR(from([1, 2, 3]), 14) === null,
    'a zero ATR divides into infinity in every position size downstream');
  check('MFI on too few bars is null, not fifty', computeMFI(from([1, 2, 3]), 14) === null);
  check('and nothing at all is null rather than a crash',
    computeRSI(null) === null && computeEMA(null, 20) === null && computeATR(null) === null);

  // Why it has to be null and has to be guarded by the callers.
  check('a null compares as zero, which is why every caller checks first',
    (100 > null) === true && (100 < null) === false,
    'an unguarded `price > ema` would read bullish on every instrument on the board');
}

// ── EMA ─────────────────────────────────────────────────────────────────────
{
  const flat = from(new Array(100).fill(50));
  check('a flat market has an EMA equal to the price', computeEMA(flat, 20) === 50);
  const up = from(Array.from({ length: 300 }, (_, i) => 100 + i));
  check('a rising market has an EMA below the price', computeEMA(up, 20) < up[299].c);
  check('and a slower EMA further below than a faster one',
    computeEMA(up, 50) < computeEMA(up, 20),
    'if the two ever cross the wrong way the golden-cross filter is inverted');
  check('exactly enough bars is enough', computeEMA(from(new Array(20).fill(7)), 20) === 7);
  check('one short is not', computeEMA(from(new Array(19).fill(7)), 20) === null);
}

// ── ATR uses Wilder smoothing too ───────────────────────────────────────────
{
  const c = Array.from({ length: 100 }, () => ({ o: 100, h: 101, l: 99, c: 100, v: 1 }));
  check('a constant two-point range gives an ATR of two',
    Math.abs(computeATR(c, 14) - 2) < 1e-9, String(computeATR(c, 14)));
}

// ── MACD ────────────────────────────────────────────────────────────────────
{
  const up = from(Array.from({ length: 200 }, (_, i) => 100 + i));
  const m = computeMACD(up);
  check('a rising market has the MACD line above zero', m.aboveZero && m.macdLine > 0);

  // On a PERFECTLY straight ramp the MACD line plateaus and its signal catches
  // it exactly, so the two are equal — correct behaviour, and not a test of
  // anything. Momentum has to be changing for the line to lead its signal.
  const accel = from(Array.from({ length: 200 }, (_, i) => 100 + i * i * 0.01));
  check('accelerating upward, the line leads its own signal',
    computeMACD(accel).macdLine > computeMACD(accel).signalLine);
  const decel = from(Array.from({ length: 200 }, (_, i) => 500 - i * i * 0.01));
  check('and accelerating downward it is the mirror',
    computeMACD(decel).belowZero
    && computeMACD(decel).macdLine < computeMACD(decel).signalLine);

  // A real cross: down for a hundred bars, then up.
  // The down-leg accelerates rather than falling in a straight line. On a
  // straight line the MACD line and its signal converge to the same number and
  // the histogram is exactly zero — correct, and useless as a test of a cross.
  const turn = from([
    ...Array.from({ length: 120 }, (_, i) => 300 - i * i * 0.02),
    ...Array.from({ length: 40 }, (_, i) => 300 - 119 * 119 * 0.02 + i * 3),
  ]);
  // Below its signal while the market is still falling, above it once it has
  // turned. Measured on this series the cross lands within two bars of the
  // turn, which is what a fast indicator on a sharp reversal should do.
  check('a market that turns up produces a crossing, not a permanent state',
    computeMACD(turn.slice(0, 118)).macdLine < computeMACD(turn.slice(0, 118)).signalLine
    && computeMACD(turn).macdLine > computeMACD(turn).signalLine,
    `falling: ${computeMACD(turn.slice(0, 118)).histogram.toFixed(2)}, `
    + `after the turn: ${computeMACD(turn).histogram.toFixed(2)}`);
  check('too short a series is a blank rather than a wrong cross',
    computeMACD(from(new Array(20).fill(5))).crossUp === false);
}

// ── How many bars each of these actually needs ─────────────────────────────
//
// A recursive indicator starts from an arbitrary seed whose weight decays as
// (1-k)^n. "Enough bars" means enough for that seed to stop mattering. The
// Screener fetched 250 for everything, which is comfortable for RSI, MACD,
// EMA20 and EMA50 — and not for the two long EMAs, so an "EMA200" was 61% its
// own opening average and the golden-cross filter was closer to an SMA cross.
//
// These are the numbers the fetch size is chosen from, asserted rather than
// left in a comment where they can quietly stop being true.
{
  const seedWeight = (period, bars, wilder = false) => {
    const k = wilder ? 1 / period : 2 / (period + 1);
    return Math.pow(1 - k, Math.max(0, bars - period));
  };
  const pct = x => `${(x * 100).toFixed(1)}%`;

  check('at 250 bars an EMA200 is still mostly its own seed',
    seedWeight(200, 250) > 0.5, pct(seedWeight(200, 250)));
  // Five percent, not sixty. Wrong by a little rather than a different
  // indicator — worth fixing when the deep pull is already happening, not
  // worth tripling the download on its own.
  check('and an EMA100 carries a few percent of seed, borderline rather than broken',
    seedWeight(100, 250) > 0.03 && seedWeight(100, 250) < 0.10,
    pct(seedWeight(100, 250)));
  check('at 700 bars the EMA200 seed is under one percent',
    seedWeight(200, 700) < 0.01, pct(seedWeight(200, 700)));

  check('RSI and ATR are fine at 250 — Wilder decays slower but 236 steps is plenty',
    seedWeight(14, 250, true) < 0.001, pct(seedWeight(14, 250, true)));
  check('EMA20 and EMA50 are fine at 250 too',
    seedWeight(20, 250) < 1e-6 && seedWeight(50, 250) < 0.001,
    `${pct(seedWeight(20, 250))} and ${pct(seedWeight(50, 250))}`);
  check('MACD\'s slow leg is fine at 250',
    seedWeight(26, 250) < 1e-6, pct(seedWeight(26, 250)));

  // And the reason the deep pull is conditional rather than always on.
  const mb = (bars) => (72 * bars * 150) / 1e6;
  check('fetching 700 for all seventy-two instruments roughly triples the download',
    mb(700) / mb(250) > 2.5 && mb(700) > 7,
    `${mb(250).toFixed(1)} MB a refresh at 250, ${mb(700).toFixed(1)} MB at 700, every ninety seconds`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

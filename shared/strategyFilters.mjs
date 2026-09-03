// shared/strategyFilters.mjs
// The entry filters the strategy builder offers, evaluated in one place.
//
// This exists because of a bug that had already happened once here: three
// switches were configurable in the app and read by nothing, so a strategy set
// to enter only on a bullish engulfing entered on EVERY bar while the screen
// said it was filtering. A switch that does not switch anything is worse than a
// missing feature, because you trust it.
//
// So the phone's "why is this not matching" preview and the bot's live decision
// both call these. If they disagree, it is a bug in one file rather than a
// silent difference between what you configured and what traded.
//
// Every function returns { pass, why } — never a bare boolean. `why` is what
// the app prints under "0 pairs matching, tap to see why", and a filter that
// cannot explain itself is a filter nobody will trust enough to leave on.
//
// NOT ENOUGH HISTORY IS A FAIL, NOT A PASS. If an indicator cannot be computed
// the condition has not been met, and the reason says so. Passing on missing
// data is how a filter quietly stops filtering.

import { macdAt, bollingerAt, stochasticAt, adxAt } from './indicators.mjs';
import { detectStrongReversal, patternsAt, PATTERN_MAP } from './candlePatterns.mjs';

const ok = () => ({ pass: true });
const no = (why) => ({ pass: false, why });

// ── Candlesticks ────────────────────────────────────────────────────────────
//
// The old vocabulary was four options: any / bullish / bearish / doji, which
// flattened all 34 registry patterns into three buckets — a Bullish Harami the
// registry calls weak passed exactly the filter a Bullish Kicker called strong
// passed. Those four still work, unchanged, so existing strategies keep
// behaving the way they did. What is new sits alongside them:
//
//   strong_hammer / strong_star / strong_any
//       The full-range sweep: the wick clears the entire prior N-bar range and
//       the close comes back INSIDE it. Stops taken and rejected. This is a
//       genuinely stricter test than a hammer shape, and it was in the code,
//       used by the Screener and the alerts, and not selectable here.
//   bull_strong / bull_medium / bull_weak (and the bearish mirrors)
//       The registry graded by its own strength label instead of flattened.
//   any named pattern id
//       "bull_engulf" and nothing else.
export function checkCandle(candles, want, { n = 5 } = {}) {
  if (!want || want === 'any') return ok();
  if (!candles?.length) return no('no candles');

  const i = candles.length - 1;

  if (want === 'strong_hammer' || want === 'strong_star' || want === 'strong_any') {
    const rev = detectStrongReversal(candles, i, n);
    if (!rev) return no(`no strong reversal on the last bar (needs the ${n}-bar range swept and reclaimed)`);
    if (want === 'strong_any') return ok();
    const wanted = want === 'strong_hammer' ? 'hammer' : 'star';
    return rev === wanted ? ok() : no(`last bar was a strong ${rev}, not a ${wanted}`);
  }

  const ids = patternsAt(candles, i);
  if (!ids.length) return no('no candle pattern completed on the last bar');

  // A graded family: cdl-bull-strong and the rest.
  const graded = /^(bull|bear)_(strong|medium|weak)$/.exec(want);
  if (graded) {
    const [, side, strength] = graded;
    const type = side === 'bull' ? 'bullish' : 'bearish';
    const hit = ids.some(id => PATTERN_MAP[id]?.type === type && PATTERN_MAP[id]?.strength === strength);
    return hit ? ok() : no(`last bar had ${ids.join(', ')} — none is a ${strength} ${type} pattern`);
  }

  // The three original families.
  if (want === 'doji') {
    return ids.some(id => /doji|spinning_top/.test(id)) ? ok()
      : no(`last bar had ${ids.join(', ')} — no doji or spinning top`);
  }
  if (want === 'bullish' || want === 'bearish') {
    return ids.some(id => PATTERN_MAP[id]?.type === want) ? ok()
      : no(`last bar had ${ids.join(', ')} — nothing ${want}`);
  }

  // One named pattern.
  if (PATTERN_MAP[want]) {
    return ids.includes(want) ? ok()
      : no(`last bar had ${ids.join(', ')} — not ${PATTERN_MAP[want].name}`);
  }
  return no(`unknown candle filter "${want}"`);
}

// ── MACD ────────────────────────────────────────────────────────────────────
//
// "Above the signal line" is true for weeks; "crossed above it on this bar" is
// one bar. They are offered separately because they are different strategies
// and the difference is invisible if you only ever see the word MACD.
export function checkMACD(candles, f) {
  if (!f?.enabled) return ok();
  const m = macdAt(candles, { fast: f.fast || 12, slow: f.slow || 26, signal: f.signal || 9 });
  if (!m) return no('not enough bars for MACD (needs about 90)');
  switch (f.mode) {
    case 'cross_up':   return m.crossUp ? ok() : no('MACD did not cross up on this bar');
    case 'cross_down': return m.crossDown ? ok() : no('MACD did not cross down on this bar');
    case 'below':      return m.hist < 0 ? ok() : no('MACD is above its signal line');
    case 'rising':     return m.hist > m.prevHist ? ok() : no('the MACD histogram is not rising');
    case 'falling':    return m.hist < m.prevHist ? ok() : no('the MACD histogram is not falling');
    case 'above':
    default:           return m.hist > 0 ? ok() : no('MACD is below its signal line');
  }
}

// ── Bollinger ───────────────────────────────────────────────────────────────
export function checkBollinger(candles, f) {
  if (!f?.enabled) return ok();
  const b = bollingerAt(candles, { period: f.period || 20, mult: f.mult || 2 });
  if (!b) return no('not enough bars for Bollinger Bands (needs 21)');
  const pct = (b.pctB * 100).toFixed(0);
  switch (f.mode) {
    case 'below_lower': return b.price < b.lower ? ok() : no(`price is inside the lower band (${pct}% across)`);
    case 'above_upper': return b.price > b.upper ? ok() : no(`price is inside the upper band (${pct}% across)`);
    case 'above_mid':   return b.price > b.mid ? ok() : no('price is below the middle band');
    case 'below_mid':   return b.price < b.mid ? ok() : no('price is above the middle band');
    // The squeeze: bands narrower than a given share of the middle band.
    case 'squeeze': {
      const lim = (f.value ?? 2) / 100;
      return b.width < lim ? ok()
        : no(`bands are ${(b.width * 100).toFixed(2)}% wide, not under ${(lim * 100).toFixed(2)}%`);
    }
    default: return no(`unknown Bollinger mode "${f.mode}"`);
  }
}

// ── Stochastic ──────────────────────────────────────────────────────────────
export function checkStochastic(candles, f) {
  if (!f?.enabled) return ok();
  const s = stochasticAt(candles, { kPeriod: f.kPeriod || 14, dPeriod: f.dPeriod || 3 });
  if (!s) return no('not enough bars for the stochastic (needs 17)');
  const v = f.value ?? (f.comparison === 'above' ? 80 : 20);
  if (f.comparison === 'above') {
    return s.k > v ? ok() : no(`stochastic %K is ${s.k.toFixed(0)}, not above ${v}`);
  }
  return s.k < v ? ok() : no(`stochastic %K is ${s.k.toFixed(0)}, not below ${v}`);
}

// ── ADX ─────────────────────────────────────────────────────────────────────
//
// ADX says how strongly price is trending and nothing about which way. The
// direction is +DI against -DI, offered as its own mode so that "trending" and
// "trending up" stay two different requests.
export function checkADX(candles, f) {
  if (!f?.enabled) return ok();
  const a = adxAt(candles, { period: f.period || 14 });
  if (!a) return no('not enough bars for ADX (needs about 42)');
  const v = f.value ?? 25;
  switch (f.mode) {
    case 'weak':  return a.adx < v ? ok() : no(`ADX is ${a.adx.toFixed(0)}, not below ${v} — this is a trend`);
    case 'bull':  return (a.adx > v && a.plusDI > a.minusDI) ? ok()
      : no(`ADX ${a.adx.toFixed(0)}, +DI ${a.plusDI?.toFixed(0)} vs -DI ${a.minusDI?.toFixed(0)} — no up-trend`);
    case 'bear':  return (a.adx > v && a.minusDI > a.plusDI) ? ok()
      : no(`ADX ${a.adx.toFixed(0)}, +DI ${a.plusDI?.toFixed(0)} vs -DI ${a.minusDI?.toFixed(0)} — no down-trend`);
    case 'strong':
    default:      return a.adx > v ? ok() : no(`ADX is ${a.adx.toFixed(0)}, not above ${v} — no trend`);
  }
}

// Every new filter at once, in a fixed order, returning the FIRST reason it
// failed. One reason is readable; five stacked reasons is a wall nobody reads.
export function checkIndicatorFilters(candles, conditions = {}) {
  const checks = [
    ['candle', () => checkCandle(candles, conditions.candlePattern, { n: conditions.candleN || 5 })],
    ['macd', () => checkMACD(candles, conditions.macdFilter)],
    ['bollinger', () => checkBollinger(candles, conditions.bbFilter)],
    ['stochastic', () => checkStochastic(candles, conditions.stochFilter)],
    ['adx', () => checkADX(candles, conditions.adxFilter)],
  ];
  const detail = {};
  let first = null;
  for (const [name, run] of checks) {
    const r = run();
    detail[name] = r.pass;
    if (!r.pass && !first) first = { name, why: r.why };
  }
  return { pass: !first, first, detail };
}

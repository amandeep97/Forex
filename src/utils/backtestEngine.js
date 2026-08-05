// src/utils/backtestEngine.js
// Core backtesting engine — pure functions, no React dependencies.
// Candle format: { t, o, h, l, c, v }  (OANDA / generateCandles format)
import { patternsAt, PATTERN_MAP } from './candlePatterns';

// Mirror map for candlestick patterns (long entry ↔ symmetrical short entry)
const PATTERN_MIRROR = {
  hammer:'shooting_star', shooting_star:'hammer', hanging_man:'inv_hammer', inv_hammer:'hanging_man',
  dragonfly_doji:'gravestone_doji', gravestone_doji:'dragonfly_doji',
  marubozu_bull:'marubozu_bear', marubozu_bear:'marubozu_bull',
  bull_engulf:'bear_engulf', bear_engulf:'bull_engulf',
  piercing_line:'dark_cloud', dark_cloud:'piercing_line',
  bull_harami:'bear_harami', bear_harami:'bull_harami',
  tweezer_bottom:'tweezer_top', tweezer_top:'tweezer_bottom',
  kicker_bull:'kicker_bear', kicker_bear:'kicker_bull',
  morning_star:'evening_star', evening_star:'morning_star',
  three_soldiers:'three_crows', three_crows:'three_soldiers',
  three_inside_up:'three_inside_dn', three_inside_dn:'three_inside_up',
  abandoned_bull:'abandoned_bear', abandoned_bear:'abandoned_bull',
  rising_three:'falling_three', falling_three:'rising_three',
  any_bull:'any_bear', any_bear:'any_bull', any_reversal:'any_reversal',
};

// ── Indicator series (return full-length array, null where insufficient data) ──

export function computeRSISeries(candles, period = 14) {
  const res = new Array(candles.length).fill(null);
  if (candles.length <= period) return res;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].c - candles[i - 1].c;
    if (d > 0) avgG += d; else avgL -= d;
  }
  avgG /= period; avgL /= period;
  res[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
    res[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return res;
}

export function computeMFISeries(candles, period = 14) {
  const res = new Array(candles.length).fill(null);
  if (candles.length <= period) return res;
  const tp   = candles.map(c => (c.h + c.l + c.c) / 3);
  const mfRaw = candles.map((c, i) => ({
    val: tp[i] * (c.v || 1),
    pos: i === 0 || tp[i] >= tp[i - 1],
  }));
  for (let i = period; i < candles.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (mfRaw[j].pos) pos += mfRaw[j].val; else neg += mfRaw[j].val;
    }
    res[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return res;
}

export function computeEMASeries(candles, period) {
  const res = new Array(candles.length).fill(null);
  if (candles.length < period) return res;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].c;
  res[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    res[i] = candles[i].c * k + res[i - 1] * (1 - k);
  }
  return res;
}

export function computeSMASeries(candles, period) {
  const res = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].c;
    res[i] = sum / period;
  }
  return res;
}

export function computeATRSeries(candles, period = 14) {
  const res = new Array(candles.length).fill(null);
  if (candles.length < period) return res;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  res[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    res[i] = (res[i - 1] * (period - 1) + tr[i]) / period;
  }
  return res;
}

// Highest and lowest CLOSE of the n bars BEFORE each bar.
//
// Before, not including — a breakout condition that compares this bar's close
// against a window containing this bar's close can never be true, which is the
// kind of bug that reads as "that idea does not work".
export function computeExtremeSeries(candles, n = 20) {
  const res = new Array(candles.length).fill(null);
  for (let i = n; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n; j < i; j++) {
      if (candles[j].c > hi) hi = candles[j].c;
      if (candles[j].c < lo) lo = candles[j].c;
    }
    res[i] = { hi, lo };
  }
  return res;
}

// ── MACD series ───────────────────────────────────────────────────────────────
export function computeMACDSeries(candles, fast = 12, slow = 26, signal = 9) {
  const res = new Array(candles.length).fill(null);
  const emaFArr = computeEMASeries(candles, fast);
  const emaSArr = computeEMASeries(candles, slow);
  const validMacd = [];
  for (let i = slow - 1; i < candles.length; i++) {
    if (emaFArr[i] != null && emaSArr[i] != null)
      validMacd.push({ idx: i, val: emaFArr[i] - emaSArr[i] });
  }
  if (validMacd.length < signal + 1) return res;
  const kg = 2 / (signal + 1);
  let sigEma = validMacd.slice(0, signal).reduce((s, v) => s + v.val, 0) / signal;
  let prevSig = sigEma;
  for (let i = signal; i < validMacd.length; i++) {
    prevSig = sigEma;
    const prev = validMacd[i - 1];
    sigEma = validMacd[i].val * kg + sigEma * (1 - kg);
    res[validMacd[i].idx] = {
      m: validMacd[i].val, s: sigEma, h: validMacd[i].val - sigEma,
      crossUp:   validMacd[i].val > sigEma && prev.val <= prevSig,
      crossDown: validMacd[i].val < sigEma && prev.val >= prevSig,
    };
  }
  return res;
}

// ── BOS series (simplified per-bar break-of-structure) ────────────────────────
export function computeBOSSeries(candles, lookback = 10) {
  const res = new Array(candles.length).fill(null);
  for (let i = lookback + 3; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - lookback), i);
    let swingHigh = -Infinity, swingLow = Infinity;
    for (let j = 2; j < slice.length - 2; j++) {
      if (slice[j].h > slice[j-1].h && slice[j].h > slice[j-2].h &&
          slice[j].h > slice[j+1].h && slice[j].h > slice[j+2].h)
        swingHigh = Math.max(swingHigh, slice[j].h);
      if (slice[j].l < slice[j-1].l && slice[j].l < slice[j-2].l &&
          slice[j].l < slice[j+1].l && slice[j].l < slice[j+2].l)
        swingLow = Math.min(swingLow, slice[j].l);
    }
    const c = candles[i];
    if (swingHigh !== -Infinity || swingLow !== Infinity) {
      res[i] = {
        bull: swingHigh !== -Infinity && c.c > swingHigh,
        bear: swingLow  !== Infinity  && c.c < swingLow,
      };
    }
  }
  return res;
}

// ── FVG series (is there a fair value gap ending at bar i) ────────────────────
export function computeFVGSeries(candles) {
  const res = new Array(candles.length).fill(null);
  const avg = candles.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / candles.length || 1;
  for (let i = 2; i < candles.length; i++) {
    const bull = candles[i-2].h < candles[i].l && (candles[i].l - candles[i-2].h) > avg * 0.1;
    const bear = candles[i-2].l > candles[i].h && (candles[i-2].l - candles[i].h) > avg * 0.1;
    if (bull || bear) res[i] = { bull, bear };
  }
  return res;
}

// ── Displacement series (3 impulsive candles in a row) ────────────────────────
export function computeDisplacementSeries(candles) {
  const res = new Array(candles.length).fill(null);
  if (candles.length < 5) return res;
  const avgBody = candles.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / candles.length || 1;
  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i-2], c1 = candles[i-1], c2 = candles[i];
    const allBull = c0.c > c0.o && c1.c > c1.o && c2.c > c2.o;
    const allBear = c0.c < c0.o && c1.c < c1.o && c2.c < c2.o;
    const totalMove = Math.abs(c2.c - c0.o);
    if ((allBull || allBear) && totalMove > avgBody * 2.5)
      res[i] = { bull: allBull, bear: allBear };
  }
  return res;
}

// ── Order Block series ───────────────────────────────────────────────────────
// Bull OB: last bearish candle before 2+ bullish impulse candles; price retests it
// Bear OB: last bullish candle before 2+ bearish impulse candles; price retests it
export function computeOBSeries(candles, lookback = 20) {
  const res = new Array(candles.length).fill(null);
  for (let i = lookback + 3; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - lookback), i);
    let bullOB = false, bearOB = false;
    for (let j = 0; j < slice.length - 2; j++) {
      if (slice[j].c < slice[j].o && slice[j+1].c > slice[j+1].o && slice[j+2].c > slice[j+2].o) {
        const obHi = slice[j].h, obLo = slice[j].l;
        const cur = candles[i];
        if (cur.l <= obHi && cur.c >= obLo) bullOB = true;
      }
      if (slice[j].c > slice[j].o && slice[j+1].c < slice[j+1].o && slice[j+2].c < slice[j+2].o) {
        const obHi = slice[j].h, obLo = slice[j].l;
        const cur = candles[i];
        if (cur.h >= obLo && cur.c <= obHi) bearOB = true;
      }
    }
    if (bullOB || bearOB) res[i] = { bull: bullOB, bear: bearOB };
  }
  return res;
}

// ── OTE Zone series (Fibonacci 61.8–78.6% retracement of last swing) ─────────
export function computeOTESeries(candles, lookback = 30) {
  const res = new Array(candles.length).fill(null);
  for (let i = lookback + 3; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - lookback), i);
    let swHi = -Infinity, swHiIdx = -1, swLo = Infinity, swLoIdx = -1;
    for (let j = 2; j < slice.length - 2; j++) {
      if (slice[j].h >= slice[j-1].h && slice[j].h >= slice[j+1].h && slice[j].h > swHi) {
        swHi = slice[j].h; swHiIdx = j;
      }
      if (slice[j].l <= slice[j-1].l && slice[j].l <= slice[j+1].l && slice[j].l < swLo) {
        swLo = slice[j].l; swLoIdx = j;
      }
    }
    if (swHi === -Infinity || swLo === Infinity) continue;
    const range = swHi - swLo;
    if (range <= 0) continue;
    const cur = candles[i].c;
    if (swHiIdx > swLoIdx) {
      const lo618 = swHi - 0.618 * range, lo786 = swHi - 0.786 * range;
      if (cur >= lo786 && cur <= lo618) res[i] = { bull: true, bear: false };
    } else if (swLoIdx > swHiIdx) {
      const hi618 = swLo + 0.618 * range, hi786 = swLo + 0.786 * range;
      if (cur >= hi618 && cur <= hi786) res[i] = { bull: false, bear: true };
    }
  }
  return res;
}

// ── Liquidity Sweep series ────────────────────────────────────────────────────
// Bullish sweep: wick below lookback low, then close back above it (engineered liquidity grab)
// Bearish sweep: wick above lookback high, close back below
export function computeLiquiditySweepSeries(candles, lookback = 20) {
  const res = new Array(candles.length).fill(null);
  for (let i = lookback + 2; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - lookback), i - 1);
    let swHi = -Infinity, swLo = Infinity;
    for (const c of slice) { swHi = Math.max(swHi, c.h); swLo = Math.min(swLo, c.l); }
    const cur = candles[i];
    const bull = cur.l < swLo && cur.c > swLo;
    const bear = cur.h > swHi && cur.c < swHi;
    if (bull || bear) res[i] = { bull, bear };
  }
  return res;
}

// ── Strong reversal series (full-range sweep hammer / shooting star) ──────────
// Bull (Strong Hammer): wick clears the entire prior N-candle low, closes green
// back inside. Bear (Strong Shooting Star): mirror. Higher quality than a lone
// hammer because it must sweep the WHOLE range, not just poke one candle.
export function computeStrongReversalSeries(candles, N = 5) {
  const res = new Array(candles.length).fill(null);
  for (let i = N; i < candles.length; i++) {
    const c = candles[i], prior = candles.slice(i - N, i);
    const body = Math.abs(c.c - c.o), up = c.h - Math.max(c.o, c.c), lo = Math.min(c.o, c.c) - c.l, r = c.h - c.l;
    if (r <= 0) continue;
    const rLow = Math.min(...prior.map(x => x.l)), rHigh = Math.max(...prior.map(x => x.h));
    const bull = c.l < rLow && c.c > rLow && c.c > c.o && lo >= 2 * body && lo > up && Math.min(c.o, c.c) >= c.l + r * 0.5;
    const bear = c.h > rHigh && c.c < rHigh && c.c < c.o && up >= 2 * body && up > lo && Math.max(c.o, c.c) <= c.l + r * 0.5;
    if (bull || bear) res[i] = { bull, bear };
  }
  return res;
}

// ── Equal Highs / Equal Lows series ──────────────────────────────────────────
export function computeEqualHLSeries(candles, lookback = 30, tolerance = 0.0015) {
  const res = new Array(candles.length).fill(null);
  for (let i = lookback + 2; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - lookback), i + 1);
    const swHis = [], swLos = [];
    for (let j = 2; j < slice.length - 2; j++) {
      if (slice[j].h >= slice[j-1].h && slice[j].h >= slice[j+1].h) swHis.push(slice[j].h);
      if (slice[j].l <= slice[j-1].l && slice[j].l <= slice[j+1].l) swLos.push(slice[j].l);
    }
    let equalHighs = false, equalLows = false;
    for (let a = 0; a < swHis.length - 1 && !equalHighs; a++)
      for (let b = a + 1; b < swHis.length && !equalHighs; b++)
        if (Math.abs(swHis[a] - swHis[b]) / (swHis[a] || 1) < tolerance) equalHighs = true;
    for (let a = 0; a < swLos.length - 1 && !equalLows; a++)
      for (let b = a + 1; b < swLos.length && !equalLows; b++)
        if (Math.abs(swLos[a] - swLos[b]) / (swLos[a] || 1) < tolerance) equalLows = true;
    if (equalHighs || equalLows) res[i] = { equalHighs, equalLows };
  }
  return res;
}

// ── Consolidation series ──────────────────────────────────────────────────────
// True when N-bar range is less than ATR × 3 (price coiling in a tight range)
export function computeConsolidationSeries(candles, period = 20) {
  const res = new Array(candles.length).fill(null);
  const atrArr = computeATRSeries(candles, 14);
  for (let i = period; i < candles.length; i++) {
    const slice = candles.slice(i - period, i + 1);
    const hi = Math.max(...slice.map(c => c.h));
    const lo = Math.min(...slice.map(c => c.l));
    const avgAtr = atrArr[i] || 1;
    res[i] = (hi - lo) < avgAtr * 3;
  }
  return res;
}

// ── Candle pattern detection ──────────────────────────────────────────────────
export function detectPatternAt(candles, i) {
  if (i < 1) return null;
  const c = candles[i], p = candles[i - 1];
  const body  = Math.abs(c.c - c.o);
  const range = (c.h - c.l) || 0.0001;
  const upWick  = c.h - Math.max(c.o, c.c);
  const dnWick  = Math.min(c.o, c.c) - c.l;
  const bull = c.c > c.o, bear = c.c < c.o;
  // Hammer
  if (bull && dnWick >= body * 2 && upWick <= body * 0.5) return 'bullish';
  // Shooting star
  if (bear && upWick >= body * 2 && dnWick <= body * 0.5) return 'bearish';
  // Bullish engulfing
  if (bull && p.c < p.o && c.o <= p.c && c.c >= p.o) return 'bullish';
  // Bearish engulfing
  if (bear && p.c > p.o && c.o >= p.c && c.c <= p.o) return 'bearish';
  // Marubozu
  if (bull && body >= range * 0.75) return 'bullish';
  if (bear && body >= range * 0.75) return 'bearish';
  return bull ? 'bullish' : (bear ? 'bearish' : null);
}

// ── Realistic default round-trip spread cost per instrument (in pips) ─────────
// Deducted from every trade so backtests aren't the fantasy of zero cost.
// User can override via strategy.spreadPips. Silver's is deliberately large —
// its spread really is proportionally brutal.
export function defaultSpreadPips(symbol) {
  const s = (symbol || '').toUpperCase();
  if (s.startsWith('XAU')) return 3;
  if (s.startsWith('XAG')) return 30;
  if (/USDT|BTC|ETH/.test(s)) return 2;
  if (/^(US|GER|UK|FR|JPN|AUS|ESP|HKG|CHN)/.test(s)) return 2;
  if (s.includes('JPY')) return 1.5;
  const majors = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD','NZD/USD'];
  if (majors.includes(symbol)) return 1;
  return 2; // crosses / everything else
}

// ── Pip size per instrument ───────────────────────────────────────────────────
const CRYPTO_PIP = { BTC:1, ETH:0.1, BNB:0.1, SOL:0.01, XRP:0.0001, ADA:0.0001, DOGE:0.0001, AVAX:0.001, LINK:0.001, DOT:0.001, LTC:0.01, TON:0.001 };
export function getPipSize(symbol) {
  if (!symbol) return 0.0001;
  const s = symbol.toUpperCase();
  if (s.includes('USDT')) return CRYPTO_PIP[s.split('/')[0]] ?? 0.01;
  if (s.includes('JPY') || s.includes('HKD')) return 0.01;
  if (s === 'USOIL' || s === 'UKOIL' || s === 'NATGAS') return 0.01;
  if (s.startsWith('XAU')) return 0.1;
  if (s.startsWith('XAG')) return 0.001;
  if (/^(US|UK|GER|JPN|AUS|FRA|ESP|HKG|CHN)/.test(s)) return 1.0;
  return 0.0001;
}

// ── Mirror a condition: bullish ↔ bearish for symmetrical short entries ────────
export function mirrorCond(cond) {
  switch (cond.type) {
    case 'rsi': case 'mfi': {
      const m = { below:'above', above:'below', crossBelow:'crossAbove', crossAbove:'crossBelow' };
      return { ...cond, op: m[cond.op] || cond.op, value: 100 - (cond.value ?? 50) };
    }
    case 'ma': {
      const m = { priceAbove:'priceBelow', priceBelow:'priceAbove', priceCrossAbove:'priceCrossBelow', priceCrossBelow:'priceCrossAbove' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'ma_cross': {
      const m = { bullishCross:'bearishCross', bearishCross:'bullishCross' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'macd': {
      const m = { crossUp:'crossDown', crossDown:'crossUp', aboveZero:'belowZero', belowZero:'aboveZero', histPos:'histNeg', histNeg:'histPos' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'bos':
    case 'fvg':
    case 'displacement':
    case 'ob':
    case 'ote_zone':
    case 'liquidity':
    case 'strong_rev': {
      const m = { bullish:'bearish', bearish:'bullish' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'equal_hl': {
      const m = { equalLows:'equalHighs', equalHighs:'equalLows' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'consolidation':
    case 'session':
    case 'volume':
    case 'dow':
    case 'volpct':
    case 'rangepos':
    case 'persistence':
      return cond;   // context filters — same for long & short
    case 'chg20': {
      const m = { up:'down', down:'up' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'pattern':
      return { ...cond, value: cond.value === 'bullish' ? 'bearish' : cond.value === 'bearish' ? 'bullish' : cond.value };
    case 'candlestick':
      return { ...cond, value: PATTERN_MIRROR[cond.value] || cond.value };
    case 'candle':
      return { ...cond, op: cond.op === 'bullish' ? 'bearish' : cond.op === 'bearish' ? 'bullish' : cond.op };
    // The new conditions are directional, so the short side is the mirror
    // image. Falling through to `default` would have tested the long-side
    // condition on short entries — a rule that quietly means something
    // different depending on which way it trades.
    case 'stretch':
    case 'gap':
    case 'peer_chg':
    case 'ratio_pct': {
      const m = { above:'below', below:'above', up:'down', down:'up' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'divergence': {
      const m = { bull:'bear', bear:'bull' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'lead': {
      const m = { up:'down', down:'up' };
      return { ...cond, op: m[cond.op] || 'down' };
    }
    // Calendar position is not directional — month end is month end.
    case 'dom':
    case 'quarter':
      return cond;
    case 'breakout': {
      const m = { high:'low', low:'high' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'wick': {
      const m = { lower:'upper', upper:'lower' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    default: return cond;
  }
}

// ── Evaluate a single condition at index i ────────────────────────────────────
function evalCond(c, prev, inds, cond, pattern, patternIds) {
  switch (cond.type) {
    case 'rsi':
    case 'mfi': {
      const key = `${cond.type}_${cond.period}`;
      const s = inds[key];
      if (!s || s.cur == null || s.prev == null) return false;
      const [cv, pv] = [s.cur, s.prev];
      if (cond.op === 'below')      return cv <  cond.value;
      if (cond.op === 'above')      return cv >  cond.value;
      if (cond.op === 'crossBelow') return cv <  cond.value && pv >= cond.value;
      if (cond.op === 'crossAbove') return cv >  cond.value && pv <= cond.value;
      return false;
    }
    case 'ma': {
      const key = `${cond.maType || 'ema'}_${cond.period}`;
      const s = inds[key];
      if (!s || s.cur == null) return false;
      const prevClose = prev?.c ?? c.c;
      const prevMa    = s.prev ?? s.cur;
      if (cond.op === 'priceAbove')      return c.c > s.cur;
      if (cond.op === 'priceBelow')      return c.c < s.cur;
      if (cond.op === 'priceCrossAbove') return c.c > s.cur && prevClose <= prevMa;
      if (cond.op === 'priceCrossBelow') return c.c < s.cur && prevClose >= prevMa;
      return false;
    }
    case 'ma_cross': {
      const mt = cond.maType || 'ema';
      const s1 = inds[`${mt}_${cond.period}`];
      const s2 = inds[`${mt}_${cond.period2}`];
      if (!s1 || !s2 || s1.cur == null || s2.cur == null) return false;
      const [p1, p2] = [s1.prev ?? s1.cur, s2.prev ?? s2.cur];
      if (cond.op === 'bullishCross') return s1.cur > s2.cur && p1 <= p2;
      if (cond.op === 'bearishCross') return s1.cur < s2.cur && p1 >= p2;
      return false;
    }
    case 'macd': {
      const s = inds['macd'];
      if (!s || s.cur == null) return false;
      if (cond.op === 'crossUp')   return s.cur.crossUp   === true;
      if (cond.op === 'crossDown') return s.cur.crossDown === true;
      if (cond.op === 'aboveZero') return s.cur.m > 0;
      if (cond.op === 'belowZero') return s.cur.m < 0;
      if (cond.op === 'histPos')   return s.cur.h > 0;
      if (cond.op === 'histNeg')   return s.cur.h < 0;
      return false;
    }
    case 'bos': {
      const s = inds['bos'];
      if (!s || s.cur == null) return false;
      if (cond.op === 'bullish') return s.cur.bull === true;
      if (cond.op === 'bearish') return s.cur.bear === true;
      return s.cur.bull || s.cur.bear;
    }
    case 'fvg': {
      const s = inds['fvg'];
      if (!s || s.cur == null) return false;
      if (cond.op === 'bullish') return s.cur.bull === true;
      if (cond.op === 'bearish') return s.cur.bear === true;
      return s.cur.bull || s.cur.bear;
    }
    case 'displacement': {
      const s = inds['disp'];
      if (!s || s.cur == null) return false;
      if (cond.op === 'bullish') return s.cur.bull === true;
      if (cond.op === 'bearish') return s.cur.bear === true;
      return s.cur.bull || s.cur.bear;
    }
    case 'ob': {
      const s = inds['ob'];
      if (!s || s.cur == null) return false;
      if (cond.op === 'bullish') return s.cur.bull === true;
      if (cond.op === 'bearish') return s.cur.bear === true;
      return s.cur.bull || s.cur.bear;
    }
    case 'ote_zone': {
      const s = inds['ote'];
      if (!s || s.cur == null) return false;
      if (cond.op === 'bullish') return s.cur.bull === true;
      if (cond.op === 'bearish') return s.cur.bear === true;
      return s.cur.bull || s.cur.bear;
    }
    case 'liquidity': {
      const s = inds['liq'];
      if (!s || s.cur == null) return false;
      if (cond.op === 'bullish') return s.cur.bull === true;
      if (cond.op === 'bearish') return s.cur.bear === true;
      return s.cur.bull || s.cur.bear;
    }
    case 'strong_rev': {
      const s = inds[`strev_${cond.n || 5}`];
      if (!s || s.cur == null) return false;
      if (cond.op === 'bullish') return s.cur.bull === true;
      if (cond.op === 'bearish') return s.cur.bear === true;
      return s.cur.bull || s.cur.bear;
    }
    case 'equal_hl': {
      const s = inds['ehl'];
      if (!s || s.cur == null) return false;
      if (cond.op === 'equalHighs') return s.cur.equalHighs === true;
      if (cond.op === 'equalLows')  return s.cur.equalLows  === true;
      return s.cur.equalHighs || s.cur.equalLows;
    }
    case 'consolidation': {
      const s = inds['consol'];
      if (!s || s.cur == null) return false;
      return s.cur === true;
    }
    case 'pattern':
      if (cond.value === 'any') return pattern !== null;
      return pattern === cond.value;
    case 'candlestick': {
      const ids = patternIds || [];
      const want = cond.value || 'any_bull';
      if (want === 'any_bull')     return ids.some(id => PATTERN_MAP[id]?.type === 'bullish');
      if (want === 'any_bear')     return ids.some(id => PATTERN_MAP[id]?.type === 'bearish');
      if (want === 'any_reversal') return ids.some(id => PATTERN_MAP[id]?.signal === 'reversal');
      return ids.includes(want);   // specific pattern id
    }
    case 'session': {
      if (!c.t) return true;       // sim data w/o timestamps — don't block
      const h = new Date(typeof c.t === 'number' ? c.t : Date.parse(c.t)).getUTCHours();
      const asian = h < 7, london = h >= 7 && h < 16, ny = h >= 12 && h < 21, overlap = h >= 12 && h < 16;
      if (cond.op === 'asian')   return asian;
      if (cond.op === 'london')  return london;
      if (cond.op === 'ny')      return ny;
      if (cond.op === 'overlap') return overlap;
      if (cond.op === 'killzone')return (h>=7&&h<10)||(h>=12&&h<15); // London KZ + NY AM KZ
      return true;
    }
    case 'dow': {
      if (!c.t) return true;
      const d = new Date(typeof c.t === 'number' ? c.t : Date.parse(c.t)).getUTCDay(); // 0=Sun..6=Sat
      const map = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
      return d === (map[cond.op] ?? -1);
    }
    case 'volume': {
      const avg = inds['volAvg']?.cur;
      if (avg == null || !c.v) return false;
      const mult = cond.mult || 1.5;
      if (cond.op === 'spike') return c.v >= avg * mult;
      if (cond.op === 'above') return c.v >  avg;
      if (cond.op === 'below') return c.v <  avg;
      return false;
    }
    // ── Live Feed measures ──
    case 'volpct': {
      const v = inds['volPct']?.cur; if (v == null) return false;
      return cond.op === 'below' ? v <= cond.value : v >= cond.value;
    }
    case 'rangepos': {
      const v = inds['rangePos']?.cur; if (v == null) return false;
      return cond.op === 'below' ? v <= cond.value : v >= cond.value;
    }
    case 'chg20': {
      const v = inds['chg20']?.cur; if (v == null) return false;
      if (cond.op === 'up')   return v >=  Math.abs(cond.value);
      if (cond.op === 'down') return v <= -Math.abs(cond.value);
      return Math.abs(v) >= Math.abs(cond.value);
    }
    case 'persistence': {
      const v = inds['persistence']?.cur; if (v == null) return false;
      return v >= cond.value;
    }

    case 'candle':
      if (cond.op === 'bullish') return c.c > c.o;
      if (cond.op === 'bearish') return c.c < c.o;
      return false;

    // ── Conditions added for the deep search ────────────────────────────────
    // Measured in ATR rather than pips or percent, so the same rule means the
    // same thing on gold, the Nasdaq and cable. A "2% move" is enormous on
    // EUR/USD and a quiet afternoon on silver; two ATR is two ATR everywhere.

    // How far price has run from its own mean. The condition almost nobody
    // stacks, and the one that separates a trend worth joining from a move
    // already exhausted.
    case 'stretch': {
      const ma = inds[`ema_${cond.period || 50}`]?.cur, a = inds['atr14']?.cur;
      if (ma == null || !a) return false;
      const x = (c.c - ma) / a;
      if (cond.op === 'above') return x >=  cond.value;      // stretched up
      if (cond.op === 'below') return x <= -cond.value;      // stretched down
      return Math.abs(x) >= cond.value;
    }

    // Close beyond every close of the prior n bars.
    case 'breakout': {
      const s = inds[`ext_${cond.n || 20}`];
      if (!s || s.cur == null) return false;
      if (cond.op === 'high') return c.c > s.cur.hi;
      if (cond.op === 'low')  return c.c < s.cur.lo;
      return c.c > s.cur.hi || c.c < s.cur.lo;
    }

    // Opening away from the previous close — the overnight repricing that a
    // bar-close backtest otherwise treats as if it never happened.
    case 'gap': {
      const a = inds['atr14']?.cur;
      if (!a || !prev) return false;
      const g = (c.o - prev.c) / a;
      if (cond.op === 'up')   return g >=  cond.value;
      if (cond.op === 'down') return g <= -cond.value;
      return Math.abs(g) >= cond.value;
    }

    // Wick dominance: who gave up ground inside the bar, regardless of where
    // it closed.
    case 'wick': {
      const range = c.h - c.l;
      if (!(range > 0)) return false;
      const lower = Math.min(c.o, c.c) - c.l;
      const upper = c.h - Math.max(c.o, c.c);
      const v = cond.value ?? 0.5;
      if (cond.op === 'lower') return lower / range >= v;
      if (cond.op === 'upper') return upper / range >= v;
      return Math.max(lower, upper) / range >= v;
    }

    // ── Cross-asset and calendar ────────────────────────────────────────────
    // These read series built from OTHER instruments (see contextSeries.js),
    // handed in on strategy.ctx and merged into the same snapshot everything
    // else uses. They are the conditions a single-chart backtester cannot
    // express, which is the reason for having them.

    // A peer moved this much over n bars.
    case 'peer_chg': {
      const v = inds[`chg:${cond.peer}:${cond.n || 5}`]?.cur;
      if (v == null) return false;
      return cond.op === 'below' ? v <= cond.value : v >= cond.value;
    }

    // This instrument and a peer pulled apart. Not correlation — correlation
    // is an average over a window and says nothing about today. This is the
    // day they disagreed.
    case 'divergence': {
      const self = inds[`chg:self:${cond.n || 5}`]?.cur;
      const peer = inds[`chg:${cond.peer}:${cond.n || 5}`]?.cur;
      if (self == null || peer == null) return false;
      const m = cond.value ?? 1;
      // 'bull': this one held or rose while the peer fell.
      if (cond.op === 'bull') return self >=  m && peer <= -m;
      if (cond.op === 'bear') return self <= -m && peer >=  m;
      return Math.abs(self - peer) >= m * 2;
    }

    // Where this instrument sits against a peer, relative to its own year.
    // The gold/silver ratio at an extreme is the obvious case.
    case 'ratio_pct': {
      const v = inds[`rpct:${cond.peer}`]?.cur;
      if (v == null) return false;
      return cond.op === 'below' ? v <= cond.value : v >= cond.value;
    }

    // The peer has already moved and this one has not — yet.
    //
    // The whole premise of the leadership work: when one market reprices a
    // shared driver, the ones that lag are the trade. A condition no
    // single-chart backtest can even state.
    case 'lead': {
      const n = cond.n || 3;
      const peer = inds[`chg:${cond.peer}:${n}`]?.cur;
      const self = inds[`chg:self:${n}`]?.cur;
      if (peer == null || self == null) return false;
      const m = cond.value ?? 1;
      if (cond.op === 'down') return peer <= -m && self > -m / 2;
      return peer >= m && self < m / 2;
    }

    // Calendar position. Month-end rebalancing, quarter-end flows and the
    // first-days-of-month bid are among the few effects with a mechanical
    // cause rather than a statistical one — and nobody backtests them.
    case 'dom': {
      if (!c.t) return false;
      const d = new Date(typeof c.t === 'number' ? c.t : Date.parse(c.t));
      const day = d.getUTCDate();
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      if (cond.op === 'turn')  return day <= 3 || day > last - 3;
      if (cond.op === 'first') return day <= 5;
      if (cond.op === 'mid')   return day > 10 && day <= 20;
      if (cond.op === 'last')  return day > last - 5;
      return false;
    }

    case 'quarter': {
      if (!c.t) return false;
      const m = new Date(typeof c.t === 'number' ? c.t : Date.parse(c.t)).getUTCMonth();
      return Math.floor(m / 3) + 1 === cond.value;
    }

    default: return false;
  }
}

// ── Pre-build required indicator arrays from conditions ───────────────────────
// ── The Live Feed's four measures, as rolling series ──────────────────────────
// Definitions copied deliberately from the feed's measure(): volatility
// percentile against the instrument's own ATR distribution, position in the
// 60-bar range, 20-bar change, and how one-sided the last 20 bars were.
//
// They must agree with the feed exactly. If they drift, "test this filter"
// silently backtests a DIFFERENT filter than the one on screen and reports a
// number for a strategy you never built — worse than having no bridge at all.
// feedMeasuresMatchTest in the test suite pins them together.
//
// Every value at bar i uses only bars up to i. An expanding percentile would be
// look-ahead; the window is the trailing WINDOW bars.
function feedMeasureSeries(candles, WINDOW = 500) {
  const n = candles.length;
  const volPct = new Array(n).fill(null);
  const rangePos = new Array(n).fill(null);
  const chg20 = new Array(n).fill(null);
  const persistence = new Array(n).fill(null);

  // ATR(14) at every bar, from true ranges
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const pc = candles[i - 1].c;
    tr[i] = Math.max(candles[i].h - candles[i].l,
                     Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
  }
  const atr = new Array(n).fill(null);
  for (let i = 14; i < n; i++) {
    let sum = 0;
    for (let k = i - 13; k <= i; k++) sum += tr[k] ?? 0;
    atr[i] = sum / 14;
  }

  for (let i = 0; i < n; i++) {
    if (atr[i] != null) {
      // Population starts at bar 15, not 14. The feed builds true ranges into a
      // separate array offset by one bar and then drops the first 14, so its
      // ATR distribution begins one bar later than the naive index suggests.
      // A one-element difference in the population shifts the percentile by a
      // point often enough to matter, and the feed is the published truth.
      const from = Math.max(15, i - WINDOW + 1);
      let below = 0, total = 0;
      for (let k = from; k <= i; k++) { if (atr[k] == null) continue; total++; if (atr[k] < atr[i]) below++; }
      if (total) volPct[i] = Math.round((below / total) * 100);
    }
    if (i >= 59) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - 59; k <= i; k++) { if (candles[k].h > hi) hi = candles[k].h; if (candles[k].l < lo) lo = candles[k].l; }
      rangePos[i] = hi > lo ? Math.round(((candles[i].c - lo) / (hi - lo)) * 100) : 50;
    }
    if (i >= 20) chg20[i] = +(((candles[i].c - candles[i - 20].c) / candles[i - 20].c) * 100).toFixed(2);
    if (i >= 19) {
      let ups = 0;
      for (let k = i - 19; k <= i; k++) if (candles[k].c > candles[k].o) ups++;
      persistence[i] = Math.round((Math.abs(ups - 10) / 10) * 100);
    }
  }
  return { volPct, rangePos, chg20, persistence };
}

const FEED_COND_TYPES = ['volpct', 'rangepos', 'chg20', 'persistence'];

// Indicator series, memoised on the candle array itself.
//
// A search runs 540 strategies over the SAME in-sample array, and every one of
// them rebuilt every series it needed from scratch. RSI over 140,000 bars is
// identical on run 1 and run 540; recomputing it is pure waste, and the
// volatility-percentile series — a rolling window — is far more expensive than
// that.
//
// Keyed by array identity in a WeakMap, so a slice is correctly a different
// dataset and the memory is released as soon as the candles are dropped.
// Nothing in the engine mutates a candle array, which is what makes identity a
// safe key.
const SERIES_CACHE = new WeakMap();
function cachedSeries(candles, key, build) {
  let m = SERIES_CACHE.get(candles);
  if (!m) { m = new Map(); SERIES_CACHE.set(candles, m); }
  if (!m.has(key)) m.set(key, build());
  return m.get(key);
}

function buildIndicators(candles, conditions) {
  const arrays = {};
  if (conditions.some(cd => FEED_COND_TYPES.includes(cd.type))) {
    Object.assign(arrays, cachedSeries(candles, 'feed', () => feedMeasureSeries(candles)));
  }
  const ensure = (type, period, period2, maType) => {
    const mt = maType || 'ema';
    if (type === 'rsi') {
      const k = `rsi_${period}`;
      if (!arrays[k]) arrays[k] = cachedSeries(candles, k, () => computeRSISeries(candles, period));
    }
    if (type === 'mfi') {
      const k = `mfi_${period}`;
      if (!arrays[k]) arrays[k] = cachedSeries(candles, k, () => computeMFISeries(candles, period));
    }
    if (type === 'ma') {
      const k = `${mt}_${period}`;
      if (!arrays[k]) arrays[k] = cachedSeries(candles, k, () => mt === 'sma' ? computeSMASeries(candles, period) : computeEMASeries(candles, period));
    }
    if (type === 'ma_cross') {
      const k1 = `${mt}_${period}`, k2 = `${mt}_${period2}`;
      if (!arrays[k1]) arrays[k1] = cachedSeries(candles, k1, () => mt === 'sma' ? computeSMASeries(candles, period)  : computeEMASeries(candles, period));
      if (!arrays[k2]) arrays[k2] = cachedSeries(candles, k2, () => mt === 'sma' ? computeSMASeries(candles, period2) : computeEMASeries(candles, period2));
    }
    if (type === 'macd'         && !arrays['macd'])   arrays['macd'] = cachedSeries(candles, 'macd', () => computeMACDSeries(candles));
    if (type === 'bos'          && !arrays['bos'])    arrays['bos'] = cachedSeries(candles, 'bos', () => computeBOSSeries(candles));
    if (type === 'fvg'          && !arrays['fvg'])    arrays['fvg'] = cachedSeries(candles, 'fvg', () => computeFVGSeries(candles));
    if (type === 'displacement' && !arrays['disp'])   arrays['disp'] = cachedSeries(candles, 'disp', () => computeDisplacementSeries(candles));
    if (type === 'ob'           && !arrays['ob'])     arrays['ob'] = cachedSeries(candles, 'ob', () => computeOBSeries(candles));
    if (type === 'ote_zone'     && !arrays['ote'])    arrays['ote'] = cachedSeries(candles, 'ote', () => computeOTESeries(candles));
    if (type === 'liquidity'    && !arrays['liq'])    arrays['liq'] = cachedSeries(candles, 'liq', () => computeLiquiditySweepSeries(candles));
    if (type === 'equal_hl'     && !arrays['ehl'])    arrays['ehl'] = cachedSeries(candles, 'ehl', () => computeEqualHLSeries(candles));
    if (type === 'consolidation'&& !arrays['consol']) arrays['consol'] = cachedSeries(candles, 'consol', () => computeConsolidationSeries(candles));
  };
  for (const cd of conditions) {
    ensure(cd.type, cd.period, cd.period2, cd.maType);
    // `stretch` is measured against an EMA in ATR units, so it needs both.
    if (cd.type === 'stretch') {
      const k = `ema_${cd.period || 50}`;
      if (!arrays[k]) arrays[k] = cachedSeries(candles, k, () => computeEMASeries(candles, cd.period || 50));
    }
    if (cd.type === 'stretch' || cd.type === 'gap') {
      if (!arrays['atr14']) arrays['atr14'] = cachedSeries(candles, 'atr_14', () => computeATRSeries(candles, 14));
    }
    if (cd.type === 'breakout') {
      const n = cd.n || 20, k = `ext_${n}`;
      if (!arrays[k]) arrays[k] = cachedSeries(candles, k, () => computeExtremeSeries(candles, n));
    }
    if (cd.type === 'strong_rev') { const k = `strev_${cd.n || 5}`; if (!arrays[k]) arrays[k] = cachedSeries(candles, k, () => computeStrongReversalSeries(candles, cd.n || 5)); }
    if (cd.type === 'volume' && !arrays['volAvg']) {
      const period = 20, out = new Array(candles.length).fill(null);
      for (let i = period; i < candles.length; i++) {
        let s = 0; for (let j = i - period; j < i; j++) s += candles[j].v || 1;
        out[i] = s / period;
      }
      arrays['volAvg'] = out;
    }
    const mc = mirrorCond(cd);
    ensure(mc.type, mc.period, mc.period2, mc.maType);
  }
  return arrays;
}

// ── Per-bar entry signal series (long / short / null) ─────────────────────────
// Uses the IDENTICAL entry logic as runBacktest, so fire-rate and the random
// baseline are guaranteed to measure the same thing the backtest actually trades.
export function computeSignalSeries(candles, strategy) {
  const res = new Array(candles?.length || 0).fill(null);
  const { conditions = [], logic = 'AND', direction = 'both' } = strategy || {};
  if (!candles || candles.length < 20 || conditions.length === 0) return res;

  const indArrays = buildIndicators(candles, conditions);
  const mirroredConds = conditions.map(mirrorCond);
  const needCandlestick = conditions.some(cd => cd.type === 'candlestick');
  const check = (condList, c, prev, inds, pattern, patternIds) =>
    logic === 'AND'
      ? condList.every(cd => evalCond(c, prev, inds, cd, pattern, patternIds))
      : condList.some(cd => evalCond(c, prev, inds, cd, pattern, patternIds));

  for (let i = 10; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    const inds = {};
    for (const [key, arr] of Object.entries(indArrays)) inds[key] = { cur: arr[i] ?? null, prev: arr[i - 1] ?? null };
    const pattern = detectPatternAt(candles, i);
    const patternIds = needCandlestick ? patternsAt(candles, i) : null;
    const longOk  = (direction === 'long'  || direction === 'both') && check(conditions,    c, prev, inds, pattern, patternIds);
    const shortOk = (direction === 'short' || direction === 'both') && check(mirroredConds, c, prev, inds, pattern, patternIds);
    res[i] = longOk ? 'long' : (shortOk ? 'short' : null);
  }
  return res;
}

// ── Main backtest runner ──────────────────────────────────────────────────────
// opts.entryOverride(i, candles) → 'long' | 'short' | null bypasses condition
// evaluation (used by the random-baseline grader) so the SAME exit / risk /
// spread mechanics run on differently-chosen entries.
export function runBacktest(candles, strategy, opts = {}) {
  if (!candles || candles.length < 20) return { trades: [], equityCurve: [10000] };

  const {
    conditions    = [],
    logic         = 'AND',
    direction     = 'both',
    exitType      = 'fixed',
    slType        = 'fixed',
    tpPips        = 50,
    slPips        = 25,
    tpAtr         = 2,
    slAtr         = 1,
    rrRatio       = 2,
    // Trailing-exit parameters. 3 ATR is wide on purpose: a tight trail is
    // clipped by every normal pullback, and being shaken out of one long trend
    // costs more than the giveback on twenty small ones combined.
    trailAtr      = 3,
    trailBars     = 0,          // 0 = ATR only; N = also trail a N-bar low/high
    swingLookback = 15,
    maxTrades     = 1,
    riskPct       = 1,
    symbol,
  } = strategy;

  if (conditions.length === 0) return { trades: [], equityCurve: [10000] };

  const pip         = getPipSize(symbol);
  const spreadPips  = strategy.spreadPips != null ? +strategy.spreadPips : defaultSpreadPips(symbol);
  const initEquity  = 10000;
  let equity        = initEquity;
  const equityCurve = [equity];
  const trades      = [];
  const open        = [];

  // Cross-asset and calendar series arrive pre-built (contextSeries.js) because
  // they need other instruments' candles, which the engine deliberately knows
  // nothing about. Merged here so they use the same per-bar snapshot as
  // everything else rather than a second lookup path inside the loop.
  const indArrays = opts.entryOverride ? {} : { ...buildIndicators(candles, conditions), ...(strategy.ctx || {}) };
  const atr       = cachedSeries(candles, 'atr_14', () => computeATRSeries(candles, 14));
  // Hoisted: Object.entries allocates a fresh array of pairs, and doing that
  // once per bar per strategy is 75 million throwaway arrays over a search.
  const indEntries = Object.entries(indArrays);

  const check = (condList, c, prev, inds, pattern, patternIds) => {
    if (logic === 'AND') return condList.every(cd => evalCond(c, prev, inds, cd, pattern, patternIds));
    return condList.some(cd => evalCond(c, prev, inds, cd, pattern, patternIds));
  };

  const entryOverride = typeof opts.entryOverride === 'function' ? opts.entryOverride : null;
  const mirroredConds = entryOverride ? [] : conditions.map(mirrorCond);
  const needCandlestick = !entryOverride && conditions.some(cd => cd.type === 'candlestick');

  // Patterns depend only on the candles, never on the strategy, so they are
  // computed once for the dataset and shared by all 540 combinations rather
  // than recomputed bar by bar inside each one.
  const patSeries = entryOverride ? [] : cachedSeries(candles, 'patAt',
    () => candles.map((_, i) => detectPatternAt(candles, i)));
  const patIdSeries = needCandlestick ? cachedSeries(candles, 'patIds',
    () => candles.map((_, i) => patternsAt(candles, i))) : null;

  for (let i = 10; i < candles.length; i++) {
    const c    = candles[i];
    const prev = candles[i - 1];

    // Build per-candle indicator snapshot. Skipped entirely when entries are
    // overridden (random baseline) — conditions are never evaluated there, so
    // computing indicators/patterns would be pure waste on every baseline run.
    const inds = {};
    let pattern = null, patternIds = null;
    if (!entryOverride) {
      for (let e = 0; e < indEntries.length; e++) {
        const arr = indEntries[e][1];
        inds[indEntries[e][0]] = { cur: arr[i] ?? null, prev: arr[i - 1] ?? null };
      }
      pattern = patSeries[i];
      patternIds = patIdSeries ? patIdSeries[i] : null;
    }

    // ── Exit open trades ──
    for (let t = open.length - 1; t >= 0; t--) {
      const trade = open[t];
      // ── Trailing stop ──────────────────────────────────────────────────
      // The engine could only ever set a fixed target at entry, which caps
      // every winner. That is fatal for the one approach with real long-run
      // evidence: trend following earns everything from a few trades running
      // far further than any target would have been placed, and capping them
      // keeps all the losers while cutting the only thing that pays for them.
      //
      // The stop ratchets on CLOSES so a single wick cannot drag it up, but it
      // is HIT intraday, because a real stop order sits in the market. Using
      // closes for both would quietly assume a discipline no broker provides.
      if (trade.trailing) {
        const a = atr[i] || trade.entry * 0.001;
        if (trade.dir === 'long') {
          trade.peak = Math.max(trade.peak ?? prev.c, prev.c);
          const byAtr = trade.peak - a * trade.trailAtr;
          const byBars = trade.trailBars
            ? Math.min(...candles.slice(Math.max(0, i - trade.trailBars), i).map(x => x.l))
            : -Infinity;
          const want = Math.max(byAtr, byBars);
          if (want > trade.sl) trade.sl = want;
        } else {
          trade.peak = Math.min(trade.peak ?? prev.c, prev.c);
          const byAtr = trade.peak + a * trade.trailAtr;
          const byBars = trade.trailBars
            ? Math.max(...candles.slice(Math.max(0, i - trade.trailBars), i).map(x => x.h))
            : Infinity;
          const want = Math.min(byAtr, byBars);
          if (want < trade.sl) trade.sl = want;
        }
      }

      let exitPrice = null, exitReason = null;

      if (trade.dir === 'long') {
        if (c.l <= trade.sl) { exitPrice = trade.sl; exitReason = trade.trailing ? 'TRAIL' : 'SL'; }
        else if (trade.tp != null && c.h >= trade.tp) { exitPrice = trade.tp; exitReason = 'TP'; }
      } else {
        if (c.h >= trade.sl) { exitPrice = trade.sl; exitReason = trade.trailing ? 'TRAIL' : 'SL'; }
        else if (trade.tp != null && c.l <= trade.tp) { exitPrice = trade.tp; exitReason = 'TP'; }
      }

      if (exitPrice !== null) {
        const grossPips = trade.dir === 'long'
          ? (exitPrice - trade.entry) / pip
          : (trade.entry - exitPrice) / pip;
        const pnlPips    = grossPips - spreadPips;            // deduct round-trip spread cost
        const riskDollars = equity * (riskPct / 100);
        const pnlDollars = riskDollars * (pnlPips / (trade.slPips || 1));
        equity += pnlDollars;
        equityCurve.push(equity);
        trades.push({
          ...trade, exit: exitPrice, exitReason,
          exitBar: i, exitTime: c.t,
          grossPips:  Math.round(grossPips * 10) / 10,
          spreadCost: spreadPips,
          riskDollars,
          pnlPips:    Math.round(pnlPips    * 10)  / 10,
          pnlDollars: Math.round(pnlDollars * 100) / 100,
          result: pnlPips > 0 ? 'win' : 'loss',
          equityAfter: Math.round(equity * 100) / 100,
          duration: i - trade.entryBar,
        });
        open.splice(t, 1);
      }
    }

    if (open.length >= maxTrades) continue;

    // ── Entry signals ──
    let dir;
    if (entryOverride) {
      dir = entryOverride(i, candles) || null;
    } else {
      const longOk  = (direction === 'long'  || direction === 'both') && check(conditions,    c, prev, inds, pattern, patternIds);
      const shortOk = (direction === 'short' || direction === 'both') && check(mirroredConds, c, prev, inds, pattern, patternIds);
      dir = longOk ? 'long' : (shortOk ? 'short' : null);
    }
    if (!dir) continue;

    const entry   = c.c;
    const currAtr = atr[i] || entry * 0.001;

    // ── Compute SL (independent of TP mode) ──
    let sl, slP;
    if (slType === 'swing') {
      const lb = swingLookback || 15;
      const swSlice = candles.slice(Math.max(0, i - lb), i);
      if (dir === 'long') {
        const swLow = Math.min(...swSlice.map(c2 => c2.l));
        sl  = swLow - pip * 3;
        slP = Math.max((entry - sl) / pip, 1);
      } else {
        const swHigh = Math.max(...swSlice.map(c2 => c2.h));
        sl  = swHigh + pip * 3;
        slP = Math.max((sl - entry) / pip, 1);
      }
    } else if (slType === 'atr') {
      slP = (currAtr * slAtr) / pip;
      sl  = dir === 'long' ? entry - currAtr * slAtr : entry + currAtr * slAtr;
    } else {
      slP = slPips;
      sl  = dir === 'long' ? entry - slPips * pip : entry + slPips * pip;
    }

    // ── Reject a stop that is not a real stop ────────────────────────────
    // A swing stop placed where the recent low IS the entry bar's low gives a
    // risk of a fraction of a pip. The old code floored that at 1 pip and
    // carried on, which corrupted everything downstream: R is pnl divided by
    // risk, so a trailing winner against a phantom stop reported thousands of
    // R, and position sizing — 1% of equity over the stop distance — implied a
    // position nobody could take.
    //
    // Rejecting is also what a person would do. You do not enter a trade whose
    // stop is inside the spread; you skip it.
    const minRisk = currAtr * 0.3;
    if (!(Math.abs(entry - sl) >= minRisk) || slP * pip < spreadPips * pip * 2) continue;

    // ── Compute TP ──
    let tp, tpP;
    if (exitType === 'trail') {
      tp = null; tpP = null;              // no target, by design
    } else if (exitType === 'rr') {
      tpP = slP * rrRatio;
      tp  = dir === 'long' ? entry + tpP * pip : entry - tpP * pip;
    } else if (exitType === 'atr') {
      tpP = (currAtr * tpAtr) / pip;
      tp  = dir === 'long' ? entry + currAtr * tpAtr : entry - currAtr * tpAtr;
    } else {
      tpP = tpPips;
      tp  = dir === 'long' ? entry + tpPips * pip : entry - tpPips * pip;
    }

    open.push({
      dir, entry, tp, sl,
      trailing:  exitType === 'trail',
      trailAtr:  trailAtr,
      trailBars: trailBars,
      peak:      entry,
      tpPips:    tpP == null ? null : Math.round(tpP * 10) / 10,
      slPips:    Math.round(slP * 10) / 10,
      entryBar:  i,
      entryTime: c.t,
    });
  }

  // Close remaining trades at last candle close
  const last = candles[candles.length - 1];
  for (const trade of open) {
    const exitPrice  = last.c;
    const grossPips  = trade.dir === 'long'
      ? (exitPrice - trade.entry) / pip
      : (trade.entry - exitPrice) / pip;
    const pnlPips    = grossPips - spreadPips;
    const riskDollars = equity * (riskPct / 100);
    const pnlDollars = riskDollars * (pnlPips / (trade.slPips || 1));
    equity += pnlDollars;
    equityCurve.push(equity);
    trades.push({
      ...trade, exit: exitPrice, exitReason: 'EOD',
      exitBar: candles.length - 1, exitTime: last.t,
      grossPips:  Math.round(grossPips * 10) / 10,
      spreadCost: spreadPips,
      riskDollars,
      pnlPips:    Math.round(pnlPips    * 10)  / 10,
      pnlDollars: Math.round(pnlDollars * 100) / 100,
      result: pnlPips > 0 ? 'win' : 'loss',
      equityAfter: Math.round(equity * 100) / 100,
      duration: candles.length - 1 - trade.entryBar,
    });
  }

  return { trades, equityCurve };
}

// ── Statistics ────────────────────────────────────────────────────────────────
export function calcStats(trades, initialEquity = 10000) {
  const empty = {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    totalPnlPips: 0, totalPnlDollars: 0, totalPnlPct: 0,
    profitFactor: 0, maxDrawdown: 0,
    avgWin: 0, avgLoss: 0, bestTrade: 0, worstTrade: 0, avgDuration: 0,
    sharpe: null, sortino: null, calmar: null,
    maxWinStreak: 0, maxLossStreak: 0,
    longWins: 0, longLosses: 0, longWinRate: null,
    shortWins: 0, shortLosses: 0, shortWinRate: null,
    avgRR: null, sdRR: null, seRR: null, monthlyPnl: [],
  };
  if (!trades || trades.length === 0) return empty;

  const wins   = trades.filter(t => t.result === 'win');
  const losses = trades.filter(t => t.result === 'loss');
  const grossP = wins.reduce((s, t)   => s + (t.pnlDollars || 0), 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + (t.pnlDollars || 0), 0));
  const totalD = trades.reduce((s, t) => s + (t.pnlDollars || 0), 0);

  // Equity curve + max drawdown
  let peak = initialEquity, maxDD = 0, eq = initialEquity;
  for (const t of trades) {
    eq += t.pnlDollars || 0;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const allPips = trades.map(t => t.pnlPips || 0);

  // Per-trade returns as % of equity (for Sharpe/Sortino)
  const returns = trades.map(t => (t.pnlDollars || 0) / initialEquity * 100);
  const meanR = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - meanR) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const downReturns = returns.filter(r => r < 0);
  const downVar = downReturns.length
    ? downReturns.reduce((s, v) => s + v ** 2, 0) / downReturns.length
    : 0;
  const downStd = Math.sqrt(downVar);

  const sharpe  = stdDev  > 0 ? +(meanR / stdDev).toFixed(2)  : null;
  const sortino = downStd > 0 ? +(meanR / downStd).toFixed(2) : null;
  const calmar  = maxDD   > 0 ? +((totalD / initialEquity * 100) / (maxDD * 100)).toFixed(2) : null;

  // Win/loss streaks
  let maxWinStreak = 0, maxLossStreak = 0, curW = 0, curL = 0;
  for (const t of trades) {
    if (t.result === 'win')  { curW++; curL = 0; maxWinStreak  = Math.max(maxWinStreak,  curW); }
    else                     { curL++; curW = 0; maxLossStreak = Math.max(maxLossStreak, curL); }
  }

  // Long vs Short breakdown
  const longTrades  = trades.filter(t => t.dir === 'long');
  const shortTrades = trades.filter(t => t.dir === 'short');
  const longWins    = longTrades.filter(t => t.result === 'win').length;
  const shortWins   = shortTrades.filter(t => t.result === 'win').length;

  // Average achieved R-multiple (pnlDollars / risk per trade)
  const rMultiples = trades
    .filter(t => t.riskDollars > 0)
    .map(t => t.pnlDollars / t.riskDollars);
  const rawAvgRR = rMultiples.length
    ? rMultiples.reduce((s, v) => s + v, 0) / rMultiples.length
    : null;
  const avgRR = rawAvgRR == null ? null : +rawAvgRR.toFixed(2);

  // How much the per-trade result actually varies, and therefore how much of
  // the average is signal.
  //
  // Expectancy on its own cannot be read. A trailing strategy wins rarely and
  // wins big, so single trades range from −1R to +15R; an average of +0.11R
  // over 400 of those is a very different claim from +0.11R over 400 trades
  // that all land near it. The standard error is the difference, and without
  // it every backtest number invites more confidence than it has earned.
  const sdRR = rMultiples.length > 1
    ? Math.sqrt(rMultiples.reduce((s, v) => s + (v - rawAvgRR) ** 2, 0) / (rMultiples.length - 1))
    : null;
  const seRR = sdRR != null ? sdRR / Math.sqrt(rMultiples.length) : null;

  // Monthly P&L buckets (use trade index as proxy when no timestamps)
  const monthlyMap = {};
  for (const t of trades) {
    let key;
    if (t.entryTime) {
      const d = new Date(typeof t.entryTime === 'number' ? t.entryTime * 1000 : t.entryTime);
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    } else {
      key = `B${Math.floor((trades.indexOf(t) / trades.length) * 12) + 1}`;
    }
    monthlyMap[key] = (monthlyMap[key] || 0) + (t.pnlDollars || 0);
  }
  const monthlyPnl = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, pnl]) => ({ label, pnl: Math.round(pnl * 100) / 100 }));

  return {
    totalTrades: trades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     Math.round(wins.length / trades.length * 1000) / 10,
    totalPnlPips:    Math.round(allPips.reduce((s, v) => s + v, 0) * 10) / 10,
    totalPnlDollars: Math.round(totalD * 100) / 100,
    totalPnlPct:     Math.round(totalD / initialEquity * 10000) / 100,
    profitFactor:    grossL === 0 ? (grossP > 0 ? 999 : 0) : Math.round(grossP / grossL * 100) / 100,
    maxDrawdown:     Math.round(maxDD * 10000) / 100,
    avgWin:          wins.length   ? Math.round(grossP / wins.length * 100) / 100 : 0,
    avgLoss:         losses.length ? Math.round(grossL / losses.length * 100) / 100 : 0,
    bestTrade:       Math.round(Math.max(...allPips) * 10) / 10,
    worstTrade:      Math.round(Math.min(...allPips) * 10) / 10,
    avgDuration:     Math.round(trades.reduce((s, t) => s + (t.duration || 0), 0) / trades.length),
    sharpe, sortino, calmar,
    maxWinStreak, maxLossStreak,
    longWins, longLosses: longTrades.length - longWins,
    longWinRate: longTrades.length ? Math.round(longWins / longTrades.length * 1000) / 10 : null,
    shortWins, shortLosses: shortTrades.length - shortWins,
    shortWinRate: shortTrades.length ? Math.round(shortWins / shortTrades.length * 1000) / 10 : null,
    avgRR,
    sdRR:  sdRR == null ? null : +sdRR.toFixed(3),
    seRR:  seRR == null ? null : +seRR.toFixed(3),
    monthlyPnl,
  };
}

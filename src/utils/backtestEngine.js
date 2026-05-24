// src/utils/backtestEngine.js
// Core backtesting engine — pure functions, no React dependencies.
// Candle format: { t, o, h, l, c, v }  (OANDA / generateCandles format)

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

// ── Pip size per instrument ───────────────────────────────────────────────────
export function getPipSize(symbol) {
  if (!symbol) return 0.0001;
  const s = symbol.toUpperCase();
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
    case 'liquidity': {
      const m = { bullish:'bearish', bearish:'bullish' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'equal_hl': {
      const m = { equalLows:'equalHighs', equalHighs:'equalLows' };
      return { ...cond, op: m[cond.op] || cond.op };
    }
    case 'consolidation':
      return cond;
    case 'pattern':
      return { ...cond, value: cond.value === 'bullish' ? 'bearish' : cond.value === 'bearish' ? 'bullish' : cond.value };
    case 'candle':
      return { ...cond, op: cond.op === 'bullish' ? 'bearish' : cond.op === 'bearish' ? 'bullish' : cond.op };
    default: return cond;
  }
}

// ── Evaluate a single condition at index i ────────────────────────────────────
function evalCond(c, prev, inds, cond, pattern) {
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
    case 'candle':
      if (cond.op === 'bullish') return c.c > c.o;
      if (cond.op === 'bearish') return c.c < c.o;
      return false;
    default: return false;
  }
}

// ── Pre-build required indicator arrays from conditions ───────────────────────
function buildIndicators(candles, conditions) {
  const arrays = {};
  const ensure = (type, period, period2, maType) => {
    const mt = maType || 'ema';
    if (type === 'rsi') {
      const k = `rsi_${period}`;
      if (!arrays[k]) arrays[k] = computeRSISeries(candles, period);
    }
    if (type === 'mfi') {
      const k = `mfi_${period}`;
      if (!arrays[k]) arrays[k] = computeMFISeries(candles, period);
    }
    if (type === 'ma') {
      const k = `${mt}_${period}`;
      if (!arrays[k]) arrays[k] = mt === 'sma' ? computeSMASeries(candles, period) : computeEMASeries(candles, period);
    }
    if (type === 'ma_cross') {
      const k1 = `${mt}_${period}`, k2 = `${mt}_${period2}`;
      if (!arrays[k1]) arrays[k1] = mt === 'sma' ? computeSMASeries(candles, period)  : computeEMASeries(candles, period);
      if (!arrays[k2]) arrays[k2] = mt === 'sma' ? computeSMASeries(candles, period2) : computeEMASeries(candles, period2);
    }
    if (type === 'macd'         && !arrays['macd'])   arrays['macd']   = computeMACDSeries(candles);
    if (type === 'bos'          && !arrays['bos'])    arrays['bos']    = computeBOSSeries(candles);
    if (type === 'fvg'          && !arrays['fvg'])    arrays['fvg']    = computeFVGSeries(candles);
    if (type === 'displacement' && !arrays['disp'])   arrays['disp']   = computeDisplacementSeries(candles);
    if (type === 'ob'           && !arrays['ob'])     arrays['ob']     = computeOBSeries(candles);
    if (type === 'ote_zone'     && !arrays['ote'])    arrays['ote']    = computeOTESeries(candles);
    if (type === 'liquidity'    && !arrays['liq'])    arrays['liq']    = computeLiquiditySweepSeries(candles);
    if (type === 'equal_hl'     && !arrays['ehl'])    arrays['ehl']    = computeEqualHLSeries(candles);
    if (type === 'consolidation'&& !arrays['consol']) arrays['consol'] = computeConsolidationSeries(candles);
  };
  for (const cd of conditions) {
    ensure(cd.type, cd.period, cd.period2, cd.maType);
    const mc = mirrorCond(cd);
    ensure(mc.type, mc.period, mc.period2, mc.maType);
  }
  return arrays;
}

// ── Main backtest runner ──────────────────────────────────────────────────────
export function runBacktest(candles, strategy) {
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
    swingLookback = 15,
    maxTrades     = 1,
    riskPct       = 1,
    symbol,
  } = strategy;

  if (conditions.length === 0) return { trades: [], equityCurve: [10000] };

  const pip         = getPipSize(symbol);
  const initEquity  = 10000;
  let equity        = initEquity;
  const equityCurve = [equity];
  const trades      = [];
  const open        = [];

  const indArrays = buildIndicators(candles, conditions);
  const atr       = computeATRSeries(candles, 14);

  const check = (condList, c, prev, inds, pattern) => {
    if (logic === 'AND') return condList.every(cd => evalCond(c, prev, inds, cd, pattern));
    return condList.some(cd => evalCond(c, prev, inds, cd, pattern));
  };

  const mirroredConds = conditions.map(mirrorCond);

  for (let i = 10; i < candles.length; i++) {
    const c    = candles[i];
    const prev = candles[i - 1];

    // Build per-candle indicator snapshot
    const inds = {};
    for (const [key, arr] of Object.entries(indArrays)) {
      inds[key] = { cur: arr[i] ?? null, prev: arr[i - 1] ?? null };
    }
    const pattern = detectPatternAt(candles, i);

    // ── Exit open trades ──
    for (let t = open.length - 1; t >= 0; t--) {
      const trade = open[t];
      let exitPrice = null, exitReason = null;

      if (trade.dir === 'long') {
        if (c.l <= trade.sl) { exitPrice = trade.sl; exitReason = 'SL'; }
        else if (c.h >= trade.tp) { exitPrice = trade.tp; exitReason = 'TP'; }
      } else {
        if (c.h >= trade.sl) { exitPrice = trade.sl; exitReason = 'SL'; }
        else if (c.l <= trade.tp) { exitPrice = trade.tp; exitReason = 'TP'; }
      }

      if (exitPrice !== null) {
        const pnlPips = trade.dir === 'long'
          ? (exitPrice - trade.entry) / pip
          : (trade.entry - exitPrice) / pip;
        const pnlDollars = equity * (riskPct / 100) * (pnlPips / (trade.slPips || 1));
        equity += pnlDollars;
        equityCurve.push(equity);
        trades.push({
          ...trade, exit: exitPrice, exitReason,
          exitBar: i, exitTime: c.t,
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
    const longOk  = (direction === 'long'  || direction === 'both') && check(conditions,    c, prev, inds, pattern);
    const shortOk = (direction === 'short' || direction === 'both') && check(mirroredConds, c, prev, inds, pattern);
    const dir = longOk ? 'long' : (shortOk ? 'short' : null);
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

    // ── Compute TP ──
    let tp, tpP;
    if (exitType === 'rr') {
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
      tpPips:    Math.round(tpP * 10) / 10,
      slPips:    Math.round(slP * 10) / 10,
      entryBar:  i,
      entryTime: c.t,
    });
  }

  // Close remaining trades at last candle close
  const last = candles[candles.length - 1];
  for (const trade of open) {
    const exitPrice  = last.c;
    const pnlPips    = trade.dir === 'long'
      ? (exitPrice - trade.entry) / pip
      : (trade.entry - exitPrice) / pip;
    const pnlDollars = equity * (riskPct / 100) * (pnlPips / (trade.slPips || 1));
    equity += pnlDollars;
    equityCurve.push(equity);
    trades.push({
      ...trade, exit: exitPrice, exitReason: 'EOD',
      exitBar: candles.length - 1, exitTime: last.t,
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
  if (!trades || trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnlPips: 0, totalPnlDollars: 0, totalPnlPct: 0,
      profitFactor: 0, maxDrawdown: 0,
      avgWin: 0, avgLoss: 0, bestTrade: 0, worstTrade: 0, avgDuration: 0,
    };
  }

  const wins   = trades.filter(t => t.result === 'win');
  const losses = trades.filter(t => t.result === 'loss');
  const grossP = wins.reduce((s, t)   => s + (t.pnlDollars || 0), 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + (t.pnlDollars || 0), 0));
  const totalD = trades.reduce((s, t) => s + (t.pnlDollars || 0), 0);

  let peak = initialEquity, maxDD = 0, eq = initialEquity;
  for (const t of trades) {
    eq += t.pnlDollars || 0;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const allPips = trades.map(t => t.pnlPips || 0);

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
  };
}

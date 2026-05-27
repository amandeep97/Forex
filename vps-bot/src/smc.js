'use strict';

function computeRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return candles[candles.length - 1]?.h - candles[candles.length - 1]?.l || 0.001;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const pc = candles[i - 1].c;
    sum += Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - pc),
      Math.abs(candles[i].l - pc),
    );
  }
  return sum / period;
}

function findSwings(candles, look = 3) {
  const n = candles.length;
  const highs = [], lows = [];
  for (let i = look; i < n - look; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= look; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) hi = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) lo = false;
    }
    if (hi) highs.push({ price: candles[i].h, idx: i });
    if (lo)  lows.push({ price: candles[i].l, idx: i });
  }
  return { highs, lows };
}

function detectStructure(candles) {
  const { highs, lows } = findSwings(candles, 3);
  if (highs.length < 2 || lows.length < 2) return 'ranging';
  const lastH1 = highs[highs.length - 2], lastH2 = highs[highs.length - 1];
  const lastL1 = lows[lows.length - 2],  lastL2 = lows[lows.length - 1];
  const hhhl = lastH2.price > lastH1.price && lastL2.price > lastL1.price;
  const lhll = lastH2.price < lastH1.price && lastL2.price < lastL1.price;
  if (hhhl) return 'bullish';
  if (lhll) return 'bearish';
  return 'ranging';
}

function detectBOS(candles) {
  if (candles.length < 20) return { hasBOS: false, hasCHoCH: false, direction: null };
  const n = candles.length;
  const { highs, lows } = findSwings(candles.slice(0, n - 1), 2);
  const isBull = highs.length >= 2 && highs[highs.length - 1].price > highs[0].price;

  let hasBOS = false, hasCHoCH = false, direction = null;

  for (let i = Math.max(5, n - 15); i < n; i++) {
    const c = candles[i];
    for (const sh of highs.filter(s => s.idx < i - 1)) {
      if (c.c > sh.price) {
        direction = 'bullish';
        if (isBull) hasBOS = true; else hasCHoCH = true;
        break;
      }
    }
    for (const sl of lows.filter(s => s.idx < i - 1)) {
      if (c.c < sl.price) {
        direction = 'bearish';
        if (!isBull) hasBOS = true; else hasCHoCH = true;
        break;
      }
    }
    if (hasBOS || hasCHoCH) break;
  }
  return { hasBOS, hasCHoCH, direction };
}

function detectOrderBlocks(candles) {
  if (candles.length < 10) return [];
  const n   = candles.length;
  const avg = candles.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / n || 1;
  const obs = [];
  for (let i = 1; i < n - 3; i++) {
    const c = candles[i], next = candles[i + 1], nn = candles[i + 2];
    const disp = Math.abs(nn.c - next.o);
    if (disp < avg * 1.2) continue;
    if (c.c < c.o && next.c > next.o && nn.c > c.o)
      obs.push({ type: 'bullish', top: c.o, bottom: c.c, high: c.h, low: c.l, idx: i });
    if (c.c > c.o && next.c < next.o && nn.c < c.o)
      obs.push({ type: 'bearish', top: c.c, bottom: c.o, high: c.h, low: c.l, idx: i });
  }
  return obs.slice(-5);
}

function detectFVGs(candles) {
  if (candles.length < 5) return [];
  const avg  = candles.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / candles.length || 1;
  const fvgs = [];
  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i], c3 = candles[i + 2];
    const gap = c1.h < c3.l ? c3.l - c1.h : (c1.l > c3.h ? c1.l - c3.h : 0);
    if (gap < avg * 0.1) continue;
    if (c1.h < c3.l) fvgs.push({ type: 'bullish', top: c3.l, bottom: c1.h, idx: i + 1 });
    else              fvgs.push({ type: 'bearish', top: c1.l, bottom: c3.h, idx: i + 1 });
  }
  return fvgs.slice(-6);
}

function detectOTE(candles, fibLevels) {
  if (candles.length < 15) return { bull: false, bear: false };
  const vis = candles.slice(-40);
  const n   = vis.length;
  const cp  = vis[n - 1].c;
  let swHigh = -Infinity, swHighIdx = 0, swLow = Infinity, swLowIdx = 0;
  for (let i = 0; i < n; i++) {
    if (vis[i].h > swHigh) { swHigh = vis[i].h; swHighIdx = i; }
    if (vis[i].l < swLow)  { swLow  = vis[i].l; swLowIdx  = i; }
  }
  const range = swHigh - swLow;
  if (range === 0) return { bull: false, bear: false };
  const levels = Array.isArray(fibLevels) && fibLevels.length >= 1
    ? [...fibLevels].sort((a, b) => a - b)
    : [0.618, 0.786];
  const fibMin = levels[0], fibMax = levels[levels.length - 1];
  const bull = swHighIdx < swLowIdx && cp >= swLow + range * fibMin && cp <= swLow + range * fibMax;
  const bear = swLowIdx < swHighIdx && cp >= swHigh - range * fibMax && cp <= swHigh - range * fibMin;
  return { bull, bear };
}

function getSwingLevels(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  return {
    recentSwingHigh: Math.max(...recent.map(c => c.h)),
    recentSwingLow:  Math.min(...recent.map(c => c.l)),
  };
}

function analyzeSMC(candles, opts = {}) {
  const structure   = detectStructure(candles);
  const bosResult   = detectBOS(candles);
  const obs         = detectOrderBlocks(candles);
  const fvgs        = detectFVGs(candles);
  const oteResult   = detectOTE(candles, opts.fibLevels);
  const rsi         = computeRSI(candles, 14);
  const atr         = computeATR(candles, 14);
  const { recentSwingHigh, recentSwingLow } = getSwingLevels(candles, 20);
  const cp          = candles[candles.length - 1].c;

  const hasBullOB = obs.some(ob => ob.type === 'bullish' && cp >= ob.bottom && cp <= ob.top + atr);
  const hasBearOB = obs.some(ob => ob.type === 'bearish' && cp <= ob.top   && cp >= ob.bottom - atr);
  const hasBullFVG = fvgs.some(f => f.type === 'bullish' && cp >= f.bottom && cp <= f.top + atr);
  const hasBearFVG = fvgs.some(f => f.type === 'bearish' && cp <= f.top   && cp >= f.bottom - atr);

  return {
    structure,
    hasBOS:      bosResult.hasBOS,
    hasCHoCH:    bosResult.hasCHoCH,
    bosDirection: bosResult.direction,
    hasOB:       obs.length > 0,
    hasBullOB,
    hasBearOB,
    hasFVG:      fvgs.length > 0,
    hasBullFVG,
    hasBearFVG,
    inOTEBull:   oteResult.bull,
    inOTEBear:   oteResult.bear,
    rsi,
    atr,
    recentSwingHigh,
    recentSwingLow,
    currentPrice: cp,
  };
}

module.exports = { analyzeSMC, computeRSI, computeATR, detectStructure, detectBOS, detectOrderBlocks, detectFVGs, detectOTE };

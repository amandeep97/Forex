// src/utils/smcAnalysis.js
// Smart Money Concepts (SMC / ICT) + Support/Resistance + Trendline analysis
// Works on any OHLC array with { o, h, l, c } fields.

// ── helpers ───────────────────────────────────────────────────────────────────
const body    = c => Math.abs(c.c - c.o);
const isGreen = c => c.c >= c.o;
const isRed   = c => c.c <  c.o;
function avgBody(arr) {
  return arr.reduce((s, c) => s + body(c), 0) / (arr.length || 1) || 1;
}
function localATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0.001;
  let atr = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const pc = candles[i - 1].c;
    atr += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
  }
  return atr / period;
}

// ── Order Blocks ──────────────────────────────────────────────────────────────
export function detectOrderBlocks(candles) {
  if (!candles || candles.length < 6) return [];
  const n   = candles.length;
  const avg = avgBody(candles);
  const obs = [];

  for (let i = 1; i < n - 3; i++) {
    const c    = candles[i];
    const next = candles[i + 1];
    const nn   = candles[i + 2];
    const displacement = Math.abs(nn.c - next.o);
    if (displacement < avg * 1.2) continue;

    if (isRed(c) && isGreen(next) && nn.c > c.o) {
      obs.push({ type: 'bullish', top: c.o, bottom: c.c, high: c.h, low: c.l, index: i });
    }
    if (isGreen(c) && isRed(next) && nn.c < c.o) {
      obs.push({ type: 'bearish', top: c.c, bottom: c.o, high: c.h, low: c.l, index: i });
    }
  }
  return obs.slice(-5);
}

// ── Fair Value Gaps ───────────────────────────────────────────────────────────
export function detectFVGs(candles) {
  if (!candles || candles.length < 3) return [];
  const n   = candles.length;
  const avg = avgBody(candles);
  const fvgs = [];

  for (let i = 0; i < n - 2; i++) {
    const c1 = candles[i];
    const c3 = candles[i + 2];
    const gapSize = c1.h < c3.l ? c3.l - c1.h : (c1.l > c3.h ? c1.l - c3.h : 0);
    if (gapSize < avg * 0.1) continue;

    if (c1.h < c3.l) {
      fvgs.push({ type: 'bullish', top: c3.l, bottom: c1.h, index: i + 1 });
    } else if (c1.l > c3.h) {
      fvgs.push({ type: 'bearish', top: c1.l, bottom: c3.h, index: i + 1 });
    }
  }
  return fvgs.slice(-8);
}

// ── Swing Highs / Lows ────────────────────────────────────────────────────────
function findSwings(candles, lookback = 3) {
  const n = candles.length;
  const highs = [], lows = [];
  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) isHigh = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) isLow  = false;
    }
    if (isHigh) highs.push({ price: candles[i].h, index: i });
    if (isLow)  lows.push({ price: candles[i].l, index: i });
  }
  return { highs, lows };
}

// ── Liquidity Pools ───────────────────────────────────────────────────────────
export function detectLiquidity(candles) {
  if (!candles || candles.length < 8) return [];
  const { highs, lows } = findSwings(candles, 3);
  const levels = [
    ...highs.slice(-5).map(h => ({ type: 'high', price: h.price, index: h.index, label: 'SSL' })),
    ...lows.slice(-5).map(l => ({ type: 'low',  price: l.price, index: l.index, label: 'BSL' })),
  ];
  return levels.sort((a, b) => a.index - b.index).slice(-8);
}

// ── Break of Structure / Change of Character ──────────────────────────────────
export function detectBOSCHoCH(candles) {
  if (!candles || candles.length < 12) return [];
  const n = candles.length;
  const { highs, lows } = findSwings(candles.slice(0, n - 1), 2);
  const signals = [];
  const used = new Set();

  const trendBullish = highs.length >= 2 && highs[highs.length - 1].price > highs[0].price;

  const checkFrom = Math.max(5, n - 18);
  for (let i = checkFrom; i < n; i++) {
    const c = candles[i];

    for (const sh of highs.filter(s => s.index < i - 1 && !used.has(`H${s.index}`))) {
      if (c.c > sh.price) {
        used.add(`H${sh.index}`);
        const isBOS = trendBullish;
        signals.push({ type: isBOS ? 'BOS' : 'CHoCH', direction: 'bullish', price: sh.price, index: i, label: (isBOS ? 'BOS' : 'CHoCH') + ' ↑' });
        break;
      }
    }
    for (const sl of lows.filter(s => s.index < i - 1 && !used.has(`L${s.index}`))) {
      if (c.c < sl.price) {
        used.add(`L${sl.index}`);
        const isBOS = !trendBullish;
        signals.push({ type: isBOS ? 'BOS' : 'CHoCH', direction: 'bearish', price: sl.price, index: i, label: (isBOS ? 'BOS' : 'CHoCH') + ' ↓' });
        break;
      }
    }
  }
  return signals.slice(-6);
}

// ── Support & Resistance ──────────────────────────────────────────────────────
export function detectSupportResistance(candles) {
  if (!candles || candles.length < 12) return [];
  const n   = candles.length;
  const tol = 0.0020;
  const pivots = [];

  for (let i = 3; i < n - 3; i++) {
    const slice = candles.slice(i - 3, i + 4);
    const maxH  = Math.max(...slice.map(c => c.h));
    const minL  = Math.min(...slice.map(c => c.l));
    if (candles[i].h >= maxH) pivots.push({ type: 'resistance', price: candles[i].h, index: i });
    if (candles[i].l <= minL) pivots.push({ type: 'support',    price: candles[i].l, index: i });
  }

  const merged = [];
  for (const p of pivots) {
    const ref = p.price || 1;
    const ex  = merged.find(m => m.type === p.type && Math.abs(m.price - p.price) / ref < tol);
    if (ex) {
      ex.touches++;
      ex.lastIndex = Math.max(ex.lastIndex, p.index);
      ex.price = (ex.price * (ex.touches - 1) + p.price) / ex.touches;
    } else {
      merged.push({ ...p, touches: 1, lastIndex: p.index });
    }
  }

  const currentPrice = candles[n - 1].c;
  return merged
    .filter(l => l.touches >= 2)
    .sort((a, b) => b.touches - a.touches)
    .slice(0, 8)
    .map(l => ({
      ...l,
      proximity: Math.abs(l.price - currentPrice) / (currentPrice || 1) * 100,
      isNear:    Math.abs(l.price - currentPrice) / (currentPrice || 1) < 0.004,
    }))
    .sort((a, b) => a.price - b.price);
}

// ── Trendlines ────────────────────────────────────────────────────────────────
export function detectTrendlines(candles) {
  if (!candles || candles.length < 10) return [];
  const n   = candles.length;
  const { highs, lows } = findSwings(candles, 3);
  const lines = [];
  const currentPrice = candles[n - 1].c;

  if (highs.length >= 2) {
    const h1 = highs[highs.length - 2], h2 = highs[highs.length - 1];
    const slope = (h2.price - h1.price) / (h2.index - h1.index);
    const priceAtEnd = h2.price + slope * (n - 1 - h2.index);
    let isBroken = false;
    for (let i = h2.index + 1; i < n; i++) {
      if (candles[i].c > h2.price + slope * (i - h2.index)) { isBroken = true; break; }
    }
    const proximity = Math.abs(priceAtEnd - currentPrice) / (currentPrice || 1) * 100;
    lines.push({ type: 'resistance', p1: h1, p2: h2, slope, priceAtEnd, isBroken, proximity, isNear: proximity < 0.4 && !isBroken, label: isBroken ? 'Resistance TL (Broken)' : 'Resistance Trendline' });
  }

  if (lows.length >= 2) {
    const l1 = lows[lows.length - 2], l2 = lows[lows.length - 1];
    const slope = (l2.price - l1.price) / (l2.index - l1.index);
    const priceAtEnd = l2.price + slope * (n - 1 - l2.index);
    let isBroken = false;
    for (let i = l2.index + 1; i < n; i++) {
      if (candles[i].c < l2.price + slope * (i - l2.index)) { isBroken = true; break; }
    }
    const proximity = Math.abs(priceAtEnd - currentPrice) / (currentPrice || 1) * 100;
    lines.push({ type: 'support', p1: l1, p2: l2, slope, priceAtEnd, isBroken, proximity, isNear: proximity < 0.4 && !isBroken, label: isBroken ? 'Support TL (Broken)' : 'Support Trendline' });
  }

  return lines;
}

// ── Premium / Discount Zones ──────────────────────────────────────────────────
export function detectPremiumDiscount(candles) {
  if (!candles || candles.length < 5) return null;
  const rangeHigh = Math.max(...candles.map(c => c.h));
  const rangeLow  = Math.min(...candles.map(c => c.l));
  const equilibrium = (rangeHigh + rangeLow) / 2;
  const currentPrice = candles[candles.length - 1].c;
  const range = rangeHigh - rangeLow || 1;
  const premBot = rangeHigh - range * 0.25;  // top 25% = premium (matches chart)
  const discTop = rangeLow  + range * 0.25;  // bottom 25% = discount (matches chart)
  const zone = currentPrice >= premBot ? 'premium'
             : currentPrice <= discTop ? 'discount'
             : 'equilibrium';
  return {
    rangeHigh, rangeLow, equilibrium,
    zone,
    deviation: ((currentPrice - equilibrium) / (equilibrium || 1)) * 100,
  };
}

// ── Breaker Blocks ────────────────────────────────────────────────────────────
// An OB becomes a breaker when price breaks through it and then retests from the other side.
export function detectBreakerBlocks(candles) {
  if (!candles || candles.length < 10) return { bull: false, bear: false };
  const obs = detectOrderBlocks(candles);
  const cp  = candles[candles.length - 1].c;
  const atr = localATR(candles);
  let bull = false, bear = false;

  for (const ob of obs) {
    const startIdx = ob.index + 3;
    if (ob.type === 'bullish') {
      // Bullish OB breaks down → now acts as resistance (bearish breaker)
      let broke = false;
      for (let i = startIdx; i < candles.length; i++) {
        if (candles[i].l < ob.bottom) { broke = true; break; }
      }
      if (broke && Math.abs(cp - ob.bottom) < atr * 2) bear = true;
    } else {
      // Bearish OB breaks up → now acts as support (bullish breaker)
      let broke = false;
      for (let i = startIdx; i < candles.length; i++) {
        if (candles[i].h > ob.top) { broke = true; break; }
      }
      if (broke && Math.abs(cp - ob.top) < atr * 2) bull = true;
    }
  }
  return { bull, bear };
}

// ── Optimal Trade Entry (OTE) ─────────────────────────────────────────────────
// fibLevels: optional array of retracement levels — zone spans from min to max
export function detectOTE(candles, fibLevels) {
  if (!candles || candles.length < 15) return { bull: false, bear: false };
  const slice = candles.slice(-40);
  const n = slice.length;
  const cp = slice[n - 1].c;

  let swingHigh = -Infinity, swingHighIdx = 0;
  let swingLow  = Infinity,  swingLowIdx  = 0;
  for (let i = 0; i < n; i++) {
    if (slice[i].h > swingHigh) { swingHigh = slice[i].h; swingHighIdx = i; }
    if (slice[i].l < swingLow)  { swingLow  = slice[i].l; swingLowIdx  = i; }
  }
  const range = swingHigh - swingLow;
  if (range === 0) return { bull: false, bear: false };

  const levels = Array.isArray(fibLevels) && fibLevels.length >= 1
    ? [...fibLevels].sort((a, b) => a - b)
    : [0.618, 0.786];
  const fibMin = levels[0], fibMax = levels[levels.length - 1];

  const bull = swingHighIdx < swingLowIdx
    && cp >= swingLow + range * fibMin
    && cp <= swingLow + range * fibMax;

  const bear = swingLowIdx < swingHighIdx
    && cp >= swingHigh - range * fibMax
    && cp <= swingHigh - range * fibMin;

  return { bull, bear };
}

// ── Displacement Candles ──────────────────────────────────────────────────────
// 3+ consecutive candles in the same direction with combined move > 2.5× avg body
export function detectDisplacement(candles) {
  if (!candles || candles.length < 5) return { bull: false, bear: false };
  const avgB  = avgBody(candles);
  const n     = candles.length;
  const c0    = candles[n - 3], c1 = candles[n - 2], c2 = candles[n - 1];
  const allBull  = c0.c > c0.o && c1.c > c1.o && c2.c > c2.o;
  const allBear  = c0.c < c0.o && c1.c < c1.o && c2.c < c2.o;
  const totalMove = Math.abs(c2.c - c0.o);
  return {
    bull: allBull && totalMove > avgB * 2.5,
    bear: allBear && totalMove > avgB * 2.5,
  };
}

// ── Consolidation Detection ───────────────────────────────────────────────────
// Recent ATR is much smaller than the longer-term ATR → price coiling
export function detectConsolidation(candles) {
  if (!candles || candles.length < 30) return false;
  const recentATR = localATR(candles.slice(-14), 14);
  const longerATR = localATR(candles.slice(-42), 14);
  return longerATR > 0 && (recentATR / longerATR) < 0.5;
}

// ── Full SMC Report ───────────────────────────────────────────────────────────
export function analyzeSMC(candles, opts = {}) {
  return {
    orderBlocks:       detectOrderBlocks(candles),
    fvgs:              detectFVGs(candles),
    liquidity:         detectLiquidity(candles),
    bosChoch:          detectBOSCHoCH(candles),
    supportResistance: detectSupportResistance(candles),
    trendlines:        detectTrendlines(candles),
    premiumDiscount:   detectPremiumDiscount(candles),
    breakerBlocks:     detectBreakerBlocks(candles),
    ote:               detectOTE(candles, opts.fibLevels),
    displacement:      detectDisplacement(candles),
    consolidation:     detectConsolidation(candles),
  };
}

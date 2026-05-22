// src/utils/smcHelpers.js
// Pure OHLCV math helpers — no crypto/broker dependencies.
// Candle format: { o, h, l, c, v }

export function detectSR(candles) {
  const n = candles.length;
  if (n < 10) return { supports: [], resistances: [] };
  const look = 3;
  const pivots = [];
  for (let i = look; i < n - look; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= look; j++) {
      if (candles[i-j].h >= candles[i].h || candles[i+j].h >= candles[i].h) isHigh = false;
      if (candles[i-j].l <= candles[i].l || candles[i+j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) pivots.push({ type:'high', price:candles[i].h, idx:i });
    if (isLow)  pivots.push({ type:'low',  price:candles[i].l, idx:i });
  }
  const allPrices = candles.flatMap(c => [c.h, c.l]);
  const threshold = (Math.max(...allPrices) - Math.min(...allPrices)) * 0.012;
  const levels = [];
  for (const p of pivots) {
    const ex = levels.find(l => Math.abs(l.price - p.price) < threshold);
    if (ex) { ex.count++; ex.price = (ex.price + p.price) / 2; }
    else levels.push({ price:p.price, type:p.type, count:1 });
  }
  const lastClose = candles[n-1].c;
  return {
    supports:    levels.filter(l => l.price < lastClose).sort((a,b) => b.count - a.count).slice(0,4),
    resistances: levels.filter(l => l.price > lastClose).sort((a,b) => b.count - a.count).slice(0,4),
  };
}

export function detectTrendlines(candles) {
  const n = candles.length;
  if (n < 12) return { resistTL:null, supportTL:null };
  const look = 3;
  const highs = [], lows = [];
  for (let i = look; i < n - look; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= look; j++) {
      if (candles[i-j].h >= candles[i].h || candles[i+j].h >= candles[i].h) isHigh = false;
      if (candles[i-j].l <= candles[i].l || candles[i+j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) highs.push({ price:candles[i].h, idx:i });
    if (isLow)  lows.push({  price:candles[i].l,  idx:i });
  }
  let resistTL = null;
  if (highs.length >= 2) {
    const h1 = highs[highs.length-2], h2 = highs[highs.length-1];
    if (h2.price < h1.price) resistTL = { x1:h1.idx, y1:h1.price, x2:h2.idx, y2:h2.price };
  }
  let supportTL = null;
  if (lows.length >= 2) {
    const l1 = lows[lows.length-2], l2 = lows[lows.length-1];
    if (l2.price > l1.price) supportTL = { x1:l1.idx, y1:l1.price, x2:l2.idx, y2:l2.price };
  }
  return { resistTL, supportTL };
}

export function zigzagSwings(candles) {
  const n = candles.length;
  if (n < 5) return { sHs:[], sLs:[], active:null };
  const atrN = Math.min(14, n-1);
  let atrSum = 0;
  for (let i = n-atrN; i < n; i++) {
    atrSum += Math.max(
      candles[i].h - candles[i].l,
      i > 0 ? Math.abs(candles[i].h - candles[i-1].c) : 0,
      i > 0 ? Math.abs(candles[i].l - candles[i-1].c) : 0
    );
  }
  const atr = atrN > 0 ? atrSum/atrN : (candles[n-1].h - candles[n-1].l || 1);
  const thr = atr * 1.5;
  const sHs = [], sLs = [];
  let dir = 'up', ep = candles[0].h, ei = 0;
  for (let i = 1; i < n; i++) {
    if (dir === 'up') {
      if (candles[i].h > ep) { ep = candles[i].h; ei = i; }
      else if (ep - candles[i].l >= thr) { sHs.push({ idx:ei, price:ep }); dir='down'; ep=candles[i].l; ei=i; }
    } else {
      if (candles[i].l < ep) { ep = candles[i].l; ei = i; }
      else if (candles[i].h - ep >= thr) { sLs.push({ idx:ei, price:ep }); dir='up'; ep=candles[i].h; ei=i; }
    }
  }
  return { sHs, sLs, active:{ dir, idx:ei, price:ep } };
}

export function detectFVGsAndOBs(candles) {
  if (candles.length < 8) return { fvgZones:[], obZones:[] };
  const { sHs, sLs, active } = zigzagSwings(candles);
  const n = candles.length;
  const fvgZones = [], obZones = [];

  function isFvgMitigated(type, topPrice, botPrice, sliceStart) {
    if (type === 'bullish') return candles.slice(sliceStart).some(c => c.l < topPrice);
    return candles.slice(sliceStart).some(c => c.h > botPrice);
  }
  function isObMitigated(type, topPrice, botPrice, sliceStart) {
    if (type === 'bullish') return candles.slice(sliceStart).some(c => c.c < botPrice);
    return candles.slice(sliceStart).some(c => c.c > topPrice);
  }
  function findOBAtSwing(swingIdx, type, prevOppositeIdx) {
    const isBull = type === 'bullish';
    const limit = prevOppositeIdx !== undefined ? prevOppositeIdx : 0;
    for (let i = swingIdx; i >= limit; i--) {
      const isTrigger = isBull ? candles[i].c < candles[i].o : candles[i].c > candles[i].o;
      if (isTrigger) {
        const ob = { type, idx:i, topPrice:candles[i].h, botPrice:candles[i].l };
        if (!isObMitigated(type, ob.topPrice, ob.botPrice, i+1)) obZones.push(ob);
        return;
      }
    }
  }

  const bullishSLs = [...sLs];
  if (active?.dir === 'down') bullishSLs.push({ idx:active.idx, price:active.price });
  for (let si = bullishSLs.length-1; si >= 0; si--) {
    const sl = bullishSLs[si];
    const sh = sHs.find(h => h.idx > sl.idx);
    const end = sh ? sh.idx-2 : n-3;
    const prevSH = [...sHs].reverse().find(h => h.idx < sl.idx);
    let resolved = false;
    for (let i = sl.idx+1; i <= end; i++) {
      if (i+2 < n && candles[i+2].l > candles[i].h) {
        const botPrice = candles[i].h, topPrice = candles[i+2].l;
        if (!isFvgMitigated('bullish', topPrice, botPrice, i+3)) {
          fvgZones.push({ type:'bullish', topPrice, botPrice, startIdx:i });
          findOBAtSwing(sl.idx, 'bullish', prevSH ? prevSH.idx : 0);
          resolved = true;
        }
        break;
      }
    }
    if (resolved) break;
  }

  const bearishSHs = [...sHs];
  if (active?.dir === 'up') bearishSHs.push({ idx:active.idx, price:active.price });
  for (let si = bearishSHs.length-1; si >= 0; si--) {
    const sh = bearishSHs[si];
    const sl = sLs.find(l => l.idx > sh.idx);
    const end = sl ? sl.idx-2 : n-3;
    const prevSL = [...sLs].reverse().find(l => l.idx < sh.idx);
    let resolved = false;
    for (let i = sh.idx+1; i <= end; i++) {
      if (i+2 < n && candles[i+2].h < candles[i].l) {
        const topPrice = candles[i].l, botPrice = candles[i+2].h;
        if (!isFvgMitigated('bearish', topPrice, botPrice, i+3)) {
          fvgZones.push({ type:'bearish', topPrice, botPrice, startIdx:i });
          findOBAtSwing(sh.idx, 'bearish', prevSL ? prevSL.idx : 0);
          resolved = true;
        }
        break;
      }
    }
    if (resolved) break;
  }
  return { fvgZones, obZones };
}

export function detectSweep(candles) {
  const n = candles.length;
  if (n < 6) return null;
  const last = candles[n-1];
  const prev = candles.slice(-6, -1);
  const prevHigh = Math.max(...prev.map(c => c.h));
  const prevLow  = Math.min(...prev.map(c => c.l));
  if (last.h > prevHigh && last.c < prevHigh) return { type:'bearish', idx:n-1, price:last.h };
  if (last.l < prevLow  && last.c > prevLow)  return { type:'bullish', idx:n-1, price:last.l };
  return null;
}

export function computeSwings(candles) {
  const n = candles.length;
  if (n < 5) return null;
  const atrN = Math.min(14, n-1);
  let atrSum = 0;
  for (let i = n-atrN; i < n; i++) {
    atrSum += Math.max(
      candles[i].h - candles[i].l,
      i > 0 ? Math.abs(candles[i].h - candles[i-1].c) : 0,
      i > 0 ? Math.abs(candles[i].l - candles[i-1].c) : 0
    );
  }
  const atr = atrN > 0 ? atrSum/atrN : (candles[n-1].h - candles[n-1].l || 1);
  function zz(thr) {
    const hs = [], ls = [];
    let dir = 'up', ep = candles[0].h, ei = 0;
    for (let i = 1; i < n; i++) {
      if (dir === 'up') {
        if (candles[i].h > ep) { ep=candles[i].h; ei=i; }
        else if (ep-candles[i].l >= thr) { hs.push({idx:ei,price:ep}); dir='down'; ep=candles[i].l; ei=i; }
      } else {
        if (candles[i].l < ep) { ep=candles[i].l; ei=i; }
        else if (candles[i].h-ep >= thr) { ls.push({idx:ei,price:ep}); dir='up'; ep=candles[i].h; ei=i; }
      }
    }
    return { hs, ls };
  }
  return { atr, short:zz(atr*0.5), mid:zz(atr*1.5), high:zz(atr*3.0) };
}

export function detectLiqLevels(candles, maxLevels = 4) {
  if (!candles || candles.length < 20) return { bsl:[], ssl:[] };
  const look = 3;
  const swingHighs = [], swingLows = [];
  for (let i = look; i < candles.length-look; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= look; j++) {
      if (candles[i-j].h >= candles[i].h || candles[i+j].h >= candles[i].h) isHigh = false;
      if (candles[i-j].l <= candles[i].l || candles[i+j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) swingHighs.push(candles[i].h);
    if (isLow)  swingLows.push(candles[i].l);
  }
  function mergeLevels(prices) {
    const sorted = [...prices].sort((a,b) => b-a);
    const merged = [], used = new Set();
    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue;
      const cluster = [sorted[i]]; let cnt = 1;
      for (let j = i+1; j < sorted.length; j++) {
        if (!used.has(j) && Math.abs(sorted[i]-sorted[j])/sorted[i] < 0.003) {
          cluster.push(sorted[j]); used.add(j); cnt++;
        }
      }
      used.add(i);
      merged.push({ price:cluster.reduce((s,v)=>s+v,0)/cluster.length, count:cnt });
    }
    return merged.sort((a,b)=>b.price-a.price).slice(0,maxLevels);
  }
  return { bsl:mergeLevels(swingHighs), ssl:mergeLevels(swingLows) };
}

// EMA series
export function computeEMASeries(candles, period) {
  if (candles.length < period) return new Array(candles.length).fill(null);
  const k = 2/(period+1);
  const res = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].c;
  res[period-1] = sum/period;
  for (let i = period; i < candles.length; i++) res[i] = candles[i].c*k + res[i-1]*(1-k);
  return res;
}

// Session VWAP
export function computeVWAP(candles) {
  let cumPV = 0, cumV = 0;
  return candles.map(c => {
    const tp = (c.h+c.l+c.c)/3;
    cumPV += tp*(c.v||1); cumV += (c.v||1);
    return cumV > 0 ? cumPV/cumV : null;
  });
}

// Point of Control
export function computePOC(candles, buckets = 60) {
  if (!candles.length) return null;
  const minP = Math.min(...candles.map(c=>c.l));
  const maxP = Math.max(...candles.map(c=>c.h));
  const range = maxP-minP || 1;
  const vol = new Array(buckets).fill(0);
  for (const c of candles) {
    const lo = Math.floor(((c.l-minP)/range)*(buckets-1));
    const hi = Math.ceil(((c.h-minP)/range)*(buckets-1));
    const v = (c.v||1)/Math.max(1,hi-lo+1);
    for (let i = lo; i <= hi; i++) if (i>=0&&i<buckets) vol[i]+=v;
  }
  const maxIdx = vol.indexOf(Math.max(...vol));
  return minP+(maxIdx/(buckets-1))*range;
}

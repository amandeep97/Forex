// src/utils/topDown.js
// Top-down analysis engine, moved verbatim out of TopDownSignals.jsx.
//
// It was previously trapped inside the component, so nothing else in the app
// could read the H4/H1/M15 read, the order blocks, the fair value gaps or the
// resulting entry — the Terminal could not aggregate what it could not call.
// The component now imports these and renders exactly as before; the logic is
// unchanged, only its address.
import { computeValueArea, computeFib } from './smcHelpers';
import { detectOTE, detectBreakerBlocks } from './smcAnalysis';

const PAIRS = [
  'XAG_USD',
  'EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','NZD_USD','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_AUD','EUR_CAD','EUR_CHF',
  'GBP_JPY','GBP_AUD','GBP_CAD','GBP_CHF',
  'AUD_JPY','CAD_JPY','CHF_JPY','NZD_JPY',
];

const KILLZONES = [
  { name:'Asian KZ',     s:0,    e:240,  color:'#f59e0b' },
  { name:'London KZ',    s:420,  e:600,  color:'#8b5cf6' },
  { name:'London Close', s:660,  e:720,  color:'#38bdf8' },
  { name:'NY AM KZ',     s:780,  e:960,  color:'#22c55e' },
  { name:'NY PM KZ',     s:1080, e:1200, color:'#f97316' },
];

// Best UTC session hours per pair
const PAIR_SESSIONS = {
  EUR_USD:{ f:8,  t:17 }, GBP_USD:{ f:8,  t:17 }, USD_JPY:{ f:0,  t:12 },
  USD_CHF:{ f:8,  t:17 }, AUD_USD:{ f:22, t:9  }, NZD_USD:{ f:22, t:9  },
  USD_CAD:{ f:13, t:22 }, EUR_GBP:{ f:8,  t:17 }, EUR_JPY:{ f:8,  t:13 },
  EUR_AUD:{ f:8,  t:13 }, EUR_CAD:{ f:13, t:17 }, EUR_CHF:{ f:8,  t:17 },
  GBP_JPY:{ f:8,  t:13 }, GBP_AUD:{ f:8,  t:12 }, GBP_CAD:{ f:13, t:17 },
  GBP_CHF:{ f:8,  t:17 }, AUD_JPY:{ f:0,  t:9  }, CAD_JPY:{ f:8,  t:17 },
  CHF_JPY:{ f:8,  t:13 }, NZD_JPY:{ f:0,  t:9  }, XAG_USD:{ f:8,  t:17 },
};

// Expected direction for each pair when DXY is BULLISH
// null = cross pair, DXY less relevant
const DXY_BULL_DIR = {
  EUR_USD:'short', GBP_USD:'short', USD_JPY:'long',  USD_CHF:'long',
  AUD_USD:'short', NZD_USD:'short', USD_CAD:'long',  XAG_USD:'short',
  EUR_JPY:null, EUR_GBP:null, EUR_AUD:null, EUR_CAD:null, EUR_CHF:null,
  GBP_JPY:null, GBP_AUD:null, GBP_CAD:null, GBP_CHF:null,
  AUD_JPY:null, CAD_JPY:null, CHF_JPY:null, NZD_JPY:null,
};

function getCurrentKZ() {
  const now  = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return KILLZONES.find(kz => mins >= kz.s && mins < kz.e) || null;
}

function getNextKZ() {
  const now  = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  let best = null, bestDiff = Infinity;
  for (const kz of KILLZONES) {
    const diff = kz.s > mins ? kz.s - mins : kz.s + 1440 - mins;
    if (diff < bestDiff) { bestDiff = diff; best = { ...kz, minsUntil: diff }; }
  }
  return best;
}

function isInSession(pairKey) {
  const s = PAIR_SESSIONS[pairKey];
  if (!s) return null;
  const h = new Date().getUTCHours();
  return s.f < s.t ? (h >= s.f && h < s.t) : (h >= s.f || h < s.t);
}

function getDOWInfo() {
  const day = new Date().getUTCDay();
  const labels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (day === 1) return { ok: true,  label: 'Mon', note: 'Rule 1 target' };
  if (day === 4) return { ok: true,  label: 'Thu', note: 'Rule 2 target' };
  return         { ok: false, label: labels[day], note: 'Not a target day' };
}

function getDXYBias(results) {
  const eur = results['EUR_USD'];
  if (!eur?.h4) return null;
  if (eur.h4.structure === 'bearish') return 'bull'; // EUR/USD down = DXY up
  if (eur.h4.structure === 'bullish') return 'bear';
  return null;
}

function isDXYAligned(pairKey, data, dxyBias) {
  if (!dxyBias) return null;
  const expectedDir = DXY_BULL_DIR[pairKey];
  if (expectedDir === undefined || expectedDir === null) return null;
  const actualDir = data?.signal?.dir ??
    (data?.h4?.structure === 'bullish' ? 'long'  :
     data?.h4?.structure === 'bearish' ? 'short' : null);
  if (!actualDir) return null;
  const expectedSignalDir = dxyBias === 'bull' ? expectedDir : (expectedDir === 'long' ? 'short' : 'long');
  return actualDir === expectedSignalDir;
}

function getCreds() {
  const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
  if (c?.apiKey) { const _e = localStorage.getItem('oanda_env'); return _e !== null ? { ...c, practice: _e !== 'live' } : c; }
  return { apiKey: localStorage.getItem('oanda_key'), practice: localStorage.getItem('oanda_env') !== 'live' };
}

async function fetchOHLC(instrument, granularity, count) {
  const { apiKey, practice } = getCreds();
  if (!apiKey) return null;
  const base = practice !== false
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  try {
    const r = await fetch(
      `${base}/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return (d.candles || [])
      .filter(c => c.complete)
      .map(c => ({ o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, v: c.volume||1, t: c.time }));
  } catch { return null; }
}

// ── SMC helpers ───────────────────────────────────────────────────────────────

function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0.001;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const pc = candles[i - 1].c;
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
  }
  return sum / period;
}

function detectStructure(candles) {
  if (!candles || candles.length < 10) return 'ranging';
  const look = 3, n = candles.length;
  const highs = [], lows = [];
  for (let i = look; i < n - look; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= look; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) hi = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) lo = false;
    }
    if (hi) highs.push(candles[i].h);
    if (lo)  lows.push(candles[i].l);
  }
  if (highs.length < 2 || lows.length < 2) return 'ranging';
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  if (h2 > h1 && l2 > l1) return 'bullish';
  if (h2 < h1 && l2 < l1) return 'bearish';
  return 'ranging';
}

function detectOBs(candles) {
  if (!candles || candles.length < 10) return [];
  const n   = candles.length;
  const avg = candles.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / n || 1;
  const obs = [];
  for (let i = 1; i < n - 3; i++) {
    const c = candles[i], nx = candles[i + 1], nn = candles[i + 2];
    if (Math.abs(nn.c - nx.o) < avg * 1.2) continue;

    if (c.c < c.o && nx.c > nx.o && nn.c > c.o) {
      // Bullish OB — mitigated if any later candle closes below OB low
      const mitigated = candles.slice(i + 3).some(x => x.c < c.l);
      if (!mitigated) obs.push({ type: 'bullish', top: c.o, bottom: c.c, low: c.l });
    }
    if (c.c > c.o && nx.c < nx.o && nn.c < c.o) {
      // Bearish OB — mitigated if any later candle closes above OB high
      const mitigated = candles.slice(i + 3).some(x => x.c > c.h);
      if (!mitigated) obs.push({ type: 'bearish', top: c.c, bottom: c.o, high: c.h });
    }
  }
  return obs.slice(-10);
}

function detectFVGs(candles) {
  if (!candles || candles.length < 5) return [];
  const avg = candles.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / candles.length || 1;
  const fvgs = [];
  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i], c3 = candles[i + 2];
    const gap = c1.h < c3.l ? c3.l - c1.h : (c1.l > c3.h ? c1.l - c3.h : 0);
    if (gap < avg * 0.1) continue;
    if (c1.h < c3.l) fvgs.push({ type: 'bullish', top: c3.l, bottom: c1.h });
    else              fvgs.push({ type: 'bearish', top: c1.l, bottom: c3.h });
  }
  return fvgs.slice(-10);
}

function analyzeTimeframe(candles) {
  if (!candles || candles.length < 20) return null;
  const cp  = candles[candles.length - 1].c;
  const atr = computeATR(candles);
  const structure = detectStructure(candles);

  const recent    = candles.slice(-20);
  const swingHigh = Math.max(...recent.map(c => c.h));
  const swingLow  = Math.min(...recent.map(c => c.l));
  const midpoint  = (swingHigh + swingLow) / 2;
  const zone      = cp < midpoint ? 'discount' : 'premium';

  const obs  = detectOBs(candles);
  const fvgs = detectFVGs(candles);

  const bullOB = obs.find(ob =>
    ob.type === 'bullish' && ob.top < midpoint &&
    cp >= ob.bottom && cp <= ob.top + atr
  ) || null;

  const bearOB = obs.find(ob =>
    ob.type === 'bearish' && ob.bottom > midpoint &&
    cp <= ob.top && cp >= ob.bottom - atr
  ) || null;

  const bullFVG = fvgs.find(f =>
    f.type === 'bullish' && f.top < midpoint &&
    cp >= f.bottom - atr * 0.5 && cp <= f.top + atr * 0.5
  ) || null;

  const bearFVG = fvgs.find(f =>
    f.type === 'bearish' && f.bottom > midpoint &&
    cp >= f.bottom - atr * 0.5 && cp <= f.top + atr * 0.5
  ) || null;

  const ote = detectOTE(candles);
  const bb  = detectBreakerBlocks(candles);

  return { cp, atr, structure, zone, swingHigh, swingLow, bullOB, bearOB, bullFVG, bearFVG, ote, bb };
}

// ── Liquidity path check — finds pools blocking the path to TP ────────────────
function checkLiqPath(dir, entry, tp, h1Candles) {
  if (!h1Candles || h1Candles.length < 20) return null;
  const look = 3, n = h1Candles.length;
  const highs = [], lows = [];
  for (let i = look; i < n - look; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= look; j++) {
      if (h1Candles[i].h <= h1Candles[i-j].h || h1Candles[i].h <= h1Candles[i+j].h) hi = false;
      if (h1Candles[i].l >= h1Candles[i-j].l || h1Candles[i].l >= h1Candles[i+j].l) lo = false;
    }
    if (hi) highs.push(h1Candles[i].h);
    if (lo)  lows.push(h1Candles[i].l);
  }
  if (dir === 'long') {
    // BSL (equal highs / swing highs) sitting between entry and TP = will get swept first
    const pools = highs.filter(h => h > entry * 1.00005 && h < tp * 0.9999);
    return pools.length ? Math.min(...pools) : null;
  } else {
    // SSL (equal lows / swing lows) sitting between entry and TP
    const pools = lows.filter(l => l < entry * 0.99995 && l > tp * 1.0001);
    return pools.length ? Math.max(...pools) : null;
  }
}

// ── Signal generation ────────────────────────────────────────────────────────
function getSignal(h4, h1, m15, h1Candles) {
  if (!h4 || !h1 || !m15) return null;

  const longOK =
    h4.structure === 'bullish' &&          // H4 must be bullish
    h1.structure !== 'bearish' &&          // H1 must NOT oppose H4
    h1.zone === 'discount' &&              // H1 in pullback zone
    m15.zone === 'discount' &&             // M15 in entry zone
    m15.structure !== 'bearish' &&         // M15 not opposing
    (m15.bullOB || m15.bullFVG);           // M15 POI for entry

  const shortOK =
    h4.structure === 'bearish' &&          // H4 must be bearish
    h1.structure !== 'bullish' &&          // H1 must NOT oppose H4
    h1.zone === 'premium' &&               // H1 in pullback zone
    m15.zone === 'premium' &&              // M15 in entry zone
    m15.structure !== 'bullish' &&         // M15 not opposing
    (m15.bearOB || m15.bearFVG);           // M15 POI for entry

  if (!longOK && !shortOK) return null;

  const dir     = longOK ? 'long' : 'short';
  const entry   = m15.cp;
  const minDist = m15.atr * 2.5;
  let sl;

  if (dir === 'long') {
    const structural = Math.min(
      m15.bullOB?.low     ?? Infinity,
      m15.bullFVG?.bottom ?? Infinity,
      m15.swingLow
    ) - m15.atr * 0.15;
    sl = Math.min(structural, entry - minDist);
  } else {
    const structural = Math.max(
      m15.bearOB?.high ?? -Infinity,
      m15.bearFVG?.top ?? -Infinity,
      m15.swingHigh
    ) + m15.atr * 0.15;
    sl = Math.max(structural, entry + minDist);
  }

  const risk = Math.abs(entry - sl);
  const tp   = dir === 'long' ? entry + risk * 2 : entry - risk * 2;
  const rr   = +(Math.abs(tp - entry) / risk).toFixed(1);

  const liqBlock = checkLiqPath(dir, entry, tp, h1Candles);
  const kz       = getCurrentKZ();

  // Quality score (max 5)
  let quality = 0;
  if (kz)                                                               quality++; // right timing
  if (h1.structure === h4.structure)                                    quality++; // H1 fully aligns H4
  if (m15.structure === h4.structure)                                   quality++; // M15 fully aligns too
  if ((dir==='long' && m15.bullOB) || (dir==='short' && m15.bearOB))   quality++; // OB entry > FVG
  if ((dir==='long' && m15.ote?.bull) || (dir==='short' && m15.ote?.bear) ||
      (dir==='long' && m15.bb?.bull)  || (dir==='short' && m15.bb?.bear))  quality++; // OTE or BB confluence

  // Blocking liquidity = hard cap at grade B
  if (liqBlock) quality = Math.min(quality, 1);

  return { dir, entry, sl, tp, rr, liqBlock, kz, quality };
}

// ── Formatting ────────────────────────────────────────────────────────────────

const fmtPair = p => p.replace('_', '/');

function fmtPrice(pair, price) {
  const isJpy   = pair.includes('JPY');
  const isMetal = pair.startsWith('XA');
  return price?.toFixed(isMetal ? 3 : isJpy ? 3 : 5) ?? '—';
}

function fmtDist(pair, dist) {
  if (!dist) return '—';
  const isMetal = pair.startsWith('XA');
  const isJpy   = pair.includes('JPY');
  if (isMetal) return `$${Math.abs(dist).toFixed(3)}`;
  const pips = Math.round(Math.abs(dist) * (isJpy ? 100 : 10000));
  return `${pips}p`;
}

function alignScore(h4, h1, m15) {
  if (!h4 || !h1 || !m15) return 0;
  let s = 0;
  if (h4.structure === 'bullish' || h4.structure === 'bearish') s++;
  if (h1.structure === h4.structure) s++;
  if ((h4.structure === 'bullish' && m15.zone === 'discount') ||
      (h4.structure === 'bearish' && m15.zone === 'premium')) s++;
  if (m15.bullOB || m15.bearOB || m15.bullFVG || m15.bearFVG) s++;
  return s;
}

export {
  DXY_BULL_DIR,
  KILLZONES,
  PAIRS,
  PAIR_SESSIONS,
  alignScore,
  analyzeTimeframe,
  checkLiqPath,
  computeATR,
  detectFVGs,
  detectOBs,
  detectStructure,
  fetchOHLC,
  fmtDist,
  fmtPair,
  fmtPrice,
  getCreds,
  getCurrentKZ,
  getDOWInfo,
  getDXYBias,
  getNextKZ,
  getSignal,
  isDXYAligned,
  isInSession,
};

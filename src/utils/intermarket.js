// Intermarket correlation signals — fetches OANDA candles for DXY/Gold/Silver/Oil/Bonds
// Dynamic Pearson correlation calculated live from 50 H1 candles

export const IM_DEFS = [
  { key: 'dxy',    label: 'DXY',    oanda: 'EUR_USD',     invert: true,  color: '#38bdf8', desc: 'US Dollar Index (EUR/USD inverse)' },
  { key: 'gold',   label: 'Gold',   oanda: 'XAU_USD',     invert: false, color: '#fbbf24', desc: 'Gold (XAU/USD)' },
  { key: 'silver', label: 'Silver', oanda: 'XAG_USD',     invert: false, color: '#94a3b8', desc: 'Silver (XAG/USD)' },
  { key: 'oil',    label: 'Oil',    oanda: 'BCO_USD',      invert: false, color: '#f97316', desc: 'Brent Crude Oil' },
  { key: 'bonds',  label: 'US10Y',  oanda: 'USB10Y_USD',  invert: false, color: '#a78bfa', desc: 'US 10-Year Bond Yield' },
];

// Which markets are relevant to show per pair (used in ChartModal)
export const PAIR_RELEVANT = {
  EUR_USD: ['dxy'],
  GBP_USD: ['dxy'],
  AUD_USD: ['dxy', 'gold'],
  NZD_USD: ['dxy', 'gold'],
  USD_CHF: ['dxy', 'gold'],
  USD_JPY: ['dxy', 'bonds'],
  USD_CAD: ['dxy', 'oil'],
  EUR_JPY: ['dxy', 'bonds'],
  GBP_JPY: ['dxy', 'bonds'],
  AUD_JPY: ['gold', 'bonds'],
  XAU_USD: ['dxy', 'gold'],
  XAG_USD: ['dxy', 'silver'],
  BCO_USD: ['dxy', 'oil'],
};

// Static fallback correlations (used when OANDA not connected)
export const PAIR_CORR = {
  EUR_USD: { dxy: -1 },
  GBP_USD: { dxy: -1 },
  AUD_USD: { dxy: -1, gold: 0.6 },
  NZD_USD: { dxy: -1 },
  USD_CHF: { dxy: 1, gold: -0.5 },
  USD_JPY: { dxy: 1, bonds: 0.7 },
  USD_CAD: { dxy: 1, oil: -0.7 },
  EUR_JPY: { bonds: 0.5 },
  GBP_JPY: { bonds: 0.5 },
  AUD_JPY: { gold: 0.5 },
  XAU_USD: { dxy: -1, gold: 1 },
  XAG_USD: { dxy: -1, silver: 1 },
};

// Pearson correlation coefficient — returns -1 to +1
function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const ax = a.slice(-n), bx = b.slice(-n);
  const mA = ax.reduce((s, v) => s + v, 0) / n;
  const mB = bx.reduce((s, v) => s + v, 0) / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const x = ax[i] - mA, y = bx[i] - mB;
    num += x * y; dA += x * x; dB += y * y;
  }
  const denom = Math.sqrt(dA * dB);
  return denom === 0 ? null : +(num / denom).toFixed(2);
}

function getOandaCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) return c;
  } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}

async function fetchCloses(instrument, tf, count) {
  const creds = getOandaCreds();
  if (!creds) return null;
  const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
  try {
    const res = await fetch(
      `${base}/instruments/${instrument}/candles?granularity=${tf}&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.candles || []).filter(c => c.complete).map(c => +c.mid.c);
  } catch { return null; }
}

export async function getIMSignals(tf = 'H1', lookback = 5) {
  const results = {};
  await Promise.all(IM_DEFS.map(async def => {
    const closes = await fetchCloses(def.oanda, tf, lookback + 6);
    if (!closes || closes.length < lookback + 1) { results[def.key] = null; return; }
    const now  = closes[closes.length - 1];
    const prev = closes[closes.length - 1 - lookback];
    const pct  = ((now - prev) / prev) * 100;
    const rawRising = now > prev;
    results[def.key] = {
      ...def,
      price: now,
      pct:   def.invert ? -pct : pct,
      direction: def.invert ? (rawRising ? 'falling' : 'rising') : (rawRising ? 'rising' : 'falling'),
    };
  }));
  return results;
}

// Fetch IM signals + live Pearson correlations for a specific pair
// Returns: { signals: {dxy,gold,...}, correlations: {dxy: -0.87, gold: 0.63, ...} }
export async function getIMData(pairOanda, tf = 'H1', corrLookback = 50) {
  const sigLookback = 5;
  const fetchCount  = corrLookback + sigLookback + 5;

  const [pairCloses, ...mktClosesArr] = await Promise.all([
    fetchCloses(pairOanda, tf, fetchCount),
    ...IM_DEFS.map(def => fetchCloses(def.oanda, tf, fetchCount)),
  ]);

  const signals      = {};
  const correlations = {};

  IM_DEFS.forEach((def, i) => {
    const closes = mktClosesArr[i];
    if (!closes?.length) { signals[def.key] = null; return; }

    // Direction signal (last 5 candles)
    const now  = closes[closes.length - 1];
    const prev = closes[closes.length - 1 - sigLookback];
    if (!prev) { signals[def.key] = null; return; }
    const pct        = ((now - prev) / prev) * 100;
    const rawRising  = now > prev;
    signals[def.key] = {
      ...def, price: now,
      pct:       def.invert ? -pct : pct,
      direction: def.invert ? (rawRising ? 'falling' : 'rising') : (rawRising ? 'rising' : 'falling'),
    };

    // Live Pearson correlation (last corrLookback candles)
    if (pairCloses?.length >= 20 && closes.length >= 20) {
      const n       = Math.min(corrLookback, pairCloses.length, closes.length);
      const rawCorr = pearsonCorr(pairCloses.slice(-n), closes.slice(-n));
      if (rawCorr !== null) {
        // Flip sign for inverted markets (DXY = EUR/USD inverse)
        correlations[def.key] = def.invert ? +(-rawCorr).toFixed(2) : rawCorr;
      }
    }
  });

  return { signals, correlations };
}

// Given intermarket filter settings and live signals, return true if trade is allowed
// filter = { enabled, dxy: 'any'|'rising'|'falling', gold: ..., oil: ..., bonds: ... }
export function checkIMFilter(filter, signals) {
  if (!filter?.enabled) return true;
  for (const def of IM_DEFS) {
    const required = filter[def.key];
    if (!required || required === 'any') continue;
    const sig = signals?.[def.key];
    if (!sig) continue; // can't fetch = don't block
    if (sig.direction !== required) return false;
  }
  return true;
}

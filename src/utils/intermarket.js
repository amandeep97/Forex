// Intermarket correlation signals — fetches OANDA candles for DXY/Gold/Silver/Oil/Bonds

export const IM_DEFS = [
  { key: 'dxy',    label: 'DXY',    oanda: 'EUR_USD',     invert: true,  color: '#38bdf8', desc: 'US Dollar Index (EUR/USD inverse)' },
  { key: 'gold',   label: 'Gold',   oanda: 'XAU_USD',     invert: false, color: '#fbbf24', desc: 'Gold (XAU/USD)' },
  { key: 'silver', label: 'Silver', oanda: 'XAG_USD',     invert: false, color: '#94a3b8', desc: 'Silver (XAG/USD)' },
  { key: 'oil',    label: 'Oil',    oanda: 'BCO_USD',      invert: false, color: '#f97316', desc: 'Brent Crude Oil' },
  { key: 'bonds',  label: 'US10Y',  oanda: 'USB10Y_USD',  invert: false, color: '#a78bfa', desc: 'US 10-Year Bond Yield' },
];

// Correlation: which markets affect which pair direction
// 1 = positive correlation, -1 = negative, 0/absent = none
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

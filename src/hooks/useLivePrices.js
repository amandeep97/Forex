import { useState, useEffect, useCallback, useRef } from 'react';

const REFRESH_MS = 15_000;

// ── OANDA ─────────────────────────────────────────────────────────────────────
const OANDA_PRACTICE = 'https://api-fxpractice.oanda.com/v3';
const OANDA_LIVE     = 'https://api-fxtrade.oanda.com/v3';

// Our symbol → OANDA instrument name
export const OANDA_MAP = {
  // Forex
  'EUR/USD':'EUR_USD','GBP/USD':'GBP_USD','USD/JPY':'USD_JPY',
  'USD/CHF':'USD_CHF','AUD/USD':'AUD_USD','USD/CAD':'USD_CAD',
  'NZD/USD':'NZD_USD','EUR/GBP':'EUR_GBP','EUR/JPY':'EUR_JPY',
  'EUR/AUD':'EUR_AUD','EUR/CAD':'EUR_CAD','EUR/CHF':'EUR_CHF',
  'EUR/TRY':'EUR_TRY','GBP/JPY':'GBP_JPY','GBP/CHF':'GBP_CHF',
  'AUD/JPY':'AUD_JPY','CAD/JPY':'CAD_JPY','USD/SGD':'USD_SGD',
  'USD/MXN':'USD_MXN','USD/ZAR':'USD_ZAR','USD/NOK':'USD_NOK',
  'USD/SEK':'USD_SEK','USD/HKD':'USD_HKD',
  // Metals
  'XAU/USD':'XAU_USD','XAG/USD':'XAG_USD',
  'XPT/USD':'XPT_USD','XPD/USD':'XPD_USD','XCU/USD':'XCU_USD',
  // Indices
  'US500':'SPX500_USD','US30':'US30_USD','US100':'NAS100_USD',
  'US2000':'US2000_USD','UK100':'UK100_GBP','GER40':'DE30_EUR',
  'FRA40':'FR40_EUR','ESP35':'ES35_EUR','JPN225':'JP225_USD',
  'AUS200':'AU200_AUD','HKG50':'HK33_HKD',
  // Energy
  'USOIL':'WTICO_USD','UKOIL':'BCO_USD','NATGAS':'NATGAS_USD',
};
const OANDA_REVERSE = Object.fromEntries(Object.entries(OANDA_MAP).map(([k,v])=>[v,k]));

function oandaBase(practice) { return practice ? OANDA_PRACTICE : OANDA_LIVE; }

async function oandaGet(path, apiKey, practice) {
  const res = await fetch(`${oandaBase(practice)}${path}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(()=>'');
    throw new Error(`OANDA ${res.status}: ${text.slice(0,120)}`);
  }
  return res.json();
}

// Auto-discover first account ID using the API key
export async function oandaDiscover(apiKey, practice) {
  const data = await oandaGet('/accounts', apiKey, practice);
  const account = data.accounts?.[0];
  if (!account?.id) throw new Error('No OANDA accounts found for this key');
  return account.id;
}

// Batch-fetch all mapped instrument prices in one request
async function oandaFetchPrices(apiKey, accountId, practice) {
  const instruments = Object.values(OANDA_MAP).join('%2C');
  const data = await oandaGet(
    `/accounts/${accountId}/pricing?instruments=${instruments}`,
    apiKey, practice
  );
  const out = {};
  (data.prices || []).forEach(p => {
    const sym = OANDA_REVERSE[p.instrument];
    if (!sym) return;
    const bid = parseFloat(p.bids?.[0]?.price);
    const ask = parseFloat(p.asks?.[0]?.price);
    if (bid > 0 && ask > 0) out[sym] = (bid + ask) / 2;
  });
  return out;
}

// ── Credential helpers (localStorage) ────────────────────────────────────────
const LS_KEY = 'oanda_creds';
function loadCreds() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; }
  catch { return null; }
}
function saveCreds(c) { localStorage.setItem(LS_KEY, JSON.stringify(c)); }
function clearCreds() { localStorage.removeItem(LS_KEY); }

// ── prices.json (GitHub Actions — updated every 15 min) ───────────────────────
async function fetchPricesJson() {
  try {
    const base = import.meta.env.BASE_URL || '/';
    const res  = await fetch(`${base}prices.json?t=${Date.now()}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const age  = Date.now() - new Date(data.timestamp).getTime();
    if (age > 45 * 60 * 1000) return null; // reject if > 45 min old
    return data;
  } catch { return null; }
}

// ── Forex (open.er-api.com → frankfurter.app fallback) ───────────────────────
async function fetchForexWithFallback() {
  const apis = [fetchFromOpenER, fetchFromFrankfurter];
  for (const api of apis) {
    try {
      const r = await api();
      if (r && Object.keys(r).length > 3) return r;
    } catch { /* try next */ }
  }
  return null;
}

async function fetchFromOpenER() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(6000) });
  const data = await res.json();
  if (!data.rates) throw new Error('no rates');
  const r = data.rates, out = {};
  out['USD/JPY']=r.JPY; out['USD/CHF']=r.CHF; out['USD/CAD']=r.CAD;
  out['USD/SGD']=r.SGD; out['USD/HKD']=r.HKD; out['USD/NOK']=r.NOK;
  out['USD/SEK']=r.SEK; out['USD/MXN']=r.MXN; out['USD/ZAR']=r.ZAR; out['USD/INR']=r.INR;
  if(r.EUR) out['EUR/USD']=parseFloat((1/r.EUR).toFixed(5));
  if(r.GBP) out['GBP/USD']=parseFloat((1/r.GBP).toFixed(5));
  if(r.AUD) out['AUD/USD']=parseFloat((1/r.AUD).toFixed(5));
  if(r.NZD) out['NZD/USD']=parseFloat((1/r.NZD).toFixed(5));
  if(r.EUR&&r.GBP) out['EUR/GBP']=parseFloat((r.GBP/r.EUR).toFixed(5));
  if(r.EUR&&r.JPY) out['EUR/JPY']=parseFloat((r.JPY/r.EUR).toFixed(3));
  if(r.EUR&&r.AUD) out['EUR/AUD']=parseFloat((r.AUD/r.EUR).toFixed(5));
  if(r.EUR&&r.CAD) out['EUR/CAD']=parseFloat((r.CAD/r.EUR).toFixed(5));
  if(r.EUR&&r.CHF) out['EUR/CHF']=parseFloat((r.CHF/r.EUR).toFixed(5));
  if(r.EUR&&r.TRY) out['EUR/TRY']=parseFloat((r.TRY/r.EUR).toFixed(3));
  if(r.GBP&&r.JPY) out['GBP/JPY']=parseFloat((r.JPY/r.GBP).toFixed(3));
  if(r.GBP&&r.CHF) out['GBP/CHF']=parseFloat((r.CHF/r.GBP).toFixed(5));
  if(r.AUD&&r.JPY) out['AUD/JPY']=parseFloat((r.JPY/r.AUD).toFixed(3));
  if(r.CAD&&r.JPY) out['CAD/JPY']=parseFloat((r.JPY/r.CAD).toFixed(3));
  return out;
}

async function fetchFromFrankfurter() {
  const res = await fetch('https://api.frankfurter.app/latest?from=USD', { signal: AbortSignal.timeout(6000) });
  const data = await res.json();
  if (!data.rates) throw new Error('no rates');
  const r = data.rates, out = {};
  out['USD/JPY']=r.JPY; out['USD/CHF']=r.CHF; out['USD/CAD']=r.CAD;
  out['USD/NOK']=r.NOK; out['USD/SEK']=r.SEK; out['USD/MXN']=r.MXN; out['USD/INR']=r.INR;
  if(r.EUR) out['EUR/USD']=parseFloat((1/r.EUR).toFixed(5));
  if(r.GBP) out['GBP/USD']=parseFloat((1/r.GBP).toFixed(5));
  if(r.AUD) out['AUD/USD']=parseFloat((1/r.AUD).toFixed(5));
  if(r.NZD) out['NZD/USD']=parseFloat((1/r.NZD).toFixed(5));
  return out;
}

// ── Metals (CryptoCompare precious + metals.live base) ────────────────────────
async function fetchMetals() {
  const out = {};
  try {
    const res = await fetch(
      'https://min-api.cryptocompare.com/data/pricemulti?fsyms=XAU,XAG,XPT,XPD&tsyms=USD',
      { signal: AbortSignal.timeout(7000) }
    );
    const data = await res.json();
    if(data.XAU?.USD) out['XAU/USD']=parseFloat(data.XAU.USD);
    if(data.XAG?.USD) out['XAG/USD']=parseFloat(data.XAG.USD);
    if(data.XPT?.USD) out['XPT/USD']=parseFloat(data.XPT.USD);
    if(data.XPD?.USD) out['XPD/USD']=parseFloat(data.XPD.USD);
  } catch { /* fall through */ }
  try {
    const res2 = await fetch('https://api.metals.live/v1/latest', { signal: AbortSignal.timeout(6000) });
    const raw  = await res2.json();
    const flat = Array.isArray(raw) ? Object.assign({}, ...raw) : raw;
    if(!out['XAU/USD']&&flat.gold)      out['XAU/USD']=parseFloat(flat.gold);
    if(!out['XAG/USD']&&flat.silver)    out['XAG/USD']=parseFloat(flat.silver);
    if(!out['XPT/USD']&&flat.platinum)  out['XPT/USD']=parseFloat(flat.platinum);
    if(!out['XPD/USD']&&flat.palladium) out['XPD/USD']=parseFloat(flat.palladium);
    if(flat.copper)   out['XCU/USD']=parseFloat(flat.copper);
    if(flat.aluminum) out['XAL/USD']=parseFloat(flat.aluminum);
    if(flat.nickel)   out['XNI/USD']=parseFloat(flat.nickel);
    if(flat.zinc)     out['XZN/USD']=parseFloat(flat.zinc);
  } catch { /* base metals stay as demo */ }
  return out;
}

// ── Indices + Energy (Yahoo Finance v8, per-symbol parallel) ──────────────────
const YF_SYMBOLS = {
  '%5EGSPC':'US500','%5EDJI':'US30','%5ENDX':'US100','%5ERUT':'US2000',
  '%5EFTSE':'UK100','%5EGDAXI':'GER40','%5EFCHI':'FRA40','%5EIBEX':'ESP35',
  '%5EN225':'JPN225','%5EAXJO':'AUS200','%5EHSI':'HKG50','000300.SS':'CHN50',
  'CL%3DF':'USOIL','BZ%3DF':'UKOIL','NG%3DF':'NATGAS',
  'HO%3DF':'HEATOIL','RB%3DF':'RBOB',
};
async function fetchOneYFChart(sym) {
  const res = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
    { signal: AbortSignal.timeout(5000), credentials:'omit' });
  const j = await res.json();
  return j?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
}
async function fetchMarkets() {
  const settled = await Promise.allSettled(
    Object.entries(YF_SYMBOLS).map(async([sym,key])=>({ key, price: await fetchOneYFChart(sym) }))
  );
  const out = {};
  settled.forEach(r=>{ if(r.status==='fulfilled'&&r.value.price!=null) out[r.value.key]=r.value.price; });
  return out;
}

// ── Crypto (CoinGecko) ────────────────────────────────────────────────────────
async function fetchCryptoWithFallback() {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,ripple,solana,binancecoin,cardano,dogecoin,avalanche-2&vs_currencies=usd',
      { signal: AbortSignal.timeout(6000) }
    );
    const d = await res.json();
    return {
      'BTC/USD':d.bitcoin?.usd,'ETH/USD':d.ethereum?.usd,'XRP/USD':d.ripple?.usd,
      'SOL/USD':d.solana?.usd,'BNB/USD':d.binancecoin?.usd,'ADA/USD':d.cardano?.usd,
      'DOGE/USD':d.dogecoin?.usd,'AVAX/USD':d['avalanche-2']?.usd,
    };
  } catch { return null; }
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useLivePrices() {
  const [forexRates,  setForexRates]  = useState({});
  const [cryptoRates, setCryptoRates] = useState({});
  const [metalRates,  setMetalRates]  = useState({});
  const [marketRates, setMarketRates] = useState({});
  const [lastUpdate,  setLastUpdate]  = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);

  // OANDA state
  const [oandaStatus, setOandaStatus] = useState(() => {
    const c = loadCreds();
    return c ? { connected: true, accountId: c.accountId, practice: c.practice, error: null } : { connected: false, accountId: null, practice: true, error: null };
  });
  const credsRef = useRef(loadCreds());

  // Connect: validate key, discover account ID, save, refresh
  const connectOanda = useCallback(async (apiKey, practice) => {
    setOandaStatus(s => ({ ...s, error: null }));
    try {
      const accountId = await oandaDiscover(apiKey, practice);
      const creds = { apiKey, accountId, practice };
      saveCreds(creds);
      credsRef.current = creds;
      setOandaStatus({ connected: true, accountId, practice, error: null });
      return { ok: true, accountId };
    } catch (e) {
      setOandaStatus(s => ({ ...s, error: e.message }));
      return { ok: false, error: e.message };
    }
  }, []);

  const disconnectOanda = useCallback(() => {
    clearCreds();
    credsRef.current = null;
    setOandaStatus({ connected: false, accountId: null, practice: true, error: null });
  }, []);

  const refresh = useCallback(async () => {
    let anySuccess = false;

    // Forex + Crypto — always fetch direct (fast, CORS-friendly)
    const fx = await fetchForexWithFallback();
    if (fx) { setForexRates(fx); anySuccess = true; }

    const cr = await fetchCryptoWithFallback();
    if (cr) { setCryptoRates(cr); anySuccess = true; }

    // ── OANDA: primary source if connected ──
    const creds = credsRef.current;
    if (creds?.apiKey && creds?.accountId) {
      try {
        const prices = await oandaFetchPrices(creds.apiKey, creds.accountId, creds.practice);
        if (Object.keys(prices).length > 0) {
          // Split into forex / metals / markets by symbol type
          const newFx={}, newMt={}, newMkt={};
          Object.entries(prices).forEach(([sym, price]) => {
            if (['XAU','XAG','XPT','XPD','XCU','XAL','XNI','XZN'].some(m=>sym.startsWith(m))) newMt[sym]=price;
            else if (sym.includes('/')) newFx[sym]=price;
            else newMkt[sym]=price;
          });
          if (Object.keys(newFx).length)  setForexRates(prev=>({...prev,...newFx}));
          if (Object.keys(newMt).length)  setMetalRates(prev=>({...prev,...newMt}));
          if (Object.keys(newMkt).length) setMarketRates(prev=>({...prev,...newMkt}));
          anySuccess = true;
        }
      } catch (e) {
        console.warn('OANDA refresh failed:', e.message);
        // If OANDA fails, fall through to other sources below
      }
    }

    // ── prices.json (GitHub Actions cache) — for metals + markets ──
    const cached = await fetchPricesJson();
    if (cached) {
      if (cached.metals  && Object.keys(cached.metals).length  > 0) { setMetalRates(cached.metals);  anySuccess = true; }
      if (cached.markets && Object.keys(cached.markets).length > 0) { setMarketRates(cached.markets); anySuccess = true; }
    } else if (!creds) {
      // Last-resort browser-side fetches
      try { const mt=await fetchMetals();  if(mt&&Object.keys(mt).length>0){setMetalRates(mt);anySuccess=true;} } catch{}
      try { const mk=await fetchMarkets(); if(mk&&Object.keys(mk).length>0){setMarketRates(mk);anySuccess=true;} } catch{}
    }

    if (anySuccess) { setLastUpdate(new Date()); setError(null); }
    else setError('Live feed unavailable — showing demo prices');
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return {
    forexRates, cryptoRates, metalRates, marketRates,
    lastUpdate, loading, error, refresh,
    oandaStatus, connectOanda, disconnectOanda,
  };
}

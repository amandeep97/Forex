import { useState, useEffect, useCallback, useRef } from 'react';

const REFRESH_MS = 15_000;

// ── Forex ─────────────────────────────────────────────────────────────────────
async function fetchForexWithFallback() {
  const apis = [() => fetchFromOpenER(), () => fetchFromFrankfurter()];
  for (const api of apis) {
    try {
      const result = await api();
      if (result && Object.keys(result).length > 3) return result;
    } catch (_) { /* try next */ }
  }
  return null;
}

async function fetchFromOpenER() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(6000) });
  const data = await res.json();
  if (!data.rates) throw new Error('no rates');
  const r = data.rates;
  const out = {};
  out['USD/JPY'] = r.JPY; out['USD/CHF'] = r.CHF; out['USD/CAD'] = r.CAD;
  out['USD/SGD'] = r.SGD; out['USD/HKD'] = r.HKD; out['USD/NOK'] = r.NOK;
  out['USD/SEK'] = r.SEK; out['USD/MXN'] = r.MXN; out['USD/ZAR'] = r.ZAR; out['USD/INR'] = r.INR;
  if (r.EUR) out['EUR/USD'] = parseFloat((1 / r.EUR).toFixed(5));
  if (r.GBP) out['GBP/USD'] = parseFloat((1 / r.GBP).toFixed(5));
  if (r.AUD) out['AUD/USD'] = parseFloat((1 / r.AUD).toFixed(5));
  if (r.NZD) out['NZD/USD'] = parseFloat((1 / r.NZD).toFixed(5));
  if (r.EUR && r.GBP) out['EUR/GBP'] = parseFloat((r.GBP / r.EUR).toFixed(5));
  if (r.EUR && r.JPY) out['EUR/JPY'] = parseFloat((r.JPY / r.EUR).toFixed(3));
  if (r.EUR && r.AUD) out['EUR/AUD'] = parseFloat((r.AUD / r.EUR).toFixed(5));
  if (r.EUR && r.CAD) out['EUR/CAD'] = parseFloat((r.CAD / r.EUR).toFixed(5));
  if (r.EUR && r.CHF) out['EUR/CHF'] = parseFloat((r.CHF / r.EUR).toFixed(5));
  if (r.EUR && r.TRY) out['EUR/TRY'] = parseFloat((r.TRY / r.EUR).toFixed(3));
  if (r.GBP && r.JPY) out['GBP/JPY'] = parseFloat((r.JPY / r.GBP).toFixed(3));
  if (r.GBP && r.CHF) out['GBP/CHF'] = parseFloat((r.CHF / r.GBP).toFixed(5));
  if (r.AUD && r.JPY) out['AUD/JPY'] = parseFloat((r.JPY / r.AUD).toFixed(3));
  if (r.CAD && r.JPY) out['CAD/JPY'] = parseFloat((r.JPY / r.CAD).toFixed(3));
  return out;
}

async function fetchFromFrankfurter() {
  const res = await fetch('https://api.frankfurter.app/latest?from=USD', { signal: AbortSignal.timeout(6000) });
  const data = await res.json();
  if (!data.rates) throw new Error('no rates');
  const r = data.rates;
  const out = {};
  out['USD/JPY'] = r.JPY; out['USD/CHF'] = r.CHF; out['USD/CAD'] = r.CAD;
  out['USD/NOK'] = r.NOK; out['USD/SEK'] = r.SEK; out['USD/MXN'] = r.MXN; out['USD/INR'] = r.INR;
  if (r.EUR) out['EUR/USD'] = parseFloat((1 / r.EUR).toFixed(5));
  if (r.GBP) out['GBP/USD'] = parseFloat((1 / r.GBP).toFixed(5));
  if (r.AUD) out['AUD/USD'] = parseFloat((1 / r.AUD).toFixed(5));
  if (r.NZD) out['NZD/USD'] = parseFloat((1 / r.NZD).toFixed(5));
  return out;
}

// ── Metals via CryptoCompare (precious) + metals.live (base) ─────────────────
// CryptoCompare treats XAU/XAG/XPT/XPD as commodities — CORS-friendly & free
async function fetchMetals() {
  const out = {};

  // Primary: CryptoCompare for precious metals (confirmed CORS-friendly)
  try {
    const res = await fetch(
      'https://min-api.cryptocompare.com/data/pricemulti?fsyms=XAU,XAG,XPT,XPD&tsyms=USD',
      { signal: AbortSignal.timeout(7000) }
    );
    const data = await res.json();
    if (data.XAU?.USD) out['XAU/USD'] = parseFloat(data.XAU.USD);
    if (data.XAG?.USD) out['XAG/USD'] = parseFloat(data.XAG.USD);
    if (data.XPT?.USD) out['XPT/USD'] = parseFloat(data.XPT.USD);
    if (data.XPD?.USD) out['XPD/USD'] = parseFloat(data.XPD.USD);
  } catch (_) { /* fall through */ }

  // Supplement: api.metals.live for base metals (copper, aluminum, nickel, zinc)
  try {
    const res2 = await fetch('https://api.metals.live/v1/latest', { signal: AbortSignal.timeout(6000) });
    const raw  = await res2.json();
    const flat = Array.isArray(raw) ? Object.assign({}, ...raw) : raw;
    if (!out['XAU/USD'] && flat.gold)      out['XAU/USD'] = parseFloat(flat.gold);
    if (!out['XAG/USD'] && flat.silver)    out['XAG/USD'] = parseFloat(flat.silver);
    if (!out['XPT/USD'] && flat.platinum)  out['XPT/USD'] = parseFloat(flat.platinum);
    if (!out['XPD/USD'] && flat.palladium) out['XPD/USD'] = parseFloat(flat.palladium);
    if (flat.copper)    out['XCU/USD'] = parseFloat(flat.copper);
    if (flat.aluminum)  out['XAL/USD'] = parseFloat(flat.aluminum);
    if (flat.nickel)    out['XNI/USD'] = parseFloat(flat.nickel);
    if (flat.zinc)      out['XZN/USD'] = parseFloat(flat.zinc);
  } catch (_) { /* base metals stay as demo */ }

  return out;
}

// ── Indices + Energy via Yahoo Finance v8 chart (per-symbol, parallel) ────────
// Using v8/finance/chart per-symbol is more CORS-permissive than v7 batch quote
const YF_SYMBOLS = {
  '%5EGSPC':    'US500',   '%5EDJI':    'US30',    '%5ENDX':  'US100',
  '%5ERUT':     'US2000',  '%5EFTSE':   'UK100',   '%5EGDAXI':'GER40',
  '%5EFCHI':    'FRA40',   '%5EIBEX':   'ESP35',   '%5EN225': 'JPN225',
  '%5EAXJO':    'AUS200',  '%5EHSI':    'HKG50',   '000300.SS':'CHN50',
  'CL%3DF':     'USOIL',   'BZ%3DF':    'UKOIL',   'NG%3DF':  'NATGAS',
  'HO%3DF':     'HEATOIL', 'RB%3DF':    'RBOB',
};

async function fetchOneYFChart(encodedSym) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodedSym}?interval=1d&range=1d`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), credentials: 'omit' });
  const json = await res.json();
  return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
}

async function fetchMarkets() {
  const entries = Object.entries(YF_SYMBOLS);
  const settled = await Promise.allSettled(
    entries.map(async ([sym, key]) => {
      const price = await fetchOneYFChart(sym);
      return { key, price };
    })
  );
  const out = {};
  settled.forEach(r => {
    if (r.status === 'fulfilled' && r.value.price != null) {
      out[r.value.key] = r.value.price;
    }
  });
  return out;
}

// ── Crypto ────────────────────────────────────────────────────────────────────
async function fetchCryptoWithFallback() {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,ripple,solana,binancecoin,cardano,dogecoin,avalanche-2&vs_currencies=usd',
      { signal: AbortSignal.timeout(6000) }
    );
    const data = await res.json();
    return {
      'BTC/USD':  data.bitcoin?.usd,
      'ETH/USD':  data.ethereum?.usd,
      'XRP/USD':  data.ripple?.usd,
      'SOL/USD':  data.solana?.usd,
      'BNB/USD':  data.binancecoin?.usd,
      'ADA/USD':  data.cardano?.usd,
      'DOGE/USD': data.dogecoin?.usd,
      'AVAX/USD': data['avalanche-2']?.usd,
    };
  } catch (_) { return null; }
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useLivePrices() {
  const [forexRates,  setForexRates]  = useState({});
  const [cryptoRates, setCryptoRates] = useState({});
  const [metalRates,  setMetalRates]  = useState({});
  const [marketRates, setMarketRates] = useState({}); // indices + energy
  const [lastUpdate,  setLastUpdate]  = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const fxSource = useRef('—');

  const refresh = useCallback(async () => {
    let anySuccess = false;

    const fx = await fetchForexWithFallback();
    if (fx) { setForexRates(fx); fxSource.current = 'open.er-api.com'; anySuccess = true; }

    const cr = await fetchCryptoWithFallback();
    if (cr) { setCryptoRates(cr); anySuccess = true; }

    // Metals — CryptoCompare primary, metals.live supplement
    try {
      const mt = await fetchMetals();
      if (mt && Object.keys(mt).length > 0) { setMetalRates(mt); anySuccess = true; }
    } catch (_) { /* keep demo prices */ }

    // Indices + Energy — Yahoo Finance v8 chart, per-symbol parallel
    try {
      const mkt = await fetchMarkets();
      if (mkt && Object.keys(mkt).length > 0) { setMarketRates(mkt); anySuccess = true; }
    } catch (_) { /* keep demo prices */ }

    if (anySuccess) { setLastUpdate(new Date()); setError(null); }
    else setError('Live feed unavailable — showing demo prices');
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { forexRates, cryptoRates, metalRates, marketRates, lastUpdate, loading, error, refresh };
}

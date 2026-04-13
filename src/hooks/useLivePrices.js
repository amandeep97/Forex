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

// ── Metals (metals.live — free, CORS-enabled) ─────────────────────────────────
async function fetchMetals() {
  const res = await fetch('https://api.metals.live/v1/latest', { signal: AbortSignal.timeout(8000) });
  const data = await res.json();
  // API returns array of single-key objects OR a flat object
  const flat = Array.isArray(data) ? Object.assign({}, ...data) : data;
  const out = {};
  if (flat.gold      != null) out['XAU/USD'] = parseFloat(flat.gold);
  if (flat.silver    != null) out['XAG/USD'] = parseFloat(flat.silver);
  if (flat.platinum  != null) out['XPT/USD'] = parseFloat(flat.platinum);
  if (flat.palladium != null) out['XPD/USD'] = parseFloat(flat.palladium);
  if (flat.copper    != null) out['XCU/USD'] = parseFloat(flat.copper);
  if (flat.aluminum  != null) out['XAL/USD'] = parseFloat(flat.aluminum);
  if (flat.nickel    != null) out['XNI/USD'] = parseFloat(flat.nickel);
  if (flat.zinc      != null) out['XZN/USD'] = parseFloat(flat.zinc);
  return out;
}

// ── Indices + Energy (Yahoo Finance v7 — free, CORS-omit) ────────────────────
const YF_MAP = {
  '^GSPC':    'US500',  '^DJI':    'US30',   '^NDX':    'US100',  '^RUT':   'US2000',
  '^FTSE':    'UK100',  '^GDAXI':  'GER40',  '^FCHI':   'FRA40',  '^IBEX':  'ESP35',
  '^N225':    'JPN225', '^AXJO':   'AUS200', '^HSI':    'HKG50',  '000300.SS': 'CHN50',
  'CL=F':     'USOIL',  'BZ=F':    'UKOIL',  'NG=F':    'NATGAS',
  'HO=F':     'HEATOIL','RB=F':    'RBOB',   'MTF=F':   'GASOIL', 'MTW=F':  'COALUSD',
};

async function fetchYahooQuotes() {
  const params = new URLSearchParams({ symbols: Object.keys(YF_MAP).join(',') });
  const res = await fetch(
    `https://query1.finance.yahoo.com/v7/finance/quote?${params}`,
    { signal: AbortSignal.timeout(8000), credentials: 'omit' }
  );
  const json = await res.json();
  const results = json?.quoteResponse?.result || [];
  const out = {};
  results.forEach(q => {
    const key = YF_MAP[q.symbol];
    if (key && q.regularMarketPrice != null) out[key] = q.regularMarketPrice;
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

    // Metals — separate try so failure doesn't block others
    try {
      const mt = await fetchMetals();
      if (mt && Object.keys(mt).length > 0) { setMetalRates(mt); anySuccess = true; }
    } catch (_) { /* metals API unavailable — keep demo prices */ }

    // Indices + Energy — Yahoo Finance (may have CORS on some networks)
    try {
      const mkt = await fetchYahooQuotes();
      if (mkt && Object.keys(mkt).length > 0) { setMarketRates(mkt); anySuccess = true; }
    } catch (_) { /* Yahoo Finance blocked — keep demo prices */ }

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

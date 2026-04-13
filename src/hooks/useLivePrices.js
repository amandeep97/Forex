import { useState, useEffect, useCallback, useRef } from 'react';

const REFRESH_MS = 15_000;

// Try multiple forex APIs in order until one works
async function fetchForexWithFallback() {
  // Primary: open.er-api.com (CORS-friendly, free)
  // Fallback: frankfurter.app
  const apis = [
    () => fetchFromOpenER(),
    () => fetchFromFrankfurter(),
  ];
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
  out['USD/JPY'] = r.JPY;
  out['USD/CHF'] = r.CHF;
  out['USD/CAD'] = r.CAD;
  out['USD/SGD'] = r.SGD;
  out['USD/HKD'] = r.HKD;
  out['USD/NOK'] = r.NOK;
  out['USD/SEK'] = r.SEK;
  out['USD/MXN'] = r.MXN;
  out['USD/ZAR'] = r.ZAR;
  out['USD/INR'] = r.INR;
  if (r.EUR) out['EUR/USD'] = parseFloat((1 / r.EUR).toFixed(5));
  if (r.GBP) out['GBP/USD'] = parseFloat((1 / r.GBP).toFixed(5));
  if (r.AUD) out['AUD/USD'] = parseFloat((1 / r.AUD).toFixed(5));
  if (r.NZD) out['NZD/USD'] = parseFloat((1 / r.NZD).toFixed(5));
  // Cross rates
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
  out['USD/JPY'] = r.JPY;
  out['USD/CHF'] = r.CHF;
  out['USD/CAD'] = r.CAD;
  out['USD/NOK'] = r.NOK;
  out['USD/SEK'] = r.SEK;
  out['USD/MXN'] = r.MXN;
  out['USD/INR'] = r.INR;
  if (r.EUR) out['EUR/USD'] = parseFloat((1 / r.EUR).toFixed(5));
  if (r.GBP) out['GBP/USD'] = parseFloat((1 / r.GBP).toFixed(5));
  if (r.AUD) out['AUD/USD'] = parseFloat((1 / r.AUD).toFixed(5));
  if (r.NZD) out['NZD/USD'] = parseFloat((1 / r.NZD).toFixed(5));
  return out;
}

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
  } catch (_) {
    return null;
  }
}

export function useLivePrices() {
  const [forexRates,  setForexRates]  = useState({});
  const [cryptoRates, setCryptoRates] = useState({});
  const [lastUpdate,  setLastUpdate]  = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const fxSource = useRef('—');

  const refresh = useCallback(async () => {
    let anySuccess = false;

    const fx = await fetchForexWithFallback();
    if (fx) {
      setForexRates(fx);
      fxSource.current = 'open.er-api.com';
      anySuccess = true;
    }

    const cr = await fetchCryptoWithFallback();
    if (cr) {
      setCryptoRates(cr);
      anySuccess = true;
    }

    if (anySuccess) {
      setLastUpdate(new Date());
      setError(null);
    } else {
      setError('Live feed unavailable — showing demo prices');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { forexRates, cryptoRates, lastUpdate, loading, error, refresh };
}

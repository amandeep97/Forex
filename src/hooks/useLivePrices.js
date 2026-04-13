import { useState, useEffect, useCallback } from 'react';

// ── Live price hook ───────────────────────────────────────────────────────────
// Forex  → Frankfurter API (free, no key, ECB/market rates)
// Crypto → CoinGecko API  (free, no key)
// Metals / Indices / Energy → simulated until broker connected

const REFRESH_MS = 10_000; // refresh every 10 seconds

export function useLivePrices() {
  const [forexRates, setForexRates]   = useState({});
  const [cryptoRates, setCryptoRates] = useState({});
  const [lastUpdate, setLastUpdate]   = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);

  const fetchForex = useCallback(async () => {
    // Fetch USD base and EUR base in parallel
    const [usdRes, eurRes, gbpRes] = await Promise.all([
      fetch('https://api.frankfurter.app/latest?from=USD'),
      fetch('https://api.frankfurter.app/latest?from=EUR'),
      fetch('https://api.frankfurter.app/latest?from=GBP'),
    ]);
    const usd = await usdRes.json();
    const eur = await eurRes.json();
    const gbp = await gbpRes.json();

    const r = {};
    if (usd.rates) {
      // Pairs where USD is base
      r['USD/JPY'] = usd.rates.JPY;
      r['USD/CHF'] = usd.rates.CHF;
      r['USD/CAD'] = usd.rates.CAD;
      r['USD/SGD'] = usd.rates.SGD;
      r['USD/HKD'] = usd.rates.HKD;
      r['USD/NOK'] = usd.rates.NOK;
      r['USD/SEK'] = usd.rates.SEK;
      r['USD/MXN'] = usd.rates.MXN;
      r['USD/ZAR'] = usd.rates.ZAR;
      r['USD/INR'] = usd.rates.INR;
      // Pairs where USD is quote
      if (usd.rates.EUR) r['EUR/USD'] = parseFloat((1 / usd.rates.EUR).toFixed(5));
      if (usd.rates.GBP) r['GBP/USD'] = parseFloat((1 / usd.rates.GBP).toFixed(5));
      if (usd.rates.AUD) r['AUD/USD'] = parseFloat((1 / usd.rates.AUD).toFixed(5));
      if (usd.rates.NZD) r['NZD/USD'] = parseFloat((1 / usd.rates.NZD).toFixed(5));
    }
    if (eur.rates) {
      r['EUR/GBP'] = eur.rates.GBP;
      r['EUR/JPY'] = eur.rates.JPY;
      r['EUR/AUD'] = eur.rates.AUD;
      r['EUR/CAD'] = eur.rates.CAD;
      r['EUR/CHF'] = eur.rates.CHF;
      r['EUR/TRY'] = eur.rates.TRY;
    }
    if (gbp.rates) {
      r['GBP/JPY'] = gbp.rates.JPY;
      r['GBP/CHF'] = gbp.rates.CHF;
      r['GBP/AUD'] = gbp.rates.AUD;
    }
    if (r['AUD/USD'] && usd.rates?.JPY) {
      r['AUD/JPY'] = parseFloat((r['AUD/USD'] * usd.rates.JPY).toFixed(3));
    }
    if (r['USD/CAD'] && usd.rates?.JPY) {
      r['CAD/JPY'] = parseFloat((usd.rates.JPY / r['USD/CAD']).toFixed(3));
    }
    return r;
  }, []);

  const fetchCrypto = useCallback(async () => {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price' +
      '?ids=bitcoin,ethereum,ripple,solana,binancecoin,cardano,dogecoin,avalanche-2' +
      '&vs_currencies=usd&include_24hr_change=true'
    );
    const data = await res.json();
    return {
      'BTC/USD':  data.bitcoin?.usd,
      'ETH/USD':  data.ethereum?.usd,
      'XRP/USD':  data.ripple?.usd,
      'SOL/USD':  data.solana?.usd,
      'BNB/USD':  data['binancecoin']?.usd,
      'ADA/USD':  data.cardano?.usd,
      'DOGE/USD': data.dogecoin?.usd,
      'AVAX/USD': data['avalanche-2']?.usd,
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [fx, cr] = await Promise.all([fetchForex(), fetchCrypto()]);
      setForexRates(fx);
      setCryptoRates(cr);
      setLastUpdate(new Date());
      setError(null);
    } catch (e) {
      setError('Live feed unavailable — showing last known prices');
    } finally {
      setLoading(false);
    }
  }, [fetchForex, fetchCrypto]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { forexRates, cryptoRates, lastUpdate, loading, error, refresh };
}

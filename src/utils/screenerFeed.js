// Real candle fetch for the Screener — OANDA (FX/metals/indices/energy) + Binance (crypto).
import { OANDA_MAP } from '../hooks/useLivePrices';

const OANDA_GRAN  = { '1m':'M1','5m':'M5','15m':'M15','30m':'M30','1h':'H1','2h':'H2','4h':'H4','8h':'H8','12h':'H12','1d':'D','1w':'W' };
const BINANCE_ITV = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','2h':'2h','4h':'4h','8h':'8h','12h':'12h','1d':'1d','3d':'3d','1w':'1w' };

function cryptoSymbol(sym) { return `${sym.split('/')[0]}USDT`; }   // BTC/USD → BTCUSDT

function oandaCreds() {
  try { const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null'); if (c?.apiKey) return c; } catch {}
  const k = localStorage.getItem('oanda_key');
  return k ? { apiKey: k, practice: localStorage.getItem('oanda_env') !== 'live' } : null;
}

// Returns candle array [{t,o,h,l,c,v}] or null if unavailable (unmapped / no key / error).
export async function fetchScreenerCandles(inst, tf, count = 250) {
  try {
    if (inst.assetType === 'Crypto') {
      const itv = BINANCE_ITV[tf] || '4h';
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${cryptoSymbol(inst.symbol)}&interval=${itv}&limit=${count}`,
        { signal: AbortSignal.timeout(9000) });
      if (!r.ok) return null;
      const d = await r.json();
      return d.map(k => ({ t: k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
    }
    const oid = OANDA_MAP[inst.symbol];
    const gran = OANDA_GRAN[tf];
    if (!oid || !gran) return null;                 // instrument OANDA doesn't offer, or TF w/o OANDA granularity (3d)
    const creds = oandaCreds();
    if (!creds?.apiKey) return null;
    const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
    const r = await fetch(`${base}/instruments/${oid}/candles?granularity=${gran}&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.candles || []).filter(c => c.complete)
      .map(c => ({ t: new Date(c.time).getTime(), o:+c.mid.o, h:+c.mid.h, l:+c.mid.l, c:+c.mid.c, v: c.volume || 1 }));
  } catch { return null; }
}

// Fetch many instruments with bounded concurrency. Returns { [inst.id]: candles }.
export async function fetchAllScreenerCandles(instruments, tf, { concurrency = 8, count = 250 } = {}) {
  const out = {};
  let idx = 0;
  async function worker() {
    while (idx < instruments.length) {
      const inst = instruments[idx++];
      const candles = await fetchScreenerCandles(inst, tf, count);
      if (candles && candles.length) out[inst.id] = candles;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, instruments.length) }, worker));
  return out;
}

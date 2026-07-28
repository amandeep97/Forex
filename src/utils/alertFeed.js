// Shared instrument feed for the Alerts engine — OANDA for FX/metals/indices/
// energy, Binance for crypto.
import { INSTRUMENTS } from '../data/instruments';

// Derived from the canonical registry rather than kept as a separate list.
// Alerts previously knew 29 instruments while the backtester knew 48, so an
// instrument could be chartable and backtestable yet absent from the alert
// dropdown. Anything the app can price can now be alerted on.
export const ALERT_INSTRUMENTS = INSTRUMENTS
  .filter(i => i.can.price)
  .map(i => ({ sym:i.sym, oanda:i.oanda || undefined, binance:i.binance || undefined, pip:i.pip, dec:i.dec }));

export function instBySym(sym) { return ALERT_INSTRUMENTS.find(i => i.sym === sym); }

const BINANCE_TF = { M1:'1m', M3:'3m', M5:'5m', M15:'15m', M30:'30m', H1:'1h', H4:'4h', D:'1d' };

function oandaCreds() {
  try { const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null'); if (c?.apiKey) { const _e = localStorage.getItem('oanda_env'); return _e !== null ? { ...c, practice: _e !== 'live' } : c; } } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}
function oandaBase(c) { return c.practice === false || c.env === 'live'
  ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3'; }

// Latest price (may be from the still-forming candle)
export async function fetchPrice(inst) {
  try {
    if (inst.binance) {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${inst.binance}`, { signal: AbortSignal.timeout(7000) });
      if (!r.ok) return null;
      return parseFloat((await r.json()).price) || null;
    }
    const c = oandaCreds();
    if (!c?.apiKey) return null;
    const r = await fetch(`${oandaBase(c)}/instruments/${inst.oanda}/candles?granularity=M1&count=1&price=M`,
      { headers:{ Authorization:`Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(7000) });
    if (!r.ok) return null;
    const d = await r.json();
    const cd = d.candles?.[d.candles.length - 1];
    return cd ? parseFloat(cd.mid.c) : null;
  } catch { return null; }
}

// Series of the most recent COMPLETED candles [{o,h,l,c,t}] for a timeframe
export async function fetchRecentCandles(inst, tf, count = 12) {
  try {
    if (inst.binance) {
      const itv = BINANCE_TF[tf] || '1h';
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${inst.binance}&interval=${itv}&limit=${count + 1}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const d = await r.json();
      return d.slice(0, -1).map(k => ({ o:+k[1], h:+k[2], l:+k[3], c:+k[4], t:k[0] })); // drop forming candle
    }
    const c = oandaCreds();
    if (!c?.apiKey) return null;
    const r = await fetch(`${oandaBase(c)}/instruments/${inst.oanda}/candles?granularity=${tf}&count=${count + 1}&price=M`,
      { headers:{ Authorization:`Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.candles || []).filter(x => x.complete).map(x => ({ o:+x.mid.o, h:+x.mid.h, l:+x.mid.l, c:+x.mid.c, t:new Date(x.time).getTime() }));
  } catch { return null; }
}

// Last COMPLETED candle {o,h,l,c,t} for a timeframe
export async function fetchLastClosed(inst, tf) {
  try {
    if (inst.binance) {
      const itv = BINANCE_TF[tf] || '1h';
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${inst.binance}&interval=${itv}&limit=2`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const d = await r.json();
      const k = d[0]; // d[1] is the still-forming candle
      return k ? { o:+k[1], h:+k[2], l:+k[3], c:+k[4], t:k[0] } : null;
    }
    const c = oandaCreds();
    if (!c?.apiKey) return null;
    const r = await fetch(`${oandaBase(c)}/instruments/${inst.oanda}/candles?granularity=${tf}&count=2&price=M`,
      { headers:{ Authorization:`Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    const done = (d.candles || []).filter(x => x.complete);
    const cd = done[done.length - 1];
    return cd ? { o:+cd.mid.o, h:+cd.mid.h, l:+cd.mid.l, c:+cd.mid.c, t:new Date(cd.time).getTime() } : null;
  } catch { return null; }
}

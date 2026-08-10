// src/utils/binanceKlines.js
// Klines from either Binance venue, and a way to find out what actually exists.
//
// Binance runs two separate markets. Spot (api.binance.com) carries BTCUSDT
// and the rest of the crypto list. Futures (fapi.binance.com) carries those
// too, plus the TradFi perpetuals — stocks, sector ETFs, WTI, Brent, gas.
//
// A futures-only symbol requested from the spot host does not error usefully:
// it returns a 400, the caller's catch swallows it, and the app falls through
// to simulated candles. Backtesting invented data is the worst failure this
// app has available, so the venue is chosen from the registry entry rather
// than guessed from the symbol.
//
// The two APIs return the same array-of-arrays kline shape with the same
// query parameters, so only the host and path differ.
const SPOT    = 'https://api.binance.com/api/v3';
const FUTURES = 'https://fapi.binance.com/fapi/v1';

// A futures kline page is capped at 1500, spot at 1000. Using the smaller for
// both costs one extra request per 1500 bars and removes a way to get this
// wrong.
const PAGE = 1000;

export function venueFor(inst) {
  if (!inst) return null;
  if (inst.binance) return { host: SPOT,    symbol: inst.binance, venue: 'spot' };
  if (inst.bfut)    return { host: FUTURES, symbol: inst.bfut,    venue: 'futures' };
  return null;
}

const toCandle = k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
const dedupeSort = a => [...new Map(a.map(c => [c.t, c])).values()].sort((x, y) => x.t - y.t);

// Walks backwards from the most recent bar. `endTime` is exclusive of the page
// already collected, so pages cannot overlap into duplicates.
export async function fetchBinanceKlines(inst, interval, total, { signal } = {}) {
  const v = venueFor(inst);
  if (!v) throw new Error(`${inst?.sym || 'instrument'} has no Binance symbol`);

  const all = [];
  let endTime = null, guard = 0;
  while (all.length < total && guard++ < 60) {
    const need = Math.min(PAGE, total - all.length);
    const url = `${v.host}/klines?symbol=${v.symbol}&interval=${interval}&limit=${need}`
      + (endTime ? `&endTime=${endTime}` : '');
    const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(20000) });
    if (!res.ok) {
      // A 400 on the first page usually means the symbol is not listed on this
      // venue, which is worth saying out loud rather than returning an empty
      // array that reads as "no history".
      if (!all.length) throw new Error(`${v.symbol} not available on Binance ${v.venue} (HTTP ${res.status})`);
      break;
    }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    for (const k of data) all.push(toCandle(k));
    endTime = data[0][0] - 1;
    if (data.length < need) break;          // reached the start of listed history
  }
  return dedupeSort(all);
}

// What is actually there.
//
// This exists because the answer cannot be assumed. These perpetuals are
// recent listings with wildly different start dates, and a symbol with six
// weeks of history looks identical to one with six years until someone asks.
// Reporting it is the difference between the search refusing a symbol for a
// stated reason and a user wondering why nothing works.
export async function probeInstrument(inst, interval = '1d') {
  const v = venueFor(inst);
  if (!v) return { sym: inst.sym, ok: false, reason: 'no Binance symbol' };
  try {
    const cs = await fetchBinanceKlines(inst, interval, 2000);
    if (!cs.length) return { sym: inst.sym, ok: false, venue: v.venue, reason: 'no candles returned' };
    const days = (cs[cs.length - 1].t - cs[0].t) / 86400e3;
    // Median rather than mean: one listing-day volume spike would otherwise
    // make a thin symbol look deep.
    const vols = cs.map(c => c.v).sort((a, b) => a - b);
    return {
      sym: inst.sym, ok: true, venue: v.venue, symbol: v.symbol,
      bars: cs.length,
      days: Math.round(days),
      from: new Date(cs[0].t).toISOString().slice(0, 10),
      medianVol: Math.round(vols[Math.floor(vols.length / 2)]),
      // The deep search refuses under 180 days; the preset search wants years.
      usable: days >= 180,
    };
  } catch (e) {
    return { sym: inst.sym, ok: false, venue: v.venue, reason: e.message };
  }
}

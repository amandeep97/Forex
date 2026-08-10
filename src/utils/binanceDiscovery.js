// src/utils/binanceDiscovery.js
// Ask Binance what it lists, instead of hardcoding a guess.
//
// The TradFi perpetuals were added from a screenshot of one screen. That is a
// bad way to build an instrument list: it misses everything below the fold, it
// goes stale as Binance lists more, and it cannot tell a symbol with six years
// of history from one listed last month.
//
// So the app asks. exchangeInfo gives every listed contract with its real tick
// size and price precision — which means pip and decimals come from the
// exchange rather than from someone typing plausible numbers — and the 24-hour
// ticker gives turnover, which is the number that decides whether a backtest
// on it will survive its own costs.
//
// Nothing is added automatically. Discovery produces candidates; the user
// picks. An instrument list that grows by itself is a list nobody can reason
// about.
import { INSTRUMENTS } from '../data/instruments';

const FAPI = 'https://fapi.binance.com/fapi/v1';
export const CUSTOM_KEY = 'binance_custom_instruments_v1';

const j = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Binance ${r.status} on ${url.split('/').pop().split('?')[0]}`);
  return r.json();
};

// Tick size is the smallest price increment the exchange accepts, which is the
// honest definition of a pip for an instrument nobody has hand-tuned.
function pipFrom(sym) {
  const f = (sym.filters || []).find(x => x.filterType === 'PRICE_FILTER');
  const tick = f ? parseFloat(f.tickSize) : null;
  return tick && tick > 0 ? tick : Math.pow(10, -(sym.pricePrecision ?? 2));
}

// Binance tags equity and commodity contracts differently from coins, but the
// exact field has changed before. Rather than depend on one of them, treat
// anything whose underlying is not a coin as TradFi and let the caller see the
// raw tags — a misfiled instrument is then visible instead of silently absent.
function classOf(sym) {
  const t = String(sym.underlyingType || '').toUpperCase();
  const sub = (sym.underlyingSubType || []).map(s => String(s).toUpperCase());
  if (sub.some(s => /STOCK|EQUITY|SHARE/.test(s))) return 'tradfi';
  if (sub.some(s => /ETF|INDEX/.test(s)))          return 'tradfi';
  if (sub.some(s => /COMMODIT|ENERGY|METAL/.test(s))) return 'tradfi';
  if (t && t !== 'COIN')                            return 'tradfi';
  return 'crypto';
}

export async function discoverBinancePerps({ includeCrypto = false } = {}) {
  const [info, tickers] = await Promise.all([
    j(`${FAPI}/exchangeInfo`),
    j(`${FAPI}/ticker/24hr`),
  ]);
  const volBy = new Map((tickers || []).map(t => [t.symbol, parseFloat(t.quoteVolume) || 0]));

  // Everything already carried, on either venue, so discovery never offers a
  // duplicate of something the app has.
  const have = new Set(INSTRUMENTS.flatMap(i => [i.binance, i.bfut].filter(Boolean)));

  const out = [];
  for (const s of info.symbols || []) {
    if (s.contractType !== 'PERPETUAL') continue;
    if (s.status !== 'TRADING') continue;
    if (s.quoteAsset !== 'USDT') continue;
    if (have.has(s.symbol)) continue;

    const cls = classOf(s);
    if (cls === 'crypto' && !includeCrypto) continue;

    out.push({
      bfut: s.symbol,
      cls,
      name: s.baseAsset,
      base: s.baseAsset,
      pip: pipFrom(s),
      dec: s.pricePrecision ?? 2,
      quoteVolume: volBy.get(s.symbol) ?? 0,
      // Kept so a wrongly-classified instrument can be seen rather than
      // guessed at.
      tags: [s.underlyingType, ...(s.underlyingSubType || [])].filter(Boolean),
    });
  }
  // Turnover order: the top of this list is where a backtest has a chance of
  // surviving its own spread.
  return out.sort((a, b) => b.quoteVolume - a.quoteVolume);
}

// ── Chosen instruments ───────────────────────────────────────────────────────
// Held in localStorage rather than the registry file, because the registry is
// a static module imported at load time by two dozen screens. Merging happens
// through allInstruments(), so nothing that reads INSTRUMENTS directly can be
// surprised by a symbol that appeared after it rendered.

export function loadCustom() {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function saveCustom(list) {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* quota */ }
  return list;
}

// A discovered candidate becomes an instrument in the same shape the registry
// produces, capabilities included — otherwise every screen would need to know
// whether an instrument came from the file or from here.
export function toInstrument(c) {
  return {
    sym: `${c.base}/USDT`,
    name: c.name || c.base,
    cls: c.cls || 'tradfi',
    bfut: c.bfut,
    perp: true,
    pip: c.pip,
    dec: c.dec,
    custom: true,
    base: c.base,
    quote: 'USDT',
    can: {
      price: true, candles: true,
      spread: false, positioning: false,
      derivatives: true,
      depth: false, book: false,
      // Futures venue only — the spot host these screens call has no such
      // symbol, so they must not offer it.
      spotCandles: false,
    },
  };
}

export function addCustom(candidate) {
  const list = loadCustom();
  // A click on a row from a stale discovery result should do nothing, not
  // take the tab down.
  if (!candidate?.bfut) return list;
  if (list.some(c => c?.bfut === candidate.bfut)) return list;
  return saveCustom([...list, candidate]);
}

export function removeCustom(bfut) {
  return saveCustom(loadCustom().filter(c => c.bfut !== bfut));
}

// The registry plus whatever was chosen. Deduped on symbol, with the static
// registry winning — a hand-tuned entry with a COT code and a real pip size
// should never be shadowed by a discovered one.
export function allInstruments() {
  const custom = loadCustom().map(toInstrument);
  const haveSym = new Set(INSTRUMENTS.map(i => i.sym));
  const haveTicker = new Set(INSTRUMENTS.flatMap(i => [i.binance, i.bfut].filter(Boolean)));
  return [
    ...INSTRUMENTS,
    ...custom.filter(c => !haveSym.has(c.sym) && !haveTicker.has(c.bfut)),
  ];
}

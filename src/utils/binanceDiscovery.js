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
  // Three sources, in order of authority: the hand-tuned registry, whatever was
  // published to the repo (and therefore also visible to the VPS), and finally
  // this device's own picks. A published instrument can never shadow a registry
  // entry that carries a COT code and a hand-checked pip size.
  const extra = [
    ...loadPublished().map(e => toInstrument({ ...e, base: e.sym.split('/')[0] })),
    ...loadCustom().map(toInstrument),
  ];
  const haveSym = new Set(INSTRUMENTS.map(i => i.sym));
  const haveTicker = new Set(INSTRUMENTS.flatMap(i => [i.binance, i.bfut].filter(Boolean)));
  const out = [...INSTRUMENTS];
  for (const c of extra) {
    if (haveSym.has(c.sym) || haveTicker.has(c.bfut)) continue;
    haveSym.add(c.sym); haveTicker.add(c.bfut);
    out.push(c);
  }
  return out;
}

// ── Publishing the discovered list ───────────────────────────────────────────
// localStorage cannot reach the VPS, so an instrument added in the browser is
// invisible to the live feed — which is where "everywhere in the app" quietly
// stops being true. The app already publishes filters and bot config to the
// repo and the bot already reads them, so the discovered list goes the same
// way: one file, both sides read it, no third hand-typed registry.
export const TRADFI_PATH = 'bot/tradfi-instruments.json';
const PUBLISHED_CACHE = 'binance_tradfi_published_v1';

// Only the fields both sides need. Volume and tags are for the picker, not for
// the registry, and writing them would put a number that changes every minute
// into a file that should change when Binance lists something.
const toEntry = c => ({
  sym: `${c.base}/USDT`,
  name: c.name || c.base,
  cls: 'tradfi',
  bfut: c.bfut,
  perp: true,
  pip: c.pip,
  dec: c.dec,
});

// Everything currently listed, static entries included, so the published file
// is the whole picture rather than a diff nobody can read.
export async function buildTradfiList() {
  const found = await discoverBinancePerps();
  const staticOnes = INSTRUMENTS.filter(i => i.cls === 'tradfi')
    .map(i => ({ sym:i.sym, name:i.name, cls:'tradfi', bfut:i.bfut, perp:true, pip:i.pip, dec:i.dec }));
  const seen = new Set(staticOnes.map(e => e.bfut));
  return [...staticOnes, ...found.filter(c => !seen.has(c.bfut)).map(toEntry)]
    .sort((a, b) => a.sym.localeCompare(b.sym));
}

export async function publishTradfiList(ghRead, ghWrite) {
  const instruments = await buildTradfiList();
  let sha = null;
  try { sha = (await ghRead(TRADFI_PATH, { noCache: true }))?.sha || null; } catch { /* first publish */ }
  await ghWrite(TRADFI_PATH, { instruments, updatedAt: new Date().toISOString() },
    `app: publish ${instruments.length} Binance TradFi instruments`, sha);
  cachePublished(instruments);
  return instruments;
}

export function cachePublished(list) {
  try { localStorage.setItem(PUBLISHED_CACHE, JSON.stringify(list)); } catch { /* quota */ }
  return list;
}

export function loadPublished() {
  try {
    const raw = localStorage.getItem(PUBLISHED_CACHE);
    const l = raw ? JSON.parse(raw) : [];
    return Array.isArray(l) ? l : [];
  } catch { return []; }
}

// Pull whatever was last published, so a second device sees the same list
// without rediscovering it.
export async function syncPublished(ghRead) {
  try {
    const f = await ghRead(TRADFI_PATH);
    const list = f?.content?.instruments;
    return Array.isArray(list) ? cachePublished(list) : loadPublished();
  } catch { return loadPublished(); }
}

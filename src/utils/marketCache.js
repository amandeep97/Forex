// src/utils/marketCache.js
// Shared market-data cache.
//
// Every tab previously re-fetched on mount, so switching between screens
// re-downloaded the same candles repeatedly — slow, and hard on rate limits
// when a scan touches 50+ instruments. This gives one place to ask for data,
// with a freshness policy per kind and honest reporting of how old a value is.
//
// Weekly data (COT) is persisted, because re-downloading a figure that only
// changes on Friday is pure waste. Fast-moving data stays in memory only.

const TTL = {
  candles: 60_000,        // 1 min — intraday bars
  candlesD: 15 * 60_000,  // 15 min — daily bars barely move intraday
  spread:  120_000,       // 2 min
  depth:    15_000,       // 15 s — order book moves constantly
  deriv:    60_000,       // 1 min — funding / OI
  cot:  6 * 3600_000,     // 6 h — the report is weekly
  news:  5 * 60_000,      // 5 min
  feed:     60_000,       // 1 min — the VPS only republishes when something changes
};

const PERSIST = new Set(['cot']);          // survives reload; the rest is per-session
const LS_KEY = 'market_cache_v1';

const mem = new Map();                     // key -> { v, at, kind }
let inflight = new Map();                  // key -> Promise (de-dupes concurrent asks)

function loadPersisted() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const now = Date.now();
    for (const [k, e] of Object.entries(raw)) {
      if (e?.at && now - e.at < (TTL[e.kind] || 0)) mem.set(k, e);
    }
  } catch {}
}
loadPersisted();

function savePersisted() {
  try {
    const out = {};
    for (const [k, e] of mem) if (PERSIST.has(e.kind)) out[k] = e;
    localStorage.setItem(LS_KEY, JSON.stringify(out));
  } catch {}
}

export function cacheKey(kind, symbol, params = '') { return `${kind}:${symbol}:${params}`; }

export function peek(kind, symbol, params = '') {
  const e = mem.get(cacheKey(kind, symbol, params));
  if (!e) return null;
  const age = Date.now() - e.at;
  return { value: e.v, age, fresh: age < (TTL[kind] || 0) };
}

// Ask for a value. Returns { value, age, fresh, cached }.
// - a fresh entry is returned without touching the network
// - concurrent asks for the same key share one request
// - if the fetch fails but a stale value exists, the stale value is returned
//   and flagged, which beats blanking a panel that had good data a minute ago
export async function get(kind, symbol, fetcher, { params = '', force = false } = {}) {
  const key = cacheKey(kind, symbol, params);
  const hit = mem.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;

  if (!force && hit && age < (TTL[kind] || 0)) {
    return { value: hit.v, age, fresh: true, cached: true };
  }
  if (inflight.has(key)) {
    const v = await inflight.get(key);
    return { value: v, age: 0, fresh: true, cached: true };
  }

  const p = (async () => {
    const v = await fetcher();
    mem.set(key, { v, at: Date.now(), kind });
    if (PERSIST.has(kind)) savePersisted();
    return v;
  })();
  inflight.set(key, p);

  try {
    const v = await p;
    return { value: v, age: 0, fresh: true, cached: false };
  } catch (err) {
    if (hit) return { value: hit.v, age, fresh: false, cached: true, stale: true, error: err.message };
    throw err;
  } finally {
    inflight.delete(key);
  }
}

export function invalidate(kind, symbol) {
  for (const k of [...mem.keys()]) {
    if (k.startsWith(`${kind}:${symbol ?? ''}`)) mem.delete(k);
  }
  savePersisted();
}

export function clearAll() {
  mem.clear(); inflight = new Map();
  try { localStorage.removeItem(LS_KEY); } catch {}
}

export function stats() {
  const byKind = {};
  for (const e of mem.values()) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return { entries: mem.size, byKind };
}

// ── Concurrency limiter ───────────────────────────────────────────────────────
// A scan over 50+ instruments must not open 50+ sockets at once: browsers queue
// them anyway and providers rate-limit. Runs `n` at a time and reports progress
// so the UI can fill in as results land instead of blocking on the slowest.
export async function pooled(items, worker, { limit = 6, onProgress } = {}) {
  const out = new Array(items.length);
  let idx = 0, done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await worker(items[i], i); }
      catch (e) { out[i] = { error: e.message, item: items[i] }; }
      done++;
      onProgress?.(done, items.length, out[i], items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

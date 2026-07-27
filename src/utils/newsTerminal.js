// src/utils/newsTerminal.js
// Terminal-grade news engine: merged multi-source stream, instrument tagging,
// a growing economic-event archive, and ECO-style historical reaction stats
// (how an instrument actually moved around past releases of a given event).

// ── Instrument tagging ────────────────────────────────────────────────────────
// Maps a headline to the instruments it plausibly moves. Deliberately narrow —
// a tag that fires on everything is worse than no tag.
export const INSTRUMENT_KEYWORDS = {
  'XAU/USD':  ['gold','bullion','xau','precious metal','safe haven','safe-haven'],
  'XAG/USD':  ['silver','xag'],
  'EUR/USD':  ['euro','ecb','eurozone','lagarde','bundesbank','german','germany'],
  'GBP/USD':  ['pound','sterling','boe','bank of england','bailey','britain','british'],
  'USD/JPY':  ['yen','boj','bank of japan','ueda','japan','japanese'],
  'AUD/USD':  ['aussie','rba','australia','australian'],
  'NZD/USD':  ['kiwi','rbnz','new zealand'],
  'USD/CAD':  ['loonie','boc','bank of canada','macklem','canada','canadian'],
  'USD/CHF':  ['franc','snb','swiss','switzerland'],
  'USOIL':    ['oil','crude','wti','opec','barrel','petroleum'],
  'UKOIL':    ['brent','crude','opec'],
  'NATGAS':   ['natural gas','natgas','lng'],
  'US500':    ['s&p','sp500','s&p 500','wall street','equities','stocks'],
  'US100':    ['nasdaq','tech stocks','big tech'],
  'US30':     ['dow','dow jones'],
  'BTC/USDT': ['bitcoin','btc','crypto'],
  'ETH/USDT': ['ethereum','ether','eth'],
};

// Macro USD events that genuinely move everything priced in dollars.
// Deliberately excludes the bare word "dollar" — it appears in most FX
// headlines and would fan every story out across seven instruments.
const USD_MACRO = ['fed','fomc','powell','treasury','nonfarm','payroll',' nfp','cpi','pce','jobless','rate decision'];
const USD_AFFECTED = ['XAU/USD','EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','US500'];

export function tagInstruments(text) {
  const t = ' ' + (text || '').toLowerCase() + ' ';
  const specific = [];
  for (const [inst, words] of Object.entries(INSTRUMENT_KEYWORDS)) {
    if (words.some(w => t.includes(w))) specific.push(inst);
  }
  // A named instrument always wins: "Gold surges as dollar weakens" is a gold
  // story, not a seven-instrument story. Only fan out to the USD complex when
  // the headline is purely macro with nothing specific named.
  if (specific.length) return specific;
  if (USD_MACRO.some(w => t.includes(w))) return [...USD_AFFECTED];
  return [];
}

// ── Severity: how much a headline deserves your attention ─────────────────────
const URGENT = ['breaking','just in','alert','emergency','surprise','unscheduled','halts','halted','intervention'];
const HEAVY  = ['rate decision','rate cut','rate hike','fomc','cpi','nonfarm','payroll','gdp','inflation','war','sanction','default','downgrade'];

export function severity(text) {
  const t = (text || '').toLowerCase();
  if (URGENT.some(w => t.includes(w))) return 3;   // red
  if (HEAVY.some(w => t.includes(w)))  return 2;   // amber
  return 1;                                        // normal
}

// ── Merged multi-source stream ────────────────────────────────────────────────
// Bloomberg shows ONE stream, not a source picker. Fetch every feed in parallel,
// keep whatever succeeds, dedupe near-identical headlines, sort newest first.
const normTitle = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

export async function mergeFeeds(feeds, fetchText, parseRSS) {
  const settled = await Promise.allSettled(
    feeds.map(async f => (parseRSS(await fetchText(f.url)) || []).map(i => ({
      ...i, source: f.name, sourceColor: f.color, sourceBadge: f.badge,
    })))
  );
  const all = settled.filter(s => s.status === 'fulfilled').flatMap(s => s.value);
  const seen = new Map();
  for (const it of all) {
    const k = normTitle(it.title).slice(0, 70);
    if (!k) continue;
    const prev = seen.get(k);
    // keep the earliest report of a story, but remember every source that ran it
    if (!prev) seen.set(k, { ...it, alsoIn: [] });
    else if (!prev.alsoIn.includes(it.source) && it.source !== prev.source) prev.alsoIn.push(it.source);
  }
  const ts = i => { const d = new Date(i.pubDate); return isNaN(d) ? 0 : d.getTime(); };
  return [...seen.values()]
    .map(i => ({ ...i, ms: ts(i), instruments: tagInstruments(`${i.title} ${i.description || ''}`), sev: severity(i.title) }))
    .sort((a, b) => b.ms - a.ms);
}

export function feedsOk(settledCount, total) { return `${settledCount}/${total} feeds`; }

// ── Economic event archive ────────────────────────────────────────────────────
// The calendar source only serves the current week, so history has to be
// accumulated. Every load merges this week's events into a local archive keyed
// by title+country+date, which grows into a usable sample over time.
const ARCH_KEY = 'news_event_archive_v1';
const ARCH_MAX = 4000;

const evKey = ev => `${ev.country}|${(ev.title || '').trim()}|${ev.date}`;

export function loadArchive() {
  try { return JSON.parse(localStorage.getItem(ARCH_KEY) || '[]'); } catch { return []; }
}

export function archiveEvents(events) {
  if (!events?.length) return loadArchive();
  const arch = loadArchive();
  const idx = new Map(arch.map(e => [evKey(e), e]));
  for (const ev of events) {
    if (!ev?.date || !ev?.title) continue;
    const k = evKey(ev);
    const slim = {
      title: ev.title, country: ev.country, date: ev.date, impact: ev.impact,
      actual: ev.actual ?? null, forecast: ev.forecast ?? null, previous: ev.previous ?? null,
    };
    // Overwrite: a re-fetch after release fills in the `actual` we did not have before
    if (!idx.has(k) || (slim.actual && !idx.get(k).actual)) idx.set(k, slim);
  }
  const next = [...idx.values()]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-ARCH_MAX);
  try { localStorage.setItem(ARCH_KEY, JSON.stringify(next)); } catch {}
  return next;
}

export function archiveStats() {
  const a = loadArchive();
  if (!a.length) return { n: 0, from: null, to: null, days: 0 };
  const from = new Date(a[0].date), to = new Date(a[a.length - 1].date);
  return { n: a.length, from, to, days: Math.max(0, Math.round((to - from) / 86400000)) };
}

// Distinct recurring event names we have enough history for
export function archivedEventTypes(minCount = 2) {
  const counts = new Map();
  for (const e of loadArchive()) {
    if (e.impact !== 'High' && e.impact !== 'Medium') continue;
    const k = `${e.country}|${(e.title || '').trim()}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([k, c]) => ({ country: k.split('|')[0], title: k.split('|')[1], count: c }))
    .sort((a, b) => b.count - a.count);
}

// ── ECO: historical price reaction to a repeating event ───────────────────────
const num = v => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
};
const INVERSE = ['unemployment rate','jobless','initial claims','continuing claims','inventories','deficit'];

export function surpriseOf(ev) {
  const a = num(ev.actual), f = num(ev.forecast);
  if (a == null || f == null) return null;
  if (a === f) return 'inline';
  let better = a > f;
  if (INVERSE.some(k => (ev.title || '').toLowerCase().includes(k))) better = !better;
  return better ? 'beat' : 'miss';
}

const median = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Reaction of one instrument to every archived instance of an event.
// fetchWindow(fromMs, toMs) must resolve to ascending candles [{t,o,h,l,c}].
export async function computeReaction(eventTitle, country, fetchWindow, opts = {}) {
  const horizons = opts.horizons || [15, 60, 240];      // minutes
  const maxInstances = opts.maxInstances || 16;
  const instances = loadArchive()
    .filter(e => e.country === country && (e.title || '').trim() === eventTitle.trim())
    .filter(e => new Date(e.date).getTime() < Date.now() - 3600e3)   // fully released
    .slice(-maxInstances);

  const rows = [];
  for (const ev of instances) {
    const t0 = new Date(ev.date).getTime();
    try {
      const candles = await fetchWindow(t0 - 30 * 60e3, t0 + (Math.max(...horizons) + 30) * 60e3);
      if (!candles?.length) continue;
      const at = ms => {
        let best = null;
        for (const c of candles) { if (c.t <= ms) best = c; else break; }
        return best;
      };
      const base = at(t0);
      if (!base) continue;
      const moves = {};
      for (const h of horizons) {
        const c = at(t0 + h * 60e3);
        moves[h] = c ? +(((c.c - base.c) / base.c) * 100).toFixed(3) : null;
      }
      rows.push({ date: ev.date, surprise: surpriseOf(ev), actual: ev.actual, forecast: ev.forecast, moves });
    } catch { /* skip an instance we cannot price */ }
  }

  const bucket = (name) => {
    const set = name === 'all' ? rows : rows.filter(r => r.surprise === name);
    const out = { name, n: set.length, horizons: {} };
    for (const h of horizons) {
      const vals = set.map(r => r.moves[h]).filter(v => v != null);
      out.horizons[h] = vals.length ? {
        median: +median(vals).toFixed(3),
        upPct: Math.round(vals.filter(v => v > 0).length / vals.length * 100),
        n: vals.length,
      } : null;
    }
    return out;
  };

  return {
    eventTitle, country, horizons,
    instances: rows.length,
    rows: rows.slice().reverse(),
    buckets: [bucket('all'), bucket('beat'), bucket('miss')].filter(b => b.n > 0),
  };
}

// ── Command bar ───────────────────────────────────────────────────────────────
// Bloomberg-style: short tokens, no menus. `XAU` filters to gold, `USD HIGH`
// filters USD high-impact, `ECO` opens reaction stats, `?` lists commands.
export const COMMANDS = [
  ['<CCY>',       'Filter to a currency — USD, EUR, GBP, JPY, AUD, NZD, CAD, CHF'],
  ['<INSTRUMENT>','Filter to an instrument — XAU, GOLD, OIL, BTC, SPX, NAS'],
  ['HIGH / MED',  'Filter calendar impact level'],
  ['TODAY',       'Only events and news from today'],
  ['ECO',         'Historical price reaction to economic releases'],
  ['LIVE',        'Merged real-time headline stream'],
  ['CAL',         'Economic calendar'],
  ['POS',         'Only news affecting your open positions'],
  ['CLR',         'Clear all filters'],
  ['?',           'Show this help'],
];

const CCY_ALIAS = { USD:'USD', EUR:'EUR', GBP:'GBP', JPY:'JPY', CHF:'CHF', AUD:'AUD', NZD:'NZD', CAD:'CAD', CNY:'CNY' };
const INST_ALIAS = {
  XAU:'XAU/USD', GOLD:'XAU/USD', XAG:'XAG/USD', SILVER:'XAG/USD',
  OIL:'USOIL', WTI:'USOIL', USOIL:'USOIL', BRENT:'UKOIL', UKOIL:'UKOIL', GAS:'NATGAS', NATGAS:'NATGAS',
  BTC:'BTC/USDT', BITCOIN:'BTC/USDT', ETH:'ETH/USDT',
  SPX:'US500', SP500:'US500', US500:'US500', NAS:'US100', NASDAQ:'US100', US100:'US100', DOW:'US30', US30:'US30',
  EURUSD:'EUR/USD', GBPUSD:'GBP/USD', USDJPY:'USD/JPY',
};

export function parseCommand(raw) {
  const out = { view: null, ccy: null, instrument: null, impact: null, today: false, help: false, clear: false, unknown: [] };
  const toks = (raw || '').toUpperCase().split(/[\s,]+/).filter(Boolean);
  for (const t of toks) {
    if (t === '?' || t === 'HELP')            { out.help = true; continue; }
    if (t === 'CLR' || t === 'CLEAR')         { out.clear = true; continue; }
    if (t === 'ECO' || t === 'LIVE' || t === 'CAL' || t === 'POS') { out.view = t; continue; }
    if (t === 'HIGH' || t === 'MED' || t === 'MEDIUM') { out.impact = t === 'HIGH' ? 'High' : 'Medium'; continue; }
    if (t === 'TODAY')                        { out.today = true; continue; }
    if (INST_ALIAS[t])                        { out.instrument = INST_ALIAS[t]; continue; }
    if (CCY_ALIAS[t])                         { out.ccy = CCY_ALIAS[t]; continue; }
    out.unknown.push(t);
  }
  return out;
}

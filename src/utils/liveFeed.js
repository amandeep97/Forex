// src/utils/liveFeed.js
// Reads the feed the VPS publishes and applies YOUR filter to it.
//
// This file computes nothing about the market. Every number it tests was
// measured on the VPS (vps-bot/src/feed.js) so that the answer is the same
// whether the app has been open all night or you just unlocked your phone.
//
// The job is shortlisting, not signalling: the output is a list of instrument
// names worth opening, and it deliberately produces no score and no direction.
// Those live in Consensus and Signals, and a fifth opinion here would be a
// fourth copy of a scoring engine rather than a new piece of information.

import { INSTRUMENTS, bySymbol, CLASS_ORDER } from '../data/instruments';
import { CONDITIONS, evaluateOne } from '../../shared/feedConditions.mjs';
import { get } from './marketCache';
import { ghRead, ghWrite, isGithubConfigured } from './githubSync';

const FEED_URL = 'https://raw.githubusercontent.com/amandeep97/Forex/main/bot/feed.json';
const FILTERS_PATH = 'bot/feed-filters.json';

const FILTERS_KEY   = 'live_feed_filters_v1';
const ACTIVE_KEY    = 'live_feed_active_v1';
const SYNCED_KEY    = 'live_feed_synced_v1';
const SHORTLIST_KEY = 'live_feed_shortlist_v1';
const SEEN_PRESETS_KEY = 'live_feed_seen_presets_v1';
const PRESET_SHIPPED_KEY = 'live_feed_preset_shipped_v1';
const WATCH_KEY     = 'forex_watchlist';

// ── Feed ──────────────────────────────────────────────────────────────────────
export async function fetchFeed({ force = false } = {}) {
  const r = await get('feed', 'live', async () => {
    const res = await fetch(`${FEED_URL}?t=${Date.now()}`, {
      cache: 'no-store', signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) return { missing: true };
    if (!res.ok) throw new Error(`feed ${res.status}`);
    return res.json();
  }, { force });
  return r.value;
}

// The condition vocabulary lives in shared/feedConditions.mjs because the VPS
// evaluates the same filters to decide whether to wake your phone. One copy, so
// a push can never disagree with the screen.
export {
  CONDITIONS, CONDITION_GROUPS, defaultParams, evaluateOne, rarityFor, matchKey,
  contradictions,
} from '../../shared/feedConditions.mjs';

// ── Filters ───────────────────────────────────────────────────────────────────
// mode 'all'  — every condition must hold
// mode 'any'  — at least `minMatch` of them. This is the useful one: four
//               conditions ANDed together return nothing on most days, which
//               reads as "the filter is broken" rather than "markets are quiet".
export function newFilter(name = 'New filter') {
  return { id: `f${Date.now().toString(36)}`, name, mode:'all', minMatch:2, classes:null, symbols:null, conditions:[] };
}

// Instruments that move together closely enough that holding several is one
// position. Measured from the feed's own daily returns, not assumed:
// USOIL/UKOIL +1.00, US500/US100 +0.92, XAU/XAG +0.90, EUR/GBP-USD +0.84.
export const SAME_BET = [
  { name:'crude oil',       syms:['USOIL','UKOIL'] },
  { name:'US indices',      syms:['US500','US100','US30','US2000'] },
  { name:'precious metals', syms:['XAU/USD','XAG/USD'] },
  { name:'EUR / GBP vs USD',syms:['EUR/USD','GBP/USD'] },
];

// Warn when a hand-picked list is fewer bets than it looks.
export function redundantPicks(symbols) {
  const set = new Set(symbols || []);
  return SAME_BET
    .map(g => ({ ...g, picked: g.syms.filter(x => set.has(x)) }))
    .filter(g => g.picked.length > 1);
}

export const PRESETS = [
  { id:'p_sweep_coiled', name:'Sweep into a quiet market', mode:'all', minMatch:2, classes:null,
    conditions:[
      { key:'sweep',     params:{ tf:'H4', dir:'any', withinH:48 } },
      { key:'volCoiled', params:{ tf:'H4', maxPct:30 } },
    ] },
  { id:'p_reversal', name:'Reversal watch (any 2)', mode:'any', minMatch:2, classes:null,
    conditions:[
      { key:'sweep',        params:{ tf:'H4', dir:'any', withinH:72 } },
      { key:'rangeTop',     params:{ tf:'D', minPct:92 } },
      { key:'rangeBottom',  params:{ tf:'D', maxPct:8 } },
      { key:'crowdedLong',  params:{ minPct:88 } },
      { key:'crowdedShort', params:{ maxPct:12 } },
    ] },
  // Deliberately without a spread guard. Adding one looks harmless and silently
  // removes every crypto instrument, because there is no bid/ask feed for them
  // and an unmeasurable condition cannot be satisfied. Cost guards belong on
  // filters scoped to instruments that actually have a spread reading.
  { id:'p_breakout', name:'Break with expansion', mode:'all', minMatch:2, classes:null,
    conditions:[
      { key:'break',        params:{ tf:'H4', dir:'any', withinH:24 } },
      { key:'volExpanding', params:{ tf:'H4', minPct:80 } },
    ] },
];

// A focus list, because watching everything is how nothing gets watched. Four
// instruments that are genuinely four different bets — gold against the dollar,
// US equity, crude, and the most liquid FX major. Silver and Brent are left out
// on purpose: at +0.90 and +1.00 they add position size, not information.
PRESETS.push({
  // ANY 2, not 1. At minMatch 1 a single condition puts an instrument on the
  // list, which is not filtering — gold appeared on "volatility coiled" alone.
  id:'p_focus', name:'My four', mode:'any', minMatch:2, classes:null,
  symbols:['XAU/USD','US500','USOIL','EUR/USD'],
  conditions:[
    { key:'sweep',        params:{ tf:'H4', dir:'any', withinH:48 } },
    { key:'break',        params:{ tf:'D',  dir:'any', withinH:120 } },
    { key:'volCoiled',    params:{ tf:'H4', maxPct:25 } },
    { key:'rangeTop',     params:{ tf:'D',  minPct:92 } },
    { key:'rangeBottom',  params:{ tf:'D',  maxPct:8 } },
  ],
});

// Saved filters used to short-circuit the presets entirely, so anyone who had
// ever created a filter would never see a newly shipped one — a preset added
// today reached only fresh installs, which is to say almost nobody.
//
// New presets are now merged in once. "Once" is the important part: a preset you
// delete stays deleted, because its id is remembered as seen rather than
// compared against what happens to be in the list right now.
const clone = p => ({ ...p, conditions: p.conditions.map(c => ({ ...c })) });
const sig = f => JSON.stringify({ mode:f.mode, minMatch:f.minMatch, classes:f.classes,
  symbols:f.symbols, conditions:f.conditions });

// Merging new presets in was only half the problem. Correcting an EXISTING
// preset never reached anyone either: "My four" was fixed from ANY 1 to ANY 2,
// and every phone kept the copy it had already saved — so the fix shipped and
// changed nothing, twice over.
//
// A saved copy is updated only when it still matches the version that shipped
// to it. If it differs, the filter has been edited and is left alone; nobody's
// tuning is overwritten by an upgrade.
export function loadFilters() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null'); } catch { /* private mode */ }

  const stamp = (list) => {
    try {
      localStorage.setItem(SEEN_PRESETS_KEY, JSON.stringify(PRESETS.map(p => p.id)));
      localStorage.setItem(PRESET_SHIPPED_KEY,
        JSON.stringify(Object.fromEntries(PRESETS.map(p => [p.id, sig(p)]))));
    } catch { /* quota */ }
    return list;
  };

  if (!Array.isArray(saved) || !saved.length) return stamp(PRESETS.map(clone));

  let seen = [], shipped = {};
  try { seen = JSON.parse(localStorage.getItem(SEEN_PRESETS_KEY) || '[]'); } catch { /* private mode */ }
  try { shipped = JSON.parse(localStorage.getItem(PRESET_SHIPPED_KEY) || '{}'); } catch { /* private mode */ }

  const byId = new Map(PRESETS.map(p => [p.id, p]));
  let changed = false;

  const next = saved.map(f => {
    const preset = byId.get(f.id);
    if (!preset) return f;                       // your own filter
    const was = shipped[f.id];
    if (was == null || was !== sig(f)) return f; // edited, or predates tracking — leave it
    if (sig(preset) === was) return f;           // unchanged upstream
    changed = true;
    return { ...clone(preset), push: f.push };   // keep the push choice, take the fix
  });

  const have = new Set([...seen, ...saved.map(f => f.id)]);
  const added = PRESETS.filter(p => !have.has(p.id)).map(clone);
  if (added.length) { next.push(...added); changed = true; }

  if (changed) saveFilters(next);
  return stamp(next);
}

export function saveFilters(list) {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(list)); } catch { /* quota */ }
}

export function loadActiveId() { try { return localStorage.getItem(ACTIVE_KEY) || null; } catch { return null; } }
export function saveActiveId(id) { try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* quota */ } }

// ── Sending filters to the VPS ────────────────────────────────────────────────
// Filters live in localStorage, which the bot cannot read. A filter marked for
// push is copied to the repo, where the bot picks it up and evaluates it with
// the same shared rules the screen uses.
//
// Syncing is explicit rather than automatic on every edit: each write is a
// commit, and auto-syncing would produce one per keystroke in the name field.
const pushable = list => (list || []).filter(f => f.push && (f.conditions || []).length)
  .map(({ id, name, mode, minMatch, classes, symbols, conditions }) =>
    ({ id, name, mode, minMatch, classes, symbols, conditions, push: true }));

const syncHash = list => JSON.stringify(pushable(list));

export function syncState(list) {
  const want = pushable(list);
  let last = null;
  try { last = localStorage.getItem(SYNCED_KEY); } catch { /* private mode */ }
  return {
    count: want.length,
    dirty: syncHash(list) !== last,
    neverSynced: last == null,
    configured: isGithubConfigured(),
  };
}

export async function syncFiltersToBot(list) {
  if (!isGithubConfigured()) {
    return { ok:false, msg:'Connect GitHub in Settings — the VPS reads your filters from the repo.' };
  }
  const want = pushable(list);
  let sha = null;
  try { const r = await ghRead(FILTERS_PATH, { noCache: true }); sha = r?.sha; } catch { /* first write */ }
  await ghWrite(FILTERS_PATH, { filters: want, updatedAt: new Date().toISOString() },
    'app: sync feed filters to bot', sha);
  try { localStorage.setItem(SYNCED_KEY, syncHash(list)); } catch { /* quota */ }
  return { ok:true, msg: want.length
    ? `${want.length} filter(s) now watched by the VPS. It notifies on NEW matches only — what already matches right now is recorded silently.`
    : 'No filters marked for push — the VPS will stop notifying.' };
}

// ── Proving push actually works ───────────────────────────────────────────────
// Everything about push can look correct — permission granted, filter marked,
// filters synced — and still deliver nothing, and the only way to find out used
// to be waiting for a market event that never came. This asks the VPS to send
// one now and reports how many devices actually took it.
const CONTROL_PATH = 'bot/vps-control.json';

export async function requestTestPush() {
  if (!isGithubConfigured()) return { ok:false, msg:'Connect GitHub in Settings first.' };
  const r = await ghRead(CONTROL_PATH, { noCache: true }).catch(() => null);
  await ghWrite(CONTROL_PATH,
    { ...(r?.content || { command:'running' }), testPush:true, testPushSentAt:new Date().toISOString(), testPushResult:null },
    'app: request push test', r?.sha || null);
  return { ok:true, msg:'Asked the VPS to send a test — it goes out within a minute.' };
}

// The bot writes its answer back into the same file.
export async function readTestPushResult() {
  try {
    const r = await ghRead(CONTROL_PATH, { noCache: true });
    const c = r?.content || {};
    if (c.testPush) return { state:'pending' };
    if (!c.testPushResult) return { state:'none' };
    return { state:'done', at:c.testPushAt, ...c.testPushResult };
  } catch (e) { return { state:'error', detail:e.message }; }
}

// ── Shortlist ─────────────────────────────────────────────────────────────────
// Starring writes to the same watchlist the Watchlist tab reads, plus a note of
// WHY and at what price. Without the note, next week's list is a row of symbols
// with no memory of what you saw in them — and no way to find out afterwards
// whether the filter that surfaced them was worth anything.
export function loadShortlist() {
  try { return JSON.parse(localStorage.getItem(SHORTLIST_KEY) || '{}'); } catch { return {}; }
}

function saveShortlist(map) {
  try { localStorage.setItem(SHORTLIST_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

export function shortlistToggle(sym, { price, reason, filterName } = {}) {
  const map = loadShortlist();
  if (map[sym]) delete map[sym];
  else map[sym] = { at: Date.now(), price: price ?? null, reason: reason || null, filter: filterName || null };
  saveShortlist(map);

  // Keep the shared watchlist in step, so this remains one list rather than two
  try {
    const prev = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    const next = map[sym] ? [...new Set([...prev, sym])] : prev.filter(s => s !== sym);
    localStorage.setItem(WATCH_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event('storage'));
  } catch { /* quota */ }
  return map;
}

// What the instrument has done since you shortlisted it. Null when there is no
// entry price to compare against rather than a fabricated 0%.
export function sinceShortlist(entry, priceNow) {
  if (!entry || entry.price == null || priceNow == null || !(entry.price > 0)) return null;
  return +(((priceNow - entry.price) / entry.price) * 100).toFixed(2);
}

// ── Evaluation over every instrument ──────────────────────────────────────────
export function evaluate(feed, filter) {
  const recs = feed?.instruments || {};
  const scope = filter.classes?.length ? new Set(filter.classes) : null;
  // A named list beats a class. "Gold, S&P, oil, EUR" crosses four classes and
  // is a subset of each, so class scoping alone could not express the handful
  // of instruments someone actually watches.
  const only = filter.symbols?.length ? new Set(filter.symbols) : null;

  const rows = [];
  let considered = 0, noData = 0;

  // Instruments that failed nothing and were still excluded, purely because a
  // condition cannot be measured for them. Under ALL, adding "funds crowded
  // long" quietly removes every crypto pair — measured is not the same as
  // false, and a filter that drops a third of the market must say so.
  const blocked = [];

  // Iterate what the FEED contains, not what this app's registry lists. The bot
  // decides pushes by walking the same map, so driving the screen from the local
  // registry instead would let a symbol the bot measures but the app has not
  // heard of get notified and never appear — the exact failure the shared rules
  // exist to prevent. Every record carries its own class, name and precision, so
  // the registry is an enrichment here, never a gate.
  for (const [sym, rec] of Object.entries(recs)) {
    if (!rec) continue;
    if (only && !only.has(sym)) continue;
    const inst = bySymbol(sym);
    const cls = rec.cls || inst?.cls || 'fx';
    if (scope && !scope.has(cls)) continue;
    considered++;
    const ev = evaluateOne(rec, filter);
    if (!ev.matched) {
      if (ev.failed.length === 0 && ev.unknown.length > 0) {
        blocked.push({ sym, keys: ev.unknown.map(u => u.label), why: ev.unknown[0].detail });
      }
      continue;
    }

    // Newest passing event first, so the list reads as "what happened, when"
    const events = ev.passed.filter(r => r.event).map(r => r.event).sort((a, b) => b.at - a.at);
    rows.push({
      sym, name: rec.name || inst?.name || sym, cls, dec: rec.dec ?? inst?.dec ?? 2,
      price: rec.price, rec, ...ev, newestAt: events[0]?.at || null, events,
      // Draw the timeframe the filter actually looked at, falling back to
      // whatever the feed has — a chart of a timeframe you did not filter on
      // would be decoration, not evidence.
      sparkTf: ev.passed.find(p => p.params?.tf)?.params.tf
            || (rec.spark?.H4 ? 'H4' : rec.spark?.D ? 'D' : null),
    });
  }

  // Registry instruments the feed has not measured yet — a cold start, not a
  // filter result, so it is reported separately rather than as "no match".
  for (const inst of INSTRUMENTS) {
    if (only && !only.has(inst.sym)) continue;
    if (scope && !scope.has(inst.cls)) continue;
    if (!recs[inst.sym]) noData++;
  }

  rows.sort((a, b) => (b.newestAt || 0) - (a.newestAt || 0) || b.passed.length - a.passed.length);
  return { rows, considered, noData, blocked, total: INSTRUMENTS.length };
}

// The bot only keeps so much event history, so asking for a longer lookback
// than it retains would quietly return less than requested — and the filter
// would look like it had stopped finding things.
export function lookbackCapH(feed, tf) {
  const days = feed?.meta?.retainDays?.[tf];
  return days ? days * 24 : null;
}

export function feedAge(feed) {
  if (!feed?.updatedAt) return null;
  return Date.now() - new Date(feed.updatedAt).getTime();
}

export function ago(ms) {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const CLASSES = CLASS_ORDER;
export { bySymbol };

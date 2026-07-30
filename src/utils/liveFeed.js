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
} from '../../shared/feedConditions.mjs';

// ── Filters ───────────────────────────────────────────────────────────────────
// mode 'all'  — every condition must hold
// mode 'any'  — at least `minMatch` of them. This is the useful one: four
//               conditions ANDed together return nothing on most days, which
//               reads as "the filter is broken" rather than "markets are quiet".
export function newFilter(name = 'New filter') {
  return { id: `f${Date.now().toString(36)}`, name, mode:'all', minMatch:2, classes:null, conditions:[] };
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

export function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* fall through to presets */ }
  return PRESETS.map(p => ({ ...p, conditions: p.conditions.map(c => ({ ...c })) }));
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
  .map(({ id, name, mode, minMatch, classes, conditions }) =>
    ({ id, name, mode, minMatch, classes, conditions, push: true }));

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
    });
  }

  // Registry instruments the feed has not measured yet — a cold start, not a
  // filter result, so it is reported separately rather than as "no match".
  for (const inst of INSTRUMENTS) {
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

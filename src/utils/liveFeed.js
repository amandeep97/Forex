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
import { get } from './marketCache';

const FEED_URL = 'https://raw.githubusercontent.com/amandeep97/Forex/main/bot/feed.json';

const FILTERS_KEY = 'live_feed_filters_v1';
const ACTIVE_KEY  = 'live_feed_active_v1';

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

// ── Conditions ────────────────────────────────────────────────────────────────
// Each returns:
//   { ok:true }   satisfied
//   { ok:false }  measured and not satisfied
//   { ok:null }   not measurable for this instrument (no COT, no spread feed…)
//
// The third case is the one that matters. Treating "we never measured it" as
// "it is false" is how a screen ends up quietly excluding every crypto pair
// from a filter that mentions positioning, with nothing on screen to say so.
const NA = why => ({ ok: null, detail: why });

const stateOf = (rec, tf) => rec?.state?.[tf] || null;

function eventHit(rec, type, p) {
  const cutoff = Date.now() - (p.withinH || 48) * 3600e3;
  const hits = (rec.events || []).filter(e =>
    e.type === type && e.tf === p.tf && e.at >= cutoff &&
    (p.dir === 'any' || !p.dir || e.dir === p.dir));
  if (!rec.asOf?.[p.tf]) return NA(`no ${p.tf} data`);
  if (!hits.length) return { ok: false, detail: `no ${p.tf} ${type} in ${p.withinH}h` };
  const h = hits[0];
  return { ok: true, event: h, detail: `${p.tf} ${h.dir === 'up' ? '▲' : '▼'} ${h.detail}`, at: h.at };
}

const TF_OPTS = [{ v:'H4', label:'H4' }, { v:'D', label:'Daily' }];
const DIR_OPTS = [{ v:'any', label:'either way' }, { v:'up', label:'bullish only' }, { v:'down', label:'bearish only' }];

export const CONDITIONS = {
  sweep: {
    label: 'Liquidity sweep', group: 'Event', kind: 'event',
    help: 'Wick clears the prior 5-bar high or low, body closes back inside.',
    params: [
      { k:'tf',      label:'timeframe', type:'select', options:TF_OPTS, def:'H4' },
      { k:'dir',     label:'direction', type:'select', options:DIR_OPTS, def:'any' },
      { k:'withinH', label:'within (hours)', type:'number', def:48, min:4, max:720, step:4 },
    ],
    test: (rec, p) => eventHit(rec, 'sweep', p),
  },
  break: {
    label: 'Structure break', group: 'Event', kind: 'event',
    help: 'Close through the most recent confirmed swing high or low.',
    params: [
      { k:'tf',      label:'timeframe', type:'select', options:TF_OPTS, def:'H4' },
      { k:'dir',     label:'direction', type:'select', options:DIR_OPTS, def:'any' },
      { k:'withinH', label:'within (hours)', type:'number', def:24, min:4, max:720, step:4 },
    ],
    test: (rec, p) => eventHit(rec, 'break', p),
  },

  volCoiled: {
    label: 'Volatility coiled', group: 'Volatility', kind: 'state',
    help: 'Current ATR low against this instrument’s own range — quiet before it is not.',
    params: [
      { k:'tf',     label:'timeframe', type:'select', options:TF_OPTS, def:'H4' },
      { k:'maxPct', label:'at or below percentile', type:'number', def:20, min:1, max:50, step:1 },
    ],
    test: (rec, p) => {
      const s = stateOf(rec, p.tf); if (!s || s.volPct == null) return NA(`no ${p.tf} data`);
      return { ok: s.volPct <= p.maxPct, detail: `volatility ${s.volPct}th pct` };
    },
  },
  volExpanding: {
    label: 'Volatility expanding', group: 'Volatility', kind: 'state',
    params: [
      { k:'tf',     label:'timeframe', type:'select', options:TF_OPTS, def:'H4' },
      { k:'minPct', label:'at or above percentile', type:'number', def:85, min:50, max:99, step:1 },
    ],
    test: (rec, p) => {
      const s = stateOf(rec, p.tf); if (!s || s.volPct == null) return NA(`no ${p.tf} data`);
      return { ok: s.volPct >= p.minPct, detail: `volatility ${s.volPct}th pct` };
    },
  },

  rangeTop: {
    label: 'At top of range', group: 'Location', kind: 'state',
    params: [
      { k:'tf',     label:'timeframe', type:'select', options:TF_OPTS, def:'H4' },
      { k:'minPct', label:'at or above', type:'number', def:90, min:50, max:100, step:1 },
    ],
    test: (rec, p) => {
      const s = stateOf(rec, p.tf); if (!s) return NA(`no ${p.tf} data`);
      return { ok: s.rangePos >= p.minPct, detail: `${s.rangePos}% up the 60-bar range` };
    },
  },
  rangeBottom: {
    label: 'At bottom of range', group: 'Location', kind: 'state',
    params: [
      { k:'tf',     label:'timeframe', type:'select', options:TF_OPTS, def:'H4' },
      { k:'maxPct', label:'at or below', type:'number', def:10, min:0, max:50, step:1 },
    ],
    test: (rec, p) => {
      const s = stateOf(rec, p.tf); if (!s) return NA(`no ${p.tf} data`);
      return { ok: s.rangePos <= p.maxPct, detail: `${s.rangePos}% up the 60-bar range` };
    },
  },

  bigMove: {
    label: 'Big recent move', group: 'Movement', kind: 'state',
    params: [
      { k:'tf',        label:'timeframe', type:'select', options:TF_OPTS, def:'H4' },
      { k:'minAbsPct', label:'20-bar change at least (%)', type:'number', def:3, min:0.5, max:30, step:0.5 },
      { k:'dir',       label:'direction', type:'select', options:DIR_OPTS, def:'any' },
    ],
    test: (rec, p) => {
      const s = stateOf(rec, p.tf); if (!s) return NA(`no ${p.tf} data`);
      const dirOk = p.dir === 'any' || !p.dir || (p.dir === 'up' ? s.chg20 > 0 : s.chg20 < 0);
      return { ok: Math.abs(s.chg20) >= p.minAbsPct && dirOk,
               detail: `${s.chg20 > 0 ? '+' : ''}${s.chg20}% over 20 bars` };
    },
  },
  oneSided: {
    label: 'One-sided bars', group: 'Movement', kind: 'state',
    help: 'How lopsided the last 20 bars have been between up and down closes.',
    params: [
      { k:'tf',     label:'timeframe', type:'select', options:TF_OPTS, def:'H4' },
      { k:'minPct', label:'at or above', type:'number', def:60, min:10, max:100, step:5 },
    ],
    test: (rec, p) => {
      const s = stateOf(rec, p.tf); if (!s) return NA(`no ${p.tf} data`);
      return { ok: s.persistence >= p.minPct, detail: `${s.persistence}% one-sided` };
    },
  },

  spreadBlown: {
    label: 'Spread blown out', group: 'Cost', kind: 'state',
    params: [{ k:'minRatio', label:'at least × normal', type:'number', def:1.8, min:1.1, max:10, step:0.1 }],
    test: (rec, p) => {
      const v = rec.state?.spreadRatio; if (v == null) return NA('no spread feed');
      return { ok: v >= p.minRatio, detail: `spread ×${v} vs normal` };
    },
  },
  spreadNormal: {
    label: 'Spread normal', group: 'Cost', kind: 'state',
    help: 'Use as a cost guard: keep only instruments that are actually cheap to trade.',
    params: [{ k:'maxRatio', label:'at most × normal', type:'number', def:1.3, min:1, max:5, step:0.1 }],
    test: (rec, p) => {
      const v = rec.state?.spreadRatio; if (v == null) return NA('no spread feed');
      return { ok: v <= p.maxRatio, detail: `spread ×${v} vs normal` };
    },
  },

  crowdedLong: {
    label: 'Funds crowded long', group: 'Positioning', kind: 'state',
    help: 'CFTC net non-commercial position high in its own 3-year range. A contrarian reading.',
    params: [{ k:'minPct', label:'at or above percentile', type:'number', def:85, min:50, max:100, step:1 }],
    test: (rec, p) => {
      const v = rec.state?.posnPct;
      if (v == null) return NA(rec.state?.posnWeeks ? `only ${rec.state.posnWeeks}w of COT` : 'no COT report');
      return { ok: v >= p.minPct, detail: `funds ${v}th pct` };
    },
  },
  crowdedShort: {
    label: 'Funds crowded short', group: 'Positioning', kind: 'state',
    params: [{ k:'maxPct', label:'at or below percentile', type:'number', def:15, min:0, max:50, step:1 }],
    test: (rec, p) => {
      const v = rec.state?.posnPct;
      if (v == null) return NA(rec.state?.posnWeeks ? `only ${rec.state.posnWeeks}w of COT` : 'no COT report');
      return { ok: v <= p.maxPct, detail: `funds ${v}th pct` };
    },
  },
};

export const CONDITION_GROUPS = [...new Set(Object.values(CONDITIONS).map(c => c.group))];

export function defaultParams(key) {
  const c = CONDITIONS[key]; if (!c) return {};
  return Object.fromEntries(c.params.map(p => [p.k, p.def]));
}

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

// ── Evaluation ────────────────────────────────────────────────────────────────
export function evaluateOne(rec, filter) {
  const results = (filter.conditions || []).map(c => {
    const def = CONDITIONS[c.key];
    if (!def) return { key:c.key, label:c.key, ok:null, detail:'unknown condition' };
    const params = { ...defaultParams(c.key), ...(c.params || {}) };
    let r; try { r = def.test(rec, params); } catch (e) { r = { ok:null, detail:e.message }; }
    return { key:c.key, label:def.label, kind:def.kind, params, ...r };
  });

  const passed  = results.filter(r => r.ok === true);
  const failed  = results.filter(r => r.ok === false);
  const unknown = results.filter(r => r.ok === null);

  const matched = filter.mode === 'any'
    ? passed.length >= (filter.minMatch || 1)
    : results.length > 0 && failed.length === 0 && unknown.length === 0;

  return { results, passed, failed, unknown, matched };
}

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

  for (const inst of INSTRUMENTS) {
    if (scope && !scope.has(inst.cls)) continue;
    const rec = recs[inst.sym];
    if (!rec) { noData++; continue; }
    considered++;
    const ev = evaluateOne(rec, filter);
    if (!ev.matched) {
      if (ev.failed.length === 0 && ev.unknown.length > 0) {
        blocked.push({ sym: inst.sym, keys: ev.unknown.map(u => u.label), why: ev.unknown[0].detail });
      }
      continue;
    }

    // Newest passing event first, so the list reads as "what happened, when"
    const events = ev.passed.filter(r => r.event).map(r => r.event).sort((a, b) => b.at - a.at);
    rows.push({
      sym: inst.sym, name: inst.name, cls: inst.cls, dec: inst.dec,
      price: rec.price, rec, ...ev, newestAt: events[0]?.at || null, events,
    });
  }

  rows.sort((a, b) => (b.newestAt || 0) - (a.newestAt || 0) || b.passed.length - a.passed.length);
  return { rows, considered, noData, blocked, total: INSTRUMENTS.length };
}

// How often the event conditions in a filter fire on a given instrument, from
// the instrument's own measured history. A filter that lights up every
// instrument every day is filtering nothing, and this is how you find that out
// before trading it rather than after.
export function rarityFor(rec, filter) {
  const parts = [];
  for (const c of filter.conditions || []) {
    if (CONDITIONS[c.key]?.kind !== 'event') continue;
    const p = { ...defaultParams(c.key), ...(c.params || {}) };
    const r = rec?.rarity?.[`${c.key}.${p.tf}`];
    if (r) parts.push({ key:c.key, tf:p.tf, ...r });
  }
  return parts;
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

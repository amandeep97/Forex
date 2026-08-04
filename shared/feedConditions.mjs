// shared/feedConditions.mjs
// The Live Feed's condition vocabulary — the one copy.
//
// The app (ESM, bundled by Vite) and the VPS bot (CommonJS, Node) both need to
// decide whether an instrument matches a filter. The app decides it to draw the
// list; the bot decides it to send a push while your phone is locked. Two
// implementations of the same rules would drift, and the first symptom would be
// a notification for something the screen does not show.
//
// So this file is ESM and nothing else: no DOM, no localStorage, no fetch, no
// Node APIs. The app imports it directly; the bot loads it with a dynamic
// import(), which works from CommonJS on Node 18+. It lives at the repo root
// because the VPS clones the whole repository, not just vps-bot/.
//
// Everything here is pure: given a published instrument record and a filter, the
// answer is the same on both sides, forever.

// The pattern list comes from the app's own registry rather than a copy, so a
// pattern can never be offered here under a name the Screener does not use.
import { CANDLE_PATTERNS, PATTERN_MAP } from '../src/utils/candlePatterns.js';

// ── Result vocabulary ────────────────────────────────────────────────────────
// A condition returns ok:true (satisfied), ok:false (measured, not satisfied),
// or ok:null (not measurable for this instrument).
//
// The third case is the one that matters. Treating "we never measured it" as
// "it is false" is how a screen quietly excludes every crypto pair from a filter
// that mentions positioning, with nothing on screen to say so.
const NA = why => ({ ok: null, detail: why });

const stateOf = (rec, tf) => rec?.state?.[tf] || null;

function eventHit(rec, type, p) {
  if (!rec?.asOf?.[p.tf]) return NA(`no ${p.tf} data`);
  const cutoff = Date.now() - (p.withinH || 48) * 3600e3;
  const hits = (rec.events || []).filter(e =>
    e.type === type && e.tf === p.tf && e.at >= cutoff &&
    (p.dir === 'any' || !p.dir || e.dir === p.dir));
  if (!hits.length) return { ok: false, detail: `no ${p.tf} ${type} in ${p.withinH}h` };
  const h = hits.reduce((a, b) => (b.at > a.at ? b : a));
  return { ok: true, event: h, detail: `${p.tf} ${h.dir === 'up' ? '▲' : '▼'} ${h.detail}`, at: h.at };
}

const TF_OPTS  = [{ v:'H4', label:'H4' }, { v:'D', label:'Daily' }];
const DIR_OPTS = [{ v:'any', label:'either way' }, { v:'up', label:'bullish only' }, { v:'down', label:'bearish only' }];

// The sweep detector is the SAME function the Screener's ⚡ STRONG CANDLE row
// uses, so it must use the Screener's words. Calling the identical thing
// "bullish only" here and "🔨 Hammer" there made it unfindable: the option was
// present the whole time and looked absent.
const SWEEP_DIR_OPTS = [
  { v:'any',  label:'any sweep' },
  { v:'up',   label:'🔨 Hammer (bullish)' },
  { v:'down', label:'⭐ Shooting Star (bearish)' },
];

const PATTERN_OPTS = [
  { v:'any', label:'any pattern' },
  ...CANDLE_PATTERNS.map(p => ({
    v: p.id,
    label: `${p.type === 'bullish' ? '▲' : p.type === 'bearish' ? '▼' : '·'} ${p.name}`,
  })),
];

export const CONDITIONS = {
  candlePattern: {
    label: 'Candlestick pattern', group: 'Event', kind: 'event',
    help: 'The Screener’s candlestick library, checked on every closed bar around the clock. Watch the ×/month figure — a Doji prints constantly, a Morning Star almost never, and the same threshold means very different things for each.',
    params: [
      { k:'tf',      label:'timeframe', type:'select', options:TF_OPTS, def:'H4' },
      { k:'pattern', label:'pattern',   type:'select', options:PATTERN_OPTS, def:'any' },
      { k:'withinH', label:'within (hours)', type:'number', def:24, min:4, max:720, step:4 },
    ],
    test: (rec, p) => {
      const list = rec?.patterns?.[p.tf];
      if (!list) return NA(`no ${p.tf} pattern data`);
      const cutoff = Date.now() - (p.withinH || 24) * 3600e3;
      const hits = list.filter(x => x.at >= cutoff && (p.pattern === 'any' || x.id === p.pattern));
      if (!hits.length) {
        const want = p.pattern === 'any' ? 'pattern' : (PATTERN_MAP[p.pattern]?.name || p.pattern);
        return { ok: false, detail: `no ${p.tf} ${want} in ${p.withinH}h` };
      }
      const h = hits.reduce((a, b) => (b.at > a.at ? b : a));
      const meta = PATTERN_MAP[h.id];
      return {
        ok: true,
        event: { type:'pattern', id:h.id, tf:p.tf, at:h.at, dir: meta?.type === 'bullish' ? 'up' : meta?.type === 'bearish' ? 'down' : null },
        at: h.at,
        detail: `${p.tf} ${meta?.name || h.id}${h.rate != null ? ` · ~${h.rate}/month here` : ''}`,
      };
    },
  },
  sweep: {
    label: 'Strong candle / sweep', group: 'Event', kind: 'event',
    help: 'The Screener’s ⚡ STRONG CANDLE, running 24/7. Wick clears the entire prior 5-bar high or low and the body closes back inside — 🔨 Hammer is the bullish one, ⭐ Shooting Star the bearish.',
    params: [
      { k:'tf',      label:'timeframe', type:'select', options:TF_OPTS, def:'H4' },
      { k:'dir',     label:'pattern', type:'select', options:SWEEP_DIR_OPTS, def:'any' },
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
      const ok = s.volPct <= p.maxPct;
      return { ok, detail: ok ? `volatility ${s.volPct}th pct`
                              : `volatility ${s.volPct}th — above the ${p.maxPct}th needed` };
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
      const ok = s.volPct >= p.minPct;
      return { ok, detail: ok ? `volatility ${s.volPct}th pct`
                              : `volatility ${s.volPct}th — below the ${p.minPct}th needed` };
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
      const ok = s.rangePos >= p.minPct;
      // A failing chip has to read as a refutation. "At bottom of range · 96%
      // up the 60-bar range" was technically true and looked like a bug.
      return { ok, detail: ok ? `${s.rangePos}% up the 60-bar range`
                              : `${s.rangePos}% up — not within ${100 - p.minPct}% of the high` };
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
      const ok = s.rangePos <= p.maxPct;
      return { ok, detail: ok ? `${s.rangePos}% up the 60-bar range`
                              : `${s.rangePos}% up — not within ${p.maxPct}% of the low` };
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
      const ok = Math.abs(s.chg20) >= p.minAbsPct && dirOk;
      const shown = `${s.chg20 > 0 ? '+' : ''}${s.chg20}%`;
      return { ok, detail: ok ? `${shown} over 20 bars`
                              : !dirOk ? `${shown} — moving the other way`
                                       : `${shown} — smaller than the ${p.minAbsPct}% needed` };
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
      const ok = s.persistence >= p.minPct;
      return { ok, detail: ok ? `${s.persistence}% one-sided`
                              : `${s.persistence}% one-sided — below the ${p.minPct}% needed` };
    },
  },

  spreadBlown: {
    label: 'Spread blown out', group: 'Cost', kind: 'state',
    params: [{ k:'minRatio', label:'at least × normal', type:'number', def:1.8, min:1.1, max:10, step:0.1 }],
    test: (rec, p) => {
      const v = rec?.state?.spreadRatio; if (v == null) return NA('no spread feed');
      const ok = v >= p.minRatio;
      return { ok, detail: ok ? `spread ×${v} vs normal`
                              : `spread ×${v} — below the ×${p.minRatio} needed` };
    },
  },
  spreadNormal: {
    label: 'Spread normal', group: 'Cost', kind: 'state',
    help: 'Use as a cost guard: keep only instruments that are actually cheap to trade.',
    params: [{ k:'maxRatio', label:'at most × normal', type:'number', def:1.3, min:1, max:5, step:0.1 }],
    test: (rec, p) => {
      const v = rec?.state?.spreadRatio; if (v == null) return NA('no spread feed');
      const ok = v <= p.maxRatio;
      return { ok, detail: ok ? `spread ×${v} vs normal`
                              : `spread ×${v} — above the ×${p.maxRatio} allowed` };
    },
  },

  crowdedLong: {
    label: 'Funds crowded long', group: 'Positioning', kind: 'state',
    help: 'CFTC net non-commercial position high in its own 3-year range. A contrarian reading.',
    params: [{ k:'minPct', label:'at or above percentile', type:'number', def:85, min:50, max:100, step:1 }],
    test: (rec, p) => {
      const v = rec?.state?.posnPct;
      if (v == null) return NA(rec?.state?.posnWeeks ? `only ${rec.state.posnWeeks}w of COT` : 'no COT report');
      const ok = v >= p.minPct;
      // "Funds crowded long · funds 11th pct" as a FAILING chip read as though
      // it had passed. A refutation has to refute.
      return { ok, detail: ok ? `funds ${v}th pct`
                              : `funds ${v}th — not crowded long (needs ${p.minPct}th+)` };
    },
  },
  crowdedShort: {
    label: 'Funds crowded short', group: 'Positioning', kind: 'state',
    params: [{ k:'maxPct', label:'at or below percentile', type:'number', def:15, min:0, max:50, step:1 }],
    test: (rec, p) => {
      const v = rec?.state?.posnPct;
      if (v == null) return NA(rec?.state?.posnWeeks ? `only ${rec.state.posnWeeks}w of COT` : 'no COT report');
      const ok = v <= p.maxPct;
      return { ok, detail: ok ? `funds ${v}th pct`
                              : `funds ${v}th — not crowded short (needs ${p.maxPct}th or less)` };
    },
  },
};

export const CONDITION_GROUPS = [...new Set(Object.values(CONDITIONS).map(c => c.group))];

export function defaultParams(key) {
  const c = CONDITIONS[key];
  if (!c) return {};
  return Object.fromEntries(c.params.map(p => [p.k, p.def]));
}

// ── Filters that can never match ─────────────────────────────────────────────
// Under ALL, "at top of range" and "at bottom of range" cannot both hold, so
// the filter matches nothing — forever, silently, looking exactly like a quiet
// market. Under ANY the pair is fine and one of them simply fails, which is
// only confusing if the failing chip does not explain itself.
const EXCLUSIVE = [
  { a:'rangeTop',    b:'rangeBottom',  tf:true,  clash:(x,y) => x.minPct   > y.maxPct,
    why:'price cannot be near the top and the bottom of the same range' },
  { a:'volExpanding',b:'volCoiled',    tf:true,  clash:(x,y) => x.minPct   > y.maxPct,
    why:'volatility cannot be above and below the same threshold' },
  { a:'spreadBlown', b:'spreadNormal', tf:false, clash:(x,y) => x.minRatio > y.maxRatio,
    why:'the spread cannot be blown out and normal at once' },
  { a:'crowdedLong', b:'crowdedShort', tf:false, clash:(x,y) => x.minPct   > y.maxPct,
    why:'funds cannot be crowded long and short at once' },
];

export function contradictions(filter) {
  if (filter?.mode !== 'all') return [];
  const byKey = {};
  for (const c of filter.conditions || []) byKey[c.key] = { ...defaultParams(c.key), ...(c.params || {}) };
  const out = [];
  for (const e of EXCLUSIVE) {
    const x = byKey[e.a], y = byKey[e.b];
    if (!x || !y) continue;
    if (e.tf && x.tf !== y.tf) continue;          // different timeframes can differ
    if (e.clash(x, y)) {
      out.push({
        a: CONDITIONS[e.a].label, b: CONDITIONS[e.b].label,
        why: e.why + (e.tf ? ` on ${x.tf}` : ''),
      });
    }
  }
  return out;
}

// ── Evaluation ───────────────────────────────────────────────────────────────
// mode 'all' — every condition must hold, and an unmeasurable one can never hold
// mode 'any' — at least `minMatch` of them, and unmeasurable ones simply abstain
export function evaluateOne(rec, filter) {
  const results = (filter?.conditions || []).map(c => {
    const def = CONDITIONS[c.key];
    if (!def) return { key:c.key, label:c.key, ok:null, detail:'unknown condition' };
    const params = { ...defaultParams(c.key), ...(c.params || {}) };
    let r;
    try { r = def.test(rec, params); } catch (e) { r = { ok:null, detail:e.message }; }
    return { key:c.key, label:def.label, kind:def.kind, params, ...r };
  });

  const passed  = results.filter(r => r.ok === true);
  const failed  = results.filter(r => r.ok === false);
  const unknown = results.filter(r => r.ok === null);

  const matched = filter?.mode === 'any'
    ? passed.length >= (filter.minMatch || 1)
    : results.length > 0 && failed.length === 0 && unknown.length === 0;

  return { results, passed, failed, unknown, matched };
}

// How often the event conditions in a filter fire on a given instrument, from
// that instrument's own measured history. A filter that lights up everything
// every day is filtering nothing, and this is how you find out before trading
// it rather than after.
export function rarityFor(rec, filter) {
  const parts = [];
  for (const c of filter?.conditions || []) {
    if (CONDITIONS[c.key]?.kind !== 'event') continue;
    const p = { ...defaultParams(c.key), ...(c.params || {}) };
    const r = rec?.rarity?.[`${c.key}.${p.tf}`];
    if (r) parts.push({ key:c.key, tf:p.tf, ...r });
  }
  return parts;
}

// A stable description of WHY an instrument matched, used to decide whether a
// push is new information. Two identical matches minutes apart are the same
// fact; the same instrument matching on a different event is not.
export function matchKey(sym, filterId, ev) {
  const evs = ev.passed
    .map(p => (p.event ? `${p.key}@${p.event.at}` : p.key))
    .sort()
    .join('|');
  return `${filterId}:${sym}:${evs}`;
}

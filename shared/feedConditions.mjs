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
      const v = rec?.state?.spreadRatio; if (v == null) return NA('no spread feed');
      return { ok: v >= p.minRatio, detail: `spread ×${v} vs normal` };
    },
  },
  spreadNormal: {
    label: 'Spread normal', group: 'Cost', kind: 'state',
    help: 'Use as a cost guard: keep only instruments that are actually cheap to trade.',
    params: [{ k:'maxRatio', label:'at most × normal', type:'number', def:1.3, min:1, max:5, step:0.1 }],
    test: (rec, p) => {
      const v = rec?.state?.spreadRatio; if (v == null) return NA('no spread feed');
      return { ok: v <= p.maxRatio, detail: `spread ×${v} vs normal` };
    },
  },

  crowdedLong: {
    label: 'Funds crowded long', group: 'Positioning', kind: 'state',
    help: 'CFTC net non-commercial position high in its own 3-year range. A contrarian reading.',
    params: [{ k:'minPct', label:'at or above percentile', type:'number', def:85, min:50, max:100, step:1 }],
    test: (rec, p) => {
      const v = rec?.state?.posnPct;
      if (v == null) return NA(rec?.state?.posnWeeks ? `only ${rec.state.posnWeeks}w of COT` : 'no COT report');
      return { ok: v >= p.minPct, detail: `funds ${v}th pct` };
    },
  },
  crowdedShort: {
    label: 'Funds crowded short', group: 'Positioning', kind: 'state',
    params: [{ k:'maxPct', label:'at or below percentile', type:'number', def:15, min:0, max:50, step:1 }],
    test: (rec, p) => {
      const v = rec?.state?.posnPct;
      if (v == null) return NA(rec?.state?.posnWeeks ? `only ${rec.state.posnWeeks}w of COT` : 'no COT report');
      return { ok: v <= p.maxPct, detail: `funds ${v}th pct` };
    },
  },
};

export const CONDITION_GROUPS = [...new Set(Object.values(CONDITIONS).map(c => c.group))];

export function defaultParams(key) {
  const c = CONDITIONS[key];
  if (!c) return {};
  return Object.fromEntries(c.params.map(p => [p.k, p.def]));
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

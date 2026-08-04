// src/utils/macroDrivers.js
// The fundamental leg: what an instrument is actually tracking in the macro
// data the repo already collects every day.
//
// public/macro-data.json has been fetched on a schedule for a long time and
// consumed only by three dashboards. It holds the things that genuinely move
// this instrument set — the 10-year REAL yield above all, which is the single
// largest macro driver of gold, plus breakeven inflation, the nominal curve,
// the policy rate and VIX.
//
// As with price drivers, nothing here is assumed. Every series is correlated
// against the instrument's own daily closes and only what clears a noise floor
// is shown. If gold has stopped tracking real yields — and it does, for months
// at a time — this says so instead of repeating a relationship from a textbook.
import { get } from './marketCache';

const MACRO_URL = 'https://raw.githubusercontent.com/amandeep97/Forex/main/public/macro-data.json';

// label + which direction is worth spelling out, because "yields up" reads
// clearly and "DGS10 up" does not.
export const MACRO_SERIES = {
  dfii10:   { label: '10y real yield',      unit: '%',  note: 'inflation-adjusted — gold’s biggest macro driver' },
  dgs10:    { label: '10y Treasury yield',  unit: '%' },
  dgs2:     { label: '2y Treasury yield',   unit: '%',  note: 'the policy-expectations end of the curve' },
  t10yie:   { label: 'inflation expected',  unit: '%',  note: '10y breakeven' },
  vix:      { label: 'VIX',                 unit: '',   note: 'equity fear gauge' },
  fedfunds: { label: 'Fed funds',           unit: '%' },
  cpi:      { label: 'CPI',                 unit: '',   note: 'monthly — too slow to correlate daily' },
  pmi:      { label: 'PMI',                 unit: '',   note: 'monthly — too slow to correlate daily' },
};

// Monthly series cannot be correlated against daily closes over a 40-day
// window; there would be one or two observations. Shown as context, never as a
// measured relationship.
const DAILY_SERIES = ['dfii10', 'dgs10', 'dgs2', 't10yie', 'vix', 'fedfunds'];

export async function fetchMacro({ force = false } = {}) {
  const r = await get('news', 'macro', async () => {
    const res = await fetch(`${MACRO_URL}?t=${Date.now()}`, {
      cache: 'no-store', signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`macro ${res.status}`);
    return res.json();
  }, { force, params: 'macro-data' });
  return r.value;
}

const iso = ms => new Date(ms).toISOString().slice(0, 10);

function pearson(x, y) {
  const n = x.length;
  if (n < 12) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Daily closes keyed by their REAL date.
//
// Markets close at weekends, so bar i is not `from + i days` — deriving dates
// that way drifts two days every week and quietly destroys any correlation
// against dated data. The feed publishes the true day offsets; without them
// this returns null and the panel says it lacks data, which is the only honest
// option. Guessing produced a confident -0.05 for gold against real yields.
function instrumentByDate(rec) {
  const sp = rec?.spark?.D;
  if (!sp?.c?.length || !sp.from || !Array.isArray(sp.d) || sp.d.length !== sp.c.length) return null;
  const out = new Map();
  for (let i = 0; i < sp.c.length; i++) out.set(iso(sp.from + sp.d[i] * 86400e3), sp.c[i]);
  return out;
}

export function macroDriversFor(sym, feed, macro) {
  const rec = feed?.instruments?.[sym];
  const byDate = instrumentByDate(rec);
  if (!byDate || !macro) {
    return { drivers: [], context: [], n: 0,
      pending: !!rec && !rec.spark?.D?.d };   // feed predates dated sparklines
  }

  const out = [];
  for (const key of DAILY_SERIES) {
    const series = macro[key];
    if (!Array.isArray(series) || series.length < 15) continue;

    // Pair up on shared dates, then correlate CHANGES rather than levels — two
    // series that both drift upward all year correlate at 0.9 while telling you
    // nothing about how one responds to the other.
    const pairs = [];
    for (const pt of series) {
      const px = byDate.get(pt.date);
      if (px != null && Number.isFinite(pt.val)) pairs.push([pt.date, px, pt.val]);
    }
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (pairs.length < 15) continue;

    const dPx = [], dMx = [];
    for (let i = 1; i < pairs.length; i++) {
      const p0 = pairs[i - 1][1], p1 = pairs[i][1];
      if (!(p0 > 0) || !(p1 > 0)) continue;
      dPx.push(Math.log(p1 / p0));
      dMx.push(pairs[i][2] - pairs[i - 1][2]);
    }
    const r = pearson(dPx, dMx);
    if (r == null) continue;

    const last = pairs[pairs.length - 1], first = pairs[0];
    out.push({
      key, ...MACRO_SERIES[key],
      r: +r.toFixed(2), n: dPx.length,
      level: last[2],
      change: +(last[2] - first[2]).toFixed(2),
      days: pairs.length,
    });
  }

  const n = out.length ? Math.max(...out.map(o => o.n)) : 0;
  const floor = n ? 2 / Math.sqrt(n) : 1;

  return {
    n, floor: +floor.toFixed(2),
    tested: out.length,
    drivers: out.filter(d => Math.abs(d.r) >= floor).sort((a, b) => Math.abs(b.r) - Math.abs(a.r)),
    // Below the floor but still worth seeing as a level — "real yields are at
    // 1.85% and gold is ignoring them" is information too.
    context: out.filter(d => Math.abs(d.r) < floor),
  };
}

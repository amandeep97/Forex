// shared/leadershipMath.mjs
// Lead–lag measurement. Pure maths, no I/O, so the VPS can run it over the full
// history and the app can render the result without a second implementation.
//
// The distinction this exists to make: correlation at lag zero says two things
// MOVE TOGETHER. Leadership says one moves FIRST. They are not the same
// question and the second is the one with value in it — knowing gold tracks the
// dollar is common knowledge, knowing the dollar turns a day earlier is not.
//
// This is also the single easiest place in the whole app to manufacture a false
// discovery. Searching every instrument at every lag and keeping the best is
// how you find a "leader" for everything. Three constraints hold it honest:
//
//   1. The significance threshold is widened for the number of lags searched,
//      properly — z at alpha/m, not a hand-waved multiplier.
//   2. A lead must beat that same pair's lag-0 correlation by a clear margin,
//      or it is a coincident relationship with a spurious tilt.
//   3. Sample size is reported everywhere. At 40 bars nothing here is
//      detectable; the honest answer at that size is "not enough data", and
//      saying so is the point.

export const LAGS = [1, 2, 3];

// Inverse normal CDF (Acklam), because the correction below needs quantiles at
// alpha values far into the tail where a small lookup table runs out.
function probit(p) {
  if (p <= 0 || p >= 1) return NaN;
  const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];
  const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];
  const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];
  const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];
  const pl=0.02425;
  if (p < pl) { const q=Math.sqrt(-2*Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 1-pl) { const q=Math.sqrt(-2*Math.log(1-p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  const q=p-0.5, r=q*q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

// The threshold |r| must clear, corrected for EVERY test performed.
//
// Correcting for the lags alone was not enough and a test caught it: each
// target is compared against every other instrument, so the real count is
// lags x candidates — 153 for this registry, not 3. At 153 tries a spurious
// 0.13 clears a 0.12 threshold as a matter of routine, and an unrelated random
// series duly acquired a "leader". With the full correction the same series
// gets none.
export function noiseFloor(n, tests = LAGS.length) {
  if (!(n > 3)) return 1;
  const alpha = 0.05 / Math.max(1, tests);
  return Math.abs(probit(alpha / 2)) / Math.sqrt(n);
}

export function logReturns(c) {
  if (!Array.isArray(c) || c.length < 20) return null;
  const r = [];
  for (let i = 1; i < c.length; i++) {
    if (!(c[i] > 0) || !(c[i - 1] > 0)) return null;
    r.push(Math.log(c[i] / c[i - 1]));
  }
  return r;
}

export function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 20) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += x[i]; mb += y[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = x[i] - ma, db = y[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  if (!saa || !sbb) return null;
  return sab / Math.sqrt(saa * sbb);
}

// r between the candidate at t-lag and the target at t.
export function corrAtLag(candidate, target, lag) {
  if (lag === 0) return pearson(candidate, target);
  return pearson(candidate.slice(0, candidate.length - lag), target.slice(lag));
}

// seriesBySym: { SYM: number[] of closes }
// Returns { [sym]: { n, floor, leaders:[...] } }
export function computeLeadership(seriesBySym, { top = 5, minEdge = 1.2 } = {}) {
  const rets = {};
  for (const [sym, closes] of Object.entries(seriesBySym)) {
    const r = logReturns(closes);
    if (r) rets[sym] = r;
  }
  const syms = Object.keys(rets);
  const out = {};

  // Every candidate at every lag, for every target, is a test — and the whole
  // map is published at once, so the family is the map, not one row of it.
  //
  // Correcting per target looked right and was measurably too loose: on twelve
  // unrelated random walks it produced about half a false leader per run, which
  // over 52 instruments means a spurious "X leads Y" on most refreshes. Since
  // the entire purpose here is to avoid manufacturing leadership out of noise,
  // the correction covers the full family.
  const tests = Math.max(1, syms.length * (syms.length - 1) * LAGS.length);

  for (const target of syms) {
    const t = rets[target];
    const n = t.length;
    const floor = noiseFloor(n, tests);
    const found = [];

    for (const cand of syms) {
      if (cand === target) continue;
      const c = rets[cand];
      const r0 = corrAtLag(c, t, 0);
      if (r0 == null) continue;

      let best = null;
      for (const lag of LAGS) {
        const r = corrAtLag(c, t, lag);
        if (r == null) continue;
        if (!best || Math.abs(r) > Math.abs(best.r)) best = { lag, r };
      }
      if (!best) continue;

      // A lead has to be materially stronger than the same-day reading — by a
      // ratio AND by an absolute margin. The ratio alone is vacuous when the
      // same-day correlation is near zero: 0.13 beats 0.02 by any multiple you
      // like while meaning nothing.
      if (Math.abs(best.r) < Math.abs(r0) * minEdge) continue;
      if (Math.abs(best.r) - Math.abs(r0) < floor / 2) continue;
      if (Math.abs(best.r) < floor) continue;

      found.push({ sym: cand, lag: best.lag, r: +best.r.toFixed(2), r0: +r0.toFixed(2) });
    }

    out[target] = {
      n, floor: +floor.toFixed(3), tests,
      leaders: found.sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, top),
    };
  }
  return out;
}

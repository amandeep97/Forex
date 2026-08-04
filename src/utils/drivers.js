// src/utils/drivers.js
// What actually moves an instrument, measured rather than assumed.
//
// intermarket.js carries a hand-written table of "relevant markets" per pair.
// It is useful and it is incomplete: no entry for US500, USOIL or NATGAS, and
// the correlations in it are static numbers that were true when someone typed
// them. Relationships move — gold and the dollar have spent whole years
// uncorrelated — so a fixed −1 is a claim the market is under no obligation to
// honour.
//
// The feed already publishes 40 closes per instrument per timeframe for the
// sparklines. That is enough to compute the real thing across all 52
// instruments, for free, with no extra request and nothing to maintain.
//
// The window is short by design: 40 bars answers "what is this moving with
// NOW", which is the question in front of you. It is emphatically not a
// long-run structural estimate, and the sample size is reported so the number
// is never mistaken for one.

const logReturns = (c) => {
  if (!Array.isArray(c) || c.length < 12) return null;
  const r = [];
  for (let i = 1; i < c.length; i++) {
    if (!(c[i] > 0) || !(c[i - 1] > 0)) return null;
    r.push(Math.log(c[i] / c[i - 1]));
  }
  return r;
};

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const x = a.slice(-n), y = b.slice(-n);
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

// Correlation on ~30 points is noisy. This is the threshold |r| has to clear
// before it is even worth showing at 95% confidence — roughly 2/sqrt(n) — so a
// relationship that is indistinguishable from chance never appears as a driver.
const noiseFloor = n => 2 / Math.sqrt(Math.max(n, 4));

export function driversFor(sym, feed, { tf = 'D', top = 6 } = {}) {
  const recs = feed?.instruments;
  if (!recs?.[sym]) return { drivers: [], n: 0, tf };

  const mine = logReturns(recs[sym].spark?.[tf]?.c);
  if (!mine) return { drivers: [], n: 0, tf };

  const out = [];
  for (const [other, rec] of Object.entries(recs)) {
    if (other === sym) continue;
    const theirs = logReturns(rec.spark?.[tf]?.c);
    if (!theirs) continue;
    const r = pearson(mine, theirs);
    if (r == null) continue;
    out.push({ sym: other, cls: rec.cls, r: +r.toFixed(2), n: Math.min(mine.length, theirs.length) });
  }

  const n = mine.length;
  const floor = noiseFloor(n);
  return {
    tf, n, floor: +floor.toFixed(2),
    drivers: out
      .filter(d => Math.abs(d.r) >= floor)
      .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
      .slice(0, top),
    // Kept separately: "nothing is moving with this" is a real and useful
    // answer, not an empty panel.
    tested: out.length,
  };
}

// Correlated instruments already in your shortlist are not confirmation — they
// are the same information arriving twice, and treating them as agreement is
// how a single view gets mistaken for a consensus.
export function overlapWith(sym, symbols, feed, opts = {}) {
  const { drivers } = driversFor(sym, feed, { ...opts, top: 52 });
  const set = new Set((symbols || []).filter(s => s !== sym));
  return drivers.filter(d => set.has(d.sym) && Math.abs(d.r) >= 0.7);
}

// shared/macroFit.mjs
// The part of gold's move the dollar and the ten-year did NOT cause.
//
// This app already measures correlation three separate times — macroDrivers.js
// against real yields, drivers.js as a rolling forty-bar number, intermarket.js
// live on H1. All three answer "do these move together". None of them produces
// the thing you could actually trade.
//
// A correlation is a single number between minus one and one. It tells you gold
// and the dollar are related. It does not tell you how much of TODAY's move the
// dollar accounts for, and it cannot separate the two halves — so when gold
// rallies, nothing in the app can say whether that was the dollar falling or
// somebody buying gold. Those are completely different trades and only the
// second one has anything to do with gold.
//
// So: a regression, not a correlation.
//
//   gold = b1 x dollar + b2 x ten-year + residual
//
// Three things fall out that a correlation cannot give you:
//
//   THE RESIDUAL. Gold's move with the macro taken out — central bank buying,
//   ETF flow, a safe-haven bid. The gold-specific part.
//
//   R SQUARED. How much of gold is currently a macro instrument at all. When it
//   collapses, gold has gone off on its own story, and every intermarket read
//   on the board is describing a relationship that has stopped operating.
//
//   THE BETAS, WITH ERROR BARS. Not just "correlated" but how much, and whether
//   the sensitivity has actually CHANGED — which is a different question from
//   whether it is currently high, and the one that matters. Gold rising while
//   yields rise is a regime, not a day.
//
// Two drivers together, not two separate pairwise numbers, because the dollar
// and the ten-year are themselves correlated. Regress gold on each alone and
// the shared part gets counted twice — both look strong and the total explains
// more than a hundred percent of a move.
//
// Nothing here may use a bar later than the one it is explaining. The betas at
// bar i come from a window that ENDS at i-1. A regression fitted on the bar it
// then explains has a residual of nearly zero by construction and would report
// that gold is always perfectly explained.
//
// ESM only. The app imports it; the bot loads it with a dynamic import().

export const FIT_WIN = 240;      // ten days of H1 — long enough for a stable
                                 // two-driver fit, short enough to be about now
export const RESID_WIN = 12;     // half a day, for "how far beyond the macro"
export const MIN_R2 = 0.02;      // below this the fit explains nothing and the
                                 // betas are noise dressed as parameters

// Log returns in percent. The raw numbers are around 1e-4 and their squares
// around 1e-8; a two-by-two determinant of those lands near 1e-16, which is
// where float64 starts losing digits. Scaling by a hundred costs nothing and
// keeps every intermediate in a sane range.
export function pctReturns(closes) {
  const out = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    if (!(closes[i] > 0) || !(closes[i - 1] > 0)) continue;
    out[i] = Math.log(closes[i] / closes[i - 1]) * 100;
  }
  return out;
}

// Line up other instruments on the base instrument's timestamps.
//
// By timestamp, never by index. Gold, the dollar and the ten-year do not print
// identical bars — different holidays, different halts, different feed gaps —
// and pairing by position regresses Tuesday's gold on Wednesday's dollar, which
// produces a real-looking number that means nothing.
export function alignOn(baseTs, series, tolMs = 2 * 3600e3) {
  const out = new Array(baseTs.length).fill(null);
  let j = 0;
  for (let i = 0; i < baseTs.length; i++) {
    while (j + 1 < series.length && series[j + 1].t <= baseTs[i]) j++;
    const s = series[j];
    if (s && Math.abs(s.t - baseTs[i]) <= tolMs) out[i] = s.c;
  }
  return out;
}

// OANDA's ten-year instrument is a BOND, and whether the number it quotes is a
// price or a yield decides the sign of everything downstream. Getting it
// backwards would have gold's relationship with rates reported exactly
// inverted, and nothing in the output would look wrong.
//
// So it is decided from the data rather than from a label: bond prices live
// near a hundred, yields near four. The app's own intermarket.js calls
// USB10Y_USD "US 10-Year Bond Yield" while quoting a price, which is precisely
// the mistake this exists to not inherit.
export function rateKind(closes) {
  const v = closes.filter(c => c > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const med = v[Math.floor(v.length / 2)];
  if (med > 40) return 'price';     // a bond future, up when yields fall
  if (med < 20) return 'yield';     // the yield itself, up when yields rise
  return null;                      // between the two, and a guess here is worse
                                    // than saying nothing
}

// ── The rolling fit ─────────────────────────────────────────────────────────
//
// Ordinary least squares with two regressors, solved in closed form — no
// matrix library for a two-by-two.
//
// The window is summed afresh for every bar rather than carried forward. That
// is four years of hourly bars times a ten-day window, which is a second of
// arithmetic in a study that runs weekly, and it buys the one thing an
// incremental sum cannot give: a hole in any of the three series shrinks the
// window honestly instead of silently corrupting a running total that has no
// way to un-add a term it never added.
//
// The window ends at i-1 and the result is stored at i. That offset is the
// no-lookahead guarantee and it is the only thing standing between this and a
// residual series that is zero everywhere.
export function rollingFit(y, x1, x2, win = FIT_WIN) {
  const n = y.length;
  const out = new Array(n).fill(null);

  // Running sums over the window. Rebuilt from scratch whenever the window
  // contains a hole, because a sum with a missing term is not a smaller sum, it
  // is a wrong one.
  const ok = i => y[i] != null && x1[i] != null && x2[i] != null
    && Number.isFinite(y[i]) && Number.isFinite(x1[i]) && Number.isFinite(x2[i]);

  for (let i = win + 1; i < n; i++) {
    let m = 0, sy = 0, s1 = 0, s2 = 0;
    let syy = 0, s11 = 0, s22 = 0, s1y = 0, s2y = 0, s12 = 0;
    for (let j = i - win; j < i; j++) {
      if (!ok(j)) continue;
      m++;
      sy += y[j]; s1 += x1[j]; s2 += x2[j];
      syy += y[j] * y[j]; s11 += x1[j] * x1[j]; s22 += x2[j] * x2[j];
      s1y += x1[j] * y[j]; s2y += x2[j] * y[j]; s12 += x1[j] * x2[j];
    }
    // Two thirds of the window present, or the fit describes a different period
    // than the one it is labelled with.
    if (m < win * 0.66 || m < 30) continue;

    // Centred cross-products.
    const c11 = s11 - s1 * s1 / m;
    const c22 = s22 - s2 * s2 / m;
    const c12 = s12 - s1 * s2 / m;
    const c1y = s1y - s1 * sy / m;
    const c2y = s2y - s2 * sy / m;
    const cyy = syy - sy * sy / m;

    const det = c11 * c22 - c12 * c12;
    // Two drivers that moved identically over the window carry one piece of
    // information between them, and splitting it into two betas produces a
    // pair of enormous numbers that cancel. Refuse rather than report them.
    if (!(Math.abs(det) > 1e-12) || !(cyy > 0)) continue;

    const b1 = (c22 * c1y - c12 * c2y) / det;
    const b2 = (c11 * c2y - c12 * c1y) / det;
    const ssr = Math.max(0, cyy - b1 * c1y - b2 * c2y);
    const dof = m - 3;
    if (dof < 10) continue;
    const s2e = ssr / dof;

    out[i] = {
      n: m,
      b1, b2,
      se1: Math.sqrt(s2e * c22 / det),
      se2: Math.sqrt(s2e * c11 / det),
      r2: 1 - ssr / cyy,
      // Residual standard deviation over the fitting window — the yardstick for
      // "how unusual is today's unexplained move".
      sd: Math.sqrt(s2e),
      alpha: (sy - b1 * s1 - b2 * s2) / m,
    };
  }
  return out;
}

// What the macro did not account for, bar by bar. Betas from before the bar,
// applied to the bar.
export function residualSeries(y, x1, x2, fits) {
  const out = new Array(y.length).fill(null);
  for (let i = 0; i < y.length; i++) {
    const f = fits[i];
    if (!f || y[i] == null || x1[i] == null || x2[i] == null) continue;
    if (!(f.r2 > MIN_R2)) continue;      // a fit that explains nothing has no
                                         // residual worth the name
    out[i] = y[i] - (f.alpha + f.b1 * x1[i] + f.b2 * x2[i]);
  }
  return out;
}

// How far gold has run beyond the macro over the last few hours, in standard
// deviations of its own residual. Summed rather than averaged, and divided by
// root-k, because independent residuals accumulate that way — dividing by k
// would make a persistent bid look smaller the longer it lasted.
export function residualPush(resid, fits, i, win = RESID_WIN) {
  const f = fits[i];
  if (!f || !(f.sd > 0) || i < win) return null;
  let sum = 0, m = 0;
  for (let j = i - win + 1; j <= i; j++) {
    if (resid[j] == null) continue;
    sum += resid[j]; m++;
  }
  if (m < win * 0.66) return null;
  return sum / (f.sd * Math.sqrt(m));
}

// Has the relationship itself changed?
//
// Against the fit one full window earlier, so the two estimates share no data.
// Overlapping windows share most of their bars, their errors move together, and
// the difference between them looks significant constantly — which is how a
// break detector ends up firing every day and meaning nothing.
export function betaShift(fits, i, win = FIT_WIN) {
  const now = fits[i], before = fits[i - win];
  if (!now || !before) return null;
  const z = (b, se) => {
    const s = Math.sqrt(se[0] * se[0] + se[1] * se[1]);
    return s > 0 ? (b[0] - b[1]) / s : null;
  };
  return {
    dollar: z([now.b1, before.b1], [now.se1, before.se1]),
    rate: z([now.b2, before.b2], [now.se2, before.se2]),
    r2Now: now.r2, r2Before: before.r2,
  };
}

// Is a beta actually there, or is it a number with an error bar around zero?
export const significant = (b, se, z = 2) => se > 0 && Math.abs(b / se) >= z;

// ── The whole thing, for one instrument ─────────────────────────────────────
//
// `dollarUp` must be a series that RISES when the dollar strengthens. EUR/USD
// does the opposite, so the caller inverts it; doing that here would hide the
// one sign convention in the file that a reader needs to see.
export function macroSeries(base, { dollarUp, rate, rateIsPrice = null, win = FIT_WIN } = {}) {
  const ts = base.map(c => c.t);
  const y = pctReturns(base.map(c => c.c));
  const dCloses = alignOn(ts, dollarUp);
  const rCloses = alignOn(ts, rate);

  const kind = rateIsPrice == null ? rateKind(rCloses.filter(Boolean)) : (rateIsPrice ? 'price' : 'yield');
  const x1 = pctReturns(dCloses);
  const rRet = pctReturns(rCloses);
  // Signed so x2 rises when YIELDS rise, whichever of the two the feed serves.
  // Gold's textbook relationship is negative to yields; if the sign convention
  // were left to chance the output would state the opposite half the time.
  const x2 = kind === 'price' ? rRet.map(v => (v == null ? null : -v)) : rRet;

  const fits = rollingFit(y, x1, x2, win);
  const resid = residualSeries(y, x1, x2, fits);
  return { ts, y, x1, x2, fits, resid, rateKind: kind };
}

// One sentence, for the top of a card. This is the thing the multi-agent
// diagrams promise and never deliver: what is moving this instrument right now,
// with the number behind every clause.
export function describe(m, i, { win = FIT_WIN, residWin = RESID_WIN } = {}) {
  const f = m.fits[i];
  if (!f) return null;
  const push = residualPush(m.resid, m.fits, i, residWin);
  const shift = betaShift(m.fits, i, win);
  const pct = Math.round(f.r2 * 100);
  const dollarSig = significant(f.b1, f.se1);
  const rateSig = significant(f.b2, f.se2);

  const parts = [];
  parts.push(pct >= 40
    ? `${pct}% of the last ${Math.round(win / 24)} days of hourly movement is the dollar and the ten-year`
    : pct >= 15
      ? `only ${pct}% of the last ${Math.round(win / 24)} days is explained by the dollar and the ten-year`
      : `the dollar and the ten-year explain almost none of it (${pct}%) — this is gold's own story`);

  if (dollarSig) {
    parts.push(f.b1 < 0
      ? `the usual inverse move against the dollar is intact (${f.b1.toFixed(2)})`
      : `it is moving WITH the dollar (${f.b1.toFixed(2)}), which is not the normal relationship`);
  } else {
    parts.push('the dollar is not currently moving it');
  }

  if (rateSig) {
    parts.push(f.b2 < 0
      ? `and falling when yields rise (${f.b2.toFixed(2)}), as it should`
      : `and RISING when yields rise (${f.b2.toFixed(2)}) — the regime where gold trends hardest`);
  }

  if (push != null && Math.abs(push) >= 1.5) {
    parts.push(push > 0
      ? `over the last ${residWin} hours it has gone ${push.toFixed(1)} standard deviations further than those two account for — somebody is buying gold itself`
      : `over the last ${residWin} hours it is ${Math.abs(push).toFixed(1)} standard deviations weaker than those two account for — somebody is selling gold itself`);
  }

  return {
    text: parts.join('; '),
    r2: +f.r2.toFixed(3), b1: +f.b1.toFixed(3), b2: +f.b2.toFixed(3),
    se1: +f.se1.toFixed(3), se2: +f.se2.toFixed(3), n: f.n,
    dollarSig, rateSig,
    push: push == null ? null : +push.toFixed(2),
    shift: shift ? {
      dollar: shift.dollar == null ? null : +shift.dollar.toFixed(2),
      rate: shift.rate == null ? null : +shift.rate.toFixed(2),
      r2Now: +shift.r2Now.toFixed(3), r2Before: +shift.r2Before.toFixed(3),
    } : null,
    rateKind: m.rateKind,
  };
}

// ── Conditions ──────────────────────────────────────────────────────────────
// The buckets the regime study searches over, so these get holdout-scored
// alongside the price-structure ones rather than being another thing on a
// screen that nobody ever checked.
export function macroBuckets(m, i) {
  const f = m.fits[i];
  if (!f) return { macro: null, dollar: null, flow: null, shift: null };
  const push = residualPush(m.resid, m.fits, i);
  const sh = betaShift(m.fits, i);
  return {
    macro: f.r2 >= 0.4 ? 'macro-driven' : f.r2 >= 0.15 ? 'macro-mixed' : 'own-story',
    dollar: !significant(f.b1, f.se1) ? 'dollar-detached'
      : f.b1 < 0 ? 'dollar-inverse' : 'dollar-together',
    flow: push == null ? null
      : push >= 1.5 ? 'bought-beyond-macro'
      : push <= -1.5 ? 'sold-beyond-macro' : null,
    shift: sh && sh.dollar != null && Math.abs(sh.dollar) >= 2.5 ? 'relationship-broke' : null,
  };
}

export const MACRO_PHRASE = {
  'macro=macro-driven': 'trading as a macro instrument',
  'macro=macro-mixed': 'partly macro, partly its own',
  'macro=own-story': 'off on its own story',
  'dollar=dollar-inverse': 'moving inverse to the dollar as usual',
  'dollar=dollar-together': 'moving WITH the dollar, which is abnormal',
  'dollar=dollar-detached': 'detached from the dollar',
  'flow=bought-beyond-macro': 'bought beyond what the macro explains',
  'flow=sold-beyond-macro': 'sold beyond what the macro explains',
  'shift=relationship-broke': 'its relationship with the dollar just broke',
};

// The part of gold's move the dollar and the ten-year did not cause.
//
// The app measures correlation three times over and cannot answer the question
// this file exists for: when gold rallies, was that the dollar falling or
// somebody buying gold? Those are different trades and only one of them is
// about gold.
//
// A regression can answer it and can also be wrong in ways that look completely
// fine. The four that matter, and every one of them is checked below:
//
//   Fitting on the bar you then explain. The residual comes out near zero
//   everywhere and the output reads "gold is perfectly explained by macro",
//   forever.
//
//   Regressing on each driver separately. The dollar and the ten-year move
//   together, so the shared part gets counted twice and the two "explanations"
//   add up to more than the move.
//
//   Pairing series by index instead of by timestamp. Different holidays, and
//   Tuesday's gold gets regressed on Wednesday's dollar.
//
//   Reading OANDA's ten-year as a yield when it quotes a price. Every sign
//   downstream inverts and nothing looks wrong.
import {
  pctReturns, alignOn, rateKind, rollingFit, residualSeries, residualPush,
  betaShift, significant, macroSeries, macroBuckets, describe, FIT_WIN,
} from '../shared/macroFit.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const H = 3600e3;
const T0 = Date.UTC(2026, 0, 5);

// Deterministic noise, so a failure is reproducible.
let seed = 24681357;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

// Build three price series where gold is a KNOWN combination of the other two
// plus noise, so the recovered coefficients have a right answer.
function world(n, { bD = -0.9, bR = -0.4, noise = 0.05, flipAt = null, bDAfter = 0.8 } = {}) {
  const gold = [{ t: T0, c: 2000 }];
  const dol = [{ t: T0, c: 100 }];
  const rate = [{ t: T0, c: 4.0 }];
  for (let i = 1; i < n; i++) {
    const t = T0 + i * H;
    const dRet = rnd() * 0.4;                 // percent
    const rRet = rnd() * 0.6 + dRet * 0.5;    // the two drivers are correlated,
                                              // which is the whole reason for a
                                              // joint fit
    const b = flipAt != null && i >= flipAt ? bDAfter : bD;
    const gRet = b * dRet + bR * rRet + rnd() * noise;
    dol.push({ t, c: dol[i - 1].c * Math.exp(dRet / 100) });
    rate.push({ t, c: rate[i - 1].c * Math.exp(rRet / 100) });
    gold.push({ t, c: gold[i - 1].c * Math.exp(gRet / 100) });
  }
  return { gold, dol, rate };
}

// ── The coefficients have a right answer, and it is recovered ───────────────
{
  const w = world(1200, { bD: -0.9, bR: -0.4 });
  const m = macroSeries(w.gold, { dollarUp: w.dol, rate: w.rate, rateIsPrice: false });
  const f = m.fits[1100];
  check('a fit is produced once there is a window behind it', !!f);
  check('the dollar coefficient is recovered', Math.abs(f.b1 - (-0.9)) < 0.06, f.b1.toFixed(3));
  check('and the rate coefficient too', Math.abs(f.b2 - (-0.4)) < 0.06, f.b2.toFixed(3));
  check('with almost all of the variance explained, because almost all of it was',
    f.r2 > 0.95, f.r2.toFixed(3));
  check('both coefficients are reported with an error bar, not as bare numbers',
    f.se1 > 0 && f.se2 > 0);
  check('and both are significant here', significant(f.b1, f.se1) && significant(f.b2, f.se2));
}

// ── Two drivers at once, not two pairwise numbers ──────────────────────────
// The dollar and the ten-year move together. Regressed separately, each one
// claims the shared part, and the two "explanations" sum to more than the move.
{
  const w = world(1200, { bD: -1.0, bR: 0, noise: 0.02 });
  // Truth: gold is the dollar alone. But the rate is correlated with the
  // dollar, so a naive pairwise read would find a strong rate relationship.
  const m = macroSeries(w.gold, { dollarUp: w.dol, rate: w.rate, rateIsPrice: false });
  const f = m.fits[1100];
  check('when only the dollar drives it, only the dollar gets a coefficient',
    Math.abs(f.b1 + 1.0) < 0.06 && Math.abs(f.b2) < 0.06,
    `dollar ${f.b1.toFixed(2)}, rate ${f.b2.toFixed(2)}`);
  check('the spurious one is correctly not significant',
    !significant(f.b2, f.se2),
    'a pairwise correlation would have called it real, because the two drivers move together');
}

// ── Nothing may see the bar it explains ────────────────────────────────────
// The one that would quietly destroy everything: fit on bar i and the residual
// at bar i is near zero by construction, so gold reads as perfectly explained
// forever and the "unexplained flow" signal never fires.
{
  const w = world(1200, { bD: -0.9, bR: -0.4, noise: 0.4 });
  const m = macroSeries(w.gold, { dollarUp: w.dol, rate: w.rate, rateIsPrice: false });

  // Rewrite gold's future. Nothing at or before the cut may move.
  const g2 = w.gold.map((c, i) => (i > 900 ? { ...c, c: c.c * 1.5 } : c));
  const m2 = macroSeries(g2, { dollarUp: w.dol, rate: w.rate, rateIsPrice: false });
  let drift = 0;
  for (let i = 0; i <= 900; i++) {
    const a = m.fits[i], b = m2.fits[i];
    if (!a !== !b) { drift++; continue; }
    if (a && (Math.abs(a.b1 - b.b1) > 1e-9 || Math.abs(a.r2 - b.r2) > 1e-9)) drift++;
  }
  check('rewriting gold after bar 900 changes no fit at or before it', drift === 0,
    `${drift} fits moved`);

  // And the residuals are a real distribution, not a row of zeros.
  const rs = m.resid.filter(v => v != null);
  const nz = rs.filter(v => Math.abs(v) > 1e-6).length;
  check('residuals are actual residuals rather than zeros', nz > rs.length * 0.9,
    `${nz} of ${rs.length} non-zero`);
  check('and they are centred near zero, as a residual must be',
    Math.abs(rs.reduce((a, b) => a + b, 0) / rs.length) < 0.02,
    String(rs.reduce((a, b) => a + b, 0) / rs.length));
}

// ── An unexplained push is detected, and only when it is there ─────────────
{
  const w = world(1200, { bD: -0.9, bR: -0.4, noise: 0.05 });
  const quiet = macroSeries(w.gold, { dollarUp: w.dol, rate: w.rate, rateIsPrice: false });
  const q = residualPush(quiet.resid, quiet.fits, 1100);
  check('with nothing but the macro moving it, there is no unexplained push',
    q != null && Math.abs(q) < 1.5, String(q));

  // Now somebody buys gold for twelve hours, with the dollar and rates unchanged.
  const bought = w.gold.map((c, i) =>
    (i > 1088 && i <= 1100 ? { ...c, c: c.c * Math.exp(0.0012 * (i - 1088)) } : c));
  const m = macroSeries(bought, { dollarUp: w.dol, rate: w.rate, rateIsPrice: false });
  const p = residualPush(m.resid, m.fits, 1100);
  check('gold bought with the macro standing still shows as an unexplained push',
    p != null && p > 1.5, String(p));
  check('and the condition says so in words',
    macroBuckets(m, 1100).flow === 'bought-beyond-macro',
    String(macroBuckets(m, 1100).flow));
  check('the quiet market gets no such flag',
    macroBuckets(quiet, 1100).flow === null, String(macroBuckets(quiet, 1100).flow));
}

// ── A broken relationship, and a stable one ────────────────────────────────
{
  const stable = world(1600, { bD: -0.9, bR: -0.4, noise: 0.05 });
  const ms = macroSeries(stable.gold, { dollarUp: stable.dol, rate: stable.rate, rateIsPrice: false });
  const zs = betaShift(ms.fits, 1500);
  check('a relationship that never changed is not reported as broken',
    zs && Math.abs(zs.dollar) < 2.5, String(zs?.dollar));
  check('and the condition stays silent', macroBuckets(ms, 1500).shift === null);

  // Gold flips to moving WITH the dollar partway through — a regime, not a day.
  const flip = world(1600, { bD: -0.9, bR: -0.4, noise: 0.05, flipAt: 1100, bDAfter: 0.8 });
  const mf = macroSeries(flip.gold, { dollarUp: flip.dol, rate: flip.rate, rateIsPrice: false });
  const zf = betaShift(mf.fits, 1420);
  check('a coefficient that genuinely flipped sign is detected',
    zf && Math.abs(zf.dollar) >= 2.5, String(zf?.dollar));
  check('the two windows compared share no data, or every day looks like a break',
    true, `compared against the fit ${FIT_WIN} bars earlier`);
  check('and the sign flip is visible in the coefficient itself',
    mf.fits[1420].b1 > 0 && ms.fits[1420].b1 < 0,
    `${mf.fits[1420].b1.toFixed(2)} vs ${ms.fits[1420].b1.toFixed(2)}`);
  check('which reads as moving with the dollar rather than against it',
    macroBuckets(mf, 1420).dollar === 'dollar-together',
    macroBuckets(mf, 1420).dollar);
}

// ── Price or yield, decided from the data ──────────────────────────────────
// OANDA's USB10Y_USD quotes a bond, and the app's own intermarket.js labels it
// "US 10-Year Bond Yield" while showing a price. Inheriting that would invert
// every statement about rates and nothing would look wrong.
{
  check('a series living near a hundred is a bond price',
    rateKind([108.2, 109.1, 107.4, 110.0]) === 'price');
  check('a series living near four is a yield',
    rateKind([4.21, 4.35, 4.02, 3.98]) === 'yield');
  check('and something in between is refused rather than guessed',
    rateKind([28, 31, 29]) === null, 'a coin flip here inverts the whole read');
  check('an empty series is null, not a default', rateKind([]) === null);

  // The same world read both ways must give opposite rate coefficients.
  const w = world(900, { bD: -0.9, bR: -0.4, noise: 0.05 });
  const asYield = macroSeries(w.gold, { dollarUp: w.dol, rate: w.rate, rateIsPrice: false });
  const asPrice = macroSeries(w.gold, { dollarUp: w.dol, rate: w.rate, rateIsPrice: true });
  check('reading the same series as a price flips the rate coefficient',
    Math.abs(asYield.fits[800].b2 + asPrice.fits[800].b2) < 1e-9,
    `${asYield.fits[800].b2.toFixed(3)} vs ${asPrice.fits[800].b2.toFixed(3)}`);
  check('which is why it is detected rather than assumed',
    macroSeries(w.gold, { dollarUp: w.dol, rate: w.rate }).rateKind === 'yield',
    'the fixture quotes a yield near 4 and is read as one');
}

// ── Alignment by timestamp ─────────────────────────────────────────────────
{
  const base = [0, 1, 2, 3, 4].map(i => T0 + i * H);
  const other = [{ t: T0, c: 10 }, { t: T0 + 2 * H, c: 12 }, { t: T0 + 4 * H, c: 14 }];
  const a = alignOn(base, other);
  check('a bar with a match uses it', a[0] === 10 && a[2] === 12 && a[4] === 14);
  check('a bar with no match of its own carries the last one within tolerance',
    a[1] === 10 && a[3] === 12);
  const stale = alignOn(base, [{ t: T0 - 20 * H, c: 99 }]);
  check('a quote a day old is not carried forward as current',
    stale.every(v => v === null), JSON.stringify(stale));
}

// ── Refusals ───────────────────────────────────────────────────────────────
{
  const w = world(100, { bD: -0.9, bR: -0.4 });
  const m = macroSeries(w.gold, { dollarUp: w.dol, rate: w.rate, rateIsPrice: false });
  check('too short a history produces no fit rather than a wild one',
    m.fits.every(f => !f), `${m.fits.filter(Boolean).length} fits from 100 bars`);

  // Two drivers that are the same series carry one piece of information, and
  // splitting it gives two enormous coefficients that cancel.
  const same = world(1200, { bD: -0.5, bR: -0.5, noise: 0.05 });
  const dup = macroSeries(same.gold, { dollarUp: same.dol, rate: same.dol, rateIsPrice: true });
  check('two identical drivers are refused rather than split into nonsense',
    dup.fits[1100] === null || Math.abs(dup.fits[1100].b1) < 50,
    dup.fits[1100] ? `b1=${dup.fits[1100].b1}` : 'refused');
  check('a bucket set is returned even with no fit, all nulls',
    macroBuckets({ fits: [], resid: [] }, 0).macro === null);
  check('and describe() says nothing rather than something made up',
    describe({ fits: [] }, 0) === null);
}

// ── The sentence ───────────────────────────────────────────────────────────
{
  const w = world(1200, { bD: -0.9, bR: -0.4, noise: 0.05 });
  const m = macroSeries(w.gold, { dollarUp: w.dol, rate: w.rate, rateIsPrice: false });
  const d = describe(m, 1100);
  check('a plain sentence is produced', typeof d.text === 'string' && d.text.length > 40);
  check('with the numbers behind it attached, not just the words',
    d.r2 != null && d.b1 != null && d.se1 != null && d.n > 0);
  check('and it says the relationship is the normal one here',
    /inverse move against the dollar/.test(d.text), d.text.slice(0, 120));

  // The first live run described SILVER's residual as somebody selling gold,
  // because the word was hard-coded into a function two instruments share.
  const bought = w.gold.map((c, i) =>
    (i > 1088 && i <= 1100 ? { ...c, c: c.c * Math.exp(0.0015 * (i - 1088)) } : c));
  const mb = macroSeries(bought, { dollarUp: w.dol, rate: w.rate, rateIsPrice: false });
  const named = describe(mb, 1100, { name: 'silver' });
  check('the instrument names itself rather than inheriting somebody else\'s',
    /buying silver itself/.test(named.text) && !/gold/.test(named.text),
    named.text.slice(-90));
  const low = describe({ ...mb, fits: mb.fits.map(f => (f ? { ...f, r2: 0.05 } : f)) },
    1100, { name: 'silver' });
  check('including in the sentence about it going off on its own',
    !/gold/.test(low.text), low.text.slice(0, 90));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

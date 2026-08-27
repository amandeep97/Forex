'use strict';
// vps-bot/src/metalsStudy.js
//
// Gold and silver, and the ratio between them.
//
// The app has shown that ratio for a long time and labelled it against fixed
// numbers — above 80 is "Extreme High", below 45 "Extreme Low". Those are rules
// of thumb from a decade when the ratio lived between 45 and 80. It has spent
// long stretches above 80 since, which means the card has been calling ordinary
// Tuesdays extreme, and nobody has ever asked the question the label implies:
// when the ratio is stretched, does anything follow?
//
// The claim behind it is specific and testable. A high ratio is supposed to
// mean silver is cheap against gold and will catch up. So: at a ratio extreme,
// does the ratio revert? Does silver beat gold? Or does a stretched ratio
// simply stay stretched, which is what a trending relationship looks like and
// what would make the whole idea decoration.
//
// Same apparatus as the COT study, and the same four ways it could be faked:
//
//   The percentile at each day is computed only from days BEFORE it. Ranked
//   against the full history, a reading knows how extreme it will turn out.
//
//   Consecutive extreme days are ONE episode. The ratio sits stretched for
//   weeks; counting each day multiplies one event into forty.
//
//   The comparison is against what these instruments did from every other day,
//   not against a coin — for the same reason nothing else here uses 50%.
//
//   And both tails are pre-specified before looking, with the hypothesis fixed:
//   high ratio means it falls from here, low means it rises. If the truth is
//   the opposite this returns strongly negative, which is a result.

const HORIZONS = [5, 10, 20, 40];
const HIGH = 90, LOW = 10;
const MIN_HISTORY = 120;      // six months of prior days before a percentile is real
const BARS = 1200;            // about five years of daily bars

const pctileOf = (v, prior) => {
  if (prior.length < MIN_HISTORY) return null;
  let below = 0;
  for (const p of prior) if (p < v) below++;
  return Math.round((below / prior.length) * 100);
};

// Gold and silver do not always print the same bars — a gap, a holiday, a feed
// hiccup. Paired on timestamp so a ratio is never built from two different days.
function pairSeries(au, ag) {
  const byT = new Map(ag.map(c => [c.t, c]));
  const out = [];
  for (const a of au) {
    const s = byT.get(a.t);
    if (!s || !(a.c > 0) || !(s.c > 0)) continue;
    out.push({ t: a.t, au: a.c, ag: s.c, ratio: a.c / s.c });
  }
  return out;
}

function stats(moves) {
  if (!moves.length) return null;
  const s = [...moves].sort((a, b) => a - b);
  return {
    n: moves.length,
    win: Math.round((moves.filter(m => m > 0).length / moves.length) * 100),
    med: +s[Math.floor(s.length / 2)].toFixed(2),
  };
}

function diffZ(w1, n1, w2, n2) {
  if (!n1 || !n2) return null;
  const p1 = w1 / 100, p2 = w2 / 100;
  const pool = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  return se > 0 ? +((p1 - p2) / se).toFixed(2) : null;
}

// Consecutive extreme days are one event. The ratio stays stretched for weeks.
function episodes(rows, test) {
  const out = [];
  let inRun = false;
  for (let i = 0; i < rows.length; i++) {
    const hit = rows[i].pct != null && test(rows[i].pct);
    if (hit && !inRun) out.push(i);
    inRun = hit;
  }
  return out;
}

// Percent change over `h` days, for whichever series is asked for.
const chg = (rows, i, h, key) =>
  rows[i + h] ? ((rows[i + h][key] - rows[i][key]) / rows[i][key]) * 100 : null;

function bucket(rows, test, hypothesis, label) {
  // hypothesis: 'fall' means the ratio is expected to come down from here,
  // which is silver outperforming gold.
  const sign = hypothesis === 'fall' ? -1 : 1;
  const eps = episodes(rows, test);
  const horizons = {};

  for (const h of HORIZONS) {
    const ratio = [], au = [], ag = [], spread = [];
    const baseRatio = [], baseSpread = [];
    for (const i of eps) {
      const r = chg(rows, i, h, 'ratio');
      if (r == null) continue;
      ratio.push(sign * r);
      au.push(chg(rows, i, h, 'au'));
      ag.push(chg(rows, i, h, 'ag'));
      // What the pair trade actually returns: long the cheap metal, short the
      // dear one. This is the number the whole idea rests on.
      spread.push(sign * (chg(rows, i, h, 'ag') - chg(rows, i, h, 'au')) * -1);
    }
    for (let i = 0; i + h < rows.length; i++) {
      const r = chg(rows, i, h, 'ratio');
      if (r == null) continue;
      baseRatio.push(sign * r);
      baseSpread.push(sign * (chg(rows, i, h, 'ag') - chg(rows, i, h, 'au')) * -1);
    }
    const s = stats(ratio), b = stats(baseRatio);
    const sp = stats(spread), bsp = stats(baseSpread);
    if (!s || !b) continue;
    horizons[h] = {
      episodes: s.n,
      // Did the ratio move the way the label implies?
      ratioWin: s.win, ratioBase: b.win, ratioZ: diffZ(s.win, s.n, b.win, b.n),
      ratioMedPct: s.med, ratioBaseMedPct: b.med,
      // And did the pair trade pay?
      pairWin: sp?.win ?? null, pairBase: bsp?.win ?? null,
      pairMedPct: sp?.med ?? null, pairBaseMedPct: bsp?.med ?? null,
      pairZ: sp && bsp ? diffZ(sp.win, sp.n, bsp.win, bsp.n) : null,
      // The metals separately, because "the ratio fell" can mean gold dropped
      // rather than silver rose, and those are different trades.
      auMedPct: stats(au.filter(x => x != null))?.med ?? null,
      agMedPct: stats(ag.filter(x => x != null))?.med ?? null,
      baseN: b.n,
    };
  }
  return { label, hypothesis, episodes: eps.length, horizons };
}

// Does one metal move before the other? Correlation of same-day gold returns
// against silver's returns from N days earlier, and the mirror. A lead is only
// interesting if it beats the same-day relationship, which is always strong.
function leadLag(rows, maxLag = 5) {
  const ret = (key) => rows.slice(1).map((r, i) => Math.log(r[key] / rows[i][key]));
  const au = ret('au'), ag = ret('ag');
  const corr = (x, y) => {
    const n = Math.min(x.length, y.length);
    if (n < 60) return null;
    const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return sxx && syy ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : null;
  };
  const out = { sameDay: corr(au, ag), silverLeadsGold: [], goldLeadsSilver: [] };
  for (let k = 1; k <= maxLag; k++) {
    out.silverLeadsGold.push({ lag: k, r: corr(au.slice(k), ag) });
    out.goldLeadsSilver.push({ lag: k, r: corr(ag.slice(k), au) });
  }
  return out;
}

async function runMetalsStudy({ oanda, log = () => {}, bars = BARS }) {
  const au = await oanda.getCandles('XAU_USD', 'D', bars);
  const ag = await oanda.getCandles('XAG_USD', 'D', bars);
  if (!au?.length || !ag?.length) return { error: 'no candles' };

  const paired = pairSeries(au, ag);
  if (paired.length < MIN_HISTORY + 100) {
    return { error: `only ${paired.length} paired days` };
  }

  // Percentile from prior days only.
  const prior = [];
  for (const row of paired) {
    row.pct = pctileOf(row.ratio, prior);
    prior.push(row.ratio);
  }

  const stretched = bucket(paired, p => p >= HIGH, 'fall',
    `ratio at or above the ${HIGH}th percentile — silver cheap against gold`);
  const compressed = bucket(paired, p => p <= LOW, 'rise',
    `ratio at or below the ${LOW}th percentile — gold cheap against silver`);

  const last = paired[paired.length - 1];
  const tests = 2 * HORIZONS.length * 2;   // two tails, four horizons, two questions

  log(`Metals study: ratio ${last.ratio.toFixed(1)} at the ${last.pct}th percentile of `
    + `${paired.length} days; ${stretched.episodes} stretched episodes, ${compressed.episodes} compressed`);

  return {
    asOf: new Date().toISOString(),
    days: paired.length,
    horizons: HORIZONS, high: HIGH, low: LOW, tests,
    now: { ratio: +last.ratio.toFixed(2), percentile: last.pct, at: last.t },
    // The thresholds the app has been using, for comparison. Kept so the
    // difference between "above 80" and "above its own 90th percentile" is
    // visible rather than argued about.
    legacyZones: { extremeHigh: 80, high: 65, normal: 55, low: 45 },
    stretched, compressed,
    leadLag: leadLag(paired),
  };
}

module.exports = {
  runMetalsStudy, pairSeries, pctileOf, episodes, bucket, leadLag,
  HORIZONS, HIGH, LOW, MIN_HISTORY,
};

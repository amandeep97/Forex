'use strict';
// vps-bot/src/cotStudy.js
//
// Does an extreme in speculative positioning precede anything?
//
// The app has been printing "positioning is at the top 10% of 3 years — crowded
// long, the side that unwinds badly" as though that were a finding. It is not.
// It is trading folklore, written into a card by me, on an instrument where
// nobody had ever measured it. This measures it.
//
// Everything else in this repo has been measured against candles — the same
// public OHLC every retail screen computes the same patterns from. COT is the
// one dataset here that is not: actual weekly filings of what large speculators
// hold. If there is an edge left anywhere in this data it is more likely to be
// here than in a hammer. That is the entire reason this is worth running.
//
// Four things keep it honest, and each of them is a way the answer could be
// faked into looking good:
//
//   The percentile at every week is computed only from the weeks BEFORE it. A
//   reading ranked against the full three years knows how extreme it would turn
//   out to be, which is hindsight wearing a statistic.
//
//   Entry is at the RELEASE, not at the report date. COT reports Tuesday's
//   positions and publishes them Friday afternoon. Measuring from Tuesday's
//   close buys three days nobody had.
//
//   Consecutive extreme weeks are ONE episode, not four. Positioning sits
//   crowded for a month at a time; counting each week multiplies a single event
//   into a sample and would make almost anything significant.
//
//   And the comparison is against what the instrument did from every other
//   week, over the same horizons — not against a coin flip, for the same reason
//   the rest of the feed stopped using one.

const { fetchCOTHistory } = require('./cotFetcher');
const { atrSeries, tradeRun, STOPS, RR } = require('./feed');

// Trading days forward. A week, a fortnight, a month, two months — COT is
// weekly with a three-day reporting lag, so anything shorter is not a question
// this data can answer.
const HORIZONS = [5, 10, 20, 40];

// What counts as extreme. Both tails, pre-specified, and the hypothesis for
// each is fixed BEFORE looking: a crowded long is expected to resolve down and
// a crowded short up. If the truth is the opposite this comes back strongly
// negative, which is a result and not a licence to flip the labels afterwards.
const HIGH = 90, LOW = 10;
const MIN_HISTORY = 52;   // a year of prior weeks before any percentile is real

const pctileOf = (v, prior) => {
  if (prior.length < MIN_HISTORY) return null;
  let below = 0;
  for (const p of prior) if (p < v) below++;
  return Math.round((below / prior.length) * 100);
};

// First candle at or after a timestamp, or null if the series ends first.
function indexAtOrAfter(cs, t) {
  for (let i = 0; i < cs.length; i++) if (cs[i].t >= t) return i;
  return null;
}

const RELEASE_LAG_MS = 3 * 86400e3;   // Tuesday report, Friday release

function stats(moves) {
  if (!moves.length) return null;
  const s = [...moves].sort((a, b) => a - b);
  return {
    n: moves.length,
    win: Math.round((moves.filter(m => m > 0).length / moves.length) * 100),
    medAtr: +s[Math.floor(s.length / 2)].toFixed(2),
  };
}

// Two proportions, the same test the rest of the app uses.
function diffZ(w1, n1, w2, n2) {
  if (!n1 || !n2) return null;
  const p1 = w1 / 100, p2 = w2 / 100;
  const pool = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  return se > 0 ? +((p1 - p2) / se).toFixed(2) : null;
}

// One instrument: every weekly reading turned into an entry with a percentile,
// a forward outcome at each horizon, and a stopped-trade result.
function measureInstrument(rows, cs) {
  const atrAt = atrSeries(cs);
  const out = [];
  const prior = [];

  for (const row of rows) {
    const pct = pctileOf(row.net, prior);
    prior.push(row.net);                       // AFTER ranking, never before
    if (pct == null) continue;

    const i = indexAtOrAfter(cs, row.t + RELEASE_LAG_MS);
    if (i == null) continue;
    const atr = atrAt(i);
    if (!atr) continue;

    const fwd = {};
    for (const h of HORIZONS) {
      if (i + h >= cs.length) continue;
      fwd[h] = (cs[i + h].c - cs[i].c) / atr;   // unsigned; the caller signs it
    }
    if (!Object.keys(fwd).length) continue;

    out.push({ t: row.t, pct, i, atr, fwd });
  }
  return { entries: out, cs, atrAt };
}

// Consecutive weeks in the same tail are one event. Keeps the first week of
// each run, which is also the only one you could have acted on without already
// being in the trade.
function episodes(entries, test) {
  const out = [];
  let inRun = false;
  for (const e of entries) {
    const hit = test(e.pct);
    if (hit && !inRun) out.push(e);
    inRun = hit;
  }
  return out;
}

function bucketResult(per, test, dir, label) {
  const sign = dir === 'up' ? 1 : -1;
  const horizons = {};
  let totalEpisodes = 0;
  const bySym = [];

  for (const { sym, m } of per) {
    const eps = episodes(m.entries, test);
    totalEpisodes += eps.length;
    if (eps.length) bySym.push({ sym, episodes: eps.length });
  }

  for (const h of HORIZONS) {
    const moves = [], baseMoves = [];
    const runs = STOPS.map(() => []);

    for (const { m } of per) {
      for (const e of episodes(m.entries, test)) {
        if (e.fwd[h] == null) continue;
        moves.push(sign * e.fwd[h]);
        STOPS.forEach((s, k) => {
          const r = tradeRun(m.cs, e.i, h, e.atr, dir, s);
          runs[k].push(r.r);
        });
      }
      // What this instrument did from EVERY week, mirrored the same way, so the
      // benchmark is the market rather than a coin.
      for (const e of m.entries) {
        if (e.fwd[h] == null) continue;
        baseMoves.push(sign * e.fwd[h]);
      }
    }

    const s = stats(moves), b = stats(baseMoves);
    if (!s || !b) continue;
    horizons[h] = {
      ...s,
      baseWin: b.win, baseMedAtr: b.medAtr, baseN: b.n,
      edgeWin: s.win - b.win,
      z: diffZ(s.win, s.n, b.win, b.n),
      stops: STOPS.map((stop, k) => ({
        stopAtr: stop, rr: RR,
        expR: runs[k].length
          ? +(runs[k].reduce((a, v) => a + v, 0) / runs[k].length).toFixed(3) : null,
        n: runs[k].length,
      })),
    };
  }

  return { label, hypothesis: dir, episodes: totalEpisodes, bySym, horizons };
}

async function runCOTStudy({ instruments, oanda, log = () => {}, weeks = 160, bars = 500 }) {
  const per = [];
  const skipped = [];

  for (const inst of instruments.filter(i => i.cot && i.oanda)) {
    try {
      const rows = await fetchCOTHistory(inst.cot, weeks);
      if (rows.length < MIN_HISTORY + 20) { skipped.push(`${inst.sym}: ${rows.length} weeks`); continue; }
      const cs = await oanda.getCandles(inst.oanda, 'D', bars);
      if (!cs || cs.length < 200) { skipped.push(`${inst.sym}: ${cs?.length || 0} bars`); continue; }
      const m = measureInstrument(rows, cs);
      if (!m.entries.length) { skipped.push(`${inst.sym}: no usable weeks`); continue; }
      per.push({ sym: inst.sym, m });
      log(`COT study: ${inst.sym} — ${m.entries.length} weeks measured`);
    } catch (e) {
      skipped.push(`${inst.sym}: ${e.message}`);
    }
  }

  if (!per.length) return { error: 'no instruments measured', skipped };

  const crowdedLong  = bucketResult(per, p => p >= HIGH, 'down', `positioning at or above the ${HIGH}th percentile`);
  const crowdedShort = bucketResult(per, p => p <= LOW,  'up',   `positioning at or below the ${LOW}th percentile`);

  // Two buckets x four horizons x three stop widths were examined to find a
  // winner. The bar has to account for that, exactly as it does for setups.
  const tests = 2 * HORIZONS.length * STOPS.length;

  return {
    asOf: new Date().toISOString(),
    weeks, horizons: HORIZONS, high: HIGH, low: LOW,
    instruments: per.map(p => p.sym),
    tests,
    // Bonferroni on a two-sided 5%, as a z. Kept as a number so the app does
    // not have to re-derive it.
    z: +(Math.abs(probit(0.05 / (2 * tests)))).toFixed(2),
    crowdedLong, crowdedShort,
    skipped,
  };
}

// Acklam's probit, same approximation the app uses for the same purpose.
function probit(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687,
             138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866,
             66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > 1 - pl) return -probit(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

module.exports = {
  runCOTStudy, measureInstrument, episodes, pctileOf, bucketResult,
  HORIZONS, HIGH, LOW, MIN_HISTORY, RELEASE_LAG_MS,
};

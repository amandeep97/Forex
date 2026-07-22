// src/utils/backtestGrading.js
// Statistical grading layer on top of the raw backtest.
// Turns a raw win-rate into an honest verdict: is this a real edge over random,
// does it hold out-of-sample, and is it safe to trade live?
//
// Phases:
//   1. Base-rate grading  — win-rate vs a random-entry baseline (×over-random)
//                           + sample-size guard (n) + expectancy in R (headline)
//   2. Selectivity        — fire-rate %, "fires too often" warning, confluence
//   3. Robustness         — 70/30 out-of-sample split, thirds consistency,
//                           Monte-Carlo trade-shuffle (drawdown / risk-of-ruin)
//   4. Verdict bucket     — Proven / Weak / Noise / Insufficient (Phase-4 library
//                           ranks by these)
//   5. Live gate          — strict pass/fail before a setup is "cleared for live"
import { runBacktest, calcStats, computeSignalSeries } from './backtestEngine';

export const MIN_SAMPLE  = 30;   // below this a win-rate is an anecdote, not evidence
export const LIVE_SAMPLE = 50;   // stricter bar for the live gate
const BASELINE_RUNS = 25;        // random-entry Monte-Carlo baseline repetitions
const MC_RUNS       = 500;       // trade-shuffle Monte-Carlo repetitions

// Deterministic seeded PRNG (Math.random is intentionally avoided so grades are
// reproducible — same inputs always give the same verdict).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

// ── segment stats: run the real strategy on a slice of candles ────────────────
function segStats(candles, strategy) {
  const { trades } = runBacktest(candles, strategy);
  const st = calcStats(trades);
  return {
    n: trades.length,
    winRate: st.winRate,
    expR: st.avgRR ?? 0,
    pnlPct: st.totalPnlPct,
  };
}

// ── Phase 1 core: random-entry baseline ───────────────────────────────────────
// Fire on random bars with the same per-bar probability & long/short mix as the
// real setup, run the IDENTICAL exit/risk/spread mechanics, pool all baseline
// trades, and measure how often *random* would have won. That's the "base rate".
function randomBaseline(candles, strategy, signalSeries) {
  const signals = signalSeries.filter(Boolean);
  const nSig = signals.length;
  const evalBars = Math.max(1, candles.length - 10);
  if (nSig === 0) return { winRate: 0, expR: 0, n: 0 };
  const p = Math.min(1, nSig / evalBars);
  const longRatio = signals.filter(x => x === 'long').length / nSig;

  const pool = [];
  for (let k = 0; k < BASELINE_RUNS; k++) {
    const rnd = mulberry32(982451 + k * 7919);
    const fire = new Array(candles.length).fill(null);
    for (let i = 10; i < candles.length; i++) {
      if (rnd() < p) fire[i] = rnd() < longRatio ? 'long' : 'short';
    }
    const { trades } = runBacktest(candles, strategy, { entryOverride: (i) => fire[i] });
    for (const t of trades) pool.push(t);
  }
  const st = calcStats(pool);
  return { winRate: st.winRate, expR: st.avgRR ?? 0, n: pool.length, perRun: Math.round(pool.length / BASELINE_RUNS) };
}

// ── Phase 3: Monte-Carlo trade-shuffle (path / drawdown risk) ─────────────────
// Real edge can still blow an account if the losing streak lands wrong. Shuffle
// the realized R-multiples many times, replay with compounding, and see the
// spread of outcomes: probability of profit, typical & worst drawdown, ruin risk.
function monteCarlo(trades, riskPct) {
  const R = trades.filter(t => t.riskDollars > 0).map(t => t.pnlDollars / t.riskDollars);
  if (R.length < 5) return null;
  const risk = (riskPct || 1) / 100;
  const finals = [], maxDDs = [];
  let ruin = 0;
  for (let k = 0; k < MC_RUNS; k++) {
    const rnd = mulberry32(123457 + k * 2654435761);
    const sh = [...R];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    let eq = 10000, peak = 10000, maxdd = 0;
    for (const r of sh) {
      eq += r * eq * risk;
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? (peak - eq) / peak : 0;
      if (dd > maxdd) maxdd = dd;
    }
    finals.push(eq); maxDDs.push(maxdd);
    if (maxdd >= 0.5) ruin++;
  }
  return {
    profitProb:  finals.filter(f => f > 10000).length / MC_RUNS,
    medianFinal: Math.round(median(finals)),
    medianMaxDD: +(median(maxDDs) * 100).toFixed(1),
    worstMaxDD:  +(percentile(maxDDs, 95) * 100).toFixed(1),
    ruinProb:    +(ruin / MC_RUNS).toFixed(3),
  };
}

// ── Master grader ─────────────────────────────────────────────────────────────
export function gradeStrategy(candles, strategy, baseStats, trades = []) {
  if (!candles || candles.length < 40 || !baseStats || baseStats.totalTrades === 0) return null;

  const n = baseStats.totalTrades;
  const setupWinRate = baseStats.winRate;
  const setupExpR = baseStats.avgRR ?? 0;

  // Phase 2 — selectivity (fire-rate) from identical entry logic
  const signalSeries = computeSignalSeries(candles, strategy);
  const signalCount = signalSeries.filter(Boolean).length;
  const evalBars = Math.max(1, candles.length - 10);
  const fireRate = +(signalCount / evalBars * 100).toFixed(2);
  const frac = signalCount / evalBars;
  const selectivity = frac > 0.15 ? 'too_loose' : (frac < 0.03 ? 'selective' : 'balanced');
  const nConditions = (strategy.conditions || []).length;

  // Phase 1 — base-rate grading
  const base = randomBaseline(candles, strategy, signalSeries);
  const edgeMult = base.winRate > 0
    ? +(setupWinRate / base.winRate).toFixed(2)
    : (setupWinRate > 0 ? 99 : 0);
  const expEdge = +(setupExpR - base.expR).toFixed(3);

  // Verdict bucket (Phase 4 library ranks on this)
  const sufficient = n >= MIN_SAMPLE;
  let verdict;
  if (!sufficient) verdict = 'insufficient';
  else if (setupExpR <= 0) verdict = 'noise';       // bleeds after spread
  else if (edgeMult >= 3 && expEdge > 0) verdict = 'proven';
  else if (edgeMult >= 1.5 && expEdge > 0) verdict = 'weak';
  else verdict = 'noise';

  const VERDICT_META = {
    proven:       { label: 'PROVEN EDGE',      color: '#22c55e', note: '×3+ better than random' },
    weak:         { label: 'REAL BUT WEAK',    color: '#f59e0b', note: '×1.5–3 better than random' },
    noise:        { label: 'NOISE / NO EDGE',  color: '#ef4444', note: 'Not distinguishable from random' },
    insufficient: { label: 'NOT ENOUGH DATA',  color: '#64748b', note: `Only ${n} trades — need ≥${MIN_SAMPLE}` },
  };

  // Phase 3 — robustness
  const split = Math.floor(candles.length * 0.7);
  const inS  = segStats(candles.slice(0, split), strategy);
  const outS = segStats(candles.slice(split), strategy);
  const oosStatus = outS.n < 8 ? 'inconclusive'
    : (outS.expR > 0 && outS.winRate >= inS.winRate * 0.75 ? 'holds' : 'fails');

  const tSize = Math.floor(candles.length / 3);
  const thirds = [
    segStats(candles.slice(0, tSize), strategy),
    segStats(candles.slice(tSize, tSize * 2), strategy),
    segStats(candles.slice(tSize * 2), strategy),
  ];
  const positiveThirds = thirds.filter(t => t.n >= 3 && t.expR > 0).length;
  const gradedThirds = thirds.filter(t => t.n >= 3).length;

  const mc = monteCarlo(trades || [], strategy.riskPct);

  // Phase 5 — live gate (strict)
  const blockers = [];
  if (n < LIVE_SAMPLE) blockers.push(`Only ${n} trades — need ≥${LIVE_SAMPLE} for live confidence`);
  if (setupExpR <= 0) blockers.push('Negative expectancy — loses money after spread');
  if (edgeMult < 3) blockers.push(`Edge only ×${edgeMult} vs random — need ≥×3`);
  if (oosStatus !== 'holds') blockers.push(
    oosStatus === 'inconclusive'
      ? 'Out-of-sample inconclusive — not enough unseen trades'
      : 'Failed out-of-sample — edge did not persist on unseen data');
  if (mc && mc.profitProb < 0.9) blockers.push(`Monte-Carlo profit probability ${Math.round(mc.profitProb * 100)}% — need ≥90%`);
  if (!mc) blockers.push('Too few trades for Monte-Carlo risk check');
  const validated = blockers.length === 0;

  return {
    // Phase 1
    n, sufficient, minSample: MIN_SAMPLE,
    setupWinRate, baseWinRate: base.winRate, baseN: base.n, edgeMult,
    setupExpR: +setupExpR.toFixed(3), baseExpR: +base.expR.toFixed(3), expEdge,
    verdict, ...VERDICT_META[verdict], verdictMeta: VERDICT_META,
    // Phase 2
    fireRate, signalCount, evalBars, selectivity, nConditions,
    // Phase 3
    oos: { in: inS, out: outS, status: oosStatus },
    thirds, positiveThirds, gradedThirds,
    monteCarlo: mc,
    // Phase 5
    blockers, validated, liveSample: LIVE_SAMPLE,
  };
}

// ── Phase 4: validated-edge library (localStorage) ────────────────────────────
const LIB_KEY = 'bt_edge_library_v1';

export function loadLibrary() {
  try { return JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); } catch { return []; }
}
export function saveToLibrary(entry) {
  const lib = loadLibrary();
  // de-dupe by symbol+tf+condition-signature
  const sig = entry.sig;
  const next = [entry, ...lib.filter(e => e.sig !== sig)].slice(0, 50);
  try { localStorage.setItem(LIB_KEY, JSON.stringify(next)); } catch {}
  return next;
}
export function removeFromLibrary(sig) {
  const next = loadLibrary().filter(e => e.sig !== sig);
  try { localStorage.setItem(LIB_KEY, JSON.stringify(next)); } catch {}
  return next;
}
export function condSignature(symbol, tf, conditions) {
  const c = (conditions || []).map(x => `${x.type}:${x.op || x.value || ''}:${x.period || ''}:${x.n || ''}`).join('|');
  return `${symbol}@${tf}#${c}`;
}

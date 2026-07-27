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
export const FWD_MIN_N   = 15;   // forward trades needed before forward test means anything
const MC_RUNS       = 500;       // trade-shuffle Monte-Carlo repetitions

// Baseline repetitions scale down as the dataset grows — a 20k-bar run already
// produces plenty of baseline trades per repetition, so fewer reps give the same
// precision at a fraction of the cost.
function baselineRuns(barCount) {
  return Math.max(6, Math.min(25, Math.round(40000 / Math.max(1, barCount))));
}

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

  const RUNS = baselineRuns(candles.length);
  const pool = [];
  for (let k = 0; k < RUNS; k++) {
    const rnd = mulberry32(982451 + k * 7919);
    const fire = new Array(candles.length).fill(null);
    for (let i = 10; i < candles.length; i++) {
      if (rnd() < p) fire[i] = rnd() < longRatio ? 'long' : 'short';
    }
    const { trades } = runBacktest(candles, strategy, { entryOverride: (i) => fire[i] });
    for (const t of trades) pool.push(t);
  }
  const st = calcStats(pool);
  return { winRate: st.winRate, expR: st.avgRR ?? 0, n: pool.length, perRun: Math.round(pool.length / RUNS) };
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

// ── Forward test: the only validation that cannot be overfit ──────────────────
// When a rule is SEALED we record the timestamp of the newest bar that existed
// at that moment. Every trade after it happened on data that did not exist when
// the rule was written, so it is impossible to have fit the rule to it. No
// daemon required — time does the work, we just re-read history later.
function forwardStats(trades, seal) {
  if (!seal?.sealBarTime) return null;
  const cut = seal.sealBarTime;
  const fwd = trades.filter(t => t.entryTime != null && +t.entryTime > cut);
  const st = calcStats(fwd);
  const daysElapsed = Math.max(0, Math.round((Date.now() - new Date(seal.sealedAt || cut).getTime()) / 86400000));
  const enough = fwd.length >= FWD_MIN_N;
  return {
    sealedAt: seal.sealedAt, sealBarTime: cut, daysElapsed,
    n: fwd.length, enough, minN: FWD_MIN_N,
    winRate: st.winRate, expR: st.avgRR ?? 0, pnlPct: st.totalPnlPct,
    status: !enough ? 'pending' : ((st.avgRR ?? 0) > 0 ? 'holds' : 'fails'),
  };
}

// ── Multiple-testing counter (Phase 2b) ───────────────────────────────────────
// Grading one strategy at ×3 is meaningful. Grading the 47th of 500 at ×3 is
// probably luck. We count DISTINCT strategies graded per dataset and surface the
// expected number of false passes, so the cost of searching is visible instead
// of silently inflating every result.
const SEARCH_KEY = 'bt_search_counts_v1';

function loadSearches() {
  try { return JSON.parse(localStorage.getItem(SEARCH_KEY) || '{}'); } catch { return {}; }
}
export function recordSearch(datasetKey, sig) {
  const all = loadSearches();
  const seen = all[datasetKey] || [];
  if (!seen.includes(sig)) seen.push(sig);
  all[datasetKey] = seen.slice(-500);
  try { localStorage.setItem(SEARCH_KEY, JSON.stringify(all)); } catch {}
  return seen.length;
}
export function resetSearches(datasetKey) {
  const all = loadSearches();
  if (datasetKey) delete all[datasetKey]; else Object.keys(all).forEach(k => delete all[k]);
  try { localStorage.setItem(SEARCH_KEY, JSON.stringify(all)); } catch {}
}
export function datasetKey(symbol, tf, bars) { return `${symbol}@${tf}@${bars}`; }

// Roughly: how many of N tested strategies would clear a ×3 bar by chance alone.
// ~5% of random strategies clear a nominal significance bar; that is the honest
// price of searching, and it grows linearly with how many you try.
function searchRisk(testCount) {
  const expectedFalse = +(testCount * 0.05).toFixed(1);
  const level = testCount <= 5 ? 'low' : testCount <= 20 ? 'moderate' : 'high';
  return { testCount, expectedFalse, level };
}

// ── Master grader ─────────────────────────────────────────────────────────────
export function gradeStrategy(candles, strategy, baseStats, trades = [], opts = {}) {
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

  // Consistency across regimes — the check that makes a big paginated history
  // safe rather than misleading (an edge averaged over two opposite regimes is
  // worth nothing, and only the per-third view exposes that).
  const consistent = gradedThirds >= 2 && positiveThirds === gradedThirds;

  // Forward test — cannot be overfit
  const forward = forwardStats(trades || [], opts.seal);

  // Multiple-testing cost of however many strategies were tried on this data
  const search = searchRisk(opts.testCount || 1);

  // Phase 5 — live gate (strict)
  const blockers = [];
  if (n < LIVE_SAMPLE) blockers.push(`Only ${n} trades — need ≥${LIVE_SAMPLE} for live confidence`);
  if (setupExpR <= 0) blockers.push('Negative expectancy — loses money after spread');
  if (edgeMult < 3) blockers.push(`Edge only ×${edgeMult} vs random — need ≥×3`);
  if (oosStatus !== 'holds') blockers.push(
    oosStatus === 'inconclusive'
      ? 'Out-of-sample inconclusive — not enough unseen trades'
      : 'Failed out-of-sample — edge did not persist on unseen data');
  if (!consistent) blockers.push('Not profitable in every period — edge is regime-dependent, not persistent');
  if (mc && mc.profitProb < 0.9) blockers.push(`Monte-Carlo profit probability ${Math.round(mc.profitProb * 100)}% — need ≥90%`);
  if (!mc) blockers.push('Too few trades for Monte-Carlo risk check');
  // The honest gate: only a forward test proves the rule was not fit to the data.
  if (!forward) blockers.push('Not sealed — seal the rule to start an un-overfittable forward test');
  else if (forward.status === 'pending') blockers.push(`Forward test running — ${forward.n}/${forward.minN} trades after seal (${forward.daysElapsed}d)`);
  else if (forward.status === 'fails') blockers.push('Failed forward test — the edge did not appear on data recorded after the rule was sealed');
  if (search.level === 'high') blockers.push(`${search.testCount} setups tested on this data — expect ~${search.expectedFalse} to pass by luck alone`);
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
    thirds, positiveThirds, gradedThirds, consistent,
    monteCarlo: mc,
    // Forward test + multiple-testing cost
    forward, search,
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
// Seal a rule: freeze "now" so every later bar is provably forward data.
// Stored per signature and independent of the library entry, so a seal survives
// removing/re-saving and can never be quietly restarted to flatter a result.
const SEAL_KEY = 'bt_seals_v1';

export function loadSeals() {
  try { return JSON.parse(localStorage.getItem(SEAL_KEY) || '{}'); } catch { return {}; }
}
export function getSeal(sig) { return loadSeals()[sig] || null; }
export function sealRule(sig, lastBarTime) {
  const all = loadSeals();
  if (all[sig]) return all[sig];         // never re-seal — that would reset the clock
  all[sig] = { sealedAt: new Date().toISOString(), sealBarTime: +lastBarTime || Date.now() };
  try { localStorage.setItem(SEAL_KEY, JSON.stringify(all)); } catch {}
  return all[sig];
}

export function condSignature(symbol, tf, conditions) {
  const c = (conditions || []).map(x => `${x.type}:${x.op || x.value || ''}:${x.period || ''}:${x.n || ''}`).join('|');
  return `${symbol}@${tf}#${c}`;
}

'use strict';
// vps-bot/src/liquidityStudy.js
// Does the sweep model actually pay? Asked of history, not of the future.
//
// The model has been live for days and has produced exactly zero measured
// evidence, because nothing recorded what happened after a hunt. The obvious
// answer — log every hunt and come back in six weeks — is the wrong one. Every
// hunt this model will ever find has already happened thousands of times in
// data OANDA will hand over on request. Waiting is a choice to stay ignorant
// for six weeks when the answer is downloadable today.
//
// So this replays the SAME code over history. Not a re-implementation: it
// imports keyLevels, findSweep and confirmation from shared/liquidity.mjs, the
// modules the live scanner uses. A second implementation would measure a model
// nobody trades.
//
// ── What it is allowed to conclude ──────────────────────────────────────────
//
// Twenty-four cells — six level kinds by four sessions — and a cell is only
// interesting if it beats the instrument's own baseline over the same bars. A
// raw win rate says nothing: if gold rises 60% of the time on two-minute bars,
// a long that wins 60% of the time has found the market, not an edge.
//
// Two holdouts, both borrowed from regimeSearch because the reasoning is the
// same. TIME: the recent stretch is held back from the cell that selects. And
// INSTRUMENTS: half the universe is never looked at during selection, so a cell
// that only works on the instruments it was chosen from is caught. The
// instrument holdout is the one that cannot be fitted.
//
// ── What it deliberately does not do ────────────────────────────────────────
//
// It does not search. There is one hypothesis here — a level taken and given
// back, then a break the other way — and the cells are a breakdown of it, not
// a space to hunt in. Twenty-four cells still means twenty-four chances to be
// fooled, so the threshold carries a correction for that, but it is nothing
// like the correction a real search needs.
//
// ── Both entries, because the model changed under the study ────────────────
//
// The first published run measured a market entry at the close of the
// confirming two-minute bar, and found nothing that survived either holdout.
// By the time it published, that was no longer the rule: tradePlan rests a
// LIMIT at the swept level, and that is what the alert describes. So both are
// replayed now — the old entry for comparability, the plan because it is what
// you would actually place — and the plan's geometry is read off tradePlan
// itself rather than rebuilt here.
//
// Two labels the live screen prints are also measured rather than asserted:
// whether the sweep ran with or against the four-hour trend, and whether the
// paired instrument took its matching level at the same time.

const { INSTRUMENTS } = require('./instruments');

const PATH = 'bot/liquidity-study.json';

// Where a part-finished run lives between restarts. See the note above
// emptyAggregate for why this file is kilobytes rather than megabytes.
const PROGRESS_PATH = 'bot/liquidity-progress.json';

// Instruments per tick. Each one is around fifteen paged two-minute requests
// plus the replay, and the feed has to keep running the whole time.
const PER_STEP = 2;

// Bump when the measurement changes meaning, so a stale answer is discarded
// rather than shown next to a model it no longer describes.
const METHOD_VERSION = 3;

// Sixty days of two-minute bars is about 43,000 per instrument — nine paged
// requests. Longer would be better and is not affordable across forty
// instruments on a box that also runs the feed.
const HISTORY_DAYS = 60;

// How long a trade is given before it is called at the market. Fifteen
// two-minute bars is thirty minutes; ninety is three hours. Both are reported,
// because a model that only works on one horizon is a model that found a
// horizon rather than an edge.
const HOLDS = [15, 90];

// The plan's own two horizons, in two-minute bars. 240 is eight hours, which is
// what tradePlan's own expiry allows: the order rests that long and then the
// setup is called stale. The position gets the same, which is generous and
// deliberately so — a limit at a level with a target at the opposite level is
// not a trade that resolves in thirty minutes, and capping it there would
// measure the cap rather than the model.
const PLAN_WAIT = 240;
const PLAN_HOLD = 240;

// The sessions used to be defined here, in UTC, and nowhere else. That was the
// problem: the live scanner had no notion of a session at all, and the app's
// hunt feed looked a row's verdict up by `${kind}|${session}|${hold}` — a field
// nothing set. One definition now lives in shared/sessions.mjs and reaches this
// file through loadLib, so a cell's bucket and a row's label cannot disagree.
//
// Scoring does not iterate a session list any more. It reads the sessions that
// actually appear in the collected entries, the same way it already reads the
// level kinds, so there is nothing here left to drift.

// The multiple-comparison count, and it stays a LITERAL on purpose.
//
// Four sessions times six level kinds is the number of cells this study set out
// to test. Deriving it from the data instead — counting the cells that happened
// to have entries — would let a thin run quietly weaken its own correction: 12
// populated cells would demand a lower z than 24, so the fewer trades a run
// collected, the easier it would be for one of them to look significant. The
// correction has to be for the number of questions ASKED, not the number that
// came back with an answer.
// Four sessions by six level kinds, for the market entry, and the same again
// for the limit plan; plus three alignment cells and two divergence cells.
//
// One threshold covers all of them. Correcting each family only within itself
// would mean adding a family made the individual tests no harder to pass, which
// is exactly backwards: every cell added is another chance to be fooled, and it
// does not matter which table it is printed in. This is stricter than the 3.078
// the first published run used, which is the safe direction to move a
// threshold — the result it already reported (nothing holds) cannot be
// overturned by raising the bar.
const CELLS = 4 * 6 + 4 * 6 + 3 + 2;

// Minimum entries before a cell is allowed to say anything. Lower than the
// regime search's because there is no search here — one hypothesis, not
// thousands — but high enough that a handful of lucky trades cannot carry it.
const MIN_DISCOVERY = 25;
const MIN_TIME_HOLDOUT = 15;
const MIN_UNSEEN = 20;

/**
 * The shared modules, as one plain object.
 *
 * Wrapped rather than used directly because the replay needs both liquidity and
 * exits in one handle, and an ES module namespace cannot be extended — assigning
 * a property to it throws. Spreading into a fresh object is the honest way to
 * carry two namespaces together.
 */
async function loadLib() {
  const [liq, exits, sessions, structure, pairs] = await Promise.all([
    import('../../shared/liquidity.mjs'),
    import('../../shared/exits.mjs'),
    import('../../shared/sessions.mjs'),
    import('../../shared/structure.mjs'),
    import('../../shared/pairs.mjs'),
  ]);
  return { ...liq, exits, sessions, structure, pairs };
}

function atrOf(cs, i, period = 14) {
  if (i < period) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const p = cs[k - 1];
    sum += Math.max(cs[k].h - cs[k].l, Math.abs(cs[k].h - p.c), Math.abs(cs[k].l - p.c));
  }
  return sum / period;
}

/** Normal tail, for the corrected threshold. Same approximation the other studies use. */
function probit(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -probit(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** The z a cell must clear, corrected for having looked at CELLS of them. */
const strictZ = () => probit(1 - 0.025 / CELLS);

/**
 * Levels valid at each point in history.
 *
 * Rebuilding them per two-minute bar would call keyLevels forty thousand times
 * an instrument for an answer that changes at most six times a day. So a
 * timeline is built once — one entry per four-hour boundary, since that is the
 * fastest of the three inputs — and each bar looks up the entry covering it.
 *
 * Every entry is built from candles that CLOSED before its own start. That is
 * the whole discipline of a replay: at 09:00 the model may know yesterday's
 * high and must not know today's.
 */
async function buildLevelTimeline(lib, { daily, weekly, h4 }) {
  const { keyLevels } = lib;
  const out = [];
  for (let i = 20; i < h4.length; i++) {
    const at = h4[i].t;
    const past = h4.slice(0, i);
    out.push({
      from: at,
      levels: keyLevels({
        daily: daily.filter(d => d.t < at),
        weekly: weekly.filter(w => w.t < at),
        h4: past,
      }, { now: at }),
      // The four-hour structure as it stood at this boundary, from the same
      // candles the levels came from and under the same discipline: bars that
      // had closed, and no others. This is what makes "with or against the 4H
      // trend" a testable claim rather than a label — it was asserted on the
      // live screen with nothing behind it.
      trend: lib.structure.readStructure(past).structure,
      // The FOUR-HOUR ATR, because that is what the live scanner hands
      // tradePlan — _refreshLevels computes atrOf(h4) and _scan passes it
      // straight through. The replay was using the two-minute ATR, which makes
      // tradePlan's cushion about two orders of magnitude smaller and the stop
      // correspondingly tighter. Same function, same inputs, a different trade.
      atr: atrOf(past, past.length - 1),
    });
  }
  return out;
}

/**
 * Walk one instrument's history and return every entry the live model would
 * have taken.
 *
 * The suppression matters as much as the detection. A sweep stays detectable
 * for the whole window, so without it one liquidity event would be counted as
 * thirty trades and every number after that would be fiction.
 */
function replayOne(lib, sym, m2, timeline, { hold }) {
  const { findSweep, confirmation } = lib;
  const { sessionOf, SESSION_LABEL, inOverlap } = lib.sessions;
  const entries = [];
  let lastKey = null;

  // The scanner looks back sixty bars, so the replay cannot start before it has
  // sixty to look at.
  for (let i = 120; i < m2.length; i++) {
    const t = m2[i].t;
    // The most recent timeline entry that started before this bar.
    let tl = null;
    for (let k = timeline.length - 1; k >= 0; k--) {
      if (timeline[k].from <= t) { tl = timeline[k]; break; }
    }
    if (!tl || !tl.levels.length) continue;

    const window = m2.slice(Math.max(0, i - 59), i + 1);
    const sweep = findSweep(window, tl.levels);
    if (!sweep) { lastKey = null; continue; }

    const conf = confirmation(window, sweep);
    if (!conf) continue;
    // The confirmation must be the bar just closed, or this counts the same
    // trade again on every subsequent bar.
    if (conf.index !== window.length - 1) continue;

    const key = `${sweep.level.kind}|${sweep.level.price}|${sweep.dir}`;
    if (key === lastKey) continue;
    lastKey = key;

    const atr = atrOf(m2, i);
    if (!atr || atr <= 0) continue;
    if (i + hold >= m2.length) break;

    entries.push({
      sym, i, t,
      kind: sweep.level.kind,
      // The label travels with the entry so scoring, which is synchronous and
      // cannot reach an ES module, never has to look one up. It is also the
      // reason scoring no longer needs a session list at all.
      session: sessionOf(t),
      sessionLabel: SESSION_LABEL[sessionOf(t)] || sessionOf(t),
      overlap: inOverlap(t),
      dir: sweep.dir === 'long' ? 'up' : 'down',
      atr,
    });
  }
  return entries;
}

/**
 * The OTHER trade — the one the bot actually alerts on now.
 *
 * replayOne above measures a market entry at the close of the confirming
 * two-minute bar. That was the live rule when the study was written, and the
 * study found nothing that survived either holdout. It is no longer the rule.
 * tradePlan rests a LIMIT at the swept level, with a stop beyond the extreme and
 * a target at the opposite side's liquidity, and that is what goes to your
 * phone. Measuring the old entry and reporting it as a verdict on the model
 * would be answering a question nobody asked any more.
 *
 * Three differences, all of which change the answer rather than decorate it:
 *
 *   NO CONFIRMATION IS REQUIRED. The live plan is built from findSweep alone —
 *   it does not wait for a two-minute break. So there are more plans than there
 *   were entries, which is the whole reason the plan exists: the confirmation
 *   was the part that had always already happened by the time anyone looked.
 *
 *   MOST OF THEM WILL NOT FILL. A plan that never gets its retest is not a
 *   losing trade, it is not a trade. The fill rate is reported next to the
 *   result, because a plan filling one time in four at +0.3R is a different
 *   proposition from one filling every time at the same number.
 *
 *   AND THE GEOMETRY COMES FROM tradePlan ITSELF. Entry, stop and target are
 *   read off the live function rather than reconstructed here. A reconstruction
 *   that drifted by one cushion would measure a model nobody runs, and would
 *   look completely healthy while doing it.
 */
function replayPlans(lib, sym, m2, timeline, { waitBars = PLAN_WAIT, holdBars = PLAN_HOLD } = {}) {
  const { findSweep, tradePlan, trendAlign } = lib;
  const { runBracket } = lib.exits;
  const { sessionOf, SESSION_LABEL, inOverlap } = lib.sessions;
  const plans = [];
  const sweeps = [];        // every sweep, for the divergence pass at scoring time
  let lastKey = null;

  for (let i = 120; i < m2.length; i++) {
    const t = m2[i].t;
    let tl = null;
    for (let k = timeline.length - 1; k >= 0; k--) {
      if (timeline[k].from <= t) { tl = timeline[k]; break; }
    }
    if (!tl || !tl.levels.length) continue;

    const start = Math.max(0, i - 59);
    const window = m2.slice(start, i + 1);
    const sweep = findSweep(window, tl.levels);
    if (!sweep) { lastKey = null; continue; }

    // The same suppression as replayOne, and for the same reason: a sweep stays
    // detectable for the whole window, so without it one liquidity event becomes
    // thirty plans and every number after that is fiction.
    const key = `${sweep.level.kind}|${sweep.level.price}|${sweep.dir}`;
    if (key === lastKey) continue;
    lastKey = key;

    const at = start + sweep.at;              // the sweep bar, in the full series
    const m2atr = atrOf(m2, i);               // only for scaling the baseline
    if (!m2atr || m2atr <= 0 || !tl.atr || tl.atr <= 0) continue;

    // Geometry from the live function, with the live function's inputs: the
    // window it would have, and the four-hour ATR it is actually given.
    const geom = tradePlan(window, sweep, tl.levels, tl.atr, { now: t });
    if (!geom || !(Math.abs(geom.entry - geom.stop) > 0)) continue;

    // ── Only plans you could have been alerted to ────────────────────────────
    //
    // This is the bar the model FINDS the sweep on. The sweep itself is up to
    // fifty-nine bars earlier, and the first version ran the order from there —
    // so a plan could be filled on a retest that had already happened before
    // anything knew there was a sweep to trade. That is a look-ahead, and it
    // was worth roughly a full R: the first run of this reported +0.9R average
    // on cells that pass every holdout.
    //
    // The live scanner alerts on state 'armed' and on nothing else. 'triggered'
    // means the retest is already behind you and the entry has gone. So a plan
    // that is anything but armed the moment it is found is not a trade that was
    // ever on offer, and the order runs from HERE, not from the sweep.
    if (geom.state !== 'armed') continue;

    const dir = sweep.dir === 'long' ? 'up' : 'down';
    sweeps.push([t, sweep.level.kind]);

    // A plan whose life runs past the end of the data is dropped rather than
    // marked to market at the last bar available. The final eight hours of the
    // series would otherwise fill with trades cut short by the download ending,
    // which is not something that happens to a real order — and those truncated
    // trades cluster at the most recent end, which is the time holdout.
    if (i + waitBars >= m2.length) break;

    const res = runBracket(m2, i, {
      entry: geom.entry, stop: geom.stop, target: geom.target, dir, waitBars, holdBars,
    });

    const risk = Math.abs(geom.entry - geom.stop);
    plans.push({
      sym, i: at, t: m2[at].t,
      kind: sweep.level.kind,
      session: sessionOf(m2[at].t),
      sessionLabel: SESSION_LABEL[sessionOf(m2[at].t)] || sessionOf(m2[at].t),
      overlap: inOverlap(m2[at].t),
      dir,
      // The claim the live screen makes with nothing behind it, now attached to
      // an outcome. 'none' is kept as its own value rather than folded into
      // either side — a ranging market is not a weak trend.
      align: trendAlign(tl.trend, sweep.dir).align,
      // Against the two-minute ATR, because that is the unit planBaseline
      // samples in. The stop itself is built from the four-hour ATR above; this
      // is only how the matched baseline is scaled.
      riskAtr: risk / m2atr,
      rr: geom.rr ?? null,
      filled: res.filled,
      why: res.why,
      r: res.filled ? res.r : null,
      how: res.how,
    });
  }
  return { plans, sweeps };
}

/** One bracket at a fixed bar, with the geometry handed in. The plan baseline. */
function bracketAt(cs, i, risk, rr, holdBars, up) {
  const entry = cs[i].c;
  const stop = up ? entry - risk : entry + risk;
  const tgt = rr ? (up ? entry + rr * risk : entry - rr * risk) : null;
  const last = Math.min(i + holdBars, cs.length - 1);
  for (let j = i + 1; j <= last; j++) {
    if (up ? cs[j].l <= stop : cs[j].h >= stop) return -1;
    if (tgt != null && (up ? cs[j].h >= tgt : cs[j].l <= tgt)) return rr;
  }
  const raw = up ? cs[last].c - entry : entry - cs[last].c;
  return raw / risk;
}

const median = xs => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

/**
 * The baseline for a plan: the same instrument, the same direction, the same
 * SHAPE of bracket, entered at bars the model did not pick.
 *
 * A bracket's null is zero by construction — with a target k times the risk
 * away, a driftless walk pays +k one time in (1+k) and −1 the rest, and those
 * cancel exactly. So this baseline is not measuring the shape, it is measuring
 * the instrument's drift over the hold, which is the one thing that can make a
 * zero-expectation bet look like an edge. Gold trending up for two months makes
 * every long bracket on gold profitable and none of them skilful.
 *
 * The geometry is the median of that instrument's own plans rather than each
 * plan's exact numbers: a fresh sampled baseline per plan is several hundred
 * full passes over forty thousand bars per instrument, for a number that is
 * flat in the risk size and only really moves with the reward ratio.
 */
function planBaseline(lib, m2, dir, plans, holdBars, step = 97) {
  const mine = plans.filter(p => p.dir === dir);
  if (!mine.length) return null;
  const riskAtr = median(mine.map(p => p.riskAtr)) || 1;
  const rr = median(mine.map(p => p.rr).filter(x => x != null)) || 2;
  const up = dir === 'up';
  let sum = 0, n = 0;
  for (let i = 120; i + holdBars < m2.length; i += step) {
    const atr = atrOf(m2, i);
    if (!atr || atr <= 0) continue;
    sum += bracketAt(m2, i, riskAtr * atr, rr, holdBars, up);
    n++;
  }
  return n ? { expR: sum / n, n, riskAtr, rr } : null;
}

/**
 * The baseline: the same instrument, the same direction, the same hold, entered
 * on bars the model did NOT pick.
 *
 * Without it a win rate is unreadable. A long that pays 0.1R on average is an
 * edge in a flat market and a failure in one that drifted up 0.3R on every bar.
 * Sampled rather than exhaustive because forty thousand trades an instrument is
 * a lot of arithmetic for a number that stabilises long before that.
 */
function baselineFor(lib, m2, dir, hold, exit, step = 97) {
  const { runTrade } = lib.exits;
  let sum = 0, n = 0;
  for (let i = 120; i + hold < m2.length; i += step) {
    const atr = atrOf(m2, i);
    if (!atr || atr <= 0) continue;
    const r = runTrade(m2, i, hold, atr, dir, exit);
    sum += r.r; n++;
  }
  return n ? { expR: sum / n, n } : null;
}


/** Deterministic, class-balanced split. Same reasoning as regimeSearch's. */
function splitUniverse(list) {
  const byClass = {};
  for (const u of list) (byClass[u.cls] = byClass[u.cls] || []).push(u);
  const search = [], proof = [];
  for (const cls of Object.keys(byClass).sort()) {
    const l = [...byClass[cls]].sort((a, b) => a.sym.localeCompare(b.sym));
    l.forEach((u, i) => (i % 2 === 0 ? search : proof).push(u));
  }
  return { search, proof };
}

/**
 * The verdict for one cell, over both holdouts.
 *
 * A cell has to beat its baseline on the search half, keep the same sign on the
 * time holdout, and keep it again on instruments never looked at. Anything less
 * is named for what it is rather than rounded up to a pass.
 */
function verdict(cell) {
  const { discovery: A, time: B, unseen: P } = cell;
  if (!A || A.n < MIN_DISCOVERY) return 'thin';
  if (!B || B.n < MIN_TIME_HOLDOUT) return 'no time holdout';
  if (!P || P.n < MIN_UNSEEN) return 'no instrument holdout';

  const z = A.edgeR / (A.sd / Math.sqrt(A.n) || 1);
  if (!(z > strictZ())) return 'not significant';

  const timeOk = B.edgeR > 0;
  const instOk = P.edgeR > 0;
  if (timeOk && instOk) return 'holds';
  if (timeOk) return 'fades on other instruments';
  if (instOk) return 'fades in time';
  return 'fails';
}

/**
 * Run the study.
 *
 * Incremental by design: a slice of the universe per call, because forty
 * instruments of paged two-minute history is far too much for one tick and the
 * feed has to keep running while this happens.
 */
async function runLiquidityStudy({ oanda, log = () => {}, slice = null, universe = null,
  from: fromOpt = null } = {}) {
  // A plain object, NOT the module namespace with a property bolted on. An ES
  // module namespace is frozen, so `lib.exits = ...` throws "object is not
  // extensible" — which a test caught before the first run did.
  const lib = await loadLib();
  const { DEFAULT_EXIT } = lib.exits;

  const all = (universe || INSTRUMENTS.filter(i => i.can?.candles && i.oanda))
    .map(i => ({ sym: i.sym, oanda: i.oanda, cls: i.cls }));
  const { search, proof } = splitUniverse(all);
  const searchSyms = new Set(search.map(s => s.sym));

  const todo = slice ? all.filter(i => slice.includes(i.sym)) : all;
  // The window is passed in when a run spans several calls. Recomputing it from
  // Date.now() on each slice would give instrument 1 and instrument 40 windows
  // forty minutes apart, and the time holdout — a boundary inside that window —
  // would mean something slightly different for each of them.
  const from = fromOpt ?? Date.now() - HISTORY_DAYS * 86400e3;

  const collected = [];          // every market-entry trade, tagged
  const baselines = {};          // sym|dir|hold -> baseline
  const planned = [];            // every limit plan — the trade the bot alerts on
  const planBaselines = {};      // sym|dir -> matched-geometry baseline
  const sweepLogs = {};          // sym -> [[t, kind], …], only for paired instruments
  const h4rs = {};               // sym -> H4 log returns, only for paired instruments

  for (const inst of todo) {
    try {
      const [daily, weekly, h4, m2] = await Promise.all([
        oanda.getCandles(inst.oanda, 'D', 130),
        oanda.getCandles(inst.oanda, 'W', 40),
        oanda.getCandlesSince(inst.oanda, 'H4', from),
        oanda.getCandlesSince(inst.oanda, 'M2', from),
      ]);
      if (!m2 || m2.length < 2000 || !h4 || h4.length < 40) {
        log(`Liquidity study ${inst.sym}: not enough history`);
        continue;
      }

      const timeline = await buildLevelTimeline(lib, { daily, weekly, h4 });

      for (const hold of HOLDS) {
        const entries = replayOne(lib, inst.sym, m2, timeline, { hold });
        for (const dir of ['up', 'down']) {
          const key = `${inst.sym}|${dir}|${hold}`;
          baselines[key] = baselineFor(lib, m2, dir, hold, DEFAULT_EXIT);
        }
        for (const e of entries) {
          const t = lib.exits.runTrade(m2, e.i, hold, e.atr, e.dir, DEFAULT_EXIT);
          collected.push({ ...e, hold, r: t.r, how: t.how, unseen: !searchSyms.has(inst.sym) });
        }
      }
      // The plan: the limit at the level, which is what the phone alert says.
      const { plans, sweeps } = replayPlans(lib, inst.sym, m2, timeline);
      planned.push(...plans.map(p => ({ ...p, unseen: !searchSyms.has(inst.sym) })));
      for (const dir of ['up', 'down']) {
        planBaselines[`${inst.sym}|${dir}`] = planBaseline(lib, m2, dir, plans, PLAN_HOLD);
      }

      // Only instruments that have a declared partner carry a sweep log and a
      // returns series forward. The divergence question cannot be answered while
      // one instrument is in memory — it needs the partner's history, and the
      // partner is replayed in a different tick, possibly after a restart. These
      // two small arrays are what survives to answer it at scoring time, and
      // keeping them for all forty would be carrying data for a question that
      // can never be asked of twenty-four of them.
      if (lib.pairs.partnersOf(inst.sym).length) {
        sweepLogs[inst.sym] = sweeps;
        h4rs[inst.sym] = lib.pairs.returnsOf(h4).slice(-400);
      }

      const filled = plans.filter(p => p.filled).length;
      log(`Liquidity study ${inst.sym}: ${m2.length} bars, `
        + `${collected.filter(c => c.sym === inst.sym).length} entries, `
        + `${plans.length} plans (${filled} filled)`);
    } catch (e) {
      log(`Liquidity study ${inst.sym}: ${e.message}`);
    }
  }

  return { collected, baselines, planned, planBaselines, sweepLogs, h4rs,
    all, searchSyms: [...searchSyms], from, METHOD_VERSION };
}

/**
 * ── Why the study is an AGGREGATE and not a pile of entries ─────────────────
 *
 * The study was written, tested, wired into the tick and pushed, and then never
 * produced a file. Not once. The reason was not in the arithmetic: a full run is
 * sixty days of paged two-minute history for forty instruments — around six
 * hundred requests and several minutes of replay — held in ONE blocking call,
 * with everything it had collected living in a local variable. The bot follows
 * its own branch and restarts on every deploy. `bootedAt` in bot/vps-version.json
 * equals `checkedAt` to the millisecond, which is what a restart looks like. Each
 * restart set liqStudyRan back to false and began the whole run again from the
 * first instrument, and during a stretch of active development no run ever got
 * to the end. `slice` existed for exactly this and was always called with null.
 *
 * Keeping partial RESULTS instead would mean writing tens of thousands of
 * replayed trades to a file once per slice. So almost nothing keeps the trades.
 * Every number the study reports — n, mean, sd, win rate, fill rate, and the
 * edge over baseline — comes from sums that can be added to one instrument at a
 * time: count, Σr, Σr², wins, and Σ(r − that instrument's baseline). A restart
 * costs whatever was in flight rather than everything.
 *
 * ── The one exception, and what it actually cost ────────────────────────────
 *
 * Divergence cannot be summed that way. "Did the partner take its level too" is
 * a question about two instruments, and they are replayed in different steps,
 * so paired instruments' plans ARE held whole. On the first real run that took
 * the progress file to 1.2MB and still climbing — against a comment right here
 * promising kilobytes. The comment being wrong was the worse half of that: a
 * large file gets noticed, a confident comment does not get rechecked.
 *
 * What was wrong was the ORDER. INSTRUMENTS lists gold at 33 and silver at 34
 * but EUR/USD at 1 and USD/CHF at 4, so a pair could be thirty instruments
 * apart and every plan in between had to be carried until the run ended. Pairs
 * are now replayed as connected components, back to back, and a component's
 * plans are classified and released the moment its last member is in. What is
 * held is bounded by the largest component — five instruments — rather than
 * growing with the run.
 *
 * ── The one thing this changes about the measurement ────────────────────────
 *
 * The time holdout used to be the most recent third of the ENTRIES — a quantile
 * of the data, which cannot be known until all of it is in. It is now a fixed
 * date: two thirds of the way through the study's window. That is the same
 * intent and a better version of it. A boundary decided by the data can be moved
 * by the data; a date cannot, and every slice folds against the same one no
 * matter what order the instruments were processed in.
 */

// `armed` counts every plan that was placed; `n` counts only the ones that
// filled. A plan that never gets its retest is not a losing trade, it is not a
// trade — averaging it in as a zero would dilute every number with orders
// nobody held, and dropping it silently would hide that the fill rate is part
// of the answer.
const bucket = () => ({ n: 0, sum: 0, sumsq: 0, wins: 0, edgeSum: 0, edgeN: 0,
  armed: 0, rrSum: 0, riskSum: 0 });

/**
 * Record a plan being placed, whether or not it went on to fill.
 *
 * The geometry is carried because it turned out to need watching. tradePlan's
 * stop sits a fraction of an ATR beyond the sweep extreme, so a SHALLOW sweep
 * produces a very small risk — while the target stays where it is, at the
 * opposite side's liquidity. The ratio of the two is then enormous: a replay on
 * synthetic data threw up a plan quoting 51R, and the live alert would have put
 * that number on your phone. It is arithmetically correct and it means the
 * opposite of what it looks like — a target that far away is one price will
 * almost never reach before the stop, not a wonderful trade.
 *
 * So the average ratio and the average stop size are reported next to every
 * result, and the question of whether the far targets ever pay becomes
 * something to read off the table rather than an argument.
 */
function addArmed(b, p) {
  b.armed++;
  if (Number.isFinite(p?.rr)) b.rrSum += p.rr;
  if (Number.isFinite(p?.riskAtr)) b.riskSum += p.riskAtr;
}

/** A fresh, empty aggregate for a window. */
function emptyAggregate({ from, to = Date.now(), searchSyms = [] } = {}) {
  return {
    method: METHOD_VERSION,
    from, to,
    // Two thirds of the way through the window, in time.
    cut: from + Math.round((to - from) * 0.67),
    searchSyms: [...searchSyms],
    done: [],
    syms: [],
    entries: 0,
    cells: {},
    // The limit plan, by level kind and session — the trade the bot alerts on.
    planCells: {},
    // The plan again, sliced by whether the sweep ran with or against the 4H
    // trend. Not crossed into planCells: six kinds by four sessions by three
    // alignments is 72 questions on a few thousand trades, which is a machine
    // for finding one that looks good. Pooled across kinds, "does alignment
    // matter" is one question with three answers.
    alignCells: {},
    // And by whether the partner took its matching level. Filled in at scoring
    // time, because it needs two instruments at once.
    divCells: {},
    // What the divergence pass needs, kept until every instrument is in.
    pending: [],
    sweepLogs: {},
    h4rs: {},
    plans: 0,
    fills: 0,
  };
}

/** Add one observation to a bucket. `edge` may be null when no baseline exists. */
function addTo(b, r, edge) {
  b.n++; b.sum += r; b.sumsq += r * r;
  if (r > 0) b.wins++;
  if (edge != null) { b.edgeSum += edge; b.edgeN++; }
}

/** Turn a bucket back into the shape verdict() and the app expect. */
function readBucket(b) {
  if (!b || !b.n) {
    return b?.armed ? { n: 0, armed: b.armed, fillRate: 0,
      rr: b.rrSum ? +(b.rrSum / b.armed).toFixed(2) : null,
      stopAtr: b.riskSum ? +(b.riskSum / b.armed).toFixed(3) : null } : null;
  }
  const mean = b.sum / b.n;
  // The population form would understate the spread and make every z larger,
  // which on a significance test is the direction that invents results.
  const varr = b.n > 1 ? Math.max(0, (b.sumsq - b.n * mean * mean) / (b.n - 1)) : 0;
  return {
    n: b.n,
    expR: +mean.toFixed(4),
    sd: +Math.sqrt(varr).toFixed(4),
    win: +(b.wins / b.n).toFixed(3),
    edgeR: b.edgeN ? +(b.edgeSum / b.edgeN).toFixed(4) : null,
    // Present only for plans. A market entry is always "filled" and reporting a
    // fill rate of 1 on it would imply the number meant something there.
    ...(b.armed ? {
      armed: b.armed,
      fillRate: +(b.n / b.armed).toFixed(3),
      // The shape of the trades in this cell, averaged over every plan placed.
      rr: b.rrSum ? +(b.rrSum / b.armed).toFixed(2) : null,
      stopAtr: b.riskSum ? +(b.riskSum / b.armed).toFixed(3) : null,
    } : {}),
  };
}

/**
 * Fold one slice's entries into the running aggregate.
 *
 * Idempotent per instrument: an instrument already in `done` is skipped, so a
 * restart that re-runs a slice it had already folded cannot double-count it into
 * significance.
 */
/** Which split an entry belongs to. The instrument holdout wins over the date. */
function splitOf(agg, seen, c) {
  if (!seen.has(c.sym)) return 'unseen';
  return c.t < agg.cut ? 'discovery' : 'time';
}

/**
 * Fold the limit plans in.
 *
 * Separate from foldInto because a plan is a different object: it has an
 * `armed` count that exists whether or not it filled, and its baseline is keyed
 * by instrument and direction only — there is no hold dimension, because the
 * plan runs to its stop or its target rather than to a clock.
 */
function foldPlans(agg, { planned = [], planBaselines = {}, sweepLogs = {}, h4rs = {} } = {}) {
  const seen = new Set(agg.searchSyms);
  const already = new Set(agg.done);

  for (const p of planned) {
    if (already.has(p.sym)) continue;
    const split = splitOf(agg, seen, p);
    const b = planBaselines[`${p.sym}|${p.dir}`];
    const edge = p.filled && b ? p.r - b.expR : null;

    const touch = (store, key, extra) => {
      let cell = store[key];
      if (!cell) cell = store[key] = { ...extra, discovery: bucket(), time: bucket(), unseen: bucket() };
      // `armed` counts every plan placed, filled or not; addTo moves `n`, which
      // counts only the fills. fillRate is n/armed, so both must be counted.
      addArmed(cell[split], p);
      if (p.filled) addTo(cell[split], p.r, edge);
      return cell;
    };
    touch(agg.planCells, `${p.kind}|${p.session}`,
      { kind: p.kind, session: p.session, sessionLabel: p.sessionLabel });
    touch(agg.alignCells, p.align, { align: p.align });

    agg.plans++;
    if (p.filled) agg.fills++;
    if (!agg.syms.includes(p.sym)) agg.syms.push(p.sym);

    // Paired instruments keep their plans whole until every instrument is in.
    // A few thousand small records, against the alternative of holding two
    // forty-thousand-bar histories in memory at the same moment.
    if (sweepLogs[p.sym] || agg.sweepLogs[p.sym]) {
      agg.pending.push({ sym: p.sym, t: p.t, kind: p.kind, dir: p.dir,
        filled: p.filled, r: p.r, edge, split, rr: p.rr, riskAtr: p.riskAtr });
    }
  }

  for (const [sym, log] of Object.entries(sweepLogs)) {
    if (!already.has(sym)) agg.sweepLogs[sym] = log;
  }
  for (const [sym, r] of Object.entries(h4rs)) {
    if (!already.has(sym)) agg.h4rs[sym] = r;
  }
  return agg;
}

/**
 * Replay order: paired instruments next to each other, everything else after.
 *
 * The order used to be whatever INSTRUMENTS listed, which put gold at position
 * 33 and silver at 34 but EUR/USD at 1 and USD/CHF at 4 — and the divergence
 * question cannot be answered until BOTH sides of a pair have been replayed. So
 * every paired plan had to be kept whole until the end of the run, and the
 * progress file reached 1.2MB on the first real pass. The comment above
 * emptyAggregate promised kilobytes; it was wrong, and a wrong comment about
 * size is worse than a large file because nobody goes and looks.
 *
 * Pairs are transitive here — US500 is paired with US100, US30, GER40 and
 * AUD/JPY — so this walks connected components rather than pairs. A component
 * replayed together can be classified and discarded together, and what is held
 * is bounded by the largest component instead of by the whole universe.
 *
 * @returns {{ order: any[], componentOf: Record<string,string> }}
 */
function orderUniverse(lib, all) {
  const bySym = new Map(all.map(i => [i.sym, i]));
  const seen = new Set();
  const order = [];
  const componentOf = {};
  for (const inst of all) {
    if (seen.has(inst.sym)) continue;
    const partners = lib.pairs.partnersOf(inst.sym);
    if (!partners.length) continue;
    // Breadth-first over the pair graph.
    const queue = [inst.sym], group = [];
    seen.add(inst.sym);
    while (queue.length) {
      const sym = queue.shift();
      const rec = bySym.get(sym);
      if (rec) group.push(rec);
      for (const p of lib.pairs.partnersOf(sym)) {
        if (seen.has(p.sym) || !bySym.has(p.sym)) continue;
        seen.add(p.sym); queue.push(p.sym);
      }
    }
    const id = group[0].sym;
    for (const g of group) componentOf[g.sym] = id;
    order.push(...group);
  }
  for (const inst of all) if (!seen.has(inst.sym)) order.push(inst);
  return { order, componentOf };
}

/**
 * Classify and discard every held plan whose whole component is now replayed.
 *
 * Called after each step. Once a component is done there is nothing further to
 * learn about it, so its plans are folded into the divergence cells and its
 * sweep logs and returns are dropped — which is what keeps the progress file
 * from growing with the run.
 */
function drainPending(lib, agg, componentOf, done) {
  if (!agg.pending?.length) return agg;
  const complete = new Set();
  const members = {};
  for (const [sym, id] of Object.entries(componentOf)) (members[id] = members[id] || []).push(sym);
  for (const [id, syms] of Object.entries(members)) {
    if (syms.every(s => done.has(s))) complete.add(id);
  }
  if (!complete.size) return agg;

  const stay = [];
  const go = [];
  for (const e of agg.pending) {
    (complete.has(componentOf[e.sym]) ? go : stay).push(e);
  }
  if (go.length) foldDivergence(lib, agg, go);
  agg.pending = stay;
  for (const sym of Object.keys(componentOf)) {
    if (!complete.has(componentOf[sym])) continue;
    // The logs are only needed by the component's own members, and they are all
    // in. Another component's plans can never ask about these.
    delete agg.sweepLogs[sym];
    delete agg.h4rs[sym];
  }
  return agg;
}

/**
 * Did the partner take its matching level too?
 *
 * Runs once, at the end, over the plans that were kept whole. It needs both
 * instruments and they are replayed in different ticks, so this is the one part
 * of the study that cannot stream.
 *
 * ±2 hours because that is the window the live scanner looks back over when it
 * decides a level is "swept". Widening it here would make the replay generous
 * about something the live screen is strict about.
 */
function foldDivergence(lib, agg, entries = null) {
  const { partnersOf, correlate, mirrorKind, MIN_R } = lib.pairs;
  const WINDOW = 2 * 3600e3;
  const corr = {};
  for (const sym of Object.keys(agg.sweepLogs)) {
    for (const p of partnersOf(sym)) {
      const key = [sym, p.sym].sort().join('|');
      if (corr[key] !== undefined) continue;
      corr[key] = (agg.h4rs[sym] && agg.h4rs[p.sym])
        ? correlate(agg.h4rs[sym], agg.h4rs[p.sym]) : null;
    }
  }

  for (const e of (entries || agg.pending)) {
    let verdict = null;
    for (const p of partnersOf(e.sym)) {
      const c = corr[[e.sym, p.sym].sort().join('|')];
      if (!c || Math.abs(c.r) < MIN_R) continue;
      const log = agg.sweepLogs[p.sym];
      if (!log) continue;
      const want = mirrorKind(e.kind, c.r);
      const together = log.some(([t, k]) => k === want && Math.abs(t - e.t) <= WINDOW);
      // The strongest related partner decides, and "together" is only claimed
      // once — a second partner that stayed put does not turn it back.
      verdict = together ? 'together' : (verdict === 'together' ? 'together' : 'alone');
      if (together) break;
    }
    if (!verdict) continue;
    let cell = agg.divCells[verdict];
    if (!cell) cell = agg.divCells[verdict] = { divergence: verdict, discovery: bucket(), time: bucket(), unseen: bucket() };
    addArmed(cell[e.split], e);
    if (e.filled) addTo(cell[e.split], e.r, e.edge);
  }
  return agg;
}

function foldInto(agg, { collected = [], baselines = {} } = {}) {
  const seen = new Set(agg.searchSyms);
  const already = new Set(agg.done);
  for (const c of collected) {
    if (already.has(c.sym)) continue;
    const key = `${c.hold}|${c.kind}|${c.session}`;
    let cell = agg.cells[key];
    if (!cell) {
      cell = agg.cells[key] = {
        hold: c.hold, kind: c.kind, session: c.session,
        sessionLabel: c.sessionLabel || c.session,
        discovery: bucket(), time: bucket(), unseen: bucket(),
      };
    }
    // Each entry against ITS OWN instrument's baseline. Pooling first and
    // subtracting one baseline would let a drifty instrument's baseline stand
    // in for a quiet one's.
    const b = baselines[`${c.sym}|${c.dir}|${c.hold}`];
    const edge = b ? c.r - b.expR : null;

    // Three splits, and an entry belongs to exactly one. The instrument holdout
    // is checked first because it is the one that cannot be fitted: an
    // instrument never looked at during selection contributes to `unseen` and to
    // nothing else, whichever side of the date it falls on.
    if (!seen.has(c.sym)) addTo(cell.unseen, c.r, edge);
    else if (c.t < agg.cut) addTo(cell.discovery, c.r, edge);
    else addTo(cell.time, c.r, edge);

    agg.entries++;
    if (!agg.syms.includes(c.sym)) agg.syms.push(c.sym);
  }
  return agg;
}

/** Mark instruments as folded, so a re-run of the same slice is a no-op. */
function markDone(agg, syms) {
  for (const s of syms) if (!agg.done.includes(s)) agg.done.push(s);
  return agg;
}

/**
 * Turn an aggregate into cells with verdicts.
 *
 * Also accepts the one-shot shape — `{ collected, baselines, searchSyms }` — by
 * folding it into a fresh aggregate first, so there is ONE scoring
 * implementation rather than one for the incremental path and another for the
 * direct one. Two would be free to disagree, and the disagreement would be
 * invisible: both produce a plausible table.
 */
function scoreStudy(input) {
  let agg = input;
  if (Array.isArray(input?.collected)) {
    const times = input.collected.map(c => c.t).filter(Number.isFinite);
    agg = emptyAggregate({
      from: input.from ?? (times.length ? Math.min(...times) : 0),
      to: input.to ?? (times.length ? Math.max(...times) + 1 : 1),
      searchSyms: input.searchSyms || [],
    });
    foldInto(agg, input);
  }

  const readFamily = (store, head) => Object.values(store || {}).map(c => {
    const cell = {
      ...head(c),
      discovery: readBucket(c.discovery),
      time: readBucket(c.time),
      unseen: readBucket(c.unseen),
    };
    cell.verdict = verdict(cell);
    return cell;
  });

  const cells = readFamily(agg.cells, c => ({
    hold: c.hold, kind: c.kind, session: c.session, sessionLabel: c.sessionLabel,
  }));
  const planCells = readFamily(agg.planCells, c => ({
    kind: c.kind, session: c.session, sessionLabel: c.sessionLabel,
  }));
  const alignCells = readFamily(agg.alignCells, c => ({ align: c.align }));
  const divCells = readFamily(agg.divCells, c => ({ divergence: c.divergence }));

  const byEdge = (a, b) => (b.discovery?.edgeR ?? -9) - (a.discovery?.edgeR ?? -9);
  cells.sort(byEdge); planCells.sort(byEdge);
  alignCells.sort(byEdge); divCells.sort(byEdge);
  return {
    at: new Date().toISOString(),
    method: METHOD_VERSION,
    historyDays: HISTORY_DAYS,
    holds: HOLDS,
    cellsTested: CELLS,
    strictZ: +strictZ().toFixed(3),
    entries: agg.entries || 0,
    instruments: (agg.syms || []).length,
    // The date the time holdout starts, published rather than implied. A
    // holdout whose boundary is not stated cannot be checked by anyone reading
    // the result.
    holdoutFrom: agg.cut ? new Date(agg.cut).toISOString() : null,
    searchHalf: agg.searchSyms || [],
    // The market entry at the confirming bar's close — the model's original
    // rule, kept because it is what the first published run measured.
    cells,
    // The limit resting at the swept level — the trade the alert describes.
    // This is the one that speaks to what you would actually place.
    plans: agg.plans || 0,
    fills: agg.fills || 0,
    fillRate: agg.plans ? +((agg.fills || 0) / agg.plans).toFixed(3) : null,
    planCells,
    // And the two labels the live screen prints with nothing behind them.
    alignCells,
    divCells,
  };
}

/**
 * One step of a run: fetch and replay a few instruments, fold them in, save.
 *
 * This is the piece that was missing. The study is not a job that takes several
 * minutes once a fortnight — it is a job that takes several minutes across as
 * many ticks as it needs, because the process it runs in does not live for
 * several minutes when anyone is deploying.
 *
 * `perStep` is two, not the whole universe. Each instrument is fifteen paged
 * two-minute requests, and the feed is running throughout.
 *
 * @returns {Promise<{state:'idle'|'running'|'published', done:number, total:number,
 *   result?:object}>}
 */
async function stepLiquidityStudy({ oanda, github, log = () => {}, perStep = PER_STEP,
  universe = null, now = Date.now() } = {}) {
  const lib = await loadLib();
  const all = (universe || INSTRUMENTS.filter(i => i.can?.candles && i.oanda))
    .map(i => ({ sym: i.sym, oanda: i.oanda, cls: i.cls }));

  // Is there a published answer already, and is it still current?
  const cur = await github.readJSON(PATH).catch(() => null);
  const age = cur?.content?.at ? now - Date.parse(cur.content.at) : Infinity;
  if (age < 14 * 86400e3 && cur?.content?.method === METHOD_VERSION) {
    return { state: 'idle', done: 0, total: 0 };
  }

  // Resume, or start. A progress file from an older method is discarded rather
  // than continued: half a run measured one way and half the other is a number
  // that describes nothing, and it would look completely normal.
  // A read that FAILS is not a read that found nothing.
  //
  // This was `.catch(() => null)`, which made a transient error indistinguishable
  // from "no progress yet" — and the only thing it could then do was throw the
  // run away and start again. Combined with the contents API returning an empty
  // 200 for anything over 1MB, that produced a study that restarted from the
  // first instrument on every single tick and could never publish.
  //
  // Not found is a fresh start. Anything else leaves the file alone and waits
  // for the next tick, because hours of replay is not worth discarding over one
  // bad response.
  let prog = null;
  try {
    prog = await github.readJSON(PROGRESS_PATH);
  } catch (e) {
    log(`Liquidity study: progress unreadable (${e.message}) — waiting rather than starting over`);
    return { state: 'running', done: 0, total: all.length };
  }
  let agg = prog?.content;
  if (!agg || agg.method !== METHOD_VERSION || !agg.cells) {
    const { search } = splitUniverse(all);
    agg = emptyAggregate({
      from: now - HISTORY_DAYS * 86400e3,
      to: now,
      searchSyms: search.map(x => x.sym),
    });
    log(`Liquidity study: starting a fresh ${HISTORY_DAYS}-day run over ${all.length} instruments`);
  }

  const done = new Set(agg.done);
  // Paired instruments adjacent, so a component finishes together and its held
  // plans can be classified and dropped instead of waiting for the whole run.
  const { order, componentOf } = orderUniverse(lib, all);
  const todo = order.filter(i => !done.has(i.sym)).slice(0, perStep);

  if (todo.length) {
    const raw = await runLiquidityStudy({
      oanda, log, universe: all, from: agg.from,
      slice: todo.map(i => i.sym),
    });
    foldInto(agg, raw);
    foldPlans(agg, raw);
    // Marked done whether or not they yielded entries. An instrument with too
    // little history contributes nothing and must still count as processed, or
    // the run retries it every tick and never reaches the end.
    markDone(agg, todo.map(i => i.sym));
    drainPending(lib, agg, componentOf, new Set(agg.done));
    await github.writeJSON(PROGRESS_PATH, agg, 'bot: liquidity study progress',
      prog?.sha || null, { pretty: false });
  }

  if (agg.done.length < all.length) {
    log(`Liquidity study: ${agg.done.length}/${all.length} instruments, ${agg.entries} entries so far`);
    return { state: 'running', done: agg.done.length, total: all.length };
  }

  // Whatever is still held: components that never completed, because an
  // instrument in them had too little history to replay. They are classified
  // with what there is rather than dropped, since a partner that produced no
  // sweeps is a partner that did not take its level.
  foldDivergence(lib, agg);
  agg.pending = [];
  const result = scoreStudy(agg);
  await github.writeJSON(PATH, result, 'bot: liquidity sweep study', cur?.sha || null);
  // The progress file is emptied rather than left behind, so the next run after
  // the fortnight is up starts clean instead of resuming a finished one.
  await github.writeJSON(PROGRESS_PATH, { method: METHOD_VERSION, done: [], cells: {} },
    'bot: liquidity study done', null, { pretty: false }).catch(() => {});

  const held = (result.cells || []).filter(c => c.verdict === 'holds');
  log(`Liquidity study published — ${result.entries} entries across ${result.instruments} `
    + `instruments, ${held.length} of ${result.cells.length} cells held both holdouts`);
  return { state: 'published', done: all.length, total: all.length, result };
}

module.exports = {
  runLiquidityStudy, scoreStudy, loadLib, replayOne, buildLevelTimeline, baselineFor,
  splitUniverse, verdict, atrOf, probit, strictZ,
  stepLiquidityStudy, emptyAggregate, foldInto, foldPlans, foldDivergence, markDone,
  orderUniverse, drainPending,
  readBucket, replayPlans, planBaseline, bracketAt, PROGRESS_PATH, PER_STEP,
  PLAN_WAIT, PLAN_HOLD,
  PATH, METHOD_VERSION, HOLDS, HISTORY_DAYS,
  MIN_DISCOVERY, MIN_TIME_HOLDOUT, MIN_UNSEEN, CELLS,
};

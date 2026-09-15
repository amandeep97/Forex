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
// And it does not simulate a limit entry, yet. The live model enters at the
// close of the confirming bar and this replays that, faithfully, including the
// part that is bad for a human.

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
const METHOD_VERSION = 1;

// Sixty days of two-minute bars is about 43,000 per instrument — nine paged
// requests. Longer would be better and is not affordable across forty
// instruments on a box that also runs the feed.
const HISTORY_DAYS = 60;

// How long a trade is given before it is called at the market. Fifteen
// two-minute bars is thirty minutes; ninety is three hours. Both are reported,
// because a model that only works on one horizon is a model that found a
// horizon rather than an edge.
const HOLDS = [15, 90];

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
const CELLS = 4 * 6;

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
  const [liq, exits, sessions] = await Promise.all([
    import('../../shared/liquidity.mjs'),
    import('../../shared/exits.mjs'),
    import('../../shared/sessions.mjs'),
  ]);
  return { ...liq, exits, sessions };
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
    out.push({
      from: at,
      levels: keyLevels({
        daily: daily.filter(d => d.t < at),
        weekly: weekly.filter(w => w.t < at),
        h4: h4.slice(0, i),
      }, { now: at }),
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

  const collected = [];          // every entry, tagged
  const baselines = {};          // sym|dir|hold -> baseline

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
      log(`Liquidity study ${inst.sym}: ${m2.length} bars, `
        + `${collected.filter(c => c.sym === inst.sym).length} entries`);
    } catch (e) {
      log(`Liquidity study ${inst.sym}: ${e.message}`);
    }
  }

  return { collected, baselines, all, searchSyms: [...searchSyms], from, METHOD_VERSION };
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
 * replayed trades to a file once per slice. So nothing keeps the trades. Every
 * number the study reports — n, mean, sd, win rate, and the edge over baseline —
 * comes from sums that can be added to one instrument at a time: count, Σr, Σr²,
 * wins, and Σ(r − that instrument's baseline). The progress file is a few
 * kilobytes whether the universe is eight instruments or four hundred, and a
 * restart costs whatever was in flight rather than everything.
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

const bucket = () => ({ n: 0, sum: 0, sumsq: 0, wins: 0, edgeSum: 0, edgeN: 0 });

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
  if (!b || !b.n) return null;
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
  };
}

/**
 * Fold one slice's entries into the running aggregate.
 *
 * Idempotent per instrument: an instrument already in `done` is skipped, so a
 * restart that re-runs a slice it had already folded cannot double-count it into
 * significance.
 */
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

  const cells = Object.values(agg.cells || {}).map(c => {
    const cell = {
      hold: c.hold, kind: c.kind, session: c.session, sessionLabel: c.sessionLabel,
      discovery: readBucket(c.discovery),
      time: readBucket(c.time),
      unseen: readBucket(c.unseen),
    };
    cell.verdict = verdict(cell);
    return cell;
  });

  cells.sort((a, b) => (b.discovery?.edgeR ?? -9) - (a.discovery?.edgeR ?? -9));
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
    cells,
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
  const prog = await github.readJSON(PROGRESS_PATH).catch(() => null);
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
  const todo = all.filter(i => !done.has(i.sym)).slice(0, perStep);

  if (todo.length) {
    const raw = await runLiquidityStudy({
      oanda, log, universe: all, from: agg.from,
      slice: todo.map(i => i.sym),
    });
    foldInto(agg, raw);
    // Marked done whether or not they yielded entries. An instrument with too
    // little history contributes nothing and must still count as processed, or
    // the run retries it every tick and never reaches the end.
    markDone(agg, todo.map(i => i.sym));
    await github.writeJSON(PROGRESS_PATH, agg, 'bot: liquidity study progress',
      prog?.sha || null, { pretty: false });
  }

  if (agg.done.length < all.length) {
    log(`Liquidity study: ${agg.done.length}/${all.length} instruments, ${agg.entries} entries so far`);
    return { state: 'running', done: agg.done.length, total: all.length };
  }

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
  stepLiquidityStudy, emptyAggregate, foldInto, markDone, readBucket, PROGRESS_PATH, PER_STEP,
  PATH, METHOD_VERSION, HOLDS, HISTORY_DAYS,
  MIN_DISCOVERY, MIN_TIME_HOLDOUT, MIN_UNSEEN, CELLS,
};

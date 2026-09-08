'use strict';
// vps-bot/src/regimeSearch.js
//
// The same method as regimeStudy.js, run wide, with a second holdout.
//
// The narrow study searched two instruments on one timeframe over one year:
// 216 rule/direction/horizon combinations, one survivor. That is not a weak
// result, it is a narrow search — the method found something in the smallest
// scope it was ever pointed at. This widens the scope without loosening a
// single thing that made the answer trustworthy.
//
// ── The problem widening creates, and the answer to it ──────────────────────
//
// Sixteen instruments over three timeframes is roughly a hundred times more
// tests than two over one. At that scale something will look wonderful purely
// by chance, and a statistical correction alone is a weak defence: it penalises
// you for the tests you ADMIT to, and a wide search runs thousands whether or
// not anyone counts them.
//
// So the defence is not a bigger correction. It is a second holdout, along an
// axis that cannot be fitted:
//
//   TIME     alternating fortnights, exactly as before. Half of history is
//            hidden during the search and survivors are scored on it.
//
//   INSTRUMENTS  the universe is split in two. Rules are searched on one half
//            and then scored on instruments that were never looked at, not
//            once, at any point in the search.
//
// The instrument holdout is the stronger of the two and it is the whole reason
// for this file. A rule can be fitted to gold's particular year; it cannot be
// fitted to eight instruments it has never seen. "It worked on six of the eight
// markets it was never searched on" is a claim of a different kind from any
// t-statistic, and it is the claim that separates a fact about markets from a
// fact about twelve months of one chart.
//
// A rule has to pass BOTH to be reported as holding. Passing time alone means
// it is real for that instrument and may be nothing more. Passing instruments
// alone means it generalises but may not be current.
//
// ── What is deliberately NOT in here ────────────────────────────────────────
//
// No macro conditions. The dollar-and-yield decomposition is specific to
// metals; asking what the dollar explains about the dollar is not a question.
// This searches price structure and the clock, which mean the same thing on
// every instrument, so a result can generalise at all.
//
// No news. The archive is weeks old, not years.

const path = require('path');
const { pathToFileURL } = require('url');
const {
  sideOf, welch, zFor, runAll, baselineFor, scoreRule, probit, loadExits,
  BLOCK_MS, STOP_ATR, DIRS, MIN_SEEN,
} = require('./regimeStudy');

const SHARED = pathToFileURL(path.join(__dirname, '..', '..', 'shared', 'moveFeatures.mjs')).href;

//   2 — the EXIT is searched, not assumed, and M15 enters. Every rule before
//       this was scored with one exit: a one ATR stop, a 2R target. That is a
//       result about a PAIR reported as a result about entries. And M15 is the
//       timeframe actually traded, which had never been looked at.
const METHOD_VERSION = 2;

// ── Scope ───────────────────────────────────────────────────────────────────
//
// Bounded by what OANDA will serve in a reasonable time, not by ambition. Four
// years of H1 is about 25,000 bars an instrument and nine paginated requests;
// sixteen instruments across three timeframes is a few hundred requests and
// several minutes. M15 over four years would be 140,000 bars each and is left
// out for that reason alone — it is the timeframe you trade, and it is the
// obvious next step once this proves worth the wait.
//
// Years are PER TIMEFRAME. Four years of M15 is 140,000 bars an instrument and
// would take longer than the answer is worth; one year is 35,000, which is six
// times the sample the hourly study has ever had, on the timeframe actually
// traded. Holds are in BARS, so twelve means twelve hours on H1 and three on
// M15 — the same number would otherwise silently ask a different question.
const TIMEFRAMES = [
  { tf: 'H4',  ms: 4 * 3600e3, holds: [6, 12],  years: 4 },   // a day, two days
  { tf: 'H1',  ms: 3600e3,     holds: [12, 24], years: 4 },   // half a day, a day
  { tf: 'M15', ms: 900e3,      holds: [16, 48], years: 1 },   // four hours, twelve
];

const YEARS = 4;
const RECENT_DAYS = 365;

// Sixteen liquid instruments, stratified so BOTH halves of the split carry a
// mix of asset classes. A split that put all the FX in one half and all the
// indices in the other would test whether a rule survives being moved between
// asset classes, which is a different and much harder question than whether it
// generalises at all.
const UNIVERSE = [
  { sym: 'EUR_USD',    cls: 'fx' },
  { sym: 'GBP_USD',    cls: 'fx' },
  { sym: 'USD_JPY',    cls: 'fx' },
  { sym: 'USD_CHF',    cls: 'fx' },
  { sym: 'AUD_USD',    cls: 'fx' },
  { sym: 'USD_CAD',    cls: 'fx' },
  { sym: 'EUR_JPY',    cls: 'fx' },
  { sym: 'GBP_JPY',    cls: 'fx' },
  { sym: 'XAU_USD',    cls: 'metal' },
  { sym: 'XAG_USD',    cls: 'metal' },
  { sym: 'SPX500_USD', cls: 'index' },
  { sym: 'NAS100_USD', cls: 'index' },
  { sym: 'US30_USD',   cls: 'index' },
  { sym: 'DE30_EUR',   cls: 'index' },
  { sym: 'WTICO_USD',  cls: 'energy' },
  { sym: 'BCO_USD',    cls: 'energy' },
];

const MIN_A = 40;          // entries on the search half before a rule is a candidate
const MIN_B = 25;          // entries on the time holdout before it can be judged
const MIN_P = 40;          // entries on the unseen instruments before it can be judged
const CARRY = 10;          // candidates per timeframe that reach the holdouts
const PAIR_SEED = 8;       // best singles crossed with each other
const MIN_INSTRUMENTS = 3; // unseen instruments a rule must work on individually

/**
 * Split the universe in two, keeping each class balanced across the halves.
 *
 * Deterministic — alternating within each class after sorting — because a
 * random split would give a different answer every week and there would be no
 * way to tell a rule dying from the split moving under it.
 */
function splitUniverse(universe = UNIVERSE) {
  const byClass = {};
  for (const u of universe) (byClass[u.cls] = byClass[u.cls] || []).push(u);
  const search = [], proof = [];
  for (const cls of Object.keys(byClass).sort()) {
    const list = [...byClass[cls]].sort((a, b) => a.sym.localeCompare(b.sym));
    list.forEach((u, i) => (i % 2 === 0 ? search : proof).push(u));
  }
  return { search, proof };
}

/**
 * How many of the unseen instruments this rule actually paid on, one at a time.
 *
 * The pooled number can be carried by a single instrument doing all the work.
 * Six of eight individually is a different and much stronger statement, and it
 * is the one that cannot be produced by one lucky market.
 */
function perInstrument(sets, rule, dir, hold, inSlice, baselinesBySym, exit = null) {
  const pred = f => rule.all.every(k => f.keys.has(k));
  const rows = [];
  for (const s of sets) {
    const r = runAll([s], pred, hold, dir, inSlice, exit);
    const b = baselinesBySym[`${s.sym}|${dir}|${hold}${exit ? `|${exit.id}` : ''}`];
    if (!r || !b || r.n < 5) continue;
    rows.push({ sym: s.sym, n: r.n, expR: r.expR, edgeR: +(r.expR - b.expR).toFixed(3) });
  }
  const positive = rows.filter(r => r.edgeR > 0).length;
  return { rows, tested: rows.length, positive };
}

/**
 * The verdict, over BOTH holdouts.
 *
 * Deliberately harder than the narrow study's. It has to be: the search is a
 * hundred times wider, so the bar for calling something real has to move with
 * it or the extra scope buys nothing but extra ways to be fooled.
 */
function wideVerdict(r) {
  const A = r.discovery, B = r.holdout, P = r.unseen;
  if (!A || !B || B.n < MIN_B) return 'thin';
  if (!P || P.n < MIN_P) return 'untested elsewhere';

  const strict = zFor(CARRY);
  const timeOk = B.edgeR > 0 && Math.sign(B.edgeR) === Math.sign(A.edgeR);
  const instOk = P.edgeR > 0 && r.spread.positive >= MIN_INSTRUMENTS;

  if (!timeOk && !instOk) return 'fails';
  // Named separately rather than collapsed, because they are different
  // failures. One is "real here, may be only here". The other is "general, may
  // be stale".
  if (timeOk && !instOk) return 'this market only';
  if (!timeOk && instOk) return 'generalises, not current';

  // ── A POSITIVE SIGN IS NOT A RESULT ──────────────────────────────────────
  //
  // The first version of this returned "holds" as soon as both holdouts came
  // back positive, and that is a coin flip twice. Run end to end against pure
  // random-walk data, where there is nothing to find by construction, it
  // reported seven of ten carried rules as holding. Which is roughly what the
  // arithmetic predicts: half the time the time holdout is positive, half the
  // time the instrument holdout is, and three of eight markets positive is
  // likelier than not. About one in five survives by chance, and ten were
  // carried.
  //
  // So both holdouts have to be significant, not merely the right sign, and
  // the unseen one is held to the corrected threshold because it is the claim
  // being made. Anything positive but not significant is a FADE — worth
  // printing, not worth trading.
  const bSig = B.t != null && B.t >= 1.96;
  const pSig = P.t != null && P.t >= 1.96;
  if (!bSig || !pSig) return 'fades';
  if (B.t >= strict && P.t >= strict) return 'confirmed';
  return 'holds';
}

// ── The study ───────────────────────────────────────────────────────────────

async function runRegimeSearch({ oanda, log = () => {}, now = Date.now(),
                                 universe = UNIVERSE, timeframes = TIMEFRAMES,
                                 years = YEARS } = {}) {
  const M = await import(SHARED);
  const X = await loadExits();
  const from = now - years * 365 * 86400e3;
  const recentStart = now - RECENT_DAYS * 86400e3;
  const { search, proof } = splitUniverse(universe);

  log(`Wide search: ${search.length} instruments searched, ${proof.length} held back`);
  log(`  searched: ${search.map(u => u.sym).join(', ')}`);
  log(`  unseen:   ${proof.map(u => u.sym).join(', ')}`);

  const out = [];
  const skipped = [];

  for (const { tf, ms, holds, years: tfYears } of timeframes) {
    const bars = {};
    const tfFrom = now - (tfYears ?? years) * 365 * 86400e3;
    for (const u of universe) {
      try {
        const cs = await oanda.getCandlesSince(u.sym, tf, tfFrom, { to: now, max: 200000 });
        // A short series is dropped rather than padded. An instrument with two
        // years where the others have four would be searched over a different
        // market and pooled as though it were the same one.
        if (!cs || cs.length < 2000) { skipped.push(`${u.sym} ${tf} (${cs?.length || 0} bars)`); continue; }
        bars[u.sym] = cs;
      } catch (e) {
        skipped.push(`${u.sym} ${tf} (${String(e.message).slice(0, 60)})`);
      }
    }
    const have = u => !!bars[u.sym];
    const S = search.filter(have), P = proof.filter(have);
    if (S.length < 3 || P.length < 3) {
      log(`Wide search: ${tf} skipped — ${S.length} searched and ${P.length} unseen is too few to split`);
      continue;
    }
    log(`Wide search: ${tf} — ${S.length} searched, ${P.length} unseen, `
      + `${Object.values(bars).reduce((a, c) => a + c.length, 0).toLocaleString()} bars`);

    const setFor = (list) => list.map((u) => {
      const f = M.featureSeries(bars[u.sym], { sym: u.sym });
      for (const row of f) if (row) row.keys = new Set(M.keysOf(row));
      return { sym: u.sym, cls: u.cls, cs: bars[u.sym], feats: f };
    });
    const sSets = setFor(S), pSets = setFor(P);

    const holdMsOf = h => h * ms;
    for (const hold of holds) {
      const holdMs = holdMsOf(hold);
      const slices = {
        // Search and time-holdout live in the RECENT window, alternating
        // fortnights, exactly as the narrow study splits them.
        discovery: f => f.t >= recentStart && sideOf(f.t, recentStart, holdMs) === 'A',
        holdout:   f => f.t >= recentStart && sideOf(f.t, recentStart, holdMs) === 'B',
        // The instrument holdout gets the WHOLE window. Nothing was searched
        // there, so there is nothing to hide from.
        unseen:    () => true,
      };

      // One set of baselines PER EXIT. A rule on a two-ATR stop compared against
      // a one-ATR baseline would report the stop width as an edge, which is the
      // most obvious way searching exits could manufacture a result.
      const baselines = {};
      const perSymBase = {};
      for (const ex of X.EXITS) {
        for (const dir of DIRS) {
          baselines[`discovery|${dir}|${hold}|${ex.id}`] = baselineFor(sSets, hold, dir, slices.discovery, ex);
          baselines[`holdout|${dir}|${hold}|${ex.id}`]   = baselineFor(sSets, hold, dir, slices.holdout, ex);
          baselines[`unseen|${dir}|${hold}|${ex.id}`]    = baselineFor(pSets, hold, dir, slices.unseen, ex);
          for (const s of pSets) {
            perSymBase[`${s.sym}|${dir}|${hold}|${ex.id}`] = baselineFor([s], hold, dir, slices.unseen, ex);
          }
        }
      }

      // ── Search, on the searched instruments' discovery fortnights only ────
      const seen = new Map();
      let discBars = 0;
      for (const s of sSets) {
        for (const f of s.feats) {
          if (!f || !slices.discovery(f)) continue;
          discBars++;
          for (const k of f.keys) seen.set(k, (seen.get(k) || 0) + 1);
        }
      }
      const singles = [...seen.entries()]
        .filter(([, n]) => n >= MIN_SEEN && n <= 0.8 * discBars)
        .map(([k]) => ({ all: [k] }));

      // Score a rule under ONE exit. The exit is part of the hypothesis, chosen
      // on the discovery half exactly like the entry, and the holdout judges
      // the pair. Choosing the entry on discovery and then shopping for an exit
      // on the holdout would be fitting the holdout, which is the one thing
      // this whole design exists to prevent.
      const scoreOn = (rule, dir, ex) => {
        const pred = f => rule.all.every(k => f.keys.has(k));
        const out = { id: `${rule.all.join('&')}|${dir}|${hold}|${ex.id}`,
                      all: rule.all, dir, hold, exit: ex.id, exitLabel: ex.label };
        for (const name of ['discovery', 'holdout']) {
          const r = runAll(sSets, pred, hold, dir, slices[name], ex);
          const b = baselines[`${name}|${dir}|${hold}|${ex.id}`];
          out[name] = r && b ? {
            n: r.n, expR: r.expR, win: r.win, resolved: r.resolved,
            medBars: r.medBars, openPct: r.openPct,
            baseExpR: b.expR, baseWin: b.win, baseN: b.n,
            edgeR: +(r.expR - b.expR).toFixed(3),
            t: welch(r.rs, b.rs),
          } : null;
        }
        return out;
      };

      const searched = [];
      for (const rule of singles) {
        for (const dir of DIRS) {
          for (const ex of X.EXITS) {
            const r = scoreOn(rule, dir, ex);
            if (r.discovery && r.discovery.n >= MIN_A) searched.push(r);
          }
        }
      }

      // Interactions, from the best singles only. The full cross is thousands
      // of tests over the same bars and would find something whatever the data
      // said.
      const family = k => k.split('=')[0];
      const seeds = searched
        .filter(r => r.discovery.t != null)
        .sort((a, b) => Math.abs(b.discovery.t) - Math.abs(a.discovery.t))
        .slice(0, PAIR_SEED);
      const pairSeen = new Set();
      for (const a of seeds) {
        for (const b of seeds) {
          const ka = a.all[0], kb = b.all[0];
          if (ka === kb || family(ka) === family(kb)) continue;
          const id = [ka, kb].sort().join('&');
          if (pairSeen.has(id)) continue;
          pairSeen.add(id);
          for (const dir of DIRS) {
            for (const ex of X.EXITS) {
              const r = scoreOn({ all: id.split('&') }, dir, ex);
              if (r.discovery && r.discovery.n >= MIN_A) searched.push(r);
            }
          }
        }
      }

      // ── Carry the best to BOTH holdouts ──────────────────────────────────
      const carried = searched
        .filter(r => r.discovery.edgeR > 0)
        .sort((a, b) => b.discovery.edgeR - a.discovery.edgeR)
        .slice(0, CARRY);

      for (const r of carried) {
        const pred = f => r.all.every(k => f.keys.has(k));
        const ex = X.exitById(r.exit) || X.DEFAULT_EXIT;
        const u = runAll(pSets, pred, r.hold, r.dir, slices.unseen, ex);
        const ub = baselines[`unseen|${r.dir}|${r.hold}|${ex.id}`];
        r.unseen = u && ub ? {
          n: u.n, expR: u.expR, win: u.win, resolved: u.resolved,
          baseExpR: ub.expR, baseWin: ub.win,
          edgeR: +(u.expR - ub.expR).toFixed(3),
          t: welch(u.rs, ub.rs),
        } : null;
        r.spread = perInstrument(pSets, r, r.dir, r.hold, slices.unseen, perSymBase, ex);
        r.tf = tf;
        r.label = r.all.map(k => M.PHRASE[k] || k).join(' + ');
        r.verdict = wideVerdict(r);

        // ── Which half was wrong ─────────────────────────────────────────────
        //
        // The same entry, on the unseen markets, under EVERY exit. This is the
        // question the whole file was built to answer: an entry that pays with
        // no stop and loses with one is a direction that works and a stop that
        // does not, and a bare "it failed" hides which.
        const byExit = {};
        for (const other of X.EXITS) {
          const ru = runAll(pSets, pred, r.hold, r.dir, slices.unseen, other);
          const bu = baselines[`unseen|${r.dir}|${r.hold}|${other.id}`];
          byExit[other.id] = ru && bu
            ? { n: ru.n, expR: ru.expR, edgeR: +(ru.expR - bu.expR).toFixed(3), t: welch(ru.rs, bu.rs) }
            : null;
        }
        r.byExit = byExit;
        r.diagnosis = X.exitDiagnosis(byExit);
        delete r.discovery.rs; delete r.holdout?.rs;
        out.push(r);
      }

      log(`Wide search: ${tf} ${hold} bars — ${singles.length} conditions, `
        + `${searched.length} scored, ${carried.length} carried, `
        + `${carried.filter(r => r.verdict === 'confirmed' || r.verdict === 'holds').length} held both`);
    }
  }

  const rank = { confirmed: 0, holds: 1, fades: 2, 'generalises, not current': 3,
                 'this market only': 4, fails: 5, thin: 6, 'untested elsewhere': 7 };
  out.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9)
    || (b.unseen?.edgeR ?? -9) - (a.unseen?.edgeR ?? -9));

  const tally = out.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  log('Wide search: ' + Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', '));

  return {
    asOf: new Date(now).toISOString(),
    methodVersion: METHOD_VERSION,
    years,
    timeframes: timeframes.map(t => ({ tf: t.tf, years: t.years ?? years, holds: t.holds })),
    exits: X.EXITS.map(e => ({ id: e.id, label: e.label })),
    split: { searched: search.map(u => u.sym), unseen: proof.map(u => u.sym) },
    skipped,
    thresholds: { MIN_A, MIN_B, MIN_P, CARRY, MIN_INSTRUMENTS, holdoutZ: +zFor(CARRY).toFixed(2) },
    method: {
      note: 'Two holdouts. Rules are searched on alternating fortnights of one half of '
          + 'the instruments, then scored on the fortnights in between AND on instruments '
          + 'never looked at during the search. A rule must clear both to be reported as '
          + 'holding, and must pay individually on at least '
          + `${MIN_INSTRUMENTS} of the unseen markets — a pooled edge can be carried by one `
          + 'lucky instrument. Every number is against what every other bar in the same '
          + 'slice paid over the same window with the same stop.',
    },
    rules: out,
    tally,
  };
}

module.exports = {
  runRegimeSearch,
  splitUniverse, perInstrument, wideVerdict,
  UNIVERSE, TIMEFRAMES, METHOD_VERSION,
  MIN_A, MIN_B, MIN_P, CARRY, MIN_INSTRUMENTS,
};

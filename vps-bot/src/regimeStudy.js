'use strict';
// vps-bot/src/regimeStudy.js
//
// What is working NOW, and what was different about the moves that mattered.
//
// Every other study in this repository has the same shape: take a pattern
// somebody else named — a candle formation, a COT extreme, the gold-silver
// ratio, an hour of the day — measure it over five years, report "no". Four
// times out of four. That is confirmatory testing. It can only rule out things
// already in the vocabulary, and averaging over five years buries anything that
// started working in March under four years of when it did not.
//
// This one runs the other way round. It names nothing in advance. It describes
// the state of the market at every bar in terms that are computable in real
// time (shared/moveFeatures.mjs), searches recent history for the states that
// precede the moves, and then — the part that has never been done here — proves
// or kills each survivor on a slice of that same history it was never allowed
// to look at.
//
// ── The four things that keep this honest ───────────────────────────────────
//
// A HOLDOUT, not a correction. Half of recent history is hidden during the
// search. Survivors are scored on the hidden half. Every previous study here
// was in-sample with a Bonferroni applied afterwards, which is weaker: a
// correction penalises you for the tests you admit to, and a search over a
// hundred conditions is a hundred tests whether or not anyone counts them.
//
// INTERLEAVED, not chronological. The two halves are alternating fortnights,
// not the first six months and the last six. Split by date and the holdout is a
// different market — a rule dies because November was not June, and there is no
// way to tell that apart from the rule being fake. Alternating fortnights put
// both halves in the same regime, which is the only fair test of "does this
// work now".
//
// NO TRADE STRADDLES THE FENCE. An entry within the holding period of a block
// boundary is dropped. Otherwise a trade selected in the discovery half is
// scored partly on holdout bars, and the holdout is no longer unseen.
//
// AND "NEW" IS MEASURED. Every survivor is scored a third time on the three
// years BEFORE the recent window. Working now is only interesting if it did not
// work then; if it worked then too, it is not news, it is just an edge — and if
// it worked then and not now, that is the more useful warning.
//
// ── What it cannot do ───────────────────────────────────────────────────────
//
// It cannot promise an edge exists. A year of hourly gold is about six thousand
// bars and a few dozen independent trades per rule, which is enough to reject a
// weak claim and not enough to confirm a small one. So the verdict is graded
// rather than binary — confirmed / holds / fades / fails / thin — and the
// counts are printed next to every number so nobody has to take the label's
// word for it.
//
// It also has no news in it. The headline and calendar archives are weeks old,
// not years, so a four-year study cannot use them; the news read stays where it
// already is, on the instrument card. What is here is price structure, the
// clock, and what the other metal is doing.

const path = require('path');
const { pathToFileURL } = require('url');
const { tradeRun } = require('./feed');

const SHARED = pathToFileURL(path.join(__dirname, '..', '..', 'shared', 'moveFeatures.mjs')).href;
const MACRO = pathToFileURL(path.join(__dirname, '..', '..', 'shared', 'macroFit.mjs')).href;

// ── Shape of the study ──────────────────────────────────────────────────────

// Bumped whenever a condition's DEFINITION changes, so the published answer is
// rebuilt rather than sitting there for a week describing a market measured a
// different way. Age is not enough on its own: version 1's round-number feature
// was an artefact of gold doubling in price, and a file that is six days old is
// six days of a wrong answer.
//
//   2 — round numbers gridded off price rather than a fixed $25/50c, and
//       proximity as a share of the grid rather than of ATR.
//   3 — the dollar and the ten-year enter as conditions: how much of the metal
//       is macro-explained, whether its dollar relationship is the normal one
//       or has broken, and how far it has moved beyond what the two account for.
//   4 — candles enter, as two separate questions. The strict sweep-and-reclaim
//       hammer and star, and the app's 34-pattern registry graded by its own
//       strength label instead of flattened into bullish/bearish/doji the way
//       the strategy builder flattens it. Conditions too rare or too common to
//       test are now reported rather than silently dropped, because "it fired
//       thirty-one times in a year" is a different answer from "it failed".
const METHOD_VERSION = 4;

const TF = 'H1';
const RECENT_DAYS = 365;        // "these days"
const PRIOR_DAYS  = 365 * 3;    // the before, for the novelty comparison
const BLOCK_MS    = 14 * 86400e3;  // a fortnight — the alternating unit
const HOLDS       = [12, 24];   // half a day and a day, on H1
const STOP_ATR    = 1.0;        // one ATR, fixed; a stop grid here would be
                                // another dimension to search and another way
                                // to find noise
const DIRS = ['up', 'down'];

const MIN_A = 30;               // entries needed on the search half to be a candidate
const MIN_SEEN = 150;           // discovery bars a condition must occur on to be testable
const MIN_B = 20;               // entries needed on the holdout to say anything at all
const CARRY = 12;               // how many candidates reach the holdout — this is the
                                // number the holdout is corrected for, and it is small
                                // BECAUSE the selection already happened elsewhere

const PAIR_SEED = 10;           // best singles that get crossed with each other

// The zigzag that finds the turns for the anatomy. One ATR, not two: at two,
// every leg the zigzag reports is two ATR or longer by construction, so there
// are no small ones left and "what did the moves that FIZZLED have in common"
// — the comparison that makes the whole description mean anything — comes back
// with an empty set. Measured: at k=2 it found 265 turns and 0 fizzles.
const ZIGZAG_K = 1.0;
const BIG_LEG = 3;              // a pivot that started a real run
const SMALL_LEG = 1.75;         // and one that went nowhere

// The instruments. Gold and silver are scored separately and pooled, because a
// condition that works on gold's last year and not on silver's is a fact about
// twelve months of one chart.
const METALS = [
  { sym: 'XAU_USD', label: 'Gold' },
  { sym: 'XAG_USD', label: 'Silver' },
];

// The two things gold is mostly a function of.
//
// EUR/USD is inverted so the series RISES when the dollar strengthens — every
// sign downstream depends on that and it is done in one place, visibly, rather
// than being buried in a regression. USB10Y_USD is a bond, and whether OANDA
// serves it as a price or a yield is decided from the data rather than from its
// label; the app's own intermarket.js calls it a yield while quoting a price.
const DOLLAR = 'EUR_USD';
const RATE = 'USB10Y_USD';

// ── Statistics ──────────────────────────────────────────────────────────────

// Acklam's inverse normal, the same one src/utils/confluence.js uses for
// zFor(). Duplicated rather than imported: that file is app ESM with its own
// dependency tree, and a study on the VPS should not be able to break by
// something changing in a React util.
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
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 1 - pl) return -probit(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
const zFor = (tests = 1) => (tests > 1 ? probit(1 - 0.05 / (2 * tests)) : 1.96);

// Two sets of trade results, compared on the thing that actually matters: R per
// trade. A win rate can rise while expectancy falls — more small wins and the
// same big losses — so the win rate is reported and the test is run on R.
function welch(a, b) {
  if (a.length < 5 || b.length < 5) return null;
  const mean = x => x.reduce((s, v) => s + v, 0) / x.length;
  const varn = (x, m) => x.reduce((s, v) => s + (v - m) * (v - m), 0) / (x.length - 1);
  const m1 = mean(a), m2 = mean(b);
  const se = Math.sqrt(varn(a, m1) / a.length + varn(b, m2) / b.length);
  return se > 0 ? +((m1 - m2) / se).toFixed(2) : null;
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// ── Splitting recent history ────────────────────────────────────────────────
//
// Alternating fortnights. Block 0 is discovery, block 1 is holdout, block 2 is
// discovery again. Bars within HOLD of a boundary belong to neither, so no
// trade selected on one side is scored on the other.
function blockOf(t, start) { return Math.floor((t - start) / BLOCK_MS); }

function sideOf(t, start, holdMs) {
  const b = blockOf(t, start);
  if (b < 0) return null;
  const into = t - (start + b * BLOCK_MS);
  // A trade opened here would still be running when the block ends.
  if (into > BLOCK_MS - holdMs) return null;
  return b % 2 === 0 ? 'A' : 'B';
}

// ── Scoring a rule ──────────────────────────────────────────────────────────
//
// Entries are spaced by the holding period. A condition that is true for six
// hours running is one opportunity, not six, and counting it six times is the
// single easiest way to turn thirty independent observations into a hundred and
// eighty fake ones.
function entriesOf(feats, pred, hold, inSlice) {
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < feats.length; i++) {
    const f = feats[i];
    if (!f) continue;
    if (i + hold >= feats.length) break;
    if (inSlice && !inSlice(f)) continue;
    if (i - last < hold) continue;
    if (!pred(f)) continue;
    out.push(i);
    last = i;
  }
  return out;
}

// Run every entry as a real trade: in at the bar's close, out at a stop, a
// target at twice the stop, or the end of the window. Both touched inside one
// bar is scored as the loss — hourly OHLC cannot order them, and assuming the
// target is how a backtest manufactures an edge that does not survive contact.
function runAll(sets, pred, hold, dir, inSlice) {
  const rs = [];
  let tgt = 0, stp = 0, open = 0;
  const bars = [];
  for (const s of sets) {
    for (const i of entriesOf(s.feats, pred, hold, inSlice)) {
      const r = tradeRun(s.cs, i, hold, s.feats[i].atr, dir, STOP_ATR);
      rs.push(r.r);
      bars.push(r.n);
      if (r.open) open++;
      else if (r.r > 0) tgt++;
      else stp++;
    }
  }
  if (!rs.length) return null;
  const resolved = tgt + stp;
  return {
    n: rs.length,
    expR: +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3),
    win: resolved ? Math.round((tgt / resolved) * 100) : null,
    resolved,
    openPct: Math.round((open / rs.length) * 100),
    medBars: median(bars),
    rs,
  };
}

// What every bar in the same slice would have paid, run the same way. Not 50%,
// not zero: the market's own drift over the same window, in the same direction,
// with the same stop. Measured on a live board once before — nearly every
// bullish pattern "worked" and nearly every bearish one "failed", across every
// asset class at once. That is not pattern skill. That is a rising market.
function baselineFor(sets, hold, dir, inSlice) {
  return runAll(sets, () => true, hold, dir, inSlice);
}

// One candidate, fully scored: the search half, the untouched half, and the
// three years before.
//
// `f.keys` is precomputed once per bar rather than rebuilt here — this predicate
// runs on the order of ten million times across a full search, and rebuilding a
// Set inside it turns a two-minute study into a twenty-minute one.
function scoreRule(rule, dir, hold, sets, slices, baselines) {
  const pred = f => rule.all.every(k => f.keys.has(k));
  const out = { id: `${rule.all.join('&')}|${dir}|${hold}`, all: rule.all, dir, hold };
  for (const [name, inSlice] of Object.entries(slices)) {
    const r = runAll(sets, pred, hold, dir, inSlice);
    const b = baselines[`${name}|${dir}|${hold}`];
    out[name] = r && b ? {
      n: r.n, expR: r.expR, win: r.win, resolved: r.resolved,
      medBars: r.medBars, openPct: r.openPct,
      baseExpR: b.expR, baseWin: b.win, baseN: b.n,
      edgeR: +(r.expR - b.expR).toFixed(3),
      t: welch(r.rs, b.rs),
    } : null;
  }
  return out;
}

// ── The verdict ─────────────────────────────────────────────────────────────
//
// Graded, not binary. A year of hourly bars gives a few dozen independent
// trades per rule; that is enough to reject a weak claim and not enough to
// confirm a small one, and a yes/no label would report "no" for both cases and
// hide the difference.
function verdictOf(r) {
  const A = r.discovery, B = r.holdout;
  if (!A || !B || B.n < MIN_B) return 'thin';
  const strict = zFor(CARRY);
  const sameSign = Math.sign(B.edgeR) === Math.sign(A.edgeR);
  if (!sameSign || B.edgeR <= 0) return 'fails';
  if (B.t != null && B.t >= strict) return 'confirmed';
  if (B.t != null && B.t >= 1.96) return 'holds';
  return 'fades';
}

// Is it actually new? The same rule over the three years before the recent
// window. Working now AND then is an edge but not news; working then and not
// now is the more useful warning, and it is the one nobody ever prints.
function noveltyOf(r) {
  const now = r.holdout?.edgeR ?? r.discovery?.edgeR;
  const before = r.prior;
  if (now == null) return null;
  if (!before || before.n < MIN_B) return 'no-history';
  const d = now - before.edgeR;
  // The dead band matters. Three years of bars will hand back an edge of two or
  // three hundredths of an R on almost anything, and treating that as "it
  // worked before too" turns every genuinely new finding into a longstanding
  // one. Anything inside ±0.05R counts as nothing happening.
  const NIL = 0.05;
  if (before.edgeR <= NIL && now > 0.1 && d >= 0.15) return 'new';
  if (before.edgeR > NIL && now <= 0) return 'faded';
  if (before.edgeR > NIL && now > 0) return d >= 0.2 ? 'stronger-now' : 'longstanding';
  return 'marginal';
}

// ── Anatomy: what the moves that mattered had in common ─────────────────────
//
// This half of the study does not trade anything and is not allowed to. A
// zigzag pivot at bar 100 is not known until bar 112, so every event here is
// identified with hindsight by construction. It is a description of what
// accompanied the reversals and the runs — the answer to "why did it turn" —
// and the rules above are where anything tradeable has to prove itself.
function anatomy(events, feats, keysOf, { big = BIG_LEG, small = SMALL_LEG, minN = 8, from = 0 } = {}) {
  // The base rate: how often each condition is simply true, on any bar — over
  // the SAME window the events came from. Counting the base over four years
  // while the events are from one is how a condition that simply became more
  // common reads as a cause.
  const baseCount = new Map();
  let baseBars = 0;
  for (const f of feats) {
    if (!f || f.t < from) continue;
    baseBars++;
    for (const k of keysOf(f)) baseCount.set(k, (baseCount.get(k) || 0) + 1);
  }
  if (!baseBars) return { definition: 'no bars in window', bars: 0 };

  const describe = (subset) => {
    const c = new Map();
    for (const e of subset) {
      const f = feats[e.i];
      if (!f) continue;
      for (const k of keysOf(f)) c.set(k, (c.get(k) || 0) + 1);
    }
    const rows = [];
    for (const [k, n] of c) {
      if (n < minN) continue;
      const base = (baseCount.get(k) || 0) / baseBars;
      if (!(base > 0)) continue;
      const at = n / subset.length;
      rows.push({
        key: k, n,
        atEvent: +(at * 100).toFixed(1),
        atAnyBar: +(base * 100).toFixed(1),
        lift: +(at / base).toFixed(2),
      });
    }
    return rows.sort((x, y) => y.lift - x.lift);
  };

  const shape = (subset) => ({
    n: subset.length,
    inAtr: +(median(subset.map(e => e.inAtr)) ?? 0).toFixed(2),
    inBars: median(subset.map(e => e.inBars)),
    outAtr: +(median(subset.map(e => e.outAtr)) ?? 0).toFixed(2),
    outBars: median(subset.map(e => e.outBars)),
    // ATR per bar on the leg INTO the turn. Whether a move arrives as a spike
    // or as a grind is the difference nobody measures and everybody argues
    // about.
    speed: +(median(subset.map(e => e.inBars > 0 ? e.inAtr / e.inBars : 0)) ?? 0).toFixed(3),
  });

  // The comparison that carries the actual information.
  //
  // "Price was falling into it" is true of almost every low, so measuring a
  // turn against all bars mostly rediscovers the definition of a low. Measuring
  // the turns that RAN against the turns that DIED removes that: both sets are
  // pivots, both were preceded by a move against them, and whatever is left is
  // the difference between the one worth taking and the one that costs money.
  const separates = (a, b, minEach = minN) => {
    const count = (subset) => {
      const c = new Map();
      for (const e of subset) {
        const f = feats[e.i];
        if (!f) continue;
        for (const k of keysOf(f)) c.set(k, (c.get(k) || 0) + 1);
      }
      return c;
    };
    if (!a.length || !b.length) return [];
    const ca = count(a), cb = count(b);
    const rows = [];
    for (const k of new Set([...ca.keys(), ...cb.keys()])) {
      const na = ca.get(k) || 0, nb = cb.get(k) || 0;
      if (na + nb < minEach * 2) continue;
      // Half a count added to each side before dividing. A condition present at
      // every turn that ran and none that died is the strongest separator there
      // is, and a bare ratio drops it for dividing by zero — which throws away
      // exactly the row worth reading. The percentages either side are the raw
      // ones; only the ratio is smoothed, and it is bounded rather than
      // infinite because a sample of thirty cannot support "infinitely".
      const pa = (na + 0.5) / (a.length + 1);
      const pb = (nb + 0.5) / (b.length + 1);
      rows.push({
        key: k,
        atRan: +((na / a.length) * 100).toFixed(1),
        atDied: +((nb / b.length) * 100).toFixed(1),
        ratio: +(pa / pb).toFixed(2), nRan: na, nDied: nb,
      });
    }
    return rows.sort((x, y) => Math.abs(Math.log(y.ratio)) - Math.abs(Math.log(x.ratio)));
  };

  const turned = events.filter(e => e.outAtr >= big);
  const fizzled = events.filter(e => e.outAtr < small);
  const ups = turned.filter(e => e.dir === 'up');
  const dns = turned.filter(e => e.dir === 'down');
  const fizzUps = fizzled.filter(e => e.dir === 'up');
  const fizzDns = fizzled.filter(e => e.dir === 'down');

  return {
    definition: `a pivot whose next leg ran ${big} ATR or more counts as a turn; `
      + `under ${small} ATR it fizzled. Both sets are pivots, so "ran vs died" is `
      + `the honest comparison — measuring a low against every bar mostly `
      + `rediscovers that lows have falling prices before them.`,
    turns: { ...shape(turned), up: ups.length, conditions: describe(turned).slice(0, 12) },
    fizzles: { ...shape(fizzled), conditions: describe(fizzled).slice(0, 12) },
    pumps: { ...shape(ups), conditions: describe(ups).slice(0, 12) },
    drops: { ...shape(dns), conditions: describe(dns).slice(0, 12) },
    // Why did this one run and that one not.
    ranVsDied: separates(turned, fizzled).slice(0, 14),
    pumpVsStall: separates(ups, fizzUps).slice(0, 10),
    dropVsStall: separates(dns, fizzDns).slice(0, 10),
    bars: baseBars,
  };
}

// Has the market itself changed? The plain frequency of each condition now
// against three years ago. Not a trade — a description of what kind of market
// this is, which is the part of "how does it react these days" that no
// win rate answers.
function drift(recentFeats, priorFeats, keysOf, minPct = 1) {
  const tally = (fs) => {
    const c = new Map(); let n = 0;
    for (const f of fs) { if (!f) continue; n++; for (const k of keysOf(f)) c.set(k, (c.get(k) || 0) + 1); }
    return { c, n };
  };
  const a = tally(recentFeats), b = tally(priorFeats);
  if (!a.n || !b.n) return [];
  const rows = [];
  for (const [k, n] of a.c) {
    const now = (n / a.n) * 100, then = ((b.c.get(k) || 0) / b.n) * 100;
    if (now < minPct && then < minPct) continue;
    rows.push({ key: k, nowPct: +now.toFixed(1), thenPct: +then.toFixed(1),
      changePct: +(now - then).toFixed(1),
      ratio: then > 0 ? +(now / then).toFixed(2) : null });
  }
  return rows.sort((x, y) => Math.abs(y.changePct) - Math.abs(x.changePct));
}

// ── The run ─────────────────────────────────────────────────────────────────

async function runRegimeStudy({ oanda, log = () => {}, now = Date.now(),
                                recentDays = RECENT_DAYS, priorDays = PRIOR_DAYS } = {}) {
  const M = await import(SHARED);
  const MF = await import(MACRO);

  const recentStart = now - recentDays * 86400e3;
  const priorStart  = recentStart - priorDays * 86400e3;

  // Pull once, split in memory. Two instruments, four years of hourly bars.
  const raw = {};
  for (const m of METALS) {
    const cs = await oanda.getCandlesSince(m.sym, TF, priorStart, { to: now });
    if (!cs || cs.length < 5000) return { error: `${m.sym}: only ${cs?.length || 0} bars` };
    raw[m.sym] = cs;
    log(`Regime study: ${m.label} ${cs.length} ${TF} bars from ${new Date(cs[0].t).toISOString().slice(0, 10)}`);
  }

  // The macro side. Missing it is a degraded study, not a failed one — the
  // price-structure conditions stand on their own, and an instrument the
  // account is not entitled to should cost those nothing.
  let dollar = null, rate = null, macroErr = null;
  try {
    const eur = await oanda.getCandlesSince(DOLLAR, TF, priorStart, { to: now });
    // Inverted here, in the open, so the series rises when the DOLLAR does.
    dollar = eur.map(c => ({ t: c.t, c: 1 / c.c }));
    rate = await oanda.getCandlesSince(RATE, TF, priorStart, { to: now });
    if (!dollar.length || !rate.length) throw new Error('empty series');
  } catch (e) {
    macroErr = e.message.slice(0, 120);
    dollar = rate = null;
    log(`Regime study: no macro leg — ${macroErr}`);
  }

  const macro = {};
  for (const m of METALS) {
    if (!dollar || !rate) { macro[m.sym] = null; continue; }
    macro[m.sym] = MF.macroSeries(raw[m.sym], { dollarUp: dollar, rate });
  }
  if (macro[METALS[0].sym]) {
    log(`Regime study: the ten-year reads as a ${macro[METALS[0].sym].rateKind}`
      + `${macro[METALS[0].sym].rateKind === null ? ' — sign left out rather than guessed' : ''}`);
  }

  // Features computed on the FULL series, then sliced. Computing them per slice
  // would restart the ATR and the previous-day levels at the slice boundary,
  // and the first fortnight of every block would be quietly wrong.
  const sets = [];
  const feats = {};
  for (const m of METALS) {
    const other = METALS.find(x => x.sym !== m.sym);
    const f = M.featureSeries(raw[m.sym], {
      sym: m.sym, partner: raw[other.sym], macro: macro[m.sym],
    });
    // The condition set for each bar, once. Rule predicates run tens of
    // millions of times across a full search and cannot afford to rebuild it.
    for (const row of f) if (row) row.keys = new Set(M.keysOf(row));
    feats[m.sym] = f;
    sets.push({ sym: m.sym, cs: raw[m.sym], feats: f });
  }

  const holdMsOf = h => h * 3600e3;
  const SLICES = {};
  for (const hold of HOLDS) {
    SLICES[hold] = {
      discovery: f => f.t >= recentStart && sideOf(f.t, recentStart, holdMsOf(hold)) === 'A',
      holdout:   f => f.t >= recentStart && sideOf(f.t, recentStart, holdMsOf(hold)) === 'B',
      prior:     f => f.t >= priorStart && f.t < recentStart,
    };
  }

  // Baselines once per slice, direction and horizon — the same numbers every
  // rule is measured against.
  const baselines = {};
  for (const hold of HOLDS) {
    for (const dir of DIRS) {
      for (const [name, inSlice] of Object.entries(SLICES[hold])) {
        baselines[`${name}|${dir}|${hold}`] = baselineFor(sets, hold, dir, inSlice);
      }
    }
  }

  // ── Search, on the discovery half only ────────────────────────────────────
  const disc = SLICES[HOLDS[0]].discovery;
  const seen = new Map();
  let discBars = 0;
  for (const s of sets) {
    for (const f of s.feats) {
      if (!f || !disc(f)) continue;
      discBars++;
      for (const k of f.keys) seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
  // A condition true on nearly every bar is not a condition — it is the market,
  // and it will score exactly the baseline. One true on nearly no bar cannot be
  // measured. Both ends are dropped before the search rather than after, so
  // neither inflates the number of tests the holdout is corrected for.
  //
  // What gets dropped is now REPORTED rather than silently discarded. "A strong
  // hammer fired thirty-one times in a year, which is too few to measure" is a
  // real answer to whether it is worth a toggle in the strategy builder, and it
  // is a different answer from "it was tested and it failed". Without this the
  // two are indistinguishable from the outside — the condition simply never
  // appears, and absence reads as rejection.
  const untested = [...seen.entries()]
    .filter(([, n]) => n < MIN_SEEN || n > 0.8 * discBars)
    .map(([k, n]) => ({
      key: k,
      n,
      why: n < MIN_SEEN ? 'too rare to measure' : 'true on most bars — that is the market, not a condition',
      pct: +((n / Math.max(1, discBars)) * 100).toFixed(2),
    }))
    .sort((a, b) => b.n - a.n);

  const singles = [...seen.entries()]
    .filter(([, n]) => n >= MIN_SEEN && n <= 0.8 * discBars)
    .map(([k]) => ({ all: [k] }));

  const searched = [];
  for (const rule of singles) {
    for (const dir of DIRS) {
      for (const hold of HOLDS) {
        const r = scoreRule(rule, dir, hold, sets, SLICES[hold], baselines);
        if (r.discovery && r.discovery.n >= MIN_A) searched.push(r);
      }
    }
  }

  // Interactions. Two conditions at once is the direction nothing here has
  // tried, and it is where a weak-but-real effect usually lives — the sweep
  // that only pays in a hot market, the stretch that only pays when the other
  // metal disagrees. Crossed from the best singles rather than all against all,
  // because the full cross is thousands of tests over the same six thousand
  // bars and would find something no matter what the data said.
  const family = k => k.split('=')[0];
  const seeds = [...searched]
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
        for (const hold of HOLDS) {
          const r = scoreRule({ all: id.split('&') }, dir, hold, sets, SLICES[hold], baselines);
          if (r.discovery && r.discovery.n >= MIN_A) searched.push(r);
        }
      }
    }
  }

  // ── Carry the best to the holdout ─────────────────────────────────────────
  // Ranked by edge on the discovery half AND by how much better it is than the
  // same rule was three years ago, because the question is what works now.
  const ranked = searched
    .filter(r => r.discovery.edgeR > 0)
    .sort((a, b) => {
      const na = a.prior ? a.discovery.edgeR - a.prior.edgeR : a.discovery.edgeR;
      const nb = b.prior ? b.discovery.edgeR - b.prior.edgeR : b.discovery.edgeR;
      return (nb + b.discovery.edgeR) - (na + a.discovery.edgeR);
    });

  const carried = ranked.slice(0, CARRY).map(r => ({
    ...r,
    label: M.labelOf({ all: r.all }),
    verdict: verdictOf(r),
    novelty: noveltyOf(r),
  }));

  // ── Anatomy and drift ─────────────────────────────────────────────────────
  const anat = {};
  const drifts = {};
  for (const m of METALS) {
    const cs = raw[m.sym];
    const atr = M.atrSeries(cs);
    const piv = M.zigzag(cs, atr, ZIGZAG_K);
    const legs = M.legsOf(piv, atr).filter(e => cs[e.i].t >= recentStart);
    const recentF = feats[m.sym].filter(f => f && f.t >= recentStart);
    const priorF  = feats[m.sym].filter(f => f && f.t >= priorStart && f.t < recentStart);
    anat[m.sym] = anatomy(legs, feats[m.sym], M.keysOf, { from: recentStart });
    drifts[m.sym] = drift(recentF, priorF, M.keysOf).slice(0, 15);
    log(`Regime study: ${m.label} — ${legs.length} pivots in the last year, `
      + `${anat[m.sym].turns?.n ?? 0} started a run of ${BIG_LEG} ATR or more, `
      + `${anat[m.sym].fizzles?.n ?? 0} went nowhere`);
  }

  // ── What is driving each metal, right now ─────────────────────────────────
  //
  // The thing the multi-agent diagrams promise and never deliver: one statement
  // of what is moving this instrument, with the number behind every clause. Not
  // a correlation — a decomposition, so "gold rallied" is separated into the
  // dollar falling and somebody buying gold, which are different trades.
  const drivers = {};
  for (const m of METALS) {
    const mm = macro[m.sym];
    if (!mm) { drivers[m.sym] = macroErr ? { unavailable: macroErr } : null; continue; }
    let i = mm.fits.length - 1;
    while (i > 0 && !mm.fits[i]) i--;
    const d = MF.describe(mm, i, { name: m.label.toLowerCase() });
    if (d) drivers[m.sym] = { ...d, at: mm.ts[i] };
  }

  // ── Where the market is right now ─────────────────────────────────────────
  const nowState = {};
  for (const m of METALS) {
    const f = [...feats[m.sym]].reverse().find(Boolean);
    if (!f) continue;
    nowState[m.sym] = {
      at: f.t, close: +f.close.toFixed(3), atr: +f.atr.toFixed(3),
      keys: M.keysOf(f),
      plain: M.keysOf(f).map(k => M.PHRASE[k] || k),
      firing: carried.filter(r => r.verdict === 'confirmed' || r.verdict === 'holds')
        .filter(r => r.all.every(k => M.keysOf(f).includes(k)))
        .map(r => r.id),
    };
  }

  const tally = carried.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  log(`Regime study: searched ${searched.length} rule/direction/horizon combinations on the `
    + `discovery fortnights, carried ${carried.length} to the holdout — `
    + Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', '));

  return {
    asOf: new Date().toISOString(),
    methodVersion: METHOD_VERSION,
    tf: TF,
    method: {
      version: METHOD_VERSION,
      recentDays, priorDays, blockDays: BLOCK_MS / 86400e3,
      holds: HOLDS, stopAtr: STOP_ATR, rr: 2,
      searched: searched.length, carried: carried.length,
      holdoutZ: +zFor(CARRY).toFixed(2),
      note: 'Candidates were searched on alternating fortnights and scored on the '
          + 'fortnights in between, which the search never saw. Entries are spaced by '
          + 'the holding period so one condition lasting six hours counts once. Trades '
          + 'that would straddle a block boundary are dropped. Every number is against '
          + 'what every other bar in the same slice paid over the same window with the '
          + 'same stop, not against 50%.',
    },
    windows: {
      recentFrom: new Date(recentStart).toISOString(),
      priorFrom: new Date(priorStart).toISOString(),
      bars: Object.fromEntries(METALS.map(m => [m.sym, raw[m.sym].length])),
    },
    rules: carried,
    tally,
    untested,
    discBars,
    anatomy: anat,
    drift: drifts,
    now: nowState,
    drivers,
    macro: {
      dollar: DOLLAR, dollarNote: 'inverted, so the series rises when the dollar strengthens',
      rate: RATE,
      rateKind: macro[METALS[0].sym]?.rateKind ?? null,
      unavailable: macroErr,
    },
  };
}

module.exports = {
  runRegimeStudy,
  // Exported for tests: the holdout split, the entry spacing, the comparison
  // and the verdict are the four places this could quietly fake a result.
  sideOf, blockOf, entriesOf, welch, zFor, verdictOf, noveltyOf, anatomy, drift,
  BLOCK_MS, HOLDS, STOP_ATR, MIN_A, MIN_B, CARRY, METALS, TF,
  ZIGZAG_K, BIG_LEG, SMALL_LEG, METHOD_VERSION, MIN_SEEN,
};

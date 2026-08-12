'use strict';
// vps-bot/src/confluenceStudy.js
// Does evidence from different places actually combine into a better signal?
//
// This app is built on the claim that it does. The ranking is driven by
// BREADTH — how many independent families of evidence point the same way — and
// the premise is written into the top of confluence.js: "A reversal is not a
// candlestick. It is a candlestick AND a level being swept AND positioning
// being one-sided AND something in the calendar that explains why now."
//
// That claim has never been tested. Every measurement so far has been of
// single setups in isolation: does a tweezer bottom work, does a sweep work.
// The answer to those was no, and it was reported as though it settled the
// question. It does not. Noise plus noise is noise, but CONDITIONING is not
// adding — a sweep while real yields are falling and positioning is crowded the
// other way is a different situation from a sweep alone, and nobody has looked.
//
// ── What is being tested, and why it is one question and not a thousand ──────
//
// Not a search. The deep search already sweeps thousands of condition
// combinations and finds an edge in pure noise 38-49% of the time; running that
// across five families would manufacture findings rather than discover them.
//
// Instead, one hypothesis with a shape that noise cannot easily fake:
//
//     is the forward edge MONOTONIC in the number of agreeing families?
//
// One agreeing family, then two, then three, then four — each beating its own
// baseline by more than the last. If confluence is real the line climbs. If it
// is not, the numbers wander. That is four buckets and one shape, so no
// multiple-comparison correction is needed, and the result cannot be salvaged
// by picking the best bucket afterwards.
//
// ── Discipline ──────────────────────────────────────────────────────────────
//
// Every direction below is PRE-SPECIFIED from the textbook relationship, never
// chosen by looking at which sign fits. Falling real yields are bullish gold
// because that is the documented mechanism, not because it tested better that
// way. A study that picks its own signs is a search wearing a disguise.
//
// And nothing may use information from after the bar it is scored on. The
// structure detectors already handle this — a swing point is only known once
// the bars after it have printed — and the macro and positioning joins take
// the last value published ON OR BEFORE the bar's date, with COT's reporting
// lag applied on top.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { detectSweeps, detectBreaks, atrSeries } = require('./feed');

// The forward window, matching the feed's daily horizon so the numbers here can
// be read next to the ones on the cards.
const HORIZON = 10;

// Reversal patterns and the way they point. Same map the app displays from.
const REVERSAL = {
  hammer:'up', inv_hammer:'up', dragonfly_doji:'up', bull_engulf:'up',
  piercing_line:'up', bull_harami:'up', tweezer_bottom:'up', morning_star:'up',
  three_inside_up:'up', abandoned_bull:'up', kicker_bull:'up',
  shooting_star:'down', hanging_man:'down', gravestone_doji:'down',
  bear_engulf:'down', dark_cloud:'down', bear_harami:'down', tweezer_top:'down',
  evening_star:'down', three_inside_dn:'down', abandoned_bear:'down', kicker_bear:'down',
};

// ── Macro ────────────────────────────────────────────────────────────────────
//
// Three relationships, each stated before looking at any outcome:
//
//   real yields down      → gold and silver up   (the carry cost of holding a
//                                                 non-yielding asset falls)
//   yield curve steepens  → indices up           (the classic risk-on signal)
//   breakevens up         → energy and metals up (inflation expectations are
//                                                 priced into commodities)
//
// Measured as a 20-day change, because a level says nothing without a
// direction: a 4% ten-year is bullish or bearish depending entirely on where it
// came from.
const MACRO_LOOKBACK = 20;

function loadMacro(repoRoot) {
  const p = path.join(repoRoot, 'public', 'macro-data.json');
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const series = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v)) continue;
    const clean = v.filter(x => x && x.date && Number.isFinite(+x.val))
      .map(x => ({ t: Date.parse(x.date + 'T00:00:00Z'), val: +x.val }))
      .sort((a, b) => a.t - b.t);
    if (clean.length) series[k] = clean;
  }
  return series;
}

// The last value published on or before this instant. A study that reads
// tomorrow's CPI into today's decision is not measuring anything.
function asOf(series, t) {
  if (!series?.length || series[0].t > t) return null;
  let lo = 0, hi = series.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) { best = series[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

function changeOver(series, t, days) {
  const now = asOf(series, t);
  const then = asOf(series, t - days * 86400e3);
  if (!now || !then || now.t === then.t) return null;
  return now.val - then.val;
}

// Which way macro points for this instrument, or null if it says nothing about
// this class. Returns 'up' | 'down' | null.
function macroDirection(cls, sym, macro, t) {
  if (!macro) return null;
  if (cls === 'metal' || /^XA[UG]/.test(sym)) {
    const d = changeOver(macro.dfii10, t, MACRO_LOOKBACK);
    return d == null ? null : d < 0 ? 'up' : 'down';
  }
  if (cls === 'index') {
    const ten = changeOver(macro.dgs10, t, MACRO_LOOKBACK);
    const two = changeOver(macro.dgs2, t, MACRO_LOOKBACK);
    if (ten == null || two == null) return null;
    const steepening = ten - two;
    return steepening > 0 ? 'up' : 'down';
  }
  if (cls === 'energy') {
    const d = changeOver(macro.t10yie, t, MACRO_LOOKBACK);
    return d == null ? null : d > 0 ? 'up' : 'down';
  }
  return null;
}

// ── Per-bar state ────────────────────────────────────────────────────────────
// Volatility location, computed from bars up to and including i and nothing
// after. Mirrors the rangePos measure the feed publishes.
function rangePosAt(cs, i, win = 60) {
  const from = Math.max(0, i - win + 1);
  let hi = -Infinity, lo = Infinity;
  for (let k = from; k <= i; k++) { if (cs[k].h > hi) hi = cs[k].h; if (cs[k].l < lo) lo = cs[k].l; }
  return hi > lo ? ((cs[i].c - lo) / (hi - lo)) * 100 : 50;
}

// ── The study ────────────────────────────────────────────────────────────────

// One instrument's contribution: for every bar with a complete forward window,
// which families pointed which way, and what happened next.
function scanInstrument({ cs, sym, cls, macro, cot, patternsAt }) {
  if (!cs || cs.length < HORIZON + 80) return [];
  const atrAt = atrSeries(cs);
  const events = [...detectSweeps(cs), ...detectBreaks(cs)];
  const byBar = new Map();
  for (const e of events) {
    if (!byBar.has(e.at)) byBar.set(e.at, []);
    byBar.get(e.at).push(e);
  }

  const rows = [];
  for (let i = 60; i + HORIZON < cs.length; i++) {
    const t = cs[i].t;
    const a = atrAt(i);
    if (!a) continue;

    // ── families, each voting up / down / not at all ──
    const votes = {};

    if (patternsAt) {
      for (const id of patternsAt(cs, i)) {
        const d = REVERSAL[id];
        if (d) votes.price = votes.price === undefined ? d : (votes.price === d ? d : null);
      }
    }

    for (const e of byBar.get(t) || []) {
      const d = e.dir === 'up' ? 'up' : 'down';
      votes.structure = votes.structure === undefined ? d : (votes.structure === d ? d : null);
    }

    const rp = rangePosAt(cs, i);
    if (rp >= 98) votes.volatility = 'down';
    else if (rp <= 2) votes.volatility = 'up';

    const md = macroDirection(cls, sym, macro, t);
    if (md) votes.fundamental = md;

    // Positioning, read contrarian at an extreme — the standard interpretation,
    // fixed in advance. The COT report covers a Tuesday and is published the
    // following Friday, so nothing may be used until three days after its own
    // report date.
    if (cot?.length) {
      const p = asOf(cot, t - 3 * 86400e3);
      if (p) {
        if (p.val >= 90) votes.positioning = 'down';
        else if (p.val <= 10) votes.positioning = 'up';
      }
    }

    const dirs = Object.values(votes).filter(Boolean);
    if (!dirs.length) continue;
    const up = dirs.filter(d => d === 'up').length;
    const down = dirs.length - up;
    if (up === down) continue;              // no net direction, nothing to score
    const dir = up > down ? 'up' : 'down';
    const agree = Math.max(up, down);
    const against = Math.min(up, down);

    const raw = cs[i + HORIZON].c - cs[i].c;
    rows.push({
      sym, cls, t, dir, agree, against,
      families: Object.entries(votes).filter(([, d]) => d === dir).map(([f]) => f),
      signed: (dir === 'up' ? raw : -raw) / a,
    });
  }
  return rows;
}

// Every bar's outcome regardless of what fired, signed 'up'. The thing every
// bucket below has to beat — see baselineOutcome in feed.js for why 50% is the
// wrong benchmark.
function baselineRows(cs) {
  const atrAt = atrSeries(cs);
  const out = [];
  for (let i = 60; i + HORIZON < cs.length; i++) {
    const a = atrAt(i);
    if (a) out.push((cs[i + HORIZON].c - cs[i].c) / a);
  }
  return out;
}

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const winRate = a => a.length ? (a.filter(x => x > 0).length / a.length) * 100 : null;

// A difference of two proportions. Both samples carry uncertainty and the
// benchmark's is not zero.
function diffZ(w1, n1, w2, n2) {
  if (!n1 || !n2) return null;
  const p1 = w1 / 100, p2 = w2 / 100;
  const pool = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  return se > 0 ? (p1 - p2) / se : null;
}

// Aggregate into the buckets the hypothesis is about.
function summarise(rows, baseUp, { minBucket = 30 } = {}) {
  const baseWinUp = winRate(baseUp), baseMedUp = median(baseUp);
  const buckets = {};
  for (const r of rows) {
    const key = r.agree >= 4 ? '4+' : String(r.agree);
    (buckets[key] ||= []).push(r);
  }
  const out = [];
  for (const key of ['1', '2', '3', '4+']) {
    const b = buckets[key] || [];
    if (b.length < minBucket) { out.push({ agree: key, n: b.length, tooFew: true }); continue; }
    const moves = b.map(r => r.signed);
    // The benchmark mirrors with direction: a short's baseline is the up
    // baseline reflected, and a mixed bucket's is the blend.
    const upShare = b.filter(r => r.dir === 'up').length / b.length;
    const baseWin = upShare * baseWinUp + (1 - upShare) * (100 - baseWinUp);
    const baseMed = baseMedUp * (2 * upShare - 1);
    const win = winRate(moves), med = median(moves);
    out.push({
      agree: key,
      n: b.length,
      win: +win.toFixed(1),
      med: +med.toFixed(3),
      baseWin: +baseWin.toFixed(1),
      baseMed: +baseMed.toFixed(3),
      edgeWin: +(win - baseWin).toFixed(1),
      edgeMed: +(med - baseMed).toFixed(3),
      z: +(diffZ(win, moves.length, baseWin, baseUp.length) ?? 0).toFixed(2),
    });
  }
  return out;
}

// The verdict. Monotonic means each bucket's edge exceeds the one below it —
// the shape confluence predicts and noise has no reason to produce.
function verdict(summary) {
  const usable = summary.filter(s => !s.tooFew && s.edgeWin != null);
  if (usable.length < 3) {
    return { supported: false, reason: `only ${usable.length} bucket(s) had enough occurrences to judge` };
  }
  let monotonic = true;
  for (let i = 1; i < usable.length; i++) {
    if (usable[i].edgeWin <= usable[i - 1].edgeWin) { monotonic = false; break; }
  }
  const top = usable[usable.length - 1];
  const bottom = usable[0];
  return {
    supported: monotonic && top.edgeWin > 0 && Math.abs(top.z) > 1.96,
    monotonic,
    span: +(top.edgeWin - bottom.edgeWin).toFixed(1),
    topBucket: top.agree,
    topEdge: top.edgeWin,
    topZ: top.z,
    reason: !monotonic ? 'the edge does not increase with the number of agreeing families'
          : top.edgeWin <= 0 ? 'the widest confluence still does not beat its own baseline'
          : Math.abs(top.z) <= 1.96 ? 'the widest confluence beats its baseline but not significantly'
          : 'edge increases with breadth and the widest bucket clears its baseline',
  };
}

module.exports = {
  HORIZON, REVERSAL, MACRO_LOOKBACK,
  loadMacro, asOf, changeOver, macroDirection, rangePosAt,
  scanInstrument, baselineRows, summarise, verdict, diffZ, median, winRate,
};

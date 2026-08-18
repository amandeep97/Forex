'use strict';
// vps-bot/src/feed.js
// The 24/7 half of the Live Feed.
//
// The app can only measure things while it is open. A filter meant to answer
// "which instruments should I look at today" has to keep watching overnight and
// over the weekend, so the measuring happens here and the app only reads the
// result out of bot/feed.json.
//
// Two kinds of fact are published, and the distinction matters:
//
//   state  — continuously true right now (volatility percentile, where price
//            sits in its range, spread vs normal, fund positioning)
//   events — discrete, dated things that happened on a specific bar (a
//            liquidity sweep, a structure break) and stay relevant for a while
//
// A filter combines both: "swept the H4 low in the last 2 days AND volatility
// is still coiled" is a state predicate AND an event-within-window predicate.
//
// Events are re-derived from candle history on every refresh rather than being
// accumulated in memory. That makes a bot restart harmless, and it means the
// rarity figure ("this fires about 4× a month on gold") is honest from the
// first tick instead of after six months of collecting.

const path = require('path');
const { pathToFileURL } = require('url');
const fetch = require('node-fetch');
const { INSTRUMENTS } = require('./instruments');

// Instruments the app discovered on Binance and published to the repo.
//
// The static list is hand-typed from screenshots, so it is always a subset of
// what Binance actually lists. The app can see the full list — it can reach
// exchangeInfo from the browser — and writes it here; without this the feed
// covers whichever twenty someone typed in and silently misses the rest.
const TRADFI_PATH = 'bot/tradfi-instruments.json';
const { detectStrongReversal, findSwings } = require('./smc');
const { fetchCOTPercentile } = require('./cotFetcher');

const FEED_PATH = 'bot/feed.json';

const BIN_TF = { M15:'15m', M30:'30m', H1:'1h', H4:'4h', D:'1d' };
const TF_MS  = { M15: 900e3, M30: 1800e3, H1: 3600e3, H4: 14400e3, D: 86400e3 };

// How much history each timeframe is scanned over. This is what the rarity
// figure is measured against, so it has to be long enough to mean something:
// 500 H4 bars is ~83 days, 400 daily bars is well over a year.
// Enough bars that a rarity figure means something on each timeframe: 500 M15
// bars is ~5 days, 500 H1 is ~20 days, 500 H4 is ~83 days, 400 daily is well
// over a year. The intraday ones buy less history in calendar terms, which is
// exactly why their rarity numbers should be read with that in mind.
const BARS = { M15: 500, M30: 500, H1: 500, H4: 500, D: 400 };

// How far back published events reach. The app applies the user's own
// freshness window on top of this, so err on the generous side here — trimming
// it in the bot would silently cap what the app is allowed to ask for.
const RETAIN_DAYS = { M15: 2, M30: 3, H1: 4, H4: 7, D: 30 };

// The Screener's candlestick library, loaded rather than reimplemented. It is
// ESM app code, so it comes in through a dynamic import the same way the shared
// filter rules do. Reusing it is the point: a "Bullish Engulfing" in the FEED
// has to mean exactly what it means on the Screener, or the two screens are
// quietly answering different questions.
const PATTERNS_SRC = pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'utils', 'candlePatterns.js')).href;

// Lead-lag needs history, not a sparkline. The app only ever receives 40 daily
// closes, and at that size the significance threshold is |r| 0.38 — higher than
// any real lead-lag effect in liquid markets, so nothing is detectable and the
// honest answer is always "not enough data". The bot holds 400 bars, where the
// threshold is 0.12. Computing it here is the difference between asking the
// question and being able to answer it.
const LEADERSHIP_SRC = pathToFileURL(
  path.join(__dirname, '..', '..', 'shared', 'leadershipMath.mjs')).href;

// Daily bars move once a day; recomputing more often burns CPU for nothing.
const LEADERSHIP_EVERY_MS = 6 * 3600e3;

// How many recent closed bars are searched for patterns. Candlestick patterns
// are short-lived by nature — the Screener asks "formed within the last 1-10
// candles" — and publishing every occurrence over the whole history would
// multiply the feed's size for information nobody would filter on.
const PATTERN_BARS = 10;

// Closes published per timeframe so the app can DRAW the recent shape rather
// than only describe it. A row that says "swept the 5-bar low" is a claim; the
// same row with the move under it is evidence. Closes only, rounded to the
// instrument's own precision — full OHLC would triple the cost for detail
// nobody can see at 90 pixels wide.
const SPARK_BARS = 40;

const SWEEP_N = 5;        // a sweep must clear the prior 5 bars
const SWING_LOOK = 2;     // bars either side that define a swing point

// Nothing may take so long that a 60-second tick overruns. Each instrument is
// only re-measured when its bar closes, so in the steady state this cap is
// never reached; it exists for the cold start, when all 52 are due at once.
// Five timeframes across seventy-plus instruments is 360 jobs rather than 144,
// and each one is an API call. Raised so a full sweep still completes inside a
// quarter of an hour; the fair-share queue below decides the order, so the
// timeframe that just closed a bar is the one that gets served.
const MAX_REFRESH_PER_TICK = 26;

// Floor between publishes when only continuous state moved. Every write is a
// commit to the repo, so unbounded churn would bury the bot's real history.
const MIN_WRITE_GAP = 15 * 60e3;

// A pass that outlives this is assumed wedged. Without it a single hung request
// holds the guard below forever: alerts keep firing, positioning keeps
// updating, and the feed quietly stops measuring with nothing on screen to say
// so — which is precisely how it froze for nineteen hours in production.
const STUCK_PASS_MS = 6 * 60e3;

// When the bar AFTER the last complete one will itself be complete, plus a
// grace period for the venue to publish it.
const nextBarDue = (lastCompleteT, tfMs, grace = 120e3) => lastCompleteT + 2 * tfMs + grace;

// ── Measures ─────────────────────────────────────────────────────────────────
// Mirrors src/utils/scanner.js so the FEED and SCAN screens cannot disagree
// about the same instrument. If you change one, change both.
function trueRanges(cs) {
  const tr = [];
  for (let i = 1; i < cs.length; i++) {
    const pc = cs[i - 1].c;
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - pc), Math.abs(cs[i].l - pc)));
  }
  return tr;
}

const pctRank = (v, arr) => {
  if (!arr.length) return null;
  return Math.round((arr.filter(x => x < v).length / arr.length) * 100);
};

function measure(cs) {
  if (!cs || cs.length < 40) return null;
  const closes = cs.map(c => c.c);
  const last = closes[closes.length - 1];

  const tr = trueRanges(cs);
  const atrOf = (arr, i, n = 14) => {
    const s = arr.slice(Math.max(0, i - n + 1), i + 1);
    return s.reduce((a, b) => a + b, 0) / (s.length || 1);
  };
  const atrSeries = tr.map((_, i) => atrOf(tr, i)).slice(14);
  const atrNow = atrSeries[atrSeries.length - 1];

  const win = cs.slice(-60);
  const hi = Math.max(...win.map(c => c.h)), lo = Math.min(...win.map(c => c.l));
  const rangePos = hi > lo ? Math.round(((last - lo) / (hi - lo)) * 100) : 50;

  const chg20 = closes.length > 20
    ? ((last - closes[closes.length - 21]) / closes[closes.length - 21]) * 100 : 0;

  const ups = cs.slice(-20).filter(c => c.c > c.o).length;
  const persistence = Math.round((Math.abs(ups - 10) / 10) * 100);

  return {
    volPct: pctRank(atrNow, atrSeries),
    rangePos,
    chg20: +chg20.toFixed(2),
    persistence,
    atrPct: +((atrNow / last) * 100).toFixed(3),
    bars: cs.length,
  };
}

// ── Event detection over the whole series ────────────────────────────────────
// Every occurrence is dated, so the same pass yields both what is live now and
// how often it happens at all.
function detectSweeps(cs) {
  const out = [];
  for (let i = SWEEP_N; i < cs.length; i++) {
    const pat = detectStrongReversal(cs, i, SWEEP_N);
    if (!pat) continue;
    out.push({
      type: 'sweep',
      dir:  pat === 'hammer' ? 'up' : 'down',
      at:   cs[i].t,
      price: +cs[i].c,
      detail: `swept the ${SWEEP_N}-bar ${pat === 'hammer' ? 'low' : 'high'} and closed back inside`,
    });
  }
  return out;
}

// How many bars forward an outcome is measured over. Long enough that a real
// effect has room to appear, short enough that it is still attributable to the
// event rather than to everything that happened afterwards.
// Timeframes the feed measures. Ordered slow-first so the fair-share queue
// serves the ones that carry the most information when it is under pressure.
const FEED_TFS = ['D', 'H4', 'H1', 'M30', 'M15'];

const HORIZON = { M15: 40, M30: 30, H1: 24, H4: 20, D: 10 };

// What actually happened after this event, the last N times it fired here.
//
// Rarity says how often something occurs. It says nothing about whether it
// mattered — and "a strong hammer formed" is a fact with no consequence
// attached, which is most of what trading screens show. This measures the
// instrument's own history: of every prior occurrence with a full forward
// window, how often price was on the signal's side afterwards, and by how much.
//
// Two things keep it honest. Occurrences too close to the end of the series are
// excluded entirely, because counting an event whose future has not happened
// yet would quietly bias the result toward whatever the market just did. And
// the move is measured in ATR at the time of the event, so a number from gold
// and a number from natural gas mean the same thing.
//
// It is a base rate, not a forecast. Twelve out of seventeen is worth knowing
// and is still seventeen samples — the count travels with the figure so it can
// never be read as more than it is.
// Which way each reversal pattern points, so a forward outcome can be signed
// the same way a sweep's is — "worked" must mean the same thing for a hammer
// and for a shooting star. Kept in step with REVERSAL in
// src/utils/confluence.js, which decides which of these reach a card.
const REVERSAL_DIR = {
  hammer:'up', inv_hammer:'up', dragonfly_doji:'up', bull_engulf:'up',
  piercing_line:'up', bull_harami:'up', tweezer_bottom:'up', morning_star:'up',
  three_inside_up:'up', abandoned_bull:'up', kicker_bull:'up',
  shooting_star:'down', hanging_man:'down', gravestone_doji:'down',
  bear_engulf:'down', dark_cloud:'down', bear_harami:'down', tweezer_top:'down',
  evening_star:'down', three_inside_dn:'down', abandoned_bear:'down', kicker_bear:'down',
};

// True range once per series instead of once per call. This used to be rebuilt
// inside forwardOutcome, which was free at two event types and is not at
// twenty-four — the same five hundred bars would be walked twenty-six times per
// timeframe per instrument.
function atrSeries(cs) {
  const tr = [];
  for (let i = 1; i < cs.length; i++) {
    const pc = cs[i - 1].c;
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - pc), Math.abs(cs[i].l - pc)));
  }
  return i => {
    const from = Math.max(0, i - 14), sl = tr.slice(from, i);
    return sl.length ? sl.reduce((a, b) => a + b, 0) / sl.length : null;
  };
}

// What EVERY bar does over the same window, so a pattern can be judged against
// the market instead of against a coin.
//
// A forward outcome is signed by the event's own direction: for a bullish
// pattern, "worked" means price was higher N bars later. In a market that
// drifted up over the sample, that is true of most bars whether or not any
// pattern was present — so measuring against 50% credits the drift to the
// pattern. It showed: on a live board, nearly every bullish pattern "worked"
// and nearly every bearish one "failed", across every asset class. That is not
// what pattern skill looks like. That is what a rising market looks like.
//
// This is the number that tells them apart. Same window, same ATR scaling,
// every bar that has a complete future — the answer to "what would you have got
// for showing up at random".
function baselineOutcome(cs, bars, atrAt) {
  if (cs.length < bars + 30) return null;
  const moves = [];
  const entries = [];
  for (let i = 15; i + bars < cs.length; i++) {
    const a = atrAt(i);
    if (!a) continue;
    moves.push((cs[i + bars].c - cs[i].c) / a);
    entries.push({ i, a });
  }
  if (moves.length < 30) return null;
  const sorted = [...moves].sort((x, y) => x - y);
  return {
    bars,
    n: moves.length,
    // Signed for an "up" event. A "down" event's baseline is the mirror of
    // this, which the app computes from the direction split below.
    win: Math.round((moves.filter(m => m > 0).length / moves.length) * 100),
    medAtr: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    // The same two questions asked of the market itself. A setup that resolves
    // in three bars is only fast if the market does not resolve in three bars
    // too, and a stop that survives is only good if a random entry's does not.
    stUp: stopGrid(entries.map(e => ({ ...e, dir: 'up' })), cs, bars),
    // Not the mirror of stUp. A long and a short entered on the same bar have
    // different stops and different targets, and which of the two the bar's
    // high and low reach first is not a symmetric question.
    stDn: stopGrid(entries.map(e => ({ ...e, dir: 'down' })), cs, bars),
    tp: timeProfile(entries.map(e => ({ ...e, dir: 'up' })), cs, bars),
  };
}

// ── Stops, and time. The two questions a fixed-window number cannot answer ───
//
// Everything above holds the position for the whole window with no stop and no
// early exit, and reports where price was at the end. That measures "enter and
// wait N bars", which is not a trade anybody places. Two things are missing
// from it, and they are the two things that decide whether a setup is usable:
//
//   Where the stop has to sit. A pattern can be right about direction and still
//   be untradeable, because getting to the eventual move means sitting through
//   an adverse excursion wider than any stop a person would set. The
//   fixed-window number cannot see that — it only looks at the last bar.
//
//   When it pays. An edge that appears at bar two and an edge that appears at
//   bar ten look identical at the horizon, and only one of them can be traded
//   by somebody who will not hold a loser for days.
//
// So each setup is run as an actual trade: in at the close of the event bar,
// out at a stop, a target, or the end of the window, whichever comes first.
const STOPS = [0.5, 1, 1.5];   // stop distance, in ATR at the moment of entry
const RR = 2;                  // target at RR x the stop, so the R is fixed
const CHECKS = [1, 2, 3, 5];   // bars at which the running win rate is sampled

// One trade, bar by bar.
function tradeRun(cs, i, bars, atr, dir, stopAtr) {
  const entry = cs[i].c;
  const risk = stopAtr * atr;
  const up = dir === 'up';
  const stop = up ? entry - risk : entry + risk;
  const tgt = up ? entry + RR * risk : entry - RR * risk;
  const last = Math.min(i + bars, cs.length - 1);

  for (let j = i + 1; j <= last; j++) {
    const hitStop = up ? cs[j].l <= stop : cs[j].h >= stop;
    const hitTgt = up ? cs[j].h >= tgt : cs[j].l <= tgt;
    // Both inside one bar. Daily OHLC does not say which came first, and
    // assuming it was the target is exactly how a backtest manufactures an edge
    // that does not survive contact. The loss is taken.
    if (hitStop) return { r: -1, n: j - i };
    if (hitTgt) return { r: RR, n: j - i };
  }
  const raw = cs[last].c - entry;
  return { r: ((up ? raw : -raw) / risk), n: last - i, open: true };
}

// Compact on purpose: this rides on every record in a file the phone downloads
// on every load. Fixed order, no keys — [target %, stop %, expectancy in R x100,
// median bars to exit] for each of STOPS.
function stopGrid(entries, cs, bars) {
  if (!entries.length) return null;
  return STOPS.map(s => {
    let tgt = 0, stp = 0, sum = 0;
    const exits = [];
    for (const e of entries) {
      const r = tradeRun(cs, e.i, bars, e.a, e.dir, s);
      sum += r.r;
      exits.push(r.n);
      if (r.open) continue;
      if (r.r > 0) tgt++; else stp++;
    }
    exits.sort((a, b) => a - b);
    return [
      Math.round((tgt / entries.length) * 100),
      Math.round((stp / entries.length) * 100),
      Math.round((sum / entries.length) * 100),
      exits[Math.floor(exits.length / 2)],
    ];
  });
}

// Win rate at bar 1, 2, 3 and 5 — the shape of the edge in time, before the
// horizon washes it out. Checkpoints past the horizon are dropped rather than
// padded, so a D record with a ten-bar window keeps all four and nothing lies.
function timeProfile(entries, cs, bars) {
  return CHECKS.filter(k => k <= bars).map(k => {
    let w = 0, n = 0;
    for (const e of entries) {
      if (e.i + k >= cs.length) continue;
      const raw = cs[e.i + k].c - cs[e.i].c;
      if ((e.dir === 'up' ? raw : -raw) > 0) w++;
      n++;
    }
    return n ? Math.round((w / n) * 100) : null;
  });
}

function forwardOutcome(cs, idxOf, events, bars, atrAt) {
  if (!events.length || cs.length < bars + 30) return {};
  atrAt = atrAt || atrSeries(cs);

  const moves = [];
  const entries = [];
  let ups = 0;
  for (const e of events) {
    const i = idxOf.get(e.at);
    if (i == null || i + bars >= cs.length) continue;   // no complete future
    const a = atrAt(i);
    if (!a) continue;
    const raw = cs[i + bars].c - cs[i].c;
    // Signed by the event's own direction, so "worked" means the same thing
    // for a hammer and for a shooting star.
    const signed = (e.dir === 'up' ? raw : -raw) / a;
    if (e.dir === 'up') ups++;
    moves.push(signed);
    entries.push({ i, a, dir: e.dir });
  }
  if (moves.length < 5) return { fwdN: moves.length };   // too few to report

  const sorted = [...moves].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  const wins = moves.filter(m => m > 0).length;
  return {
    fwdBars: bars,
    fwdN: moves.length,
    fwdWin: Math.round((wins / moves.length) * 100),
    fwdMedAtr: +median.toFixed(2),
    // What share of these occurrences pointed up. Needed to mirror the baseline
    // correctly: a candle pattern is all one direction, but sweeps and breaks
    // are a mix, and a mixed population's baseline is a blend of the up
    // baseline and its mirror. Without this the comparison silently assumes an
    // even split.
    upShare: +(ups / moves.length).toFixed(3),
    // The same occurrences run as trades with a stop, and the win rate at bars
    // 1, 2, 3 and 5. Both are compared against the matching entry in the
    // instrument's baseline, never read on their own.
    //
    // Withheld below ten occurrences. At six, one trade moves the target rate
    // by seventeen points and the whole grid is noise wearing a number — and
    // this rides on every record in a file a phone downloads, so a figure that
    // cannot be read is not worth the bytes either.
    ...(moves.length >= 10 ? {
      st: stopGrid(entries, cs, bars),
      tp: timeProfile(entries, cs, bars),
    } : {}),
  };
}

// A swing point at index s is only KNOWN once `look` bars have printed after
// it, so a break can never be credited to a bar that could not have seen the
// level yet — that is the difference between a detector and hindsight.
function detectBreaks(cs) {
  const { highs, lows } = findSwings(cs, SWING_LOOK);
  const out = [];
  let hi = 0, lo = 0, lastHigh = null, lastLow = null;

  for (let i = 1; i < cs.length; i++) {
    while (hi < highs.length && highs[hi].idx + SWING_LOOK <= i - 1) lastHigh = highs[hi++];
    while (lo < lows.length  && lows[lo].idx  + SWING_LOOK <= i - 1) lastLow  = lows[lo++];
    const c = cs[i], prev = cs[i - 1];

    if (lastHigh && c.c > lastHigh.price && prev.c <= lastHigh.price) {
      out.push({ type:'break', dir:'up', at:c.t, price:+c.c,
        detail:`closed above the swing high at ${lastHigh.price}` });
    } else if (lastLow && c.c < lastLow.price && prev.c >= lastLow.price) {
      out.push({ type:'break', dir:'down', at:c.t, price:+c.c,
        detail:`closed below the swing low at ${lastLow.price}` });
    }
  }
  return out;
}

// ── Feed builder ─────────────────────────────────────────────────────────────
class FeedBuilder {
  constructor({ oanda, github, log, notifier = null }) {
    this.oanda  = oanda;
    this.github = github;
    this.log    = log || (() => {});
    this.notifier = notifier;
    this.data   = {};      // sym -> published record
    this.due    = new Map();  // "SYM|H4" -> next refresh timestamp
    this.servedAt = new Map();  // "SYM|H4" -> monotonic order it was last run
    this.seq    = 0;
    this.sha    = null;
    this.lastSig = null;
    this.loaded = false;
    this.published = [];        // TradFi instruments discovered by the app
    this.publishedAt = 0;
    this.cotAt  = 0;
    this.wroteAt = 0;
    this.dailyCloses = {};    // sym -> full daily close series, for lead-lag
    this.leadershipAt = 0;
    this.passId = 0;
    this.runningSince = 0;
    this.failStreak = 0;
    this.lastFailure = null;
  }

  // Loaded once, lazily: an older checkout without the module must degrade to
  // "no patterns" rather than take the whole feed down.
  async _leadershipLib() {
    if (this._lead === undefined) {
      try { this._lead = await import(LEADERSHIP_SRC); }
      catch (e) { this._lead = null; this.log(`Feed: leadership maths unavailable (${e.message})`); }
    }
    return this._lead;
  }

  // Who moves first, across everything that has daily history.
  //
  // Deliberately NOT part of _refreshTf: it needs every instrument's series at
  // once, so it runs after enough of them have been measured. Skipped entirely
  // until most of the registry is present, because a leadership map computed
  // from eight instruments would be both wrong and confident.
  async _refreshLeadership() {
    const lib = await this._leadershipLib();
    if (!lib?.computeLeadership) return;

    const have = Object.keys(this.dailyCloses).length;
    const want = this.instruments.filter(i => i.can.candles).length;
    if (have < want * 0.8) {
      // The series are only captured when a DAILY bar refreshes, which happens
      // once a day — and this map does not survive a restart. Since the bot
      // now updates itself and restarts regularly, waiting for the schedule
      // meant leadership never ran at all: it sat at 0 of 52 indefinitely.
      //
      // So ask for what is missing instead of waiting for it. These go through
      // the normal queue, rate limit and round robin; a daily re-fetch is cheap
      // and only happens once per boot.
      let queued = 0;
      for (const inst of this.instruments) {
        if (!inst.can.candles || this.dailyCloses[inst.sym]) continue;
        const k = `${inst.sym}|D`;
        if ((this.due.get(k) || 0) > Date.now()) { this.due.set(k, 0); queued++; }
      }
      this.log(`Feed: leadership deferred — ${have}/${want} daily series`
        + (queued ? `, requested ${queued} now` : ''));
      return;
    }

    const t0 = Date.now();
    const map = lib.computeLeadership(this.dailyCloses);
    this.leadershipAt = Date.now();

    let withLeader = 0;
    for (const [sym, r] of Object.entries(map)) {
      const rec = this.data[sym];
      if (!rec) continue;
      rec.leaders = { n: r.n, floor: r.floor, list: r.leaders };
      if (r.leaders.length) withLeader++;
    }
    this.log(`Feed: leadership over ${have} instruments in ${Date.now() - t0}ms — `
      + `${withLeader} have a measurable leader`);
  }

  async _patternLib() {
    if (this._pats === undefined) {
      try { this._pats = await import(PATTERNS_SRC); }
      catch (e) { this._pats = null; this.log(`Feed: candle patterns unavailable (${e.message})`); }
    }
    return this._pats;
  }

  // Pick up where the last process left off, so a restart does not republish
  // an identical file (and does not lose the SHA needed to write).
  async _load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const f = await this.github.readJSON(FEED_PATH);
      if (f?.content?.instruments) {
        this.data = f.content.instruments;
        this.sha  = f.sha;
        this.lastSig = this._signature(this.data);
        this.lastEventSig = this._eventSignature(this.data);
        this.wroteAt = new Date(f.content.updatedAt || 0).getTime() || 0;

        // Rebuild the refresh schedule from the timestamps already published.
        // Without this the due map starts empty, every instrument is due at
        // once, and the bot re-walks the whole registry from the top — so the
        // instruments at the END of it wait ten minutes to be reached again,
        // even though nothing about them had expired. Cheap to get wrong and
        // easy to miss, because re-measuring produces identical values and
        // looks like healthy "nothing changed" ticks. It matters much more now
        // that the self-updater restarts the bot on its own.
        let restored = 0, backfill = 0;
        for (const [sym, rec] of Object.entries(this.data)) {
          for (const tf of FEED_TFS) {
            if (!rec.asOf?.[tf]) continue;
            // A record written by an older build can be missing a field this
            // one produces. Leaving it on schedule would mean waiting a whole
            // bar — up to a day on the daily — for a newly shipped condition to
            // become usable, and until then it reports "no data" and silently
            // excludes the instrument. Re-measure those now instead.
            // Every field the current build produces, not just the newest one:
            // adding a field and forgetting to list it here is how a record
            // silently stays a version behind until its bar happens to close.
            if (!rec.patterns?.[tf] || !rec.spark?.[tf]) { backfill++; continue; }
            if (tf === 'D' && !rec.spark.D.d) { backfill++; continue; }
            this.due.set(`${sym}|${tf}`, nextBarDue(rec.asOf[tf], TF_MS[tf]));
            restored++;
          }
          if (rec.asOf?.spread) {
            this.due.set(`${sym}|SPREAD`, nextBarDue(rec.asOf.spread, TF_MS.M15, 60e3)); restored++;
          }
        }
        this.log(`Feed: resumed with ${Object.keys(this.data).length} instruments, ${restored} schedules restored`
          + (backfill ? `, ${backfill} due for backfill (record predates a current field)` : ''));
      } else if (f) {
        this.sha = f.sha;
      }
    } catch (e) { this.log(`Feed: could not read existing feed (${e.message})`); }
  }

  async _candles(inst, tf, count) {
    // Spot for the coins, futures for the TradFi perpetuals. Asking
    // api.binance.com for a futures-only symbol returns a 400, which here
    // would drop the instrument out of the feed with a misleading error
    // rather than fetching it from the venue that has it.
    const host = inst.binance ? 'https://api.binance.com/api/v3'
               : inst.bfut    ? 'https://fapi.binance.com/fapi/v1'
               : null;
    if (host) {
      const ticker = inst.binance || inst.bfut;
      const r = await fetch(`${host}/klines?symbol=${ticker}&interval=${BIN_TF[tf]}&limit=${count}`,
        { timeout: 20000 });
      if (!r.ok) throw new Error(`Binance ${r.status} (${ticker})`);
      const d = await r.json();
      // The final kline is the bar still forming; an incomplete bar would make
      // every instrument look like it just did something.
      return d.slice(0, -1).map(k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4] }));
    }
    return this.oanda.getCandles(inst.oanda, tf, count);
  }

  // Spread against its own recent normal. An absolute pip figure says nothing —
  // 3 pips is tight on GBP/NZD and terrible on EUR/USD.
  async _spread(inst) {
    const rows = await this.oanda.getBidAskCandles(inst.oanda, 'M15', 96);
    if (rows.length < 20) return null;
    const spreads = rows.map(c => c.ask - c.bid).filter(v => v > 0).sort((a, b) => a - b);
    if (spreads.length < 20) return null;
    const median = spreads[Math.floor(spreads.length / 2)];
    if (!(median > 0)) return null;
    const lastRow = rows[rows.length - 1];
    // One decimal on purpose. ×1.1 versus ×1.8 changes a decision; ×1.12 versus
    // ×1.14 does not, and publishing that precision would rewrite the feed —
    // and commit it — every fifteen minutes for forty instruments.
    // The ratio says whether conditions are normal; the absolute spread is what
    // a trade actually pays. A plan cannot say "this costs 8% of your stop"
    // from a ratio, so both are published.
    return {
      ratio: +((lastRow.ask - lastRow.bid) / median).toFixed(1),
      abs: +(lastRow.ask - lastRow.bid).toPrecision(4),
      at: lastRow.t,
    };
  }

  // Identity is stamped the moment a record exists, not when its candles first
  // arrive. During a cold start the COT pass creates records for instruments
  // whose prices have not been measured yet; without a class on them, a filter
  // scoped to "metals" skipped those records here while the app included them
  // by falling back to its own registry — the app and the VPS disagreeing about
  // the same instrument, which is the one thing the shared rules exist to stop.
  _rec(inst) {
    const sym = typeof inst === 'string' ? inst : inst.sym;
    if (!this.data[sym]) this.data[sym] = { state:{}, events:[], rarity:{}, asOf:{}, patterns:{}, spark:{} };
    const r = this.data[sym];
    r.state ||= {}; r.events ||= []; r.rarity ||= {}; r.asOf ||= {}; r.patterns ||= {}; r.spark ||= {};
    if (typeof inst === 'object') {
      r.cls  = inst.cls;
      r.name = inst.name;
      r.dec  = inst.dec;
    }
    return r;
  }

  async _refreshTf(inst, tf) {
    const cs = await this._candles(inst, tf, BARS[tf]);
    if (!cs || cs.length < 60) throw new Error(`only ${cs?.length || 0} bars`);

    const rec = this._rec(inst);
    rec.price = +cs[cs.length - 1].c;

    rec.state[tf] = measure(cs);
    rec.asOf[tf]  = cs[cs.length - 1].t;
    // Retained only for the daily lead-lag pass; 52 x 400 numbers is nothing.
    if (tf === 'D') this.dailyCloses[inst.sym] = cs.map(x => x.c);

    const spanDays = Math.max(1, (cs[cs.length - 1].t - cs[0].t) / 86400e3);
    const all = [...detectSweeps(cs), ...detectBreaks(cs)];

    const idxOf = new Map(cs.map((c, i) => [c.t, i]));
    const atrFn = atrSeries(cs);
    // Measured once per timeframe, before anything is compared to it.
    rec.baseline ||= {};
    const bl = baselineOutcome(cs, HORIZON[tf] || 20, atrFn);
    if (bl) rec.baseline[tf] = bl;
    for (const type of ['sweep', 'break']) {
      const hits = all.filter(e => e.type === type);
      rec.rarity[`${type}.${tf}`] = {
        n: hits.length,
        days: Math.round(spanDays),
        perMonth: +((hits.length / spanDays) * 30).toFixed(1),
        ...forwardOutcome(cs, idxOf, hits, HORIZON[tf] || 20, atrFn),
      };
    }

    // ── Candlestick patterns, dated, with each one's own rate ──
    const lib = await this._patternLib();
    if (lib?.patternsAt) {
      const counts = {};
      const recent = [];
      // Every occurrence, kept as {at, dir} so the forward pass can reuse the
      // same code path the sweeps take. Timestamps, not objects with bodies —
      // thirty-four ids over five hundred bars is a few thousand small entries
      // and they are discarded at the end of this function.
      const occurrences = {};
      const firstRecent = Math.max(4, cs.length - PATTERN_BARS);
      for (let i = 4; i < cs.length; i++) {
        const ids = lib.patternsAt(cs, i);
        for (const id of ids) {
          counts[id] = (counts[id] || 0) + 1;
          const dir = REVERSAL_DIR[id];
          if (dir) (occurrences[id] ||= []).push({ at: cs[i].t, dir });
          if (i >= firstRecent) recent.push({ id, at: cs[i].t });
        }
      }
      // The rate rides on the entry rather than in a separate table, so only
      // patterns actually present cost anything — which is also exactly when
      // the number is worth showing.
      rec.patterns ||= {};
      rec.patterns[tf] = recent.map(p => ({
        ...p,
        rate: +(((counts[p.id] || 0) / spanDays) * 30).toFixed(1),
      }));

      // What actually happened after each candle.
      //
      // Only sweeps and breaks were ever measured forward, so the app could
      // draw a card built on a hammer and never price it — on a live feed, 24
      // of 27 unpriced trade plans were anchored on a candle pattern. The
      // machinery to answer it has been sitting right here the whole time,
      // running on the other two event types.
      //
      // Only for patterns actually on screen. Measuring all thirty-four on
      // every timeframe would triple the published payload to answer questions
      // nobody is asking.
      const onScreen = [...new Set(recent.map(p => p.id))].filter(id => REVERSAL_DIR[id]);
      for (const id of onScreen) {
        const hits = occurrences[id];
        if (!hits || hits.length < 5) continue;
        const out = forwardOutcome(cs, idxOf, hits, HORIZON[tf] || 20, atrFn);
        if (out.fwdN >= 5) {
          rec.rarity[`${id}.${tf}`] = {
            n: counts[id],
            days: Math.round(spanDays),
            perMonth: +(((counts[id] || 0) / spanDays) * 30).toFixed(1),
            ...out,
          };
        }
      }
    }

    // The recent shape, for drawing. Rounded to the instrument's own precision
    // so a JPY cross does not ship fifteen meaningless decimals.
    const dp = inst.dec ?? 4;
    rec.spark ||= {};
    const sparkBars = cs.slice(-SPARK_BARS);
    rec.spark[tf] = {
      from: sparkBars[0].t,
      c: sparkBars.map(x => +x.c.toFixed(dp)),
      // Day offset of each bar from the first. Bars are NOT evenly spaced —
      // markets close at weekends — so a consumer cannot reconstruct dates by
      // multiplying an index, and anything aligning this series to dated data
      // (macro releases, yields) would silently drift two days a week. Small
      // integers, and only where dates are actually used.
      ...(tf === 'D' ? { d: sparkBars.map(x => Math.round((x.t - sparkBars[0].t) / 86400e3)) } : {}),
    };
    // Index of each bar by timestamp. An event's position CANNOT be derived
    // arithmetically from its time: FX bars skip weekends, so elapsed-time over
    // bar-size drifts by two days every week and every marker after a Friday
    // lands on the wrong bar. The bot knows the real index, so it publishes it.
    const sparkIdx = new Map(sparkBars.map((b, i) => [b.t, i]));

    const cutoff = Date.now() - RETAIN_DAYS[tf] * 86400e3;
    const kept = all
      .filter(e => e.at >= cutoff)
      .map(e => {
        const si = sparkIdx.get(e.at);
        return si === undefined ? { ...e, tf } : { ...e, tf, si };
      })
      .sort((a, b) => b.at - a.at);

    rec.events = [...rec.events.filter(e => e.tf !== tf), ...kept]
      .sort((a, b) => b.at - a.at);

    // A bar stamped t covers [t, t+TF) and is only complete at t+TF, so the
    // NEXT complete bar does not exist until t+2·TF. Scheduling one TF ahead
    // puts every instrument permanently due and the feed re-fetches all 52 on
    // every 60-second tick instead of once a bar.
    this.due.set(`${inst.sym}|${tf}`, nextBarDue(cs[cs.length - 1].t, TF_MS[tf]));
    return kept.length;
  }

  async _refreshSpread(inst) {
    const s = await this._spread(inst);
    const rec = this._rec(inst);
    if (s) {
      rec.state.spreadRatio = s.ratio;
      rec.state.spreadAbs = s.abs;
      rec.asOf.spread = s.at;
      this.due.set(`${inst.sym}|SPREAD`, nextBarDue(s.at, TF_MS.M15, 60e3));
    } else {
      this.due.set(`${inst.sym}|SPREAD`, Date.now() + TF_MS.M15);
    }
  }

  async _refreshCot() {
    // Stamped before the work, not after: fifteen sequential CFTC requests take
    // a while, and if one throws halfway a timestamp set at the end would never
    // be reached and the bot would retry the whole set every single tick.
    this.cotAt = Date.now();
    const list = this.instruments.filter(i => i.can.positioning);
    for (const inst of list) {
      try {
        const p = await fetchCOTPercentile(inst.cot);
        const rec = this._rec(inst);
        if (p) {
          // A percentile from a thin history is noise wearing a number's
          // clothes, so publish the sample size and let the app refuse it.
          rec.state.posnPct   = p.enough ? p.pct : null;
          rec.state.posnWeeks = p.weeks;
          rec.asOf.cot = p.date;
        }
      } catch (e) { this.log(`Feed COT ${inst.sym}: ${e.message}`); }
    }
  }

  _eventSignature(data) {
    return JSON.stringify(Object.entries(data).sort(([a], [b]) => a < b ? -1 : 1)
      .map(([sym, r]) => [sym,
        (r.events || []).map(e => `${e.type}${e.dir}${e.tf}${e.at}`),
        Object.entries(r.patterns || {}).map(([tf, list]) => `${tf}:${list.map(p => p.id + p.at).join(',')}`)]));
  }

  _signature(data) {
    // Everything except wall-clock, so an unchanged market does not produce a
    // commit every minute. 1440 no-op commits a day would bury the real ones.
    return JSON.stringify(Object.entries(data).sort(([a], [b]) => a < b ? -1 : 1)
      .map(([sym, r]) => [sym, r.price, r.state, r.rarity, (r.leaders?.list || []).map(l => `${l.sym}${l.lag}${l.r}`),
        (r.events || []).map(e => `${e.type}${e.dir}${e.tf}${e.at}`),
        Object.entries(r.patterns || {}).map(([tf, list]) => `${tf}:${list.map(p => p.id + p.at).join(',')}`)]));
  }

  // The static registry plus whatever the app published. Read through this
  // rather than INSTRUMENTS directly, or the feed measures the twenty someone
  // typed in and quietly ignores everything Binance has listed since.
  get instruments() {
    if (!this.published.length) return INSTRUMENTS;
    const have = new Set(INSTRUMENTS.map(i => i.sym));
    const extra = this.published
      .filter(e => e && e.sym && e.bfut && !have.has(e.sym))
      .map(e => ({ ...e, cls: e.cls || 'tradfi', perp: true,
                   can: { candles: true, spread: false, positioning: false } }));
    return [...INSTRUMENTS, ...extra];
  }

  // Refreshed hourly. The list changes when Binance lists a contract, not
  // between ticks, and a failed read must leave the previous list in place —
  // dropping to the static twenty on one bad request would show as instruments
  // vanishing from the feed and then coming back.
  async _loadPublished() {
    if (Date.now() - this.publishedAt < 3600e3) return;
    this.publishedAt = Date.now();
    try {
      const f = await this.github.readJSON(TRADFI_PATH);
      const list = f?.content?.instruments;
      if (Array.isArray(list) && list.length) {
        const before = this.published.length;
        this.published = list;
        if (list.length !== before) {
          this.log(`Feed: ${list.length} published TradFi instruments (was ${before})`);
        }
      }
    } catch { /* not published yet, or unreachable — keep what we have */ }
  }

  async tick() {
    // The bot ticks on a timer, not on completion. A COT refresh is fifteen
    // sequential CFTC requests and can outlast the interval, and two overlapping
    // runs would mutate this.data and race each other to write the same file.
    if (this.running) {
      const stuckFor = Date.now() - this.runningSince;
      if (stuckFor < STUCK_PASS_MS) {
        this.log(`Feed: previous pass still running (${Math.round(stuckFor / 1000)}s) — skipping`);
        return;
      }
      // Release rather than wait forever. The abandoned pass is now stale: it
      // checks its own id before writing anything, so it cannot resurrect and
      // publish over whatever the new pass produces.
      this.log(`Feed: previous pass wedged for ${Math.round(stuckFor / 60000)} min — abandoning it and starting a new one`);
      this.running = false;
    }
    const id = ++this.passId;
    this.running = true;

    // Before anything enumerates instruments.
    await this._loadPublished();
    this.runningSince = Date.now();
    try { await this._pass(id); }
    finally { if (id === this.passId) { this.running = false; this.runningSince = 0; } }
  }

  async _pass(passId = this.passId) {
    const mine = () => passId === this.passId;
    await this._load();
    const now = Date.now();
    const jobs = [];

    for (const inst of this.instruments) {
      if (!inst.can.candles) continue;
      for (const tf of FEED_TFS) {
        const k = `${inst.sym}|${tf}`;
        if ((this.due.get(k) || 0) <= now) jobs.push({ inst, kind: tf, key: k });
      }
      if (inst.can.spread) {
        const k = `${inst.sym}|SPREAD`;
        if ((this.due.get(k) || 0) <= now) jobs.push({ inst, kind: 'SPREAD', key: k });
      }
    }

    // Serve the most overdue first, then whatever has waited longest since it
    // was last served. NOT registry order.
    //
    // Observed live: the last five instruments in the registry — the whole
    // crypto tail — went unmeasured indefinitely while every tick logged
    // healthily. Taking the head of a registry-ordered list means the front of
    // the registry always wins, and forty OANDA spread jobs fall due together
    // every thirty minutes against fourteen slots a tick.
    //
    // Sorting by due time alone does NOT fix it: bar boundaries are global, so
    // all forty spread jobs share one due timestamp and the tie falls straight
    // back to registry order. The least-recently-served tie-break is what makes
    // it a round robin, so an oversubscribed feed degrades into "everything is
    // a bit stale" instead of "the last few are never measured at all".
    const dueAt  = j => this.due.get(j.key) || 0;
    const served = k => this.servedAt.get(k) || 0;
    const batch = jobs
      .sort((a, b) => dueAt(a) - dueAt(b) || served(a.key) - served(b.key))
      .slice(0, MAX_REFRESH_PER_TICK);
    for (const j of batch) {
      // Stamped before the attempt, so a job that keeps failing takes its turn
      // at the back of the queue rather than reclaiming a slot every tick.
      this.servedAt.set(j.key, ++this.seq);
      try {
        if (j.kind === 'SPREAD') await this._refreshSpread(j.inst);
        else await this._refreshTf(j.inst, j.kind);
        this.failStreak = 0;
      } catch (e) {
        // Back off this one job rather than the whole feed — one delisted
        // symbol or one bad response must not stall the other 51.
        this.due.set(j.key, now + 10 * 60e3);
        this.failStreak++;
        this.lastFailure = { sym: j.inst.sym, kind: j.kind, msg: e.message, at: new Date().toISOString() };
        this.log(`Feed ${j.inst.sym} ${j.kind}: ${e.message}`);
      }
    }

    // Retried every few minutes until it has run once, then only daily. Without
    // the short retry the first successful pass would wait a full interval
    // after the series finally arrived.
    const everCompleted = this.leadershipAt > 0;
    const dueIn = everCompleted ? LEADERSHIP_EVERY_MS : 3 * 60e3;
    if (now - (this.leadershipTriedAt || 0) > dueIn) {
      this.leadershipTriedAt = now;
      await this._refreshLeadership().catch(e => this.log(`Feed leadership: ${e.message}`));
    }

    if (now - this.cotAt > 6 * 3600e3) {
      await this._refreshCot().catch(e => this.log(`Feed COT: ${e.message}`));
    }

    // Events age out even when nothing new is fetched (a weekend, say), so
    // prune on every tick rather than only on refresh.
    for (const [sym, rec] of Object.entries(this.data)) {
      const before = (rec.events || []).length;
      rec.events = (rec.events || []).filter(e => e.at >= now - (RETAIN_DAYS[e.tf] || 7) * 86400e3);
      if (rec.events.length !== before) this.log(`Feed ${sym}: ${before - rec.events.length} event(s) aged out`);
    }

    if (!Object.keys(this.data).length) return;

    if (!mine()) { this.log('Feed: pass superseded — discarding its result'); return; }

    const sig = this._signature(this.data);
    if (sig === this.lastSig) {
      if (batch.length) this.log(`Feed: ${batch.length} refreshed, nothing changed — no write`);
      return;
    }

    // A new or expired event is the whole point of the feed and publishes at
    // once. Everything else — a percentile ticking over, a spread nudging up —
    // waits for the floor, so a quiet market cannot produce a commit a minute.
    // Notify before deciding whether to write. The write is throttled to keep
    // the repo readable; a match reaching your phone is not something to hold
    // back for fifteen minutes because the commit log would look tidier.
    if (this.notifier) {
      await this.notifier.run(this.data).catch(e => this.log(`Feed push: ${e.message}`));
    }

    const eventSig = this._eventSignature(this.data);
    const eventsChanged = eventSig !== this.lastEventSig;
    if (!eventsChanged && this.wroteAt && now - this.wroteAt < MIN_WRITE_GAP) {
      this.log(`Feed: state moved but no new events — holding the write`);
      return;
    }

    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      meta: {
        instruments: Object.keys(this.data).length,
        bars: BARS,
        retainDays: RETAIN_DAYS,
        sweepBars: SWEEP_N,
        // Health, published so a stall is visible in the app instead of only
        // in a log nobody is watching.
        failStreak: this.failStreak,
        lastFailure: this.lastFailure,
        patternBars: PATTERN_BARS,
        sparkBars: SPARK_BARS,
        pending: Math.max(0, jobs.length - batch.length),
      },
      instruments: this.data,
    };

    try {
      this.sha = await this.github.writeJSON(FEED_PATH, payload, 'bot: live feed update', this.sha, { pretty: false });
      this.lastSig = sig;
      this.lastEventSig = eventSig;
      this.wroteAt = now;
      const live = Object.values(this.data).reduce((n, r) => n + (r.events || []).length, 0);
      this.log(`Feed: published ${Object.keys(this.data).length} instruments, ${live} live events`);
    } catch (e) {
      this.log(`Feed write: ${e.message}`);
      this.sha = null;   // force a SHA re-read on the next attempt
    }
  }
}

module.exports = {
  FeedBuilder, measure, detectSweeps, detectBreaks,
  // Exported for tests: the forward-outcome pass is the thing every base rate
  // in the app rests on, and it is worth being able to check it directly
  // against a series with a known answer.
  forwardOutcome, atrSeries, baselineOutcome, REVERSAL_DIR,
  tradeRun, stopGrid, timeProfile, STOPS, RR, CHECKS,
};

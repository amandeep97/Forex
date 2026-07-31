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
const { detectStrongReversal, findSwings } = require('./smc');
const { fetchCOTPercentile } = require('./cotFetcher');

const FEED_PATH = 'bot/feed.json';

const BIN_TF = { H4:'4h', D:'1d' };
const TF_MS  = { M15: 900e3, H4: 14400e3, D: 86400e3 };

// How much history each timeframe is scanned over. This is what the rarity
// figure is measured against, so it has to be long enough to mean something:
// 500 H4 bars is ~83 days, 400 daily bars is well over a year.
const BARS = { H4: 500, D: 400 };

// How far back published events reach. The app applies the user's own
// freshness window on top of this, so err on the generous side here — trimming
// it in the bot would silently cap what the app is allowed to ask for.
const RETAIN_DAYS = { H4: 7, D: 30 };

// The Screener's candlestick library, loaded rather than reimplemented. It is
// ESM app code, so it comes in through a dynamic import the same way the shared
// filter rules do. Reusing it is the point: a "Bullish Engulfing" in the FEED
// has to mean exactly what it means on the Screener, or the two screens are
// quietly answering different questions.
const PATTERNS_SRC = pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'utils', 'candlePatterns.js')).href;

// How many recent closed bars are searched for patterns. Candlestick patterns
// are short-lived by nature — the Screener asks "formed within the last 1-10
// candles" — and publishing every occurrence over the whole history would
// multiply the feed's size for information nobody would filter on.
const PATTERN_BARS = 10;

const SWEEP_N = 5;        // a sweep must clear the prior 5 bars
const SWING_LOOK = 2;     // bars either side that define a swing point

// Nothing may take so long that a 60-second tick overruns. Each instrument is
// only re-measured when its bar closes, so in the steady state this cap is
// never reached; it exists for the cold start, when all 52 are due at once.
const MAX_REFRESH_PER_TICK = 14;

// Floor between publishes when only continuous state moved. Every write is a
// commit to the repo, so unbounded churn would bury the bot's real history.
const MIN_WRITE_GAP = 15 * 60e3;

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
    this.cotAt  = 0;
    this.wroteAt = 0;
  }

  // Loaded once, lazily: an older checkout without the module must degrade to
  // "no patterns" rather than take the whole feed down.
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
          for (const tf of ['H4', 'D']) {
            if (!rec.asOf?.[tf]) continue;
            // A record written by an older build can be missing a field this
            // one produces. Leaving it on schedule would mean waiting a whole
            // bar — up to a day on the daily — for a newly shipped condition to
            // become usable, and until then it reports "no data" and silently
            // excludes the instrument. Re-measure those now instead.
            if (!rec.patterns?.[tf]) { backfill++; continue; }
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
    if (inst.binance) {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${inst.binance}&interval=${BIN_TF[tf]}&limit=${count}`,
        { timeout: 20000 });
      if (!r.ok) throw new Error(`Binance ${r.status}`);
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
    return { ratio: +((lastRow.ask - lastRow.bid) / median).toFixed(1), at: lastRow.t };
  }

  // Identity is stamped the moment a record exists, not when its candles first
  // arrive. During a cold start the COT pass creates records for instruments
  // whose prices have not been measured yet; without a class on them, a filter
  // scoped to "metals" skipped those records here while the app included them
  // by falling back to its own registry — the app and the VPS disagreeing about
  // the same instrument, which is the one thing the shared rules exist to stop.
  _rec(inst) {
    const sym = typeof inst === 'string' ? inst : inst.sym;
    if (!this.data[sym]) this.data[sym] = { state:{}, events:[], rarity:{}, asOf:{}, patterns:{} };
    const r = this.data[sym];
    r.state ||= {}; r.events ||= []; r.rarity ||= {}; r.asOf ||= {}; r.patterns ||= {};
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

    const spanDays = Math.max(1, (cs[cs.length - 1].t - cs[0].t) / 86400e3);
    const all = [...detectSweeps(cs), ...detectBreaks(cs)];

    for (const type of ['sweep', 'break']) {
      const hits = all.filter(e => e.type === type);
      rec.rarity[`${type}.${tf}`] = {
        n: hits.length,
        days: Math.round(spanDays),
        perMonth: +((hits.length / spanDays) * 30).toFixed(1),
      };
    }

    // ── Candlestick patterns, dated, with each one's own rate ──
    const lib = await this._patternLib();
    if (lib?.patternsAt) {
      const counts = {};
      const recent = [];
      const firstRecent = Math.max(4, cs.length - PATTERN_BARS);
      for (let i = 4; i < cs.length; i++) {
        const ids = lib.patternsAt(cs, i);
        for (const id of ids) {
          counts[id] = (counts[id] || 0) + 1;
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
    }

    const cutoff = Date.now() - RETAIN_DAYS[tf] * 86400e3;
    const kept = all
      .filter(e => e.at >= cutoff)
      .map(e => ({ ...e, tf }))
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
    const list = INSTRUMENTS.filter(i => i.can.positioning);
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
      .map(([sym, r]) => [sym, r.price, r.state, r.rarity,
        (r.events || []).map(e => `${e.type}${e.dir}${e.tf}${e.at}`),
        Object.entries(r.patterns || {}).map(([tf, list]) => `${tf}:${list.map(p => p.id + p.at).join(',')}`)]));
  }

  async tick() {
    // The bot ticks on a timer, not on completion. A COT refresh is fifteen
    // sequential CFTC requests and can outlast the interval, and two overlapping
    // runs would mutate this.data and race each other to write the same file.
    if (this.running) { this.log('Feed: previous pass still running — skipping'); return; }
    this.running = true;
    try { await this._pass(); } finally { this.running = false; }
  }

  async _pass() {
    await this._load();
    const now = Date.now();
    const jobs = [];

    for (const inst of INSTRUMENTS) {
      if (!inst.can.candles) continue;
      for (const tf of ['H4', 'D']) {
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
      } catch (e) {
        // Back off this one job rather than the whole feed — one delisted
        // symbol or one bad response must not stall the other 51.
        this.due.set(j.key, now + 10 * 60e3);
        this.log(`Feed ${j.inst.sym} ${j.kind}: ${e.message}`);
      }
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
        patternBars: PATTERN_BARS,
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

module.exports = { FeedBuilder, measure, detectSweeps, detectBreaks };

'use strict';
// vps-bot/src/liquidityScan.js
// The sweep model, on the VPS, awake or not.
//
// This started in the app because the consensus code already had the candles
// and it shipped in an hour. That was the wrong place. The whole point of the
// model is a two-minute confirmation after a level is taken, and a two-minute
// confirmation is exactly the thing a person cannot sit and wait for. Running
// it in a browser tab means it only works while someone is watching, which is
// the one case where it is not needed.
//
// ── The problem this has to solve, which the app version did not ────────────
//
// Two-minute candles for every instrument every two minutes is 25 requests a
// minute on its own, against a whole-bot budget of 26 per tick that the feed
// already competes for. Scanning everything, always, would starve the feed to
// answer a question that is almost always "no".
//
// So the scan is gated on proximity. Levels move slowly — yesterday's high is
// yesterday's high all day — so they refresh hourly and cost three requests an
// instrument. Between refreshes the last known price is compared to those
// levels, and two-minute candles are fetched ONLY for instruments where price
// is near one or has gone past it. On a quiet day that is a handful of
// instruments; the rest cost nothing.
//
// "Near" is one H4 ATR, measured when the levels are built. A fixed percentage
// cannot work across gold at 4300 and EUR/USD at 1.08, and a fixed pip count is
// the same mistake in different clothes.
//
// ── What it publishes, and what it deliberately does not ────────────────────
//
// Every scanned instrument gets a record whether or not it found anything,
// because "checked, nothing there" and "never checked" are different facts and
// the app must be able to tell them apart. A row that has never been scanned
// says so rather than showing an empty result that looks like an answer.

const { INSTRUMENTS } = require('./instruments');

const PATH = 'bot/liquidity.json';

// Bump this whenever the MEANING of a level changes.
//
// Restoring levels across restarts made the bot cheap and made it impossible to
// ship a correction. The off-by-one fix went live and the screen kept showing
// the old prices, because the levels were restored from a file written by the
// old code and the only thing that expires them is an hour-old timestamp. Worse,
// every restart restored them again, so the hour kept being reset in effect.
//
// A version stamp fixes it at the root: levels computed by a different method
// are not stale, they are WRONG, and no amount of waiting makes them right. On
// restore they are dropped and rebuilt.
const LEVEL_METHOD = 2;

// Levels are yesterday's and last week's, so an hour is generous.
const LEVELS_TTL = 60 * 60e3;
// A two-minute bar closes every two minutes; there is nothing to gain by
// asking more often than that.
const SCAN_TTL = 2 * 60e3;

// Per-tick budgets, kept small on purpose. The feed's own queue gets 26 a tick
// and this must not compete with it for the whole allowance.
// Twelve rather than four. A full rebuild is 40 instruments at three requests
// each; at four a tick that is ten minutes, and the bot has been restarting more
// often than that, so it never finished and the levels never updated. At twelve
// it is under four minutes. The feed's own queue is separate and still gets its
// 26 a tick — this competes for OANDA's rate limit, not for the feed's slots,
// and a burst of level fetches once an hour is affordable where a burst of
// two-minute fetches every two minutes was not.
const LEVEL_JOBS = 12;
const SCAN_JOBS = 8;

// How close to a level is worth spending a request on, in H4 ATR.
//
// The daily high and low get a wider band than the rest. They are the levels an
// intraday trader is actually waiting on, so being told about the approach
// early is the point rather than an expense to minimise; an H4 swing only earns
// a request once price is nearly on it.
const NEAR_ATR = 1.0;
const NEAR_ATR_DAILY = 2.0;

// How close counts as "approaching", reported on the row. Tighter than the
// scan band: a request is worth spending well before a level is worth
// mentioning on screen.
const APPROACH_ATR = 0.5;

// A setup is announced once. Re-announcing the same sweep every two minutes
// while it remains valid would train you to ignore the alert.
const ANNOUNCE_TTL = 6 * 3600e3;

function atrOf(cs, period = 14) {
  if (!cs || cs.length < period + 1) return null;
  let sum = 0;
  for (let i = cs.length - period; i < cs.length; i++) {
    const p = cs[i - 1];
    sum += Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - p.c), Math.abs(cs[i].l - p.c));
  }
  return sum / period;
}

class LiquidityScanner {
  constructor({ oanda, github, telegram = null, log = () => {}, env = {} }) {
    this.oanda = oanda;
    this.github = github;
    this.telegram = telegram;
    this.log = log;
    this.env = env;
    this.levels = new Map();     // sym -> { levels, atr, at }
    this.results = new Map();    // sym -> record
    this.announced = new Map();  // key -> when
    this.sha = null;
    this.lastSig = null;
    this.seq = 0;
    this.servedAt = new Map();
    this.lib = null;
    this.restored = false;
  }

  // Pick up where the last process left off.
  //
  // Everything lived in memory and nothing survived a restart, so each deploy
  // wiped the levels for all 40 instruments and the screen went back to near
  // empty. Rebuilding takes three requests an instrument at four instruments a
  // tick — ten minutes of looking like the model found nothing, and 120 wasted
  // requests, every single time the bot restarts. During a run of deploys it
  // never finished: eight instruments had levels after an hour, and the app
  // reported that as though it had looked at everything.
  //
  // The published file already carries what is needed, so it is read back once
  // at startup. The level timestamp is restored with it, so an hour-old set
  // still expires on schedule rather than being treated as fresh.
  async _restore() {
    if (this.restored) return;
    this.restored = true;
    try {
      const cur = await this.github.readJSON(PATH);
      this.sha = cur?.sha || null;
      // Levels from an older method are discarded rather than trusted. The
      // results are still worth keeping so the screen is not empty while they
      // rebuild, but they are marked so nothing reads them as current.
      const fileMethod = cur?.content?.method ?? 1;
      const usable = fileMethod === LEVEL_METHOD;
      if (!usable) {
        this.log(`Liquidity: file was built by method ${fileMethod}, current is `
          + `${LEVEL_METHOD} — rebuilding every level rather than trusting them`);
      }
      for (const r of cur?.content?.rows || []) {
        if (!r?.sym) continue;
        this.results.set(r.sym, r);
        if (usable && Array.isArray(r.lv) && r.lv.length) {
          this.levels.set(r.sym, {
            levels: r.lv.map(([kind, price, side, label]) => ({ kind, price, side, label })),
            atr: r.atr ?? null,
            at: r.lvAt || 0,
          });
        }
      }
      if (this.results.size) {
        this.log(`Liquidity: restored ${this.results.size} instrument(s), `
          + `${this.levels.size} with levels — no rebuild needed`);
      }
    } catch (e) {
      this.log(`Liquidity restore: ${e.message} — starting cold`);
    }
  }

  // shared/ is ESM and this file is CommonJS, so the one copy of the rule is
  // loaded rather than reimplemented. A second implementation on the bot side
  // is exactly how the app and the bot came to disagree about structure.
  async _load() {
    if (!this.lib) this.lib = await import('../../shared/liquidity.mjs');
    return this.lib;
  }

  _instruments() {
    return INSTRUMENTS.filter(i => i.can?.candles && i.oanda);
  }

  async _refreshLevels(inst) {
    const { keyLevels } = await this._load();
    const [daily, weekly, h4] = await Promise.all([
      this.oanda.getCandles(inst.oanda, 'D', 12),
      this.oanda.getCandles(inst.oanda, 'W', 8),
      this.oanda.getCandles(inst.oanda, 'H4', 80),
    ]);
    const levels = keyLevels({ daily, weekly, h4 });
    const atr = atrOf(h4);
    this.levels.set(inst.sym, { levels, atr, at: Date.now() });
    return { levels, atr };
  }

  // Is price close enough to any level that a two-minute look is worth a
  // request? Beyond a level counts too — that is the case the model is about.
  _near(sym, price) {
    const rec = this.levels.get(sym);
    if (!rec || !rec.levels.length || !Number.isFinite(price)) return false;
    const unit = rec.atr || Math.abs(price) * 0.002;
    return rec.levels.some(l => {
      const daily = l.kind === 'PDH' || l.kind === 'PDL';
      return Math.abs(price - l.price) <= unit * (daily ? NEAR_ATR_DAILY : NEAR_ATR);
    });
  }

  async _scan(inst) {
    await this._load();
    // The levels came from the slower series an hour ago at most. Re-deriving
    // them from a fresh D/W/H4 fetch every two minutes is the cost this whole
    // design exists to avoid, so they are passed in instead.
    const cached = this.levels.get(inst.sym)
      || await this._refreshLevels(inst);
    if (!cached.levels.length) throw new Error('no levels');

    const m2 = await this.oanda.getCandles(inst.oanda, 'M2', 200);
    if (!m2 || m2.length < 20) throw new Error('no M2 data');

    const setup = this._withLevels(m2, cached.levels);
    // The other half of the instruction. "Swept or NEAR the daily high or low"
    // is one request with two states, and only the sweep was reported before —
    // proximity existed purely as a cost gate and the number was thrown away.
    const near = this.lib.approach(m2, cached.levels, cached.atr, { within: APPROACH_ATR });
    // Every level's own state, so the screen can put one in each column.
    // Reporting only the best one hides five of the six facts, and which one
    // survives depends on a ranking the reader cannot see.
    const states = this.lib.levelStates(m2, cached.levels, cached.atr, { near: APPROACH_ATR });

    const rec = {
      sym: inst.sym,
      cls: inst.cls,
      at: Date.now(),
      price: +m2[m2.length - 1].c,
      scanned: true,
      setup: setup ? this._slim(setup) : null,
      // An approach carries no direction on purpose: price walking up to
      // yesterday's high may sweep it and turn, or go through and run, and
      // which one happens is exactly what has not been decided yet.
      near: near ? {
        kind: near.level.kind, price: near.level.price, label: near.level.label,
        distance: +near.distance.toFixed(6), atrPct: +near.pct.toFixed(2),
      } : null,
      // One entry per level. H4 swings collapse to the nearest of each side —
      // there are up to three a side and a column can only hold one, so the
      // one price is closest to is the one that matters.
      levels: this._columns(states),
      // The raw level set and its scale, so a restart does not have to re-fetch
      // D, W and H4 for every instrument before it can say anything.
      lv: cached.levels.map(l => [l.kind, l.price, l.side, l.label]),
      atr: cached.atr,
      lvAt: cached.at,
    };
    this.results.set(inst.sym, rec);
    return rec;
  }

  // sweepSetup takes the higher-timeframe series and derives levels from them.
  // Here the levels already exist, so the two halves are run directly. Same
  // functions, same rules — only the fetch is skipped.
  _withLevels(m2, levels) {
    const { findSweep, confirmation, tsOf } = this.lib;
    const sweep = findSweep(m2, levels);
    if (!sweep) return null;
    // When the hunt happened, in wall-clock time. "18 minutes ago" is what
    // decides whether a setup is still worth looking at; a bar index is not.
    const sweptAt = tsOf(m2[sweep.at]);
    const confirm = confirmation(m2, sweep);
    if (!confirm) return { sweep, sweptAt, confirm: null, ready: false, dir: sweep.dir };

    const depth = Math.abs(sweep.extreme - sweep.level.price);
    const entry = m2[confirm.index].c;
    const stop = sweep.dir === 'long' ? sweep.extreme - depth * 0.1 : sweep.extreme + depth * 0.1;
    const age = (m2.length - 1) - confirm.index;
    const fresh = age <= 3;
    const valid = sweep.dir === 'long' ? entry > stop : entry < stop;
    return {
      sweep, confirm, dir: sweep.dir, entry, stop, age, fresh,
      sweptAt, confirmedAt: tsOf(m2[confirm.index]),
      ready: valid && fresh,
      risk: Math.abs(entry - stop),
      reason: `${sweep.level.label} swept and reclaimed, then ${confirm.type} ${sweep.dir === 'long' ? 'up' : 'down'}`
        + (fresh ? '' : ` — ${age} bars ago, the entry has gone`),
    };
  }

  // One state per column, keyed by level kind. The daily and weekly levels are
  // unique so they map straight across; the H4 swings are not, so each side
  // keeps whichever is in the most advanced state, and among equals the nearest.
  _columns(states) {
    const rank = { swept: 3, through: 2, near: 1, quiet: 0 };
    const out = {};
    for (const st of states) {
      const cur = out[st.kind];
      const better = !cur
        || rank[st.state] > rank[cur.state]
        || (rank[st.state] === rank[cur.state] && (st.atrPct ?? 9) < (cur.atrPct ?? 9));
      if (better) {
        out[st.kind] = {
          state: st.state, price: st.price, dir: st.dir,
          atrPct: st.atrPct == null ? null : +st.atrPct.toFixed(2),
          at: st.atTime ?? null,
        };
      }
    }
    return out;
  }

  // Only what a row needs. The full candle arrays and the level list would make
  // the published file enormous for no gain.
  _slim(s) {
    return {
      dir: s.dir,
      ready: !!s.ready,
      state: !s.confirm ? 'taken' : s.ready ? 'setup' : 'missed',
      level: { kind: s.sweep.level.kind, price: s.sweep.level.price, label: s.sweep.level.label },
      extreme: s.sweep.extreme,
      entry: s.entry ?? null,
      stop: s.stop ?? null,
      risk: s.risk ?? null,
      age: s.age ?? null,
      sweptAt: s.sweptAt ?? null,
      confirmedAt: s.confirmedAt ?? null,
      confirm: s.confirm ? { type: s.confirm.type, direction: s.confirm.direction } : null,
      reason: s.reason || null,
    };
  }

  async _announce(rec) {
    const s = rec.setup;
    if (!s || !s.ready || !this.telegram) return;
    const key = `${rec.sym}|${s.level.kind}|${s.level.price}|${s.dir}`;
    const now = Date.now();
    for (const [k, t] of this.announced) if (now - t > ANNOUNCE_TTL) this.announced.delete(k);
    if (this.announced.has(key)) return;
    this.announced.set(key, now);

    const dp = Math.abs(rec.price) < 20 ? 5 : 2;
    await this.telegram.send(
      `<b>SWEEP ${s.dir.toUpperCase()} — ${rec.sym}</b>\n`
      + `${s.level.label} at ${s.level.price.toFixed(dp)} swept and reclaimed\n`
      + `${s.confirm.type} ${s.confirm.direction} on M2\n\n`
      + `entry <b>${s.entry.toFixed(dp)}</b>\n`
      + `stop <b>${s.stop.toFixed(dp)}</b>\n`
      + `risk ${s.risk.toFixed(dp)}\n\n`
      + `<i>Not a measured edge. This model has never been tested here.</i>`
    ).catch(e => this.log(`Liquidity push: ${e.message}`));
  }

  _signature() {
    return JSON.stringify([...this.results.entries()]
      .map(([sym, r]) => [sym, r.setup?.state || null, r.setup?.level?.price ?? null, r.setup?.dir || null,
        r.near?.kind || null,
        // Bucketed, not raw. Publishing the exact distance would rewrite the
        // file every two minutes on any instrument merely drifting near a
        // level, which is most of them on a quiet day.
        r.near ? Math.round(r.near.atrPct * 10) : null,
        // A column changing state is the whole point of the table, so the
        // signature has to see it or the file never gets rewritten.
        Object.entries(r.levels || {}).map(([k, v]) => `${k}:${v.state}`).sort().join(',')])
      .sort());
  }

  /**
   * One pass. `prices` is sym -> last known price, which the feed already
   * holds; without it every instrument would need a request just to find out
   * whether it is worth a request.
   */
  async tick(prices = {}) {
    await this._restore();
    const now = Date.now();
    const insts = this._instruments();

    // 1. Level refresh, round-robin by staleness.
    const stale = insts
      .filter(i => now - (this.levels.get(i.sym)?.at || 0) > LEVELS_TTL)
      .sort((a, b) => (this.levels.get(a.sym)?.at || 0) - (this.levels.get(b.sym)?.at || 0))
      .slice(0, LEVEL_JOBS);
    for (const inst of stale) {
      try { await this._refreshLevels(inst); }
      catch (e) {
        // Back this one off rather than retrying it every tick forever.
        this.levels.set(inst.sym, { levels: [], atr: null, at: now - LEVELS_TTL + 10 * 60e3 });
        this.log(`Liquidity ${inst.sym} levels: ${e.message}`);
      }
    }

    // 2. Scan only what is near a level, least-recently-served first.
    const candidates = insts
      .filter(i => this._near(i.sym, prices[i.sym] ?? this.results.get(i.sym)?.price))
      .filter(i => now - (this.results.get(i.sym)?.at || 0) > SCAN_TTL)
      .sort((a, b) => (this.servedAt.get(a.sym) || 0) - (this.servedAt.get(b.sym) || 0))
      .slice(0, SCAN_JOBS);

    for (const inst of candidates) {
      this.servedAt.set(inst.sym, ++this.seq);
      try {
        const rec = await this._scan(inst);
        await this._announce(rec);
      } catch (e) {
        this.log(`Liquidity ${inst.sym}: ${e.message}`);
      }
    }

    if (stale.length || candidates.length) {
      this.log(`Liquidity: ${stale.length} level refresh, ${candidates.length} scanned, `
        + `${[...this.results.values()].filter(r => r.setup).length} with a sweep`);
    }

    await this._publish();
  }

  async _publish() {
    if (!this.results.size || !this.github) return;
    const sig = this._signature();
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const payload = {
      at: new Date().toISOString(),
      // So a future process can tell whether these levels mean what it means.
      method: LEVEL_METHOD,
      near: NEAR_ATR,
      scanned: this.results.size,
      // How many instruments the scan COULD cover, so a screen can say "8 of
      // 40" rather than implying it looked at all of them. Eight rows with no
      // denominator reads as "the market was quiet"; it meant "the bot has not
      // got to the other thirty-two yet".
      eligible: this._instruments().length,
      withLevels: this._instruments().filter(i => this.levels.get(i.sym)?.levels?.length).length,
      // Instruments with levels but no scan yet are listed so the app can say
      // "not checked" rather than showing nothing and implying "nothing there".
      watching: this._instruments().filter(i => this.levels.get(i.sym)?.levels?.length).map(i => i.sym),
      rows: [...this.results.values()].sort((a, b) => {
        // A live setup outranks a taken level, which outranks an approach to
        // the daily high or low, which outranks an approach to anything else.
        const rank = r => r?.setup?.state === 'setup' ? 5
          : r?.setup?.state === 'taken' ? 4
          : r?.setup ? 3
          : (r?.near?.kind === 'PDH' || r?.near?.kind === 'PDL') ? 2
          : r?.near ? 1 : 0;
        return rank(b) - rank(a)
          || (a.near?.atrPct ?? 9) - (b.near?.atrPct ?? 9)
          || a.sym.localeCompare(b.sym);
      }),
    };
    try {
      this.sha = await this.github.writeJSON(PATH, payload, 'bot: liquidity sweep scan', this.sha, { pretty: false });
    } catch (e) {
      this.log(`Liquidity publish: ${e.message}`);
    }
  }
}

module.exports = { LiquidityScanner, PATH, NEAR_ATR, NEAR_ATR_DAILY, APPROACH_ATR,
  LEVELS_TTL, SCAN_TTL, LEVEL_JOBS, LEVEL_METHOD, atrOf };

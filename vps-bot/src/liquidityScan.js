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

// Levels are yesterday's and last week's, so an hour is generous.
const LEVELS_TTL = 60 * 60e3;
// A two-minute bar closes every two minutes; there is nothing to gain by
// asking more often than that.
const SCAN_TTL = 2 * 60e3;

// Per-tick budgets, kept small on purpose. The feed's own queue gets 26 a tick
// and this must not compete with it for the whole allowance.
const LEVEL_JOBS = 4;
const SCAN_JOBS = 8;

// How close to a level is worth spending a request on, in H4 ATR.
const NEAR_ATR = 1.0;

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
    const band = rec.atr ? rec.atr * NEAR_ATR : Math.abs(price) * 0.002;
    return rec.levels.some(l => Math.abs(price - l.price) <= band);
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

    const rec = {
      sym: inst.sym,
      cls: inst.cls,
      at: Date.now(),
      price: +m2[m2.length - 1].c,
      scanned: true,
      setup: setup ? this._slim(setup) : null,
    };
    this.results.set(inst.sym, rec);
    return rec;
  }

  // sweepSetup takes the higher-timeframe series and derives levels from them.
  // Here the levels already exist, so the two halves are run directly. Same
  // functions, same rules — only the fetch is skipped.
  _withLevels(m2, levels) {
    const { findSweep, confirmation } = this.lib;
    const sweep = findSweep(m2, levels);
    if (!sweep) return null;
    const confirm = confirmation(m2, sweep);
    if (!confirm) return { sweep, confirm: null, ready: false, dir: sweep.dir };

    const depth = Math.abs(sweep.extreme - sweep.level.price);
    const entry = m2[confirm.index].c;
    const stop = sweep.dir === 'long' ? sweep.extreme - depth * 0.1 : sweep.extreme + depth * 0.1;
    const age = (m2.length - 1) - confirm.index;
    const fresh = age <= 3;
    const valid = sweep.dir === 'long' ? entry > stop : entry < stop;
    return {
      sweep, confirm, dir: sweep.dir, entry, stop, age, fresh,
      ready: valid && fresh,
      risk: Math.abs(entry - stop),
      reason: `${sweep.level.label} swept and reclaimed, then ${confirm.type} ${sweep.dir === 'long' ? 'up' : 'down'}`
        + (fresh ? '' : ` — ${age} bars ago, the entry has gone`),
    };
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
      .map(([sym, r]) => [sym, r.setup?.state || null, r.setup?.level?.price ?? null, r.setup?.dir || null])
      .sort());
  }

  /**
   * One pass. `prices` is sym -> last known price, which the feed already
   * holds; without it every instrument would need a request just to find out
   * whether it is worth a request.
   */
  async tick(prices = {}) {
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
      near: NEAR_ATR,
      scanned: this.results.size,
      // Instruments with levels but no scan yet are listed so the app can say
      // "not checked" rather than showing nothing and implying "nothing there".
      watching: this._instruments().filter(i => this.levels.get(i.sym)?.levels?.length).map(i => i.sym),
      rows: [...this.results.values()].sort((a, b) => {
        const rank = s => (s?.setup?.state === 'setup' ? 3 : s?.setup?.state === 'taken' ? 2 : s?.setup ? 1 : 0);
        return rank(b) - rank(a) || a.sym.localeCompare(b.sym);
      }),
    };
    try {
      this.sha = await this.github.writeJSON(PATH, payload, 'bot: liquidity sweep scan', this.sha, { pretty: false });
    } catch (e) {
      this.log(`Liquidity publish: ${e.message}`);
    }
  }
}

module.exports = { LiquidityScanner, PATH, NEAR_ATR, LEVELS_TTL, SCAN_TTL, atrOf };

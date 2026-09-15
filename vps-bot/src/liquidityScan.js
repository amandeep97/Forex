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

// What the replay concluded about this kind of hunt. Read, not computed — the
// study publishes it and this only quotes it.
const STUDY_PATH = 'bot/liquidity-study.json';
const STUDY_TTL = 6 * 3600e3;

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
const LEVEL_METHOD = 4;

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

// How far back the PLAN looks for its sweep, in two-minute bars.
//
// The hunt list uses sixty bars — two hours — because a hunt is news and stale
// news is noise. A plan is not news: it is a resting order, and it is good for
// as long as the level holds. Two hundred and forty bars is eight hours, which
// is what tradePlan's own expiry allows.
//
// These two numbers have to agree. With the plan looking back two hours and
// claiming eight, an armed plan would vanish at the two-hour mark for no reason
// visible on screen — it would simply stop being found.
const PLAN_WINDOW = 240;

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
    this.levels = new Map();     // sym -> { levels, atr, trend, at }
    this.results = new Map();    // sym -> record
    this.h4r = new Map();        // sym -> [[t, logReturn], …] for the pair correlations
    this.corr = new Map();       // 'A|B' -> { r, n, at }
    this.announced = new Map();  // key -> when
    this.sha = null;
    this.lastSig = null;
    this.seq = 0;
    this.servedAt = new Map();
    this.lib = null;
    this.restored = false;
    this.study = null;
    this.studyAt = 0;
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
            trend: r.trend ?? null,
            at: r.lvAt || 0,
          });
        }
        // The measured correlations come back too. They are derived from H4
        // returns that are NOT published, so without this a restart would show
        // no divergence on any row until the hourly level refresh had been
        // round the whole universe again — up to an hour of blank, every
        // deploy, for a number that barely moves between one hour and the next.
        for (const [other, c] of Object.entries(r.corr || {})) {
          const key = [r.sym, other].sort().join('|');
          if (!this.corr.has(key) && Number.isFinite(c?.r)) {
            this.corr.set(key, { r: c.r, n: c.n || 0, at: r.lvAt || 0 });
          }
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
  //
  // Four namespaces, spread into one plain object rather than assigned onto the
  // liquidity namespace. An ES module namespace is frozen: `lib.pairs = ...`
  // throws "object is not extensible", which is how the study's first run died
  // before a test caught it.
  async _load() {
    if (!this.lib) {
      const [liq, structure, sessions, pairs] = await Promise.all([
        import('../../shared/liquidity.mjs'),
        import('../../shared/structure.mjs'),
        import('../../shared/sessions.mjs'),
        import('../../shared/pairs.mjs'),
      ]);
      this.lib = { ...liq, structure, sessions, pairs };
    }
    return this.lib;
  }

  _instruments() {
    return INSTRUMENTS.filter(i => i.can?.candles && i.oanda);
  }

  async _refreshLevels(inst) {
    const lib = await this._load();
    const [daily, weekly, h4] = await Promise.all([
      this.oanda.getCandles(inst.oanda, 'D', 12),
      this.oanda.getCandles(inst.oanda, 'W', 8),
      this.oanda.getCandles(inst.oanda, 'H4', 80),
    ]);
    const levels = lib.keyLevels({ daily, weekly, h4 });
    const atr = atrOf(h4);

    // The four-hour trend, from the candles already in hand. This costs no
    // request — the H4 series was fetched for the levels and the ATR, and was
    // then thrown away, which meant the one fact that separates a stop hunt
    // from a downtrend making a new low was being discarded every hour.
    const trend = lib.structure.readStructure(h4).structure;

    // And the returns, kept in memory for the correlation pass. Not published:
    // seventy-nine floats an instrument is a file three times its current size
    // to carry an input, when the OUTPUT — one number per pair — is what any
    // reader actually needs and restores in a line.
    this.h4r.set(inst.sym, lib.pairs.returnsOf(h4));

    this.levels.set(inst.sym, { levels, atr, trend, at: Date.now() });
    return { levels, atr, trend };
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

    // The plan. Unlike the setup, this is true for hours rather than six
    // minutes — a limit resting at the swept level, a stop beyond the extreme,
    // and a target at the opposite side's liquidity. The setup stays too,
    // because "the break confirmed four minutes ago" is still worth knowing;
    // it just stopped being the only thing on offer.
    const topSweep = this.lib.findSweep(m2, cached.levels, { within: PLAN_WINDOW });
    const plan = topSweep
      ? this.lib.tradePlan(m2, topSweep, cached.levels, cached.atr)
      : null;

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
      // The four-hour structure this instrument is in. Published as the bare
      // reading, not as "with" or "against": alignment depends on which way a
      // particular sweep turns, and a row carries several sweeps that can turn
      // different ways. Deriving it once per sweep, from one published fact,
      // beats publishing the derived answer several times and letting the
      // copies drift — which is how the app and the bot came to disagree about
      // structure the first time.
      trend: cached.trend ?? null,
      plan: plan ? {
        dir: plan.dir, state: plan.state, why: plan.why,
        entry: plan.entry, stop: plan.stop, risk: plan.risk,
        target: plan.target, targetLabel: plan.targetLabel, rr: plan.rr,
        level: { kind: plan.level.kind, price: plan.level.price, label: plan.level.label },
        sweptAt: plan.sweptAt,
        // What kind of trade this is, in words, decided from facts that are
        // already on the row. Neither of these filters the plan out.
        align: this.lib.trendAlign(cached.trend, plan.dir),
        session: this.lib.sessions.sessionStamp(plan.sweptAt),
      } : null,
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
          // Stamped per level, not per row. Two levels on one instrument are
          // routinely taken hours apart — yesterday's high at the London open
          // and a 4H swing in the New York afternoon — and one session on the
          // row would put the wrong label on whichever of them it was not
          // computed from. It is also the key the study's verdict is looked up
          // by, so a row-level approximation would quietly read the wrong cell.
          session: st.atTime ? this.lib.sessions.sessionStamp(st.atTime) : null,
        };
      }
    }
    return out;
  }

  // ── Did it take the level alone, or did the whole complex move? ───────────
  //
  // A post-pass rather than part of _scan, because the answer needs the
  // PARTNER's scan and the two are not scanned in the same tick. Gold may be
  // near a level and scanned while silver is nowhere near one and skipped for
  // hours. Asking inside _scan would give whatever the partner's record said at
  // some arbitrary earlier moment, or nothing at all, and would do it silently.
  //
  // Everything here is arithmetic over data already fetched. No requests.
  _diverge() {
    if (!this.lib) return;
    const { partnersOf, correlate, divergence } = this.lib.pairs;
    const RANK = { PDH: 3, PDL: 3, PWH: 2, PWL: 2, H4H: 1, H4L: 1 };

    for (const rec of this.results.values()) {
      const partners = partnersOf(rec.sym);
      if (!partners.length) { rec.div = null; rec.corr = null; continue; }

      // Correlations first, and for every partner whether or not anything was
      // swept — the number is what makes the divergence claim readable, and
      // recomputing it only at the moment of a sweep would mean the first sweep
      // after a restart had no number to show.
      const corrs = {};
      for (const p of partners) {
        const key = [rec.sym, p.sym].sort().join('|');
        const a = this.h4r.get(rec.sym), b = this.h4r.get(p.sym);
        if (a?.length && b?.length) {
          const c = correlate(a, b);
          if (c) this.corr.set(key, { ...c, at: Date.now() });
        }
        const held = this.corr.get(key);
        if (held) corrs[p.sym] = { r: held.r, n: held.n };
      }
      rec.corr = Object.keys(corrs).length ? corrs : null;

      // One divergence per row, for the level that matters most. A row can have
      // three swept kinds and the feed shows them as separate events, but the
      // daily level is the one being traded off and three near-identical
      // sentences under one instrument is the noise this feed keeps trying to
      // become. The `kind` travels with it so the app attaches it to the right
      // event rather than to all of them.
      const swept = Object.entries(rec.levels || {})
        .filter(([, v]) => v?.state === 'swept')
        .sort((x, y) => (RANK[y[0]] || 0) - (RANK[x[0]] || 0))[0];
      if (!swept) { rec.div = null; continue; }

      let best = null;
      for (const p of partners) {
        const key = [rec.sym, p.sym].sort().join('|');
        const d = divergence({
          sym: rec.sym, kind: swept[0], partner: p,
          corr: this.corr.get(key) || null,
          partnerLevels: this.results.get(p.sym)?.levels || null,
        });
        // The most strongly related partner wins. A pair at 0.9 and a pair at
        // 0.55 disagreeing is not a tie, and showing the weaker one because it
        // happened to be listed first would be arbitrary.
        if (d && (!best || Math.abs(d.r) > Math.abs(best.r))) best = d;
      }
      rec.div = best;
    }
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

  // Announce the PLAN, not the six-minute setup.
  //
  // The old alert fired only on a confirmed setup, which is live for three
  // two-minute bars. By the time a phone buzzes and is picked up, the window
  // has closed — the live file showed zero tradeable rows every single time it
  // was looked at. An armed plan is true for hours, so the message is still
  // worth acting on when it is read.
  async _announce(rec) {
    const p = rec.plan;
    if (!p || p.state !== 'armed' || !this.telegram) return;
    const key = `${rec.sym}|${p.level.kind}|${p.level.price}|${p.dir}`;
    const now = Date.now();
    for (const [k, t] of this.announced) if (now - t > ANNOUNCE_TTL) this.announced.delete(k);
    if (this.announced.has(key)) return;
    this.announced.set(key, now);

    const dp = Math.abs(rec.price) < 20 ? 5 : 2;
    const side = p.dir === 'long' ? 'BUY' : 'SELL';

    // What sixty days of replay says about this exact kind of hunt, in this
    // session. Quoted whether or not it is flattering — especially when it is
    // not, because that is the case a person needs it for.
    const study = await this._loadStudy();
    const ses = p.session?.id;
    const cell = study?.byCell?.[`${p.level.kind}|${ses}`] || null;
    const d = cell?.discovery;
    const verdictLine = cell
      ? `\n\n<b>${study.days}-day replay:</b> ${cell.verdict}`
        + (d?.armed ? ` — ${d.armed} of these, ${Math.round((d.fillRate ?? 0) * 100)}% filled` : '')
        + (d?.edgeR != null ? `, ${d.edgeR > 0 ? '+' : ''}${d.edgeR}R vs baseline` : '')
        + (study.held === 0 ? `\nNo cell in the study beat its baseline on both holdouts.` : '')
      : study
        ? `\n\n<i>The replay has no cell for ${p.level.kind} in the ${p.session?.label || 'this'} session.</i>`
        : `\n\n<i>The replay has not published yet.</i>`;
    await this.telegram.send(
      `<b>${side} LIMIT — ${rec.sym}</b>\n`
      + `${p.level.label} at ${p.level.price.toFixed(dp)} was swept and reclaimed\n\n`
      + `entry <b>${p.entry.toFixed(dp)}</b> (limit, on the retest)\n`
      + `stop <b>${p.stop.toFixed(dp)}</b>\n`
      + (p.target != null
        ? `target <b>${p.target.toFixed(dp)}</b> — ${p.targetLabel}${p.rr ? ` · ${p.rr}R` : ''}\n`
        : `no opposite level to aim at\n`)
      // The three things that say what KIND of trade this is. They do not
      // change whether the message is sent — none of them has been measured
      // here — but they are the difference between a plan you place and one you
      // look at twice, and they cost nothing to carry.
      + (p.align?.align && p.align.align !== 'none' ? `\n${p.align.align === 'with' ? '✓' : '⚠'} ${p.align.text}` : '')
      + (p.session ? `\n· ${p.session.label} session${p.session.overlap ? ' (London/NY overlap)' : ''}` : '')
      + (rec.div ? `\n· ${rec.div.text} (r ${rec.div.r}, ${rec.div.why})` : '')
      + verdictLine
      + `\n\n<i>The order rests until price comes back. It dies if price closes `
      + `beyond ${p.stop.toFixed(dp)}.</i>`
    ).catch(e => this.log(`Liquidity push: ${e.message}`));
  }

  // The replay's verdict, for the alert.
  //
  // The message used to end "Not a measured edge — this model has never been
  // tested here." That was true when it was written and stopped being true the
  // moment the study published. A caveat that has gone stale is worse than no
  // caveat: it says the answer is unknown when the answer is known and is no.
  async _loadStudy() {
    if (this.study && Date.now() - this.studyAt < STUDY_TTL) return this.study;
    try {
      const cur = await this.github.readJSON(STUDY_PATH);
      const cells = cur?.content?.planCells || [];
      this.study = {
        at: cur?.content?.at || null,
        days: cur?.content?.historyDays ?? null,
        byCell: Object.fromEntries(cells.map(c => [`${c.kind}|${c.session}`, c])),
        held: cells.filter(c => c.verdict === 'holds').length,
        total: cells.length,
      };
      this.studyAt = Date.now();
    } catch (e) {
      this.log(`Liquidity study read: ${e.message}`);
      this.studyAt = Date.now();   // do not hammer it every tick
    }
    return this.study;
  }

  _signature() {
    return JSON.stringify([...this.results.entries()]
      .map(([sym, r]) => [sym, r.setup?.state || null, r.setup?.level?.price ?? null, r.setup?.dir || null,
        r.near?.kind || null,
        // Bucketed, not raw. Publishing the exact distance would rewrite the
        // file every two minutes on any instrument merely drifting near a
        // level, which is most of them on a quiet day.
        r.near ? Math.round(r.near.atrPct * 10) : null,
        r.plan ? `${r.plan.state}:${r.plan.dir}:${r.plan.entry}` : null,
        // The context stamps. Without these the file would keep the first
        // version of a row forever: silver taking its own low after gold took
        // one changes gold's row from "alone" to "together", and nothing else
        // on gold's row moves when it happens.
        r.trend || null,
        r.div ? `${r.div.partner}:${r.div.verdict}` : null,
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
    //
    // A level set counts as stale when it is an hour old OR when it is missing
    // something the current code reads off it. The 4H structure and the H4
    // returns were added to _refreshLevels after the published file already
    // existed, so every restored set had levels and prices and no trend — and
    // an hour-old timestamp is the only thing that expires them. The first hour
    // after that deploy, every row would have said "ranging" and shown no
    // divergence, which is indistinguishable on screen from a market where
    // nothing is trending and nothing is diverging.
    //
    // This is deliberately not a LEVEL_METHOD bump. The levels are not wrong,
    // they are incomplete: throwing them away would blank the screen for four
    // minutes to fix something that only needs filling in. The condition also
    // costs nothing once satisfied, and backfills whatever gets added next.
    const incomplete = rec => !rec || rec.trend === undefined || rec.trend === null;
    const stale = insts
      .filter(i => {
        const rec = this.levels.get(i.sym);
        // An instrument with no levels at all is already covered by the age
        // test; this must not resurrect one that was just backed off after a
        // fetch failure, or it would retry every tick forever.
        if (rec && rec.levels.length && incomplete(rec)) return true;
        return now - (rec?.at || 0) > LEVELS_TTL;
      })
      .sort((a, b) => (this.levels.get(a.sym)?.at || 0) - (this.levels.get(b.sym)?.at || 0))
      .slice(0, LEVEL_JOBS);
    for (const inst of stale) {
      try { await this._refreshLevels(inst); }
      catch (e) {
        // Back this one off rather than retrying it every tick forever. `trend`
        // is set — to a definite "unknown" rather than left absent — so the
        // backfill test above does not immediately pick it up again.
        this.levels.set(inst.sym,
          { levels: [], atr: null, trend: 'ranging', at: now - LEVELS_TTL + 10 * 60e3 });
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
        await this._scan(inst);
      } catch (e) {
        this.log(`Liquidity ${inst.sym}: ${e.message}`);
      }
    }

    // Before the alerts, not after. The message says whether the instrument
    // took the level alone or the whole complex moved, and that is one of the
    // few things on it that changes what you would do — sending it and working
    // it out afterwards would put the weaker version on the phone every time.
    this._diverge();
    for (const inst of candidates) {
      const rec = this.results.get(inst.sym);
      if (rec) await this._announce(rec).catch(e => this.log(`Liquidity announce ${inst.sym}: ${e.message}`));
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
  LEVELS_TTL, SCAN_TTL, LEVEL_JOBS, LEVEL_METHOD, PLAN_WINDOW, atrOf };

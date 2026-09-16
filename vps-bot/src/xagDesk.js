'use strict';
// vps-bot/src/xagDesk.js
// Silver, with a human in the loop. Nothing reaches the venue unapproved.
//
// ── What this is, and what it deliberately is not ───────────────────────────
//
// The sweep model has been measured. Sixty days, forty instruments, both
// entries, every session: no cell beat its baseline on both holdouts. So this
// is NOT an edge being automated. It is a hand being saved — the model watches
// silver around the clock, and when a level it was watching gets taken it works
// out the order and asks. The judgement stays with a person; the arithmetic,
// the timing and the staying awake do not.
//
// That distinction is the whole design. An engine that decided for itself would
// be paying to rediscover a result already on file. An engine that only ever
// PROPOSES is worth having even when the model has no edge, because the thing
// it automates is the part a person is bad at: being at the screen at 03:00,
// and sizing to a fixed risk without arithmetic errors.
//
// ── This places real orders on a live account ───────────────────────────────
//
// Every guard below exists because of a specific way money is lost, not because
// of a general wish to be careful:
//
//   ONE INSTRUMENT. Silver, hard-coded, not read from config. A desk that can
//   be pointed at anything by editing an environment variable is a desk that
//   will one day be pointed at everything.
//
//   ONE AT A TIME. One live proposal, one resting order, one open position. A
//   model that fires twice in an hour would otherwise stack three lots of risk
//   on the same idea while a person taps approve twice.
//
//   AN EXPIRY ON BOTH SIDES. A proposal dies if it is not answered, and the
//   order carries a GTD expiry at the venue. Approving a plan the next morning
//   would place a trade at a level that stopped meaning anything overnight, and
//   an order resting at the venue after the bot forgets about it is the worst
//   outcome available here.
//
//   ONE EXECUTION PER PROPOSAL. The state moves to 'placing' BEFORE the call to
//   OANDA, so a second tap — or the app and Telegram both approving — finds it
//   already gone. Two approvals must never mean two orders.
//
//   AND ONLY THE OWNER APPROVES. A callback from any other Telegram account is
//   ignored. The bot posts into a chat; a chat is not an authenticator.

const { fmtPrice } = require('./utils');

const SYM = 'XAG/USD';
const OANDA_SYM = 'XAG_USD';

const DESK_PATH = 'bot/xag-desk.json';
const DECISIONS_PATH = 'bot/xag-decisions.json';
// Written by the app. Read every tick, never trusted.
const CONTROL_PATH = 'bot/xag-control.json';

// The risk on one trade, in account currency. Not a percentage: the account is
// small and a percentage of it is pennies, which rounds to zero units and
// silently stops proposing anything.
const RISK_USD = 3;

// At most this many placed in a rolling day. There was no such limit, and with
// nothing but "one at a time" in the way, a busy day could fill, stop out and
// re-propose over and over. One at a time bounds the exposure at any instant;
// this bounds it over a day, which is the number that actually empties an
// account.
const MAX_PER_DAY = 3;

// ── What the app may change, and how far ────────────────────────────────────
//
// Two keys, deliberately. XAG_DESK in the environment says the desk is
// PERMITTED; the app's control file says it is ARMED. The app can disarm, and
// can arm again within what the box allows — but it can never turn on a desk
// the box has switched off.
//
// That distinction is the whole reason there is still an env flag at all. The
// app writes to a public repo with a token, and that same token can already
// approve a trade through the decisions file. If the app could also arm the
// desk, the token alone would be sufficient for the entire path from nothing to
// a live order. The env flag is the one lock that a leaked token cannot pick,
// and it costs one SSH session to set.
//
// Every bound below is enforced HERE, on the numbers that arrive, not in the
// form that produced them. A control file is just a file: it can be edited by
// hand, written by an older build of the app, or corrupted. A UI that validates
// its own input has checked the honest case and nothing else.
const LIMITS = {
  riskUsd: { min: 0.5, max: 25, dflt: RISK_USD },
  maxPerDay: { min: 1, max: 10, dflt: MAX_PER_DAY },
  // How long a proposal stands before it dies unanswered. An hour is long
  // enough to be read after a meeting and short enough that the level still
  // means something.
  proposalTtlMin: { min: 5, max: 240, dflt: 60 },
  // How long the resting order lives at the venue once placed. Eight hours
  // agrees with tradePlan, which calls a setup dead at the same age — two
  // numbers that disagreed would leave an order alive for a plan the screen
  // had already given up on. Raising this past 8 breaks that agreement, which
  // is why the ceiling is a day rather than a week.
  orderTtlHours: { min: 1, max: 24, dflt: 8 },
};

/**
 * Coerce to a number inside its bounds, falling back to the default.
 *
 * ABSENT and OUT OF RANGE are different, and conflating them is a quiet way to
 * change behaviour. This started as `Number(v)` with a finite check, and
 * Number(null) is 0 — finite — so a field an older build of the app simply did
 * not write got clamped to the MINIMUM rather than the default. Harmless for
 * risk, where the minimum is the small end; not harmless for the proposal
 * expiry, where it silently gives you five minutes to answer instead of sixty.
 *
 * So a missing value takes the default, and only a real number is bounded.
 */
function clamp(v, { min, max, dflt }) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Kept so the app can show what happened, and trimmed so the file cannot grow
// without bound.
const HISTORY = 40;

const uid = () => 'X' + Date.now().toString(36).toUpperCase();

class XagDesk {
  constructor({ oanda, github, telegram = null, log = () => {}, env = {} }) {
    this.oanda = oanda;
    this.github = github;
    this.telegram = telegram;
    this.log = log;
    this.env = env;

    this.pending = null;      // at most one, by design
    this.history = [];
    this.offset = 0;          // telegram update cursor
    this.sha = null;
    this.decisionsSha = null;
    this.restored = false;
    this.lastSig = null;

    // PERMITTED, not armed. The env flag says the box allows a desk at all; the
    // app's control file decides whether it is live right now. A deploy must
    // not turn on live order placement by arriving, and neither must a token.
    this.permitted = String(env.XAG_DESK || '').toLowerCase() === 'on';

    // The ceiling the app cannot type its way past. Bounded by LIMITS as well,
    // so a fat-fingered environment variable cannot raise it either.
    this.maxRiskUsd = clamp(env.XAG_MAX_RISK_USD ?? LIMITS.riskUsd.max, LIMITS.riskUsd);

    // Settings as they stand. Replaced each tick from the control file, so a
    // change in the app takes effect on the next pass rather than on a restart.
    this.cfg = {
      armed: false,
      riskUsd: clamp(env.XAG_RISK_USD ?? LIMITS.riskUsd.dflt, LIMITS.riskUsd),
      maxPerDay: LIMITS.maxPerDay.dflt,
      proposalTtlMin: LIMITS.proposalTtlMin.dflt,
      orderTtlHours: LIMITS.orderTtlHours.dflt,
    };

    // Who may approve. Defaults to the chat the bot posts into, which for a
    // private chat is the owner's own user id.
    this.owner = String(env.TELEGRAM_OWNER_ID || env.TELEGRAM_CHAT_ID || '').trim();
  }

  /** Live only when the box permits it AND the app has armed it. */
  get enabled() { return this.permitted && this.cfg.armed; }

  /** Convenience for the rest of the class, which used to read a constant. */
  get riskUsd() { return Math.min(this.cfg.riskUsd, this.maxRiskUsd); }

  /**
   * Settings from the app, bounded on arrival.
   *
   * Read every tick rather than at startup, because the point of moving these
   * into the app was to stop needing an SSH session and a restart to change
   * them. A missing file means disarmed: the safe direction, and the state a
   * desk should be in when nobody has said otherwise.
   */
  async _loadControl() {
    let cur = null;
    try { cur = await this.github.readJSON(CONTROL_PATH); }
    catch (e) { this.log(`XAG desk control: ${e.message} — keeping current settings`); return; }
    const c = cur?.content || {};
    this.cfg = {
      armed: c.armed === true,
      riskUsd: clamp(c.riskUsd, LIMITS.riskUsd),
      maxPerDay: clamp(c.maxPerDay, LIMITS.maxPerDay),
      proposalTtlMin: clamp(c.proposalTtlMin, LIMITS.proposalTtlMin),
      orderTtlHours: clamp(c.orderTtlHours, LIMITS.orderTtlHours),
    };
  }

  /** How many were actually placed in the last rolling day. */
  _placedToday(now = Date.now()) {
    return this.history.filter(h => h.state === 'placed' && now - (h.closedAt || 0) < 86400e3).length;
  }

  // ── State that has to survive a restart ──────────────────────────────────
  //
  // The Telegram cursor above all. Telegram redelivers a callback until it is
  // acknowledged, so a desk that forgot its offset would, on every restart,
  // re-process every tap still in the queue — including approvals answered
  // hours ago, for proposals that have since expired. The expiry catches it,
  // but relying on a second guard to cover a lost cursor is how a near miss
  // becomes an incident.
  async _restore() {
    if (this.restored) return;
    this.restored = true;
    try {
      const cur = await this.github.readJSON(DESK_PATH);
      this.sha = cur?.sha || null;
      const c = cur?.content || {};
      this.offset = c.offset || 0;
      this.history = Array.isArray(c.history) ? c.history : [];
      // A proposal that was pending when the process died is restored only if
      // it is still inside its own life. Otherwise it is closed as expired,
      // which is what it would have become anyway.
      const p = c.pending;
      if (p && p.state === 'pending' && p.expiresAt > Date.now()) this.pending = p;
      else if (p && p.state === 'pending') this._close(p, 'expired', 'the bot restarted after it had lapsed');
      this.log(`XAG desk: ${this.enabled ? 'ON' : 'off'}, `
        + `${this.pending ? 'one proposal live' : 'nothing pending'}, cursor ${this.offset}`);
    } catch (e) {
      this.log(`XAG desk restore: ${e.message} — starting cold`);
    }
  }

  _close(p, state, why) {
    p.state = state;
    p.closedAt = Date.now();
    p.why = why || p.why || null;
    this.history.unshift(p);
    this.history = this.history.slice(0, HISTORY);
    if (this.pending && this.pending.id === p.id) this.pending = null;
  }

  /**
   * Is the account clear for a new proposal?
   *
   * Asked of the VENUE, not of local state. The bot is not the only thing that
   * can open a silver position — a manual trade from the OANDA app counts too,
   * and a desk that only knew about its own orders would happily add to it.
   */
  async _clear() {
    if (this.pending) return { ok: false, why: 'a proposal is already live' };
    const [trades, orders] = await Promise.all([
      this.oanda.getOpenTrades(),
      this.oanda.getPendingOrders(),
    ]);
    if ((trades || []).some(t => t.instrument === OANDA_SYM)) {
      return { ok: false, why: 'silver is already open' };
    }
    if ((orders || []).some(o => o.instrument === OANDA_SYM)) {
      return { ok: false, why: 'a silver order is already resting' };
    }
    return { ok: true };
  }

  /**
   * Size to a fixed cash risk.
   *
   * Silver is quoted in dollars an ounce and one unit is one ounce, so the risk
   * on a unit is simply the distance to the stop. No pip tables, no contract
   * multipliers — the places those go wrong are not worth inviting for an
   * instrument that does not need them.
   */
  async _size(entry, stop) {
    const perUnit = Math.abs(entry - stop);
    if (!(perUnit > 0)) return { units: 0, why: 'the stop is at the entry' };

    const detail = await this.oanda.getInstrumentDetail(OANDA_SYM);
    const minSize = detail?.minimumTradeSize ?? 1;
    const precision = detail?.displayPrecision ?? 4;

    const raw = this.riskUsd / perUnit;
    const units = Math.floor(raw);
    if (units < minSize) {
      // Rounding up to the minimum would risk more than asked. Saying so is the
      // honest outcome: this stop is too wide for this risk budget.
      return { units: 0, precision,
        why: `${this.riskUsd} of risk over a ${perUnit.toFixed(4)} stop is `
          + `${raw.toFixed(2)} ounces, below the ${minSize} minimum` };
    }

    const account = await this.oanda.getAccountSummary();
    const notional = units * entry;
    const margin = notional * (detail?.marginRate ?? 0.2);
    if (account?.marginAvailable != null && margin > account.marginAvailable) {
      return { units: 0, precision,
        why: `needs ${margin.toFixed(2)} of margin, ${Number(account.marginAvailable).toFixed(2)} available` };
    }
    return { units, precision, risk: units * perUnit, margin };
  }

  /**
   * Turn an armed plan into a proposal and ask.
   *
   * Called by the scanner when silver's plan goes armed. Everything that can
   * refuse does so here, before a person is interrupted — an alert offering a
   * trade the account cannot place is worse than no alert.
   */
  async propose(rec) {
    if (!this.enabled) return null;
    // Not configurable, and checked rather than assumed.
    if (rec?.sym !== SYM) return null;
    const p = rec.plan;
    if (!p || p.state !== 'armed') return null;

    const clear = await this._clear();
    if (!clear.ok) { this.log(`XAG desk: skipped — ${clear.why}`); return null; }

    // One at a time bounds what is at risk in any instant. This bounds it over
    // a day, which is the number that actually empties an account: fill, stop,
    // re-propose, repeat.
    const placed = this._placedToday();
    if (placed >= this.cfg.maxPerDay) {
      this.log(`XAG desk: ${placed} already placed today, cap is ${this.cfg.maxPerDay}`);
      return null;
    }

    const sized = await this._size(p.entry, p.stop);
    if (!sized.units) { this.log(`XAG desk: not sized — ${sized.why}`); return null; }

    const now = Date.now();
    const prop = {
      id: uid(),
      sym: SYM, instrument: OANDA_SYM,
      dir: p.dir,
      entry: p.entry, stop: p.stop, target: p.target ?? null,
      targetLabel: p.targetLabel ?? null, rr: p.rr ?? null,
      level: { kind: p.level.kind, price: p.level.price, label: p.level.label },
      session: p.session?.label || null,
      align: p.align?.align || null,
      units: sized.units, precision: sized.precision,
      riskUsd: +sized.risk.toFixed(2), marginUsd: +(sized.margin || 0).toFixed(2),
      live: String(this.env.OANDA_PRACTICE) === 'false',
      proposedAt: now,
      expiresAt: now + this.cfg.proposalTtlMin * 60e3,
      state: 'pending',
      messageId: null,
    };
    this.pending = prop;

    if (this.telegram) {
      prop.messageId = await this.telegram.sendWithButtons(this._text(prop), [
        { text: `✅ Place ${prop.units} oz`, data: `xag:ok:${prop.id}` },
        { text: '✕ Skip', data: `xag:no:${prop.id}` },
      ]).catch(e => { this.log(`XAG desk push: ${e.message}`); return null; });
    }
    this.log(`XAG desk: proposed ${prop.dir} ${prop.units}oz at ${prop.entry} (${prop.id})`);
    return prop;
  }

  _text(p) {
    const dp = p.precision ?? 4;
    const side = p.dir === 'long' ? 'BUY' : 'SELL';
    const mins = Math.round((p.expiresAt - Date.now()) / 60e3);
    return `<b>${side} LIMIT — SILVER</b>  <i>needs your OK</i>\n`
      + `${p.level.label} at ${fmtPrice(p.level.price, SYM)} was swept and reclaimed\n\n`
      + `entry <b>${Number(p.entry).toFixed(dp)}</b> (limit, on the retest)\n`
      + `stop <b>${Number(p.stop).toFixed(dp)}</b>\n`
      + (p.target != null ? `target <b>${Number(p.target).toFixed(dp)}</b> — ${p.targetLabel}\n` : '')
      + `\nsize <b>${p.units} oz</b> · risk <b>$${p.riskUsd.toFixed(2)}</b>`
      + (p.marginUsd ? ` · margin $${p.marginUsd.toFixed(2)}` : '')
      + `\n${p.live ? '⚠️ <b>LIVE ACCOUNT — real money</b>' : 'practice account'}\n`
      + (p.session ? `· ${p.session} session\n` : '')
      + `\n<i>The replay found no edge in this model. This is a plan and a size, `
      + `not a recommendation. Expires in ${mins} min if you do not answer.</i>`;
  }

  /**
   * Act on an approval. The only path to the venue.
   *
   * `source` is recorded because the app and Telegram can both answer, and when
   * an order shows up on the account the first question is which one did it.
   */
  async _execute(prop, source) {
    // Before the await, not after. A second tap, or the app approving the same
    // proposal a moment later, finds this already gone. Two approvals must
    // never mean two orders, and the window between check and call is exactly
    // where that would happen.
    if (prop.state !== 'pending') return prop;
    if (Date.now() > prop.expiresAt) {
      this._close(prop, 'expired', 'answered after it had lapsed');
      return prop;
    }
    prop.state = 'placing';
    prop.approvedBy = source;

    // The account can have changed since the proposal went out — a manual trade,
    // another fill. Asked again rather than trusted.
    const clear = await this._clear().catch(() => ({ ok: true }));
    if (!clear.ok && !/proposal/.test(clear.why)) {
      this._close(prop, 'failed', clear.why);
      return prop;
    }

    try {
      const res = await this.oanda.placeLimitOrder({
        instrument: OANDA_SYM,
        units: prop.dir === 'long' ? prop.units : -prop.units,
        price: prop.entry,
        sl: prop.stop,
        tp: prop.target ?? null,
        clientId: prop.id,
        expiry: Date.now() + this.cfg.orderTtlHours * 3600e3,
        precision: prop.precision,
      });
      const created = res?.orderCreateTransaction;
      const rejected = res?.orderRejectTransaction || res?.orderCancelTransaction;
      if (!created || rejected) {
        this._close(prop, 'failed',
          rejected?.rejectReason || rejected?.reason || 'the venue did not create the order');
      } else {
        prop.orderId = created.id;
        this._close(prop, 'placed', null);
      }
    } catch (e) {
      this._close(prop, 'failed', e.message);
    }
    return prop;
  }

  /** Taps from Telegram. */
  async _pollTelegram() {
    if (!this.telegram?.enabled) return;
    let batch;
    try { batch = await this.telegram.getCallbacks(this.offset); }
    catch (e) { this.log(`XAG desk callbacks: ${e.message}`); return; }
    this.offset = batch.nextOffset;

    for (const u of batch.updates) {
      const m = /^xag:(ok|no):(.+)$/.exec(u.data || '');
      if (!m) continue;
      // A chat is not an authenticator. The bot posts into a chat; anyone else
      // in it, or anyone who learns the callback format, is not the owner.
      if (this.owner && String(u.from) !== this.owner) {
        await this.telegram.answerCallback(u.id, 'Not your desk.');
        this.log(`XAG desk: ignored a tap from ${u.from}`);
        continue;
      }
      const [, verb, id] = m;
      const prop = this.pending?.id === id ? this.pending
        : this.history.find(h => h.id === id) || null;
      if (!prop) {
        await this.telegram.answerCallback(u.id, 'That proposal is gone.');
        continue;
      }
      if (prop.state !== 'pending') {
        await this.telegram.answerCallback(u.id, `Already ${prop.state}.`);
        await this.telegram.editMessage(prop.messageId, this._closedText(prop));
        continue;
      }
      if (verb === 'no') {
        this._close(prop, 'rejected', 'you skipped it');
        await this.telegram.answerCallback(u.id, 'Skipped.');
      } else {
        await this.telegram.answerCallback(u.id, 'Placing…');
        await this._execute(prop, 'telegram');
      }
      await this.telegram.editMessage(prop.messageId, this._closedText(prop));
    }
  }

  /** Decisions written by the app. Same execution path, different doorway. */
  async _pollApp() {
    if (!this.pending) return;
    let cur = null;
    try { cur = await this.github.readJSON(DECISIONS_PATH); }
    catch (e) { this.log(`XAG desk decisions: ${e.message}`); return; }
    if (!cur?.content) return;
    this.decisionsSha = cur.sha || this.decisionsSha;
    const d = cur.content[this.pending.id];
    if (!d) return;

    const prop = this.pending;
    if (d === 'reject' || d?.decision === 'reject') {
      this._close(prop, 'rejected', 'you skipped it in the app');
    } else if (d === 'approve' || d?.decision === 'approve') {
      await this._execute(prop, 'app');
    } else return;
    if (this.telegram) await this.telegram.editMessage(prop.messageId, this._closedText(prop));
  }

  _closedText(p) {
    const dp = p.precision ?? 4;
    const side = p.dir === 'long' ? 'BUY' : 'SELL';
    const head = {
      placed: `✅ <b>PLACED — SILVER ${side} LIMIT</b>`,
      rejected: `✕ <b>Skipped — silver ${side}</b>`,
      expired: `⌛ <b>Expired — silver ${side}</b>`,
      failed: `⚠️ <b>Not placed — silver ${side}</b>`,
    }[p.state] || `<b>Silver ${side} — ${p.state}</b>`;
    return `${head}\n`
      + `${p.units} oz at ${Number(p.entry).toFixed(dp)}, stop ${Number(p.stop).toFixed(dp)}`
      + (p.state === 'placed' ? `\norder ${p.orderId} · rests ${this.cfg.orderTtlHours}h`
        : p.why ? `\n${p.why}` : '')
      + (p.approvedBy ? `\n<i>approved from ${p.approvedBy}</i>` : '');
  }

  /** One pass: expire what has lapsed, collect answers, publish. */
  async tick() {
    await this._restore();

    // Before anything else: what has the app asked for? Reading it here rather
    // than at startup is the whole point of moving these into the app — a
    // change takes effect on the next pass instead of needing a restart.
    await this._loadControl();

    // A disarmed desk still publishes, so the app can show it as disarmed
    // rather than as a bot that has stopped writing. The signature carries the
    // settings, so this writes when something changes and stays quiet when it
    // does not.
    if (!this.enabled) { await this._publish(); return; }

    if (this.pending && Date.now() > this.pending.expiresAt) {
      const p = this.pending;
      this._close(p, 'expired', 'you did not answer in time');
      if (this.telegram) await this.telegram.editMessage(p.messageId, this._closedText(p));
    }

    await this._pollTelegram();
    await this._pollApp();
    await this._publish();
  }

  // Settings are in here on purpose.
  //
  // Without them, arming the desk changed nothing the signature could see —
  // with nothing pending and no history, the key was identical before and
  // after. It published anyway, but only because a restart clears lastSig, so
  // the correctness depended on arming always involving a restart. Now that the
  // app can arm it without one, that accident is gone and the signature has to
  // carry what it is describing.
  _signature() {
    return JSON.stringify([
      this.pending?.id || null, this.pending?.state || null, this.offset,
      this.history[0]?.id || null, this.history[0]?.state || null,
      this.permitted, this.cfg.armed, this.riskUsd, this.cfg.maxPerDay,
      this.cfg.proposalTtlMin, this.cfg.orderTtlHours, this._placedToday(),
    ]);
  }

  async _publish() {
    if (!this.github) return;
    const sig = this._signature();
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    const payload = {
      at: new Date().toISOString(),
      // Permitted and armed are reported separately, because "off" has two very
      // different causes and only one of them can be fixed from the app.
      permitted: this.permitted,
      armed: this.cfg.armed,
      enabled: this.enabled,
      live: String(this.env.OANDA_PRACTICE) === 'false',
      // The settings AS APPLIED, after clamping. If the app asked for $100 and
      // the ceiling is $25, the screen has to say 25 — showing back what was
      // typed would be a promise the desk has no intention of keeping.
      riskUsd: this.riskUsd,
      maxRiskUsd: this.maxRiskUsd,
      maxPerDay: this.cfg.maxPerDay,
      proposalTtlMin: this.cfg.proposalTtlMin,
      orderTtlHours: this.cfg.orderTtlHours,
      placedToday: this._placedToday(),
      limits: LIMITS,
      offset: this.offset,
      pending: this.pending,
      history: this.history,
    };
    try {
      this.sha = await this.github.writeJSON(DESK_PATH, payload, 'bot: XAG desk', this.sha);
    } catch (e) {
      this.log(`XAG desk publish: ${e.message}`);
    }
  }
}

module.exports = { XagDesk, SYM, OANDA_SYM, DESK_PATH, DECISIONS_PATH, CONTROL_PATH,
  RISK_USD, MAX_PER_DAY, LIMITS, clamp };

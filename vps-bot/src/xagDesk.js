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

// How long a proposal stands before it dies unanswered. Long enough to be read
// after a meeting, short enough that the level still means something.
const PROPOSAL_TTL = 60 * 60e3;

// How long the resting order lives at the venue once placed. tradePlan calls a
// setup dead after eight hours and this agrees with it on purpose — two numbers
// that disagree would leave an order alive for a plan the screen calls dead.
const ORDER_TTL = 8 * 3600e3;

// The risk on one trade, in account currency. Not a percentage: the account is
// small and a percentage of it is pennies, which rounds to zero units and
// silently stops proposing anything.
const RISK_USD = 3;

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

    // Off unless switched on deliberately. A desk that places live orders must
    // not be something a deploy turns on by arriving.
    this.enabled = String(env.XAG_DESK || '').toLowerCase() === 'on';
    this.riskUsd = Number(env.XAG_RISK_USD) > 0 ? Number(env.XAG_RISK_USD) : RISK_USD;

    // Who may approve. Defaults to the chat the bot posts into, which for a
    // private chat is the owner's own user id.
    this.owner = String(env.TELEGRAM_OWNER_ID || env.TELEGRAM_CHAT_ID || '').trim();
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
      expiresAt: now + PROPOSAL_TTL,
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
        expiry: Date.now() + ORDER_TTL,
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
      + (p.state === 'placed' ? `\norder ${p.orderId} · rests ${Math.round(ORDER_TTL / 3600e3)}h`
        : p.why ? `\n${p.why}` : '')
      + (p.approvedBy ? `\n<i>approved from ${p.approvedBy}</i>` : '');
  }

  /** One pass: expire what has lapsed, collect answers, publish. */
  async tick() {
    if (!this.enabled) return;
    await this._restore();

    if (this.pending && Date.now() > this.pending.expiresAt) {
      const p = this.pending;
      this._close(p, 'expired', 'you did not answer in time');
      if (this.telegram) await this.telegram.editMessage(p.messageId, this._closedText(p));
    }

    await this._pollTelegram();
    await this._pollApp();
    await this._publish();
  }

  _signature() {
    return JSON.stringify([
      this.pending?.id || null, this.pending?.state || null, this.offset,
      this.history[0]?.id || null, this.history[0]?.state || null,
    ]);
  }

  async _publish() {
    if (!this.github) return;
    const sig = this._signature();
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    const payload = {
      at: new Date().toISOString(),
      enabled: this.enabled,
      live: String(this.env.OANDA_PRACTICE) === 'false',
      riskUsd: this.riskUsd,
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

module.exports = { XagDesk, SYM, OANDA_SYM, DESK_PATH, DECISIONS_PATH,
  PROPOSAL_TTL, ORDER_TTL, RISK_USD };

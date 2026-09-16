'use strict';
// Silver with a human in the loop — vps-bot/src/xagDesk.js.
//
// This is the only code in the project that moves real money, on a live
// account, so every check here is aimed at a specific way money is lost rather
// than at coverage. The model itself has been measured and has no edge; what is
// being automated is the watching and the arithmetic, and the judgement stays
// with a person. That only holds if the gate between proposal and venue is
// airtight.
const { XagDesk, SYM, OANDA_SYM, PROPOSAL_TTL } = require('../vps-bot/src/xagDesk');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// ── A venue that records what it was asked to do ───────────────────────────
function fakeOanda(o = {}) {
  return {
    placed: [],
    cancelled: [],
    async getOpenTrades() { return o.trades || []; },
    async getPendingOrders() { return o.orders || []; },
    async getInstrumentDetail() {
      return { marginRate: 0.2, minimumTradeSize: 1, displayPrecision: 4, tradeUnitsPrecision: 0 };
    },
    async getAccountSummary() { return { balance: 500, marginAvailable: o.margin ?? 400 }; },
    async placeLimitOrder(req) {
      this.placed.push(req);
      if (o.reject) return { orderRejectTransaction: { rejectReason: o.reject } };
      return { orderCreateTransaction: { id: '9001' } };
    },
    async cancelOrder(id) { this.cancelled.push(id); return {}; },
  };
}

function fakeTelegram(taps = []) {
  return {
    enabled: true, sent: [], edits: [], answered: [], _taps: [...taps],
    async sendWithButtons(text) { this.sent.push(text); return 100 + this.sent.length; },
    async editMessage(id, text) { this.edits.push({ id, text }); },
    async answerCallback(id, text) { this.answered.push(text); },
    async getCallbacks(offset) {
      const updates = this._taps.splice(0);
      return { updates, nextOffset: offset + updates.length };
    },
  };
}

const memGithub = () => {
  const files = {};
  return {
    files,
    async readJSON(p) { return files[p] ? { content: files[p], sha: 'x' } : null; },
    async writeJSON(p, payload) { files[p] = JSON.parse(JSON.stringify(payload)); return 'x'; },
  };
};

const ENV = { XAG_DESK: 'on', OANDA_PRACTICE: 'false', TELEGRAM_CHAT_ID: '55' };

const desk = (oanda, tg, env = {}) => new XagDesk({
  oanda, telegram: tg, github: memGithub(), log: () => {}, env: { ...ENV, ...env },
});

const armed = (over = {}) => ({
  sym: SYM, price: 30.2,
  plan: {
    state: 'armed', dir: 'long', entry: 30.0, stop: 29.5, target: 31.5,
    targetLabel: "yesterday's high", rr: 3,
    level: { kind: 'PDL', price: 30.0, label: "yesterday's low" },
    session: { id: 'ny', label: 'New York', overlap: true },
    align: { align: 'with', text: 'with the 4H trend' },
    ...over,
  },
});

(async () => {
  // ── Off unless deliberately switched on ──────────────────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = desk(o, t, { XAG_DESK: '' });
    check('the desk is off unless XAG_DESK says on',
      (await d.propose(armed())) === null && t.sent.length === 0,
      '', 'a deploy must not turn on live order placement by arriving');
  }

  // ── One instrument, and it is not configurable ───────────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = desk(o, t);
    const gold = { ...armed(), sym: 'XAU/USD' };
    check('anything that is not silver is refused',
      (await d.propose(gold)) === null && t.sent.length === 0,
      '', 'a desk that can be pointed at anything will one day be pointed at everything');
    check('and the instrument it trades is the venue symbol, not the display one',
      OANDA_SYM === 'XAG_USD' && SYM === 'XAG/USD');
  }

  // ── A proposal, sized to the cash risk ───────────────────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = desk(o, t);
    const p = await d.propose(armed());
    // $3 over a 0.50 stop is 6 ounces.
    check('size comes from the risk budget and the stop, not from a lot table',
      p && p.units === 6 && Math.abs(p.riskUsd - 3) < 1e-6,
      `${p?.units} oz risking ${p?.riskUsd}`);
    check('the proposal is pending and nothing has reached the venue',
      p.state === 'pending' && o.placed.length === 0,
      `${o.placed.length} order(s) placed`,
      'this is the whole point: proposing and placing are different acts');
    check('the message says it is a live account, in as many words',
      /LIVE ACCOUNT/.test(t.sent[0]), '',
      'the difference between practice and real money must not be inferred');
    check('and it repeats that the model has no measured edge',
      /no edge/i.test(t.sent[0]));
  }

  // ── A stop too wide for the budget is refused, not rounded up ────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = desk(o, t);
    // A $4 stop against a $3 budget is 0.75 ounces — below the 1 oz minimum.
    const p = await d.propose(armed({ entry: 30, stop: 26 }));
    check('a stop too wide for the risk budget proposes nothing',
      p === null && t.sent.length === 0,
      '', 'rounding up to the minimum would risk more than asked, quietly');
  }

  // ── Margin is checked before a person is interrupted ─────────────────────
  {
    const o = fakeOanda({ margin: 5 }), t = fakeTelegram();
    const d = desk(o, t);
    check('a trade the account cannot margin is never offered',
      (await d.propose(armed())) === null && t.sent.length === 0,
      '', 'an alert offering a trade that cannot be placed is worse than no alert');
  }

  // ── One at a time, asked of the venue rather than of memory ──────────────
  {
    const t = fakeTelegram();
    const d1 = desk(fakeOanda({ trades: [{ instrument: OANDA_SYM }] }), t);
    check('silver already open means no new proposal',
      (await d1.propose(armed())) === null);

    const d2 = desk(fakeOanda({ orders: [{ instrument: OANDA_SYM }] }), t);
    check('and a silver order already resting means the same',
      (await d2.propose(armed())) === null,
      '', 'asked of the venue, because a manual trade from the OANDA app counts too');

    const o3 = fakeOanda(), d3 = desk(o3, t);
    await d3.propose(armed());
    check('a second proposal is refused while one is live',
      (await d3.propose(armed())) === null,
      '', 'otherwise two taps stack two lots of risk on the same idea');
  }

  // ── Approval from Telegram places exactly one order ──────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = desk(o, t);
    const p = await d.propose(armed());
    t._taps.push({ id: 'c1', data: `xag:ok:${p.id}`, from: '55', messageId: p.messageId });
    await d.tick();

    check('an approval places one limit order at the level',
      o.placed.length === 1 && o.placed[0].price === 30 && o.placed[0].units === 6,
      `${o.placed.length} order(s), price ${o.placed[0]?.price}, units ${o.placed[0]?.units}`);
    check('with the stop and target attached, not placed afterwards',
      o.placed[0].sl === 29.5 && o.placed[0].tp === 31.5,
      '', 'separate placement leaves the position unprotected exactly when a level breaks');
    check('and an expiry, so an order cannot outlive the bot that placed it',
      o.placed[0].expiry > Date.now(),
      new Date(o.placed[0].expiry).toISOString());
    check('the proposal is closed as placed and carries the order id',
      d.pending === null && d.history[0].state === 'placed' && d.history[0].orderId === '9001',
      d.history[0]?.state);
    check('the message loses its buttons once answered',
      t.edits.length === 1 && /PLACED/.test(t.edits[0].text),
      '', 'a button that still offers to place is telling you something untrue');

    // The double-tap. This is the one that costs money.
    t._taps.push({ id: 'c2', data: `xag:ok:${p.id}`, from: '55', messageId: p.messageId });
    await d.tick();
    check('tapping approve a second time does not place a second order',
      o.placed.length === 1,
      `${o.placed.length} order(s) after two taps`,
      'two approvals must never mean two orders');
  }

  // ── A sell is mirrored, not half-mirrored ────────────────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = desk(o, t);
    const p = await d.propose(armed({ dir: 'short', entry: 30, stop: 30.5, target: 28.5 }));
    t._taps.push({ id: 'c1', data: `xag:ok:${p.id}`, from: '55' });
    await d.tick();
    check('a short is sent as negative units with the stop above',
      o.placed[0].units === -6 && o.placed[0].sl === 30.5 && o.placed[0].tp === 28.5,
      `${o.placed[0].units} units, sl ${o.placed[0].sl}`);
  }

  // ── Skip places nothing ──────────────────────────────────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = desk(o, t);
    const p = await d.propose(armed());
    t._taps.push({ id: 'c1', data: `xag:no:${p.id}`, from: '55' });
    await d.tick();
    check('skipping closes the proposal and sends nothing to the venue',
      o.placed.length === 0 && d.history[0].state === 'rejected' && d.pending === null,
      `${o.placed.length} order(s), state ${d.history[0]?.state}`);
  }

  // ── Only the owner may approve ───────────────────────────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = desk(o, t);
    const p = await d.propose(armed());
    t._taps.push({ id: 'c1', data: `xag:ok:${p.id}`, from: '999' });
    await d.tick();
    check('a tap from anyone else places nothing',
      o.placed.length === 0 && d.pending?.state === 'pending',
      `${o.placed.length} order(s)`,
      'the bot posts into a chat; a chat is not an authenticator');
    check('and the stranger is told so rather than ignored silently',
      t.answered.some(x => /not your desk/i.test(x)), t.answered.join('|'));
  }

  // ── Expiry, on the proposal ──────────────────────────────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = desk(o, t);
    const p = await d.propose(armed());
    p.expiresAt = Date.now() - 1000;
    await d.tick();
    check('an unanswered proposal lapses on its own',
      d.pending === null && d.history[0].state === 'expired',
      d.history[0]?.state);

    t._taps.push({ id: 'c1', data: `xag:ok:${p.id}`, from: '55' });
    await d.tick();
    check('and approving it afterwards still places nothing',
      o.placed.length === 0,
      '', 'a level that mattered an hour ago is not a level now');
  }

  // ── The venue refusing is recorded, not swallowed ────────────────────────
  {
    const o = fakeOanda({ reject: 'PRICE_PRECISION_EXCEEDED' }), t = fakeTelegram();
    const d = desk(o, t);
    const p = await d.propose(armed());
    t._taps.push({ id: 'c1', data: `xag:ok:${p.id}`, from: '55' });
    await d.tick();
    check('a rejected order closes as failed with the venue&apos;s reason',
      d.history[0].state === 'failed' && /PRECISION/.test(d.history[0].why),
      `${d.history[0]?.state}: ${d.history[0]?.why}`,
      'a ghost "placed" would blind the one-at-a-time guard');
    check('and the message says it did not go through',
      t.edits.some(e => /Not placed/.test(e.text)));
  }

  // ── The app is the same gate, not a second one ───────────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const gh = memGithub();
    const d = new XagDesk({ oanda: o, telegram: t, github: gh, log: () => {}, env: ENV });
    const p = await d.propose(armed());
    gh.files['bot/xag-decisions.json'] = { [p.id]: 'approve' };
    await d.tick();
    check('an approval written by the app places the order too',
      o.placed.length === 1 && d.history[0].approvedBy === 'app',
      `${o.placed.length} order(s) via ${d.history[0]?.approvedBy}`);

    // And the race that matters: both doorways answering the same proposal.
    const o2 = fakeOanda(), t2 = fakeTelegram(), gh2 = memGithub();
    const d2 = new XagDesk({ oanda: o2, telegram: t2, github: gh2, log: () => {}, env: ENV });
    const p2 = await d2.propose(armed());
    gh2.files['bot/xag-decisions.json'] = { [p2.id]: 'approve' };
    t2._taps.push({ id: 'c1', data: `xag:ok:${p2.id}`, from: '55' });
    await d2.tick();
    check('the app and Telegram approving the same proposal is still one order',
      o2.placed.length === 1,
      `${o2.placed.length} order(s) from two doorways`,
      'this is why the state moves before the call, not after it');
  }

  // ── The Telegram cursor survives a restart ───────────────────────────────
  {
    const gh = memGithub();
    const o = fakeOanda(), t = fakeTelegram();
    const d = new XagDesk({ oanda: o, telegram: t, github: gh, log: () => {}, env: ENV });
    const p = await d.propose(armed());
    t._taps.push({ id: 'c1', data: `xag:no:${p.id}`, from: '55' });
    await d.tick();
    const cursor = d.offset;
    check('the cursor advances past a processed tap', cursor > 0, String(cursor));

    const d2 = new XagDesk({ oanda: fakeOanda(), telegram: fakeTelegram(), github: gh, log: () => {}, env: ENV });
    await d2._restore();
    check('and a restart picks it up rather than replaying the queue',
      d2.offset === cursor, `${d2.offset} vs ${cursor}`,
      'Telegram redelivers until acknowledged; a lost cursor re-answers old taps');
  }

  // ── A proposal that outlived the process is not resurrected ──────────────
  {
    const gh = memGithub();
    gh.files['bot/xag-desk.json'] = {
      offset: 5, history: [],
      pending: { id: 'OLD', state: 'pending', expiresAt: Date.now() - 60e3, dir: 'long',
        entry: 30, stop: 29.5, units: 6 },
    };
    const o = fakeOanda();
    const d = new XagDesk({ oanda: o, telegram: fakeTelegram(), github: gh, log: () => {}, env: ENV });
    await d._restore();
    check('a pending proposal that lapsed while the bot was down is closed, not restored',
      d.pending === null && d.history[0]?.state === 'expired',
      d.history[0]?.state);
  }

  // ── A desk that is off still tells the app it is off ────────────────────
  //
  // tick() returned early when disabled, so bot/xag-desk.json was never
  // written and the panel had no file to read. It showed "the desk has not
  // published yet", which reads as broken when the truth is that it is
  // switched off and behaving correctly.
  {
    const gh = memGithub();
    const d = new XagDesk({ oanda: fakeOanda(), telegram: fakeTelegram(), github: gh,
      log: () => {}, env: { ...ENV, XAG_DESK: '' } });
    await d.tick();
    const file = gh.files['bot/xag-desk.json'];
    check('an off desk publishes its state so the app can say OFF',
      !!file && file.enabled === false,
      file ? `enabled=${file.enabled}` : '(no file)',
      'no file at all is indistinguishable from a broken bot');
    check('and it still places nothing',
      d.pending === null && (await d.propose(armed())) === null);

    // And it does not rewrite that file every tick forever.
    const before = JSON.stringify(gh.files['bot/xag-desk.json']);
    await d.tick(); await d.tick();
    check('an off desk writes once, not on every tick',
      JSON.stringify(gh.files['bot/xag-desk.json']) === before,
      '', 'the signature check is what keeps a disabled feature from churning the repo');
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

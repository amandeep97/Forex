'use strict';
// Silver with a human in the loop — vps-bot/src/xagDesk.js.
//
// This is the only code in the project that moves real money, on a live
// account, so every check here is aimed at a specific way money is lost rather
// than at coverage. The model itself has been measured and has no edge; what is
// being automated is the watching and the arithmetic, and the judgement stays
// with a person. That only holds if the gate between proposal and venue is
// airtight.
const { XagDesk, SYM, OANDA_SYM, CONTROL_PATH, LIMITS, clamp } = require('../vps-bot/src/xagDesk');

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

// Armed is now a thing the APP says, not the environment. The env flag only
// permits a desk to exist; the control file decides whether it is live. So the
// harness seeds that file and loads it, which is the same path production
// takes — a helper that just set cfg.armed would be testing a door nobody uses.
const CONTROL = { armed: true, riskUsd: 3, maxPerDay: 3, proposalTtlMin: 60, orderTtlHours: 8 };

async function mkDesk(oanda, tg, { env = {}, control = {}, github = null } = {}) {
  const gh = github || memGithub();
  if (control !== false) gh.files[CONTROL_PATH] = { ...CONTROL, ...control };
  const d = new XagDesk({ oanda, telegram: tg, github: gh, log: () => {}, env: { ...ENV, ...env } });
  await d._loadControl();
  d._gh = gh;
  return d;
}

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
    const d = await mkDesk(o, t, { env: { XAG_DESK: '' } });
    check('the desk is off unless XAG_DESK says on',
      (await d.propose(armed())) === null && t.sent.length === 0,
      '', 'a deploy must not turn on live order placement by arriving');
  }

  // ── One instrument, and it is not configurable ───────────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = await mkDesk(o, t);
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
    const d = await mkDesk(o, t);
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
    const d = await mkDesk(o, t);
    // A $4 stop against a $3 budget is 0.75 ounces — below the 1 oz minimum.
    const p = await d.propose(armed({ entry: 30, stop: 26 }));
    check('a stop too wide for the risk budget proposes nothing',
      p === null && t.sent.length === 0,
      '', 'rounding up to the minimum would risk more than asked, quietly');
  }

  // ── Margin is checked before a person is interrupted ─────────────────────
  {
    const o = fakeOanda({ margin: 5 }), t = fakeTelegram();
    const d = await mkDesk(o, t);
    check('a trade the account cannot margin is never offered',
      (await d.propose(armed())) === null && t.sent.length === 0,
      '', 'an alert offering a trade that cannot be placed is worse than no alert');
  }

  // ── One at a time, asked of the venue rather than of memory ──────────────
  {
    const t = fakeTelegram();
    const d1 = await mkDesk(fakeOanda({ trades: [{ instrument: OANDA_SYM }] }), t);
    check('silver already open means no new proposal',
      (await d1.propose(armed())) === null);

    const d2 = await mkDesk(fakeOanda({ orders: [{ instrument: OANDA_SYM }] }), t);
    check('and a silver order already resting means the same',
      (await d2.propose(armed())) === null,
      '', 'asked of the venue, because a manual trade from the OANDA app counts too');

    const o3 = fakeOanda(), d3 = await mkDesk(o3, t);
    await d3.propose(armed());
    check('a second proposal is refused while one is live',
      (await d3.propose(armed())) === null,
      '', 'otherwise two taps stack two lots of risk on the same idea');
  }

  // ── Approval from Telegram places exactly one order ──────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = await mkDesk(o, t);
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
    const d = await mkDesk(o, t);
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
    const d = await mkDesk(o, t);
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
    const d = await mkDesk(o, t);
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
    const d = await mkDesk(o, t);
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
    const d = await mkDesk(o, t);
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
    const d = await mkDesk(o, t);
    const gh = d._gh;
    const p = await d.propose(armed());
    gh.files['bot/xag-decisions.json'] = { [p.id]: 'approve' };
    await d.tick();
    check('an approval written by the app places the order too',
      o.placed.length === 1 && d.history[0].approvedBy === 'app',
      `${o.placed.length} order(s) via ${d.history[0]?.approvedBy}`);

    // And the race that matters: both doorways answering the same proposal.
    const o2 = fakeOanda(), t2 = fakeTelegram();
    const d2 = await mkDesk(o2, t2);
    const gh2 = d2._gh;
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
    const o = fakeOanda(), t = fakeTelegram();
    const d = await mkDesk(o, t);
    const gh = d._gh;
    const p = await d.propose(armed());
    t._taps.push({ id: 'c1', data: `xag:no:${p.id}`, from: '55' });
    await d.tick();
    const cursor = d.offset;
    check('the cursor advances past a processed tap', cursor > 0, String(cursor));

    const d2 = await mkDesk(fakeOanda(), fakeTelegram(), { github: gh });
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
    const d = await mkDesk(fakeOanda(), fakeTelegram(), { github: gh });
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
    const d = await mkDesk(fakeOanda(), fakeTelegram(), { github: gh, env: { XAG_DESK: '' } });
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

  // ── Two keys: the box permits, the app arms ──────────────────────────────
  //
  // Arming moved into the app so a change does not need SSH and a restart. The
  // env flag stays, and it is not redundant: the app writes to a public repo
  // with a token, and that same token can already approve a trade through the
  // decisions file. If the app could arm the desk too, the token alone would be
  // enough for the whole path from nothing to a live order.
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = await mkDesk(o, t, { env: { XAG_DESK: '' }, control: { armed: true } });
    check('the app cannot arm a desk the box has not permitted',
      d.enabled === false && (await d.propose(armed())) === null && t.sent.length === 0,
      `permitted=${d.permitted} armed=${d.cfg.armed}`,
      'the env flag is the one lock a leaked token cannot pick');

    const d2 = await mkDesk(fakeOanda(), fakeTelegram(), { control: { armed: false } });
    check('and a permitted desk stays off until the app arms it',
      d2.permitted === true && d2.enabled === false,
      `permitted=${d2.permitted} enabled=${d2.enabled}`);

    const d3 = await mkDesk(fakeOanda(), fakeTelegram(), { control: false });
    check('no control file at all means disarmed, not armed',
      d3.enabled === false,
      '', 'a missing file must fail in the safe direction');

    // Disarming takes effect on the next pass, with no restart.
    const d4 = await mkDesk(fakeOanda(), fakeTelegram());
    check('an armed desk is live', d4.enabled === true);
    d4._gh.files[CONTROL_PATH] = { ...CONTROL, armed: false };
    await d4.tick();
    check('and disarming in the app takes hold on the next tick',
      d4.enabled === false,
      '', 'that is the whole point of moving it out of the environment');
  }

  // ── The numbers are bounded here, not in the form ────────────────────────
  //
  // A control file is just a file. It can be hand-edited, written by an older
  // build, or corrupted. A UI that validates its own input has checked the
  // honest case and nothing else.
  {
    const wild = await mkDesk(fakeOanda(), fakeTelegram(), {
      control: { armed: true, riskUsd: 100000, maxPerDay: 999, proposalTtlMin: 0, orderTtlHours: 9999 },
    });
    check('an absurd risk is clamped to the ceiling, not honoured',
      wild.riskUsd === LIMITS.riskUsd.max, `$${wild.riskUsd}`);
    check('and so are the cap and both expiries',
      wild.cfg.maxPerDay === LIMITS.maxPerDay.max
      && wild.cfg.proposalTtlMin === LIMITS.proposalTtlMin.min
      && wild.cfg.orderTtlHours === LIMITS.orderTtlHours.max,
      `${wild.cfg.maxPerDay}/day, ${wild.cfg.proposalTtlMin}min, ${wild.cfg.orderTtlHours}h`);

    const junk = await mkDesk(fakeOanda(), fakeTelegram(), {
      control: { armed: true, riskUsd: 'lots', maxPerDay: null },
    });
    check('nonsense falls back to the default rather than to NaN',
      junk.riskUsd === LIMITS.riskUsd.dflt && junk.cfg.maxPerDay === LIMITS.maxPerDay.dflt,
      `$${junk.riskUsd}, ${junk.cfg.maxPerDay}/day`,
      'NaN units would reach the venue as a rejected order at best');

    // Absent is not the same as out of range. Number(null) is 0, which is
    // finite, so a field an older app build never wrote used to be clamped to
    // the MINIMUM — five minutes to answer a proposal instead of sixty.
    const partial = await mkDesk(fakeOanda(), fakeTelegram(), { control: { armed: true } });
    check('a field the app never wrote takes the default, not the minimum',
      partial.cfg.proposalTtlMin === LIMITS.proposalTtlMin.dflt
      && partial.cfg.orderTtlHours === LIMITS.orderTtlHours.dflt
      && partial.cfg.maxPerDay === LIMITS.maxPerDay.dflt,
      `${partial.cfg.proposalTtlMin}min, ${partial.cfg.orderTtlHours}h, ${partial.cfg.maxPerDay}/day`,
      'an older build of the app must not silently shorten your answering window');

    // The environment keeps a ceiling the app cannot type past.
    const capped = await mkDesk(fakeOanda(), fakeTelegram(), {
      env: { XAG_MAX_RISK_USD: '5' }, control: { armed: true, riskUsd: 25 },
    });
    check('the box can set a ceiling below the app’s own maximum',
      capped.riskUsd === 5, `$${capped.riskUsd}`);
  }

  // ── The risk setting actually changes the size ───────────────────────────
  {
    const o = fakeOanda();
    const d = await mkDesk(o, fakeTelegram(), { control: { armed: true, riskUsd: 6 } });
    const p = await d.propose(armed());
    check('doubling the risk doubles the ounces',
      p.units === 12 && Math.abs(p.riskUsd - 6) < 1e-6,
      `${p.units} oz risking $${p.riskUsd}`,
      '$6 over a $0.50 stop is 12 ounces');
  }

  // ── A cap on the day, not just on the moment ─────────────────────────────
  //
  // "One at a time" bounds what is at risk in any instant. It does nothing
  // about fill, stop, re-propose, repeat — which is the pattern that empties an
  // account over an afternoon.
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = await mkDesk(o, t, { control: { armed: true, maxPerDay: 2 } });
    const now = Date.now();
    d.history = [
      { id: 'a', state: 'placed', closedAt: now - 3600e3 },
      { id: 'b', state: 'placed', closedAt: now - 7200e3 },
    ];
    check('at the daily cap nothing is proposed',
      (await d.propose(armed())) === null && t.sent.length === 0,
      `${d._placedToday()} placed today, cap 2`);

    // Skipped and expired proposals are not trades and must not count.
    d.history = [
      { id: 'a', state: 'rejected', closedAt: now - 3600e3 },
      { id: 'b', state: 'expired', closedAt: now - 7200e3 },
      { id: 'c', state: 'failed', closedAt: now - 7200e3 },
    ];
    check('skipped, expired and failed do not spend from the cap',
      d._placedToday() === 0 && (await d.propose(armed())) !== null,
      `${d._placedToday()} counted`,
      'only an order that actually reached the venue is a trade');

    // And the window rolls.
    const e = await mkDesk(fakeOanda(), fakeTelegram(), { control: { armed: true, maxPerDay: 1 } });
    e.history = [{ id: 'a', state: 'placed', closedAt: now - 25 * 3600e3 }];
    check('yesterday’s fills do not count against today',
      e._placedToday() === 0 && (await e.propose(armed())) !== null);
  }

  // ── What the app is shown is what is in force ────────────────────────────
  {
    const d = await mkDesk(fakeOanda(), fakeTelegram(), {
      control: { armed: true, riskUsd: 999, maxPerDay: 2 },
    });
    await d.tick();
    const f = d._gh.files['bot/xag-desk.json'];
    check('the published settings are the clamped ones, not what was typed',
      f.riskUsd === LIMITS.riskUsd.max && f.maxPerDay === 2,
      `$${f.riskUsd}, ${f.maxPerDay}/day`,
      'echoing back an unhonoured number is a promise the desk will not keep');
    check('permitted and armed are reported separately',
      f.permitted === true && f.armed === true && f.enabled === true,
      '', 'off has two causes and only one of them is fixable from the app');
    check('and the limits travel with it, so the form knows its own bounds',
      f.limits?.riskUsd?.max === LIMITS.riskUsd.max);

    // The signature has to see a settings change or the app never sees its edit
    // land — the file would keep showing the old numbers.
    const before = JSON.stringify(d._gh.files['bot/xag-desk.json']);
    d._gh.files[CONTROL_PATH] = { ...CONTROL, armed: true, riskUsd: 7 };
    await d.tick();
    check('changing a setting republishes, so the screen catches up',
      JSON.stringify(d._gh.files['bot/xag-desk.json']) !== before
      && d._gh.files['bot/xag-desk.json'].riskUsd === 7,
      `$${d._gh.files['bot/xag-desk.json'].riskUsd}`,
      'the signature used to omit settings and only published by restart accident');
  }

  // ── The expiries are the ones the app asked for ──────────────────────────
  {
    const o = fakeOanda(), t = fakeTelegram();
    const d = await mkDesk(o, t, { control: { armed: true, proposalTtlMin: 15, orderTtlHours: 2 } });
    const p = await d.propose(armed());
    const mins = Math.round((p.expiresAt - p.proposedAt) / 60e3);
    check('a proposal lives as long as the app said', mins === 15, `${mins} min`);

    t._taps.push({ id: 'c1', data: `xag:ok:${p.id}`, from: '55' });
    await d.tick();
    const hours = Math.round((o.placed[0].expiry - Date.now()) / 3600e3);
    check('and the order rests for as long as the app said', hours === 2, `${hours}h`);
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

// src/utils/tradePlan.js
// Turns "this is unusual" into a trade you can accept or refuse.
//
// Every screen in this app stopped at the same place: it told you an
// instrument was interesting and left the entry, the stop, the size and the
// decision to you. That is the gap between a watchlist and a tool. Everything
// needed to close it was already in the feed — ATR for distance, the swept
// level for structure, the spread for cost, and the measured record of what
// followed the same setup before.
//
// Two things make this different from the usual "signal":
//
// The TARGET comes from what actually happened. Not 1:2 because 1:2 sounds
// disciplined — the median move that followed this exact setup on this exact
// instrument, measured over every prior occurrence with a complete forward
// window. The reward-to-risk falls out of the data instead of being chosen.
//
// And it can say NO. Gold's daily strong reversals have gone the wrong way
// 77% of the time over thirteen occurrences, median −1.4 ATR. A tool that
// draws an entry and a target on that is worse than one that says nothing.
// When the record contradicts the signal, this says so and refuses to price
// a trade.
//
// It is still not a prediction. It is a fully specified proposal with its
// historical record attached, and the record is frequently discouraging.

// Stop distance, in ATR. Wide enough that ordinary noise does not take it out,
// tight enough that the measured median move is worth more than the risk.
const DEFAULT_STOP_ATR = 1.5;

// Below this many prior occurrences the record cannot price anything. Ten is
// already thin; it is stated as thin rather than hidden.
const MIN_RECORD = 10;

// A spread this far above its own median means conditions are not normal —
// news, a rollover, or a thin session. The setup may be fine and the fill
// will not be.
const MAX_SPREAD_RATIO = 1.6;

// Cost that eats this much of the stop makes the maths unrecoverable: a 2R
// target loses a fifth of its value before the trade starts.
const MAX_COST_SHARE = 0.10;

const round = (v, dec) => v == null ? null : +v.toFixed(dec ?? 5);

// The piece of evidence the plan is built on: the freshest thing that carries
// a measured record, falling back to the strongest directional evidence.
function anchorOf(a) {
  const withRecord = a.evidence.filter(e => e.base && e.dir);
  if (withRecord.length) {
    return withRecord.sort((x, y) => (y.base.n ?? 0) - (x.base.n ?? 0))[0];
  }
  return a.evidence.find(e => e.dir) || null;
}

export function buildPlan(a, rec, { balance = 10000, riskPct = 1, stopAtr = DEFAULT_STOP_ATR } = {}) {
  if (!a || !rec) return null;
  const anchor = anchorOf(a);
  if (!anchor) return { ok: false, reason: 'no directional evidence to build a trade from' };

  const tf = (anchor.tfs || [])[0] || 'D';
  const st = rec.state?.[tf];
  const price = rec.price;
  if (!st?.atrPct || !price) return { ok: false, reason: `no volatility measurement on ${tf} yet` };

  const atr = price * (st.atrPct / 100);
  const dir = anchor.dir;
  const long = dir === 'up';

  const stopDist = atr * stopAtr;
  const stop = long ? price - stopDist : price + stopDist;

  const base = anchor.base;
  const spreadAbs = rec.state?.spreadAbs ?? null;
  const spreadRatio = rec.state?.spreadRatio ?? null;

  // Cost first: it is the one number that can kill a trade regardless of how
  // good the setup looks, and it is knowable before anything else.
  const costShare = spreadAbs && stopDist > 0 ? spreadAbs / stopDist : null;

  const plan = {
    ok: true,
    sym: a.sym, dir, tf,
    why: anchor.label,
    entry: round(price, rec.dec),
    stop: round(stop, rec.dec),
    stopDist: round(stopDist, rec.dec),
    stopAtr,
    atr: round(atr, rec.dec),
    spreadAbs, spreadRatio,
    costShare: costShare == null ? null : +(costShare * 100).toFixed(1),
    record: base ? { n: base.n, win: base.win, medAtr: base.med, bars: base.bars } : null,
  };

  // ── What the record says ─────────────────────────────────────────────────
  if (!base) {
    plan.verdict = 'unpriced';
    plan.note = 'no measured record for this setup on this instrument — the trade can be drawn but not priced';
  } else if (base.n < MIN_RECORD) {
    plan.verdict = 'thin';
    plan.note = `only ${base.n} prior occurrences — too few to price a target from`;
  } else if (base.med <= 0) {
    // The important case, and the one no other tool will tell you.
    plan.verdict = 'record-says-no';
    plan.note = `the last ${base.n} times this fired here, the median outcome was `
      + `${base.med} ATR — against the signal. ${base.win}% went its way. `
      + `This setup has not worked on this instrument.`;
  } else {
    const target = long ? price + base.med * atr : price - base.med * atr;
    const rr = (base.med * atr) / stopDist;
    const win = base.win / 100;
    // Expectancy in R from the instrument's own record, not from an assumed
    // win rate. Losers are taken at 1R by construction.
    const ev = win * rr - (1 - win);
    Object.assign(plan, {
      target: round(target, rec.dec),
      rr: +rr.toFixed(2),
      ev: +ev.toFixed(2),
    });
    plan.verdict = ev <= 0 ? 'negative' : 'priced';
    if (ev <= 0) {
      plan.note = `${base.win}% at ${rr.toFixed(2)}R is ${ev.toFixed(2)}R per trade — `
        + `the historical record does not pay for the risk`;
    }
  }

  // ── Conditions that override a good setup ────────────────────────────────
  if (spreadRatio != null && spreadRatio > MAX_SPREAD_RATIO) {
    plan.blocked = `spread is ${spreadRatio}× its normal level — wait for conditions to settle`;
  } else if (costShare != null && costShare > MAX_COST_SHARE) {
    plan.blocked = `the spread is ${(costShare * 100).toFixed(0)}% of your stop — the cost is too large a share of the risk`;
  }

  // ── Size ─────────────────────────────────────────────────────────────────
  // Only for trades worth taking. Printing a position size next to a setup the
  // record rejects is an invitation, and this is meant to be the opposite.
  const worth = plan.verdict === 'priced' && !plan.blocked;
  if (worth) {
    const riskAmount = balance * (riskPct / 100);
    plan.riskAmount = +riskAmount.toFixed(2);
    // Fractional, not floored. Gold at 4,369 with a 140-point stop needs 0.71
    // units to risk $100 — flooring that to zero silently turns every plan on
    // an expensive instrument into "no position", which reads as a bug in the
    // setup rather than in the arithmetic.
    plan.units = stopDist > 0 ? +(riskAmount / stopDist).toFixed(4) : 0;
    plan.riskPct = riskPct;
    // A size below the smallest tradeable amount is a real constraint, and the
    // honest thing is to say the account cannot take this trade at this risk
    // rather than to round it up.
    if (plan.units < 0.01) {
      plan.blocked = `${riskPct}% of ${balance} is ${riskAmount.toFixed(2)}, which is smaller than `
        + `the minimum position at a ${plan.stopDist} stop — raise the risk or skip this one`;
    }
  }

  plan.take = worth && !plan.blocked;
  return plan;
}

// One line summarising why a plan is or is not worth taking, for a screen that
// has room for exactly one line.
export function verdictLine(plan) {
  if (!plan?.ok) return plan?.reason || '';
  switch (plan.verdict) {
    case 'priced':          return `${plan.rr}R target from the record · ${plan.record.win}% · ${plan.ev > 0 ? '+' : ''}${plan.ev}R expected`;
    case 'negative':        return plan.note;
    case 'record-says-no':  return plan.note;
    case 'thin':            return plan.note;
    default:                return plan.note || '';
  }
}

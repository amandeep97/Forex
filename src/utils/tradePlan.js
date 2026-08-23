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

import { tellsUsSomething, MIN_EXP_R, MAX_COST_SHARE } from './confluence';

// ── Horizon ──────────────────────────────────────────────────────────────────
//
// The plan is priced on the timeframe the trade will be HELD on, not the one
// that happened to fire.
//
// This picked whichever piece of evidence carried the largest sample, which on
// a Daily setup with an H1 pattern attached was usually the H1 one — so a trade
// meant to run for a fortnight got an H1 ATR stop, an H1 target, and a size
// computed for a hold of a few hours. Every number was individually correct and
// the plan as a whole described a trade nobody was going to take.
//
// Slowest first, so a pattern present on both M15 and Daily prices as the daily
// event it is.
const TF_ORDER = ['D', 'H4', 'H1', 'M30', 'M15'];
const SWING_TFS = new Set(['D', 'H4']);

const TF_MS = { D: 86400e3, H4: 14400e3, H1: 3600e3, M30: 1800e3, M15: 900e3 };

// The feed's forward windows, used only when a piece of evidence has no record
// of its own. Kept in step with HORIZON in vps-bot/src/feed.js.
const FWD_BARS = { D: 10, H4: 20, H1: 24, M30: 30, M15: 40 };

// Daily bars are trading days. Ten of them is two calendar weeks, and the
// difference matters here because the hold window is what the calendar is
// searched over — an event five weekdays out is inside a 10-bar daily hold.
const CALENDAR_STRETCH = { D: 7 / 5 };

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

// MAX_COST_SHARE now lives in confluence.js, because the stop WIDTH has to be
// chosen with it rather than checked against it afterwards. Two copies of the
// same threshold is how they drift apart.

// Below this, a scheduled event is not a disclosure — it is a reason not to be
// in the market yet. Entering an hour before a rate decision means the entry
// price is not the price you will have.
const IMMINENT_MS = 2 * 3600e3;

const round = (v, dec) => v == null ? null : +v.toFixed(dec ?? 5);

const untilText = ms => ms < 3600e3 ? `${Math.round(ms / 60e3)} min`
                      : ms < 36 * 3600e3 ? `${(ms / 3600e3).toFixed(1)}h`
                      : `${Math.round(ms / 86400e3)}d`;

// The piece of evidence the plan is built on. It must speak to the horizon the
// trade will be held for: a swing setup can only be anchored by swing evidence,
// and a piece of context with no timeframe at all cannot anchor anything,
// because there is no ATR to measure a stop against.
function anchorOf(a) {
  const swing = a.kind !== 'intraday';
  const inScope = (e) => {
    const tfs = e.tfs || [];
    if (!tfs.length) return false;
    return swing ? tfs.some(t => SWING_TFS.has(t)) : tfs.every(t => !SWING_TFS.has(t));
  };
  const pool = a.evidence.filter(e => e.dir && inScope(e));
  if (!pool.length) return null;
  // A record is what prices the trade, so evidence carrying one wins; among
  // those, the largest sample.
  const withRecord = pool.filter(e => e.base);
  return (withRecord.length ? withRecord : pool)
    .sort((x, y) => (y.base?.n ?? 0) - (x.base?.n ?? 0))[0];
}

// How long this is expected to be held. Two different numbers, and conflating
// them is what made this screen quote
// "about three days" for a trade that is usually over in four hours.
//
//   ms is the OUTER bound — the full window the record was measured over. The
//   calendar is searched across it, because a release can land anywhere in it.
//
//   typical is the median bars to actually leave, at the stop, at the target or
//   at the end. That is the number somebody deciding whether they can sit
//   through this wants, and until the bot ran the trades it did not exist.
function holdOf(tf, base, measured) {
  const bars = base?.bars ?? FWD_BARS[tf] ?? 10;
  const span = b => {
    const ms = b * (TF_MS[tf] ?? 86400e3) * (CALENDAR_STRETCH[tf] ?? 1);
    const days = ms / 86400e3;
    return { ms, days: +days.toFixed(1),
      text: days >= 10 ? `about ${Math.round(days / 7)} weeks`
          : days >= 1.5 ? `about ${Math.round(days)} days`
          : days >= 0.8 ? 'about a day'
          : days >= 0.04 ? `about ${Math.round(ms / 3600e3)} hours`
          : `about ${Math.round(ms / 60e3)} min` };
  };
  const outer = span(bars);
  const typical = measured?.exitBars ? { bars: measured.exitBars, ...span(measured.exitBars) } : null;
  return { bars, ...outer, typical };
}

// High-impact events scheduled inside the hold window, for the currencies this
// instrument is exposed to.
//
// A swing trade cannot avoid the calendar — over a fortnight there is always an
// NFP — so this does not refuse on the count. It refuses on IMMINENCE, which is
// the part you can actually do something about, and discloses the rest.
function eventsInHold(a, news, now, holdMs) {
  const cal = news?.calendar;
  if (!cal?.length) return null;
  const mine = new Set(a.ccy || []);
  const hits = cal
    .filter(e => e.impact === 'high' && mine.has(e.country) && e.at > now && e.at < now + holdMs)
    .sort((x, y) => x.at - y.at)
    // inMs is kept exact and every display derives from it. Rounding to hours
    // first and converting back turned "in 45 min" into "in 48 min".
    .map(e => ({ title: e.title, country: e.country, at: e.at,
                 inMs: e.at - now, inHrs: +((e.at - now) / 3600e3).toFixed(1) }));
  return { n: hits.length, next: hits[0] || null, list: hits.slice(0, 4) };
}

export function buildPlan(a, rec, {
  balance = 10000, riskPct = 1, stopAtr = DEFAULT_STOP_ATR,
  news = null, now = Date.now(),
} = {}) {
  if (!a || !rec) return null;
  const anchor = anchorOf(a);
  if (!anchor) {
    return { ok: false, reason: a.kind === 'intraday'
      ? 'no directional intraday evidence to build a trade from'
      : 'the swing evidence here has no direction — nothing to price' };
  }

  // The slowest timeframe the anchor appeared on. A signal on H4 and Daily at
  // once is a daily trade that also shows on H4.
  const tf = TF_ORDER.find(t => (anchor.tfs || []).includes(t)) || 'D';
  const st = rec.state?.[tf];
  const price = rec.price;
  if (!st?.atrPct || !price) return { ok: false, reason: `no volatility measurement on ${tf} yet` };

  const atr = price * (st.atrPct / 100);
  const dir = anchor.dir;
  const long = dir === 'up';

  const base = anchor.base;
  const pool = anchor.pool;

  // Which record prices this, settled before the stop is drawn — because where
  // there is a measured record the stop is part of what it measured.
  //
  // Where the instrument's own record cannot decide, the pooled record for the
  // same event across its asset class usually can: two orders of magnitude more
  // samples, at the cost of assuming a sweep on one crypto pair is the same
  // event as a sweep on another.
  const own = base && tellsUsSomething(base) ? base : null;
  const usable = own || (pool && tellsUsSomething(pool) ? pool : null);

  // The grid is read even from a record that is not significant, because the two
  // directions are not symmetric: TAKING a trade needs the record to establish
  // something, REFUSING one does not. A setup that loses money at every stop
  // width tried is a reason to stay out whether or not the loss clears a
  // significance bar, and routing that through "inconclusive" threw away the
  // one thing the measurement was built to tell you.
  const gridRec = usable?.stops ? usable : (base?.stops ? base : (pool?.stops ? pool : null));

  // The stop stops being a setting here. The expectancy below was measured at a
  // specific width, and quoting it beside a stop of some other size describes a
  // trade nobody ran — which is what this screen was doing: a win rate measured
  // with no stop at all, multiplied through a 1.5 ATR stop it never saw. Three
  // widths were run; the one that beat a random entry by most is carried.
  // A grid that was priced out has no affordable width to take a stop from, so
  // it cannot set one. The caller's default stands and the plan refuses below.
  const measured = gridRec?.stops && !gridRec.stops.pricedOut ? gridRec.stops : null;
  const pricedOut = gridRec?.stops?.pricedOut ? gridRec.stops : null;
  const effStopAtr = measured ? measured.stopAtr : stopAtr;
  const stopDist = atr * effStopAtr;
  const stop = long ? price - stopDist : price + stopDist;

  const spreadAbs = rec.state?.spreadAbs ?? null;
  const spreadRatio = rec.state?.spreadRatio ?? null;

  // Cost first: it is the one number that can kill a trade regardless of how
  // good the setup looks, and it is knowable before anything else.
  const costShare = spreadAbs && stopDist > 0 ? spreadAbs / stopDist : null;

  const hold = holdOf(tf, base, measured);
  const events = eventsInHold(a, news, now, hold.ms);

  const plan = {
    ok: true,
    sym: a.sym, dir, tf,
    kind: a.kind || 'swing',
    why: anchor.label,
    // On a timed entry, which fast signal timed it. The trade is still the slow
    // one — this is why now rather than why at all.
    triggeredBy: a.kind === 'trigger' ? (a.trigger?.label || null) : null,
    hold,
    events,
    entry: round(price, rec.dec),
    stop: round(stop, rec.dec),
    stopDist: round(stopDist, rec.dec),
    stopAtr: effStopAtr,
    // Whether that width was chosen by measurement or is still the default, so
    // the card can say which.
    stopFromRecord: !!measured,
    atr: round(atr, rec.dec),
    spreadAbs, spreadRatio,
    costShare: costShare == null ? null : +(costShare * 100).toFixed(1),
    record: base ? { n: base.n, win: base.win, medAtr: base.med, bars: base.bars, ci: base.ci } : null,
    // What the market did over the same window, on every plan rather than only
    // priced ones. A refusal is far easier to trust when the number it was
    // compared against is visible next to it.
    marketWin: base?.baseWin ?? pool?.baseWin ?? null,
    marketMed: base?.baseMed ?? pool?.baseMed ?? null,
    // The same event across the asset class, always shown when it exists, so a
    // thin per-instrument number can be read next to a meaningful one.
    pool: pool ? { n: pool.n, win: pool.win, medAtr: pool.med, syms: pool.syms, ci: pool.ci } : null,
  };

  // ── What the record says ─────────────────────────────────────────────────
  //
  // Rewritten once the arithmetic was actually done. "48% went its way over 33
  // times" carries a margin of error of nine points — the true rate is between
  // 31% and 65% — and the screen was reporting that as THE RECORD SAYS NO on
  // fifteen cards at once. A record whose interval straddles a coin flip is not
  // a finding pointing the other way; it is the absence of one, and saying so
  // is the difference between a tool that is cautious and a tool that is
  // confidently wrong.
  //
  const m = measured;
  const over = m ? +(m.expR - m.baseExpR).toFixed(2) : null;
  const src = gridRec?.pooled ? `across ${gridRec.syms} ${a.cls} instruments` : 'here';
  const at = m ? `a ${m.stopAtr} ATR stop and a ${m.rr}R target` : '';

  if (!base && !pool) {
    plan.verdict = 'unpriced';
    plan.note = 'no measured record for this setup on this instrument — the trade can be drawn but not priced';
  } else if (pricedOut) {
    // Before this, the stop width was chosen on measured edge alone and the
    // spread was checked afterwards against a width picked without it. On
    // EUR/USD M15 that produced a 1.2 pip stop against a 1.6 pip spread — the
    // stop inside the spread — presented as the best setup on the board.
    plan.verdict = 'costly';
    plan.stopped = pricedOut;
    plan.note = `the spread is ${Math.round(pricedOut.cost * 100)}% of the stop even at the widest width `
      + `measured (${pricedOut.cheapestAt} ATR). The setup returns ${pricedOut.expR}R against `
      + `${pricedOut.baseExpR}R for a random entry and the cost of taking it is larger than the edge. `
      + `Not broken — unaffordable here. A slower timeframe or a tighter-spread market is where this lives.`;
  } else if (m && m.bestExpR <= 0) {
    // Refusals come first and do not wait for significance. See gridRec above.
    plan.verdict = 'negative';
    plan.stopped = m;
    plan.ev = m.expR;
    plan.note = `run ${src} as a real trade, this setup lost money at every stop width tried — `
      + `best was ${m.bestExpR}R a trade at ${m.stopAtr} ATR, reaching its target ${m.hit}% of the `
      + `time and its stop ${m.stopped}%. There is no width that makes this one work.`;
  } else if (m && m.expR < MIN_EXP_R) {
    // Positive and too small to collect is the same refusal as negative, and
    // the distinction matters because the comparison can look spectacular
    // while the number does not: +0.03R against a random entry's −0.46R is a
    // short losing less badly than a rising market, not a trade.
    plan.verdict = 'negative';
    plan.stopped = m;
    plan.ev = m.expR;
    plan.note = m.expR <= 0
      ? `with ${at} this returns ${m.expR}R a trade ${src}. It beats a random entry, which returns `
        + `${m.baseExpR}R — but losing less than the market lost is not making money.`
      : `with ${at} this returns ${m.expR}R a trade ${src}, against ${m.baseExpR}R for a random entry. `
        + `The comparison is good and the number is too small to collect — the spread takes it.`;
  } else if (m && over <= 0) {
    // The distinction the baseline exists for. A rising market makes almost any
    // long pay; that is the market, not the signal.
    plan.verdict = 'negative';
    plan.stopped = m;
    plan.ev = m.expR;
    plan.note = `${at} pays ${m.expR}R ${src}, and the same stop on a random bar of this market pays `
      + `${m.baseExpR}R. The setup is not adding anything — that is the market, not the signal.`;
  } else if (!usable) {
    // The honest verdict, and the one that replaced most of the false ones.
    plan.verdict = 'inconclusive';
    const src = base || pool;
    plan.note = src.baseWin != null
      ? `${src.win}% over ${src.n} occurrences against ${src.baseWin}% for the market itself — `
        + `too close to separate, so this record does not say the setup works or that it `
        + `fails. It says we do not know.`
      : `${src.win}% over ${src.n} occurrences is ±${src.ci} points — `
        + `the range covers a coin flip, so this record does not say the setup works `
        + `or that it fails. It says we do not know.`;
  } else if (usable.n < MIN_RECORD) {
    plan.verdict = 'thin';
    plan.note = `only ${usable.n} prior occurrences — too few to price a target from`;
  } else if (measured) {
    // ── Priced from the trade, not from the horizon ──────────────────────────
    //
    // Nothing is inferred here. The target is RR times the stop because that is
    // the target the measurement used, and the expectancy is what those trades
    // actually returned — stops taken at −1R, targets at +2R, anything still
    // open at the end of the window marked to market. The old arithmetic took a
    // win rate measured with no stop and multiplied it through a stop, which
    // overstates every setup that has to survive an excursion to get paid.
    Object.assign(plan, {
      target: round(long ? price + m.rr * stopDist : price - m.rr * stopDist, rec.dec),
      rr: m.rr,
      ev: m.expR,
      evOverMarket: over,
      stopped: m,
      pricedFrom: gridRec.pooled ? `${gridRec.syms} ${a.cls} instruments` : 'this instrument',
      marketWin: usable.baseWin ?? null,
    });
    plan.verdict = 'priced';
    plan.note = `the last ${gridRec.n} times this fired ${src}, taken with ${at}, it reached target `
      + `${m.hit}% of the time against ${m.baseHit}% for a random entry — ${m.expR}R a trade `
      + `against ${m.baseExpR}R. Usually over in ${hold.typical?.text || `${m.exitBars} bars`}.`;
    if (over < 0.1) {
      plan.fragile = `only ${over}R a trade better than a random entry with the same stop — real, and thin`;
    }
  } else if (usable.med <= (usable.baseMed ?? 0)) {
    // The important case, and the one no other tool will tell you — now stated
    // only when the record is significant AND the comparison is against what
    // the market itself did, not against a coin flip. A bearish setup winning
    // 37% on an instrument that rose 65% of the time has beaten its benchmark,
    // and calling that "has not worked" was wrong on every bearish card.
    plan.verdict = 'record-says-no';
    const vs = usable.baseWin != null
      ? `${usable.win}% against ${usable.baseWin}% for the market over the same window`
      : `${usable.win}% ±${usable.ci} went its way`;
    plan.note = `the last ${usable.n} times this fired${usable.pooled ? ` across ${usable.syms} ${a.cls} instruments` : ' here'}, `
      + `the median outcome was ${usable.med} ATR`
      + (usable.baseMed != null ? ` against the market's ${usable.baseMed}` : '')
      + `. ${vs}. This setup has not worked.`;
  } else {
    // The move the SETUP adds, not the move the market was making anyway. A
    // target drawn from a raw median on a drifting instrument is mostly the
    // drift, and would be there whether or not the signal fired.
    const edgeMed = usable.baseMed != null ? usable.med - usable.baseMed : usable.med;
    const target = long ? price + edgeMed * atr : price - edgeMed * atr;
    const rr = (edgeMed * atr) / stopDist;
    const win = usable.win / 100;
    // Expectancy in R from a measured win rate, not an assumed one. Losers are
    // taken at 1R by construction.
    const ev = win * rr - (1 - win);
    // And the same sum at the pessimistic end of the record's own interval.
    // A trade that only pays at the point estimate is not one the record
    // supports — it is one the record permits, which is a weaker claim and was
    // being presented as the stronger one.
    const winLow = Math.max(0, usable.win - (usable.ci ?? 0)) / 100;
    const evLow = winLow * rr - (1 - winLow);
    Object.assign(plan, {
      target: round(target, rec.dec),
      rr: +rr.toFixed(2),
      ev: +ev.toFixed(2),
      evLow: +evLow.toFixed(2),
      pricedFrom: usable.pooled ? `${usable.syms} ${a.cls} instruments` : 'this instrument',
      marketWin: usable.baseWin ?? null,
      edgeMed: +edgeMed.toFixed(2),
    });
    // Significance was already required to get here — the record's interval had
    // to exclude a coin flip. Demanding that the pessimistic end ALSO pay is
    // the same caution charged twice, and on a live board it refused every
    // trade there was. So the point estimate decides, and the weak end is
    // disclosed rather than enforced.
    plan.verdict = ev <= 0 ? 'negative' : 'priced';
    if (ev <= 0) {
      plan.note = `${usable.win}% at ${rr.toFixed(2)}R is ${ev.toFixed(2)}R per trade — `
        + `the historical record does not pay for the risk`;
    } else if (evLow <= 0) {
      // Worth taking and worth knowing it is not comfortable.
      plan.fragile = `pays ${ev.toFixed(2)}R at the measured rate but ${evLow.toFixed(2)}R at the `
        + `weak end of the record — the edge is real but thin`;
    }
  }

  // ── Conditions that override a good setup ────────────────────────────────
  // An imminent release first: it is the only one where waiting a few hours
  // costs nothing and entering now can cost the whole stop in one print.
  if (events?.next && events.next.inMs < IMMINENT_MS) {
    const n = events.next;
    plan.blocked = `${n.country} ${n.title} in ${untilText(n.inMs)}`
      + ` — the entry price will not survive it. Let it print first.`;
  } else if (spreadRatio != null && spreadRatio > MAX_SPREAD_RATIO) {
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

// What the calendar holds over the life of the trade. Disclosure, not a
// verdict: a fortnight-long hold cannot dodge the calendar, and pretending
// otherwise would refuse every swing trade there is. What it can do is tell you
// what you are agreeing to sit through.
export function eventLine(plan) {
  const ev = plan?.events;
  if (!ev?.n) return '';
  const n = ev.next;
  const when = untilText(n.inMs);
  return ev.n === 1
    ? `1 high-impact release inside the hold — ${n.country} ${n.title} in ${when}`
    : `${ev.n} high-impact releases inside the hold — next is ${n.country} ${n.title} in ${when}`;
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

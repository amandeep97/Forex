'use strict';
// vps-bot/src/exposure.js
// Never long and short the same thing at once.
//
// ── Why this is not already covered ─────────────────────────────────────────
//
// Two things on this box can place an order, and each was guarding its own
// work only.
//
// The strategy engine counts positions per pair like this:
//
//     openTrades.filter(t => t.instrument === pair && stratOandaIds.has(t.id))
//
// — ANDed with the ids that strategy opened. A silver long placed by the desk
// is not in that set, so it counts as zero, and a short strategy on silver
// would happily open against it. Two different strategies on the same pair do
// the same to each other.
//
// The desk refuses any silver proposal while silver is open at all, which is
// stricter, but it only defends the desk's own door. Nothing stopped the
// engine walking through the other one.
//
// So the rule lives here, once, and both ask it.
//
// ── What a conflict is ──────────────────────────────────────────────────────
//
// Any exposure the other way. Open trades AND resting orders, because an order
// resting at a level is a position you have already decided to take: if a
// desk long limit is sitting on yesterday's low and a strategy opens a short,
// nothing is wrong until the limit fills, and then you are hedged without ever
// having chosen to be.
//
// Same-direction adding is NOT blocked here. That is what the per-pair and
// global position limits are for, and conflating the two questions would mean
// a change to one silently moved the other.
//
// ── On netting accounts this is still worth having ──────────────────────────
//
// A netting account would reduce the long rather than open a short, so the
// account cannot be hedged — but the trade is not the one anyone intended
// either. A short signal is not an instruction to close a long at market, and
// a strategy that thinks it opened a position when it actually closed someone
// else's is a worse state than being refused.

/** Long or short, from whichever field the venue used. */
function sideOf(x) {
  const u = Number(x?.currentUnits ?? x?.units ?? 0);
  if (!Number.isFinite(u) || u === 0) return null;
  return u > 0 ? 'long' : 'short';
}

/** Normalise the many ways this codebase spells a direction. */
function wanted(dir) {
  const d = String(dir || '').toLowerCase();
  if (d === 'long' || d === 'buy' || d === 'up') return 'long';
  if (d === 'short' || d === 'sell' || d === 'down') return 'short';
  return null;
}

/**
 * Is there exposure the other way on this instrument?
 *
 * @param {object} arg
 * @param {any[]} arg.trades  open trades from the venue
 * @param {any[]} arg.orders  resting orders from the venue
 * @param {string} arg.instrument  venue symbol, e.g. XAG_USD
 * @param {string} arg.dir  the direction about to be taken
 * @returns {null|{ why:string, side:'long'|'short', from:'position'|'order' }}
 */
function directionConflict({ trades = [], orders = [], instrument, dir }) {
  const want = wanted(dir);
  if (!want || !instrument) return null;
  const opposite = want === 'long' ? 'short' : 'long';

  for (const t of trades || []) {
    if (t?.instrument !== instrument) continue;
    if (sideOf(t) === opposite) {
      return { why: `${instrument} is already ${opposite} — refusing to open the other side`,
        side: opposite, from: 'position' };
    }
  }
  for (const o of orders || []) {
    if (o?.instrument !== instrument) continue;
    if (sideOf(o) === opposite) {
      return { why: `a ${opposite} order is already resting on ${instrument} — refusing to open the other side`,
        side: opposite, from: 'order' };
    }
  }
  return null;
}

/**
 * Ask the venue, then answer.
 *
 * Asked at the moment of placing rather than once a tick, because the gap
 * between the two is exactly where the other engine places its order. Two
 * requests on a path that runs a handful of times a day is not a cost worth
 * optimising against a hedged book.
 *
 * A failure to ASK is a failure. It used to be possible to treat an unreachable
 * venue as "nothing is open", which is the most dangerous reading available:
 * the one case where the check cannot see the account is the case it answers
 * "go ahead".
 */
async function conflictAtVenue(oanda, { instrument, dir }) {
  const [trades, orders] = await Promise.all([
    oanda.getOpenTrades(),
    oanda.getPendingOrders(),
  ]);
  return directionConflict({ trades, orders, instrument, dir });
}

module.exports = { directionConflict, conflictAtVenue, sideOf, wanted };

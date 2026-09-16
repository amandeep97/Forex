'use strict';
// Never long and short the same thing at once — vps-bot/src/exposure.js.
//
// Two things on this box place orders and each guarded only its own work. The
// strategy engine counts positions per pair ANDed with the ids that strategy
// opened, so a silver long placed by the desk counts as zero and a short
// strategy on silver would open against it. The desk refused any silver while
// silver was open, which is stricter, but only defended its own door.
const { directionConflict, conflictAtVenue, sideOf, wanted } =
  require('../vps-bot/src/exposure');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const XAG = 'XAG_USD';
const long = (instrument = XAG) => ({ instrument, currentUnits: '6' });
const short = (instrument = XAG) => ({ instrument, currentUnits: '-6' });
const longOrder = (instrument = XAG) => ({ instrument, units: '6' });
const shortOrder = (instrument = XAG) => ({ instrument, units: '-6' });

// ── Direction, from whichever field the venue used ─────────────────────────
{
  check('a positive size is long, a negative one is short',
    sideOf({ currentUnits: '6' }) === 'long' && sideOf({ currentUnits: '-6' }) === 'short');
  check('an order reports its size in `units`, not `currentUnits`',
    sideOf({ units: '-6' }) === 'short' && sideOf({ units: '6' }) === 'long',
    '', 'reading only one of the two fields would make every resting order invisible');
  check('a flat or unreadable size is neither',
    sideOf({ currentUnits: '0' }) === null && sideOf({}) === null && sideOf(null) === null);

  check('the three spellings of a direction in this codebase all resolve',
    wanted('long') === 'long' && wanted('buy') === 'long' && wanted('up') === 'long'
    && wanted('short') === 'short' && wanted('sell') === 'short' && wanted('down') === 'short',
    '', 'the desk says long/short, the study says up/down — one of them would have gone unchecked');
  check('and anything else is refused rather than guessed',
    wanted('') === null && wanted(undefined) === null && wanted('sideways') === null);
}

// ── The rule ───────────────────────────────────────────────────────────────
{
  check('a long is refused while a short is open',
    !!directionConflict({ trades: [short()], orders: [], instrument: XAG, dir: 'long' }));
  check('and a short is refused while a long is open',
    !!directionConflict({ trades: [long()], orders: [], instrument: XAG, dir: 'short' }));

  check('a RESTING ORDER the other way counts too',
    !!directionConflict({ trades: [], orders: [shortOrder()], instrument: XAG, dir: 'long' }),
    '', 'an order at a level is a position you have already decided to take');

  check('the same direction is allowed — that is a position limit, not this rule',
    directionConflict({ trades: [long()], orders: [longOrder()], instrument: XAG, dir: 'long' }) === null,
    '', 'conflating the two would mean changing one silently moved the other');

  check('a different instrument is not a conflict',
    directionConflict({ trades: [short('XAU_USD')], orders: [], instrument: XAG, dir: 'long' }) === null,
    '', 'gold and silver are related, not the same book');

  check('an empty account is clear',
    directionConflict({ trades: [], orders: [], instrument: XAG, dir: 'long' }) === null);

  check('a flat trade is not exposure',
    directionConflict({ trades: [{ instrument: XAG, currentUnits: '0' }], orders: [],
      instrument: XAG, dir: 'long' }) === null);

  // The scenario in the report: the desk holds silver long, a strategy fires short.
  {
    const c = directionConflict({
      trades: [long()], orders: [], instrument: XAG, dir: 'sell',
    });
    check('the desk long blocks the strategy short, which is the case this exists for',
      !!c && c.side === 'long' && c.from === 'position',
      c?.why);
  }
  // And the reverse: a strategy is short, the desk wants to buy the level.
  {
    const c = directionConflict({
      trades: [], orders: [shortOrder()], instrument: XAG, dir: 'long',
    });
    check('a resting short blocks the desk long',
      !!c && c.from === 'order', c?.why);
  }

  check('a missing direction is refused rather than treated as clear',
    directionConflict({ trades: [short()], orders: [], instrument: XAG, dir: null }) === null
    && directionConflict({ trades: [short()], orders: [], instrument: null, dir: 'long' }) === null,
    '', 'nothing is placed without a direction, so returning null here cannot let one through');
}

// ── Asking the venue, and what happens when it cannot be asked ─────────────
(async () => {
  {
    const oanda = {
      async getOpenTrades() { return [long()]; },
      async getPendingOrders() { return []; },
    };
    const c = await conflictAtVenue(oanda, { instrument: XAG, dir: 'short' });
    check('asking the venue finds the conflict', !!c, c?.why);

    const clear = await conflictAtVenue(oanda, { instrument: XAG, dir: 'long' });
    check('and clears the same-direction case', clear === null);
  }

  // The important one. An unreachable venue must not read as an empty account.
  {
    const broken = {
      async getOpenTrades() { throw new Error('ECONNRESET'); },
      async getPendingOrders() { return []; },
    };
    let threw = false;
    try { await conflictAtVenue(broken, { instrument: XAG, dir: 'long' }); }
    catch { threw = true; }
    check('a venue that cannot be read throws rather than reporting "clear"',
      threw, '',
      'the one case the check cannot see the book is the worst case to answer "go ahead" to');
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

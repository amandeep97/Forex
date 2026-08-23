// The screen has been pricing trades from a number measured without a stop.
//
// "65% of the time price was higher ten bars later" was multiplied through a
// 1.5 ATR stop the measurement never saw, and the product was printed as
// expectancy. Those are different trades. A setup can be right about direction
// ten bars out and lose every time with a stop on it, because getting there
// means sitting through an excursion the stop does not survive — and that is
// precisely the case somebody who will not hold a loser for days needs told
// apart from the good one.
//
// The bot now runs each setup as an actual trade at three stop widths. These
// check that the app prices from those runs and not from the horizon.
import { buildPlan } from '../src/utils/tradePlan.js';
import { assess, chooseStop, stopsFor, verdictOf, tellsUsSomething, pooledRecords, stopCosts }
  from '../src/utils/confluence.js';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const NOW = 1786500000000;

// Grid rows are [target %, stop %, expectancy x100, median bars to exit], in
// the order of STOPS = [0.5, 1, 1.5]. Same layout the bot publishes.
const G = (...rows) => rows;

const rec = (rarity, baseline) => ({
  cls: 'fx', name: 'X', price: 100, dec: 2,
  state: { D: { atrPct: 2, volPct: 50, rangePos: 50 }, spreadAbs: 0.05, spreadRatio: 1 },
  events: [{ type: 'sweep', dir: 'up', at: NOW, tf: 'D', detail: 'swept the 5-bar low' }],
  rarity: { 'sweep.D': { perMonth: 0.7, n: 14, fwdBars: 10, ...rarity } },
  baseline: { D: { bars: 10, n: 380, win: 52, medAtr: 0.05, ...baseline } },
  patterns: {}, asOf: { D: NOW },
});

// ── Choosing the width ───────────────────────────────────────────────────────
// The instrument drifts up, so the widest stop has the highest raw expectancy —
// it is the row most like simply being long. Picking on raw expectancy would
// hand the market's drift back as the setup's edge for the third time in this
// project's history. The edge OVER a random entry at the same width is at 0.5.
{
  const setup = G([50, 40, 40, 3], [45, 40, 35, 7], [40, 35, 60, 9]);
  const market = G([40, 45, 5, 4], [42, 44, 20, 8], [44, 40, 55, 9]);
  const c = chooseStop(setup, market);
  check('the width is chosen by the edge over the market, not by raw expectancy',
    c.stopAtr === 0.5, `${c.stopAtr}, raw best was 1.5 at ${1.5}`);
  check('and both sides of the comparison are carried',
    c.expR === 0.4 && c.baseExpR === 0.05, JSON.stringify([c.expR, c.baseExpR]));
  check('with the median bars to leave the trade', c.exitBars === 3, String(c.exitBars));
  check('and how many widths were tried, so the interval can be widened',
    c.tried === 3, String(c.tried));
}

check('no grid means no opinion, not a default one',
  chooseStop(null, G([1, 2, 3, 4])) === null && chooseStop(G([1, 2, 3, 4]), null) === null);

// ── The spread decides the width ─────────────────────────────────────────────
// This chose purely on measured edge, and on a fast timeframe that means it
// always chose the tightest stop: a 0.5 ATR stop with a 2R target has the
// biggest winners in a frictionless simulation. On EUR/USD M15 a 0.5 ATR stop
// is 1.2 pips and the spread is 1.6 — the stop sits INSIDE the spread. The
// board's best setup, +0.71R over 153 occurrences and resolved in half an hour,
// could not be taken by anybody. The cost check existed and ran per card, after
// the width had been chosen and after the panel had called the setup working.
{
  const setup  = G([50, 40, 60, 3], [45, 42, 40, 7], [40, 45, 20, 9]);
  const market = G([40, 45, 5, 4], [42, 44, 5, 8], [44, 43, 5, 9]);

  const free = chooseStop(setup, market, null);
  check('with no spread known the tightest, best-scoring width still wins',
    free.stopAtr === 0.5 && free.costKnown === false, `${free.stopAtr} ATR`);

  // Tight is unaffordable, wide is fine. The best edge is at 0.5 and the best
  // TRADE is at 1.5.
  const dear = chooseStop(setup, market, [0.42, 0.21, 0.08]);
  check('an affordable width is chosen over a better-scoring unaffordable one',
    dear.stopAtr === 1.5, `${dear.stopAtr} ATR at ${Math.round(dear.cost * 100)}% cost`);
  check('and the cost it was chosen at travels with it',
    dear.costKnown === true && dear.cost === 0.08, JSON.stringify([dear.costKnown, dear.cost]));

  // The live EUR/USD M15 case: every width is eaten.
  const none = chooseStop(setup, market, [4.23, 2.11, 1.41]);
  check('when no width is affordable that is the answer, not the least-bad width',
    none.pricedOut === true, JSON.stringify(none.stopAtr));
  check('and it reports the cheapest width and what it would still cost',
    none.cheapestAt === 1.5 && none.cost === 1.41, `${none.cheapestAt} ATR at ${none.cost}`);
  check('while still carrying what the setup would have returned, because '
      + 'unaffordable and broken are different findings',
    none.expR === 0.6 && none.baseExpR === 0.05, JSON.stringify([none.expR, none.baseExpR]));
}

// stopCosts reads the instrument, and refuses to guess.
{
  // EUR/USD as published: price 1.158, M15 ATR 0.02% of price, spread 1.6 pips.
  const eur = { price: 1.158, state: { M15: { atrPct: 0.02 }, spreadAbs: 0.00016 } };
  const c = stopCosts(eur, 'M15');
  check('a 0.5 ATR stop on EUR/USD M15 is smaller than the spread', c[0] > 1,
    `spread is ${Math.round(c[0] * 100)}% of the stop`);
  check('and even the widest width measured does not clear the limit', c[2] > 0.10,
    `${Math.round(c[2] * 100)}% at 1.5 ATR`);
  // The same instrument on Daily, where the ATR is two orders larger.
  const daily = { price: 1.158, state: { D: { atrPct: 0.465 }, spreadAbs: 0.00016 } };
  check('the same spread on Daily is affordable', stopCosts(daily, 'D')[2] <= 0.10,
    `${Math.round(stopCosts(daily, 'D')[2] * 100)}% at 1.5 ATR`);
  check('an instrument with no spread published costs unknown, not zero',
    stopCosts({ price: 100, state: { M15: { atrPct: 1 } } }, 'M15') === null,
    '32 of 72 instruments are in this state and treating them as free is how '
    + 'an untradeable setup became the best on the board');
}

// ── The mixed-direction blend ────────────────────────────────────────────────
// A sweep record is a mix of ups and downs. Its benchmark is the blend of the
// two baseline grids, not the mirror of whichever direction is firing now.
{
  // The half-ATR row wins the edge comparison against all three benchmarks, so
  // the only thing varying between the three checks is which benchmark was used.
  const r = { fwdN: 200, fwdWin: 60, fwdMedAtr: 1.2, fwdBars: 10, upShare: 0.5,
              st: G([50, 40, 80, 3], [45, 45, 0, 8], [40, 40, -50, 9]) };
  const b = { bars: 10, n: 380, win: 52, medAtr: 0.05,
              stUp: G([60, 30, 60, 3], [50, 40, 20, 8], [40, 40, 0, 9]),
              stDn: G([20, 70, -40, 3], [30, 60, -20, 8], [40, 40, 0, 9]) };
  const out = stopsFor(r, { baseline: { D: b } }, 'D', 'up');
  check('an even split blends the two baseline grids to the middle',
    out.stops.baseExpR === 0.1, String(out.stops.baseExpR));
  const allUp = stopsFor({ ...r, upShare: 1 }, { baseline: { D: b } }, 'D', 'up');
  check('an all-up population is judged against the up grid alone',
    allUp.stops.baseExpR === 0.6, String(allUp.stops.baseExpR));
  const allDn = stopsFor({ ...r, upShare: 0 }, { baseline: { D: b } }, 'D', 'down');
  check('and an all-down one against the down grid',
    allDn.stops.baseExpR === -0.4, String(allDn.stops.baseExpR));
}

// ── The case this exists for ─────────────────────────────────────────────────
// Identical horizon numbers. One survives a stop, one does not. The old code
// gave them the same verdict, the same target and the same expectancy.
const HORIZON = { fwdN: 200, fwdWin: 65, fwdMedAtr: 1.8, fwdBars: 10, upShare: 1 };
const MARKET = { stUp: G([30, 55, -20, 4], [32, 52, -12, 8], [34, 50, -8, 10]),
                 stDn: G([28, 57, -25, 4], [30, 54, -18, 8], [32, 52, -12, 10]),
                 tp: [51, 51, 52, 52] };

{
  // Reaches target more than half the time at a half-ATR stop, and quickly.
  const survives = rec({ ...HORIZON, st: G([48, 40, 44, 3], [44, 44, 32, 7], [40, 46, 12, 9]),
                                     tp: [61, 63, 60, 55] }, MARKET);
  const p = buildPlan(assess('S', survives, { now: NOW }), survives, { balance: 10000, riskPct: 1 });
  check('a setup that survives a stop is priced', p.verdict === 'priced', p.verdict);
  check('the stop is the measured width, not the caller default',
    p.stopAtr === 0.5 && p.stop === 99, `${p.stopAtr} ATR, stop ${p.stop}`);
  check('and the card can say the width came from the record', p.stopFromRecord === true);
  check('the target is the ratio the measurement used', p.rr === 2 && p.target === 102,
    `${p.rr}R, target ${p.target}`);
  check('expectancy is what those trades returned, not a product of a horizon rate',
    p.ev === 0.44, String(p.ev));
  check('and it is stated against a random entry with the same stop',
    p.evOverMarket === 0.64, String(p.evOverMarket));
  check('the note says how often it reached target and how often it was stopped',
    /48% of the time against 30%/.test(p.note) && /0.44R a trade against -0.2R/.test(p.note), p.note);
  check('a size is offered', p.units > 0);

  // Same horizon record. The move only arrives after a full ATR against you.
  const shaken = rec({ ...HORIZON, st: G([12, 80, -44, 2], [20, 70, -30, 5], [30, 55, -10, 9]),
                                   tp: [40, 42, 45, 48] }, MARKET);
  const q = buildPlan(assess('K', shaken, { now: NOW }), shaken);
  check('the same horizon record is refused when a stop cannot survive it',
    q.verdict === 'negative', q.verdict);
  check('no target is drawn on it', q.target === undefined);
  check('no size is offered', q.units === undefined);
  check('and it says which width was the least bad and what it cost',
    /-0.1R a trade at 1.5 ATR/.test(q.note), q.note);
  // Refusing does not wait for significance. The least-bad width here is 30%
  // against the market's 34% over 200 — nowhere near separable — and routing
  // that through "we do not know" would throw away the finding that every
  // width tried loses money, which is the whole point of running them.
  check('a losing grid refuses without needing to clear a significance bar',
    /every stop width tried/.test(q.note), q.note);
  check('the two are indistinguishable on the number the screen used to price from',
    survives.rarity['sweep.D'].fwdWin === shaken.rarity['sweep.D'].fwdWin,
    'both 65% over 200, both median 1.8 ATR');
}

// ── Profitable, and no better than showing up at random ──────────────────────
// The distinction the baseline exists for. A rising market makes almost any
// long pay; that is the market, not the signal.
{
  const drift = rec({ ...HORIZON, st: G([40, 45, 10, 4], [42, 43, 16, 8], [44, 42, 20, 10]) },
                    { stUp: G([42, 44, 14, 4], [44, 42, 20, 8], [46, 40, 26, 10]),
                      stDn: G([30, 56, -26, 4], [32, 54, -20, 8], [34, 52, -14, 10]) });
  const p = buildPlan(assess('D', drift, { now: NOW }), drift);
  check('a setup that pays less than a random entry is refused even though it pays',
    p.verdict === 'negative' && p.ev > 0, `${p.verdict}, ${p.ev}R`);
  check('and the note says so in as many words',
    /that is the market, not the signal/.test(p.note), p.note);
}

// ── How long you are actually in it ──────────────────────────────────────────
// The hold estimate has been quoting the full measurement window. A ten-bar
// daily window is a fortnight; the median trade is over in three days.
{
  const fast = rec({ ...HORIZON, st: G([48, 40, 44, 2], [44, 44, 32, 7], [40, 46, 12, 9]) }, MARKET);
  const p = buildPlan(assess('F', fast, { now: NOW }), fast);
  check('the outer window is still the full measurement window, because a release '
      + 'can land anywhere in it', p.hold.bars === 10 && /weeks/.test(p.hold.text), p.hold.text);
  check('and the typical hold is the median time to actually leave',
    p.hold.typical?.bars === 2 && /days/.test(p.hold.typical.text),
    JSON.stringify(p.hold.typical));
  check('which the note quotes, since that is the question being asked',
    /Usually over in about 3 days/.test(p.note), p.note);
}

// ── An older feed keeps working ──────────────────────────────────────────────
{
  const old = rec({ ...HORIZON }, {});   // no stop grid anywhere
  const p = buildPlan(assess('O', old, { now: NOW }), old);
  check('a feed with no grid prices exactly as before',
    p.verdict === 'priced' && p.stopAtr === 1.5 && p.stopFromRecord === false,
    `${p.verdict}, ${p.stopAtr} ATR`);
  check('and the target still comes from the median, not from a ratio',
    p.rr !== 2 && p.target > 100, `${p.rr}R`);
}

// ── The panel asks the same question ─────────────────────────────────────────
// Otherwise WHAT ACTUALLY WORKS and the card it links to disagree.
{
  const works = { n: 200, baseN: 380, win: 65, baseWin: 52, med: 1.8, edgeMed: 1.2,
                  stops: { stopAtr: 0.5, rr: 2, hit: 48, stopped: 40, expR: 0.44,
                           baseExpR: -0.2, baseHit: 30, exitBars: 3, baseExitBars: 4, tried: 3,
                           costKnown: true, cost: 0.04 } };
  check('a setup that pays with a stop it can afford is reported as working',
    verdictOf(works) === 'works', verdictOf(works));
  // Two states that used to be reported as working and are not the same claim.
  const noSpread = { ...works, stops: { ...works.stops, costKnown: false, cost: null } };
  check('one on an instrument that publishes no spread is uncosted, not working',
    verdictOf(noSpread) === 'uncosted', verdictOf(noSpread));
  const tooDear = { ...works, stops: { ...works.stops, pricedOut: true, cost: 4.23, cheapestAt: 1.5 } };
  check('one whose spread is larger than its stop is costly, not working',
    verdictOf(tooDear) === 'costly', verdictOf(tooDear));
  const paid = { ...works, stops: { ...works.stops, expR: -0.1 } };
  check('one that clears significance and does not pay is not called working',
    verdictOf(paid) === 'tiny', verdictOf(paid));
  const beaten = { ...works, stops: { ...works.stops, hit: 18, expR: -0.46 } };
  check('one significantly worse than a random entry is reported as failing',
    verdictOf(beaten) === 'fails', verdictOf(beaten));
  const noise = { ...works, n: 12, stops: { ...works.stops, hit: 40 } };
  check('twelve occurrences say nothing at all', verdictOf(noise) === 'silent', verdictOf(noise));
  check('and the same precedence governs whether a record is usable',
    tellsUsSomething(works) === true && tellsUsSomething(noise) === false);
}

// ── Pooling ──────────────────────────────────────────────────────────────────
// Per instrument a grid is fifteen occurrences. Across the class it is
// thousands, and that is the only version with enough behind it to act on.
{
  const mk = (fwdN, st) => ({
    cls: 'fx', price: 100,
    rarity: { 'sweep.D': { fwdN, fwdWin: 60, fwdMedAtr: 1, fwdBars: 10, upShare: 1, st, tp: [60, 60, 60, 60] } },
    baseline: { D: { bars: 10, n: 100, win: 50, medAtr: 0,
                     stUp: G([30, 50, -10, 4], [30, 50, -10, 8], [30, 50, -10, 10]),
                     stDn: G([30, 50, -10, 4], [30, 50, -10, 8], [30, 50, -10, 10]),
                     tp: [50, 50, 50, 50] } },
  });
  const feed = { instruments: {
    A: mk(100, G([50, 40, 40, 3], [40, 45, 15, 8], [35, 48, 0, 10])),
    B: mk(100, G([40, 45, 20, 5], [40, 45, 15, 8], [35, 48, 0, 10])),
    C: mk(200, G([45, 42, 30, 4], [40, 45, 15, 8], [35, 48, 0, 10])),
  } };
  const pools = pooledRecords(feed);
  const p = pools['fx|sweep.D'];
  check('the pool carries a stop grid', !!p?.stops, JSON.stringify(p?.stops));
  check('weighted by occurrences, so the instrument with twice the sample counts twice',
    p.stops.expR === +((0.4 * 100 + 0.2 * 100 + 0.3 * 200) / 400).toFixed(2),
    `${p.stops.expR} vs ${(0.4 * 100 + 0.2 * 100 + 0.3 * 200) / 400}`);
  check('and the sample is the sum, not one instrument', p.n === 400, String(p.n));
  check('the pooled baseline is pooled too', p.stops.baseExpR === -0.1, String(p.stops.baseExpR));
  check('and the time profile comes across', p.profile?.length === 4 &&
    p.profile[0].win === 60 && p.profile[0].base === 50, JSON.stringify(p.profile?.[0]));

  // An older instrument with no grid must not drag the pool's grid toward zero.
  const mixed = { instruments: { ...feed.instruments,
    D: (() => { const r = mk(400, undefined); delete r.rarity['sweep.D'].st; return r; })() } };
  const pm = pooledRecords(mixed)['fx|sweep.D'];
  check('an instrument with no grid adds to the sample and not to the grid',
    pm.n === 800 && pm.stops.expR === p.stops.expR,
    `n ${pm.n}, expR ${pm.stops.expR}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

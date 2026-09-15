// runBracket — a resting limit with a stop and a target, in shared/exits.mjs.
//
// This is the trade the bot alerts on, and it is the one runTrade cannot
// express: it might not fill, it can die before it fills, and it has to wait for
// price to leave the level before a touch counts as a fill. Each of those is a
// way the replay could quietly measure a better trade than the one on offer.

import { runBracket } from '../shared/exits.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// A bar builder where h/l are explicit, because every rule here is about which
// of the two gets touched first.
const b = (o, c, h, l) => ({ t: 0, o, c, h: h ?? Math.max(o, c), l: l ?? Math.min(o, c), v: 1 });

// A long plan: level (entry) 100, stop 98, target 106. Risk 2, reward 6 = 3R.
const LONG = { entry: 100, stop: 98, target: 106, dir: 'up' };

{
  // Sweep down to 99, close back above 100 (the reclaim), drift up, come back
  // and touch 100 (the fill), then run to the target.
  const cs = [
    b(100, 99, 100.2, 98.6),   // 0 — the sweep bar, order placed here
    b(99, 100.5),              // 1 — closes above the level: reclaimed
    b(100.5, 101.5),           // 2
    b(101.5, 101, 101.6, 99.9),// 3 — low 99.9 touches the limit: filled
    b(101, 104),               // 4
    b(104, 106.5, 106.5, 104), // 5 — target
  ];
  const r = runBracket(cs, 0, LONG);
  check('a plan that reclaims, retests and runs is filled and pays its target',
    r.filled && r.how === 'target' && r.at === 3 && r.r === 3,
    `${r.why} at ${r.at}, ${r.r}R via ${r.how}`);
}

{
  // The single most important rule. On the sweep bar price is already AT the
  // level, so an order resting there fills instantly and the entry price means
  // nothing. tradePlan requires a close back the trade's side first.
  const cs = [
    b(100, 99, 100.2, 98.6),    // sweep bar: low is already through 100
    b(99, 99.2, 99.5, 98.9),    // still below — no reclaim
    b(99.2, 99.4, 99.6, 99.1),
    b(99.4, 99.5, 99.8, 99.2),
  ];
  const r = runBracket(cs, 0, LONG);
  check('price sitting at the level does not fill until it has left and come back',
    !r.filled && r.why === 'never reclaimed',
    `${r.why}`,
    'without this every plan fills on its own sweep bar at a meaningless price');
}

{
  // The reclaim bar itself must not also be the fill bar. A bar that closes
  // above the level almost always has a low below it, so counting the same bar
  // twice would fill essentially every plan on the reclaim.
  const cs = [
    b(100, 99, 100.2, 98.6),
    b(99, 100.5, 100.6, 99.0),  // closes above AND has a low under 100
    b(100.5, 101, 101.2, 100.4),
    b(101, 100.9, 101.1, 100.6),
  ];
  const r = runBracket(cs, 0, LONG);
  check('the bar that reclaims cannot also be the bar that fills',
    !r.filled, `${r.why}`,
    'a reclaim bar nearly always dips back through the level on its way up');
}

{
  // Price keeps going and closes beyond where the stop would be. The setup is
  // gone; the order must be cancelled, not left resting to be filled hours later
  // on a move with nothing to do with the sweep.
  const cs = [
    b(100, 99, 100.2, 98.6),
    b(99, 97.5, 99.1, 97.4),   // closes below the stop at 98
    b(97.5, 99),
    b(99, 100.5),
    b(100.5, 100, 100.8, 99.5),// would have filled, long after the plan died
    b(100, 106.5, 106.6, 100),
  ];
  const r = runBracket(cs, 0, LONG);
  check('a close beyond the stop kills the order before it can fill',
    !r.filled && r.why === 'invalidated',
    `${r.why}`,
    'otherwise the replay buys every level that failed, at the price it failed at');
}

{
  // Reclaimed, but price never comes back to the level within the window.
  const cs = [b(100, 99, 100.2, 98.6), b(99, 101), ...Array.from({ length: 8 }, () => b(101, 102, 102.2, 100.8))];
  const r = runBracket(cs, 0, { ...LONG, waitBars: 5 });
  check('a plan that reclaims and never retests is not a trade, and is not a loss',
    !r.filled && r.why === 'never came back' && r.r === null,
    `${r.why}, r=${r.r}`,
    'counting it as flat would dilute every average with orders nobody held');
}

{
  // Stop and target inside one bar. OHLC cannot say which came first, and
  // assuming the target is the single easiest way to manufacture an edge.
  const cs = [
    b(100, 99, 100.2, 98.6),
    b(99, 100.5),
    b(100.5, 100.2, 100.7, 99.9),   // fill
    b(100.2, 103, 106.5, 97.5),     // touches BOTH 98 and 106
  ];
  const r = runBracket(cs, 0, LONG);
  check('stop and target in the same bar is taken as the stop',
    r.filled && r.how === 'stop' && r.r === -1,
    `${r.how} ${r.r}R`);
}

{
  // A short is the same machine with every comparison inverted, which is
  // exactly the sort of thing that gets half-mirrored.
  const SHORT = { entry: 100, stop: 102, target: 94, dir: 'down' };
  const cs = [
    b(100, 101, 101.4, 99.8),   // sweep up through the level
    b(101, 99.5),               // closes below: reclaimed
    b(99.5, 99.8, 100.1, 99.4), // high 100.1 touches the limit: filled
    b(99.8, 96),
    b(96, 93.5, 96, 93.4),      // target
  ];
  const r = runBracket(cs, 0, SHORT);
  check('a short plan mirrors cleanly — reclaim below, fill on a rally, target down',
    r.filled && r.how === 'target' && r.r === 3,
    `${r.why} ${r.r}R via ${r.how}`);
}

{
  // No opposite level to aim at: the position runs to the horizon and is marked
  // to market rather than being given a target it never had.
  const cs = [
    b(100, 99, 100.2, 98.6), b(99, 100.5), b(100.5, 100.2, 100.6, 99.9),
    b(100.2, 101), b(101, 102),
  ];
  const r = runBracket(cs, 0, { ...LONG, target: null, holdBars: 2 });
  check('with no target the trade is marked to market at the horizon',
    r.filled && r.how === 'horizon' && Math.abs(r.r - 1) < 1e-6,
    `${r.how} ${r.r}R`,
    'entry 100, out at 102, risk 2 — one R');
}

{
  check('a plan with no risk is refused rather than dividing by zero',
    runBracket([b(100, 100)], 0, { entry: 100, stop: 100, target: 110, dir: 'up' }).why === 'no risk');
  check('and an empty series returns not-filled rather than throwing',
    runBracket([], 0, LONG).filled === false);
}

console.log(fails ? `\n${fails} failed` : '\nall bracket checks passed');
process.exit(fails ? 1 : 0);

// Sweep and reversal — shared/liquidity.mjs.
//
// The model: a higher-timeframe level holding resting stops gets taken, price
// refuses to stay beyond it, and a change of character on the execution series
// confirms the turn.
//
// The ways this could be wrong in a way nothing on screen would show:
//
//   Treating a breakout as a sweep. Price beyond the level and STAYING there is
//   the opposite trade. If both produce a setup, the filter means nothing.
//
//   Using a level that is still forming. Today's high is by construction never
//   exceeded by today's price, so sweeping it is arithmetic, not an event.
//
//   Confirming in the wrong direction. A swept high is bearish. A bullish break
//   after it is not a confirmation, it is a contradiction — and this exact
//   defect, a check with no direction term, lived in the bot for months.
//
//   Confirming before the sweep. A break that happened first is not evidence
//   about a liquidity event that had not occurred yet.
import {
  keyLevels, findSweep, confirmation, sweepSetup, H4_SWINGS,
} from '../shared/liquidity.mjs';
import { detectBreaks } from '../shared/structure.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const M = 120e3, T0 = Date.UTC(2026, 0, 5);
let clock = 0;
function bar(o, c, hPad = 0.2, lPad = 0.2) {
  return { t: T0 + (clock++) * M, o, c, h: Math.max(o, c) + hPad, l: Math.min(o, c) - lPad, v: 1 };
}
function leg(out, n, step, from, hPad = 0.2, lPad = 0.05) {
  let p = from;
  for (let i = 0; i < n; i++) { const o = p, c = p + step; out.push(bar(o, c, step > 0 ? hPad : lPad, step > 0 ? lPad : hPad)); p = c; }
  return p;
}

// ── Levels come from COMPLETED candles ─────────────────────────────────────
{
  const daily = [
    { o: 100, h: 110, l: 95, c: 105 },   // older
    { o: 105, h: 118, l: 101, c: 112 },  // YESTERDAY — the one that counts
    { o: 112, h: 113, l: 111, c: 112 },  // today, still forming
  ];
  const weekly = [
    { o: 90, h: 120, l: 88, c: 115 },
    { o: 115, h: 130, l: 108, c: 120 },  // last week
    { o: 120, h: 121, l: 119, c: 120 },  // this week, still forming
  ];
  const ls = keyLevels({ daily, weekly });

  const pdh = ls.find(l => l.kind === 'PDH');
  check("yesterday's high is the level, not today's",
    pdh.price === 118, `${pdh.price}`,
    "today's high is wherever price is — sweeping it is arithmetic, not an event");
  check("and yesterday's low likewise",
    ls.find(l => l.kind === 'PDL').price === 101);
  check('last week gives its own pair',
    ls.find(l => l.kind === 'PWH').price === 130 && ls.find(l => l.kind === 'PWL').price === 108);

  check('every level knows which side it is',
    ls.every(l => (l.side === 'high') === /H$/.test(l.kind)),
    ls.map(l => `${l.kind}:${l.side}`).join(' '));

  check('no data means no levels rather than invented ones',
    keyLevels({}).length === 0 && keyLevels({ daily: [{ o:1,h:1,l:1,c:1 }] }).length === 0,
    'one candle has no PRIOR candle');

  // H4 swings, capped
  const h4 = [];
  let p = 100;
  for (const [n, s] of [[6,1],[6,-1],[7,1],[6,-1],[7,1],[6,-1],[7,1],[6,-1]]) p = leg(h4, n, s, p);
  const withH4 = keyLevels({ h4 });
  check('recent H4 swings become levels, and only the recent ones',
    withH4.filter(l => l.kind === 'H4H').length <= H4_SWINGS
    && withH4.filter(l => l.kind === 'H4L').length <= H4_SWINGS
    && withH4.length > 0,
    `${withH4.length} levels`,
    'older swings have been traded through and are not where the stops are any more');
}

const LEVEL = [{ kind: 'PDH', price: 110, side: 'high', label: "yesterday's high" }];
const LOW_LEVEL = [{ kind: 'PDL', price: 90, side: 'low', label: "yesterday's low" }];

// ── A sweep is taken AND given back ────────────────────────────────────────
{
  // Up through 110, then back below it.
  const swept = [];
  let p = 104;
  p = leg(swept, 8, 1, p);          // 104 → 112, wicks above 110
  leg(swept, 8, -1, p);             // back down to 104

  const s = findSweep(swept, LEVEL);
  check('a level taken and reclaimed is a sweep',
    s !== null && s.level.kind === 'PDH', s ? s.level.kind : 'null');
  check('and it is bearish, because the buy stops above the high were filled',
    s.dir === 'short', s.dir,
    'there is no case where a swept high argues for a long');
  check('it records how far beyond the level price actually went',
    s.extreme > 110, String(s.extreme));
  check('and which bar did it',
    s.at >= 0 && swept[s.at].h === s.extreme, `bar ${s.at}`);

  // Up through 110 and STAYING there.
  const broke = [];
  p = 104;
  leg(broke, 12, 1, p);             // 104 → 116 and closes there
  check('a breakout is NOT a sweep',
    findSweep(broke, LEVEL) === null,
    `last close ${broke[broke.length-1].c.toFixed(1)}`,
    'price beyond the level and staying is the opposite trade; conflating them makes the filter meaningless');

  // Never reached the level at all.
  const never = [];
  p = 100;
  leg(never, 10, 0.3, p);
  check('a level never reached is not swept',
    findSweep(never, LEVEL) === null);

  // The mirror.
  const sweptLow = [];
  p = 96;
  p = leg(sweptLow, 8, -1, p);      // down through 90
  leg(sweptLow, 8, 1, p);           // back up
  const sl = findSweep(sweptLow, LOW_LEVEL);
  check('sweeping a low is bullish',
    sl !== null && sl.dir === 'long', sl ? sl.dir : 'null');
}

// ── Two levels at once is one event, and the deeper one ran the stops ──────
{
  const both = [];
  let p = 104;
  p = leg(both, 10, 1, p);          // up through 108 and 110
  leg(both, 12, -1, p);
  const two = [
    { kind: 'H4H', price: 108, side: 'high', label: 'H4 swing high' },
    { kind: 'PDH', price: 110, side: 'high', label: "yesterday's high" },
  ];
  const s = findSweep(both, two);
  check('when two levels are taken, the one taken furthest is reported',
    s.level.price === 108, `${s.level.kind} at ${s.level.price}`,
    'depth beyond 108 is larger than depth beyond 110 for the same extreme');
}

// ── The confirmation must come after, and point the right way ─────────────
{
  // A real reversal pulls back. A straight-line drop leaves no confirmed swing
  // low to break, so the first version of this fixture produced zero breaks —
  // the code was right and the fixture was not a reversal.
  const cs = [];
  let p = 104;
  p = leg(cs, 8, 1, p);             // sweep up through 110
  p = leg(cs, 10, -1, p);           // reject
  p = leg(cs, 5, 0.8, p);           // pull back, leaving a swing low
  leg(cs, 10, -1.2, p);             // and break it

  const s = findSweep(cs, LEVEL);
  const c = confirmation(cs, s);
  check('a downward break after a swept high confirms the short',
    c !== null && c.direction === 'bearish', c ? `${c.type} ${c.direction}` : 'null');
  check('and it happened after the liquidity was taken',
    c.index > s.at, `break ${c.index} vs sweep ${s.at}`,
    'a break that came first is not evidence about an event that had not happened');

  check('an upward break does NOT confirm a swept high',
    confirmation(cs, { ...s, dir: 'long' }) === null
    || confirmation(cs, { ...s, dir: 'long' }).direction === 'bullish',
    'a check with no direction term is the exact defect that lived in the bot for months');

  check('a stale sweep expires rather than confirming forever',
    confirmation(cs, { ...s, at: 0 }, { maxBars: 2 }) === null,
    'a confirmation thirty bars late is a move you watched, not one you can take');

  check('no sweep means no confirmation',
    confirmation(cs, null) === null && confirmation(null, s) === null);
}

// ── The ticket ─────────────────────────────────────────────────────────────
{
  // Sweep, drop, pull back leaving a swing low, break it, pull back again,
  // break again. Two breaks matter: the setup triggered at the FIRST one.
  const exec = [];
  let p = 104;
  p = leg(exec, 8, 1, p);           // sweep up through 110
  p = leg(exec, 6, -0.6, p);        // reject
  p = leg(exec, 4, 0.5, p);         // pullback — leaves a swing low
  p = leg(exec, 6, -0.6, p);        // break it
  p = leg(exec, 4, 0.4, p);         // pullback again
  leg(exec, 6, -0.6, p);            // and again

  const daily = [{ o:100,h:105,l:95,c:104 }, { o:104,h:110,l:100,c:106 }, { o:106,h:107,l:105,c:106 }];
  const out = sweepSetup({ daily, exec });

  check('a confirmed sweep produces a direction, an entry and a stop',
    out?.ready === true && out.dir === 'short'
    && Number.isFinite(out.entry) && Number.isFinite(out.stop),
    out ? `${out.dir} entry ${out.entry?.toFixed(2)} stop ${out.stop?.toFixed(2)}` : 'null');

  check('the stop sits beyond the swept extreme, not at the level',
    out.stop > out.sweep.extreme, `stop ${out.stop.toFixed(2)} vs extreme ${out.sweep.extreme.toFixed(2)}`,
    'price already proved it can reach the extreme; a stop inside that is taken by a retest that changes nothing');

  check('risk is the distance between them and is positive',
    out.risk > 0 && Math.abs(out.risk - Math.abs(out.entry - out.stop)) < 1e-9, out.risk.toFixed(2));

  check('a short entry is below its stop',
    out.entry < out.stop, `${out.entry.toFixed(2)} < ${out.stop.toFixed(2)}`,
    'an entry the wrong side of its own stop is a trade already lost before it is placed');

  check('the entry is the confirmation bar, not wherever price is now',
    out.entry === exec[out.confirm.index].c,
    `${out.entry.toFixed(2)} at bar ${out.confirm.index} of ${exec.length}`,
    'quoting a break that already happened at the current close, with the same stop, invents a fill nobody could have got');

  check('the confirmation is the FIRST break after the sweep, not the newest',
    (() => {
      const c = confirmation(exec, out.sweep);
      return c.index === out.confirm.index
        && !detectableEarlier(exec, out.sweep, c.index);
    })(),
    `bar ${out.confirm.index}`,
    'the latest break reports a move you watched go past as a live ticket');

  check('the reason names the level, so a row can explain itself',
    /yesterday's high/.test(out.reason), out.reason);

  // The same setup, judged by a stricter freshness rule than its own age.
  const strict = sweepSetup({ daily, exec }, { freshBars: 0 });
  check('a confirmation older than the freshness rule allows is not ready',
    strict.age > 0 && strict.fresh === false && strict.ready === false,
    `age ${strict.age}, ready ${strict.ready}`,
    '"you missed it" is a different state from "there was no setup"');
  check('and it says so in words rather than just going quiet',
    /the entry has gone/.test(strict.reason), strict.reason);
  check('but the sweep and the break are still reported, because they happened',
    strict.sweep !== null && strict.confirm !== null);

  // A sweep with no confirmation yet.
  const waiting = [];
  let q = 104;
  q = leg(waiting, 8, 1, q);
  leg(waiting, 14, -0.5, q);
  const w = sweepSetup({ daily, exec: waiting });
  check('a sweep without confirmation is watched, not tradeable',
    w !== null && w.ready === false && w.confirm === null && w.entry === undefined,
    w ? `ready ${w.ready}, confirm ${w.confirm}` : 'null',
    'this is the row that says "watch", and it must not carry an entry price');

  check('no sweep at all produces nothing',
    sweepSetup({ daily, exec: (() => { const a = []; leg(a, 25, 0.05, 104); return a; })() }) === null,
    'price that never left the range between the levels swept nothing');

  check('too little execution history produces nothing rather than a guess',
    sweepSetup({ daily, exec: exec.slice(0, 10) }) === null);
}

// Is there a qualifying break earlier than `idx`? Used to prove the
// confirmation really is the first one and not merely a plausible one.
function detectableEarlier(cs, sweep, idx) {
  const want = sweep.dir === 'long' ? 'bullish' : 'bearish';
  return detectBreaks(cs, { within: Math.min(30, cs.length - 1), max: 8 })
    .some(b => b.direction === want && b.index > sweep.at && b.index < idx);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

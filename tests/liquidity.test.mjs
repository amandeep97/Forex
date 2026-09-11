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
  keyLevels, findSweep, confirmation, sweepSetup, approach, levelStates, tsOf, H4_SWINGS, LEVEL_RANK,
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

// ── Two levels at once is one event ────────────────────────────────────────
//
// This test used to assert the level taken FURTHEST wins, which was the rule
// until a live run showed why it is wrong. See the ranking block below: depth
// now breaks ties within a rank and no longer outranks the level's importance.
{
  const both = [];
  let p = 104;
  p = leg(both, 10, 1, p);          // up through 108 and 110
  leg(both, 12, -1, p);
  const two = [
    { kind: 'H4H', price: 108, side: 'high', label: 'H4 swing high' },
    { kind: 'H4H', price: 110, side: 'high', label: 'a higher H4 swing high' },
  ];
  const s = findSweep(both, two);
  check('between two levels of equal standing, the one taken furthest is reported',
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

  // Shipped broken. The waiting row read `dir` off the setup, the early return
  // did not carry it, and the undefined fell through a ternary to "bearish" —
  // so a swept LOW announced itself as waiting for a bearish break, on screen,
  // in the app. Both returns carry the direction now.
  check('the waiting state still knows which way the sweep points',
    w.dir === w.sweep.dir && (w.dir === 'long' || w.dir === 'short'),
    `dir ${w.dir}, sweep ${w.sweep.dir}`,
    'a direction that exists internally but never travels out is the same defect as one never computed');

  const lowSwept = [];
  let z = 104;
  z = leg(lowSwept, 9, -1, z);      // down through yesterday's low at 100
  leg(lowSwept, 14, 0.6, z);        // and back above it
  const lw = sweepSetup({ daily, exec: lowSwept });
  check('a swept LOW waits for a BULLISH break, never a bearish one',
    lw !== null && lw.sweep.level.side === 'low' && lw.dir === 'long',
    lw ? `${lw.sweep.level.label} → ${lw.dir}` : 'null',
    'this is exactly what was wrong on screen');

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

// ── Daily levels outrank the rest ──────────────────────────────────────────
//
// The first version ranked by depth alone, so an H4 swing an inch away beat
// yesterday's high a mile away. On the first live run it reported an H4 swing
// low on EUR/USD and never mentioned the daily levels — for an intraday trader
// those ARE the liquidity, and the H4 swing is a smaller landmark that happened
// to be nearer.
{
  check('the daily high and low rank above weekly, which rank above H4',
    LEVEL_RANK.PDH > LEVEL_RANK.PWH && LEVEL_RANK.PWH > LEVEL_RANK.H4H
    && LEVEL_RANK.PDL === LEVEL_RANK.PDH,
    `PDH ${LEVEL_RANK.PDH} PWH ${LEVEL_RANK.PWH} H4H ${LEVEL_RANK.H4H}`);

  const cs = [];
  let p = 104;
  p = leg(cs, 10, 1, p);          // up through both 108 and 110
  leg(cs, 12, -1, p);             // and back below

  // The H4 swing is taken FURTHER, so depth alone would pick it.
  const mixed = [
    { kind: 'H4H', price: 108, side: 'high', label: 'H4 swing high' },
    { kind: 'PDH', price: 110, side: 'high', label: "yesterday's high" },
  ];
  const s = findSweep(cs, mixed);
  check("yesterday's high wins over a more deeply swept H4 swing",
    s.level.kind === 'PDH', `${s.level.kind} at ${s.level.price}`,
    'this is the EUR/USD row: an H4 swing reported while the daily levels went unmentioned');

  check('and depth still decides between two levels of the same rank',
    findSweep(cs, [
      { kind: 'H4H', price: 108, side: 'high', label: 'a' },
      { kind: 'H4H', price: 109, side: 'high', label: 'b' },
    ]).level.price === 108,
    'ranking must not throw away the tie-break that was there before');
}

// ── Approaching a level, which had no representation at all ────────────────
{
  const at = price => [{ t: 0, o: price, c: price, h: price + 0.05, l: price - 0.05, v: 1 }];
  const levels = [
    { kind: 'PDH', price: 110, side: 'high', label: "yesterday's high" },
    { kind: 'H4H', price: 106, side: 'high', label: 'H4 swing high' },
    { kind: 'PDL', price: 100, side: 'low', label: "yesterday's low" },
  ];

  const near = approach(at(109.5), levels, 2);
  check('price walking up to a level is reported before it is taken',
    near !== null && near.level.kind === 'PDH', near ? near.level.kind : 'null',
    'this is the state a trader actually waits in and it had no line on the screen');
  check('with the distance in the instrument\'s own scale',
    Math.abs(near.pct - 0.25) < 1e-9, `${near.pct} ATR`,
    'a fixed pip count cannot serve gold at 4300 and EUR/USD at 1.08');

  check('a level already gone past is not an approach',
    approach(at(111), [levels[0]], 2) === null,
    'beyond the level is a sweep or a breakout — both are other functions\' business');

  check('and a level far away is not one either',
    approach(at(104), [levels[0]], 2) === null, 'three ATR away is not "approaching"');

  // Both inside the band, so the choice is genuinely about rank. With a
  // smaller ATR the daily level simply is not approaching, and preferring the
  // H4 one there is correct rather than a ranking failure — the first version
  // of this check confused the two.
  check('the daily level wins even when an H4 level is closer',
    approach(at(105.9), levels, 10).level.kind === 'PDH',
    `${approach(at(105.9), levels, 10).level.kind}, PDH 4.1 away and H4H 0.1 away, band 5`,
    'same ranking as a sweep, for the same reason');

  check('approaching a LOW works the same way',
    approach(at(100.6), [levels[2]], 2)?.level.kind === 'PDL');

  check('an approach carries no direction',
    !('dir' in (approach(at(109.5), levels, 2) || {})),
    'price at yesterday\'s high may sweep and turn or go straight through, and that is the undecided part');

  check('no levels, no price or no scale produces nothing rather than a guess',
    approach(at(109.5), [], 2) === null
    && approach([], levels, 2) === null
    && approach(at(109.5), levels, 0) === null
    && approach(at(109.5), levels, null) === null);
}

// ── A state for every level, so a table can have a column each ─────────────
//
// findSweep and approach answer "which ONE level matters most", which is right
// for an alert and wrong for a screen. Asked for a column per level — did it
// hunt the daily high, did it hunt the weekly low — a single best-level answer
// hides five of the six facts, and which one survives depends on a ranking the
// reader cannot see.
{
  const levels = [
    { kind:'PDH', price:110, side:'high', label:"yesterday's high" },
    { kind:'PDL', price:100, side:'low',  label:"yesterday's low" },
    { kind:'PWH', price:120, side:'high', label:"last week's high" },
    { kind:'H4H', price:107, side:'high', label:'H4 swing high' },
  ];

  // Up through 110 (and 107), back below both, nowhere near 120 or 100.
  const cs = [];
  let p = 104;
  p = leg(cs, 8, 1, p);
  leg(cs, 8, -1, p);

  const st = levelStates(cs, levels, 4);
  const by = k => st.find(x => x.kind === k);

  check('every level gets its own entry, not just the winner',
    st.length === levels.length, `${st.length} of ${levels.length}`,
    'a column per level is the whole request');

  check("the daily high reads swept",
    by('PDH').state === 'swept', by('PDH').state);
  check('and so does the H4 swing it passed on the way',
    by('H4H').state === 'swept', by('H4H').state,
    'both were taken; reporting only one of them is what hid the other five facts');
  check('a level price never went near reads quiet',
    by('PWH').state === 'quiet', by('PWH').state);

  check('a swept level carries its direction and a quiet one does not',
    by('PDH').dir === 'short' && by('PWH').dir === null,
    `PDH ${by('PDH').dir}, PWH ${by('PWH').dir}`);

  // Beyond and STAYING is a breakout, not a hunt.
  const through = [];
  p = 104;
  leg(through, 12, 1, p);           // starts below 110, closes at 116 above it
  const tst = levelStates(through, levels, 4);
  check('past the level and still there reads through, never swept',
    tst.find(x => x.kind === 'PDH').state === 'through',
    tst.find(x => x.kind === 'PDH').state,
    'a breakout is the opposite trade; one colour for both would make the table worse than nothing');
  check('and a breakout implies no reversal direction',
    tst.find(x => x.kind === 'PDH').dir === null);

  // The defect that turned the whole live table one colour: a level price has
  // simply been on the far side of for days had every bar beyond it, so "some
  // bar went beyond" was true and it read as a fresh breakout.
  const longGone = [];
  leg(longGone, 30, 0.05, 130);     // never once below 110 in the window
  const lg = levelStates(longGone, levels, 4);
  check('a level price left long ago reads behind, not through',
    lg.find(x => x.kind === 'PDH').state === 'behind',
    lg.find(x => x.kind === 'PDH').state,
    'reporting where price IS rather than what it DID is what made eight of eight rows purple');
  check('and behind carries no direction either',
    lg.find(x => x.kind === 'PDH').dir === null);
  check('a crossing needs price on BOTH sides inside the window',
    tst.find(x => x.kind === 'PDH').state === 'through'
    && lg.find(x => x.kind === 'PDH').state === 'behind',
    'the same level, the same side of it, told apart only by whether price crossed recently');

  // Approaching but not taken.
  const nearBy = [];
  p = 100.5;
  leg(nearBy, 10, 0.05, p);         // drifts up to ~101, just above the 100 low
  const nst = levelStates(nearBy, levels, 4, { near: 0.5 });
  check('a level price is walking toward reads near',
    nst.find(x => x.kind === 'PDL').state === 'near',
    nst.find(x => x.kind === 'PDL').state);
  check('with the distance in the instrument\'s own scale',
    nst.find(x => x.kind === 'PDL').atrPct > 0
    && nst.find(x => x.kind === 'PDL').atrPct <= 0.5,
    `${nst.find(x => x.kind === 'PDL').atrPct} ATR`);
  check('and near carries no direction, because nothing has been decided',
    nst.find(x => x.kind === 'PDL').dir === null,
    'price at the level may sweep and turn or go straight through');

  check('no levels or no candles gives an empty table rather than a guess',
    levelStates(cs, [], 4).length === 0 && levelStates([], levels, 4).length === 0);
}

// ── When it happened ──────────────────────────────────────────────────────
//
// A bar index tells a screen nothing. "Eighteen minutes ago" is what decides
// whether a hunt is still worth acting on, and every earlier version computed
// the index and threw the time away.
{
  const levels = [{ kind:'PDH', price:110, side:'high', label:"yesterday's high" }];
  const cs = [];
  let p = 104;
  p = leg(cs, 8, 1, p);
  leg(cs, 8, -1, p);
  const st = levelStates(cs, levels, 4).find(x => x.kind === 'PDH');

  check('a swept level reports WHEN, not just which bar',
    Number.isFinite(st.atTime), String(st.atTime));
  check('and the time is the sweeping bar\'s own',
    st.atTime === tsOf(cs[st.at]), `${st.atTime} vs bar ${st.at}`,
    'off by one bar here is two minutes of wrongness on every row');

  check('a level nothing happened at reports no time rather than zero',
    levelStates(cs, [{ kind:'PWH', price:200, side:'high', label:'far' }], 4)[0].atTime === null,
    'zero is a real timestamp and would render as 1970');

  // Both spellings, because the bot passes numbers and the app passes ISO.
  check('candle times work as epoch numbers and as ISO strings',
    tsOf({ t: 1757000000000 }) === 1757000000000
    && tsOf({ t: '2026-09-11T03:00:00.000Z' }) === Date.parse('2026-09-11T03:00:00.000Z'),
    'reading .t raw works for one and silently produces NaN for the other');

  check('and a candle with no time says so',
    tsOf({}) === null && tsOf(null) === null && tsOf({ t: 'not a date' }) === null);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

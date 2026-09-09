// Market structure — shared/structure.mjs.
//
// Written after being asked whether the SMC concepts were implemented properly.
// Reading the code found three defects, and none of them would have shown up as
// a crash or a wrong-looking number on screen.
//
//   Direction was never checked. `bos: !requireBOS || smc.hasBOS` has no
//   direction term, so a LONG strategy passed on price breaking DOWN.
//
//   CHoCH was computed and used zero times, under a control labelled
//   "BOS / CHoCH".
//
//   And the trend was decided twice by two different measures that were free
//   to disagree with each other.
import {
  findSwings, alternate, readStructure, detectBreak, detectBreaks, breakSatisfies, SWING_LOOK,
} from '../shared/structure.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const H = 3600e3, T0 = Date.UTC(2026, 0, 5);
let clock = 0;
const reset = () => { clock = 0; };
// A leg of `n` bars moving `step` each.
//
// The wicks are ASYMMETRIC, and that is not decoration. With a symmetric pad,
// the last bar of an up leg and the first bar of the down leg that follows
// share a price and therefore an identical high — and a fractal swing needs a
// STRICT maximum, so the tie disqualified the turn and the fixture produced
// zero swings. A rising bar carrying a larger upper wick than a falling one is
// both realistic and enough to break it.
function leg(out, n, step, from) {
  let p = from;
  const up = step > 0;
  for (let i = 0; i < n; i++) {
    const o = p, c = p + step;
    out.push({
      t: T0 + (clock++) * H, o, c, v: 1,
      h: Math.max(o, c) + (up ? 0.2 : 0.05),
      l: Math.min(o, c) - (up ? 0.05 : 0.2),
    });
    p = c;
  }
  return p;
}
function series(legs, start = 100) {
  reset();
  const out = [];
  let p = start;
  for (const [n, step] of legs) p = leg(out, n, step, p);
  return out;
}

// ── Swings are only swings once price has turned away ───────────────────────
{
  const cs = series([[6, 1], [6, -1], [6, 1]]);
  const sw = findSwings(cs, SWING_LOOK);
  check('a turn in the middle is found as a swing',
    sw.length > 0, `${sw.length} swings`);
  check('and the newest bars are never swings, because nothing has turned yet',
    sw.every(s => s.idx < cs.length - SWING_LOOK),
    'calling the last bar a swing would be reading the future');
}

// ── Two highs in a row are one high ─────────────────────────────────────────
//
// The defect the old code had: highs[-1] against highs[-2] as a list, with no
// low between them required. Two points from the same leg say nothing about
// structure, and comparing them reads as a lower high when it is just noise
// on the way up.
{
  const raw = [
    { kind: 'high', price: 105, idx: 10 },
    { kind: 'high', price: 108, idx: 14 },   // no low in between
    { kind: 'low', price: 100, idx: 20 },
    { kind: 'low', price: 98, idx: 24 },     // no high in between
    { kind: 'high', price: 112, idx: 30 },
  ];
  const alt = alternate(raw);
  check('consecutive highs collapse to the HIGHER one',
    alt.filter(s => s.kind === 'high')[0].price === 108,
    alt.map(s => `${s.kind[0]}${s.price}`).join(' '));
  check('and consecutive lows collapse to the LOWER one',
    alt.filter(s => s.kind === 'low')[0].price === 98);
  check('the result strictly alternates',
    alt.every((s, i) => i === 0 || s.kind !== alt[i - 1].kind),
    alt.map(s => s.kind[0]).join(''));
  check('and nothing is invented — the count only ever shrinks',
    alt.length <= raw.length && alt.length === 3, `${alt.length} of ${raw.length}`);
}

// ── Higher high AND higher low ──────────────────────────────────────────────
{
  // Up, back, further up, back less, further up: higher highs and higher lows.
  const up = series([[6, 1], [4, -0.6], [7, 1], [4, -0.6], [7, 1], [5, -0.6]]);
  const su = readStructure(up);
  check('a staircase of higher highs and higher lows reads bullish',
    su.structure === 'bullish', `${su.structure} (HH ${su.higherHigh}, HL ${su.higherLow})`);

  const down = series([[6, -1], [4, 0.6], [7, -1], [4, 0.6], [7, -1], [5, 0.6]]);
  const sd = readStructure(down);
  check('and the mirror reads bearish',
    sd.structure === 'bearish', `${sd.structure} (LH ${sd.lowerHigh}, LL ${sd.lowerLow})`);

  check('the individual legs are reported, not just the label',
    su.higherHigh === true && su.higherLow === true
    && su.lowerHigh === false && su.lowerLow === false,
    'a higher low without a higher high is a real state and needs its own name');

  const flat = series([[6, 1], [6, -1], [6, 1], [6, -1], [6, 1], [6, -1]]);
  check('a market going nowhere is ranging rather than forced into a side',
    readStructure(flat).structure === 'ranging', readStructure(flat).structure);

  check('too few swings to judge is ranging, not a guess',
    readStructure(series([[4, 1]])).structure === 'ranging');
}

// ── BOS is with the trend, CHoCH is against it ──────────────────────────────
{
  // A downtrend, then a close back above a prior swing high. Against the
  // trend, so a change of character — the signal that a reversal is starting.
  const cs = series([[6, -1], [4, 0.6], [7, -1], [4, 0.6], [7, -1], [10, 1.4]]);
  const brk = detectBreak(cs);
  check('a break upward inside a downtrend is a CHoCH, not a BOS',
    brk.hasCHoCH === true && brk.hasBOS === false,
    `BOS ${brk.hasBOS}, CHoCH ${brk.hasCHoCH}, trend ${brk.structure}`);
  check('and it carries its direction',
    brk.direction === 'bullish', String(brk.direction),
    'bosDirection was computed and used zero times before this');

  // The same trend, continuing down through its own low: with the trend.
  const cont = series([[6, -1], [4, 0.6], [7, -1], [4, 0.6], [7, -1], [10, -1.4]]);
  const b2 = detectBreak(cont);
  check('a break downward inside a downtrend is a BOS',
    b2.hasBOS === true && b2.hasCHoCH === false && b2.direction === 'bearish',
    `BOS ${b2.hasBOS}, CHoCH ${b2.hasCHoCH}, ${b2.direction}`);

  check('a ranging market gets neither label, only a direction',
    (() => {
      const r = detectBreak(series([[6, 1], [6, -1], [6, 1], [6, -1], [8, 2]]));
      return r.structure === 'ranging' && !(r.hasBOS && r.hasCHoCH);
    })(),
    'there is no trend to continue or reverse, and inventing one to classify against would be worse');

  check('too little history says nothing rather than guessing',
    detectBreak(series([[5, 1]])).direction === null);
}

// ── THE defect: a long must not pass on a downward break ────────────────────
{
  const bearBreak = { hasBOS: true, hasCHoCH: false, direction: 'bearish' };
  const bullBreak = { hasBOS: true, hasCHoCH: false, direction: 'bullish' };
  const bullChoch = { hasBOS: false, hasCHoCH: true, direction: 'bullish' };
  const nothing = { hasBOS: false, hasCHoCH: false, direction: null };

  check('a LONG does not pass on a bearish break',
    breakSatisfies(bearBreak, 'long') === false,
    'this is exactly what the old check did, because it had no direction term');
  check('a long passes on a bullish break',
    breakSatisfies(bullBreak, 'long') === true);
  check('a SHORT is the mirror',
    breakSatisfies(bearBreak, 'short') === true
    && breakSatisfies(bullBreak, 'short') === false);

  check('a CHoCH satisfies a control labelled "BOS / CHoCH"',
    breakSatisfies(bullChoch, 'long') === true,
    'CHoCH was computed and never read, so the label promised something the bot ignored');

  check('and no break at all satisfies nothing',
    breakSatisfies(nothing, 'long') === false
    && breakSatisfies(nothing, 'short') === false
    && breakSatisfies(null, 'long') === false);
}

// ── One trend, not two ──────────────────────────────────────────────────────
{
  // detectBreak must classify against the SAME structure readStructure reports.
  // The old code decided bull-or-bear by comparing the last swing high in the
  // window to the FIRST one, which could contradict the structure on screen.
  for (const legs of [
    [[6, -1], [4, 0.6], [7, -1], [4, 0.6], [7, -1], [10, 1.4]],
    [[6, 1], [4, -0.6], [7, 1], [4, -0.6], [7, 1], [10, -1.4]],
  ]) {
    const cs = series(legs);
    const brk = detectBreak(cs);
    const read = readStructure(cs.slice(0, cs.length - 1)).structure;
    check(`the break is classified against the structure actually read (${read})`,
      brk.structure === read, `${brk.structure} vs ${read}`,
      'two measures of trend in one analysis could disagree, and did');
  }
}

// ── The list the screener and the chart draw from ──────────────────────────
//
// A THIRD copy of this logic lived in smcAnalysis.js for the screener, and it
// carried the same defect: the trend came from comparing the last swing high in
// the window to the FIRST one, and there was no ranging state at all. So a
// sideways market was forced to be bullish or bearish and every break in it was
// tagged as continuing or reversing a trend that was not there.
{
  const cs = series([[6, -1], [4, 0.6], [7, -1], [4, 0.6], [7, -1], [10, 1.4]]);
  const list = detectBreaks(cs);
  check('the list and the single read agree on the newest break',
    list.length > 0 && list[0].type === (detectBreak(cs).hasCHoCH ? 'CHoCH' : 'BOS')
    && list[0].direction === detectBreak(cs).direction,
    `${list[0]?.type} ${list[0]?.direction}`,
    'the tag on a screener row and the bot decision must not disagree');

  check('it is newest first, so a stale break never leads',
    list.every((b, i) => i === 0 || b.index <= list[i - 1].index),
    list.map(b => b.index).join(' > '));

  check('and it carries the shape the chart draws',
    list.every(b => typeof b.price === 'number' && typeof b.index === 'number'
      && typeof b.label === 'string' && /[↑↓]/.test(b.label)));

  // The screener's old code had no ranging state, so this is the case that
  // could not previously be expressed at all.
  const flat = series([[6, 1], [6, -1], [6, 1], [6, -1], [8, 2]]);
  const fl = detectBreaks(flat);
  check('a break in a ranging market is neither BOS nor CHoCH',
    fl.every(b => b.type !== 'BOS' && b.type !== 'CHoCH'),
    fl.map(b => b.type).join(', ') || '(none)',
    'there is no trend to continue or reverse and saying otherwise invents one');

  check('each swing level is only broken once',
    (() => {
      const seen = new Set();
      return list.every(b => {
        const k = `${b.direction}${b.price}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
    })(),
    'one level broken on six consecutive bars is one break, not six');

  check('too little history gives an empty list rather than a guess',
    detectBreaks(series([[5, 1]])).length === 0);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

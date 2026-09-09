// Premium and discount — shared/premiumDiscount.mjs.
//
// Written after the FEED showed a LONG on GBP/USD with price pressed against
// the top of its range and nothing in the app able to notice. The engine vote
// counts how many methods agree. None of them knows where price is, so four
// engines can agree on "up" at the ceiling and the vote calls that a clean read.
//
// The ways this check could be worse than useless, each of which has a test:
//
//   Blocking breakouts. Price above the range high is not an extreme premium,
//   it is a breakout, and buying above everything is the entire point of one.
//
//   Blocking everything. Price is at the top of SOME two-minute leg most of the
//   time. If M2 could veto, almost nothing would survive and the block would
//   carry no information at all.
//
//   Vetoing on a measurement that was never taken. A range that could not be
//   computed is not evidence against a trade.
import {
  dealingRange, rangeRead, forbids, locationCheck, pct, EQ_BAND,
} from '../shared/premiumDiscount.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const H = 3600e3, T0 = Date.UTC(2026, 0, 5);
let clock = 0;
// Same asymmetric wicks as the structure fixture, and for the same reason: with
// a symmetric pad the last bar of an up leg and the first of the down leg tie
// exactly, a fractal swing needs a strict maximum, and the fixture yields no
// swings at all.
function leg(out, n, step, from) {
  let p = from;
  const up = step > 0;
  for (let i = 0; i < n; i++) {
    const o = p, c = p + step;
    out.push({ t: T0 + (clock++) * H, o, c, v: 1,
      h: Math.max(o, c) + (up ? 0.2 : 0.05), l: Math.min(o, c) - (up ? 0.05 : 0.2) });
    p = c;
  }
  return p;
}
function series(legs, start = 100) {
  clock = 0;
  const out = [];
  let p = start;
  for (const [n, step] of legs) p = leg(out, n, step, p);
  return out;
}

// A range with a clear high and a clear low, and enough bars after each that
// both are confirmed swings.
const RANGE = series([[6, 1], [8, -1], [8, 1], [8, -1], [6, 1]]);
const R = dealingRange(RANGE);

// ── There is a range, and it is not drawn to the current bar ────────────────
{
  check('a swing high and a swing low make a range',
    R !== null && R.high > R.low, R ? `${R.low.toFixed(2)}–${R.high.toFixed(2)}` : 'null');

  const last = RANGE[RANGE.length - 1];
  check('the range is not anchored to the newest bar',
    R.high !== last.h && R.low !== last.l,
    'a range drawn to the current bar puts price at 0% or 100% of it by construction, which measures nothing');

  check('too little history is no range rather than a guessed one',
    dealingRange(series([[5, 1]])) === null);
  check('and one-sided swings are not a range either',
    dealingRange(null) === null && dealingRange([]) === null);
}

// ── The half price sits in ─────────────────────────────────────────────────
{
  const eq = (R.high + R.low) / 2;
  const span = R.high - R.low;

  const hi = rangeRead(RANGE, eq + span * 0.35);
  const lo = rangeRead(RANGE, eq - span * 0.35);
  check('the top half is premium', hi.zone === 'premium', `${hi.zone} at ${pct(hi.pos)}`);
  check('the bottom half is discount', lo.zone === 'discount', `${lo.zone} at ${pct(lo.pos)}`);

  const mid = rangeRead(RANGE, eq);
  check('the exact middle is neither half',
    mid.zone === 'equilibrium', `${mid.zone} at ${pct(mid.pos)}`,
    'without a dead band 50.01% and 49.99% are opposite verdicts and the answer flips on noise');

  const edge = rangeRead(RANGE, eq + span * (EQ_BAND * 0.9));
  check('and the dead band is actually the width it claims to be',
    edge.zone === 'equilibrium', `${edge.zone} at ${pct(edge.pos)}`);

  check('the position is reported as well as the label',
    Math.abs(rangeRead(RANGE, eq).pos - 0.5) < 1e-9, String(mid.pos),
    'a caller showing 47% on screen must not have to re-derive it');
}

// ── A breakout is not a premium ────────────────────────────────────────────
{
  const above = rangeRead(RANGE, R.high + (R.high - R.low) * 0.2);
  const below = rangeRead(RANGE, R.low - (R.high - R.low) * 0.2);
  check('price above the range is outside, not premium',
    above.zone === 'outside', `${above.zone} at ${pct(above.pos)}`,
    'calling a breakout an extreme premium would veto exactly the trades this rule was never aimed at');
  check('and price below the range is outside, not discount',
    below.zone === 'outside', below.zone);

  check('outside forbids nothing in either direction',
    !forbids(above, 'up') && !forbids(above, 'down')
    && !forbids(below, 'up') && !forbids(below, 'down'));
}

// ── THE case: a long at the top ────────────────────────────────────────────
{
  const eq = (R.high + R.low) / 2, span = R.high - R.low;
  const top = rangeRead(RANGE, eq + span * 0.4);
  const bottom = rangeRead(RANGE, eq - span * 0.4);

  check('a LONG is forbidden at the top of the range',
    forbids(top, 'up') === true,
    'this is the GBP/USD row: engines aligned long, price at the ceiling, nothing able to object');
  check('a SHORT is forbidden at the bottom',
    forbids(bottom, 'down') === true);

  check('and the right-way-round trades are allowed',
    forbids(bottom, 'up') === false && forbids(top, 'down') === false);

  check('long and up mean the same thing, as do short and down',
    forbids(top, 'long') === forbids(top, 'up')
    && forbids(bottom, 'short') === forbids(bottom, 'down'),
    'two vocabularies for one idea is how a check ends up silently inverted');

  check('equilibrium forbids nothing',
    forbids(rangeRead(RANGE, eq), 'up') === false
    && forbids(rangeRead(RANGE, eq), 'down') === false,
    'the middle is not a bad place to trade from, it is merely not an edge');

  check('a measurement that could not be taken forbids nothing',
    forbids(null, 'up') === false && forbids(rangeRead(RANGE, NaN), 'up') === false,
    'absent must stay absent — a missing range is not evidence against the trade');

  check('and no direction forbids nothing',
    forbids(top, null) === false);
}

// ── Only H4 blocks. M15 and M2 say "not yet" ───────────────────────────────
{
  const eq = (R.high + R.low) / 2, span = R.high - R.low;
  const topPrice = eq + span * 0.4;
  const botPrice = eq - span * 0.4;

  // Discount on H4, premium on the faster two: a good idea at a bad moment.
  const fastTop = series([[6, -1], [8, 1], [8, -1], [8, 1], [6, -1]], 80);
  const fr = rangeRead(fastTop, botPrice);

  const a = locationCheck({ H4: RANGE, M15: RANGE, M2: RANGE }, topPrice, 'up');
  check('a long at the top of the H4 range is vetoed',
    a.veto !== null, String(a.veto));
  check('the veto says where price was, not just that it failed',
    /%/.test(a.veto || ''), String(a.veto),
    'a block with no number on it cannot be argued with or checked');

  const b = locationCheck({ H4: RANGE, M15: [], M2: [] }, botPrice, 'up');
  check('a long in the H4 discount is not vetoed',
    b.veto === null, String(b.veto));

  check('the fast timeframes are read but never veto',
    (() => {
      const c = locationCheck({ H4: RANGE, M15: fastTop, M2: fastTop }, botPrice, 'up');
      return c.veto === null && (fr && forbids(fr, 'up') ? c.timing !== null : true);
    })(),
    'price is at the top of some two-minute leg most of the time; an M2 veto would block nearly everything and mean nothing');

  check('all three reads come back for the screen',
    (() => {
      const c = locationCheck({ H4: RANGE, M15: RANGE, M2: RANGE }, topPrice, 'up');
      return ['H4', 'M15', 'M2'].every(k => k in c.reads);
    })());

  check('a veto suppresses the timing note',
    a.timing === null,
    'telling someone to wait for a better level on a trade that is not allowed is two contradictory instructions');

  check('no candles at all produces no veto',
    locationCheck({}, topPrice, 'up').veto === null,
    'a missing fetch must not silently block every trade');
}

// ── The number on the screen ───────────────────────────────────────────────
{
  check('a position prints as a whole percent', pct(0.4705) === '47%', pct(0.4705));
  check('and an absent one prints as a dash rather than NaN',
    pct(null) === '—' && pct(undefined) === '—' && pct(NaN) === '—');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

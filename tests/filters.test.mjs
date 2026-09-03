// The strategy entry filters — shared/strategyFilters.mjs and the indicators
// under them.
//
// These exist because of a bug that already happened in this repo once: three
// switches were configurable in the app and read by nothing, so a strategy set
// to enter only on a bullish engulfing entered on EVERY bar while the screen
// said it was filtering. So the checks below are mostly about the failure
// direction — a filter that cannot be computed must FAIL, never pass, and a
// filter that is off must not silently be on.
import {
  checkCandle, checkMACD, checkBollinger, checkStochastic, checkADX,
  checkIndicatorFilters,
} from '../shared/strategyFilters.mjs';
import {
  macdAt, bollingerAt, stochasticAt, adxAt,
  MACD_MIN, BB_MIN, STOCH_MIN, ADX_MIN,
} from '../shared/indicators.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const H = 3600e3;
const MON = Date.UTC(2026, 0, 5);
const stamp = arr => arr.map((b, k) => ({ t: MON + k * H, v: 1, ...b }));
const bar = (o, h, l, c) => ({ o, h, l, c });
const flat = (n, px = 100, w = 1) =>
  stamp(Array.from({ length: n }, () => bar(px, px + w, px - w, px)));
const ramp = (n, from = 100, step = 1, w = 0.4) =>
  stamp(Array.from({ length: n }, (_, i) => {
    const o = from + i * step, c = o + step;
    return bar(o, Math.max(o, c) + w, Math.min(o, c) - w, c);
  }));

// ── Off means off ───────────────────────────────────────────────────────────
{
  const cs = flat(200);
  check('every filter left off passes without touching the candles',
    checkMACD(cs, undefined).pass && checkMACD(cs, { enabled: false }).pass
    && checkBollinger(cs, { enabled: false }).pass
    && checkStochastic(cs, { enabled: false }).pass
    && checkADX(cs, { enabled: false }).pass
    && checkCandle(cs, 'any').pass && checkCandle(cs, null).pass);
  const all = checkIndicatorFilters(cs, {});
  check('and a strategy with none of them set passes as a whole',
    all.pass && all.first === null);
}

// ── Not computable is a FAIL, never a pass ──────────────────────────────────
//
// The single most important group here. `price > null` is TRUE in JavaScript,
// so a filter that returns a null indicator and compares it will pass every
// bar — which is exactly how a switch stops switching anything.
{
  const tiny = flat(10);
  check('MACD on ten bars fails rather than passing',
    checkMACD(tiny, { enabled: true, mode: 'above' }).pass === false);
  check('Bollinger on ten bars fails rather than passing',
    checkBollinger(tiny, { enabled: true, mode: 'below_lower' }).pass === false);
  check('the stochastic on ten bars fails rather than passing',
    checkStochastic(tiny, { enabled: true, comparison: 'below', value: 20 }).pass === false);
  check('ADX on ten bars fails rather than passing',
    checkADX(tiny, { enabled: true, mode: 'strong' }).pass === false);
  check('and each one says how many bars it wanted',
    /90/.test(checkMACD(tiny, { enabled: true }).why)
    && /21/.test(checkBollinger(tiny, { enabled: true, mode: 'below_lower' }).why)
    && /17/.test(checkStochastic(tiny, { enabled: true }).why)
    && /42/.test(checkADX(tiny, { enabled: true }).why));

  check('the indicators themselves return null rather than a plausible number',
    macdAt(tiny) === null && bollingerAt(tiny) === null
    && stochasticAt(tiny) === null && adxAt(tiny) === null,
    'a seeded-off-four-bars EMA is not an EMA');

  // The stated minimums have to be the real ones, or the note in the UI lies.
  check('and the stated minimum is the actual minimum for each',
    macdAt(flat(MACD_MIN - 1)) === null
    && bollingerAt(flat(BB_MIN - 1)) === null
    && stochasticAt(flat(STOCH_MIN - 1)) === null
    && adxAt(flat(ADX_MIN - 1)) === null);
}

// ── A flat market is not a signal ───────────────────────────────────────────
{
  const cs = flat(300);
  check('Bollinger refuses a window with no deviation at all',
    bollingerAt(cs) === null,
    'a flat window has no band for price to be outside of');
  const dead = stamp(Array.from({ length: 60 }, () => bar(100, 100, 100, 100)));
  check('and the stochastic refuses a window with literally no range',
    stochasticAt(dead) === null,
    'a bar with no high and no low has no position within itself');
  check('so "price below the lower band" fails on a flat market',
    checkBollinger(cs, { enabled: true, mode: 'below_lower' }).pass === false,
    'the alternative is a filter that fires every bar of a dead market');
}

// ── MACD: a state and an event are different conditions ─────────────────────
{
  // ACCELERATING, not linear. On a perfectly straight ramp the MACD line is a
  // constant, its signal converges onto it, and the histogram is exactly zero —
  // true, and useless as a fixture. Momentum has to be changing for a momentum
  // indicator to say anything.
  const up = stamp(Array.from({ length: 200 }, (_, i) => {
    const o = 100 + i * i * 0.01, c = 100 + (i + 1) * (i + 1) * 0.01;
    return bar(o, Math.max(o, c) + 0.4, Math.min(o, c) - 0.4, c);
  }));
  const m = macdAt(up);
  check('an accelerating rally puts MACD above its signal line',
    m != null && m.hist > 0, m ? m.hist.toFixed(4) : 'null');
  check('"above signal" passes on it', checkMACD(up, { enabled: true, mode: 'above' }).pass);
  check('and "below signal" fails on it',
    checkMACD(up, { enabled: true, mode: 'below' }).pass === false);
  check('but "crossed up on THIS bar" does NOT pass',
    checkMACD(up, { enabled: true, mode: 'cross_up' }).pass === false,
    'it crossed two hundred bars ago; a state that lasts weeks is not a trigger');

  // A rally that turns over: the cross has to land on the bar it happens.
  const turn = stamp([...ramp(160, 100, 0.5), ...ramp(40, 180, -0.9)].map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c })));
  const mt = macdAt(turn);
  check('after a real turn the histogram is negative',
    mt != null && mt.hist < 0, mt ? mt.hist.toFixed(4) : 'null');
}

// ── ADX says how much, not which way ────────────────────────────────────────
{
  const trend = ramp(200, 100, 0.6);
  const a = adxAt(trend);
  check('a clean one-way ramp registers as a strong trend',
    a != null && a.adx > 25, a ? a.adx.toFixed(1) : 'null');
  check('with +DI above -DI',
    a != null && a.plusDI > a.minusDI,
    a ? `+DI ${a.plusDI.toFixed(0)} vs -DI ${a.minusDI.toFixed(0)}` : 'null');
  check('"trending" passes and "ranging" fails on it',
    checkADX(trend, { enabled: true, mode: 'strong', value: 25 }).pass
    && checkADX(trend, { enabled: true, mode: 'weak', value: 25 }).pass === false);
  check('"trending up" passes and "trending down" fails',
    checkADX(trend, { enabled: true, mode: 'bull' }).pass
    && checkADX(trend, { enabled: true, mode: 'bear' }).pass === false,
    'reading direction out of ADX itself is the usual mistake, so direction is its own mode');

  // A chop with no net direction should not read as a trend.
  const rnd = (() => { let x = 11; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const chop = stamp(Array.from({ length: 200 }, (_, i) => {
    const o = 100 + (i % 2 ? 1 : -1) + (rnd() - 0.5), c = 100 + (i % 2 ? -1 : 1) + (rnd() - 0.5);
    return bar(o, Math.max(o, c) + rnd(), Math.min(o, c) - rnd(), c);
  }));
  const ac = adxAt(chop);
  check('and a market going nowhere does not',
    ac != null && ac.adx < 25, ac ? ac.adx.toFixed(1) : 'null');

  // Identical bars are a separate case from a weak trend, and worth pinning:
  // with every high and every low the same there is no directional movement at
  // all, so DX is undefined. Null, and therefore a FAILING filter — the safe
  // direction, since the alternative is an ADX gate that passes a dead market.
  const frozen = stamp(Array.from({ length: 200 }, () => bar(99, 101.3, 98.7, 101)));
  check('a market with no directional movement at all leaves ADX undefined',
    adxAt(frozen) === null
    && checkADX(frozen, { enabled: true, mode: 'strong' }).pass === false,
    'undefined has to fail closed, or the gate passes a dead market');
}

// ── Stochastic uses highs and lows, not closes ──────────────────────────────
{
  // Closes pinned at the middle, but each bar has a wide range. A close-only
  // stochastic would read 50; a real one reads the close against the window's
  // true extremes, which here are set by the wicks.
  const cs = stamp(Array.from({ length: 60 }, () => bar(100, 110, 90, 100)));
  const s = stochasticAt(cs);
  check('%K measures the close against the window high and low',
    s != null && Math.abs(s.k - 50) < 0.01, s ? s.k.toFixed(2) : 'null');

  const low = stamp([...Array.from({ length: 40 }, () => bar(100, 110, 90, 100)),
                     ...Array.from({ length: 5 }, () => bar(92, 93, 90, 91))]);
  check('a close near the window low reads low',
    checkStochastic(low, { enabled: true, comparison: 'below', value: 20 }).pass);
  check('and the same bar fails an "above 80" filter',
    checkStochastic(low, { enabled: true, comparison: 'above', value: 80 }).pass === false);
}

// ── The candle filter, old vocabulary and new ───────────────────────────────
{
  const base = Array.from({ length: 20 }, () => bar(100, 101, 99, 100));
  const hammer = stamp([...base, bar(100, 100.6, 96, 100.5)]);
  const starBar = stamp([...base, bar(100.2, 105, 99.9, 100)]);

  check('the strict hammer passes its own filter',
    checkCandle(hammer, 'strong_hammer').pass);
  check('and fails the star filter, which is the point of separating them',
    checkCandle(hammer, 'strong_star').pass === false);
  check('"either" accepts both',
    checkCandle(hammer, 'strong_any').pass && checkCandle(starBar, 'strong_any').pass);
  check('a quiet market has no strong reversal at all',
    checkCandle(flat(60), 'strong_any').pass === false);
  check('and the reason names what the test actually is',
    /swept and reclaimed/.test(checkCandle(flat(60), 'strong_any').why),
    'a reader told only "no strong hammer" cannot tell why');

  // The four original options must behave exactly as before, or every saved
  // strategy silently changes meaning on deploy.
  const engulf = stamp([...base, bar(100, 100.2, 99, 99.2), bar(99, 101.2, 98.9, 101)]);
  check('the old "bullish" family still passes a bullish engulfing',
    checkCandle(engulf, 'bullish').pass);
  check('the old "bearish" family still rejects it',
    checkCandle(engulf, 'bearish').pass === false);
  check('graded selection is stricter than the family',
    checkCandle(engulf, 'bull_strong').pass
    && checkCandle(engulf, 'bull_weak').pass === false,
    'a weak harami used to pass exactly the filter a strong kicker passed');
  check('and a single named pattern is stricter still',
    checkCandle(engulf, 'bull_engulf').pass
    && checkCandle(engulf, 'morning_star').pass === false);
  check('an unknown filter name fails rather than passing',
    checkCandle(engulf, 'not_a_pattern').pass === false,
    'a typo in a config must not become "no filter"');
}

// ── The whole group, and the reason it reports ──────────────────────────────
{
  const cs = ramp(200, 100, 0.5);
  const r = checkIndicatorFilters(cs, {
    candlePattern: 'strong_hammer',
    adxFilter: { enabled: true, mode: 'strong', value: 25 },
  });
  check('one failing filter fails the group',
    r.pass === false);
  check('and the first failure is the one reported, not a wall of them',
    r.first?.name === 'candle' && typeof r.first.why === 'string');
  check('while the passing ones are still recorded',
    r.detail.adx === true && r.detail.candle === false);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

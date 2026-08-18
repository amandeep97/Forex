// A search that knows how long its rules hold for.
//
// The search optimised over scalps and swings together, and scalps tend to win
// that ranking — a rule that exits in a bar or two accumulates a tidier
// expectancy than one that sits through a fortnight's drawdown. If the trade
// you intend to place is a multi-day one, most of the old list was unusable.
import { deepSearch, POOL } from '../src/utils/deepSearch.js';
import { runBacktest, calcStats } from '../src/utils/backtestEngine.js';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const T0 = 1500000000000 - (1500000000000 % 86400e3);

// `plant` embeds an edge with a SHAPE, not just a sign: a long lower wick on a
// Tuesday is followed by twenty bars of upward drift. Twenty bars is the point
// — collecting it requires holding, so a search that only rewards quick exits
// cannot find it, and a finalist that does find it must have held for weeks.
function series(seed, n, stepMs, { plant = false } = {}) {
  let s = seed, p = 100;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  let drift = 0, driftLeft = 0;
  for (let i = 0; i < n; i++) {
    const t = T0 + i * stepMs;
    const o = p + (rnd() < 0.06 ? (rnd() < 0.5 ? 1 : -1) * (0.9 + rnd()) : 0);
    const c = o + (rnd() - 0.5) * 1.0 + drift;
    const longLowerWick = rnd() < 0.25;
    out.push({ t, o,
      h: Math.max(o, c) + rnd() * 0.4,
      l: Math.min(o, c) - (longLowerWick ? 2.2 + rnd() : rnd() * 0.4),
      c, v: 50 + rnd() * 120 });
    p = c;
    if (driftLeft > 0 && --driftLeft === 0) drift = 0;
    if (plant && new Date(t).getUTCDay() === 2 && longLowerWick) { drift = 0.22; driftLeft = 12; }
  }
  return out;
}

// ── The median holding period is measured ─────────────────────────────────
const daily = series(7, 1600, 86400e3, { plant: true });
const st = calcStats(runBacktest(daily, {
  conditions: [{ type:'rsi', period:14, op:'below', value:40 }],
  logic:'AND', direction:'both', exitType:'trail', trailAtr:3,
  slType:'atr', slAtr:2, riskPct:1, maxTrades:1,
}).trades);
check('holding period is reported as a median, not only a mean',
  st.medDuration != null && st.medDuration > 0, `${st.medDuration} bars (mean ${st.avgDuration})`);
check('an empty result still answers the question', calcStats([]).medDuration === 0);

// ── Swing mode drops the intraday-only vocabulary ─────────────────────────
const opts = { maxDepth: 3, beam: 4, keep: 4, calibrate: false, minTrades: 15 };
const any   = await deepSearch(daily, { ...opts });
const swing = await deepSearch(daily, { ...opts, horizon: 'swing' });

check('the "any" run still works unchanged', any.ok === true, any.reason);
check('swing mode removes the four session conditions',
  swing.poolSize === any.poolSize - 4, `${swing.poolSize} vs ${any.poolSize}`);
check('and no finalist can contain one', !swing.finalists?.some(f =>
  /killzone|London session|New York session|Asian session/.test(f.label)));
check('day-of-week and month-end survive — they are not intraday ideas',
  POOL.filter(p => p.fam === 'calendar' || p.fam === 'time').length > 4);

// ── The bar spacing is read from the data ─────────────────────────────────
check('daily bars are detected as daily', swing.barMs === 86400e3, String(swing.barMs));
check('so a two-day hold is two bars here', swing.minHoldBars === 2, String(swing.minHoldBars));
check('the horizon is reported back', swing.horizon === 'swing');
check('"any" mode reports no hold floor', any.minHoldBars === null);

// ── Every swing finalist actually held for the swing horizon ──────────────
// The planted edge takes twelve bars to pay, so this is not a vacuous list:
// if the search returns nothing, the assertions below are worthless and the
// count is checked first.
check('the planted multi-day edge is found', swing.ok && swing.finalists.length > 0,
  swing.ok ? `${swing.finalists.length} finalists` : swing.reason);
check('every finalist reports its holding period',
  swing.finalists?.every(f => f.hold?.bars > 0),
  swing.finalists?.map(f => f.hold?.bars).join(','));
check('and every one of them clears two days',
  swing.finalists?.every(f => f.hold.swingOk),
  swing.finalists?.map(f => `${f.hold?.days}d`).join(' '));
console.log(`         swing finalists held ${swing.finalists?.map(f => f.hold.days + 'd').join(', ')}`);
console.log(`         dropped for being too short: ${swing.droppedShort}`);

// ── The "any" run reports holds too, it just does not filter on them ──────
check('holding period is reported whichever horizon was asked for',
  any.finalists?.length > 0 && any.finalists.every(f => f.hold?.bars > 0));

// ── A faster series is told what it is asking for ─────────────────────────
// Two days of H4 bars is twelve bars. That is a real constraint, and the answer
// when nothing clears it has to say so rather than return an empty list.
const h4 = series(11, 1400, 14400e3);
const hSwing = await deepSearch(h4, { ...opts, horizon: 'swing' });
check('an H4 swing run knows a two-day hold is 12 bars',
  hSwing.minHoldBars === 12, String(hSwing.minHoldBars));
if (!hSwing.ok && hSwing.droppedShort) {
  check('and when nothing holds that long it says why, naming the number',
    /12 bars/.test(hSwing.reason) && /intraday rules/.test(hSwing.reason), hSwing.reason);
} else if (hSwing.ok) {
  check('anything it does return really held two days',
    hSwing.finalists.every(f => f.hold.swingOk),
    hSwing.finalists.map(f => `${f.hold?.days}d`).join(' '));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

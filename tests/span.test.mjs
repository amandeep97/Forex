import { searchStrategies, historySpanDays, describeSpan } from '../src/utils/strategySearch.js';

function series(n, stepMs) {
  let s = 42, p = 100;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = (rnd() - 0.5) * 2, o = p, c = p + d;
    out.push({ t: 1600000000000 + i * stepMs, o, h: Math.max(o,c)+rnd(), l: Math.min(o,c)-rnd(), c, v: 1000 });
    p = c;
  }
  return out;
}
const MIN = 60e3, DAY = 86400e3;

let fails = 0;
const check = (name, cond, extra='') => { console.log(`${cond?'  ok  ':'  FAIL'}  ${name}${extra?' — '+extra:''}`); if(!cond) fails++; };

// Exactly the user's case: 4999 one-minute bars.
const m1 = series(4999, MIN);
check('4999 M1 bars span ~3.5 days', Math.round(historySpanDays(m1)) === 3, `${historySpanDays(m1).toFixed(1)}d`);
const rM1 = await searchStrategies(m1);
check('M1/5000 is refused', rM1.ok === false);
check('refusal names the span', /days/.test(rM1.reason || ''), (rM1.reason||'').slice(0,60));
check('refusal is not the bar-count message', !/at least 400/.test(rM1.reason || ''));

// 15-minute, 5000 bars = 52 days. Still refused.
check('M15/5000 refused', (await searchStrategies(series(5000, 15*MIN))).ok === false);

// Hourly, 5000 bars = 208 days. Runs, but flagged thin.
const rH1 = await searchStrategies(series(5000, 60*MIN));
check('H1/5000 runs', rH1.ok === true, rH1.reason);
check('H1/5000 flagged thin', rH1.thinHistory === true);
check('H1/5000 reports months', /months/.test(rH1.span), rH1.span);

// Daily, 2600 bars = 7.1 years. Runs clean.
const rD = await searchStrategies(series(2600, DAY));
check('D/2600 runs', rD.ok === true, rD.reason);
check('D/2600 not flagged thin', rD.thinHistory === false, `${rD.span}`);
check('D/2600 reports years', /years/.test(rD.span), rD.span);

// The bar-count guard must still fire first for genuinely tiny sets.
const tiny = await searchStrategies(series(100, DAY));
check('100 bars still hits the bar guard', /at least 400/.test(tiny.reason || ''));

// Boundary: just under and just over six months of daily bars.
check('179 days refused', (await searchStrategies(series(500, 179*DAY/500))).ok === false);
check('181 days accepted', (await searchStrategies(series(500, 181*DAY/500))).ok === true);

check('describeSpan formats', describeSpan(3)==='3 days' && describeSpan(200)==='7 months' && describeSpan(1095)==='3.0 years',
      `${describeSpan(3)} / ${describeSpan(200)} / ${describeSpan(1095)}`);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

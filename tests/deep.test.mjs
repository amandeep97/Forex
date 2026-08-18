const ROOT = new URL('../', import.meta.url).pathname;
import { runBacktest, calcStats, computeExtremeSeries } from '../src/utils/backtestEngine.js';
import { deepSearch, POOL, describe, familiesOf } from '../src/utils/deepSearch.js';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const T0 = 1500000000000 - (1500000000000 % 3600e3);

// Hourly bars with occasional opening gaps and deliberate long wicks, so gap,
// session and wick conditions are all meaningful.
//
// `plant` embeds a real edge: a London-session bar with a long lower wick is
// followed by twenty bars of upward drift. Both conditions are common enough
// (37% and 25% of bars) that the combination fires a few hundred times — a
// planted edge rarer than minTrades cannot be found by any search, and
// asserting otherwise would only test the test.
function series(seed, n, { plant = false } = {}) {
  let s = seed, p = 100;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  let drift = 0, driftLeft = 0;
  for (let i = 0; i < n; i++) {
    const t = T0 + i * 3600e3;
    const hr = new Date(t).getUTCHours();
    const o = p + (rnd() < 0.06 ? (rnd() < 0.5 ? 1 : -1) * (0.9 + rnd()) : 0);
    const c = o + (rnd() - 0.5) * 1.0 + drift;
    const longLowerWick = rnd() < 0.25;
    const bar = { t, o,
      h: Math.max(o,c) + rnd()*0.4,
      l: Math.min(o,c) - (longLowerWick ? 2.2 + rnd() : rnd()*0.4),
      c, v: 50 + rnd()*120 };
    out.push(bar);
    p = c;
    if (driftLeft > 0 && --driftLeft === 0) drift = 0;
    if (plant && hr >= 7 && hr < 16 && longLowerWick) { drift = 0.22; driftLeft = 20; }
  }
  return out;
}

// bull_engulf needs a down bar followed by an up bar that swallows its body —
// a shape random walks with big wicks almost never produce. Checked on bars
// built for the purpose rather than asserted over noise.
function engulfingAt(i, n = 60) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const base = 100 + k * 0.01;
    out.push(k === i - 1 ? { t: T0 + k*3600e3, o: base + 1.0, h: base + 1.1, l: base - 0.1, c: base, v: 90 }
           : k === i     ? { t: T0 + k*3600e3, o: base - 0.1, h: base + 1.6, l: base - 0.2, c: base + 1.4, v: 90 }
           : { t: T0 + k*3600e3, o: base, h: base + 0.2, l: base - 0.2, c: base + 0.02, v: 90 });
  }
  return out;
}

const cs = series(5, 4000);
const run = cond => calcStats(runBacktest(cs, {
  conditions:[cond], logic:'AND', direction:'long', exitType:'rr', rrRatio:2,
  slType:'atr', slAtr:2, symbol:'XAU/USD' }).trades).totalTrades;

check('stretch fires',  run({ type:'stretch', period:50, op:'below', value:1.5 }) > 3);
check('breakout fires', run({ type:'breakout', op:'high', n:20 }) > 3);
check('gap fires',      run({ type:'gap', op:'up', value:0.5 }) > 3, `n=${run({type:'gap',op:'up',value:0.5})}`);
check('wick fires',     run({ type:'wick', op:'lower', value:0.5 }) > 3);

const ext = computeExtremeSeries(cs, 20);
check('extreme window excludes the current bar', (() => {
  for (let i = 20; i < cs.length; i++) {
    let hi = -Infinity; for (let j = i-20; j < i; j++) hi = Math.max(hi, cs[j].c);
    if (Math.abs(ext[i].hi - hi) > 1e-9) return false;
  }
  return true;
})());

const dirN = d => calcStats(runBacktest(cs, { conditions:[{type:'stretch',period:50,op:'above',value:2}],
  logic:'AND', direction:d, exitType:'rr', rrRatio:2, slType:'atr', slAtr:2, symbol:'XAU/USD' }).trades).totalTrades;
check('stretch mirrors for shorts', dirN('long') > 0 && dirN('short') > 0 && dirN('long') !== dirN('short'),
  `long=${dirN('long')} short=${dirN('short')}`);

check('pool has no duplicate ids', new Set(POOL.map(p=>p.id)).size === POOL.length);
// Cross-asset conditions are added per run, so the static pool carries nine.
check('pool spans 9 static families', new Set(POOL.map(p=>p.fam)).size === 9,
  [...new Set(POOL.map(p=>p.fam))].join(','));
check('pool is much bigger than the preset search', POOL.length >= 40, `${POOL.length} conditions`);

const dead = POOL.filter(p => calcStats(runBacktest(cs, { conditions:[p.cond], logic:'AND',
  direction:'both', exitType:'rr', rrRatio:2, slType:'atr', slAtr:2, symbol:'XAU/USD' }).trades).totalTrades === 0);
// This slice starts in July and runs 166 days, so Q1 never occurs in it and
// `onesided`/`engulf` are shapes a random walk rarely produces. All three are
// properties of the test data, and the search excludes non-firing conditions
// by design — which is the behaviour asserted below.
check('few pooled conditions are dead on this noise', dead.length <= 3, dead.map(d=>d.id).join(', ') || 'all fire');

// The one that noise cannot produce is checked directly.
const { patternsAt } = await import(`${ROOT}src/utils/candlePatterns.js`);
check('bull_engulf is detected when it exists', patternsAt(engulfingAt(40), 40).includes('bull_engulf'),
  patternsAt(engulfingAt(40), 40).join(',') || 'nothing detected');
check('and not on the bars around it', !patternsAt(engulfingAt(40), 38).includes('bull_engulf'));

// ── Refusals ───────────────────────────────────────────────────────────────
check('refuses too few bars', (await deepSearch(series(9, 300))).ok === false);
// 400 hourly bars is 16 days — enough bars, nowhere near enough history.
const shortSpan = await deepSearch(series(9, 900));
check('refuses a short history', shortSpan.ok === false && /days/.test(shortSpan.reason), shortSpan.reason?.slice(0,50));

// ── Can it recover a planted edge? ─────────────────────────────────────────
const good = series(11, 22000, { plant: true });  // 22,000 hourly bars ≈ 2.5 years
const res = await deepSearch(good, { minTrades: 15, beam: 8, maxDepth: 4, keep: 8 });
check('search completes', res.ok === true, res.reason);
check('evaluated far more than 540 strategies', res.evaluated > 540, `${res.evaluated}`);
check('touched the holdout only a handful of times', res.holdoutLooks <= 8, `${res.holdoutLooks} looks`);
check('produced finalists', res.finalists.length > 0, `${res.finalists.length}`);
check('found combinations deeper than two', Math.max(...res.finalists.map(f=>f.depth)) >= 3,
  `depths ${res.finalists.map(f=>f.depth).join(',')}`);
// The planted drift lasts twenty bars, so several different rules can capture
// it. What matters is that the search finds SOMETHING that beats random
// entries on the untouched slice — and that on noise, it does not.
check('planted data yields a rule that beats random',
  res.finalists.some(f => f.significance?.beatsRandom),
  res.finalists.map(f => `${f.verdict}:${f.significance?.edgeOverRandom ?? '-'}`).join(' '));
check('cross-family combinations found', res.finalists.some(f => familiesOf(f.ids).length >= 3),
  `max families = ${Math.max(...res.finalists.map(f => familiesOf(f.ids).length))}`);
check('a finalist survived the holdout', res.finalists.some(f => f.verdict === 'survived'),
  res.finalists.map(f=>f.verdict).join(','));

// ── Structural guarantees ──────────────────────────────────────────────────
check('slices partition the history',
  res.buildBars + res.validateBars + res.holdoutBars === good.length);
check('no family appears more than twice', res.finalists.every(f => {
  const c = {}; for (const id of f.ids) { const fam = POOL.find(p=>p.id===id).fam; c[fam]=(c[fam]||0)+1; }
  return Object.values(c).every(v => v <= 2);
}));
// Significance is only claimed above the holdout minimum; below it the
// verdict says so instead. Either is fine — silence with a verdict is not.
check('significance is present exactly when the sample allows it',
  res.finalists.every(f => f.significance ? f.holdout.n >= res.minHoldout
                                          : (f.verdict === 'untested' || f.rare || f.holdout.n < res.minHoldout)),
  res.finalists.map(f=>`${f.verdict}:n=${f.holdout?.n}:${f.significance?'sig':'-'}`).join(' '));
const f0 = res.finalists[0];
check('finalist strategy reproduces its holdout',
  calcStats(runBacktest(good.slice(-res.holdoutBars), f0.strategy).trades).totalTrades === f0.holdout.n);

// A search on pure noise must NOT confidently report survivors.
const noise = await deepSearch(series(77, 22000), { minTrades: 15, beam: 8, maxDepth: 4, keep: 8 });
// KNOWN LIMITATION, pinned deliberately.
//
// Neither the zero test nor the random-entry test brings the false-positive
// rate anywhere near 5%. Measured across five pure random walks: 38% cleared
// zero, 49% beat random entries. The UI says "about 40%" and that claim has to
// stay true, so this asserts the failure rather than pretending otherwise. If
// a future change genuinely fixes it, this test fails and forces the UI text
// to be corrected — which is the point.
const noiseSig  = noise.ok ? noise.finalists.filter(f => f.significance?.beatsRandom).length : 0;
const noiseZero = noise.ok ? noise.finalists.filter(f => f.significance?.clearsZero).length : 0;
const nF = noise.finalists?.length || 0;
check('KNOWN: significance tests still pass noise often', noiseSig >= 2,
  `${noiseSig}/${nF} beat random, ${noiseZero}/${nF} cleared zero — the UI warning must keep saying so`);
check('the null calibration is reported', noise.nullRun?.bestExpR != null,
  `shuffled best ${noise.nullRun?.bestExpR}R`);
check('null calibration uses more than one draw', (noise.nullRun?.draws || 0) >= 2,
  `${noise.nullRun?.draws} draws`);

console.log(`\n  planted-edge top: ${f0.label}`);
console.log(`                    families: ${f0.families.join(', ')} · holdout ${f0.holdout.expR}R n=${f0.holdout.n} · ${f0.verdict}`);
if (res.neverFires.length) console.log(`  never fired: ${res.neverFires.join(', ')}`);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

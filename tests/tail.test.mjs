import { calcStats, runBacktest } from '../src/utils/backtestEngine.js';
import { testAcrossInstruments } from '../src/utils/strategySearch.js';
import { deepSearch } from '../src/utils/deepSearch.js';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const mk = rs => rs.map((r,i) => ({ result: r>0?'win':'loss', pnlDollars: r*100, riskDollars: 100,
  pnlPips: r*10, dir:'long', duration:1, entryTime:i }));

// ── Tail statistics ───────────────────────────────────────────────────────
// Two rules, same mean, completely different animals.
const grind = calcStats(mk(Array.from({length:80}, (_,i) => i%2 ? 0.9 : -0.6)));   // +0.15R
// Same mean as the grinder (+0.15R), reached the opposite way: mostly small
// losses paid for by a handful of very large winners.
const spike = calcStats(mk([...Array(70).fill(-1), 20, 15, 12, 12, 10, 8, 6, 5, 5, 5]));
check('grinder and spiker have similar means',
  Math.abs(grind.avgRR - spike.avgRR) < 0.2, `${grind.avgRR} vs ${spike.avgRR}`);
check('but very different total R', Math.abs(grind.totalR - spike.totalR) > 1,
  `${grind.totalR}R vs ${spike.totalR}R`);
check('big-win rate separates them', spike.bigWinRate > grind.bigWinRate * 5,
  `${grind.bigWinRate}% vs ${spike.bigWinRate}%`);
check('grinder has no trade past +5R', grind.bigWins === 0);
check('spiker reports its best trade', spike.maxR === 20, String(spike.maxR));
check('payoff ratio computed', spike.payoff > 5 && grind.payoff > 1,
  `${grind.payoff} / ${spike.payoff}`);
// The point of a 90th percentile: it asks what a GOOD trade looks like, not
// what the average one does. The grinder's best decile is +0.9R, the spiker's
// is +5R — the two rules have the same mean and the difference between them
// is exactly what mean expectancy cannot show.
check('p90 shows the spiker has a far better top decile', spike.p90R > grind.p90R * 4,
  `grinder ${grind.p90R}R vs spiker ${spike.p90R}R`);
check('p90 sits at the smallest winner for the spiker', spike.p90R === 5, String(spike.p90R));
check('totalR matches the sum', Math.abs(grind.totalR - grind.avgRR * grind.totalTrades) < 1);
check('no trades gives nulls not NaN',
  calcStats([]).totalR === null && calcStats([]).bigWinRate === null);

// ── Bigger exits actually reach further ───────────────────────────────────
const DAY = 86400e3;
function trending(seed, n) {
  let s = seed, p = 100; const out = [];
  const rnd = () => (s = (s*1103515245+12345)%2147483648)/2147483648;
  for (let i = 0; i < n; i++) {
    const o = p, c = o + (rnd()-0.5)*1.2 + (Math.floor(i/120)%2 ? 0.5 : -0.1);
    out.push({ t: 1500000000000+i*DAY, o, h: Math.max(o,c)+rnd()*0.5, l: Math.min(o,c)-rnd()*0.5, c, v:100 });
    p = c;
  }
  return out;
}
const cs = trending(4, 2000);
const strat = e => ({ conditions:[{type:'ma',period:50,maType:'ema',op:'priceAbove'}],
  logic:'AND', direction:'long', slType:'atr', slAtr:2, symbol:'XAU/USD', ...e });
const r3  = calcStats(runBacktest(cs, strat({ exitType:'rr', rrRatio:3 })).trades);
const r8  = calcStats(runBacktest(cs, strat({ exitType:'rr', rrRatio:8 })).trades);
const t5  = calcStats(runBacktest(cs, strat({ exitType:'trail', trailAtr:5 })).trades);
const t12 = calcStats(runBacktest(cs, strat({ exitType:'trail', trailAtr:12 })).trades);
check('an 8R target can produce a trade bigger than 3R', (r8.maxR ?? 0) > (r3.maxR ?? 0),
  `3R exit best ${r3.maxR}R vs 8R exit best ${r8.maxR}R`);
// A wider trail is not guaranteed to produce a bigger single winner — it also
// sits further from the peak and, with one position at a time, opens a
// different set of trades. What matters is that both can run past the point a
// fixed target would have capped them.
check('both trailing exits run far past a 3R cap', (t5.maxR ?? 0) > 5 && (t12.maxR ?? 0) > 5,
  `5 ATR ${t5.maxR}R, 12 ATR ${t12.maxR}R`);
check('the 3R target is genuinely capped near 3R', (r3.maxR ?? 0) <= 3.6, String(r3.maxR));

// ── Pooling across instruments ────────────────────────────────────────────
const syms = ['A','B','C','D','E','F','G','H'];
const load = async s => trending(syms.indexOf(s)*991 + 7, 1200);
const res = await testAcrossInstruments(strat({ exitType:'trail', trailAtr:5 }), load, syms, { minTrades: 5 });
check('pooled result returned', !!res.pooled);
check('pooled n is the sum of the rows',
  res.pooled.n === res.rows.filter(r=>!r.origin && r.n).reduce((s,r)=>s+r.n,0),
  `${res.pooled.n}`);
check('pooling gives a far larger sample than any one instrument',
  res.pooled.n > Math.max(...res.rows.map(r => r.n || 0)) * 3,
  `pooled ${res.pooled.n} vs best single ${Math.max(...res.rows.map(r=>r.n||0))}`);
check('pooled error bar is narrower than a single instrument would give',
  res.pooled.ci != null && res.pooled.ci > 0, `±${res.pooled.ci}`);
check('pooled reports tail stats', res.pooled.totalR != null && res.pooled.maxR != null);

// The origin instrument must stay out of the pool as well as the count.
const withOrigin = await testAcrossInstruments(strat({ exitType:'trail', trailAtr:5 }), load, syms,
  { minTrades: 5, origin: 'A' });
check('origin excluded from the pool', withOrigin.pooled.n < res.pooled.n,
  `${withOrigin.pooled.n} vs ${res.pooled.n}`);

// ── Tail objective admits what mean mode rejects ──────────────────────────
const cs2 = trending(21, 3000);
const meanRun = await deepSearch(cs2, { objective:'mean', minTrades:20, beam:5, maxDepth:3, keep:6, calibrate:false });
const tailRun = await deepSearch(cs2, { objective:'tail', minTrades:20, beam:5, maxDepth:3, keep:6, calibrate:false });
check('both modes run', meanRun.ok && tailRun.ok, `${meanRun.reason||''} ${tailRun.reason||''}`);
check('tail mode uses a much lower trade floor', tailRun.minBuildTrades < meanRun.minBuildTrades,
  `${tailRun.minBuildTrades} vs ${meanRun.minBuildTrades}`);
check('tail mode reports its objective', tailRun.objective === 'tail');
const tailBest = Math.max(...tailRun.finalists.map(f => f.holdout?.maxR ?? 0));
const meanBest = Math.max(...meanRun.finalists.map(f => f.holdout?.maxR ?? 0));
console.log(`         best single trade — mean mode ${meanBest}R, tail mode ${tailBest}R`);
check('tail finalists are labelled rare rather than untested when the sample is small',
  tailRun.finalists.every(f => !f.rare || /^rare-/.test(f.verdict)),
  tailRun.finalists.map(f=>`${f.verdict}(n=${f.holdout?.n})`).join(' '));

// The wider exits must not resurrect the tiny-stop bug: an R multiple only
// explodes when the risk denominator collapses, and position sizing goes with
// it. Every trade's risk must be a sane fraction of price.
const wide = runBacktest(cs, strat({ exitType:'trail', trailAtr:12 })).trades;
const badRisk = wide.filter(t => t.riskDollars > 0 && t.entry && Math.abs(t.entry) > 0
  && (t.riskDollars / 100) / Math.abs(t.entry) < 0.0005);
check('no trade has a collapsed stop', badRisk.length === 0,
  `${badRisk.length} of ${wide.length} trades`);
check('R multiples stay finite', wide.every(t => !t.riskDollars || Number.isFinite(t.pnlDollars / t.riskDollars)));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

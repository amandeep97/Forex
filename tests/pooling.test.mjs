// Sample size, and saying "we do not know" when that is the answer.
//
// A live feed carried 707 records with a median sample of 22 and a median win
// rate of 50%. The screen reported those as findings — fifteen cards at once
// reading THE RECORD SAYS NO off numbers indistinguishable from a coin flip.
import { pooledRecords, winInterval, winCI, tellsUsSomething, rank, assess,
         zFor, verdictOf, MIN_EDGE_ATR } from '../src/utils/confluence.js';
import { buildPlan } from '../src/utils/tradePlan.js';
import { readFileSync } from 'fs';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const NOW = 1786500000000;

// ── The interval ──────────────────────────────────────────────────────────
// Wald on gold's record gives 0-46%, which excludes a coin flip and licenses
// the screen to call the setup broken on thirteen observations.
const gold = winInterval(23, 13);
check('a 13-sample record does not exclude a coin flip', gold.hi >= 50, `23% over 13 → ${gold.lo}-${gold.hi}%`);
check('and so it is not allowed to say anything', !tellsUsSomething({ win: 23, n: 13 }));
check('the same rate over a real sample does say something',
  tellsUsSomething({ win: 23, n: 300 }), JSON.stringify(winInterval(23, 300)));
check('an interval narrows as the square root of n',
  winCI(50, 100) > winCI(50, 400) && winCI(50, 400) > winCI(50, 1600),
  `${winCI(50,100)} → ${winCI(50,400)} → ${winCI(50,1600)}`);
check('a coin flip on any sample says nothing', !tellsUsSomething({ win: 50, n: 100000 }));
check('degenerate input is safe', winInterval(null, 0) === null && !tellsUsSomething(null));

// ── Pooling ───────────────────────────────────────────────────────────────
const feed = JSON.parse(readFileSync(process.argv[2] || '/tmp/feed-live.json', 'utf8'));
const now = Date.parse(feed.updatedAt);
const pools = pooledRecords(feed);
const works = [], failsSig = [], silent = [];
for (const [k, v] of Object.entries(pools)) {
  const iv = winInterval(v.win, v.n);
  if (iv.lo > 50 && v.med > 0) works.push([k, v]);
  else if (iv.hi < 50) failsSig.push([k, v]);
  else silent.push(k);
}
console.log(`         ${Object.keys(pools).length} pooled setups → ${works.length} work, ${failsSig.length} fail, ${silent.length} say nothing`);
for (const [k, v] of works) console.log(`           WORKS  ${k}  ${v.win}% n=${v.n} med ${v.med}`);

check('pooling produces samples an instrument alone cannot',
  Object.values(pools).some(p => p.n > 200), `largest pool n=${Math.max(...Object.values(pools).map(p => p.n))}`);
check('a pool is never built from fewer than three instruments',
  Object.values(pools).every(p => p.syms >= 3));
check('every pool carries its own interval', Object.values(pools).every(p => p.ci > 0));
check('most setups still say nothing, which is the honest outcome',
  silent.length > works.length, `${silent.length} silent vs ${works.length} working`);
check('and the ones that do say something are not all one direction',
  works.length > 0 && failsSig.length > 0, `${works.length} work · ${failsSig.length} fail`);

// ── The pool rescues a record too thin to price ───────────────────────────
const rec = (rarity) => ({ cls:'fx', name:'X', price:100, dec:2,
  state:{ D:{ atrPct:2, volPct:50, rangePos:50 }, spreadAbs:0.01, spreadRatio:1 },
  events:[{ type:'sweep', dir:'up', at:NOW, tf:'D', detail:'swept the 5-bar low' }],
  rarity, patterns:{}, asOf:{ D: NOW } });

// Six occurrences at 67% is meaningless on its own.
const thinOnly = { 'sweep.D': { perMonth:0.7, n:6, fwdBars:10, fwdN:6, fwdWin:67, fwdMedAtr:1.5 } };
const aThin = assess('T', rec(thinOnly), { now: NOW });
const pThin = buildPlan(aThin, rec(thinOnly), { now: NOW });
check('six occurrences cannot price a trade on their own',
  pThin.verdict === 'inconclusive', pThin.verdict);
check('and the reason given is the interval, not a made-up rule',
  /coin flip/.test(pThin.note), pThin.note?.slice(0, 60));

// Same instrument, same thin record, with a real pool behind it.
const pooled = { 'fx|sweep.D': { n: 600, win: 58, med: 1.4, bars: 10, syms: 20, ci: winCI(58, 600), pooled: true } };
const aPooled = assess('P', rec(thinOnly), { now: NOW, pools: pooled });
const pPooled = buildPlan(aPooled, rec(thinOnly), { now: NOW });
check('a real pool behind it makes the same setup priceable',
  pPooled.verdict === 'priced', pPooled.verdict);
check('and the card says the price came from the class, not the instrument',
  /instruments/.test(pPooled.pricedFrom || ''), pPooled.pricedFrom);
check('the target uses the pooled median', pPooled.target === 102.8, String(pPooled.target));

// A pool that is itself a coin flip rescues nothing.
const flat = { 'fx|sweep.D': { n: 600, win: 50, med: 1.4, bars: 10, syms: 20, ci: winCI(50, 600), pooled: true } };
const pFlat = buildPlan(assess('F', rec(thinOnly), { now: NOW, pools: flat }), rec(thinOnly), { now: NOW });
check('a pool that is itself a coin flip rescues nothing',
  pFlat.verdict === 'inconclusive', pFlat.verdict);

// A pool that significantly fails still refuses, and says so with its size.
const bad = { 'fx|sweep.D': { n: 600, win: 42, med: -0.4, bars: 10, syms: 20, ci: winCI(42, 600), pooled: true } };
const pBad = buildPlan(assess('B', rec(thinOnly), { now: NOW, pools: bad }), rec(thinOnly), { now: NOW });
check('a pool that significantly fails refuses the trade',
  pBad.verdict === 'record-says-no', pBad.verdict);
check('and names how many instruments say so', /20 fx instruments/.test(pBad.note), pBad.note?.slice(0, 70));

// ── Positioning is alive ──────────────────────────────────────────────────
const ranked = rank(feed, { now, minBreadth: 1 });
const withPosn = ranked.filter(a => a.families.includes('positioning'));
console.log(`         positioning appears on ${withPosn.length} cards: ${withPosn.map(a => a.sym).join(' ')}`);
check('the positioning family finally reaches a card', withPosn.length > 0);
check('only at a genuine extreme',
  withPosn.every(a => {
    const p = feed.instruments[a.sym].state.posnPct;
    return p <= 10 || p >= 90;
  }));
check('and it does not vote on direction, because that cannot be measured here',
  ranked.every(a => a.evidence.filter(e => e.family === 'positioning').every(e => e.dir === null)));
check('it counts toward breadth, which is the point of it being independent',
  withPosn.every(a => a.families.length >= 2));

// ── Testing ninety-one things at once ─────────────────────────────────────
// A 95% interval is a statement about ONE question. The panel asks every
// pooled setup at once and keeps the winners, which is a search, and an
// uncorrected search over ninety-one hypotheses hands back four or five
// findings that are nothing at all.
check('one test keeps the ordinary threshold', zFor(1) === 1.96 && zFor(0) === 1.96);
check('ninety-one tests raise it to about three and a half sigma',
  zFor(91) > 3.4 && zFor(91) < 3.6, zFor(91).toFixed(2));
check('the bar rises with the number of things asked',
  zFor(5) < zFor(50) && zFor(50) < zFor(500),
  `${zFor(5).toFixed(2)} → ${zFor(50).toFixed(2)} → ${zFor(500).toFixed(2)}`);
check('and a corrected interval is strictly wider',
  winInterval(60, 200, 91).lo < winInterval(60, 200).lo, 
  `${winInterval(60,200,91).lo} vs ${winInterval(60,200).lo}`);

// A record that clears one test and not ninety-one.
const marginal = { win: 55, n: 420, med: 0.58 };
check('a marginal setup survives on its own', verdictOf(marginal, 1) === 'works');
check('and does not survive being one of ninety-one',
  verdictOf(marginal, 91) !== 'works', verdictOf(marginal, 91));

// ── Significant and worthless are different things ────────────────────────
// FX tweezer bottoms on M15: 52% over 2,563 samples, median +0.02 ATR. Real,
// and gone the moment the spread is paid.
const trivial = { win: 52, n: 2563, med: 0.02 };
check('a huge sample makes a trivial edge significant',
  winInterval(trivial.win, trivial.n).lo > 50, JSON.stringify(winInterval(52, 2563)));
check('but significance alone does not make it worth taking',
  verdictOf(trivial, 1) === 'tiny', verdictOf(trivial, 1));
check('the same edge at a tradeable size does count',
  verdictOf({ ...trivial, med: MIN_EDGE_ATR }, 1) === 'works');

// ── On the live board, after correction ───────────────────────────────────
const tests = Object.keys(pools).length;
const after = { works: [], fails: [], tiny: 0, silent: 0 };
for (const [k, v] of Object.entries(pools)) {
  const d = verdictOf(v, tests);
  if (d === 'works') after.works.push([k, v]);
  else if (d === 'fails') after.fails.push([k, v]);
  else if (d === 'tiny') after.tiny++;
  else after.silent++;
}
console.log(`         after correction (${tests} tests, z=${zFor(tests).toFixed(2)}): ${after.works.length} work, ${after.fails.length} fail, ${after.tiny} too small, ${after.silent} silent`);
for (const [k, v] of after.works) console.log(`           ${k}  ${v.win}% n=${v.n} med +${v.med}`);
check('correction removes findings rather than adding them',
  after.works.length <= works.length, `${works.length} → ${after.works.length}`);
check('every surviving setup clears the tradeable-size floor',
  after.works.every(([, v]) => v.med >= MIN_EDGE_ATR));
check('and every one clears the corrected interval',
  after.works.every(([, v]) => winInterval(v.win, v.n, tests).lo > 50));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

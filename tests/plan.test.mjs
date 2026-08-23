import { buildPlan, verdictLine } from '../src/utils/tradePlan.js';
import { assess, rank } from '../src/utils/confluence.js';
import { readFileSync } from 'fs';
import { loadFeed } from './feed-fixture.mjs';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const NOW = 1786500000000;

const rec = (o={}) => ({ cls:'fx', name:'X', price:100, dec:2,
  state:{ D:{ atrPct: 2, volPct:50, rangePos:50 }, spreadAbs: 0.05, spreadRatio: 1 },
  events:[], rarity:{}, patterns:{}, asOf:{ D: NOW }, ...o });

const sweep = (extra={}) => rec({
  events:[{ type:'sweep', dir:'up', at:NOW, tf:'D', detail:'swept the 5-bar low' }],
  rarity:{ 'sweep.D': { perMonth:0.7, n:14, fwdBars:10, ...extra } },
  ...(extra.recOverride || {}),
});

// ── A setup the record supports ───────────────────────────────────────────
const good = sweep({ fwdN:200, fwdWin:65, fwdMedAtr:1.8 });
const pGood = buildPlan(assess('G', good, { now: NOW }), good, { balance: 10000, riskPct: 1 });
check('a supported setup is priced', pGood.verdict === 'priced', pGood.verdict);
check('entry is the current price', pGood.entry === 100);
check('stop is 1.5 ATR below for a long', pGood.stop === 97, String(pGood.stop));
check('target comes from the RECORD, not a chosen ratio',
  pGood.target === 103.6, `${pGood.target} = 1.8 ATR, the measured median`);
check('reward:risk falls out of the data', pGood.rr === 1.2, String(pGood.rr));
check('expectancy uses the measured win rate',
  pGood.ev === +(0.65*1.2 - 0.35).toFixed(2), String(pGood.ev));
check('size is given only when the trade is worth taking', pGood.units > 0);
check('size risks exactly the configured amount',
  Math.abs(pGood.units * pGood.stopDist - 100) < pGood.stopDist, `${pGood.units} units × ${pGood.stopDist}`);
check('it says take', pGood.take === true);

// ── The gold case: thirteen observations decide nothing ───────────────────
// This used to read THE RECORD SAYS NO off 23% over 13 — a Wald interval of
// 0-46% that excludes a coin flip only because the approximation is unreliable
// at small n and extreme p. Wilson puts the same record at 8-50%.
const bad = sweep({ fwdN:13, fwdWin:23, fwdMedAtr:-1.4 });
const pBad = buildPlan(assess('B', bad, { now: NOW }), bad);
check('thirteen observations cannot establish that a setup fails',
  pBad.verdict === 'inconclusive', pBad.verdict);

// The same rate on a sample that can decide.
const reallyBad = sweep({ fwdN:300, fwdWin:23, fwdMedAtr:-1.4 });
const pReallyBad = buildPlan(assess('RB', reallyBad, { now: NOW }), reallyBad);
check('a contradicted setup on a real sample is refused',
  pReallyBad.verdict === 'record-says-no', pReallyBad.verdict);
check('and no target is drawn', pBad.target === undefined && pReallyBad.target === undefined);
check('and no position size is offered', pBad.units === undefined,
  'printing a size next to a setup the record rejects is an invitation');
check('and it says do not take', pBad.take === false);
check('the thin case names the sample and the interval, not a verdict',
  /13 occurrences/.test(pBad.note) && /coin flip/.test(pBad.note), pBad.note);
check('the real refusal names the sample and the median',
  /300 times/.test(pReallyBad.note) && /-1.4 ATR/.test(pReallyBad.note), pReallyBad.note);

// ── Positive median but negative expectancy ───────────────────────────────
const weak = sweep({ fwdN:30, fwdWin:30, fwdMedAtr:1.0 });
const pWeak = buildPlan(assess('W', weak, { now: NOW }), weak);
check('a positive median can still be a negative edge', pWeak.verdict === 'negative', pWeak.verdict);
check('  → because 30% at 0.67R loses', pWeak.ev < 0, String(pWeak.ev));
check('  → and no size is offered', pWeak.units === undefined);

// ── Thin records are not priced ───────────────────────────────────────────
const thin = sweep({ fwdN:6, fwdWin:83, fwdMedAtr:2.5 });
const pThin = buildPlan(assess('T', thin, { now: NOW }), thin);
check('a six-sample record decides nothing', pThin.verdict === 'inconclusive', pThin.verdict);
check('however good it looks', pThin.take === false, '83% over six is not a finding');

// ── Cost and conditions override the setup ────────────────────────────────
const wide = sweep({ fwdN:20, fwdWin:65, fwdMedAtr:1.8,
  recOverride:{ state:{ D:{ atrPct:2 }, spreadAbs: 0.05, spreadRatio: 2.4 } } });
const pWide = buildPlan(assess('S', wide, { now: NOW }), wide);
check('an abnormal spread blocks a good setup', !!pWide.blocked && pWide.take === false, pWide.blocked);

const costly = sweep({ fwdN:20, fwdWin:65, fwdMedAtr:1.8,
  recOverride:{ state:{ D:{ atrPct:2 }, spreadAbs: 0.5, spreadRatio: 1 } } });
const pCost = buildPlan(assess('C', costly, { now: NOW }), costly);
check('cost as a share of the stop is computed', pCost.costShare > 15, `${pCost.costShare}%`);
check('and too much cost blocks the trade', !!pCost.blocked && pCost.take === false, pCost.blocked);

// ── Shorts mirror ─────────────────────────────────────────────────────────
const short = rec({
  events:[{ type:'sweep', dir:'down', at:NOW, tf:'D', detail:'swept the 5-bar high' }],
  rarity:{ 'sweep.D': { perMonth:0.7, n:14, fwdBars:10, fwdN:200, fwdWin:65, fwdMedAtr:1.8 } } });
const pShort = buildPlan(assess('SH', short, { now: NOW }), short);
check('a short stops above and targets below',
  pShort.stop === 103 && pShort.target === 96.4, `${pShort.stop} / ${pShort.target}`);

// ── Degenerate inputs ─────────────────────────────────────────────────────
check('no volatility yet is refused, not guessed',
  buildPlan(assess('N', sweep({fwdN:200,fwdWin:65,fwdMedAtr:1.8}), {now:NOW}),
    { ...sweep({fwdN:200}), state:{} }).ok === false);
check('null inputs are safe', buildPlan(null, null) === null);

// ── Against the live feed ─────────────────────────────────────────────────
const feed = loadFeed();
const now = Date.parse(feed.updatedAt);
const ranked = rank(feed, { now, minBreadth: 2 });
const plans = ranked.map(a => buildPlan(a, feed.instruments[a.sym])).filter(Boolean);
const takeable = plans.filter(p => p.take);
const byVerdict = {};
for (const p of plans) byVerdict[p.verdict] = (byVerdict[p.verdict] || 0) + 1;
console.log(`         ${plans.length} plans → ${JSON.stringify(byVerdict)}`);
console.log(`         ${takeable.length} worth taking`);
check('every plan reaches a verdict', plans.every(p => p.verdict));
check('every takeable plan has entry, stop, target and size',
  takeable.every(p => p.entry && p.stop && p.target && p.units > 0));
check('no takeable plan has a negative expectancy', takeable.every(p => p.ev > 0));
check('no takeable plan is blocked', takeable.every(p => !p.blocked));
check('the screen refuses far more than it offers', takeable.length < plans.length / 2,
  `${takeable.length} of ${plans.length}`);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

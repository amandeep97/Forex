// The cards judged against a coin flip while the panel judged against the
// market, and I fixed one and not the other.
//
// US500 rose on 65% of days. A bearish signal there is benchmarked at 35%, not
// 50% — so a setup winning 37% had beaten its benchmark, and the card printed
// THE RECORD SAYS NO in red. Every bearish card on a rising instrument read
// that way, and the error was one-directional: bullish cards looked better than
// they were by exactly the same amount.
const ROOT = new URL('../', import.meta.url).pathname;
import { assess, mirroredBaseline, tellsUsSomething } from '../src/utils/confluence.js';
import { buildPlan } from '../src/utils/tradePlan.js';
import { readFileSync } from 'fs';
import { loadFeed } from './feed-fixture.mjs';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const NOW = 1786500000000;

// ── The baseline is mirrored by direction ─────────────────────────────────
const rec = { baseline: { D: { n: 374, win: 65, medAtr: 0.6, bars: 10 } } };
check('a bullish event is benchmarked against the market as published',
  mirroredBaseline(rec, 'D', 'up').baseWin === 65);
check('a bearish event against its mirror, not against 50',
  mirroredBaseline(rec, 'D', 'down').baseWin === 35);
check('and the median mirrors too',
  mirroredBaseline(rec, 'D', 'down').baseMed === -0.6);
check('no baseline yields nothing rather than a default',
  Object.keys(mirroredBaseline({}, 'D', 'up')).length === 0);

// ── A record is judged against its benchmark ──────────────────────────────
check('37% against a 35% market says nothing on 70 samples',
  !tellsUsSomething({ win: 37, n: 70, baseWin: 35, baseN: 374 }));
check('37% against a 50% market DOES say something',
  tellsUsSomething({ win: 37, n: 70, baseWin: 50, baseN: 20000 }),
  'which is why the old comparison called it broken');
check('a big edge on a real sample still registers',
  tellsUsSomething({ win: 60, n: 400, baseWin: 45, baseN: 4000 }));
check('with no baseline it falls back to a coin flip rather than going silent',
  tellsUsSomething({ win: 30, n: 400 }));

// ── The US500 case, end to end ────────────────────────────────────────────
const us500 = {
  cls:'index', name:'US500', price:7738, dec:1,
  state:{ D:{ atrPct:1.1, volPct:50, rangePos:60 }, spreadAbs:0.5, spreadRatio:1 },
  events:[{ type:'sweep', dir:'down', at:NOW, tf:'D', detail:'swept the 5-bar high' }],
  rarity:{ 'sweep.D': { perMonth:3.9, n:72, fwdBars:10, fwdN:70, fwdWin:37, fwdMedAtr:-0.31 } },
  baseline:{ D: { n:374, win:65, medAtr:0.61, bars:10 } },
  patterns:{}, asOf:{ D: NOW },
};
const p = buildPlan(assess('US500', us500, { now: NOW }), us500, { now: NOW });
check('the card no longer says the setup has not worked',
  p.verdict !== 'record-says-no', p.verdict);
check('it says the record cannot separate it from the market',
  p.verdict === 'inconclusive' && /market itself/.test(p.note), p.note?.slice(0, 70));
check('and the benchmark is shown so the refusal can be checked',
  p.marketWin === 35, String(p.marketWin));

// A setup that genuinely does fail its benchmark still says so.
const reallyBad = { ...us500,
  rarity:{ 'sweep.D': { perMonth:3.9, n:400, fwdBars:10, fwdN:400, fwdWin:20, fwdMedAtr:-0.9 } } };
const pb = buildPlan(assess('B', reallyBad, { now: NOW }), reallyBad, { now: NOW });
check('a setup that really does lose to the market is still refused',
  pb.verdict === 'record-says-no', pb.verdict);
check('and names both numbers', /against 35%/.test(pb.note), pb.note?.slice(0, 90));

// ── On the live board ─────────────────────────────────────────────────────
const feed = loadFeed();
const { rank } = await import(`${ROOT}src/utils/confluence.js`);
const now = Date.parse(feed.updatedAt);
const plans = rank(feed, { now, minBreadth: 2 })
  .map(a => buildPlan(a, feed.instruments[a.sym], { now })).filter(p => p?.ok);
const withBench = plans.filter(p => p.marketWin != null);
const feedHasBaselines = Object.values(feed.instruments).some(r => Object.keys(r.baseline || {}).length);
console.log(`         ${plans.length} plans, ${withBench.length} carrying a market benchmark`
  + (feedHasBaselines ? '' : '  (this snapshot predates baselines)'));
// A feed published before baselines existed carries none, and the right
// behaviour there is to fall back to a coin flip rather than invent a
// benchmark — so the assertion only applies where the data is present.
if (feedHasBaselines) {
  check('most plans now show what they were measured against',
    withBench.length > plans.length * 0.7, `${withBench.length}/${plans.length}`);
} else {
  check('an old feed with no baselines degrades instead of breaking',
    withBench.length === 0 && plans.every(p => p.verdict));
}
check('and no refusal is issued without one where the data exists',
  plans.filter(p => p.verdict === 'record-says-no').every(p => p.marketWin != null || p.record?.baseWin == null));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

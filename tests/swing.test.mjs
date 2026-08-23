// Swing is the trade; intraday is the timing.
//
// Three things are being pinned here. That the slow evidence owns the direction
// of a slow setup, that the plan is priced on the timeframe it will be held on,
// and that the calendar is searched over the life of the trade rather than the
// next few hours.
import { assess, rank, horizonOf } from '../src/utils/confluence.js';
import { buildPlan, eventLine } from '../src/utils/tradePlan.js';
import { readFileSync } from 'fs';
import { loadFeed } from './feed-fixture.mjs';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const NOW = 1786500000000, H = 3600e3;

const asOf = { M15: NOW, M30: NOW, H1: NOW, H4: NOW, D: NOW };

// A daily bearish sweep, with whatever intraday evidence the caller wants
// layered on top of it.
const rec = (o={}) => ({ cls:'fx', name:'X', price:100, dec:2,
  state:{ D:{ atrPct:2, volPct:50, rangePos:50 }, H1:{ atrPct:0.4, volPct:50, rangePos:50 },
          spreadAbs:0.05, spreadRatio:1 },
  events:[], rarity:{}, patterns:{}, asOf, ...o });

const dailyBear = {
  events:[{ type:'sweep', dir:'down', at:NOW, tf:'D', detail:'swept the 5-bar high' }],
  rarity:{ 'sweep.D': { perMonth:0.7, n:14, fwdBars:10, fwdN:260, fwdWin:64, fwdMedAtr:1.8 } },
};

// ── The direction of a slow setup is set by slow evidence ─────────────────
// An M15 hammer inside a bearish daily setup is a pullback, not a reversal of
// the idea. This used to flip the card to BULLISH.
const pullbackRec = rec({
  ...dailyBear,
  patterns:{ M15:[{ id:'hammer', at:NOW, rate:1.2 }] },
});
const pull = assess('P', pullbackRec, { now: NOW });
check('a daily bearish setup stays bearish under an M15 hammer', pull.dir === 'down', pull.dir);
check('and is named a swing setup', pull.kind === 'swing', pull.kind);
check('with the disagreement reported as a pullback, not a conflict',
  pull.pullback === true && pull.conflict === false);
check('the fast evidence is still listed', pull.intraDir === 'up', String(pull.intraDir));

// ── Agreement across horizons is the case worth surfacing ─────────────────
const timedRec = rec({
  ...dailyBear,
  patterns:{ H1:[{ id:'shooting_star', at:NOW, rate:1.1 }] },
});
const timed = assess('T', timedRec, { now: NOW });
check('a fast signal agreeing with the slow bias is a timed entry', timed.kind === 'trigger', timed.kind);
check('and names what timed it', /shooting star/.test(timed.trigger?.label || ''), timed.trigger?.label);
check('a timed entry outranks the same setup without one', timed.score > pull.score,
  `${timed.score} vs ${pull.score}`);

// ── Intraday alone is a trade, and is held to a shorter clock ─────────────
const intraRec = rec({
  events:[{ type:'sweep', dir:'up', at:NOW, tf:'H1', detail:'swept the 5-bar low' }],
  rarity:{ 'sweep.H1': { perMonth:1.2, n:30, fwdBars:24, fwdN:300, fwdWin:62, fwdMedAtr:1.4 } },
  state:{ H1:{ atrPct:0.4, volPct:2, rangePos:50 }, spreadAbs:0.02, spreadRatio:1 },
});
const intra = assess('I', intraRec, { now: NOW });
check('with nothing slow, the setup is intraday', intra.kind === 'intraday', intra.kind);
check('and it is discounted against a swing setup of the same shape',
  intra.score < assess('S', rec(dailyBear), { now: NOW }).score,
  `${intra.score} vs ${assess('S', rec(dailyBear), { now: NOW }).score}`);
check('context carries no horizon of its own', horizonOf({ family:'positioning' }) === 'context');

// ── The plan is priced on the timeframe it is held on ─────────────────────
// Daily ATR is 2% and H1 ATR is 0.4%. Anchoring to the trigger would give a
// stop five times too tight and a size five times too large.
const pTimed = buildPlan(timed, timedRec, { balance: 10000, riskPct: 1, now: NOW });
check('a timed swing entry is anchored to the DAILY timeframe', pTimed.tf === 'D', pTimed.tf);
check('so the stop is 1.5 daily ATR, not 1.5 hourly ATR', pTimed.stop === 103, String(pTimed.stop));
check('and it says which fast signal timed it', !!pTimed.triggeredBy, pTimed.triggeredBy);
const pIntra = buildPlan(intra, intraRec, { balance: 10000, riskPct: 1, now: NOW });
check('an intraday setup is anchored to its own timeframe', pIntra.tf === 'H1', pIntra.tf);

// ── The hold window is read off the record ────────────────────────────────
check('a 10-bar daily record is a two-week hold', pTimed.hold.days === 14, String(pTimed.hold.days));
check('and is stated in words', /week/.test(pTimed.hold.text), pTimed.hold.text);
check('a 24-bar hourly record is a one-day hold', pIntra.hold.days === 1, String(pIntra.hold.days));

// ── The calendar is searched over the life of the trade ───────────────────
const news = { calendar: [
  { title:'Non-Farm Payrolls', country:'USD', impact:'high', at: NOW + 5*24*H },
  { title:'CPI',               country:'USD', impact:'high', at: NOW + 9*24*H },
  { title:'Retail Sales',      country:'USD', impact:'medium', at: NOW + 2*24*H },
  { title:'ECB Rate Decision', country:'EUR', impact:'high', at: NOW + 3*24*H },
  { title:'GDP',               country:'USD', impact:'high', at: NOW + 30*24*H },
] };
const withNews = buildPlan(assess('EUR/USD', rec(dailyBear), { now: NOW }), rec(dailyBear),
  { news, now: NOW });
check('high-impact events inside the hold are found', withNews.events.n === 3, String(withNews.events.n));
check('events beyond the hold are not', !withNews.events.list.some(e => /GDP/.test(e.title)));
check('medium impact is not counted', !withNews.events.list.some(e => /Retail/.test(e.title)));
check('both currencies of the pair are searched',
  withNews.events.list.some(e => e.country === 'EUR') && withNews.events.list.some(e => e.country === 'USD'));
check('and it reads as disclosure', /3 high-impact releases/.test(eventLine(withNews)), eventLine(withNews));
check('a fortnight of scheduled risk does NOT refuse the trade — it cannot be avoided',
  withNews.take === true);

// ── Imminent is different from scheduled ──────────────────────────────────
const soon = { calendar: [{ title:'FOMC', country:'USD', impact:'high', at: NOW + 45*60e3 }] };
const pSoon = buildPlan(assess('EUR/USD', rec(dailyBear), { now: NOW }), rec(dailyBear),
  { news: soon, now: NOW });
check('an imminent release blocks the entry', !!pSoon.blocked, pSoon.blocked);
check('and says how long to wait', /45 min/.test(pSoon.blocked));
check('a blocked plan is not takeable', pSoon.take === false);

// ── Against the live feed ─────────────────────────────────────────────────
const feed = loadFeed();
const now = Date.parse(feed.updatedAt);
const ranked = rank(feed, { now, minBreadth: 2 });
const kinds = {};
for (const a of ranked) kinds[a.kind] = (kinds[a.kind] || 0) + 1;
console.log(`         ${ranked.length} cards → ${JSON.stringify(kinds)}`);

const plans = ranked.map(a => ({ a, p: buildPlan(a, feed.instruments[a.sym], { now }) }))
  .filter(x => x.p?.ok);
const SWING = new Set(['D','H4']);
check('every swing plan is priced on a swing timeframe',
  plans.filter(x => x.a.kind !== 'intraday').every(x => SWING.has(x.p.tf)),
  plans.filter(x => x.a.kind !== 'intraday' && !SWING.has(x.p.tf)).map(x => `${x.a.sym}:${x.p.tf}`).join(' '));
check('every intraday plan is priced on an intraday timeframe',
  plans.filter(x => x.a.kind === 'intraday').every(x => !SWING.has(x.p.tf)),
  plans.filter(x => x.a.kind === 'intraday' && SWING.has(x.p.tf)).map(x => `${x.a.sym}:${x.p.tf}`).join(' '));
check('every plan states a holding period', plans.every(x => x.p.hold?.days > 0));
check('a swing plan is held longer than an intraday one', (() => {
  const s = plans.filter(x => x.a.kind !== 'intraday').map(x => x.p.hold.days);
  const i = plans.filter(x => x.a.kind === 'intraday').map(x => x.p.hold.days);
  return !i.length || !s.length || Math.min(...s) >= Math.max(...i);
})());
check('the direction of every swing card comes from its swing evidence',
  ranked.filter(a => a.kind !== 'intraday').every(a => a.dir === a.swingDir));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

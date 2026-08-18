import { assess, rank, currenciesOf, ageOf, driversOf, clusters, FAMILY } from '../src/utils/confluence.js';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const NOW = 1786400000000, H = 3600e3;

// Freshness is counted in bars against the feed's own last bar, so every
// record needs an asOf. NOW is treated as the last H4 and D close.
const rec = (o={}) => ({ cls:'fx', name:'X', price:1.1, dec:5,
  state:{}, events:[], rarity:{}, patterns:{},
  asOf:{ H4: NOW, D: NOW }, ...o });

// ── A reversal is not just a candlestick ──────────────────────────────────
const onlyCandle = assess('EUR/USD', rec({
  patterns:{ D:[{ id:'hammer', at: NOW - 2*H, rate: 1.5 }] } }), { now: NOW });
check('a lone candle is one family', onlyCandle.breadth === 1, String(onlyCandle.breadth));
check('and is filtered out of the ranking by default',
  rank({ instruments:{ 'EUR/USD': rec({ patterns:{ D:[{id:'hammer',at:NOW-2*H,rate:1.5}] } }) } },
       { now: NOW }).length === 0);

// The same candle, plus a swept level, plus crowded positioning, plus an event.
const full = assess('EUR/USD', rec({
  patterns:{ D:[{ id:'hammer', at: NOW - 2*H, rate: 1.5 }],
             H4:[{ id:'hammer', at: NOW - 1*H, rate: 3 }] },
  events:[{ type:'sweep', dir:'down', at: NOW - 3*H, tf:'H4', detail:'swept the 5-bar low' }],
  rarity:{ 'sweep.H4': { perMonth: 2 } },
  // Positioning comes off state.posnPct, which is where the bot writes it.
  // The `cot` argument this used to pass was a shape nothing in the app ever
  // supplied, so the highest-weighted family had never once reached a card.
  state:{ H4:{ volPct: 4, rangePos: 1 }, posnPct: 3, posnWeeks: 160 },
}), {
  now: NOW,
  news: { calendar:[{ impact:'high', country:'EUR', title:'ECB Rate Decision', at: NOW + 1.5*H, forecast:'2.15%', previous:'2.40%' }],
          headlines:[{ title:'ECB signals caution on further cuts', ccy:['EUR'], at: NOW - 30*60e3, source:'ForexLive' }] },
});
check('multiple kinds of evidence are collected', full.breadth >= 3, `${full.breadth} families: ${full.families}`);
check('news is attached as a shared driver', full.hasNews === true && full.shared.length > 0);
check('news is NOT counted in breadth', !full.families.includes('news'),
  'a currency event is identical on every pair holding that currency');
check('positioning is attached', full.families.includes('positioning'));
check('structure is attached', full.families.includes('structure'));
check('multi-timeframe candle is flagged', full.multiTf === true);
check('confluence outranks the lone candle', full.score > onlyCandle.score * 3,
  `${full.score} vs ${onlyCandle.score}`);

// ── Breadth beats loudness ────────────────────────────────────────────────
// Four price-action signals from the same candles must not outrank three
// genuinely independent ones.
const loud = assess('A', rec({ patterns:{ H4:[
  {id:'hammer',at:NOW-H,rate:1}, {id:'bull_engulf',at:NOW-H,rate:1},
  {id:'morning_star',at:NOW-H,rate:1}, {id:'piercing_line',at:NOW-H,rate:1}] } }), { now: NOW });
// The broad card's evidence has to AGREE, or this stops testing breadth and
// starts testing coherence: a three-family card that contradicts itself losing
// to a coherent one-family card is correct behaviour, not the thing being
// pinned here. The sweep pointed the other way to the hammer, so it was.
// Positioning is read from state.posnPct now, where the bot actually writes
// it — not from a `cot` map supplied by the caller, which nothing ever did.
const broad = assess('B', rec({
  patterns:{ D:[{id:'hammer',at:NOW-H,rate:2}] },
  events:[{ type:'sweep', dir:'up', at:NOW-H, tf:'H4' }],
  rarity:{ 'sweep.H4':{ perMonth: 2 } },
  state:{ posnPct: 3, posnWeeks: 160 },
}), { now: NOW });
check('one family stays one family however many signals', loud.breadth === 1, String(loud.breadth));
check('three independent families outrank four correlated signals',
  broad.score > loud.score, `broad ${broad.score} vs loud ${loud.score}`);

// ── Direction is a weighted vote over directional evidence only ───────────
check('agreeing evidence gives a direction', full.dir === 'up', String(full.dir));
// A genuine split: one bearish candle against one bullish sweep, and nothing
// else tipping the balance. The positioning entry used to be here, which made
// it two-up-against-one — a lopsided agreement being reported as a
// contradiction, which is the thing the screen was doing far too often.
const conflicted = assess('C', rec({
  patterns:{ H4:[{id:'shooting_star',at:NOW-H,rate:1}] },
  events:[{ type:'sweep', dir:'up', at:NOW-H, tf:'H4' }],
  rarity:{ 'sweep.H4':{ perMonth:1 } },
}), { now: NOW });
check('disagreement is reported, not averaged away',
  conflicted.conflict === true || conflicted.dir === null,
  `dir=${conflicted.dir} conflict=${conflicted.conflict}`);
// And the other half of the same rule: two families agreeing against one
// dissenter is an agreement, not a contradiction.
const lopsided = assess('L', rec({
  patterns:{ H4:[{id:'shooting_star',at:NOW-H,rate:1}],
             D: [{id:'hammer',at:NOW-H,rate:1}, {id:'bull_engulf',at:NOW-H,rate:1}] },
  events:[{ type:'sweep', dir:'up', at:NOW-H, tf:'H4' }],
  rarity:{ 'sweep.H4':{ perMonth:1 } },
}), { now: NOW });
check('a lopsided majority is not called a contradiction',
  lopsided.conflict === false && lopsided.dir === 'up',
  `dir=${lopsided.dir} conflict=${lopsided.conflict} coherence=${lopsided.coherence}`);
// Context cannot originate a card. A volatility squeeze and a scheduled event
// are both true of a large slice of the board at any moment; requiring
// something to have HAPPENED is what stops the screen listing most of what it
// measures.
const contextOnly = assess('D', rec({ state:{ H4:{ volPct: 3 } } }),
  { now: NOW, news:{ calendar:[{impact:'high',country:'USD',title:'NFP',at:NOW+H}], headlines:[] } });
check('a squeeze plus a scheduled event is not a card', contextOnly === null);

// The same context WITH an event is, and still has no manufactured direction.
const withEvent = assess('D2', rec({
  state:{ H4:{ volPct: 3 } },
  patterns:{ H4:[{ id:'doji', at: NOW, rate: 2 }] },
  events:[{ type:'break', dir:'up', at: NOW, tf:'H4' }],
  rarity:{ 'break.H4':{ perMonth: 2 } },
}), { now: NOW, news:{ calendar:[{impact:'high',country:'USD',title:'NFP',at:NOW+H}], headlines:[] } });
check('an event plus context is a card', withEvent !== null);
check('and the non-directional parts stay non-directional',
  withEvent.evidence.filter(e => e.family === 'volatility').every(e => e.dir === null));

// ── Common patterns are wallpaper ─────────────────────────────────────────
const common = assess('E', rec({ patterns:{ H4:[{ id:'tweezer_top', at:NOW-H, rate: 29.7 }] } }), { now: NOW });
check('a pattern firing 30x a month is ignored', common === null);
const rare = assess('F', rec({ patterns:{ D:[{ id:'tweezer_top', at:NOW-H, rate: 1.2 }] } }), { now: NOW });
check('the same pattern at 1.2x a month is kept', rare !== null);

// ── Staleness ─────────────────────────────────────────────────────────────
const old = assess('G', rec({ patterns:{ H4:[{ id:'hammer', at: NOW - 10*24*H, rate: 1 }] } }), { now: NOW });
check('a week-old H4 pattern is not "now"', old === null);

// ── News attaches only to instruments it concerns ─────────────────────────
check('EUR/USD is exposed to EUR and USD',
  currenciesOf('EUR/USD').join() === 'EUR,USD');
check('a TradFi perp is exposed to USD', currenciesOf('ORCL/USDT','tradfi').join() === 'USD');
check('a crypto perp keeps its own coin', currenciesOf('BTC/USDT','crypto').includes('BTC'));
check('an index maps to its home currency', currenciesOf('GER40').join() === 'EUR');
const jpyOnly = assess('USD/JPY', rec({ patterns:{ D:[{id:'hammer',at:NOW-H,rate:1}] } }), {
  now: NOW, news:{ calendar:[{ impact:'high', country:'AUD', title:'RBA', at: NOW + H }], headlines:[] } });
check('an unrelated currency event is not attached', !jpyOnly.hasNews);
const jpyEvent = assess('USD/JPY', rec({ patterns:{ D:[{id:'hammer',at:NOW-H,rate:1}] } }), {
  now: NOW, news:{ calendar:[{ impact:'high', country:'JPY', title:'BoJ', at: NOW + H }], headlines:[] } });
check('a relevant one is', jpyEvent.hasNews);
const lowImpact = assess('USD/JPY', rec({ patterns:{ D:[{id:'hammer',at:NOW-H,rate:1}] } }), {
  now: NOW, news:{ calendar:[{ impact:'low', country:'JPY', title:'Machine Orders', at: NOW + H }], headlines:[] } });
check('low-impact events are not surfaced', !lowImpact.hasNews);

// ── Ranking and staleness ─────────────────────────────────────────────────
const feed = { updatedAt: new Date(NOW - 5*60e3).toISOString(), instruments: {
  'EUR/USD': rec({ patterns:{ D:[{id:'hammer',at:NOW-H,rate:1}] },
                   events:[{type:'sweep',dir:'down',at:NOW-H,tf:'H4'}], rarity:{'sweep.H4':{perMonth:2}} }),
  'GBP/USD': rec({ patterns:{ H4:[{id:'tweezer_top',at:NOW-H,rate:40}] } }),
}};
const ranked = rank(feed, { now: NOW });
check('only confluent instruments are ranked', ranked.length === 1 && ranked[0].sym === 'EUR/USD',
  ranked.map(r=>r.sym).join());
const age = ageOf(feed, { updatedAt: new Date(NOW - 3*3600e3).toISOString() }, NOW);
check('fresh feed is not flagged stale', age.feedStale === false);
check('3-hour-old news IS flagged stale', age.newsStale === true);
check('missing data counts as stale', ageOf(null, null, NOW).feedStale === true);




// ── Shared drivers must not inflate every pair holding the currency ────────
const rbaNews = { calendar:[{ impact:'high', country:'AUD', title:'RBA Cash Rate', at: NOW + 1.5*3600e3 }], headlines:[] };
const audFeed = { updatedAt:new Date(NOW).toISOString(), instruments: {} };
for (const s of ['AUD/NZD','AUD/CHF','AUD/JPY','GBP/AUD','EUR/AUD']) {
  audFeed.instruments[s] = rec({ patterns:{ H4:[{ id:'hammer', at:NOW-3600e3, rate:2 }] } });
}
// One with genuinely more of its own evidence.
audFeed.instruments['AUD/NZD'] = rec({
  patterns:{ D:[{id:'hammer',at:NOW-3600e3,rate:1.5}], H4:[{id:'hammer',at:NOW-3600e3,rate:2}] },
  events:[{ type:'sweep', dir:'up', at:NOW-3600e3, tf:'H4', detail:'swept the 5-bar low' }],
  rarity:{ 'sweep.H4':{ perMonth:2 } },
  state:{ H4:{ volPct:3 } },
});
const audRanked = rank(audFeed, { news: rbaNews, now: NOW, minBreadth: 1 });
check('the pair with its own evidence ranks first',
  audRanked[0].sym === 'AUD/NZD', audRanked.map(r=>`${r.sym}:${r.score}`).join(' '));
const others = audRanked.filter(r => r.sym !== 'AUD/NZD');
check('the rest are not all tied at the top by the same event',
  new Set(others.map(r => r.score)).size >= 1 && others.every(r => r.score < audRanked[0].score),
  'one RBA decision must not lift five pairs equally above everything else');

const drivers = driversOf(audRanked);
check('the shared driver is grouped once', drivers.length === 1, String(drivers.length));
check('and lists every instrument it touches', drivers[0].syms.length === 5, String(drivers[0].syms.length));
check('it is marked scheduled', drivers[0].scheduled === true);

// ── Strong hammer / star naming and direction ─────────────────────────────
const hammer = assess('X', rec({
  events:[{ type:'sweep', dir:'up', at:NOW-3600e3, tf:'H4', detail:'swept the 5-bar low and closed back inside' }],
  rarity:{ 'sweep.H4':{ perMonth:2 } } }), { now: NOW });
check('a strong hammer is named', /strong hammer/.test(hammer.evidence[0].label), hammer.evidence[0].label);
check('and is BULLISH, not inverted', hammer.dir === 'up', String(hammer.dir));
check('and is flagged as a strong candle', hammer.strong === true);
const star = assess('Y', rec({
  events:[{ type:'sweep', dir:'down', at:NOW-3600e3, tf:'H4', detail:'swept the 5-bar high and closed back inside' }],
  rarity:{ 'sweep.H4':{ perMonth:2 } } }), { now: NOW });
check('a strong shooting star is named', /strong shooting star/.test(star.evidence[0].label), star.evidence[0].label);
check('and is BEARISH', star.dir === 'down', String(star.dir));
const brk = assess('Z', rec({
  events:[{ type:'break', dir:'up', at:NOW-3600e3, tf:'H4' }], rarity:{ 'break.H4':{ perMonth:2 } } }), { now: NOW });
check('a break is still a break', /structure break up/.test(brk.evidence[0].label) && brk.dir === 'up');
check('a break is not a strong candle', !brk.strong);

// An instrument with ONLY a shared driver is not a finding.
const newsOnly = rank({ updatedAt:new Date(NOW).toISOString(), instruments:{ 'AUD/CAD': rec() } },
  { news: rbaNews, now: NOW, minBreadth: 1 });
check('news alone does not make an instrument interesting', newsOnly.length === 0);


// ── The H4 + H4 + D bug ───────────────────────────────────────────────────
const dup = assess('K', rec({ patterns:{
  H4:[{ id:'bull_engulf', at:NOW-3600e3, rate:1.3 }, { id:'bull_engulf', at:NOW-7200e3, rate:1.3 }],
  D: [{ id:'bull_engulf', at:NOW-3600e3, rate:1.3 }] } }), { now: NOW });
check('a timeframe appears once however many occurrences',
  /H4 \+ D/.test(dup.evidence[0].label) && !/H4 \+ H4/.test(dup.evidence[0].label),
  dup.evidence[0].label);

// ── Base rates ────────────────────────────────────────────────────────────
const withBase = assess('L', rec({
  events:[{ type:'sweep', dir:'up', at:NOW-3600e3, tf:'H4' }],
  rarity:{ 'sweep.H4':{ perMonth:2, fwdN:17, fwdWin:71, fwdMedAtr:0.9, fwdBars:20 } } }), { now: NOW });
check('a measured record is attached', withBase.evidence[0].base?.n === 17,
  JSON.stringify(withBase.evidence[0].base));
check('and surfaced on the card', withBase.base?.win === 71);
const noBase = assess('M', rec({
  events:[{ type:'sweep', dir:'up', at:NOW-3600e3, tf:'H4' }],
  rarity:{ 'sweep.H4':{ perMonth:2, fwdN:3 } } }), { now: NOW });
check('too few occurrences means no record shown', noBase.evidence[0].base === null);

// A favourable record should lift the same signal above an unfavourable one.
const good = assess('N', rec({ events:[{type:'sweep',dir:'up',at:NOW-3600e3,tf:'H4'}],
  rarity:{ 'sweep.H4':{ perMonth:2, fwdN:20, fwdWin:70, fwdMedAtr:1, fwdBars:20 } } }), { now: NOW });
const bad = assess('O', rec({ events:[{type:'sweep',dir:'up',at:NOW-3600e3,tf:'H4'}],
  rarity:{ 'sweep.H4':{ perMonth:2, fwdN:20, fwdWin:30, fwdMedAtr:-1, fwdBars:20 } } }), { now: NOW });
check('a good record outranks a poor one for the same signal',
  good.score > bad.score, `${good.score} vs ${bad.score}`);

// ── Timeframe tagging, for the filter ─────────────────────────────────────
const tfd = assess('P', rec({ patterns:{ D:[{id:'hammer',at:NOW-3600e3,rate:1}] } }), { now: NOW });
check('daily-only evidence is tagged D', tfd.tfs.includes('D') && !tfd.tfs.includes('H4'), tfd.tfs.join());

// ── Class clustering ──────────────────────────────────────────────────────
const mk = (dir) => ({ dir, cls:'metal', sym:'X'+Math.random() });
// A cluster must be a real count AND a majority. "13 of 23 fx pointing up" was
// neither — it is what half a class doing anything looks like, and it appeared
// on every class at once.
check('four out of five is a cluster',
  clusters([mk('up'),mk('up'),mk('up'),mk('up'),mk('down')]).length === 1);
check('three out of four is not — too few', clusters([mk('up'),mk('up'),mk('up'),mk('down')]).length === 0);
check('a bare majority of a large class is not either',
  clusters([...Array(13)].map(() => mk('up')).concat([...Array(10)].map(() => mk('down')))).length === 0,
  '13 of 23 is not a regime');
check('a strong majority of a large class is',
  clusters([...Array(18)].map(() => mk('up')).concat([...Array(5)].map(() => mk('down')))).length === 1);
check('the cluster reports its side and count', (() => {
  const c = clusters([mk('up'),mk('up'),mk('up'),mk('up'),mk('down')])[0];
  return c.dir === 'up' && c.n === 4 && c.total === 5;
})());
check('instruments with no direction are not clustered',
  clusters([{dir:null,cls:'fx'},{dir:null,cls:'fx'},{dir:null,cls:'fx'}]).length === 0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

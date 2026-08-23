// Seven readings existed and none of them talked to each other: the chart in
// confluence, the macro in macroDrivers, institutional positioning arriving
// with the feed as a COT percentile, retail positioning in flowFeed, headlines
// matched to currencies, the calendar, and the lead-lag list. Six screens, and
// the combining was left to whoever was looking at them.
//
// These check the combining, and mostly they check that it refuses to invent:
// a leg with nothing to say says nothing, a record too small to mean anything
// is not quoted as though it did, and a chart signal whose own history says it
// fails does not get an up arrow with the contradiction printed underneath.
import { instrumentRead } from '../src/utils/instrumentRead.js';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const NOW = 1787500000000;

const legOf = (r, name) => r.legs.find(l => l.leg === name);

const rec = (state = {}) => ({ cls: 'fx', price: 1.1, dec: 5, state: { posnWeeks: 156, ...state } });
const card = (ev) => ({ sym: 'EUR/USD', cls: 'fx', evidence: ev });
const sig = (dir, label, base) => ({ dir, label, family: 'price', tfs: ['D'], base });

// A record big enough and lopsided enough to be significant either way.
const good = { n: 400, baseN: 900, win: 66, baseWin: 50, med: 1.2, baseMed: 0.1, bars: 10 };
const bad  = { n: 400, baseN: 900, win: 34, baseWin: 50, med: -1.2, baseMed: 0.1, bars: 10 };
const tiny = { n: 6,   baseN: 900, win: 33, baseWin: 59, med: -0.4, baseMed: 0.1, bars: 10 };

// ── The failure that started this ────────────────────────────────────────────
// A live card read "strong hammer on D" with an up arrow, and underneath it
// "33% went its way against 59.3% for the market" on six occurrences. Six
// occurrences establish nothing, and the numbers read as evidence against the
// arrow they were sitting under.
{
  const r = instrumentRead('EUR/USD', rec(), card([sig('up', 'strong hammer on D', tiny)]), { now: NOW });
  const t = legOf(r, 'technical');
  check('a six-sample record is not quoted as if it meant something',
    !/33%/.test(t.detail), t.detail);
  check('and the leg says plainly that nothing is measured behind the shape',
    /nothing measured behind it/.test(t.detail), t.detail);
}

// A record that IS significant and says the setup fails is not support for it.
{
  const r = instrumentRead('EUR/USD', rec(), card([sig('up', 'strong hammer on D', bad)]), { now: NOW });
  const t = legOf(r, 'technical');
  check('a signal its own history contradicts does not get a direction',
    t.dir === null, String(t.dir));
  check('and the contradiction is the headline, not a footnote',
    /the record says it fails here/.test(t.headline), t.headline);
  check('so it cannot be counted as agreement', r.agree === 0, String(r.agree));
}

// The ordinary case still works.
{
  const r = instrumentRead('EUR/USD', rec(), card([sig('up', 'strong hammer on D', good)]), { now: NOW });
  check('a signal its history supports points where it points',
    legOf(r, 'technical').dir === 'up');
  check('and quotes the sample', /400 prior occurrences/.test(legOf(r, 'technical').detail));
}

// Two signals pointing opposite ways is a real state and gets said.
{
  const r = instrumentRead('EUR/USD', rec(),
    card([sig('up', 'hammer', good), sig('down', 'shooting star', good)]), { now: NOW });
  check('a chart arguing with itself is reported, not resolved by a tiebreak',
    legOf(r, 'technical').dir === null && /both things at once/.test(legOf(r, 'technical').headline));
}

// ── Positioning ──────────────────────────────────────────────────────────────
{
  const hot = instrumentRead('EUR/USD', rec({ posnPct: 92 }), card([sig('up', 'hammer', good)]), { now: NOW });
  check('a crowded long is read as a risk to the downside',
    legOf(hot, 'big players').dir === 'down', String(legOf(hot, 'big players').dir));
  check('and that is a conflict with a bullish chart, stated as one',
    hot.conflict === true && /split/.test(hot.verdict), hot.verdict);

  const cold = instrumentRead('EUR/USD', rec({ posnPct: 8 }), card([sig('up', 'hammer', good)]), { now: NOW });
  check('a crowded short is read as a squeeze risk upward',
    legOf(cold, 'big players').dir === 'up');
  check('and agreement is counted and named', cold.agree === 2 && /2 of/.test(cold.verdict), cold.verdict);

  const mid = instrumentRead('EUR/USD', rec({ posnPct: 50 }), card([sig('up', 'hammer', good)]), { now: NOW });
  check('mid-range positioning votes for nothing',
    legOf(mid, 'big players').dir === null);
  check('and no positioning data at all produces no leg',
    !legOf(instrumentRead('EUR/USD', rec(), card([sig('up', 'h', good)]), { now: NOW }), 'big players'));
}

// ── Sentiment: retail against the institutions ───────────────────────────────
{
  const opposed = { retailLongPct: 78, retailLong: true, opposed: true, crowded: true };
  const r = instrumentRead('EUR/USD', rec(), card([sig('up', 'h', good)]), { now: NOW, smart: opposed });
  check('a crowded retail long opposed by the institutions points down',
    legOf(r, 'sentiment').dir === 'down', String(legOf(r, 'sentiment').dir));
  const aligned = { retailLongPct: 60, retailLong: true, opposed: false, crowded: false };
  const s = instrumentRead('EUR/USD', rec(), card([sig('up', 'h', good)]), { now: NOW, smart: aligned });
  check('retail agreeing with the institutions is not a contrarian signal',
    legOf(s, 'sentiment').dir === null, String(legOf(s, 'sentiment').dir));
}

// ── Fundamental ──────────────────────────────────────────────────────────────
// Direction comes from the sign of the correlation AND the direction the series
// is moving. Getting one of the two wrong inverts the whole leg.
{
  const mk = (r, change) => ({ drivers: [{ label: '10y real yield', r, change, n: 60, level: 2.4, unit: '%' }] });
  const cases = [
    [-0.5,  0.2, 'down', 'a negative tracker rising pushes down'],
    [-0.5, -0.2, 'up',   'a negative tracker falling pushes up'],
    [ 0.5,  0.2, 'up',   'a positive tracker rising pushes up'],
    [ 0.5, -0.2, 'down', 'a positive tracker falling pushes down'],
  ];
  for (const [rr, ch, want, why] of cases) {
    const out = instrumentRead('EUR/USD', rec(), card([sig('up', 'h', good)]), { now: NOW, macro: mk(rr, ch) });
    check(why, legOf(out, 'fundamental').dir === want, String(legOf(out, 'fundamental').dir));
  }
  const none = instrumentRead('EUR/USD', rec(), card([sig('up', 'h', good)]),
    { now: NOW, macro: { drivers: [] } });
  check('nothing clearing the noise floor produces no fundamental leg',
    !legOf(none, 'fundamental'),
    'gold stops tracking real yields for months and the honest output is silence');
  // The series note describes the series in general — the real-yield one says
  // "gold's biggest macro driver" — and printed under DOT/USDT it is a sentence
  // about a different instrument.
  const noted = instrumentRead('DOT/USDT', { cls:'crypto', price:5, state:{} },
    { sym:'DOT/USDT', cls:'crypto', evidence: [sig('up','h',good)] },
    { now: NOW, macro: { drivers: [{ label:'10y real yield', r:-0.45, change:0.2, n:25,
                                     level:2.44, unit:'%', note:"gold's biggest macro driver" }] } });
  check('a note about another instrument is not printed under this one',
    !/gold/.test(legOf(noted, 'fundamental').detail), legOf(noted, 'fundamental').detail);
}

// ── News and the calendar ────────────────────────────────────────────────────
{
  const news = {
    headlines: [{ title: 'ECB holds rates', ccy: ['EUR'], at: NOW - 3600e3 },
                { title: 'Unrelated', ccy: ['JPY'], at: NOW - 3600e3 },
                { title: 'Stale', ccy: ['EUR'], at: NOW - 80 * 3600e3 }],
    calendar: [{ title: 'Core CPI m/m', country: 'USD', impact: 'high', at: NOW + 3 * 3600e3 },
               { title: 'Low one', country: 'USD', impact: 'low', at: NOW + 3600e3 }],
  };
  const r = instrumentRead('EUR/USD', rec(), card([sig('up', 'h', good)]), { now: NOW, news });
  check('only headlines naming this instrument count, and only recent ones',
    /1 recent story on EUR\/USD/.test(legOf(r, 'news').headline), legOf(r, 'news').headline);
  check('a scheduled high-impact release becomes its own leg',
    /Core CPI/.test(legOf(r, 'event risk').headline), legOf(r, 'event risk')?.headline);
  check('and it votes for no direction, because it overrides rather than agrees',
    legOf(r, 'event risk').dir === null);
  check('the risk is surfaced separately, since it can undo every other leg',
    r.risk?.leg === 'event risk');
  // A perp maps to USD plus its own ticker for matching. Printing that ticker
  // as a currency read as though somebody were writing about DOT.
  const dot = instrumentRead('DOT/USDT', { cls: 'crypto', price: 5, state: {} },
    { sym: 'DOT/USDT', cls: 'crypto', evidence: [sig('up', 'h', good)] },
    { now: NOW, news: { headlines: [{ title: 'Fed speaks', ccy: ['USD'], at: NOW - 3600e3 }], calendar: [] } });
  check('a perp reports its quote currency, not its own ticker as a currency',
    /on USD$/.test(legOf(dot, 'news').headline), legOf(dot, 'news').headline);
}

// ── Lead-lag ─────────────────────────────────────────────────────────────────
// The sign is the whole meaning. "CRWD leads this by 1 day, correlation -0.29"
// left the reader to spot the minus and work out that it means the opposite.
{
  const withLeaders = n => ({ ...rec(), leaders: { list: [{ sym: 'DXY', lag: 1, r: n, r0: 0.1 }] } });
  const pos = instrumentRead('EUR/USD', withLeaders(0.42), card([sig('up', 'h', good)]), { now: NOW });
  check('a positive lead reads as leading', /DXY leads this by 1 day/.test(legOf(pos, 'related').headline),
    legOf(pos, 'related').headline);
  const neg = instrumentRead('EUR/USD', withLeaders(-0.42), card([sig('up', 'h', good)]), { now: NOW });
  check('a negative lead reads as moving it the other way',
    /opposite way/.test(legOf(neg, 'related').headline), legOf(neg, 'related').headline);
  check('and the magnitude is shown without the sign confusing it',
    /0\.42 correlation/.test(legOf(neg, 'related').detail), legOf(neg, 'related').detail);
}

// ── The whole point ──────────────────────────────────────────────────────────
{
  const empty = instrumentRead('EUR/USD', rec(), { sym: 'EUR/USD', cls: 'fx', evidence: [] }, { now: NOW });
  check('an instrument with nothing to say says nothing',
    empty.legs.length === 0 && /nothing here points anywhere/.test(empty.verdict), empty.verdict);
  check('a missing record is safe', instrumentRead('X', null, null) === null);

  const many = instrumentRead('EUR/USD', rec({ posnPct: 5 }), card([sig('up', 'hammer', good)]), {
    now: NOW,
    macro: { drivers: [{ label: '2y yield', r: -0.6, change: -0.3, n: 90, level: 3.7, unit: '%' }] },
    smart: { retailLongPct: 75, retailLong: false, opposed: true, crowded: true },
  });
  check('four legs agreeing is counted and every one of them is named',
    many.agree === 4 && ['technical','big players','sentiment','fundamental']
      .every(l => many.verdict.includes(l)), many.verdict);
  check('and the strongest evidence is ordered first',
    many.legs[0].leg === 'technical', many.legs.map(l => l.leg).join(' > '));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

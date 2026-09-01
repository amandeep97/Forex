// The screen the app opens on.
//
// Twenty-eight tabs in a horizontal scroll and nothing saying where to start:
// the answer to "is there anything to do today" was four swipes away, and on
// some days ten model calls away as well.
//
// The rule this file exists to protect: the verdict is ARITHMETIC. Either a
// setup that survived the holdout is true on this bar, or it is one condition
// short, or there is nothing. The macro read and the headlines are printed for
// a person to read and must never leak into the answer — they have never been
// scored against an outcome, and turning them into a signal is the exact habit
// the rest of this work exists to break.
import { verdictFor, barAge, nextEvents, topHeadlines, breaking, moveSincePct } from '../src/utils/todayRead.js';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const H = 3600e3;

// ── The verdict, and what it refuses to consider ───────────────────────────
{
  const rule = {
    id: 'r1', dir: 'up', hold: 12, text: 'at the day\'s high + after the New York close',
    holdout: { expR: 0.424, baseExpR: 0.066, n: 91 },
  };
  const v = verdictFor({ fires: [rule], near: [] });
  check('a surviving setup that is true right now says so, and which way',
    v.word === 'SETUP — LONG', v.word);
  check('with the edge AND the sample it rests on, not just a direction',
    /\+0\.424R/.test(v.line) && /91 trades/.test(v.line), v.line);
  check('and against a random entry rather than against zero', /0\.066R/.test(v.line));
  check('a short setup reads as a short',
    verdictFor({ fires: [{ ...rule, dir: 'down' }] }).word === 'SETUP — SHORT');

  const near = verdictFor({ fires: [], near: [{ text: 'ripping higher + after the New York close',
    missing: ['after the New York close'] }] });
  check('one condition short is WATCH, not a trade', near.word === 'WATCH', near.word);
  check('and it names the condition that is missing',
    /needs after the New York close/.test(near.line), near.line);

  const none = verdictFor({ fires: [], near: [] });
  check('nothing firing and nothing close says NOTHING', none.word === 'NOTHING');
  check('and says plainly that the rest of the card is not a reason to trade',
    /context, not a reason to trade/.test(none.line), none.line);

  // The line this must not cross.
  check('a firing setup wins over a near miss', verdictFor({ fires: [rule],
    near: [{ text: 'x', missing: ['y'] }] }).word === 'SETUP — LONG');
  // The line this must not cross, asserted on behaviour rather than on the
  // shape of the function: hand it the macro read, the headlines and a
  // screaming severity, and the answer must be byte-for-byte identical.
  const plain = verdictFor({ fires: [], near: [] });
  const loud = verdictFor({
    fires: [], near: [],
    driver: { r2: 0.31, push: -2.08, text: 'somebody is selling gold itself' },
    headlines: [{ title: 'BREAKING: Iran strikes reported', sev: 3 }],
    events: [{ title: 'ISM', impact: 'high', inH: 2 }],
  });
  check('the macro read and the headlines cannot change the answer',
    JSON.stringify(plain) === JSON.stringify(loud),
    'neither has ever been scored against an outcome, and a screen that quietly '
    + 'weighs them has invented a signal out of decoration');
}

// ── A closed market is not a broken feed ───────────────────────────────────
// FX shuts on Friday evening and reopens Sunday evening. A bare date read as a
// stale feed, which is exactly how it read on screen.
{
  const sunday = Date.UTC(2026, 7, 30, 12, 0);      // Sunday midday
  const friday = Date.UTC(2026, 7, 28, 20, 0);      // Friday, before the close
  check('a two-day-old bar on a Sunday is explained, not flagged as stale',
    barAge(friday, sunday).text === 'last bar before the weekend close',
    barAge(friday, sunday).text);
  check('and is not marked stale, because nothing is wrong',
    barAge(friday, sunday).stale === false);

  const wed = Date.UTC(2026, 8, 2, 12, 0);
  check('a bar from an hour ago mid-week is live', barAge(wed - H, wed).text === 'live');
  check('one from nine hours ago mid-week IS stale',
    barAge(wed - 9 * H, wed).stale === true, barAge(wed - 9 * H, wed).text);
  check('and one from three days ago mid-week says how old in days',
    /3d old/.test(barAge(wed - 72 * H, wed).text), barAge(wed - 72 * H, wed).text);
  check('no bar at all is null rather than a made-up age', barAge(null) === null);
}

// ── The clock ──────────────────────────────────────────────────────────────
{
  const now = Date.UTC(2026, 8, 1, 12, 0);
  const cal = {
    calendar: [
      { title: 'ISM Manufacturing PMI', country: 'USD', impact: 'high', at: now + 19 * H, forecast: '55.2' },
      { title: 'Housing revision', country: 'USD', impact: 'low', at: now + 2 * H },
      { title: 'ECB speech', country: 'EUR', impact: 'high', at: now + 5 * H },
      { title: 'G20 meeting', country: 'All', impact: 'high', at: now + 8 * H },
      { title: 'Last week\'s CPI', country: 'USD', impact: 'high', at: now - 5 * H },
      { title: 'Next month\'s NFP', country: 'USD', impact: 'high', at: now + 400 * H },
    ],
  };
  const e = nextEvents(cal, ['XAU', 'USD'], { now });
  check('only high-impact events make the clock', !e.some(x => /Housing/.test(x.title)),
    'a low-impact housing revision is not a reason to look at the clock');
  check('an event for another currency is left out', !e.some(x => /ECB/.test(x.title)));
  check('but one marked for everybody is kept', e.some(x => /G20/.test(x.title)));
  check('what has already happened is not upcoming', !e.some(x => /Last week/.test(x.title)));
  check('and something four hundred hours away is not either',
    !e.some(x => /Next month/.test(x.title)));
  check('soonest first', e[0].inH < e[e.length - 1].inH, JSON.stringify(e.map(x => x.inH)));
  check('with the countdown in hours and the forecast attached',
    e.find(x => /ISM/.test(x.title))?.inH === 19
    && e.find(x => /ISM/.test(x.title))?.forecast === '55.2');
  check('an empty calendar is an empty list, not a crash', nextEvents(null, ['USD']).length === 0);
}

// ── Headlines ──────────────────────────────────────────────────────────────
{
  const now = Date.UTC(2026, 8, 1, 12, 0);
  const news = {
    headlines: [
      { title: 'Gold slips on profit taking', inst: ['XAU/USD'], ccy: ['XAU'], sev: 1, at: now - 6 * H, source: 'Reuters' },
      { title: 'Fed rate hike odds rise', inst: [], ccy: ['USD'], sev: 2, at: now - 1 * H, source: 'MarketWatch' },
      { title: 'BREAKING: Iran strikes reported', inst: ['XAU/USD'], ccy: ['XAU'], sev: 3, at: now - 3 * H, source: 'ForexLive' },
      { title: 'Nikkei closes higher', inst: ['JPN225'], ccy: ['JPY'], sev: 1, at: now - 30 * 60e3, source: 'CNBC' },
    ],
  };
  const insts = [{ feedSym: 'XAU/USD', ccy: ['XAU', 'USD'] }];
  const h = topHeadlines(news, insts, { now });
  check('a Japanese equities story does not reach a gold screen',
    !h.some(x => /Nikkei/.test(x.title)));
  check('the heaviest headline is first even though it is not the newest',
    /Iran/.test(h[0].title), h.map(x => x.title).join(' | '));
  check('a dollar story reaches gold, because the dollar prices it',
    h.some(x => /Fed rate hike/.test(x.title)));
  check('and is marked as reaching it through the currency rather than directly',
    h.find(x => /Fed rate hike/.test(x.title))?.direct === false);
  check('a gold story is marked as directly about it',
    h.find(x => /Iran/.test(x.title))?.direct === true);
  check('each carries its age, so stale is visible',
    h.every(x => Number.isFinite(x.ageH)), JSON.stringify(h.map(x => x.ageH)));
  check('an empty archive is an empty list', topHeadlines(null, insts).length === 0);
}

// ── What just happened, and what the market did after ──────────────────────
//
// A severity-3 wire and a two-percent dump were on the same screen twenty
// scrolls apart — the metals at the top, the headline at the bottom under the
// calendar. This puts the headline first with the clock on it and states what
// the metals have done since that bar.
//
// The line it must not cross: it reports SEQUENCE, never cause. Nothing in this
// app has ever measured whether a headline moved a price.
{
  const now = Date.UTC(2026, 8, 1, 18, 0);
  const H = 3600e3;
  // Hourly bars: flat until 14:00, then a slide.
  const cs = [];
  for (let h = 6; h <= 18; h++) {
    const p = h <= 14 ? 4450 : 4450 - (h - 14) * 25;
    cs.push({ t: Date.UTC(2026, 8, 1, h), o: p, h: p + 5, l: p - 5, c: p, v: 1 });
  }

  const m = moveSincePct(cs, Date.UTC(2026, 8, 1, 14, 12));
  check('the move is measured from the bar the headline landed IN, not before it',
    m.at === Date.UTC(2026, 8, 1, 15), new Date(m.at).toISOString());
  check('and it is the move to now', Math.abs(m.pct - ((4350 - 4425) / 4425 * 100)) < 1e-9,
    `${m.pct.toFixed(2)}%`);
  check('a headline newer than the last complete bar has nothing to measure yet',
    moveSincePct(cs, now + H) === null,
    'a zero there would read as "the market did nothing", which is a different claim');
  check('no bars is null rather than zero', moveSincePct(null, now) === null);

  const news = { headlines: [
    { title: 'BREAKING: US strikes Iranian sites', sev: 3, at: Date.UTC(2026, 8, 1, 14, 12),
      inst: ['XAU/USD'], ccy: ['XAU'], source: 'ForexLive' },
    { title: 'Fed speaker repeats guidance', sev: 2, at: Date.UTC(2026, 8, 1, 9, 0),
      inst: [], ccy: ['USD'], source: 'Investing' },
    { title: 'Routine Asia wrap', sev: 1, at: Date.UTC(2026, 8, 1, 17, 0),
      inst: ['XAU/USD'], ccy: ['XAU'], source: 'CNBC' },
    { title: 'Old war headline', sev: 3, at: Date.UTC(2026, 7, 30, 9, 0),
      inst: ['XAU/USD'], ccy: ['XAU'], source: 'BBC' },
    { title: 'Nikkei closes higher', sev: 3, at: Date.UTC(2026, 8, 1, 15, 0),
      inst: ['JPN225'], ccy: ['JPY'], source: 'CNBC' },
  ] };
  const insts = [{ sym: 'XAU_USD', feedSym: 'XAU/USD', label: 'Gold', dec: 2, ccy: ['XAU', 'USD'] }];
  const b = breaking(news, insts, { XAU_USD: cs }, { now });

  check('the urgent one is first, ahead of a newer but lighter headline',
    /US strikes/.test(b[0].title), b.map(x => x.title).join(' | '));
  check('routine noise never reaches the top of the page',
    !b.some(x => /Routine Asia/.test(x.title)), 'severity 1 is not breaking');
  check('yesterday\'s war is not breaking either',
    !b.some(x => /Old war/.test(x.title)), 'two days old, however severe');
  check('and a Japanese equities story does not reach a metals screen',
    !b.some(x => /Nikkei/.test(x.title)));
  check('it carries the clock and the age, not just a date',
    b[0].at === Date.UTC(2026, 8, 1, 14, 12) && b[0].ageMin === 228, String(b[0].ageMin));
  check('with what the metal has done since it landed',
    b[0].since[0].move.pct < -1, `${b[0].since[0].move.pct.toFixed(2)}%`);
  check('a dollar story still reaches gold, marked as indirect',
    b.some(x => /Fed speaker/.test(x.title) && x.direct === false));
  check('an empty archive is an empty band rather than a crash',
    breaking(null, insts, {}, { now }).length === 0);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

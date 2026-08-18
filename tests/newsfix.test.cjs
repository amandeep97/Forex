// Three defects in the news pipeline, each found by looking at what it was
// actually producing rather than at what it was supposed to produce.
//
//   Half the sources were dead — FXStreet, DailyFX and CNBC — and failing
//   silently, so the screen simply looked like a quiet news day.
//
//   "Goldman Sachs raises S&P target" was tagged GOLD and "Canada Goose shares
//   fall 8%" was tagged CAD, because the matcher tested substrings. That match
//   decides which instrument's card a headline appears on, so a wrong one is
//   not untidy, it is evidence attached to the wrong market.
//
//   And the actual result was never kept. Fifty-five past events were stored
//   and not one recorded what had happened, so the screen could say CPI was
//   coming and never say what CPI was.
const ROOT = require('path').join(__dirname, '..') + '/';
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const N = require(`${ROOT}vps-bot/src/newsFetcher.js`);

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// ── The matcher no longer attaches stories to the wrong market ────────────
const cases = [
  ['Goldman Sachs raises S&P 500 target',        [],      'a bank is not bullion'],
  ['Canada Goose shares fall 8% on weak guidance',[],     'a coat maker is not the loonie'],
  ['Golden Gate Bridge closure snarls traffic',  [],      'nor is a bridge'],
  ['Silver Lake nears deal for software firm',   [],      'nor is a buyout fund silver'],
  ['Boeing wins order from flag carrier',        [],      'boe is inside Boeing'],
  ['Audit finds errors at regional lender',      [],      'aud is inside audit'],
  ['Gold hits record high above $4,400',         ['XAU'], 'the real thing still matches'],
  ['Silver follows gold higher',                 ['XAU','XAG'], 'and so does both at once'],
  ['Fed holds rates, Powell signals patience',   ['USD'], 'central banks still match'],
  ['ECB cuts as eurozone inflation cools',       ['EUR'], 'and so do theirs'],
  ['RBNZ surprises with a hold in New Zealand',  ['NZD'], 'multi-word entries survive'],
  ['Crude slips as OPEC raises output',          ['OIL'], 'energy still matches'],
];
for (const [title, want, why] of cases) {
  const got = N.currenciesIn(title).sort();
  check(why, JSON.stringify(got) === JSON.stringify([...want].sort()),
    `"${title.slice(0, 42)}" -> ${JSON.stringify(got)}`);
}

// ── Released numbers are read, not thrown away ────────────────────────────
check('a percentage is read as a number', N.numOf('0.2%') === 0.2);
check('thousands are expanded', N.numOf('250K') === 250000);
check('millions too', N.numOf('3.40M') === 3400000);
check('negatives survive', N.numOf('-1.2%') === -1.2);
check('commas do not break it', N.numOf('1,250K') === 1250000);
check('an empty value is not zero', N.numOf('') === null && N.numOf(null) === null);
check('a non-numeric value is refused, not guessed', N.numOf('Tentative') === null);

// ── The surprise, which is the part that moves anything ───────────────────
const hot = N.withSurprise({ actual: '3.4%', forecast: '3.1%', previous: '3.0%' });
check('a beat is measured against forecast, not against last month',
  hot.surprise === 0.3 && hot.vsPrevious === 0.4, `surprise ${hot.surprise}, vs prev ${hot.vsPrevious}`);
check('and named', hot.beat === 'above', hot.beat);
check('with a relative reading, because 0.3 means different things',
  hot.surprisePct === 9.7, String(hot.surprisePct));

const miss = N.withSurprise({ actual: '180K', forecast: '250K', previous: '210K' });
check('a miss is negative', miss.surprise === -70000 && miss.beat === 'below', String(miss.surprise));

const inline = N.withSurprise({ actual: '0.2%', forecast: '0.2%' });
check('in line is neither', inline.beat === 'inline' && inline.surprise === 0);

const notYet = N.withSurprise({ forecast: '0.2%', previous: '0.3%' });
check('an event that has not happened gets no surprise, not a zero',
  notYet.surprise === undefined && notYet.beat === undefined);

const zeroFc = N.withSurprise({ actual: '0.3%', forecast: '0.0%' });
check('a zero forecast does not divide by zero',
  zeroFc.surprise === 0.3 && zeroFc.surprisePct === undefined, JSON.stringify(zeroFc.surprisePct));

// ── Sources ───────────────────────────────────────────────────────────────
check('the dead feeds have replacements alongside them',
  N.CURRENCY_WORDS && require('fs').readFileSync(`${ROOT}vps-bot/src/newsFetcher.js`, 'utf8')
    .match(/name: '/g).length >= 9, 'nine sources configured');
check('a history file has its own path, separate from the live screen',
  N.HISTORY_PATH === 'bot/calendar-history.json', N.HISTORY_PATH);

// ── The actual, filled in from BLS where the calendar leaves it blank ─────
// The schedule feed never sends a result. BLS does, has no key, and the macro
// workflow already reaches it, so the value arrives through the repo.
const releases = {
  cpi_mom:      [{ date:'2026-06-01', val:0.2 }, { date:'2026-07-01', val:0.4 }],
  core_cpi_mom: [{ date:'2026-07-01', val:0.3 }],
  nfp:          [{ date:'2026-07-01', val:180000 }],
};
const AUG = Date.parse('2026-08-12T12:30:00Z');
check('a released US CPI is found for the month it reported',
  N.releasedValue('CPI m/m', AUG, releases, 'USD') === 0.4);
check('core CPI is a different series, not a fuzzy match on the same one',
  N.releasedValue('Core CPI m/m', AUG, releases, 'USD') === 0.3);
check('payrolls too', N.releasedValue('Non-Farm Employment Change', AUG, releases, 'USD') === 180000);
check('an event with no mapped series gets nothing rather than a guess',
  N.releasedValue('Flash Manufacturing PMI', AUG, releases, 'USD') === null);
check('and a value published AFTER the event is never used',
  N.releasedValue('CPI m/m', Date.parse('2026-06-15T00:00:00Z'), releases, 'USD') === 0.2,
  'the June release reported May, not July');
check('no releases file means no actual, not a zero',
  N.releasedValue('CPI m/m', AUG, null, 'USD') === null);

// ── BLS is a US agency, and the first version of this forgot ──────────────
// Every calendar carries "CPI m/m" for a dozen countries. Matching on title
// alone filed the US CPI against Canada's release and the US unemployment rate
// against China's, then computed a surprise from the mismatched pair and wrote
// it to a permanent archive.
check('Canada does not get the US CPI',
  N.releasedValue('CPI m/m', AUG, releases, 'CAD') === null);
check('nor China the US unemployment rate',
  N.releasedValue('Unemployment Rate', AUG, releases, 'CNY') === null);
check('nor the eurozone', N.releasedValue('CPI m/m', AUG, releases, 'EUR') === null);
check('and a missing country matches nothing rather than everything',
  N.releasedValue('CPI m/m', AUG, releases, undefined) === null);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

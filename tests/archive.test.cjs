// A cleanup behind a guard it could not reach.
//
// The archive filled with US figures filed against Canadian and Chinese
// releases. The fix added a country check and a purge — and the purge sat after
// `if (!released.length) return`, so once the country check was in place there
// was nothing to add, the method returned immediately, and the bad rows stayed.
// A correction that only runs when there is also new work is not a correction.
const ROOT = require('path').join(__dirname, '..') + '/';
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const { NewsFetcher, HISTORY_PATH } = require(`${ROOT}vps-bot/src/newsFetcher.js`);

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const BAD = [
  { at: Date.now() - 6e5, country: 'CNY', title: 'Unemployment Rate', actual: '4.1', actualFrom: 'BLS' },
  { at: Date.now() - 6e5, country: 'CAD', title: 'CPI m/m',           actual: '0.07', actualFrom: 'BLS' },
  { at: Date.now() - 6e5, country: 'CAD', title: 'Core CPI m/m',      actual: '0.22', actualFrom: 'BLS' },
];
const GOOD = { at: Date.now() - 6e5, country: 'USD', title: 'CPI m/m', actual: '0.4', actualFrom: 'BLS' };

function fakeGh(events) {
  const state = { written: null, calls: 0 };
  return { state, github: {
    readJSON: async () => ({ content: { version: 1, events }, sha: 'aaa' }),
    writeJSON: async (path, body) => { state.calls++; state.written = body; return 'bbb'; },
  }};
}

async function run(existing, calendar) {
  const { state, github } = fakeGh(existing);
  const nf = new NewsFetcher({ github, log: () => {} });
  await nf._archive(calendar);
  return state;
}

(async () => {
  // The exact situation on the live archive: bad rows present, nothing new.
  let s = await run([...BAD], []);
  check('the purge runs even when there is nothing new to add', s.calls === 1);
  check('and every mis-attributed row is gone',
    s.written && s.written.events.length === 0, JSON.stringify(s.written?.events?.length));

  // Nothing wrong and nothing new: do not churn a commit.
  s = await run([GOOD], []);
  check('a clean archive with no new events writes nothing', s.calls === 0);

  // A genuine US row survives the purge.
  s = await run([GOOD, ...BAD], []);
  check('a correctly attributed US row is kept',
    s.written.events.length === 1 && s.written.events[0].country === 'USD',
    JSON.stringify(s.written.events.map(e => e.country)));

  // A restated timestamp updates the row rather than duplicating it. Both dates
  // must be in the PAST — the archive only takes released events, so a fixture
  // dated tomorrow is correctly ignored and proves nothing.
  const t = Date.now() - 3 * 86400e3;
  const first  = { at: t,          country: 'USD', title: 'Core CPI m/m', actual: '0.22', actualFrom: 'BLS' };
  const redate = { at: t + 120000, country: 'USD', title: 'Core CPI m/m', actual: '0.22', actualFrom: 'BLS' };
  s = await run([first], [redate]);
  check('the same release two minutes later is one row, not two',
    s.calls === 0 || s.written.events.length === 1,
    `wrote ${s.written?.events?.length ?? 'nothing'}`);

  // And a genuinely new day is a new row.
  const nextDay = { at: t + 86400e3, country: 'USD', title: 'Core CPI m/m', actual: '0.30', actualFrom: 'BLS' };  // still two days ago
  s = await run([first], [nextDay]);
  check('the next month\'s release is a separate row', s.written.events.length === 2);

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

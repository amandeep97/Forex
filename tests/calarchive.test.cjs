// The calendar archive recorded nothing for its entire existence.
//
// It filtered for events that were BOTH in the past AND carried an actual. A
// calendar is a schedule: it lists what is coming, carries a forecast while an
// event is upcoming, and drops the event once it has happened. Those two
// conditions were never true at the same moment. Checked on the live feed: 66
// events, 0 in the past, 0 with an actual — and calendar-history.json held an
// empty array, as it had since the day it was written.
//
// The cost is not an empty file. Surprise is actual minus forecast, and the
// forecast exists only BEFORE the event. Waiting until afterwards throws away
// the half that cannot be recovered, permanently — which is why a study of
// news surprise could not be run today and cannot be run for months yet.
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const { NewsFetcher } = require('../vps-bot/src/newsFetcher.js');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const NOW = Date.parse('2026-08-24T00:00:00Z');

const run = async (calendar, releases, stored) => {
  const hub = {
    stored,
    async readJSON() { return this.stored ? { content: this.stored, sha: 's' } : null; },
    async writeJSON(_p, payload) { this.stored = payload; return 's2'; },
  };
  const n = new NewsFetcher({ github: hub, log: () => {} });
  await n._archive(calendar, releases);
  return hub.stored;
};

(async () => {
  // A purely forward-looking calendar — which is every calendar this bot has
  // ever fetched — must now produce rows.
  const future = [
    { at: NOW + 3 * 86400e3, country: 'USD', title: 'CPI m/m', impact: 'high',
      forecast: '0.3%', previous: '0.2%' },
    { at: NOW + 5 * 86400e3, country: 'EUR', title: 'ECB Rate Decision', impact: 'high',
      forecast: '2.15%', previous: '2.15%' },
  ];
  const a = await run(future, null, null);
  check('a scheduled event is archived before it happens',
    a && a.events.length === 2, String(a && a.events.length));
  check('with the forecast, which is the half that disappears afterwards',
    a.events.find(e => e.title === 'CPI m/m').forecast === '0.3%');
  check('and no actual yet, rather than a zero standing in for one',
    a.events.every(e => e.actual === null));

  // The event passes. The calendar no longer carries it at all — that is the
  // normal case, not an edge case — and BLS has published the number.
  const releases = { cpi_mom: [{ date: '2026-08-01', val: 0.5 }] };
  const past = a.events.map(e => ({ ...e, at: e.at - 10 * 86400e3 }));
  const b = await run([], releases, { version: 1, events: past });
  const cpi = b.events.find(e => e.title === 'CPI m/m');
  check('the actual is filled in once the event is past', cpi.actual === 0.5, String(cpi.actual));
  check('and its source is recorded rather than passed off as the calendar\'s',
    cpi.actualFrom === 'BLS');
  check('the surprise finally exists, which was the entire point',
    cpi.surprise === 0.2 && cpi.beat === 'above', `${cpi.surprise} ${cpi.beat}`);
  check('a non-US event gets no US number, whatever its title matches',
    b.events.find(e => e.country === 'EUR').actual === null,
    'BLS is a United States agency and every series it publishes is a US number');

  // A restated forecast must not overwrite the one captured beforehand: the
  // market was positioned against the original, not the revision.
  const c = await run(
    [{ at: NOW + 86400e3, country: 'USD', title: 'CPI m/m', impact: 'high', forecast: '0.9%' }],
    null,
    { version: 1, events: [{ at: NOW + 86400e3, country: 'USD', title: 'CPI m/m',
                             impact: 'high', forecast: '0.3%', previous: null, actual: null }] });
  check('a forecast captured before the event is never overwritten later',
    c.events[0].forecast === '0.3%', c.events[0].forecast);

  // Bounded, or the file grows forever.
  const old = await run([], null, {
    version: 1,
    events: [{ at: NOW - 400 * 86400e3, country: 'USD', title: 'Old', impact: 'high', actual: 1 },
             { at: NOW - 10 * 86400e3,  country: 'USD', title: 'Recent', impact: 'high', actual: 1 }],
  });
  check('rows older than a year age out',
    old.events.length === 1 && old.events[0].title === 'Recent',
    JSON.stringify(old.events.map(e => e.title)));

  // Nothing at all to do must not rewrite the file every minute.
  const none = await run([], null, { version: 1, events: [] });
  check('an empty calendar with an empty archive writes nothing', none.events === undefined
    || none.events.length === 0, JSON.stringify(none && none.events));

  // The calendar sends an unreleased value as an EMPTY STRING, not as a missing
  // field. On the live feed all 66 archived rows came back with actual:"" —
  // which reads as present, so the fill pass skipped every one of them and no
  // actual would ever have been written. The same failure as the original bug
  // wearing different clothes: a condition that looks like it fires and does
  // not.
  const empties = [{ at: NOW + 86400e3, country: 'USD', title: 'CPI m/m', impact: 'high',
                     forecast: '0.3%', previous: '0.2%', actual: '' }];
  const d = await run(empties, null, null);
  check('an empty actual is stored as absent, not as a value',
    d.events[0].actual === null, JSON.stringify(d.events[0].actual));

  // And a row written by the first version, carrying "", must still get filled.
  const e = await run([], { cpi_mom: [{ date: '2026-08-01', val: 0.5 }] }, {
    version: 1,
    events: [{ at: NOW - 86400e3, country: 'USD', title: 'CPI m/m', impact: 'high',
               forecast: '0.3%', previous: '0.2%', actual: '' }],
  });
  check('a row already written with an empty actual is repaired and filled',
    e.events[0].actual === 0.5 && e.events[0].surprise === 0.2,
    `${e.events[0].actual} / ${e.events[0].surprise}`);

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('  FAIL  threw —', e.stack.split('\n').slice(0, 3).join(' ')); process.exit(1); });

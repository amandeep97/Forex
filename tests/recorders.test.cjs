// Two recorders, and neither measures anything.
//
// I offered a study of news surprise and a study of retail positioning, and
// only checked afterwards whether the data existed. It did not. The calendar
// archive has been empty since the day it was written, and the retail position
// book has never been stored at all — the app fetches it live in the browser
// and discards it when the tab closes.
//
// So the questions were not hard, they were unanswerable, and they stay
// unanswerable until something starts writing the data down. That is all this
// is. The studies cannot be written for another two or three months.
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const { BookRecorder, spanOf, SAMPLE_MS, KEEP_DAYS } = require('../vps-bot/src/bookRecorder.js');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const NOW = 1787500000000;

// A GitHub stand-in that remembers what was written.
function fakeHub(initial = null) {
  return {
    stored: initial,
    async readJSON() { return this.stored ? { content: this.stored, sha: 'sha1' } : null; },
    async writeJSON(_p, payload) { this.stored = payload; return 'sha2'; },
  };
}
const INST = [
  { sym: 'EUR/USD', oanda: 'EUR_USD' },
  { sym: 'GBP/USD', oanda: 'GBP_USD' },
  { sym: 'BTC/USDT', binance: 'BTCUSDT' },   // no OANDA book exists for this
];

const okBook = pct => ({ t: NOW, price: 1.1, longPct: pct });

(async () => {
  // ── It records, and only what it should ────────────────────────────────────
  {
    const hub = fakeHub();
    const asked = [];
    const r = new BookRecorder({
      instruments: INST, github: hub, log: () => {},
      oanda: { async getPositionBook(i) { asked.push(i); return okBook(72); } },
    });
    const out = await r.tick(NOW);
    check('only instruments that have an OANDA book are asked',
      asked.join() === 'EUR_USD,GBP_USD', asked.join());
    check('a sample is stored per instrument',
      Object.keys(out.samples).length === 2, JSON.stringify(Object.keys(out.samples)));
    check('as [t, longPct, price], not objects, because this file lives for months',
      Array.isArray(out.samples['EUR/USD'][0]) && out.samples['EUR/USD'][0].length === 3,
      JSON.stringify(out.samples['EUR/USD'][0]));
    check('and the column order is written down rather than left to be guessed',
      out.columns.join() === 't,longPct,price', out.columns.join());

    // ── It does not resample on every tick ──────────────────────────────────
    check('a second tick a minute later does nothing',
      (await r.tick(NOW + 60e3)) === null,
      'the book is a census of open accounts, not a tick stream');
    check('and four hours later it does', (await r.tick(NOW + SAMPLE_MS)) !== null);
    check('appending rather than replacing',
      hub.stored.samples['EUR/USD'].length === 2, String(hub.stored.samples['EUR/USD'].length));
  }

  // ── A refusal is remembered, not retried forever ───────────────────────────
  // Not every OANDA account is served this endpoint. Asking thirty instruments
  // for a 403 apiece every four hours helps nobody.
  {
    let calls = 0;
    const r = new BookRecorder({
      instruments: INST, github: fakeHub(), log: () => {},
      oanda: { async getPositionBook() { calls++; return { error: 'OANDA 403 forbidden' }; } },
    });
    await r.tick(NOW);
    const first = calls;
    await r.tick(NOW + SAMPLE_MS);
    check('a 4xx refusal is not asked again', calls === first, `${first} then ${calls}`);
    check('and it is recorded, so an empty series reads as "not entitled" rather '
        + 'than as "retail had no opinion"', r.refused.size === 2, String(r.refused.size));
  }

  // A 5xx is transient and must not be treated as a permanent refusal.
  {
    let calls = 0;
    const r = new BookRecorder({
      instruments: INST, github: fakeHub(), log: () => {},
      oanda: { async getPositionBook() { calls++; return { error: 'OANDA 503 unavailable' }; } },
    });
    await r.tick(NOW);
    await r.tick(NOW + SAMPLE_MS);
    check('a server error is retried, because it is not a property of the account',
      calls === 4, String(calls));
  }

  // ── Old rows age out, so the file cannot grow forever ──────────────────────
  {
    const old = NOW - (KEEP_DAYS + 10) * 86400e3;
    const hub = fakeHub({ version: 1, samples: { 'EUR/USD': [[old, 50, 1.1], [NOW - 86400e3, 60, 1.1]] } });
    const r = new BookRecorder({
      instruments: INST, github: hub, log: () => {},
      oanda: { async getPositionBook() { return okBook(70); } },
    });
    const out = await r.tick(NOW);
    check('a row older than the retention window is dropped',
      !out.samples['EUR/USD'].some(x => x[0] === old), JSON.stringify(out.samples['EUR/USD']));
    check('and the ones inside it are kept', out.samples['EUR/USD'].length === 2,
      String(out.samples['EUR/USD'].length));
  }

  // ── How much history exists ────────────────────────────────────────────────
  // The only number that matters while this is still collecting: a study of it
  // is not worth writing until there are months in the file.
  {
    check('an empty store has no span', spanOf({}) === 0);
    check('one sample is not a span', spanOf({ X: [[NOW, 50, 1]] }) === 0);
    check('span is measured in days across every instrument',
      spanOf({ A: [[NOW - 30 * 86400e3, 50, 1]], B: [[NOW, 50, 1]] }) === 30,
      String(spanOf({ A: [[NOW - 30 * 86400e3, 50, 1]], B: [[NOW, 50, 1]] })));
  }

  // ── Nothing is written when nothing answered ───────────────────────────────
  {
    const hub = fakeHub();
    const r = new BookRecorder({
      instruments: INST, github: hub, log: () => {},
      oanda: { async getPositionBook() { return null; } },
    });
    check('an empty result writes no file rather than an empty one',
      (await r.tick(NOW)) === null && hub.stored === null);
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('  FAIL  threw —', e.stack.split('\n').slice(0, 3).join(' ')); process.exit(1); });

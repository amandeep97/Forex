// The stop grid was checked as pure functions. This drives the real
// _refreshTf, because the bot is currently down and the next thing that happens
// to it is a restart onto this code — a crash in the record assembly would look
// exactly like the outage it is being restarted from, and I would have caused
// the second one while diagnosing the first.
const ROOT = require('path').join(__dirname, '..') + '/';
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const { FeedBuilder } = require(`${ROOT}vps-bot/src/feed.js`);

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// Bars with real structure in them: swings to break, wicks to sweep, and enough
// history that every timeframe has a complete forward window.
function series(n, seed) {
  const cs = [];
  let p = 100, s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < n; i++) {
    p *= 1 + (rnd() - 0.5) * 0.02 + Math.sin(i / 17) * 0.002;
    const o = p * (1 + (rnd() - 0.5) * 0.004);
    const h = Math.max(o, p) * (1 + rnd() * 0.006);
    const l = Math.min(o, p) * (1 - rnd() * 0.006);
    cs.push({ t: 1700000000000 + i * 86400000, o: +o.toFixed(5), h: +h.toFixed(5), l: +l.toFixed(5), c: +p.toFixed(5) });
  }
  return cs;
}

(async () => {
  const logs = [];
  const fb = new FeedBuilder({
    oanda: null,
    github: { readJSON: async () => null, writeJSON: async () => 'sha' },
    log: m => logs.push(String(m)),
  });
  // The only thing stubbed is where candles come from. Everything downstream —
  // measure, detectSweeps, detectBreaks, the pattern library, the forward pass
  // and the new stop grid — is the code that will run on the server.
  fb._candles = async () => series(500, 7);

  const inst = { sym: 'TEST/USD', name: 'Test', cls: 'fx', dec: 5, oanda: 'TEST_USD' };
  for (const tf of ['D', 'H4', 'H1', 'M30', 'M15']) {
    await fb._refreshTf(inst, tf);
  }

  const rec = fb.data['TEST/USD'];
  check('a record is built for every timeframe', Object.keys(rec.state).length === 5,
    Object.keys(rec.state).join(','));

  const withGrid = Object.entries(rec.rarity).filter(([, v]) => v.st);
  const withN = Object.entries(rec.rarity).filter(([, v]) => (v.fwdN || 0) >= 10);
  check('records with ten or more occurrences carry a grid',
    withGrid.length === withN.length && withGrid.length > 0,
    `${withGrid.length} grids for ${withN.length} eligible records`);
  check('and nothing below ten does',
    Object.values(rec.rarity).every(v => !v.st || v.fwdN >= 10));

  for (const [k, v] of withGrid) {
    if (v.st.length !== 3) return check(`${k} grid has three rows`, false, String(v.st.length));
    for (const row of v.st) {
      if (row.length !== 4) return check(`${k} row shape`, false, JSON.stringify(row));
      if (row.some(x => !Number.isFinite(x))) return check(`${k} finite`, false, JSON.stringify(row));
      if (row[0] + row[1] > 100) return check(`${k} rates sum past 100`, false, JSON.stringify(row));
      if (row[3] < 1) return check(`${k} exits before entering`, false, JSON.stringify(row));
    }
    if (v.tp.some(x => x != null && (x < 0 || x > 100))) return check(`${k} profile`, false, JSON.stringify(v.tp));
  }
  check('every published row is finite, well formed and internally consistent',
    withGrid.length > 0, `${withGrid.length} checked`);

  const bl = Object.entries(rec.baseline);
  check('every baseline carries both direction grids and a profile',
    bl.length === 5 && bl.every(([, b]) => b.stUp?.length === 3 && b.stDn?.length === 3 && b.tp?.length),
    bl.map(([tf, b]) => `${tf}:${b.stUp ? 'y' : 'n'}`).join(' '));

  // The size of the thing the phone downloads, per instrument, so a surprise
  // shows up here and not in a failed write.
  const bytes = JSON.stringify(rec).length;
  check('one instrument stays under 20 KB', bytes < 20000, `${(bytes / 1024).toFixed(1)} KB`);

  check('nothing was logged as a failure', !logs.some(l => /fail|error/i.test(l)), logs.join(' | '));

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('  FAIL  _refreshTf threw —', e.stack.split('\n').slice(0, 3).join(' ')); process.exit(1); });

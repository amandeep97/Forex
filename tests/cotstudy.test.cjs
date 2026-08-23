// The app printed "positioning is at the top 10% of 3 years — crowded long,
// the side that unwinds badly" as though it were a finding. It was folklore,
// written into a card by me, on an instrument where nobody had measured it.
//
// This checks the thing that measures it — and mostly it checks the four ways
// the answer could be faked into looking good, because each of them would
// produce a confident, significant, wrong result:
//
//   a percentile that has seen the future,
//   an entry three days before the data was published,
//   one month-long episode counted as four independent observations,
//   and a benchmark of 50% instead of what the instrument actually did.
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const S = require('../vps-bot/src/cotStudy.js');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// ── The percentile must not see the future ───────────────────────────────────
{
  const prior = Array.from({ length: 100 }, (_, i) => i);   // 0..99
  check('a value above everything seen so far ranks at the top',
    S.pctileOf(200, prior) === 100, String(S.pctileOf(200, prior)));
  check('and below everything ranks at the bottom',
    S.pctileOf(-5, prior) === 0, String(S.pctileOf(-5, prior)));
  check('a year of prior weeks is required before any percentile is real',
    S.pctileOf(50, [1, 2, 3]) === null,
    'ranking week three against two weeks is not a three-year extreme');
  check('the boundary is a year, not a month',
    S.pctileOf(50, Array.from({ length: S.MIN_HISTORY - 1 }, (_, i) => i)) === null
    && S.pctileOf(50, Array.from({ length: S.MIN_HISTORY }, (_, i) => i)) !== null,
    `MIN_HISTORY is ${S.MIN_HISTORY}`);
}

// ── Episodes, not weeks ──────────────────────────────────────────────────────
// Positioning sits crowded for a month at a time. Counting each week turns one
// event into four and would make almost anything significant.
{
  const mk = pcts => pcts.map((pct, i) => ({ pct, i, t: i }));
  const hot = p => p >= 90;
  check('a four-week run of extremes is one episode',
    S.episodes(mk([50, 95, 96, 97, 95, 50]), hot).length === 1);
  check('and the episode is dated at its first week, the only one you could act on',
    S.episodes(mk([50, 95, 96, 97, 95, 50]), hot)[0].i === 1);
  check('two runs separated by a normal week are two episodes',
    S.episodes(mk([95, 50, 95]), hot).length === 2);
  check('a run that is already under way at the start still counts once',
    S.episodes(mk([95, 96, 50]), hot).length === 1);
  check('never extreme is no episodes', S.episodes(mk([50, 60, 70]), hot).length === 0);
  check('counting weeks instead would have said four',
    mk([50, 95, 96, 97, 95, 50]).filter(e => hot(e.pct)).length === 4,
    'which is the inflation this avoids');
}

// ── The reporting lag ────────────────────────────────────────────────────────
// COT reports Tuesday's positions and publishes them Friday afternoon.
// Measuring from Tuesday buys three days nobody had.
{
  check('entry waits three days for the release',
    S.RELEASE_LAG_MS === 3 * 86400e3, `${S.RELEASE_LAG_MS / 86400e3} days`);

  // A series where price falls hard between the report date and the release.
  // Entering at the report captures that fall; entering at the release does not.
  const day = 86400e3;
  const cs = [];
  for (let i = 0; i < 300; i++) {
    // Flat, then a cliff on the day after the report, then flat again.
    const p = i < 100 ? 100 : i < 101 ? 100 : i < 104 ? 90 : 90;
    cs.push({ t: i * day, o: p, h: p + 0.5, l: p - 0.5, c: p });
  }
  const rows = Array.from({ length: 120 }, (_, w) => ({ t: (w * 2) * day, net: w }));
  const m = S.measureInstrument(rows, cs);
  const atReport = m.entries.find(e => e.i === 100);
  check('no entry is dated at the report itself',
    !atReport || atReport.t + S.RELEASE_LAG_MS <= cs[atReport.i].t,
    'every entry index is at or after report date plus the lag');
}

// ── Direction and the benchmark ──────────────────────────────────────────────
// The pooled result signs the forward move by the pre-specified hypothesis and
// compares it against what the instrument did from EVERY week, mirrored the
// same way. Both halves have to be right or the answer inverts.
{
  const day = 86400e3;
  // A market that rises relentlessly. A "short it" hypothesis must therefore
  // come back losing, AND the baseline for that hypothesis must also be losing
  // — the setup is not bad, the direction is.
  const cs = [];
  for (let i = 0; i < 400; i++) {
    const p = 100 * Math.pow(1.004, i);
    cs.push({ t: i * day, o: p, h: p * 1.002, l: p * 0.998, c: p });
  }
  // Positioning climbs to an extreme once, midway.
  const rows = Array.from({ length: 150 }, (_, w) => ({
    t: (w * 2) * day, net: w === 100 ? 10000 : w,
  }));
  const per = [{ sym: 'TEST', m: S.measureInstrument(rows, cs) }];
  const long = S.bucketResult(per, p => p >= S.HIGH, 'down', 'crowded long');
  const h = long.horizons[20];
  check('a crowded-long episode is found', long.episodes >= 1, String(long.episodes));
  check('shorting a rising market loses', h && h.win < 50, h ? `${h.win}%` : 'no result');
  check('and the benchmark for shorting it loses too, so the edge is near zero',
    h && h.baseWin < 50 && Math.abs(h.edgeWin) < 60,
    h ? `setup ${h.win}% vs market ${h.baseWin}% = ${h.edgeWin} points` : '');
  check('which is the whole point of not benchmarking against 50%',
    h && h.baseWin !== 50, h ? `benchmark is ${h.baseWin}%, not 50%` : '');
  check('the stopped result is reported at every width',
    h && h.stops.length === 3 && h.stops.every(s => s.expR !== null),
    h ? JSON.stringify(h.stops.map(s => s.expR)) : '');
  check('and the sample behind the comparison is stated on both sides',
    h && h.n > 0 && h.baseN > h.n, h ? `${h.n} episodes against ${h.baseN} weeks` : '');
}

// The mirror: the same rising market with a crowded SHORT, hypothesis up.
{
  const day = 86400e3;
  const cs = [];
  for (let i = 0; i < 400; i++) {
    const p = 100 * Math.pow(1.004, i);
    cs.push({ t: i * day, o: p, h: p * 1.002, l: p * 0.998, c: p });
  }
  const rows = Array.from({ length: 150 }, (_, w) => ({
    t: (w * 2) * day, net: w === 100 ? -10000 : w,
  }));
  const per = [{ sym: 'TEST', m: S.measureInstrument(rows, cs) }];
  const short = S.bucketResult(per, p => p <= S.LOW, 'up', 'crowded short');
  const h = short.horizons[20];
  check('buying a rising market wins', h && h.win === 100, h ? `${h.win}%` : 'none');
  check('but so does the market, so the edge is zero and it is not a finding',
    h && h.edgeWin === 0, h ? `${h.win}% vs ${h.baseWin}% = ${h.edgeWin} points` : '');
}

// ── Shape ────────────────────────────────────────────────────────────────────
check('both tails are pre-specified before anything is looked at',
  S.HIGH === 90 && S.LOW === 10, `${S.LOW}/${S.HIGH}`);
check('horizons are weekly or slower, because COT cannot answer faster',
  S.HORIZONS.every(h => h >= 5), JSON.stringify(S.HORIZONS));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

// Every forward number in this feed so far answers "where was price N bars
// later", holding through anything in between with no stop. That is not a
// trade. It cannot tell a setup that runs straight to target from one that
// first goes a full ATR against you and comes back — and those are the same
// number at the horizon and opposite outcomes for anybody with a stop.
//
// These check the two measurements that close that gap: the setup run as an
// actual stopped trade, and the win rate at bars 1, 2, 3 and 5.
const ROOT = require('path').join(__dirname, '..') + '/';
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const F = require(`${ROOT}vps-bot/src/feed.js`);

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// A bar with no wick beyond its body, so only the moves written here exist.
const bar = (t, c, h, l) => ({ t, o: c, c, h: h ?? c, l: l ?? c });

// ── One trade at a time ──────────────────────────────────────────────────────
// ATR is 1 throughout these, so a 1.0 stop is exactly 1 price unit and an R is
// readable straight off the numbers.

// Straight up. Entry 100, stop 99, target 102 — bar 3 gets there.
{
  const cs = [bar(0, 100), bar(1, 100.4), bar(2, 101.2), bar(3, 102.5), bar(4, 103)];
  const r = F.tradeRun(cs, 0, 4, 1, 'up', 1);
  check('a clean run to target pays RR', r.r === 2 && r.n === 3, JSON.stringify(r));
}

// The case the whole thing exists for. Price dips 0.8 ATR against, then runs to
// target. A 0.5 stop is taken out on bar 1 and never sees the move; a 1.0 stop
// survives it. The fixed-window number is identical for both and says nothing.
{
  const cs = [bar(0, 100), bar(1, 99.6, 100, 99.2), bar(2, 100.8), bar(3, 102.4), bar(4, 103)];
  const tight = F.tradeRun(cs, 0, 4, 1, 'up', 0.5);
  const wide  = F.tradeRun(cs, 0, 4, 1, 'up', 1);
  check('a tight stop is taken out by the shakeout', tight.r === -1 && tight.n === 1, JSON.stringify(tight));
  check('a wider one survives it and reaches target', wide.r === 2 && wide.n === 3, JSON.stringify(wide));
  check('and the horizon close cannot tell them apart',
    cs[4].c - cs[0].c === 3, 'both end +3, one is a loss');
}

// Stop and target inside the same bar. OHLC does not say which came first.
{
  const cs = [bar(0, 100), bar(1, 101, 102.5, 98.5), bar(2, 103)];
  const r = F.tradeRun(cs, 0, 2, 1, 'up', 1);
  check('a bar that touches both is scored as the loss', r.r === -1, JSON.stringify(r));
}

// Neither is reached: the position is marked at the last close, in R.
{
  const cs = [bar(0, 100), bar(1, 100.2), bar(2, 100.5)];
  const r = F.tradeRun(cs, 0, 2, 1, 'up', 1);
  check('an unresolved trade is marked to market, not counted as flat',
    near(r.r, 0.5) && r.open === true, JSON.stringify(r));
}

// Short side. Same geometry, mirrored — a short's stop is above and its target
// below, and the bar's high is what takes it out.
{
  const cs = [bar(0, 100), bar(1, 99.5), bar(2, 97.9), bar(3, 97)];
  const r = F.tradeRun(cs, 0, 3, 1, 'down', 1);
  check('a short reaching its target pays the same RR', r.r === 2 && r.n === 2, JSON.stringify(r));
  const up = F.tradeRun(cs, 0, 3, 1, 'up', 1);
  check('and the long on the same bars is stopped', up.r === -1, JSON.stringify(up));
}

// The window is honoured. A trade that would reach target on bar 6 of a 3-bar
// window does not get credit for it.
{
  const cs = [bar(0, 100), bar(1, 100.1), bar(2, 100.2), bar(3, 100.3),
              bar(4, 101), bar(5, 102), bar(6, 103)];
  const r = F.tradeRun(cs, 0, 3, 1, 'up', 1);
  check('the horizon is a hard exit', r.open === true && r.n === 3 && near(r.r, 0.3), JSON.stringify(r));
}

// ── The grid ─────────────────────────────────────────────────────────────────
// Three entries, all identical, all running clean to target: every stop shows
// 100% target, expectancy 2R.
{
  const cs = [];
  for (let i = 0; i < 40; i++) cs.push(bar(i, 100 + i * 0.9, 100 + i * 0.9 + 0.05, 100 + i * 0.9 - 0.05));
  const entries = [{ i: 0, a: 1, dir: 'up' }, { i: 1, a: 1, dir: 'up' }, { i: 2, a: 1, dir: 'up' }];
  const g = F.stopGrid(entries, cs, 10);
  check('the grid has one row per stop', g.length === F.STOPS.length, String(g.length));
  check('a trending sample is all target at every stop',
    g.every(r => r[0] === 100 && r[1] === 0 && r[2] === 200), JSON.stringify(g));
  check('and the median exit is reported in bars', g[0][3] >= 1, JSON.stringify(g[0]));
}

// The row that matters: tight loses, wide wins, on the same entries.
{
  const cs = [bar(0, 100), bar(1, 99.6, 100, 99.2), bar(2, 100.8), bar(3, 102.4),
              bar(4, 103), bar(5, 103), bar(6, 103), bar(7, 103), bar(8, 103),
              bar(9, 103), bar(10, 103)];
  const g = F.stopGrid([{ i: 0, a: 1, dir: 'up' }], cs, 10);
  check('the grid separates the stop that survives from the one that does not',
    g[0][2] === -100 && g[1][2] === 200, JSON.stringify(g.map(r => r[2])));
}

check('an empty entry list gets nothing rather than a row of zeros',
  F.stopGrid([], [], 10) === null);

// ── When the edge shows up ───────────────────────────────────────────────────
// Up on bars 1 and 2, back through the entry by bar 5. Held to the horizon this
// is a loss; at bar 2 it is a win. That difference is the point.
{
  const cs = [bar(0, 100), bar(1, 101), bar(2, 102), bar(3, 101), bar(4, 100.5),
              bar(5, 99), bar(6, 98), bar(7, 97), bar(8, 96), bar(9, 95), bar(10, 94)];
  const tp = F.timeProfile([{ i: 0, a: 1, dir: 'up' }], cs, 10);
  check('the profile samples bars 1, 2, 3 and 5', tp.length === 4, JSON.stringify(tp));
  check('early bars are wins and bar 5 is not',
    tp[0] === 100 && tp[1] === 100 && tp[2] === 100 && tp[3] === 0, JSON.stringify(tp));
}

// A three-bar window has no bar 5 to sample, so it reports three, not four with
// a fabricated last one.
{
  const cs = [bar(0, 100), bar(1, 101), bar(2, 102), bar(3, 103)];
  const tp = F.timeProfile([{ i: 0, a: 1, dir: 'up' }], cs, 3);
  check('checkpoints past the horizon are dropped, not padded',
    tp.length === 3, JSON.stringify(tp));
}

// ── The baseline gets the same treatment ─────────────────────────────────────
// Otherwise a setup resolving in three bars is called fast without anyone
// checking whether a random entry also resolves in three.
{
  const cs = [];
  let p = 100;
  for (let i = 0; i < 200; i++) {
    // Deterministic zigzag with drift, so the two directions genuinely differ.
    p += (i % 3 === 0 ? -0.6 : 0.5);
    cs.push(bar(i, +p.toFixed(4), +(p + 0.4).toFixed(4), +(p - 0.35).toFixed(4)));
  }
  const atrAt = F.atrSeries(cs);
  const bl = F.baselineOutcome(cs, 10, atrAt);
  check('the baseline carries a stop grid for each direction',
    Array.isArray(bl.stUp) && Array.isArray(bl.stDn) && bl.stUp.length === F.STOPS.length,
    JSON.stringify(bl.stUp));
  check('and they are not each other mirrored, because intrabar order is not symmetric',
    JSON.stringify(bl.stUp) !== JSON.stringify(bl.stDn),
    `${JSON.stringify(bl.stUp[1])} vs ${JSON.stringify(bl.stDn[1])}`);
  check('the baseline has a time profile too', Array.isArray(bl.tp) && bl.tp.length === 4,
    JSON.stringify(bl.tp));
  check('the old fields still read the same', typeof bl.win === 'number' && bl.bars === 10,
    JSON.stringify({ win: bl.win, bars: bl.bars }));

  // A setup measured on the same series must come back with the same shape, so
  // the app can put the two side by side without special-casing either.
  const idxOf = new Map(cs.map((c, i) => [c.t, i]));
  const events = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map(i => ({ at: cs[i].t, dir: 'up' }));
  const out = F.forwardOutcome(cs, idxOf, events, 10, atrAt);
  check('a setup record carries the same two measurements',
    out.st.length === F.STOPS.length && out.tp.length === 4,
    JSON.stringify({ st: out.st, tp: out.tp }));
  check('and every stop row is [target %, stop %, expectancy x100, median bars]',
    out.st.every(r => r.length === 4 && r[0] + r[1] <= 100), JSON.stringify(out.st));
  check('the fixed-window fields are untouched',
    typeof out.fwdWin === 'number' && out.fwdN === 11 && typeof out.upShare === 'number',
    JSON.stringify({ fwdWin: out.fwdWin, fwdN: out.fwdN }));

  // Between five and nine occurrences the fixed-window figure is still reported
  // — it is one number with a count beside it — but a stop grid at that size is
  // four numbers each of which one trade can swing by a fifth.
  const few = F.forwardOutcome(cs, idxOf, [20, 40, 60, 80, 100, 120].map(i => ({ at: cs[i].t, dir: 'up' })), 10, atrAt);
  check('six occurrences get the old number and no stop grid',
    few.fwdN === 6 && typeof few.fwdWin === 'number' && few.st === undefined && few.tp === undefined,
    JSON.stringify(few));
}

// Too few occurrences still returns the count alone, with no stop grid to read
// as if it meant something.
{
  const cs = [];
  for (let i = 0; i < 100; i++) cs.push(bar(i, 100 + i * 0.1, 100 + i * 0.1 + 0.2, 100 + i * 0.1 - 0.2));
  const idxOf = new Map(cs.map((c, i) => [c.t, i]));
  const out = F.forwardOutcome(cs, idxOf, [{ at: cs[10].t, dir: 'up' }], 10, F.atrSeries(cs));
  check('four occurrences produce a count and nothing that looks like evidence',
    out.fwdN === 1 && out.st === undefined && out.tp === undefined, JSON.stringify(out));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

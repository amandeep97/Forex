'use strict';
// Replaying the sweep model over history — vps-bot/src/liquidityStudy.js.
//
// A backtest is the easiest place in this whole codebase to produce a number
// that is wrong and looks right. Every check here is aimed at one specific way
// this could lie:
//
//   LOOKAHEAD. Levels built from candles that had not closed yet. Yesterday's
//   high is knowable at 09:00; today's is not, and a model that knows it prints
//   a wonderful equity curve and loses money.
//
//   DOUBLE COUNTING. A sweep stays detectable for the whole sixty-bar window.
//   Without suppression one liquidity event becomes thirty trades, the sample
//   size inflates by thirty, and every significance test after that is fiction.
//
//   NO BASELINE. A long that pays 0.1R is an edge in a flat market and a
//   failure in one that drifted up 0.3R over the same bars. Without the
//   instrument's own baseline the number cannot be read at all.
//
//   AND A PASS THAT IS NOT A PASS. A cell that beats its baseline on the half
//   it was chosen from, and nowhere else, has found the half it was chosen
//   from.
const S = require('../vps-bot/src/liquidityStudy');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const M2 = 120e3, DAY = 86400e3;

function bar(t, o, c, hPad = 0.2, lPad = 0.05) {
  return { t, o, c, h: Math.max(o, c) + hPad, l: Math.min(o, c) - lPad, v: 1 };
}

// Sessions moved to tests/context.test.mjs when the definition moved to
// shared/sessions.mjs. They are tested with the module that owns them rather
// than with one of its three readers.

// ── The threshold is corrected for how many cells were looked at ──────────
{
  check('the bar is higher than a single-test 1.96',
    S.strictZ() > 1.96, S.strictZ().toFixed(3),
    'twenty-four cells means twenty-four chances to be fooled');
  check('and it is derived from the cell count, not typed in',
    Math.abs(S.strictZ() - S.probit(1 - 0.025 / S.CELLS)) < 1e-9,
    `${S.CELLS} cells`);
}

// ── Lookahead: the replay must not know today's high ───────────────────────
(async () => {
  {
    const lib = await import('../shared/liquidity.mjs');
    // Three days. The LAST day has a wild high that must never appear in any
    // level set built during that day.
    const daily = [
      { t: Date.UTC(2026, 8, 11), o: 100, h: 110, l: 95, c: 105 },
      { t: Date.UTC(2026, 8, 12), o: 105, h: 118, l: 101, c: 112 },
      { t: Date.UTC(2026, 8, 14), o: 112, h: 999, l: 111, c: 112 },   // today
    ];
    const weekly = [
      { t: Date.UTC(2026, 8, 6), o: 90, h: 120, l: 88, c: 115 },
      { t: Date.UTC(2026, 8, 13), o: 115, h: 130, l: 108, c: 120 },
    ];
    // Starts well before the 14th: buildLevelTimeline needs twenty bars of
    // warm-up, so a series beginning on the 12th produces its first entry on
    // the 15th and the day under test would have no sets at all.
    const h4 = [];
    for (let i = 0; i < 60; i++) {
      h4.push(bar(Date.UTC(2026, 8, 8) + i * 4 * 3600e3, 100 + i, 100.5 + i));
    }
    const tl = await S.buildLevelTimeline(lib, { daily, weekly, h4 });

    // Entries built DURING the 14th. From the 15th onward the 14th's candle has
    // genuinely closed and its high IS yesterday's high, so including those
    // would assert that a replay may never learn anything, which is the
    // opposite of the point.
    const duringToday = tl.filter(e => e.from >= Date.UTC(2026, 8, 14)
      && e.from < Date.UTC(2026, 8, 15));
    check('no level set built today contains today\'s high',
      duringToday.length > 0
      && duringToday.every(e => e.levels.every(l => l.price !== 999)),
      `${duringToday.length} set(s) checked`,
      'this is the single easiest way for a backtest to print a fortune it could never have made');

    check('and the levels it DOES have are the ones that had closed',
      tl.length > 0 && tl[tl.length - 1].levels.some(l => l.kind === 'PDH'),
      tl[tl.length - 1]?.levels.map(l => l.kind).join(',') || '(none)');

    check('every timeline entry is built only from candles older than itself',
      tl.every(e => {
        const future = daily.filter(d => d.t >= e.from);
        return future.every(f => !e.levels.some(l => l.price === f.h || l.price === f.l));
      }),
      'checked against every daily candle that had not closed');
  }

  // ── Double counting: one sweep is one trade ──────────────────────────────
  {
    const lib = await S.loadLib();
    // loadLib, not a bare namespace: replayOne needs sessions as well as
    // liquidity, and building the handle differently here than the code does
    // is how a test passes against a shape production never sees.
    // A sweep of 110 that stays detectable for many bars afterwards.
    const m2 = [];
    let t = Date.UTC(2026, 8, 14, 8), p = 104;
    const push = (n, step) => {
      for (let i = 0; i < n; i++) { const o = p, c = p + step; m2.push(bar(t, o, c, step > 0 ? 0.2 : 0.05, step > 0 ? 0.05 : 0.2)); p = c; t += M2; }
    };
    push(130, 0.01);          // quiet lead-in so the window is full
    push(20, 0.4);            // up through 110
    push(10, -0.3);           // back below
    push(6, 0.2);             // pull back, leaving a swing low
    push(30, -0.3);           // and break it, repeatedly detectable
    push(120, -0.02);         // room for the trade to run

    const timeline = [{ from: 0, levels: [
      { kind:'PDH', price:110, side:'high', label:"yesterday's high" },
    ] }];

    const entries = S.replayOne(lib, 'TEST', m2, timeline, { hold: 15 });
    check('one liquidity event produces at most a couple of entries, not thirty',
      entries.length <= 3, `${entries.length} entries`,
      'without suppression the sample inflates and every significance test downstream is fiction');

    check('and the entries it does produce are tagged with kind, session and side',
      entries.every(e => e.kind && e.session && (e.dir === 'up' || e.dir === 'down')),
      entries[0] ? `${entries[0].kind} ${entries[0].session} ${entries[0].dir}` : '(none)');

    check('a swept HIGH is replayed as a short',
      entries.every(e => e.dir === 'down'),
      entries.map(e => e.dir).join(','),
      'the direction error that lived in the bot for months would double the measured edge if it came back here');

    check('no entry is taken without room to see the trade finish',
      entries.every(e => e.i + 15 < m2.length),
      'an entry whose horizon runs off the end is a trade with no outcome');
  }

  // ── Baselines, without which the numbers cannot be read ─────────────────
  {
    const lib = await S.loadLib();
    // A market that drifts UP on every bar. A long here should look good and
    // mean nothing, which is exactly what the baseline exists to say.
    const drift = [];
    let t = Date.UTC(2026, 8, 14), p = 100;
    for (let i = 0; i < 600; i++) { drift.push(bar(t, p, p + 0.05)); p += 0.05; t += M2; }

    const up = S.baselineFor(lib, drift, 'up', 15, lib.exits.DEFAULT_EXIT);
    const down = S.baselineFor(lib, drift, 'down', 15, lib.exits.DEFAULT_EXIT);
    check('a drifting market has a NON-zero baseline, and that is the point',
      up && up.expR > 0 && down && down.expR < 0,
      `long ${up?.expR.toFixed(2)}R, short ${down?.expR.toFixed(2)}R`,
      'a long that pays 0.1R here has found the drift, not an edge');

    check('a baseline reports how many samples it used',
      up.n > 1, `${up.n} samples`,
      'a baseline from three bars is a number with no meaning behind it');
  }

  // ── The verdict has to name the failure, not round it up ────────────────
  {
    const cell = (d, tt, u) => S.verdict({ discovery: d, time: tt, unseen: u });
    const good = { n: 60, edgeR: 0.30, sd: 0.4, expR: 0.3, win: 0.6 };
    const strong = { n: 200, edgeR: 0.30, sd: 0.4, expR: 0.3, win: 0.6 };

    check('too few entries is thin, not a pass',
      cell({ n: 5, edgeR: 9, sd: 0.1 }, good, good) === 'thin');
    check('no time holdout is named as such',
      cell(strong, { n: 2, edgeR: 0.3, sd: 0.4 }, good) === 'no time holdout');
    check('no instrument holdout is named as such',
      cell(strong, good, { n: 2, edgeR: 0.3, sd: 0.4 }) === 'no instrument holdout');

    check('an edge too small for its own noise is not significant',
      cell({ n: 60, edgeR: 0.01, sd: 2.0 }, good, good) === 'not significant',
      'the corrected threshold, not a positive sign, is what a pass has to clear');

    check('passing discovery but dying on other instruments says so',
      cell(strong, good, { ...good, edgeR: -0.2 }) === 'fades on other instruments',
      'this is the failure that looks most like a success');
    check('passing discovery but dying in time says so',
      cell(strong, { ...good, edgeR: -0.2 }, good) === 'fades in time');
    check('dying on both is a plain failure',
      cell(strong, { ...good, edgeR: -0.2 }, { ...good, edgeR: -0.2 }) === 'fails');

    check('and only surviving BOTH holdouts holds',
      cell(strong, good, good) === 'holds',
      'one holdout is a filter; two is the claim');
  }

  // ── The instrument split cannot be reshuffled into a pass ───────────────
  {
    const uni = [
      { sym:'A', cls:'fx' }, { sym:'B', cls:'fx' }, { sym:'C', cls:'fx' }, { sym:'D', cls:'fx' },
      { sym:'X', cls:'metal' }, { sym:'Y', cls:'metal' },
    ];
    const one = S.splitUniverse(uni);
    const two = S.splitUniverse([...uni].reverse());
    check('the split is deterministic, so a cell dying is not the split moving',
      JSON.stringify(one.search.map(s => s.sym)) === JSON.stringify(two.search.map(s => s.sym)),
      one.search.map(s => s.sym).join(','));
    check('and each class is represented on both sides',
      one.search.some(s => s.cls === 'metal') && one.proof.some(s => s.cls === 'metal'),
      'a holdout made entirely of one asset class tests the class, not the model');
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

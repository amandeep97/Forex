// How a trade ends — shared/exits.mjs.
//
// Every rule this project has ever tested was scored with ONE exit: a stop one
// ATR away, a target at twice it, out at the horizon. 232 combinations, 12
// carried, none survived. That is a result about a PAIR, reported as a result
// about entries.
//
// One ATR on hourly gold is about twenty-five dollars, which ordinary noise
// takes out. So a condition could predict direction perfectly and fail every
// test run here, and nothing could tell that apart from the condition being
// worthless. These checks are mostly about keeping those two answers separate.
import {
  EXITS, DEFAULT_EXIT, TIME_ONLY, TIME_ONLY_RISK_ATR, exitById,
  runTrade, exitDiagnosis,
} from '../shared/exits.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

const H = 3600e3, T0 = Date.UTC(2026, 0, 5);
const bar = (o, h, l, c) => ({ o, h, l, c });
const stamp = arr => arr.map((b, k) => ({ t: T0 + k * H, v: 1, ...b }));

// ── The grid is small and each entry changes one thing ──────────────────────
{
  check('there is a time-only exit, and it is the point of the file',
    TIME_ONLY.stopAtr === null && TIME_ONLY.rr === null,
    'no stop is the only way to ask whether the STOP is what kills a rule');
  check('the default is the exit every previous study used',
    DEFAULT_EXIT.stopAtr === 1 && DEFAULT_EXIT.rr === 2,
    'so a study that passes no exit is unchanged by any of this');
  check('the grid is small enough to mean something',
    EXITS.length <= 6, `${EXITS.length} exits`,
    'a finer grid finds a better-looking combination every run and means nothing');
  check('every exit has a unique id and a readable label',
    new Set(EXITS.map(e => e.id)).size === EXITS.length
    && EXITS.every(e => typeof e.label === 'string' && e.label.length > 5));
  check('and one can be looked up by id, or refused',
    exitById('s1r2') === DEFAULT_EXIT && exitById('nope') === null);
}

// ── The stop is taken when both are hit in one bar ──────────────────────────
{
  // Entry at 100, ATR 1, one ATR stop at 99, 2R target at 102. A bar that
  // reaches BOTH. The OHLC cannot order them.
  const cs = stamp([bar(100, 100, 100, 100), bar(100, 103, 98, 101)]);
  const r = runTrade(cs, 0, 5, 1, 'up', DEFAULT_EXIT);
  check('a bar touching stop and target is scored as the LOSS',
    r.r === -1 && r.how === 'stop',
    'assuming the target is exactly how a backtest manufactures an edge');
}

// ── A wider stop survives what a tight one does not ─────────────────────────
//
// The whole hypothesis, as an arithmetic fact rather than an opinion. Price
// dips to 98.5, then runs to 105. A one ATR stop at 99 is taken out. A two ATR
// stop at 98 is not, and the trade reaches its target.
{
  const cs = stamp([
    bar(100, 100, 100, 100),
    bar(100, 100.5, 98.5, 99),     // the dip
    bar(99, 102, 99, 101),
    bar(101, 105, 101, 105),       // the run
  ]);
  const tight = runTrade(cs, 0, 5, 1, 'up', exitById('s1r2'));
  const wide = runTrade(cs, 0, 5, 1, 'up', exitById('s2r2'));
  check('a one ATR stop is taken out by the dip',
    tight.r === -1 && tight.how === 'stop', `${tight.r}R`);
  check('and a two ATR stop rides it to the target',
    wide.r === 2 && wide.how === 'target', `${wide.r}R`,
    'the entry was right both times; only the exit differed');
}

// ── Time-only measures the move, with no stop at all ────────────────────────
{
  const cs = stamp([
    bar(100, 100, 100, 100),
    bar(100, 100.5, 96, 99),       // a dip that would take out any stop tested
    bar(99, 102, 99, 102),
    bar(102, 103, 102, 103),
  ]);
  const t = runTrade(cs, 0, 3, 1, 'up', TIME_ONLY);
  check('time-only ignores the dip and measures where it ended',
    near(t.r, 3) && t.how === 'horizon', `${t.r}R`,
    'entry 100, out at 103, one ATR of reference risk');
  check('and every stopped exit loses the same trade',
    EXITS.filter(e => e.stopAtr != null)
      .every(e => runTrade(cs, 0, 3, 1, 'up', e).r === -1),
    'this is the shape of an entry that works and an exit that does not');
  check('the reference risk is stated rather than hidden',
    TIME_ONLY_RISK_ATR === 1);

  // Direction has to be handled, not assumed.
  const d = runTrade(cs, 0, 3, 1, 'down', TIME_ONLY);
  check('a short is the mirror', near(d.r, -3), `${d.r}R`);
}

// ── R stays comparable across stop widths ───────────────────────────────────
{
  // A clean 2R win is 2R whether the stop was one ATR or two, because a wider
  // stop means a smaller position for the same money at risk. That is only
  // true because sizing now comes from the stop distance.
  const cs = stamp([
    bar(100, 100, 100, 100),
    bar(100, 110, 100, 110),
  ]);
  const a = runTrade(cs, 0, 3, 1, 'up', exitById('s1r2'));
  const b = runTrade(cs, 0, 3, 1, 'up', exitById('s2r2'));
  check('a 2R target pays 2R on either stop width',
    a.r === 2 && b.r === 2, `${a.r} and ${b.r}`);
  const c = runTrade(cs, 0, 3, 1, 'up', exitById('s1r1'));
  check('and a 1R target pays 1R, so the target is in the number too',
    c.r === 1, `${c.r}`);
}

// ── The diagnosis names which half was wrong ────────────────────────────────
{
  const stopIsProblem = exitDiagnosis({
    time: { edgeR: 0.4 }, s1r2: { edgeR: -0.2 }, s2r2: { edgeR: -0.05 },
    s1r1: { edgeR: -0.1 }, s15r3: { edgeR: -0.3 },
  });
  check('paying with no stop and losing with every stop is named',
    stopIsProblem?.kind === 'stop-is-the-problem', stopIsProblem?.kind);
  check('and the sentence says the direction was right',
    /direction is right/.test(stopIsProblem.text), stopIsProblem.text.slice(0, 70));

  const exitWorks = exitDiagnosis({
    time: { edgeR: -0.1 }, s1r2: { edgeR: 0.3 }, s2r2: { edgeR: 0.1 },
    s1r1: { edgeR: 0.05 }, s15r3: { edgeR: 0.02 },
  });
  check('an edge that lives entirely in the exit is named separately',
    exitWorks?.kind === 'exit-is-doing-the-work', exitWorks?.kind,
    'worth knowing before treating the condition as a signal');

  const nothing = exitDiagnosis({
    time: { edgeR: -0.2 }, s1r2: { edgeR: -0.3 }, s2r2: { edgeR: -0.1 },
    s1r1: { edgeR: -0.4 }, s15r3: { edgeR: -0.2 },
  });
  check('and when nothing pays it says the CONDITION is the problem',
    nothing?.kind === 'nothing-there' && /condition is the problem/.test(nothing.text),
    'which is the answer every study here has been reporting without being able to prove it');

  const both = exitDiagnosis({
    time: { edgeR: 0.2 }, s1r2: { edgeR: 0.35 }, s2r2: { edgeR: 0.1 },
    s1r1: { edgeR: 0.05 }, s15r3: { edgeR: 0.02 },
  });
  check('paying both ways names the best exit',
    both?.kind === 'both' && /1 ATR stop, target at 2R/.test(both.text), both.text.slice(0, 60));

  check('missing data gives no diagnosis rather than a guess',
    exitDiagnosis(null) === null
    && exitDiagnosis({ time: { edgeR: 0.2 } }) === null
    && exitDiagnosis({ time: null, s1r2: { edgeR: 0.2 } }) === null,
    'no time-only result means the comparison cannot be made at all');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

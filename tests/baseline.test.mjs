// Beating the market, not beating a coin.
//
// A forward outcome is signed by the event's own direction, so in a market that
// drifted up over the sample every bullish pattern "works" and every bearish
// one "fails" whether or not either means anything. That is exactly what the
// live board showed: five surviving setups, four of them bullish patterns, and
// the failures almost all bearish ones — across every asset class at once.
// Patterns do not behave like that. Rising markets do.
import { pooledRecords, verdictOf, zFor, MIN_EDGE_ATR } from '../src/utils/confluence.js';
import { atrSeries, baselineOutcome, forwardOutcome } from '../vps-bot/src/feed.js';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// ── The bot half ──────────────────────────────────────────────────────────
const T0 = 1500000000000, D = 86400e3;
const rising = Array.from({ length: 300 }, (_, i) =>
  ({ t: T0 + i*D, o: 100+i*0.3, h: 100.5+i*0.3, l: 99.5+i*0.3, c: 100+i*0.3 }));
const bl = baselineOutcome(rising, 10, atrSeries(rising));
check('a rising market has a baseline far above a coin flip', bl.win > 90, `${bl.win}%`);
check('and a large positive median', bl.medAtr > 1, `${bl.medAtr} ATR`);

const idxOf = new Map(rising.map((c, i) => [c.t, i]));
const marks = [40, 60, 80, 100, 120, 140].map(i => ({ at: rising[i].t, dir: 'up' }));
const bull = forwardOutcome(rising, idxOf, marks, 10);
check('a bullish pattern in that market also scores 100%', bull.fwdWin === 100, `${bull.fwdWin}%`);
check('which is exactly the trap — it matches the baseline',
  bull.fwdWin === bl.win, `pattern ${bull.fwdWin}% vs market ${bl.win}%`);
check('the direction split is published so the baseline can be mirrored',
  bull.upShare === 1, String(bull.upShare));
const bear = forwardOutcome(rising, idxOf, marks.map(m => ({ ...m, dir: 'down' })), 10);
check('and a bearish one scores zero for the same reason', bear.fwdWin === 0);
check('its split is recorded too', bear.upShare === 0, String(bear.upShare));

// ── The app half ──────────────────────────────────────────────────────────
// Four instruments so a pool forms, each carrying the same story.
const feedOf = (patWin, patMed, baseWin, baseMed, up = 1) => ({
  updatedAt: new Date(T0).toISOString(),
  instruments: Object.fromEntries(['A','B','C','D'].map(s => [s, {
    cls: 'fx', price: 100, dec: 2, state: {}, events: [], patterns: {}, asOf: {},
    baseline: { D: { bars: 10, n: 1000, win: baseWin, medAtr: baseMed } },
    rarity: { 'hammer.D': { perMonth: 1, n: 200, fwdBars: 10, fwdN: 200,
                            fwdWin: patWin, fwdMedAtr: patMed, upShare: up } },
  }])),
});

// The trap: a pattern that looks superb and only matches its market.
const trap = pooledRecords(feedOf(70, 1.2, 70, 1.2))['fx|hammer.D'];
check('the pooled record knows what the market did', trap.baseWin === 70, String(trap.baseWin));
check('so a 70% pattern in a 70% market has no edge', trap.edgeWin === 0, String(trap.edgeWin));
check('and none in the median either', trap.edgeMed === 0, String(trap.edgeMed));
check('it is reported as saying nothing', verdictOf(trap, 91) === 'silent', verdictOf(trap, 91));
check('where the old test called it a finding',
  (() => { const { baseWin, ...noBase } = trap; return verdictOf(noBase, 91); })() === 'works');

// A real edge: the same 70%, in a market that only did 50%.
const real = pooledRecords(feedOf(70, 1.2, 50, 0.1))['fx|hammer.D'];
check('a 70% pattern in a 50% market keeps its edge', real.edgeWin === 20, String(real.edgeWin));
check('and is reported as working', verdictOf(real, 91) === 'works', verdictOf(real, 91));

// A pattern that does WORSE than simply being there.
const worse = pooledRecords(feedOf(55, 0.2, 75, 1.5))['fx|hammer.D'];
check('beating a coin while losing to the market is a failure',
  worse.edgeWin === -20 && verdictOf(worse, 91) === 'fails',
  `edge ${worse.edgeWin} → ${verdictOf(worse, 91)}`);

// Real edge, too small to collect.
const small = pooledRecords(feedOf(62, 0.62, 50, 0.5))['fx|hammer.D'];
check('an edge smaller than the spread is real and not worth taking',
  verdictOf(small, 1) === 'tiny', `edgeMed ${small.edgeMed} → ${verdictOf(small, 1)}`);

// ── A bearish pattern mirrors the baseline ────────────────────────────────
// The same rising market. A bearish pattern scoring 30% is not failing; it is
// doing exactly what the market says it should.
const bearPool = pooledRecords(feedOf(30, -1.2, 70, 1.2, 0))['fx|hammer.D'];
check('a bearish setup is judged against the mirrored baseline',
  bearPool.baseWin === 30, `${bearPool.baseWin}% (market was 70% up)`);
check('so 30% in a rising market is no edge, not a failure',
  bearPool.edgeWin === 0 && verdictOf(bearPool, 91) === 'silent',
  `edge ${bearPool.edgeWin} → ${verdictOf(bearPool, 91)}`);
check('and the mirrored median follows', bearPool.baseMed === -1.2, String(bearPool.baseMed));

// ── A mixed population sits between the two ───────────────────────────────
const mixed = pooledRecords(feedOf(50, 0, 70, 1.2, 0.5))['fx|hammer.D'];
check('an even up/down split gives a 50% benchmark, as it must',
  mixed.baseWin === 50 && mixed.baseMed === 0,
  `${mixed.baseWin}% / ${mixed.baseMed} ATR`);

// ── Old feeds degrade instead of disappearing ─────────────────────────────
const legacy = { win: 70, n: 200, med: 1.2 };
check('a record with no baseline still gets a verdict',
  verdictOf(legacy, 1) === 'works', verdictOf(legacy, 1));
check('and the correction for many tests still applies to it',
  verdictOf({ win: 55, n: 420, med: 0.58 }, 91) !== 'works');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

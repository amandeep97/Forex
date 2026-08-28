// The condition vocabulary — shared/moveFeatures.mjs.
//
// This is the file the whole regime study rests on. If a feature here can see a
// bar that has not happened yet, every number downstream is fiction, and it will
// look wonderful right up until it is real money. So most of these check the
// clock rather than the arithmetic.
import {
  atrSeries, emaSeries, featureSeries, keysOf, fires, zigzag, legsOf,
  sessionOf, roundStepFor, PHRASE, labelOf, DRIVE_BARS,
} from '../shared/moveFeatures.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const H = 3600e3;

// Bars on the hour from a fixed Monday, so the session and day-boundary tests
// are about the code and not about when they happened to be run.
const MON = Date.UTC(2026, 0, 5, 0, 0, 0);
function bars(n, f) {
  const cs = [];
  for (let i = 0; i < n; i++) {
    const b = f(i, cs);
    cs.push({ t: MON + i * H, v: 1, ...b });
  }
  return cs;
}
const flat = (n, px = 100, rng = 1) =>
  bars(n, () => ({ o: px, h: px + rng / 2, l: px - rng / 2, c: px }));

// ── Nothing may look forward ────────────────────────────────────────────────
// The one that matters. Every other check in this repository is downstream of
// it: a feature that peeks at bar i+1 makes a study that cannot be traded.
{
  const cs = flat(900, 100, 1);
  const a = featureSeries(cs, { sym: 'XAU_USD' });

  // Change the future and nothing about the present may move.
  const cs2 = cs.map((c, i) => (i > 700 ? { ...c, c: c.c * 3, h: c.h * 3, l: c.l * 3 } : c));
  const b = featureSeries(cs2, { sym: 'XAU_USD' });
  let drift = 0;
  for (let i = 0; i <= 700; i++) {
    if (JSON.stringify(a[i]?.b) !== JSON.stringify(b[i]?.b)) drift++;
  }
  check('rewriting every bar after 700 changes nothing at or before it', drift === 0,
    `${drift} bars moved, which would mean a feature can see the future`);
}

// ── ATR ─────────────────────────────────────────────────────────────────────
{
  const cs = flat(40, 100, 2);
  const a = atrSeries(cs);
  check('ATR is null until there is enough history', a[5] === null && a[13] === null);
  check('and is the average true range once there is',
    Math.abs(a[30] - 2) < 1e-9, String(a[30]));
  const e = emaSeries(cs, 10);
  check('a flat series has an EMA equal to the price', Math.abs(e[30] - 100) < 1e-9, String(e[30]));
  check('and no EMA before the seed period', e[3] === null);
}

// ── Volatility is measured against this instrument, not against dollars ─────
// Gold moves in dollars and silver in cents. If "hot" is a dollar number, gold
// is always hot and silver never is, and the pooled answer is only ever about
// gold.
{
  const wide  = featureSeries(bars(900, i => {
    const p = 2000, r = i > 600 ? 12 : 4;
    return { o: p, h: p + r / 2, l: p - r / 2, c: p };
  }), { sym: 'XAU_USD' });
  const small = featureSeries(bars(900, i => {
    const p = 25, r = i > 600 ? 0.15 : 0.05;
    return { o: p, h: p + r / 2, l: p - r / 2, c: p };
  }), { sym: 'XAG_USD' });
  check('a threefold jump in range reads as hot on gold', wide[750]?.b.vol === 'hot',
    String(wide[750]?.b.vol));
  check('and the identical jump reads as hot on silver too', small[750]?.b.vol === 'hot',
    `${small[750]?.b.vol} — the two differ by a factor of eighty in dollars`);
  check('a market that has not changed is not hot', wide[550]?.b.vol !== 'hot',
    String(wide[550]?.b.vol));
}

// ── A sweep is taken AND given back ─────────────────────────────────────────
// A level broken and held is a breakout, which is the opposite trade. Lumping
// the two together is exactly how a sweep study reports nothing.
{
  // Day one ranges 99–101. Day two poked to 103 and closed back at 100.
  const cs = [];
  for (let i = 0; i < 24; i++) cs.push({ t: MON + i * H, o: 100, h: 101, l: 99, c: 100, v: 1 });
  for (let i = 0; i < 4; i++) cs.push({ t: MON + (24 + i) * H, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 });
  cs.push({ t: MON + 28 * H, o: 100, h: 103, l: 99.8, c: 100, v: 1 });   // the poke, closed back
  const f = featureSeries(cs);
  check('yesterday\'s high taken and given back is a sweep',
    f[28]?.b.pd === 'pd-high-swept', String(f[28]?.b.pd));

  const held = cs.slice(0, 28).concat([{ t: MON + 28 * H, o: 100, h: 103, l: 99.8, c: 102.5, v: 1 }]);
  const g = featureSeries(held);
  check('the same poke that CLOSES above the level is not a sweep',
    g[28]?.b.pd == null, `${g[28]?.b.pd} — that is a breakout, and the opposite trade`);
}

// ── The partner metal is paired by time, never by index ─────────────────────
// Gold and silver do not print identical bars. Pairing by position compares
// Tuesday's gold to Wednesday's silver and calls the result a correlation.
{
  const au = bars(60, i => ({ o: 2000 + i, h: 2001 + i, l: 1999 + i, c: 2000 + i }));
  // Silver missing a stretch of bars entirely, and running the other way.
  const ag = bars(60, i => ({ o: 25 - i * 0.05, h: 25.1 - i * 0.05, l: 24.9 - i * 0.05, c: 25 - i * 0.05 }))
    .filter((_, i) => i < 20 || i > 40);
  const f = featureSeries(au, { sym: 'XAU_USD', partner: ag });
  const at = f[55];
  check('gold up and silver down is read as a divergence',
    at?.b.partner === 'partner-diverge', String(at?.b.partner));

  // A partner whose most recent bar is a day old is not confirmation.
  const stale = ag.filter(c => c.t < MON + 20 * H);
  const g = featureSeries(au, { sym: 'XAU_USD', partner: stale });
  check('a partner quote hours old contributes nothing rather than agreeing',
    g[55]?.b.partner == null, String(g[55]?.b.partner));
}

// ── Round numbers, and the artefact that made the first version useless ─────
//
// Version 1 fixed the grid at $25 for gold and asked whether price was within a
// quarter of an ATR of one. The live study's own output showed what that does:
// "sitting on a round number" was true on 38.6% of gold bars this year against
// 12% in the three years before — the largest change on the board, and entirely
// because gold went from $1,800 to $4,524. Hourly ATR on gold is now $25.6, the
// whole grid spacing, so the condition had stopped meaning anything at all
// while reading as the year's biggest finding.
{
  check('the grid at $4,500 gold is the fifty-dollar levels people quote',
    roundStepFor('XAU_USD', 4524) === 50, String(roundStepFor('XAU_USD', 4524)));
  check('and at $1,800 it is the twenties, not the same absolute number',
    roundStepFor('XAU_USD', 1800) === 20, String(roundStepFor('XAU_USD', 1800)));
  check('silver at $68 gets fifty cents', roundStepFor('XAG_USD', 68) === 0.5,
    String(roundStepFor('XAG_USD', 68)));
  check('and at $25 it gets twenty', roundStepFor('XAG_USD', 25) === 0.2,
    String(roundStepFor('XAG_USD', 25)));
  check('an instrument with no such convention has no grid rather than a made-up one',
    roundStepFor('EUR_USD', 1.08) === null);

  const near = featureSeries(flat(600, 4500.9, 25), { sym: 'XAU_USD' });
  const off  = featureSeries(flat(600, 4525.0, 25), { sym: 'XAU_USD' });
  check('a price sitting on 4500 is at a round number', near[500]?.b.round === 'at-round');
  check('and one exactly between two levels is not', off[500]?.b.round == null,
    String(off[500]?.b.round));

  // The regression itself: the same market twice, once at half the price. The
  // frequency of the condition must not move.
  const freq = (px, atr) => {
    const cs = bars(900, i => {
      const p = px * (1 + Math.sin(i / 7) * 0.004 + i * 0.00002);
      return { o: p, h: p + atr / 2, l: p - atr / 2, c: p };
    });
    const f = featureSeries(cs, { sym: 'XAU_USD' }).filter(Boolean);
    return f.filter(x => x.b.round === 'at-round').length / f.length;
  };
  const cheap = freq(1800, 9), dear = freq(4524, 25.6);
  check('doubling the price does not change how often the condition is true',
    Math.abs(cheap - dear) < 0.06, `${(cheap * 100).toFixed(1)}% vs ${(dear * 100).toFixed(1)}%`);
  check('and it is a condition rather than the market — true some of the time, not most',
    dear > 0.02 && dear < 0.45, `${(dear * 100).toFixed(1)}%`);
}

// ── Sessions ────────────────────────────────────────────────────────────────
{
  check('the London-New York overlap is its own session', sessionOf(14) === 'ny-am');
  check('and so is the hour after the New York close', sessionOf(22) === 'late');
  check('every hour of the day belongs to exactly one',
    new Set(Array.from({ length: 24 }, (_, h) => sessionOf(h))).size === 5);
}

// ── Rules are an AND, and unmeasurable is not a condition ───────────────────
{
  const f = { b: { vol: 'hot', session: 'london', pd: null, round: null } };
  check('a bar\'s conditions are the ones that are true', keysOf(f).sort().join(',')
    === 'session=london,vol=hot', keysOf(f).join(','));
  check('a null bucket is not counted as a condition', !keysOf(f).some(k => k.includes('null')),
    'treating "we could not measure it" as a state is how absent data becomes a signal');
  check('a rule needs all of its parts', fires({ all: ['vol=hot', 'session=london'] }, f));
  check('and one missing part is enough to not fire',
    !fires({ all: ['vol=hot', 'session=ny-am'] }, f));
  check('every condition has plain English for the card',
    ['vol=hot', 'session=london', 'pd=pd-high-swept', 'partner=partner-diverge']
      .every(k => PHRASE[k]));
  check('and a rule reads as a sentence',
    labelOf({ all: ['vol=hot', 'pd=pd-low-swept'] })
      === 'volatility running hot + yesterday\'s low taken and given back',
    labelOf({ all: ['vol=hot', 'pd=pd-low-swept'] }));
}

// ── The zigzag, and what it is not allowed to be used for ───────────────────
{
  // A clean sawtooth: up 20, down 20, repeating.
  const cs = bars(400, (i) => {
    const leg = Math.floor(i / 20) % 2 === 0;
    const base = 100 + (leg ? (i % 20) : 20 - (i % 20));
    return { o: base, h: base + 0.5, l: base - 0.5, c: base };
  });
  const atr = atrSeries(cs);
  const piv = zigzag(cs, atr, 2);
  check('the turns of a sawtooth are found', piv.length >= 8, String(piv.length));
  check('highs and lows alternate, because a zigzag that does not is not one',
    piv.every((p, i) => i === 0 || p.type !== piv[i - 1].type));
  check('every pivot records when it was CONFIRMED, which is later than when it happened',
    piv.every(p => p.confirmedAt > p.i),
    'this is why the anatomy is descriptive and never a signal');

  const legs = legsOf(piv, atr);
  check('a leg in and a leg out is measured for each turn',
    legs.length === piv.length - 2, `${legs.length} from ${piv.length} pivots`);
  check('and both are in ATR so gold and silver can be pooled',
    legs.every(l => l.inAtr > 0 && l.outAtr > 0));
  check('a turn at a low is a trade upward', legs.filter(l => l.type === 'low').every(l => l.dir === 'up'));
  check('too short a series produces no pivots rather than an imaginary one',
    zigzag(flat(5), atrSeries(flat(5)), 2).length === 0);
}

// ── Drive ───────────────────────────────────────────────────────────────────
{
  const up = featureSeries(bars(600, i => {
    const p = 100 + i * 0.5;
    return { o: p, h: p + 0.2, l: p - 0.2, c: p };
  }));
  check(`a market climbing steadily reads as driving up over ${DRIVE_BARS} bars`,
    ['firm', 'ripping'].includes(up[500]?.b.drive), String(up[500]?.b.drive));
  const still = featureSeries(flat(600));
  check('and one going nowhere reads as flat', still[500]?.b.drive === 'flat',
    String(still[500]?.b.drive));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

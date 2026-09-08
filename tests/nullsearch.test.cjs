// The null test: point the wide search at data with nothing in it.
//
// This is the single most important check on a search engine, and it is the one
// almost nobody writes. Every other test asks whether the arithmetic is right.
// This one asks whether the machine can tell the difference between a market
// and a coin, which is the only question that matters when the search is a
// hundred times wider than the one that produced the original result.
//
// The data is a pure random walk with no drift and no structure. Any rule the
// search reports as holding is, by construction, a false positive.
//
// It caught a real failure on its first run. The verdict returned "holds" as
// soon as both holdouts came back POSITIVE, which is a coin flip twice, and it
// reported seven of ten carried rules as holding on noise. Both holdouts now
// have to be statistically significant rather than merely the right sign, and
// "confirmed" needs the multiple-testing threshold on both.
const path = require('path');
const { runRegimeSearch } = require(path.join(__dirname, '..', 'vps-bot', 'src', 'regimeSearch.js'));

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const H = 3600e3;

// mulberry32, not the linear congruential generator the other test files use.
//
// This is not fussiness. The LCG that was here has a mean of 0.4952 rather than
// 0.5 — a bias of about one percent of its range. Over four thousand bars that
// is invisible. Over the thirty-five thousand bars in a year of M15 it
// compounds into a FIFTY PERCENT decline, and every series it generates trends
// hard downward.
//
// The first M15 null run reported ten of ten rules confirmed, almost all short.
// The search was not broken. It had correctly found a real trend in data this
// file was calling noise, and the test would have gone on certifying the search
// as sound while feeding it a signal.
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// An ADDITIVE walk on price, so there is no compounding for a bias to ride on
// even if a future generator has one. No drift, no mean reversion, no
// seasonality — the only structure is the one the search must fail to find.
function walk(sym, seed, tfMs, from, to) {
  const rnd = mulberry32(seed + sym.split('').reduce((a, c) => a + c.charCodeAt(0), 0));
  const out = [];
  let p = 100;
  for (let t = from; t < to; t += tfMs) {
    const o = p;
    const c = p + (rnd() - 0.5) * 0.4;
    const hi = Math.max(o, c) + rnd() * 0.1;
    const lo = Math.min(o, c) - rnd() * 0.1;
    out.push({ t, o, h: hi, l: lo, c, v: 50 + Math.floor(rnd() * 50) });
    p = c;
  }
  return out;
}

const TF_MS = 4 * H;
const NOW = Date.UTC(2026, 8, 1);

async function runOnNoise(seed) {
  const oanda = {
    getCandlesSince: async (sym, tf, from, { to }) => walk(sym, seed, TF_MS, from, to),
  };
  return runRegimeSearch({
    oanda, now: NOW, years: 2, log: () => {},
    // M15 as well as H4. The failure only appeared at M15's sample size, so a
    // null test that skips it is testing the wrong thing.
    timeframes: [
      { tf: 'H4', ms: TF_MS, holds: [6], years: 2 },
      { tf: 'M15', ms: 900e3, holds: [16], years: 1 },
    ],
  });
}

(async () => {
  // ── The test data itself is tested first ──────────────────────────────────
  //
  // A null test is only worth the data it runs on. If the generator drifts,
  // the search finds the drift, reports it honestly, and this file calls that
  // a false positive — certifying nothing while looking rigorous. So the
  // generator is checked before anything is asked of the search.
  {
    const ends = [7, 4242, 918273].map((seed) => {
      const cs = walk('XAU_USD', seed, TF_MS, NOW - 365 * 86400e3, NOW);
      return { n: cs.length, first: cs[0].c, last: cs[cs.length - 1].c };
    });
    const drifts = ends.map(e => (e.last - e.first) / e.first);
    const worst = Math.max(...drifts.map(Math.abs));
    check('the generator produces series with no meaningful drift',
      worst < 0.15, `worst ${(worst * 100).toFixed(1)}% over ${ends[0].n} bars`,
      'the LCG this used to use ended 50% down every time, and the search rightly found it');
    check('and the drift is not all in one direction across seeds',
      !(drifts.every(d => d > 0) || drifts.every(d => d < 0)) || worst < 0.05,
      drifts.map(d => `${(d * 100).toFixed(1)}%`).join(', '),
      'three out of three the same way is a biased generator, not three coincidences');
  }

  // Three seeds, because one clean run could be luck rather than a working
  // defence — which is the exact mistake this whole file exists to catch.
  const seeds = [7, 4242, 918273];
  const runs = [];
  for (const seed of seeds) runs.push(await runOnNoise(seed));

  const confirmed = runs.reduce((a, r) => a + (r.tally.confirmed || 0), 0);
  const holds = runs.reduce((a, r) => a + (r.tally.holds || 0), 0);
  const carried = runs.reduce((a, r) => a + r.rules.length, 0);

  check('the search runs end to end and produces verdicts',
    carried > 0 && runs.every(r => r.rules.length > 0), `${carried} rules carried across ${seeds.length} runs`);

  // CONFIRMED is the label that says "trade this". On noise it must never
  // appear. There is no acceptable non-zero number here.
  check('nothing is ever CONFIRMED on random data',
    confirmed === 0, `${confirmed} confirmed`,
    'confirmed requires the corrected threshold on BOTH holdouts, which noise should not clear');

  // HOLDS is the weaker label and uses the uncorrected 1.96, so roughly one
  // false positive per run is arithmetic rather than a bug. More than that
  // means the defences have loosened and the label is meaningless.
  check('and HOLDS stays rare — at most one per run on average',
    holds <= seeds.length, `${holds} across ${seeds.length} runs of ${carried} carried rules`,
    'holds uses the uncorrected threshold, so a small number is expected; a large one is a broken gate');

  // The bulk should land in the honest middle: positive by luck, not
  // significant. A run where everything is "fails" would mean the search is
  // broken rather than disciplined.
  const fades = runs.reduce((a, r) => a + (r.tally.fades || 0), 0);
  const fail = runs.reduce((a, r) => a + (r.tally.fails || 0), 0);
  check('most noise lands in fades or fails rather than in a verdict',
    (fades + fail) > carried / 2, `${fades} fades, ${fail} fails of ${carried}`);

  // The instrument holdout has to be doing work, not passed through.
  check('every carried rule was scored on the unseen markets individually',
    runs.every(r => r.rules.every(x => x.spread && typeof x.spread.tested === 'number')),
    'a rule reported without a per-market breakdown could be one lucky instrument');

  check('and the split is reported so the claim can be checked',
    runs.every(r => r.split.searched.length > 0 && r.split.unseen.length > 0
      && !r.split.searched.some(s => r.split.unseen.includes(s))));

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log(`  FAIL  the null run threw — ${e.message}`);
  console.log('\n1 FAILED');
  process.exit(1);
});

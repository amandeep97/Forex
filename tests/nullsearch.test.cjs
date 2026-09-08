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

// A geometric random walk. No drift, no mean reversion, no seasonality — the
// ONLY structure is the one the search is supposed to fail to find.
function walk(sym, seed, tfMs, from, to) {
  let s = seed + sym.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  let p = 100;
  for (let t = from; t < to; t += tfMs) {
    const o = p;
    const c = p * (1 + (rnd() - 0.5) * 0.004);
    const hi = Math.max(o, c) * (1 + rnd() * 0.001);
    const lo = Math.min(o, c) * (1 - rnd() * 0.001);
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
    timeframes: [{ tf: 'H4', ms: TF_MS, holds: [6] }],
  });
}

(async () => {
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

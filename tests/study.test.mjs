// The app's central premise, and whether the test of it can tell truth from
// noise.
//
// Everything measured so far has been single setups in isolation. The ranking
// is driven by BREADTH — how many independent families agree — and that claim
// has never been checked. Before it is checked, the checker has to be shown to
// work: a study that reports "confluence holds" on random data is worse than no
// study.
const ROOT = new URL('../', import.meta.url).pathname;
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const S = require(`${ROOT}vps-bot/src/confluenceStudy.js`);

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const T0 = Date.UTC(2024, 0, 1), DAY = 86400e3;

// ── No value may come from the future ─────────────────────────────────────
const series = Array.from({ length: 100 }, (_, i) => ({ t: T0 + i*DAY, val: i }));
check('asOf returns the last value on or before the instant',
  S.asOf(series, T0 + 50*DAY).val === 50);
check('and never one from after it',
  S.asOf(series, T0 + 50*DAY + DAY/2).val === 50);
check('before the series starts, it returns nothing',
  S.asOf(series, T0 - DAY) === null);
check('a change is measured backwards, not forwards',
  S.changeOver(series, T0 + 50*DAY, 20) === 20);

// ── The pre-specified macro directions ────────────────────────────────────
// These are the textbook relationships, fixed before any outcome was looked at.
// A study that picks its own signs is a search wearing a disguise.
const falling = Array.from({ length: 100 }, (_, i) => ({ t: T0 + i*DAY, val: 2 - i*0.01 }));
const rising  = Array.from({ length: 100 }, (_, i) => ({ t: T0 + i*DAY, val: 2 + i*0.01 }));
const flat    = Array.from({ length: 100 }, (_, i) => ({ t: T0 + i*DAY, val: 2 }));
const at = T0 + 60*DAY;
check('falling real yields point gold up',
  S.macroDirection('metal', 'XAU/USD', { dfii10: falling }, at) === 'up');
check('rising real yields point gold down',
  S.macroDirection('metal', 'XAU/USD', { dfii10: rising }, at) === 'down');
check('a steepening curve points indices up',
  S.macroDirection('index', 'US500', { dgs10: rising, dgs2: flat }, at) === 'up');
check('a flattening curve points indices down',
  S.macroDirection('index', 'US500', { dgs10: flat, dgs2: rising }, at) === 'down');
check('rising breakevens point energy up',
  S.macroDirection('energy', 'USOIL', { t10yie: rising }, at) === 'up');
// FX through the rate differential. Leaving this out was not neutral: it left
// every FX pair with only price and structure, so three-family agreement was
// arithmetically almost impossible — the first run found it three times in
// 1,465 bars.
check('a rising US 2-year points EUR/USD down, because the dollar is the quote',
  S.macroDirection('fx', 'EUR/USD', { dgs2: rising }, at) === 'down');
check('and points USD/JPY up, because the dollar is the base',
  S.macroDirection('fx', 'USD/JPY', { dgs2: rising }, at) === 'up');
check('a falling US 2-year reverses both',
  S.macroDirection('fx', 'EUR/USD', { dgs2: falling }, at) === 'up' &&
  S.macroDirection('fx', 'USD/JPY', { dgs2: falling }, at) === 'down');
check('a cross with no dollar leg gets no vote',
  S.macroDirection('fx', 'EUR/GBP', { dgs2: rising }, at) === null);
check('stocks follow the same risk signal as indices',
  S.macroDirection('tradfi', 'ORCL/USDT', { dgs10: rising, dgs2: flat }, at) === 'up');
check('missing data yields no vote, not a default one',
  S.macroDirection('metal', 'XAU/USD', {}, at) === null);

// ── The statistics: can it tell a real gradient from a flat one? ──────────
// Synthetic rows, so the answer is known. A baseline of pure coin flips.
const rnd = (seed => () => (seed = (seed*1103515245 + 12345) % 2147483648) / 2147483648)(7);
const baseline = Array.from({ length: 20000 }, () => rnd() - 0.5);

// Rows where the edge genuinely climbs with the number of agreeing families.
const gradient = [];
for (const [agree, edge] of [[1, 0.02], [2, 0.10], [3, 0.22], [4, 0.40]]) {
  for (let i = 0; i < 900; i++) {
    gradient.push({ agree, dir: 'up', signed: (rnd() - 0.5) + edge });
  }
}
const gs = S.summarise(gradient, baseline);
const gv = S.verdict(gs);
console.log('         planted gradient →', gs.filter(b => !b.tooFew).map(b => `${b.agree}:${b.edgeWin > 0 ? '+' : ''}${b.edgeWin}`).join('  '));
check('a real gradient is detected as monotonic', gv.monotonic === true);
check('and reported as supported', gv.supported === true, gv.reason);
check('the edge widens from the narrowest bucket to the widest', gv.span > 5, String(gv.span));

// The same shape with NO gradient — every bucket equally good.
const flatRows = [];
for (const agree of [1, 2, 3, 4]) {
  for (let i = 0; i < 900; i++) flatRows.push({ agree, dir: 'up', signed: (rnd() - 0.5) + 0.2 });
}
const fv = S.verdict(S.summarise(flatRows, baseline));
check('a uniform edge is NOT confluence, however large it is',
  fv.supported === false, fv.reason);

// Pure noise: no edge anywhere.
const noise = [];
for (const agree of [1, 2, 3, 4]) {
  for (let i = 0; i < 900; i++) noise.push({ agree, dir: 'up', signed: rnd() - 0.5 });
}
const nv = S.verdict(S.summarise(noise, baseline));
check('pure noise is not reported as a finding', nv.supported === false, nv.reason);

// A gradient pointing the WRONG way — more agreement, worse outcome.
const inverted = [];
for (const [agree, edge] of [[1, 0.40], [2, 0.22], [3, 0.10], [4, 0.02]]) {
  for (let i = 0; i < 900; i++) inverted.push({ agree, dir: 'up', signed: (rnd() - 0.5) + edge });
}
const iv = S.verdict(S.summarise(inverted, baseline));
check('confluence that makes things worse is not "supported"', iv.supported === false, iv.reason);

// ── Direction is mirrored against the baseline, not compared to 50% ───────
// A rising market: two thirds of bars go up.
const upMarket = Array.from({ length: 20000 }, () => (rnd() - 0.5) + 0.35);
const allShort = Array.from({ length: 2000 }, () => ({ agree: 2, dir: 'down', signed: (rnd() - 0.5) - 0.35 }));
const sm = S.summarise(allShort, upMarket).find(b => b.agree === '2');
check('a short in a rising market is benchmarked against the mirrored baseline',
  Math.abs(sm.baseWin - (100 - S.winRate(upMarket))) < 0.2,
  `${sm.baseWin}% vs mirror ${(100 - S.winRate(upMarket)).toFixed(1)}%`);
check('so doing exactly what the market did is no edge',
  Math.abs(sm.edgeWin) < 3, `edge ${sm.edgeWin}`);

// ── A bucket too small to judge says so, rather than guessing ─────────────
const sparse = Array.from({ length: 12 }, () => ({ agree: 4, dir: 'up', signed: 1 }));
const ss = S.summarise(sparse, baseline);
check('a bucket under the minimum is flagged, not scored',
  ss.find(b => b.agree === '4+').tooFew === true);
check('and a study with too few usable buckets refuses a verdict',
  S.verdict(ss).supported === false && /bucket/.test(S.verdict(ss).reason),
  S.verdict(ss).reason);

// ── Scanning a series ─────────────────────────────────────────────────────
// A flat series with one clear feature: price pinned at the very bottom of its
// 60-bar range should register the volatility family, pointing up.
const cs = [];
for (let i = 0; i < 200; i++) {
  const c = 100 - (i > 150 ? (i - 150) * 0.5 : 0) + (i % 3) * 0.01;
  cs.push({ t: T0 + i*DAY, o: c, h: c + 0.3, l: c - 0.3, c });
}
const rows = S.scanInstrument({ cs, sym: 'X', cls: 'fx', macro: null, cot: null, patternsAt: null });
check('a scan produces one row per scorable bar, and no more',
  rows.length > 0 && rows.length <= cs.length, String(rows.length));
check('every row has a direction and at least one agreeing family',
  rows.every(r => (r.dir === 'up' || r.dir === 'down') && r.agree >= 1));
check('no row is scored without a complete forward window',
  rows.every(r => {
    const i = cs.findIndex(c => c.t === r.t);
    return i + S.HORIZON < cs.length;
  }));
check('price at the floor of its range votes up',
  rows.some(r => r.families.includes('volatility') && r.dir === 'up'));
check('the study never scores a bar it has no evidence for',
  rows.every(r => r.families.length > 0));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

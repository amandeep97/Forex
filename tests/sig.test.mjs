import { calcStats } from '../src/utils/backtestEngine.js';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// Build trades with known R multiples so SD and SE can be checked against
// values computed by hand rather than against the code under test.
const mk = rs => rs.map((r, i) => ({
  result: r > 0 ? 'win' : 'loss', pnlDollars: r * 100, riskDollars: 100,
  pnlPips: r * 10, dir: 'long', duration: 1, entryTime: i,
}));

// Five trades: -1,-1,-1,-1,+8  → mean = +0.8
const s1 = calcStats(mk([-1,-1,-1,-1,8]));
check('avgRR correct', s1.avgRR === 0.8, String(s1.avgRR));
check('win rate correct', s1.winRate === 20, String(s1.winRate));
// sample SD of [-1,-1,-1,-1,8] = sqrt(((−1.8)^2*4 + 7.2^2)/4) = sqrt((12.96+51.84)/4) = 4.0249
check('sdRR matches hand calc', Math.abs(s1.sdRR - 4.025) < 0.005, String(s1.sdRR));
check('seRR = sd/sqrt(n)', Math.abs(s1.seRR - 4.025/Math.sqrt(5)) < 0.005, String(s1.seRR));

// A tight, consistent series must have a far smaller error than a spiky one
// with the SAME mean — that is the whole point of reporting it.
const tight = calcStats(mk(Array(400).fill(0).map((_, i) => i % 2 ? 0.9 : -0.7)));   // mean +0.1
const spiky = calcStats(mk(Array(400).fill(0).map((_, i) => i % 20 === 0 ? 20.9 : -1))); // mean +0.095
check('same-ish mean, very different error',
  Math.abs(tight.avgRR - spiky.avgRR) < 0.02 && spiky.seRR > tight.seRR * 5,
  `tight ±${tight.seRR} vs spiky ±${spiky.seRR}`);

// Loss streaks
check('loss streak counted', calcStats(mk([-1,-1,-1,2,-1,-1])).maxLossStreak === 3,
  String(calcStats(mk([-1,-1,-1,2,-1,-1])).maxLossStreak));

// Degenerate inputs must not produce NaN on screen.
check('single trade has no SD', calcStats(mk([1])).sdRR === null);
check('no trades returns nulls', calcStats([]).seRR === null && calcStats([]).sdRR === null);

// The user's actual result: 21% win rate, +0.11R, n=396. Reconstruct a series
// with those properties and confirm the verdict the app will print.
const winR = (0.11 + 0.79) / 0.21;   // ≈ 4.29R average winner
// Wins placed pseudo-randomly, not blocked — a blocked layout would report a
// 79-loss streak that is an artifact of the test data, not of a 21% win rate.
let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const real = mk(Array.from({length:396}, () => rnd() < 0.21 ? winR : -1));
const rs = calcStats(real);
const ci = 1.96 * rs.seRR;
check('reconstruction matches the screenshot', Math.abs(rs.avgRR - 0.11) < 0.08 && Math.abs(rs.winRate - 21) < 3,
  `${rs.avgRR}R at ${rs.winRate}%`);
check('and zero sits inside its error bar', rs.avgRR - ci < 0,
  `+${rs.avgRR} ± ${ci.toFixed(2)}`);
const needed = Math.ceil((1.96 * rs.seRR * Math.sqrt(rs.totalTrades) / Math.abs(rs.avgRR)) ** 2);
check('needed-trades estimate is sane', needed > 396 && needed < 100000, `${needed} trades`);
console.log(`         → app will report: +${rs.avgRR}R ± ${ci.toFixed(2)}, needs ~${needed.toLocaleString()} trades, worst run ${rs.maxLossStreak}`);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

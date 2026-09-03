const ROOT = new URL('../', import.meta.url).pathname;
import { patternsAt } from '../src/utils/candlePatterns.js';
import { runBacktest, calcStats } from '../src/utils/backtestEngine.js';
import { readFileSync } from 'fs';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// ── patternsAt: tail slice must equal the old full slice, bar for bar ──────
// Reference = the ORIGINAL implementation, reconstructed from the same
// _detectOnWindow the module uses, so this compares behaviour and not a copy
// of the new code.
//
// Read from shared/, which is where the detection lives now.
// src/utils/candlePatterns.js is a re-export shim, and loading a shim as a
// data: URL cannot work — a data: module has no directory to resolve
// '../../shared/...' against. patternsAt is still imported through the shim at
// the top of this file, so the shim itself stays covered.
const src = readFileSync(`${ROOT}shared/candlePatterns.mjs`, 'utf8');
const refMod = await import('data:text/javascript,' + encodeURIComponent(
  src.replace(
    'return _detectOnWindow(candles.slice(Math.max(0, i - PATTERN_LOOKBACK), i + 1))',
    'return _detectOnWindow(candles.slice(0, i + 1))')
  + '\nexport const __ref = patternsAt;'));
const refPatternsAt = refMod.__ref;

function series(seed, n) {
  let s = seed, p = 100;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  for (let i = 0; i < n; i++) {
    // Wide variety of body/wick shapes so every pattern branch gets exercised.
    const d = (rnd() - 0.5) * 2 * (rnd() < 0.2 ? 4 : 1);
    const o = p, c = p + d;
    const hi = Math.max(o, c) + rnd() * 3, lo = Math.min(o, c) - rnd() * 3;
    out.push({ t: i * 60000, o, h: hi, l: lo, c, v: 100 });
    p = c;
  }
  return out;
}

let compared = 0, hits = 0;
for (const seed of [3, 17, 101, 999, 424242]) {
  const cs = series(seed, 900);
  for (let i = 0; i < cs.length; i++) {
    const a = refPatternsAt(cs, i), b = patternsAt(cs, i);
    compared++;
    if (a.length) hits++;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      check(`patternsAt differs at seed ${seed} bar ${i}`, false, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      break;
    }
  }
}
check(`patternsAt identical across ${compared.toLocaleString()} bars`, fails === 0, `${hits.toLocaleString()} bars carried a pattern`);
check('the comparison was not vacuous', hits > 500, `${hits} pattern hits`);

// ── Backtest results must be byte-identical across repeated runs and across
// separate-but-equal candle arrays (i.e. the cache is keyed correctly). ──────
const STRATS = [
  { conditions:[{type:'candlestick',value:'morning_star'}], exitType:'trail', trailAtr:5, slType:'atr', slAtr:2 },
  { conditions:[{type:'candlestick',value:'hammer'}], exitType:'rr', rrRatio:2, slType:'swing', swingLookback:12 },
  { conditions:[{type:'ob',op:'bullish'},{type:'volpct',op:'below',value:30}], exitType:'rr', rrRatio:2, slType:'swing', swingLookback:12 },
  { conditions:[{type:'rsi',period:14,op:'crossBelow',value:30}], exitType:'rr', rrRatio:3, slType:'atr', slAtr:2 },
  { conditions:[{type:'ma_cross',period:20,period2:50,maType:'ema',op:'bullishCross'}], exitType:'trail', trailAtr:3, slType:'atr', slAtr:2 },
  { conditions:[{type:'bos',op:'bullish'},{type:'rangepos',op:'below',value:25}], exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 },
];
const base = series(7, 3000);
for (const [n, st] of STRATS.entries()) {
  const s = { ...st, logic:'AND', direction:'both', symbol:'XAG/USD' };
  const a = calcStats(runBacktest(base, s).trades);
  const b = calcStats(runBacktest(base, s).trades);                 // same array, warm cache
  const c = calcStats(runBacktest(base.map(x => ({...x})), s).trades); // fresh array, cold cache
  const same = JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) === JSON.stringify(c);
  check(`strategy ${n + 1} identical warm and cold`, same,
    `n=${a.totalTrades} expR=${a.avgRR}`);
}

// A slice must be treated as a different dataset, not served the parent's cache.
const half = base.slice(0, 1500);
const sIn  = calcStats(runBacktest(half, { ...STRATS[0], logic:'AND', direction:'both', symbol:'XAG/USD' }).trades);
const sRef = calcStats(runBacktest(half.map(x=>({...x})), { ...STRATS[0], logic:'AND', direction:'both', symbol:'XAG/USD' }).trades);
check('a slice is its own dataset', JSON.stringify(sIn) === JSON.stringify(sRef), `n=${sIn.totalTrades}`);
check('the slice case actually trades', sIn.totalTrades > 5, `n=${sIn.totalTrades}`);
check('slice really differs from the full run', sIn.totalTrades !== calcStats(runBacktest(base, { ...STRATS[0], logic:'AND', direction:'both', symbol:'XAG/USD' }).trades).totalTrades);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

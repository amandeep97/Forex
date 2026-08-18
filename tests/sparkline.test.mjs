const ROOT = new URL('../', import.meta.url).pathname;
import { readFileSync } from 'fs';
let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// Extract the real Sparkline component and run it headlessly, so this tests
// the shipped geometry rather than a restatement of it.
const src = readFileSync(`${ROOT}src/components/Screener.jsx`,'utf8');
const body = src.slice(src.indexOf('function Sparkline'), src.indexOf('\n}', src.indexOf('function Sparkline')) + 2);
const jsxFree = body
  .replace(/return <div style=\{\{width:w,height:h\}\}\/>;/g, 'return { empty: true };')
  .replace(/return \(\s*<svg[\s\S]*?\);\s*\}$/m, 'return { empty:false, pts, lastY: +lastY, h };\n}');
const { Sparkline } = await import('data:text/javascript,' + encodeURIComponent(jsxFree + '\nexport { Sparkline };'));

const H = 26;
const ys = r => r.pts.split(' ').map(p => +p.split(',')[1]);

// The bug: an all-zero series drew every point one pixel BELOW the viewport.
const zero = Sparkline({ data: Array(9).fill(0), change: 0 });
check('an all-zero series renders nothing', zero.empty === true);

// A flat but real price must be visible, not clipped.
const flat = Sparkline({ data: Array(9).fill(250.25), change: 0 });
check('a flat real series renders', flat.empty === false);
check('and sits inside the viewport', ys(flat).every(v => v >= 0 && v <= H),
  `y values ${[...new Set(ys(flat))].join(',')}`);
check('drawn down the middle', ys(flat).every(v => Math.abs(v - H/2) < 0.01));

// Normal data must still be laid out across the full height.
const rising = Sparkline({ data: [10,11,12,13,14,15,16,17,18], change: 5 });
check('a rising series renders', rising.empty === false);
check('every point is inside the viewport', ys(rising).every(v => v >= 0 && v <= H),
  `min ${Math.min(...ys(rising))} max ${Math.max(...ys(rising))}`);
check('it actually slopes', new Set(ys(rising)).size > 5);
check('rising prices plot upward (smaller y)',
  ys(rising)[0] > ys(rising)[ys(rising).length - 1]);
check('the marker sits on the last point',
  Math.abs(rising.lastY - ys(rising)[ys(rising).length - 1]) < 0.01);

check('too little data renders nothing', Sparkline({ data:[5], change:0 }).empty === true);
check('missing data renders nothing', Sparkline({ data:null, change:0 }).empty === true);

// The screener must build sparklines from real candles, not a random walk.
check('screener uses real closes for sparklines',
  /const real = realCandles\[inst\.id\]/.test(src) && /sparkline: closes/.test(src));
check('and recomputes when candles arrive',
  /realCandles\]\);/.test(src.slice(src.indexOf('instrumentsWithLive'))));
check('generateSparkline is no longer what the table displays',
  src.indexOf('sparkline: closes') > 0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

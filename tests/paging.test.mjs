// The paging loop and span estimator are module-private inside Backtester.jsx.
// Extract them from source and run the REAL code rather than a copy, so this
// test fails if the file changes underneath it.
const ROOT = new URL('../', import.meta.url).pathname;
import { readFileSync } from 'fs';
const src = readFileSync(`${ROOT}src/components/Backtester.jsx`, 'utf8');

const grab = (startMarker, endMarker) => {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error(`not found: ${startMarker}`);
  const j = src.indexOf(endMarker, i);
  return src.slice(i, j + endMarker.length);
};
const paged  = grab('async function fetchOandaPaged', '\n}');
const perDay = grab('const BARS_PER_TRADING_DAY', '};');
const spanFn = grab('function estimateSpanDays', '\n}');
const dedupe = 'const dedupeSort = a => [...new Map(a.map(c=>[c.t,c])).values()].sort((x,y)=>x.t-y.t);';

const mod = await import('data:text/javascript,' + encodeURIComponent(
  `${dedupe}\n${paged}\n${perDay}\n${spanFn}\nexport { fetchOandaPaged, estimateSpanDays, BARS_PER_TRADING_DAY };`));

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// Fake OANDA: 12,000 M1 bars of history. Every page's newest candle is still
// forming, exactly as the real API behaves — that is what broke paging.
const HISTORY = 12000, T0 = 1700000000000, STEP = 60000;
let requests = 0;
globalThis.fetch = async (url) => {
  requests++;
  const u = new URL(url);
  const count = +u.searchParams.get('count');
  const to = u.searchParams.get('to');
  const endIdx = to ? Math.round((new Date(to).getTime() - T0) / STEP) : HISTORY;
  const startIdx = Math.max(0, endIdx - count);
  const out = [];
  for (let i = startIdx; i < endIdx; i++) {
    out.push({ time: new Date(T0 + i * STEP).toISOString(), complete: true,
      mid: { o:'1.1', h:'1.2', l:'1.0', c:'1.15' }, volume: 10 });
  }
  // The newest bar of the most recent page is still forming.
  if (!to && out.length) out[out.length - 1].complete = false;
  return { ok: true, json: async () => ({ candles: out }) };
};
globalThis.AbortSignal = { timeout: () => undefined };

const got = await mod.fetchOandaPaged('EUR_USD', 'M1', 10000, 'k', 'https://x');
check('10,000 requested → 10,000 delivered', got.length >= 9990, `${got.length} bars in ${requests} requests`);
check('more than one page was fetched', requests >= 2, `${requests}`);
check('bars are sorted ascending', got.every((c,i) => i === 0 || c.t > got[i-1].t));
check('no duplicate timestamps', new Set(got.map(c=>c.t)).size === got.length);

// Asking for more than exists must stop at the start of history, not spin.
requests = 0;
const all = await mod.fetchOandaPaged('EUR_USD', 'M1', 50000, 'k', 'https://x');
check('stops at start of history', all.length <= HISTORY && all.length >= HISTORY - 5, `${all.length}/${HISTORY}`);
check('does not spin past the end', requests <= 5, `${requests} requests`);

// ── Span estimates ────────────────────────────────────────────────────────
const S = mod.estimateSpanDays;
// The user's exact case: what they SAW was 4999 bars ≈ 6 calendar days.
check('M1 × 5,000 ≈ 5 days',    Math.round(S('1M', 5000, false)) === 5,   String(Math.round(S('1M',5000,false))));
check('M1 × 50,000 under 180',  S('1M', 50000, false) < 180,              String(Math.round(S('1M',50000,false))));
check('M1 × 200,000 clears 180',S('1M', 200000, false) >= 180,            String(Math.round(S('1M',200000,false))));
check('M5 × 50,000 clears 180', S('5M', 50000, false) >= 180,             String(Math.round(S('5M',50000,false))));
check('M15 × 20,000 clears 180',S('15M', 20000, false) >= 180,            String(Math.round(S('15M',20000,false))));
check('D × 2,600 ≈ 10 years',   Math.abs(S('D', 2600, false)/365 - 10) < 0.5, `${(S('D',2600,false)/365).toFixed(1)}y`);
// Crypto trades weekends, so the same bar count buys fewer calendar days.
check('crypto spans fewer calendar days', S('1H', 5000, true) < S('1H', 5000, false));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

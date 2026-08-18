// Every screen must reach the right venue. The old failure was silent: a
// futures-only symbol asked of the spot host returns 400, the caller's catch
// swallows it, and the panel shows nothing or invented data.
const ROOT = new URL('../', import.meta.url).pathname;
import { INSTRUMENTS, bySymbol } from '../src/data/instruments.js';
import { venueFor, isBinance, binanceCandles, binancePrice, BINANCE_TF } from '../src/utils/binanceKlines.js';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

const tradfi = INSTRUMENTS.filter(i => i.cls === 'tradfi');
check('TradFi list from both screenshots', tradfi.length === 20, String(tradfi.length));
check('silver perp carried alongside OANDA silver',
  !!bySymbol('XAG/USDT')?.bfut && !!bySymbol('XAG/USD')?.oanda);
check('the two silvers are distinct symbols', bySymbol('XAG/USDT').sym !== bySymbol('XAG/USD').sym);
check('every TradFi entry has a futures ticker', tradfi.every(i => i.bfut && !i.binance));
check('every TradFi entry is candle-capable', tradfi.every(i => i.can.candles));
check('no duplicate tickers across the whole registry', (() => {
  const t = INSTRUMENTS.map(i => i.binance || i.bfut).filter(Boolean);
  return new Set(t).size === t.length;
})());
check('no duplicate symbols', new Set(INSTRUMENTS.map(i=>i.sym)).size === INSTRUMENTS.length);

// The breadth set must stay OANDA-only, or oil is counted twice.
const { FOCUS_SET } = await import(`${ROOT}src/utils/strategySearch.js`);
check('breadth set excludes every perp',
  FOCUS_SET.every(s => !bySymbol(s)?.bfut), FOCUS_SET.filter(s => bySymbol(s)?.bfut).join());

// ── Routing, by instrument and by bare ticker ─────────────────────────────
check('instrument routes to futures', venueFor(bySymbol('NFLX/USDT')).venue === 'futures');
check('instrument routes to spot',    venueFor(bySymbol('BTC/USDT')).venue === 'spot');
check('known ticker string routes to futures', venueFor('CRWDUSDT').venue === 'futures');
check('known ticker string routes to spot',    venueFor('BTCUSDT').venue === 'spot');
check('unknown ticker falls back to spot',     venueFor('WHATEVERUSDT').venue === 'spot',
  'preserves the behaviour of call sites that only ever had a string');
check('lowercase ticker still resolves', venueFor('crwdusdt').venue === 'futures');

// ── Every migrated call site hits the right host ──────────────────────────
const seen = [];
globalThis.fetch = async (url) => {
  seen.push(url);
  if (url.includes('ticker/price')) return { ok:true, json: async () => ({ price:'123.45' }) };
  const u = new URL(url);
  const limit = +u.searchParams.get('limit');
  const out = Array.from({length: Math.min(limit, 500)}, (_,i) =>
    [1700000000000 + i*86400e3, '1','2','0.5','1.5','100']);
  return { ok:true, json: async () => out };
};
globalThis.AbortSignal = { timeout: () => undefined };

const hostOf = async (fn) => { seen.length = 0; await fn(); return seen[0] || ''; };

check('candles for a TradFi instrument hit fapi',
  (await hostOf(() => binanceCandles(bySymbol('ORCL/USDT'), 'D', 50))).includes('fapi.binance.com'));
check('candles for crypto still hit spot',
  (await hostOf(() => binanceCandles(bySymbol('BTC/USDT'), 'D', 50))).includes('api.binance.com/api/v3'));
check('price for a TradFi instrument hits fapi',
  (await hostOf(() => binancePrice(bySymbol('ORCL/USDT')))).includes('fapi.binance.com'));
check('price returns a number', await binancePrice(bySymbol('ORCL/USDT')) === 123.45);

// Timeframe spellings used across the app must all map.
for (const tf of ['H1','4H','D','M15','1h','1D','W'])
  check(`timeframe "${tf}" maps`, !!(BINANCE_TF[tf] || /^\d/.test(tf)), tf);

// ── The migrated modules themselves ───────────────────────────────────────
const scanner = await import(`${ROOT}src/utils/scanner.js`);
check('scanner module loads after migration', !!scanner);
const alerts = await import(`${ROOT}src/utils/alertFeed.js`);
check('alertFeed loads', typeof alerts.fetchPrice === 'function');
check('alertFeed price routes by venue',
  (await hostOf(() => alerts.fetchPrice(bySymbol('NFLX/USDT')))).includes('fapi.binance.com'));
check('alertFeed candles route by venue',
  (await hostOf(() => alerts.fetchRecentCandles(bySymbol('NFLX/USDT'), 'H1', 5))).includes('fapi.binance.com'));
check('alertFeed last-closed routes by venue',
  (await hostOf(() => alerts.fetchLastClosed(bySymbol('NFLX/USDT'), 'H1'))).includes('fapi.binance.com'));
check('alertFeed drops the forming candle',
  (await alerts.fetchRecentCandles(bySymbol('NFLX/USDT'), 'H1', 5)).length === 5);

const cmd = await import(`${ROOT}src/utils/commandScore.js`);
check('commandScore routes a known ticker to futures',
  (await hostOf(() => cmd.binanceFetch('CRWDUSDT','1d',20))).includes('fapi.binance.com'));
check('commandScore still returns closes',
  (await cmd.binanceFetch('BTCUSDT','1d',20)).every(x => typeof x.c === 'number'));

// No module may build its own KLINES url — that is the call where picking the
// wrong host silently returns nothing for a futures-only instrument.
//
// Bulk endpoints are a deliberate exception and are listed by name: the live
// price hook pulls the entire ticker table in one request per venue, which a
// per-instrument client cannot express, and flowFeed reads the spot order
// book, which has no futures equivalent in the same shape.
import { execSync } from 'child_process';
const ALLOWED = /binanceKlines|binanceDiscovery|data\/instruments|flowFeed|useLivePrices/;
const klineOffenders = execSync(
  `grep -rl "api.binance.com/api/v3/klines" ${ROOT}src --include=*.js --include=*.jsx || true`)
  .toString().trim().split('\n').filter(Boolean).filter(f => !ALLOWED.test(f));
check('no screen builds its own klines URL', klineOffenders.length === 0,
  klineOffenders.map(f => f.split('/').pop()).join(', ') || 'clean');

const anyOffenders = execSync(
  `grep -rl "api.binance.com" ${ROOT}src --include=*.js --include=*.jsx || true`)
  .toString().trim().split('\n').filter(Boolean).filter(f => !ALLOWED.test(f));
check('and the only files touching Binance directly are the allowed ones',
  anyOffenders.length === 0, anyOffenders.map(f => f.split('/').pop()).join(', ') || 'clean');

// The live price hook is allowed a direct call, but only the bulk one.
import { readFileSync } from 'fs';
const hookSrc = readFileSync(`${ROOT}src/hooks/useLivePrices.js`,'utf8');
check('the price hook uses only the bulk ticker endpoint',
  !/api\.binance\.com\/api\/v3\/klines/.test(hookSrc)
  && /api\/v3\/ticker\/price/.test(hookSrc));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

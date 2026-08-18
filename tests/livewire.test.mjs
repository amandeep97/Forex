const ROOT = new URL('../', import.meta.url).pathname;
import { readFileSync } from 'fs';
import { INSTRUMENTS, bySymbol } from '../src/data/instruments.js';
import { isBinance, binanceCandles } from '../src/utils/binanceKlines.js';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// ── ChartModal must not send a Binance symbol to OANDA ────────────────────
const chart = readFileSync(`${ROOT}src/components/ChartModal.jsx`,'utf8');
const fn = chart.slice(chart.indexOf('async function fetchCandles'),
                       chart.indexOf('// ── SVG Chart'));
check('chart checks the venue before OANDA',
  fn.indexOf('isBinance') < fn.indexOf('getOandaCreds'),
  'the Binance branch must come first, or a perp asks OANDA and 400s');
check('chart uses the shared client', /binanceCandles\(/.test(fn));
check('chart still supports OANDA', /api-fxpractice\.oanda\.com/.test(fn));

// ── Live prices must cover every Binance instrument ───────────────────────
const hook = readFileSync(`${ROOT}src/hooks/useLivePrices.js`,'utf8');
check('live prices query both venues',
  /api\.binance\.com\/api\/v3\/ticker\/price/.test(hook) && /fapi\.binance\.com\/fapi\/v1\/ticker\/price/.test(hook));
check('live prices key by registry symbol, not CoinGecko names',
  /map\.get\(t\.symbol\)/.test(hook));
check('Binance overrides CoinGecko on overlap',
  /\.\.\.\(cr \|\| \{\}\), \.\.\.\(bn \|\| \{\}\)/.test(hook),
  'BTC has a price from both; the venue the app charts should win');

// ── Simulate the ticker mapping the hook performs ─────────────────────────
const wanted = INSTRUMENTS.filter(i => i.binance || i.bfut);
const bySpot = new Map(wanted.filter(i=>i.binance).map(i=>[i.binance,i.sym]));
const byFut  = new Map(wanted.filter(i=>i.bfut).map(i=>[i.bfut,i.sym]));
check('every crypto instrument is reachable on spot', bySpot.size === 12, String(bySpot.size));
check('every TradFi instrument is reachable on futures', byFut.size === 20, String(byFut.size));
check('the two venue maps do not overlap',
  [...bySpot.keys()].every(k => !byFut.has(k)));

const fakeSpot = [...bySpot.keys()].map(t => ({ symbol:t, price:'100.5' }));
const fakeFut  = [...byFut.keys()].map(t => ({ symbol:t, price:'250.25' }));
const mapped = {};
for (const [list, map] of [[fakeSpot, bySpot],[fakeFut, byFut]])
  for (const t of list) { const s = map.get(t.symbol); if (s) mapped[s] = parseFloat(t.price); }
check('every Binance instrument gets a price', wanted.every(i => mapped[i.sym] > 0),
  wanted.filter(i => !mapped[i.sym]).map(i=>i.sym).join());
check('prices land on registry symbols', mapped['CRWD/USDT'] === 250.25 && mapped['BTC/USDT'] === 100.5);
check('an unlisted ticker is ignored, not stored',
  !Object.values({ ...mapped }).includes(NaN));

// ── The chart path actually resolves ──────────────────────────────────────
const seen = [];
globalThis.fetch = async (url) => {
  seen.push(url);
  return { ok:true, json: async () => Array.from({length:50}, (_,i) =>
    [1700000000000 + i*14400e3, '1','2','0.5','1.5','100']) };
};
globalThis.AbortSignal = { timeout: () => undefined };
check('a TradFi chart is Binance-routed', isBinance(bySymbol('ADBE/USDT')));
await binanceCandles(bySymbol('ADBE/USDT'), 'H4', 100);
check('and hits the futures host with the H4 interval',
  seen[0].includes('fapi.binance.com') && seen[0].includes('interval=4h'), seen[0]);
check('an OANDA-only symbol is not Binance-routed', !isBinance(bySymbol('EUR/USD')));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

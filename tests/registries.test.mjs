// Three instrument lists have to agree. They cannot import each other — the
// app is ESM in a browser bundle, the bot is CommonJS on a VPS, and the
// screener list carries display seed data — so the only thing keeping them in
// step is this test.
const ROOT = new URL('../', import.meta.url).pathname;
import { INSTRUMENTS } from '../src/data/instruments.js';
import { createRequire } from 'module';
const require = createRequire(`${ROOT}vps-bot/`);
const vps = require(`${ROOT}vps-bot/src/instruments.js`);
const { allInstruments: screener, ASSET_TYPES } = await import(`${ROOT}src/data/forexData.js`);

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// ── App registry vs VPS registry ──────────────────────────────────────────
const appSyms = new Set(INSTRUMENTS.map(i => i.sym));
const vpsSyms = new Set(vps.INSTRUMENTS.map(i => i.sym));
const missingInVps = [...appSyms].filter(s => !vpsSyms.has(s));
const extraInVps   = [...vpsSyms].filter(s => !appSyms.has(s));
check('VPS registry covers every app instrument', missingInVps.length === 0, missingInVps.join(', '));
check('VPS registry has no instrument the app lacks', extraInVps.length === 0, extraInVps.join(', '));

// Tickers must match exactly, or the feed measures a different instrument than
// the screen shows under the same name.
const mismatched = INSTRUMENTS.filter(a => {
  const b = vps.bySymbol(a.sym);
  return b && ((a.oanda || null) !== (b.oanda || null)
            || (a.binance || null) !== (b.binance || null)
            || (a.bfut || null) !== (b.bfut || null));
});
check('every venue ticker matches between app and VPS', mismatched.length === 0,
  mismatched.map(i => i.sym).join(', '));

// ── VPS venue routing ─────────────────────────────────────────────────────
check('VPS knows the futures venue', vps.BINANCE_VENUE['CRWD/USDT']?.venue === 'futures');
check('VPS knows the spot venue',    vps.BINANCE_VENUE['BTC/USDT']?.venue === 'spot');
check('VPS futures host is fapi',    vps.BINANCE_VENUE['XAG/USDT']?.host.includes('fapi.binance.com'));
check('VPS spot host is api',        vps.BINANCE_VENUE['ETH/USDT']?.host.includes('api.binance.com/api/v3'));
check('VPS venue map covers every Binance instrument',
  INSTRUMENTS.filter(i => i.binance || i.bfut).every(i => !!vps.BINANCE_VENUE[i.sym]));
check('an OANDA-only symbol has no Binance venue', !vps.BINANCE_VENUE['XAU/USD']);
check('VPS marks TradFi as candle-capable',
  vps.INSTRUMENTS.filter(i => i.cls === 'tradfi').every(i => i.can.candles));
check('VPS TradFi has no OANDA spread',
  vps.INSTRUMENTS.filter(i => i.cls === 'tradfi').every(i => !i.can.spread));

// ── Screener list ─────────────────────────────────────────────────────────
check('screener offers Crypto and TradFi',
  ASSET_TYPES.includes('Crypto') && ASSET_TYPES.includes('TradFi'));
const scr = new Set(screener.map(i => i.symbol));
const cryptoRows = screener.filter(i => i.assetType === 'Crypto');
const tradfiRows = screener.filter(i => i.assetType === 'TradFi');
check('screener carries every crypto instrument',
  INSTRUMENTS.filter(i => i.cls === 'crypto').every(i => scr.has(i.sym)),
  INSTRUMENTS.filter(i => i.cls==='crypto' && !scr.has(i.sym)).map(i=>i.sym).join());
check('screener carries every TradFi instrument',
  INSTRUMENTS.filter(i => i.cls === 'tradfi').every(i => scr.has(i.sym)));
check('screener crypto uses registry symbols, not BTC/USD',
  cryptoRows.some(i => i.symbol === 'BTC/USDT') && !scr.has('BTC/USD'));
check('derived rows carry no invented price',
  [...cryptoRows, ...tradfiRows].every(i => i.bid === 0 && i.seeded === false));
check('hand-seeded rows are untouched',
  screener.find(i => i.symbol === 'EUR/USD')?.bid > 1);
check('no duplicate rows in the screener list',
  new Set(screener.map(i=>i.symbol)).size === screener.length);
check('every screener row has an id', screener.every(i => !!i.id));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

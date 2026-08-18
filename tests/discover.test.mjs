const ROOT = new URL('../', import.meta.url).pathname;
import { INSTRUMENTS, bySymbol } from '../src/data/instruments.js';

// localStorage shim before importing the module that reads it.
const store = new Map();
globalThis.localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k,v) => store.set(k,String(v)),
  removeItem: k => store.delete(k),
};
const D = await import(`${ROOT}src/utils/binanceDiscovery.js`);

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// ── The duplicates are gone ───────────────────────────────────────────────
// Commodities and silver are carried on BOTH venues by decision. OANDA is
// where they are traded; the perp adds 24/7 pricing plus funding and open
// interest on the same underlying. The overlap is deliberate.
for (const [perp, oanda] of [['WTI/USDT','USOIL'],['BRENT/USDT','UKOIL'],
                             ['NGAS/USDT','NATGAS'],['XAG/USDT','XAG/USD']]) {
  check(`${perp} and ${oanda} both carried`, !!bySymbol(perp)?.bfut && !!bySymbol(oanda)?.oanda);
}
// Double counting is prevented where it would actually distort a result: the
// twelve-major breadth test, which must not weigh oil twice.
const { FOCUS_SET: FS } = await import(`${ROOT}src/utils/strategySearch.js`);
check('breadth set excludes every perp', FS.every(x => !bySymbol(x)?.bfut),
  FS.filter(x => bySymbol(x)?.bfut).join() || 'clean');

// ── Discovery ─────────────────────────────────────────────────────────────
const symbols = [
  { symbol:'CRWDUSDT', contractType:'PERPETUAL', status:'TRADING', quoteAsset:'USDT', baseAsset:'CRWD',
    pricePrecision:2, underlyingType:'INDEX', underlyingSubType:['STOCK'],
    filters:[{ filterType:'PRICE_FILTER', tickSize:'0.01' }] },
  { symbol:'NVDAUSDT', contractType:'PERPETUAL', status:'TRADING', quoteAsset:'USDT', baseAsset:'NVDA',
    pricePrecision:2, underlyingType:'INDEX', underlyingSubType:['STOCK'],
    filters:[{ filterType:'PRICE_FILTER', tickSize:'0.01' }] },
  { symbol:'XLFUSDT', contractType:'PERPETUAL', status:'TRADING', quoteAsset:'USDT', baseAsset:'XLF',
    pricePrecision:3, underlyingType:'INDEX', underlyingSubType:['ETF'],
    filters:[{ filterType:'PRICE_FILTER', tickSize:'0.001' }] },
  { symbol:'BTCUSDT', contractType:'PERPETUAL', status:'TRADING', quoteAsset:'USDT', baseAsset:'BTC',
    pricePrecision:1, underlyingType:'COIN', filters:[{ filterType:'PRICE_FILTER', tickSize:'0.1' }] },
  { symbol:'PEPEUSDT', contractType:'PERPETUAL', status:'TRADING', quoteAsset:'USDT', baseAsset:'PEPE',
    pricePrecision:8, underlyingType:'COIN', filters:[{ filterType:'PRICE_FILTER', tickSize:'0.00000001' }] },
  { symbol:'OLDUSDT', contractType:'PERPETUAL', status:'SETTLING', quoteAsset:'USDT', baseAsset:'OLD',
    pricePrecision:2, underlyingType:'INDEX', underlyingSubType:['STOCK'], filters:[] },
  { symbol:'DATEDUSDT', contractType:'CURRENT_QUARTER', status:'TRADING', quoteAsset:'USDT', baseAsset:'DTD',
    pricePrecision:2, underlyingType:'INDEX', underlyingSubType:['STOCK'], filters:[] },
  { symbol:'XLEUSDT', contractType:'PERPETUAL', status:'TRADING', quoteAsset:'USDT', baseAsset:'XLE',
    pricePrecision:2, underlyingType:'INDEX', underlyingSubType:['ETF'],
    filters:[{ filterType:'PRICE_FILTER', tickSize:'0.01' }] },
];
const tickers = [
  { symbol:'CRWDUSDT', quoteVolume:'1920000' },
  { symbol:'XLFUSDT',  quoteVolume:'5000000' },
  { symbol:'NVDAUSDT', quoteVolume:'12000000' },
  { symbol:'BTCUSDT',  quoteVolume:'9000000000' },
  { symbol:'PEPEUSDT', quoteVolume:'40000000' },
  { symbol:'XLEUSDT',  quoteVolume:'309000' },
];
globalThis.fetch = async (url) => ({ ok:true, json: async () =>
  url.includes('exchangeInfo') ? { symbols } : tickers });
globalThis.AbortSignal = { timeout: () => undefined };

const found = await D.discoverBinancePerps();
const ids = found.map(f => f.bfut);
check('TradFi contracts discovered', ids.includes('NVDAUSDT') && ids.includes('XLFUSDT'));
// CRWD and XLE are already registry entries, so offering them again would be
// a duplicate — discovery must not surface what the app already carries.
check('registry entries are not re-offered', !ids.includes('CRWDUSDT'));
check('crypto excluded by default', !ids.includes('BTCUSDT') && !ids.includes('PEPEUSDT'));
check('non-perpetual excluded', !ids.includes('DATEDUSDT'));
check('non-trading excluded', !ids.includes('OLDUSDT'));
check('already-carried symbol excluded', !ids.includes('XLEUSDT'), 'XLE is in the registry already');
check('sorted by turnover', found[0].bfut === 'NVDAUSDT', found[0]?.bfut);
check('pip comes from the exchange tick size',
  found.find(f=>f.bfut==='XLFUSDT').pip === 0.001, String(found.find(f=>f.bfut==='XLFUSDT').pip));
check('decimals come from pricePrecision',
  found.find(f=>f.bfut==='XLFUSDT').dec === 3);
// BTC is already carried on spot, so even with crypto included it must not be
// offered again; PEPE is not carried and must be.
const withCrypto = await D.discoverBinancePerps({ includeCrypto:true });
check('crypto included when asked', withCrypto.some(f => f.bfut === 'PEPEUSDT'));
check('but an already-carried coin is still not re-offered',
  !withCrypto.some(f => f.bfut === 'BTCUSDT'));

// ── Selection ─────────────────────────────────────────────────────────────
const crwd = found.find(f => f.bfut === 'NVDAUSDT');
check('nothing selected initially', D.loadCustom().length === 0);
D.addCustom(crwd);
check('adding persists', D.loadCustom().length === 1);
D.addCustom(crwd);
check('adding twice is idempotent', D.loadCustom().length === 1);

const merged = D.allInstruments();
check('merged list includes the custom instrument', merged.some(i => i.sym === 'NVDA/USDT'));
check('merged list still has every registry instrument',
  INSTRUMENTS.every(r => merged.some(m => m.sym === r.sym)));
const c = merged.find(i => i.sym === 'NVDA/USDT');
check('custom instrument is fetchable', c.can.candles === true);
check('custom instrument is not offered to spot screens', c.can.spotCandles === false);
check('custom instrument has no order book', c.can.depth === false);
check('custom instrument carries derivatives', c.can.derivatives === true);
check('custom instrument is flagged as such', c.custom === true);
check('custom instrument keeps the exchange pip', c.pip === 0.01);

// A discovered symbol that duplicates a registry entry must never shadow it.
D.saveCustom([{ base:'XAU', bfut:'XAUUSDT', cls:'tradfi', pip:9.99, dec:9 }]);
const merged2 = D.allInstruments();
check('a discovered duplicate cannot shadow the registry',
  merged2.filter(i => i.sym === 'XAU/USD').length === 1
  && merged2.find(i => i.sym === 'XAU/USD').pip === 0.1);
check('and does not appear twice under its own name',
  merged2.filter(i => i.sym === 'XAU/USDT').length <= 1);

D.saveCustom([]);
D.addCustom(crwd);
D.removeCustom('NVDAUSDT');
check('removal persists', D.loadCustom().length === 0);
check('and drops out of the merged list',
  !D.allInstruments().some(i => i.sym === 'NVDA/USDT'));
check('a junk entry cannot crash the add path', D.addCustom(undefined).length === 0);
check('nor one missing its ticker', D.addCustom({ base:'X' }).length === 0);

// Corrupt storage must not take the app down.
store.set(D.CUSTOM_KEY, 'not json');
check('corrupt storage degrades to empty', D.loadCustom().length === 0);
check('and the merged list still works', D.allInstruments().length === INSTRUMENTS.length);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

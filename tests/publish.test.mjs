const ROOT = new URL('../', import.meta.url).pathname;
const store = new Map();
globalThis.localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k,v) => store.set(k,String(v)),
  removeItem: k => store.delete(k),
};
globalThis.AbortSignal = { timeout: () => undefined };
const { INSTRUMENTS } = await import(`${ROOT}src/data/instruments.js`);
const D = await import(`${ROOT}src/utils/binanceDiscovery.js`);

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

const mk = (t, base, prec=2, tick='0.01', sub=['STOCK']) => ({
  symbol:t, contractType:'PERPETUAL', status:'TRADING', quoteAsset:'USDT', baseAsset:base,
  pricePrecision:prec, underlyingType:'INDEX', underlyingSubType:sub,
  filters:[{ filterType:'PRICE_FILTER', tickSize:tick }] });
const symbols = [mk('NVDAUSDT','NVDA'), mk('TSLAUSDT','TSLA'), mk('XLFUSDT','XLF',3,'0.001',['ETF']),
                 mk('CRWDUSDT','CRWD')];  // CRWD is already in the registry
globalThis.fetch = async (url) => ({ ok:true, json: async () =>
  url.includes('exchangeInfo') ? { symbols }
  : symbols.map(s => ({ symbol:s.symbol, quoteVolume:'1000000' })) });

// ── The published list is the WHOLE picture, not a diff ───────────────────
const list = await D.buildTradfiList();
const syms = list.map(e => e.sym);
check('published list includes the static registry entries',
  ['XAG/USDT','CRWD/USDT','ORCL/USDT'].every(s => syms.includes(s)));
check('and the newly discovered ones', syms.includes('NVDA/USDT') && syms.includes('TSLA/USDT'));
check('registry TradFi count is covered',
  INSTRUMENTS.filter(i=>i.cls==='tradfi').every(i => syms.includes(i.sym)));
check('no duplicates', new Set(syms).size === syms.length);
check('CRWD appears once, from the registry', syms.filter(s => s==='CRWD/USDT').length === 1);
check('sorted for a readable diff', [...syms].sort((a,b)=>a.localeCompare(b)).join() === syms.join());
check('entries carry only registry fields', list.every(e =>
  e.sym && e.bfut && e.cls === 'tradfi' && e.perp === true
  && typeof e.pip === 'number' && typeof e.dec === 'number'
  && e.quoteVolume === undefined && e.tags === undefined),
  'volume changes every minute and must not sit in a file that tracks listings');
check('discovered pip comes from tick size',
  list.find(e => e.sym === 'XLF/USDT').pip === 0.001);

// ── Publishing ────────────────────────────────────────────────────────────
let written = null;
const ghRead = async () => ({ sha: 'abc123' });
const ghWrite = async (path, content, msg, sha) => { written = { path, content, msg, sha }; };
await D.publishTradfiList(ghRead, ghWrite);
check('writes to the path the bot reads', written.path === D.TRADFI_PATH, written.path);
check('sends the existing sha so a concurrent write conflicts', written.sha === 'abc123');
check('payload is the instrument list', Array.isArray(written.content.instruments)
  && written.content.instruments.length === list.length);
check('payload is timestamped', !!written.content.updatedAt);

// A first publish, with no file yet, must not throw.
written = null;
const ghReadFail = async () => { throw new Error('404'); };
await D.publishTradfiList(ghReadFail, ghWrite);
check('first publish works with no existing file', written?.sha === null);

// ── Merging back into the app ─────────────────────────────────────────────
check('publishing caches locally', D.loadPublished().length === list.length);
const merged = D.allInstruments();
check('discovered instruments appear in the app', merged.some(i => i.sym === 'NVDA/USDT'));
check('every registry instrument survives', INSTRUMENTS.every(r => merged.some(m => m.sym === r.sym)));
check('no duplicates after merge', new Set(merged.map(i=>i.sym)).size === merged.length);
const crwd = merged.filter(i => i.sym === 'CRWD/USDT');
check('a published entry cannot shadow the registry',
  crwd.length === 1 && crwd[0].custom === undefined,
  'the registry version must win');
const nvda = merged.find(i => i.sym === 'NVDA/USDT');
check('discovered instruments are futures-routed', nvda.bfut === 'NVDAUSDT' && !nvda.binance);
check('and excluded from spot-only screens', nvda.can.spotCandles === false);

// Sync from the repo on another device.
const ghReadList = async () => ({ content: { instruments: [{ sym:'AMD/USDT', bfut:'AMDUSDT', cls:'tradfi', pip:0.01, dec:2 }] } });
await D.syncPublished(ghReadList);
check('a second device picks up the published list',
  D.allInstruments().some(i => i.sym === 'AMD/USDT'));
check('a failed sync keeps what was cached',
  (await D.syncPublished(async () => { throw new Error('offline'); })).length === 1);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

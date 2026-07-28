// src/data/instruments.js
// Canonical instrument registry — the single source of truth for what this app
// can trade, price, and analyse.
//
// Before this existed each tab kept its own list (48 in the backtester, 29 in
// alerts, 16 in positioning), so an instrument could exist in one screen and
// silently not in another. Everything now derives from here, and every screen
// can ask what a given instrument actually supports rather than assuming.

export const CLASS = {
  fx:     { label:'FX',      color:'#0ea5e9' },
  metal:  { label:'Metals',  color:'#eab308' },
  index:  { label:'Indices', color:'#a78bfa' },
  energy: { label:'Energy',  color:'#f97316' },
  crypto: { label:'Crypto',  color:'#22c55e' },
};

// cot: CFTC contract code (positioning available)
// oanda / binance: venue symbols (pricing available)
const R = [
  // ── FX majors ──────────────────────────────────────────────────────────────
  { sym:'EUR/USD', name:'Euro / US Dollar',        cls:'fx', oanda:'EUR_USD', cot:'099741', pip:0.0001, dec:5, major:true },
  { sym:'GBP/USD', name:'Pound / US Dollar',       cls:'fx', oanda:'GBP_USD', cot:'096742', pip:0.0001, dec:5, major:true },
  { sym:'USD/JPY', name:'US Dollar / Yen',         cls:'fx', oanda:'USD_JPY', cot:'097741', pip:0.01,   dec:3, major:true },
  { sym:'USD/CHF', name:'US Dollar / Swiss Franc', cls:'fx', oanda:'USD_CHF', cot:'092741', pip:0.0001, dec:5, major:true },
  { sym:'USD/CAD', name:'US Dollar / Canadian $',  cls:'fx', oanda:'USD_CAD', cot:'090741', pip:0.0001, dec:5, major:true },
  { sym:'AUD/USD', name:'Australian $ / US $',     cls:'fx', oanda:'AUD_USD', cot:'232741', pip:0.0001, dec:5, major:true },
  { sym:'NZD/USD', name:'New Zealand $ / US $',    cls:'fx', oanda:'NZD_USD', cot:'112741', pip:0.0001, dec:5, major:true },

  // ── FX crosses ─────────────────────────────────────────────────────────────
  { sym:'EUR/GBP', name:'Euro / Pound',        cls:'fx', oanda:'EUR_GBP', pip:0.0001, dec:5 },
  { sym:'EUR/JPY', name:'Euro / Yen',          cls:'fx', oanda:'EUR_JPY', pip:0.01,   dec:3 },
  { sym:'GBP/JPY', name:'Pound / Yen',         cls:'fx', oanda:'GBP_JPY', pip:0.01,   dec:3 },
  { sym:'EUR/AUD', name:'Euro / Australian $', cls:'fx', oanda:'EUR_AUD', pip:0.0001, dec:5 },
  { sym:'EUR/CAD', name:'Euro / Canadian $',   cls:'fx', oanda:'EUR_CAD', pip:0.0001, dec:5 },
  { sym:'EUR/CHF', name:'Euro / Swiss Franc',  cls:'fx', oanda:'EUR_CHF', pip:0.0001, dec:5 },
  { sym:'EUR/NZD', name:'Euro / NZ Dollar',    cls:'fx', oanda:'EUR_NZD', pip:0.0001, dec:5 },
  { sym:'GBP/CHF', name:'Pound / Swiss Franc', cls:'fx', oanda:'GBP_CHF', pip:0.0001, dec:5 },
  { sym:'GBP/CAD', name:'Pound / Canadian $',  cls:'fx', oanda:'GBP_CAD', pip:0.0001, dec:5 },
  { sym:'GBP/AUD', name:'Pound / Australian $',cls:'fx', oanda:'GBP_AUD', pip:0.0001, dec:5 },
  { sym:'GBP/NZD', name:'Pound / NZ Dollar',   cls:'fx', oanda:'GBP_NZD', pip:0.0001, dec:5 },
  { sym:'AUD/JPY', name:'Australian $ / Yen',  cls:'fx', oanda:'AUD_JPY', pip:0.01,   dec:3 },
  { sym:'AUD/CHF', name:'Australian $ / CHF',  cls:'fx', oanda:'AUD_CHF', pip:0.0001, dec:5 },
  { sym:'AUD/CAD', name:'Australian $ / CAD',  cls:'fx', oanda:'AUD_CAD', pip:0.0001, dec:5 },
  { sym:'AUD/NZD', name:'Australian $ / NZD',  cls:'fx', oanda:'AUD_NZD', pip:0.0001, dec:5 },
  { sym:'NZD/JPY', name:'NZ Dollar / Yen',     cls:'fx', oanda:'NZD_JPY', pip:0.01,   dec:3 },
  { sym:'NZD/CHF', name:'NZ Dollar / CHF',     cls:'fx', oanda:'NZD_CHF', pip:0.0001, dec:5 },
  { sym:'NZD/CAD', name:'NZ Dollar / CAD',     cls:'fx', oanda:'NZD_CAD', pip:0.0001, dec:5 },
  { sym:'CAD/JPY', name:'Canadian $ / Yen',    cls:'fx', oanda:'CAD_JPY', pip:0.01,   dec:3 },
  { sym:'CAD/CHF', name:'Canadian $ / CHF',    cls:'fx', oanda:'CAD_CHF', pip:0.0001, dec:5 },
  { sym:'CHF/JPY', name:'Swiss Franc / Yen',   cls:'fx', oanda:'CHF_JPY', pip:0.01,   dec:3 },

  // ── Metals ─────────────────────────────────────────────────────────────────
  { sym:'XAU/USD', name:'Gold',   cls:'metal', oanda:'XAU_USD', cot:'088691', pip:0.1,   dec:2, major:true },
  { sym:'XAG/USD', name:'Silver', cls:'metal', oanda:'XAG_USD', cot:'084691', pip:0.001, dec:3, major:true },

  // ── Indices ────────────────────────────────────────────────────────────────
  { sym:'US500',  name:'S&P 500',      cls:'index', oanda:'SPX500_USD', cot:'13874A', pip:0.1, dec:1, major:true },
  { sym:'US100',  name:'Nasdaq 100',   cls:'index', oanda:'NAS100_USD', cot:'209742', pip:1,   dec:1, major:true },
  { sym:'US30',   name:'Dow Jones 30', cls:'index', oanda:'US30_USD',                 pip:1,   dec:1 },
  { sym:'US2000', name:'Russell 2000', cls:'index', oanda:'US2000_USD',               pip:0.1, dec:1 },
  { sym:'UK100',  name:'FTSE 100',     cls:'index', oanda:'UK100_GBP',                pip:1,   dec:1 },
  { sym:'GER40',  name:'DAX 40',       cls:'index', oanda:'DE30_EUR',                 pip:1,   dec:1 },
  { sym:'JPN225', name:'Nikkei 225',   cls:'index', oanda:'JP225_USD',                pip:1,   dec:1 },

  // ── Energy ─────────────────────────────────────────────────────────────────
  { sym:'USOIL',  name:'WTI Crude Oil',  cls:'energy', oanda:'WTICO_USD',  cot:'067651', pip:0.01,  dec:2, major:true },
  { sym:'UKOIL',  name:'Brent Crude Oil',cls:'energy', oanda:'BCO_USD',                  pip:0.01,  dec:2 },
  { sym:'NATGAS', name:'Natural Gas',    cls:'energy', oanda:'NATGAS_USD', cot:'023651', pip:0.001, dec:3 },

  // ── Crypto ─────────────────────────────────────────────────────────────────
  { sym:'BTC/USDT',  name:'Bitcoin',   cls:'crypto', binance:'BTCUSDT',  perp:true, pip:1,      dec:1, major:true },
  { sym:'ETH/USDT',  name:'Ethereum',  cls:'crypto', binance:'ETHUSDT',  perp:true, pip:0.1,    dec:2, major:true },
  { sym:'BNB/USDT',  name:'BNB',       cls:'crypto', binance:'BNBUSDT',  perp:true, pip:0.1,    dec:2 },
  { sym:'SOL/USDT',  name:'Solana',    cls:'crypto', binance:'SOLUSDT',  perp:true, pip:0.01,   dec:2 },
  { sym:'XRP/USDT',  name:'XRP',       cls:'crypto', binance:'XRPUSDT',  perp:true, pip:0.0001, dec:4 },
  { sym:'ADA/USDT',  name:'Cardano',   cls:'crypto', binance:'ADAUSDT',  perp:true, pip:0.0001, dec:4 },
  { sym:'DOGE/USDT', name:'Dogecoin',  cls:'crypto', binance:'DOGEUSDT', perp:true, pip:0.0001, dec:4 },
  { sym:'AVAX/USDT', name:'Avalanche', cls:'crypto', binance:'AVAXUSDT', perp:true, pip:0.001,  dec:3 },
  { sym:'LINK/USDT', name:'Chainlink', cls:'crypto', binance:'LINKUSDT', perp:true, pip:0.001,  dec:3 },
  { sym:'DOT/USDT',  name:'Polkadot',  cls:'crypto', binance:'DOTUSDT',  perp:true, pip:0.001,  dec:3 },
  { sym:'LTC/USDT',  name:'Litecoin',  cls:'crypto', binance:'LTCUSDT',  perp:true, pip:0.01,   dec:2 },
  { sym:'TON/USDT',  name:'Toncoin',   cls:'crypto', binance:'TONUSDT',  perp:true, pip:0.001,  dec:3 },
];

// Capabilities are derived, never hand-maintained — a screen asks what an
// instrument supports instead of assuming, so a missing feed shows as
// "unavailable" rather than as a blank panel or a fabricated number.
export const INSTRUMENTS = R.map(i => ({
  ...i,
  base:  i.sym.includes('/') ? i.sym.split('/')[0] : null,
  quote: i.sym.includes('/') ? i.sym.split('/')[1] : null,
  can: {
    price:       !!(i.oanda || i.binance),
    candles:     !!(i.oanda || i.binance),
    spread:      !!i.oanda,          // bid/ask candles
    positioning: !!i.cot,            // CFTC COT
    derivatives: !!i.perp,           // funding / OI / L-S ratio
    depth:       !!i.binance,        // real order book
    book:        false,              // OANDA order/position book — refused on this account
  },
}));

export const bySymbol = sym => INSTRUMENTS.find(i => i.sym === sym) || null;
export const byClass  = cls => INSTRUMENTS.filter(i => i.cls === cls);
export const majors   = () => INSTRUMENTS.filter(i => i.major);
export const withCap  = cap => INSTRUMENTS.filter(i => i.can[cap]);

export const CLASS_ORDER = ['metal','index','energy','fx','crypto'];

// Currencies a given instrument is exposed to — used to attach the right
// economic events and news to it.
export function exposureOf(inst) {
  if (!inst) return [];
  if (inst.cls === 'crypto') return ['USD'];
  if (inst.cls === 'index')  return inst.sym.startsWith('US') ? ['USD']
    : inst.sym === 'UK100' ? ['GBP'] : inst.sym === 'GER40' ? ['EUR']
    : inst.sym === 'JPN225' ? ['JPY'] : ['USD'];
  if (inst.cls === 'energy') return ['USD'];
  if (inst.cls === 'metal')  return ['USD'];
  return [inst.base, inst.quote].filter(Boolean);
}

// Counts for honest reporting in the UI
export const REGISTRY_STATS = {
  total: INSTRUMENTS.length,
  byClass: Object.fromEntries(CLASS_ORDER.map(c => [c, byClass(c).length])),
  withPositioning: withCap('positioning').length,
  withSpread: withCap('spread').length,
};

'use strict';
// vps-bot/src/instruments.js
// The bot's copy of the app's canonical registry (src/data/instruments.js).
//
// The two cannot import from each other — the app is ESM in a browser bundle,
// the bot is CommonJS on a VPS — so this file mirrors it deliberately and is
// the ONLY place the bot lists instruments. Before it existed, alertChecker
// carried its own three tables and anything new had to repeat them a fourth
// time. If you add an instrument to the app registry, add it here too.

const R = [
  // ── FX majors ──
  { sym:'EUR/USD', name:'Euro / US Dollar',        cls:'fx', oanda:'EUR_USD', cot:'099741', dec:5 },
  { sym:'GBP/USD', name:'Pound / US Dollar',       cls:'fx', oanda:'GBP_USD', cot:'096742', dec:5 },
  { sym:'USD/JPY', name:'US Dollar / Yen',         cls:'fx', oanda:'USD_JPY', cot:'097741', dec:3 },
  { sym:'USD/CHF', name:'US Dollar / Swiss Franc', cls:'fx', oanda:'USD_CHF', cot:'092741', dec:5 },
  { sym:'USD/CAD', name:'US Dollar / Canadian $',  cls:'fx', oanda:'USD_CAD', cot:'090741', dec:5 },
  { sym:'AUD/USD', name:'Australian $ / US $',     cls:'fx', oanda:'AUD_USD', cot:'232741', dec:5 },
  { sym:'NZD/USD', name:'New Zealand $ / US $',    cls:'fx', oanda:'NZD_USD', cot:'112741', dec:5 },

  // ── FX crosses ──
  { sym:'EUR/GBP', name:'Euro / Pound',         cls:'fx', oanda:'EUR_GBP', dec:5 },
  { sym:'EUR/JPY', name:'Euro / Yen',           cls:'fx', oanda:'EUR_JPY', dec:3 },
  { sym:'GBP/JPY', name:'Pound / Yen',          cls:'fx', oanda:'GBP_JPY', dec:3 },
  { sym:'EUR/AUD', name:'Euro / Australian $',  cls:'fx', oanda:'EUR_AUD', dec:5 },
  { sym:'EUR/CAD', name:'Euro / Canadian $',    cls:'fx', oanda:'EUR_CAD', dec:5 },
  { sym:'EUR/CHF', name:'Euro / Swiss Franc',   cls:'fx', oanda:'EUR_CHF', dec:5 },
  { sym:'EUR/NZD', name:'Euro / NZ Dollar',     cls:'fx', oanda:'EUR_NZD', dec:5 },
  { sym:'GBP/CHF', name:'Pound / Swiss Franc',  cls:'fx', oanda:'GBP_CHF', dec:5 },
  { sym:'GBP/CAD', name:'Pound / Canadian $',   cls:'fx', oanda:'GBP_CAD', dec:5 },
  { sym:'GBP/AUD', name:'Pound / Australian $', cls:'fx', oanda:'GBP_AUD', dec:5 },
  { sym:'GBP/NZD', name:'Pound / NZ Dollar',    cls:'fx', oanda:'GBP_NZD', dec:5 },
  { sym:'AUD/JPY', name:'Australian $ / Yen',   cls:'fx', oanda:'AUD_JPY', dec:3 },
  { sym:'AUD/CHF', name:'Australian $ / CHF',   cls:'fx', oanda:'AUD_CHF', dec:5 },
  { sym:'AUD/CAD', name:'Australian $ / CAD',   cls:'fx', oanda:'AUD_CAD', dec:5 },
  { sym:'AUD/NZD', name:'Australian $ / NZD',   cls:'fx', oanda:'AUD_NZD', dec:5 },
  { sym:'NZD/JPY', name:'NZ Dollar / Yen',      cls:'fx', oanda:'NZD_JPY', dec:3 },
  { sym:'NZD/CHF', name:'NZ Dollar / CHF',      cls:'fx', oanda:'NZD_CHF', dec:5 },
  { sym:'NZD/CAD', name:'NZ Dollar / CAD',      cls:'fx', oanda:'NZD_CAD', dec:5 },
  { sym:'CAD/JPY', name:'Canadian $ / Yen',     cls:'fx', oanda:'CAD_JPY', dec:3 },
  { sym:'CAD/CHF', name:'Canadian $ / CHF',     cls:'fx', oanda:'CAD_CHF', dec:5 },
  { sym:'CHF/JPY', name:'Swiss Franc / Yen',    cls:'fx', oanda:'CHF_JPY', dec:3 },

  // ── Metals ──
  { sym:'XAU/USD', name:'Gold',   cls:'metal', oanda:'XAU_USD', cot:'088691', dec:2 },
  { sym:'XAG/USD', name:'Silver', cls:'metal', oanda:'XAG_USD', cot:'084691', dec:3 },

  // ── Indices ──
  { sym:'US500',  name:'S&P 500',      cls:'index', oanda:'SPX500_USD', cot:'13874A', dec:1 },
  { sym:'US100',  name:'Nasdaq 100',   cls:'index', oanda:'NAS100_USD', cot:'209742', dec:1 },
  { sym:'US30',   name:'Dow Jones 30', cls:'index', oanda:'US30_USD',   dec:1 },
  { sym:'US2000', name:'Russell 2000', cls:'index', oanda:'US2000_USD', dec:1 },
  { sym:'UK100',  name:'FTSE 100',     cls:'index', oanda:'UK100_GBP',  dec:1 },
  { sym:'GER40',  name:'DAX 40',       cls:'index', oanda:'DE30_EUR',   dec:1 },
  { sym:'JPN225', name:'Nikkei 225',   cls:'index', oanda:'JP225_USD',  dec:1 },

  // ── Energy ──
  { sym:'USOIL',  name:'WTI Crude Oil',   cls:'energy', oanda:'WTICO_USD',  cot:'067651', dec:2 },
  { sym:'UKOIL',  name:'Brent Crude Oil', cls:'energy', oanda:'BCO_USD',    dec:2 },
  { sym:'NATGAS', name:'Natural Gas',     cls:'energy', oanda:'NATGAS_USD', cot:'023651', dec:3 },

  // ── Crypto ──
  { sym:'BTC/USDT',  name:'Bitcoin',   cls:'crypto', binance:'BTCUSDT',  dec:1 },
  { sym:'ETH/USDT',  name:'Ethereum',  cls:'crypto', binance:'ETHUSDT',  dec:2 },
  { sym:'BNB/USDT',  name:'BNB',       cls:'crypto', binance:'BNBUSDT',  dec:2 },
  { sym:'SOL/USDT',  name:'Solana',    cls:'crypto', binance:'SOLUSDT',  dec:2 },
  { sym:'XRP/USDT',  name:'XRP',       cls:'crypto', binance:'XRPUSDT',  dec:4 },
  { sym:'ADA/USDT',  name:'Cardano',   cls:'crypto', binance:'ADAUSDT',  dec:4 },
  { sym:'DOGE/USDT', name:'Dogecoin',  cls:'crypto', binance:'DOGEUSDT', dec:4 },
  { sym:'AVAX/USDT', name:'Avalanche', cls:'crypto', binance:'AVAXUSDT', dec:3 },
  { sym:'LINK/USDT', name:'Chainlink', cls:'crypto', binance:'LINKUSDT', dec:3 },
  { sym:'DOT/USDT',  name:'Polkadot',  cls:'crypto', binance:'DOTUSDT',  dec:3 },
  { sym:'LTC/USDT',  name:'Litecoin',  cls:'crypto', binance:'LTCUSDT',  dec:2 },
  { sym:'TON/USDT',  name:'Toncoin',   cls:'crypto', binance:'TONUSDT',  dec:3 },

  // ── Binance TradFi perpetuals ──
  // Mirrors src/data/instruments.js. `bfut` means the FUTURES venue only —
  // asking api.binance.com for one of these returns a 400, so the fetch picks
  // its host from this field rather than assuming spot.
  { sym:'XAG/USDT',  name:'Silver (perp)',      cls:'tradfi', bfut:'XAGUSDT',    dec:2 },
  { sym:'WTI/USDT',  name:'WTI Crude (perp)',   cls:'tradfi', bfut:'CLUSDT',     dec:2 },
  { sym:'BRENT/USDT',name:'Brent Crude (perp)', cls:'tradfi', bfut:'BZUSDT',     dec:2 },
  { sym:'NGAS/USDT', name:'Natural Gas (perp)', cls:'tradfi', bfut:'NATGASUSDT', dec:3 },
  { sym:'XLE/USDT',  name:'Energy Sector ETF',  cls:'tradfi', bfut:'XLEUSDT',    dec:2 },
  { sym:'SOXS/USDT', name:'Semis Bear 3x ETF',  cls:'tradfi', bfut:'SOXSUSDT',   dec:2 },
  { sym:'SNXX/USDT', name:'SNDK Long 2x ETF',   cls:'tradfi', bfut:'SNXXUSDT',   dec:2 },
  { sym:'ORCL/USDT', name:'Oracle',             cls:'tradfi', bfut:'ORCLUSDT',   dec:2 },
  { sym:'BABA/USDT', name:'Alibaba',            cls:'tradfi', bfut:'BABAUSDT',   dec:2 },
  { sym:'LLY/USDT',  name:'Eli Lilly',          cls:'tradfi', bfut:'LLYUSDT',    dec:2 },
  { sym:'CRWD/USDT', name:'CrowdStrike',        cls:'tradfi', bfut:'CRWDUSDT',   dec:2 },
  { sym:'NFLX/USDT', name:'Netflix',            cls:'tradfi', bfut:'NFLXUSDT',   dec:2 },
  { sym:'HPE/USDT',  name:'HPE',                cls:'tradfi', bfut:'HPEUSDT',    dec:2 },
  { sym:'ADBE/USDT', name:'Adobe',              cls:'tradfi', bfut:'ADBEUSDT',   dec:2 },
  { sym:'TTWO/USDT', name:'Take-Two',           cls:'tradfi', bfut:'TTWOUSDT',   dec:2 },
  { sym:'BX/USDT',   name:'Blackstone',         cls:'tradfi', bfut:'BXUSDT',     dec:2 },
  { sym:'PANW/USDT', name:'Palo Alto Networks', cls:'tradfi', bfut:'PANWUSDT',   dec:2 },
  { sym:'UBER/USDT', name:'Uber',               cls:'tradfi', bfut:'UBERUSDT',   dec:2 },
  { sym:'BSP/USDT',  name:'Bending Spoons',     cls:'tradfi', bfut:'BSPUSDT',    dec:2 },
  { sym:'SHAZ/USDT', name:'SharonAI',           cls:'tradfi', bfut:'SHAZUSDT',   dec:2 },
];

const INSTRUMENTS = R.map(i => ({
  ...i,
  can: {
    candles:     !!(i.oanda || i.binance || i.bfut),
    spread:      !!i.oanda,   // bid/ask candles
    positioning: !!i.cot,     // CFTC COT
  },
}));

const OANDA_MAP   = Object.fromEntries(R.filter(i => i.oanda).map(i => [i.sym, i.oanda]));
const BINANCE_MAP = Object.fromEntries(R.filter(i => i.binance).map(i => [i.sym, i.binance]));
const DEC         = Object.fromEntries(R.map(i => [i.sym, i.dec]));

const bySymbol = sym => INSTRUMENTS.find(i => i.sym === sym) || null;

// Which Binance venue a symbol lives on, if any.
//
// BINANCE_MAP only ever knew spot tickers, so every caller that used it to
// decide "is this a Binance instrument" silently answered no for the TradFi
// perpetuals and fell through to the OANDA branch, where they do not exist
// either. This returns the host as well as the ticker so the decision and the
// URL cannot drift apart.
const BINANCE_VENUE = Object.fromEntries(
  R.filter(i => i.binance || i.bfut).map(i => [i.sym, i.binance
    ? { host: 'https://api.binance.com/api/v3',   ticker: i.binance, venue: 'spot' }
    : { host: 'https://fapi.binance.com/fapi/v1', ticker: i.bfut,    venue: 'futures' }]),
);

module.exports = { INSTRUMENTS, OANDA_MAP, BINANCE_MAP, BINANCE_VENUE, DEC, bySymbol };

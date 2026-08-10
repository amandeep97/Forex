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
  tradfi: { label:'TradFi',  color:'#f472b6' },
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

  // ── Binance TradFi perpetuals ──────────────────────────────────────────────
  // Perpetual futures on stocks, ETFs and commodities, settled in USDT.
  //
  // `bfut` rather than `binance`: these exist only on the FUTURES venue
  // (fapi.binance.com). Asking the spot host for one returns a 400, the
  // caller's catch swallows it, and the app falls through to simulated
  // candles — so the venue is resolved from this field by binanceKlines.js
  // and never guessed from the symbol.
  //
  // Two things make them worth having despite being derivatives rather than
  // the underlying. There are no splits or dividends inside the price series,
  // so no fake 50% gap for an ATR stop to trip over; and they carry funding
  // and open interest, which is positioning data almost nobody has on a single
  // stock.
  //
  // They are NOT the underlying. The perp runs 24/7 while the stock market is
  // shut about seventeen hours a day, so for most of its life it trades on
  // sentiment and funding rather than on the company. A rule found on CRWDUSDT
  // is a rule about the perpetual, not about CrowdStrike.
  //
  // History is the real constraint: these are recent listings, and the deep
  // search refuses anything under 180 days. Run the health check on the
  // Backtester before trusting any of them — it reports what actually loaded.

  // Commodities and metals. These deliberately overlap USOIL, UKOIL, NATGAS
  // and XAG/USD on OANDA, and the overlap is the point: OANDA gives five days
  // a week and no positioning, while the perp runs 24/7 and carries funding
  // and open interest. Same underlying, genuinely different information.
  //
  // They are excluded from FOCUS_SET so the twelve-major breadth test cannot
  // count oil twice.
  { sym:'XAG/USDT',  name:'Silver (perp)',     cls:'tradfi', bfut:'XAGUSDT',    perp:true, pip:0.01,  dec:2 },
  { sym:'WTI/USDT',  name:'WTI Crude (perp)',  cls:'tradfi', bfut:'CLUSDT',     perp:true, pip:0.01,  dec:2 },
  { sym:'BRENT/USDT',name:'Brent Crude (perp)',cls:'tradfi', bfut:'BZUSDT',     perp:true, pip:0.01,  dec:2 },
  { sym:'NGAS/USDT', name:'Natural Gas (perp)',cls:'tradfi', bfut:'NATGASUSDT', perp:true, pip:0.001, dec:3 },

  // Sector and leveraged ETFs. XLE is the cross-asset peer worth more than any
  // single name here; the other two are leveraged and decay against a flat
  // index, so they are not proxies for anything — kept because a 2x and a 3x
  // inverse tape are genuinely different volatility regimes to test against.
  { sym:'XLE/USDT',  name:'Energy Sector ETF', cls:'tradfi', bfut:'XLEUSDT',    perp:true, pip:0.01,  dec:2 },
  { sym:'SOXS/USDT', name:'Semis Bear 3x ETF', cls:'tradfi', bfut:'SOXSUSDT',   perp:true, pip:0.01,  dec:2, leveraged:true },
  { sym:'SNXX/USDT', name:'SNDK Long 2x ETF',  cls:'tradfi', bfut:'SNXXUSDT',   perp:true, pip:0.01,  dec:2, leveraged:true },

  // Single names. Thin — a million or two a day against eight hundred million
  // on silver — so spread will be a large share of the daily range and the
  // breadth test will judge them harshly, correctly.
  { sym:'ORCL/USDT', name:'Oracle',            cls:'tradfi', bfut:'ORCLUSDT',   perp:true, pip:0.01,  dec:2 },
  { sym:'BABA/USDT', name:'Alibaba',           cls:'tradfi', bfut:'BABAUSDT',   perp:true, pip:0.01,  dec:2 },
  { sym:'LLY/USDT',  name:'Eli Lilly',         cls:'tradfi', bfut:'LLYUSDT',    perp:true, pip:0.01,  dec:2 },
  { sym:'CRWD/USDT', name:'CrowdStrike',       cls:'tradfi', bfut:'CRWDUSDT',   perp:true, pip:0.01,  dec:2 },
  { sym:'NFLX/USDT', name:'Netflix',           cls:'tradfi', bfut:'NFLXUSDT',   perp:true, pip:0.01,  dec:2 },
  { sym:'HPE/USDT',  name:'HPE',               cls:'tradfi', bfut:'HPEUSDT',    perp:true, pip:0.01,  dec:2 },
  { sym:'ADBE/USDT', name:'Adobe',             cls:'tradfi', bfut:'ADBEUSDT',   perp:true, pip:0.01,  dec:2 },
  { sym:'TTWO/USDT', name:'Take-Two',          cls:'tradfi', bfut:'TTWOUSDT',   perp:true, pip:0.01,  dec:2 },
  { sym:'BX/USDT',   name:'Blackstone',        cls:'tradfi', bfut:'BXUSDT',     perp:true, pip:0.01,  dec:2 },
  { sym:'PANW/USDT', name:'Palo Alto Networks',cls:'tradfi', bfut:'PANWUSDT',   perp:true, pip:0.01,  dec:2 },
  { sym:'UBER/USDT', name:'Uber',              cls:'tradfi', bfut:'UBERUSDT',   perp:true, pip:0.01,  dec:2 },
  { sym:'BSP/USDT',  name:'Bending Spoons',    cls:'tradfi', bfut:'BSPUSDT',    perp:true, pip:0.01,  dec:2 },
  { sym:'SHAZ/USDT', name:'SharonAI',          cls:'tradfi', bfut:'SHAZUSDT',   perp:true, pip:0.01,  dec:2 },
];

// Capabilities are derived, never hand-maintained — a screen asks what an
// instrument supports instead of assuming, so a missing feed shows as
// "unavailable" rather than as a blank panel or a fabricated number.
export const INSTRUMENTS = R.map(i => ({
  ...i,
  base:  i.sym.includes('/') ? i.sym.split('/')[0] : null,
  quote: i.sym.includes('/') ? i.sym.split('/')[1] : null,
  can: {
    price:       !!(i.oanda || i.binance || i.bfut),
    candles:     !!(i.oanda || i.binance || i.bfut),
    spread:      !!i.oanda,          // bid/ask candles
    positioning: !!i.cot,            // CFTC COT
    derivatives: !!i.perp,           // funding / OI / L-S ratio
    // Order book and the spot ticker are SPOT endpoints. A futures-only
    // instrument has neither, and saying otherwise would send half the app
    // to a URL that returns nothing for it.
    depth:       !!i.binance,
    book:        false,              // OANDA order/position book — refused on this account
    // Kept for the two screens that still build their own spot URL — order
    // book depth in flowFeed, and the VPS live feed. Everything else now goes
    // through binanceKlines and picks the venue from the instrument, so a
    // futures-only symbol is a first-class instrument rather than a hidden one.
    spotCandles: !!(i.oanda || i.binance),
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

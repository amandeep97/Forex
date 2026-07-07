// ── Market Data ───────────────────────────────────────────────────────────────
// Replace with live feed (WebSocket / REST API) when ready.

export const ASSET_TYPES = ['All', 'Forex', 'Metals', 'Indices', 'Energy'];

export const FOREX_CATEGORIES = ['All', 'Majors', 'Minors', 'Exotics'];

export const STRUCTURES          = ['All', 'bullish', 'bearish'];
export const HTF_BIASES          = ['All', 'bullish', 'bearish', 'sideways'];
export const ZONES               = ['All', 'premium', 'discount'];
export const STRUCTURE_TIMEFRAMES = [
  { value: '1m',  label: '1M'  }, { value: '5m',  label: '5M'  },
  { value: '15m', label: '15M' }, { value: '30m', label: '30M' },
  { value: '1h',  label: '1H'  }, { value: '2h',  label: '2H'  },
  { value: '4h',  label: '4H'  }, { value: '8h',  label: '8H'  },
  { value: '12h', label: '12H' }, { value: '1d',  label: '1D'  },
  { value: '3d',  label: '3D'  }, { value: '1w',  label: '1W'  },
];
export const DEFAULT_FILTERS = {
  search: '', baseCurrency: 'All', structureTF: '4h', structure: 'All', htfBias: 'All',
  requireBos: false, bosTF: '4h', requireChoch: false, chochTF: '4h', requireSweep: false,
  obDir: 'All', requireOb: false, fvgDir: 'All', requireFvg: false, fvgObMode: 'AND',
  liqType: 'All', zone: 'All',
  requireNearResistance: false, requireNearSupport: false,
  requireBrokeResistance: false, requireBrokeSupport: false,
  requireTrendlineBull: false, requireTrendlineBear: false, requireTrendlineBreak: false,
  changeMin: '', changeMax: '', rsiMin: '', rsiMax: '', mfiMin: '', mfiMax: '',
  volumeMin: 0, volSpikeMin: 0,
  emaPriceFilter: 'Any', emaAlignFilter: 'Any', emaCrossFilter: 'Any',
  divFilter: 'Any', macdFilter: 'Any', equalFilter: 'Any', signalScoreMin: -5,
  dispFilter: 'Any', breakerFilter: 'Any', oteFilter: 'Any', consolidatingFilter: 'Any',
  vwapBias: 'All', pocBias: 'All',
  candleType: 'All', candlePattern: 'All', candleInterval: '1',
  chartPattern: 'All',
};

export const SIGNALS = {
  STRONG_BUY:  { label: 'Strong Buy',  color: '#16a34a', bg: '#14532d33' },
  BUY:         { label: 'Buy',         color: '#22c55e', bg: '#15803d22' },
  NEUTRAL:     { label: 'Neutral',     color: '#94a3b8', bg: '#1e293b55' },
  SELL:        { label: 'Sell',        color: '#f97316', bg: '#7c2d1222' },
  STRONG_SELL: { label: 'Strong Sell', color: '#ef4444', bg: '#7f1d1d33' },
};

// Asset type color tags
export const ASSET_COLORS = {
  Forex:   { color: '#0ea5e9', bg: '#0ea5e915' },
  Metals:  { color: '#f59e0b', bg: '#f59e0b15' },
  Indices: { color: '#a78bfa', bg: '#a78bfa15' },
  Energy:  { color: '#22c55e', bg: '#22c55e15' },
  Crypto:  { color: '#f97316', bg: '#f9731615' },
};

function generateSparkline(currentPrice, change) {
  const points = [];
  let price = currentPrice * (1 - change / 100);
  for (let i = 0; i < 8; i++) {
    price += (Math.random() - 0.48) * currentPrice * 0.002;
    points.push(parseFloat(price.toFixed(5)));
  }
  points.push(currentPrice);
  return points;
}

const item = (symbol, assetType, category, bid, ask, change, high, low, vol, signal, rsi, macd, unit = '') => ({
  id: symbol.replace(/[^a-zA-Z0-9]/g, ''),
  symbol,
  assetType,
  category,
  bid,
  ask,
  spread: parseFloat((ask - bid).toFixed(ask > 1000 ? 2 : ask > 10 ? 3 : 5)),
  change,
  high,
  low,
  volume: vol,
  signal,
  rsi,
  macd,
  unit,
  sparkline: generateSparkline(bid, change),
});

// ── FOREX ─────────────────────────────────────────────────────────────────────
export const forexPairs = [
  // Majors
  item('EUR/USD', 'Forex', 'Majors', 1.08542, 1.08558,  0.23, 1.08890, 1.08210, 89432, 'BUY',         58.4,  0.0012),
  item('GBP/USD', 'Forex', 'Majors', 1.27134, 1.27152, -0.41, 1.27680, 1.26920, 72891, 'SELL',        41.2, -0.0023),
  item('USD/JPY', 'Forex', 'Majors', 153.420, 153.437,  0.61, 153.890, 152.540, 95120, 'STRONG_BUY',  71.8,  0.4200),
  item('USD/CHF', 'Forex', 'Majors', 0.89012, 0.89030, -0.18, 0.89340, 0.88790, 41200, 'NEUTRAL',     50.1, -0.0005),
  item('AUD/USD', 'Forex', 'Majors', 0.64821, 0.64839, -0.55, 0.65180, 0.64610, 58340, 'STRONG_SELL', 28.9, -0.0031),
  item('USD/CAD', 'Forex', 'Majors', 1.36482, 1.36502,  0.14, 1.36780, 1.36120, 47890, 'BUY',         54.7,  0.0018),
  item('NZD/USD', 'Forex', 'Majors', 0.59234, 0.59252, -0.29, 0.59610, 0.58980, 33210, 'SELL',        43.6, -0.0014),
  // Minors
  item('EUR/GBP', 'Forex', 'Minors', 0.85312, 0.85334,  0.47, 0.85580, 0.85010, 28900, 'BUY',         61.3,  0.0008),
  item('EUR/JPY', 'Forex', 'Minors', 166.521, 166.548,  0.83, 167.120, 165.880, 51230, 'STRONG_BUY',  73.2,  0.5100),
  item('GBP/JPY', 'Forex', 'Minors', 195.213, 195.245, -0.22, 196.100, 194.780, 44120, 'NEUTRAL',     48.8, -0.1200),
  item('EUR/AUD', 'Forex', 'Minors', 1.67432, 1.67468,  0.36, 1.68010, 1.67100, 19840, 'BUY',         57.9,  0.0024),
  item('AUD/JPY', 'Forex', 'Minors', 99.423,  99.451,  -0.63, 99.980,  98.920,  22340, 'SELL',        38.7, -0.2800),
  item('GBP/CHF', 'Forex', 'Minors', 1.13241, 1.13275,  0.19, 1.13680, 1.12980, 14120, 'NEUTRAL',     52.1,  0.0009),
  item('CAD/JPY', 'Forex', 'Minors', 112.432, 112.465,  0.54, 112.890, 111.980, 18760, 'BUY',         59.8,  0.3100),
  // Exotics
  item('USD/SGD', 'Forex', 'Exotics', 1.34521, 1.34578, -0.12, 1.34890, 1.34210, 8920,  'NEUTRAL',     49.3, -0.0003),
  item('USD/MXN', 'Forex', 'Exotics', 17.2341, 17.2461,  0.91, 17.3120, 17.1230, 15640, 'STRONG_BUY',  69.4,  0.0812),
  item('USD/ZAR', 'Forex', 'Exotics', 18.4321, 18.4521, -1.23, 18.5670, 18.3120, 12380, 'STRONG_SELL', 24.8, -0.0921),
  item('EUR/TRY', 'Forex', 'Exotics', 34.8921, 34.9121,  1.54, 35.1230, 34.5670, 7840,  'STRONG_BUY',  74.1,  0.2341),
  item('USD/INR', 'Forex', 'Exotics', 83.4210, 83.4510,  0.08, 83.5120, 83.3210, 9230,  'NEUTRAL',     51.2,  0.0241),
];

// ── METALS ────────────────────────────────────────────────────────────────────
export const metals = [
  item('XAU/USD', 'Metals', 'Precious', 2342.50, 2342.90,  0.84, 2358.40, 2318.20, 142300, 'STRONG_BUY',  72.4,  3.210, '/oz'),
  item('XAG/USD', 'Metals', 'Precious', 27.842,  27.868,   1.12, 28.240,  27.410,  89200,  'STRONG_BUY',  68.9,  0.412, '/oz'),
  item('XPT/USD', 'Metals', 'Precious', 968.40,  969.10,  -0.31, 978.50,  961.20,  18400,  'NEUTRAL',     49.7, -0.820, '/oz'),
  item('XPD/USD', 'Metals', 'Precious', 1024.30, 1025.80, -0.76, 1042.10, 1018.40, 9800,   'SELL',        38.2, -2.140, '/oz'),
  item('XCU/USD', 'Metals', 'Base',     4.2341,  4.2389,   0.43, 4.2810,  4.1920,  34100,  'BUY',         57.3,  0.041, '/lb'),
  item('XAL/USD', 'Metals', 'Base',     0.9812,  0.9834,  -0.22, 0.9960,  0.9740,  21300,  'NEUTRAL',     48.1, -0.009, '/lb'),
  item('XNI/USD', 'Metals', 'Base',     7.8421,  7.8612,   0.61, 7.9120,  7.7840,  14200,  'BUY',         56.8,  0.081, '/lb'),
  item('XZN/USD', 'Metals', 'Base',     1.3241,  1.3278,  -0.18, 1.3420,  1.3140,  11800,  'NEUTRAL',     50.4, -0.012, '/lb'),
];

// ── INDICES ───────────────────────────────────────────────────────────────────
export const indices = [
  item('US500',   'Indices', 'Americas', 5218.40, 5219.10,  0.52, 5248.30, 5194.20, 312400, 'BUY',         61.2,  8.420),
  item('US30',    'Indices', 'Americas', 38942.0, 38948.0,  0.34, 39120.0, 38720.0, 198200, 'BUY',         57.8,  42.10),
  item('US100',   'Indices', 'Americas', 18124.0, 18128.0,  0.89, 18310.0, 17980.0, 241800, 'STRONG_BUY',  70.4,  68.20),
  item('US2000',  'Indices', 'Americas', 2048.20, 2049.10, -0.41, 2068.40, 2034.10, 84100,  'SELL',        41.3, -4.810),
  item('UK100',   'Indices', 'Europe',   8124.30, 8125.80, -0.28, 8198.40, 8094.20, 142100, 'NEUTRAL',     49.2, -6.320),
  item('GER40',   'Indices', 'Europe',   18241.0, 18245.0,  0.63, 18410.0, 18140.0, 168400, 'BUY',         59.4,  42.80),
  item('FRA40',   'Indices', 'Europe',   8012.40, 8014.20, -0.19, 8084.10, 7984.30, 98200,  'NEUTRAL',     51.1, -8.420),
  item('ESP35',   'Indices', 'Europe',   11241.0, 11244.0,  0.41, 11310.0, 11190.0, 62100,  'BUY',         55.8,  18.40),
  item('JPN225',  'Indices', 'Asia',     38412.0, 38418.0,  1.24, 38810.0, 37940.0, 284100, 'STRONG_BUY',  72.1,  124.0),
  item('AUS200',  'Indices', 'Asia',     7841.20, 7842.80,  0.38, 7892.40, 7804.10, 89400,  'BUY',         58.2,  14.20),
  item('HKG50',   'Indices', 'Asia',     17124.0, 17128.0, -0.84, 17420.0, 16980.0, 124100, 'SELL',        38.4, -48.10),
  item('CHN50',   'Indices', 'Asia',     12841.0, 12846.0, -0.56, 13020.0, 12740.0, 104200, 'SELL',        40.2, -28.40),
];

// ── ENERGY ───────────────────────────────────────────────────────────────────
export const energy = [
  item('USOIL',  'Energy', 'Crude Oil',   82.341,  82.389,  0.92, 83.210, 81.420, 284100, 'STRONG_BUY',  69.8,  0.821, '/bbl'),
  item('UKOIL',  'Energy', 'Crude Oil',   86.124,  86.178,  0.78, 86.940, 85.210, 241800, 'BUY',         62.4,  0.642, '/bbl'),
  item('NATGAS', 'Energy', 'Natural Gas',  2.1842,  2.1894, -1.34,  2.2840,  2.1420, 184100, 'STRONG_SELL', 26.4, -0.048, '/MMBtu'),
  item('HEATOIL','Energy', 'Refined',      2.4821,  2.4878,  0.54,  2.5140,  2.4520, 84100,  'BUY',         58.1,  0.021, '/gal'),
  item('GASOIL', 'Energy', 'Refined',    841.240, 841.840,  0.67, 848.120, 834.210, 64100,  'BUY',         60.2,  2.840, '/MT'),
  item('RBOB',   'Energy', 'Refined',      2.6421,  2.6498,  0.88,  2.6840,  2.6120, 74200,  'BUY',         63.4,  0.034, '/gal'),
  item('COALUSD','Energy', 'Coal',        124.841, 125.041, -0.92, 127.420, 123.840, 28100,  'SELL',        37.8, -0.841, '/MT'),
];

// ── CRYPTO ────────────────────────────────────────────────────────────────────
export const crypto = [
  item('BTC/USD', 'Crypto', 'Major',  68241.0, 68298.0,  2.14, 69420.0, 66840.0, 384200, 'STRONG_BUY',  71.2,  421.0),
  item('ETH/USD', 'Crypto', 'Major',  3524.80, 3526.40,  1.84,  3612.40, 3448.20, 241800, 'STRONG_BUY',  68.4,  48.20),
  item('XRP/USD', 'Crypto', 'Major',  0.52841, 0.52918,  0.94,  0.54210, 0.51840, 184100, 'BUY',         59.8,  0.0041),
  item('SOL/USD', 'Crypto', 'Major',  142.841, 143.048,  3.24,  148.420, 138.210, 124100, 'STRONG_BUY',  74.1,  2.841),
  item('BNB/USD', 'Crypto', 'Major',  584.210, 584.840,  1.12,  592.410, 576.840, 84100,  'BUY',         62.4,  4.821),
  item('ADA/USD', 'Crypto', 'Alt',    0.44821, 0.44918, -0.84,  0.46120, 0.44210, 64100,  'SELL',        39.4, -0.0021),
  item('DOGE/USD','Crypto', 'Alt',    0.14821, 0.14884,  1.42,  0.15420, 0.14510, 94100,  'BUY',         61.2,  0.0012),
  item('AVAX/USD','Crypto', 'Alt',    34.8421, 34.9124,  2.84,  36.4210, 33.8420, 54100,  'STRONG_BUY',  72.8,  0.4821),
];

// ── All instruments combined ──────────────────────────────────────────────────
export const allInstruments = [
  ...forexPairs,
  ...metals,
  ...indices,
  ...energy,
];

// ── Strategy presets ──────────────────────────────────────────────────────────
export const STRATEGIES = [
  {
    id: 'scalp',
    name: 'Scalping',
    description: 'High-frequency trades on 1M–5M timeframes targeting 3–8 pip moves.',
    timeframe: '1M / 5M',
    defaultSL: 5,
    defaultTP: 8,
    defaultLot: 0.01,
    maxTrades: 10,
    indicators: ['EMA 9/21', 'RSI 14', 'Stochastic'],
  },
  {
    id: 'swing',
    name: 'Swing Trading',
    description: 'Mid-term trades on 1H–4H timeframes targeting 30–100 pip moves.',
    timeframe: '1H / 4H',
    defaultSL: 30,
    defaultTP: 80,
    defaultLot: 0.05,
    maxTrades: 5,
    indicators: ['EMA 50/200', 'MACD', 'RSI 14'],
  },
  {
    id: 'trend',
    name: 'Trend Following',
    description: 'Daily chart trades following macro trends targeting 100–500 pip moves.',
    timeframe: '4H / Daily',
    defaultSL: 80,
    defaultTP: 250,
    defaultLot: 0.02,
    maxTrades: 3,
    indicators: ['ADX', 'Bollinger Bands', 'EMA 200'],
  },
  {
    id: 'breakout',
    name: 'Breakout',
    description: 'Trades key S/R level breaks with momentum confirmation.',
    timeframe: '15M / 1H',
    defaultSL: 15,
    defaultTP: 45,
    defaultLot: 0.03,
    maxTrades: 6,
    indicators: ['ATR', 'Volume', 'VWAP'],
  },
];

// ── Sample active positions ───────────────────────────────────────────────────
export const samplePositions = [
  { id: 'T001', pair: 'EUR/USD',  type: 'BUY',  lots: 0.05, openPrice: 1.08420,  currentPrice: 1.08542,  sl: 1.08100,  tp: 1.08900,  pnl: +61.00,  pips: +12.2, openTime: '09:14', duration: '2h 31m' },
  { id: 'T002', pair: 'USD/JPY',  type: 'BUY',  lots: 0.02, openPrice: 153.120,  currentPrice: 153.420,  sl: 152.600,  tp: 154.200,  pnl: +46.50,  pips: +30.0, openTime: '07:55', duration: '3h 50m' },
  { id: 'T003', pair: 'XAU/USD',  type: 'BUY',  lots: 0.10, openPrice: 2318.40,  currentPrice: 2342.50,  sl: 2300.00,  tp: 2380.00,  pnl: +241.00, pips: +241,  openTime: '08:30', duration: '3h 15m' },
  { id: 'T004', pair: 'US100',    type: 'BUY',  lots: 0.01, openPrice: 17980.00, currentPrice: 18124.00, sl: 17800.00, tp: 18400.00, pnl: +144.00, pips: +144,  openTime: '09:45', duration: '2h 00m' },
];

// ── Trade history ─────────────────────────────────────────────────────────────
export const tradeHistory = [
  { id: 'H001', pair: 'EUR/USD',  type: 'BUY',  lots: 0.05, openPrice: 1.08120,  closePrice: 1.08490,  pnl: +138.75, pips: +37,  result: 'WIN',  closeTime: '2026-04-11 16:42' },
  { id: 'H002', pair: 'XAU/USD',  type: 'BUY',  lots: 0.10, openPrice: 2298.40,  closePrice: 2341.20,  pnl: +427.80, pips: +428, result: 'WIN',  closeTime: '2026-04-11 15:30' },
  { id: 'H003', pair: 'USOIL',    type: 'BUY',  lots: 0.10, openPrice: 80.420,   closePrice: 82.180,   pnl: +176.00, pips: +176, result: 'WIN',  closeTime: '2026-04-11 14:20' },
  { id: 'H004', pair: 'GBP/JPY',  type: 'SELL', lots: 0.02, openPrice: 195.800,  closePrice: 196.100,  pnl: -45.00,  pips: -30,  result: 'LOSS', closeTime: '2026-04-11 14:20' },
  { id: 'H005', pair: 'US500',    type: 'BUY',  lots: 0.02, openPrice: 5180.20,  closePrice: 5218.40,  pnl: +152.00, pips: +38,  result: 'WIN',  closeTime: '2026-04-11 11:05' },
  { id: 'H006', pair: 'BTC/USD',  type: 'BUY',  lots: 0.01, openPrice: 66840.0,  closePrice: 68241.0,  pnl: +140.10, pips: +1401,result: 'WIN',  closeTime: '2026-04-10 18:30' },
  { id: 'H007', pair: 'NATGAS',   type: 'SELL', lots: 0.10, openPrice: 2.2420,   closePrice: 2.1842,   pnl: +57.80,  pips: +58,  result: 'WIN',  closeTime: '2026-04-10 15:12' },
  { id: 'H008', pair: 'USD/JPY',  type: 'BUY',  lots: 0.05, openPrice: 152.800,  closePrice: 153.380,  pnl: +218.75, pips: +58,  result: 'WIN',  closeTime: '2026-04-10 12:44' },
];

// ── Filter logic matching FilterPanel UI ──────────────────────────────────────
export function filterPairs(data, filters) {
  return data.filter(item => {
    if (filters.baseCurrency !== 'All' && item.base !== filters.baseCurrency) return false
    if (filters.structure !== 'All' && item.structure !== filters.structure) return false
    if (filters.htfBias   !== 'All' && item.htfBias   !== filters.htfBias)   return false
    if (filters.zone      !== 'All' && item.zone      !== filters.zone)      return false
    if (item.change < filters.changeMin || item.change > filters.changeMax) return false
    if (item.rsi != null && (item.rsi < filters.rsiMin || item.rsi > filters.rsiMax)) return false
    if (item.mfi != null && (item.mfi < filters.mfiMin || item.mfi > filters.mfiMax)) return false
    if (filters.volSpikeMin > 0 && (item.volRatio ?? 0) < filters.volSpikeMin) return false
    if (filters.requireBos   && !item.bos)   return false
    if (filters.requireChoch && !item.choch) return false
    if (filters.requireFvg && filters.requireOb) {
      if ((filters.fvgObMode || 'AND') === 'OR') {
        if (!item.fvgTap && !item.obTap) return false
      } else {
        if (!item.fvgTap || !item.obTap) return false
      }
    } else {
      if (filters.requireFvg && !item.fvgTap) return false
      if (filters.requireOb  && !item.obTap)  return false
    }
    if (filters.requireSweep           && !item.sweep)             return false
    if (filters.requireNearResistance  && !item.nearResistance)    return false
    if (filters.requireNearSupport     && !item.nearSupport)       return false
    if (filters.requireBrokeResistance && !item.brokeResistance)   return false
    if (filters.requireBrokeSupport    && !item.brokeSupport)      return false
    if (filters.requireTrendlineBull   && !item.trendlineBull)     return false
    if (filters.requireTrendlineBear   && !item.trendlineBear)     return false
    if (filters.requireTrendlineBreak  && !item.trendlineBreakout && !item.trendlineBreakdown) return false
    if (filters.fvgDir  !== 'All' && item.fvg !== filters.fvgDir)  return false
    if (filters.obDir   !== 'All' && item.ob  !== filters.obDir)   return false
    if (filters.liqType !== 'All' && item.liq !== filters.liqType) return false
    if (filters.search) {
      const q = filters.search.toLowerCase()
      if (!item.pair?.toLowerCase().includes(q) && !item.base?.toLowerCase().includes(q)) return false
    }
    // Candlestick patterns
    const maxAgo = parseInt(filters.candleInterval ?? '1') || 1
    if (filters.candleType !== 'All') {
      if (!item.patterns?.some(p => p.type === filters.candleType && p.candlesAgo <= maxAgo)) return false
    }
    if (filters.candlePattern !== 'All') {
      if (!item.patterns?.some(p => p.id === filters.candlePattern && p.candlesAgo <= maxAgo)) return false
    }
    // Chart patterns
    if (filters.chartPattern && filters.chartPattern !== 'All') {
      const [typeFilter, statusFilter] = filters.chartPattern.split(':')
      const match = item.chartPatterns?.some(p =>
        p.type === typeFilter && (!statusFilter || statusFilter === 'any' || p.status === statusFilter)
      )
      if (!match) return false
    }
    // VWAP / POC
    if (filters.vwapBias !== 'All' && item.vwapBias !== filters.vwapBias) return false
    if (filters.pocBias  !== 'All' && item.pocBias  !== filters.pocBias)  return false
    // EMA
    if (filters.emaPriceFilter && filters.emaPriceFilter !== 'Any') {
      const pf = filters.emaPriceFilter, p = item.price ?? 0
      if (pf === 'above20'  && (item.ema20  == null || p <= item.ema20))  return false
      if (pf === 'below20'  && (item.ema20  == null || p >= item.ema20))  return false
      if (pf === 'above50'  && (item.ema50  == null || p <= item.ema50))  return false
      if (pf === 'below50'  && (item.ema50  == null || p >= item.ema50))  return false
      if (pf === 'above100' && (item.ema100 == null || p <= item.ema100)) return false
      if (pf === 'below100' && (item.ema100 == null || p >= item.ema100)) return false
      if (pf === 'above200' && (item.ema200 == null || p <= item.ema200)) return false
      if (pf === 'below200' && (item.ema200 == null || p >= item.ema200)) return false
    }
    if (filters.emaAlignFilter && filters.emaAlignFilter !== 'Any') {
      if (filters.emaAlignFilter === '20_50'  && !item.ema20Above50)  return false
      if (filters.emaAlignFilter === '50_200' && !item.ema50Above200) return false
    }
    if (filters.emaCrossFilter && filters.emaCrossFilter !== 'Any') {
      const cf = filters.emaCrossFilter
      if (cf === 'cross_up_20_50'  && !item.ema20CrossUp50)    return false
      if (cf === 'cross_dn_20_50'  && !item.ema20CrossDown50)  return false
      if (cf === 'golden'          && !item.ema50CrossUp200)   return false
      if (cf === 'death'           && !item.ema50CrossDown200) return false
    }
    // Divergence / MACD / Equal levels
    if (filters.divFilter && filters.divFilter !== 'Any') {
      const df = filters.divFilter
      if (df === 'bull'       && !item.rsiDivBull)   return false
      if (df === 'bear'       && !item.rsiDivBear)   return false
      if (df === 'hiddenBull' && !item.hiddenDivBull) return false
      if (df === 'hiddenBear' && !item.hiddenDivBear) return false
    }
    if (filters.macdFilter && filters.macdFilter !== 'Any') {
      const mf = filters.macdFilter
      if (mf === 'crossUp'   && !item.macdCrossUp)                           return false
      if (mf === 'crossDown' && !item.macdCrossDown)                         return false
      if (mf === 'aboveZero' && !(item.macdVal != null && item.macdVal > 0)) return false
      if (mf === 'belowZero' && !(item.macdVal != null && item.macdVal < 0)) return false
    }
    if (filters.equalFilter && filters.equalFilter !== 'Any') {
      const ef = filters.equalFilter
      if (ef === 'equalHighs' && !item.equalHighs) return false
      if (ef === 'equalLows'  && !item.equalLows)  return false
      if (ef === 'either' && !item.equalHighs && !item.equalLows) return false
    }
    if (filters.signalScoreMin != null && filters.signalScoreMin > -5) {
      if ((item.signalStrength ?? 0) < filters.signalScoreMin) return false
    }
    // ICT / SMC advanced
    if (filters.dispFilter && filters.dispFilter !== 'Any') {
      const xf = filters.dispFilter
      if (xf === 'bull'   && !item.dispBull)  return false
      if (xf === 'bear'   && !item.dispBear)  return false
      if (xf === 'either' && !item.dispBull && !item.dispBear) return false
    }
    if (filters.breakerFilter && filters.breakerFilter !== 'Any') {
      const xf = filters.breakerFilter
      if (xf === 'bull'   && !item.breakerBull)  return false
      if (xf === 'bear'   && !item.breakerBear)  return false
      if (xf === 'either' && !item.breakerBull && !item.breakerBear) return false
    }
    if (filters.oteFilter && filters.oteFilter !== 'Any') {
      const xf = filters.oteFilter
      if (xf === 'bull'   && !item.oteBull)  return false
      if (xf === 'bear'   && !item.oteBear)  return false
      if (xf === 'either' && !item.oteBull && !item.oteBear) return false
    }
    if (filters.consolidatingFilter && filters.consolidatingFilter !== 'Any') {
      if (filters.consolidatingFilter === 'yes' && !item.consolidating) return false
      if (filters.consolidatingFilter === 'no'  &&  item.consolidating) return false
    }
    return true
  })
}

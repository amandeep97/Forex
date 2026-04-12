// ── Forex Pair Mock Data ──────────────────────────────────────────────────────
// Replace with live feed (WebSocket / REST API) when ready.

export const CATEGORIES = ['All', 'Majors', 'Minors', 'Exotics'];

export const SIGNALS = {
  STRONG_BUY:  { label: 'Strong Buy',  color: '#16a34a', bg: '#14532d33' },
  BUY:         { label: 'Buy',         color: '#22c55e', bg: '#15803d22' },
  NEUTRAL:     { label: 'Neutral',     color: '#94a3b8', bg: '#1e293b55' },
  SELL:        { label: 'Sell',        color: '#f97316', bg: '#7c2d1222' },
  STRONG_SELL: { label: 'Strong Sell', color: '#ef4444', bg: '#7f1d1d33' },
};

// Utility: create a pair entry
const pair = (symbol, category, bid, ask, change, high, low, vol, signal, rsi, macd) => ({
  id: symbol.replace('/', ''),
  symbol,
  category,
  bid,
  ask,
  spread: parseFloat((ask - bid).toFixed(5)),
  change,
  high,
  low,
  volume: vol,
  signal,
  rsi,
  macd,
  // sparkline trend data (7 closing prices)
  sparkline: generateSparkline(bid, change),
});

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

export const forexPairs = [
  // ── MAJORS ──────────────────────────────────────────────────────────────────
  pair('EUR/USD', 'Majors', 1.08542, 1.08558,  0.23, 1.08890, 1.08210, 89432, 'BUY',         58.4,  0.0012),
  pair('GBP/USD', 'Majors', 1.27134, 1.27152, -0.41, 1.27680, 1.26920, 72891, 'SELL',        41.2, -0.0023),
  pair('USD/JPY', 'Majors', 153.420, 153.437,  0.61, 153.890, 152.540, 95120, 'STRONG_BUY',  71.8,  0.4200),
  pair('USD/CHF', 'Majors', 0.89012, 0.89030, -0.18, 0.89340, 0.88790, 41200, 'NEUTRAL',     50.1, -0.0005),
  pair('AUD/USD', 'Majors', 0.64821, 0.64839, -0.55, 0.65180, 0.64610, 58340, 'STRONG_SELL', 28.9, -0.0031),
  pair('USD/CAD', 'Majors', 1.36482, 1.36502,  0.14, 1.36780, 1.36120, 47890, 'BUY',         54.7,  0.0018),
  pair('NZD/USD', 'Majors', 0.59234, 0.59252, -0.29, 0.59610, 0.58980, 33210, 'SELL',        43.6, -0.0014),

  // ── MINORS ──────────────────────────────────────────────────────────────────
  pair('EUR/GBP', 'Minors', 0.85312, 0.85334,  0.47, 0.85580, 0.85010, 28900, 'BUY',         61.3,  0.0008),
  pair('EUR/JPY', 'Minors', 166.521, 166.548,  0.83, 167.120, 165.880, 51230, 'STRONG_BUY',  73.2,  0.5100),
  pair('GBP/JPY', 'Minors', 195.213, 195.245, -0.22, 196.100, 194.780, 44120, 'NEUTRAL',     48.8, -0.1200),
  pair('EUR/AUD', 'Minors', 1.67432, 1.67468,  0.36, 1.68010, 1.67100, 19840, 'BUY',         57.9,  0.0024),
  pair('EUR/CAD', 'Minors', 1.48123, 1.48158,  0.09, 1.48560, 1.47800, 17650, 'NEUTRAL',     51.4,  0.0006),
  pair('AUD/JPY', 'Minors', 99.423,  99.451,  -0.63, 99.980,  98.920,  22340, 'SELL',        38.7, -0.2800),
  pair('GBP/CHF', 'Minors', 1.13241, 1.13275,  0.19, 1.13680, 1.12980, 14120, 'NEUTRAL',     52.1,  0.0009),
  pair('CAD/JPY', 'Minors', 112.432, 112.465,  0.54, 112.890, 111.980, 18760, 'BUY',         59.8,  0.3100),

  // ── EXOTICS ─────────────────────────────────────────────────────────────────
  pair('USD/SGD', 'Exotics', 1.34521, 1.34578, -0.12, 1.34890, 1.34210, 8920,  'NEUTRAL',     49.3, -0.0003),
  pair('USD/HKD', 'Exotics', 7.82341, 7.82415,  0.03, 7.83120, 7.81890, 11230, 'NEUTRAL',     50.8,  0.0012),
  pair('USD/NOK', 'Exotics', 10.5432, 10.5512, -0.87, 10.6230, 10.4890, 9840,  'STRONG_SELL', 27.4, -0.0342),
  pair('USD/SEK', 'Exotics', 10.3241, 10.3321,  0.31, 10.3780, 10.2890, 8120,  'BUY',         56.2,  0.0289),
  pair('USD/MXN', 'Exotics', 17.2341, 17.2461,  0.91, 17.3120, 17.1230, 15640, 'STRONG_BUY',  69.4,  0.0812),
  pair('USD/ZAR', 'Exotics', 18.4321, 18.4521, -1.23, 18.5670, 18.3120, 12380, 'STRONG_SELL', 24.8, -0.0921),
  pair('EUR/TRY', 'Exotics', 34.8921, 34.9121,  1.54, 35.1230, 34.5670, 7840,  'STRONG_BUY',  74.1,  0.2341),
  pair('USD/INR', 'Exotics', 83.4210, 83.4510,  0.08, 83.5120, 83.3210, 9230,  'NEUTRAL',     51.2,  0.0241),
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
  { id: 'T001', pair: 'EUR/USD', type: 'BUY',  lots: 0.05, openPrice: 1.08420, currentPrice: 1.08542, sl: 1.08100, tp: 1.08900, pnl: +61.00, pips: +12.2, openTime: '09:14', duration: '2h 31m' },
  { id: 'T002', pair: 'USD/JPY', type: 'BUY',  lots: 0.02, openPrice: 153.120, currentPrice: 153.420, sl: 152.600, tp: 154.200, pnl: +46.50, pips: +30.0, openTime: '07:55', duration: '3h 50m' },
  { id: 'T003', pair: 'GBP/USD', type: 'SELL', lots: 0.03, openPrice: 1.27390, currentPrice: 1.27134, sl: 1.27700, tp: 1.26800, pnl: +57.00, pips: +25.6, openTime: '10:02', duration: '1h 43m' },
  { id: 'T004', pair: 'AUD/USD', type: 'SELL', lots: 0.02, openPrice: 0.64920, currentPrice: 0.64821, sl: 0.65200, tp: 0.64400, pnl: +14.80, pips: +9.9,  openTime: '10:45', duration: '1h 00m' },
];

// ── Trade history ─────────────────────────────────────────────────────────────
export const tradeHistory = [
  { id: 'H001', pair: 'EUR/USD', type: 'BUY',  lots: 0.05, openPrice: 1.08120, closePrice: 1.08490, pnl: +138.75, pips: +37, result: 'WIN',  closeTime: '2026-04-11 16:42' },
  { id: 'H002', pair: 'GBP/JPY', type: 'SELL', lots: 0.02, openPrice: 195.800, closePrice: 196.100, pnl: -45.00,  pips: -30, result: 'LOSS', closeTime: '2026-04-11 14:20' },
  { id: 'H003', pair: 'USD/CAD', type: 'BUY',  lots: 0.03, openPrice: 1.36100, closePrice: 1.36480, pnl: +85.50,  pips: +38, result: 'WIN',  closeTime: '2026-04-11 11:05' },
  { id: 'H004', pair: 'EUR/JPY', type: 'BUY',  lots: 0.04, openPrice: 165.980, closePrice: 166.520, pnl: +162.00, pips: +54, result: 'WIN',  closeTime: '2026-04-10 18:30' },
  { id: 'H005', pair: 'NZD/USD', type: 'SELL', lots: 0.02, openPrice: 0.59450, closePrice: 0.59600, pnl: -22.50,  pips: -15, result: 'LOSS', closeTime: '2026-04-10 15:12' },
  { id: 'H006', pair: 'USD/JPY', type: 'BUY',  lots: 0.05, openPrice: 152.800, closePrice: 153.380, pnl: +218.75, pips: +58, result: 'WIN',  closeTime: '2026-04-10 12:44' },
];

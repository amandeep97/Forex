// src/utils/commandScore.js
// Command Center's factor model, moved verbatim out of the component.
// Weighted technical, DXY, COT, strength and timing scores were unreachable
// from anywhere else; the Terminal needs them as one input among several.

const PAIRS = [
  'EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','USD_CAD','NZD_USD',
  'EUR_GBP','EUR_JPY','GBP_JPY','AUD_JPY','EUR_AUD','GBP_AUD','EUR_CAD',
  'GBP_CAD','AUD_CAD','EUR_NZD','GBP_NZD','NZD_JPY','AUD_NZD','CAD_JPY',
];

// CFTC legacy COT contract codes
const COT_CODES = {
  EUR:'099741', GBP:'096742', JPY:'097741',
  CHF:'092741', AUD:'232741', NZD:'112741', CAD:'090741',
};

const KZ = [
  { name:'Asian',  start:0,  end:3  },
  { name:'London', start:7,  end:10 },
  { name:'NY AM',  start:12, end:15 },
  { name:'NY PM',  start:17, end:19 },
];

const W = { tech:0.30, dxy:0.20, cot:0.20, str:0.15, time:0.15 };

function sma(arr, n) {
  if (!arr.length) return 0;
  const slice = arr.slice(-Math.min(n, arr.length));
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function midClose(c) {
  return parseFloat(c.mid?.c ?? c.c ?? 0);
}

function techScore(h4, h1) {
  if (!h4 || h4.length < 5) return 0;
  const c4 = h4.map(midClose);
  const last = c4[c4.length - 1];
  const ma20 = sma(c4, 20);
  const prev5 = c4[Math.max(0, c4.length - 6)];

  let s = 0;
  s += last > ma20 ? 0.40 : -0.40;
  s += last > prev5 ? 0.30 : -0.30;

  if (h1 && h1.length >= 5) {
    const c1 = h1.map(midClose);
    const last1 = c1[c1.length - 1];
    const ma10 = sma(c1, 10);
    s += last1 > ma10 ? 0.15 : -0.15;
    s += c1[c1.length - 1] > c1[c1.length - 4] ? 0.15 : -0.15;
  }

  return Math.max(-1, Math.min(1, s));
}

function timingScore() {
  const now = new Date();
  const h = now.getUTCHours();
  const dow = now.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return -1;

  let s = 0;
  if (dow >= 2 && dow <= 4) s += 0.50;
  else if (dow === 5) s -= 0.20;

  const inKZ = KZ.some(kz => h >= kz.start && h < kz.end);
  s += inKZ ? 0.50 : 0;

  return Math.max(-1, Math.min(1, s));
}

function currKZ() {
  const h = new Date().getUTCHours();
  return KZ.find(kz => h >= kz.start && h < kz.end)?.name ?? null;
}

function computeStrengths(h4Map) {
  const acc = {};
  const cnt = {};
  for (const pair of PAIRS) {
    const c = h4Map[pair];
    if (!c || c.length < 2) continue;
    const closes = c.map(midClose);
    if (!closes[0]) continue;
    const pct = (closes[closes.length - 1] - closes[0]) / closes[0];
    const [base, quote] = pair.split('_');
    acc[base] = (acc[base] ?? 0) + pct; cnt[base] = (cnt[base] ?? 0) + 1;
    acc[quote] = (acc[quote] ?? 0) - pct; cnt[quote] = (cnt[quote] ?? 0) + 1;
  }
  const avg = Object.fromEntries(Object.keys(acc).map(k => [k, acc[k] / cnt[k]]));
  const max = Math.max(...Object.values(avg).map(Math.abs), 1e-8);
  return Object.fromEntries(Object.entries(avg).map(([k, v]) => [k, v / max]));
}

const gradeOf = conf =>
  conf >= 70 ? 'A+' : conf >= 55 ? 'A' : conf >= 40 ? 'B+' : conf >= 25 ? 'B' : 'C';
const gradeColor = g =>
  g === 'A+' ? '#22c55e' : g === 'A' ? '#86efac' : g === 'B+' ? '#fbbf24' : '#94a3b8';

const FACTORS = [
  { key:'tech',  label:'Tech',  color:'#818cf8' },
  { key:'dxy',   label:'DXY',   color:'#60a5fa' },
  { key:'cot',   label:'COT',   color:'#f472b6' },
  { key:'str',   label:'Str',   color:'#34d399' },
  { key:'time',  label:'Time',  color:'#fbbf24' },
];

// Top 12 crypto — Binance public API (free, no key needed)
const CRYPTO_PAIRS = [
  { key:'BTC',  label:'BTC/USDT',  symbol:'BTCUSDT'  },
  { key:'ETH',  label:'ETH/USDT',  symbol:'ETHUSDT'  },
  { key:'BNB',  label:'BNB/USDT',  symbol:'BNBUSDT'  },
  { key:'SOL',  label:'SOL/USDT',  symbol:'SOLUSDT'  },
  { key:'XRP',  label:'XRP/USDT',  symbol:'XRPUSDT'  },
  { key:'ADA',  label:'ADA/USDT',  symbol:'ADAUSDT'  },
  { key:'DOGE', label:'DOGE/USDT', symbol:'DOGEUSDT' },
  { key:'AVAX', label:'AVAX/USDT', symbol:'AVAXUSDT' },
  { key:'LINK', label:'LINK/USDT', symbol:'LINKUSDT' },
  { key:'DOT',  label:'DOT/USDT',  symbol:'DOTUSDT'  },
  { key:'LTC',  label:'LTC/USDT',  symbol:'LTCUSDT'  },
  { key:'TON',  label:'TON/USDT',  symbol:'TONUSDT'  },
];

// Binance public candle API — no key, free, browser-safe
async function binanceFetch(symbol, interval, limit) {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    // Exclude last candle (still forming). Format: [openTime,o,h,l,close,...]
    return data.slice(0, -1).map(k => ({ c: parseFloat(k[4]) }));
  } catch { return []; }
}

// No COT for crypto. DXY = primary macro driver (strong USD = bearish crypto).
const CRYPTO_W = { tech:0.45, dxy:0.30, time:0.25 };
const CRYPTO_FACTORS = [
  { key:'tech', label:'Tech', color:'#818cf8' },
  { key:'dxy',  label:'DXY',  color:'#60a5fa' },
  { key:'time', label:'Time', color:'#fbbf24' },
];


export {
  COT_CODES,
  CRYPTO_FACTORS,
  CRYPTO_PAIRS,
  CRYPTO_W,
  FACTORS,
  KZ,
  PAIRS,
  W,
  binanceFetch,
  computeStrengths,
  currKZ,
  gradeColor,
  gradeOf,
  midClose,
  sma,
  techScore,
  timingScore,
};

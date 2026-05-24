// src/utils/indicatorCalc.js
// Technical indicator calculations from OHLCV candle arrays.
// Candle format: { o, h, l, c, v }

// ── RSI ───────────────────────────────────────────────────────────────────────
export function computeRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const chg = candles[i].c - candles[i - 1].c;
    if (chg > 0) gains += chg;
    else         losses -= chg;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return Math.round(100 - (100 / (1 + avgGain / avgLoss)));
}

// ── Money Flow Index ──────────────────────────────────────────────────────────
export function computeMFI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 50;
  let posMF = 0, negMF = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp     = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const prevTp = (candles[i-1].h + candles[i-1].l + candles[i-1].c) / 3;
    const mf     = tp * (candles[i].v || 1);
    if (tp >= prevTp) posMF += mf;
    else              negMF += mf;
  }
  if (negMF === 0) return 100;
  return Math.round(100 - (100 / (1 + posMF / negMF)));
}

// ── EMA ───────────────────────────────────────────────────────────────────────
export function computeEMA(candles, period) {
  if (!candles || candles.length < period) return candles?.[candles.length - 1]?.c ?? 0;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].c * k + ema * (1 - k);
  }
  return ema;
}

// ── ATR ───────────────────────────────────────────────────────────────────────
export function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
  const trs = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ── MACD ──────────────────────────────────────────────────────────────────────
// Returns last-bar MACD state with cross and zero-line info
export function computeMACD(candles, fast = 12, slow = 26, signal = 9) {
  const blank = { macdLine: 0, signalLine: 0, histogram: 0, crossUp: false, crossDown: false, aboveZero: false, belowZero: false };
  if (!candles || candles.length < slow + signal + 1) return blank;

  const kf = 2 / (fast + 1), ks = 2 / (slow + 1), kg = 2 / (signal + 1);

  const emaFArr = new Array(candles.length).fill(null);
  const emaSArr = new Array(candles.length).fill(null);
  emaFArr[fast - 1] = candles.slice(0, fast).reduce((s, c) => s + c.c, 0) / fast;
  emaSArr[slow - 1] = candles.slice(0, slow).reduce((s, c) => s + c.c, 0) / slow;
  for (let i = fast;  i < candles.length; i++) emaFArr[i] = candles[i].c * kf + emaFArr[i - 1] * (1 - kf);
  for (let i = slow;  i < candles.length; i++) emaSArr[i] = candles[i].c * ks + emaSArr[i - 1] * (1 - ks);

  const validMacd = [];
  for (let i = slow - 1; i < candles.length; i++) {
    if (emaFArr[i] != null && emaSArr[i] != null)
      validMacd.push({ idx: i, val: emaFArr[i] - emaSArr[i] });
  }
  if (validMacd.length < signal + 1) return blank;

  let sigEma = validMacd.slice(0, signal).reduce((s, v) => s + v.val, 0) / signal;
  let prevSig = sigEma;
  for (let i = signal; i < validMacd.length; i++) {
    prevSig = sigEma;
    sigEma = validMacd[i].val * kg + sigEma * (1 - kg);
  }

  const lastMacd = validMacd[validMacd.length - 1].val;
  const prevMacd = validMacd[validMacd.length - 2].val;

  return {
    macdLine: lastMacd,
    signalLine: sigEma,
    histogram: lastMacd - sigEma,
    crossUp:   lastMacd > sigEma  && prevMacd <= prevSig,
    crossDown: lastMacd < sigEma  && prevMacd >= prevSig,
    aboveZero: lastMacd > 0,
    belowZero: lastMacd < 0,
  };
}

// ── RSI Divergence ────────────────────────────────────────────────────────────
// Compares last two swing highs/lows in price vs RSI to detect divergence
export function detectRSIDivergence(candles, period = 14, lookback = 35) {
  const def = { bull: false, bear: false, hiddenBull: false, hiddenBear: false };
  if (!candles || candles.length < period + lookback + 5) return def;

  const slice = candles.slice(Math.max(0, candles.length - lookback - period));
  const rsiArr = new Array(slice.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const d = slice[i].c - slice[i - 1].c;
    if (d > 0) avgG += d; else avgL -= d;
  }
  avgG /= period; avgL /= period;
  rsiArr[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < slice.length; i++) {
    const d = slice[i].c - slice[i - 1].c;
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    rsiArr[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }

  const priceLows = [], priceHighs = [];
  for (let i = 2; i < slice.length - 2; i++) {
    if (rsiArr[i] == null) continue;
    const isLow  = slice[i].l <= slice[i-1].l && slice[i].l <= slice[i-2].l &&
                   slice[i].l <= slice[i+1].l && slice[i].l <= slice[i+2].l;
    const isHigh = slice[i].h >= slice[i-1].h && slice[i].h >= slice[i-2].h &&
                   slice[i].h >= slice[i+1].h && slice[i].h >= slice[i+2].h;
    if (isLow)  priceLows.push({ price: slice[i].l, rsi: rsiArr[i] });
    if (isHigh) priceHighs.push({ price: slice[i].h, rsi: rsiArr[i] });
  }

  let bull = false, bear = false, hiddenBull = false, hiddenBear = false;
  if (priceLows.length >= 2) {
    const a = priceLows[priceLows.length - 2], b = priceLows[priceLows.length - 1];
    if (b.price < a.price && b.rsi > a.rsi) bull       = true;
    if (b.price > a.price && b.rsi < a.rsi) hiddenBull = true;
  }
  if (priceHighs.length >= 2) {
    const a = priceHighs[priceHighs.length - 2], b = priceHighs[priceHighs.length - 1];
    if (b.price > a.price && b.rsi < a.rsi) bear       = true;
    if (b.price < a.price && b.rsi > a.rsi) hiddenBear = true;
  }
  return { bull, bear, hiddenBull, hiddenBear };
}

// ── Equal Highs / Equal Lows ──────────────────────────────────────────────────
// Two swing highs/lows within tolerance = untested liquidity pool
export function detectEqualHighsLows(candles, lookback = 40, tolerance = 0.0015) {
  if (!candles || candles.length < 10) return { equalHighs: false, equalLows: false };
  const slice = candles.slice(Math.max(0, candles.length - lookback));
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < slice.length - 2; i++) {
    if (slice[i].h >= slice[i-1].h && slice[i].h >= slice[i-2].h &&
        slice[i].h >= slice[i+1].h && slice[i].h >= slice[i+2].h)
      swingHighs.push(slice[i].h);
    if (slice[i].l <= slice[i-1].l && slice[i].l <= slice[i-2].l &&
        slice[i].l <= slice[i+1].l && slice[i].l <= slice[i+2].l)
      swingLows.push(slice[i].l);
  }
  let equalHighs = false, equalLows = false;
  for (let i = 0; i < swingHighs.length - 1 && !equalHighs; i++)
    for (let j = i + 1; j < swingHighs.length && !equalHighs; j++)
      if (Math.abs(swingHighs[i] - swingHighs[j]) / (swingHighs[i] || 1) < tolerance) equalHighs = true;
  for (let i = 0; i < swingLows.length - 1 && !equalLows; i++)
    for (let j = i + 1; j < swingLows.length && !equalLows; j++)
      if (Math.abs(swingLows[i] - swingLows[j]) / (swingLows[i] || 1) < tolerance) equalLows = true;
  return { equalHighs, equalLows };
}

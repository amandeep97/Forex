// src/utils/indicatorCalc.js
// Technical indicator calculations (RSI, MFI) from OHLCV candle arrays.

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
  const rs = avgGain / avgLoss;
  return Math.round(100 - (100 / (1 + rs)));
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
  const mfr = posMF / negMF;
  return Math.round(100 - (100 / (1 + mfr)));
}

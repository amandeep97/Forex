// shared/indicators.mjs
// MACD, Bollinger Bands, Stochastic and ADX — the one copy.
//
// In shared/ because the strategy editor previews these on the phone and the
// bot has to evaluate the same thing on the VPS. Two implementations of an
// indicator is two indicators, and the screen would say a strategy was
// filtering while the bot took every bar.
//
// One rule throughout: NOT ENOUGH HISTORY RETURNS NULL, never a plausible
// number. An EMA seeded off four bars is not an EMA, and `price > null` is TRUE
// in JavaScript, so every caller has to check. That is deliberate — a silent
// zero here becomes a filter that passes everything.
//
// How many bars each one actually needs, since the answer is not the period:
//
//   Bollinger(20)      21 bars. A plain window, so the period is the answer.
//   Stochastic(14,3)   17 bars. Window plus the smoothing of %D.
//   MACD(12,26,9)      ~90 bars. The slow EMA's seed is still 1% of the value
//                      at 3.3x the period, and the signal line is an EMA of
//                      that, so 26+9 is arithmetically valid and numerically
//                      wrong. 90 is where it stops moving.
//   ADX(14)            ~42 bars. Wilder smoothing applied twice — once to DI,
//                      once to DX — so it is 3x the period, not 1x.
//
// The bot fetches 250 bars for a strategy check, which clears all four.

const sma = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function emaSeries(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let e = sma(values.slice(0, period));
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export const MACD_MIN = 90;
export const BB_MIN = 21;
export const STOCH_MIN = 17;
export const ADX_MIN = 42;

/**
 * MACD on the last closed bar: the line, its signal, and the histogram.
 *
 * `hist` is what a trader reads as momentum, and `crossUp` / `crossDown` are
 * the events — the histogram changing sign between the previous bar and this
 * one. A cross is a different condition from "the line is above the signal",
 * which is true for weeks at a time, and conflating them is how a trigger
 * becomes a trend filter without anyone noticing.
 */
export function macdAt(candles, { fast = 12, slow = 26, signal = 9 } = {}) {
  if (!candles || candles.length < MACD_MIN) return null;
  const close = candles.map(c => c.c);
  const ef = emaSeries(close, fast);
  const es = emaSeries(close, slow);
  const line = close.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const solid = line.filter(v => v != null);
  if (solid.length < signal + 2) return null;
  const sig = emaSeries(solid, signal);
  const n = solid.length - 1;
  if (sig[n] == null || sig[n - 1] == null) return null;

  const hist = solid[n] - sig[n];
  const prev = solid[n - 1] - sig[n - 1];
  return {
    line: solid[n], signal: sig[n], hist, prevHist: prev,
    crossUp: prev <= 0 && hist > 0,
    crossDown: prev >= 0 && hist < 0,
  };
}

/**
 * Bollinger Bands on the last closed bar, plus where price sits inside them.
 *
 * `pctB` is 0 at the lower band and 1 at the upper. It is reported rather than
 * bucketed here so the caller decides what "outside the band" means; a band
 * touch and a band break are not the same bar.
 */
export function bollingerAt(candles, { period = 20, mult = 2 } = {}) {
  if (!candles || candles.length < BB_MIN) return null;
  const win = candles.slice(-period).map(c => c.c);
  const mid = sma(win);
  const variance = sma(win.map(v => (v - mid) ** 2));
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;             // a flat window has no band to be outside of
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const price = candles[candles.length - 1].c;
  return {
    upper, mid, lower, sd, price,
    pctB: (price - lower) / (upper - lower),
    // Band width against the middle band — the squeeze everyone watches.
    width: (upper - lower) / mid,
  };
}

/**
 * Stochastic %K and %D on the last closed bar.
 *
 * The high and low come from the HIGHS and LOWS of the window, not the closes.
 * A close-only stochastic is a different indicator that happens to share the
 * name, and it reads consistently less extreme.
 */
export function stochasticAt(candles, { kPeriod = 14, dPeriod = 3 } = {}) {
  if (!candles || candles.length < kPeriod + dPeriod) return null;
  const kAt = (end) => {
    const win = candles.slice(end - kPeriod + 1, end + 1);
    const hi = Math.max(...win.map(c => c.h));
    const lo = Math.min(...win.map(c => c.l));
    if (!(hi > lo)) return null;          // no range means no position within it
    return ((candles[end].c - lo) / (hi - lo)) * 100;
  };
  const last = candles.length - 1;
  const ks = [];
  for (let i = last - dPeriod + 1; i <= last; i++) {
    const v = kAt(i);
    if (v == null) return null;
    ks.push(v);
  }
  return { k: ks[ks.length - 1], d: sma(ks) };
}

/**
 * ADX with +DI and -DI, Wilder's method.
 *
 * ADX measures how strongly price is trending and says NOTHING about the
 * direction — that is +DI against -DI. They are returned together because a
 * filter on ADX alone is a filter on "is there a trend", which is what it is
 * for, and reading direction out of it is the usual mistake.
 */
export function adxAt(candles, { period = 14 } = {}) {
  if (!candles || candles.length < ADX_MIN) return null;

  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const dn = candles[i - 1].l - candles[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    const pc = candles[i - 1].c;
    tr.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - pc),
      Math.abs(candles[i].l - pc),
    ));
  }
  if (tr.length < period * 2) return null;

  // Wilder's smoothing: seed with a sum, then subtract a period-share each bar.
  const wilder = (xs) => {
    let s = xs.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < xs.length; i++) {
      s = s - s / period + xs[i];
      out.push(s);
    }
    return out;
  };
  const sTR = wilder(tr), sP = wilder(plusDM), sM = wilder(minusDM);

  const dx = [];
  for (let i = 0; i < sTR.length; i++) {
    if (!(sTR[i] > 0)) { dx.push(null); continue; }
    const p = (sP[i] / sTR[i]) * 100;
    const m = (sM[i] / sTR[i]) * 100;
    const sum = p + m;
    dx.push(sum > 0 ? (Math.abs(p - m) / sum) * 100 : null);
  }
  const solid = dx.filter(v => v != null);
  if (solid.length < period + 1) return null;

  // ADX is Wilder's average of DX — itself smoothed, which is the second pass
  // that makes this need three times the period rather than one.
  let adx = sma(solid.slice(0, period));
  for (let i = period; i < solid.length; i++) adx = (adx * (period - 1) + solid[i]) / period;

  const last = sTR.length - 1;
  return {
    adx,
    plusDI: sTR[last] > 0 ? (sP[last] / sTR[last]) * 100 : null,
    minusDI: sTR[last] > 0 ? (sM[last] / sTR[last]) * 100 : null,
  };
}

// shared/timeframes.mjs
// Which venue can actually serve which timeframe.
//
// M2 was added across the app on request. It is served by OANDA and it is NOT
// served by Binance, whose interval list goes 1m, 3m, 5m — there is no two.
// That asymmetry is the whole reason this file exists.
//
// ── The failure this prevents ───────────────────────────────────────────────
//
// The Backtester picked its Binance interval with `BINANCE_TF[tf] || '1h'`. A
// timeframe the map did not know fell through to one hour, silently. Add M2 to
// the picker without touching that line and selecting a crypto instrument runs
// the entire backtest on hourly candles while the control says 2M, prints a
// win rate, and gives no indication anywhere that it answered a different
// question than the one asked.
//
// That is worse than an error. An error is visible. This produces a plausible
// number for a timeframe that was never tested, and there is nothing on screen
// that could tell you.
//
// So a venue that cannot serve a timeframe says so, and the caller shows the
// option as unavailable rather than substituting a different one.

/**
 * OANDA granularity codes. M2 is real here — the client has always known its
 * bar width, nothing had ever asked for it.
 */
export const OANDA_TFS = [
  'S5', 'S10', 'S30', 'M1', 'M2', 'M4', 'M5', 'M10', 'M15', 'M30',
  'H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12', 'D', 'W', 'M',
];

/**
 * Binance intervals, exactly as the exchange lists them. Note the gap: 1m, 3m,
 * 5m. There is no 2m and there never has been.
 */
export const BINANCE_TFS = [
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
];

/** Minutes per bar, for anything that needs to turn a count into a span. */
export const TF_MINUTES = {
  M1: 1, M2: 2, M4: 4, M5: 5, M10: 10, M15: 15, M30: 30,
  H1: 60, H2: 120, H3: 180, H4: 240, H6: 360, H8: 480, H12: 720,
  D: 1440, W: 10080,
};

/**
 * How many bars of this timeframe are in one trading day.
 *
 * FX and metals run around the clock five days a week, so a "day" here is 1440
 * minutes of trading rather than a calendar day.
 */
export function barsPerTradingDay(oandaTf) {
  const m = TF_MINUTES[oandaTf];
  return m ? 1440 / m : null;
}

/**
 * Can this venue serve this OANDA-coded timeframe?
 *
 * @param {'oanda'|'binance'} venue
 * @param {string} oandaTf e.g. 'M2'
 */
export function venueSupports(venue, oandaTf) {
  if (venue === 'binance') return toBinance(oandaTf) !== null;
  return OANDA_TFS.includes(oandaTf);
}

/**
 * OANDA code to Binance interval, or null when the exchange has no such bar.
 *
 * Returning null rather than a nearby interval is the point. M2 has no Binance
 * equivalent and quietly handing back '1m' or '3m' would answer a question
 * nobody asked, under a label saying otherwise.
 *
 * @param {string} oandaTf
 * @returns {string|null}
 */
export function toBinance(oandaTf) {
  const map = {
    M1: '1m', M4: '3m', M5: '5m', M15: '15m', M30: '30m',
    H1: '1h', H2: '2h', H4: '4h', H6: '6h', H8: '8h', H12: '12h',
    D: '1d', W: '1w',
  };
  return map[oandaTf] ?? null;
}

/**
 * Why an option is greyed out, in words a person can act on.
 *
 * @param {'oanda'|'binance'} venue
 * @param {string} oandaTf
 */
export function unsupportedReason(venue, oandaTf) {
  if (venueSupports(venue, oandaTf)) return null;
  if (venue === 'binance') {
    return `Binance has no ${oandaTf.replace('M', '')}-minute interval — its list goes 1m, 3m, 5m`;
  }
  return `${oandaTf} is not an OANDA granularity`;
}

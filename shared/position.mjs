// shared/position.mjs
// How many units to buy so that being wrong costs what you said it would.
//
// This replaces a sizing rule that was correct for FX majors and wrong for
// everything else. The old one converted the stop distance to "pips", then
// assumed $10 per pip per lot and 100,000 units per lot. Both assumptions are
// specific to a major FX pair, and the strategy builder offers indices, oil and
// metals as well.
//
// What that cost, concretely, on SPX500 with a 30-point stop: the pip size fell
// through to 0.0001, so the stop measured 300,000 "pips", the lot calculation
// underflowed to the 0.01 minimum, and 0.01 lots became 1,000 units — roughly
// six million dollars of notional on an account risking three. The number was
// not slightly off. It was unrelated to the input.
//
// The rule here is the one OANDA actually trades on. It deals in UNITS, and for
// an instrument quoted in currency Q, one unit moving one price point is worth
// one unit of Q. So:
//
//     units = risk / (stop distance x value of one quote unit in USD)
//
// No pips, no lots, no per-instrument table to get wrong. For a USD-quoted
// instrument the conversion is 1 and the whole thing is a division.
//
// Worth stating because it is easy to miss: for FX majors this produces
// EXACTLY the same answer as the old code. risk/(dist/0.0001 x 10) lots, times
// 100,000 units per lot, is algebraically risk/dist. Nothing about EUR/USD
// sizing changes. What changes is everything the old formula was not written
// for.

/** The quote currency of an OANDA instrument name: EUR_USD -> USD. */
export function quoteOf(pair) {
  const parts = String(pair || '').toUpperCase().split('_');
  return parts.length === 2 ? parts[1] : null;
}

export function baseOf(pair) {
  const parts = String(pair || '').toUpperCase().split('_');
  return parts.length === 2 ? parts[0] : null;
}

/**
 * Units to trade, or a refusal.
 *
 * @param riskUsd     what being stopped out should cost, in account currency
 * @param entry       intended entry price
 * @param stop        the stop price
 * @param quoteToUsd  value of one unit of the QUOTE currency in USD.
 *                    1 for a USD-quoted instrument. Null means unknown, and
 *                    unknown is a refusal, not an assumption.
 * @param minUnits    the smallest position the venue will accept
 *
 * Returns { units, risk, why }. `units` is 0 when the trade cannot be sized
 * within the budget, and `why` says which of the reasons it was. Zero is a
 * refusal the caller must honour — the old code clamped up to a minimum
 * instead, which silently turned "risk three dollars" into whatever the
 * minimum happened to cost.
 */
export function unitsFor({ riskUsd, entry, stop, quoteToUsd = 1, minUnits = 1 }) {
  if (!(riskUsd > 0)) return { units: 0, risk: 0, why: 'no risk budget' };
  const dist = Math.abs(entry - stop);
  if (!(dist > 0)) return { units: 0, risk: 0, why: 'the stop is at the entry' };
  if (quoteToUsd == null || !(quoteToUsd > 0)) {
    return { units: 0, risk: 0,
      why: 'no conversion rate for the quote currency — sizing it anyway would be a guess' };
  }

  const perUnit = dist * quoteToUsd;          // what one unit loses at the stop
  const raw = riskUsd / perUnit;

  // Round DOWN, so the risk never exceeds the budget — but absorb binary
  // representation noise first. 1.1000 - 1.0970 is 0.0030000000000000027 in
  // IEEE754, which makes a clean 10,000 units come out as 9999.99999 and floor
  // to 9,999. A relative tolerance of one part in a billion recovers the unit
  // the subtraction lost; it cannot promote a genuinely fractional size, and
  // the most it can add to the realised risk is a billionth of it.
  const units = Math.floor(raw * (1 + 1e-9));

  if (units < minUnits) {
    // The smallest position the venue accepts already risks more than asked.
    // Trading it anyway is the failure this function exists to prevent.
    return { units: 0, risk: minUnits * perUnit, wanted: raw,
      why: `the smallest tradeable size (${minUnits}) would risk `
         + `${(minUnits * perUnit).toFixed(2)}, more than the ${riskUsd.toFixed(2)} budget` };
  }
  return { units, risk: units * perUnit };
}

/**
 * The value of one unit of an instrument's quote currency, in USD.
 *
 * Two of the three cases need no data at all, which is worth knowing before
 * reaching for a network call:
 *
 *   EUR_USD  quote is USD                  -> 1
 *   USD_JPY  base is USD, so 1 JPY is      -> 1 / price
 *   EUR_JPY  neither, so the rate has to come from somewhere else, and
 *   UK100_GBP  `rateFor` is asked for it.
 *
 * The third case is why this returns a promise. `rateFor(sym)` should return a
 * price for an OANDA instrument or null; null propagates to a refusal rather
 * than to a default.
 */
export async function quoteToUsdFor(pair, price, rateFor = null) {
  const q = quoteOf(pair), b = baseOf(pair);
  if (!q) return null;
  if (q === 'USD') return 1;
  if (b === 'USD') return price > 0 ? 1 / price : null;
  if (!rateFor) return null;

  // QUOTE_USD if it exists (GBP_USD, EUR_USD), otherwise USD_QUOTE inverted.
  const direct = await rateFor(`${q}_USD`);
  if (direct > 0) return direct;
  const inverse = await rateFor(`USD_${q}`);
  return inverse > 0 ? 1 / inverse : null;
}

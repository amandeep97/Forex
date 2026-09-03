// Position sizing — shared/position.mjs.
//
// The bug this replaces was not a rounding error. The old rule converted the
// stop to "pips", assumed $10 per pip per lot and 100,000 units per lot, and
// clamped up to a 0.01 lot minimum. On SPX500 the pip size fell through to
// 0.0001, so a thirty-point stop measured 300,000 pips, the lot maths
// underflowed to the clamp, and 0.01 lots became 1,000 units — about six
// million dollars of notional against a three-dollar risk budget.
//
// So the checks here are: does the size actually cost what was asked, does FX
// come out unchanged, and does it REFUSE rather than clamp when it cannot.
import { unitsFor, quoteToUsdFor, quoteOf, baseOf } from '../shared/position.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

// ── The size costs what was asked ───────────────────────────────────────────
{
  // EUR/USD, 30 pip stop, $30 budget. 30 pips on 10,000 units is $30.
  const r = unitsFor({ riskUsd: 30, entry: 1.1000, stop: 1.0970, quoteToUsd: 1 });
  check('EUR/USD sizes so the stop costs the budget',
    r.units === 10000 && near(r.risk, 30), `${r.units} units, risks ${r.risk?.toFixed(2)}`);

  // The same trade the old code sized correctly, to prove FX did not change.
  const small = unitsFor({ riskUsd: 3, entry: 1.1000, stop: 1.0970, quoteToUsd: 1 });
  check('and the old formula agreed on FX — 1,000 units for a $3 risk',
    small.units === 1000, `${small.units}`,
    'risk/(dist/0.0001 x 10) lots x 100,000 units is algebraically risk/dist');

  // SPX500 at 6000, 30 point stop, $3 budget. One unit loses $30 at the stop,
  // so no position at all fits — and that is the correct answer.
  const spx = unitsFor({ riskUsd: 3, entry: 6000, stop: 5970, quoteToUsd: 1 });
  check('SPX500 with a 30 point stop and a $3 budget is REFUSED',
    spx.units === 0, spx.why);
  check('and the refusal says what the smallest position would have cost',
    near(spx.risk, 30), `${spx.risk?.toFixed(2)}`,
    'the old code traded 1,000 units here — six million dollars of notional');

  // The same instrument with a budget that fits.
  const spxOk = unitsFor({ riskUsd: 300, entry: 6000, stop: 5970, quoteToUsd: 1 });
  check('with a $300 budget it is 10 units, risking 300',
    spxOk.units === 10 && near(spxOk.risk, 300), `${spxOk.units} units`);

  // Gold at 4500, $20 stop, $100 budget.
  const gold = unitsFor({ riskUsd: 100, entry: 4500, stop: 4480, quoteToUsd: 1 });
  check('gold sizes off the dollar distance, not a pip table',
    gold.units === 5 && near(gold.risk, 100), `${gold.units} units`);
}

// ── Rounding is always DOWN ─────────────────────────────────────────────────
{
  const r = unitsFor({ riskUsd: 100, entry: 6000, stop: 5970, quoteToUsd: 1 });
  check('a fractional size rounds down, never up',
    r.units === 3 && r.risk <= 100, `${r.units} units risking ${r.risk.toFixed(2)}`,
    'rounding up would put the risk above the budget on every trade');

  // But binary noise must not cost a whole unit. 1.1000 - 1.0970 is
  // 0.0030000000000000027, so a clean 10,000 floors to 9,999 without a
  // tolerance — and the same thing happens on most FX stops.
  const clean = unitsFor({ riskUsd: 30, entry: 1.1000, stop: 1.0970, quoteToUsd: 1 });
  check('and representation noise does not silently cost a unit',
    clean.units === 10000, `${clean.units}`);
  const genuinely = unitsFor({ riskUsd: 100, entry: 6000, stop: 5970, quoteToUsd: 1 });
  check('while a genuinely fractional 3.33 is still 3, not 4',
    genuinely.units === 3, `${genuinely.units}`,
    'the tolerance must not be big enough to promote a real fraction');
}

// ── Refusals, not guesses ───────────────────────────────────────────────────
{
  check('a stop at the entry is refused rather than dividing by zero',
    unitsFor({ riskUsd: 30, entry: 1.1, stop: 1.1, quoteToUsd: 1 }).units === 0);
  check('no budget is refused',
    unitsFor({ riskUsd: 0, entry: 1.1, stop: 1.09, quoteToUsd: 1 }).units === 0);
  check('a missing conversion rate is refused, not assumed to be 1',
    unitsFor({ riskUsd: 30, entry: 100, stop: 99, quoteToUsd: null }).units === 0,
    'assuming 1 would size a DAX trade as though euros were dollars');
  check('and the reason says so rather than being a bare zero',
    /conversion rate/.test(unitsFor({ riskUsd: 30, entry: 100, stop: 99, quoteToUsd: null }).why));

  // The clamp that caused the original damage.
  const tiny = unitsFor({ riskUsd: 1, entry: 6000, stop: 5900, quoteToUsd: 1 });
  check('too small to trade returns zero rather than clamping up to a minimum',
    tiny.units === 0 && tiny.risk > 1,
    `smallest would risk ${tiny.risk.toFixed(2)} against a budget of 1`);
}

// ── The quote currency, and what one unit of it is worth ────────────────────
{
  check('the quote and base are read off the instrument name',
    quoteOf('EUR_USD') === 'USD' && baseOf('EUR_USD') === 'EUR'
    && quoteOf('UK100_GBP') === 'GBP' && baseOf('SPX500_USD') === 'SPX500');

  const usd = await quoteToUsdFor('EUR_USD', 1.1);
  check('a USD-quoted instrument needs no rate at all', usd === 1);

  // USD_JPY at 150 means one yen is 1/150 of a dollar. No lookup needed.
  const jpy = await quoteToUsdFor('USD_JPY', 150);
  check('a USD-BASED instrument inverts its own price', near(jpy, 1 / 150, 1e-9),
    String(jpy));

  // A cross has to ask. GBP_USD exists, so it is used directly.
  let asked = [];
  const rateFor = async (sym) => { asked.push(sym); return sym === 'GBP_USD' ? 1.27 : null; };
  const gbp = await quoteToUsdFor('UK100_GBP', 8200, rateFor);
  check('a cross looks up QUOTE_USD', gbp === 1.27, asked.join(', '));

  // For a currency only quoted the other way round, invert.
  asked = [];
  const inv = async (sym) => { asked.push(sym); return sym === 'USD_CHF' ? 0.8 : null; };
  const chf = await quoteToUsdFor('EUR_CHF', 0.95, inv);
  check('and falls back to inverting USD_QUOTE', near(chf, 1 / 0.8, 1e-9), asked.join(', '));

  check('a cross with no rate available returns null, which becomes a refusal',
    await quoteToUsdFor('EUR_JPY', 165, async () => null) === null);
  check('and a cross with no lookup at all returns null rather than 1',
    await quoteToUsdFor('EUR_JPY', 165) === null);
}

// ── A cross sized end to end ────────────────────────────────────────────────
{
  // DAX at 18,000 quoted in EUR, 100 point stop, $500 budget, EUR at 1.08.
  // One unit loses 100 EUR = 108 USD, so four units fit.
  const rate = await quoteToUsdFor('DE30_EUR', 18000, async s => (s === 'EUR_USD' ? 1.08 : null));
  const r = unitsFor({ riskUsd: 500, entry: 18000, stop: 17900, quoteToUsd: rate });
  check('the DAX sizes in euros converted to dollars',
    r.units === 4 && near(r.risk, 432), `${r.units} units risking ${r.risk.toFixed(2)}`);
  check('and ignoring the conversion would have oversized it',
    Math.floor(500 / 100) === 5,
    'treating euros as dollars gives 5 units — 540 of risk against a 500 budget');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

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
import { unitsFor, quoteToUsdFor, quoteOf, baseOf,
         LOT_UNITS, lotUnitsFor, unitsForLots, affordCheck } from '../shared/position.mjs';

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

// ── What a lot is, in one place ─────────────────────────────────────────────
//
// There were two definitions and they disagreed by fifty times. The strategy
// editor's note said silver was 5,000 ounces a lot; the bot converted every
// metal at 100. So 0.01 lots of silver meant fifty ounces on the screen and one
// ounce in the order.
{
  check('a silver lot is five thousand ounces, not a hundred',
    lotUnitsFor('XAG_USD') === 5000 && LOT_UNITS.XAG === 5000);
  check('and gold is a hundred, which is where the two used to agree',
    lotUnitsFor('XAU_USD') === 100);
  check('forex is the hundred thousand everyone means by a lot',
    lotUnitsFor('EUR_USD') === 100000 && lotUnitsFor('USD_JPY') === 100000);

  check('0.01 lots of silver is fifty ounces',
    unitsForLots('XAG_USD', 0.01) === 50, String(unitsForLots('XAG_USD', 0.01)),
    'the bot used to send 1');
  check('0.01 lots of gold is one ounce', unitsForLots('XAU_USD', 0.01) === 1);
  check('and nonsense is no position rather than a rounded guess',
    unitsForLots('XAG_USD', 0) === 0 && unitsForLots('XAG_USD', -1) === 0
    && unitsForLots('XAG_USD', 'x') === 0);
}

// ── Can the account place it, asked BEFORE the order goes out ──────────────
//
// Eight consecutive CANCELLED rows on the activity list, every one of them
// "Not enough margin — reduce lot size", for a condition knowable here. These
// numbers are the real ones off the account: silver at 66.6, margin available
// 51.47 CAD, and OANDA charging 20.23 CAD on a single ounce.
{
  const SILVER = { price: 66.6, marginRate: 0.22, toHome: 1.38 };

  const one = affordCheck({ units: 1, marginAvailable: 51.47, ...SILVER });
  check('one ounce of silver fits, and the number matches the broker ticket',
    one.ok === true && Math.abs(one.required - 20.2) < 0.3,
    `${one.required.toFixed(2)} CAD required — the broker said 20.23`);

  const fifty = affordCheck({ units: 50, marginAvailable: 51.47, ...SILVER });
  check('fifty does not, and it is refused rather than sent',
    fifty.ok === false, fifty.why);
  check('and the refusal says how many WOULD fit',
    fifty.affordable === 2, `${fifty.affordable} units`,
    'the broker ticket said Units Available 2');

  const broke = affordCheck({ units: 1, marginAvailable: 5, ...SILVER });
  check('when not even the minimum fits, it says that instead',
    broke.ok === false && /even the minimum/.test(broke.why), broke.why);

  // The failure that matters most: unknown must not read as affordable.
  check('an unreadable margin rate is refused, not waved through',
    affordCheck({ units: 1, price: 66.6, marginRate: null, marginAvailable: 51.47, toHome: 1.38 }).ok === false);
  check('and so is an unknown balance, or an unknown conversion',
    affordCheck({ units: 1, price: 66.6, marginRate: 0.22, marginAvailable: null, toHome: 1.38 }).ok === false
    && affordCheck({ units: 1, price: 66.6, marginRate: 0.22, marginAvailable: 51.47, toHome: null }).ok === false,
    'guessing here is how the red rows happened in the first place');

  // Headroom, so a price tick between the check and the fill is not a rejection.
  const exact = affordCheck({ units: 1, marginAvailable: 20.3, ...SILVER });
  check('a position that only just fits is refused, not sent on the edge',
    exact.ok === false,
    'a rejection costs the whole trade; five percent of headroom costs nothing');

  // A USD account needs no conversion and must behave identically.
  const usd = affordCheck({ units: 1, price: 66.6, marginRate: 0.22, marginAvailable: 100 });
  check('a USD account converts by one and is unaffected',
    usd.ok === true && Math.abs(usd.required - 14.65) < 0.05, usd.required.toFixed(2));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

// Timeframes and what each venue can actually serve — shared/timeframes.mjs.
//
// M2 was added to every timeframe picker in the app. OANDA serves it. Binance
// does not, and never has: its interval list goes 1m, 3m, 5m.
//
// The defect this guards is not hypothetical, it was already in the code. The
// Backtester chose its Binance interval with `BINANCE_TF[tf] || '1h'`. Any
// timeframe the map did not know fell through to one hour without a word. Add
// M2 to the picker and leave that line alone and a crypto backtest runs on
// hourly candles, under a control reading 2M, and prints a win rate. Nothing on
// the screen could tell you it answered a different question.
//
// An error is visible and a wrong number is not, which is why every lookup here
// refuses instead of substituting.
import {
  OANDA_TFS, BINANCE_TFS, TF_MINUTES,
  venueSupports, toBinance, unsupportedReason, barsPerTradingDay,
} from '../shared/timeframes.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// ── The asymmetry this file exists for ─────────────────────────────────────
{
  check('OANDA serves two-minute bars',
    OANDA_TFS.includes('M2') && venueSupports('oanda', 'M2') === true);

  check('Binance does not, and the list proves it',
    !BINANCE_TFS.includes('2m') && venueSupports('binance', 'M2') === false,
    BINANCE_TFS.slice(0, 4).join(' '),
    'the exchange goes 1m, 3m, 5m — there is no two');

  check('and the gap is specifically at two, not everywhere',
    venueSupports('binance', 'M1') && venueSupports('binance', 'M5')
    && venueSupports('binance', 'H1') && venueSupports('binance', 'H4'));
}

// ── A missing interval returns nothing, never something near it ────────────
{
  check('M2 maps to null on Binance rather than to a neighbour',
    toBinance('M2') === null, String(toBinance('M2')),
    "'1m' or '3m' here is how a study labelled 2m ends up run on other data");

  check('a timeframe that does exist maps to it',
    toBinance('M15') === '15m' && toBinance('H4') === '4h' && toBinance('D') === '1d');

  check('and an unknown code is null too, not a guess',
    toBinance('M7') === null && toBinance('') === null && toBinance(undefined) === null);

  check('every mapping it does return is a real Binance interval',
    OANDA_TFS.map(toBinance).filter(Boolean).every(x => BINANCE_TFS.includes(x)),
    'a map entry the exchange rejects fails at request time instead of here');
}

// ── The refusal has to be readable ─────────────────────────────────────────
{
  const why = unsupportedReason('binance', 'M2');
  check('an unsupported pairing explains itself',
    typeof why === 'string' && /1m, 3m, 5m/.test(why), String(why),
    'a greyed-out control with no reason on it is a bug report waiting to happen');

  check('a supported pairing has no reason, because there is nothing wrong',
    unsupportedReason('binance', 'M15') === null
    && unsupportedReason('oanda', 'M2') === null);
}

// ── Bar widths, used to turn a count into a span ───────────────────────────
{
  check('a two-minute bar is two minutes', TF_MINUTES.M2 === 2);
  check('and the day divides by it',
    barsPerTradingDay('M2') === 720, String(barsPerTradingDay('M2')),
    '720 two-minute bars is one 24-hour trading day');

  check('the widths increase with the timeframe, with no transcription slips',
    (() => {
      const order = ['M1','M2','M5','M15','M30','H1','H4','D','W'];
      return order.every((tf, i) => i === 0 || TF_MINUTES[tf] > TF_MINUTES[order[i-1]]);
    })(),
    order2());

  check('an unknown timeframe has no width rather than a default one',
    barsPerTradingDay('M7') === null && barsPerTradingDay(undefined) === null,
    'defaulting to 60 minutes silently rescales every span estimate that uses it');
}

function order2() {
  return ['M1','M2','M5','M15','H1','D'].map(t => `${t}=${TF_MINUTES[t]}`).join(' ');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

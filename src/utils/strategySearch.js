// src/utils/strategySearch.js
// Search the space instead of guessing one preset at a time.
//
// Trying strategies by hand and keeping whichever looked best is the classic
// way to find something that has never worked and never will. Run enough
// variants and one of them wins on any data set, including pure noise. That is
// not a reason to avoid searching — it is a reason to search PROPERLY.
//
// The guard here is not a p-value adjustment, which is easy to argue with. It
// is a holdout:
//
//   1. The search only ever sees the first 70% of the history.
//   2. The best few survivors are then run on the last 30%, which the search
//      never touched.
//   3. Anything whose edge collapses out of sample was curve-fitting, and is
//      reported as such rather than quietly dropped.
//
// A strategy that is genuinely there survives both halves. One that was found
// by looking hard almost never does — and watching that happen is far more
// convincing than being told about it.
import { runBacktest, calcStats } from './backtestEngine';

// The instruments a breadth test should be judged on.
//
// Running the check across all fifty sounds more rigorous and is not. Half of
// that list is small-cap crypto and third-tier crosses whose spread is a large
// fraction of the daily range, so a rule with a genuine edge still prints
// negative there and drags the median down. The verdict then reads "one-off"
// for a reason that has nothing to do with the rule.
//
// Twelve deeply traded markets across four asset classes is a harder test, not
// an easier one: metals, indices, both crude grades and the FX majors have
// nothing structurally in common, so a rule that travels across them is
// describing behaviour rather than history.
export const FOCUS_SET = [
  'XAU/USD', 'XAG/USD',                                  // metals
  'US500', 'US100', 'GER40',                             // indices
  'USOIL', 'UKOIL',                                      // energy — both grades
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', // FX majors
];

// Entry triggers. Kept deliberately small: a huge space does not find more
// edges, it finds more noise, and each extra variant raises the bar the winner
// has to clear before it means anything.
const TRIGGERS = [
  { id:'rsi_os',    label:'RSI oversold',        conds:[{type:'rsi',period:14,op:'crossBelow',value:30}] },
  { id:'macd_x',    label:'MACD cross',          conds:[{type:'macd',op:'crossUp'}] },
  { id:'ema_20_50', label:'EMA 20/50 cross',     conds:[{type:'ma_cross',period:20,period2:50,maType:'ema',op:'bullishCross'}] },
  { id:'ema_50_200',label:'EMA 50/200 cross',    conds:[{type:'ma_cross',period:50,period2:200,maType:'ema',op:'bullishCross'}] },
  { id:'sweep',     label:'Strong sweep',        conds:[{type:'strong_rev',op:'bullish',n:5}] },
  { id:'bos',       label:'Structure break',     conds:[{type:'bos',op:'bullish'}] },
  { id:'fvg',       label:'Fair value gap',      conds:[{type:'fvg',op:'bullish'}] },
  { id:'ob',        label:'Order block',         conds:[{type:'ob',op:'bullish'}] },
  { id:'engulf',    label:'Bullish engulfing',   conds:[{type:'candlestick',value:'bull_engulf'}] },
];

// Context filters — the half of a strategy people skip. A trigger that fails
// everywhere often works in one regime, and that is worth finding.
const FILTERS = [
  { id:'none',     label:'—',                   conds:[] },
  { id:'coiled',   label:'volatility coiled',   conds:[{type:'volpct',op:'below',value:30}] },
  { id:'expanding',label:'volatility expanding',conds:[{type:'volpct',op:'above',value:70}] },
  { id:'lowrange', label:'bottom of range',     conds:[{type:'rangepos',op:'below',value:25}] },
  { id:'uptrend',  label:'above EMA200',        conds:[{type:'ma',period:200,maType:'ema',op:'priceAbove'}] },
  { id:'killzone', label:'London/NY killzone',  conds:[{type:'session',op:'killzone'}] },
];

const EXITS = [
  { id:'rr2',    label:'2R target',       exitType:'rr',    rrRatio:2 },
  { id:'rr3',    label:'3R target',       exitType:'rr',    rrRatio:3 },
  { id:'trail2', label:'2 ATR trailing',  exitType:'trail', trailAtr:2 },
  { id:'trail3', label:'3 ATR trailing',  exitType:'trail', trailAtr:3 },
  { id:'trail5', label:'5 ATR trailing',  exitType:'trail', trailAtr:5 },
];

const STOPS = [
  { id:'atr2',  label:'2 ATR stop',  slType:'atr',   slAtr:2 },
  { id:'swing', label:'swing stop',  slType:'swing', swingLookback:12 },
];

export function combinationCount() {
  return TRIGGERS.length * FILTERS.length * EXITS.length * STOPS.length;
}

function build(trigger, filter, exit, stop) {
  return {
    conditions: [...trigger.conds, ...filter.conds],
    logic: 'AND', direction: 'both',
    exitType: exit.exitType, rrRatio: exit.rrRatio, trailAtr: exit.trailAtr,
    slType: stop.slType, slAtr: stop.slAtr, swingLookback: stop.swingLookback,
    slPips: 25, tpPips: 50, riskPct: 1, maxTrades: 1,
  };
}

// Expectancy in R, after spread. The only number worth ranking on: win rate
// alone is satisfied by taking tiny profits and holding losers.
function expR(stats) {
  if (!stats || !stats.totalTrades) return null;
  return stats.avgRR ?? null;
}

// How far back the data reaches, which is not the same thing as how many bars
// there are and matters a great deal more.
//
// 5,000 one-minute bars is six days. Six days is one regime — one prevailing
// trend, one volatility level, one set of positioning — so a rule tuned on it
// has learned last week, and the holdout is the second half of last week. The
// bar count guard passes it happily, which is exactly why it needed a second
// guard that counts calendar time instead.
const MIN_SPAN_DAYS  = 180;
const GOOD_SPAN_DAYS = 1095;   // three years — enough to contain regimes that disagree

export function historySpanDays(candles) {
  if (!candles || candles.length < 2) return 0;
  return (candles[candles.length - 1].t - candles[0].t) / 86400e3;
}

export function describeSpan(days) {
  if (days >= 365) return `${(days / 365).toFixed(1)} years`;
  if (days >= 60)  return `${Math.round(days / 30)} months`;
  return `${Math.round(days)} days`;
}

export async function searchStrategies(candles, {
  minTrades = 30, holdout = 0.3, keep = 8, spreadPips, onProgress,
} = {}) {
  if (!candles || candles.length < 400) {
    return { ok:false, reason:`Only ${candles?.length || 0} bars. A search needs at least 400, and far more to mean anything.` };
  }

  const spanDays = historySpanDays(candles);
  if (spanDays < MIN_SPAN_DAYS) {
    return {
      ok: false,
      reason: `This history covers ${describeSpan(spanDays)}. Searching 540 combinations across it would find `
            + `the best fit to a single market regime and label it a strategy — the holdout would be the `
            + `second half of the same regime, so it could not catch the error either. `
            + `Switch to the Daily timeframe, or a longer one, until the history reaches at least six months.`,
      spanDays,
    };
  }

  const cut = Math.floor(candles.length * (1 - holdout));
  const inSample  = candles.slice(0, cut);
  const outSample = candles.slice(cut);

  const results = [];
  let done = 0;
  let lastYield = performance.now();
  const total = combinationCount();

  for (const tr of TRIGGERS) for (const fl of FILTERS) for (const ex of EXITS) for (const st of STOPS) {
    const strat = build(tr, fl, ex, st);
    if (spreadPips != null) strat.spreadPips = spreadPips;
    let stats = null;
    try {
      const r = runBacktest(inSample, strat);
      stats = calcStats(r.trades);
    } catch { /* a combination that cannot run is simply not a candidate */ }
    done++;
    // Yield on elapsed time, not on a fixed count. One combination costs under
    // a millisecond on 500 daily bars and a fifth of a second on 140,000
    // one-minute ones, so "every 12" meant either yielding pointlessly often or
    // going two and a half seconds between repaints — which reads as a hang,
    // and is what a stalled progress counter actually was.
    if (performance.now() - lastYield > 80) {
      onProgress?.(done, total);
      await new Promise(r => setTimeout(r, 0));
      lastYield = performance.now();
    }

    const e = expR(stats);
    if (stats && stats.totalTrades >= minTrades && e != null) {
      results.push({
        id: `${tr.id}|${fl.id}|${ex.id}|${st.id}`,
        label: `${tr.label}${fl.conds.length ? ` + ${fl.label}` : ''} · ${ex.label} · ${st.label}`,
        strategy: strat,
        inSample: { n: stats.totalTrades, winRate: stats.winRate, expR: e, pf: stats.profitFactor, dd: stats.maxDrawdown,
                    se: stats.seRR, lossStreak: stats.maxLossStreak },
      });
    }
  }

  // Only the best few earn a look at the holdout. Testing everything there
  // would just move the same dredging problem one step later.
  const finalists = results.sort((a, b) => b.inSample.expR - a.inSample.expR).slice(0, keep);

  for (const f of finalists) {
    try {
      const r = runBacktest(outSample, { ...f.strategy, ...(spreadPips != null ? { spreadPips } : {}) });
      const s = calcStats(r.trades);
      f.outSample = { n: s.totalTrades, winRate: s.winRate, expR: expR(s), pf: s.profitFactor, dd: s.maxDrawdown,
                      se: s.seRR, lossStreak: s.maxLossStreak };
    } catch { f.outSample = null; }

    const i = f.inSample.expR, o = f.outSample?.expR;
    f.survived = o != null && o > 0 && f.outSample.n >= Math.max(8, minTrades / 3);
    f.held = f.survived && o >= i * 0.5;      // kept at least half its edge
    f.verdict = !f.outSample || f.outSample.n < 8 ? 'untested'
              : !f.survived ? 'curve-fit'
              : f.held ? 'survived' : 'faded';

    // Surviving the holdout and being distinguishable from luck are different
    // questions, and only the first was ever asked. A trailing rule's single
    // trades run from −1R to +15R, so an average of +0.11R over 400 of them
    // can sit comfortably inside its own error bar — positive, reproduced out
    // of sample, and still not evidence of anything.
    f.significance = significanceOf(f.outSample);
  }

  function significanceOf(s) {
    if (!s || s.expR == null || !s.se) return null;
    const t = s.expR / s.se;                     // how many standard errors from zero
    const ci = 1.96 * s.se;
    // Out-of-sample trades needed for this expectancy to clear zero at 95%,
    // holding the observed variability. The honest answer to "is it enough
    // yet" is usually a number far larger than the one on screen.
    const needed = Math.ceil((1.96 * s.se * Math.sqrt(s.n) / Math.abs(s.expR)) ** 2);
    return {
      t: +t.toFixed(2),
      ci: +ci.toFixed(2),
      clearsZero: s.expR - ci > 0,
      needed: needed > s.n ? needed : null,
    };
  }

  return {
    ok: true,
    tested: total, qualified: results.length,
    inSampleBars: inSample.length, outSampleBars: outSample.length,
    spanDays, span: describeSpan(spanDays),
    // Long enough to run, still short enough that a survivor has only been
    // asked to work in one or two regimes.
    thinHistory: spanDays < GOOD_SPAN_DAYS,
    finalists,
    // Stated plainly so the number can never be read as a discovery count.
    expectedFalsePositives: +(total * 0.05).toFixed(0),
  };
}

// ── Does it work anywhere else? ──────────────────────────────────────────────
// The strongest test available, and stronger than simply adding more bars.
//
// A rule fitted to one instrument's history has no reason to work on another.
// A rule that reflects something real about how markets behave — participants
// trapped at a level, volatility clustering — has every reason to. So run the
// survivor, unchanged, across everything and look at the spread of outcomes.
//
// One instrument at +0.7R and eleven around zero is a fitted rule that got
// lucky once. Seven instruments mildly positive is far more interesting than a
// single spectacular one, and it is the opposite of what a curve-fit produces.
// minTrades is deliberately low. Trend strategies fire rarely — an EMA cross
// might produce a dozen trades in years of data — and at 20 per instrument
// nothing qualified and the whole test returned "not enough". Here the evidence
// is BREADTH across instruments, not depth within one, so ten trades each
// across twelve instruments is a stronger argument than sixty on a single one.
//
// `origin` is the instrument the strategy was searched on. Its row is still
// shown — seeing it tower over everything else is the clearest possible picture
// of a fitted rule — but it is excluded from the count and the median. It was
// selected for being the best of 540 attempts on that one history, so it is
// guaranteed to look good and carries no information. Across fifty instruments
// that bias was 2% and ignorable; across twelve it is 8% and would be the
// difference between a "mixed" and a "one-off" verdict.
export async function testAcrossInstruments(strategy, loadCandles, symbols, { minTrades = 10, origin = null, onProgress } = {}) {
  const rows = [];
  let done = 0;
  for (const sym of symbols) {
    let row = { sym, error: null, origin: sym === origin };
    try {
      const candles = await loadCandles(sym);
      if (!candles || candles.length < 300) throw new Error(`only ${candles?.length || 0} bars`);
      const r = runBacktest(candles, { ...strategy, symbol: sym });
      const s = calcStats(r.trades);
      row.n = s.totalTrades;
      row.expR = s.avgRR;
      row.winRate = s.winRate;
      row.enough = s.totalTrades >= minTrades;
    } catch (e) { row.error = e.message; }
    rows.push(row);
    done++;
    onProgress?.(done, symbols.length);
    await new Promise(r => setTimeout(r, 0));
  }

  const judged = rows.filter(r => r.enough && r.expR != null && !r.origin);
  const positive = judged.filter(r => r.expR > 0);
  const median = judged.length
    ? [...judged].sort((a, b) => a.expR - b.expR)[Math.floor(judged.length / 2)].expR
    : null;

  return {
    rows: rows.sort((a, b) => (b.expR ?? -99) - (a.expR ?? -99)),
    judged: judged.length,
    positive: positive.length,
    median,
    totalTrades: judged.reduce((n, r) => n + r.n, 0),
    skipped: rows.filter(r => !r.enough && !r.error && !r.origin).length,
    origin,
    // A single winner among many is what a fitted rule looks like. Breadth is
    // the evidence; the best number in the list is not.
    verdict: judged.length < 4 ? 'too-few'
           : positive.length >= Math.ceil(judged.length * 0.6) && median > 0 ? 'broad'
           : positive.length >= Math.ceil(judged.length * 0.4) ? 'mixed'
           : 'one-off',
  };
}

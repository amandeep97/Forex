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

export async function searchStrategies(candles, {
  minTrades = 30, holdout = 0.3, keep = 8, spreadPips, onProgress,
} = {}) {
  if (!candles || candles.length < 400) {
    return { ok:false, reason:`Only ${candles?.length || 0} bars. A search needs at least 400, and far more to mean anything.` };
  }

  const cut = Math.floor(candles.length * (1 - holdout));
  const inSample  = candles.slice(0, cut);
  const outSample = candles.slice(cut);

  const results = [];
  let done = 0;
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
    // Yield to the browser periodically — 540 backtests in one synchronous
    // block freezes the phone and looks like a crash.
    if (done % 12 === 0) {
      onProgress?.(done, total);
      await new Promise(r => setTimeout(r, 0));
    }

    const e = expR(stats);
    if (stats && stats.totalTrades >= minTrades && e != null) {
      results.push({
        id: `${tr.id}|${fl.id}|${ex.id}|${st.id}`,
        label: `${tr.label}${fl.conds.length ? ` + ${fl.label}` : ''} · ${ex.label} · ${st.label}`,
        strategy: strat,
        inSample: { n: stats.totalTrades, winRate: stats.winRate, expR: e, pf: stats.profitFactor, dd: stats.maxDrawdown },
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
      f.outSample = { n: s.totalTrades, winRate: s.winRate, expR: expR(s), pf: s.profitFactor, dd: s.maxDrawdown };
    } catch { f.outSample = null; }

    const i = f.inSample.expR, o = f.outSample?.expR;
    f.survived = o != null && o > 0 && f.outSample.n >= Math.max(8, minTrades / 3);
    f.held = f.survived && o >= i * 0.5;      // kept at least half its edge
    f.verdict = !f.outSample || f.outSample.n < 8 ? 'untested'
              : !f.survived ? 'curve-fit'
              : f.held ? 'survived' : 'faded';
  }

  return {
    ok: true,
    tested: total, qualified: results.length,
    inSampleBars: inSample.length, outSampleBars: outSample.length,
    finalists,
    // Stated plainly so the number can never be read as a discovery count.
    expectedFalsePositives: +(total * 0.05).toFixed(0),
  };
}

// src/utils/feedToBacktest.js
// Turns a Live Feed filter into a Backtester strategy.
//
// The Feed answers "is this rare?" and the Backtester answers "is it worth
// trading?" — two halves of the same question that had no way to talk to each
// other. You could build a filter, watch it fire 0.6 times a month, shortlist
// from it, and never find out whether anything followed.
//
// The translation is deliberately incomplete, and says so. Some conditions
// cannot be backtested honestly:
//
//   spread — no historical bid/ask is stored anywhere, so testing it would mean
//            inventing the numbers
//   COT    — testable in principle, but only with the report's real publication
//            lag applied. Ignoring that lag produces a beautiful, fake edge.
//
// Those are reported as dropped rather than silently omitted. A backtest that
// quietly tests four of your six conditions and reports a win rate is worse
// than no backtest, because it looks like an answer.
import { CONDITIONS, defaultParams } from '../../shared/feedConditions.mjs';

const DIR = d => (d === 'up' ? 'bullish' : d === 'down' ? 'bearish' : 'any');

// key -> (params) => backtest condition | null, plus why null
const MAP = {
  sweep: p => ({ type:'strong_rev', op: DIR(p.dir) === 'any' ? 'bullish' : DIR(p.dir) }),
  break: p => ({ type:'bos',        op: DIR(p.dir) === 'any' ? 'bullish' : DIR(p.dir) }),
  candlePattern: p => ({ type:'candlestick', value: p.pattern === 'any' ? 'any_reversal' : p.pattern }),

  volCoiled:    p => ({ type:'volpct',      op:'below', value: p.maxPct }),
  volExpanding: p => ({ type:'volpct',      op:'above', value: p.minPct }),
  rangeTop:     p => ({ type:'rangepos',    op:'above', value: p.minPct }),
  rangeBottom:  p => ({ type:'rangepos',    op:'below', value: p.maxPct }),
  bigMove:      p => ({ type:'chg20',       op: p.dir === 'up' ? 'up' : p.dir === 'down' ? 'down' : 'any', value: p.minAbsPct }),
  oneSided:     p => ({ type:'persistence', op:'above', value: p.minPct }),
};

const UNTESTABLE = {
  spreadBlown:  'no historical bid/ask is stored — testing it would mean inventing the data',
  spreadNormal: 'no historical bid/ask is stored — testing it would mean inventing the data',
  crowdedLong:  'needs the COT report’s real publication lag; ignoring it gives look-ahead bias',
  crowdedShort: 'needs the COT report’s real publication lag; ignoring it gives look-ahead bias',
};

export function translateFilter(filter) {
  const conditions = [];
  const dropped = [];

  for (const c of filter?.conditions || []) {
    const def = CONDITIONS[c.key];
    const p = { ...defaultParams(c.key), ...(c.params || {}) };
    if (UNTESTABLE[c.key]) {
      dropped.push({ key:c.key, label: def?.label || c.key, why: UNTESTABLE[c.key] });
      continue;
    }
    const fn = MAP[c.key];
    if (!fn) { dropped.push({ key:c.key, label: def?.label || c.key, why:'no equivalent in the backtest engine' }); continue; }
    conditions.push(fn(p));
  }

  // Timeframes are per-condition in the Feed and per-strategy in a backtest, so
  // a filter mixing H4 and daily cannot be one test. Report it rather than
  // silently testing everything on whichever timeframe happens to be first.
  const tfs = [...new Set((filter?.conditions || [])
    .map(c => ({ ...defaultParams(c.key), ...(c.params || {}) }).tf)
    .filter(Boolean))];

  return {
    strategy: {
      name: `Feed — ${filter?.name || 'filter'}`,
      conditions,
      // ANY N-of-M has no engine equivalent; the honest reduction is OR, and
      // the caller is told the threshold was lost.
      logic: filter?.mode === 'any' ? 'OR' : 'AND',
      direction: 'both',
    },
    timeframe: tfs[0] || 'H4',
    mixedTimeframes: tfs.length > 1 ? tfs : null,
    minMatchLost: filter?.mode === 'any' && (filter.minMatch || 1) > 1 ? filter.minMatch : null,
    dropped,
    testable: conditions.length,
    total: (filter?.conditions || []).length,
  };
}

export const FEED_BACKTEST_KEY = 'feed_backtest_handoff_v1';

// Handed over through localStorage rather than a prop, because the Backtester
// is a lazily-loaded sibling tab with no shared parent state to thread through.
export function stageFilterForBacktest(filter) {
  const t = translateFilter(filter);
  try { localStorage.setItem(FEED_BACKTEST_KEY, JSON.stringify({ ...t, at: Date.now() })); } catch { /* quota */ }
  return t;
}

export function takeStagedFilter() {
  try {
    const raw = localStorage.getItem(FEED_BACKTEST_KEY);
    if (!raw) return null;
    localStorage.removeItem(FEED_BACKTEST_KEY);
    const v = JSON.parse(raw);
    // Stale handoffs are worse than none — you would be shown a strategy you
    // set up days ago as though you had just asked for it.
    return Date.now() - (v.at || 0) < 10 * 60_000 ? v : null;
  } catch { return null; }
}

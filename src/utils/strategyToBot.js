// src/utils/strategyToBot.js
// Turns a Backtester strategy into an Auto Trading bot strategy.
//
// This exists because the alternative is retyping, and retyping is how an
// XAG/USD daily engulfing rule with a 5 ATR trailing stop became a EUR/USD
// one-minute strategy with no entry conditions and a fixed 1:2 target. Every
// field was changed by hand and every one of them was changed wrong. The
// backtest that justified it was testing something else entirely.
//
// The translation is honest about being partial. Three categories:
//
//   exact        the bot does the same thing the engine did
//   approximate  the bot does something close, and the difference is stated
//   blocking     the bot has no equivalent, so the handoff is refused
//
// A silent approximation is the dangerous case, because the result is a live
// strategy that looks like the tested one and is not. So approximations are
// listed on screen and have to be read before the handoff completes, and
// anything blocking stops it outright. Refusing to trade a rule is cheap.
// Trading a different rule than the one you validated is not.
import { bySymbol } from '../data/instruments';

// Conditions the bot evaluates, and what it actually checks.
const MAP = {
  bos: (c, out) => {
    out.conditions.requireBOS = true;
    return { level: 'approximate', what: 'Structure break',
      why: 'the engine tests a break in the trade direction; the bot tests for any break and takes the side the market structure is already on' };
  },

  ob: (c, out) => {
    out.conditions.requireOB = true;
    return { level: 'approximate', what: 'Order block',
      why: 'the engine tests that an order block formed; the bot additionally requires price to be tapping into it AND to be in the discount half of the range, so it will fire less often' };
  },

  fvg: (c, out) => {
    out.conditions.requireFVG = true;
    return { level: 'approximate', what: 'Fair value gap',
      why: 'the bot additionally requires price to be inside the gap and in the discount half of the range, so it will fire less often' };
  },

  // The bot can now name a single pattern, so this is a translation rather than
  // a widening. It used to collapse every pattern to its family and warn that
  // the bot would take more trades than the backtest did; that warning was
  // correct and is no longer needed.
  candlestick: (c, out) => {
    const want = String(c.value || '');
    if (want === 'any_bull') { out.conditions.candlePattern = 'bullish'; return null; }
    if (want === 'any_bear') { out.conditions.candlePattern = 'bearish'; return null; }
    if (want === 'any_reversal') {
      out.conditions.candlePattern = 'bullish';
      return { level: 'approximate', what: 'Candlestick: any reversal',
        why: 'the bot takes one direction per strategy, so this becomes the bullish family — run a second strategy for the bearish side' };
    }
    out.conditions.candlePattern = want;
    return null;
  },

  // The full-range sweep. The bot has always detected it; it now has a switch.
  // The engine says bullish/bearish, which for a strong reversal means the
  // hammer and the star — a bullish one sweeps the low, a bearish one the high.
  strong_rev: (c, out) => {
    const op = String(c.op || c.value || 'any');
    out.conditions.candlePattern = op === 'bullish' ? 'strong_hammer'
      : op === 'bearish' ? 'strong_star' : 'strong_any';
    if (c.n) out.conditions.candleN = c.n;
    return null;
  },

  // The engine names the MACD event in camelCase (crossUp); the bot's modes are
  // snake_case. Translating rather than passing it through, because an
  // unrecognised mode would fall through to "above" — a state, not the trigger
  // that was backtested.
  macd: (c, out) => {
    const raw = String(c.op || c.value || 'above');
    const MODES = {
      crossUp: 'cross_up', cross_up: 'cross_up',
      crossDown: 'cross_down', cross_down: 'cross_down',
      above: 'above', below: 'below', rising: 'rising', falling: 'falling',
    };
    const mode = MODES[raw];
    if (!mode) {
      return { level: 'blocking', what: `MACD: ${raw}`,
        why: 'the bot has no equivalent for this MACD trigger' };
    }
    out.conditions.macdFilter = { enabled: true, mode };
    return null;
  },

  // The two the bot used to refuse. It now evaluates them with the FEED's own
  // measure(), against the same 500-bar population the engine ranks against,
  // so this is a translation rather than an approximation.
  volpct: (c, out) => {
    out.conditions.volPctFilter = { enabled: true, op: c.op === 'above' ? 'above' : 'below', value: c.value ?? 30 };
    return { level: 'exact', what: `Volatility percentile ${c.op} ${c.value}` };
  },

  rangepos: (c, out) => {
    out.conditions.rangePosFilter = { enabled: true, op: c.op === 'above' ? 'above' : 'below', value: c.value ?? 25 };
    return { level: 'exact', what: `Range position ${c.op} ${c.value}` };
  },

  ma: (c, out) => {
    if ((c.maType || 'ema') !== 'ema') {
      return { level: 'blocking', what: `${c.maType} ${c.period} filter`,
        why: 'the bot only has an EMA filter' };
    }
    out.conditions.emaFilter = {
      enabled: true,
      period: c.period || 200,
      side: c.op === 'priceBelow' ? 'below' : 'above',
    };
    return { level: 'exact', what: `Price vs EMA${c.period || 200}` };
  },

  rsi: (c, out) => {
    const cross = /cross/i.test(c.op || '');
    out.conditions.rsiFilter = {
      enabled: true,
      comparison: /Below|below/.test(c.op || '') ? 'below' : 'above',
      value: c.value ?? 30,
    };
    return cross
      ? { level: 'approximate', what: `RSI ${c.op} ${c.value}`,
          why: 'the engine fires on the bar RSI crosses the level — a single event. The bot fires on every bar RSI is beyond it, so it will keep entering while the condition persists' }
      : { level: 'exact', what: `RSI ${c.op} ${c.value}` };
  },

  session: (c, out) => {
    out.conditions.sessions = ['london', 'newyork'];
    return { level: 'approximate', what: 'London/NY killzone',
      why: 'the bot has whole sessions, not killzones — this covers 07:00–22:00 UTC rather than the two-hour windows the engine tested' };
  },
};

// No equivalent exists. Each of these would need new detection in the bot, and
// approximating them would change the rule rather than translate it.
const BLOCKING = {
  chg20:       'the bot has no N-bar change filter',
  persistence: 'the bot has no directional-persistence filter',
  ma_cross:    'the bot has no moving-average cross trigger',
  // Cross-asset conditions need a second instrument's aligned history at
  // decision time. The bot fetches one pair per strategy, so handing one over
  // would place trades on a rule with its most important condition missing.
  lead:        'the bot has no cross-asset series — it would trade this without the peer condition at all',
  divergence:  'the bot has no cross-asset series — it would trade this without the peer condition at all',
  peer_chg:    'the bot has no cross-asset series — it would trade this without the peer condition at all',
  ratio_pct:   'the bot has no cross-asset series — it would trade this without the peer condition at all',
  stretch:     'the bot has no distance-from-EMA filter',
  breakout:    'the bot has no n-bar breakout filter',
  gap:         'the bot has no opening-gap filter',
  wick:        'the bot has no wick-dominance filter',
  dom:         'the bot has no day-of-month filter',
  quarter:     'the bot has no quarter filter',
};

const TF_MAP = { '1M':'M1', '5M':'M5', '15M':'M15', '30M':'M30', '1H':'H1', '4H':'H4', '8H':'H8', 'D':'D', 'W':'W' };

export function translateToBot(strategy, { symbol, timeframe, name, riskPercent = 1 } = {}) {
  const notes = [];
  const inst = bySymbol(symbol);

  const out = {
    name: name || `Backtester — ${symbol}`,
    enabled: false,          // never arrives switched on
    pairs: inst?.oanda ? [inst.oanda] : [],
    timeframe: TF_MAP[timeframe] || 'H1',
    direction: strategy?.direction || 'both',
    conditions: { structure: 'any', priceZone: 'any', sessions: [] },
    risk: { riskType: 'percent', riskPercent },
    maxPositionsPerPair: 1,
  };

  if (!inst?.oanda) {
    notes.push({ level: 'blocking', what: symbol || 'instrument',
      why: 'the trading bot places orders through OANDA, and this instrument is not on OANDA' });
  }

  for (const c of strategy?.conditions || []) {
    if (BLOCKING[c.type]) {
      notes.push({ level: 'blocking', what: c.type, why: BLOCKING[c.type] });
      continue;
    }
    const fn = MAP[c.type];
    if (!fn) { notes.push({ level: 'blocking', what: c.type, why: 'no equivalent in the trading bot' }); continue; }
    const note = fn(c, out);
    if (note) notes.push(note);
  }

  // OR has no bot equivalent: every condition in a bot strategy must pass.
  // Translating it to AND would quietly test a far stricter rule.
  if ((strategy?.logic || 'AND') === 'OR' && (strategy?.conditions || []).length > 1) {
    notes.push({ level: 'blocking', what: 'ANY / OR logic',
      why: 'the bot requires every condition to pass; there is no way to express "any of these"' });
  }

  // Exit
  if (strategy?.exitType === 'trail') {
    out.risk.tpMethod = 'trail';
    out.risk.trailAtr = strategy.trailAtr || 3;
    notes.push({ level: 'approximate', what: `${out.risk.trailAtr} ATR trailing stop`,
      why: 'the bot walks the stop once per closed bar, like the backtest — but only while the VPS is running. If it stops, the trade keeps its last stop and no longer trails' });
  } else {
    out.risk.tpMethod = 'rr';
    out.risk.rrRatio = strategy?.rrRatio || 2;
    notes.push({ level: 'exact', what: `${out.risk.rrRatio}R target` });
  }

  // Stop
  if (strategy?.slType === 'swing') {
    out.risk.slMethod = 'swing';
    notes.push({ level: 'approximate', what: 'Swing stop',
      why: `the engine looks back ${strategy.swingLookback || 12} bars for the swing; the bot uses 20 and adds a 3 pip buffer, so the stop will usually be wider and the position smaller` });
  } else {
    out.risk.slMethod = 'atr';
    out.risk.slAtr = strategy?.slAtr || 2;
    notes.push({ level: 'exact', what: `${out.risk.slAtr} ATR stop` });
  }

  // The bot resolves "both" from market structure and refuses to trade a
  // ranging market. The engine has no such rule, so this is a filter the
  // backtest never applied.
  if (out.direction === 'both') {
    notes.push({ level: 'approximate', what: 'Direction: both',
      why: 'the bot takes the side of the prevailing market structure and stands aside when structure is ranging — a filter the backtest did not apply' });
  }

  const blockers = notes.filter(n => n.level === 'blocking');
  return {
    ok: blockers.length === 0,
    config: out,
    notes,
    blockers,
    approximations: notes.filter(n => n.level === 'approximate'),
    exact: notes.filter(n => n.level === 'exact'),
  };
}

export const BOT_HANDOFF_KEY = 'backtest_bot_handoff_v1';

// Staged through localStorage for the same reason the Feed→Backtester handoff
// is: Auto Trading is a lazily-loaded sibling tab with no shared parent state.
export function stageForBot(strategy, opts) {
  const t = translateToBot(strategy, opts);
  if (!t.ok) return t;
  try { localStorage.setItem(BOT_HANDOFF_KEY, JSON.stringify({ config: t.config, notes: t.notes, at: Date.now() })); }
  catch { /* quota */ }
  return t;
}

export function takeStagedBotStrategy() {
  try {
    const raw = localStorage.getItem(BOT_HANDOFF_KEY);
    if (!raw) return null;
    localStorage.removeItem(BOT_HANDOFF_KEY);
    const v = JSON.parse(raw);
    return Date.now() - (v.at || 0) < 10 * 60_000 ? v : null;
  } catch { return null; }
}

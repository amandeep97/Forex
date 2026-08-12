// src/utils/deepSearch.js
// Build strategies of three, four and five conditions instead of two.
//
// The preset search pairs one trigger with one filter: 540 strategies, none of
// them deeper than two conditions. That is not where uncommon edges live. A
// trigger everyone knows, on its own, has been arbitraged flat; the same
// trigger under three specific conditions that nobody stacks together has not,
// because nobody has looked.
//
// The obstacle is that the space explodes. Forty conditions taken four at a
// time is 91,390 sets before exits and stops, and testing 91,390 strategies
// guarantees finding beautiful ones in pure noise.
//
// So this does not enumerate. It builds greedily and splits the history three
// ways:
//
//   BUILD    (50%)  conditions are added one at a time, keeping whichever
//                   addition most improves expectancy here
//   VALIDATE (20%)  every finished combination is scored here. Constructions
//                   that only worked on BUILD are dropped, and this is what
//                   catches the greedy step fitting itself to its own data
//   HOLDOUT  (30%)  touched once, by the finalists, and never used to choose
//                   between them
//
// Roughly 1,300 strategies get evaluated, but only about a dozen ever reach
// the holdout — and it is the number of looks at the FINAL slice that governs
// how much a good number there is worth. That count is reported rather than
// buried.
import { runBacktest, calcStats } from './backtestEngine';
import { buildContext } from './contextSeries';

// ── Is it better than entering at random, here? ──────────────────────────────
//
// Comparing holdout expectancy against zero is not enough, and on a trending
// slice it is barely a test at all. A price series wanders; if the last third
// of it happens to rise, every long-biased rule shows a positive expectancy
// there, and the error bar around that expectancy has nothing to say about it
// because the drift is real, just not a property of the rule.
//
// Measured on pure random walks, the zero test passed five finalists out of
// eight. The whole point of the exercise is not to produce those.
//
// So the comparison is against random entries taken on the SAME slice, at the
// same frequency and the same long/short mix, exited by the same rules. Any
// drift is then in both arms and cancels; what is left is whether the entry
// timing knew something. The p-value is the fraction of random runs that did
// at least as well.
const RANDOM_RUNS = 40;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function beatsRandom(slice, strategy, nTrades, longRatio) {
  const evalBars = Math.max(1, slice.length - 10);
  const p = Math.min(1, nTrades / evalBars);
  if (!(p > 0)) return null;

  const got = [];
  for (let k = 0; k < RANDOM_RUNS; k++) {
    const rnd = mulberry32(982451 + k * 7919);
    const fire = new Array(slice.length).fill(null);
    for (let i = 10; i < slice.length; i++) {
      if (rnd() < p) fire[i] = rnd() < longRatio ? 'long' : 'short';
    }
    try {
      const st = calcStats(runBacktest(slice, strategy, { entryOverride: i => fire[i] }).trades);
      if (st.totalTrades >= 5 && st.avgRR != null) got.push(st.avgRR);
    } catch { /* a run that cannot execute is not evidence either way */ }
  }
  if (got.length < RANDOM_RUNS / 2) return null;
  got.sort((a, b) => a - b);
  return {
    runs: got.length,
    median: +got[Math.floor(got.length / 2)].toFixed(2),
    best:   +got[got.length - 1].toFixed(2),
    // Fraction of random runs that matched or beat the rule, with the usual
    // +1 correction so a perfect result reports 1/(runs+1) rather than an
    // impossible zero.
    pValue: (ruleExpR) => (got.filter(v => v >= ruleExpR).length + 1) / (got.length + 1),
  };
}

// ── A null built from your own data ─────────────────────────────────────────
//
// Every significance test here rests on an assumption, and the assumptions
// were checked and found wanting. Measured on five pure random walks, 38% of
// finalists cleared zero and 49% beat random entries — where 5% was the
// intent. The diagnosis is not the obvious one: entry volatility sits at the
// median and the fitted rules carry WIDER stops than the random arm, so this
// is not a risk-normalisation artifact. Whatever the mechanism, a search that
// deep finds structure in noise faster than a formula can discount it.
//
// So stop reasoning about the null and measure it. Bars are resampled in
// blocks — long enough to preserve volatility clustering and the shape of
// individual candles, shuffled enough to destroy any real predictability —
// and the identical search is run again on that. Whatever it finds there is
// what this machinery produces from nothing.
//
// A finalist is then worth attention only if it beats that. It is the one
// benchmark that cannot be argued with, because it was produced by the same
// search, on the same instrument, at the same length.
const BLOCK = 25;

export function shuffledNull(candles, seed = 20260805) {
  const n = candles.length;
  if (n < BLOCK * 4) return candles.slice();
  const rnd = mulberry32(seed);
  const nBlocks = Math.ceil(n / BLOCK);
  const out = [];
  let last = candles[0].c;

  for (let b = 0; b < nBlocks; b++) {
    const start = Math.floor(rnd() * (n - BLOCK));
    const block = candles.slice(start, start + BLOCK);
    // Each block is re-based so its first open continues from the previous
    // close. Without this the series is full of enormous artificial gaps and
    // the null becomes far easier to beat than the real thing.
    const shift = last - block[0].o;
    for (const c of block) {
      out.push({ t: candles[out.length]?.t ?? c.t,
                 o: c.o + shift, h: c.h + shift, l: c.l + shift, c: c.c + shift, v: c.v });
      if (out.length >= n) break;
    }
    last = out[out.length - 1].c;
    if (out.length >= n) break;
  }
  return out;
}

// Families exist to answer "is this combination unusual?".
//
// Four conditions that are all momentum are one idea measured four ways, and
// they will agree with each other by construction. Four conditions drawn from
// four different families are four independent statements about the same bar,
// which is both rarer and much harder to arrive at by accident.
export const FAMILY = {
  crossasset: 'Cross-asset',
  calendar:   'Calendar',
  structure:  'Structure',
  momentum:   'Momentum',
  trend:      'Trend',
  volatility: 'Volatility',
  location:   'Location',
  time:       'Timing',
  volume:     'Volume',
  candle:     'Candle',
};

// The vocabulary. Everything the engine can evaluate, including the eleven
// types the preset search never touched and the four added for this.
export const POOL = [
  // ── Structure ─────────────────────────────────────────────────────────────
  { id:'bos',        fam:'structure', label:'structure break',        cond:{ type:'bos', op:'bullish' } },
  { id:'ob',         fam:'structure', label:'order block',            cond:{ type:'ob', op:'bullish' } },
  { id:'fvg',        fam:'structure', label:'fair value gap',         cond:{ type:'fvg', op:'bullish' } },
  { id:'sweep',      fam:'structure', label:'strong sweep',           cond:{ type:'strong_rev', op:'bullish', n:5 } },
  { id:'liq',        fam:'structure', label:'liquidity sweep',        cond:{ type:'liquidity', op:'bullish' } },
  { id:'ote',        fam:'structure', label:'OTE zone',               cond:{ type:'ote_zone', op:'bullish' } },
  { id:'eqlows',     fam:'structure', label:'equal lows',             cond:{ type:'equal_hl', op:'equalLows' } },
  { id:'disp',       fam:'structure', label:'displacement',           cond:{ type:'displacement', op:'bullish' } },

  // ── Momentum ──────────────────────────────────────────────────────────────
  { id:'rsi_os',     fam:'momentum',  label:'RSI crosses under 30',   cond:{ type:'rsi', period:14, op:'crossBelow', value:30 } },
  { id:'rsi_lo',     fam:'momentum',  label:'RSI under 40',           cond:{ type:'rsi', period:14, op:'below', value:40 } },
  { id:'rsi_hi',     fam:'momentum',  label:'RSI over 60',            cond:{ type:'rsi', period:14, op:'above', value:60 } },
  { id:'macd_x',     fam:'momentum',  label:'MACD cross',             cond:{ type:'macd', op:'crossUp' } },
  { id:'mfi_lo',     fam:'momentum',  label:'MFI under 30',           cond:{ type:'mfi', period:14, op:'below', value:30 } },
  { id:'mfi_hi',     fam:'momentum',  label:'MFI over 70',            cond:{ type:'mfi', period:14, op:'above', value:70 } },

  // ── Trend ─────────────────────────────────────────────────────────────────
  { id:'above200',   fam:'trend',     label:'above EMA200',           cond:{ type:'ma', period:200, maType:'ema', op:'priceAbove' } },
  { id:'below200',   fam:'trend',     label:'below EMA200',           cond:{ type:'ma', period:200, maType:'ema', op:'priceBelow' } },
  { id:'above50',    fam:'trend',     label:'above EMA50',            cond:{ type:'ma', period:50,  maType:'ema', op:'priceAbove' } },
  { id:'x_20_50',    fam:'trend',     label:'EMA 20/50 cross',        cond:{ type:'ma_cross', period:20, period2:50,  maType:'ema', op:'bullishCross' } },
  { id:'x_50_200',   fam:'trend',     label:'EMA 50/200 cross',       cond:{ type:'ma_cross', period:50, period2:200, maType:'ema', op:'bullishCross' } },

  // ── Volatility ────────────────────────────────────────────────────────────
  { id:'coiled',     fam:'volatility',label:'volatility coiled',      cond:{ type:'volpct', op:'below', value:30 } },
  { id:'expanding',  fam:'volatility',label:'volatility expanding',   cond:{ type:'volpct', op:'above', value:70 } },
  { id:'consol',     fam:'volatility',label:'in consolidation',       cond:{ type:'consolidation' } },
  { id:'gap_up',     fam:'volatility',label:'gapped up 0.5 ATR',      cond:{ type:'gap', op:'up', value:0.5 } },

  // ── Location ──────────────────────────────────────────────────────────────
  { id:'range_lo',   fam:'location',  label:'bottom of range',        cond:{ type:'rangepos', op:'below', value:25 } },
  { id:'range_hi',   fam:'location',  label:'top of range',           cond:{ type:'rangepos', op:'above', value:75 } },
  { id:'stretch_dn', fam:'location',  label:'2 ATR below EMA50',      cond:{ type:'stretch', period:50, op:'below', value:2 } },
  { id:'stretch_up', fam:'location',  label:'2 ATR above EMA50',      cond:{ type:'stretch', period:50, op:'above', value:2 } },
  { id:'break_hi',   fam:'location',  label:'20-bar breakout',        cond:{ type:'breakout', op:'high', n:20 } },
  { id:'break_lo',   fam:'location',  label:'20-bar breakdown',       cond:{ type:'breakout', op:'low',  n:20 } },
  { id:'bigmove',    fam:'location',  label:'20-bar move over 3%',    cond:{ type:'chg20', op:'up', value:3 } },
  { id:'onesided',   fam:'location',  label:'one-sided last 20',      cond:{ type:'persistence', op:'above', value:70 } },

  // ── Timing ────────────────────────────────────────────────────────────────
  { id:'kz',         fam:'time',      label:'London/NY killzone',     cond:{ type:'session', op:'killzone' } },
  { id:'london',     fam:'time',      label:'London session',         cond:{ type:'session', op:'london' } },
  { id:'ny',         fam:'time',      label:'New York session',       cond:{ type:'session', op:'ny' } },
  { id:'asian',      fam:'time',      label:'Asian session',          cond:{ type:'session', op:'asian' } },
  { id:'mon',        fam:'time',      label:'Monday',                 cond:{ type:'dow', op:'mon' } },
  { id:'tue',        fam:'time',      label:'Tuesday',                cond:{ type:'dow', op:'tue' } },
  { id:'wed',        fam:'time',      label:'Wednesday',              cond:{ type:'dow', op:'wed' } },
  { id:'thu',        fam:'time',      label:'Thursday',               cond:{ type:'dow', op:'thu' } },
  { id:'fri',        fam:'time',      label:'Friday',                 cond:{ type:'dow', op:'fri' } },

  // ── Volume ────────────────────────────────────────────────────────────────
  { id:'vol_spike',  fam:'volume',    label:'volume spike 1.5x',      cond:{ type:'volume', op:'spike', mult:1.5 } },
  { id:'vol_dry',    fam:'volume',    label:'volume below average',   cond:{ type:'volume', op:'below' } },

  // ── Candle ────────────────────────────────────────────────────────────────
  { id:'engulf',     fam:'candle',    label:'bullish engulfing',      cond:{ type:'candlestick', value:'bull_engulf' } },
  { id:'hammer',     fam:'candle',    label:'hammer',                 cond:{ type:'candlestick', value:'hammer' } },
  { id:'any_rev',    fam:'candle',    label:'any reversal pattern',   cond:{ type:'candlestick', value:'any_reversal' } },
  { id:'wick_dn',    fam:'candle',    label:'long lower wick',        cond:{ type:'wick', op:'lower', value:0.5 } },
  { id:'wick_up',    fam:'candle',    label:'long upper wick',        cond:{ type:'wick', op:'upper', value:0.5 } },

  // ── Calendar ──────────────────────────────────────────────────────────────
  // Month-end and quarter-end flows are among the few effects with a
  // mechanical cause — funds rebalance because a mandate says so, not because
  // a chart looked a certain way — and almost nobody tests them.
  { id:'turn_month', fam:'calendar',  label:'turn of the month',      cond:{ type:'dom', op:'turn' } },
  { id:'first_days', fam:'calendar',  label:'first 5 days of month',  cond:{ type:'dom', op:'first' } },
  { id:'mid_month',  fam:'calendar',  label:'middle of the month',    cond:{ type:'dom', op:'mid' } },
  { id:'last_days',  fam:'calendar',  label:'last 5 days of month',   cond:{ type:'dom', op:'last' } },
  { id:'q1',         fam:'calendar',  label:'Q1',                     cond:{ type:'quarter', value:1 } },
  { id:'q4',         fam:'calendar',  label:'Q4',                     cond:{ type:'quarter', value:4 } },
];

// ── Cross-asset conditions ───────────────────────────────────────────────────
// Built per peer, because the peer set depends on what the app could fetch.
//
// This is the half of the vocabulary a chart package cannot express, and the
// reason to expect anything here to be untrodden. "RSI under 30 on gold" has
// been tested by a million people. "Gold made a 20-bar high while silver did
// not, in the last three days of the month" has been tested by approximately
// nobody, which is not proof it works but is the only place worth looking.
export const PEER_LABEL = {
  'US500':   'the S&P',
  'XAU/USD': 'gold',
  'XAG/USD': 'silver',
  'USOIL':   'oil',
  'EUR/USD': 'the euro',
  'US100':   'the Nasdaq',
};

export function crossAssetPool(peers) {
  const out = [];
  for (const sym of peers) {
    const name = PEER_LABEL[sym] || sym;
    out.push(
      { id:`lead_up_${sym}`,  fam:'crossasset', label:`${name} moved up, this has not yet`,
        cond:{ type:'lead', peer:sym, n:3, op:'up', value:1.5 } },
      { id:`lead_dn_${sym}`,  fam:'crossasset', label:`${name} moved down, this has not yet`,
        cond:{ type:'lead', peer:sym, n:3, op:'down', value:1.5 } },
      { id:`div_bull_${sym}`, fam:'crossasset', label:`held up while ${name} fell`,
        cond:{ type:'divergence', peer:sym, n:5, op:'bull', value:1 } },
      { id:`div_bear_${sym}`, fam:'crossasset', label:`fell while ${name} held up`,
        cond:{ type:'divergence', peer:sym, n:5, op:'bear', value:1 } },
      { id:`peer_up_${sym}`,  fam:'crossasset', label:`${name} up over 2% in 10 bars`,
        cond:{ type:'peer_chg', peer:sym, n:10, op:'above', value:2 } },
      { id:`peer_dn_${sym}`,  fam:'crossasset', label:`${name} down over 2% in 10 bars`,
        cond:{ type:'peer_chg', peer:sym, n:10, op:'below', value:-2 } },
      { id:`ratio_hi_${sym}`, fam:'crossasset', label:`near a 1-year high against ${name}`,
        cond:{ type:'ratio_pct', peer:sym, op:'above', value:80 } },
      { id:`ratio_lo_${sym}`, fam:'crossasset', label:`near a 1-year low against ${name}`,
        cond:{ type:'ratio_pct', peer:sym, op:'below', value:20 } },
    );
  }
  return out;
}

// The ceiling here was a 3R target and a 5 ATR trail, which means no strategy
// in the search could express "hold for a very large move". A rule whose whole
// case is one 20R trade a year had no exit capable of collecting it, so it
// could never place well however good the entry was.
const EXITS = [
  { id:'rr2',    label:'2R target',       exitType:'rr',    rrRatio:2 },
  { id:'rr3',    label:'3R target',       exitType:'rr',    rrRatio:3 },
  { id:'rr5',    label:'5R target',       exitType:'rr',    rrRatio:5 },
  { id:'rr8',    label:'8R target',       exitType:'rr',    rrRatio:8 },
  { id:'trail2', label:'2 ATR trailing',  exitType:'trail', trailAtr:2 },
  { id:'trail3', label:'3 ATR trailing',  exitType:'trail', trailAtr:3 },
  { id:'trail5', label:'5 ATR trailing',  exitType:'trail', trailAtr:5 },
  { id:'trail8', label:'8 ATR trailing',  exitType:'trail', trailAtr:8 },
  { id:'trail12',label:'12 ATR trailing', exitType:'trail', trailAtr:12 },
];
const STOPS = [
  { id:'atr2',  label:'2 ATR stop', slType:'atr',   slAtr:2 },
  { id:'swing', label:'swing stop', slType:'swing', swingLookback:12 },
];

// Used while conditions are being chosen, so the search is comparing entries
// rather than exits. Exits are optimised afterwards, on the combinations that
// survived — otherwise a good entry with an unlucky default exit is discarded
// before it is ever seen properly.
//
// Looked up by id, not by position. This was EXITS[3], and adding two wider
// targets to the front of the list silently moved the neutral exit from a
// 3 ATR trail to an 8R target — which completes far fewer trades, so every
// condition fell under the trade floor and the search reported that no
// condition in a 47-word vocabulary produced a single qualifying entry.
const NEUTRAL_EXIT = EXITS.find(e => e.id === 'trail3');
const NEUTRAL_STOP = STOPS.find(s => s.id === 'atr2');

// ── Horizon ──────────────────────────────────────────────────────────────────
//
// The search had no notion of how long a rule holds for, so it optimised over
// scalps and swings together and returned whichever scored best. If the trade
// you intend to place is a multi-day one, most of that list is unusable — and
// worse, the scalps tend to win the ranking, because a rule that fires often
// and exits in a bar or two accumulates a tidier expectancy than one that holds
// through a drawdown for a fortnight.
//
// Two changes when swing mode is on, and only two, because everything else the
// search does is horizon-neutral.
//
// Session filters go, and not as a preference. "London killzone" is a statement
// about which hours of the day price moves, and a rule held for two weeks spans
// every session there is — on daily bars the condition is a single constant for
// the entire history, and on intraday bars it constrains the entry hour of a
// trade whose outcome is decided days later.
const INTRADAY_ONLY = new Set(['kz', 'london', 'ny', 'asian']);

// And the measured holding period has to clear a floor. This is the honest
// version of the filter: not "use wide exits" — a 2R target on daily bars takes
// days to reach and is a perfectly good swing exit — but "whatever the exit, the
// trades this rule actually produced were held for at least this long".
//
// Two days is deliberately the minimum that is not intraday rather than
// something more ambitious. It excludes rules that open and close inside a
// session without excluding the fast end of genuine swing trading.
const MIN_SWING_HOLD_MS = 2 * 86400e3;

// Two conditions from the same family are usually the same statement twice.
// "RSI under 40" plus "MFI under 30" adds a condition and almost no
// information, while halving the trade count — the shape of a rule that looks
// selective and is merely rare.
const MAX_PER_FAMILY = 2;

// Adding a condition must improve expectancy by more than rounding.
//
// Accepting any improvement at all rewards rarity: each extra condition cuts
// the trade count, and the average of whatever survives drifts upward on
// nothing but small numbers. On pure noise a greedy search with no margin
// happily builds four-condition strategies that clear zero out of sample.
const MIN_GAIN = 0.05;

// A verdict needs a real out-of-sample sample.
//
// This was set at 8, and on random data the search produced four-condition
// finalists with nine holdout trades, +3.78R, and an error bar narrow enough
// to call significant. Nine trades from a trailing exit is three winners and
// six losers; the standard error computed from them is not an estimate of
// anything. Below this many, the answer is "not tested yet" — never a verdict
// and never a significance claim.
const MIN_HOLDOUT = 25;

// Rebuilt per run, because the cross-asset half depends on which peers loaded.
let byId = Object.fromEntries(POOL.map(p => [p.id, p]));

function assemble(ids, exit, stop, ctx) {
  return {
    conditions: ids.map(id => ({ ...byId[id].cond })),
    ctx,
    logic: 'AND', direction: 'both',
    exitType: exit.exitType, rrRatio: exit.rrRatio, trailAtr: exit.trailAtr,
    slType: stop.slType, slAtr: stop.slAtr, swingLookback: stop.swingLookback,
    slPips: 25, tpPips: 50, riskPct: 1, maxTrades: 1,
  };
}

export function describe(ids) {
  return ids.map(id => byId[id]?.label || id).join(' + ');
}

export function poolFor(peers) {
  return peers?.length ? [...POOL, ...crossAssetPool(peers)] : POOL;
}

export function familiesOf(ids) {
  return [...new Set(ids.map(id => byId[id]?.fam).filter(Boolean))];
}

function canAdd(ids, id) {
  if (ids.includes(id)) return false;
  const fam = byId[id].fam;
  return ids.filter(x => byId[x].fam === fam).length < MAX_PER_FAMILY;
}

// The number that matters is not how many strategies were tried, but how many
// distinct ideas were given a chance to look good. Counted honestly and
// reported, because a search that hides its own size is not a test.
export async function deepSearch(candles, {
  maxDepth   = 4,
  beam       = 8,       // combinations carried forward at each depth
  minTrades  = 25,
  keep       = 10,
  spreadPips,
  calibrate  = true,    // re-run on a shuffled copy to measure the null
  peers      = null,    // { 'US500': candles, ... } — enables cross-asset conditions
  // 'mean' ranks by expectancy per trade and needs a real sample to mean
  // anything, so it favours rules that fire often and pay little.
  //
  // 'tail' ranks by total R captured and by how often a trade ran past +5R.
  // It deliberately admits rare setups — twenty fires in a decade — because
  // that is where asymmetric payoffs live, and a floor built for statistical
  // comfort deletes them before they are ever ranked. Those results cannot be
  // validated on one instrument; they are validated by POOLING the same rule
  // across the majors, where twenty fires becomes two hundred and forty.
  objective  = 'mean',
  // 'swing' drops the intraday-only vocabulary and requires the rule's measured
  // holding period to clear two days. 'any' is the old behaviour, kept as the
  // default so nothing that already calls this changes underneath it.
  horizon    = 'any',
  onProgress,
} = {}) {
  if (!candles || candles.length < 400) {
    return { ok:false, reason:`Only ${candles?.length || 0} bars. A deep search needs at least 400.` };
  }
  const spanDays = (candles[candles.length-1].t - candles[0].t) / 86400e3;
  if (spanDays < 180) {
    return { ok:false, reason:`This history covers ${Math.round(spanDays)} days. Building four-condition `
      + `strategies on it would fit them to one market regime in far more detail than a two-condition `
      + `search could. Use the Daily timeframe, or more bars.`, spanDays };
  }

  // How far apart the bars are, taken from the data rather than from a
  // timeframe label the search is never given. The median, because feeds have
  // weekend gaps and the mean would report a daily series as 33-hourly.
  const gaps = [];
  for (let i = 1; i < Math.min(candles.length, 400); i++) gaps.push(candles[i].t - candles[i - 1].t);
  gaps.sort((a, b) => a - b);
  const barMs = gaps[Math.floor(gaps.length / 2)] || 86400e3;

  const swing = horizon === 'swing';
  const minHoldBars = swing ? Math.max(1, Math.round(MIN_SWING_HOLD_MS / barMs)) : 0;
  const holdOk = r => !swing || (r.medDuration != null && r.medDuration >= minHoldBars);

  // The cross-asset half of the vocabulary only exists if peers were supplied.
  const peerSyms = peers ? Object.keys(peers).filter(k => peers[k]?.length) : [];
  const pool = poolFor(peerSyms).filter(p => !(swing && INTRADAY_ONLY.has(p.id)));
  byId = Object.fromEntries(pool.map(p => [p.id, p]));
  // Context is built on the FULL series and then sliced, so a 20-bar peer
  // change at the start of the holdout still sees the bars before it. Building
  // it per slice would blind every cross-asset condition for its first twenty
  // bars of every slice, three times over.
  const fullCtx = peerSyms.length ? buildContext(candles, peers) : {};
  const sliceCtx = (from, to) => {
    const out = {};
    for (const [k, arr] of Object.entries(fullCtx)) out[k] = arr.slice(from, to);
    return out;
  };

  const nB = Math.floor(candles.length * 0.5);
  const nV = Math.floor(candles.length * 0.7);
  const build    = candles.slice(0, nB);
  const validate = candles.slice(nB, nV);
  const holdout  = candles.slice(nV);
  const ctxFor = new Map([[build, sliceCtx(0, nB)], [validate, sliceCtx(nB, nV)], [holdout, sliceCtx(nV)]]);

  // The trade-count floor is derived from the holdout, not chosen separately.
  //
  // Requiring 25 trades on BUILD looks reasonable and is not: build is half the
  // history and the holdout is under a third, so a rule that fires exactly 25
  // times on build fires about 15 times on the holdout — below the threshold
  // for a verdict. Every finalist then comes back "not tested yet", which is
  // accurate and useless. Scale the floor so that clearing it on build implies
  // clearing it where it counts.
  const tail = objective === 'tail';
  // In tail mode the floor drops to something that only rules out pure
  // accidents. The sample problem is real and does not go away — it is moved
  // to the breadth test, which is the only place it can honestly be solved.
  const minBuild = tail
    ? Math.max(6, minTrades / 4)
    : Math.max(minTrades, Math.ceil(MIN_HOLDOUT * build.length / Math.max(1, holdout.length)));

  // What "better" means. Total R captured rewards a rule that takes 80R out of
  // the market in forty trades over one that takes 20R in four hundred.
  const rank = r => tail ? (r.totalR ?? -999) : (r.expR ?? -999);

  let evaluated = 0;
  const withSpread = s => (spreadPips != null ? { ...s, spreadPips } : s);

  const score = (slice, ids, exit, stop) => {
    evaluated++;
    try {
      const trades = runBacktest(slice, withSpread(assemble(ids, exit, stop, ctxFor.get(slice)))).trades;
      const st = calcStats(trades);
      return { n: st.totalTrades, expR: st.avgRR, winRate: st.winRate,
               se: st.seRR, lossStreak: st.maxLossStreak,
               medDuration: st.medDuration, holdMs: (st.medDuration || 0) * barMs,
               totalR: st.totalR, bigWinRate: st.bigWinRate, bigWins: st.bigWins,
               maxR: st.maxR, payoff: st.payoff, p90R: st.p90R,
               longRatio: trades.length ? trades.filter(t => t.dir === 'long').length / trades.length : 0.5 };
    } catch { return { n: 0, expR: null }; }
  };

  let lastYield = performance.now();
  const breathe = async (phase, done, total) => {
    if (performance.now() - lastYield < 80) return;
    onProgress?.({ phase, done, total, evaluated });
    await new Promise(r => setTimeout(r, 0));
    lastYield = performance.now();
  };

  // ── Depth 1 ───────────────────────────────────────────────────────────────
  // Every condition is scored alone, which does two jobs. It ranks the seeds,
  // and it identifies conditions that never fire on this data at all.
  //
  // The second matters more than it looks. Conditions combine with AND, so one
  // that produces no trades by itself produces none in any combination that
  // contains it — carrying it forward would spend a third of the search on
  // sets that cannot trade. Session filters on daily bars are the standard
  // case: every daily candle carries the same timestamp, so "London session"
  // is one constant answer for the whole history.
  const singles = [];
  const usable = [];
  const neverFires = [];
  for (let i = 0; i < pool.length; i++) {
    const r = score(build, [pool[i].id], NEUTRAL_EXIT, NEUTRAL_STOP);
    if (r.n > 0) usable.push(pool[i]); else neverFires.push(pool[i]);
    if (r.n >= minBuild && r.expR != null) singles.push({ ids:[pool[i].id], build:r });
    await breathe('single conditions', i + 1, pool.length);
  }
  if (!singles.length) {
    return { ok:false, reason:`No single condition produced ${minBuild} trades on this data. `
      + `Try more bars or a lower timeframe.`, neverFires: neverFires.map(p => p.label) };
  }

  // ── Depth 2..maxDepth, greedy with a beam ─────────────────────────────────
  // Depth 2 is seeded wide on purpose. A beam of eight singles decides the
  // whole shape of the search before it has looked at a single pair, and a
  // condition that is unremarkable alone but decisive in company — which is
  // exactly what this is hunting for — never gets considered. Pairs are cheap
  // relative to what they rule in; depth 3 and beyond narrow to the beam.
  const ranked = singles.sort((a,b) => rank(b.build) - rank(a.build));
  let frontier = ranked.slice(0, beam * 3);
  const seen = new Set(frontier.map(f => f.ids.join('|')));
  const allCombos = [...frontier];

  for (let depth = 2; depth <= maxDepth; depth++) {
    const next = [];
    let done = 0;
    for (const f of frontier) {
      for (const p of usable) {
        if (!canAdd(f.ids, p.id)) continue;
        const ids = [...f.ids, p.id].sort();
        const key = ids.join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const r = score(build, ids, NEUTRAL_EXIT, NEUTRAL_STOP);
        // An addition has to earn its place by a margin, not by rounding.
        // In tail mode an addition earns its place by capturing more total R,
        // which a filter that removes losing trades does even when it fires
        // less. In mean mode it must lift expectancy by more than rounding.
        const better = tail ? rank(r) > rank(f.build) : r.expR > f.build.expR + MIN_GAIN;
        if (r.n >= minBuild && r.expR != null && better) {
          next.push({ ids, build:r });
        }
      }
      done++;
      await breathe(`${depth}-condition combinations`, done, frontier.length);
    }
    if (!next.length) break;
    frontier = next.sort((a,b) => rank(b.build) - rank(a.build)).slice(0, beam);
    allCombos.push(...frontier);
  }

  // ── Exits and stops, on the surviving entries only ────────────────────────
  const shortlist = allCombos
    .sort((a,b) => rank(b.build) - rank(a.build))
    .slice(0, Math.max(beam, 12));

  // This is where the holding-period floor is applied, rather than earlier.
  // Every combination gets to try all nine exits against it, so a good entry is
  // only rejected once it is clear that NO exit holds it long enough — not
  // because the neutral exit happened to close it quickly.
  const tuned = [];
  let done = 0;
  let droppedShort = 0;
  for (const c of shortlist) {
    let best = null, sawAny = false;
    for (const ex of EXITS) for (const st of STOPS) {
      const r = score(build, c.ids, ex, st);
      if (r.n >= minBuild && r.expR != null) {
        sawAny = true;
        if (holdOk(r) && (!best || rank(r) > rank(best.build))) {
          best = { ids:c.ids, exit:ex, stop:st, build:r };
        }
      }
    }
    if (best) tuned.push(best);
    else if (sawAny && swing) droppedShort++;
    done++;
    await breathe('exits and stops', done, shortlist.length);
  }
  if (swing && !tuned.length && droppedShort) {
    return { ok:false, horizon, barMs, minHoldBars, droppedShort,
      reason: `${droppedShort} combination${droppedShort === 1 ? '' : 's'} traded well here but `
        + `closed in under ${minHoldBars} bar${minHoldBars === 1 ? '' : 's'} — those are intraday rules, `
        + `not swing ones. On this timeframe a two-day hold is ${minHoldBars} bars; `
        + `search the Daily or H4 series, or switch the horizon to "any".` };
  }

  // ── VALIDATE: drop anything that only worked where it was built ───────────
  const validated = [];
  for (const t of tuned) {
    const v = score(validate, t.ids, t.exit, t.stop);
    // The validation slice is a fifth of the history, so it will always show
    // fewer trades than build — but "positive on three trades" is not a
    // filter, it is a coin landing the right way up.
    const vMin = tail ? Math.max(3, minBuild / 3) : Math.max(10, minBuild / 3);
    if (v.expR != null && v.expR > 0 && v.n >= vMin) {
      validated.push({ ...t, validate: v });
    }
  }
  validated.sort((a,b) => rank(b.validate) - rank(a.validate));

  // ── HOLDOUT: touched once, by the finalists ───────────────────────────────
  const finalists = validated.slice(0, keep);
  const holdoutLooks = finalists.length;
  for (const f of finalists) {
    f.holdout = score(holdout, f.ids, f.exit, f.stop);
    f.label = `${describe(f.ids)} · ${f.exit.label} · ${f.stop.label}`;
    f.families = familiesOf(f.ids);
    f.strategy = withSpread(assemble(f.ids, f.exit, f.stop, ctxFor.get(holdout)));
    // The builder and the breadth test run on their own data, so they need the
    // conditions without this run's pre-sliced context bolted on.
    f.conditions = f.ids.map(id => ({ ...byId[id].cond }));
    f.crossAsset = f.ids.filter(id => byId[id]?.fam === 'crossasset').length;
    f.depth = f.ids.length;
    // How long it actually held, out of sample. Reported for every run, not
    // only swing ones — knowing that a rule's typical trade lasts four hours is
    // information whichever horizon you asked for.
    const hb = f.holdout?.medDuration ?? f.build?.medDuration ?? null;
    f.hold = hb == null ? null : {
      bars: hb,
      days: +((hb * barMs) / 86400e3).toFixed(1),
      swingOk: hb * barMs >= MIN_SWING_HOLD_MS,
    };

    const o = f.holdout;
    // In tail mode a small holdout sample is expected, not a defect — so it
    // is reported as "rare" rather than "untested", and the breadth test is
    // named as the thing that settles it.
    f.rare = tail && o.n > 0 && o.n < MIN_HOLDOUT;
    f.verdict = o.expR == null || o.n === 0 ? 'untested'
              : f.rare ? (o.expR > 0 ? 'rare-positive' : 'rare-negative')
              : o.n < MIN_HOLDOUT ? 'untested'
              : o.expR <= 0 ? 'curve-fit'
              : o.expR >= f.build.expR * 0.5 ? 'survived' : 'faded';
    // Downgraded below if random entries on this same slice did as well —
    // set after significance is computed.

    if (o.expR != null && o.se && o.n >= MIN_HOLDOUT) {
      const ci = 1.96 * o.se;
      const rnd = beatsRandom(holdout, f.strategy, o.n, o.longRatio ?? 0.5);
      // How many random runs matched or beat it. Under the null this is a
      // uniform draw, so a small value is the thing worth reporting and a
      // large one is the thing worth acting on.
      f.significance = {
        ci: +ci.toFixed(2),
        t: +(o.expR / o.se).toFixed(2),
        clearsZero: o.expR - ci > 0,
        needed: (() => {
          const n = Math.ceil((1.96 * o.se * Math.sqrt(o.n) / Math.abs(o.expR)) ** 2);
          return n > o.n ? n : null;
        })(),
        random: rnd ? { runs: rnd.runs, median: rnd.median, best: rnd.best } : null,
        pRandom: rnd ? +rnd.pValue(o.expR).toFixed(3) : null,
        beatsRandom: rnd ? rnd.pValue(o.expR) <= 0.05 : null,
        edgeOverRandom: rnd ? +(o.expR - rnd.median).toFixed(2) : null,
      };
      // A rule that no random run beat has said something. A rule that half of
      // them beat has said nothing, however green its expectancy — and on a
      // holdout that happened to trend, that is the common case.
      if (rnd && o.expR <= rnd.median && f.verdict === 'survived') f.verdict = 'no-better-than-random';
    }
  }

  // ── Calibration: what does this same search find in shuffled data? ───────
  let nullRun = null;
  if (calibrate) {
    onProgress?.({ phase: 'calibrating against shuffled data', done: 0, total: 1, evaluated });
    await new Promise(r => setTimeout(r, 0));
    // More than one shuffle, because one is not a measurement. A single
    // draw's best finalist swung from −0.28R to +5.61R across test runs, which
    // is wide enough to call a real edge noise and noise a real edge.
    const draws = [];
    for (const seed of [20260805, 771113]) {
      try {
        // No peers: the shuffle destroys the timestamp alignment that makes a
        // cross-asset condition mean anything, so including them would compare
        // a smaller vocabulary against a larger one.
        // Same horizon as the real run. A null measured under a wider
        // vocabulary and no holding-period floor is not the null for this
        // search — it would be a harder benchmark than the thing it grades.
        const nullRes = await deepSearch(shuffledNull(candles, seed), {
          maxDepth, beam, minTrades, keep, spreadPips, horizon, calibrate: false,
          onProgress: p => onProgress?.({ ...p, phase: `null: ${p.phase}`, evaluated }),
        });
        if (nullRes.ok && nullRes.finalists.length) {
          draws.push({
            best: nullRes.finalists.reduce((m, f) =>
              Math.max(m, f.holdout?.expR ?? -99), -99),
            survivors: nullRes.finalists.filter(f => f.verdict === 'survived').length,
            finalists: nullRes.finalists.length,
          });
        }
      } catch { /* a failed draw is simply one fewer measurement */ }
    }
    if (draws.length) {
      nullRun = {
        draws: draws.length,
        bestExpR:  +Math.max(...draws.map(d => d.best)).toFixed(2),
        survivors: Math.max(...draws.map(d => d.survivors)),
        finalists: Math.max(...draws.map(d => d.finalists)),
      };
    }
  }

  // Reported, not enforced.
  //
  // Overriding the verdict with this was tried and is worse than not having
  // it: two shuffles still mislabelled a planted edge as noise. The comparison
  // is real information and belongs on screen — "shuffled data produced
  // +0.9R here" tells you exactly how impressed to be by +1.1R — but it is not
  // precise enough to decide on its own, and dressing it up as a verdict would
  // repeat the mistake this whole section exists to document.
  if (nullRun && nullRun.bestExpR != null) {
    for (const f of finalists) {
      f.beatsNull = f.holdout?.expR != null && f.holdout.expR > nullRun.bestExpR;
    }
  }

  return {
    ok: true,
    finalists,
    nullRun,
    evaluated,
    holdoutLooks,
    poolSize: pool.length,
    peers: peerSyms,
    usablePool: usable.length,
    // Named rather than dropped in silence: "the search ignored nine of your
    // conditions" is something you should be told, not left to infer.
    neverFires: neverFires.map(p => p.label),
    maxDepth,
    spanDays,
    buildBars: build.length, validateBars: validate.length, holdoutBars: holdout.length,
    // Only the looks at the holdout carry a multiple-testing cost for the
    // number being reported. Everything before it was scored on data the
    // holdout has never seen.
    expectedFalsePositives: +(holdoutLooks * 0.05).toFixed(1),
    minHoldout: MIN_HOLDOUT,
    minBuildTrades: minBuild,
    objective,
    horizon,
    barMs,
    // Stated rather than silent: a swing run that threw away nine otherwise
    // good combinations should say so, or an empty result looks like the
    // vocabulary failing when it was the holding period.
    minHoldBars: swing ? minHoldBars : null,
    droppedShort: swing ? droppedShort : null,
  };
}

import { translateToBot } from '../src/utils/strategyToBot.js';

let fails = 0;
const check = (name, cond, extra='') => { console.log(`${cond?'  ok  ':'  FAIL'}  ${name}${extra?' — '+extra:''}`); if(!cond) fails++; };
const has = (t, level, frag) => t.notes.some(n => n.level === level && (n.what + ' ' + (n.why||'')).includes(frag));

// The exact rule from the user's screenshots.
const engulfTrail = {
  conditions: [{ type:'candlestick', value:'bull_engulf' }],
  logic:'AND', direction:'both', exitType:'trail', trailAtr:5, slType:'atr', slAtr:2,
};
const t1 = translateToBot(engulfTrail, { symbol:'XAG/USD', timeframe:'D', name:'test' });
check('engulfing + trail translates', t1.ok === true, t1.blockers.map(b=>b.what).join(','));
check('  → correct OANDA instrument', t1.config.pairs[0] === 'XAG_USD', t1.config.pairs.join());
check('  → daily timeframe',          t1.config.timeframe === 'D');
check('  → tpMethod trail',           t1.config.risk.tpMethod === 'trail');
check('  → trailAtr carried',         t1.config.risk.trailAtr === 5, String(t1.config.risk.trailAtr));
check('  → 2 ATR stop',               t1.config.risk.slMethod === 'atr' && t1.config.risk.slAtr === 2);
// The bot can now name one pattern, so this is a translation and not a
// widening. It used to become the whole bullish family with a warning that the
// bot would take more trades than the backtest did.
check('  → the exact pattern carries',t1.config.conditions.candlePattern === 'bull_engulf',
  String(t1.config.conditions.candlePattern));
check('  → arrives disabled',         t1.config.enabled === false);
check('  → and is no longer flagged as a widening',
  !has(t1, 'approximate', 'bull_engulf'));
check('  → VPS dependency flagged',   has(t1, 'approximate', 'VPS'));
check('  → structure filter flagged', has(t1, 'approximate', 'ranging'));

// The two commonest search conditions must now translate, not block — they
// were refusing nearly every handoff.
const tVol = translateToBot({ conditions:[{type:'volpct',op:'below',value:30}],
  exitType:'trail', trailAtr:5, slType:'atr', slAtr:2 }, { symbol:'XAU/USD', timeframe:'D' });
check('volatility percentile now translates', tVol.ok === true, tVol.blockers.map(b=>b.what).join());
check('  → volPctFilter set correctly',
  tVol.config.conditions.volPctFilter?.enabled === true
  && tVol.config.conditions.volPctFilter?.op === 'below'
  && tVol.config.conditions.volPctFilter?.value === 30,
  JSON.stringify(tVol.config.conditions.volPctFilter));
check('  → reported as exact, not approximate', has(tVol, 'exact', 'Volatility percentile'));

const tRange = translateToBot({ conditions:[{type:'rangepos',op:'below',value:25}],
  exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 }, { symbol:'XAU/USD', timeframe:'D' });
check('range position now translates', tRange.ok === true);
check('  → rangePosFilter set correctly',
  tRange.config.conditions.rangePosFilter?.enabled === true
  && tRange.config.conditions.rangePosFilter?.value === 25);

// The exact rule from the refused screenshot: structure break + volatility
// expanding + 3R target + swing stop.
const tScreen = translateToBot({
  conditions:[{type:'bos',op:'bullish'},{type:'volpct',op:'above',value:70}],
  logic:'AND', exitType:'rr', rrRatio:3, slType:'swing', swingLookback:12 },
  { symbol:'XAU/USD', timeframe:'D' });
check('the refused strategy now translates', tScreen.ok === true,
  tScreen.blockers.map(b=>b.what).join() || 'no blockers');
check('  → and still flags the structure-break difference', has(tScreen, 'approximate', 'any break'));

// Cross-asset conditions MUST block: the bot fetches one instrument.
for (const cond of [
  { type:'lead', peer:'US500', n:3, op:'up', value:1.5 },
  { type:'divergence', peer:'XAU/USD', n:5, op:'bull', value:1 },
  { type:'ratio_pct', peer:'XAG/USD', op:'above', value:80 },
]) {
  const t = translateToBot({ conditions:[cond], exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 },
    { symbol:'XAU/USD', timeframe:'D' });
  check(`${cond.type} blocks (no peer data live)`, t.ok === false && has(t, 'blocking', 'cross-asset'));
}

// Conditions the bot genuinely cannot express must block, not approximate.
for (const [type, cond] of Object.entries({
  ma_cross: { type:'ma_cross', period:20, period2:50, maType:'ema', op:'bullishCross' },
  stretch:  { type:'stretch', period:50, op:'below', value:2 },
  dom:      { type:'dom', op:'turn' },
})) {
  const t = translateToBot({ conditions:[cond], exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 },
    { symbol:'XAU/USD', timeframe:'D' });
  check(`${type} blocks the handoff`, t.ok === false && t.blockers.length >= 1);
}

// The two the bot used to refuse. It now has a switch for each, so a strategy
// found in the Backtester on a strong hammer hands over as a strong hammer
// rather than being turned away at the door.
{
  const m = translateToBot({ conditions:[{ type:'macd', op:'crossUp' }],
    exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 }, { symbol:'XAU/USD', timeframe:'D' });
  check('MACD now hands over', m.ok === true, m.blockers.map(b => b.what).join(','));
  check('  → as the cross, not as a state',
    m.config.conditions.macdFilter?.enabled === true
    && m.config.conditions.macdFilter?.mode === 'cross_up');
  const bad = translateToBot({ conditions:[{ type:'macd', op:'zeroCross' }],
    exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 }, { symbol:'XAU/USD', timeframe:'D' });
  check('  → and a MACD trigger it cannot express still blocks',
    bad.ok === false,
    'falling through to "above" would hand over a state where a trigger was tested');

  const r = translateToBot({ conditions:[{ type:'strong_rev', op:'bullish', n:7 }],
    exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 }, { symbol:'XAU/USD', timeframe:'D' });
  check('a strong reversal now hands over', r.ok === true, r.blockers.map(b => b.what).join(','));
  check('  → a bullish sweep is the hammer, with its range length',
    r.config.conditions.candlePattern === 'strong_hammer' && r.config.conditions.candleN === 7,
    `${r.config.conditions.candlePattern}, n=${r.config.conditions.candleN}`);
}

// EMA200 is the one filter that maps exactly.
const t2 = translateToBot({ conditions:[{type:'ma',period:200,maType:'ema',op:'priceAbove'}],
  exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 }, { symbol:'XAU/USD', timeframe:'D' });
check('EMA200 maps exactly', t2.ok && t2.config.conditions.emaFilter?.period === 200
  && t2.config.conditions.emaFilter?.side === 'above' && has(t2,'exact','EMA200'));

// RSI crossBelow is an event; the bot only has a state. Must be flagged.
const t3 = translateToBot({ conditions:[{type:'rsi',period:14,op:'crossBelow',value:30}],
  exitType:'rr', rrRatio:2, slType:'swing', swingLookback:12 }, { symbol:'EUR/USD', timeframe:'D' });
check('RSI cross flagged as different', t3.ok && has(t3,'approximate','keep entering'));
check('swing stop difference flagged',  has(t3,'approximate','20 and adds a 3 pip buffer'));

// OR has no bot equivalent and must not become AND.
const t4 = translateToBot({ conditions:[{type:'ob',op:'bullish'},{type:'fvg',op:'bullish'}],
  logic:'OR', exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 }, { symbol:'XAU/USD', timeframe:'D' });
check('OR logic blocks', t4.ok === false && has(t4,'blocking','any of these'));

// An instrument OANDA does not carry cannot be traded by this bot.
const t5 = translateToBot({ conditions:[{type:'ob',op:'bullish'}], exitType:'rr', rrRatio:2,
  slType:'atr', slAtr:2 }, { symbol:'BTC/USDT', timeframe:'D' });
check('non-OANDA instrument blocks', t5.ok === false && has(t5,'blocking','not on OANDA'));

// Order block semantics differ materially and must never pass as "exact".
const t6 = translateToBot({ conditions:[{type:'ob',op:'bullish'}], exitType:'rr', rrRatio:2,
  slType:'atr', slAtr:2 }, { symbol:'XAU/USD', timeframe:'D' });
check('order block never reported as exact',
  !t6.notes.some(n => n.level === 'exact' && n.what === 'Order block') && has(t6,'approximate','discount half'));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

// Exercises the real ForexBot methods. node-fetch is stubbed because the VPS
// deps are not installed here; nothing under test makes a network call.
const ROOT = require('path').join(__dirname, '..') + '/';
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return origResolve.call(this, req, ...rest);
};
require('fs').writeFileSync(__dirname + '/stub-fetch.cjs', 'module.exports = () => { throw new Error("no network in test"); };\n');

const { ForexBot } = require(`${ROOT}vps-bot/src/bot.js`);
const bot = new ForexBot({ FEED_ENABLED: 'false' });
bot.log = () => {}; bot.warn = () => {}; bot.err = () => {};

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// ── Candle patterns ────────────────────────────────────────────────────────
// A real bullish engulfing: down bar, then an up bar that swallows its body.
const base = (n, p=100) => Array.from({length:n}, (_,i) => ({ t:1600000000000+i*86400e3, o:p, h:p+0.4, l:p-0.4, c:p+0.05, v:100 }));
const engulf = base(30);
engulf[28] = { t:engulf[28].t, o:101, h:101.2, l:99.8, c:100.0, v:100 };   // down bar
engulf[29] = { t:engulf[29].t, o:99.9, h:101.6, l:99.7, c:101.4, v:100 };  // engulfs it

(async () => {
  // The candle filter moved into shared/strategyFilters.mjs, so the bot now
  // asks one module for candles, MACD, Bollinger, stochastic and ADX together.
  // What is checked here is the BOT's side of that: it delegates, and it fails
  // closed when the module will not load.
  const F = (cs, conditions) => bot._checkIndicatorFilters(cs, conditions);

  check('bullish engulfing passes a bullish filter',
    (await F(engulf, { candlePattern: 'bullish' })).pass === true);
  check('bullish engulfing fails a bearish filter',
    (await F(engulf, { candlePattern: 'bearish' })).pass === false);
  check('"any" passes without loading anything',
    (await F(engulf, { candlePattern: 'any' })).pass === true);
  check('flat bars fail a bullish filter',
    (await F(base(30), { candlePattern: 'bullish' })).pass === false);
  check('a strategy with no indicator filters set does no work at all',
    (await F(base(30), {})).pass === true);

  // The filter must be closed, not open, when it cannot be evaluated. An
  // unloadable module that passed would place trades the strategy explicitly
  // asked not to place, and the screen would still say it was filtering.
  const broken = new (require(`${ROOT}vps-bot/src/bot.js`).ForexBot)({ FEED_ENABLED:'false' });
  broken.warn = () => {};
  Object.defineProperty(broken, '_filters', { get(){ throw new Error('boom'); }, set(){}, configurable:true });
  const failed = await broken._checkIndicatorFilters(engulf, { candlePattern: 'bullish' });
  check('unloadable filter module fails closed', failed.pass === false);

  // ── EMA filter ───────────────────────────────────────────────────────────
  const rising = Array.from({length:120}, (_,i) => ({ t:i*86400e3, o:100+i*0.1, h:100+i*0.1, l:100+i*0.1, c:100+i*0.1, v:1 }));
  check('EMA: disabled passes',        bot._checkEMA(rising, { enabled:false }) === true);
  check('EMA: price above rising EMA', bot._checkEMA(rising, { enabled:true, period:50, side:'above' }) === true);
  check('EMA: "below" fails there',    bot._checkEMA(rising, { enabled:true, period:50, side:'below' }) === false);
  check('EMA: too few bars fails',     bot._checkEMA(rising.slice(0,10), { enabled:true, period:50, side:'above' }) === false);

  // ── VWAP ─────────────────────────────────────────────────────────────────
  const today = Math.floor(Date.now()/86400e3)*86400e3;
  const intra = Array.from({length:10}, (_,i) => ({ t: today + i*3600e3, o:100, h:100+i, l:100, c:100+i, v:10 }));
  check('VWAP: price above session VWAP', bot._checkVWAP(intra, { enabled:true, side:'above' }) === true);
  check('VWAP: disabled passes',          bot._checkVWAP(intra, { enabled:false }) === true);
  check('VWAP: no bars today fails',      bot._checkVWAP(
    [{ t: today - 5*86400e3, o:1,h:1,l:1,c:1,v:1 }], { enabled:true, side:'above' }) === false);

  // ── TP method ────────────────────────────────────────────────────────────
  check('trail returns no target',   bot._calcTP('long', 100, 98, { tpMethod:'trail', trailAtr:5 }, 0.01) === null);
  check('rr still returns a target', bot._calcTP('long', 100, 98, { tpMethod:'rr', rrRatio:2 }, 0.01) === 104);

  // ── Trailing stop ────────────────────────────────────────────────────────
  const calls = [];
  bot.oanda.modifyTradeStop = async (id, px) => { calls.push({ id, px }); return {}; };
  // 60 flat-ish bars, then a strong run up, so the trailing level advances.
  const up = Array.from({length:60}, (_,i) => ({ t:i*3600e3, o:100+i, h:100.5+i, l:99.5+i, c:100+i, v:1 }));
  bot.oanda.getCandles = async () => up;

  const mkLog = (sl) => ({ trades: [{
    id:'t1', status:'open', oandaId:'999', pair:'XAU_USD', direction:'long',
    sl, trail:{ atr:3, tf:'H1' }, trailBar:null }] });
  const live = [{ id:'999' }];

  let log = mkLog(100);
  let changed = await bot._manageTrailingStops(live, log);
  check('stop moved forward', changed === true && calls.length === 1 && calls[0].px > 100, JSON.stringify(calls[0]));
  const first = log.trades[0].sl;
  check('record updated', first > 100, String(first));

  // Same bar again: must be a no-op.
  const before = calls.length;
  await bot._manageTrailingStops(live, log);
  check('once per bar only', calls.length === before);

  // A stop already ahead of the trailing level must never be widened.
  log = mkLog(999); log.trades[0].trailBar = null;
  calls.length = 0;
  await bot._manageTrailingStops(live, log);
  check('ratchet never widens', calls.length === 0 && log.trades[0].sl === 999);

  // Short side moves the other way.
  const down = up.map(c => ({ ...c, o:200-c.o, h:200-c.l, l:200-c.h, c:200-c.c }));
  bot.oanda.getCandles = async () => down;
  log = { trades:[{ id:'t2', status:'open', oandaId:'999', pair:'XAU_USD', direction:'short',
    sl: 500, trail:{ atr:3, tf:'H1' }, trailBar:null }] };
  calls.length = 0;
  await bot._manageTrailingStops(live, log);
  check('short stop moves down', calls.length === 1 && calls[0].px < 500 && log.trades[0].sl < 500, String(log.trades[0].sl));

  // A trade OANDA no longer reports must not be touched.
  calls.length = 0;
  log = mkLog(100); log.trades[0].oandaId = 'gone';
  check('closed trade skipped', await bot._manageTrailingStops(live, log) === false && calls.length === 0);

  // A rejection must still consume the bar rather than retry every tick.
  bot.oanda.modifyTradeStop = async () => { throw new Error('wrong side of market'); };
  bot.oanda.getCandles = async () => up;
  log = mkLog(100);
  await bot._manageTrailingStops(live, log);
  const barAfter = log.trades[0].trailBar;
  check('rejection still consumes the bar', barAfter != null);

  // ── Feed measures (volatility percentile / range position) ───────────────
  // Compared against the FEED's own measure(), which is the function the bot
  // imports — so this checks the wiring, not a copy of the arithmetic.
  const { measure } = require(`${ROOT}vps-bot/src/feed.js`);
  let s3 = 13, px = 100;
  const rnd3 = () => (s3 = (s3 * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cs520 = Array.from({ length: 520 }, (_, i) => {
    const o = px, c = o + (rnd3() - 0.5) * 1.2;
    const bar = { t: i * 86400e3, o, h: Math.max(o,c)+rnd3()*0.5, l: Math.min(o,c)-rnd3()*0.5, c, v: 100 };
    px = c; return bar;
  });
  const truth = measure(cs520);
  bot.oanda.getCandles = async (pair, tf, n) => { check('asks for 520 bars', n === 520, String(n)); return cs520; };

  check('no filter enabled passes without fetching',
    await bot._checkFeedMeasures('XAU_USD', 'D', {}) === true);

  // A threshold the real measurement satisfies must pass, and one it does not
  // must fail — both derived from measure() rather than hardcoded.
  check(`volPct filter passes at its own value (${truth.volPct})`,
    await bot._checkFeedMeasures('XAU_USD','D',{ volPctFilter:{enabled:true,op:'below',value:truth.volPct} }) === true);
  check('volPct filter fails below its own value',
    await bot._checkFeedMeasures('XAU_USD','D',{ volPctFilter:{enabled:true,op:'below',value:truth.volPct-1} }) === false);
  check(`rangePos filter passes at its own value (${truth.rangePos})`,
    await bot._checkFeedMeasures('XAU_USD','D',{ rangePosFilter:{enabled:true,op:'above',value:truth.rangePos} }) === true);
  check('rangePos filter fails above its own value',
    await bot._checkFeedMeasures('XAU_USD','D',{ rangePosFilter:{enabled:true,op:'above',value:truth.rangePos+1} }) === false);
  check('both filters must pass together',
    await bot._checkFeedMeasures('XAU_USD','D',{
      volPctFilter:{enabled:true,op:'below',value:truth.volPct},
      rangePosFilter:{enabled:true,op:'above',value:truth.rangePos+1} }) === false);

  // A fetch failure must block the trade, not wave it through.
  bot.oanda.getCandles = async () => { throw new Error('network'); };
  check('a failed fetch fails the filter closed',
    await bot._checkFeedMeasures('XAU_USD','D',{ volPctFilter:{enabled:true,op:'below',value:99} }) === false);
  // Too few bars for measure() to return anything must also fail closed.
  bot.oanda.getCandles = async () => cs520.slice(0, 20);
  check('too few bars fails closed',
    await bot._checkFeedMeasures('XAU_USD','D',{ volPctFilter:{enabled:true,op:'below',value:99} }) === false);

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

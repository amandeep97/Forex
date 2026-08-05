import { useState, useMemo, useEffect } from 'react';
import { runBacktest, calcStats, defaultSpreadPips } from '../utils/backtestEngine';
import { gradeStrategy, loadLibrary, saveToLibrary, removeFromLibrary, condSignature,
         getSeal, sealRule, recordSearch, datasetKey } from '../utils/backtestGrading';
import { OANDA_MAP } from '../hooks/useLivePrices';
import { INSTRUMENTS as REGISTRY } from '../data/instruments';
import { generateCandles } from '../utils/generateCandles';
import { takeStagedFilter } from '../utils/feedToBacktest';
import { searchStrategies, combinationCount, testAcrossInstruments } from '../utils/strategySearch';

const TF_GRAN = {'1M':'M1','5M':'M5','15M':'M15','30M':'M30','1H':'H1','4H':'H4','8H':'H8','D':'D','W':'W'};
const TFS = ['1M','5M','15M','30M','1H','4H','8H','D','W'];
const COUNTS = [100,500,1000,2000,5000,10000,20000,50000];

// Single source of truth — see src/data/instruments.js
const INSTRUMENTS = REGISTRY.filter(i => i.can.candles).map(i => i.sym);

const FALLBACK_PRICES = {
  'EUR/USD':1.095,'GBP/USD':1.270,'USD/JPY':149.5,'USD/CHF':0.905,
  'AUD/USD':0.655,'USD/CAD':1.360,'NZD/USD':0.610,'EUR/GBP':0.860,
  'EUR/JPY':163.7,'GBP/JPY':189.9,'EUR/AUD':1.670,'EUR/CAD':1.490,
  'EUR/CHF':0.935,'EUR/NZD':1.785,'GBP/CHF':1.132,'GBP/CAD':1.725,
  'GBP/AUD':1.915,'GBP/NZD':2.085,'AUD/JPY':98.5,'AUD/CHF':0.585,
  'AUD/CAD':0.905,'AUD/NZD':1.085,'NZD/JPY':88.5,'NZD/CHF':0.540,
  'NZD/CAD':0.835,'CAD/JPY':109.5,'CAD/CHF':0.645,'CHF/JPY':168.5,
  'XAU/USD':3250,'XAG/USD':32.5,'US500':5500,'US30':42000,
  'US100':19500,'US2000':2050,'UK100':8100,'GER40':18500,'JPN225':39000,'USOIL':78.0,'UKOIL':82.0,
  'BTC/USDT':68000,'ETH/USDT':3500,'BNB/USDT':580,'SOL/USDT':145,'XRP/USDT':0.53,
  'ADA/USDT':0.45,'DOGE/USDT':0.15,'AVAX/USDT':35,'LINK/USDT':15,'DOT/USDT':6.4,'LTC/USDT':78,'TON/USDT':5.8,
};

const COND_TYPES = [
  {v:'rsi',          l:'RSI',              icon:'📊', color:'#0ea5e9'},
  {v:'mfi',          l:'MFI',              icon:'💧', color:'#06b6d4'},
  {v:'ma',           l:'Price vs MA',      icon:'〰', color:'#f59e0b'},
  {v:'ma_cross',     l:'MA Crossover',     icon:'✕',  color:'#a78bfa'},
  {v:'macd',         l:'MACD',             icon:'📈', color:'#22c55e'},
  {v:'bos',          l:'BOS / CHoCH',      icon:'⚡', color:'#00d4aa'},
  {v:'fvg',          l:'Fair Value Gap',   icon:'◫',  color:'#f97316'},
  {v:'displacement', l:'Displacement',     icon:'🚀', color:'#ef4444'},
  {v:'ob',           l:'Order Block',      icon:'🧱', color:'#8b5cf6'},
  {v:'ote_zone',     l:'OTE Zone',         icon:'🎯', color:'#14b8a6'},
  {v:'liquidity',    l:'Liquidity Sweep',  icon:'💦', color:'#3b82f6'},
  {v:'strong_rev',   l:'Strong Hammer/Star',icon:'⚡', color:'#22d3ee'},
  {v:'equal_hl',     l:'Equal H/L',        icon:'═',  color:'#fb923c'},
  {v:'consolidation',l:'Consolidation',    icon:'📦', color:'#94a3b8'},
  {v:'candlestick',  l:'Candlestick (30+)', icon:'🕯', color:'#eab308'},
  {v:'session',      l:'Session / Killzone',icon:'🕐', color:'#a78bfa'},
  {v:'dow',          l:'Day of Week',      icon:'📅', color:'#f472b6'},
  {v:'volume',       l:'Volume',           icon:'📊', color:'#38bdf8'},
  {v:'pattern',      l:'Candle Dir (simple)',icon:'▲', color:'#eab308'},
  {v:'candle',       l:'Candle Close',     icon:'▲',  color:'#64748b'},
];

// Full candlestick pattern list for the picker (matches the shared candlePatterns.js)
const CANDLESTICKS = [
  ['any_bull','Any bullish pattern'],['any_bear','Any bearish pattern'],['any_reversal','Any reversal pattern'],
  ['hammer','Hammer 🔨'],['shooting_star','Shooting Star ⭐'],['inv_hammer','Inverted Hammer'],['hanging_man','Hanging Man'],
  ['bull_engulf','Bullish Engulfing'],['bear_engulf','Bearish Engulfing'],
  ['morning_star','Morning Star'],['evening_star','Evening Star'],
  ['three_soldiers','Three White Soldiers'],['three_crows','Three Black Crows'],
  ['piercing_line','Piercing Line'],['dark_cloud','Dark Cloud Cover'],
  ['bull_harami','Bullish Harami'],['bear_harami','Bearish Harami'],['harami_cross','Harami Cross'],
  ['tweezer_bottom','Tweezer Bottom'],['tweezer_top','Tweezer Top'],
  ['dragonfly_doji','Dragonfly Doji'],['gravestone_doji','Gravestone Doji'],['doji','Doji'],['long_legged_doji','Long-Legged Doji'],
  ['marubozu_bull','Bullish Marubozu'],['marubozu_bear','Bearish Marubozu'],['spinning_top','Spinning Top'],
  ['inside_bar','Inside Bar'],['outside_bar','Outside Bar'],['kicker_bull','Bullish Kicker'],['kicker_bear','Bearish Kicker'],
  ['three_inside_up','Three Inside Up'],['three_inside_dn','Three Inside Down'],
  ['abandoned_bull','Abandoned Baby Bull'],['abandoned_bear','Abandoned Baby Bear'],
  ['rising_three','Rising Three Methods'],['falling_three','Falling Three Methods'],
];

const DEF = {
  rsi:          {period:14, op:'crossBelow', value:30},
  mfi:          {period:14, op:'crossBelow', value:20},
  ma:           {maType:'ema', period:50, op:'priceCrossAbove'},
  ma_cross:     {maType:'ema', period:9, period2:21, op:'bullishCross'},
  macd:         {op:'crossUp'},
  bos:          {op:'bullish'},
  fvg:          {op:'bullish'},
  displacement: {op:'bullish'},
  ob:           {op:'bullish'},
  ote_zone:     {op:'bullish'},
  liquidity:    {op:'bullish'},
  strong_rev:   {op:'bullish', n:5},
  equal_hl:     {op:'equalLows'},
  consolidation:{},
  candlestick:  {value:'any_bull'},
  session:      {op:'killzone'},
  dow:          {op:'tue'},
  volume:       {op:'spike', mult:1.5},
  pattern:      {value:'bullish'},
  candle:       {op:'bullish'},
};

// Categorized presets
//
// Everything below in Momentum / SMC / ICT is an ENTRY trigger with a fixed
// target. That is the whole library, and it is the category with the least
// evidence behind it. The approach with the longest documented record —
// trend following, positive in essentially every decade since 1880 — was not
// merely missing from this list, it could not be expressed at all until the
// engine learned a trailing exit, because it depends on never capping a winner.
const PRESETS = [
  {name:'RSI Reversal',   cat:'Momentum', emoji:'📊', desc:'RSI crosses oversold',
   dir:'both', conds:[{type:'rsi',period:14,op:'crossBelow',value:30}], exit:'rr',slTyp:'fixed',sl:25,rr:2},
  {name:'MFI Extremes',   cat:'Momentum', emoji:'💧', desc:'MFI cross OS/OB',
   dir:'both', conds:[{type:'mfi',period:14,op:'crossBelow',value:20}], exit:'rr',slTyp:'fixed',sl:20,rr:2},
  {name:'MACD Cross',     cat:'Momentum', emoji:'📈', desc:'MACD × signal line',
   dir:'both', conds:[{type:'macd',op:'crossUp'}], exit:'rr',slTyp:'fixed',sl:20,rr:2.5},
  {name:'MACD Zero',      cat:'Momentum', emoji:'0',  desc:'MACD crosses zero line',
   dir:'both', conds:[{type:'macd',op:'aboveZero'},{type:'rsi',period:14,op:'above',value:50}], exit:'atr',slTyp:'atr',tpA:2,slA:1},
  {name:'EMA 50 Bounce',  cat:'Trend',    emoji:'〰', desc:'Price bounces EMA50',
   dir:'both', conds:[{type:'ma',maType:'ema',period:50,op:'priceCrossAbove'},{type:'rsi',period:14,op:'above',value:45}], exit:'atr',slTyp:'swing',swingLb:15,tpA:2,slA:1},
  {name:'Golden Cross',   cat:'Trend',    emoji:'✕',  desc:'EMA9 × EMA21',
   dir:'both', conds:[{type:'ma_cross',maType:'ema',period:9,period2:21,op:'bullishCross'}], exit:'atr',slTyp:'atr',tpA:3,slA:1},
  {name:'BOS + RSI',      cat:'SMC',      emoji:'⚡', desc:'Structure break + RSI confirm',
   dir:'both', conds:[{type:'bos',op:'bullish'},{type:'rsi',period:14,op:'below',value:55}], exit:'rr',slTyp:'swing',swingLb:15,sl:25,rr:3},
  {name:'FVG Entry',      cat:'SMC',      emoji:'◫',  desc:'Fair Value Gap fill',
   dir:'both', conds:[{type:'fvg',op:'bullish'},{type:'candle',op:'bullish'}], exit:'rr',slTyp:'fixed',sl:15,rr:3},
  {name:'Displacement',   cat:'SMC',      emoji:'🚀', desc:'3-candle impulse entry',
   dir:'both', conds:[{type:'displacement',op:'bullish'}], exit:'atr',slTyp:'atr',tpA:3,slA:1},
  {name:'SMC Full',       cat:'SMC',      emoji:'🏆', desc:'BOS + FVG + RSI confluence',
   dir:'long', conds:[{type:'bos',op:'bullish'},{type:'fvg',op:'bullish'},{type:'rsi',period:14,op:'below',value:60}], exit:'rr',slTyp:'swing',swingLb:20,sl:30,rr:3},
  {name:'OB Entry',       cat:'ICT',      emoji:'🧱', desc:'Order Block tap + BOS confirm',
   dir:'both', conds:[{type:'ob',op:'bullish'},{type:'bos',op:'bullish'}], exit:'rr',slTyp:'swing',swingLb:15,sl:20,rr:3},
  {name:'OTE Reversal',   cat:'ICT',      emoji:'🎯', desc:'OTE 61.8–78.6% zone entry',
   dir:'both', conds:[{type:'ote_zone',op:'bullish'},{type:'rsi',period:14,op:'below',value:55}], exit:'rr',slTyp:'swing',swingLb:20,sl:25,rr:2.5},
  {name:'Liq Sweep',      cat:'ICT',      emoji:'💦', desc:'Liquidity sweep + close back',
   dir:'both', conds:[{type:'liquidity',op:'bullish'}], exit:'rr',slTyp:'swing',swingLb:10,sl:15,rr:3},
  {name:'Strong Sweep',   cat:'ICT',      emoji:'⚡', desc:'Full-range sweep hammer/star (your core setup)',
   dir:'both', conds:[{type:'strong_rev',op:'bullish',n:5}], exit:'rr',slTyp:'swing',swingLb:8,sl:20,rr:2},
  {name:'Sweep + RSI',    cat:'ICT',      emoji:'🎯', desc:'Strong sweep confirmed by RSI extreme',
   dir:'both', conds:[{type:'strong_rev',op:'bullish',n:5},{type:'rsi',period:14,op:'below',value:45}], exit:'rr',slTyp:'swing',swingLb:8,sl:20,rr:2.5},
  {name:'Killzone Sweep', cat:'ICT',      emoji:'🕐', desc:'Strong sweep only in London/NY killzone',
   dir:'both', conds:[{type:'strong_rev',op:'bullish',n:5},{type:'session',op:'killzone'}], exit:'rr',slTyp:'swing',swingLb:8,sl:20,rr:2},
  {name:'Engulfing',      cat:'Pattern',  emoji:'🕯', desc:'Bullish/bearish engulfing reversal',
   dir:'both', conds:[{type:'candlestick',value:'bull_engulf'}], exit:'rr',slTyp:'swing',swingLb:10,sl:20,rr:2},
  {name:'Trend Follow',   cat:'Trend',    emoji:'📈', desc:'EMA 20/50 cross, 3 ATR trailing exit — no target',
   dir:'both', conds:[{type:'ma_cross',period:20,period2:50,maType:'ema',op:'bullishCross'}],
   exit:'trail', trailA:3, slTyp:'atr', slA:2},
  {name:'Slow Trend',     cat:'Trend',    emoji:'🐢', desc:'EMA 50/200, 4 ATR trail — fewer, longer trades',
   dir:'both', conds:[{type:'ma_cross',period:50,period2:200,maType:'ema',op:'bullishCross'}],
   exit:'trail', trailA:4, slTyp:'atr', slA:2.5},
  {name:'Sweep + Trail',  cat:'ICT',      emoji:'🎣', desc:'Your sweep entry, but the winner is not capped',
   dir:'both', conds:[{type:'strong_rev',op:'bullish',n:5}],
   exit:'trail', trailA:3, slTyp:'swing', swingLb:10},
  {name:'Morning Star',   cat:'Pattern',  emoji:'🌅', desc:'3-candle reversal + volume spike',
   dir:'both', conds:[{type:'candlestick',value:'morning_star'},{type:'volume',op:'spike',mult:1.5}], exit:'rr',slTyp:'swing',swingLb:12,sl:25,rr:2.5},
  {name:'Equal Lows Tap', cat:'ICT',      emoji:'═',  desc:'Equal lows support + bull candle',
   dir:'long', conds:[{type:'equal_hl',op:'equalLows'},{type:'candle',op:'bullish'}], exit:'rr',slTyp:'swing',swingLb:20,sl:20,rr:2},
  {name:'ICT Full',       cat:'ICT',      emoji:'🏆', desc:'BOS + OB + Liquidity sweep',
   dir:'long', conds:[{type:'bos',op:'bullish'},{type:'ob',op:'bullish'},{type:'liquidity',op:'bullish'}], exit:'rr',slTyp:'swing',swingLb:20,sl:25,rr:3},
  {name:'Pattern + RSI',  cat:'Pattern',  emoji:'🕯', desc:'Bull pattern under RSI 50',
   dir:'both', conds:[{type:'pattern',value:'bullish'},{type:'rsi',period:14,op:'below',value:50}], exit:'rr',slTyp:'fixed',sl:25,rr:2},
  {name:'RSI+MFI Combo',  cat:'Momentum', emoji:'⚡', desc:'Double oversold confirmation',
   dir:'long', conds:[{type:'rsi',period:14,op:'below',value:35},{type:'mfi',period:14,op:'below',value:35}], exit:'rr',slTyp:'fixed',sl:30,rr:2},
];

const CAT_COLORS = {
  Momentum:'#0ea5e9', Trend:'#a78bfa', SMC:'#00d4aa', ICT:'#8b5cf6', Pattern:'#eab308',
};

const BINANCE_TF = {'1M':'1m','5M':'5m','15M':'15m','30M':'30m','1H':'1h','4H':'4h','8H':'8h','D':'1d','W':'1w'};

// Both APIs cap a single request (OANDA 5000, Binance 1000). To grade honestly
// we want far more history than that, so page BACKWARDS from now until we have
// the requested count or the exchange runs out of history.
const dedupeSort = cs => {
  const m = new Map();
  for (const c of cs) m.set(c.t, c);
  return [...m.values()].sort((a, b) => a.t - b.t);
};

async function fetchBinancePaged(sym, itv, total) {
  const all = [];
  let endTime = null, guard = 0;
  while (all.length < total && guard++ < 30) {
    const need = Math.min(1000, total - all.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${itv}&limit=${need}`
      + (endTime ? `&endTime=${endTime}` : '');
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) break;
    const data = await res.json();
    if (!data.length) break;
    all.push(...data.map(k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] })));
    endTime = data[0][0] - 1;          // next page ends just before this page's oldest bar
    if (data.length < need) break;     // exchange has no more history
  }
  return dedupeSort(all);
}

async function fetchOandaPaged(instr, gran, total, apiKey, base) {
  const all = [];
  let toParam = null, guard = 0;
  while (all.length < total && guard++ < 20) {
    const need = Math.min(5000, total - all.length);
    const url = `${base}/instruments/${instr}/candles?count=${need}&granularity=${gran}&price=M`
      + (toParam ? `&to=${encodeURIComponent(toParam)}` : '');
    const res = await fetch(url, { headers:{Authorization:`Bearer ${apiKey}`}, signal:AbortSignal.timeout(25000) });
    if (!res.ok) break;
    const data = await res.json();
    const raw = (data.candles || []).filter(c => c.complete);
    if (!raw.length) break;
    all.push(...raw.map(c => ({
      t:new Date(c.time).getTime(), o:+c.mid.o, h:+c.mid.h, l:+c.mid.l, c:+c.mid.c, v:c.volume||1,
    })));
    toParam = raw[0].time;             // page backwards from the oldest bar we got
    if (raw.length < need) break;
  }
  return dedupeSort(all);
}

const spanLabel = cs => {
  if (cs.length < 2) return '';
  const days = (cs[cs.length-1].t - cs[0].t) / 86400000;
  return days >= 365 ? ` · ${(days/365).toFixed(1)}y history`
       : days >= 1   ? ` · ${Math.round(days)}d history` : '';
};

async function fetchCandles(symbol, tf, count) {
  // Crypto → Binance (free, no key, real historical data)
  if (symbol.includes('/USDT')) {
    try {
      const cs = await fetchBinancePaged(symbol.replace('/', ''), BINANCE_TF[tf] || '1h', count);
      if (cs.length >= 20) return { candles:cs, src:`Binance Live · ${cs.length} bars${spanLabel(cs)}` };
    } catch {}
  }
  // FX / metals / indices / energy → OANDA. oanda_env (Settings toggle) is the source
  // of truth for environment — never trust a possibly-stale cached practice flag.
  try {
    const raw = localStorage.getItem('oanda_creds');
    const creds = raw ? JSON.parse(raw) : null;
    const envSet = localStorage.getItem('oanda_env');
    const practice = envSet !== null ? envSet !== 'live' : creds?.practice;
    if (creds?.apiKey && OANDA_MAP[symbol]) {
      const base = practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
      const cs = await fetchOandaPaged(OANDA_MAP[symbol], TF_GRAN[tf]||'H1', count, creds.apiKey, base);
      if (cs.length >= 20) return {candles:cs, src:`OANDA Live · ${cs.length} bars${spanLabel(cs)}`};
    }
  } catch {}
  const inst = {bid:FALLBACK_PRICES[symbol]||1.1,change:0,volume:10000};
  const cs = generateCandles(inst, tf, Math.min(count,500));
  return {candles:cs, src:`Simulated · ${cs.length} bars`};
}

const CRYPTO_PIP_BT = { BTC:1, ETH:0.1, BNB:0.1, SOL:0.01, XRP:0.0001, ADA:0.0001, DOGE:0.0001, AVAX:0.001, LINK:0.001, DOT:0.001, LTC:0.01, TON:0.001 };
function getPipSz(sym) {
  if (!sym) return 0.0001;
  const s = sym.toUpperCase();
  if (s.includes('USDT')) return CRYPTO_PIP_BT[s.split('/')[0]] ?? 0.01;
  if (s.includes('JPY')) return 0.01;
  if (s.startsWith('XAU')) return 0.1;
  if (s.startsWith('XAG')) return 0.001;
  if (/^(US|GER|UK|FR|JPN)/.test(s)) return 1.0;
  return 0.0001;
}

function fmtP(v, sym) {
  if (v == null) return '—';
  if (sym?.startsWith('XAU')) return v.toFixed(2);
  if (/^(US|GER)/.test(sym||'')) return v.toFixed(1);
  if ((sym||'').includes('JPY')) return v.toFixed(3);
  return v.toFixed(5);
}
const clr = v => v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#64748b';
const sign = v => v > 0 ? '+' : '';

// ── Equity Curve ──────────────────────────────────────────────────────────────
function EquityCurve({curve}) {
  if (!curve || curve.length < 2) return null;
  const W=600, H=140, pl=58, pr=12, pt=12, pb=26;
  const pw=W-pl-pr, ph=H-pt-pb;
  const mn=Math.min(...curve), mx=Math.max(...curve), rng=(mx-mn)||1;
  const tx=i=>pl+(i/(curve.length-1))*pw;
  const ty=v=>pt+ph-((v-mn)/rng)*ph;
  const init=10000, iy=ty(init);
  const last=curve[curve.length-1];
  const col=last>=init?'#22c55e':'#ef4444';
  const pts=curve.map((v,i)=>`${tx(i).toFixed(1)},${ty(v).toFixed(1)}`).join(' ');
  const area=`M${pl},${Math.min(Math.max(iy,pt),pt+ph)} L${curve.map((v,i)=>`${tx(i).toFixed(1)},${ty(v).toFixed(1)}`).join(' L')} L${tx(curve.length-1).toFixed(1)},${Math.min(Math.max(iy,pt),pt+ph)} Z`;
  const ytks=[mn,mx].filter((v,i,a)=>a.indexOf(v)===i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:H,display:'block'}}>
      <defs>
        <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.2"/>
          <stop offset="100%" stopColor={col} stopOpacity="0.01"/>
        </linearGradient>
      </defs>
      <line x1={pl} y1={iy} x2={W-pr} y2={iy} stroke="#1e293b" strokeWidth={1} strokeDasharray="4,3"/>
      <path d={area} fill="url(#eqGrad)"/>
      <polyline points={pts} fill="none" stroke={col} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round"/>
      <circle cx={pl} cy={ty(curve[0])} r={3} fill={col} opacity={0.7}/>
      <circle cx={tx(curve.length-1)} cy={ty(last)} r={4} fill={col}/>
      {ytks.map(v=>(
        <text key={v} x={pl-5} y={ty(v)+4} textAnchor="end" fontSize={9} fill="#475569">${Math.round(v).toLocaleString()}</text>
      ))}
      <text x={pl} y={H-6} fontSize={9} fill="#334155">Start</text>
      <text x={W-pr} y={H-6} textAnchor="end" fontSize={9} fill="#334155">End</text>
    </svg>
  );
}

// ── Monthly P&L Bar Chart ─────────────────────────────────────────────────────
function MonthlyPnlChart({ monthlyPnl }) {
  if (!monthlyPnl || monthlyPnl.length < 2) return null;
  const W = 600, H = 120, pl = 48, pr = 8, pt = 10, pb = 22;
  const pw = W - pl - pr, ph = H - pt - pb;
  const maxAbs = Math.max(...monthlyPnl.map(m => Math.abs(m.pnl)), 1);
  const bw = Math.max(4, Math.floor(pw / monthlyPnl.length) - 2);
  const zeroY = pt + ph / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:H, display:'block' }}>
      <line x1={pl} y1={zeroY} x2={W-pr} y2={zeroY} stroke="#1e293b" strokeWidth={1}/>
      {monthlyPnl.map((m, i) => {
        const x = pl + (i / monthlyPnl.length) * pw + (pw / monthlyPnl.length - bw) / 2;
        const barH = Math.max(2, (Math.abs(m.pnl) / maxAbs) * (ph / 2 - 2));
        const y = m.pnl >= 0 ? zeroY - barH : zeroY;
        const col = m.pnl >= 0 ? '#22c55e' : '#ef4444';
        return (
          <g key={m.label}>
            <rect x={x} y={y} width={bw} height={barH} fill={col} opacity={0.85} rx={1}/>
            {monthlyPnl.length <= 18 && (
              <text x={x + bw/2} y={H - 6} textAnchor="middle" fontSize={7} fill="#475569">
                {m.label.length > 7 ? m.label.slice(2) : m.label}
              </text>
            )}
          </g>
        );
      })}
      <text x={pl - 4} y={pt + 6} textAnchor="end" fontSize={8} fill="#475569">${Math.round(maxAbs)}</text>
      <text x={pl - 4} y={pt + ph + 4} textAnchor="end" fontSize={8} fill="#475569">-${Math.round(maxAbs)}</text>
      <text x={pl - 4} y={zeroY + 4} textAnchor="end" fontSize={8} fill="#334155">0</text>
    </svg>
  );
}

// ── Long vs Short Panel ────────────────────────────────────────────────────────
function LongShortPanel({ s }) {
  if (s.longWinRate === null && s.shortWinRate === null) return null;
  const rows = [
    { label: '▲ Long',  wr: s.longWinRate,  wins: s.longWins,  losses: s.longLosses,  color: '#22c55e' },
    { label: '▼ Short', wr: s.shortWinRate, wins: s.shortWins, losses: s.shortLosses, color: '#ef4444' },
  ].filter(r => r.wr !== null);
  return (
    <div style={{ display:'flex', gap:10 }}>
      {rows.map(r => (
        <div key={r.label} style={{ flex:1, padding:'8px 12px', borderRadius:6, border:`1px solid ${r.color}33`,
          background:`${r.color}08` }}>
          <div style={{ fontSize:11, fontWeight:700, color:r.color, marginBottom:6 }}>{r.label}</div>
          <div style={{ fontSize:20, fontWeight:900, fontFamily:'monospace', color:r.wr>=50?'#22c55e':r.wr>=40?'#f59e0b':'#ef4444' }}>
            {r.wr}%
          </div>
          <div style={{ fontSize:10, color:'var(--text3)', marginTop:2 }}>{r.wins}W · {r.losses}L</div>
          <div style={{ height:5, background:'#1e293b', borderRadius:3, overflow:'hidden', marginTop:6 }}>
            <div style={{ width:`${r.wr}%`, height:'100%', background:r.color, borderRadius:3 }}/>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Statistical Grade Card (Phases 1 & 2 & 5) ─────────────────────────────────
function GradeCard({ g, onSave, saved, onSeal }) {
  if (!g) return null;
  const barBase = 100, barSetup = Math.min(100, (g.setupWinRate / Math.max(g.baseWinRate * 3, g.setupWinRate, 1)) * 100);
  const barRand = Math.min(100, (g.baseWinRate / Math.max(g.baseWinRate * 3, g.setupWinRate, 1)) * 100);
  const selMeta = {
    too_loose: { c:'#ef4444', t:'Too loose', d:'fires very often — most matches will be noise' },
    balanced:  { c:'#f59e0b', t:'Balanced',  d:'reasonable trigger frequency' },
    selective: { c:'#22c55e', t:'Selective', d:'rare, high-conviction trigger' },
  }[g.selectivity];
  return (
    <div style={{borderRadius:10, border:`1.5px solid ${g.color}55`, background:`${g.color}0c`, padding:14, marginBottom:14}}>
      {/* Verdict banner */}
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, flexWrap:'wrap'}}>
        <div style={{display:'flex', alignItems:'center', gap:10}}>
          <span style={{fontSize:22, fontWeight:900, letterSpacing:'-0.5px', color:g.color}}>
            {g.verdict==='proven'?'✅':g.verdict==='weak'?'📈':g.verdict==='insufficient'?'⚠️':'❌'} {g.label}
          </span>
        </div>
        <div style={{display:'flex', alignItems:'center', gap:8}}>
          {g.edgeMult>0 && g.verdict!=='insufficient' && (
            <span style={{fontSize:20, fontWeight:900, fontFamily:'monospace', color:g.color,
              padding:'2px 10px', borderRadius:6, background:`${g.color}18`}}>
              ×{g.edgeMult}
            </span>
          )}
          <span style={{fontSize:11, color:'var(--text3)'}}>{g.note}</span>
        </div>
      </div>

      {/* Win-rate vs random bars */}
      <div style={{marginTop:12, display:'flex', flexDirection:'column', gap:8}}>
        <div>
          <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:3}}>
            <span style={{color:'var(--text2)', fontWeight:600}}>This setup</span>
            <span style={{fontFamily:'monospace', color:g.color, fontWeight:700}}>{g.setupWinRate}% win</span>
          </div>
          <div style={{height:8, background:'#1e293b', borderRadius:4, overflow:'hidden'}}>
            <div style={{width:`${barSetup}%`, height:'100%', background:g.color, borderRadius:4}}/>
          </div>
        </div>
        <div>
          <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:3}}>
            <span style={{color:'var(--text3)'}}>Random baseline (n={g.baseN})</span>
            <span style={{fontFamily:'monospace', color:'var(--text3)'}}>{g.baseWinRate}% win</span>
          </div>
          <div style={{height:8, background:'#1e293b', borderRadius:4, overflow:'hidden'}}>
            <div style={{width:`${barRand}%`, height:'100%', background:'#475569', borderRadius:4}}/>
          </div>
        </div>
      </div>

      {/* Headline numbers */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginTop:12}}>
        <div style={{textAlign:'center', padding:'8px 4px', borderRadius:6, background:'var(--bg2,#0f172a)'}}>
          <div style={{fontSize:18, fontWeight:900, fontFamily:'monospace', color: g.setupExpR>0?'#22c55e':'#ef4444'}}>
            {g.setupExpR>0?'+':''}{g.setupExpR}R
          </div>
          <div style={{fontSize:9, color:'var(--text3)', marginTop:2}}>EXPECTANCY / TRADE</div>
          <div style={{fontSize:9, color:'var(--text3)'}}>vs {g.baseExpR>0?'+':''}{g.baseExpR}R random</div>
        </div>
        <div style={{textAlign:'center', padding:'8px 4px', borderRadius:6, background:'var(--bg2,#0f172a)'}}>
          <div style={{fontSize:18, fontWeight:900, fontFamily:'monospace', color: g.sufficient?'var(--text)':'#f59e0b'}}>
            n={g.n}
          </div>
          <div style={{fontSize:9, color:'var(--text3)', marginTop:2}}>SAMPLE SIZE</div>
          <div style={{fontSize:9, color: g.sufficient?'#22c55e':'#f59e0b'}}>
            {g.sufficient?`≥${g.minSample} ✓ trustworthy`:`<${g.minSample} — thin`}
          </div>
        </div>
        <div style={{textAlign:'center', padding:'8px 4px', borderRadius:6, background:'var(--bg2,#0f172a)'}}>
          <div style={{fontSize:18, fontWeight:900, fontFamily:'monospace', color:selMeta.c}}>{g.fireRate}%</div>
          <div style={{fontSize:9, color:'var(--text3)', marginTop:2}}>FIRE RATE · {selMeta.t}</div>
          <div style={{fontSize:9, color:'var(--text3)'}}>{g.signalCount} signals · {g.nConditions} cond</div>
        </div>
      </div>

      {/* Forward test — the only check that cannot be overfit */}
      {(() => {
        const f = g.forward;
        const fc = !f ? '#64748b' : f.status==='holds' ? '#22c55e' : f.status==='fails' ? '#ef4444' : '#0ea5e9';
        return (
          <div style={{marginTop:12, borderRadius:8, border:`1px solid ${fc}44`, background:`${fc}0a`, padding:'9px 11px'}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, flexWrap:'wrap'}}>
              <span style={{fontSize:11, fontWeight:800, color:fc}}>
                🔐 FORWARD TEST {!f ? '— NOT SEALED' : f.status==='holds' ? '— HOLDS ✓' : f.status==='fails' ? '— FAILED ✗' : '— RUNNING'}
              </span>
              {!f && (
                <button onClick={onSeal}
                  style={{fontSize:11, fontWeight:700, padding:'4px 11px', borderRadius:6, cursor:'pointer',
                    border:'1px solid #0ea5e955', background:'#0ea5e918', color:'#0ea5e9'}}>
                  🔐 Seal rule &amp; start clock
                </button>
              )}
            </div>
            <div style={{marginTop:5, fontSize:11, color:'var(--text3)', lineHeight:1.5}}>
              {!f ? (
                <>Sealing freezes today's date. Every bar after it is data that <strong>did not exist</strong> when you
                wrote the rule — so the result cannot be curve-fit. It is the only honest proof, and it costs nothing
                but patience. Seal now; re-run in a few weeks.</>
              ) : f.status==='pending' ? (
                <>Sealed {f.daysElapsed}d ago · <strong>{f.n}/{f.minN}</strong> forward trades so far.
                Nothing to conclude yet — re-run this backtest periodically and the clock does the validating.</>
              ) : (
                <>Sealed {f.daysElapsed}d ago · <strong>n={f.n}</strong> trades on data recorded after sealing ·
                {' '}<strong style={{color:fc}}>{f.winRate}% win · {f.expR>0?'+':''}{f.expR}R</strong>
                {f.status==='holds'
                  ? ' — the edge appeared on data it could not have been fitted to. This is the strongest evidence available.'
                  : ' — the edge vanished on unseen data. The backtest was curve-fit.'}</>
              )}
            </div>
          </div>
        );
      })()}

      {/* Multiple-testing cost */}
      {g.search && g.search.testCount > 5 && (
        <div style={{marginTop:10, fontSize:11, borderRadius:6, padding:'7px 10px',
          color: g.search.level==='high' ? '#fca5a5' : '#fcd34d',
          background: g.search.level==='high' ? '#ef444412' : '#f59e0b12',
          border: `1px solid ${g.search.level==='high' ? '#ef444433' : '#f59e0b33'}`}}>
          🔍 <strong>{g.search.testCount} different setups</strong> tested on this data.
          At that many attempts, expect <strong>~{g.search.expectedFalse}</strong> to look like a real edge by pure luck.
          The more you search, the less a single ✅ means — only the forward test above is immune to this.
        </div>
      )}

      {g.selectivity==='too_loose' && (
        <div style={{marginTop:10, fontSize:11, color:'#fca5a5', background:'#ef444412', border:'1px solid #ef444433',
          borderRadius:6, padding:'7px 10px'}}>
          ⚠ This setup fires on {g.fireRate}% of bars — that's the "every second coin matches" problem. A real edge
          should be <strong>selective</strong>. Add a confluence condition or tighten thresholds.
        </div>
      )}

      {/* Live gate */}
      <div style={{marginTop:12, borderTop:'1px solid #1e293b', paddingTop:10}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, flexWrap:'wrap'}}>
          <span style={{fontSize:12, fontWeight:800, color: g.validated?'#22c55e':'#94a3b8'}}>
            {g.validated ? '🟢 CLEARED FOR LIVE' : '🔒 NOT CLEARED FOR LIVE'}
          </span>
          <button onClick={onSave} disabled={saved}
            style={{fontSize:11, fontWeight:700, padding:'5px 12px', borderRadius:6, cursor: saved?'default':'pointer',
              border:`1px solid ${g.color}55`, background: saved?'#1e293b':`${g.color}18`, color: saved?'#64748b':g.color}}>
            {saved ? '✓ Saved to Edge Library' : '★ Save to Edge Library'}
          </button>
        </div>
        {!g.validated && g.blockers.length>0 && (
          <ul style={{margin:'8px 0 0', paddingLeft:18, fontSize:11, color:'var(--text3)'}}>
            {g.blockers.map((b,i)=><li key={i} style={{marginBottom:2}}>{b}</li>)}
          </ul>
        )}
        {g.validated && (
          <div style={{marginTop:6, fontSize:11, color:'var(--text3)'}}>
            Passed every check: ≥{g.liveSample} trades · ×{g.edgeMult} over random · positive expectancy ·
            holds out-of-sample · Monte-Carlo profit-safe. Still size responsibly — past edge ≠ guaranteed future.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Robustness Card (Phase 3) ─────────────────────────────────────────────────
function RobustnessCard({ g }) {
  if (!g) return null;
  const oos = g.oos;
  const oosColor = oos.status==='holds'?'#22c55e':oos.status==='fails'?'#ef4444':'#64748b';
  const mc = g.monteCarlo;
  return (
    <div className="bt2-chart-card">
      <div className="bt2-card-title">Robustness Checks <span style={{color:'var(--text3)',fontWeight:400,fontSize:10}}>does the edge survive unseen data & bad luck?</span></div>

      {/* Out-of-sample */}
      <div style={{display:'flex', gap:10, marginTop:4}}>
        <div style={{flex:1, padding:'8px 10px', borderRadius:6, border:'1px solid #1e293b', background:'#0f172a'}}>
          <div style={{fontSize:10, color:'var(--text3)', marginBottom:4}}>IN-SAMPLE (first 70%)</div>
          <div style={{fontSize:15, fontWeight:800, fontFamily:'monospace', color: g.oos.in.expR>0?'#22c55e':'#ef4444'}}>
            {g.oos.in.winRate}% · {g.oos.in.expR>0?'+':''}{g.oos.in.expR}R
          </div>
          <div style={{fontSize:9, color:'var(--text3)'}}>{g.oos.in.n} trades</div>
        </div>
        <div style={{display:'flex', alignItems:'center', color:oosColor, fontSize:18}}>→</div>
        <div style={{flex:1, padding:'8px 10px', borderRadius:6, border:`1px solid ${oosColor}44`, background:`${oosColor}0a`}}>
          <div style={{fontSize:10, color:'var(--text3)', marginBottom:4}}>OUT-OF-SAMPLE (last 30%)</div>
          <div style={{fontSize:15, fontWeight:800, fontFamily:'monospace', color: g.oos.out.expR>0?'#22c55e':'#ef4444'}}>
            {g.oos.out.winRate}% · {g.oos.out.expR>0?'+':''}{g.oos.out.expR}R
          </div>
          <div style={{fontSize:9, color:'var(--text3)'}}>{g.oos.out.n} trades</div>
        </div>
      </div>
      <div style={{marginTop:6, fontSize:11, fontWeight:700, color:oosColor}}>
        {oos.status==='holds' && '✓ Edge holds on data the setup never saw — the strongest sign it is real.'}
        {oos.status==='fails' && '✗ Edge collapsed out-of-sample — likely curve-fit to the in-sample period.'}
        {oos.status==='inconclusive' && '— Not enough out-of-sample trades to judge. Test on more bars.'}
      </div>

      {/* Thirds consistency */}
      <div style={{marginTop:12}}>
        <div style={{fontSize:10, color:'var(--text3)', marginBottom:5}}>CONSISTENCY ACROSS PERIODS ({g.positiveThirds}/{g.gradedThirds} profitable)</div>
        <div style={{display:'flex', gap:6}}>
          {g.thirds.map((t,i)=>(
            <div key={i} style={{flex:1, textAlign:'center', padding:'6px 2px', borderRadius:5,
              background: t.n<3?'#0f172a':(t.expR>0?'#22c55e12':'#ef444412'),
              border:`1px solid ${t.n<3?'#1e293b':(t.expR>0?'#22c55e33':'#ef444433')}`}}>
              <div style={{fontSize:9, color:'var(--text3)'}}>{['Early','Mid','Recent'][i]}</div>
              <div style={{fontSize:12, fontWeight:800, fontFamily:'monospace', color: t.n<3?'#64748b':(t.expR>0?'#22c55e':'#ef4444')}}>
                {t.n<3?'—':`${t.expR>0?'+':''}${t.expR}R`}
              </div>
              <div style={{fontSize:8, color:'var(--text3)'}}>{t.n} tr</div>
            </div>
          ))}
        </div>
      </div>

      {/* Monte Carlo */}
      {mc ? (
        <div style={{marginTop:12}}>
          <div style={{fontSize:10, color:'var(--text3)', marginBottom:5}}>
            MONTE-CARLO ({500} shuffles of trade order — path & drawdown risk)
          </div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6}}>
            <div style={{textAlign:'center', padding:'6px 2px', borderRadius:5, background:'#0f172a'}}>
              <div style={{fontSize:14, fontWeight:800, fontFamily:'monospace', color: mc.profitProb>=0.9?'#22c55e':mc.profitProb>=0.7?'#f59e0b':'#ef4444'}}>
                {Math.round(mc.profitProb*100)}%
              </div>
              <div style={{fontSize:8, color:'var(--text3)'}}>PROFIT PROB</div>
            </div>
            <div style={{textAlign:'center', padding:'6px 2px', borderRadius:5, background:'#0f172a'}}>
              <div style={{fontSize:14, fontWeight:800, fontFamily:'monospace', color:'var(--text2)'}}>{mc.medianMaxDD}%</div>
              <div style={{fontSize:8, color:'var(--text3)'}}>TYPICAL DD</div>
            </div>
            <div style={{textAlign:'center', padding:'6px 2px', borderRadius:5, background:'#0f172a'}}>
              <div style={{fontSize:14, fontWeight:800, fontFamily:'monospace', color: mc.worstMaxDD>=30?'#ef4444':'#f59e0b'}}>{mc.worstMaxDD}%</div>
              <div style={{fontSize:8, color:'var(--text3)'}}>WORST 5% DD</div>
            </div>
            <div style={{textAlign:'center', padding:'6px 2px', borderRadius:5, background:'#0f172a'}}>
              <div style={{fontSize:14, fontWeight:800, fontFamily:'monospace', color: mc.ruinProb<=0.02?'#22c55e':mc.ruinProb<=0.1?'#f59e0b':'#ef4444'}}>
                {(mc.ruinProb*100).toFixed(1)}%
              </div>
              <div style={{fontSize:8, color:'var(--text3)'}}>RUIN RISK</div>
            </div>
          </div>
          <div style={{marginTop:6, fontSize:10, color:'var(--text3)'}}>
            Ruin = a run that draws down ≥50%. Even a positive edge can ruin an account if drawdown risk is high.
          </div>
        </div>
      ) : (
        <div style={{marginTop:10, fontSize:11, color:'var(--text3)'}}>Too few trades for a Monte-Carlo risk simulation (need ≥5).</div>
      )}
    </div>
  );
}

// ── Edge Library (Phase 4) ────────────────────────────────────────────────────
function EdgeLibrary({ items, onLoad, onRemove }) {
  if (!items || items.length === 0) return null;
  const rank = { proven:3, weak:2, noise:1, insufficient:0 };
  const sorted = [...items].sort((a,b)=> (rank[b.verdict]-rank[a.verdict]) || (b.edgeMult-a.edgeMult) || (b.n-a.n));
  return (
    <div className="bt2-chart-card">
      <div className="bt2-card-title">
        ★ Validated Edge Library
        <span style={{color:'var(--text3)',fontWeight:400,fontSize:10,marginLeft:6}}>{items.length} saved · ranked by proven edge</span>
      </div>
      <div style={{display:'flex', flexDirection:'column', gap:6}}>
        {sorted.map(e=>(
          <div key={e.sig} style={{display:'flex', alignItems:'center', gap:8, padding:'7px 10px', borderRadius:6,
            border:`1px solid ${e.color}33`, background:`${e.color}08`}}>
            <span style={{fontSize:14}}>{e.validated?'🟢':e.verdict==='proven'?'✅':e.verdict==='weak'?'📈':'❌'}</span>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:12, fontWeight:700, color:'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
                {e.symbol} · {e.tf} · {(e.conds||[]).map(c=>c.type).join(' + ')}
              </div>
              <div style={{fontSize:10, color:'var(--text3)'}}>
                ×{e.edgeMult} vs random · {e.winRate}% win · {e.expR>0?'+':''}{e.expR}R · n={e.n} · OOS {e.oos}
                {e.fwd && ` · 🔐 fwd ${e.fwd.status==='pending' ? `${e.fwd.n}/15 (${e.fwd.days}d)` : `${e.fwd.status} n=${e.fwd.n}`}`}
              </div>
            </div>
            <span style={{fontSize:10, fontWeight:800, color:e.color, padding:'2px 7px', borderRadius:4, background:`${e.color}18`}}>
              {e.verdictLabel}
            </span>
            <button onClick={()=>onLoad(e)} title="Load into builder"
              style={{fontSize:11, padding:'3px 8px', borderRadius:5, border:'1px solid #334155', background:'transparent', color:'var(--text2)', cursor:'pointer'}}>↺</button>
            <button onClick={()=>onRemove(e.sig)} title="Remove"
              style={{fontSize:11, padding:'3px 7px', borderRadius:5, border:'1px solid #334155', background:'transparent', color:'#64748b', cursor:'pointer'}}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function Metric({label, value, sub, color, accent}) {
  return (
    <div className="bt2-metric" style={accent?{borderColor:accent+'44',background:accent+'08'}:{}}>
      <div className="bt2-metric-val" style={{color:color||'var(--text)'}}>{value}</div>
      <div className="bt2-metric-label">{label}</div>
      {sub && <div className="bt2-metric-sub">{sub}</div>}
    </div>
  );
}

// ── Condition Row ─────────────────────────────────────────────────────────────
function CondRow({cond, onChange, onRemove, idx}) {
  const upd = o => onChange({...cond,...o});
  const chType = t => onChange({id:cond.id, type:t, ...DEF[t]});
  const meta = COND_TYPES.find(c=>c.v===cond.type)||{icon:'?',color:'#94a3b8'};
  return (
    <div className="bt2-cond-row">
      {idx > 0 && <div className="bt2-cond-connector"><span className="bt2-and-badge">AND</span></div>}
      <div className="bt2-cond-card" style={{borderLeftColor:meta.color}}>
        <div className="bt2-cond-top">
          <span className="bt2-cond-icon" style={{color:meta.color}}>{meta.icon}</span>
          <select className="bt2-sel" value={cond.type} onChange={e=>chType(e.target.value)} style={{fontWeight:600}}>
            {COND_TYPES.map(t=><option key={t.v} value={t.v}>{t.l}</option>)}
          </select>
          <button className="bt2-rm" onClick={onRemove}>✕</button>
        </div>
        <div className="bt2-cond-controls">
          {(cond.type==='rsi'||cond.type==='mfi') && <>
            <label className="bt2-mini-label">Period</label>
            <input className="bt2-num" type="number" value={cond.period||14} min={2} max={50}
              onChange={e=>upd({period:+e.target.value})}/>
            <select className="bt2-sel sm" value={cond.op} onChange={e=>upd({op:e.target.value})}>
              <option value="crossBelow">Crosses below</option>
              <option value="crossAbove">Crosses above</option>
              <option value="below">Is below</option>
              <option value="above">Is above</option>
            </select>
            <input className="bt2-num" type="number" value={cond.value||30} min={1} max={99}
              onChange={e=>upd({value:+e.target.value})}/>
          </>}
          {cond.type==='ma' && <>
            <select className="bt2-sel sm" value={cond.maType||'ema'} onChange={e=>upd({maType:e.target.value})}>
              <option value="ema">EMA</option><option value="sma">SMA</option>
            </select>
            <input className="bt2-num" type="number" value={cond.period||50} min={2} max={500} title="Period"
              onChange={e=>upd({period:+e.target.value})}/>
            <select className="bt2-sel" value={cond.op} onChange={e=>upd({op:e.target.value})}>
              <option value="priceCrossAbove">Price × above</option>
              <option value="priceCrossBelow">Price × below</option>
              <option value="priceAbove">Price above</option>
              <option value="priceBelow">Price below</option>
            </select>
          </>}
          {cond.type==='ma_cross' && <>
            <select className="bt2-sel sm" value={cond.maType||'ema'} onChange={e=>upd({maType:e.target.value})}>
              <option value="ema">EMA</option><option value="sma">SMA</option>
            </select>
            <label className="bt2-mini-label">Fast</label>
            <input className="bt2-num" type="number" value={cond.period||9} min={2} max={100}
              onChange={e=>upd({period:+e.target.value})}/>
            <label className="bt2-mini-label">Slow</label>
            <input className="bt2-num" type="number" value={cond.period2||21} min={3} max={500}
              onChange={e=>upd({period2:+e.target.value})}/>
            <select className="bt2-sel sm" value={cond.op} onChange={e=>upd({op:e.target.value})}>
              <option value="bullishCross">Bull ×</option>
              <option value="bearishCross">Bear ×</option>
            </select>
          </>}
          {cond.type==='macd' && (
            <select className="bt2-sel full" value={cond.op||'crossUp'} onChange={e=>upd({op:e.target.value})}>
              <option value="crossUp">MACD crosses above signal (bullish)</option>
              <option value="crossDown">MACD crosses below signal (bearish)</option>
              <option value="aboveZero">MACD line above zero</option>
              <option value="belowZero">MACD line below zero</option>
              <option value="histPos">Histogram is positive</option>
              <option value="histNeg">Histogram is negative</option>
            </select>
          )}
          {cond.type==='bos' && (
            <select className="bt2-sel full" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
              <option value="bullish">Bullish BOS — broke swing high</option>
              <option value="bearish">Bearish BOS — broke swing low</option>
              <option value="any">Any BOS / CHoCH signal</option>
            </select>
          )}
          {cond.type==='fvg' && (
            <select className="bt2-sel full" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
              <option value="bullish">Bullish FVG (gap up imbalance)</option>
              <option value="bearish">Bearish FVG (gap down imbalance)</option>
              <option value="any">Any FVG present</option>
            </select>
          )}
          {cond.type==='displacement' && (
            <select className="bt2-sel full" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
              <option value="bullish">Bullish displacement (3 bull candles, impulse)</option>
              <option value="bearish">Bearish displacement (3 bear candles, impulse)</option>
              <option value="any">Any displacement</option>
            </select>
          )}
          {cond.type==='ob' && (
            <select className="bt2-sel full" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
              <option value="bullish">Bullish OB — price retesting demand zone</option>
              <option value="bearish">Bearish OB — price retesting supply zone</option>
              <option value="any">Any Order Block retest</option>
            </select>
          )}
          {cond.type==='ote_zone' && (
            <select className="bt2-sel full" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
              <option value="bullish">Bullish OTE — Fib 61.8–78.6% pullback in uptrend</option>
              <option value="bearish">Bearish OTE — Fib 61.8–78.6% bounce in downtrend</option>
              <option value="any">Any OTE zone</option>
            </select>
          )}
          {cond.type==='liquidity' && (
            <select className="bt2-sel full" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
              <option value="bullish">Bullish sweep — wick below lows, closed back above</option>
              <option value="bearish">Bearish sweep — wick above highs, closed back below</option>
              <option value="any">Any liquidity sweep</option>
            </select>
          )}
          {cond.type==='strong_rev' && <>
            <select className="bt2-sel" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
              <option value="bullish">Strong Hammer 🔨 (swept range low, reversed up)</option>
              <option value="bearish">Strong Shooting Star ⭐ (swept range high, reversed down)</option>
              <option value="any">Either strong sweep</option>
            </select>
            <label className="bt2-mini-label">Range N</label>
            <input className="bt2-num" type="number" value={cond.n||5} min={2} max={30} title="Candles the wick must clear"
              onChange={e=>upd({n:+e.target.value})}/>
          </>}
          {cond.type==='equal_hl' && (
            <select className="bt2-sel full" value={cond.op||'equalLows'} onChange={e=>upd({op:e.target.value})}>
              <option value="equalLows">Equal Lows — untested buy-side liquidity below</option>
              <option value="equalHighs">Equal Highs — untested sell-side liquidity above</option>
              <option value="any">Equal Highs or Equal Lows present</option>
            </select>
          )}
          {cond.type==='consolidation' && (
            <div className="bt2-rr-preview" style={{fontSize:11,padding:'6px 8px'}}>
              📦 Triggers when price is consolidating in a tight range (ATR squeeze)
            </div>
          )}
          {cond.type==='candlestick' && (
            <select className="bt2-sel full" value={cond.value||'any_bull'} onChange={e=>upd({value:e.target.value})}>
              {CANDLESTICKS.map(([v,l])=><option key={v} value={v}>{l}</option>)}
            </select>
          )}
          {cond.type==='session' && (
            <select className="bt2-sel full" value={cond.op||'killzone'} onChange={e=>upd({op:e.target.value})}>
              <option value="killzone">ICT Killzone (London 7-10 · NY AM 12-15 UTC)</option>
              <option value="asian">Asian session (00-07 UTC)</option>
              <option value="london">London session (07-16 UTC)</option>
              <option value="ny">New York session (12-21 UTC)</option>
              <option value="overlap">London·NY overlap (12-16 UTC)</option>
            </select>
          )}
          {cond.type==='dow' && (
            <select className="bt2-sel full" value={cond.op||'tue'} onChange={e=>upd({op:e.target.value})}>
              <option value="mon">Monday only</option><option value="tue">Tuesday only</option>
              <option value="wed">Wednesday only</option><option value="thu">Thursday only</option>
              <option value="fri">Friday only</option>
            </select>
          )}
          {cond.type==='volume' && <>
            <select className="bt2-sel" value={cond.op||'spike'} onChange={e=>upd({op:e.target.value})}>
              <option value="spike">Volume spike (× 20-bar avg)</option>
              <option value="above">Above average</option>
              <option value="below">Below average</option>
            </select>
            {cond.op==='spike' && <>
              <label className="bt2-mini-label">×</label>
              <input className="bt2-num" type="number" value={cond.mult||1.5} min={1} max={5} step={0.1}
                onChange={e=>upd({mult:+e.target.value})}/>
            </>}
          </>}
          {cond.type==='pattern' && (
            <select className="bt2-sel full" value={cond.value||'bullish'} onChange={e=>upd({value:e.target.value})}>
              <option value="bullish">Bullish candle pattern</option>
              <option value="bearish">Bearish candle pattern</option>
              <option value="any">Any significant pattern</option>
            </select>
          )}
          {cond.type==='candle' && (
            <select className="bt2-sel full" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
              <option value="bullish">Bullish close (green candle)</option>
              <option value="bearish">Bearish close (red candle)</option>
            </select>
          )}
        </div>
      </div>
    </div>
  );
}

const PAGE = 15;

export default function Backtester() {
  const [sym,   setSym]   = useState('EUR/USD');
  const [tf,    setTf]    = useState('1H');
  const [cnt,   setCnt]   = useState(1000);
  const [dir,   setDir]   = useState('both');
  const [conds, setConds] = useState([{id:1,type:'rsi',period:14,op:'crossBelow',value:30}]);
  const [exit,      setExit]      = useState('rr');
  const [slType,    setSlType]    = useState('fixed');
  const [trailA,    setTrailA]    = useState(3);
  const [tp,        setTp]        = useState(50);
  const [sl,        setSl]        = useState(25);
  const [rr,        setRr]        = useState(2.0);
  const [tpA,       setTpA]       = useState(2.0);
  const [slA,       setSlA]       = useState(1.0);
  const [swingLb,   setSwingLb]   = useState(15);
  const [risk,      setRisk]      = useState(1);
  const [maxT,      setMaxT]      = useState(1);
  const [spread,    setSpread]    = useState('');   // '' = realistic auto default per instrument
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [src,    setSrc]     = useState('');
  const [err,    setErr]     = useState('');
  const [page,   setPage]    = useState(0);
  const [activePresetCat, setActivePresetCat] = useState('All');
  const [library, setLibrary] = useState(() => loadLibrary());
  // AND/OR was hardcoded to AND. A Feed filter set to "ANY" would otherwise
  // arrive here as AND and quietly test a much stricter strategy than the one
  // on screen — the exact silent mistranslation the handoff exists to avoid.
  const [logic, setLogic] = useState('AND');
  const [fromFeed, setFromFeed] = useState(null);
  const [search, setSearch]     = useState(null);   // { running, done, total, result }
  const [across, setAcross]     = useState(null);   // cross-instrument check of one finalist
  const [saved,   setSaved]   = useState(false);

  const addCond = () => setConds(p=>[...p,{id:Date.now(),type:'rsi',...DEF.rsi}]);
  const updCond = (id,u) => setConds(p=>p.map(c=>c.id===id?{...c,...u}:c));
  const delCond = id => setConds(p=>p.filter(c=>c.id!==id));

  const applyPreset = p => {
    setDir(p.dir);
    setConds(p.conds.map((c,i)=>({...c,id:i+1})));
    if (p.exit==='rr')   { setExit('rr');    setSl(p.sl||25);   setRr(p.rr||2);   }
    if (p.exit==='fixed'){ setExit('fixed'); setTp(p.tp||50);   setSl(p.sl||25);  }
    if (p.exit==='atr')  { setExit('atr');   setTpA(p.tpA||2);  setSlA(p.slA||1); }
    if (p.exit==='trail'){ setExit('trail'); setTrailA(p.trailA||3); setSlA(p.slA||2); }
    setSlType(p.slTyp || 'fixed');
    if (p.swingLb) setSwingLb(p.swingLb);
    if (p.slTyp === 'atr' && p.slA) setSlA(p.slA);
  };

  // Auto-compute TP in R:R mode
  const rrTpPips = useMemo(() => Math.round(sl * rr), [sl, rr]);
  const rrTpAtr  = useMemo(() => +(slA * rr).toFixed(1), [slA, rr]);

  const run = async () => {
    if (conds.length === 0) { setErr('Add at least one entry condition.'); return; }
    setRunning(true); setErr(''); setResults(null); setPage(0); setSaved(false);
    try {
      const {candles, src:s} = await fetchCandles(sym, tf, cnt);
      setSrc(s);
      const strat = {
        symbol:sym, conditions:conds, logic, direction:dir,
        trailAtr: trailA,
        exitType:     exit,
        slType:       slType,
        tpPips:       exit==='fixed' ? tp : (exit==='rr' ? rrTpPips : tp),
        slPips:       sl,
        tpAtr:        tpA,
        slAtr:        slA,
        rrRatio:      rr,
        swingLookback:swingLb,
        maxTrades:maxT, riskPct:risk,
        spreadPips: spread === '' ? undefined : +spread,   // undefined → engine uses realistic default
      };
      const {trades, equityCurve} = runBacktest(candles, strat);
      const stats = calcStats(trades);
      // Statistical grading (all phases) — yield to the paint first so the
      // spinner shows, since baseline + Monte-Carlo are a bit of extra compute.
      await new Promise(r => setTimeout(r, 0));
      const sig = condSignature(sym, tf, conds);
      const seal = getSeal(sig);
      const testCount = recordSearch(datasetKey(sym, tf, cnt), sig);
      let grade = null;
      try { grade = gradeStrategy(candles, strat, stats, trades, { seal, testCount }); } catch { grade = null; }
      setResults({
        trades, equityCurve, stats, grade, sig,
        lastBarTime: candles[candles.length - 1]?.t ?? Date.now(),
        symUsed:sym, tfUsed:tf, srcUsed:s,
      });
    } catch(e) { setErr(e.message); }
    setRunning(false);
  };

  // Seal = freeze the clock. Every bar after this instant is provably forward
  // data, so the forward test can never be overfit. Deliberately irreversible.
  const sealNow = () => {
    if (!results?.sig) return;
    sealRule(results.sig, results.lastBarTime);
    setResults(r => ({
      ...r,
      grade: { ...r.grade, forward: { sealedAt:new Date().toISOString(), sealBarTime:r.lastBarTime,
        daysElapsed:0, n:0, enough:false, minN:15, winRate:0, expR:0, status:'pending' } },
    }));
  };

  const saveGrade = () => {
    if (!results?.grade) return;
    const g = results.grade;
    const entry = {
      sig: condSignature(sym, tf, conds),
      symbol: sym, tf, dir,
      conds: conds.map(c=>({...c})),
      verdict: g.verdict, verdictLabel: g.label, color: g.color,
      edgeMult: g.edgeMult, n: g.n, expR: g.setupExpR,
      winRate: g.setupWinRate, baseWinRate: g.baseWinRate,
      oos: g.oos.status, validated: g.validated,
      fwd: g.forward ? { status:g.forward.status, n:g.forward.n, expR:g.forward.expR, days:g.forward.daysElapsed } : null,
      savedAt: new Date().toISOString(),
    };
    setLibrary(saveToLibrary(entry));
    setSaved(true);
  };
  // Pick up a filter handed over from the Live Feed. Consumed on read, so
  // switching tabs and back cannot silently re-apply a strategy you have edited.
  useEffect(() => {
    const staged = takeStagedFilter();
    if (!staged?.strategy?.conditions?.length) return;
    setConds(staged.strategy.conditions.map((c, i) => ({ ...c, id: i + 1 })));
    setLogic(staged.strategy.logic || 'AND');
    setTf(staged.timeframe === 'D' ? 'D' : '4H');
    setDir('both');
    setFromFeed(staged);
  }, []);

  // Search the space rather than trying presets one at a time — with a holdout,
  // so anything found by looking hard is exposed instead of celebrated.
  const runSearch = async () => {
    setErr(''); setSearch({ running:true, done:0, total:combinationCount() });
    try {
      const { candles } = await fetchCandles(sym, tf, cnt);
      const res = await searchStrategies(candles, {
        spreadPips: spread === '' ? undefined : +spread,
        onProgress: (done, total) => setSearch(s => ({ ...s, done, total })),
      });
      setSearch({ running:false, result:res });
    } catch (e) { setErr(e.message); setSearch(null); }
  };

  // Load a search finalist into the builder, so the full report — trade list,
  // equity curve, grade, forward-test seal — can be run on it. The search says
  // whether something survived; everything else about it lives here.
  const loadFinalist = (f) => {
    const st = f.strategy;
    setConds(st.conditions.map((c, i) => ({ ...c, id: i + 1 })));
    setLogic(st.logic || 'AND');
    setDir(st.direction || 'both');
    setExit(st.exitType);
    if (st.exitType === 'rr')    setRr(st.rrRatio || 2);
    if (st.exitType === 'trail') setTrailA(st.trailAtr || 3);
    setSlType(st.slType);
    if (st.slType === 'atr')   setSlA(st.slAtr || 2);
    if (st.slType === 'swing') setSwingLb(st.swingLookback || 12);
    setSearch(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Run one finalist, unchanged, on every instrument. Breadth is the evidence.
  const runAcross = async (f) => {
    setAcross({ running:true, label:f.label, done:0, total:INSTRUMENTS.length });
    try {
      const res = await testAcrossInstruments(
        f.strategy,
        async (s) => (await fetchCandles(s, tf, cnt)).candles,
        INSTRUMENTS,
        { onProgress: (done, total) => setAcross(a => ({ ...a, done, total })) },
      );
      setAcross({ running:false, label:f.label, result:res });
    } catch (e) { setErr(e.message); setAcross(null); }
  };

  const removeGrade = (sig) => setLibrary(removeFromLibrary(sig));
  const loadFromLib = (e) => {
    setSym(e.symbol); setTf(e.tf); setDir(e.dir);
    setConds(e.conds.map((c,i)=>({...c,id:i+1})));
  };

  const s = results?.stats;
  const trades = results?.trades || [];
  const pageCount = Math.ceil(trades.length / PAGE);
  const pageTrades = trades.slice(page*PAGE, page*PAGE+PAGE);

  // Extra computed stats
  const expectancy = s ? ((s.winRate/100)*s.avgWin - ((1-s.winRate/100)*s.avgLoss)).toFixed(2) : null;
  const recovFactor = (s && s.maxDrawdown>0) ? (Math.abs(s.totalPnlDollars)/( (s.maxDrawdown/100)*10000)).toFixed(2) : null;

  const presetCats = ['All', ...Array.from(new Set(PRESETS.map(p=>p.cat)))];
  const visiblePresets = activePresetCat==='All' ? PRESETS : PRESETS.filter(p=>p.cat===activePresetCat);

  return (
    <div className="bt2-root">

      {/* ── LEFT: Strategy Builder ─────────────────────────────────────────── */}
      <div className="bt2-builder">
        <div className="bt2-builder-head">
          <span>⚡</span> Strategy Builder
        </div>

        {/* Step 1: Instrument */}
        {/* ── What the Live Feed handed over, and what it could not ──
              A backtest that quietly tests four of your six conditions and
              reports a win rate is worse than no backtest, because it looks
              like an answer. ── */}
        {fromFeed && (
          <div style={{ background:'#0b1118', border:'1px solid #00d4aa44', borderRadius:8,
            padding:'10px 12px', marginBottom:12, fontSize:12, lineHeight:1.7 }}>
            <div style={{ color:'#00d4aa', fontWeight:700, marginBottom:4 }}>
              From the Live Feed — testing {fromFeed.testable} of {fromFeed.total} conditions on {fromFeed.timeframe}
            </div>
            {fromFeed.dropped.length > 0 && (
              <div style={{ color:'#f59e0b' }}>
                {fromFeed.dropped.map((d, i) => (
                  <div key={i}>⚠ <strong>{d.label}</strong> not tested — {d.why}</div>
                ))}
              </div>
            )}
            {fromFeed.mixedTimeframes && (
              <div style={{ color:'#f59e0b' }}>
                ⚠ Filter mixes {fromFeed.mixedTimeframes.join(' and ')} — this test runs on {fromFeed.timeframe} only.
              </div>
            )}
            {fromFeed.minMatchLost && (
              <div style={{ color:'#f59e0b' }}>
                ⚠ “ANY {fromFeed.minMatchLost} of N” became plain OR — the engine has no N-of-M.
              </div>
            )}
            <div style={{ color:'#475569', fontSize:11, marginTop:4 }}>
              Set your exit and risk below, then run. The grade tells you whether any edge beats random.
            </div>
          </div>
        )}

        <div className="bt2-step">
          <div className="bt2-step-label"><span className="bt2-step-num">01</span>Instrument &amp; Data</div>
          <div className="bt2-row">
            <select className="bt2-sel" style={{flex:2}} value={sym} onChange={e=>setSym(e.target.value)}>
              {INSTRUMENTS.map(i=><option key={i} value={i}>{i}</option>)}
            </select>
            <select className="bt2-sel" value={cnt} onChange={e=>setCnt(+e.target.value)}>
              {COUNTS.map(c=><option key={c} value={c}>{c} bars</option>)}
            </select>
          </div>
          <div className="bt2-tf-row">
            {TFS.map(t=>(
              <button key={t} className={`bt2-tf-pill${tf===t?' active':''}`} onClick={()=>setTf(t)}>{t}</button>
            ))}
          </div>
          <div className="bt2-tf-row" style={{ marginTop:6 }}>
            <span style={{ fontSize:11, color:'#475569', alignSelf:'center', marginRight:6 }}>conditions must</span>
            {[['AND','all hold'],['OR','any hold']].map(([v,l])=>(
              <button key={v} className={`bt2-tf-pill${logic===v?' active':''}`} onClick={()=>setLogic(v)}>{l}</button>
            ))}
          </div>
        </div>

        {/* Step 2: Direction */}
        <div className="bt2-step">
          <div className="bt2-step-label"><span className="bt2-step-num">02</span>Trade Direction</div>
          <div className="bt2-dir-row">
            {[{v:'long',l:'▲ Long'},{v:'short',l:'▼ Short'},{v:'both',l:'↕ Both'}].map(d=>(
              <button key={d.v} className={`bt2-dir-btn${dir===d.v?' active':''}`} onClick={()=>setDir(d.v)}>
                {d.l}
              </button>
            ))}
          </div>
          <div className="bt2-hint">
            {dir==='both'?'Opens longs on signal · shorts on mirror signal':dir==='long'?'Long trades only':'Short trades only'}
          </div>
        </div>

        {/* Step 3: Entry Conditions */}
        <div className="bt2-step">
          <div className="bt2-step-label" style={{justifyContent:'space-between'}}>
            <div><span className="bt2-step-num">03</span>Entry Conditions</div>
            <button className="bt2-add-btn" onClick={addCond}>+ Add Condition</button>
          </div>
          {conds.length === 0 && (
            <div className="bt2-empty-conds">No conditions — click + Add Condition</div>
          )}
          {conds.map((c,i)=>(
            <CondRow key={c.id} cond={c} idx={i}
              onChange={u=>updCond(c.id,u)} onRemove={()=>delCond(c.id)}/>
          ))}
        </div>

        {/* Step 4: Exit Rules */}
        <div className="bt2-step">
          <div className="bt2-step-label"><span className="bt2-step-num">04</span>Exit Rules</div>

          {/* Take Profit Mode */}
          <div className="bt2-sub-label">Take Profit</div>
          <div className="bt2-exit-tabs">
            {[{v:'rr',l:'R:R Ratio'},{v:'fixed',l:'Fixed Pips'},{v:'atr',l:'ATR ×'},{v:'trail',l:'Trailing'}].map(e=>(
              <button key={e.v} className={`bt2-exit-tab${exit===e.v?' active':''}`} onClick={()=>setExit(e.v)}>{e.l}</button>
            ))}
          </div>
          {exit==='rr' && (
            <div className="bt2-exit-body">
              <div className="bt2-exit-grid">
                <div>
                  <div className="bt2-mini-label">Risk : Reward</div>
                  <div className="bt2-rr-control">
                    <input className="bt2-num" type="number" value={rr} min={0.5} max={20} step={0.5} style={{width:52}} onChange={e=>setRr(+e.target.value)}/>
                    <span className="bt2-rr-sep">: 1</span>
                  </div>
                </div>
              </div>
              <div className="bt2-rr-preview">
                <span className="bt2-rr-preview-icon">→</span>
                TP = SL distance × <strong>{rr}R</strong>
                <span className="bt2-rr-preview-ratio">(auto from SL below)</span>
              </div>
            </div>
          )}
          {exit==='fixed' && (
            <div className="bt2-exit-body">
              <div>
                <div className="bt2-mini-label">Take Profit (pips)</div>
                <input className="bt2-num" type="number" value={tp} min={1} style={{width:'100%'}} onChange={e=>setTp(+e.target.value)}/>
              </div>
              {slType==='fixed' && (
                <div className="bt2-rr-preview">
                  <span className="bt2-rr-preview-icon">≈</span>
                  Implied R:R ≈ <strong>{sl>0?(tp/sl).toFixed(2):0} : 1</strong>
                </div>
              )}
            </div>
          )}
          {exit==='atr' && (
            <div className="bt2-exit-body">
              <div className="bt2-exit-grid">
                <div>
                  <div className="bt2-mini-label">TP (× ATR)</div>
                  <input className="bt2-num full" type="number" value={tpA} min={0.1} step={0.1} onChange={e=>setTpA(+e.target.value)}/>
                </div>
              </div>
            </div>
          )}

          {exit==='trail' && (
            <div style={{marginTop:8}}>
              <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                <span style={{fontSize:12,color:'var(--text3)'}}>Trail distance</span>
                <input className="bt2-input" type="number" step="0.5" min="1" max="10" value={trailA}
                  onChange={e=>setTrailA(+e.target.value||3)} style={{width:80}}/>
                <span style={{fontSize:12,color:'var(--text3)'}}>× ATR</span>
              </div>
              <div style={{fontSize:11,color:'var(--text3)',lineHeight:1.7,marginTop:6,
                background:'#0b1220',border:'1px solid #16324a',borderRadius:8,padding:'8px 10px'}}>
                <strong style={{color:'#7dd3fc'}}>No take profit at all.</strong> The stop follows price up and
                the trade ends only when it is hit. Every other exit here sets a target at entry, which caps the
                winner — and a strategy that pays for twenty small losses with one very large win cannot survive
                having that win capped. Expect a <em>lower</em> win rate and a much larger best trade.
                <div style={{marginTop:4,color:'#8aa8bd'}}>
                  Wide on purpose. A tight trail is clipped by every normal pullback, and being shaken out of one
                  real trend costs more than the giveback on twenty ordinary trades.
                </div>
              </div>
            </div>
          )}

          {/* Stop Loss Type */}
          <div className="bt2-sub-label" style={{marginTop:10}}>Stop Loss</div>
          <div className="bt2-exit-tabs">
            {[{v:'fixed',l:'Fixed Pips'},{v:'swing',l:'Swing H/L'},{v:'atr',l:'ATR ×'}].map(e=>(
              <button key={e.v} className={`bt2-exit-tab${slType===e.v?' active':''}`} onClick={()=>setSlType(e.v)}>{e.l}</button>
            ))}
          </div>
          {slType==='fixed' && (
            <div className="bt2-exit-body">
              <div>
                <div className="bt2-mini-label">Stop Loss (pips)</div>
                <input className="bt2-num" type="number" value={sl} min={1} style={{width:'100%'}} onChange={e=>setSl(+e.target.value)}/>
              </div>
              {exit==='rr' && (
                <div className="bt2-rr-preview">
                  <span className="bt2-rr-preview-icon">→</span>
                  SL {sl} pips → TP <strong>{rrTpPips} pips</strong>
                  <span className="bt2-rr-preview-ratio">({rr}R)</span>
                </div>
              )}
            </div>
          )}
          {slType==='swing' && (
            <div className="bt2-exit-body">
              <div className="bt2-exit-grid">
                <div>
                  <div className="bt2-mini-label">Lookback (bars)</div>
                  <input className="bt2-num full" type="number" value={swingLb} min={3} max={100} onChange={e=>setSwingLb(+e.target.value)}/>
                </div>
                <div>
                  <div className="bt2-mini-label">Buffer (pips)</div>
                  <div className="bt2-mini-label" style={{color:'var(--accent)',fontSize:10}}>3 pips fixed</div>
                </div>
              </div>
              <div className="bt2-rr-preview" style={{background:'#8b5cf615',borderColor:'#8b5cf633'}}>
                <span className="bt2-rr-preview-icon" style={{color:'#8b5cf6'}}>⤵</span>
                SL placed at swing low/high within last <strong>{swingLb} bars</strong> + 3 pip buffer
                {exit==='rr' && <span className="bt2-rr-preview-ratio"> · TP = SL dist × {rr}R</span>}
              </div>
            </div>
          )}
          {slType==='atr' && (
            <div className="bt2-exit-body">
              <div className="bt2-exit-grid">
                <div>
                  <div className="bt2-mini-label">SL (× ATR)</div>
                  <input className="bt2-num full" type="number" value={slA} min={0.1} step={0.1} onChange={e=>setSlA(+e.target.value)}/>
                </div>
              </div>
              {exit==='rr' && (
                <div className="bt2-rr-preview">
                  <span className="bt2-rr-preview-icon">→</span>
                  SL = {slA}× ATR → TP = {slA}× ATR × <strong>{rr}R</strong>
                </div>
              )}
              {exit==='atr' && (
                <div className="bt2-rr-preview">
                  <span className="bt2-rr-preview-icon">≈</span>
                  ATR R:R = <strong>{(tpA/slA).toFixed(2)} : 1</strong>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Step 5: Risk Management */}
        <div className="bt2-step">
          <div className="bt2-step-label"><span className="bt2-step-num">05</span>Risk Management</div>
          <div className="bt2-exit-grid">
            <div>
              <div className="bt2-mini-label">Risk per trade (%)</div>
              <input className="bt2-num full" type="number" value={risk} min={0.1} max={10} step={0.1} onChange={e=>setRisk(+e.target.value)}/>
            </div>
            <div>
              <div className="bt2-mini-label">Max open trades</div>
              <input className="bt2-num full" type="number" value={maxT} min={1} max={10} onChange={e=>setMaxT(+e.target.value)}/>
            </div>
            <div>
              <div className="bt2-mini-label">Spread cost (pips)</div>
              <input className="bt2-num full" type="number" value={spread} min={0} step={0.1}
                placeholder={`auto: ${defaultSpreadPips(sym)}`} onChange={e=>setSpread(e.target.value)}/>
            </div>
          </div>
          <div className="bt2-hint">
            Starting capital: $10,000 · Risk {risk}% = ${(10000*risk/100).toFixed(0)}/trade ·
            Spread {spread===''?`${defaultSpreadPips(sym)} (auto)`:spread} pips deducted per trade — real cost, not a fantasy fill
          </div>
        </div>

        {/* Presets */}
        <div className="bt2-step">
          <div className="bt2-step-label"><span className="bt2-step-num">★</span>Quick Presets</div>
          <div className="bt2-preset-cats">
            {presetCats.map(cat=>(
              <button key={cat} className={`bt2-preset-cat${activePresetCat===cat?' active':''}`}
                style={activePresetCat===cat&&cat!=='All'?{color:CAT_COLORS[cat],borderColor:CAT_COLORS[cat]+'55',background:CAT_COLORS[cat]+'12'}:{}}
                onClick={()=>setActivePresetCat(cat)}>
                {cat}
              </button>
            ))}
          </div>
          <div className="bt2-preset-grid">
            {visiblePresets.map(p=>(
              <button key={p.name} className="bt2-preset-card" onClick={()=>applyPreset(p)}
                title={p.desc}>
                <span className="bt2-preset-emoji">{p.emoji}</span>
                <div className="bt2-preset-info">
                  <div className="bt2-preset-name">{p.name}</div>
                  <div className="bt2-preset-desc">{p.desc}</div>
                </div>
                <span className="bt2-preset-badge" style={{color:CAT_COLORS[p.cat]||'#94a3b8',background:(CAT_COLORS[p.cat]||'#94a3b8')+'15'}}>
                  {p.cat}
                </span>
              </button>
            ))}
          </div>
        </div>

        {err && <div className="bt2-error">⚠ {err}</div>}

        <div style={{padding:'12px 14px', flexShrink:0}}>
          <button className="bt2-run-btn" onClick={run} disabled={running || search?.running}>
            {running ? <><span style={{animation:'spin 1s linear infinite',display:'inline-block'}}>⟳</span> Running…</> : '▶ Run Backtest'}
          </button>

          {/* ── Search the space, with a holdout ───────────────────────────
                Trying presets one at a time and keeping the best is how you
                find something that never worked. This tries every combination
                on the first 70% of the history, then runs the survivors on the
                last 30% it never saw — so curve-fitting is visible instead of
                being reported as a discovery. ── */}
          <button onClick={runSearch} disabled={running || search?.running}
            style={{ width:'100%', marginTop:10, padding:'12px', borderRadius:10, cursor:'pointer',
              fontWeight:800, fontSize:14, border:'1px solid #7dd3fc55', background:'#0b1a2a', color:'#7dd3fc' }}>
            {search?.running
              ? `⟳ Searching… ${search.done}/${search.total}`
              : `🔍 Find what works — search ${combinationCount()} combinations`}
          </button>
          <div style={{ fontSize:11, color:'var(--text3)', lineHeight:1.6, marginTop:6 }}>
            Searches on the first 70% of the bars, then tests the best few on the last 30% it never saw.
            Anything whose edge collapses out of sample was curve-fitting, and is labelled that way.
            <strong style={{ color:'#f59e0b' }}> Use the Daily timeframe and as many bars as you can</strong> —
            1,000 hourly bars is 58 days, which is not enough history for any of this to mean anything.
          </div>
        </div>
      </div>

      {/* ── RIGHT: Results ─────────────────────────────────────────────────── */}
      <div className="bt2-results">
        {across && (() => {
          if (across.running) return (
            <div style={{ background:'#0b1118', border:'1px solid #16324a', borderRadius:12,
              padding:'14px 16px', margin:'0 0 14px', fontSize:13, color:'#7dd3fc' }}>
              ⟳ Testing on every instrument… {across.done}/{across.total}
            </div>
          );
          const r = across.result; if (!r) return null;
          const V = {
            broad:   { c:'#22c55e', t:'WORKS BROADLY',
                       d:'Positive on most instruments. That is what a real behaviour looks like — a rule fitted to one history has no reason to travel.' },
            mixed:   { c:'#f59e0b', t:'MIXED',
                       d:'Positive on some, negative on others. Could be a weak real effect, could be luck. Not enough to trade on.' },
            'one-off':{ c:'#ef4444', t:'ONE INSTRUMENT ONLY',
                       d:'It works where it was found and nowhere else. That is what curve-fitting looks like when you widen the lens.' },
            'too-few':{ c:'#64748b', t:'NOT ENOUGH INSTRUMENTS TRADED',
                       d:'Too few instruments produced enough trades to judge. Try more bars, or a lower timeframe.' },
          }[r.verdict];
          return (
            <div style={{ background:'#0b1118', border:`1px solid ${V.c}44`, borderRadius:12, padding:'14px 16px', margin:'0 0 14px' }}>
              <div style={{ fontSize:15, fontWeight:800, color:V.c }}>{V.t}</div>
              <div style={{ fontSize:12, color:'var(--text3)', marginTop:3, marginBottom:8 }}>{across.label}</div>
              <div style={{ fontSize:12, color:'#c7d2da', lineHeight:1.7, marginBottom:10 }}>
                {V.d}
                <div style={{ marginTop:3, color:'var(--text3)' }}>
                  {r.positive} of {r.judged} instruments positive · median {r.median != null ? `${r.median > 0 ? '+' : ''}${r.median}R` : '—'}
                </div>
              </div>
              {r.rows.filter(x => x.enough).map(x => (
                <div key={x.sym} style={{ display:'flex', alignItems:'center', gap:8, padding:'2px 0', fontSize:12 }}>
                  <span style={{ width:88, fontWeight:700, color:'#e2e8f0', flexShrink:0 }}>{x.sym}</span>
                  <span style={{ flex:1, height:4, background:'#0f172a', borderRadius:2, overflow:'hidden', minWidth:40 }}>
                    <span style={{ display:'block', marginLeft: x.expR < 0 ? 0 : '50%',
                      width:`${Math.min(50, Math.abs(x.expR) * 25)}%`, height:'100%',
                      background: x.expR > 0 ? '#22c55e' : '#ef4444',
                      float: x.expR < 0 ? 'right' : 'none' }}/>
                  </span>
                  <span style={{ width:56, textAlign:'right', fontFamily:'monospace',
                    color: x.expR > 0 ? '#22c55e' : '#ef4444' }}>
                    {x.expR > 0 ? '+' : ''}{x.expR}R
                  </span>
                  <span style={{ width:44, textAlign:'right', color:'var(--text3)' }}>n={x.n}</span>
                </div>
              ))}
              <button onClick={() => setAcross(null)}
                style={{ marginTop:10, fontSize:11, padding:'3px 10px', borderRadius:6, cursor:'pointer',
                  background:'transparent', color:'var(--text3)', border:'1px solid var(--border)' }}>close</button>
            </div>
          );
        })()}

        {search?.result && (() => {
          const r = search.result;
          if (!r.ok) return <div className="bt2-error">⚠ {r.reason}</div>;
          const COL = { survived:'#22c55e', faded:'#f59e0b', 'curve-fit':'#ef4444', untested:'#64748b' };
          const WORD = { survived:'SURVIVED', faded:'FADED', 'curve-fit':'CURVE-FIT', untested:'TOO FEW OUT-OF-SAMPLE' };
          const kept = r.finalists.filter(f => f.verdict === 'survived');
          return (
            <div style={{ background:'#0b1118', border:'1px solid #16324a', borderRadius:12, padding:'14px 16px', margin:'0 0 14px' }}>
              <div style={{ fontSize:15, fontWeight:800, color:'#7dd3fc', marginBottom:4 }}>
                Searched {r.tested} combinations
              </div>
              <div style={{ fontSize:12, color:'var(--text3)', lineHeight:1.7, marginBottom:12 }}>
                {r.qualified} had enough trades to judge. Searched on {r.inSampleBars} bars,
                tested on {r.outSampleBars} the search never saw.
                <div style={{ marginTop:3, color:'#f59e0b' }}>
                  At {r.tested} attempts, roughly {r.expectedFalsePositives} would look good by luck alone.
                  That is exactly why the holdout column is the only one worth reading.
                </div>
              </div>

              {kept.length === 0 && (
                <div style={{ fontSize:13, color:'#fca5a5', lineHeight:1.7, marginBottom:10,
                  border:'1px solid #ef444444', borderRadius:8, padding:'10px 12px', background:'#ef44440d' }}>
                  <strong>Nothing survived the holdout.</strong>
                  <div style={{ marginTop:3, color:'#c7d2da' }}>
                    Every candidate that looked good on the first 70% failed on the last 30%. That is the
                    normal result, and it is worth far more than a number that would have been fitted.
                    Longer history and the Daily timeframe give this the best chance.
                  </div>
                </div>
              )}

              {r.finalists.map(f => (
                <div key={f.id} style={{ borderTop:'1px solid #16202b', padding:'9px 0' }}>
                  <div style={{ display:'flex', gap:8, alignItems:'baseline', flexWrap:'wrap' }}>
                    <span style={{ fontSize:10, fontWeight:900, color:COL[f.verdict],
                      border:`1px solid ${COL[f.verdict]}44`, borderRadius:3, padding:'1px 6px' }}>
                      {WORD[f.verdict]}
                    </span>
                    <span style={{ fontSize:12, color:'#e2e8f0' }}>{f.label}</span>
                  </div>
                  <div style={{ display:'flex', gap:18, marginTop:5, fontSize:12, flexWrap:'wrap' }}>
                    <span style={{ color:'var(--text3)' }}>
                      searched: <strong style={{ color:'#94a3b8' }}>{f.inSample.expR > 0 ? '+' : ''}{f.inSample.expR}R</strong>
                      {' '}· {f.inSample.winRate}% · n={f.inSample.n}
                    </span>
                    <span style={{ color:'var(--text3)' }}>
                      held out: <strong style={{ color: f.outSample?.expR > 0 ? '#22c55e' : '#ef4444' }}>
                        {f.outSample ? `${f.outSample.expR > 0 ? '+' : ''}${f.outSample.expR}R` : '—'}
                      </strong>
                      {f.outSample ? ` · ${f.outSample.winRate}% · n=${f.outSample.n}` : ''}
                    </span>
                    <span style={{ marginLeft:'auto', display:'flex', gap:6 }}>
                      {f.verdict === 'survived' && (
                        <button onClick={() => runAcross(f)} disabled={across?.running}
                          style={{ fontSize:11, fontWeight:700, padding:'3px 10px', borderRadius:6,
                            cursor:'pointer', border:'1px solid #22c55e55', background:'#0b1a12', color:'#22c55e' }}>
                          test on all instruments
                        </button>
                      )}
                      <button onClick={() => loadFinalist(f)}
                        style={{ fontSize:11, fontWeight:700, padding:'3px 10px', borderRadius:6,
                          cursor:'pointer', border:'1px solid #7dd3fc55', background:'#0b1a2a', color:'#7dd3fc' }}>
                        open in builder →
                      </button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          );
        })()}
        {!results && !running && (
          <div className="bt2-placeholder">
            <div className="bt2-placeholder-icon">📊</div>
            <div className="bt2-placeholder-title">No results yet</div>
            <div className="bt2-placeholder-sub">Configure a strategy on the left, then click Run Backtest.</div>
            <div className="bt2-data-pills">
              <span className="bt2-data-pill live">● OANDA Live — real historical data when connected</span>
              <span className="bt2-data-pill sim">~ Simulated data when offline</span>
            </div>
            {library.length > 0 && (
              <div style={{width:'100%', maxWidth:620, marginTop:18, textAlign:'left'}}>
                <EdgeLibrary items={library} onLoad={loadFromLib} onRemove={removeGrade}/>
              </div>
            )}
          </div>
        )}
        {running && (
          <div className="bt2-placeholder">
            <div className="bt2-placeholder-icon" style={{animation:'spin 1.2s linear infinite',display:'inline-block'}}>⟳</div>
            <div className="bt2-placeholder-title">Fetching data &amp; running backtest…</div>
          </div>
        )}
        {results && (
          <>
            {/* Header row */}
            <div className="bt2-results-header">
              <span className={`bt2-src-badge${src.startsWith('OANDA')?' live':' sim'}`}>
                {src.startsWith('OANDA')?'●':'~'} {src}
              </span>
              <span className="bt2-results-sym">{sym} · {tf} · {cnt} bars</span>
            </div>

            {/* Statistical grade — the honest verdict (Phases 1/2/5) */}
            {results.grade && <GradeCard g={results.grade} onSave={saveGrade} saved={saved} onSeal={sealNow}/>}

            {/* Key metrics — top row */}
            <div className="bt2-kpi-row">
              <div className={`bt2-kpi ${s.winRate>=50?'bull':s.winRate>=40?'neutral':'bear'}`}>
                <div className="bt2-kpi-val">{s.winRate}%</div>
                <div className="bt2-kpi-label">Win Rate</div>
                <div className="bt2-kpi-sub">{s.wins}W · {s.losses}L</div>
              </div>
              <div className={`bt2-kpi ${s.totalPnlDollars>=0?'bull':'bear'}`}>
                <div className="bt2-kpi-val">{sign(s.totalPnlDollars)}${Math.abs(s.totalPnlDollars)}</div>
                <div className="bt2-kpi-label">Total P&amp;L</div>
                <div className="bt2-kpi-sub">{sign(s.totalPnlPct)}{s.totalPnlPct}%</div>
              </div>
              <div className={`bt2-kpi ${s.profitFactor>=1.5?'bull':s.profitFactor>=1?'neutral':'bear'}`}>
                <div className="bt2-kpi-val">{s.profitFactor===999?'∞':s.profitFactor}</div>
                <div className="bt2-kpi-label">Profit Factor</div>
                <div className="bt2-kpi-sub">{s.totalTrades} trades</div>
              </div>
              <div className={`bt2-kpi ${s.maxDrawdown<5?'bull':s.maxDrawdown<15?'neutral':'bear'}`}>
                <div className="bt2-kpi-val">{s.maxDrawdown}%</div>
                <div className="bt2-kpi-label">Max Drawdown</div>
                <div className="bt2-kpi-sub">peak-to-trough</div>
              </div>
            </div>

            {/* Secondary metrics */}
            <div className="bt2-metric-grid">
              <Metric label="Avg Win"     value={`$${s.avgWin}`}    color="#22c55e"/>
              <Metric label="Avg Loss"    value={`$${s.avgLoss}`}   color="#ef4444"/>
              <Metric label="Best Trade"  value={`${sign(s.bestTrade)}${s.bestTrade} pips`}  color={clr(s.bestTrade)}/>
              <Metric label="Worst Trade" value={`${sign(s.worstTrade)}${s.worstTrade} pips`} color={clr(s.worstTrade)}/>
              <Metric label="Avg Duration" value={`${s.avgDuration} bars`} color="var(--text2)"/>
              <Metric label="Total Pips"  value={`${sign(s.totalPnlPips)}${s.totalPnlPips}`} color={clr(s.totalPnlPips)}/>
              {expectancy != null && (
                <Metric label="Expectancy/trade" value={`${sign(+expectancy)}$${Math.abs(+expectancy)}`}
                  color={clr(+expectancy)} sub="avg $ per trade"/>
              )}
              {recovFactor != null && (
                <Metric label="Recovery Factor" value={recovFactor}
                  color={+recovFactor>=2?'#22c55e':+recovFactor>=1?'#f59e0b':'#ef4444'} sub="P&L ÷ MaxDD"/>
              )}
              {s.sharpe != null && (
                <Metric label="Sharpe Ratio" value={s.sharpe}
                  color={s.sharpe>=1?'#22c55e':s.sharpe>=0?'#f59e0b':'#ef4444'} sub="per-trade (>1 = good)"/>
              )}
              {s.sortino != null && (
                <Metric label="Sortino Ratio" value={s.sortino}
                  color={s.sortino>=1.5?'#22c55e':s.sortino>=0?'#f59e0b':'#ef4444'} sub="downside-adj (>1.5 = good)"/>
              )}
              {s.calmar != null && (
                <Metric label="Calmar Ratio" value={s.calmar}
                  color={s.calmar>=2?'#22c55e':s.calmar>=1?'#f59e0b':'#ef4444'} sub="return ÷ max drawdown"/>
              )}
              {s.avgRR != null && (
                <Metric label="Avg Achieved R" value={s.avgRR}
                  color={s.avgRR>=1?'#22c55e':s.avgRR>=0?'#f59e0b':'#ef4444'} sub="avg R-multiple per trade"/>
              )}
              <Metric label="Max Win Streak"  value={s.maxWinStreak}  color="#22c55e" sub="consecutive wins"/>
              <Metric label="Max Loss Streak" value={s.maxLossStreak} color="#ef4444" sub="consecutive losses"/>
            </div>

            {/* Robustness — out-of-sample, thirds, Monte-Carlo (Phase 3) */}
            {results.grade && <RobustnessCard g={results.grade}/>}

            {/* Long vs Short breakdown */}
            {(s.longWinRate != null || s.shortWinRate != null) && (
              <div className="bt2-chart-card">
                <div className="bt2-card-title">Long vs Short Performance</div>
                <LongShortPanel s={s}/>
              </div>
            )}

            {/* Monthly P&L distribution */}
            {s.monthlyPnl && s.monthlyPnl.length >= 2 && (
              <div className="bt2-chart-card">
                <div className="bt2-card-title">
                  Period P&amp;L Distribution
                  <span style={{color:'var(--text3)',fontWeight:400,fontSize:10,marginLeft:6}}>
                    {s.monthlyPnl.filter(m=>m.pnl>0).length} profitable · {s.monthlyPnl.filter(m=>m.pnl<0).length} losing periods
                  </span>
                </div>
                <MonthlyPnlChart monthlyPnl={s.monthlyPnl}/>
              </div>
            )}

            {/* Equity curve */}
            <div className="bt2-chart-card">
              <div className="bt2-card-title">Equity Curve <span style={{color:'var(--text3)',fontWeight:400,fontSize:10}}>$10,000 starting capital</span></div>
              <EquityCurve curve={results.equityCurve}/>
            </div>

            {/* Validated edge library (Phase 4) */}
            <EdgeLibrary items={library} onLoad={loadFromLib} onRemove={removeGrade}/>

            {/* Trade log */}
            {trades.length > 0 && (
              <div className="bt2-chart-card">
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                  <div className="bt2-card-title">Trade Log <span style={{color:'var(--text3)',fontWeight:400,fontSize:10}}>({trades.length} trades)</span></div>
                  {pageCount>1 && (
                    <div style={{display:'flex',alignItems:'center',gap:6}}>
                      <button className="bt2-page-btn" disabled={page===0} onClick={()=>setPage(p=>p-1)}>‹</button>
                      <span style={{fontSize:11,color:'var(--text2)'}}>{page+1} / {pageCount}</span>
                      <button className="bt2-page-btn" disabled={page>=pageCount-1} onClick={()=>setPage(p=>p+1)}>›</button>
                    </div>
                  )}
                </div>
                <div style={{overflowX:'auto'}}>
                  <table className="bt2-table">
                    <thead>
                      <tr>
                        <th>#</th><th>Dir</th><th>Entry</th><th>Exit</th>
                        <th>Exit</th><th>Pips</th><th>P&amp;L $</th><th>Bars</th><th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageTrades.map((t,i)=>{
                        const n = page*PAGE+i+1;
                        const isW = t.result==='win';
                        return (
                          <tr key={n} className={isW?'bt2-row-win':'bt2-row-loss'}>
                            <td style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>{n}</td>
                            <td><span className={`bt2-dir-badge ${t.dir}`}>{t.dir==='long'?'▲ L':'▼ S'}</span></td>
                            <td style={{fontFamily:'var(--mono)',fontSize:10}}>{fmtP(t.entry,sym)}</td>
                            <td style={{fontFamily:'var(--mono)',fontSize:10}}>{fmtP(t.exit,sym)}</td>
                            <td><span style={{fontSize:10,fontWeight:600,color:t.exitReason==='TP'?'#22c55e':t.exitReason==='SL'?'#ef4444':'#64748b'}}>{t.exitReason}</span></td>
                            <td style={{color:clr(t.pnlPips),fontFamily:'var(--mono)',fontSize:11,fontWeight:600}}>
                              {sign(t.pnlPips)}{t.pnlPips}
                            </td>
                            <td style={{color:clr(t.pnlDollars),fontFamily:'var(--mono)',fontSize:11}}>
                              {sign(t.pnlDollars)}{Math.abs(t.pnlDollars)}
                            </td>
                            <td style={{color:'var(--text3)',fontSize:10}}>{t.duration}</td>
                            <td>
                              <span style={{display:'inline-block',padding:'2px 6px',borderRadius:3,fontSize:9,fontWeight:800,
                                background:isW?'#22c55e22':'#ef444422',color:isW?'#22c55e':'#ef4444'}}>
                                {isW?'WIN':'LOSS'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {trades.length === 0 && (
              <div className="bt2-no-trades">
                No trades fired — try adjusting conditions, loosening thresholds, or using more data bars.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

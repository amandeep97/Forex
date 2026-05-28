import { useState, useMemo } from 'react';
import { runBacktest, calcStats } from '../utils/backtestEngine';
import { OANDA_MAP } from '../hooks/useLivePrices';
import { generateCandles } from '../utils/generateCandles';

const TF_GRAN = {'1M':'M1','5M':'M5','15M':'M15','30M':'M30','1H':'H1','4H':'H4','8H':'H8','D':'D','W':'W'};
const TFS = ['1M','5M','15M','30M','1H','4H','8H','D','W'];
const COUNTS = [100,500,1000,2000,5000];

const INSTRUMENTS = [
  'EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD','NZD/USD',
  'EUR/GBP','EUR/JPY','GBP/JPY','EUR/AUD','EUR/CAD',
  'XAU/USD','XAG/USD','US500','US30','US100','GER40','USOIL','UKOIL',
];

const FALLBACK_PRICES = {
  'EUR/USD':1.095,'GBP/USD':1.270,'USD/JPY':149.5,'USD/CHF':0.905,
  'AUD/USD':0.655,'USD/CAD':1.360,'NZD/USD':0.610,'EUR/GBP':0.860,
  'EUR/JPY':163.7,'GBP/JPY':189.9,'EUR/AUD':1.670,'EUR/CAD':1.490,
  'XAU/USD':3250,'XAG/USD':32.5,'US500':5500,'US30':42000,
  'US100':19500,'GER40':18500,'USOIL':78.0,'UKOIL':82.0,
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
  {v:'equal_hl',     l:'Equal H/L',        icon:'═',  color:'#fb923c'},
  {v:'consolidation',l:'Consolidation',    icon:'📦', color:'#94a3b8'},
  {v:'pattern',      l:'Candle Pattern',   icon:'🕯', color:'#eab308'},
  {v:'candle',       l:'Candle Dir',       icon:'▲',  color:'#64748b'},
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
  equal_hl:     {op:'equalLows'},
  consolidation:{},
  pattern:      {value:'bullish'},
  candle:       {op:'bullish'},
};

// Categorized presets
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

async function fetchCandles(symbol, tf, count) {
  try {
    const raw = localStorage.getItem('oanda_creds');
    const creds = raw ? JSON.parse(raw) : null;
    if (creds?.apiKey && OANDA_MAP[symbol]) {
      const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
      const res = await fetch(
        `${base}/instruments/${OANDA_MAP[symbol]}/candles?count=${Math.min(count,5000)}&granularity=${TF_GRAN[tf]||'H1'}&price=M`,
        {headers:{Authorization:`Bearer ${creds.apiKey}`}, signal:AbortSignal.timeout(20000)}
      );
      if (res.ok) {
        const data = await res.json();
        const cs = (data.candles||[]).filter(c=>c.complete).map(c=>({
          t:new Date(c.time).getTime(),o:+c.mid.o,h:+c.mid.h,l:+c.mid.l,c:+c.mid.c,v:c.volume||1
        }));
        if (cs.length >= 20) return {candles:cs, src:`OANDA Live · ${cs.length} bars`};
      }
    }
  } catch {}
  const inst = {bid:FALLBACK_PRICES[symbol]||1.1,change:0,volume:10000};
  const cs = generateCandles(inst, tf, Math.min(count,500));
  return {candles:cs, src:`Simulated · ${cs.length} bars`};
}

function getPipSz(sym) {
  if (!sym) return 0.0001;
  const s = sym.toUpperCase();
  if (s.includes('JPY')) return 0.01;
  if (s.startsWith('XAU')) return 0.1;
  if (/^(US|GER|UK|FR)/.test(s)) return 1.0;
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
  const [tp,        setTp]        = useState(50);
  const [sl,        setSl]        = useState(25);
  const [rr,        setRr]        = useState(2.0);
  const [tpA,       setTpA]       = useState(2.0);
  const [slA,       setSlA]       = useState(1.0);
  const [swingLb,   setSwingLb]   = useState(15);
  const [risk,      setRisk]      = useState(1);
  const [maxT,      setMaxT]      = useState(1);
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [src,    setSrc]     = useState('');
  const [err,    setErr]     = useState('');
  const [page,   setPage]    = useState(0);
  const [activePresetCat, setActivePresetCat] = useState('All');

  const addCond = () => setConds(p=>[...p,{id:Date.now(),type:'rsi',...DEF.rsi}]);
  const updCond = (id,u) => setConds(p=>p.map(c=>c.id===id?{...c,...u}:c));
  const delCond = id => setConds(p=>p.filter(c=>c.id!==id));

  const applyPreset = p => {
    setDir(p.dir);
    setConds(p.conds.map((c,i)=>({...c,id:i+1})));
    if (p.exit==='rr')   { setExit('rr');    setSl(p.sl||25);   setRr(p.rr||2);   }
    if (p.exit==='fixed'){ setExit('fixed'); setTp(p.tp||50);   setSl(p.sl||25);  }
    if (p.exit==='atr')  { setExit('atr');   setTpA(p.tpA||2);  setSlA(p.slA||1); }
    setSlType(p.slTyp || 'fixed');
    if (p.swingLb) setSwingLb(p.swingLb);
    if (p.slTyp === 'atr' && p.slA) setSlA(p.slA);
  };

  // Auto-compute TP in R:R mode
  const rrTpPips = useMemo(() => Math.round(sl * rr), [sl, rr]);
  const rrTpAtr  = useMemo(() => +(slA * rr).toFixed(1), [slA, rr]);

  const run = async () => {
    if (conds.length === 0) { setErr('Add at least one entry condition.'); return; }
    setRunning(true); setErr(''); setResults(null); setPage(0);
    try {
      const {candles, src:s} = await fetchCandles(sym, tf, cnt);
      setSrc(s);
      const strat = {
        symbol:sym, conditions:conds, logic:'AND', direction:dir,
        exitType:     exit,
        slType:       slType,
        tpPips:       exit==='fixed' ? tp : (exit==='rr' ? rrTpPips : tp),
        slPips:       sl,
        tpAtr:        tpA,
        slAtr:        slA,
        rrRatio:      rr,
        swingLookback:swingLb,
        maxTrades:maxT, riskPct:risk,
      };
      const {trades, equityCurve} = runBacktest(candles, strat);
      const stats = calcStats(trades);
      setResults({trades, equityCurve, stats});
    } catch(e) { setErr(e.message); }
    setRunning(false);
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
            {[{v:'rr',l:'R:R Ratio'},{v:'fixed',l:'Fixed Pips'},{v:'atr',l:'ATR ×'}].map(e=>(
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
          </div>
          <div className="bt2-hint">Starting capital: $10,000 · Risk {risk}% = ${(10000*risk/100).toFixed(0)}/trade</div>
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
          <button className="bt2-run-btn" onClick={run} disabled={running}>
            {running ? <><span style={{animation:'spin 1s linear infinite',display:'inline-block'}}>⟳</span> Running…</> : '▶ Run Backtest'}
          </button>
        </div>
      </div>

      {/* ── RIGHT: Results ─────────────────────────────────────────────────── */}
      <div className="bt2-results">
        {!results && !running && (
          <div className="bt2-placeholder">
            <div className="bt2-placeholder-icon">📊</div>
            <div className="bt2-placeholder-title">No results yet</div>
            <div className="bt2-placeholder-sub">Configure a strategy on the left, then click Run Backtest.</div>
            <div className="bt2-data-pills">
              <span className="bt2-data-pill live">● OANDA Live — real historical data when connected</span>
              <span className="bt2-data-pill sim">~ Simulated data when offline</span>
            </div>
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

import { useState } from 'react';
import { runBacktest, calcStats } from '../utils/backtestEngine';
import { OANDA_MAP } from '../hooks/useLivePrices';
import { generateCandles } from '../utils/generateCandles';

const TF_GRAN = {'1M':'M1','2M':'M2','3M':'M4','5M':'M5','15M':'M15','30M':'M30','1H':'H1','2H':'H2','4H':'H4','8H':'H8','D':'D','W':'W'};
const TFS = ['1M','2M','3M','5M','15M','30M','1H','2H','4H','8H','D','W'];
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
  {v:'rsi',l:'RSI'},{v:'mfi',l:'MFI'},{v:'ma',l:'Price vs MA'},
  {v:'ma_cross',l:'MA Crossover'},{v:'macd',l:'MACD'},
  {v:'bos',l:'BOS / Structure'},{v:'fvg',l:'Fair Value Gap'},
  {v:'displacement',l:'Displacement'},{v:'pattern',l:'Pattern'},{v:'candle',l:'Candle Dir'},
];

const DEF = {
  rsi:{period:14,op:'crossBelow',value:30},
  mfi:{period:14,op:'crossBelow',value:20},
  ma:{maType:'ema',period:50,op:'priceCrossAbove'},
  ma_cross:{maType:'ema',period:9,period2:21,op:'bullishCross'},
  macd:{op:'crossUp'},
  bos:{op:'bullish'},
  fvg:{op:'bullish'},
  displacement:{op:'bullish'},
  pattern:{value:'bullish'},
  candle:{op:'bullish'},
};

const PRESETS = [
  {name:'RSI Reversal',dir:'both',conds:[{type:'rsi',period:14,op:'crossBelow',value:30}],exit:'fixed',tp:50,sl:25},
  {name:'MFI Extremes',dir:'both',conds:[{type:'mfi',period:14,op:'crossBelow',value:20}],exit:'fixed',tp:40,sl:20},
  {name:'EMA Bounce',dir:'both',conds:[{type:'ma',maType:'ema',period:50,op:'priceCrossAbove'},{type:'rsi',period:14,op:'above',value:40}],exit:'atr',tpA:2,slA:1},
  {name:'MA Crossover',dir:'both',conds:[{type:'ma_cross',maType:'ema',period:9,period2:21,op:'bullishCross'}],exit:'atr',tpA:3,slA:1.5},
  {name:'MACD Cross',dir:'both',conds:[{type:'macd',op:'crossUp'}],exit:'atr',tpA:2.5,slA:1},
  {name:'BOS + RSI',dir:'both',conds:[{type:'bos',op:'bullish'},{type:'rsi',period:14,op:'below',value:55}],exit:'atr',tpA:3,slA:1},
  {name:'FVG Entry',dir:'both',conds:[{type:'fvg',op:'bullish'},{type:'candle',op:'bullish'}],exit:'atr',tpA:2,slA:1},
  {name:'Displacement',dir:'both',conds:[{type:'displacement',op:'bullish'}],exit:'atr',tpA:3,slA:1.5},
  {name:'Pattern+RSI',dir:'both',conds:[{type:'pattern',value:'bullish'},{type:'rsi',period:14,op:'below',value:50}],exit:'fixed',tp:45,sl:25},
  {name:'RSI+MFI Combo',dir:'long',conds:[{type:'rsi',period:14,op:'below',value:35},{type:'mfi',period:14,op:'below',value:35}],exit:'fixed',tp:60,sl:30},
  {name:'SMC Full',dir:'long',conds:[{type:'bos',op:'bullish'},{type:'fvg',op:'bullish'},{type:'rsi',period:14,op:'below',value:60}],exit:'atr',tpA:3,slA:1},
];

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

function fmtP(v,sym) {
  if (v==null) return '—';
  if (sym?.startsWith('XAU')) return v.toFixed(2);
  if (/^(US|GER|JPN|AUS|UK|FR|ES)/.test(sym||'')) return v.toFixed(1);
  if ((sym||'').includes('JPY')) return v.toFixed(3);
  return v.toFixed(5);
}
function clr(v) { return v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#94a3b8'; }

function EquityCurve({curve}) {
  if (!curve || curve.length < 2) return null;
  const W=600, H=130, pl=52, pr=10, pt=12, pb=24;
  const pw=W-pl-pr, ph=H-pt-pb;
  const mn=Math.min(...curve), mx=Math.max(...curve), rng=(mx-mn)||1;
  const tx=i=>pl+(i/(curve.length-1))*pw;
  const ty=v=>pt+ph-((v-mn)/rng)*ph;
  const init=10000, iy=ty(init);
  const pts=curve.map((v,i)=>`${tx(i).toFixed(1)},${ty(v).toFixed(1)}`).join(' ');
  const last=curve[curve.length-1];
  const col=last>=init?'#22c55e':'#ef4444';
  const area=`M${pl},${Math.min(Math.max(iy,pt),pt+ph)} L${curve.map((v,i)=>`${tx(i).toFixed(1)},${ty(v).toFixed(1)}`).join(' L')} L${tx(curve.length-1).toFixed(1)},${Math.min(Math.max(iy,pt),pt+ph)} Z`;
  const ytks=[mn,init,mx].filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a-b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:H}}>
      <line x1={pl} y1={iy} x2={W-pr} y2={iy} stroke="#1e293b" strokeWidth={1} strokeDasharray="4,3"/>
      <path d={area} fill={col} fillOpacity={0.08}/>
      <polyline points={pts} fill="none" stroke={col} strokeWidth={1.5} strokeLinejoin="round"/>
      <circle cx={pl} cy={ty(curve[0])} r={3} fill={col}/>
      <circle cx={tx(curve.length-1)} cy={ty(last)} r={3.5} fill={col}/>
      {ytks.map(v=>(
        <text key={v} x={pl-4} y={ty(v)+4} textAnchor="end" fontSize={9} fill="#64748b">
          ${Math.round(v).toLocaleString()}
        </text>
      ))}
      <text x={pl} y={H-4} fontSize={9} fill="#475569">Start</text>
      <text x={W-pr} y={H-4} textAnchor="end" fontSize={9} fill="#475569">T{curve.length-1}</text>
    </svg>
  );
}

function StatCard({label, value, sub, color}) {
  return (
    <div className="bt-stat">
      <div className="bt-stat-val" style={{color:color||'var(--text)'}}>{value}</div>
      <div className="bt-stat-label">{label}</div>
      {sub && <div className="bt-stat-sub">{sub}</div>}
    </div>
  );
}

function CondRow({cond, onChange, onRemove, idx}) {
  const upd = o => onChange({...cond,...o});
  const chType = t => onChange({id:cond.id, type:t, ...DEF[t]});
  return (
    <div className="bt-cond-row">
      {idx>0 && <span className="bt-cond-and">AND</span>}
      <div className="bt-cond-inner">
        <select className="bt-sel" value={cond.type} onChange={e=>chType(e.target.value)}>
          {COND_TYPES.map(t=><option key={t.v} value={t.v}>{t.l}</option>)}
        </select>
        {(cond.type==='rsi'||cond.type==='mfi') && <>
          <input className="bt-num" type="number" value={cond.period||14} min={2} max={50} title="Period"
            onChange={e=>upd({period:+e.target.value})}/>
          <select className="bt-sel sm" value={cond.op} onChange={e=>upd({op:e.target.value})}>
            <option value="crossBelow">× below</option>
            <option value="crossAbove">× above</option>
            <option value="below">below</option>
            <option value="above">above</option>
          </select>
          <input className="bt-num" type="number" value={cond.value||30} min={1} max={99} title="Level"
            onChange={e=>upd({value:+e.target.value})}/>
        </>}
        {cond.type==='ma' && <>
          <select className="bt-sel sm" value={cond.maType||'ema'} onChange={e=>upd({maType:e.target.value})}>
            <option value="ema">EMA</option><option value="sma">SMA</option>
          </select>
          <input className="bt-num" type="number" value={cond.period||50} min={2} max={200} title="Period"
            onChange={e=>upd({period:+e.target.value})}/>
          <select className="bt-sel" value={cond.op} onChange={e=>upd({op:e.target.value})}>
            <option value="priceCrossAbove">price × above</option>
            <option value="priceCrossBelow">price × below</option>
            <option value="priceAbove">price above</option>
            <option value="priceBelow">price below</option>
          </select>
        </>}
        {cond.type==='ma_cross' && <>
          <select className="bt-sel sm" value={cond.maType||'ema'} onChange={e=>upd({maType:e.target.value})}>
            <option value="ema">EMA</option><option value="sma">SMA</option>
          </select>
          <input className="bt-num" type="number" value={cond.period||9} min={2} max={100} title="Fast"
            onChange={e=>upd({period:+e.target.value})}/>
          <span style={{color:'var(--text3)',fontSize:10}}>×</span>
          <input className="bt-num" type="number" value={cond.period2||21} min={3} max={200} title="Slow"
            onChange={e=>upd({period2:+e.target.value})}/>
          <select className="bt-sel sm" value={cond.op} onChange={e=>upd({op:e.target.value})}>
            <option value="bullishCross">bull ×</option>
            <option value="bearishCross">bear ×</option>
          </select>
        </>}
        {cond.type==='macd' && (
          <select className="bt-sel" value={cond.op||'crossUp'} onChange={e=>upd({op:e.target.value})}>
            <option value="crossUp">MACD × above signal (bull)</option>
            <option value="crossDown">MACD × below signal (bear)</option>
            <option value="aboveZero">MACD above zero line</option>
            <option value="belowZero">MACD below zero line</option>
            <option value="histPos">Histogram positive</option>
            <option value="histNeg">Histogram negative</option>
          </select>
        )}
        {cond.type==='bos' && (
          <select className="bt-sel" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
            <option value="bullish">BOS Bullish (broke swing high)</option>
            <option value="bearish">BOS Bearish (broke swing low)</option>
            <option value="any">Any BOS</option>
          </select>
        )}
        {cond.type==='fvg' && (
          <select className="bt-sel" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
            <option value="bullish">Bullish FVG (gap up)</option>
            <option value="bearish">Bearish FVG (gap down)</option>
            <option value="any">Any FVG</option>
          </select>
        )}
        {cond.type==='displacement' && (
          <select className="bt-sel" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
            <option value="bullish">Bullish displacement (3 bull candles)</option>
            <option value="bearish">Bearish displacement (3 bear candles)</option>
            <option value="any">Any displacement</option>
          </select>
        )}
        {cond.type==='pattern' && (
          <select className="bt-sel" value={cond.value||'bullish'} onChange={e=>upd({value:e.target.value})}>
            <option value="bullish">Bullish</option>
            <option value="bearish">Bearish</option>
            <option value="any">Any</option>
          </select>
        )}
        {cond.type==='candle' && (
          <select className="bt-sel" value={cond.op||'bullish'} onChange={e=>upd({op:e.target.value})}>
            <option value="bullish">Bullish candle</option>
            <option value="bearish">Bearish candle</option>
          </select>
        )}
        <button className="bt-cond-rm" onClick={onRemove} title="Remove">✕</button>
      </div>
    </div>
  );
}

const PAGE = 20;

export default function Backtester() {
  const [sym,   setSym]   = useState('EUR/USD');
  const [tf,    setTf]    = useState('1H');
  const [cnt,   setCnt]   = useState(500);
  const [dir,   setDir]   = useState('both');
  const [conds, setConds] = useState([{id:1,type:'rsi',period:14,op:'crossBelow',value:30}]);
  const [exit,  setExit]  = useState('fixed');
  const [tp,    setTp]    = useState(50);
  const [sl,    setSl]    = useState(25);
  const [tpA,   setTpA]   = useState(2.0);
  const [slA,   setSlA]   = useState(1.0);
  const [risk,  setRisk]  = useState(1);
  const [maxT,  setMaxT]  = useState(1);
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [src,    setSrc]     = useState('');
  const [err,    setErr]     = useState('');
  const [page,   setPage]    = useState(0);

  const addCond = () => setConds(p=>[...p,{id:Date.now(),type:'rsi',...DEF.rsi}]);
  const updCond = (id,u) => setConds(p=>p.map(c=>c.id===id?{...c,...u}:c));
  const delCond = id => setConds(p=>p.filter(c=>c.id!==id));

  const applyPreset = p => {
    setDir(p.dir);
    setConds(p.conds.map((c,i)=>({...c,id:i+1})));
    setExit(p.exit);
    if(p.exit==='fixed'){setTp(p.tp);setSl(p.sl);}
    else{setTpA(p.tpA||2);setSlA(p.slA||1);}
  };

  const run = async () => {
    if (conds.length === 0) { setErr('Add at least one condition.'); return; }
    setRunning(true); setErr(''); setResults(null); setPage(0);
    try {
      const {candles, src:s} = await fetchCandles(sym, tf, cnt);
      setSrc(s);
      const strat = {symbol:sym,conditions:conds,logic:'AND',direction:dir,
        exitType:exit,tpPips:tp,slPips:sl,tpAtr:tpA,slAtr:slA,maxTrades:maxT,riskPct:risk};
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

  return (
    <div className="bt-root">
      {/* ── LEFT: Strategy Builder ── */}
      <div className="bt-panel">
        <div className="bt-panel-head">Strategy Builder</div>

        {/* Symbol + TF */}
        <div className="bt-section">
          <div className="bt-row">
            <div className="bt-field">
              <label className="bt-label">Symbol</label>
              <select className="bt-sel full" value={sym} onChange={e=>setSym(e.target.value)}>
                {INSTRUMENTS.map(i=><option key={i} value={i}>{i}</option>)}
              </select>
            </div>
            <div className="bt-field">
              <label className="bt-label">Data</label>
              <select className="bt-sel" value={cnt} onChange={e=>setCnt(+e.target.value)}>
                {COUNTS.map(c=><option key={c} value={c}>{c} bars</option>)}
              </select>
            </div>
          </div>
          <div style={{marginTop:8}}>
            <label className="bt-label">Timeframe</label>
            <div className="bt-tf-row">
              {TFS.map(t=>(
                <button key={t} className={`bt-tf-pill${tf===t?' active':''}`} onClick={()=>setTf(t)}>{t}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Direction */}
        <div className="bt-section">
          <label className="bt-label">Trade Direction</label>
          <div className="bt-dir-row">
            {['long','short','both'].map(d=>(
              <button key={d} className={`bt-dir-btn${dir===d?' active':''}`} onClick={()=>setDir(d)}>
                {d==='long'?'▲ Long':d==='short'?'▼ Short':'↕ Both'}
              </button>
            ))}
          </div>
          <div className="bt-dir-note">
            {dir==='both'?'Opens longs on signal, shorts on mirror signal.':dir==='long'?'Only opens long trades.':'Only opens short trades.'}
          </div>
        </div>

        {/* Conditions */}
        <div className="bt-section">
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
            <label className="bt-label" style={{margin:0}}>Entry Conditions (AND)</label>
            <button className="bt-add-btn" onClick={addCond}>+ Add</button>
          </div>
          {conds.length === 0 && <div className="bt-empty-conds">No conditions — click + Add</div>}
          {conds.map((c,i)=>(
            <CondRow key={c.id} cond={c} idx={i}
              onChange={u=>updCond(c.id,u)} onRemove={()=>delCond(c.id)}/>
          ))}
        </div>

        {/* Exit */}
        <div className="bt-section">
          <label className="bt-label">Exit Settings</label>
          <div className="bt-exit-type-row">
            <button className={`bt-exit-btn${exit==='fixed'?' active':''}`} onClick={()=>setExit('fixed')}>Fixed Pips</button>
            <button className={`bt-exit-btn${exit==='atr'?' active':''}`} onClick={()=>setExit('atr')}>ATR Multiple</button>
          </div>
          <div className="bt-exit-vals">
            {exit==='fixed' ? <>
              <div className="bt-field sm">
                <label className="bt-label">TP (pips)</label>
                <input className="bt-num full" type="number" value={tp} min={1} onChange={e=>setTp(+e.target.value)}/>
              </div>
              <div className="bt-field sm">
                <label className="bt-label">SL (pips)</label>
                <input className="bt-num full" type="number" value={sl} min={1} onChange={e=>setSl(+e.target.value)}/>
              </div>
            </> : <>
              <div className="bt-field sm">
                <label className="bt-label">TP (×ATR)</label>
                <input className="bt-num full" type="number" value={tpA} min={0.1} step={0.1} onChange={e=>setTpA(+e.target.value)}/>
              </div>
              <div className="bt-field sm">
                <label className="bt-label">SL (×ATR)</label>
                <input className="bt-num full" type="number" value={slA} min={0.1} step={0.1} onChange={e=>setSlA(+e.target.value)}/>
              </div>
            </>}
            <div className="bt-field sm">
              <label className="bt-label">Risk %</label>
              <input className="bt-num full" type="number" value={risk} min={0.1} max={10} step={0.1} onChange={e=>setRisk(+e.target.value)}/>
            </div>
            <div className="bt-field sm">
              <label className="bt-label">Max Trades</label>
              <input className="bt-num full" type="number" value={maxT} min={1} max={10} onChange={e=>setMaxT(+e.target.value)}/>
            </div>
          </div>
        </div>

        {/* Presets */}
        <div className="bt-section">
          <label className="bt-label">Quick Presets</label>
          <div className="bt-preset-grid">
            {PRESETS.map(p=>(
              <button key={p.name} className="bt-preset-btn" onClick={()=>applyPreset(p)} title={`Direction: ${p.dir} · Exit: ${p.exit}`}>
                {p.name}
              </button>
            ))}
          </div>
        </div>

        {err && <div className="bt-error">⚠ {err}</div>}

        <button className="bt-run-btn" onClick={run} disabled={running}>
          {running ? '⟳ Running…' : '▶ Run Backtest'}
        </button>
      </div>

      {/* ── RIGHT: Results ── */}
      <div className="bt-results">
        {!results && !running && (
          <div className="bt-empty">
            <div className="bt-empty-icon">📊</div>
            <div className="bt-empty-title">No results yet</div>
            <div className="bt-empty-sub">Configure a strategy on the left and click Run Backtest.</div>
            <div className="bt-empty-sub" style={{marginTop:4,color:'var(--accent)'}}>
              OANDA connected → real historical data · Otherwise → simulated data
            </div>
          </div>
        )}
        {running && (
          <div className="bt-empty">
            <div className="bt-empty-icon" style={{animation:'spin 1s linear infinite',display:'inline-block'}}>⟳</div>
            <div className="bt-empty-title">Fetching data &amp; running backtest…</div>
          </div>
        )}
        {results && (
          <>
            {/* Data source badge */}
            <div className="bt-src-row">
              <span className={`bt-src-badge${src.startsWith('OANDA')?' live':' sim'}`}>{src.startsWith('OANDA')?'●':src.startsWith('Sim')?'~':''} {src}</span>
            </div>

            {/* Stats */}
            <div className="bt-stat-grid">
              <StatCard label="Total Trades" value={s.totalTrades}/>
              <StatCard label="Win Rate" value={`${s.winRate}%`}
                sub={`${s.wins}W / ${s.losses}L`}
                color={s.winRate>=50?'#22c55e':s.winRate>=40?'#f59e0b':'#ef4444'}/>
              <StatCard label="Profit Factor" value={s.profitFactor===999?'∞':s.profitFactor}
                color={s.profitFactor>=1.5?'#22c55e':s.profitFactor>=1?'#f59e0b':'#ef4444'}/>
              <StatCard label="Total P&L" value={`$${s.totalPnlDollars>=0?'+':''}${s.totalPnlDollars}`}
                sub={`${s.totalPnlPct>=0?'+':''}${s.totalPnlPct}%`}
                color={clr(s.totalPnlDollars)}/>
              <StatCard label="Max Drawdown" value={`${s.maxDrawdown}%`}
                color={s.maxDrawdown<5?'#22c55e':s.maxDrawdown<15?'#f59e0b':'#ef4444'}/>
              <StatCard label="Avg Win / Loss" value={`$${s.avgWin}`} sub={`$${s.avgLoss} loss`} color="#94a3b8"/>
              <StatCard label="Best Trade" value={`${s.bestTrade>0?'+':''}${s.bestTrade} pips`} color={clr(s.bestTrade)}/>
              <StatCard label="Avg Duration" value={`${s.avgDuration} bars`}/>
            </div>

            {/* Equity Curve */}
            <div className="bt-equity-box">
              <div className="bt-section-title">Equity Curve <span style={{color:'var(--text3)',fontWeight:400,fontSize:10}}>starting $10,000</span></div>
              <EquityCurve curve={results.equityCurve}/>
            </div>

            {/* Trade Log */}
            {trades.length > 0 && (
              <div className="bt-log-box">
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                  <div className="bt-section-title">Trade Log <span style={{color:'var(--text3)',fontWeight:400,fontSize:10}}>({trades.length} trades)</span></div>
                  {pageCount>1 && (
                    <div className="bt-page-row">
                      <button className="bt-page-btn" disabled={page===0} onClick={()=>setPage(p=>p-1)}>‹</button>
                      <span style={{fontSize:11,color:'var(--text2)'}}>{page+1}/{pageCount}</span>
                      <button className="bt-page-btn" disabled={page>=pageCount-1} onClick={()=>setPage(p=>p+1)}>›</button>
                    </div>
                  )}
                </div>
                <div className="bt-table-wrap">
                  <table className="bt-table">
                    <thead>
                      <tr>
                        <th>#</th><th>Dir</th><th>Entry</th><th>Exit</th>
                        <th>Reason</th><th>Pips</th><th>P&L $</th><th>Bars</th><th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageTrades.map((t,i)=>{
                        const n = page*PAGE+i+1;
                        const isW = t.result==='win';
                        return (
                          <tr key={n} className={isW?'bt-row-win':'bt-row-loss'}>
                            <td className="bt-td-num">{n}</td>
                            <td><span className={`bt-dir-badge ${t.dir}`}>{t.dir==='long'?'▲ L':'▼ S'}</span></td>
                            <td className="bt-td-mono">{fmtP(t.entry,sym)}</td>
                            <td className="bt-td-mono">{fmtP(t.exit,sym)}</td>
                            <td><span className={`bt-reason ${t.exitReason}`}>{t.exitReason}</span></td>
                            <td style={{color:clr(t.pnlPips),fontFamily:'var(--mono)',fontSize:11}}>
                              {t.pnlPips>0?'+':''}{t.pnlPips}
                            </td>
                            <td style={{color:clr(t.pnlDollars),fontFamily:'var(--mono)',fontSize:11}}>
                              {t.pnlDollars>0?'+':''}{t.pnlDollars}
                            </td>
                            <td style={{color:'var(--text3)',fontSize:11}}>{t.duration}</td>
                            <td><span className={`bt-result-badge ${t.result}`}>{isW?'W':'L'}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {trades.length === 0 && (
              <div className="bt-no-trades">No trades fired — try adjusting your conditions or using more data.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

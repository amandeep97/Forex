import { useState, useEffect, useRef } from 'react';
import { OANDA_MAP } from '../hooks/useLivePrices';
import {
  detectSR, detectTrendlines, detectFVGsAndOBs, detectSweep,
  computeSwings, detectLiqLevels,
  computeEMASeries, computeVWAP, computePOC,
} from '../utils/smcHelpers';

const TFS    = ['M1','M5','M15','M30','H1','H4','D','W'];
const TV_TF  = { M1:'1',M5:'5',M15:'15',M30:'30',H1:'60',H4:'240',D:'D',W:'W' };

// Instrument format helpers
function toOandaInstr(symbol) { return (symbol||'').replace('/','_'); }
function toTVSymbol(symbol) {
  const s = (symbol||'').replace('/','').replace('_','');
  return `OANDA:${s}`;
}
function fmtP(v, symbol) {
  if (v == null) return '—';
  const s = symbol||'';
  if (s.startsWith('XAU')) return v.toFixed(2);
  if (/^(US|GER|JPN|AUS|UK)/.test(s)) return v.toFixed(1);
  if (s.includes('JPY')) return v.toFixed(3);
  return v.toFixed(5);
}

// Candle fetch from OANDA
async function fetchCandles(symbol, tf, count = 500) {
  const creds = (() => { try { return JSON.parse(localStorage.getItem('oanda_creds')); } catch { return null; } })();
  if (!creds?.apiKey) throw new Error('OANDA not connected — connect in the Screener first.');
  const instr = toOandaInstr(symbol);
  const base  = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
  const res   = await fetch(
    `${base}/instruments/${instr}/candles?granularity=${tf}&count=${count}&price=M`,
    { headers:{ Authorization:`Bearer ${creds.apiKey}` }, signal:AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`OANDA ${res.status}`);
  const data = await res.json();
  return (data.candles||[]).filter(c=>c.complete).map(c=>({
    t: new Date(c.time).getTime(),
    o:+c.mid.o, h:+c.mid.h, l:+c.mid.l, c:+c.mid.c, v:c.volume||1,
  }));
}

// ── SVG Chart ─────────────────────────────────────────────────────────────────
const OV_DEFS = [
  {k:'ema20', l:'EMA 20', c:'#22c55e'}, {k:'ema50',  l:'EMA 50',  c:'#f59e0b'},
  {k:'ema200',l:'EMA 200',c:'#ef4444'}, {k:'vwap',   l:'VWAP',    c:'#a78bfa'},
  {k:'poc',   l:'POC',    c:'#fbbf24'}, {k:'fvg',    l:'FVG',     c:'#00d4aa'},
  {k:'ob',    l:'OB',     c:'#22c55e'}, {k:'sr',     l:'S/R',     c:'#94a3b8'},
  {k:'tl',    l:'TL',     c:'#f59e0b'}, {k:'zones',  l:'Zones',   c:'#f59e0b'},
  {k:'sweep', l:'Sweep',  c:'#fb923c'}, {k:'swings', l:'Swings',  c:'#60a5fa'},
  {k:'liq',   l:'LIQ',   c:'#c084fc'},
];
const DEFAULT_OV = { ema20:true,ema50:true,ema200:false,vwap:true,poc:false,fvg:true,ob:true,sr:true,tl:true,zones:true,sweep:true,swings:false,liq:false };

function SVGChart({ candles, symbol, ov }) {
  const W=900, H=460, PL=8, PR=68, PT=18, PB=36;
  const pw=W-PL-PR, ph=H-PT-PB;

  if (!candles||candles.length<2) return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{width:'100%',flex:1,display:'block',minHeight:0}}>
      <text x={W/2} y={H/2} textAnchor="middle" fontSize={13} fill="#475569">No candle data</text>
    </svg>
  );

  const vis  = candles.slice(-120);
  const nv   = vis.length;
  const minP = Math.min(...vis.map(c=>c.l));
  const maxP = Math.max(...vis.map(c=>c.h));
  const pad  = (maxP-minP)*0.05 || 1;
  const pMin = minP-pad, pMax = maxP+pad;

  const xOf = i  => PL+(i/(nv-1))*pw;
  const yOf = p  => PT+ph-((p-pMin)/(pMax-pMin))*ph;
  const cw   = Math.max(2,(pw/nv)*0.65);

  const si   = candles.length-nv; // start index in full array
  const ema20v  = ov.ema20  ? computeEMASeries(candles,  20).slice(si) : [];
  const ema50v  = ov.ema50  ? computeEMASeries(candles,  50).slice(si) : [];
  const ema200v = ov.ema200 ? computeEMASeries(candles, 200).slice(si) : [];
  const vwapV   = ov.vwap   ? computeVWAP(candles).slice(si)           : [];
  const poc     = ov.poc    ? computePOC(vis)                           : null;

  const { fvgZones=[], obZones=[] } = (ov.fvg||ov.ob) ? detectFVGsAndOBs(vis) : {};
  const { supports=[], resistances=[] } = ov.sr ? detectSR(vis) : {};
  const { resistTL, supportTL } = ov.tl ? detectTrendlines(vis) : {};
  const sweep  = ov.sweep  ? detectSweep(vis)          : null;
  const { bsl=[], ssl=[] } = ov.liq ? detectLiqLevels(vis) : {};
  const swings = ov.swings ? computeSwings(vis)        : null;

  let premBot=null, discTop=null, eqTop=null, eqBot=null;
  if (ov.zones && nv >= 20) {
    const rH = Math.max(...vis.map(c=>c.h)), rL = Math.min(...vis.map(c=>c.l));
    const range = rH - rL;
    const mid = (rH + rL) / 2;
    premBot  = rH - range * 0.25;
    discTop  = rL + range * 0.25;
    eqTop    = mid + range * 0.1;
    eqBot    = mid - range * 0.1;
  }

  function linePath(vals, color, sw=1.5, dash='') {
    const d = [];
    for (let i=0;i<nv;i++) {
      if (vals[i]==null) continue;
      d.push(`${(i===0||vals[i-1]==null)?'M':'L'}${xOf(i).toFixed(1)},${yOf(vals[i]).toFixed(1)}`);
    }
    return d.length ? <path key={color+dash} d={d.join(' ')} fill="none" stroke={color} strokeWidth={sw} strokeDasharray={dash}/> : null;
  }

  const last = vis[nv-1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{width:'100%',flex:1,display:'block',background:'var(--bg2)',borderRadius:6,minHeight:0}}>
      {/* Grid */}
      {[0.2,0.4,0.6,0.8].map(f=>{
        const py=PT+ph*f, pr=pMax-f*(pMax-pMin);
        return <g key={f}>
          <line x1={PL} y1={py} x2={W-PR} y2={py} stroke="#1a2540" strokeWidth={1}/>
          <text x={W-PR+4} y={py+4} fontSize={8} fill="#334155">{fmtP(pr,symbol)}</text>
        </g>;
      })}

      {/* Zones: premium/discount/EQ */}
      {ov.zones && premBot && <>
        <rect x={PL} y={PT} width={pw} height={Math.max(2, yOf(premBot)-PT)}
          fill="#ef444418" stroke="#ef444444" strokeWidth={0.8}/>
        <text x={PL+5} y={PT+12} fontSize={9} fontWeight="700" fill="#ef4444aa">PREMIUM</text>
        <line x1={PL} y1={yOf(premBot)} x2={PL+pw} y2={yOf(premBot)} stroke="#ef444477" strokeWidth={1} strokeDasharray="5,3"/>

        <rect x={PL} y={yOf(discTop)} width={pw} height={Math.max(2, PT+ph-yOf(discTop))}
          fill="#22c55e18" stroke="#22c55e44" strokeWidth={0.8}/>
        <text x={PL+5} y={yOf(discTop)+12} fontSize={9} fontWeight="700" fill="#22c55eaa">DISCOUNT</text>
        <line x1={PL} y1={yOf(discTop)} x2={PL+pw} y2={yOf(discTop)} stroke="#22c55e77" strokeWidth={1} strokeDasharray="5,3"/>

        <rect x={PL} y={yOf(eqTop)} width={pw} height={Math.max(2, Math.abs(yOf(eqBot)-yOf(eqTop)))}
          fill="#f59e0b20" stroke="#f59e0b55" strokeWidth={0.8}/>
        <text x={PL+5} y={yOf(eqTop)+12} fontSize={9} fontWeight="700" fill="#f59e0baa">EQ</text>
      </>}

      {/* FVG */}
      {ov.fvg && fvgZones.map((z,i)=>z.startIdx<nv&&(
        <g key={`fvg${i}`}>
          <rect x={xOf(z.startIdx)} y={yOf(z.topPrice)}
            width={pw-xOf(z.startIdx)+PL} height={Math.max(2,Math.abs(yOf(z.botPrice)-yOf(z.topPrice)))}
            fill={z.type==='bullish'?'#00d4aa28':'#f4724428'}
            stroke={z.type==='bullish'?'#00d4aa':'#f47244'} strokeWidth={1} strokeDasharray="4,2"/>
          <text x={xOf(z.startIdx)+3} y={yOf(z.topPrice)+10} fontSize={8} fontWeight="700"
            fill={z.type==='bullish'?'#00d4aa':'#f47244'}>FVG</text>
        </g>
      ))}

      {/* OB */}
      {ov.ob && obZones.map((z,i)=>z.idx<nv&&(
        <g key={`ob${i}`}>
          <rect x={xOf(z.idx)} y={yOf(z.topPrice)}
            width={Math.min(cw*10, pw-xOf(z.idx)+PL)} height={Math.max(2,Math.abs(yOf(z.botPrice)-yOf(z.topPrice)))}
            fill={z.type==='bullish'?'#22c55e2a':'#ef44442a'}
            stroke={z.type==='bullish'?'#22c55e':'#ef4444'} strokeWidth={1.2} rx={2}/>
          <text x={xOf(z.idx)+3} y={yOf(z.topPrice)+10} fontSize={8} fontWeight="700"
            fill={z.type==='bullish'?'#22c55e':'#ef4444'}>
            {z.type==='bullish'?'Bull OB':'Bear OB'}
          </text>
        </g>
      ))}

      {/* S/R */}
      {ov.sr && <>
        {supports.map((s,i)=><g key={`s${i}`}>
          <line x1={PL} y1={yOf(s.price)} x2={W-PR} y2={yOf(s.price)} stroke="#22c55e" strokeWidth={1} strokeDasharray="4,3" opacity={0.55}/>
          <text x={W-PR+3} y={yOf(s.price)+4} fontSize={8} fill="#22c55e">S</text>
        </g>)}
        {resistances.map((r,i)=><g key={`r${i}`}>
          <line x1={PL} y1={yOf(r.price)} x2={W-PR} y2={yOf(r.price)} stroke="#ef4444" strokeWidth={1} strokeDasharray="4,3" opacity={0.55}/>
          <text x={W-PR+3} y={yOf(r.price)+4} fontSize={8} fill="#ef4444">R</text>
        </g>)}
      </>}

      {/* Trendlines */}
      {ov.tl && resistTL && <line x1={xOf(resistTL.x1)} y1={yOf(resistTL.y1)} x2={xOf(resistTL.x2)} y2={yOf(resistTL.y2)} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="6,3" opacity={0.8}/>}
      {ov.tl && supportTL && <line x1={xOf(supportTL.x1)} y1={yOf(supportTL.y1)} x2={xOf(supportTL.x2)} y2={yOf(supportTL.y2)} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="6,3" opacity={0.8}/>}

      {/* LIQ levels */}
      {ov.liq && <>
        {bsl.map((l,i)=><g key={`bsl${i}`}><line x1={PL} y1={yOf(l.price)} x2={W-PR} y2={yOf(l.price)} stroke="#c084fc" strokeWidth={1} strokeDasharray="3,2" opacity={0.7}/><text x={W-PR+3} y={yOf(l.price)+4} fontSize={7} fill="#c084fc">BSL</text></g>)}
        {ssl.map((l,i)=><g key={`ssl${i}`}><line x1={PL} y1={yOf(l.price)} x2={W-PR} y2={yOf(l.price)} stroke="#fb923c" strokeWidth={1} strokeDasharray="3,2" opacity={0.7}/><text x={W-PR+3} y={yOf(l.price)+4} fontSize={7} fill="#fb923c">SSL</text></g>)}
      </>}

      {/* POC */}
      {ov.poc && poc && <line x1={PL} y1={yOf(poc)} x2={W-PR} y2={yOf(poc)} stroke="#fbbf24" strokeWidth={1.5} opacity={0.8}/>}

      {/* EMA / VWAP */}
      {ov.ema20  && linePath(ema20v,  '#22c55e', 1.2)}
      {ov.ema50  && linePath(ema50v,  '#f59e0b', 1.2)}
      {ov.ema200 && linePath(ema200v, '#ef4444', 1.5)}
      {ov.vwap   && linePath(vwapV,   '#a78bfa', 1.5, '5,3')}

      {/* Candles */}
      {vis.map((c,i)=>{
        const x=xOf(i), bull=c.c>=c.o, col=bull?'#22c55e':'#ef4444';
        const bTop=yOf(Math.max(c.o,c.c)), bBot=yOf(Math.min(c.o,c.c));
        return <g key={i}>
          <line x1={x} y1={yOf(c.h)} x2={x} y2={yOf(c.l)} stroke={col} strokeWidth={1}/>
          <rect x={x-cw/2} y={bTop} width={cw} height={Math.max(1,bBot-bTop)} fill={col} opacity={0.85}/>
        </g>;
      })}

      {/* Sweep marker */}
      {ov.sweep && sweep && sweep.idx<nv && (
        <g>
          <circle cx={xOf(sweep.idx)} cy={yOf(sweep.price)} r={5} fill={sweep.type==='bullish'?'#22c55e':'#ef4444'} fillOpacity={0.25} stroke={sweep.type==='bullish'?'#22c55e':'#ef4444'} strokeWidth={1.5}/>
          <text x={xOf(sweep.idx)} y={yOf(sweep.price)-8} textAnchor="middle" fontSize={8} fill={sweep.type==='bullish'?'#22c55e':'#ef4444'}>SWP</text>
        </g>
      )}

      {/* Swing labels */}
      {ov.swings && swings && <>
        {swings.mid.hs.slice(-4).map((s,i)=>s.idx<nv&&<text key={`sh${i}`} x={xOf(s.idx)} y={yOf(s.price)-7} textAnchor="middle" fontSize={8} fill="#60a5fa">HH</text>)}
        {swings.mid.ls.slice(-4).map((s,i)=>s.idx<nv&&<text key={`sl${i}`} x={xOf(s.idx)} y={yOf(s.price)+12} textAnchor="middle" fontSize={8} fill="#f87171">LL</text>)}
      </>}

      {/* Last price label */}
      <rect x={W-PR+1} y={yOf(last.c)-9} width={PR-3} height={18} fill="#00d4aa" rx={3}/>
      <text x={W-PR+5} y={yOf(last.c)+5} fontSize={9} fill="#080c14" fontWeight="700">{fmtP(last.c,symbol)}</text>
    </svg>
  );
}

// ── TradingView widget ─────────────────────────────────────────────────────────
function TradingViewWidget({ symbol, interval }) {
  const ref = useRef(null);
  const id  = useRef(`tv_${Math.random().toString(36).slice(2)}`);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.id = id.current; wrap.style.cssText = 'width:100%;height:100%;';
    ref.current.appendChild(wrap);
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/tv.js'; s.async = true;
    s.onload = () => {
      if (!window.TradingView || !document.getElementById(id.current)) return;
      new window.TradingView.widget({
        container_id:id.current, symbol, interval,
        theme:'dark', style:'1', locale:'en', toolbar_bg:'#0d1321',
        enable_publishing:false, allow_symbol_change:true, autosize:true,
      });
    };
    ref.current.appendChild(s);
    return () => { if (ref.current) ref.current.innerHTML = ''; };
  }, [symbol, interval]);
  return <div ref={ref} style={{width:'100%',flex:1,minHeight:480}}/>;
}

// ── Default checklist ──────────────────────────────────────────────────────────
const DEF_RULES = [
  'Price is in premium or discount zone',
  'BOS or ChoCh confirmed on this TF',
  'FVG or OB present as entry point',
  'Clear SL level identified (swing low/high)',
  'Risk/reward is at least 1:2',
  'No major news in next 2 hours',
  'Higher timeframe structure aligns',
];

// ── ChartModal ─────────────────────────────────────────────────────────────────
export default function ChartModal({ instrument, onClose }) {
  const symbol = instrument?.symbol || 'EUR/USD';

  const [tf,       setTf]       = useState('H4');
  const [tab,      setTab]      = useState('chart');
  const [candles,  setCandles]  = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [loadErr,  setLoadErr]  = useState('');
  const [ov,       setOv]       = useState(DEFAULT_OV);
  const [aiRead,   setAiRead]   = useState(null);
  const [aiRL,     setAiRL]     = useState(false);
  const [analysis, setAnalysis] = useState('');
  const [analyLL,  setAnalyLL]  = useState(false);
  const [rules,    setRules]    = useState(DEF_RULES);
  const [newRule,  setNewRule]  = useState('');
  const [checks,   setChecks]   = useState({});

  // Fetch candles when tf or tab=chart changes
  useEffect(() => {
    if (tab !== 'chart') return;
    setLoading(true); setLoadErr(''); setCandles(null);
    fetchCandles(symbol, tf, 500)
      .then(cs => setCandles(cs))
      .catch(e => setLoadErr(e.message))
      .finally(() => setLoading(false));
  }, [symbol, tf, tab]);

  const toggleOv = k => setOv(o => ({ ...o, [k]: !o[k] }));

  // AI Auto-Read (requires anthropic_key in localStorage)
  const doAutoRead = async () => {
    if (!candles?.length) return;
    setAiRL(true);
    try {
      const { supports, resistances } = detectSR(candles);
      const { fvgZones } = detectFVGsAndOBs(candles);
      const last = candles[candles.length-1];
      const prompt = `SMC Forex analyst. Pair: ${symbol}, TF: ${tf}. Last close: ${fmtP(last.c,symbol)}.
Supports: ${supports.slice(0,2).map(s=>fmtP(s.price,symbol)).join(', ')}.
Resistances: ${resistances.slice(0,2).map(r=>fmtP(r.price,symbol)).join(', ')}.
Active FVGs: ${fvgZones.map(f=>f.type).join(', ')||'none'}.
Reply ONLY with JSON: {"bias":"Bullish|Bearish|Neutral","quality":"A|B|C","entry":"${symbol.includes('JPY')?'xxx.xxx':'x.xxxxx'}","stop":"${symbol.includes('JPY')?'xxx.xxx':'x.xxxxx'}","reason":"one sentence max"}`;
      const key = localStorage.getItem('anthropic_key');
      if (!key) { setAiRead({bias:'N/A',quality:'—',entry:'—',stop:'—',reason:'Add anthropic_key to localStorage'}); setAiRL(false); return; }
      const res = await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},
        body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:180,messages:[{role:'user',content:prompt}]})
      });
      const d = await res.json();
      const text = d.content?.[0]?.text||'{}';
      const m = text.match(/\{[\s\S]*\}/);
      setAiRead(m ? JSON.parse(m[0]) : {bias:'Error',quality:'—',entry:'—',stop:'—',reason:'Parse failed'});
    } catch(e) { setAiRead({bias:'Error',quality:'—',entry:'—',stop:'—',reason:e.message}); }
    setAiRL(false);
  };

  // AI Deep Analysis
  const doAnalysis = async () => {
    if (!candles?.length) return;
    setAnalyLL(true); setAnalysis('');
    try {
      const { supports, resistances } = detectSR(candles);
      const { fvgZones, obZones } = detectFVGsAndOBs(candles);
      const sw = computeSwings(candles);
      const last = candles[candles.length-1];
      const prompt = `Perform a detailed SMC analysis for ${symbol} on ${tf} timeframe.
Last close: ${fmtP(last.c,symbol)}. Candles analysed: ${candles.length}.
Supports: ${supports.map(s=>fmtP(s.price,symbol)).join(', ')}.
Resistances: ${resistances.map(r=>fmtP(r.price,symbol)).join(', ')}.
Active FVGs: ${fvgZones.length} (${fvgZones.map(f=>f.type).join(', ')||'none'}).
Active OBs: ${obZones.length}.
ATR: ${sw?.atr?.toFixed(5)||'—'}.

Provide:
1. Market Structure (BOS/ChoCh, trend)
2. Key Zones (OBs, FVGs, premium/discount)
3. Trade Setup (direction, entry zone, invalidation)
4. Specific levels: Entry / Stop Loss / Take Profit
5. Confluence & Risk Notes`;
      const key = localStorage.getItem('anthropic_key');
      if (!key) { setAnalysis('Set anthropic_key in localStorage to use AI analysis.\n\nOpen console → localStorage.setItem("anthropic_key","sk-ant-...")'); setAnalyLL(false); return; }
      const res = await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},
        body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:700,messages:[{role:'user',content:prompt}]})
      });
      const d = await res.json();
      setAnalysis(d.content?.[0]?.text||'No response');
    } catch(e) { setAnalysis(`Error: ${e.message}`); }
    setAnalyLL(false);
  };

  const tvSym = toTVSymbol(symbol);
  const tvInt = TV_TF[tf] || '240';
  const biasColor = { bullish:'#22c55e', bearish:'#ef4444', neutral:'#94a3b8' };

  return (
    <div className="cm-overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="cm-modal">

        {/* ── Header ── */}
        <div className="cm-header">
          {/* Symbol — always visible, shrinks last */}
          <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}}>
            <span style={{fontSize:15,fontWeight:700}}>{symbol}</span>
            <span style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--mono)'}}>{tf}</span>
          </div>
          {/* Scrollable tab strip */}
          <div className="cm-tab-strip">
            {[{k:'chart',l:'📈 Chart'},{k:'tv',l:'📺 TradingView'},{k:'ai',l:'🤖 Analysis'},{k:'checklist',l:'✅ Checklist'}].map(t=>(
              <button key={t.k} className={`cm-tab-btn${tab===t.k?' active':''}`} onClick={()=>setTab(t.k)}>{t.l}</button>
            ))}
          </div>
          {/* Close — always pinned right, never hidden */}
          <button className="cm-close-btn" onClick={onClose} style={{flexShrink:0,marginLeft:4}}>✕</button>
        </div>

        {/* ── Chart Tab ── */}
        {tab==='chart' && (
          <div className="cm-body">
            {/* Toolbar: TF + overlays */}
            <div className="cm-toolbar">
              <div className="cm-tf-row">
                {TFS.map(t=><button key={t} className={`cm-tf-pill${tf===t?' active':''}`} onClick={()=>setTf(t)}>{t}</button>)}
              </div>
              <div className="cm-ov-row">
                {OV_DEFS.map(o=>(
                  <button key={o.k} className={`cm-ov-btn${ov[o.k]?' active':''}`}
                    style={ov[o.k]?{borderColor:o.c+'66',color:o.c}:{}} onClick={()=>toggleOv(o.k)}>{o.l}</button>
                ))}
              </div>
            </div>

            {/* AI Auto-Read bar */}
            <div className="cm-autoread">
              <button className="cm-autoread-btn" onClick={doAutoRead} disabled={aiRL||!candles}>
                {aiRL?'⟳ Reading…':'⚡ AI Auto-Read'}
              </button>
              {aiRead && (
                <div className="cm-autoread-result">
                  <span className="cm-bias-pill" style={{color:biasColor[aiRead.bias?.toLowerCase()]||'#94a3b8',borderColor:(biasColor[aiRead.bias?.toLowerCase()]||'#94a3b8')+'55',background:(biasColor[aiRead.bias?.toLowerCase()]||'#94a3b8')+'12'}}>
                    {aiRead.bias}
                  </span>
                  <span className="cm-ar-chip">Q: {aiRead.quality}</span>
                  <span className="cm-ar-chip">Entry: {aiRead.entry}</span>
                  <span className="cm-ar-chip">Stop: {aiRead.stop}</span>
                  <span style={{fontSize:11,color:'var(--text2)',flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{aiRead.reason}</span>
                </div>
              )}
            </div>

            {/* Chart area */}
            <div className="cm-chart-wrap">
              {loading && <div className="cm-state">⟳ Fetching {symbol} {tf} candles…</div>}
              {loadErr && <div className="cm-state cm-err">⚠ {loadErr}</div>}
              {!loading && !loadErr && candles && <SVGChart candles={candles} symbol={symbol} ov={ov}/>}
            </div>
          </div>
        )}

        {/* ── TradingView Tab ── */}
        {tab==='tv' && (
          <div className="cm-body">
            <div className="cm-toolbar">
              <div className="cm-tf-row">
                {TFS.map(t=><button key={t} className={`cm-tf-pill${tf===t?' active':''}`} onClick={()=>setTf(t)}>{t}</button>)}
              </div>
              <span style={{fontSize:11,color:'var(--text3)'}}>Symbol: {tvSym}</span>
            </div>
            <div style={{flex:1,display:'flex',flexDirection:'column'}}>
              <TradingViewWidget symbol={tvSym} interval={tvInt}/>
            </div>
          </div>
        )}

        {/* ── AI Analysis Tab ── */}
        {tab==='ai' && (
          <div className="cm-body cm-ai-body">
            <div className="cm-ai-panel">
              <div className="cm-section-title">AI Setup Analysis — {symbol} {tf}</div>
              <div className="cm-tf-row" style={{marginBottom:10}}>
                {TFS.map(t=><button key={t} className={`cm-tf-pill${tf===t?' active':''}`} onClick={()=>setTf(t)}>{t}</button>)}
              </div>
              <button className="cm-run-btn" onClick={doAnalysis} disabled={analyLL}>
                {analyLL?'⟳ Analysing…':'🔍 Run Deep Analysis'}
              </button>
              {analysis && <div className="cm-analysis-text">{analysis}</div>}
              <div className="cm-ai-hint">
                Set <code>anthropic_key</code> in browser console:<br/>
                <code>localStorage.setItem('anthropic_key','sk-ant-...')</code>
              </div>
            </div>
          </div>
        )}

        {/* ── Checklist Tab ── */}
        {tab==='checklist' && (
          <div className="cm-body cm-check-body">
            <div className="cm-check-panel">
              <div className="cm-section-title">Pre-Trade Checklist — {symbol}</div>
              {rules.map((r,i)=>(
                <div key={i} className="cm-check-row">
                  <button className={`cm-check-toggle ${checks[i]||'none'}`}
                    onClick={()=>setChecks(c=>({...c,[i]:c[i]==='pass'?'fail':c[i]==='fail'?'none':'pass'}))}>
                    {checks[i]==='pass'?'✅':checks[i]==='fail'?'❌':'○'}
                  </button>
                  <span style={{flex:1,fontSize:12,color:'var(--text2)'}}>{r}</span>
                  <button className="cm-rm-btn" onClick={()=>{setRules(p=>p.filter((_,j)=>j!==i));const c={...checks};delete c[i];setChecks(c);}}>✕</button>
                </div>
              ))}
              <div className="cm-check-add">
                <input className="cm-check-input" value={newRule} placeholder="Add custom rule…"
                  onChange={e=>setNewRule(e.target.value)}
                  onKeyDown={e=>{if(e.key==='Enter'&&newRule.trim()){setRules(p=>[...p,newRule.trim()]);setNewRule('');}}}/>
                <button className="bt-add-btn" onClick={()=>{if(newRule.trim()){setRules(p=>[...p,newRule.trim()]);setNewRule('');}}}>+ Add</button>
              </div>
              <div className="cm-score">
                {Object.values(checks).filter(v=>v==='pass').length} / {rules.length} checks passed
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

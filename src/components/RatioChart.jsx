import { useState, useEffect } from 'react';
import { OANDA_MAP } from '../hooks/useLivePrices';
import { generateCandles } from '../utils/generateCandles';

const TF_GRAN = { '1H':'H1','4H':'H4','D':'D','W':'W' };
const TFS     = ['1H','4H','D','W'];
const COUNTS  = { '1H':200, '4H':200, 'D':300, 'W':200 };

const FALLBACK = {
  'XAU/USD': { bid:3250, change:0, volume:1000 },
  'XAG/USD': { bid:32.5, change:0, volume:1000 },
};

async function fetchRawCandles(symbol, tf, count) {
  try {
    const raw   = localStorage.getItem('oanda_creds');
    const creds = raw ? JSON.parse(raw) : null;
    if (creds?.apiKey && OANDA_MAP[symbol]) {
      const base = creds.practice
        ? 'https://api-fxpractice.oanda.com/v3'
        : 'https://api-fxtrade.oanda.com/v3';
      const res = await fetch(
        `${base}/instruments/${OANDA_MAP[symbol]}/candles?count=${Math.min(count,5000)}&granularity=${TF_GRAN[tf]||'H4'}&price=M`,
        { headers:{ Authorization:`Bearer ${creds.apiKey}` }, signal:AbortSignal.timeout(20000) }
      );
      if (res.ok) {
        const data = await res.json();
        const cs = (data.candles||[]).filter(c=>c.complete).map(c=>({
          t:new Date(c.time).getTime(),
          o:+c.mid.o, h:+c.mid.h, l:+c.mid.l, c:+c.mid.c, v:c.volume||1,
        }));
        if (cs.length >= 20) return { candles:cs, live:true };
      }
    }
  } catch {}
  const inst = FALLBACK[symbol] || { bid:1, change:0, volume:1000 };
  const cs   = generateCandles(inst, tf, Math.min(count, 250));
  return { candles:cs, live:false };
}

function calcRatio(xau, xag) {
  const len = Math.min(xau.length, xag.length);
  const a   = xau.slice(-len);
  const b   = xag.slice(-len);
  return a.map((c, i) => ({
    t: c.t,
    o: c.o / b[i].o,
    h: c.h / b[i].l,   // max possible ratio in bar
    l: c.l / b[i].h,   // min possible ratio in bar
    c: c.c / b[i].c,
  }));
}

// ── SVG Candlestick chart ─────────────────────────────────────────────────────
function CandleChart({ candles, keyLevels = [] }) {
  if (!candles || candles.length < 2) return null;

  const W=900, H=380, pl=56, pr=16, pt=16, pb=32;
  const pw = W-pl-pr, ph = H-pt-pb;

  const vis = candles.slice(-150);
  const n   = vis.length;

  const mn  = Math.min(...vis.map(c=>c.l));
  const mx  = Math.max(...vis.map(c=>c.h));
  const rng = (mx - mn) || 1;

  const cx  = i  => pl + (i / (n - 1)) * pw;
  const cy  = v  => pt + ph - ((v - mn) / rng) * ph;
  const cw  = Math.max(1.5, pw / n * 0.55);

  const ticks   = 7;
  const tickV   = Array.from({length:ticks}, (_,i) => mn + (rng/(ticks-1))*i);

  // X-axis labels (show ~6 evenly spaced dates)
  const xLabels = [0, Math.floor(n/5), Math.floor(2*n/5), Math.floor(3*n/5), Math.floor(4*n/5), n-1]
    .filter((v,i,a) => a.indexOf(v)===i && v < n)
    .map(i => ({ i, label: new Date(vis[i].t).toLocaleDateString([], {month:'short',day:'numeric'}) }));

  const last = vis[n-1].c;
  const prev = vis[n-2].c;
  const isUp = last >= prev;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'auto',display:'block'}}>
      {/* Chart background */}
      <rect x={pl} y={pt} width={pw} height={ph} fill="#0a0f1a" rx={3}/>

      {/* Y grid + labels */}
      {tickV.map((v,i)=>(
        <g key={i}>
          <line x1={pl} y1={cy(v)} x2={pl+pw} y2={cy(v)} stroke="#1a2535" strokeWidth={1}/>
          <text x={pl-5} y={cy(v)+4} textAnchor="end" fontSize={9} fill="#475569">
            {v.toFixed(1)}
          </text>
        </g>
      ))}

      {/* Key levels */}
      {keyLevels.filter(l=>l>=mn&&l<=mx).map(l=>(
        <g key={l}>
          <line x1={pl} y1={cy(l)} x2={pl+pw} y2={cy(l)}
            stroke="#334155" strokeWidth={1.2} strokeDasharray="5,4"/>
          <rect x={pl+4} y={cy(l)-10} width={28} height={12} fill="#1e293b" rx={2}/>
          <text x={pl+18} y={cy(l)+0} textAnchor="middle" fontSize={8} fill="#94a3b8">{l}</text>
        </g>
      ))}

      {/* Candles */}
      {vis.map((c,i) => {
        const bTop = cy(Math.max(c.o,c.c));
        const bBot = cy(Math.min(c.o,c.c));
        const bH   = Math.max(1, bBot - bTop);
        const bull = c.c >= c.o;
        const col  = bull ? '#22c55e' : '#ef4444';
        return (
          <g key={i}>
            <line x1={cx(i)} y1={cy(c.h)} x2={cx(i)} y2={cy(c.l)} stroke={col} strokeWidth={1}/>
            <rect x={cx(i)-cw/2} y={bTop} width={cw} height={bH} fill={col} opacity={0.9} rx={0.5}/>
          </g>
        );
      })}

      {/* Current price dashed line */}
      <line x1={pl} y1={cy(last)} x2={pl+pw} y2={cy(last)}
        stroke="#00d4aa" strokeWidth={1} strokeDasharray="4,3" opacity={0.8}/>
      <rect x={pl+pw-2} y={cy(last)-9} width={46} height={16} fill="#00d4aa" rx={3}/>
      <text x={pl+pw+21} y={cy(last)+4} textAnchor="middle" fontSize={9} fill="#000" fontWeight={700}>
        {last.toFixed(2)}
      </text>

      {/* X axis labels */}
      <line x1={pl} y1={pt+ph} x2={pl+pw} y2={pt+ph} stroke="#1e293b" strokeWidth={1}/>
      {xLabels.map(({i,label})=>(
        <text key={i} x={cx(i)} y={pt+ph+14} textAnchor="middle" fontSize={8} fill="#475569">
          {label}
        </text>
      ))}
    </svg>
  );
}

// ── Context card ──────────────────────────────────────────────────────────────
function CtxCard({ value, label, color, sub }) {
  return (
    <div className="ratio-ctx-card" style={{borderTopColor: color}}>
      <div className="ratio-ctx-val" style={{color}}>{value}</div>
      <div className="ratio-ctx-label">{label}</div>
      {sub && <div className="ratio-ctx-sub">{sub}</div>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function RatioChart() {
  const [tf,     setTf]     = useState('4H');
  const [candles,setCandles]= useState([]);
  const [loading,setLoading]= useState(false);
  const [live,   setLive]   = useState(false);

  const load = async () => {
    setLoading(true);
    const [xauR, xagR] = await Promise.all([
      fetchRawCandles('XAU/USD', tf, COUNTS[tf]||200),
      fetchRawCandles('XAG/USD', tf, COUNTS[tf]||200),
    ]);
    const ratio = calcRatio(xauR.candles, xagR.candles);
    setCandles(ratio);
    setLive(xauR.live && xagR.live);
    setLoading(false);
  };

  useEffect(() => { load(); }, [tf]);

  const cur  = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev5= candles[candles.length - 6];

  const dir     = cur && prev ? (cur.c > prev.c ? 'up' : 'down') : null;
  const chg5    = cur && prev5 ? ((cur.c - prev5.c) / prev5.c * 100).toFixed(2) : null;

  const zone = !cur ? '—'
    : cur.c > 80 ? 'Extreme High'
    : cur.c > 65 ? 'High'
    : cur.c > 55 ? 'Normal'
    : cur.c > 45 ? 'Low'
    : 'Extreme Low';

  const zoneColor = !cur ? '#64748b'
    : cur.c > 80 ? '#ef4444'
    : cur.c > 65 ? '#f97316'
    : cur.c > 55 ? '#94a3b8'
    : cur.c > 45 ? '#22c55e'
    : '#00d4aa';

  const metalSignal = dir === 'down'
    ? { text:'Metals BULLISH', sub:'XAG rising faster', color:'#22c55e' }
    : dir === 'up'
    ? { text:'Metals BEARISH', sub:'XAG falling faster', color:'#ef4444' }
    : null;

  // Suggested trade based on ratio direction + zone
  const tradeHint = !cur ? null
    : dir === 'down' && cur.c > 65
    ? { text:'XAG Long', sub:'Ratio falling from high zone', color:'#22c55e' }
    : dir === 'up' && cur.c < 55
    ? { text:'XAG Short', sub:'Ratio rising from low zone', color:'#ef4444' }
    : dir === 'down'
    ? { text:'XAU/XAG Long', sub:'Ratio falling, metals up', color:'#22c55e' }
    : { text:'XAU/XAG Short', sub:'Ratio rising, metals down', color:'#ef4444' };

  // Key levels to show on chart
  const KEY_LEVELS = [45, 55, 65, 80];

  return (
    <div className="ratio-root">

      {/* Header */}
      <div className="ratio-header">
        <div>
          <div className="ratio-title">⚖ Gold / Silver Ratio</div>
          <div className="ratio-sub">
            XAU ÷ XAG · How many oz of silver = 1 oz of gold
            <span className={`ratio-src-badge ${live?'live':'sim'}`}>
              {live ? '● Live' : '~ Simulated'}
            </span>
          </div>
        </div>
        <div style={{textAlign:'right'}}>
          {cur && <div className="ratio-big-val">{cur.c.toFixed(2)}</div>}
          {dir && (
            <div style={{fontSize:11, color: dir==='down'?'#22c55e':'#ef4444', fontWeight:700}}>
              {dir==='down' ? '▼ Falling' : '▲ Rising'}
              {chg5 && ` · ${chg5 > 0?'+':''}${chg5}% (5 bars)`}
            </div>
          )}
        </div>
      </div>

      {/* TF + refresh controls */}
      <div className="ratio-controls">
        <div className="ratio-tf-row">
          {TFS.map(t=>(
            <button key={t} className={`ratio-tf-btn${tf===t?' active':''}`} onClick={()=>setTf(t)}>{t}</button>
          ))}
        </div>
        <button className="ratio-refresh-btn" onClick={load} disabled={loading}>
          {loading ? '⟳' : '⟳ Refresh'}
        </button>
      </div>

      {/* Context cards */}
      <div className="ratio-ctx-row">
        <CtxCard
          value={cur ? cur.c.toFixed(1) : '—'}
          label="Current Ratio"
          color={zoneColor}
          sub={zone}
        />
        <CtxCard
          value={dir === 'down' ? '▼' : dir === 'up' ? '▲' : '—'}
          label="Direction"
          color={dir === 'down' ? '#22c55e' : '#ef4444'}
          sub={dir === 'down' ? 'Metals up' : 'Metals down'}
        />
        <CtxCard
          value={metalSignal?.text || '—'}
          label="Metal Signal"
          color={metalSignal?.color || '#64748b'}
          sub={metalSignal?.sub}
        />
        <CtxCard
          value={tradeHint?.text || '—'}
          label="Trade Idea"
          color={tradeHint?.color || '#64748b'}
          sub={tradeHint?.sub}
        />
      </div>

      {/* Chart */}
      <div className="ratio-chart-wrap">
        {loading ? (
          <div className="ratio-loading">
            <span style={{fontSize:28,animation:'spin 1s linear infinite',display:'inline-block'}}>⟳</span>
            <div style={{marginTop:8,fontSize:13,color:'var(--text3)'}}>Loading XAU & XAG candles…</div>
          </div>
        ) : candles.length > 0 ? (
          <CandleChart candles={candles} keyLevels={KEY_LEVELS}/>
        ) : (
          <div className="ratio-loading">No data available</div>
        )}
      </div>

      {/* How to use section */}
      <div className="ratio-guide">
        <div className="ratio-guide-title">How to read this chart</div>
        <div className="ratio-guide-grid">
          <div className="ratio-guide-item bull">
            <div className="ratio-guide-icon">▼</div>
            <div>
              <div className="ratio-guide-label">Ratio Falling</div>
              <div className="ratio-guide-text">Silver outperforming gold → Both metals likely rising. XAG gives bigger % move. Look for longs on XAU &amp; XAG.</div>
            </div>
          </div>
          <div className="ratio-guide-item bear">
            <div className="ratio-guide-icon">▲</div>
            <div>
              <div className="ratio-guide-label">Ratio Rising</div>
              <div className="ratio-guide-text">Gold outperforming silver → Both metals likely falling. Silver drops harder. Look for shorts or avoid longs.</div>
            </div>
          </div>
          <div className="ratio-guide-item neutral">
            <div className="ratio-guide-icon">80+</div>
            <div>
              <div className="ratio-guide-label">Ratio Extreme High</div>
              <div className="ratio-guide-text">Silver historically cheap vs gold. High probability of ratio reverting down → strong XAG long opportunity incoming.</div>
            </div>
          </div>
          <div className="ratio-guide-item neutral">
            <div className="ratio-guide-icon">45-</div>
            <div>
              <div className="ratio-guide-label">Ratio Extreme Low</div>
              <div className="ratio-guide-text">Silver historically expensive vs gold. Ratio likely to revert up → metals may weaken or gold outperforms.</div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';

// ── Config ────────────────────────────────────────────────────────────────────
const PAIRS = [
  { key:'EUR_USD', label:'EUR/USD', pip:0.0001 },
  { key:'GBP_USD', label:'GBP/USD', pip:0.0001 },
  { key:'USD_JPY', label:'USD/JPY', pip:0.01   },
  { key:'XAU_USD', label:'XAU/USD', pip:0.1    },
  { key:'GBP_JPY', label:'GBP/JPY', pip:0.01   },
  { key:'EUR_JPY', label:'EUR/JPY', pip:0.01   },
  { key:'USD_CAD', label:'USD/CAD', pip:0.0001 },
  { key:'AUD_USD', label:'AUD/USD', pip:0.0001 },
  { key:'NZD_USD', label:'NZD/USD', pip:0.0001 },
];

const LS_KEY = 'alpha_lab_v2';

const PHASES = {
  accumulation: { color:'#f59e0b', glow:'#f59e0b44', label:'ACCUMULATING', icon:'◎', desc:'Coiling — big move coming' },
  manipulation: { color:'#ef4444', glow:'#ef444466', label:'MANIPULATION',  icon:'⚡', desc:'Liquidity sweep detected' },
  distribution: { color:'#00d4aa', glow:'#00d4aa44', label:'DISTRIBUTION',  icon:'▶', desc:'Real move in progress'   },
  neutral:      { color:'#334155', glow:'transparent', label:'NEUTRAL',     icon:'·', desc:'No clear phase'          },
};

// ── OANDA ─────────────────────────────────────────────────────────────────────
function getCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) return c;
  } catch {}
  const apiKey  = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}

async function fetchCandles(pair, gran, count) {
  const creds = getCreds();
  if (!creds?.apiKey) return null;
  const base = creds.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  try {
    const r = await fetch(
      `${base}/instruments/${pair}/candles?granularity=${gran}&count=${count}&price=M`,
      { headers:{ Authorization:`Bearer ${creds.apiKey}` }, signal:AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return (d.candles||[]).filter(c=>c.complete).map(c=>({
      o:+c.mid.o, h:+c.mid.h, l:+c.mid.l, c:+c.mid.c,
      t:new Date(c.time).getTime(), v:c.volume||0,
    }));
  } catch { return null; }
}

// ── Algorithms ────────────────────────────────────────────────────────────────
function avgBody(candles) {
  return candles.reduce((s,c)=>s+Math.abs(c.c-c.o),0)/(candles.length||1);
}
function avgRange(candles) {
  return candles.reduce((s,c)=>s+(c.h-c.l),0)/(candles.length||1);
}
function computeATR(candles, p=14) {
  if (!candles||candles.length<p+1) return 0;
  let s=0;
  for (let i=candles.length-p;i<candles.length;i++) {
    const pc=candles[i-1].c;
    s+=Math.max(candles[i].h-candles[i].l,Math.abs(candles[i].h-pc),Math.abs(candles[i].l-pc));
  }
  return s/p;
}

function detectPhase(candles) {
  if (!candles||candles.length<25) return { phase:'neutral' };
  const n    = candles.length;
  const last = candles[n-1];
  const ref20 = candles.slice(-21,-1);
  const ab   = avgBody(ref20);
  const ar   = avgRange(ref20);
  const swH  = Math.max(...ref20.map(c=>c.h));
  const swL  = Math.min(...ref20.map(c=>c.l));

  // MANIPULATION — wick pierces swing but body closes back
  const sweptHigh = last.h>swH && last.c<swH;
  const sweptLow  = last.l<swL && last.c>swL;
  if (sweptHigh||sweptLow) return {
    phase:'manipulation',
    swept:sweptHigh?'high':'low',
    level:sweptHigh?swH:swL,
    direction:sweptHigh?'bearish':'bullish',
    excess:sweptHigh ? Math.round((last.h-swH)/ar*100) : Math.round((swL-last.l)/ar*100),
  };

  // DISTRIBUTION — strong body relative to recent average
  const lastBody = Math.abs(last.c-last.o);
  if (lastBody>ab*1.9 && ar>0) return {
    phase:'distribution',
    direction:last.c>last.o?'bullish':'bearish',
    strength:+(lastBody/ab).toFixed(1),
  };

  // ACCUMULATION — last 6 candles all small, range narrowing
  const last6 = candles.slice(-6);
  const allSmall = last6.every(c=>Math.abs(c.c-c.o)<ab*0.75);
  const narrow   = (last6[5].h-last6[5].l)<(last6[0].h-last6[0].l)*1.15;
  if (allSmall&&narrow) return { phase:'accumulation' };

  return { phase:'neutral' };
}

// ── Persistence ───────────────────────────────────────────────────────────────
function loadStore() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)||'{}'); } catch { return {}; }
}
function saveStore(d) {
  try { localStorage.setItem(LS_KEY,JSON.stringify(d)); } catch {}
}

// ── CSS injected once ─────────────────────────────────────────────────────────
const CSS = `
@keyframes alphaGlow   { 0%,100%{opacity:1} 50%{opacity:0.5} }
@keyframes alphaScan   { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }
@keyframes alphaSlide  { from{transform:translateX(-12px);opacity:0} to{transform:translateX(0);opacity:1} }
@keyframes alphaPulse  { 0%,100%{transform:scale(1)} 50%{transform:scale(1.15)} }
`;

// ── Sub-components ────────────────────────────────────────────────────────────

function PhaseCard({ pair, data, loading }) {
  const ph   = PHASES[data?.phase||'neutral'];
  const isManip = data?.phase==='manipulation';
  const isAccum = data?.phase==='accumulation';
  const isDist  = data?.phase==='distribution';
  return (
    <div style={{
      position:'relative', overflow:'hidden',
      background: data?.phase&&data.phase!=='neutral' ? `${ph.color}08` : '#090d18',
      border:`1px solid ${data?.phase&&data.phase!=='neutral'?ph.color+'44':'#0f1929'}`,
      borderRadius:12, padding:'12px 14px',
      boxShadow: data?.phase&&data.phase!=='neutral' ? `0 0 20px ${ph.glow}` : 'none',
      transition:'all 0.4s ease',
    }}>
      {/* scanning shimmer */}
      {loading && (
        <div style={{ position:'absolute', inset:0, overflow:'hidden', borderRadius:12 }}>
          <div style={{ position:'absolute', top:0, bottom:0, width:'30%', background:'linear-gradient(90deg,transparent,#ffffff08,transparent)',
            animation:'alphaScan 1.5s infinite' }}/>
        </div>
      )}

      {/* pair label */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <span style={{ fontSize:13, fontWeight:800, color:'#f1f5f9', letterSpacing:'0.04em' }}>{pair.label}</span>
        {data?.price && (
          <span style={{ fontSize:10, color:'#475569', fontFamily:'monospace' }}>
            {data.price.toFixed(pair.pip<0.001?3:pair.pip<0.01?5:3)}
          </span>
        )}
      </div>

      {/* Phase badge */}
      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6 }}>
        <span style={{
          fontSize:9, fontWeight:700, letterSpacing:'0.1em',
          padding:'3px 8px', borderRadius:20,
          color:ph.color, background:`${ph.color}18`, border:`1px solid ${ph.color}44`,
          animation: isManip ? 'alphaGlow 0.8s infinite' : 'none',
        }}>
          {ph.icon} {ph.label}
        </span>
        {isManip && data.swept && (
          <span style={{ fontSize:9, color:'#ef4444', fontWeight:700 }}>
            {data.swept==='high'?'↑ HIGH':'↓ LOW'} swept
          </span>
        )}
        {isDist && data.direction && (
          <span style={{ fontSize:9, fontWeight:700, color:data.direction==='bullish'?'#00d4aa':'#ef4444' }}>
            {data.direction==='bullish'?'▲':'▼'} {data.strength}x
          </span>
        )}
      </div>

      <div style={{ fontSize:10, color:'#334155' }}>{loading?'Scanning…':ph.desc}</div>

      {/* ATR bar */}
      {data?.atr && (
        <div style={{ marginTop:8, display:'flex', alignItems:'center', gap:5 }}>
          <span style={{ fontSize:9, color:'#1e293b', width:22 }}>ATR</span>
          <div style={{ flex:1, height:2, background:'#0f1929', borderRadius:1 }}>
            <div style={{ height:'100%', width:`${Math.min(100,data.atr/pair.pip/50*100)}%`,
              background:`linear-gradient(90deg,${ph.color}66,${ph.color})`, borderRadius:1 }}/>
          </div>
          <span style={{ fontSize:9, color:'#334155', fontFamily:'monospace' }}>
            {Math.round(data.atr/pair.pip)}p
          </span>
        </div>
      )}
    </div>
  );
}

function SweepEntry({ s, idx }) {
  const age  = Math.round((Date.now()-new Date(s.time).getTime())/60000);
  const ageStr = age<60?`${age}m`:`${Math.floor(age/60)}h ${age%60}m`;
  const outcomeCol = s.outcome==='confirmed'?'#00d4aa':s.outcome==='failed'?'#ef4444':'#475569';
  const outcomeLabel = s.outcome==='confirmed'?'✓ CONFIRMED':s.outcome==='failed'?'✗ FAILED':'⏳ PENDING';
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:10, padding:'10px 12px',
      background: idx%2===0?'#06090f':'#070b12',
      borderBottom:'1px solid #0a0f1a',
      animation:'alphaSlide 0.3s ease',
    }}>
      {/* time */}
      <span style={{ fontSize:10, color:'#334155', fontFamily:'monospace', minWidth:32, flexShrink:0 }}>{ageStr}</span>
      {/* direction indicator */}
      <div style={{
        width:24, height:24, borderRadius:6, flexShrink:0,
        background: s.expectedDir==='bullish'?'#00d4aa18':'#ef444418',
        border:`1px solid ${s.expectedDir==='bullish'?'#00d4aa44':'#ef444444'}`,
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:10, color:s.expectedDir==='bullish'?'#00d4aa':'#ef4444', fontWeight:800,
      }}>
        {s.expectedDir==='bullish'?'↑':'↓'}
      </div>
      {/* pair + info */}
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:12, fontWeight:700, color:'#e2e8f0' }}>{s.label}</span>
          <span style={{ fontSize:9, color:'#ef4444', background:'#ef444412', padding:'1px 5px', borderRadius:4, border:'1px solid #ef444433' }}>
            ⚡ {s.swept==='high'?'HIGH':'LOW'} swept
          </span>
        </div>
        <div style={{ fontSize:10, color:'#334155', marginTop:2 }}>
          @ {new Date(s.time).toUTCString().slice(17,22)} UTC
          {s.pipsMoved>0 && ` · ${s.pipsMoved}p moved after`}
        </div>
      </div>
      {/* outcome */}
      <span style={{ fontSize:9, fontWeight:700, color:outcomeCol, background:`${outcomeCol}12`,
        padding:'2px 7px', borderRadius:10, border:`1px solid ${outcomeCol}33`, flexShrink:0, whiteSpace:'nowrap' }}>
        {outcomeLabel}
      </span>
    </div>
  );
}

function TimeDNA({ heatmap }) {
  const hours = Array.from({length:24},(_,i)=>i);
  // Find global max for color scaling
  let globalMax = 1;
  Object.values(heatmap).forEach(ph => {
    Object.values(ph).forEach(v => { if(v>globalMax) globalMax=v; });
  });

  const sessions = [
    { label:'Asian',  s:0,  e:9,  color:'#f59e0b' },
    { label:'London', s:7,  e:17, color:'#8b5cf6' },
    { label:'NY',     s:13, e:22, color:'#22c55e'  },
  ];
  const utcNow = new Date().getUTCHours();

  return (
    <div style={{ padding:'4px 0' }}>
      <div style={{ fontSize:11, color:'#475569', marginBottom:12, lineHeight:1.6 }}>
        Each cell shows how many liquidity sweeps were detected at that UTC hour.
        Brighter = more market maker activity. Builds over time as you use the app.
      </div>

      {/* Session bands */}
      <div style={{ display:'flex', gap:6, marginBottom:10, flexWrap:'wrap' }}>
        {sessions.map(s=>(
          <div key={s.label} style={{ display:'flex', alignItems:'center', gap:4, fontSize:10, color:s.color }}>
            <div style={{ width:8, height:8, borderRadius:2, background:s.color, opacity:0.6 }}/>
            {s.label} {String(s.s).padStart(2,'0')}-{String(s.e).padStart(2,'0')} UTC
          </div>
        ))}
      </div>

      {/* Hour labels */}
      <div style={{ display:'grid', gridTemplateColumns:`60px repeat(24,1fr)`, gap:2, marginBottom:4 }}>
        <div/>
        {hours.map(h=>(
          <div key={h} style={{
            fontSize:8, textAlign:'center', fontFamily:'monospace',
            color: h===utcNow?'#00d4aa':'#1e293b', fontWeight:h===utcNow?700:400,
          }}>{String(h).padStart(2,'0')}</div>
        ))}
      </div>

      {/* Heatmap rows */}
      {PAIRS.map(pair=>{
        const ph = heatmap[pair.key]||{};
        const rowMax = Math.max(1,...Object.values(ph));
        return (
          <div key={pair.key} style={{ display:'grid', gridTemplateColumns:`60px repeat(24,1fr)`, gap:2, marginBottom:2 }}>
            <div style={{ fontSize:9, color:'#334155', display:'flex', alignItems:'center', fontWeight:600, letterSpacing:'0.02em' }}>
              {pair.label.replace('/','/')}
            </div>
            {hours.map(h=>{
              const val = ph[h]||0;
              const intensity = val/globalMax;
              const isSession = sessions.some(s=>h>=s.s&&h<s.e);
              const isNow = h===utcNow;
              return (
                <div key={h} title={`${pair.label} ${String(h).padStart(2,'0')}:00 UTC — ${val} sweep${val!==1?'s':''}`}
                  style={{
                    height:18, borderRadius:3,
                    background: val>0
                      ? `rgba(0,212,170,${0.15+intensity*0.85})`
                      : isSession ? '#0a0f1a' : '#060810',
                    border: isNow?'1px solid #00d4aa44':'1px solid transparent',
                    position:'relative', overflow:'hidden',
                  }}>
                  {val>0&&(
                    <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                      <span style={{ fontSize:7, fontWeight:700, color:intensity>0.5?'#04070f':'#00d4aa' }}>{val}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      <div style={{ marginTop:16, display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ fontSize:9, color:'#1e293b' }}>Low activity</span>
        {[0.1,0.3,0.5,0.7,0.9,1].map(v=>(
          <div key={v} style={{ width:16, height:10, borderRadius:2, background:`rgba(0,212,170,${0.15+v*0.85})` }}/>
        ))}
        <span style={{ fontSize:9, color:'#00d4aa' }}>High activity</span>
      </div>
    </div>
  );
}

function StatsBar({ log, phases }) {
  const resolved  = log.filter(s=>s.outcome!=='pending');
  const confirmed = resolved.filter(s=>s.outcome==='confirmed');
  const winRate   = resolved.length ? Math.round(confirmed.length/resolved.length*100) : null;
  const pending   = log.filter(s=>s.outcome==='pending').length;
  const manipNow  = Object.values(phases).filter(p=>p.phase==='manipulation').length;
  const accumNow  = Object.values(phases).filter(p=>p.phase==='accumulation').length;

  const stat = (label, value, color='#475569') => (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3, minWidth:60 }}>
      <span style={{ fontSize:16, fontWeight:900, color, fontFamily:'monospace', lineHeight:1 }}>{value}</span>
      <span style={{ fontSize:9, color:'#334155', textAlign:'center', lineHeight:1.3 }}>{label}</span>
    </div>
  );

  return (
    <div style={{ display:'flex', gap:0, background:'#06090f', borderRadius:12, border:'1px solid #0f1929',
      overflow:'hidden', marginBottom:14 }}>
      <div style={{ flex:1, padding:'12px 8px', display:'flex', justifyContent:'center', borderRight:'1px solid #0f1929' }}>
        {stat('Sweeps Logged', log.length, '#e2e8f0')}
      </div>
      <div style={{ flex:1, padding:'12px 8px', display:'flex', justifyContent:'center', borderRight:'1px solid #0f1929' }}>
        {stat('Win After Sweep', winRate!=null?`${winRate}%`:'—', winRate>60?'#00d4aa':winRate>40?'#f59e0b':'#ef4444')}
      </div>
      <div style={{ flex:1, padding:'12px 8px', display:'flex', justifyContent:'center', borderRight:'1px solid #0f1929' }}>
        {stat('Pending', pending, '#f59e0b')}
      </div>
      <div style={{ flex:1, padding:'12px 8px', display:'flex', justifyContent:'center', borderRight:'1px solid #0f1929' }}>
        {stat('⚡ Live Sweeps', manipNow, '#ef4444')}
      </div>
      <div style={{ flex:1, padding:'12px 8px', display:'flex', justifyContent:'center' }}>
        {stat('◎ Coiling', accumNow, '#f59e0b')}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function AlphaLab() {
  const [phases,    setPhases]    = useState({});
  const [loading,   setLoading]   = useState(new Set());
  const [sweepLog,  setSweepLog]  = useState([]);
  const [heatmap,   setHeatmap]   = useState({});
  const [scanning,  setScanning]  = useState(false);
  const [lastScan,  setLastScan]  = useState(null);
  const [tab,       setTab]       = useState('scanner');
  const hasOanda = !!getCreds()?.apiKey;

  // Load persisted data
  useEffect(() => {
    const store = loadStore();
    if (store.sweepLog) setSweepLog(store.sweepLog);
    if (store.heatmap)  setHeatmap(store.heatmap);
  }, []);

  const scan = useCallback(async () => {
    if (!hasOanda || scanning) return;
    setScanning(true);
    setLoading(new Set(PAIRS.map(p=>p.key)));

    const store     = loadStore();
    const existLog  = store.sweepLog || [];
    const hm        = store.heatmap  || {};
    const newPhases = {};
    const newSweeps = [];
    const utcHour   = new Date().getUTCHours();

    await Promise.all(PAIRS.map(async pair => {
      const candles = await fetchCandles(pair.key, 'H1', 60);
      setLoading(prev => { const s=new Set(prev); s.delete(pair.key); return s; });
      if (!candles) return;

      const phase = detectPhase(candles);
      const atr   = computeATR(candles);
      const price = candles[candles.length-1].c;
      newPhases[pair.key] = { ...phase, atr, price };

      // Log manipulation sweeps (deduplicate within 1h)
      if (phase.phase==='manipulation') {
        const recent = existLog.find(s=>s.pair===pair.key&&Date.now()-new Date(s.time).getTime()<60*60*1000);
        if (!recent) {
          newSweeps.push({
            id:      `${pair.key}_${Date.now()}`,
            pair:    pair.key,
            label:   pair.label,
            time:    new Date().toISOString(),
            utcHour,
            swept:       phase.swept,
            level:       phase.level,
            expectedDir: phase.direction,
            entryPrice:  price,
            pip:         pair.pip,
            outcome:     'pending',
            pipsMoved:   0,
          });
          if (!hm[pair.key]) hm[pair.key]={};
          hm[pair.key][utcHour] = (hm[pair.key][utcHour]||0)+1;
        }
      }

      // Resolve pending sweeps older than 1h
      existLog.forEach(s => {
        if (s.pair!==pair.key||s.outcome!=='pending') return;
        const hrs = (Date.now()-new Date(s.time).getTime())/(1000*60*60);
        if (hrs<1) return;
        const moved = (price-s.entryPrice)/s.pip;
        const expectedPos = s.expectedDir==='bullish';
        const moved20 = (expectedPos&&moved>20)||(!expectedPos&&moved<-20);
        s.outcome    = moved20 ? 'confirmed' : hrs>6 ? 'failed' : 'pending';
        s.pipsMoved  = Math.round(Math.abs(moved));
        s.resolvedAt = new Date().toISOString();
      });
    }));

    const merged = [...newSweeps, ...existLog].slice(0,200);
    saveStore({ sweepLog:merged, heatmap:hm });
    setPhases(newPhases);
    setSweepLog(merged);
    setHeatmap(hm);
    setLastScan(new Date());
    setScanning(false);
  }, [hasOanda, scanning]);

  useEffect(() => {
    scan();
    const id = setInterval(scan, 15*60*1000);
    return () => clearInterval(id);
  }, []);

  // Active manipulations alert
  const liveManip = Object.entries(phases).filter(([,v])=>v.phase==='manipulation');

  const innerTabs = [
    { id:'scanner', label:'Phase Scanner' },
    { id:'feed',    label:`Sweep Feed (${sweepLog.length})` },
    { id:'dna',     label:'Time DNA' },
  ];

  return (
    <div style={{ height:'100%', overflowY:'auto', background:'#04070f', padding:'14px 12px' }}>
      <style>{CSS}</style>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14 }}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:16, fontWeight:900, color:'#f1f5f9', letterSpacing:'0.06em' }}>⚗ ALPHA LAB</span>
            {scanning && (
              <span style={{ fontSize:9, fontWeight:700, color:'#00d4aa', padding:'2px 7px',
                borderRadius:10, background:'#00d4aa12', border:'1px solid #00d4aa44',
                animation:'alphaGlow 1s infinite' }}>
                ● SCANNING
              </span>
            )}
          </div>
          <div style={{ fontSize:10, color:'#334155', marginTop:3 }}>
            Market maker phase detection · Liquidity sweep tracker · Time pattern analysis
          </div>
        </div>
        <div style={{ textAlign:'right' }}>
          <button onClick={scan} disabled={scanning||!hasOanda} style={{
            background:'#090d18', border:'1px solid #1e293b', borderRadius:8,
            color:scanning?'#334155':'#e2e8f0', fontSize:11, padding:'6px 14px',
            cursor:scanning||!hasOanda?'not-allowed':'pointer', fontWeight:600,
          }}>
            {scanning?'Scanning…':'↻ Scan Now'}
          </button>
          {lastScan&&<div style={{ fontSize:9, color:'#1e293b', marginTop:3 }}>{lastScan.toLocaleTimeString()}</div>}
        </div>
      </div>

      {!hasOanda && (
        <div style={{ textAlign:'center', padding:'48px 20px', color:'#334155', fontSize:13 }}>
          <div style={{ fontSize:32, marginBottom:10 }}>⚗</div>
          Connect OANDA to start detecting market maker phases.
        </div>
      )}

      {hasOanda && (
        <>
          {/* ── Live sweep alert ──────────────────────────────────────── */}
          {liveManip.length>0 && (
            <div style={{ background:'#ef444410', border:'1px solid #ef444433', borderRadius:10,
              padding:'10px 14px', marginBottom:12, animation:'alphaGlow 1s infinite' }}>
              <div style={{ fontSize:11, fontWeight:800, color:'#ef4444', marginBottom:6 }}>
                ⚡ LIVE MANIPULATION — {liveManip.length} pair{liveManip.length>1?'s':''} sweeping liquidity right now
              </div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                {liveManip.map(([key,v])=>{
                  const pair = PAIRS.find(p=>p.key===key);
                  return (
                    <div key={key} style={{ fontSize:10, fontWeight:700,
                      color:'#ef4444', background:'#ef444418', padding:'3px 10px',
                      borderRadius:20, border:'1px solid #ef444444' }}>
                      {pair?.label} · {v.swept==='high'?'↑ HIGH':'↓ LOW'} swept →
                      <span style={{ color:'#00d4aa', marginLeft:4 }}>
                        expect {v.direction==='bullish'?'▲ UP':'▼ DOWN'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Stats bar ────────────────────────────────────────────── */}
          <StatsBar log={sweepLog} phases={phases}/>

          {/* ── Inner tabs ───────────────────────────────────────────── */}
          <div style={{ display:'flex', gap:4, marginBottom:14, background:'#06090f',
            borderRadius:10, padding:4, border:'1px solid #0f1929' }}>
            {innerTabs.map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{
                flex:1, padding:'7px 4px', borderRadius:7, border:'none', cursor:'pointer',
                fontSize:10, fontWeight:700, transition:'all 0.2s',
                background: tab===t.id?'#0f1929':'transparent',
                color:      tab===t.id?'#00d4aa':'#334155',
              }}>{t.label}</button>
            ))}
          </div>

          {/* ── Phase Scanner ─────────────────────────────────────────── */}
          {tab==='scanner' && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(155px,1fr))', gap:10 }}>
              {PAIRS.map(pair=>(
                <PhaseCard key={pair.key} pair={pair}
                  data={phases[pair.key]}
                  loading={loading.has(pair.key)}
                />
              ))}
            </div>
          )}

          {/* ── Sweep Feed ───────────────────────────────────────────── */}
          {tab==='feed' && (
            <div style={{ background:'#06090f', borderRadius:12, border:'1px solid #0f1929', overflow:'hidden' }}>
              {sweepLog.length===0?(
                <div style={{ textAlign:'center', padding:'48px 20px', color:'#1e293b', fontSize:12 }}>
                  No sweeps logged yet. Scans run every 15 minutes automatically.
                </div>
              ):sweepLog.map((s,i)=>(
                <SweepEntry key={s.id} s={s} idx={i}/>
              ))}
            </div>
          )}

          {/* ── Time DNA ─────────────────────────────────────────────── */}
          {tab==='dna' && (
            <div style={{ background:'#06090f', borderRadius:12, border:'1px solid #0f1929', padding:'14px' }}>
              {Object.keys(heatmap).length===0?(
                <div style={{ textAlign:'center', padding:'48px 20px', color:'#1e293b', fontSize:12 }}>
                  Heatmap builds automatically as sweeps are detected over time.
                  <br/>Come back after a few days of scanning.
                </div>
              ):(
                <TimeDNA heatmap={heatmap}/>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

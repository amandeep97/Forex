import { useState, useEffect, useCallback, useMemo } from 'react';
import { ghRead, isGithubConfigured } from '../utils/githubSync';

// ── Shared helpers ────────────────────────────────────────────────────────────
const $pnl  = (v, d = 2) => v == null ? '—' : `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(d)}`;
const pnlColor  = v => v >= 0 ? '#22c55e' : '#ef4444';
const resultColor = r => ({ win:'#22c55e', loss:'#ef4444', be:'#64748b', open:'#38bdf8' }[r] ?? '#94a3b8');
const resultBg    = r => ({ win:'#14532d', loss:'#450a0a', be:'#1e293b',  open:'#0c4a6e' }[r] ?? '#1e293b');

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString([], { month:'short', day:'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function sessKey(s) {
  if (!s) return 'other';
  if (s.includes('asian') || s === 'asia') return 'asian';
  if (s.includes('london')) return 'london';
  if (s.includes('new') || s.includes('york') || s.includes('overlap')) return 'newyork';
  return 'other';
}

// ── Normalise VPS trade record ────────────────────────────────────────────────
function normVPS(t) {
  const raw    = t.pnlUsd ?? t.pnl ?? null;
  const status = (t.status || '').toLowerCase();
  let result = 'open';
  if      (status === 'tp_hit' || status === 'win'  || (raw != null && raw >  0.005)) result = 'win';
  else if (status === 'sl_hit' || status === 'loss' || (raw != null && raw < -0.005)) result = 'loss';
  else if (raw != null && Math.abs(raw) <= 0.005 && !['open',''].includes(status))    result = 'be';
  else if (status === 'closed') result = raw != null ? (raw > 0 ? 'win' : raw < 0 ? 'loss' : 'be') : 'be';
  const dir = (t.direction || t.dir || '').toUpperCase();
  return {
    ...t,
    _pair:     (t.pair || t.instrument || '?').replace('_', '/'),
    _dir:      dir || 'LONG',
    _entry:    t.entry  ?? t.entryPrice  ?? t.openPrice ?? null,
    _sl:       t.sl     ?? t.slPrice     ?? null,
    _tp:       t.tp     ?? t.tpPrice     ?? null,
    _close:    t.closePrice ?? t.close   ?? null,
    _pnl:      raw,
    _rr:       t.rrAchieved ?? t.rrPlanned ?? t.rr ?? null,
    _result:   result,
    _openedAt: t.openedAt ?? t.openTime  ?? t.timestamp ?? null,
    _closedAt: t.closedAt ?? t.closeTime ?? null,
    _strategy: t.strategyName ?? t.strategy ?? '',
    _session:  (t.session || '').toLowerCase(),
    _lots:     t.lotSize ?? t.lots ?? null,
    _source:   t.source ?? 'vps_bot',
  };
}

// ── Normalise manual trade record ─────────────────────────────────────────────
function normManual(t) {
  const raw = t.pnl ?? null;
  let result = t.result ?? 'open';
  if (result === 'open' && raw != null) {
    if (raw > 0.005) result = 'win';
    else if (raw < -0.005) result = 'loss';
    else result = 'be';
  }
  return {
    ...t,
    _pair:     t.pair || '?',
    _dir:      (t.direction || 'LONG').toUpperCase(),
    _entry:    t.entry   ?? null,
    _sl:       t.sl      ?? null,
    _tp:       t.tp      ?? null,
    _close:    t.close   ?? null,
    _pnl:      raw,
    _rr:       t.rr      ?? null,
    _result:   result,
    _openedAt: t.openedAt ?? null,
    _closedAt: t.closedAt ?? null,
    _strategy: t.strategy ?? '',
    _setupSource: t.setupSource ?? '',
    _session:  (t.session || '').toLowerCase(),
    _lots:     t.lots ?? null,
    _source:   'manual',
    _notes:    t.notes ?? '',
  };
}

// ── Consistency score (% of weeks with win rate >= 50%) ───────────────────────
function calcConsistency(closed) {
  if (closed.length < 3) return null;
  const weeks = {};
  closed.forEach(t => {
    if (!t._closedAt) return;
    const d = new Date(t._closedAt);
    const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7)); mon.setHours(0,0,0,0);
    const k = mon.toISOString().slice(0,10);
    if (!weeks[k]) weeks[k] = { w:0, t:0 };
    weeks[k].t++;
    if (t._result === 'win') weeks[k].w++;
  });
  const wks = Object.values(weeks);
  if (wks.length < 2) return null;
  const consistent = wks.filter(w => w.t > 0 && w.w / w.t >= 0.5).length;
  return Math.round(consistent / wks.length * 100);
}

// ── Greeting ──────────────────────────────────────────────────────────────────
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// ── Weekly stats helper ───────────────────────────────────────────────────────
function weeklyStats(closed) {
  const start = new Date();
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  start.setHours(0,0,0,0);
  const wTrades = closed.filter(t => t._closedAt && new Date(t._closedAt) >= start);
  const wWins   = wTrades.filter(t => t._result === 'win');
  const wPnl    = wTrades.reduce((s, t) => s + (t._pnl || 0), 0);
  const wRR     = wTrades.filter(t => t._rr != null);
  const avgR    = wRR.length ? wRR.reduce((s, t) => s + Number(t._rr), 0) / wRR.length : null;
  return {
    trades:  wTrades.length,
    winRate: wTrades.length ? Math.round(wWins.length / wTrades.length * 100) : null,
    pnl:     wPnl,
    avgR,
  };
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function ConsistencyRing({ score }) {
  if (score == null) return (
    <div style={{ width:80, height:80, borderRadius:'50%', background:'#1e293b',
      display:'flex', alignItems:'center', justifyContent:'center' }}>
      <span style={{ fontSize:11, color:'#475569' }}>N/A</span>
    </div>
  );
  const r = 34, circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const col = score >= 70 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ position:'relative', width:80, height:80 }}>
      <svg width="80" height="80" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r={r} fill="none" stroke="#1e293b" strokeWidth="8"/>
        <circle cx="40" cy="40" r={r} fill="none" stroke={col} strokeWidth="8"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          transform="rotate(-90 40 40)"/>
      </svg>
      <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column',
        alignItems:'center', justifyContent:'center' }}>
        <span style={{ fontSize:18, fontWeight:900, color:col, lineHeight:1 }}>{score}</span>
        <span style={{ fontSize:8, color:'#475569' }}>/100</span>
      </div>
    </div>
  );
}

function WeeklyCaptureCard({ wk, consistency }) {
  return (
    <div style={{ background:'linear-gradient(135deg,#0f172a,#1e293b)', border:'1px solid #334155',
      borderRadius:14, padding:'16px 20px', marginBottom:16 }}>
      <div style={{ display:'flex', alignItems:'flex-start', gap:16 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'#475569', textTransform:'uppercase',
            letterSpacing:'0.08em', marginBottom:12 }}>This Week · Capture</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
            {[
              { label:'Trades',  value: wk.trades || '—',   color:'#f8fafc' },
              { label:'Win Rate',value: wk.winRate != null ? `${wk.winRate}%` : '—', color: wk.winRate >= 50 ? '#22c55e' : '#ef4444' },
              { label:'Avg R',   value: wk.avgR != null ? `${wk.avgR >= 0 ? '+' : ''}${wk.avgR.toFixed(2)}R` : '—', color: wk.avgR >= 0 ? '#22c55e' : '#ef4444' },
              { label:'P&L',     value: $pnl(wk.pnl),       color: pnlColor(wk.pnl) },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div style={{ fontSize:9, color:'#475569', fontWeight:700, marginBottom:4 }}>{label}</div>
                <div style={{ fontSize:16, fontWeight:900, color }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
          <div style={{ fontSize:9, color:'#475569', fontWeight:700 }}>Consistency</div>
          <ConsistencyRing score={consistency}/>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color = '#f8fafc', accent }) {
  return (
    <div style={{ background:'#1e293b', borderRadius:10, padding:'12px 14px',
      borderTop: accent ? `3px solid ${accent}` : undefined }}>
      <div style={{ fontSize:9, color:'#64748b', fontWeight:700, textTransform:'uppercase',
        letterSpacing:'0.06em', marginBottom:5 }}>{label}</div>
      <div style={{ fontSize:22, fontWeight:900, color }}>{value}</div>
      {sub && <div style={{ fontSize:10, color:'#475569', marginTop:3 }}>{sub}</div>}
    </div>
  );
}

function TradeCard({ t, onEdit, onDelete }) {
  const rc = resultColor(t._result);
  const dc = t._dir === 'LONG' ? '#22c55e' : '#ef4444';
  const srcLabel = t._source === 'vps_bot' ? 'VPS' : t._source === 'app_autotrade' ? 'AUTO' : null;
  return (
    <div style={{ background:'#1e293b', borderRadius:10, padding:'12px 14px',
      marginBottom:8, borderLeft:`3px solid ${rc}` }}>
      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
        <span style={{ fontSize:14, fontWeight:800, color:'#f8fafc' }}>{t._pair}</span>
        <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:4,
          background:dc+'22', color:dc }}>{t._dir}</span>
        <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:4,
          background:resultBg(t._result), color:rc }}>{t._result.toUpperCase()}</span>
        {srcLabel && (
          <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4,
            background:'#1e40af22', color:'#60a5fa', border:'1px solid #1e40af44' }}>{srcLabel}</span>
        )}
        <div style={{ marginLeft:'auto', textAlign:'right' }}>
          {t._pnl != null && <div style={{ fontSize:14, fontWeight:800, color:rc }}>{$pnl(t._pnl)}</div>}
          {t._rr  != null && <div style={{ fontSize:10, color:'#64748b' }}>{Number(t._rr) >= 0 ? '+' : ''}{Number(t._rr).toFixed(2)}R</div>}
        </div>
      </div>
      <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:4 }}>
        {t._setupSource && (
          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:4,
            color: t._setupSource===OFF_SYSTEM ? '#fca5a5' : '#00d4aa',
            background: t._setupSource===OFF_SYSTEM ? '#45050933' : '#00d4aa18',
            border: `1px solid ${t._setupSource===OFF_SYSTEM ? '#ef444433' : '#00d4aa33'}` }}>
            📌 {t._setupSource}</span>
        )}
        {t._strategy && <span style={{ fontSize:10, color:'#94a3b8', background:'#0f172a', padding:'2px 8px', borderRadius:4 }}>{t._strategy}</span>}
        {t._session  && <span style={{ fontSize:10, color:'#64748b', background:'#0f172a', padding:'2px 8px', borderRadius:4 }}>{t._session}</span>}
      </div>
      <div style={{ fontSize:10, color:'#475569', display:'flex', gap:10, flexWrap:'wrap' }}>
        <span>{fmtDate(t._openedAt)}</span>
        {t._entry != null && <span>Entry {Number(t._entry).toPrecision(6)}</span>}
        {t._result === 'open' && t._sl != null && <span style={{ color:'#ef444488' }}>SL {Number(t._sl).toPrecision(5)}</span>}
        {t._result === 'open' && t._tp != null && <span style={{ color:'#22c55e88' }}>TP {Number(t._tp).toPrecision(5)}</span>}
      </div>
      {t._notes && (
        <div style={{ marginTop:6, fontSize:11, color:'#94a3b8', fontStyle:'italic',
          borderTop:'1px solid #334155', paddingTop:5 }}>{t._notes}</div>
      )}
      {(onEdit || onDelete) && (
        <div style={{ display:'flex', gap:6, marginTop:8 }}>
          {onEdit   && <button onClick={() => onEdit(t)}   style={editBtnStyle()}>Edit</button>}
          {onDelete && <button onClick={() => onDelete(t.id)} style={delBtnStyle()}>Delete</button>}
        </div>
      )}
    </div>
  );
}
const editBtnStyle = () => ({ padding:'3px 12px', borderRadius:5, background:'none',
  border:'1px solid #334155', color:'#64748b', fontSize:10, cursor:'pointer' });
const delBtnStyle  = () => ({ padding:'3px 12px', borderRadius:5, background:'none',
  border:'1px solid #334155', color:'#ef444477', fontSize:10, cursor:'pointer' });

function EquityCurve({ trades }) {
  const sorted = [...trades].sort((a, b) => new Date(a._closedAt||0) - new Date(b._closedAt||0));
  let cum = 0;
  const pts = [0, ...sorted.map(t => { cum += (t._pnl||0); return cum; })];
  if (pts.length < 2) return null;
  const mn = Math.min(...pts), mx = Math.max(...pts), range = mx - mn || 1;
  const W = 340, H = 64, P = 4;
  const px = i => P + (i / (pts.length-1)) * (W - P*2);
  const py = v => H - P - ((v - mn) / range) * (H - P*2);
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const last = pts[pts.length-1];
  const col  = last >= 0 ? '#22c55e' : '#ef4444';
  return (
    <div style={{ background:'#1e293b', borderRadius:10, padding:'12px 14px', marginBottom:10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
        <span style={{ fontSize:11, fontWeight:700, color:'#94a3b8' }}>Equity Curve</span>
        <span style={{ fontSize:13, fontWeight:800, color:col }}>{$pnl(last)}</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <linearGradient id="eqG2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.3"/>
            <stop offset="100%" stopColor={col} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <path d={`M${px(0)},${H} ${path.slice(1)} L${px(pts.length-1)},${H} Z`} fill="url(#eqG2)"/>
        <path d={path} fill="none" stroke={col} strokeWidth="1.5"/>
        <circle cx={px(pts.length-1)} cy={py(last)} r="3" fill={col}/>
      </svg>
    </div>
  );
}

function MonthCalendar({ trades }) {
  const now = new Date();
  const [m, setM] = useState(now.getMonth());
  const [y, setY] = useState(now.getFullYear());
  const dayMap = {};
  trades.forEach(t => {
    const d = t._closedAt ? new Date(t._closedAt) : null;
    if (!d || d.getMonth() !== m || d.getFullYear() !== y) return;
    const k = d.getDate(); dayMap[k] = (dayMap[k]||0) + (t._pnl||0);
  });
  const first = new Date(y, m, 1).getDay();
  const days  = new Date(y, m+1, 0).getDate();
  const label = new Date(y, m, 1).toLocaleString([], { month:'long', year:'numeric' });
  const prev  = () => m === 0 ? (setM(11), setY(y-1)) : setM(m-1);
  const next  = () => m === 11 ? (setM(0), setY(y+1)) : setM(m+1);
  const cells = [...Array(first).fill(null), ...Array.from({ length:days }, (_, i) => i+1)];
  return (
    <div style={{ background:'#1e293b', borderRadius:10, padding:'12px 14px', marginBottom:10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <span style={{ fontSize:12, fontWeight:700, color:'#f8fafc' }}>Monthly P&amp;L</span>
        <div style={{ display:'flex', alignItems:'center', gap:4 }}>
          <button onClick={prev} style={{ background:'none', border:'none', color:'#64748b', cursor:'pointer', fontSize:16 }}>‹</button>
          <span style={{ fontSize:10, color:'#94a3b8', minWidth:100, textAlign:'center' }}>{label}</span>
          <button onClick={next} style={{ background:'none', border:'none', color:'#64748b', cursor:'pointer', fontSize:16 }}>›</button>
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2 }}>
        {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
          <div key={d} style={{ fontSize:8, color:'#334155', textAlign:'center', fontWeight:700, paddingBottom:2 }}>{d}</div>
        ))}
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`}/>;
          const pnl = dayMap[day]; const has = pnl != null;
          const isToday = day === now.getDate() && m === now.getMonth() && y === now.getFullYear();
          const fmt = has ? (Math.abs(pnl) >= 1 ? `${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(0)}` : `${pnl>=0?'+':'-'}${(Math.abs(pnl)*100).toFixed(0)}¢`) : null;
          return (
            <div key={day} style={{ borderRadius:4, padding:'3px 1px', textAlign:'center', minHeight:30,
              background:has ? (pnl>=0 ? '#14532d' : '#450a0a') : '#0f172a',
              border:`1px solid ${isToday ? '#00d4aa' : 'transparent'}` }}>
              <div style={{ fontSize:8, fontWeight:600, color:has ? (pnl>=0 ? '#86efac' : '#fca5a5') : '#334155' }}>{day}</div>
              {fmt && <div style={{ fontSize:7, fontWeight:800, color:pnl>=0 ? '#22c55e' : '#ef4444', lineHeight:1.2 }}>{fmt}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── VPS Journal (GitHub-synced) ───────────────────────────────────────────────
function VPSJournal() {
  const [rawTrades, setRaw]    = useState([]);
  const [loading,  setLoading] = useState(false);
  const [error,    setError]   = useState('');
  const [tab,      setTab]     = useState('overview');
  const [search,   setSearch]  = useState('');
  const [filter,   setFilter]  = useState('all');
  const [lastSync, setLastSync]= useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const d = await ghRead('bot/trades.json');
      setRaw(d?.content?.trades || []);
      setLastSync(new Date());
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 120_000); return () => clearInterval(t); }, [load]);

  const trades  = useMemo(() => rawTrades.map(normVPS), [rawTrades]);
  const closed  = useMemo(() => trades.filter(t => t._result !== 'open'), [trades]);
  const open    = useMemo(() => trades.filter(t => t._result === 'open'),  [trades]);
  const wins    = useMemo(() => closed.filter(t => t._result === 'win'),   [closed]);
  const losses  = useMemo(() => closed.filter(t => t._result === 'loss'),  [closed]);
  const bes     = useMemo(() => closed.filter(t => t._result === 'be'),    [closed]);

  const totalPnl = useMemo(() => closed.reduce((s,t) => s+(t._pnl||0), 0), [closed]);
  const gProfit  = useMemo(() => wins.reduce((s,t) => s+(t._pnl||0), 0),   [wins]);
  const gLoss    = useMemo(() => Math.abs(losses.reduce((s,t) => s+(t._pnl||0), 0)), [losses]);
  const pf       = gLoss > 0 ? gProfit/gLoss : wins.length > 0 ? Infinity : 0;
  const winRate  = closed.length > 0 ? wins.length/closed.length*100 : 0;
  const avgWin   = wins.length   > 0 ? gProfit/wins.length   : 0;
  const avgLoss  = losses.length > 0 ? gLoss/losses.length   : 0;
  const rrTrades = useMemo(() => closed.filter(t => t._rr != null), [closed]);
  const avgR     = rrTrades.length > 0 ? rrTrades.reduce((s,t) => s+Number(t._rr),0)/rrTrades.length : null;
  const maxDD    = useMemo(() => {
    let peak=0,cum=0,dd=0;
    [...closed].sort((a,b)=>new Date(a._closedAt||0)-new Date(b._closedAt||0))
      .forEach(t => { cum+=t._pnl||0; if(cum>peak)peak=cum; if(peak-cum>dd)dd=peak-cum; });
    return dd;
  }, [closed]);
  const streak = useMemo(() => {
    const s = [...closed].sort((a,b)=>new Date(a._closedAt||0)-new Date(b._closedAt||0));
    if (!s.length) return {type:null,count:0};
    const last=s[s.length-1]._result; let n=0;
    for (let i=s.length-1; i>=0 && s[i]._result===last; i--) n++;
    return {type:last,count:n};
  }, [closed]);
  const sessStats = useMemo(() => {
    const m={asian:{t:0,w:0,pnl:0},london:{t:0,w:0,pnl:0},newyork:{t:0,w:0,pnl:0},other:{t:0,w:0,pnl:0}};
    closed.forEach(t => { const k=sessKey(t._session); m[k].t++; m[k].pnl+=t._pnl||0; if(t._result==='win')m[k].w++; });
    return m;
  }, [closed]);
  const stratStats = useMemo(() => {
    const m={};
    closed.forEach(t => { const k=t._strategy||'Manual'; if(!m[k])m[k]={name:k,t:0,w:0,pnl:0}; m[k].t++; m[k].pnl+=t._pnl||0; if(t._result==='win')m[k].w++; });
    return Object.values(m).sort((a,b)=>b.pnl-a.pnl);
  }, [closed]);
  const pairStats = useMemo(() => {
    const m={};
    closed.forEach(t => { const k=t._pair; if(!m[k])m[k]={pair:k,t:0,w:0,pnl:0}; m[k].t++; m[k].pnl+=t._pnl||0; if(t._result==='win')m[k].w++; });
    return Object.values(m).sort((a,b)=>b.pnl-a.pnl);
  }, [closed]);
  const longs  = useMemo(() => closed.filter(t=>t._dir==='LONG'),  [closed]);
  const shorts = useMemo(() => closed.filter(t=>t._dir==='SHORT'), [closed]);
  const wk = useMemo(() => weeklyStats(closed), [closed]);
  const consistency = useMemo(() => calcConsistency(closed), [closed]);
  const filteredTrades = useMemo(() => {
    let list=[...trades];
    if (filter==='win')  list=list.filter(t=>t._result==='win');
    else if(filter==='loss') list=list.filter(t=>t._result==='loss');
    else if(filter==='be')   list=list.filter(t=>t._result==='be');
    else if(filter==='open') list=list.filter(t=>t._result==='open');
    if (search.trim()) { const q=search.toLowerCase(); list=list.filter(t=>t._pair.toLowerCase().includes(q)||t._strategy.toLowerCase().includes(q)); }
    return list.sort((a,b)=>new Date(b._openedAt||0)-new Date(a._openedAt||0));
  }, [trades,filter,search]);
  const fmtPf = v => v===Infinity ? '∞' : v.toFixed(2);

  return (
    <div style={{ maxWidth:600, margin:'0 auto', padding:'0 4px' }}>
      {/* Sync bar */}
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <div style={{ flex:1, fontSize:11, color:'#475569' }}>
          {trades.length} trades synced from VPS bot
          {lastSync && <span> · {lastSync.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>}
        </div>
        {open.length > 0 && <span style={{ fontSize:11, color:'#38bdf8', fontWeight:600 }}>{open.length} open</span>}
        <button onClick={load} disabled={loading} style={{ padding:'6px 14px', borderRadius:8,
          background:'#1e293b', border:'1px solid #334155', color:loading?'#475569':'#94a3b8',
          fontSize:11, cursor:'pointer' }}>{loading ? '⟳' : '⟳ Sync'}</button>
      </div>

      {error && <div style={{ background:'#450a0a', border:'1px solid #b91c1c', borderRadius:6,
        padding:'8px 12px', marginBottom:10, color:'#fca5a5', fontSize:11 }}>{error}</div>}
      {!isGithubConfigured() && <div style={{ background:'#1e293b', borderRadius:8, padding:'9px 14px',
        marginBottom:10, fontSize:11, color:'#f59e0b', textAlign:'center' }}>
        GitHub token required — set in Strategy tab</div>}

      <WeeklyCaptureCard wk={wk} consistency={consistency}/>

      {/* Inner tabs */}
      <div style={{ display:'flex', gap:2, marginBottom:14, background:'#1e293b', borderRadius:10, padding:3 }}>
        {[['overview','Overview'],['log','Trade Log'],['performance','Performance']].map(([v,l]) => (
          <button key={v} onClick={()=>setTab(v)} style={{ flex:1, padding:'7px 4px', borderRadius:8,
            fontSize:12, fontWeight:600, border:'none', cursor:'pointer',
            background:tab===v?'#0f172a':'transparent', color:tab===v?'#f8fafc':'#64748b' }}>{l}</button>
        ))}
      </div>

      {/* ── Overview ── */}
      {tab === 'overview' && (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
            <StatCard label="Total Trades" value={closed.length} sub={`${wins.length}W · ${losses.length}L · ${bes.length}BE`}/>
            <StatCard label="Win Rate" value={closed.length ? `${winRate.toFixed(1)}%` : '—'}
              color={closed.length ? (winRate>=50?'#22c55e':'#ef4444') : '#64748b'}
              sub={`${wins.length}W / ${losses.length}L`}/>
            <StatCard label="Total PnL" value={closed.length ? $pnl(totalPnl) : '—'}
              color={closed.length ? pnlColor(totalPnl) : '#64748b'}
              sub={closed.length ? `+$${gProfit.toFixed(2)} / -$${gLoss.toFixed(2)}` : null}/>
            <StatCard label="Profit Factor" value={closed.length ? fmtPf(pf) : '—'}
              color={pf>=1.5?'#22c55e':pf>=1?'#f59e0b':'#ef4444'}
              sub={closed.length&&avgLoss>0 ? `Avg W $${avgWin.toFixed(2)} / L $${avgLoss.toFixed(2)}` : null}/>
            <StatCard label="Avg R" value={avgR!=null ? `${avgR>=0?'+':''}${avgR.toFixed(2)}R` : '—'}
              color={avgR!=null?pnlColor(avgR):'#64748b'} sub={`${rrTrades.length} trades w/ R data`}/>
            <StatCard label="Max Drawdown" value={closed.length ? `$${maxDD.toFixed(2)}` : '—'}
              color={maxDD>0?'#ef4444':'#64748b'}/>
            <StatCard label="Avg Win" value={wins.length ? `$${avgWin.toFixed(2)}` : '—'} color="#22c55e"
              sub={`${wins.length} wins`}/>
            <StatCard label="Streak"
              value={streak.count > 0 ? `${streak.type==='win'?'W':streak.type==='loss'?'L':'BE'}${streak.count}` : '—'}
              color={streak.type==='win'?'#22c55e':streak.type==='loss'?'#ef4444':'#64748b'}
              sub={streak.count>1?`${streak.count} in a row`:null}/>
          </div>
          {closed.length > 0 && <MonthCalendar trades={closed}/>}
          {closed.length > 1 && <EquityCurve   trades={closed}/>}
          {closed.length > 0 && (
            <div style={{ marginTop:4 }}>
              <div style={{ fontSize:12, fontWeight:700, color:'#f8fafc', marginBottom:8 }}>By Session</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                {[{key:'asian',label:'Asia',color:'#fbbf24'},{key:'london',label:'London',color:'#38bdf8'},
                  {key:'newyork',label:'New York',color:'#34d399'},{key:'other',label:'Other',color:'#a78bfa'}].map(({key,label,color}) => {
                  const s=sessStats[key]; const wr=s.t>0?Math.round(s.w/s.t*100):0;
                  return (
                    <div key={key} style={{ background:'#1e293b', borderRadius:10, padding:'12px 14px', borderTop:`3px solid ${color}` }}>
                      <div style={{ fontSize:11, color, fontWeight:700, marginBottom:3 }}>{label}</div>
                      <div style={{ fontSize:18, fontWeight:800, color:'#f8fafc' }}>{s.t} trades</div>
                      <div style={{ fontSize:10, color:'#64748b', margin:'2px 0' }}>{s.t>0?`${wr}% WR`:'No trades'}</div>
                      <div style={{ fontSize:13, fontWeight:700, color:s.t>0?pnlColor(s.pnl):'#334155' }}>{s.t>0?$pnl(s.pnl):'—'}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {open.length > 0 && (
            <div style={{ marginTop:12, background:'#0c4a6e22', border:'1px solid #0ea5e933', borderRadius:10, padding:'12px 14px' }}>
              <div style={{ fontSize:12, fontWeight:700, color:'#38bdf8', marginBottom:8 }}>{open.length} Open</div>
              {open.map((t,i) => <TradeCard key={t.id||i} t={t}/>)}
            </div>
          )}
          {trades.length===0 && !loading && (
            <div style={{ textAlign:'center', padding:'40px 0', color:'#475569', fontSize:12 }}>
              No VPS trades yet — sync the bot or check GitHub config
            </div>
          )}
        </>
      )}

      {/* ── Log ── */}
      {tab === 'log' && (
        <>
          <input placeholder="Search pair or strategy…" value={search} onChange={e=>setSearch(e.target.value)}
            style={{ width:'100%', background:'#1e293b', color:'#e2e8f0', border:'1px solid #334155',
              borderRadius:8, padding:'8px 14px', fontSize:12, marginBottom:8, boxSizing:'border-box' }}/>
          <div style={{ display:'flex', gap:5, marginBottom:12, overflowX:'auto', paddingBottom:2 }}>
            {[['all',`All(${trades.length})`],['win',`Win(${wins.length})`],['loss',`Loss(${losses.length})`],
              ['be',`BE(${bes.length})`],['open','Open']].map(([v,l]) => (
              <button key={v} onClick={()=>setFilter(v)} style={{ flexShrink:0, padding:'5px 12px', borderRadius:20,
                fontSize:11, fontWeight:600, cursor:'pointer', border:'none',
                background:filter===v?'#00d4aa':'#1e293b', color:filter===v?'#080c14':'#94a3b8' }}>{l}</button>
            ))}
          </div>
          {filteredTrades.length===0
            ? <div style={{ textAlign:'center', padding:'30px 0', color:'#475569', fontSize:12 }}>No trades match</div>
            : filteredTrades.map((t,i) => <TradeCard key={t.id||i} t={t}/>)}
        </>
      )}

      {/* ── Performance ── */}
      {tab === 'performance' && (
        <>
          {stratStats.length > 0 && (
            <div style={{ background:'#1e293b', borderRadius:10, padding:'14px 16px', marginBottom:10 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'#f8fafc', marginBottom:10 }}>Strategy Performance</div>
              {stratStats.map(s => (
                <div key={s.name} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 0', borderBottom:'1px solid #0f172a' }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:'#e2e8f0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.name}</div>
                    <div style={{ fontSize:10, color:'#475569', marginTop:1 }}>{s.t} trades · {s.t?Math.round(s.w/s.t*100):0}% WR</div>
                  </div>
                  <span style={{ fontSize:13, fontWeight:700, color:pnlColor(s.pnl), minWidth:58, textAlign:'right' }}>{$pnl(s.pnl)}</span>
                </div>
              ))}
            </div>
          )}
          {pairStats.length > 0 && (
            <div style={{ background:'#1e293b', borderRadius:10, padding:'14px 16px', marginBottom:10 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'#f8fafc', marginBottom:10 }}>By Pair</div>
              {pairStats.slice(0,20).map(s => (
                <div key={s.pair} style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 0', borderBottom:'1px solid #0f172a' }}>
                  <span style={{ fontSize:12, fontWeight:700, color:'#e2e8f0', minWidth:70 }}>{s.pair}</span>
                  <span style={{ fontSize:10, color:'#475569', minWidth:22 }}>{s.t}T</span>
                  <span style={{ fontSize:10, color:s.w/s.t>=0.5?'#22c55e':'#ef4444', minWidth:28 }}>{Math.round(s.w/s.t*100)}%</span>
                  <div style={{ flex:1 }}>
                    <div style={{ height:3, borderRadius:2, background:'#0f172a', overflow:'hidden' }}>
                      <div style={{ height:'100%', width:`${s.w/s.t*100}%`, background:s.w/s.t>=0.5?'#22c55e':'#ef4444', borderRadius:2 }}/>
                    </div>
                  </div>
                  <span style={{ fontSize:12, fontWeight:700, color:pnlColor(s.pnl), minWidth:56, textAlign:'right' }}>{$pnl(s.pnl)}</span>
                </div>
              ))}
            </div>
          )}
          {closed.length > 0 && (
            <div style={{ background:'#1e293b', borderRadius:10, padding:'14px 16px', marginBottom:10 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'#f8fafc', marginBottom:10 }}>Long vs Short</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                {[{label:'LONG',list:longs,color:'#22c55e',bg:'#14532d22'},{label:'SHORT',list:shorts,color:'#ef4444',bg:'#450a0a22'}].map(({label,list,color,bg}) => {
                  const w=list.filter(t=>t._result==='win').length;
                  const p=list.reduce((s,t)=>s+(t._pnl||0),0);
                  return (
                    <div key={label} style={{ background:bg, border:`1px solid ${color}33`, borderRadius:8, padding:'10px 12px' }}>
                      <div style={{ fontSize:13, fontWeight:800, color, marginBottom:8 }}>{label}</div>
                      {[['Trades',list.length,'#e2e8f0'],['Win Rate',list.length?`${Math.round(w/list.length*100)}%`:'—',list.length&&w/list.length>=0.5?'#22c55e':'#ef4444'],
                        ['W/L',`${w}W/${list.length-w}L`,'#e2e8f0'],['P&L',$pnl(p),pnlColor(p)]].map(([lbl,val,col]) => (
                        <div key={lbl} style={{ display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:3 }}>
                          <span style={{ color:'#94a3b8' }}>{lbl}</span>
                          <span style={{ fontWeight:600, color:col }}>{val}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Manual Trade Form ─────────────────────────────────────────────────────────
const PAIRS = ['EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','USD/CHF','NZD/USD','EUR/GBP',
  'EUR/JPY','GBP/JPY','XAU/USD','XAG/USD','US30/USD','NAS100/USD','SPX500/USD','Other'];
const SESSIONS = ['Asian','London','London Close','New York','New York PM'];
const STRATEGIES = ['ICT OB','ICT FVG','ICT BMS','SMC Sweep','Breakout','Pullback','Scalp','News','Other'];
const RESULTS = ['win','loss','be','open'];
// Where the trade idea came from — the discipline tracker. "My Own Idea / Gut" = off-system.
const SOURCES = ['Command Center','Alpha Lab','DOW Pattern','Screener','AI Validated','My Own Idea / Gut'];
const OFF_SYSTEM = 'My Own Idea / Gut';

function ManualTradeForm({ initial, onSave, onCancel }) {
  const blank = { pair:'EUR/USD', direction:'LONG', entry:'', sl:'', tp:'', close:'',
    pnl:'', rr:'', result:'open', session:'', strategy:'', setupSource:'', notes:'', openedAt:'', closedAt:'' };
  const [f, setF] = useState(initial || blank);
  const set = (k, v) => setF(p => ({...p, [k]:v}));
  const isEdit = !!initial;

  const handleSave = () => {
    const pnlNum  = f.pnl  !== '' ? parseFloat(f.pnl)  : null;
    const rrNum   = f.rr   !== '' ? parseFloat(f.rr)   : null;
    const entryN  = f.entry !== '' ? parseFloat(f.entry) : null;
    const slN     = f.sl    !== '' ? parseFloat(f.sl)    : null;
    const tpN     = f.tp    !== '' ? parseFloat(f.tp)    : null;
    const closeN  = f.close !== '' ? parseFloat(f.close) : null;
    const openedAt = f.openedAt ? new Date(f.openedAt).toISOString() : new Date().toISOString();
    const closedAt = f.closedAt ? new Date(f.closedAt).toISOString() : (f.result !== 'open' ? new Date().toISOString() : null);
    onSave({ pair:f.pair, direction:f.direction, entry:entryN, sl:slN, tp:tpN, close:closeN,
      pnl:pnlNum, rr:rrNum, result:f.result, session:f.session, strategy:f.strategy,
      setupSource:f.setupSource, notes:f.notes.trim(), openedAt, closedAt });
  };

  const inp = (style={}) => ({
    background:'#0f172a', color:'#e2e8f0', border:'1px solid #334155', borderRadius:7,
    padding:'8px 12px', fontSize:12, outline:'none', width:'100%', boxSizing:'border-box', ...style,
  });
  const lbl = { fontSize:10, color:'#64748b', fontWeight:700, marginBottom:4, display:'block' };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:16 }}>
      <div style={{ background:'#0f172a', border:'1px solid #334155', borderRadius:16,
        width:'100%', maxWidth:500, padding:'20px 22px', maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ display:'flex', alignItems:'center', marginBottom:16 }}>
          <div style={{ fontSize:15, fontWeight:800, color:'#f8fafc', flex:1 }}>
            {isEdit ? 'Edit Trade' : 'Log New Trade'}
          </div>
          <button onClick={onCancel} style={{ background:'none', border:'none', color:'#64748b',
            fontSize:22, cursor:'pointer', lineHeight:1 }}>×</button>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          {/* Pair */}
          <div>
            <label style={lbl}>Pair</label>
            <select value={f.pair} onChange={e=>set('pair',e.target.value)} style={inp()}>
              {PAIRS.map(p => <option key={p}>{p}</option>)}
            </select>
          </div>
          {/* Direction */}
          <div>
            <label style={lbl}>Direction</label>
            <div style={{ display:'flex', gap:6 }}>
              {['LONG','SHORT'].map(d => (
                <button key={d} onClick={()=>set('direction',d)} style={{ flex:1, padding:'8px 0',
                  borderRadius:7, border:'none', cursor:'pointer', fontWeight:700, fontSize:12,
                  background:f.direction===d?(d==='LONG'?'#14532d':'#450a0a'):'#1e293b',
                  color:f.direction===d?(d==='LONG'?'#22c55e':'#ef4444'):'#64748b' }}>{d}</button>
              ))}
            </div>
          </div>
          {/* Entry */}
          <div>
            <label style={lbl}>Entry Price</label>
            <input type="number" step="any" placeholder="e.g. 1.08500" value={f.entry}
              onChange={e=>set('entry',e.target.value)} style={inp()}/>
          </div>
          {/* Close */}
          <div>
            <label style={lbl}>Close Price</label>
            <input type="number" step="any" placeholder="e.g. 1.09000" value={f.close}
              onChange={e=>set('close',e.target.value)} style={inp()}/>
          </div>
          {/* SL */}
          <div>
            <label style={lbl}>Stop Loss</label>
            <input type="number" step="any" placeholder="e.g. 1.08200" value={f.sl}
              onChange={e=>set('sl',e.target.value)} style={inp()}/>
          </div>
          {/* TP */}
          <div>
            <label style={lbl}>Take Profit</label>
            <input type="number" step="any" placeholder="e.g. 1.09500" value={f.tp}
              onChange={e=>set('tp',e.target.value)} style={inp()}/>
          </div>
          {/* PnL */}
          <div>
            <label style={lbl}>P&L ($)</label>
            <input type="number" step="any" placeholder="e.g. 120.50 or -45.00" value={f.pnl}
              onChange={e=>set('pnl',e.target.value)} style={inp()}/>
          </div>
          {/* R:R */}
          <div>
            <label style={lbl}>R:R Achieved</label>
            <input type="number" step="any" placeholder="e.g. 2.5" value={f.rr}
              onChange={e=>set('rr',e.target.value)} style={inp()}/>
          </div>
          {/* Result */}
          <div>
            <label style={lbl}>Result</label>
            <div style={{ display:'flex', gap:4 }}>
              {RESULTS.map(r => (
                <button key={r} onClick={()=>set('result',r)} style={{ flex:1, padding:'6px 0',
                  borderRadius:6, border:'none', cursor:'pointer', fontSize:10, fontWeight:700,
                  background:f.result===r?resultBg(r):'#1e293b',
                  color:f.result===r?resultColor(r):'#475569' }}>{r.toUpperCase()}</button>
              ))}
            </div>
          </div>
          {/* Session */}
          <div>
            <label style={lbl}>Session</label>
            <select value={f.session} onChange={e=>set('session',e.target.value)} style={inp()}>
              <option value="">— Select —</option>
              {SESSIONS.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          {/* Strategy */}
          <div>
            <label style={lbl}>Strategy</label>
            <select value={f.strategy} onChange={e=>set('strategy',e.target.value)} style={inp()}>
              <option value="">— Select —</option>
              {STRATEGIES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          {/* Setup Source — discipline tracker */}
          <div style={{ gridColumn:'1 / -1' }}>
            <label style={lbl}>📌 Setup Source — where did this trade come from?</label>
            <select value={f.setupSource} onChange={e=>set('setupSource',e.target.value)}
              style={inp({ border:`1px solid ${f.setupSource===OFF_SYSTEM ? '#ef4444' : f.setupSource ? '#00d4aa' : '#334155'}` })}>
              <option value="">— Select source (be honest) —</option>
              {SOURCES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          {/* Opened */}
          <div>
            <label style={lbl}>Opened At</label>
            <input type="datetime-local" value={f.openedAt} onChange={e=>set('openedAt',e.target.value)}
              style={inp({ colorScheme:'dark' })}/>
          </div>
          {/* Closed */}
          <div>
            <label style={lbl}>Closed At</label>
            <input type="datetime-local" value={f.closedAt} onChange={e=>set('closedAt',e.target.value)}
              style={inp({ colorScheme:'dark' })}/>
          </div>
        </div>

        {/* Notes */}
        <div style={{ marginTop:12 }}>
          <label style={lbl}>Notes / Thoughts</label>
          <textarea rows={3} placeholder="What did you see? Why did you enter? What could be better?"
            value={f.notes} onChange={e=>set('notes',e.target.value)}
            style={{ ...inp(), resize:'vertical', lineHeight:1.6, fontFamily:'inherit' }}/>
        </div>

        <div style={{ display:'flex', gap:10, marginTop:16, justifyContent:'flex-end' }}>
          <button onClick={onCancel} style={{ padding:'9px 20px', borderRadius:8, background:'#1e293b',
            border:'1px solid #334155', color:'#94a3b8', fontSize:12, cursor:'pointer', fontWeight:600 }}>
            Cancel</button>
          <button onClick={handleSave} style={{ padding:'9px 24px', borderRadius:8, background:'#00d4aa',
            border:'none', color:'#080c14', fontSize:12, cursor:'pointer', fontWeight:700 }}>
            {isEdit ? 'Save Changes' : 'Log Trade'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Manual Journal (localStorage) ────────────────────────────────────────────
const MAN_LS = 'forex_manual_trades_v1';
function loadManual()  { try { return JSON.parse(localStorage.getItem(MAN_LS)||'[]'); } catch { return []; } }
function saveManual(d) { localStorage.setItem(MAN_LS, JSON.stringify(d)); }

function ManualJournal() {
  const [rawTrades, setRaw]   = useState(loadManual);
  const [tab,       setTab]   = useState('overview');
  const [search,    setSearch]= useState('');
  const [filter,    setFilter]= useState('all');
  const [form,      setForm]  = useState(null); // null | 'new' | {trade obj}
  const [delId,     setDelId] = useState(null);

  const persist = useCallback((next) => { setRaw(next); saveManual(next); }, []);

  const handleSave = useCallback((data) => {
    const now = new Date().toISOString();
    if (form === 'new') {
      const id = `m_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      persist([...rawTrades, { ...data, id, createdAt:now }]);
    } else {
      persist(rawTrades.map(t => t.id === form.id ? { ...t, ...data, updatedAt:now } : t));
    }
    setForm(null);
  }, [form, rawTrades, persist]);

  const handleDelete = useCallback((id) => {
    persist(rawTrades.filter(t => t.id !== id));
    setDelId(null);
  }, [rawTrades, persist]);

  const trades  = useMemo(() => rawTrades.map(normManual), [rawTrades]);
  const closed  = useMemo(() => trades.filter(t=>t._result!=='open'), [trades]);
  const open    = useMemo(() => trades.filter(t=>t._result==='open'),  [trades]);
  const wins    = useMemo(() => closed.filter(t=>t._result==='win'),   [closed]);
  const losses  = useMemo(() => closed.filter(t=>t._result==='loss'),  [closed]);
  const bes     = useMemo(() => closed.filter(t=>t._result==='be'),    [closed]);
  const totalPnl= useMemo(() => closed.reduce((s,t)=>s+(t._pnl||0),0), [closed]);
  const gProfit = useMemo(() => wins.reduce((s,t)=>s+(t._pnl||0),0),   [wins]);
  const gLoss   = useMemo(() => Math.abs(losses.reduce((s,t)=>s+(t._pnl||0),0)), [losses]);
  const pf      = gLoss>0 ? gProfit/gLoss : wins.length>0 ? Infinity : 0;
  const winRate = closed.length>0 ? wins.length/closed.length*100 : 0;
  const avgWin  = wins.length>0 ? gProfit/wins.length : 0;
  const rrTrades= useMemo(() => closed.filter(t=>t._rr!=null), [closed]);
  const avgR    = rrTrades.length>0 ? rrTrades.reduce((s,t)=>s+Number(t._rr),0)/rrTrades.length : null;
  const pairStats= useMemo(() => {
    const m={}; closed.forEach(t=>{ const k=t._pair; if(!m[k])m[k]={pair:k,t:0,w:0,pnl:0}; m[k].t++; m[k].pnl+=t._pnl||0; if(t._result==='win')m[k].w++; });
    return Object.values(m).sort((a,b)=>b.pnl-a.pnl);
  }, [closed]);
  // Discipline: performance by where the trade came from (system vs gut)
  const sourceStats = useMemo(() => {
    const m={};
    closed.forEach(t=>{
      const k=t._setupSource || 'Untagged';
      if(!m[k]) m[k]={source:k,t:0,w:0,pnl:0,rSum:0,rN:0};
      m[k].t++; m[k].pnl+=t._pnl||0; if(t._result==='win')m[k].w++;
      if(t._rr!=null){ m[k].rSum+=Number(t._rr); m[k].rN++; }
    });
    return Object.values(m).sort((a,b)=>b.pnl-a.pnl);
  }, [closed]);
  // System (on-app) vs gut, the single headline number
  const systemVsGut = useMemo(() => {
    const agg = (pred) => {
      const arr = closed.filter(pred);
      const w = arr.filter(t=>t._result==='win').length;
      const pnl = arr.reduce((s,t)=>s+(t._pnl||0),0);
      const rArr = arr.filter(t=>t._rr!=null);
      const avgR = rArr.length ? rArr.reduce((s,t)=>s+Number(t._rr),0)/rArr.length : null;
      return { n:arr.length, wr: arr.length? w/arr.length*100 : null, pnl, avgR };
    };
    return {
      system: agg(t => t._setupSource && t._setupSource !== OFF_SYSTEM),
      gut:    agg(t => t._setupSource === OFF_SYSTEM),
    };
  }, [closed]);
  const wk = useMemo(()=>weeklyStats(closed),[closed]);
  const consistency = useMemo(()=>calcConsistency(closed),[closed]);
  const fmtPf = v => v===Infinity?'∞':v.toFixed(2);
  const filteredTrades = useMemo(() => {
    let list=[...trades];
    if (filter==='win') list=list.filter(t=>t._result==='win');
    else if(filter==='loss') list=list.filter(t=>t._result==='loss');
    else if(filter==='be')   list=list.filter(t=>t._result==='be');
    else if(filter==='open') list=list.filter(t=>t._result==='open');
    if (search.trim()) { const q=search.toLowerCase(); list=list.filter(t=>t._pair.toLowerCase().includes(q)||t._strategy.toLowerCase().includes(q)||t._notes.toLowerCase().includes(q)); }
    return list.sort((a,b)=>new Date(b._openedAt||0)-new Date(a._openedAt||0));
  }, [trades,filter,search]);

  return (
    <div style={{ maxWidth:600, margin:'0 auto', padding:'0 4px' }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', marginBottom:12 }}>
        <div style={{ flex:1, fontSize:11, color:'#475569' }}>
          {trades.length} trades logged manually · stored locally
        </div>
        <button onClick={()=>setForm('new')} style={{ padding:'7px 16px', borderRadius:8,
          background:'#00d4aa', border:'none', color:'#080c14', fontSize:12, fontWeight:700, cursor:'pointer' }}>
          + Log Trade</button>
      </div>

      <WeeklyCaptureCard wk={wk} consistency={consistency}/>

      <div style={{ display:'flex', gap:2, marginBottom:14, background:'#1e293b', borderRadius:10, padding:3 }}>
        {[['overview','Overview'],['log','Trade Log'],['performance','Performance']].map(([v,l]) => (
          <button key={v} onClick={()=>setTab(v)} style={{ flex:1, padding:'7px 4px', borderRadius:8,
            fontSize:12, fontWeight:600, border:'none', cursor:'pointer',
            background:tab===v?'#0f172a':'transparent', color:tab===v?'#f8fafc':'#64748b' }}>{l}</button>
        ))}
      </div>

      {/* ── Overview ── */}
      {tab === 'overview' && (
        <>
          {trades.length === 0 ? (
            <div style={{ textAlign:'center', padding:'50px 20px' }}>
              <div style={{ fontSize:40, marginBottom:12 }}>📝</div>
              <div style={{ fontSize:15, fontWeight:700, color:'#64748b', marginBottom:6 }}>No trades logged yet</div>
              <div style={{ fontSize:12, color:'#334155', marginBottom:18 }}>Manually log your trades to track performance independently</div>
              <button onClick={()=>setForm('new')} style={{ padding:'10px 24px', borderRadius:8,
                background:'#00d4aa', border:'none', color:'#080c14', fontSize:13, fontWeight:700, cursor:'pointer' }}>
                Log Your First Trade</button>
            </div>
          ) : (
            <>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
                <StatCard label="Total Trades" value={closed.length} sub={`${wins.length}W · ${losses.length}L · ${bes.length}BE`}/>
                <StatCard label="Win Rate" value={closed.length?`${winRate.toFixed(1)}%`:'—'}
                  color={closed.length?(winRate>=50?'#22c55e':'#ef4444'):'#64748b'} sub={`${wins.length}W / ${losses.length}L`}/>
                <StatCard label="Total PnL" value={closed.length?$pnl(totalPnl):'—'}
                  color={closed.length?pnlColor(totalPnl):'#64748b'}
                  sub={closed.length?`+$${gProfit.toFixed(2)} / -$${gLoss.toFixed(2)}`:null}/>
                <StatCard label="Profit Factor" value={closed.length?fmtPf(pf):'—'}
                  color={pf>=1.5?'#22c55e':pf>=1?'#f59e0b':'#ef4444'}/>
                <StatCard label="Avg R" value={avgR!=null?`${avgR>=0?'+':''}${avgR.toFixed(2)}R`:'—'}
                  color={avgR!=null?pnlColor(avgR):'#64748b'} sub={`${rrTrades.length} trades w/ R data`}/>
                <StatCard label="Avg Win" value={wins.length?`$${avgWin.toFixed(2)}`:'—'} color="#22c55e"
                  sub={`${wins.length} wins`}/>
              </div>
              {closed.length > 0 && <MonthCalendar trades={closed}/>}
              {closed.length > 1 && <EquityCurve   trades={closed}/>}
              {open.length > 0 && (
                <div style={{ marginTop:10, background:'#0c4a6e22', border:'1px solid #0ea5e933', borderRadius:10, padding:'12px 14px' }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#38bdf8', marginBottom:8 }}>{open.length} Open</div>
                  {open.map(t => <TradeCard key={t.id} t={t} onEdit={t2=>setForm(rawTrades.find(r=>r.id===t2.id))} onDelete={setDelId}/>)}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Log ── */}
      {tab === 'log' && (
        <>
          <input placeholder="Search pair, strategy, or notes…" value={search} onChange={e=>setSearch(e.target.value)}
            style={{ width:'100%', background:'#1e293b', color:'#e2e8f0', border:'1px solid #334155',
              borderRadius:8, padding:'8px 14px', fontSize:12, marginBottom:8, boxSizing:'border-box' }}/>
          <div style={{ display:'flex', gap:5, marginBottom:12, overflowX:'auto', paddingBottom:2 }}>
            {[['all',`All(${trades.length})`],['win',`Win(${wins.length})`],['loss',`Loss(${losses.length})`],
              ['be',`BE(${bes.length})`],['open','Open']].map(([v,l]) => (
              <button key={v} onClick={()=>setFilter(v)} style={{ flexShrink:0, padding:'5px 12px', borderRadius:20,
                fontSize:11, fontWeight:600, cursor:'pointer', border:'none',
                background:filter===v?'#00d4aa':'#1e293b', color:filter===v?'#080c14':'#94a3b8' }}>{l}</button>
            ))}
          </div>
          {filteredTrades.length===0
            ? <div style={{ textAlign:'center', padding:'30px 0', color:'#475569', fontSize:12 }}>No trades match</div>
            : filteredTrades.map(t => <TradeCard key={t.id} t={t}
                onEdit={t2=>setForm(rawTrades.find(r=>r.id===t2.id))}
                onDelete={setDelId}/>)}
        </>
      )}

      {/* ── Performance ── */}
      {tab === 'performance' && (
        <>
          {/* Discipline: System vs Gut headline */}
          {(systemVsGut.system.n > 0 || systemVsGut.gut.n > 0) && (
            <div style={{ background:'#1e293b', borderRadius:10, padding:'14px 16px', marginBottom:10 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'#f8fafc', marginBottom:3 }}>🎯 Discipline — System vs Gut</div>
              <div style={{ fontSize:10, color:'#475569', marginBottom:12 }}>
                Trades from the app's tools vs your own off-system ideas. The honest mirror.
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                {[['📊 System', systemVsGut.system, '#00d4aa'], ['🎲 Gut', systemVsGut.gut, '#ef4444']].map(([lbl, d, col]) => (
                  <div key={lbl} style={{ background:'#0f172a', borderRadius:9, padding:'11px 12px', border:`1px solid ${col}33` }}>
                    <div style={{ fontSize:11, fontWeight:800, color:col, marginBottom:8 }}>{lbl}</div>
                    {d.n === 0 ? (
                      <div style={{ fontSize:11, color:'#475569' }}>No trades tagged yet</div>
                    ) : (
                      <>
                        <div style={{ fontSize:24, fontWeight:900, color: d.wr>=50?'#22c55e':'#ef4444', lineHeight:1 }}>
                          {d.wr.toFixed(0)}%</div>
                        <div style={{ fontSize:9, color:'#475569', marginBottom:6 }}>win rate · {d.n} trades</div>
                        <div style={{ fontSize:11, fontWeight:700, color:pnlColor(d.pnl) }}>{$pnl(d.pnl)}</div>
                        {d.avgR!=null && (
                          <div style={{ fontSize:10, color:pnlColor(d.avgR) }}>{d.avgR>=0?'+':''}{d.avgR.toFixed(2)}R avg</div>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
              {systemVsGut.system.n > 0 && systemVsGut.gut.n > 0 && (
                <div style={{ marginTop:10, padding:'8px 11px', borderRadius:7, fontSize:11, lineHeight:1.5,
                  background: systemVsGut.system.pnl > systemVsGut.gut.pnl ? '#14532d22' : '#45050922',
                  border: `1px solid ${systemVsGut.system.pnl > systemVsGut.gut.pnl ? '#22c55e33' : '#ef444433'}`,
                  color: systemVsGut.system.pnl > systemVsGut.gut.pnl ? '#86efac' : '#fca5a5' }}>
                  {systemVsGut.system.pnl > systemVsGut.gut.pnl
                    ? `Your system trades made ${$pnl(systemVsGut.system.pnl - systemVsGut.gut.pnl)} more than your gut trades. The data says: stick to the tools.`
                    : `Your gut is currently beating the system by ${$pnl(systemVsGut.gut.pnl - systemVsGut.system.pnl)} — but check the sample size before trusting it.`}
                </div>
              )}
            </div>
          )}

          {/* By Setup Source */}
          {sourceStats.length > 0 && sourceStats.some(s => s.source !== 'Untagged') && (
            <div style={{ background:'#1e293b', borderRadius:10, padding:'14px 16px', marginBottom:10 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'#f8fafc', marginBottom:10 }}>By Setup Source</div>
              {sourceStats.map(s => {
                const wr = Math.round(s.w/s.t*100);
                const avgR = s.rN ? s.rSum/s.rN : null;
                const isGut = s.source === OFF_SYSTEM;
                return (
                  <div key={s.source} style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 0', borderBottom:'1px solid #0f172a' }}>
                    <span style={{ fontSize:11, fontWeight:700, color:isGut?'#fca5a5':'#e2e8f0', minWidth:110 }}>{s.source}</span>
                    <span style={{ fontSize:10, color:'#475569', minWidth:22 }}>{s.t}T</span>
                    <span style={{ fontSize:10, color:wr>=50?'#22c55e':'#ef4444', minWidth:30 }}>{wr}%</span>
                    {avgR!=null && <span style={{ fontSize:10, color:pnlColor(avgR), minWidth:42 }}>{avgR>=0?'+':''}{avgR.toFixed(1)}R</span>}
                    <span style={{ marginLeft:'auto', fontSize:11, fontWeight:700, color:pnlColor(s.pnl) }}>{$pnl(s.pnl)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {pairStats.length > 0 && (
            <div style={{ background:'#1e293b', borderRadius:10, padding:'14px 16px', marginBottom:10 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'#f8fafc', marginBottom:10 }}>By Pair</div>
              {pairStats.slice(0,20).map(s => (
                <div key={s.pair} style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 0', borderBottom:'1px solid #0f172a' }}>
                  <span style={{ fontSize:12, fontWeight:700, color:'#e2e8f0', minWidth:70 }}>{s.pair}</span>
                  <span style={{ fontSize:10, color:'#475569', minWidth:22 }}>{s.t}T</span>
                  <span style={{ fontSize:10, color:s.w/s.t>=0.5?'#22c55e':'#ef4444', minWidth:28 }}>{Math.round(s.w/s.t*100)}%</span>
                  <div style={{ flex:1 }}>
                    <div style={{ height:3, borderRadius:2, background:'#0f172a', overflow:'hidden' }}>
                      <div style={{ height:'100%', width:`${s.w/s.t*100}%`, background:s.w/s.t>=0.5?'#22c55e':'#ef4444', borderRadius:2 }}/>
                    </div>
                  </div>
                  <span style={{ fontSize:12, fontWeight:700, color:pnlColor(s.pnl), minWidth:56, textAlign:'right' }}>{$pnl(s.pnl)}</span>
                </div>
              ))}
            </div>
          )}
          {closed.length === 0 && (
            <div style={{ textAlign:'center', padding:'30px 0', color:'#475569', fontSize:12 }}>
              No closed trades yet</div>
          )}
        </>
      )}

      {/* Form modal */}
      {form !== null && (
        <ManualTradeForm
          initial={form === 'new' ? null : {
            ...form,
            entry:     form.entry    != null ? String(form.entry)    : '',
            sl:        form.sl       != null ? String(form.sl)       : '',
            tp:        form.tp       != null ? String(form.tp)       : '',
            close:     form.close    != null ? String(form.close)    : '',
            pnl:       form.pnl      != null ? String(form.pnl)      : '',
            rr:        form.rr       != null ? String(form.rr)       : '',
            openedAt:  form.openedAt ? new Date(form.openedAt).toISOString().slice(0,16) : '',
            closedAt:  form.closedAt ? new Date(form.closedAt).toISOString().slice(0,16) : '',
          }}
          onSave={handleSave}
          onCancel={()=>setForm(null)}
        />
      )}

      {/* Delete confirm */}
      {delId && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)',
          display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <div style={{ background:'#0f172a', border:'1px solid #334155', borderRadius:14,
            padding:'24px 28px', maxWidth:300, textAlign:'center' }}>
            <div style={{ fontSize:28, marginBottom:10 }}>🗑️</div>
            <div style={{ fontSize:14, fontWeight:700, color:'#f8fafc', marginBottom:6 }}>Delete Trade?</div>
            <div style={{ fontSize:12, color:'#475569', marginBottom:18 }}>This cannot be undone.</div>
            <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
              <button onClick={()=>setDelId(null)} style={{ padding:'8px 18px', borderRadius:8, background:'#1e293b',
                border:'1px solid #334155', color:'#94a3b8', fontSize:12, cursor:'pointer', fontWeight:600 }}>Cancel</button>
              <button onClick={()=>handleDelete(delId)} style={{ padding:'8px 18px', borderRadius:8, background:'#ef4444',
                border:'none', color:'#fff', fontSize:12, cursor:'pointer', fontWeight:700 }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Root Journal (mode switcher) ──────────────────────────────────────────────
export default function Journal() {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const [mode, setMode] = useState('vps'); // 'vps' | 'manual'

  return (
    <div style={{ padding:'14px 16px', overflowY:'auto', height:'100%' }}>
      {/* Greeting header */}
      <div style={{ marginBottom:16 }}>
        <div style={{ fontSize:22, fontWeight:900, color:'#f8fafc' }}>
          {greet}, Trader 👋
        </div>
        <div style={{ fontSize:12, color:'#475569', marginTop:3 }}>
          Review · Reflect · Refine · Repeat
        </div>
      </div>

      {/* Mode switcher */}
      <div style={{ display:'inline-flex', background:'#1e293b', borderRadius:10, padding:3, marginBottom:18, gap:2 }}>
        <button onClick={()=>setMode('vps')} style={{ padding:'8px 20px', borderRadius:8, border:'none',
          cursor:'pointer', fontSize:12, fontWeight:700,
          background:mode==='vps'?'#0f172a':'transparent',
          color:mode==='vps'?'#00d4aa':'#64748b' }}>
          🤖 VPS Bot Journal
        </button>
        <button onClick={()=>setMode('manual')} style={{ padding:'8px 20px', borderRadius:8, border:'none',
          cursor:'pointer', fontSize:12, fontWeight:700,
          background:mode==='manual'?'#0f172a':'transparent',
          color:mode==='manual'?'#818cf8':'#64748b' }}>
          ✍️ Manual Journal
        </button>
      </div>

      {/* Render active journal */}
      {mode === 'vps'    ? <VPSJournal/>    : <ManualJournal/>}
    </div>
  );
}

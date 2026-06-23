'use strict';
import { useState, useMemo } from 'react';
import ChartModal from './ChartModal';

const SETUP_KEY = 'trade_setups_v1';

const PAIRS = [
  'EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD','NZD/USD',
  'GBP/JPY','EUR/JPY','EUR/GBP','AUD/JPY','CAD/JPY',
  'XAU/USD','XAG/USD',
  'US30','NAS100','SPX500','GER40','JPN225','UK100',
];
const TFS = ['M15','M30','H1','H4','D1','W1'];

const STATUS = {
  planned:     { label:'Planned',     color:'#f59e0b', bg:'#f59e0b18' },
  triggered:   { label:'Triggered',   color:'#3b82f6', bg:'#3b82f618' },
  won:         { label:'Won ✓',       color:'#22c55e', bg:'#22c55e18' },
  lost:        { label:'Lost ✗',      color:'#ef4444', bg:'#ef444418' },
  invalidated: { label:'Invalidated', color:'#475569', bg:'#47556918' },
};

function load() { try { return JSON.parse(localStorage.getItem(SETUP_KEY) || '[]'); } catch { return []; } }
function save(list) { try { localStorage.setItem(SETUP_KEY, JSON.stringify(list)); } catch {} }

function rr(entry, sl, tp) {
  const e = +entry, s = +sl, t = +tp;
  if (!e || !s || !t || e === s) return null;
  return (Math.abs(t - e) / Math.abs(e - s)).toFixed(2);
}

function fmt(v) {
  if (v == null) return '—';
  if (v >= 10000) return v.toFixed(1);
  if (v >= 100) return v.toFixed(2);
  if (v >= 1) return v.toFixed(3);
  return v.toFixed(5);
}

function RRViz({ entry, sl, tp1, tp2 }) {
  if (!entry || !sl || !tp1) return null;
  const rr1 = +rr(entry, sl, tp1);
  const rr2 = tp2 ? +rr(entry, sl, tp2) : null;
  if (!rr1) return null;
  const max = Math.max(rr1, rr2 || 0, 2);
  const slW = 12;
  const entryX = slW + 2;
  const tp1X = entryX + Math.round((rr1 / max) * 82);
  const tp2X = rr2 ? entryX + Math.round((rr2 / max) * 82) : null;
  return (
    <div style={{ padding:'8px 12px', background:'#060a14', borderRadius:8, border:'1px solid #0f1929', marginBottom:10 }}>
      <div style={{ fontSize:9, color:'#475569', fontWeight:700, letterSpacing:'0.06em', marginBottom:6 }}>R:R PROFILE</div>
      <svg width="100%" height="30" viewBox="0 0 100 30" preserveAspectRatio="none">
        <rect x={0} y={10} width={slW} height={10} fill="#ef444425" stroke="#ef444455" strokeWidth={0.5} rx={1}/>
        <text x={slW/2} y={26} textAnchor="middle" fontSize={5} fill="#ef4444">SL</text>
        <rect x={entryX} y={6} width={2} height={18} fill="#f1f5f9" rx={1}/>
        <text x={entryX+1} y={4} textAnchor="middle" fontSize={5} fill="#f1f5f9">E</text>
        {rr2 && tp2X && (
          <rect x={entryX+2} y={12} width={tp2X-entryX-2} height={6} fill="#22c55e18" stroke="#22c55e44" strokeWidth={0.5} strokeDasharray="2,1" rx={1}/>
        )}
        <rect x={entryX+2} y={9} width={tp1X-entryX-2} height={12} fill="#22c55e30" stroke="#22c55e66" strokeWidth={0.5} rx={1}/>
        <text x={tp1X+1} y={16} fontSize={5} fill="#22c55e">TP1 {rr1}R</text>
        {rr2 && tp2X && <text x={tp2X+1} y={26} fontSize={5} fill="#22c55e88">TP2 {rr2}R</text>}
      </svg>
    </div>
  );
}

const BLANK = { pair:'EUR/USD', direction:'LONG', tf:'H4', entry:'', sl:'', tp1:'', tp2:'', notes:'', status:'planned' };

export default function SetupPlanner() {
  const [setups, setSetups] = useState(load);
  const [showForm, setShowForm]     = useState(false);
  const [editId, setEditId]         = useState(null);
  const [chartSetup, setChartSetup] = useState(null);
  const [filterStatus, setFilter]   = useState('All');
  const [form, setForm]             = useState(BLANK);

  const fld = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const rr1 = rr(form.entry, form.sl, form.tp1);
  const rr2 = form.tp2 ? rr(form.entry, form.sl, form.tp2) : null;

  const openNew = () => { setForm(BLANK); setEditId(null); setShowForm(true); };
  const openEdit = s => { setForm({ ...s, entry:String(s.entry), sl:String(s.sl), tp1:String(s.tp1), tp2:s.tp2?String(s.tp2):'' }); setEditId(s.id); setShowForm(true); };

  const submit = () => {
    if (!form.entry || !form.sl || !form.tp1) return;
    const setup = {
      ...form, entry:+form.entry, sl:+form.sl, tp1:+form.tp1, tp2:form.tp2?+form.tp2:null,
      rr1: rr1?+rr1:null, rr2: rr2?+rr2:null,
      id: editId || `s_${Date.now()}`,
      createdAt: editId ? setups.find(s=>s.id===editId)?.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const updated = editId ? setups.map(s => s.id===editId ? setup : s) : [setup, ...setups];
    save(updated); setSetups(updated); setShowForm(false); setEditId(null); setForm(BLANK);
  };

  const updateStatus = (id, status) => {
    const updated = setups.map(s => s.id===id ? { ...s, status, updatedAt:new Date().toISOString() } : s);
    save(updated); setSetups(updated);
  };

  const del = id => {
    const updated = setups.filter(s => s.id !== id);
    save(updated); setSetups(updated);
  };

  const counts = useMemo(() => {
    const c = {};
    Object.keys(STATUS).forEach(k => { c[k] = setups.filter(s => s.status===k).length; });
    c.All = setups.length;
    return c;
  }, [setups]);

  const filtered = filterStatus === 'All' ? setups : setups.filter(s => s.status===filterStatus);

  const inputStyle = (border='#1e293b') => ({
    width:'100%', background:'#0a0e1a', border:`1px solid ${border}`,
    borderRadius:6, color:'#f1f5f9', fontSize:11, padding:'6px 8px', boxSizing:'border-box',
  });

  return (
    <div style={{ background:'#04070f', minHeight:'100vh', padding:'14px 12px', paddingBottom:80 }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:900, color:'#f1f5f9', letterSpacing:'0.06em' }}>📌 SETUP PLANNER</div>
          <div style={{ fontSize:10, color:'#334155', marginTop:2 }}>Plan trade setups before price arrives · {setups.length} saved</div>
        </div>
        <button onClick={showForm ? () => setShowForm(false) : openNew} style={{
          padding:'8px 14px', borderRadius:10, border:'1px solid #3b82f644',
          background:'#3b82f618', color:'#3b82f6', fontSize:12, fontWeight:800, cursor:'pointer',
        }}>{showForm ? '✕ Cancel' : '+ New Setup'}</button>
      </div>

      {/* Status filter */}
      <div style={{ display:'flex', gap:5, marginBottom:14, flexWrap:'wrap' }}>
        {['All', ...Object.keys(STATUS)].map(s => {
          const m = STATUS[s];
          const active = filterStatus === s;
          return (
            <button key={s} onClick={() => setFilter(s)} style={{
              padding:'4px 10px', borderRadius:8, fontSize:10, fontWeight:700, cursor:'pointer',
              border:`1px solid ${active ? (m?.color||'#00d4aa')+'55' : '#0f1929'}`,
              background: active ? `${m?.color||'#00d4aa'}18` : 'transparent',
              color: active ? (m?.color||'#00d4aa') : '#334155',
            }}>{m?.label||'All'} <span style={{ opacity:0.6 }}>({counts[s]||0})</span></button>
          );
        })}
      </div>

      {/* Form */}
      {showForm && (
        <div style={{ background:'#06090f', borderRadius:14, border:'1px solid #0f1929', padding:16, marginBottom:14 }}>
          <div style={{ fontSize:11, fontWeight:800, color:'#f1f5f9', marginBottom:12 }}>
            {editId ? '✏️ Edit Setup' : '📌 New Trade Setup'}
          </div>

          {/* Pair / Dir / TF */}
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:8, marginBottom:10 }}>
            <div>
              <label style={{ fontSize:10, color:'#475569', display:'block', marginBottom:4 }}>Pair</label>
              <select value={form.pair} onChange={e => fld('pair',e.target.value)} style={inputStyle()}>
                {PAIRS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize:10, color:'#475569', display:'block', marginBottom:4 }}>Direction</label>
              <div style={{ display:'flex', gap:4, height:32 }}>
                {['LONG','SHORT'].map(d => {
                  const c = d==='LONG' ? '#22c55e' : '#ef4444';
                  const active = form.direction===d;
                  return (
                    <button key={d} onClick={() => fld('direction',d)} style={{
                      flex:1, borderRadius:6, fontSize:11, fontWeight:800, cursor:'pointer',
                      border:`1px solid ${active ? c+'55' : '#1e293b'}`,
                      background: active ? c+'18' : 'transparent', color: active ? c : '#475569',
                    }}>{d==='LONG'?'▲':'▼'} {d}</button>
                  );
                })}
              </div>
            </div>
            <div>
              <label style={{ fontSize:10, color:'#475569', display:'block', marginBottom:4 }}>Timeframe</label>
              <select value={form.tf} onChange={e => fld('tf',e.target.value)} style={inputStyle()}>
                {TFS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* Levels */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:10 }}>
            {[
              { key:'entry', label:'Entry',     color:'#f1f5f9' },
              { key:'sl',    label:'Stop Loss', color:'#ef4444' },
              { key:'tp1',   label:'TP 1 *',    color:'#22c55e' },
              { key:'tp2',   label:'TP 2',      color:'#86efac' },
            ].map(f => (
              <div key={f.key}>
                <label style={{ fontSize:10, color:f.color, display:'block', marginBottom:4, fontWeight:700 }}>{f.label}</label>
                <input type="number" step="any" value={form[f.key]} onChange={e => fld(f.key,e.target.value)}
                  placeholder="0.00000"
                  style={{ ...inputStyle(`${f.color}33`), color:f.color, fontFamily:'monospace' }}
                />
              </div>
            ))}
          </div>

          {/* R:R display */}
          {rr1 && (
            <div style={{ display:'flex', gap:8, marginBottom:10 }}>
              <div style={{ flex:1, background:'#22c55e10', border:'1px solid #22c55e33', borderRadius:8, padding:'6px 10px', textAlign:'center' }}>
                <div style={{ fontSize:9, color:'#475569', marginBottom:1 }}>R:R → TP1</div>
                <div style={{ fontSize:20, fontWeight:900, color:'#22c55e' }}>1:{rr1}</div>
              </div>
              {rr2 && (
                <div style={{ flex:1, background:'#22c55e08', border:'1px solid #22c55e22', borderRadius:8, padding:'6px 10px', textAlign:'center' }}>
                  <div style={{ fontSize:9, color:'#475569', marginBottom:1 }}>R:R → TP2</div>
                  <div style={{ fontSize:20, fontWeight:900, color:'#86efac' }}>1:{rr2}</div>
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          <div style={{ marginBottom:12 }}>
            <label style={{ fontSize:10, color:'#475569', display:'block', marginBottom:4 }}>Thesis / Confluence</label>
            <textarea value={form.notes} onChange={e => fld('notes',e.target.value)} rows={3}
              placeholder="Why this setup? e.g. BOS on H4, OB at discount, London KZ entry, HTF bullish…"
              style={{ width:'100%', background:'#0a0e1a', border:'1px solid #1e293b', borderRadius:6,
                color:'#94a3b8', fontSize:11, padding:'8px', resize:'vertical', fontFamily:'inherit', boxSizing:'border-box' }}
            />
          </div>

          <button onClick={submit} disabled={!form.entry || !form.sl || !form.tp1} style={{
            width:'100%', padding:'11px', borderRadius:10, fontSize:13, fontWeight:800, cursor:'pointer',
            border:'1px solid #3b82f644', background: (!form.entry||!form.sl||!form.tp1) ? '#0a0e1a' : '#3b82f618',
            color: (!form.entry||!form.sl||!form.tp1) ? '#334155' : '#3b82f6',
          }}>{editId ? '💾 Update Setup' : '📌 Save Setup'}</button>
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <div style={{ textAlign:'center', padding:'40px 20px', color:'#1e293b', fontSize:13 }}>
          {setups.length === 0 ? 'No setups yet — click "+ New Setup" to plan your first trade' : 'No setups with this status'}
        </div>
      )}

      {/* Setup cards */}
      {filtered.map(setup => {
        const m = STATUS[setup.status] || STATUS.planned;
        const dirColor = setup.direction==='LONG' ? '#22c55e' : '#ef4444';
        return (
          <div key={setup.id} style={{ background:'#06090f', borderRadius:14, border:'1px solid #0f1929', marginBottom:10, overflow:'hidden' }}>

            {/* Card header */}
            <div style={{ padding:'12px 14px', borderBottom:'1px solid #0a0e1a' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                <span style={{ fontSize:14, fontWeight:900, color:dirColor }}>{setup.direction==='LONG'?'▲':'▼'} {setup.pair}</span>
                <span style={{ fontSize:9, color:'#475569', background:'#0a0e1a', padding:'2px 6px', borderRadius:4 }}>{setup.tf}</span>
                <span style={{ fontSize:9, fontWeight:700, color:m.color, background:m.bg,
                  padding:'2px 8px', borderRadius:6, border:`1px solid ${m.color}44` }}>{m.label}</span>
                <div style={{ marginLeft:'auto', display:'flex', gap:4 }}>
                  <button onClick={() => setChartSetup(setup)}
                    style={{ background:'#0a0e1a', border:'1px solid #1e293b', borderRadius:6, color:'#64748b', fontSize:11, padding:'3px 8px', cursor:'pointer' }}>📊</button>
                  <button onClick={() => openEdit(setup)}
                    style={{ background:'#0a0e1a', border:'1px solid #1e293b', borderRadius:6, color:'#64748b', fontSize:11, padding:'3px 8px', cursor:'pointer' }}>✏️</button>
                  <button onClick={() => del(setup.id)}
                    style={{ background:'#0a0e1a', border:'1px solid #ef444422', borderRadius:6, color:'#ef4444', fontSize:11, padding:'3px 8px', cursor:'pointer' }}>✕</button>
                </div>
              </div>

              {/* Price levels */}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6, marginBottom: setup.notes ? 8 : 0 }}>
                {[
                  { label:'ENTRY', val:setup.entry, color:'#f1f5f9' },
                  { label:'STOP',  val:setup.sl,    color:'#ef4444' },
                  { label:'TP1',   val:setup.tp1,   color:'#22c55e', sub: setup.rr1?`1:${setup.rr1}R`:null },
                  { label:'TP2',   val:setup.tp2,   color:'#86efac', sub: setup.rr2?`1:${setup.rr2}R`:null },
                ].map(lv => (
                  <div key={lv.label} style={{ background:'#0a0e1a', borderRadius:6, padding:'5px 8px',
                    border:`1px solid ${lv.color}18`, textAlign:'center', opacity: lv.val ? 1 : 0.35 }}>
                    <div style={{ fontSize:7, color:'#334155', fontWeight:700, letterSpacing:'0.06em' }}>{lv.label}</div>
                    <div style={{ fontSize:10, fontWeight:900, color: lv.val ? lv.color : '#334155', fontFamily:'monospace' }}>{fmt(lv.val)}</div>
                    {lv.sub && <div style={{ fontSize:7, color:lv.color, opacity:0.7 }}>{lv.sub}</div>}
                  </div>
                ))}
              </div>

              {setup.notes && (
                <div style={{ fontSize:10, color:'#64748b', lineHeight:1.5, paddingTop:6, borderTop:'1px solid #0a0e1a', marginTop:4 }}>
                  {setup.notes}
                </div>
              )}
            </div>

            {/* Status bar */}
            <div style={{ padding:'7px 14px', display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}>
              <span style={{ fontSize:9, color:'#334155', fontWeight:700, flexShrink:0 }}>STATUS →</span>
              {Object.entries(STATUS).map(([k, sm]) => (
                <button key={k} onClick={() => updateStatus(setup.id, k)} style={{
                  padding:'2px 8px', borderRadius:6, fontSize:9, fontWeight:700, cursor:'pointer',
                  border:`1px solid ${setup.status===k ? sm.color+'55' : '#0f1929'}`,
                  background: setup.status===k ? sm.bg : 'transparent',
                  color: setup.status===k ? sm.color : '#334155',
                }}>{sm.label}</button>
              ))}
              <span style={{ marginLeft:'auto', fontSize:8, color:'#1e293b' }}>
                {new Date(setup.createdAt).toLocaleDateString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}
              </span>
            </div>
          </div>
        );
      })}

      {/* ChartModal with setup levels */}
      {chartSetup && (
        <ChartModal
          instrument={{ symbol: chartSetup.pair }}
          setupLevels={{ entry:chartSetup.entry, sl:chartSetup.sl, tp1:chartSetup.tp1, tp2:chartSetup.tp2, direction:chartSetup.direction }}
          onClose={() => setChartSetup(null)}
        />
      )}
    </div>
  );
}

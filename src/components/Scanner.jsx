import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { runScan } from '../utils/scanner';
import { CLASS, CLASS_ORDER } from '../data/instruments';
import { stats as cacheStats, clearAll } from '../utils/marketCache';

const C = {
  bg:'#080c11', panel:'#0b1118', line:'#16202b', dim:'#475569', txt:'#cbd5e1',
  accent:'#00d4aa', warn:'#f59e0b', bad:'#ef4444', good:'#22c55e', mono:'var(--mono, monospace)',
};

const TAG_COL = {
  VOL:'#a78bfa', RANGE:'#0ea5e9', MOVE:'#f59e0b', TREND:'#64748b',
  COST:'#ef4444', POSN:'#22c55e', SMART:'#eab308',
};

function Bar({ pct, color }) {
  return (
    <div style={{ width:38, height:6, background:'#131c26', borderRadius:2, overflow:'hidden', flexShrink:0 }}>
      <div style={{ width:`${Math.max(0, Math.min(100, pct ?? 0))}%`, height:'100%', background:color }}/>
    </div>
  );
}

function Row({ r, onOpen }) {
  const cls = CLASS[r.cls];
  return (
    <div onClick={() => onOpen(r.sym)} style={{ borderBottom:`1px solid #0e161e`, padding:'6px 9px', cursor:'pointer' }}>
      <div style={{ display:'flex', alignItems:'center', gap:7, fontFamily:C.mono }}>
        <span style={{ fontSize:11, fontWeight:800, color:C.txt, width:82, flexShrink:0 }}>{r.sym}</span>
        <span style={{ fontSize:8, fontWeight:800, color:cls.color, width:44, flexShrink:0 }}>{cls.label}</span>

        <span style={{ fontSize:9, color:C.dim, width:30, flexShrink:0, textAlign:'right' }}>vol</span>
        <Bar pct={r.m?.volPct} color={r.m?.volPct >= 90 ? '#a78bfa' : '#334155'}/>
        <span style={{ fontSize:9, color: r.m?.volPct >= 90 ? '#a78bfa' : C.dim, width:26, flexShrink:0 }}>
          {r.m?.volPct ?? '—'}
        </span>

        <span style={{ fontSize:9, color: (r.m?.chg20 ?? 0) > 0 ? C.good : C.bad, width:52, flexShrink:0, textAlign:'right' }}>
          {r.m ? `${r.m.chg20 > 0 ? '+' : ''}${r.m.chg20}%` : '—'}
        </span>

        <span style={{ marginLeft:'auto', fontSize:11, fontWeight:900, flexShrink:0,
          color: r.score >= 6 ? C.bad : r.score >= 3 ? C.warn : '#334155' }}>
          {r.score || ''}
        </span>
        <button onClick={() => onOpen(r.sym)} title="Open in Instrument view"
          style={{ fontSize:10, padding:'1px 6px', borderRadius:3, cursor:'pointer',
            border:`1px solid ${C.line}`, background:'transparent', color:C.dim }}>→</button>
      </div>

      {r.signals.length > 0 && (
        <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginTop:4, paddingLeft:2 }}>
          {r.signals.map((s, i) => (
            <span key={i} style={{ fontSize:9, fontFamily:C.mono, color:TAG_COL[s.tag] || C.dim,
              border:`1px solid ${(TAG_COL[s.tag] || '#334155')}33`, background:`${TAG_COL[s.tag] || '#334155'}0d`,
              borderRadius:2, padding:'1px 6px' }}>
              <strong style={{ fontWeight:800 }}>{s.tag}</strong> {s.txt}
            </span>
          ))}
        </div>
      )}
      {r.error && (
        <div style={{ fontSize:9, color:'#334155', fontFamily:C.mono, marginTop:3 }}>no data: {r.error}</div>
      )}
    </div>
  );
}

export default function Scanner({ onOpen }) {
  const [rows,    setRows]    = useState([]);
  const [busy,    setBusy]    = useState(false);
  const [prog,    setProg]    = useState({ done:0, total:0 });
  const [gran,    setGran]    = useState('H4');
  const [filter,  setFilter]  = useState('all');
  const [ranAt,   setRanAt]   = useState(null);
  const started = useRef(false);

  const scan = useCallback(async (force = false) => {
    setBusy(true); setProg({ done:0, total:0 });
    try {
      const partial = [];
      const out = await runScan({
        granularity: gran, force,
        onProgress: (done, total, row) => {
          setProg({ done, total });
          // fill the table as results land rather than waiting for the slowest
          if (row && row.sym) {
            partial.push(row);
            if (done % 5 === 0 || done === total) {
              setRows([...partial].sort((a, b) => b.score - a.score));
            }
          }
        },
      });
      setRows(out);
      setRanAt(new Date());
    } catch { /* individual failures are already captured per row */ }
    setBusy(false);
  }, [gran]);

  // Kick off in an effect, not during render — calling setState from a render
  // pass is a React violation and made the first scan unreliable.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    scan(false);
  }, [scan]);

  const shown = useMemo(() => {
    const f = filter === 'all' ? rows
      : filter === 'flagged' ? rows.filter(r => r.score >= 3)
      : rows.filter(r => r.cls === filter);
    return f;
  }, [rows, filter]);

  const flagged = rows.filter(r => r.score >= 3).length;
  const cs = cacheStats();

  return (
    <div style={{ background:C.bg, minHeight:'100vh', paddingBottom:80, fontFamily:C.mono }}>
      <div style={{ position:'sticky', top:0, zIndex:5, background:C.bg, borderBottom:`1px solid ${C.line}`, padding:'9px 10px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          <span style={{ fontSize:14, fontWeight:900, color:C.accent, letterSpacing:'2px' }}>SCAN</span>
          <span style={{ fontSize:9, color:C.dim }}>what is unusual right now</span>
          <span style={{ marginLeft:'auto', fontSize:9, color:C.dim }}>
            {busy ? `${prog.done}/${prog.total || '…'}` : ranAt ? `ran ${ranAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : ''}
          </span>
          <button onClick={() => scan(true)} disabled={busy}
            style={{ fontSize:10, fontWeight:800, padding:'3px 9px', borderRadius:3, cursor:busy?'default':'pointer',
              border:`1px solid ${C.accent}44`, background:'#00d4aa15', color:C.accent }}>↻</button>
        </div>

        <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginTop:7 }}>
          {['H1','H4','D'].map(g => (
            <button key={g} onClick={() => { setGran(g); setTimeout(() => scan(false), 0); }}
              style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:2, cursor:'pointer',
                border:`1px solid ${gran===g?'#00d4aa55':C.line}`, background:gran===g?'#00d4aa15':'transparent',
                color:gran===g?C.accent:C.dim }}>{g}</button>
          ))}
          <span style={{ width:8 }}/>
          {[['flagged',`flagged ${flagged}`], ['all',`all ${rows.length}`], ...CLASS_ORDER.map(c => [c, CLASS[c].label])].map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)}
              style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:2, cursor:'pointer',
                border:`1px solid ${filter===k?'#00d4aa55':C.line}`, background:filter===k?'#00d4aa15':'transparent',
                color:filter===k?C.accent:C.dim }}>{label}</button>
          ))}
        </div>

        {busy && prog.total > 0 && (
          <div style={{ height:2, background:'#131c26', borderRadius:1, marginTop:7, overflow:'hidden' }}>
            <div style={{ width:`${(prog.done/prog.total)*100}%`, height:'100%', background:C.accent, transition:'width .2s' }}/>
          </div>
        )}
      </div>

      <div style={{ padding:'8px 10px 0', fontSize:9, color:'#334155', lineHeight:1.6 }}>
        Each instrument is measured against its <strong style={{color:C.dim}}>own</strong> history, so a metal and an
        FX cross are judged on the same scale. The number on the right counts how many unusual things are true at
        once — it is a reason to look, not a signal to trade.
      </div>

      <div style={{ margin:'8px 10px', background:C.panel, border:`1px solid ${C.line}`, borderRadius:5, overflow:'hidden' }}>
        {shown.length === 0 && !busy && (
          <div style={{ padding:16, fontSize:10, color:C.dim }}>
            {rows.length === 0 ? 'No data — connect OANDA in Settings for FX, metals, indices and energy.'
                               : 'Nothing matches this filter. Markets are behaving normally.'}
          </div>
        )}
        {shown.map(r => (
          <Row key={r.sym} r={r} onOpen={onOpen}/>
        ))}
      </div>

      <div style={{ padding:'0 12px 20px', fontSize:8, color:'#2b3644', lineHeight:1.6 }}>
        {cs.entries} cached values · candles 1 min, spreads 2 min, COT 6 h.
        <button onClick={() => { clearAll(); scan(true); }}
          style={{ marginLeft:6, fontSize:8, background:'none', border:'none', color:'#475569', cursor:'pointer', textDecoration:'underline' }}>
          clear cache
        </button>
      </div>
    </div>
  );
}

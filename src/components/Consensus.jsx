import { useState, useEffect, useCallback, useRef } from 'react';
import { runConsensus, FAMILIES, DEFAULTS } from '../utils/consensus';

const C = {
  panel:'#0b1118', line:'#16202b', dim:'#475569', txt:'#cbd5e1',
  accent:'#00d4aa', warn:'#f59e0b', bad:'#ef4444', good:'#22c55e', mono:'var(--mono, monospace)',
};

const ARROW = d => d === 'up' ? '▲' : d === 'down' ? '▼' : '—';
const DIRCOL = d => d === 'up' ? C.good : d === 'down' ? C.bad : '#334155';

// One row per source, so the verdict can always be traced back to who said what
function SourceRows({ votes, missing }) {
  return (
    <div style={{ marginTop:6 }}>
      {Object.entries(FAMILIES).map(([key, f]) => {
        const v = votes[key];
        const absent = !v;
        return (
          <div key={key} style={{ display:'flex', gap:7, alignItems:'baseline', padding:'2px 0', fontFamily:C.mono }}>
            <span style={{ fontSize:9, color: absent ? '#2b3644' : C.dim, width:74, flexShrink:0 }}>{f.label}</span>
            <span style={{ fontSize:10, color: absent ? '#2b3644' : DIRCOL(v.dir), width:12, flexShrink:0 }}>
              {absent ? '·' : ARROW(v.dir)}
            </span>
            <span style={{ fontSize:9, color: absent ? '#2b3644' : '#64748b', flex:1, minWidth:0 }}>
              {absent ? 'no data' : v.detail}
            </span>
          </div>
        );
      })}
      {missing.length > 0 && (
        <div style={{ fontSize:8, color:'#2b3644', fontFamily:C.mono, marginTop:3 }}>
          {4 - missing.length}/4 sources available
        </div>
      )}
    </div>
  );
}

export function ConsensusRow({ r }) {
  const v = r.verdict;
  const state = v.state;
  const col = state === 'aligned' ? (v.dir === 'up' ? C.good : C.bad)
            : state === 'conflict' ? C.warn
            : state === 'blocked' ? '#a78bfa' : '#334155';
  const sig = r.votes.structure?.signal;

  return (
    <div style={{ border:`1px solid ${col}33`, background:`${col}08`, borderRadius:5,
      padding:'8px 10px', marginBottom:6 }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:8, flexWrap:'wrap', fontFamily:C.mono }}>
        <span style={{ fontSize:12, fontWeight:900, color:C.txt }}>{r.sym}</span>
        {state === 'aligned' && (
          <span style={{ fontSize:12, fontWeight:900, color:col }}>{v.dir === 'up' ? 'LONG' : 'SHORT'}</span>
        )}
        {state === 'conflict' && <span style={{ fontSize:10, fontWeight:800, color:C.warn }}>SOURCES DISAGREE</span>}
        {state === 'blocked'  && <span style={{ fontSize:10, fontWeight:800, color:'#a78bfa' }}>BLOCKED</span>}
        <span style={{ marginLeft:'auto', fontSize:9, color:C.dim }}>
          {state === 'conflict'
            ? `${v.agree} vs ${v.against}`
            : `${v.agree} of ${r.total} sources`}
        </span>
      </div>

      <SourceRows votes={r.votes} missing={r.missing}/>

      {r.vetoes.length > 0 && (
        <div style={{ marginTop:5 }}>
          {r.vetoes.map((x, i) => (
            <div key={i} style={{ fontSize:9, color:'#a78bfa', fontFamily:C.mono }}>⛔ {x}</div>
          ))}
        </div>
      )}

      {state === 'aligned' && sig && (sig.entry || sig.sl) && (
        <div style={{ display:'flex', gap:12, marginTop:6, paddingTop:6, borderTop:`1px solid ${C.line}`,
          fontFamily:C.mono, fontSize:10, flexWrap:'wrap' }}>
          {sig.entry != null && <span><span style={{color:C.dim}}>entry </span><strong style={{color:C.txt}}>{sig.entry}</strong></span>}
          {sig.sl    != null && <span><span style={{color:C.dim}}>SL </span><strong style={{color:C.bad}}>{sig.sl}</strong></span>}
          {sig.tp    != null && <span><span style={{color:C.dim}}>TP </span><strong style={{color:C.good}}>{sig.tp}</strong></span>}
          {sig.rr    != null && <span><span style={{color:C.dim}}>R:R </span><strong style={{color:C.txt}}>{sig.rr}</strong></span>}
          <span style={{ marginLeft:'auto', fontSize:8, color:'#2b3644' }}>levels from Signals</span>
        </div>
      )}

      {state === 'conflict' && (
        <div style={{ fontSize:9, color:C.warn, fontFamily:C.mono, marginTop:5, lineHeight:1.5 }}>
          {(v.upFamilies||[]).map(k => FAMILIES[k]?.label).join(' + ')} say long ·
          {' '}{(v.downFamilies||[]).map(k => FAMILIES[k]?.label).join(' + ')} say short — stand aside
        </div>
      )}
    </div>
  );
}

export default function Consensus() {
  const [res, setRes]   = useState(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const started = useRef(false);

  const run = useCallback(async () => {
    setBusy(true);
    try { setRes(await runConsensus()); }
    catch (e) { setRes({ ok:false, msg:e.message }); }
    setBusy(false);
  }, []);

  useEffect(() => { if (!started.current) { started.current = true; run(); } }, [run]);

  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:6, margin:'9px 10px', overflow:'hidden' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px',
        borderBottom:`1px solid ${C.line}`, background:'#0a0f15', flexWrap:'wrap' }}>
        <span style={{ fontSize:11, fontWeight:900, letterSpacing:'1px', color:C.accent, fontFamily:C.mono }}>
          CONSENSUS
        </span>
        <span style={{ fontSize:9, color:C.dim, fontFamily:C.mono }}>
          where the app&apos;s own engines agree
        </span>
        <span style={{ marginLeft:'auto', fontSize:9, color:C.dim, fontFamily:C.mono }}>
          {busy ? 'reading sources…'
                : res?.ok ? `${res.aligned.length} aligned · ${res.conflict.length} conflicting` : ''}
        </span>
        <button onClick={run} disabled={busy}
          style={{ fontSize:10, fontWeight:800, padding:'2px 8px', borderRadius:3, cursor:busy?'default':'pointer',
            border:`1px solid ${C.accent}44`, background:'#00d4aa15', color:C.accent }}>↻</button>
      </div>

      <div style={{ padding:'9px 10px' }}>
        {busy && !res && <div style={{ fontSize:10, color:C.dim, fontFamily:C.mono }}>asking every engine…</div>}
        {res && !res.ok && <div style={{ fontSize:10, color:C.warn, fontFamily:C.mono }}>{res.msg}</div>}

        {res?.ok && (
          <>
            {res.aligned.length === 0 && (
              <div style={{ fontSize:11, color:C.dim, fontFamily:C.mono, lineHeight:1.6, marginBottom:8 }}>
                <strong style={{ color:C.txt }}>No instrument has {res.cfg.minAgree} sources agreeing.</strong>
                <div style={{ marginTop:3 }}>
                  {res.scanned} checked. Independent methods rarely line up — when they do it means something,
                  and when they do not the honest answer is no trade.
                </div>
              </div>
            )}

            {res.aligned.map(r => <ConsensusRow key={r.sym} r={r}/>)}

            {res.blocked.length > 0 && (
              <>
                <div style={{ fontSize:9, color:'#a78bfa', fontFamily:C.mono, margin:'8px 0 4px' }}>
                  AGREED BUT BLOCKED — conditions, not the read
                </div>
                {res.blocked.map(r => <ConsensusRow key={r.sym} r={r}/>)}
              </>
            )}

            {res.conflict.length > 0 && (
              <>
                <div style={{ fontSize:9, color:C.warn, fontFamily:C.mono, margin:'8px 0 4px' }}>
                  SOURCES DISAGREE — shown because a hidden conflict is worse than a visible one
                </div>
                {res.conflict.slice(0, showAll ? 99 : 4).map(r => <ConsensusRow key={r.sym} r={r}/>)}
                {res.conflict.length > 4 && (
                  <button onClick={() => setShowAll(v => !v)}
                    style={{ fontSize:10, padding:'3px 9px', borderRadius:4, cursor:'pointer', fontFamily:C.mono,
                      border:`1px solid ${C.line}`, background:'transparent', color:C.dim }}>
                    {showAll ? '▾ fewer' : `▸ ${res.conflict.length - 4} more conflicting`}
                  </button>
                )}
              </>
            )}
          </>
        )}

        <div style={{ fontSize:8, color:'#2b3644', fontFamily:C.mono, marginTop:10, lineHeight:1.6 }}>
          No analysis of its own. Structure comes from Signals, factors from Command Center, historical win rate
          from Pair Hub, positioning from the CFTC report; spread and scheduled events can only block, never vote.
          Sources are grouped by method, so three screens reading the same moving averages count once — “{DEFAULTS.minAgree} of 4”
          means three different ways of looking, not three tabs. Agreement is not a forecast; it means nothing measured is against it.
        </div>
      </div>
    </div>
  );
}

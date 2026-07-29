import { useState, useEffect, useCallback, useRef } from 'react';
import { runTradeGate, GATE_DEFAULTS } from '../utils/tradeGate';
import { fmtScanPrice } from '../utils/marketScan';

const C = {
  panel:'#0b1118', line:'#16202b', dim:'#475569', txt:'#cbd5e1',
  accent:'#00d4aa', warn:'#f59e0b', bad:'#ef4444', good:'#22c55e', mono:'var(--mono, monospace)',
};

function PassCard({ t }) {
  const isBuy = /BUY|LONG/i.test(t.dir || '');
  const col = isBuy ? C.good : C.bad;
  return (
    <div style={{ border:`1px solid ${col}44`, background:`${col}0a`, borderRadius:6, padding:'9px 11px', marginBottom:7 }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:8, flexWrap:'wrap' }}>
        <span style={{ fontSize:13, fontWeight:900, color:C.txt }}>{t.sym}</span>
        <span style={{ fontSize:12, fontWeight:900, color:col }}>{t.dir}</span>
        <span style={{ marginLeft:'auto', fontSize:10, color:C.dim }}>{t.notes.join(' · ')}</span>
      </div>
      <div style={{ display:'flex', gap:14, marginTop:7, fontFamily:C.mono, fontSize:11, flexWrap:'wrap' }}>
        <span><span style={{ color:C.dim }}>entry </span><strong style={{ color:C.txt }}>{fmtScanPrice(t.entry, t.pip)}</strong></span>
        <span><span style={{ color:C.dim }}>SL </span><strong style={{ color:C.bad }}>{fmtScanPrice(t.sl, t.pip)}</strong></span>
        <span><span style={{ color:C.dim }}>TP </span><strong style={{ color:C.good }}>{fmtScanPrice(t.tp1, t.pip)}</strong></span>
        <span><span style={{ color:C.dim }}>R:R </span><strong style={{ color:C.txt }}>{t.rr}:1</strong></span>
      </div>
      {t.reasons?.length > 0 && (
        <div style={{ fontSize:9, color:'#475569', marginTop:6, lineHeight:1.5 }}>
          {t.reasons.slice(0, 4).join(' · ')}
        </div>
      )}
    </div>
  );
}

export default function TradeGate() {
  const [res, setRes]   = useState(null);
  const [busy, setBusy] = useState(false);
  const [showRej, setShowRej] = useState(false);
  const started = useRef(false);

  const run = useCallback(async () => {
    setBusy(true);
    try { setRes(await runTradeGate()); }
    catch (e) { setRes({ ok:false, msg:e.message }); }
    setBusy(false);
  }, []);

  useEffect(() => { if (!started.current) { started.current = true; run(); } }, [run]);

  const cfg = res?.cfg || GATE_DEFAULTS;

  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:6, margin:'9px 10px', overflow:'hidden' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px',
        borderBottom:`1px solid ${C.line}`, background:'#0a0f15', flexWrap:'wrap' }}>
        <span style={{ fontSize:11, fontWeight:900, letterSpacing:'1px', color:C.accent, fontFamily:C.mono }}>
          TRADES THAT PASS
        </span>
        <span style={{ fontSize:9, color:C.dim, fontFamily:C.mono }}>
          every check the app can make
        </span>
        <span style={{ marginLeft:'auto', fontSize:9, color:C.dim, fontFamily:C.mono }}>
          {busy ? 'checking…' : res?.ok ? `${res.passed.length}/${res.total} passed` : ''}
        </span>
        <button onClick={run} disabled={busy}
          style={{ fontSize:10, fontWeight:800, padding:'2px 8px', borderRadius:3, cursor:busy?'default':'pointer',
            border:`1px solid ${C.accent}44`, background:'#00d4aa15', color:C.accent }}>↻</button>
      </div>

      <div style={{ padding:'9px 10px' }}>
        {busy && !res && <div style={{ fontSize:10, color:C.dim, fontFamily:C.mono }}>scanning and gating…</div>}
        {res && !res.ok && <div style={{ fontSize:10, color:C.warn, fontFamily:C.mono }}>{res.msg}</div>}

        {res?.ok && res.passed.length === 0 && (
          <div style={{ fontSize:11, color:C.dim, fontFamily:C.mono, lineHeight:1.6 }}>
            <strong style={{ color:C.txt }}>Nothing passes right now.</strong>
            <div style={{ marginTop:4 }}>
              {res.total} setups were found and every one failed at least one check. That is the normal
              result — a gate that passes something every time is not a gate. Standing aside costs nothing.
            </div>
          </div>
        )}

        {res?.ok && res.passed.map((t, i) => <PassCard key={i} t={t}/>)}

        {res?.ok && res.rejected.length > 0 && (
          <>
            <button onClick={() => setShowRej(v => !v)}
              style={{ fontSize:10, fontWeight:700, marginTop:res.passed.length?8:2, padding:'3px 9px', borderRadius:4,
                cursor:'pointer', border:`1px solid ${C.line}`, background:'transparent', color:C.dim, fontFamily:C.mono }}>
              {showRej ? '▾' : '▸'} {res.rejected.length} rejected — see why
            </button>
            {showRej && (
              <div style={{ marginTop:7 }}>
                {res.rejected.map((t, i) => (
                  <div key={i} style={{ padding:'5px 0', borderBottom:'1px solid #0e161e', fontFamily:C.mono }}>
                    <div style={{ display:'flex', gap:7, alignItems:'baseline' }}>
                      <span style={{ fontSize:10, fontWeight:800, color:'#64748b' }}>{t.sym}</span>
                      <span style={{ fontSize:9, color:'#475569' }}>{t.dir}</span>
                      <span style={{ fontSize:9, color:'#334155', marginLeft:'auto' }}>{t.score}/100</span>
                    </div>
                    {t.blockers.map((b, j) => (
                      <div key={j} style={{ fontSize:9, color:'#7f5539', marginTop:2 }}>✕ {b}</div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div style={{ fontSize:8, color:'#2b3644', fontFamily:C.mono, marginTop:9, lineHeight:1.6 }}>
          Direction comes from the existing confluence scanner. This only decides whether to allow it:
          confluence ≥{cfg.minConfluence}/100, R:R ≥{cfg.minRR}:1, spread under ×{cfg.maxSpreadRatio} of its own
          normal, and no high-impact event inside {cfg.eventBlackoutMin} minutes. Passing means nothing the app
          measures is against it — not that the trade will win.
        </div>
      </div>
    </div>
  );
}

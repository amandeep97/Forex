import { useState, useEffect, useCallback, useRef } from 'react';
import { runMtfScan, MTF_DEFAULTS, MTF, ENTRY_TF } from '../utils/mtfTrades';

const C = {
  panel:'#0b1118', line:'#16202b', dim:'#475569', txt:'#cbd5e1',
  accent:'#00d4aa', warn:'#f59e0b', bad:'#ef4444', good:'#22c55e', mono:'var(--mono, monospace)',
};

// The timeframe ladder — the point of the card. Green up, red down, grey means
// that timeframe's trend and structure disagree and it is deliberately not
// forced onto a side.
function Ladder({ ladder, dir }) {
  return (
    <div style={{ display:'flex', gap:4, alignItems:'center' }}>
      {MTF.map(tf => {
        const b = ladder[tf] || {};
        const col = b.dir === 'up' ? C.good : b.dir === 'down' ? C.bad : '#334155';
        const glyph = b.dir === 'up' ? '▲' : b.dir === 'down' ? '▼' : '—';
        return (
          <span key={tf} title={b.why || ''}
            style={{ fontSize:9, fontFamily:C.mono, color:col, border:`1px solid ${col}44`,
              borderRadius:3, padding:'1px 5px', fontWeight:800 }}>
            {tf} {glyph}
          </span>
        );
      })}
      <span style={{ fontSize:9, fontFamily:C.mono, color:C.accent, border:`1px solid ${C.accent}44`,
        borderRadius:3, padding:'1px 5px', fontWeight:800 }}>
        {ENTRY_TF} {dir === 'BUY' ? '🔨' : '⭐'}
      </span>
    </div>
  );
}

function PassCard({ t, dec }) {
  const isBuy = t.dir === 'BUY';
  const col = isBuy ? C.good : C.bad;
  const f = v => v?.toFixed(dec ?? 4);
  return (
    <div style={{ border:`1px solid ${col}44`, background:`${col}0a`, borderRadius:6, padding:'9px 11px', marginBottom:7 }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:8, flexWrap:'wrap' }}>
        <span style={{ fontSize:13, fontWeight:900, color:C.txt }}>{t.sym}</span>
        <span style={{ fontSize:12, fontWeight:900, color:col }}>{t.dir}</span>
        <span style={{ fontSize:9, color: t.withTrend ? C.good : C.warn, fontFamily:C.mono }}>
          {t.withTrend ? 'with trend' : `counter-trend from ${t.location?.zone}`}
        </span>
        <span style={{ marginLeft:'auto', fontSize:9, color:C.dim, fontFamily:C.mono }}>
          {t.aligned}/3 aligned
        </span>
      </div>

      <div style={{ marginTop:6 }}><Ladder ladder={t.ladder} dir={t.dir}/></div>

      <div style={{ display:'flex', gap:14, marginTop:7, fontFamily:C.mono, fontSize:11, flexWrap:'wrap' }}>
        <span><span style={{ color:C.dim }}>entry </span><strong style={{ color:C.txt }}>{f(t.entry)}</strong></span>
        <span><span style={{ color:C.dim }}>SL </span><strong style={{ color:C.bad }}>{f(t.sl)}</strong></span>
        <span><span style={{ color:C.dim }}>TP </span><strong style={{ color:C.good }}>{f(t.tp)}</strong></span>
        <span><span style={{ color:C.dim }}>R:R </span><strong style={{ color:C.txt }}>{t.rr}:1</strong></span>
      </div>
      <div style={{ fontSize:9, color:'#475569', marginTop:5, lineHeight:1.5 }}>
        Trigger: {ENTRY_TF} strong {t.trigger === 'hammer' ? 'hammer — swept the low and closed back up' : 'shooting star — swept the high and closed back down'}.
        Stop sits beyond that candle, so risk is set by where the market actually turned.
      </div>
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
    try { setRes(await runMtfScan()); }
    catch (e) { setRes({ ok:false, msg:e.message }); }
    setBusy(false);
  }, []);

  useEffect(() => { if (!started.current) { started.current = true; run(); } }, [run]);

  const cfg = res?.cfg || MTF_DEFAULTS;

  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:6, margin:'9px 10px', overflow:'hidden' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px',
        borderBottom:`1px solid ${C.line}`, background:'#0a0f15', flexWrap:'wrap' }}>
        <span style={{ fontSize:11, fontWeight:900, letterSpacing:'1px', color:C.accent, fontFamily:C.mono }}>
          MTF TRADES
        </span>
        <span style={{ fontSize:9, color:C.dim, fontFamily:C.mono }}>
          higher timeframes filter · entry timeframe triggers
        </span>
        <span style={{ marginLeft:'auto', fontSize:9, color:C.dim, fontFamily:C.mono }}>
          {busy ? 'scanning…' : res?.ok ? `${res.passed.length} of ${res.triggered} triggered` : ''}
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
              {res.scanned} instruments scanned, {res.triggered} had a {ENTRY_TF} trigger, none cleared every
              check. That is the normal result — a gate that passes something every time is not a gate.
            </div>
          </div>
        )}

        {res?.ok && res.passed.map((t, i) => <PassCard key={i} t={t} dec={t.inst?.dec}/>)}

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
                      <span style={{ fontSize:9, color:'#334155', marginLeft:'auto' }}>{t.aligned}/3 aligned</span>
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
          Higher timeframes ({MTF.join(' → ')}) decide which side is permitted; the reason to enter is a strong
          sweep on {ENTRY_TF}. No trigger, no trade — however aligned the trend looks. Requires ≥{cfg.minAligned}/3
          timeframes agreeing, spread under ×{cfg.maxSpreadRatio} of normal, and no high-impact event inside
          {cfg.eventBlackoutMin} minutes. Counter-trend is allowed only from the opposite extreme of the range.
          Passing means nothing measured is against it — not that the trade will win.
        </div>
      </div>
    </div>
  );
}

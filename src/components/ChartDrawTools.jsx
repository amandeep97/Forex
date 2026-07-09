'use strict';
import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { loadAlerts, saveAlerts } from '../hooks/useAlertsEngine';

// ── Pan-aware slicing (shared by SVGChart + this overlay so they stay aligned) ─
// panOffset = how many candles back from the newest the RIGHT edge of the view sits.
// 0 = latest. Clamped so the window never goes narrower than barCount or past the ends.
export function sliceVisible(candles, barCount, panOffset = 0) {
  const n = candles.length;
  const count = Math.max(1, Math.min(barCount || 100, n));
  const rightEdge = Math.max(count, Math.min(n, n - panOffset));
  return candles.slice(rightEdge - count, rightEdge);
}
export function maxPanOffset(candles, barCount) {
  const n = candles.length;
  const count = Math.max(1, Math.min(barCount || 100, n));
  return Math.max(0, n - count);
}

// ── Geometry (mirrors SVGChart exactly) ───────────────────────────────────────
export function chartGeom(candles, barCount, chartH, volOn, panOffset = 0) {
  const W = 900, H = Math.max(240, chartH || 460);
  const VOL_H = volOn ? 60 : 0;
  const PL = 8, PR = 68, PT = 22, PB = 28 + VOL_H;
  const pw = W - PL - PR, ph = H - PT - PB;
  const vis = sliceVisible(candles, barCount, panOffset);
  const nv = vis.length;
  const minP = Math.min(...vis.map(c => c.l)), maxP = Math.max(...vis.map(c => c.h));
  const pad = (maxP - minP) * 0.06 || 1;
  const pMin = minP - pad, pMax = maxP + pad;
  const xOf = i => PL + (i / (nv - 1 || 1)) * pw;
  const yOf = p => PT + ph - ((p - pMin) / (pMax - pMin || 1)) * ph;
  return { W, H, PL, PR, PT, PB, pw, ph, vis, nv, pMin, pMax, xOf, yOf };
}

function tToIdx(vis, nv, t) {
  if (nv < 2) return 0;
  if (t <= vis[0].t)      { const sp = (vis[1].t - vis[0].t) || 1; return (t - vis[0].t) / sp; }
  if (t >= vis[nv-1].t)   { const sp = (vis[nv-1].t - vis[nv-2].t) || 1; return (nv-1) + (t - vis[nv-1].t) / sp; }
  for (let i = 0; i < nv - 1; i++) if (t >= vis[i].t && t <= vis[i+1].t) return i + (t - vis[i].t) / ((vis[i+1].t - vis[i].t) || 1);
  return nv - 1;
}
function idxToT(vis, nv, i) {
  if (nv < 2) return vis[0]?.t || 0;
  if (i <= 0)     { const sp = (vis[1].t - vis[0].t) || 1; return vis[0].t + i * sp; }
  if (i >= nv-1)  { const sp = (vis[nv-1].t - vis[nv-2].t) || 1; return vis[nv-1].t + (i - (nv-1)) * sp; }
  const k = Math.floor(i), f = i - k; return vis[k].t + f * ((vis[k+1].t - vis[k].t) || 0);
}

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

const TOOLS = [
  { id:'cursor', icon:'⤢', label:'Select / move' },
  { id:'trend',  icon:'╱', label:'Trendline' },
  { id:'ray',    icon:'➹', label:'Ray (extends right)' },
  { id:'hline',  icon:'━', label:'Horizontal line' },
  { id:'vline',  icon:'│', label:'Vertical line' },
  { id:'rect',   icon:'▭', label:'Rectangle / zone' },
  { id:'fib',    icon:'☰', label:'Fib retracement' },
  { id:'text',   icon:'T', label:'Text note' },
];
const TWO_POINT = ['trend','ray','rect','fib'];
const COLORS = { trend:'#38bdf8', ray:'#38bdf8', hline:'#f59e0b', vline:'#94a3b8', rect:'#22c55e', fib:'#a855f7', text:'#e2e8f0' };

function drawKey(symbol, tf) { return `chart_draw_${symbol}_${tf}`; }
function loadDrawings(symbol, tf) { try { return JSON.parse(localStorage.getItem(drawKey(symbol, tf)) || '[]'); } catch { return []; } }
function saveDrawings(symbol, tf, d) { localStorage.setItem(drawKey(symbol, tf), JSON.stringify(d)); }

// ── Drawing overlay ───────────────────────────────────────────────────────────
export default function ChartDrawTools({ candles, symbol, tf, ov, barCount, chartH, panOffset = 0, onPan, maxOffset = 0 }) {
  const g = useMemo(() => chartGeom(candles, barCount, chartH, !!ov.vol, panOffset), [candles, barCount, chartH, ov.vol, panOffset]);
  const svgRef = useRef(null);
  const [tool, setTool]       = useState('cursor');
  const [drawings, setDraw]   = useState(() => loadDrawings(symbol, tf));
  const [pendA, setPendA]     = useState(null);   // first anchor {t,p}
  const [hover, setHover]     = useState(null);    // live cursor {t,p}
  const [selId, setSel]       = useState(null);
  const [toast, setToast]     = useState('');
  const [crosshair, setCrosshair] = useState(null); // {idx, sx, sy} — TV-style tap-to-inspect
  const dragRef    = useRef(null); // active pan/tap gesture: {startSx, startOffset, moved}
  const lastTapRef = useRef({ time: 0, sx: 0, sy: 0 }); // for double-tap-to-reset-pan

  // reload when symbol/tf change
  const keyRef = useRef(`${symbol}_${tf}`);
  if (keyRef.current !== `${symbol}_${tf}`) { keyRef.current = `${symbol}_${tf}`; }

  const persist = useCallback((next) => { setDraw(next); saveDrawings(symbol, tf, next); }, [symbol, tf]);

  // Toolbar pan buttons (or anything else) changing panOffset externally should
  // drop a stale crosshair reading rather than show it against a shifted window.
  useEffect(() => { setCrosshair(null); }, [panOffset]);

  // coordinate conversion
  const xOfT = (t) => g.xOf(tToIdx(g.vis, g.nv, t));
  const yOfP = (p) => g.yOf(p);
  const ptFromEvent = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const cx = (e.touches?.[0]?.clientX ?? e.clientX);
    const cy = (e.touches?.[0]?.clientY ?? e.clientY);
    const sx = (cx - r.left) / r.width * g.W;
    const sy = (cy - r.top)  / r.height * g.H;
    const idx = (sx - g.PL) / g.pw * (g.nv - 1);
    const t = idxToT(g.vis, g.nv, idx);
    const p = g.pMin + (g.PT + g.ph - sy) / g.ph * (g.pMax - g.pMin);
    return { t, p, sx, sy };
  };

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 1800); };

  const create = (a, b) => {
    const id = `d_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
    let d = null;
    if (tool === 'hline') d = { id, type:'hline', p:a.p, color:COLORS.hline };
    else if (tool === 'vline') d = { id, type:'vline', t:a.t, color:COLORS.vline };
    else if (tool === 'text') { const txt = prompt('Note text:'); if (!txt) return; d = { id, type:'text', t:a.t, p:a.p, text:txt, color:COLORS.text }; }
    else if (TWO_POINT.includes(tool) && b) d = { id, type:tool, a, b, color:COLORS[tool] };
    if (!d) return;
    persist([...drawings, d]);
    setPendA(null); setHover(null); setTool('cursor');
  };

  const hitTest = (pt) => {
    // returns id of nearest drawing within threshold
    const TH = 11;
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (d.type === 'hline') { if (Math.abs(pt.sy - yOfP(d.p)) < TH) return d.id; }
      else if (d.type === 'vline') { if (Math.abs(pt.sx - xOfT(d.t)) < TH) return d.id; }
      else if (d.type === 'text') { if (Math.abs(pt.sx - xOfT(d.t)) < 30 && Math.abs(pt.sy - yOfP(d.p)) < 14) return d.id; }
      else if (d.type === 'rect') {
        const x1=xOfT(d.a.t),y1=yOfP(d.a.p),x2=xOfT(d.b.t),y2=yOfP(d.b.p);
        const inX = pt.sx >= Math.min(x1,x2)-TH && pt.sx <= Math.max(x1,x2)+TH;
        const inY = pt.sy >= Math.min(y1,y2)-TH && pt.sy <= Math.max(y1,y2)+TH;
        if (inX && inY) return d.id;
      } else { // trend / ray / fib → distance to segment
        const x1=xOfT(d.a.t),y1=yOfP(d.a.p); let x2=xOfT(d.b.t),y2=yOfP(d.b.p);
        if (d.type==='ray') { const dx=x2-x1,dy=y2-y1; const k=(g.W-x1)/(dx||1e-6); x2=g.W; y2=y1+dy*k; }
        if (distToSeg(pt.sx,pt.sy,x1,y1,x2,y2) < TH) return d.id;
      }
    }
    return null;
  };

  const idxFromSx = (sx) => Math.max(0, Math.min(g.nv - 1, Math.round((sx - g.PL) / g.pw * (g.nv - 1))));

  const onDown = (e) => {
    e.preventDefault();
    const pt = ptFromEvent(e);
    if (tool === 'cursor') {
      const hitId = hitTest(pt);
      if (hitId) { setSel(hitId); setCrosshair(null); dragRef.current = null; return; }
      setSel(null);
      // double-tap on empty space → jump back to the latest candle
      const now = Date.now();
      const lt = lastTapRef.current;
      if (now - lt.time < 350 && Math.abs(pt.sx - lt.sx) < 20 && Math.abs(pt.sy - lt.sy) < 20) {
        onPan?.(0); setCrosshair(null); dragRef.current = null;
        lastTapRef.current = { time: 0, sx: 0, sy: 0 };
        return;
      }
      try { e.target.setPointerCapture?.(e.pointerId); } catch {}
      dragRef.current = { startSx: pt.sx, startOffset: panOffset, moved: false };
      setCrosshair({ idx: idxFromSx(pt.sx), sx: pt.sx, sy: pt.sy });
      return;
    }
    if (TWO_POINT.includes(tool)) {
      if (!pendA) { setPendA(pt); setHover(pt); }
      else create(pendA, pt);
    } else create(pt);
  };

  const onMovePreview = (e) => {
    if (pendA) { setHover(ptFromEvent(e)); return; }
    if (tool === 'cursor' && dragRef.current) {
      const pt = ptFromEvent(e);
      const dx = pt.sx - dragRef.current.startSx;
      if (Math.abs(dx) > 6) {
        dragRef.current.moved = true;
        const pxPerCandle = g.pw / (g.vis.length || 1);
        const deltaCandles = Math.round(dx / pxPerCandle);
        const newOffset = Math.max(0, Math.min(maxOffset, dragRef.current.startOffset + deltaCandles));
        onPan?.(newOffset);
        setCrosshair(null);
      } else {
        setCrosshair({ idx: idxFromSx(pt.sx), sx: pt.sx, sy: pt.sy });
      }
    }
  };

  const onUp = (e) => {
    if (tool === 'cursor' && dragRef.current) {
      const pt = ptFromEvent(e);
      lastTapRef.current = { time: Date.now(), sx: pt.sx, sy: pt.sy };
      dragRef.current = null;
    }
  };

  const delSel = () => { if (!selId) return; persist(drawings.filter(d => d.id !== selId)); setSel(null); };
  const clearAll = () => { if (drawings.length && confirm('Clear all drawings on this chart?')) persist([]); setSel(null); };

  // ── Create an alert from the selected drawing ──
  const alertFromSel = () => {
    const d = drawings.find(x => x.id === selId);
    if (!d) return;
    const base = { id:`al_${Date.now()}_${Math.random().toString(36).slice(2,5)}`, sym:symbol, enabled:true, repeat:false, createdAt:Date.now(), lastTriggered:null };
    let a = null;
    if (d.type === 'hline') a = { ...base, type:'price', dir:'cross', level:round(d.p) };
    else if (d.type === 'rect') a = { ...base, type:'zone', top:round(Math.max(d.a.p,d.b.p)), bottom:round(Math.min(d.a.p,d.b.p)) };
    else if (d.type === 'trend' || d.type === 'ray') a = { ...base, type:'trendline', t1:d.a.t, p1:d.a.p, t2:d.b.t, p2:d.b.p };
    else { flash('No alert for this drawing type'); return; }
    saveAlerts([a, ...loadAlerts()]);
    flash(`🔔 Alert set on ${symbol} from your ${d.type === 'hline' ? 'line' : d.type === 'rect' ? 'zone' : 'trendline'}`);
  };

  // ── Render a single drawing ──
  const renderDrawing = (d, preview = false) => {
    const sel = d.id === selId;
    const sw = sel ? 2.4 : 1.6;
    const op = preview ? 0.6 : 1;
    if (d.type === 'hline') {
      const y = yOfP(d.p);
      return <g key={d.id} opacity={op}>
        <line x1={g.PL} y1={y} x2={g.W-g.PR} y2={y} stroke={d.color} strokeWidth={sw} strokeDasharray={sel?'':'4,3'}/>
        <rect x={g.W-g.PR} y={y-7} width={g.PR} height={14} fill={d.color}/>
        <text x={g.W-g.PR+4} y={y+4} fontSize={9} fill="#06121f" fontWeight="700">{fmt(d.p)}</text>
      </g>;
    }
    if (d.type === 'vline') { const x = xOfT(d.t); return <line key={d.id} opacity={op} x1={x} y1={g.PT} x2={x} y2={g.PT+g.ph} stroke={d.color} strokeWidth={sw} strokeDasharray="4,3"/>; }
    if (d.type === 'text') { const x=xOfT(d.t),y=yOfP(d.p); return <text key={d.id} opacity={op} x={x} y={y} fontSize={12} fill={d.color} fontWeight="700" style={{ paintOrder:'stroke' }} stroke="#06121f" strokeWidth={0.6}>{d.text}{sel?' ◂':''}</text>; }
    if (d.type === 'rect') {
      const x1=xOfT(d.a.t),y1=yOfP(d.a.p),x2=xOfT(d.b.t),y2=yOfP(d.b.p);
      return <rect key={d.id} opacity={op} x={Math.min(x1,x2)} y={Math.min(y1,y2)} width={Math.abs(x2-x1)} height={Math.abs(y2-y1)}
        fill={d.color+'1f'} stroke={d.color} strokeWidth={sel?2:1.2}/>;
    }
    if (d.type === 'fib') {
      const x1=xOfT(d.a.t),x2=xOfT(d.b.t);
      return <g key={d.id} opacity={op}>
        {FIB.map(r => { const price = d.a.p + (d.b.p - d.a.p) * r; const y = yOfP(price); return (
          <g key={r}>
            <line x1={Math.min(x1,x2)} y1={y} x2={g.W-g.PR} y2={y} stroke={d.color} strokeWidth={r===0.618?1.4:0.8} strokeDasharray="3,3" opacity={0.8}/>
            <text x={Math.min(x1,x2)+2} y={y-2} fontSize={8} fill={d.color}>{r} · {fmt(price)}</text>
          </g>); })}
      </g>;
    }
    // trend / ray
    const x1=xOfT(d.a.t),y1=yOfP(d.a.p); let x2=xOfT(d.b.t),y2=yOfP(d.b.p);
    if (d.type==='ray') { const dx=x2-x1,dy=y2-y1; const k=(g.W-g.PR-x1)/(dx||1e-6); x2=g.W-g.PR; y2=y1+dy*k; }
    return <g key={d.id} opacity={op}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={d.color} strokeWidth={sw}/>
      {sel && <><circle cx={x1} cy={y1} r={3.5} fill={d.color}/><circle cx={x2} cy={y2} r={3.5} fill={d.color}/></>}
    </g>;
  };

  function fmt(v) { const s=symbol||''; if (s.startsWith('XAU')) return v.toFixed(2); if (/^(US|GER|JPN|NAS|SPX)/.test(s)) return v.toFixed(1); if (s.includes('JPY')) return v.toFixed(3); if (s.includes('BTC')||s.includes('ETH')) return v.toFixed(1); return v.toFixed(5); }
  function round(v) { return parseFloat(fmt(v)); }

  const previewDraw = pendA && hover && TWO_POINT.includes(tool)
    ? { id:'__preview', type:tool, a:pendA, b:hover, color:COLORS[tool] } : null;

  return (
    <>
      {/* Tool palette */}
      <div style={{ position:'absolute', top:8, left:8, display:'flex', flexDirection:'column', gap:3, zIndex:6 }}>
        {TOOLS.map(t => (
          <button key={t.id} title={t.label} onClick={()=>{ setTool(t.id); setPendA(null); setSel(null); setCrosshair(null); }}
            style={{ width:28, height:28, borderRadius:7, cursor:'pointer', fontSize:13, fontWeight:700, lineHeight:1,
              background: tool===t.id ? '#00d4aa22' : 'rgba(13,19,33,0.85)', color: tool===t.id ? '#00d4aa' : '#94a3b8',
              border:`1px solid ${tool===t.id ? '#00d4aa66' : '#1e293b'}` }}>{t.icon}</button>
        ))}
        <button title="Clear all" onClick={clearAll}
          style={{ width:28, height:28, borderRadius:7, cursor:'pointer', fontSize:12, background:'rgba(13,19,33,0.85)',
            color:'#ef4444', border:'1px solid #1e293b', marginTop:4 }}>🗑</button>
      </div>

      {/* Selected-drawing action bar */}
      {selId && (
        <div style={{ position:'absolute', top:8, right:8, display:'flex', gap:6, zIndex:6 }}>
          <button onClick={alertFromSel} style={actBtn('#00d4aa')}>🔔 Set alert</button>
          <button onClick={delSel} style={actBtn('#ef4444')}>🗑 Delete</button>
        </div>
      )}

      {pendA && (
        <div style={{ position:'absolute', bottom:8, left:'50%', transform:'translateX(-50%)', zIndex:6,
          fontSize:10, color:'#00d4aa', background:'rgba(6,18,31,0.9)', padding:'4px 10px', borderRadius:10, border:'1px solid #00d4aa44' }}>
          Tap the second point…
        </div>
      )}
      {toast && (
        <div style={{ position:'absolute', bottom:8, left:'50%', transform:'translateX(-50%)', zIndex:7,
          fontSize:11, color:'#06121f', background:'#00d4aa', padding:'5px 12px', borderRadius:10, fontWeight:700 }}>{toast}</div>
      )}

      {/* Crosshair OHLC readout — tap empty space to inspect, drag to pan, double-tap to reset */}
      {crosshair && g.vis[crosshair.idx] && !selId && (() => {
        const c = g.vis[crosshair.idx];
        const bull = c.c >= c.o;
        const timeStr = new Date(c.t).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        return (
          <div style={{ position:'absolute', top:8, right:8, zIndex:6, background:'rgba(6,18,31,0.94)',
            border:'1px solid #33415566', borderRadius:8, padding:'6px 10px', fontSize:10, color:'#e2e8f0',
            fontFamily:'monospace', lineHeight:1.6, pointerEvents:'none' }}>
            <div style={{ color:'#64748b', marginBottom:2 }}>{timeStr}</div>
            <div>O <strong style={{color:'#e2e8f0'}}>{fmt(c.o)}</strong>&nbsp;&nbsp;H <strong style={{color:'#22c55e'}}>{fmt(c.h)}</strong></div>
            <div>L <strong style={{color:'#ef4444'}}>{fmt(c.l)}</strong>&nbsp;&nbsp;C <strong style={{color:bull?'#22c55e':'#ef4444'}}>{fmt(c.c)}</strong></div>
          </div>
        );
      })()}

      {panOffset > 0 && (
        <button onClick={() => onPan?.(0)} style={{ position:'absolute', bottom:8, right:8, zIndex:6,
          fontSize:9.5, fontWeight:700, padding:'4px 10px', borderRadius:10, cursor:'pointer',
          background:'#f59e0b18', color:'#f59e0b', border:'1px solid #f59e0b44' }}>
          📍 Viewing history · tap to return to live
        </button>
      )}

      <svg ref={svgRef} viewBox={`0 0 ${g.W} ${g.H}`} preserveAspectRatio="none"
        onPointerDown={onDown} onPointerMove={onMovePreview}
        onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onUp}
        style={{ position:'absolute', inset:0, width:'100%', height:'100%', zIndex:5,
          cursor: tool==='cursor' ? 'default' : 'crosshair', touchAction:'none' }}>
        {drawings.map(d => renderDrawing(d))}
        {previewDraw && renderDrawing(previewDraw, true)}
        {pendA && <circle cx={xOfT(pendA.t)} cy={yOfP(pendA.p)} r={4} fill={COLORS[tool]||'#00d4aa'}/>}
        {crosshair && g.vis[crosshair.idx] && (() => {
          const cx = g.xOf(crosshair.idx), cy = crosshair.sy;
          const priceAtCursor = g.pMin + (g.PT + g.ph - cy) / g.ph * (g.pMax - g.pMin);
          return (
            <g>
              <line x1={cx} y1={g.PT} x2={cx} y2={g.PT+g.ph} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3,3" opacity={0.6}/>
              <line x1={g.PL} y1={cy} x2={g.W-g.PR} y2={cy} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3,3" opacity={0.6}/>
              <rect x={g.W-g.PR} y={cy-8} width={g.PR} height={16} fill="#94a3b8"/>
              <text x={g.W-g.PR+4} y={cy+4} fontSize={9} fill="#06121f" fontWeight="700">{fmt(priceAtCursor)}</text>
            </g>
          );
        })()}
      </svg>
    </>
  );
}

function actBtn(c) {
  return { fontSize:10, fontWeight:700, padding:'5px 9px', borderRadius:7, cursor:'pointer',
    background:'rgba(6,18,31,0.92)', color:c, border:`1px solid ${c}66` };
}
function distToSeg(px,py,x1,y1,x2,y2) {
  const dx=x2-x1, dy=y2-y1; const l2=dx*dx+dy*dy;
  if (l2===0) return Math.hypot(px-x1,py-y1);
  let t=((px-x1)*dx+(py-y1)*dy)/l2; t=Math.max(0,Math.min(1,t));
  return Math.hypot(px-(x1+t*dx), py-(y1+t*dy));
}

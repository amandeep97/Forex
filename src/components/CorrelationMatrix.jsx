import { useState, useEffect, useCallback } from 'react';
import { pearson as sharedPearson } from '../utils/mathUtils';
import { INSTRUMENTS as REGISTRY } from '../data/instruments';

// Derived from the canonical registry rather than typed out again. This was a
// fourth hand-maintained instrument list, and it had drifted: Brent was here
// and WTI was not, so the oil row showed one contract when the app trades two —
// and UK100, GER40, JPN225 and NATGAS were missing outright.
//
// US10Y is not a tradeable instrument in the registry but belongs on a
// correlation grid, so it is added explicitly as the one genuine extra.
const SHORT_LABEL = {
  'USOIL':'Oil(WTI)', 'UKOIL':'Oil(BCO)', 'NATGAS':'NatGas',
  'US500':'SPX', 'US100':'NQ', 'US30':'DJI', 'US2000':'RUT',
  'UK100':'FTSE', 'GER40':'DAX', 'JPN225':'NKY',
};
const COLOR_BY_CLASS = { fx:'#3b82f6', metal:'#fbbf24', energy:'#fb923c', index:'#22c55e', crypto:'#f59e0b' };

// The grid is unreadable past roughly this many rows on a phone, so FX is
// limited to the majors and crosses people actually watch together.
const FX_SHOWN = new Set(['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD','NZD/USD',
                          'EUR/JPY','GBP/JPY','AUD/JPY','EUR/GBP']);

const INSTRUMENTS = [
  ...REGISTRY
    .filter(i => i.oanda && (i.cls !== 'fx' || FX_SHOWN.has(i.sym)))
    .map(i => ({
      key: i.oanda,
      label: SHORT_LABEL[i.sym] || i.sym,
      color: COLOR_BY_CLASS[i.cls] || '#94a3b8',
      cls: i.cls,
    })),
  { key:'USB10Y_USD', label:'US10Y', color:'#818cf8', cls:'rate' },
];

const TF_OPTIONS = ['M15', 'H1', 'H4', 'D'];
const LB_OPTIONS = [
  { v: 20,  l: '20 bars' },
  { v: 50,  l: '50 bars' },
  { v: 100, l: '100 bars' },
];

function getOandaCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) { const _e = localStorage.getItem('oanda_env'); return _e !== null ? { ...c, practice: _e !== 'live' } : c; }
  } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}

async function fetchCloses(instrument, granularity, count) {
  const creds = getOandaCreds();
  if (!creds) return null;
  const base = creds.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  try {
    const res = await fetch(
      `${base}/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.candles || []).filter(c => c.complete).map(c => +c.mid.c);
  } catch { return null; }
}

// pearson moved to utils/mathUtils; minimum-sample guard (5) preserved
const pearson = (a, b) => sharedPearson(a, b, 5);

// Map r value → background colour (red→white→green)
function rToColor(r) {
  if (r === null) return '#1e293b';
  if (r === 1)   return '#166534';
  const abs = Math.abs(r);
  const intensity = abs; // 0–1
  if (r > 0) {
    const g = Math.round(50 + intensity * 150);
    const rb = Math.round(20 + (1 - intensity) * 40);
    return `rgb(${rb},${g},${rb})`;
  } else {
    const red = Math.round(80 + intensity * 150);
    const gb  = Math.round(20 + (1 - intensity) * 40);
    return `rgb(${red},${gb},${gb})`;
  }
}

function rToTextColor(r) {
  if (r === null) return '#475569';
  return Math.abs(r) > 0.4 ? '#fff' : '#94a3b8';
}

export default function CorrelationMatrix() {
  const [tf, setTf]       = useState('H1');
  const [lb, setLb]       = useState(50);
  const [closes, setCloses] = useState({});
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [selected, setSelected] = useState(null); // { row, col } for highlight
  const [filter, setFilter] = useState(0.7); // show only |r| >= filter (0 = show all)
  // Reading one instrument's relationships off a 24x24 grid means scanning a
  // row and a column and holding both in your head. Tapping its name gives the
  // same information as a sorted list, which is how the question is actually
  // asked: "what does gold move with?"
  const [focus, setFocus] = useState(null);

  const hasOanda = !!getOandaCreds();

  const load = useCallback(async () => {
    if (!getOandaCreds()) return;
    setLoading(true);
    const count = lb + 5;
    const results = await Promise.all(
      INSTRUMENTS.map(async ins => {
        const c = await fetchCloses(ins.key, tf, count);
        return { key: ins.key, closes: c };
      })
    );
    const map = {};
    results.forEach(r => { if (r.closes) map[r.key] = r.closes; });
    setCloses(map);
    setLoading(false);
    setLastRefresh(new Date());
  }, [tf, lb]);

  useEffect(() => { if (hasOanda) load(); }, [load, hasOanda]);

  // Build correlation matrix (only for instruments we have data for)
  const available = INSTRUMENTS.filter(ins => closes[ins.key]);
  const matrix = {};
  for (const a of available) {
    matrix[a.key] = {};
    for (const b of available) {
      if (a.key === b.key) { matrix[a.key][b.key] = 1; continue; }
      matrix[a.key][b.key] = pearson(closes[a.key], closes[b.key]);
    }
  }

  // Strong pairs list (sorted by |r|, filtered)
  const strongPairs = [];
  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const r = matrix[available[i].key]?.[available[j].key];
      if (r != null && Math.abs(r) >= filter) {
        strongPairs.push({ a: available[i], b: available[j], r });
      }
    }
  }
  strongPairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  const fmtR = r => r === null ? '—' : r === 1 ? '1.00' : r.toFixed(2);

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* Header */}
      <div style={{ padding:'10px 16px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10, flexShrink:0, flexWrap:'wrap' }}>
        <div>
          <span style={{ fontSize:14, fontWeight:700, color:'var(--text)' }}>⬡ Correlation Matrix</span>
          <span style={{ fontSize:10, color:'var(--text3)', marginLeft:8 }}>Live Pearson r — all major pairs</span>
        </div>

        {/* Controls */}
        <div style={{ display:'flex', gap:6, marginLeft:'auto', flexWrap:'wrap', alignItems:'center' }}>
          {/* Timeframe */}
          <div style={{ display:'flex', gap:2 }}>
            {TF_OPTIONS.map(t => (
              <button key={t} onClick={() => setTf(t)}
                style={{ padding:'3px 8px', borderRadius:4, fontSize:10, fontWeight:700, cursor:'pointer', border:'1px solid var(--border)',
                  background: tf===t ? '#00d4aa' : 'var(--bg2)',
                  color:      tf===t ? '#080c14' : 'var(--text3)' }}>
                {t}
              </button>
            ))}
          </div>
          {/* Lookback */}
          <select value={lb} onChange={e => setLb(+e.target.value)}
            style={{ padding:'3px 6px', borderRadius:4, fontSize:10, background:'var(--bg2)', color:'var(--text)', border:'1px solid var(--border)', cursor:'pointer' }}>
            {LB_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
          {lastRefresh && <span style={{ fontSize:10, color:'var(--text3)' }}>{lastRefresh.toLocaleTimeString()}</span>}
          <button onClick={load} disabled={loading || !hasOanda}
            style={{ padding:'4px 10px', borderRadius:4, fontSize:11, fontWeight:700, cursor:'pointer',
              background:'var(--bg2)', color:'var(--text3)', border:'1px solid var(--border)' }}>
            {loading ? '⟳' : '↺'} Refresh
          </button>
        </div>
      </div>

      {!hasOanda && (
        <div style={{ padding:'10px 16px', background:'#f59e0b14', borderBottom:'1px solid #f59e0b33', flexShrink:0 }}>
          <span style={{ fontSize:11, color:'#f59e0b' }}>⚠ Connect OANDA in Screener settings to enable live correlation data.</span>
        </div>
      )}

      <div style={{ flex:1, overflowY:'auto', padding:'12px 16px' }}>

        {loading && (
          <div style={{ textAlign:'center', padding:40, color:'var(--text3)' }}>
            <div style={{ fontSize:24, animation:'spin 1s linear infinite', display:'inline-block' }}>⟳</div>
            <div style={{ marginTop:8, fontSize:12 }}>Fetching {INSTRUMENTS.length} instruments…</div>
          </div>
        )}

        {!loading && available.length === 0 && hasOanda && (
          <div style={{ textAlign:'center', padding:40, color:'var(--text3)', fontSize:12 }}>
            No data loaded yet. Click Refresh.
          </div>
        )}

        {!loading && available.length > 1 && (
          <>
            {/* Colour legend */}
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10, flexWrap:'wrap' }}>
              <span style={{ fontSize:10, color:'var(--text3)' }}>Correlation:</span>
              {[[-1,'Strong Neg'],[-.7,'Mod Neg'],[0,'Neutral'],[.7,'Mod Pos'],[1,'Strong Pos']].map(([v,l]) => (
                <div key={v} style={{ display:'flex', alignItems:'center', gap:3 }}>
                  <div style={{ width:14, height:14, borderRadius:2, background:rToColor(v), border:'1px solid #ffffff10' }}/>
                  <span style={{ fontSize:9, color:'var(--text3)' }}>{l}</span>
                </div>
              ))}
              <span style={{ marginLeft:'auto', fontSize:10, color:'var(--text3)' }}>
                {available.length}/{INSTRUMENTS.length} instruments loaded · {lb}-bar {tf}
              </span>
            </div>

            {/* Matrix grid */}
            <div style={{ overflowX:'auto', marginBottom:16 }}>
              <table style={{ borderCollapse:'collapse', fontSize:10, tableLayout:'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ width:64, padding:'4px 6px', color:'var(--text3)', fontWeight:600, textAlign:'right', fontSize:9 }}>↓ vs →</th>
                    {available.map(ins => (
                      <th key={ins.key} style={{ width:54, padding:'4px 2px', textAlign:'center',
                        color: selected && (selected.col === ins.key || selected.row === ins.key) ? ins.color : 'var(--text3)',
                        fontWeight: selected && (selected.col === ins.key || selected.row === ins.key) ? 700 : 500,
                        fontSize:9, whiteSpace:'nowrap' }}>
                        {ins.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {available.map(rowIns => (
                    <tr key={rowIns.key}>
                      <td onClick={() => setFocus(focus === rowIns.key ? null : rowIns.key)}
                        title={`Show everything ${rowIns.label} moves with`}
                        style={{ padding:'2px 6px', textAlign:'right', fontWeight:700, fontSize:9,
                        color: focus === rowIns.key ? rowIns.color
                             : selected && (selected.row === rowIns.key || selected.col === rowIns.key) ? rowIns.color : 'var(--text3)',
                        whiteSpace:'nowrap', cursor:'pointer',
                        textDecoration: focus === rowIns.key ? 'underline' : 'none' }}>
                        {rowIns.label}
                      </td>
                      {available.map(colIns => {
                        const r = matrix[rowIns.key]?.[colIns.key];
                        const isSelf = rowIns.key === colIns.key;
                        const isHighlighted = selected &&
                          (selected.row === rowIns.key || selected.col === rowIns.key ||
                           selected.row === colIns.key || selected.col === colIns.key);
                        const isSelected = selected &&
                          ((selected.row === rowIns.key && selected.col === colIns.key) ||
                           (selected.row === colIns.key && selected.col === rowIns.key));
                        return (
                          <td key={colIns.key}
                            onClick={() => isSelf ? null : setSelected(
                              isSelected ? null : { row: rowIns.key, col: colIns.key }
                            )}
                            style={{
                              width:54, padding:'3px 2px', textAlign:'center',
                              background: isSelf ? '#0f172a' : rToColor(r),
                              color:      isSelf ? '#334155' : rToTextColor(r),
                              fontFamily: 'monospace', fontWeight: 700, fontSize:10,
                              cursor:     isSelf ? 'default' : 'pointer',
                              border:     isSelected ? '2px solid #00d4aa' : isHighlighted ? '1px solid #ffffff30' : '1px solid #0f172a',
                              opacity:    selected && !isHighlighted && !isSelf ? 0.4 : 1,
                              transition: 'opacity 0.15s',
                              userSelect: 'none',
                            }}>
                            {isSelf ? '●' : fmtR(r)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Selected pair detail */}
            {selected && (() => {
              const aIns = INSTRUMENTS.find(i => i.key === selected.row);
              const bIns = INSTRUMENTS.find(i => i.key === selected.col);
              const r = matrix[selected.row]?.[selected.col];
              if (!aIns || !bIns || r == null) return null;
              const abs = Math.abs(r);
              const strength = abs >= 0.8 ? 'Very Strong' : abs >= 0.6 ? 'Strong' : abs >= 0.4 ? 'Moderate' : abs >= 0.2 ? 'Weak' : 'Negligible';
              const dir = r > 0 ? 'Positive' : 'Negative';
              return (
                <div style={{ padding:'10px 14px', borderRadius:8, marginBottom:14, border:`1px solid #00d4aa44`, background:'#00d4aa08' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <span style={{ fontSize:13, fontWeight:700, color:aIns.color }}>{aIns.label}</span>
                    <span style={{ color:'var(--text3)' }}>↔</span>
                    <span style={{ fontSize:13, fontWeight:700, color:bIns.color }}>{bIns.label}</span>
                    <span style={{ marginLeft:8, fontSize:18, fontFamily:'monospace', fontWeight:900, color:rToColor(r) === '#1e293b' ? 'var(--text)' : r > 0 ? '#22c55e' : '#ef4444' }}>
                      r = {fmtR(r)}
                    </span>
                    <span style={{ fontSize:11, padding:'2px 8px', borderRadius:4, fontWeight:700,
                      background: Math.abs(r) >= 0.6 ? '#00d4aa18' : '#f59e0b18',
                      color:      Math.abs(r) >= 0.6 ? '#00d4aa' : '#f59e0b',
                      border:     `1px solid ${Math.abs(r) >= 0.6 ? '#00d4aa44' : '#f59e0b44'}` }}>
                      {strength} {dir}
                    </span>
                    <button onClick={() => setSelected(null)}
                      style={{ marginLeft:'auto', background:'none', border:'none', color:'var(--text3)', cursor:'pointer', fontSize:14 }}>✕</button>
                  </div>
                  <div style={{ fontSize:11, color:'var(--text3)' }}>
                    {r > 0.6 && `${aIns.label} and ${bIns.label} move strongly TOGETHER. Trading the same direction on both increases correlated risk.`}
                    {r < -0.6 && `${aIns.label} and ${bIns.label} move strongly OPPOSITE. One can hedge the other. Holding both long/short = net flat.`}
                    {Math.abs(r) <= 0.6 && Math.abs(r) >= 0.3 && `Moderate relationship — confirm other signals before trading both simultaneously.`}
                    {Math.abs(r) < 0.3 && `Weak correlation — these pairs are largely independent on this timeframe.`}
                  </div>
                </div>
              );
            })()}

            {/* Strong pairs list */}
            {/* ── One instrument against everything ─────────────────────────
                  Same numbers as the grid, asked the way people actually ask
                  it. Sorted by strength, with the threshold below which a
                  correlation at this sample size is indistinguishable from
                  chance shown rather than left for the reader to guess. ── */}
            {focus && (() => {
              const me = available.find(i => i.key === focus);
              if (!me) return null;
              const rows = available
                .filter(o => o.key !== focus)
                .map(o => ({ ...o, r: matrix[focus]?.[o.key] }))
                .filter(o => typeof o.r === 'number')
                .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
              const n = closes[focus]?.length || 0;
              const floor = n > 4 ? 1.96 / Math.sqrt(n) : 1;
              const strong = rows.filter(o => Math.abs(o.r) >= 0.7);
              return (
                <div style={{ background:'var(--card)', border:`1px solid ${me.color}55`, borderRadius:8,
                  padding:'12px 14px', marginBottom:12 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, flexWrap:'wrap' }}>
                    <span style={{ fontSize:14, fontWeight:800, color:me.color }}>{me.label}</span>
                    <span style={{ fontSize:11, color:'var(--text3)' }}>against everything · {tf} · {n} bars</span>
                    <button onClick={() => setFocus(null)}
                      style={{ marginLeft:'auto', fontSize:11, padding:'2px 9px', borderRadius:6, cursor:'pointer',
                        background:'transparent', color:'var(--text3)', border:'1px solid var(--border)' }}>close</button>
                  </div>
                  {strong.length > 0 && (
                    <div style={{ fontSize:11, color:'#fbbf24', marginBottom:8, lineHeight:1.6 }}>
                      ⚠ {strong.map(o => o.label).join(', ')} {strong.length > 1 ? 'are' : 'is'} above |0.7| —
                      holding {me.label} and {strong.length > 1 ? 'those' : 'that'} is one position at double size,
                      not two ideas.
                    </div>
                  )}
                  {rows.map(o => (
                    <div key={o.key} style={{ display:'flex', alignItems:'center', gap:8, padding:'2px 0',
                      opacity: Math.abs(o.r) >= floor ? 1 : 0.45 }}>
                      <span style={{ fontSize:11, fontWeight:700, color:o.color, width:76, flexShrink:0 }}>{o.label}</span>
                      <span style={{ fontSize:10, color:'var(--text3)', width:52, flexShrink:0 }}>
                        {o.r > 0 ? 'with' : 'against'}
                      </span>
                      <span style={{ flex:1, height:4, background:'#0f172a', borderRadius:2, overflow:'hidden', minWidth:40 }}>
                        <span style={{ display:'block', width:`${Math.min(100, Math.abs(o.r) * 100)}%`, height:'100%',
                          background: o.r > 0 ? '#22c55e' : '#ef4444' }}/>
                      </span>
                      <span style={{ fontSize:11, fontFamily:'monospace', fontWeight:700, width:44, textAlign:'right',
                        color: Math.abs(o.r) >= floor ? (o.r > 0 ? '#22c55e' : '#ef4444') : 'var(--text3)' }}>
                        {o.r > 0 ? '+' : ''}{o.r.toFixed(2)}
                      </span>
                    </div>
                  ))}
                  <div style={{ fontSize:10, color:'var(--text3)', marginTop:8, lineHeight:1.6 }}>
                    Dimmed rows are below |{floor.toFixed(2)}|, the level at which a correlation over {n} bars
                    stops being distinguishable from chance. Reading meaning into those is reading noise.
                  </div>
                </div>
              );
            })()}

            <div style={{ background:'var(--card)', border:'1px solid var(--border)', borderRadius:8, padding:'12px 14px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                <span style={{ fontSize:12, fontWeight:700, color:'var(--text)' }}>Notable Correlations</span>
                <div style={{ display:'flex', gap:4, marginLeft:'auto', alignItems:'center' }}>
                  <span style={{ fontSize:10, color:'var(--text3)' }}>|r| ≥</span>
                  {[0, 0.5, 0.7, 0.9].map(v => (
                    <button key={v} onClick={() => setFilter(v)}
                      style={{ padding:'2px 7px', borderRadius:3, fontSize:10, fontWeight:700, cursor:'pointer', border:'1px solid var(--border)',
                        background: filter===v ? '#00d4aa' : 'var(--bg2)',
                        color:      filter===v ? '#080c14' : 'var(--text3)' }}>
                      {v === 0 ? 'All' : v}
                    </button>
                  ))}
                </div>
              </div>

              {strongPairs.length === 0 && (
                <div style={{ color:'var(--text3)', fontSize:11, textAlign:'center', padding:12 }}>
                  No pairs with |r| ≥ {filter} on this timeframe/lookback.
                </div>
              )}

              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(200px, 1fr))', gap:6 }}>
                {strongPairs.slice(0, 30).map(({ a, b, r }) => (
                  <div key={`${a.key}-${b.key}`}
                    onClick={() => setSelected({ row: a.key, col: b.key })}
                    style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', borderRadius:6, cursor:'pointer',
                      border:'1px solid var(--border)', background:'var(--bg2)',
                      borderLeftColor: r > 0 ? '#22c55e' : '#ef4444', borderLeftWidth:3 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:10, fontWeight:700 }}>
                        <span style={{ color:a.color }}>{a.label}</span>
                        <span style={{ color:'var(--text3)', margin:'0 4px' }}>↔</span>
                        <span style={{ color:b.color }}>{b.label}</span>
                      </div>
                    </div>
                    <span style={{ fontSize:12, fontFamily:'monospace', fontWeight:900,
                      color: r > 0 ? '#22c55e' : '#ef4444' }}>
                      {r > 0 ? '+' : ''}{fmtR(r)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

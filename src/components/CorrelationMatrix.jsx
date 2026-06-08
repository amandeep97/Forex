import { useState, useEffect, useCallback } from 'react';

const INSTRUMENTS = [
  { key: 'EUR_USD',  label: 'EUR/USD', color: '#3b82f6' },
  { key: 'GBP_USD',  label: 'GBP/USD', color: '#8b5cf6' },
  { key: 'USD_JPY',  label: 'USD/JPY', color: '#f59e0b' },
  { key: 'USD_CHF',  label: 'USD/CHF', color: '#f97316' },
  { key: 'AUD_USD',  label: 'AUD/USD', color: '#10b981' },
  { key: 'USD_CAD',  label: 'USD/CAD', color: '#ef4444' },
  { key: 'NZD_USD',  label: 'NZD/USD', color: '#06b6d4' },
  { key: 'EUR_JPY',  label: 'EUR/JPY', color: '#a78bfa' },
  { key: 'GBP_JPY',  label: 'GBP/JPY', color: '#c084fc' },
  { key: 'AUD_JPY',  label: 'AUD/JPY', color: '#34d399' },
  { key: 'EUR_GBP',  label: 'EUR/GBP', color: '#60a5fa' },
  { key: 'XAU_USD',  label: 'XAU/USD', color: '#fbbf24' },
  { key: 'XAG_USD',  label: 'XAG/USD', color: '#94a3b8' },
  { key: 'BCO_USD',    label: 'Oil(BCO)', color: '#fb923c' },
  { key: 'USB10Y_USD', label: 'US10Y',   color: '#818cf8' },
  { key: 'SPX500_USD', label: 'SPX',     color: '#22c55e' },
  { key: 'NAS100_USD', label: 'NQ',      color: '#06b6d4' },
  { key: 'US30_USD',   label: 'DJI',     color: '#a78bfa' },
  { key: 'US2000_USD', label: 'RUT',     color: '#f472b6' },
  { key: 'BTC_USD',    label: 'BTC',     color: '#f59e0b' },
  { key: 'ETH_USD',    label: 'ETH',     color: '#818cf8' },
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
    if (c?.apiKey) return c;
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

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const ax = a.slice(-n), bx = b.slice(-n);
  const mA = ax.reduce((s, v) => s + v, 0) / n;
  const mB = bx.reduce((s, v) => s + v, 0) / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const x = ax[i] - mA, y = bx[i] - mB;
    num += x * y; dA += x * x; dB += y * y;
  }
  const denom = Math.sqrt(dA * dB);
  return denom === 0 ? null : +(num / denom).toFixed(2);
}

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
                      <td style={{ padding:'2px 6px', textAlign:'right', fontWeight:700, fontSize:9,
                        color: selected && (selected.row === rowIns.key || selected.col === rowIns.key) ? rowIns.color : 'var(--text3)',
                        whiteSpace:'nowrap' }}>
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

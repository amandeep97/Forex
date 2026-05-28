import { useState, useEffect } from 'react';

// CFTC futures contract codes for each currency
const COT_MARKETS = [
  { key:'EUR', label:'EUR/USD', code:'099741', color:'#3b82f6', invert:false },
  { key:'GBP', label:'GBP/USD', code:'096742', color:'#8b5cf6', invert:false },
  { key:'JPY', label:'USD/JPY', code:'097741', color:'#f59e0b', invert:true  },
  { key:'AUD', label:'AUD/USD', code:'232741', color:'#10b981', invert:false },
  { key:'CAD', label:'USD/CAD', code:'090741', color:'#ef4444', invert:true  },
  { key:'CHF', label:'USD/CHF', code:'092741', color:'#f97316', invert:true  },
  { key:'NZD', label:'NZD/USD', code:'112741', color:'#06b6d4', invert:false },
  { key:'XAU', label:'Gold',    code:'088691', color:'#eab308', invert:false },
  { key:'XAG', label:'Silver',  code:'084691', color:'#94a3b8', invert:false },
];

async function fetchCOTRows(code, weeks = 8) {
  const url = `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${weeks}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`CFTC ${res.status}`);
  return res.json();
}

function MiniSpark({ values }) {
  if (!values || values.length < 2) return null;
  const w = 100, h = 28;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) =>
    `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / range) * (h - 4) - 2).toFixed(1)}`
  ).join(' ');
  const last = values[values.length - 1];
  return (
    <svg width={w} height={h} style={{ display:'block', flexShrink:0 }}>
      <polyline points={pts} fill="none" stroke={last >= 0 ? '#22c55e' : '#ef4444'} strokeWidth="1.5" strokeLinejoin="round"/>
      <circle
        cx={w} cy={h - ((last - min) / range) * (h - 4) - 2}
        r="2.5" fill={last >= 0 ? '#22c55e' : '#ef4444'}/>
    </svg>
  );
}

export default function COTTab() {
  const [data,    setData]    = useState({});
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState('');
  const [view,    setView]    = useState('cards'); // 'cards' | 'table'

  useEffect(() => {
    setLoading(true); setErr('');
    let cancelled = false;
    Promise.allSettled(
      COT_MARKETS.map(async m => {
        const rows = await fetchCOTRows(m.code, 8);
        const arr = rows.map(r => ({
          date:  (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
          long:  +r.noncomm_positions_long_all  || 0,
          short: +r.noncomm_positions_short_all || 0,
          oi:    +r.open_interest_all           || 0,
          net:   (+r.noncomm_positions_long_all || 0) - (+r.noncomm_positions_short_all || 0),
        })).map(d => ({ ...d, net: m.invert ? -d.net : d.net }));
        return { key: m.key, arr };
      })
    ).then(results => {
      if (cancelled) return;
      const map = {};
      results.forEach(r => { if (r.status === 'fulfilled') map[r.value.key] = r.value.arr; });
      setData(map);
      if (Object.keys(map).length === 0) setErr('Could not load COT data. CFTC API may be temporarily unavailable.');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) return (
    <div style={{ padding:40, textAlign:'center', color:'var(--text3)' }}>
      <div style={{ fontSize:28, marginBottom:12, animation:'spin 1.2s linear infinite', display:'inline-block' }}>⟳</div>
      <div>Loading COT data from CFTC…</div>
      <div style={{ fontSize:10, marginTop:6, color:'#475569' }}>Fetching from publicreporting.cftc.gov</div>
    </div>
  );

  if (err) return (
    <div style={{ padding:24, textAlign:'center' }}>
      <div style={{ color:'#ef4444', marginBottom:8 }}>⚠ {err}</div>
      <div style={{ fontSize:11, color:'var(--text3)' }}>
        The CFTC Socrata API is free and public but may be temporarily unavailable.<br/>
        COT data updates every Friday after market close.
      </div>
    </div>
  );

  const allNets = Object.values(data).flatMap(arr => arr.map(d => Math.abs(d.net)));
  const maxNet  = Math.max(...allNets, 1);

  // Overall market bias summary
  const biasCount = COT_MARKETS.reduce((acc, m) => {
    const arr = data[m.key];
    if (!arr?.length) return acc;
    const bull = arr[0].net >= 0;
    return { bull: acc.bull + (bull ? 1 : 0), bear: acc.bear + (bull ? 0 : 1) };
  }, { bull: 0, bear: 0 });

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* Header */}
      <div style={{ padding:'10px 16px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', flexShrink:0 }}>
        <div>
          <span style={{ fontSize:14, fontWeight:700, color:'var(--text)' }}>📊 COT Report</span>
          <span style={{ fontSize:10, color:'var(--text3)', marginLeft:8 }}>CFTC Commitments of Traders — Non-Commercial (large speculators) net positions</span>
        </div>
        <div style={{ display:'flex', gap:4, marginLeft:'auto', flexWrap:'wrap' }}>
          {[{v:'cards',l:'Cards'},{v:'table',l:'Table'}].map(t => (
            <button key={t.v} onClick={() => setView(t.v)}
              style={{ padding:'3px 10px', borderRadius:4, fontSize:11, fontWeight:700, cursor:'pointer',
                background: view===t.v ? '#00d4aa' : 'var(--bg2)',
                color:      view===t.v ? '#080c14'  : 'var(--text3)',
                border:'1px solid var(--border)' }}>
              {t.l}
            </button>
          ))}
        </div>
      </div>

      {/* Bias summary bar */}
      <div style={{ padding:'6px 16px', borderBottom:'1px solid var(--border)', background:'#080c14', display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', flexShrink:0 }}>
        <span style={{ fontSize:10, fontWeight:700, color:'var(--text3)' }}>OVERALL:</span>
        <span style={{ fontSize:11, fontWeight:700, color:'#22c55e' }}>▲ {biasCount.bull} Bullish</span>
        <span style={{ fontSize:11, fontWeight:700, color:'#ef4444' }}>▼ {biasCount.bear} Bearish</span>
        <span style={{ fontSize:9, color:'var(--text3)', marginLeft:'auto' }}>Updated weekly (Fridays)</span>
        {/* quick bias chips */}
        {COT_MARKETS.map(m => {
          const arr = data[m.key];
          if (!arr?.length) return null;
          const bull = arr[0].net >= 0;
          return (
            <div key={m.key} style={{ padding:'2px 8px', borderRadius:4, fontSize:10, fontWeight:700, flexShrink:0,
              color:      bull ? '#22c55e' : '#ef4444',
              background: bull ? '#22c55e18' : '#ef444418',
              border:     `1px solid ${bull ? '#22c55e44' : '#ef444444'}` }}>
              {bull ? '▲' : '▼'} {m.label}
            </div>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex:1, overflowY:'auto', padding:'12px 16px' }}>

        {view === 'cards' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(270px, 1fr))', gap:10 }}>
            {COT_MARKETS.map(m => {
              const arr = data[m.key];
              if (!arr?.length) return null;
              const latest = arr[0];
              const prev   = arr[1];
              const bull   = latest.net >= 0;
              const delta  = prev ? latest.net - prev.net : 0;
              const history = [...arr].reverse().map(d => d.net);
              const total   = latest.long + latest.short || 1;
              const longPct = Math.round((latest.long / total) * 100);
              const shortPct = 100 - longPct;
              const maxBarNet = Math.abs(latest.net);
              const barPct    = maxNet > 0 ? (maxBarNet / maxNet) * 100 : 0;

              return (
                <div key={m.key} style={{ background:'var(--card)', border:`1px solid ${bull ? '#22c55e33' : '#ef444433'}`, borderRadius:8, padding:'10px 12px' }}>
                  {/* Card header */}
                  <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6 }}>
                    <span style={{ fontSize:13, fontWeight:700, color:m.color }}>{m.label}</span>
                    <span style={{ padding:'2px 7px', borderRadius:3, fontSize:10, fontWeight:700,
                      color:      bull ? '#22c55e' : '#ef4444',
                      background: bull ? '#22c55e18' : '#ef444418',
                      border:     `1px solid ${bull ? '#22c55e44' : '#ef444444'}` }}>
                      {bull ? '▲ NET LONG' : '▼ NET SHORT'}
                    </span>
                    {delta !== 0 && (
                      <span style={{ marginLeft:'auto', fontSize:10, fontFamily:'monospace',
                        color: delta > 0 ? '#22c55e' : '#ef4444' }}>
                        {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toLocaleString()}
                      </span>
                    )}
                  </div>

                  {/* Net position */}
                  <div style={{ fontSize:13, fontFamily:'monospace', color:bull?'#22c55e':'#ef4444', fontWeight:700, marginBottom:6 }}>
                    Net: {latest.net >= 0 ? '+' : ''}{latest.net.toLocaleString()}
                  </div>

                  {/* Net bar (relative to all markets) */}
                  <div style={{ height:6, background:'#1e293b', borderRadius:3, overflow:'hidden', marginBottom:6 }}>
                    <div style={{ width:`${barPct}%`, height:'100%', background:bull?'#22c55e':'#ef4444', borderRadius:3 }}/>
                  </div>

                  {/* Long vs Short split bar */}
                  <div style={{ display:'flex', height:5, borderRadius:3, overflow:'hidden', marginBottom:6 }}>
                    <div style={{ flex:latest.long, background:'#22c55e' }}/>
                    <div style={{ flex:latest.short, background:'#ef4444' }}/>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--text3)', marginBottom:8 }}>
                    <span style={{ color:'#22c55e' }}>Long: {longPct}% ({latest.long.toLocaleString()})</span>
                    <span style={{ color:'#ef4444' }}>Short: {shortPct}% ({latest.short.toLocaleString()})</span>
                  </div>

                  {/* Sparkline + date */}
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                    <MiniSpark values={history}/>
                    <div style={{ fontSize:9, color:'var(--text3)', textAlign:'right' }}>
                      <div>{latest.date}</div>
                      <div style={{ marginTop:2 }}>OI: {latest.oi.toLocaleString()}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {view === 'table' && (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
              <thead>
                <tr style={{ borderBottom:'1px solid var(--border)' }}>
                  {['Market','Bias','Net','Long','Short','OI','Week Δ','Date'].map(h => (
                    <th key={h} style={{ padding:'6px 10px', textAlign:'left', color:'var(--text3)', fontWeight:600, fontSize:10, whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COT_MARKETS.map(m => {
                  const arr = data[m.key];
                  if (!arr?.length) return null;
                  const latest = arr[0];
                  const prev   = arr[1];
                  const bull   = latest.net >= 0;
                  const delta  = prev ? latest.net - prev.net : 0;
                  return (
                    <tr key={m.key} style={{ borderBottom:'1px solid var(--border)' }}>
                      <td style={{ padding:'8px 10px', fontWeight:700, color:m.color }}>{m.label}</td>
                      <td style={{ padding:'8px 10px' }}>
                        <span style={{ padding:'2px 7px', borderRadius:3, fontSize:10, fontWeight:700,
                          color:bull?'#22c55e':'#ef4444', background:bull?'#22c55e18':'#ef444418' }}>
                          {bull ? '▲ LONG' : '▼ SHORT'}
                        </span>
                      </td>
                      <td style={{ padding:'8px 10px', fontFamily:'monospace', fontWeight:700, color:bull?'#22c55e':'#ef4444' }}>
                        {latest.net >= 0 ? '+' : ''}{latest.net.toLocaleString()}
                      </td>
                      <td style={{ padding:'8px 10px', fontFamily:'monospace', color:'#22c55e' }}>{latest.long.toLocaleString()}</td>
                      <td style={{ padding:'8px 10px', fontFamily:'monospace', color:'#ef4444' }}>{latest.short.toLocaleString()}</td>
                      <td style={{ padding:'8px 10px', fontFamily:'monospace', color:'var(--text3)' }}>{latest.oi.toLocaleString()}</td>
                      <td style={{ padding:'8px 10px', fontFamily:'monospace', color:delta>=0?'#22c55e':'#ef4444' }}>
                        {delta >= 0 ? '+' : ''}{delta.toLocaleString()}
                      </td>
                      <td style={{ padding:'8px 10px', color:'var(--text3)', fontSize:10 }}>{latest.date}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ padding:'6px 16px', fontSize:9, color:'var(--text3)', borderTop:'1px solid var(--border)', flexShrink:0 }}>
        Source: CFTC.gov public API · Non-Commercial = hedge funds &amp; large speculators · Inverted for USD-base pairs (JPY, CAD, CHF) · Updates every Friday
      </div>
    </div>
  );
}

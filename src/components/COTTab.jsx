import { useState, useEffect } from 'react';
import ChartModal from './ChartModal.jsx';

const WEEKS = 104; // 2 years

const COT_MARKETS = [
  { key:'EUR', label:'EUR/USD', code:'099741', color:'#3b82f6', invert:false, type:'tff'   },
  { key:'GBP', label:'GBP/USD', code:'096742', color:'#8b5cf6', invert:false, type:'tff'   },
  { key:'JPY', label:'USD/JPY', code:'097741', color:'#f59e0b', invert:true,  type:'tff'   },
  { key:'AUD', label:'AUD/USD', code:'232741', color:'#10b981', invert:false, type:'tff'   },
  { key:'CAD', label:'USD/CAD', code:'090741', color:'#ef4444', invert:true,  type:'tff'   },
  { key:'CHF', label:'USD/CHF', code:'092741', color:'#f97316', invert:true,  type:'tff'   },
  { key:'NZD', label:'NZD/USD', code:'112741', color:'#06b6d4', invert:false, type:'tff'   },
  { key:'XAU', label:'Gold',    code:'088691', commodity:'GOLD',   color:'#eab308', invert:false, type:'disag' },
  { key:'XAG', label:'Silver',  code:'084691', commodity:'SILVER', color:'#94a3b8', invert:false, type:'disag' },
];

// ── Legacy API (non-commercial) — used for original card display ──────────────
async function fetchLegacy(code) {
  const url = `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${WEEKS}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`Legacy ${res.status}`);
  return res.json();
}

// ── TFF API (4 categories) — for FX pairs ────────────────────────────────────
async function fetchTFF(code) {
  const url = `https://publicreporting.cftc.gov/resource/gpe5-46if.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${WEEKS}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`TFF ${res.status}`);
  return res.json();
}

// ── Disaggregated API (4 categories) — for metals ────────────────────────────
// Tries by contract code first; falls back to commodity name search if empty
async function fetchDisag(code, commodity) {
  const byCode = `https://publicreporting.cftc.gov/resource/6ddc-gi25.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${WEEKS}`;
  const r1 = await fetch(byCode, { signal: AbortSignal.timeout(25000) });
  if (r1.ok) {
    const d = await r1.json();
    if (d.length > 0) return d;
  }
  // Fallback: search by commodity name (handles code differences between reports)
  const byName = `https://publicreporting.cftc.gov/resource/6ddc-gi25.json?$where=upper(commodity_name)%20like%20'%25${commodity}%25'&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${WEEKS}`;
  const r2 = await fetch(byName, { signal: AbortSignal.timeout(25000) });
  if (!r2.ok) throw new Error(`Disag ${r2.status}`);
  return r2.json();
}

function n(v) { return +v || 0; }
const s = (invert, val) => invert ? -val : val;

function parseLegacy(rows, invert) {
  return rows.map(r => ({
    date:  (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
    long:  n(r.noncomm_positions_long_all),
    short: n(r.noncomm_positions_short_all),
    oi:    n(r.open_interest_all),
    net:   s(invert, n(r.noncomm_positions_long_all) - n(r.noncomm_positions_short_all)),
  }));
}

function parseTFF(rows, invert) {
  return rows.map(r => ({
    date: (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
    leveraged: s(invert, n(r.lev_money_positions_long_all   || r.lev_money_positions_long)
                        - n(r.lev_money_positions_short_all  || r.lev_money_positions_short)),
    assetMgr:  s(invert, n(r.asset_mgr_positions_long_all   || r.asset_mgr_positions_long)
                        - n(r.asset_mgr_positions_short_all  || r.asset_mgr_positions_short)),
    dealer:    s(invert, n(r.dealer_positions_long_all)      - n(r.dealer_positions_short_all)),
    smallSpec: s(invert, n(r.nonrept_positions_long_all)     - n(r.nonrept_positions_short_all)),
  }));
}

function parseDisag(rows, invert) {
  return rows.map(r => ({
    date: (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
    leveraged: s(invert, n(r.m_money_positions_long_all)        - n(r.m_money_positions_short_all)),
    assetMgr:  s(invert, n(r.prod_merc_positions_long_all)      - n(r.prod_merc_positions_short_all)),
    dealer:    s(invert, n(r.swap_positions_long_all)            - n(r['swap__positions_short_all'] || r.swap_positions_short_all)),
    smallSpec: s(invert, n(r.nonrept_positions_long_all)        - n(r.nonrept_positions_short_all)),
  }));
}

// ── Crowded signal: percentile over full history ──────────────────────────────
function getCrowded(legacyArr) {
  if (legacyArr.length < 10) return null;
  const nets = legacyArr.map(d => d.net);
  const cur = nets[0], min = Math.min(...nets), max = Math.max(...nets);
  const range = max - min;
  if (range === 0) return null;
  const pct = (cur - min) / range;
  if (pct >= 0.8) return { type:'CROWDED LONG',  color:'#f85149', bg:'#f8514920',
    desc:'Hedge funds extremely net long — contrarian SHORT bias' };
  if (pct <= 0.2) return { type:'CROWDED SHORT', color:'#3fb950', bg:'#3fb95020',
    desc:'Hedge funds extremely net short — contrarian LONG bias' };
  return null;
}

// ── Extreme flag: 52-week (last 52 entries) percentile ───────────────────────
function getExtreme(legacyArr) {
  // Use the most recent 52 weeks (entries are newest-first)
  const slice = legacyArr.slice(0, 52);
  if (slice.length < 10) return null;
  const nets = slice.map(d => d.net);
  const cur = nets[0], min = Math.min(...nets), max = Math.max(...nets);
  const range = max - min;
  if (range === 0) return null;
  const pct = (cur - min) / range * 100;
  if (pct >= 80) return { type:'EXTREME LONG',  pct, color:'#f43f5e', bg:'#f43f5e18', border:'#f43f5e44' };
  if (pct <= 20) return { type:'EXTREME SHORT', pct, color:'#22c55e', bg:'#22c55e18', border:'#22c55e44' };
  return null;
}


// ── History line chart (full 2-year sparkline) ────────────────────────────────
function HistoryChart({ arr, color }) {
  if (!arr || arr.length < 4) return null;
  const vals  = [...arr].reverse().map(d => d.net);
  const dates = [...arr].reverse().map(d => d.date);
  const W = 300, H = 60;
  const minV = Math.min(...vals, 0), maxV = Math.max(...vals, 0);
  const range = maxV - minV || 1;
  const toX = i => (i / (vals.length - 1)) * W;
  const toY = v => H - 4 - ((v - minV) / range) * (H - 8);
  const zeroY = toY(0);
  const pts = vals.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  const lc = last >= 0 ? '#22c55e' : '#ef4444';
  const ticks = [0, Math.floor(vals.length / 2), vals.length - 1];
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H + 14}`} style={{ display:'block' }}>
      <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#30363d" strokeWidth="1" strokeDasharray="3,2"/>
      <polyline points={pts} fill="none" stroke={lc} strokeWidth="1.5" strokeLinejoin="round"/>
      <circle cx={toX(vals.length-1)} cy={toY(last)} r="2.5" fill={lc}/>
      {ticks.map(i => (
        <text key={i} x={toX(i)} y={H+12}
          textAnchor={i===0?'start':i===vals.length-1?'end':'middle'}
          fontSize="7" fill="#484f58">{dates[i]?.slice(0,7)}</text>
      ))}
    </svg>
  );
}

// ── Category row (new addition) ───────────────────────────────────────────────
function CatRow({ label, net, prevNet, maxAbs }) {
  if (net === undefined) return null;
  const wow  = prevNet !== undefined ? net - prevNet : null;
  const bull = net >= 0;
  const barW = maxAbs > 0 ? Math.min(100, (Math.abs(net) / maxAbs) * 100) : 0;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
      <span style={{ fontSize:10, color:'#8b949e', minWidth:90, flexShrink:0 }}>{label}</span>
      <span style={{ fontFamily:'monospace', fontSize:11, fontWeight:700,
        color:bull?'#22c55e':'#ef4444', minWidth:68, flexShrink:0 }}>
        {net>=0?'+':''}{net.toLocaleString()}
      </span>
      {wow !== null && (
        <span style={{ fontSize:9, fontFamily:'monospace', minWidth:60, flexShrink:0,
          color:wow>0?'#22c55e':wow<0?'#ef4444':'#8b949e' }}>
          {wow>=0?'+':''}{wow.toLocaleString()} WoW
        </span>
      )}
      <div style={{ flex:1, height:4, background:'#21262d', borderRadius:2, overflow:'hidden' }}>
        <div style={{ width:`${barW}%`, height:'100%', background:bull?'#22c55e':'#ef4444', borderRadius:2 }}/>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function COTTab() {
  const [chartInstrument, setChartInstrument] = useState(null);
  const [legacy,   setLegacy]   = useState({});
  const [cats,     setCats]     = useState({});
  const [loading,  setLoading]  = useState(true);
  const [err,      setErr]      = useState('');
  const [view,     setView]     = useState('cards');
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    setLoading(true); setErr('');
    let cancelled = false;

    Promise.allSettled([
      // Fetch 1: legacy non-commercial data (original display)
      Promise.allSettled(COT_MARKETS.map(async m => {
        const rows = await fetchLegacy(m.code);
        return { key: m.key, arr: parseLegacy(rows, m.invert) };
      })),
      // Fetch 2: 4-category data (new addition)
      Promise.allSettled(COT_MARKETS.map(async m => {
        try {
          const rows = m.type === 'tff' ? await fetchTFF(m.code) : await fetchDisag(m.code, m.commodity);
          return { key: m.key, arr: m.type === 'tff' ? parseTFF(rows, m.invert) : parseDisag(rows, m.invert) };
        } catch { return { key: m.key, arr: [] }; }
      })),
    ]).then(([legacyRes, catsRes]) => {
      if (cancelled) return;
      const legMap = {}, catMap = {};
      legacyRes.value?.forEach(r => { if (r.status==='fulfilled') legMap[r.value.key] = r.value.arr; });
      catsRes.value?.forEach(r  => { if (r.status==='fulfilled') catMap[r.value.key]  = r.value.arr; });
      setLegacy(legMap);
      setCats(catMap);
      if (!Object.keys(legMap).length) setErr('Could not load COT data. CFTC API may be temporarily unavailable.');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) return (
    <div style={{ padding:40, textAlign:'center', color:'var(--text3)' }}>
      <div style={{ fontSize:28, marginBottom:12, display:'inline-block' }}>⟳</div>
      <div>Loading {WEEKS}-week COT history from CFTC…</div>
      <div style={{ fontSize:10, marginTop:6, color:'#475569' }}>Fetching from publicreporting.cftc.gov</div>
    </div>
  );

  if (err) return (
    <div style={{ padding:24, textAlign:'center' }}>
      <div style={{ color:'#ef4444', marginBottom:8 }}>⚠ {err}</div>
      <div style={{ fontSize:11, color:'var(--text3)' }}>
        CFTC API may be temporarily unavailable. Updates every Friday.
      </div>
    </div>
  );

  const allNets   = Object.values(legacy).flatMap(arr => arr.map(d => Math.abs(d.net)));
  const maxNet    = Math.max(...allNets, 1);
  const biasCount = COT_MARKETS.reduce((acc, m) => {
    const arr = legacy[m.key];
    if (!arr?.length) return acc;
    const bull = arr[0].net >= 0;
    return { bull: acc.bull+(bull?1:0), bear: acc.bear+(bull?0:1) };
  }, { bull:0, bear:0 });

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* Header */}
      <div style={{ padding:'10px 16px', borderBottom:'1px solid var(--border)', display:'flex',
        alignItems:'center', gap:10, flexWrap:'wrap', flexShrink:0 }}>
        <div>
          <span style={{ fontSize:14, fontWeight:700, color:'var(--text)' }}>📊 COT Report</span>
          <span style={{ fontSize:10, color:'var(--text3)', marginLeft:8 }}>
            CFTC Commitments of Traders — {WEEKS}-week history · 4 trader categories
          </span>
        </div>
        <div style={{ display:'flex', gap:4, marginLeft:'auto' }}>
          {[{v:'cards',l:'Cards'},{v:'table',l:'Table'}].map(t => (
            <button key={t.v} onClick={() => setView(t.v)}
              style={{ padding:'3px 10px', borderRadius:4, fontSize:11, fontWeight:700, cursor:'pointer',
                background:view===t.v?'#00d4aa':'var(--bg2)',
                color:view===t.v?'#080c14':'var(--text3)',
                border:'1px solid var(--border)' }}>{t.l}</button>
          ))}
        </div>
      </div>

      {/* Bias summary */}
      <div style={{ padding:'6px 16px', borderBottom:'1px solid var(--border)', background:'#080c14',
        display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', flexShrink:0 }}>
        <span style={{ fontSize:10, fontWeight:700, color:'var(--text3)' }}>OVERALL:</span>
        <span style={{ fontSize:11, fontWeight:700, color:'#22c55e' }}>▲ {biasCount.bull} Bullish</span>
        <span style={{ fontSize:11, fontWeight:700, color:'#ef4444' }}>▼ {biasCount.bear} Bearish</span>
        <span style={{ fontSize:9, color:'var(--text3)', marginLeft:'auto' }}>Updated weekly (Fridays)</span>
        {COT_MARKETS.map(m => {
          const arr = legacy[m.key];
          if (!arr?.length) return null;
          const bull    = arr[0].net >= 0;
          const crowded = getCrowded(arr);
          return (
            <div key={m.key} style={{ padding:'2px 8px', borderRadius:4, fontSize:10, fontWeight:700, flexShrink:0,
              color:      crowded ? crowded.color : (bull?'#22c55e':'#ef4444'),
              background: crowded ? crowded.bg    : (bull?'#22c55e18':'#ef444418'),
              border:`1px solid ${crowded ? crowded.color+'44' : (bull?'#22c55e44':'#ef444444')}` }}>
              {crowded ? '⚠ ' : (bull?'▲ ':'▼ ')}{m.label}
            </div>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex:1, overflowY:'auto', padding:'12px 16px' }}>

        {/* ── Chart buttons ── */}
        <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:12, padding:'0 4px' }}>
          {[
            { label:'EUR/USD', sym:'EUR/USD' },
            { label:'GBP/USD', sym:'GBP/USD' },
            { label:'USD/JPY', sym:'USD/JPY' },
            { label:'AUD/USD', sym:'AUD/USD' },
            { label:'USD/CAD', sym:'USD/CAD' },
            { label:'USD/CHF', sym:'USD/CHF' },
            { label:'NZD/USD', sym:'NZD/USD' },
            { label:'Gold', sym:'XAU/USD' },
            { label:'Silver', sym:'XAG/USD' },
          ].map(({ label, sym }) => (
            <button key={sym} onClick={() => setChartInstrument({ symbol: sym })} style={{
              fontSize:10, padding:'3px 8px', borderRadius:4, cursor:'pointer',
              background:'#8b5cf622', color:'#a78bfa', border:'1px solid #8b5cf644',
            }}>📊 {label}</button>
          ))}
        </div>

        {/* ── CARDS ──────────────────────────────────────────────── */}
        {view === 'cards' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', gap:12 }}>
            {COT_MARKETS.map(m => {
              const arr = legacy[m.key];
              if (!arr?.length) return null;
              const catArr  = cats[m.key] || [];
              const latest  = arr[0], prev = arr[1];
              const latCat  = catArr[0],  prevCat = catArr[1];
              const bull    = latest.net >= 0;
              const delta   = prev ? latest.net - prev.net : 0;
              const history = [...arr].reverse().map(d => d.net);
              const total   = latest.long + latest.short || 1;
              const longPct  = Math.round((latest.long / total) * 100);
              const shortPct = 100 - longPct;
              const barPct   = maxNet > 0 ? (Math.abs(latest.net) / maxNet) * 100 : 0;
              const crowded  = getCrowded(arr);
              const extreme  = getExtreme(arr);
              const isExp    = expanded[m.key];

              const maxCatAbs = latCat ? Math.max(
                Math.abs(latCat.leveraged), Math.abs(latCat.assetMgr),
                Math.abs(latCat.dealer),    Math.abs(latCat.smallSpec), 1
              ) : 1;

              return (
                <div key={m.key} style={{ background:'var(--card)',
                  border:`1px solid ${crowded ? crowded.color+'55' : (bull?'#22c55e33':'#ef444433')}`,
                  borderRadius:8, padding:'10px 12px' }}>

                  {/* ── CROWDED SIGNAL (new) ── */}
                  {crowded && (
                    <div style={{ background:crowded.bg, border:`1px solid ${crowded.color}44`,
                      borderRadius:6, padding:'5px 8px', marginBottom:8 }}>
                      <div style={{ fontSize:11, fontWeight:800, color:crowded.color, letterSpacing:'0.05em' }}>
                        {crowded.type}
                      </div>
                      <div style={{ fontSize:9, color:crowded.color, opacity:0.85, marginTop:1 }}>
                        {crowded.desc}
                      </div>
                    </div>
                  )}

                  {/* ── Original: header ── */}
                  <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6 }}>
                    <span style={{ fontSize:13, fontWeight:700, color:m.color }}>{m.label}</span>
                    <span style={{ padding:'2px 7px', borderRadius:3, fontSize:10, fontWeight:700,
                      color:bull?'#22c55e':'#ef4444', background:bull?'#22c55e18':'#ef444418',
                      border:`1px solid ${bull?'#22c55e44':'#ef444444'}` }}>
                      {bull ? '▲ NET LONG' : '▼ NET SHORT'}
                    </span>
                    {delta !== 0 && (
                      <span style={{ marginLeft:'auto', fontSize:10, fontFamily:'monospace',
                        color:delta>0?'#22c55e':'#ef4444' }}>
                        {delta>0?'▲':'▼'} {Math.abs(delta).toLocaleString()}
                      </span>
                    )}
                  </div>

                  {/* ── Original: net position ── */}
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <div style={{ fontSize:13, fontFamily:'monospace', color:bull?'#22c55e':'#ef4444', fontWeight:700 }}>
                      Net: {latest.net>=0?'+':''}{latest.net.toLocaleString()}
                    </div>
                    {extreme && (
                      <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4,
                        color:extreme.color, background:extreme.bg, border:`1px solid ${extreme.border}` }}>
                        ⚠ {extreme.type}
                      </span>
                    )}
                  </div>

                  {/* ── Original: net bar ── */}
                  <div style={{ height:6, background:'#1e293b', borderRadius:3, overflow:'hidden', marginBottom:6 }}>
                    <div style={{ width:`${barPct}%`, height:'100%', background:bull?'#22c55e':'#ef4444', borderRadius:3 }}/>
                  </div>

                  {/* ── Original: long/short split ── */}
                  <div style={{ display:'flex', height:5, borderRadius:3, overflow:'hidden', marginBottom:4 }}>
                    <div style={{ flex:latest.long, background:'#22c55e' }}/>
                    <div style={{ flex:latest.short, background:'#ef4444' }}/>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--text3)', marginBottom:10 }}>
                    <span style={{ color:'#22c55e' }}>Long: {longPct}% ({latest.long.toLocaleString()})</span>
                    <span style={{ color:'#ef4444' }}>Short: {shortPct}% ({latest.short.toLocaleString()})</span>
                  </div>

                  {/* ── NEW: 4 categories breakdown ── */}
                  {latCat && (
                    <div style={{ borderTop:'1px solid #21262d', paddingTop:8, marginBottom:8 }}>
                      <div style={{ fontSize:9, fontWeight:600, color:'#8b949e', marginBottom:6,
                        textTransform:'uppercase', letterSpacing:'0.05em' }}>
                        Net Positioning by Trader
                      </div>
                      <CatRow label="Leveraged Funds"                        net={latCat.leveraged} prevNet={prevCat?.leveraged} maxAbs={maxCatAbs}/>
                      <CatRow label={m.type==='disag'?'Prod/Merchant':'Asset Manager'} net={latCat.assetMgr}  prevNet={prevCat?.assetMgr}  maxAbs={maxCatAbs}/>
                      <CatRow label={m.type==='disag'?'Swap Dealer':'Dealer'}          net={latCat.dealer}    prevNet={prevCat?.dealer}    maxAbs={maxCatAbs}/>
                      <CatRow label="Small Specs"                                      net={latCat.smallSpec} prevNet={prevCat?.smallSpec} maxAbs={maxCatAbs}/>
                    </div>
                  )}

                  {/* ── Original: sparkline + date ── */}
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', borderTop:'1px solid #21262d', paddingTop:8 }}>
                    <MiniSpark values={history.slice(-8)}/>
                    <div style={{ fontSize:9, color:'var(--text3)', textAlign:'right' }}>
                      <div>{latest.date}</div>
                      <div style={{ marginTop:2 }}>OI: {latest.oi.toLocaleString()}</div>
                    </div>
                  </div>

                  {/* ── NEW: expandable full history chart ── */}
                  <div style={{ marginTop:8 }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                      cursor:'pointer', userSelect:'none' }}
                      onClick={() => setExpanded(e => ({ ...e, [m.key]: !e[m.key] }))}>
                      <span style={{ fontSize:9, color:'#484f58' }}>
                        Non-Commercial Net — {arr.length} weeks history
                      </span>
                      <span style={{ fontSize:10, color:'#484f58' }}>{isExp ? '▲' : '▼'}</span>
                    </div>
                    {isExp && <div style={{ marginTop:6 }}><HistoryChart arr={arr} color={m.color}/></div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── TABLE ──────────────────────────────────────────────── */}
        {view === 'table' && (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
              <thead>
                <tr style={{ borderBottom:'1px solid var(--border)' }}>
                  {['Market','Signal','Extreme (52wk)','Net (Non-Comm)','Long','Short','OI','WoW','Lev Funds','Asset Mgr','Dealer','Small Specs','Date'].map(h => (
                    <th key={h} style={{ padding:'6px 8px', textAlign:'left', color:'var(--text3)',
                      fontWeight:600, fontSize:10, whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COT_MARKETS.map(m => {
                  const arr    = legacy[m.key];
                  const catArr = cats[m.key] || [];
                  if (!arr?.length) return null;
                  const l = arr[0], p = arr[1];
                  const lc = catArr[0], pc = catArr[1];
                  const bull    = l.net >= 0;
                  const delta   = p ? l.net - p.net : 0;
                  const crowded = getCrowded(arr);
                  const extreme = getExtreme(arr);
                  const C = ({ v }) => (
                    <td style={{ padding:'6px 8px', fontFamily:'monospace', fontSize:10, whiteSpace:'nowrap',
                      color: v===undefined ? '#484f58' : v>=0 ? '#22c55e' : '#ef4444' }}>
                      {v===undefined ? '—' : `${v>=0?'+':''}${v.toLocaleString()}`}
                    </td>
                  );
                  return (
                    <tr key={m.key} style={{ borderBottom:'1px solid #21262d' }}>
                      <td style={{ padding:'6px 8px', fontWeight:700, color:m.color, whiteSpace:'nowrap' }}>{m.label}</td>
                      <td style={{ padding:'6px 8px' }}>
                        <span style={{ padding:'2px 6px', borderRadius:3, fontSize:9, fontWeight:700,
                          color:crowded?crowded.color:(bull?'#22c55e':'#ef4444'),
                          background:crowded?crowded.bg:(bull?'#22c55e18':'#ef444418') }}>
                          {crowded ? crowded.type : (bull?'▲ LONG':'▼ SHORT')}
                        </span>
                      </td>
                      <td style={{ padding:'6px 8px' }}>
                        {extreme ? (
                          <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4,
                            color:extreme.color, background:extreme.bg, border:`1px solid ${extreme.border}`,
                            whiteSpace:'nowrap' }}>
                            ⚠ {extreme.type}
                          </span>
                        ) : (
                          <span style={{ fontSize:9, color:'#484f58' }}>—</span>
                        )}
                      </td>
                      <C v={l.net}/>
                      <td style={{ padding:'6px 8px', fontFamily:'monospace', fontSize:10, color:'#22c55e' }}>{l.long.toLocaleString()}</td>
                      <td style={{ padding:'6px 8px', fontFamily:'monospace', fontSize:10, color:'#ef4444' }}>{l.short.toLocaleString()}</td>
                      <td style={{ padding:'6px 8px', fontFamily:'monospace', fontSize:10, color:'var(--text3)' }}>{l.oi.toLocaleString()}</td>
                      <C v={delta}/>
                      <C v={lc?.leveraged}/>
                      <C v={lc?.assetMgr}/>
                      <C v={lc?.dealer}/>
                      <C v={lc?.smallSpec}/>
                      <td style={{ padding:'6px 8px', color:'#484f58', fontSize:10 }}>{l.date}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── How to read ── */}
        <div style={{ marginTop:20, padding:'12px 14px', background:'#161b22',
          border:'1px solid #30363d', borderRadius:8, fontSize:11, color:'#8b949e' }}>
          <div style={{ fontWeight:700, color:'#e6edf3', marginBottom:8 }}>How to read COT</div>
          <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
            <div><span style={{ color:'#f85149' }}>Leveraged Funds extreme net long</span> → crowd is in, smart money fades = bearish signal</div>
            <div><span style={{ color:'#3fb950' }}>Leveraged Funds extreme net short</span> → shorts crowded = short squeeze risk = bullish</div>
            <div><span style={{ color:'#58a6ff' }}>Asset Manager net long growing</span> → institutional accumulation = bullish</div>
            <div><span style={{ color:'#d29922' }}>Dealer net long</span> → market makers positioned to sell into strength (normal hedging)</div>
            <div style={{ marginTop:4, color:'#484f58', fontSize:10 }}>
              ⚠ CROWDED signal = Non-Commercial at 80th/20th percentile of {WEEKS}-week range · Contrarian bias only, not entry signal
            </div>
            <div style={{ marginTop:3, color:'#484f58', fontSize:10 }}>
              ⚠ EXTREME flag = top/bottom 20% of 52-week range → potential reversal zone · EXTREME LONG = crowded longs at risk of unwind · EXTREME SHORT = shorts may squeeze
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding:'6px 16px', fontSize:9, color:'var(--text3)',
        borderTop:'1px solid var(--border)', flexShrink:0 }}>
        Source: CFTC.gov public API · Non-Commercial = hedge funds &amp; large speculators ·
        4-category breakdown from TFF &amp; Disaggregated reports · {WEEKS}-week history · Updates every Friday
      </div>
      {chartInstrument && (
        <ChartModal instrument={chartInstrument} onClose={() => setChartInstrument(null)} />
      )}
    </div>
  );
}

// ── MiniSpark (original) ──────────────────────────────────────────────────────
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
      <circle cx={w} cy={h - ((last - min) / range) * (h - 4) - 2} r="2.5" fill={last >= 0 ? '#22c55e' : '#ef4444'}/>
    </svg>
  );
}

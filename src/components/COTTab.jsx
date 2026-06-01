import { useState, useEffect } from 'react';

const WEEKS = 104; // 2 years of history

// CFTC contract codes
const COT_MARKETS = [
  { key:'EUR', label:'EUR/USD', code:'099741', color:'#3b82f6', invert:false, type:'tff'   },
  { key:'GBP', label:'GBP/USD', code:'096742', color:'#8b5cf6', invert:false, type:'tff'   },
  { key:'JPY', label:'USD/JPY', code:'097741', color:'#f59e0b', invert:true,  type:'tff'   },
  { key:'AUD', label:'AUD/USD', code:'232741', color:'#10b981', invert:false, type:'tff'   },
  { key:'CAD', label:'USD/CAD', code:'090741', color:'#ef4444', invert:true,  type:'tff'   },
  { key:'CHF', label:'USD/CHF', code:'092741', color:'#f97316', invert:true,  type:'tff'   },
  { key:'NZD', label:'NZD/USD', code:'112741', color:'#06b6d4', invert:false, type:'tff'   },
  { key:'XAU', label:'Gold',    code:'088691', color:'#eab308', invert:false, type:'disag' },
  { key:'XAG', label:'Silver',  code:'084691', color:'#94a3b8', invert:false, type:'disag' },
];

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchTFF(code) {
  const url = `https://publicreporting.cftc.gov/resource/gpe5-46if.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${WEEKS}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`TFF ${res.status}`);
  return res.json();
}

async function fetchDisag(code) {
  const url = `https://publicreporting.cftc.gov/resource/6ddc-gi25.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${WEEKS}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`Disag ${res.status}`);
  return res.json();
}

function n(v) { return +v || 0; }

function parseTFF(rows, invert) {
  const s = invert ? -1 : 1;
  return rows.map(r => ({
    date:       (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
    oi:          n(r.open_interest_all),
    leveraged: { long: n(r.lev_money_positions_long_all  || r.lev_money_positions_long),
                 short: n(r.lev_money_positions_short_all || r.lev_money_positions_short),
                 net:   s * (n(r.lev_money_positions_long_all  || r.lev_money_positions_long)
                           - n(r.lev_money_positions_short_all || r.lev_money_positions_short)) },
    assetMgr:  { long: n(r.asset_mgr_positions_long_all  || r.asset_mgr_positions_long),
                 short: n(r.asset_mgr_positions_short_all || r.asset_mgr_positions_short),
                 net:   s * (n(r.asset_mgr_positions_long_all  || r.asset_mgr_positions_long)
                           - n(r.asset_mgr_positions_short_all || r.asset_mgr_positions_short)) },
    dealer:    { long: n(r.dealer_positions_long_all),
                 short: n(r.dealer_positions_short_all),
                 net:   s * (n(r.dealer_positions_long_all) - n(r.dealer_positions_short_all)) },
    smallSpec: { long: n(r.nonrept_positions_long_all),
                 short: n(r.nonrept_positions_short_all),
                 net:   s * (n(r.nonrept_positions_long_all) - n(r.nonrept_positions_short_all)) },
  }));
}

function parseDisag(rows, invert) {
  const s = invert ? -1 : 1;
  return rows.map(r => ({
    date:       (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
    oi:          n(r.open_interest_all),
    leveraged: { long: n(r.m_money_positions_long_all),
                 short: n(r.m_money_positions_short_all),
                 net:   s * (n(r.m_money_positions_long_all) - n(r.m_money_positions_short_all)) },
    assetMgr:  { long: n(r.prod_merc_positions_long_all),
                 short: n(r.prod_merc_positions_short_all),
                 net:   s * (n(r.prod_merc_positions_long_all) - n(r.prod_merc_positions_short_all)) },
    dealer:    { long: n(r.swap_positions_long_all),
                 short: n(r['swap__positions_short_all'] || r.swap_positions_short_all),
                 net:   s * (n(r.swap_positions_long_all)
                           - n(r['swap__positions_short_all'] || r.swap_positions_short_all)) },
    smallSpec: { long: n(r.nonrept_positions_long_all),
                 short: n(r.nonrept_positions_short_all),
                 net:   s * (n(r.nonrept_positions_long_all) - n(r.nonrept_positions_short_all)) },
  }));
}

// ── Crowded signal (percentile over full history) ─────────────────────────────

function getCrowded(arr) {
  if (arr.length < 8) return null;
  const nets = arr.map(d => d.leveraged.net);
  const current = nets[0];
  const min = Math.min(...nets), max = Math.max(...nets);
  const range = max - min;
  if (range === 0) return null;
  const pct = (current - min) / range;
  if (pct >= 0.8) return { type: 'CROWDED LONG',  color: '#f85149', bg: '#f8514920',
    desc: 'Hedge funds extremely net long — contrarian SHORT bias' };
  if (pct <= 0.2) return { type: 'CROWDED SHORT', color: '#3fb950', bg: '#3fb95020',
    desc: 'Hedge funds extremely net short — contrarian LONG bias' };
  return null;
}

// ── Chart component (full history line chart) ─────────────────────────────────

function HistoryChart({ arr, color }) {
  if (!arr || arr.length < 4) return null;
  const vals  = [...arr].reverse().map(d => d.leveraged.net);
  const dates = [...arr].reverse().map(d => d.date);
  const W = 320, H = 72;
  const minV = Math.min(...vals, 0), maxV = Math.max(...vals, 0);
  const range = maxV - minV || 1;
  const toX = i  => (i / (vals.length - 1)) * W;
  const toY = v  => H - 4 - ((v - minV) / range) * (H - 8);
  const zeroY = toY(0);

  const pts = vals.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const areaAbove = `M${toX(0)},${zeroY} ` +
    vals.map((v, i) => `L${toX(i).toFixed(1)},${Math.min(toY(v), zeroY).toFixed(1)}`).join(' ') +
    ` L${toX(vals.length-1)},${zeroY} Z`;
  const areaBelow = `M${toX(0)},${zeroY} ` +
    vals.map((v, i) => `L${toX(i).toFixed(1)},${Math.max(toY(v), zeroY).toFixed(1)}`).join(' ') +
    ` L${toX(vals.length-1)},${zeroY} Z`;

  const last = vals[vals.length - 1];
  const lastColor = last >= 0 ? '#3fb950' : '#f85149';

  // Tick labels: first, middle, last date
  const ticks = [
    { i: 0, label: dates[0]?.slice(0, 7) },
    { i: Math.floor(vals.length / 2), label: dates[Math.floor(vals.length / 2)]?.slice(0, 7) },
    { i: vals.length - 1, label: dates[vals.length - 1]?.slice(0, 7) },
  ];

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H + 14}`} style={{ display: 'block', overflow: 'visible' }}>
      <path d={areaAbove} fill="#3fb950" opacity="0.12" />
      <path d={areaBelow} fill="#f85149" opacity="0.12" />
      <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#30363d" strokeWidth="1" strokeDasharray="3,3" />
      <polyline points={pts} fill="none" stroke={lastColor} strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx={toX(vals.length - 1)} cy={toY(last)} r="3" fill={lastColor} />
      {ticks.map(t => (
        <text key={t.i} x={toX(t.i)} y={H + 12} textAnchor={t.i === 0 ? 'start' : t.i === vals.length - 1 ? 'end' : 'middle'}
          fontSize="8" fill="#484f58">{t.label}</text>
      ))}
    </svg>
  );
}

// ── Category bar row ───────────────────────────────────────────────────────────

function CatRow({ label, curr, prev, maxAbs }) {
  if (!curr) return null;
  const wow   = prev ? curr.net - prev.net : null;
  const bull  = curr.net >= 0;
  const barW  = maxAbs > 0 ? Math.min(100, (Math.abs(curr.net) / maxAbs) * 100) : 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', alignItems: 'center', gap: 8, marginBottom: 7 }}>
      <div style={{ fontSize: 11, color: '#8b949e' }}>{label}</div>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700,
            color: bull ? '#3fb950' : '#f85149', minWidth: 72 }}>
            {curr.net >= 0 ? '+' : ''}{curr.net.toLocaleString()}
          </span>
          {wow !== null && (
            <span style={{ fontSize: 10, color: wow > 0 ? '#3fb950' : wow < 0 ? '#f85149' : '#8b949e',
              fontFamily: 'monospace', minWidth: 70 }}>
              {wow >= 0 ? '+' : ''}{wow.toLocaleString()} WoW
            </span>
          )}
        </div>
        <div style={{ height: 5, background: '#21262d', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${barW}%`, height: '100%', background: bull ? '#3fb950' : '#f85149',
            borderRadius: 3, transition: 'width 0.4s' }} />
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function COTTab() {
  const [data,    setData]    = useState({});
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState('');
  const [view,    setView]    = useState('cards');
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    setLoading(true); setErr('');
    let cancelled = false;
    Promise.allSettled(
      COT_MARKETS.map(async m => {
        const rows = m.type === 'tff' ? await fetchTFF(m.code) : await fetchDisag(m.code);
        const arr  = m.type === 'tff' ? parseTFF(rows, m.invert) : parseDisag(rows, m.invert);
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
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}>
      <div style={{ fontSize: 28, marginBottom: 12, display: 'inline-block' }}>⟳</div>
      <div>Loading {WEEKS}-week COT history from CFTC…</div>
      <div style={{ fontSize: 10, marginTop: 6, color: '#475569' }}>
        Fetching disaggregated & TFF reports from publicreporting.cftc.gov
      </div>
    </div>
  );

  if (err) return (
    <div style={{ padding: 24, textAlign: 'center' }}>
      <div style={{ color: '#ef4444', marginBottom: 8 }}>⚠ {err}</div>
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>
        CFTC API may be temporarily unavailable. COT data updates every Friday.
      </div>
    </div>
  );

  const biasCount = COT_MARKETS.reduce((acc, m) => {
    const arr = data[m.key];
    if (!arr?.length) return acc;
    const bull = arr[0].leveraged.net >= 0;
    return { bull: acc.bull + (bull ? 1 : 0), bear: acc.bear + (bull ? 0 : 1) };
  }, { bull: 0, bear: 0 });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex',
        alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>📊 COT Report</span>
          <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 8 }}>
            CFTC — Disaggregated · {WEEKS}-week history · 4 trader categories
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {[{ v: 'cards', l: 'Cards' }, { v: 'table', l: 'Table' }].map(t => (
            <button key={t.v} onClick={() => setView(t.v)}
              style={{ padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                background: view === t.v ? '#00d4aa' : 'var(--bg2)',
                color:      view === t.v ? '#080c14'  : 'var(--text3)',
                border: '1px solid var(--border)' }}>
              {t.l}
            </button>
          ))}
        </div>
      </div>

      {/* Bias summary */}
      <div style={{ padding: '6px 16px', borderBottom: '1px solid var(--border)', background: '#080c14',
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>LEVERAGED FUNDS:</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#3fb950' }}>▲ {biasCount.bull} Net Long</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#f85149' }}>▼ {biasCount.bear} Net Short</span>
        <span style={{ fontSize: 9, color: 'var(--text3)', marginLeft: 'auto' }}>Updated weekly (Fridays)</span>
        {COT_MARKETS.map(m => {
          const arr = data[m.key];
          if (!arr?.length) return null;
          const bull = arr[0].leveraged.net >= 0;
          const crowded = getCrowded(arr);
          return (
            <div key={m.key} style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
              color:      crowded ? crowded.color : (bull ? '#3fb950' : '#f85149'),
              background: crowded ? crowded.bg    : (bull ? '#3fb95018' : '#f8514918'),
              border:     `1px solid ${crowded ? crowded.color + '44' : (bull ? '#3fb95044' : '#f8514944')}`,
              flexShrink: 0 }}>
              {crowded ? '⚠ ' : (bull ? '▲ ' : '▼ ')}{m.label}
            </div>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>

        {/* ── CARDS VIEW ─────────────────────────────────────────── */}
        {view === 'cards' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {COT_MARKETS.map(m => {
              const arr = data[m.key];
              if (!arr?.length) return null;
              const latest   = arr[0];
              const prev     = arr[1];
              const crowded  = getCrowded(arr);
              const bull     = latest.leveraged.net >= 0;
              const isExp    = expanded[m.key];

              // Max absolute net across 4 categories (for bar scaling)
              const maxAbs = Math.max(
                Math.abs(latest.leveraged.net),
                Math.abs(latest.assetMgr.net),
                Math.abs(latest.dealer.net),
                Math.abs(latest.smallSpec.net),
                1
              );

              return (
                <div key={m.key} style={{ background: 'var(--card)',
                  border: `1px solid ${crowded ? crowded.color + '55' : (bull ? '#3fb95033' : '#f8514933')}`,
                  borderRadius: 10, padding: '12px 14px' }}>

                  {/* Crowded signal banner */}
                  {crowded && (
                    <div style={{ background: crowded.bg, border: `1px solid ${crowded.color}44`,
                      borderRadius: 6, padding: '6px 10px', marginBottom: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: crowded.color, letterSpacing: '0.05em' }}>
                        {crowded.type}
                      </div>
                      <div style={{ fontSize: 10, color: crowded.color, opacity: 0.8, marginTop: 2 }}>
                        {crowded.desc}
                      </div>
                    </div>
                  )}

                  {/* Card title */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: m.color }}>{m.label}</span>
                    <span style={{ padding: '2px 7px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                      color:      bull ? '#3fb950' : '#f85149',
                      background: bull ? '#3fb95018' : '#f8514918',
                      border:     `1px solid ${bull ? '#3fb95044' : '#f8514944'}` }}>
                      {bull ? '▲ NET LONG' : '▼ NET SHORT'}
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: 9, color: '#484f58' }}>
                      {latest.date}
                    </span>
                  </div>

                  {/* Section: Net Positioning */}
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#8b949e', marginBottom: 8,
                    textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Net Positioning (contracts)
                  </div>

                  <CatRow label="Leveraged Funds" curr={latest.leveraged} prev={prev?.leveraged} maxAbs={maxAbs} />
                  <CatRow label="Asset Manager"   curr={latest.assetMgr}  prev={prev?.assetMgr}  maxAbs={maxAbs} />
                  <CatRow label="Dealer"          curr={latest.dealer}    prev={prev?.dealer}    maxAbs={maxAbs} />
                  <CatRow label="Small Specs"     curr={latest.smallSpec} prev={prev?.smallSpec} maxAbs={maxAbs} />

                  {/* History chart toggle */}
                  <div style={{ borderTop: '1px solid #21262d', marginTop: 10, paddingTop: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      cursor: 'pointer', userSelect: 'none' }}
                      onClick={() => setExpanded(e => ({ ...e, [m.key]: !e[m.key] }))}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Leveraged Funds Net — {arr.length} weeks
                      </span>
                      <span style={{ fontSize: 12, color: '#8b949e' }}>{isExp ? '▲' : '▼'}</span>
                    </div>
                    {isExp && (
                      <div style={{ marginTop: 8 }}>
                        <HistoryChart arr={arr} color={m.color} />
                      </div>
                    )}
                  </div>

                  {/* OI */}
                  <div style={{ fontSize: 9, color: '#484f58', marginTop: 6 }}>
                    OI: {latest.oi.toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── TABLE VIEW ─────────────────────────────────────────── */}
        {view === 'table' && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Market','Signal','Lev Funds','WoW','Asset Mgr','WoW','Dealer','WoW','Small Specs','WoW','Date'].map(h => (
                    <th key={h} style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--text3)',
                      fontWeight: 600, fontSize: 10, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COT_MARKETS.map(m => {
                  const arr = data[m.key];
                  if (!arr?.length) return null;
                  const l = arr[0], p = arr[1];
                  const crowded = getCrowded(arr);
                  const bull = l.leveraged.net >= 0;
                  const wow = (cat) => p ? l[cat].net - p[cat].net : 0;
                  const Cell = ({ val, wow: w }) => (
                    <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontWeight: 600,
                      color: val >= 0 ? '#3fb950' : '#f85149', whiteSpace: 'nowrap' }}>
                      {val >= 0 ? '+' : ''}{val.toLocaleString()}
                      {w !== undefined && (
                        <span style={{ fontSize: 9, marginLeft: 4, color: w > 0 ? '#3fb950' : w < 0 ? '#f85149' : '#8b949e' }}>
                          {w >= 0 ? '+' : ''}{w.toLocaleString()}
                        </span>
                      )}
                    </td>
                  );
                  return (
                    <tr key={m.key} style={{ borderBottom: '1px solid #21262d' }}>
                      <td style={{ padding: '7px 8px', fontWeight: 700, color: m.color, whiteSpace: 'nowrap' }}>{m.label}</td>
                      <td style={{ padding: '7px 8px' }}>
                        <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700,
                          color:      crowded ? crowded.color : (bull ? '#3fb950' : '#f85149'),
                          background: crowded ? crowded.bg    : (bull ? '#3fb95018' : '#f8514918') }}>
                          {crowded ? crowded.type : (bull ? '▲ LONG' : '▼ SHORT')}
                        </span>
                      </td>
                      <Cell val={l.leveraged.net} />
                      <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontSize: 10, whiteSpace: 'nowrap',
                        color: wow('leveraged') > 0 ? '#3fb950' : wow('leveraged') < 0 ? '#f85149' : '#8b949e' }}>
                        {wow('leveraged') >= 0 ? '+' : ''}{wow('leveraged').toLocaleString()}
                      </td>
                      <Cell val={l.assetMgr.net} />
                      <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontSize: 10, whiteSpace: 'nowrap',
                        color: wow('assetMgr') > 0 ? '#3fb950' : wow('assetMgr') < 0 ? '#f85149' : '#8b949e' }}>
                        {wow('assetMgr') >= 0 ? '+' : ''}{wow('assetMgr').toLocaleString()}
                      </td>
                      <Cell val={l.dealer.net} />
                      <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontSize: 10, whiteSpace: 'nowrap',
                        color: wow('dealer') > 0 ? '#3fb950' : wow('dealer') < 0 ? '#f85149' : '#8b949e' }}>
                        {wow('dealer') >= 0 ? '+' : ''}{wow('dealer').toLocaleString()}
                      </td>
                      <Cell val={l.smallSpec.net} />
                      <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontSize: 10, whiteSpace: 'nowrap',
                        color: wow('smallSpec') > 0 ? '#3fb950' : wow('smallSpec') < 0 ? '#f85149' : '#8b949e' }}>
                        {wow('smallSpec') >= 0 ? '+' : ''}{wow('smallSpec').toLocaleString()}
                      </td>
                      <td style={{ padding: '7px 8px', color: '#484f58', fontSize: 10 }}>{l.date}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── How to read ────────────────────────────────────────── */}
        <div style={{ marginTop: 20, padding: '12px 14px', background: '#161b22',
          border: '1px solid #30363d', borderRadius: 8, fontSize: 11, color: '#8b949e' }}>
          <div style={{ fontWeight: 700, color: '#e6edf3', marginBottom: 8 }}>How to read COT</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div><span style={{ color: '#f85149' }}>Leveraged Funds extreme net long</span> → crowd is in, smart money fades = bearish signal</div>
            <div><span style={{ color: '#3fb950' }}>Leveraged Funds extreme net short</span> → shorts crowded = short squeeze risk = bullish</div>
            <div><span style={{ color: '#58a6ff' }}>Asset Manager net long growing</span> → institutional accumulation = bullish</div>
            <div><span style={{ color: '#d29922' }}>Dealer net long</span> → market makers positioned to sell into rallies (normal)</div>
            <div style={{ marginTop: 4, color: '#484f58', fontSize: 10 }}>
              ⚠ CROWDED signal = Leveraged Funds at 80th/20th percentile of {WEEKS}-week range · Contrarian bias only, not entry signal
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '6px 16px', fontSize: 9, color: 'var(--text3)',
        borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        Source: CFTC.gov · TFF report (currencies) · Disaggregated report (metals) · {WEEKS}-week history · Updates every Friday
      </div>
    </div>
  );
}

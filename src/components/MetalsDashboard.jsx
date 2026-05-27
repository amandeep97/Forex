import { useState, useEffect, useCallback } from 'react';

// ── OANDA instruments ────────────────────────────────────────────────────────
const INSTR = {
  gold:    'XAU_USD',
  silver:  'XAG_USD',
  dxy:     'EUR_USD',     // inverted — DXY proxy
  bonds10: 'USB10Y_USD',
  bonds2:  'USB02Y_USD',
  oil:     'BCO_USD',
  copper:  'XCU_USD',
};

// CFTC contract codes for 52-week COT history
const COT_METALS = [
  { key: 'XAU', label: 'Gold',   code: '088691', color: '#fbbf24' },
  { key: 'XAG', label: 'Silver', code: '084691', color: '#94a3b8' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
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

async function fetchCOTHistory(code, weeks = 54) {
  const url = `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${weeks}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows.map(r => ({
      date:  (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
      long:  +r.noncomm_positions_long_all  || 0,
      short: +r.noncomm_positions_short_all || 0,
      net:   (+r.noncomm_positions_long_all || 0) - (+r.noncomm_positions_short_all || 0),
    }));
  } catch { return null; }
}

function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
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

function pctRank(value, history) {
  if (!history?.length) return null;
  const below = history.filter(v => v <= value).length;
  return Math.round((below / history.length) * 100);
}

function direction(closes, lookback = 5) {
  if (!closes || closes.length < lookback + 1) return null;
  const n = closes.length;
  return closes[n - 1] > closes[n - 1 - lookback] ? 'rising' : 'falling';
}

function pctChange(closes, lookback = 5) {
  if (!closes || closes.length < lookback + 1) return null;
  const n = closes.length;
  return ((closes[n - 1] - closes[n - 1 - lookback]) / closes[n - 1 - lookback]) * 100;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function Gauge({ pct, label, color }) {
  if (pct === null) return <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>;
  const zone = pct >= 80 ? '#22c55e' : pct <= 20 ? '#ef4444' : pct >= 60 ? '#86efac' : pct <= 40 ? '#fca5a5' : '#f59e0b';
  const zoneLabel = pct >= 80 ? 'Extreme Long' : pct <= 20 ? 'Extreme Short' : pct >= 60 ? 'Moderately Long' : pct <= 40 ? 'Moderately Short' : 'Neutral';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: zone }}>{pct}th pct — {zoneLabel}</span>
      </div>
      <div style={{ height: 8, background: '#1e293b', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
        {/* zones */}
        <div style={{ position:'absolute', left:0, width:'20%', height:'100%', background:'#ef444433' }}/>
        <div style={{ position:'absolute', right:0, width:'20%', height:'100%', background:'#22c55e33' }}/>
        {/* needle */}
        <div style={{ position:'absolute', left:`${Math.min(pct, 97)}%`, top:0, width:3, height:'100%', background: zone, borderRadius:2, transform:'translateX(-50%)' }}/>
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'#475569', marginTop:2 }}>
        <span>Short Extreme</span><span>Neutral</span><span>Long Extreme</span>
      </div>
    </div>
  );
}

function MiniSpark({ values, color = '#00d4aa' }) {
  if (!values || values.length < 2) return null;
  const w = 80, h = 24;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) =>
    `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / range) * (h - 4) - 2).toFixed(1)}`
  ).join(' ');
  const last = values[values.length - 1];
  const c = last >= values[0] ? color : '#ef4444';
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round"/>
      <circle cx={w} cy={h - ((last - min) / range) * (h - 4) - 2} r="2.5" fill={c}/>
    </svg>
  );
}

function SignalBadge({ bull, label, note }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 8px', borderRadius:5,
      background: bull === true ? '#22c55e14' : bull === false ? '#ef444414' : '#33333320',
      border: `1px solid ${bull === true ? '#22c55e44' : bull === false ? '#ef444444' : '#33333340'}` }}>
      <span style={{ fontSize:12, lineHeight:1 }}>{bull === true ? '▲' : bull === false ? '▼' : '—'}</span>
      <div>
        <div style={{ fontSize:11, fontWeight:700, color: bull === true ? '#22c55e' : bull === false ? '#ef4444' : 'var(--text3)' }}>{label}</div>
        {note && <div style={{ fontSize:9, color:'var(--text3)' }}>{note}</div>}
      </div>
    </div>
  );
}

function ScoreRing({ score, max, label, color }) {
  const pct = max > 0 ? score / max : 0;
  const r = 28, cx = 36, cy = 36;
  const circ = 2 * Math.PI * r;
  const dash = pct * circ;
  return (
    <div style={{ textAlign:'center' }}>
      <svg width={72} height={72}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e293b" strokeWidth={6}/>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={6}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}/>
        <text x={cx} y={cy - 4} textAnchor="middle" fill={color} fontSize="13" fontWeight="700">{score}</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="#64748b" fontSize="9">/{max}</text>
      </svg>
      <div style={{ fontSize:12, fontWeight:700, color:'var(--text)', marginTop:2 }}>{label}</div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function MetalsDashboard() {
  const [mkt, setMkt]       = useState(null);   // market closes data
  const [cot, setCot]       = useState(null);   // COT 52-week data
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const hasOanda = !!getOandaCreds();

  const load = useCallback(async () => {
    setLoading(true);
    const COUNT = 60;
    const [gold, silver, dxy, bonds10, bonds2, oil, copper,
           cotGold, cotSilver] = await Promise.all([
      fetchCloses(INSTR.gold,    'H1', COUNT),
      fetchCloses(INSTR.silver,  'H1', COUNT),
      fetchCloses(INSTR.dxy,     'H1', COUNT),
      fetchCloses(INSTR.bonds10, 'H1', COUNT),
      fetchCloses(INSTR.bonds2,  'H1', COUNT),
      fetchCloses(INSTR.oil,     'H1', COUNT),
      fetchCloses(INSTR.copper,  'H1', COUNT),
      fetchCOTHistory('088691', 54),
      fetchCOTHistory('084691', 54),
    ]);
    setMkt({ gold, silver, dxy, bonds10, bonds2, oil, copper });
    setCot({ gold: cotGold, silver: cotSilver });
    setLoading(false);
    setLastRefresh(new Date());
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Derive signals ──────────────────────────────────────────────────────────
  const sig = {};

  if (mkt) {
    // DXY direction (EUR_USD inverted)
    const dxyDir = direction(mkt.dxy);
    sig.dxy = dxyDir ? (dxyDir === 'falling' ? 'rising' : 'falling') : null; // invert
    sig.dxyPct = mkt.dxy ? -(pctChange(mkt.dxy) || 0) : null;

    // DXY correlation to Gold (inverted: EUR_USD negative corr → DXY positive corr)
    if (mkt.dxy && mkt.gold) {
      const rawR = pearsonCorr(mkt.dxy, mkt.gold);
      sig.dxyGoldCorr = rawR !== null ? +(-rawR).toFixed(2) : null; // flip: DXY vs gold
    }

    // Real yield proxy: 10Y direction (rising 10Y = bearish gold)
    sig.bonds10Dir = direction(mkt.bonds10);
    sig.bonds10Pct = pctChange(mkt.bonds10);
    sig.bonds2Dir  = direction(mkt.bonds2);

    // Yield curve = 10Y minus 2Y
    if (mkt.bonds10 && mkt.bonds2) {
      const n10 = mkt.bonds10.length, n2 = mkt.bonds2.length;
      if (n10 > 0 && n2 > 0) {
        sig.yieldCurve = +(mkt.bonds10[n10 - 1] - mkt.bonds2[n2 - 1]).toFixed(3);
        sig.yieldCurveInverted = sig.yieldCurve < 0;
      }
    }

    // Real yield proxy direction: if bonds rising & gold falling → real yields rising → bearish
    if (sig.bonds10Dir && mkt.gold) {
      const goldDir = direction(mkt.gold);
      if (sig.bonds10Dir === 'rising' && goldDir === 'falling') sig.realYieldSignal = 'bearish';
      else if (sig.bonds10Dir === 'falling' && goldDir === 'rising') sig.realYieldSignal = 'bullish';
      else sig.realYieldSignal = 'neutral';
    }

    // Gold/Silver ratio
    if (mkt.gold && mkt.silver) {
      const ng = mkt.gold.length, ns = mkt.silver.length;
      if (ng > 0 && ns > 0) {
        sig.auAgRatio = +(mkt.gold[ng - 1] / mkt.silver[ns - 1]).toFixed(2);
        // >80 = silver cheap, <50 = silver expensive, 50-80 normal
        sig.auAgSignal = sig.auAgRatio > 80 ? 'silver_cheap' : sig.auAgRatio < 50 ? 'silver_expensive' : 'normal';
      }
    }

    // Gold/Oil ratio
    if (mkt.gold && mkt.oil) {
      const ng = mkt.gold.length, no = mkt.oil.length;
      if (ng > 0 && no > 0) {
        sig.goldOilRatio = +(mkt.gold[ng - 1] / mkt.oil[no - 1]).toFixed(2);
        sig.goldOilHigh = sig.goldOilRatio > 30; // gold expensive vs oil
      }
    }

    // Gold momentum
    sig.goldDir  = direction(mkt.gold);
    sig.goldPct  = pctChange(mkt.gold);
    sig.silverDir = direction(mkt.silver);
    sig.silverPct = pctChange(mkt.silver);

    // Copper → Silver leading indicator (copper up = industrial demand = silver bullish)
    sig.copperDir = direction(mkt.copper);
    if (mkt.copper && mkt.silver) {
      const rawR = pearsonCorr(mkt.copper, mkt.silver);
      sig.copperSilverCorr = rawR;
    }

    // Oil → Gold correlation
    if (mkt.oil && mkt.gold) {
      sig.oilGoldCorr = pearsonCorr(mkt.oil, mkt.gold);
    }
  }

  // COT percentile
  const cotSig = {};
  if (cot) {
    ['gold', 'silver'].forEach(k => {
      const rows = cot[k];
      if (!rows?.length) return;
      const nets = rows.map(r => r.net);
      const latest = rows[0];
      const history52 = nets.slice(1); // exclude current week
      cotSig[k] = {
        net:    latest.net,
        long:   latest.long,
        short:  latest.short,
        date:   latest.date,
        bias:   latest.net >= 0 ? 'bullish' : 'bearish',
        pct:    pctRank(latest.net, history52),
        nets:   [...nets].reverse(),   // oldest → newest for spark
        delta:  rows[1] ? latest.net - rows[1].net : 0,
      };
    });
  }

  // ── Overall confluence score ────────────────────────────────────────────────
  function calcScore(metal) {
    const factors = [];
    // 1. DXY: rising DXY = bearish metals
    if (sig.dxy) factors.push({ label:'DXY', bull: sig.dxy === 'falling', w: 2 });
    // 2. Real yields: rising = bearish
    if (sig.realYieldSignal) factors.push({ label:'Real Yield', bull: sig.realYieldSignal === 'bullish', w: 2 });
    // 3. COT
    const c = cotSig[metal === 'gold' ? 'gold' : 'silver'];
    if (c) factors.push({ label:'COT', bull: c.bias === 'bullish', w: 2 });
    // 4. Momentum
    const dir = metal === 'gold' ? sig.goldDir : sig.silverDir;
    if (dir) factors.push({ label:'Momentum', bull: dir === 'rising', w: 1 });
    // 5. Yield curve inversion (good for gold)
    if (sig.yieldCurveInverted !== undefined) factors.push({ label:'Yield Curve', bull: sig.yieldCurveInverted, w: 1 });
    // 6. Copper for silver
    if (metal === 'silver' && sig.copperDir) factors.push({ label:'Copper', bull: sig.copperDir === 'rising', w: 1 });
    if (!factors.length) return null;
    const max = factors.reduce((s, f) => s + f.w, 0);
    const score = factors.filter(f => f.bull).reduce((s, f) => s + f.w, 0);
    return { score, max, factors };
  }

  const goldScore   = calcScore('gold');
  const silverScore = calcScore('silver');

  const fmtPct = v => v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const fmtR   = v => v === null ? '—' : v.toFixed(2);

  const card = {
    background: 'var(--card)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '12px 14px',
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* Header */}
      <div style={{ padding:'10px 16px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10, flexShrink:0, flexWrap:'wrap' }}>
        <div>
          <span style={{ fontSize:14, fontWeight:700, color:'var(--text)' }}>⚜ Metals Dashboard</span>
          <span style={{ fontSize:10, color:'var(--text3)', marginLeft:8 }}>Gold &amp; Silver — All Key Drivers</span>
        </div>
        <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center' }}>
          {lastRefresh && <span style={{ fontSize:10, color:'var(--text3)' }}>Updated {lastRefresh.toLocaleTimeString()}</span>}
          <button onClick={load} disabled={loading}
            style={{ padding:'4px 12px', borderRadius:4, fontSize:11, fontWeight:700, cursor:'pointer',
              background:'var(--bg2)', color:'var(--text3)', border:'1px solid var(--border)' }}>
            {loading ? '⟳ Loading…' : '↺ Refresh'}
          </button>
        </div>
      </div>

      {!hasOanda && (
        <div style={{ padding:'8px 16px', background:'#f59e0b14', borderBottom:'1px solid #f59e0b33', flexShrink:0 }}>
          <span style={{ fontSize:11, color:'#f59e0b' }}>⚠ Connect OANDA in Screener settings to enable live market data. COT data loads regardless.</span>
        </div>
      )}

      <div style={{ flex:1, overflowY:'auto', padding:'12px 16px' }}>

        {/* ── Confluence Score Row ─────────────────────────────────────────── */}
        <div style={{ display:'flex', gap:12, marginBottom:14, flexWrap:'wrap' }}>

          {/* Gold score */}
          <div style={{ ...card, flex:1, minWidth:220, display:'flex', alignItems:'center', gap:16,
            borderColor: goldScore && goldScore.score > goldScore.max/2 ? '#fbbf2444' : '#ef444433' }}>
            <ScoreRing score={goldScore?.score ?? '?'} max={goldScore?.max ?? 9} label="Gold (XAU)" color="#fbbf24"/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:10, color:'var(--text3)', marginBottom:4 }}>CONFLUENCE FACTORS</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                {goldScore?.factors?.map(f => (
                  <span key={f.label} style={{ fontSize:10, padding:'2px 6px', borderRadius:3, fontWeight:600,
                    color:      f.bull ? '#22c55e' : '#ef4444',
                    background: f.bull ? '#22c55e18' : '#ef444418',
                    border:     `1px solid ${f.bull ? '#22c55e33' : '#ef444433'}` }}>
                    {f.bull ? '▲' : '▼'} {f.label}
                  </span>
                )) ?? <span style={{ fontSize:11, color:'var(--text3)' }}>No data — connect OANDA</span>}
              </div>
              {sig.goldDir && (
                <div style={{ marginTop:6, fontSize:12, fontFamily:'monospace',
                  color: sig.goldDir === 'rising' ? '#22c55e' : '#ef4444' }}>
                  XAU/USD {fmtPct(sig.goldPct)} (5-bar)
                </div>
              )}
            </div>
          </div>

          {/* Silver score */}
          <div style={{ ...card, flex:1, minWidth:220, display:'flex', alignItems:'center', gap:16,
            borderColor: silverScore && silverScore.score > silverScore.max/2 ? '#94a3b844' : '#ef444433' }}>
            <ScoreRing score={silverScore?.score ?? '?'} max={silverScore?.max ?? 9} label="Silver (XAG)" color="#94a3b8"/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:10, color:'var(--text3)', marginBottom:4 }}>CONFLUENCE FACTORS</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                {silverScore?.factors?.map(f => (
                  <span key={f.label} style={{ fontSize:10, padding:'2px 6px', borderRadius:3, fontWeight:600,
                    color:      f.bull ? '#22c55e' : '#ef4444',
                    background: f.bull ? '#22c55e18' : '#ef444418',
                    border:     `1px solid ${f.bull ? '#22c55e33' : '#ef444433'}` }}>
                    {f.bull ? '▲' : '▼'} {f.label}
                  </span>
                )) ?? <span style={{ fontSize:11, color:'var(--text3)' }}>No data — connect OANDA</span>}
              </div>
              {sig.silverDir && (
                <div style={{ marginTop:6, fontSize:12, fontFamily:'monospace',
                  color: sig.silverDir === 'rising' ? '#22c55e' : '#ef4444' }}>
                  XAG/USD {fmtPct(sig.silverPct)} (5-bar)
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Main grid ───────────────────────────────────────────────────── */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', gap:12 }}>

          {/* DXY Monitor */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#38bdf8', marginBottom:8 }}>📉 US Dollar (DXY)</div>
            <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
              <div style={{ flex:1 }}>
                <SignalBadge
                  bull={sig.dxy === 'falling'}
                  label={sig.dxy ? `DXY ${sig.dxy === 'rising' ? 'Rising ↑' : 'Falling ↓'}` : 'No data'}
                  note={sig.dxy ? (sig.dxy === 'falling' ? 'Bullish for metals' : 'Bearish for metals') : 'Connect OANDA'}
                />
                {sig.dxyGoldCorr !== null && (
                  <div style={{ marginTop:8 }}>
                    <div style={{ fontSize:10, color:'var(--text3)', marginBottom:3 }}>DXY↔Gold correlation (50 H1)</div>
                    <div style={{ fontSize:13, fontFamily:'monospace', fontWeight:700,
                      color: Math.abs(sig.dxyGoldCorr) > 0.6 ? '#ef4444' : Math.abs(sig.dxyGoldCorr) > 0.3 ? '#f59e0b' : '#64748b' }}>
                      r = {fmtR(sig.dxyGoldCorr)}
                      <span style={{ fontSize:10, fontFamily:'sans-serif', marginLeft:6, color:'var(--text3)', fontWeight:400 }}>
                        {Math.abs(sig.dxyGoldCorr) > 0.6 ? 'Strong inverse' : Math.abs(sig.dxyGoldCorr) > 0.3 ? 'Moderate' : 'Weak'}
                      </span>
                    </div>
                  </div>
                )}
                {sig.dxyPct !== null && (
                  <div style={{ fontSize:11, fontFamily:'monospace', marginTop:6,
                    color: sig.dxyPct > 0 ? '#ef4444' : '#22c55e' }}>
                    DXY 5-bar: {fmtPct(sig.dxyPct)}
                  </div>
                )}
              </div>
              {mkt?.dxy && <MiniSpark values={mkt.dxy.slice(-20)} color="#38bdf8"/>}
            </div>
          </div>

          {/* Real Yields & Yield Curve */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#a78bfa', marginBottom:8 }}>📊 Real Yields &amp; Yield Curve</div>
            <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
              <SignalBadge
                bull={sig.realYieldSignal === 'bullish'}
                label={sig.realYieldSignal ? `Real Yield Proxy: ${sig.realYieldSignal.toUpperCase()}` : 'No data'}
                note="10Y rising + Gold falling = real yields up = bearish"
              />
              {sig.bonds10Dir && (
                <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderBottom:'1px solid var(--border)' }}>
                  <span style={{ fontSize:11, color:'var(--text3)' }}>US 10Y Yield</span>
                  <span style={{ fontSize:11, fontFamily:'monospace',
                    color: sig.bonds10Dir === 'rising' ? '#ef4444' : '#22c55e' }}>
                    {sig.bonds10Dir === 'rising' ? '▲ Rising' : '▼ Falling'}
                    {sig.bonds10Pct !== null && <span style={{ color:'var(--text3)', marginLeft:4 }}>{fmtPct(sig.bonds10Pct)}</span>}
                  </span>
                </div>
              )}
              {sig.yieldCurve !== undefined && (
                <div>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{ fontSize:11, color:'var(--text3)' }}>Yield Curve (10Y−2Y)</span>
                    <span style={{ fontSize:11, fontFamily:'monospace',
                      color: sig.yieldCurveInverted ? '#22c55e' : '#f59e0b' }}>
                      {sig.yieldCurve > 0 ? '+' : ''}{sig.yieldCurve}
                    </span>
                  </div>
                  {sig.yieldCurveInverted && (
                    <div style={{ fontSize:10, marginTop:3, padding:'3px 7px', borderRadius:3,
                      background:'#22c55e14', color:'#22c55e', border:'1px solid #22c55e33' }}>
                      ⚡ INVERTED — Recession signal → Historically bullish for Gold
                    </div>
                  )}
                  {!sig.yieldCurveInverted && sig.yieldCurve !== undefined && (
                    <div style={{ fontSize:10, marginTop:3, color:'var(--text3)' }}>
                      Normal curve — no recession premium
                    </div>
                  )}
                </div>
              )}
              {!sig.bonds10Dir && <span style={{ fontSize:11, color:'var(--text3)' }}>Connect OANDA for yield data</span>}
            </div>
          </div>

          {/* COT Gold */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#fbbf24', marginBottom:8 }}>🏦 COT — Gold (52wk)</div>
            {cotSig.gold ? (
              <div>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                  <div>
                    <div style={{ fontSize:13, fontFamily:'monospace', fontWeight:700,
                      color: cotSig.gold.bias === 'bullish' ? '#22c55e' : '#ef4444' }}>
                      Net: {cotSig.gold.net >= 0 ? '+' : ''}{cotSig.gold.net.toLocaleString()}
                    </div>
                    <div style={{ fontSize:10, color:'var(--text3)' }}>
                      {cotSig.gold.delta !== 0 && (
                        <span style={{ color: cotSig.gold.delta > 0 ? '#22c55e' : '#ef4444' }}>
                          {cotSig.gold.delta > 0 ? '▲' : '▼'} {Math.abs(cotSig.gold.delta).toLocaleString()} wk
                        </span>
                      )}
                      {' '}· {cotSig.gold.date}
                    </div>
                  </div>
                  <MiniSpark values={cotSig.gold.nets.slice(-12)} color="#fbbf24"/>
                </div>
                <Gauge pct={cotSig.gold.pct} label="52-week percentile"/>
                {cotSig.gold.pct !== null && (cotSig.gold.pct >= 80 || cotSig.gold.pct <= 20) && (
                  <div style={{ marginTop:6, padding:'4px 8px', borderRadius:4, fontSize:10, fontWeight:700,
                    background: cotSig.gold.pct >= 80 ? '#22c55e14' : '#ef444414',
                    color:      cotSig.gold.pct >= 80 ? '#22c55e' : '#ef4444',
                    border:     `1px solid ${cotSig.gold.pct >= 80 ? '#22c55e33' : '#ef444433'}` }}>
                    {cotSig.gold.pct >= 80 ? '⚡ Crowded LONG — Contrarian Bearish Risk' : '⚡ Extreme SHORT — Contrarian Bullish Setup'}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>Loading CFTC data…</div>
            )}
          </div>

          {/* COT Silver */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#94a3b8', marginBottom:8 }}>🏦 COT — Silver (52wk)</div>
            {cotSig.silver ? (
              <div>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                  <div>
                    <div style={{ fontSize:13, fontFamily:'monospace', fontWeight:700,
                      color: cotSig.silver.bias === 'bullish' ? '#22c55e' : '#ef4444' }}>
                      Net: {cotSig.silver.net >= 0 ? '+' : ''}{cotSig.silver.net.toLocaleString()}
                    </div>
                    <div style={{ fontSize:10, color:'var(--text3)' }}>
                      {cotSig.silver.delta !== 0 && (
                        <span style={{ color: cotSig.silver.delta > 0 ? '#22c55e' : '#ef4444' }}>
                          {cotSig.silver.delta > 0 ? '▲' : '▼'} {Math.abs(cotSig.silver.delta).toLocaleString()} wk
                        </span>
                      )}
                      {' '}· {cotSig.silver.date}
                    </div>
                  </div>
                  <MiniSpark values={cotSig.silver.nets.slice(-12)} color="#94a3b8"/>
                </div>
                <Gauge pct={cotSig.silver.pct} label="52-week percentile"/>
                {cotSig.silver.pct !== null && (cotSig.silver.pct >= 80 || cotSig.silver.pct <= 20) && (
                  <div style={{ marginTop:6, padding:'4px 8px', borderRadius:4, fontSize:10, fontWeight:700,
                    background: cotSig.silver.pct >= 80 ? '#22c55e14' : '#ef444414',
                    color:      cotSig.silver.pct >= 80 ? '#22c55e' : '#ef4444',
                    border:     `1px solid ${cotSig.silver.pct >= 80 ? '#22c55e33' : '#ef444433'}` }}>
                    {cotSig.silver.pct >= 80 ? '⚡ Crowded LONG — Contrarian Bearish Risk' : '⚡ Extreme SHORT — Contrarian Bullish Setup'}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>Loading CFTC data…</div>
            )}
          </div>

          {/* Au/Ag Ratio */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#e2b714', marginBottom:8 }}>⚖ Gold/Silver Ratio</div>
            {sig.auAgRatio ? (
              <div>
                <div style={{ fontSize:26, fontWeight:900, fontFamily:'monospace',
                  color: sig.auAgSignal === 'silver_cheap' ? '#22c55e' : sig.auAgSignal === 'silver_expensive' ? '#ef4444' : '#f59e0b' }}>
                  {sig.auAgRatio}
                </div>
                <div style={{ fontSize:11, marginTop:4,
                  color: sig.auAgSignal === 'silver_cheap' ? '#22c55e' : sig.auAgSignal === 'silver_expensive' ? '#ef4444' : '#f59e0b' }}>
                  {sig.auAgSignal === 'silver_cheap' && '⚡ >80 — Silver historically CHEAP vs Gold → Favour Silver longs'}
                  {sig.auAgSignal === 'silver_expensive' && '⚡ <50 — Silver historically EXPENSIVE vs Gold → Favour Gold'}
                  {sig.auAgSignal === 'normal' && 'Normal range (50–80)'}
                </div>
                {/* Visual gauge 0-120 */}
                <div style={{ marginTop:10 }}>
                  <div style={{ height:8, background:'#1e293b', borderRadius:4, position:'relative', overflow:'hidden' }}>
                    <div style={{ position:'absolute', left:'41.7%', width:'33.3%', height:'100%', background:'#22c55e18' }}/>
                    <div style={{ position:'absolute', left:0, width:'41.7%', height:'100%', background:'#ef444418' }}/>
                    <div style={{ position:'absolute', right:0, width:'25%', height:'100%', background:'#22c55e18' }}/>
                    <div style={{ position:'absolute', left:`${Math.min((sig.auAgRatio/120)*100, 97)}%`, top:0,
                      width:3, height:'100%', background:'#e2b714', borderRadius:2, transform:'translateX(-50%)' }}/>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'#475569', marginTop:2 }}>
                    <span>0</span><span>50 (Silver exp.)</span><span>80 (Silver cheap)</span><span>120</span>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>{hasOanda ? 'Loading…' : 'Connect OANDA'}</div>
            )}
          </div>

          {/* Gold/Oil Ratio */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#f97316', marginBottom:8 }}>🛢 Gold/Oil Ratio</div>
            {sig.goldOilRatio ? (
              <div>
                <div style={{ fontSize:26, fontWeight:900, fontFamily:'monospace',
                  color: sig.goldOilHigh ? '#f59e0b' : '#22c55e' }}>
                  {sig.goldOilRatio}
                </div>
                <div style={{ fontSize:11, marginTop:4, color: sig.goldOilHigh ? '#f59e0b' : '#22c55e' }}>
                  {sig.goldOilHigh
                    ? 'High >30 — Gold elevated vs oil; inflation may not be oil-driven'
                    : 'Normal (<30) — Oil-linked inflation supporting metals'}
                </div>
                {sig.oilGoldCorr !== null && sig.oilGoldCorr !== undefined && (
                  <div style={{ marginTop:8, fontSize:11 }}>
                    <span style={{ color:'var(--text3)' }}>Oil↔Gold r50: </span>
                    <span style={{ fontFamily:'monospace', color: Math.abs(sig.oilGoldCorr) > 0.5 ? '#fbbf24' : 'var(--text3)' }}>
                      {fmtR(sig.oilGoldCorr)}
                    </span>
                  </div>
                )}
                <div style={{ marginTop:6, display:'flex', alignItems:'center', gap:6 }}>
                  {sig.goldDir && (
                    <span style={{ fontSize:10, padding:'2px 6px', borderRadius:3,
                      color:      sig.goldDir === 'rising' ? '#22c55e' : '#ef4444',
                      background: sig.goldDir === 'rising' ? '#22c55e18' : '#ef444418',
                      border:     `1px solid ${sig.goldDir === 'rising' ? '#22c55e33' : '#ef444433'}` }}>
                      Gold {sig.goldDir === 'rising' ? '▲' : '▼'}
                    </span>
                  )}
                  {mkt?.oil && <span style={{ fontSize:10, color:'var(--text3)' }}>
                    Oil {direction(mkt.oil) === 'rising' ? '▲' : '▼'} {fmtPct(pctChange(mkt.oil))}
                  </span>}
                </div>
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>{hasOanda ? 'Loading…' : 'Connect OANDA'}</div>
            )}
          </div>

          {/* Copper → Silver */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#c2855a', marginBottom:8 }}>🔧 Copper (Silver Leading Indicator)</div>
            {sig.copperDir ? (
              <div>
                <SignalBadge
                  bull={sig.copperDir === 'rising'}
                  label={`Copper ${sig.copperDir === 'rising' ? 'Rising ↑' : 'Falling ↓'}`}
                  note={sig.copperDir === 'rising' ? 'Industrial demand rising → bullish Silver' : 'Industrial demand falling → bearish Silver'}
                />
                {sig.copperSilverCorr !== null && sig.copperSilverCorr !== undefined && (
                  <div style={{ marginTop:8 }}>
                    <div style={{ fontSize:10, color:'var(--text3)', marginBottom:3 }}>Copper↔Silver correlation (50 H1)</div>
                    <div style={{ fontSize:13, fontFamily:'monospace', fontWeight:700,
                      color: Math.abs(sig.copperSilverCorr) > 0.5 ? '#22c55e' : 'var(--text3)' }}>
                      r = {fmtR(sig.copperSilverCorr)}
                    </div>
                  </div>
                )}
                {mkt?.copper && <MiniSpark values={mkt.copper.slice(-20)} color="#c2855a"/>}
                <div style={{ fontSize:10, color:'var(--text3)', marginTop:6 }}>
                  Copper is 60% used in industry — tracks global growth &amp; demand for silver (industrial metal)
                </div>
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>
                {hasOanda ? 'Copper (XCU_USD) not available on your OANDA plan' : 'Connect OANDA'}
                <div style={{ fontSize:10, marginTop:4 }}>Tip: Monitor Dr. Copper on TradingView as proxy</div>
              </div>
            )}
          </div>

          {/* Momentum comparison */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--text)', marginBottom:8 }}>📈 Gold vs Silver Momentum</div>
            {(sig.goldPct !== null || sig.silverPct !== null) ? (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {/* Gold bar */}
                {sig.goldPct !== null && (
                  <div>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                      <span style={{ fontSize:11, color:'#fbbf24' }}>XAU/USD</span>
                      <span style={{ fontSize:11, fontFamily:'monospace',
                        color: sig.goldPct >= 0 ? '#22c55e' : '#ef4444' }}>{fmtPct(sig.goldPct)}</span>
                    </div>
                    <div style={{ height:6, background:'#1e293b', borderRadius:3, overflow:'hidden' }}>
                      <div style={{ width:`${Math.min(Math.abs(sig.goldPct) * 10, 100)}%`, height:'100%', borderRadius:3,
                        background: sig.goldPct >= 0 ? '#22c55e' : '#ef4444' }}/>
                    </div>
                  </div>
                )}
                {/* Silver bar */}
                {sig.silverPct !== null && (
                  <div>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                      <span style={{ fontSize:11, color:'#94a3b8' }}>XAG/USD</span>
                      <span style={{ fontSize:11, fontFamily:'monospace',
                        color: sig.silverPct >= 0 ? '#22c55e' : '#ef4444' }}>{fmtPct(sig.silverPct)}</span>
                    </div>
                    <div style={{ height:6, background:'#1e293b', borderRadius:3, overflow:'hidden' }}>
                      <div style={{ width:`${Math.min(Math.abs(sig.silverPct) * 10, 100)}%`, height:'100%', borderRadius:3,
                        background: sig.silverPct >= 0 ? '#22c55e' : '#ef4444' }}/>
                    </div>
                  </div>
                )}
                {sig.goldPct !== null && sig.silverPct !== null && (
                  <div style={{ fontSize:10, color:'var(--text3)', marginTop:4, padding:'4px 8px', background:'var(--bg2)', borderRadius:4 }}>
                    {Math.abs(sig.silverPct) > Math.abs(sig.goldPct)
                      ? `Silver moving ${(Math.abs(sig.silverPct) / Math.abs(sig.goldPct)).toFixed(1)}× faster than Gold — elevated vol`
                      : `Gold leading, Silver lagging — watch for silver catch-up`}
                  </div>
                )}
                <div style={{ display:'flex', gap:6, marginTop:4 }}>
                  {mkt?.gold   && <MiniSpark values={mkt.gold.slice(-20)}   color="#fbbf24"/>}
                  {mkt?.silver && <MiniSpark values={mkt.silver.slice(-20)} color="#94a3b8"/>}
                </div>
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>{hasOanda ? 'Loading…' : 'Connect OANDA'}</div>
            )}
          </div>

        </div>{/* end grid */}

        {/* ── Confluence Table ─────────────────────────────────────────────── */}
        <div style={{ ...card, marginTop:14 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--text)', marginBottom:10 }}>📋 Driver Confluence Summary</div>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
              <thead>
                <tr style={{ borderBottom:'1px solid var(--border)' }}>
                  {['Driver','Signal','Gold Impact','Silver Impact','Strength'].map(h => (
                    <th key={h} style={{ padding:'5px 10px', textAlign:'left', color:'var(--text3)', fontWeight:600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    driver: 'US Dollar (DXY)',
                    signal: sig.dxy ? (sig.dxy === 'falling' ? '▼ Falling' : '▲ Rising') : '—',
                    goldImpact:   sig.dxy === 'falling' ? '✅ Bullish' : sig.dxy === 'rising' ? '❌ Bearish' : '—',
                    silverImpact: sig.dxy === 'falling' ? '✅ Bullish' : sig.dxy === 'rising' ? '❌ Bearish' : '—',
                    strength: sig.dxyGoldCorr !== null ? `r=${fmtR(sig.dxyGoldCorr)}` : '—',
                  },
                  {
                    driver: 'Real Yield Proxy',
                    signal: sig.realYieldSignal ? sig.realYieldSignal.toUpperCase() : '—',
                    goldImpact:   sig.realYieldSignal === 'bullish' ? '✅ Bullish' : sig.realYieldSignal === 'bearish' ? '❌ Bearish' : '—',
                    silverImpact: sig.realYieldSignal === 'bullish' ? '✅ Mild Bullish' : sig.realYieldSignal === 'bearish' ? '❌ Bearish' : '—',
                    strength: sig.bonds10Dir ? `10Y ${sig.bonds10Dir}` : '—',
                  },
                  {
                    driver: 'Yield Curve (10Y-2Y)',
                    signal: sig.yieldCurve !== undefined ? `${sig.yieldCurve > 0 ? '+' : ''}${sig.yieldCurve}` : '—',
                    goldImpact:   sig.yieldCurveInverted ? '✅ Bullish (recession)' : sig.yieldCurveInverted === false ? '➖ Neutral' : '—',
                    silverImpact: sig.yieldCurveInverted ? '✅ Mild Bullish' : '➖ Neutral',
                    strength: sig.yieldCurveInverted ? 'INVERTED ⚡' : sig.yieldCurve !== undefined ? 'Normal' : '—',
                  },
                  {
                    driver: 'COT Gold (52wk pct)',
                    signal: cotSig.gold ? `${cotSig.gold.pct}th pct` : '—',
                    goldImpact:   cotSig.gold ? (cotSig.gold.pct >= 70 ? '⚠ Crowded Long' : cotSig.gold.pct <= 30 ? '✅ Contrarian Bull' : '✅ Bullish') : '—',
                    silverImpact: '➖ Indirect',
                    strength: cotSig.gold ? (cotSig.gold.pct >= 80 || cotSig.gold.pct <= 20 ? 'EXTREME ⚡' : 'Moderate') : '—',
                  },
                  {
                    driver: 'COT Silver (52wk pct)',
                    signal: cotSig.silver ? `${cotSig.silver.pct}th pct` : '—',
                    goldImpact: '➖ Indirect',
                    silverImpact: cotSig.silver ? (cotSig.silver.pct >= 70 ? '⚠ Crowded Long' : cotSig.silver.pct <= 30 ? '✅ Contrarian Bull' : '✅ Bullish') : '—',
                    strength: cotSig.silver ? (cotSig.silver.pct >= 80 || cotSig.silver.pct <= 20 ? 'EXTREME ⚡' : 'Moderate') : '—',
                  },
                  {
                    driver: 'Au/Ag Ratio',
                    signal: sig.auAgRatio ? `${sig.auAgRatio}` : '—',
                    goldImpact:   sig.auAgSignal === 'silver_expensive' ? '✅ Bullish' : '➖ Neutral',
                    silverImpact: sig.auAgSignal === 'silver_cheap' ? '✅ Bullish (cheap vs Gold)' : sig.auAgSignal === 'silver_expensive' ? '❌ Expensive' : '➖ Normal',
                    strength: sig.auAgSignal === 'silver_cheap' ? 'Silver undervalued' : sig.auAgSignal === 'silver_expensive' ? 'Silver overvalued' : 'Normal',
                  },
                  {
                    driver: 'Copper (Industrial)',
                    signal: sig.copperDir ? (sig.copperDir === 'rising' ? '▲ Rising' : '▼ Falling') : '—',
                    goldImpact:   '➖ Weak',
                    silverImpact: sig.copperDir === 'rising' ? '✅ Bullish (demand)' : sig.copperDir === 'falling' ? '❌ Bearish' : '—',
                    strength: sig.copperSilverCorr !== null ? `r=${fmtR(sig.copperSilverCorr)}` : '—',
                  },
                ].map((row, i) => (
                  <tr key={i} style={{ borderBottom:'1px solid var(--border)', background: i%2===0 ? 'transparent' : '#ffffff05' }}>
                    <td style={{ padding:'6px 10px', color:'var(--text)', fontWeight:600 }}>{row.driver}</td>
                    <td style={{ padding:'6px 10px', fontFamily:'monospace', color:'var(--text)' }}>{row.signal}</td>
                    <td style={{ padding:'6px 10px' }}>{row.goldImpact}</td>
                    <td style={{ padding:'6px 10px' }}>{row.silverImpact}</td>
                    <td style={{ padding:'6px 10px', color:'var(--text3)', fontSize:10 }}>{row.strength}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>{/* end scroll */}
    </div>
  );
}

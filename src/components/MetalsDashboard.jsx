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

// ── FRED data — all proxies race simultaneously, first success wins ───────────
const FRED_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  url => `https://thingproxy.freeboard.io/fetch/${url}`,
];

function parseFredCsv(text) {
  if (!text?.includes(',')) return null;
  const series = text.trim().split('\n').slice(1)
    .map(line => { const [date, val] = line.split(','); return { date, val: parseFloat(val) }; })
    .filter(d => Number.isFinite(d.val));
  return series.length >= 2 ? series : null;
}

async function fetchFredSeries(id, days = 120) {
  const start = new Date();
  start.setDate(start.getDate() - days);
  const cosd    = start.toISOString().slice(0, 10);
  const fredUrl = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`;

  const tryProxy = async (makeProxy) => {
    const res  = await fetch(makeProxy(fredUrl), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('bad status');
    const text = await res.text();
    const data = parseFredCsv(text);
    if (!data) throw new Error('no data');
    return data;
  };

  try {
    return await Promise.any(FRED_PROXIES.map(p => tryProxy(p)));
  } catch { return null; }
}

const fetchRealYield     = () => fetchFredSeries('DFII10');
const fetchBreakevenInfl = () => fetchFredSeries('T10YIE');
const fetchCPI           = () => fetchFredSeries('CPIAUCSL', 540);
const fetchYield10       = () => fetchFredSeries('DGS10', 365);
const fetchYield2        = () => fetchFredSeries('DGS2',  365);
// MPMIVMA stores PMI as decimal (0.487 = 48.7%). Normalize then accept only realistic range.
const fetchPMI = () => fetchFredSeries('MPMIVMA', 24).then(d => {
  if (!d?.length) return null;
  const norm = d.map(x => ({ ...x, val: x.val < 5 ? +(x.val * 100).toFixed(1) : +x.val.toFixed(1) }))
                .filter(x => x.val >= 30 && x.val <= 75);
  return norm.length ? norm : null;
});

// Macro cache from GitHub Actions (no proxy, no CORS)
async function fetchMacroCache() {
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/amandeep97/Forex/main/public/macro-data.json?t=' + Date.now(),
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch { return null; }
}

// VIX: FRED VIXCLS proxy (same reliability as CPI/Fed), Yahoo Finance as backup
async function fetchVIX() {
  const fred = await fetchFredSeries('VIXCLS', 60);
  if (fred?.length) return fred;
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=30d',
      { signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const ts     = data.chart?.result?.[0]?.timestamp || [];
    const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const series = ts.map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      val:  closes[i],
    })).filter(d => Number.isFinite(d.val));
    return series.length >= 2 ? series : null;
  } catch { return null; }
}

// ── ICT session H/L from H1 OHLC ─────────────────────────────────────────────
// Sessions in UTC: Asian 00-06, London 07-11, NY 12-16
function computeSessions(h1Candles) {
  if (!h1Candles?.length) return null;
  const byDate = {};
  h1Candles.forEach(c => {
    const d   = new Date(c.t);
    const key = d.toISOString().slice(0, 10);
    const hr  = d.getUTCHours();
    const ses = hr <= 6 ? 'asian' : hr <= 11 ? 'london' : hr <= 16 ? 'ny' : null;
    if (!ses) return;
    if (!byDate[key]) byDate[key] = { asian:[], london:[], ny:[] };
    byDate[key][ses].push(c);
  });
  const dates = Object.keys(byDate).sort().reverse();
  const result = {};
  for (const ses of ['asian', 'london', 'ny']) {
    for (const date of dates) {
      const cs = byDate[date]?.[ses];
      if (cs?.length >= 2) {
        result[ses] = {
          date,
          high:  Math.max(...cs.map(c => c.h)),
          low:   Math.min(...cs.map(c => c.l)),
          open:  cs[0].o,
          close: cs[cs.length - 1].c,
        };
        break;
      }
    }
  }
  return Object.keys(result).length ? result : null;
}

// ── OHLC candles (for RSI / ATR / EMA / key levels) ─────────────────────────
async function fetchOHLC(instrument, granularity, count) {
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
    return (data.candles || []).filter(c => c.complete).map(c => ({
      t: c.time, o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c,
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

function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return +(100 - 100 / (1 + (gains / period) / avgLoss)).toFixed(1);
}

function calcEMA(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return +ema.toFixed(2);
}

function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    ));
  }
  return +(trs.slice(-period).reduce((s, v) => s + v, 0) / period).toFixed(2);
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
  const [mkt, setMkt]         = useState(null);
  const [cot, setCot]         = useState(null);
  const [ry,  setRy]          = useState(null);
  const [bi,  setBi]          = useState(null);
  const [daily,   setDaily]   = useState(null);
  const [weekly,  setWeekly]  = useState(null);
  const [monthly, setMonthly] = useState(null);
  const [h1ohlc,  setH1ohlc] = useState(null);   // H1 OHLC for session ranges
  const [pmi,     setPmi]     = useState(null);
  const [vix,     setVix]     = useState(null);
  const [cpi,     setCpi]     = useState(null);
  const [yield10, setYield10] = useState(null);   // DGS10 — real 10Y yield %
  const [yield2,  setYield2]  = useState(null);   // DGS2  — real 2Y yield %
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const hasOanda = !!getOandaCreds();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Phase 1: OANDA + Yahoo Finance + macro cache (all parallel, no proxies)
      const [gold, silver, dxy, bonds10, bonds2, oil, copper,
             cotGold, cotSilver,
             dGold, dSilver, wGold, wSilver, mGold, mSilver,
             h1Gold, h1Silver,
             vixData, macroCache] = await Promise.all([
        fetchCloses(INSTR.gold,    'H1', 60),
        fetchCloses(INSTR.silver,  'H1', 60),
        fetchCloses(INSTR.dxy,     'H1', 60),
        fetchCloses(INSTR.bonds10, 'H1', 60),
        fetchCloses(INSTR.bonds2,  'H1', 60),
        fetchCloses(INSTR.oil,     'H1', 60),
        fetchCloses(INSTR.copper,  'H1', 60),
        fetchCOTHistory('088691', 54),
        fetchCOTHistory('084691', 54),
        fetchOHLC(INSTR.gold,   'D', 60),
        fetchOHLC(INSTR.silver, 'D', 60),
        fetchOHLC(INSTR.gold,   'W', 5),
        fetchOHLC(INSTR.silver, 'W', 5),
        fetchOHLC(INSTR.gold,   'M', 3),
        fetchOHLC(INSTR.silver, 'M', 3),
        fetchOHLC(INSTR.gold,   'H1', 100),
        fetchOHLC(INSTR.silver, 'H1', 100),
        fetchVIX(),
        fetchMacroCache(),
      ]);

      // Phase 2: cache → FRED proxy fallback
      const [realYield, breakevenInfl, cpiData, pmiData, y10Data, y2Data] = await Promise.all([
        macroCache?.dfii10?.length ? macroCache.dfii10 : fetchRealYield(),
        macroCache?.t10yie?.length ? macroCache.t10yie : fetchBreakevenInfl(),
        macroCache?.cpi?.length    ? macroCache.cpi    : fetchCPI(),
        macroCache?.pmi?.length    ? macroCache.pmi    : fetchPMI(),
        macroCache?.dgs10?.length  ? macroCache.dgs10  : fetchYield10(),
        macroCache?.dgs2?.length   ? macroCache.dgs2   : fetchYield2(),
      ]);

      setMkt({ gold, silver, dxy, bonds10, bonds2, oil, copper });
      setCot({ gold: cotGold, silver: cotSilver });
      setRy(realYield);
      setBi(breakevenInfl);
      setDaily({ gold: dGold, silver: dSilver });
      setWeekly({ gold: wGold, silver: wSilver });
      setMonthly({ gold: mGold, silver: mSilver });
      setH1ohlc({ gold: h1Gold, silver: h1Silver });
      setPmi(pmiData);
      setVix(vixData);
      setCpi(cpiData);
      setYield10(y10Data);
      setYield2(y2Data);
      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
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

    // Yield curve = real 10Y yield % minus real 2Y yield % (from FRED DGS10/DGS2)
    if (yield10?.length && yield2?.length) {
      sig.yieldCurve = +(yield10[yield10.length - 1].val - yield2[yield2.length - 1].val).toFixed(3);
      sig.yieldCurveInverted = sig.yieldCurve < 0;
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

    // Mark the above as the proxy source (used only when FRED is unavailable)
    if (sig.realYieldSignal) sig.realYieldSource = 'proxy';
  }

  // ── Actual real yield from FRED (DFII10) — overrides the proxy when available ─
  if (ry && ry.length >= 5) {
    const latest = ry[ry.length - 1];
    const ref    = ry[Math.max(0, ry.length - 21)];   // ~1 month ago
    const change = +(latest.val - ref.val).toFixed(2);
    sig.realYield       = latest.val;
    sig.realYieldDate   = latest.date;
    sig.realYieldChange = change;
    sig.realYieldDir    = change > 0.02 ? 'rising' : change < -0.02 ? 'falling' : 'flat';
    sig.realYieldSignal = sig.realYieldDir === 'rising'  ? 'bearish'
                        : sig.realYieldDir === 'falling' ? 'bullish'
                        : 'neutral';
    sig.realYieldSource = 'fred';
  }

  // ── Breakeven inflation from FRED (T10YIE) ─────────────────────────────────
  // Rising breakeven = market expects more inflation = gold as inflation hedge = bullish
  if (bi && bi.length >= 5) {
    const latest = bi[bi.length - 1];
    const ref    = bi[Math.max(0, bi.length - 21)];
    const change = +(latest.val - ref.val).toFixed(2);
    sig.breakeven       = latest.val;
    sig.breakevenDate   = latest.date;
    sig.breakevenChange = change;
    sig.breakevenDir    = change > 0.02 ? 'rising' : change < -0.02 ? 'falling' : 'flat';
    sig.breakevenSignal = sig.breakevenDir === 'rising'  ? 'bullish'
                       : sig.breakevenDir === 'falling' ? 'bearish'
                       : 'neutral';
    // Combined context: tell user what's driving real yields
    if (sig.realYieldSource === 'fred') {
      const nominalDir = sig.realYieldDir;
      const biDir      = sig.breakevenDir;
      if      (nominalDir === 'rising'  && biDir === 'rising')  sig.yieldContext = 'inflation_rise';
      else if (nominalDir === 'rising'  && biDir !== 'rising')  sig.yieldContext = 'growth_rise';
      else if (nominalDir === 'falling' && biDir === 'falling') sig.yieldContext = 'deflation';
      else if (nominalDir === 'falling' && biDir === 'rising')  sig.yieldContext = 'stagflation';
      else sig.yieldContext = 'mixed';
    }
  }

  // ── Technical signals from daily candles ──────────────────────────────────
  if (daily) {
    ['gold', 'silver'].forEach(k => {
      const candles = daily[k];
      if (!candles?.length) return;
      const closes = candles.map(c => c.c);
      // RSI(14)
      const rsi = calcRSI(closes);
      sig[`${k}RSI`]       = rsi;
      sig[`${k}RSISignal`] = rsi !== null ? (rsi < 30 ? 'oversold' : rsi > 70 ? 'overbought' : 'neutral') : null;
      // 50 EMA trend filter
      const ema50 = calcEMA(closes, 50);
      sig[`${k}EMA50`]      = ema50;
      sig[`${k}AboveEMA50`] = ema50 !== null ? closes[closes.length - 1] > ema50 : null;
      // ATR(14) — position sizing
      sig[`${k}ATR`] = calcATR(candles);
      // Previous Day H/L (last completed daily candle)
      if (candles.length >= 1) {
        const pd = candles[candles.length - 1];
        sig[`${k}PDH`] = pd.h;
        sig[`${k}PDL`] = pd.l;
      }
    });
  }

  // ── Previous Week H/L from weekly candles ─────────────────────────────────
  if (weekly) {
    ['gold', 'silver'].forEach(k => {
      const candles = weekly[k];
      if (!candles?.length) return;
      // last completed weekly candle = previous week
      const pw = candles[candles.length - 1];
      sig[`${k}PWH`] = pw.h;
      sig[`${k}PWL`] = pw.l;
    });
  }

  // ── PMI signal ─────────────────────────────────────────────────────────────
  if (pmi && pmi.length >= 2) {
    const latest = pmi[pmi.length - 1];
    const prev   = pmi[pmi.length - 2];
    sig.pmi          = latest.val;
    sig.pmiDate      = latest.date;
    sig.pmiPrev      = prev.val;
    sig.pmiExpanding = latest.val >= 50;
    sig.pmiRising    = latest.val > prev.val;
    sig.pmiSignal    = (sig.pmiExpanding && sig.pmiRising)  ? 'bullish'
                     : (sig.pmiExpanding && !sig.pmiRising) ? 'mild_bullish'
                     : (!sig.pmiExpanding && sig.pmiRising) ? 'mild_bearish'
                     : 'bearish';
  }

  // ── VIX — safe haven demand ────────────────────────────────────────────────
  if (vix && vix.length >= 5) {
    const latest = vix[vix.length - 1];
    const prev5  = vix[Math.max(0, vix.length - 6)];
    sig.vix        = latest.val;
    sig.vixDate    = latest.date;
    sig.vixChange  = +(latest.val - prev5.val).toFixed(2);
    sig.vixRising  = sig.vixChange > 0.5;
    sig.vixElevated = latest.val >= 20;
    // Rising or elevated VIX = fear = gold safe haven bid
    sig.vixSignal  = (sig.vixElevated && sig.vixRising)  ? 'strong_bullish'
                   : (sig.vixElevated && !sig.vixRising) ? 'mild_bullish'
                   : (!sig.vixElevated && sig.vixRising) ? 'watch'
                   : 'neutral';
  }

  // ── US CPI — inflation trend ───────────────────────────────────────────────
  if (cpi && cpi.length >= 13) {
    const latest  = cpi[cpi.length - 1];
    const prev1m  = cpi[cpi.length - 2];
    const prev12m = cpi[cpi.length - 13]; // 12 months ago for YoY
    const yoy     = +((latest.val - prev12m.val) / prev12m.val * 100).toFixed(2);
    const mom     = +((latest.val - prev1m.val)  / prev1m.val  * 100).toFixed(3);
    sig.cpi        = latest.val;
    sig.cpiDate    = latest.date;
    sig.cpiYoY     = yoy;
    sig.cpiMoM     = mom;
    sig.cpiHot     = yoy >= 3.0;                     // ≥3% YoY = above Fed target
    sig.cpiRising  = mom > 0;
    // Hot or rising CPI = inflation = gold bullish (inflation hedge)
    sig.cpiSignal  = (sig.cpiHot && sig.cpiRising)   ? 'strong_bullish'
                   : (sig.cpiHot && !sig.cpiRising)  ? 'mild_bullish'
                   : (!sig.cpiHot && sig.cpiRising)  ? 'mild_bullish'
                   : 'neutral';
  }

  // ── HTF weekly/monthly context ────────────────────────────────────────────
  ['gold', 'silver'].forEach(k => {
    const wc = weekly?.[k];
    const mc = monthly?.[k];
    if (wc?.length >= 1) {
      const pw = wc[wc.length - 1];
      sig[`${k}WeeklyClose`] = pw.c;
      sig[`${k}WeeklyHigh`]  = pw.h;
      sig[`${k}WeeklyLow`]   = pw.l;
    }
    if (mc?.length >= 1) {
      const pm = mc[mc.length - 1];
      sig[`${k}MonthlyClose`] = pm.c;
      sig[`${k}MonthlyHigh`]  = pm.h;
      sig[`${k}MonthlyLow`]   = pm.l;
    }
    // Current price from H1 (last close in mkt)
    const mktCloses = mkt?.[k];
    if (mktCloses?.length) {
      const curr = mktCloses[mktCloses.length - 1];
      if (sig[`${k}WeeklyClose`])  sig[`${k}AboveWeekly`]  = curr > sig[`${k}WeeklyClose`];
      if (sig[`${k}MonthlyClose`]) sig[`${k}AboveMonthly`] = curr > sig[`${k}MonthlyClose`];
    }
  });

  // ── ICT Session ranges ────────────────────────────────────────────────────
  const sessions = {
    gold:   computeSessions(h1ohlc?.gold),
    silver: computeSessions(h1ohlc?.silver),
  };

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
    // 6. Breakeven inflation: rising = bullish (inflation hedge demand)
    if (sig.breakevenSignal) factors.push({ label:'Breakeven', bull: sig.breakevenSignal === 'bullish', w: 1 });
    // 7. Copper for silver
    if (metal === 'silver' && sig.copperDir) factors.push({ label:'Copper', bull: sig.copperDir === 'rising', w: 1 });
    // 8. EMA50: above = uptrend
    const aboveEMA = sig[`${metal}AboveEMA50`];
    if (aboveEMA !== null && aboveEMA !== undefined) factors.push({ label:'EMA50', bull: aboveEMA, w: 1 });
    // 9. RSI: oversold = bullish entry zone; overbought = caution (weight 0 when overbought — doesn't penalise bull run)
    const rsiSig = sig[`${metal}RSISignal`];
    if (rsiSig === 'oversold')   factors.push({ label:'RSI', bull: true,  w: 1 });
    if (rsiSig === 'overbought') factors.push({ label:'RSI', bull: false, w: 1 });
    // 10. PMI for silver (industrial demand)
    if (metal === 'silver' && sig.pmi !== undefined) factors.push({ label:'PMI', bull: sig.pmiExpanding, w: 1 });
    // 11. VIX: elevated/rising = safe haven = bullish gold
    if (sig.vixSignal) factors.push({ label:'VIX', bull: sig.vixSignal === 'strong_bullish' || sig.vixSignal === 'mild_bullish', w: 1 });
    // 12. CPI: hot inflation = bullish gold
    if (sig.cpiSignal) factors.push({ label:'CPI', bull: sig.cpiSignal !== 'neutral', w: 1 });
    // 13. HTF: above last weekly close = bullish
    const aboveW = sig[`${metal}AboveWeekly`];
    if (aboveW !== undefined) factors.push({ label:'HTF Weekly', bull: aboveW, w: 1 });
    if (!factors.length) return null;
    const max = factors.reduce((s, f) => s + f.w, 0);
    const score = factors.filter(f => f.bull).reduce((s, f) => s + f.w, 0);
    return { score, max, factors };
  }

  const goldScore   = calcScore('gold');
  const silverScore = calcScore('silver');

  const fmtPct = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const fmtR   = v => v == null ? '—' : v.toFixed(2);

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
                {sig.dxyGoldCorr != null && (
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
            <div style={{ fontSize:12, fontWeight:700, color:'#a78bfa', marginBottom:8 }}>📊 Real Yields &amp; Breakeven Inflation</div>
            <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
              <SignalBadge
                bull={sig.realYieldSignal === 'bullish'}
                label={sig.realYieldSignal
                  ? `Real Yield ${sig.realYieldSource === 'fred' ? '(FRED DFII10)' : 'Proxy'}: ${sig.realYieldSignal.toUpperCase()}`
                  : 'No data'}
                note={sig.realYieldSource === 'fred'
                  ? 'Rising real yield = bonds beat gold = bearish · falling = bullish'
                  : '10Y rising + Gold falling = real yields up = bearish'}
              />
              {sig.realYieldSource === 'fred' && sig.realYield !== undefined && (
                <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderBottom:'1px solid var(--border)' }}>
                  <span style={{ fontSize:11, color:'var(--text3)' }}>
                    Real Yield (DFII10) <span style={{ color:'#484f58' }}>({sig.realYieldDate})</span>
                  </span>
                  <span style={{ fontSize:11, fontFamily:'monospace',
                    color: sig.realYieldDir === 'rising' ? '#ef4444' : sig.realYieldDir === 'falling' ? '#22c55e' : 'var(--text3)' }}>
                    {sig.realYield.toFixed(2)}%
                    <span style={{ marginLeft:4 }}>
                      {sig.realYieldDir === 'rising' ? '▲' : sig.realYieldDir === 'falling' ? '▼' : '■'}
                      {sig.realYieldChange > 0 ? '+' : ''}{sig.realYieldChange} (1mo)
                    </span>
                  </span>
                </div>
              )}
              {/* ── Breakeven Inflation (T10YIE) ── */}
              {sig.breakeven !== undefined && (
                <>
                  <SignalBadge
                    bull={sig.breakevenSignal === 'bullish'}
                    label={`Breakeven Inflation (T10YIE): ${sig.breakevenSignal.toUpperCase()}`}
                    note="Rising inflation expectations = gold as inflation hedge = bullish"
                  />
                  <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderBottom:'1px solid var(--border)' }}>
                    <span style={{ fontSize:11, color:'var(--text3)' }}>
                      10Y Breakeven <span style={{ color:'#484f58' }}>({sig.breakevenDate})</span>
                    </span>
                    <span style={{ fontSize:11, fontFamily:'monospace',
                      color: sig.breakevenDir === 'rising' ? '#22c55e' : sig.breakevenDir === 'falling' ? '#ef4444' : 'var(--text3)' }}>
                      {sig.breakeven.toFixed(2)}%
                      <span style={{ marginLeft:4 }}>
                        {sig.breakevenDir === 'rising' ? '▲' : sig.breakevenDir === 'falling' ? '▼' : '■'}
                        {sig.breakevenChange > 0 ? '+' : ''}{sig.breakevenChange} (1mo)
                      </span>
                    </span>
                  </div>
                  {/* Context: what is driving real yields */}
                  {sig.yieldContext && (
                    <div style={{ fontSize:10, padding:'4px 8px', borderRadius:4, border:'1px solid var(--border)',
                      background:'var(--bg2)', color:'var(--text3)' }}>
                      {sig.yieldContext === 'inflation_rise' && '🔥 Real yields rising on INFLATION — inflation hedge demand + rate headwind → mixed for gold'}
                      {sig.yieldContext === 'growth_rise'   && '📈 Real yields rising on GROWTH — not inflation-driven → bearish gold'}
                      {sig.yieldContext === 'deflation'     && '❄ Real yields falling on DEFLATION — weak growth → mild bullish for gold'}
                      {sig.yieldContext === 'stagflation'   && '⚡ STAGFLATION signal — falling real yields + rising inflation → very bullish gold'}
                      {sig.yieldContext === 'mixed'         && 'Mixed yield signals — monitor direction'}
                    </div>
                  )}
                </>
              )}
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
              {!sig.bonds10Dir && sig.realYieldSource !== 'fred' && (
                <span style={{ fontSize:11, color:'var(--text3)' }}>Connect OANDA for yield data</span>
              )}
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

          {/* Manufacturing PMI */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#34d399', marginBottom:8 }}>🏭 Manufacturing PMI (S&amp;P Global)</div>
            {sig.pmi !== undefined ? (
              <div>
                <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:8 }}>
                  <span style={{ fontSize:28, fontWeight:900, fontFamily:'monospace',
                    color: sig.pmiExpanding ? '#22c55e' : '#ef4444' }}>{sig.pmi.toFixed(1)}</span>
                  <div>
                    <div style={{ fontSize:11, fontWeight:700,
                      color: sig.pmiExpanding ? '#22c55e' : '#ef4444' }}>
                      {sig.pmiExpanding ? '▲ EXPANDING' : '▼ CONTRACTING'}
                      {sig.pmiRising ? ' ↑' : ' ↓'}
                    </div>
                    <div style={{ fontSize:10, color:'var(--text3)' }}>{sig.pmiDate}</div>
                  </div>
                </div>
                {/* 50-line gauge */}
                <div style={{ marginBottom:8 }}>
                  <div style={{ height:8, background:'#1e293b', borderRadius:4, position:'relative', overflow:'hidden' }}>
                    <div style={{ position:'absolute', left:'50%', width:2, height:'100%', background:'#475569' }}/>
                    <div style={{ position:'absolute', left:`${Math.min(Math.max((sig.pmi - 30) / 50 * 100, 2), 97)}%`,
                      top:0, width:3, height:'100%', borderRadius:2, transform:'translateX(-50%)',
                      background: sig.pmiExpanding ? '#22c55e' : '#ef4444' }}/>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'#475569', marginTop:2 }}>
                    <span>30 (Deep Contraction)</span><span>50 (Neutral)</span><span>65+ (Boom)</span>
                  </div>
                </div>
                <SignalBadge
                  bull={sig.pmiSignal === 'bullish' || sig.pmiSignal === 'mild_bullish'}
                  label={`PMI Impact: ${sig.pmiSignal === 'bullish' ? 'Strong Bull Silver' : sig.pmiSignal === 'mild_bullish' ? 'Mild Bull Silver' : sig.pmiSignal === 'mild_bearish' ? 'Mild Bear' : 'Bearish Silver'}`}
                  note="PMI drives silver industrial demand — less impact on gold"
                />
                {sig.pmiPrev !== undefined && (
                  <div style={{ fontSize:10, color:'var(--text3)', marginTop:6 }}>
                    Previous: {sig.pmiPrev.toFixed(1)} → {sig.pmi.toFixed(1)}
                    {' '}({sig.pmiRising ? '+' : ''}{(sig.pmi - sig.pmiPrev).toFixed(1)} MoM)
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>
                Loading PMI from FRED…
                <div style={{ fontSize:10, marginTop:4 }}>Series: MPMIVMA (S&amp;P Global US Manufacturing PMI)</div>
              </div>
            )}
          </div>

          {/* Technical Indicators — RSI, EMA50, ATR */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#818cf8', marginBottom:8 }}>📐 Technical Indicators (Daily)</div>
            {(sig.goldRSI !== null || sig.silverRSI !== null) ? (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {[
                  { label:'XAU/USD', color:'#fbbf24', rsi: sig.goldRSI,   rsiSig: sig.goldRSISignal,   ema: sig.goldEMA50,   above: sig.goldAboveEMA50,   atr: sig.goldATR },
                  { label:'XAG/USD', color:'#94a3b8', rsi: sig.silverRSI, rsiSig: sig.silverRSISignal, ema: sig.silverEMA50, above: sig.silverAboveEMA50, atr: sig.silverATR },
                ].map(({ label, color, rsi, rsiSig, ema, above, atr }) => (
                  <div key={label} style={{ padding:'8px', background:'var(--bg2)', borderRadius:6, border:'1px solid var(--border)' }}>
                    <div style={{ fontSize:11, fontWeight:700, color, marginBottom:6 }}>{label}</div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
                      {/* RSI */}
                      {rsi !== null && (
                        <div style={{ flex:1, minWidth:80 }}>
                          <div style={{ fontSize:9, color:'var(--text3)', marginBottom:2 }}>RSI(14)</div>
                          <div style={{ fontSize:16, fontFamily:'monospace', fontWeight:700,
                            color: rsiSig === 'oversold' ? '#22c55e' : rsiSig === 'overbought' ? '#ef4444' : '#f59e0b' }}>
                            {rsi}
                          </div>
                          <div style={{ fontSize:9, fontWeight:700,
                            color: rsiSig === 'oversold' ? '#22c55e' : rsiSig === 'overbought' ? '#ef4444' : '#64748b' }}>
                            {rsiSig === 'oversold' ? '⚡ OVERSOLD — Buy zone' : rsiSig === 'overbought' ? '⚠ OVERBOUGHT' : 'Neutral'}
                          </div>
                          {/* RSI bar */}
                          <div style={{ height:4, background:'#1e293b', borderRadius:2, marginTop:4, position:'relative', overflow:'hidden' }}>
                            <div style={{ position:'absolute', left:'30%', width:'40%', height:'100%', background:'#22c55e11' }}/>
                            <div style={{ position:'absolute', left:`${Math.min(rsi, 97)}%`, top:0, width:3, height:'100%',
                              background: rsiSig === 'oversold' ? '#22c55e' : rsiSig === 'overbought' ? '#ef4444' : '#f59e0b',
                              transform:'translateX(-50%)' }}/>
                          </div>
                        </div>
                      )}
                      {/* EMA50 */}
                      {above !== null && above !== undefined && (
                        <div style={{ flex:1, minWidth:80 }}>
                          <div style={{ fontSize:9, color:'var(--text3)', marginBottom:2 }}>50 EMA Trend</div>
                          <div style={{ fontSize:13, fontWeight:700,
                            color: above ? '#22c55e' : '#ef4444' }}>
                            {above ? '▲ Above' : '▼ Below'}
                          </div>
                          {ema && <div style={{ fontSize:9, fontFamily:'monospace', color:'#475569' }}>EMA: {ema.toLocaleString()}</div>}
                          <div style={{ fontSize:9, color: above ? '#22c55e' : '#ef4444', marginTop:2 }}>
                            {above ? 'Uptrend — favour longs' : 'Downtrend — favour shorts'}
                          </div>
                        </div>
                      )}
                      {/* ATR */}
                      {atr !== null && atr !== undefined && (
                        <div style={{ flex:1, minWidth:80 }}>
                          <div style={{ fontSize:9, color:'var(--text3)', marginBottom:2 }}>ATR(14) Daily</div>
                          <div style={{ fontSize:16, fontFamily:'monospace', fontWeight:700, color:'#a78bfa' }}>
                            {atr.toLocaleString()}
                          </div>
                          <div style={{ fontSize:9, color:'var(--text3)' }}>
                            Typical daily range · use for SL sizing
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>{hasOanda ? 'Loading daily candles…' : 'Connect OANDA'}</div>
            )}
          </div>

          {/* ICT Key Levels — Previous Week & Day H/L */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#f472b6', marginBottom:8 }}>🎯 ICT Key Levels (Liquidity)</div>
            <div style={{ fontSize:10, color:'var(--text3)', marginBottom:8 }}>
              Previous Week & Day Highs/Lows — price sweeps these before reversing (stop hunts)
            </div>
            {(sig.goldPWH || sig.silverPWH) ? (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {[
                  { label:'XAU/USD', color:'#fbbf24', pwh: sig.goldPWH,   pwl: sig.goldPWL,   pdh: sig.goldPDH,   pdl: sig.goldPDL },
                  { label:'XAG/USD', color:'#94a3b8', pwh: sig.silverPWH, pwl: sig.silverPWL, pdh: sig.silverPDH, pdl: sig.silverPDL },
                ].map(({ label, color, pwh, pwl, pdh, pdl }) => (
                  <div key={label} style={{ padding:'8px', background:'var(--bg2)', borderRadius:6, border:'1px solid var(--border)' }}>
                    <div style={{ fontSize:11, fontWeight:700, color, marginBottom:6 }}>{label}</div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                      {pwh && <div style={{ padding:'4px 8px', borderRadius:4, background:'#22c55e0d', border:'1px solid #22c55e22' }}>
                        <div style={{ fontSize:9, color:'#22c55e', fontWeight:700 }}>PW HIGH</div>
                        <div style={{ fontSize:13, fontFamily:'monospace', color:'#22c55e', fontWeight:700 }}>{pwh.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                        <div style={{ fontSize:9, color:'var(--text3)' }}>Sell-side liquidity above</div>
                      </div>}
                      {pwl && <div style={{ padding:'4px 8px', borderRadius:4, background:'#ef44440d', border:'1px solid #ef444422' }}>
                        <div style={{ fontSize:9, color:'#ef4444', fontWeight:700 }}>PW LOW</div>
                        <div style={{ fontSize:13, fontFamily:'monospace', color:'#ef4444', fontWeight:700 }}>{pwl.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                        <div style={{ fontSize:9, color:'var(--text3)' }}>Buy-side liquidity below</div>
                      </div>}
                      {pdh && <div style={{ padding:'4px 8px', borderRadius:4, background:'#22c55e07', border:'1px solid #22c55e18' }}>
                        <div style={{ fontSize:9, color:'#86efac', fontWeight:700 }}>PD HIGH</div>
                        <div style={{ fontSize:13, fontFamily:'monospace', color:'#86efac', fontWeight:700 }}>{pdh.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                      </div>}
                      {pdl && <div style={{ padding:'4px 8px', borderRadius:4, background:'#ef444407', border:'1px solid #ef444418' }}>
                        <div style={{ fontSize:9, color:'#fca5a5', fontWeight:700 }}>PD LOW</div>
                        <div style={{ fontSize:13, fontFamily:'monospace', color:'#fca5a5', fontWeight:700 }}>{pdl.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                      </div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>{hasOanda ? 'Loading weekly candles…' : 'Connect OANDA'}</div>
            )}
          </div>

          {/* VIX — Safe Haven Demand */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#fb923c', marginBottom:8 }}>😰 VIX — Fear &amp; Safe Haven</div>
            {sig.vix !== undefined ? (
              <div>
                <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:8 }}>
                  <span style={{ fontSize:28, fontWeight:900, fontFamily:'monospace',
                    color: sig.vixElevated ? '#ef4444' : sig.vixRising ? '#f59e0b' : '#22c55e' }}>
                    {sig.vix.toFixed(1)}
                  </span>
                  <div>
                    <div style={{ fontSize:11, fontWeight:700,
                      color: sig.vixElevated ? '#ef4444' : '#94a3b8' }}>
                      {sig.vixElevated ? '⚡ ELEVATED ≥20' : 'Low <20'}
                      {sig.vixRising ? ' ▲' : ' ▼'}
                    </div>
                    <div style={{ fontSize:10, color:'var(--text3)' }}>{sig.vixDate}</div>
                  </div>
                </div>
                {/* VIX gauge 0-50 */}
                <div style={{ height:8, background:'#1e293b', borderRadius:4, position:'relative', overflow:'hidden', marginBottom:6 }}>
                  <div style={{ position:'absolute', left:'40%', width:2, height:'100%', background:'#475569' }}/>
                  <div style={{ position:'absolute', left:`${Math.min((sig.vix / 50) * 100, 97)}%`,
                    top:0, width:3, height:'100%', borderRadius:2, transform:'translateX(-50%)',
                    background: sig.vixElevated ? '#ef4444' : '#22c55e' }}/>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'#475569', marginBottom:8 }}>
                  <span>0 (Complacency)</span><span>20 (Fear)</span><span>50+ (Panic)</span>
                </div>
                <SignalBadge
                  bull={sig.vixSignal === 'strong_bullish' || sig.vixSignal === 'mild_bullish'}
                  label={sig.vixSignal === 'strong_bullish' ? 'High Fear — Strong Gold Bid'
                        : sig.vixSignal === 'mild_bullish'  ? 'Elevated Fear — Gold Supported'
                        : sig.vixSignal === 'watch'         ? 'VIX Rising — Watch for Gold Bid'
                        : 'Low Volatility — Risk-On Environment'}
                  note="VIX ≥20 + rising = market fear = safe haven demand for gold"
                />
                <div style={{ fontSize:10, color:'var(--text3)', marginTop:6 }}>
                  5-day change: <span style={{ color: sig.vixChange > 0 ? '#ef4444' : '#22c55e', fontFamily:'monospace' }}>
                    {sig.vixChange > 0 ? '+' : ''}{sig.vixChange}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>Loading VIX…</div>
            )}
          </div>

          {/* US CPI — Inflation Trend */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#f43f5e', marginBottom:8 }}>📈 US CPI — Inflation Trend</div>
            {sig.cpi !== undefined ? (
              <div>
                <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:8 }}>
                  <span style={{ fontSize:22, fontWeight:900, fontFamily:'monospace',
                    color: sig.cpiHot ? '#ef4444' : '#22c55e' }}>
                    {sig.cpiYoY.toFixed(2)}% YoY
                  </span>
                  <span style={{ fontSize:11, color: sig.cpiHot ? '#ef4444' : '#22c55e', fontWeight:700 }}>
                    {sig.cpiHot ? '🔥 HOT' : '✓ Near target'}
                  </span>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{ fontSize:11, color:'var(--text3)' }}>MoM Change</span>
                    <span style={{ fontSize:11, fontFamily:'monospace',
                      color: sig.cpiMoM > 0 ? '#ef4444' : '#22c55e' }}>
                      {sig.cpiMoM > 0 ? '+' : ''}{(sig.cpiMoM * 100).toFixed(2)}% ({sig.cpiDate})
                    </span>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{ fontSize:11, color:'var(--text3)' }}>CPI Index Level</span>
                    <span style={{ fontSize:11, fontFamily:'monospace', color:'var(--text)' }}>{sig.cpi.toFixed(1)}</span>
                  </div>
                </div>
                <div style={{ marginTop:8 }}>
                  <SignalBadge
                    bull={sig.cpiSignal !== 'neutral'}
                    label={sig.cpiSignal === 'strong_bullish' ? 'Hot + Rising CPI — Strong Gold Inflation Hedge'
                          : sig.cpiSignal === 'mild_bullish'  ? 'Inflation Persisting — Gold Supported'
                          : 'CPI Near Target — Neutral for Gold'}
                    note="High inflation → gold as inflation hedge → bullish · Cooling CPI → bearish"
                  />
                </div>
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>Loading CPI from FRED (CPIAUCSL)…</div>
            )}
          </div>

          {/* HTF Weekly/Monthly Bias */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#22d3ee', marginBottom:8 }}>📊 HTF Bias (Weekly &amp; Monthly)</div>
            <div style={{ fontSize:10, color:'var(--text3)', marginBottom:8 }}>
              ICT rule: align entries with HTF direction. Above weekly close = bullish bias.
            </div>
            {(sig.goldWeeklyClose || sig.goldMonthlyClose) ? (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {[
                  { label:'XAU/USD', color:'#fbbf24',
                    wClose: sig.goldWeeklyClose,  wHigh: sig.goldWeeklyHigh,  wLow: sig.goldWeeklyLow,  aboveW: sig.goldAboveWeekly,
                    mClose: sig.goldMonthlyClose, mHigh: sig.goldMonthlyHigh, mLow: sig.goldMonthlyLow, aboveM: sig.goldAboveMonthly },
                  { label:'XAG/USD', color:'#94a3b8',
                    wClose: sig.silverWeeklyClose,  wHigh: sig.silverWeeklyHigh,  wLow: sig.silverWeeklyLow,  aboveW: sig.silverAboveWeekly,
                    mClose: sig.silverMonthlyClose, mHigh: sig.silverMonthlyHigh, mLow: sig.silverMonthlyLow, aboveM: sig.silverAboveMonthly },
                ].map(({ label, color, wClose, wHigh, wLow, aboveW, mClose, mHigh, mLow, aboveM }) => (
                  <div key={label} style={{ padding:'8px', background:'var(--bg2)', borderRadius:6, border:'1px solid var(--border)' }}>
                    <div style={{ fontSize:11, fontWeight:700, color, marginBottom:6 }}>
                      {label}
                      {aboveW !== undefined && <span style={{ marginLeft:8, fontSize:10, padding:'1px 5px', borderRadius:3, fontWeight:700,
                        color: aboveW ? '#22c55e' : '#ef4444', background: aboveW ? '#22c55e14' : '#ef444414' }}>
                        {aboveW ? '▲ Bull Bias' : '▼ Bear Bias'}
                      </span>}
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                      {wClose && <div style={{ padding:'4px 8px', borderRadius:4, background:'var(--card)', border:'1px solid var(--border)' }}>
                        <div style={{ fontSize:9, color:'#22d3ee', fontWeight:700 }}>WEEKLY</div>
                        <div style={{ fontSize:11, fontFamily:'monospace', color: aboveW ? '#22c55e' : '#ef4444' }}>
                          {aboveW ? '▲ Above ' : '▼ Below '}{wClose?.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}
                        </div>
                        <div style={{ fontSize:9, color:'var(--text3)' }}>H: {wHigh?.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})} · L: {wLow?.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                      </div>}
                      {mClose && <div style={{ padding:'4px 8px', borderRadius:4, background:'var(--card)', border:'1px solid var(--border)' }}>
                        <div style={{ fontSize:9, color:'#f59e0b', fontWeight:700 }}>MONTHLY</div>
                        <div style={{ fontSize:11, fontFamily:'monospace', color: aboveM ? '#22c55e' : '#ef4444' }}>
                          {aboveM ? '▲ Above ' : '▼ Below '}{mClose?.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}
                        </div>
                        <div style={{ fontSize:9, color:'var(--text3)' }}>H: {mHigh?.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})} · L: {mLow?.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                      </div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>{hasOanda ? 'Loading HTF candles…' : 'Connect OANDA'}</div>
            )}
          </div>

          {/* ICT Session Ranges */}
          <div style={card}>
            <div style={{ fontSize:12, fontWeight:700, color:'#a3e635', marginBottom:8 }}>⏱ ICT Session Ranges</div>
            <div style={{ fontSize:10, color:'var(--text3)', marginBottom:8 }}>
              AMD cycle: Asian sets range → London manipulates (sweeps H/L) → NY delivers true move
            </div>
            {(sessions.gold || sessions.silver) ? (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {[
                  { label:'XAU/USD', color:'#fbbf24', ses: sessions.gold },
                  { label:'XAG/USD', color:'#94a3b8', ses: sessions.silver },
                ].map(({ label, color, ses }) => ses ? (
                  <div key={label}>
                    <div style={{ fontSize:11, fontWeight:700, color, marginBottom:4 }}>{label}</div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6 }}>
                      {[
                        { name:'Asian',  sesKey:'asian',  c:'#60a5fa' },
                        { name:'London', sesKey:'london', c:'#34d399' },
                        { name:'NY',     sesKey:'ny',     c:'#f59e0b' },
                      ].map(({ name, sesKey, c }) => {
                        const s = ses[sesKey];
                        return s ? (
                          <div key={sesKey} style={{ padding:'5px 7px', borderRadius:5, background:'var(--bg2)', border:`1px solid ${c}33` }}>
                            <div style={{ fontSize:9, fontWeight:700, color: c, marginBottom:3 }}>{name}</div>
                            <div style={{ fontSize:10, fontFamily:'monospace', color:'#22c55e', fontWeight:600 }}>
                              H {s.high.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}
                            </div>
                            <div style={{ fontSize:10, fontFamily:'monospace', color:'#ef4444', fontWeight:600 }}>
                              L {s.low.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}
                            </div>
                            <div style={{ fontSize:9, color:'var(--text3)', marginTop:2 }}>
                              Range: {(s.high - s.low).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}
                            </div>
                          </div>
                        ) : null;
                      })}
                    </div>
                  </div>
                ) : null)}
              </div>
            ) : (
              <div style={{ color:'var(--text3)', fontSize:11 }}>{hasOanda ? 'Loading session candles…' : 'Connect OANDA'}</div>
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
                    strength: sig.dxyGoldCorr != null ? `r=${fmtR(sig.dxyGoldCorr)}` : '—',
                  },
                  {
                    driver: sig.realYieldSource === 'fred' ? 'Real Yield (DFII10)' : 'Real Yield Proxy',
                    signal: sig.realYieldSource === 'fred' && sig.realYield !== undefined
                      ? `${sig.realYield.toFixed(2)}% (${sig.realYieldSignal.toUpperCase()})`
                      : sig.realYieldSignal ? sig.realYieldSignal.toUpperCase() : '—',
                    goldImpact:   sig.realYieldSignal === 'bullish' ? '✅ Bullish' : sig.realYieldSignal === 'bearish' ? '❌ Bearish' : '—',
                    silverImpact: sig.realYieldSignal === 'bullish' ? '✅ Mild Bullish' : sig.realYieldSignal === 'bearish' ? '❌ Bearish' : '—',
                    strength: sig.realYieldSource === 'fred' ? `${sig.realYieldChange > 0 ? '+' : ''}${sig.realYieldChange} (1mo)` : sig.bonds10Dir ? `10Y ${sig.bonds10Dir}` : '—',
                  },
                  {
                    driver: 'Breakeven Inflation (T10YIE)',
                    signal: sig.breakeven !== undefined
                      ? `${sig.breakeven.toFixed(2)}% (${sig.breakevenSignal.toUpperCase()})`
                      : '—',
                    goldImpact:   sig.breakevenSignal === 'bullish' ? '✅ Bullish (inflation hedge)' : sig.breakevenSignal === 'bearish' ? '❌ Bearish' : '—',
                    silverImpact: sig.breakevenSignal === 'bullish' ? '✅ Bullish' : sig.breakevenSignal === 'bearish' ? '❌ Bearish' : '—',
                    strength: sig.breakeven !== undefined ? `${sig.breakevenChange > 0 ? '+' : ''}${sig.breakevenChange} (1mo)` : '—',
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
                  {
                    driver: 'PMI Manufacturing',
                    signal: sig.pmi !== undefined ? `${sig.pmi.toFixed(1)} (${sig.pmiExpanding ? 'Expanding' : 'Contracting'})` : '—',
                    goldImpact:   '➖ Indirect',
                    silverImpact: sig.pmiSignal === 'bullish' ? '✅ Strong Bullish' : sig.pmiSignal === 'mild_bullish' ? '✅ Mild Bullish' : sig.pmiSignal === 'mild_bearish' ? '❌ Mild Bearish' : sig.pmiSignal === 'bearish' ? '❌ Bearish' : '—',
                    strength: sig.pmi !== undefined ? (sig.pmiRising ? '↑ Rising' : '↓ Falling') : '—',
                  },
                  {
                    driver: 'RSI(14) Gold Daily',
                    signal: sig.goldRSI !== null ? `${sig.goldRSI} — ${sig.goldRSISignal}` : '—',
                    goldImpact:   sig.goldRSISignal === 'oversold' ? '✅ Buy zone' : sig.goldRSISignal === 'overbought' ? '⚠ Caution' : '➖ Neutral' ,
                    silverImpact: '➖ —',
                    strength: '—',
                  },
                  {
                    driver: 'RSI(14) Silver Daily',
                    signal: sig.silverRSI !== null ? `${sig.silverRSI} — ${sig.silverRSISignal}` : '—',
                    goldImpact:   '➖ —',
                    silverImpact: sig.silverRSISignal === 'oversold' ? '✅ Buy zone' : sig.silverRSISignal === 'overbought' ? '⚠ Caution' : '➖ Neutral',
                    strength: '—',
                  },
                  {
                    driver: '50 EMA Trend (Daily)',
                    signal: sig.goldAboveEMA50 !== null && sig.goldAboveEMA50 !== undefined ? `Gold: ${sig.goldAboveEMA50 ? '▲ Above' : '▼ Below'} · Silver: ${sig.silverAboveEMA50 ? '▲ Above' : '▼ Below'}` : '—',
                    goldImpact:   sig.goldAboveEMA50 ? '✅ Uptrend' : sig.goldAboveEMA50 === false ? '❌ Downtrend' : '—',
                    silverImpact: sig.silverAboveEMA50 ? '✅ Uptrend' : sig.silverAboveEMA50 === false ? '❌ Downtrend' : '—',
                    strength: 'Trend filter',
                  },
                  {
                    driver: 'VIX (CBOE Fear Index)',
                    signal: sig.vix !== undefined ? `${sig.vix.toFixed(1)} (${sig.vixElevated ? 'Elevated' : 'Low'})` : '—',
                    goldImpact:   sig.vix === undefined ? '—' : sig.vixSignal === 'strong_bullish' ? '✅ Strong Bullish' : sig.vixSignal === 'mild_bullish' ? '✅ Bullish' : sig.vixSignal === 'watch' ? '👀 Watch' : '➖ Neutral',
                    silverImpact: sig.vix === undefined ? '—' : sig.vixSignal === 'strong_bullish' ? '✅ Mild Bullish' : sig.vixSignal === 'mild_bullish' ? '✅ Mild Bullish' : '➖ Neutral',
                    strength: sig.vix !== undefined ? `5d: ${sig.vixChange > 0 ? '+' : ''}${sig.vixChange}` : '—',
                  },
                  {
                    driver: 'US CPI Inflation (YoY)',
                    signal: sig.cpiYoY !== undefined ? `${sig.cpiYoY.toFixed(2)}% (${sig.cpiHot ? 'Hot' : 'Cooling'})` : '—',
                    goldImpact:   sig.cpiYoY === undefined ? '—' : sig.cpiSignal === 'strong_bullish' ? '✅ Strong Bullish' : sig.cpiSignal === 'mild_bullish' ? '✅ Bullish' : '➖ Neutral',
                    silverImpact: sig.cpiYoY === undefined ? '—' : sig.cpiSignal !== 'neutral' ? '✅ Bullish' : '➖ Neutral',
                    strength: sig.cpiMoM !== undefined ? `MoM: ${sig.cpiMoM > 0 ? '+' : ''}${(sig.cpiMoM * 100).toFixed(2)}%` : '—',
                  },
                  {
                    driver: 'HTF Bias (Weekly Close)',
                    signal: sig.goldAboveWeekly !== undefined ? `Gold: ${sig.goldAboveWeekly ? '▲' : '▼'} · Silver: ${sig.silverAboveWeekly ? '▲' : '▼'}` : '—',
                    goldImpact:   sig.goldAboveWeekly ? '✅ Bullish Bias' : sig.goldAboveWeekly === false ? '❌ Bearish Bias' : '—',
                    silverImpact: sig.silverAboveWeekly ? '✅ Bullish Bias' : sig.silverAboveWeekly === false ? '❌ Bearish Bias' : '—',
                    strength: 'ICT HTF alignment',
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

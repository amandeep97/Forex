import { useState, useEffect, useCallback } from 'react';

/* ─────────────────────── CONSTANTS ─────────────────────────────── */
const INDICES = {
  spx:     { oanda: 'SPX500_USD', name: 'S&P 500',      short: 'SPX', color: '#22c55e', cot: '13874A' },
  nq:      { oanda: 'NAS100_USD', name: 'Nasdaq 100',   short: 'NQ',  color: '#3b82f6', cot: '209742' },
  dow:     { oanda: 'US30_USD',   name: 'Dow Jones',    short: 'DJI', color: '#f59e0b', cot: '124603' },
  russell: { oanda: 'US2000_USD', name: 'Russell 2000', short: 'RUT', color: '#a78bfa', cot: '239742' },
};
const INDEX_KEYS = ['spx', 'nq', 'dow', 'russell'];

const FOMC_DATES = [
  '2026-01-29','2026-03-19','2026-05-07',
  '2026-06-18','2026-07-30','2026-09-18',
  '2026-10-29','2026-12-10',
];

const FRED_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  url => `https://thingproxy.freeboard.io/fetch/${url}`,
];

/* ─────────────────────── HELPERS ────────────────────────────────── */
function getOanda() {
  return {
    key:  localStorage.getItem('oanda_key')  || '',
    env:  localStorage.getItem('oanda_env')  || 'practice',
  };
}

function pctRank(arr) {
  if (!arr || arr.length < 2) return null;
  const last = arr[arr.length - 1];
  const sorted = [...arr].sort((a, b) => a - b);
  const below = sorted.filter(v => v < last).length;
  return Math.round((below / (sorted.length - 1)) * 100);
}

function fmtPct(v, dec = 2) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(dec) + '%';
}

function fmtPrice(v) {
  if (v == null) return '—';
  return v >= 1000 ? v.toFixed(0) : v.toFixed(2);
}

/* ─────────────────────── TECHNICAL ──────────────────────────────── */
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

function detectMarketStructure(candles) {
  if (!candles || candles.length < 14) return null;
  const slice = candles.slice(-20);
  const ph = [], pl = [];
  for (let i = 2; i < slice.length - 2; i++) {
    if (slice[i].h > slice[i-1].h && slice[i].h > slice[i-2].h && slice[i].h > slice[i+1].h && slice[i].h > slice[i+2].h) ph.push(slice[i].h);
    if (slice[i].l < slice[i-1].l && slice[i].l < slice[i-2].l && slice[i].l < slice[i+1].l && slice[i].l < slice[i+2].l) pl.push(slice[i].l);
  }
  if (ph.length >= 2 && pl.length >= 2) {
    if (ph[ph.length-1] > ph[ph.length-2] && pl[pl.length-1] > pl[pl.length-2]) return 'bullish';
    if (ph[ph.length-1] < ph[ph.length-2] && pl[pl.length-1] < pl[pl.length-2]) return 'bearish';
  }
  const half = Math.floor(slice.length / 2);
  const fH = Math.max(...slice.slice(0, half).map(c => c.h));
  const lH = Math.max(...slice.slice(half).map(c => c.h));
  const fL = Math.min(...slice.slice(0, half).map(c => c.l));
  const lL = Math.min(...slice.slice(half).map(c => c.l));
  if (lH > fH && lL > fL) return 'bullish';
  if (lH < fH && lL < fL) return 'bearish';
  return 'ranging';
}

function detectFVG(candles) {
  if (!candles || candles.length < 3) return null;
  for (let i = candles.length - 1; i >= 2; i--) {
    if (candles[i].l > candles[i-2].h)
      return { type: 'bullish', top: +candles[i].l.toFixed(2), bottom: +candles[i-2].h.toFixed(2) };
    if (candles[i].h < candles[i-2].l)
      return { type: 'bearish', top: +candles[i-2].l.toFixed(2), bottom: +candles[i].h.toFixed(2) };
  }
  return null;
}

function detectLiquiditySweep(candles) {
  if (!candles || candles.length < 2) return null;
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  if (curr.l < prev.l && curr.c > prev.l) return { type: 'bullish', level: +prev.l.toFixed(2), desc: 'Swept PDL — bought liquidity (bullish reversal signal)' };
  if (curr.h > prev.h && curr.c < prev.h) return { type: 'bearish', level: +prev.h.toFixed(2), desc: 'Swept PDH — sold liquidity (bearish reversal signal)' };
  return null;
}

function detectSMT(closesA, closesB, lookback = 5) {
  if (!closesA || !closesB || closesA.length < lookback * 2 || closesB.length < lookback * 2) return null;
  const aCurr = closesA.slice(-lookback), aPrev = closesA.slice(-lookback*2, -lookback);
  const bCurr = closesB.slice(-lookback), bPrev = closesB.slice(-lookback*2, -lookback);
  const aCH = Math.max(...aCurr), aPH = Math.max(...aPrev);
  const aCL = Math.min(...aCurr), aPL = Math.min(...aPrev);
  const bCH = Math.max(...bCurr), bPH = Math.max(...bPrev);
  const bCL = Math.min(...bCurr), bPL = Math.min(...bPrev);
  if (aCH > aPH && bCH <= bPH) return { type: 'bearish', who: 'A new HH, B failed — smart money warning' };
  if (bCH > bPH && aCH <= aPH) return { type: 'bearish', who: 'B new HH, A failed — smart money warning' };
  if (aCL < aPL && bCL >= bPL) return { type: 'bullish', who: 'A new LL, B held — potential reversal' };
  if (bCL < bPL && aCL >= aPL) return { type: 'bullish', who: 'B new LL, A held — potential reversal' };
  return null;
}

function computeSessions(h1Candles) {
  if (!h1Candles?.length) return null;
  const byDate = {};
  h1Candles.forEach(c => {
    const dt = new Date(c.t);
    const date = dt.toISOString().slice(0, 10);
    const h = dt.getUTCHours();
    const s = h < 7 ? 'asian' : h < 13 ? 'london' : h < 21 ? 'ny' : null;
    if (!s) return;
    if (!byDate[date]) byDate[date] = {};
    if (!byDate[date][s]) byDate[date][s] = { highs: [], lows: [], open: c.o };
    byDate[date][s].highs.push(c.h);
    byDate[date][s].lows.push(c.l);
    byDate[date][s].close = c.c;
  });
  return Object.entries(byDate).sort(([a],[b]) => a.localeCompare(b)).slice(-2)
    .map(([date, d]) => ({
      date,
      asian:  d.asian  ? { high: Math.max(...d.asian.highs),  low: Math.min(...d.asian.lows),  open: d.asian.open,  close: d.asian.close  } : null,
      london: d.london ? { high: Math.max(...d.london.highs), low: Math.min(...d.london.lows), open: d.london.open, close: d.london.close } : null,
      ny:     d.ny     ? { high: Math.max(...d.ny.highs),     low: Math.min(...d.ny.lows),     open: d.ny.open,     close: d.ny.close     } : null,
    }));
}

/* ─────────────────────── TIME INTELLIGENCE ─────────────────────── */
function getKillZone() {
  const now = new Date();
  const t = now.getUTCHours() + now.getUTCMinutes() / 60;
  const zones = [
    { start: 2,    end: 5,    name: 'Asian Kill Zone',   color: '#a78bfa', desc: 'Liquidity grab — watch for Asian range expansion before London' },
    { start: 7,    end: 9,    name: 'London Open KZ',    color: '#3b82f6', desc: 'Highest probability reversals — institutions enter here' },
    { start: 9.5,  end: 11.5, name: 'NY Open KZ',        color: '#22c55e', desc: 'US market opens — momentum continuation or sharp reversal' },
    { start: 14,   end: 16,   name: 'NY PM / London Close', color: '#f59e0b', desc: 'Position squaring — fade exhaustion moves here' },
  ];
  for (const z of zones) {
    if (t >= z.start && t < z.end) {
      const remaining = z.end - t;
      const rh = Math.floor(remaining), rm = Math.round((remaining % 1) * 60);
      return { ...z, active: true, remainStr: `${rh}h ${rm}m left` };
    }
  }
  const upcoming = zones.map(z => ({ ...z, wait: z.start > t ? z.start - t : z.start + 24 - t }))
    .sort((a, b) => a.wait - b.wait)[0];
  const h = Math.floor(upcoming.wait), m = Math.round((upcoming.wait % 1) * 60);
  return { ...upcoming, active: false, waitStr: `in ${h}h ${m}m` };
}

function getAMDPhase() {
  const now = new Date();
  const t = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (t >= 0 && t < 12)   return { phase: 'A', label: 'Accumulation',  color: '#6b7280', desc: 'Off-hours — institutions quietly building overnight positions. No action.' };
  if (t >= 12 && t < 13.5) return { phase: 'A', label: 'Accumulation (Pre-mkt)', color: '#f59e0b', desc: '8–9:30am EST pre-market. Watch futures direction. Do not trade yet.' };
  if (t >= 13.5 && t < 14.5) return { phase: 'M', label: 'Manipulation (Opening)', color: '#ef4444', desc: '9:30–10:30am EST. Stop hunts happen here. Wait — do NOT chase the first move.' };
  if (t >= 14.5 && t < 20) return { phase: 'D', label: 'Distribution (Main)',   color: '#22c55e', desc: '10:30am+ EST. Real trend delivery. This is your window to enter confirmed setups.' };
  return { phase: 'A', label: 'Accumulation', color: '#6b7280', desc: 'Market closed. Plan tomorrow\'s bias now.' };
}

function getDaysTillFOMC() {
  const today = new Date(); today.setHours(0,0,0,0);
  for (const d of FOMC_DATES) {
    const dt = new Date(d);
    const diff = Math.round((dt - today) / 86400000);
    if (diff >= 0) return { date: d, days: diff };
  }
  return null;
}

function getEarningsSeason() {
  const now = new Date();
  const m = now.getMonth() + 1, d = now.getDate();
  const active = (m===1&&d>=15)||(m===2&&d<=15)||(m===4&&d>=15)||(m===5&&d<=15)||
                 (m===7&&d>=15)||(m===8&&d<=15)||(m===10&&d>=15)||(m===11&&d<=15);
  if (active) return { active: true, label: 'Earnings Season Active ⚠', desc: 'High gap risk — use wider stops, smaller size' };
  const nexts = [{m:1,d:15,q:'Q4'},{m:4,d:15,q:'Q1'},{m:7,d:15,q:'Q2'},{m:10,d:15,q:'Q3'}];
  for (const s of nexts) {
    const dt = new Date(now.getFullYear(), s.m - 1, s.d);
    if (dt > now) {
      const days = Math.round((dt - now) / 86400000);
      return { active: false, label: `${s.q} Earnings in ${days}d`, desc: 'Normal volatility' };
    }
  }
  return { active: false, label: 'Quiet Period', desc: 'Normal conditions' };
}

/* ─────────────────────── DATA FETCHING ──────────────────────────── */
async function fetchOHLC(instrument, granularity, count) {
  const { key, env } = getOanda();
  if (!key) return null;
  const host = env === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
  try {
    const res = await fetch(
      `${host}/v3/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.candles || []).filter(c => c.complete)
      .map(c => ({ t: c.time, o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c }));
  } catch { return null; }
}

async function fetchCloses(instrument, granularity, count) {
  const candles = await fetchOHLC(instrument, granularity, count);
  return candles ? candles.map(c => c.c) : null;
}

async function fetchFredSeries(id, days = 120) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
  async function tryProxy(makeUrl) {
    const res = await fetch(makeUrl(url), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('not ok');
    const text = await res.text();
    const series = text.trim().split('\n').slice(1)
      .map(l => { const [date, val] = l.split(','); return { date, val: parseFloat(val) }; })
      .filter(d => Number.isFinite(d.val)).slice(-days);
    if (!series.length) throw new Error('empty');
    return series;
  }
  try { return await Promise.any(FRED_PROXIES.map(p => tryProxy(p))); } catch { return null; }
}

async function fetchYahooSeries(ticker, range = '60d') {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${range}`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const ts = data.chart?.result?.[0]?.timestamp || [];
    const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const series = ts.map((t,i) => ({ date: new Date(t*1000).toISOString().slice(0,10), val: closes[i] }))
      .filter(d => Number.isFinite(d.val));
    return series.length >= 2 ? series : null;
  } catch { return null; }
}

// VIX: FRED VIXCLS proxy (same reliability as CPI/Fed), Yahoo as backup
async function fetchVIX() {
  const fred = await fetchFredSeries('VIXCLS', 60);
  if (fred?.length) return fred;
  return fetchYahooSeries('%5EVIX', '30d');
}
// ^TNX = 10-Year Treasury yield (Yahoo returns e.g. 43.2 meaning 4.32%)
const fetchYield10Y = () => fetchYahooSeries('%5ETNX').then(s => s?.map(d => ({ ...d, val: d.val > 20 ? d.val / 10 : d.val })) || null);
// ^IRX = 13-Week T-Bill rate
const fetchYield2Y  = () => fetchYahooSeries('%5EIRX').then(s => s?.map(d => ({ ...d, val: d.val > 20 ? d.val / 10 : d.val })) || null);

// Macro cache from GitHub Actions (server-side FRED fetch, no proxy needed)
async function fetchMacroCache() {
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/amandeep97/Forex/main/public/macro-data.json?t=' + Date.now(),
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function fetchCOTHistory(code, weeks = 52) {
  if (!code) return null;
  try {
    const url = `https://publicreporting.cftc.gov/api/odata/v1/CorrectMarketHistory?$filter=CFTC_Commodity_Code eq '${code}'&$orderby=Report_Date_as_YYYY_MM_DD desc&$top=${weeks}&$select=Report_Date_as_YYYY_MM_DD,NonComm_Positions_Long_All,NonComm_Positions_Short_All`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.value || []).reverse()
      .map(r => ({ date: r.Report_Date_as_YYYY_MM_DD, net: (r.NonComm_Positions_Long_All||0)-(r.NonComm_Positions_Short_All||0) }));
  } catch { return null; }
}

/* ─────────────────────── SUB-COMPONENTS ────────────────────────── */
function Sparkline({ data, color = '#22c55e', width = 80, height = 28 }) {
  if (!data || data.length < 2) return <span style={{ color:'var(--text3)', fontSize:10 }}>—</span>;
  const vals = data.slice(-20);
  const mn = Math.min(...vals), mx = Math.max(...vals), range = mx - mn || 1;
  const pts = vals.map((v,i) => `${(i/(vals.length-1))*width},${height-((v-mn)/range)*height}`).join(' ');
  return (
    <svg width={width} height={height} style={{ overflow:'visible' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  );
}

function ScoreRing({ score, total, color }) {
  const pct = total > 0 ? score / total : 0;
  const r = 26, circ = 2 * Math.PI * r;
  const dash = pct * circ;
  const ringColor = pct >= 0.65 ? '#22c55e' : pct <= 0.35 ? '#ef4444' : '#f59e0b';
  return (
    <svg width={70} height={70} viewBox="0 0 70 70">
      <circle cx={35} cy={35} r={r} fill="none" stroke="var(--border)" strokeWidth={6}/>
      <circle cx={35} cy={35} r={r} fill="none" stroke={ringColor} strokeWidth={6}
        strokeDasharray={`${dash} ${circ}`} strokeDashoffset={circ/4}
        strokeLinecap="round" style={{ transition:'stroke-dasharray 0.5s' }}/>
      <text x={35} y={30} textAnchor="middle" fill={ringColor} fontSize={14} fontWeight="700">{score}</text>
      <text x={35} y={44} textAnchor="middle" fill="var(--text3)" fontSize={10}>/{total}</text>
    </svg>
  );
}

function Tag({ bull, label }) {
  const bg   = bull === true ? '#22c55e20' : bull === false ? '#ef444420' : '#6b728020';
  const color = bull === true ? '#22c55e'  : bull === false ? '#ef4444'  : '#6b7280';
  const arrow = bull === true ? '▲' : bull === false ? '▼' : '●';
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:2, padding:'2px 6px', borderRadius:4, background:bg, color, fontSize:10, fontWeight:700, marginRight:3, marginBottom:3 }}>
      {arrow} {label}
    </span>
  );
}

function SectionCard({ children, style = {} }) {
  return (
    <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:14, ...style }}>
      {children}
    </div>
  );
}

function SectionTitle({ icon, label, color = 'var(--accent)' }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10 }}>
      <span style={{ fontSize:14 }}>{icon}</span>
      <span style={{ fontWeight:700, fontSize:13, color }}>{label}</span>
    </div>
  );
}

/* ─────────────────────── SCORING ────────────────────────────────── */
function scoreIndex(key, data, macro) {
  const { daily, weekly, monthly, h1Closes, cot } = data;
  const { vixLast, cpiYoY, fedRate, fedPrev, yieldCurve, pmiLast } = macro;

  const dailyCloses = daily?.map(c => c.c) || [];
  const currentPrice = h1Closes?.[h1Closes.length-1] ?? dailyCloses[dailyCloses.length-1];

  let score = 0, total = 0;
  const factors = [];

  const add = (name, bull, detail) => { total++; if (bull) score++; factors.push({ name, bull, detail }); };

  // 1. Fed direction — cutting/pausing = bullish for stocks
  if (fedRate != null && fedPrev != null) {
    const dir = fedRate < fedPrev ? 'cutting' : fedRate > fedPrev ? 'hiking' : 'pausing';
    add('Fed', dir !== 'hiking', dir === 'cutting' ? `Cutting (${fedRate}%)` : dir === 'pausing' ? `Pausing (${fedRate}%)` : `Hiking (${fedRate}%)`);
  }

  // 2. VIX — low fear = bullish for equities
  if (vixLast != null) {
    const bull = vixLast < 20;
    add('VIX', bull, `${vixLast.toFixed(1)} ${vixLast < 15 ? '(calm)' : vixLast < 20 ? '(low)' : vixLast < 30 ? '(elevated)' : '(extreme)'}`);
  }

  // 3. Yield curve — positive = normal = bullish
  if (yieldCurve != null) {
    add('Yield Curve', yieldCurve > 0, `${yieldCurve > 0 ? '+' : ''}${yieldCurve.toFixed(3)}% ${yieldCurve > 0 ? 'normal' : 'inverted'}`);
  }

  // 4. PMI > 50 = expansion = bullish
  if (pmiLast != null) {
    add('PMI', pmiLast > 50, `${pmiLast.toFixed(1)} ${pmiLast > 50 ? '(expanding)' : '(contracting)'}`);
  }

  // 5. CPI — for equities, very high CPI (Fed forced to hike) is bearish; moderate is neutral-bullish
  if (cpiYoY != null) {
    const bull = cpiYoY < 3;
    add('CPI', bull, `${cpiYoY.toFixed(2)}% YoY ${cpiYoY >= 4 ? '(too hot — Fed hawkish)' : cpiYoY >= 2.5 ? '(elevated)' : '(controlled)'}`);
  }

  // 6. COT < 80th pct = not crowded = bullish
  if (cot && cot.length >= 10) {
    const nets = cot.map(c => c.net);
    const pct = pctRank(nets);
    if (pct != null) add('COT', pct < 80, `${pct}th pct ${pct < 20 ? '(contrarian bull)' : pct > 80 ? '(crowded)' : '(neutral)'}`);
  }

  // 7. RSI
  const rsi = calcRSI(dailyCloses);
  if (rsi != null) {
    const bull = rsi < 70; // overbought is only bearish signal; oversold = buy zone
    add('RSI', bull, `${rsi} — ${rsi < 30 ? 'oversold (buy zone)' : rsi < 50 ? 'neutral-bearish' : rsi < 70 ? 'neutral-bullish' : 'overbought'}`);
  }

  // 8. 50 EMA
  const ema50 = calcEMA(dailyCloses, 50);
  if (ema50 && currentPrice) {
    add('EMA50', currentPrice > ema50, `Price ${currentPrice > ema50 ? 'above' : 'below'} ${fmtPrice(ema50)}`);
  }

  // 9. HTF Weekly bias
  const prevWeekClose = weekly?.length >= 2 ? weekly[weekly.length-2].c : null;
  if (prevWeekClose && currentPrice) {
    add('HTF Weekly', currentPrice > prevWeekClose, `${currentPrice > prevWeekClose ? 'Above' : 'Below'} ${fmtPrice(prevWeekClose)}`);
  }

  // 10. HTF Monthly bias
  const prevMonthClose = monthly?.length >= 2 ? monthly[monthly.length-2].c : null;
  if (prevMonthClose && currentPrice) {
    add('HTF Monthly', currentPrice > prevMonthClose, `${currentPrice > prevMonthClose ? 'Above' : 'Below'} ${fmtPrice(prevMonthClose)}`);
  }

  // 11. Market structure
  const ms = detectMarketStructure(daily);
  if (ms) {
    const bull = ms === 'bullish';
    total++; if (bull) score++;
    factors.push({ name: 'Structure', bull: ms === 'ranging' ? null : bull, detail: ms === 'bullish' ? 'HH + HL' : ms === 'bearish' ? 'LH + LL' : 'Ranging' });
  }

  const bias = score / total >= 0.65 ? 'bullish' : score / total <= 0.35 ? 'bearish' : 'neutral';
  return { score, total, factors, bias, rsi, ema50, currentPrice,
    ms: detectMarketStructure(daily),
    atr: calcATR(daily),
  };
}

/* ─────────────────────── MAIN COMPONENT ────────────────────────── */
export default function IndicesDashboard() {
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [h1, setH1]         = useState(null);
  const [daily, setDaily]   = useState(null);
  const [weekly, setWeekly] = useState(null);
  const [monthly, setMonthly] = useState(null);
  const [h1ohlc, setH1ohlc] = useState(null);
  const [vix, setVix]       = useState(null);
  const [cpi, setCpi]       = useState(null);
  const [fed, setFed]       = useState(null);
  const [yield10, setYield10] = useState(null);
  const [yield2,  setYield2]  = useState(null);
  const [pmi, setPmi]       = useState(null);
  const [cot, setCot]       = useState(null);
  const [killZone, setKillZone] = useState(() => getKillZone());
  const [amd, setAmd]       = useState(() => getAMDPhase());

  useEffect(() => {
    const t = setInterval(() => { setKillZone(getKillZone()); setAmd(getAMDPhase()); }, 30000);
    return () => clearInterval(t);
  }, []);

  const hasOanda = !!getOanda().key;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Phase 1: OANDA + Yahoo Finance + macro cache (all parallel, no FRED proxies)
      const [
        spxH1c, nqH1c, dowH1c, rutH1c,
        spxD, nqD, dowD, rutD,
        spxW, nqW, dowW, rutW,
        spxM, nqM, dowM, rutM,
        spxH1o, nqH1o,
        vixData, y10Yahoo, y2Yahoo,
        macroCache,
        cotSPX, cotNQ, cotDow, cotRUT,
      ] = await Promise.all([
        fetchCloses(INDICES.spx.oanda,     'H1', 60),
        fetchCloses(INDICES.nq.oanda,      'H1', 60),
        fetchCloses(INDICES.dow.oanda,     'H1', 60),
        fetchCloses(INDICES.russell.oanda, 'H1', 60),
        fetchOHLC(INDICES.spx.oanda,       'D', 60),
        fetchOHLC(INDICES.nq.oanda,        'D', 60),
        fetchOHLC(INDICES.dow.oanda,       'D', 60),
        fetchOHLC(INDICES.russell.oanda,   'D', 60),
        fetchOHLC(INDICES.spx.oanda,       'W', 5),
        fetchOHLC(INDICES.nq.oanda,        'W', 5),
        fetchOHLC(INDICES.dow.oanda,       'W', 5),
        fetchOHLC(INDICES.russell.oanda,   'W', 5),
        fetchOHLC(INDICES.spx.oanda,       'M', 3),
        fetchOHLC(INDICES.nq.oanda,        'M', 3),
        fetchOHLC(INDICES.dow.oanda,       'M', 3),
        fetchOHLC(INDICES.russell.oanda,   'M', 3),
        fetchOHLC(INDICES.spx.oanda,       'H1', 100),
        fetchOHLC(INDICES.nq.oanda,        'H1', 100),
        fetchVIX(),
        fetchYield10Y(),   // ^TNX from Yahoo Finance
        fetchYield2Y(),    // ^IRX from Yahoo Finance
        fetchMacroCache(), // GitHub Actions JSON
        fetchCOTHistory(INDICES.spx.cot, 54),
        fetchCOTHistory(INDICES.nq.cot, 54),
        fetchCOTHistory(INDICES.dow.cot, 54),
        fetchCOTHistory(INDICES.russell.cot, 54),
      ]);

      // Phase 2: cache → FRED proxy fallback. Also fetch yields from FRED if Yahoo + cache both empty.
      const [cpiData, fedData, pmiData, fredY10, fredY2] = await Promise.all([
        macroCache?.cpi?.length      ? macroCache.cpi      : fetchFredSeries('CPIAUCSL', 24),
        macroCache?.fedfunds?.length ? macroCache.fedfunds : fetchFredSeries('FEDFUNDS', 12),
        macroCache?.pmi?.length      ? macroCache.pmi      : fetchFredSeries('MPMIVMA', 24).then(d => {
          if (!d?.length) return null;
          const norm = d.map(x => ({ ...x, val: x.val < 5 ? +(x.val * 100).toFixed(1) : +x.val.toFixed(1) }))
                        .filter(x => x.val >= 30 && x.val <= 75);
          return norm.length ? norm : null;
        }),
        (!y10Yahoo?.length && !macroCache?.dgs10?.length)  ? fetchFredSeries('DGS10', 365) : Promise.resolve(null),
        (!y2Yahoo?.length  && !macroCache?.dgs2?.length)   ? fetchFredSeries('DGS2',  365) : Promise.resolve(null),
      ]);

      // Yield curve: Yahoo → cache → FRED proxy (triple fallback)
      const y10Data = y10Yahoo?.length ? y10Yahoo : (macroCache?.dgs10?.length ? macroCache.dgs10 : fredY10);
      const y2Data  = y2Yahoo?.length  ? y2Yahoo  : (macroCache?.dgs2?.length  ? macroCache.dgs2  : fredY2);

      setH1({ spx: spxH1c, nq: nqH1c, dow: dowH1c, russell: rutH1c });
      setDaily({ spx: spxD, nq: nqD, dow: dowD, russell: rutD });
      setWeekly({ spx: spxW, nq: nqW, dow: dowW, russell: rutW });
      setMonthly({ spx: spxM, nq: nqM, dow: dowM, russell: rutM });
      setH1ohlc({ spx: spxH1o, nq: nqH1o });
      setVix(vixData); setCpi(cpiData); setFed(fedData);
      setYield10(y10Data); setYield2(y2Data); setPmi(pmiData);
      setCot({ spx: cotSPX, nq: cotNQ, dow: cotDow, russell: cotRUT });
      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /* ── Macro signals ───────────────────────────────────────────── */
  const vixLast = vix?.[vix.length-1]?.val;
  const vixPrev = vix?.[vix.length-2]?.val;
  const vixDir  = vixLast != null && vixPrev != null ? (vixLast > vixPrev ? 'rising' : 'falling') : null;

  let cpiYoY = null;
  if (cpi?.length >= 13) cpiYoY = +((cpi[cpi.length-1].val - cpi[cpi.length-13].val) / cpi[cpi.length-13].val * 100).toFixed(2);

  const fedRate = fed?.[fed.length-1]?.val;
  const fedPrev = fed?.[fed.length-2]?.val;
  const fedDir  = fedRate != null && fedPrev != null ? (fedRate < fedPrev ? 'cutting' : fedRate > fedPrev ? 'hiking' : 'pausing') : null;

  const y10val  = yield10?.[yield10.length-1]?.val;
  const y2val   = yield2?.[yield2.length-1]?.val;
  const yieldCurve = (y10val && y2val) ? +(y10val - y2val).toFixed(3) : null;

  const pmiLast = pmi?.[pmi.length-1]?.val;

  const macro = { vixLast, vixPrev, cpiYoY, fedRate, fedPrev, yieldCurve, pmiLast };

  /* ── Score each index ────────────────────────────────────────── */
  const scores = {};
  for (const key of INDEX_KEYS) {
    scores[key] = scoreIndex(key, {
      daily: daily?.[key], weekly: weekly?.[key], monthly: monthly?.[key],
      h1Closes: h1?.[key], cot: cot?.[key],
    }, macro);
  }

  /* ── Relative strength (5-bar H1 return) ────────────────────── */
  const relStrength = INDEX_KEYS
    .filter(k => h1?.[k]?.length > 5)
    .map(k => {
      const c = h1[k];
      const ret = (c[c.length-1] - c[c.length-6]) / c[c.length-6] * 100;
      return { key: k, ...INDICES[k], ret, currentPrice: scores[k]?.currentPrice };
    })
    .sort((a, b) => b.ret - a.ret);

  /* ── Risk-On/Off ─────────────────────────────────────────────── */
  let riskSentiment = null;
  const spxC = h1?.spx, rutC = h1?.russell, nqC = h1?.nq, dowC = h1?.dow;
  if (spxC?.length > 5 && rutC?.length > 5) {
    const spxRet = (spxC[spxC.length-1] - spxC[spxC.length-6]) / spxC[spxC.length-6] * 100;
    const rutRet = (rutC[rutC.length-1] - rutC[rutC.length-6]) / rutC[rutC.length-6] * 100;
    const nqRet  = nqC?.length > 5 ? (nqC[nqC.length-1] - nqC[nqC.length-6]) / nqC[nqC.length-6] * 100 : null;
    const dowRet = dowC?.length > 5 ? (dowC[dowC.length-1] - dowC[dowC.length-6]) / dowC[dowC.length-6] * 100 : null;
    const outperform = rutRet - spxRet;
    let level, color, label, desc;
    if (outperform > 0.3 && spxRet > 0)        { level='risk_on';   color='#22c55e'; label='Risk-On 🟢';     desc='Russell leading SPX — high risk appetite, buy dips'; }
    else if (outperform > 0)                    { level='mild_on';   color='#86efac'; label='Mild Risk-On';   desc='Slight outperform — lean bullish but cautious'; }
    else if (outperform < -0.3 && spxRet < 0)  { level='risk_off';  color='#ef4444'; label='Risk-Off 🔴';    desc='Russell lagging SPX — defensive, reduce size'; }
    else                                        { level='mild_off';  color='#fca5a5'; label='Mild Risk-Off';  desc='Slight defensive tilt — mixed signals'; }
    riskSentiment = { level, color, label, desc, spxRet, rutRet, nqRet, dowRet, outperform };
  }

  /* ── SMT Divergence ──────────────────────────────────────────── */
  const spxH = daily?.spx?.map(c=>c.h), spxL = daily?.spx?.map(c=>c.l);
  const nqH  = daily?.nq?.map(c=>c.h),  nqL  = daily?.nq?.map(c=>c.l);
  const rutH = daily?.russell?.map(c=>c.h), rutL = daily?.russell?.map(c=>c.l);
  const dowH = daily?.dow?.map(c=>c.h), dowL = daily?.dow?.map(c=>c.l);
  const smtSpxNq  = detectSMT(spxH||[], nqH||[]);
  const smtSpxRut = detectSMT(spxH||[], rutH||[]);
  const smtNqDow  = detectSMT(nqH||[], dowH||[]);

  /* ── ICT Levels ──────────────────────────────────────────────── */
  function getICT(d, w) {
    if (!d?.length) return null;
    const n = d.length;
    const prev = d[n-2] || d[n-1];
    const curr = d[n-1];
    const openGap = n >= 2 ? +((curr.o - d[n-2].c) / d[n-2].c * 100).toFixed(3) : null;
    return {
      pdh: +prev.h.toFixed(2), pdl: +prev.l.toFixed(2),
      pwh: w?.length >= 2 ? +w[w.length-2].h.toFixed(2) : null,
      pwl: w?.length >= 2 ? +w[w.length-2].l.toFixed(2) : null,
      todayOpen: +curr.o.toFixed(2), openGap,
    };
  }
  const ict = {
    spx: getICT(daily?.spx, weekly?.spx),
    nq:  getICT(daily?.nq,  weekly?.nq),
    dow: getICT(daily?.dow,  weekly?.dow),
    russell: getICT(daily?.russell, weekly?.russell),
  };

  /* ── FVG + Sweep ─────────────────────────────────────────────── */
  const fvg   = { spx: detectFVG(daily?.spx), nq: detectFVG(daily?.nq), dow: detectFVG(daily?.dow), russell: detectFVG(daily?.russell) };
  const sweep = { spx: detectLiquiditySweep(daily?.spx), nq: detectLiquiditySweep(daily?.nq), dow: detectLiquiditySweep(daily?.dow), russell: detectLiquiditySweep(daily?.russell) };

  /* ── Sessions ────────────────────────────────────────────────── */
  const sessions = computeSessions(h1ohlc?.spx);

  /* ── Misc ────────────────────────────────────────────────────── */
  const fomc     = getDaysTillFOMC();
  const earnings = getEarningsSeason();
  const bull = '#22c55e', bear = '#ef4444', warn = '#f59e0b', neu = 'var(--text3)';

  /* ── Overall market narrative ────────────────────────────────── */
  const totalScore = INDEX_KEYS.reduce((s,k) => s + (scores[k]?.score||0), 0);
  const totalMax   = INDEX_KEYS.reduce((s,k) => s + (scores[k]?.total||0), 0);
  const marketBull = totalMax > 0 && totalScore / totalMax >= 0.6;
  const marketBear = totalMax > 0 && totalScore / totalMax <= 0.4;
  const bestIndex  = relStrength[0];
  const worstIndex = relStrength[relStrength.length-1];

  /* ════════════════════ RENDER ════════════════════════════════════ */
  return (
    <div style={{ height:'100%', overflowY:'auto', background:'var(--bg1)', fontFamily:'var(--font)' }}>

      {/* ── Header ─────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', padding:'10px 16px', background:'var(--bg2)', borderBottom:'1px solid var(--border)', flexShrink:0, gap:8, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:18 }}>📊</span>
          <span style={{ fontWeight:800, fontSize:15 }}>US Indices Dashboard</span>
          <span style={{ fontSize:10, color:'var(--text3)', marginLeft:4 }}>SPX · NQ · DJI · RUT — All Drivers</span>
        </div>
        <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center' }}>
          {lastRefresh && <span style={{ fontSize:10, color:neu }}>Updated {lastRefresh.toLocaleTimeString()}</span>}
          <button onClick={load} disabled={loading}
            style={{ padding:'4px 12px', borderRadius:4, fontSize:11, fontWeight:700, cursor:'pointer',
              background:'var(--bg2)', color:neu, border:'1px solid var(--border)' }}>
            {loading ? '⟳ Loading…' : '↺ Refresh'}
          </button>
        </div>
      </div>

      {!hasOanda && (
        <div style={{ padding:'8px 16px', background:'#f59e0b14', borderBottom:'1px solid #f59e0b33' }}>
          <span style={{ fontSize:11, color:warn }}>⚠ Connect OANDA in Screener settings to enable live market data.</span>
        </div>
      )}

      <div style={{ padding:'12px 16px', display:'flex', flexDirection:'column', gap:12 }}>

        {/* ── SECTION 1: Market Narrative (plain English) ── */}
        {totalMax > 0 && (
          <SectionCard style={{ background: marketBull ? '#22c55e10' : marketBear ? '#ef444410' : '#f59e0b10', border:`1px solid ${marketBull ? '#22c55e30' : marketBear ? '#ef444430' : '#f59e0b30'}` }}>
            <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
              <div style={{ fontSize:24, flexShrink:0 }}>{marketBull ? '📈' : marketBear ? '📉' : '⚖'}</div>
              <div>
                <div style={{ fontWeight:800, fontSize:13, color: marketBull ? bull : marketBear ? bear : warn, marginBottom:4 }}>
                  {marketBull ? 'MACRO BULLISH — Look for Buy Setups' : marketBear ? 'MACRO BEARISH — Look for Short Setups' : 'MIXED SIGNALS — Wait for Confluence'}
                </div>
                <div style={{ fontSize:11, color:'var(--text2)', lineHeight:1.5 }}>
                  {marketBull && bestIndex && `Overall score ${totalScore}/${totalMax}. Strongest index: ${bestIndex.name} (${fmtPct(bestIndex.ret,2)} 5-bar). Focus buy setups on ${bestIndex.name} first.`}
                  {marketBear && worstIndex && `Overall score ${totalScore}/${totalMax}. Weakest index: ${worstIndex.name} (${fmtPct(worstIndex.ret,2)} 5-bar). Focus short setups on ${worstIndex.name} first.`}
                  {!marketBull && !marketBear && `Score ${totalScore}/${totalMax} — no clear directional edge. Reduce size, wait for stronger confluence before entering.`}
                </div>
              </div>
            </div>
          </SectionCard>
        )}

        {/* ── SECTION 2: Macro Environment Pills ────────── */}
        <SectionCard>
          <SectionTitle icon="🌐" label="US Macro Environment"/>
          <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
            {/* VIX */}
            <div style={{ flex:'1 1 140px', background:'var(--bg1)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px' }}>
              <div style={{ fontSize:10, color:neu, marginBottom:2 }}>VIX Fear Index</div>
              <div style={{ fontWeight:700, fontSize:14, color: vixLast == null ? neu : vixLast < 15 ? bull : vixLast < 20 ? bull : vixLast < 30 ? warn : bear }}>
                {vixLast != null ? vixLast.toFixed(1) : '—'}
                {vixDir && <span style={{ fontSize:10, marginLeft:4 }}>{vixDir === 'rising' ? '▲' : '▼'}</span>}
              </div>
              <div style={{ fontSize:10, color:neu }}>
                {vixLast == null ? (loading ? 'Loading…' : '— unavailable') : vixLast < 15 ? 'Very Low — ideal for bulls' : vixLast < 20 ? 'Low — normal rally' : vixLast < 30 ? 'Elevated — caution' : 'Extreme fear'}
              </div>
              <Sparkline data={vix?.map(d=>d.val)} color={vixLast < 20 ? bull : bear} width={100} height={22}/>
            </div>

            {/* Fed Rate */}
            <div style={{ flex:'1 1 140px', background:'var(--bg1)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px' }}>
              <div style={{ fontSize:10, color:neu, marginBottom:2 }}>Fed Funds Rate</div>
              <div style={{ fontWeight:700, fontSize:14, color: fedDir === 'cutting' ? bull : fedDir === 'hiking' ? bear : warn }}>
                {fedRate != null ? `${fedRate}%` : '—'}
                {fedDir && <span style={{ fontSize:10, marginLeft:4 }}>{fedDir === 'hiking' ? '▲' : fedDir === 'cutting' ? '▼' : '—'}</span>}
              </div>
              <div style={{ fontSize:10, color:neu }}>
                {fedDir === 'cutting' ? '✅ Cutting — bullish for stocks' : fedDir === 'hiking' ? '❌ Hiking — bearish for stocks' : fedDir === 'pausing' ? '➖ Pausing — neutral' : loading ? 'Loading…' : '— unavailable'}
              </div>
            </div>

            {/* CPI */}
            <div style={{ flex:'1 1 140px', background:'var(--bg1)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px' }}>
              <div style={{ fontSize:10, color:neu, marginBottom:2 }}>CPI Inflation YoY</div>
              <div style={{ fontWeight:700, fontSize:14, color: cpiYoY == null ? neu : cpiYoY >= 4 ? bear : cpiYoY >= 2.5 ? warn : bull }}>
                {cpiYoY != null ? `${cpiYoY.toFixed(2)}%` : '—'}
              </div>
              <div style={{ fontSize:10, color:neu }}>
                {cpiYoY == null ? (loading ? 'Loading…' : '— unavailable') : cpiYoY >= 4 ? '❌ Hot — Fed must stay hawkish' : cpiYoY >= 2.5 ? '⚠ Elevated — watch Fed signals' : '✅ Controlled — Fed can ease'}
              </div>
            </div>

            {/* Yield Curve */}
            <div style={{ flex:'1 1 140px', background:'var(--bg1)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px' }}>
              <div style={{ fontSize:10, color:neu, marginBottom:2 }}>Yield Curve (10Y-2Y)</div>
              <div style={{ fontWeight:700, fontSize:14, color: yieldCurve == null ? neu : yieldCurve > 0 ? bull : bear }}>
                {yieldCurve != null ? `${yieldCurve > 0 ? '+' : ''}${yieldCurve.toFixed(3)}%` : '—'}
              </div>
              <div style={{ fontSize:10, color:neu }}>
                {yieldCurve == null ? (loading ? 'Loading…' : '— FRED unavailable') : yieldCurve > 0.5 ? '✅ Normal — growth signal' : yieldCurve > 0 ? '✅ Slight normal' : yieldCurve > -0.5 ? '⚠ Near inversion' : '❌ Inverted — recession warning'}
              </div>
            </div>

            {/* PMI */}
            <div style={{ flex:'1 1 140px', background:'var(--bg1)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px' }}>
              <div style={{ fontSize:10, color:neu, marginBottom:2 }}>PMI Manufacturing</div>
              <div style={{ fontWeight:700, fontSize:14, color: pmiLast == null ? neu : pmiLast > 50 ? bull : bear }}>
                {pmiLast != null ? pmiLast.toFixed(1) : '—'}
              </div>
              <div style={{ fontSize:10, color:neu }}>
                {pmiLast == null ? (loading ? 'Loading…' : '— FRED unavailable') : pmiLast > 55 ? '✅ Strong expansion' : pmiLast > 50 ? '✅ Expanding' : pmiLast > 45 ? '❌ Contracting' : '❌ Sharp contraction'}
              </div>
            </div>

            {/* FOMC Countdown */}
            <div style={{ flex:'1 1 140px', background:'var(--bg1)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px' }}>
              <div style={{ fontSize:10, color:neu, marginBottom:2 }}>Next FOMC Meeting</div>
              <div style={{ fontWeight:700, fontSize:14, color: fomc?.days <= 7 ? bear : fomc?.days <= 14 ? warn : bull }}>
                {fomc ? `${fomc.days}d away` : '—'}
              </div>
              <div style={{ fontSize:10, color:neu }}>
                {fomc?.date} — {fomc?.days <= 3 ? '⚠ FOMC this week! High risk' : fomc?.days <= 7 ? '⚠ Approaching — reduce size' : 'Safe window'}
              </div>
            </div>

            {/* Earnings */}
            <div style={{ flex:'1 1 140px', background: earnings.active ? '#f59e0b10' : 'var(--bg1)', border:`1px solid ${earnings.active ? '#f59e0b40' : 'var(--border)'}`, borderRadius:8, padding:'8px 10px' }}>
              <div style={{ fontSize:10, color:neu, marginBottom:2 }}>Earnings Season</div>
              <div style={{ fontWeight:700, fontSize:12, color: earnings.active ? warn : bull }}>{earnings.label}</div>
              <div style={{ fontSize:10, color:neu }}>{earnings.desc}</div>
            </div>
          </div>
        </SectionCard>

        {/* ── SECTION 3: AMD Cycle + Kill Zone ──────────── */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>

          {/* AMD Phase */}
          <SectionCard>
            <SectionTitle icon="⏱" label="AMD Cycle Phase"/>
            <div style={{ textAlign:'center', padding:'8px 0' }}>
              <div style={{ width:52, height:52, borderRadius:'50%', background: amd.color + '25',
                border:`3px solid ${amd.color}`, display:'flex', alignItems:'center', justifyContent:'center',
                margin:'0 auto 8px', fontSize:20, fontWeight:800, color: amd.color }}>
                {amd.phase}
              </div>
              <div style={{ fontWeight:700, fontSize:12, color: amd.color, marginBottom:4 }}>{amd.label}</div>
              <div style={{ fontSize:10, color:'var(--text2)', lineHeight:1.4 }}>{amd.desc}</div>
            </div>
            <div style={{ marginTop:8, padding:'6px 8px', background:'var(--bg1)', borderRadius:6, fontSize:10, color:neu }}>
              <strong style={{ color:'var(--text1)' }}>A</strong> Accumulate → <strong style={{ color:'#ef4444' }}>M</strong> Manipulate → <strong style={{ color:'#22c55e' }}>D</strong> Deliver
            </div>
          </SectionCard>

          {/* Kill Zone */}
          <SectionCard style={{ borderColor: killZone.active ? killZone.color + '60' : 'var(--border)', background: killZone.active ? killZone.color + '08' : 'var(--bg2)' }}>
            <SectionTitle icon="🎯" label="ICT Kill Zone" color={killZone.active ? killZone.color : 'var(--accent)'}/>
            <div style={{ textAlign:'center', padding:'4px 0' }}>
              <div style={{ fontWeight:700, fontSize:12, color: killZone.color, marginBottom:6 }}>
                {killZone.active ? '● ACTIVE NOW' : '○ Next Zone'}
              </div>
              <div style={{ fontWeight:800, fontSize:13, color:'var(--text1)', marginBottom:4 }}>{killZone.name}</div>
              {killZone.active
                ? <div style={{ fontSize:10, color:neu, marginBottom:4 }}>Ends {killZone.remainStr}</div>
                : <div style={{ fontSize:11, color: killZone.color, fontWeight:700, marginBottom:4 }}>{killZone.waitStr}</div>
              }
              <div style={{ fontSize:10, color:'var(--text2)', lineHeight:1.4 }}>{killZone.desc}</div>
            </div>
            <div style={{ marginTop:8, display:'flex', gap:4, flexWrap:'wrap' }}>
              {[{n:'Asian',t:'2-5 UTC',c:'#a78bfa'},{n:'London',t:'7-9 UTC',c:'#3b82f6'},{n:'NY Open',t:'9:30-11:30',c:'#22c55e'},{n:'NY PM',t:'14-16 UTC',c:'#f59e0b'}].map(z => (
                <span key={z.n} style={{ fontSize:9, padding:'2px 5px', borderRadius:3, background: z.c + '20', color: z.c }}>{z.n}</span>
              ))}
            </div>
          </SectionCard>
        </div>

        {/* ── SECTION 4: Risk-On/Off + Relative Strength ─ */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>

          {/* Risk Sentiment */}
          <SectionCard>
            <SectionTitle icon="⚡" label="Risk Sentiment"/>
            {riskSentiment ? (
              <>
                <div style={{ textAlign:'center', marginBottom:8 }}>
                  <div style={{ fontWeight:800, fontSize:14, color: riskSentiment.color, marginBottom:4 }}>{riskSentiment.label}</div>
                  <div style={{ fontSize:10, color:'var(--text2)', lineHeight:1.4 }}>{riskSentiment.desc}</div>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:4, fontSize:10 }}>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{ color:neu }}>SPX 5-bar</span>
                    <span style={{ color: riskSentiment.spxRet >= 0 ? bull : bear, fontWeight:700 }}>{fmtPct(riskSentiment.spxRet)}</span>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{ color:neu }}>RUT 5-bar</span>
                    <span style={{ color: riskSentiment.rutRet >= 0 ? bull : bear, fontWeight:700 }}>{fmtPct(riskSentiment.rutRet)}</span>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', borderTop:'1px solid var(--border)', paddingTop:3, marginTop:2 }}>
                    <span style={{ color:neu }}>RUT vs SPX</span>
                    <span style={{ color: riskSentiment.outperform >= 0 ? bull : bear, fontWeight:700 }}>{fmtPct(riskSentiment.outperform)}</span>
                  </div>
                </div>
                <div style={{ marginTop:8, padding:'5px 8px', borderRadius:5, background:'var(--bg1)', fontSize:10, color:neu }}>
                  RUT outperforming = risk-on (buy stocks). RUT lagging = risk-off (defensive).
                </div>
              </>
            ) : <div style={{ color:neu, fontSize:11 }}>Loading OANDA data…</div>}
          </SectionCard>

          {/* Relative Strength */}
          <SectionCard>
            <SectionTitle icon="🏆" label="Relative Strength"/>
            {relStrength.length > 0 ? (
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {relStrength.map((idx, i) => (
                  <div key={idx.key} style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <span style={{ fontSize:11, color:neu, width:14 }}>#{i+1}</span>
                    <span style={{ fontSize:10, fontWeight:700, color: idx.color, width:30 }}>{idx.short}</span>
                    <div style={{ flex:1, height:4, background:'var(--bg1)', borderRadius:2, overflow:'hidden' }}>
                      <div style={{ width:`${Math.min(100, Math.abs(idx.ret) * 20)}%`, height:'100%',
                        background: idx.ret >= 0 ? bull : bear, borderRadius:2 }}/>
                    </div>
                    <span style={{ fontSize:11, fontWeight:700, color: idx.ret >= 0 ? bull : bear, width:46, textAlign:'right' }}>
                      {fmtPct(idx.ret)}
                    </span>
                  </div>
                ))}
                <div style={{ fontSize:10, color:neu, marginTop:4, lineHeight:1.4 }}>
                  {marketBull ? `→ Trade ${relStrength[0]?.short} first (strongest in uptrend)` : marketBear ? `→ Short ${relStrength[relStrength.length-1]?.short} first (weakest in downtrend)` : '→ Wait for direction before picking index'}
                </div>
              </div>
            ) : <div style={{ color:neu, fontSize:11 }}>Loading…</div>}
          </SectionCard>
        </div>

        {/* ── SECTION 5: SMT Divergence ─────────────────── */}
        <SectionCard>
          <SectionTitle icon="🔀" label="SMT Divergence (Smart Money Technique)"/>
          <div style={{ fontSize:10, color:neu, marginBottom:8 }}>When correlated indices fail to confirm each other's high/low = smart money warning. Trade only the confirmed direction.</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
            {[
              { pair:'SPX / NQ', smt: smtSpxNq,  desc:'Core pair — if they diverge, the move is fake' },
              { pair:'SPX / RUT', smt: smtSpxRut, desc:'Risk signal — RUT confirms broad market health' },
              { pair:'NQ / DJI',  smt: smtNqDow,  desc:'Growth vs value — sector rotation signal' },
            ].map(({ pair, smt, desc }) => (
              <div key={pair} style={{ background:'var(--bg1)', border:`1px solid ${smt ? (smt.type==='bearish' ? '#ef444440' : '#22c55e40') : 'var(--border)'}`, borderRadius:8, padding:10, textAlign:'center' }}>
                <div style={{ fontWeight:700, fontSize:11, color:'var(--text1)', marginBottom:4 }}>{pair}</div>
                {smt ? (
                  <>
                    <div style={{ fontWeight:800, fontSize:12, color: smt.type==='bearish' ? bear : bull, marginBottom:3 }}>
                      {smt.type === 'bearish' ? '⚠ BEARISH SMT' : '✅ BULLISH SMT'}
                    </div>
                    <div style={{ fontSize:9, color:'var(--text2)', lineHeight:1.3 }}>{smt.who}</div>
                    <div style={{ fontSize:9, color: smt.type==='bearish' ? bear : bull, marginTop:4, fontWeight:600 }}>
                      {smt.type==='bearish' ? 'Do NOT buy — one index is lying' : 'Watch for reversal entry'}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight:700, fontSize:11, color: bull, marginBottom:3 }}>✅ Confirmed</div>
                    <div style={{ fontSize:9, color:neu }}>Both indices aligned — clean signal</div>
                  </>
                )}
                <div style={{ fontSize:9, color:neu, marginTop:6, borderTop:'1px solid var(--border)', paddingTop:4 }}>{desc}</div>
              </div>
            ))}
          </div>
        </SectionCard>

        {/* ── SECTION 6: Index Score Cards ──────────────── */}
        <div>
          <div style={{ fontWeight:700, fontSize:12, color:'var(--text2)', marginBottom:8, paddingLeft:2 }}>Individual Index Analysis</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {INDEX_KEYS.map(key => {
              const idx = INDICES[key];
              const sc  = scores[key];
              if (!sc) return null;
              const biasColor = sc.bias === 'bullish' ? bull : sc.bias === 'bearish' ? bear : warn;
              const price5Bar = h1?.[key]?.length > 5
                ? (h1[key][h1[key].length-1] - h1[key][h1[key].length-6]) / h1[key][h1[key].length-6] * 100
                : null;
              return (
                <div key={key} style={{ background:'var(--bg2)', border:`1px solid ${biasColor}40`, borderRadius:12, padding:12, display:'flex', flexDirection:'column', gap:6 }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                    <div>
                      <div style={{ fontWeight:800, fontSize:13, color: idx.color }}>{idx.short}</div>
                      <div style={{ fontSize:10, color:neu }}>{idx.name}</div>
                    </div>
                    <ScoreRing score={sc.score} total={sc.total} />
                  </div>

                  <div style={{ textAlign:'center', padding:'2px 0' }}>
                    <span style={{ fontWeight:700, fontSize:11, color: biasColor, padding:'2px 8px', background: biasColor+'20', borderRadius:4 }}>
                      {sc.bias === 'bullish' ? '▲ BULLISH' : sc.bias === 'bearish' ? '▼ BEARISH' : '● NEUTRAL'}
                    </span>
                  </div>

                  {/* Factor chips */}
                  <div style={{ display:'flex', flexWrap:'wrap', gap:2 }}>
                    {sc.factors.map(f => (
                      <span key={f.name} title={f.detail} style={{ fontSize:9, padding:'1px 5px', borderRadius:3,
                        background: f.bull === true ? '#22c55e20' : f.bull === false ? '#ef444420' : '#6b728020',
                        color:      f.bull === true ? bull : f.bull === false ? bear : neu,
                        fontWeight:700, cursor:'help' }}>
                        {f.bull === true ? '▲' : f.bull === false ? '▼' : '●'} {f.name}
                      </span>
                    ))}
                  </div>

                  {/* Quick stats */}
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:neu, marginTop:2 }}>
                    <span>RSI {sc.rsi ?? '—'}</span>
                    <span>ATR {sc.atr ?? '—'}</span>
                    <span style={{ color: price5Bar == null ? neu : price5Bar >= 0 ? bull : bear }}>
                      {price5Bar != null ? fmtPct(price5Bar) : '—'} 5-bar
                    </span>
                  </div>

                  {sc.currentPrice && (
                    <div style={{ fontSize:11, color:'var(--text2)', fontWeight:600 }}>
                      Current: {fmtPrice(sc.currentPrice)}
                      {sc.ema50 && <span style={{ fontSize:10, color:neu, marginLeft:6 }}>EMA50: {fmtPrice(sc.ema50)}</span>}
                    </div>
                  )}

                  <Sparkline data={h1?.[key]} color={biasColor} width={130} height={24}/>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── SECTION 7: ICT Key Levels ─────────────────── */}
        <SectionCard>
          <SectionTitle icon="📐" label="ICT Key Levels — Where Price Will React"/>
          <div style={{ fontSize:10, color:neu, marginBottom:8 }}>PDH/PDL = Previous Day High/Low. PWH/PWL = Previous Week High/Low. These are the liquidity pools where institutions hunt stops.</div>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10 }}>
              <thead>
                <tr style={{ color:neu, borderBottom:'1px solid var(--border)' }}>
                  <td style={{ padding:'4px 6px', fontWeight:700 }}>Level</td>
                  {INDEX_KEYS.map(k => <td key={k} style={{ padding:'4px 6px', textAlign:'center', fontWeight:700, color: INDICES[k].color }}>{INDICES[k].short}</td>)}
                </tr>
              </thead>
              <tbody>
                {[
                  { label:'PDH', key:'pdh', color: bear, desc:'Previous Day High — bearish if swept' },
                  { label:'PDL', key:'pdl', color: bull, desc:'Previous Day Low — bullish if swept' },
                  { label:'PWH', key:'pwh', color:'#f97316', desc:'Previous Week High — major resistance' },
                  { label:'PWL', key:'pwl', color:'#06b6d4', desc:'Previous Week Low — major support' },
                  { label:"Today's Open", key:'todayOpen', color:'var(--text2)', desc:'Gap tells institutional intent' },
                ].map(row => (
                  <tr key={row.key} style={{ borderBottom:'1px solid var(--border)22' }}>
                    <td style={{ padding:'5px 6px' }}>
                      <div style={{ color: row.color, fontWeight:700 }}>{row.label}</div>
                      <div style={{ color:neu, fontSize:9 }}>{row.desc}</div>
                    </td>
                    {INDEX_KEYS.map(k => (
                      <td key={k} style={{ padding:'5px 6px', textAlign:'center' }}>
                        <span style={{ fontWeight:600, color:'var(--text1)' }}>
                          {ict[k]?.[row.key] != null ? fmtPrice(ict[k][row.key]) : '—'}
                        </span>
                        {row.key === 'todayOpen' && ict[k]?.openGap != null && (
                          <div style={{ fontSize:9, color: ict[k].openGap > 0 ? bull : bear }}>
                            {fmtPct(ict[k].openGap, 2)} gap
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* ── SECTION 8: Technical Readings ────────────── */}
        <SectionCard>
          <SectionTitle icon="📊" label="Technical Readings per Index"/>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10 }}>
              <thead>
                <tr style={{ color:neu, borderBottom:'1px solid var(--border)' }}>
                  <td style={{ padding:'4px 6px', fontWeight:700 }}>Signal</td>
                  {INDEX_KEYS.map(k => <td key={k} style={{ padding:'4px 6px', textAlign:'center', fontWeight:700, color: INDICES[k].color }}>{INDICES[k].short}</td>)}
                </tr>
              </thead>
              <tbody>
                {/* Market Structure */}
                <tr style={{ borderBottom:'1px solid var(--border)22' }}>
                  <td style={{ padding:'5px 6px', color:neu }}>Market Structure</td>
                  {INDEX_KEYS.map(k => {
                    const ms = scores[k]?.ms;
                    return (
                      <td key={k} style={{ padding:'5px 6px', textAlign:'center', fontWeight:700,
                        color: ms === 'bullish' ? bull : ms === 'bearish' ? bear : warn }}>
                        {ms === 'bullish' ? 'HH/HL ▲' : ms === 'bearish' ? 'LH/LL ▼' : ms === 'ranging' ? 'Ranging' : '—'}
                      </td>
                    );
                  })}
                </tr>

                {/* RSI */}
                <tr style={{ borderBottom:'1px solid var(--border)22' }}>
                  <td style={{ padding:'5px 6px', color:neu }}>RSI(14) Daily</td>
                  {INDEX_KEYS.map(k => {
                    const rsi = scores[k]?.rsi;
                    const c = rsi == null ? neu : rsi < 30 ? bull : rsi > 70 ? bear : 'var(--text1)';
                    return (
                      <td key={k} style={{ padding:'5px 6px', textAlign:'center', color: c, fontWeight:600 }}>
                        {rsi ?? '—'}
                        {rsi != null && <div style={{ fontSize:9, color:neu }}>{rsi<30?'oversold':rsi>70?'overbought':'neutral'}</div>}
                      </td>
                    );
                  })}
                </tr>

                {/* EMA50 */}
                <tr style={{ borderBottom:'1px solid var(--border)22' }}>
                  <td style={{ padding:'5px 6px', color:neu }}>50 EMA (Daily)</td>
                  {INDEX_KEYS.map(k => {
                    const { ema50, currentPrice } = scores[k] || {};
                    const above = ema50 && currentPrice ? currentPrice > ema50 : null;
                    return (
                      <td key={k} style={{ padding:'5px 6px', textAlign:'center', color: above == null ? neu : above ? bull : bear, fontWeight:600 }}>
                        {ema50 ? fmtPrice(ema50) : '—'}
                        {above != null && <div style={{ fontSize:9 }}>{above ? '▲ Above' : '▼ Below'}</div>}
                      </td>
                    );
                  })}
                </tr>

                {/* ATR */}
                <tr style={{ borderBottom:'1px solid var(--border)22' }}>
                  <td style={{ padding:'5px 6px', color:neu }}>ATR(14) Daily</td>
                  {INDEX_KEYS.map(k => (
                    <td key={k} style={{ padding:'5px 6px', textAlign:'center', color:'var(--text1)' }}>
                      {scores[k]?.atr ?? '—'}
                    </td>
                  ))}
                </tr>

                {/* FVG */}
                <tr style={{ borderBottom:'1px solid var(--border)22' }}>
                  <td style={{ padding:'5px 6px', color:neu }}>Fair Value Gap</td>
                  {INDEX_KEYS.map(k => {
                    const f = fvg[k];
                    return (
                      <td key={k} style={{ padding:'5px 6px', textAlign:'center' }}>
                        {f ? (
                          <div style={{ color: f.type==='bullish' ? bull : bear, fontWeight:600 }}>
                            <div style={{ fontSize:9 }}>{f.type==='bullish'?'▲':'▼'} {f.type}</div>
                            <div style={{ fontSize:9, color:neu }}>{fmtPrice(f.bottom)}–{fmtPrice(f.top)}</div>
                          </div>
                        ) : <span style={{ color:neu }}>None</span>}
                      </td>
                    );
                  })}
                </tr>

                {/* Liquidity Sweep */}
                <tr>
                  <td style={{ padding:'5px 6px', color:neu }}>Liquidity Sweep</td>
                  {INDEX_KEYS.map(k => {
                    const s = sweep[k];
                    return (
                      <td key={k} style={{ padding:'5px 6px', textAlign:'center' }}>
                        {s ? (
                          <div style={{ color: s.type==='bullish' ? bull : bear, fontWeight:600, fontSize:9 }}>
                            {s.type==='bullish' ? '✅ Bullish' : '❌ Bearish'}<br/>
                            <span style={{ color:neu }}>{fmtPrice(s.level)}</span>
                          </div>
                        ) : <span style={{ color:neu, fontSize:9 }}>None</span>}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* ── SECTION 9: ICT Session Ranges (SPX) ──────── */}
        {sessions && (
          <SectionCard>
            <SectionTitle icon="🕐" label="ICT Session Ranges — AMD Cycle (SPX)"/>
            <div style={{ fontSize:10, color:neu, marginBottom:8 }}>
              Asian sets the range → London manipulates (sweeps Asian H/L) → NY delivers real move.
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {sessions.slice().reverse().map((day, i) => (
                <div key={day.date} style={{ background:'var(--bg1)', borderRadius:8, padding:10 }}>
                  <div style={{ fontWeight:700, fontSize:11, color:'var(--text2)', marginBottom:6 }}>
                    {i === 0 ? 'Today' : 'Yesterday'} — {day.date}
                  </div>
                  <div style={{ display:'flex', gap:6 }}>
                    {[
                      { key:'asian', label:'Asian', color:'#a78bfa', emoji:'🌙', time:'00-07 UTC' },
                      { key:'london', label:'London', color:'#3b82f6', emoji:'🏛', time:'07-13 UTC' },
                      { key:'ny', label:'NY', color:'#22c55e', emoji:'🗽', time:'13-21 UTC' },
                    ].map(sess => {
                      const d = day[sess.key];
                      return (
                        <div key={sess.key} style={{ flex:1, background:'var(--bg2)', borderRadius:6, padding:8, border:`1px solid ${sess.color}30` }}>
                          <div style={{ fontSize:10, fontWeight:700, color: sess.color, marginBottom:4 }}>
                            {sess.emoji} {sess.label}
                          </div>
                          <div style={{ fontSize:9, color:neu, marginBottom:4 }}>{sess.time}</div>
                          {d ? (
                            <>
                              <div style={{ fontSize:10, color: bull }}>H: {fmtPrice(d.high)}</div>
                              <div style={{ fontSize:10, color: bear }}>L: {fmtPrice(d.low)}</div>
                              <div style={{ fontSize:9, color:neu, marginTop:2 }}>Range: {fmtPrice(d.high - d.low)}</div>
                            </>
                          ) : (
                            <div style={{ fontSize:9, color:neu }}>Not yet / No data</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        {/* ── SECTION 10: Full Confluence Table ─────────── */}
        <SectionCard>
          <SectionTitle icon="📋" label="Confluence Summary — All Drivers vs All Indices"/>
          <div style={{ fontSize:10, color:neu, marginBottom:8 }}>Count green cells per column to decide which index has strongest case.</div>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10 }}>
              <thead>
                <tr style={{ borderBottom:'2px solid var(--border)' }}>
                  <td style={{ padding:'5px 6px', fontWeight:700, color:neu, minWidth:110 }}>Driver</td>
                  <td style={{ padding:'5px 6px', fontWeight:700, color:neu, minWidth:70 }}>Signal</td>
                  {INDEX_KEYS.map(k => (
                    <td key={k} style={{ padding:'5px 6px', textAlign:'center', fontWeight:700, color: INDICES[k].color, minWidth:60 }}>{INDICES[k].short}</td>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* ─ Shared macro rows ─ */}
                {[
                  {
                    driver: 'Fed Rate', shared: true,
                    signal: fedDir == null ? '—' : fedDir === 'cutting' ? `▼ ${fedRate}% Cutting` : fedDir === 'hiking' ? `▲ ${fedRate}% Hiking` : `— ${fedRate}% Pausing`,
                    bull: fedDir !== 'hiking',
                    impact: 'Cutting = expansion = bullish. Hiking = tightening = bearish.',
                  },
                  {
                    driver: 'VIX Fear', shared: true,
                    signal: vixLast != null ? `${vixLast.toFixed(1)} ${vixLast < 15 ? '(calm)' : vixLast < 20 ? '(low)' : vixLast < 30 ? '(elevated)' : '(extreme)'}` : '—',
                    bull: vixLast != null ? vixLast < 20 : null,
                    impact: 'Low VIX = calm markets = bullish. High VIX = fear = bearish stocks.',
                  },
                  {
                    driver: 'Yield Curve', shared: true,
                    signal: yieldCurve != null ? `${yieldCurve > 0 ? '+' : ''}${yieldCurve.toFixed(3)}%` : '—',
                    bull: yieldCurve != null ? yieldCurve > 0 : null,
                    impact: 'Normal (positive) = bullish. Inverted = recession risk = bearish.',
                  },
                  {
                    driver: 'PMI Mfg', shared: true,
                    signal: pmiLast != null ? `${pmiLast.toFixed(1)} ${pmiLast > 50 ? '(exp)' : '(cont)'}` : '—',
                    bull: pmiLast != null ? pmiLast > 50 : null,
                    impact: 'Above 50 = expansion = bullish. Below 50 = contraction = bearish.',
                  },
                  {
                    driver: 'CPI Inflation', shared: true,
                    signal: cpiYoY != null ? `${cpiYoY.toFixed(2)}% YoY` : '—',
                    bull: cpiYoY != null ? cpiYoY < 3 : null,
                    impact: 'Hot CPI (>3%) forces Fed to stay hawkish = bearish stocks.',
                  },
                ].map(row => (
                  <tr key={row.driver} style={{ borderBottom:'1px solid var(--border)22' }}>
                    <td style={{ padding:'5px 6px' }}>
                      <div style={{ fontWeight:600, color:'var(--text1)' }}>{row.driver}</div>
                      <div style={{ fontSize:9, color:neu }}>{row.impact}</div>
                    </td>
                    <td style={{ padding:'5px 6px', fontWeight:700,
                      color: row.bull === null ? neu : row.bull ? bull : bear }}>
                      {row.signal}
                    </td>
                    {INDEX_KEYS.map(k => (
                      <td key={k} style={{ padding:'5px 6px', textAlign:'center', fontWeight:700,
                        color: row.bull === null ? neu : row.bull ? bull : bear }}>
                        {row.bull === null ? '—' : row.bull ? '✅' : '❌'}
                      </td>
                    ))}
                  </tr>
                ))}

                {/* ─ Per-index rows ─ */}
                {['COT','RSI','EMA50','HTF Weekly','HTF Monthly','Structure'].map(factorName => (
                  <tr key={factorName} style={{ borderBottom:'1px solid var(--border)22' }}>
                    <td style={{ padding:'5px 6px', color:'var(--text1)', fontWeight:600 }}>{factorName}</td>
                    <td style={{ padding:'5px 6px', color:neu, fontSize:9 }}>Per index</td>
                    {INDEX_KEYS.map(k => {
                      const f = scores[k]?.factors?.find(x => x.name === factorName) || scores[k]?.factors?.find(x => x.name.startsWith(factorName.split(' ')[0]));
                      return (
                        <td key={k} style={{ padding:'5px 6px', textAlign:'center' }}>
                          {!f ? <span style={{ color:neu }}>—</span> : (
                            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:1 }}>
                              <span style={{ fontWeight:700, color: f.bull === true ? bull : f.bull === false ? bear : neu }}>
                                {f.bull === true ? '✅' : f.bull === false ? '❌' : '➖'}
                              </span>
                              <span style={{ fontSize:8, color:neu }}>{f.detail?.split(' ')[0]}</span>
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}

                {/* ─ Score row ─ */}
                <tr style={{ borderTop:'2px solid var(--border)', background:'var(--bg1)' }}>
                  <td style={{ padding:'6px 6px', fontWeight:800, color:'var(--text1)' }}>TOTAL SCORE</td>
                  <td style={{ padding:'6px 6px', color:neu, fontSize:9 }}>Higher = stronger bias</td>
                  {INDEX_KEYS.map(k => {
                    const sc = scores[k];
                    const pct = sc?.total > 0 ? sc.score / sc.total : 0;
                    const c = pct >= 0.65 ? bull : pct <= 0.35 ? bear : warn;
                    return (
                      <td key={k} style={{ padding:'6px 6px', textAlign:'center', fontWeight:800, color: c, fontSize:12 }}>
                        {sc ? `${sc.score}/${sc.total}` : '—'}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* ── SECTION 11: How to Use ─────────────────────── */}
        <SectionCard style={{ background:'var(--bg1)' }}>
          <SectionTitle icon="📖" label="How to Use This Dashboard"/>
          <div style={{ display:'flex', flexDirection:'column', gap:8, fontSize:11, color:'var(--text2)', lineHeight:1.6 }}>
            <div><strong style={{ color:'var(--text1)' }}>Step 1 — Macro check:</strong> Check the Macro Environment section. If VIX is low, Fed is pausing/cutting, PMI >50 = bullish bias. If opposite = bearish bias.</div>
            <div><strong style={{ color:'var(--text1)' }}>Step 2 — Pick the index:</strong> Look at Relative Strength. In an uptrend, trade the strongest index (NQ often leads). In a downtrend, short the weakest (RUT often falls first).</div>
            <div><strong style={{ color:'var(--text1)' }}>Step 3 — Check SMT:</strong> If SPX/NQ are diverging, do NOT trade that move. Wait for both to agree.</div>
            <div><strong style={{ color:'var(--text1)' }}>Step 4 — Wait for Kill Zone:</strong> Best entries happen at London Open (07-09 UTC) or NY Open (13:30-15:30 UTC). Do not enter in Asian session.</div>
            <div><strong style={{ color:'var(--text1)' }}>Step 5 — AMD timing:</strong> Wait until Distribution phase (after 10:30am EST). The Manipulation phase creates fake moves — don't trade them.</div>
            <div><strong style={{ color:'var(--text1)' }}>Step 6 — Entry:</strong> Use PDH/PDL/FVG levels on a 15-minute chart. If a Liquidity Sweep happened today, that's your signal — enter after the sweep with a tight stop.</div>
            <div><strong style={{ color:'var(--text1)' }}>Score rule:</strong> Only trade when confluence score ≥ 7/11 in your direction. Mixed signals = no trade.</div>
          </div>
        </SectionCard>

        <div style={{ textAlign:'center', fontSize:10, color:neu, paddingBottom:16 }}>
          ForexPro Indices v1.0 · Data: OANDA + Yahoo Finance + FRED · Session: {new Date().toDateString()}
        </div>

      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import AIDashboardPanel from './AIDashboardPanel.jsx';
import ChartModal from './ChartModal.jsx';

const PAIRS = [
  { key:'eurusd', label:'EUR/USD', instr:'EUR_USD', base:'EUR', quote:'USD', cotCode:'099741', cotDir: 1, dp:5, vixEffect:null   },
  { key:'gbpusd', label:'GBP/USD', instr:'GBP_USD', base:'GBP', quote:'USD', cotCode:'096742', cotDir: 1, dp:5, vixEffect:'bear' },
  { key:'usdjpy', label:'USD/JPY', instr:'USD_JPY', base:'JPY', quote:'USD', cotCode:'097741', cotDir:-1, dp:3, vixEffect:'bear' },
  { key:'audusd', label:'AUD/USD', instr:'AUD_USD', base:'AUD', quote:'USD', cotCode:'232741', cotDir: 1, dp:5, vixEffect:'bear' },
  { key:'usdcad', label:'USD/CAD', instr:'USD_CAD', base:'CAD', quote:'USD', cotCode:'090741', cotDir:-1, dp:5, vixEffect:'bull' },
  { key:'usdchf', label:'USD/CHF', instr:'USD_CHF', base:'CHF', quote:'USD', cotCode:'092741', cotDir:-1, dp:5, vixEffect:'bear' },
  { key:'nzdusd', label:'NZD/USD', instr:'NZD_USD', base:'NZD', quote:'USD', cotCode:'112741', cotDir: 1, dp:5, vixEffect:'bear' },
];

// Central bank rates — update monthly
const CB_RATES = { USD:5.33, EUR:4.50, GBP:5.25, JPY:0.10, AUD:4.35, CAD:5.00, CHF:1.75, NZD:5.50 };

// ── OANDA helpers ─────────────────────────────────────────────────────────────
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
  const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
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

async function fetchOHLC(instrument, granularity, count) {
  const creds = getOandaCreds();
  if (!creds) return null;
  const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
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

async function fetchRetailSentiment(instrument, creds) {
  const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
  try {
    const res = await fetch(
      `${base}/instruments/${instrument}/positionBook`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const buckets = data.positionBook?.buckets || [];
    let totalLong = 0, totalShort = 0;
    buckets.forEach(b => {
      totalLong  += parseFloat(b.longCountPercent  || 0);
      totalShort += parseFloat(b.shortCountPercent || 0);
    });
    const total = totalLong + totalShort;
    if (!total) return null;
    const longPct = Math.round(totalLong / total * 100);
    return { longPct, shortPct: 100 - longPct };
  } catch { return null; }
}

// ── COT via CFTC Socrata (CORS-enabled) ──────────────────────────────────────
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

// ── Macro cache + FRED ────────────────────────────────────────────────────────
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

const FRED_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

function parseFredCsv(text) {
  if (!text?.includes(',')) return null;
  const series = text.trim().split('\n').slice(1)
    .map(line => { const [date, val] = line.split(','); return { date, val: parseFloat(val) }; })
    .filter(d => Number.isFinite(d.val));
  return series.length >= 2 ? series : null;
}

async function fetchFredSeries(id, days = 365) {
  const start = new Date();
  start.setDate(start.getDate() - days);
  const fredUrl = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start.toISOString().slice(0, 10)}`;
  try {
    return await Promise.any(FRED_PROXIES.map(async p => {
      const res = await fetch(p(fredUrl), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('bad');
      const text = await res.text();
      const data = parseFredCsv(text);
      if (!data) throw new Error('no data');
      return data;
    }));
  } catch { return null; }
}

const fetchYield10 = () => fetchFredSeries('DGS10', 365);
const fetchYield2  = () => fetchFredSeries('DGS2',  365);

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
    const ts = data.chart?.result?.[0]?.timestamp || [];
    const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const series = ts.map((t, i) => ({ date: new Date(t*1000).toISOString().slice(0,10), val: closes[i] }))
                     .filter(d => Number.isFinite(d.val));
    return series.length >= 2 ? series : null;
  } catch { return null; }
}

// ── Technical indicators ──────────────────────────────────────────────────────
function pctRank(value, history) {
  if (!history?.length) return null;
  return Math.round((history.filter(v => v <= value).length / history.length) * 100);
}

function direction(closes, lookback = 5) {
  if (!closes || closes.length < lookback + 1) return null;
  const n = closes.length;
  return closes[n-1] > closes[n-1-lookback] ? 'rising' : 'falling';
}

function pctChange(closes, lookback = 5) {
  if (!closes || closes.length < lookback + 1) return null;
  const n = closes.length;
  return ((closes[n-1] - closes[n-1-lookback]) / closes[n-1-lookback]) * 100;
}

function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
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
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1-k);
  return +ema.toFixed(6);
}

function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i-1].c),
      Math.abs(candles[i].l - candles[i-1].c)
    ));
  }
  return +(trs.slice(-period).reduce((s, v) => s + v, 0) / period).toFixed(6);
}

// ── Per-pair signal computation ───────────────────────────────────────────────
function computePairSig(pairDef, data) {
  const { base, quote, cotDir } = pairDef;
  const { h1, daily, weekly, cot } = data;
  const sig = {};

  if (h1?.length) {
    sig.price   = h1[h1.length - 1];
    sig.pct5bar = pctChange(h1);
    sig.momentum = direction(h1);
  }

  if (daily?.length) {
    const closes = daily.map(c => c.c);
    sig.rsi       = calcRSI(closes);
    sig.rsiSignal = sig.rsi !== null ? (sig.rsi < 30 ? 'oversold' : sig.rsi > 70 ? 'overbought' : 'neutral') : null;
    sig.ema50     = calcEMA(closes, 50);
    sig.aboveEMA50 = sig.ema50 !== null ? closes[closes.length-1] > sig.ema50 : null;
    sig.atr       = calcATR(daily);
    if (daily.length >= 1) {
      const pd = daily[daily.length - 1];
      sig.pdh = pd.h;
      sig.pdl = pd.l;
    }
  }

  if (weekly?.length >= 1) {
    const pw = weekly[weekly.length - 1];
    sig.pwh = pw.h;
    sig.pwl = pw.l;
  }

  // COT — cotDir: 1 = base currency futures direct signal, -1 = invert (USD base pairs)
  if (cot?.length >= 2) {
    const nets     = cot.map(r => r.net);
    const latest   = cot[0]; // DESC order, newest first
    const hist52   = nets.slice(1);
    const rawPct   = pctRank(latest.net, hist52);
    sig.cotNet   = latest.net;
    sig.cotPct   = cotDir === 1 ? rawPct : (rawPct !== null ? 100 - rawPct : null);
    sig.cotBias  = (latest.net * cotDir >= 0) ? 'bullish' : 'bearish';
    sig.cotDate  = latest.date;
    sig.cotDelta = cot[1] ? latest.net - cot[1].net : 0;
    sig.cotNets  = [...nets].reverse(); // oldest→newest for sparkline

    // COT Extreme flag — 52-week percentile of the raw net position
    const currentNet = nets[0];
    const min52 = Math.min(...nets);
    const max52 = Math.max(...nets);
    const range52 = max52 - min52;
    if (range52 > 0) {
      const cotRawPct = (currentNet - min52) / range52 * 100;
      sig.cotExtreme = cotRawPct >= 80 ? 'EXTREME LONG' : cotRawPct <= 20 ? 'EXTREME SHORT' : null;
    } else {
      sig.cotExtreme = null;
    }
  }

  sig.rateDiff   = +((CB_RATES[base] || 0) - (CB_RATES[quote] || 0)).toFixed(2);
  sig.rateSignal = sig.rateDiff > 0.25 ? 'bullish' : sig.rateDiff < -0.25 ? 'bearish' : 'neutral';

  return sig;
}

// ── Confluence score ──────────────────────────────────────────────────────────
function calcScore(pairDef, pairSig, dxyDir, vixSignal) {
  const factors = [];

  if (pairSig.cotBias)
    factors.push({ label:'COT', bull: pairSig.cotBias === 'bullish', w:2 });

  if (dxyDir) {
    // USD-base pairs (USD/JPY, USD/CAD, USD/CHF): DXY rising = bullish
    // USD-quote pairs (EUR, GBP, AUD, NZD): DXY rising = bearish
    const dxyBull = pairDef.base === 'USD' ? dxyDir === 'rising' : dxyDir === 'falling';
    factors.push({ label:'DXY', bull: dxyBull, w:2 });
  }

  if (pairSig.rateSignal !== 'neutral')
    factors.push({ label:'Rate', bull: pairSig.rateSignal === 'bullish', w:1 });

  if (pairSig.aboveEMA50 !== null && pairSig.aboveEMA50 !== undefined)
    factors.push({ label:'EMA50', bull: pairSig.aboveEMA50, w:1 });

  if (pairSig.momentum)
    factors.push({ label:'Mom', bull: pairSig.momentum === 'rising', w:1 });

  if (pairSig.rsiSignal === 'oversold')   factors.push({ label:'RSI', bull: true,  w:1 });
  if (pairSig.rsiSignal === 'overbought') factors.push({ label:'RSI', bull: false, w:1 });

  if (pairDef.vixEffect && vixSignal) {
    const vixHigh = ['strong_bullish', 'mild_bullish'].includes(vixSignal);
    factors.push({ label:'Risk', bull: pairDef.vixEffect === 'bull' ? vixHigh : !vixHigh, w:1 });
  }

  if (!factors.length) return null;
  const max   = factors.reduce((s, f) => s + f.w, 0);
  const score = factors.filter(f => f.bull).reduce((s, f) => s + f.w, 0);
  return { score, max, factors };
}

// ── AI context ────────────────────────────────────────────────────────────────
function buildAIContext(pairSignals, pairScores, dxyDir, vixSignal, yieldCurve, macro) {
  const now = new Date();
  const utc = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC`;
  const lines = [`=== FOREX PAIRS DASHBOARD — SIGNAL DATA (${utc}) ===`, ''];

  lines.push('CONFLUENCE SCORES:');
  PAIRS.forEach(p => {
    const sc = pairScores[p.key];
    if (sc) lines.push(`  ${p.label}: ${sc.score}/${sc.max} — ${sc.factors.map(f=>(f.bull?'▲':'▼')+f.label).join(', ')}`);
    else    lines.push(`  ${p.label}: no data`);
  });
  lines.push('');

  lines.push('MACRO:');
  if (dxyDir)     lines.push(`  DXY: ${dxyDir} (EUR/USD inverted proxy)`);
  if (vixSignal) {
    const vl = macro.vix?.[macro.vix.length-1];
    lines.push(`  VIX: ${vl?.val?.toFixed(1) ?? '—'} — ${vixSignal}`);
  }
  if (yieldCurve != null) lines.push(`  US Yield Curve (10Y-2Y): ${yieldCurve>0?'+':''}${yieldCurve}% — ${yieldCurve<0?'INVERTED':'Normal'}`);
  lines.push('');

  lines.push('CENTRAL BANK RATES:');
  Object.entries(CB_RATES).forEach(([cur, rate]) => lines.push(`  ${cur}: ${rate}%`));
  lines.push('');

  lines.push('PER-PAIR SIGNALS:');
  PAIRS.forEach(p => {
    const sig = pairSignals[p.key];
    if (!sig) return;
    const parts = [`  ${p.label}:`];
    if (sig.price != null)      parts.push(`Price=${sig.price.toFixed(p.dp)}`);
    if (sig.pct5bar != null)    parts.push(`5bar=${sig.pct5bar>=0?'+':''}${sig.pct5bar.toFixed(3)}%`);
    if (sig.cotPct != null)     parts.push(`COT=${sig.cotPct}th pct(${sig.cotBias})`);
    if (sig.cotExtreme)         parts.push(`COT-Extreme=${sig.cotExtreme}`);
    parts.push(`RateDiff=${sig.rateDiff>=0?'+':''}${sig.rateDiff}%`);
    if (sig.rsi != null)        parts.push(`RSI=${sig.rsi}(${sig.rsiSignal})`);
    if (sig.aboveEMA50 != null) parts.push(`EMA50=${sig.aboveEMA50?'Above':'Below'}`);
    if (sig.atr != null)        parts.push(`ATR=${sig.atr.toFixed(p.dp>3?5:2)}`);
    if (sig.pdh != null)        parts.push(`PDH=${sig.pdh.toFixed(p.dp)} PDL=${sig.pdl.toFixed(p.dp)}`);
    lines.push(parts.join(' | '));
  });

  return lines.join('\n');
}

// ── Sub-components ────────────────────────────────────────────────────────────
function MiniSpark({ values, color = '#00d4aa' }) {
  if (!values || values.length < 2) return null;
  const w = 70, h = 22;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) =>
    `${((i/(values.length-1))*w).toFixed(1)},${(h-((v-min)/range)*(h-4)-2).toFixed(1)}`
  ).join(' ');
  const c = values[values.length-1] >= values[0] ? color : '#ef4444';
  return (
    <svg width={w} height={h} style={{ display:'block' }}>
      <polyline points={pts} fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round"/>
      <circle cx={w} cy={h-((values[values.length-1]-min)/range)*(h-4)-2} r="2" fill={c}/>
    </svg>
  );
}

function CotGauge({ pct }) {
  if (pct === null || pct === undefined)
    return <span style={{ color:'var(--text3)', fontSize:10 }}>COT —</span>;
  const color = pct >= 80 ? '#22c55e' : pct <= 20 ? '#ef4444' : pct >= 60 ? '#86efac' : pct <= 40 ? '#fca5a5' : '#f59e0b';
  const label = pct >= 80 ? 'Extreme Long' : pct <= 20 ? 'Extreme Short' : pct >= 60 ? 'Mod. Long' : pct <= 40 ? 'Mod. Short' : 'Neutral';
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
        <span style={{ fontSize:9, color:'var(--text3)' }}>COT Non-Commercial (52wk)</span>
        <span style={{ fontSize:10, fontWeight:700, color }}>{pct}th pct · {label}</span>
      </div>
      <div style={{ height:6, background:'#1e293b', borderRadius:3, position:'relative', overflow:'hidden' }}>
        <div style={{ position:'absolute', left:0, width:'20%', height:'100%', background:'#ef444433' }}/>
        <div style={{ position:'absolute', right:0, width:'20%', height:'100%', background:'#22c55e33' }}/>
        <div style={{ position:'absolute', left:`${Math.min(pct,97)}%`, top:0, width:3, height:'100%',
          background:color, borderRadius:2, transform:'translateX(-50%)' }}/>
      </div>
    </div>
  );
}

function PairCard({ pairDef, sig, score, sentiment }) {
  const { label, base, quote, dp } = pairDef;
  const BULL = '#22c55e', BEAR = '#ef4444';
  const scorePct   = score ? score.score / score.max : null;
  const scoreColor = scorePct === null ? '#64748b' : scorePct >= 0.6 ? BULL : scorePct <= 0.4 ? BEAR : '#f59e0b';
  const bias       = scorePct !== null ? (scorePct >= 0.6 ? 'BULLISH' : scorePct <= 0.4 ? 'BEARISH' : 'MIXED') : '—';
  const fmtP = v => v == null ? '—' : v.toFixed(dp);
  const momColor   = sig.momentum === 'rising' ? BULL : sig.momentum === 'falling' ? BEAR : '#64748b';
  const rateColor  = sig.rateDiff > 0 ? BULL : sig.rateDiff < 0 ? BEAR : '#64748b';

  // Retail sentiment display logic (contrarian)
  let sentColor = '#64748b', sentLabel = 'Mixed';
  if (sentiment) {
    if (sentiment.longPct > 65) { sentColor = BEAR; sentLabel = 'Contrarian SHORT'; }
    else if (sentiment.longPct < 35) { sentColor = BULL; sentLabel = 'Contrarian LONG'; }
  }

  return (
    <div style={{
      background:'var(--card)',
      border:`1px solid ${score && scorePct >= 0.6 ? '#22c55e44' : score && scorePct <= 0.4 ? '#ef444433' : 'var(--border)'}`,
      borderRadius:8, padding:'12px 14px', display:'flex', flexDirection:'column', gap:8,
    }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
        <div>
          <span style={{ fontSize:15, fontWeight:800, color:'var(--text)', letterSpacing:0.5 }}>{label}</span>
          <span style={{ fontSize:9, color:'var(--text3)', marginLeft:6 }}>
            {CB_RATES[base]}% / {CB_RATES[quote]}%
          </span>
        </div>
        {score && (
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:11, fontWeight:700, color:scoreColor }}>{bias}</div>
            <div style={{ fontSize:9, color:'var(--text3)' }}>{score.score}/{score.max} pts</div>
          </div>
        )}
      </div>

      {/* Price */}
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <span style={{ fontSize:20, fontWeight:800, fontFamily:'monospace', color:'var(--text)' }}>
          {fmtP(sig.price)}
        </span>
        {sig.pct5bar != null && (
          <span style={{ fontSize:12, fontWeight:700, color:momColor }}>
            {sig.momentum === 'rising' ? '▲' : '▼'}{' '}
            {sig.pct5bar >= 0 ? '+' : ''}{sig.pct5bar.toFixed(3)}%
          </span>
        )}
      </div>

      {/* COT */}
      <CotGauge pct={sig.cotPct} />
      {sig.cotNets && (
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <MiniSpark values={sig.cotNets} color={sig.cotBias === 'bullish' ? BULL : BEAR} />
          <div style={{ fontSize:9, color:'var(--text3)' }}>
            {sig.cotDelta !== undefined && (sig.cotDelta >= 0 ? '+' : '')}{sig.cotDelta?.toLocaleString()} wk
            <br/>{sig.cotDate}
          </div>
          {/* COT Extreme badge */}
          {sig.cotExtreme && (
            <span
              title="Top/bottom 20% of 52wk net-position range — potential reversal zone"
              style={{
                fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:4,
                color:      sig.cotExtreme.includes('LONG') ? '#f43f5e' : '#22c55e',
                background: sig.cotExtreme.includes('LONG') ? '#f43f5e18' : '#22c55e18',
                border:     `1px solid ${sig.cotExtreme.includes('LONG') ? '#f43f5e44' : '#22c55e44'}`,
              }}>
              ⚠ {sig.cotExtreme}
            </span>
          )}
        </div>
      )}
      {/* COT Extreme tooltip note */}
      {sig.cotExtreme && (
        <div style={{ fontSize:9, color:'var(--text3)', fontStyle:'italic' }}>
          (top/bottom 20% of 52wk range = potential reversal)
        </div>
      )}

      {/* Retail Sentiment */}
      {sentiment && (
        <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
          <span style={{ fontSize:9, color:'var(--text3)' }}>Retail Sentiment:</span>
          <span style={{
            fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:4,
            color:      sentColor,
            background: sentiment.longPct > 65 ? '#ef444418' : sentiment.longPct < 35 ? '#22c55e18' : '#64748b18',
            border:     `1px solid ${sentiment.longPct > 65 ? '#ef444433' : sentiment.longPct < 35 ? '#22c55e33' : '#64748b33'}`,
          }}>
            🐟 {sentiment.longPct}% Retail Long
          </span>
          <span style={{ fontSize:9, fontWeight:600, color:sentColor }}>{sentLabel}</span>
        </div>
      )}

      {/* Rate differential */}
      <div style={{ display:'flex', gap:8, alignItems:'center', fontSize:10 }}>
        <span style={{ color:'var(--text3)' }}>Rate Diff:</span>
        <span style={{ fontWeight:700, color:rateColor }}>
          {sig.rateDiff >= 0 ? '+' : ''}{sig.rateDiff}%
        </span>
        <span style={{ color:'var(--text3)', fontSize:9 }}>
          {base} {CB_RATES[base]}% vs {quote} {CB_RATES[quote]}%
        </span>
      </div>

      {/* Technicals */}
      {(sig.rsi != null || sig.aboveEMA50 != null) && (
        <div style={{ display:'flex', gap:10, flexWrap:'wrap', fontSize:10 }}>
          {sig.rsi != null && (
            <span>
              RSI{' '}
              <span style={{ fontWeight:700, color:sig.rsiSignal==='oversold'?BULL:sig.rsiSignal==='overbought'?BEAR:'var(--text)' }}>
                {sig.rsi}
              </span>{' '}
              <span style={{ color:'var(--text3)' }}>({sig.rsiSignal})</span>
            </span>
          )}
          {sig.aboveEMA50 != null && (
            <span>
              EMA50{' '}
              <span style={{ fontWeight:700, color:sig.aboveEMA50?BULL:BEAR }}>
                {sig.aboveEMA50 ? 'Above' : 'Below'}
              </span>
            </span>
          )}
          {sig.atr != null && (
            <span style={{ color:'var(--text3)' }}>
              ATR {sig.atr.toFixed(dp > 3 ? 4 : 2)}
            </span>
          )}
        </div>
      )}

      {/* Key levels */}
      {sig.pdh != null && (
        <div style={{ fontSize:9, color:'var(--text3)', fontFamily:'monospace' }}>
          PDH {fmtP(sig.pdh)} · PDL {fmtP(sig.pdl)}
          {sig.pwh != null && <span> | PWH {fmtP(sig.pwh)} · PWL {fmtP(sig.pwl)}</span>}
        </div>
      )}

      {/* Confluence factors */}
      {score?.factors?.length > 0 && (
        <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
          {score.factors.map(f => (
            <span key={f.label} style={{
              fontSize:9, padding:'1px 5px', borderRadius:3, fontWeight:600,
              color:      f.bull ? BULL : BEAR,
              background: f.bull ? '#22c55e18' : '#ef444418',
              border:     `1px solid ${f.bull ? '#22c55e33' : '#ef444433'}`,
            }}>
              {f.bull ? '▲' : '▼'} {f.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ForexPairsDashboard() {
  const [pairData, setPairData]       = useState({});
  const [macro, setMacro]             = useState({});
  const [loading, setLoading]         = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [sentimentMap, setSentimentMap] = useState({});
  const [chartInstrument, setChartInstrument] = useState(null);
  const hasOanda = !!getOandaCreds();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vixData, macroCache, ...pairResultsArr] = await Promise.all([
        fetchVIX(),
        fetchMacroCache(),
        ...PAIRS.map(p => Promise.all([
          fetchCloses(p.instr, 'H1', 60),
          fetchOHLC(p.instr, 'D', 60),
          fetchOHLC(p.instr, 'W', 5),
          fetchCOTHistory(p.cotCode, 54),
        ])),
      ]);

      const newPairData = {};
      PAIRS.forEach((p, i) => {
        const [h1, daily, weekly, cot] = pairResultsArr[i];
        newPairData[p.key] = { h1, daily, weekly, cot };
      });

      const resolvedVix = macroCache?.vix?.length ? macroCache.vix : vixData;

      const [y10Data, y2Data] = await Promise.all([
        macroCache?.dgs10?.length ? macroCache.dgs10 : fetchYield10(),
        macroCache?.dgs2?.length  ? macroCache.dgs2  : fetchYield2(),
      ]);

      // Fetch retail sentiment
      const creds = getOandaCreds();
      if (creds) {
        const sentResults = await Promise.allSettled(
          PAIRS.map(async p => {
            const s = await fetchRetailSentiment(p.instr, creds);
            return { key: p.key, s };
          })
        );
        const sm = {};
        sentResults.forEach(r => { if (r.status === 'fulfilled' && r.value.s) sm[r.value.key] = r.value.s; });
        setSentimentMap(sm);
      }

      setPairData(newPairData);
      setMacro({ vix: resolvedVix, y10: y10Data, y2: y2Data });
      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Derive macro signals
  const dxyCloses = pairData.eurusd?.h1;
  const dxyDir    = dxyCloses ? (direction(dxyCloses) === 'falling' ? 'rising' : 'falling') : null;

  let vixSignal = null, vixLast = null;
  if (macro.vix?.length >= 5) {
    vixLast = macro.vix[macro.vix.length - 1];
    const vixPrev   = macro.vix[Math.max(0, macro.vix.length - 6)];
    const vixChange = vixLast.val - vixPrev.val;
    const elevated  = vixLast.val >= 20;
    vixSignal = (elevated && vixChange > 0.5) ? 'strong_bullish'
              : elevated ? 'mild_bullish'
              : (vixChange > 0.5) ? 'watch'
              : 'neutral';
  }

  let yieldCurve = null;
  if (macro.y10?.length && macro.y2?.length) {
    yieldCurve = +(macro.y10[macro.y10.length-1].val - macro.y2[macro.y2.length-1].val).toFixed(3);
  }

  const pairSignals = {}, pairScores = {};
  PAIRS.forEach(p => {
    const sig = computePairSig(p, pairData[p.key] || {});
    pairSignals[p.key] = sig;
    pairScores[p.key]  = calcScore(p, sig, dxyDir, vixSignal);
  });

  const aiContext = buildAIContext(pairSignals, pairScores, dxyDir, vixSignal, yieldCurve, macro);

  const card = { background:'var(--card)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px' };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* Header */}
      <div style={{ padding:'10px 16px', borderBottom:'1px solid var(--border)', display:'flex',
        alignItems:'center', gap:10, flexShrink:0, flexWrap:'wrap' }}>
        <div>
          <span style={{ fontSize:14, fontWeight:700, color:'var(--text)' }}>💱 Forex Pairs</span>
          <span style={{ fontSize:10, color:'var(--text3)', marginLeft:8 }}>7 Majors — COT · Carry · Technicals</span>
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
          <span style={{ fontSize:11, color:'#f59e0b' }}>
            ⚠ Connect OANDA in Screener settings for live prices &amp; technicals. COT &amp; carry data load regardless.
          </span>
        </div>
      )}

      <div style={{ flex:1, overflowY:'auto', padding:'12px 16px' }}>

        {/* AI Panel */}
        <AIDashboardPanel
          context={aiContext}
          quickPrompts={[
            'Which forex pair has the best setup right now?',
            'Best carry trade opportunity this week?',
            'Risk-on vs risk-off pairs — DXY direction?',
            'COT extremes: any contrarian plays?',
          ]}
        />

        {/* Macro strip */}
        <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
          <div style={{ ...card, display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:11, color:'var(--text3)' }}>DXY</span>
            {dxyDir ? (
              <span style={{ fontSize:12, fontWeight:700, color:dxyDir==='rising'?'#22c55e':'#ef4444' }}>
                {dxyDir === 'rising' ? '▲ Rising' : '▼ Falling'}
              </span>
            ) : <span style={{ fontSize:11, color:'var(--text3)' }}>—</span>}
          </div>

          <div style={{ ...card, display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:11, color:'var(--text3)' }}>VIX</span>
            {vixLast ? (
              <span style={{ fontSize:12, fontWeight:700,
                color:['strong_bullish','mild_bullish'].includes(vixSignal)?'#f59e0b':'#22c55e' }}>
                {vixLast.val.toFixed(1)} —{' '}
                {vixSignal==='strong_bullish'?'Fear':vixSignal==='mild_bullish'?'Elevated':vixSignal==='watch'?'Rising':'Low'}
              </span>
            ) : <span style={{ fontSize:11, color:'var(--text3)' }}>—</span>}
          </div>

          <div style={{ ...card, display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:11, color:'var(--text3)' }}>US 10Y-2Y</span>
            {yieldCurve !== null ? (
              <span style={{ fontSize:12, fontWeight:700, color:yieldCurve<0?'#f59e0b':'var(--text)' }}>
                {yieldCurve>0?'+':''}{yieldCurve}%{yieldCurve<0?' ⚠ Inv.':''}
              </span>
            ) : <span style={{ fontSize:11, color:'var(--text3)' }}>—</span>}
          </div>

          <div style={{ ...card, display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:11, color:'var(--text3)' }}>Risk</span>
            <span style={{ fontSize:12, fontWeight:700,
              color:vixSignal==='neutral'?'#22c55e':['strong_bullish','mild_bullish'].includes(vixSignal)?'#ef4444':'#f59e0b' }}>
              {vixSignal==='neutral'?'Risk-On':['strong_bullish','mild_bullish'].includes(vixSignal)?'Risk-Off':'Caution'}
            </span>
          </div>
        </div>

        {/* Rate table */}
        <div style={{ ...card, marginBottom:14 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--text3)', marginBottom:8 }}>
            CARRY DIFFERENTIALS (Base CB Rate − Quote CB Rate)
          </div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
            {PAIRS.map(p => {
              const diff = +((CB_RATES[p.base]||0) - (CB_RATES[p.quote]||0)).toFixed(2);
              const c = diff > 0.25 ? '#22c55e' : diff < -0.25 ? '#ef4444' : '#64748b';
              return (
                <div key={p.key} style={{ display:'flex', gap:6, alignItems:'center',
                  padding:'4px 8px', background:'var(--bg2)', borderRadius:5, fontSize:10 }}>
                  <span style={{ fontWeight:700, color:'var(--text)' }}>{p.label}</span>
                  <span style={{ fontWeight:700, color:c }}>{diff>=0?'+':''}{diff}%</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Pair cards */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(300px, 1fr))', gap:12 }}>
          {PAIRS.map(p => (
            <div key={p.key} style={{ display:'flex', flexDirection:'column', gap:4 }}>
              <PairCard
                pairDef={p}
                sig={pairSignals[p.key]}
                score={pairScores[p.key]}
                sentiment={sentimentMap[p.key]}
              />
              <button onClick={() => setChartInstrument({ symbol: p.label })} style={{
                fontSize:10, padding:'3px 8px', borderRadius:4, cursor:'pointer',
                background:'#8b5cf622', color:'#a78bfa', border:'1px solid #8b5cf644',
                alignSelf:'flex-start',
              }}>📊 Chart</button>
            </div>
          ))}
        </div>

      </div>

      {chartInstrument && (
        <ChartModal instrument={chartInstrument} onClose={() => setChartInstrument(null)} />
      )}
    </div>
  );
}

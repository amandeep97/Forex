import { useState, useCallback, useEffect, useRef } from 'react';
import ChartModal from './ChartModal.jsx';
import { computeValueArea, computeFib } from '../utils/smcHelpers';
import { detectOTE, detectBreakerBlocks } from '../utils/smcAnalysis';
import { sendTelegram, showBrowserNotification, requestBrowserPermission, getGrade, formatTelegramMsg } from '../utils/notifications';

const PAIRS = [
  'XAG_USD',
  'EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','NZD_USD','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_AUD','EUR_CAD','EUR_CHF',
  'GBP_JPY','GBP_AUD','GBP_CAD','GBP_CHF',
  'AUD_JPY','CAD_JPY','CHF_JPY','NZD_JPY',
];

const KILLZONES = [
  { name:'Asian KZ',     s:0,    e:240,  color:'#f59e0b' },
  { name:'London KZ',    s:420,  e:600,  color:'#8b5cf6' },
  { name:'London Close', s:660,  e:720,  color:'#38bdf8' },
  { name:'NY AM KZ',     s:780,  e:960,  color:'#22c55e' },
  { name:'NY PM KZ',     s:1080, e:1200, color:'#f97316' },
];

// Best UTC session hours per pair
const PAIR_SESSIONS = {
  EUR_USD:{ f:8,  t:17 }, GBP_USD:{ f:8,  t:17 }, USD_JPY:{ f:0,  t:12 },
  USD_CHF:{ f:8,  t:17 }, AUD_USD:{ f:22, t:9  }, NZD_USD:{ f:22, t:9  },
  USD_CAD:{ f:13, t:22 }, EUR_GBP:{ f:8,  t:17 }, EUR_JPY:{ f:8,  t:13 },
  EUR_AUD:{ f:8,  t:13 }, EUR_CAD:{ f:13, t:17 }, EUR_CHF:{ f:8,  t:17 },
  GBP_JPY:{ f:8,  t:13 }, GBP_AUD:{ f:8,  t:12 }, GBP_CAD:{ f:13, t:17 },
  GBP_CHF:{ f:8,  t:17 }, AUD_JPY:{ f:0,  t:9  }, CAD_JPY:{ f:8,  t:17 },
  CHF_JPY:{ f:8,  t:13 }, NZD_JPY:{ f:0,  t:9  }, XAG_USD:{ f:8,  t:17 },
};

// Expected direction for each pair when DXY is BULLISH
// null = cross pair, DXY less relevant
const DXY_BULL_DIR = {
  EUR_USD:'short', GBP_USD:'short', USD_JPY:'long',  USD_CHF:'long',
  AUD_USD:'short', NZD_USD:'short', USD_CAD:'long',  XAG_USD:'short',
  EUR_JPY:null, EUR_GBP:null, EUR_AUD:null, EUR_CAD:null, EUR_CHF:null,
  GBP_JPY:null, GBP_AUD:null, GBP_CAD:null, GBP_CHF:null,
  AUD_JPY:null, CAD_JPY:null, CHF_JPY:null, NZD_JPY:null,
};

function getCurrentKZ() {
  const now  = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return KILLZONES.find(kz => mins >= kz.s && mins < kz.e) || null;
}

function getNextKZ() {
  const now  = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  let best = null, bestDiff = Infinity;
  for (const kz of KILLZONES) {
    const diff = kz.s > mins ? kz.s - mins : kz.s + 1440 - mins;
    if (diff < bestDiff) { bestDiff = diff; best = { ...kz, minsUntil: diff }; }
  }
  return best;
}

function isInSession(pairKey) {
  const s = PAIR_SESSIONS[pairKey];
  if (!s) return null;
  const h = new Date().getUTCHours();
  return s.f < s.t ? (h >= s.f && h < s.t) : (h >= s.f || h < s.t);
}

function getDOWInfo() {
  const day = new Date().getUTCDay();
  const labels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (day === 1) return { ok: true,  label: 'Mon', note: 'Rule 1 target' };
  if (day === 4) return { ok: true,  label: 'Thu', note: 'Rule 2 target' };
  return         { ok: false, label: labels[day], note: 'Not a target day' };
}

function getDXYBias(results) {
  const eur = results['EUR_USD'];
  if (!eur?.h4) return null;
  if (eur.h4.structure === 'bearish') return 'bull'; // EUR/USD down = DXY up
  if (eur.h4.structure === 'bullish') return 'bear';
  return null;
}

function isDXYAligned(pairKey, data, dxyBias) {
  if (!dxyBias) return null;
  const expectedDir = DXY_BULL_DIR[pairKey];
  if (expectedDir === undefined || expectedDir === null) return null;
  const actualDir = data?.signal?.dir ??
    (data?.h4?.structure === 'bullish' ? 'long'  :
     data?.h4?.structure === 'bearish' ? 'short' : null);
  if (!actualDir) return null;
  const expectedSignalDir = dxyBias === 'bull' ? expectedDir : (expectedDir === 'long' ? 'short' : 'long');
  return actualDir === expectedSignalDir;
}

function getCreds() {
  const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
  if (c?.apiKey) { const _e = localStorage.getItem('oanda_env'); return _e !== null ? { ...c, practice: _e !== 'live' } : c; }
  return { apiKey: localStorage.getItem('oanda_key'), practice: localStorage.getItem('oanda_env') !== 'live' };
}

async function fetchOHLC(instrument, granularity, count) {
  const { apiKey, practice } = getCreds();
  if (!apiKey) return null;
  const base = practice !== false
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  try {
    const r = await fetch(
      `${base}/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return (d.candles || [])
      .filter(c => c.complete)
      .map(c => ({ o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, v: c.volume||1, t: c.time }));
  } catch { return null; }
}

// ── SMC helpers ───────────────────────────────────────────────────────────────

function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0.001;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const pc = candles[i - 1].c;
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
  }
  return sum / period;
}

function detectStructure(candles) {
  if (!candles || candles.length < 10) return 'ranging';
  const look = 3, n = candles.length;
  const highs = [], lows = [];
  for (let i = look; i < n - look; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= look; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) hi = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) lo = false;
    }
    if (hi) highs.push(candles[i].h);
    if (lo)  lows.push(candles[i].l);
  }
  if (highs.length < 2 || lows.length < 2) return 'ranging';
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  if (h2 > h1 && l2 > l1) return 'bullish';
  if (h2 < h1 && l2 < l1) return 'bearish';
  return 'ranging';
}

function detectOBs(candles) {
  if (!candles || candles.length < 10) return [];
  const n   = candles.length;
  const avg = candles.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / n || 1;
  const obs = [];
  for (let i = 1; i < n - 3; i++) {
    const c = candles[i], nx = candles[i + 1], nn = candles[i + 2];
    if (Math.abs(nn.c - nx.o) < avg * 1.2) continue;

    if (c.c < c.o && nx.c > nx.o && nn.c > c.o) {
      // Bullish OB — mitigated if any later candle closes below OB low
      const mitigated = candles.slice(i + 3).some(x => x.c < c.l);
      if (!mitigated) obs.push({ type: 'bullish', top: c.o, bottom: c.c, low: c.l });
    }
    if (c.c > c.o && nx.c < nx.o && nn.c < c.o) {
      // Bearish OB — mitigated if any later candle closes above OB high
      const mitigated = candles.slice(i + 3).some(x => x.c > c.h);
      if (!mitigated) obs.push({ type: 'bearish', top: c.c, bottom: c.o, high: c.h });
    }
  }
  return obs.slice(-10);
}

function detectFVGs(candles) {
  if (!candles || candles.length < 5) return [];
  const avg = candles.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / candles.length || 1;
  const fvgs = [];
  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i], c3 = candles[i + 2];
    const gap = c1.h < c3.l ? c3.l - c1.h : (c1.l > c3.h ? c1.l - c3.h : 0);
    if (gap < avg * 0.1) continue;
    if (c1.h < c3.l) fvgs.push({ type: 'bullish', top: c3.l, bottom: c1.h });
    else              fvgs.push({ type: 'bearish', top: c1.l, bottom: c3.h });
  }
  return fvgs.slice(-10);
}

function analyzeTimeframe(candles) {
  if (!candles || candles.length < 20) return null;
  const cp  = candles[candles.length - 1].c;
  const atr = computeATR(candles);
  const structure = detectStructure(candles);

  const recent    = candles.slice(-20);
  const swingHigh = Math.max(...recent.map(c => c.h));
  const swingLow  = Math.min(...recent.map(c => c.l));
  const midpoint  = (swingHigh + swingLow) / 2;
  const zone      = cp < midpoint ? 'discount' : 'premium';

  const obs  = detectOBs(candles);
  const fvgs = detectFVGs(candles);

  const bullOB = obs.find(ob =>
    ob.type === 'bullish' && ob.top < midpoint &&
    cp >= ob.bottom && cp <= ob.top + atr
  ) || null;

  const bearOB = obs.find(ob =>
    ob.type === 'bearish' && ob.bottom > midpoint &&
    cp <= ob.top && cp >= ob.bottom - atr
  ) || null;

  const bullFVG = fvgs.find(f =>
    f.type === 'bullish' && f.top < midpoint &&
    cp >= f.bottom - atr * 0.5 && cp <= f.top + atr * 0.5
  ) || null;

  const bearFVG = fvgs.find(f =>
    f.type === 'bearish' && f.bottom > midpoint &&
    cp >= f.bottom - atr * 0.5 && cp <= f.top + atr * 0.5
  ) || null;

  const ote = detectOTE(candles);
  const bb  = detectBreakerBlocks(candles);

  return { cp, atr, structure, zone, swingHigh, swingLow, bullOB, bearOB, bullFVG, bearFVG, ote, bb };
}

// ── Liquidity path check — finds pools blocking the path to TP ────────────────
function checkLiqPath(dir, entry, tp, h1Candles) {
  if (!h1Candles || h1Candles.length < 20) return null;
  const look = 3, n = h1Candles.length;
  const highs = [], lows = [];
  for (let i = look; i < n - look; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= look; j++) {
      if (h1Candles[i].h <= h1Candles[i-j].h || h1Candles[i].h <= h1Candles[i+j].h) hi = false;
      if (h1Candles[i].l >= h1Candles[i-j].l || h1Candles[i].l >= h1Candles[i+j].l) lo = false;
    }
    if (hi) highs.push(h1Candles[i].h);
    if (lo)  lows.push(h1Candles[i].l);
  }
  if (dir === 'long') {
    // BSL (equal highs / swing highs) sitting between entry and TP = will get swept first
    const pools = highs.filter(h => h > entry * 1.00005 && h < tp * 0.9999);
    return pools.length ? Math.min(...pools) : null;
  } else {
    // SSL (equal lows / swing lows) sitting between entry and TP
    const pools = lows.filter(l => l < entry * 0.99995 && l > tp * 1.0001);
    return pools.length ? Math.max(...pools) : null;
  }
}

// ── Signal generation ────────────────────────────────────────────────────────
function getSignal(h4, h1, m15, h1Candles) {
  if (!h4 || !h1 || !m15) return null;

  const longOK =
    h4.structure === 'bullish' &&          // H4 must be bullish
    h1.structure !== 'bearish' &&          // H1 must NOT oppose H4
    h1.zone === 'discount' &&              // H1 in pullback zone
    m15.zone === 'discount' &&             // M15 in entry zone
    m15.structure !== 'bearish' &&         // M15 not opposing
    (m15.bullOB || m15.bullFVG);           // M15 POI for entry

  const shortOK =
    h4.structure === 'bearish' &&          // H4 must be bearish
    h1.structure !== 'bullish' &&          // H1 must NOT oppose H4
    h1.zone === 'premium' &&               // H1 in pullback zone
    m15.zone === 'premium' &&              // M15 in entry zone
    m15.structure !== 'bullish' &&         // M15 not opposing
    (m15.bearOB || m15.bearFVG);           // M15 POI for entry

  if (!longOK && !shortOK) return null;

  const dir     = longOK ? 'long' : 'short';
  const entry   = m15.cp;
  const minDist = m15.atr * 2.5;
  let sl;

  if (dir === 'long') {
    const structural = Math.min(
      m15.bullOB?.low     ?? Infinity,
      m15.bullFVG?.bottom ?? Infinity,
      m15.swingLow
    ) - m15.atr * 0.15;
    sl = Math.min(structural, entry - minDist);
  } else {
    const structural = Math.max(
      m15.bearOB?.high ?? -Infinity,
      m15.bearFVG?.top ?? -Infinity,
      m15.swingHigh
    ) + m15.atr * 0.15;
    sl = Math.max(structural, entry + minDist);
  }

  const risk = Math.abs(entry - sl);
  const tp   = dir === 'long' ? entry + risk * 2 : entry - risk * 2;
  const rr   = +(Math.abs(tp - entry) / risk).toFixed(1);

  const liqBlock = checkLiqPath(dir, entry, tp, h1Candles);
  const kz       = getCurrentKZ();

  // Quality score (max 5)
  let quality = 0;
  if (kz)                                                               quality++; // right timing
  if (h1.structure === h4.structure)                                    quality++; // H1 fully aligns H4
  if (m15.structure === h4.structure)                                   quality++; // M15 fully aligns too
  if ((dir==='long' && m15.bullOB) || (dir==='short' && m15.bearOB))   quality++; // OB entry > FVG
  if ((dir==='long' && m15.ote?.bull) || (dir==='short' && m15.ote?.bear) ||
      (dir==='long' && m15.bb?.bull)  || (dir==='short' && m15.bb?.bear))  quality++; // OTE or BB confluence

  // Blocking liquidity = hard cap at grade B
  if (liqBlock) quality = Math.min(quality, 1);

  return { dir, entry, sl, tp, rr, liqBlock, kz, quality };
}

// ── Formatting ────────────────────────────────────────────────────────────────

const fmtPair = p => p.replace('_', '/');

function fmtPrice(pair, price) {
  const isJpy   = pair.includes('JPY');
  const isMetal = pair.startsWith('XA');
  return price?.toFixed(isMetal ? 3 : isJpy ? 3 : 5) ?? '—';
}

function fmtDist(pair, dist) {
  if (!dist) return '—';
  const isMetal = pair.startsWith('XA');
  const isJpy   = pair.includes('JPY');
  if (isMetal) return `$${Math.abs(dist).toFixed(3)}`;
  const pips = Math.round(Math.abs(dist) * (isJpy ? 100 : 10000));
  return `${pips}p`;
}

function alignScore(h4, h1, m15) {
  if (!h4 || !h1 || !m15) return 0;
  let s = 0;
  if (h4.structure === 'bullish' || h4.structure === 'bearish') s++;
  if (h1.structure === h4.structure) s++;
  if ((h4.structure === 'bullish' && m15.zone === 'discount') ||
      (h4.structure === 'bearish' && m15.zone === 'premium')) s++;
  if (m15.bullOB || m15.bearOB || m15.bullFVG || m15.bearFVG) s++;
  return s;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const bull = '#22c55e', bear = '#ef4444', neu = '#6b7280';

function TFRow({ label, data }) {
  if (!data) return null;
  const sc = data.structure === 'bullish' ? bull : data.structure === 'bearish' ? bear : neu;
  const zc = data.zone === 'discount' ? bull : bear;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, marginBottom:2 }}>
      <span style={{ color:neu, width:28, flexShrink:0 }}>{label}</span>
      <span style={{ color:sc, fontWeight:600, width:60 }}>{data.structure}</span>
      <span style={{ color:zc, fontSize:11, background:'rgba(255,255,255,0.06)', padding:'1px 6px', borderRadius:4 }}>
        {data.zone}
      </span>
      {(data.bullOB || data.bearOB) && (
        <span style={{ fontSize:10, color:'#f59e0b', background:'rgba(245,158,11,0.15)', padding:'1px 5px', borderRadius:4 }}>OB</span>
      )}
      {(data.bullFVG || data.bearFVG) && (
        <span style={{ fontSize:10, color:'#818cf8', background:'rgba(129,140,248,0.15)', padding:'1px 5px', borderRadius:4 }}>FVG</span>
      )}
      {(data.bb?.bull || data.bb?.bear) && (
        <span style={{ fontSize:10, color:'#f97316', background:'rgba(249,115,22,0.15)', padding:'1px 5px', borderRadius:4 }}>BB</span>
      )}
      {(data.ote?.bull || data.ote?.bear) && (
        <span style={{ fontSize:10, color:'#06b6d4', background:'rgba(6,182,212,0.15)', padding:'1px 5px', borderRadius:4 }}>OTE</span>
      )}
    </div>
  );
}

// Quality star rating
function QualityStars({ q }) {
  return (
    <div style={{ display:'flex', gap:2, alignItems:'center' }}>
      {[0,1,2,3,4].map(i => (
        <span key={i} style={{ fontSize:10, color: i < q ? '#f59e0b' : '#1e293b' }}>★</span>
      ))}
      <span style={{ fontSize:9, color:'#64748b', marginLeft:3 }}>
        {q >= 5 ? 'A+' : q === 4 ? 'A' : q === 3 ? 'B+' : q === 2 ? 'B' : 'C'}
      </span>
    </div>
  );
}

const BC = { bullish:'#00d4aa', bearish:'#ef4444', neutral:'#64748b' };
const BA = { bullish:'▲', bearish:'▼', neutral:'—' };

function MTFConsensus({ h4, h1, m15 }) {
  const tfs = [{ l:'H4', b:h4?.structure }, { l:'H1', b:h1?.structure }, { l:'M15', b:m15?.structure }];
  const bulls = tfs.filter(t => t.b === 'bullish').length;
  const bears = tfs.filter(t => t.b === 'bearish').length;
  const cons  = bulls >= 2 ? 'BULL' : bears >= 2 ? 'BEAR' : 'MIXED';
  const cc    = bulls >= 2 ? '#00d4aa' : bears >= 2 ? '#ef4444' : '#f59e0b';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8,
      padding:'5px 8px', borderRadius:6, background:'#ffffff06', border:'1px solid rgba(255,255,255,0.06)' }}>
      {tfs.map(tf => (
        <div key={tf.l} style={{ display:'flex', alignItems:'center', gap:2 }}>
          <span style={{ fontSize:9, color:'#475569' }}>{tf.l}</span>
          <span style={{ fontSize:11, color:BC[tf.b||'neutral'], fontWeight:800 }}>{BA[tf.b||'neutral']}</span>
        </div>
      ))}
      <div style={{ marginLeft:'auto', fontSize:10, fontWeight:800, color:cc,
        background:`${cc}18`, padding:'1px 7px', borderRadius:5, border:`1px solid ${cc}33` }}>
        {cons}
      </div>
    </div>
  );
}

function PairCard({ pair, data, loading: cardLoading, onOpenChart }) {
  const { h4, h1, m15, signal, va, fib } = data || {};
  const [showLevels, setShowLevels] = useState(false);
  const isLong  = signal?.dir === 'long';
  const isShort = signal?.dir === 'short';
  const borderCol = isLong ? bull : isShort ? bear : 'transparent';

  return (
    <div style={{
      background:'var(--card-bg, #1a1a2e)',
      border:`1px solid ${borderCol || 'rgba(255,255,255,0.08)'}`,
      borderRadius:10,
      padding:'12px 14px',
      boxShadow: signal ? `0 0 12px ${borderCol}33` : 'none',
    }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontWeight:700, fontSize:14, letterSpacing:0.5 }}>{fmtPair(pair)}</span>
          <button onClick={onOpenChart} title="Open Chart" style={{
            fontSize:11, padding:'2px 7px', borderRadius:4, cursor:'pointer',
            background:'#8b5cf622', color:'#a78bfa', border:'1px solid #8b5cf644',
          }}>📊</button>
        </div>
        {cardLoading ? (
          <span style={{ fontSize:11, color:neu }}>loading…</span>
        ) : signal ? (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:3 }}>
            <span style={{
              fontSize:11, fontWeight:700, padding:'3px 8px', borderRadius:5,
              background: isLong ? '#16a34a22' : '#dc262622',
              color: isLong ? bull : bear,
              border: `1px solid ${isLong ? bull : bear}`,
            }}>
              {isLong ? '▲ LONG' : '▼ SHORT'}
            </span>
            <QualityStars q={signal.quality} />
          </div>
        ) : (
          <span style={{ fontSize:11, color:neu }}>waiting</span>
        )}
      </div>

      {(!data && !cardLoading) ? (
        <div style={{ fontSize:12, color:neu }}>No OANDA data</div>
      ) : cardLoading ? (
        <div style={{ fontSize:12, color:neu }}>Fetching H4 · H1 · M15…</div>
      ) : (
        <>
          {/* MTF consensus row */}
          <MTFConsensus h4={h4} h1={h1} m15={m15} />
          <TFRow label="H4"  data={h4} />
          <TFRow label="H1"  data={h1} />
          <TFRow label="M15" data={m15} />

          {signal && (
            <div style={{ marginTop:10, paddingTop:8, borderTop:'1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ display:'grid', gridTemplateColumns:'auto 1fr auto', gap:'3px 10px', fontSize:12 }}>
                <span style={{ color:neu }}>Entry</span>
                <span style={{ color:'#e2e8f0', fontWeight:600 }}>{fmtPrice(pair, signal.entry)}</span>
                <span></span>

                <span style={{ color:neu }}>SL</span>
                <span style={{ color:bear, fontWeight:600 }}>{fmtPrice(pair, signal.sl)}</span>
                <span style={{ color:neu, fontSize:11 }}>−{fmtDist(pair, Math.abs(signal.entry - signal.sl))}</span>

                <span style={{ color:neu }}>TP</span>
                <span style={{ color:bull, fontWeight:600 }}>{fmtPrice(pair, signal.tp)}</span>
                <span style={{ color:neu, fontSize:11 }}>+{fmtDist(pair, Math.abs(signal.tp - signal.entry))}</span>
              </div>

              <div style={{ marginTop:5, fontSize:11, color:'#f59e0b' }}>
                R:R {signal.rr}:1 · M15 {m15?.bullOB || m15?.bearOB ? 'OB' : 'FVG'} entry
              </div>

              {((isLong && m15?.ote?.bull) || (isShort && m15?.ote?.bear)) && (
                <div style={{ marginTop:4, fontSize:10, fontWeight:700,
                  color:'#06b6d4', background:'#06b6d412', border:'1px solid #06b6d433',
                  borderRadius:4, padding:'2px 8px' }}>
                  📐 OTE — Fib 61.8–78.6% retracement zone
                </div>
              )}
              {((isLong && m15?.bb?.bull) || (isShort && m15?.bb?.bear)) && (
                <div style={{ marginTop:4, fontSize:10, fontWeight:700,
                  color:'#f97316', background:'#f9731612', border:'1px solid #f9731633',
                  borderRadius:4, padding:'2px 8px' }}>
                  🔄 Breaker Block — flipped OB acting as {isLong ? 'support' : 'resistance'}
                </div>
              )}

              {/* Killzone badge */}
              {signal.kz ? (
                <div style={{ marginTop:6, fontSize:10, fontWeight:700, color:signal.kz.color,
                  background:`${signal.kz.color}18`, border:`1px solid ${signal.kz.color}44`,
                  borderRadius:4, padding:'3px 8px', display:'inline-block' }}>
                  ⚡ {signal.kz.name} active — optimal timing
                </div>
              ) : (
                <div style={{ marginTop:6, fontSize:10, color:'#64748b' }}>
                  ⏱ Outside killzone — {(() => { const n = getNextKZ(); return n ? `${n.name} in ${Math.floor(n.minsUntil/60)}h ${n.minsUntil%60}m` : ''; })()}
                </div>
              )}

              {/* Liquidity block warning */}
              {signal.liqBlock && (
                <div style={{ marginTop:5, fontSize:10, fontWeight:700,
                  color:'#f43f5e', background:'#f43f5e12', border:'1px solid #f43f5e44',
                  borderRadius:4, padding:'3px 8px' }}>
                  ⚠ BSL/SSL blocking @ {fmtPrice(pair, signal.liqBlock)} — liquidity pool in path to TP
                </div>
              )}
            </div>
          )}

          {/* VA + Fib key levels */}
          {(va || fib) && (
            <div style={{ marginTop:8, borderTop:'1px solid rgba(255,255,255,0.06)', paddingTop:8 }}>
              <button onClick={() => setShowLevels(s => !s)} style={{ fontSize:9, color:'#475569',
                background:'transparent', border:'none', cursor:'pointer', padding:0, fontWeight:700,
                letterSpacing:'0.06em' }}>
                📐 KEY LEVELS {showLevels ? '▲' : '▼'}
              </button>
              {showLevels && (
                <div style={{ marginTop:6 }}>
                  {/* Volume Profile */}
                  {va && (
                    <div style={{ display:'flex', gap:6, marginBottom:6 }}>
                      {[
                        { l:'VAH', v:va.vah, c:'#22c55e' },
                        { l:'POC', v:va.poc, c:'#f59e0b' },
                        { l:'VAL', v:va.val, c:'#ef4444' },
                      ].map(item => (
                        <div key={item.l} style={{ flex:1, background:'#ffffff06',
                          border:`1px solid ${item.c}33`, borderRadius:6, padding:'4px 6px', textAlign:'center' }}>
                          <div style={{ fontSize:8, color:item.c, fontWeight:800 }}>{item.l}</div>
                          <div style={{ fontSize:10, color:item.c, fontFamily:'monospace', fontWeight:700 }}>
                            {fmtPrice(pair, item.v)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Fib key levels */}
                  {fib && (
                    <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                      {fib.map(f => (
                        <div key={f.ratio} style={{ background:'#f59e0b0a',
                          border:'1px solid #f59e0b22', borderRadius:5, padding:'2px 7px' }}>
                          <span style={{ fontSize:8, color:'#f59e0b' }}>{f.label} </span>
                          <span style={{ fontSize:9, fontFamily:'monospace', color:'#e2e8f0', fontWeight:700 }}>
                            {fmtPrice(pair, f.price)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Checklist Board — scans all pairs against the 5 auto-checks ──────────────

function CheckItem({ ok, label }) {
  const c = ok === null ? '#334155' : ok ? '#22c55e' : '#ef4444';
  const bg = ok === null ? '#0f172a' : ok ? '#22c55e12' : '#ef444412';
  return (
    <span style={{ fontSize:9, fontWeight:700, color:c, background:bg,
      border:`1px solid ${c}44`, borderRadius:4, padding:'1px 5px', whiteSpace:'nowrap' }}>
      {ok === null ? '?' : ok ? '✓' : '✗'} {label}
    </span>
  );
}

function ChecklistBoard({ results }) {
  const kz      = getCurrentKZ();
  const nextKZ  = getNextKZ();
  const dow     = getDOWInfo();
  const dxyBias = getDXYBias(results);

  const rows = PAIRS.map(pair => {
    const data = results[pair];
    const checks = {
      kz:      !!kz,
      session: isInSession(pair),
      mtf:     data?.h4?.structure === 'bullish' || data?.h4?.structure === 'bearish',
      dxy:     isDXYAligned(pair, data, dxyBias),
      dow:     dow.ok,
    };
    const vals   = Object.values(checks);
    const known  = vals.filter(v => v !== null);
    const passed = known.filter(Boolean).length;
    const score  = known.length ? passed / known.length : 0;
    const verdict = score >= 0.8 ? 'GO' : score >= 0.6 ? 'PARTIAL' : 'WAIT';
    const vc      = score >= 0.8 ? '#22c55e' : score >= 0.6 ? '#f59e0b' : '#64748b';
    const dir     = data?.signal?.dir ??
      (data?.h4?.structure === 'bullish' ? 'long' : data?.h4?.structure === 'bearish' ? 'short' : null);
    return { pair, checks, passed, total: known.length, verdict, vc, dir };
  }).sort((a, b) => b.passed - a.passed);

  return (
    <div>
      {/* Context bar */}
      <div style={{ background:'#1e293b', borderRadius:8, padding:'9px 13px', marginBottom:10,
        display:'flex', gap:16, flexWrap:'wrap', fontSize:11, alignItems:'center' }}>
        <span>
          KZ: {kz
            ? <span style={{ color:kz.color, fontWeight:700 }}>⚡ {kz.name}</span>
            : <span style={{ color:'#334155' }}>None {nextKZ ? `· ${nextKZ.name} in ${Math.floor(nextKZ.minsUntil/60)}h ${nextKZ.minsUntil%60}m` : ''}</span>}
        </span>
        <span>
          DOW: <span style={{ color: dow.ok ? '#22c55e' : '#475569', fontWeight: dow.ok ? 700 : 400 }}>
            {dow.label} {dow.ok ? `✓ ${dow.note}` : `(${dow.note})`}
          </span>
        </span>
        <span>
          DXY: <span style={{ color: dxyBias === 'bull' ? '#22c55e' : dxyBias === 'bear' ? '#ef4444' : '#475569', fontWeight:700 }}>
            {dxyBias === 'bull' ? '▲ Bull' : dxyBias === 'bear' ? '▼ Bear' : '?'}
          </span>
          <span style={{ color:'#334155', fontSize:9 }}> via EUR/USD H4</span>
        </span>
      </div>

      {/* Pair rows */}
      <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
        {rows.map(({ pair, checks, passed, total, verdict, vc, dir }) => (
          <div key={pair} style={{ background:'#1e293b', borderRadius:8, padding:'7px 12px',
            border:`1px solid ${vc}22`, display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            {/* Name + direction */}
            <div style={{ minWidth:72 }}>
              <div style={{ fontSize:12, fontWeight:800, color:'#f1f5f9' }}>{fmtPair(pair)}</div>
              {dir
                ? <div style={{ fontSize:9, color: dir==='long'?'#22c55e':'#ef4444', fontWeight:700 }}>
                    {dir==='long'?'▲ LONG':'▼ SHORT'}
                  </div>
                : <div style={{ fontSize:9, color:'#334155' }}>—</div>}
            </div>
            {/* Checks */}
            <div style={{ display:'flex', gap:4, flex:1, flexWrap:'wrap' }}>
              <CheckItem ok={checks.kz}      label="Kill Zone" />
              <CheckItem ok={checks.session} label="Session"   />
              <CheckItem ok={checks.mtf}     label="MTF align" />
              <CheckItem ok={checks.dxy}     label="DXY"       />
              <CheckItem ok={checks.dow}     label="DOW day"   />
            </div>
            {/* Verdict */}
            <div style={{ fontSize:13, fontWeight:900, color:vc, background:`${vc}12`,
              border:`1px solid ${vc}30`, borderRadius:6, padding:'3px 10px',
              flexShrink:0, textAlign:'center', minWidth:70 }}>
              {verdict}
              <div style={{ fontSize:9, fontWeight:400, color:'#475569', marginTop:1 }}>{passed}/{total}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop:12, padding:'8px 12px', background:'#0f172a', borderRadius:7,
        fontSize:10, color:'#334155', lineHeight:1.8 }}>
        Auto-checked above. Before entry also verify manually:<br/>
        <span style={{ color:'#1e3a5f' }}>① Price at key level (PDH/PDL/OB/FVG)?</span>{' '}
        <span style={{ color:'#1e3a5f' }}>② Trigger candle (sweep+reject / engulfing)?</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TopDownSignals() {
  const [tab,              setTab]              = useState('signals');
  const [results,          setResults]          = useState({});
  const [loadingSet,       setLoadingSet]       = useState(new Set());
  const [lastRefresh,      setLastRefresh]      = useState(null);
  const [refreshing,       setRefreshing]       = useState(false);
  const [kzOnly,           setKzOnly]           = useState(false);
  const [clearOnly,        setClearOnly]        = useState(false);
  const [minQuality,       setMinQuality]       = useState(0);
  const [chartInstrument,  setChartInstrument]  = useState(null);
  const [notifOpen,        setNotifOpen]        = useState(false);
  const [notifSettings,    setNotifSettings]    = useState(() => {
    try { return JSON.parse(localStorage.getItem('forex_notif_v1') || '{}'); } catch { return {}; }
  });
  const alertedRef      = useRef(new Map());
  const autoIntervalRef = useRef(null);

  const hasOanda = !!getCreds().apiKey;

  function saveNotif(patch) {
    const next = { ...notifSettings, ...patch };
    setNotifSettings(next);
    localStorage.setItem('forex_notif_v1', JSON.stringify(next));
  }

  const checkAndAlert = useCallback((currentResults) => {
    const { browserOn, telegramOn, botToken, chatId, minGrade = 5 } = notifSettings;
    if (!browserOn && !telegramOn) return;
    Object.entries(currentResults).forEach(([pair, data]) => {
      if (!data?.signal) return;
      const q = data.signal.quality ?? 0;
      if (q < minGrade) return;
      const key = `${pair}`;
      const last = alertedRef.current.get(key) || 0;
      if (Date.now() - last < 4 * 3600 * 1000) return;
      alertedRef.current.set(key, Date.now());
      const grade = getGrade(q);
      const dir = data.signal.dir === 'long' ? '▲ LONG' : '▼ SHORT';
      const sym = pair.replace('_', '/');
      if (browserOn) {
        showBrowserNotification(`${grade} Setup: ${sym} ${dir}`, `Entry ${data.signal.entry?.toFixed(5)} · R:R ${data.signal.rr}:1`);
      }
      if (telegramOn && botToken && chatId) {
        sendTelegram(botToken, chatId, formatTelegramMsg(pair, data.signal, grade));
      }
    });
  }, [notifSettings]);

  const load = useCallback(async () => {
    if (!hasOanda) return;
    setRefreshing(true);
    setLoadingSet(new Set(PAIRS));
    const accumulated = {};

    await Promise.all(PAIRS.map(async (pair) => {
      const [h4c, h1c, m15c] = await Promise.all([
        fetchOHLC(pair, 'H4', 60),
        fetchOHLC(pair, 'H1', 100),
        fetchOHLC(pair, 'M15', 100),
      ]);
      const h4     = analyzeTimeframe(h4c);
      const h1     = analyzeTimeframe(h1c);
      const m15    = analyzeTimeframe(m15c);
      const signal = getSignal(h4, h1, m15, h1c);

      // Volume Profile + Fib from H1 candles
      let va = null, fib = null;
      if (h1c && h1c.length >= 10) {
        va = computeValueArea(h1c.slice(-50));
        const swHigh = Math.max(...h1c.slice(-50).map(c => c.h));
        const swLow  = Math.min(...h1c.slice(-50).map(c => c.l));
        fib = computeFib(swHigh, swLow, [0.5, 0.618, 0.702, 0.786, 0.893]);
      }

      setResults(prev => ({ ...prev, [pair]: { h4, h1, m15, signal, va, fib } }));
      accumulated[pair] = { h4, h1, m15, signal, va, fib };
      setLoadingSet(prev => { const s = new Set(prev); s.delete(pair); return s; });
    }));

    setLastRefresh(new Date());
    setRefreshing(false);
    checkAndAlert(accumulated);
  }, [hasOanda, checkAndAlert]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (autoIntervalRef.current) clearInterval(autoIntervalRef.current);
    const mins = notifSettings.refreshMins ?? 15;
    if ((notifSettings.browserOn || notifSettings.telegramOn) && mins > 0) {
      autoIntervalRef.current = setInterval(() => { load(); }, mins * 60 * 1000);
    }
    return () => { if (autoIntervalRef.current) clearInterval(autoIntervalRef.current); };
  }, [notifSettings.browserOn, notifSettings.telegramOn, notifSettings.refreshMins, load]);

  let sorted = [...PAIRS].sort((a, b) => {
    const aQ = results[a]?.signal?.quality ?? -1;
    const bQ = results[b]?.signal?.quality ?? -1;
    if (aQ !== bQ) return bQ - aQ;
    return alignScore(results[b]?.h4, results[b]?.h1, results[b]?.m15)
         - alignScore(results[a]?.h4, results[a]?.h1, results[a]?.m15);
  });

  // Apply filters
  if (kzOnly)    sorted = sorted.filter(p => results[p]?.signal?.kz);
  if (clearOnly) sorted = sorted.filter(p => !results[p]?.signal?.liqBlock);
  if (minQuality > 0) sorted = sorted.filter(p => (results[p]?.signal?.quality ?? 0) >= minQuality);

  const allSignals   = Object.values(results).filter(r => r?.signal);
  const kzSignals    = allSignals.filter(r => r.signal.kz);
  const clearSignals = allSignals.filter(r => !r.signal.liqBlock);
  const aSignals     = allSignals.filter(r => r.signal.quality >= 4);

  const chip = (label, active, onClick, count) => (
    <button onClick={onClick} style={{
      fontSize:10, padding:'3px 8px', borderRadius:5, cursor:'pointer', fontWeight:600,
      background: active ? 'rgba(139,92,246,0.25)' : 'rgba(255,255,255,0.06)',
      color:      active ? '#a78bfa' : '#94a3b8',
      border:     `1px solid ${active ? '#8b5cf644' : 'rgba(255,255,255,0.1)'}`,
    }}>
      {label} {count != null ? <span style={{ opacity:0.7 }}>({count})</span> : null}
    </button>
  );

  function NotificationSettingsPanel() {
    const [testStatus, setTestStatus] = useState('');
    const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

    async function handleEnableBrowser() {
      const result = await requestBrowserPermission();
      if (result === 'granted') saveNotif({ browserOn: true });
      else setTestStatus('Browser permission denied. Please allow notifications in browser settings.');
    }

    async function handleTest() {
      setTestStatus('Sending test…');
      let ok = false;
      if (notifSettings.browserOn) {
        showBrowserNotification('ForexPro Test', 'Notifications are working! ✓');
        ok = true;
      }
      if (notifSettings.telegramOn && notifSettings.botToken && notifSettings.chatId) {
        const sent = await sendTelegram(notifSettings.botToken, notifSettings.chatId, '🧪 <b>ForexPro Test</b>\nTelegram alerts are working! ✓');
        if (!sent) { setTestStatus('Telegram failed — check bot token and chat ID.'); return; }
        ok = true;
      }
      setTestStatus(ok ? '✓ Test sent!' : 'Enable at least one alert type first.');
      setTimeout(() => setTestStatus(''), 3000);
    }

    const toggle = (val, onChange) => (
      <div onClick={onChange} style={{
        width:36, height:20, borderRadius:10, cursor:'pointer', position:'relative',
        background: val ? '#8b5cf6' : '#1e293b', border:`1px solid ${val ? '#8b5cf6' : '#334155'}`,
        transition:'background 0.2s',
      }}>
        <div style={{
          position:'absolute', top:2, left: val ? 16 : 2, width:14, height:14,
          borderRadius:'50%', background:'white', transition:'left 0.2s',
        }}/>
      </div>
    );

    const input = (placeholder, val, onChange) => (
      <input
        type="text" placeholder={placeholder} value={val || ''}
        onChange={e => onChange(e.target.value)}
        style={{
          width:'100%', background:'#0f172a', border:'1px solid #1e293b',
          borderRadius:6, padding:'6px 10px', fontSize:11, color:'#e2e8f0',
          outline:'none', marginTop:4,
        }}
      />
    );

    return (
      <div style={{ background:'#1e293b', borderRadius:10, padding:'14px 16px', marginBottom:12,
        border:'1px solid #8b5cf633' }}>
        <div style={{ fontWeight:700, fontSize:12, color:'#a78bfa', marginBottom:12 }}>🔔 Alert Settings</div>

        {/* Browser Notifications */}
        <div style={{ marginBottom:12, padding:'10px 12px', background:'#0f172a', borderRadius:8 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
            <span style={{ fontSize:11, fontWeight:700, color:'#e2e8f0' }}>Browser Notifications</span>
            {perm === 'granted'
              ? toggle(!!notifSettings.browserOn, () => saveNotif({ browserOn: !notifSettings.browserOn }))
              : <button onClick={handleEnableBrowser} style={{
                  fontSize:10, padding:'3px 8px', borderRadius:5, cursor:'pointer', fontWeight:700,
                  background:'#8b5cf622', color:'#a78bfa', border:'1px solid #8b5cf644',
                }}>Enable</button>
            }
          </div>
          <div style={{ fontSize:9, color:'#475569' }}>
            Works while this tab is open. Great for desktop.
          </div>
        </div>

        {/* Telegram */}
        <div style={{ marginBottom:12, padding:'10px 12px', background:'#0f172a', borderRadius:8 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
            <span style={{ fontSize:11, fontWeight:700, color:'#e2e8f0' }}>📱 Telegram</span>
            {toggle(!!notifSettings.telegramOn, () => saveNotif({ telegramOn: !notifSettings.telegramOn }))}
          </div>
          <div style={{ fontSize:9, color:'#475569', marginBottom:8 }}>
            Get alerts on your phone. Create bot via @BotFather on Telegram.
          </div>
          {input('Bot Token (from @BotFather)', notifSettings.botToken, v => saveNotif({ botToken: v }))}
          {input('Chat ID (message @userinfobot to get)', notifSettings.chatId, v => saveNotif({ chatId: v }))}
        </div>

        {/* Alert threshold + refresh interval */}
        <div style={{ display:'flex', gap:8, marginBottom:12 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:9, color:'#475569', marginBottom:4 }}>Alert when grade ≥</div>
            <select
              value={notifSettings.minGrade ?? 5}
              onChange={e => saveNotif({ minGrade: +e.target.value })}
              style={{ width:'100%', background:'#0f172a', border:'1px solid #1e293b',
                borderRadius:6, padding:'5px 8px', fontSize:11, color:'#e2e8f0', outline:'none' }}
            >
              <option value={5}>A+ only (quality 5)</option>
              <option value={4}>A or better (quality 4+)</option>
              <option value={3}>B+ or better (quality 3+)</option>
            </select>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:9, color:'#475569', marginBottom:4 }}>Auto-refresh every</div>
            <select
              value={notifSettings.refreshMins ?? 15}
              onChange={e => saveNotif({ refreshMins: +e.target.value })}
              style={{ width:'100%', background:'#0f172a', border:'1px solid #1e293b',
                borderRadius:6, padding:'5px 8px', fontSize:11, color:'#e2e8f0', outline:'none' }}
            >
              <option value={5}>5 min</option>
              <option value={10}>10 min</option>
              <option value={15}>15 min</option>
              <option value={30}>30 min</option>
            </select>
          </div>
        </div>

        {/* Test + status */}
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <button onClick={handleTest} style={{
            fontSize:11, fontWeight:700, padding:'6px 16px', borderRadius:6, cursor:'pointer',
            background:'#8b5cf625', color:'#a78bfa', border:'1px solid #8b5cf644',
          }}>Send Test Alert</button>
          {testStatus && <span style={{ fontSize:10, color: testStatus.startsWith('✓') ? '#22c55e' : '#ef4444' }}>{testStatus}</span>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding:'12px 10px', overflowY:'auto', height:'100%' }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
        <div>
          <div style={{ fontWeight:700, fontSize:15 }}>Top-Down Signals</div>
          <div style={{ fontSize:11, color:neu, marginTop:2 }}>H4 bias → H1 structure → M15 entry · SL · TP</div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            <button
              onClick={() => setNotifOpen(v => !v)}
              style={{
                background: notifOpen ? 'rgba(139,92,246,0.2)' : 'rgba(255,255,255,0.08)',
                border: `1px solid ${notifOpen ? '#8b5cf644' : 'rgba(255,255,255,0.12)'}`,
                borderRadius:6, color: notifOpen ? '#a78bfa' : '#e2e8f0',
                fontSize:14, padding:'5px 10px', cursor:'pointer',
              }}
            >
              🔔
            </button>
            <button
              onClick={load}
              disabled={refreshing}
              style={{
                background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:6, color:'#e2e8f0', fontSize:12, padding:'5px 12px', cursor:'pointer',
              }}
            >
              {refreshing ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
          {lastRefresh && (
            <div style={{ fontSize:10, color:neu, marginTop:3 }}>{lastRefresh.toLocaleTimeString()}</div>
          )}
        </div>
      </div>

      {notifOpen && <NotificationSettingsPanel />}

      {/* Sub-tabs */}
      <div style={{ display:'flex', gap:6, marginBottom:12 }}>
        {[['signals','📊 Signals'],['checklist','📋 Trade Ready']].map(([id, lbl]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            fontSize:11, fontWeight:700, padding:'5px 14px', borderRadius:7, cursor:'pointer',
            background: tab===id ? '#8b5cf625' : '#0f172a',
            color:      tab===id ? '#a78bfa'   : '#475569',
            border:     `1px solid ${tab===id ? '#8b5cf644' : '#1e293b'}`,
          }}>{lbl}</button>
        ))}
      </div>

      {/* Trade Ready checklist tab */}
      {tab === 'checklist' && <ChecklistBoard results={results} />}

      {/* Filter chips — signals tab only */}
      {tab === 'signals' && (
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:10 }}>
        {chip('⚡ KZ Only',       kzOnly,    () => setKzOnly(v => !v),    kzSignals.length)}
        {chip('✅ Clear Path',    clearOnly, () => setClearOnly(v => !v), clearSignals.length)}
        {chip('★★★ A-Grade',    minQuality >= 3, () => setMinQuality(v => v >= 3 ? 0 : 3), aSignals.length)}
      </div>)}

      {!hasOanda && (
        <div style={{ textAlign:'center', color:neu, padding:40, fontSize:13 }}>
          Connect OANDA in Screener settings to see signals.
        </div>
      )}

      {tab === 'signals' && (
        <>
          {hasOanda && allSignals.length > 0 && (
            <div style={{
              background:'rgba(34,197,94,0.1)', border:'1px solid rgba(34,197,94,0.3)',
              borderRadius:8, padding:'8px 14px', marginBottom:12, fontSize:13,
              color:bull, fontWeight:600,
            }}>
              {allSignals.length} setup{allSignals.length > 1 ? 's' : ''} · {kzSignals.length} in KZ · {clearSignals.length} clear path · {aSignals.length} A-grade
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', gap:10 }}>
            {sorted.map(pair => (
              <PairCard
                key={pair}
                pair={pair}
                data={results[pair]}
                loading={loadingSet.has(pair)}
                onOpenChart={() => setChartInstrument({ symbol: fmtPair(pair) })}
              />
            ))}
          </div>
        </>
      )}

      {chartInstrument && (
        <ChartModal instrument={chartInstrument} onClose={() => setChartInstrument(null)} />
      )}
    </div>
  );
}

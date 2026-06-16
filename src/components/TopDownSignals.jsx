import { useState, useCallback, useEffect } from 'react';
import ChartModal from './ChartModal.jsx';

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

function getCreds() {
  const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
  if (c?.apiKey) return c;
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
      .map(c => ({ o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, t: c.time }));
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

  return { cp, atr, structure, zone, swingHigh, swingLow, bullOB, bearOB, bullFVG, bearFVG };
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
    h4.structure === 'bullish' &&
    h1.zone === 'discount' &&
    m15.zone === 'discount' &&
    (m15.bullOB || m15.bullFVG);

  const shortOK =
    h4.structure === 'bearish' &&
    h1.zone === 'premium' &&
    m15.zone === 'premium' &&
    (m15.bearOB || m15.bearFVG);

  if (!longOK && !shortOK) return null;

  const dir      = longOK ? 'long' : 'short';
  const entry    = m15.cp;
  const minDist  = m15.atr * 1.5;
  let sl;

  if (dir === 'long') {
    const structural = Math.min(
      m15.bullOB?.low  ?? Infinity,
      m15.bullFVG?.bottom ?? Infinity,
      m15.swingLow
    ) - m15.atr * 0.1;
    sl = Math.min(structural, entry - minDist);
  } else {
    const structural = Math.max(
      m15.bearOB?.high ?? -Infinity,
      m15.bearFVG?.top ?? -Infinity,
      m15.swingHigh
    ) + m15.atr * 0.1;
    sl = Math.max(structural, entry + minDist);
  }

  const risk = Math.abs(entry - sl);
  const tp   = dir === 'long' ? entry + risk * 2 : entry - risk * 2;
  const rr   = +(Math.abs(tp - entry) / risk).toFixed(1);

  // Quality filters
  const liqBlock = checkLiqPath(dir, entry, tp, h1Candles);
  const kz       = getCurrentKZ();

  // Quality score 0-4
  let quality = 0;
  if (kz)        quality++;                          // killzone timing
  if (!liqBlock) quality++;                          // clear path to TP
  if (h1.structure === h4.structure) quality++;      // H1 aligns with H4
  if (m15.bullOB || m15.bearOB) quality++;           // OB entry (stronger than FVG)

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
    </div>
  );
}

// Quality star rating
function QualityStars({ q }) {
  return (
    <div style={{ display:'flex', gap:2, alignItems:'center' }}>
      {[0,1,2,3].map(i => (
        <span key={i} style={{ fontSize:10, color: i < q ? '#f59e0b' : '#1e293b' }}>★</span>
      ))}
      <span style={{ fontSize:9, color:'#64748b', marginLeft:3 }}>
        {q === 4 ? 'A+' : q === 3 ? 'A' : q === 2 ? 'B' : 'C'}
      </span>
    </div>
  );
}

function PairCard({ pair, data, loading: cardLoading, onOpenChart }) {
  const { h4, h1, m15, signal } = data || {};
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
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TopDownSignals() {
  const [results,          setResults]          = useState({});
  const [loadingSet,       setLoadingSet]       = useState(new Set());
  const [lastRefresh,      setLastRefresh]      = useState(null);
  const [refreshing,       setRefreshing]       = useState(false);
  const [kzOnly,           setKzOnly]           = useState(false);
  const [clearOnly,        setClearOnly]        = useState(false);
  const [minQuality,       setMinQuality]       = useState(0);
  const [chartInstrument,  setChartInstrument]  = useState(null);

  const hasOanda = !!getCreds().apiKey;

  const load = useCallback(async () => {
    if (!hasOanda) return;
    setRefreshing(true);
    setLoadingSet(new Set(PAIRS));

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

      setResults(prev => ({ ...prev, [pair]: { h4, h1, m15, signal } }));
      setLoadingSet(prev => { const s = new Set(prev); s.delete(pair); return s; });
    }));

    setLastRefresh(new Date());
    setRefreshing(false);
  }, [hasOanda]);

  useEffect(() => { load(); }, [load]);

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
  const aSignals     = allSignals.filter(r => r.signal.quality >= 3);

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

  return (
    <div style={{ padding:'12px 10px', overflowY:'auto', height:'100%' }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
        <div>
          <div style={{ fontWeight:700, fontSize:15 }}>Top-Down Signals</div>
          <div style={{ fontSize:11, color:neu, marginTop:2 }}>H4 bias → H1 structure → M15 entry · SL · TP</div>
        </div>
        <div style={{ textAlign:'right' }}>
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
          {lastRefresh && (
            <div style={{ fontSize:10, color:neu, marginTop:3 }}>{lastRefresh.toLocaleTimeString()}</div>
          )}
        </div>
      </div>

      {/* Filter chips */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:10 }}>
        {chip('⚡ KZ Only',       kzOnly,    () => setKzOnly(v => !v),    kzSignals.length)}
        {chip('✅ Clear Path',    clearOnly, () => setClearOnly(v => !v), clearSignals.length)}
        {chip('★★★ A-Grade',    minQuality >= 3, () => setMinQuality(v => v >= 3 ? 0 : 3), aSignals.length)}
      </div>

      {!hasOanda && (
        <div style={{ textAlign:'center', color:neu, padding:40, fontSize:13 }}>
          Connect OANDA in Screener settings to see signals.
        </div>
      )}

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

      {chartInstrument && (
        <ChartModal instrument={chartInstrument} onClose={() => setChartInstrument(null)} />
      )}
    </div>
  );
}

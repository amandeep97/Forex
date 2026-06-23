'use strict';
import { useState, useEffect, useCallback } from 'react';
import { computeRSI, computeEMA } from '../utils/indicatorCalc';
import { zigzagSwings } from '../utils/smcHelpers';

const PROXY = 'https://corsproxy.io/?';
const CALENDAR_URL = PROXY + encodeURIComponent('https://nfs.faireconomy.media/ff_calendar_thisweek.json');

const TFS = [
  { key: 'W',   label: 'W',   gran: 'W',   count: 60  },
  { key: 'D',   label: 'D',   gran: 'D',   count: 120 },
  { key: 'H4',  label: '4H',  gran: 'H4',  count: 120 },
  { key: 'H1',  label: '1H',  gran: 'H1',  count: 100 },
  { key: 'M30', label: '30M', gran: 'M30', count: 100 },
  { key: 'M15', label: '15M', gran: 'M15', count: 100 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOandaCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) return c;
  } catch {}
  const k = localStorage.getItem('oanda_key');
  return k ? { apiKey: k, practice: localStorage.getItem('oanda_env') !== 'live' } : null;
}

async function fetchCandles(inst, gran, count, creds) {
  const base = creds.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  try {
    const res = await fetch(
      `${base}/instruments/${inst}/candles?granularity=${gran}&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(9000) }
    );
    if (!res.ok) return null;
    const d = await res.json();
    return (d.candles || []).filter(c => c.complete).map(c => ({
      t: new Date(c.time).getTime(),
      o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, v: +(c.volume || 0),
    }));
  } catch { return null; }
}

// Invert EUR/USD → DXY proxy (h/l swap because inverting flips them)
function toDXY(candles) {
  return candles.map(c => ({ t: c.t, o: 1/c.o, h: 1/c.l, l: 1/c.h, c: 1/c.c, v: c.v }));
}

function computeBias(candles) {
  if (!candles || candles.length < 22) return { trend: 'neutral', rsi: 50 };
  try {
    const rsi   = computeRSI(candles, 14);
    const ema20 = computeEMA(candles, 20);
    const ema50 = candles.length >= 52 ? computeEMA(candles, 50) : ema20;
    const last  = candles[candles.length - 1].c;
    const prev5 = candles[candles.length - 6]?.c ?? last;
    const bulls = [last > ema20, last > ema50, rsi > 55, last > prev5].filter(Boolean).length;
    const bears = [last < ema20, last < ema50, rsi < 45, last < prev5].filter(Boolean).length;
    return { trend: bulls >= 3 ? 'bull' : bears >= 3 ? 'bear' : 'neutral', rsi };
  } catch { return { trend: 'neutral', rsi: 50 }; }
}

function computeStructure(dxyCnds) {
  if (!dxyCnds || dxyCnds.length < 30) return { pattern: 'ranging' };
  try {
    const { sHs, sLs } = zigzagSwings(dxyCnds);
    const highs = sHs.slice(-4), lows = sLs.slice(-4);
    let hh = 0, lh = 0, hl = 0, ll = 0;
    for (let i = 1; i < highs.length; i++) highs[i].price > highs[i-1].price ? hh++ : lh++;
    for (let i = 1; i < lows.length;  i++) lows[i].price  > lows[i-1].price  ? hl++ : ll++;
    return {
      pattern: (hh > 0 && hl > 0) ? 'uptrend' : (lh > 0 && ll > 0) ? 'downtrend' : 'ranging',
      hh, hl, lh, ll,
    };
  } catch { return { pattern: 'ranging' }; }
}

function pctDiff(candles, lookback = 5) {
  const n = candles.length;
  if (n < lookback + 1) return null;
  return ((candles[n-1].c - candles[n-1-lookback].c) / candles[n-1-lookback].c) * 100;
}

async function fetchCalendar() {
  try {
    const res = await fetch(CALENDAR_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return data.filter(ev => ev.country === 'USD' || ev.country === 'US');
  } catch { return []; }
}

async function fetchUSDCOT() {
  try {
    // EUR TFF (leveraged funds) inverted = USD institutional positioning
    const url = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json' +
      '?cftc_contract_market_code=099741&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=1';
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.length) return null;
    const r   = data[0];
    const nv  = v => +v || 0;
    const eurLev = nv(r.lev_money_positions_long_all  || r.lev_money_positions_long)
                 - nv(r.lev_money_positions_short_all || r.lev_money_positions_short);
    const usdNet = -eurLev;
    return {
      usdNet,
      direction: usdNet > 8000 ? 'bull' : usdNet < -8000 ? 'bear' : 'neutral',
      label: `${usdNet > 0 ? 'Net Long' : 'Net Short'} (${Math.abs(usdNet).toLocaleString()} lots)`,
      date: (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
    };
  } catch { return null; }
}

function detectReversal(events, dxy15m) {
  if (!events?.length || !dxy15m?.length) return null;
  const now = Date.now();
  const recent = events
    .filter(ev => ev.impact === 'High')
    .filter(ev => { const t = new Date(ev.date).getTime(); return t < now && t > now - 7200000; })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!recent.length) return null;
  const ev   = recent[0];
  const evT  = new Date(ev.date).getTime();
  const post = dxy15m.filter(c => c.t >= evT);
  if (post.length < 2) return null;
  const spike    = post[0];
  const spikePct = ((spike.c - spike.o) / spike.o) * 100;
  if (Math.abs(spikePct) < 0.08) return null;
  const cur = dxy15m[dxy15m.length - 1].c;
  const dir = spikePct > 0 ? 'up' : 'down';
  const ret = dir === 'up' ? cur < spike.h * 0.9988 : cur > spike.l * 1.0012;
  return {
    event: ev, dir, spikePct: spikePct.toFixed(2),
    isRetracing: ret,
    signal: ret ? 'REVERSAL' : 'CONTINUATION',
    minsAgo: Math.round((now - evT) / 60000),
  };
}

function countdown(dateStr) {
  const diff = new Date(dateStr) - Date.now();
  if (diff < 0) return null;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'NOW';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Mini EUR/USD chart (inverted visually = DXY direction) ────────────────────
function MiniChart({ eurusdCandles, dxyIsUp }) {
  if (!eurusdCandles?.length) return null;
  const W = 340, H = 60, PX = 4, PY = 6;
  // Show EUR/USD closes — when EUR/USD falls, line goes down, meaning DXY goes up
  const closes = eurusdCandles.slice(-80).map(c => c.c);
  const mn = Math.min(...closes), mx = Math.max(...closes);
  const range = mx - mn || 0.0001;
  const pts = closes.map((v, i) => {
    const x = PX + (i / (closes.length - 1)) * (W - 2*PX);
    const y = PY + ((mx - v) / range) * (H - 2*PY);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // Color by DXY direction (not EUR/USD direction)
  const color = dxyIsUp ? '#22c55e' : '#ef4444';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }}>
      <polyline points={`${PX},${H} ${pts} ${W-PX},${H}`} fill={color} opacity={0.07}/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} opacity={0.85}/>
    </svg>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function DXYDashboard() {
  const [tfBias,      setTfBias]      = useState({});
  const [tfStructure, setTfStructure] = useState({});
  const [structure,   setStructure]   = useState({ pattern: 'ranging' });
  const [eurusdD,   setEurusdD]   = useState(null);
  const [dxy15m,    setDxy15m]    = useState(null);
  const [events,    setEvents]    = useState([]);
  const [cot,       setCot]       = useState(null);
  const [us10y,     setUs10y]     = useState(null);
  const [reversal,  setReversal]  = useState(null);
  const [hasOanda,  setHasOanda]  = useState(false);
  const [loading,   setLoading]   = useState(true);
  const [dxyPct,    setDxyPct]    = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    fetchCalendar().then(ev => setEvents(ev));
    fetchUSDCOT().then(setCot);

    const creds = getOandaCreds();
    setHasOanda(!!creds);

    if (creds) {
      const [wC, dC, h4C, h1C, m30C, m15C, b10C] = await Promise.all([
        fetchCandles('EUR_USD', 'W',   60,  creds),
        fetchCandles('EUR_USD', 'D',   120, creds),
        fetchCandles('EUR_USD', 'H4',  120, creds),
        fetchCandles('EUR_USD', 'H1',  100, creds),
        fetchCandles('EUR_USD', 'M30', 100, creds),
        fetchCandles('EUR_USD', 'M15', 100, creds),
        fetchCandles('USB10Y_USD', 'H1', 25, creds),
      ]);

      if (dC) setEurusdD(dC);

      const raws = [wC, dC, h4C, h1C, m30C, m15C];
      const biases = {};
      const structures = {};
      TFS.forEach((tf, i) => {
        if (raws[i]) {
          biases[tf.key]    = computeBias(toDXY(raws[i]));
          structures[tf.key] = computeStructure(toDXY(raws[i]));
        }
      });
      setTfBias(biases);
      setTfStructure(structures);

      if (h1C) {
        const p = pctDiff(toDXY(h1C), 5);
        if (p != null) setDxyPct(p);
      }

      if (dC) setStructure(computeStructure(toDXY(dC)));

      if (m15C) setDxy15m(toDXY(m15C));

      if (b10C && b10C.length >= 6) {
        const last = b10C[b10C.length - 1].c;
        const prev = b10C[b10C.length - 6].c;
        setUs10y({ dir: last > prev ? 'rising' : 'falling', val: last.toFixed(2) });
      }
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    if (events.length && dxy15m) setReversal(detectReversal(events, dxy15m));
  }, [events, dxy15m]);

  useEffect(() => { load(); }, [load]);

  // ── Confluence ─────────────────────────────────────────────────────────────
  const sigs = [];
  TFS.forEach(tf => {
    const b = tfBias[tf.key];
    if (b?.trend === 'bull') sigs.push('bull');
    if (b?.trend === 'bear') sigs.push('bear');
  });
  if (structure.pattern === 'uptrend')   sigs.push('bull');
  if (structure.pattern === 'downtrend') sigs.push('bear');
  if (cot?.direction === 'bull') sigs.push('bull');
  if (cot?.direction === 'bear') sigs.push('bear');
  if (us10y?.dir === 'rising')  sigs.push('bull');
  if (us10y?.dir === 'falling') sigs.push('bear');
  if (reversal?.signal === 'REVERSAL')
    sigs.push(reversal.dir === 'up' ? 'bear' : 'bull');
  if (reversal?.signal === 'CONTINUATION')
    sigs.push(reversal.dir === 'up' ? 'bull' : 'bear');

  const bulls = sigs.filter(s => s === 'bull').length;
  const bears = sigs.filter(s => s === 'bear').length;
  const total = bulls + bears || 1;
  const ratio = bulls / total;

  let verdict, conf, vc;
  if      (ratio >= 0.75) { verdict = 'BULLISH'; conf = 'HIGH';   vc = '#22c55e'; }
  else if (ratio >= 0.6)  { verdict = 'BULLISH'; conf = 'MEDIUM'; vc = '#86efac'; }
  else if (ratio <= 0.25) { verdict = 'BEARISH'; conf = 'HIGH';   vc = '#ef4444'; }
  else if (ratio <= 0.4)  { verdict = 'BEARISH'; conf = 'MEDIUM'; vc = '#fca5a5'; }
  else                    { verdict = 'NEUTRAL';  conf = 'WAIT';   vc = '#94a3b8'; }

  const buyPairs = verdict === 'BULLISH'
    ? ['USD/JPY', 'USD/CAD', 'USD/CHF']
    : verdict === 'BEARISH'
    ? ['EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD', 'XAU/USD']
    : [];
  const sellPairs = verdict === 'BULLISH'
    ? ['EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD', 'XAU/USD']
    : verdict === 'BEARISH'
    ? ['USD/JPY', 'USD/CAD', 'USD/CHF']
    : [];

  const todayHighUSD = events
    .filter(ev => ev.impact === 'High')
    .filter(ev => new Date(ev.date).toDateString() === new Date().toDateString())
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const nextHighUSD = events
    .filter(ev => ev.impact === 'High' && new Date(ev.date) > Date.now())
    .sort((a, b) => new Date(a.date) - new Date(b.date))[0];

  const tfBullCount = Object.values(tfBias).filter(b => b.trend === 'bull').length;
  const tfBearCount = Object.values(tfBias).filter(b => b.trend === 'bear').length;

  const structureColor = structure.pattern === 'uptrend' ? '#22c55e'
    : structure.pattern === 'downtrend' ? '#ef4444' : '#94a3b8';
  const dxyIsUp = structure.pattern === 'uptrend' ||
    (tfBullCount > tfBearCount && structure.pattern === 'ranging');

  const C = (children, style = {}) => (
    <div style={{ background: '#1e293b', borderRadius: 10, padding: '13px 15px', marginBottom: 10, ...style }}>
      {children}
    </div>
  );
  const TT = txt => (
    <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.08em', marginBottom: 9, textTransform: 'uppercase' }}>
      {txt}
    </div>
  );

  return (
    <div style={{ padding: '12px 14px', fontFamily: 'monospace', color: '#f1f5f9', maxWidth: 640, margin: '0 auto', paddingBottom: 48 }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <span style={{ fontSize: 16, fontWeight: 800, color: '#38bdf8' }}>💵 DXY Dashboard</span>
          <span style={{ fontSize: 10, color: '#334155', marginLeft: 8 }}>EUR/USD inverse proxy</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {!hasOanda && (
            <span style={{ fontSize: 10, background: '#f59e0b15', color: '#f59e0b', border: '1px solid #f59e0b30', borderRadius: 5, padding: '2px 8px' }}>
              No OANDA key
            </span>
          )}
          <button
            onClick={load} disabled={loading}
            style={{ fontSize: 11, background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: loading ? '#334155' : '#94a3b8', padding: '4px 10px', cursor: 'pointer' }}
          >
            {loading ? '…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* ── Overall Verdict ── */}
      {C(
        <>
          {TT('Overall DXY Verdict')}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 34, fontWeight: 900, color: vc, lineHeight: 1 }}>{verdict}</div>
            <div>
              <div style={{ fontSize: 12, color: vc, fontWeight: 700, letterSpacing: '0.05em' }}>
                {conf} CONFIDENCE
              </div>
              <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>
                {bulls} bull · {bears} bear · {bulls+bears} signals
              </div>
              {dxyPct !== null && (
                <div style={{ fontSize: 10, color: dxyPct >= 0 ? '#22c55e' : '#ef4444', marginTop: 2 }}>
                  DXY 5-bar H1: {dxyPct >= 0 ? '+' : ''}{dxyPct.toFixed(3)}%
                </div>
              )}
            </div>
          </div>
          {verdict !== 'NEUTRAL' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ background: '#22c55e0d', border: '1px solid #22c55e20', borderRadius: 8, padding: '9px 11px' }}>
                <div style={{ fontSize: 10, color: '#22c55e', fontWeight: 700, marginBottom: 6 }}>▲ BUY</div>
                {buyPairs.map(p => (
                  <div key={p} style={{ fontSize: 12, color: '#86efac', padding: '2px 0', borderBottom: '1px solid #22c55e10' }}>{p}</div>
                ))}
              </div>
              <div style={{ background: '#ef44440d', border: '1px solid #ef444420', borderRadius: 8, padding: '9px 11px' }}>
                <div style={{ fontSize: 10, color: '#ef4444', fontWeight: 700, marginBottom: 6 }}>▼ SELL</div>
                {sellPairs.map(p => (
                  <div key={p} style={{ fontSize: 12, color: '#fca5a5', padding: '2px 0', borderBottom: '1px solid #ef444410' }}>{p}</div>
                ))}
              </div>
            </div>
          )}
          {verdict === 'NEUTRAL' && (
            <div style={{ fontSize: 11, color: '#64748b', padding: '8px 10px', background: '#0f172a', borderRadius: 7 }}>
              Signals conflicting — wait for alignment before taking positions.
            </div>
          )}
        </>,
        { border: `1px solid ${vc}28` }
      )}

      {/* ── MTF Bias Grid ── */}
      {C(
        <>
          {TT('Multi-Timeframe Bias (DXY via EUR/USD inverse)')}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, marginBottom: 10 }}>
            {TFS.map(tf => {
              const b = tfBias[tf.key];
              const trend = b?.trend ?? (hasOanda ? 'neutral' : null);
              const color = trend === 'bull' ? '#22c55e' : trend === 'bear' ? '#ef4444' : '#475569';
              const arrow = trend === 'bull' ? '▲' : trend === 'bear' ? '▼' : trend === 'neutral' ? '→' : '?';
              return (
                <div key={tf.key} style={{ textAlign: 'center', background: '#0f172a', borderRadius: 8, padding: '8px 4px', border: `1px solid ${color}22` }}>
                  <div style={{ fontSize: 9, color: '#475569', marginBottom: 3, fontWeight: 600 }}>{tf.label}</div>
                  <div style={{ fontSize: 21, color, lineHeight: 1.1 }}>{arrow}</div>
                  {trend && <div style={{ fontSize: 8, color, marginTop: 3, fontWeight: 700 }}>{trend.toUpperCase()}</div>}
                  {b?.rsi && <div style={{ fontSize: 7, color: '#334155', marginTop: 2 }}>RSI {b.rsi}</div>}
                  {(() => {
                    const s = tfStructure[tf.key];
                    if (!s) return null;
                    if (s.pattern === 'uptrend')   return <div style={{ fontSize: 7, color: '#22c55e', marginTop: 2, fontWeight: 600 }}>HH·HL</div>;
                    if (s.pattern === 'downtrend') return <div style={{ fontSize: 7, color: '#ef4444', marginTop: 2, fontWeight: 600 }}>LH·LL</div>;
                    return <div style={{ fontSize: 7, color: '#475569', marginTop: 2 }}>Rng</div>;
                  })()}
                </div>
              );
            })}
          </div>
          {hasOanda && Object.keys(tfBias).length > 0 ? (
            <div style={{ fontSize: 11, color: '#64748b' }}>
              {tfBullCount} TFs bullish · {tfBearCount} bearish
              {(tfBullCount >= 5 || tfBearCount >= 5) && (
                <span style={{ marginLeft: 10, fontWeight: 800, color: tfBullCount >= 5 ? '#22c55e' : '#ef4444' }}>
                  ✓ HIGH CONFLUENCE
                </span>
              )}
            </div>
          ) : !hasOanda ? (
            <div style={{ fontSize: 11, color: '#334155', textAlign: 'center', paddingTop: 4 }}>
              Connect OANDA API key for live MTF analysis
            </div>
          ) : null}
        </>
      )}

      {/* ── Market Structure ── */}
      {C(
        <>
          {TT('Market Structure — Daily DXY')}
          {hasOanda ? (
            <>
              <div style={{ fontSize: 14, fontWeight: 800, color: structureColor, marginBottom: 8 }}>
                {structure.pattern === 'uptrend'   ? '↗ UPTREND — Higher Highs + Higher Lows' :
                 structure.pattern === 'downtrend' ? '↘ DOWNTREND — Lower Highs + Lower Lows' :
                 '↔ RANGING — No clear direction'}
              </div>
              {eurusdD && (
                <div style={{ marginBottom: 6 }}>
                  <MiniChart eurusdCandles={eurusdD} dxyIsUp={dxyIsUp} />
                  <div style={{ fontSize: 9, color: '#334155', marginTop: 2, textAlign: 'right' }}>
                    EUR/USD Daily (DXY moves opposite ↕)
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, lineHeight: 1.6 }}>
                {structure.pattern === 'uptrend'
                  ? 'DXY making higher highs — USD strengthening structurally. Favor USD long setups.'
                  : structure.pattern === 'downtrend'
                  ? 'DXY making lower highs — USD weakening structurally. Favor USD short setups.'
                  : 'DXY ranging — no directional bias from structure. Wait for a clear break.'}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: '#334155' }}>Connect OANDA for live structure analysis</div>
          )}
        </>
      )}

      {/* ── News Intelligence ── */}
      {C(
        <>
          {TT('News Intelligence')}

          {todayHighUSD.length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: '#475569', fontWeight: 600, marginBottom: 6 }}>
                TODAY — HIGH IMPACT USD EVENTS
              </div>
              {todayHighUSD.slice(0, 5).map((ev, i) => {
                const cd   = countdown(ev.date);
                const past = new Date(ev.date) < Date.now();
                const beat = ev.actual && ev.forecast
                  ? parseFloat(ev.actual) >= parseFloat(ev.forecast) : null;
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6,
                    padding: '7px 9px', background: '#0f172a', borderRadius: 7,
                    border: `1px solid ${cd === 'NOW' ? '#ef444440' : '#1e293b'}`,
                  }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444', flexShrink: 0, marginTop: 3 }}/>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: '#e2e8f0', fontWeight: 600 }}>
                        {ev.title || ev.event}
                      </div>
                      {ev.actual && (
                        <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                          Actual: <span style={{ color: beat ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{ev.actual}</span>
                          {ev.forecast && <> · Forecast: <span>{ev.forecast}</span></>}
                          {beat !== null && (
                            <span style={{ marginLeft: 8, color: beat ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                              {beat ? '▲ Beat → DXY bullish' : '▼ Miss → DXY bearish'}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: cd ? '#f59e0b' : '#334155', flexShrink: 0 }}>
                      {cd ?? (past ? 'Released' : '')}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#334155', marginBottom: 10 }}>No high-impact USD events today</div>
          )}

          {/* Post-news reversal / continuation signal */}
          {reversal ? (
            <div style={{
              padding: '10px 13px', borderRadius: 8,
              background: reversal.signal === 'REVERSAL' ? '#ef444410' : '#22c55e10',
              border: `1px solid ${reversal.signal === 'REVERSAL' ? '#ef444432' : '#22c55e32'}`,
            }}>
              <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 4, color: reversal.signal === 'REVERSAL' ? '#ef4444' : '#22c55e' }}>
                {reversal.signal === 'REVERSAL' ? '⚡ POST-NEWS REVERSAL FORMING' : '⚡ POST-NEWS CONTINUATION'}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>
                {reversal.event.title || reversal.event.event} — {reversal.minsAgo}m ago
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                Initial spike: <span style={{ color: reversal.dir === 'up' ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                  DXY {reversal.dir === 'up' ? '▲' : '▼'} {reversal.spikePct}%
                </span>
                {reversal.isRetracing
                  ? <span style={{ color: '#fbbf24', fontWeight: 700 }}> → fading now (take opposite)</span>
                  : <span style={{ color: '#22c55e' }}> → holding (continuation valid)</span>}
              </div>
            </div>
          ) : nextHighUSD ? (
            <div style={{ padding: '9px 12px', background: '#0f172a', borderRadius: 8, border: '1px solid #1e293b' }}>
              <div style={{ fontSize: 10, color: '#475569', fontWeight: 600, marginBottom: 4 }}>NEXT HIGH-IMPACT EVENT</div>
              <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 700 }}>
                {nextHighUSD.title || nextHighUSD.event}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                in <span style={{ color: '#fbbf24', fontWeight: 700 }}>{countdown(nextHighUSD.date)}</span>
                <span style={{ color: '#475569' }}> — avoid new setups near release time</span>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#334155' }}>No upcoming high-impact USD events this week</div>
          )}
        </>
      )}

      {/* ── COT + US10Y ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div style={{ background: '#1e293b', borderRadius: 10, padding: '12px 14px' }}>
          {TT('COT — USD Positioning')}
          {cot ? (
            <>
              <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 5, color: cot.direction === 'bull' ? '#22c55e' : cot.direction === 'bear' ? '#ef4444' : '#94a3b8' }}>
                {cot.direction === 'bull' ? '▲ Long USD' : cot.direction === 'bear' ? '▼ Short USD' : '→ Neutral'}
              </div>
              <div style={{ fontSize: 10, color: '#64748b' }}>{cot.label}</div>
              {cot.date && <div style={{ fontSize: 9, color: '#334155', marginTop: 3 }}>Report: {cot.date}</div>}
              <div style={{ fontSize: 9, color: '#334155', marginTop: 1 }}>leveraged funds via EUR inverse</div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: '#334155' }}>Fetching CFTC data…</div>
          )}
        </div>
        <div style={{ background: '#1e293b', borderRadius: 10, padding: '12px 14px' }}>
          {TT('US 10Y Yield')}
          {hasOanda ? (
            us10y ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 5, color: us10y.dir === 'rising' ? '#22c55e' : '#ef4444' }}>
                  {us10y.dir === 'rising' ? '▲ Rising' : '▼ Falling'}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{us10y.val}%</div>
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                  {us10y.dir === 'rising' ? 'USD tailwind — supports DXY bull' : 'USD headwind — pressures DXY bear'}
                </div>
              </>
            ) : <div style={{ fontSize: 11, color: '#334155' }}>Fetching…</div>
          ) : (
            <div style={{ fontSize: 11, color: '#334155' }}>Needs OANDA key</div>
          )}
        </div>
      </div>

      {/* ── How to Use ── */}
      {C(
        <>
          {TT('Step-by-Step — DXY First Approach')}
          <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.85 }}>
            <div><span style={{ color: '#38bdf8', fontWeight: 700 }}>1.</span> Check MTF Bias — 4+ TFs agreeing = high confidence direction</div>
            <div><span style={{ color: '#38bdf8', fontWeight: 700 }}>2.</span> Confirm Structure — DXY uptrend or downtrend on Daily?</div>
            <div><span style={{ color: '#38bdf8', fontWeight: 700 }}>3.</span> Validate COT — institutions positioned same way?</div>
            <div><span style={{ color: '#38bdf8', fontWeight: 700 }}>4.</span> Check News — any high-impact event in next 2h? Wait or avoid.</div>
            <div><span style={{ color: '#38bdf8', fontWeight: 700 }}>5.</span> Go to Screener — trade only pairs aligned with DXY direction.</div>
          </div>
        </>,
        { background: '#0f172a', border: '1px solid #1e293b' }
      )}

    </div>
  );
}

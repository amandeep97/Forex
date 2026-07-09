'use strict';
import { useState, useEffect } from 'react';
import { computeRSI, computeEMA } from '../utils/indicatorCalc';
import { computeVWAPBands, computePivots, computeValueArea, computeFib } from '../utils/smcHelpers';

const PIP_MAP = {
  XAU_USD:0.01, XAG_USD:0.001,
  USD_JPY:0.01, GBP_JPY:0.01, EUR_JPY:0.01, AUD_JPY:0.01,
  CAD_JPY:0.01, CHF_JPY:0.01, NZD_JPY:0.01,
  US30_USD:1, NAS100_USD:1, SPX500_USD:1, DE30_EUR:1, JP225_USD:1, UK100_GBP:1,
  WTICO_USD:0.01, BCO_USD:0.01, XCU_USD:0.0001,
  BTC_USD:1, ETH_USD:0.01,
};
function pipOf(key) { return PIP_MAP[key] || 0.0001; }
function decOf(pip) { return pip >= 1 ? 2 : pip >= 0.01 ? 3 : pip >= 0.001 ? 3 : 5; }

function getCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) { const _e = localStorage.getItem('oanda_env'); return _e !== null ? { ...c, practice: _e !== 'live' } : c; }
    const k = localStorage.getItem('oanda_key');
    if (k) return { apiKey: k, practice: localStorage.getItem('oanda_env') !== 'live' };
  } catch {}
  return null;
}

async function oandaCandles(key, gran, count) {
  const creds = getCreds();
  if (!creds?.apiKey) return null;
  const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
  try {
    const r = await fetch(
      `${base}/instruments/${key}/candles?granularity=${gran}&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return (d.candles || [])
      .filter(c => c.complete)
      .map(c => ({ o:+c.mid.o, h:+c.mid.h, l:+c.mid.l, c:+c.mid.c, v:c.volume||1, t:c.time }));
  } catch { return null; }
}

const FIB_DEFAULTS = [0, 0.236, 0.382, 0.5, 0.618, 0.702, 0.786, 0.893, 1.0, 1.272, 1.618];
const FIB_KEY = 'tp_fib_levels';

function biasOf(candles) {
  if (!candles || candles.length < 15) return 'neutral';
  const rsi = computeRSI(candles, 14);
  const ema = computeEMA(candles, 20);
  const last = candles[candles.length - 1].c;
  if (last > ema && rsi > 55) return 'bullish';
  if (last < ema && rsi < 45) return 'bearish';
  return 'neutral';
}

const BIAS_COL = { bullish:'#00d4aa', bearish:'#ef4444', neutral:'#64748b' };
const BIAS_ARR = { bullish:'▲', bearish:'▼', neutral:'—' };

export default function TechnicalPanel({ pairKey, label }) {
  const pip = pipOf(pairKey);
  const dec = decOf(pip);
  const fmt = v => (v != null && isFinite(v)) ? v.toFixed(dec) : '—';

  const [tab, setTab]       = useState('fib');
  const [loading, setLoading] = useState(false);
  const [ind, setInd]       = useState(null);
  const [camMode, setCamMode] = useState(false);
  const [fibLevels, setFibLevels] = useState(() => {
    try { return JSON.parse(localStorage.getItem(FIB_KEY)) || [...FIB_DEFAULTS]; }
    catch { return [...FIB_DEFAULTS]; }
  });
  const [newLvl, setNewLvl] = useState('');

  useEffect(() => {
    if (!pairKey) return;
    setLoading(true);
    setInd(null);
    (async () => {
      const [h1, d1, h4, m15] = await Promise.all([
        oandaCandles(pairKey, 'H1', 100),
        oandaCandles(pairKey, 'D1', 5),
        oandaCandles(pairKey, 'H4', 50),
        oandaCandles(pairKey, 'M15', 80),
      ]);
      if (!h1 || !h1.length) { setLoading(false); return; }

      const price = h1[h1.length - 1].c;
      const sw    = h1.slice(-50);
      const swingHigh = Math.max(...sw.map(c => c.h));
      const swingLow  = Math.min(...sw.map(c => c.l));
      const vwap  = computeVWAPBands(h1.slice(-24));
      const va    = computeValueArea(h1.slice(-50));
      let pivots  = null;
      if (d1 && d1.length >= 2) {
        const p = d1[d1.length - 2];
        pivots = computePivots(p.h, p.l, p.c);
      }
      const mtf = { h4: biasOf(h4), h1: biasOf(h1), m15: biasOf(m15) };
      setInd({ price, swingHigh, swingLow, vwap, va, pivots, mtf });
      setLoading(false);
    })();
  }, [pairKey]);

  function addLevel() {
    const v = parseFloat(newLvl);
    if (isNaN(v) || v < 0 || v > 5) return;
    const next = [...new Set([...fibLevels, v])].sort((a, b) => a - b);
    setFibLevels(next);
    localStorage.setItem(FIB_KEY, JSON.stringify(next));
    setNewLvl('');
  }
  function removeLevel(l) {
    const next = fibLevels.filter(x => x !== l);
    setFibLevels(next);
    localStorage.setItem(FIB_KEY, JSON.stringify(next));
  }
  function resetLevels() {
    setFibLevels([...FIB_DEFAULTS]);
    localStorage.setItem(FIB_KEY, JSON.stringify(FIB_DEFAULTS));
  }

  const TABS = [
    { id:'fib',    icon:'📐', label:'Fib'        },
    { id:'vwap',   icon:'〰', label:'VWAP'       },
    { id:'pivots', icon:'🎯', label:'Pivots'     },
    { id:'vp',     icon:'📊', label:'Vol Profile' },
    { id:'mtf',    icon:'🔀', label:'MTF'        },
  ];

  const tabBtn = (active) => ({
    padding:'5px 10px', borderRadius:8, fontSize:10, fontWeight:800,
    cursor:'pointer', flexShrink:0, whiteSpace:'nowrap',
    background: active ? '#00d4aa20' : '#06090f',
    color:       active ? '#00d4aa'  : '#475569',
    border:      active ? '1px solid #00d4aa44' : '1px solid #0f1929',
  });

  const rowStyle = (bold) => ({
    display:'flex', justifyContent:'space-between', alignItems:'center',
    padding:'5px 0', borderBottom:'1px solid #070b13',
    fontWeight: bold ? 800 : 400,
  });

  return (
    <div style={{ background:'#04070f', border:'1px solid #0f1929', borderRadius:12,
      padding:'12px', marginBottom:12 }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <div style={{ fontSize:10, color:'#475569', fontWeight:700, letterSpacing:'0.08em' }}>
          📐 TECHNICAL LEVELS — {label}
        </div>
        <div style={{ fontSize:9, color:'#334155' }}>
          {loading ? 'Loading…'
            : ind ? <span>Price: <span style={{color:'#f1f5f9', fontFamily:'monospace'}}>{fmt(ind.price)}</span></span>
            : 'Connect OANDA'}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display:'flex', gap:4, marginBottom:10, overflowX:'auto', scrollbarWidth:'none' }}>
        {TABS.map(t => (
          <button key={t.id} style={tabBtn(tab === t.id)} onClick={() => setTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {!ind && !loading && (
        <div style={{ fontSize:11, color:'#334155', textAlign:'center', padding:'16px 0' }}>
          {getCreds()?.apiKey ? 'No candle data returned' : 'Connect OANDA API key to load levels'}
        </div>
      )}

      {/* ── FIB ───────────────────────────────────────────────────────────── */}
      {tab === 'fib' && (
        <>
          {/* Level editor */}
          <div style={{ display:'flex', gap:6, marginBottom:8, alignItems:'center' }}>
            <input
              value={newLvl}
              onChange={e => setNewLvl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addLevel()}
              placeholder="Add ratio (e.g. 0.702)"
              style={{ flex:1, background:'#06090f', border:'1px solid #0f1929', borderRadius:8,
                color:'#f1f5f9', fontSize:11, padding:'5px 9px', outline:'none' }}
            />
            <button onClick={addLevel} style={{ padding:'5px 10px', borderRadius:8, fontSize:10,
              fontWeight:800, background:'#00d4aa20', color:'#00d4aa',
              border:'1px solid #00d4aa44', cursor:'pointer' }}>Add</button>
            <button onClick={resetLevels} style={{ padding:'5px 8px', borderRadius:8, fontSize:9,
              fontWeight:700, background:'transparent', color:'#334155',
              border:'1px solid #0f1929', cursor:'pointer' }}>Reset</button>
          </div>

          {/* Active level chips */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:8 }}>
            {fibLevels.map(l => (
              <div key={l} style={{ display:'flex', alignItems:'center', gap:2,
                background:'#06090f', border:'1px solid #0f1929', borderRadius:6, padding:'2px 7px' }}>
                <span style={{ fontSize:9, color: FIB_DEFAULTS.includes(l) ? '#64748b' : '#f59e0b' }}>
                  {(l * 100).toFixed(1)}%
                </span>
                {!FIB_DEFAULTS.includes(l) && (
                  <button onClick={() => removeLevel(l)} style={{ background:'transparent', border:'none',
                    color:'#475569', fontSize:10, cursor:'pointer', lineHeight:1, padding:'0 0 0 2px' }}>✕</button>
                )}
              </div>
            ))}
          </div>

          {/* Swing range */}
          {ind && (
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:9,
              color:'#334155', marginBottom:6, padding:'4px 0', borderBottom:'1px solid #0a0d14' }}>
              <span>Swing High: <span style={{color:'#ef4444', fontFamily:'monospace'}}>{fmt(ind.swingHigh)}</span></span>
              <span>Swing Low: <span style={{color:'#00d4aa', fontFamily:'monospace'}}>{fmt(ind.swingLow)}</span></span>
            </div>
          )}

          {/* Fib table */}
          {ind && (() => {
            const fibs = computeFib(ind.swingHigh, ind.swingLow, fibLevels);
            const range = ind.swingHigh - ind.swingLow;
            return (
              <div>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:8,
                  color:'#334155', padding:'0 0 4px', marginBottom:2,
                  borderBottom:'1px solid #0a0d14', fontWeight:700, letterSpacing:'0.06em' }}>
                  <span style={{minWidth:70}}>LEVEL</span>
                  <span>PRICE</span>
                  <span style={{minWidth:55, textAlign:'right'}}>DIST</span>
                </div>
                {fibs.map(f => {
                  const abv = f.price > ind.price;
                  const dist = Math.abs(f.price - ind.price);
                  const isClose = dist < range * 0.015;
                  const isOTE   = [0.618, 0.702, 0.786, 0.893].includes(f.ratio);
                  const isEq    = f.ratio === 0.5;
                  const col = isOTE ? '#f59e0b' : isEq ? '#8b5cf6' : '#64748b';
                  return (
                    <div key={f.ratio} style={{
                      display:'flex', justifyContent:'space-between', alignItems:'center',
                      padding:'4px 0', borderBottom:'1px solid #050810',
                      background: isClose ? '#00d4aa08' : isOTE ? '#f59e0b06' : 'transparent',
                    }}>
                      <span style={{ fontSize:10, color:col, fontWeight:isOTE||isEq?800:400, minWidth:70 }}>
                        {f.label}{isOTE?' ⭐':''}
                      </span>
                      <span style={{ fontSize:11, fontFamily:'monospace', fontWeight:700,
                        color: abv ? '#ef4444' : '#22c55e' }}>
                        {fmt(f.price)}
                      </span>
                      <span style={{ fontSize:9, color:'#334155', fontFamily:'monospace',
                        minWidth:55, textAlign:'right' }}>
                        {(dist / pip).toFixed(0)}p {abv ? '↑' : '↓'}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </>
      )}

      {/* ── VWAP ──────────────────────────────────────────────────────────── */}
      {tab === 'vwap' && ind && (
        <div>
          <div style={{ fontSize:9, color:'#334155', marginBottom:8 }}>
            Session VWAP = last 24 H1 candles · ±1σ / ±2σ standard deviation bands
          </div>
          {[
            { label:'+2σ', val:ind.vwap?.upper2, col:'#ef444488' },
            { label:'+1σ', val:ind.vwap?.upper1, col:'#f59e0b88' },
            { label:'VWAP', val:ind.vwap?.vwap,  col:'#00d4aa', bold:true },
            { label:'−1σ', val:ind.vwap?.lower1, col:'#f59e0b88' },
            { label:'−2σ', val:ind.vwap?.lower2, col:'#ef444488' },
          ].map(row => (
            <div key={row.label} style={rowStyle(row.bold)}>
              <span style={{ fontSize:10, color:row.col, fontWeight:row.bold?800:600, minWidth:40 }}>{row.label}</span>
              <span style={{ fontSize:11, fontFamily:'monospace', fontWeight:700, color:row.col }}>{fmt(row.val)}</span>
              <span style={{ fontSize:9, color:'#334155' }}>
                {row.val != null ? `${(Math.abs(row.val - ind.price) / pip).toFixed(0)}p` : ''}
              </span>
            </div>
          ))}
          {ind.vwap && (
            <div style={{ marginTop:10, padding:'8px 12px', borderRadius:8, fontSize:11, fontWeight:700,
              background: ind.price >= ind.vwap.vwap ? '#00d4aa12' : '#ef444412',
              border: `1px solid ${ind.price >= ind.vwap.vwap ? '#00d4aa33' : '#ef444433'}`,
              color: ind.price >= ind.vwap.vwap ? '#00d4aa' : '#ef4444' }}>
              Price is {ind.price >= ind.vwap.vwap ? 'ABOVE VWAP → Bullish bias' : 'BELOW VWAP → Bearish bias'}
            </div>
          )}
        </div>
      )}

      {/* ── PIVOTS ────────────────────────────────────────────────────────── */}
      {tab === 'pivots' && ind && (
        <div>
          <div style={{ display:'flex', gap:6, marginBottom:8 }}>
            {['Classic','Camarilla'].map(m => (
              <button key={m} onClick={() => setCamMode(m==='Camarilla')} style={tabBtn(camMode===(m==='Camarilla'))}>
                {m}
              </button>
            ))}
          </div>
          {ind.pivots ? (() => {
            const rows = camMode ? [
              { label:'R4 — Extreme',  val:ind.pivots.cR4, col:'#ef4444' },
              { label:'R3 — Breakout', val:ind.pivots.cR3, col:'#f97316' },
              { label:'R2',            val:ind.pivots.cR2, col:'#f59e0b' },
              { label:'R1',            val:ind.pivots.cR1, col:'#86efac' },
              { label:'Pivot (P)',     val:ind.pivots.P,   col:'#f1f5f9', bold:true },
              { label:'S1',            val:ind.pivots.cS1, col:'#86efac' },
              { label:'S2',            val:ind.pivots.cS2, col:'#f59e0b' },
              { label:'S3 — Breakout', val:ind.pivots.cS3, col:'#f97316' },
              { label:'S4 — Extreme',  val:ind.pivots.cS4, col:'#ef4444' },
            ] : [
              { label:'R3', val:ind.pivots.R3, col:'#ef4444' },
              { label:'R2', val:ind.pivots.R2, col:'#f97316' },
              { label:'R1', val:ind.pivots.R1, col:'#f59e0b' },
              { label:'Pivot (P)', val:ind.pivots.P, col:'#f1f5f9', bold:true },
              { label:'S1', val:ind.pivots.S1, col:'#22c55e' },
              { label:'S2', val:ind.pivots.S2, col:'#16a34a' },
              { label:'S3', val:ind.pivots.S3, col:'#15803d' },
            ];
            return rows.map(row => {
              const abv = row.val > ind.price;
              const close = Math.abs(row.val - ind.price) < (ind.swingHigh - ind.swingLow) * 0.015;
              return (
                <div key={row.label} style={{ ...rowStyle(row.bold),
                  background: close ? '#ffffff08' : 'transparent' }}>
                  <span style={{ fontSize:10, color:row.col, fontWeight:row.bold?800:600, minWidth:80 }}>{row.label}</span>
                  <span style={{ fontSize:11, fontFamily:'monospace', fontWeight:700, color:row.col }}>{fmt(row.val)}</span>
                  <span style={{ fontSize:9, color:'#334155' }}>{abv ? '↑ res' : '↓ sup'}</span>
                </div>
              );
            });
          })() : (
            <div style={{ fontSize:11, color:'#334155', textAlign:'center', padding:'12px 0' }}>
              Need D1 candles — connect OANDA
            </div>
          )}
        </div>
      )}

      {/* ── VOLUME PROFILE ────────────────────────────────────────────────── */}
      {tab === 'vp' && ind && (
        <div>
          {ind.va ? (
            <>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:10 }}>
                {[
                  { label:'VAH', val:ind.va.vah, col:'#22c55e' },
                  { label:'POC', val:ind.va.poc, col:'#f59e0b' },
                  { label:'VAL', val:ind.va.val, col:'#ef4444' },
                ].map(item => (
                  <div key={item.label} style={{ background:'#06090f', border:`1px solid ${item.col}33`,
                    borderRadius:8, padding:'8px', textAlign:'center' }}>
                    <div style={{ fontSize:8, color:item.col, fontWeight:800, letterSpacing:'0.06em', marginBottom:3 }}>
                      {item.label}
                    </div>
                    <div style={{ fontSize:11, fontWeight:900, color:item.col, fontFamily:'monospace' }}>
                      {fmt(item.val)}
                    </div>
                    <div style={{ fontSize:8, color:'#334155', marginTop:2 }}>
                      {(Math.abs(item.val - ind.price) / pip).toFixed(0)}p
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize:9, color:'#334155', marginBottom:6 }}>
                Value Area 70% · last 50 H1 candles · 🟡 POC · 🟢 VAH · 🔴 VAL
              </div>
              <div style={{ maxHeight:200, overflowY:'auto', scrollbarWidth:'none' }}>
                {[...ind.va.distribution].reverse().map((bar, i) => {
                  const wPct  = ind.va.maxVol > 0 ? (bar.vol / ind.va.maxVol * 100) : 0;
                  const isVAH = Math.abs(bar.price - ind.va.vah) < (ind.va.rangeHigh - ind.va.rangeLow) / 58;
                  const isVAL = Math.abs(bar.price - ind.va.val) < (ind.va.rangeHigh - ind.va.rangeLow) / 58;
                  const col   = bar.isPoc ? '#f59e0b' : isVAH ? '#22c55e55' : isVAL ? '#ef444455' : '#1e3a5f';
                  return (
                    <div key={i} style={{ display:'flex', alignItems:'center', gap:4, height:7, marginBottom:1 }}>
                      <span style={{ fontSize:7, color:'#1e293b', width:48, textAlign:'right', flexShrink:0,
                        fontFamily:'monospace' }}>
                        {bar.price.toFixed(dec)}
                      </span>
                      <div style={{ flex:1, height:5, background:'#06090f', borderRadius:1 }}>
                        <div style={{ width:`${wPct}%`, height:'100%', background:col, borderRadius:1 }}/>
                      </div>
                      {bar.isPoc && <span style={{ fontSize:7, color:'#f59e0b', fontWeight:800, flexShrink:0 }}>●</span>}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div style={{ fontSize:11, color:'#334155', textAlign:'center', padding:'16px 0' }}>
              No volume data
            </div>
          )}
        </div>
      )}

      {/* ── MTF ───────────────────────────────────────────────────────────── */}
      {tab === 'mtf' && ind && (() => {
        const tfs = [
          { label:'H4',  bias:ind.mtf.h4  },
          { label:'H1',  bias:ind.mtf.h1  },
          { label:'M15', bias:ind.mtf.m15 },
        ];
        const bulls = tfs.filter(t => t.bias === 'bullish').length;
        const bears = tfs.filter(t => t.bias === 'bearish').length;
        const consensus = bulls >= 2 ? 'BULLISH' : bears >= 2 ? 'BEARISH' : 'MIXED';
        const cc = bulls >= 2 ? '#00d4aa' : bears >= 2 ? '#ef4444' : '#f59e0b';
        return (
          <div>
            <div style={{ fontSize:9, color:'#334155', marginBottom:10 }}>
              Bias = price vs EMA20 + RSI(14) per timeframe
            </div>
            {tfs.map(tf => (
              <div key={tf.label} style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                padding:'10px 12px', marginBottom:6, borderRadius:10,
                background: BIAS_COL[tf.bias] + '12',
                border: `1px solid ${BIAS_COL[tf.bias]}33` }}>
                <span style={{ fontSize:14, fontWeight:900, color:'#94a3b8' }}>{tf.label}</span>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span style={{ fontSize:22, color:BIAS_COL[tf.bias], lineHeight:1 }}>{BIAS_ARR[tf.bias]}</span>
                  <span style={{ fontSize:12, fontWeight:800, color:BIAS_COL[tf.bias], textTransform:'uppercase' }}>
                    {tf.bias}
                  </span>
                </div>
              </div>
            ))}
            <div style={{ marginTop:10, padding:'10px', borderRadius:10, textAlign:'center',
              background:`${cc}10`, border:`1px solid ${cc}33` }}>
              <div style={{ fontSize:9, color:'#475569', marginBottom:3, fontWeight:700,
                letterSpacing:'0.06em' }}>CONSENSUS</div>
              <div style={{ fontSize:17, fontWeight:900, color:cc }}>{consensus}</div>
              <div style={{ fontSize:9, color:'#475569', marginTop:3 }}>
                {bulls} bullish · {bears} bearish · {3 - bulls - bears} neutral
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

'use strict';
import { useState, useCallback } from 'react';

const DOW_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const PAIRS = [
  { key:'EUR_USD',    label:'EUR/USD',  pip:0.0001 },
  { key:'GBP_USD',   label:'GBP/USD',  pip:0.0001 },
  { key:'USD_JPY',   label:'USD/JPY',  pip:0.01   },
  { key:'GBP_JPY',   label:'GBP/JPY',  pip:0.01   },
  { key:'AUD_USD',   label:'AUD/USD',  pip:0.0001 },
  { key:'USD_CAD',   label:'USD/CAD',  pip:0.0001 },
  { key:'NZD_USD',   label:'NZD/USD',  pip:0.0001 },
  { key:'XAU_USD',   label:'XAU/USD',  pip:0.1    },
  { key:'US30_USD',  label:'US30',     pip:1       },
  { key:'NAS100_USD',label:'NAS100',   pip:0.1    },
];

function getCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) return c;
  } catch {}
  const k = localStorage.getItem('oanda_key');
  return k ? { apiKey: k, practice: localStorage.getItem('oanda_env') !== 'live' } : null;
}

async function fetchDaily(pairKey, count) {
  const creds = getCreds();
  if (!creds) return null;
  const base = creds.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  try {
    const res = await fetch(
      `${base}/instruments/${pairKey}/candles?granularity=D&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.candles || []).filter(c => c.complete).map(c => ({
      t:    new Date(c.time).getTime(),
      o:   +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c,
      dow:  DOW_LABELS[new Date(c.time).getDay()],
      date: c.time.slice(0, 10),
    }));
  } catch { return null; }
}

// ── Pattern detection ─────────────────────────────────────────────────────────

function detectPatterns(candles, pip) {
  const results = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];
    if (curr.dow === 'Sun' || prev.dow === 'Sun') continue;

    // Failed High: curr high < prev high → next visits curr low
    if (curr.h < prev.h) {
      results.push({
        type:      'FAILED_HIGH',
        direction: 'bearish',
        date:       curr.date,
        dayCombo:  `${prev.dow}→${curr.dow}→${next.dow}`,
        prevDOW:    prev.dow, currDOW: curr.dow, nextDOW: next.dow,
        prevExtreme: prev.h,
        currExtreme: curr.h,
        target:      curr.l,
        nextL:       next.l, nextH: next.h,
        hit:         next.l <= curr.l,
        pips:        Math.round(Math.abs(curr.h - curr.l) / pip),
      });
    }

    // Failed Low: curr low > prev low → next visits curr high
    if (curr.l > prev.l) {
      results.push({
        type:      'FAILED_LOW',
        direction: 'bullish',
        date:       curr.date,
        dayCombo:  `${prev.dow}→${curr.dow}→${next.dow}`,
        prevDOW:    prev.dow, currDOW: curr.dow, nextDOW: next.dow,
        prevExtreme: prev.l,
        currExtreme: curr.l,
        target:      curr.h,
        nextL:       next.l, nextH: next.h,
        hit:         next.h >= curr.h,
        pips:        Math.round(Math.abs(curr.h - curr.l) / pip),
      });
    }
  }

  // Extended: Wed high < Mon high → Thu visits Wed low (user's second rule)
  for (let i = 2; i < candles.length - 1; i++) {
    const mon  = candles[i - 2];
    const curr = candles[i];
    const next = candles[i + 1];
    if (mon.dow !== 'Mon' || curr.dow !== 'Wed') continue;

    if (curr.h < mon.h) {
      results.push({
        type:      'WED_FAILED_MON',
        direction: 'bearish',
        date:       curr.date,
        dayCombo:  'Mon→Wed→Thu (extended)',
        prevDOW: 'Mon', currDOW: 'Wed', nextDOW: next.dow,
        prevExtreme: mon.h,
        currExtreme: curr.h,
        target:      curr.l,
        nextL:       next.l, nextH: next.h,
        hit:         next.l <= curr.l,
        pips:        Math.round(Math.abs(curr.h - curr.l) / pip),
      });
    }

    if (curr.l > mon.l) {
      results.push({
        type:      'WED_FAILED_MON_BULL',
        direction: 'bullish',
        date:       curr.date,
        dayCombo:  'Mon→Wed→Thu (extended)',
        prevDOW: 'Mon', currDOW: 'Wed', nextDOW: next.dow,
        prevExtreme: mon.l,
        currExtreme: curr.l,
        target:      curr.h,
        nextL:       next.l, nextH: next.h,
        hit:         next.h >= curr.h,
        pips:        Math.round(Math.abs(curr.h - curr.l) / pip),
      });
    }
  }

  return results.sort((a, b) => b.date.localeCompare(a.date));
}

function buildStats(patterns) {
  const byCombo  = {};
  const byType   = { FAILED_HIGH: { t:0,h:0 }, FAILED_LOW: { t:0,h:0 }, EXT: { t:0,h:0 } };

  patterns.forEach(p => {
    if (!byCombo[p.dayCombo]) byCombo[p.dayCombo] = { t:0, h:0 };
    byCombo[p.dayCombo].t++;
    if (p.hit) byCombo[p.dayCombo].h++;

    const tk = p.type === 'FAILED_HIGH' ? 'FAILED_HIGH'
             : p.type === 'FAILED_LOW'  ? 'FAILED_LOW'  : 'EXT';
    byType[tk].t++;
    if (p.hit) byType[tk].h++;
  });

  return { byCombo, byType };
}

// ── Main component ────────────────────────────────────────────────────────────
export default function DOWPatterns() {
  const [view,         setView]         = useState('backtest');
  const [selPair,      setSelPair]      = useState('EUR_USD');
  const [lookback,     setLookback]     = useState(200);
  const [results,      setResults]      = useState(null);
  const [livePatterns, setLivePatterns] = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [filterCombo,  setFilterCombo]  = useState('all');
  const [filterDir,    setFilterDir]    = useState('all');

  const hasOanda = !!getCreds();

  const runBacktest = useCallback(async () => {
    if (!hasOanda) return;
    setLoading(true);
    const pair    = PAIRS.find(p => p.key === selPair);
    const candles = await fetchDaily(selPair, lookback);
    if (!candles || candles.length < 3) {
      setResults({ error: true });
      setLoading(false);
      return;
    }
    const patterns = detectPatterns(candles, pair.pip);
    const stats    = buildStats(patterns);
    setResults({ patterns, stats, pair, lookback });
    setFilterCombo('all');
    setFilterDir('all');
    setLoading(false);
  }, [selPair, lookback, hasOanda]);

  const runLiveScan = useCallback(async () => {
    if (!hasOanda) return;
    setLoading(true);
    const found = [];
    for (const pair of PAIRS) {
      const candles = await fetchDaily(pair.key, 5);
      if (!candles || candles.length < 2) continue;
      const n    = candles.length;
      const prev = candles[n - 2];
      const curr = candles[n - 1];
      if (curr.dow === 'Sun' || prev.dow === 'Sun') continue;

      if (curr.h < prev.h) {
        const dec = pair.pip < 0.01 ? 5 : (pair.pip < 1 ? 3 : 1);
        found.push({
          pair: pair.label, pairKey: pair.key, direction: 'bearish',
          dayCombo: `${prev.dow}→${curr.dow}`,
          desc: `${curr.dow} high (${curr.h.toFixed(dec)}) < ${prev.dow} high (${prev.h.toFixed(dec)})`,
          target: curr.l, targetStr: curr.l.toFixed(dec),
          nextDOW: 'Next session', pip: pair.pip,
        });
      }
      if (curr.l > prev.l) {
        const dec = pair.pip < 0.01 ? 5 : (pair.pip < 1 ? 3 : 1);
        found.push({
          pair: pair.label, pairKey: pair.key, direction: 'bullish',
          dayCombo: `${prev.dow}→${curr.dow}`,
          desc: `${curr.dow} low (${curr.l.toFixed(dec)}) > ${prev.dow} low (${prev.l.toFixed(dec)})`,
          target: curr.h, targetStr: curr.h.toFixed(dec),
          nextDOW: 'Next session', pip: pair.pip,
        });
      }
    }
    setLivePatterns(found);
    setLoading(false);
  }, [hasOanda]);

  // Filtered backtest rows
  const filtered = results?.patterns
    ? results.patterns.filter(p =>
        (filterCombo === 'all' || p.dayCombo === filterCombo) &&
        (filterDir   === 'all' || p.direction === filterDir)
      )
    : [];

  const combos = results?.patterns ? [...new Set(results.patterns.map(p => p.dayCombo))] : [];
  const total  = results?.patterns?.length ?? 0;
  const hits   = results?.patterns?.filter(p => p.hit).length ?? 0;
  const hr     = total > 0 ? Math.round((hits / total) * 100) : 0;

  // ── Styles ──────────────────────────────────────────────────────────────────
  const S  = (extra={}) => ({ background:'#1e293b', borderRadius:10, padding:'12px 14px', marginBottom:10, ...extra });
  const TT = txt => (
    <div style={{ fontSize:10, fontWeight:700, color:'#475569', letterSpacing:'0.08em', marginBottom:8, textTransform:'uppercase' }}>
      {txt}
    </div>
  );
  const Btn = ({ id, label, active, onClick }) => (
    <button onClick={onClick} style={{
      fontSize:11, fontWeight:700, padding:'5px 13px', borderRadius:7, cursor:'pointer',
      background: active ? '#00d4aa18' : '#0f172a',
      color:      active ? '#00d4aa'   : '#475569',
      border: `1px solid ${active ? '#00d4aa35' : '#1e293b'}`,
    }}>{label}</button>
  );

  return (
    <div style={{ fontFamily:'monospace', color:'#f1f5f9', padding:'12px 14px', maxWidth:720, paddingBottom:40 }}>

      {/* Sub-nav */}
      <div style={{ display:'flex', gap:6, marginBottom:12 }}>
        <Btn id="backtest" label="📊 Backtest (Past)"    active={view==='backtest'} onClick={() => setView('backtest')} />
        <Btn id="live"     label="⚡ Live Scan (Current)" active={view==='live'}     onClick={() => setView('live')}     />
      </div>

      {!hasOanda && (
        <div style={{ ...S(), background:'#f59e0b0d', border:'1px solid #f59e0b22', fontSize:11, color:'#f59e0b', marginBottom:10 }}>
          ⚠ OANDA API key required — connect in Settings to enable live data
        </div>
      )}

      {/* ── BACKTEST ── */}
      {view === 'backtest' && (
        <>
          {/* Controls */}
          <div style={{ ...S(), display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
            <select value={selPair} onChange={e => setSelPair(e.target.value)}
              style={{ fontSize:11, background:'#0f172a', color:'#f1f5f9', border:'1px solid #334155', borderRadius:6, padding:'5px 9px' }}>
              {PAIRS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            <select value={lookback} onChange={e => setLookback(+e.target.value)}
              style={{ fontSize:11, background:'#0f172a', color:'#f1f5f9', border:'1px solid #334155', borderRadius:6, padding:'5px 9px' }}>
              <option value={100}>~4 months</option>
              <option value={200}>~8 months</option>
              <option value={365}>~1 year</option>
              <option value={500}>~2 years</option>
            </select>
            <button onClick={runBacktest} disabled={loading || !hasOanda} style={{
              fontSize:11, fontWeight:700, padding:'5px 14px', borderRadius:7, cursor: hasOanda ? 'pointer':'not-allowed',
              background: loading ? '#0f172a' : '#00d4aa1a',
              color:      loading ? '#334155' : '#00d4aa',
              border:'1px solid #00d4aa30',
            }}>
              {loading ? 'Running…' : '▶ Run Backtest'}
            </button>
          </div>

          {results?.error && (
            <div style={{ ...S(), color:'#ef4444', fontSize:12 }}>Could not fetch candles. Check your OANDA connection.</div>
          )}

          {/* Summary */}
          {results?.patterns && (
            <>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:10 }}>
                {[
                  { val: total,  label:'PATTERNS FOUND', color:'#38bdf8' },
                  { val: `${hr}%`, label:'OVERALL HIT RATE', color: hr>=60?'#22c55e':hr>=45?'#f59e0b':'#ef4444' },
                  { val: hits,   label:'TIMES HIT TARGET', color:'#22c55e' },
                ].map((s,i) => (
                  <div key={i} style={{ ...S({ marginBottom:0, textAlign:'center' }) }}>
                    <div style={{ fontSize:26, fontWeight:900, color:s.color }}>{s.val}</div>
                    <div style={{ fontSize:9, color:'#475569', marginTop:3 }}>{s.label}</div>
                  </div>
                ))}
              </div>

              {/* By pattern type */}
              <div style={S()}>
                {TT('Hit Rate by Pattern Type')}
                {[
                  { key:'FAILED_HIGH', label:'Failed High → Next day visits LOW',  color:'#ef4444' },
                  { key:'FAILED_LOW',  label:'Failed Low → Next day visits HIGH',  color:'#22c55e' },
                  { key:'EXT',         label:'Wed below Mon → Thu visits Wed low',  color:'#a78bfa' },
                ].map(pt => {
                  const d    = results.stats.byType[pt.key];
                  const rate = d.t > 0 ? Math.round((d.h/d.t)*100) : 0;
                  const rateColor = rate>=60?'#22c55e':rate>=45?'#f59e0b':'#ef4444';
                  if (!d.t) return null;
                  return (
                    <div key={pt.key} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 10px', background:'#0f172a', borderRadius:7, marginBottom:6 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:11, color:pt.color, fontWeight:700 }}>{pt.label}</div>
                        <div style={{ fontSize:10, color:'#475569', marginTop:2 }}>{d.h} hits / {d.t} occurrences</div>
                      </div>
                      <div style={{ fontSize:20, fontWeight:900, color:rateColor }}>{rate}%</div>
                    </div>
                  );
                })}
              </div>

              {/* By day combo */}
              <div style={S()}>
                {TT('Hit Rate by Day Combination')}
                {Object.entries(results.stats.byCombo)
                  .sort((a,b) => b[1].t - a[1].t)
                  .map(([combo, stat]) => {
                    const rate = stat.t > 0 ? Math.round((stat.h/stat.t)*100) : 0;
                    const rateColor = rate>=60?'#22c55e':rate>=45?'#f59e0b':'#ef4444';
                    return (
                      <div key={combo} style={{ marginBottom:8 }}>
                        <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:3 }}>
                          <span style={{ color:'#94a3b8' }}>{combo}</span>
                          <span style={{ color:rateColor, fontWeight:700 }}>{rate}% &nbsp;({stat.h}/{stat.t})</span>
                        </div>
                        <div style={{ height:5, background:'#0f172a', borderRadius:3 }}>
                          <div style={{ height:'100%', width:`${rate}%`, background:rateColor, borderRadius:3, transition:'width 0.4s' }}/>
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* Filter + log */}
              <div style={S()}>
                {TT('Occurrence Log')}
                <div style={{ display:'flex', gap:5, marginBottom:8, flexWrap:'wrap' }}>
                  {['all','bearish','bullish'].map(d => (
                    <Btn key={d} id={d} label={d==='all'?'All dir':d} active={filterDir===d} onClick={() => setFilterDir(d)} />
                  ))}
                  <span style={{ color:'#334155', alignSelf:'center', fontSize:11 }}>|</span>
                  <Btn id="all" label="All combos" active={filterCombo==='all'} onClick={() => setFilterCombo('all')} />
                  {combos.slice(0,6).map(c => (
                    <Btn key={c} id={c} label={c} active={filterCombo===c} onClick={() => setFilterCombo(c)} />
                  ))}
                </div>
                <div style={{ maxHeight:300, overflowY:'auto' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10 }}>
                    <thead>
                      <tr style={{ color:'#334155' }}>
                        {['','Date','Combo','Dir','Target','Result','Pips'].map((h,i) => (
                          <td key={i} style={{ padding:'4px 6px', borderBottom:'1px solid #1e293b' }}>{h}</td>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0,80).map((r,i) => (
                        <tr key={i} style={{ background: i%2===0?'#0a1120':'transparent' }}>
                          <td style={{ padding:'4px 6px' }}>
                            <span style={{ width:7, height:7, borderRadius:'50%', background:r.hit?'#22c55e':'#ef4444', display:'inline-block' }}/>
                          </td>
                          <td style={{ padding:'4px 6px', color:'#64748b' }}>{r.date}</td>
                          <td style={{ padding:'4px 6px', color:'#94a3b8' }}>{r.dayCombo}</td>
                          <td style={{ padding:'4px 6px', color:r.direction==='bearish'?'#ef4444':'#22c55e', fontWeight:700 }}>
                            {r.direction==='bearish'?'▼':'▲'}
                          </td>
                          <td style={{ padding:'4px 6px', color:'#94a3b8' }}>{r.target?.toFixed(r.pips<10?5:2)}</td>
                          <td style={{ padding:'4px 6px', fontWeight:700, color:r.hit?'#22c55e':'#ef4444' }}>{r.hit?'HIT':'MISS'}</td>
                          <td style={{ padding:'4px 6px', color:'#475569' }}>{r.pips}p</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filtered.length > 80 && (
                    <div style={{ fontSize:10, color:'#334155', textAlign:'center', padding:8 }}>
                      Showing 80 of {filtered.length}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {!results && !loading && (
            <div style={{ ...S({ background:'#0f172a', border:'1px solid #1e293b', textAlign:'center' }) }}>
              <div style={{ fontSize:12, color:'#334155', padding:'24px 0 16px' }}>
                Select a pair and click Run Backtest
              </div>
              <div style={{ fontSize:11, color:'#1e293b', paddingBottom:16 }}>
                Tests: Failed High → Next Day Low · Failed Low → Next Day High · Wed/Mon extended
              </div>
            </div>
          )}
        </>
      )}

      {/* ── LIVE SCAN ── */}
      {view === 'live' && (
        <>
          <div style={{ ...S(), display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ fontSize:11, color:'#64748b' }}>
              Checks last 2 completed daily candles across all pairs for active patterns
            </div>
            <button onClick={runLiveScan} disabled={loading || !hasOanda} style={{
              fontSize:11, fontWeight:700, padding:'5px 14px', borderRadius:7, cursor: hasOanda?'pointer':'not-allowed',
              background: loading?'#0f172a':'#00d4aa1a', color:loading?'#334155':'#00d4aa', border:'1px solid #00d4aa30',
            }}>
              {loading ? 'Scanning…' : '⚡ Scan Now'}
            </button>
          </div>

          {livePatterns !== null && (
            livePatterns.length > 0 ? (
              <div style={S()}>
                {TT(`Active DOW Patterns — ${livePatterns.length} found`)}
                {livePatterns.map((p, i) => (
                  <div key={i} style={{
                    padding:'10px 13px', borderRadius:8, marginBottom:8,
                    background: p.direction==='bearish'?'#ef444410':'#22c55e10',
                    border:`1px solid ${p.direction==='bearish'?'#ef444428':'#22c55e28'}`,
                  }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                      <span style={{ fontSize:14, fontWeight:800, color:'#f1f5f9' }}>{p.pair}</span>
                      <span style={{ fontSize:11, fontWeight:800, color:p.direction==='bearish'?'#ef4444':'#22c55e' }}>
                        {p.direction==='bearish'?'▼ BEARISH':'▲ BULLISH'}
                      </span>
                    </div>
                    <div style={{ fontSize:11, color:'#94a3b8', marginBottom:5 }}>{p.desc}</div>
                    <div style={{ fontSize:12, color:'#64748b' }}>
                      {p.nextDOW} target:{' '}
                      <span style={{ color:p.direction==='bearish'?'#fca5a5':'#86efac', fontWeight:800, fontSize:13 }}>
                        {p.targetStr}
                      </span>
                      <span style={{ color:'#334155', marginLeft:8, fontSize:10 }}>
                        (visits {p.direction==='bearish'?'low':'high'})
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ ...S({ background:'#0f172a', border:'1px solid #1e293b', textAlign:'center' }) }}>
                <div style={{ fontSize:12, color:'#334155', padding:'20px 0' }}>No active DOW patterns right now</div>
              </div>
            )
          )}

          {!livePatterns && !loading && (
            <div style={{ ...S({ background:'#0f172a', border:'1px solid #1e293b', textAlign:'center' }) }}>
              <div style={{ fontSize:12, color:'#334155', padding:'24px 0' }}>Click Scan Now to check current patterns</div>
            </div>
          )}

          {/* Rules reference */}
          <div style={{ ...S({ background:'#0f172a', border:'1px solid #1e293b' }) }}>
            {TT('Pattern Rules — ICT Day of Week')}
            <div style={{ fontSize:11, color:'#64748b', lineHeight:1.9 }}>
              <div style={{ color:'#ef4444', fontWeight:700 }}>▼ Failed High (Bearish)</div>
              <div>Day N high <span style={{ color:'#f1f5f9' }}>BELOW</span> Day N-1 high → next session visits Day N LOW</div>
              <div style={{ color:'#475569', marginBottom:10, fontSize:10 }}>
                e.g. Thu high 1.0900 · Fri high 1.0880 → Mon draws to Fri low
              </div>
              <div style={{ color:'#22c55e', fontWeight:700 }}>▲ Failed Low (Bullish)</div>
              <div>Day N low <span style={{ color:'#f1f5f9' }}>ABOVE</span> Day N-1 low → next session visits Day N HIGH</div>
              <div style={{ color:'#475569', marginBottom:10, fontSize:10 }}>
                e.g. Thu low 1.0810 · Fri low 1.0830 → Mon draws to Fri high
              </div>
              <div style={{ color:'#a78bfa', fontWeight:700 }}>◆ Extended (Wed/Mon)</div>
              <div>Wed high <span style={{ color:'#f1f5f9' }}>BELOW</span> Mon high → Thu visits Wed LOW</div>
              <div style={{ color:'#475569', fontSize:10 }}>
                Market failed to expand on Wed vs Mon — Thu draws back to collect Wed's sell-side
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

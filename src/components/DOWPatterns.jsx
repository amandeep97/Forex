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

const RULES = [
  {
    id:    'rule1',
    title: 'Rule 1 — Fri High < Thu High',
    desc:  'Monday will visit Friday\'s LOW (sell-side liquidity)',
    combo: 'Thu → Fri → Mon',
    color: '#ef4444',
  },
  {
    id:    'rule1b',
    title: 'Rule 1 Inverse — Fri Low > Thu Low',
    desc:  'Monday will visit Friday\'s HIGH (buy-side liquidity)',
    combo: 'Thu → Fri → Mon',
    color: '#22c55e',
  },
  {
    id:    'rule2',
    title: 'Rule 2 — Wed High < Mon High',
    desc:  'Thursday will visit Wednesday\'s LOW (sell-side liquidity)',
    combo: 'Mon → Wed → Thu',
    color: '#ef4444',
  },
  {
    id:    'rule2b',
    title: 'Rule 2 Inverse — Wed Low > Mon Low',
    desc:  'Thursday will visit Wednesday\'s HIGH (buy-side liquidity)',
    combo: 'Mon → Wed → Thu',
    color: '#22c55e',
  },
];

// ── OANDA fetch ───────────────────────────────────────────────────────────────

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
    const d = await res.json();
    return (d.candles || []).filter(c => c.complete).map(c => ({
      t:    new Date(c.time).getTime(),
      o:   +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c,
      dow:  DOW_LABELS[new Date(c.time).getDay()],
      date: c.time.slice(0, 10),
    }));
  } catch { return null; }
}

// ── Pattern detection ─────────────────────────────────────────────────────────

// General: any Day N high < Day N-1 high → Day N+1 visits Day N low (all combos)
function detectGeneral(candles, pip) {
  const results = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];
    if (curr.dow === 'Sun' || prev.dow === 'Sun') continue;

    if (curr.h < prev.h) {
      results.push({
        rule: 'gen_high', direction: 'bearish', date: curr.date,
        dayCombo: `${prev.dow}→${curr.dow}→${next.dow}`,
        prevDOW: prev.dow, currDOW: curr.dow, nextDOW: next.dow,
        target: curr.l, resultVal: next.l, hit: next.l <= curr.l,
        pips: Math.round((curr.h - curr.l) / pip),
      });
    }
    if (curr.l > prev.l) {
      results.push({
        rule: 'gen_low', direction: 'bullish', date: curr.date,
        dayCombo: `${prev.dow}→${curr.dow}→${next.dow}`,
        prevDOW: prev.dow, currDOW: curr.dow, nextDOW: next.dow,
        target: curr.h, resultVal: next.h, hit: next.h >= curr.h,
        pips: Math.round((curr.h - curr.l) / pip),
      });
    }
  }
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

// Rule 1: Fri high < Thu high → Mon visits Fri low
// Rule 1b: Fri low > Thu low → Mon visits Fri high
function detectRule1(candles, pip) {
  const results = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const thu = candles[i - 1];
    const fri = candles[i];
    const mon = candles[i + 1];
    if (thu.dow !== 'Thu' || fri.dow !== 'Fri' || mon.dow !== 'Mon') continue;

    if (fri.h < thu.h) {
      results.push({
        rule: 'rule1', direction: 'bearish', date: fri.date,
        refVal: thu.h, trigVal: fri.h, target: fri.l,
        resultVal: mon.l, hit: mon.l <= fri.l,
        pips: Math.round((fri.h - fri.l) / pip),
        detail: `Thu H: ${thu.h.toFixed(5)} · Fri H: ${fri.h.toFixed(5)} · Fri L: ${fri.l.toFixed(5)} · Mon L: ${mon.l.toFixed(5)}`,
      });
    }

    if (fri.l > thu.l) {
      results.push({
        rule: 'rule1b', direction: 'bullish', date: fri.date,
        refVal: thu.l, trigVal: fri.l, target: fri.h,
        resultVal: mon.h, hit: mon.h >= fri.h,
        pips: Math.round((fri.h - fri.l) / pip),
        detail: `Thu L: ${thu.l.toFixed(5)} · Fri L: ${fri.l.toFixed(5)} · Fri H: ${fri.h.toFixed(5)} · Mon H: ${mon.h.toFixed(5)}`,
      });
    }
  }
  return results;
}

// Rule 2: Wed high < Mon high → Thu visits Wed low
// Rule 2b: Wed low > Mon low → Thu visits Wed high
// Wed is compared to the Mon of the SAME week (not just preceding day)
function detectRule2(candles, pip) {
  const results = [];
  for (let i = 0; i < candles.length - 1; i++) {
    if (candles[i].dow !== 'Wed') continue;
    const wed = candles[i];
    const thu = candles[i + 1];
    if (!thu || thu.dow !== 'Thu') continue;

    // Find Mon of same week (search up to 4 candles back)
    let mon = null;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      if (candles[j].dow === 'Mon') {
        const daysDiff = (new Date(wed.date) - new Date(candles[j].date)) / 86400000;
        if (daysDiff <= 5) { mon = candles[j]; break; }
      }
    }
    if (!mon) continue;

    const dec = pip < 0.01 ? 5 : pip < 1 ? 3 : 1;

    if (wed.h < mon.h) {
      results.push({
        rule: 'rule2', direction: 'bearish', date: wed.date,
        refVal: mon.h, trigVal: wed.h, target: wed.l,
        resultVal: thu.l, hit: thu.l <= wed.l,
        pips: Math.round((wed.h - wed.l) / pip),
        detail: `Mon H: ${mon.h.toFixed(dec)} · Wed H: ${wed.h.toFixed(dec)} · Wed L: ${wed.l.toFixed(dec)} · Thu L: ${thu.l.toFixed(dec)}`,
      });
    }

    if (wed.l > mon.l) {
      results.push({
        rule: 'rule2b', direction: 'bullish', date: wed.date,
        refVal: mon.l, trigVal: wed.l, target: wed.h,
        resultVal: thu.h, hit: thu.h >= wed.h,
        pips: Math.round((wed.h - wed.l) / pip),
        detail: `Mon L: ${mon.l.toFixed(dec)} · Wed L: ${wed.l.toFixed(dec)} · Wed H: ${wed.h.toFixed(dec)} · Thu H: ${thu.h.toFixed(dec)}`,
      });
    }
  }
  return results;
}

function hitRate(arr) {
  if (!arr.length) return null;
  return Math.round((arr.filter(r => r.hit).length / arr.length) * 100);
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DOWPatterns() {
  const [view,      setView]      = useState('backtest');
  const [selPair,   setSelPair]   = useState('EUR_USD');
  const [lookback,  setLookback]  = useState(200);
  const [results,   setResults]   = useState(null);
  const [liveData,  setLiveData]  = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [selRule,   setSelRule]   = useState('all');

  const hasOanda = !!getCreds();

  const runBacktest = useCallback(async () => {
    if (!hasOanda) return;
    setLoading(true);
    const pair    = PAIRS.find(p => p.key === selPair);
    const candles = await fetchDaily(selPair, lookback);
    if (!candles || candles.length < 4) {
      setResults({ error: true });
      setLoading(false);
      return;
    }
    const dec = pair.pip < 0.01 ? 5 : pair.pip < 1 ? 3 : 1;
    // Reformat detail with correct decimals
    const r1  = detectRule1(candles, pair.pip).map(r => ({
      ...r,
      detail: r.rule === 'rule1'
        ? `Thu H: ${r.refVal.toFixed(dec)} · Fri H: ${r.trigVal.toFixed(dec)} · Fri L: ${r.target.toFixed(dec)} · Mon L: ${r.resultVal.toFixed(dec)}`
        : `Thu L: ${r.refVal.toFixed(dec)} · Fri L: ${r.trigVal.toFixed(dec)} · Fri H: ${r.target.toFixed(dec)} · Mon H: ${r.resultVal.toFixed(dec)}`,
    }));
    const r2  = detectRule2(candles, pair.pip);
    const gen = detectGeneral(candles, pair.pip);
    const all = [...r1, ...r2].sort((a, b) => b.date.localeCompare(a.date));

    // Stats for general patterns by day combo
    const genByCombo = {};
    gen.forEach(p => {
      if (!genByCombo[p.dayCombo]) genByCombo[p.dayCombo] = { t:0, h:0, label:p.dayCombo };
      genByCombo[p.dayCombo].t++;
      if (p.hit) genByCombo[p.dayCombo].h++;
    });

    setResults({ all, r1, r2, gen, genByCombo, pair });
    setSelRule('all');
    setLoading(false);
  }, [selPair, lookback, hasOanda]);

  const runLiveScan = useCallback(async () => {
    if (!hasOanda) return;
    setLoading(true);
    const found = [];
    for (const pair of PAIRS) {
      const candles = await fetchDaily(pair.key, 8);
      if (!candles || candles.length < 4) continue;
      const dec = pair.pip < 0.01 ? 5 : pair.pip < 1 ? 3 : 1;
      const r1 = detectRule1(candles, pair.pip);
      const r2 = detectRule2(candles, pair.pip);
      const recent = [...r1, ...r2]
        .filter(r => {
          // Only patterns from last 3 trading days (still relevant)
          const age = (Date.now() - new Date(r.date).getTime()) / 86400000;
          return age <= 4;
        });
      recent.forEach(r => {
        const rule = RULES.find(x => x.id === r.rule);
        found.push({
          pair:      pair.label,
          pairKey:   pair.key,
          rule:      r.rule,
          ruleTitle: rule?.title ?? r.rule,
          ruleDesc:  rule?.desc ?? '',
          direction: r.direction,
          date:      r.date,
          target:    r.target.toFixed(dec),
          targetRaw: r.target,
          color:     rule?.color ?? '#94a3b8',
          combo:     rule?.combo ?? '',
          hit:       r.hit,
        });
      });
    }
    // Sort: most recent first, then bull/bear
    found.sort((a, b) => b.date.localeCompare(a.date));
    setLiveData(found);
    setLoading(false);
  }, [hasOanda]);

  // Filtered rows for backtest table
  const filtered = results?.all
    ? (selRule === 'all' ? results.all : results.all.filter(r => r.rule === selRule))
    : [];

  // ── Render helpers ──────────────────────────────────────────────────────────
  const S  = (ex={}) => ({ background:'#1e293b', borderRadius:10, padding:'13px 15px', marginBottom:10, ...ex });
  const TT = txt => (
    <div style={{ fontSize:10, fontWeight:700, color:'#475569', letterSpacing:'0.08em', marginBottom:9, textTransform:'uppercase' }}>
      {txt}
    </div>
  );
  const TabBtn = ({ id, label, active, onClick }) => (
    <button onClick={onClick} style={{
      fontSize:11, fontWeight:700, padding:'5px 14px', borderRadius:7, cursor:'pointer',
      background: active ? '#00d4aa18' : '#0f172a',
      color:      active ? '#00d4aa'   : '#475569',
      border: `1px solid ${active ? '#00d4aa35' : '#1e293b'}`,
    }}>{label}</button>
  );

  const RuleCard = ({ rule, data }) => {
    const hr = hitRate(data);
    const hits = data.filter(r => r.hit).length;
    const hrColor = hr === null ? '#475569' : hr >= 65 ? '#22c55e' : hr >= 50 ? '#f59e0b' : '#ef4444';
    return (
      <div style={{ background:'#0f172a', borderRadius:9, padding:'12px 14px', border:`1px solid ${rule.color}22` }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
          <div>
            <div style={{ fontSize:12, fontWeight:800, color:rule.color }}>{rule.title}</div>
            <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>{rule.desc}</div>
            <div style={{ fontSize:10, color:'#334155', marginTop:2 }}>Combo: {rule.combo}</div>
          </div>
          <div style={{ textAlign:'center', flexShrink:0, marginLeft:12 }}>
            <div style={{ fontSize:26, fontWeight:900, color:hrColor, lineHeight:1 }}>
              {hr !== null ? `${hr}%` : '—'}
            </div>
            <div style={{ fontSize:9, color:'#475569', marginTop:2 }}>HIT RATE</div>
            <div style={{ fontSize:9, color:'#334155' }}>{hits}/{data.length}</div>
          </div>
        </div>
        {/* Bar */}
        {hr !== null && (
          <div style={{ height:4, background:'#1e293b', borderRadius:2, marginTop:6 }}>
            <div style={{ height:'100%', width:`${hr}%`, background:hrColor, borderRadius:2 }}/>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ fontFamily:'monospace', color:'#f1f5f9', padding:'12px 14px', maxWidth:720, paddingBottom:40 }}>

      {/* Header */}
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:14, fontWeight:800, color:'#f1f5f9', marginBottom:3 }}>📅 DOW Candle Patterns</div>
        <div style={{ fontSize:11, color:'#475569' }}>ICT Day-of-Week liquidity rules — backtest hit rate + live alerts</div>
      </div>

      {/* Sub-nav */}
      <div style={{ display:'flex', gap:6, marginBottom:12 }}>
        <TabBtn id="backtest" label="📊 Backtest (Past Results)"    active={view==='backtest'} onClick={() => setView('backtest')} />
        <TabBtn id="live"     label="⚡ Live Scan (Now)"            active={view==='live'}     onClick={() => setView('live')}     />
      </div>

      {!hasOanda && (
        <div style={{ ...S({ background:'#f59e0b08', border:'1px solid #f59e0b22' }), fontSize:11, color:'#f59e0b' }}>
          ⚠ Connect OANDA API key to fetch real historical daily candles
        </div>
      )}

      {/* ── Rules summary (always visible) ── */}
      <div style={S()}>
        {TT('The Two Rules')}
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <div style={{ padding:'10px 12px', background:'#0f172a', borderRadius:8, borderLeft:'3px solid #ef4444' }}>
            <div style={{ fontSize:12, fontWeight:800, color:'#f1f5f9', marginBottom:3 }}>Rule 1</div>
            <div style={{ fontSize:11, color:'#94a3b8' }}>
              If <span style={{ color:'#f1f5f9', fontWeight:700 }}>Friday high &lt; Thursday high</span>
              {' → '}Monday will visit <span style={{ color:'#ef4444', fontWeight:700 }}>Friday's LOW</span> (sell-side)
            </div>
          </div>
          <div style={{ padding:'10px 12px', background:'#0f172a', borderRadius:8, borderLeft:'3px solid #a78bfa' }}>
            <div style={{ fontSize:12, fontWeight:800, color:'#f1f5f9', marginBottom:3 }}>Rule 2</div>
            <div style={{ fontSize:11, color:'#94a3b8' }}>
              If <span style={{ color:'#f1f5f9', fontWeight:700 }}>Wednesday high &lt; Monday high</span>
              {' → '}Thursday will visit <span style={{ color:'#a78bfa', fontWeight:700 }}>Wednesday's LOW</span> (sell-side)
            </div>
          </div>
        </div>
      </div>

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
              fontSize:11, fontWeight:700, padding:'5px 16px', borderRadius:7,
              cursor: (loading || !hasOanda) ? 'not-allowed' : 'pointer',
              background: loading ? '#0f172a' : '#00d4aa18',
              color:      loading ? '#334155' : '#00d4aa',
              border:'1px solid #00d4aa30',
            }}>
              {loading ? 'Running…' : '▶ Run Backtest'}
            </button>
          </div>

          {results?.error && (
            <div style={{ ...S(), color:'#ef4444', fontSize:12 }}>
              Failed to fetch candles — check OANDA connection.
            </div>
          )}

          {/* Rule cards */}
          {results?.all && (
            <>
              <div style={S()}>
                {TT(`Results — ${results.pair.label} · ${results.all.length} total occurrences`)}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                  {RULES.map(rule => {
                    const data = results.all.filter(r => r.rule === rule.id);
                    return <RuleCard key={rule.id} rule={rule} data={data} />;
                  })}
                </div>
              </div>

              {/* General patterns by day combo */}
              {results?.genByCombo && Object.keys(results.genByCombo).length > 0 && (
                <div style={S()}>
                  {TT(`All Day Combos — Failed High/Low (${results.gen.length} total)`)}
                  <div style={{ fontSize:10, color:'#334155', marginBottom:10 }}>
                    Any day whose high/low fails to exceed the previous day → next day visits the target
                  </div>
                  {Object.entries(results.genByCombo)
                    .sort((a, b) => b[1].t - a[1].t)
                    .map(([combo, stat]) => {
                      const rate = stat.t > 0 ? Math.round((stat.h / stat.t) * 100) : 0;
                      const rc   = rate >= 65 ? '#22c55e' : rate >= 50 ? '#f59e0b' : '#ef4444';
                      return (
                        <div key={combo} style={{ marginBottom:8 }}>
                          <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:3 }}>
                            <span style={{ color:'#94a3b8' }}>{combo}</span>
                            <span style={{ color:rc, fontWeight:700 }}>{rate}% &nbsp;({stat.h}/{stat.t})</span>
                          </div>
                          <div style={{ height:4, background:'#0f172a', borderRadius:2 }}>
                            <div style={{ height:'100%', width:`${rate}%`, background:rc, borderRadius:2 }}/>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}

              {/* Occurrence log */}
              <div style={S()}>
                {TT('Occurrence Log — Rule 1 & Rule 2')}
                {/* Filter by rule */}
                <div style={{ display:'flex', gap:5, marginBottom:10, flexWrap:'wrap' }}>
                  {[['all','All'], ['rule1','Rule 1 ▼'], ['rule1b','Rule 1 ▲'], ['rule2','Rule 2 ▼'], ['rule2b','Rule 2 ▲']].map(([id, lbl]) => (
                    <button key={id} onClick={() => setSelRule(id)} style={{
                      fontSize:10, fontWeight:700, padding:'3px 10px', borderRadius:6, cursor:'pointer',
                      background: selRule===id ? '#00d4aa18' : '#0f172a',
                      color:      selRule===id ? '#00d4aa'   : '#475569',
                      border:`1px solid ${selRule===id ? '#00d4aa35' : '#1e293b'}`,
                    }}>{lbl}</button>
                  ))}
                </div>
                <div style={{ maxHeight:320, overflowY:'auto' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10 }}>
                    <thead>
                      <tr style={{ color:'#334155', position:'sticky', top:0, background:'#1e293b' }}>
                        {['','Date','Rule','Dir','Target','Result','Pips'].map((h,i) => (
                          <td key={i} style={{ padding:'5px 7px', borderBottom:'1px solid #0f172a' }}>{h}</td>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, 100).map((r, i) => {
                        const rule = RULES.find(x => x.id === r.rule);
                        return (
                          <tr key={i} style={{ background: i%2===0 ? '#0a1120' : 'transparent' }}>
                            <td style={{ padding:'5px 7px' }}>
                              <div style={{ width:7, height:7, borderRadius:'50%', background: r.hit ? '#22c55e' : '#ef4444' }}/>
                            </td>
                            <td style={{ padding:'5px 7px', color:'#64748b' }}>{r.date}</td>
                            <td style={{ padding:'5px 7px', color: rule?.color ?? '#94a3b8', fontWeight:700 }}>
                              {r.rule === 'rule1' ? 'R1 ▼' : r.rule === 'rule1b' ? 'R1 ▲' : r.rule === 'rule2' ? 'R2 ▼' : 'R2 ▲'}
                            </td>
                            <td style={{ padding:'5px 7px', color: r.direction==='bearish' ? '#ef4444' : '#22c55e', fontWeight:700 }}>
                              {r.direction==='bearish' ? '▼' : '▲'}
                            </td>
                            <td style={{ padding:'5px 7px', color:'#94a3b8' }}>
                              {r.target?.toFixed(results.pair.pip < 0.01 ? 5 : results.pair.pip < 1 ? 3 : 1)}
                            </td>
                            <td style={{ padding:'5px 7px', fontWeight:700, color: r.hit ? '#22c55e' : '#ef4444' }}>
                              {r.hit ? 'HIT' : 'MISS'}
                            </td>
                            <td style={{ padding:'5px 7px', color:'#475569' }}>{r.pips}p</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filtered.length > 100 && (
                    <div style={{ fontSize:10, color:'#334155', textAlign:'center', padding:8 }}>
                      Showing 100 of {filtered.length}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {!results && !loading && (
            <div style={{ ...S({ background:'#0f172a', border:'1px solid #1e293b', textAlign:'center' }) }}>
              <div style={{ fontSize:12, color:'#334155', padding:'24px 0 8px' }}>Select pair + lookback and run the backtest</div>
              <div style={{ fontSize:10, color:'#1e293b', paddingBottom:20 }}>
                Tests Rule 1 (Thu/Fri/Mon) and Rule 2 (Mon/Wed/Thu) on real daily candles
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
              Scans all pairs for Rule 1 and Rule 2 active right now
            </div>
            <button onClick={runLiveScan} disabled={loading || !hasOanda} style={{
              fontSize:11, fontWeight:700, padding:'5px 16px', borderRadius:7,
              cursor: (loading || !hasOanda) ? 'not-allowed' : 'pointer',
              background: loading ? '#0f172a' : '#00d4aa18',
              color:      loading ? '#334155' : '#00d4aa',
              border:'1px solid #00d4aa30',
            }}>
              {loading ? 'Scanning…' : '⚡ Scan Now'}
            </button>
          </div>

          {liveData !== null && (
            liveData.length > 0 ? (
              <div style={S()}>
                {TT(`Active Patterns — ${liveData.length} found`)}
                {liveData.map((p, i) => (
                  <div key={i} style={{
                    padding:'11px 13px', borderRadius:9, marginBottom:8,
                    background: p.direction==='bearish' ? '#ef444410' : '#22c55e10',
                    border:`1px solid ${p.direction==='bearish' ? '#ef444428' : '#22c55e28'}`,
                  }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                      <span style={{ fontSize:15, fontWeight:900, color:'#f1f5f9' }}>{p.pair}</span>
                      <span style={{ fontSize:10, color:'#475569' }}>{p.date}</span>
                    </div>
                    <div style={{ fontSize:12, fontWeight:700, color:p.color, marginBottom:4 }}>{p.ruleTitle}</div>
                    <div style={{ fontSize:11, color:'#94a3b8', marginBottom:6 }}>{p.ruleDesc}</div>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <div style={{ fontSize:10, color:'#64748b' }}>Combo: <span style={{ color:'#94a3b8' }}>{p.combo}</span></div>
                      <div style={{ marginLeft:'auto', fontSize:13, fontWeight:800, color: p.direction==='bearish'?'#fca5a5':'#86efac' }}>
                        Target: {p.target}
                      </div>
                      {p.hit !== undefined && (
                        <div style={{ fontSize:11, fontWeight:700, color: p.hit ? '#22c55e' : '#ef4444' }}>
                          {p.hit ? '✓ HIT' : '✗ MISS'}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ ...S({ background:'#0f172a', border:'1px solid #1e293b', textAlign:'center' }) }}>
                <div style={{ fontSize:12, color:'#334155', padding:'20px 0' }}>
                  No Rule 1 or Rule 2 patterns active right now
                </div>
              </div>
            )
          )}

          {!liveData && !loading && (
            <div style={{ ...S({ background:'#0f172a', border:'1px solid #1e293b', textAlign:'center' }) }}>
              <div style={{ fontSize:12, color:'#334155', padding:'24px 0' }}>Click Scan Now to check all pairs</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

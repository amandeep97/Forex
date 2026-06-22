'use strict';
import { useState, useEffect, useCallback } from 'react';

const ALL_PAIRS = [
  // Forex Majors
  { key:'EUR_USD', label:'EUR/USD', group:'Forex',   pip:0.0001, cot:['EUR','USD'] },
  { key:'GBP_USD', label:'GBP/USD', group:'Forex',   pip:0.0001, cot:['GBP','USD'] },
  { key:'USD_JPY', label:'USD/JPY', group:'Forex',   pip:0.01,   cot:['USD','JPY'] },
  { key:'USD_CHF', label:'USD/CHF', group:'Forex',   pip:0.0001, cot:['USD','CHF'] },
  { key:'AUD_USD', label:'AUD/USD', group:'Forex',   pip:0.0001, cot:['AUD','USD'] },
  { key:'USD_CAD', label:'USD/CAD', group:'Forex',   pip:0.0001, cot:['USD','CAD'] },
  { key:'NZD_USD', label:'NZD/USD', group:'Forex',   pip:0.0001, cot:['NZD','USD'] },
  { key:'GBP_JPY', label:'GBP/JPY', group:'Forex',   pip:0.01,   cot:['GBP','JPY'] },
  { key:'EUR_JPY', label:'EUR/JPY', group:'Forex',   pip:0.01,   cot:['EUR','JPY'] },
  { key:'EUR_GBP', label:'EUR/GBP', group:'Forex',   pip:0.0001, cot:['EUR','GBP'] },
  { key:'AUD_JPY', label:'AUD/JPY', group:'Forex',   pip:0.01,   cot:['AUD','JPY'] },
  { key:'CAD_JPY', label:'CAD/JPY', group:'Forex',   pip:0.01,   cot:['CAD','JPY'] },
  // Metals
  { key:'XAU_USD', label:'XAU/USD', group:'Metals',  pip:0.01,   cot:['XAU','USD'] },
  { key:'XAG_USD', label:'XAG/USD', group:'Metals',  pip:0.001,  cot:['XAG','USD'] },
  // Indices
  { key:'US30_USD',   label:'US30',   group:'Indices', pip:1, cot:[] },
  { key:'NAS100_USD', label:'NAS100', group:'Indices', pip:1, cot:[] },
  { key:'SPX500_USD', label:'SPX500', group:'Indices', pip:1, cot:[] },
  { key:'DE30_EUR',   label:'GER40',  group:'Indices', pip:1, cot:[] },
  { key:'JP225_USD',  label:'JPN225', group:'Indices', pip:1, cot:[] },
  { key:'UK100_GBP',  label:'UK100',  group:'Indices', pip:1, cot:[] },
];

const GROUP_COLORS = { Forex:'#8b5cf6', Metals:'#f59e0b', Indices:'#22c55e' };

function getCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) return c;
    const k = localStorage.getItem('oanda_key');
    if (k) return { apiKey: k, practice: localStorage.getItem('oanda_env') !== 'live' };
  } catch {}
  return null;
}

async function fetchPrice(pairKey) {
  const creds = getCreds();
  if (!creds) return null;
  const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
  try {
    const r = await fetch(
      `${base}/instruments/${pairKey}/candles?granularity=H1&count=25&price=M`,
      { headers:{ Authorization:`Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const candles = (d.candles||[]).filter(c=>c.complete).map(c=>+c.mid.c);
    if (!candles.length) return null;
    const last = candles[candles.length-1];
    const prev = candles[candles.length-6] || candles[0];
    const change = ((last - prev) / prev * 100);
    const high = Math.max(...candles), low = Math.min(...candles);
    const pct = high > low ? ((last - low)/(high-low)*100) : 50;
    const trend = last > candles[candles.length-4] ? 'up' : 'down';
    return { price:last, change, pct, trend, candles };
  } catch { return null; }
}

function getAlphaStats(pairKey) {
  try {
    const store = JSON.parse(localStorage.getItem('alpha_lab_v2')||'{}');
    const log = (store.sweepLog||[]).filter(s=>s.pair===pairKey);
    const resolved = log.filter(s=>s.outcome!=='pending');
    const confirmed = resolved.filter(s=>s.outcome==='confirmed');
    const pending = log.filter(s=>s.outcome==='pending');
    const wr = resolved.length ? Math.round(confirmed.length/resolved.length*100) : null;
    const bullLog = resolved.filter(s=>s.expectedDir==='bullish');
    const bearLog = resolved.filter(s=>s.expectedDir==='bearish');
    const bullWR = bullLog.length>=3 ? Math.round(bullLog.filter(s=>s.outcome==='confirmed').length/bullLog.length*100) : null;
    const bearWR = bearLog.length>=3 ? Math.round(bearLog.filter(s=>s.outcome==='confirmed').length/bearLog.length*100) : null;
    const recent = log.slice(0,5);
    return { total:log.length, resolved:resolved.length, wr, bullWR, bearWR, pending:pending.length, recent };
  } catch { return null; }
}

function getNewsForPair(pair) {
  try {
    const cache = JSON.parse(localStorage.getItem('forex_news_cache')||'null');
    if (!cache?.items) return [];
    const kws = pair.label.replace('/','').toLowerCase().split('');
    const base1 = pair.label.split('/')[0].toLowerCase();
    const base2 = pair.label.split('/')[1]?.toLowerCase();
    return cache.items.filter(item => {
      const t = item.title.toLowerCase();
      return t.includes(base1) || (base2 && t.includes(base2));
    }).slice(0,4);
  } catch { return []; }
}

function MiniSparkline({ candles }) {
  if (!candles || candles.length < 2) return null;
  const min = Math.min(...candles), max = Math.max(...candles);
  const range = max - min || 1;
  const w = 80, h = 30;
  const pts = candles.map((v,i) => {
    const x = (i/(candles.length-1))*w;
    const y = h - ((v-min)/range)*h;
    return `${x},${y}`;
  }).join(' ');
  const last = candles[candles.length-1];
  const first = candles[0];
  const col = last >= first ? '#00d4aa' : '#ef4444';
  return (
    <svg width={w} height={h} style={{ overflow:'visible' }}>
      <polyline points={pts} fill="none" stroke={col} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  );
}

function StatBox({ label, value, color='#f1f5f9', sub }) {
  return (
    <div style={{ background:'#06090f', borderRadius:10, padding:'10px 12px', border:'1px solid #0f1929', textAlign:'center' }}>
      <div style={{ fontSize:9, color:'#475569', fontWeight:700, letterSpacing:'0.08em', marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:18, fontWeight:900, color }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize:9, color:'#334155', marginTop:2 }}>{sub}</div>}
    </div>
  );
}

export default function PairHub() {
  const [group,     setGroup]     = useState('All');
  const [search,    setSearch]    = useState('');
  const [selected,  setSelected]  = useState(null);
  const [priceData, setPriceData] = useState(null);
  const [loading,   setLoading]   = useState(false);

  const groups = ['All','Forex','Metals','Indices'];
  const filtered = ALL_PAIRS.filter(p =>
    (group==='All' || p.group===group) &&
    (!search || p.label.toLowerCase().includes(search.toLowerCase()))
  );

  const selectPair = useCallback(async (pair) => {
    setSelected(pair);
    setLoading(true);
    setPriceData(null);
    const data = await fetchPrice(pair.key);
    setPriceData(data);
    setLoading(false);
  }, []);

  const alphaStats = selected ? getAlphaStats(selected.key) : null;
  const pairNews   = selected ? getNewsForPair(selected) : [];

  const priceFmt = (p, pair) => {
    if (!p) return '—';
    const dec = pair.pip < 0.001 ? 2 : pair.pip < 0.01 ? 3 : pair.pip === 0.01 ? 5 : 5;
    return p.toFixed(dec);
  };

  return (
    <div style={{ background:'#04070f', minHeight:'100vh', padding:'14px 12px', paddingBottom:80 }}>

      {/* ── Header ── */}
      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:16, fontWeight:900, color:'#f1f5f9', letterSpacing:'0.06em', marginBottom:2 }}>
          💱 PAIR HUB
        </div>
        <div style={{ fontSize:10, color:'#334155' }}>Select any pair to see full analysis — price, Alpha Lab, news, AI</div>
      </div>

      {/* ── Search + group filter ── */}
      <div style={{ display:'flex', gap:8, marginBottom:12, alignItems:'center' }}>
        <input
          value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search pair…"
          style={{ flex:1, background:'#06090f', border:'1px solid #0f1929', borderRadius:10,
            color:'#f1f5f9', fontSize:12, padding:'8px 12px', outline:'none' }}
        />
        <div style={{ display:'flex', gap:4 }}>
          {groups.map(g => {
            const c = GROUP_COLORS[g] || '#475569';
            const active = group===g;
            return (
              <button key={g} onClick={()=>setGroup(g)} style={{
                padding:'6px 10px', borderRadius:10, fontSize:10, fontWeight:800, cursor:'pointer',
                border:`1px solid ${active ? c+'55':'#0f1929'}`,
                background:active?`${c}18`:'transparent', color:active?c:'#334155',
              }}>{g}</button>
            );
          })}
        </div>
      </div>

      {/* ── Pair grid ── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:6, marginBottom:16 }}>
        {filtered.map(p => {
          const active = selected?.key === p.key;
          const gc = GROUP_COLORS[p.group];
          const stats = getAlphaStats(p.key);
          return (
            <button key={p.key} onClick={()=>selectPair(p)} style={{
              padding:'8px 4px', borderRadius:10, cursor:'pointer', textAlign:'center',
              border:`1px solid ${active ? gc+'55':'#0f1929'}`,
              background:active?`${gc}18`:'#06090f',
              transition:'all 0.15s',
            }}>
              <div style={{ fontSize:10, fontWeight:800, color:active?gc:'#94a3b8' }}>{p.label}</div>
              {stats?.wr != null && (
                <div style={{ fontSize:8, color:stats.wr>=60?'#00d4aa':stats.wr>=45?'#f59e0b':'#ef4444', marginTop:2, fontWeight:700 }}>
                  {stats.wr}% WR
                </div>
              )}
              {stats?.pending > 0 && (
                <div style={{ fontSize:7, color:'#ef4444', fontWeight:700 }}>● LIVE</div>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Pair detail ── */}
      {selected && (
        <div>
          {/* Price header */}
          <div style={{ background:'#06090f', borderRadius:14, padding:'14px', border:'1px solid #0f1929', marginBottom:12 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <div>
                <div style={{ fontSize:14, fontWeight:900, color:'#f1f5f9', letterSpacing:'0.06em' }}>{selected.label}</div>
                <div style={{ fontSize:9, color:GROUP_COLORS[selected.group], fontWeight:700, marginTop:2 }}>{selected.group}</div>
              </div>
              <div style={{ textAlign:'right' }}>
                {loading && <div style={{ fontSize:11, color:'#334155' }}>Loading…</div>}
                {priceData && (
                  <>
                    <div style={{ fontSize:20, fontWeight:900, color:'#f1f5f9' }}>
                      {priceFmt(priceData.price, selected)}
                    </div>
                    <div style={{ fontSize:11, fontWeight:700, color:priceData.change>=0?'#00d4aa':'#ef4444' }}>
                      {priceData.change>=0?'+':''}{priceData.change.toFixed(3)}% (5H)
                    </div>
                  </>
                )}
                {!loading && !priceData && (
                  <div style={{ fontSize:10, color:'#334155' }}>Connect OANDA for price</div>
                )}
              </div>
            </div>
            {priceData && (
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:10 }}>
                <MiniSparkline candles={priceData.candles}/>
                <div style={{ fontSize:10, color:'#334155' }}>
                  Trend: <span style={{ color:priceData.trend==='up'?'#00d4aa':'#ef4444', fontWeight:700 }}>
                    {priceData.trend==='up'?'↑ Bullish':'↓ Bearish'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Alpha Lab stats */}
          {alphaStats && alphaStats.total > 0 && (
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:9, color:'#475569', fontWeight:700, letterSpacing:'0.08em', marginBottom:8 }}>⚗ ALPHA LAB — {selected.label}</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6, marginBottom:10 }}>
                <StatBox label="SWEEPS" value={alphaStats.total}/>
                <StatBox label="WIN RATE" value={alphaStats.wr!=null?`${alphaStats.wr}%`:null}
                  color={alphaStats.wr>=60?'#00d4aa':alphaStats.wr>=45?'#f59e0b':'#ef4444'}/>
                <StatBox label="▲ LONG WR" value={alphaStats.bullWR!=null?`${alphaStats.bullWR}%`:null}
                  color={alphaStats.bullWR>=60?'#00d4aa':alphaStats.bullWR>=45?'#f59e0b':'#ef4444'}/>
                <StatBox label="▼ SHORT WR" value={alphaStats.bearWR!=null?`${alphaStats.bearWR}%`:null}
                  color={alphaStats.bearWR>=60?'#00d4aa':alphaStats.bearWR>=45?'#f59e0b':'#ef4444'}/>
              </div>
              {alphaStats.pending > 0 && (
                <div style={{ background:'#ef444410', border:'1px solid #ef444433', borderRadius:10,
                  padding:'8px 12px', fontSize:11, fontWeight:700, color:'#ef4444', marginBottom:8 }}>
                  ⚡ {alphaStats.pending} LIVE sweep{alphaStats.pending>1?'s':''} active on {selected.label} right now
                </div>
              )}
              {alphaStats.recent.length > 0 && (
                <div style={{ background:'#06090f', borderRadius:10, border:'1px solid #0f1929', overflow:'hidden' }}>
                  <div style={{ fontSize:9, color:'#334155', fontWeight:700, padding:'8px 12px', borderBottom:'1px solid #0f1929', letterSpacing:'0.08em' }}>RECENT SWEEPS</div>
                  {alphaStats.recent.map((s,i) => (
                    <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px',
                      borderBottom:i<alphaStats.recent.length-1?'1px solid #060810':undefined }}>
                      <span style={{ fontSize:10, color:s.expectedDir==='bullish'?'#00d4aa':'#ef4444', fontWeight:700 }}>
                        {s.expectedDir==='bullish'?'▲':'▼'}
                      </span>
                      <span style={{ fontSize:9, color:'#475569', flex:1 }}>
                        {new Date(s.time).toLocaleDateString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
                      </span>
                      <span style={{ fontSize:9, color:'#475569' }}>{s.tf}</span>
                      <span style={{ fontSize:10, fontWeight:700,
                        color:s.outcome==='confirmed'?'#00d4aa':s.outcome==='failed'?'#ef4444':'#f59e0b' }}>
                        {s.outcome==='confirmed'?`✓ +${s.pipsMoved}p`:s.outcome==='failed'?'✗ FAIL':'⏳'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {alphaStats && alphaStats.total === 0 && (
            <div style={{ background:'#06090f', borderRadius:10, border:'1px solid #0f1929',
              padding:'16px', textAlign:'center', fontSize:11, color:'#334155', marginBottom:12 }}>
              No Alpha Lab data for {selected.label} yet — run a backfill in Alpha Lab
            </div>
          )}

          {/* News */}
          {pairNews.length > 0 && (
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:9, color:'#475569', fontWeight:700, letterSpacing:'0.08em', marginBottom:8 }}>📰 LATEST NEWS — {selected.label}</div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {pairNews.map((n,i) => (
                  <div key={i} style={{ background:'#06090f', borderRadius:10, border:'1px solid #0f1929', padding:'10px 12px' }}>
                    <div style={{ fontSize:11, fontWeight:600, color:'#e2e8f0', lineHeight:1.4, marginBottom:4 }}>{n.title}</div>
                    <div style={{ fontSize:9, color:'#334155' }}>{n.source} {n.age!=null?`· ${n.age}m ago`:''}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI quick ask */}
          <button
            onClick={() => {
              try {
                localStorage.setItem('ai_prefill', `Analyze ${selected.label} right now using all available data — Alpha Lab sweep win rate, COT positioning, current price momentum, and any relevant news. Give me a clear bias (long/short/wait) with reasoning and trade setup if applicable.`);
              } catch {}
              // Navigate to AI tab by dispatching a custom event
              window.dispatchEvent(new CustomEvent('navigate-tab', { detail:'ai' }));
            }}
            style={{ width:'100%', padding:'13px', borderRadius:12, border:'1px solid #8b5cf644',
              background:'#8b5cf612', color:'#8b5cf6', fontSize:13, fontWeight:700, cursor:'pointer' }}>
            🤖 Ask AI about {selected.label}
          </button>
        </div>
      )}

      {!selected && (
        <div style={{ textAlign:'center', padding:'40px 20px', color:'#1e293b', fontSize:13 }}>
          Tap any pair above to see its full analysis
        </div>
      )}
    </div>
  );
}

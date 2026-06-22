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

// Best session hours (UTC) for each pair group
const PAIR_SESSIONS = {
  EUR_USD:{ name:'London/NY', utcFrom:8,  utcTo:17 },
  GBP_USD:{ name:'London/NY', utcFrom:8,  utcTo:17 },
  USD_JPY:{ name:'Tokyo/London', utcFrom:0, utcTo:12 },
  USD_CHF:{ name:'London/NY', utcFrom:8,  utcTo:17 },
  AUD_USD:{ name:'Sydney/Tokyo', utcFrom:22, utcTo:9 },
  USD_CAD:{ name:'NY',        utcFrom:13, utcTo:22 },
  NZD_USD:{ name:'Sydney/Tokyo', utcFrom:22, utcTo:9 },
  GBP_JPY:{ name:'London',   utcFrom:8,  utcTo:13 },
  EUR_JPY:{ name:'London',   utcFrom:8,  utcTo:13 },
  EUR_GBP:{ name:'London',   utcFrom:8,  utcTo:17 },
  AUD_JPY:{ name:'Tokyo',    utcFrom:0,  utcTo:9  },
  CAD_JPY:{ name:'London/NY',utcFrom:8,  utcTo:17 },
  XAU_USD:{ name:'London/NY',utcFrom:8,  utcTo:17 },
  XAG_USD:{ name:'London/NY',utcFrom:8,  utcTo:17 },
  US30_USD:{ name:'NY',      utcFrom:13, utcTo:21 },
  NAS100_USD:{ name:'NY',    utcFrom:13, utcTo:21 },
  SPX500_USD:{ name:'NY',    utcFrom:13, utcTo:21 },
  DE30_EUR:{ name:'London',  utcFrom:7,  utcTo:16 },
  JP225_USD:{ name:'Tokyo',  utcFrom:0,  utcTo:9  },
  UK100_GBP:{ name:'London', utcFrom:8,  utcTo:16 },
};

function isInSession(pairKey) {
  const s = PAIR_SESSIONS[pairKey];
  if (!s) return false;
  const h = new Date().getUTCHours();
  if (s.utcFrom < s.utcTo) return h >= s.utcFrom && h < s.utcTo;
  return h >= s.utcFrom || h < s.utcTo;
}

function dowFactor() {
  const d = new Date().getDay(); // 0=Sun,1=Mon,...,6=Sat
  return d === 2 || d === 3 ? 20  // Tue/Wed — highest probability
       : d === 1 || d === 4 ? 12  // Mon/Thu — good
       : d === 5             ?  5  // Fri — low, often trap
       : 0;                        // Weekend
}

function scorePairToday(pair) {
  let score = 0;
  const breakdown = [];
  let direction = null;
  let dirReason = '';
  let levels = null;

  try {
    const store = JSON.parse(localStorage.getItem('alpha_lab_v2')||'{}');
    const log = (store.sweepLog||[]).filter(s=>s.pair===pair.key);
    const resolved = log.filter(s=>s.outcome!=='pending');
    const confirmed = resolved.filter(s=>s.outcome==='confirmed');
    const pending = log.filter(s=>s.outcome==='pending');
    const wr = resolved.length >= 5 ? Math.round(confirmed.length/resolved.length*100) : null;

    const bullLog = resolved.filter(s=>s.expectedDir==='bullish');
    const bearLog = resolved.filter(s=>s.expectedDir==='bearish');
    const bullWR = bullLog.length>=5 ? Math.round(bullLog.filter(s=>s.outcome==='confirmed').length/bullLog.length*100) : null;
    const bearWR = bearLog.length>=5 ? Math.round(bearLog.filter(s=>s.outcome==='confirmed').length/bearLog.length*100) : null;

    // ── Direction logic ──
    // 1. Live sweep wins — use its expected direction
    if (pending.length > 0) {
      const liveSweep = pending[0];
      direction = liveSweep.expectedDir === 'bullish' ? 'long' : 'short';
      dirReason = `Live sweep expects ${direction.toUpperCase()}`;
      score += 30;
      breakdown.push(`Live sweep (+30)`);
    }

    // 2. Recent sweep in last 48h
    if (!direction) {
      const recent = log.find(s => s.outcome !== 'pending' &&
        Date.now() - new Date(s.time).getTime() < 48 * 3600 * 1000);
      if (recent) {
        direction = recent.expectedDir === 'bullish' ? 'long' : 'short';
        dirReason = `Recent ${recent.outcome === 'confirmed' ? '✓' : ''} sweep was ${direction.toUpperCase()}`;
      }
    }

    // 3. Best historical direction WR
    if (!direction && (bullWR != null || bearWR != null)) {
      if (bullWR != null && (bearWR == null || bullWR >= bearWR)) {
        direction = 'long'; dirReason = `Long WR ${bullWR}% > Short WR ${bearWR??'N/A'}%`;
      } else {
        direction = 'short'; dirReason = `Short WR ${bearWR}% > Long WR ${bullWR??'N/A'}%`;
      }
    }

    // 1. Historical WR (0-30 pts)
    if (wr != null) {
      const wrPts = wr >= 65 ? 30 : wr >= 55 ? 20 : wr >= 45 ? 10 : 0;
      if (wrPts) { score += wrPts; breakdown.push(`WR ${wr}% (+${wrPts})`); }
    }

    // 3. Today's DOW WR
    const today = new Date().getDay();
    const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const todayLabel = dowNames[today];
    const todayLog = resolved.filter(s => {
      const d = s.dow ?? dowNames[new Date(s.time).getDay()];
      return d === todayLabel;
    });
    if (todayLog.length >= 5) {
      const todayWins = todayLog.filter(s=>s.outcome==='confirmed').length;
      const todayWR = Math.round(todayWins/todayLog.length*100);
      const pts = todayWR >= 65 ? 20 : todayWR >= 55 ? 12 : 0;
      if (pts) { score += pts; breakdown.push(`${todayLabel} WR ${todayWR}% (+${pts})`); }

      // refine direction from today's data
      if (direction) {
        const todayDir = todayLog.filter(s=>s.expectedDir===(direction==='long'?'bullish':'bearish'));
        const todayDirWins = todayDir.filter(s=>s.outcome==='confirmed').length;
        const todayDirWR = todayDir.length >= 3 ? Math.round(todayDirWins/todayDir.length*100) : null;
        if (todayDirWR != null) dirReason += ` · ${todayLabel} ${todayDirWR}% WR`;
      }
    }

    // 4. Session timing (0-15 pts)
    if (isInSession(pair.key)) {
      score += 15;
      breakdown.push(`Peak session (+15)`);
    }

    // 5. Day of week base (0-20 pts)
    const dfPts = dowFactor();
    if (dfPts) { score += dfPts; breakdown.push(`${todayLabel} factor (+${dfPts})`); }

    // 6. Recent streak (0-10 pts)
    const last3 = resolved.slice(0,3);
    if (last3.length === 3 && last3.every(s=>s.outcome==='confirmed')) {
      score += 10; breakdown.push('Hot streak (+10)');
    }

    // 7. HTF aligned (0-5 pts)
    const latestSweep = log.find(s=>s.htfAligned!=null);
    if (latestSweep?.htfAligned) {
      score += 5; breakdown.push('HTF aligned (+5)');
    }

    // Directional WR bonus — if direction strongly confirmed
    const dirWR = direction === 'long' ? bullWR : bearWR;
    if (dirWR != null && dirWR >= 65 && pending.length === 0) {
      score += 10; breakdown.push(`Dir WR ${dirWR}% (+10)`);
    }

    // ── Trade levels from sweep ──
    const sourceSweep = pending[0] || log.find(s =>
      s.outcome !== 'pending' &&
      Date.now() - new Date(s.time).getTime() < 48 * 3600 * 1000
    );
    if (sourceSweep && sourceSweep.level && sourceSweep.entryPrice) {
      const pip = sourceSweep.pip || pair.pip;
      const isLong = (sourceSweep.expectedDir === 'bullish');
      const entry = sourceSweep.entryPrice;
      const buffer = pip * 5;                              // 5 pip buffer beyond swept level
      const sl = isLong ? sourceSweep.level - buffer      // below swept low
                        : sourceSweep.level + buffer;     // above swept high
      const risk = Math.abs(entry - sl);
      const tp1  = isLong ? entry + risk * 2 : entry - risk * 2;   // 1:2 R:R
      const tp2  = isLong ? entry + risk * 3 : entry - risk * 3;   // 1:3 R:R
      const riskPips = Math.round(risk / pip);
      const dec = pip < 0.001 ? 2 : pip < 0.01 ? 3 : pip === 0.01 ? 3 : 5;
      levels = {
        entry:    entry.toFixed(dec),
        sl:       sl.toFixed(dec),
        tp1:      tp1.toFixed(dec),
        tp2:      tp2.toFixed(dec),
        riskPips,
        tp1Pips:  riskPips * 2,
        tp2Pips:  riskPips * 3,
        isLive:   sourceSweep.outcome === 'pending',
      };
    }

  } catch {}

  return { score: Math.min(score, 100), breakdown, direction, dirReason, levels };
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

const DOW_LABEL  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];
const DOW_COLOR  = [0,6].includes(new Date().getDay()) ? '#334155'
  : [2,3].includes(new Date().getDay()) ? '#00d4aa'
  : new Date().getDay() === 5 ? '#ef4444' : '#f59e0b';

export default function PairHub() {
  const [group,     setGroup]     = useState('All');
  const [search,    setSearch]    = useState('');
  const [selected,  setSelected]  = useState(null);
  const [priceData, setPriceData] = useState(null);
  const [loading,   setLoading]   = useState(false);

  const todayRanking = ALL_PAIRS.map(p => ({ pair:p, ...scorePairToday(p) }))
    .filter(r => r.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, 5);

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

      {/* ── Today's Best ── */}
      <div style={{ background:'#06090f', borderRadius:14, border:'1px solid #0f1929', marginBottom:14, overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid #0f1929', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ fontSize:11, fontWeight:800, color:'#f1f5f9', letterSpacing:'0.06em' }}>
            🎯 TODAY'S HIGH PROBABILITY PAIRS
          </div>
          <div style={{ fontSize:10, fontWeight:700, color:DOW_COLOR, background:DOW_COLOR+'18',
            padding:'2px 8px', borderRadius:8, border:`1px solid ${DOW_COLOR}33` }}>
            {DOW_LABEL} {[2,3].includes(new Date().getDay())?'✓ Best day':[5].includes(new Date().getDay())?'⚠ Caution':''}
          </div>
        </div>

        {todayRanking.length === 0 ? (
          <div style={{ padding:'24px', textAlign:'center', fontSize:11, color:'#334155' }}>
            Run backfill in Alpha Lab to generate scores
          </div>
        ) : todayRanking.map((r, i) => {
          const gc = GROUP_COLORS[r.pair.group];
          const scoreColor = r.score >= 70 ? '#00d4aa' : r.score >= 45 ? '#f59e0b' : '#ef4444';
          const stats = getAlphaStats(r.pair.key);
          const live = stats?.pending > 0;
          const dirColor = r.direction === 'long' ? '#00d4aa' : r.direction === 'short' ? '#ef4444' : '#475569';
          const dirLabel = r.direction === 'long' ? '▲ LONG' : r.direction === 'short' ? '▼ SHORT' : '— WAIT';
          return (
            <div key={r.pair.key} onClick={()=>selectPair(r.pair)}
              style={{ padding:'12px 14px', borderBottom: i<todayRanking.length-1?'1px solid #0a0e1a':undefined,
                cursor:'pointer', background: selected?.key===r.pair.key ? '#0f172a' : 'transparent' }}>
              {/* Top row */}
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                <div style={{ fontSize:11, fontWeight:900, color:'#1e293b', width:14, flexShrink:0 }}>{i+1}</div>
                <span style={{ fontSize:13, fontWeight:900, color:gc }}>{r.pair.label}</span>
                {live && <span style={{ fontSize:8, fontWeight:800, color:'#ef4444', background:'#ef444418',
                  padding:'1px 6px', borderRadius:6, border:'1px solid #ef444433', animation:'none' }}>⚡ LIVE NOW</span>}
                {/* Direction badge — most prominent element */}
                <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:8 }}>
                  <div style={{ background:`${dirColor}20`, border:`1px solid ${dirColor}55`,
                    borderRadius:8, padding:'4px 10px', textAlign:'center' }}>
                    <div style={{ fontSize:13, fontWeight:900, color:dirColor, letterSpacing:'0.05em' }}>{dirLabel}</div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:17, fontWeight:900, color:scoreColor, lineHeight:1 }}>{r.score}</div>
                    <div style={{ fontSize:8, color:'#334155' }}>score</div>
                  </div>
                </div>
              </div>
              {/* Dir reason */}
              {r.dirReason && (
                <div style={{ fontSize:9, color:dirColor, fontWeight:600, marginBottom:6, paddingLeft:22 }}>{r.dirReason}</div>
              )}

              {/* Trade levels */}
              {r.levels && (
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:5, paddingLeft:22, marginBottom:6 }}>
                  {[
                    { label:'ENTRY',   value:r.levels.entry,  color:'#f1f5f9',  sub: r.levels.isLive ? 'Live price' : 'Sweep close' },
                    { label:'SL',      value:r.levels.sl,     color:'#ef4444',  sub: `${r.levels.riskPips}p risk` },
                    { label:'TP1 1:2', value:r.levels.tp1,    color:'#00d4aa',  sub: `+${r.levels.tp1Pips}p` },
                    { label:'TP2 1:3', value:r.levels.tp2,    color:'#f59e0b',  sub: `+${r.levels.tp2Pips}p` },
                  ].map(lv => (
                    <div key={lv.label} style={{ background:'#0a0e1a', borderRadius:8,
                      padding:'6px 8px', border:`1px solid ${lv.color}22`, textAlign:'center' }}>
                      <div style={{ fontSize:7, color:'#334155', fontWeight:700, letterSpacing:'0.06em', marginBottom:2 }}>{lv.label}</div>
                      <div style={{ fontSize:10, fontWeight:900, color:lv.color }}>{lv.value}</div>
                      <div style={{ fontSize:7, color:'#1e293b', marginTop:1 }}>{lv.sub}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Breakdown chips */}
              <div style={{ display:'flex', gap:4, flexWrap:'wrap', paddingLeft:22 }}>
                {r.breakdown.map((b,j) => (
                  <span key={j} style={{ fontSize:8, color:'#334155', background:'#0a0e1a',
                    padding:'1px 5px', borderRadius:4, border:'1px solid #0f1929' }}>{b}</span>
                ))}
              </div>
              {/* Score bar */}
              <div style={{ height:3, background:'#0a0e1a', borderRadius:2, marginTop:8 }}>
                <div style={{ width:`${r.score}%`, height:'100%', background:scoreColor, borderRadius:2 }}/>
              </div>
            </div>
          );
        })}
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

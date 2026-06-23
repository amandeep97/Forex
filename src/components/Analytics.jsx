'use strict';
import { useState, useMemo } from 'react';

const JOURNAL_KEY = 'forex_manual_trades_v1';
const ALPHA_KEY   = 'alpha_lab_v2';

function loadJournal() {
  try { return JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]'); } catch { return []; }
}
function loadAlpha() {
  try {
    const store = JSON.parse(localStorage.getItem(ALPHA_KEY) || '{}');
    return (store.sweepLog || []).filter(s => s.outcome !== 'pending');
  } catch { return []; }
}

// ── SVG helpers ────────────────────────────────────────────────────────────────
function EquityCurve({ points, W=340, H=100 }) {
  if (!points || points.length < 2) return (
    <div style={{ height:H, display:'flex', alignItems:'center', justifyContent:'center', color:'#334155', fontSize:11 }}>
      Not enough trade data yet
    </div>
  );
  const minV = Math.min(...points), maxV = Math.max(...points);
  const range = maxV - minV || 1;
  const toX = i => (i / (points.length - 1)) * W;
  const toY = v => H - 8 - ((v - minV) / range) * (H - 16);
  const pathD = points.map((v, i) => `${i===0?'M':'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const lastY = toY(points[points.length - 1]);
  const col = points[points.length - 1] >= points[0] ? '#22c55e' : '#ef4444';
  const fillD = `${pathD} L${W},${H} L0,${H} Z`;
  const zero = toY(0);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display:'block', borderRadius:4 }}>
      <defs>
        <linearGradient id="ecGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.25"/>
          <stop offset="100%" stopColor={col} stopOpacity="0.02"/>
        </linearGradient>
        <clipPath id="ecClip"><rect x={0} y={0} width={W} height={H}/></clipPath>
      </defs>
      <rect width={W} height={H} fill="#060a14" rx={4}/>
      {/* Zero line */}
      {zero > 0 && zero < H && (
        <line x1={0} y1={zero} x2={W} y2={zero} stroke="#1e293b" strokeWidth={1} strokeDasharray="4,3"/>
      )}
      <path d={fillD} fill="url(#ecGrad)" clipPath="url(#ecClip)"/>
      <path d={pathD} fill="none" stroke={col} strokeWidth={2} strokeLinejoin="round"/>
      <circle cx={toX(points.length-1)} cy={lastY} r={4} fill={col}/>
      {/* Min/Max labels */}
      <text x={4} y={10} fontSize={8} fill="#475569" fontFamily="monospace">{maxV >= 0 ? '+' : ''}{maxV.toFixed(1)}</text>
      <text x={4} y={H-3} fontSize={8} fill="#475569" fontFamily="monospace">{minV >= 0 ? '+' : ''}{minV.toFixed(1)}</text>
    </svg>
  );
}

function HBar({ label, wins, total, color='#22c55e' }) {
  if (!total) return null;
  const pct = Math.round((wins / total) * 100);
  const barW = pct;
  const dimC = pct >= 60 ? '#22c55e' : pct >= 45 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
      <div style={{ width:64, fontSize:9, color:'#94a3b8', textAlign:'right', flexShrink:0, fontFamily:'monospace' }}>{label}</div>
      <div style={{ flex:1, height:12, background:'#0a0e1a', borderRadius:2, overflow:'hidden' }}>
        <div style={{ width:`${barW}%`, height:'100%', background:dimC, borderRadius:2, transition:'width 0.4s' }}/>
      </div>
      <div style={{ width:52, fontSize:9, color:dimC, fontFamily:'monospace', flexShrink:0, fontWeight:700 }}>
        {pct}% <span style={{ color:'#334155', fontWeight:400 }}>({total})</span>
      </div>
    </div>
  );
}

function StatCard({ label, value, color='#f1f5f9', sub }) {
  return (
    <div style={{ background:'#06090f', borderRadius:10, padding:'10px 12px', border:'1px solid #0f1929', textAlign:'center' }}>
      <div style={{ fontSize:9, color:'#475569', fontWeight:700, letterSpacing:'0.08em', marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:20, fontWeight:900, color, lineHeight:1 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize:9, color:'#334155', marginTop:3 }}>{sub}</div>}
    </div>
  );
}

// ── Journal stats ──────────────────────────────────────────────────────────────
function computeJournalStats(trades) {
  const closed = trades.filter(t => t.result && t.result !== 'open');
  if (!closed.length) return null;

  const wins   = closed.filter(t => t.result === 'win');
  const losses = closed.filter(t => t.result === 'loss');
  const be     = closed.filter(t => t.result === 'be');

  const winRate = closed.length ? (wins.length / closed.length * 100) : 0;

  const grossProfit = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? '∞' : '—';

  const avgWin  = wins.length   ? grossProfit / wins.length   : 0;
  const avgLoss = losses.length ? grossLoss   / losses.length : 0;
  const expectancy = ((wins.length/closed.length) * avgWin - (losses.length/closed.length) * avgLoss).toFixed(2);

  const avgRR = closed.filter(t => t.rr != null).reduce((s,t,_,a) => s + t.rr/a.length, 0).toFixed(2);

  // Equity curve (cumulative pnl by trade date)
  const sorted = [...closed].filter(t => t.pnl != null && t.openedAt).sort((a,b) => new Date(a.openedAt)-new Date(b.openedAt));
  let cumPnl = 0;
  const equity = sorted.map(t => { cumPnl += (t.pnl||0); return cumPnl; });
  const maxDD = (() => {
    let peak = 0, dd = 0;
    for (const v of equity) { if (v > peak) peak = v; if (peak - v > dd) dd = peak - v; }
    return dd.toFixed(2);
  })();

  // By pair
  const pairMap = {};
  closed.forEach(t => {
    if (!t.pair) return;
    if (!pairMap[t.pair]) pairMap[t.pair] = { wins:0, total:0 };
    pairMap[t.pair].total++;
    if (t.result==='win') pairMap[t.pair].wins++;
  });
  const byPair = Object.entries(pairMap).sort((a,b) => b[1].total-a[1].total).slice(0,8);

  // By DOW
  const dowMap = {};
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  closed.forEach(t => {
    if (!t.openedAt) return;
    const d = DAYS[new Date(t.openedAt).getDay()];
    if (!dowMap[d]) dowMap[d] = { wins:0, total:0 };
    dowMap[d].total++;
    if (t.result==='win') dowMap[d].wins++;
  });
  const byDow = ['Mon','Tue','Wed','Thu','Fri'].map(d => [d, dowMap[d]||{wins:0,total:0}]);

  // By session
  const sessMap = {};
  closed.forEach(t => {
    const s = t.session || 'Unknown';
    if (!sessMap[s]) sessMap[s] = { wins:0, total:0 };
    sessMap[s].total++;
    if (t.result==='win') sessMap[s].wins++;
  });
  const bySess = Object.entries(sessMap).sort((a,b) => b[1].total-a[1].total);

  // Monthly
  const monthMap = {};
  closed.forEach(t => {
    if (!t.openedAt) return;
    const d = new Date(t.openedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (!monthMap[key]) monthMap[key] = { pnl:0, wins:0, total:0 };
    monthMap[key].total++;
    monthMap[key].pnl += (t.pnl||0);
    if (t.result==='win') monthMap[key].wins++;
  });
  const byMonth = Object.entries(monthMap).sort((a,b) => a[0].localeCompare(b[0])).slice(-12);

  return {
    total:closed.length, wins:wins.length, losses:losses.length, be:be.length,
    winRate: winRate.toFixed(1), profitFactor, expectancy, avgRR, maxDD,
    totalPnl: cumPnl.toFixed(2),
    equity: [0, ...equity],
    byPair, byDow, bySess, byMonth,
  };
}

// ── Alpha Lab stats ────────────────────────────────────────────────────────────
function computeAlphaStats(sweeps) {
  if (!sweeps.length) return null;

  const wins   = sweeps.filter(s => s.outcome==='confirmed');
  const losses = sweeps.filter(s => s.outcome==='failed');
  const winRate = (wins.length / sweeps.length * 100).toFixed(1);
  const avgPips = (wins.reduce((s,t) => s+(t.pipsMoved||0),0) / (wins.length||1)).toFixed(1);
  const avgLoss = (losses.reduce((s,t) => s+(t.pipsMoved||0),0) / (losses.length||1)).toFixed(1);
  const pf = +avgLoss > 0 ? (+avgPips / +avgLoss).toFixed(2) : '∞';
  const expectancy = ((wins.length/sweeps.length) * +avgPips - (losses.length/sweeps.length) * +avgLoss).toFixed(1);

  const equity = (() => {
    const sorted = [...sweeps].sort((a,b) => new Date(a.time)-new Date(b.time));
    let cum = 0;
    return [0, ...sorted.map(s => { cum += s.outcome==='confirmed'?(s.pipsMoved||0):-(s.pipsMoved||10); return cum; })];
  })();

  const maxDD = (() => {
    let peak=0, dd=0;
    for (const v of equity) { if(v>peak) peak=v; if(peak-v>dd) dd=peak-v; }
    return dd.toFixed(1);
  })();

  const pairMap = {};
  sweeps.forEach(s => {
    const p = s.label || s.pair;
    if (!pairMap[p]) pairMap[p] = { wins:0, total:0 };
    pairMap[p].total++;
    if (s.outcome==='confirmed') pairMap[p].wins++;
  });
  const byPair = Object.entries(pairMap).sort((a,b) => b[1].total-a[1].total).slice(0,8);

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dowMap = {};
  sweeps.forEach(s => {
    const d = s.dow || (s.time ? DAYS[new Date(s.time).getDay()] : '?');
    if (!dowMap[d]) dowMap[d] = { wins:0, total:0 };
    dowMap[d].total++;
    if (s.outcome==='confirmed') dowMap[d].wins++;
  });
  const byDow = ['Mon','Tue','Wed','Thu','Fri'].map(d => [d, dowMap[d]||{wins:0,total:0}]);

  const tfMap = {};
  sweeps.forEach(s => {
    const t = s.tf||'?';
    if (!tfMap[t]) tfMap[t] = { wins:0, total:0 };
    tfMap[t].total++;
    if (s.outcome==='confirmed') tfMap[t].wins++;
  });
  const byTF = Object.entries(tfMap).sort((a,b) => b[1].total-a[1].total);

  const monthMap = {};
  sweeps.forEach(s => {
    if (!s.time) return;
    const d = new Date(s.time);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (!monthMap[key]) monthMap[key] = { pips:0, wins:0, total:0 };
    monthMap[key].total++;
    monthMap[key].pips += s.outcome==='confirmed'?(s.pipsMoved||0):-(s.pipsMoved||10);
    if (s.outcome==='confirmed') monthMap[key].wins++;
  });
  const byMonth = Object.entries(monthMap).sort((a,b) => a[0].localeCompare(b[0])).slice(-12);

  return {
    total:sweeps.length, wins:wins.length, losses:losses.length,
    winRate, profitFactor:pf, expectancy, avgPips, maxDD,
    equity, byPair, byDow, byTF, byMonth,
  };
}

export default function Analytics() {
  const [source, setSource] = useState('journal');

  const stats = useMemo(() => {
    if (source==='journal') return computeJournalStats(loadJournal());
    return computeAlphaStats(loadAlpha());
  }, [source]);

  const isAlpha = source === 'alpha';

  return (
    <div style={{ background:'#04070f', minHeight:'100vh', padding:'14px 12px', paddingBottom:80 }}>

      {/* Header */}
      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:16, fontWeight:900, color:'#f1f5f9', letterSpacing:'0.06em' }}>📊 PERFORMANCE ANALYTICS</div>
        <div style={{ fontSize:10, color:'#334155', marginTop:2 }}>Profit factor · Expectancy · Max drawdown · Win breakdown</div>
      </div>

      {/* Source toggle */}
      <div style={{ display:'flex', gap:4, marginBottom:14, background:'#06090f', padding:4, borderRadius:10, border:'1px solid #0f1929' }}>
        {[
          { id:'journal', label:'📋 Journal Trades' },
          { id:'alpha',   label:'⚗ Alpha Lab Sweeps' },
        ].map(s => (
          <button key={s.id} onClick={() => setSource(s.id)} style={{
            flex:1, padding:'8px', borderRadius:8, fontSize:11, fontWeight:800, cursor:'pointer', border:'none',
            background: source===s.id ? '#1e293b' : 'transparent',
            color: source===s.id ? '#f1f5f9' : '#334155',
          }}>{s.label}</button>
        ))}
      </div>

      {/* No data state */}
      {!stats && (
        <div style={{ textAlign:'center', padding:'60px 20px' }}>
          <div style={{ fontSize:32, marginBottom:12 }}>{isAlpha ? '⚗' : '📋'}</div>
          <div style={{ fontSize:14, fontWeight:700, color:'#334155', marginBottom:8 }}>
            {isAlpha ? 'No Alpha Lab data' : 'No journal trades found'}
          </div>
          <div style={{ fontSize:11, color:'#1e293b', maxWidth:240, margin:'0 auto', lineHeight:1.6 }}>
            {isAlpha ? 'Run a backfill in Alpha Lab to generate sweep history' : 'Log trades in the Journal tab to see performance analytics here'}
          </div>
        </div>
      )}

      {stats && <>

        {/* Summary stats */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:14 }}>
          <StatCard label="TOTAL TRADES"   value={stats.total} color="#f1f5f9"/>
          <StatCard label="WIN RATE"        value={`${stats.winRate}%`}
            color={+stats.winRate>=55?'#22c55e':+stats.winRate>=45?'#f59e0b':'#ef4444'}
            sub={`${stats.wins}W · ${stats.losses}L${stats.be?' · '+stats.be+'BE':''}`}/>
          <StatCard label="PROFIT FACTOR"   value={stats.profitFactor}
            color={+stats.profitFactor>=1.5?'#22c55e':+stats.profitFactor>=1?'#f59e0b':'#ef4444'}/>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:14 }}>
          <StatCard label="EXPECTANCY"     value={isAlpha ? `${stats.expectancy}p` : `$${stats.expectancy}`}
            color={+stats.expectancy>0?'#22c55e':'#ef4444'}/>
          <StatCard label={isAlpha?"AVG WIN (pips)":"NET P&L"}
            value={isAlpha ? `+${stats.avgPips}p` : `$${stats.totalPnl}`}
            color={isAlpha ? '#22c55e' : +stats.totalPnl>=0?'#22c55e':'#ef4444'}/>
          <StatCard label="MAX DRAWDOWN"   value={isAlpha?`${stats.maxDD}p`:`$${stats.maxDD}`} color="#f59e0b"/>
        </div>

        {/* Equity curve */}
        <div style={{ background:'#06090f', borderRadius:14, border:'1px solid #0f1929', padding:'12px 14px', marginBottom:14 }}>
          <div style={{ fontSize:10, color:'#475569', fontWeight:700, letterSpacing:'0.06em', marginBottom:8 }}>
            {isAlpha ? 'CUMULATIVE PIPS' : 'EQUITY CURVE (USD)'}
          </div>
          <EquityCurve points={stats.equity} W={340} H={100}/>
        </div>

        {/* Win rate by pair */}
        <div style={{ background:'#06090f', borderRadius:14, border:'1px solid #0f1929', padding:'12px 14px', marginBottom:14 }}>
          <div style={{ fontSize:10, color:'#475569', fontWeight:700, letterSpacing:'0.06em', marginBottom:10 }}>WIN RATE BY PAIR</div>
          {stats.byPair.map(([pair, d]) => (
            <HBar key={pair} label={pair} wins={d.wins} total={d.total}/>
          ))}
          {!stats.byPair.length && <div style={{ fontSize:10, color:'#334155' }}>Not enough data</div>}
        </div>

        {/* Win rate by day */}
        <div style={{ background:'#06090f', borderRadius:14, border:'1px solid #0f1929', padding:'12px 14px', marginBottom:14 }}>
          <div style={{ fontSize:10, color:'#475569', fontWeight:700, letterSpacing:'0.06em', marginBottom:10 }}>WIN RATE BY DAY OF WEEK</div>
          {stats.byDow.map(([day, d]) => (
            <HBar key={day} label={day} wins={d.wins} total={d.total}/>
          ))}
        </div>

        {/* Win rate by session / TF */}
        <div style={{ background:'#06090f', borderRadius:14, border:'1px solid #0f1929', padding:'12px 14px', marginBottom:14 }}>
          <div style={{ fontSize:10, color:'#475569', fontWeight:700, letterSpacing:'0.06em', marginBottom:10 }}>
            {isAlpha ? 'WIN RATE BY TIMEFRAME' : 'WIN RATE BY SESSION'}
          </div>
          {(isAlpha ? stats.byTF : stats.bySess).map(([k, d]) => (
            <HBar key={k} label={k} wins={d.wins} total={d.total}/>
          ))}
          {!(isAlpha ? stats.byTF : stats.bySess).length && <div style={{ fontSize:10, color:'#334155' }}>Not enough data</div>}
        </div>

        {/* Monthly breakdown */}
        {stats.byMonth.length > 0 && (
          <div style={{ background:'#06090f', borderRadius:14, border:'1px solid #0f1929', padding:'12px 14px', marginBottom:14 }}>
            <div style={{ fontSize:10, color:'#475569', fontWeight:700, letterSpacing:'0.06em', marginBottom:10 }}>
              MONTHLY BREAKDOWN
            </div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10 }}>
                <thead>
                  <tr>
                    {['Month', 'Trades', 'Wins', 'WR%', isAlpha?'Pips':'P&L'].map(h => (
                      <th key={h} style={{ padding:'4px 8px', color:'#475569', fontWeight:700, textAlign:'left',
                        borderBottom:'1px solid #0f1929', letterSpacing:'0.06em', fontSize:9 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.byMonth.map(([month, d]) => {
                    const wr = d.total ? Math.round(d.wins/d.total*100) : 0;
                    const val = isAlpha ? (d.pips||0) : (d.pnl||0);
                    const valColor = val >= 0 ? '#22c55e' : '#ef4444';
                    return (
                      <tr key={month}>
                        <td style={{ padding:'5px 8px', color:'#94a3b8', fontFamily:'monospace' }}>{month}</td>
                        <td style={{ padding:'5px 8px', color:'#64748b' }}>{d.total}</td>
                        <td style={{ padding:'5px 8px', color:'#22c55e' }}>{d.wins}</td>
                        <td style={{ padding:'5px 8px', color: wr>=60?'#22c55e':wr>=45?'#f59e0b':'#ef4444', fontWeight:700 }}>{wr}%</td>
                        <td style={{ padding:'5px 8px', color:valColor, fontFamily:'monospace', fontWeight:700 }}>
                          {val>=0?'+':''}{isAlpha?val.toFixed(1)+'p':'$'+val.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Best / Worst insights */}
        {stats.byPair.length >= 2 && (
          <div style={{ background:'#06090f', borderRadius:14, border:'1px solid #0f1929', padding:'12px 14px', marginBottom:14 }}>
            <div style={{ fontSize:10, color:'#475569', fontWeight:700, letterSpacing:'0.06em', marginBottom:10 }}>INSIGHTS</div>
            {(() => {
              const sorted = [...stats.byPair].filter(([,d]) => d.total>=3).sort((a,b) => (b[1].wins/b[1].total)-(a[1].wins/a[1].total));
              const best = sorted[0], worst = sorted[sorted.length-1];
              const bestDay = [...stats.byDow].filter(([,d]) => d.total>=2).sort((a,b) => (b[1].wins/b[1].total)-(a[1].wins/a[1].total))[0];
              return (
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {best && (
                    <div style={{ fontSize:11, color:'#64748b' }}>
                      🏆 Best pair: <span style={{ color:'#22c55e', fontWeight:700 }}>{best[0]}</span>
                      {' '}{Math.round(best[1].wins/best[1].total*100)}% WR ({best[1].total} trades)
                    </div>
                  )}
                  {worst && worst[0] !== best?.[0] && (
                    <div style={{ fontSize:11, color:'#64748b' }}>
                      ⚠️ Worst pair: <span style={{ color:'#ef4444', fontWeight:700 }}>{worst[0]}</span>
                      {' '}{Math.round(worst[1].wins/worst[1].total*100)}% WR ({worst[1].total} trades) — consider reducing exposure
                    </div>
                  )}
                  {bestDay && bestDay[1].total >= 2 && (
                    <div style={{ fontSize:11, color:'#64748b' }}>
                      📅 Best day: <span style={{ color:'#f59e0b', fontWeight:700 }}>{bestDay[0]}</span>
                      {' '}{Math.round(bestDay[1].wins/bestDay[1].total*100)}% WR
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

      </>}
    </div>
  );
}

import { useState, useEffect, useCallback, useMemo } from 'react';
import { INSTRUMENTS, CLASS, CLASS_ORDER, bySymbol, byClass, exposureOf, REGISTRY_STATS } from '../data/instruments';
import { fetchPositioning, fetchSpreadStress, fetchSqueeze, fetchDepthMap, oandaCreds } from '../utils/flowFeed';

const C = {
  bg:'#080c11', panel:'#0b1118', line:'#16202b', dim:'#475569', txt:'#cbd5e1',
  accent:'#00d4aa', warn:'#f59e0b', bad:'#ef4444', good:'#22c55e', mono:'var(--mono, monospace)',
};

// ── Provenance ────────────────────────────────────────────────────────────────
// The rule this screen is built on: never show a number that cannot be sourced.
// Every value carries where it came from and when, and an unavailable feed says
// so plainly instead of being filled in with a plausible-looking substitute.
const SRC = {
  live:        { c:'#22c55e', t:'LIVE' },
  delayed:     { c:'#0ea5e9', t:'DELAYED' },
  weekly:      { c:'#a78bfa', t:'WEEKLY' },
  unavailable: { c:'#475569', t:'N/A' },
  error:       { c:'#ef4444', t:'ERROR' },
};

function Src({ kind, note }) {
  const s = SRC[kind] || SRC.unavailable;
  return (
    <span style={{ fontSize:8, fontWeight:800, color:s.c, fontFamily:C.mono, letterSpacing:'0.5px' }}>
      {s.t}{note ? <span style={{ color:'#334155', fontWeight:400 }}> · {note}</span> : null}
    </span>
  );
}

function Card({ title, src, note, children }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:5, overflow:'hidden' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
        padding:'6px 9px', borderBottom:`1px solid ${C.line}`, background:'#0a0f15' }}>
        <span style={{ fontSize:10, fontWeight:800, letterSpacing:'1px', color:C.accent, fontFamily:C.mono }}>{title}</span>
        <Src kind={src} note={note}/>
      </div>
      <div style={{ padding:'8px 9px' }}>{children}</div>
    </div>
  );
}

const Muted = ({ children }) => (
  <div style={{ fontSize:10, color:C.dim, fontFamily:C.mono, lineHeight:1.6 }}>{children}</div>
);

// ── Data loaders ──────────────────────────────────────────────────────────────
async function loadCandles(inst, tf = 'H1', count = 120) {
  if (inst.binance) {
    const map = { M5:'5m', M15:'15m', H1:'1h', H4:'4h', D:'1d' };
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${inst.binance}&interval=${map[tf]||'1h'}&limit=${count}`,
      { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    const d = await r.json();
    return { candles: d.map(k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] })), source:'Binance' };
  }
  const c = oandaCreds();
  if (!c?.apiKey) { const e = new Error('OANDA not connected'); e.code='NOKEY'; throw e; }
  const base = c.practice === false ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3';
  const r = await fetch(`${base}/instruments/${inst.oanda}/candles?granularity=${tf}&count=${count}&price=M`,
    { headers:{ Authorization:`Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`OANDA ${r.status}`);
  const d = await r.json();
  return {
    candles: (d.candles||[]).filter(x=>x.complete).map(x=>({
      t:new Date(x.time).getTime(), o:+x.mid.o, h:+x.mid.h, l:+x.mid.l, c:+x.mid.c, v:x.volume||0 })),
    source:'OANDA',
  };
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function Spark({ candles, dec }) {
  if (!candles?.length) return null;
  const W = 600, H = 96, pad = 4;
  const cs = candles.map(c => c.c);
  const mn = Math.min(...cs), mx = Math.max(...cs), rng = (mx - mn) || 1;
  const x = i => pad + (i / (cs.length - 1)) * (W - pad*2);
  const y = v => pad + (1 - (v - mn) / rng) * (H - pad*2);
  const up = cs[cs.length-1] >= cs[0];
  const col = up ? C.good : C.bad;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:H, display:'block' }}>
      <defs>
        <linearGradient id="ivg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.22"/>
          <stop offset="100%" stopColor={col} stopOpacity="0.01"/>
        </linearGradient>
      </defs>
      <path d={`M${x(0)},${y(cs[0])} ${cs.map((v,i)=>`L${x(i)},${y(v)}`).join(' ')} L${x(cs.length-1)},${H-pad} L${x(0)},${H-pad} Z`} fill="url(#ivg)"/>
      <polyline points={cs.map((v,i)=>`${x(i)},${y(v)}`).join(' ')} fill="none" stroke={col} strokeWidth="1.6"/>
      <text x={W-2} y={11} textAnchor="end" fontSize="9" fill="#475569" fontFamily="monospace">{mx.toFixed(dec)}</text>
      <text x={W-2} y={H-3} textAnchor="end" fontSize="9" fill="#475569" fontFamily="monospace">{mn.toFixed(dec)}</text>
    </svg>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function InstrumentView({ sym: symProp, onBack }) {
  const [sym,   setSym]   = useState(symProp || 'XAU/USD');
  const [tf,    setTf]    = useState('H1');
  const [query, setQuery] = useState('');
  const [px,    setPx]    = useState(null);   // {candles, source} | {error}
  const [spread,setSpread]= useState(null);
  const [posn,  setPosn]  = useState(null);
  const [deriv, setDeriv] = useState(null);
  const [depth, setDepth] = useState(null);
  const [events,setEvents]= useState(null);
  const [busy,  setBusy]  = useState(false);
  const [asOf,  setAsOf]  = useState(null);

  const inst = bySymbol(sym);

  const load = useCallback(async () => {
    if (!inst) return;
    setBusy(true);
    setPx(null); setSpread(null); setPosn(null); setDeriv(null); setDepth(null);

    const jobs = [
      loadCandles(inst, tf).then(r => setPx(r)).catch(e => setPx({ error:e.message, code:e.code })),
      inst.can.spread
        ? fetchSpreadStress({ sym:inst.sym, oanda:inst.oanda }).then(setSpread).catch(e => setSpread({ error:e.message }))
        : Promise.resolve(),
      inst.can.positioning
        ? fetchPositioning({ key:inst.sym, label:inst.name, code:inst.cot, group:inst.cls })
            .then(setPosn).catch(e => setPosn({ error:e.message }))
        : Promise.resolve(),
      inst.can.derivatives
        ? fetchSqueeze(inst.binance).then(setDeriv).catch(e => setDeriv({ error:e.message }))
        : Promise.resolve(),
      inst.can.depth
        ? fetchDepthMap(inst.binance).then(setDepth).catch(e => setDepth({ error:e.message }))
        : Promise.resolve(),
    ];
    // Upcoming high-impact events for the currencies this instrument is exposed
    // to. Same calendar the News tab uses; attached here so the instrument page
    // answers "is something scheduled that moves this" without a tab switch.
    jobs.push((async () => {
      try {
        const ccys = exposureOf(inst);
        const cached = JSON.parse(localStorage.getItem('news_event_archive_v1') || '[]');
        const now = Date.now();
        const soon = cached
          .filter(e => ccys.includes(e.country) && (e.impact === 'High' || e.impact === 'Medium'))
          .map(e => ({ ...e, ms: new Date(e.date).getTime() }))
          .filter(e => e.ms > now)
          .sort((a, b) => a.ms - b.ms)
          .slice(0, 4);
        setEvents(soon);
      } catch { setEvents([]); }
    })());

    await Promise.allSettled(jobs);
    setAsOf(new Date());
    setBusy(false);
  }, [inst, tf]);

  useEffect(() => { load(); }, [load]);

  // Follow the symbol the shell asks for
  useEffect(() => { if (symProp && symProp !== sym) setSym(symProp); }, [symProp]); // eslint-disable-line

  const results = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return null;
    return INSTRUMENTS.filter(i =>
      i.sym.toUpperCase().includes(q) || i.name.toUpperCase().includes(q)
    ).slice(0, 8);
  }, [query]);

  const last = px?.candles?.[px.candles.length - 1];
  const first = px?.candles?.[0];
  const chg = last && first ? ((last.c - first.c) / first.c) * 100 : null;

  return (
    <div style={{ background:C.bg, minHeight:'100vh', paddingBottom:80, fontFamily:C.mono }}>

      {/* command bar — type a symbol, like a terminal */}
      <div style={{ position:'sticky', top:0, zIndex:6, background:C.bg, borderBottom:`1px solid ${C.line}`, padding:'8px 10px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, background:'#000',
          border:'1px solid #1e3a2f', borderRadius:4, padding:'6px 9px' }}>
          <span style={{ color:C.accent, fontWeight:800, fontSize:13 }}>&gt;</span>
          <input value={query} onChange={e=>setQuery(e.target.value)}
            onKeyDown={e => { if (e.key==='Enter' && results?.length) { setSym(results[0].sym); setQuery(''); } }}
            placeholder={`${sym} — type to search ${REGISTRY_STATS.total} instruments`}
            spellCheck={false}
            style={{ flex:1, background:'transparent', border:'none', outline:'none', color:'#d1fae5',
              fontSize:13, fontFamily:'inherit', textTransform:'uppercase' }}/>
          {busy && <span style={{ fontSize:9, color:C.dim }}>loading…</span>}
          <button onClick={load} style={{ fontSize:10, fontWeight:800, padding:'2px 8px', borderRadius:3,
            border:`1px solid ${C.accent}44`, background:'#00d4aa15', color:C.accent, cursor:'pointer' }}>↻</button>
        </div>

        {results && (
          <div style={{ marginTop:5, background:C.panel, border:`1px solid ${C.line}`, borderRadius:4 }}>
            {results.length === 0 && <div style={{ padding:'6px 9px', fontSize:10, color:C.dim }}>no match</div>}
            {results.map(i => (
              <button key={i.sym} onClick={() => { setSym(i.sym); setQuery(''); }}
                style={{ display:'flex', width:'100%', alignItems:'center', gap:8, padding:'5px 9px',
                  background:'transparent', border:'none', borderBottom:'1px solid #0e161e', cursor:'pointer', textAlign:'left' }}>
                <span style={{ fontSize:11, color:C.txt, fontWeight:700, width:88 }}>{i.sym}</span>
                <span style={{ fontSize:10, color:C.dim, flex:1 }}>{i.name}</span>
                <span style={{ fontSize:8, fontWeight:800, color:CLASS[i.cls].color }}>{CLASS[i.cls].label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* class shortcuts */}
      <div style={{ display:'flex', gap:4, flexWrap:'wrap', padding:'8px 10px 0' }}>
        {CLASS_ORDER.flatMap(cls => byClass(cls).filter(i => i.major)).map(i => (
          <button key={i.sym} onClick={() => setSym(i.sym)}
            style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:2, cursor:'pointer',
              border:`1px solid ${sym===i.sym ? CLASS[i.cls].color+'66' : C.line}`,
              background: sym===i.sym ? CLASS[i.cls].color+'18' : 'transparent',
              color: sym===i.sym ? CLASS[i.cls].color : C.dim }}>
            {i.sym.replace('/USDT','').replace('/','')}
          </button>
        ))}
      </div>

      {inst && (
        <div style={{ padding:'9px 10px', display:'flex', flexDirection:'column', gap:9 }}>

          {/* header */}
          <div style={{ display:'flex', alignItems:'baseline', gap:9, flexWrap:'wrap' }}>
            {onBack && (
              <button onClick={onBack} title="Back to market scan"
                style={{ fontSize:13, fontWeight:800, padding:'1px 8px', borderRadius:3, cursor:'pointer',
                  border:`1px solid ${C.line}`, background:'transparent', color:C.accent }}>←</button>
            )}
            <span style={{ fontSize:20, fontWeight:900, color:C.txt, letterSpacing:'-0.5px' }}>{inst.sym}</span>
            <span style={{ fontSize:11, color:C.dim }}>{inst.name}</span>
            <span style={{ fontSize:9, fontWeight:800, color:CLASS[inst.cls].color,
              border:`1px solid ${CLASS[inst.cls].color}44`, borderRadius:2, padding:'1px 6px' }}>
              {CLASS[inst.cls].label}
            </span>
            <span style={{ marginLeft:'auto', fontSize:9, color:'#334155' }}>
              {asOf ? `as of ${asOf.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : ''}
            </span>
          </div>

          {/* price */}
          <Card title="PRICE" src={px?.error ? 'error' : px ? 'live' : 'unavailable'}
            note={px?.source ? `${px.source} · ${tf}` : px?.error || ''}>
            <div style={{ display:'flex', gap:4, marginBottom:7 }}>
              {['M15','H1','H4','D'].map(t => (
                <button key={t} onClick={()=>setTf(t)}
                  style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:2, cursor:'pointer',
                    border:`1px solid ${tf===t?'#00d4aa55':C.line}`, background:tf===t?'#00d4aa15':'transparent',
                    color:tf===t?C.accent:C.dim }}>{t}</button>
              ))}
            </div>
            {px?.error ? (
              <Muted>
                {px.code === 'NOKEY'
                  ? 'No OANDA key connected — connect one in Settings to price this instrument.'
                  : `Could not load prices: ${px.error}`}
                <div style={{ color:'#334155', marginTop:3 }}>
                  No substitute figure is shown. A number here would be invented, not measured.
                </div>
              </Muted>
            ) : !px ? <Muted>loading…</Muted> : (
              <>
                <div style={{ display:'flex', alignItems:'baseline', gap:10, marginBottom:4 }}>
                  <span style={{ fontSize:22, fontWeight:900, color:C.txt }}>{last?.c.toFixed(inst.dec)}</span>
                  {chg != null && (
                    <span style={{ fontSize:12, fontWeight:800, color: chg>=0?C.good:C.bad }}>
                      {chg>=0?'+':''}{chg.toFixed(2)}%
                    </span>
                  )}
                  <span style={{ fontSize:9, color:'#334155' }}>{px.candles.length} bars</span>
                </div>
                <Spark candles={px.candles} dec={inst.dec}/>
              </>
            )}
          </Card>

          {/* cost to trade */}
          <Card title="COST TO TRADE"
            src={!inst.can.spread ? 'unavailable' : spread?.error ? 'error' : spread ? 'live' : 'unavailable'}
            note={inst.can.spread ? (spread?.error || 'spread vs own median') : 'no bid/ask feed'}>
            {!inst.can.spread ? (
              <Muted>Spread is measured from OANDA bid/ask candles. {inst.cls === 'crypto'
                ? 'Crypto here is priced from Binance mid, which does not publish this.' : 'Not available for this instrument.'}</Muted>
            ) : spread?.error ? <Muted>{spread.error}</Muted>
              : !spread ? <Muted>measuring…</Muted> : (
              <div style={{ display:'flex', alignItems:'center', gap:9 }}>
                <span style={{ fontSize:18, fontWeight:900,
                  color: spread.state==='blown'?C.bad:spread.state==='wide'?C.warn:C.txt }}>
                  {spread.bps} bp
                </span>
                <span style={{ fontSize:10, color:C.dim }}>×{spread.ratio} vs normal</span>
                <span style={{ marginLeft:'auto', fontSize:9, fontWeight:800,
                  color: spread.state==='blown'?C.bad:spread.state==='wide'?C.warn:C.dim }}>
                  {spread.state.toUpperCase()}
                </span>
              </div>
            )}
          </Card>

          {/* positioning */}
          <Card title="POSITIONING"
            src={!inst.can.positioning ? 'unavailable' : posn?.error ? 'error' : posn?.enough ? 'weekly' : posn ? 'weekly' : 'unavailable'}
            note={inst.can.positioning ? (posn?.date ? `CFTC ${String(posn.date).slice(0,10)}` : 'CFTC') : 'no futures contract'}>
            {!inst.can.positioning ? (
              <Muted>No CFTC futures contract maps to this instrument — crosses and minor indices are not reported separately.</Muted>
            ) : posn?.error ? <Muted>{posn.error}</Muted>
              : !posn ? <Muted>loading…</Muted>
              : posn.failed ? <Muted>CFTC returned no rows for contract {inst.cot}.</Muted>
              : (
              <>
                <div style={{ display:'flex', alignItems:'center', gap:9 }}>
                  <span style={{ fontSize:16, fontWeight:900, color: posn.net>0?C.good:C.bad }}>
                    {posn.net>0?'+':''}{Math.round(posn.net/1000)}k
                  </span>
                  <span style={{ fontSize:10, color: posn.change>0?C.good:C.bad }}>
                    {posn.change==null?'':`${posn.change>0?'+':''}${Math.round(posn.change/1000)}k wk`}
                  </span>
                  <span style={{ marginLeft:'auto', fontSize:10, fontWeight:800,
                    color: !posn.enough ? C.warn : posn.pct>=90?C.bad:posn.pct<=10?C.good:C.dim }}>
                    {posn.enough ? `${posn.pct}th pct` : `n=${posn.weeks} — too thin to rank`}
                  </span>
                </div>
                {posn.enough && (
                  <div style={{ height:8, background:'#131c26', borderRadius:2, overflow:'hidden', marginTop:6 }}>
                    <div style={{ width:`${posn.pct}%`, height:'100%',
                      background: posn.pct>=90?'#ef4444':posn.pct<=10?'#22c55e':'#334155' }}/>
                  </div>
                )}
                <div style={{ fontSize:8, color:'#334155', marginTop:5, lineHeight:1.5 }}>
                  Fund net position against its own 3-year range. Weekly release — positioning, not timing.
                </div>
              </>
            )}
          </Card>

          {/* derivatives */}
          {inst.can.derivatives && (
            <Card title="DERIVATIVES" src={deriv?.error ? 'error' : deriv ? 'live' : 'unavailable'} note="binance perp">
              {deriv?.error ? <Muted>{deriv.error}</Muted> : !deriv ? <Muted>loading…</Muted> : (
                <div style={{ display:'flex', alignItems:'center', gap:9, flexWrap:'wrap' }}>
                  <span style={{ fontSize:14, fontWeight:900, color: deriv.funding>0?C.good:C.bad }}>
                    {deriv.fundingAnnual>0?'+':''}{deriv.fundingAnnual}%
                  </span>
                  <span style={{ fontSize:9, color:C.dim }}>funding (annualised)</span>
                  <span style={{ fontSize:9, color:C.dim }}>
                    OI {deriv.oiChangePct==null?'—':`${deriv.oiChangePct>0?'↑':'↓'}${Math.abs(deriv.oiChangePct)}%`}
                  </span>
                  <span style={{ marginLeft:'auto', fontSize:9, fontWeight:800,
                    color: deriv.state?.includes('squeeze')?C.bad:deriv.state?.includes('crowded')?C.warn:C.dim }}>
                    {deriv.state==='neutral'?'':deriv.state.replace(/-/g,' ').toUpperCase()}
                  </span>
                </div>
              )}
            </Card>
          )}

          {/* order book — real resting size, crypto only */}
          {inst.can.depth && (
            <Card title="ORDER BOOK" src={depth?.error ? 'error' : depth ? 'live' : 'unavailable'}
              note={depth && !depth.error ? `spans ±${(depth.rangePct/2).toFixed(2)}%` : 'binance'}>
              {depth?.error ? <Muted>{depth.error}</Muted> : !depth ? <Muted>loading…</Muted> : (
                <>
                  <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:7, fontSize:10 }}>
                    <div style={{ flex:1, height:11, background:'#1a2430', borderRadius:2, overflow:'hidden', display:'flex' }}>
                      <div style={{ width:`${depth.imbalance}%`, background:'#22c55e55' }}/>
                      <div style={{ width:`${100-depth.imbalance}%`, background:'#ef444455' }}/>
                    </div>
                    <span style={{ fontSize:9, color:C.dim }}>{depth.imbalance}% bid</span>
                  </div>
                  {depth.walls.length === 0
                    ? <Muted>No stand-out walls — depth is evenly spread.</Muted>
                    : depth.walls.map((w, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:6, padding:'1px 0', fontSize:10 }}>
                        <span style={{ color: w.side==='bid'?C.good:C.bad, width:12 }}>{w.side==='bid'?'▼':'▲'}</span>
                        <span style={{ color:C.txt, width:72 }}>{w.price.toFixed(inst.dec)}</span>
                        <div style={{ flex:1, height:7, background:'#131c26', borderRadius:2, overflow:'hidden' }}>
                          <div style={{ width:`${Math.max(4, w.rel*100)}%`, height:'100%',
                            background: w.side==='bid'?'#22c55e':'#ef4444' }}/>
                        </div>
                        <span style={{ color:C.dim, width:48, textAlign:'right' }}>
                          ${w.notional>=1e6?`${(w.notional/1e6).toFixed(1)}M`:`${Math.round(w.notional/1e3)}k`}
                        </span>
                        <span style={{ color: w.xMedian>=8?C.warn:'#334155', width:30, textAlign:'right' }}>×{w.xMedian}</span>
                      </div>
                    ))}
                  <div style={{ fontSize:8, color:'#334155', marginTop:5, lineHeight:1.5 }}>
                    Real resting orders. ×N = size versus a typical price level; only ≥×3 qualifies as a wall.
                    Walls can be pulled at any moment.
                  </div>
                </>
              )}
            </Card>
          )}

          {/* scheduled risk */}
          <Card title="SCHEDULED RISK" src={events?.length ? 'delayed' : 'unavailable'}
            note={events?.length ? `next ${events.length} · ${exposureOf(inst).join('/')}` : 'calendar archive'}>
            {events === null ? <Muted>loading…</Muted>
              : events.length === 0 ? (
                <Muted>
                  No upcoming high-impact events archived for {exposureOf(inst).join(' / ')}.
                  The calendar source publishes one week at a time and builds up as the News tab is opened.
                </Muted>
              ) : events.map((e, i) => {
                const mins = Math.round((e.ms - Date.now()) / 60000);
                const soon = mins < 120;
                return (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'2px 0', fontFamily:C.mono }}>
                    <span style={{ fontSize:9, fontWeight:800, color: e.impact === 'High' ? C.bad : C.warn, width:30 }}>
                      {e.country}
                    </span>
                    <span style={{ fontSize:10, color:C.txt, flex:1, minWidth:0, overflow:'hidden',
                      textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.title}</span>
                    <span style={{ fontSize:9, fontWeight:soon?800:400, color: soon ? C.bad : C.dim, flexShrink:0 }}>
                      {mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins/60)}h` : `${Math.floor(mins/1440)}d`}
                    </span>
                  </div>
                );
              })}
          </Card>

          {/* what this instrument supports — honesty about coverage */}
          <Card title="DATA COVERAGE" src="live" note="what is available for this instrument">
            <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
              {[
                ['Price/Chart', inst.can.candles],
                ['Spread',      inst.can.spread],
                ['Positioning', inst.can.positioning],
                ['Derivatives', inst.can.derivatives],
                ['Order book',  inst.can.depth],
              ].map(([label, ok]) => (
                <span key={label} style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:2,
                  border:`1px solid ${ok?'#22c55e33':'#1e293b'}`, background: ok?'#22c55e0c':'transparent',
                  color: ok?C.good:'#334155' }}>
                  {ok?'✓':'✕'} {label}
                </span>
              ))}
            </div>
            <div style={{ fontSize:8, color:'#334155', marginTop:6, lineHeight:1.5 }}>
              Exposure: {exposureOf(inst).join(' · ') || '—'}.
              Panels above show only measured values; where a feed is unavailable it says so rather than
              substituting an estimate.
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

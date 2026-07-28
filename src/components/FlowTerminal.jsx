import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BOOK_INSTRUMENTS, SQUEEZE_SYMBOLS, COT_CODES,
  fetchPositionBook, fetchOrderBook, liquidityPools, retailBias,
  fetchSqueeze, fetchTakerFlow, fetchCOTNet, smartVsDumb,
  CORREL_PAIRS, pearson, returnsOf, correlationBreak, oandaCreds, probeOanda,
  DEPTH_SYMBOLS, fetchDepthMap,
  POSITION_MARKETS, fetchPositioning, SPREAD_INSTRUMENTS, fetchSpreadStress,
} from '../utils/flowFeed';

const C = {
  bg:'#080c11', panel:'#0b1118', line:'#16202b', dim:'#475569', txt:'#cbd5e1',
  accent:'#00d4aa', warn:'#f59e0b', bad:'#ef4444', good:'#22c55e', mono:'var(--mono, monospace)',
};

function Panel({ title, right, children, flex }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:5, overflow:'hidden', flex }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
        padding:'6px 9px', borderBottom:`1px solid ${C.line}`, background:'#0a0f15' }}>
        <span style={{ fontSize:10, fontWeight:800, letterSpacing:'1px', color:C.accent, fontFamily:C.mono }}>{title}</span>
        {right && <span style={{ fontSize:9, color:C.dim, fontFamily:C.mono }}>{right}</span>}
      </div>
      <div style={{ padding:'7px 9px' }}>{children}</div>
    </div>
  );
}

const Empty = ({ children }) => (
  <div style={{ fontSize:10, color:C.dim, fontFamily:C.mono, padding:'8px 0', lineHeight:1.6 }}>{children}</div>
);

// ── 1. LIQUIDITY MAP ──────────────────────────────────────────────────────────
// Explains exactly why the book is missing — measured, not guessed.
const VERDICT = {
  TOKEN_BAD: {
    c:'#ef4444', t:'Token rejected by BOTH OANDA hosts',
    d:'This key does not authenticate anywhere, so it is expired, revoked, or mistyped. Generate a fresh personal access token in the OANDA portal and paste it into Settings.',
  },
  WRONG_ENV: {
    c:'#f59e0b', t:'Token belongs to the other environment',
    d:'The key authenticates fine — just not on the host currently selected. Flip the environment toggle in Settings to match, and the book will load.',
  },
  BOOK_DENIED: {
    c:'#f59e0b', t:'Token is valid; the book itself is refused',
    d:'Authentication succeeds on this host, so the key is correct — OANDA is declining the order/position book specifically. That is an account-level entitlement, not something the app can fix.',
  },
  BOOK_OK: {
    c:'#22c55e', t:'Book is reachable now',
    d:'The earlier failure was transient. Hit refresh.',
  },
};

function BookDiagnosis({ fail, probe, probing, onProbe }) {
  if (!fail) return null;
  if (fail.code === 'NOKEY') return <Empty>No OANDA key connected. Add one in Settings.</Empty>;
  if (fail.code === 'UNSUPPORTED') return <Empty>OANDA does not publish a book for this instrument. Try a major pair or gold.</Empty>;

  const v = probe?.verdict ? VERDICT[probe.verdict] : null;
  return (
    <div style={{ fontSize:10, fontFamily:C.mono, lineHeight:1.6, padding:'6px 0' }}>
      <div style={{ fontWeight:800, color:C.warn, marginBottom:3 }}>
        Book refused ({fail.status}) on your <u>{fail.env}</u> token
      </div>
      {fail.message && <div style={{ color:'#334155', marginBottom:6 }}>OANDA said: “{fail.message}”</div>}

      {!probe && (
        <button onClick={onProbe} disabled={probing}
          style={{ fontSize:10, fontWeight:800, padding:'4px 10px', borderRadius:3, cursor:probing?'default':'pointer',
            border:`1px solid ${C.accent}44`, background:'#00d4aa15', color:C.accent }}>
          {probing ? 'testing both hosts…' : '⌕ Diagnose this token'}
        </button>
      )}

      {v && (
        <>
          <div style={{ fontWeight:800, color:v.c, marginTop:4 }}>{v.t}</div>
          <div style={{ color:C.dim, marginTop:2 }}>{v.d}</div>
          <div style={{ marginTop:6, borderTop:`1px solid ${C.line}`, paddingTop:5 }}>
            {probe.rows.map(r => (
              <div key={r.env} style={{ display:'flex', gap:8, color:'#475569' }}>
                <span style={{ width:64, color: r.env===probe.configured ? C.txt : '#334155' }}>
                  {r.env}{r.env===probe.configured ? ' *' : ''}
                </span>
                <span style={{ width:74, color: r.auth===200 ? C.good : C.bad }}>auth {r.auth || 'fail'}</span>
                <span style={{ color: r.book===200 ? C.good : r.book ? C.bad : '#334155' }}>
                  book {r.book ?? '—'}
                </span>
              </div>
            ))}
            <div style={{ color:'#2b3644', marginTop:3 }}>* currently selected in Settings</div>
          </div>
        </>
      )}
    </div>
  );
}

// Real Binance order book: live resting bids/asks, not inferred from candles.
function DepthMap({ depth }) {
  if (!depth) return null;
  const dec = depth.mid >= 1000 ? 1 : depth.mid >= 1 ? 3 : 5;
  return (
    <>
      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8, fontFamily:C.mono, fontSize:10 }}>
        <span style={{ color:C.dim }}>BOOK</span>
        <div style={{ flex:1, height:12, background:'#1a2430', borderRadius:2, overflow:'hidden', display:'flex' }}>
          <div style={{ width:`${depth.imbalance}%`, background:'#22c55e55', display:'flex', alignItems:'center', paddingLeft:4 }}>
            <span style={{ fontSize:8, color:C.good, fontWeight:800 }}>{depth.imbalance}% bid</span>
          </div>
          <div style={{ width:`${100-depth.imbalance}%`, background:'#ef444455', display:'flex', alignItems:'center', justifyContent:'flex-end', paddingRight:4 }}>
            <span style={{ fontSize:8, color:C.bad, fontWeight:800 }}>{(100-depth.imbalance).toFixed(1)}% ask</span>
          </div>
        </div>
        {Math.abs(depth.imbalance - 50) >= 15 && (
          <span style={{ fontSize:9, color:C.warn, fontWeight:800 }}>SKEWED</span>
        )}
      </div>

      <div style={{ fontSize:9, color:C.dim, fontFamily:C.mono, marginBottom:4 }}>
        RESTING WALLS · mid {depth.mid.toFixed(dec)} · book spans ±{(depth.rangePct/2).toFixed(2)}%
      </div>
      {depth.walls.length === 0 && (
        <Empty>No stand-out walls — depth is evenly spread, no single block dominates.</Empty>
      )}
      {depth.walls.map((w, i) => (
        <div key={i} style={{ display:'flex', alignItems:'center', gap:6, padding:'2px 0', fontFamily:C.mono }}>
          <span style={{ fontSize:10, color: w.side==='bid' ? C.good : C.bad, width:14, flexShrink:0 }}>
            {w.side==='bid' ? '▼' : '▲'}
          </span>
          <span style={{ fontSize:10, color:C.txt, width:70, flexShrink:0 }}>{w.price.toFixed(dec)}</span>
          <div style={{ flex:1, height:9, background:'#131c26', borderRadius:2, overflow:'hidden' }}>
            <div style={{ width:`${Math.max(4, w.rel*100)}%`, height:'100%',
              background: w.side==='bid' ? 'linear-gradient(90deg,#22c55e88,#22c55e)' : 'linear-gradient(90deg,#ef444488,#ef4444)' }}/>
          </div>
          <span style={{ fontSize:9, color:C.dim, width:52, textAlign:'right', flexShrink:0 }}>
            ${w.notional >= 1e6 ? `${(w.notional/1e6).toFixed(1)}M` : `${Math.round(w.notional/1e3)}k`}
          </span>
          <span style={{ fontSize:9, color: w.xMedian >= 8 ? C.warn : '#334155', width:34, textAlign:'right', flexShrink:0 }}>
            ×{w.xMedian}
          </span>
          <span style={{ fontSize:9, color:'#334155', width:44, textAlign:'right', flexShrink:0 }}>
            {w.distPct > 0 ? '+' : ''}{w.distPct}%
          </span>
        </div>
      ))}
      <div style={{ fontSize:8, color:'#334155', fontFamily:C.mono, marginTop:6, lineHeight:1.5 }}>
        ▼ bid walls below · ▲ ask walls above. ×N = how many times the typical price level this block is;
        only levels ≥×3 qualify. Walls can be pulled at any moment — this is the book now, not a promise.
      </div>
    </>
  );
}

function LiquidityMap({ sym, setSym, data, depth, busy, fail, probe, probing, onProbe }) {
  const inst = BOOK_INSTRUMENTS.find(i => i.sym === sym);
  const isCrypto = DEPTH_SYMBOLS.includes(sym);
  const d = data[sym];
  const pools = d?.pools || [];
  const bias = d?.bias;
  const px = d?.book?.price;
  const dep = depth[sym];

  return (
    <Panel title="LIQUIDITY MAP"
      right={isCrypto ? 'binance · live book' : (d?.book?.time ? new Date(d.book.time).toUTCString().slice(17, 22) + ' UTC' : 'oanda')}>
      <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:8 }}>
        {DEPTH_SYMBOLS.map(s => (
          <button key={s} onClick={() => setSym(s)}
            style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:2, cursor:'pointer', fontFamily:C.mono,
              border:`1px solid ${sym===s?'#00d4aa55':C.line}`, background:sym===s?'#00d4aa15':'transparent',
              color:sym===s?C.accent:C.dim }}>{s.replace('USDT','')}</button>
        ))}
        {BOOK_INSTRUMENTS.map(i => (
          <button key={i.sym} onClick={() => setSym(i.sym)}
            style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:2, cursor:'pointer', fontFamily:C.mono, opacity:0.55,
              border:`1px solid ${sym===i.sym?'#00d4aa55':C.line}`, background:sym===i.sym?'#00d4aa15':'transparent',
              color:sym===i.sym?C.accent:C.dim }}>{i.sym.replace('/','')}</button>
        ))}
      </div>

      {isCrypto && !dep && busy && <Empty>loading order book…</Empty>}
      {isCrypto && !dep && !busy && <Empty>Order book unavailable for {sym}.</Empty>}
      {isCrypto && dep && <DepthMap depth={dep}/>}

      {!isCrypto && busy && !d && <Empty>loading book…</Empty>}
      {!isCrypto && !busy && !d && (fail ? <BookDiagnosis fail={fail} probe={probe} probing={probing} onProbe={onProbe}/> : <Empty>No book data returned for this instrument.</Empty>)}

      {!isCrypto && d && (
        <>
          {bias && (
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8, fontFamily:C.mono, fontSize:10 }}>
              <span style={{ color:C.dim }}>RETAIL</span>
              <div style={{ flex:1, height:12, background:'#1a2430', borderRadius:2, overflow:'hidden', display:'flex' }}>
                <div style={{ width:`${bias.longPct}%`, background:'#22c55e55', display:'flex', alignItems:'center', paddingLeft:4 }}>
                  <span style={{ fontSize:8, color:C.good, fontWeight:800 }}>{bias.longPct}% L</span>
                </div>
                <div style={{ width:`${bias.shortPct}%`, background:'#ef444455', display:'flex', alignItems:'center', justifyContent:'flex-end', paddingRight:4 }}>
                  <span style={{ fontSize:8, color:C.bad, fontWeight:800 }}>{bias.shortPct}% S</span>
                </div>
              </div>
              {bias.crowded && <span style={{ fontSize:9, color:C.warn, fontWeight:800 }}>CROWDED</span>}
            </div>
          )}

          <div style={{ fontSize:9, color:C.dim, fontFamily:C.mono, marginBottom:4 }}>
            RESTING LIQUIDITY · price {px?.toFixed(inst?.dec ?? 5)}
          </div>
          {pools.length === 0 && <Empty>No clusters found.</Empty>}
          {pools.map((p, i) => (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:6, padding:'2px 0', fontFamily:C.mono }}>
              <span style={{ fontSize:10, color: p.below ? C.bad : C.good, width:14, flexShrink:0 }}>{p.below ? '▼' : '▲'}</span>
              <span style={{ fontSize:10, color:C.txt, width:62, flexShrink:0 }}>{p.price.toFixed(inst?.dec ?? 5)}</span>
              <div style={{ flex:1, height:9, background:'#131c26', borderRadius:2, overflow:'hidden' }}>
                <div style={{ width:`${Math.max(4, p.rel*100)}%`, height:'100%',
                  background: p.below ? 'linear-gradient(90deg,#ef444488,#ef4444)' : 'linear-gradient(90deg,#22c55e88,#22c55e)' }}/>
              </div>
              <span style={{ fontSize:9, color:C.dim, width:34, textAlign:'right', flexShrink:0 }}>{p.pct}%</span>
              <span style={{ fontSize:9, color:'#334155', width:42, textAlign:'right', flexShrink:0 }}>
                {p.distPct > 0 ? '+' : ''}{p.distPct}%
              </span>
            </div>
          ))}
          <div style={{ fontSize:8, color:'#334155', fontFamily:C.mono, marginTop:6, lineHeight:1.5 }}>
            ▼ sell-side pools below price · ▲ buy-side above. Ranked by size and closeness.
            This is where stops rest — not a prediction that they get taken.
          </div>
        </>
      )}
    </Panel>
  );
}

// ── POSITIONING — metals, energies, indices, FX ───────────────────────────────
const GROUP_LABEL = { metal:'METALS', energy:'ENERGY', index:'INDICES', fx:'FX' };

const STATE_TXT = { '3y-high':'3Y HIGH', 'elevated':'ELEVATED', '3y-low':'3Y LOW', 'depressed':'DEPRESSED' };

function Positioning({ rows, busy }) {
  const ok = rows.filter(r => !r.failed);
  const failed = rows.filter(r => r.failed);
  const byGroup = ['metal','energy','index','fx']
    .map(g => ({ g, items: ok.filter(r => r.group === g) }))
    .filter(x => x.items.length);

  const stateCol = s => s === '3y-high' ? C.bad : s === '3y-low' ? C.good
                      : s === 'elevated' || s === 'depressed' ? C.warn : C.dim;

  return (
    <Panel title="POSITIONING" right="CFTC · 3yr percentile">
      {busy && !rows.length && <Empty>loading institutional positioning…</Empty>}
      {!busy && !rows.length && <Empty>CFTC unavailable right now.</Empty>}

      {byGroup.map(({ g, items }) => (
        <div key={g} style={{ marginBottom:7 }}>
          <div style={{ fontSize:8, color:'#334155', fontFamily:C.mono, letterSpacing:'1px', marginBottom:2 }}>
            {GROUP_LABEL[g]}
          </div>
          {items.map(r => (
            <div key={r.key} style={{ display:'flex', alignItems:'center', gap:5, padding:'2px 0', fontFamily:C.mono }}>
              <span style={{ fontSize:10, color:C.txt, width:56, flexShrink:0, fontWeight:700 }}>{r.label}</span>
              <span style={{ fontSize:9, width:52, flexShrink:0, textAlign:'right',
                color: r.net > 0 ? C.good : C.bad }}>
                {r.net > 0 ? '+' : ''}{Math.round(r.net/1000)}k
              </span>
              <span style={{ fontSize:9, width:44, flexShrink:0, textAlign:'right',
                color: r.change == null ? '#334155' : r.change > 0 ? C.good : C.bad }}>
                {r.change == null ? '—' : `${r.change > 0 ? '+' : ''}${Math.round(r.change/1000)}k`}
              </span>
              {/* percentile bar — only drawn when there is enough history to rank */}
              <div style={{ flex:1, height:9, background:'#131c26', borderRadius:2, overflow:'hidden', position:'relative' }}>
                {r.enough && (
                  <div style={{ width:`${r.pct ?? 0}%`, height:'100%',
                    background: r.pct >= 90 ? '#ef4444' : r.pct <= 10 ? '#22c55e'
                              : r.pct >= 75 || r.pct <= 25 ? '#f59e0b' : '#334155' }}/>
                )}
              </div>
              <span style={{ fontSize:9, color: r.enough ? C.dim : '#334155', width:30, textAlign:'right', flexShrink:0 }}>
                {r.enough ? `${r.pct}%` : '—'}
              </span>
              <span style={{ fontSize:8, fontWeight:800, color: r.enough ? stateCol(r.state) : '#f59e0b',
                width:58, textAlign:'right', flexShrink:0 }}>
                {r.enough ? (STATE_TXT[r.state] || '') : `n=${r.weeks} THIN`}
              </span>
            </div>
          ))}
        </div>
      ))}

      {failed.length > 0 && (
        <div style={{ fontSize:9, color:C.warn, fontFamily:C.mono, marginTop:4, lineHeight:1.5 }}>
          No CFTC data returned for: {failed.map(f => f.label).join(', ')} — contract code may have changed.
        </div>
      )}
      {ok.length > 0 && (
        <div style={{ fontSize:8, color:'#334155', fontFamily:C.mono, marginTop:4, lineHeight:1.5 }}>
          Net fund position, weekly change, and where it sits in its own 3-year range.
          3Y HIGH = top decile of its history, 3Y LOW = bottom. Rows marked THIN returned under {ok[0].minWeeks}
          weeks of history — the reading is shown but not ranked, because a percentile from a handful of points
          is noise. Weekly report ({(ok[0].date || '').slice(0,10)}) — positioning, not timing.
        </div>
      )}
    </Panel>
  );
}

// ── SPREAD STRESS ─────────────────────────────────────────────────────────────
function SpreadStress({ rows, busy, hasOanda }) {
  const col = s => s === 'blown' ? C.bad : s === 'wide' ? C.warn : s === 'tight' ? C.good : C.dim;
  return (
    <Panel title="SPREAD STRESS" right="oanda · M5 vs own median">
      {!hasOanda && <Empty>Needs a connected OANDA key.</Empty>}
      {hasOanda && busy && !rows.length && <Empty>measuring spreads…</Empty>}
      {hasOanda && !busy && !rows.length && <Empty>No bid/ask data returned.</Empty>}
      {rows.map(r => (
        <div key={r.sym} style={{ display:'flex', alignItems:'center', gap:6, padding:'2px 0', fontFamily:C.mono }}>
          <span style={{ fontSize:10, color:C.txt, width:60, flexShrink:0, fontWeight:700 }}>{r.sym}</span>
          <span style={{ fontSize:9, color:C.dim, width:56, flexShrink:0, textAlign:'right' }}>{r.bps} bp</span>
          <div style={{ flex:1, height:9, background:'#131c26', borderRadius:2, overflow:'hidden' }}>
            <div style={{ width:`${Math.min(100, (r.ratio/4)*100)}%`, height:'100%',
              background: r.ratio >= 3 ? '#ef4444' : r.ratio >= 1.8 ? '#f59e0b' : '#334155' }}/>
          </div>
          <span style={{ fontSize:9, color:col(r.state), width:38, textAlign:'right', flexShrink:0, fontWeight:700 }}>
            ×{r.ratio}
          </span>
          <span style={{ fontSize:8, fontWeight:800, color:col(r.state), width:46, textAlign:'right', flexShrink:0 }}>
            {r.state === 'normal' ? '' : r.state.toUpperCase()}
          </span>
        </div>
      ))}
      {rows.length > 0 && (
        <div style={{ fontSize:8, color:'#334155', fontFamily:C.mono, marginTop:6, lineHeight:1.5 }}>
          Current spread against this instrument's own median. ×3 or more = blown out: thin liquidity,
          worse fills, stops taken at prices you did not expect. This is the cost of trading right now.
        </div>
      )}
    </Panel>
  );
}

// ── 2. SQUEEZE RADAR ──────────────────────────────────────────────────────────
function SqueezeRadar({ rows, busy }) {
  const col = s => s?.includes('squeeze') ? C.bad : s?.includes('crowded') ? C.warn : C.dim;
  return (
    <Panel title="SQUEEZE RADAR" right="binance perps">
      {busy && !rows.length && <Empty>loading funding & open interest…</Empty>}
      {!busy && !rows.length && <Empty>Derivatives data unavailable (Binance futures endpoint blocked or offline).</Empty>}
      {rows.map(r => (
        <div key={r.symbol} style={{ display:'flex', alignItems:'center', gap:6, padding:'3px 0',
          borderBottom:`1px solid #0e161e`, fontFamily:C.mono }}>
          <span style={{ fontSize:10, color:C.txt, width:46, flexShrink:0, fontWeight:700 }}>{r.symbol.replace('USDT','')}</span>
          <span style={{ fontSize:10, width:56, flexShrink:0, textAlign:'right',
            color: r.funding > 0 ? C.good : r.funding < 0 ? C.bad : C.dim }}>
            {r.fundingAnnual != null ? `${r.fundingAnnual > 0 ? '+' : ''}${r.fundingAnnual}%` : '—'}
          </span>
          <span style={{ fontSize:9, color:C.dim, width:52, flexShrink:0, textAlign:'right' }}>
            OI {r.oiChangePct != null ? `${r.oiChangePct > 0 ? '↑' : '↓'}${Math.abs(r.oiChangePct)}%` : '—'}
          </span>
          <span style={{ fontSize:9, color:C.dim, width:40, flexShrink:0, textAlign:'right' }}>
            {r.longShortRatio != null ? `${r.longShortRatio.toFixed(2)}` : '—'}
          </span>
          <span style={{ fontSize:9, fontWeight:800, color:col(r.state), flex:1, textAlign:'right' }}>
            {r.state === 'neutral' ? '' : r.state.replace(/-/g,' ').toUpperCase()}
          </span>
        </div>
      ))}
      <div style={{ fontSize:8, color:'#334155', fontFamily:C.mono, marginTop:6, lineHeight:1.5 }}>
        Funding shown annualised. Positive = longs paying shorts to hold. Large + rising OI = crowd still building.
        L/S = global long/short account ratio.
      </div>
    </Panel>
  );
}

// ── 3. SMART vs DUMB ──────────────────────────────────────────────────────────
function SmartDumb({ rows, busy }) {
  return (
    <Panel title="SMART vs DUMB" right="COT × retail book">
      {busy && !rows.length && <Empty>loading COT and retail books…</Empty>}
      {!busy && !rows.length && <Empty>Needs both a connected OANDA key (retail book) and CFTC data.</Empty>}
      {rows.map(r => (
        <div key={r.ccy} style={{ display:'flex', alignItems:'center', gap:6, padding:'3px 0',
          borderBottom:'1px solid #0e161e', fontFamily:C.mono }}>
          <span style={{ fontSize:10, color:C.txt, width:34, flexShrink:0, fontWeight:700 }}>{r.ccy}</span>
          <span style={{ fontSize:9, width:74, flexShrink:0, color: r.instLong ? C.good : C.bad }}>
            inst {r.instNet > 0 ? '+' : ''}{(r.instNet/1000).toFixed(0)}k
          </span>
          <span style={{ fontSize:9, width:78, flexShrink:0, color: r.retailLong ? C.good : C.bad }}>
            retail {r.retailLongPct}% {r.retailLong ? 'L' : 'S'}
          </span>
          <span style={{ fontSize:9, fontWeight:800, flex:1, textAlign:'right',
            color: r.strength === 'strong' ? C.warn : r.strength === 'mild' ? C.dim : '#334155' }}>
            {r.strength === 'strong' ? '⚠ OPPOSITE + CROWDED' : r.strength === 'mild' ? 'opposite' : 'aligned'}
          </span>
        </div>
      ))}
      <div style={{ fontSize:8, color:'#334155', fontFamily:C.mono, marginTop:6, lineHeight:1.5 }}>
        Institutions (CFTC non-commercial net, weekly) against retail (OANDA client book, live).
        Disagreement is a fact about positioning — it is not a signal to trade.
      </div>
    </Panel>
  );
}

// ── 4. ORDER FLOW ─────────────────────────────────────────────────────────────
function OrderFlow({ rows, busy }) {
  return (
    <Panel title="AGGRESSIVE FLOW" right="taker buy % · 24h">
      {busy && !rows.length && <Empty>loading taker flow…</Empty>}
      {rows.map(r => {
        const c = r.buyPct >= 55 ? C.good : r.buyPct <= 45 ? C.bad : C.dim;
        return (
          <div key={r.symbol} style={{ display:'flex', alignItems:'center', gap:6, padding:'3px 0', fontFamily:C.mono }}>
            <span style={{ fontSize:10, color:C.txt, width:46, flexShrink:0, fontWeight:700 }}>{r.symbol.replace('USDT','')}</span>
            <div style={{ flex:1, height:9, background:'#131c26', borderRadius:2, overflow:'hidden', display:'flex' }}>
              <div style={{ width:`${r.buyPct}%`, background:'#22c55e88' }}/>
              <div style={{ width:`${100-r.buyPct}%`, background:'#ef444488' }}/>
            </div>
            <span style={{ fontSize:9, color:c, width:46, textAlign:'right', flexShrink:0, fontWeight:700 }}>{r.buyPct}% buy</span>
          </div>
        );
      })}
      <div style={{ fontSize:8, color:'#334155', fontFamily:C.mono, marginTop:6, lineHeight:1.5 }}>
        Share of volume executed by market BUY orders — who is lifting offers vs hitting bids.
        Above 55% = aggressive buying dominates.
      </div>
    </Panel>
  );
}

// ── 5. CORRELATION BREAKS ─────────────────────────────────────────────────────
function CorrelBreaks({ rows, busy }) {
  const col = s => s === 'broken' ? C.bad : s === 'decoupled' ? C.warn : C.dim;
  return (
    <Panel title="CORRELATION BREAKS" right="H1 · last 100 bars">
      {busy && !rows.length && <Empty>computing…</Empty>}
      {!busy && !rows.length && <Empty>Needs OANDA candles.</Empty>}
      {rows.map(r => (
        <div key={r.label} style={{ display:'flex', alignItems:'center', gap:8, padding:'3px 0', fontFamily:C.mono }}>
          <span style={{ fontSize:10, color:C.txt, flex:1 }}>{r.label}</span>
          <span style={{ fontSize:10, color: r.corr > 0 ? C.good : C.bad, width:44, textAlign:'right' }}>
            {r.corr > 0 ? '+' : ''}{r.corr}
          </span>
          <span style={{ fontSize:9, color:'#334155', width:56, textAlign:'right' }}>
            usually {r.expect > 0 ? '+' : '−'}
          </span>
          <span style={{ fontSize:9, fontWeight:800, color:col(r.status), width:74, textAlign:'right' }}>
            {r.status.toUpperCase()}
          </span>
        </div>
      ))}
      <div style={{ fontSize:8, color:'#334155', fontFamily:C.mono, marginTop:6, lineHeight:1.5 }}>
        BROKEN = the relationship has inverted against its normal direction. Structural, not directional.
      </div>
    </Panel>
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
export default function FlowTerminal() {
  const [sym,      setSym]      = useState('BTCUSDT');
  const [books,    setBooks]    = useState({});
  const [squeeze,  setSqueeze]  = useState([]);
  const [flow,     setFlow]     = useState([]);
  const [sd,       setSd]       = useState([]);
  const [correl,   setCorrel]   = useState([]);
  const [busy,     setBusy]     = useState(false);
  const [updated,  setUpdated]  = useState(null);
  const [err,      setErr]      = useState('');
  const [bookFail, setBookFail] = useState(null);
  const [probe,    setProbe]    = useState(null);
  const [probing,  setProbing]  = useState(false);
  const [depth,    setDepth]    = useState({});
  const [posn,     setPosn]     = useState([]);
  const [spreads,  setSpreads]  = useState([]);
  const started = useRef(false);

  const hasOanda = !!oandaCreds()?.apiKey;

  const runProbe = useCallback(async () => {
    setProbing(true);
    try { setProbe(await probeOanda(BOOK_INSTRUMENTS.find(i => i.sym === sym)?.oanda || 'EUR_USD')); }
    catch (e) { setErr('probe failed: ' + e.message); }
    setProbing(false);
  }, [sym]);

  const loadBook = useCallback(async (s) => {
    if (DEPTH_SYMBOLS.includes(s)) {
      try {
        const dm = await fetchDepthMap(s);
        setDepth(prev => ({ ...prev, [s]: dm }));
      } catch {
        setDepth(prev => { const n = { ...prev }; delete n[s]; return n; });
      }
      return;
    }
    const inst = BOOK_INSTRUMENTS.find(i => i.sym === s);
    if (!inst) return;
    try {
      const pb = await fetchPositionBook(inst.oanda);
      setBooks(prev => ({ ...prev, [s]: { book: pb, pools: liquidityPools(pb), bias: retailBias(pb) } }));
      setBookFail(null);
    } catch (e) {
      setBooks(prev => { const n = { ...prev }; delete n[s]; return n; });
      setBookFail({ code: e.code, status: e.status, env: e.env, message: e.message });
    }
  }, []);

  const loadAll = useCallback(async () => {
    setBusy(true); setErr('');

    // Crypto derivatives + aggressive flow (no key needed). Started here so it
    // runs alongside the OANDA work, but awaited before clearing `busy` —
    // otherwise the panels flash "unavailable" while still loading.
    const cryptoDone = (async () => {
      const sq = await Promise.allSettled(SQUEEZE_SYMBOLS.map(fetchSqueeze));
      setSqueeze(sq.filter(x => x.status === 'fulfilled' && x.value).map(x => x.value));
      const fl = await Promise.allSettled(SQUEEZE_SYMBOLS.slice(0, 4).map(s => fetchTakerFlow(s)));
      setFlow(fl.filter(x => x.status === 'fulfilled' && x.value).map(x => x.value));
    })();

    // The markets actually traded here: institutional positioning (all of them)
    // and live spread stress (all of them). Independent of the refused book.
    const posnDone = (async () => {
      const r = await Promise.allSettled(POSITION_MARKETS.map(m => fetchPositioning(m)));
      // keep failures so the panel can name what is missing instead of hiding it
      setPosn(r.map((x, i) => x.status === 'fulfilled' && x.value ? x.value : { ...POSITION_MARKETS[i], failed:true, weeks:0 }));
    })();
    const spreadDone = hasOanda ? (async () => {
      const r = await Promise.allSettled(SPREAD_INSTRUMENTS.map(fetchSpreadStress));
      setSpreads(r.filter(x => x.status === 'fulfilled' && x.value).map(x => x.value));
    })() : Promise.resolve();

    await loadBook(sym);

    // Smart vs Dumb — needs both a COT net and a retail book per currency
    if (hasOanda) {
      const map = [
        { ccy:'EUR', code:COT_CODES.EUR, book:'EUR_USD', sym:'EUR/USD' },
        { ccy:'GBP', code:COT_CODES.GBP, book:'GBP_USD', sym:'GBP/USD' },
        { ccy:'AUD', code:COT_CODES.AUD, book:'AUD_USD', sym:'AUD/USD' },
        { ccy:'XAU', code:COT_CODES.XAU, book:'XAU_USD', sym:'XAU/USD' },
      ];
      const out = [];
      for (const m of map) {
        try {
          const [cot, pb] = await Promise.all([fetchCOTNet(m.code), fetchPositionBook(m.book)]);
          const r = smartVsDumb(m.ccy, cot, retailBias(pb));
          if (r) out.push(r);
        } catch { /* skip this currency */ }
      }
      setSd(out);

      // Correlation breaks from H1 candles
      try {
        const c = oandaCreds();
        const b = c.practice === false ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3';
        const get = async instr => {
          const r = await fetch(`${b}/instruments/${instr}/candles?granularity=H1&count=100&price=M`,
            { headers:{Authorization:`Bearer ${c.apiKey}`}, signal:AbortSignal.timeout(15000) });
          if (!r.ok) return null;
          const d = await r.json();
          return (d.candles||[]).filter(x=>x.complete).map(x=>({ c:+x.mid.c }));
        };
        const need = { 'XAU/USD':'XAU_USD','XAG/USD':'XAG_USD','EUR/USD':'EUR_USD','GBP/USD':'GBP_USD',
                       'AUD/USD':'AUD_USD','NZD/USD':'NZD_USD','DXY':'USD_CHF' };  // USD proxy
        const series = {};
        await Promise.all(Object.entries(need).map(async ([k, v]) => { series[k] = await get(v); }));
        const rows = CORREL_PAIRS.map(p => {
          const A = series[p.a], B = series[p.b];
          if (!A?.length || !B?.length) return null;
          return correlationBreak(p.label, p.expect, pearson(returnsOf(A), returnsOf(B)));
        }).filter(Boolean);
        setCorrel(rows);
      } catch { /* correlation is optional */ }
    }

    await Promise.all([cryptoDone, posnDone, spreadDone].map(p => p.catch(() => {})));
    setUpdated(new Date());
    setBusy(false);
  }, [sym, hasOanda, loadBook]);

  useEffect(() => { if (!started.current) { started.current = true; loadAll(); } }, [loadAll]);
  useEffect(() => { if (started.current) loadBook(sym); }, [sym, loadBook]);

  return (
    <div style={{ background:C.bg, minHeight:'100vh', paddingBottom:80, fontFamily:C.mono }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 11px',
        borderBottom:`1px solid ${C.line}`, position:'sticky', top:0, background:C.bg, zIndex:5 }}>
        <span style={{ fontSize:14, fontWeight:900, color:C.accent, letterSpacing:'2px' }}>FLOW</span>
        <span style={{ fontSize:9, color:C.dim }}>positioning x-ray</span>
        <span style={{ marginLeft:'auto', fontSize:9, color:C.dim }}>
          {busy ? 'loading…' : updated ? `upd ${updated.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : ''}
        </span>
        <button onClick={loadAll} disabled={busy}
          style={{ fontSize:10, fontWeight:800, padding:'3px 9px', borderRadius:3, cursor:busy?'default':'pointer',
            border:`1px solid ${C.accent}44`, background:'#00d4aa15', color:C.accent }}>↻</button>
      </div>

      {!hasOanda && (
        <div style={{ margin:'9px 11px', padding:'8px 10px', borderRadius:4, background:'#f59e0b10',
          border:'1px solid #f59e0b33', fontSize:10, color:C.warn, lineHeight:1.6 }}>
          OANDA not connected — the liquidity map, retail book and correlation panels need it.
          Crypto squeeze and flow panels work without a key.
        </div>
      )}
      {err && (
        <div style={{ margin:'9px 11px', padding:'7px 10px', borderRadius:4, background:'#450a0a',
          border:'1px solid #7f1d1d', fontSize:10, color:'#fca5a5' }}>{err}</div>
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:9, padding:'9px 11px' }}>
        <Positioning rows={posn} busy={busy}/>
        <SpreadStress rows={spreads} busy={busy} hasOanda={hasOanda}/>
        <CorrelBreaks rows={correl} busy={busy}/>
        <LiquidityMap sym={sym} setSym={setSym} data={books} depth={depth} busy={busy} fail={bookFail}
          probe={probe} probing={probing} onProbe={runProbe}/>
        <SqueezeRadar rows={squeeze} busy={busy}/>
        <OrderFlow rows={flow} busy={busy}/>
        <SmartDumb rows={sd} busy={busy}/>
      </div>

      <div style={{ padding:'4px 13px 20px', fontSize:9, color:'#2b3644', lineHeight:1.6 }}>
        Every number here describes positioning as it is right now. Nothing on this screen forecasts price.
      </div>
    </div>
  );
}

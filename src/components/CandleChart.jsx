import { useState, useMemo, useRef, useEffect } from 'react';
import { generateCandles } from '../utils/generateCandles';
import { detectCandlePatterns } from '../utils/candlePatterns';
import { analyzeSMC } from '../utils/smcAnalysis';
import { OANDA_MAP } from '../hooks/useLivePrices';

const TIMEFRAMES = ['1M','2M','3M','5M','15M','30M','1H','2H','4H','8H','D','W'];

// Our TF codes → OANDA granularity (OANDA has no M3 — use M4 as closest)
const TF_GRAN = {
  '1M':'M1','2M':'M2','3M':'M4','5M':'M5','15M':'M15','30M':'M30',
  '1H':'H1','2H':'H2','4H':'H4','8H':'H8','D':'D','W':'W',
};

function loadOandaCreds() {
  const envSet = localStorage.getItem('oanda_env');
  const freshPractice = envSet !== null ? envSet !== 'live' : undefined;
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds'));
    if (c?.apiKey) return { ...c, practice: freshPractice !== undefined ? freshPractice : c.practice };
  } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  return apiKey ? { apiKey, practice: freshPractice !== undefined ? freshPractice : true } : null;
}

async function fetchOandaCandles(symbol, tf, apiKey, practice) {
  const instrument = OANDA_MAP[symbol];
  if (!instrument) return null;
  const gran = TF_GRAN[tf] || 'H1';
  const base = practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
  const res  = await fetch(
    `${base}/instruments/${instrument}/candles?count=100&granularity=${gran}&price=M`,
    { headers: { 'Authorization': `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return (data.candles || [])
    .filter(c => c.complete !== false || data.candles.indexOf(c) === data.candles.length - 1)
    .map(c => ({
      t: new Date(c.time).getTime(),
      o: parseFloat(c.mid.o), h: parseFloat(c.mid.h),
      l: parseFloat(c.mid.l), c: parseFloat(c.mid.c),
      v: c.volume || 1,
    }));
}

const PAT_COLOR = { bullish:'#22c55e', bearish:'#ef4444', neutral:'#94a3b8' };
const STR_OP    = { strong:1, medium:0.75, weak:0.5 };

function fmt(v) {
  if (v == null) return '—';
  if (v >= 10000) return v.toFixed(0);
  if (v >= 100)   return v.toFixed(2);
  if (v >= 1)     return v.toFixed(4);
  return v.toFixed(5);
}
function fmtTime(ts, tf) {
  const d = new Date(ts);
  if (tf === 'W' || tf === 'D') return d.toLocaleDateString([], { month:'short', day:'numeric' });
  return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

const OVERLAYS = [
  { key:'ob',  label:'OB',  title:'Order Blocks',        color:'#a78bfa' },
  { key:'fvg', label:'FVG', title:'Fair Value Gaps',      color:'#60a5fa' },
  { key:'liq', label:'LIQ', title:'Liquidity Pools',      color:'#f59e0b' },
  { key:'bos', label:'BOS', title:'BOS / CHoCH',          color:'#22c55e' },
  { key:'sr',  label:'S&R', title:'Support & Resistance', color:'#00d4aa' },
  { key:'tl',  label:'TL',  title:'Trendlines',           color:'#fb923c' },
];

export default function CandleChart({ instrument, onClose }) {
  const [tf, setTf]           = useState('1H');
  const [hover, setHover]     = useState(null);
  const [tab, setTab]         = useState('patterns');
  const [ov, setOv]           = useState({ ob:true, fvg:true, liq:true, bos:true, sr:true, tl:true });
  const [candles, setCandles] = useState(() => generateCandles(instrument, '1H', 100));
  const [isLive,  setIsLive]  = useState(false);
  const [loadingC, setLoadingC] = useState(false);
  const svgRef                = useRef(null);

  const toggleOv = k => setOv(o => ({ ...o, [k]: !o[k] }));

  // Load candles: try OANDA first, fall back to generated
  useEffect(() => {
    let cancelled = false;
    const creds = loadOandaCreds();
    setLoadingC(true);
    (async () => {
      if (creds?.apiKey) {
        try {
          const live = await fetchOandaCandles(instrument.symbol, tf, creds.apiKey, creds.practice);
          if (!cancelled && live && live.length >= 10) {
            setCandles(live); setIsLive(true); setLoadingC(false); return;
          }
        } catch { /* fall through */ }
      }
      if (!cancelled) {
        setCandles(generateCandles(instrument, tf, 100));
        setIsLive(false); setLoadingC(false);
      }
    })();
    return () => { cancelled = true; };
  }, [instrument, tf]);
  const patterns = useMemo(() => detectCandlePatterns(candles, 12), [candles]);
  const smc      = useMemo(() => analyzeSMC(candles), [candles]);

  // ── dimensions ────────────────────────────────────────────────────────────
  const W=860, H=340, VOL_H=55, PAD={ top:12, right:68, bottom:22, left:6 };
  const chartH = H - VOL_H - 8;

  const priceMin = Math.min(...candles.map(c => c.l));
  const priceMax = Math.max(...candles.map(c => c.h));
  const priceRng = priceMax - priceMin || 1;
  const volMax   = Math.max(...candles.map(c => c.v)) || 1;

  const cw    = (W - PAD.left - PAD.right) / candles.length;
  const bodyW = Math.max(1, cw * 0.68);

  const py = p  => PAD.top + chartH - ((p - priceMin) / priceRng) * chartH;
  const cx = i  => PAD.left + i * cw + cw / 2;
  const vy = v  => H - PAD.bottom - (v / volMax) * VOL_H;

  const grid = useMemo(() => {
    const s = 5;
    return Array.from({ length: s + 1 }, (_, i) => priceMin + (priceRng / s) * i);
  }, [priceMin, priceRng]);

  const patMap = useMemo(() => {
    const m = {};
    patterns.forEach(p => {
      const idx = candles.length - 1 - p.candlesAgo;
      if (!m[idx]) m[idx] = [];
      m[idx].push(p);
    });
    return m;
  }, [patterns, candles.length]);

  const onMouseMove = e => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const i = Math.floor((e.clientX - r.left - PAD.left) / cw);
    if (i >= 0 && i < candles.length) setHover(i);
  };

  const hc = hover !== null ? candles[hover] : candles[candles.length - 1];
  const n  = candles.length;

  // near-price alerts
  const nearSR = smc.supportResistance.filter(l => l.isNear);
  const nearTL = smc.trendlines.filter(t => t.isNear);
  const alerts = nearSR.length + nearTL.length;

  const smcCount = smc.orderBlocks.length + smc.fvgs.length + smc.bosChoch.length;
  const srCount  = smc.supportResistance.length + smc.trendlines.length;

  return (
    <div className="cc-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="cc-box">

        {/* ── row 1: symbol + ohlcv + close ─────────────────────────────── */}
        <div className="cc-head">
          <div className="cc-head-left">
            <span className="cc-sym">{instrument.symbol}</span>
            <span className="cc-meta">{instrument.assetType} · {instrument.category}</span>
            {loadingC
              ? <span className="cc-data-badge loading">⟳ Loading…</span>
              : isLive
                ? <span className="cc-data-badge live">● OANDA LIVE</span>
                : <span className="cc-data-badge sim">~ Simulated</span>
            }
            {smc.premiumDiscount && (
              <span className={`cc-zone ${smc.premiumDiscount.zone}`}>
                {smc.premiumDiscount.zone === 'premium' ? '▲ Premium' : '▼ Discount'}
              </span>
            )}
          </div>
          {hc && (
            <div className="cc-ohlcv">
              <span>O <b style={{color:'#94a3b8'}}>{fmt(hc.o)}</b></span>
              <span>H <b style={{color:'#22c55e'}}>{fmt(hc.h)}</b></span>
              <span>L <b style={{color:'#ef4444'}}>{fmt(hc.l)}</b></span>
              <span>C <b style={{color: hc.c>=hc.o ? '#22c55e':'#ef4444'}}>{fmt(hc.c)}</b></span>
              <span style={{color:'#475569'}}>Vol <b style={{color:'#94a3b8'}}>{hc.v.toLocaleString()}</b></span>
            </div>
          )}
          <button className="cc-close" onClick={onClose}>✕</button>
        </div>

        {/* ── row 2: timeframes + overlay toggles ───────────────────────── */}
        <div className="cc-toolbar">
          <div className="cc-tfs">
            {TIMEFRAMES.map(t => (
              <button key={t} className={`cc-tf ${tf===t?'active':''}`} onClick={() => setTf(t)}>{t}</button>
            ))}
          </div>
          <div className="cc-ovs">
            {OVERLAYS.map(({ key, label, title, color }) => (
              <button key={key}
                className={`cc-ov ${ov[key]?'on':''}`}
                title={title}
                style={ov[key] ? { borderColor: color+'88', color, background: color+'18' } : {}}
                onClick={() => toggleOv(key)}
              >{label}</button>
            ))}
          </div>
        </div>

        {/* ── SVG chart ─────────────────────────────────────────────────── */}
        <div className="cc-svg-wrap">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%"
            style={{ display:'block', cursor:'crosshair' }}
            onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)}>

            {/* grid */}
            {grid.map((p, i) => (
              <g key={i}>
                <line x1={PAD.left} y1={py(p)} x2={W-PAD.right} y2={py(p)} stroke="#1a2337" strokeWidth="1"/>
                <text x={W-PAD.right+4} y={py(p)+4} fill="#3d5070" fontSize="8.5" fontFamily="JetBrains Mono">{fmt(p)}</text>
              </g>
            ))}

            {/* ── SMC: Order Blocks ─────────────────────────────────────── */}
            {ov.ob && smc.orderBlocks.map((ob, i) => {
              const col = ob.type==='bullish' ? '#22c55e' : '#ef4444';
              const yT  = py(Math.max(ob.top, ob.bottom));
              const yB  = py(Math.min(ob.top, ob.bottom));
              const x0  = cx(ob.index);
              return (
                <g key={`ob${i}`}>
                  <rect x={x0} y={yT} width={W-PAD.right-x0} height={Math.max(2,yB-yT)}
                    fill={col+'14'} stroke={col+'55'} strokeWidth="1" strokeDasharray="4,2"/>
                  <text x={x0+3} y={yT+10} fill={col} fontSize="8" fontFamily="JetBrains Mono">
                    {ob.type==='bullish'?'Bull OB':'Bear OB'}
                  </text>
                </g>
              );
            })}

            {/* ── SMC: FVGs ────────────────────────────────────────────── */}
            {ov.fvg && smc.fvgs.map((fvg, i) => {
              const col = fvg.type==='bullish' ? '#60a5fa' : '#f472b6';
              const yT  = py(fvg.top);
              const yB  = py(fvg.bottom);
              return (
                <g key={`fvg${i}`}>
                  <rect x={cx(fvg.index)} y={Math.min(yT,yB)}
                    width={W-PAD.right-cx(fvg.index)} height={Math.max(2,Math.abs(yB-yT))}
                    fill={col+'16'} stroke={col+'44'} strokeWidth="0.5"/>
                  <text x={cx(fvg.index)+3} y={Math.min(yT,yB)+9} fill={col} fontSize="7.5" fontFamily="JetBrains Mono">FVG</text>
                </g>
              );
            })}

            {/* ── SMC: Liquidity ────────────────────────────────────────── */}
            {ov.liq && smc.liquidity.map((liq, i) => (
              <g key={`liq${i}`}>
                <line x1={cx(liq.index)} y1={py(liq.price)} x2={W-PAD.right} y2={py(liq.price)}
                  stroke="#f59e0b" strokeWidth="1" strokeDasharray="2,5" opacity="0.65"/>
                <text x={W-PAD.right-28} y={py(liq.price)-3} fill="#f59e0b" fontSize="7" fontFamily="JetBrains Mono">{liq.label}</text>
              </g>
            ))}

            {/* ── S&R horizontal lines ──────────────────────────────────── */}
            {ov.sr && smc.supportResistance.map((sr, i) => {
              const col = sr.type==='support' ? '#22c55e' : '#ef4444';
              return (
                <g key={`sr${i}`}>
                  <line x1={PAD.left} y1={py(sr.price)} x2={W-PAD.right} y2={py(sr.price)}
                    stroke={col} strokeWidth={sr.isNear?1.5:0.8} strokeDasharray="5,3" opacity={sr.isNear?0.9:0.45}/>
                  <text x={W-PAD.right+4} y={py(sr.price)+4} fill={col} fontSize="8" fontFamily="JetBrains Mono">
                    {sr.type==='support'?'S':'R'}{sr.touches}
                  </text>
                </g>
              );
            })}

            {/* ── Trendlines ────────────────────────────────────────────── */}
            {ov.tl && smc.trendlines.map((tl, i) => {
              const col  = tl.isBroken ? '#4b5563' : (tl.type==='support' ? '#fb923c' : '#a78bfa');
              const x1   = cx(tl.p1.index);
              const y1   = py(tl.p1.price);
              const x2   = W - PAD.right;
              const y2   = py(tl.priceAtEnd);
              return (
                <line key={`tl${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={col} strokeWidth={tl.isNear?1.8:1.2}
                  strokeDasharray={tl.isBroken?'4,4':'none'}
                  opacity={tl.isBroken?0.35:0.8}/>
              );
            })}

            {/* ── BOS / CHoCH markers ───────────────────────────────────── */}
            {ov.bos && smc.bosChoch.map((b, i) => {
              const col = b.direction==='bullish' ? '#22c55e' : '#ef4444';
              return (
                <g key={`bos${i}`}>
                  <line x1={cx(b.index)} y1={PAD.top} x2={cx(b.index)} y2={H-PAD.bottom-VOL_H}
                    stroke={col} strokeWidth="1" strokeDasharray="2,5" opacity="0.6"/>
                  <text x={cx(b.index)+3} y={PAD.top+13} fill={col} fontSize="8"
                    fontFamily="JetBrains Mono" fontWeight="700">{b.label}</text>
                </g>
              );
            })}

            {/* volume bars */}
            {candles.map((c, i) => (
              <rect key={`v${i}`} x={cx(i)-bodyW/2} y={vy(c.v)}
                width={bodyW} height={Math.max(1, H-PAD.bottom-vy(c.v))}
                fill={c.c>=c.o?'#22c55e22':'#ef444422'}/>
            ))}

            {/* vol divider */}
            <line x1={PAD.left} y1={H-PAD.bottom-VOL_H} x2={W-PAD.right} y2={H-PAD.bottom-VOL_H}
              stroke="#1a2337" strokeWidth="1" strokeDasharray="3,3"/>

            {/* candles */}
            {candles.map((c, i) => {
              const green   = c.c >= c.o;
              const col     = green ? '#22c55e' : '#ef4444';
              const bodyTop = py(Math.max(c.o, c.c));
              const bodyBot = py(Math.min(c.o, c.c));
              const bh      = Math.max(1, bodyBot - bodyTop);
              const pats    = patMap[i];
              return (
                <g key={i}>
                  {hover===i && <rect x={cx(i)-cw/2} y={PAD.top} width={cw} height={chartH} fill="#ffffff04"/>}
                  {pats && <circle cx={cx(i)} cy={py(c.h)-8} r={4} fill={PAT_COLOR[pats[0].type]} opacity={STR_OP[pats[0].strength]}/>}
                  <line x1={cx(i)} y1={py(c.h)} x2={cx(i)} y2={py(c.l)} stroke={col} strokeWidth="1"/>
                  <rect x={cx(i)-bodyW/2} y={bodyTop} width={bodyW} height={bh} fill={col} opacity={green?0.9:0.82} rx="1"/>
                  {i % Math.max(1, Math.floor(n/8)) === 0 && (
                    <text x={cx(i)} y={H-3} textAnchor="middle" fill="#2d3f58" fontSize="7.5" fontFamily="JetBrains Mono">
                      {fmtTime(c.t, tf)}
                    </text>
                  )}
                </g>
              );
            })}

            {/* crosshair */}
            {hover !== null && (
              <>
                <line x1={cx(hover)} y1={PAD.top} x2={cx(hover)} y2={H-PAD.bottom}
                  stroke="#334155" strokeWidth="1" strokeDasharray="3,3"/>
                <line x1={PAD.left} y1={py(hc.c)} x2={W-PAD.right} y2={py(hc.c)}
                  stroke="#334155" strokeWidth="1" strokeDasharray="3,3"/>
                <rect x={W-PAD.right+2} y={py(hc.c)-8} width={PAD.right-4} height={14}
                  fill={hc.c>=hc.o?'#22c55e':'#ef4444'} rx="2"/>
                <text x={W-PAD.right+4} y={py(hc.c)+3} fill="#fff" fontSize="8" fontFamily="JetBrains Mono">
                  {fmt(hc.c)}
                </text>
              </>
            )}
          </svg>
        </div>

        {/* ── analysis panel ────────────────────────────────────────────── */}
        <div className="cc-analysis">
          <div className="cc-atabs">
            <button className={`cc-atab ${tab==='patterns'?'active':''}`} onClick={() => setTab('patterns')}>
              Patterns ({patterns.length})
            </button>
            <button className={`cc-atab ${tab==='smc'?'active':''}`} onClick={() => setTab('smc')}>
              SMC ({smcCount})
            </button>
            <button className={`cc-atab ${tab==='sr'?'active':''}`} onClick={() => setTab('sr')}>
              S&amp;R + TL ({srCount})
            </button>
            {alerts > 0 && (
              <span className="cc-alert">⚡ {alerts} near price</span>
            )}
          </div>

          <div className="cc-acontent">

            {/* patterns */}
            {tab === 'patterns' && (
              patterns.length === 0
                ? <span className="cc-empty">No patterns detected</span>
                : <div className="cc-chips">
                    {patterns.map((p, i) => (
                      <div key={i} className="cc-chip"
                        style={{ borderColor: PAT_COLOR[p.type]+'55', background: PAT_COLOR[p.type]+'10' }}>
                        <span style={{ color: PAT_COLOR[p.type], fontWeight:700, fontSize:11 }}>
                          {p.type==='bullish'?'▲':p.type==='bearish'?'▼':'◆'}
                        </span>
                        <div>
                          <div style={{ fontWeight:600, fontSize:11, color:'var(--text)' }}>{p.name}</div>
                          <div style={{ fontSize:10, color:'#475569' }}>{p.signal} · {p.strength} · {p.candlesAgo}c ago</div>
                        </div>
                        <span className={`cc-dot s-${p.strength}`}/>
                      </div>
                    ))}
                  </div>
            )}

            {/* smc */}
            {tab === 'smc' && (
              smcCount === 0
                ? <span className="cc-empty">No SMC signals detected</span>
                : <div className="cc-chips">
                    {smc.orderBlocks.map((ob, i) => {
                      const col = ob.type==='bullish' ? '#22c55e' : '#ef4444';
                      return (
                        <div key={`ob${i}`} className="cc-chip" style={{ borderColor: col+'55' }}>
                          <span style={{ color:col, fontWeight:700, fontSize:10 }}>OB</span>
                          <div>
                            <div style={{ fontWeight:600, fontSize:11 }}>{ob.type==='bullish'?'Bullish':'Bearish'} Order Block</div>
                            <div style={{ fontSize:10, color:'#475569' }}>{fmt(ob.bottom)} – {fmt(ob.top)}</div>
                          </div>
                        </div>
                      );
                    })}
                    {smc.fvgs.map((fvg, i) => {
                      const col = fvg.type==='bullish' ? '#60a5fa' : '#f472b6';
                      return (
                        <div key={`fvg${i}`} className="cc-chip" style={{ borderColor: col+'55' }}>
                          <span style={{ color:col, fontWeight:700, fontSize:10 }}>FVG</span>
                          <div>
                            <div style={{ fontWeight:600, fontSize:11 }}>{fvg.type==='bullish'?'Bullish':'Bearish'} FVG</div>
                            <div style={{ fontSize:10, color:'#475569' }}>{fmt(fvg.bottom)} – {fmt(fvg.top)}</div>
                          </div>
                        </div>
                      );
                    })}
                    {smc.bosChoch.map((b, i) => {
                      const col = b.direction==='bullish' ? '#22c55e' : '#ef4444';
                      return (
                        <div key={`bos${i}`} className="cc-chip" style={{ borderColor: col+'55' }}>
                          <span style={{ color:col, fontWeight:700, fontSize:10 }}>{b.type}</span>
                          <div>
                            <div style={{ fontWeight:600, fontSize:11 }}>{b.label}</div>
                            <div style={{ fontSize:10, color:'#475569' }}>Price: {fmt(b.price)}</div>
                          </div>
                        </div>
                      );
                    })}
                    {smc.liquidity.slice(0, 4).map((liq, i) => (
                      <div key={`liq${i}`} className="cc-chip" style={{ borderColor:'#f59e0b55' }}>
                        <span style={{ color:'#f59e0b', fontWeight:700, fontSize:10 }}>LIQ</span>
                        <div>
                          <div style={{ fontWeight:600, fontSize:11 }}>{liq.label}</div>
                          <div style={{ fontSize:10, color:'#475569' }}>{fmt(liq.price)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
            )}

            {/* s&r + trendlines */}
            {tab === 'sr' && (
              srCount === 0
                ? <span className="cc-empty">No S&R levels detected</span>
                : <div className="cc-chips">
                    {smc.supportResistance.map((sr, i) => {
                      const col = sr.type==='support' ? '#22c55e' : '#ef4444';
                      return (
                        <div key={`sr${i}`} className="cc-chip"
                          style={{ borderColor: col+'55', background: sr.isNear ? col+'0e' : undefined }}>
                          <span style={{ color:col, fontWeight:700, fontSize:10 }}>{sr.type==='support'?'S':'R'}</span>
                          <div>
                            <div style={{ fontWeight:600, fontSize:11 }}>
                              {sr.type==='support'?'Support':'Resistance'} — {fmt(sr.price)}
                              {sr.isNear && <span style={{ marginLeft:5, color:'#f59e0b', fontSize:9 }}>⚡ NEAR</span>}
                            </div>
                            <div style={{ fontSize:10, color:'#475569' }}>{sr.touches} touches · {sr.proximity.toFixed(2)}% away</div>
                          </div>
                        </div>
                      );
                    })}
                    {smc.trendlines.map((tl, i) => {
                      const col = tl.isBroken ? '#6b7280' : (tl.type==='support' ? '#fb923c' : '#a78bfa');
                      return (
                        <div key={`tl${i}`} className="cc-chip" style={{ borderColor: col+'55' }}>
                          <span style={{ color:col, fontWeight:700, fontSize:10 }}>TL</span>
                          <div>
                            <div style={{ fontWeight:600, fontSize:11 }}>
                              {tl.label}
                              {tl.isBroken && <span style={{ marginLeft:5, color:'#ef4444', fontSize:9 }}>BROKEN</span>}
                              {tl.isNear && !tl.isBroken && <span style={{ marginLeft:5, color:'#f59e0b', fontSize:9 }}>⚡ NEAR</span>}
                            </div>
                            <div style={{ fontSize:10, color:'#475569' }}>
                              {fmt(tl.p1.price)} → {fmt(tl.priceAtEnd)} · {tl.proximity.toFixed(2)}% away
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
            )}

          </div>
        </div>

      </div>
    </div>
  );
}

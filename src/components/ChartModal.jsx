import { useState, useEffect, useRef } from 'react';
import { OANDA_MAP } from '../hooks/useLivePrices';
import { getIMData, PAIR_CORR, PAIR_RELEVANT } from '../utils/intermarket';
import {
  detectSR, detectTrendlines, detectFVGsAndOBs, detectSweep,
  computeSwings, detectLiqLevels,
  computeEMASeries, computeVWAP, computePOC, computeValueArea,
} from '../utils/smcHelpers';
import { detectBOSCHoCH } from '../utils/smcAnalysis';
import { findStrongReversals, getPatternN, setPatternN } from '../utils/candlePatterns';
import ChartDrawTools, { sliceVisible, maxPanOffset } from './ChartDrawTools';

const TFS    = ['M1','M5','M15','M30','H1','H2','H4','H6','H12','D','W'];
const TV_TF  = { M1:'1',M5:'5',M15:'15',M30:'30',H1:'60',H2:'120',H4:'240',H6:'360',H12:'720',D:'D',W:'W' };

// Instrument format helpers
// Indices/metals/energy have no slash (e.g. "US100") and need the real OANDA_MAP
// lookup ("NAS100_USD") — a naive slash-replace passes them through unmapped and
// OANDA rejects the bad instrument name with 400. FX pairs are in the map too, so
// prefer it always; only fall back to slash-replace for anything not mapped.
function toOandaInstr(symbol) { return OANDA_MAP[symbol] || (symbol||'').replace('/','_'); }
function toTVSymbol(symbol) {
  const s = (symbol||'').replace('/','').replace('_','');
  return `OANDA:${s}`;
}
function fmtP(v, symbol) {
  if (v == null) return '—';
  const s = symbol||'';
  if (s.startsWith('XAU')) return v.toFixed(2);
  if (/^(US|GER|JPN|AUS|UK)/.test(s)) return v.toFixed(1);
  if (s.includes('JPY')) return v.toFixed(3);
  return v.toFixed(5);
}

// oanda_env (Settings Practice/Live toggle) is the source of truth for environment —
// never trust a possibly-stale `practice` flag cached inside oanda_creds.
function getOandaCreds() {
  const envSet = localStorage.getItem('oanda_env');
  const freshPractice = envSet !== null ? envSet !== 'live' : undefined;
  let creds = null;
  try { creds = JSON.parse(localStorage.getItem('oanda_creds')); } catch {}
  if (creds?.apiKey) return { ...creds, practice: freshPractice !== undefined ? freshPractice : creds.practice };
  const apiKey = localStorage.getItem('oanda_key');
  return apiKey ? { apiKey, practice: freshPractice !== undefined ? freshPractice : true } : null;
}

// Candle fetch from OANDA
async function fetchCandles(symbol, tf, count = 500) {
  const creds = getOandaCreds();
  if (!creds?.apiKey) throw new Error('OANDA not connected — connect in the Screener first.');
  const instr = toOandaInstr(symbol);
  const base  = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
  const res   = await fetch(
    `${base}/instruments/${instr}/candles?granularity=${tf}&count=${count}&price=M`,
    { headers:{ Authorization:`Bearer ${creds.apiKey}` }, signal:AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`OANDA ${res.status}`);
  const data = await res.json();
  return (data.candles||[]).filter(c=>c.complete).map(c=>({
    t: new Date(c.time).getTime(),
    o:+c.mid.o, h:+c.mid.h, l:+c.mid.l, c:+c.mid.c, v:c.volume||1,
  }));
}

// ── SVG Chart ─────────────────────────────────────────────────────────────────
const OV_DEFS = [
  {k:'ema20', l:'EMA 20', c:'#22c55e'}, {k:'ema50',  l:'EMA 50',  c:'#f59e0b'},
  {k:'ema200',l:'EMA 200',c:'#ef4444'}, {k:'vwap',   l:'VWAP',    c:'#a78bfa'},
  {k:'poc',   l:'POC',    c:'#fbbf24'}, {k:'fvg',    l:'FVG',     c:'#00d4aa'},
  {k:'ob',    l:'OB',     c:'#22c55e'}, {k:'sr',     l:'S/R',     c:'#94a3b8'},
  {k:'tl',    l:'TL',     c:'#f59e0b'}, {k:'zones',  l:'Zones',   c:'#f59e0b'},
  {k:'sweep', l:'Sweep',  c:'#fb923c'}, {k:'swings', l:'Swings',  c:'#60a5fa'},
  {k:'liq',   l:'LIQ',    c:'#c084fc'}, {k:'bos',    l:'BOS/CoC', c:'#38bdf8'},
  {k:'fib',   l:'Auto Fib',c:'#e879f9'},{k:'vol',    l:'Volume',  c:'#64748b'},
  {k:'piv',   l:'Pivots',  c:'#e0c97a'},{k:'vah',    l:'VAH',     c:'#22c55e'},
  {k:'val',   l:'VAL',     c:'#ef4444'},{k:'strev',  l:'⚡H/SS',   c:'#22d3ee'},
];
const DEFAULT_OV = { ema20:true,ema50:true,ema200:false,vwap:true,poc:false,fvg:true,ob:true,sr:true,tl:true,zones:true,sweep:true,swings:false,liq:false,bos:true,fib:false,vol:true,piv:false,vah:false,val:false,strev:true };

function loadSavedOv() {
  try {
    const saved = JSON.parse(localStorage.getItem('chart_indicators') || 'null');
    if (saved && typeof saved === 'object') {
      return { ...DEFAULT_OV, ...saved };
    }
  } catch {}
  return DEFAULT_OV;
}

function SVGChart({ candles, symbol, ov, barCount, chartH, setupLevels, patternN, panOffset }) {
  const W    = 900;
  const H    = Math.max(240, chartH || 460);
  const VOL_H = ov.vol ? 60 : 0;
  const PL = 8, PR = 68, PT = 22;
  const PB = 28 + VOL_H;
  const pw = W - PL - PR;
  const ph = H - PT - PB;
  const VOL_Y = H - VOL_H - 20;

  if (!candles||candles.length<2) return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      style={{width:'100%',height:H,display:'block',background:'#0d1321',borderRadius:6}}>
      <text x={W/2} y={H/2} textAnchor="middle" fontSize={13} fill="#475569">No candle data</text>
    </svg>
  );

  const vis  = sliceVisible(candles, barCount, panOffset || 0);
  const nv   = vis.length;
  const minP = Math.min(...vis.map(c=>c.l));
  const maxP = Math.max(...vis.map(c=>c.h));
  const pad  = (maxP-minP)*0.06 || 1;
  const pMin = minP-pad, pMax = maxP+pad;

  const xOf = i  => PL+(i/(nv-1||1))*pw;
  const yOf = p  => PT+ph-((p-pMin)/(pMax-pMin||1))*ph;
  const cw   = Math.max(1.5, (pw/nv)*0.7);

  const si      = candles.length-nv;
  const ema20v  = ov.ema20  ? computeEMASeries(candles,  20).slice(si) : [];
  const ema50v  = ov.ema50  ? computeEMASeries(candles,  50).slice(si) : [];
  const ema200v = ov.ema200 ? computeEMASeries(candles, 200).slice(si) : [];
  const vwapV   = ov.vwap   ? computeVWAP(candles).slice(si)           : [];
  const poc     = ov.poc    ? computePOC(vis)                           : null;
  const vaData  = (ov.vah||ov.val) ? computeValueArea(vis, 60)          : null;
  const vah     = vaData?.vah ?? null;
  const val     = vaData?.val ?? null;

  const { fvgZones=[], obZones=[] } = (ov.fvg||ov.ob) ? detectFVGsAndOBs(vis) : {};
  const { supports=[], resistances=[] } = ov.sr ? detectSR(vis) : {};
  const { resistTL, supportTL } = ov.tl ? detectTrendlines(vis) : {};
  const sweep  = ov.sweep  ? detectSweep(vis)   : null;
  const { bsl=[], ssl=[] } = ov.liq ? detectLiqLevels(vis) : {};
  const swings = ov.swings ? computeSwings(vis) : null;
  const bosArr = ov.bos    ? detectBOSCHoCH(vis) : [];
  const strevs = ov.strev  ? findStrongReversals(vis, patternN || getPatternN()) : [];

  // Always compute zone boundaries (even when zones overlay is off) for the live zone badge
  const last  = vis[nv-1];
  const _rH = Math.max(...vis.map(c=>c.h)), _rL = Math.min(...vis.map(c=>c.l));
  const _range = _rH - _rL || 1;
  const _premBot = _rH - _range * 0.25;
  const _discTop = _rL + _range * 0.25;
  const liveZone = last.c >= _premBot ? 'PREMIUM'
                 : last.c <= _discTop ? 'DISCOUNT'
                 : 'EQ';
  const liveZoneColor = liveZone === 'PREMIUM' ? '#ef4444'
                      : liveZone === 'DISCOUNT' ? '#22c55e' : '#f59e0b';

  let premBot=null, discTop=null, eqTop=null, eqBot=null;
  if (ov.zones && nv >= 20) {
    const rH = _rH, rL = _rL;
    const range = _range;
    const mid = (rH + rL) / 2;
    premBot = rH - range * 0.25;
    discTop = rL + range * 0.25;
    eqTop   = mid + range * 0.1;
    eqBot   = mid - range * 0.1;
  }

  // Auto Fib: from most recent swing low to swing high (or vice versa)
  let fibLevels = [];
  if (ov.fib && nv >= 20) {
    let shIdx = 0, slIdx = 0, sh = -Infinity, sl = Infinity;
    for (let i=0;i<nv;i++) {
      if (vis[i].h > sh) { sh = vis[i].h; shIdx = i; }
      if (vis[i].l < sl) { sl = vis[i].l; slIdx = i; }
    }
    const range = sh - sl;
    const fibRatios = [[0,'0'],[0.236,'0.236'],[0.382,'0.382'],[0.5,'0.5'],[0.618,'0.618'],[0.786,'0.786'],[1,'1']];
    const bull = slIdx < shIdx; // low came first → up move
    fibLevels = fibRatios.map(([r, lbl]) => ({
      price: bull ? sh - r * range : sl + r * range,
      label: lbl,
      color: r === 0.618 ? '#e879f9' : r === 0.5 ? '#a855f7' : '#7c3aed',
      width: r === 0.618 ? 1.5 : 1,
    }));
  }

  // Volume max for scaling
  const maxVol = ov.vol ? Math.max(...vis.map(c=>c.v||1)) : 1;

  // Pivot points — use previous "session" (prior 24 candles or prior day by timestamp)
  let pivotLevels = [];
  if (ov.piv && vis.length >= 10) {
    const lastTs = vis[vis.length - 1].t;
    const prevArr = lastTs
      ? (() => {
          const d = new Date(lastTs);
          const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
          const prevStart = dayStart - 86400000;
          const day = vis.filter(c => c.t >= prevStart && c.t < dayStart);
          return day.length >= 3 ? day : vis.slice(-Math.min(vis.length, 48), -1);
        })()
      : vis.slice(-Math.min(vis.length, 48), -1);
    if (prevArr.length >= 2) {
      const pH = Math.max(...prevArr.map(c => c.h));
      const pL = Math.min(...prevArr.map(c => c.l));
      const pC = prevArr[prevArr.length - 1].c;
      const PP = (pH + pL + pC) / 3;
      const R1 = 2 * PP - pL, R2 = PP + (pH - pL);
      const S1 = 2 * PP - pH, S2 = PP - (pH - pL);
      pivotLevels = [
        { price: PP, label: 'PP', color: '#e0c97a', width: 1.5 },
        { price: R1, label: 'R1', color: '#ef4444', width: 1.1 },
        { price: R2, label: 'R2', color: '#ef4444', width: 0.8 },
        { price: S1, label: 'S1', color: '#22c55e', width: 1.1 },
        { price: S2, label: 'S2', color: '#22c55e', width: 0.8 },
      ].filter(l => l.price > pMin && l.price < pMax);
    }
  }

  function linePath(vals, color, sw=1.5, dash='') {
    const d = [];
    for (let i=0;i<nv;i++) {
      if (vals[i]==null) continue;
      d.push(`${(i===0||vals[i-1]==null)?'M':'L'}${xOf(i).toFixed(1)},${yOf(vals[i]).toFixed(1)}`);
    }
    return d.length ? <path key={color+dash} d={d.join(' ')} fill="none" stroke={color} strokeWidth={sw} strokeDasharray={dash}/> : null;
  }

  // Date labels: show ~5 evenly spaced
  const dateLabels = [];
  const step = Math.floor(nv / 5) || 1;
  for (let i=0;i<nv;i+=step) {
    const t = vis[i].t;
    if (!t) continue;
    const d = new Date(t);
    const lbl = `${d.getMonth()+1}/${d.getDate()}`;
    dateLabels.push({ x: xOf(i), lbl });
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      style={{width:'100%',height:H,display:'block',background:'#0d1321',borderRadius:6}}>

      {/* Background */}
      <rect x={PL} y={PT} width={pw} height={ph} fill="#0d1321"/>

      {/* Grid lines */}
      {[0,0.167,0.333,0.5,0.667,0.833,1].map(f=>{
        const py = PT + ph*f;
        const pr = pMax - f*(pMax-pMin);
        return <g key={f}>
          <line x1={PL} y1={py} x2={W-PR} y2={py} stroke="#1e293b" strokeWidth={f===0||f===1?0.5:0.8}/>
          <text x={W-PR+4} y={py+3.5} fontSize={7.5} fill="#475569" fontFamily="monospace">{fmtP(pr,symbol)}</text>
        </g>;
      })}

      {/* Date labels */}
      {dateLabels.map((d,i)=>(
        <text key={i} x={d.x} y={H-VOL_H-6} textAnchor="middle" fontSize={7} fill="#334155">{d.lbl}</text>
      ))}

      {/* Volume sub-panel */}
      {ov.vol && <>
        <line x1={PL} y1={VOL_Y} x2={W-PR} y2={VOL_Y} stroke="#1e293b" strokeWidth={0.8}/>
        {vis.map((c,i)=>{
          const vH = Math.max(1, ((c.v||1)/maxVol)*(VOL_H-8));
          const bull = c.c >= c.o;
          return <rect key={`v${i}`}
            x={xOf(i)-cw/2} y={VOL_Y + (VOL_H-8) - vH} width={cw} height={vH}
            fill={bull ? '#22c55e55' : '#ef444455'}/>;
        })}
      </>}

      {/* Zones: premium/discount/EQ */}
      {ov.zones && premBot && <>
        <rect x={PL} y={PT} width={pw} height={Math.max(2, yOf(premBot)-PT)}
          fill="#ef444410" stroke="#ef444430" strokeWidth={0.8}/>
        <text x={PL+5} y={PT+11} fontSize={8} fontWeight="700" fill="#ef4444bb" letterSpacing="1">PREMIUM</text>
        <line x1={PL} y1={yOf(premBot)} x2={PL+pw} y2={yOf(premBot)} stroke="#ef444455" strokeWidth={0.8} strokeDasharray="5,3"/>

        <rect x={PL} y={yOf(discTop)} width={pw} height={Math.max(2, PT+ph-yOf(discTop))}
          fill="#22c55e10" stroke="#22c55e30" strokeWidth={0.8}/>
        <text x={PL+5} y={yOf(discTop)+11} fontSize={8} fontWeight="700" fill="#22c55ebb" letterSpacing="1">DISCOUNT</text>
        <line x1={PL} y1={yOf(discTop)} x2={PL+pw} y2={yOf(discTop)} stroke="#22c55e55" strokeWidth={0.8} strokeDasharray="5,3"/>

        <rect x={PL} y={yOf(eqTop)} width={pw} height={Math.max(2, Math.abs(yOf(eqBot)-yOf(eqTop)))}
          fill="#f59e0b15" stroke="#f59e0b40" strokeWidth={0.8}/>
        <text x={PL+5} y={yOf(eqTop)+11} fontSize={8} fontWeight="700" fill="#f59e0bbb">EQ</text>
      </>}

      {/* Auto Fib */}
      {ov.fib && fibLevels.map((f,i)=>(
        <g key={`fib${i}`}>
          <line x1={PL} y1={yOf(f.price)} x2={W-PR} y2={yOf(f.price)}
            stroke={f.color} strokeWidth={f.width} strokeDasharray="3,3" opacity={0.7}/>
          <text x={W-PR+3} y={yOf(f.price)+4} fontSize={7} fill={f.color} fontFamily="monospace">{f.label}</text>
        </g>
      ))}

      {/* FVG */}
      {ov.fvg && fvgZones.map((z,i)=>z.startIdx<nv&&(
        <g key={`fvg${i}`}>
          <rect x={xOf(z.startIdx)} y={yOf(z.topPrice)}
            width={Math.max(4, pw-xOf(z.startIdx)+PL)}
            height={Math.max(2,Math.abs(yOf(z.botPrice)-yOf(z.topPrice)))}
            fill={z.type==='bullish'?'#00d4aa22':'#f4724422'}
            stroke={z.type==='bullish'?'#00d4aa88':'#f4724488'} strokeWidth={0.8} strokeDasharray="3,2"/>
          <text x={xOf(z.startIdx)+3} y={yOf(z.topPrice)-2} fontSize={7.5} fontWeight="700"
            fill={z.type==='bullish'?'#00d4aa':'#f47244'}>
            {z.type==='bullish'?'Bull FVG':'Bear FVG'}
          </text>
        </g>
      ))}

      {/* OB — fixed width box (8 candle-widths) anchored at OB candle */}
      {ov.ob && obZones.map((z,i)=>z.idx<nv&&(
        <g key={`ob${i}`}>
          <rect x={xOf(z.idx)-cw/2} y={yOf(z.topPrice)}
            width={Math.min(cw*8, pw-(xOf(z.idx)-cw/2))}
            height={Math.max(2,Math.abs(yOf(z.botPrice)-yOf(z.topPrice)))}
            fill={z.type==='bullish'?'#22c55e1e':'#ef44441e'}
            stroke={z.type==='bullish'?'#22c55e99':'#ef444499'} strokeWidth={1} rx={2}/>
          <text x={xOf(z.idx)+cw/2+2} y={yOf(z.topPrice)-2} fontSize={7.5} fontWeight="700"
            fill={z.type==='bullish'?'#22c55e':'#ef4444'}>
            {z.type==='bullish'?'Bull OB':'Bear OB'}
          </text>
        </g>
      ))}

      {/* S/R */}
      {ov.sr && <>
        {supports.map((s,i)=><g key={`s${i}`}>
          <line x1={PL} y1={yOf(s.price)} x2={W-PR} y2={yOf(s.price)} stroke="#22c55e" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.5}/>
          <text x={W-PR+3} y={yOf(s.price)+3.5} fontSize={7} fill="#22c55e88">SUP</text>
        </g>)}
        {resistances.map((r,i)=><g key={`r${i}`}>
          <line x1={PL} y1={yOf(r.price)} x2={W-PR} y2={yOf(r.price)} stroke="#ef4444" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.5}/>
          <text x={W-PR+3} y={yOf(r.price)+3.5} fontSize={7} fill="#ef444488">RES</text>
        </g>)}
      </>}

      {/* Trendlines */}
      {ov.tl && resistTL && <line x1={xOf(resistTL.x1)} y1={yOf(resistTL.y1)} x2={xOf(resistTL.x2)} y2={yOf(resistTL.y2)} stroke="#f59e0b" strokeWidth={1.2} strokeDasharray="6,3" opacity={0.75}/>}
      {ov.tl && supportTL && <line x1={xOf(supportTL.x1)} y1={yOf(supportTL.y1)} x2={xOf(supportTL.x2)} y2={yOf(supportTL.y2)} stroke="#22c55e" strokeWidth={1.2} strokeDasharray="6,3" opacity={0.75}/>}

      {/* LIQ levels */}
      {ov.liq && <>
        {bsl.map((l,i)=><g key={`bsl${i}`}><line x1={PL} y1={yOf(l.price)} x2={W-PR} y2={yOf(l.price)} stroke="#c084fc" strokeWidth={0.8} strokeDasharray="3,2" opacity={0.65}/><text x={W-PR+3} y={yOf(l.price)+3.5} fontSize={6.5} fill="#c084fc88">BSL</text></g>)}
        {ssl.map((l,i)=><g key={`ssl${i}`}><line x1={PL} y1={yOf(l.price)} x2={W-PR} y2={yOf(l.price)} stroke="#fb923c" strokeWidth={0.8} strokeDasharray="3,2" opacity={0.65}/><text x={W-PR+3} y={yOf(l.price)+3.5} fontSize={6.5} fill="#fb923c88">SSL</text></g>)}
      </>}

      {/* BOS / CHoCH */}
      {ov.bos && bosArr.map((b,i)=>b.index<nv&&(
        <g key={`bos${i}`}>
          <line x1={xOf(b.index)} y1={yOf(b.price)} x2={W-PR} y2={yOf(b.price)}
            stroke={b.direction==='bullish'?'#38bdf8':'#f472b6'} strokeWidth={1}
            strokeDasharray={b.type==='BOS'?'':'4,2'} opacity={0.85}/>
          <rect x={xOf(b.index)} y={yOf(b.price)-9} width={b.type==='BOS'?22:32} height={12}
            fill={b.direction==='bullish'?'#38bdf820':'#f472b620'}
            stroke={b.direction==='bullish'?'#38bdf855':'#f472b655'} rx={2}/>
          <text x={xOf(b.index)+3} y={yOf(b.price)+2} fontSize={7} fontWeight="700"
            fill={b.direction==='bullish'?'#38bdf8':'#f472b6'}>{b.label}</text>
        </g>
      ))}

      {/* Strong Hammer / Shooting Star (full-range sweep) */}
      {ov.strev && strevs.map(({ i, type }) => {
        const c = vis[i];
        const bull = type === 'hammer';
        const x = xOf(i);
        const col = bull ? '#22c55e' : '#ef4444';
        const my = bull ? yOf(c.l) + 6 : yOf(c.h) - 6;   // below wick / above wick
        const ty = bull ? my + 12 : my - 6;
        return (
          <g key={`strev${i}`}>
            <text x={x} y={my} fontSize={12} fontWeight="900" textAnchor="middle" fill={col}>{bull ? '▲' : '▼'}</text>
            <text x={x} y={ty} fontSize={6.5} fontWeight="700" textAnchor="middle" fill={col}>{bull ? 'SH' : 'SS'}</text>
          </g>
        );
      })}

      {/* POC */}
      {ov.poc && poc && <>
        <line x1={PL} y1={yOf(poc)} x2={W-PR} y2={yOf(poc)} stroke="#fbbf24" strokeWidth={1.2} strokeDasharray="2,2" opacity={0.85}/>
        <text x={W-PR+3} y={yOf(poc)+3.5} fontSize={7} fill="#fbbf24" fontFamily="monospace">POC</text>
      </>}

      {/* VAH / VAL */}
      {ov.vah && vah && vah > pMin && vah < pMax && <>
        <line x1={PL} y1={yOf(vah)} x2={W-PR} y2={yOf(vah)} stroke="#22c55e" strokeWidth={1.2} strokeDasharray="4,2" opacity={0.85}/>
        <text x={W-PR+3} y={yOf(vah)+3.5} fontSize={7} fill="#22c55e" fontFamily="monospace">VAH</text>
      </>}
      {ov.val && val && val > pMin && val < pMax && <>
        <line x1={PL} y1={yOf(val)} x2={W-PR} y2={yOf(val)} stroke="#ef4444" strokeWidth={1.2} strokeDasharray="4,2" opacity={0.85}/>
        <text x={W-PR+3} y={yOf(val)+3.5} fontSize={7} fill="#ef4444" fontFamily="monospace">VAL</text>
      </>}

      {/* Pivot Points */}
      {ov.piv && pivotLevels.map((p, i) => (
        <g key={`piv${i}`}>
          <line x1={PL} y1={yOf(p.price)} x2={W-PR} y2={yOf(p.price)}
            stroke={p.color} strokeWidth={p.width} strokeDasharray="6,3" opacity={0.8}/>
          <rect x={W-PR+1} y={yOf(p.price)-7} width={PR-3} height={13} fill={p.color+'33'} rx={2}/>
          <text x={W-PR+4} y={yOf(p.price)+4} fontSize={8} fontWeight="700" fill={p.color}>{p.label}</text>
        </g>
      ))}

      {/* Setup Planner levels */}
      {setupLevels && (() => {
        const sl = setupLevels;
        const isBull = sl.direction === 'LONG';
        return <>
          {sl.entry != null && sl.entry > pMin && sl.entry < pMax && <>
            <line x1={PL} y1={yOf(sl.entry)} x2={W-PR} y2={yOf(sl.entry)} stroke="#f1f5f9" strokeWidth={1.5} opacity={0.9}/>
            <rect x={W-PR+1} y={yOf(sl.entry)-7} width={PR-3} height={13} fill="#1e293b" rx={2}/>
            <text x={W-PR+4} y={yOf(sl.entry)+4} fontSize={8} fontWeight="800" fill="#f1f5f9">ENTRY</text>
          </>}
          {sl.sl != null && sl.sl > pMin && sl.sl < pMax && <>
            <line x1={PL} y1={yOf(sl.sl)} x2={W-PR} y2={yOf(sl.sl)} stroke="#ef4444" strokeWidth={1.5} opacity={0.9}/>
            <rect x={W-PR+1} y={yOf(sl.sl)-7} width={PR-3} height={13} fill="#450a0a" rx={2}/>
            <text x={W-PR+4} y={yOf(sl.sl)+4} fontSize={8} fontWeight="800" fill="#ef4444">SL</text>
          </>}
          {sl.tp1 != null && sl.tp1 > pMin && sl.tp1 < pMax && <>
            <line x1={PL} y1={yOf(sl.tp1)} x2={W-PR} y2={yOf(sl.tp1)} stroke="#22c55e" strokeWidth={1.5} opacity={0.9}/>
            <rect x={W-PR+1} y={yOf(sl.tp1)-7} width={PR-3} height={13} fill="#14532d" rx={2}/>
            <text x={W-PR+4} y={yOf(sl.tp1)+4} fontSize={8} fontWeight="800" fill="#22c55e">TP1</text>
          </>}
          {sl.tp2 != null && sl.tp2 > pMin && sl.tp2 < pMax && <>
            <line x1={PL} y1={yOf(sl.tp2)} x2={W-PR} y2={yOf(sl.tp2)} stroke="#86efac" strokeWidth={1} strokeDasharray="5,3" opacity={0.8}/>
            <rect x={W-PR+1} y={yOf(sl.tp2)-7} width={PR-3} height={13} fill="#14532d" rx={2}/>
            <text x={W-PR+4} y={yOf(sl.tp2)+4} fontSize={8} fontWeight="700" fill="#86efac">TP2</text>
          </>}
          {/* Direction badge */}
          <rect x={PL} y={PT-18} width={48} height={14} fill={isBull?'#22c55e22':'#ef444422'} stroke={isBull?'#22c55e66':'#ef444466'} rx={3}/>
          <text x={PL+24} y={PT-8} textAnchor="middle" fontSize={8} fontWeight="800" fill={isBull?'#22c55e':'#ef4444'}>{isBull?'▲ LONG':'▼ SHORT'}</text>
        </>;
      })()}

      {/* EMA / VWAP */}
      {ov.ema20  && linePath(ema20v,  '#22c55e', 1.2)}
      {ov.ema50  && linePath(ema50v,  '#f59e0b', 1.3)}
      {ov.ema200 && linePath(ema200v, '#ef4444', 1.5)}
      {ov.vwap   && linePath(vwapV,   '#a78bfa', 1.4, '5,3')}

      {/* Candles */}
      {vis.map((c,i)=>{
        const x   = xOf(i);
        const bull = c.c >= c.o;
        const col  = bull ? '#26a69a' : '#ef5350';
        const wickCol = bull ? '#26a69a' : '#ef5350';
        const bTop = yOf(Math.max(c.o,c.c));
        const bBot = yOf(Math.min(c.o,c.c));
        const bH   = Math.max(1, bBot-bTop);
        return <g key={i}>
          <line x1={x} y1={yOf(c.h)} x2={x} y2={bTop} stroke={wickCol} strokeWidth={cw>4?1.2:0.9}/>
          <line x1={x} y1={bBot} x2={x} y2={yOf(c.l)} stroke={wickCol} strokeWidth={cw>4?1.2:0.9}/>
          <rect x={x-cw/2} y={bTop} width={cw} height={bH}
            fill={bull ? '#26a69a' : '#ef5350'}
            stroke={bull ? '#1a7a72' : '#c0392b'} strokeWidth={0.4}/>
        </g>;
      })}

      {/* Sweep marker */}
      {ov.sweep && sweep && sweep.idx < nv && (
        <g>
          <polygon
            points={sweep.type==='bullish'
              ? `${xOf(sweep.idx)},${yOf(sweep.price)+14} ${xOf(sweep.idx)-5},${yOf(sweep.price)+22} ${xOf(sweep.idx)+5},${yOf(sweep.price)+22}`
              : `${xOf(sweep.idx)},${yOf(sweep.price)-14} ${xOf(sweep.idx)-5},${yOf(sweep.price)-22} ${xOf(sweep.idx)+5},${yOf(sweep.price)-22}`}
            fill={sweep.type==='bullish'?'#22c55e':'#ef4444'} opacity={0.85}/>
          <text x={xOf(sweep.idx)} y={sweep.type==='bullish'?yOf(sweep.price)+34:yOf(sweep.price)-26}
            textAnchor="middle" fontSize={7.5} fontWeight="700"
            fill={sweep.type==='bullish'?'#22c55e':'#ef4444'}>SWP</text>
        </g>
      )}

      {/* Swing labels */}
      {ov.swings && swings && <>
        {swings.mid.hs.slice(-5).map((s,i)=>s.idx<nv&&(
          <g key={`sh${i}`}>
            <line x1={xOf(s.idx)} y1={yOf(s.price)} x2={xOf(s.idx)} y2={yOf(s.price)-10} stroke="#60a5fa" strokeWidth={1}/>
            <text x={xOf(s.idx)} y={yOf(s.price)-13} textAnchor="middle" fontSize={8} fontWeight="700" fill="#60a5fa">HH</text>
          </g>
        ))}
        {swings.mid.ls.slice(-5).map((s,i)=>s.idx<nv&&(
          <g key={`sl${i}`}>
            <line x1={xOf(s.idx)} y1={yOf(s.price)} x2={xOf(s.idx)} y2={yOf(s.price)+10} stroke="#f87171" strokeWidth={1}/>
            <text x={xOf(s.idx)} y={yOf(s.price)+22} textAnchor="middle" fontSize={8} fontWeight="700" fill="#f87171">LL</text>
          </g>
        ))}
      </>}

      {/* Last price label */}
      <line x1={PL} y1={yOf(last.c)} x2={W-PR} y2={yOf(last.c)} stroke="#00d4aa" strokeWidth={0.6} strokeDasharray="3,3" opacity={0.5}/>
      <rect x={W-PR+1} y={yOf(last.c)-8} width={PR-3} height={16} fill="#00d4aa" rx={3}/>
      <text x={W-PR+PR/2-1} y={yOf(last.c)+4} textAnchor="middle" fontSize={8.5} fill="#080c14" fontWeight="800">{fmtP(last.c,symbol)}</text>

      {/* Live zone badge — always shows actual zone from real chart data */}
      <rect x={PL} y={PT-18} width={72} height={14} fill={liveZoneColor+'22'} stroke={liveZoneColor+'66'} rx={3}/>
      <text x={PL+36} y={PT-8} textAnchor="middle" fontSize={8} fontWeight="800" fill={liveZoneColor} letterSpacing="0.5">{liveZone}</text>
    </svg>
  );
}

// ── TradingView widget ─────────────────────────────────────────────────────────
function TradingViewWidget({ symbol, interval }) {
  const ref = useRef(null);
  const id  = useRef(`tv_${Math.random().toString(36).slice(2)}`);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.id = id.current; wrap.style.cssText = 'width:100%;height:100%;';
    ref.current.appendChild(wrap);
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/tv.js'; s.async = true;
    s.onload = () => {
      if (!window.TradingView || !document.getElementById(id.current)) return;
      new window.TradingView.widget({
        container_id:id.current, symbol, interval,
        theme:'dark', style:'1', locale:'en', toolbar_bg:'#0d1321',
        enable_publishing:false, allow_symbol_change:true, autosize:true,
      });
    };
    ref.current.appendChild(s);
    return () => { if (ref.current) ref.current.innerHTML = ''; };
  }, [symbol, interval]);
  return <div ref={ref} style={{width:'100%',flex:1,minHeight:480}}/>;
}

// ── Default checklist ──────────────────────────────────────────────────────────
const DEF_RULES = [
  'Price is in premium or discount zone',
  'BOS or ChoCh confirmed on this TF',
  'FVG or OB present as entry point',
  'Clear SL level identified (swing low/high)',
  'Risk/reward is at least 1:2',
  'No major news in next 2 hours',
  'Higher timeframe structure aligns',
];

// ── ChartModal ─────────────────────────────────────────────────────────────────
export default function ChartModal({ instrument, onClose, setupLevels }) {
  const symbol = instrument?.symbol || 'EUR/USD';

  const [tf,        setTf]       = useState('H4');
  const [tab,       setTab]      = useState('chart');
  const [candles,   setCandles]  = useState(null);
  const [loading,   setLoading]  = useState(false);
  const [loadErr,   setLoadErr]  = useState('');
  const [ov,        setOv]       = useState(loadSavedOv);
  const [patternN,  setPatN]     = useState(getPatternN);
  const [barCount,  setBarCount] = useState(100);
  const [panOffset, setPanOffset]= useState(0);
  const [chartH,    setChartH]   = useState(460);
  const [aiRead,    setAiRead]   = useState(null);
  const [aiRL,      setAiRL]     = useState(false);
  const [analysis,  setAnalysis] = useState('');
  const [analyLL,   setAnalyLL]  = useState(false);
  const [rules,     setRules]    = useState(DEF_RULES);
  const [newRule,   setNewRule]  = useState('');
  const [checks,    setChecks]   = useState({});
  const [imData,     setImData]     = useState(null);
  const [depthData,  setDepthData]  = useState(null);
  const [depthLoad,  setDepthLoad]  = useState(false);
  const [depthErr,   setDepthErr]   = useState('');
  const chartWrapRef = useRef(null);

  // Measure chart container — subtract 16px for the 8px padding on each side
  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight - 16;
      if (h > 80) setChartH(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fetch candles when tf or tab=chart changes
  useEffect(() => {
    if (tab !== 'chart') return;
    setLoading(true); setLoadErr(''); setCandles(null); setPanOffset(0);
    fetchCandles(symbol, tf, 500)
      .then(cs => setCandles(cs))
      .catch(e => setLoadErr(e.message))
      .finally(() => setLoading(false));
  }, [symbol, tf, tab]);

  const maxOffset = candles ? maxPanOffset(candles, barCount) : 0;
  const clampedPan = Math.min(panOffset, maxOffset);
  const panStep = Math.max(5, Math.round(barCount / 4));

  useEffect(() => {
    const oandaSym = toOandaInstr(symbol);
    getIMData(oandaSym, 'H1', 50).then(setImData).catch(() => {});
  }, [symbol]);

  useEffect(() => {
    if (tab !== 'depth') return;
    setDepthLoad(true); setDepthErr(''); setDepthData(null);
    const creds = getOandaCreds();
    if (!creds?.apiKey) { setDepthErr('Connect OANDA in the Screener first.'); setDepthLoad(false); return; }
    const instr = toOandaInstr(symbol);
    const base  = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
    const hdr   = { Authorization: `Bearer ${creds.apiKey}` };
    const tryFetch = url => fetch(url, { headers: hdr, signal: AbortSignal.timeout(10000) })
      .then(r => r.json()).catch(() => ({}));
    Promise.all([
      tryFetch(`${base}/instruments/${instr}/positionBook`),
      tryFetch(`${base}/instruments/${instr}/orderBook`),
    ]).then(([posResp, ordResp]) => {
      const pos = posResp.positionBook;
      const ord = ordResp.orderBook;
      if (!pos && !ord) {
        setDepthErr(`Position/Order book not available for ${symbol}. OANDA only provides this for major USD pairs (EUR/USD, GBP/USD, USD/JPY, etc.).`);
        setDepthLoad(false);
        return;
      }
      const posBuckets = (pos?.buckets || []).filter(b => parseFloat(b.longCountPercent||0) + parseFloat(b.shortCountPercent||0) > 0);
      const ordBuckets = (ord?.buckets || []).filter(b => parseFloat(b.longCountPercent||0) + parseFloat(b.shortCountPercent||0) > 0);
      setDepthData({
        pos: pos ? { ...pos, buckets: posBuckets } : null,
        ord: ord ? { ...ord, buckets: ordBuckets } : null,
      });
      setDepthLoad(false);
    }).catch(e => { setDepthErr(e.message); setDepthLoad(false); });
  }, [symbol, tab]);

  const toggleOv = k => setOv(o => {
    const next = { ...o, [k]: !o[k] };
    localStorage.setItem('chart_indicators', JSON.stringify(next));
    return next;
  });
  const clearAllOv  = () => { const off = Object.fromEntries(Object.keys(ov).map(k=>[k,false])); setOv(off); localStorage.setItem('chart_indicators', JSON.stringify(off)); };
  const resetOv     = () => { setOv(DEFAULT_OV); localStorage.setItem('chart_indicators', JSON.stringify(DEFAULT_OV)); };

  // AI Auto-Read (requires anthropic_key in localStorage)
  const doAutoRead = async () => {
    if (!candles?.length) return;
    setAiRL(true);
    try {
      const { supports, resistances } = detectSR(candles);
      const { fvgZones } = detectFVGsAndOBs(candles);
      const last = candles[candles.length-1];
      const prompt = `SMC Forex analyst. Pair: ${symbol}, TF: ${tf}. Last close: ${fmtP(last.c,symbol)}.
Supports: ${supports.slice(0,2).map(s=>fmtP(s.price,symbol)).join(', ')}.
Resistances: ${resistances.slice(0,2).map(r=>fmtP(r.price,symbol)).join(', ')}.
Active FVGs: ${fvgZones.map(f=>f.type).join(', ')||'none'}.
Reply ONLY with JSON: {"bias":"Bullish|Bearish|Neutral","quality":"A|B|C","entry":"${symbol.includes('JPY')?'xxx.xxx':'x.xxxxx'}","stop":"${symbol.includes('JPY')?'xxx.xxx':'x.xxxxx'}","reason":"one sentence max"}`;
      const key = localStorage.getItem('anthropic_key');
      if (!key) { setAiRead({bias:'N/A',quality:'—',entry:'—',stop:'—',reason:'Add anthropic_key to localStorage'}); setAiRL(false); return; }
      const res = await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},
        body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:180,messages:[{role:'user',content:prompt}]})
      });
      const d = await res.json();
      const text = d.content?.[0]?.text||'{}';
      const m = text.match(/\{[\s\S]*\}/);
      setAiRead(m ? JSON.parse(m[0]) : {bias:'Error',quality:'—',entry:'—',stop:'—',reason:'Parse failed'});
    } catch(e) { setAiRead({bias:'Error',quality:'—',entry:'—',stop:'—',reason:e.message}); }
    setAiRL(false);
  };

  // AI Deep Analysis
  const doAnalysis = async () => {
    if (!candles?.length) return;
    setAnalyLL(true); setAnalysis('');
    try {
      const { supports, resistances } = detectSR(candles);
      const { fvgZones, obZones } = detectFVGsAndOBs(candles);
      const sw = computeSwings(candles);
      const last = candles[candles.length-1];
      const prompt = `Perform a detailed SMC analysis for ${symbol} on ${tf} timeframe.
Last close: ${fmtP(last.c,symbol)}. Candles analysed: ${candles.length}.
Supports: ${supports.map(s=>fmtP(s.price,symbol)).join(', ')}.
Resistances: ${resistances.map(r=>fmtP(r.price,symbol)).join(', ')}.
Active FVGs: ${fvgZones.length} (${fvgZones.map(f=>f.type).join(', ')||'none'}).
Active OBs: ${obZones.length}.
ATR: ${sw?.atr?.toFixed(5)||'—'}.

Provide:
1. Market Structure (BOS/ChoCh, trend)
2. Key Zones (OBs, FVGs, premium/discount)
3. Trade Setup (direction, entry zone, invalidation)
4. Specific levels: Entry / Stop Loss / Take Profit
5. Confluence & Risk Notes`;
      const key = localStorage.getItem('anthropic_key');
      if (!key) { setAnalysis('Set anthropic_key in localStorage to use AI analysis.\n\nOpen console → localStorage.setItem("anthropic_key","sk-ant-...")'); setAnalyLL(false); return; }
      const res = await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},
        body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:700,messages:[{role:'user',content:prompt}]})
      });
      const d = await res.json();
      setAnalysis(d.content?.[0]?.text||'No response');
    } catch(e) { setAnalysis(`Error: ${e.message}`); }
    setAnalyLL(false);
  };

  const tvSym = toTVSymbol(symbol);
  const tvInt = TV_TF[tf] || '240';
  const biasColor = { bullish:'#22c55e', bearish:'#ef4444', neutral:'#94a3b8' };

  return (
    <div className="cm-overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="cm-modal">

        {/* ── Header ── */}
        <div className="cm-header">
          {/* Symbol — always visible, shrinks last */}
          <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}}>
            <span style={{fontSize:15,fontWeight:700}}>{symbol}</span>
            <span style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--mono)'}}>{tf}</span>
          </div>
          {/* Scrollable tab strip */}
          <div className="cm-tab-strip">
            {[{k:'chart',l:'📈 Chart'},{k:'tv',l:'📺 TradingView'},{k:'depth',l:'📊 Depth'},{k:'ai',l:'🤖 Analysis'},{k:'checklist',l:'✅ Checklist'}].map(t=>(
              <button key={t.k} className={`cm-tab-btn${tab===t.k?' active':''}`} onClick={()=>setTab(t.k)}>{t.l}</button>
            ))}
          </div>
          {/* Close — always pinned right, never hidden */}
          <button className="cm-close-btn" onClick={onClose} style={{flexShrink:0,marginLeft:4}}>✕</button>
        </div>

        {/* ── Chart Tab ── */}
        {tab==='chart' && (
          <div className="cm-body">
            {/* Toolbar: TF + bar count + overlays */}
            <div className="cm-toolbar">
              <div className="cm-tf-row" style={{flexWrap:'nowrap',overflowX:'auto',gap:2,scrollbarWidth:'none'}}>
                {TFS.map(t=><button key={t} className={`cm-tf-pill${tf===t?' active':''}`} onClick={()=>setTf(t)} style={{flexShrink:0}}>{t}</button>)}
                <span style={{margin:'0 4px',color:'var(--border)',alignSelf:'center',flexShrink:0}}>|</span>
                {[50,100,200,500].map(n=>(
                  <button key={n} className={`cm-tf-pill${barCount===n?' active':''}`}
                    onClick={()=>setBarCount(n)} style={{flexShrink:0,color:'var(--text3)',minWidth:32}}>
                    {n}
                  </button>
                ))}
                <span style={{fontSize:10,color:'var(--text3)',alignSelf:'center',flexShrink:0,marginLeft:2}}>bars</span>
                <span style={{margin:'0 4px',color:'var(--border)',alignSelf:'center',flexShrink:0}}>|</span>
                <button onClick={()=>setPanOffset(o=>Math.min(maxOffset,o+panStep))} disabled={clampedPan>=maxOffset}
                  title="Pan back (older candles)" style={{flexShrink:0,minWidth:26,padding:'2px 6px',borderRadius:6,
                  fontSize:12,fontWeight:800,cursor:clampedPan>=maxOffset?'not-allowed':'pointer',
                  background:'#0f172a',color:clampedPan>=maxOffset?'#334155':'#94a3b8',border:'1px solid #1e293b'}}>◀</button>
                <button onClick={()=>setPanOffset(o=>Math.max(0,o-panStep))} disabled={clampedPan<=0}
                  title="Pan forward (newer candles)" style={{flexShrink:0,minWidth:26,padding:'2px 6px',borderRadius:6,
                  fontSize:12,fontWeight:800,cursor:clampedPan<=0?'not-allowed':'pointer',
                  background:'#0f172a',color:clampedPan<=0?'#334155':'#94a3b8',border:'1px solid #1e293b'}}>▶</button>
                {clampedPan > 0 && (
                  <button onClick={()=>setPanOffset(0)} style={{flexShrink:0,padding:'2px 9px',borderRadius:6,
                    fontSize:10,fontWeight:700,cursor:'pointer',background:'#f59e0b18',color:'#f59e0b',border:'1px solid #f59e0b44'}}>
                    Live ↦
                  </button>
                )}
              </div>
              <div className="cm-ov-row">
                {OV_DEFS.map(o=>(
                  <button key={o.k} className={`cm-ov-btn${ov[o.k]?' active':''}`}
                    style={ov[o.k]?{borderColor:o.c+'66',color:o.c}:{}} onClick={()=>toggleOv(o.k)}>{o.l}</button>
                ))}
                {ov.strev && (
                  <span style={{display:'inline-flex',alignItems:'center',gap:3,flexShrink:0,alignSelf:'center',
                    background:'#22d3ee14',border:'1px solid #22d3ee44',borderRadius:6,padding:'1px 5px'}}>
                    <span style={{fontSize:9,color:'#22d3ee',fontWeight:700}}>⚡N</span>
                    <button onClick={()=>setPatN(setPatternN(patternN-1))} style={{width:18,height:18,borderRadius:4,cursor:'pointer',
                      fontSize:12,fontWeight:800,lineHeight:1,background:'#0f172a',color:'#94a3b8',border:'1px solid #1e293b'}}>−</button>
                    <span style={{fontSize:11,fontWeight:800,color:'#22d3ee',minWidth:14,textAlign:'center'}}>{patternN}</span>
                    <button onClick={()=>setPatN(setPatternN(patternN+1))} style={{width:18,height:18,borderRadius:4,cursor:'pointer',
                      fontSize:12,fontWeight:800,lineHeight:1,background:'#0f172a',color:'#94a3b8',border:'1px solid #1e293b'}}>+</button>
                  </span>
                )}
                <span style={{margin:'0 4px',color:'var(--border)',alignSelf:'center'}}>|</span>
                <button onClick={clearAllOv} style={{fontSize:10,padding:'2px 8px',borderRadius:4,cursor:'pointer',
                  background:'#ef444422',color:'#ef4444',border:'1px solid #ef444444',flexShrink:0,whiteSpace:'nowrap'}}>
                  Clear All
                </button>
                <button onClick={resetOv} style={{fontSize:10,padding:'2px 8px',borderRadius:4,cursor:'pointer',
                  background:'#8b5cf622',color:'#a78bfa',border:'1px solid #8b5cf644',flexShrink:0,whiteSpace:'nowrap'}}>
                  Reset
                </button>
              </div>
            </div>

            {/* AI Auto-Read bar */}
            <div className="cm-autoread">
              <button className="cm-autoread-btn" onClick={doAutoRead} disabled={aiRL||!candles}>
                {aiRL?'⟳ Reading…':'⚡ AI Auto-Read'}
              </button>
              {aiRead && (
                <div className="cm-autoread-result">
                  <span className="cm-bias-pill" style={{color:biasColor[aiRead.bias?.toLowerCase()]||'#94a3b8',borderColor:(biasColor[aiRead.bias?.toLowerCase()]||'#94a3b8')+'55',background:(biasColor[aiRead.bias?.toLowerCase()]||'#94a3b8')+'12'}}>
                    {aiRead.bias}
                  </span>
                  <span className="cm-ar-chip">Q: {aiRead.quality}</span>
                  <span className="cm-ar-chip">Entry: {aiRead.entry}</span>
                  <span className="cm-ar-chip">Stop: {aiRead.stop}</span>
                  <span style={{fontSize:11,color:'var(--text2)',flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{aiRead.reason}</span>
                </div>
              )}
            </div>

            {/* Correlated Markets Bar — dynamic live Pearson correlation */}
            {imData && (() => {
              const { signals, correlations } = imData;
              const oandaSym = symbol.replace('/', '_');
              // Determine which markets to show: use PAIR_RELEVANT list, else live corr > 0.2
              const relevantKeys = PAIR_RELEVANT[oandaSym]
                || Object.entries(correlations).filter(([,v]) => Math.abs(v) >= 0.2).map(([k]) => k)
                || Object.keys(PAIR_CORR[oandaSym] || {});
              if (!relevantKeys.length) return null;
              const hasLive = Object.keys(correlations).length > 0;
              return (
                <div style={{ display:'flex', gap:5, padding:'4px 8px', flexWrap:'wrap', borderBottom:'1px solid var(--border)', background:'#0a0f1a', alignItems:'center' }}>
                  <span style={{ fontSize:8, color:'#334155', flexShrink:0 }}>
                    {hasLive ? '⚡ LIVE r50' : 'STATIC'}
                  </span>
                  {relevantKeys.map(key => {
                    const sig = signals[key];
                    if (!sig) return null;
                    // Live correlation if available, else static fallback
                    const liveR   = correlations[key];
                    const staticR = (PAIR_CORR[oandaSym] || {})[key] || 0;
                    const corrVal = liveR ?? staticR;
                    const isLive  = liveR !== undefined;
                    const strength = Math.abs(corrVal); // 0-1
                    const weak    = strength < 0.3;
                    const bullish = (sig.direction === 'rising' && corrVal > 0) || (sig.direction === 'falling' && corrVal < 0);
                    const bearish = (sig.direction === 'rising' && corrVal < 0) || (sig.direction === 'falling' && corrVal > 0);
                    // Correlation strength label
                    const strengthLabel = strength >= 0.7 ? 'Strong' : strength >= 0.4 ? 'Mod' : 'Weak';
                    const strengthColor = strength >= 0.7 ? '#22c55e' : strength >= 0.4 ? '#f59e0b' : '#475569';
                    return (
                      <div key={key} style={{ display:'flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:4,
                        opacity: weak ? 0.55 : 1,
                        background: bullish ? '#14532d33' : bearish ? '#450a0a33' : '#1e293b',
                        border: `1px solid ${bullish ? '#22c55e44' : bearish ? '#ef444444' : '#334155'}` }}>
                        <span style={{ fontSize:9, fontWeight:700, color:sig.color }}>{sig.label}</span>
                        <span style={{ fontSize:9, color:sig.direction==='rising'?'#22c55e':'#ef4444' }}>
                          {sig.direction==='rising'?'↑':'↓'} {sig.pct>=0?'+':''}{sig.pct.toFixed(2)}%
                        </span>
                        {!weak && (
                          <span style={{ fontSize:9, color:bullish?'#22c55e':bearish?'#ef4444':'#64748b', fontWeight:700 }}>
                            {bullish?'▲':bearish?'▼':''}
                          </span>
                        )}
                        {/* Live correlation value */}
                        <span style={{ fontSize:8, fontFamily:'monospace', color:strengthColor }}>
                          r{corrVal>=0?'+':''}{corrVal.toFixed(2)}
                          {!isLive && <span style={{ color:'#334155' }}>*</span>}
                        </span>
                        {isLive && (
                          <span style={{ fontSize:8, color:strengthColor }}>{strengthLabel}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* Chart area */}
            <div className="cm-chart-wrap" ref={chartWrapRef}>
              {loading && <div className="cm-state">⟳ Fetching {symbol} {tf} candles…</div>}
              {loadErr && <div className="cm-state cm-err">⚠ {loadErr}</div>}
              {!loading && !loadErr && candles && (
                <div style={{ position:'relative' }}>
                  <SVGChart candles={candles} symbol={symbol} ov={ov} barCount={barCount} chartH={chartH} setupLevels={setupLevels} patternN={patternN} panOffset={clampedPan}/>
                  <ChartDrawTools candles={candles} symbol={symbol} tf={tf} ov={ov} barCount={barCount} chartH={chartH} panOffset={clampedPan} onPan={setPanOffset} maxOffset={maxOffset}/>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── TradingView Tab ── */}
        {tab==='tv' && (
          <div className="cm-body">
            <div className="cm-toolbar">
              <div className="cm-tf-row">
                {TFS.map(t=><button key={t} className={`cm-tf-pill${tf===t?' active':''}`} onClick={()=>setTf(t)}>{t}</button>)}
              </div>
              <span style={{fontSize:11,color:'var(--text3)'}}>Symbol: {tvSym}</span>
            </div>
            <div style={{flex:1,display:'flex',flexDirection:'column'}}>
              <TradingViewWidget symbol={tvSym} interval={tvInt}/>
            </div>
          </div>
        )}

        {/* ── Depth Tab (Position Book + Order Book) ── */}
        {tab==='depth' && (
          <div className="cm-body" style={{ overflowY:'auto' }}>
            {depthLoad && <div className="cm-state">⟳ Loading order &amp; position book for {symbol}…</div>}
            {depthErr  && <div className="cm-state cm-err">⚠ {depthErr}</div>}
            {!depthLoad && !depthErr && depthData && (() => {
              const pos = depthData.pos;
              const ord = depthData.ord;
              const curPrice = parseFloat(pos?.price || ord?.price || '0') || 0;
              const renderBook = (title, buckets, longKey, shortKey, color) => {
                if (!buckets?.length) return (
                  <div style={{ marginBottom:16, padding:'12px', background:'#1e293b', borderRadius:6, color:'var(--text3)', fontSize:11 }}>
                    {title} — No data available for {symbol}
                  </div>
                );
                const maxPct = Math.max(...buckets.flatMap(b => [parseFloat(b[longKey]||0), parseFloat(b[shortKey]||0)]), 0.1);
                // show 40 buckets centred around current price
                const sorted = [...buckets].sort((a,b) => parseFloat(b.price) - parseFloat(a.price));
                const midIdx = sorted.findIndex(b => parseFloat(b.price) <= curPrice);
                const start  = Math.max(0, (midIdx < 0 ? 0 : midIdx) - 20);
                const visible = sorted.slice(start, start + 40);
                return (
                  <div style={{ marginBottom:16 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:'var(--text2)', marginBottom:8 }}>{title}</div>
                    <div style={{ fontSize:9, color:'var(--text3)', marginBottom:4 }}>Current price: {fmtP(curPrice, symbol)} · {visible.length} price levels</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:1 }}>
                      {visible.map((b, i) => {
                        const lPct = parseFloat(b[longKey]  || 0);
                        const sPct = parseFloat(b[shortKey] || 0);
                        const bPrice = parseFloat(b.price);
                        const isCurrent = Math.abs(bPrice - curPrice) / (curPrice || 1) < 0.002;
                        return (
                          <div key={i} style={{ display:'flex', alignItems:'center', gap:4,
                            background: isCurrent ? '#00d4aa18' : 'transparent',
                            borderRadius: isCurrent ? 3 : 0,
                            padding:'1px 0' }}>
                            {/* Short bar (left) */}
                            <div style={{ width:100, display:'flex', justifyContent:'flex-end' }}>
                              <div style={{ height:8, background:'#ef4444', borderRadius:'3px 0 0 3px',
                                width:`${(sPct/maxPct)*100}px`, maxWidth:100 }}/>
                            </div>
                            {/* Price label */}
                            <div style={{ width:70, textAlign:'center', fontSize:8, fontFamily:'monospace',
                              color: isCurrent ? '#00d4aa' : 'var(--text3)', fontWeight: isCurrent ? 700 : 400 }}>
                              {fmtP(bPrice, symbol)}{isCurrent ? ' ◄' : ''}
                            </div>
                            {/* Long bar (right) */}
                            <div style={{ width:100 }}>
                              <div style={{ height:8, background:'#22c55e', borderRadius:'0 3px 3px 0',
                                width:`${(lPct/maxPct)*100}px`, maxWidth:100 }}/>
                            </div>
                            {/* pct labels */}
                            <span style={{ fontSize:8, color:'#22c55e', fontFamily:'monospace', width:30 }}>
                              {lPct > 0 ? lPct.toFixed(1)+'%' : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display:'flex', justifyContent:'space-between', marginTop:4, fontSize:9, color:'var(--text3)' }}>
                      <span style={{ color:'#ef4444' }}>◄ SHORT %</span>
                      <span style={{ color:'#22c55e' }}>LONG % ►</span>
                    </div>
                  </div>
                );
              };
              return (
                <div style={{ padding:12 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'var(--text)', marginBottom:12 }}>
                    {symbol} — Position &amp; Order Book
                    <span style={{ fontSize:10, fontWeight:400, color:'var(--text3)', marginLeft:8 }}>
                      OANDA live data · Price: {fmtP(curPrice, symbol)}
                    </span>
                  </div>
                  {renderBook('Position Book — Open Trade Distribution', pos?.buckets, 'longCountPercent', 'shortCountPercent', '#22c55e')}
                  {renderBook('Order Book — Pending Orders Distribution', ord?.buckets, 'longCountPercent', 'shortCountPercent', '#3b82f6')}
                  <div style={{ fontSize:9, color:'var(--text3)', marginTop:8, lineHeight:1.6 }}>
                    Position Book shows where open trades are clustered. Order Book shows pending buy/sell orders.<br/>
                    Dense long areas below price = support. Dense short areas above = resistance.
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── AI Analysis Tab ── */}
        {tab==='ai' && (
          <div className="cm-body cm-ai-body">
            <div className="cm-ai-panel">
              <div className="cm-section-title">AI Setup Analysis — {symbol} {tf}</div>
              <div className="cm-tf-row" style={{marginBottom:10}}>
                {TFS.map(t=><button key={t} className={`cm-tf-pill${tf===t?' active':''}`} onClick={()=>setTf(t)}>{t}</button>)}
              </div>
              <button className="cm-run-btn" onClick={doAnalysis} disabled={analyLL}>
                {analyLL?'⟳ Analysing…':'🔍 Run Deep Analysis'}
              </button>
              {analysis && <div className="cm-analysis-text">{analysis}</div>}
              <div className="cm-ai-hint">
                Set <code>anthropic_key</code> in browser console:<br/>
                <code>localStorage.setItem('anthropic_key','sk-ant-...')</code>
              </div>
            </div>
          </div>
        )}

        {/* ── Checklist Tab ── */}
        {tab==='checklist' && (
          <div className="cm-body cm-check-body">
            <div className="cm-check-panel">
              <div className="cm-section-title">Pre-Trade Checklist — {symbol}</div>
              {rules.map((r,i)=>(
                <div key={i} className="cm-check-row">
                  <button className={`cm-check-toggle ${checks[i]||'none'}`}
                    onClick={()=>setChecks(c=>({...c,[i]:c[i]==='pass'?'fail':c[i]==='fail'?'none':'pass'}))}>
                    {checks[i]==='pass'?'✅':checks[i]==='fail'?'❌':'○'}
                  </button>
                  <span style={{flex:1,fontSize:12,color:'var(--text2)'}}>{r}</span>
                  <button className="cm-rm-btn" onClick={()=>{setRules(p=>p.filter((_,j)=>j!==i));const c={...checks};delete c[i];setChecks(c);}}>✕</button>
                </div>
              ))}
              <div className="cm-check-add">
                <input className="cm-check-input" value={newRule} placeholder="Add custom rule…"
                  onChange={e=>setNewRule(e.target.value)}
                  onKeyDown={e=>{if(e.key==='Enter'&&newRule.trim()){setRules(p=>[...p,newRule.trim()]);setNewRule('');}}}/>
                <button className="bt-add-btn" onClick={()=>{if(newRule.trim()){setRules(p=>[...p,newRule.trim()]);setNewRule('');}}}>+ Add</button>
              </div>
              <div className="cm-score">
                {Object.values(checks).filter(v=>v==='pass').length} / {rules.length} checks passed
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

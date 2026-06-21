import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

// ── Config ────────────────────────────────────────────────────────────────────
const PAIRS = [
  { key:'EUR_USD',    label:'EUR/USD',  pip:0.0001, group:'Forex'   },
  { key:'GBP_USD',    label:'GBP/USD',  pip:0.0001, group:'Forex'   },
  { key:'USD_JPY',    label:'USD/JPY',  pip:0.01,   group:'Forex'   },
  { key:'GBP_JPY',    label:'GBP/JPY',  pip:0.01,   group:'Forex'   },
  { key:'EUR_JPY',    label:'EUR/JPY',  pip:0.01,   group:'Forex'   },
  { key:'USD_CAD',    label:'USD/CAD',  pip:0.0001, group:'Forex'   },
  { key:'AUD_USD',    label:'AUD/USD',  pip:0.0001, group:'Forex'   },
  { key:'NZD_USD',    label:'NZD/USD',  pip:0.0001, group:'Forex'   },
  { key:'XAU_USD',    label:'XAU/USD',  pip:0.1,    group:'Metals'  },
  { key:'XAG_USD',    label:'XAG/USD',  pip:0.01,   group:'Metals'  },
  { key:'US30_USD',   label:'US30',     pip:1,      group:'Indices' },
  { key:'SPX500_USD', label:'SPX500',   pip:0.1,    group:'Indices' },
  { key:'NAS100_USD', label:'NAS100',   pip:0.1,    group:'Indices' },
  { key:'UK100_GBP',  label:'UK100',    pip:0.1,    group:'Indices' },
  { key:'DE30_EUR',   label:'GER30',    pip:0.1,    group:'Indices' },
  { key:'JP225_USD',  label:'JPN225',   pip:1,      group:'Indices' },
];

const LS_KEY = 'alpha_lab_v2';

const PHASES = {
  accumulation: { color:'#f59e0b', glow:'#f59e0b44', label:'ACCUMULATING', icon:'◎', desc:'Coiling — big move coming' },
  manipulation: { color:'#ef4444', glow:'#ef444466', label:'MANIPULATION',  icon:'⚡', desc:'Liquidity sweep detected' },
  distribution: { color:'#00d4aa', glow:'#00d4aa44', label:'DISTRIBUTION',  icon:'▶', desc:'Real move in progress'   },
  neutral:      { color:'#334155', glow:'transparent', label:'NEUTRAL',     icon:'·', desc:'No clear phase'          },
};

// Timeframe config — pages:2 × 5000 candles = up to 10k per pair
// H4 ×2 pages ≈ 4.6 years · H1 ≈ 14 months · M30 ≈ 7 months · M15 ≈ 3.5 months
const TF_CONFIG = {
  M15: { label:'15m', gran:'M15', liveCount:200, pages:2, futureCandles:12 },
  M30: { label:'30m', gran:'M30', liveCount:120, pages:2, futureCandles:8  },
  H1:  { label:'1H',  gran:'H1',  liveCount:100, pages:2, futureCandles:6  },
  H4:  { label:'4H',  gran:'H4',  liveCount:80,  pages:2, futureCandles:5  },
};

const TF_HIST_LABEL = { M15:'~3.5 months', M30:'~7 months', H1:'~14 months', H4:'~4.6 years' };

// ── OANDA ─────────────────────────────────────────────────────────────────────
function getCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) return c;
  } catch {}
  const apiKey  = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}

async function fetchCandles(pair, gran, count) {
  const creds = getCreds();
  if (!creds?.apiKey) return null;
  const base = creds.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  try {
    const r = await fetch(
      `${base}/instruments/${pair}/candles?granularity=${gran}&count=${count}&price=M`,
      { headers:{ Authorization:`Bearer ${creds.apiKey}` }, signal:AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return (d.candles||[]).filter(c=>c.complete).map(c=>({
      o:+c.mid.o, h:+c.mid.h, l:+c.mid.l, c:+c.mid.c,
      t:new Date(c.time).getTime(), v:c.volume||0,
    }));
  } catch { return null; }
}

async function fetchCandlesAt(pair, isoTime, before=14, after=8) {
  const creds = getCreds();
  if (!creds?.apiKey) return null;
  const base = creds.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  const from = new Date(new Date(isoTime).getTime() - before * 3600000).toISOString();
  const count = before + after + 2;
  try {
    const r = await fetch(
      `${base}/instruments/${pair}/candles?granularity=H1&from=${encodeURIComponent(from)}&count=${count}&price=M`,
      { headers:{ Authorization:`Bearer ${creds.apiKey}` }, signal:AbortSignal.timeout(10000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return (d.candles||[]).map(c=>({
      o:+c.mid.o, h:+c.mid.h, l:+c.mid.l, c:+c.mid.c,
      t:new Date(c.time).getTime(),
    }));
  } catch { return null; }
}

// Paginated fetch: pages×5000 candles, oldest→newest
async function fetchCandlesAll(pairKey, gran, pages = 2) {
  const creds = getCreds();
  if (!creds?.apiKey) return null;
  const base = creds.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  let allCandles = [];
  let toTime = null;
  for (let p = 0; p < pages; p++) {
    const url = toTime
      ? `${base}/instruments/${pairKey}/candles?granularity=${gran}&count=5000&to=${encodeURIComponent(toTime)}&price=M`
      : `${base}/instruments/${pairKey}/candles?granularity=${gran}&count=5000&price=M`;
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        signal:  AbortSignal.timeout(25000),
      });
      if (!r.ok) break;
      const d = await r.json();
      const batch = (d.candles || []).filter(c => c.complete).map(c => ({
        o:+c.mid.o, h:+c.mid.h, l:+c.mid.l, c:+c.mid.c,
        t:new Date(c.time).getTime(), v:c.volume || 0,
      }));
      if (!batch.length) break;
      allCandles = [...batch, ...allCandles];
      toTime = new Date(batch[0].t - 1).toISOString();
    } catch { break; }
  }
  return allCandles.sort((a, b) => a.t - b.t);
}

// ── Algorithms ────────────────────────────────────────────────────────────────
function avgBody(candles) {
  return candles.reduce((s,c)=>s+Math.abs(c.c-c.o),0)/(candles.length||1);
}
function avgRange(candles) {
  return candles.reduce((s,c)=>s+(c.h-c.l),0)/(candles.length||1);
}
function computeATR(candles, p=14) {
  if (!candles||candles.length<p+1) return 0;
  let s=0;
  for (let i=candles.length-p;i<candles.length;i++) {
    const pc=candles[i-1].c;
    s+=Math.max(candles[i].h-candles[i].l,Math.abs(candles[i].h-pc),Math.abs(candles[i].l-pc));
  }
  return s/p;
}

// Real swing highs: pivot candle whose high is STRICTLY higher than `strength` candles on each side
function findSwingHighs(candles, strength) {
  const out = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const h = candles[i].h;
    let ok = true;
    for (let j = 1; j <= strength; j++) {
      if (candles[i-j].h >= h || candles[i+j].h >= h) { ok = false; break; }
    }
    if (ok) out.push({ price:h, idx:i, time:candles[i].t });
  }
  return out;
}

// Real swing lows: pivot candle whose low is STRICTLY lower than `strength` candles on each side
function findSwingLows(candles, strength) {
  const out = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const l = candles[i].l;
    let ok = true;
    for (let j = 1; j <= strength; j++) {
      if (candles[i-j].l <= l || candles[i+j].l <= l) { ok = false; break; }
    }
    if (ok) out.push({ price:l, idx:i, time:candles[i].t });
  }
  return out;
}

function detectPhase(candles, strength=3, minWickPct=0) {
  const minLen = strength * 2 + 6;
  if (!candles || candles.length < minLen) return { phase:'neutral' };
  const n    = candles.length;
  const last = candles[n-1];

  const history    = candles.slice(0, -1);
  const swingHighs = findSwingHighs(history, strength);
  const swingLows  = findSwingLows(history, strength);
  const lastSwH    = swingHighs.length ? swingHighs[swingHighs.length-1] : null;
  const lastSwL    = swingLows.length  ? swingLows[swingLows.length-1]   : null;

  const ref  = candles.slice(-Math.min(21, n-1), -1);
  const ab   = avgBody(ref);
  const ar   = avgRange(ref);

  // MANIPULATION — wick sweeps a confirmed pivot, body closes back inside
  // minWickPct: wick excess must be at least X% of avg range (filters micro-pokes)
  if (lastSwH && last.h > lastSwH.price && last.c < lastSwH.price) {
    const excessPct = ar>0 ? (last.h - lastSwH.price)/ar*100 : 0;
    if (excessPct < minWickPct) return { phase:'neutral' };
    return {
      phase:    'manipulation',
      swept:    'high',
      level:    lastSwH.price,
      swingIdx: lastSwH.idx,
      direction:'bearish',
      excess:   Math.round(excessPct),
    };
  }
  if (lastSwL && last.l < lastSwL.price && last.c > lastSwL.price) {
    const excessPct = ar>0 ? (lastSwL.price - last.l)/ar*100 : 0;
    if (excessPct < minWickPct) return { phase:'neutral' };
    return {
      phase:    'manipulation',
      swept:    'low',
      level:    lastSwL.price,
      swingIdx: lastSwL.idx,
      direction:'bullish',
      excess:   Math.round(excessPct),
    };
  }

  // DISTRIBUTION — strong impulsive body
  const lastBody = Math.abs(last.c-last.o);
  if (ab>0 && lastBody>ab*1.9 && ar>0) return {
    phase:    'distribution',
    direction: last.c>last.o?'bullish':'bearish',
    strength:  +(lastBody/ab).toFixed(1),
  };

  // ACCUMULATION — 6 small narrowing candles
  const last6    = candles.slice(-6);
  const allSmall = ab>0 && last6.every(c=>Math.abs(c.c-c.o)<ab*0.75);
  const narrow   = (last6[5].h-last6[5].l)<(last6[0].h-last6[0].l)*1.15;
  if (allSmall&&narrow) return { phase:'accumulation' };

  return { phase:'neutral' };
}

// O(N) sweep backfill using pre-computed swing pointers — much faster than O(N²) sliding window
function backfillOnCandles(candles, pair, tf, strength, minWick, futureLen, hm, seenIds) {
  const sweeps = [];
  const minI   = strength * 2 + 2;
  if (candles.length < minI + futureLen + 2) return sweeps;

  const allHighs = findSwingHighs(candles, strength);
  const allLows  = findSwingLows(candles, strength);
  let hPtr = -1, lPtr = -1;

  for (let i = minI; i < candles.length - 1; i++) {
    // Advance to most recent pivot confirmed in history[0..i-1]: pivot.idx + strength <= i-1
    while (hPtr + 1 < allHighs.length && allHighs[hPtr + 1].idx + strength <= i - 1) hPtr++;
    while (lPtr + 1 < allLows.length  && allLows[lPtr + 1].idx  + strength <= i - 1) lPtr++;

    const lastSwH = hPtr >= 0 ? allHighs[hPtr] : null;
    const lastSwL = lPtr >= 0 ? allLows[lPtr]  : null;
    if (!lastSwH && !lastSwL) continue;

    const candle = candles[i];
    const ar     = avgRange(candles.slice(Math.max(0, i - 21), i));
    let phase    = null;

    if (lastSwH && candle.h > lastSwH.price && candle.c < lastSwH.price) {
      const excessPct = ar > 0 ? (candle.h - lastSwH.price) / ar * 100 : 0;
      if (excessPct >= minWick)
        phase = { swept:'high', level:lastSwH.price, direction:'bearish' };
    } else if (lastSwL && candle.l < lastSwL.price && candle.c > lastSwL.price) {
      const excessPct = ar > 0 ? (lastSwL.price - candle.l) / ar * 100 : 0;
      if (excessPct >= minWick)
        phase = { swept:'low', level:lastSwL.price, direction:'bullish' };
    }
    if (!phase) continue;

    const id = `${pair.key}_${tf}_s${strength}_w${minWick}_hist_${candle.t}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const future  = candles.slice(i + 1, i + futureLen + 1);
    const entry   = candle.c;
    const expBull = phase.direction === 'bullish';
    let outcome = 'failed', pipsMoved = 0;
    for (const fc of future) {
      const moved = (fc.c - entry) / pair.pip;
      if ((expBull && moved > 20) || (!expBull && moved < -20)) {
        outcome   = 'confirmed';
        pipsMoved = Math.round(Math.abs(moved));
        break;
      }
    }

    const utcHour = new Date(candle.t).getUTCHours();
    if (!hm[pair.key]) hm[pair.key] = {};
    hm[pair.key][utcHour] = (hm[pair.key][utcHour] || 0) + 1;

    sweeps.push({
      id, pair: pair.key, label: pair.label,
      time:        new Date(candle.t).toISOString(),
      utcHour,
      swept:       phase.swept,
      level:       phase.level,
      expectedDir: phase.direction,
      entryPrice:  entry,
      pip:         pair.pip,
      outcome, pipsMoved,
      resolvedAt:  new Date(candles[Math.min(i + futureLen, candles.length - 1)].t).toISOString(),
      historical:  true,
      tf, strength,
    });
  }
  return sweeps;
}

// ── Persistence ───────────────────────────────────────────────────────────────
function loadStore() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)||'{}'); } catch { return {}; }
}
function saveStore(d) {
  try { localStorage.setItem(LS_KEY,JSON.stringify(d)); } catch {}
}

// ── Historical backfill ───────────────────────────────────────────────────────
async function runBackfill(onProgress, tf = 'H1', strength = 3, minWick = 0) {
  const tfCfg   = TF_CONFIG[tf];
  const store   = loadStore();
  const hm      = store.heatmap  || {};
  const existing = store.sweepLog || [];
  const seenIds  = new Set(existing.map(s => s.id));
  let allNew = [], total = 0;

  for (let pi = 0; pi < PAIRS.length; pi++) {
    const pair = PAIRS[pi];
    onProgress && onProgress(`[${tf} ${pi+1}/${PAIRS.length}] Fetching ${pair.label}…`);
    const candles = await fetchCandlesAll(pair.key, tfCfg.gran, tfCfg.pages);
    if (!candles || candles.length < strength * 2 + 10) continue;

    onProgress && onProgress(`[${tf} ${pi+1}/${PAIRS.length}] Scanning ${pair.label} · ${candles.length.toLocaleString()} candles…`);
    const sweeps = backfillOnCandles(candles, pair, tf, strength, minWick, tfCfg.futureCandles, hm, seenIds);
    allNew = allNew.concat(sweeps);
    total += sweeps.length;
  }

  const merged = [...allNew, ...existing]
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 2000);

  saveStore({ ...store, sweepLog: merged, heatmap: hm });
  return { sweeps: merged, heatmap: hm, total };
}

// ── Time & alert helpers ──────────────────────────────────────────────────────
function toET(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    }).replace(',', ' ·');
  } catch { return iso?.slice(0,16) || '—'; }
}

function getETHour(iso) {
  try {
    const h = parseInt(new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', hour12: false,
    }), 10);
    return isNaN(h) ? 0 : h % 24;
  } catch { return 0; }
}

function getSessionLabel(etHour) {
  if (etHour >= 19 || etHour < 3)  return { label:'Asian',   color:'#f59e0b' };
  if (etHour >= 3  && etHour < 8)  return { label:'London',  color:'#8b5cf6' };
  if (etHour >= 8  && etHour < 12) return { label:'Overlap', color:'#a78bfa' };
  if (etHour >= 12 && etHour < 17) return { label:'NY',      color:'#22c55e' };
  return null;
}

function playAlert() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18, 0.36].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.2, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.15);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.15);
    });
  } catch {}
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
@keyframes alphaGlow   { 0%,100%{opacity:1} 50%{opacity:0.5} }
@keyframes alphaScan   { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }
@keyframes alphaSlide  { from{transform:translateX(-12px);opacity:0} to{transform:translateX(0);opacity:1} }
@keyframes alphaPulse  { 0%,100%{transform:scale(1)} 50%{transform:scale(1.15)} }
`;

// ── WinRateByHourChart ────────────────────────────────────────────────────────
function WinRateByHourChart({ byHour }) {
  const hours = Array.from({ length:24 }, (_,i) => i);
  const maxCount = Math.max(1, ...Object.values(byHour).map(v => v.total));
  return (
    <div style={{ overflowX:'auto' }}>
      <div style={{ display:'flex', alignItems:'flex-end', gap:2, height:72, minWidth:420 }}>
        {hours.map(h => {
          const d = byHour[h];
          const hasData = d && d.total >= 2;
          const wr = hasData ? Math.round(d.confirmed / d.total * 100) : null;
          const barH = hasData ? Math.max(5, (d.total / maxCount) * 56) : 3;
          const color = !hasData ? '#0f1929'
            : wr >= 60 ? '#00d4aa'
            : wr >= 40 ? '#f59e0b'
            : '#ef4444';
          const sess = getSessionLabel(h);
          return (
            <div key={h} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:1, minWidth:14 }}>
              {hasData && (
                <span style={{ fontSize:7, color, fontWeight:700 }}>{wr}%</span>
              )}
              <div
                title={hasData
                  ? `${String(h).padStart(2,'0')}:00 ET — ${wr}% win (${d.confirmed}/${d.total})`
                  : `${String(h).padStart(2,'0')}:00 ET — no data`}
                style={{
                  width:'100%', height:Math.max(3, barH),
                  background: hasData ? `linear-gradient(180deg,${color},${color}88)` : color,
                  borderRadius:'2px 2px 0 0',
                  border: sess && hasData ? `1px solid ${sess.color}44` : 'none',
                }}
              />
              <span style={{ fontSize:7, color:'#1e293b', fontFamily:'monospace' }}>
                {String(h).padStart(2,'0')}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ display:'flex', gap:10, marginTop:8, flexWrap:'wrap' }}>
        {[
          { label:'Asian 7pm–3am ET',    color:'#f59e0b' },
          { label:'London 3–8am ET',     color:'#8b5cf6' },
          { label:'Overlap 8–12pm ET',   color:'#a78bfa' },
          { label:'NY 12–5pm ET',        color:'#22c55e' },
        ].map(s=>(
          <div key={s.label} style={{ display:'flex', alignItems:'center', gap:3 }}>
            <div style={{ width:6, height:6, borderRadius:1, background:s.color }}/>
            <span style={{ fontSize:8, color:s.color }}>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── MiniSweepChart ────────────────────────────────────────────────────────────
function MiniSweepChart({ sweep, pairKey }) {
  const [candles, setCandles] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setCandles(null);
    fetchCandlesAt(pairKey, sweep.time, 14, 8).then(c => {
      setCandles(c);
      setLoading(false);
    });
  }, [pairKey, sweep.time]);

  if (loading) return (
    <div style={{ padding:'14px 0', textAlign:'center', fontSize:10, color:'#334155', animation:'alphaGlow 1s infinite' }}>
      Loading chart data…
    </div>
  );
  if (!candles || candles.length < 4) return (
    <div style={{ padding:'14px 0', textAlign:'center', fontSize:10, color:'#1e293b' }}>
      No chart data available for this period
    </div>
  );

  const sweepTs = new Date(sweep.time).getTime();
  let sweepIdx = 0;
  let minDiff = Infinity;
  candles.forEach((c, i) => {
    const d = Math.abs(c.t - sweepTs);
    if (d < minDiff) { minDiff = d; sweepIdx = i; }
  });

  const W = 340, H = 130;
  const padL = 4, padR = 4, padT = 14, padB = 20;
  const usableW = W - padL - padR;
  const usableH = H - padT - padB;
  const cw = usableW / candles.length;

  const allH = candles.map(c => c.h);
  const allL = candles.map(c => c.l);
  const pMax = Math.max(...allH, sweep.level) * 1.0002;
  const pMin = Math.min(...allL, sweep.level) * 0.9998;
  const pRange = pMax - pMin || 1;

  const py = p => padT + (pMax - p) / pRange * usableH;
  const px = i => padL + i * cw + cw * 0.5;

  const sweepColor  = sweep.swept === 'high' ? '#ef4444' : '#00d4aa';
  const expectColor = sweep.expectedDir === 'bullish' ? '#00d4aa' : '#ef4444';
  const levelY = py(sweep.level);

  return (
    <div style={{ background:'#030508', borderRadius:8, padding:'6px 2px 4px', marginTop:6, border:'1px solid #0a0f1a', overflow:'hidden' }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display:'block' }}>
        {/* Sweep level dashed line */}
        <line x1={padL} y1={levelY} x2={W-padR} y2={levelY}
          stroke={sweepColor} strokeWidth="0.7" strokeDasharray="4,3" opacity="0.7"/>
        <text x={W-padR-2} y={levelY-3} fontSize="7" fill={sweepColor} textAnchor="end" opacity="0.8">
          {sweep.swept==='high'?'SWING HIGH':'SWING LOW'}
        </text>

        {/* Vertical marker at sweep candle */}
        <line x1={px(sweepIdx)} y1={padT} x2={px(sweepIdx)} y2={H-padB}
          stroke={sweepColor} strokeWidth="0.5" strokeDasharray="2,2" opacity="0.35"/>

        {/* Candles */}
        {candles.map((c, i) => {
          const isSweep  = i === sweepIdx;
          const isAfter  = i > sweepIdx;
          const bullish  = c.c >= c.o;
          const baseCol  = bullish ? '#22c55e' : '#ef4444';
          const col = isSweep ? sweepColor : baseCol;
          const opacity  = isSweep ? 1 : isAfter ? 0.75 : 0.45;
          const bodyTop  = py(Math.max(c.o, c.c));
          const bodyBot  = py(Math.min(c.o, c.c));
          const bodyH    = Math.max(1, bodyBot - bodyTop);
          const wickX    = px(i);
          const bodyX    = px(i) - cw * 0.36;
          const bW       = cw * 0.72;
          return (
            <g key={i} opacity={opacity}>
              <line x1={wickX} y1={py(c.h)} x2={wickX} y2={py(c.l)}
                stroke={col} strokeWidth={isSweep ? 1.5 : 0.9}/>
              <rect x={bodyX} y={bodyTop} width={bW} height={bodyH} fill={col}/>
              {isSweep && (
                <rect x={bodyX-1.5} y={bodyTop-1.5} width={bW+3} height={bodyH+3}
                  fill="none" stroke={sweepColor} strokeWidth="1" opacity="0.6"/>
              )}
            </g>
          );
        })}

        {/* Expected direction arrow */}
        {sweepIdx < candles.length - 1 && (
          <g opacity="0.8">
            <line
              x1={px(sweepIdx) + cw * 0.5}
              y1={levelY}
              x2={px(sweepIdx) + cw * 0.5}
              y2={sweep.expectedDir==='bullish' ? levelY - 22 : levelY + 22}
              stroke={expectColor} strokeWidth="1.5"/>
            <polygon
              points={sweep.expectedDir==='bullish'
                ? `${px(sweepIdx)+cw*0.5-4},${levelY-18} ${px(sweepIdx)+cw*0.5+4},${levelY-18} ${px(sweepIdx)+cw*0.5},${levelY-26}`
                : `${px(sweepIdx)+cw*0.5-4},${levelY+18} ${px(sweepIdx)+cw*0.5+4},${levelY+18} ${px(sweepIdx)+cw*0.5},${levelY+26}`}
              fill={expectColor}/>
          </g>
        )}

        {/* ⚡ label under sweep candle */}
        <text x={px(sweepIdx)} y={H-padB+13} fontSize="8" fill={sweepColor} textAnchor="middle" fontWeight="700">
          ⚡SWEEP
        </text>

        {/* ET time at first and last candle */}
        {[0, candles.length-1].map(i => (
          <text key={i} x={px(i)} y={H-padB+13} fontSize="7" fill="#1e293b" textAnchor="middle">
            {toET(new Date(candles[i].t).toISOString()).slice(-5)}
          </text>
        ))}

        {/* Outcome indicator after sweep */}
        {sweep.outcome !== 'pending' && sweepIdx < candles.length - 1 && (
          <text x={px(Math.min(sweepIdx+4, candles.length-1))} y={padT+10} fontSize="8" fontWeight="700"
            fill={sweep.outcome==='confirmed'?'#00d4aa':'#ef4444'} textAnchor="middle">
            {sweep.outcome==='confirmed'?'✓ WIN':'✗ FAIL'}
          </text>
        )}
      </svg>

      <div style={{ display:'flex', gap:10, padding:'2px 8px 4px', flexWrap:'wrap' }}>
        {[
          { col:sweepColor, label:`Sweep level (${sweep.swept==='high'?'swing H':'swing L'})`, dash:true },
          { col:sweepColor, label:'Sweep candle' },
          { col:expectColor, label:`Expected: ${sweep.expectedDir==='bullish'?'▲ UP':'▼ DOWN'}` },
        ].map(({ col, label, dash }) => (
          <div key={label} style={{ display:'flex', alignItems:'center', gap:3 }}>
            <div style={{ width:10, height: dash?1:6, background:col, borderRadius:1, opacity:0.8,
              borderTop:dash?`1px dashed ${col}`:'none', background:dash?'transparent':col }}/>
            <span style={{ fontSize:8, color:'#334155' }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── PairDetailModal ───────────────────────────────────────────────────────────
function PairDetailModal({ pairKey, sweepLog, phases, onClose }) {
  const pair = PAIRS.find(p => p.key === pairKey);
  if (!pair) return null;

  const pairSweeps = sweepLog.filter(s => s.pair === pairKey);
  const phase = phases[pairKey];
  const ph = PHASES[phase?.phase || 'neutral'];

  const resolved  = pairSweeps.filter(s => s.outcome !== 'pending');
  const confirmed = resolved.filter(s => s.outcome === 'confirmed');
  const winRate   = resolved.length ? Math.round(confirmed.length / resolved.length * 100) : null;
  const avgPips   = confirmed.length
    ? Math.round(confirmed.reduce((sum, e) => sum + e.pipsMoved, 0) / confirmed.length)
    : 0;

  const byHour = {};
  pairSweeps.forEach(s => {
    if (s.outcome === 'pending') return;
    const h = getETHour(s.time);
    if (!byHour[h]) byHour[h] = { total:0, confirmed:0 };
    byHour[h].total++;
    if (s.outcome === 'confirmed') byHour[h].confirmed++;
  });

  const bestEntry = Object.entries(byHour)
    .filter(([, v]) => v.total >= 2)
    .sort(([, a], [, b]) => (b.confirmed/b.total) - (a.confirmed/a.total))[0];
  const bestHour = bestEntry ? parseInt(bestEntry[0]) : null;
  const bestWR   = bestEntry ? Math.round(bestEntry[1].confirmed/bestEntry[1].total*100) : null;

  const nowETHour = getETHour(new Date().toISOString());
  const nowHrData = byHour[nowETHour];
  const nowHrWR   = nowHrData && nowHrData.total >= 2
    ? Math.round(nowHrData.confirmed/nowHrData.total*100) : null;

  const [chartOpenId, setChartOpenId] = useState(null);

  return (
    <div
      style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(4,7,15,0.97)', overflowY:'auto', padding:'16px 12px' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <button onClick={onClose} style={{
        position:'fixed', top:12, right:12, width:32, height:32,
        background:'#0f1929', border:'1px solid #1e293b', borderRadius:8,
        color:'#94a3b8', fontSize:16, cursor:'pointer', zIndex:1001,
        display:'flex', alignItems:'center', justifyContent:'center', padding:0,
      }}>✕</button>

      {/* Header */}
      <div style={{ marginBottom:14, paddingRight:40 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
          <span style={{ fontSize:22, fontWeight:900, color:'#f1f5f9', letterSpacing:'0.04em' }}>
            {pair.label}
          </span>
          <span style={{ fontSize:10, fontWeight:700, color:ph.color, background:`${ph.color}18`,
            padding:'3px 10px', borderRadius:12, border:`1px solid ${ph.color}44`,
            animation: phase?.phase==='manipulation' ? 'alphaGlow 0.8s infinite' : 'none' }}>
            {ph.icon} {ph.label}
          </span>
          <span style={{ fontSize:9, color:'#475569', background:'#0f1929', padding:'2px 8px', borderRadius:6, border:'1px solid #1e293b' }}>
            {pair.group}
          </span>
          {phase?.price && (
            <span style={{ fontSize:15, color:'#e2e8f0', fontFamily:'monospace', marginLeft:'auto' }}>
              {phase.price.toFixed(pair.pip < 0.01 ? 5 : pair.pip < 1 ? 3 : 1)}
            </span>
          )}
        </div>
        <div style={{ fontSize:10, color:'#334155' }}>
          {pairSweeps.length} sweeps logged · {resolved.length} resolved
          {nowHrWR !== null && (
            <span style={{ marginLeft:8, color:nowHrWR>=60?'#00d4aa':nowHrWR>=40?'#f59e0b':'#ef4444', fontWeight:700 }}>
              · Now ({String(nowETHour).padStart(2,'0')}:xx ET): {nowHrWR}% WR historically
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:14 }}>
        {[
          { label:'Total Sweeps', value:pairSweeps.length, color:'#e2e8f0' },
          { label:'Win Rate',
            value: winRate != null ? `${winRate}%` : '—',
            color: winRate==null ? '#475569' : winRate>=60 ? '#00d4aa' : winRate>=40 ? '#f59e0b' : '#ef4444' },
          { label:'Avg Pips (W)', value:avgPips>0?`${avgPips}p`:'—', color:'#60a5fa' },
          { label:'Best ET Hour',
            value: bestHour!=null ? `${String(bestHour).padStart(2,'0')}:00` : '—',
            color:'#8b5cf6', sub: bestWR!=null ? `${bestWR}% WR` : '' },
        ].map(({ label, value, color, sub }) => (
          <div key={label} style={{ background:'#060910', border:'1px solid #0f1929', borderRadius:10, padding:'10px 8px', textAlign:'center' }}>
            <div style={{ fontSize:20, fontWeight:900, color, fontFamily:'monospace', lineHeight:1 }}>{value}</div>
            {sub && <div style={{ fontSize:9, color:'#60a5fa', marginTop:1 }}>{sub}</div>}
            <div style={{ fontSize:9, color:'#334155', marginTop:4 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Win Rate by ET Hour */}
      <div style={{ background:'#060910', border:'1px solid #0f1929', borderRadius:12, padding:'12px 14px', marginBottom:14 }}>
        <div style={{ fontSize:10, fontWeight:700, color:'#475569', marginBottom:10, letterSpacing:'0.08em' }}>
          WIN RATE BY ET HOUR
        </div>
        {resolved.length >= 3 ? (
          <WinRateByHourChart byHour={byHour} />
        ) : (
          <div style={{ fontSize:11, color:'#1e293b', textAlign:'center', padding:'20px 0' }}>
            Need at least 3 resolved sweeps — run "Load 30d History" first
          </div>
        )}
      </div>

      {/* All sweeps for this pair */}
      <div style={{ background:'#060910', border:'1px solid #0f1929', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid #0f1929', fontSize:10, fontWeight:700, color:'#475569', letterSpacing:'0.08em' }}>
          ALL SWEEPS — {pair.label}
        </div>
        {pairSweeps.length === 0 ? (
          <div style={{ textAlign:'center', padding:'32px', fontSize:11, color:'#1e293b' }}>No sweeps logged yet</div>
        ) : pairSweeps.map((s, i) => {
          const etH = getETHour(s.time);
          const hrD = byHour[etH];
          const hrWR = hrD && hrD.total >= 2 ? Math.round(hrD.confirmed/hrD.total*100) : null;
          const sess = getSessionLabel(etH);
          return (
            <div key={s.id} style={{ borderBottom:'1px solid #0a0f1a', background: i%2===0 ? '#060910' : '#070b12' }}>
            <div style={{
              display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
            }}>
              <div style={{
                width:22, height:22, borderRadius:5, flexShrink:0,
                background: s.expectedDir==='bullish'?'#00d4aa18':'#ef444418',
                border:`1px solid ${s.expectedDir==='bullish'?'#00d4aa44':'#ef444444'}`,
                display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:10, color:s.expectedDir==='bullish'?'#00d4aa':'#ef4444', fontWeight:800,
              }}>
                {s.expectedDir==='bullish'?'↑':'↓'}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}>
                  <span style={{ fontSize:11, color:'#e2e8f0', fontWeight:600 }}>
                    {toET(s.time)} ET
                  </span>
                  {sess && (
                    <span style={{ fontSize:8, color:sess.color, background:`${sess.color}12`,
                      padding:'1px 5px', borderRadius:4, border:`1px solid ${sess.color}33` }}>
                      {sess.label}
                    </span>
                  )}
                  {hrWR !== null && (
                    <span style={{ fontSize:8, fontWeight:700,
                      color: hrWR>=60?'#00d4aa':hrWR>=40?'#f59e0b':'#ef4444' }}>
                      {hrWR}% WR this hour
                    </span>
                  )}
                </div>
                <div style={{ fontSize:10, color:'#334155', marginTop:1 }}>
                  {s.swept==='high'?'↑ HIGH':'↓ LOW'} swept
                  {s.pipsMoved>0 && <span style={{ color:'#475569' }}> · {s.pipsMoved}p moved after</span>}
                  {s.historical && <span style={{ color:'#1e293b' }}> · historical</span>}
                </div>
              </div>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, flexShrink:0 }}>
                <span style={{
                  fontSize:9, fontWeight:700,
                  color: s.outcome==='confirmed'?'#00d4aa':s.outcome==='failed'?'#ef4444':'#f59e0b',
                  background: s.outcome==='confirmed'?'#00d4aa12':s.outcome==='failed'?'#ef444412':'#f59e0b12',
                  padding:'2px 8px', borderRadius:8,
                  border:`1px solid ${s.outcome==='confirmed'?'#00d4aa33':s.outcome==='failed'?'#ef444433':'#f59e0b33'}`,
                }}>
                  {s.outcome==='confirmed'?'✓ WIN':s.outcome==='failed'?'✗ FAIL':'⏳'}
                </span>
                <button
                  onClick={() => setChartOpenId(chartOpenId===s.id ? null : s.id)}
                  style={{
                    fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:6, cursor:'pointer',
                    background: chartOpenId===s.id ? '#1e293b' : 'transparent',
                    border:'1px solid #1e293b',
                    color: chartOpenId===s.id ? '#00d4aa' : '#475569',
                    transition:'all 0.15s',
                  }}>
                  {chartOpenId===s.id ? '▲ Chart' : '📈 Chart'}
                </button>
              </div>
            </div>
            {chartOpenId === s.id && (
              <div style={{ padding:'0 14px 10px' }}>
                <MiniSweepChart sweep={s} pairKey={pairKey}/>
              </div>
            )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── EdgeBreakdown ─────────────────────────────────────────────────────────────
function EdgeBreakdown({ sweepLog, onPairClick }) {
  const byPair = {};
  PAIRS.forEach(p => { byPair[p.key] = { label:p.label, group:p.group, total:0, confirmed:0, failed:0, pips:0 }; });
  sweepLog.forEach(s => {
    if (!byPair[s.pair] || s.outcome === 'pending') return;
    byPair[s.pair].total++;
    if (s.outcome === 'confirmed') { byPair[s.pair].confirmed++; byPair[s.pair].pips += s.pipsMoved; }
    if (s.outcome === 'failed') byPair[s.pair].failed++;
  });
  const pairRows = Object.values(byPair)
    .filter(r => r.total > 0)
    .sort((a, b) => (b.confirmed/b.total) - (a.confirmed/a.total));

  const byHour = {};
  sweepLog.forEach(s => {
    if (s.outcome === 'pending') return;
    const h = getETHour(s.time);
    if (!byHour[h]) byHour[h] = { total:0, confirmed:0 };
    byHour[h].total++;
    if (s.outcome === 'confirmed') byHour[h].confirmed++;
  });

  const bySess = {
    Asian:  { total:0, confirmed:0 },
    London: { total:0, confirmed:0 },
    NY:     { total:0, confirmed:0 },
  };
  sweepLog.forEach(s => {
    if (s.outcome === 'pending') return;
    const h = getETHour(s.time);
    const name = h >= 19 || h < 3 ? 'Asian'
               : h >= 3 && h < 12 ? 'London'
               : h >= 8 && h < 17 ? 'NY' : null;
    if (name) {
      bySess[name].total++;
      if (s.outcome === 'confirmed') bySess[name].confirmed++;
    }
  });

  const sessColors = { Asian:'#f59e0b', London:'#8b5cf6', NY:'#22c55e' };
  const groupColors = { Forex:'#8b5cf6', Metals:'#f59e0b', Indices:'#22c55e' };

  return (
    <div>
      {/* Session breakdown */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:14 }}>
        {Object.entries(bySess).map(([sess, d]) => {
          const wr = d.total ? Math.round(d.confirmed/d.total*100) : null;
          const c = sessColors[sess];
          return (
            <div key={sess} style={{ background:`${c}08`, border:`1px solid ${c}33`, borderRadius:10, padding:'12px 8px', textAlign:'center' }}>
              <div style={{ fontSize:20, fontWeight:900, fontFamily:'monospace',
                color: wr==null?'#334155':wr>=60?'#00d4aa':wr>=40?'#f59e0b':'#ef4444' }}>
                {wr!=null?`${wr}%`:'—'}
              </div>
              <div style={{ fontSize:9, color:c, opacity:0.8, marginTop:2 }}>{d.confirmed}/{d.total} sweeps</div>
              <div style={{ fontSize:10, fontWeight:700, color:c, marginTop:5, letterSpacing:'0.05em' }}>{sess}</div>
            </div>
          );
        })}
      </div>

      {/* Win rate by ET hour */}
      <div style={{ background:'#06090f', border:'1px solid #0f1929', borderRadius:12, padding:'12px 14px', marginBottom:14 }}>
        <div style={{ fontSize:10, fontWeight:700, color:'#475569', marginBottom:10, letterSpacing:'0.08em' }}>
          WIN RATE BY ET HOUR — ALL PAIRS
        </div>
        {Object.keys(byHour).length >= 3 ? (
          <WinRateByHourChart byHour={byHour} />
        ) : (
          <div style={{ fontSize:11, color:'#1e293b', textAlign:'center', padding:'20px 0' }}>
            Load 30d history to populate this chart
          </div>
        )}
      </div>

      {/* By pair table */}
      <div style={{ background:'#06090f', border:'1px solid #0f1929', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid #0f1929', fontSize:10, fontWeight:700, color:'#475569', letterSpacing:'0.08em' }}>
          WIN RATE BY PAIR — click any row to deep dive
        </div>
        {pairRows.length === 0 ? (
          <div style={{ textAlign:'center', padding:'32px', color:'#1e293b', fontSize:11 }}>
            Load 30d history to see win rates per pair
          </div>
        ) : (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'80px 55px 44px 44px 44px 1fr 50px', gap:4,
              padding:'6px 14px', borderBottom:'1px solid #0f1929' }}>
              {['Pair','Group','Total','Win','Fail','Win Rate','Avg Pip'].map(h=>(
                <div key={h} style={{ fontSize:9, color:'#1e293b', fontWeight:700, letterSpacing:'0.04em' }}>{h}</div>
              ))}
            </div>
            {pairRows.map((r, i) => {
              const wr = Math.round(r.confirmed/r.total*100);
              const gc = groupColors[r.group] || '#475569';
              const avgP = r.confirmed ? Math.round(r.pips/r.confirmed) : 0;
              const pairKey = PAIRS.find(p=>p.label===r.label)?.key;
              return (
                <div key={r.label}
                  onClick={() => pairKey && onPairClick(pairKey)}
                  style={{
                    display:'grid', gridTemplateColumns:'80px 55px 44px 44px 44px 1fr 50px', gap:4,
                    padding:'9px 14px', background:i%2===0?'#06090f':'#070b12',
                    borderBottom:'1px solid #0a0f1a',
                    cursor:'pointer', transition:'background 0.15s',
                  }}
                  onMouseEnter={e=>e.currentTarget.style.background='#0f1929'}
                  onMouseLeave={e=>e.currentTarget.style.background=i%2===0?'#06090f':'#070b12'}
                >
                  <span style={{ fontSize:12, fontWeight:700, color:'#e2e8f0' }}>{r.label}</span>
                  <span style={{ fontSize:9, color:gc, fontWeight:700, alignSelf:'center' }}>{r.group}</span>
                  <span style={{ fontSize:11, color:'#94a3b8', fontFamily:'monospace', alignSelf:'center' }}>{r.total}</span>
                  <span style={{ fontSize:11, color:'#00d4aa', fontFamily:'monospace', alignSelf:'center' }}>{r.confirmed}</span>
                  <span style={{ fontSize:11, color:'#ef4444', fontFamily:'monospace', alignSelf:'center' }}>{r.failed}</span>
                  <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <div style={{ flex:1, height:5, background:'#0f1929', borderRadius:2 }}>
                      <div style={{ height:'100%', width:`${wr}%`, borderRadius:2,
                        background:wr>=60?'#00d4aa':wr>=40?'#f59e0b':'#ef4444' }}/>
                    </div>
                    <span style={{ fontSize:11, fontWeight:700, fontFamily:'monospace', minWidth:30,
                      color:wr>=60?'#00d4aa':wr>=40?'#f59e0b':'#ef4444' }}>{wr}%</span>
                  </div>
                  <span style={{ fontSize:9, color:'#475569', fontFamily:'monospace', alignSelf:'center' }}>
                    {avgP>0?`${avgP}p`:'—'}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ── PhaseCard ─────────────────────────────────────────────────────────────────
function PhaseCard({ pair, data, loading, onClick }) {
  const ph   = PHASES[data?.phase||'neutral'];
  const isManip = data?.phase==='manipulation';
  const isDist  = data?.phase==='distribution';
  return (
    <div
      onClick={onClick}
      style={{
        position:'relative', overflow:'hidden',
        background: data?.phase&&data.phase!=='neutral' ? `${ph.color}08` : '#090d18',
        border:`1px solid ${data?.phase&&data.phase!=='neutral'?ph.color+'44':'#0f1929'}`,
        borderRadius:12, padding:'12px 14px',
        boxShadow: data?.phase&&data.phase!=='neutral' ? `0 0 20px ${ph.glow}` : 'none',
        transition:'all 0.3s ease',
        cursor:'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = ph.color + '88'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = data?.phase&&data.phase!=='neutral'?ph.color+'44':'#0f1929'; e.currentTarget.style.transform = 'none'; }}
    >
      {loading && (
        <div style={{ position:'absolute', inset:0, overflow:'hidden', borderRadius:12 }}>
          <div style={{ position:'absolute', top:0, bottom:0, width:'30%', background:'linear-gradient(90deg,transparent,#ffffff08,transparent)',
            animation:'alphaScan 1.5s infinite' }}/>
        </div>
      )}

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <span style={{ fontSize:13, fontWeight:800, color:'#f1f5f9', letterSpacing:'0.04em' }}>{pair.label}</span>
        <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:1 }}>
          {data?.price && (
            <span style={{ fontSize:10, color:'#475569', fontFamily:'monospace' }}>
              {data.price.toFixed(pair.pip<0.001?3:pair.pip<0.01?5:pair.pip<1?3:1)}
            </span>
          )}
          <span style={{ fontSize:8, color:'#1e293b' }}>{pair.group}</span>
        </div>
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6 }}>
        <span style={{
          fontSize:9, fontWeight:700, letterSpacing:'0.1em',
          padding:'3px 8px', borderRadius:20,
          color:ph.color, background:`${ph.color}18`, border:`1px solid ${ph.color}44`,
          animation: isManip ? 'alphaGlow 0.8s infinite' : 'none',
        }}>
          {ph.icon} {ph.label}
        </span>
        {isManip && data.swept && (
          <span style={{ fontSize:9, color:'#ef4444', fontWeight:700 }}>
            {data.swept==='high'?'↑ HIGH':'↓ LOW'} swept
            {data.excess>0 && <span style={{ color:'#f97316', marginLeft:3 }}>+{data.excess}%</span>}
          </span>
        )}
        {isDist && data.direction && (
          <span style={{ fontSize:9, fontWeight:700, color:data.direction==='bullish'?'#00d4aa':'#ef4444' }}>
            {data.direction==='bullish'?'▲':'▼'} {data.strength}x
          </span>
        )}
      </div>

      <div style={{ fontSize:10, color:'#334155' }}>{loading?'Scanning…':ph.desc}</div>

      {data?.atr && (
        <div style={{ marginTop:8, display:'flex', alignItems:'center', gap:5 }}>
          <span style={{ fontSize:9, color:'#1e293b', width:22 }}>ATR</span>
          <div style={{ flex:1, height:2, background:'#0f1929', borderRadius:1 }}>
            <div style={{ height:'100%', width:`${Math.min(100,data.atr/pair.pip/50*100)}%`,
              background:`linear-gradient(90deg,${ph.color}66,${ph.color})`, borderRadius:1 }}/>
          </div>
          <span style={{ fontSize:9, color:'#334155', fontFamily:'monospace' }}>
            {Math.round(data.atr/pair.pip)}p
          </span>
        </div>
      )}

      <div style={{ position:'absolute', bottom:5, right:8, fontSize:8, color:'#1e293b', opacity:0.5 }}>
        tap to analyze
      </div>
    </div>
  );
}

// ── SweepEntry ────────────────────────────────────────────────────────────────
function SweepEntry({ s, idx, onPairClick }) {
  const etH  = getETHour(s.time);
  const sess = getSessionLabel(etH);
  const tf   = s.tf || 'H1';
  const tfColor = { M15:'#38bdf8', M30:'#818cf8', H1:'#00d4aa', H4:'#f59e0b' }[tf] || '#00d4aa';
  const tfLabel = TF_CONFIG[tf]?.label || tf;
  const outcomeCol   = s.outcome==='confirmed'?'#00d4aa':s.outcome==='failed'?'#ef4444':'#f59e0b';
  const outcomeLabel = s.outcome==='confirmed'?'✓ WIN':s.outcome==='failed'?'✗ FAIL':'⏳';
  return (
    <div
      onClick={() => onPairClick(s.pair)}
      style={{
        display:'flex', alignItems:'center', gap:10, padding:'10px 12px',
        background: idx%2===0?'#06090f':'#070b12',
        borderBottom:'1px solid #0a0f1a',
        animation:'alphaSlide 0.3s ease',
        cursor:'pointer', transition:'background 0.15s',
      }}
      onMouseEnter={e => e.currentTarget.style.background='#0f1929'}
      onMouseLeave={e => e.currentTarget.style.background=idx%2===0?'#06090f':'#070b12'}
    >
      <div style={{
        width:24, height:24, borderRadius:6, flexShrink:0,
        background: s.expectedDir==='bullish'?'#00d4aa18':'#ef444418',
        border:`1px solid ${s.expectedDir==='bullish'?'#00d4aa44':'#ef444444'}`,
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:10, color:s.expectedDir==='bullish'?'#00d4aa':'#ef4444', fontWeight:800,
      }}>
        {s.expectedDir==='bullish'?'↑':'↓'}
      </div>

      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}>
          <span style={{ fontSize:12, fontWeight:700, color:'#e2e8f0' }}>{s.label}</span>
          <span style={{ fontSize:8, color:tfColor, background:`${tfColor}12`,
            padding:'1px 5px', borderRadius:4, border:`1px solid ${tfColor}33`, fontWeight:700 }}>
            {tfLabel}
          </span>
          <span style={{ fontSize:9, color:'#ef4444', background:'#ef444412', padding:'1px 5px', borderRadius:4, border:'1px solid #ef444433' }}>
            ⚡ {s.swept==='high'?'HIGH':'LOW'} swept
          </span>
          {sess && (
            <span style={{ fontSize:9, color:sess.color, background:`${sess.color}12`,
              padding:'1px 5px', borderRadius:4, border:`1px solid ${sess.color}33` }}>
              {sess.label}
            </span>
          )}
        </div>
        <div style={{ fontSize:10, color:'#475569', marginTop:2, fontFamily:'monospace' }}>
          {toET(s.time)} ET
          {s.pipsMoved>0 && <span style={{ color:'#334155' }}> · {s.pipsMoved}p after</span>}
          {s.strength && <span style={{ color:'#1e293b' }}> · str:{s.strength}</span>}
        </div>
      </div>

      <span style={{ fontSize:9, fontWeight:700, color:outcomeCol, background:`${outcomeCol}12`,
        padding:'2px 7px', borderRadius:10, border:`1px solid ${outcomeCol}33`,
        flexShrink:0, whiteSpace:'nowrap' }}>
        {outcomeLabel}
      </span>
    </div>
  );
}

// ── TimeDNA ───────────────────────────────────────────────────────────────────
function TimeDNA({ heatmap }) {
  const hours = Array.from({length:24},(_,i)=>i);
  let globalMax = 1;
  Object.values(heatmap).forEach(ph => {
    Object.values(ph).forEach(v => { if(v>globalMax) globalMax=v; });
  });
  const sessions = [
    { label:'Asian',  s:0,  e:9,  color:'#f59e0b' },
    { label:'London', s:7,  e:17, color:'#8b5cf6' },
    { label:'NY',     s:13, e:22, color:'#22c55e'  },
  ];
  const utcNow = new Date().getUTCHours();
  return (
    <div style={{ padding:'4px 0' }}>
      <div style={{ fontSize:11, color:'#475569', marginBottom:12, lineHeight:1.6 }}>
        Each cell = how many sweeps detected at that UTC hour. Brighter = more market maker activity.
      </div>
      <div style={{ display:'flex', gap:6, marginBottom:10, flexWrap:'wrap' }}>
        {sessions.map(s=>(
          <div key={s.label} style={{ display:'flex', alignItems:'center', gap:4, fontSize:10, color:s.color }}>
            <div style={{ width:8, height:8, borderRadius:2, background:s.color, opacity:0.6 }}/>
            {s.label} {String(s.s).padStart(2,'0')}–{String(s.e).padStart(2,'0')} UTC
          </div>
        ))}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:`60px repeat(24,1fr)`, gap:2, marginBottom:4 }}>
        <div/>
        {hours.map(h=>(
          <div key={h} style={{
            fontSize:8, textAlign:'center', fontFamily:'monospace',
            color: h===utcNow?'#00d4aa':'#1e293b', fontWeight:h===utcNow?700:400,
          }}>{String(h).padStart(2,'0')}</div>
        ))}
      </div>
      {PAIRS.map(pair=>{
        const ph = heatmap[pair.key]||{};
        return (
          <div key={pair.key} style={{ display:'grid', gridTemplateColumns:`60px repeat(24,1fr)`, gap:2, marginBottom:2 }}>
            <div style={{ fontSize:9, color:'#334155', display:'flex', alignItems:'center', fontWeight:600 }}>
              {pair.label}
            </div>
            {hours.map(h=>{
              const val = ph[h]||0;
              const intensity = val/globalMax;
              const isSession = sessions.some(s=>h>=s.s&&h<s.e);
              const isNow = h===utcNow;
              return (
                <div key={h}
                  title={`${pair.label} ${String(h).padStart(2,'0')}:00 UTC — ${val} sweep${val!==1?'s':''}`}
                  style={{
                    height:18, borderRadius:3,
                    background: val>0 ? `rgba(0,212,170,${0.15+intensity*0.85})` : isSession ? '#0a0f1a' : '#060810',
                    border: isNow?'1px solid #00d4aa44':'1px solid transparent',
                    position:'relative', overflow:'hidden',
                  }}>
                  {val>0&&(
                    <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                      <span style={{ fontSize:7, fontWeight:700, color:intensity>0.5?'#04070f':'#00d4aa' }}>{val}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <div style={{ marginTop:16, display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ fontSize:9, color:'#1e293b' }}>Low</span>
        {[0.1,0.3,0.5,0.7,0.9,1].map(v=>(
          <div key={v} style={{ width:16, height:10, borderRadius:2, background:`rgba(0,212,170,${0.15+v*0.85})` }}/>
        ))}
        <span style={{ fontSize:9, color:'#00d4aa' }}>High</span>
      </div>
    </div>
  );
}

// ── StatsBar ──────────────────────────────────────────────────────────────────
function StatsBar({ log, phases }) {
  const resolved  = log.filter(s=>s.outcome!=='pending');
  const confirmed = resolved.filter(s=>s.outcome==='confirmed');
  const winRate   = resolved.length ? Math.round(confirmed.length/resolved.length*100) : null;
  const pending   = log.filter(s=>s.outcome==='pending').length;
  const manipNow  = Object.values(phases).filter(p=>p.phase==='manipulation').length;
  const accumNow  = Object.values(phases).filter(p=>p.phase==='accumulation').length;

  const stat = (label, value, color='#475569') => (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3, minWidth:60 }}>
      <span style={{ fontSize:16, fontWeight:900, color, fontFamily:'monospace', lineHeight:1 }}>{value}</span>
      <span style={{ fontSize:9, color:'#334155', textAlign:'center', lineHeight:1.3 }}>{label}</span>
    </div>
  );

  return (
    <div style={{ display:'flex', gap:0, background:'#06090f', borderRadius:12, border:'1px solid #0f1929',
      overflow:'hidden', marginBottom:14 }}>
      <div style={{ flex:1, padding:'12px 8px', display:'flex', justifyContent:'center', borderRight:'1px solid #0f1929' }}>
        {stat('Sweeps Logged', log.length, '#e2e8f0')}
      </div>
      <div style={{ flex:1, padding:'12px 8px', display:'flex', justifyContent:'center', borderRight:'1px solid #0f1929' }}>
        {stat('Win After Sweep', winRate!=null?`${winRate}%`:'—', winRate>60?'#00d4aa':winRate>40?'#f59e0b':'#ef4444')}
      </div>
      <div style={{ flex:1, padding:'12px 8px', display:'flex', justifyContent:'center', borderRight:'1px solid #0f1929' }}>
        {stat('Pending', pending, '#f59e0b')}
      </div>
      <div style={{ flex:1, padding:'12px 8px', display:'flex', justifyContent:'center', borderRight:'1px solid #0f1929' }}>
        {stat('⚡ Live Sweeps', manipNow, '#ef4444')}
      </div>
      <div style={{ flex:1, padding:'12px 8px', display:'flex', justifyContent:'center' }}>
        {stat('◎ Coiling', accumNow, '#f59e0b')}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function AlphaLab() {
  const [phases,           setPhases]           = useState({});
  const [loading,          setLoading]          = useState(new Set());
  const [sweepLog,         setSweepLog]         = useState([]);
  const [heatmap,          setHeatmap]          = useState({});
  const [scanning,         setScanning]         = useState(false);
  const [lastScan,         setLastScan]         = useState(null);
  const [tab,              setTab]              = useState('scanner');
  const [groupFilter,      setGroupFilter]      = useState('All');
  const [sessionFilter,    setSessionFilter]    = useState('All');
  const [selectedPair,     setSelectedPair]     = useState(null);
  const [backfilling,      setBackfilling]      = useState(false);
  const [backfillProgress, setBackfillProgress] = useState('');
  const [backfillDone,     setBackfillDone]     = useState(null);
  const [scanTF,           setScanTF]           = useState('H1');
  const [swingStrength,    setSwingStrength]    = useState(3);
  const [minWickPct,       setMinWickPct]       = useState(0);

  const prevManipCount = useRef(0);
  const hasOanda = !!getCreds()?.apiKey;

  useEffect(() => {
    const store = loadStore();
    if (store.sweepLog) setSweepLog(store.sweepLog);
    if (store.heatmap)  setHeatmap(store.heatmap);
  }, []);

  const scan = useCallback(async () => {
    if (!hasOanda || scanning) return;
    setScanning(true);
    setLoading(new Set(PAIRS.map(p=>p.key)));

    const tfCfg    = TF_CONFIG[scanTF];
    const store    = loadStore();
    const existLog = store.sweepLog || [];
    const hm       = store.heatmap  || {};
    const newPhases = {};
    const newSweeps = [];
    const utcHour   = new Date().getUTCHours();
    const resolveHrs = tfCfg.futureCandles * (scanTF==='M15'?0.25:scanTF==='M30'?0.5:scanTF==='H4'?4:1);

    await Promise.all(PAIRS.map(async pair => {
      const candles = await fetchCandles(pair.key, tfCfg.gran, tfCfg.liveCount);
      setLoading(prev => { const s=new Set(prev); s.delete(pair.key); return s; });
      if (!candles) return;

      const phase = detectPhase(candles, swingStrength, minWickPct);
      const atr   = computeATR(candles);
      const price = candles[candles.length-1].c;
      newPhases[pair.key] = { ...phase, atr, price };

      if (phase.phase==='manipulation') {
        const dedupWindow = resolveHrs * 60 * 60 * 1000;
        const recent = existLog.find(s=>
          s.pair===pair.key && s.tf===scanTF &&
          Date.now()-new Date(s.time).getTime() < dedupWindow
        );
        if (!recent) {
          newSweeps.push({
            id:          `${pair.key}_${scanTF}_${Date.now()}`,
            pair:        pair.key,
            label:       pair.label,
            time:        new Date().toISOString(),
            utcHour,
            swept:       phase.swept,
            level:       phase.level,
            expectedDir: phase.direction,
            entryPrice:  price,
            pip:         pair.pip,
            outcome:     'pending',
            pipsMoved:   0,
            tf:          scanTF,
            strength:    swingStrength,
          });
          if (!hm[pair.key]) hm[pair.key]={};
          hm[pair.key][utcHour] = (hm[pair.key][utcHour]||0)+1;
        }
      }

      existLog.forEach(s => {
        if (s.pair!==pair.key||s.outcome!=='pending'||(s.tf||'H1')!==scanTF) return;
        const hrs = (Date.now()-new Date(s.time).getTime())/(1000*60*60);
        if (hrs < resolveHrs * 0.5) return;
        const moved = (price-s.entryPrice)/s.pip;
        const expectedPos = s.expectedDir==='bullish';
        const moved20 = (expectedPos&&moved>20)||(!expectedPos&&moved<-20);
        s.outcome    = moved20 ? 'confirmed' : hrs > resolveHrs ? 'failed' : 'pending';
        s.pipsMoved  = Math.round(Math.abs(moved));
        s.resolvedAt = new Date().toISOString();
      });
    }));

    const merged = [...newSweeps, ...existLog].slice(0,400);
    saveStore({ sweepLog:merged, heatmap:hm });
    setPhases(newPhases);
    setSweepLog(merged);
    setHeatmap(hm);
    setLastScan(new Date());
    setScanning(false);
  }, [hasOanda, scanning, scanTF, swingStrength, minWickPct]);

  useEffect(() => {
    scan();
    const id = setInterval(scan, 15*60*1000);
    return () => clearInterval(id);
  }, []);

  const startBackfill = useCallback(async () => {
    if (!hasOanda || backfilling) return;
    setBackfilling(true);
    setBackfillDone(null);
    setBackfillProgress('Starting historical scan…');
    try {
      const result = await runBackfill(msg => setBackfillProgress(msg), scanTF, swingStrength, minWickPct);
      setSweepLog(result.sweeps);
      setHeatmap(result.heatmap);
      setBackfillDone(result.total);
      setBackfillProgress('');
    } catch {
      setBackfillProgress('Error during backfill');
    }
    setBackfilling(false);
  }, [hasOanda, backfilling]);

  // Sound alert when new live manipulation detected
  const liveManip = Object.entries(phases).filter(([,v])=>v.phase==='manipulation');
  useEffect(() => {
    if (liveManip.length > prevManipCount.current) playAlert();
    prevManipCount.current = liveManip.length;
  }, [liveManip.length]);

  // Feed filtered by TF + session
  const tfLog = useMemo(() =>
    sweepLog.filter(s => (s.tf || 'H1') === scanTF),
  [sweepLog, scanTF]);

  const filteredFeed = useMemo(() => {
    if (sessionFilter === 'All') return tfLog;
    return tfLog.filter(s => {
      const h = getETHour(s.time);
      if (sessionFilter === 'Asian')  return h >= 19 || h < 3;
      if (sessionFilter === 'London') return h >= 3  && h < 12;
      if (sessionFilter === 'NY')     return h >= 8  && h < 17;
      return true;
    });
  }, [tfLog, sessionFilter]);

  const groups       = ['All', 'Forex', 'Metals', 'Indices'];
  const filteredPairs = groupFilter === 'All' ? PAIRS : PAIRS.filter(p => p.group === groupFilter);

  const innerTabs = [
    { id:'scanner', label:'Phase Scanner' },
    { id:'feed',    label:`Sweep Feed (${filteredFeed.length})` },
    { id:'dna',     label:'Time DNA' },
    { id:'edge',    label:'Edge Breakdown' },
  ];

  return (
    <>
      {selectedPair && (
        <PairDetailModal
          pairKey={selectedPair}
          sweepLog={sweepLog}
          phases={phases}
          onClose={() => setSelectedPair(null)}
        />
      )}

      <div style={{ height:'100%', overflowY:'auto', background:'#04070f', padding:'14px 12px' }}>
        <style>{CSS}</style>

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14, gap:10, flexWrap:'wrap' }}>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontSize:16, fontWeight:900, color:'#f1f5f9', letterSpacing:'0.06em' }}>⚗ ALPHA LAB</span>
              {scanning && (
                <span style={{ fontSize:9, fontWeight:700, color:'#00d4aa', padding:'2px 7px',
                  borderRadius:10, background:'#00d4aa12', border:'1px solid #00d4aa44',
                  animation:'alphaGlow 1s infinite' }}>● SCANNING</span>
              )}
            </div>
            <div style={{ fontSize:10, color:'#334155', marginTop:3 }}>
              Market maker phase detection · Liquidity sweep tracker · Time pattern analysis
            </div>
          </div>

          <div style={{ display:'flex', flexDirection:'column', gap:5, alignItems:'flex-end' }}>
            <div style={{ display:'flex', gap:6 }}>
              <button onClick={startBackfill} disabled={backfilling||scanning||!hasOanda} style={{
                background: backfilling?'#090d18':'#0a1628',
                border:`1px solid ${backfilling?'#1e293b':'#1d4ed8'}`,
                borderRadius:8, color:backfilling?'#334155':'#60a5fa',
                fontSize:10, padding:'6px 12px',
                cursor:backfilling||scanning||!hasOanda?'not-allowed':'pointer', fontWeight:700,
              }}>
                {backfilling?'Loading…':`⏮ Load ${TF_HIST_LABEL[scanTF] || 'History'}`}
              </button>
              <button onClick={scan} disabled={scanning||!hasOanda} style={{
                background:'#090d18', border:'1px solid #1e293b', borderRadius:8,
                color:scanning?'#334155':'#e2e8f0', fontSize:11, padding:'6px 14px',
                cursor:scanning||!hasOanda?'not-allowed':'pointer', fontWeight:600,
              }}>
                {scanning?'Scanning…':'↻ Scan Now'}
              </button>
            </div>
            {backfilling && backfillProgress && (
              <div style={{ fontSize:9, color:'#60a5fa', animation:'alphaGlow 1s infinite' }}>
                {backfillProgress}
              </div>
            )}
            {backfillDone !== null && !backfilling && (
              <div style={{ fontSize:9, color:'#00d4aa' }}>✓ +{backfillDone} historical sweeps loaded</div>
            )}
            {lastScan && (
              <div style={{ fontSize:9, color:'#1e293b' }}>Last scan {lastScan.toLocaleTimeString()}</div>
            )}
          </div>
        </div>

        {!hasOanda && (
          <div style={{ textAlign:'center', padding:'48px 20px', color:'#334155', fontSize:13 }}>
            <div style={{ fontSize:32, marginBottom:10 }}>⚗</div>
            Connect OANDA to start detecting market maker phases.
          </div>
        )}

        {hasOanda && (
          <>
            {/* ── TF + Swing Strength selectors ───────────────────────── */}
          <div style={{ display:'flex', gap:6, alignItems:'center', marginBottom:12, flexWrap:'wrap',
            background:'#06090f', borderRadius:10, padding:'8px 12px', border:'1px solid #0f1929' }}>
            <span style={{ fontSize:9, color:'#475569', fontWeight:700, letterSpacing:'0.08em', flexShrink:0 }}>TIMEFRAME</span>
            {Object.entries(TF_CONFIG).map(([key, cfg]) => {
              const active = scanTF === key;
              const c = { M15:'#38bdf8', M30:'#818cf8', H1:'#00d4aa', H4:'#f59e0b' }[key];
              return (
                <button key={key} onClick={() => setScanTF(key)} style={{
                  padding:'4px 11px', borderRadius:12,
                  border:`1px solid ${active?c+'66':'#0f1929'}`,
                  background:active?`${c}18`:'transparent',
                  cursor:'pointer', fontSize:11, fontWeight:800,
                  color:active?c:'#334155', transition:'all 0.2s',
                }}>{cfg.label}</button>
              );
            })}
            <div style={{ width:1, height:16, background:'#0f1929', margin:'0 4px', flexShrink:0 }}/>
            <span style={{ fontSize:9, color:'#475569', fontWeight:700, letterSpacing:'0.08em', flexShrink:0 }}>SWING STRENGTH</span>
            {[2,3,4,5].map(n => {
              const active = swingStrength === n;
              return (
                <button key={n} onClick={() => setSwingStrength(n)} style={{
                  padding:'4px 10px', borderRadius:12,
                  border:`1px solid ${active?'#8b5cf666':'#0f1929'}`,
                  background:active?'#8b5cf618':'transparent',
                  cursor:'pointer', fontSize:11, fontWeight:800,
                  color:active?'#8b5cf6':'#334155', transition:'all 0.2s',
                }}>{n}</button>
              );
            })}
            <span style={{ fontSize:9, color:'#1e293b', marginLeft:2 }}>each side</span>
            <div style={{ width:1, height:16, background:'#0f1929', margin:'0 4px', flexShrink:0 }}/>
            <span style={{ fontSize:9, color:'#475569', fontWeight:700, letterSpacing:'0.08em', flexShrink:0 }}>MIN WICK</span>
            {[0, 10, 20, 30, 50].map(pct => {
              const active = minWickPct === pct;
              return (
                <button key={pct} onClick={() => setMinWickPct(pct)} style={{
                  padding:'4px 10px', borderRadius:12,
                  border:`1px solid ${active?'#ef444466':'#0f1929'}`,
                  background:active?'#ef444418':'transparent',
                  cursor:'pointer', fontSize:11, fontWeight:800,
                  color:active?'#ef4444':'#334155', transition:'all 0.2s',
                }}>{pct===0?'Off':`${pct}%`}</button>
              );
            })}
            <span style={{ fontSize:9, color:'#1e293b' }}>of ATR</span>
          </div>

          {/* ── Live sweep alert ─────────────────────────────────────── */}
            {liveManip.length>0 && (
              <div style={{ background:'#ef444410', border:'1px solid #ef444433', borderRadius:10,
                padding:'10px 14px', marginBottom:12, animation:'alphaGlow 1s infinite' }}>
                <div style={{ fontSize:11, fontWeight:800, color:'#ef4444', marginBottom:6 }}>
                  ⚡ LIVE MANIPULATION — {liveManip.length} pair{liveManip.length>1?'s':''} sweeping liquidity right now
                </div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                  {liveManip.map(([key,v])=>{
                    const pair = PAIRS.find(p=>p.key===key);
                    return (
                      <div key={key}
                        onClick={() => setSelectedPair(key)}
                        style={{ fontSize:10, fontWeight:700, cursor:'pointer',
                          color:'#ef4444', background:'#ef444418', padding:'3px 10px',
                          borderRadius:20, border:'1px solid #ef444444' }}>
                        {pair?.label} · {v.swept==='high'?'↑ HIGH':'↓ LOW'} swept →
                        <span style={{ color:'#00d4aa', marginLeft:4 }}>
                          expect {v.direction==='bullish'?'▲ UP':'▼ DOWN'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Stats bar ────────────────────────────────────────────── */}
            <StatsBar log={tfLog} phases={phases}/>

            {/* ── Inner tabs ───────────────────────────────────────────── */}
            <div style={{ display:'flex', gap:4, marginBottom:14, background:'#06090f',
              borderRadius:10, padding:4, border:'1px solid #0f1929', overflowX:'auto' }}>
              {innerTabs.map(t=>(
                <button key={t.id} onClick={()=>setTab(t.id)} style={{
                  flex:1, padding:'7px 4px', borderRadius:7, border:'none', cursor:'pointer',
                  fontSize:10, fontWeight:700, transition:'all 0.2s', whiteSpace:'nowrap',
                  background: tab===t.id?'#0f1929':'transparent',
                  color:      tab===t.id?'#00d4aa':'#334155',
                }}>{t.label}</button>
              ))}
            </div>

            {/* ── Phase Scanner ─────────────────────────────────────────── */}
            {tab==='scanner' && (
              <>
                <div style={{ display:'flex', gap:4, marginBottom:12, flexWrap:'wrap' }}>
                  {groups.map(g => {
                    const count = g==='All' ? PAIRS.length : PAIRS.filter(p=>p.group===g).length;
                    const active = groupFilter===g;
                    const gc = { All:'#475569', Forex:'#8b5cf6', Metals:'#f59e0b', Indices:'#22c55e' }[g];
                    return (
                      <button key={g} onClick={()=>setGroupFilter(g)} style={{
                        padding:'4px 10px', borderRadius:16,
                        border:`1px solid ${active?gc+'66':'#0f1929'}`,
                        background:active?`${gc}18`:'transparent', cursor:'pointer',
                        fontSize:10, fontWeight:700,
                        color:active?gc:'#334155', transition:'all 0.2s',
                      }}>
                        {g} <span style={{ fontSize:9, opacity:0.7 }}>({count})</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(155px,1fr))', gap:10 }}>
                  {filteredPairs.map(pair=>(
                    <PhaseCard key={pair.key} pair={pair}
                      data={phases[pair.key]}
                      loading={loading.has(pair.key)}
                      onClick={() => setSelectedPair(pair.key)}
                    />
                  ))}
                </div>
              </>
            )}

            {/* ── Sweep Feed ───────────────────────────────────────────── */}
            {tab==='feed' && (
              <>
                <div style={{ display:'flex', gap:4, marginBottom:10, alignItems:'center', flexWrap:'wrap' }}>
                  {['All','Asian','London','NY'].map(sess => {
                    const c = { All:'#475569', Asian:'#f59e0b', London:'#8b5cf6', NY:'#22c55e' }[sess];
                    const active = sessionFilter===sess;
                    return (
                      <button key={sess} onClick={()=>setSessionFilter(sess)} style={{
                        padding:'4px 10px', borderRadius:14,
                        border:`1px solid ${active?c+'66':'#0f1929'}`,
                        background:active?`${c}18`:'transparent', cursor:'pointer',
                        fontSize:10, fontWeight:700, color:active?c:'#334155', transition:'all 0.2s',
                      }}>{sess}</button>
                    );
                  })}
                  <span style={{ marginLeft:'auto', fontSize:10, color:'#334155' }}>
                    {filteredFeed.length} entries · click any row to deep dive
                  </span>
                </div>
                <div style={{ background:'#06090f', borderRadius:12, border:'1px solid #0f1929', overflow:'hidden' }}>
                  {filteredFeed.length===0 ? (
                    <div style={{ textAlign:'center', padding:'48px 20px', color:'#1e293b', fontSize:12 }}>
                      {sweepLog.length===0
                        ? 'No sweeps logged yet. Scans run every 15 minutes automatically.'
                        : 'No sweeps in this session filter.'}
                    </div>
                  ) : filteredFeed.map((s,i)=>(
                    <SweepEntry key={s.id} s={s} idx={i} onPairClick={setSelectedPair}/>
                  ))}
                </div>
              </>
            )}

            {/* ── Time DNA ─────────────────────────────────────────────── */}
            {tab==='dna' && (
              <div style={{ background:'#06090f', borderRadius:12, border:'1px solid #0f1929', padding:'14px' }}>
                {Object.keys(heatmap).length===0 ? (
                  <div style={{ textAlign:'center', padding:'48px 20px', color:'#1e293b', fontSize:12 }}>
                    Heatmap builds as sweeps are detected. Load 30d history for instant data.
                  </div>
                ) : (
                  <TimeDNA heatmap={heatmap}/>
                )}
              </div>
            )}

            {/* ── Edge Breakdown ───────────────────────────────────────── */}
            {tab==='edge' && (
              <EdgeBreakdown sweepLog={tfLog} onPairClick={setSelectedPair}/>
            )}
          </>
        )}
      </div>
    </>
  );
}

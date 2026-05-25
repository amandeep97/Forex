import { useState, useEffect, useCallback, useRef } from 'react';
import { ghRead, ghWrite, isGithubConfigured } from '../utils/githubSync';

// ── SMC engine (browser port of vps-bot/src/smc.js) ──────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = (gains / period) / ((losses / period) || 0.0001);
  return +(100 - 100 / (1 + rs)).toFixed(1);
}

function findSwings(candles, look = 3) {
  const n = candles.length;
  const highs = [], lows = [];
  for (let i = look; i < n - look; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= look; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) hi = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) lo = false;
    }
    if (hi) highs.push({ price: candles[i].h, idx: i });
    if (lo)  lows.push({ price: candles[i].l, idx: i });
  }
  return { highs, lows };
}

function detectStructure(candles) {
  const { highs, lows } = findSwings(candles, 3);
  if (highs.length < 2 || lows.length < 2) return 'ranging';
  const lastH1 = highs[highs.length - 2], lastH2 = highs[highs.length - 1];
  const lastL1 = lows[lows.length - 2],   lastL2 = lows[lows.length - 1];
  if (lastH2.price > lastH1.price && lastL2.price > lastL1.price) return 'bullish';
  if (lastH2.price < lastH1.price && lastL2.price < lastL1.price) return 'bearish';
  return 'ranging';
}

function detectBOS(candles) {
  if (candles.length < 20) return false;
  const n = candles.length;
  const { highs, lows } = findSwings(candles.slice(0, n - 1), 2);
  for (let i = Math.max(5, n - 15); i < n; i++) {
    const c = candles[i];
    if (highs.some(s => s.idx < i - 1 && c.c > s.price)) return true;
    if (lows.some(s  => s.idx < i - 1 && c.c < s.price)) return true;
  }
  return false;
}

function detectOrderBlocks(candles) {
  if (candles.length < 10) return [];
  const n   = candles.length;
  const avg = candles.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / n || 1;
  const obs = [];
  for (let i = 1; i < n - 3; i++) {
    const c = candles[i], nx = candles[i + 1], nn = candles[i + 2];
    if (Math.abs(nn.c - nx.o) < avg * 1.2) continue;
    if (c.c < c.o && nx.c > nx.o && nn.c > c.o) obs.push({ type: 'bullish', top: c.o,   bottom: c.c });
    if (c.c > c.o && nx.c < nx.o && nn.c < c.o) obs.push({ type: 'bearish', top: c.c,   bottom: c.o });
  }
  return obs.slice(-5);
}

function detectFVGs(candles) {
  if (candles.length < 5) return [];
  const avg  = candles.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / candles.length || 1;
  const fvgs = [];
  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i], c3 = candles[i + 2];
    const gap = c1.h < c3.l ? c3.l - c1.h : (c1.l > c3.h ? c1.l - c3.h : 0);
    if (gap < avg * 0.1) continue;
    if (c1.h < c3.l) fvgs.push({ type: 'bullish', top: c3.l, bottom: c1.h });
    else              fvgs.push({ type: 'bearish', top: c1.l, bottom: c3.h });
  }
  return fvgs.slice(-6);
}

function detectOTE(candles) {
  if (candles.length < 15) return { bull: false, bear: false };
  const vis = candles.slice(-40);
  const n   = vis.length;
  const cp  = vis[n - 1].c;
  let swHigh = -Infinity, swHighIdx = 0, swLow = Infinity, swLowIdx = 0;
  for (let i = 0; i < n; i++) {
    if (vis[i].h > swHigh) { swHigh = vis[i].h; swHighIdx = i; }
    if (vis[i].l < swLow)  { swLow  = vis[i].l; swLowIdx  = i; }
  }
  const range = swHigh - swLow;
  if (!range) return { bull: false, bear: false };
  const bull = swHighIdx < swLowIdx && cp >= swLow + range * 0.618 && cp <= swLow + range * 0.786;
  const bear = swLowIdx < swHighIdx && cp >= swHigh - range * 0.786 && cp <= swHigh - range * 0.618;
  return { bull, bear };
}

function detectLiqSweep(candles) {
  if (candles.length < 10) return { bull: false, bear: false };
  const ref     = candles.slice(-15, -3);
  const refLow  = Math.min(...ref.map(c => c.l));
  const refHigh = Math.max(...ref.map(c => c.h));
  const recent  = candles.slice(-3);
  return {
    bull: recent.some(c => c.l < refLow  && c.c > refLow),
    bear: recent.some(c => c.h > refHigh && c.c < refHigh),
  };
}

function detectPriceZone(candles) {
  const n  = candles.length;
  const sl = candles.slice(-20);
  const hi = Math.max(...sl.map(c => c.h));
  const lo = Math.min(...sl.map(c => c.l));
  const cp = candles[n - 1].c;
  const lvl = (hi - lo) ? (cp - lo) / (hi - lo) : 0.5;
  if (lvl < 0.45) return 'discount';
  if (lvl > 0.55) return 'premium';
  return 'equilibrium';
}

function getSession() {
  const h = new Date().getUTCHours();
  const s = [];
  if (h >= 0  && h < 8)  s.push('asian');
  if (h >= 7  && h < 16) s.push('london');
  if (h >= 12 && h < 16) s.push('overlap');
  if (h >= 13 && h < 22) s.push('newyork');
  return s;
}

async function scanPair(pair, strat) {
  const key = localStorage.getItem('oanda_key');
  const env = localStorage.getItem('oanda_env') || 'practice';
  if (!key) return { pair, pass: false, reason: 'Connect OANDA first', rsi: null, structure: null };
  const base = env === 'live' ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3';
  try {
    const res = await fetch(
      `${base}/instruments/${pair}/candles?granularity=${strat.timeframe || 'H1'}&count=100&price=M`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) return { pair, pass: false, reason: `OANDA ${res.status}`, rsi: null, structure: null };
    const { candles } = await res.json();
    const cs = (candles || []).filter(c => c.complete).map(c => ({
      o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c,
    }));
    if (cs.length < 20) return { pair, pass: false, reason: 'Not enough candles', rsi: null, structure: null };

    const rsi       = calcRSI(cs.map(c => c.c));
    const structure = detectStructure(cs);
    const cp        = cs[cs.length - 1].c;
    const atr       = cs.slice(-14).reduce((s, c) => s + (c.h - c.l), 0) / 14;
    const cond      = strat.conditions || {};
    const dir       = strat.direction || 'both';
    const sessions  = getSession();

    // Session
    const allowedSess = cond.sessions?.length ? cond.sessions : [];
    if (allowedSess.length && !sessions.some(s => allowedSess.includes(s)))
      return { pair, pass: false, reason: `Session: ${sessions.join('/')||'none'} ∉ [${allowedSess.join(',')}]`, rsi, structure };

    // Market structure
    if (cond.structure && cond.structure !== 'any' && structure !== cond.structure)
      return { pair, pass: false, reason: `Structure: ${structure} ≠ ${cond.structure}`, rsi, structure };

    // RSI
    if (cond.rsiFilter?.enabled && rsi != null) {
      const ok = cond.rsiFilter.comparison === 'above' ? rsi > cond.rsiFilter.value : rsi < cond.rsiFilter.value;
      if (!ok) return { pair, pass: false, reason: `RSI ${rsi} not ${cond.rsiFilter.comparison} ${cond.rsiFilter.value}`, rsi, structure };
    }

    // BOS
    if (cond.requireBOS && !detectBOS(cs))
      return { pair, pass: false, reason: 'No BOS/CHoCH detected', rsi, structure };

    // Price zone
    if (cond.priceZone && cond.priceZone !== 'any') {
      const zone = detectPriceZone(cs);
      if (zone !== cond.priceZone)
        return { pair, pass: false, reason: `Price zone: ${zone} ≠ ${cond.priceZone}`, rsi, structure };
    }

    // Order Block
    if (cond.requireOB) {
      const obs    = detectOrderBlocks(cs);
      const obDir  = cond.obDir || 'any';
      const bullOB = obs.some(ob => ob.type === 'bullish' && cp >= ob.bottom && cp <= ob.top + atr);
      const bearOB = obs.some(ob => ob.type === 'bearish' && cp <= ob.top   && cp >= ob.bottom - atr);
      const ok     = obDir === 'bullish' ? bullOB : obDir === 'bearish' ? bearOB : (bullOB || bearOB);
      if (!ok) return { pair, pass: false, reason: `No ${obDir} OB at price`, rsi, structure };
    }

    // FVG
    if (cond.requireFVG) {
      const fvgs   = detectFVGs(cs);
      const fvgDir = cond.fvgDir || 'any';
      const bullF  = fvgs.some(f => f.type === 'bullish' && cp >= f.bottom && cp <= f.top + atr);
      const bearF  = fvgs.some(f => f.type === 'bearish' && cp <= f.top   && cp >= f.bottom - atr);
      const ok     = fvgDir === 'bullish' ? bullF : fvgDir === 'bearish' ? bearF : (bullF || bearF);
      if (!ok) return { pair, pass: false, reason: `No ${fvgDir} FVG at price`, rsi, structure };
    }

    // OTE
    if (cond.requireOTE) {
      const ote = detectOTE(cs);
      const ok  = (dir === 'long') ? ote.bull : (dir === 'short') ? ote.bear : (ote.bull || ote.bear);
      if (!ok) return { pair, pass: false, reason: 'Price not in OTE zone (0.618–0.786)', rsi, structure };
    }

    // Liquidity sweep
    if (cond.requireLiqSweep) {
      const liq = detectLiqSweep(cs);
      const ok  = (dir === 'long') ? liq.bull : (dir === 'short') ? liq.bear : (liq.bull || liq.bear);
      if (!ok) return { pair, pass: false, reason: 'No liquidity sweep detected', rsi, structure };
    }

    return { pair, pass: true, reason: 'All conditions met', rsi, structure };
  } catch (e) {
    return { pair, pass: false, reason: e.message, rsi: null, structure: null };
  }
}

// ── Scan panel component ──────────────────────────────────────────────────────
function ScanPanel({ strat }) {
  const [scanning,  setScanning]  = useState(false);
  const [results,   setResults]   = useState(null);
  const [lastScan,  setLastScan]  = useState(null);
  const abortRef  = useRef(false);
  const timerRef  = useRef(null);

  const scan = async () => {
    const pairs = (strat.pairs?.filter(p => p !== 'ALL') || [strat.pair].filter(Boolean));
    if (!pairs.length) return;
    abortRef.current = false;
    setScanning(true); setResults(null);

    const all = [];
    // Scan in batches of 4 to avoid rate limits
    for (let i = 0; i < pairs.length; i += 4) {
      if (abortRef.current) break;
      const batch = await Promise.all(pairs.slice(i, i + 4).map(p => scanPair(p, strat)));
      all.push(...batch);
      setResults([...all]); // show progress
    }
    setScanning(false);
    if (!abortRef.current) setLastScan(new Date());
  };

  // Auto-scan on mount, then refresh every 5 minutes
  useEffect(() => {
    scan();
    timerRef.current = setInterval(scan, 5 * 60 * 1000);
    return () => {
      abortRef.current = true;
      clearInterval(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strat.id]);

  const passing = results?.filter(r => r.pass) || [];
  const failing = results?.filter(r => !r.pass) || [];
  const total = (strat.pairs?.filter(p => p !== 'ALL') || [strat.pair].filter(Boolean)).length;
  const scanned = results?.length || 0;
  const lastScanLabel = lastScan ? lastScan.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div style={{ marginTop: 8 }}>
      {/* Status badge — SMCPro style */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {!results && !scanning && (
          <div style={{ padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
            background: '#1e293b', border: '1px solid #334155', color: '#64748b' }}>
            ⏳ Initialising scan…
          </div>
        )}
        {scanning && (
          <div style={{ padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
            background: '#1e293b', border: '1px solid #334155', color: '#94a3b8' }}>
            🔄 Scanning… {scanned}/{total}
          </div>
        )}
        {results && !scanning && (
          <>
            <div style={{ padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
              background: passing.length > 0 ? '#22c55e22' : '#1e293b',
              color: passing.length > 0 ? '#22c55e' : '#64748b',
              border: passing.length > 0 ? '1px solid #22c55e44' : '1px solid #334155' }}>
              {passing.length > 0 ? `🎯 ${passing.length} pairs matching now` : '⏳ 0 pairs matching — waiting for signal'}
            </div>
            {/* Matching pair chips — tap to trade */}
            {passing.slice(0, 6).map(r => (
              <button key={r.pair}
                onClick={() => window.dispatchEvent(new CustomEvent('trade-signal-pair', { detail: { pair: r.pair } }))}
                style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44' }}>
                {r.pair.replace('_','/')}
              </button>
            ))}
            {passing.length > 6 && (
              <span style={{ fontSize: 10, color: '#64748b' }}>+{passing.length - 6} more</span>
            )}
            <button onClick={scan} title="Refresh scan"
              style={{ fontSize: 12, color: '#475569', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>↻</button>
            {lastScanLabel && (
              <span style={{ fontSize: 9, color: '#334155' }}>{lastScanLabel}</span>
            )}
          </>
        )}
      </div>

      {/* Failing pairs — collapsed details */}
      {results && failing.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 10, color: '#475569', cursor: 'pointer', listStyle: 'none', userSelect: 'none' }}>
            ✗ {failing.length} pairs not matching — tap to see why
          </summary>
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 8 }}>
            {failing.map(r => (
              <div key={r.pair} style={{ fontSize: 10, color: '#475569', display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ minWidth: 72, color: '#334155', fontWeight: 600 }}>{r.pair.replace('_','/')}</span>
                <span>{r.reason}</span>
                {r.rsi != null && <span style={{ marginLeft: 'auto', color: '#334155' }}>RSI {r.rsi}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────
const PAIR_GROUPS = [
  { label: 'Majors', color: '#38bdf8', pairs: [
    { v:'EUR_USD', l:'EUR/USD' }, { v:'GBP_USD', l:'GBP/USD' }, { v:'USD_JPY', l:'USD/JPY' },
    { v:'USD_CHF', l:'USD/CHF' }, { v:'AUD_USD', l:'AUD/USD' }, { v:'NZD_USD', l:'NZD/USD' },
    { v:'USD_CAD', l:'USD/CAD' },
  ]},
  { label: 'Minors', color: '#a78bfa', pairs: [
    { v:'EUR_GBP', l:'EUR/GBP' }, { v:'EUR_JPY', l:'EUR/JPY' }, { v:'EUR_AUD', l:'EUR/AUD' },
    { v:'EUR_CAD', l:'EUR/CAD' }, { v:'EUR_CHF', l:'EUR/CHF' }, { v:'GBP_JPY', l:'GBP/JPY' },
    { v:'GBP_AUD', l:'GBP/AUD' }, { v:'GBP_CAD', l:'GBP/CAD' }, { v:'GBP_CHF', l:'GBP/CHF' },
    { v:'AUD_JPY', l:'AUD/JPY' }, { v:'CAD_JPY', l:'CAD/JPY' }, { v:'CHF_JPY', l:'CHF/JPY' },
    { v:'NZD_JPY', l:'NZD/JPY' },
  ]},
  { label: 'Metals', color: '#fbbf24', pairs: [
    { v:'XAU_USD', l:'GOLD' }, { v:'XAG_USD', l:'SILVER' },
  ]},
  { label: 'Oil', color: '#f97316', pairs: [
    { v:'BCO_USD', l:'BRENT' }, { v:'WTICO_USD', l:'WTI' },
  ]},
  { label: 'Indices', color: '#34d399', pairs: [
    { v:'SPX500_USD', l:'SPX500' }, { v:'NAS100_USD', l:'NAS100' },
    { v:'US30_USD', l:'US30' }, { v:'UK100_GBP', l:'UK100' }, { v:'DE30_EUR', l:'DE30' },
  ]},
];
const ALL_PAIRS = PAIR_GROUPS.flatMap(g => g.pairs.map(p => p.v));

const TFS = [
  { v:'M1',  l:'1 Min' },
  { v:'M5',  l:'5 Min' },
  { v:'M15', l:'15 Min' },
  { v:'M30', l:'30 Min' },
  { v:'H1',  l:'1 Hour' },
  { v:'H2',  l:'2 Hour' },
  { v:'H4',  l:'4 Hour' },
  { v:'H6',  l:'6 Hour' },
  { v:'H12', l:'12 Hour' },
  { v:'D',   l:'Daily' },
  { v:'W',   l:'Weekly' },
];

const SESSIONS = [
  { v:'asian',   l:'Asian   (00–08 UTC)' },
  { v:'london',  l:'London  (07–16 UTC)' },
  { v:'overlap', l:'Overlap (12–16 UTC)' },
  { v:'newyork', l:'New York(13–22 UTC)' },
];

const SL_METHODS = [
  { v:'swing', l:'Swing Low / High' },
  { v:'ob',    l:'Order Block Base' },
  { v:'atr',   l:'ATR ×' },
  { v:'fixed', l:'Fixed Pips' },
];

const TP_METHODS = [
  { v:'rr',    l:'R:R Ratio' },
  { v:'fib',   l:'Fib Extension' },
  { v:'fixed', l:'Fixed Pips' },
];

// ── Strategy templates ────────────────────────────────────────────────────────
const TEMPLATES = [
  { v:'blank',        l:'— Blank —',                 data: null },
  { v:'ict_long',     l:'ICT London Long (BOS+OB)',   data: { name:'ICT London Long',   pairs:['EUR_USD','GBP_USD'], timeframe:'H1',  direction:'long',  conditions:{ structure:'bullish', requireBOS:true,  requireOB:true,  requireFVG:false, requireOTE:false, sessions:['london'],           rsiFilter:{enabled:false,comparison:'below',value:70} }, risk:{ riskType:'percent', riskPercent:1, riskUsdt:10, slMethod:'swing', slAtr:1.5, slPips:20, tpMethod:'rr', rrRatio:2,   tpFibLevel:1.618 } } },
  { v:'ict_short',    l:'ICT NY Short (BOS+FVG)',     data: { name:'ICT NY Short',       pairs:['GBP_USD','EUR_USD'], timeframe:'H1',  direction:'short', conditions:{ structure:'bearish', requireBOS:true,  requireOB:false, requireFVG:true,  requireOTE:false, sessions:['newyork'],          rsiFilter:{enabled:false,comparison:'above',value:30} }, risk:{ riskType:'percent', riskPercent:1, riskUsdt:10, slMethod:'swing', slAtr:1.5, slPips:20, tpMethod:'rr', rrRatio:2,   tpFibLevel:1.618 } } },
  { v:'ote_scalp',    l:'OTE Scalp M15',              data: { name:'OTE Scalp',          pairs:['EUR_USD'], timeframe:'M15', direction:'both',  conditions:{ structure:'any',     requireBOS:true,  requireOB:false, requireFVG:false, requireOTE:true,  sessions:['london','overlap'],  rsiFilter:{enabled:false,comparison:'below',value:70} }, risk:{ riskType:'percent', riskPercent:0.5,riskUsdt:5, slMethod:'atr',   slAtr:1.0, slPips:10, tpMethod:'rr', rrRatio:2,   tpFibLevel:1.618 } } },
  { v:'premium_fade', l:'Premium Fade (OB+FVG)',      data: { name:'Premium Fade',       pairs:['XAU_USD'], timeframe:'H4',  direction:'short', conditions:{ structure:'bearish', requireBOS:true,  requireOB:true,  requireFVG:true,  requireOTE:false, sessions:['london','newyork'],  rsiFilter:{enabled:true, comparison:'above',value:70} }, risk:{ riskType:'percent', riskPercent:1, riskUsdt:10, slMethod:'swing', slAtr:1.5, slPips:20, tpMethod:'rr', rrRatio:3,   tpFibLevel:1.618 } } },
  { v:'full_ict',     l:'Full ICT Setup (7 Majors)',  data: { name:'Full ICT Setup',     pairs:['EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','NZD_USD','USD_CAD'], timeframe:'H1',  direction:'both',  conditions:{ structure:'any',     requireBOS:true,  requireOB:true,  requireFVG:true,  requireOTE:true,  sessions:['london','newyork'],  rsiFilter:{enabled:false,comparison:'below',value:70} }, risk:{ riskType:'percent', riskPercent:1, riskUsdt:10, slMethod:'swing', slAtr:1.5, slPips:20, tpMethod:'rr', rrRatio:2.5, tpFibLevel:1.618 } } },
  { v:'gold_h4',      l:'Gold H4 Structure',          data: { name:'Gold H4 Structure',  pairs:['XAU_USD'], timeframe:'H4',  direction:'both',  conditions:{ structure:'any',     requireBOS:true,  requireOB:true,  requireFVG:false, requireOTE:false, sessions:['london','newyork'],  rsiFilter:{enabled:false,comparison:'below',value:70} }, risk:{ riskType:'percent', riskPercent:1, riskUsdt:10, slMethod:'atr',   slAtr:2.0, slPips:50, tpMethod:'rr', rrRatio:2,   tpFibLevel:1.618 } } },
  { v:'asian_range',  l:'Asian Session Range Break',  data: { name:'Asian Range Break',  pairs:['EUR_USD','GBP_USD','USD_JPY'], timeframe:'M30', direction:'both',  conditions:{ structure:'any',     requireBOS:true,  requireOB:false, requireFVG:false, requireOTE:false, sessions:['london'],            rsiFilter:{enabled:false,comparison:'below',value:70} }, risk:{ riskType:'percent', riskPercent:0.5,riskUsdt:5, slMethod:'fixed', slAtr:1.5, slPips:15, tpMethod:'rr', rrRatio:2,   tpFibLevel:1.618 } } },
];

const DEFAULT_STRAT = {
  id: '', name: 'New Strategy', enabled: false,
  pairs: ['EUR_USD'], timeframe: 'H1', direction: 'both',
  conditions: {
    structure: 'any', requireBOS: false,
    priceZone: 'any',
    requireLiqSweep: false,
    obDir: 'any', requireOB: false, requireOBTap: false,
    fvgDir: 'any', requireFVG: false, requireFVGTap: false,
    requireOTE: false,
    candlePattern: 'any',
    emaFilter:  { enabled: false, period: 200, side: 'above' },
    vwapFilter: { enabled: false, side: 'above' },
    sessions: ['london'],
    rsiFilter: { enabled: false, comparison: 'below', value: 70 },
  },
  risk: {
    riskType: 'percent', riskPercent: 1, riskUsdt: 10,
    slMethod: 'swing', slAtr: 1.5, slPips: 20,
    tpMethod: 'rr', rrRatio: 2, tpFibLevel: 1.618,
  },
};

// ── Small UI helpers ──────────────────────────────────────────────────────────
function Label({ children }) { return <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, letterSpacing: '0.04em' }}>{children}</span>; }
function FieldRow({ label, children }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
    <Label>{label}</Label>
    <div style={{ marginLeft: 'auto' }}>{children}</div>
  </div>;
}
function Toggle({ checked, onChange }) {
  return <button onClick={() => onChange(!checked)} style={{ width: 40, height: 22, borderRadius: 11, background: checked ? '#00d4aa' : '#1e293b', border: 'none', position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}>
    <span style={{ position: 'absolute', top: 3, left: checked ? 20 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }}/>
  </button>;
}
function Select({ value, onChange, options, style = {} }) {
  return <select value={value} onChange={e => onChange(e.target.value)}
    style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', fontSize: 11, ...style }}>
    {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
  </select>;
}
function NumberInput({ value, onChange, min, max, step = 1, style = {} }) {
  return <input type="number" value={value} min={min} max={max} step={step}
    onChange={e => onChange(+e.target.value)}
    style={{ width: 70, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', fontSize: 11, textAlign: 'right', ...style }}/>;
}
function CondChip({ active, color, onClick, children }) {
  return <button onClick={onClick} style={{ padding: '3px 9px', borderRadius: 4, fontSize: 11, fontWeight: 700, border: `1px solid ${active ? color + '88' : 'var(--border)'}`, background: active ? color + '22' : 'var(--bg2)', color: active ? color : 'var(--text3)', cursor: 'pointer', transition: 'all 0.12s' }}>{children}</button>;
}

// ── Strategy form ─────────────────────────────────────────────────────────────
function StrategyEditor({ strat, onSave, onCancel }) {
  // Normalise old strategies that used `pair` (string) to `pairs` (array)
  const [s, setS] = useState(() => {
    const clone = JSON.parse(JSON.stringify(strat));
    if (!clone.pairs) clone.pairs = clone.pair ? [clone.pair] : ['EUR_USD'];
    return clone;
  });
  const set  = (path, val) => setS(prev => {
    const clone = JSON.parse(JSON.stringify(prev));
    const parts = path.split('.');
    let obj = clone;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = val;
    return clone;
  });
  const toggleSession = (v) => {
    const cur = s.conditions.sessions || [];
    set('conditions.sessions', cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v]);
  };
  const togglePair = (v) => {
    const cur = s.pairs || [];
    setS(prev => ({ ...prev, pairs: cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v] }));
  };
  const selectGroupPairs = (groupPairs) => {
    const vals = groupPairs.map(p => p.v);
    const cur = s.pairs || [];
    const allSelected = vals.every(v => cur.includes(v));
    setS(prev => ({
      ...prev,
      pairs: allSelected ? cur.filter(v => !vals.includes(v)) : [...new Set([...cur, ...vals])],
    }));
  };

  const applyTemplate = (tplVal) => {
    const tpl = TEMPLATES.find(t => t.v === tplVal);
    if (!tpl?.data) return;
    setS(prev => ({ ...JSON.parse(JSON.stringify(tpl.data)), id: prev.id }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>

      {/* Template picker */}
      <section>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Start from Template</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TEMPLATES.filter(t => t.v !== 'blank').map(t => (
            <button key={t.v} onClick={() => applyTemplate(t.v)}
              style={{ padding: '4px 10px', borderRadius: 4, fontSize: 10, fontWeight: 600, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {t.l}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>Click a template to pre-fill — you can then customise below</div>
      </section>

      {/* Name + pair + TF */}
      <section>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>General</div>
        <FieldRow label="Strategy Name">
          <input value={s.name} onChange={e => set('name', e.target.value)}
            style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px', fontSize: 12, width: 160 }}/>
        </FieldRow>
        {/* Pairs — chip multi-select grouped */}
        <div style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Label>Pairs ({(s.pairs||[]).length} selected)</Label>
            <button onClick={() => setS(p => ({ ...p, pairs: ALL_PAIRS }))}
              style={{ marginLeft: 'auto', fontSize: 9, padding: '2px 7px', borderRadius: 3, background: '#00d4aa22', color: '#00d4aa', border: '1px solid #00d4aa44', cursor: 'pointer' }}>All</button>
            <button onClick={() => setS(p => ({ ...p, pairs: [] }))}
              style={{ fontSize: 9, padding: '2px 7px', borderRadius: 3, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)', cursor: 'pointer' }}>Clear</button>
          </div>
          {PAIR_GROUPS.map(grp => (
            <div key={grp.label} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: grp.color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{grp.label}</span>
                <button onClick={() => selectGroupPairs(grp.pairs)}
                  style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'none', color: 'var(--text3)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                  {grp.pairs.every(p => (s.pairs||[]).includes(p.v)) ? 'Deselect' : 'Select'} all
                </button>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {grp.pairs.map(p => {
                  const active = (s.pairs||[]).includes(p.v);
                  return <button key={p.v} onClick={() => togglePair(p.v)}
                    style={{ padding: '3px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: 'pointer',
                      border: `1px solid ${active ? grp.color + '88' : 'var(--border)'}`,
                      background: active ? grp.color + '22' : 'var(--bg2)',
                      color: active ? grp.color : 'var(--text3)' }}>
                    {p.l}
                  </button>;
                })}
              </div>
            </div>
          ))}
          {(s.pairs||[]).length === 0 && (
            <div style={{ fontSize: 10, color: '#ef4444', marginTop: 4 }}>Select at least one pair</div>
          )}
        </div>
        <FieldRow label="Timeframe">
          <Select value={s.timeframe} onChange={v => set('timeframe', v)} options={TFS}/>
        </FieldRow>
        <FieldRow label="Direction">
          <Select value={s.direction} onChange={v => set('direction', v)} options={[{ v:'both',l:'Both (follow structure)'},{v:'long',l:'Long only'},{v:'short',l:'Short only'}]}/>
        </FieldRow>
        <FieldRow label="Enabled">
          <Toggle checked={s.enabled} onChange={v => set('enabled', v)}/>
        </FieldRow>
      </section>

      {/* Conditions */}
      <section>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Entry Conditions</div>

        {/* Market Structure */}
        <FieldRow label="Market Structure">
          <Select value={s.conditions.structure} onChange={v => set('conditions.structure', v)}
            options={[{v:'any',l:'Any'},{v:'bullish',l:'Bullish'},{v:'bearish',l:'Bearish'}]}/>
        </FieldRow>
        <FieldRow label="Require BOS / CHoCH">
          <Toggle checked={!!s.conditions.requireBOS} onChange={v => set('conditions.requireBOS', v)}/>
        </FieldRow>

        {/* Price Zone */}
        <FieldRow label="Price Zone">
          <Select value={s.conditions.priceZone||'any'} onChange={v => set('conditions.priceZone', v)}
            options={[{v:'any',l:'Any'},{v:'premium',l:'Premium (top 25%)'},{v:'discount',l:'Discount (bottom 25%)'},{v:'equilibrium',l:'Equilibrium (middle)'}]}/>
        </FieldRow>

        {/* Liquidity */}
        <FieldRow label="Liquidity Sweep">
          <Toggle checked={!!s.conditions.requireLiqSweep} onChange={v => set('conditions.requireLiqSweep', v)}/>
        </FieldRow>
        {s.conditions.requireLiqSweep && (
          <div style={{ padding: '2px 0 6px 12px', borderBottom: '1px solid var(--border)', fontSize: 10, color: 'var(--text3)' }}>
            Recent sweep of swing highs (for shorts) or swing lows (for longs)
          </div>
        )}

        {/* Order Block */}
        <div style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Label>Order Block</Label>
            <div style={{ marginLeft: 'auto' }}>
              <Select value={s.conditions.obDir||'any'} onChange={v => set('conditions.obDir', v)}
                options={[{v:'any',l:'Any'},{v:'bullish',l:'Bullish OB'},{v:'bearish',l:'Bearish OB'}]}/>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>Require OB</span>
            <Toggle checked={!!s.conditions.requireOB} onChange={v => set('conditions.requireOB', v)}/>
            <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>OB Tap</span>
            <Toggle checked={!!s.conditions.requireOBTap} onChange={v => set('conditions.requireOBTap', v)}/>
          </div>
          {s.conditions.requireOBTap && (
            <div style={{ fontSize: 10, color: 'var(--text3)', paddingLeft: 8, marginTop: 3 }}>Price must be inside OB zone right now</div>
          )}
        </div>

        {/* Fair Value Gap */}
        <div style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Label>Fair Value Gap</Label>
            <div style={{ marginLeft: 'auto' }}>
              <Select value={s.conditions.fvgDir||'any'} onChange={v => set('conditions.fvgDir', v)}
                options={[{v:'any',l:'Any'},{v:'bullish',l:'Bullish FVG'},{v:'bearish',l:'Bearish FVG'}]}/>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>Require FVG</span>
            <Toggle checked={!!s.conditions.requireFVG} onChange={v => set('conditions.requireFVG', v)}/>
            <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>FVG Tap</span>
            <Toggle checked={!!s.conditions.requireFVGTap} onChange={v => set('conditions.requireFVGTap', v)}/>
          </div>
          {s.conditions.requireFVGTap && (
            <div style={{ fontSize: 10, color: 'var(--text3)', paddingLeft: 8, marginTop: 3 }}>Price must be inside FVG zone right now</div>
          )}
        </div>

        {/* OTE */}
        <FieldRow label="Require OTE Zone (0.618–0.786)">
          <Toggle checked={!!s.conditions.requireOTE} onChange={v => set('conditions.requireOTE', v)}/>
        </FieldRow>

        {/* Candle Pattern */}
        <FieldRow label="Candlestick Pattern">
          <Select value={s.conditions.candlePattern||'any'} onChange={v => set('conditions.candlePattern', v)}
            options={[{v:'any',l:'Any'},{v:'bullish',l:'Bullish (engulfing / hammer)'},{v:'bearish',l:'Bearish (engulfing / shooting star)'},{v:'doji',l:'Doji / Indecision'}]}/>
        </FieldRow>

        {/* EMA Filter */}
        <div style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: (s.conditions.emaFilter?.enabled) ? 6 : 0 }}>
            <Label>EMA Filter</Label>
            <div style={{ marginLeft: 'auto' }}><Toggle checked={!!s.conditions.emaFilter?.enabled} onChange={v => set('conditions.emaFilter.enabled', v)}/></div>
          </div>
          {s.conditions.emaFilter?.enabled && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingLeft: 8 }}>
              <Label>Price</Label>
              <Select value={s.conditions.emaFilter?.side||'above'} onChange={v => set('conditions.emaFilter.side', v)}
                options={[{v:'above',l:'Above'},{v:'below',l:'Below'}]}/>
              <Label>EMA</Label>
              <Select value={String(s.conditions.emaFilter?.period||200)} onChange={v => set('conditions.emaFilter.period', +v)}
                options={[{v:'20',l:'EMA 20'},{v:'50',l:'EMA 50'},{v:'100',l:'EMA 100'},{v:'200',l:'EMA 200'}]}/>
            </div>
          )}
        </div>

        {/* VWAP */}
        <div style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: (s.conditions.vwapFilter?.enabled) ? 6 : 0 }}>
            <Label>VWAP Filter</Label>
            <div style={{ marginLeft: 'auto' }}><Toggle checked={!!s.conditions.vwapFilter?.enabled} onChange={v => set('conditions.vwapFilter.enabled', v)}/></div>
          </div>
          {s.conditions.vwapFilter?.enabled && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingLeft: 8 }}>
              <Label>Price</Label>
              <Select value={s.conditions.vwapFilter?.side||'above'} onChange={v => set('conditions.vwapFilter.side', v)}
                options={[{v:'above',l:'Above VWAP'},{v:'below',l:'Below VWAP'}]}/>
            </div>
          )}
        </div>

        {/* Sessions */}
        <div style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <Label>Sessions</Label>
          <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
            {SESSIONS.map(({ v, l }) => (
              <CondChip key={v} active={(s.conditions.sessions||[]).includes(v)} color="#00d4aa" onClick={() => toggleSession(v)}>{v}</CondChip>
            ))}
          </div>
        </div>

        {/* RSI */}
        <div style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: s.conditions.rsiFilter?.enabled ? 8 : 0 }}>
            <Label>RSI Filter</Label>
            <div style={{ marginLeft: 'auto' }}><Toggle checked={!!s.conditions.rsiFilter?.enabled} onChange={v => set('conditions.rsiFilter.enabled', v)}/></div>
          </div>
          {s.conditions.rsiFilter?.enabled && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingLeft: 8 }}>
              <Label>RSI</Label>
              <Select value={s.conditions.rsiFilter.comparison} onChange={v => set('conditions.rsiFilter.comparison', v)}
                options={[{v:'below',l:'Below'},{v:'above',l:'Above'}]}/>
              <NumberInput value={s.conditions.rsiFilter.value} onChange={v => set('conditions.rsiFilter.value', v)} min={1} max={99} step={1} style={{width:55}}/>
            </div>
          )}
        </div>
      </section>

      {/* Risk */}
      <section>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Risk Management</div>

        {/* Risk type toggle */}
        <div style={{ display: 'flex', gap: 4, padding: '4px 0 10px', borderBottom: '1px solid var(--border)' }}>
          {[{v:'percent',l:'% Balance'},{v:'usdt',l:'Fixed USDT'}].map(opt => (
            <button key={opt.v} onClick={() => set('risk.riskType', opt.v)}
              style={{ flex: 1, padding: '6px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: `1px solid ${(s.risk.riskType||'percent')===opt.v ? '#00d4aa' : 'var(--border)'}`, background: (s.risk.riskType||'percent')===opt.v ? '#00d4aa22' : 'var(--bg2)', color: (s.risk.riskType||'percent')===opt.v ? '#00d4aa' : 'var(--text3)' }}>
              {opt.l}
            </button>
          ))}
        </div>

        {(s.risk.riskType||'percent') === 'percent' ? (
          <FieldRow label="Risk Per Trade (%)">
            <NumberInput value={s.risk.riskPercent} onChange={v => set('risk.riskPercent', v)} min={0.1} max={10} step={0.1}/>
          </FieldRow>
        ) : (
          <FieldRow label="Risk Per Trade (USDT)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>$</span>
              <NumberInput value={s.risk.riskUsdt||10} onChange={v => set('risk.riskUsdt', v)} min={1} max={10000} step={1}/>
            </div>
          </FieldRow>
        )}

        <FieldRow label="Stop Loss Method">
          <Select value={s.risk.slMethod} onChange={v => set('risk.slMethod', v)} options={SL_METHODS}/>
        </FieldRow>
        {s.risk.slMethod === 'swing' && <div style={{ padding: '2px 0 6px 12px', borderBottom: '1px solid var(--border)', fontSize: 10, color: 'var(--text3)' }}>SL below recent swing low (long) or above swing high (short) + 3 pip buffer</div>}
        {s.risk.slMethod === 'ob'    && <div style={{ padding: '2px 0 6px 12px', borderBottom: '1px solid var(--border)', fontSize: 10, color: 'var(--text3)' }}>SL below the base of the entry Order Block</div>}
        {s.risk.slMethod === 'atr'   && <FieldRow label="ATR Multiplier"><NumberInput value={s.risk.slAtr||1.5} onChange={v => set('risk.slAtr', v)} min={0.5} max={5} step={0.1}/></FieldRow>}
        {s.risk.slMethod === 'fixed' && <FieldRow label="SL (pips)"><NumberInput value={s.risk.slPips||20} onChange={v => set('risk.slPips', v)} min={5} max={500} step={1}/></FieldRow>}

        <FieldRow label="Take Profit Method">
          <Select value={s.risk.tpMethod} onChange={v => set('risk.tpMethod', v)} options={TP_METHODS}/>
        </FieldRow>
        {s.risk.tpMethod === 'rr' && (
          <>
            <FieldRow label="R:R Ratio"><NumberInput value={s.risk.rrRatio} onChange={v => set('risk.rrRatio', v)} min={1} max={10} step={0.5}/></FieldRow>
            <div style={{ display: 'flex', gap: 5, padding: '4px 0 6px', borderBottom: '1px solid var(--border)' }}>
              {[1, 1.5, 2, 2.5, 3, 4].map(r => (
                <button key={r} onClick={() => set('risk.rrRatio', r)}
                  style={{ padding: '2px 7px', borderRadius: 3, fontSize: 10, cursor: 'pointer', border: `1px solid ${s.risk.rrRatio===r?'#00d4aa':'var(--border)'}`, background: s.risk.rrRatio===r?'#00d4aa22':'var(--bg2)', color: s.risk.rrRatio===r?'#00d4aa':'var(--text3)' }}>
                  1:{r}
                </button>
              ))}
            </div>
          </>
        )}
        {s.risk.tpMethod === 'fixed' && <FieldRow label="TP (pips)"><NumberInput value={s.risk.tpPips||40} onChange={v => set('risk.tpPips', v)} min={5} max={500} step={1}/></FieldRow>}
        {s.risk.tpMethod === 'fib'   && <FieldRow label="Fib Level"><Select value={s.risk.tpFibLevel} onChange={v => set('risk.tpFibLevel', +v)} options={[{v:1.0,l:'1.0'},{v:1.272,l:'1.272'},{v:1.618,l:'1.618'},{v:2.0,l:'2.0'},{v:2.618,l:'2.618'}]}/></FieldRow>}
      </section>

      {/* Summary pill */}
      <div style={{ background: '#00d4aa14', border: '1px solid #00d4aa33', borderRadius: 6, padding: '8px 12px', fontSize: 11, color: 'var(--text2)', lineHeight: 1.6 }}>
        <b style={{ color: '#00d4aa' }}>{s.name}</b> · {(s.pairs||[]).length} pair{(s.pairs||[]).length!==1?'s':''} · {s.timeframe} · {s.direction.toUpperCase()}<br/>
        Pairs: {(s.pairs||[]).map(p=>p.replace('_','/')).join(', ')||'None'}<br/>
        Conditions: {[s.conditions.requireBOS&&'BOS',s.conditions.requireOB&&'OB',s.conditions.requireFVG&&'FVG',s.conditions.requireOTE&&'OTE'].filter(Boolean).join(', ')||'None'}<br/>
        Sessions: {(s.conditions.sessions||[]).join(', ')||'None'}<br/>
        Risk: {s.risk.riskType==='usdt' ? `$${s.risk.riskUsdt||10} USDT` : `${s.risk.riskPercent}%`} · SL: {s.risk.slMethod.toUpperCase()} · TP: {s.risk.tpMethod === 'rr' ? `1:${s.risk.rrRatio}` : s.risk.tpMethod}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, padding: '8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text3)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
        <button onClick={() => onSave(s)} style={{ flex: 2, padding: '8px', borderRadius: 6, border: 'none', background: '#00d4aa', color: '#080c14', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Save Strategy</button>
      </div>
    </div>
  );
}

// ── Main BotConfig component ──────────────────────────────────────────────────
export default function BotConfig() {
  const [config,   setConfig]   = useState(null);
  const [sha,      setSha]      = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [err,      setErr]      = useState('');
  const [editing,  setEditing]  = useState(null); // null | 'new' | stratId
  const [pat,      setPat]      = useState(() => localStorage.getItem('github_pat') || '');
  const [patSaved, setPatSaved] = useState(!!localStorage.getItem('github_pat'));

  const load = useCallback(async () => {
    if (!isGithubConfigured()) return;
    setLoading(true); setErr('');
    try {
      const result = await ghRead('bot/strategy.json');
      if (result) { setConfig(result.content); setSha(result.sha); }
      else {
        // First time — create default
        const def = { version:1, updatedAt: new Date().toISOString(), strategies: [], globalSettings: { maxTotalTrades:3, telegramEnabled:false, telegramChatId:'', tradeOnWeekends:false, lastRunAt:null, lastError:null } };
        setConfig(def); setSha(null);
      }
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { if (patSaved) load(); }, [patSaved, load]);

  const saveConfig = async (cfg) => {
    setSaving(true); setErr('');
    try {
      const updated = { ...cfg, updatedAt: new Date().toISOString() };
      // Fetch fresh SHA bypassing CDN cache (GitHub caches for ~60s, causing 409)
      const fresh = await ghRead('bot/strategy.json', { noCache: true }).catch(() => null);
      const freshSha = fresh?.sha ?? sha;
      if (fresh?.sha && fresh.sha !== sha) setSha(fresh.sha);
      const newSha = await ghWrite('bot/strategy.json', updated, 'App: update strategy config', freshSha);
      setConfig(updated); setSha(newSha);
      setSaving(false);
      return true;
    } catch (e) {
      setErr(`Save failed: ${e.message}`);
      setSaving(false);
      return false;
    }
  };

  const saveGlobal = (key, val) => {
    const updated = { ...config, globalSettings: { ...config.globalSettings, [key]: val } };
    saveConfig(updated);
  };

  const handleSaveStrat = (strat) => {
    const strats = [...(config.strategies || [])];
    if (!strat.id) strat.id = 'strat_' + Date.now();
    const idx = strats.findIndex(s => s.id === strat.id);
    if (idx >= 0) strats[idx] = strat; else strats.push(strat);
    saveConfig({ ...config, strategies: strats });
    setEditing(null);
  };

  const deleteStrat = (id) => {
    if (!window.confirm('Delete this strategy?')) return;
    saveConfig({ ...config, strategies: config.strategies.filter(s => s.id !== id) });
  };

  const toggleStrat = async (id) => {
    const original = config.strategies;
    const strats = config.strategies.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s);
    setConfig(prev => ({ ...prev, strategies: strats })); // optimistic
    const ok = await saveConfig({ ...config, strategies: strats });
    if (!ok) setConfig(prev => ({ ...prev, strategies: original })); // revert
  };

  const savePat = () => {
    localStorage.setItem('github_pat', pat);
    setPatSaved(true);
    load();
  };

  // ── PAT setup screen ──────────────────────────────────────────────────────
  if (!patSaved) {
    return (
      <div style={{ padding: 20, maxWidth: 500 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Connect GitHub</div>
        <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16, lineHeight: 1.6 }}>
          The bot config and trade log are stored in your GitHub repo. Enter a Personal Access Token with <b>Contents: read &amp; write</b> permission.
          <br/><br/>
          Create at: <code style={{ fontSize: 10, color: '#00d4aa' }}>github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens</code>
        </p>
        <input placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" value={pat} onChange={e => setPat(e.target.value)}
          style={{ width: '100%', background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}/>
        <button onClick={savePat} disabled={!pat.trim()} style={{ padding: '9px 20px', borderRadius: 6, background: '#00d4aa', color: '#080c14', fontWeight: 700, fontSize: 12, border: 'none', cursor: 'pointer' }}>
          Save &amp; Connect
        </button>
      </div>
    );
  }

  if (loading) return <div style={{ padding: 24, color: 'var(--text3)', fontSize: 13 }}>⟳ Loading config from GitHub…</div>;

  // ── Edit screen ─────────────────────────────────────────────────────────────
  if (editing !== null) {
    const existing = editing === 'new' ? null : config.strategies.find(s => s.id === editing);
    return (
      <div style={{ maxWidth: 520 }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setEditing(null)} style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>←</button>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{existing ? 'Edit Strategy' : 'New Strategy'}</span>
        </div>
        <StrategyEditor
          strat={existing || { ...DEFAULT_STRAT }}
          onSave={handleSaveStrat}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  // ── Main screen ─────────────────────────────────────────────────────────────
  const gs = config?.globalSettings || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, maxWidth: 520 }}>

      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>⚙ Bot Config</span>
        <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 4 }}>synced with GitHub</span>
        <button onClick={load} style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 4, background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text3)', fontSize: 11, cursor: 'pointer' }}>↻ Refresh</button>
        {saving && <span style={{ fontSize: 11, color: '#00d4aa' }}>Saving…</span>}
      </div>

      {err && (
        <div style={{ margin: '8px 16px', padding: '10px 12px', background: '#ef444420', border: '1px solid #ef444444', borderRadius: 6, fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ flex: 1 }}>{err}</span>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button onClick={() => { setErr(''); load(); }} style={{ padding: '3px 8px', borderRadius: 4, fontSize: 10, background: '#ef444433', border: '1px solid #ef444466', color: '#ef4444', cursor: 'pointer', fontWeight: 700 }}>↻ Retry</button>
            <button onClick={() => setErr('')} style={{ padding: '3px 8px', borderRadius: 4, fontSize: 10, background: 'none', border: '1px solid #ef444444', color: '#ef4444', cursor: 'pointer' }}>✕</button>
          </div>
        </div>
      )}

      {/* Global settings */}
      {config && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Global Settings</div>
          <FieldRow label="Max Total Open Trades">
            <NumberInput value={gs.maxTotalTrades || 3} onChange={v => saveGlobal('maxTotalTrades', v)} min={1} max={10} step={1}/>
          </FieldRow>
          <FieldRow label="Telegram Enabled">
            <Toggle checked={!!gs.telegramEnabled} onChange={v => saveGlobal('telegramEnabled', v)}/>
          </FieldRow>
          {gs.telegramEnabled && (
            <FieldRow label="Chat ID">
              <input value={gs.telegramChatId || ''} onChange={e => saveGlobal('telegramChatId', e.target.value)}
                placeholder="-100xxxxxxxxxx"
                style={{ width: 140, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', fontSize: 11 }}/>
            </FieldRow>
          )}
          {gs.lastRunAt && (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
              Last bot run: {new Date(gs.lastRunAt).toLocaleString()}
              {gs.lastError && <span style={{ color: '#f87171', marginLeft: 6 }}>⚠ {gs.lastError}</span>}
            </div>
          )}
        </div>
      )}

      {/* Strategies list */}
      {config && (
        <div style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Strategies</span>
            <button onClick={() => setEditing('new')}
              style={{ marginLeft: 'auto', padding: '5px 12px', borderRadius: 4, background: '#00d4aa', color: '#080c14', fontWeight: 700, fontSize: 11, border: 'none', cursor: 'pointer' }}>
              + New
            </button>
          </div>

          {(!config.strategies || config.strategies.length === 0) && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 12, border: '1px dashed var(--border)', borderRadius: 6 }}>
              No strategies yet — click + New to create one
            </div>
          )}

          {(config.strategies || []).map(strat => (
            <div key={strat.id} style={{ background: 'var(--card)', border: `1px solid ${strat.enabled ? '#00d4aa33' : 'var(--border)'}`, borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Toggle checked={strat.enabled} onChange={() => toggleStrat(strat.id)}/>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: strat.enabled ? 'var(--text)' : 'var(--text3)' }}>{strat.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                    {(() => {
                      const pairs = strat.pairs || (strat.pair ? [strat.pair] : []);
                      if (pairs.length === 0) return 'No pairs';
                      if (pairs.length === 1) return pairs[0].replace('_','/');
                      if (pairs.length <= 3) return pairs.map(p => p.replace('_','/')).join(', ');
                      return `${pairs.slice(0,2).map(p=>p.replace('_','/')).join(', ')} +${pairs.length-2} more`;
                    })()} · {strat.timeframe} · {strat.direction}
                  </div>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button onClick={() => setEditing(strat.id)} style={{ padding: '4px 10px', borderRadius: 4, fontSize: 11, background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text2)', cursor: 'pointer' }}>Edit</button>
                  <button onClick={() => deleteStrat(strat.id)} style={{ padding: '4px 10px', borderRadius: 4, fontSize: 11, background: 'none', border: '1px solid #ef444433', color: '#ef4444', cursor: 'pointer' }}>✕</button>
                </div>
              </div>
              {/* Descriptive condition chips — SMCPro v2 style */}
              <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {strat.conditions.structure && strat.conditions.structure !== 'any' && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                    Market Structure == {strat.conditions.structure}
                  </span>
                )}
                {strat.conditions.requireBOS && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                    BOS / CHoCH required
                  </span>
                )}
                {strat.conditions.priceZone && strat.conditions.priceZone !== 'any' && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                    Price Zone == {strat.conditions.priceZone}
                  </span>
                )}
                {strat.conditions.requireOB && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                    OB (Order Block) == {strat.conditions.obDir || 'any'}
                  </span>
                )}
                {strat.conditions.requireFVG && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                    FVG (Fair Value Gap) == {strat.conditions.fvgDir || 'any'}
                  </span>
                )}
                {strat.conditions.requireOTE && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                    OTE Zone is_true
                  </span>
                )}
                {strat.conditions.requireLiqSweep && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                    Liquidity Sweep required
                  </span>
                )}
                {strat.conditions.rsiFilter?.enabled && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: '#f9731620', color: '#f97316', border: '1px solid #f9731633' }}>
                    RSI {strat.conditions.rsiFilter.comparison} {strat.conditions.rsiFilter.value}
                  </span>
                )}
                {strat.conditions.emaFilter?.enabled && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                    Price {strat.conditions.emaFilter.side} EMA {strat.conditions.emaFilter.period}
                  </span>
                )}
                {strat.conditions.vwapFilter?.enabled && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                    Price {strat.conditions.vwapFilter.side} VWAP
                  </span>
                )}
                {(strat.conditions.sessions||[]).length > 0 && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: '#f59e0b20', color: '#f59e0b', border: '1px solid #f59e0b33' }}>
                    Session == {(strat.conditions.sessions||[]).join(' / ')}
                  </span>
                )}
                <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                  Risk {strat.risk.riskType==='usdt' ? `$${strat.risk.riskUsdt||10}` : `${strat.risk.riskPercent}%`} · SL: {strat.risk.slMethod}{strat.risk.tpMethod === 'rr' ? ` · TP: 1:${strat.risk.rrRatio}R` : ''}
                </span>
              </div>
              <ScanPanel strat={strat} />
            </div>
          ))}
        </div>
      )}

      {/* VPS setup guide */}
      <div style={{ margin: '0 16px 16px', padding: '10px 12px', background: '#1e293b', borderRadius: 8, border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', marginBottom: 6 }}>VPS Bot Setup</div>
        <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.7, fontFamily: 'monospace' }}>
          cd vps-bot<br/>
          npm install<br/>
          cp .env.example .env &amp;&amp; nano .env<br/>
          pm2 start ecosystem.config.js<br/>
          pm2 save &amp;&amp; pm2 startup
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>
          Bot reads strategy every 60s from GitHub. Change strategy in app → bot picks it up automatically next minute.
        </div>
      </div>

      {/* Reset PAT + token test */}
      <div style={{ padding: '0 16px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
        <button onClick={() => { localStorage.removeItem('github_pat'); setPatSaved(false); setPat(''); }}
          style={{ fontSize: 10, color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
          Change GitHub token
        </button>
        <button onClick={async () => {
          try {
            await ghRead('bot/strategy.json');
            alert('GitHub token is valid — read/write OK');
          } catch (e) {
            alert(`GitHub token error: ${e.message}`);
          }
        }} style={{ fontSize: 10, color: '#00d4aa', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
          Test token
        </button>
      </div>
    </div>
  );
}

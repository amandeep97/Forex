import { useState, useMemo, useEffect } from 'react';
import { allInstruments, ASSET_TYPES, FOREX_CATEGORIES, SIGNALS, ASSET_COLORS, DEFAULT_FILTERS } from '../data/forexData';
import { useLivePrices, OANDA_MAP } from '../hooks/useLivePrices';
import { generateCandles } from '../utils/generateCandles';
import { detectCandlePatterns } from '../utils/candlePatterns';
import { analyzeSMC } from '../utils/smcAnalysis';
import { computeRSI, computeMFI, computeEMA, computeMACD, detectRSIDivergence, detectEqualHighsLows } from '../utils/indicatorCalc';
import { computeVWAP, detectFVGsAndOBs, detectLiqLevels } from '../utils/smcHelpers';
import ChartModal from './ChartModal';
import TechnicalPanel from './TechnicalPanel';
import OandaConnect from './OandaConnect';
import FilterPanel from './FilterPanel';
import { getIMSignals, IM_DEFS } from '../utils/intermarket';

// ── Forex Session Clock ───────────────────────────────────────────────────────
function SessionClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const utcH = now.getUTCHours(), utcM = now.getUTCMinutes();
  const mins = utcH * 60 + utcM;
  function inSess(s, e) { return s < e ? mins >= s && mins < e : mins >= s || mins < e; }
  const sessions = [
    { name:'Sydney',   s:22*60, e:7*60,  color:'#3b82f6', active:inSess(22*60,7*60)  },
    { name:'Tokyo',    s:0*60,  e:9*60,  color:'#f59e0b', active:inSess(0*60,9*60)   },
    { name:'London',   s:8*60,  e:17*60, color:'#8b5cf6', active:inSess(8*60,17*60)  },
    { name:'New York', s:13*60, e:22*60, color:'#22c55e', active:inSess(13*60,22*60) },
  ];
  const overlap = sessions[2].active && sessions[3].active;
  const utcStr = `${String(utcH).padStart(2,'0')}:${String(utcM).padStart(2,'0')} UTC`;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:5, padding:'4px 12px', borderBottom:'1px solid var(--border)', background:'#060a10', overflowX:'auto', scrollbarWidth:'none', flexShrink:0 }}>
      <span style={{ fontSize:9, color:'#475569', flexShrink:0, fontFamily:'monospace' }}>🕐 {utcStr}</span>
      {sessions.map(s => (
        <div key={s.name} style={{ display:'flex', alignItems:'center', gap:3, padding:'2px 7px', borderRadius:4, flexShrink:0,
          background: s.active ? s.color+'22' : 'transparent',
          border:     `1px solid ${s.active ? s.color+'55' : '#1e293b'}` }}>
          {s.active && <span style={{ width:5, height:5, borderRadius:'50%', background:s.color, display:'inline-block', animation:'pulse 1.4s infinite' }}/>}
          <span style={{ fontSize:9, fontWeight:700, color:s.active ? s.color : '#334155' }}>{s.name}</span>
        </div>
      ))}
      {overlap && (
        <div style={{ padding:'2px 7px', borderRadius:4, background:'#22c55e18', border:'1px solid #22c55e44', flexShrink:0 }}>
          <span style={{ fontSize:9, fontWeight:700, color:'#22c55e' }}>⚡ London+NY</span>
        </div>
      )}
    </div>
  );
}

// ── ICT Killzone Bar ──────────────────────────────────────────────────────────
function KillzoneBar() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  const KILLZONES = [
    { name: 'Asian KZ',      s: 0*60,  e: 4*60,  color: '#f59e0b' },
    { name: 'London KZ',     s: 7*60,  e: 10*60, color: '#8b5cf6' },
    { name: 'London Close',  s: 11*60, e: 12*60, color: '#38bdf8' },
    { name: 'NY AM KZ',      s: 13*60, e: 16*60, color: '#22c55e' },
    { name: 'NY PM KZ',      s: 18*60, e: 20*60, color: '#f97316' },
  ];

  const activeKZ = KILLZONES.find(kz => mins >= kz.s && mins < kz.e);

  // Find next killzone and time until it
  let nextKZ = null, minsUntil = null;
  for (const kz of KILLZONES) {
    const diff = kz.s > mins ? kz.s - mins : kz.s + 1440 - mins;
    if (minsUntil === null || diff < minsUntil) { nextKZ = kz; minsUntil = diff; }
  }

  const hh = Math.floor(minsUntil / 60), mm = minsUntil % 60;

  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, padding:'3px 12px',
      borderBottom:'1px solid rgba(139,92,246,0.12)', background:'rgba(5,8,15,0.9)',
      overflowX:'auto', scrollbarWidth:'none', flexShrink:0 }}>
      <span style={{ fontSize:9, color:'#4b5563', flexShrink:0, fontWeight:600, letterSpacing:'0.06em' }}>KILLZONE</span>
      {KILLZONES.map(kz => {
        const active = mins >= kz.s && mins < kz.e;
        return (
          <div key={kz.name} style={{ display:'flex', alignItems:'center', gap:3, padding:'2px 7px',
            borderRadius:4, flexShrink:0,
            background: active ? kz.color+'22' : 'transparent',
            border: `1px solid ${active ? kz.color+'66' : 'rgba(255,255,255,0.06)'}` }}>
            {active && <span style={{ width:4, height:4, borderRadius:'50%', background:kz.color,
              display:'inline-block', animation:'pulse 1.4s infinite' }}/>}
            <span style={{ fontSize:9, fontWeight:700, color: active ? kz.color : '#374151' }}>
              {kz.name}
            </span>
          </div>
        );
      })}
      {!activeKZ && nextKZ && (
        <span style={{ fontSize:9, color:'#64748b', marginLeft:'auto', flexShrink:0, fontFamily:'monospace' }}>
          Next: <span style={{ color: nextKZ.color }}>{nextKZ.name}</span> in {hh}h {mm}m
        </span>
      )}
      {activeKZ && (
        <span style={{ fontSize:9, color: activeKZ.color, marginLeft:'auto', flexShrink:0, fontWeight:700 }}>
          ⚡ ACTIVE — ends in {hh}h {mm}m
        </span>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Sparkline({ data, change }) {
  const w=64, h=26;
  if (!data||data.length<2) return <div style={{width:w,height:h}}/>;
  const min=Math.min(...data),max=Math.max(...data),range=max-min||0.0001;
  const pts=data.map((v,i)=>`${((i/(data.length-1))*w).toFixed(1)},${(h-((v-min)/range)*(h-2)+1).toFixed(1)}`).join(' ');
  const col=change>=0?'#22c55e':'#ef4444';
  const lastX=((data.length-1)/(data.length-1)*w).toFixed(1);
  const lastY=(h-((data[data.length-1]-min)/range)*(h-2)+1).toFixed(1);
  return (
    <svg width={w} height={h} style={{display:'block'}}>
      <defs>
        <linearGradient id={`sg_${change}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.25"/>
          <stop offset="100%" stopColor={col} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts} ${lastX},${h}`} fill={`url(#sg_${change})`}/>
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.5" strokeLinejoin="round"/>
      <circle cx={lastX} cy={lastY} r="2" fill={col}/>
    </svg>
  );
}

function AIScoreCircle({ score, dir }) {
  const r=15, circ=2*Math.PI*r;
  const col = dir==='bullish'?'#22c55e': dir==='bearish'?'#ef4444':'#64748b';
  const dash=(Math.min(score,100)/100*circ).toFixed(1);
  return (
    <div style={{position:'relative',width:38,height:38}}>
      <svg width="38" height="38" viewBox="0 0 38 38">
        <circle cx="19" cy="19" r={r} fill="none" stroke="#1e293b" strokeWidth="3.5"/>
        <circle cx="19" cy="19" r={r} fill="none" stroke={col} strokeWidth="3.5"
          strokeDasharray={`${dash} ${circ.toFixed(1)}`} strokeLinecap="round"
          transform="rotate(-90 19 19)"/>
      </svg>
      <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <span style={{fontSize:10,fontWeight:900,color:col,lineHeight:1}}>{score}</span>
      </div>
    </div>
  );
}

function SignalBadge({ signal }) {
  const s=SIGNALS[signal]; if(!s) return null;
  const strong=['STRONG_BUY','STRONG_SELL'].includes(signal);
  return (
    <span style={{
      padding:'4px 10px',borderRadius:20,fontSize:10,fontWeight:800,
      color:s.color,background:s.bg,border:`1px solid ${s.color}55`,
      letterSpacing:'0.03em',whiteSpace:'nowrap',
      boxShadow:strong?`0 0 8px ${s.color}33`:'none',
    }}>{s.label}</span>
  );
}

function AssetBadge({ type }) {
  const c=ASSET_COLORS[type]||{color:'#94a3b8',bg:'#1e293b55'};
  const icon = {Forex:'₣',Metals:'⬡',Indices:'📊',Energy:'⚡',Crypto:'₿'}[type]||'·';
  return (
    <span style={{padding:'2px 7px',borderRadius:6,fontSize:10,fontWeight:700,
      color:c.color,background:c.bg,border:`1px solid ${c.color}44`,
      whiteSpace:'nowrap',display:'inline-flex',alignItems:'center',gap:3}}>
      <span style={{fontSize:9}}>{icon}</span>{type}
    </span>
  );
}

function SmcTagRow({ bosBullish, bosBearish, chochBullish, chochBearish, hasFvg, hasOb }) {
  const tags = [];
  if (bosBullish)   tags.push(<span key="bosb"  style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#22c55e',background:'#22c55e18',border:'1px solid #22c55e44'}}>BOS↑</span>);
  if (bosBearish)   tags.push(<span key="bosr"  style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#ef4444',background:'#ef444418',border:'1px solid #ef444444'}}>BOS↓</span>);
  if (chochBullish) tags.push(<span key="chb"   style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#eab308',background:'#eab30818',border:'1px solid #eab30844'}}>CHoCH↑</span>);
  if (chochBearish) tags.push(<span key="chr"   style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#f97316',background:'#f9731618',border:'1px solid #f9731644'}}>CHoCH↓</span>);
  if (hasFvg) tags.push(<span key="fvg" style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#00d4aa',background:'#00d4aa12',border:'1px solid #00d4aa44'}}>FVG</span>);
  if (hasOb)  tags.push(<span key="ob"  style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#a78bfa',background:'#a78bfa12',border:'1px solid #a78bfa44'}}>OB</span>);
  if (tags.length===0) return <span style={{color:'#334155',fontSize:10}}>—</span>;
  return <div style={{display:'flex',flexWrap:'wrap',gap:2}}>{tags}</div>;
}

function ZoneBadge({ zone }) {
  if (zone==='premium')  return <span style={{padding:'2px 6px',borderRadius:4,fontSize:10,fontWeight:700,color:'#ef4444',background:'#ef444418',border:'1px solid #ef444444'}}>▲ Prem</span>;
  if (zone==='discount') return <span style={{padding:'2px 6px',borderRadius:4,fontSize:10,fontWeight:700,color:'#22c55e',background:'#22c55e18',border:'1px solid #22c55e44'}}>▼ Disc</span>;
  return <span style={{color:'#475569',fontSize:10}}>—</span>;
}

function StructBadge({ structure }) {
  if (structure==='bullish') return <span style={{padding:'2px 6px',borderRadius:4,fontSize:9,fontWeight:700,color:'#22c55e',background:'#22c55e14',border:'1px solid #22c55e33'}}>Bullish</span>;
  if (structure==='bearish') return <span style={{padding:'2px 6px',borderRadius:4,fontSize:9,fontWeight:700,color:'#ef4444',background:'#ef444414',border:'1px solid #ef444433'}}>Bearish</span>;
  return <span style={{color:'#475569',fontSize:9}}>Neutral</span>;
}

function StrengthBar({ value, dir }) {
  const col=dir==='bullish'?'#22c55e':dir==='bearish'?'#ef4444':'#64748b';
  return (
    <div style={{display:'flex',alignItems:'center',gap:5,minWidth:80}}>
      <div style={{flex:1,height:4,background:'#1e293b',borderRadius:2,overflow:'hidden'}}>
        <div style={{width:`${value}%`,height:'100%',background:`linear-gradient(90deg,${col}66,${col})`,borderRadius:2}}/>
      </div>
      <span style={{fontSize:10,color:col,fontFamily:'monospace',fontWeight:700,minWidth:28}}>{value}%</span>
    </div>
  );
}

function RsiBar({ value, ob=70, os=30 }) {
  const color=value>=ob?'#ef4444':value<=os?'#22c55e':'#94a3b8';
  return (
    <div style={{display:'flex',alignItems:'center',gap:6}}>
      <div style={{width:48,height:4,background:'#1e293b',borderRadius:2,overflow:'hidden'}}>
        <div style={{width:`${value}%`,height:'100%',background:color,borderRadius:2}}/>
      </div>
      <span style={{fontSize:11,color,fontFamily:'monospace',minWidth:28}}>{value}</span>
    </div>
  );
}

function SortIcon({ col, sortKey, dir }) {
  if (sortKey!==col) return <span style={{color:'#334155',marginLeft:3}}>⇅</span>;
  return <span style={{color:'#00d4aa',marginLeft:3}}>{dir==='asc'?'↑':'↓'}</span>;
}

function LiveBadge({ isLive }) {
  return isLive
    ? <span style={{display:'inline-flex',alignItems:'center',gap:4,padding:'1px 6px',borderRadius:10,fontSize:9,fontWeight:700,color:'#22c55e',background:'#22c55e18',border:'1px solid #22c55e44'}}><span style={{width:5,height:5,borderRadius:'50%',background:'#22c55e',display:'inline-block',animation:'pulse 1.4s infinite'}}/> LIVE</span>
    : <span style={{padding:'1px 6px',borderRadius:10,fontSize:9,fontWeight:700,color:'#475569',background:'#1e293b',border:'1px solid #334155'}}>DEMO</span>;
}

function fmtPrice(v) {
  if(v==null) return '—';
  if(v>=10000) return v.toFixed(0);
  if(v>=100)   return v.toFixed(2);
  if(v>=1)     return v.toFixed(3);
  return v.toFixed(5);
}

// ── Main Screener ─────────────────────────────────────────────────────────────
export default function Screener() {
  const { forexRates, cryptoRates, metalRates, marketRates, lastUpdate, loading, error, refresh,
          oandaStatus, connectOanda, disconnectOanda } = useLivePrices();

  const [filters, setFilters]           = useState({ ...DEFAULT_FILTERS });
  const [showFilters, setShowFilters]   = useState(false);
  const [sortKey, setSortKey]           = useState('symbol');
  const [sortDir, setSortDir]           = useState('asc');
  const [signalFilter, setSignalFilter] = useState('All');
  const [subCategory, setSubCategory]   = useState('All');
  const [chartInstrument, setChartInstrument] = useState(null);
  const [levelsInst, setLevelsInst] = useState(null);

  const [imSignals, setImSignals] = useState(null);
  const [sentiment, setSentiment] = useState({});
  const [sentimentHasCreds, setSentimentHasCreds] = useState(true);

  const [watchlist, setWatchlist] = useState(() => {
    try { return JSON.parse(localStorage.getItem('forex_watchlist')) || []; } catch { return []; }
  });

  useEffect(() => {
    getIMSignals('H1', 5).then(setImSignals).catch(() => {});
    const id = setInterval(() => getIMSignals('H1', 5).then(setImSignals).catch(() => {}), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // ── Retail sentiment fetch (OANDA position book) ──────────────────────────
  useEffect(() => {
    async function fetchAllSentiment() {
      let creds = null;
      try { creds = JSON.parse(localStorage.getItem('oanda_creds') || 'null'); } catch {}
      if (!creds?.apiKey) {
        const apiKey = localStorage.getItem('oanda_key');
        const practice = localStorage.getItem('oanda_env') !== 'live';
        if (apiKey) creds = { apiKey, practice };
      }
      if (!creds?.apiKey) { setSentimentHasCreds(false); return; }

      // Position book is public market data — always try live API first
      const liveBase = 'https://api-fxtrade.oanda.com/v3';
      const practiceBase = 'https://api-fxpractice.oanda.com/v3';

      async function fetchSentiment(oandaInstrument) {
        for (const base of [liveBase, practiceBase]) {
          try {
            const res = await fetch(
              `${base}/instruments/${oandaInstrument}/positionBook`,
              { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(6000) }
            );
            if (!res.ok) continue;
            const data = await res.json();
            const buckets = (data.positionBook?.buckets || []).filter(
              b => parseFloat(b.longCountPercent||0) > 0 || parseFloat(b.shortCountPercent||0) > 0
            );
            if (!buckets.length) continue;
            // Each bucket's longCountPercent = % of all long positions at this price level
            // Sum across buckets ≈ 100 for longs, 100 for shorts — use count of dominant buckets instead
            let longBuckets = 0, shortBuckets = 0;
            buckets.forEach(b => {
              const l = parseFloat(b.longCountPercent||0);
              const s = parseFloat(b.shortCountPercent||0);
              if (l >= s) longBuckets += l; else shortBuckets += s;
            });
            const total = longBuckets + shortBuckets;
            if (!total) continue;
            const longPct = Math.round(longBuckets / total * 100);
            return { longPct, shortPct: 100 - longPct };
          } catch { continue; }
        }
        return null;
      }

      const results = {};
      await Promise.all(
        allInstruments
          .filter(inst => OANDA_MAP[inst.symbol])
          .map(async inst => {
            const oandaId = OANDA_MAP[inst.symbol];
            const sent = await fetchSentiment(oandaId);
            if (sent) results[inst.id] = sent;
          })
      );
      setSentiment(results);
    }

    fetchAllSentiment();
  }, []);

  const toggleWatch = sym => {
    setWatchlist(prev => {
      const next = prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym];
      localStorage.setItem('forex_watchlist', JSON.stringify(next));
      return next;
    });
  };

  const activeFilterCount = useMemo(() => {
    const skip = new Set(['search','category','baseCurrency','candleInterval']);
    return Object.keys(DEFAULT_FILTERS).filter(k => !skip.has(k) && filters[k] !== DEFAULT_FILTERS[k]).length;
  }, [filters]);

  const handleSort = (key) => {
    if (sortKey===key) setSortDir(d=>d==='asc'?'desc':'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const subCategories = useMemo(() => {
    if (filters.category==='All'||filters.category==='Crypto') return [];
    if (filters.category==='Forex') return FOREX_CATEGORIES;
    const cats=[...new Set(allInstruments.filter(i=>i.assetType===filters.category).map(i=>i.category))];
    return ['All',...cats];
  }, [filters.category]);

  // ── Analysis ───────────────────────────────────────────────────────────────
  const lookback = Math.max(1, parseInt(filters.candleInterval) || 1);
  const tfFilter = filters.structureTF || '4h';

  const analysis = useMemo(() => {
    const map = {};
    allInstruments.forEach(inst => {
      try {
        const candles   = generateCandles(inst, tfFilter, 250);
        const prevCandles = candles.slice(0, -1);
        const rsiVal    = computeRSI(candles, 14);
        const mfiVal    = computeMFI(candles, 14);
        const fibLevels = (() => {
          const raw = filters.oteFibLevels;
          if (!raw) return null;
          const parsed = String(raw).split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
          return parsed.length >= 1 ? parsed : null;
        })();
        const smc       = analyzeSMC(candles, fibLevels ? { fibLevels } : {});
        const patterns  = detectCandlePatterns(candles.slice(-60), lookback);
        const cp        = candles[candles.length - 1].c;

        const bosBullish   = smc.bosChoch.some(b=>b.type==='BOS'&&b.direction==='bullish');
        const bosBearish   = smc.bosChoch.some(b=>b.type==='BOS'&&b.direction==='bearish');
        const chochBullish = smc.bosChoch.some(b=>b.type==='CHoCH'&&b.direction==='bullish');
        const chochBearish = smc.bosChoch.some(b=>b.type==='CHoCH'&&b.direction==='bearish');
        // Use same detection functions as the chart for alignment
        const { fvgZones=[], obZones=[] } = detectFVGsAndOBs(candles);
        const { bsl: bslLevels=[], ssl: sslLevels=[] } = detectLiqLevels(candles);
        const hasOB      = obZones.length > 0;
        const hasFVG     = fvgZones.length > 0;
        const hasBullOB  = obZones.some(ob => ob.type === 'bullish');
        const hasBearOB  = obZones.some(ob => ob.type === 'bearish');
        const hasBullFVG = fvgZones.some(fvg => fvg.type === 'bullish');
        const hasBearFVG = fvgZones.some(fvg => fvg.type === 'bearish');
        // Tap = price is currently inside the OB/FVG box
        const obTap  = obZones.some(ob  => cp >= ob.botPrice  && cp <= ob.topPrice);
        const fvgTap = fvgZones.some(fvg => cp >= fvg.botPrice && cp <= fvg.topPrice);
        // Zone: same 25% quartile logic as chart (top 25% = premium, bottom 25% = discount)
        const zone   = smc.premiumDiscount?.zone || 'equilibrium';

        const vwapSeries = computeVWAP(candles.slice(-60));
        const lastVwap   = vwapSeries[vwapSeries.length-1];
        const vwapAbove  = cp >= (lastVwap || cp);

        const structure = (bosBullish||chochBullish) ? 'bullish'
                        : (bosBearish||chochBearish) ? 'bearish' : 'neutral';

        // EMAs
        const ema20  = computeEMA(candles, 20);
        const ema50  = computeEMA(candles, 50);
        const ema100 = computeEMA(candles, 100);
        const ema200 = computeEMA(candles, 200);
        const prevEma20  = computeEMA(prevCandles, 20);
        const prevEma50  = computeEMA(prevCandles, 50);
        const prevEma200 = computeEMA(prevCandles, 200);

        // MACD
        const macd = computeMACD(candles);

        // Divergence
        const rsiDiv = detectRSIDivergence(candles);

        // Equal Highs/Lows
        const eql = detectEqualHighsLows(candles);

        let sBull = 0, sBear = 0;
        if (rsiVal < 30) sBull += 2; else if (rsiVal > 70) sBear += 2;
        else if (rsiVal < 45) sBull++; else if (rsiVal > 55) sBear++;
        if (mfiVal < 40) sBull++;  else if (mfiVal > 60) sBear++;
        if (bosBullish)  sBull += 2; if (bosBearish)  sBear += 2;
        if (chochBullish) sBull++;   if (chochBearish) sBear++;
        if (hasFVG) { if (structure==='bullish') sBull++; else sBear++; }
        if (hasOB)  { if (structure==='bullish') sBull++; else sBear++; }
        if (zone==='discount') sBull++; else if (zone==='premium') sBear++;
        if (vwapAbove) sBull++; else sBear++;
        if (macd.crossUp) sBull++; if (macd.crossDown) sBear++;
        if (rsiDiv.bull || rsiDiv.hiddenBull) sBull++; if (rsiDiv.bear || rsiDiv.hiddenBear) sBear++;
        if (smc.displacement.bull) sBull++; if (smc.displacement.bear) sBear++;
        const stTotal = sBull + sBear || 1;
        const strength    = Math.round((Math.max(sBull, sBear) / stTotal) * 100);
        const strengthDir = sBull > sBear ? 'bullish' : sBear > sBull ? 'bearish' : 'neutral';

        map[inst.id] = {
          rsi: rsiVal, mfi: mfiVal,
          nearResistance:  smc.supportResistance.some(s=>s.type==='resistance'&&s.isNear),
          nearSupport:     smc.supportResistance.some(s=>s.type==='support'&&s.isNear),
          brokeResistance: bosBullish,
          brokeSupport:    bosBearish,
          nearTrendline:   smc.trendlines.some(t=>t.isNear),
          brokeTrendline:  smc.trendlines.some(t=>t.isBroken),
          hasOB, hasFVG, hasBullOB, hasBearOB, hasBullFVG, hasBearFVG,
          obTap, fvgTap,
          bosBullish, bosBearish, chochBullish, chochBearish,
          zone, structure, strength, strengthDir, vwapAbove,
          // BSL = near a swing high (buy-side liquidity rests above highs)
          // SSL = near a swing low (sell-side liquidity rests below lows)
          buySideLiq:  bslLevels.some(l=>Math.abs(l.price-cp)/(cp||1)<0.006),
          sellSideLiq: sslLevels.some(l=>Math.abs(l.price-cp)/(cp||1)<0.006),
          patternIds:  patterns.map(p=>p.id),
          patternType: patterns.length===0?'neut':
                       patterns.some(p=>p.type==='bullish')?'bull':
                       patterns.some(p=>p.type==='bearish')?'bear':'neut',
          // New computed fields
          ema20, ema50, ema100, ema200, prevEma20, prevEma50, prevEma200,
          macdCrossUp: macd.crossUp, macdCrossDown: macd.crossDown,
          macdAboveZero: macd.aboveZero, macdBelowZero: macd.belowZero,
          rsiDivBull: rsiDiv.bull, rsiDivBear: rsiDiv.bear,
          rsiDivHiddenBull: rsiDiv.hiddenBull, rsiDivHiddenBear: rsiDiv.hiddenBear,
          equalHighs: eql.equalHighs, equalLows: eql.equalLows,
          dispBull: smc.displacement.bull, dispBear: smc.displacement.bear,
          breakerBull: smc.breakerBlocks.bull, breakerBear: smc.breakerBlocks.bear,
          oteBull: smc.ote.bull, oteBear: smc.ote.bear,
          isConsolidating: smc.consolidation,
        };
      } catch {
        map[inst.id] = { rsi:50, mfi:50, nearResistance:false, nearSupport:false,
          brokeResistance:false, brokeSupport:false, nearTrendline:false,
          brokeTrendline:false, hasOB:false, hasFVG:false, hasBullOB:false, hasBearOB:false,
          hasBullFVG:false, hasBearFVG:false, obTap:false, fvgTap:false, bosBullish:false,
          bosBearish:false, chochBullish:false, chochBearish:false,
          zone:'discount', structure:'neutral', strength:50, strengthDir:'neutral',
          vwapAbove:true, buySideLiq:false, sellSideLiq:false,
          patternIds:[], patternType:'neut',
          ema20:0, ema50:0, ema100:0, ema200:0,
          prevEma20:0, prevEma50:0, prevEma200:0,
          macdCrossUp:false, macdCrossDown:false, macdAboveZero:false, macdBelowZero:false,
          rsiDivBull:false, rsiDivBear:false, rsiDivHiddenBull:false, rsiDivHiddenBear:false,
          equalHighs:false, equalLows:false,
          dispBull:false, dispBear:false, breakerBull:false, breakerBear:false,
          oteBull:false, oteBear:false, isConsolidating:false };
      }
    });
    return map;
  }, [tfFilter, lookback]);

  // ── Live prices ───────────────────────────────────────────────────────────
  const instrumentsWithLive = useMemo(() => allInstruments.map(inst => {
    let lp=null;
    if (inst.assetType==='Forex')   lp=forexRates[inst.symbol];
    if (inst.assetType==='Crypto')  lp=cryptoRates[inst.symbol];
    if (inst.assetType==='Metals')  lp=metalRates[inst.symbol];
    if (inst.assetType==='Indices'||inst.assetType==='Energy') lp=marketRates[inst.symbol];
    if (lp) {
      const dp=inst.bid>10000?0:inst.bid>100?2:inst.bid>1?3:5;
      const bid=parseFloat(lp.toFixed(dp));
      const ask=parseFloat((bid+inst.spread).toFixed(dp));
      return {...inst,bid,ask,isLive:true};
    }
    return {...inst,isLive:false};
  }), [forexRates, cryptoRates, metalRates, marketRates]);

  // ── Filtering ─────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = instrumentsWithLive;
    const a  = analysis;
    const f  = filters;

    if (f.category && f.category !== 'All') list = list.filter(i => i.assetType === f.category);
    if (subCategory !== 'All' && subCategories.length > 0) list = list.filter(i => i.category === subCategory);
    if (f.baseCurrency && f.baseCurrency !== 'All')
      list = list.filter(i => i.symbol.split('/')[0] === f.baseCurrency);
    if (signalFilter !== 'All') list = list.filter(i => i.signal === signalFilter);
    if (f.search?.trim()) {
      const q = f.search.trim().toUpperCase();
      list = list.filter(i => i.symbol.toUpperCase().includes(q));
    }
    if (f.rsiMin != null && f.rsiMin !== '') list = list.filter(i => (a[i.id]?.rsi||50) >= Number(f.rsiMin));
    if (f.rsiMax != null && f.rsiMax !== '') list = list.filter(i => (a[i.id]?.rsi||50) <= Number(f.rsiMax));
    if (f.mfiMin != null && f.mfiMin !== '') list = list.filter(i => (a[i.id]?.mfi||50) >= Number(f.mfiMin));
    if (f.mfiMax != null && f.mfiMax !== '') list = list.filter(i => (a[i.id]?.mfi||50) <= Number(f.mfiMax));
    if (f.changeMin != null && f.changeMin !== '') list = list.filter(i => i.change >= Number(f.changeMin));
    if (f.changeMax != null && f.changeMax !== '') list = list.filter(i => i.change <= Number(f.changeMax));
    if (f.candleType && f.candleType !== 'All') {
      const map = { bullish:'bull', bearish:'bear', neutral:'neut' };
      list = list.filter(i => a[i.id]?.patternType === (map[f.candleType]||f.candleType));
    }
    if (f.candlePattern && f.candlePattern !== 'All')
      list = list.filter(i => a[i.id]?.patternIds?.includes(f.candlePattern));
    if (f.requireNearResistance)  list = list.filter(i => a[i.id]?.nearResistance);
    if (f.requireNearSupport)     list = list.filter(i => a[i.id]?.nearSupport);
    if (f.requireBrokeResistance) list = list.filter(i => a[i.id]?.brokeResistance);
    if (f.requireBrokeSupport)    list = list.filter(i => a[i.id]?.brokeSupport);
    if (f.requireTrendlineBull || f.requireTrendlineBear) list = list.filter(i => a[i.id]?.nearTrendline);
    if (f.requireTrendlineBreak) list = list.filter(i => a[i.id]?.brokeTrendline);
    // OB filter: requireOb = price must be inside OB zone (obTap), not just any OB exists
    if (f.requireOb) list = list.filter(i => a[i.id]?.obTap);
    if (f.obDir === 'bullish') list = list.filter(i => a[i.id]?.hasBullOB);
    if (f.obDir === 'bearish') list = list.filter(i => a[i.id]?.hasBearOB);
    // FVG filter: requireFvg = price must be inside FVG zone (fvgTap)
    if (f.requireFvg) list = list.filter(i => a[i.id]?.fvgTap);
    if (f.fvgDir === 'bullish') list = list.filter(i => a[i.id]?.hasBullFVG);
    if (f.fvgDir === 'bearish') list = list.filter(i => a[i.id]?.hasBearFVG);
    if (f.requireFvg && f.requireOb && f.fvgObMode === 'OR')
      list = list.filter(i => a[i.id]?.fvgTap || a[i.id]?.obTap);
    if (f.requireBos)   list = list.filter(i => a[i.id]?.bosBullish || a[i.id]?.bosBearish);
    if (f.requireChoch) list = list.filter(i => a[i.id]?.chochBullish || a[i.id]?.chochBearish);
    if (f.structure !== 'All') list = list.filter(i => a[i.id]?.structure === f.structure);
    if (f.zone !== 'All') list = list.filter(i => a[i.id]?.zone === f.zone);
    if (f.liqType === 'bsl') list = list.filter(i => a[i.id]?.buySideLiq);
    if (f.liqType === 'ssl') list = list.filter(i => a[i.id]?.sellSideLiq);
    if (f.vwapBias === 'above') list = list.filter(i =>  a[i.id]?.vwapAbove);
    if (f.vwapBias === 'below') list = list.filter(i => !a[i.id]?.vwapAbove);

    // EMA price filter
    if (f.emaPriceFilter && f.emaPriceFilter !== 'Any') {
      const above = f.emaPriceFilter.startsWith('above');
      const per = parseInt(f.emaPriceFilter.replace('above','').replace('below',''));
      const key = `ema${per}`;
      if (above) list = list.filter(i => i.bid > (a[i.id]?.[key] || 0));
      else       list = list.filter(i => i.bid < (a[i.id]?.[key] || Infinity));
    }

    // EMA alignment filter
    if (f.emaAlignFilter && f.emaAlignFilter !== 'Any') {
      if (f.emaAlignFilter === '20_50')
        list = list.filter(i => (a[i.id]?.ema20||0) > (a[i.id]?.ema50||0));
      if (f.emaAlignFilter === '50_200')
        list = list.filter(i => (a[i.id]?.ema50||0) > (a[i.id]?.ema200||0));
    }

    // EMA cross filter
    if (f.emaCrossFilter && f.emaCrossFilter !== 'Any') {
      if (f.emaCrossFilter === 'cross_up_20_50')
        list = list.filter(i => { const ai=a[i.id]; return ai?.ema20>ai?.ema50 && ai?.prevEma20<=ai?.prevEma50; });
      if (f.emaCrossFilter === 'cross_dn_20_50')
        list = list.filter(i => { const ai=a[i.id]; return ai?.ema20<ai?.ema50 && ai?.prevEma20>=ai?.prevEma50; });
      if (f.emaCrossFilter === 'golden')
        list = list.filter(i => { const ai=a[i.id]; return ai?.ema50>ai?.ema200 && ai?.prevEma50<=ai?.prevEma200; });
      if (f.emaCrossFilter === 'death')
        list = list.filter(i => { const ai=a[i.id]; return ai?.ema50<ai?.ema200 && ai?.prevEma50>=ai?.prevEma200; });
    }

    // MACD filter
    if (f.macdFilter && f.macdFilter !== 'Any') {
      if (f.macdFilter === 'crossUp')   list = list.filter(i => a[i.id]?.macdCrossUp);
      if (f.macdFilter === 'crossDown') list = list.filter(i => a[i.id]?.macdCrossDown);
      if (f.macdFilter === 'aboveZero') list = list.filter(i => a[i.id]?.macdAboveZero);
      if (f.macdFilter === 'belowZero') list = list.filter(i => a[i.id]?.macdBelowZero);
    }

    // RSI divergence filter
    if (f.divFilter && f.divFilter !== 'Any') {
      if (f.divFilter === 'bull')       list = list.filter(i => a[i.id]?.rsiDivBull);
      if (f.divFilter === 'bear')       list = list.filter(i => a[i.id]?.rsiDivBear);
      if (f.divFilter === 'hiddenBull') list = list.filter(i => a[i.id]?.rsiDivHiddenBull);
      if (f.divFilter === 'hiddenBear') list = list.filter(i => a[i.id]?.rsiDivHiddenBear);
    }

    // Equal highs/lows filter
    if (f.equalFilter && f.equalFilter !== 'Any') {
      if (f.equalFilter === 'equalHighs') list = list.filter(i => a[i.id]?.equalHighs);
      if (f.equalFilter === 'equalLows')  list = list.filter(i => a[i.id]?.equalLows);
      if (f.equalFilter === 'either')     list = list.filter(i => a[i.id]?.equalHighs || a[i.id]?.equalLows);
    }

    // Displacement filter
    if (f.dispFilter && f.dispFilter !== 'Any') {
      if (f.dispFilter === 'bull')   list = list.filter(i => a[i.id]?.dispBull);
      if (f.dispFilter === 'bear')   list = list.filter(i => a[i.id]?.dispBear);
      if (f.dispFilter === 'either') list = list.filter(i => a[i.id]?.dispBull || a[i.id]?.dispBear);
    }

    // Breaker block filter
    if (f.breakerFilter && f.breakerFilter !== 'Any') {
      if (f.breakerFilter === 'bull')   list = list.filter(i => a[i.id]?.breakerBull);
      if (f.breakerFilter === 'bear')   list = list.filter(i => a[i.id]?.breakerBear);
      if (f.breakerFilter === 'either') list = list.filter(i => a[i.id]?.breakerBull || a[i.id]?.breakerBear);
    }

    // OTE filter
    if (f.oteFilter && f.oteFilter !== 'Any') {
      if (f.oteFilter === 'bull')   list = list.filter(i => a[i.id]?.oteBull);
      if (f.oteFilter === 'bear')   list = list.filter(i => a[i.id]?.oteBear);
      if (f.oteFilter === 'either') list = list.filter(i => a[i.id]?.oteBull || a[i.id]?.oteBear);
    }

    // Consolidation filter
    if (f.consolidatingFilter && f.consolidatingFilter !== 'Any') {
      if (f.consolidatingFilter === 'yes') list = list.filter(i =>  a[i.id]?.isConsolidating);
      if (f.consolidatingFilter === 'no')  list = list.filter(i => !a[i.id]?.isConsolidating);
    }

    // Volume spike filter
    if (f.volSpikeMin && f.volSpikeMin > 0) {
      const avgVol = allInstruments.reduce((s, inst) => s + inst.volume, 0) / (allInstruments.length || 1);
      list = list.filter(i => i.volume >= avgVol * f.volSpikeMin);
    }

    // Signal score filter
    if (f.signalScoreMin != null && f.signalScoreMin > -5) {
      const scoreMap = { STRONG_BUY:5, BUY:3, NEUTRAL:0, SELL:-3, STRONG_SELL:-5 };
      list = list.filter(i => (scoreMap[i.signal] ?? 0) >= f.signalScoreMin);
    }

    // Chart pattern filter (structural pattern approximated from candle behavior)
    if (f.chartPattern && f.chartPattern !== 'All') {
      const pName = f.chartPattern.split(':')[0];
      const bullPatterns = ['falling_wedge','ascending_triangle','double_bottom','inv_head_shoulders','bull_flag','channel_up'];
      const bearPatterns = ['rising_wedge','descending_triangle','double_top','head_shoulders','bear_flag','channel_down'];
      const isBullPat = bullPatterns.includes(pName);
      const isBearPat = bearPatterns.includes(pName);
      if (isBullPat) list = list.filter(i => a[i.id]?.structure === 'bullish' || a[i.id]?.rsiDivBull || a[i.id]?.oteBull);
      else if (isBearPat) list = list.filter(i => a[i.id]?.structure === 'bearish' || a[i.id]?.rsiDivBear || a[i.id]?.oteBear);
    }

    return [...list].sort((a,b) => {
      let av=a[sortKey],bv=b[sortKey];
      if(typeof av==='string'){av=av.toLowerCase();bv=bv.toLowerCase();}
      if(av<bv) return sortDir==='asc'?-1:1;
      if(av>bv) return sortDir==='asc'?1:-1;
      return 0;
    });
  }, [instrumentsWithLive, analysis, filters, signalFilter, sortKey, sortDir, subCategory, subCategories]);

  const total   = filtered.length;
  const bullish = filtered.filter(p=>['STRONG_BUY','BUY'].includes(p.signal)).length;
  const bearish = filtered.filter(p=>['STRONG_SELL','SELL'].includes(p.signal)).length;
  const neutral = filtered.filter(p=>p.signal==='NEUTRAL').length;
  const liveCount = filtered.filter(i=>i.isLive).length;

  const counts = useMemo(() => {
    const c={};
    ASSET_TYPES.forEach(t=>{c[t]=t==='All'?allInstruments.length:allInstruments.filter(i=>i.assetType===t).length;});
    return c;
  }, []);

  const cols = [
    { key:'symbol',   label:'Symbol',   width:130 },
    { key:null,       label:'Chart',    width:80  },
    { key:'assetType',label:'Type',     width:80  },
    { key:'category', label:'Category', width:90  },
    { key:'bid',      label:'Bid',      width:100 },
    { key:'ask',      label:'Ask',      width:100 },
    { key:'spread',   label:'Spread',   width:80  },
    { key:'change',   label:'Change %', width:90  },
    { key:'high',     label:'High',     width:100 },
    { key:'low',      label:'Low',      width:100 },
    { key:'volume',   label:'Volume',   width:90  },
    { key:null,       label:'RSI',      width:110 },
    { key:null,       label:'MFI',      width:110 },
    { key:null,       label:'SMC',      width:140 },
    { key:null,       label:'Zone',     width:75  },
    { key:null,       label:'Struct',   width:80  },
    { key:null,       label:'Score',    width:55  },
    { key:null,       label:'Strength', width:90  },
    { key:'signal',   label:'Signal',   width:120 },
    { key:null,       label:'Sentiment',width:80  },
  ];

  return (
    <div className="screener-root">

      <SessionClock/>
      <KillzoneBar/>

      {/* ── Asset type tabs ──────────────────────────────────────────────── */}
      <div className="asset-type-row">
        {ASSET_TYPES.map(t => {
          const c=ASSET_COLORS[t]||{color:'#94a3b8',bg:'#1e293b55'};
          const active=(filters.category||'All')===t;
          return (
            <button key={t} className={`asset-type-btn ${active?'active':''}`}
              style={active?{borderColor:c.color,color:c.color,background:c.bg}:{}}
              onClick={()=>{ setFilters(f=>({...f,category:t,baseCurrency:'All'})); setSubCategory('All'); }}>
              <span className="asset-type-icon">{t==='All'?'◈':t==='Forex'?'₣':t==='Metals'?'⬡':t==='Indices'?'📊':t==='Energy'?'⚡':'₿'}</span>
              {t}<span className="asset-type-count">{counts[t]}</span>
            </button>
          );
        })}
      </div>

      {/* ── Compact status + summary bar ─────────────────────────────────── */}
      <div className="screener-topbar">
        <div className="screener-topbar-left">
          {loading
            ? <span className="topbar-status loading">⟳ Connecting…</span>
            : error
            ? <span className="topbar-status error">⚠ {error}</span>
            : <><span className="topbar-live-dot"/><span className="topbar-status live">{oandaStatus.connected?'OANDA':'LIVE'} — {liveCount} instruments</span></>
          }
          <span className="topbar-divider"/>
          <span className="topbar-time">{lastUpdate?lastUpdate.toLocaleTimeString():'—'}</span>
          <OandaConnect status={oandaStatus} onConnect={connectOanda} onDisconnect={disconnectOanda}/>
        </div>
        <div className="screener-topbar-right">
          {/* Summary stats */}
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <div style={{ fontSize:11, color:'#475569' }}><span style={{ color:'#00d4aa', fontWeight:800, fontSize:13 }}>{total}</span> shown</div>
            <span style={{ color:'#1e293b' }}>|</span>
            <div style={{ display:'flex', alignItems:'center', gap:3 }}>
              <span style={{ fontSize:10, padding:'2px 9px', borderRadius:12, background:'#22c55e18', color:'#22c55e', fontWeight:700, border:'1px solid #22c55e33' }}>{bullish}+ Buy</span>
              <span style={{ fontSize:10, padding:'2px 9px', borderRadius:12, background:'#ef444418', color:'#ef4444', fontWeight:700, border:'1px solid #ef444433' }}>{bearish}+ Sell</span>
              <span style={{ fontSize:10, padding:'2px 9px', borderRadius:12, background:'#1e293b', color:'#64748b', fontWeight:700, border:'1px solid #334155' }}>{neutral} Neutral</span>
            </div>
          </div>
          <span className="topbar-divider"/>
          <span style={{color:'#475569',fontSize:11}}>TF: <strong style={{color:'#00d4aa'}}>{tfFilter.toUpperCase()}</strong></span>
          <button onClick={refresh} className="topbar-refresh-btn" title="Refresh">↻</button>
        </div>
      </div>

      {/* ── Toolbar row 1: filter toggle + subcategory tabs ─────────────── */}
      <div className="screener-toolbar">
        <button
          className={`filter-toggle-btn ${showFilters ? 'active' : ''}`}
          onClick={() => setShowFilters(s => !s)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/>
          </svg>
          Filters
          {activeFilterCount > 0 && <span className="filter-count-badge">{activeFilterCount}</span>}
        </button>

        {subCategories.length > 0 && subCategories.map(c=>(
          <button key={c} className={`tab-btn ${subCategory===c?'active':''}`} onClick={()=>setSubCategory(c)}>{c}</button>
        ))}
      </div>

      {/* ── Toolbar row 2: signal filter tabs (full-width scrollable) ─────── */}
      <div className="signal-tab-group">
        {['All','STRONG_BUY','BUY','NEUTRAL','SELL','STRONG_SELL'].map(s=>(
          <button key={s}
            className={`signal-tab-btn ${signalFilter===s?'active':''}`}
            style={signalFilter===s&&s!=='All'?{color:SIGNALS[s]?.color,borderColor:SIGNALS[s]?.color,background:SIGNALS[s]?.bg}:{}}
            onClick={()=>setSignalFilter(s)}>
            {s==='All'?'All Signals':SIGNALS[s]?.label}
          </button>
        ))}
      </div>

      {/* ── Technical Levels modal ───────────────────────────────────────── */}
      {levelsInst && (
        <div style={{ position:'fixed', inset:0, background:'rgba(4,7,15,0.97)', zIndex:2000,
          display:'flex', flexDirection:'column' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'12px 16px', background:'#06090f', borderBottom:'1px solid #0f1929', flexShrink:0 }}>
            <div style={{ fontSize:14, fontWeight:900, color:'#f1f5f9' }}>📐 {levelsInst.symbol}</div>
            <button onClick={() => setLevelsInst(null)} style={{ background:'#0a0e1a',
              border:'1px solid #1e293b', borderRadius:8, color:'#94a3b8',
              fontSize:18, cursor:'pointer', padding:'3px 10px', lineHeight:1 }}>✕</button>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:12 }}>
            <TechnicalPanel pairKey={levelsInst.id} label={levelsInst.symbol} />
          </div>
        </div>
      )}

      {/* ── Chart modal ──────────────────────────────────────────────────── */}
      {chartInstrument && <ChartModal instrument={chartInstrument} onClose={()=>setChartInstrument(null)}/>}

      {/* Intermarket Conditions Bar */}
      {imSignals && (
        <div style={{ display:'flex', gap:6, padding:'5px 12px', overflowX:'auto', borderBottom:'1px solid #0f172a', background:'#060a10', scrollbarWidth:'none', alignItems:'center' }}>
          <span style={{ fontSize:9, color:'#334155', flexShrink:0, fontWeight:700, letterSpacing:'0.08em' }}>MARKETS</span>
          {IM_DEFS.map(def => {
            const sig = imSignals[def.key];
            if (!sig) return null;
            const up = sig.direction === 'rising';
            return (
              <div key={def.key} style={{ display:'flex', alignItems:'center', gap:4, padding:'3px 10px', borderRadius:6,
                background: up ? '#22c55e10' : '#ef444410',
                border: `1px solid ${up ? '#22c55e30' : '#ef444430'}`, flexShrink:0 }}>
                <span style={{ fontSize:10, fontWeight:700, color: def.color }}>{def.label}</span>
                <span style={{ fontSize:10, color: up ? '#22c55e' : '#ef4444', fontWeight:800 }}>{up ? '▲' : '▼'}</span>
                <span style={{ fontSize:9, color: up ? '#22c55e99' : '#ef444499', fontFamily:'monospace' }}>
                  {sig.pct >= 0 ? '+' : ''}{sig.pct.toFixed(2)}%
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Main: filter sidebar + table ─────────────────────────────────── */}
      <div className="screener-body">

        {/* Mobile backdrop */}
        {showFilters && (
          <div className="filter-backdrop" onClick={() => setShowFilters(false)} />
        )}

        {/* Filter sidebar */}
        {showFilters && (
          <div className="filter-sidebar-wrap">
            <FilterPanel
              filters={filters}
              onChange={setFilters}
              onReset={() => setFilters({ ...DEFAULT_FILTERS })}
              onClose={() => setShowFilters(false)}
              resultCount={filtered.length}
              totalCount={allInstruments.length}
              allPairs={allInstruments}
            />
          </div>
        )}

        {/* Table area */}
        <div className="screener-table-area">
          <div className="table-wrap">
            <table className="screener-table">
              <thead>
                <tr>
                  {cols.map(c=>(
                    <th key={c.label} style={{minWidth:c.width,cursor:c.key?'pointer':'default'}} onClick={()=>c.key&&handleSort(c.key)}>
                      {c.label}{c.key&&<SortIcon col={c.key} sortKey={sortKey} dir={sortDir}/>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length===0?(
                  <tr><td colSpan={cols.length} style={{textAlign:'center',padding:'48px 0',color:'#475569'}}>
                    <div style={{fontSize:28,marginBottom:8}}>🔍</div>
                    No instruments match your filters
                  </td></tr>
                ):filtered.map(p => {
                  const ai = analysis[p.id] || {};
                  const isWatched = watchlist.includes(p.symbol);
                  const sent = sentimentHasCreds ? sentiment[p.id] : null;
                  return (
                    <tr key={p.id} className="pair-row">
                      {/* Symbol */}
                      <td>
                        <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                            <span className="pair-symbol">{p.symbol}</span>
                            <LiveBadge isLive={p.isLive}/>
                          </div>
                          {p.unit && <span className="pair-category">{p.unit}</span>}
                        </div>
                      </td>
                      {/* Chart + sparkline + actions */}
                      <td>
                        <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                          <Sparkline data={p.sparkline} change={p.change}/>
                          <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                            <button className="chart-open-btn" title="Open chart" onClick={() => setChartInstrument(p)}>📈</button>
                            <button className="chart-open-btn" title="Technical Levels" onClick={() => setLevelsInst(p)}>📐</button>
                            <button className={`wl-star-btn${isWatched ? ' active' : ''}`} title={isWatched ? 'Remove' : 'Add to watchlist'} onClick={() => toggleWatch(p.symbol)}>
                              {isWatched ? '★' : '☆'}
                            </button>
                          </div>
                        </div>
                      </td>
                      {/* Type */}
                      <td><AssetBadge type={p.assetType}/></td>
                      {/* Category */}
                      <td><span className="pair-category" style={{ fontSize:12 }}>{p.category}</span></td>
                      {/* Bid */}
                      <td className="mono">{fmtPrice(p.bid)}</td>
                      {/* Ask */}
                      <td className="mono">{fmtPrice(p.ask)}</td>
                      {/* Spread */}
                      <td className="mono spread-cell">{fmtPrice(p.spread)}</td>
                      {/* Change */}
                      <td>
                        <span style={{ fontWeight:700, fontFamily:'monospace', fontSize:12,
                          color: p.change >= 0 ? '#22c55e' : '#ef4444' }}>
                          {p.change >= 0 ? '▲' : '▼'} {Math.abs(p.change).toFixed(2)}%
                        </span>
                      </td>
                      {/* High */}
                      <td className="mono muted">{fmtPrice(p.high)}</td>
                      {/* Low */}
                      <td className="mono muted">{fmtPrice(p.low)}</td>
                      {/* Volume */}
                      <td className="mono muted">{p.volume.toLocaleString()}</td>
                      {/* RSI */}
                      <td><RsiBar value={ai.rsi || p.rsi} ob={70} os={30}/></td>
                      {/* MFI */}
                      <td><RsiBar value={ai.mfi || 50} ob={80} os={20}/></td>
                      {/* SMC */}
                      <td><SmcTagRow bosBullish={ai.bosBullish} bosBearish={ai.bosBearish} chochBullish={ai.chochBullish} chochBearish={ai.chochBearish} hasFvg={ai.hasFVG} hasOb={ai.hasOB}/></td>
                      {/* Zone */}
                      <td><ZoneBadge zone={ai.zone}/></td>
                      {/* Structure */}
                      <td><StructBadge structure={ai.structure}/></td>
                      {/* AI Score circle */}
                      <td style={{ padding:'6px 8px' }}>
                        <AIScoreCircle score={ai.strength || 50} dir={ai.strengthDir || 'neutral'}/>
                      </td>
                      {/* Strength bar */}
                      <td><StrengthBar value={ai.strength || 50} dir={ai.strengthDir || 'neutral'}/></td>
                      {/* Signal */}
                      <td><SignalBadge signal={p.signal}/></td>
                      {/* Sentiment */}
                      <td style={{ textAlign:'center', padding:'8px 6px' }}>
                        {!sentimentHasCreds ? (
                          <span title="Connect OANDA API key to see retail sentiment" style={{ fontSize:9, color:'#475569', cursor:'default' }}>🔑 key</span>
                        ) : sent ? (
                          <span style={{ fontSize:10, fontWeight:700, fontFamily:'monospace',
                            color: sent.longPct > 60 ? '#f43f5e' : sent.longPct < 40 ? '#22c55e' : '#8b949e' }}>
                            {sent.longPct}%L
                          </span>
                        ) : <span style={{ color:'#374151', fontSize:10 }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="table-footer">
            Showing <strong>{filtered.length}</strong> of <strong>{allInstruments.length}</strong> instruments
            &nbsp;·&nbsp;<span style={{color:'#475569'}}>TF: {tfFilter.toUpperCase()} · {new Date().toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

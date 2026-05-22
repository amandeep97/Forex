import { useState, useMemo } from 'react';
import { allInstruments, ASSET_TYPES, FOREX_CATEGORIES, SIGNALS, ASSET_COLORS } from '../data/forexData';
import { useLivePrices } from '../hooks/useLivePrices';
import { generateCandles } from '../utils/generateCandles';
import { detectCandlePatterns, CANDLE_PATTERNS } from '../utils/candlePatterns';
import { analyzeSMC } from '../utils/smcAnalysis';
import { computeRSI, computeMFI } from '../utils/indicatorCalc';
import { computeVWAP } from '../utils/smcHelpers';
import ChartModal from './ChartModal';
import OandaConnect from './OandaConnect';

const SCREENER_TFS = ['1M','2M','3M','5M','15M','30M','1H','2H','4H','8H','D','W'];
const ALL_PATTERNS = [{ id:'', name:'Any Pattern' }, ...CANDLE_PATTERNS];

// ── Sub-components ────────────────────────────────────────────────────────────
function Sparkline({ data, change }) {
  const w=80, h=28;
  if (!data||data.length<2) return null;
  const min=Math.min(...data),max=Math.max(...data),range=max-min||0.0001;
  const pts=data.map((v,i)=>`${((i/(data.length-1))*w).toFixed(1)},${(h-((v-min)/range)*h).toFixed(1)}`).join(' ');
  return <svg width={w} height={h} style={{display:'block'}}><polyline points={pts} fill="none" stroke={change>=0?'#22c55e':'#ef4444'} strokeWidth="1.5" strokeLinejoin="round"/></svg>;
}

function SignalBadge({ signal }) {
  const s=SIGNALS[signal]; if(!s) return null;
  return <span style={{padding:'2px 8px',borderRadius:4,fontSize:11,fontWeight:600,color:s.color,background:s.bg,border:`1px solid ${s.color}44`,whiteSpace:'nowrap'}}>{s.label}</span>;
}

function AssetBadge({ type }) {
  const c=ASSET_COLORS[type]||{color:'#94a3b8',bg:'#1e293b55'};
  return <span style={{padding:'1px 6px',borderRadius:3,fontSize:10,fontWeight:600,color:c.color,background:c.bg,border:`1px solid ${c.color}44`,whiteSpace:'nowrap'}}>{type}</span>;
}

function RsiBar({ value, ob=70, os=30 }) {
  const color=value>=ob?'#ef4444':value<=os?'#22c55e':'#94a3b8';
  return (
    <div style={{display:'flex',alignItems:'center',gap:6}}>
      <div style={{width:48,height:4,background:'#1e293b',borderRadius:2,overflow:'hidden'}}>
        <div style={{width:`${value}%`,height:'100%',background:color,borderRadius:2}}/>
      </div>
      <span style={{fontSize:11,color,fontFamily:'JetBrains Mono',minWidth:28}}>{value}</span>
    </div>
  );
}

function SortIcon({ col, sortKey, dir }) {
  if (sortKey!==col) return <span style={{color:'#334155',marginLeft:3}}>⇅</span>;
  return <span style={{color:'#00d4aa',marginLeft:3}}>{dir==='asc'?'↑':'↓'}</span>;
}

function SummaryCard({ label, value, color }) {
  return <div className="summary-card"><span className="summary-value" style={{color}}>{value}</span><span className="summary-label">{label}</span></div>;
}

function fmtPrice(v) {
  if(v==null) return '—';
  if(v>=10000) return v.toFixed(0);
  if(v>=100)   return v.toFixed(2);
  if(v>=1)     return v.toFixed(3);
  return v.toFixed(5);
}

function SmcTagRow({ bosBullish, bosBearish, chochBullish, chochBearish, hasFvg, hasOb }) {
  const tags = [];
  if (bosBullish)  tags.push(<span key="bosb" style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#22c55e',background:'#22c55e18',border:'1px solid #22c55e44'}}>BOS↑</span>);
  if (bosBearish)  tags.push(<span key="bosr" style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#ef4444',background:'#ef444418',border:'1px solid #ef444444'}}>BOS↓</span>);
  if (chochBullish) tags.push(<span key="chb" style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#eab308',background:'#eab30818',border:'1px solid #eab30844'}}>ChoCh↑</span>);
  if (chochBearish) tags.push(<span key="chr" style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#f97316',background:'#f9731618',border:'1px solid #f9731644'}}>ChoCh↓</span>);
  if (hasFvg) tags.push(<span key="fvg" style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#00d4aa',background:'#00d4aa12',border:'1px solid #00d4aa44'}}>FVG</span>);
  if (hasOb)  tags.push(<span key="ob" style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#a78bfa',background:'#a78bfa12',border:'1px solid #a78bfa44'}}>OB</span>);
  if (tags.length === 0) return <span style={{color:'#334155',fontSize:10}}>—</span>;
  return <div style={{display:'flex',flexWrap:'wrap',gap:2}}>{tags}</div>;
}

function ZoneBadge({ zone }) {
  if (zone === 'premium')  return <span style={{padding:'2px 6px',borderRadius:4,fontSize:10,fontWeight:700,color:'#ef4444',background:'#ef444418',border:'1px solid #ef444444'}}>▲ Prem</span>;
  if (zone === 'discount') return <span style={{padding:'2px 6px',borderRadius:4,fontSize:10,fontWeight:700,color:'#22c55e',background:'#22c55e18',border:'1px solid #22c55e44'}}>▼ Disc</span>;
  return <span style={{color:'#475569',fontSize:10}}>—</span>;
}

function StructBadge({ structure }) {
  if (structure === 'bullish') return <span style={{padding:'2px 6px',borderRadius:4,fontSize:10,fontWeight:700,color:'#22c55e',background:'#22c55e18',border:'1px solid #22c55e44'}}>Bullish</span>;
  if (structure === 'bearish') return <span style={{padding:'2px 6px',borderRadius:4,fontSize:10,fontWeight:700,color:'#ef4444',background:'#ef444418',border:'1px solid #ef444444'}}>Bearish</span>;
  return <span style={{color:'#475569',fontSize:10}}>Neutral</span>;
}

function StrengthBar({ value, dir }) {
  const color = dir === 'bullish' ? '#22c55e' : dir === 'bearish' ? '#ef4444' : '#94a3b8';
  return (
    <div style={{display:'flex',alignItems:'center',gap:5}}>
      <div style={{width:44,height:5,background:'#1e293b',borderRadius:3,overflow:'hidden'}}>
        <div style={{width:`${value}%`,height:'100%',background:color,borderRadius:3}}/>
      </div>
      <span style={{fontSize:10,color,fontFamily:'var(--mono)',minWidth:28,fontWeight:600}}>{value}%</span>
    </div>
  );
}

function LiveBadge({ isLive }) {
  return isLive
    ? <span style={{display:'inline-flex',alignItems:'center',gap:4,padding:'1px 6px',borderRadius:10,fontSize:9,fontWeight:700,color:'#22c55e',background:'#22c55e18',border:'1px solid #22c55e44'}}><span style={{width:5,height:5,borderRadius:'50%',background:'#22c55e',display:'inline-block',animation:'pulse 1.4s infinite'}}/> LIVE</span>
    : <span style={{padding:'1px 6px',borderRadius:10,fontSize:9,fontWeight:700,color:'#475569',background:'#1e293b',border:'1px solid #334155'}}>DEMO</span>;
}

function Toggle({ on, onChange, label, desc }) {
  return (
    <div className="sf-toggle-row" onClick={()=>onChange(!on)}>
      <div className="sf-toggle-info">
        <span className="sf-toggle-label">{label}</span>
        {desc && <span className="sf-toggle-desc">{desc}</span>}
      </div>
      <div className={`sf-toggle ${on?'on':''}`}><div className="sf-toggle-knob"/></div>
    </div>
  );
}

function FilterSection({ title, icon, children, defaultOpen=false }) {
  const [open,setOpen]=useState(defaultOpen);
  return (
    <div className="sf-section">
      <button className="sf-section-head" onClick={()=>setOpen(o=>!o)}>
        <span>{icon} {title}</span>
        <span style={{fontSize:10,color:'#475569'}}>{open?'▲':'▼'}</span>
      </button>
      {open && <div className="sf-section-body">{children}</div>}
    </div>
  );
}

function RangeInput({ label, value, onChange, min=1, max=200 }) {
  return (
    <div className="sf-range-row">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span className="sf-row-label" style={{margin:0}}>{label}</span>
        <span style={{fontSize:12,color:'var(--accent)',fontFamily:'var(--mono)',fontWeight:700}}>{value}</span>
      </div>
      <input type="range" className="sf-slider" value={value} min={min} max={max}
        onChange={e=>onChange(Number(e.target.value))}/>
    </div>
  );
}

// ── Main Screener ─────────────────────────────────────────────────────────────
export default function Screener() {
  const { forexRates, cryptoRates, metalRates, marketRates, lastUpdate, loading, error, refresh,
          oandaStatus, connectOanda, disconnectOanda } = useLivePrices();

  // View
  const [assetType, setAssetType]     = useState('All');
  const [subCategory, setSubCategory] = useState('All');
  const [search, setSearch]           = useState('');
  const [sortKey, setSortKey]         = useState('symbol');
  const [sortDir, setSortDir]         = useState('asc');
  const [signalFilter, setSignalFilter] = useState('All');
  const [showFilters, setShowFilters] = useState(false);

  // Timeframe for analysis
  const [tfFilter, setTfFilter] = useState('1H');

  // Candlestick pattern
  const [patternType, setPatternType]         = useState('All');
  const [specificPattern, setSpecificPattern] = useState('');
  const [patternLookback, setPatternLookback] = useState(5); // how many recent candles to scan

  // RSI settings
  const [rsiLength, setRsiLength] = useState(14);
  const [rsiOB, setRsiOB]         = useState(70);
  const [rsiOS, setRsiOS]         = useState(30);
  const [rsiFilter, setRsiFilter] = useState('All');

  // MFI settings
  const [mfiLength, setMfiLength] = useState(14);
  const [mfiOB, setMfiOB]         = useState(80);
  const [mfiOS, setMfiOS]         = useState(20);
  const [mfiFilter, setMfiFilter] = useState('All');

  // S&R
  const [nearRes, setNearRes]   = useState(false);
  const [nearSup, setNearSup]   = useState(false);
  const [brokeRes, setBrokeRes] = useState(false);
  const [brokeSup, setBrokeSup] = useState(false);

  // Trendlines
  const [nearTL, setNearTL]   = useState(false);
  const [brokeTL, setBrokeTL] = useState(false);

  // SMC
  const [smcOB,     setSmcOB]     = useState(false);
  const [smcFVG,    setSmcFVG]    = useState(false);
  const [bosDir,    setBosDir]    = useState('All');   // All | Bullish | Bearish
  const [chochDir,  setChochDir]  = useState('All');   // All | Bullish | Bearish
  const [zoneFilter, setZoneFilter] = useState('All'); // All | Premium | Discount
  const [liqFilter,  setLiqFilter]  = useState('All'); // All | Buy Side | Sell Side

  // Volume
  const [volFilter, setVolFilter] = useState('All');

  // Chart
  const [chartInstrument, setChartInstrument] = useState(null);

  // Watchlist (persisted in localStorage)
  const [watchlist, setWatchlist] = useState(() => {
    try { return JSON.parse(localStorage.getItem('forex_watchlist')) || []; } catch { return []; }
  });
  const toggleWatch = sym => {
    setWatchlist(prev => {
      const next = prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym];
      localStorage.setItem('forex_watchlist', JSON.stringify(next));
      return next;
    });
  };

  const handleSort = (key) => {
    if (sortKey===key) setSortDir(d=>d==='asc'?'desc':'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const subCategories = useMemo(() => {
    if (assetType==='All'||assetType==='Crypto') return [];
    if (assetType==='Forex') return FOREX_CATEGORIES;
    const cats=[...new Set(allInstruments.filter(i=>i.assetType===assetType).map(i=>i.category))];
    return ['All',...cats];
  }, [assetType]);

  // ── Compute per-instrument analysis (candles → RSI, MFI, SMC, patterns) ──
  const analysis = useMemo(() => {
    const map = {};
    allInstruments.forEach(inst => {
      try {
        const candles  = generateCandles(inst, tfFilter, 60);
        const rsiVal   = computeRSI(candles, rsiLength);
        const mfiVal   = computeMFI(candles, mfiLength);
        const smc      = analyzeSMC(candles);
        const patterns = detectCandlePatterns(candles, patternLookback);
        const cp       = candles[candles.length - 1].c;

        const bosBullish   = smc.bosChoch.some(b=>b.type==='BOS'&&b.direction==='bullish');
        const bosBearish   = smc.bosChoch.some(b=>b.type==='BOS'&&b.direction==='bearish');
        const chochBullish = smc.bosChoch.some(b=>b.type==='CHoCH'&&b.direction==='bullish');
        const chochBearish = smc.bosChoch.some(b=>b.type==='CHoCH'&&b.direction==='bearish');
        const hasOB  = smc.orderBlocks.length>0;
        const hasFVG = smc.fvgs.length>0;
        const zone   = smc.premiumDiscount?.zone || 'discount';

        // VWAP position
        const vwapSeries = computeVWAP(candles);
        const lastVwap   = vwapSeries[vwapSeries.length-1];
        const vwapAbove  = cp >= (lastVwap || cp);

        // Market structure
        const structure = (bosBullish||chochBullish) ? 'bullish'
                        : (bosBearish||chochBearish) ? 'bearish' : 'neutral';

        // Signal strength 0-100
        let sBull = 0, sBear = 0;
        if (rsiVal < rsiOS)       sBull += 2; else if (rsiVal > rsiOB) sBear += 2;
        else if (rsiVal < 45)     sBull++;    else if (rsiVal > 55)    sBear++;
        if (mfiVal < 40) sBull++;  else if (mfiVal > 60) sBear++;
        if (bosBullish)  sBull += 2; if (bosBearish)  sBear += 2;
        if (chochBullish) sBull++;   if (chochBearish) sBear++;
        if (hasFVG) { if (structure==='bullish') sBull++; else sBear++; }
        if (hasOB)  { if (structure==='bullish') sBull++; else sBear++; }
        if (zone==='discount') sBull++; else if (zone==='premium') sBear++;
        if (vwapAbove) sBull++; else sBear++;
        const stTotal = sBull + sBear || 1;
        const strength    = Math.round((Math.max(sBull, sBear) / stTotal) * 100);
        const strengthDir = sBull > sBear ? 'bullish' : sBear > sBull ? 'bearish' : 'neutral';

        map[inst.id] = {
          rsi: rsiVal, mfi: mfiVal,
          // S&R
          nearResistance:  smc.supportResistance.some(s=>s.type==='resistance'&&s.isNear),
          nearSupport:     smc.supportResistance.some(s=>s.type==='support'&&s.isNear),
          brokeResistance: bosBullish,
          brokeSupport:    bosBearish,
          // Trendlines
          nearTrendline:  smc.trendlines.some(t=>t.isNear),
          brokeTrendline: smc.trendlines.some(t=>t.isBroken),
          // SMC
          hasOB, hasFVG, bosBullish, bosBearish, chochBullish, chochBearish,
          zone, structure, strength, strengthDir, vwapAbove,
          buySideLiq:  smc.liquidity.some(l=>l.type==='low'&&Math.abs(l.price-cp)/(cp||1)<0.006),
          sellSideLiq: smc.liquidity.some(l=>l.type==='high'&&Math.abs(l.price-cp)/(cp||1)<0.006),
          // Patterns
          patternIds:  patterns.map(p=>p.id),
          patternType: patterns.length===0?'neut':
                       patterns.some(p=>p.type==='bullish')?'bull':
                       patterns.some(p=>p.type==='bearish')?'bear':'neut',
        };
      } catch(e) {
        map[inst.id] = { rsi:50, mfi:50, nearResistance:false, nearSupport:false,
          brokeResistance:false, brokeSupport:false, nearTrendline:false,
          brokeTrendline:false, hasOB:false, hasFVG:false, bosBullish:false,
          bosBearish:false, chochBullish:false, chochBearish:false,
          zone:'discount', structure:'neutral', strength:50, strengthDir:'neutral',
          vwapAbove:true, buySideLiq:false, sellSideLiq:false,
          patternIds:[], patternType:'neut' };
      }
    });
    return map;
  }, [tfFilter, rsiLength, mfiLength, patternLookback, rsiOB, rsiOS]);

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

    if (assetType!=='All') list=list.filter(i=>i.assetType===assetType);
    if (subCategory!=='All'&&subCategories.length>0) list=list.filter(i=>i.category===subCategory);
    if (signalFilter!=='All') list=list.filter(i=>i.signal===signalFilter);

    // RSI (using computed value)
    if (rsiFilter==='Overbought') list=list.filter(i=>a[i.id]?.rsi>=rsiOB);
    if (rsiFilter==='Neutral')    list=list.filter(i=>{ const r=a[i.id]?.rsi||50; return r>rsiOS&&r<rsiOB; });
    if (rsiFilter==='Oversold')   list=list.filter(i=>a[i.id]?.rsi<=rsiOS);

    // MFI
    if (mfiFilter==='Overbought') list=list.filter(i=>a[i.id]?.mfi>=mfiOB);
    if (mfiFilter==='Neutral')    list=list.filter(i=>{ const m=a[i.id]?.mfi||50; return m>mfiOS&&m<mfiOB; });
    if (mfiFilter==='Oversold')   list=list.filter(i=>a[i.id]?.mfi<=mfiOS);

    // Volume
    const vols=instrumentsWithLive.map(i=>i.volume).sort((x,y)=>x-y);
    const v33=vols[Math.floor(vols.length/3)],v66=vols[Math.floor(vols.length*2/3)];
    if (volFilter==='High Vol')   list=list.filter(i=>i.volume>v66);
    if (volFilter==='Medium Vol') list=list.filter(i=>i.volume>=v33&&i.volume<=v66);
    if (volFilter==='Low Vol')    list=list.filter(i=>i.volume<v33);

    // Candlestick patterns
    if (patternType==='Bull') list=list.filter(i=>a[i.id]?.patternType==='bull');
    if (patternType==='Bear') list=list.filter(i=>a[i.id]?.patternType==='bear');
    if (patternType==='Neut') list=list.filter(i=>a[i.id]?.patternType==='neut');
    if (specificPattern)      list=list.filter(i=>a[i.id]?.patternIds?.includes(specificPattern));

    // S&R
    if (nearRes)  list=list.filter(i=>a[i.id]?.nearResistance);
    if (nearSup)  list=list.filter(i=>a[i.id]?.nearSupport);
    if (brokeRes) list=list.filter(i=>a[i.id]?.brokeResistance);
    if (brokeSup) list=list.filter(i=>a[i.id]?.brokeSupport);

    // Trendlines
    if (nearTL)  list=list.filter(i=>a[i.id]?.nearTrendline);
    if (brokeTL) list=list.filter(i=>a[i.id]?.brokeTrendline);

    // SMC
    if (smcOB)  list=list.filter(i=>a[i.id]?.hasOB);
    if (smcFVG) list=list.filter(i=>a[i.id]?.hasFVG);

    // BOS
    if (bosDir==='Bullish') list=list.filter(i=>a[i.id]?.bosBullish);
    if (bosDir==='Bearish') list=list.filter(i=>a[i.id]?.bosBearish);

    // CHoCH
    if (chochDir==='Bullish') list=list.filter(i=>a[i.id]?.chochBullish);
    if (chochDir==='Bearish') list=list.filter(i=>a[i.id]?.chochBearish);

    // Zone
    if (zoneFilter==='Premium')  list=list.filter(i=>a[i.id]?.zone==='premium');
    if (zoneFilter==='Discount') list=list.filter(i=>a[i.id]?.zone==='discount');

    // Liquidity
    if (liqFilter==='Buy Side')  list=list.filter(i=>a[i.id]?.buySideLiq);
    if (liqFilter==='Sell Side') list=list.filter(i=>a[i.id]?.sellSideLiq);

    if (search.trim()) {
      const q=search.trim().toUpperCase();
      list=list.filter(i=>i.symbol.toUpperCase().includes(q));
    }
    return [...list].sort((a,b)=>{
      let av=a[sortKey],bv=b[sortKey];
      if(typeof av==='string'){av=av.toLowerCase();bv=bv.toLowerCase();}
      if(av<bv) return sortDir==='asc'?-1:1;
      if(av>bv) return sortDir==='asc'?1:-1;
      return 0;
    });
  }, [instrumentsWithLive, analysis, assetType, subCategory, search, sortKey, sortDir, signalFilter,
      subCategories, rsiFilter, rsiOB, rsiOS, mfiFilter, mfiOB, mfiOS, volFilter,
      patternType, specificPattern, nearRes, nearSup, brokeRes, brokeSup,
      nearTL, brokeTL, smcOB, smcFVG, bosDir, chochDir, zoneFilter, liqFilter]);

  const total=filtered.length;
  const bullish=filtered.filter(p=>['STRONG_BUY','BUY'].includes(p.signal)).length;
  const bearish=filtered.filter(p=>['STRONG_SELL','SELL'].includes(p.signal)).length;
  const neutral=filtered.filter(p=>p.signal==='NEUTRAL').length;
  const liveCount=filtered.filter(i=>i.isLive).length;

  const counts = useMemo(() => {
    const c={};
    ASSET_TYPES.forEach(t=>{c[t]=t==='All'?allInstruments.length:allInstruments.filter(i=>i.assetType===t).length;});
    return c;
  }, []);

  const activeFilterCount = [
    rsiFilter!=='All', mfiFilter!=='All', volFilter!=='All',
    patternType!=='All', !!specificPattern,
    nearRes, nearSup, brokeRes, brokeSup, nearTL, brokeTL,
    smcOB, smcFVG, bosDir!=='All', chochDir!=='All',
    zoneFilter!=='All', liqFilter!=='All'
  ].filter(Boolean).length;

  const clearAll = () => {
    setRsiFilter('All'); setMfiFilter('All'); setVolFilter('All');
    setPatternType('All'); setSpecificPattern('');
    setNearRes(false); setNearSup(false); setBrokeRes(false); setBrokeSup(false);
    setNearTL(false); setBrokeTL(false);
    setSmcOB(false); setSmcFVG(false);
    setBosDir('All'); setChochDir('All');
    setZoneFilter('All'); setLiqFilter('All');
  };

  const cols = [
    {key:'symbol',    label:'Symbol',   width:130},
    {key:null,        label:'Chart',    width:55},
    {key:'assetType', label:'Type',     width:80},
    {key:'category',  label:'Category', width:90},
    {key:'bid',       label:'Bid',      width:100},
    {key:'ask',       label:'Ask',      width:100},
    {key:'spread',    label:'Spread',   width:80},
    {key:'change',    label:'Change %', width:90},
    {key:'high',      label:'High',     width:100},
    {key:'low',       label:'Low',      width:100},
    {key:'volume',    label:'Volume',   width:90},
    {key:null,        label:'RSI',      width:110},
    {key:null,        label:'MFI',      width:110},
    {key:null,        label:'Trend',    width:90},
    {key:null,        label:'SMC',      width:140},
    {key:null,        label:'Zone',     width:75},
    {key:null,        label:'Struct',   width:80},
    {key:null,        label:'Strength', width:90},
    {key:'signal',    label:'Signal',   width:110},
  ];

  return (
    <div className="screener-root">

      {/* Asset type tabs */}
      <div className="asset-type-row">
        {ASSET_TYPES.map(t => {
          const c=ASSET_COLORS[t]||{color:'#94a3b8',bg:'#1e293b55'};
          const active=assetType===t;
          return (
            <button key={t} className={`asset-type-btn ${active?'active':''}`}
              style={active?{borderColor:c.color,color:c.color,background:c.bg}:{}}
              onClick={()=>{setAssetType(t);setSubCategory('All');}}>
              <span className="asset-type-icon">{t==='All'?'◈':t==='Forex'?'₣':t==='Metals'?'⬡':t==='Indices'?'📊':t==='Energy'?'⚡':'₿'}</span>
              {t}<span className="asset-type-count">{counts[t]}</span>
            </button>
          );
        })}
      </div>

      {/* Live status */}
      <div className="live-status-bar">
        <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
          {loading?<span style={{color:'#475569',fontSize:12}}>⟳ Connecting…</span>
          :error?<span style={{color:'#f97316',fontSize:12}}>⚠ {error}</span>
          :<><span style={{width:7,height:7,borderRadius:'50%',background:'#22c55e',display:'inline-block',animation:'pulse 1.4s infinite'}}/><span style={{color:'#22c55e',fontSize:12,fontWeight:600}}>{oandaStatus.connected?'OANDA':'LIVE'} — {liveCount} instruments</span><span style={{color:'#475569',fontSize:11}}>· {lastUpdate?lastUpdate.toLocaleTimeString():'—'}</span></>}
          <OandaConnect status={oandaStatus} onConnect={connectOanda} onDisconnect={disconnectOanda}/>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {/* Timeframe selector */}
          <span style={{color:'#475569',fontSize:11,whiteSpace:'nowrap'}}>Analysis TF:</span>
          <div className="tf-scroll-box">
            <div className="tf-scroll-row">
              {SCREENER_TFS.map(tf=>(
                <button key={tf} className={`tf-pill ${tfFilter===tf?'active':''}`} onClick={()=>setTfFilter(tf)}>{tf}</button>
              ))}
            </div>
          </div>
          <button onClick={refresh} style={{color:'#00d4aa',fontSize:11,fontWeight:600,padding:'2px 8px',border:'1px solid #00d4aa44',borderRadius:4}}>↻</button>
        </div>
      </div>

      {/* Summary */}
      <div className="summary-row">
        <SummaryCard label="Showing" value={total}   color="#00d4aa"/>
        <SummaryCard label="Bullish" value={bullish}  color="#22c55e"/>
        <SummaryCard label="Bearish" value={bearish}  color="#ef4444"/>
        <SummaryCard label="Neutral" value={neutral}  color="#94a3b8"/>
      </div>

      {/* Filter bar */}
      <div className="filter-bar">
        <button className={`tab-btn ${showFilters?'active':''}`}
          onClick={()=>setShowFilters(f=>!f)}
          style={{display:'flex',alignItems:'center',gap:6}}>
          ⧉ Filters {activeFilterCount>0&&<span className="sf-count-badge">{activeFilterCount}</span>}
        </button>
        {subCategories.length>0&&(
          <div className="tab-group">
            {subCategories.map(c=>(
              <button key={c} className={`tab-btn ${subCategory===c?'active':''}`} onClick={()=>setSubCategory(c)}>{c}</button>
            ))}
          </div>
        )}
        <div className="tab-group">
          {['All','STRONG_BUY','BUY','NEUTRAL','SELL','STRONG_SELL'].map(s=>(
            <button key={s} className={`tab-btn signal-tab ${signalFilter===s?'active':''}`}
              style={signalFilter===s&&s!=='All'?{color:SIGNALS[s]?.color,borderColor:SIGNALS[s]?.color,background:SIGNALS[s]?.bg}:{}}
              onClick={()=>setSignalFilter(s)}>
              {s==='All'?'All Signals':SIGNALS[s]?.label}
            </button>
          ))}
        </div>
        <div className="search-wrap">
          <span className="search-icon">⌕</span>
          <input className="search-input" placeholder="Search symbol…" value={search} onChange={e=>setSearch(e.target.value)}/>
          {search&&<button className="search-clear" onClick={()=>setSearch('')}>×</button>}
        </div>
      </div>

      {/* ── Smart Filter Panel ─────────────────────────────────────────────── */}
      {showFilters&&(
        <div className="sf-panel">
          <div className="sf-panel-head">
            <span style={{fontWeight:700,fontSize:13,color:'var(--text)'}}>⧉ Smart Filters <span style={{fontSize:10,color:'#475569',fontWeight:400}}>· Timeframe: {tfFilter}</span></span>
            {activeFilterCount>0&&<button className="sf-clear-btn" onClick={clearAll}>✕ Clear all ({activeFilterCount})</button>}
          </div>

          <div className="sf-sections">

            {/* Candlestick Patterns */}
            <FilterSection title="Candlestick Patterns" icon="🕯️" defaultOpen={true}>
              <div className="sf-row-label">Pattern Direction</div>
              <div className="sf-chip-row">
                {[['All','All'],['Bull','🟢 Bull'],['Bear','🔴 Bear'],['Neut','⚪ Neut']].map(([val,lbl])=>(
                  <button key={val} className={`sf-chip ${patternType===val?'active':''}`}
                    style={patternType===val&&val!=='All'?{background:val==='Bull'?'#22c55e22':val==='Bear'?'#ef444422':'#94a3b822',borderColor:val==='Bull'?'#22c55e':val==='Bear'?'#ef4444':'#94a3b8',color:val==='Bull'?'#22c55e':val==='Bear'?'#ef4444':'#94a3b8'}:{}}
                    onClick={()=>setPatternType(val)}>{lbl}</button>
                ))}
              </div>
              <div className="sf-row-label" style={{marginTop:8}}>Specific Pattern</div>
              <select className="sf-select" value={specificPattern} onChange={e=>setSpecificPattern(e.target.value)}>
                {ALL_PATTERNS.map(p=>(
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <div className="sf-row-label" style={{marginTop:10}}>Scan Interval (last N candles)</div>
              <div className="sf-chip-row">
                {[3,5,8,10,15,20].map(n=>(
                  <button key={n} className={`sf-chip ${patternLookback===n?'active':''}`}
                    onClick={()=>setPatternLookback(n)}>{n}</button>
                ))}
              </div>
            </FilterSection>

            {/* Support & Resistance */}
            <FilterSection title="Support & Resistance" icon="📊" defaultOpen={true}>
              <Toggle on={nearRes}  onChange={setNearRes}  label="Near Resistance" desc="Price within ~0.4% below a resistance level"/>
              <Toggle on={nearSup}  onChange={setNearSup}  label="Near Support"    desc="Price within ~0.4% above a support level"/>
              <Toggle on={brokeRes} onChange={setBrokeRes} label="Broke Resistance" desc="Last BOS broke above a resistance level"/>
              <Toggle on={brokeSup} onChange={setBrokeSup} label="Broke Support"   desc="Last BOS broke below a support level"/>
            </FilterSection>

            {/* Trendlines */}
            <FilterSection title="Trendlines" icon="📈">
              <Toggle on={nearTL}  onChange={setNearTL}  label="Near Trendline"  desc="Price within 0.4% of a trendline"/>
              <Toggle on={brokeTL} onChange={setBrokeTL} label="Broke Trendline" desc="Recent candle closed through trendline"/>
            </FilterSection>

            {/* Smart Money */}
            <FilterSection title="Smart Money (SMC)" icon="💰">
              <Toggle on={smcOB}  onChange={setSmcOB}  label="Order Block"    desc="Active bullish or bearish order block present"/>
              <Toggle on={smcFVG} onChange={setSmcFVG} label="Fair Value Gap" desc="Unfilled price imbalance (FVG) present"/>
              <div className="sf-row-label" style={{marginTop:10}}>BOS (Break of Structure)</div>
              <div className="sf-chip-row">
                {['All','Bullish','Bearish'].map(v=>(
                  <button key={v} className={`sf-chip ${bosDir===v?'active':''}`}
                    style={bosDir===v&&v!=='All'?{color:v==='Bullish'?'#22c55e':'#ef4444',borderColor:v==='Bullish'?'#22c55e':'#ef4444',background:v==='Bullish'?'#22c55e18':'#ef444418'}:{}}
                    onClick={()=>setBosDir(v)}>{v==='All'?'Any BOS':v+' BOS'}</button>
                ))}
              </div>
              <div className="sf-row-label" style={{marginTop:8}}>CHoCH (Change of Character)</div>
              <div className="sf-chip-row">
                {['All','Bullish','Bearish'].map(v=>(
                  <button key={v} className={`sf-chip ${chochDir===v?'active':''}`}
                    style={chochDir===v&&v!=='All'?{color:v==='Bullish'?'#22c55e':'#ef4444',borderColor:v==='Bullish'?'#22c55e':'#ef4444',background:v==='Bullish'?'#22c55e18':'#ef444418'}:{}}
                    onClick={()=>setChochDir(v)}>{v==='All'?'Any CHoCH':v+' CHoCH'}</button>
                ))}
              </div>
              <div className="sf-row-label" style={{marginTop:8}}>Zone</div>
              <div className="sf-chip-row">
                {[['All','All'],['Premium','▲ Premium'],['Discount','▼ Discount']].map(([val,lbl])=>(
                  <button key={val} className={`sf-chip ${zoneFilter===val?'active':''}`}
                    style={zoneFilter===val&&val!=='All'?{color:val==='Premium'?'#ef4444':'#22c55e',borderColor:val==='Premium'?'#ef4444':'#22c55e',background:val==='Premium'?'#ef444418':'#22c55e18'}:{}}
                    onClick={()=>setZoneFilter(val)}>{lbl}</button>
                ))}
              </div>
              <div className="sf-row-label" style={{marginTop:8}}>Liquidity Hunt</div>
              <div className="sf-chip-row">
                {[['All','All'],['Buy Side','🟢 Buy-Side Liq'],['Sell Side','🔴 Sell-Side Liq']].map(([val,lbl])=>(
                  <button key={val} className={`sf-chip ${liqFilter===val?'active':''}`}
                    style={liqFilter===val&&val!=='All'?{color:val==='Buy Side'?'#22c55e':'#ef4444',borderColor:val==='Buy Side'?'#22c55e':'#ef4444',background:val==='Buy Side'?'#22c55e18':'#ef444418'}:{}}
                    onClick={()=>setLiqFilter(val)}>{lbl}</button>
                ))}
              </div>
            </FilterSection>

            {/* RSI */}
            <FilterSection title="RSI" icon="📉">
              <RangeInput label="Length" value={rsiLength} onChange={setRsiLength} min={2} max={50}/>
              <RangeInput label={`Overbought ≥ ${rsiOB}`} value={rsiOB} onChange={setRsiOB} min={30} max={99}/>
              <RangeInput label={`Oversold ≤ ${rsiOS}`} value={rsiOS} onChange={setRsiOS} min={1} max={70}/>
              <div className="sf-chip-row" style={{marginTop:8}}>
                {['All','Overbought','Neutral','Oversold'].map(f=>(
                  <button key={f} className={`sf-chip ${rsiFilter===f?'active':''}`}
                    style={rsiFilter===f&&f!=='All'?{color:f==='Overbought'?'#ef4444':f==='Oversold'?'#22c55e':'#94a3b8',borderColor:f==='Overbought'?'#ef4444':f==='Oversold'?'#22c55e':'#94a3b8'}:{}}
                    onClick={()=>setRsiFilter(f)}>{f==='Overbought'?`OB ≥${rsiOB}`:f==='Oversold'?`OS ≤${rsiOS}`:f==='Neutral'?`${rsiOS}–${rsiOB}`:f}</button>
                ))}
              </div>
            </FilterSection>

            {/* MFI */}
            <FilterSection title="Money Flow Index (MFI)" icon="💧">
              <RangeInput label="Length" value={mfiLength} onChange={setMfiLength} min={2} max={50}/>
              <RangeInput label={`Overbought ≥ ${mfiOB}`} value={mfiOB} onChange={setMfiOB} min={30} max={99}/>
              <RangeInput label={`Oversold ≤ ${mfiOS}`} value={mfiOS} onChange={setMfiOS} min={1} max={70}/>
              <div className="sf-chip-row" style={{marginTop:8}}>
                {['All','Overbought','Neutral','Oversold'].map(f=>(
                  <button key={f} className={`sf-chip ${mfiFilter===f?'active':''}`}
                    style={mfiFilter===f&&f!=='All'?{color:f==='Overbought'?'#ef4444':f==='Oversold'?'#22c55e':'#60a5fa',borderColor:f==='Overbought'?'#ef4444':f==='Oversold'?'#22c55e':'#60a5fa'}:{}}
                    onClick={()=>setMfiFilter(f)}>{f==='Overbought'?`OB ≥${mfiOB}`:f==='Oversold'?`OS ≤${mfiOS}`:f==='Neutral'?`${mfiOS}–${mfiOB}`:f}</button>
                ))}
              </div>
            </FilterSection>

            {/* Volume */}
            <FilterSection title="Volume" icon="📦">
              <div className="sf-chip-row">
                {['All','High Vol','Medium Vol','Low Vol'].map(f=>(
                  <button key={f} className={`sf-chip ${volFilter===f?'active':''}`} onClick={()=>setVolFilter(f)}>{f}</button>
                ))}
              </div>
            </FilterSection>

          </div>
        </div>
      )}

      {chartInstrument&&<ChartModal instrument={chartInstrument} onClose={()=>setChartInstrument(null)}/>}

      {/* Table */}
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
              <tr><td colSpan={cols.length} style={{textAlign:'center',padding:'40px 0',color:'#475569'}}>No instruments match your filters</td></tr>
            ):filtered.map(p=>{
              const ai=analysis[p.id]||{};
              return (
                <tr key={p.id} className="pair-row">
                  <td>
                    <div style={{display:'flex',flexDirection:'column',gap:3}}>
                      <div style={{display:'flex',alignItems:'center',gap:6}}>
                        <span className="pair-symbol">{p.symbol}</span>
                        <LiveBadge isLive={p.isLive}/>
                      </div>
                      {p.unit&&<span className="pair-category">{p.unit}</span>}
                    </div>
                  </td>
                  <td style={{display:'flex',gap:4,alignItems:'center'}}>
                    <button className="chart-open-btn" title="Open chart" onClick={()=>setChartInstrument(p)}>📈</button>
                    <button className={`wl-star-btn${watchlist.includes(p.symbol)?' active':''}`} title={watchlist.includes(p.symbol)?'Remove from watchlist':'Add to watchlist'} onClick={()=>toggleWatch(p.symbol)}>
                      {watchlist.includes(p.symbol)?'★':'☆'}
                    </button>
                  </td>
                  <td><AssetBadge type={p.assetType}/></td>
                  <td><span className="pair-category" style={{fontSize:12}}>{p.category}</span></td>
                  <td className="mono">{fmtPrice(p.bid)}</td>
                  <td className="mono">{fmtPrice(p.ask)}</td>
                  <td className="mono spread-cell">{fmtPrice(p.spread)}</td>
                  <td><span className={p.change>=0?'up':'down'}>{p.change>=0?'+':''}{p.change.toFixed(2)}%</span></td>
                  <td className="mono muted">{fmtPrice(p.high)}</td>
                  <td className="mono muted">{fmtPrice(p.low)}</td>
                  <td className="mono muted">{p.volume.toLocaleString()}</td>
                  <td><RsiBar value={ai.rsi||p.rsi} ob={rsiOB} os={rsiOS}/></td>
                  <td><RsiBar value={ai.mfi||50} ob={mfiOB} os={mfiOS}/></td>
                  <td><Sparkline data={p.sparkline} change={p.change}/></td>
                  <td><SmcTagRow bosBullish={ai.bosBullish} bosBearish={ai.bosBearish} chochBullish={ai.chochBullish} chochBearish={ai.chochBearish} hasFvg={ai.hasFVG} hasOb={ai.hasOB}/></td>
                  <td><ZoneBadge zone={ai.zone}/></td>
                  <td><StructBadge structure={ai.structure}/></td>
                  <td><StrengthBar value={ai.strength||50} dir={ai.strengthDir||'neutral'}/></td>
                  <td><SignalBadge signal={p.signal}/></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        Showing <strong>{filtered.length}</strong> of <strong>{allInstruments.length}</strong> instruments
        &nbsp;·&nbsp;<span style={{color:'#475569'}}>TF: {tfFilter} · Updated: {new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

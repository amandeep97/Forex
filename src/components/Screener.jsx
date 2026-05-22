import { useState, useMemo } from 'react';
import { allInstruments, ASSET_TYPES, FOREX_CATEGORIES, SIGNALS, ASSET_COLORS, DEFAULT_FILTERS } from '../data/forexData';
import { useLivePrices } from '../hooks/useLivePrices';
import { generateCandles } from '../utils/generateCandles';
import { detectCandlePatterns } from '../utils/candlePatterns';
import { analyzeSMC } from '../utils/smcAnalysis';
import { computeRSI, computeMFI } from '../utils/indicatorCalc';
import { computeVWAP } from '../utils/smcHelpers';
import ChartModal from './ChartModal';
import OandaConnect from './OandaConnect';
import FilterPanel from './FilterPanel';

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

function SmcTagRow({ bosBullish, bosBearish, chochBullish, chochBearish, hasFvg, hasOb }) {
  const tags = [];
  if (bosBullish)   tags.push(<span key="bosb"  style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#22c55e',background:'#22c55e18',border:'1px solid #22c55e44'}}>BOS↑</span>);
  if (bosBearish)   tags.push(<span key="bosr"  style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#ef4444',background:'#ef444418',border:'1px solid #ef444444'}}>BOS↓</span>);
  if (chochBullish) tags.push(<span key="chb"   style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#eab308',background:'#eab30818',border:'1px solid #eab30844'}}>ChoCh↑</span>);
  if (chochBearish) tags.push(<span key="chr"   style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#f97316',background:'#f9731618',border:'1px solid #f9731644'}}>ChoCh↓</span>);
  if (hasFvg) tags.push(<span key="fvg" style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#00d4aa',background:'#00d4aa12',border:'1px solid #00d4aa44'}}>FVG</span>);
  if (hasOb)  tags.push(<span key="ob"  style={{padding:'1px 4px',borderRadius:3,fontSize:9,fontWeight:700,color:'#a78bfa',background:'#a78bfa12',border:'1px solid #a78bfa44'}}>OB</span>);
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

function LiveBadge({ isLive }) {
  return isLive
    ? <span style={{display:'inline-flex',alignItems:'center',gap:4,padding:'1px 6px',borderRadius:10,fontSize:9,fontWeight:700,color:'#22c55e',background:'#22c55e18',border:'1px solid #22c55e44'}}><span style={{width:5,height:5,borderRadius:'50%',background:'#22c55e',display:'inline-block',animation:'pulse 1.4s infinite'}}/> LIVE</span>
    : <span style={{padding:'1px 6px',borderRadius:10,fontSize:9,fontWeight:700,color:'#475569',background:'#1e293b',border:'1px solid #334155'}}>DEMO</span>;
}

// ── Main Screener ─────────────────────────────────────────────────────────────
export default function Screener() {
  const { forexRates, cryptoRates, metalRates, marketRates, lastUpdate, loading, error, refresh,
          oandaStatus, connectOanda, disconnectOanda } = useLivePrices();

  const [filters, setFilters]         = useState({ ...DEFAULT_FILTERS });
  const [sortKey, setSortKey]         = useState('symbol');
  const [sortDir, setSortDir]         = useState('asc');
  const [signalFilter, setSignalFilter] = useState('All');
  const [subCategory, setSubCategory] = useState('All');
  const [chartInstrument, setChartInstrument] = useState(null);

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
        const candles   = generateCandles(inst, tfFilter, 60);
        const rsiVal    = computeRSI(candles, 14);
        const mfiVal    = computeMFI(candles, 14);
        const smc       = analyzeSMC(candles);
        const patterns  = detectCandlePatterns(candles, lookback);
        const cp        = candles[candles.length - 1].c;

        const bosBullish   = smc.bosChoch.some(b=>b.type==='BOS'&&b.direction==='bullish');
        const bosBearish   = smc.bosChoch.some(b=>b.type==='BOS'&&b.direction==='bearish');
        const chochBullish = smc.bosChoch.some(b=>b.type==='CHoCH'&&b.direction==='bullish');
        const chochBearish = smc.bosChoch.some(b=>b.type==='CHoCH'&&b.direction==='bearish');
        const hasOB  = smc.orderBlocks.length>0;
        const hasFVG = smc.fvgs.length>0;
        const zone   = smc.premiumDiscount?.zone || 'discount';

        const vwapSeries = computeVWAP(candles);
        const lastVwap   = vwapSeries[vwapSeries.length-1];
        const vwapAbove  = cp >= (lastVwap || cp);

        const structure = (bosBullish||chochBullish) ? 'bullish'
                        : (bosBearish||chochBearish) ? 'bearish' : 'neutral';

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
          hasOB, hasFVG, bosBullish, bosBearish, chochBullish, chochBearish,
          zone, structure, strength, strengthDir, vwapAbove,
          buySideLiq:  smc.liquidity.some(l=>l.type==='low'&&Math.abs(l.price-cp)/(cp||1)<0.006),
          sellSideLiq: smc.liquidity.some(l=>l.type==='high'&&Math.abs(l.price-cp)/(cp||1)<0.006),
          patternIds:  patterns.map(p=>p.id),
          patternType: patterns.length===0?'neut':
                       patterns.some(p=>p.type==='bullish')?'bull':
                       patterns.some(p=>p.type==='bearish')?'bear':'neut',
        };
      } catch {
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

    // Category
    if (f.category && f.category !== 'All') list = list.filter(i => i.assetType === f.category);
    if (subCategory !== 'All' && subCategories.length > 0) list = list.filter(i => i.category === subCategory);

    // Base currency
    if (f.baseCurrency && f.baseCurrency !== 'All')
      list = list.filter(i => i.symbol.split('/')[0] === f.baseCurrency);

    // Signal filter (top bar)
    if (signalFilter !== 'All') list = list.filter(i => i.signal === signalFilter);

    // Search
    if (f.search?.trim()) {
      const q = f.search.trim().toUpperCase();
      list = list.filter(i => i.symbol.toUpperCase().includes(q));
    }

    // RSI range
    if (f.rsiMin != null && f.rsiMin !== '') list = list.filter(i => (a[i.id]?.rsi||50) >= Number(f.rsiMin));
    if (f.rsiMax != null && f.rsiMax !== '') list = list.filter(i => (a[i.id]?.rsi||50) <= Number(f.rsiMax));

    // MFI range
    if (f.mfiMin != null && f.mfiMin !== '') list = list.filter(i => (a[i.id]?.mfi||50) >= Number(f.mfiMin));
    if (f.mfiMax != null && f.mfiMax !== '') list = list.filter(i => (a[i.id]?.mfi||50) <= Number(f.mfiMax));

    // % Change
    if (f.changeMin != null && f.changeMin !== '') list = list.filter(i => i.change >= Number(f.changeMin));
    if (f.changeMax != null && f.changeMax !== '') list = list.filter(i => i.change <= Number(f.changeMax));

    // Candle patterns
    if (f.candleType && f.candleType !== 'All') {
      const map = { bullish:'bull', bearish:'bear', neutral:'neut' };
      list = list.filter(i => a[i.id]?.patternType === (map[f.candleType]||f.candleType));
    }
    if (f.candlePattern && f.candlePattern !== 'All')
      list = list.filter(i => a[i.id]?.patternIds?.includes(f.candlePattern));

    // S&R
    if (f.requireNearResistance)  list = list.filter(i => a[i.id]?.nearResistance);
    if (f.requireNearSupport)     list = list.filter(i => a[i.id]?.nearSupport);
    if (f.requireBrokeResistance) list = list.filter(i => a[i.id]?.brokeResistance);
    if (f.requireBrokeSupport)    list = list.filter(i => a[i.id]?.brokeSupport);

    // Trendlines
    if (f.requireTrendlineBull || f.requireTrendlineBear) list = list.filter(i => a[i.id]?.nearTrendline);
    if (f.requireTrendlineBreak) list = list.filter(i => a[i.id]?.brokeTrendline);

    // SMC — OB
    if (f.requireOb) list = list.filter(i => a[i.id]?.hasOB);
    if (f.obDir === 'bullish') list = list.filter(i => a[i.id]?.hasOB && a[i.id]?.structure === 'bullish');
    if (f.obDir === 'bearish') list = list.filter(i => a[i.id]?.hasOB && a[i.id]?.structure === 'bearish');

    // SMC — FVG
    if (f.requireFvg) list = list.filter(i => a[i.id]?.hasFVG);
    if (f.fvgDir === 'bullish') list = list.filter(i => a[i.id]?.hasFVG && a[i.id]?.structure === 'bullish');
    if (f.fvgDir === 'bearish') list = list.filter(i => a[i.id]?.hasFVG && a[i.id]?.structure === 'bearish');

    // FVG + OB mode
    if (f.requireFvg && f.requireOb && f.fvgObMode === 'OR')
      list = list.filter(i => a[i.id]?.hasFVG || a[i.id]?.hasOB);

    // SMC — BOS / CHoCH
    if (f.requireBos)   list = list.filter(i => a[i.id]?.bosBullish || a[i.id]?.bosBearish);
    if (f.requireChoch) list = list.filter(i => a[i.id]?.chochBullish || a[i.id]?.chochBearish);
    if (f.structure !== 'All') list = list.filter(i => a[i.id]?.structure === f.structure);

    // Zone
    if (f.zone !== 'All') list = list.filter(i => a[i.id]?.zone === f.zone);

    // Liquidity
    if (f.liqType === 'bsl') list = list.filter(i => a[i.id]?.buySideLiq);
    if (f.liqType === 'ssl') list = list.filter(i => a[i.id]?.sellSideLiq);

    // VWAP
    if (f.vwapBias === 'above') list = list.filter(i =>  a[i.id]?.vwapAbove);
    if (f.vwapBias === 'below') list = list.filter(i => !a[i.id]?.vwapAbove);

    // Sort
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

      {/* Live status */}
      <div className="live-status-bar">
        <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
          {loading?<span style={{color:'#475569',fontSize:12}}>⟳ Connecting…</span>
          :error?<span style={{color:'#f97316',fontSize:12}}>⚠ {error}</span>
          :<><span style={{width:7,height:7,borderRadius:'50%',background:'#22c55e',display:'inline-block',animation:'pulse 1.4s infinite'}}/><span style={{color:'#22c55e',fontSize:12,fontWeight:600}}>{oandaStatus.connected?'OANDA':'LIVE'} — {liveCount} instruments</span><span style={{color:'#475569',fontSize:11}}>· {lastUpdate?lastUpdate.toLocaleTimeString():'—'}</span></>}
          <OandaConnect status={oandaStatus} onConnect={connectOanda} onDisconnect={disconnectOanda}/>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <span style={{color:'#475569',fontSize:11}}>TF: <strong style={{color:'#00d4aa'}}>{tfFilter.toUpperCase()}</strong></span>
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

      {/* Signal filter + subcategory tabs */}
      <div className="filter-bar">
        {subCategories.length > 0 && (
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
      </div>

      {/* Main: sidebar + table */}
      {chartInstrument && <ChartModal instrument={chartInstrument} onClose={()=>setChartInstrument(null)}/>}

      <div style={{display:'flex',gap:16,alignItems:'flex-start',marginTop:8}}>

        {/* FilterPanel sidebar */}
        <FilterPanel
          filters={filters}
          onChange={setFilters}
          onReset={() => setFilters({ ...DEFAULT_FILTERS })}
          resultCount={filtered.length}
          totalCount={allInstruments.length}
          allPairs={allInstruments}
        />

        {/* Table area */}
        <div style={{flex:1,minWidth:0}}>
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
                      <td><RsiBar value={ai.rsi||p.rsi} ob={70} os={30}/></td>
                      <td><RsiBar value={ai.mfi||50} ob={80} os={20}/></td>
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
            &nbsp;·&nbsp;<span style={{color:'#475569'}}>TF: {tfFilter.toUpperCase()} · Updated: {new Date().toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

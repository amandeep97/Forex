import { useState, useMemo } from 'react';
import { allInstruments, ASSET_TYPES, FOREX_CATEGORIES, SIGNALS, ASSET_COLORS, DEFAULT_FILTERS } from '../data/forexData';
import { useLivePrices } from '../hooks/useLivePrices';
import { generateCandles } from '../utils/generateCandles';
import { detectCandlePatterns } from '../utils/candlePatterns';
import { analyzeSMC } from '../utils/smcAnalysis';
import { computeRSI, computeMFI, computeEMA, computeMACD, detectRSIDivergence, detectEqualHighsLows } from '../utils/indicatorCalc';
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
        const smc       = analyzeSMC(candles);
        const patterns  = detectCandlePatterns(candles.slice(-60), lookback);
        const cp        = candles[candles.length - 1].c;

        const bosBullish   = smc.bosChoch.some(b=>b.type==='BOS'&&b.direction==='bullish');
        const bosBearish   = smc.bosChoch.some(b=>b.type==='BOS'&&b.direction==='bearish');
        const chochBullish = smc.bosChoch.some(b=>b.type==='CHoCH'&&b.direction==='bullish');
        const chochBearish = smc.bosChoch.some(b=>b.type==='CHoCH'&&b.direction==='bearish');
        const hasOB  = smc.orderBlocks.length>0;
        const hasFVG = smc.fvgs.length>0;
        const zone   = smc.premiumDiscount?.zone || 'discount';

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
          hasOB, hasFVG, bosBullish, bosBearish, chochBullish, chochBearish,
          zone, structure, strength, strengthDir, vwapAbove,
          buySideLiq:  smc.liquidity.some(l=>l.type==='low'&&Math.abs(l.price-cp)/(cp||1)<0.006),
          sellSideLiq: smc.liquidity.some(l=>l.type==='high'&&Math.abs(l.price-cp)/(cp||1)<0.006),
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
          brokeTrendline:false, hasOB:false, hasFVG:false, bosBullish:false,
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
    if (f.requireOb) list = list.filter(i => a[i.id]?.hasOB);
    if (f.obDir === 'bullish') list = list.filter(i => a[i.id]?.hasOB && a[i.id]?.structure === 'bullish');
    if (f.obDir === 'bearish') list = list.filter(i => a[i.id]?.hasOB && a[i.id]?.structure === 'bearish');
    if (f.requireFvg) list = list.filter(i => a[i.id]?.hasFVG);
    if (f.fvgDir === 'bullish') list = list.filter(i => a[i.id]?.hasFVG && a[i.id]?.structure === 'bullish');
    if (f.fvgDir === 'bearish') list = list.filter(i => a[i.id]?.hasFVG && a[i.id]?.structure === 'bearish');
    if (f.requireFvg && f.requireOb && f.fvgObMode === 'OR')
      list = list.filter(i => a[i.id]?.hasFVG || a[i.id]?.hasOB);
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
          <div className="screener-stats">
            <span className="stat-pill"><span style={{color:'#00d4aa',fontWeight:700}}>{total}</span> shown</span>
            <span className="stat-pill bull"><span style={{color:'#22c55e',fontWeight:700}}>{bullish}↑</span></span>
            <span className="stat-pill bear"><span style={{color:'#ef4444',fontWeight:700}}>{bearish}↓</span></span>
            <span className="stat-pill"><span style={{color:'#94a3b8',fontWeight:700}}>{neutral}→</span></span>
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

      {/* ── Chart modal ──────────────────────────────────────────────────── */}
      {chartInstrument && <ChartModal instrument={chartInstrument} onClose={()=>setChartInstrument(null)}/>}

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
                      <td>
                        <div style={{display:'flex',gap:4,alignItems:'center'}}>
                          <button className="chart-open-btn" title="Open chart" onClick={()=>setChartInstrument(p)}>📈</button>
                          <button className={`wl-star-btn${watchlist.includes(p.symbol)?' active':''}`} title={watchlist.includes(p.symbol)?'Remove':'Add to watchlist'} onClick={()=>toggleWatch(p.symbol)}>
                            {watchlist.includes(p.symbol)?'★':'☆'}
                          </button>
                        </div>
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
            &nbsp;·&nbsp;<span style={{color:'#475569'}}>TF: {tfFilter.toUpperCase()} · {new Date().toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

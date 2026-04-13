import { useState, useMemo } from 'react';
import { allInstruments, ASSET_TYPES, FOREX_CATEGORIES, SIGNALS, ASSET_COLORS } from '../data/forexData';
import { useLivePrices } from '../hooks/useLivePrices';
import CandleChart from './CandleChart';

function Sparkline({ data, change }) {
  const w = 80, h = 28;
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 0.0001;
  const pts = data.map((v, i) => `${((i/(data.length-1))*w).toFixed(1)},${(h-((v-min)/range)*h).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display:'block' }}>
      <polyline points={pts} fill="none" stroke={change>=0?'#22c55e':'#ef4444'} strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  );
}

function SignalBadge({ signal }) {
  const s = SIGNALS[signal]; if (!s) return null;
  return <span style={{ padding:'2px 8px', borderRadius:4, fontSize:11, fontWeight:600, color:s.color, background:s.bg, border:`1px solid ${s.color}44`, whiteSpace:'nowrap' }}>{s.label}</span>;
}

function AssetBadge({ type }) {
  const c = ASSET_COLORS[type] || { color:'#94a3b8', bg:'#1e293b55' };
  return <span style={{ padding:'1px 6px', borderRadius:3, fontSize:10, fontWeight:600, color:c.color, background:c.bg, border:`1px solid ${c.color}44`, whiteSpace:'nowrap' }}>{type}</span>;
}

function RsiBar({ value }) {
  const color = value>=70?'#ef4444':value<=30?'#22c55e':'#94a3b8';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <div style={{ width:48, height:4, background:'#1e293b', borderRadius:2, overflow:'hidden' }}>
        <div style={{ width:`${value}%`, height:'100%', background:color, borderRadius:2 }}/>
      </div>
      <span style={{ fontSize:11, color, fontFamily:'JetBrains Mono', minWidth:28 }}>{value}</span>
    </div>
  );
}

function SortIcon({ col, sortKey, dir }) {
  if (sortKey !== col) return <span style={{ color:'#334155', marginLeft:3 }}>⇅</span>;
  return <span style={{ color:'#00d4aa', marginLeft:3 }}>{dir==='asc'?'↑':'↓'}</span>;
}

function SummaryCard({ label, value, color }) {
  return (
    <div className="summary-card">
      <span className="summary-value" style={{ color }}>{value}</span>
      <span className="summary-label">{label}</span>
    </div>
  );
}

function fmtPrice(v) {
  if (v==null) return '—';
  if (v>=10000) return v.toFixed(0);
  if (v>=100)   return v.toFixed(2);
  if (v>=1)     return v.toFixed(3);
  return v.toFixed(5);
}

function LiveBadge({ isLive }) {
  return isLive
    ? <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'1px 6px', borderRadius:10, fontSize:9, fontWeight:700, color:'#22c55e', background:'#22c55e18', border:'1px solid #22c55e44' }}><span style={{ width:5, height:5, borderRadius:'50%', background:'#22c55e', display:'inline-block', animation:'pulse 1.4s infinite' }}/> LIVE</span>
    : <span style={{ padding:'1px 6px', borderRadius:10, fontSize:9, fontWeight:700, color:'#475569', background:'#1e293b', border:'1px solid #334155' }}>DEMO</span>;
}

// Toggle switch component
function Toggle({ on, onChange, label, desc }) {
  return (
    <div className="sf-toggle-row" onClick={() => onChange(!on)}>
      <div className="sf-toggle-info">
        <span className="sf-toggle-label">{label}</span>
        {desc && <span className="sf-toggle-desc">{desc}</span>}
      </div>
      <div className={`sf-toggle ${on?'on':''}`}>
        <div className="sf-toggle-knob"/>
      </div>
    </div>
  );
}

// Collapsible section
function FilterSection({ title, icon, children, defaultOpen=false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sf-section">
      <button className="sf-section-head" onClick={() => setOpen(o=>!o)}>
        <span>{icon} {title}</span>
        <span style={{ fontSize:10, color:'#475569' }}>{open?'▲':'▼'}</span>
      </button>
      {open && <div className="sf-section-body">{children}</div>}
    </div>
  );
}

// ── helpers for derived filters ───────────────────────────────────────────────
function getPatternType(inst) {
  if (['STRONG_BUY','BUY'].includes(inst.signal))    return 'bull';
  if (['STRONG_SELL','SELL'].includes(inst.signal))   return 'bear';
  return 'neut';
}
function isNearResistance(inst)  { return inst.rsi > 65; }
function isNearSupport(inst)     { return inst.rsi < 35; }
function isBrokeResistance(inst) { return inst.signal==='STRONG_BUY' && inst.change > 0.5; }
function isBrokeSupport(inst)    { return inst.signal==='STRONG_SELL' && inst.change < -0.5; }
function isNearTrendline(inst)   { return Math.abs(inst.change) < 0.3 && inst.rsi > 42 && inst.rsi < 58; }
function isBrokeTrendline(inst)  { return Math.abs(inst.change) > 0.7; }
function hasOrderBlock(inst)     { return inst.rsi > 62 || inst.rsi < 38; }
function hasFVG(inst)            { return Math.abs(inst.change) > 0.25; }
function hasBOS(inst)            { return inst.signal==='STRONG_BUY' || inst.signal==='STRONG_SELL'; }

// ── Main Screener ─────────────────────────────────────────────────────────────
export default function Screener() {
  const { forexRates, cryptoRates, lastUpdate, loading, error, refresh } = useLivePrices();

  // Basic
  const [assetType, setAssetType]       = useState('All');
  const [subCategory, setSubCategory]   = useState('All');
  const [search, setSearch]             = useState('');
  const [sortKey, setSortKey]           = useState('symbol');
  const [sortDir, setSortDir]           = useState('asc');
  const [signalFilter, setSignalFilter] = useState('All');
  const [showFilters, setShowFilters]   = useState(false);

  // Technicals
  const [rsiFilter, setRsiFilter]       = useState('All');
  const [changeFilter, setChangeFilter] = useState('All');
  const [volFilter, setVolFilter]       = useState('All');

  // Candlestick patterns
  const [patternType, setPatternType]       = useState('All');
  const [patternRecency, setPatternRecency] = useState(0); // 0=any

  // S&R toggles
  const [nearRes, setNearRes]   = useState(false);
  const [nearSup, setNearSup]   = useState(false);
  const [brokeRes, setBrokeRes] = useState(false);
  const [brokeSup, setBrokeSup] = useState(false);

  // Trendline toggles
  const [nearTL, setNearTL]   = useState(false);
  const [brokeTL, setBrokeTL] = useState(false);

  // SMC toggles
  const [smcOB,  setSmcOB]  = useState(false);
  const [smcFVG, setSmcFVG] = useState(false);
  const [smcBOS, setSmcBOS] = useState(false);

  // Chart
  const [chartInstrument, setChartInstrument] = useState(null);

  const handleSort = (key) => {
    if (sortKey===key) setSortDir(d=>d==='asc'?'desc':'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const subCategories = useMemo(() => {
    if (assetType==='All'||assetType==='Crypto') return [];
    if (assetType==='Forex') return FOREX_CATEGORIES;
    const cats = [...new Set(allInstruments.filter(i=>i.assetType===assetType).map(i=>i.category))];
    return ['All',...cats];
  }, [assetType]);

  const instrumentsWithLive = useMemo(() => allInstruments.map(inst => {
    let lp = null;
    if (inst.assetType==='Forex')  lp = forexRates[inst.symbol];
    if (inst.assetType==='Crypto') lp = cryptoRates[inst.symbol];
    if (lp) {
      const bid = parseFloat(lp.toFixed(inst.bid>10?3:5));
      const ask = parseFloat((bid+inst.spread).toFixed(inst.bid>10?3:5));
      return { ...inst, bid, ask, isLive:true };
    }
    return { ...inst, isLive:false };
  }), [forexRates, cryptoRates]);

  const filtered = useMemo(() => {
    let list = instrumentsWithLive;
    if (assetType!=='All') list = list.filter(i=>i.assetType===assetType);
    if (subCategory!=='All'&&subCategories.length>0) list = list.filter(i=>i.category===subCategory);
    if (signalFilter!=='All') list = list.filter(i=>i.signal===signalFilter);

    // Technicals
    if (rsiFilter==='Overbought >70') list = list.filter(i=>i.rsi>70);
    if (rsiFilter==='Neutral 30–70')  list = list.filter(i=>i.rsi>=30&&i.rsi<=70);
    if (rsiFilter==='Oversold <30')   list = list.filter(i=>i.rsi<30);
    if (changeFilter==='Strong Up >1%')    list = list.filter(i=>i.change>1);
    if (changeFilter==='Up 0–1%')          list = list.filter(i=>i.change>0&&i.change<=1);
    if (changeFilter==='Down 0–1%')        list = list.filter(i=>i.change<0&&i.change>=-1);
    if (changeFilter==='Strong Down <-1%') list = list.filter(i=>i.change<-1);
    const vols = instrumentsWithLive.map(i=>i.volume).sort((a,b)=>a-b);
    const v33=vols[Math.floor(vols.length/3)], v66=vols[Math.floor(vols.length*2/3)];
    if (volFilter==='High Vol')   list = list.filter(i=>i.volume>v66);
    if (volFilter==='Medium Vol') list = list.filter(i=>i.volume>=v33&&i.volume<=v66);
    if (volFilter==='Low Vol')    list = list.filter(i=>i.volume<v33);

    // Candlestick pattern
    if (patternType==='Bull') list = list.filter(i=>getPatternType(i)==='bull');
    if (patternType==='Bear') list = list.filter(i=>getPatternType(i)==='bear');
    if (patternType==='Neut') list = list.filter(i=>getPatternType(i)==='neut');

    // S&R
    if (nearRes)   list = list.filter(i=>isNearResistance(i));
    if (nearSup)   list = list.filter(i=>isNearSupport(i));
    if (brokeRes)  list = list.filter(i=>isBrokeResistance(i));
    if (brokeSup)  list = list.filter(i=>isBrokeSupport(i));

    // Trendlines
    if (nearTL)  list = list.filter(i=>isNearTrendline(i));
    if (brokeTL) list = list.filter(i=>isBrokeTrendline(i));

    // SMC
    if (smcOB)  list = list.filter(i=>hasOrderBlock(i));
    if (smcFVG) list = list.filter(i=>hasFVG(i));
    if (smcBOS) list = list.filter(i=>hasBOS(i));

    if (search.trim()) {
      const q = search.trim().toUpperCase();
      list = list.filter(i=>i.symbol.toUpperCase().includes(q));
    }
    return [...list].sort((a,b) => {
      let av=a[sortKey], bv=b[sortKey];
      if (typeof av==='string') { av=av.toLowerCase(); bv=bv.toLowerCase(); }
      if (av<bv) return sortDir==='asc'?-1:1;
      if (av>bv) return sortDir==='asc'?1:-1;
      return 0;
    });
  }, [instrumentsWithLive, assetType, subCategory, search, sortKey, sortDir, signalFilter, subCategories,
      rsiFilter, changeFilter, volFilter, patternType, nearRes, nearSup, brokeRes, brokeSup,
      nearTL, brokeTL, smcOB, smcFVG, smcBOS]);

  const total=filtered.length;
  const bullish=filtered.filter(p=>['STRONG_BUY','BUY'].includes(p.signal)).length;
  const bearish=filtered.filter(p=>['STRONG_SELL','SELL'].includes(p.signal)).length;
  const neutral=filtered.filter(p=>p.signal==='NEUTRAL').length;

  const counts = useMemo(() => {
    const c={};
    ASSET_TYPES.forEach(t=>{ c[t]=t==='All'?allInstruments.length:allInstruments.filter(i=>i.assetType===t).length; });
    return c;
  }, []);

  const liveCount = filtered.filter(i=>i.isLive).length;

  const activeFilterCount = [rsiFilter!=='All', changeFilter!=='All', volFilter!=='All',
    patternType!=='All', nearRes, nearSup, brokeRes, brokeSup, nearTL, brokeTL, smcOB, smcFVG, smcBOS].filter(Boolean).length;

  const clearAll = () => {
    setRsiFilter('All'); setChangeFilter('All'); setVolFilter('All');
    setPatternType('All'); setNearRes(false); setNearSup(false);
    setBrokeRes(false); setBrokeSup(false); setNearTL(false);
    setBrokeTL(false); setSmcOB(false); setSmcFVG(false); setSmcBOS(false);
  };

  const cols = [
    { key:'symbol',    label:'Symbol',   width:130 },
    { key:null,        label:'Chart',    width:55  },
    { key:'assetType', label:'Type',     width:80  },
    { key:'category',  label:'Category', width:90  },
    { key:'bid',       label:'Bid',      width:100 },
    { key:'ask',       label:'Ask',      width:100 },
    { key:'spread',    label:'Spread',   width:80  },
    { key:'change',    label:'Change %', width:90  },
    { key:'high',      label:'High',     width:100 },
    { key:'low',       label:'Low',      width:100 },
    { key:'volume',    label:'Volume',   width:90  },
    { key:'rsi',       label:'RSI',      width:110 },
    { key:null,        label:'Trend',    width:90  },
    { key:'signal',    label:'Signal',   width:110 },
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
              onClick={() => { setAssetType(t); setSubCategory('All'); }}>
              <span className="asset-type-icon">{t==='All'?'◈':t==='Forex'?'₣':t==='Metals'?'⬡':t==='Indices'?'📊':t==='Energy'?'⚡':'₿'}</span>
              {t}<span className="asset-type-count">{counts[t]}</span>
            </button>
          );
        })}
      </div>

      {/* Live status */}
      <div className="live-status-bar">
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {loading ? <span style={{ color:'#475569', fontSize:12 }}>⟳ Connecting…</span>
          : error   ? <span style={{ color:'#f97316', fontSize:12 }}>⚠ {error}</span>
          : <>
              <span style={{ width:7, height:7, borderRadius:'50%', background:'#22c55e', display:'inline-block', animation:'pulse 1.4s infinite' }}/>
              <span style={{ color:'#22c55e', fontSize:12, fontWeight:600 }}>LIVE — {liveCount} instruments</span>
              <span style={{ color:'#475569', fontSize:11 }}>· {lastUpdate?lastUpdate.toLocaleTimeString():'—'}</span>
            </>}
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <span style={{ color:'#475569', fontSize:11 }}>Metals · Indices · Energy = Demo</span>
          <button onClick={refresh} style={{ color:'#00d4aa', fontSize:11, fontWeight:600, padding:'2px 8px', border:'1px solid #00d4aa44', borderRadius:4 }}>↻ Refresh</button>
        </div>
      </div>

      {/* Summary */}
      <div className="summary-row">
        <SummaryCard label="Showing"  value={total}   color="#00d4aa"/>
        <SummaryCard label="Bullish"  value={bullish}  color="#22c55e"/>
        <SummaryCard label="Bearish"  value={bearish}  color="#ef4444"/>
        <SummaryCard label="Neutral"  value={neutral}  color="#94a3b8"/>
      </div>

      {/* Filter bar */}
      <div className="filter-bar">
        <button className={`tab-btn ${showFilters?'active':''}`}
          onClick={() => setShowFilters(f=>!f)}
          style={{ display:'flex', alignItems:'center', gap:6 }}>
          ⧉ Filters
          {activeFilterCount>0 && <span className="sf-count-badge">{activeFilterCount}</span>}
        </button>

        {subCategories.length>0 && (
          <div className="tab-group">
            {subCategories.map(c => (
              <button key={c} className={`tab-btn ${subCategory===c?'active':''}`} onClick={() => setSubCategory(c)}>{c}</button>
            ))}
          </div>
        )}

        <div className="tab-group">
          {['All','STRONG_BUY','BUY','NEUTRAL','SELL','STRONG_SELL'].map(s => (
            <button key={s} className={`tab-btn signal-tab ${signalFilter===s?'active':''}`}
              style={signalFilter===s&&s!=='All'?{color:SIGNALS[s]?.color,borderColor:SIGNALS[s]?.color,background:SIGNALS[s]?.bg}:{}}
              onClick={() => setSignalFilter(s)}>
              {s==='All'?'All Signals':SIGNALS[s]?.label}
            </button>
          ))}
        </div>

        <div className="search-wrap">
          <span className="search-icon">⌕</span>
          <input className="search-input" placeholder="Search symbol…" value={search} onChange={e=>setSearch(e.target.value)}/>
          {search && <button className="search-clear" onClick={() => setSearch('')}>×</button>}
        </div>
      </div>

      {/* ── Smart Filter Panel ──────────────────────────────────────────── */}
      {showFilters && (
        <div className="sf-panel">
          <div className="sf-panel-head">
            <span style={{ fontWeight:700, fontSize:13, color:'var(--text)' }}>⧉ Smart Filters</span>
            {activeFilterCount>0 && (
              <button className="sf-clear-btn" onClick={clearAll}>✕ Clear all ({activeFilterCount})</button>
            )}
          </div>

          <div className="sf-sections">

            {/* Candlestick Patterns */}
            <FilterSection title="Candlestick Patterns" icon="🕯️" defaultOpen={true}>
              <div className="sf-row-label">Pattern Type</div>
              <div className="sf-chip-row">
                {['All','Bull','Bear','Neut'].map(p => (
                  <button key={p}
                    className={`sf-chip ${patternType===p?'active':''}`}
                    style={patternType===p&&p!=='All' ? {
                      background: p==='Bull'?'#22c55e22':p==='Bear'?'#ef444422':'#94a3b822',
                      borderColor: p==='Bull'?'#22c55e':p==='Bear'?'#ef4444':'#94a3b8',
                      color: p==='Bull'?'#22c55e':p==='Bear'?'#ef4444':'#94a3b8',
                    } : {}}
                    onClick={() => setPatternType(p)}>
                    {p==='Bull'?'🟢 Bull':p==='Bear'?'🔴 Bear':p==='Neut'?'⚪ Neut':'All'}
                  </button>
                ))}
              </div>
            </FilterSection>

            {/* Support & Resistance */}
            <FilterSection title="Support & Resistance" icon="📊" defaultOpen={true}>
              <Toggle on={nearRes}  onChange={setNearRes}  label="Near Resistance" desc="RSI above 65 — approaching resistance"/>
              <Toggle on={nearSup}  onChange={setNearSup}  label="Near Support"    desc="RSI below 35 — approaching support"/>
              <Toggle on={brokeRes} onChange={setBrokeRes} label="Broke Resistance" desc="Strong bullish breakout above resistance"/>
              <Toggle on={brokeSup} onChange={setBrokeSup} label="Broke Support"   desc="Strong bearish breakdown below support"/>
            </FilterSection>

            {/* Trendlines */}
            <FilterSection title="Trendlines" icon="📈">
              <Toggle on={nearTL}  onChange={setNearTL}  label="Near Trendline"  desc="Price within 0.3% of a trendline"/>
              <Toggle on={brokeTL} onChange={setBrokeTL} label="Broke Trendline" desc="Recent candle broke a key trendline"/>
            </FilterSection>

            {/* Smart Money */}
            <FilterSection title="Smart Money (SMC)" icon="💰">
              <Toggle on={smcOB}  onChange={setSmcOB}  label="Order Block"     desc="Active bullish or bearish order block"/>
              <Toggle on={smcFVG} onChange={setSmcFVG} label="Fair Value Gap"  desc="Unfilled price imbalance (FVG)"/>
              <Toggle on={smcBOS} onChange={setSmcBOS} label="BOS / CHoCH"     desc="Break of structure detected"/>
            </FilterSection>

            {/* Technicals */}
            <FilterSection title="Technicals" icon="⚙️">
              <div className="sf-row-label">RSI</div>
              <div className="sf-chip-row">
                {['All','Overbought >70','Neutral 30–70','Oversold <30'].map(f => (
                  <button key={f} className={`sf-chip ${rsiFilter===f?'active':''}`} onClick={() => setRsiFilter(f)}>{f}</button>
                ))}
              </div>
              <div className="sf-row-label" style={{ marginTop:8 }}>Change %</div>
              <div className="sf-chip-row">
                {['All','Strong Up >1%','Up 0–1%','Down 0–1%','Strong Down <-1%'].map(f => (
                  <button key={f} className={`sf-chip ${changeFilter===f?'active':''}`} onClick={() => setChangeFilter(f)}>{f}</button>
                ))}
              </div>
              <div className="sf-row-label" style={{ marginTop:8 }}>Volume</div>
              <div className="sf-chip-row">
                {['All','High Vol','Medium Vol','Low Vol'].map(f => (
                  <button key={f} className={`sf-chip ${volFilter===f?'active':''}`} onClick={() => setVolFilter(f)}>{f}</button>
                ))}
              </div>
            </FilterSection>

          </div>
        </div>
      )}

      {/* Chart modal */}
      {chartInstrument && (
        <CandleChart instrument={chartInstrument} onClose={() => setChartInstrument(null)}/>
      )}

      {/* Table */}
      <div className="table-wrap">
        <table className="screener-table">
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c.label} style={{ minWidth:c.width, cursor:c.key?'pointer':'default' }}
                  onClick={() => c.key && handleSort(c.key)}>
                  {c.label}{c.key && <SortIcon col={c.key} sortKey={sortKey} dir={sortDir}/>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length===0 ? (
              <tr><td colSpan={cols.length} style={{ textAlign:'center', padding:'40px 0', color:'#475569' }}>No instruments match your filters</td></tr>
            ) : filtered.map(p => (
              <tr key={p.id} className="pair-row">
                <td>
                  <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <span className="pair-symbol">{p.symbol}</span>
                      <LiveBadge isLive={p.isLive}/>
                    </div>
                    {p.unit && <span className="pair-category">{p.unit}</span>}
                  </div>
                </td>
                <td>
                  <button className="chart-open-btn" title="Open chart" onClick={() => setChartInstrument(p)}>📈</button>
                </td>
                <td><AssetBadge type={p.assetType}/></td>
                <td><span className="pair-category" style={{ fontSize:12 }}>{p.category}</span></td>
                <td className="mono">{fmtPrice(p.bid)}</td>
                <td className="mono">{fmtPrice(p.ask)}</td>
                <td className="mono spread-cell">{fmtPrice(p.spread)}</td>
                <td><span className={p.change>=0?'up':'down'}>{p.change>=0?'+':''}{p.change.toFixed(2)}%</span></td>
                <td className="mono muted">{fmtPrice(p.high)}</td>
                <td className="mono muted">{fmtPrice(p.low)}</td>
                <td className="mono muted">{p.volume.toLocaleString()}</td>
                <td><RsiBar value={p.rsi}/></td>
                <td><Sparkline data={p.sparkline} change={p.change}/></td>
                <td><SignalBadge signal={p.signal}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        Showing <strong>{filtered.length}</strong> of <strong>{allInstruments.length}</strong> instruments
        &nbsp;·&nbsp;<span style={{ color:'#475569' }}>Updated: {new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

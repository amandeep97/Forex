import { useState, useMemo } from 'react';
import { allInstruments, ASSET_TYPES, FOREX_CATEGORIES, SIGNALS, ASSET_COLORS } from '../data/forexData';
import { useLivePrices } from '../hooks/useLivePrices';
import CandleChart from './CandleChart';

// ── Mini sparkline ────────────────────────────────────────────────────────────
function Sparkline({ data, change }) {
  const w = 80, h = 28;
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 0.0001;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const color = change >= 0 ? '#22c55e' : '#ef4444';
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ── Signal badge ──────────────────────────────────────────────────────────────
function SignalBadge({ signal }) {
  const s = SIGNALS[signal];
  if (!s) return null;
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
      letterSpacing: '0.03em', color: s.color, background: s.bg,
      border: `1px solid ${s.color}44`, whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  );
}

// ── Asset type badge ──────────────────────────────────────────────────────────
function AssetBadge({ type }) {
  const c = ASSET_COLORS[type] || { color: '#94a3b8', bg: '#1e293b55' };
  return (
    <span style={{
      padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
      color: c.color, background: c.bg, border: `1px solid ${c.color}44`,
      whiteSpace: 'nowrap',
    }}>
      {type}
    </span>
  );
}

// ── RSI bar ───────────────────────────────────────────────────────────────────
function RsiBar({ value }) {
  const color = value >= 70 ? '#ef4444' : value <= 30 ? '#22c55e' : '#94a3b8';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 48, height: 4, background: '#1e293b', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, color, fontFamily: 'JetBrains Mono', minWidth: 28 }}>{value}</span>
    </div>
  );
}

// ── Sort icon ─────────────────────────────────────────────────────────────────
function SortIcon({ col, sortKey, dir }) {
  if (sortKey !== col) return <span style={{ color: '#334155', marginLeft: 3 }}>⇅</span>;
  return <span style={{ color: '#00d4aa', marginLeft: 3 }}>{dir === 'asc' ? '↑' : '↓'}</span>;
}

// ── Summary card ─────────────────────────────────────────────────────────────
function SummaryCard({ label, value, color }) {
  return (
    <div className="summary-card">
      <span className="summary-value" style={{ color }}>{value}</span>
      <span className="summary-label">{label}</span>
    </div>
  );
}

// ── Format price based on magnitude ──────────────────────────────────────────
function fmtPrice(v) {
  if (v === undefined || v === null) return '—';
  if (v >= 10000) return v.toFixed(0);
  if (v >= 100)   return v.toFixed(2);
  if (v >= 1)     return v.toFixed(3);
  return v.toFixed(5);
}

// ── Live price badge ──────────────────────────────────────────────────────────
function LiveBadge({ isLive }) {
  return isLive ? (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '1px 6px', borderRadius: 10, fontSize: 9, fontWeight: 700,
      color: '#22c55e', background: '#22c55e18', border: '1px solid #22c55e44',
      letterSpacing: '0.06em',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'pulse 1.4s infinite' }} />
      LIVE
    </span>
  ) : (
    <span style={{
      padding: '1px 6px', borderRadius: 10, fontSize: 9, fontWeight: 700,
      color: '#475569', background: '#1e293b', border: '1px solid #334155',
      letterSpacing: '0.06em',
    }}>DEMO</span>
  );
}

// ── Main Screener ─────────────────────────────────────────────────────────────
const RSI_FILTERS   = ['All', 'Overbought >70', 'Neutral 30–70', 'Oversold <30'];
const CHANGE_FILTERS = ['All', 'Strong Up >1%', 'Up 0–1%', 'Down 0–1%', 'Strong Down <-1%'];
const VOL_FILTERS    = ['All', 'High Vol', 'Medium Vol', 'Low Vol'];

export default function Screener() {
  const { forexRates, cryptoRates, lastUpdate, loading, error, refresh } = useLivePrices();
  const [assetType, setAssetType]       = useState('All');
  const [subCategory, setSubCategory]   = useState('All');
  const [search, setSearch]             = useState('');
  const [sortKey, setSortKey]           = useState('symbol');
  const [sortDir, setSortDir]           = useState('asc');
  const [signalFilter, setSignalFilter] = useState('All');
  // Advanced filters
  const [rsiFilter, setRsiFilter]       = useState('All');
  const [changeFilter, setChangeFilter] = useState('All');
  const [volFilter, setVolFilter]       = useState('All');
  const [showFilters, setShowFilters]   = useState(false);
  // Candle chart
  const [chartInstrument, setChartInstrument] = useState(null);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  // Sub-categories depend on chosen asset type
  const subCategories = useMemo(() => {
    if (assetType === 'All' || assetType === 'Crypto') return [];
    if (assetType === 'Forex') return FOREX_CATEGORIES;
    const cats = [...new Set(allInstruments.filter(i => i.assetType === assetType).map(i => i.category))];
    return ['All', ...cats];
  }, [assetType]);

  // Merge live prices into instruments
  const instrumentsWithLive = useMemo(() => {
    return allInstruments.map(inst => {
      let livePrice = null;
      if (inst.assetType === 'Forex')  livePrice = forexRates[inst.symbol];
      if (inst.assetType === 'Crypto') livePrice = cryptoRates[inst.symbol];
      if (livePrice) {
        const spread = inst.spread;
        const bid    = parseFloat(livePrice.toFixed(inst.bid > 10 ? 3 : 5));
        const ask    = parseFloat((bid + spread).toFixed(inst.bid > 10 ? 3 : 5));
        return { ...inst, bid, ask, isLive: true };
      }
      return { ...inst, isLive: false };
    });
  }, [forexRates, cryptoRates]);

  const filtered = useMemo(() => {
    let list = instrumentsWithLive;
    if (assetType !== 'All') list = list.filter(i => i.assetType === assetType);
    if (subCategory !== 'All' && subCategories.length > 0) list = list.filter(i => i.category === subCategory);
    if (signalFilter !== 'All') list = list.filter(i => i.signal === signalFilter);
    // RSI filter
    if (rsiFilter === 'Overbought >70') list = list.filter(i => i.rsi > 70);
    if (rsiFilter === 'Neutral 30–70')  list = list.filter(i => i.rsi >= 30 && i.rsi <= 70);
    if (rsiFilter === 'Oversold <30')   list = list.filter(i => i.rsi < 30);
    // Change filter
    if (changeFilter === 'Strong Up >1%')    list = list.filter(i => i.change > 1);
    if (changeFilter === 'Up 0–1%')          list = list.filter(i => i.change > 0 && i.change <= 1);
    if (changeFilter === 'Down 0–1%')        list = list.filter(i => i.change < 0 && i.change >= -1);
    if (changeFilter === 'Strong Down <-1%') list = list.filter(i => i.change < -1);
    // Volume filter
    const vols = instrumentsWithLive.map(i => i.volume).sort((a,b) => a - b);
    const v33 = vols[Math.floor(vols.length / 3)];
    const v66 = vols[Math.floor(vols.length * 2 / 3)];
    if (volFilter === 'High Vol')   list = list.filter(i => i.volume > v66);
    if (volFilter === 'Medium Vol') list = list.filter(i => i.volume >= v33 && i.volume <= v66);
    if (volFilter === 'Low Vol')    list = list.filter(i => i.volume < v33);
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      list = list.filter(i => i.symbol.toUpperCase().includes(q));
    }
    list = [...list].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (typeof av === 'string') av = av.toLowerCase(), bv = bv.toLowerCase();
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [instrumentsWithLive, assetType, subCategory, search, sortKey, sortDir, signalFilter, subCategories]);

  // Summary stats
  const total   = filtered.length;
  const bullish = filtered.filter(p => p.signal === 'STRONG_BUY' || p.signal === 'BUY').length;
  const bearish = filtered.filter(p => p.signal === 'STRONG_SELL' || p.signal === 'SELL').length;
  const neutral = filtered.filter(p => p.signal === 'NEUTRAL').length;

  // Asset type counts
  const counts = useMemo(() => {
    const c = {};
    ASSET_TYPES.forEach(t => {
      c[t] = t === 'All' ? allInstruments.length : allInstruments.filter(i => i.assetType === t).length;
    });
    return c;
  }, []);

  const liveCount = filtered.filter(i => i.isLive).length;

  const cols = [
    { key: 'symbol',    label: 'Symbol',   width: 120 },
    { key: 'assetType', label: 'Type',     width: 80  },
    { key: 'category',  label: 'Category', width: 90  },
    { key: 'bid',       label: 'Bid',      width: 100 },
    { key: 'ask',       label: 'Ask',      width: 100 },
    { key: 'spread',    label: 'Spread',   width: 80  },
    { key: 'change',    label: 'Change %', width: 90  },
    { key: 'high',      label: 'High',     width: 100 },
    { key: 'low',       label: 'Low',      width: 100 },
    { key: 'volume',    label: 'Volume',   width: 90  },
    { key: 'rsi',       label: 'RSI',      width: 110 },
    { key: null,        label: 'Trend',    width: 90  },
    { key: 'signal',    label: 'Signal',   width: 110 },
    { key: null,        label: 'Chart',    width: 60  },
  ];

  return (
    <div className="screener-root">

      {/* ── Asset type tabs ─────────────────────────────────────────────── */}
      <div className="asset-type-row">
        {ASSET_TYPES.map(t => {
          const c = ASSET_COLORS[t] || { color: '#94a3b8', bg: '#1e293b55' };
          const active = assetType === t;
          return (
            <button
              key={t}
              className={`asset-type-btn ${active ? 'active' : ''}`}
              style={active ? { borderColor: c.color, color: c.color, background: c.bg } : {}}
              onClick={() => { setAssetType(t); setSubCategory('All'); }}
            >
              <span className="asset-type-icon">
                {t === 'All' ? '◈' : t === 'Forex' ? '₣' : t === 'Metals' ? '⬡' : t === 'Indices' ? '📊' : t === 'Energy' ? '⚡' : '₿'}
              </span>
              {t}
              <span className="asset-type-count">{counts[t]}</span>
            </button>
          );
        })}
      </div>

      {/* ── Live feed status bar ─────────────────────────────────────────── */}
      <div className="live-status-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {loading ? (
            <span style={{ color: '#475569', fontSize: 12 }}>⟳ Connecting to live feed…</span>
          ) : error ? (
            <span style={{ color: '#f97316', fontSize: 12 }}>⚠ {error}</span>
          ) : (
            <>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'pulse 1.4s infinite' }} />
              <span style={{ color: '#22c55e', fontSize: 12, fontWeight: 600 }}>
                LIVE — {liveCount} instruments (Forex + Crypto)
              </span>
              <span style={{ color: '#475569', fontSize: 11 }}>
                · Updated {lastUpdate ? lastUpdate.toLocaleTimeString() : '—'}
              </span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#475569', fontSize: 11 }}>Metals · Indices · Energy = Demo prices</span>
          <button
            onClick={refresh}
            style={{ color: '#00d4aa', fontSize: 11, fontWeight: 600, padding: '2px 8px', border: '1px solid #00d4aa44', borderRadius: 4 }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* ── Summary row ─────────────────────────────────────────────────── */}
      <div className="summary-row">
        <SummaryCard label="Showing"  value={total}   color="#00d4aa" />
        <SummaryCard label="Bullish"  value={bullish}  color="#22c55e" />
        <SummaryCard label="Bearish"  value={bearish}  color="#ef4444" />
        <SummaryCard label="Neutral"  value={neutral}  color="#94a3b8" />
      </div>

      {/* ── Filters bar ─────────────────────────────────────────────────── */}
      <div className="filter-bar">
        {/* Advanced filter toggle */}
        <button
          className={`tab-btn ${showFilters ? 'active' : ''}`}
          onClick={() => setShowFilters(f => !f)}
          style={{ display: 'flex', alignItems: 'center', gap: 5 }}
        >
          ⧉ Filters
          {(rsiFilter !== 'All' || changeFilter !== 'All' || volFilter !== 'All') && (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#00d4aa', display: 'inline-block' }} />
          )}
        </button>

        {/* Sub-category tabs (Majors/Minors etc.) */}
        {subCategories.length > 0 && (
          <div className="tab-group">
            {subCategories.map(c => (
              <button
                key={c}
                className={`tab-btn ${subCategory === c ? 'active' : ''}`}
                onClick={() => setSubCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {/* Signal filter */}
        <div className="tab-group">
          {['All', 'STRONG_BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG_SELL'].map(s => (
            <button
              key={s}
              className={`tab-btn signal-tab ${signalFilter === s ? 'active' : ''}`}
              style={signalFilter === s && s !== 'All' ? {
                color: SIGNALS[s]?.color,
                borderColor: SIGNALS[s]?.color,
                background: SIGNALS[s]?.bg,
              } : {}}
              onClick={() => setSignalFilter(s)}
            >
              {s === 'All' ? 'All Signals' : SIGNALS[s]?.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="search-wrap">
          <span className="search-icon">⌕</span>
          <input
            className="search-input"
            placeholder="Search symbol…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button className="search-clear" onClick={() => setSearch('')}>×</button>}
        </div>
      </div>

      {/* ── Advanced filter panel ───────────────────────────────────────── */}
      {showFilters && (
        <div className="adv-filter-panel">
          <div className="adv-filter-group">
            <div className="adv-filter-label">RSI</div>
            <div className="tab-group">
              {RSI_FILTERS.map(f => (
                <button key={f} className={`tab-btn ${rsiFilter === f ? 'active' : ''}`}
                  onClick={() => setRsiFilter(f)}>{f}</button>
              ))}
            </div>
          </div>
          <div className="adv-filter-group">
            <div className="adv-filter-label">Change %</div>
            <div className="tab-group">
              {CHANGE_FILTERS.map(f => (
                <button key={f} className={`tab-btn ${changeFilter === f ? 'active' : ''}`}
                  onClick={() => setChangeFilter(f)}>{f}</button>
              ))}
            </div>
          </div>
          <div className="adv-filter-group">
            <div className="adv-filter-label">Volume</div>
            <div className="tab-group">
              {VOL_FILTERS.map(f => (
                <button key={f} className={`tab-btn ${volFilter === f ? 'active' : ''}`}
                  onClick={() => setVolFilter(f)}>{f}</button>
              ))}
            </div>
          </div>
          <button
            className="tab-btn"
            style={{ marginLeft: 'auto', color: '#ef4444' }}
            onClick={() => { setRsiFilter('All'); setChangeFilter('All'); setVolFilter('All'); }}
          >
            ✕ Clear
          </button>
        </div>
      )}

      {/* ── Candle chart modal ──────────────────────────────────────────── */}
      {chartInstrument && (
        <CandleChart
          instrument={chartInstrument}
          onClose={() => setChartInstrument(null)}
        />
      )}

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <div className="table-wrap">
        <table className="screener-table">
          <thead>
            <tr>
              {cols.map(c => (
                <th
                  key={c.label}
                  style={{ minWidth: c.width, cursor: c.key ? 'pointer' : 'default' }}
                  onClick={() => c.key && handleSort(c.key)}
                >
                  {c.label}
                  {c.key && <SortIcon col={c.key} sortKey={sortKey} dir={sortDir} />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={cols.length} style={{ textAlign: 'center', padding: '40px 0', color: '#475569' }}>
                  No instruments match your filters
                </td>
              </tr>
            ) : filtered.map(p => (
              <tr key={p.id} className="pair-row"
              >
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="pair-symbol">{p.symbol}</span>
                      <LiveBadge isLive={p.isLive} />
                    </div>
                    {p.unit && <span className="pair-category">{p.unit}</span>}
                  </div>
                </td>
                <td><AssetBadge type={p.assetType} /></td>
                <td><span className="pair-category" style={{ fontSize: 12 }}>{p.category}</span></td>
                <td className="mono">{fmtPrice(p.bid)}</td>
                <td className="mono">{fmtPrice(p.ask)}</td>
                <td className="mono spread-cell">{fmtPrice(p.spread)}</td>
                <td>
                  <span className={p.change >= 0 ? 'up' : 'down'}>
                    {p.change >= 0 ? '+' : ''}{p.change.toFixed(2)}%
                  </span>
                </td>
                <td className="mono muted">{fmtPrice(p.high)}</td>
                <td className="mono muted">{fmtPrice(p.low)}</td>
                <td className="mono muted">{p.volume.toLocaleString()}</td>
                <td><RsiBar value={p.rsi} /></td>
                <td><Sparkline data={p.sparkline} change={p.change} /></td>
                <td><SignalBadge signal={p.signal} /></td>
                <td>
                  <button
                    className="chart-open-btn"
                    title="Open candlestick chart"
                    onClick={() => setChartInstrument(p)}
                  >📈</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        Showing <strong>{filtered.length}</strong> of <strong>{allInstruments.length}</strong> instruments
        &nbsp;·&nbsp;
        <span style={{ color: '#475569' }}>Last updated: {new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

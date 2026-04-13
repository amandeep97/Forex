import { useState, useMemo } from 'react';
import { allInstruments, ASSET_TYPES, FOREX_CATEGORIES, SIGNALS, ASSET_COLORS } from '../data/forexData';

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

// ── Main Screener ─────────────────────────────────────────────────────────────
export default function Screener() {
  const [assetType, setAssetType]   = useState('All');
  const [subCategory, setSubCategory] = useState('All');
  const [search, setSearch]         = useState('');
  const [sortKey, setSortKey]       = useState('symbol');
  const [sortDir, setSortDir]       = useState('asc');
  const [signalFilter, setSignalFilter] = useState('All');

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

  const filtered = useMemo(() => {
    let list = allInstruments;
    if (assetType !== 'All') list = list.filter(i => i.assetType === assetType);
    if (subCategory !== 'All' && subCategories.length > 0) list = list.filter(i => i.category === subCategory);
    if (signalFilter !== 'All') list = list.filter(i => i.signal === signalFilter);
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
  }, [assetType, subCategory, search, sortKey, sortDir, signalFilter, subCategories]);

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

  const cols = [
    { key: 'symbol',    label: 'Symbol',   width: 110 },
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

      {/* ── Summary row ─────────────────────────────────────────────────── */}
      <div className="summary-row">
        <SummaryCard label="Showing"  value={total}   color="#00d4aa" />
        <SummaryCard label="Bullish"  value={bullish}  color="#22c55e" />
        <SummaryCard label="Bearish"  value={bearish}  color="#ef4444" />
        <SummaryCard label="Neutral"  value={neutral}  color="#94a3b8" />
      </div>

      {/* ── Filters bar ─────────────────────────────────────────────────── */}
      <div className="filter-bar">
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
              <tr key={p.id} className="pair-row">
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span className="pair-symbol">{p.symbol}</span>
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

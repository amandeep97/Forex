import { useState, useMemo } from 'react';
import { forexPairs, CATEGORIES, SIGNALS } from '../data/forexData';

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
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.03em',
      color: s.color,
      background: s.bg,
      border: `1px solid ${s.color}44`,
      whiteSpace: 'nowrap',
    }}>
      {s.label}
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

// ── Main Screener ─────────────────────────────────────────────────────────────
export default function Screener() {
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('symbol');
  const [sortDir, setSortDir] = useState('asc');
  const [signalFilter, setSignalFilter] = useState('All');

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const filtered = useMemo(() => {
    let list = forexPairs;
    if (category !== 'All') list = list.filter(p => p.category === category);
    if (signalFilter !== 'All') list = list.filter(p => p.signal === signalFilter);
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      list = list.filter(p => p.symbol.includes(q));
    }
    list = [...list].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (typeof av === 'string') av = av.toLowerCase(), bv = bv.toLowerCase();
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [category, search, sortKey, sortDir, signalFilter]);

  // Summary stats
  const total = forexPairs.length;
  const bullish = forexPairs.filter(p => p.signal === 'STRONG_BUY' || p.signal === 'BUY').length;
  const bearish = forexPairs.filter(p => p.signal === 'STRONG_SELL' || p.signal === 'SELL').length;
  const neutral = forexPairs.filter(p => p.signal === 'NEUTRAL').length;

  const cols = [
    { key: 'symbol',  label: 'Pair',     width: 110 },
    { key: 'bid',     label: 'Bid',      width: 100 },
    { key: 'ask',     label: 'Ask',      width: 100 },
    { key: 'spread',  label: 'Spread',   width: 80  },
    { key: 'change',  label: 'Change %', width: 90  },
    { key: 'high',    label: 'High',     width: 100 },
    { key: 'low',     label: 'Low',      width: 100 },
    { key: 'volume',  label: 'Volume',   width: 90  },
    { key: 'rsi',     label: 'RSI',      width: 110 },
    { key: null,      label: 'Trend',    width: 90  },
    { key: 'signal',  label: 'Signal',   width: 110 },
  ];

  return (
    <div className="screener-root">
      {/* Summary row */}
      <div className="summary-row">
        <SummaryCard label="Total Pairs"  value={total}   color="#94a3b8" />
        <SummaryCard label="Bullish"      value={bullish}  color="#22c55e" />
        <SummaryCard label="Bearish"      value={bearish}  color="#ef4444" />
        <SummaryCard label="Neutral"      value={neutral}  color="#94a3b8" />
        <SummaryCard label="Showing"      value={filtered.length} color="#00d4aa" />
      </div>

      {/* Filters */}
      <div className="filter-bar">
        {/* Category tabs */}
        <div className="tab-group">
          {CATEGORIES.map(c => (
            <button
              key={c}
              className={`tab-btn ${category === c ? 'active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>

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
            placeholder="Search pair…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')}>×</button>
          )}
        </div>
      </div>

      {/* Table */}
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
                  No pairs match your filters
                </td>
              </tr>
            ) : filtered.map(p => (
              <tr key={p.id} className="pair-row">
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span className="pair-symbol">{p.symbol}</span>
                    <span className="pair-category">{p.category}</span>
                  </div>
                </td>
                <td className="mono">{p.bid.toFixed(p.bid > 10 ? 3 : 5)}</td>
                <td className="mono">{p.ask.toFixed(p.ask > 10 ? 3 : 5)}</td>
                <td className="mono spread-cell">{p.spread.toFixed(p.spread > 0.1 ? 3 : 5)}</td>
                <td>
                  <span className={p.change >= 0 ? 'up' : 'down'}>
                    {p.change >= 0 ? '+' : ''}{p.change.toFixed(2)}%
                  </span>
                </td>
                <td className="mono muted">{p.high.toFixed(p.high > 10 ? 3 : 5)}</td>
                <td className="mono muted">{p.low.toFixed(p.low > 10 ? 3 : 5)}</td>
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
        Showing <strong>{filtered.length}</strong> of <strong>{total}</strong> pairs
        &nbsp;·&nbsp; Data refreshes every 5s &nbsp;·&nbsp;
        <span style={{ color: '#475569' }}>Last updated: {new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

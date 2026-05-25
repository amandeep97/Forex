import { useState, useEffect, useCallback } from 'react';
import { ghRead, isGithubConfigured } from '../utils/githubSync';

function getSession(isoTime) {
  if (!isoTime) return 'unknown';
  const h = new Date(isoTime).getUTCHours();
  if (h >= 8  && h < 13) return 'london';
  if (h >= 13 && h < 17) return 'overlap';
  if (h >= 13 && h < 22) return 'newyork';
  return 'asian';
}

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: '#1e293b', borderRadius: 8, padding: '14px 18px', flex: 1, minWidth: 130 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#f8fafc' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

export default function Journal() {
  const [trades, setTrades]       = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [filterPair, setFilterPair]     = useState('ALL');
  const [filterResult, setFilterResult] = useState('ALL');
  const [filterDir, setFilterDir]       = useState('ALL');
  const [sortField, setSortField] = useState('openTime');
  const [sortDir, setSortDir]     = useState('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await ghRead('bot/trades.json');
      setTrades(data?.content?.trades || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const closed = trades.filter(t => t.status === 'CLOSED' || t.pnl != null);
  const open   = trades.filter(t => t.status === 'OPEN' && t.pnl == null);

  // Stats
  const wins       = closed.filter(t => (t.pnl || 0) > 0);
  const losses     = closed.filter(t => (t.pnl || 0) <= 0);
  const winRate    = closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : null;
  const totalPnl   = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const gProfit    = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const gLoss      = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
  const pf         = gLoss > 0 ? (gProfit / gLoss).toFixed(2) : '∞';
  const rrVals     = closed.filter(t => t.rr != null).map(t => t.rr);
  const avgRR      = rrVals.length > 0 ? (rrVals.reduce((s, v) => s + v, 0) / rrVals.length).toFixed(2) : null;

  // Per-pair table
  const pairMap = {};
  closed.forEach(t => {
    if (!pairMap[t.pair]) pairMap[t.pair] = { pair: t.pair, trades: 0, wins: 0, pnl: 0 };
    pairMap[t.pair].trades++;
    if ((t.pnl || 0) > 0) pairMap[t.pair].wins++;
    pairMap[t.pair].pnl += t.pnl || 0;
  });
  const pairStats = Object.values(pairMap).sort((a, b) => b.pnl - a.pnl);

  // Session stats
  const sess = { london: { t: 0, pnl: 0 }, overlap: { t: 0, pnl: 0 }, newyork: { t: 0, pnl: 0 }, asian: { t: 0, pnl: 0 } };
  closed.forEach(t => {
    const s = (t.session || getSession(t.openTime)).toLowerCase();
    const key = s.includes('overlap') ? 'overlap'
              : s.includes('london')  ? 'london'
              : s.includes('newyork') || s.includes('new') ? 'newyork'
              : 'asian';
    sess[key].t++;
    sess[key].pnl += t.pnl || 0;
  });

  const allPairs = [...new Set(trades.map(t => t.pair))].filter(Boolean).sort();

  // Filter + sort
  let filtered = [...closed];
  if (filterPair   !== 'ALL') filtered = filtered.filter(t => t.pair === filterPair);
  if (filterResult === 'WIN')  filtered = filtered.filter(t => (t.pnl || 0) > 0);
  if (filterResult === 'LOSS') filtered = filtered.filter(t => (t.pnl || 0) <= 0);
  if (filterDir    !== 'ALL') filtered = filtered.filter(t => t.direction === filterDir);
  filtered.sort((a, b) => {
    const av = a[sortField] ?? '', bv = b[sortField] ?? '';
    return sortDir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('desc'); }
  };

  const fmtPnl  = (v) => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;
  const fmtDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const fmtPx   = (v) => v != null ? Number(v).toFixed(5) : '—';

  const TH = ({ f, l }) => (
    <th
      onClick={() => toggleSort(f)}
      style={{ padding: '10px 10px', textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none', color: '#64748b', fontWeight: 500 }}
    >
      {l}{sortField === f ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <div style={{ padding: '16px 20px', maxWidth: 1200, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: '#f8fafc' }}>Trade Journal</h2>
        {loading && <span style={{ fontSize: 12, color: '#64748b' }}>Loading…</span>}
        {!isGithubConfigured() && (
          <span style={{ fontSize: 12, color: '#f59e0b', background: '#1e293b', padding: '4px 10px', borderRadius: 6 }}>
            GitHub token required — set in Strategy tab
          </span>
        )}
        <button
          onClick={load}
          disabled={loading}
          style={{ marginLeft: 'auto', background: '#334155', border: 'none', color: '#94a3b8', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
        >
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#450a0a', border: '1px solid #b91c1c', borderRadius: 6, padding: '8px 14px', marginBottom: 16, color: '#fca5a5', fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <StatCard label="Total Closed" value={closed.length} />
        <StatCard label="Open Trades"  value={open.length}   color="#0ea5e9" />
        <StatCard
          label="Win Rate"
          value={winRate ? `${winRate}%` : '—'}
          color={winRate ? (parseFloat(winRate) >= 50 ? '#22c55e' : '#ef4444') : undefined}
          sub={closed.length ? `${wins.length}W / ${losses.length}L` : ''}
        />
        <StatCard
          label="Profit Factor"
          value={closed.length ? pf : '—'}
          color={closed.length ? (pf === '∞' || parseFloat(pf) >= 1.5 ? '#22c55e' : parseFloat(pf) >= 1 ? '#f59e0b' : '#ef4444') : undefined}
        />
        <StatCard label="Avg R:R"   value={avgRR ? `1:${avgRR}` : '—'} color="#a78bfa" />
        <StatCard
          label="Total P&L"
          value={closed.length ? fmtPnl(totalPnl) : '—'}
          color={totalPnl >= 0 ? '#22c55e' : '#ef4444'}
          sub={closed.length ? `${fmtPnl(gProfit)} / ${fmtPnl(-gLoss)}` : ''}
        />
      </div>

      {/* Pair + session tables */}
      {closed.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>

          <div style={{ flex: 2, minWidth: 260, background: '#1e293b', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 10 }}>Performance by Pair</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#64748b' }}>
                  <th style={{ textAlign: 'left',  padding: '4px 6px' }}>Pair</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Trades</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Win%</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>P&L</th>
                </tr>
              </thead>
              <tbody>
                {pairStats.slice(0, 8).map(ps => (
                  <tr key={ps.pair} style={{ borderTop: '1px solid #0f172a' }}>
                    <td style={{ padding: '5px 6px', fontWeight: 600, color: '#e2e8f0' }}>{ps.pair?.replace('_', '/')}</td>
                    <td style={{ padding: '5px 6px', textAlign: 'right', color: '#94a3b8' }}>{ps.trades}</td>
                    <td style={{ padding: '5px 6px', textAlign: 'right', color: ps.wins / ps.trades >= 0.5 ? '#22c55e' : '#ef4444' }}>
                      {((ps.wins / ps.trades) * 100).toFixed(0)}%
                    </td>
                    <td style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 600, color: ps.pnl >= 0 ? '#22c55e' : '#ef4444' }}>
                      {fmtPnl(ps.pnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ flex: 1, minWidth: 200, background: '#1e293b', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 10 }}>Session Performance</div>
            {[
              { key: 'london',  label: 'London',   color: '#38bdf8' },
              { key: 'overlap', label: 'Overlap',  color: '#a78bfa' },
              { key: 'newyork', label: 'New York', color: '#34d399' },
              { key: 'asian',   label: 'Asian',    color: '#fbbf24' },
            ].map(({ key, label, color }) => (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid #0f172a' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
                  <span style={{ fontSize: 12, color: '#e2e8f0' }}>{label}</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 11, color: '#64748b', marginRight: 8 }}>{sess[key].t} trades</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: sess[key].pnl >= 0 ? '#22c55e' : '#ef4444' }}>
                    {sess[key].t > 0 ? fmtPnl(sess[key].pnl) : '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>

        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: '#64748b' }}>Filter:</span>
        <select
          value={filterPair}
          onChange={e => setFilterPair(e.target.value)}
          style={{ background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '5px 10px', fontSize: 12 }}
        >
          <option value="ALL">All Pairs</option>
          {allPairs.map(p => <option key={p} value={p}>{p.replace('_', '/')}</option>)}
        </select>
        <select
          value={filterDir}
          onChange={e => setFilterDir(e.target.value)}
          style={{ background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '5px 10px', fontSize: 12 }}
        >
          <option value="ALL">All Directions</option>
          <option value="LONG">Long Only</option>
          <option value="SHORT">Short Only</option>
        </select>
        {['ALL', 'WIN', 'LOSS'].map(r => (
          <button
            key={r}
            onClick={() => setFilterResult(r)}
            style={{
              background: filterResult === r ? '#334155' : 'transparent',
              border: `1px solid ${filterResult === r ? '#475569' : '#1e293b'}`,
              color: filterResult === r ? '#f8fafc' : '#64748b',
              borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer',
            }}
          >
            {r === 'ALL' ? 'All Results' : r}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#475569' }}>
          {filtered.length} trade{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Trade table */}
      <div style={{ overflowX: 'auto', background: '#1e293b', borderRadius: 8 }}>
        {trades.length === 0 && !loading ? (
          <div style={{ padding: '48px 0', textAlign: 'center', color: '#475569' }}>
            {isGithubConfigured()
              ? 'No trades in bot/trades.json — run the VPS bot or place trades via App Bot'
              : 'Configure GitHub token in the Strategy tab to load trade history'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #0f172a' }}>
                <TH f="openTime"   l="Opened"   />
                <TH f="pair"       l="Pair"      />
                <TH f="direction"  l="Dir"       />
                <TH f="entryPrice" l="Entry"     />
                <TH f="slPrice"    l="SL"        />
                <TH f="tpPrice"    l="TP"        />
                <TH f="closePrice" l="Close"     />
                <TH f="rr"         l="R:R"       />
                <TH f="pnl"        l="P&L"       />
                <TH f="status"     l="Result"    />
                <TH f="session"    l="Session"   />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={11} style={{ textAlign: 'center', padding: '32px 0', color: '#475569' }}>
                    No trades match the current filters
                  </td>
                </tr>
              ) : filtered.map((t, i) => {
                const isWin = (t.pnl || 0) > 0;
                return (
                  <tr key={t.id || i} style={{ borderTop: '1px solid #0f172a' }}>
                    <td style={{ padding: '8px 10px', color: '#94a3b8', whiteSpace: 'nowrap' }}>{fmtDate(t.openTime)}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 600, color: '#e2e8f0' }}>{t.pair?.replace('_', '/')}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ color: t.direction === 'LONG' ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{t.direction}</span>
                    </td>
                    <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: '#cbd5e1' }}>{fmtPx(t.entryPrice)}</td>
                    <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: '#ef4444' }}>{fmtPx(t.slPrice)}</td>
                    <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: '#22c55e' }}>{fmtPx(t.tpPrice)}</td>
                    <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: '#94a3b8' }}>{fmtPx(t.closePrice)}</td>
                    <td style={{ padding: '8px 10px', color: '#a78bfa' }}>{t.rr != null ? `1:${Number(t.rr).toFixed(1)}` : '—'}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 600, color: (t.pnl || 0) >= 0 ? '#22c55e' : '#ef4444' }}>
                      {t.pnl != null ? fmtPnl(t.pnl) : '—'}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                        background: t.status === 'OPEN' ? '#0c4a6e' : isWin ? '#14532d' : '#450a0a',
                        color:      t.status === 'OPEN' ? '#38bdf8' : isWin ? '#4ade80' : '#f87171',
                      }}>
                        {t.status === 'OPEN' ? 'OPEN' : isWin ? 'WIN' : 'LOSS'}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px', color: '#64748b', fontSize: 11 }}>
                      {(t.session || getSession(t.openTime)) || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

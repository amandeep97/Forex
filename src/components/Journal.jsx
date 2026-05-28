import { useState, useEffect, useCallback, useMemo } from 'react';
import { ghRead, isGithubConfigured } from '../utils/githubSync';

// ── Normalise any trade record (vps-bot, app autotrade, manual) ───────────────
function norm(t) {
  const raw    = t.pnlUsd ?? t.pnl ?? null;
  const status = (t.status || '').toLowerCase();
  let result   = 'open';
  if      (status === 'tp_hit' || status === 'win'  || (raw != null && raw >  0.005)) result = 'win';
  else if (status === 'sl_hit' || status === 'loss' || (raw != null && raw < -0.005)) result = 'loss';
  else if (raw != null && Math.abs(raw) <= 0.005 && !['open',''].includes(status))    result = 'be';
  else if (status === 'closed')  result = raw != null ? (raw > 0 ? 'win' : raw < 0 ? 'loss' : 'be') : 'be';
  const dir = (t.direction || t.dir || '').toUpperCase();
  return {
    ...t,
    _pair:     (t.pair || t.instrument || '?').replace('_', '/'),
    _dir:      dir || 'LONG',
    _entry:    t.entry  ?? t.entryPrice ?? t.openPrice  ?? null,
    _sl:       t.sl     ?? t.slPrice    ?? null,
    _tp:       t.tp     ?? t.tpPrice    ?? null,
    _close:    t.closePrice ?? t.close  ?? null,
    _pnl:      raw,
    _rr:       t.rrAchieved ?? t.rrPlanned ?? t.rr ?? null,
    _result:   result,
    _openedAt: t.openedAt  ?? t.openTime  ?? t.timestamp ?? null,
    _closedAt: t.closedAt  ?? t.closeTime ?? null,
    _strategy: t.strategyName ?? t.strategy ?? '',
    _source:   t.source  ?? 'manual',
    _session:  (t.session || '').toLowerCase(),
    _lots:     t.lotSize ?? t.lots ?? null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (v, digits = 2) => v == null ? '—' : `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(digits)}`;
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const pnlColor = v => v >= 0 ? '#22c55e' : '#ef4444';
const resultColor = r => ({ win: '#22c55e', loss: '#ef4444', be: '#64748b', open: '#38bdf8' }[r] ?? '#94a3b8');
const resultBg    = r => ({ win: '#14532d', loss: '#450a0a', be: '#1e293b',  open: '#0c4a6e' }[r] ?? '#1e293b');

// ── Equity Curve ──────────────────────────────────────────────────────────────
function EquityCurve({ trades }) {
  const sorted = [...trades].sort((a, b) => new Date(a._closedAt || 0) - new Date(b._closedAt || 0));
  let cum = 0;
  const pts = [0, ...sorted.map(t => { cum += (t._pnl || 0); return cum; })];
  if (pts.length < 2) return null;
  const mn = Math.min(...pts), mx = Math.max(...pts), range = mx - mn || 1;
  const W = 340, H = 72, P = 4;
  const px = i => P + (i / (pts.length - 1)) * (W - P * 2);
  const py = v => H - P - ((v - mn) / range) * (H - P * 2);
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const col  = last >= 0 ? '#22c55e' : '#ef4444';
  return (
    <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px', marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>Equity Curve</span>
        <span style={{ fontSize: 14, fontWeight: 800, color: col }}>{$(last)}</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <linearGradient id="eqG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.35"/>
            <stop offset="100%" stopColor={col} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <path d={`M${px(0)},${H} ${path.slice(1)} L${px(pts.length-1)},${H} Z`} fill="url(#eqG)"/>
        <path d={path} fill="none" stroke={col} strokeWidth="1.5"/>
        <circle cx={px(pts.length-1)} cy={py(last)} r="3" fill={col}/>
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span style={{ fontSize: 9, color: '#334155' }}>Start</span>
        <span style={{ fontSize: 9, color: '#334155' }}>Now</span>
      </div>
    </div>
  );
}

// ── Monthly P&L Calendar ──────────────────────────────────────────────────────
function MonthCalendar({ trades }) {
  const now = new Date();
  const [m, setM] = useState(now.getMonth());
  const [y, setY] = useState(now.getFullYear());
  const dayMap = {};
  trades.forEach(t => {
    const d = t._closedAt ? new Date(t._closedAt) : null;
    if (!d || d.getMonth() !== m || d.getFullYear() !== y) return;
    const k = d.getDate();
    dayMap[k] = (dayMap[k] || 0) + (t._pnl || 0);
  });
  const first = new Date(y, m, 1).getDay();
  const days  = new Date(y, m + 1, 0).getDate();
  const label = new Date(y, m, 1).toLocaleString([], { month: 'long', year: 'numeric' });
  const prev  = () => m === 0 ? (setM(11), setY(y - 1)) : setM(m - 1);
  const next  = () => m === 11 ? (setM(0), setY(y + 1)) : setM(m + 1);
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px', marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc' }}>Monthly P&amp;L Calendar</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={prev} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>‹</button>
          <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 110, textAlign: 'center' }}>{label}</span>
          <button onClick={next} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>›</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
        {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
          <div key={d} style={{ fontSize: 9, color: '#334155', textAlign: 'center', fontWeight: 700, paddingBottom: 3 }}>{d}</div>
        ))}
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`}/>;
          const pnl     = dayMap[day];
          const has     = pnl != null;
          const isToday = day === now.getDate() && m === now.getMonth() && y === now.getFullYear();
          const fmt     = has ? (Math.abs(pnl) >= 0.995 ? `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(0)}` : `${pnl >= 0 ? '+' : '-'}${(Math.abs(pnl)*100).toFixed(0)}¢`) : null;
          return (
            <div key={day} style={{
              borderRadius: 5, padding: '4px 2px', textAlign: 'center', minHeight: 36,
              background: has ? (pnl >= 0 ? '#14532d' : '#450a0a') : '#0f172a',
              border: `1px solid ${isToday ? '#00d4aa' : 'transparent'}`,
            }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: has ? (pnl >= 0 ? '#86efac' : '#fca5a5') : '#334155' }}>{day}</div>
              {fmt && <div style={{ fontSize: 8, fontWeight: 800, color: pnl >= 0 ? '#22c55e' : '#ef4444', lineHeight: 1.3 }}>{fmt}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Trade Card (mobile-first) ─────────────────────────────────────────────────
function TradeCard({ t }) {
  const rc = resultColor(t._result);
  const dc = t._dir === 'LONG' ? '#22c55e' : '#ef4444';
  const srcLabel = t._source === 'vps_bot' ? 'VPS' : t._source === 'app_autotrade' ? 'AUTO' : t._source === 'app_mt4' ? 'MT4' : null;
  return (
    <div style={{ background: '#1e293b', borderRadius: 10, padding: '12px 14px', marginBottom: 8, borderLeft: `3px solid ${rc}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 15, fontWeight: 800, color: '#f8fafc' }}>{t._pair}</span>
        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: dc + '22', color: dc }}>{t._dir}</span>
        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: resultBg(t._result), color: rc }}>{t._result.toUpperCase()}</span>
        {srcLabel && (
          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: '#1e40af22', color: '#60a5fa', border: '1px solid #1e40af44' }}>{srcLabel}</span>
        )}
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          {t._pnl != null && <div style={{ fontSize: 15, fontWeight: 800, color: rc }}>{$(t._pnl)}</div>}
          {t._rr  != null && <div style={{ fontSize: 10, color: '#64748b' }}>{Number(t._rr) >= 0 ? '+' : ''}{Number(t._rr).toFixed(2)}R</div>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}>
        {t._strategy && <span style={{ fontSize: 10, color: '#94a3b8', background: '#0f172a', padding: '2px 8px', borderRadius: 4 }}>{t._strategy}</span>}
        {t._session  && <span style={{ fontSize: 10, color: '#64748b', background: '#0f172a', padding: '2px 8px', borderRadius: 4 }}>{t._session}</span>}
      </div>
      <div style={{ fontSize: 10, color: '#475569', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span>{fmtDate(t._openedAt)}</span>
        {t._entry != null && <span>Entry {Number(t._entry).toPrecision(6)}</span>}
        {t._result === 'open' && t._sl != null && <span style={{ color: '#ef444488' }}>SL {Number(t._sl).toPrecision(5)}</span>}
        {t._result === 'open' && t._tp != null && <span style={{ color: '#22c55e88' }}>TP {Number(t._tp).toPrecision(5)}</span>}
      </div>
    </div>
  );
}

// ── Session key helper ────────────────────────────────────────────────────────
function sessKey(s) {
  if (!s) return 'other';
  if (s.includes('asian') || s === 'asia') return 'asian';
  if (s.includes('london'))  return 'london';
  if (s.includes('new') || s.includes('york')) return 'newyork';
  if (s.includes('overlap')) return 'newyork'; // overlap = London/NY crossover
  return 'other';
}

// ── Main Journal ──────────────────────────────────────────────────────────────
export default function Journal() {
  const [rawTrades, setRaw]     = useState([]);
  const [loading,   setLoading] = useState(false);
  const [error,     setError]   = useState('');
  const [tab,       setTab]     = useState('overview');
  const [search,    setSearch]  = useState('');
  const [filter,    setFilter]  = useState('all');
  const [lastSync,  setLastSync]= useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const d = await ghRead('bot/trades.json');
      setRaw(d?.content?.trades || []);
      setLastSync(new Date());
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 120_000); return () => clearInterval(t); }, [load]);

  const trades  = useMemo(() => rawTrades.map(norm), [rawTrades]);
  const closed  = useMemo(() => trades.filter(t => t._result !== 'open'), [trades]);
  const open    = useMemo(() => trades.filter(t => t._result === 'open'),  [trades]);
  const wins    = useMemo(() => closed.filter(t => t._result === 'win'),   [closed]);
  const losses  = useMemo(() => closed.filter(t => t._result === 'loss'),  [closed]);
  const bes     = useMemo(() => closed.filter(t => t._result === 'be'),    [closed]);

  const totalPnl = useMemo(() => closed.reduce((s, t) => s + (t._pnl || 0), 0), [closed]);
  const gProfit  = useMemo(() => wins.reduce((s, t) => s + (t._pnl || 0), 0),   [wins]);
  const gLoss    = useMemo(() => Math.abs(losses.reduce((s, t) => s + (t._pnl || 0), 0)), [losses]);
  const pf       = gLoss > 0 ? gProfit / gLoss : wins.length > 0 ? Infinity : 0;
  const winRate  = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const avgWin   = wins.length   > 0 ? gProfit / wins.length   : 0;
  const avgLoss  = losses.length > 0 ? gLoss   / losses.length : 0;

  const rrTrades = useMemo(() => closed.filter(t => t._rr != null), [closed]);
  const avgR     = rrTrades.length > 0 ? rrTrades.reduce((s, t) => s + Number(t._rr), 0) / rrTrades.length : null;

  const maxDrawdown = useMemo(() => {
    let peak = 0, cum = 0, dd = 0;
    [...closed].sort((a, b) => new Date(a._closedAt || 0) - new Date(b._closedAt || 0))
      .forEach(t => { cum += t._pnl || 0; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; });
    return dd;
  }, [closed]);

  const streak = useMemo(() => {
    const sorted = [...closed].sort((a, b) => new Date(a._closedAt || 0) - new Date(b._closedAt || 0));
    if (!sorted.length) return { type: null, count: 0 };
    const last = sorted[sorted.length - 1]._result;
    let n = 0;
    for (let i = sorted.length - 1; i >= 0 && sorted[i]._result === last; i--) n++;
    return { type: last, count: n };
  }, [closed]);

  const sessStats = useMemo(() => {
    const m = { asian: { t:0, w:0, pnl:0 }, london: { t:0, w:0, pnl:0 }, newyork: { t:0, w:0, pnl:0 }, other: { t:0, w:0, pnl:0 } };
    closed.forEach(t => {
      const k = sessKey(t._session);
      m[k].t++; m[k].pnl += t._pnl || 0;
      if (t._result === 'win') m[k].w++;
    });
    return m;
  }, [closed]);

  const stratStats = useMemo(() => {
    const m = {};
    closed.forEach(t => {
      const k = t._strategy || 'Manual';
      if (!m[k]) m[k] = { name: k, t: 0, w: 0, pnl: 0 };
      m[k].t++; m[k].pnl += t._pnl || 0;
      if (t._result === 'win') m[k].w++;
    });
    return Object.values(m).sort((a, b) => b.pnl - a.pnl);
  }, [closed]);

  const pairStats = useMemo(() => {
    const m = {};
    closed.forEach(t => {
      const k = t._pair;
      if (!m[k]) m[k] = { pair: k, t: 0, w: 0, pnl: 0 };
      m[k].t++; m[k].pnl += t._pnl || 0;
      if (t._result === 'win') m[k].w++;
    });
    return Object.values(m).sort((a, b) => b.pnl - a.pnl);
  }, [closed]);

  const longs  = useMemo(() => closed.filter(t => t._dir === 'LONG'),  [closed]);
  const shorts = useMemo(() => closed.filter(t => t._dir === 'SHORT'), [closed]);

  const weeklyPnl = useMemo(() => {
    const start = new Date(); start.setDate(start.getDate() - start.getDay() + 1); start.setHours(0,0,0,0);
    return closed.filter(t => t._closedAt && new Date(t._closedAt) >= start).reduce((s, t) => s + (t._pnl || 0), 0);
  }, [closed]);

  const filteredTrades = useMemo(() => {
    let list = [...trades];
    if (filter === 'win')  list = list.filter(t => t._result === 'win');
    else if (filter === 'loss') list = list.filter(t => t._result === 'loss');
    else if (filter === 'be')   list = list.filter(t => t._result === 'be');
    else if (filter === 'open') list = list.filter(t => t._result === 'open');
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t => t._pair.toLowerCase().includes(q) || t._strategy.toLowerCase().includes(q));
    }
    return list.sort((a, b) => new Date(b._openedAt || 0) - new Date(a._openedAt || 0));
  }, [trades, filter, search]);

  const fmtPf = v => v === Infinity ? '∞' : v.toFixed(2);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '12px 14px', maxWidth: 560, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: '#f8fafc' }}>Trading Journal</div>
          <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>
            {trades.length} trades logged
            {lastSync && <span> · auto {lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        </div>
        {closed.length > 0 && (
          <div style={{ fontSize: 10, color: '#475569', textAlign: 'right', marginTop: 2 }}>
            {open.length > 0 && <div style={{ color: '#38bdf8', fontWeight: 600 }}>{open.length} open</div>}
            <div>Up to date — {closed.length} total closed</div>
          </div>
        )}
        <button onClick={load} disabled={loading}
          style={{ padding: '7px 14px', borderRadius: 8, background: '#1e293b', border: '1px solid #334155', color: loading ? '#475569' : '#94a3b8', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>
          {loading ? '⟳' : '⟳ Sync'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#450a0a', border: '1px solid #b91c1c', borderRadius: 6, padding: '8px 12px', marginBottom: 12, color: '#fca5a5', fontSize: 11 }}>{error}</div>
      )}
      {!isGithubConfigured() && (
        <div style={{ background: '#1e293b', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 11, color: '#f59e0b', textAlign: 'center' }}>
          GitHub token required — set in Strategy tab
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 16, background: '#1e293b', borderRadius: 10, padding: 3 }}>
        {[['overview','Overview'],['log','Trade Log'],['performance','Performance']].map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)}
            style={{ flex: 1, padding: '7px 4px', borderRadius: 8, fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: tab === v ? '#0f172a' : 'transparent', color: tab === v ? '#f8fafc' : '#64748b' }}>
            {l}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ─────────────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 4 }}>

            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Total Trades</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: '#f8fafc' }}>{closed.length}</div>
              <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>{wins.length}W · {losses.length}L · {bes.length}BE</div>
            </div>

            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Win Rate</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: closed.length ? (winRate >= 50 ? '#22c55e' : '#ef4444') : '#64748b' }}>
                {closed.length ? `${winRate.toFixed(1)}%` : '—'}
              </div>
              <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>{wins.length}W / {losses.length}L (excl. BE)</div>
            </div>

            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Total PnL</div>
              <div style={{ fontSize: 24, fontWeight: 900, color: closed.length ? pnlColor(totalPnl) : '#64748b' }}>
                {closed.length ? $(totalPnl) : '—'}
              </div>
              {closed.length > 0 && (
                <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>+${gProfit.toFixed(2)} / -${gLoss.toFixed(2)}</div>
              )}
            </div>

            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Profit Factor</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: pf >= 1.5 ? '#22c55e' : pf >= 1 ? '#f59e0b' : '#ef4444' }}>
                {closed.length ? fmtPf(pf) : '—'}
              </div>
              {closed.length > 0 && avgLoss > 0 && (
                <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>Avg W ${avgWin.toFixed(2)} / L ${avgLoss.toFixed(2)}</div>
              )}
            </div>

            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Avg R</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: avgR != null ? pnlColor(avgR) : '#64748b' }}>
                {avgR != null ? `${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R` : '—'}
              </div>
              <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>{rrTrades.length} trades with R data</div>
            </div>

            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Max Drawdown</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: maxDrawdown > 0 ? '#ef4444' : '#64748b' }}>
                {closed.length ? `$${maxDrawdown.toFixed(2)}` : '—'}
              </div>
            </div>

            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Avg Win</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: '#22c55e' }}>{wins.length ? `$${avgWin.toFixed(2)}` : '—'}</div>
              <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>{wins.length} winning trades</div>
            </div>

            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Current Streak</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: streak.type === 'win' ? '#22c55e' : streak.type === 'loss' ? '#ef4444' : '#64748b' }}>
                {streak.count > 0 ? `${streak.type === 'win' ? 'W' : streak.type === 'loss' ? 'L' : 'BE'}${streak.count}` : '—'}
              </div>
              {streak.count > 1 && <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>{streak.count} in a row</div>}
            </div>
          </div>

          {closed.length > 0 && <MonthCalendar trades={closed}/>}
          {closed.length > 1  && <EquityCurve   trades={closed}/>}

          {/* Session cards */}
          {closed.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc', marginBottom: 10 }}>Performance by Session</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { key: 'asian',   label: 'Asia',     color: '#fbbf24' },
                  { key: 'london',  label: 'London',   color: '#38bdf8' },
                  { key: 'newyork', label: 'New York', color: '#34d399' },
                  { key: 'other',   label: 'Other',    color: '#a78bfa' },
                ].map(({ key, label, color }) => {
                  const s = sessStats[key];
                  const wr = s.t > 0 ? Math.round(s.w / s.t * 100) : 0;
                  return (
                    <div key={key} style={{ background: '#1e293b', borderRadius: 10, padding: '12px 14px', borderTop: `3px solid ${color}` }}>
                      <div style={{ fontSize: 11, color, fontWeight: 700, marginBottom: 4 }}>{label}</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#f8fafc' }}>{s.t} trades</div>
                      <div style={{ fontSize: 10, color: '#64748b', margin: '3px 0' }}>{s.t > 0 ? `${wr}% WR` : 'No trades'}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: s.t > 0 ? pnlColor(s.pnl) : '#334155' }}>
                        {s.t > 0 ? $(s.pnl) : '—'}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Open positions */}
          {open.length > 0 && (
            <div style={{ marginTop: 14, background: '#0c4a6e22', border: '1px solid #0ea5e933', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8', marginBottom: 10 }}>
                {open.length} Open Position{open.length !== 1 ? 's' : ''}
              </div>
              {open.map((t, i) => <TradeCard key={t.id || i} t={t}/>)}
            </div>
          )}

          {trades.length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#475569', fontSize: 12 }}>
              No trades yet — run the VPS bot or place trades via the app
            </div>
          )}
        </>
      )}

      {/* ── TRADE LOG ────────────────────────────────────────────────────── */}
      {tab === 'log' && (
        <>
          <input
            placeholder="Search pair or strategy..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 8, padding: '9px 14px', fontSize: 12, marginBottom: 10, boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto', paddingBottom: 2 }}>
            {[
              ['all',  `All (${trades.length})`],
              ['win',  `Win (${wins.length})`],
              ['loss', `Loss (${losses.length})`],
              ['be',   `BE (${bes.length})`],
              ['open', `Open`],
            ].map(([v, l]) => (
              <button key={v} onClick={() => setFilter(v)}
                style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none',
                  background: filter === v ? '#00d4aa' : '#1e293b', color: filter === v ? '#080c14' : '#94a3b8' }}>
                {l}
              </button>
            ))}
          </div>
          {filteredTrades.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#475569', fontSize: 12 }}>No trades match</div>
          ) : (
            filteredTrades.map((t, i) => <TradeCard key={t.id || i} t={t}/>)
          )}
        </>
      )}

      {/* ── PERFORMANCE ──────────────────────────────────────────────────── */}
      {tab === 'performance' && (
        <>
          {/* Strategy Performance */}
          {stratStats.length > 0 && (
            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc', marginBottom: 12 }}>
                Strategy Performance <span style={{ fontSize: 11, color: '#475569', fontWeight: 400 }}>{stratStats.length}</span>
              </div>
              {stratStats.map(s => (
                <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid #0f172a' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                    <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>{s.t} trades · {s.t ? Math.round(s.w/s.t*100) : 0}% WR</div>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: pnlColor(s.pnl), minWidth: 60, textAlign: 'right' }}>{$(s.pnl)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Performance by Pair */}
          {pairStats.length > 0 && (
            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc', marginBottom: 12 }}>
                Performance by Pair <span style={{ fontSize: 11, color: '#475569', fontWeight: 400 }}>{pairStats.length}</span>
              </div>
              {pairStats.slice(0, 20).map(s => (
                <div key={s.pair} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #0f172a' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', minWidth: 72 }}>{s.pair}</span>
                  <span style={{ fontSize: 10, color: '#475569', minWidth: 24 }}>{s.t}T</span>
                  <span style={{ fontSize: 10, color: s.w/s.t >= 0.5 ? '#22c55e' : '#ef4444', minWidth: 30 }}>{Math.round(s.w/s.t*100)}%</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ height: 4, borderRadius: 2, background: '#0f172a', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${s.w/s.t*100}%`, background: s.w/s.t >= 0.5 ? '#22c55e' : '#ef4444', borderRadius: 2 }}/>
                    </div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: pnlColor(s.pnl), minWidth: 58, textAlign: 'right' }}>{$(s.pnl)}</span>
                </div>
              ))}
              {pairStats.length > 20 && (
                <div style={{ fontSize: 10, color: '#334155', textAlign: 'center', marginTop: 8 }}>+{pairStats.length - 20} more pairs</div>
              )}
            </div>
          )}

          {/* Long vs Short */}
          {closed.length > 0 && (
            <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc', marginBottom: 12 }}>Long vs Short Performance</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { label: 'LONG',  list: longs,  color: '#22c55e', bg: '#14532d22' },
                  { label: 'SHORT', list: shorts, color: '#ef4444', bg: '#450a0a22' },
                ].map(({ label, list, color, bg }) => {
                  const w = list.filter(t => t._result === 'win').length;
                  const p = list.reduce((s, t) => s + (t._pnl || 0), 0);
                  return (
                    <div key={label} style={{ background: bg, border: `1px solid ${color}33`, borderRadius: 8, padding: '12px 14px' }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color, marginBottom: 10 }}>{label}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Trades <span style={{ color: '#e2e8f0', fontWeight: 600, float: 'right' }}>{list.length}</span></div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Win Rate <span style={{ color: list.length && w/list.length >= 0.5 ? '#22c55e' : '#ef4444', fontWeight: 600, float: 'right' }}>{list.length ? `${Math.round(w/list.length*100)}%` : '—'}</span></div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>W / L <span style={{ color: '#e2e8f0', fontWeight: 600, float: 'right' }}>{w}W / {list.length - w}L</span></div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>Total P&amp;L <span style={{ color: pnlColor(p), fontWeight: 700, float: 'right' }}>{$(p)}</span></div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Weekly Review */}
          <div style={{ background: '#1e293b', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc' }}>Weekly Review</div>
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>Mon – Sun · this week</div>
              </div>
              <div style={{ fontSize: 20, fontWeight: 900, color: pnlColor(weeklyPnl) }}>{$(weeklyPnl)}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

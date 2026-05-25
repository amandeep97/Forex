import { useState, useEffect, useCallback } from 'react';
import { ghRead, ghWrite, isGithubConfigured } from '../utils/githubSync';
import BotConfig from './BotConfig';

// ── OANDA helpers ─────────────────────────────────────────────────────────────
const oandaBase = (env) =>
  env === 'live'
    ? 'https://api-fxtrade.oanda.com/v3'
    : 'https://api-fxpractice.oanda.com/v3';

async function fetchOandaCandles(apiKey, env, instrument, count = 100) {
  const res = await fetch(
    `${oandaBase(env)}/instruments/${instrument}/candles?granularity=H1&count=${count}&price=M`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.errorMessage || `OANDA ${res.status}`);
  }
  const { candles } = await res.json();
  return candles.filter(c => c.complete).map(c => ({
    t: c.time,
    o: parseFloat(c.mid.o), h: parseFloat(c.mid.h),
    l: parseFloat(c.mid.l), c: parseFloat(c.mid.c),
    v: c.volume,
  }));
}

function analyzeCandles(candles) {
  if (candles.length < 20) return null;
  const n = candles.length;
  let atrSum = 0;
  for (let i = n - 14; i < n; i++) atrSum += candles[i].h - candles[i].l;
  const atr = atrSum / 14;
  const cp  = candles[n - 1].c;
  const win = candles.slice(Math.max(0, n - 50));
  let sH = -Infinity, sL = Infinity;
  for (let i = 2; i < win.length - 2; i++) {
    if (win[i].h > win[i-1].h && win[i].h > win[i-2].h && win[i].h > win[i+1].h && win[i].h > win[i+2].h) sH = Math.max(sH, win[i].h);
    if (win[i].l < win[i-1].l && win[i].l < win[i-2].l && win[i].l < win[i+1].l && win[i].l < win[i+2].l) sL = Math.min(sL, win[i].l);
  }
  if (sH === -Infinity) sH = Math.max(...win.map(c => c.h));
  if (sL === Infinity)  sL = Math.min(...win.map(c => c.l));
  const h6  = candles.slice(n - 6).map(c => c.h);
  const structure = h6[5] > h6[3] && h6[3] > h6[1] ? 'bullish' : h6[5] < h6[3] && h6[3] < h6[1] ? 'bearish' : 'ranging';
  if (structure === 'ranging') return { dir: null, structure, cp, atr };
  const dir   = structure === 'bullish' ? 'LONG' : 'SHORT';
  const sl    = dir === 'LONG' ? sL - atr * 0.5 : sH + atr * 0.5;
  const dist  = Math.abs(cp - sl);
  if (dist <= 0) return null;
  const tp = dir === 'LONG' ? cp + dist * 2 : cp - dist * 2;
  return { dir, structure, cp, sl, tp, rr: (Math.abs(tp - cp) / dist).toFixed(1), atr };
}

// ── Shared ────────────────────────────────────────────────────────────────────
function Toggle({ checked, onChange }) {
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{ width: 44, height: 24, borderRadius: 12, cursor: 'pointer', position: 'relative', background: checked ? '#2563eb' : '#334155', transition: 'background 0.2s', flexShrink: 0 }}
    >
      <div style={{ position: 'absolute', top: 2, left: checked ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
    </div>
  );
}

const INP = { background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 6, padding: '6px 10px', fontSize: 12 };
const BTN = (extra) => ({ border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 12, cursor: 'pointer', fontWeight: 600, ...extra });
const CARD = { background: '#1e293b', borderRadius: 10, padding: 16, border: '1px solid #334155', marginBottom: 12 };
const SECTION = { fontSize: 11, fontWeight: 600, color: '#64748b', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 };

const APP_PAIRS = ['EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','NZD_USD','USD_CAD','XAU_USD','GBP_JPY','EUR_JPY'];
function dp(pair) { return pair?.includes('JPY') ? 3 : pair?.includes('XAU') ? 2 : 5; }
function fmtPx(v, pair) { return v != null ? Number(v).toFixed(dp(pair)) : '—'; }
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'; }

// ── Connect Exchange tab ──────────────────────────────────────────────────────
function ConnectTab({ onLog }) {
  const [apiKey,    setApiKey]    = useState(() => localStorage.getItem('oanda_key')  || '');
  const [accountId, setAccountId] = useState(() => localStorage.getItem('oanda_acct') || '');
  const [env,       setEnv]       = useState(() => localStorage.getItem('oanda_env')  || 'practice');
  const [connected, setConnected] = useState(() => !!localStorage.getItem('oanda_key'));
  const [acctInfo,  setAcctInfo]  = useState(null);
  const [pair,      setPair]      = useState('EUR_USD');
  const [signal,    setSignal]    = useState(null);
  const [editEntry, setEditEntry] = useState('');
  const [editSL,    setEditSL]    = useState('');
  const [editTP,    setEditTP]    = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [placing,   setPlacing]   = useState(false);
  const [connMsg,   setConnMsg]   = useState('');
  const [tradeMsg,  setTradeMsg]  = useState('');
  const [connErr,   setConnErr]   = useState('');
  const [tradeErr,  setTradeErr]  = useState('');

  const connect = async () => {
    if (!apiKey || !accountId) { setConnErr('Enter API key and Account ID'); return; }
    setConnErr(''); setConnMsg('Saving…');
    // Save credentials immediately — verify by fetching a price quote (no account permission needed)
    localStorage.setItem('oanda_key', apiKey);
    localStorage.setItem('oanda_acct', accountId);
    localStorage.setItem('oanda_env', env);
    try {
      const res = await fetch(
        `${oandaBase(env)}/instruments/EUR_USD/candles?granularity=M1&count=1&price=M`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      if (!res.ok) throw new Error(`OANDA ${res.status}`);
      setConnected(true); setConnMsg('');
      setAcctInfo({ env });
      onLog?.('SUCCESS', `Connected to OANDA ${env} — credentials saved`);
    } catch (e) {
      setConnErr(e.message); setConnMsg('');
    }
  };

  const analyze = async () => {
    if (!apiKey) { setTradeErr('Enter your OANDA API key and click Connect first'); return; }
    setAnalyzing(true); setTradeErr(''); setSignal(null);
    try {
      const candles = await fetchOandaCandles(apiKey, env, pair);
      const sig = analyzeCandles(candles);
      if (!sig?.dir) {
        setTradeErr('Market ranging — no clear SMC signal on H1');
      } else {
        setSignal(sig);
        const d = dp(pair);
        setEditEntry(sig.cp.toFixed(d)); setEditSL(sig.sl.toFixed(d)); setEditTP(sig.tp.toFixed(d));
        onLog?.('INFO', `Signal: ${sig.dir} ${pair.replace('_','/')} · ${sig.structure} · R:R 1:${sig.rr}`);
      }
    } catch (e) { setTradeErr(e.message); }
    finally { setAnalyzing(false); }
  };

  const placeOrder = async () => {
    if (!signal || !apiKey || !accountId) return;
    setPlacing(true); setTradeErr('');
    try {
      const sl = parseFloat(editSL), tp = parseFloat(editTP), entry = parseFloat(editEntry);
      if (isNaN(sl) || isNaN(tp)) throw new Error('Invalid SL or TP');
      const d = dp(pair);
      const units = signal.dir === 'LONG' ? '1000' : '-1000';
      const res = await fetch(`${oandaBase(env)}/accounts/${accountId}/orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: { type: 'MARKET', instrument: pair, units, stopLossOnFill: { price: sl.toFixed(d) }, takeProfitOnFill: { price: tp.toFixed(d) } } }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.errorMessage || `OANDA ${res.status}`);
      const tradeId = json.orderFillTransaction?.tradeOpened?.tradeID || json.relatedTransactionIDs?.[0] || '—';
      // Log trade to GitHub
      try {
        const ghData = await ghRead('bot/trades.json');
        const log = ghData?.content?.trades || [];
        log.push({ id: `app_${Date.now()}`, source: 'app_bot', pair, direction: signal.dir, entryPrice: entry, slPrice: sl, tpPrice: tp, units: parseInt(units), oandaTradeId: tradeId, openTime: new Date().toISOString(), status: 'OPEN', structure: signal.structure, rr: parseFloat(signal.rr) });
        await ghWrite('bot/trades.json', { trades: log }, `App bot: ${signal.dir} ${pair}`, ghData?.sha || null);
      } catch (logErr) { console.warn('Trade log:', logErr.message); }
      onLog?.('TRADE', `Placing ${signal.dir} ${pair.replace('_','/')} @ ${editEntry} | SL: ${editSL} | TP: ${editTP}`);
      onLog?.('SUCCESS', `Order confirmed — Trade ID: ${tradeId}`);
      setTradeMsg(`Order placed — ID: ${tradeId}`);
      setSignal(null);
      setTimeout(() => setTradeMsg(''), 5000);
    } catch (e) {
      setTradeErr(e.message);
      onLog?.('ERROR', e.message);
    } finally { setPlacing(false); }
  };

  return (
    <div style={{ padding: 16 }}>
      {/* OANDA connection */}
      <div style={{ ...CARD }}>
        <div style={SECTION}>OANDA Connection</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>API Key</div>
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Bearer token…" style={{ ...INP, width: 180 }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>Account ID</div>
            <input value={accountId} onChange={e => setAccountId(e.target.value)} placeholder="001-001-…" style={{ ...INP, width: 140 }} />
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['practice','live'].map(e => (
              <button key={e} onClick={() => setEnv(e)} style={{ background: env===e ? '#334155' : 'transparent', border: `1px solid ${env===e ? '#475569' : '#1e293b'}`, color: env===e ? '#f8fafc' : '#64748b', borderRadius: 6, padding: '6px 10px', fontSize: 11, cursor: 'pointer', textTransform: 'capitalize' }}>{e}</button>
            ))}
          </div>
          <button onClick={connect} style={BTN({ background: connected ? '#166534' : '#1d4ed8', color: '#fff' })}>
            {connected ? '● Connected' : 'Connect'}
          </button>
        </div>
        {connected && (
          <div style={{ display: 'flex', gap: 16, fontSize: 12, alignItems: 'center' }}>
            <span style={{ color: '#22c55e', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
              Connected · {env}
            </span>
            <span style={{ color: '#64748b', fontFamily: 'monospace', fontSize: 11 }}>{accountId}</span>
          </div>
        )}
        {connErr && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>{connErr}</div>}
        {connMsg && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>{connMsg}</div>}
      </div>

      {/* Manual trade */}
      <div style={{ ...CARD }}>
        <div style={SECTION}>Manual SMC Trade</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <select value={pair} onChange={e => { setPair(e.target.value); setSignal(null); setTradeErr(''); }} style={INP}>
            {APP_PAIRS.map(p => <option key={p} value={p}>{p.replace('_','/')}</option>)}
          </select>
          <button onClick={analyze} disabled={analyzing} style={BTN({ background: '#0ea5e9', color: '#fff' })}>
            {analyzing ? 'Analyzing…' : 'Analyze H1'}
          </button>
          {tradeMsg && <span style={{ fontSize: 11, color: '#22c55e' }}>{tradeMsg}</span>}
          {!signal && tradeErr && <span style={{ fontSize: 11, color: '#ef4444' }}>{tradeErr}</span>}
        </div>
        {signal && (
          <div style={{ background: '#0f172a', borderRadius: 8, padding: 14, border: `1px solid ${signal.dir==='LONG'?'#166534':'#7f1d1d'}` }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: signal.dir==='LONG' ? '#22c55e' : '#ef4444' }}>
                {signal.dir==='LONG' ? '▲ LONG' : '▼ SHORT'}
              </span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{pair.replace('_','/')} · H1 · {signal.structure}</span>
              <span style={{ fontSize: 11, color: '#a78bfa', marginLeft: 'auto' }}>R:R 1:{signal.rr}</span>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {[{l:'Entry',v:editEntry,s:setEditEntry,c:'#94a3b8'},{l:'Stop Loss',v:editSL,s:setEditSL,c:'#ef4444'},{l:'Take Profit',v:editTP,s:setEditTP,c:'#22c55e'}].map(({l,v,s,c}) => (
                <div key={l}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>{l}</div>
                  <input value={v} onChange={e => s(e.target.value)} style={{ background: '#1e293b', border: `1px solid ${c}55`, color: c, borderRadius: 6, padding: '6px 10px', fontSize: 12, width: 110, fontFamily: 'monospace' }} />
                </div>
              ))}
              <button onClick={placeOrder} disabled={placing} style={BTN({ background: signal.dir==='LONG'?'#166534':'#7f1d1d', border: `1px solid ${signal.dir==='LONG'?'#22c55e':'#ef4444'}`, color: signal.dir==='LONG'?'#22c55e':'#ef4444' })}>
                {placing ? 'Placing…' : `Place ${signal.dir}`}
              </button>
              <button onClick={() => setSignal(null)} style={{ background: 'transparent', border: '1px solid #334155', color: '#64748b', borderRadius: 6, padding: '7px 12px', fontSize: 11, cursor: 'pointer' }}>Cancel</button>
            </div>
            {tradeErr && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{tradeErr}</div>}
          </div>
        )}
      </div>
    </div>
  );
}


// ── Positions tab ─────────────────────────────────────────────────────────────
function PositionsTab({ onLog }) {
  const [trades,  setTrades]  = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [closing, setClosing] = useState(null);

  useEffect(() => {
    async function load() {
      setLoading(true); setError('');
      try {
        const data = await ghRead('bot/trades.json');
        setTrades(data?.content?.trades || []);
      } catch (e) { setError(e.message); }
      finally { setLoading(false); }
    }
    load();
  }, []);

  const open = trades.filter(t => t.status === 'OPEN' || t.status === 'open');
  const closed = trades.filter(t => t.status !== 'OPEN' && t.status !== 'open');

  const markClosed = async (id) => {
    setClosing(id);
    try {
      const data = await ghRead('bot/trades.json');
      const updated = (data?.content?.trades || []).map(t =>
        t.id === id ? { ...t, status: 'CLOSED', closeTime: new Date().toISOString() } : t
      );
      await ghWrite('bot/trades.json', { trades: updated }, `Close trade ${id}`, data?.sha || null);
      setTrades(updated);
      onLog?.('INFO', `Trade ${id} marked closed`);
    } catch (e) { setError(e.message); }
    finally { setClosing(null); }
  };

  const clearClosed = async () => {
    try {
      const data = await ghRead('bot/trades.json');
      const cleaned = (data?.content?.trades || []).filter(t => t.status !== 'CLOSED' && t.status !== 'closed');
      await ghWrite('bot/trades.json', { trades: cleaned }, 'Clear closed trades', data?.sha || null);
      setTrades(cleaned);
    } catch (e) { setError(e.message); }
  };

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: '#f8fafc', fontSize: 15 }}>Open ({open.length})</span>
        <button onClick={() => {
          setLoading(true);
          ghRead('bot/trades.json').then(d => { setTrades(d?.content?.trades || []); setLoading(false); }).catch(e => { setError(e.message); setLoading(false); });
        }} style={{ background: '#334155', border: 'none', color: '#94a3b8', padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
          Sync OANDA
        </button>
        {closed.length > 0 && (
          <button onClick={clearClosed} style={{ background: 'transparent', border: '1px solid #334155', color: '#64748b', padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
            Clear Closed ({closed.length})
          </button>
        )}
        {loading && <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>Loading…</span>}
      </div>

      {error && <div style={{ background: '#450a0a', color: '#fca5a5', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {open.length === 0 && !loading ? (
        <div style={{ textAlign: 'center', color: '#475569', padding: '48px 0', fontSize: 13 }}>No open positions</div>
      ) : open.map(t => {
        const isLong = t.direction === 'LONG' || t.direction === 'long';
        const entry  = t.entryPrice ?? t.entry;
        const sl     = t.slPrice    ?? t.sl;
        const tp     = t.tpPrice    ?? t.tp;
        const rr     = t.rr ? `1:${Number(t.rr).toFixed(1)}` : '—';
        const oandaId = t.oandaTradeId || t.oandaId || t.id;
        return (
          <div key={t.id} style={{ background: '#1e293b', borderRadius: 10, padding: 14, marginBottom: 10, border: `1px solid ${isLong ? '#1e3a5f' : '#3b0764'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc' }}>
                {isLong ? '↗' : '↘'} {(t.pair || '').replace('_', '/')}
              </span>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: isLong?'#14532d':'#450a0a', color: isLong?'#4ade80':'#f87171', fontWeight: 700 }}>
                {t.direction?.toUpperCase?.() || 'LONG'}
              </span>
              <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#0f172a', color: '#38bdf8' }}>OANDA</span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: '#a78bfa', fontWeight: 600 }}>R:R {rr}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 }}>
              {[{l:'Entry',v:fmtPx(entry,t.pair),c:'#e2e8f0'},{l:'Current',v:'—',c:'#94a3b8'},{l:'SL',v:fmtPx(sl,t.pair),c:'#ef4444'},{l:'TP',v:fmtPx(tp,t.pair),c:'#22c55e'}].map(({l,v,c}) => (
                <div key={l} style={{ background: '#0f172a', borderRadius: 6, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#475569', marginBottom: 3 }}>{l}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: c, fontFamily: 'monospace' }}>{v}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: '#475569', marginBottom: 10 }}>
              {t.source || 'vps_bot'} · Opened {fmtTime(t.openTime || t.openedAt)} · ID: {oandaId}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => markClosed(t.id)} disabled={closing===t.id}
                style={{ background: '#991b1b', border: 'none', color: '#fff', borderRadius: 6, padding: '6px 14px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
                {closing===t.id ? '…' : '✓ Mark Closed'}
              </button>
              <button style={{ background: '#166534', border: 'none', color: '#4ade80', borderRadius: 6, padding: '6px 14px', fontSize: 11, cursor: 'pointer' }}>
                Move BE
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── VPS Bot tab ───────────────────────────────────────────────────────────────
function VPSBotTab({ onLog }) {
  const [botStatus, setBotStatus]   = useState(null);
  const [loading,   setLoading]     = useState(false);
  const [saving,    setSaving]      = useState(false);
  const [pat,       setPat]         = useState(() => localStorage.getItem('github_pat') || '');
  const [msg,       setMsg]         = useState('');
  const [err,       setErr]         = useState('');

  const refreshStatus = async () => {
    setLoading(true); setErr('');
    try {
      const [stratData, ctrlData] = await Promise.all([
        ghRead('bot/strategy.json').catch(() => null),
        ghRead('bot/vps-control.json').catch(() => null),
      ]);
      const gs = stratData?.content?.globalSettings || {};
      setBotStatus({
        lastRunAt: gs.lastRunAt,
        lastError: gs.lastError,
        control:   ctrlData?.content?.command || 'running',
      });
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const sendControl = async (command) => {
    setSaving(true); setErr('');
    try {
      const existing = await ghRead('bot/vps-control.json').catch(() => null);
      await ghWrite('bot/vps-control.json', { command, sentAt: new Date().toISOString() }, `VPS control: ${command}`, existing?.sha || null);
      setBotStatus(s => ({ ...s, control: command }));
      setMsg(`Command "${command}" sent — bot picks up on next cycle`);
      onLog?.('INFO', `VPS control: ${command}`);
      setTimeout(() => setMsg(''), 4000);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const savePat = () => {
    localStorage.setItem('github_pat', pat);
    setMsg('GitHub token saved');
    setTimeout(() => setMsg(''), 2000);
  };

  const ctrlColor = { running: '#22c55e', paused: '#f59e0b', stopped: '#ef4444' }[botStatus?.control] || '#475569';

  return (
    <div style={{ padding: 16 }}>
      {/* Bot info */}
      <div style={{ ...CARD, display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 32 }}>🤖</span>
        <div>
          <div style={{ fontWeight: 700, color: '#f8fafc', fontSize: 14, marginBottom: 4 }}>VPS Auto-Trade Bot</div>
          <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
            Runs 24/7 on your VPS — trades even when your browser is off.<br />
            Reads active strategies from GitHub, fetches live OANDA candles, places orders automatically.
          </div>
        </div>
      </div>

      {/* Bot control */}
      <div style={{ ...CARD }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={SECTION}>Bot Control</div>
          <button onClick={refreshStatus} disabled={loading}
            style={{ background: '#334155', border: 'none', color: '#94a3b8', padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
            {loading ? 'Loading…' : 'Refresh Status'}
          </button>
        </div>
        <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 14 }}>
          Status:{' '}
          {botStatus
            ? <strong style={{ color: ctrlColor }}>
                {botStatus.control === 'running' ? 'Running' : botStatus.control === 'paused' ? 'Paused' : 'Stopped'}
                {botStatus.lastRunAt ? ` — last run ${new Date(botStatus.lastRunAt).toLocaleTimeString()}` : ''}
              </strong>
            : <span style={{ color: '#475569' }}>Unknown — click Refresh Status</span>
          }
        </div>
        {botStatus?.lastError && (
          <div style={{ background: '#450a0a', color: '#fca5a5', padding: '6px 12px', borderRadius: 6, fontSize: 11, marginBottom: 12 }}>
            Last error: {botStatus.lastError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button onClick={() => sendControl('running')} disabled={saving}
            style={BTN({ background: '#1d4ed8', color: '#fff' })}>▶ Resume</button>
          <button onClick={() => sendControl('paused')} disabled={saving}
            style={BTN({ background: '#92400e', color: '#fbbf24' })}>⏸ Pause</button>
          <button onClick={() => sendControl('stopped')} disabled={saving}
            style={BTN({ background: '#450a0a', color: '#ef4444' })}>⏹ Stop</button>
        </div>
        {msg && <div style={{ fontSize: 12, color: '#22c55e' }}>{msg}</div>}
        {err && <div style={{ fontSize: 12, color: '#ef4444' }}>{err}</div>}
        <div style={{ fontSize: 10, color: '#475569', marginTop: 10 }}>
          Writes <code style={{ background: '#0f172a', padding: '1px 5px', borderRadius: 3 }}>bot/vps-control.json</code> to GitHub — bot checks each cycle
        </div>
      </div>

      {/* GitHub PAT */}
      <div style={{ ...CARD }}>
        <div style={SECTION}>Step 1 — GitHub PAT (repo scope)</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10, lineHeight: 1.5 }}>
          The VPS bot reads <code style={{ background: '#0f172a', padding: '1px 5px', borderRadius: 3 }}>bot/strategy.json</code> from your repo.
          Set your PAT here so the browser app can also write strategies.
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input type="password" value={pat} onChange={e => setPat(e.target.value)} placeholder="ghp_xxx…"
            style={{ ...INP, flex: 1 }} />
          <button onClick={savePat} style={BTN({ background: '#1d4ed8', color: '#fff' })}>Save</button>
        </div>
        <div style={SECTION}>Step 2 — Deploy VPS Bot</div>
        {[
          { n:1, cmd: 'git clone https://github.com/amandeep97/Forex && cd Forex/vps-bot' },
          { n:2, cmd: 'npm install' },
          { n:3, cmd: 'cp .env.example .env  # fill OANDA_API_KEY, GITHUB_TOKEN, TELEGRAM_BOT_TOKEN' },
          { n:4, cmd: 'npm install -g pm2 && pm2 start ecosystem.config.js && pm2 save' },
        ].map(({ n, cmd }) => (
          <div key={n} style={{ background: '#0f172a', borderRadius: 6, padding: '8px 12px', marginBottom: 6, display: 'flex', gap: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#2563eb', minWidth: 16, paddingTop: 2 }}>{n}</span>
            <code style={{ fontSize: 11, color: '#94a3b8', wordBreak: 'break-all' }}>{cmd}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Log tab ───────────────────────────────────────────────────────────────────
const TAG_STYLE = {
  INFO:    { bg: '#1e3a5f', color: '#93c5fd' },
  SUCCESS: { bg: '#14532d', color: '#86efac' },
  ERROR:   { bg: '#450a0a', color: '#fca5a5' },
  TRADE:   { bg: '#1e1b4b', color: '#a5b4fc' },
};

function LogTab({ entries, onClear }) {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontWeight: 700, color: '#f8fafc', fontSize: 15 }}>Activity Log</span>
        <button onClick={onClear} style={{ background: '#991b1b', border: 'none', color: '#fff', borderRadius: 6, padding: '5px 14px', fontSize: 11, cursor: 'pointer' }}>Clear</button>
      </div>
      {entries.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#475569', padding: '48px 0' }}>No activity yet — connect OANDA or analyze a trade</div>
      ) : (
        <div style={{ background: '#1e293b', borderRadius: 10, overflow: 'hidden' }}>
          {[...entries].reverse().map((e, i) => {
            const s = TAG_STYLE[e.type] || TAG_STYLE.INFO;
            return (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 14px', borderBottom: '1px solid #0f172a' }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 3, background: s.bg, color: s.color, whiteSpace: 'nowrap', marginTop: 1 }}>{e.type}</span>
                <span style={{ flex: 1, fontSize: 12, color: '#cbd5e1' }}>{e.msg}</span>
                <span style={{ fontSize: 10, color: '#475569', whiteSpace: 'nowrap' }}>{new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main AutoTrading ──────────────────────────────────────────────────────────
export default function AutoTrading({ accountMode = 'demo' }) {
  const isReal = accountMode === 'real';
  const [activeTab,  setActiveTab]  = useState('connect');
  const [logEntries, setLogEntries] = useState([]);
  const [stratCount, setStratCount] = useState(0);
  const [posCount,   setPosCount]   = useState(0);

  const addLog = useCallback((type, msg) => {
    setLogEntries(prev => [...prev, { type, msg, ts: Date.now() }]);
  }, []);


  const TABS = [
    { id: 'connect',    label: 'Connect Exchange' },
    { id: 'config',     label: stratCount ? `Strategy Config (${stratCount})` : 'Strategy Config' },
    { id: 'positions',  label: posCount   ? `Positions (${posCount})`   : 'Positions' },
    { id: 'vpsbot',     label: 'VPS Bot' },
    { id: 'log',        label: logEntries.length ? `Log (${logEntries.length})` : 'Log' },
  ];

  return (
    <div style={{ background: '#0f172a', minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      {isReal && (
        <div style={{ background: '#7f1d1d', padding: '6px 20px', fontSize: 12, color: '#fca5a5' }}>
          ⚠️ Real Money Mode Active — trades execute with real funds
        </div>
      )}

      {/* Header */}
      <div style={{ padding: '16px 20px 0' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#f8fafc' }}>Auto Trading</h2>
        <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>Strategy-based auto-execution on OANDA</p>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', padding: '10px 20px 0', borderBottom: '2px solid #1e293b', overflowX: 'auto', gap: 2 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              background: activeTab === t.id ? '#2563eb' : 'transparent',
              border: 'none',
              color: activeTab === t.id ? '#fff' : '#64748b',
              padding: '8px 16px',
              borderRadius: activeTab === t.id ? '8px 8px 0 0' : '6px 6px 0 0',
              fontSize: 13,
              cursor: 'pointer',
              fontWeight: activeTab === t.id ? 600 : 400,
              whiteSpace: 'nowrap',
              transition: 'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {activeTab === 'connect'   && <ConnectTab   onLog={addLog} />}
        {activeTab === 'config'    && <BotConfig />}
        {activeTab === 'positions' && <PositionsTab onLog={addLog} />}
        {activeTab === 'vpsbot'    && <VPSBotTab    onLog={addLog} />}
        {activeTab === 'log'       && <LogTab entries={logEntries} onClear={() => setLogEntries([])} />}
      </div>
    </div>
  );
}

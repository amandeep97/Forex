import { useState } from 'react';
import { STRATEGIES, samplePositions, tradeHistory, SIGNALS, forexPairs } from '../data/forexData';
import { ghRead, ghWrite } from '../utils/githubSync';

// ── OANDA helpers (browser-direct) ───────────────────────────────────────────
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

  // ATR(14)
  let atrSum = 0;
  for (let i = n - 14; i < n; i++) atrSum += candles[i].h - candles[i].l;
  const atr = atrSum / 14;

  const cp = candles[n - 1].c;

  // Swing high/low over last 50
  const win = candles.slice(Math.max(0, n - 50));
  let sH = -Infinity, sL = Infinity;
  for (let i = 2; i < win.length - 2; i++) {
    if (win[i].h > win[i-1].h && win[i].h > win[i-2].h && win[i].h > win[i+1].h && win[i].h > win[i+2].h)
      sH = Math.max(sH, win[i].h);
    if (win[i].l < win[i-1].l && win[i].l < win[i-2].l && win[i].l < win[i+1].l && win[i].l < win[i+2].l)
      sL = Math.min(sL, win[i].l);
  }
  if (sH === -Infinity) sH = Math.max(...win.map(c => c.h));
  if (sL === Infinity)  sL = Math.min(...win.map(c => c.l));

  // Bias from last 6 candles (HH/HL = bullish, LL/LH = bearish)
  const last6 = candles.slice(n - 6);
  const hArr  = last6.map(c => c.h);
  const lArr  = last6.map(c => c.l);
  const structure =
    hArr[5] > hArr[3] && hArr[3] > hArr[1] ? 'bullish' :
    hArr[5] < hArr[3] && hArr[3] < hArr[1] ? 'bearish' : 'ranging';

  if (structure === 'ranging') return { dir: null, structure, cp, atr };

  const dir = structure === 'bullish' ? 'LONG' : 'SHORT';
  const slBuf = atr * 0.5;
  const sl    = dir === 'LONG' ? sL - slBuf : sH + slBuf;
  const dist  = Math.abs(cp - sl);
  if (dist <= 0) return null;
  const tp  = dir === 'LONG' ? cp + dist * 2 : cp - dist * 2;
  const rr  = (Math.abs(tp - cp) / dist).toFixed(1);

  return { dir, structure, cp, sl, tp, rr, atr };
}

// ── App Bot panel ─────────────────────────────────────────────────────────────
const APP_BOT_PAIRS = [
  'EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD',
  'NZD_USD','USD_CAD','XAU_USD','GBP_JPY','EUR_JPY',
];

function AppBotPanel() {
  const [apiKey,     setApiKey]     = useState(() => localStorage.getItem('oanda_key')  || '');
  const [accountId,  setAccountId]  = useState(() => localStorage.getItem('oanda_acct') || '');
  const [env,        setEnv]        = useState(() => localStorage.getItem('oanda_env')  || 'practice');
  const [pair,       setPair]       = useState('EUR_USD');
  const [signal,     setSignal]     = useState(null);
  const [editEntry,  setEditEntry]  = useState('');
  const [editSL,     setEditSL]     = useState('');
  const [editTP,     setEditTP]     = useState('');
  const [analyzing,  setAnalyzing]  = useState(false);
  const [placing,    setPlacing]    = useState(false);
  const [statusMsg,  setStatusMsg]  = useState('');
  const [errMsg,     setErrMsg]     = useState('');

  const saveCredentials = () => {
    localStorage.setItem('oanda_key',  apiKey);
    localStorage.setItem('oanda_acct', accountId);
    localStorage.setItem('oanda_env',  env);
    setStatusMsg('Credentials saved');
    setTimeout(() => setStatusMsg(''), 2000);
  };

  const analyze = async () => {
    if (!apiKey || !accountId) { setErrMsg('Enter OANDA credentials first'); return; }
    setAnalyzing(true); setErrMsg(''); setSignal(null);
    try {
      const candles = await fetchOandaCandles(apiKey, env, pair);
      const sig = analyzeCandles(candles);
      if (!sig || !sig.dir) {
        setErrMsg('Market ranging — no clear SMC signal on H1');
      } else {
        setSignal(sig);
        const dp = pair.includes('JPY') ? 3 : pair.includes('XAU') ? 2 : 5;
        setEditEntry(sig.cp.toFixed(dp));
        setEditSL(sig.sl.toFixed(dp));
        setEditTP(sig.tp.toFixed(dp));
      }
    } catch (e) {
      setErrMsg(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const placeOrder = async () => {
    if (!signal || !apiKey || !accountId) return;
    setPlacing(true); setErrMsg('');
    try {
      const entry = parseFloat(editEntry);
      const sl    = parseFloat(editSL);
      const tp    = parseFloat(editTP);
      if (isNaN(sl) || isNaN(tp)) throw new Error('Invalid SL or TP value');

      const dp    = pair.includes('JPY') ? 3 : pair.includes('XAU') ? 2 : 5;
      const units = signal.dir === 'LONG' ? '1000' : '-1000';

      const body = {
        order: {
          type: 'MARKET',
          instrument: pair,
          units,
          stopLossOnFill:   { price: sl.toFixed(dp) },
          takeProfitOnFill: { price: tp.toFixed(dp) },
        },
      };

      const res = await fetch(`${oandaBase(env)}/accounts/${accountId}/orders`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.errorMessage || `OANDA ${res.status}`);

      const tradeId = json.orderFillTransaction?.tradeOpened?.tradeID
        || json.relatedTransactionIDs?.[0]
        || '—';

      // Log to bot/trades.json via GitHub
      try {
        const ghData   = await ghRead('bot/trades.json');
        const tradeLog = ghData?.content?.trades || [];
        tradeLog.push({
          id:          `app_${Date.now()}`,
          source:      'app_bot',
          pair,
          direction:   signal.dir,
          entryPrice:  entry,
          slPrice:     sl,
          tpPrice:     tp,
          units:       parseInt(units),
          oandaTradeId: tradeId,
          openTime:    new Date().toISOString(),
          status:      'OPEN',
          structure:   signal.structure,
          rr:          parseFloat(signal.rr),
        });
        await ghWrite(
          'bot/trades.json',
          { trades: tradeLog },
          `App bot: ${signal.dir} ${pair}`,
          ghData?.sha || null
        );
      } catch (logErr) {
        console.warn('Trade log failed:', logErr.message);
      }

      setStatusMsg(`Order placed — Trade ID: ${tradeId}`);
      setSignal(null);
    } catch (e) {
      setErrMsg(e.message);
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, marginBottom: 16, border: '1px solid #334155' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc' }}>🤖 App Bot</span>
        <span style={{ fontSize: 10, color: '#64748b', background: '#0f172a', padding: '2px 8px', borderRadius: 4 }}>
          Manual SMC · OANDA Direct
        </span>
      </div>

      {/* Credentials row */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-end' }}>
        <div>
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>OANDA API Key</div>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="Bearer token…"
            style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 6, padding: '5px 10px', fontSize: 12, width: 180 }}
          />
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>Account ID</div>
          <input
            value={accountId}
            onChange={e => setAccountId(e.target.value)}
            placeholder="001-001-…"
            style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 6, padding: '5px 10px', fontSize: 12, width: 140 }}
          />
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {['practice', 'live'].map(e => (
            <button
              key={e}
              onClick={() => setEnv(e)}
              style={{
                background: env === e ? '#334155' : 'transparent',
                border: `1px solid ${env === e ? '#475569' : '#1e293b'}`,
                color: env === e ? '#f8fafc' : '#64748b',
                borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', textTransform: 'capitalize',
              }}
            >
              {e}
            </button>
          ))}
        </div>
        <button
          onClick={saveCredentials}
          style={{ background: '#1d4ed8', border: 'none', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 11, cursor: 'pointer' }}
        >
          Save
        </button>
      </div>

      {/* Pair + Analyze */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={pair}
          onChange={e => { setPair(e.target.value); setSignal(null); setErrMsg(''); }}
          style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 6, padding: '6px 10px', fontSize: 12 }}
        >
          {APP_BOT_PAIRS.map(p => (
            <option key={p} value={p}>{p.replace('_', '/')}</option>
          ))}
        </select>
        <button
          onClick={analyze}
          disabled={analyzing}
          style={{ background: '#0ea5e9', border: 'none', color: '#fff', borderRadius: 6, padding: '7px 16px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
        >
          {analyzing ? 'Analyzing…' : 'Analyze H1'}
        </button>
        {statusMsg && <span style={{ fontSize: 11, color: '#22c55e' }}>{statusMsg}</span>}
        {errMsg    && <span style={{ fontSize: 11, color: '#ef4444' }}>{errMsg}</span>}
      </div>

      {/* Signal card */}
      {signal && (
        <div style={{
          marginTop: 14, background: '#0f172a', borderRadius: 8, padding: 14,
          border: `1px solid ${signal.dir === 'LONG' ? '#166534' : '#7f1d1d'}`,
        }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: signal.dir === 'LONG' ? '#22c55e' : '#ef4444' }}>
              {signal.dir === 'LONG' ? '▲ LONG' : '▼ SHORT'}
            </span>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{pair.replace('_', '/')} · H1 · {signal.structure}</span>
            <span style={{ fontSize: 11, color: '#a78bfa' }}>R:R 1:{signal.rr}</span>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {[
              { label: 'Entry',       value: editEntry, setter: setEditEntry, color: '#94a3b8' },
              { label: 'Stop Loss',   value: editSL,    setter: setEditSL,    color: '#ef4444' },
              { label: 'Take Profit', value: editTP,    setter: setEditTP,    color: '#22c55e' },
            ].map(({ label, value, setter, color }) => (
              <div key={label}>
                <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>{label}</div>
                <input
                  value={value}
                  onChange={e => setter(e.target.value)}
                  style={{ background: '#1e293b', border: `1px solid ${color}55`, color, borderRadius: 6, padding: '5px 10px', fontSize: 12, width: 110, fontFamily: 'monospace' }}
                />
              </div>
            ))}
            <button
              onClick={placeOrder}
              disabled={placing}
              style={{
                background: signal.dir === 'LONG' ? '#166534' : '#7f1d1d',
                border: `1px solid ${signal.dir === 'LONG' ? '#22c55e' : '#ef4444'}`,
                color: signal.dir === 'LONG' ? '#22c55e' : '#ef4444',
                borderRadius: 6, padding: '8px 18px', fontSize: 12, cursor: 'pointer', fontWeight: 700,
              }}
            >
              {placing ? 'Placing…' : `Place ${signal.dir} Order`}
            </button>
            <button
              onClick={() => setSignal(null)}
              style={{ background: 'transparent', border: '1px solid #334155', color: '#64748b', borderRadius: 6, padding: '8px 12px', fontSize: 11, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Broker definitions ────────────────────────────────────────────────────────
const BROKERS = [
  {
    id: 'forexcom',
    name: 'Forex.com',
    logo: '🏦',
    tag: 'RECOMMENDED',
    tagColor: '#00d4aa',
    fields: 'both',     // supports login AND api
    url: 'forex.com',
  },
  {
    id: 'mt5',
    name: 'MetaTrader 5',
    logo: '📊',
    fields: 'mt',
    hint: 'Use your MT5 broker server, login and investor/trading password.',
  },
  {
    id: 'mt4',
    name: 'MetaTrader 4',
    logo: '📈',
    fields: 'mt',
    hint: 'Use your MT4 broker server, login and trading password.',
  },
  {
    id: 'ctrader',
    name: 'cTrader',
    logo: '🔷',
    fields: 'api',
    hint: 'Use your cTrader Open API credentials.',
  },
  {
    id: 'oanda',
    name: 'OANDA',
    logo: '🌐',
    fields: 'api',
    hint: 'Get your API token from OANDA → Manage API Access.',
  },
  {
    id: 'ib',
    name: 'Interactive Brokers',
    logo: '🏛️',
    fields: 'mt',
    hint: 'Requires TWS or IB Gateway running locally.',
  },
];

function BrokerPanel({ brokerState }) {
  const [selectedBroker, setSelectedBroker] = useState(BROKERS[0]);

  // Use lifted state from App so it persists across tab switches
  const env        = brokerState.env;
  const setEnv     = brokerState.setEnv;
  const authMethod = brokerState.authMethod;
  const setAuthMethod = brokerState.setAuthMethod;
  const connected  = brokerState.connected;
  const setConnected = (v) => {
    brokerState.setConnected(v);
    if (v) brokerState.setName(selectedBroker.name);
  };

  // Local form fields (these don't need to persist)
  const [username, setUsername]   = useState('');
  const [password, setPassword]   = useState('');
  const [server, setServer]       = useState('');
  const [apiKey, setApiKey]       = useState('');
  const [accountId, setAccountId] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const isBoth = selectedBroker.fields === 'both';
  const isApi  = selectedBroker.fields === 'api' || (isBoth && authMethod === 'api');
  const isMt   = selectedBroker.fields === 'mt';

  const canConnect = isApi
    ? apiKey.trim() && accountId.trim()
    : username.trim() && password.trim();

  const handleConnect = () => {
    if (!canConnect) return;
    setConnecting(true);
    setTimeout(() => { setConnecting(false); setConnected(true); setShowPicker(false); }, 2000);
  };

  const handleDisconnect = () => {
    brokerState.setConnected(false);
    brokerState.setName('');
    setUsername(''); setPassword(''); setServer('');
    setApiKey(''); setAccountId('');
  };

  const handleBrokerSelect = (b) => {
    setSelectedBroker(b);
    setAuthMethod('login');
    setShowPicker(false);
    setConnected(false);
    setUsername(''); setPassword(''); setServer('');
    setApiKey(''); setAccountId('');
  };

  return (
    <div className="broker-panel">
      <div className="panel-title" style={{ color: '#f97316' }}>
        ⚡ Broker Connection
        {connected && <span className="broker-connected-badge">● Connected</span>}
      </div>

      {/* Broker selector button */}
      <div className="broker-selector-btn" onClick={() => !connected && setShowPicker(p => !p)}>
        <span style={{ fontSize: 18 }}>{selectedBroker.logo}</span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>{selectedBroker.name}</span>
            {selectedBroker.tag && (
              <span className="broker-tag" style={{ borderColor: selectedBroker.tagColor, color: selectedBroker.tagColor }}>
                {selectedBroker.tag}
              </span>
            )}
          </div>
          {selectedBroker.url && (
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>{selectedBroker.url}</span>
          )}
        </div>
        {!connected && <span style={{ color: 'var(--text3)', fontSize: 11 }}>▾</span>}
      </div>

      {/* Broker picker dropdown */}
      {showPicker && (
        <div className="broker-picker">
          {BROKERS.map(b => (
            <div
              key={b.id}
              className={`broker-picker-item ${selectedBroker.id === b.id ? 'selected' : ''}`}
              onClick={() => handleBrokerSelect(b)}
            >
              <span style={{ fontSize: 16 }}>{b.logo}</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)' }}>{b.name}</div>
              </div>
              {b.tag && (
                <span className="broker-tag" style={{ marginLeft: 'auto', borderColor: b.tagColor, color: b.tagColor }}>
                  {b.tag}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {connected ? (
        <div className="broker-connected-info">
          <div className="broker-row"><span>Broker</span><strong>{selectedBroker.name}</strong></div>
          <div className="broker-row"><span>Mode</span><strong style={{ color: env === 'live' ? '#22c55e' : '#0ea5e9' }}>{env === 'live' ? '● Live' : '● Demo'}</strong></div>
          <div className="broker-row"><span>Auth</span><strong>{isApi ? 'API Key' : 'Login'}</strong></div>
          {isApi
            ? <div className="broker-row"><span>Account</span><strong>{accountId}</strong></div>
            : <div className="broker-row"><span>Username</span><strong>{username}</strong></div>
          }
          <div className="broker-row"><span>Status</span><strong style={{ color: '#22c55e' }}>● Active</strong></div>
          <button className="broker-disconnect-btn" onClick={handleDisconnect}>Disconnect</button>
        </div>
      ) : (
        <div className="broker-form">

          {/* Live / Demo environment toggle */}
          <div className="broker-env-row">
            <button className={`env-btn ${env === 'live' ? 'active' : ''}`} onClick={() => setEnv('live')}>Live</button>
            <button className={`env-btn ${env === 'demo' ? 'active' : ''}`} onClick={() => setEnv('demo')}>Demo</button>
          </div>

          {/* Login / API method toggle — shown only for Forex.com (both) */}
          {isBoth && (
            <div className="auth-method-row">
              <button
                className={`auth-method-btn ${authMethod === 'login' ? 'active' : ''}`}
                onClick={() => setAuthMethod('login')}
              >
                🔑 Login
              </button>
              <button
                className={`auth-method-btn ${authMethod === 'api' ? 'active' : ''}`}
                onClick={() => setAuthMethod('api')}
              >
                ⚙️ API Key
              </button>
            </div>
          )}

          {/* Fields */}
          {isApi ? (
            <>
              <div className="field">
                <label className="field-label">API Key</label>
                <input className="field-input" placeholder="Paste your API key…" value={apiKey} onChange={e => setApiKey(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">Account ID</label>
                <input className="field-input" placeholder="e.g. 001-001-1234567-001" value={accountId} onChange={e => setAccountId(e.target.value)} />
              </div>
              <p className="broker-hint">Get API Key from Forex.com → My Account → API Access.</p>
            </>
          ) : (
            <>
              <div className="field">
                <label className="field-label">Username / Email</label>
                <input className="field-input" placeholder="Your Forex.com username" value={username} onChange={e => setUsername(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">Password</label>
                <input className="field-input" type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
              </div>
              {isMt && (
                <div className="field">
                  <label className="field-label">Server</label>
                  <input className="field-input" placeholder="e.g. Forex-Live01" value={server} onChange={e => setServer(e.target.value)} />
                </div>
              )}
              <p className="broker-hint">Use your Forex.com account login credentials.</p>
            </>
          )}

          <button className="broker-connect-btn" onClick={handleConnect} disabled={connecting || !canConnect}>
            {connecting ? 'Connecting…' : `Connect to ${selectedBroker.name}`}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Toggle switch ─────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, label }) {
  return (
    <label className="toggle-wrap">
      <div className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
        <div className="toggle-knob" />
      </div>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}

// ── Status dot ────────────────────────────────────────────────────────────────
function StatusDot({ active }) {
  return (
    <span className={`status-dot ${active ? 'active' : ''}`} />
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <div className="stat-card">
      <div className="stat-value" style={color ? { color } : {}}>{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// ── Position row ──────────────────────────────────────────────────────────────
function PositionRow({ pos, onClose }) {
  return (
    <tr className="pair-row">
      <td><span className="pair-symbol" style={{ fontSize: 13 }}>{pos.pair}</span></td>
      <td>
        <span className={`type-badge ${pos.type.toLowerCase()}`}>{pos.type}</span>
      </td>
      <td className="mono">{pos.lots}</td>
      <td className="mono muted">{typeof pos.openPrice === 'number' ? pos.openPrice.toFixed(pos.openPrice > 10 ? 3 : 5) : pos.openPrice}</td>
      <td className="mono">{typeof pos.currentPrice === 'number' ? pos.currentPrice.toFixed(pos.currentPrice > 10 ? 3 : 5) : pos.currentPrice}</td>
      <td className="mono" style={{ color: '#ef4444' }}>{typeof pos.sl === 'number' ? pos.sl.toFixed(pos.sl > 10 ? 3 : 5) : pos.sl}</td>
      <td className="mono" style={{ color: '#22c55e' }}>{typeof pos.tp === 'number' ? pos.tp.toFixed(pos.tp > 10 ? 3 : 5) : pos.tp}</td>
      <td>
        <span className={pos.pips >= 0 ? 'up' : 'down'}>
          {pos.pips >= 0 ? '+' : ''}{pos.pips} pips
        </span>
      </td>
      <td>
        <span className={pos.pnl >= 0 ? 'up' : 'down'} style={{ fontWeight: 600 }}>
          {pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(2)}
        </span>
      </td>
      <td className="muted" style={{ fontSize: 11 }}>{pos.openTime} · {pos.duration}</td>
      <td>
        <button className="close-btn" onClick={() => onClose(pos.id)}>Close</button>
      </td>
    </tr>
  );
}

// ── History row ───────────────────────────────────────────────────────────────
function HistoryRow({ trade }) {
  return (
    <tr className="pair-row">
      <td className="mono muted" style={{ fontSize: 11 }}>{trade.id}</td>
      <td><span className="pair-symbol" style={{ fontSize: 13 }}>{trade.pair}</span></td>
      <td><span className={`type-badge ${trade.type.toLowerCase()}`}>{trade.type}</span></td>
      <td className="mono muted">{trade.lots}</td>
      <td className="mono muted">{typeof trade.openPrice === 'number' ? trade.openPrice.toFixed(trade.openPrice > 10 ? 3 : 5) : trade.openPrice}</td>
      <td className="mono muted">{typeof trade.closePrice === 'number' ? trade.closePrice.toFixed(trade.closePrice > 10 ? 3 : 5) : trade.closePrice}</td>
      <td><span className={trade.pips >= 0 ? 'up' : 'down'}>{trade.pips >= 0 ? '+' : ''}{trade.pips}p</span></td>
      <td>
        <span className={trade.pnl >= 0 ? 'up' : 'down'} style={{ fontWeight: 600 }}>
          {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
        </span>
      </td>
      <td>
        <span className={`result-badge ${trade.result.toLowerCase()}`}>{trade.result}</span>
      </td>
      <td className="muted" style={{ fontSize: 11 }}>{trade.closeTime}</td>
    </tr>
  );
}

// ── Number input ──────────────────────────────────────────────────────────────
function NumberInput({ label, value, onChange, min, max, step, unit }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      <div className="field-input-wrap">
        <input
          type="number"
          className="field-input"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={e => onChange(parseFloat(e.target.value))}
        />
        {unit && <span className="field-unit">{unit}</span>}
      </div>
    </div>
  );
}

// ── Main AutoTrading ──────────────────────────────────────────────────────────
export default function AutoTrading({ accountMode = 'demo', brokerState }) {
  const isReal = accountMode === 'real';
  // fallback brokerState if not provided (standalone use)
  const bs = brokerState || {
    connected: false, name: '', env: 'live', authMethod: 'login',
    setConnected: () => {}, setName: () => {}, setEnv: () => {}, setAuthMethod: () => {},
  };
  const [botActive, setBotActive] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState(STRATEGIES[0]);
  const [positions, setPositions] = useState(samplePositions);
  const [history, setHistory] = useState(tradeHistory);
  const [activeTab, setActiveTab] = useState('positions');

  // Risk settings state (initialized from strategy defaults)
  const [lotSize, setLotSize] = useState(selectedStrategy.defaultLot);
  const [stopLoss, setStopLoss] = useState(selectedStrategy.defaultSL);
  const [takeProfit, setTakeProfit] = useState(selectedStrategy.defaultTP);
  const [maxTrades, setMaxTrades] = useState(selectedStrategy.maxTrades);
  const [maxDrawdown, setMaxDrawdown] = useState(5);
  const [trailingStop, setTrailingStop] = useState(false);
  const [martingale, setMartingale] = useState(false);
  const [selectedPairs, setSelectedPairs] = useState(['EUR/USD', 'GBP/USD', 'USD/JPY']);

  // Stats derived from history
  const totalPnl = history.reduce((s, t) => s + t.pnl, 0);
  const wins = history.filter(t => t.result === 'WIN').length;
  const winRate = history.length > 0 ? ((wins / history.length) * 100).toFixed(1) : '0.0';
  const activePnl = positions.reduce((s, p) => s + p.pnl, 0);

  const handleStrategyChange = (s) => {
    setSelectedStrategy(s);
    setLotSize(s.defaultLot);
    setStopLoss(s.defaultSL);
    setTakeProfit(s.defaultTP);
    setMaxTrades(s.maxTrades);
  };

  const handleClosePosition = (id) => {
    const pos = positions.find(p => p.id === id);
    if (pos) {
      setHistory(prev => [{
        id: `H${String(prev.length + 1).padStart(3, '0')}`,
        pair: pos.pair,
        type: pos.type,
        lots: pos.lots,
        openPrice: pos.openPrice,
        closePrice: pos.currentPrice,
        pnl: pos.pnl,
        pips: pos.pips,
        result: pos.pnl >= 0 ? 'WIN' : 'LOSS',
        closeTime: new Date().toLocaleString(),
      }, ...prev]);
      setPositions(prev => prev.filter(p => p.id !== id));
    }
  };

  const togglePair = (symbol) => {
    setSelectedPairs(prev =>
      prev.includes(symbol) ? prev.filter(s => s !== symbol) : [...prev, symbol]
    );
  };

  const majorPairs = forexPairs.filter(p => p.category === 'Majors').map(p => p.symbol);

  return (
    <div className="autotrading-root">

      {/* ── App Bot (manual SMC trades via OANDA) ────────────────────────── */}
      <AppBotPanel />

      {/* ── Real mode warning + broker panel ─────────────────────────────── */}
      {isReal && (
        <div className="at-real-row">
          <div className="real-warning-card">
            <span style={{ fontSize: 20 }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 600, color: '#f97316', marginBottom: 2 }}>Real Money Mode Active</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                All bot trades will execute on your live broker account using real funds.
                Double-check your risk settings before enabling the bot.
              </div>
            </div>
          </div>
          <BrokerPanel brokerState={bs} />
        </div>
      )}

      {/* ── TOP: Bot control + stats ─────────────────────────────────────── */}
      <div className="at-top-row">

        {/* Bot status card */}
        <div className="bot-status-card">
          <div className="bot-status-header">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <StatusDot active={botActive} />
                <span className="bot-status-title">{botActive ? 'Bot Running' : 'Bot Offline'}</span>
              </div>
              <div className="bot-strategy-name">{selectedStrategy.name}</div>
              <div className="bot-tf">{selectedStrategy.timeframe}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <Toggle checked={botActive} onChange={setBotActive} />
              <div style={{ fontSize: 10, color: '#475569', marginTop: 6 }}>
                {botActive ? 'Click to stop' : 'Click to start'}
              </div>
            </div>
          </div>

          <div className="bot-indicator-row">
            {selectedStrategy.indicators.map(ind => (
              <span key={ind} className="indicator-chip">{ind}</span>
            ))}
          </div>

          {botActive && (
            <div className="bot-live-row">
              <span className="live-dot" />
              <span style={{ color: '#22c55e', fontSize: 12 }}>LIVE — scanning {selectedPairs.length} pair{selectedPairs.length !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>

        {/* Stats */}
        <StatCard label="Open Positions"  value={positions.length}              color={positions.length > 0 ? '#00d4aa' : undefined} />
        <StatCard label="Floating P&L"    value={`${activePnl >= 0 ? '+' : ''}$${activePnl.toFixed(2)}`}  color={activePnl >= 0 ? '#22c55e' : '#ef4444'} sub="unrealised" />
        <StatCard label="Total P&L"       value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}    color={totalPnl >= 0 ? '#22c55e' : '#ef4444'}  sub={`${history.length} trades`} />
        <StatCard label="Win Rate"        value={`${winRate}%`}                 color={parseFloat(winRate) >= 60 ? '#22c55e' : parseFloat(winRate) >= 40 ? '#f59e0b' : '#ef4444'} sub={`${wins}W / ${history.length - wins}L`} />
      </div>

      {/* ── MIDDLE: Strategy + Risk config ──────────────────────────────── */}
      <div className="at-config-row">

        {/* Strategy selector */}
        <div className="config-panel">
          <div className="panel-title">Strategy</div>
          <div className="strategy-grid">
            {STRATEGIES.map(s => (
              <div
                key={s.id}
                className={`strategy-card ${selectedStrategy.id === s.id ? 'active' : ''}`}
                onClick={() => handleStrategyChange(s)}
              >
                <div className="strategy-card-name">{s.name}</div>
                <div className="strategy-card-tf">{s.timeframe}</div>
                <div className="strategy-card-desc">{s.description}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Risk management */}
        <div className="config-panel">
          <div className="panel-title">Risk Management</div>
          <div className="fields-grid">
            <NumberInput label="Lot Size"      value={lotSize}    onChange={setLotSize}    min={0.01} max={10}   step={0.01} unit="lots" />
            <NumberInput label="Stop Loss"     value={stopLoss}   onChange={setStopLoss}   min={1}    max={500}  step={1}    unit="pips" />
            <NumberInput label="Take Profit"   value={takeProfit} onChange={setTakeProfit} min={1}    max={1000} step={1}    unit="pips" />
            <NumberInput label="Max Trades"    value={maxTrades}  onChange={setMaxTrades}  min={1}    max={50}   step={1}    unit="open" />
            <NumberInput label="Max Drawdown"  value={maxDrawdown} onChange={setMaxDrawdown} min={1} max={50}   step={0.5}  unit="%" />
            <div className="field" />
          </div>
          <div className="toggle-row">
            <Toggle checked={trailingStop} onChange={setTrailingStop} label="Trailing Stop Loss" />
            <Toggle checked={martingale}   onChange={setMartingale}   label="Martingale (risky)" />
          </div>
          <div className="rr-display">
            R:R Ratio <strong style={{ color: '#00d4aa' }}> 1:{(takeProfit / stopLoss).toFixed(1)}</strong>
          </div>
        </div>

        {/* Pair selector */}
        <div className="config-panel pair-selector-panel">
          <div className="panel-title">Trading Pairs <span style={{ color: '#475569', fontWeight: 400, fontSize: 12 }}>({selectedPairs.length} selected)</span></div>
          <div className="pair-chips">
            {majorPairs.map(sym => (
              <button
                key={sym}
                className={`pair-chip ${selectedPairs.includes(sym) ? 'active' : ''}`}
                onClick={() => togglePair(sym)}
              >
                {sym}
              </button>
            ))}
          </div>
          <div className="pair-selector-hint">
            Click pairs to toggle. Bot will only trade selected pairs.
          </div>
        </div>
      </div>

      {/* ── BOTTOM: Positions + History ──────────────────────────────────── */}
      <div className="at-bottom-panel">
        <div className="panel-tabs">
          <button
            className={`panel-tab ${activeTab === 'positions' ? 'active' : ''}`}
            onClick={() => setActiveTab('positions')}
          >
            Open Positions
            {positions.length > 0 && <span className="tab-badge">{positions.length}</span>}
          </button>
          <button
            className={`panel-tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            Trade History
            {history.length > 0 && <span className="tab-badge">{history.length}</span>}
          </button>
        </div>

        <div className="table-wrap" style={{ marginTop: 0 }}>
          {activeTab === 'positions' && (
            <table className="screener-table">
              <thead>
                <tr>
                  {['Pair','Type','Lots','Open','Current','SL','TP','Pips','P&L','Opened',''].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan={11} style={{ textAlign: 'center', padding: '32px 0', color: '#475569' }}>
                      {botActive ? 'No open positions — bot is scanning…' : 'No open positions'}
                    </td>
                  </tr>
                ) : positions.map(pos => (
                  <PositionRow key={pos.id} pos={pos} onClose={handleClosePosition} />
                ))}
              </tbody>
            </table>
          )}

          {activeTab === 'history' && (
            <table className="screener-table">
              <thead>
                <tr>
                  {['ID','Pair','Type','Lots','Open','Close','Pips','P&L','Result','Closed'].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ textAlign: 'center', padding: '32px 0', color: '#475569' }}>
                      No trade history yet
                    </td>
                  </tr>
                ) : history.map(t => (
                  <HistoryRow key={t.id} trade={t} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

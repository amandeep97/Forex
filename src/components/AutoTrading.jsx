import { useState, useEffect, useCallback, useRef } from 'react';
import { ghRead, ghWrite } from '../utils/githubSync';
import BotConfig from './BotConfig';
import ChartModal from './ChartModal';

// ── Broker base URLs ──────────────────────────────────────────────────────────
const oandaBase = (env) =>
  env === 'live' ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3';

// ── OANDA helpers ─────────────────────────────────────────────────────────────
async function oandaCandles(apiKey, env, instrument, count = 100, granularity = 'H1') {
  const res = await fetch(
    `${oandaBase(env)}/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.errorMessage || `OANDA ${res.status}`); }
  const { candles } = await res.json();
  return candles.filter(c => c.complete).map(c => ({
    t: c.time, o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, v: c.volume,
  }));
}

async function oandaAccount(apiKey, accountId, env) {
  const res = await fetch(`${oandaBase(env)}/accounts/${accountId}/summary`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) return { balance: 1000, marginAvailable: 200, leverage: 30 };
  const d   = await res.json();
  const acc = d.account || {};
  return {
    balance:         parseFloat(acc.balance         || 1000),
    marginAvailable: parseFloat(acc.marginAvailable || acc.balance || 200),
    leverage:        acc.marginRate ? Math.round(1 / parseFloat(acc.marginRate)) : 30,
  };
}

async function oandaPlaceOrder(apiKey, accountId, env, pair, signedUnits, sl, tp) {
  const d = pair.includes('JPY') ? 3 : pair.includes('XAU') ? 2 : 5;
  const res = await fetch(`${oandaBase(env)}/accounts/${accountId}/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: { type: 'MARKET', instrument: pair, units: String(signedUnits),
      stopLossOnFill: { price: sl.toFixed(d) }, takeProfitOnFill: { price: tp.toFixed(d) } } }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.errorMessage || `OANDA ${res.status}`);
  return json.orderFillTransaction?.tradeOpened?.tradeID || json.relatedTransactionIDs?.[0] || '?';
}

async function oandaModifyTrade(apiKey, accountId, env, tradeId, body) {
  const res = await fetch(`${oandaBase(env)}/accounts/${accountId}/trades/${tradeId}/orders`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.errorMessage || `OANDA ${res.status}`); }
  return res.json();
}

// ── MT4 signal writer ─────────────────────────────────────────────────────────
async function writeMT4Signal(pair, direction, entry, sl, tp, lots) {
  const signal = {
    id:        `sig_${Date.now()}`,
    pair,
    direction,
    entry,
    sl,
    tp,
    lots,
    sentAt:    new Date().toISOString(),
    status:    'pending',
  };
  const existing = await ghRead('bot/mt4-signals.json', { noCache: true }).catch(() => null);
  await ghWrite('bot/mt4-signals.json', signal, `MT4 signal: ${direction} ${pair}`, existing?.sha || null);
  return signal.id;
}

// ── MT4 EA source code ────────────────────────────────────────────────────────
const MT4_EA_CODE = `//+------------------------------------------------------------------+
//| ForexPro MT4 Bridge EA                                            |
//| Reads signals from GitHub and places trades in MT4               |
//+------------------------------------------------------------------+
// SETUP:
// 1. Copy this file to: MT4 → File → Open Data Folder → MQL4/Experts/
// 2. Compile (F7) then drag onto any chart
// 3. Tools → Options → Expert Advisors → Allow WebRequest for URLs:
//    https://raw.githubusercontent.com
// 4. Enable "Allow live trading" checkbox

#property strict
extern double LotSize   = 0.01;
extern int    Slippage  = 3;
extern int    PollSecs  = 30;
extern string SignalURL = "https://raw.githubusercontent.com/amandeep97/Forex/main/bot/mt4-signals.json";

string   lastId    = "";
datetime lastCheck = 0;

int OnInit()  { EventSetTimer(PollSecs); return INIT_SUCCEEDED; }
void OnDeinit(const int r) { EventKillTimer(); }
void OnTimer() { CheckSignal(); }
void OnTick()  { if (TimeCurrent()-lastCheck >= PollSecs) CheckSignal(); }

void CheckSignal() {
  lastCheck = TimeCurrent();
  char post[], result[]; string rh;
  int code = WebRequest("GET", SignalURL+"?_="+IntegerToString(TimeCurrent()),
                        "", 5000, post, result, rh);
  if (code != 200) { Print("[FP] HTTP ", code," — allow URL in Tools>Options>EA"); return; }
  string j = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
  string id  = F(j,"id"), status = F(j,"status"), pair = F(j,"pair");
  string dir = F(j,"direction");
  double sl  = StringToDouble(F(j,"sl")), tp = StringToDouble(F(j,"tp"));
  double lots= StringToDouble(F(j,"lots")); if(lots<=0) lots=LotSize;
  if (id=="" || id==lastId || status!="pending") return;
  lastId = id;
  string sym = pair; StringReplace(sym,"_","");
  int cmd = (dir=="LONG") ? OP_BUY : OP_SELL;
  double px = (cmd==OP_BUY) ? MarketInfo(sym,MODE_ASK) : MarketInfo(sym,MODE_BID);
  int tk = OrderSend(sym, cmd, lots, px, Slippage, sl, tp, "ForexPro", 12345, 0,
                     cmd==OP_BUY ? clrLime : clrRed);
  if (tk>0) Print("[FP] Placed #",tk," ",dir," ",sym," SL:",sl," TP:",tp);
  else      Print("[FP] Failed: ",GetLastError());
}

string F(string j, string k) {
  int p=StringFind(j,"\""+k+"\""); if(p<0) return "";
  p=StringFind(j,":",p)+1;
  while(StringGetCharacter(j,p)==' ') p++;
  bool s=(StringGetCharacter(j,p)=='"'); if(s) p++;
  string r="";
  for(int i=p;i<StringLen(j);i++) {
    ushort c=StringGetCharacter(j,i);
    if(s&&c=='"') break;
    if(!s&&(c==','||c=='}'||c=='\\n')) break;
    r+=ShortToString(c);
  }
  return r;
}`;

// ── SMC analysis for manual trade ─────────────────────────────────────────────
function analyzeCandles(candles, forceDir = null) {
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
  const dir = forceDir || (structure === 'bullish' ? 'LONG' : structure === 'bearish' ? 'SHORT' : null);
  if (!dir) return { dir: null, structure, cp, atr };
  const pipSize  = win[0] ? (String(win[0].c).includes('.') && win[0].c < 10 ? 0.0001 : win[0].c > 10 ? 0.01 : 0.0001) : 0.0001;
  const minSLPips = 15; // minimum 15 pips SL distance — below this OANDA rejects
  const rawSL    = dir === 'LONG' ? sL - atr * 0.5 : sH + atr * 0.5;
  const minSLDist = minSLPips * pipSize;
  const sl   = dir === 'LONG'
    ? Math.min(rawSL, cp - minSLDist)
    : Math.max(rawSL, cp + minSLDist);
  const dist = Math.abs(cp - sl);
  if (dist <= 0) return { dir: null, structure, cp, atr };
  const tp   = dir === 'LONG' ? cp + dist * 2 : cp - dist * 2;
  return { dir, structure, cp, sl, tp, rr: (Math.abs(tp - cp) / dist).toFixed(1), atr };
}

function calcUnits(balance, riskPct, entry, sl, pair, marginAvailable, leverage) {
  const pipSize  = pair.includes('JPY') ? 0.01 : pair.includes('XAU') ? 0.1 : 0.0001;
  const slPips   = Math.abs(entry - sl) / pipSize;
  if (!slPips || slPips < 1) return 1;
  // Risk-based units
  const riskAmt   = balance * riskPct / 100;
  const riskUnits = Math.round(riskAmt / (slPips * pipSize));
  // Margin-safe cap: use at most 40% of available margin for this trade
  const lev       = leverage || 30;
  const mAvail    = marginAvailable || balance * 0.5;
  const marginCap = Math.floor((mAvail * 0.4 * lev) / (entry || 1));
  return Math.max(1, Math.min(riskUnits, marginCap, 500000));
}

// ── Shared UI atoms ───────────────────────────────────────────────────────────
function Toggle({ checked, onChange }) {
  return (
    <div onClick={() => onChange(!checked)}
      style={{ width: 44, height: 24, borderRadius: 12, cursor: 'pointer', position: 'relative',
        background: checked ? '#2563eb' : '#334155', transition: 'background 0.2s', flexShrink: 0 }}>
      <div style={{ position: 'absolute', top: 2, left: checked ? 22 : 2, width: 20, height: 20,
        borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
    </div>
  );
}

const INP  = { background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 6, padding: '6px 10px', fontSize: 12 };
const BTN  = (x) => ({ border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 12, cursor: 'pointer', fontWeight: 600, ...x });
const CARD = { background: '#1e293b', borderRadius: 10, padding: 16, border: '1px solid #334155', marginBottom: 12 };
const SEC  = { fontSize: 11, fontWeight: 600, color: '#64748b', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 };

const ALL_PAIRS = [
  // Majors
  'EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','NZD_USD','USD_CAD',
  // Crosses EUR
  'EUR_GBP','EUR_JPY','EUR_AUD','EUR_CAD','EUR_NZD','EUR_CHF',
  // Crosses GBP
  'GBP_JPY','GBP_AUD','GBP_CAD','GBP_NZD','GBP_CHF',
  // Crosses AUD
  'AUD_JPY','AUD_CAD','AUD_NZD','AUD_CHF',
  // Crosses NZD
  'NZD_JPY','NZD_CAD','NZD_CHF',
  // Crosses CAD
  'CAD_JPY','CAD_CHF',
  // Crosses CHF
  'CHF_JPY',
  // Metals & commodities
  'XAU_USD','XAG_USD','BCO_USD','WTICO_USD',
];
function dp(pair)      { return pair?.includes('JPY') ? 3 : pair?.includes('XAU') ? 2 : 5; }
function fmtPx(v, p)   { return v != null ? Number(v).toFixed(dp(p)) : '—'; }
function fmtTime(iso)  { return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'; }

// ── Connect Exchange tab ───────────────────────────────────────────────────────
function ConnectTab({ onLog, signalPair, onSignalUsed }) {
  const [broker,     setBroker]     = useState(() => localStorage.getItem('broker_type') || 'oanda');

  // OANDA state
  const [apiKey,    setApiKey]    = useState(() => localStorage.getItem('oanda_key')  || '');
  const [accountId, setAccountId] = useState(() => localStorage.getItem('oanda_acct') || '');
  const [env,       setEnv]       = useState(() => localStorage.getItem('oanda_env')  || 'practice');
  const [connected, setConnected] = useState(() => !!localStorage.getItem('oanda_key'));

  // Forex.com state (kept for future use, CORS workaround via VPS)
  const [fcUser,    setFcUser]    = useState(() => localStorage.getItem('fc_user') || '');
  const [fcPass,    setFcPass]    = useState('');
  const [fcEnv,     setFcEnv]     = useState(() => localStorage.getItem('fc_env') || 'demo');

  // MT4 state
  const [mt4Copied, setMt4Copied] = useState(false);
  const [mt4Sending, setMt4Sending] = useState(false);

  // Trade state
  const [pair,      setPair]      = useState('EUR_USD');
  const [tf,        setTf]        = useState('H1');
  const [signal,    setSignal]    = useState(null);
  const [editEntry, setEditEntry] = useState('');
  const [editSL,    setEditSL]    = useState('');
  const [editTP,    setEditTP]    = useState('');
  const [lotSize,   setLotSize]   = useState('0.01');
  const [analyzing, setAnalyzing] = useState(false);
  const [placing,   setPlacing]   = useState(false);
  const [connMsg,   setConnMsg]   = useState('');
  const [tradeMsg,  setTradeMsg]  = useState('');
  const [connErr,   setConnErr]   = useState('');
  const [tradeErr,  setTradeErr]  = useState('');

  // Auto-populate pair from scan tap
  useEffect(() => {
    if (!signalPair) return;
    setPair(signalPair); setSignal(null); setTradeErr('');
    onSignalUsed?.();
  }, [signalPair, onSignalUsed]);

  // ── OANDA connect ──────────────────────────────────────────────────────────
  const connectOanda = async () => {
    if (!apiKey || !accountId) { setConnErr('Enter API key and Account ID'); return; }
    setConnErr(''); setConnMsg('Verifying…');
    localStorage.setItem('oanda_key', apiKey);
    localStorage.setItem('oanda_acct', accountId);
    localStorage.setItem('oanda_env', env);
    localStorage.setItem('broker_type', 'oanda');
    try {
      const res = await fetch(`${oandaBase(env)}/instruments/EUR_USD/candles?granularity=M1&count=1&price=M`,
        { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`OANDA ${res.status}`);
      setConnected(true); setConnMsg('');
      onLog?.('SUCCESS', `Connected to OANDA ${env}`);
    } catch (e) { setConnErr(e.message); setConnMsg(''); }
  };

  // ── Forex.com connect ──────────────────────────────────────────────────────
  const connectForexCom = async () => {
    if (!fcUser || !fcPass) { setConnErr('Enter username and password'); return; }
    setConnErr(''); setConnMsg('Authenticating…');
    try {
      const auth = await fcAuth(fcUser, fcPass, fcEnv);
      localStorage.setItem('fc_user', fcUser);
      localStorage.setItem('fc_session', auth.session);
      localStorage.setItem('fc_env', fcEnv);
      localStorage.setItem('broker_type', 'forexcom');
      setFcSession(auth.session);
      // Get accounts
      const accts = await fcGetAccounts(fcUser, auth.session, fcEnv).catch(() => ({ ClientAccounts: [] }));
      const list = accts.ClientAccounts || [];
      setFcAccts(list);
      if (list.length > 0) {
        const id = String(list[0].TradingAccountId);
        setFcAcctId(id);
        localStorage.setItem('fc_acct', id);
      }
      setFcConnected(true); setConnMsg('');
      onLog?.('SUCCESS', `Connected to Forex.com ${fcEnv} · ${list.length} account(s)`);
    } catch (e) {
      setConnErr(`Forex.com: ${e.message} — Note: browser CORS may block direct API calls; use VPS bot for Forex.com instead.`);
      setConnMsg('');
    }
  };

  // ── Analyze ────────────────────────────────────────────────────────────────
  const analyze = async (forceDir = null) => {
    const key = broker === 'oanda' ? apiKey : null;
    if (broker === 'oanda' && !key) { setTradeErr('Connect OANDA first'); return; }
    if (broker === 'forexcom' && !fcConnected) { setTradeErr('Connect Forex.com first'); return; }
    setAnalyzing(true); setTradeErr(''); setSignal(null);
    try {
      let candles;
      if (broker === 'oanda' && apiKey) {
        candles = await oandaCandles(apiKey, env, pair, 100, tf);
      } else {
        const savedKey = localStorage.getItem('oanda_key');
        if (savedKey) {
          candles = await oandaCandles(savedKey, localStorage.getItem('oanda_env') || 'practice', pair, 100, tf);
        } else {
          throw new Error('Add an OANDA API key for chart analysis (free practice account works — no trading needed)');
        }
      }
      const sig = analyzeCandles(candles, forceDir);
      if (!sig) { setTradeErr('Not enough candle data'); return; }
      if (!sig.dir && !forceDir) {
        // Ranging — return partial signal so user can pick direction
        setSignal({ ...sig, needsDirection: true });
        setEditEntry(sig.cp.toFixed(dp(pair)));
        return;
      }
      setSignal(sig);
      const d = dp(pair);
      setEditEntry(sig.cp.toFixed(d)); setEditSL(sig.sl?.toFixed(d) || ''); setEditTP(sig.tp?.toFixed(d) || '');
      // Fetch real balance + margin and size accordingly
      const acct  = (broker === 'oanda' && apiKey && accountId)
        ? await oandaAccount(apiKey, accountId, env).catch(() => ({ balance: 1000, marginAvailable: 200, leverage: 30 }))
        : { balance: 1000, marginAvailable: 200, leverage: 30 };
      const units = calcUnits(acct.balance, 1, sig.cp, sig.sl, pair, acct.marginAvailable, acct.leverage);
      const lots  = units / 100000;
      setLotSize(lots < 0.01 ? lots.toFixed(4) : lots.toFixed(2));
      onLog?.('INFO', `Signal: ${sig.dir} ${pair.replace('_','/')} · ${sig.structure} · R:R 1:${sig.rr}`);
    } catch (e) { setTradeErr(e.message); }
    finally { setAnalyzing(false); }
  };

  // ── Place order ────────────────────────────────────────────────────────────
  const placeOrder = async (dirOverride) => {
    const dir = dirOverride || signal?.dir;
    if (!dir) return;
    const sl = parseFloat(editSL), tp = parseFloat(editTP), entry = parseFloat(editEntry);
    if (isNaN(sl) || isNaN(tp)) { setTradeErr('Enter valid SL and TP'); return; }
    setPlacing(true); setTradeErr('');
    try {
      let tradeId;
      const units = Math.max(1, Math.round(parseFloat(lotSize) * 100000));
      const signedUnits = dir === 'LONG' ? units : -units;

      if (broker === 'oanda') {
        if (!apiKey || !accountId) throw new Error('OANDA not connected');
        tradeId = await oandaPlaceOrder(apiKey, accountId, env, pair, signedUnits, sl, tp);
      } else if (broker === 'mt4') {
        const signalId = await writeMT4Signal(pair, dir, entry, sl, tp, parseFloat(lotSize));
        tradeId = `MT4-${signalId}`;
      } else {
        throw new Error('Broker not supported for direct orders — use MT4 or OANDA');
      }

      // Log to GitHub
      try {
        const ghData = await ghRead('bot/trades.json', { noCache: true });
        const log = ghData?.content?.trades || [];
        log.push({ id: `app_${Date.now()}`, source: broker === 'oanda' ? 'app_manual' : 'app_mt4',
          pair, direction: dir, entryPrice: entry, slPrice: sl, tpPrice: tp,
          units: signedUnits, oandaTradeId: tradeId, openTime: new Date().toISOString(), status: 'OPEN',
          structure: signal?.structure, rr: parseFloat(signal?.rr || 0) });
        await ghWrite('bot/trades.json', { trades: log }, `Manual: ${dir} ${pair}`, ghData?.sha || null);
      } catch {}

      onLog?.('TRADE',   `${dir} ${pair.replace('_','/')} @ ${editEntry} | SL ${editSL} | TP ${editTP}`);
      onLog?.('SUCCESS', broker === 'mt4' ? `Signal sent to MT4 — EA will place the order within 30s` : `Order confirmed — ID: ${tradeId}`);
      setTradeMsg(broker === 'mt4' ? `✓ Signal sent to MT4 — check your MT4 platform` : `✓ Order placed — ID: ${tradeId}`);
      setSignal(null);
      setTimeout(() => setTradeMsg(''), 6000);
    } catch (e) { setTradeErr(e.message); onLog?.('ERROR', e.message); }
    finally { setPlacing(false); }
  };

  return (
    <div style={{ padding: 16 }}>

      {/* Broker selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {[['oanda','OANDA','#1d4ed8'],['mt4','MT4 / Forex.com','#7c3aed'],['forexcom','Forex.com Direct','#334155']].map(([id, label, bg]) => (
          <button key={id} onClick={() => { setBroker(id); setConnErr(''); localStorage.setItem('broker_type', id); }}
            style={{ padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: broker === id ? `1.5px solid ${bg}` : '1px solid #334155',
              background: broker === id ? bg : '#1e293b', color: broker === id ? '#fff' : '#94a3b8' }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── OANDA connection ──────────────────────────────────────────────── */}
      {broker === 'oanda' && (
        <div style={CARD}>
          <div style={SEC}>OANDA Connection</div>
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
                <button key={e} onClick={() => setEnv(e)} style={{ background: env===e?'#334155':'transparent', border:`1px solid ${env===e?'#475569':'#1e293b'}`, color: env===e?'#f8fafc':'#64748b', borderRadius:6, padding:'6px 10px', fontSize:11, cursor:'pointer', textTransform:'capitalize' }}>{e}</button>
              ))}
            </div>
            <button onClick={connectOanda} style={BTN({ background: connected ? '#166534' : '#1d4ed8', color: '#fff' })}>
              {connected ? '● Connected' : 'Connect'}
            </button>
          </div>
          {connected && <div style={{ fontSize: 12, color: '#22c55e', fontWeight: 600 }}>● Connected · {env} · {accountId}</div>}
          {connErr && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>{connErr}</div>}
          {connMsg && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>{connMsg}</div>}
        </div>
      )}

      {/* ── MT4 Bridge (Forex.com / any MT4 broker) ──────────────────────── */}
      {broker === 'mt4' && (
        <div style={CARD}>
          <div style={SEC}>MT4 Bridge — Works with Forex.com, IC Markets, any MT4 broker</div>
          <div style={{ background: '#7c3aed15', border: '1px solid #7c3aed44', borderRadius: 8, padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#a78bfa', marginBottom: 6 }}>How it works</div>
            <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.8 }}>
              1. You analyze a trade here → click <strong style={{ color: '#e2e8f0' }}>"Send to MT4"</strong><br/>
              2. ForexPro writes the signal to GitHub (takes 1 second)<br/>
              3. The <strong style={{ color: '#e2e8f0' }}>EA running in your MT4</strong> detects the signal within 30s and places the order<br/>
              4. Works with <strong style={{ color: '#e2e8f0' }}>Forex.com, IC Markets, Pepperstone</strong> — any broker with MT4
            </div>
          </div>

          <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 8, letterSpacing: 1, textTransform: 'uppercase' }}>Step 1 — Install the EA in MT4 Desktop</div>
          <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.8, marginBottom: 10 }}>
            Download MT4 from your broker (Forex.com → <em>Platforms → MetaTrader 4</em>)<br/>
            Then: File → Open Data Folder → MQL4 → Experts → paste the EA file below
          </div>

          <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 8, letterSpacing: 1, textTransform: 'uppercase' }}>Step 2 — EA Code (ForexPro_Bridge.mq4)</div>
          <div style={{ position: 'relative' }}>
            <pre style={{ background: '#0f172a', borderRadius: 8, padding: 12, fontSize: 10, color: '#94a3b8', overflow: 'auto', maxHeight: 200, margin: 0, border: '1px solid #334155', lineHeight: 1.5 }}>
              {MT4_EA_CODE}
            </pre>
            <button onClick={() => { navigator.clipboard.writeText(MT4_EA_CODE); setMt4Copied(true); setTimeout(() => setMt4Copied(false), 2000); }}
              style={{ position: 'absolute', top: 8, right: 8, background: mt4Copied ? '#166534' : '#334155', border: 'none', color: mt4Copied ? '#4ade80' : '#94a3b8', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: 'pointer' }}>
              {mt4Copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>

          <div style={{ fontSize: 11, color: '#64748b', marginTop: 10, lineHeight: 1.7 }}>
            <strong style={{ color: '#f59e0b' }}>⚠️ Required in MT4:</strong><br/>
            Tools → Options → Expert Advisors → ✓ Allow WebRequest for listed URLs<br/>
            Add: <code style={{ background: '#0f172a', padding: '1px 6px', borderRadius: 3, color: '#38bdf8' }}>https://raw.githubusercontent.com</code>
          </div>
        </div>
      )}

      {/* ── Forex.com Direct (CORS warning) ──────────────────────────────── */}
      {broker === 'forexcom' && (
        <div style={CARD}>
          <div style={SEC}>Forex.com Direct API</div>
          <div style={{ background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#f87171', marginBottom: 4 }}>Browser CORS Restriction</div>
            <div style={{ fontSize: 11, color: '#fca5a5', lineHeight: 1.6 }}>
              Browsers block direct Forex.com API calls for security reasons.<br/>
              <strong>Use MT4 Bridge tab instead</strong> — it works with your Forex.com MT4 account.
            </div>
          </div>
          <button onClick={() => setBroker('mt4')} style={BTN({ background: '#7c3aed', color: '#fff', width: '100%' })}>
            Switch to MT4 Bridge →
          </button>
        </div>
      )}

      {/* ── Manual Trade ─────────────────────────────────────────────────── */}
      <div style={CARD}>
        <div style={SEC}>Manual Trade</div>

        {signalPair && (
          <div style={{ background: '#22c55e15', border: '1px solid #22c55e33', borderRadius: 6, padding: '6px 10px', marginBottom: 10, fontSize: 11, color: '#22c55e' }}>
            📡 Strategy signal: <strong>{signalPair.replace('_','/')}</strong> — analyze to see entry details
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <select value={pair} onChange={e => { setPair(e.target.value); setSignal(null); setTradeErr(''); }} style={INP}>
            {ALL_PAIRS.map(p => <option key={p} value={p}>{p.replace('_','/')}</option>)}
          </select>
          <select value={tf} onChange={e => { setTf(e.target.value); setSignal(null); }} style={{ ...INP, width: 72 }}>
            {['M5','M15','M30','H1','H4','D'].map(t => <option key={t} value={t === 'D' ? 'D' : t}>{t}</option>)}
          </select>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>Lot Size</div>
            <input value={lotSize} onChange={e => setLotSize(e.target.value)} style={{ ...INP, width: 70 }} />
          </div>
          <button onClick={() => analyze()} disabled={analyzing} style={BTN({ background: '#0ea5e9', color: '#fff', marginTop: 14 })}>
            {analyzing ? 'Analyzing…' : `Analyze ${tf}`}
          </button>
          {tradeMsg && <span style={{ fontSize: 11, color: '#22c55e', marginTop: 14 }}>{tradeMsg}</span>}
        </div>

        {/* Ranging market — let user pick direction */}
        {signal?.needsDirection && (
          <div style={{ background: '#0f172a', borderRadius: 8, padding: 14, border: '1px solid #334155' }}>
            <div style={{ fontSize: 12, color: '#f59e0b', marginBottom: 6, fontWeight: 600 }}>
              ⚠️ Market ranging on {tf} — choose direction manually
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 12 }}>
              Current price: <strong style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{editEntry}</strong> · ATR: {signal.atr?.toFixed(dp(pair))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => analyze('LONG')} disabled={analyzing}
                style={BTN({ background: '#166534', border: '1px solid #22c55e', color: '#22c55e' })}>
                ▲ Force Long
              </button>
              <button onClick={() => analyze('SHORT')} disabled={analyzing}
                style={BTN({ background: '#7f1d1d', border: '1px solid #ef4444', color: '#ef4444' })}>
                ▼ Force Short
              </button>
            </div>
          </div>
        )}

        {/* Trade panel */}
        {signal && !signal.needsDirection && (
          <div style={{ background: '#0f172a', borderRadius: 8, padding: 14, border: `1px solid ${signal.dir==='LONG'?'#166534':'#7f1d1d'}` }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: signal.dir==='LONG' ? '#22c55e' : '#ef4444' }}>
                {signal.dir==='LONG' ? '▲ LONG' : '▼ SHORT'}
              </span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{pair.replace('_','/')} · {tf} · {signal.structure}</span>
              <span style={{ fontSize: 11, color: '#a78bfa', marginLeft: 'auto' }}>R:R 1:{signal.rr}</span>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
              {[{l:'Entry',v:editEntry,s:setEditEntry,c:'#94a3b8'},{l:'Stop Loss',v:editSL,s:setEditSL,c:'#ef4444'},{l:'Take Profit',v:editTP,s:setEditTP,c:'#22c55e'}].map(({l,v,s,c}) => (
                <div key={l}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>{l}</div>
                  <input value={v} onChange={e => s(e.target.value)} style={{ background: '#1e293b', border: `1px solid ${c}55`, color: c, borderRadius: 6, padding: '6px 10px', fontSize: 12, width: 110, fontFamily: 'monospace' }} />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => placeOrder()} disabled={placing}
                style={BTN({ background: signal.dir==='LONG'?'#166534':'#7f1d1d', border:`1px solid ${signal.dir==='LONG'?'#22c55e':'#ef4444'}`, color: signal.dir==='LONG'?'#22c55e':'#ef4444' })}>
                {placing ? 'Placing…' : `Place ${signal.dir} · ${lotSize} lots`}
              </button>
              <button onClick={() => setSignal(null)} style={{ background:'transparent', border:'1px solid #334155', color:'#64748b', borderRadius:6, padding:'7px 12px', fontSize:11, cursor:'pointer' }}>Cancel</button>
            </div>
          </div>
        )}

        {tradeErr && !signal && (
          <div style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{tradeErr}</div>
        )}
        {tradeErr && signal && (
          <div style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{tradeErr}</div>
        )}
      </div>
    </div>
  );
}

// ── OANDA cancel reason → plain English ───────────────────────────────────────
const CANCEL_REASONS = {
  STOP_LOSS_ON_FILL_PRICE_DISTANCE_MINIMUM_NOT_MET: 'SL too close to price — move SL further away',
  TAKE_PROFIT_ON_FILL_PRICE_DISTANCE_MINIMUM_NOT_MET: 'TP too close to price — move TP further away',
  STOP_LOSS_ON_FILL_PRICE_DISTANCE_MAXIMUM_EXCEEDED: 'SL too far from price',
  STOP_LOSS_ON_FILL_LOSS: 'SL would cause immediate loss at current price',
  TAKE_PROFIT_ON_FILL_LOSS: 'TP would cause immediate loss at current price',
  INSUFFICIENT_MARGIN: 'Not enough margin — reduce lot size',
  UNITS_LIMIT_EXCEEDED: 'Position size too large for your account',
  ACCOUNT_NOT_TRADEABLE: 'Account not enabled for trading — contact OANDA',
  INSTRUMENT_NOT_TRADEABLE: 'Instrument not tradeable right now (market closed?)',
  PRICE_HALTED: 'Market halted — try again shortly',
  MARKET_HALTED: 'Market halted — try again shortly',
  TIME_IN_FORCE_EXPIRY: 'Order expired before it could fill',
  CLIENT_CANCEL: 'Cancelled by user',
  LINKED_TRADE_CLOSED: 'Related trade was already closed',
  STOP_LOSS_ON_FILL_GUARANTEED_BID_HALTED_CREATE_ONLY: 'Guaranteed SL not available — use regular stop',
  MARKET_ORDER_POSITION_CLOSEOUT_ONLY: 'Only close orders allowed for this instrument now',
};

function explainReason(raw) {
  return CANCEL_REASONS[raw] || raw?.replace(/_/g, ' ').toLowerCase() || 'Unknown reason';
}

// ── Positions tab ─────────────────────────────────────────────────────────────
function PositionsTab({ onLog }) {
  const [trades,      setTrades]      = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [closing,     setClosing]     = useState(null);
  const [activity,    setActivity]    = useState([]);
  const [actLoading,  setActLoading]  = useState(false);
  const [actErr,      setActErr]      = useState('');
  const [livePrices,  setLivePrices]  = useState({});
  const [liveMargins, setLiveMargins] = useState({});
  const [modifyState, setModifyState] = useState({});
  const [chartPair,   setChartPair]   = useState(null);

  const getMS = (id) => modifyState[id] || { sl: '', tp: '', trailDist: '', trailing: false, trailMode: 'pip', busy: false, err: '' };
  const setMS = (id, patch) => setModifyState(prev => ({ ...prev, [id]: { ...getMS(id), ...patch } }));

  const doModify = async (id, oandaId, body, tradeUpdate) => {
    const apiKey    = localStorage.getItem('oanda_key');
    const accountId = localStorage.getItem('oanda_acct');
    const env_      = localStorage.getItem('oanda_env') || 'practice';
    if (!apiKey || !accountId) { setMS(id, { err: 'Connect OANDA first' }); return; }
    setMS(id, { busy: true, err: '' });
    try {
      await oandaModifyTrade(apiKey, accountId, env_, oandaId, body);
      setMS(id, { busy: false, err: '' });
      onLog?.('INFO', `Trade ${oandaId} modified`);

      if (tradeUpdate) {
        // 1. Update React state immediately (instant UI feedback)
        setTrades(prev => prev.map(tr => tr.id === id ? { ...tr, ...tradeUpdate } : tr));

        // 2. Persist to GitHub so it survives page refresh
        try {
          const fresh = await ghRead('bot/trades.json', { noCache: true });
          const updatedTrades = (fresh?.content?.trades || []).map(tr =>
            tr.id === id ? { ...tr, ...tradeUpdate } : tr
          );
          await ghWrite('bot/trades.json', { trades: updatedTrades }, `App: update trade ${oandaId}`, fresh?.sha || null);
        } catch(e2) {
          setMS(id, { err: `OANDA updated but GitHub sync failed: ${e2.message}` });
        }
      }
    } catch(e) { setMS(id, { busy: false, err: e.message }); }
  };

  useEffect(() => {
    setLoading(true);
    ghRead('bot/trades.json').then(d => { setTrades(d?.content?.trades || []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  // Fetch live prices + real marginUsed for open trades every 15 seconds
  useEffect(() => {
    const fetchPrices = async () => {
      const apiKey    = localStorage.getItem('oanda_key');
      const accountId = localStorage.getItem('oanda_acct');
      const env_      = localStorage.getItem('oanda_env') || 'practice';
      if (!apiKey || !accountId) return;
      const openTrades = trades.filter(t => t.status === 'OPEN' || t.status === 'open');
      if (openTrades.length === 0) return;
      const instruments = [...new Set(openTrades.map(t => t.pair).filter(Boolean))].join(',');
      try {
        const [priceRes, tradesRes] = await Promise.all([
          fetch(`${oandaBase(env_)}/accounts/${accountId}/pricing?instruments=${instruments}`,
            { headers: { Authorization: `Bearer ${apiKey}` } }),
          fetch(`${oandaBase(env_)}/accounts/${accountId}/openTrades`,
            { headers: { Authorization: `Bearer ${apiKey}` } }),
        ]);
        if (priceRes.ok) {
          const data = await priceRes.json();
          const prices = {};
          (data.prices || []).forEach(p => {
            const bid = parseFloat(p.bids?.[0]?.price || 0);
            const ask = parseFloat(p.asks?.[0]?.price || 0);
            if (bid && ask) prices[p.instrument] = (bid + ask) / 2;
          });
          if (Object.keys(prices).length > 0) setLivePrices(prev => ({ ...prev, ...prices }));
        }
        if (tradesRes.ok) {
          const data = await tradesRes.json();
          const margins = {};
          (data.trades || []).forEach(t => {
            if (t.id && t.marginUsed) margins[String(t.id)] = parseFloat(t.marginUsed);
          });
          if (Object.keys(margins).length > 0) setLiveMargins(prev => ({ ...prev, ...margins }));
        }
      } catch {}
    };
    fetchPrices();
    const id = setInterval(fetchPrices, 15000);
    return () => clearInterval(id);
  }, [trades]);

  const fetchActivity = async () => {
    const apiKey    = localStorage.getItem('oanda_key');
    const accountId = localStorage.getItem('oanda_acct');
    const env_      = localStorage.getItem('oanda_env') || 'practice';
    if (!apiKey || !accountId) { setActErr('No OANDA account connected. Go to "Connect Exchange" tab and add your OANDA API key.'); return; }
    setActLoading(true); setActErr(''); setActivity([]);
    try {
      // Step 1: get latest transaction ID from account summary
      const sumRes = await fetch(`${oandaBase(env_)}/accounts/${accountId}/summary`,
        { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!sumRes.ok) { const j = await sumRes.json().catch(() => ({})); throw new Error(j.errorMessage || `OANDA ${sumRes.status}`); }
      const sumData = await sumRes.json();
      const lastId  = parseInt(sumData.account?.lastTransactionID || '0', 10);
      if (lastId === 0) { setActivity([]); return; }

      // Step 2: fetch last 200 transactions by ID range
      const fromId = Math.max(1, lastId - 200);
      const txRes  = await fetch(
        `${oandaBase(env_)}/accounts/${accountId}/transactions/idrange?from=${fromId}&to=${lastId}`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      if (!txRes.ok) { const j = await txRes.json().catch(() => ({})); throw new Error(j.errorMessage || `OANDA ${txRes.status}`); }
      const txData = await txRes.json();
      const all    = txData.transactions || [];

      // Step 3: client-side filter for relevant types, newest first
      const relevant = ['ORDER_CANCEL', 'MARKET_ORDER_REJECT', 'ORDER_FILL', 'STOP_LOSS_ORDER', 'TAKE_PROFIT_ORDER'];
      const filtered = all.filter(t => relevant.includes(t.type)).reverse().slice(0, 40);
      setActivity(filtered);
      if (filtered.length === 0) setActErr('No order activity found in last 200 transactions.');
    } catch (e) { setActErr(e.message); }
    finally { setActLoading(false); }
  };

  const open   = trades.filter(t => t.status === 'OPEN' || t.status === 'open');
  const closed = trades.filter(t => t.status !== 'OPEN' && t.status !== 'open' && t.status !== 'CANCELLED');
  const cancelled = trades.filter(t => t.status === 'CANCELLED');

  // Sync with OANDA: mark positions closed/cancelled if not in actual open trades
  const syncOanda = async () => {
    const apiKey    = localStorage.getItem('oanda_key');
    const accountId = localStorage.getItem('oanda_acct');
    const env_      = localStorage.getItem('oanda_env') || 'practice';
    if (!apiKey || !accountId) { setError('Connect OANDA first'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch(`${oandaBase(env_)}/accounts/${accountId}/openTrades`,
        { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`OANDA ${res.status}`);
      const data = await res.json();
      const openIds = new Set((data.trades || []).map(t => String(t.id)));

      const ghData = await ghRead('bot/trades.json', { noCache: true });
      const all = ghData?.content?.trades || [];
      let changed = 0;
      const updated = all.map(t => {
        const isOpen  = t.status === 'OPEN' || t.status === 'open';
        if (!isOpen) return t;
        const tradeId = t.oandaId || t.oandaTradeId;
        // Close if: no oandaId (can't verify) OR oandaId not in OANDA open trades
        if (!tradeId || !openIds.has(String(tradeId))) {
          changed++;
          return { ...t, status: 'closed', closedAt: new Date().toISOString() };
        }
        return t;
      });
      if (changed > 0) {
        await ghWrite('bot/trades.json', { trades: updated }, `Sync: ${changed} closed`, ghData?.sha || null);
        setTrades(updated);
        onLog?.('INFO', `Synced — ${changed} position(s) marked closed`);
      } else {
        onLog?.('INFO', 'Sync complete — all positions match OANDA');
        setTrades(all);
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const markClosed = async (id) => {
    setClosing(id);
    try {
      const data = await ghRead('bot/trades.json', { noCache: true });
      // Remove the trade entirely from the list
      const updated = (data?.content?.trades || []).filter(t => t.id !== id);
      await ghWrite('bot/trades.json', { trades: updated }, `Remove trade ${id}`, data?.sha || null);
      setTrades(updated);
    } catch (e) { setError(e.message); }
    finally { setClosing(null); }
  };

  const clearClosed = async () => {
    try {
      const data    = await ghRead('bot/trades.json', { noCache: true });
      const OPEN_ST = new Set(['open', 'OPEN']);
      const cleaned = (data?.content?.trades || []).filter(t => OPEN_ST.has(t.status));
      await ghWrite('bot/trades.json', { trades: cleaned }, 'Clear closed trades', data?.sha || null);
      setTrades(cleaned);
    } catch (e) { setError(e.message); }
  };

  return (
    <div style={{ padding: 16 }}>
      {chartPair && <ChartModal instrument={{ symbol: chartPair.replace('_', '/') }} onClose={() => setChartPair(null)}/>}
      {/* Sync banner — show if any open positions exist */}
      {open.length > 0 && (
        <div style={{ background: '#f59e0b15', border: '1px solid #f59e0b44', borderRadius: 8, padding: '10px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: '#fbbf24', flex: 1 }}>
            ⚠️ Positions may differ from broker — tap Sync to check which were filled vs cancelled
          </span>
          <button onClick={syncOanda} disabled={loading}
            style={{ background: '#f59e0b', border: 'none', color: '#000', borderRadius: 6, padding: '6px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {loading ? 'Syncing…' : '⟳ Sync OANDA'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: '#f8fafc', fontSize: 15 }}>Open ({open.length})</span>
        {cancelled.length > 0 && (
          <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 600 }}>✗ {cancelled.length} cancelled by broker</span>
        )}
        <button onClick={() => { setLoading(true); ghRead('bot/trades.json').then(d => { setTrades(d?.content?.trades || []); setLoading(false); }).catch(e => { setError(e.message); setLoading(false); }); }}
          style={{ background: '#334155', border: 'none', color: '#94a3b8', padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>Refresh</button>
        {(closed.length > 0 || cancelled.length > 0) && (
          <button onClick={clearClosed} style={{ background: 'transparent', border: '1px solid #334155', color: '#64748b', padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
            Clear History ({closed.length + cancelled.length})
          </button>
        )}
        {loading && <span style={{ fontSize: 11, color: '#475569' }}>Loading…</span>}
      </div>
      {error && <div style={{ background: '#450a0a', color: '#fca5a5', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {/* Cancelled positions — newest first */}
      {[...cancelled].sort((a,b) => new Date(b.openTime||b.openedAt||0) - new Date(a.openTime||a.openedAt||0)).map(t => (
        <div key={t.id} style={{ background: '#1e293b', borderRadius: 10, padding: 12, marginBottom: 8, border: '1px solid #7f1d1d', opacity: 0.8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#f87171' }}>✗</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>{(t.pair||'').replace('_','/')}</span>
            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, background: '#450a0a', color: '#f87171' }}>CANCELLED BY BROKER</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#475569' }}>{fmtTime(t.openTime||t.openedAt)}</span>
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Entry {fmtPx(t.entryPrice??t.entry, t.pair)} · SL {fmtPx(t.slPrice??t.sl, t.pair)} · TP {fmtPx(t.tpPrice??t.tp, t.pair)}
            {' '}— <span style={{ color: '#f59e0b' }}>Check "Order Activity" below for cancel reason</span>
          </div>
        </div>
      ))}
      {open.length === 0 && !loading
        ? <div style={{ textAlign: 'center', color: '#475569', padding: '48px 0', fontSize: 13 }}>No open positions</div>
        : [...open].sort((a, b) => new Date(b.openTime||b.openedAt||0) - new Date(a.openTime||a.openedAt||0)).map(t => {
          const isLong  = t.direction === 'LONG' || t.direction === 'long';
          const entry   = t.entryPrice ?? t.entry;
          const sl      = t.slPrice ?? t.sl;
          const tp      = t.tpPrice ?? t.tp;
          const units    = Math.abs(t.units || 0);
          const notional = units && entry ? units * entry : null;
          const oandaId  = String(t.oandaTradeId || t.oandaId || '');
          const margin   = liveMargins[oandaId] ?? null;
          const livePrice = livePrices[t.pair] || null;
          const rawPL    = livePrice && entry && units
            ? (isLong ? (livePrice - entry) : (entry - livePrice)) * units
            : null;
          const plSign   = rawPL != null ? (rawPL >= 0 ? '+' : '') : '';
          return (
            <div key={t.id} style={{ background: '#1e293b', borderRadius: 10, padding: 14, marginBottom: 10, border: `1px solid ${isLong?'#1e3a5f':'#3b0764'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span onClick={() => setChartPair(t.pair)}
                  style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc', cursor: 'pointer', textDecoration: 'underline dotted #475569' }}>
                  {isLong?'↗':'↘'} {(t.pair||'').replace('_','/')}
                </span>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: isLong?'#14532d':'#450a0a', color: isLong?'#4ade80':'#f87171', fontWeight: 700 }}>{t.direction?.toUpperCase?.() || 'LONG'}</span>
                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#0f172a', color: '#38bdf8' }}>{t.source?.includes('forexcom') ? 'Forex.com' : 'OANDA'}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: '#a78bfa', fontWeight: 600 }}>R:R 1:{t.rr?.toFixed?.(1) ?? '—'}</span>
              </div>
              {rawPL != null && (
                <div style={{ background: rawPL >= 0 ? '#14532d33' : '#450a0a33', border: `1px solid ${rawPL >= 0 ? '#22c55e44' : '#ef444444'}`, borderRadius: 8, padding: '8px 14px', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: '#64748b' }}>Live P&L @ {fmtPx(livePrice, t.pair)}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: rawPL >= 0 ? '#22c55e' : '#ef4444', fontFamily: 'monospace' }}>{plSign}{rawPL.toFixed(2)} USD</span>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
                {[{l:'Entry',v:fmtPx(entry,t.pair),c:'#e2e8f0'},{l:'SL',v:fmtPx(sl,t.pair),c:'#ef4444'},{l:'TP',v:fmtPx(tp,t.pair),c:'#22c55e'}].map(({l,v,c}) => (
                  <div key={l} style={{ background: '#0f172a', borderRadius: 6, padding: '8px 10px', textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#475569', marginBottom: 3 }}>{l}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: c, fontFamily: 'monospace' }}>{v}</div>
                  </div>
                ))}
              </div>
              {(notional || units) ? (
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <div style={{ background: '#0f172a', borderRadius: 6, padding: '6px 10px', flex: 1, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#475569', marginBottom: 2 }}>Units</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', fontFamily: 'monospace' }}>{units.toLocaleString()}</div>
                  </div>
                  {notional && <div style={{ background: '#0f172a', borderRadius: 6, padding: '6px 10px', flex: 1, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#475569', marginBottom: 2 }}>Trade Value</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', fontFamily: 'monospace' }}>${notional.toFixed(2)}</div>
                  </div>}
                  {margin && <div style={{ background: '#0f172a', borderRadius: 6, padding: '6px 10px', flex: 1, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#475569', marginBottom: 2 }}>Margin Used</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#fbbf24', fontFamily: 'monospace' }}>{margin.toFixed(2)}</div>
                  </div>}
                </div>
              ) : null}
              <div style={{ fontSize: 11, color: '#475569', marginBottom: 10 }}>
                {t.source || 'vps_bot'} · {fmtTime(t.openTime || t.openedAt)} · ID: {t.oandaTradeId || t.id}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button onClick={() => markClosed(t.id)} disabled={closing===t.id}
                  style={{ background: '#991b1b', border: 'none', color: '#fff', borderRadius: 6, padding: '6px 14px', fontSize: 11, cursor: 'pointer' }}>
                  {closing===t.id ? '…' : '✓ Mark Closed'}
                </button>
                {oandaId && entry != null && (
                  <button onClick={() => {
                    const bePrice = Number(entry).toFixed(dp(t.pair));
                    doModify(t.id, oandaId,
                      { stopLoss: { price: bePrice, timeInForce: 'GTC' } },
                      { sl: Number(entry), slPrice: Number(entry) }
                    );
                  }} disabled={getMS(t.id).busy}
                    style={{ background: '#f59e0b22', border: '1px solid #f59e0b88', color: '#fbbf24', borderRadius: 6, padding: '6px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                    ⚡ Breakeven
                  </button>
                )}
              </div>

              {oandaId && (
                <div style={{ marginTop: 10, borderTop: '1px solid #334155', paddingTop: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: '#475569', marginBottom: 3 }}>Adjust SL</div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input value={getMS(t.id).sl} onChange={e => setMS(t.id, { sl: e.target.value })}
                          placeholder={fmtPx(sl, t.pair)}
                          style={{ flex: 1, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '4px 6px', fontSize: 11, fontFamily: 'monospace', minWidth: 0 }}/>
                        <button onClick={() => {
                          const val = parseFloat(getMS(t.id).sl);
                          if (isNaN(val)) { setMS(t.id, { err: 'Invalid SL' }); return; }
                          doModify(t.id, oandaId,
                            { stopLoss: { price: val.toFixed(dp(t.pair)), timeInForce: 'GTC' } },
                            { sl: val, slPrice: val }
                          );
                          setMS(t.id, { sl: '' });
                        }} disabled={getMS(t.id).busy}
                          style={{ padding: '4px 8px', borderRadius: 4, background: '#ef444422', border: '1px solid #ef444488', color: '#f87171', fontSize: 10, cursor: 'pointer', whiteSpace: 'nowrap' }}>Set</button>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#475569', marginBottom: 3 }}>Adjust TP</div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input value={getMS(t.id).tp} onChange={e => setMS(t.id, { tp: e.target.value })}
                          placeholder={fmtPx(tp, t.pair)}
                          style={{ flex: 1, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '4px 6px', fontSize: 11, fontFamily: 'monospace', minWidth: 0 }}/>
                        <button onClick={() => {
                          const val = parseFloat(getMS(t.id).tp);
                          if (isNaN(val)) { setMS(t.id, { err: 'Invalid TP' }); return; }
                          doModify(t.id, oandaId,
                            { takeProfit: { price: val.toFixed(dp(t.pair)), timeInForce: 'GTC' } },
                            { tp: val, tpPrice: val }
                          );
                          setMS(t.id, { tp: '' });
                        }} disabled={getMS(t.id).busy}
                          style={{ padding: '4px 8px', borderRadius: 4, background: '#22c55e22', border: '1px solid #22c55e88', color: '#4ade80', fontSize: 10, cursor: 'pointer', whiteSpace: 'nowrap' }}>Set</button>
                      </div>
                    </div>
                  </div>

                  {/* Trailing SL */}
                  <div style={{ background: '#0f172a', borderRadius: 6, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: getMS(t.id).trailing ? 8 : 0 }}>
                      <div>
                        <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>Trailing SL</span>
                        <div style={{ fontSize: 9, color: '#475569', marginTop: 1 }}>Follows price in profit, locks gains</div>
                      </div>
                      <div onClick={() => setMS(t.id, { trailing: !getMS(t.id).trailing })}
                        style={{ width: 36, height: 20, borderRadius: 10, background: getMS(t.id).trailing ? '#a78bfa' : '#334155', cursor: 'pointer', position: 'relative', flexShrink: 0, marginLeft: 'auto' }}>
                        <span style={{ position: 'absolute', top: 2, left: getMS(t.id).trailing ? 18 : 2, width: 16, height: 16, borderRadius: 8, background: '#fff', display: 'block', transition: 'left 0.15s' }}/>
                      </div>
                    </div>
                    {getMS(t.id).trailing && (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #334155', flexShrink: 0 }}>
                          {['pip','price'].map(m => (
                            <button key={m} onClick={() => setMS(t.id, { trailMode: m })}
                              style={{ padding: '4px 8px', fontSize: 10, fontWeight: 600, cursor: 'pointer', border: 'none',
                                background: getMS(t.id).trailMode === m ? '#a78bfa' : '#1e293b',
                                color:      getMS(t.id).trailMode === m ? '#fff' : '#64748b' }}>
                              {m === 'pip' ? 'Pips' : 'Price'}
                            </button>
                          ))}
                        </div>
                        <input value={getMS(t.id).trailDist} onChange={e => setMS(t.id, { trailDist: e.target.value })}
                          placeholder={getMS(t.id).trailMode === 'pip' ? 'e.g. 20' : fmtPx(Math.abs((sl||0) - (entry||0)), t.pair)}
                          style={{ width: 70, background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '4px 6px', fontSize: 11, fontFamily: 'monospace' }}/>
                        <button onClick={() => {
                          const ms = getMS(t.id);
                          const val = parseFloat(ms.trailDist);
                          if (isNaN(val) || val <= 0) { setMS(t.id, { err: 'Enter a value' }); return; }
                          let dist;
                          if (ms.trailMode === 'price') {
                            dist = val.toFixed(dp(t.pair));
                          } else {
                            const pip = t.pair?.includes('JPY') ? 0.01 : t.pair?.includes('XAU') ? 1 : 0.0001;
                            dist = (val * pip).toFixed(dp(t.pair));
                          }
                          doModify(t.id, oandaId, { trailingStopLoss: { distance: dist, timeInForce: 'GTC' } });
                        }} disabled={getMS(t.id).busy}
                          style={{ padding: '4px 10px', borderRadius: 4, background: '#a78bfa22', border: '1px solid #a78bfa88', color: '#c4b5fd', fontSize: 10, cursor: 'pointer', whiteSpace: 'nowrap' }}>Set Trail</button>
                        <span style={{ fontSize: 9, color: '#475569' }}>
                          {getMS(t.id).trailMode === 'pip' ? 'pips behind current price' : 'price distance behind current price'}
                        </span>
                      </div>
                    )}
                  </div>
                  {getMS(t.id).err && (
                    <div style={{ fontSize: 11, color: '#f87171', background: '#450a0a', borderRadius: 4, padding: '4px 8px', marginTop: 6 }}>{getMS(t.id).err}</div>
                  )}
                </div>
              )}
            </div>
          );
        })
      }

      {/* ── OANDA Order Activity ──────────────────────────────────────── */}
      <div style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ fontWeight: 700, color: '#f8fafc', fontSize: 15 }}>Order Activity</span>
          <button onClick={fetchActivity} disabled={actLoading}
            style={{ background: '#334155', border: 'none', color: '#94a3b8', padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
            {actLoading ? 'Loading…' : 'Check OANDA Activity'}
          </button>
        </div>
        {actErr && <div style={{ background: '#450a0a', color: '#fca5a5', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 10 }}>{actErr}</div>}
        {activity.length === 0 && !actLoading && !actErr && (
          <div style={{ fontSize: 12, color: '#475569' }}>Tap "Check OANDA Activity" to see cancelled orders and fill reasons</div>
        )}
        {activity.map((tx, i) => {
          const isCancelled = tx.type === 'ORDER_CANCEL' || tx.type === 'MARKET_ORDER_REJECT';
          const isFill      = tx.type === 'ORDER_FILL';
          const isSL        = tx.type === 'STOP_LOSS_ORDER';
          const isTP        = tx.type === 'TAKE_PROFIT_ORDER';
          const color       = isCancelled ? '#ef4444' : isFill ? '#22c55e' : isSL ? '#f59e0b' : isTP ? '#a78bfa' : '#94a3b8';
          const icon        = isCancelled ? '✗' : isFill ? '✓' : isSL ? 'SL' : isTP ? 'TP' : '·';
          const label       = isCancelled ? 'CANCELLED' : isFill ? 'FILLED' : isSL ? 'STOP LOSS' : isTP ? 'TAKE PROFIT' : tx.type?.replace(/_/g,' ');
          const reason      = isCancelled ? explainReason(tx.reason || tx.rejectReason) : null;
          const timeStr     = tx.time ? new Date(tx.time).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
          const dateStr     = tx.time ? new Date(tx.time).toLocaleDateString([], { month:'short', day:'numeric' }) : '';
          return (
            <div key={tx.id || i} style={{ background: '#1e293b', borderRadius: 8, padding: '10px 14px', marginBottom: 6, border: `1px solid ${isCancelled ? '#7f1d1d' : isFill ? '#14532d' : '#334155'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color }}>{icon}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color, padding: '1px 6px', borderRadius: 3, background: `${color}22` }}>{label}</span>
                {tx.instrument && <span style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 600 }}>{tx.instrument.replace('_','/')}</span>}
                {tx.units && <span style={{ fontSize: 11, color: '#64748b' }}>{parseInt(tx.units) > 0 ? '▲' : '▼'} {Math.abs(tx.units)} units</span>}
                <span style={{ marginLeft: 'auto', fontSize: 10, color: '#475569' }}>{dateStr} {timeStr}</span>
              </div>
              {reason && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#fca5a5', background: '#450a0a', borderRadius: 4, padding: '4px 8px', lineHeight: 1.5 }}>
                  Reason: {reason}
                </div>
              )}
              {isFill && tx.price && (
                <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8' }}>
                  Filled @ <span style={{ color: '#22c55e', fontFamily: 'monospace' }}>{tx.price}</span>
                  {tx.pl != null && <span style={{ marginLeft: 8, color: parseFloat(tx.pl) >= 0 ? '#22c55e' : '#ef4444' }}>P&L: {parseFloat(tx.pl) >= 0 ? '+' : ''}{parseFloat(tx.pl).toFixed(2)}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── VPS Bot tab ───────────────────────────────────────────────────────────────
function VPSBotTab({ onLog }) {
  const [botStatus, setBotStatus] = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [msg,       setMsg]       = useState('');
  const [err,       setErr]       = useState('');
  const [copied,    setCopied]    = useState('');
  const [step,      setStep]      = useState('setup'); // setup | deploy | control

  const copy = (text, key) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(''), 2000); });
  };

  const refreshStatus = async () => {
    setLoading(true); setErr('');
    try {
      const [stratData, ctrlData, tradesData] = await Promise.all([
        ghRead('bot/strategy.json').catch(() => null),
        ghRead('bot/vps-control.json').catch(() => null),
        ghRead('bot/trades.json').catch(() => null),
      ]);
      const trades = tradesData?.content?.trades || [];
      const botTrades = trades.filter(t => t.source === 'vps_bot');
      setBotStatus({
        control:   ctrlData?.content?.command || 'unknown',
        sentAt:    ctrlData?.content?.sentAt,
        totalBotTrades: botTrades.length,
        openBotTrades:  botTrades.filter(t => t.status === 'open' || t.status === 'OPEN').length,
        hasStrategy: !!stratData,
      });
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const sendControl = async (command) => {
    setSaving(true); setErr('');
    try {
      const existing = await ghRead('bot/vps-control.json', { noCache: true }).catch(() => null);
      await ghWrite('bot/vps-control.json', { command, sentAt: new Date().toISOString() }, `VPS control: ${command}`, existing?.sha || null);
      setBotStatus(s => ({ ...s, control: command }));
      setMsg(`Command "${command}" sent to bot`); onLog?.('INFO', `VPS: ${command}`);
      setTimeout(() => setMsg(''), 3000);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const ctrlColor = { running: '#22c55e', paused: '#f59e0b', stopped: '#ef4444', unknown: '#475569' }[botStatus?.control] || '#475569';
  const ctrlLabel = { running: '● Running', paused: '⏸ Paused', stopped: '■ Stopped', unknown: '? Unknown' }[botStatus?.control] || '? Unknown';

  const VPS_PROVIDERS = [
    { name: 'Hetzner',      price: '€3.29/mo', url: 'hetzner.com',      note: '✓ You have this', highlight: true },
    { name: 'DigitalOcean', price: '$4/mo',    url: 'digitalocean.com', note: 'Easiest setup' },
    { name: 'Vultr',        price: '$2.50/mo', url: 'vultr.com',        note: 'Cheapest' },
    { name: 'Linode',       price: '$5/mo',    url: 'linode.com',       note: 'Reliable' },
  ];

  const SETUP_CMDS = [
    { key: 'clone', label: '1. Download bot code', cmd: 'git clone https://github.com/amandeep97/Forex.git && cd Forex/vps-bot' },
    { key: 'install', label: '2. Install dependencies', cmd: 'npm install' },
    { key: 'env', label: '3. Create config file', cmd: 'cp .env.example .env && nano .env' },
    { key: 'pm2', label: '4. Install PM2 (keeps bot alive)', cmd: 'npm install -g pm2' },
    { key: 'start', label: '5. Start bot', cmd: 'pm2 start ecosystem.config.js && pm2 save && pm2 startup' },
    { key: 'logs', label: '6. Watch live logs', cmd: 'pm2 logs forex-bot' },
  ];

  const ENV_CONTENT = `OANDA_API_KEY=${localStorage.getItem('oanda_key') || 'your_oanda_api_key'}
OANDA_ACCOUNT_ID=${localStorage.getItem('oanda_acct') || 'your_account_id'}
OANDA_PRACTICE=${localStorage.getItem('oanda_env') === 'live' ? 'false' : 'true'}

GITHUB_TOKEN=ghp_your_github_personal_access_token
GITHUB_OWNER=amandeep97
GITHUB_REPO=Forex
GITHUB_BRANCH=main

TELEGRAM_BOT_TOKEN=optional_leave_blank_to_skip
TELEGRAM_CHAT_ID=optional_leave_blank_to_skip

BOT_INTERVAL_MS=60000`;

  return (
    <div style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg,#1e3a5f,#1e1b4b)', borderRadius: 12, padding: 16, marginBottom: 14, border: '1px solid #2563eb44' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc', marginBottom: 4 }}>🤖 VPS Auto-Trade Bot</div>
        <div style={{ fontSize: 12, color: '#93c5fd', lineHeight: 1.7 }}>
          Runs 24/7 on a cheap server — scans pairs every minute, places trades automatically even when your phone is off.
        </div>
      </div>

      {/* Step tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[['setup','1. Get VPS'],['deploy','2. Deploy'],['control','3. Control']].map(([id, label]) => (
          <button key={id} onClick={() => setStep(id)}
            style={{ flex: 1, padding: '8px 4px', borderRadius: 8, border: `1px solid ${step===id?'#2563eb':'#334155'}`,
              background: step===id ? '#1d4ed8' : '#1e293b', color: step===id ? '#fff' : '#64748b',
              fontSize: 12, fontWeight: step===id ? 700 : 400, cursor: 'pointer' }}>
            {label}
          </button>
        ))}
      </div>

      {/* Step 1: Get VPS */}
      {step === 'setup' && (
        <div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12, lineHeight: 1.7 }}>
            You need a Linux VPS (Ubuntu 22.04) — costs $2–5/month. Pick any provider:
          </div>
          {VPS_PROVIDERS.map(p => (
            <div key={p.name} style={{ background: p.highlight ? '#14532d22' : '#1e293b', borderRadius: 8, padding: '12px 14px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${p.highlight ? '#22c55e44' : 'transparent'}` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: p.highlight ? '#4ade80' : '#f8fafc', fontSize: 13 }}>{p.name}</div>
                <div style={{ fontSize: 11, color: p.highlight ? '#86efac' : '#64748b' }}>{p.note} · {p.url}</div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#22c55e' }}>{p.price}</div>
            </div>
          ))}
          <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, marginTop: 14, fontSize: 12, color: '#64748b', lineHeight: 1.8 }}>
            <div style={{ color: '#f8fafc', fontWeight: 600, marginBottom: 6 }}>After signing up:</div>
            <div>1. Create a server — choose <strong style={{color:'#93c5fd'}}>Ubuntu 22.04</strong></div>
            <div>2. Connect via SSH: <code style={{color:'#a5b4fc'}}>ssh root@your-server-ip</code></div>
            <div>3. Install Node.js:</div>
            <div style={{ background: '#1e293b', borderRadius: 6, padding: '6px 10px', marginTop: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <code style={{ fontSize: 11, color: '#94a3b8' }}>curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs git</code>
              <button onClick={() => copy('curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs git', 'node')}
                style={{ background: copied==='node'?'#14532d':'#334155', border:'none', color: copied==='node'?'#4ade80':'#94a3b8', borderRadius:4, padding:'3px 8px', fontSize:10, cursor:'pointer', whiteSpace:'nowrap', marginLeft:8 }}>
                {copied==='node' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ marginTop: 6 }}>4. Then go to <strong style={{color:'#93c5fd'}}>Step 2 → Deploy</strong></div>
          </div>
        </div>
      )}

      {/* Step 2: Deploy */}
      {step === 'deploy' && (
        <div>
          {SETUP_CMDS.map(({ key, label, cmd }) => (
            <div key={key} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{label}</div>
              <div style={{ background: '#0f172a', borderRadius: 6, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <code style={{ fontSize: 11, color: '#94a3b8', flex: 1, wordBreak: 'break-all' }}>{cmd}</code>
                <button onClick={() => copy(cmd, key)}
                  style={{ background: copied===key?'#14532d':'#334155', border:'none', color:copied===key?'#4ade80':'#94a3b8', borderRadius:4, padding:'4px 10px', fontSize:10, cursor:'pointer', whiteSpace:'nowrap', flexShrink:0 }}>
                  {copied===key ? '✓' : 'Copy'}
                </button>
              </div>
            </div>
          ))}

          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 6, fontWeight: 600 }}>📋 .env file contents (pre-filled with your OANDA keys)</div>
            <div style={{ background: '#0f172a', borderRadius: 6, padding: '10px 12px', position: 'relative' }}>
              <pre style={{ fontSize: 10, color: '#94a3b8', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{ENV_CONTENT}</pre>
              <button onClick={() => copy(ENV_CONTENT, 'env')}
                style={{ position: 'absolute', top: 8, right: 8, background: copied==='env'?'#14532d':'#334155', border:'none', color:copied==='env'?'#4ade80':'#94a3b8', borderRadius:4, padding:'4px 10px', fontSize:10, cursor:'pointer' }}>
                {copied==='env' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#475569', marginTop: 6 }}>
              Paste this into the .env file. Add your GitHub PAT from github.com/settings/tokens (repo scope).
            </div>
          </div>

          <div style={{ background: '#14532d33', border: '1px solid #22c55e44', borderRadius: 8, padding: 12, marginTop: 14 }}>
            <div style={{ fontSize: 12, color: '#4ade80', fontWeight: 600, marginBottom: 4 }}>✓ Bot is running when you see:</div>
            <code style={{ fontSize: 11, color: '#86efac' }}>ForexPro VPS Bot starting — interval 60s</code>
          </div>
        </div>
      )}

      {/* Step 3: Control */}
      {step === 'control' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>Remote control via GitHub — bot checks every minute</div>
            <button onClick={refreshStatus} disabled={loading}
              style={{ background:'#334155', border:'none', color:'#94a3b8', padding:'5px 12px', borderRadius:6, fontSize:11, cursor:'pointer' }}>
              {loading ? '…' : 'Refresh'}
            </button>
          </div>

          {botStatus ? (
            <div style={{ background: '#1e293b', borderRadius: 10, padding: 14, marginBottom: 14, border: `1px solid ${ctrlColor}44` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: ctrlColor }}>{ctrlLabel}</span>
                {botStatus.sentAt && <span style={{ fontSize: 11, color: '#475569' }}>since {new Date(botStatus.sentAt).toLocaleTimeString()}</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ background: '#0f172a', borderRadius: 6, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#475569', marginBottom: 2 }}>Bot Trades Total</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#f8fafc' }}>{botStatus.totalBotTrades}</div>
                </div>
                <div style={{ background: '#0f172a', borderRadius: 6, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#475569', marginBottom: 2 }}>Currently Open</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#22c55e' }}>{botStatus.openBotTrades}</div>
                </div>
              </div>
              {!botStatus.hasStrategy && (
                <div style={{ marginTop: 10, fontSize: 11, color: '#f59e0b' }}>⚠ No strategy.json found — configure in Strategy Config tab first</div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#475569', marginBottom: 14 }}>Tap Refresh to check bot status</div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button onClick={() => sendControl('running')} disabled={saving} style={{ ...BTN({ background:'#14532d', color:'#4ade80' }), flex:1, justifyContent:'center' }}>▶ Resume</button>
            <button onClick={() => sendControl('paused')}  disabled={saving} style={{ ...BTN({ background:'#78350f', color:'#fbbf24' }), flex:1, justifyContent:'center' }}>⏸ Pause</button>
            <button onClick={() => sendControl('stopped')} disabled={saving} style={{ ...BTN({ background:'#450a0a', color:'#ef4444' }), flex:1, justifyContent:'center' }}>■ Stop</button>
          </div>
          {msg && <div style={{ fontSize: 12, color: '#22c55e', marginBottom: 8 }}>{msg}</div>}
          {err && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 8 }}>{err}</div>}

          <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, fontSize: 12, color: '#64748b', lineHeight: 1.8 }}>
            <div style={{ color: '#f8fafc', fontWeight: 600, marginBottom: 6 }}>Useful PM2 commands on your VPS:</div>
            {[
              ['pm2 logs forex-bot', 'See live logs'],
              ['pm2 restart forex-bot', 'Restart bot'],
              ['pm2 stop forex-bot', 'Stop bot'],
              ['pm2 status', 'Check if running'],
            ].map(([cmd, desc]) => (
              <div key={cmd} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <code style={{ color: '#a5b4fc', fontSize: 11, flex: 1 }}>{cmd}</code>
                <span style={{ color: '#475569', fontSize: 10 }}>{desc}</span>
                <button onClick={() => copy(cmd, cmd)}
                  style={{ background: copied===cmd?'#14532d':'#1e293b', border:'none', color:copied===cmd?'#4ade80':'#475569', borderRadius:3, padding:'2px 6px', fontSize:9, cursor:'pointer' }}>
                  {copied===cmd?'✓':'Copy'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Log tab ───────────────────────────────────────────────────────────────────
const TAG = { INFO:{bg:'#1e3a5f',color:'#93c5fd'}, SUCCESS:{bg:'#14532d',color:'#86efac'}, ERROR:{bg:'#450a0a',color:'#fca5a5'}, TRADE:{bg:'#1e1b4b',color:'#a5b4fc'} };

function LogTab({ entries, onClear }) {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <span style={{ fontWeight:700, color:'#f8fafc', fontSize:15 }}>Activity Log</span>
        <button onClick={onClear} style={{ background:'#991b1b', border:'none', color:'#fff', borderRadius:6, padding:'5px 14px', fontSize:11, cursor:'pointer' }}>Clear</button>
      </div>
      {entries.length === 0
        ? <div style={{ textAlign:'center', color:'#475569', padding:'48px 0' }}>No activity yet</div>
        : <div style={{ background:'#1e293b', borderRadius:10, overflow:'hidden' }}>
            {[...entries].reverse().map((e, i) => {
              const s = TAG[e.type] || TAG.INFO;
              return (
                <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start', padding:'10px 14px', borderBottom:'1px solid #0f172a' }}>
                  <span style={{ fontSize:10, fontWeight:700, padding:'2px 6px', borderRadius:3, background:s.bg, color:s.color, whiteSpace:'nowrap', marginTop:1 }}>{e.type}</span>
                  <span style={{ flex:1, fontSize:12, color:'#cbd5e1' }}>{e.msg}</span>
                  <span style={{ fontSize:10, color:'#475569', whiteSpace:'nowrap' }}>{new Date(e.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>
                </div>
              );
            })}
          </div>
      }
    </div>
  );
}

// ── Main AutoTrading ──────────────────────────────────────────────────────────
export default function AutoTrading({ accountMode = 'demo' }) {
  const isReal       = accountMode === 'real';
  const [activeTab,  setActiveTab]  = useState(() => localStorage.getItem('fp_active_tab') || 'connect');
  const [logEntries, setLogEntries] = useState(() => {
    try { return JSON.parse(localStorage.getItem('fp_activity_log') || '[]'); } catch { return []; }
  });
  const [signalPair, setSignalPair] = useState(null);
  const [autoExecute, setAutoExecute] = useState(false);
  const autoLogRef = useRef(new Set());

  const addLog = useCallback((type, msg) => {
    setLogEntries(prev => {
      const next = [...prev, { type, msg, ts: Date.now() }].slice(-100); // keep last 100
      try { localStorage.setItem('fp_activity_log', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // Listen for tap-to-trade events from BotConfig scan chips
  useEffect(() => {
    const handler = (e) => { setSignalPair(e.detail?.pair || null); setActiveTab('connect'); };
    window.addEventListener('trade-signal-pair', handler);
    return () => window.removeEventListener('trade-signal-pair', handler);
  }, []);

  // Auto-execute: place trade when strategy scan finds a match
  const handleAutoTrade = useCallback(async ({ pair, strat, tradeParams }) => {
    if (!tradeParams) return;
    const key = autoLogRef.current;
    const tradeKey = `${pair}-${strat.id}`;
    if (key.has(tradeKey)) return; // already fired this session
    key.add(tradeKey);

    const apiKey   = localStorage.getItem('oanda_key');
    const accountId = localStorage.getItem('oanda_acct');
    const env_     = localStorage.getItem('oanda_env') || 'practice';
    if (!apiKey || !accountId) { addLog('ERROR', `Auto-execute: OANDA not connected (${pair})`); return; }

    const { dir, entry, sl, tp, riskPercent } = tradeParams;
    addLog('TRADE', `Auto-executing ${dir} ${pair.replace('_','/')} @ ${entry?.toFixed(dp(pair))} | SL ${sl?.toFixed(dp(pair))} | TP ${tp?.toFixed(dp(pair))}`);
    try {
      const acct_   = await oandaAccount(apiKey, accountId, env_);
      const units   = calcUnits(acct_.balance, riskPercent || 1, entry, sl, pair, acct_.marginAvailable, acct_.leverage);
      const signedU  = dir === 'LONG' ? units : -units;
      const tradeId  = await oandaPlaceOrder(apiKey, accountId, env_, pair, signedU, sl, tp);
      addLog('SUCCESS', `Auto-trade placed — ${pair.replace('_','/')} ID: ${tradeId}`);
      // Log to GitHub
      try {
        const gh = await ghRead('bot/trades.json', { noCache: true });
        const log = gh?.content?.trades || [];
        log.push({ id: `auto_${Date.now()}`, source: 'browser_auto', pair, direction: dir,
          entryPrice: entry, slPrice: sl, tpPrice: tp, units: signedU, oandaTradeId: tradeId,
          openTime: new Date().toISOString(), status: 'OPEN', rr: tradeParams.rr, strategyName: strat.name });
        await ghWrite('bot/trades.json', { trades: log }, `Auto: ${dir} ${pair}`, gh?.sha || null);
      } catch {}
    } catch (e) { addLog('ERROR', `Auto-trade failed (${pair}): ${e.message}`); }
  }, [addLog]);

  // Reset auto-trade dedup when autoExecute turns off
  useEffect(() => { if (!autoExecute) autoLogRef.current = new Set(); }, [autoExecute]);

  const TABS = [
    { id: 'connect',   label: 'Connect Exchange' },
    { id: 'config',    label: 'Strategy Config' },
    { id: 'positions', label: 'Positions' },
    { id: 'vpsbot',    label: 'VPS Bot' },
    { id: 'log',       label: logEntries.length ? `Log (${logEntries.length})` : 'Log' },
  ];

  return (
    <div style={{ background: '#0f172a', minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      {isReal && (
        <div style={{ background: '#7f1d1d', padding: '6px 20px', fontSize: 12, color: '#fca5a5' }}>
          ⚠️ Real Money Mode — trades execute with real funds
        </div>
      )}

      {/* Header */}
      <div style={{ padding: '16px 20px 0', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#f8fafc' }}>Auto Trading</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>Strategy-based auto-execution on OANDA · Forex.com</p>
        </div>
        {/* Auto-Execute toggle */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: autoExecute ? '#22c55e' : '#64748b' }}>
              Auto-Execute
            </span>
            <Toggle checked={autoExecute} onChange={setAutoExecute} />
          </div>
          {autoExecute && (
            <span style={{ fontSize: 10, color: '#f59e0b', maxWidth: 160, textAlign: 'right', lineHeight: 1.4 }}>
              ⚡ Live — will place trades automatically when strategy matches
            </span>
          )}
        </div>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', padding: '10px 20px 0', borderBottom: '2px solid #1e293b', overflowX: 'auto', gap: 2 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setActiveTab(t.id); localStorage.setItem('fp_active_tab', t.id); }}
            style={{ background: activeTab===t.id ? '#2563eb' : 'transparent', border: 'none',
              color: activeTab===t.id ? '#fff' : '#64748b', padding: '8px 16px',
              borderRadius: activeTab===t.id ? '8px 8px 0 0' : '6px 6px 0 0',
              fontSize: 13, cursor: 'pointer', fontWeight: activeTab===t.id ? 600 : 400,
              whiteSpace: 'nowrap', transition: 'all 0.15s' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {activeTab === 'connect'   && <ConnectTab onLog={addLog} signalPair={signalPair} onSignalUsed={() => setSignalPair(null)} />}
        {activeTab === 'config'    && <BotConfig autoExecute={autoExecute} onAutoTrade={handleAutoTrade} />}
        {activeTab === 'positions' && <PositionsTab onLog={addLog} />}
        {activeTab === 'vpsbot'    && <VPSBotTab onLog={addLog} />}
        {activeTab === 'log'       && <LogTab entries={logEntries} onClear={() => { setLogEntries([]); localStorage.removeItem('fp_activity_log'); }} />}
      </div>
    </div>
  );
}

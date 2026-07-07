'use strict';
import { useState, useEffect } from 'react';
import { ALERT_INSTRUMENTS, instBySym, fetchPrice } from '../utils/alertFeed';
import { showBrowserNotification, requestBrowserPermission, sendTelegram } from '../utils/notifications';
import { loadAlerts, saveAlerts, loadLog, notifCfg, saveNotifCfg, LOG_LS, POLL_MS } from '../hooks/useAlertsEngine';
import { enableBackgroundPush, disableBackgroundPush, isPushEnabled, syncAlertsToBot, pushSupported } from '../utils/webPush';
import { getPatternN, setPatternN } from '../utils/candlePatterns';

// ── UI helpers ────────────────────────────────────────────────────────────────
const inp = (s={}) => ({ background:'#0f172a', color:'#e2e8f0', border:'1px solid #334155', borderRadius:8,
  padding:'9px 11px', fontSize:13, outline:'none', width:'100%', boxSizing:'border-box', ...s });
const lbl = { fontSize:10, color:'#64748b', fontWeight:700, marginBottom:4, display:'block', textTransform:'uppercase', letterSpacing:'0.04em' };

// ── Alerts Center modal ───────────────────────────────────────────────────────
export default function AlertsCenter({ onClose }) {
  const [alerts, setAlerts] = useState(loadAlerts);
  const [log, setLog]       = useState(loadLog);
  const [tab, setTab]       = useState('list');
  const [cfg, setCfg]       = useState(notifCfg);

  // New-alert form state
  const [type, setType] = useState('price');
  const [sym, setSym]   = useState('EUR/USD');
  const [dir, setDir]   = useState('cross');
  const [level, setLevel] = useState('');
  const [top, setTop]   = useState('');
  const [bottom, setBottom] = useState('');
  const [tf, setTf]     = useState('H1');
  const [closeDir, setCloseDir] = useState('above');
  const [patternKind, setPatternKind] = useState('both'); // both | hammer | star
  const [patN, setPatN] = useState(() => getPatternN());
  const [repeat, setRepeat] = useState(false);
  const [cur, setCur]   = useState(null);
  const [permMsg, setPermMsg] = useState('');
  const [pushOn, setPushOn]   = useState(isPushEnabled);
  const [pushMsg, setPushMsg] = useState('');
  const [pushBusy, setPushBusy] = useState(false);

  const inst = instBySym(sym);

  useEffect(() => {
    const refresh = () => { setAlerts(loadAlerts()); setLog(loadLog()); };
    window.addEventListener('alerts-updated', refresh);
    return () => window.removeEventListener('alerts-updated', refresh);
  }, []);

  // TF options — OANDA has no 3-min; Binance (crypto) has 3m but no 2m
  const isCrypto = !!inst?.binance;
  const TF_OPTIONS = isCrypto
    ? ['M1','M3','M5','M15','M30','H1','H4','D']
    : ['M1','M5','M15','M30','H1','H4','D'];

  // Show current price when picking instrument; clamp TF if it's no longer valid
  useEffect(() => {
    let on = true; setCur(null);
    fetchPrice(inst).then(p => { if (on) setCur(p); });
    if (!TF_OPTIONS.includes(tf)) setTf('M5');
    return () => { on = false; };
  }, [sym]); // eslint-disable-line

  const persist = (next) => { setAlerts(next); saveAlerts(next); if (isPushEnabled()) syncAlertsToBot().catch(() => {}); };

  const toggleBackgroundPush = async () => {
    setPushBusy(true); setPushMsg('');
    const r = pushOn ? await disableBackgroundPush() : await enableBackgroundPush();
    setPushOn(isPushEnabled());
    setPushMsg((r.ok ? '✓ ' : '✗ ') + r.msg);
    setPushBusy(false);
  };
  const resyncAlerts = async () => {
    setPushBusy(true);
    const r = await syncAlertsToBot();
    setPushMsg((r.ok ? '✓ ' : '✗ ') + r.msg);
    setPushBusy(false);
  };

  const addAlert = () => {
    const id = `al_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const base = { id, type, sym, repeat, enabled:true, createdAt:Date.now(), lastTriggered:null };
    let a = null;
    if (type === 'price') { if (!(parseFloat(level) > 0)) return; a = { ...base, level:parseFloat(level), dir }; }
    if (type === 'zone')  { const t=parseFloat(top), b=parseFloat(bottom); if (!(t>0)||!(b>0)) return; a = { ...base, top:Math.max(t,b), bottom:Math.min(t,b) }; }
    if (type === 'candle'){ if (!(parseFloat(level) > 0)) return; a = { ...base, tf, closeDir, level:parseFloat(level), lastCandleT:null }; }
    if (type === 'pattern'){ const N = setPatternN(patN); a = { ...base, tf, pattern:patternKind, N, lastCandleT:null }; }
    if (!a) return;
    persist([a, ...alerts]);
    setLevel(''); setTop(''); setBottom('');
    setTab('list');
  };

  const toggle = (id) => persist(alerts.map(a => a.id === id ? { ...a, enabled: !a.enabled } : a));
  const del    = (id) => persist(alerts.filter(a => a.id !== id));
  const clearLog = () => { localStorage.setItem(LOG_LS, '[]'); setLog([]); };

  const saveCfg = (patch) => { const n = { ...cfg, ...patch }; setCfg(n); saveNotifCfg(n); };
  const enableBrowser = async () => {
    const r = await requestBrowserPermission();
    setPermMsg(r === 'granted' ? '✓ Browser notifications on' : r === 'denied' ? '✗ Blocked — allow in browser settings' : '✗ Not supported');
  };
  const testNotif = () => {
    showBrowserNotification('🔔 ForexPro test', 'Alerts are working.');
    if (cfg.botToken && cfg.chatId) sendTelegram(cfg.botToken, cfg.chatId, '🔔 ForexPro test alert — working.');
  };

  const describe = (a) => {
    if (a.type === 'price')  return `Price ${a.dir === 'above' ? 'crosses above' : a.dir === 'below' ? 'crosses below' : 'touches'} ${a.level}`;
    if (a.type === 'zone')   return `Price enters zone ${a.bottom} – ${a.top}`;
    if (a.type === 'candle') return `${a.tf} candle closes ${a.closeDir} ${a.level}`;
    if (a.type === 'trendline') return `Price crosses your drawn trendline`;
    if (a.type === 'pattern') return `${a.tf} ${a.pattern === 'hammer' ? 'Strong Hammer 🔨' : a.pattern === 'star' ? 'Strong Shooting Star ⭐' : 'Strong Hammer/Star ⚡'} (${a.N || 5}-bar sweep)`;
    return '';
  };

  const TYPES = [['price','🎯 Price'],['pattern','⚡ Strong candle'],['candle','🕯️ Candle close'],['zone','✏️ Line / Zone']];
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.82)', display:'flex',
      alignItems:'flex-start', justifyContent:'center', zIndex:5000, padding:'34px 14px', overflowY:'auto' }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:'#0b111e', border:'1px solid #1e293b', borderRadius:16,
        width:'100%', maxWidth:470, padding:'18px 20px' }}>

        <div style={{ display:'flex', alignItems:'center', marginBottom:4 }}>
          <div style={{ fontSize:16, fontWeight:800, color:'#f8fafc', flex:1 }}>🔔 Alerts Center</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#64748b', fontSize:24, cursor:'pointer', lineHeight:1 }}>×</button>
        </div>
        <div style={{ fontSize:10, color:'#475569', marginBottom:14 }}>
          Fires browser + Telegram alerts while the app/PWA is open.
        </div>

        <div style={{ display:'flex', gap:6, marginBottom:16 }}>
          {[['list',`Alerts (${alerts.length})`],['new','+ New'],['log','History'],['setup','⚙ Notify']].map(([id,l]) => (
            <button key={id} onClick={()=>setTab(id)} style={{ flex:1, padding:'7px 0', borderRadius:8, fontSize:11, fontWeight:700,
              cursor:'pointer', border:`1px solid ${tab===id?'#00d4aa55':'#1e293b'}`, background: tab===id?'#00d4aa14':'#0f172a',
              color: tab===id?'#00d4aa':'#64748b' }}>{l}</button>
          ))}
        </div>

        {/* ── New alert ── */}
        {tab === 'new' && (
          <>
            <label style={lbl}>Alert type</label>
            <div style={{ display:'flex', gap:6, marginBottom:12 }}>
              {TYPES.map(([id,l]) => (
                <button key={id} onClick={()=>setType(id)} style={{ flex:1, padding:'7px 0', borderRadius:8, fontSize:11, fontWeight:700,
                  cursor:'pointer', border:`1px solid ${type===id?'#00d4aa55':'#1e293b'}`, background: type===id?'#00d4aa14':'#0f172a',
                  color: type===id?'#00d4aa':'#64748b' }}>{l}</button>
              ))}
            </div>

            <label style={lbl}>Instrument</label>
            <select value={sym} onChange={e=>setSym(e.target.value)} style={{ ...inp(), marginBottom:4 }}>
              {ALERT_INSTRUMENTS.map(i => <option key={i.sym}>{i.sym}</option>)}
            </select>
            <div style={{ fontSize:10, color: cur ? '#00d4aa' : '#475569', marginBottom:12 }}>
              {cur != null ? `Current price: ${cur.toFixed(inst.dec)}` : 'Fetching current price… (needs OANDA key for FX/metals/indices)'}
            </div>

            {type === 'price' && (
              <>
                <label style={lbl}>Condition</label>
                <div style={{ display:'flex', gap:6, marginBottom:10 }}>
                  {[['above','Crosses ↑ above'],['below','Crosses ↓ below'],['cross','Touches (either)']].map(([id,l]) => (
                    <button key={id} onClick={()=>setDir(id)} style={{ flex:1, padding:'7px 0', borderRadius:7, fontSize:10, fontWeight:700,
                      cursor:'pointer', border:`1px solid ${dir===id?'#00d4aa55':'#1e293b'}`, background:dir===id?'#00d4aa14':'#0f172a',
                      color:dir===id?'#00d4aa':'#64748b' }}>{l}</button>
                  ))}
                </div>
                <label style={lbl}>Price level</label>
                <input type="number" step="any" value={level} onChange={e=>setLevel(e.target.value)} placeholder="e.g. 1.08500" style={{ ...inp(), marginBottom:12 }}/>
              </>
            )}

            {type === 'zone' && (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:12 }}>
                <div><label style={lbl}>Zone top</label>
                  <input type="number" step="any" value={top} onChange={e=>setTop(e.target.value)} placeholder="upper" style={inp()}/></div>
                <div><label style={lbl}>Zone bottom</label>
                  <input type="number" step="any" value={bottom} onChange={e=>setBottom(e.target.value)} placeholder="lower" style={inp()}/></div>
              </div>
            )}

            {type === 'candle' && (
              <>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}>
                  <div><label style={lbl}>Timeframe</label>
                    <select value={tf} onChange={e=>setTf(e.target.value)} style={inp()}>
                      {TF_OPTIONS.map(t => <option key={t}>{t}</option>)}
                    </select></div>
                  <div><label style={lbl}>Close direction</label>
                    <select value={closeDir} onChange={e=>setCloseDir(e.target.value)} style={inp()}>
                      <option value="above">closes above</option>
                      <option value="below">closes below</option>
                    </select></div>
                </div>
                <label style={lbl}>Price level</label>
                <input type="number" step="any" value={level} onChange={e=>setLevel(e.target.value)} placeholder="e.g. 1.08500" style={{ ...inp(), marginBottom:12 }}/>
              </>
            )}

            {type === 'pattern' && (
              <>
                <label style={lbl}>Which pattern</label>
                <div style={{ display:'flex', gap:6, marginBottom:10 }}>
                  {[['both','⚡ Both'],['hammer','🔨 Strong Hammer'],['star','⭐ Shooting Star']].map(([id,l]) => (
                    <button key={id} onClick={()=>setPatternKind(id)} style={{ flex:1, padding:'7px 0', borderRadius:7, fontSize:10, fontWeight:700,
                      cursor:'pointer', border:`1px solid ${patternKind===id?'#22d3ee66':'#1e293b'}`, background:patternKind===id?'#22d3ee14':'#0f172a',
                      color:patternKind===id?'#22d3ee':'#64748b' }}>{l}</button>
                  ))}
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}>
                  <div><label style={lbl}>Timeframe</label>
                    <select value={tf} onChange={e=>setTf(e.target.value)} style={inp()}>
                      {TF_OPTIONS.map(t => <option key={t}>{t}</option>)}
                    </select></div>
                  <div><label style={lbl}>Range = last N candles</label>
                    <input type="number" min="2" max="30" value={patN} onChange={e=>setPatN(e.target.value)} style={inp()}/></div>
                </div>
                <div style={{ fontSize:9.5, color:'#475569', marginBottom:12, lineHeight:1.5 }}>
                  Fires when a candle's wick clears the whole last-{patN} range and closes back inside (a full-range liquidity sweep). N also controls the chart markers.
                </div>
              </>
            )}

            <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:11, color:'#94a3b8', marginBottom:14, cursor:'pointer' }}>
              <input type="checkbox" checked={repeat} onChange={e=>setRepeat(e.target.checked)}/>
              Repeat (keep alerting) — off = fire once then disable
            </label>

            <button onClick={addAlert} style={{ width:'100%', padding:'10px 0', borderRadius:9, fontSize:13, fontWeight:800,
              cursor:'pointer', background:'#00d4aa', color:'#080c14', border:'none' }}>+ Create alert</button>

            {type === 'zone' && (
              <div style={{ fontSize:9.5, color:'#475569', marginTop:10, lineHeight:1.5 }}>
                ✏️ Horizontal lines & supply/demand zones supported. Diagonal trendline-on-chart drawing is a planned next phase.
              </div>
            )}
          </>
        )}

        {/* ── List ── */}
        {tab === 'list' && (
          alerts.length === 0 ? (
            <div style={{ textAlign:'center', padding:'34px 0', color:'#475569', fontSize:12 }}>
              No alerts yet. Tap <strong style={{ color:'#00d4aa' }}>+ New</strong> to create one.
            </div>
          ) : (
            alerts.map(a => (
              <div key={a.id} style={{ background:'#0d1626', borderRadius:10, padding:'11px 13px', marginBottom:8,
                border:`1px solid ${a.enabled ? '#14233b' : '#1e293b'}`, opacity: a.enabled ? 1 : 0.55 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                  <span style={{ fontSize:13, fontWeight:800, color:'#e2e8f0' }}>{a.sym}</span>
                  {a.repeat && <span style={{ fontSize:8, fontWeight:700, color:'#a78bfa', background:'#a78bfa18', padding:'1px 5px', borderRadius:4 }}>REPEAT</span>}
                  <button onClick={()=>toggle(a.id)} style={{ marginLeft:'auto', fontSize:10, fontWeight:700, cursor:'pointer',
                    padding:'3px 9px', borderRadius:6, border:'1px solid #334155',
                    background: a.enabled ? '#22c55e14' : '#1e293b', color: a.enabled ? '#22c55e' : '#64748b' }}>
                    {a.enabled ? 'ON' : 'OFF'}</button>
                  <button onClick={()=>del(a.id)} style={{ fontSize:14, cursor:'pointer', background:'none', border:'none', color:'#ef4444' }}>🗑</button>
                </div>
                <div style={{ fontSize:11, color:'#94a3b8' }}>{describe(a)}</div>
                {a.lastTriggered && (
                  <div style={{ fontSize:9, color:'#475569', marginTop:3 }}>
                    Last fired {new Date(a.lastTriggered).toLocaleString()}{!a.enabled && !a.repeat ? ' · disabled after firing' : ''}
                  </div>
                )}
              </div>
            ))
          )
        )}

        {/* ── History ── */}
        {tab === 'log' && (
          log.length === 0 ? (
            <div style={{ textAlign:'center', padding:'34px 0', color:'#475569', fontSize:12 }}>No alerts have fired yet.</div>
          ) : (
            <>
              <button onClick={clearLog} style={{ fontSize:10, color:'#64748b', background:'none', border:'1px solid #1e293b',
                borderRadius:6, padding:'4px 10px', cursor:'pointer', marginBottom:10 }}>Clear history</button>
              {log.map((e,i) => (
                <div key={i} style={{ background:'#0d1626', borderRadius:8, padding:'9px 12px', marginBottom:6, border:'1px solid #14233b' }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#e2e8f0' }}>{e.sym}</div>
                  <div style={{ fontSize:10.5, color:'#94a3b8', margin:'2px 0' }}>{e.msg}</div>
                  <div style={{ fontSize:9, color:'#475569' }}>{new Date(e.ts).toLocaleString()}</div>
                </div>
              ))}
            </>
          )
        )}

        {/* ── Notify setup ── */}
        {tab === 'setup' && (
          <>
            {/* Background push via VPS */}
            <div style={{ background:'#0d1626', borderRadius:12, padding:'14px 15px', marginBottom:12, border:'1px solid #00d4aa33' }}>
              <div style={{ fontSize:12, fontWeight:800, color:'#00d4aa', marginBottom:4 }}>🚀 Background push (app closed)</div>
              <div style={{ fontSize:9.5, color:'#64748b', marginBottom:10, lineHeight:1.5 }}>
                Your VPS watches prices 24/7 and pushes to this device even when the app is fully closed — no Telegram needed.
                {pushSupported() ? '' : ' (Not supported on this browser — install the app to your home screen.)'}
              </div>
              <button onClick={toggleBackgroundPush} disabled={pushBusy || !pushSupported()} style={{ width:'100%', padding:'9px 0', borderRadius:8,
                fontSize:12, fontWeight:700, cursor: pushBusy ? 'wait' : 'pointer',
                background: pushOn ? '#ef444414' : '#00d4aa14', color: pushOn ? '#ef4444' : '#00d4aa',
                border:`1px solid ${pushOn ? '#ef444444' : '#00d4aa44'}` }}>
                {pushBusy ? '⟳ Working…' : pushOn ? 'Disable background push' : '🚀 Enable background push on this device'}
              </button>
              {pushOn && (
                <button onClick={resyncAlerts} disabled={pushBusy} style={{ width:'100%', padding:'7px 0', borderRadius:8, marginTop:8,
                  fontSize:11, fontWeight:700, cursor:'pointer', background:'#1e293b', color:'#94a3b8', border:'1px solid #334155' }}>
                  ↻ Re-sync my alerts to the VPS
                </button>
              )}
              {pushMsg && <div style={{ fontSize:11, marginTop:8, color: pushMsg.startsWith('✓') ? '#22c55e' : '#ef4444' }}>{pushMsg}</div>}
              <div style={{ fontSize:9, color:'#475569', marginTop:8, lineHeight:1.5 }}>
                Needs GitHub connected (⚙️ Settings) so your VPS can read this device's subscription + your alerts. iPhone: must be added to Home Screen.
              </div>
            </div>

            <div style={{ background:'#0d1626', borderRadius:12, padding:'14px 15px', marginBottom:12, border:'1px solid #14233b' }}>
              <div style={{ fontSize:12, fontWeight:800, color:'#f1f5f9', marginBottom:8 }}>📱 Browser / phone push</div>
              <div style={{ fontSize:10.5, color:'#64748b', marginBottom:10 }}>Permission: <strong style={{ color: perm==='granted'?'#22c55e':'#f59e0b' }}>{perm}</strong></div>
              <button onClick={enableBrowser} style={{ width:'100%', padding:'9px 0', borderRadius:8, fontSize:12, fontWeight:700,
                cursor:'pointer', background:'#00d4aa14', color:'#00d4aa', border:'1px solid #00d4aa44' }}>Enable browser notifications</button>
              {permMsg && <div style={{ fontSize:11, marginTop:8, color: permMsg.startsWith('✓')?'#22c55e':'#ef4444' }}>{permMsg}</div>}
            </div>

            <div style={{ background:'#0d1626', borderRadius:12, padding:'14px 15px', marginBottom:12, border:'1px solid #14233b' }}>
              <div style={{ fontSize:12, fontWeight:800, color:'#f1f5f9', marginBottom:4 }}>✈️ Telegram (push to phone)</div>
              <div style={{ fontSize:9.5, color:'#475569', marginBottom:10, lineHeight:1.4 }}>
                Create a bot via @BotFather → paste its token. Get your chat ID from @userinfobot.
              </div>
              <label style={lbl}>Bot token</label>
              <input value={cfg.botToken || ''} onChange={e=>saveCfg({ botToken:e.target.value })} placeholder="123456:ABC…" style={{ ...inp(), marginBottom:10, fontFamily:'monospace' }}/>
              <label style={lbl}>Chat ID</label>
              <input value={cfg.chatId || ''} onChange={e=>saveCfg({ chatId:e.target.value })} placeholder="your chat id" style={{ ...inp(), fontFamily:'monospace' }}/>
            </div>

            <button onClick={testNotif} style={{ width:'100%', padding:'9px 0', borderRadius:8, fontSize:12, fontWeight:700,
              cursor:'pointer', background:'#1e293b', color:'#94a3b8', border:'1px solid #334155' }}>🔔 Send test notification</button>

            <div style={{ fontSize:9.5, color:'#f59e0b', marginTop:12, lineHeight:1.5 }}>
              ⚠ Alerts are checked every {POLL_MS/1000}s while the app is open. For reliable alerts, keep the PWA open / installed. True closed-app push needs a server (not available).
            </div>
          </>
        )}
      </div>
    </div>
  );
}

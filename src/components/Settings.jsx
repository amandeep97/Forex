'use strict';
import { useState, useCallback } from 'react';
import { fetchGroqModels } from '../utils/groqModels.js';

// ── Key storage adapters ──────────────────────────────────────────────────────
// Each service knows where its key lives in localStorage (some share the ai_keys blob).
function readAiKeys() { try { return JSON.parse(localStorage.getItem('ai_keys') || '{}'); } catch { return {}; } }
function writeAiKeys(obj) { localStorage.setItem('ai_keys', JSON.stringify(obj)); }

function getKey(id) {
  if (['groq','openrouter','gemini','claude'].includes(id)) return readAiKeys()[id] || '';
  if (id === 'oanda')   { try { const c = JSON.parse(localStorage.getItem('oanda_creds')||'null'); if (c?.apiKey) return c.apiKey; } catch {} return localStorage.getItem('oanda_key') || ''; }
  if (id === 'finnhub') return localStorage.getItem('finnhub_key') || '';
  if (id === 'anthropic') return localStorage.getItem('anthropic_key') || '';
  if (id === 'github')  return localStorage.getItem('github_pat') || '';
  return '';
}
function setKey(id, val) {
  if (['groq','openrouter','gemini','claude'].includes(id)) { const o = readAiKeys(); o[id] = val; writeAiKeys(o); return; }
  if (id === 'oanda') {
    const practice = (localStorage.getItem('oanda_env') || 'practice') !== 'live';
    localStorage.setItem('oanda_key', val);
    localStorage.setItem('oanda_creds', JSON.stringify({ apiKey: val, practice }));
    return;
  }
  if (id === 'finnhub')   { localStorage.setItem('finnhub_key', val); return; }
  if (id === 'anthropic') { localStorage.setItem('anthropic_key', val); return; }
  if (id === 'github')    { localStorage.setItem('github_pat', val); return; }
}
function getOandaEnv() { return localStorage.getItem('oanda_env') === 'live' ? 'live' : 'practice'; }
function setOandaEnv(env) {
  localStorage.setItem('oanda_env', env);
  try { const c = JSON.parse(localStorage.getItem('oanda_creds')||'null'); if (c?.apiKey) localStorage.setItem('oanda_creds', JSON.stringify({ ...c, practice: env !== 'live' })); } catch {}
}

// ── Key validation (real network checks) ──────────────────────────────────────
async function testKey(id, key) {
  if (!key?.trim()) return { ok:false, msg:'No key entered' };
  const sig = { signal: AbortSignal.timeout(10000) };
  try {
    if (id === 'oanda') {
      const base = getOandaEnv() === 'live' ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3';
      const r = await fetch(`${base}/accounts`, { headers:{ Authorization:`Bearer ${key}` }, ...sig });
      if (!r.ok) return { ok:false, msg:`Rejected (${r.status}) — check key & environment` };
      const d = await r.json();
      const id0 = d.accounts?.[0]?.id;
      return { ok:true, msg: id0 ? `Valid · account ${id0}` : 'Valid' };
    }
    if (id === 'gemini') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, sig);
      return r.ok ? { ok:true, msg:'Valid Gemini key' } : { ok:false, msg:`Rejected (${r.status})` };
    }
    if (id === 'groq') {
      // The same call that proves the key works also returns the model list, so
      // it fills the picker instead of being thrown away. Forced past the cache
      // because typing a key in is exactly when you want the list refreshed.
      const list = await fetchGroqModels(key, { force: true });
      if (list?.length) return { ok:true, msg:`Valid Groq key · ${list.length} models` };
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers:{ Authorization:`Bearer ${key}` }, ...sig });
      return r.ok ? { ok:true, msg:'Valid Groq key' } : { ok:false, msg:`Rejected (${r.status})` };
    }
    if (id === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/auth/key', { headers:{ Authorization:`Bearer ${key}` }, ...sig });
      return r.ok ? { ok:true, msg:'Valid OpenRouter key' } : { ok:false, msg:`Rejected (${r.status})` };
    }
    if (id === 'claude' || id === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{ 'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
        body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1, messages:[{role:'user',content:'hi'}] }),
        ...sig,
      });
      if (r.ok) return { ok:true, msg:'Valid Anthropic key' };
      if (r.status === 400) return { ok:true, msg:'Valid (reached API)' }; // auth passed, request trivially rejected
      return { ok:false, msg:`Rejected (${r.status})` };
    }
    if (id === 'finnhub') {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${key}`, sig);
      if (!r.ok) return { ok:false, msg:`Rejected (${r.status})` };
      const d = await r.json();
      return d?.c ? { ok:true, msg:'Valid Finnhub key' } : { ok:false, msg:'Key rejected (no data)' };
    }
    if (id === 'github') {
      const r = await fetch('https://api.github.com/user', { headers:{ Authorization:`token ${key}`, Accept:'application/vnd.github.v3+json' }, ...sig });
      if (!r.ok) return { ok:false, msg:`Rejected (${r.status}) — token invalid or lacks repo scope` };
      const d = await r.json();
      return { ok:true, msg: d.login ? `Valid · @${d.login}` : 'Valid GitHub token' };
    }
  } catch (e) {
    return { ok:false, msg:`Couldn't reach API (${e.name === 'TimeoutError' ? 'timeout' : 'network/CORS'})` };
  }
  return { ok:false, msg:'Unknown service' };
}

// ── Backup keys (everything worth moving to another browser) ───────────────────
const BACKUP_KEYS = [
  'oanda_creds','oanda_key','oanda_env','oanda_account_id','oanda_acct',
  'ai_keys','ai_provider','anthropic_key','finnhub_key',
  'github_pat','broker_type','fc_user','fc_acct','fc_env','fc_session',
  'forex_watchlist','forex_manual_trades_v1','alpha_lab_v2','alpha_scenarios',
  'chart_indicators','manual_pmi','forex_pos_calc_v2','forex_notif_v1','fp_active_tab',
];
function buildBackup() {
  const data = {};
  // include any ai_model_* keys + the whitelist
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (BACKUP_KEYS.includes(k) || k.startsWith('ai_model_')) data[k] = localStorage.getItem(k);
  }
  return { app:'ForexPro', v:1, ts:new Date().toISOString(), data };
}
function applyBackup(obj) {
  if (!obj || obj.app !== 'ForexPro' || !obj.data) throw new Error('Not a valid ForexPro backup');
  let n = 0;
  Object.entries(obj.data).forEach(([k, v]) => { if (typeof v === 'string') { localStorage.setItem(k, v); n++; } });
  return n;
}

// ── Reusable key field ────────────────────────────────────────────────────────
function KeyField({ id, label, placeholder, hint, getUrl }) {
  const [val, setVal]   = useState(() => getKey(id));
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState(null);   // null | {ok,msg} | 'loading'

  const save = (v) => { setVal(v); setKey(id, v); setSaved(true); setTest(null); setTimeout(()=>setSaved(false), 1200); };
  const copy = () => { navigator.clipboard?.writeText(val).then(()=>{ setSaved(true); setTimeout(()=>setSaved(false),900); }); };
  const runTest = async () => { setTest('loading'); setTest(await testKey(id, val)); };

  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ display:'flex', alignItems:'center', marginBottom:5 }}>
        <span style={{ fontSize:10, fontWeight:700, color:'#64748b', textTransform:'uppercase', letterSpacing:'0.05em', flex:1 }}>{label}</span>
        {getUrl && <a href={getUrl} target="_blank" rel="noreferrer" style={{ fontSize:10, color:'#38bdf8', textDecoration:'none' }}>↗ Get key</a>}
      </div>
      <div style={{ display:'flex', gap:6, alignItems:'stretch' }}>
        <input type={show ? 'text' : 'password'} value={val} placeholder={placeholder}
          onChange={e=>save(e.target.value)}
          style={{ flex:1, background:'#0f172a', color:'#e2e8f0', border:`1px solid ${test?.ok ? '#22c55e55' : test?.ok===false ? '#ef444455' : '#334155'}`,
            borderRadius:8, padding:'9px 12px', fontSize:12, outline:'none', fontFamily:'monospace' }}/>
        <button onClick={()=>setShow(s=>!s)} style={btn()}>{show ? 'hide' : 'show'}</button>
        <button onClick={copy} disabled={!val} style={btn(!!val)}>{saved ? '✓' : 'copy'}</button>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:7 }}>
        <button onClick={runTest} disabled={!val || test==='loading'} style={{
          padding:'6px 14px', borderRadius:7, fontSize:11, fontWeight:700, cursor: val ? 'pointer':'not-allowed',
          background: '#00d4aa14', color:'#00d4aa', border:'1px solid #00d4aa44', opacity: val ? 1 : 0.4 }}>
          {test==='loading' ? '⟳ Testing…' : '⚡ Test key'}
        </button>
        {test && test !== 'loading' && (
          <span style={{ fontSize:11, fontWeight:700, color: test.ok ? '#22c55e' : '#ef4444' }}>
            {test.ok ? '✓ ' : '✗ '}{test.msg}
          </span>
        )}
      </div>
      {hint && <div style={{ fontSize:9.5, color:'#475569', marginTop:5, lineHeight:1.4 }}>{hint}</div>}
    </div>
  );
}
function btn(enabled=true) {
  return { padding:'0 12px', borderRadius:8, fontSize:11, fontWeight:700, cursor: enabled ? 'pointer':'not-allowed',
    background:'#1e293b', color:'#94a3b8', border:'1px solid #334155', opacity: enabled ? 1 : 0.5 };
}

// ── Main settings modal ───────────────────────────────────────────────────────
export default function Settings({ onClose }) {
  const [env, setEnv] = useState(getOandaEnv());
  const [tab, setTab] = useState('keys');
  const [backupText, setBackupText] = useState('');
  const [importText, setImportText] = useState('');
  const [msg, setMsg] = useState('');

  const doExport = useCallback(() => {
    const json = JSON.stringify(buildBackup(), null, 2);
    setBackupText(json);
    setMsg('');
  }, []);
  const copyBackup = () => { navigator.clipboard?.writeText(backupText); setMsg('✓ Copied — paste it in the other browser’s Import box'); };
  const downloadBackup = () => {
    const blob = new Blob([backupText || JSON.stringify(buildBackup(), null, 2)], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `forexpro-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  };
  const doImport = (text) => {
    try {
      const n = applyBackup(JSON.parse(text));
      setMsg(`✓ Restored ${n} settings. Reloading…`);
      setTimeout(()=>window.location.reload(), 900);
    } catch (e) { setMsg(`✗ ${e.message}`); }
  };
  const onFile = (file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => doImport(String(r.result));
    r.readAsText(file);
  };

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.82)', display:'flex',
      alignItems:'flex-start', justifyContent:'center', zIndex:5000, padding:'34px 14px', overflowY:'auto' }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:'#0b111e', border:'1px solid #1e293b', borderRadius:16,
        width:'100%', maxWidth:480, padding:'18px 20px' }}>

        <div style={{ display:'flex', alignItems:'center', marginBottom:14 }}>
          <div style={{ fontSize:16, fontWeight:800, color:'#f8fafc', flex:1 }}>⚙️ Settings & API Keys</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#64748b', fontSize:24, cursor:'pointer', lineHeight:1 }}>×</button>
        </div>

        <div style={{ display:'flex', gap:6, marginBottom:16 }}>
          {[['keys','🔑 API Keys'],['backup','💾 Backup & Restore']].map(([id,l]) => (
            <button key={id} onClick={()=>setTab(id)} style={{ flex:1, padding:'8px 0', borderRadius:8, fontSize:12, fontWeight:700,
              cursor:'pointer', border:`1px solid ${tab===id?'#00d4aa55':'#1e293b'}`, background: tab===id?'#00d4aa14':'#0f172a',
              color: tab===id?'#00d4aa':'#64748b' }}>{l}</button>
          ))}
        </div>

        {tab === 'keys' && (
          <>
            {/* OANDA with env toggle */}
            <div style={{ background:'#0d1626', borderRadius:12, padding:'14px 15px', marginBottom:12, border:'1px solid #14233b' }}>
              <div style={{ fontSize:13, fontWeight:800, color:'#f1f5f9', marginBottom:2 }}>📈 OANDA (Broker — prices, sentiment)</div>
              <div style={{ display:'flex', gap:6, margin:'8px 0 12px' }}>
                {['practice','live'].map(e => (
                  <button key={e} onClick={()=>{ setEnv(e); setOandaEnv(e); }} style={{ flex:1, padding:'6px 0', borderRadius:7,
                    fontSize:11, fontWeight:700, cursor:'pointer', border:`1px solid ${env===e?(e==='live'?'#ef444455':'#22c55e55'):'#1e293b'}`,
                    background: env===e?(e==='live'?'#ef44441a':'#22c55e1a'):'#0f172a', color: env===e?(e==='live'?'#ef4444':'#22c55e'):'#64748b' }}>
                    {e==='live'?'🔴 Live':'🟢 Practice'}</button>
                ))}
              </div>
              <KeyField id="oanda" label="OANDA API Key" placeholder="your OANDA token"
                getUrl="https://www.oanda.com/account/tpa/personal_token"
                hint="Test uses the selected environment above. Practice & Live keys are different."/>
            </div>

            {/* AI providers */}
            <div style={{ background:'#0d1626', borderRadius:12, padding:'14px 15px', marginBottom:12, border:'1px solid #14233b' }}>
              <div style={{ fontSize:13, fontWeight:800, color:'#f1f5f9', marginBottom:12 }}>🤖 AI Models (Analysis tab)</div>
              <KeyField id="gemini"     label="Gemini (free · vision)" placeholder="AIza…" getUrl="https://aistudio.google.com/apikey"/>
              <KeyField id="groq"       label="Groq (free · fast)"     placeholder="gsk_…" getUrl="https://console.groq.com/keys"/>
              <KeyField id="openrouter" label="OpenRouter (free models)" placeholder="sk-or-…" getUrl="https://openrouter.ai/keys"/>
              <KeyField id="claude"     label="Claude (paid · best vision)" placeholder="sk-ant-…" getUrl="https://console.anthropic.com/settings/keys"/>
            </div>

            {/* GitHub — required for background alerts / VPS sync */}
            <div style={{ background:'#0d1626', borderRadius:12, padding:'14px 15px', marginBottom:12, border:'1px solid #14233b' }}>
              <div style={{ fontSize:13, fontWeight:800, color:'#f1f5f9', marginBottom:3 }}>🐙 GitHub (background alerts + VPS)</div>
              <div style={{ fontSize:9.5, color:'#64748b', marginBottom:10, lineHeight:1.5 }}>
                Required for screen-off push — your alerts + push subscription travel to the VPS through GitHub. Needs a token with <strong>repo</strong> scope.
              </div>
              <KeyField id="github" label="GitHub Personal Access Token" placeholder="ghp_…" getUrl="https://github.com/settings/tokens/new"/>
            </div>

            {/* Other */}
            <div style={{ background:'#0d1626', borderRadius:12, padding:'14px 15px', border:'1px solid #14233b' }}>
              <div style={{ fontSize:13, fontWeight:800, color:'#f1f5f9', marginBottom:12 }}>🔔 Other</div>
              <KeyField id="finnhub" label="Finnhub (live news feed)" placeholder="finnhub key" getUrl="https://finnhub.io/dashboard"/>
            </div>

            <div style={{ fontSize:9.5, color:'#475569', marginTop:12, lineHeight:1.5 }}>
              🔒 All keys are stored only in this browser (localStorage) and sent directly to each provider — never to any ForexPro server.
            </div>
          </>
        )}

        {tab === 'backup' && (
          <>
            <div style={{ fontSize:11, color:'#94a3b8', lineHeight:1.6, marginBottom:14 }}>
              Move everything — keys, watchlist, journal, Alpha Lab data, strategies — to another browser or device.
              Export here, then paste into the Import box on the other browser.
            </div>

            {/* Export */}
            <div style={{ background:'#0d1626', borderRadius:12, padding:'14px 15px', marginBottom:14, border:'1px solid #14233b' }}>
              <div style={{ fontSize:12, fontWeight:800, color:'#f1f5f9', marginBottom:8 }}>⬆ Export</div>
              <button onClick={doExport} style={{ width:'100%', padding:'9px 0', borderRadius:8, fontSize:12, fontWeight:700,
                cursor:'pointer', background:'#00d4aa14', color:'#00d4aa', border:'1px solid #00d4aa44', marginBottom:8 }}>
                Generate backup
              </button>
              {backupText && (
                <>
                  <textarea readOnly value={backupText} rows={5}
                    style={{ width:'100%', boxSizing:'border-box', background:'#0f172a', color:'#94a3b8', border:'1px solid #334155',
                      borderRadius:8, padding:'9px 11px', fontSize:10, fontFamily:'monospace', resize:'vertical' }}/>
                  <div style={{ display:'flex', gap:8, marginTop:8 }}>
                    <button onClick={copyBackup} style={{ flex:1, padding:'8px 0', borderRadius:8, fontSize:12, fontWeight:700,
                      cursor:'pointer', background:'#00d4aa', color:'#080c14', border:'none' }}>📋 Copy</button>
                    <button onClick={downloadBackup} style={{ flex:1, padding:'8px 0', borderRadius:8, fontSize:12, fontWeight:700,
                      cursor:'pointer', background:'#1e293b', color:'#94a3b8', border:'1px solid #334155' }}>⬇ Download file</button>
                  </div>
                </>
              )}
            </div>

            {/* Import */}
            <div style={{ background:'#0d1626', borderRadius:12, padding:'14px 15px', border:'1px solid #14233b' }}>
              <div style={{ fontSize:12, fontWeight:800, color:'#f1f5f9', marginBottom:8 }}>⬇ Import (on the other browser)</div>
              <textarea value={importText} onChange={e=>setImportText(e.target.value)} rows={4}
                placeholder="Paste the backup text here…"
                style={{ width:'100%', boxSizing:'border-box', background:'#0f172a', color:'#e2e8f0', border:'1px solid #334155',
                  borderRadius:8, padding:'9px 11px', fontSize:10, fontFamily:'monospace', resize:'vertical', marginBottom:8 }}/>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={()=>doImport(importText)} disabled={!importText.trim()} style={{ flex:1, padding:'9px 0', borderRadius:8,
                  fontSize:12, fontWeight:700, cursor: importText.trim()?'pointer':'not-allowed',
                  background: importText.trim()?'#00d4aa':'#1e293b', color: importText.trim()?'#080c14':'#475569', border:'none' }}>
                  Restore from text</button>
                <label style={{ flex:1, padding:'9px 0', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer', textAlign:'center',
                  background:'#1e293b', color:'#94a3b8', border:'1px solid #334155' }}>
                  ⬆ From file
                  <input type="file" accept="application/json,.json" style={{ display:'none' }}
                    onChange={e=>onFile(e.target.files?.[0])}/>
                </label>
              </div>
              <div style={{ fontSize:9.5, color:'#f59e0b', marginTop:8, lineHeight:1.4 }}>
                ⚠ Import overwrites matching settings in this browser, then reloads.
              </div>
            </div>
          </>
        )}

        {msg && (
          <div style={{ marginTop:14, padding:'9px 12px', borderRadius:8, fontSize:11, fontWeight:700,
            background: msg.startsWith('✓') ? '#14532d33' : '#45050933',
            color: msg.startsWith('✓') ? '#86efac' : '#fca5a5',
            border: `1px solid ${msg.startsWith('✓') ? '#22c55e33' : '#ef444433'}` }}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}

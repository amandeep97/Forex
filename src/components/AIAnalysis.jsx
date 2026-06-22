import { useState, useEffect, useRef, useCallback } from 'react';
import { runMarketScan, scanDigest, fmtScanPrice } from '../utils/marketScan.js';

// ── Inject blink keyframe once ────────────────────────────────────────────────
if (!document.getElementById('ai-tab-kf')) {
  const s = document.createElement('style');
  s.id = 'ai-tab-kf';
  s.textContent = '@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}';
  document.head.appendChild(s);
}

// ── Provider configs ──────────────────────────────────────────────────────────
const PROVIDERS = [
  {
    id: 'groq', label: 'Groq', badge: 'FREE', icon: '⚡', color: '#f97316',
    keyPlaceholder: 'gsk_xxxxxxxxxxxx',
    keyHint: 'Free key → console.groq.com',
    models: [
      { id: 'llama-3.3-70b-versatile',          label: 'Llama 3.3 70B' },
      { id: 'deepseek-r1-distill-llama-70b',    label: 'DeepSeek R1 70B' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B' },
      { id: 'llama-3.1-8b-instant',             label: 'Llama 3.1 8B (fastest)' },
    ],
  },
  {
    id: 'openrouter', label: 'OpenRouter', badge: 'FREE', icon: '🔀', color: '#6366f1',
    keyPlaceholder: 'sk-or-xxxxxxxxxxxx',
    keyHint: 'Free key + free models → openrouter.ai/keys',
    models: [
      { id: 'google/gemini-2.5-flash-preview:free',      label: 'Gemini 2.5 Flash (Free)' },
      { id: 'google/gemini-2.5-pro-preview:free',        label: 'Gemini 2.5 Pro (Free)' },
      { id: 'deepseek/deepseek-r1-0528:free',            label: 'DeepSeek R1 0528 (Free)' },
      { id: 'meta-llama/llama-4-maverick:free',          label: 'Llama 4 Maverick (Free)' },
      { id: 'anthropic/claude-sonnet-4-5',               label: 'Claude Sonnet 4.5 (via OR)' },
    ],
  },
  {
    id: 'gemini', label: 'Gemini', badge: 'FREE', icon: '✦', color: '#4285f4',
    keyPlaceholder: 'AIzaSyxxxxxxxxxxxxxxxx',
    keyHint: 'Free key → aistudio.google.com',
    models: [
      { id: 'gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash (latest)' },
      { id: 'gemini-2.5-pro-preview-06-05',   label: 'Gemini 2.5 Pro (latest)' },
      { id: 'gemini-2.0-flash',               label: 'Gemini 2.0 Flash' },
    ],
  },
  {
    id: 'claude', label: 'Claude', badge: 'PAID', icon: '◈', color: '#cc785c',
    keyPlaceholder: 'sk-ant-xxxxxxxxxxxx',
    keyHint: 'Paid key → console.anthropic.com',
    models: [
      { id: 'claude-sonnet-4-6',              label: 'Claude Sonnet 4.6 (latest)' },
      { id: 'claude-opus-4-8',                label: 'Claude Opus 4.8 (best)' },
      { id: 'claude-haiku-4-5-20251001',      label: 'Claude Haiku 4.5 (fastest)' },
    ],
  },
];

// ── Quick prompts ─────────────────────────────────────────────────────────────
const QUICK_PROMPTS = [
  { label: 'Full Summary',    icon: '🧠', text: "Give me a complete platform summary: active session, top scanner setups, Alpha Lab sweep intelligence (win rates, live sweeps, top pairs), COT bias, DXY direction, and the 1-2 best trades right now with entry/SL/TP. Cross-reference everything." },
  { label: 'Best trade now',  icon: '🎯', text: "Look at the APP SETUP SCANNER and ALPHA LAB SWEEP INTELLIGENCE in the live context. Cross-reference the top scanner setup with its sweep win rate and COT positioning. Give me the single best trade right now with entry, SL and TP." },
  { label: "Today's brief",   icon: '📋', text: "Give me today's complete market brief — active sessions, bias for major pairs based on COT + Alpha Lab sweep data, and what to watch or avoid." },
  { label: 'Alpha Lab read',  icon: '⚗',  text: "Analyze the ALPHA LAB SWEEP INTELLIGENCE section in my context. Which pairs have the highest sweep win rates? Are there any live pending sweeps right now? What do the active scenarios suggest?" },
  { label: 'Gold setup',      icon: '⚜', text: 'Analyze XAU/USD in full detail using COT, DXY, real yields, momentum, and Alpha Lab sweep data. Should I be long or short and why?' },
  { label: 'COT reading',     icon: '🏦', text: 'Explain the current COT positioning for all major currencies in the context. Who is positioned at extremes? What does smart money positioning suggest this week?' },
  { label: 'Session timing',  icon: '🕐', text: 'What session is active right now? Based on the Alpha Lab sweep time DNA (which sessions show highest win rates), which pairs should I focus on?' },
  { label: 'DXY impact',      icon: '💵', text: 'How is the current DXY direction impacting metals and USD pairs today? Cross-check with COT and Alpha Lab sweep data to confirm or deny the move.' },
];

// ── OANDA helpers ─────────────────────────────────────────────────────────────
function getOandaCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) return c;
  } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}

async function fetchCloses(instr, gran, count) {
  const creds = getOandaCreds();
  if (!creds) return null;
  const base = creds.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  try {
    const res = await fetch(
      `${base}/instruments/${instr}/candles?granularity=${gran}&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.candles || []).filter(c => c.complete).map(c => +c.mid.c);
  } catch { return null; }
}

async function fetchCOT(code) {
  try {
    const url = `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=2`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows?.length) return null;
    const r = rows[0];
    const long = +r.noncomm_positions_long_all || 0;
    const short = +r.noncomm_positions_short_all || 0;
    return { net: long - short, long, short, date: (r.report_date_as_yyyy_mm_dd || '').slice(0, 10) };
  } catch { return null; }
}

function getCurrentSessions() {
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const inS = (s, e) => s < e ? mins >= s && mins < e : mins >= s || mins < e;
  const active = [
    { name: 'Sydney',   s: 22*60, e:  7*60 },
    { name: 'Tokyo',    s:  0*60, e:  9*60 },
    { name: 'London',   s:  8*60, e: 17*60 },
    { name: 'New York', s: 13*60, e: 22*60 },
  ].filter(x => inS(x.s, x.e)).map(x => x.name);
  const overlap = active.includes('London') && active.includes('New York');
  const h = String(now.getUTCHours()).padStart(2,'0');
  const m = String(now.getUTCMinutes()).padStart(2,'0');
  return { active, overlap, utcTime: `${h}:${m} UTC` };
}

function buildAlphaLabContext() {
  try {
    const store     = JSON.parse(localStorage.getItem('alpha_lab_v2') || '{}');
    const scenarios = JSON.parse(localStorage.getItem('alpha_scenarios') || '[]');
    const log       = store.sweepLog || [];
    if (!log.length) return '';

    const resolved  = log.filter(s => s.outcome !== 'pending');
    const confirmed = resolved.filter(s => s.outcome === 'confirmed');
    const pending   = log.filter(s => s.outcome === 'pending');
    const wr        = resolved.length ? Math.round(confirmed.length / resolved.length * 100) : null;

    // Per-pair breakdown
    const pairStats = {};
    for (const s of resolved) {
      if (!pairStats[s.label]) pairStats[s.label] = { total: 0, wins: 0, bullWins: 0, bullTotal: 0 };
      pairStats[s.label].total++;
      if (s.outcome === 'confirmed') pairStats[s.label].wins++;
      if (s.expectedDir === 'bullish') {
        pairStats[s.label].bullTotal++;
        if (s.outcome === 'confirmed') pairStats[s.label].bullWins++;
      }
    }
    const topPairs = Object.entries(pairStats)
      .map(([label, st]) => ({ label, wr: Math.round(st.wins / st.total * 100), total: st.total,
        bullWR: st.bullTotal >= 5 ? Math.round(st.bullWins / st.bullTotal * 100) : null }))
      .filter(p => p.total >= 8)
      .sort((a, b) => b.wr - a.wr)
      .slice(0, 6);

    // Best scenarios
    const scenarioResults = scenarios.slice(0, 5).map(sc => {
      const matched = resolved.filter(s =>
        (sc.conditions || []).every(c => {
          if (c.type === 'pair')      return s.label === c.value || s.pair?.includes(c.value);
          if (c.type === 'session')   return true;
          if (c.type === 'direction') return s.expectedDir === c.value;
          if (c.type === 'tf')        return (s.tf || 'H1') === c.value;
          if (c.type === 'dow')       return (s.dow ?? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(s.time).getDay()]) === c.value;
          return true;
        })
      );
      const wins = matched.filter(s => s.outcome === 'confirmed').length;
      const scWR = matched.length ? Math.round(wins / matched.length * 100) : null;
      return { name: sc.name, dir: sc.dir, signals: matched.length, wr: scWR };
    }).filter(r => r.signals > 0);

    const L = [];
    L.push('=== ALPHA LAB SWEEP INTELLIGENCE ===');
    L.push(`Total sweeps: ${log.length} | Resolved: ${resolved.length} | Overall WR after sweep: ${wr != null ? wr + '%' : 'N/A'}`);

    if (pending.length) {
      L.push(`\nLIVE PENDING SWEEPS (happening now or recently, not yet resolved):`);
      for (const s of pending.slice(0, 6)) {
        const pips = s.pip ? ((s.swept === 'high' ? s.entryPrice - s.level : s.level - s.entryPrice) / s.pip).toFixed(0) : '?';
        L.push(`  ${s.label} [${s.tf}] — ${s.swept === 'high' ? '↑ HIGH' : '↓ LOW'} swept → expect ${s.expectedDir.toUpperCase()} | ~${pips} pip wick past level`);
      }
    }

    if (topPairs.length) {
      L.push(`\nTOP PAIRS BY SWEEP WIN RATE (historical, resolved signals only):`);
      for (const p of topPairs) {
        const bull = p.bullWR != null ? ` | Bull: ${p.bullWR}%` : '';
        L.push(`  ${p.label}: ${p.wr}% WR from ${p.total} sweeps${bull}`);
      }
    }

    if (scenarioResults.length) {
      L.push(`\nSAVED SCENARIO RESULTS:`);
      for (const r of scenarioResults) {
        L.push(`  "${r.name}" [${r.dir}]: ${r.signals} signals, ${r.wr != null ? r.wr + '% WR' : 'N/A'}`);
      }
    }

    return L.join('\n');
  } catch { return ''; }
}

async function buildMarketContext() {
  const session = getCurrentSessions();
  const [gold, silver, eurusd, bonds10, bonds2, oil,
         cotGold, cotSilver, cotEUR, cotGBP, cotJPY, cotAUD, scan] = await Promise.all([
    fetchCloses('XAU_USD',    'H1', 15),
    fetchCloses('XAG_USD',    'H1', 15),
    fetchCloses('EUR_USD',    'H1', 15),
    fetchCloses('USB10Y_USD', 'H1', 15),
    fetchCloses('USB02Y_USD', 'H1', 15),
    fetchCloses('BCO_USD',    'H1', 15),
    fetchCOT('088691'), fetchCOT('084691'),
    fetchCOT('099741'), fetchCOT('096742'),
    fetchCOT('097741'), fetchCOT('232741'),
    runMarketScan().catch(() => ({ ok: false, setups: [] })),
  ]);

  const last  = a => a?.[a.length - 1] ?? null;
  const pct5  = a => {
    if (!a || a.length < 6) return null;
    return ((a[a.length-1] - a[a.length-6]) / a[a.length-6] * 100).toFixed(3);
  };
  const dirOf = (a, lb=5) => {
    if (!a || a.length < lb+1) return null;
    return a[a.length-1] > a[a.length-1-lb] ? 'rising' : 'falling';
  };
  const fmt = (v, dec=2) => v != null ? v.toFixed(dec) : 'N/A';

  const goldP = last(gold), silverP = last(silver);
  const dxyDir = eurusd ? (dirOf(eurusd) === 'rising' ? 'falling' : 'rising') : null;
  const dxyPct = eurusd ? -(+(pct5(eurusd) ?? 0)) : null;
  const b10dir = dirOf(bonds10), goldDir = dirOf(gold), silvDir = dirOf(silver);
  const yc     = (last(bonds10) && last(bonds2)) ? (last(bonds10) - last(bonds2)).toFixed(3) : null;
  const auag   = (goldP && silverP) ? (goldP / silverP).toFixed(1) : null;

  let realYield = 'unknown';
  if (b10dir && goldDir) {
    if (b10dir === 'rising'  && goldDir === 'falling') realYield = 'RISING → bearish metals';
    else if (b10dir === 'falling' && goldDir === 'rising')  realYield = 'FALLING → bullish metals';
    else realYield = 'mixed / neutral';
  }

  const L = [];
  L.push('=== FOREXPRO LIVE MARKET CONTEXT ===');
  L.push(`Time: ${session.utcTime} | Sessions: ${session.active.length ? session.active.join(' + ') : 'None active'}`);
  if (session.overlap) L.push('⚡ LONDON+NY OVERLAP ACTIVE — highest liquidity window of the day');
  L.push('');
  L.push('=== METALS (H1, 5-bar momentum) ===');
  if (goldP)   L.push(`XAU/USD: $${fmt(goldP)} | ${pct5(gold) != null ? (+(pct5(gold))>=0?'+':'')+(+pct5(gold)).toFixed(3)+'%' : 'N/A'} | Trend: ${goldDir ?? 'unknown'}`);
  if (silverP) L.push(`XAG/USD: $${fmt(silverP)} | ${pct5(silver) != null ? (+(pct5(silver))>=0?'+':'')+(+pct5(silver)).toFixed(3)+'%' : 'N/A'} | Trend: ${silvDir ?? 'unknown'}`);
  if (auag)    L.push(`Au/Ag Ratio: ${auag} — ${+auag > 80 ? 'Silver historically CHEAP vs Gold (>80)' : +auag < 50 ? 'Silver expensive vs Gold (<50)' : 'Normal range (50-80)'}`);
  if (last(oil)) L.push(`Brent Oil: $${fmt(last(oil))} | ${dirOf(oil) ?? 'unknown'}`);
  L.push('');
  L.push('=== MACRO DRIVERS ===');
  if (dxyDir)    L.push(`DXY: ${dxyDir} (${dxyPct != null ? (dxyPct>=0?'+':'')+dxyPct.toFixed(3)+'%' : 'N/A'}) — ${dxyDir==='rising'?'Headwind for metals':'Tailwind for metals'}`);
  if (b10dir)    L.push(`US 10Y Yield: ${b10dir} — ${b10dir==='rising'?'Bearish metals (real yields rising)':'Bullish metals (real yields falling)'}`);
  if (yc != null) L.push(`Yield Curve (10Y-2Y): ${+yc>=0?'+':''}${yc} — ${+yc<0?'INVERTED = recession signal = gold bullish':'Normal curve'}`);
  L.push(`Real Yield Proxy: ${realYield}`);
  L.push('');
  L.push('=== COT POSITIONING (CFTC, non-commercial speculators) ===');
  if (cotGold)   L.push(`Gold:   Net ${cotGold.net>=0?'+':''}${cotGold.net.toLocaleString()} contracts → ${cotGold.net>=0?'BULLISH':'BEARISH'} | ${cotGold.date}`);
  if (cotSilver) L.push(`Silver: Net ${cotSilver.net>=0?'+':''}${cotSilver.net.toLocaleString()} contracts → ${cotSilver.net>=0?'BULLISH':'BEARISH'} | ${cotSilver.date}`);
  if (cotEUR)    L.push(`EUR:    Net ${cotEUR.net>=0?'+':''}${cotEUR.net.toLocaleString()} → ${cotEUR.net>=0?'Bullish':'Bearish'}`);
  if (cotGBP)    L.push(`GBP:    Net ${cotGBP.net>=0?'+':''}${cotGBP.net.toLocaleString()} → ${cotGBP.net>=0?'Bullish':'Bearish'}`);
  if (cotJPY)    L.push(`JPY:    Net ${-cotJPY.net>=0?'+':''}${(-cotJPY.net).toLocaleString()} → ${-cotJPY.net>=0?'Bullish':'Bearish'} (inverted)`);
  if (cotAUD)    L.push(`AUD:    Net ${cotAUD.net>=0?'+':''}${cotAUD.net.toLocaleString()} → ${cotAUD.net>=0?'Bullish':'Bearish'}`);
  L.push('');
  const digest = scanDigest(scan);
  if (digest) { L.push(digest); L.push(''); }

  const alphaCtx = buildAlphaLabContext();
  if (alphaCtx) { L.push(''); L.push(alphaCtx); }

  L.push(`\nOANDA: ${getOandaCreds() ? 'Connected' : 'NOT connected — price data unavailable'}`);

  return {
    text: L.join('\n'),
    summary: {
      sessions: session.active, overlap: session.overlap,
      goldP, silverP, auag, dxyDir, b10dir, yc, realYield,
      cotGold, cotSilver, oandaOk: !!getOandaCreds(),
      scan: scan?.ok ? scan : null,
    },
  };
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYS = `You are ForexPro AI — an elite forex and metals trading analyst embedded in a professional multi-tab trading platform. You receive real-time market data with every message covering the full platform.

YOUR DATA SOURCES (all provided in context):
1. APP SETUP SCANNER — confluence scores from live H4 bias, H1 structure, COT, session timing
2. ALPHA LAB SWEEP INTELLIGENCE — historical liquidity sweep win rates per pair, live pending sweeps, saved scenario results. This is proprietary backtested data — use it heavily.
3. COT DATA — CFTC non-commercial positioning for major currencies and metals
4. MACRO — DXY, US yields (10Y/2Y), real yield proxy, yield curve
5. SESSION — current active sessions (Sydney/Tokyo/London/NY/Overlap)

ALWAYS reference actual numbers from the data. Never give generic advice — every claim must cite a number or data point from the context.

When you identify a trade setup output it in this EXACT format on its own line:
\`\`\`trade
{"action":"BUY","pair":"XAU/USD","entry":"market","sl":"3228","tp":"3280","rr":"1:2","confidence":75,"reason":"COT extreme long + Alpha Lab 68% WR on XAU sweeps + real yield falling"}
\`\`\`

Rules:
- Cross-reference Alpha Lab sweep WR with scanner setups — if scanner says BUY and Alpha Lab shows 65%+ WR on that pair's sweeps, that's high confluence
- Note live pending sweeps — these are happening RIGHT NOW and may be the best entries
- Flag contradictions: e.g. "COT bullish BUT Alpha Lab shows only 40% WR on GBP bullish sweeps — skip"
- Be concise: bullet points, 2-3 sentences per point
- Maximum 2 trade ideas per response
- Confidence: 50-65=low, 66-79=moderate, 80+=high (90+ only when Alpha Lab + COT + scanner all agree)
- If OANDA not connected, say price data is unavailable but you can still analyse COT/macro/Alpha Lab`;

// ── Streaming generators ──────────────────────────────────────────────────────
async function* streamOpenAI(url, key, model, messages, extra = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}`, ...extra },
    body: JSON.stringify({ model, messages, stream:true, max_tokens:1400, temperature:0.7 }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(()=>res.statusText)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream:true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const ln of lines) {
      if (!ln.startsWith('data: ')) continue;
      const d = ln.slice(6).trim();
      if (d === '[DONE]') return;
      try { const c = JSON.parse(d).choices?.[0]?.delta?.content; if (c) yield c; } catch {}
    }
  }
}

async function* streamGemini(key, model, messages) {
  const sys = messages.find(m => m.role === 'system');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts:[{text:m.content}] }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents, ...(sys ? {system_instruction:{parts:[{text:sys.content}]}} : {}), generationConfig:{maxOutputTokens:1400,temperature:0.7} }) }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status} ${await res.text().catch(()=>res.statusText)}`);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream:true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const ln of lines) {
      if (!ln.startsWith('data: ')) continue;
      try { const t = JSON.parse(ln.slice(6)).candidates?.[0]?.content?.parts?.[0]?.text; if (t) yield t; } catch {}
    }
  }
}

async function* streamClaude(key, model, messages) {
  const sys = messages.find(m => m.role === 'system');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{ 'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
    body: JSON.stringify({
      model, max_tokens:1400, stream:true,
      system: sys?.content ?? SYS,
      messages: messages.filter(m=>m.role!=='system').map(m=>({role:m.role,content:m.content})),
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status} ${await res.text().catch(()=>res.statusText)}`);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream:true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const ln of lines) {
      if (!ln.startsWith('data: ')) continue;
      try {
        const j = JSON.parse(ln.slice(6));
        if (j.type==='content_block_delta' && j.delta?.type==='text_delta') yield j.delta.text;
      } catch {}
    }
  }
}

// ── Trade card helpers ────────────────────────────────────────────────────────
function extractTrades(content) {
  const trades = []; const re = /```trade\s*\n([\s\S]*?)\n```/g; let m;
  while ((m = re.exec(content)) !== null) { try { trades.push(JSON.parse(m[1].trim())); } catch {} }
  return trades;
}
const stripTrades = t => t.replace(/```trade[\s\S]*?```/g,'').trim();

// ── Simple markdown renderer ──────────────────────────────────────────────────
function MsgContent({ text }) {
  const lines = text.split('\n');
  return (
    <div style={{ fontSize:12, lineHeight:1.75, color:'var(--text)' }}>
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} style={{ height:6 }}/>;
        if (line.startsWith('### ')) return <div key={i} style={{ fontWeight:700, color:'#00d4aa', fontSize:12, marginTop:6 }}>{line.slice(4)}</div>;
        if (line.startsWith('## '))  return <div key={i} style={{ fontWeight:700, color:'var(--text)', fontSize:13, marginTop:8 }}>{line.slice(3)}</div>;
        if (line.startsWith('# '))   return <div key={i} style={{ fontWeight:900, color:'var(--text)', fontSize:14, marginTop:8 }}>{line.slice(2)}</div>;
        const isBullet = line.startsWith('- ') || line.startsWith('• ') || line.startsWith('* ');
        const content = isBullet ? line.slice(2) : line;
        const formatted = content.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((p, j) => {
          if (p.startsWith('**') && p.endsWith('**')) return <strong key={j}>{p.slice(2,-2)}</strong>;
          if (p.startsWith('`') && p.endsWith('`'))   return <code key={j} style={{ background:'#1e293b', padding:'1px 5px', borderRadius:3, fontSize:11, fontFamily:'monospace' }}>{p.slice(1,-1)}</code>;
          return p;
        });
        return (
          <div key={i} style={{ display:'flex', gap: isBullet ? 6 : 0, marginBottom: isBullet ? 2 : 0 }}>
            {isBullet && <span style={{ color:'#00d4aa', flexShrink:0 }}>•</span>}
            <span>{formatted}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Trade card ────────────────────────────────────────────────────────────────
function TradeCard({ trade }) {
  const col = { BUY:'#22c55e', SELL:'#ef4444', LONG:'#22c55e', SHORT:'#ef4444' }[trade.action?.toUpperCase()] || '#00d4aa';
  const conf = trade.confidence ?? 0;
  const confCol = conf >= 80 ? '#22c55e' : conf >= 66 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ borderRadius:10, border:`1px solid ${col}55`, borderLeft:`4px solid ${col}`, background:`${col}0d`, padding:'12px 14px', marginBottom:6 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
        <span style={{ fontSize:15, fontWeight:900, color:col }}>{trade.action} {trade.pair}</span>
        {conf > 0 && (
          <span style={{ marginLeft:'auto', fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:10,
            color:confCol, background:`${confCol}18`, border:`1px solid ${confCol}44` }}>
            {conf}% confidence
          </span>
        )}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:8 }}>
        {[['Entry',trade.entry],['Stop Loss',trade.sl],['Take Profit',trade.tp]].map(([l,v]) => (
          <div key={l} style={{ textAlign:'center', padding:'5px 8px', borderRadius:6, background:'#0f172a' }}>
            <div style={{ fontSize:9, color:'var(--text3)', marginBottom:2 }}>{l}</div>
            <div style={{ fontSize:11, fontWeight:700, fontFamily:'monospace', color:'var(--text)' }}>{v ?? '—'}</div>
          </div>
        ))}
      </div>
      {trade.rr && <div style={{ fontSize:11, fontWeight:700, color:col, marginBottom:4 }}>Risk:Reward = {trade.rr}</div>}
      {trade.reason && <div style={{ fontSize:10, color:'var(--text3)', lineHeight:1.5 }}>{trade.reason}</div>}
    </div>
  );
}

// ── Best Setup card (deterministic, app-ranked, live data) ────────────────────
function scoreColor(s) { return s >= 75 ? '#22c55e' : s >= 60 ? '#f59e0b' : '#94a3b8'; }

function BestSetupCard({ setup, rank, onValidate, disabled }) {
  const col = setup.dir === 'LONG' ? '#22c55e' : '#ef4444';
  const sc  = scoreColor(setup.score);
  return (
    <div style={{ borderRadius:12, border:`1px solid ${col}44`, background:`${col}0a`,
      padding:'12px 14px', marginBottom:8 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
        {rank && <span style={{ fontSize:11, fontWeight:900, color:'var(--text3)' }}>#{rank}</span>}
        <span style={{ fontSize:14, fontWeight:900, color:col }}>{setup.dir} {setup.label}</span>
        {setup.inKZ && (
          <span style={{ fontSize:8, fontWeight:800, padding:'2px 6px', borderRadius:8,
            background:'#22c55e18', color:'#22c55e', border:'1px solid #22c55e33' }}>⚡ KZ</span>
        )}
        <span style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:5 }}>
          <span style={{ fontSize:9, color:'var(--text3)' }}>score</span>
          <span style={{ fontSize:15, fontWeight:900, color:sc }}>{setup.score}</span>
        </span>
      </div>
      {/* score bar */}
      <div style={{ height:4, borderRadius:2, background:'#ffffff10', overflow:'hidden', marginBottom:8 }}>
        <div style={{ height:'100%', width:`${setup.score}%`, background:sc, borderRadius:2 }}/>
      </div>
      {/* levels */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:5, marginBottom:8 }}>
        {[['Entry',setup.entry,'var(--text)'],['SL',setup.sl,'#ef4444'],
          ['TP1',setup.tp1,'#22c55e'],['TP2',setup.tp2,'#22c55e']].map(([l,v,c]) => (
          <div key={l} style={{ textAlign:'center', padding:'4px 4px', borderRadius:6, background:'#0f172a' }}>
            <div style={{ fontSize:8, color:'var(--text3)', marginBottom:2 }}>{l}</div>
            <div style={{ fontSize:10, fontWeight:700, fontFamily:'monospace', color:c }}>{fmtScanPrice(v, setup.pip)}</div>
          </div>
        ))}
      </div>
      <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:6, flexWrap:'wrap' }}>
        {setup.rr != null && <span style={{ fontSize:10, fontWeight:700, color:col }}>{setup.rr}R</span>}
        {setup.sentiment != null && (
          <span style={{ fontSize:9, color:'var(--text3)' }}>retail {setup.sentiment}% long</span>
        )}
      </div>
      <div style={{ fontSize:9.5, color:'var(--text3)', lineHeight:1.5, marginBottom:8 }}>
        {setup.reasons.join(' · ')}
      </div>
      {onValidate && (
        <button onClick={() => onValidate(setup)} disabled={disabled}
          style={{ width:'100%', padding:'7px 0', borderRadius:8, fontSize:11, fontWeight:700,
            cursor: disabled ? 'not-allowed' : 'pointer', border:'none',
            background: disabled ? 'var(--bg2)' : `${col}1f`, color: disabled ? 'var(--text3)' : col,
            opacity: disabled ? 0.5 : 1 }}>
          🤖 Validate this setup with AI
        </button>
      )}
    </div>
  );
}

function buildValidatePrompt(s) {
  return `The app's live scanner ranked this as a top setup:\n` +
    `${s.dir} ${s.label} (confluence score ${s.score}/100${s.inKZ ? ', in killzone' : ''})\n` +
    `Entry ${fmtScanPrice(s.entry, s.pip)}, SL ${fmtScanPrice(s.sl, s.pip)}, TP1 ${fmtScanPrice(s.tp1, s.pip)}, TP2 ${fmtScanPrice(s.tp2, s.pip)} (${s.rr ?? '?'}R)\n` +
    `Confluences: ${s.reasons.join('; ')}.\n` +
    `Using the full live market context, validate or challenge this setup. Is the timing right? Any contradictions in COT, DXY, yields or correlation? Refine the entry/SL/TP if needed and give your confidence.`;
}

// ── Context sidebar ───────────────────────────────────────────────────────────
function ContextPanel({ ctx, loading, onRefresh }) {
  if (loading) return (
    <div style={{ padding:12, color:'var(--text3)', fontSize:11, textAlign:'center' }}>
      <div style={{ fontSize:18, animation:'spin 1s linear infinite', display:'inline-block', marginBottom:6 }}>⟳</div>
      <div>Loading market data…</div>
    </div>
  );
  if (!ctx) return (
    <div style={{ padding:12, color:'var(--text3)', fontSize:11 }}>
      No data. <button onClick={onRefresh} style={{ background:'none',border:'none',color:'#00d4aa',cursor:'pointer',fontSize:11 }}>Refresh</button>
    </div>
  );
  const s = ctx.summary;
  const row = (label, value, color) => (
    <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderBottom:'1px solid #ffffff08' }}>
      <span style={{ fontSize:10, color:'var(--text3)' }}>{label}</span>
      <span style={{ fontSize:10, fontWeight:700, color: color || 'var(--text)', fontFamily:'monospace', textAlign:'right', maxWidth:100 }}>{value}</span>
    </div>
  );
  return (
    <div style={{ padding:'10px 12px', fontSize:11 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <span style={{ fontSize:11, fontWeight:700, color:'var(--text)' }}>Live Context</span>
        <button onClick={onRefresh} style={{ background:'none', border:'none', color:'var(--text3)', cursor:'pointer', fontSize:12 }}>↺</button>
      </div>

      {/* Sessions */}
      <div style={{ marginBottom:8 }}>
        <div style={{ fontSize:9, color:'var(--text3)', marginBottom:4, textTransform:'uppercase', letterSpacing:1 }}>Sessions</div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
          {s.sessions.length ? s.sessions.map(n => (
            <span key={n} style={{ fontSize:9, padding:'2px 7px', borderRadius:10, fontWeight:700,
              background: s.overlap && (n==='London'||n==='New York') ? '#22c55e18' : '#ffffff0a',
              color: s.overlap && (n==='London'||n==='New York') ? '#22c55e' : 'var(--text3)',
              border:`1px solid ${s.overlap&&(n==='London'||n==='New York')?'#22c55e33':'var(--border)'}` }}>
              {n}
            </span>
          )) : <span style={{ fontSize:9, color:'var(--text3)' }}>No active session</span>}
        </div>
        {s.overlap && <div style={{ fontSize:9, color:'#22c55e', marginTop:4 }}>⚡ London+NY overlap</div>}
      </div>

      {/* Metals */}
      <div style={{ fontSize:9, color:'var(--text3)', marginBottom:4, textTransform:'uppercase', letterSpacing:1 }}>Metals</div>
      {s.goldP   && row('XAU/USD', `$${s.goldP.toFixed(2)}`, '#fbbf24')}
      {s.silverP && row('XAG/USD', `$${s.silverP.toFixed(2)}`, '#94a3b8')}
      {s.auag    && row('Au/Ag Ratio', s.auag, +s.auag > 80 ? '#22c55e' : '#f59e0b')}

      {/* Macro */}
      <div style={{ fontSize:9, color:'var(--text3)', marginTop:8, marginBottom:4, textTransform:'uppercase', letterSpacing:1 }}>Macro</div>
      {s.dxyDir  && row('DXY', s.dxyDir, s.dxyDir==='falling'?'#22c55e':'#ef4444')}
      {s.b10dir  && row('US 10Y', s.b10dir, s.b10dir==='falling'?'#22c55e':'#ef4444')}
      {s.yc != null && row('Yield Curve', `${+s.yc>=0?'+':''}${s.yc}`, +s.yc<0?'#22c55e':'#f59e0b')}
      {s.realYield && row('Real Yield', s.realYield.split('→')[0].trim(), s.realYield.includes('bullish')?'#22c55e':'#ef4444')}

      {/* COT */}
      <div style={{ fontSize:9, color:'var(--text3)', marginTop:8, marginBottom:4, textTransform:'uppercase', letterSpacing:1 }}>COT Bias</div>
      {s.cotGold   && row('Gold COT',   s.cotGold.net>=0  ?'Net Long ▲':'Net Short ▼', s.cotGold.net>=0  ?'#22c55e':'#ef4444')}
      {s.cotSilver && row('Silver COT', s.cotSilver.net>=0?'Net Long ▲':'Net Short ▼', s.cotSilver.net>=0?'#22c55e':'#ef4444')}

      {/* Top setups */}
      {s.scan?.setups?.length > 0 && (
        <>
          <div style={{ fontSize:9, color:'var(--text3)', marginTop:8, marginBottom:4, textTransform:'uppercase', letterSpacing:1 }}>
            🏆 Top Setups (live)
          </div>
          {s.scan.setups.slice(0, 4).map((st, i) => {
            const c = st.dir === 'LONG' ? '#22c55e' : '#ef4444';
            return (
              <div key={st.id} style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 0', borderBottom:'1px solid #ffffff08' }}>
                <span style={{ fontSize:9, color:'var(--text3)', width:10 }}>{i+1}</span>
                <span style={{ fontSize:10, fontWeight:700, color:'var(--text)' }}>{st.label}</span>
                <span style={{ fontSize:9, fontWeight:700, color:c }}>{st.dir}</span>
                {st.inKZ && <span style={{ fontSize:8 }}>⚡</span>}
                <span style={{ marginLeft:'auto', fontSize:10, fontWeight:800, color:scoreColor(st.score) }}>{st.score}</span>
              </div>
            );
          })}
        </>
      )}

      <div style={{ marginTop:8, fontSize:9, padding:'4px 8px', borderRadius:4,
        background: s.oandaOk ? '#22c55e12' : '#ef444412',
        color:      s.oandaOk ? '#22c55e'   : '#ef4444',
        border:     `1px solid ${s.oandaOk ? '#22c55e33' : '#ef444433'}` }}>
        OANDA: {s.oandaOk ? 'Connected ✓' : 'Not connected'}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function AIAnalysis() {
  const [provider, setProvider] = useState(() => localStorage.getItem('ai_provider') || 'groq');
  const [model, setModel]       = useState('');
  const [apiKeys, setApiKeys]   = useState(() => { try { return JSON.parse(localStorage.getItem('ai_keys')||'{}'); } catch { return {}; } });
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState('');
  const [streaming, setStreaming] = useState(false);
  const [context, setContext]   = useState(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [error, setError]       = useState('');
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  const curProvider = PROVIDERS.find(p => p.id === provider) || PROVIDERS[0];
  const hasKey = !!(apiKeys[provider]?.trim());

  // Persist settings
  useEffect(() => { localStorage.setItem('ai_provider', provider); }, [provider]);
  useEffect(() => { localStorage.setItem('ai_keys', JSON.stringify(apiKeys)); }, [apiKeys]);

  // Sync model when provider changes
  useEffect(() => {
    const saved = localStorage.getItem(`ai_model_${provider}`);
    const def   = PROVIDERS.find(p => p.id === provider)?.models[0]?.id ?? '';
    setModel(saved || def);
  }, [provider]);

  useEffect(() => {
    if (model) localStorage.setItem(`ai_model_${provider}`, model);
  }, [model, provider]);

  // Auto-scroll
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth' }); }, [messages]);

  // Load context on mount
  const loadContext = useCallback(async () => {
    setLoadingCtx(true);
    try { setContext(await buildMarketContext()); } catch {}
    setLoadingCtx(false);
  }, []);
  useEffect(() => { loadContext(); }, [loadContext]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const send = useCallback(async (text) => {
    const trimmed = text?.trim();
    if (!trimmed || streaming) return;
    if (!hasKey) { setShowSettings(true); setError('Please enter your API key first'); return; }
    setError('');

    const uid = Date.now(), aid = Date.now()+1;
    const sysContent = `${SYS}\n\n${context?.text ?? '(Market data unavailable — OANDA not connected)'}`;
    const history = messages.filter(m => m.role !== 'system');
    const apiMsgs = [
      { role:'system', content:sysContent },
      ...history.map(m => ({ role:m.role, content:m.content })),
      { role:'user', content:trimmed },
    ];

    setMessages(prev => [
      ...prev,
      { role:'user',      content:trimmed, id:uid },
      { role:'assistant', content:'',      id:aid, isStreaming:true },
    ]);
    setStreaming(true);
    setInput('');

    try {
      let gen;
      const key = apiKeys[provider]?.trim();
      if (provider === 'groq') {
        gen = streamOpenAI('https://api.groq.com/openai/v1/chat/completions', key, model, apiMsgs);
      } else if (provider === 'openrouter') {
        gen = streamOpenAI('https://openrouter.ai/api/v1/chat/completions', key, model, apiMsgs, {
          'HTTP-Referer':'https://amandeep97.github.io/Forex', 'X-Title':'ForexPro AI',
        });
      } else if (provider === 'gemini') {
        gen = streamGemini(key, model, apiMsgs);
      } else {
        gen = streamClaude(key, model, apiMsgs);
      }

      let full = '';
      for await (const chunk of gen) {
        full += chunk;
        setMessages(prev => prev.map(m => m.id===aid ? {...m, content:full} : m));
      }
      setMessages(prev => prev.map(m => m.id===aid ? {...m, isStreaming:false} : m));
    } catch (e) {
      setMessages(prev => prev.map(m =>
        m.id===aid ? {...m, content:`⚠ Error: ${e.message}`, isStreaming:false, isError:true} : m
      ));
    }
    setStreaming(false);
  }, [streaming, hasKey, context, messages, provider, model, apiKeys]);

  const onSubmit = e => { e.preventDefault(); send(input); };

  const validateSetup = useCallback((setup) => {
    if (!hasKey) { setShowSettings(true); setError('Please enter your API key first'); return; }
    send(buildValidatePrompt(setup));
  }, [hasKey, send]);

  const topSetups = context?.summary?.scan?.setups ?? [];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* Header */}
      <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--border)', flexShrink:0, background:'var(--bg)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:4, flexWrap:'wrap', marginBottom:7 }}>
          <span style={{ fontSize:13, fontWeight:800, color:'var(--text)', marginRight:4 }}>🤖 AI Analysis</span>
          {PROVIDERS.map(p => (
            <button key={p.id} onClick={() => setProvider(p.id)}
              style={{ padding:'3px 10px', borderRadius:16, fontSize:10, fontWeight:700, cursor:'pointer', border:'none', transition:'all 0.15s',
                background: provider===p.id ? p.color : 'var(--bg2)',
                color:      provider===p.id ? '#fff' : 'var(--text3)',
                boxShadow:  provider===p.id ? `0 0 8px ${p.color}66` : 'none' }}>
              {p.icon} {p.label} <span style={{ fontSize:8, opacity:0.8 }}>{p.badge}</span>
            </button>
          ))}
          <div style={{ marginLeft:'auto', display:'flex', gap:4, alignItems:'center' }}>
            {context && !loadingCtx && (
              <span style={{ fontSize:9, padding:'2px 7px', borderRadius:10, background:'#22c55e14', color:'#22c55e', border:'1px solid #22c55e33' }}>
                ✓ Live data
              </span>
            )}
            <button onClick={() => setShowSidebar(s=>!s)}
              style={{ padding:'3px 8px', borderRadius:4, fontSize:10, cursor:'pointer', background:'var(--bg2)', border:'1px solid var(--border)', color:'var(--text3)' }}>
              {showSidebar ? 'Hide ctx' : 'Context'}
            </button>
            <button onClick={() => { setShowSettings(s=>!s); setError(''); }}
              style={{ padding:'3px 8px', borderRadius:4, fontSize:10, cursor:'pointer',
                background: hasKey ? '#22c55e14' : '#ef444414',
                color:      hasKey ? '#22c55e'   : '#ef4444',
                border:     `1px solid ${hasKey ? '#22c55e33' : '#ef444433'}` }}>
              {hasKey ? '🔑 Key ✓' : '⚠ Set key'}
            </button>
          </div>
        </div>

        {/* Model row */}
        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          <select value={model} onChange={e => setModel(e.target.value)}
            style={{ flex:1, minWidth:140, padding:'4px 8px', borderRadius:4, fontSize:10, background:'var(--bg2)', color:'var(--text)', border:'1px solid var(--border)', cursor:'pointer' }}>
            {curProvider.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {loadingCtx
            ? <span style={{ fontSize:10, color:'var(--text3)' }}>⟳ Loading data…</span>
            : <button onClick={loadContext} style={{ padding:'4px 8px', fontSize:10, borderRadius:4, cursor:'pointer', background:'var(--bg2)', border:'1px solid var(--border)', color:'var(--text3)' }}>↺ Data</button>}
          {messages.length > 0 && (
            <button onClick={() => setMessages([])}
              style={{ padding:'4px 8px', fontSize:10, borderRadius:4, cursor:'pointer', background:'var(--bg2)', border:'1px solid var(--border)', color:'var(--text3)' }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--border)', background:'var(--card)', flexShrink:0 }}>
          <div style={{ fontSize:11, fontWeight:700, color:curProvider.color, marginBottom:6 }}>
            {curProvider.icon} {curProvider.label} API Key
          </div>
          <div style={{ display:'flex', gap:6 }}>
            <input type="password" placeholder={curProvider.keyPlaceholder}
              value={apiKeys[provider] || ''}
              onChange={e => setApiKeys(prev => ({...prev, [provider]: e.target.value}))}
              style={{ flex:1, padding:'7px 10px', borderRadius:6, fontSize:11, fontFamily:'monospace',
                background:'var(--bg)', border:'1px solid var(--border)', color:'var(--text)' }}/>
            <button onClick={() => setShowSettings(false)}
              style={{ padding:'7px 14px', borderRadius:6, fontSize:11, fontWeight:700, cursor:'pointer', background:'#22c55e', color:'#fff', border:'none' }}>
              Save
            </button>
          </div>
          <div style={{ fontSize:10, color:'var(--text3)', marginTop:5 }}>
            {curProvider.keyHint} · Stored locally in your browser only, never sent to our servers
          </div>
          {error && <div style={{ marginTop:5, fontSize:10, color:'#ef4444' }}>⚠ {error}</div>}
        </div>
      )}

      {/* Body: sidebar + chat */}
      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>

        {/* Context sidebar */}
        {showSidebar && (
          <div style={{ width:180, flexShrink:0, borderRight:'1px solid var(--border)', overflowY:'auto', background:'var(--bg)' }}>
            <ContextPanel ctx={context} loading={loadingCtx} onRefresh={loadContext}/>
          </div>
        )}

        {/* Chat area */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

          {/* Messages */}
          <div style={{ flex:1, overflowY:'auto', padding:'14px 14px 6px' }}>

            {/* Empty state */}
            {messages.length === 0 && (
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:40, marginBottom:8 }}>{curProvider.icon}</div>
                <div style={{ fontSize:14, fontWeight:700, color:'var(--text)' }}>
                  {curProvider.label} ready
                </div>
                <div style={{ fontSize:11, color:'var(--text3)', marginBottom:18, marginTop:4 }}>
                  {context
                    ? `${context.summary.sessions.length ? context.summary.sessions.join(' + ') : 'No active'} session · Live data loaded`
                    : 'Loading live market data…'}
                </div>

                {/* 🏆 Best setups — deterministic, ranked from live data */}
                {topSetups.length > 0 && (
                  <div style={{ maxWidth:380, margin:'0 auto 18px', textAlign:'left' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
                      <span style={{ fontSize:12, fontWeight:800, color:'var(--text)' }}>🏆 Best Setups Right Now</span>
                      <span style={{ fontSize:9, color:'var(--text3)' }}>app-ranked · live data</span>
                    </div>
                    {topSetups.slice(0, 3).map((st, i) => (
                      <BestSetupCard key={st.id} setup={st} rank={i+1}
                        onValidate={validateSetup} disabled={!hasKey || streaming}/>
                    ))}
                    <div style={{ fontSize:9, color:'var(--text3)', textAlign:'center', marginTop:2 }}>
                      Scored on H4 bias · H1 structure · liquidity sweeps · COT · sentiment · killzone timing
                    </div>
                  </div>
                )}
                {context && !loadingCtx && topSetups.length === 0 && (
                  <div style={{ maxWidth:360, margin:'0 auto 16px', fontSize:10, color:'var(--text3)',
                    padding:'8px 12px', borderRadius:8, background:'var(--card)', border:'1px solid var(--border)' }}>
                    Connect OANDA (Auto Trading tab) to unlock the live Best-Setup scanner across metals + FX majors.
                  </div>
                )}

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:7, maxWidth:360, margin:'0 auto', textAlign:'left' }}>
                  {QUICK_PROMPTS.map(q => (
                    <button key={q.label} onClick={() => send(q.text)} disabled={!hasKey || streaming}
                      style={{ padding:'9px 11px', borderRadius:10, cursor:'pointer', textAlign:'left', transition:'all 0.15s',
                        background:'var(--card)', border:'1px solid var(--border)',
                        opacity: hasKey ? 1 : 0.45 }}>
                      <div style={{ fontSize:16, marginBottom:4 }}>{q.icon}</div>
                      <div style={{ fontSize:10, fontWeight:600, color:'var(--text)', lineHeight:1.3 }}>{q.label}</div>
                    </button>
                  ))}
                </div>
                {!hasKey && (
                  <div style={{ marginTop:16, fontSize:11, color:'#f59e0b' }}>
                    ⚠ Tap "Set key" above and enter your {curProvider.label} API key to start
                  </div>
                )}
              </div>
            )}

            {/* Message list */}
            {messages.map(msg => {
              const trades  = msg.role === 'assistant' ? extractTrades(msg.content) : [];
              const display = msg.role === 'assistant' ? stripTrades(msg.content)  : msg.content;
              const isUser  = msg.role === 'user';
              return (
                <div key={msg.id} style={{ marginBottom:14, display:'flex', flexDirection:'column',
                  alignItems: isUser ? 'flex-end' : 'flex-start' }}>

                  {/* Trade cards first */}
                  {trades.map((t, i) => <TradeCard key={i} trade={t}/>)}

                  {/* Text bubble */}
                  {(display || msg.isStreaming) && (
                    <div style={{ maxWidth:'94%', padding:'10px 13px',
                      borderRadius: isUser ? '16px 16px 4px 16px' : '4px 16px 16px 16px',
                      background:   isUser ? '#00d4aa1a' : 'var(--card)',
                      border: `1px solid ${isUser ? '#00d4aa33' : msg.isError ? '#ef444433' : 'var(--border)'}` }}>
                      {isUser
                        ? <span style={{ fontSize:12, color:'var(--text)' }}>{display}</span>
                        : <MsgContent text={display}/>}
                      {msg.isStreaming && (
                        <span style={{ display:'inline-block', width:7, height:13, background:'#00d4aa', borderRadius:1, marginLeft:3, verticalAlign:'middle', animation:'blink 0.8s step-end infinite' }}/>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={bottomRef}/>
          </div>

          {/* Quick prompts strip (while chatting) */}
          {messages.length > 0 && !streaming && (
            <div style={{ padding:'5px 12px', borderTop:'1px solid var(--border)', display:'flex', gap:5, flexWrap:'wrap', flexShrink:0 }}>
              {QUICK_PROMPTS.slice(0,5).map(q => (
                <button key={q.label} onClick={() => send(q.text)} disabled={!hasKey}
                  style={{ padding:'4px 11px', borderRadius:14, fontSize:10, fontWeight:600, cursor:'pointer', whiteSpace:'nowrap',
                    background:'var(--bg2)', border:'1px solid var(--border)', color:'var(--text3)' }}>
                  {q.icon} {q.label}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <form onSubmit={onSubmit}
            style={{ padding:'10px 12px', borderTop:'1px solid var(--border)', display:'flex', gap:8, flexShrink:0 }}>
            <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
              disabled={streaming || !hasKey}
              placeholder={hasKey ? 'Ask anything about the markets…' : `Enter ${curProvider.label} API key to start`}
              style={{ flex:1, padding:'10px 14px', borderRadius:22, fontSize:12,
                background:'var(--card)', border:'1px solid var(--border)', color:'var(--text)', outline:'none' }}/>
            <button type="submit" disabled={streaming || !hasKey || !input.trim()}
              style={{ width:42, height:42, borderRadius:21, border:'none', cursor:'pointer', fontSize:16, fontWeight:700, transition:'all 0.15s',
                background: (streaming || !hasKey || !input.trim()) ? 'var(--bg2)' : '#00d4aa',
                color:      (streaming || !hasKey || !input.trim()) ? 'var(--text3)' : '#080c14',
                boxShadow:  (!streaming && hasKey && input.trim()) ? '0 0 12px #00d4aa55' : 'none' }}>
              {streaming ? '⟳' : '↑'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

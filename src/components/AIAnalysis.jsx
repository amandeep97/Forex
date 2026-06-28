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
    id: 'openrouter', label: 'OpenRouter', badge: 'FREE', icon: '🔀', color: '#6366f1', vision: true,
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
    id: 'gemini', label: 'Gemini', badge: 'FREE', icon: '✦', color: '#4285f4', vision: true,
    keyPlaceholder: 'AIzaSyxxxxxxxxxxxxxxxx',
    keyHint: 'Free key → aistudio.google.com',
    models: [
      { id: 'gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash (latest)' },
      { id: 'gemini-2.5-pro-preview-06-05',   label: 'Gemini 2.5 Pro (latest)' },
      { id: 'gemini-2.0-flash',               label: 'Gemini 2.0 Flash' },
    ],
  },
  {
    id: 'claude', label: 'Claude', badge: 'PAID', icon: '◈', color: '#cc785c', vision: true,
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
  { label: 'Validate top setup', icon: '✅', text: "Take the #1 setup from the APP SETUP SCANNER. Validate or challenge it: do COT, Currency Strength, Alpha Lab sweep WR, Day-of-Week and Kill Zone AGREE with it or contradict it? Flag any imminent news risk. Give a verdict: TAKE IT / WAIT / SKIP, and exactly what would have to change to flip that verdict." },
  { label: "What's the data say", icon: '🧭', text: "Don't predict — just report what the deterministic tools say right now: scanner top setups + scores, Alpha Lab win-rates and any live sweeps, COT bias for all 7 currencies, Currency Strength ranking, DXY direction, active session/Kill Zone. Then tell me where they AGREE and where they CONTRADICT." },
  { label: 'Risk check',      icon: '⚠️', text: "Act as a risk checker. Given the current context, what should I AVOID right now? Imminent high-impact news, bad day-of-week, outside Kill Zone, COT at reversal extremes, or weak/low-sample Alpha Lab data. Be blunt about what makes now a bad time to trade." },
  { label: 'Alpha Lab read',  icon: '⚗',  text: "Analyze the ALPHA LAB SWEEP INTELLIGENCE section. Which pairs have the highest BACKTESTED sweep win rates and is the sample size big enough to trust? Any live pending sweeps? Treat anything under ~55% WR or ~20 samples as weak and say so." },
  { label: 'Challenge my idea', icon: '🥊', text: "I'm thinking about a trade (I'll describe it). Before I tell you, list what the deterministic data would need to show for it to be valid. Then when I give the idea, cross-check it against scanner, COT, strength, Alpha Lab and news, and try to talk me OUT of it if the data doesn't support it." },
  { label: 'COT reading',     icon: '🏦', text: 'Report the current COT positioning for all major currencies from the context. Who is at multi-month extremes (reversal risk)? Stick to what the numbers show — do not extrapolate a price prediction.' },
  { label: 'Session timing',  icon: '🕐', text: 'What session/Kill Zone is active right now? Based on the Alpha Lab sweep time DNA (which sessions show highest backtested win rates), which pairs are statistically worth watching — and is right now a good or bad window to be entering at all?' },
  { label: 'DXY impact',      icon: '💵', text: 'How is the current DXY direction affecting metals and USD pairs? Cross-check against COT and Alpha Lab data — does the data CONFIRM the DXY move or contradict it? Do not guess where DXY goes next.' },
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

async function fetchBinanceCloses(symbol, interval, limit) {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.slice(0, -1).map(k => parseFloat(k[4]));
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

function buildNewsContext() {
  try {
    const cache = JSON.parse(localStorage.getItem('forex_news_cache') || 'null');
    if (!cache?.items?.length) return '';
    const ageMin = Math.round((Date.now() - cache.ts) / 60000);
    if (ageMin > 120) return '';
    const L = [`=== LATEST MARKET NEWS (from ${cache.items[0]?.source || 'news feed'}, ${ageMin}m ago) ===`];
    for (const item of cache.items.slice(0, 8)) {
      const age = item.age != null ? `${item.age}m ago` : '';
      L.push(`• [${item.source}] ${item.title}${age ? ' (' + age + ')' : ''}`);
    }
    return L.join('\n');
  } catch { return ''; }
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

function buildDOWContext() {
  const now = new Date();
  const dow = now.getUTCDay();
  const name = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];
  const h = now.getUTCHours();
  const kz = [
    { name:'Asian', start:0, end:3 }, { name:'London', start:7, end:10 },
    { name:'NY AM', start:12, end:15 }, { name:'NY PM', start:17, end:19 },
  ].find(k => h >= k.start && h < k.end);
  const L = [`=== DAY-OF-WEEK + KILL ZONE CONTEXT ===`, `Today: ${name} UTC`];
  if (dow === 0 || dow === 6) L.push('Weekend — no institutional order flow, avoid trading');
  else if (dow === 1) L.push('Monday = range day. Check: did Fri high < Thu high? → targets Friday LOW today (Rule 1 bearish). Wait for London direction.');
  else if (dow === 2) L.push('Tuesday = HIGHEST PROBABILITY DAY (ICT). Strong trend continuation expected. Best day to trade.');
  else if (dow === 3) l: {
    L.push('Wednesday = mid-week extreme. CHECK Rule 2: is Wed high < Mon high? → Thu visits Wed LOW.');
    L.push('NY session often creates the weekly high or low today.');
  }
  else if (dow === 4) L.push('Thursday = Rule 2 TARGET DAY. If Rule 2 triggered Wednesday, today visits Wednesday LOW or HIGH. Strong institutional day.');
  else if (dow === 5) L.push('Friday CAUTION: sweeps often fail, market makers close positions. Check: Fri high vs Thu high → sets up next Monday Rule 1.');
  L.push(kz ? `⚡ ACTIVE KILL ZONE: ${kz.name} — prime entry window now` : `No Kill Zone active (next: London 07 UTC, NY AM 12 UTC)`);
  return L.join('\n');
}

async function buildMarketContext() {
  const session = getCurrentSessions();
  const [gold, silver, eurusd, bonds10, bonds2, oil, btc, eth,
         cotGold, cotSilver, cotEUR, cotGBP, cotJPY, cotAUD,
         cotCHF, cotNZD, cotCAD,
         h4EUR, h4GBP, h4JPY, h4CHF, h4AUD, h4CAD, h4NZD,
         scan] = await Promise.all([
    fetchCloses('XAU_USD',    'H1', 15),
    fetchCloses('XAG_USD',    'H1', 15),
    fetchCloses('EUR_USD',    'H1', 15),
    fetchCloses('USB10Y_USD', 'H1', 15),
    fetchCloses('USB02Y_USD', 'H1', 15),
    fetchCloses('BCO_USD',    'H1', 15),
    fetchBinanceCloses('BTCUSDT', '1h', 16),
    fetchBinanceCloses('ETHUSDT', '1h', 16),
    fetchCOT('088691'), fetchCOT('084691'),
    fetchCOT('099741'), fetchCOT('096742'),
    fetchCOT('097741'), fetchCOT('232741'),
    fetchCOT('092741'), fetchCOT('112741'), fetchCOT('090741'),
    fetchCloses('EUR_USD','H4',40), fetchCloses('GBP_USD','H4',40),
    fetchCloses('USD_JPY','H4',40), fetchCloses('USD_CHF','H4',40),
    fetchCloses('AUD_USD','H4',40), fetchCloses('USD_CAD','H4',40),
    fetchCloses('NZD_USD','H4',40),
    runMarketScan().catch(() => ({ ok: false, setups: [] })),
  ]);

  // Currency strength from H4 closes
  const strPairs = [
    ['EUR','USD',h4EUR], ['GBP','USD',h4GBP], ['USD','JPY',h4JPY],
    ['USD','CHF',h4CHF], ['AUD','USD',h4AUD], ['USD','CAD',h4CAD], ['NZD','USD',h4NZD],
  ];
  const strAcc = {}, strCnt = {};
  for (const [base, quote, closes] of strPairs) {
    if (!closes || closes.length < 2) continue;
    const pct = (closes[closes.length-1] - closes[0]) / closes[0];
    strAcc[base] = (strAcc[base]||0) + pct; strCnt[base] = (strCnt[base]||0) + 1;
    strAcc[quote] = (strAcc[quote]||0) - pct; strCnt[quote] = (strCnt[quote]||0) + 1;
  }
  const strengthRanked = Object.keys(strAcc).length
    ? Object.entries(strAcc).map(([c,v]) => [c, v/strCnt[c]]).sort((a,b) => b[1]-a[1])
    : [];

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

  if (btc || eth) {
    L.push('');
    L.push('=== CRYPTO (H1 momentum) ===');
    if (btc) L.push(`BTC/USDT: $${fmt(last(btc),0)} | ${pct5(btc) != null ? (+(pct5(btc))>=0?'+':'')+(+pct5(btc)).toFixed(2)+'%' : 'N/A'} | Trend: ${dirOf(btc) ?? 'unknown'}`);
    if (eth) L.push(`ETH/USDT: $${fmt(last(eth),0)} | ${pct5(eth) != null ? (+(pct5(eth))>=0?'+':'')+(+pct5(eth)).toFixed(2)+'%' : 'N/A'} | Trend: ${dirOf(eth) ?? 'unknown'}`);
    if (btc && eth) {
      const btcEthRatio = last(btc) && last(eth) ? (last(btc)/last(eth)).toFixed(1) : null;
      if (btcEthRatio) L.push(`BTC/ETH Ratio: ${btcEthRatio} — ${+btcEthRatio > 20 ? 'BTC dominance high' : 'ETH gaining on BTC'}`);
    }
  }
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
  if (cotCHF)    L.push(`CHF:    Net ${-cotCHF.net>=0?'+':''}${(-cotCHF.net).toLocaleString()} → ${-cotCHF.net>=0?'Bullish':'Bearish'} (inverted)`);
  if (cotNZD)    L.push(`NZD:    Net ${cotNZD.net>=0?'+':''}${cotNZD.net.toLocaleString()} → ${cotNZD.net>=0?'Bullish':'Bearish'}`);
  if (cotCAD)    L.push(`CAD:    Net ${-cotCAD.net>=0?'+':''}${(-cotCAD.net).toLocaleString()} → ${-cotCAD.net>=0?'Bullish':'Bearish'} (inverted)`);

  if (strengthRanked.length) {
    L.push('');
    L.push('=== CURRENCY STRENGTH (H4 relative momentum, strongest → weakest) ===');
    strengthRanked.forEach(([cur, val]) => {
      const arrow = val > 0.0003 ? '▲▲ STRONG' : val > 0 ? '▲ mild' : val < -0.0003 ? '▼▼ WEAK' : '▼ mild';
      L.push(`  ${cur}: ${val>=0?'+':''}${(val*100).toFixed(3)}% ${arrow}`);
    });
    if (strengthRanked.length >= 2) {
      const strongest = strengthRanked[0][0];
      const weakest   = strengthRanked[strengthRanked.length-1][0];
      L.push(`  → Best pair bias: LONG ${strongest}/${weakest} or SHORT ${weakest}/${strongest}`);
    }
  }

  L.push('');
  L.push(buildDOWContext());

  L.push('');
  const digest = scanDigest(scan);
  if (digest) { L.push(digest); L.push(''); }

  const newsCtx = buildNewsContext();
  if (newsCtx) { L.push(''); L.push(newsCtx); }

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
      strengthRanked,
      cotFX: { EUR:cotEUR, GBP:cotGBP, JPY:cotJPY, AUD:cotAUD, CHF:cotCHF, NZD:cotNZD, CAD:cotCAD },
    },
  };
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYS = `You are ForexPro AI — a trade VALIDATOR and risk-checker embedded in a professional multi-tab trading platform. You receive real-time market data with every message covering the full platform.

CRITICAL — KNOW YOUR LIMITS:
You CANNOT predict price direction, and you must never pretend to. You are a language model, not a forecasting engine. The platform's DETERMINISTIC, BACKTESTED tools are the source of truth — your job is to pressure-test their output, not to invent your own market calls.
- The APP SETUP SCANNER and ALPHA LAB win-rates are real, auditable numbers. Trust them OVER your own intuition.
- When asked "will X go up?" or "what's the best trade?", do NOT answer with a prediction. Instead, report what the deterministic data says, then validate or challenge it.
- If the data is mixed, weak, or contradictory, the correct answer is "NO TRADE / wait" — say so plainly. A confident-sounding guess is worse than an honest "the data doesn't align."

YOUR DATA SOURCES (all provided in context):
1. APP SETUP SCANNER — confluence scores from live H4 bias, H1 structure, COT, session timing. THE primary signal.
2. ALPHA LAB SWEEP INTELLIGENCE — historical liquidity sweep win rates per pair, live pending sweeps, saved scenario results. Backtested — this is your strongest evidence.
3. COT DATA — CFTC non-commercial positioning for ALL 7 major currencies (EUR, GBP, JPY, AUD, CHF, NZD, CAD) + Gold + Silver
4. CURRENCY STRENGTH — H4 relative momentum ranking for all 7 currencies (strongest to weakest)
5. MACRO — DXY, US yields (10Y/2Y), real yield proxy, yield curve
6. SESSION + DAY-OF-WEEK — active Kill Zone, ICT DOW rules, best/worst trading days
7. NEWS — latest headlines + imminent high-impact events if available

YOUR JOB, IN ORDER:
1. State what the deterministic tools say (scanner score, Alpha Lab WR, COT, strength) — cite the actual numbers.
2. Check for AGREEMENT vs CONTRADICTION across sources. Agreement = higher confidence. Contradiction = lower or no trade.
3. Flag RISK: imminent news events, Friday/Sunday, outside Kill Zone, COT at extremes (reversal risk), low backtested sample size.
4. Give a verdict: TAKE IT / WAIT / SKIP — and the single clearest reason.

ALWAYS reference actual numbers from the data. Never give generic advice. Never cite a number that isn't in the context.

When the deterministic data supports a setup you can confirm, output it in this EXACT format on its own line:
\`\`\`trade
{"action":"BUY","pair":"XAU/USD","entry":"market","sl":"3228","tp":"3280","rr":"1:2","confidence":75,"reason":"Scanner 78 + Alpha Lab 68% WR on XAU sweeps + COT net long — all agree"}
\`\`\`
Only emit a trade card when at least the scanner AND one other source (Alpha Lab WR, COT, or strength) agree. If they don't agree, emit NO card and explain why you're standing aside.

TRADE LEVEL RULES (critical — you cannot see live prices, so do NOT fabricate them):
- Only put exact numbers in entry/sl/tp if they come from the context's live data or the user's chart. If you don't have a real price, set entry to "market" and describe SL/TP as relative (e.g. "SL above the swing high, TP at 2R") rather than inventing digits.
- If you do give numeric levels: for a LONG, SL must be BELOW entry and TP ABOVE entry; for a SHORT, SL ABOVE entry and TP BELOW entry. Never the reverse.
- Take profit must give at least 1.5R. Never place TP within a few pips of entry (that is a 0R trade and is wrong).
- Confidence must be ≤55 whenever R:R is below 1.5. A high-confidence, low-R:R trade is a contradiction — never output one.

Rules:
- Confidence reflects how many INDEPENDENT sources agree, not your gut: 50-65=one source, 66-79=two agree, 80+=three+ agree (90+ only when scanner + COT + Strength + Alpha Lab ALL align AND timing is clean)
- Alpha Lab WR below ~55% or sample under ~20 = treat as weak evidence, say so
- Check Day-of-Week + Kill Zone: Friday/Sunday or outside KZ = downgrade or wait, even on a good score
- Check NEWS: if a high-impact event is imminent for either currency, advise waiting until after the release regardless of score
- Flag contradictions explicitly: e.g. "Scanner says BUY GBP but Currency Strength has GBP weakest this week and COT is net short — contradiction, WAIT"
- Be concise: bullet points, 2-3 sentences per point. Maximum 2 trade ideas per response.
- If OANDA not connected, say price data is unavailable but you can still analyse COT/macro/Alpha Lab
- Never oversell. End uncertain reads with what would need to change for the trade to become valid.

CHART IMAGES: If the user attaches a chart screenshot, read it carefully — identify the pair/timeframe if visible, market structure (HH/HL or LH/LL), key swing highs/lows, any drawn zones or levels, and where price is now relative to them. Then CROSS-CHECK what you see against the deterministic data in context (scanner, COT, strength, Alpha Lab). If the chart and the data disagree, say so. Describe only what is actually visible — never invent price levels you cannot read.`;

// ── Image helpers ─────────────────────────────────────────────────────────────
// Split a data URL "data:image/png;base64,XXXX" into { mediaType, base64 }
function parseDataUrl(dataUrl) {
  const m = /^data:(.*?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mediaType: m[1], base64: m[2] } : null;
}

// Convert our normalized message (may carry .image dataUrl) to OpenAI multimodal content
function toOpenAIContent(m) {
  if (!m.image) return m.content;
  return [
    { type: 'text', text: m.content || 'Analyze this chart.' },
    { type: 'image_url', image_url: { url: m.image } },
  ];
}

// ── Streaming generators ──────────────────────────────────────────────────────
async function* streamOpenAI(url, key, model, messages, extra = {}) {
  const apiMessages = messages.map(m => ({ role: m.role, content: toOpenAIContent(m) }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}`, ...extra },
    body: JSON.stringify({ model, messages: apiMessages, stream:true, max_tokens:1400, temperature:0.7 }),
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
    .map(m => {
      const parts = [{ text: m.content || 'Analyze this chart.' }];
      const img = m.image ? parseDataUrl(m.image) : null;
      if (img) parts.push({ inline_data: { mime_type: img.mediaType, data: img.base64 } });
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });
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
      messages: messages.filter(m=>m.role!=='system').map(m=>{
        const img = m.image ? parseDataUrl(m.image) : null;
        if (!img) return { role:m.role, content:m.content };
        return { role:m.role, content:[
          { type:'text', text:m.content || 'Analyze this chart.' },
          { type:'image', source:{ type:'base64', media_type:img.mediaType, data:img.base64 } },
        ]};
      }),
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

// Validate AI-proposed levels — weak models often fabricate nonsensical entry/SL/TP.
// Returns { ok, rr, msg }. ok:false → render a warning instead of a real card.
function analyzeTrade(trade) {
  const e = parseFloat(trade.entry), s = parseFloat(trade.sl), t = parseFloat(trade.tp);
  const isLong = ['BUY','LONG'].includes((trade.action || '').toUpperCase());
  if (!(e > 0) || !(s > 0)) return { ok:true, rr:null };          // market/missing levels — can't validate
  const risk = Math.abs(e - s);
  if (risk === 0) return { ok:false, msg:'Stop loss equals entry — no defined risk. Ignore these levels.' };
  if (isLong ? s >= e : s <= e)
    return { ok:false, msg:`Stop loss is on the wrong side for a ${isLong ? 'long' : 'short'}. Levels are invalid.` };
  let rr = null;
  if (t > 0) {
    if (isLong ? t <= e : t >= e)
      return { ok:false, msg:`Take profit is on the wrong side — reward ≈ 0. The model invented bad levels; ignore.` };
    rr = Math.abs(t - e) / risk;
    if (rr < 0.3) return { ok:false, msg:'Take profit is almost at entry — reward ≈ 0. The model fabricated levels; ignore.' };
  }
  return { ok:true, rr };
}

// ── Trade card ────────────────────────────────────────────────────────────────
function TradeCard({ trade }) {
  const check = analyzeTrade(trade);

  // Reject degenerate AI levels with an honest warning instead of a misleading card
  if (!check.ok) {
    return (
      <div style={{ borderRadius:10, border:'1px solid #ef444455', borderLeft:'4px solid #ef4444',
        background:'#ef44440d', padding:'12px 14px', marginBottom:6 }}>
        <div style={{ fontSize:12, fontWeight:800, color:'#ef4444', marginBottom:5 }}>
          ⚠ AI proposed invalid levels — discard
        </div>
        <div style={{ fontSize:10.5, color:'var(--text3)', lineHeight:1.5, marginBottom:6 }}>
          {trade.action} {trade.pair} · {check.msg}
        </div>
        <div style={{ fontSize:9.5, color:'#64748b', lineHeight:1.5 }}>
          This is the model guessing prices it can't see. Use the <strong>Setup Planner</strong> or your live chart
          for real entry/SL/TP — or switch to a stronger model (Claude/Gemini) for level work.
        </div>
      </div>
    );
  }

  const col = { BUY:'#22c55e', SELL:'#ef4444', LONG:'#22c55e', SHORT:'#ef4444' }[trade.action?.toUpperCase()] || '#00d4aa';
  // Trust computed R:R over the model's claimed rr string; cap confidence to R:R quality
  const rr = check.rr;
  let conf = trade.confidence ?? 0;
  if (rr != null && rr < 1.5 && conf > 60) conf = 55;     // weak R:R can't be high-confidence
  const confCol = conf >= 80 ? '#22c55e' : conf >= 66 ? '#f59e0b' : '#ef4444';
  const rrCol = rr == null ? col : rr >= 2 ? '#22c55e' : rr >= 1 ? '#f59e0b' : '#ef4444';
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
      {rr != null
        ? <div style={{ fontSize:11, fontWeight:700, color:rrCol, marginBottom:4 }}>
            Risk:Reward = 1 : {rr.toFixed(2)}{rr < 1 ? ' — poor, reward below risk' : ''}
          </div>
        : trade.rr && <div style={{ fontSize:11, fontWeight:700, color:col, marginBottom:4 }}>Risk:Reward = {trade.rr}</div>}
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

      {/* FX Strength */}
      {s.strengthRanked?.length > 0 && (
        <>
          <div style={{ fontSize:9, color:'var(--text3)', marginTop:8, marginBottom:4, textTransform:'uppercase', letterSpacing:1 }}>FX Strength (H4)</div>
          {s.strengthRanked.map(([cur, val]) => {
            const c = val > 0 ? '#22c55e' : '#ef4444';
            return row(cur, `${val>=0?'+':''}${(val*100).toFixed(3)}%`, c);
          })}
        </>
      )}

      {/* COT */}
      <div style={{ fontSize:9, color:'var(--text3)', marginTop:8, marginBottom:4, textTransform:'uppercase', letterSpacing:1 }}>COT Bias</div>
      {s.cotGold   && row('Gold',   s.cotGold.net>=0  ?'Net Long ▲':'Net Short ▼', s.cotGold.net>=0  ?'#22c55e':'#ef4444')}
      {s.cotSilver && row('Silver', s.cotSilver.net>=0?'Net Long ▲':'Net Short ▼', s.cotSilver.net>=0?'#22c55e':'#ef4444')}
      {s.cotFX && Object.entries(s.cotFX).map(([cur, d]) => {
        if (!d) return null;
        const net = ['JPY','CHF','CAD'].includes(cur) ? -d.net : d.net;
        return row(cur, net>=0?'Long ▲':'Short ▼', net>=0?'#22c55e':'#ef4444');
      })}

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
  const [image, setImage]       = useState(null); // data URL of attached chart
  const [streaming, setStreaming] = useState(false);
  const [context, setContext]   = useState(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [error, setError]       = useState('');
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const fileRef   = useRef(null);

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
  const send = useCallback(async (text, img = null) => {
    const trimmed = text?.trim();
    const attached = img ?? image;
    if ((!trimmed && !attached) || streaming) return;
    if (!hasKey) { setShowSettings(true); setError('Please enter your API key first'); return; }
    if (attached && !curProvider.vision) {
      setError(`${curProvider.label} can't read images. Switch to Gemini, Claude, or OpenRouter (vision model) to analyze charts.`);
      return;
    }
    setError('');

    const userText = trimmed || 'Analyze this chart using my live market data context.';
    const uid = Date.now(), aid = Date.now()+1;
    const sysContent = `${SYS}\n\n${context?.text ?? '(Market data unavailable — OANDA not connected)'}`;
    const history = messages.filter(m => m.role !== 'system');
    const apiMsgs = [
      { role:'system', content:sysContent },
      ...history.map(m => ({ role:m.role, content:m.content })),
      { role:'user', content:userText, ...(attached ? { image: attached } : {}) },
    ];

    setMessages(prev => [
      ...prev,
      { role:'user',      content:userText, id:uid, image: attached || undefined },
      { role:'assistant', content:'',       id:aid, isStreaming:true },
    ]);
    setStreaming(true);
    setInput('');
    setImage(null);

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
  }, [streaming, hasKey, context, messages, provider, model, apiKeys, image, curProvider]);

  const onSubmit = e => { e.preventDefault(); send(input); };

  const onPickImage = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return;
    if (file.size > 5 * 1024 * 1024) { setError('Image too large (max 5MB)'); return; }
    const reader = new FileReader();
    reader.onload = () => setImage(reader.result);
    reader.readAsDataURL(file);
  }, []);

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

                  {/* Attached chart thumbnail */}
                  {msg.image && (
                    <img src={msg.image} alt="chart" style={{ maxWidth:'70%', maxHeight:200, objectFit:'contain',
                      borderRadius:10, border:'1px solid #00d4aa33', marginBottom:6 }}/>
                  )}

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

          {/* Image preview chip */}
          {image && (
            <div style={{ padding:'8px 12px 0', display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
              <div style={{ position:'relative', display:'inline-block' }}>
                <img src={image} alt="chart" style={{ height:54, borderRadius:8, border:'1px solid #00d4aa44' }}/>
                <button onClick={() => setImage(null)} type="button"
                  style={{ position:'absolute', top:-7, right:-7, width:20, height:20, borderRadius:10, border:'none',
                    cursor:'pointer', background:'#ef4444', color:'#fff', fontSize:12, fontWeight:700, lineHeight:1 }}>×</button>
              </div>
              <span style={{ fontSize:10, color: curProvider.vision ? 'var(--text3)' : '#ef4444' }}>
                {curProvider.vision ? '📊 Chart attached — ask a question or just send' : `⚠ ${curProvider.label} can't read images`}
              </span>
            </div>
          )}

          {/* Input */}
          <form onSubmit={onSubmit}
            style={{ padding:'10px 12px', borderTop:'1px solid var(--border)', display:'flex', gap:8, flexShrink:0, alignItems:'center' }}>
            <input type="file" accept="image/*" ref={fileRef} style={{ display:'none' }}
              onChange={e => { onPickImage(e.target.files?.[0]); e.target.value=''; }}/>
            <button type="button" title="Attach a chart screenshot"
              onClick={() => curProvider.vision ? fileRef.current?.click()
                : setError(`${curProvider.label} can't read images — switch to Gemini, Claude, or OpenRouter.`)}
              disabled={streaming || !hasKey}
              style={{ width:42, height:42, borderRadius:21, flexShrink:0, cursor:(streaming||!hasKey)?'not-allowed':'pointer',
                fontSize:17, background:'var(--card)', border:`1px solid ${image ? '#00d4aa66' : 'var(--border)'}`,
                color: image ? '#00d4aa' : 'var(--text3)' }}>
              📎
            </button>
            <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
              disabled={streaming || !hasKey}
              placeholder={hasKey ? (image ? 'Ask about this chart…' : 'Ask anything, or 📎 a chart…') : `Enter ${curProvider.label} API key to start`}
              style={{ flex:1, padding:'10px 14px', borderRadius:22, fontSize:12,
                background:'var(--card)', border:'1px solid var(--border)', color:'var(--text)', outline:'none' }}/>
            <button type="submit" disabled={streaming || !hasKey || (!input.trim() && !image)}
              style={{ width:42, height:42, borderRadius:21, border:'none', cursor:'pointer', fontSize:16, fontWeight:700, transition:'all 0.15s', flexShrink:0,
                background: (streaming || !hasKey || (!input.trim() && !image)) ? 'var(--bg2)' : '#00d4aa',
                color:      (streaming || !hasKey || (!input.trim() && !image)) ? 'var(--text3)' : '#080c14',
                boxShadow:  (!streaming && hasKey && (input.trim() || image)) ? '0 0 12px #00d4aa55' : 'none' }}>
              {streaming ? '⟳' : '↑'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

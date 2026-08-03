// src/utils/pairStats.js
// Pair Hub's empirical scoring, moved verbatim out of the component.
// Win rate by day and session is the one input in this app derived from
// realised outcomes rather than indicators, which makes it the most valuable
// thing to have available elsewhere — and it was locked in a component.
'use strict';

const ALL_PAIRS = [
  // Forex Majors
  { key:'EUR_USD', label:'EUR/USD', group:'Forex',   pip:0.0001, cot:['EUR','USD'] },
  { key:'GBP_USD', label:'GBP/USD', group:'Forex',   pip:0.0001, cot:['GBP','USD'] },
  { key:'USD_JPY', label:'USD/JPY', group:'Forex',   pip:0.01,   cot:['USD','JPY'] },
  { key:'USD_CHF', label:'USD/CHF', group:'Forex',   pip:0.0001, cot:['USD','CHF'] },
  { key:'AUD_USD', label:'AUD/USD', group:'Forex',   pip:0.0001, cot:['AUD','USD'] },
  { key:'USD_CAD', label:'USD/CAD', group:'Forex',   pip:0.0001, cot:['USD','CAD'] },
  { key:'NZD_USD', label:'NZD/USD', group:'Forex',   pip:0.0001, cot:['NZD','USD'] },
  { key:'GBP_JPY', label:'GBP/JPY', group:'Forex',   pip:0.01,   cot:['GBP','JPY'] },
  { key:'EUR_JPY', label:'EUR/JPY', group:'Forex',   pip:0.01,   cot:['EUR','JPY'] },
  { key:'EUR_GBP', label:'EUR/GBP', group:'Forex',   pip:0.0001, cot:['EUR','GBP'] },
  { key:'AUD_JPY', label:'AUD/JPY', group:'Forex',   pip:0.01,   cot:['AUD','JPY'] },
  { key:'CAD_JPY', label:'CAD/JPY', group:'Forex',   pip:0.01,   cot:['CAD','JPY'] },
  // Metals
  { key:'XAU_USD', label:'XAU/USD', group:'Metals',  pip:0.01,   cot:['XAU','USD'] },
  { key:'XAG_USD', label:'XAG/USD', group:'Metals',  pip:0.001,  cot:['XAG','USD'] },
  // Indices
  { key:'US30_USD',   label:'US30',   group:'Indices', pip:1, cot:[] },
  { key:'NAS100_USD', label:'NAS100', group:'Indices', pip:1, cot:[] },
  { key:'SPX500_USD', label:'SPX500', group:'Indices', pip:1, cot:[] },
  { key:'DE30_EUR',   label:'GER40',  group:'Indices', pip:1, cot:[] },
  { key:'JP225_USD',  label:'JPN225', group:'Indices', pip:1, cot:[] },
  { key:'UK100_GBP',  label:'UK100',  group:'Indices', pip:1, cot:[] },
];

const GROUP_COLORS = { Forex:'#8b5cf6', Metals:'#f59e0b', Indices:'#22c55e' };

const TV_SYMBOLS = {
  EUR_USD:'FX:EURUSD', GBP_USD:'FX:GBPUSD', USD_JPY:'FX:USDJPY',
  USD_CHF:'FX:USDCHF', AUD_USD:'FX:AUDUSD', USD_CAD:'FX:USDCAD',
  NZD_USD:'FX:NZDUSD', GBP_JPY:'FX:GBPJPY', EUR_JPY:'FX:EURJPY',
  EUR_GBP:'FX:EURGBP', AUD_JPY:'FX:AUDJPY', CAD_JPY:'FX:CADJPY',
  XAU_USD:'TVC:GOLD',  XAG_USD:'TVC:SILVER',
  US30_USD:'DJ:DJI', NAS100_USD:'NASDAQ:NDX', SPX500_USD:'SP:SPX',
  DE30_EUR:'XETR:DAX', JP225_USD:'INDEX:NKY', UK100_GBP:'INDEX:UKX',
};

function getCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) { const _e = localStorage.getItem('oanda_env'); return _e !== null ? { ...c, practice: _e !== 'live' } : c; }
    const k = localStorage.getItem('oanda_key');
    if (k) return { apiKey: k, practice: localStorage.getItem('oanda_env') !== 'live' };
  } catch {}
  return null;
}

async function fetchPrice(pairKey) {
  const creds = getCreds();
  if (!creds) return null;
  const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
  try {
    const r = await fetch(
      `${base}/instruments/${pairKey}/candles?granularity=H1&count=25&price=M`,
      { headers:{ Authorization:`Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const candles = (d.candles||[]).filter(c=>c.complete).map(c=>+c.mid.c);
    if (!candles.length) return null;
    const last = candles[candles.length-1];
    const prev = candles[candles.length-6] || candles[0];
    const change = ((last - prev) / prev * 100);
    const high = Math.max(...candles), low = Math.min(...candles);
    const pct = high > low ? ((last - low)/(high-low)*100) : 50;
    const trend = last > candles[candles.length-4] ? 'up' : 'down';
    return { price:last, change, pct, trend, candles };
  } catch { return null; }
}

async function fetchLivePrice(pairKey) {
  const creds = getCreds();
  if (!creds) return null;
  const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
  try {
    const r = await fetch(
      `${base}/instruments/${pairKey}/candles?granularity=M1&count=2&price=M`,
      { headers:{ Authorization:`Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const candles = d.candles || [];
    if (!candles.length) return null;
    return +candles[candles.length - 1].mid.c;
  } catch { return null; }
}

function getAlphaStats(pairKey) {
  try {
    const store = JSON.parse(localStorage.getItem('alpha_lab_v2')||'{}');
    const log = (store.sweepLog||[]).filter(s=>s.pair===pairKey);
    const resolved = log.filter(s=>s.outcome!=='pending');
    const confirmed = resolved.filter(s=>s.outcome==='confirmed');
    const pending = log.filter(s=>s.outcome==='pending');
    const wr = resolved.length ? Math.round(confirmed.length/resolved.length*100) : null;
    const bullLog = resolved.filter(s=>s.expectedDir==='bullish');
    const bearLog = resolved.filter(s=>s.expectedDir==='bearish');
    const bullWR = bullLog.length>=3 ? Math.round(bullLog.filter(s=>s.outcome==='confirmed').length/bullLog.length*100) : null;
    const bearWR = bearLog.length>=3 ? Math.round(bearLog.filter(s=>s.outcome==='confirmed').length/bearLog.length*100) : null;
    const recent = log.slice(0,5);
    return { total:log.length, resolved:resolved.length, wr, bullWR, bearWR, pending:pending.length, recent };
  } catch { return null; }
}

// Best session hours (UTC) for each pair group
const PAIR_SESSIONS = {
  EUR_USD:{ name:'London/NY', utcFrom:8,  utcTo:17 },
  GBP_USD:{ name:'London/NY', utcFrom:8,  utcTo:17 },
  USD_JPY:{ name:'Tokyo/London', utcFrom:0, utcTo:12 },
  USD_CHF:{ name:'London/NY', utcFrom:8,  utcTo:17 },
  AUD_USD:{ name:'Sydney/Tokyo', utcFrom:22, utcTo:9 },
  USD_CAD:{ name:'NY',        utcFrom:13, utcTo:22 },
  NZD_USD:{ name:'Sydney/Tokyo', utcFrom:22, utcTo:9 },
  GBP_JPY:{ name:'London',   utcFrom:8,  utcTo:13 },
  EUR_JPY:{ name:'London',   utcFrom:8,  utcTo:13 },
  EUR_GBP:{ name:'London',   utcFrom:8,  utcTo:17 },
  AUD_JPY:{ name:'Tokyo',    utcFrom:0,  utcTo:9  },
  CAD_JPY:{ name:'London/NY',utcFrom:8,  utcTo:17 },
  XAU_USD:{ name:'London/NY',utcFrom:8,  utcTo:17 },
  XAG_USD:{ name:'London/NY',utcFrom:8,  utcTo:17 },
  US30_USD:{ name:'NY',      utcFrom:13, utcTo:21 },
  NAS100_USD:{ name:'NY',    utcFrom:13, utcTo:21 },
  SPX500_USD:{ name:'NY',    utcFrom:13, utcTo:21 },
  DE30_EUR:{ name:'London',  utcFrom:7,  utcTo:16 },
  JP225_USD:{ name:'Tokyo',  utcFrom:0,  utcTo:9  },
  UK100_GBP:{ name:'London', utcFrom:8,  utcTo:16 },
};

function isInSession(pairKey) {
  const s = PAIR_SESSIONS[pairKey];
  if (!s) return false;
  const h = new Date().getUTCHours();
  if (s.utcFrom < s.utcTo) return h >= s.utcFrom && h < s.utcTo;
  return h >= s.utcFrom || h < s.utcTo;
}

function dowFactor() {
  const d = new Date().getDay(); // 0=Sun,1=Mon,...,6=Sat
  return d === 2 || d === 3 ? 20  // Tue/Wed — highest probability
       : d === 1 || d === 4 ? 12  // Mon/Thu — good
       : d === 5             ?  5  // Fri — low, often trap
       : 0;                        // Weekend
}

// ── Honest scoring helpers ───────────────────────────────────────────────────
// A win rate from five samples is not a win rate. Rather than a hard cutoff
// that makes a pair vanish the moment it has four, the observed rate is pulled
// toward a coin flip by how little evidence supports it: 5 wins from 6 becomes
// 58%, while 40 from 60 stays at 63%. Extraordinary numbers need extraordinary
// sample sizes, and small samples stop producing extraordinary numbers.
const PRIOR_N = 20;
function shrunkWR(wins, n) {
  if (!n) return null;
  return Math.round(((wins + 0.5 * PRIOR_N) / (n + PRIOR_N)) * 100);
}

// Points are grouped by what they independently measure. The old scoring added
// overall win rate, today's win rate and the directional win rate together —
// but today's trades are INSIDE the overall set, so one good run was counted
// three times and a pair could show 100 on a handful of trades.
//
// Deliberately gone:
//   dowFactor  — the same bonus for every pair on a given day, so it cannot
//                rank anything; it only inflated the whole board on Tuesdays
//   hot streak — three wins in a row is recency, not evidence
const FAMILY_MAX = { record: 30, live: 30, timing: 15, htf: 5 };

// ── Cross-instrument consistency ─────────────────────────────────────────────
// Each pair is scored on its own, which is how a ranking ended up showing
// NAS100 LONG at 92 directly above SPX500 SHORT at 84. Those two move together
// almost all the time, so that is not a view of the market — it is two
// independent statistics disagreeing, and it is the clearest possible sign that
// the numbers are noise rather than a read.
//
// Grouped by what actually moves together, not by tab.
const MOVES_TOGETHER = [
  { name:'equity indices', test: k => /SPX|NAS|US30|US2000|UK100|DE30|GER|JP225|JPN/i.test(k) },
  { name:'precious metals', test: k => /XAU|XAG/i.test(k) },
  { name:'crude oil',       test: k => /WTI|BCO|USOIL|UKOIL/i.test(k) },
];

// rows: [{ key, direction }] → Map(key -> warning)
export function directionConflicts(rows) {
  const out = new Map();
  for (const g of MOVES_TOGETHER) {
    const inGroup = (rows || []).filter(r => r.direction && g.test(r.key || ''));
    if (inGroup.length < 2) continue;
    const longs  = inGroup.filter(r => r.direction === 'long');
    const shorts = inGroup.filter(r => r.direction === 'short');
    if (!longs.length || !shorts.length) continue;
    const msg = `${g.name} disagree — ${longs.map(r=>r.label||r.key).join(', ')} long vs `
              + `${shorts.map(r=>r.label||r.key).join(', ')} short. These move together, so at most one can be right.`;
    for (const r of inGroup) out.set(r.key, msg);
  }
  return out;
}

// Correlated instruments pointing the same way are ONE position, not several.
// Taking the top five as five trades is usually taking two at double size.
export function exposureGroups(rows) {
  const groups = [];
  for (const g of MOVES_TOGETHER) {
    const inGroup = (rows || []).filter(r => r.direction && g.test(r.key || ''));
    if (inGroup.length >= 2) groups.push({ name:g.name, members:inGroup.map(r=>r.label||r.key), dirs:[...new Set(inGroup.map(r=>r.direction))] });
  }
  return groups;
}

function scorePairToday(pair) {
  const fam = {};                       // family -> { pts, notes[] }
  const addF = (family, pts, note) => {
    const f = (fam[family] ||= { pts: 0, notes: [] });
    f.pts = Math.max(f.pts, pts);       // strongest in the family, not the sum
    if (note) f.notes.push(note);
  };
  const breakdown = [];
  let direction = null;
  let dirReason = '';
  let levels = null;
  let sample = 0;

  try {
    const store = JSON.parse(localStorage.getItem('alpha_lab_v2')||'{}');
    const log = (store.sweepLog||[]).filter(s=>s.pair===pair.key);
    const resolved = log.filter(s=>s.outcome!=='pending');
    const confirmed = resolved.filter(s=>s.outcome==='confirmed');
    const pending = log.filter(s=>s.outcome==='pending');
    sample = resolved.length;

    const rawWR = resolved.length ? Math.round(confirmed.length/resolved.length*100) : null;
    const wr    = shrunkWR(confirmed.length, resolved.length);

    const bullLog = resolved.filter(s=>s.expectedDir==='bullish');
    const bearLog = resolved.filter(s=>s.expectedDir==='bearish');
    const bullWR = shrunkWR(bullLog.filter(s=>s.outcome==='confirmed').length, bullLog.length);
    const bearWR = shrunkWR(bearLog.filter(s=>s.outcome==='confirmed').length, bearLog.length);

    // ── Direction ──
    if (pending.length > 0) {
      const liveSweep = pending[0];
      direction = liveSweep.expectedDir === 'bullish' ? 'long' : 'short';
      dirReason = `Live sweep expects ${direction.toUpperCase()}`;
      addF('live', 30, 'Live sweep');
    }
    if (!direction) {
      const recent = log.find(s => s.outcome !== 'pending' &&
        Date.now() - new Date(s.time).getTime() < 48 * 3600 * 1000);
      if (recent) {
        direction = recent.expectedDir === 'bullish' ? 'long' : 'short';
        dirReason = `Recent ${recent.outcome === 'confirmed' ? '✓' : ''} sweep was ${direction.toUpperCase()}`;
        addF('live', 15, 'Recent sweep');
      }
    }
    if (!direction && (bullWR != null || bearWR != null)) {
      if (bullWR != null && (bearWR == null || bullWR >= bearWR)) {
        direction = 'long'; dirReason = `Long ${bullWR}% > Short ${bearWR??'n/a'}% (adjusted)`;
      } else {
        direction = 'short'; dirReason = `Short ${bearWR}% > Long ${bullWR??'n/a'}% (adjusted)`;
      }
    }

    // ── Record: ONE family. Overall, today's and directional win rates are all
    //    the same trades sliced differently, so the strongest counts and the
    //    rest only corroborate.
    if (wr != null && resolved.length >= 5) {
      const pts = wr >= 62 ? 30 : wr >= 56 ? 20 : wr >= 52 ? 10 : 0;
      if (pts) addF('record', pts, `WR ${wr}% adj (raw ${rawWR}%, n=${resolved.length})`);
    }

    const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const todayLabel = dowNames[new Date().getDay()];
    const todayLog = resolved.filter(s => (s.dow ?? dowNames[new Date(s.time).getDay()]) === todayLabel);
    if (todayLog.length >= 5) {
      const tWR = shrunkWR(todayLog.filter(s=>s.outcome==='confirmed').length, todayLog.length);
      if (tWR >= 56) addF('record', 0, `${todayLabel} ${tWR}% adj (n=${todayLog.length})`);
      if (direction) dirReason += ` · ${todayLabel} n=${todayLog.length}`;
    }

    const dirWR = direction === 'long' ? bullWR : bearWR;
    const dirN  = direction === 'long' ? bullLog.length : bearLog.length;
    if (dirWR != null && dirWR >= 58 && dirN >= 5) addF('record', 0, `${direction} ${dirWR}% adj (n=${dirN})`);

    // ── Timing and higher-timeframe agreement: genuinely separate lenses ──
    if (isInSession(pair.key)) addF('timing', 15, 'Peak session');
    const latestSweep = log.find(s=>s.htfAligned!=null);
    if (latestSweep?.htfAligned) addF('htf', 5, 'HTF aligned');

    // ── Trade levels from sweep ──
    const sourceSweep = pending[0] || log.find(s =>
      s.outcome !== 'pending' &&
      Date.now() - new Date(s.time).getTime() < 48 * 3600 * 1000
    );
    if (sourceSweep && sourceSweep.level && sourceSweep.entryPrice) {
      const pip = sourceSweep.pip || pair.pip;
      const isLong = (sourceSweep.expectedDir === 'bullish');
      const entry = sourceSweep.entryPrice;

      // SL: 5 pips beyond the swept level, then enforce minimum risk from entry
      // Indices need ~15 pts, metals ~100 pips, forex 10 pips minimum
      const bufferPips = pair.group === 'Indices' ? 15 : 5;
      const buffer = pip * bufferPips;
      const slFromLevel = isLong ? sourceSweep.level - buffer
                                 : sourceSweep.level + buffer;
      const minRiskPips = pair.group === 'Indices' ? 20 : pair.group === 'Metals' ? 120 : 10;
      const minRisk = pip * minRiskPips;
      // Ensure SL is at least minRisk away from entry
      const sl = isLong
        ? Math.min(slFromLevel, entry - minRisk)
        : Math.max(slFromLevel, entry + minRisk);
      const risk = Math.abs(entry - sl);
      const tp1  = isLong ? entry + risk * 2 : entry - risk * 2;   // 1:2 R:R
      const tp2  = isLong ? entry + risk * 3 : entry - risk * 3;   // 1:3 R:R
      const riskPips = Math.round(risk / pip);
      const dec = pip >= 1 ? 2 : pip >= 0.01 ? 3 : pip >= 0.001 ? 3 : 5;
      levels = {
        entry:    entry.toFixed(dec),
        sl:       sl.toFixed(dec),
        tp1:      tp1.toFixed(dec),
        tp2:      tp2.toFixed(dec),
        riskPips,
        tp1Pips:  riskPips * 2,
        tp2Pips:  riskPips * 3,
        isLive:   sourceSweep.outcome === 'pending',
      };
    }

  } catch {}

  // Strongest per family, plus a little for each extra INDEPENDENT family.
  // Corroboration inside a family adds 2, not another full score.
  const names = Object.keys(fam);
  let base = 0;
  for (const n of names) {
    base += fam[n].pts + 2 * Math.max(0, fam[n].notes.length - 1);
    for (const note of fam[n].notes) breakdown.push(note);
  }
  const score = Math.min(100, Math.round(base + 5 * Math.max(0, names.length - 1)));

  return {
    score, breakdown, direction, dirReason, levels,
    families: names.length, sample,
    thin: sample > 0 && sample < 30,     // below the grading engine's own MIN_SAMPLE
  };
}

function getNewsForPair(pair) {
  try {
    const cache = JSON.parse(localStorage.getItem('forex_news_cache')||'null');
    if (!cache?.items) return [];
    const kws = pair.label.replace('/','').toLowerCase().split('');
    const base1 = pair.label.split('/')[0].toLowerCase();
    const base2 = pair.label.split('/')[1]?.toLowerCase();
    return cache.items.filter(item => {
      const t = item.title.toLowerCase();
      return t.includes(base1) || (base2 && t.includes(base2));
    }).slice(0,4);
  } catch { return []; }
}


export {
  ALL_PAIRS,
  GROUP_COLORS,
  PAIR_SESSIONS,
  TV_SYMBOLS,
  dowFactor,
  fetchLivePrice,
  fetchPrice,
  getAlphaStats,
  getCreds,
  getNewsForPair,
  isInSession,
  scorePairToday,
};

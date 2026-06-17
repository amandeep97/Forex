// src/utils/marketScan.js
// Live, deterministic multi-market setup scanner — REAL OANDA data only.
// Combines: H4 bias, H1 structure, liquidity sweeps, premium/discount,
// COT positioning, retail sentiment (contrarian) and ICT killzone timing.
//
// Everything here runs on real broker candles + live CFTC COT + OANDA
// position book. No mock/generated data is used, so the scores are
// trustworthy enough to act on.

import {
  detectSweep, detectLiqLevels, detectFVGsAndOBs,
  computeSwings, computeEMASeries,
} from './smcHelpers.js';

// ── Instruments to scan (OANDA id, label, COT code, pip size) ─────────────────
const SCAN_SET = [
  { id: 'XAU_USD', label: 'XAU/USD', cot: '088691', pip: 0.1,    cotInv: false },
  { id: 'XAG_USD', label: 'XAG/USD', cot: '084691', pip: 0.01,   cotInv: false },
  { id: 'EUR_USD', label: 'EUR/USD', cot: '099741', pip: 0.0001, cotInv: false },
  { id: 'GBP_USD', label: 'GBP/USD', cot: '096742', pip: 0.0001, cotInv: false },
  { id: 'USD_JPY', label: 'USD/JPY', cot: '097741', pip: 0.01,   cotInv: true  },
  { id: 'AUD_USD', label: 'AUD/USD', cot: '232741', pip: 0.0001, cotInv: false },
  { id: 'USD_CAD', label: 'USD/CAD', cot: '090741', pip: 0.0001, cotInv: true  },
  { id: 'USD_CHF', label: 'USD/CHF', cot: '092741', pip: 0.0001, cotInv: true  },
  { id: 'NZD_USD', label: 'NZD/USD', cot: '112741', pip: 0.0001, cotInv: false },
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

async function fetchCandles(instr, gran, count, creds) {
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
    return (data.candles || []).filter(c => c.complete).map(c => ({
      o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, v: c.volume || 1,
    }));
  } catch { return null; }
}

async function fetchCOT(code) {
  try {
    const url = `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows?.length) return null;
    const r = rows[0];
    const long = +r.noncomm_positions_long_all || 0;
    const short = +r.noncomm_positions_short_all || 0;
    return { net: long - short, long, short };
  } catch { return null; }
}

// Retail sentiment — position book is public market data, try live first.
async function fetchSentiment(instr, creds) {
  for (const base of ['https://api-fxtrade.oanda.com/v3', 'https://api-fxpractice.oanda.com/v3']) {
    try {
      const res = await fetch(`${base}/instruments/${instr}/positionBook`,
        { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const data = await res.json();
      const buckets = (data.positionBook?.buckets || []).filter(
        b => parseFloat(b.longCountPercent || 0) > 0 || parseFloat(b.shortCountPercent || 0) > 0);
      if (!buckets.length) continue;
      let lng = 0, sht = 0;
      buckets.forEach(b => {
        const l = parseFloat(b.longCountPercent || 0), s = parseFloat(b.shortCountPercent || 0);
        if (l >= s) lng += l; else sht += s;
      });
      const total = lng + sht;
      if (!total) continue;
      return { longPct: Math.round(lng / total * 100) };
    } catch { continue; }
  }
  return null;
}

// ── ICT Killzones (UTC) ───────────────────────────────────────────────────────
const KILLZONES = [
  { name: 'Asian KZ',     s: 0,  e: 4  },
  { name: 'London KZ',    s: 7,  e: 10 },
  { name: 'London Close', s: 11, e: 12 },
  { name: 'NY AM KZ',     s: 13, e: 16 },
  { name: 'NY PM KZ',     s: 18, e: 20 },
];
function currentKillzone() {
  const h = new Date().getUTCHours();
  return KILLZONES.find(k => h >= k.s && h < k.e) || null;
}

// ── Price formatting ──────────────────────────────────────────────────────────
function fmtPrice(v, pip) {
  if (v == null) return '—';
  const dec = pip >= 0.1 ? 2 : pip >= 0.01 ? 3 : pip >= 0.001 ? 4 : 5;
  return v.toFixed(dec);
}

// ── Score one instrument ──────────────────────────────────────────────────────
function scoreInstrument(meta, h4, h1, cot, sentiment, kz) {
  if (!h4 || h4.length < 30 || !h1 || h1.length < 30) return null;

  const reasons = [];
  let bull = 0, bear = 0;
  const W = {
    h4trend: 2.0, h4struct: 2.0, h4zone: 1.0,
    h1trend: 1.5, h1struct: 1.5, sweep: 2.0,
    momentum: 1.0, fvgob: 1.0, cot: 1.5, sentiment: 1.5,
  };

  // ── H4 EMA trend ──
  const h4e20 = computeEMASeries(h4, 20), h4e50 = computeEMASeries(h4, 50);
  const e20 = h4e20[h4e20.length - 1], e50 = h4e50[h4e50.length - 1];
  if (e20 != null && e50 != null) {
    if (e20 > e50) { bull += W.h4trend; reasons.push('H4 EMA20>50 (uptrend)'); }
    else           { bear += W.h4trend; reasons.push('H4 EMA20<50 (downtrend)'); }
  }

  // ── H4 structure (HH/HL vs LH/LL via mid zigzag) ──
  const sw4 = computeSwings(h4);
  if (sw4?.mid) {
    const { hs, ls } = sw4.mid;
    if (hs.length >= 2 && ls.length >= 2) {
      const hh = hs[hs.length - 1].price > hs[hs.length - 2].price;
      const hl = ls[ls.length - 1].price > ls[ls.length - 2].price;
      if (hh && hl)        { bull += W.h4struct; reasons.push('H4 making HH+HL'); }
      else if (!hh && !hl) { bear += W.h4struct; reasons.push('H4 making LH+LL'); }
    }
  }

  // ── H4 premium/discount ──
  const h4highs = Math.max(...h4.map(c => c.h));
  const h4lows  = Math.min(...h4.map(c => c.l));
  const range4  = h4highs - h4lows || 1;
  const cp      = h1[h1.length - 1].c;
  const posPct  = (cp - h4lows) / range4 * 100;
  if (posPct < 40)      { bull += W.h4zone; reasons.push(`Discount zone (${posPct.toFixed(0)}%)`); }
  else if (posPct > 60) { bear += W.h4zone; reasons.push(`Premium zone (${posPct.toFixed(0)}%)`); }

  // ── H1 EMA trend ──
  const h1e20 = computeEMASeries(h1, 20), h1e50 = computeEMASeries(h1, 50);
  const he20 = h1e20[h1e20.length - 1], he50 = h1e50[h1e50.length - 1];
  if (he20 != null && he50 != null) {
    if (he20 > he50) bull += W.h1trend; else bear += W.h1trend;
  }

  // ── H1 structure ──
  const sw1 = computeSwings(h1);
  if (sw1?.short) {
    const { hs, ls } = sw1.short;
    if (hs.length >= 2 && ls.length >= 2) {
      const hh = hs[hs.length - 1].price > hs[hs.length - 2].price;
      const hl = ls[ls.length - 1].price > ls[ls.length - 2].price;
      if (hh && hl)        { bull += W.h1struct; reasons.push('H1 bullish structure'); }
      else if (!hh && !hl) { bear += W.h1struct; reasons.push('H1 bearish structure'); }
    }
  }

  // ── H1 liquidity sweep ──
  const sweep = detectSweep(h1);
  if (sweep?.type === 'bullish') { bull += W.sweep; reasons.push('H1 swept sell-side liq (bullish)'); }
  if (sweep?.type === 'bearish') { bear += W.sweep; reasons.push('H1 swept buy-side liq (bearish)'); }

  // ── H1 momentum (last 6 closes) ──
  if (h1.length >= 7) {
    const mom = (cp - h1[h1.length - 7].c) / h1[h1.length - 7].c * 100;
    if (mom > 0.05)      bull += W.momentum;
    else if (mom < -0.05) bear += W.momentum;
  }

  // ── FVG / OB near price ──
  const { fvgZones = [], obZones = [] } = detectFVGsAndOBs(h1);
  const nearBullZone = [...fvgZones, ...obZones].some(z => z.type === 'bullish' && cp >= z.botPrice * 0.999 && cp <= z.topPrice * 1.001);
  const nearBearZone = [...fvgZones, ...obZones].some(z => z.type === 'bearish' && cp >= z.botPrice * 0.999 && cp <= z.topPrice * 1.001);
  if (nearBullZone) { bull += W.fvgob; reasons.push('Price at bullish OB/FVG'); }
  if (nearBearZone) { bear += W.fvgob; reasons.push('Price at bearish OB/FVG'); }

  // ── COT ──
  if (cot) {
    const net = meta.cotInv ? -cot.net : cot.net;
    if (net > 0)      { bull += W.cot; reasons.push(`COT net long ${Math.abs(net).toLocaleString()}`); }
    else if (net < 0) { bear += W.cot; reasons.push(`COT net short ${Math.abs(net).toLocaleString()}`); }
  }

  // ── Retail sentiment (contrarian) ──
  if (sentiment?.longPct != null) {
    if (sentiment.longPct >= 65)      { bull += W.sentiment; reasons.push(`${sentiment.longPct}% retail long → fade (bullish)`); }
    else if (sentiment.longPct <= 35) { bear += W.sentiment; reasons.push(`${100 - sentiment.longPct}% retail short → fade (bearish)`); }
  }

  // ── Resolve direction ──
  const total = bull + bear;
  if (total === 0) return null;
  const dir = bull >= bear ? 'LONG' : 'SHORT';
  const dominant = Math.max(bull, bear);
  const maxPts = Object.values(W).reduce((a, b) => a + b, 0);
  let score = Math.round(dominant / maxPts * 100);

  // Agreement penalty — if both sides are close, it's choppy → lower confidence
  const agreement = dominant / total;
  score = Math.round(score * (0.55 + 0.45 * agreement));

  // Killzone timing bonus
  if (kz) score = Math.min(99, score + 6);

  // ── Trade levels (ATR + liquidity anchored) ──
  const atr = sw1?.atr || (h1[h1.length - 1].h - h1[h1.length - 1].l) || meta.pip * 10;
  const { bsl = [], ssl = [] } = detectLiqLevels(h1);
  const entry = cp;
  let sl, tp1, tp2;
  if (dir === 'LONG') {
    const sslBelow = ssl.filter(l => l.price < entry).sort((a, b) => b.price - a.price)[0];
    const anchor = sslBelow ? sslBelow.price - 0.2 * atr : entry - 2 * atr;
    sl = Math.min(anchor, entry - 1.5 * atr);
    const bslAbove = bsl.filter(l => l.price > entry).sort((a, b) => a.price - b.price)[0];
    const risk = entry - sl;
    tp1 = bslAbove ? bslAbove.price : entry + risk * 2;
    tp2 = entry + risk * 3;
  } else {
    const bslAbove = bsl.filter(l => l.price > entry).sort((a, b) => a.price - b.price)[0];
    const anchor = bslAbove ? bslAbove.price + 0.2 * atr : entry + 2 * atr;
    sl = Math.max(anchor, entry + 1.5 * atr);
    const sslBelow = ssl.filter(l => l.price < entry).sort((a, b) => b.price - a.price)[0];
    const risk = sl - entry;
    tp1 = sslBelow ? sslBelow.price : entry - risk * 2;
    tp2 = entry - risk * 3;
  }
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp1 - entry);
  const rr = risk > 0 ? +(reward / risk).toFixed(1) : null;

  return {
    label: meta.label, id: meta.id, pip: meta.pip,
    dir, score, bull: +bull.toFixed(1), bear: +bear.toFixed(1),
    reasons: reasons.slice(0, 6),
    entry, sl, tp1, tp2, rr, atr,
    sentiment: sentiment?.longPct ?? null,
    inKZ: !!kz,
  };
}

// ── Public: run the full scan ─────────────────────────────────────────────────
export async function runMarketScan() {
  const creds = getOandaCreds();
  if (!creds) return { ok: false, reason: 'OANDA not connected', setups: [] };

  const kz = currentKillzone();

  const results = await Promise.all(SCAN_SET.map(async (meta) => {
    const [h4, h1, cot, sent] = await Promise.all([
      fetchCandles(meta.id, 'H4', 60, creds),
      fetchCandles(meta.id, 'H1', 90, creds),
      fetchCOT(meta.cot),
      fetchSentiment(meta.id, creds),
    ]);
    return scoreInstrument(meta, h4, h1, cot, sent, kz);
  }));

  const setups = results.filter(Boolean).sort((a, b) => b.score - a.score);

  return {
    ok: true,
    setups,
    killzone: kz?.name || null,
    asOf: new Date(),
  };
}

// ── Build a compact text digest for the AI context ────────────────────────────
export function scanDigest(scan) {
  if (!scan?.ok || !scan.setups.length) return '';
  const L = [];
  L.push('=== APP SETUP SCANNER (live OANDA — H4 bias + H1 structure + COT + sentiment + killzone) ===');
  L.push(`Killzone now: ${scan.killzone || 'none (outside ICT killzones)'}`);
  L.push('Top ranked setups (deterministic confluence score 0-100):');
  scan.setups.slice(0, 6).forEach((s, i) => {
    L.push(
      `${i + 1}. ${s.label} ${s.dir} — score ${s.score}/100${s.inKZ ? ' [in KZ]' : ''} | ` +
      `Entry ${fmtPrice(s.entry, s.pip)} SL ${fmtPrice(s.sl, s.pip)} TP ${fmtPrice(s.tp1, s.pip)} (${s.rr ?? '?'}R)` +
      (s.sentiment != null ? ` | retail ${s.sentiment}% long` : '') +
      ` | ${s.reasons.join('; ')}`
    );
  });
  return L.join('\n');
}

export { fmtPrice as fmtScanPrice };

// src/utils/scanner.js
// Daily scanner — ranks every instrument by how UNUSUAL it is right now.
//
// The point is not to find trades. It is to answer "where should I look today"
// without opening five tabs per instrument. Every measure is a comparison of an
// instrument against its OWN recent history, so a 40-point range in gold and a
// 4-pip range in EUR/GBP are judged on the same scale.
//
// Nothing here predicts direction. A flagged instrument is one behaving
// differently from normal — which way it goes is not this file's business.
import { INSTRUMENTS } from '../data/instruments';
import { oandaCreds, fetchSpreadStress, fetchPositioning, POSITION_MARKETS } from './flowFeed';
import { get, pooled } from './marketCache';

const pct = (v, arr) => {
  if (!arr.length) return null;
  const below = arr.filter(x => x < v).length;
  return Math.round((below / arr.length) * 100);
};

// ── Candles (cached) ──────────────────────────────────────────────────────────
async function candles(inst, granularity = 'H4', count = 180) {
  return get('candles', inst.sym, async () => {
    if (inst.binance) {
      const map = { H1:'1h', H4:'4h', D:'1d' };
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${inst.binance}&interval=${map[granularity]||'4h'}&limit=${count}`,
        { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`Binance ${r.status}`);
      return (await r.json()).map(k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4] }));
    }
    const c = oandaCreds();
    if (!c?.apiKey) throw new Error('OANDA not connected');
    const base = c.practice === false ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3';
    const r = await fetch(`${base}/instruments/${inst.oanda}/candles?granularity=${granularity}&count=${count}&price=M`,
      { headers:{ Authorization:`Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`OANDA ${r.status}`);
    const d = await r.json();
    return (d.candles||[]).filter(x=>x.complete)
      .map(x => ({ t:new Date(x.time).getTime(), o:+x.mid.o, h:+x.mid.h, l:+x.mid.l, c:+x.mid.c }));
  }, { params: granularity });
}

// ── Measures ──────────────────────────────────────────────────────────────────
function trueRanges(cs) {
  const tr = [];
  for (let i = 1; i < cs.length; i++) {
    const pc = cs[i-1].c;
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - pc), Math.abs(cs[i].l - pc)));
  }
  return tr;
}

function measure(inst, cs) {
  if (!cs || cs.length < 40) return null;
  const closes = cs.map(c => c.c);
  const last = closes[closes.length - 1];

  // Volatility: current ATR against its own distribution
  const tr = trueRanges(cs);
  const atrOf = (arr, i, n = 14) => {
    const s = arr.slice(Math.max(0, i - n + 1), i + 1);
    return s.reduce((a, b) => a + b, 0) / (s.length || 1);
  };
  const atrSeries = tr.map((_, i) => atrOf(tr, i)).slice(14);
  const atrNow = atrSeries[atrSeries.length - 1];
  const volPct = pct(atrNow, atrSeries);

  // Where price sits inside its recent range
  const win = cs.slice(-60);
  const hi = Math.max(...win.map(c => c.h)), lo = Math.min(...win.map(c => c.l));
  const rangePos = hi > lo ? Math.round(((last - lo) / (hi - lo)) * 100) : 50;

  // Momentum over the window, normalised so instruments compare
  const chg20 = closes.length > 20 ? ((last - closes[closes.length - 21]) / closes[closes.length - 21]) * 100 : 0;

  // Directional persistence — how one-sided the last 20 bars have been
  const ups = cs.slice(-20).filter(c => c.c > c.o).length;
  const persistence = Math.round((Math.abs(ups - 10) / 10) * 100);

  return {
    last, volPct, rangePos, chg20: +chg20.toFixed(2), persistence,
    atrPct: +((atrNow / last) * 100).toFixed(3),
    bars: cs.length,
  };
}

// ── Signal extraction ─────────────────────────────────────────────────────────
// Each signal is a plain statement of fact with a weight. The score is simply
// how many unusual things are true at once — deliberately not a "probability".
function signalsFor(m, spread, posn) {
  const out = [];
  if (m) {
    if (m.volPct >= 90) out.push({ w:3, tag:'VOL', txt:`volatility ${m.volPct}th pct — expanding` });
    else if (m.volPct <= 10) out.push({ w:2, tag:'VOL', txt:`volatility ${m.volPct}th pct — coiled` });

    if (m.rangePos >= 95) out.push({ w:2, tag:'RANGE', txt:'at top of 60-bar range' });
    else if (m.rangePos <= 5) out.push({ w:2, tag:'RANGE', txt:'at bottom of 60-bar range' });

    if (Math.abs(m.chg20) >= 5) out.push({ w:2, tag:'MOVE', txt:`${m.chg20 > 0 ? '+' : ''}${m.chg20}% over 20 bars` });
    if (m.persistence >= 60) out.push({ w:1, tag:'TREND', txt:'one-sided recent bars' });
  }
  if (spread && !spread.error) {
    if (spread.state === 'blown') out.push({ w:3, tag:'COST', txt:`spread ×${spread.ratio} — blown out` });
    else if (spread.state === 'wide') out.push({ w:2, tag:'COST', txt:`spread ×${spread.ratio} — wide` });
  }
  if (posn && posn.enough) {
    if (posn.pct >= 90) out.push({ w:3, tag:'POSN', txt:`funds at ${posn.pct}th pct — 3y high` });
    else if (posn.pct <= 10) out.push({ w:3, tag:'POSN', txt:`funds at ${posn.pct}th pct — 3y low` });
    if (posn.smartDumb?.opposed && posn.smartDumb?.bothStretched)
      out.push({ w:2, tag:'SMART', txt:'hedgers and small traders both stretched' });
  }
  return out;
}

// ── Runner ────────────────────────────────────────────────────────────────────
export async function runScan({ granularity = 'H4', onProgress, limit = 6, force = false } = {}) {
  const list = INSTRUMENTS.filter(i => i.can.candles);

  // COT is weekly and cached for hours, so fetch it once per market up front
  const cotByKey = {};
  await pooled(POSITION_MARKETS, async m => {
    try {
      const r = await get('cot', m.key, () => fetchPositioning(m), { force });
      cotByKey[m.key] = r.value;
    } catch { /* market simply has no positioning row */ }
  }, { limit: 4 });

  const rows = await pooled(list, async (inst) => {
    let m = null, spread = null, err = null;
    try {
      const c = await candles(inst, granularity);
      m = measure(inst, c.value);
    } catch (e) { err = e.message; }

    if (inst.can.spread) {
      try {
        const s = await get('spread', inst.sym, () => fetchSpreadStress({ sym:inst.sym, oanda:inst.oanda }), { force });
        spread = s.value;
      } catch { /* spread is optional */ }
    }

    const posn = cotByKey[inst.sym] || null;
    const sig = signalsFor(m, spread, posn);
    return {
      sym: inst.sym, name: inst.name, cls: inst.cls,
      m, spread, posn, signals: sig,
      score: sig.reduce((a, s) => a + s.w, 0),
      error: err,
    };
  }, { limit, onProgress });

  return rows
    .filter(r => r && !r.item)                 // drop pool error placeholders
    .sort((a, b) => b.score - a.score || (b.m?.volPct ?? 0) - (a.m?.volPct ?? 0));
}

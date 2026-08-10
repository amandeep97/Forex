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
import { binanceCandles, isBinance } from './binanceKlines';

const pct = (v, arr) => {
  if (!arr.length) return null;
  const below = arr.filter(x => x < v).length;
  return Math.round((below / arr.length) * 100);
};

// ── Candles (cached) ──────────────────────────────────────────────────────────
async function candles(inst, granularity = 'H4', count = 180) {
  return get('candles', inst.sym, async () => {
    // Venue comes from the instrument, not the host name: the TradFi
    // perpetuals live on the futures API and return nothing from spot.
    if (isBinance(inst)) return binanceCandles(inst, granularity, count);
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
// Each signal is a plain statement of fact, tagged with the FAMILY of evidence
// it comes from. The family matters because a naive sum double-counts: a large
// 20-bar move and high volatility are the same event described twice, so an
// instrument that had merely moved a lot outranked one where three genuinely
// independent sources agreed.
//
//   swing      — magnitude of movement, from the candle series
//   location   — where price sits in its range, from the same series but a
//                different question
//   persistence— one-sidedness of recent bars
//   cost       — the bid/ask spread, a separate feed entirely
//   positioning— CFTC weekly, unrelated to price action
const FAMILY_LABEL = {
  swing:'movement', location:'range position', persistence:'trend',
  cost:'trading cost', positioning:'positioning',
};

function signalsFor(m, spread, posn) {
  const out = [];
  if (m) {
    if (m.volPct >= 90) out.push({ w:3, f:'swing', tag:'VOL', txt:`volatility ${m.volPct}th pct — expanding` });
    else if (m.volPct <= 10) out.push({ w:2, f:'swing', tag:'VOL', txt:`volatility ${m.volPct}th pct — coiled` });

    if (m.rangePos >= 95) out.push({ w:2, f:'location', tag:'RANGE', txt:'at top of 60-bar range' });
    else if (m.rangePos <= 5) out.push({ w:2, f:'location', tag:'RANGE', txt:'at bottom of 60-bar range' });

    if (Math.abs(m.chg20) >= 5) out.push({ w:2, f:'swing', tag:'MOVE', txt:`${m.chg20 > 0 ? '+' : ''}${m.chg20}% over 20 bars` });
    if (m.persistence >= 60) out.push({ w:1, f:'persistence', tag:'TREND', txt:'one-sided recent bars' });
  }
  if (spread && !spread.error) {
    if (spread.state === 'blown') out.push({ w:3, f:'cost', tag:'COST', txt:`spread ×${spread.ratio} — blown out` });
    else if (spread.state === 'wide') out.push({ w:2, f:'cost', tag:'COST', txt:`spread ×${spread.ratio} — wide` });
  }
  if (posn && posn.enough) {
    if (posn.pct >= 90) out.push({ w:3, f:'positioning', tag:'POSN', txt:`funds at ${posn.pct}th pct — 3y high` });
    else if (posn.pct <= 10) out.push({ w:3, f:'positioning', tag:'POSN', txt:`funds at ${posn.pct}th pct — 3y low` });
    if (posn.smartDumb?.opposed && posn.smartDumb?.bothStretched)
      out.push({ w:2, f:'positioning', tag:'SMART', txt:'hedgers and small traders both stretched' });
  }
  return out;
}

// Score = strongest signal per family, plus a small credit for corroboration
// within a family, multiplied up as more independent families agree. Two facts
// from one source are worth far less than two facts from two sources.
export function scoreSignals(signals) {
  if (!signals.length) return { score: 0, families: 0, familyNames: [] };
  const byFamily = {};
  for (const s of signals) (byFamily[s.f] ||= []).push(s);

  let base = 0;
  for (const list of Object.values(byFamily)) {
    const strongest = Math.max(...list.map(s => s.w));
    base += strongest + 0.5 * (list.length - 1);   // corroboration, not a second vote
  }
  const families = Object.keys(byFamily).length;
  const independence = 1 + 0.35 * (families - 1);
  return {
    score: +(base * independence).toFixed(1),
    families,
    familyNames: Object.keys(byFamily).map(f => FAMILY_LABEL[f] || f),
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────
export async function runScan({ granularity = 'H4', onProgress, limit = 6, force = false } = {}) {
  const list = INSTRUMENTS.filter(i => i.can.candles);

  // COT is weekly, cached for hours, and slow to fetch across 15 contracts.
  // It must NOT gate the price scan: doing so left progress at 0 and the table
  // empty until every CFTC request had returned. Start it in the background and
  // fold the positioning signals in once the price rows exist.
  const cotByKey = {};
  const cotDone = pooled(POSITION_MARKETS, async m => {
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

    // positioning may still be in flight; it is merged in below
    const sig = signalsFor(m, spread, null);
    const sc = scoreSignals(sig);
    return {
      sym: inst.sym, name: inst.name, cls: inst.cls,
      m, spread, posn: null, signals: sig,
      score: sc.score, families: sc.families, familyNames: sc.familyNames,
      error: err,
    };
  }, { limit, onProgress });

  const priced = rows.filter(r => r && r.sym);   // drop pool error placeholders

  // Fold in positioning once the CFTC requests have landed
  await cotDone;
  for (const r of priced) {
    const posn = cotByKey[r.sym];
    if (!posn) continue;
    r.posn = posn;
    r.signals = signalsFor(r.m, r.spread, posn);
    const sc = scoreSignals(r.signals);
    r.score = sc.score; r.families = sc.families; r.familyNames = sc.familyNames;
  }

  return priced.sort((a, b) => b.score - a.score || (b.m?.volPct ?? 0) - (a.m?.volPct ?? 0));
}

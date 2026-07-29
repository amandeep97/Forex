// src/utils/mtfTrades.js
// Multi-timeframe trade finder.
//
// Built after establishing two things about the previous engine: it leaned on
// bias (8 of 15 points from five correlated trend measures that cannot disagree
// with each other), and it covered 9 instruments out of 52.
//
// This inverts that. Bias is a FILTER — higher timeframes decide which side is
// permitted — and the reason to enter is an EVENT on the entry timeframe. No
// trigger, no trade, however aligned the trend looks. That is the Strong Sweep
// idea: something has to actually happen at a level.
//
// The trigger is the shared detectStrongReversal used by the chart, the alerts
// and the VPS bot, so a trade here means the same thing it means everywhere else.
import { INSTRUMENTS } from '../data/instruments';
import { lastStrongReversal } from './candlePatterns';
import { computeEMASeries } from './backtestEngine';
import { oandaCreds, fetchSpreadStress } from './flowFeed';
import { bySymbol, exposureOf } from '../data/instruments';
import { get, pooled } from './marketCache';

export const MTF = ['D', 'H4', 'H1'];      // context → bias → structure
export const ENTRY_TF = 'M15';             // where the trigger must appear

const BIN_TF = { D:'1d', H4:'4h', H1:'1h', M15:'15m' };

async function candles(inst, tf, count = 120) {
  const r = await get('candles', inst.sym, async () => {
    if (inst.binance) {
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${inst.binance}&interval=${BIN_TF[tf]}&limit=${count}`,
        { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Binance ${res.status}`);
      return (await res.json()).map(k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4] }));
    }
    const c = oandaCreds();
    if (!c?.apiKey) throw new Error('OANDA not connected');
    const base = c.practice === false ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3';
    const res = await fetch(`${base}/instruments/${inst.oanda}/candles?granularity=${tf}&count=${count}&price=M`,
      { headers:{ Authorization:`Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`OANDA ${res.status}`);
    const d = await res.json();
    return (d.candles||[]).filter(x=>x.complete)
      .map(x => ({ t:new Date(x.time).getTime(), o:+x.mid.o, h:+x.mid.h, l:+x.mid.l, c:+x.mid.c }));
  }, { params: tf });
  return r.value;
}

// One timeframe's verdict. Trend and structure are combined here rather than
// scored separately, because on the same series they nearly always agree — two
// names for one fact.
function biasOf(cs) {
  if (!cs || cs.length < 55) return { dir: null, why: 'insufficient history' };
  const e20 = computeEMASeries(cs, 20), e50 = computeEMASeries(cs, 50);
  const a = e20[e20.length-1], b = e50[e50.length-1];
  if (a == null || b == null) return { dir: null, why: 'no EMA' };

  // swing structure over the recent window
  const w = cs.slice(-40);
  const highs = [], lows = [];
  for (let i = 2; i < w.length - 2; i++) {
    if (w[i].h > w[i-1].h && w[i].h > w[i+1].h) highs.push(w[i].h);
    if (w[i].l < w[i-1].l && w[i].l < w[i+1].l) lows.push(w[i].l);
  }
  const hh = highs.length >= 2 && highs[highs.length-1] > highs[highs.length-2];
  const hl = lows.length  >= 2 && lows[lows.length-1]  > lows[lows.length-2];
  const structure = hh && hl ? 'up' : (!hh && !hl && highs.length >= 2 && lows.length >= 2) ? 'down' : null;

  const emaDir = a > b ? 'up' : 'down';
  // Structure and EMA disagreeing is genuine information — the timeframe is
  // transitioning, and is reported as neutral rather than forced to a side.
  const dir = structure && structure !== emaDir ? null : emaDir;
  return { dir, ema: emaDir, structure, why: dir ? `EMA ${emaDir}${structure ? ` + structure ${structure}` : ''}` : 'EMA and structure disagree' };
}

// Where price sits in the higher-timeframe range — a trigger against the trend
// is only interesting from the far end of the range.
function locationOf(cs) {
  const w = cs.slice(-60);
  const hi = Math.max(...w.map(c => c.h)), lo = Math.min(...w.map(c => c.l));
  const last = w[w.length-1].c;
  const pct = hi > lo ? Math.round(((last - lo) / (hi - lo)) * 100) : 50;
  return { pct, zone: pct < 35 ? 'discount' : pct > 65 ? 'premium' : 'mid' };
}

export async function findTrade(inst, cfg) {
  const [d, h4, h1, m15] = await Promise.all(
    [...MTF, ENTRY_TF].map(tf => candles(inst, tf).catch(() => null))
  );
  if (!m15 || m15.length < 20) return null;

  const ladder = { D: biasOf(d), H4: biasOf(h4), H1: biasOf(h1) };
  const dirs = Object.values(ladder).map(x => x.dir).filter(Boolean);
  const ups = dirs.filter(x => x === 'up').length;
  const downs = dirs.filter(x => x === 'down').length;
  const htfDir = ups > downs ? 'up' : downs > ups ? 'down' : null;
  const aligned = Math.max(ups, downs);

  // The reason to act: an event on the entry timeframe, not a state.
  const trig = lastStrongReversal(m15, cfg.sweepN);
  if (!trig) return { inst, ladder, aligned, htfDir, trigger:null, skip:'no trigger on ' + ENTRY_TF };

  const trigDir = trig === 'hammer' ? 'up' : 'down';
  const loc = locationOf(h4 || m15);

  // Risk from the trigger candle itself — a structural stop, not a fixed pip
  // distance, so the size of the stop reflects where the market actually turned.
  const bar = m15[m15.length-1];
  const entry = bar.c;
  const pad = (bar.h - bar.l) * 0.15;
  const sl = trigDir === 'up' ? bar.l - pad : bar.h + pad;
  const risk = Math.abs(entry - sl);
  const tp = trigDir === 'up' ? entry + risk * cfg.targetR : entry - risk * cfg.targetR;
  const rr = risk > 0 ? +cfg.targetR.toFixed(1) : null;

  return {
    inst, sym: inst.sym, ladder, aligned, htfDir,
    trigger: trig, dir: trigDir === 'up' ? 'BUY' : 'SELL',
    entry, sl, tp, risk, rr, location: loc,
    withTrend: htfDir != null && htfDir === trigDir,
    counterTrend: htfDir != null && htfDir !== trigDir,
  };
}

export const MTF_DEFAULTS = {
  sweepN: 5,
  targetR: 2,
  minAligned: 2,        // of the three higher timeframes
  maxSpreadRatio: 1.8,
  eventBlackoutMin: 60,
  allowCounterTrend: true,   // permitted only from the opposite extreme
};

function eventsNear(sym, withinMin) {
  try {
    const inst = bySymbol(sym); if (!inst) return [];
    const ccys = exposureOf(inst), now = Date.now();
    return JSON.parse(localStorage.getItem('news_event_archive_v1') || '[]')
      .filter(e => e.impact === 'High' && ccys.includes(e.country))
      .map(e => ({ ...e, ms: new Date(e.date).getTime() }))
      .filter(e => e.ms > now && e.ms <= now + withinMin * 60000)
      .sort((a, b) => a.ms - b.ms);
  } catch { return []; }
}

export async function runMtfScan(overrides = {}) {
  const cfg = { ...MTF_DEFAULTS, ...overrides };
  const list = INSTRUMENTS.filter(i => i.can.candles);

  const found = await pooled(list, async inst => {
    try { return await findTrade(inst, cfg); } catch { return null; }
  }, { limit: 5 });

  const withTrigger = found.filter(t => t && t.trigger);
  const judged = await pooled(withTrigger, async t => {
    const blockers = [];
    if (t.aligned < cfg.minAligned)
      blockers.push(`only ${t.aligned}/3 higher timeframes agree`);
    // Against the higher timeframes is allowed only from the far end of the
    // range, where a reversal has somewhere to go.
    if (t.counterTrend) {
      if (!cfg.allowCounterTrend) blockers.push('against higher timeframes');
      else if (!((t.dir === 'BUY' && t.location.zone === 'discount') ||
                 (t.dir === 'SELL' && t.location.zone === 'premium')))
        blockers.push(`counter-trend from ${t.location.zone} — no room`);
    }
    if (t.inst.can.spread) {
      try {
        const s = await get('spread', t.sym, () => fetchSpreadStress({ sym:t.sym, oanda:t.inst.oanda }));
        if (s.value?.ratio > cfg.maxSpreadRatio) blockers.push(`spread ×${s.value.ratio}`);
      } catch { /* optional */ }
    }
    const ev = eventsNear(t.sym, cfg.eventBlackoutMin);
    if (ev.length) blockers.push(`${ev[0].country} ${ev[0].title} in ${Math.round((ev[0].ms-Date.now())/60000)}m`);
    return { ...t, blockers, passed: blockers.length === 0 };
  }, { limit: 5 });

  return {
    ok: true, cfg,
    scanned: list.length,
    triggered: withTrigger.length,
    passed: judged.filter(t => t.passed).sort((a, b) => b.aligned - a.aligned),
    rejected: judged.filter(t => !t.passed).sort((a, b) => b.aligned - a.aligned),
  };
}

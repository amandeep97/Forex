// src/utils/tradeGate.js
// The gate between "a setup exists" and "this is worth risking money on".
//
// The app already produced trades and already knew when they were bad — it just
// never connected the two. The Metals panel handed out a SELL at 3/9 confluence
// with a 0.6:1 target while the spread reading and the economic calendar sat one
// tab away, unconsulted.
//
// Nothing here predicts direction; runMarketScan already decided that. This only
// decides whether to ALLOW it, by re-using measurements the app already makes.
// Every rejection is a losing trade removed, which is the only honest route to a
// higher-probability list: fewer trades, not better forecasts.
import { runMarketScan } from './marketScan';
import { fetchSpreadStress } from './flowFeed';
import { bySymbol, exposureOf } from '../data/instruments';
import { get, pooled } from './marketCache';

export const GATE_DEFAULTS = {
  minConfluence: 65,   // marketScan scores 0-100; ~65 is "two independent sources agree"
  minRR: 1.5,          // below this a win rate has to be implausibly high to profit
  maxSpreadRatio: 1.8, // vs the instrument's own median
  eventBlackoutMin: 60,
};

// Upcoming high-impact events for the currencies an instrument is exposed to.
// Read from the archive the News tab accumulates.
function eventsNear(sym, withinMin) {
  try {
    const inst = bySymbol(sym);
    if (!inst) return [];
    const ccys = exposureOf(inst);
    const now = Date.now(), horizon = now + withinMin * 60000;
    return JSON.parse(localStorage.getItem('news_event_archive_v1') || '[]')
      .filter(e => e.impact === 'High' && ccys.includes(e.country))
      .map(e => ({ ...e, ms: new Date(e.date).getTime() }))
      .filter(e => e.ms > now && e.ms <= horizon)
      .sort((a, b) => a.ms - b.ms);
  } catch { return []; }
}

// A single candidate judged against every check the app can make.
async function judge(setup, cfg) {
  const blockers = [], notes = [];
  const sym = setup.label || setup.sym;

  // 1. Conviction — the app's own confluence score
  if (setup.score == null) blockers.push('No confluence score');
  else if (setup.score < cfg.minConfluence)
    blockers.push(`Confluence ${setup.score}/100 — below ${cfg.minConfluence}`);
  else notes.push(`confluence ${setup.score}/100`);

  // 2. Reward vs risk. A sub-1.5 target needs a win rate high enough that the
  //    backtest grader would call it noise, so it is refused outright.
  const rr = setup.rr != null ? +setup.rr : null;
  if (rr == null) blockers.push('No R:R computed');
  else if (rr < cfg.minRR) blockers.push(`R:R ${rr}:1 — below ${cfg.minRR}:1`);
  else notes.push(`R:R ${rr}:1`);

  // 3. Cost of trading right now
  const inst = bySymbol(sym);
  if (inst?.can.spread) {
    try {
      const s = await get('spread', sym, () => fetchSpreadStress({ sym, oanda: inst.oanda }));
      const sp = s.value;
      if (sp?.ratio > cfg.maxSpreadRatio)
        blockers.push(`Spread ×${sp.ratio} vs normal — entry cost inflated`);
      else if (sp) notes.push(`spread ×${sp.ratio}`);
    } catch { notes.push('spread unknown'); }
  }

  // 4. Scheduled risk
  const evs = eventsNear(sym, cfg.eventBlackoutMin);
  if (evs.length) {
    const mins = Math.round((evs[0].ms - Date.now()) / 60000);
    blockers.push(`${evs[0].country} ${evs[0].title} in ${mins}m`);
  }

  return { ...setup, sym, rr, blockers, notes, passed: blockers.length === 0 };
}

// Returns every candidate with a verdict — rejections included, with the reason.
// Showing what was refused is the point: a list that only ever shows passes is
// indistinguishable from one that is broken.
export async function runTradeGate(overrides = {}) {
  const cfg = { ...GATE_DEFAULTS, ...overrides };
  const scan = await runMarketScan();
  if (!scan?.ok) return { ok: false, msg: 'Market scan unavailable — check the OANDA connection.', cfg };

  const judged = await pooled(scan.setups || [], s => judge(s, cfg), { limit: 5 });
  const rows = judged.filter(r => r && r.sym);

  return {
    ok: true, cfg,
    killzone: scan.killzone,
    asOf: scan.asOf,
    passed: rows.filter(r => r.passed).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    rejected: rows.filter(r => !r.passed).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    total: rows.length,
  };
}

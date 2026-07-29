// src/utils/consensus.js
// Reads what the other tabs conclude and reports where they agree.
//
// It computes no opinion of its own. Every direction here comes from an engine
// that already exists — Signals' top-down read, Command Center's factor model,
// Pair Hub's realised win rates — plus the two things that can only veto:
// spread cost and scheduled events.
//
// The reason for grouping into FAMILIES rather than counting screens: three
// screens reading the same EMAs is one piece of evidence wearing three hats.
// Only genuinely different methods can corroborate each other, which is why
// "4 of 5 sources" here means four different ways of looking, not four tabs.
//
// Conflicts are reported, never averaged. Two engines pointing opposite ways is
// information; blending them to neutral destroys it and produces a number that
// looks confident and means nothing.
import { INSTRUMENTS, bySymbol, exposureOf } from '../data/instruments';
import { fetchOHLC, analyzeTimeframe, getSignal, alignScore } from './topDown';
import { techScore } from './commandScore';
import { scorePairToday } from './pairStats';
import { fetchSpreadStress, fetchPositioning, oandaCreds } from './flowFeed';
import { get, pooled } from './marketCache';

export const FAMILIES = {
  structure:  { label:'Structure',  from:'Signals — H4/H1/M15, OB/FVG' },
  factor:     { label:'Factors',    from:'Command Center — technical model' },
  historical: { label:'Historical', from:'Pair Hub — realised win rate' },
  positioning:{ label:'Positioning',from:'CFTC — fund extremes' },
};

export const DEFAULTS = {
  minAgree: 3,          // families pointing the same way
  maxSpreadRatio: 1.8,
  eventBlackoutMin: 60,
  posnExtreme: 15,      // percentile tails that count as a positioning vote
};

const oandaOf = sym => bySymbol(sym)?.oanda || null;

function eventsNear(sym, mins) {
  try {
    const inst = bySymbol(sym); if (!inst) return [];
    const ccys = exposureOf(inst), now = Date.now();
    return JSON.parse(localStorage.getItem('news_event_archive_v1') || '[]')
      .filter(e => e.impact === 'High' && ccys.includes(e.country))
      .map(e => ({ ...e, ms:new Date(e.date).getTime() }))
      .filter(e => e.ms > now && e.ms <= now + mins * 60000)
      .sort((a,b) => a.ms - b.ms);
  } catch { return []; }
}

// ── One instrument, every source ──────────────────────────────────────────────
async function readSources(inst, cfg) {
  const sym = inst.sym, instr = oandaOf(sym);
  const votes = {};      // family -> { dir, detail }
  const missing = [];

  // 1 & 2. Structure and factors both need candles, so fetch once and share.
  let h4 = null, h1 = null, m15 = null;
  if (instr && oandaCreds()?.apiKey) {
    try {
      [h4, h1, m15] = await Promise.all([
        get('candles', sym, () => fetchOHLC(instr, 'H4', 60),  { params:'H4-td'  }).then(r => r.value),
        get('candles', sym, () => fetchOHLC(instr, 'H1', 90),  { params:'H1-td'  }).then(r => r.value),
        get('candles', sym, () => fetchOHLC(instr, 'M15', 90), { params:'M15-td' }).then(r => r.value),
      ]);
    } catch { /* handled by the missing list below */ }
  }

  if (h4 && h1 && m15) {
    const a4 = analyzeTimeframe(h4), a1 = analyzeTimeframe(h1), a15 = analyzeTimeframe(m15);
    if (a4 && a1 && a15) {
      const sig = getSignal(a4, a1, a15, h1);
      const dir = sig?.dir ? (/BUY|LONG|bull/i.test(sig.dir) ? 'up' : 'down')
                : a4.structure === 'bullish' ? 'up' : a4.structure === 'bearish' ? 'down' : null;
      votes.structure = {
        dir,
        detail: `H4 ${a4.structure} · H1 ${a1.structure} · M15 ${a15.structure}`,
        align: alignScore(a4, a1, a15),
        signal: sig || null,
      };
    }
    // Command Center's technical factor, on the same candles
    try {
      const t = techScore(h4, h1);
      votes.factor = { dir: t > 0.2 ? 'up' : t < -0.2 ? 'down' : null, detail: `factor ${t > 0 ? '+' : ''}${t.toFixed(2)}` };
    } catch { missing.push('factor'); }
  } else missing.push('structure');

  // 3. Pair Hub — realised win rate by day and session. Reads Alpha Lab's saved
  //    results, so it only speaks for instruments that have been tested.
  try {
    const s = scorePairToday({ key: instr || sym, label: sym });
    if (s && s.score > 0 && s.direction) {
      votes.historical = {
        dir: /SHORT|SELL|bear/i.test(s.direction) ? 'down' : 'up',
        detail: `${s.score} pts · ${s.dirReason || 'win-rate edge'}`,
      };
    } else missing.push('historical');
  } catch { missing.push('historical'); }

  // 4. Positioning — only the tails vote. Mid-range positioning says nothing,
  //    and an extreme is a contrarian reading, not a trend confirmation.
  if (inst.can.positioning) {
    try {
      const r = await get('cot', sym, () => fetchPositioning({ key:sym, label:inst.name, code:inst.cot, group:inst.cls }));
      const p = r.value;
      if (p?.enough) {
        const dir = p.pct >= 100 - cfg.posnExtreme ? 'down'      // crowded long → contrarian short
                  : p.pct <= cfg.posnExtreme ? 'up' : null;      // crowded short → contrarian long
        votes.positioning = { dir, detail: `funds ${p.pct}th pct${dir ? ' — contrarian' : ''}` };
      } else missing.push('positioning');
    } catch { missing.push('positioning'); }
  } else missing.push('positioning');

  // ── Vetoes: these never vote on direction, they only forbid ──
  const vetoes = [];
  if (inst.can.spread) {
    try {
      const s = await get('spread', sym, () => fetchSpreadStress({ sym, oanda: instr }));
      if (s.value?.ratio > cfg.maxSpreadRatio) vetoes.push(`spread ×${s.value.ratio} vs normal`);
    } catch { /* optional */ }
  }
  const ev = eventsNear(sym, cfg.eventBlackoutMin);
  if (ev.length) vetoes.push(`${ev[0].country} ${ev[0].title} in ${Math.round((ev[0].ms - Date.now())/60000)}m`);

  return { votes, missing, vetoes };
}

// ── Verdict ───────────────────────────────────────────────────────────────────
function verdictOf(votes, vetoes, cfg) {
  const cast = Object.entries(votes).filter(([, v]) => v.dir);
  const up = cast.filter(([, v]) => v.dir === 'up');
  const dn = cast.filter(([, v]) => v.dir === 'down');

  if (!cast.length) return { state:'no-read', dir:null, agree:0, against:0 };
  if (up.length && dn.length) {
    return { state:'conflict', dir:null, agree:Math.max(up.length, dn.length), against:Math.min(up.length, dn.length),
             upFamilies: up.map(([k]) => k), downFamilies: dn.map(([k]) => k) };
  }
  const dir = up.length ? 'up' : 'down';
  const agree = Math.max(up.length, dn.length);
  if (vetoes.length) return { state:'blocked', dir, agree, against:0 };
  if (agree < cfg.minAgree) return { state:'weak', dir, agree, against:0 };
  return { state:'aligned', dir, agree, against:0 };
}

export async function runConsensus(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const list = INSTRUMENTS.filter(i => i.can.candles);

  const rows = await pooled(list, async inst => {
    try {
      const { votes, missing, vetoes } = await readSources(inst, cfg);
      const verdict = verdictOf(votes, vetoes, cfg);
      return { sym: inst.sym, cls: inst.cls, inst, votes, missing, vetoes, verdict,
               sources: Object.keys(votes).length, total: Object.keys(FAMILIES).length };
    } catch (e) { return { sym: inst.sym, cls: inst.cls, inst, error: e.message, votes:{}, missing:[], vetoes:[],
                           verdict:{ state:'no-read', agree:0 } }; }
  }, { limit: 4 });

  const ok = rows.filter(r => r && r.sym);
  const rank = { aligned:4, blocked:3, conflict:2, weak:1, 'no-read':0 };
  ok.sort((a, b) => (rank[b.verdict.state] - rank[a.verdict.state]) || (b.verdict.agree - a.verdict.agree));

  return {
    ok: true, cfg, asOf: new Date(),
    aligned:  ok.filter(r => r.verdict.state === 'aligned'),
    blocked:  ok.filter(r => r.verdict.state === 'blocked'),
    conflict: ok.filter(r => r.verdict.state === 'conflict'),
    rest:     ok.filter(r => ['weak','no-read'].includes(r.verdict.state)),
    scanned:  ok.length,
  };
}

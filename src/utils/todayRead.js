// src/utils/todayRead.js
//
// The one screen that answers the question the app is opened for: is there
// anything to do.
//
// Everything here is computed from measured data and arrives in about a second.
// No language model, nothing to wait for, nothing to press. The Desk is the
// deep dive for when the answer is interesting; this is the glance that tells
// you whether it is.
//
// The verdict is deliberately NOT the Desk's. The Desk's verdict is an opinion
// with reasoning attached and it costs ten model calls. This one is arithmetic:
// either a rule that survived the holdout is true on this bar, or it is one
// condition away, or it is not. Three states, no judgement, no waiting.

import { featureSeries, keysOf, PHRASE } from '../../shared/moveFeatures.mjs';
import { macroSeries, describe as describeMacro } from '../../shared/macroFit.mjs';
import {
  fetchRegimeStudy, firing, nearMisses,
  DOLLAR_INSTRUMENT, RATE_INSTRUMENT, invertDollar,
} from './regimeRead.js';

const RAW = 'https://raw.githubusercontent.com/amandeep97/Forex/main';

export const FOCUS = [
  { sym: 'XAU_USD', feedSym: 'XAU/USD', label: 'Gold', dec: 2, ccy: ['XAU', 'USD'], color: '#fbbf24' },
  { sym: 'XAG_USD', feedSym: 'XAG/USD', label: 'Silver', dec: 3, ccy: ['XAG', 'USD'], color: '#94a3b8' },
];

function creds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) {
      const e = localStorage.getItem('oanda_env');
      return e !== null ? { ...c, practice: e !== 'live' } : c;
    }
  } catch { /* a corrupt blob is the same as none */ }
  const apiKey = localStorage.getItem('oanda_key');
  return apiKey ? { apiKey, practice: localStorage.getItem('oanda_env') !== 'live' } : null;
}

async function candles(sym, count = 2000) {
  const c = creds();
  if (!c) return null;
  const base = c.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  try {
    const res = await fetch(
      `${base}/instruments/${sym}/candles?granularity=H1&count=${count}&price=M`,
      { headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const d = await res.json();
    return (d.candles || []).filter(x => x.complete).map(x => ({
      t: new Date(x.time).getTime(),
      o: +x.mid.o, h: +x.mid.h, l: +x.mid.l, c: +x.mid.c, v: x.volume || 1,
    }));
  } catch { return null; }
}

// A one-minute cache bucket, not five. The bot publishes every three minutes
// now; a five-minute bucket in front of it would spend more time than the
// faster poll saved, and this screen exists to be current.
async function json(path, bucketMs = 60e3) {
  try {
    const r = await fetch(`${RAW}/${path}?t=${Math.floor(Date.now() / bucketMs)}`,
      { signal: AbortSignal.timeout(20000) });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// FX closes Friday evening and reopens Sunday evening. On a Sunday the last
// complete hourly bar is genuinely two days old, and a bare date on screen reads
// as a broken feed rather than a closed market — which is exactly how it read.
export function barAge(t, now = Date.now()) {
  if (!t) return null;
  const hours = (now - t) / 3600e3;
  if (hours < 2) return { text: 'live', stale: false };
  const d = new Date(now).getUTCDay();
  const closed = d === 6 || (d === 0 && new Date(now).getUTCHours() < 21);
  if (closed) return { text: 'last bar before the weekend close', stale: false, closed: true };
  if (hours < 24) return { text: `${Math.round(hours)}h old`, stale: hours > 6 };
  return { text: `${Math.round(hours / 24)}d old`, stale: true };
}

// What is scheduled, soonest first, with how long until it lands. High impact
// only — a low-impact housing revision is not a reason to look at the clock.
export function nextEvents(news, ccy, { now = Date.now(), within = 36 * 3600e3, max = 3 } = {}) {
  const cal = news?.calendar || [];
  return cal
    .filter(e => e.at > now && e.at < now + within)
    .filter(e => /high/i.test(e.impact || ''))
    .filter(e => !ccy?.length || ccy.includes((e.country || '').toUpperCase())
      || (e.country || '').toUpperCase() === 'ALL')
    .sort((a, b) => a.at - b.at)
    .slice(0, max)
    .map(e => ({ ...e, inMs: e.at - now, inH: Math.round((e.at - now) / 3600e3) }));
}

// Headlines that matter for these instruments, heaviest first. Uses the tags the
// bot already published rather than re-deciding relevance here, so this screen
// and the news tab cannot disagree.
export function topHeadlines(news, insts, { max = 4, now = Date.now() } = {}) {
  const items = news?.headlines || [];
  const syms = new Set(insts.map(i => i.feedSym));
  const ccys = new Set(insts.flatMap(i => i.ccy));
  const out = [];
  for (const h of items) {
    const direct = (h.inst || []).some(x => syms.has(x));
    const viaCcy = (h.ccy || []).some(x => ccys.has(x));
    if (!direct && !viaCcy) continue;
    out.push({
      title: h.title, at: h.at, link: h.link, source: h.source,
      sev: h.sev ?? 1, direct,
      ageH: h.at ? Math.round((now - h.at) / 3600e3) : null,
    });
  }
  // Heaviest first, then what is actually about the instrument, then newest.
  return out
    .sort((a, b) => (b.sev - a.sev) || (b.direct - a.direct) || ((b.at || 0) - (a.at || 0)))
    .slice(0, max);
}

// What price has done since a given moment, from the bars already loaded.
//
// The bar AT or AFTER the timestamp, so a headline that landed mid-bar is
// measured from the close of the bar it landed in rather than from a price that
// had already moved on it. Null when the headline is newer than the last
// complete bar — over a weekend, or in the first minutes of an hour, there is
// nothing to measure yet and a zero would read as "it did nothing".
export function moveSincePct(cs, t) {
  if (!cs?.length || !t) return null;
  const i = cs.findIndex(c => c.t >= t);
  if (i < 0 || i >= cs.length - 1) return null;
  const from = cs[i].c, to = cs[cs.length - 1].c;
  if (!(from > 0)) return null;
  return { pct: ((to - from) / from) * 100, bars: cs.length - 1 - i, at: cs[i].t };
}

// The headline worth putting at the TOP, and what the market did after it.
//
// Two measured facts placed next to each other — this landed at 14:12, gold is
// down 1.9% since — and deliberately nothing more. It does not say the headline
// caused the move. Nothing here has ever measured that, and a screen that
// asserts cause from adjacency is inventing a signal, which is the habit the
// rest of this work exists to break. The sequence is the information; the
// reader draws the line.
export function breaking(news, insts, bars, { now = Date.now(), withinH = 12, max = 2 } = {}) {
  const items = news?.headlines || [];
  const syms = new Set(insts.map(i => i.feedSym));
  const ccys = new Set(insts.flatMap(i => i.ccy));
  const cutoff = now - withinH * 3600e3;

  return items
    .filter(h => (h.sev ?? 1) >= 2 && h.at && h.at >= cutoff)
    .filter(h => (h.inst || []).some(x => syms.has(x)) || (h.ccy || []).some(x => ccys.has(x)))
    .sort((a, b) => (b.sev - a.sev) || (b.at - a.at))
    .slice(0, max)
    .map(h => ({
      title: h.title, source: h.source, link: h.link, sev: h.sev ?? 1,
      // When it BROKE, not when this outlet rewrote it. The bot groups the same
      // story across outlets and keeps the earliest sighting; without that, a
      // story that landed at 14:12 and was rewritten at 15:40 is filed as 15:40
      // and the move since it is measured from the wrong hour.
      at: h.firstAt ?? h.at,
      srcs: h.srcs ?? 1,
      ageMin: Math.round((now - (h.firstAt ?? h.at)) / 60e3),
      direct: (h.inst || []).some(x => syms.has(x)),
      since: insts.map(i => ({
        label: i.label, dec: i.dec,
        move: moveSincePct(bars[i.sym], h.firstAt ?? h.at),
      })).filter(x => x.move),
    }));
}

// The verdict, from arithmetic rather than opinion.
//
// A rule that survived the holdout is true on this bar, or it is one condition
// short, or there is nothing. Nothing else — no scoring of the macro read, no
// weighing of headlines. Those are on the card for a person to read; turning
// them into a score would be inventing a signal out of things that have never
// been measured against an outcome, which is the habit this whole project has
// been trying to break.
export function verdictFor({ fires = [], near = [] }) {
  if (fires.length) {
    const r = fires[0];
    return {
      word: r.dir === 'up' ? 'SETUP — LONG' : 'SETUP — SHORT',
      tone: r.dir === 'up' ? 'bull' : 'bear',
      line: `${r.text}. On the half of history it was not fitted on: `
        + `${r.holdout?.expR > 0 ? '+' : ''}${r.holdout?.expR}R a trade against `
        + `${r.holdout?.baseExpR}R for a random entry, over ${r.holdout?.n} trades. `
        + `Hold ${r.hold}h.`,
      rule: r,
    };
  }
  if (near.length) {
    const r = near[0];
    return {
      word: 'WATCH', tone: 'neutral',
      line: `One condition from ${r.text}: needs ${r.missing.join(', ')}.`,
      rule: r,
    };
  }
  return {
    word: 'NOTHING', tone: 'neutral',
    line: 'No surviving setup is true or close on this bar. The read below is context, not a reason to trade.',
  };
}

/**
 * Everything the Today screen shows, in one pass.
 *
 * The dollar and the ten-year are fetched ONCE and shared, not once per metal —
 * gathering evidence per instrument fetched them twice and doubled the wait for
 * a screen whose whole point is that it is instant.
 */
export async function loadToday({ now = Date.now(), instruments = FOCUS } = {}) {
  const connected = !!creds();

  const [study, news, eur, rate] = await Promise.all([
    fetchRegimeStudy().catch(() => null),
    json('bot/news.json'),
    connected ? candles(DOLLAR_INSTRUMENT) : null,
    connected ? candles(RATE_INSTRUMENT) : null,
  ]);

  const dollarUp = eur?.length ? invertDollar(eur) : null;
  const bars = {};
  if (connected) {
    const got = await Promise.all(instruments.map(i => candles(i.sym)));
    instruments.forEach((i, k) => { bars[i.sym] = got[k]; });
  }

  const rows = instruments.map((inst) => {
    const cs = bars[inst.sym];
    if (!cs?.length) return { inst, missing: connected ? 'no bars' : 'OANDA not connected' };

    const other = instruments.find(x => x.sym !== inst.sym);
    const macro = dollarUp?.length && rate?.length
      ? macroSeries(cs, { dollarUp, rate })
      : null;
    const feats = featureSeries(cs, {
      sym: inst.sym, partner: other ? bars[other.sym] : null, macro,
    });
    let i = feats.length - 1;
    while (i > 0 && !feats[i]) i--;
    const f = feats[i];
    if (!f) return { inst, missing: 'not enough history' };

    const keys = keysOf(f);
    const fires = study ? firing(study, keys) : [];
    const near = study ? nearMisses(study, keys, 1) : [];
    const prev = cs[cs.length - 25] || cs[0];

    return {
      inst,
      at: f.t,
      age: barAge(f.t, now),
      price: f.close,
      atr: f.atr,
      dayPct: prev?.c > 0 ? ((f.close - prev.c) / prev.c) * 100 : null,
      state: keys.map(k => PHRASE[k] || k),
      driver: macro ? describeMacro(macro, i, { name: inst.label.toLowerCase() }) : null,
      fires, near,
      verdict: verdictFor({ fires, near }),
    };
  });

  return {
    now,
    connected,
    haveStudy: !!study,
    studyAsOf: study?.asOf || null,
    rows,
    breaking: breaking(news, instruments, bars, { now }),
    events: nextEvents(news, [...new Set(instruments.flatMap(i => i.ccy))], { now }),
    headlines: topHeadlines(news, instruments, { now }),
    newsAt: news?.headlinesAt || news?.updatedAt || null,
  };
}

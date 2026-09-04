// src/utils/deskEvidence.js
//
// What the desk is allowed to know.
//
// The agents in deskAgents.js are forbidden from recalling anything about the
// market — their training data is a year old and a model that "remembers" gold
// at $2,400 will write a confident paragraph around that number. Everything
// they see comes from here, and everything here comes from something measured:
// live OANDA bars, the bot's published feed and its base rates, the headline
// archive, COT positioning, and the macro decomposition.
//
// The one rule: a piece of evidence that could not be fetched is ABSENT, never
// zero and never a plausible-looking default. An analyst told "COT: 0 contracts"
// will write about balanced positioning; an analyst told "no COT data" will say
// there is none, which is the truth.

import { featureSeries, keysOf, PHRASE } from '../../shared/moveFeatures.mjs';
import { macroSeries, describe as describeMacro } from '../../shared/macroFit.mjs';
import { tagInstruments, severity } from '../../shared/newsTagging.mjs';
import { fetchRegimeStudy, firing, DOLLAR_INSTRUMENT, RATE_INSTRUMENT, invertDollar } from './regimeRead.js';

const RAW = 'https://raw.githubusercontent.com/amandeep97/Forex/main';
const FEED = `${RAW}/bot/feed.json`;
const NEWS = `${RAW}/bot/news.json`;

// `feedSym` is the name the bot tags headlines with — 'XAU/USD', not 'Gold' and
// not 'XAU_USD'. Matching on the display label found nothing at all, which read
// on screen as "0 tagged headlines" and sent the news analyst into a live gold
// selloff with an empty page.
export const DESK_INSTRUMENTS = [
  { sym: 'XAU_USD', feedSym: 'XAU/USD', name: 'Gold', label: 'Gold', dec: 2, ccy: ['XAU', 'USD'] },
  { sym: 'XAG_USD', feedSym: 'XAG/USD', name: 'Silver', label: 'Silver', dec: 3, ccy: ['XAG', 'USD'] },
  { sym: 'EUR_USD', feedSym: 'EUR/USD', name: 'Euro / US Dollar', label: 'EUR/USD', dec: 5, ccy: ['EUR', 'USD'] },
  { sym: 'GBP_USD', feedSym: 'GBP/USD', name: 'Sterling / US Dollar', label: 'GBP/USD', dec: 5, ccy: ['GBP', 'USD'] },
  { sym: 'USD_JPY', feedSym: 'USD/JPY', name: 'US Dollar / Yen', label: 'USD/JPY', dec: 3, ccy: ['USD', 'JPY'] },
  { sym: 'BCO_USD', feedSym: 'USOIL', name: 'Brent Crude', label: 'Oil', dec: 2, ccy: ['OIL', 'USD'] },
  { sym: 'SPX500_USD', feedSym: 'US500', name: 'S&P 500', label: 'US500', dec: 1, ccy: ['USD'] },
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

// Exported so the Desk's own record can re-read the same bars it decided on.
// A second fetch written in the component would eventually disagree with this
// one about which bars are complete, and the record would be scoring a
// different series from the one the verdict was made on.
export async function candles(sym, gran, count) {
  const c = creds();
  if (!c) throw new Error('OANDA is not connected — the desk has no prices to read');
  const base = c.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  const res = await fetch(
    `${base}/instruments/${sym}/candles?granularity=${gran}&count=${count}&price=M`,
    { headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const d = await res.json();
  return (d.candles || []).filter(x => x.complete).map(x => ({
    t: new Date(x.time).getTime(),
    o: +x.mid.o, h: +x.mid.h, l: +x.mid.l, c: +x.mid.c, v: x.volume || 1,
  }));
}

// The live spread, from bid and ask rather than assumed. A trade that costs a
// tenth of its stop to enter is not a trade, and the risk manager cannot check
// that against a number nobody fetched.
async function spread(sym) {
  const c = creds();
  if (!c) return null;
  const base = c.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  try {
    const res = await fetch(
      `${base}/instruments/${sym}/candles?granularity=M15&count=8&price=BA`,
      { headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const d = await res.json();
    const s = (d.candles || []).filter(x => x.complete && x.bid && x.ask)
      .map(x => +x.ask.c - +x.bid.c).filter(v => v > 0).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  } catch { return null; }
}

// Trend on a timeframe, in the terms a person would describe it: how far it has
// travelled, and where it sits between the period's high and low.
function tfSummary(cs, bars) {
  if (!cs || cs.length < bars + 2) return null;
  const w = cs.slice(-bars);
  const first = w[0].c, last = w[w.length - 1].c;
  const hi = Math.max(...w.map(c => c.h)), lo = Math.min(...w.map(c => c.l));
  const chgPct = ((last - first) / first) * 100;
  return {
    bars,
    chgPct,
    trend: chgPct > 1 ? 'up' : chgPct < -1 ? 'down' : 'sideways',
    fromHigh: ((hi - last) / last) * 100,
    fromLow: ((last - lo) / last) * 100,
    high: hi, low: lo,
  };
}

function levelsOf(d1, h4) {
  const out = [];
  if (d1?.length >= 2) {
    const y = d1[d1.length - 2];
    out.push({ label: 'yesterday high', price: y.h }, { label: 'yesterday low', price: y.l });
  }
  if (d1?.length >= 6) {
    const w = d1.slice(-6);
    out.push({ label: 'week high', price: Math.max(...w.map(c => c.h)) },
      { label: 'week low', price: Math.min(...w.map(c => c.l)) });
  }
  if (h4?.length >= 30) {
    const w = h4.slice(-30);
    out.push({ label: '5-day high', price: Math.max(...w.map(c => c.h)) },
      { label: '5-day low', price: Math.min(...w.map(c => c.l)) });
  }
  return out;
}

async function json(url) {
  try {
    const r = await fetch(`${url}?t=${Math.floor(Date.now() / 3e5)}`, { signal: AbortSignal.timeout(20000) });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// Headlines that are ABOUT this instrument, using the same vocabulary the bot
// tags with — so what the desk reads is what the news tab shows, not a second
// opinion about relevance.
// The bot publishes `headlines`, each already tagged with `inst` (feed symbols)
// and `ccy` (currency codes) and scored `sev` 1-3 by the shared vocabulary. Use
// those; fall back to tagging the text here only when a headline predates the
// tagging, so the two sides can never disagree about what a headline is about.
function newsFor(news, inst) {
  const items = news?.headlines || [];
  const out = [];
  for (const it of items) {
    const title = it.title || '';
    const tags = it.inst?.length ? it.inst : tagInstruments(`${title} ${it.desc || ''}`);
    const ccys = it.ccy || [];
    // Directly about the instrument, or about a currency that prices it. A
    // dollar story is a gold story; that is the whole point of the second test.
    const mine = tags.includes(inst.feedSym) || ccys.some(c => inst.ccy.includes(c));
    if (!mine) continue;
    const sev = it.sev ?? severity(`${title} ${it.desc || ''}`);
    out.push({
      title, at: it.at || null,
      // Published as a number. Printed as one, it reads as a price.
      severity: sev >= 3 ? 'high impact' : sev === 2 ? 'notable' : 'routine',
      direct: tags.includes(inst.feedSym),
      dir: it.dir || null,
    });
  }
  // What is actually about this instrument first, then most recent.
  return out.sort((a, b) => (b.direct - a.direct) || ((b.at || 0) - (a.at || 0)));
}

// The calendar's `country` field holds the CURRENCY code — 'USD', 'EUR', 'All'.
// A high-impact US release is relevant to gold whether or not anyone tagged it.
function eventsFor(news, inst) {
  const cal = news?.calendar || [];
  const now = Date.now();
  return cal
    .filter(e => e.at > now && e.at < now + 48 * 3600e3)
    .filter(e => {
      const c = (e.country || '').toUpperCase();
      return inst.ccy.includes(c) || (c === 'ALL' && /high/i.test(e.impact || ''));
    })
    .map(e => ({ ...e, currency: e.country }))
    .sort((a, b) => a.at - b.at);
}

// The feed keys its records by display symbol — 'XAU/USD' — and publishes
// positioning as a PERCENTILE of its own history under state.posnPct, not as a
// contract count. Looking for `rec.cot` found nothing on every instrument, which
// showed on screen as "missing: cot" and left the positioning analyst with an
// empty page while the number was sitting in the file.
function positionFor(feed, inst) {
  const st = feed?.instruments?.[inst.feedSym]?.state;
  if (!st || st.posnPct == null) return null;
  return { pct: st.posnPct, weeks: st.posnWeeks ?? null };
}

// The spread the feed measured, as a fallback when the live bid/ask call fails.
function feedSpread(feed, inst) {
  const st = feed?.instruments?.[inst.feedSym]?.state;
  return st?.spreadAbs ?? null;
}

/**
 * Everything the desk is allowed to see, for one instrument.
 *
 * Every field is either real or absent. Nothing is defaulted, because a default
 * is a fact the agents cannot tell apart from a measurement.
 */
export async function gatherEvidence(inst, { onStep = () => {} } = {}) {
  onStep('prices');
  const [h1, h4, d1] = await Promise.all([
    candles(inst.sym, 'H1', 2000),
    candles(inst.sym, 'H4', 200),
    candles(inst.sym, 'D', 120),
  ]);
  if (!h1?.length) throw new Error(`no hourly bars for ${inst.label} — is OANDA connected?`);

  onStep('macro');
  // The two things most instruments here are partly a function of. A missing
  // entitlement costs the rest of the pack nothing.
  const [eur, rate] = await Promise.all([
    candles(DOLLAR_INSTRUMENT, 'H1', 2000).catch(() => null),
    candles(RATE_INSTRUMENT, 'H1', 2000).catch(() => null),
  ]);
  const macro = eur?.length && rate?.length && inst.sym !== DOLLAR_INSTRUMENT
    ? macroSeries(h1, { dollarUp: invertDollar(eur), rate })
    : null;

  onStep('partner');
  const partnerSym = inst.sym === 'XAU_USD' ? 'XAG_USD' : inst.sym === 'XAG_USD' ? 'XAU_USD' : null;
  const partnerCs = partnerSym ? await candles(partnerSym, 'H1', 2000).catch(() => null) : null;

  const feats = featureSeries(h1, { sym: inst.sym, partner: partnerCs, macro });
  let i = feats.length - 1;
  while (i > 0 && !feats[i]) i--;
  const f = feats[i] || null;
  const keys = f ? keysOf(f) : [];

  onStep('feed');
  const [feed, news, study] = await Promise.all([
    json(FEED), json(NEWS), fetchRegimeStudy().catch(() => null),
  ]);

  onStep('spread');
  const sp = await spread(inst.sym);

  const last = h1[h1.length - 1];
  const partnerNote = partnerCs?.length
    ? (() => {
      const a = (last.c - h1[h1.length - 13].c) / h1[h1.length - 13].c * 100;
      const p = partnerCs[partnerCs.length - 1];
      const p0 = partnerCs[partnerCs.length - 13];
      const b = p0 ? (p.c - p0.c) / p0.c * 100 : null;
      if (b == null) return null;
      return `${partnerSym === 'XAG_USD' ? 'silver' : 'gold'} is ${b >= 0 ? '+' : ''}${b.toFixed(2)}% over the same 12 hours `
        + `against this instrument's ${a >= 0 ? '+' : ''}${a.toFixed(2)}% — they are ${Math.sign(a) === Math.sign(b) ? 'agreeing' : 'diverging'}`;
    })()
    : null;

  return {
    sym: inst.sym, name: inst.name, label: inst.label, dec: inst.dec,
    at: last.t, price: last.c, atr: f?.atr ?? null, spread: sp ?? feedSpread(feed, inst),
    state: f ? { keys, plain: keys.map(k => PHRASE[k] || k) } : null,
    tf: {
      'Last 5 days (H4)': tfSummary(h4, 30),
      'Last month (daily)': tfSummary(d1, 22),
      'Last quarter (daily)': tfSummary(d1, 65),
    },
    levels: levelsOf(d1, h4),
    driver: macro ? describeMacro(macro, i, { name: inst.label.toLowerCase() }) : null,
    rules: study ? firing(study, keys) : [],
    studyAsOf: study?.asOf || null,
    news: newsFor(news, inst),
    events: eventsFor(news, inst),
    cot: positionFor(feed, inst),
    partner: partnerNote,
    // For the record, so a reader can tell a thin pack from a full one.
    have: {
      prices: !!h1?.length, macro: !!macro, feed: !!feed, news: !!(news || feed),
      study: !!study, spread: sp != null || feedSpread(feed, inst) != null,
      positioning: !!positionFor(feed, inst),
    },
  };
}

// src/utils/confluence.js
// What is worth looking at right now, and why — across every kind of evidence.
//
// The old Command Center scored five factors that were not five things. Two of
// them were the same momentum reading counted twice, and a third was a clock
// that returned the same number for every instrument. Everything it produced
// came from one source: recent price.
//
// A reversal is not a candlestick. It is a candlestick AND a level being swept
// AND positioning being one-sided AND something in the calendar that explains
// why now. Any one of those alone is noise — the whole point is that they
// rarely line up, and that when they do it is worth knowing.
//
// So evidence is grouped into FAMILIES, and the ranking is driven by how many
// INDEPENDENT families agree rather than by how large any single reading is.
// Three technical signals that all derive from the same twenty candles are one
// piece of evidence wearing three hats; a candle pattern plus a positioning
// extreme plus a scheduled event are three.
//
// Nothing here is a prediction. Every line is something that has happened or
// is scheduled, with a stated rarity. The screen says what is unusual, not
// what will occur.

export const FAMILY = {
  price:     { label: 'Price action', weight: 1.0 },
  structure: { label: 'Structure',    weight: 1.0 },
  volatility:{ label: 'Volatility',   weight: 0.8 },
  crossasset:{ label: 'Cross-asset',  weight: 1.0 },
  positioning:{label: 'Positioning',  weight: 1.2 },   // COT — slow, independent of price
  news:      { label: 'News',         weight: 1.2 },   // scheduled or just happened
};

const DAY = 86400e3;

// Reversal patterns worth surfacing, and which way they point. A tweezer that
// fires thirty times a month is not evidence of anything, so rarity decides
// whether one appears at all — see RARE_ENOUGH below.
const REVERSAL = {
  hammer:'up', inv_hammer:'up', dragonfly_doji:'up', bull_engulf:'up',
  piercing_line:'up', bull_harami:'up', tweezer_bottom:'up', morning_star:'up',
  three_inside_up:'up', abandoned_bull:'up', kicker_bull:'up',
  shooting_star:'down', hanging_man:'down', gravestone_doji:'down',
  bear_engulf:'down', dark_cloud:'down', bear_harami:'down', tweezer_top:'down',
  evening_star:'down', three_inside_dn:'down', abandoned_bear:'down', kicker_bear:'down',
};

// Occurrences per month above which a pattern is wallpaper. A daily harami at
// 1.2/month is a rare event on that instrument; the same name on H4 at 29.7 is
// what the chart does on a quiet afternoon.
const RARE_ENOUGH = 8;

// How recent an event still counts. An H4 sweep from six days ago is history,
// not a reason to look now.
const FRESH = { H4: 2 * DAY, D: 6 * DAY };

const ago = (t, now) => now - (t || 0);

function freshness(at, tf, now) {
  const age = ago(at, now);
  const window = FRESH[tf] || 2 * DAY;
  if (age < 0 || age > window) return 0;
  return 1 - age / window;          // 1 = just happened, 0 = at the edge
}

// ── Evidence collectors ──────────────────────────────────────────────────────
// Each returns { family, dir, label, detail, weight } or nothing. `dir` is
// 'up' | 'down' | null, and null means "notable but not directional" — a
// volatility squeeze says something is coming, not which way.

function candleEvidence(rec, now) {
  const out = [];
  const byTf = rec.patterns || {};
  // A pattern on two timeframes at once is the thing being asked for, and it
  // is rare enough to deserve its own line rather than two separate ones.
  const seen = {};
  for (const [tf, list] of Object.entries(byTf)) {
    for (const p of list || []) {
      const dir = REVERSAL[p.id];
      if (!dir) continue;
      if ((p.rate ?? 99) > RARE_ENOUGH) continue;
      const f = freshness(p.at, tf, now);
      if (!f) continue;
      (seen[p.id] ||= []).push({ tf, rate: p.rate, f });
    }
  }
  for (const [id, hits] of Object.entries(seen)) {
    const dir = REVERSAL[id];
    const tfs = hits.map(h => h.tf);
    const rarest = Math.min(...hits.map(h => h.rate ?? 99));
    const multi = hits.length > 1;
    out.push({
      family: 'price',
      dir,
      label: `${id.replace(/_/g, ' ')}${multi ? ` on ${tfs.join(' + ')}` : ` on ${tfs[0]}`}`,
      detail: `${rarest.toFixed(1)}× a month on this instrument`,
      // Two timeframes agreeing is genuinely more than one, and a rarer
      // pattern is stronger evidence than a common one.
      weight: (multi ? 1.6 : 1) * (rarest <= 2 ? 1.4 : rarest <= 4 ? 1.15 : 1)
              * Math.max(...hits.map(h => h.f)),
      multiTf: multi,
    });
  }
  return out;
}

function structureEvidence(rec, now) {
  const out = [];
  const rarity = rec.rarity || {};
  for (const e of rec.events || []) {
    const f = freshness(e.at, e.tf, now);
    if (!f) continue;
    const r = rarity[`${e.type}.${e.tf}`];
    const perMonth = r?.perMonth;
    // The feed's "sweep" is detectStrongReversal — a strong hammer or a strong
    // shooting star, where the bar takes out N bars of highs or lows and closes
    // back inside. It already resolves direction: dir 'up' IS the hammer.
    //
    // This used to invert it, reasoning that sweeping the highs is a rejection
    // of up — which is correct reasoning applied to a value that had already
    // had it applied, so every strong hammer was reported as bearish and every
    // star as bullish. Exactly backwards, on the highest-weight signal here.
    const dir = e.dir === 'up' ? 'up' : 'down';
    const label = e.type === 'sweep'
      ? (e.dir === 'up' ? `strong hammer on ${e.tf}` : `strong shooting star on ${e.tf}`)
      : `structure break ${e.dir} on ${e.tf}`;
    out.push({
      family: 'structure',
      dir,
      label,
      detail: e.detail || '',
      rarity: perMonth,
      strong: e.type === 'sweep',
      weight: f * (perMonth == null ? 1 : perMonth <= 2 ? 1.5 : perMonth <= 5 ? 1.2 : 0.8),
    });
  }
  return out;
}

function volatilityEvidence(rec) {
  const out = [];
  for (const [tf, st] of Object.entries(rec.state || {})) {
    if (!st) continue;
    if (st.volPct != null && st.volPct <= 5) {
      out.push({ family:'volatility', dir:null, label:`volatility at a ${tf} floor`,
        detail:`bottom ${st.volPct}% of its own range — coiled`, weight:1.1 });
    } else if (st.volPct != null && st.volPct >= 95) {
      out.push({ family:'volatility', dir:null, label:`volatility at a ${tf} extreme`,
        detail:`top ${st.volPct}% — moves are already large`, weight:0.9 });
    }
    if (st.rangePos != null && st.rangePos >= 98) {
      out.push({ family:'volatility', dir:'down', label:`pinned at the top of its ${tf} range`,
        detail:`${st.rangePos}% of the 60-bar range`, weight:1.0 });
    } else if (st.rangePos != null && st.rangePos <= 2) {
      out.push({ family:'volatility', dir:'up', label:`pinned at the bottom of its ${tf} range`,
        detail:`${st.rangePos}% of the 60-bar range`, weight:1.0 });
    }
  }
  return out;
}

function leadershipEvidence(rec) {
  const l = rec.leaders;
  if (!l?.list?.length) return [];
  // Only leaders that clear the noise floor the VPS already computed. Below it
  // the correlation is indistinguishable from chance at this sample size.
  const strong = l.list.filter(x => Math.abs(x.r) > (l.floor ?? 0.25)).slice(0, 2);
  return strong.map(x => ({
    family: 'crossasset',
    dir: null,
    label: `${x.sym} leads by ${x.lag} bar${x.lag > 1 ? 's' : ''}`,
    detail: `r=${x.r.toFixed(2)} against a ${(l.floor ?? 0).toFixed(2)} noise floor`,
    weight: 0.9,
  }));
}

// ── News ─────────────────────────────────────────────────────────────────────
// The currencies an instrument is exposed to. A calendar event only matters to
// an instrument that touches the currency it concerns.
export function currenciesOf(sym, cls) {
  if (!sym) return [];
  if (sym.includes('/')) {
    const [a, b] = sym.split('/');
    if (b === 'USDT') return cls === 'tradfi' ? ['USD'] : ['USD', a];
    return [a, b];
  }
  // Indices and single-name symbols
  if (/^(US|SPX|NAS|DJ)/.test(sym)) return ['USD'];
  if (/^UK/.test(sym)) return ['GBP'];
  if (/^GER|^FR|^EU/.test(sym)) return ['EUR'];
  if (/^JPN/.test(sym)) return ['JPY'];
  if (/OIL|NATGAS/.test(sym)) return ['USD', 'OIL'];
  return ['USD'];
}

function newsEvidence(sym, cls, news, now) {
  if (!news) return [];
  const mine = new Set(currenciesOf(sym, cls));
  const out = [];

  // Scheduled, high impact, within the next 24 hours. This is the one piece of
  // evidence that is about the future rather than the past, and the only
  // honest thing to say about it is that it is coming.
  for (const e of news.calendar || []) {
    if (e.impact !== 'high') continue;
    if (!mine.has(e.country)) continue;
    const inMs = e.at - now;
    if (inMs < -2 * 3600e3 || inMs > 24 * 3600e3) continue;
    const hrs = inMs / 3600e3;
    out.push({
      family: 'news',
      dir: null,
      label: hrs < 0 ? `${e.country} ${e.title} — just released`
           : hrs < 1 ? `${e.country} ${e.title} in ${Math.round(hrs * 60)} min`
           : `${e.country} ${e.title} in ${hrs.toFixed(1)}h`,
      detail: [e.forecast && `forecast ${e.forecast}`, e.previous && `prev ${e.previous}`]
        .filter(Boolean).join(' · '),
      // Imminent matters more than merely today.
      weight: hrs < 0 ? 1.3 : hrs < 2 ? 1.4 : hrs < 8 ? 1.0 : 0.7,
      scheduled: true,
      shared: e.country,        // identical on every instrument touching it
      driver: `${e.country} ${e.title}`,
    });
  }

  // Headlines from the last six hours that name one of this instrument's
  // currencies. Older than that and it is context, not news.
  const recent = (news.headlines || [])
    .filter(h => now - h.at < 6 * 3600e3 && (h.ccy || []).some(c => mine.has(c)))
    .slice(0, 2);
  for (const h of recent) {
    out.push({
      family: 'news', dir: null,
      label: h.title.length > 90 ? h.title.slice(0, 88) + '…' : h.title,
      detail: `${h.source} · ${Math.round((now - h.at) / 60000)} min ago`,
      weight: 0.8, headline: true, link: h.link,
      shared: (h.ccy || [])[0] || 'news',
      driver: h.title,
    });
  }
  return out;
}

function positioningEvidence(sym, cls, cot) {
  if (!cot) return [];
  const [base, quote] = sym.includes('/') ? sym.split('/') : [sym, null];
  const out = [];
  const add = (ccy, sign) => {
    const v = cot[ccy];
    if (v == null || Math.abs(v) < 0.5) return;    // only genuine extremes
    out.push({
      family: 'positioning',
      dir: (v * sign) > 0 ? 'up' : 'down',
      label: `${ccy} positioning ${v > 0 ? 'heavily long' : 'heavily short'}`,
      detail: `net ${(v * 100).toFixed(0)}% of open interest — crowded`,
      weight: Math.min(1.4, 0.8 + Math.abs(v)),
    });
  };
  add(base, 1);
  if (quote && quote !== 'USDT') add(quote, -1);
  return out;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function assess(sym, rec, { news = null, cot = null, now = Date.now() } = {}) {
  if (!rec) return null;
  const cls = rec.cls;
  const evidence = [
    ...candleEvidence(rec, now),
    ...structureEvidence(rec, now),
    ...volatilityEvidence(rec),
    ...leadershipEvidence(rec),
    ...newsEvidence(sym, cls, news, now),
    ...positioningEvidence(sym, cls, cot),
  ];
  if (!evidence.length) return null;

  // Shared vs own.
  //
  // An RBA decision is identical evidence on AUD/NZD, AUD/CHF, AUD/JPY and
  // every other AUD pair. Counting it per instrument put seven near-identical
  // cards at the top of the screen, each listing the same three lines, and
  // buried everything else — the same double-counting the family model exists
  // to prevent, happening across instruments instead of within one.
  //
  // A currency driver cannot discriminate between instruments that all contain
  // that currency, so it does not contribute to the ranking. It is shown as
  // context, once, with the list of what it touches.
  const own = evidence.filter(e => !e.shared);
  const shared = evidence.filter(e => e.shared);
  if (!own.length) return null;

  const families = [...new Set(own.map(e => e.family))];

  // Direction is a vote, weighted, and only over evidence that has one. A
  // volatility squeeze and a calendar event are real but say nothing about
  // which way — counting them as agreement would manufacture a bias.
  let up = 0, down = 0;
  for (const e of own) {
    if (e.dir === 'up') up += e.weight * (FAMILY[e.family]?.weight ?? 1);
    else if (e.dir === 'down') down += e.weight * (FAMILY[e.family]?.weight ?? 1);
  }
  const net = up - down;
  const dir = Math.abs(net) < 0.35 ? null : net > 0 ? 'up' : 'down';

  // The score is driven by breadth across families, not by the loudest single
  // reading. Four price-action signals from the same twenty candles are one
  // piece of evidence; a candle plus positioning plus a scheduled event are
  // three, and that is the case worth surfacing.
  const base = own.reduce((s, e) => s + e.weight * (FAMILY[e.family]?.weight ?? 1), 0);
  const breadth = families.length;
  const score = +(base * (1 + 0.35 * (breadth - 1))).toFixed(2);

  const byWeight = (a, b) =>
    (b.weight * (FAMILY[b.family]?.weight ?? 1)) - (a.weight * (FAMILY[a.family]?.weight ?? 1));

  return {
    sym, cls, price: rec.price, dec: rec.dec, name: rec.name,
    evidence: own.sort(byWeight),
    shared: shared.sort(byWeight),
    families, breadth, dir, score,
    conflict: up > 0.5 && down > 0.5,   // evidence disagrees — worth saying so
    hasNews: shared.length > 0,
    strong: own.some(e => e.strong),
    multiTf: own.some(e => e.multiTf),
    ccy: currenciesOf(sym, cls),
  };
}

// Shared drivers, grouped once instead of repeated on every affected card.
//
// "RBA decision in 1.5h → AUD/NZD, AUD/CHF, GBP/AUD and four others" is one
// fact. Printing it seven times is not seven facts, and it pushed everything
// else off the screen.
export function driversOf(assessed) {
  const map = new Map();
  for (const a of assessed) {
    for (const e of a.shared || []) {
      const key = e.driver || e.label;
      if (!map.has(key)) {
        map.set(key, { key, label: e.label, detail: e.detail, ccy: e.shared,
                       scheduled: !!e.scheduled, weight: e.weight, syms: [] });
      }
      const d = map.get(key);
      if (!d.syms.includes(a.sym)) d.syms.push(a.sym);
      // The nearest event wins the label — "in 20 min" beats "in 1.5h".
      if (e.weight > d.weight) { d.weight = e.weight; d.label = e.label; }
    }
  }
  return [...map.values()].sort((a, b) =>
    (b.syms.length * b.weight) - (a.syms.length * a.weight));
}

// Everything worth looking at, most confluent first.
//
// The threshold is on BREADTH, not score: one very loud technical signal is
// what every other screen in this app already shows. This one exists to find
// the moments when unrelated kinds of evidence point at the same instrument.
export function rank(feed, { news = null, cot = null, now = Date.now(), minBreadth = 2 } = {}) {
  const out = [];
  for (const [sym, rec] of Object.entries(feed?.instruments || {})) {
    const a = assess(sym, rec, { news, cot, now });
    if (a && a.breadth >= minBreadth) out.push(a);
  }
  return out.sort((a, b) => b.score - a.score);
}

// How stale the data is. A live screen that quietly shows yesterday's readings
// as current is worse than one that is honestly empty.
export function ageOf(feed, news, now = Date.now()) {
  const f = feed?.updatedAt ? now - Date.parse(feed.updatedAt) : null;
  const n = news?.updatedAt ? now - Date.parse(news.updatedAt) : null;
  return {
    feedMs: f, newsMs: n,
    feedStale: f == null || f > 30 * 60e3,
    newsStale: n == null || n > 90 * 60e3,
  };
}

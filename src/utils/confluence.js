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

// Rarity has to be measured per BAR, not per month.
//
// "Five times a month" means opposite things on different timeframes: M15 has
// roughly 2,900 bars in a month and Daily has 22, so five occurrences is
// extraordinary on one and routine on the other. A flat monthly threshold
// treated them identically, and adding three intraday timeframes promptly put
// most of the board back on the screen.
//
// Per bar it is one number with one meaning: how often does this instrument do
// this, out of the chances it had.
// Corrected once already, in the other direction. Per-bar rarity is the right
// measure of "unusual for this instrument" and the wrong one for this screen:
// a pattern at one bar in seventeen fires about 170 times a month on M15, which
// is rare per bar and constant in wall-clock terms. This tab answers "what is
// happening now", and now is a human unit, so the threshold is per month and
// deliberately strict — on M15 only something genuinely exceptional survives it.
const MAX_PER_MONTH = 4;

// Corrected a second time, and this is the correction that matters.
//
// Per month is the right unit and the wrong threshold. Four a month means
// something on Daily, which has 22 bars in a month; on M15, which has 2,900,
// nothing can be that rare. Measured on a live feed: of 297 fresh M15 candle
// patterns, ZERO cleared it. M30 kept 2, H1 kept 1, against Daily's 121. The
// structure gate was worse — the rarest intraday structure event anywhere in
// the feed fired 7.3 times a month, against a threshold of 8, so the entire
// intraday population was excluded by construction rather than by selection.
//
// That is not strictness. A filter that always returns zero is not selecting.
//
// So the threshold is a RANK within the timeframe's own population — the
// rarest tenth of what M15 does, judged against other M15 events — which is
// the argument this file already makes for ranking instruments rather than
// scoring them against absolutes. The absolute caps stay as a FLOOR, so the
// slow timeframes keep exactly the behaviour they have now and only the fast
// ones, which had nothing, gain a population.
const RARE_PCTL = 0.10;

function pctl(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.floor(sorted.length * p) - 1)];
}

// The cutoffs, measured across every instrument at once. This has to be a
// population pass — an instrument cannot know whether its own M15 event is
// unusual for M15 without seeing what M15 does elsewhere.
export function rarityCutoffs(feed) {
  const pat = {}, str = {};
  for (const rec of Object.values(feed?.instruments || {})) {
    for (const [tf, list] of Object.entries(rec.patterns || {})) {
      for (const p of list || []) {
        if (p.rate != null && freshness(p.at, tf, rec.asOf)) (pat[tf] ||= []).push(p.rate);
      }
    }
    for (const e of rec.events || []) {
      const pm = (rec.rarity || {})[`${e.type}.${e.tf}`]?.perMonth;
      if (pm != null && freshness(e.at, e.tf, rec.asOf)) (str[e.tf] ||= []).push(pm);
    }
  }
  const cut = (m, floor) => Object.fromEntries(Object.entries(m).map(([tf, a]) => {
    a.sort((x, y) => x - y);
    // Floored by the absolute cap, never tighter than it. On the slow
    // timeframes the tenth percentile normally sits well below the cap, so
    // Daily and H4 keep the threshold they have; on a day when H4 events are
    // unusually common its own tenth percentile can run past the cap, and
    // admitting those is the same rule, not an exception to it.
    return [tf, Math.max(floor, pctl(a, RARE_PCTL) ?? floor)];
  }));
  return { pattern: cut(pat, MAX_PER_MONTH), structure: cut(str, MAX_PER_MONTH * 2) };
}

// Significance is a separate axis from rarity. A daily strong hammer and an
// M15 one can be equally rare in per-bar terms and are not equally worth
// knowing about — the daily one survived a hundred times as much trading.
const TF_WEIGHT = { M15: 0.45, M30: 0.6, H1: 0.8, H4: 1.0, D: 1.3 };

// ── Horizon ──────────────────────────────────────────────────────────────────
//
// A timeframe is not a preference, it is a holding period, and mixing them
// produced a screen that could not be traded from.
//
// Every record on this screen is measured forward over a window the feed picks
// per timeframe: Daily looks 10 bars ahead (about a fortnight), H4 looks 20
// (about three days), H1 and below look a day or less. Those are two different
// questions. Ranking a Daily setup and an M15 setup against each other on one
// list asks you to compare "this instrument is likely to be higher in two
// weeks" with "this instrument is likely to be higher by lunchtime", and the
// old code went further than that — it let the M15 vote count toward the
// direction of the Daily setup, so an intraday pullback could flip the stated
// bias of a two-week idea.
//
// So evidence is split by the horizon it speaks to, and the two are combined in
// one direction only: the slow evidence sets the bias, the fast evidence can
// time an entry into it. That is the difference between a swing trade and an
// intraday trade, and it is what decides which record prices the trade.
const SWING_TFS = new Set(['D', 'H4']);

// Positioning, cross-asset leadership and the calendar carry no timeframe. They
// move over days to weeks, so they belong with the slow evidence rather than
// being discarded — but they are context, and context alone is never a setup.
export function horizonOf(e) {
  const tfs = e?.tfs || [];
  if (!tfs.length) return 'context';
  return tfs.some(t => SWING_TFS.has(t)) ? 'swing' : 'intraday';
}

// A setup where the slow bias and the fast trigger agree is the thing being
// hunted for, and it is much rarer than either alone. An intraday-only idea is
// still shown — sometimes the better setup really is the fast one — but it has
// to be exceptional to outrank a swing setup rather than merely present.
const KIND_WEIGHT = { trigger: 1.35, swing: 1.0, intraday: 0.55 };


// Freshness is counted in BARS, against the feed's own last bar — not in days
// against the wall clock.
//
// Measuring in days made "recent" mean twelve H4 bars, and with thirty-four
// pattern types across five timeframes every instrument accumulates several
// inside a window that wide. Measured on live data: 100% of seventy-two
// instruments had a "rare" pattern and 99% had a structure event, so almost
// everything cleared two families and the screen selected nothing.
//
// Against the wall clock it was also wrong in a second way. If the feed last
// refreshed an instrument four hours ago, an event on its most recent bar is
// already "old" by a clock and is still the latest thing that happened.
const TF_MS = { M15: 900e3, M30: 1800e3, H1: 3600e3, H4: 14400e3, D: 86400e3 };
const MAX_BARS_AGO = 2;

function freshness(at, tf, asOf) {
  const ms = TF_MS[tf];
  const last = asOf?.[tf];
  if (!ms || !last || !at) return 0;
  const bars = (last - at) / ms;
  if (bars < -0.5 || bars > MAX_BARS_AGO) return 0;
  return 1 - Math.max(0, bars) / (MAX_BARS_AGO + 1);
}

// ── Evidence collectors ──────────────────────────────────────────────────────
// Each returns { family, dir, label, detail, weight } or nothing. `dir` is
// 'up' | 'down' | null, and null means "notable but not directional" — a
// volatility squeeze says something is coming, not which way.

function candleEvidence(rec, asOf, cuts) {
  const out = [];
  const byTf = rec.patterns || {};
  // A pattern on two timeframes at once is the thing being asked for, and it
  // is rare enough to deserve its own line rather than two separate ones.
  const seen = {};
  for (const [tf, list] of Object.entries(byTf)) {
    for (const p of list || []) {
      const dir = REVERSAL[p.id];
      if (!dir) continue;
      if ((p.rate ?? 99) > (cuts?.pattern?.[tf] ?? MAX_PER_MONTH)) continue;
      const f = freshness(p.at, tf, asOf);
      if (!f) continue;
      // One entry per timeframe. The same pattern can appear twice in a
      // timeframe's list — two occurrences within the retained window — and
      // pushing both produced labels reading "bull engulf on H4 + H4 + D".
      const bucket = (seen[p.id] ||= []);
      const existing = bucket.find(x => x.tf === tf);
      if (existing) { if (f > existing.f) { existing.f = f; existing.rate = p.rate; } }
      else bucket.push({ tf, rate: p.rate, f });
    }
  }
  // A bullish and a bearish pattern on the same instrument is not two pieces of
  // evidence, it is an unclear chart. Both were being listed — "bear harami on
  // H4 + D" directly above "bull engulf on H4 + D" — which inflated the count
  // and made almost every card read EVIDENCE DISAGREES. The fresher and rarer
  // side is kept and the other is dropped.
  const score = h => Math.max(...h.map(x => x.f)) * (h.length > 1 ? 1.6 : 1)
                     / Math.max(0.5, Math.min(...h.map(x => x.rate ?? 99)));
  const ups = Object.entries(seen).filter(([id]) => REVERSAL[id] === 'up');
  const dns = Object.entries(seen).filter(([id]) => REVERSAL[id] === 'down');
  if (ups.length && dns.length) {
    const bestUp = Math.max(...ups.map(([, h]) => score(h)));
    const bestDn = Math.max(...dns.map(([, h]) => score(h)));
    const drop = bestUp >= bestDn ? dns : ups;
    for (const [id] of drop) delete seen[id];
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
      tfs,
      detail: `${rarest.toFixed(1)}× a month on this instrument`,
      // Two timeframes agreeing is genuinely more than one, and a rarer
      // pattern is stronger evidence than a common one.
      // Weighted by the slowest timeframe it appeared on: a pattern present on
      // both M15 and Daily is a daily event that also shows intraday, not an
      // intraday one.
      weight: (multi ? 1.6 : 1)
              * Math.max(...hits.map(h => TF_WEIGHT[h.tf] ?? 1))
              * Math.max(...hits.map(h => h.f)),
      multiTf: multi,
    });
  }
  return out;
}

function structureEvidence(rec, asOf, cuts) {
  const out = [];
  const rarity = rec.rarity || {};
  for (const e of rec.events || []) {
    const f = freshness(e.at, e.tf, asOf);
    if (!f) continue;
    const r = rarity[`${e.type}.${e.tf}`];
    const perMonth = r?.perMonth;
    // Routine for its own timeframe is not an event worth a line — and "for
    // its own timeframe" is now measured against what that timeframe does,
    // not against a number that only ever made sense on Daily.
    if (perMonth != null && perMonth > (cuts?.structure?.[e.tf] ?? MAX_PER_MONTH * 2)) continue;
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
    // What happened the last time this fired here. A pattern with no
    // consequence attached is the thing every other screen shows; this is the
    // instrument's own record, with its sample size, and it is the only line
    // on the card that answers "so what".
    const base = r?.fwdN >= 5 ? {
      n: r.fwdN, win: r.fwdWin, med: r.fwdMedAtr, bars: r.fwdBars,
    } : null;
    out.push({
      family: 'structure',
      dir,
      label,
      tfs: [e.tf],
      detail: e.detail || '',
      rarity: perMonth,
      strong: e.type === 'sweep',
      base,
      // Evidence with a measured history behind it outranks evidence without
      // one — but only mildly, and only when the record is actually favourable.
      // Rarity is graded against the same cutoff that admitted it, for the
      // same reason the cutoff is per-timeframe: an M15 event that fires 14
      // times a month is exceptional for M15, and a fixed "more than 4 a month
      // is routine" scored every one of them as routine.
      // The ratios reproduce the old fixed boundaries exactly on the slow
      // timeframes — 1.5 and 4 against the Daily cutoff of 8.
      weight: f * (TF_WEIGHT[e.tf] ?? 1)
                * (perMonth == null ? 1 : (() => {
                    const ratio = perMonth / (cuts?.structure?.[e.tf] ?? MAX_PER_MONTH * 2);
                    return ratio <= 0.1875 ? 1.5 : ratio <= 0.5 ? 1.2 : 0.7;
                  })())
                * (base && base.n >= 10 ? (base.win >= 60 ? 1.25 : base.win <= 40 ? 0.8 : 1) : 1),
    });
  }
  return out;
}

function volatilityEvidence(rec) {
  const out = [];
  for (const [tf, st] of Object.entries(rec.state || {})) {
    // state also carries non-timeframe keys — spreadRatio, posnPct, posnWeeks —
    // which would otherwise be reported as "volatility at a posnPct floor".
    if (!st || typeof st !== 'object' || !TF_MS[tf]) continue;
    if (st.volPct != null && st.volPct <= 5) {
      out.push({ family:'volatility', dir:null, label:`volatility at a ${tf} floor`, tfs:[tf],
        detail:`bottom ${st.volPct}% of its own range — coiled`, weight:1.1 });
    } else if (st.volPct != null && st.volPct >= 95) {
      out.push({ family:'volatility', dir:null, label:`volatility at a ${tf} extreme`, tfs:[tf],
        detail:`top ${st.volPct}% — moves are already large`, weight:0.9 });
    }
    if (st.rangePos != null && st.rangePos >= 98) {
      out.push({ family:'volatility', dir:'down', label:`pinned at the top of its ${tf} range`, tfs:[tf],
        detail:`${st.rangePos}% of the 60-bar range`, weight:1.0 });
    } else if (st.rangePos != null && st.rangePos <= 2) {
      out.push({ family:'volatility', dir:'up', label:`pinned at the bottom of its ${tf} range`, tfs:[tf],
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
  // Clearing the noise floor by a hair is not a finding — 57% of instruments
  // had at least one leader over it, so as a qualifying criterion it selected
  // nothing. Well clear of the floor, and only the strongest.
  const strong = l.list
    .filter(x => Math.abs(x.r) > Math.max((l.floor ?? 0.25) * 1.6, 0.35))
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
    .slice(0, 1);
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

export function assess(sym, rec, { news = null, cot = null, now = Date.now(), cuts = null } = {}) {
  if (!rec) return null;
  const cls = rec.cls;
  const evidence = [
    ...candleEvidence(rec, rec.asOf, cuts),
    ...structureEvidence(rec, rec.asOf, cuts),
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

  // Something has to have HAPPENED.
  //
  // Volatility regime, leadership and positioning are states: they are true for
  // a third of the board at any moment, and two of them together were enough to
  // put an instrument on the screen with nothing having occurred on it. They
  // explain an event; they cannot be one. Requiring a price or structure event
  // is what makes this a list of things that just happened rather than a list
  // of things that are currently the case.
  if (!own.some(e => e.family === 'price' || e.family === 'structure')) return null;

  const families = [...new Set(own.map(e => e.family))];

  const byWeight = (a, b) =>
    (b.weight * (FAMILY[b.family]?.weight ?? 1)) - (a.weight * (FAMILY[a.family]?.weight ?? 1));

  // Direction is a vote, weighted, and only over evidence that has one. A
  // volatility squeeze and a calendar event are real but say nothing about
  // which way — counting them as agreement would manufacture a bias.
  //
  // The floor is per-population, and it has to be. TF_WEIGHT caps intraday
  // evidence at 0.8 against Daily's 1.3, so the 0.35 that makes a slow signal
  // count is a far higher bar for a fast one. Applied flat to both, it silenced
  // the fast side almost entirely — on a live snapshot the only two instruments
  // with an intraday event both agreed with their daily bias and both scored
  // 0.2, so neither was ever reported as a timed entry.
  //
  // The two votes are also answering different questions. The slow one decides
  // whether there is a trade at all and deserves a real threshold. The fast one
  // only has to say agree, disagree, or nothing — the strength of the case was
  // already settled by the slow evidence.
  const MIN_NET = { swing: 0.35, intra: 0.15 };
  const vote = (list, floor) => {
    let up = 0, down = 0;
    for (const e of list) {
      if (e.dir === 'up') up += e.weight * (FAMILY[e.family]?.weight ?? 1);
      else if (e.dir === 'down') down += e.weight * (FAMILY[e.family]?.weight ?? 1);
    }
    const net = up - down;
    return { up, down, net, dir: Math.abs(net) < floor ? null : net > 0 ? 'up' : 'down' };
  };

  // Two separate votes, never one. Context sits with the slow side: an
  // extreme in positioning is a two-week fact, not a lunchtime one.
  const swingEv = own.filter(e => horizonOf(e) !== 'intraday');
  const intraEv = own.filter(e => horizonOf(e) === 'intraday');
  const isEvent = e => e.family === 'price' || e.family === 'structure';
  const swingSetup = swingEv.some(isEvent);
  const intraSetup = intraEv.some(isEvent);
  const sv = vote(swingEv, MIN_NET.swing);
  const iv = vote(intraEv, MIN_NET.intra);

  // A setup whose own slow evidence contradicts itself is not a timed entry,
  // whatever the fast timeframes are doing. Calling it one promoted exactly the
  // cards the screen should be cautious about — the trigger bonus was cancelling
  // the conflict penalty, and a contradicted card was arriving at the top of the
  // board labelled TIMED ENTRY.
  const MIN_TRIGGER_COHERENCE = 0.5;
  const swingCoherent = (sv.up + sv.down) > 0
    && Math.abs(sv.net) / (sv.up + sv.down) >= MIN_TRIGGER_COHERENCE;

  let kind, dir, trigger = null, pullback = false;
  if (swingSetup) {
    // The slow evidence owns the direction. This is the whole correction: an
    // M15 hammer inside a bearish daily setup is a pullback to sell into, not
    // a reason to relabel the card bullish.
    dir = sv.dir;
    if (intraSetup && iv.dir && dir && iv.dir === dir && swingCoherent) {
      kind = 'trigger';
      trigger = intraEv.filter(e => e.dir === dir && isEvent(e)).sort(byWeight)[0] || null;
    } else {
      kind = 'swing';
      pullback = !!(dir && iv.dir && iv.dir !== dir);
    }
  } else {
    kind = 'intraday';
    dir = iv.dir;
  }

  // The score is driven by breadth across families, not by the loudest single
  // reading. Four price-action signals from the same twenty candles are one
  // piece of evidence; a candle plus positioning plus a scheduled event are
  // three, and that is the case worth surfacing.
  const base = own.reduce((s, e) => s + e.weight * (FAMILY[e.family]?.weight ?? 1), 0);
  const breadth = families.length;

  // Conflict is only meaningful inside one horizon. Slow and fast evidence
  // disagreeing is ordinary and has its own name — see `pullback` above.
  const cv = kind === 'intraday' ? iv : sv;

  // Agreement has to be worth something, because the score was rewarding its
  // opposite — in two separate places.
  //
  // `base` added up every piece of evidence regardless of which way it pointed,
  // so an instrument with a bullish break and a bearish candle carried more
  // total weight than one with the bullish break alone. And the breadth bonus
  // made it worse: the opposing candle arrived from a different FAMILY, so
  // contradicting the setup earned the 35% multiplier for "independent kinds of
  // evidence agree" — which is the exact opposite of what happened.
  //
  // The effect was systematic. On a live feed, conflicted cards averaged rank
  // 22.5 against 30.3 for cards whose evidence agreed, and eight of the
  // seventeen cards clearing three families were conflicted. The top of the
  // list was reliably something the tool then argued against.
  //
  // So the bonus is counted over families that AGREE with the card's direction,
  // plus the ones that carry no direction at all — a volatility squeeze
  // supports a setup without pointing anywhere. Opposing evidence still counts
  // toward `breadth` for qualification and display, because "these disagree" is
  // worth knowing; it just stops being rewarded for it.
  const agreeing = own.filter(e => !e.dir || e.dir === dir);
  const agreeBreadth = new Set(agreeing.map(e => e.family)).size;

  // Coherence is the share of directional weight that points one way. A clean
  // card keeps its score; a card split down the middle keeps a quarter of it
  // and stays on the screen, because "these disagree" is still worth knowing —
  // it just is not worth ranking first.
  const dirTot = cv.up + cv.down;
  const coherence = dirTot > 0 ? Math.abs(cv.net) / dirTot : 1;
  const score = +(base * (1 + 0.35 * Math.max(0, agreeBreadth - 1)) * (KIND_WEIGHT[kind] ?? 1)
                  * (0.25 + 0.75 * coherence)).toFixed(2);

  // Which evidence the trade would actually be built on, so the record shown
  // on the card is measured over the horizon the trade will be held for.
  const scope = kind === 'intraday' ? intraEv : swingEv;

  return {
    sym, cls, price: rec.price, dec: rec.dec, name: rec.name,
    evidence: own.sort(byWeight),
    shared: shared.sort(byWeight),
    families, breadth, dir, score,
    coherence: +coherence.toFixed(2),
    agreeBreadth,
    // 'swing'    — a D/H4 event, held over the horizon that record was measured on
    // 'trigger'  — the same, with a faster event agreeing: a timed entry into it
    // 'intraday' — nothing on the slow timeframes; a trade in its own right, and
    //              held to a much shorter clock
    kind, trigger, pullback,
    swingDir: sv.dir, intraDir: iv.dir,
    // Evidence disagrees — worth saying so, but only when it genuinely does.
    // The absolute floor alone flagged cards where one side held 85% of the
    // weight, which reads as a contradiction and is a lopsided agreement. Both
    // sides must carry real weight AND neither may dominate.
    conflict: cv.up > 0.5 && cv.down > 0.5 && coherence < MIN_TRIGGER_COHERENCE,
    hasNews: shared.length > 0,
    strong: own.some(e => e.strong),
    multiTf: own.some(e => e.multiTf),
    // Read off the evidence, not scraped back out of its label.
    //
    // This parsed the display string with /\b(H4|D)\b/ — written when those
    // were the only two timeframes — so when M15, M30 and H1 arrived the
    // filters for them matched nothing and silently returned an empty screen.
    // Recovering data from text meant for humans is how that happens.
    tfs: [...new Set(own.flatMap(e => e.tfs || []))],
    swingTfs: [...new Set(swingEv.flatMap(e => e.tfs || []))],
    intraTfs: [...new Set(intraEv.flatMap(e => e.tfs || []))],
    // The strongest measured record among the evidence the trade is built on.
    // Taken from `scope`, not from everything: on a Daily setup with an M15
    // pattern attached, the M15 record answers a question you are not asking.
    base: scope.map(e => e.base).filter(Boolean).sort((a, b) => b.n - a.n)[0] || null,
    ccy: currenciesOf(sym, cls),
  };
}

// When a whole asset class moves together, that is a different fact.
//
// One metal firing a signal is about that metal. Five of seven metals firing
// the same direction at once is about the dollar, or real rates, or risk — a
// regime, not a setup. Nothing in the app said which of those you were looking
// at, and they call for opposite responses: the idiosyncratic one is a trade,
// the cluster is a reason to check your total exposure.
export function clusters(assessed) {
  const byCls = {};
  for (const a of assessed) {
    if (!a.dir) continue;
    (byCls[a.cls] ||= []).push(a);
  }
  const out = [];
  for (const [cls, list] of Object.entries(byCls)) {
    const up = list.filter(a => a.dir === 'up');
    const down = list.filter(a => a.dir === 'down');
    const side = up.length >= down.length ? up : down;
    // A cluster has to be both a real count AND a majority of what fired in
    // that class. "13 of 23" was neither remarkable nor informative — it is
    // roughly what half a class doing anything looks like.
    if (side.length < 4 || side.length < list.length * 0.6) continue;
    out.push({
      cls, dir: side === up ? 'up' : 'down',
      syms: side.map(a => a.sym),
      n: side.length, total: list.length,
    });
  }
  return out.sort((a, b) => b.n - a.n);
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
export function rank(feed, { news = null, cot = null, now = Date.now(),
                             minBreadth = 2, top = null } = {}) {
  const scored = [];
  let total = 0;
  // Measured once over the whole board, then applied to each instrument. What
  // counts as a rare M15 event is a property of the population, not of one
  // chart, so it cannot be decided inside assess().
  const cuts = rarityCutoffs(feed);
  for (const [sym, rec] of Object.entries(feed?.instruments || {})) {
    total++;
    const a = assess(sym, rec, { news, cot, now, cuts });
    if (a) scored.push(a);
  }
  scored.sort((a, b) => b.score - a.score);

  // Percentile against everything measured, not against everything shown.
  //
  // Absolute thresholds do not survive contact with a real market: on a quiet
  // day nothing clears them and on a volatile one everything does, and either
  // way the screen stops discriminating. A rank is stable — "the third most
  // unusual instrument of seventy-two" means the same thing in both.
  scored.forEach((a, i) => {
    a.rank = i + 1;
    a.of = total;
    a.pct = Math.round(((total - i) / total) * 100);
  });

  let out = scored.filter(a => a.breadth >= minBreadth);
  if (top) out = out.slice(0, top);
  return out;
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

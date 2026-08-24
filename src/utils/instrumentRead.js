// src/utils/instrumentRead.js
// One question, answered per instrument: what is going on here?
//
// Every leg of that answer already existed and none of them talked to each
// other. The technical record is in confluence.js, the fundamental one in
// macroDrivers.js, institutional positioning arrives with the feed as a COT
// percentile, retail positioning and smart-vs-dumb live in flowFeed.js,
// headlines are matched to currencies in the news file, the calendar carries
// what is scheduled, and the feed publishes which instruments lead this one.
// Seven separate readings, seven separate screens, and the person looking at
// them had to do the combining.
//
// This does the combining. It invents nothing: every line below is a number
// that was already measured somewhere, and a leg with nothing to say says
// nothing rather than filling the space.
//
// The output is deliberately small — a direction per leg, a sentence of
// evidence, and an honest count of how many agree. The value is not in any one
// leg. It is in seeing that four of them point the same way, or that the
// technical picture and the positioning picture flatly contradict each other,
// which is the thing no single screen could ever show.

import { currenciesOf, tellsUsSomething, verdictOf } from './confluence';

// ── Legs ─────────────────────────────────────────────────────────────────────
//
// Each returns { dir, headline, detail, weight } or null. dir is 'up', 'down'
// or null for something that matters without pointing anywhere — an event
// risk, a volatility regime.
//
// weight is not a score to be summed into a number. It orders the display, so
// a measured record with two thousand samples sits above a single headline.

// What price is doing, and whether that has ever meant anything here.
function technical(a) {
  if (!a?.evidence?.length) return null;
  const priced = a.evidence.filter(e => e.dir && e.base && tellsUsSomething(e.base));
  const any = a.evidence.filter(e => e.dir);
  const use = priced.length ? priced : any;
  if (!use.length) return null;

  const up = use.filter(e => e.dir === 'up').length;
  const dn = use.filter(e => e.dir === 'down').length;
  if (up === dn) {
    return { leg: 'technical', dir: null, weight: 3,
      headline: 'price is saying both things at once',
      detail: `${up} bullish and ${dn} bearish signals on the chart — no directional read` };
  }
  const dir = up > dn ? 'up' : 'down';
  const lead = use.find(e => e.dir === dir);

  // Only a record that actually says something gets quoted. Without this the
  // leg printed "strong hammer on D — 33% went its way against 59.3% for the
  // market" underneath an up arrow, on six occurrences. Six occurrences
  // establish nothing, and the numbers read as evidence against the very arrow
  // they were sitting under.
  const rec = lead?.base && tellsUsSomething(lead.base) ? lead.base : null;
  const says = rec ? verdictOf(rec) : null;

  // And a record that IS significant and says this setup fails is not support
  // for the signal — it is the strongest thing on the card pointing the other
  // way. The leg stops voting and says so, rather than carrying the chart's
  // direction with the record's contradiction printed underneath it.
  if (says === 'fails') {
    return {
      leg: 'technical', dir: null, weight: 5,
      headline: `${lead.label}, and the record says it fails here`,
      detail: `${rec.n} prior occurrences${rec.stops
        ? `: ${rec.stops.expR}R a trade against ${rec.stops.baseExpR}R for a random entry`
        : `: ${rec.win}% went its way against ${rec.baseWin ?? 50}% for the market`}`
        + ' — the chart and its own history disagree',
    };
  }

  return {
    leg: 'technical', dir, weight: rec ? 5 : 3,
    headline: lead.label,
    detail: rec
      ? `${rec.n} prior occurrences${rec.stops
          ? `, ${rec.stops.expR}R a trade against ${rec.stops.baseExpR}R for a random entry`
          : `, ${rec.win}% went its way against ${rec.baseWin ?? 50}% for the market`}`
      : 'nothing measured behind it — the shape is on the chart and its history says nothing either way',
  };
}

// Only real currency and commodity codes. currenciesOf returns the base ticker
// too for a perp — DOT/USDT gives USD and DOT — which is right for matching and
// wrong to print, because "2 stories on USD/DOT" reads as though somebody is
// writing about DOT when they are writing about the dollar.
const CODE = /^(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|CNY|XAU|XAG|OIL)$/;
const printable = ccy => ccy.filter(c => CODE.test(c));

// Where the big players are, from the COT percentile the feed publishes.
//
// This used to vote. A reading above the 85th percentile was called "crowded
// long — the side that unwinds badly" and counted as a bearish leg, which on
// US500 produced a card reading "split — technical say up, big players say
// down". That sentence was trading folklore. I wrote it here, as a finding,
// on instruments where nobody had measured it — in the feature built to stop
// exactly that.
//
// It has since been measured: bot/cot-study.json, thirteen instruments, three
// years of weekly filings, forward outcomes at one, two, four and eight weeks
// against what each instrument did from every other week, entered at the
// Friday release rather than the Tuesday report, consecutive crowded weeks
// counted as one episode. Thirty-seven crowded-long episodes and forty
// crowded-short. The largest z anywhere in it is 0.82 against a corrected bar
// of 3.08, and stopped expectancy sits between −0.25R and +0.16R.
//
// So the number is real and what follows it is not distinguishable from the
// market. It stays on the card as context, because "positioning is stretched"
// is a true statement about the world, and it no longer points anywhere or
// counts toward agreement.
//
// The threshold is 90/10 rather than 85/15 because that is what was actually
// tested; flagging at 85 and testing at 90 would be citing a measurement of a
// different thing.
function institutional(rec) {
  const p = rec?.state?.posnPct;
  const wk = rec?.state?.posnWeeks;
  if (p == null || !wk) return null;
  const yrs = Math.round(wk / 52);
  if (p >= 90 || p <= 10) return { leg: 'big players', dir: null, weight: 2,
    headline: `positioning is ${p >= 90 ? 'stretched long' : 'stretched short'} — `
      + `${p >= 90 ? `top ${100 - p}%` : `bottom ${p}%`} of ${yrs} years`,
    detail: 'measured across 13 instruments: what follows an extreme is '
      + 'indistinguishable from what the market does anyway' };
  return { leg: 'big players', dir: null, weight: 1,
    headline: `positioning is mid-range (${p}th percentile)`,
    detail: `nothing stretched about it against ${yrs} years` };
}

// Retail against institutional. The only genuine sentiment reading here, and it
// only earns a line when the two sides actually disagree — when they agree it
// is not a contrarian signal, it is just a crowd.
function sentiment(sd) {
  if (!sd) return null;
  if (!sd.opposed) return { leg: 'sentiment', dir: null, weight: 1,
    headline: `retail is ${sd.retailLongPct}% long and the big players are on the same side`,
    detail: 'no disagreement to trade against' };
  const dir = sd.retailLong ? 'down' : 'up';
  return {
    leg: 'sentiment', dir, weight: sd.crowded ? 4 : 2,
    headline: `retail is ${sd.retailLongPct}% ${sd.retailLong ? 'long' : 'short'} against the big players`,
    detail: sd.crowded
      ? 'crowded and opposed — the configuration that resolves against the crowd'
      : 'opposed but not crowded',
  };
}

// The fundamental leg, from macroDriversFor: series correlated against this
// instrument's own closes, only what clears the noise floor. If gold has
// stopped tracking real yields — and it does, for months — nothing appears.
function fundamental(drivers) {
  const top = drivers?.drivers?.[0];
  if (!top) return null;
  // r is the correlation against the instrument; the series' own recent
  // direction decides which way that points.
  const rising = top.change > 0;
  const dir = (top.r > 0) === rising ? 'up' : 'down';
  return {
    leg: 'fundamental', dir, weight: 4,
    headline: `${top.label} ${rising ? 'rising' : 'falling'}`,
    // The series' own note is deliberately left out. MACRO_SERIES describes
    // what each series means in general — the real-yield note says "gold's
    // biggest macro driver" — and printed under DOT/USDT that is a sentence
    // about a different instrument. The correlation IS the claim here, and it
    // was measured against this instrument's own closes.
    detail: `${top.level}${top.unit || ''} now, ${top.change > 0 ? 'up' : 'down'} `
      + `${Math.abs(top.change)} over the window · tracks this instrument at r=${top.r} across ${top.n} days`,
  };
}

// Headlines that name this instrument's currencies. A count and the latest, not
// a sentiment score: nothing here can read a headline's tone honestly, and
// pretending otherwise would be the invented number this whole file avoids.
function headlines(news, ccy, now) {
  const mine = (news?.headlines || []).filter(h =>
    (h.ccy || []).some(c => ccy.includes(c)) && (!h.at || now - h.at < 36 * 3600e3));
  if (!mine.length) return null;
  const latest = mine[0];
  const who = printable(ccy);
  return {
    leg: 'news', dir: null, weight: 2,
    headline: `${mine.length} recent ${mine.length === 1 ? 'story' : 'stories'} on ${who.join('/') || 'this market'}`,
    detail: latest.title,
    items: mine.slice(0, 4),
  };
}

// What is scheduled that can undo any of the above.
function scheduled(news, ccy, now, holdMs) {
  const hits = (news?.calendar || [])
    .filter(e => e.impact === 'high' && ccy.includes(e.country)
                 && e.at > now && e.at < now + (holdMs || 7 * 86400e3))
    .sort((x, y) => x.at - y.at);
  if (!hits.length) return null;
  const n = hits[0];
  const hrs = (n.at - now) / 3600e3;
  return {
    leg: 'event risk', dir: null, weight: 3,
    headline: `${n.country} ${n.title} in ${hrs < 24 ? `${Math.round(hrs)}h` : `${Math.round(hrs / 24)}d`}`,
    detail: hits.length > 1 ? `${hits.length} high-impact releases inside the window` : 'one high-impact release inside the window',
    imminent: hrs < 2,
  };
}

// What moves before this does. The feed measures lead-lag daily; a leader that
// has already moved is the closest thing here to an early warning.
function related(rec) {
  const list = rec?.leaders?.list;
  if (!list?.length) return null;
  const top = list[0];
  // The sign is the whole meaning. A lead correlation of −0.29 does not mean
  // "CRWD leads this" in any useful sense — it means this tends to go the other
  // way a day later, and printing "leads this by 1 day, correlation −0.29" left
  // the reader to notice the minus sign and work that out.
  const inverse = top.r < 0;
  return {
    leg: 'related', dir: null, weight: 1,
    headline: inverse
      ? `${top.sym} moves this the opposite way a day later`
      : `${top.sym} leads this by ${top.lag} day${top.lag === 1 ? '' : 's'}`,
    detail: `${Math.abs(top.r)} correlation at a ${top.lag}-day lag against ${Math.abs(top.r0)} same-day`
      + `${list.length > 1 ? ` · also ${list.slice(1, 3).map(x => x.sym).join(', ')}` : ''}`,
  };
}

// ── The read ─────────────────────────────────────────────────────────────────

export function instrumentRead(sym, rec, a, {
  news = null, macro = null, smart = null, now = Date.now(), holdMs = null,
} = {}) {
  if (!rec) return null;
  const ccy = currenciesOf(sym, rec.cls) || [];

  const legs = [
    technical(a),
    institutional(rec),
    sentiment(smart),
    fundamental(macro),
    headlines(news, ccy, now),
    scheduled(news, ccy, now, holdMs),
    related(rec),
  ].filter(Boolean).sort((x, y) => y.weight - x.weight);

  const directional = legs.filter(l => l.dir);
  const up = directional.filter(l => l.dir === 'up');
  const dn = directional.filter(l => l.dir === 'down');

  // The whole point of combining. Not a score — a count, and the names of what
  // is on each side, because "three things agree" is only worth knowing if you
  // can see which three and disagree with one of them.
  let verdict, dir = null;
  if (!directional.length) verdict = 'nothing here points anywhere';
  else if (up.length && dn.length) {
    verdict = `split — ${up.map(l => l.leg).join(' and ')} say up, `
            + `${dn.map(l => l.leg).join(' and ')} say down`;
  } else {
    dir = up.length ? 'up' : 'down';
    const side = up.length ? up : dn;
    verdict = side.length === 1
      ? `only ${side[0].leg} points ${dir}, and nothing contradicts it`
      : `${side.length} of ${legs.length} agree ${dir} — ${side.map(l => l.leg).join(', ')}`;
  }

  return {
    sym, ccy, legs, dir,
    agree: Math.max(up.length, dn.length),
    conflict: up.length > 0 && dn.length > 0,
    verdict,
    // Named separately because it overrides rather than votes: a release inside
    // the window can undo every other leg regardless of which way they point.
    risk: legs.find(l => l.leg === 'event risk') || null,
  };
}

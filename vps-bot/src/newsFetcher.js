'use strict';
// vps-bot/src/newsFetcher.js
// Calendar and headlines, fetched where there is no CORS and nothing sleeps.
//
// The app fetched both from the browser, through a chain of three public CORS
// proxies it does not control. That fails often, and more importantly it only
// exists while a tab is open — so news could never be part of a screen that is
// supposed to be current at four in the morning.
//
// Node has no CORS. The bot is already running, already talks to GitHub, and
// already publishes the feed the app reads. News goes the same way.
//
// Everything here degrades rather than throws. A calendar that is briefly
// unreachable must leave the last good copy in place: a screen saying "no
// events today" when there is an NFP in an hour is worse than one saying
// "calendar 3 hours old".

const fetch = require('node-fetch');

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

// Three of the original six were failing, silently, for long enough that the
// screen simply looked quiet — a feed that returns nothing and a feed that is
// blocked are indistinguishable unless the failure is recorded, which it now
// is, with the status code that caused it.
//
// FXStreet, DailyFX and CNBC's id-based endpoint are all behind bot protection
// that a plain fetch does not get past. They are kept, because a block can lift
// and the cost of trying is one request, but each now has a working alternative
// alongside it rather than a silent hole.
const RSS = [
  { name: 'ForexLive',   url: 'https://www.forexlive.com/feed/news' },
  { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
  { name: 'Investing',   url: 'https://www.investing.com/rss/news_25.rss' },
  // Replacements for the three that stopped answering.
  { name: 'Investing FX',  url: 'https://www.investing.com/rss/news_1.rss' },
  { name: 'Investing Cmdty', url: 'https://www.investing.com/rss/news_11.rss' },
  { name: 'CNBC Markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664' },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
  // Kept on trial; they have been blocked, and a block can lift.
  { name: 'FXStreet',    url: 'https://www.fxstreet.com/rss/news' },
  { name: 'DailyFX',     url: 'https://www.dailyfx.com/feeds/market-news' },
];

const NEWS_PATH = 'bot/news.json';
const HISTORY_PATH = 'bot/calendar-history.json';
const MAX_HEADLINES = 60;
const KEEP_CALENDAR_DAYS = 8;

// ── The surprise ─────────────────────────────────────────────────────────────
//
// "There is a CPI at 13:30" is a diary entry. "CPI came in 0.3 hotter than
// forecast" is the thing that moved the market. The second cannot be computed
// without the first being kept, which is why the actual is captured above.
//
// Values arrive as display strings — "0.2%", "250K", "-1.2%", "3.40M" — so
// they have to be read as numbers before they can be compared.
// The calendar sends an unreleased value as an empty string, not as a missing
// field. `?? null` does not catch that, so every archived row came back with
// actual:"" — which reads as present, which meant the fill pass skipped all 66
// of them and no actual would ever have been written. Same failure as the
// original archive bug wearing different clothes: a condition that looks like
// it fires and never does.
const blank = v => (v == null || String(v).trim() === '') ? null : v;

function numOf(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/,/g, '').replace(/%$/, '');
  const m = t.match(/^(-?\d*\.?\d+)\s*([KMBT])?$/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] || '').toUpperCase()] || 1;
  return parseFloat(m[1]) * mult;
}

// ── Filling in the actual the calendar never sends ───────────────────────────
//
// The schedule feed carries forecast and previous and nothing else, so the
// surprise could be computed and never was. BLS publishes the released values,
// has no key, and the macro workflow already reaches it — so the numbers arrive
// in public/macro-data.json under `releases` and are joined here by title.
//
// An explicit map, not a fuzzy match. "Core CPI m/m" and "CPI m/m" differ by
// one word and are different series, and a matcher clever enough to pair them
// automatically is clever enough to pair them wrongly.
//
// And US ONLY, which the first version of this forgot. BLS is a United States
// agency; every series below is a US number. Matching on title alone put the US
// unemployment rate onto China's release and the US CPI onto Canada's — the
// archive recorded Canadian CPI as 0.07 against a 0.4% Canadian forecast and
// called it a miss. Every calendar carries the same event names for a dozen
// countries, so a title is not an identifier.
const RELEASE_COUNTRY = 'USD';
const RELEASE_MAP = [
  [/^core cpi m\/m$/i,               'core_cpi_mom'],
  [/^cpi m\/m$/i,                    'cpi_mom'],
  [/^non-?farm employment change$/i, 'nfp'],
  [/^unemployment rate$/i,           'unemployment'],
  [/^average hourly earnings m\/m$/i,'avg_earnings_mom'],
];

// The released value for the month an event covers. A release in March reports
// February, so the reading published on or just before the event date is the
// one it announced — never a later one, which would be a number nobody had.
function releasedValue(title, at, releases, country) {
  if (!releases || !title) return null;
  // The country is not optional. Without it this fills every nation's release
  // with a US number.
  if (country !== RELEASE_COUNTRY) return null;
  const key = RELEASE_MAP.find(([re]) => re.test(title.trim()))?.[1];
  const series = key && releases[key];
  if (!Array.isArray(series) || !series.length) return null;
  let best = null;
  for (const row of series) {
    const t = Date.parse(row.date + 'T00:00:00Z');
    // The series is dated by the month it covers, which is before the release.
    if (Number.isFinite(t) && t <= at && (!best || t > Date.parse(best.date + 'T00:00:00Z'))) best = row;
  }
  return best ? best.val : null;
}

function withSurprise(e) {
  const a = numOf(e.actual), f = numOf(e.forecast), p = numOf(e.previous);
  if (a == null) return e;
  const out = { ...e, actualNum: a };
  if (p != null) out.vsPrevious = +(a - p).toFixed(4);
  if (f == null) return out;
  out.forecastNum = f;
  out.surprise = +(a - f).toFixed(4);
  // A relative reading, because 0.1 is enormous on a rate decision and noise on
  // a payrolls number. Guarded: forecasts of exactly zero are common.
  if (Math.abs(f) > 1e-9) out.surprisePct = +(((a - f) / Math.abs(f)) * 100).toFixed(1);
  out.beat = out.surprise > 0 ? 'above' : out.surprise < 0 ? 'below' : 'inline';
  return out;
}

// A currency mentioned in a headline is the link between a story and an
// instrument. Matching on the code alone puts every "CAD" in "Canada" and
// every "AUD" in "audit", so each currency carries the words that actually
// appear in financial copy.
const CURRENCY_WORDS = {
  USD: ['dollar', 'greenback', 'fed', 'fomc', 'powell', 'treasury', 'nfp', 'payrolls'],
  EUR: ['euro', 'ecb', 'lagarde', 'eurozone', 'bund'],
  GBP: ['pound', 'sterling', 'boe', 'gilt', 'bailey'],
  JPY: ['yen', 'boj', 'ueda', 'japan'],
  CHF: ['franc', 'snb', 'swiss'],
  AUD: ['aussie', 'rba', 'australia'],
  NZD: ['kiwi', 'rbnz', 'new zealand'],
  CAD: ['loonie', 'boc', 'canada'],
  XAU: ['gold', 'bullion'],
  XAG: ['silver'],
  OIL: ['oil', 'crude', 'wti', 'brent', 'opec'],
  BTC: ['bitcoin', 'crypto'],
};

const strip = s => String(s || '')
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? strip(m[1]) : '';
};

// Deliberately not an XML parser. These feeds are six known publishers with
// stable shapes; a dependency that can throw on a malformed entity would take
// the whole news pass down for one bad character in one headline.
function parseRSS(xml, source) {
  const out = [];
  const blocks = String(xml || '').split(/<item[\s>]/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/item>/i)[0];
    const title = tag(block, 'title');
    if (!title) continue;
    const dateStr = tag(block, 'pubDate') || tag(block, 'dc:date') || tag(block, 'published');
    const t = Date.parse(dateStr);
    out.push({
      title,
      link: tag(block, 'link'),
      source,
      at: Number.isFinite(t) ? t : Date.now(),
    });
  }
  return out;
}

// Names that contain a currency word and have nothing to do with the currency.
// Checked before the words are, because "Goldman Sachs raises S&P target" was
// arriving on the gold card as though it were about bullion, and "Canada Goose
// shares fall 8%" as though it were about the loonie.
const NOT_ABOUT = [
  ['goldman', 'XAU'], ['golden', 'XAU'], ['gold coast', 'XAU'], ['goldmine', 'XAU'],
  ['silver lake', 'XAG'], ['silverstone', 'XAG'],
  ['canada goose', 'CAD'],
  ['boeing', 'GBP'],           // 'boe'
  ['audit', 'AUD'], ['audio', 'AUD'], ['audience', 'AUD'],
  ['oilers', 'OIL'],
];

// Which currencies a headline is about. Empty means general market news,
// which is still worth showing but should not attach itself to an instrument.
//
// Matched on WORD BOUNDARIES. Plain substring matching put every Goldman story
// on gold and every Canada Goose story on the Canadian dollar — and because the
// match also drives which instrument's card a headline appears on, a mismatched
// headline is not merely untidy, it is evidence attached to the wrong market.
function currenciesIn(text) {
  const low = String(text).toLowerCase();
  const blocked = new Set(NOT_ABOUT.filter(([n]) => low.includes(n)).map(([, c]) => c));
  const hit = new Set();
  for (const [code, words] of Object.entries(CURRENCY_WORDS)) {
    if (blocked.has(code)) continue;
    // \b on both sides, with the word escaped — several entries contain spaces
    // ("new zealand") and one contains a dot in other locales.
    if (words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low))) {
      hit.add(code);
    }
  }
  return [...hit];
}

async function getText(url, timeout = 15000) {
  const res = await fetch(url, {
    timeout,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ForexPro/1.0)' },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

class NewsFetcher {
  constructor({ github, log }) {
    this.github = github;
    this.log = log || (() => {});
    this.sha = null;
    this.historySha = null;
    this.last = null;         // last good payload
    this.lastRunAt = 0;
  }

  // Released values, published by the macro workflow into the repo the bot
  // already has checked out. Re-read each pass so a fresh git pull is picked up
  // without a restart; a missing or unreadable file simply means no actuals.
  _releases() {
    try {
      const p = require('path').join(__dirname, '..', '..', 'public', 'macro-data.json');
      return JSON.parse(require('fs').readFileSync(p, 'utf8')).releases || null;
    } catch { return null; }
  }

  async _calendar() {
    const releases = this._releases();
    const raw = await getText(CALENDAR_URL);
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error('calendar was not a list');
    const cutoff = Date.now() - 24 * 3600e3;
    return list
      .map(e => {
        const at = Date.parse(e.date);
        // The ACTUAL, if the source carries it.
        //
        // This used to map six fields by hand and drop everything else, so a
        // released number was thrown away the moment it arrived. Fifty-five
        // past events were stored and not one recorded what had happened —
        // the screen could say CPI was coming and never say what CPI was,
        // which is the only part of a release that moves anything.
        //
        // Anything the source provides under another name is kept in `extra`
        // rather than discarded, so a field appearing later needs no code
        // change to be visible.
        const known = new Set(['title', 'country', 'impact', 'date', 'forecast', 'previous', 'actual']);
        const extra = {};
        for (const [k, v] of Object.entries(e)) {
          if (!known.has(k) && v != null && v !== '') extra[k] = v;
        }
        const row = {
          title: strip(e.title),
          country: e.country,            // currency code, e.g. USD
          impact: String(e.impact || '').toLowerCase(),   // high | medium | low
          at: Number.isFinite(at) ? at : null,
          forecast: e.forecast || '',
          previous: e.previous || '',
          actual: e.actual || '',
        };
        // Only for events that have already happened, and only when the source
        // left the field empty — a value the calendar does provide is always
        // preferred to one reconstructed here.
        if (!row.actual && row.at && row.at < Date.now()) {
          const v = releasedValue(row.title, row.at, releases, row.country);
          if (v != null) { row.actual = String(v); row.actualFrom = 'BLS'; }
        }
        if (Object.keys(extra).length) row.extra = extra;
        return withSurprise(row);
      })
      .filter(e => e.at && e.at > cutoff && e.at < Date.now() + KEEP_CALENDAR_DAYS * 86400e3)
      .sort((a, b) => a.at - b.at);
  }

  // Every released event, kept forever, in a file of its own.
  //
  // The live calendar holds eight days because that is all a screen needs. The
  // question worth answering — "the last twelve times CPI came in hot, what did
  // EUR/USD do" — needs years, and the only way to have years later is to start
  // keeping them now. Merged by a stable key so a re-fetch updates a row rather
  // than duplicating it: an event's actual appears minutes after the event
  // itself, so the same row is written twice by design.
  async _archive(calendar, releases = null) {
    // Everything on the calendar, not only what has already printed.
    //
    // This used to filter for events that were BOTH past AND carried an
    // actual. The calendar is a schedule: it lists what is coming, carries a
    // forecast while the event is upcoming, and drops the event once it has
    // happened. So the two conditions were never true at the same moment and
    // the file has been empty since the day it was created — checked on the
    // live feed: 66 events, 0 in the past, 0 with an actual.
    //
    // The consequence is not an empty file, it is a permanently unanswerable
    // question. Surprise is actual minus forecast, and the forecast only exists
    // BEFORE the event. Waiting until afterwards to record anything throws away
    // the half that can never be recovered.
    //
    // So every event is written while it is still scheduled, forecast and all,
    // and the actual is filled in on a later pass once it exists.
    const now = Date.now();
    // No early return on an empty batch. The cleanup below has to run even when
    // there is nothing to add — and once the country check was in place there
    // never was, so the purge sat behind a guard it could not get past and the
    // four bad rows stayed exactly where they were.
    let prev = [];
    try {
      const cur = await this.github.readJSON(HISTORY_PATH).catch(() => null);
      if (Array.isArray(cur?.content?.events)) prev = cur.content.events;
      this.historySha = cur?.sha || null;
    } catch { /* first run, or unreadable — start fresh rather than lose today */ }

    // Drop anything the country-blind version of this wrote. A US figure filed
    // against a Canadian release is not a row to keep and correct later; it is
    // a fabricated observation, and leaving it in would poison the first study
    // that ever reads this file.
    const before = prev.length;
    prev = prev.filter(e => !(e.actualFrom === 'BLS' && e.country !== RELEASE_COUNTRY));

    // Keyed to the DAY, not the minute. The calendar restates its own
    // timestamps — the same Canadian Core CPI arrived at 12:30 and again at
    // 12:32 and was archived twice, because an exact-millisecond key treats a
    // two-minute correction as a different event.
    const keyOf = e => `${new Date(e.at).toISOString().slice(0, 10)}|${e.country}|${e.title}`;
    const byKey = new Map(prev.map(e => [keyOf(e), e]));

    let added = 0, filled = 0;
    for (const e of calendar) {
      const k = keyOf(e);
      const was = byKey.get(k);
      if (!was) {
        added++;
        byKey.set(k, {
          at: e.at, country: e.country, title: e.title, impact: e.impact,
          // The half that cannot be recovered later. Captured now, while the
          // event is still in the future and the calendar is still carrying it.
          forecast: blank(e.forecast),
          previous: blank(e.previous),
          seenAt: new Date().toISOString(),
          actual: blank(e.actual),
        });
        continue;
      }
      // Never overwrite a forecast that was captured before the event with
      // whatever the calendar says about it afterwards — a restated forecast is
      // not the number the market was positioned against.
      // Normalised on every pass, not only on insert: rows written by the
      // first version of this carry "" and would otherwise never be filled.
      was.forecast = blank(was.forecast) ?? blank(e.forecast);
      was.previous = blank(was.previous) ?? blank(e.previous);
      if (blank(was.actual) == null && blank(e.actual) != null) { was.actual = blank(e.actual); filled++; }
      else was.actual = blank(was.actual);
    }

    // Fill actuals from the BLS series the macro workflow publishes, for events
    // that have passed and that the calendar never gave a result for — which is
    // all of them. Guarded by country: BLS is a US agency, and the first version
    // of this filed the US CPI against Canada's release.
    for (const e of byKey.values()) {
      if (blank(e.actual) != null || e.at > now) continue;
      const v = releasedValue(e.title, e.at, releases, e.country);
      if (v == null) continue;
      e.actual = v;
      e.actualFrom = 'BLS';
      filled++;
    }

    // Surprise, wherever both halves are now present. This is the only number
    // on the row that moves anything, and it exists solely because the forecast
    // was captured before the event.
    for (const e of byKey.values()) {
      if (blank(e.actual) == null || blank(e.forecast) == null || e.surprise != null) continue;
      const a = numOf(e.actual), f = numOf(e.forecast);
      if (a == null || f == null) continue;
      e.surprise = +(a - f).toFixed(4);
      e.beat = e.surprise > 0 ? 'above' : e.surprise < 0 ? 'below' : 'inline';
    }

    const purged = before - prev.length;

    // Bounded. A year of every scheduled event is enough to measure against and
    // small enough to ship; without this the file grows forever.
    //
    // Computed BEFORE the write guard, not after. Putting it after is how the
    // original version of this file ended up with a cleanup that could never
    // run: the guard returned on a quiet pass and the stale rows sat there
    // being quietly wrong. Aging a row out is itself a change worth writing.
    const cutoff = now - 365 * 86400e3;
    let dropped = 0;
    const events = [...byKey.values()]
      .filter(e => { const keep = e.at >= cutoff; if (!keep) dropped++; return keep; })
      .sort((a, b) => a.at - b.at);

    if (!added && !filled && !purged && !dropped) return;   // genuinely nothing to do

    const what = [added && `+${added}`, filled && `${filled} filled`,
                  purged && `-${purged} bad`, dropped && `-${dropped} aged out`]
      .filter(Boolean).join(', ');
    try {
      this.historySha = await this.github.writeJSON(HISTORY_PATH,
        { version: 1, updatedAt: new Date().toISOString(), events },
        `bot: calendar history (${what})`, this.historySha);
      this.log(`News: archive ${what}, ${events.length} total`);
    } catch (err) {
      this.log(`News: could not archive (${err.message})`);
      this.historySha = null;
    }
  }

  async _headlines() {
    const settled = await Promise.allSettled(
      RSS.map(async f => parseRSS(await getText(f.url), f.name)),
    );
    const items = [];
    const ok = [], failed = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled' && s.value.length) { ok.push(RSS[i].name); items.push(...s.value); }
      // The reason, not just the name. "FXStreet failed" is a fact nobody can
      // act on; "FXStreet 403" says it is being blocked and "FXStreet 0 items"
      // says the parser is the problem, and those need opposite fixes.
      else failed.push({
        name: RSS[i].name,
        why: s.status === 'rejected' ? (s.reason?.message || 'error') : 'no items parsed',
      });
    });
    // Same story from three outlets is one story. Dedupe on the headline text
    // before truncating, or the list is six versions of whatever just broke.
    const seen = new Set();
    const unique = [];
    for (const it of items.sort((a, b) => b.at - a.at)) {
      const key = it.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ ...it, ccy: currenciesIn(it.title) });
      if (unique.length >= MAX_HEADLINES) break;
    }
    return { items: unique, ok, failed };
  }

  async run() {
    if (Date.now() - this.lastRunAt < 15 * 60e3) return;
    this.lastRunAt = Date.now();

    const [cal, news] = await Promise.allSettled([this._calendar(), this._headlines()]);

    // A partial failure keeps the previous half rather than publishing a gap.
    const calendar = cal.status === 'fulfilled' ? cal.value : (this.last?.calendar || []);
    const headlines = news.status === 'fulfilled' ? news.value.items : (this.last?.headlines || []);
    if (cal.status === 'rejected')  this.log(`News: calendar failed (${cal.reason?.message}) — keeping previous`);
    if (news.status === 'rejected') this.log(`News: headlines failed (${news.reason?.message}) — keeping previous`);
    if (!calendar.length && !headlines.length) return;

    // Start keeping released events now, so the question "what did EUR/USD do
    // the last twelve times CPI ran hot" is answerable in a few months rather
    // than never.
    // The BLS actuals come from the same file the calendar pass reads, so the
    // archive can fill in results the calendar itself never carries.
    await this._archive(calendar, this._releases())
      .catch(e => this.log(`News: archive failed (${e.message})`));

    const payload = {
      calendar,
      headlines,
      sources: news.status === 'fulfilled' ? news.value.ok : [],
      failed:  news.status === 'fulfilled' ? news.value.failed : [],
      // Separate from updatedAt: the app must be able to tell "published ten
      // minutes ago from a cached copy" from "actually fetched ten minutes ago".
      calendarAt:  cal.status === 'fulfilled' ? new Date().toISOString() : (this.last?.calendarAt || null),
      headlinesAt: news.status === 'fulfilled' ? new Date().toISOString() : (this.last?.headlinesAt || null),
      updatedAt: new Date().toISOString(),
    };
    this.last = payload;

    try {
      this.sha = await this.github.writeJSON(NEWS_PATH, payload,
        `bot: news (${calendar.length} events, ${headlines.length} headlines)`, this.sha);
      const high = calendar.filter(e => e.impact === 'high' && e.at > Date.now()).length;
      this.log(`News: ${headlines.length} headlines, ${calendar.length} events (${high} high-impact upcoming)`);
    } catch (e) {
      this.log(`News: could not publish (${e.message})`);
      this.sha = null;      // force a SHA re-read next time
    }
  }
}

module.exports = { NewsFetcher, NEWS_PATH, HISTORY_PATH, parseRSS, currenciesIn,
                   CURRENCY_WORDS, numOf, withSurprise, NOT_ABOUT, releasedValue, RELEASE_MAP };

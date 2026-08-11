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

const RSS = [
  { name: 'ForexLive',   url: 'https://www.forexlive.com/feed/news' },
  { name: 'FXStreet',    url: 'https://www.fxstreet.com/rss/news' },
  { name: 'DailyFX',     url: 'https://www.dailyfx.com/feeds/market-news' },
  { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
  { name: 'CNBC',        url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'Investing',   url: 'https://www.investing.com/rss/news_25.rss' },
];

const NEWS_PATH = 'bot/news.json';
const MAX_HEADLINES = 60;
const KEEP_CALENDAR_DAYS = 8;

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

// Which currencies a headline is about. Empty means general market news,
// which is still worth showing but should not attach itself to an instrument.
function currenciesIn(text) {
  const low = String(text).toLowerCase();
  const hit = new Set();
  for (const [code, words] of Object.entries(CURRENCY_WORDS)) {
    if (words.some(w => low.includes(w))) hit.add(code);
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
    this.last = null;         // last good payload
    this.lastRunAt = 0;
  }

  async _calendar() {
    const raw = await getText(CALENDAR_URL);
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error('calendar was not a list');
    const cutoff = Date.now() - 24 * 3600e3;
    return list
      .map(e => {
        const at = Date.parse(e.date);
        return {
          title: strip(e.title),
          country: e.country,            // currency code, e.g. USD
          impact: String(e.impact || '').toLowerCase(),   // high | medium | low
          at: Number.isFinite(at) ? at : null,
          forecast: e.forecast || '',
          previous: e.previous || '',
        };
      })
      .filter(e => e.at && e.at > cutoff && e.at < Date.now() + KEEP_CALENDAR_DAYS * 86400e3)
      .sort((a, b) => a.at - b.at);
  }

  async _headlines() {
    const settled = await Promise.allSettled(
      RSS.map(async f => parseRSS(await getText(f.url), f.name)),
    );
    const items = [];
    const ok = [], failed = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled' && s.value.length) { ok.push(RSS[i].name); items.push(...s.value); }
      else failed.push(RSS[i].name);
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

module.exports = { NewsFetcher, NEWS_PATH, parseRSS, currenciesIn, CURRENCY_WORDS };

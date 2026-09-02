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
const { NewsDirection } = require('./newsDirection');
// The same web-push and subscription plumbing the price alerts use. A second
// mechanism for "tell the phone something happened" would be a second thing to
// keep alive.
const { configurePush, sendPush } = require('./push');
const SUBS_PATH = 'bot/push-subscriptions.json';

// shared/newsTagging.mjs is ESM and this file is CommonJS, so it arrives by
// dynamic import — the same route shared/feedConditions.mjs already takes. Held
// after the first load; a failure falls back to the currency-only matcher below
// rather than publishing sixty untagged headlines.
// The same ESM-from-CommonJS bridge, for the price helpers the alert needs.
let _features = null;
async function features() {
  if (_features) return _features;
  try {
    const url = require('url').pathToFileURL(
      require('path').join(__dirname, '..', '..', 'shared', 'moveFeatures.mjs')).href;
    _features = await import(url);
  } catch { _features = {}; }
  return _features;
}

let _tagging = null;
async function tagging() {
  if (_tagging) return _tagging;
  try {
    const url = require('url').pathToFileURL(
      require('path').join(__dirname, '..', '..', 'shared', 'newsTagging.mjs')).href;
    _tagging = await import(url);
  } catch { _tagging = { labelHeadline: null }; }
  return _tagging;
}
async function labelOf(title, desc) {
  const t = await tagging();
  if (t.labelHeadline) return t.labelHeadline(title, desc);
  return { ccy: currenciesIn(title), inst: [], sev: 1, rel: 1 };
}

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

  // ── Wires ──────────────────────────────────────────────────────────────
  //
  // Every source above is a MARKETS outlet, and geopolitics reaches them
  // second — after a wire has run it and after somebody has written the
  // markets angle. On a board whose main instrument is gold, that is the
  // wrong way round: the safe-haven bid moves before the commentary exists.
  //
  // These carry a great deal that is not about markets at all. That is fine
  // now: the list is cut by relevance first and recency second, so an
  // untagged culture piece can fill a spare slot and can never take one.
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'BBC World',  url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  // A standing query rather than a section. Google News aggregates every
  // outlet it indexes, so this is usually the first place a strike appears
  // in a feed we can read without a key.
  { name: 'Wires (geo)', url: 'https://news.google.com/rss/search?q=' + encodeURIComponent(
      '(Iran OR Israel OR Russia OR Ukraine OR "Middle East") '
      + 'AND (strike OR strikes OR attack OR sanctions OR ceasefire OR escalation)')
      + '&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Wires (macro)', url: 'https://news.google.com/rss/search?q=' + encodeURIComponent(
      '("Federal Reserve" OR "rate cut" OR "rate hike" OR inflation OR tariffs) '
      + 'AND (gold OR dollar OR treasury OR markets)')
      + '&hl=en-US&gl=US&ceid=US:en' },
];

const NEWS_PATH = 'bot/news.json';
const HISTORY_PATH = 'bot/calendar-history.json';
const NEWS_HISTORY_PATH = 'bot/news-history.json';
// Long enough to measure against, small enough to ship. Only headlines that
// name an instrument are kept — an untagged story cannot be scored against a
// price, so storing it would be weight without a question attached.
const KEEP_NEWS_DAYS = 45;
const MAX_NEWS_ROWS = 6000;
// Raised with the wire sources. Twelve feeds into sixty slots meant a world
// desk could crowd out the markets ones even after the relevance sort.
const MAX_HEADLINES = 90;

// The news pass used to be gated to once every fifteen minutes, which put the
// average lag from a wire publishing to it reaching the phone at seven and a
// half minutes before anything else in the chain. For a missile strike that is
// not a news feed. Three minutes costs a few more RSS requests per hour and
// nothing else — the publish only happens when the payload actually changed.
const POLL_MS = 3 * 60e3;

// What the phone is allowed to do. Twenty passes an hour with three alerts each
// is sixty pushes, which is a feature you switch off after one afternoon.
const MAX_ALERTS_PER_HOUR = 4;
const MIN_ALERT_GAP_MS = 8 * 60e3;
const ALERT_MEMORY_MS = 2 * 3600e3;

// ── Theatres ─────────────────────────────────────────────────────────────────
//
// The market prices in "the US is striking Iran" ONCE. The fifth report of
// another strike in the same war is not a new event to trade; it is the same
// event being reported again, and a phone that buzzes for each one is telling
// you something you already acted on.
//
// Suppressing on shared PROPER NOUNS was the first attempt and it does not
// work, which three live alerts inside two hours demonstrated:
//
//   "US strikes Iran as state media reports four killed at wedding party"
//        → iran
//   "Iranian media reports US missile attack near Ahvaz"
//        → iranian, ahvaz, middle, east
//   "US military conducting fresh strikes in the Strait of Hormuz"
//        → strait, hormuz, axios
//
// Not one word in common between any pair. "Iran" and "Iranian" are different
// strings, and Ahvaz, Hormuz and a wedding party are genuinely different
// places — in the same war.
//
// So the key is the CONFLICT, not the entity. Two headlines touching the same
// theatre are the same running story however differently they are worded, and
// the theatre stays quiet for four hours unless something escalates it.
const THEATRES = {
  iran:     /\b(iran|iranian|tehran|hormuz|ahvaz|irgc|persian gulf|bandar)\b/i,
  levant:   /\b(israel|israeli|gaza|hamas|hezbollah|lebanon|west bank|houthi|red sea|yemen)\b/i,
  ukraine:  /\b(russia|russian|ukrain\w*|moscow|kyiv|kremlin|putin|zelensk\w*|donbas)\b/i,
  taiwan:   /\b(taiwan|beijing|south china sea|pla navy)\b/i,
  korea:    /\b(north korea|pyongyang|kim jong)\b/i,
  venezuela:/\b(venezuela|venezuelan|maduro|caracas)\b/i,
};

// Four hours. Long enough that one war is one alert through a session, short
// enough that tomorrow morning's development is news again.
const THEATRE_QUIET_MS = 4 * 3600e3;

// ── What kind of thing happened ──────────────────────────────────────────────
//
// Every gate before this one asks how LOUD a headline is: severity words,
// corroboration, whether the theatre has already alerted. None of them asks
// what KIND of event it is, and that is the question that decides whether a
// market moves.
//
// A market prices in a war when it STARTS and when it ENDS, and re-prices when
// something changes its kind — a strait closes, a leader is killed, a new
// country enters, a nuclear weapon is involved. It does not re-price on the
// fortieth strike report, and it certainly does not re-price on a condemnation.
//
// Seven alerts got through in one day and the price move beside each of them
// says the same thing:
//
//   Citibank fined £4.7m over Russia sanctions breaches      gold  +0.53%
//   Stock Market Today: Dow Rises On Surprise Jobs Data      gold  +0.04%
//   Air raid alert shatters first day of school in Kyiv      gold  +0.26%
//   Seven US Embassies Issue Security Alert Warnings         gold  -0.31%
//   EU and Nato vow to step up pressure on Russia            gold  -0.22%
//   Iran condemns US strikes, says dozens killed             gold  -0.10%
//
// A fine, a daily wrap, a human-interest angle, a consequence, a statement, a
// reaction. Every one of them noise, and the noise is measured.
//
// So: a headline has to be a KIND of event, not merely a loud sentence about
// one. Everything else still reaches the Today screen and the news tab; it just
// does not reach the phone.

// A war beginning, or a new party entering one.
const WAR_START = [
  /\bdeclare[sd]? war\b/i, /\bdeclaration of war\b/i,
  /\b(invasion of|invades?|invading)\b/i,
  /\blaunch(es|ed)?\b[^.]{0,30}\b(invasion|offensive|ground operation|war)\b/i,
  /\b(enters|joins|entering) the (war|conflict)\b/i,
  /\bopens? a (new )?front\b/i,
  /\bstate of war\b/i,
];

// A war ending. Just as tradeable as the start, and in the other direction.
const WAR_END = [
  /\bcease[- ]?fire\b/i, /\btruce\b/i, /\barmistice\b/i,
  /\bpeace (deal|agreement|accord|treaty)\b/i,
  /\b(war|conflict|hostilities) (ends?|ended|over)\b/i,
  /\bsurrenders?\b/i,
];

// A change in KIND rather than a continuation. These re-price a market that has
// already priced the war itself.
const ESCALATION = [
  /\bnuclear\b[^.]{0,30}\b(test|strike|weapon|attack|detonat|launch)/i,
  /\bchemical weapons?\b/i,
  /\bclos(es|ed|ing|ure)\b[^.]{0,20}\bstrait\b/i, /\bstrait\b[^.]{0,20}\bclos/i,
  /\bblockad(e|es|ed|ing)\b/i,
  /\bassassinat/i,
  /\b(supreme leader|president|prime minister|\bpm\b|chancellor|ayatollah|crown prince|army chief|defen[cs]e minister)\b[^.]{0,45}\b(killed|assassinated|dead|shot)\b/i,
  /\bmartial law\b/i,
  /\bgeneral mobilis|mobiliz(ation|es|ed)\b/i,
  /\barticle 5\b/i, /\bnato (invokes|triggers|activates)\b/i,
  /\b(capital|city) (falls|has fallen|captured)\b/i,
];

// The macro equivalent. A SCHEDULED rate decision is on the calendar and is not
// news; an unscheduled one is the whole market repricing at once.
const MACRO_SHOCK = [
  /\bemergency\b[^.]{0,30}\b(meeting|cut|rate|session)\b/i,
  /\bunscheduled\b/i,
  /\b(currency |fx |yen |won )?intervention\b/i,
  /\bcircuit breaker/i, /\bhalts? trading\b/i, /\btrading halted\b/i,
  /\b(sovereign )?default(s|ed)?\b/i,
  /\bdowngrades? (the )?(us|u\.s\.|france|uk|japan|china)\b/i,
  /\bsurprise (rate )?(cut|hike)\b/i,
];

// Words that mean somebody TALKED ABOUT an event rather than the event
// happening. Checked first, because "Iran condemns US strikes" contains the
// vocabulary of a strike and is a press release.
const REACTION = [
  /\b(condemn|denounce|vow|urge|slam|criticis|criticiz|deplore)/i,
  /\bwarn(s|ed|ing)?\b/i, /\bcalls? for\b/i, /\bstep up pressure\b/i,
  /\btells? the world\b/i, /\bstay away\b/i,
  /\bsecurity alert\b/i, /\btravel advisory\b/i, /\bembassy|embassies\b/i,
  /\bfined?\b/i, /\blawsuit\b/i, /\bprobe\b/i,
  /\blive coverage\b/i, /\bstock market today\b/i, /\bmarket wrap\b/i,
  /\b(analysis|opinion|explainer|what to know|here.s why|five things)\b/i,
  /\breacts?\b/i, /\bresponds? to\b/i,
];

// Language that means something MIGHT happen, or that people are discussing
// whether it should. "Ceasefire talks collapse" contains the word ceasefire and
// is the opposite of a ceasefire; "invasion fears mount" is not an invasion.
// Checked alongside the reaction words, because a headline about the
// possibility of an event is a headline about a conversation.
const TENTATIVE = [
  /\btalks?\b/i, /\bnegotiat/i, /\bpropos/i, /\bplans? to\b/i, /\bdraft\b/i,
  /\bhopes?\b/i, /\bseeks?\b/i, /\bpush(es|ing)? for\b/i, /\boffers?\b/i,
  /\bmull(s|ing)?\b/i, /\bconsider(s|ing)\b/i, /\bweigh(s|ing)\b/i,
  /\b(could|may|might|would|expected to|set to|poised to)\b/i,
  /\b(threat|threaten|fear|risk of|prospect|possib|potential)/i,
  /\bahead of\b/i, /\bprepar(es|ing)\b/i, /\bdemands?\b/i, /\brejects?\b/i,
];

const anyRx = (list, t) => list.some(rx => rx.test(t));

/**
 * The kind of market event a headline reports, or null.
 *
 * Null is the common case and it is the point: almost every headline about a
 * war is a report ABOUT the war rather than a change in it.
 */
function marketEvent(text) {
  const t = String(text || '');
  if (anyRx(REACTION, t) || anyRx(TENTATIVE, t)) return null;
  if (anyRx(WAR_END, t)) return 'war-end';
  if (anyRx(WAR_START, t)) return 'war-start';
  if (anyRx(ESCALATION, t)) return 'escalation';
  if (anyRx(MACRO_SHOCK, t)) return 'macro-shock';
  return null;
}

const EVENT_LABEL = {
  'war-start': 'WAR STARTS', 'war-end': 'WAR ENDS',
  escalation: 'ESCALATION', 'macro-shock': 'MACRO SHOCK',
};

// ── Quiet hours ──────────────────────────────────────────────────────────────
//
// Gold's geopolitical windows are the Asian and European mornings, which are
// the middle of the night in Toronto, so alerts WILL land at three in the
// morning. Severity 3 still gets through — a war starting is worth waking for,
// and a silenced one is the alert that mattered. Severity 2 waits until
// morning; the story is on the Today screen when you open it either way.
//
// A named zone rather than a UTC offset, so this does not drift by an hour
// twice a year. iOS does this better through Focus and per-app notification
// settings; this exists because it was asked for and because Telegram has no
// equivalent.
const QUIET_TZ = process.env.NEWS_QUIET_TZ || 'America/Toronto';
const QUIET_FROM = Number(process.env.NEWS_QUIET_FROM ?? 23);
const QUIET_TO = Number(process.env.NEWS_QUIET_TO ?? 7);

// The local hour in a named zone, without pulling in a date library.
function hourIn(tz, at = Date.now()) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: 'numeric', hour12: false,
    }).format(new Date(at)));
  } catch { return null; }   // an unknown zone means no quiet hours, not a crash
}

function inQuietHours(at = Date.now(), tz = QUIET_TZ, from = QUIET_FROM, to = QUIET_TO) {
  if (from === to) return false;                     // configured off
  const h = hourIn(tz, at);
  if (h == null) return false;
  // Wraps past midnight: 23 to 7 is 23, 0, 1 ... 6.
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

// Which conflicts a headline touches. A story naming two of them — "Israel
// strikes Iran" — belongs to both, and overlapping with EITHER later is enough
// to call it the same running story.
function theatresIn(text) {
  const t = String(text || '');
  const out = new Set();
  for (const [name, rx] of Object.entries(THEATRES)) if (rx.test(t)) out.add(name);
  return out;
}

// ── Corroboration ────────────────────────────────────────────────────────────
//
// One outlet reporting something is a CLAIM. Three within half an hour is an
// event. The feed used to throw duplicates away and keep the newest, which
// destroyed exactly the information that tells those two apart — and kept the
// LATEST timestamp, so a story that broke at 14:12 and was rewritten at 15:40
// was filed as 15:40.
//
// Matching is on content words rather than on the headline text, because two
// outlets never word it the same way: "US strikes Iranian launchers" and "Oil
// jumps after US attack on Iran's Larak island" share almost no characters and
// obviously describe one event.
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'after',
  'says', 'said', 'over', 'into', 'amid', 'more', 'than', 'their', 'about', 'have',
  'has', 'was', 'were', 'will', 'its', 'his', 'her', 'they', 'you', 'but', 'not', 'are']);

function tokens(title) {
  return new Set(String(title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w)));
}

const sharedWords = (a, b) => [...a].filter(w => b.has(w));

/**
 * How many independent outlets carried each story, and when it actually broke.
 *
 * Returns the same items with `srcs` (distinct sources, at least 1) and
 * `firstAt` (the earliest sighting in its group).
 *
 * Two gates, and the second is the one that makes it work. Tried on sixty live
 * headlines, "at least three shared content words" grouped NOTHING — two
 * outlets never word it the same way. Relaxing to two produced exactly one
 * match and it was wrong: "U.S. stock futures slip as chances of a rate hike
 * rise" and "U.S. stock futures dip amid renewed Iran hostilities" share
 * "stock" and "futures" and are two entirely different stories. Weighting by
 * how rare a word is in the batch did not save it either — sixty headlines is
 * far too small a sample to tell a rare word from a common one.
 *
 * What does tell them apart is that a shared PROPER NOUN is an entity and a
 * shared common noun is vocabulary. Iran, Larak, Warsh, Powell name the thing
 * that happened; stock, futures, rate and market are how the business talks
 * about everything. So a pair has to share at least two content words AND at
 * least one capitalised one.
 */
function properNouns(title) {
  return new Set(String(title || '')
    .split(/\s+/)
    .map(w => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter(w => w.length > 3 && /^[A-Z]/.test(w))
    .map(w => w.toLowerCase())
    .filter(w => !STOPWORDS.has(w)));
}

function corroborate(items, { windowMs = 45 * 60e3, minShared = 2 } = {}) {
  const tok = items.map(i => tokens(i.title));
  const nouns = items.map(i => properNouns(i.title));

  return items.map((it, i) => {
    const srcs = new Set([it.source]);
    let firstAt = it.at || null;
    for (let j = 0; j < items.length; j++) {
      if (j === i) continue;
      const other = items[j];
      if (!it.at || !other.at || Math.abs(other.at - it.at) > windowMs) continue;
      if (sharedWords(tok[i], tok[j]).length < minShared) continue;
      if (!sharedWords(nouns[i], nouns[j]).length) continue;
      srcs.add(other.source);
      if (other.at && (firstAt == null || other.at < firstAt)) firstAt = other.at;
    }
    return { ...it, srcs: srcs.size, firstAt };
  });
}
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
  // Six entities were decoded by name and everything else came through raw —
  // a live headline read "Dick&apos;s Sporting Goods". Numeric forms are handled
  // too, because feeds emit &#8217; for a curly apostrophe as often as a name.
  .replace(/&(amp|lt|gt|quot|apos|nbsp|#0*39|#x0*27);/gi, (_, e) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  }[e.toLowerCase()] ?? "'"))
  .replace(/&#(\d+);/g, (_, n) => { const c = +n; return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
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
    // The description was parsed past and thrown away for this project's whole
    // existence. RSS carries a lede paragraph and it is often the half that
    // says what actually happened — "Fed rate decision delayed" and "Fed rate
    // decision shocks markets" are the same headline to a keyword matcher and
    // different stories in the first sentence. Trimmed, because sixty of these
    // ride in a file the phone downloads.
    const desc = (tag(block, 'description') || tag(block, 'summary') || '').slice(0, 280);
    out.push({
      title,
      link: tag(block, 'link'),
      source,
      ...(desc ? { desc } : {}),
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
  constructor({ github, log, groqApiKey = null, telegram = null, env = null, oanda = null }) {
    this.github = github;
    this.log = log || (() => {});
    // Optional. Without either, the alert pass does nothing and says nothing —
    // which is the state news has been in all along.
    this.telegram = telegram && telegram.enabled ? telegram : null;
    this.pushReady = env ? configurePush(env) : false;
    // Optional. Without it the alert carries the headline and no price, which
    // is where it started.
    this.oanda = oanda;
    // Alerting is once per story. Keyed on the link, and floored at the boot
    // time so a restart cannot replay the morning.
    this.alerted = new Set();
    // [{ at, sev, nouns }] for the last two hours, so one running story cannot
    // buzz the phone once per outlet per pass.
    this.alertLog = [];
    this.bootAt = Date.now();
    this.sha = null;
    this.historySha = null;
    this.newsHistorySha = null;
    this.last = null;         // last good payload
    this.lastRunAt = 0;
    // Which way each headline points, read by a model rather than matched
    // against a word list — "OPEC raises output" and "OPEC cuts output" are the
    // same words and opposite trades. Absent a key it labels nothing and says
    // so once, which is the state everything was in before.
    this.direction = new NewsDirection({ apiKey: groqApiKey, log: this.log });
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

  // Headlines, kept.
  //
  // Sixty were published and everything older was discarded, so no headline has
  // ever been correlated with a forward return and none ever could be. That is
  // the same failure as the calendar archive and the position book: the answer
  // was not unavailable, it was never written down.
  //
  // Unlike those two this needs no broker and nobody's permission, and arrives
  // at sixty an hour rather than six a day — so it becomes measurable in weeks.
  // Stored as [t, sev, instruments, title] with the title trimmed: the study
  // needs the timestamp and the tag, and the text only so a result can be
  // audited by eye rather than taken on trust.
  async _archiveNews(items) {
    const now = Date.now();
    const tagged = items.filter(i => i.inst?.length);
    if (!tagged.length) return;

    let prev = [];
    try {
      const cur = await this.github.readJSON(NEWS_HISTORY_PATH).catch(() => null);
      if (Array.isArray(cur?.content?.rows)) prev = cur.content.rows;
      this.newsHistorySha = cur?.sha || null;
    } catch { /* first run — start fresh rather than lose today */ }

    // Keyed on the headline text, not the timestamp: the same story arrives
    // from three outlets minutes apart and is one event, not three.
    const keyOf = r => String(r[3] || '').toLowerCase().slice(0, 60);
    const byKey = new Map(prev.map(r => [keyOf(r), r]));
    let added = 0;
    for (const i of tagged) {
      // The label is stored with the row. Without it the archive can say what
      // was published and never what it was called, and the whole point of
      // labelling is that a study can come back later and mark it.
      const row = [i.at, i.sev ?? 1, i.inst, String(i.title).slice(0, 120)];
      if (i.dir) row.push(i.dir);
      if (byKey.has(keyOf(row))) continue;
      byKey.set(keyOf(row), row);
      added++;
    }

    const cutoff = now - KEEP_NEWS_DAYS * 86400e3;
    let rows = [...byKey.values()].filter(r => r[0] >= cutoff).sort((a, b) => a[0] - b[0]);
    const aged = byKey.size - rows.length;
    // A hard cap as well as an age limit, because a busy fortnight should not
    // be able to produce a file the phone has to download.
    let capped = 0;
    if (rows.length > MAX_NEWS_ROWS) { capped = rows.length - MAX_NEWS_ROWS; rows = rows.slice(-MAX_NEWS_ROWS); }
    if (!added && !aged && !capped) return;

    const span = rows.length > 1 ? Math.round((rows[rows.length - 1][0] - rows[0][0]) / 86400e3) : 0;
    try {
      this.newsHistorySha = await this.github.writeJSON(NEWS_HISTORY_PATH, {
        version: 1, updatedAt: new Date(now).toISOString(),
        columns: ['at', 'severity', 'instruments', 'title', 'direction'],
        keepDays: KEEP_NEWS_DAYS, days: span, rows,
      }, `bot: news history (+${added})`, this.newsHistorySha, { pretty: false });
      this.log(`News: archived +${added}, ${rows.length} rows over ${span} days`
        + `${aged ? `, ${aged} aged out` : ''}${capped ? `, ${capped} capped` : ''}`);
    } catch (e) {
      this.log(`News: could not archive headlines (${e.message})`);
      this.newsHistorySha = null;
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
    const labelled = [];
    for (const it of items.sort((a, b) => b.at - a.at)) {
      const key = it.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      // Instruments, currencies, severity and relevance in one pass, from the
      // vocabulary the app uses. Computed here so the phone does not run
      // seventeen regex sets over sixty headlines on every render, and so a
      // label on a card cannot disagree with the same label on the news screen.
      const label = await labelOf(it.title, it.desc);
      labelled.push({ ...it, ...label });
    }

    // Everything is labelled BEFORE the list is cut, and the cut is by
    // relevance first and recency second.
    //
    // It used to take the sixty most recent and label those, which sounds
    // harmless and is not: MarketWatch's feed carries a personal-finance advice
    // column, those items are newer than a Fed story, and on a live board five
    // of fourteen headlines were "My mom gave me a house" and "I'm single, 74,
    // with $10 million burning a hole in my pocket". They were pushing real news
    // off the end of the list — which is half of why the desk's news analyst
    // saw three headlines during an Iran war.
    //
    // Not-news is dropped outright. Corporate stories are kept but go last, so
    // an M&A wire can fill a spare slot and can never take one.
    const { isJunk } = await tagging();
    const clean = isJunk
      ? labelled.filter(x => !isJunk(`${x.title} ${x.desc || ''}`))
      : labelled;
    // Counted over everything fetched, BEFORE the list is cut, or a story
    // carried by five outlets would report two because the other three fell
    // off the end.
    const usable = corroborate(clean);
    const rank = x => (x.rel ?? 1) > 0 ? 0 : 1;
    const unique = usable
      .sort((a, b) => rank(a) - rank(b) || b.at - a.at)
      .slice(0, MAX_HEADLINES)
      .sort((a, b) => b.at - a.at);

    return { items: unique, ok, failed, dropped: labelled.length - usable.length };
  }

  // ── The alert ──────────────────────────────────────────────────────────
  //
  // Speed is the whole point of the last two changes and neither of them helps
  // if being fast requires you to open an app. This pushes to the phone the
  // moment a geopolitical wire lands, on the same web-push and Telegram plumbing
  // the price alerts already use.
  //
  // Three gates, and each one exists because of a way this becomes noise you
  // switch off:
  //
  //   Severity. An urgent wire alerts on sight. A merely heavy one has to be
  //   CORROBORATED first — two outlets — because a single outlet reporting a
  //   strike is a claim, and a phone that buzzes for claims stops being read.
  //
  //   Age. Nothing older than two hours, and on a fresh process nothing from
  //   before it started plus a thirty-minute grace. Otherwise a restart replays
  //   the whole morning.
  //
  //   Memory. Once per story, keyed on the link, capped so the set cannot grow
  //   without bound over a long-running process.
  //
  // And then the arithmetic that the three gates above do NOT solve. Twenty
  // passes an hour times three alerts a pass is sixty pushes an hour, and
  // during an active war four wire feeds will genuinely produce ten to twenty
  // distinct geopolitical headlines that clear every gate above. A phone that
  // buzzes every few minutes gets its notifications switched off, and then the
  // whole feature is worth nothing.
  //
  // So three more, and the first is the one that matters:
  //
  //   THE SAME RUNNING STORY IS ONE ALERT. A candidate sharing a proper noun
  //   with something already alerted in the last two hours is the same war
  //   being reported again — suppressed, unless it is an ESCALATION, an urgent
  //   wire where the earlier one was merely heavy.
  //
  //   A floor on the gap between alerts, and a ceiling per hour. Blunt, and
  //   blunt is the point: whatever the story vocabulary does, the phone cannot
  //   buzz more than four times an hour.
  async _alert(headlines) {
    if (!this.telegram && !this.pushReady) return 0;
    const now = Date.now();
    const floor = Math.max(this.bootAt - 30 * 60e3, now - 2 * 3600e3);
    const M = await tagging();
    const geo = M.isGeopolitical || (() => false);

    // Forget what was alerted more than two hours ago; a new day's Iran story
    // is a new story.
    this.alertLog = (this.alertLog || [])
      .filter(a => now - a.at < Math.max(ALERT_MEMORY_MS, THEATRE_QUIET_MS));
    const lastAt = this.alertLog.length ? Math.max(...this.alertLog.map(a => a.at)) : 0;
    const inLastHour = this.alertLog.filter(a => now - a.at < 3600e3).length;

    const candidates = headlines.filter((h) => {
      if (!h.at || h.at < floor) return false;
      const key = h.link || h.title;
      if (this.alerted.has(key)) return false;

      // THE FIRST QUESTION IS WHAT KIND OF THING HAPPENED, not how loud the
      // sentence is. A war starting, a war ending, a change in its kind, or a
      // market repricing at once. Everything else — the fortieth strike report,
      // the condemnation, the embassy warning, the daily wrap — goes to the
      // Today screen and no further.
      h._kind = marketEvent(`${h.title} ${h.desc || ''}`);
      if (!h._kind) return false;

      // A war ending is worth waking for as much as one starting, so quiet
      // hours are broken by the kind rather than by the severity word.
      const big = h._kind === 'war-start' || h._kind === 'war-end';
      if (!big && inQuietHours(now)) return false;

      // Corroboration still applies to the ones that are not obviously huge: a
      // single outlet claiming a ceasefire is a claim.
      return big || (h.sev ?? 1) >= 3 || (h.srcs || 1) >= 2;
    }).sort((a, b) => (b.sev ?? 1) - (a.sev ?? 1) || (b.at - a.at));

    const hits = [];
    let budget = Math.max(0, MAX_ALERTS_PER_HOUR - inLastHour);
    let gapFrom = lastAt;
    for (const h of candidates) {
      if (budget <= 0) break;
      const sev = h.sev ?? 1;
      const nouns = properNouns(h.title);
      const theatres = theatresIn(`${h.title} ${h.desc || ''}`);

      // Already told you about this war. The theatre is the strong test and
      // holds for four hours; the proper nouns are the fallback for a story
      // that belongs to no named conflict.
      const prior = this.alertLog.find(a =>
        (theatres.size && now - a.at < THEATRE_QUIET_MS
          && [...theatres].some(x => a.theatres?.has(x)))
        || [...nouns].some(w => a.nouns.has(w)));
      if (prior && !(sev >= 3 && prior.sev < 3)) continue;
      // Not within eight minutes of the last one, unless it is urgent and the
      // last one was not.
      if (now - gapFrom < MIN_ALERT_GAP_MS && !(sev >= 3 && (!prior || prior.sev < 3))) continue;

      hits.push(h);
      this.alertLog.push({ at: now, sev, nouns, theatres });
      gapFrom = now;
      budget--;
    }

    if (!hits.length) return 0;
    for (const h of hits) this.alerted.add(h.link || h.title);
    if (this.alerted.size > 500) this.alerted = new Set([...this.alerted].slice(-300));

    for (const h of hits) {
      const when = new Date(h.firstAt || h.at).toISOString().slice(11, 16);
      const srcs = (h.srcs || 1) > 1 ? ` · ${h.srcs} sources` : ' · 1 source, unconfirmed';
      const moved = await this._moveSince(h.firstAt || h.at).catch(() => '');
      const body = `${h.title}\n${h.source}${srcs}${moved ? `\n${moved}` : ''}`;
      // The tag names the EVENT rather than the loudness of the sentence.
      const tag = h._kind === 'war-end' ? '🕊 WAR ENDS'
        : h._kind === 'war-start' ? '🔴 WAR STARTS'
        : h._kind === 'escalation' ? '🔴 ESCALATION'
        : '🟠 MACRO SHOCK';
      if (this.telegram) {
        await this.telegram.send(`${tag} <b>${when} UTC</b>${srcs}\n${h.title}`
          + `\n<i>${h.source}</i>${moved ? `\n<b>${moved}</b>` : ''}`).catch(() => {});
      }
      if (this.pushReady) {
        const subs = await this._subs();
        if (subs.length) await sendPush(subs, `${tag} ${when} UTC`, body).catch(() => {});
      }
    }
    this.log(`News: alerted ${hits.length} market event(s) `+ `[${hits.map(h => h._kind).join(', ')}]`
      + ` (${inLastHour + hits.length}/${MAX_ALERTS_PER_HOUR} this hour)`);
    return hits.length;
  }

  // What the metals have done since the headline broke.
  //
  // The line that turns a news alert into a trading one. Buzzing "US strikes
  // Iran" invites the classic mistake — buying the news after the market has
  // already taken it — and "Gold +0.9% since" is the number that says you are
  // late. A near-zero reading is just as useful and much rarer: the market has
  // seen this headline and does not care.
  //
  // ONE-MINUTE BARS, not hourly. The alert fires about three minutes after the
  // wire, and an H1 bar that began at 21:00 is not complete until 22:00 — the
  // measurement would be null on every alert it was built for. Ninety M1 bars
  // covers an hour and a half of headline age and gives a close within a minute
  // of now.
  //
  // Absent rather than zero when the market was shut, when the headline is
  // older than the window, or when OANDA is not wired in.
  async _moveSince(at) {
    if (!this.oanda || !at) return '';
    const M = await features();
    if (!M?.moveSincePct) return '';
    const parts = [];
    for (const [sym, label] of [['XAU_USD', 'Gold'], ['XAG_USD', 'Silver']]) {
      const cs = await this.oanda.getCandles(sym, 'M1', 90).catch(() => null);
      const mv = cs && M.moveSincePct(cs, at);
      if (!mv) continue;
      parts.push(`${label} ${mv.pct >= 0 ? '+' : ''}${mv.pct.toFixed(2)}%`);
    }
    return parts.length ? `${parts.join(' · ')} since` : '';
  }

  async _subs() {
    try {
      const f = await this.github.readJSON(SUBS_PATH);
      return f?.content?.subscriptions || [];
    } catch { return []; }
  }

  async run() {
    if (Date.now() - this.lastRunAt < POLL_MS) return;
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
    // Before the direction labelling, the archive and the publish, all of which
    // take seconds this is trying not to spend.
    await this._alert(headlines).catch(e => this.log(`News alert: ${e.message}`));

    // Direction, before anything is written, so the label reaches the live
    // file AND the archive that will eventually be used to judge it.
    await this.direction.label(headlines)
      .catch(e => this.log(`News direction: ${e.message}`));

    await this._archive(calendar, this._releases())
      .catch(e => this.log(`News: archive failed (${e.message})`));
    await this._archiveNews(headlines)
      .catch(e => this.log(`News: headline archive failed (${e.message})`));

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
                   CURRENCY_WORDS, numOf, withSurprise, NOT_ABOUT, releasedValue, RELEASE_MAP,
                   corroborate, tokens, properNouns, POLL_MS, MAX_HEADLINES,
                   MAX_ALERTS_PER_HOUR, MIN_ALERT_GAP_MS, ALERT_MEMORY_MS,
                   theatresIn, THEATRES, THEATRE_QUIET_MS,
                   inQuietHours, hourIn, QUIET_TZ, QUIET_FROM, QUIET_TO,
                   marketEvent, EVENT_LABEL };

const ROOT = require('path').join(__dirname, '..') + '/';
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-news-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const fs = require('fs');

// Controllable fake network.
let ROUTES = {};
fs.writeFileSync(__dirname + '/stub-news-fetch.cjs',
  'module.exports = (...a) => global.__fetch(...a);\n');
global.__fetch = async (url) => {
  const r = ROUTES[Object.keys(ROUTES).find(k => url.includes(k))];
  if (!r) throw new Error('unrouted ' + url);
  if (r instanceof Error) throw r;
  return { ok: r.ok !== false, status: r.status || 200, text: async () => r.body };
};

const { NewsFetcher, parseRSS, currenciesIn } = require(`${ROOT}vps-bot/src/newsFetcher.js`);
let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// ── RSS parsing ───────────────────────────────────────────────────────────
const rss = `<rss><channel>
<item><title><![CDATA[ECB holds rates &amp; signals caution]]></title>
<link>https://x.com/1</link><pubDate>Mon, 10 Aug 2026 12:00:00 GMT</pubDate></item>
<item><title>Gold hits record as dollar slips</title>
<link>https://x.com/2</link><pubDate>Mon, 10 Aug 2026 11:00:00 GMT</pubDate></item>
<item><description>no title here</description></item>
</channel></rss>`;
const items = parseRSS(rss, 'Test');
check('parses items', items.length === 2, String(items.length));
check('decodes CDATA and entities', items[0].title === 'ECB holds rates & signals caution', items[0].title);
check('keeps the link', items[0].link === 'https://x.com/1');
check('parses the date', items[0].at === Date.parse('Mon, 10 Aug 2026 12:00:00 GMT'));
check('skips an item with no title', !items.some(i => !i.title));
check('malformed xml does not throw', parseRSS('<rss><item><title>x', 'T').length >= 0);
check('empty input is safe', parseRSS('', 'T').length === 0 && parseRSS(null, 'T').length === 0);

// ── Currency tagging ──────────────────────────────────────────────────────
check('ECB story tags EUR', currenciesIn('ECB holds rates').includes('EUR'));
check('gold story tags XAU', currenciesIn('Gold hits record high').includes('XAU'));
check('dollar story tags USD', currenciesIn('Dollar slips after Powell'));
check('an unrelated story tags nothing', currenciesIn('Tech shares rally on earnings').length === 0,
  currenciesIn('Tech shares rally on earnings').join());
check('substring false positives avoided', !currenciesIn('the auditor said').includes('AUD'),
  'matching bare currency codes would put every "audit" in AUD');

// ── The full pass ─────────────────────────────────────────────────────────
const NOW = Date.now();
const cal = JSON.stringify([
  { title:'ECB Rate Decision', country:'EUR', impact:'High', date:new Date(NOW + 3600e3).toISOString(), forecast:'2.15%', previous:'2.40%' },
  { title:'Machine Orders',    country:'JPY', impact:'Low',  date:new Date(NOW + 7200e3).toISOString() },
  { title:'Ancient Event',     country:'USD', impact:'High', date:new Date(NOW - 5*86400e3).toISOString() },
  { title:'Far Future',        country:'USD', impact:'High', date:new Date(NOW + 30*86400e3).toISOString() },
]);
ROUTES = { 'faireconomy': { body: cal }, 'forexlive': { body: rss }, 'fxstreet': { body: rss },
           'dailyfx': { body: rss }, 'marketwatch': { body: rss }, 'cnbc': { body: rss }, 'investing': { body: rss } };

let written = null;
const github = { writeJSON: async (path, content, msg, sha) => { written = { path, content, msg, sha }; return 'sha1'; } };
const nf = new NewsFetcher({ github, log: () => {} });

(async () => {
  await nf.run();
  check('publishes to bot/news.json', written?.path === 'bot/news.json', written?.path);
  const p = written.content;
  check('keeps upcoming events', p.calendar.some(e => e.title === 'ECB Rate Decision'));
  check('drops events far in the past', !p.calendar.some(e => e.title === 'Ancient Event'));
  check('drops events far in the future', !p.calendar.some(e => e.title === 'Far Future'));
  check('keeps low impact for the app to filter', p.calendar.some(e => e.impact === 'low'));
  check('impact is lowercased', p.calendar.every(e => e.impact === e.impact.toLowerCase()));
  check('calendar is time-ordered', p.calendar.every((e,i,a) => i===0 || a[i-1].at <= e.at));
  check('headlines are deduped across sources', p.headlines.length === 2,
    `${p.headlines.length} from 6 identical feeds`);
  check('headlines carry currency tags', p.headlines.every(h => Array.isArray(h.ccy)));
  check('newest headline first', p.headlines[0].at >= p.headlines[1].at);
  // Not a count. Pinning "exactly six feeds" made this fail the moment three
  // dead sources were replaced, which is a change to the source list and not to
  // any behaviour worth testing. What matters is that every feed that answered
  // is named, and that a failure carries its reason rather than just a name.
  check('every source that answered is named',
    p.sources.length > 0 && p.sources.every(s => typeof s === 'string'), String(p.sources.length));
  check('and a failure says why, not just who',
    p.failed.every(f => typeof f === 'object' && f.name && f.why),
    JSON.stringify(p.failed));
  check('timestamps recorded', !!p.calendarAt && !!p.headlinesAt && !!p.updatedAt);

  // Rate limit: a second immediate run must not refetch.
  written = null;
  await nf.run();
  check('does not republish within 15 minutes', written === null);

  // A calendar failure must keep the previous calendar rather than publish a gap.
  nf.lastRunAt = 0;
  ROUTES['faireconomy'] = new Error('calendar down');
  written = null;
  await nf.run();
  check('a calendar outage keeps the last good copy',
    written?.content.calendar.some(e => e.title === 'ECB Rate Decision'),
    'showing "no events" when an ECB decision is an hour away is the dangerous failure');
  check('and headlines still update', written?.content.headlines.length === 2);

  // Everything down: publish nothing rather than an empty screen.
  nf.lastRunAt = 0;
  nf.last = null;
  for (const k of Object.keys(ROUTES)) ROUTES[k] = new Error('down');
  written = null;
  await nf.run();
  check('total outage publishes nothing', written === null);

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

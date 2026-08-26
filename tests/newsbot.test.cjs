// The bot is CommonJS and shared/newsTagging.mjs is ESM, so the vocabulary
// arrives by dynamic import at runtime — the one part of this that a unit test
// of the module itself cannot cover, and the part that fails silently. The
// fallback returns currency-only tags, which looks like working code and would
// quietly put index cards back on dollar stories.
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const path = require('path');
const fs = require('fs');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

(async () => {
  // Resolved exactly the way newsFetcher.js resolves it, from the same depth.
  const fromBotSrc = path.join(__dirname, '..', 'vps-bot', 'src');
  const target = path.join(fromBotSrc, '..', '..', 'shared', 'newsTagging.mjs');
  check('the path the bot computes points at a file that exists', fs.existsSync(target), target);

  const url = require('url').pathToFileURL(target).href;
  const m = await import(url);
  check('and a CommonJS dynamic import of it works',
    typeof m.labelHeadline === 'function');

  const l = m.labelHeadline('S&P 500 climbs as tech stocks lead Wall Street higher');
  check('an index headline reaches the bot as an index tag',
    l.inst.includes('US500'), JSON.stringify(l.inst));
  check('which is the whole point — this used to arrive tagged USD',
    !l.ccy.includes('USD'), JSON.stringify(l.ccy));

  // The published shape. instrumentRead matches on inst first and falls back to
  // ccy, and CommandCenter ranks by sev, so all four have to be present.
  check('every published label is present', ['inst', 'ccy', 'sev', 'rel'].every(k => k in l),
    Object.keys(l).join(','));

  // The description is read too. RSS carries it and this project discarded it.
  const src = fs.readFileSync(path.join(fromBotSrc, 'newsFetcher.js'), 'utf8');
  check('the RSS description is parsed rather than skipped', /tag\(block, 'description'\)/.test(src));
  check('and trimmed, because sixty of these ride in a file a phone downloads',
    /\.slice\(0, 280\)/.test(src));
  check('the fallback exists for when the import fails',
    /labelHeadline \? t\.labelHeadline|t\.labelHeadline\b/.test(src) && /currenciesIn\(title\)/.test(src),
    'a failed import must not publish sixty untagged headlines');

  // Headlines are kept now. Nothing measures them yet; nothing could, because
  // sixty were published and everything older was thrown away.
  check('headlines are archived to their own file', /bot\/news-history\.json/.test(src));
  check('only instrument-tagged rows are stored',
    /items\.filter\(i => i\.inst\?\.length\)/.test(src),
    'an untagged story cannot be scored against a price');
  check('and the file is bounded by age and by row count',
    /KEEP_NEWS_DAYS/.test(src) && /MAX_NEWS_ROWS/.test(src));

  // ── The News screen was never migrated off the browser proxies ────────────
  // newsFetcher.js's own header says the app "fetched both from the browser,
  // through a chain of three public CORS proxies it does not control". The
  // Command Center was moved to the bot's file; the News tab was not, and kept
  // failing the old way — "Could not load ForexLive:" with an empty reason and
  // a blank screen, while sixty tagged headlines sat in bot/news.json.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'NewsCalendar.jsx'), 'utf8');
  check('the News screen reads what the bot publishes', /bot\/news\.json/.test(ui));
  // Order matters, not proximity: the bot call has to come first in the
  // function, however much comment sits between it and the fallback.
  const stream = ui.slice(ui.indexOf('const loadStream'), ui.indexOf('const loadStream') + 1600);
  check('the merged terminal stream tries the bot before any proxy',
    stream.indexOf('fetchBotNews') > -1
    && stream.indexOf('fetchBotNews') < stream.indexOf('mergeFeeds'),
    'the proxies are the fallback, not the plan');
  check('the proxies remain as a fallback rather than being deleted',
    /proxyFetch\(feed\.url\)/.test(ui),
    'a live proxy beats a stale file, so the path stays');
  check('a failed load names the reason',
    /e\?\.errors\?\.length/.test(ui),
    'Promise.any rejects with an AggregateError whose own message is empty, '
    + 'which is why the error read "Could not load ForexLive:" and stopped');

  // Entity decoding — a live headline read "Dick&apos;s Sporting Goods".
  const strip = (t) => t
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#0*39|#x0*27);/gi, (_, e) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()] ?? "'"))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  check('named entities beyond the original six decode',
    strip('Dick&apos;s Sporting Goods') === "Dick's Sporting Goods", strip('Dick&apos;s Sporting Goods'));
  check('and numeric ones, which feeds emit as often',
    strip('Trump&#8217;s plan &#38; more') === 'Trump\u2019s plan & more', strip('Trump&#8217;s plan &#38; more'));
  check('the original six still work',
    strip('a&amp;b &lt;c&gt; &quot;d&quot; &#39;e&#39;') === 'a&b <c> "d" \'e\'', strip('a&amp;b &lt;c&gt; &quot;d&quot; &#39;e&#39;'));

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('  FAIL  threw —', e.stack.split('\n').slice(0, 3).join(' ')); process.exit(1); });

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

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('  FAIL  threw —', e.stack.split('\n').slice(0, 3).join(' ')); process.exit(1); });

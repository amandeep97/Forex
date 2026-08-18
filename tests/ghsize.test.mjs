// A file that grew past a megabyte, and the API that quietly refuses to look
// at one.
//
// The live feed crossed 1 MB. Updating a file on GitHub requires its SHA; the
// bot held one in memory, so writes kept working and nothing looked wrong. The
// first restart after crossing the line wiped it, every write from then on
// asked for the SHA through an endpoint that answers 403 for anything over
// 1 MB, and the feed stopped publishing for half an hour while news and alerts
// — both small — carried on normally.
const ROOT = new URL('../', import.meta.url).pathname;
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const calls = [];
let handler = () => ({ ok: true, status: 200, json: async () => ({}) });
// node-fetch is resolved through a stub that forwards to the handler above, so
// every request the client makes is inspectable without a network.
require('fs').writeFileSync(new URL('./stub-fetch-rec.cjs', import.meta.url).pathname,
  'module.exports = (...a) => global.__fetch(...a);\n');
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch-rec.cjs');
  return orig.call(this, req, ...rest);
};
global.__fetch = (url, opts) => { calls.push({ url, opts }); return handler(url, opts); };
const { GitHubClient } = require(`${ROOT}vps-bot/src/github.js`);

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const gh = new GitHubClient({ token: 't', owner: 'o', repo: 'r', branch: 'main' });
const reset = () => { calls.length = 0; };

// ── The SHA of a large file comes from the directory listing ──────────────
reset();
handler = (url) => {
  if (url.includes('/contents/bot?ref=main')) {
    return { ok: true, status: 200, json: async () => ([
      { name: 'news.json', sha: 'aaa' },
      { name: 'feed.json', sha: 'bbb' },
    ]) };
  }
  throw new Error(`unexpected ${url}`);
};
check('a SHA is read from the parent directory, not the file',
  await gh.readSha('bot/feed.json') === 'bbb');
check('and the listing is what was requested',
  calls[0].url.includes('/contents/bot?ref=main'), calls[0].url);
check('a file not in the listing returns nothing, rather than throwing',
  await gh.readSha('bot/missing.json') === null);

// ── A 403 falls back to the blob API instead of dying ─────────────────────
reset();
handler = (url, opts) => {
  if (url.includes('/contents/bot/feed.json')) return { ok: false, status: 403, json: async () => ({}) };
  if (url.includes('/contents/bot?ref=main')) {
    return { ok: true, status: 200, json: async () => ([{ name: 'feed.json', sha: 'bbb' }]) };
  }
  if (url.includes('/git/blobs/bbb')) {
    check('the blob is asked for raw, not base64',
      (opts.headers.Accept || '').includes('raw'), opts.headers.Accept);
    return { ok: true, status: 200, text: async () => '{"hello":1}' };
  }
  throw new Error(`unexpected ${url}`);
};
const big = await gh.readJSON('bot/feed.json');
check('a file too large for the Contents API is still readable',
  big?.content?.hello === 1, JSON.stringify(big?.content));
check('and carries the SHA a write will need', big?.sha === 'bbb');

// ── A missing file is still missing ───────────────────────────────────────
reset();
handler = () => ({ ok: false, status: 404, json: async () => ({}) });
check('404 still means absent, not an error', await gh.readJSON('bot/none.json') === null);

// ── The write recovery no longer downloads the file to read its SHA ───────
reset();
let puts = 0;
handler = (url, opts) => {
  if (opts?.method === 'PUT') {
    puts++;
    // First attempt has no SHA — exactly the state after a restart.
    if (puts === 1) return { ok: false, status: 422, json: async () => ({ message: 'sha wasn\'t supplied' }) };
    const body = JSON.parse(opts.body);
    check('the retry supplies the SHA it just fetched', body.sha === 'bbb', body.sha);
    return { ok: true, status: 200, json: async () => ({ content: { sha: 'ccc' } }) };
  }
  if (url.includes('/contents/bot?ref=main')) {
    return { ok: true, status: 200, json: async () => ([{ name: 'feed.json', sha: 'bbb' }]) };
  }
  throw new Error(`unexpected ${url}`);
};
const newSha = await gh.writeJSON('bot/feed.json', { a: 1 }, 'msg', null, { pretty: false });
check('a write with no cached SHA recovers and succeeds', newSha === 'ccc', String(newSha));
check('recovery never fetches the file body',
  !calls.some(c => c.url.includes('/contents/bot/feed.json') && c.opts?.method !== 'PUT'),
  calls.filter(c => c.opts?.method !== 'PUT').map(c => c.url).join(' '));
check('and it took exactly two PUTs', puts === 2, String(puts));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

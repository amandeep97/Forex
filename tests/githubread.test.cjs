'use strict';
// Reading a file back out of GitHub — vps-bot/src/github.js.
//
// This exists because of one specific, silent failure that cost the liquidity
// study two full runs.
//
// GitHub's contents endpoint has a 1MB ceiling. Above it the request does not
// fail, does not 403 and does not say anything is wrong: it answers 200 with
// `content: ""` and `encoding: "none"`. Decoding that gives an empty string,
// JSON.parse("") throws, and any caller that reads a throw as "the file is not
// there yet" will cheerfully start over. The study's progress file crossed 1MB
// at 32 of 40 instruments and the run restarted from the beginning on every
// tick after that, forever, while the log printed ordinary progress the whole
// time.
//
// The client already handled the >100MB case, where the endpoint really does
// 403. The gap was the band in between — which is the band real files land in.
const { GitHubClient } = require('../vps-bot/src/github');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const client = () => new GitHubClient({ owner: 'o', repo: 'r', token: 't', branch: 'main' });
const b64 = o => Buffer.from(JSON.stringify(o)).toString('utf8') && Buffer.from(JSON.stringify(o)).toString('base64');

const real = globalThis.fetch;
const withFetch = async (impl, fn) => {
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

(async () => {
  // The ordinary case, so the fix cannot be "always use the blob API".
  await withFetch(async () => ({
    ok: true, status: 200,
    async json() { return { content: b64({ small: true, n: 1 }), encoding: 'base64', sha: 'def' }; },
  }), async () => {
    const r = await client().readJSON('bot/small.json');
    check('a normal file still decodes from the contents response',
      r?.content?.n === 1 && r.sha === 'def', JSON.stringify(r?.content));
  });

  // The failure. 200, no error, and nothing in the body.
  {
    let blobCalls = 0;
    await withFetch(async (url) => {
      if (String(url).includes('/git/blobs/')) {
        blobCalls++;
        return { ok: true, status: 200, async text() { return JSON.stringify({ big: true, n: 42 }); } };
      }
      return { ok: true, status: 200, async json() { return { content: '', encoding: 'none', sha: 'abc' }; } };
    }, async () => {
      const r = await client().readJSON('bot/big.json');
      check('a file over 1MB comes back through the blob API, not as a throw',
        r?.content?.n === 42 && blobCalls === 1,
        `n=${r?.content?.n}, ${blobCalls} blob call(s)`,
        'a 200 with an empty body is the shape that broke the study');
      check('and it carries the same sha, so the next write is not a blind overwrite',
        r?.sha === 'abc', String(r?.sha));
    });
  }

  // A real 404 still means "not there", which callers depend on to start fresh.
  await withFetch(async () => ({ ok: false, status: 404 }), async () => {
    check('a missing file is still null rather than an error',
      await client().readJSON('bot/nope.json') === null);
  });

  // And a genuine failure still throws, so it cannot be mistaken for absence.
  await withFetch(async () => ({ ok: false, status: 500 }), async () => {
    let threw = false;
    try { await client().readJSON('bot/x.json'); } catch { threw = true; }
    check('a server error throws instead of reading as an empty file',
      threw, '', 'this is the distinction the study now depends on');
  });

  // The >100MB path the client already had must not have been broken by the fix.
  // There the endpoint genuinely 403s, and the sha is looked up by listing the
  // directory before the blob is fetched.
  {
    let blob = 0, listed = 0;
    await withFetch(async (url) => {
      const u = String(url);
      if (u.includes('/git/blobs/')) {
        blob++;
        return { ok: true, status: 200, async text() { return '{"huge":1}'; } };
      }
      if (u.includes('/contents/bot/huge.json')) return { ok: false, status: 403 };
      if (u.includes('/contents/bot?')) {
        listed++;
        return { ok: true, status: 200, async json() { return [{ name: 'huge.json', sha: 'zzz' }]; } };
      }
      return { ok: false, status: 404 };
    }, async () => {
      const out = await client().readJSON('bot/huge.json');
      check('the existing 403 path still resolves through a directory listing',
        out?.content?.huge === 1 && listed === 1 && blob === 1,
        `huge=${out?.content?.huge}, ${listed} listing(s), ${blob} blob call(s)`);
    });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

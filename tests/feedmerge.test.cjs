// The feed must enumerate the published list, not the hand-typed twenty.
const ROOT = require('path').join(__dirname, '..') + '/';
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const { FeedBuilder } = require(`${ROOT}vps-bot/src/feed.js`);
const { INSTRUMENTS } = require(`${ROOT}vps-bot/src/instruments.js`);

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

let served = { content: { instruments: [
  { sym:'NVDA/USDT', name:'NVIDIA', cls:'tradfi', bfut:'NVDAUSDT', perp:true, pip:0.01, dec:2 },
  { sym:'TSLA/USDT', name:'Tesla',  cls:'tradfi', bfut:'TSLAUSDT', perp:true, pip:0.01, dec:2 },
  // Already static — must not be added twice.
  { sym:'CRWD/USDT', name:'CrowdStrike', cls:'tradfi', bfut:'CRWDUSDT', perp:true, pip:0.01, dec:2 },
] } };
let reads = 0;
const github = { readJSON: async () => { reads++; if (served instanceof Error) throw served; return served; } };
const fb = new FeedBuilder({ oanda:{}, github, log: () => {} });

(async () => {
  check('before loading, only the static registry', fb.instruments.length === INSTRUMENTS.length);

  await fb._loadPublished();
  const syms = fb.instruments.map(i => i.sym);
  check('published instruments are enumerated', syms.includes('NVDA/USDT') && syms.includes('TSLA/USDT'));
  check('static entries survive', INSTRUMENTS.every(i => syms.includes(i.sym)));
  check('a published duplicate is not added twice',
    syms.filter(s => s === 'CRWD/USDT').length === 1);
  check('published instruments are candle-capable',
    fb.instruments.find(i => i.sym === 'NVDA/USDT').can.candles === true);
  check('and carry no OANDA spread',
    fb.instruments.find(i => i.sym === 'NVDA/USDT').can.spread === false);
  check('they route to futures', !!fb.instruments.find(i => i.sym === 'NVDA/USDT').bfut);

  // Cached for an hour — the list changes when Binance lists something, not
  // between ticks.
  const before = reads;
  await fb._loadPublished();
  check('not re-read every tick', reads === before);

  // A failed read must keep the previous list, not collapse to the static one.
  fb.publishedAt = 0;
  served = new Error('github down');
  await fb._loadPublished();
  check('a failed read keeps the previous list',
    fb.instruments.some(i => i.sym === 'NVDA/USDT'),
    'instruments must not vanish from the feed and reappear');

  // Junk entries must be skipped, not crash the pass.
  fb.publishedAt = 0;
  served = { content: { instruments: [null, { sym:'X/USDT' }, { bfut:'YUSDT' }, 'nope'] } };
  await fb._loadPublished();
  check('malformed entries are ignored', fb.instruments.length === INSTRUMENTS.length,
    `${fb.instruments.length} vs ${INSTRUMENTS.length}`);

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

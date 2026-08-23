// The Groq model list was four ids typed into a component. Groq retires ids on
// a schedule, so the dropdown kept offering a model that no longer existed and
// the request came back 404 with nothing on screen saying why. It is now asked
// of Groq.
//
// Which means the risky part is no longer the list — it is what gets picked out
// of a list nobody has seen. Groq serves speech, moderation and embedding
// models from the same endpoint, and defaulting to one of those produces a 400
// on the first message. These check the filtering and the ranking against a
// response shaped like Groq's, including model names that do not exist yet,
// because those are the ones the rule has to survive.
const ROOT = new URL('../', import.meta.url).pathname;

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// localStorage and fetch, before the module under test is loaded.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

let lastRequest = null;
let respond = null;
globalThis.fetch = async (url, opts) => {
  lastRequest = { url, opts };
  return respond();
};
const ok = data => () => ({ ok: true, status: 200, json: async () => data });

const G = await import(`${ROOT}src/utils/groqModels.js`);

const T = 1_700_000_000;
const m = (id, created, extra = {}) => ({ id, created, object: 'model', context_window: 131072, ...extra });

// A response in Groq's shape: chat models mixed with everything else it serves.
const BODY = {
  object: 'list',
  data: [
    m('llama-3.1-8b-instant', T + 500),
    m('whisper-large-v3-turbo', T + 900),
    m('llama-3.3-70b-versatile', T + 100),
    m('meta-llama/llama-guard-4-12b', T + 800),
    m('some-future-405b-model', T + 700),      // newest full-size: the answer
    m('playai-tts', T + 950),
    m('text-embedding-3-large', T + 990),
    m('deepseek-r1-distill-llama-70b', T + 200),
  ],
};

// ── What comes back ──────────────────────────────────────────────────────────
store.clear();
respond = ok(BODY);
const list = await G.fetchGroqModels('gsk_test');

check('the key is sent as a bearer token',
  lastRequest.opts.headers.Authorization === 'Bearer gsk_test', lastRequest.opts.headers.Authorization);
check('and the request goes to the models endpoint',
  lastRequest.url === 'https://api.groq.com/openai/v1/models', lastRequest.url);

const ids = list.map(x => x.id);
check('speech, moderation and embedding models are dropped',
  !ids.some(i => /whisper|tts|guard|embedding/.test(i)), ids.join(', '));
check('every chat model survives', ids.length === 4, ids.join(', '));

// ── What gets defaulted to ───────────────────────────────────────────────────
// The rule has to work on names nobody has seen. It reads Groq's own `created`
// timestamp rather than guessing quality from a name — a model released after
// this test was written cannot be recognised by name, and can be by date.
check('the default is the newest model, not the first Groq happens to list',
  ids[0] === 'some-future-405b-model', ids[0]);
check('a newer small variant does not outrank a full-size one',
  ids.indexOf('llama-3.1-8b-instant') > ids.indexOf('llama-3.3-70b-versatile'),
  `8b at ${ids.indexOf('llama-3.1-8b-instant')}, 70b at ${ids.indexOf('llama-3.3-70b-versatile')}`);
check('speed variants are still offered, just not first',
  ids.includes('llama-3.1-8b-instant'));
check('cachedGroqDefault agrees with the list it cached',
  G.cachedGroqDefault() === 'some-future-405b-model', G.cachedGroqDefault());

// An inactive model is one Groq has already turned off.
store.clear();
respond = ok({ data: [m('retired-70b', T + 900, { active: false }), m('live-70b', T + 100)] });
check('a model Groq marks inactive is not offered',
  (await G.fetchGroqModels('k')).map(x => x.id).join() === 'live-70b');

// ── Names ────────────────────────────────────────────────────────────────────
check('an id becomes a readable label',
  G.prettyModel('llama-3.3-70b-versatile') === 'Llama 3.3 70B Versatile', G.prettyModel('llama-3.3-70b-versatile'));
check('a vendor prefix is dropped',
  G.prettyModel('meta-llama/llama-4-scout-17b-16e-instruct').startsWith('Llama 4 Scout 17B'),
  G.prettyModel('meta-llama/llama-4-scout-17b-16e-instruct'));

// ── Failure must never empty the picker ──────────────────────────────────────
// The whole point is a dropdown that is always right. A dropdown that is
// sometimes empty is worse than one that is sometimes stale.
store.clear();
respond = ok(BODY);
await G.fetchGroqModels('k');                       // prime the cache
const cachedIds = G.cachedGroqModels().map(x => x.id).join();

respond = () => { throw new Error('network down'); };
const afterThrow = await G.fetchGroqModels('k', { force: true });
check('a thrown request falls back to the cache rather than throwing',
  afterThrow?.map(x => x.id).join() === cachedIds);

respond = () => ({ ok: false, status: 401, json: async () => ({}) });
const after401 = await G.fetchGroqModels('k', { force: true });
check('a rejected key falls back to the cache too', after401?.map(x => x.id).join() === cachedIds);

respond = ok({ data: [] });
const afterEmpty = await G.fetchGroqModels('k', { force: true });
check('an empty list is refused, so the picker cannot go blank',
  afterEmpty?.map(x => x.id).join() === cachedIds);

store.clear();
respond = () => { throw new Error('network down'); };
check('with no cache and no network the caller gets null and keeps its own list',
  (await G.fetchGroqModels('k')) === null);
check('no key means no call at all', (await G.fetchGroqModels('')) === null);

store.set('ai_models_groq', '{not json');
check('a corrupt cache reads as no cache rather than crashing the tab',
  G.cachedGroqModels() === null && G.cachedGroqDefault('fb') === 'fb');

// ── The cache is used ────────────────────────────────────────────────────────
store.clear();
respond = ok(BODY);
await G.fetchGroqModels('k');
let calls = 0;
respond = () => { calls++; return { ok: true, status: 200, json: async () => BODY }; };
await G.fetchGroqModels('k');
check('a second call inside the TTL does not hit the network', calls === 0, String(calls));
await G.fetchGroqModels('k', { force: true });
check('and force does', calls === 1, String(calls));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

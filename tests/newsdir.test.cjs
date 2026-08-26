// Which way a headline points, read rather than pattern-matched.
//
// A word list cannot tell "OPEC raises output" from "OPEC cuts output" — same
// words, same severity, opposite trades. A model can. It will also return a
// fluent, confident answer when it knows nothing, which is the failure that put
// "crowded long — the side that unwinds badly" onto a card as a finding.
//
// So most of this file is about containment: what happens when the model
// invents an instrument, returns prose instead of JSON, indexes a headline that
// is not in the batch, or is simply unreachable. The labels themselves are
// assumed worthless until the archive is old enough to score them.
// node-fetch resolves through tests/stubs, which forwards to globalThis.fetch —
// so replacing that below is enough to intercept every request the module makes.
const { NewsDirection, BATCH, MAX_BATCHES } = require('../vps-bot/src/newsDirection.js');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// A stand-in Groq: serves a model list, then whatever the test queued.
function stub(replies) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    if (String(url).endsWith('/models')) {
      return { ok: true, status: 200, json: async () => ({ data: [
        { id: 'llama-3.1-8b-instant', created: 900, active: true },
        { id: 'newest-70b-versatile', created: 800, active: true },
        { id: 'whisper-large-v3',     created: 999, active: true },
        { id: 'older-70b',            created: 100, active: true },
      ] }) };
    }
    const next = replies.shift();
    if (next?.status && next.status !== 200) {
      return { ok: false, status: next.status, text: async () => next.body || '' };
    }
    return { ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: next?.content ?? '[]' } }] }) };
  };
  return calls;
}

const h = (title, inst, sev = 1) => ({ title, inst, sev, at: 1 });

(async () => {
  // ── The model list, because a hardcoded id dies ────────────────────────────
  // This project already shipped a dropdown full of retired Groq ids once.
  {
    const calls = stub([{ content: '[]' }]);
    const d = new NewsDirection({ apiKey: 'k' });
    await d.label([h('Gold rises', ['XAU/USD'])]);
    check('the model is fetched, not hardcoded', calls[0].url.endsWith('/models'));
    check('speech models are not used as chat models', d.model !== 'whisper-large-v3', d.model);
    check('and the newest full-size model wins over a newer small one',
      d.model === 'newest-70b-versatile', d.model);
  }

  // ── The label ─────────────────────────────────────────────────────────────
  {
    stub([{ content: '[{"i":0,"d":{"USOIL":"down"},"w":"ceasefire eases supply risk"}]' }]);
    const d = new NewsDirection({ apiKey: 'k' });
    const items = [h('Oil slides after U.S.-Iran ceasefire report', ['USOIL'], 2)];
    const out = await d.label(items);
    check('a headline comes back with a direction', items[0].dir?.USOIL === 'down',
      JSON.stringify(items[0].dir));
    check('and a short reason', items[0].why === 'ceasefire eases supply risk', items[0].why);
    check('the count is reported', out.labelled === 1, JSON.stringify(out));
  }

  // ── Containment ───────────────────────────────────────────────────────────
  {
    // An instrument the tagger never assigned is a trade the model invented.
    stub([{ content: '[{"i":0,"d":{"USOIL":"down","US500":"up"},"w":"x"}]' }]);
    const d = new NewsDirection({ apiKey: 'k' });
    const items = [h('Oil slides', ['USOIL'])];
    await d.label(items);
    check('a direction for an untagged instrument is dropped',
      items[0].dir?.USOIL === 'down' && !('US500' in items[0].dir), JSON.stringify(items[0].dir));
  }
  {
    stub([{ content: '[{"i":9,"d":{"XAU/USD":"up"},"w":"x"}]' }]);
    const d = new NewsDirection({ apiKey: 'k' });
    const items = [h('Gold rises', ['XAU/USD'])];
    await d.label(items);
    check('an index outside the batch labels nothing', !items[0].dir);
  }
  {
    stub([{ content: '[{"i":0,"d":{"XAU/USD":"maybe"},"w":"x"}]' }]);
    const d = new NewsDirection({ apiKey: 'k' });
    const items = [h('Gold rises', ['XAU/USD'])];
    await d.label(items);
    check('a direction that is neither up nor down is dropped', !items[0].dir,
      JSON.stringify(items[0].dir));
  }
  {
    // "flat" is a real answer and the prompt asks for it. It must leave the
    // headline with no direction rather than inventing one.
    stub([{ content: '[{"i":0,"d":{"XAU/USD":"flat"},"w":"no clear implication"}]' }]);
    const d = new NewsDirection({ apiKey: 'k' });
    const items = [h('Gold steady ahead of data', ['XAU/USD'])];
    await d.label(items);
    check('"flat" means no direction, and the reason still lands',
      !items[0].dir && items[0].why === 'no clear implication', JSON.stringify(items[0]));
  }

  // ── Prose around the JSON, which is the common case ───────────────────────
  {
    check('a fenced block parses',
      NewsDirection.parse('```json\n[{"i":0}]\n```').length === 1);
    check('so does a preamble',
      NewsDirection.parse('Sure! Here you go:\n[{"i":1}]').length === 1);
    check('and malformed JSON costs the batch, not the process',
      NewsDirection.parse('[{"i":0,') .length === 0);
    check('and no JSON at all is empty', NewsDirection.parse('I cannot help with that.').length === 0);
  }

  // ── Failure leaves yesterday's behaviour ──────────────────────────────────
  {
    stub([{ status: 429, body: 'rate limited' }]);
    const d = new NewsDirection({ apiKey: 'k', log: () => {} });
    const items = [h('Gold rises', ['XAU/USD'])];
    const out = await d.label(items);
    check('a rate limit leaves the headline unlabelled and does not throw',
      !items[0].dir && out.labelled === 0);
  }
  {
    const d = new NewsDirection({ apiKey: null, log: () => {} });
    const items = [h('Gold rises', ['XAU/USD'])];
    global.fetch = async () => { throw new Error('should not be called'); };
    const out = await d.label(items);
    check('no key means no request at all', out.labelled === 0 && !items[0].dir);
  }

  // ── Paid for once ─────────────────────────────────────────────────────────
  // A headline survives many cycles in the top sixty; it must be sent once.
  {
    const calls = stub([{ content: '[{"i":0,"d":{"XAU/USD":"up"},"w":"weak dollar"}]' }]);
    const d = new NewsDirection({ apiKey: 'k' });
    const first = [h('Gold rises on a weaker dollar', ['XAU/USD'])];
    await d.label(first);
    const before = calls.length;
    const second = [h('Gold rises on a weaker dollar', ['XAU/USD'])];
    await d.label(second);
    check('a headline already labelled is not sent again', calls.length === before,
      `${before} → ${calls.length}`);
    check('but it keeps its label across cycles', second[0].dir?.['XAU/USD'] === 'up',
      JSON.stringify(second[0].dir));
  }

  // Untagged headlines are never sent: without an instrument there is nothing
  // to be bullish about.
  {
    const calls = stub([{ content: '[]' }]);
    const d = new NewsDirection({ apiKey: 'k' });
    await d.label([h('Zoetis earnings reveal a divided business', [])]);
    check('an untagged headline costs nothing', calls.length === 0, String(calls.length));
  }

  // ── Bounded per cycle ─────────────────────────────────────────────────────
  {
    const calls = stub([{ content: '[]' }, { content: '[]' }, { content: '[]' }]);
    const d = new NewsDirection({ apiKey: 'k' });
    const many = Array.from({ length: BATCH * 5 }, (_, i) => h(`Story ${i}`, ['XAU/USD']));
    const out = await d.label(many);
    const chats = calls.filter(c => !c.url.endsWith('/models')).length;
    check('at most two batches go out per cycle', chats <= MAX_BATCHES, String(chats));
    check('and the rest are reported as deferred, not silently dropped',
      out.skipped === BATCH * 5 - MAX_BATCHES * BATCH, String(out.skipped));
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('  FAIL  threw —', e.stack.split('\n').slice(0, 3).join(' ')); process.exit(1); });

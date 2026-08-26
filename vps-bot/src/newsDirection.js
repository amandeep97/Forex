'use strict';
// vps-bot/src/newsDirection.js
//
// Which way a headline points, for the instruments it is about.
//
// Everything else in this project decides that with a word list. A word list
// cannot tell "OPEC raises output" from "OPEC cuts output" — same words, same
// severity, opposite trades — and it never will, because the difference is in
// the meaning rather than the vocabulary.
//
// So the headline is read by a model instead. That is a genuine step up in what
// this can do and a genuine step DOWN in how much it can be trusted: a model
// returns a fluent, confident answer whether or not it knows anything, which is
// exactly the failure mode that put "crowded long — the side that unwinds
// badly" onto a card as though it were a finding.
//
// The whole design therefore assumes the labels are worthless until measured.
// They are stamped onto the headline, archived beside it, and a study reads the
// archive in a few weeks and asks what actually followed the ones called
// bearish. If the answer is nothing, the direction comes off the cards and this
// file goes with it. Adding it without that plan would be the same mistake in a
// more expensive form.
//
// Cheap on purpose: only headlines never seen before are sent, batched, at most
// twice per cycle. That is roughly a hundred and fifty calls a day, well inside
// a free tier.

const fetch = require('node-fetch');

const BASE = 'https://api.groq.com/openai/v1';
const BATCH = 15;          // headlines per request
const MAX_BATCHES = 2;     // per news cycle
const MAX_INSTRUMENTS = 3; // per headline, so a macro fan-out cannot bloat the prompt
const TIMEOUT = 25000;

// No hardcoded model id.
//
// Groq retires models on a schedule; this project already shipped a dropdown
// full of dead ids once and spent a morning on it. The list is fetched, speech
// and moderation models are dropped, and the newest full-size chat model wins.
// Cached for the life of the process and re-picked if a request comes back
// saying the model is gone.
const NOT_CHAT = /whisper|^distil|tts|guard|embed|moderation|^playai/i;
const SPEED_TIER = /instant|mini|nano|\b[1-9]b\b/i;

class NewsDirection {
  constructor({ apiKey, log = () => {} }) {
    this.apiKey = apiKey || null;
    this.log = log;
    this.model = null;
    this.warned = false;
    // Titles already labelled, so a headline is paid for once however many
    // cycles it survives in the top sixty.
    this.seen = new Map();
  }

  enabled() { return !!this.apiKey; }

  async _pickModel(force = false) {
    if (this.model && !force) return this.model;
    const r = await fetch(`${BASE}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` }, timeout: TIMEOUT,
    });
    if (!r.ok) throw new Error(`models ${r.status}`);
    const body = await r.json();
    const usable = (body?.data || [])
      .filter(m => !NOT_CHAT.test(m.id || '') && m.active !== false)
      // Full-size first, then newest. Written the other way round this picked
      // the 8b speed model over a 70b one purely because the small one was
      // published later — the sort read as "prefer speed tier" when it was
      // meant to read "demote it".
      .sort((a, b) => (SPEED_TIER.test(b.id) ? 0 : 1) - (SPEED_TIER.test(a.id) ? 0 : 1)
                   || (b.created || 0) - (a.created || 0));
    if (!usable.length) throw new Error('no chat model available');
    this.model = usable[0].id;
    this.log(`News direction: using ${this.model}`);
    return this.model;
  }

  // A model returns prose around JSON as often as not, and a stray fence or a
  // sentence of preamble must not cost the whole batch.
  static parse(text) {
    if (!text) return [];
    const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    try {
      const rows = JSON.parse(cleaned.slice(start, end + 1));
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  _prompt(batch) {
    const lines = batch.map((h, i) =>
      `${i}. [${h.inst.slice(0, MAX_INSTRUMENTS).join(', ')}] ${h.title}`
      + (h.desc ? ` — ${String(h.desc).slice(0, 160)}` : ''));
    return [
      { role: 'system', content:
        'You label financial headlines by direction. For each numbered headline, '
        + 'decide for EACH instrument in its brackets whether the news is bullish '
        + '("up"), bearish ("down"), or unclear ("flat") FOR THAT INSTRUMENT. '
        + 'A stronger dollar is bearish for XAU/USD and for EUR/USD. '
        + 'Reply with ONLY a JSON array, one object per headline: '
        + '{"i":<number>,"d":{"<instrument>":"up|down|flat"},"w":"<max 8 words>"}. '
        + 'Use "flat" freely — most headlines do not clearly imply a direction, '
        + 'and a guess is worse than saying so.' },
      { role: 'user', content: lines.join('\n') },
    ];
  }

  async _call(batch) {
    const model = await this._pickModel();
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', timeout: TIMEOUT,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 1200, messages: this._prompt(batch),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // A decommissioned model is the one failure worth retrying differently.
      if (res.status === 404 || /decommission|not found|does not exist/i.test(body)) {
        this.log(`News direction: ${model} is gone, re-picking`);
        this.model = null;
        await this._pickModel(true);
      }
      throw new Error(`chat ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = await res.json();
    return NewsDirection.parse(data?.choices?.[0]?.message?.content);
  }

  // Attaches { dir: {instrument: 'up'|'down'}, why } to headlines that have an
  // instrument tag and have not been labelled before. Mutates nothing it does
  // not own, throws nothing: a failure leaves headlines unlabelled, which is
  // the state they were in yesterday.
  async label(headlines) {
    if (!this.enabled()) {
      if (!this.warned) {
        this.warned = true;
        this.log('News direction: not labelling — GROQ_API_KEY is unset');
      }
      return { labelled: 0, skipped: headlines.length };
    }

    const keyOf = h => String(h.title || '').toLowerCase().slice(0, 60);
    // Re-apply what is already known before deciding what is new, so a headline
    // keeps its label for as long as it stays on the board.
    const todo = [];
    for (const h of headlines) {
      if (!h.inst?.length) continue;
      const known = this.seen.get(keyOf(h));
      if (known) { h.dir = known.dir; h.why = known.why; continue; }
      todo.push(h);
    }
    if (!todo.length) return { labelled: 0, skipped: 0 };

    let labelled = 0;
    for (let b = 0; b < MAX_BATCHES && b * BATCH < todo.length; b++) {
      const batch = todo.slice(b * BATCH, (b + 1) * BATCH);
      let rows = [];
      try {
        rows = await this._call(batch);
      } catch (e) {
        this.log(`News direction: batch failed (${e.message})`);
        break;
      }
      for (const row of rows) {
        const h = batch[Number(row?.i)];
        if (!h || !row?.d || typeof row.d !== 'object') continue;
        // Only directions for instruments the tagger actually assigned. A model
        // inventing an instrument is a model inventing a trade.
        const dir = {};
        for (const [inst, d] of Object.entries(row.d)) {
          if (!h.inst.includes(inst)) continue;
          if (d === 'up' || d === 'down') dir[inst] = d;
        }
        const why = String(row.w || '').slice(0, 60);
        if (!Object.keys(dir).length && !why) continue;
        if (Object.keys(dir).length) h.dir = dir;
        if (why) h.why = why;
        this.seen.set(keyOf(h), { dir: h.dir, why: h.why });
        labelled++;
      }
    }

    // The cache is per process and must not grow without bound.
    if (this.seen.size > 4000) {
      for (const k of [...this.seen.keys()].slice(0, this.seen.size - 2000)) this.seen.delete(k);
    }
    const over = Math.max(0, todo.length - MAX_BATCHES * BATCH);
    if (labelled) this.log(`News direction: labelled ${labelled}${over ? `, ${over} deferred` : ''}`);
    return { labelled, skipped: over };
  }
}

module.exports = { NewsDirection, BATCH, MAX_BATCHES, MAX_INSTRUMENTS };

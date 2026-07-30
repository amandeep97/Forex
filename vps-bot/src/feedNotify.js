'use strict';
// vps-bot/src/feedNotify.js
// Pushes when YOUR filter matches — not when the market merely moved.
//
// The rules are not reimplemented here. They are loaded from
// shared/feedConditions.mjs, the same module the app imports to draw the list,
// via a dynamic import() (ESM from CommonJS, fine on Node 18+). Writing a
// second evaluator in CommonJS would have been quicker and would eventually
// have sent a notification for something the screen did not show — which is
// worse than no notification at all, because it teaches you to distrust both.
//
// The app publishes its filters to bot/feed-filters.json. Only those you have
// explicitly marked for push are evaluated here.

const path = require('path');
const { pathToFileURL } = require('url');
const { configurePush, sendPush } = require('./push');
const { bySymbol } = require('./instruments');

const FILTERS_PATH  = 'bot/feed-filters.json';
const NOTIFIED_PATH = 'bot/feed-notified.json';
const SUBS_PATH     = 'bot/push-subscriptions.json';

const SHARED = pathToFileURL(path.join(__dirname, '..', '..', 'shared', 'feedConditions.mjs')).href;

// Keys older than this are forgotten. They only exist to stop a repeat push for
// the same fact, and a fact whose event has long since aged out of the feed can
// never match again anyway.
const FORGET_MS = 30 * 24 * 3600e3;

// A notification that lists forty instruments is not a notification.
const MAX_LISTED = 6;

class FeedNotifier {
  constructor({ github, telegram, env, log }) {
    this.github = github;
    this.telegram = telegram || null;
    this.log = log || (() => {});
    this.pushReady = configurePush(env);
    this.telegramOn = !!(this.telegram && this.telegram.enabled);
    this.conditions = null;
    this.notified = null;      // { seeded, keys: { key: ts } }
    this.notifiedSha = null;
    this.filtersSha = null;
  }

  async _shared() {
    if (!this.conditions) this.conditions = await import(SHARED);
    return this.conditions;
  }

  async _loadNotified() {
    if (this.notified) return this.notified;
    try {
      const f = await this.github.readJSON(NOTIFIED_PATH);
      this.notified = f?.content?.keys ? f.content : { seeded: false, keys: {} };
      this.notifiedSha = f?.sha || null;
    } catch { this.notified = { seeded: false, keys: {} }; }
    return this.notified;
  }

  // Everything currently matching is recorded WITHOUT notifying the first time.
  // Otherwise switching push on, or restarting the bot, empties the whole
  // current state of the market onto your lock screen at once.
  async _seed(matches) {
    const now = Date.now();
    for (const m of matches) this.notified.keys[m.key] = now;
    this.notified.seeded = true;
    await this._saveNotified(`bot: seed feed notifications (${matches.length} already matching)`);
    this.log(`Feed push: seeded ${matches.length} existing match(es) without notifying`);
  }

  async _saveNotified(message) {
    const cutoff = Date.now() - FORGET_MS;
    for (const [k, ts] of Object.entries(this.notified.keys)) {
      if (ts < cutoff) delete this.notified.keys[k];
    }
    try {
      this.notifiedSha = await this.github.writeJSON(
        NOTIFIED_PATH, { ...this.notified, updatedAt: new Date().toISOString() }, message, this.notifiedSha);
    } catch (e) {
      this.log(`Feed push: could not save notified state (${e.message})`);
      this.notifiedSha = null;   // force a SHA re-read next time
    }
  }

  // `data` is the feed builder's live instrument map — no re-fetch, no second
  // measurement, so a push can only ever describe what the feed already says.
  async run(data) {
    if (!this.pushReady && !this.telegramOn) return;
    if (!data || !Object.keys(data).length) return;

    const fFile = await this.github.readJSON(FILTERS_PATH).catch(() => null);
    const filters = (fFile?.content?.filters || []).filter(f => f && f.push && (f.conditions || []).length);
    this.filtersSha = fFile?.sha || null;
    if (!filters.length) return;

    let mod;
    try { mod = await this._shared(); }
    catch (e) { this.log(`Feed push: shared rules not loadable (${e.message}) — run git pull on the VPS`); return; }
    const { evaluateOne, matchKey } = mod;

    await this._loadNotified();

    // Evaluate every published instrument against every push-enabled filter
    const matches = [];
    for (const f of filters) {
      const scope = f.classes?.length ? new Set(f.classes) : null;
      for (const [sym, rec] of Object.entries(data)) {
        // Fall back to the registry exactly as the app does. Records written
        // before identity was stamped at creation carry no class, and reading
        // rec.cls alone would skip them here while the app still showed them.
        if (scope && !scope.has(rec.cls || bySymbol(sym)?.cls)) continue;
        let ev;
        try { ev = evaluateOne(rec, f); } catch { continue; }
        if (!ev.matched) continue;
        matches.push({ key: matchKey(sym, f.id, ev), sym, filter: f, ev });
      }
    }

    if (!this.notified.seeded) { await this._seed(matches); return; }

    const fresh = matches.filter(m => !this.notified.keys[m.key]);
    if (!fresh.length) return;

    const subs = this.pushReady ? await this._subs() : { list: [], sha: null };
    const dead = new Set();
    const now = Date.now();

    // One notification per filter, listing what newly matched. At an H4 boundary
    // several instruments can turn over at once, and six separate buzzes for one
    // event is how a useful alert becomes one you swipe away without reading.
    for (const f of filters) {
      const mine = fresh.filter(m => m.filter.id === f.id);
      if (!mine.length) continue;

      const names = mine.map(m => m.sym);
      const shown = names.slice(0, MAX_LISTED).join(', ');
      const more  = names.length > MAX_LISTED ? ` +${names.length - MAX_LISTED} more` : '';
      const why   = mine[0].ev.passed.map(p => p.label).join(' + ');
      const title = `📋 ${f.name} — ${names.length} match${names.length > 1 ? 'es' : ''}`;
      const body  = `${shown}${more}\n${why}`;

      this.log(`Feed push: "${f.name}" → ${names.join(', ')}`);

      if (this.pushReady && subs.list.length) {
        const r = await sendPush(subs.list, title, body);
        r.dead.forEach(e => dead.add(e));
      }
      if (this.telegramOn) {
        await this.telegram.send(`📋 <b>${f.name}</b>\n${shown}${more}\n<i>${why}</i>`).catch(() => {});
      }
      for (const m of mine) this.notified.keys[m.key] = now;
    }

    await this._saveNotified('bot: feed notification sent');

    if (dead.size) {
      const cleaned = subs.list.filter(s => !dead.has(s.endpoint));
      await this.github.writeJSON(SUBS_PATH, { subscriptions: cleaned }, 'bot: prune dead subscriptions', subs.sha)
        .catch(() => {});
    }
  }

  // Deliver a notification on demand, so push can be proven end to end without
  // waiting for a market event. The count matters more than the message: a
  // result of "0 devices" is the difference between "push is broken" and
  // "nothing has matched yet", which are otherwise indistinguishable from the
  // app and have very different fixes.
  async sendTest() {
    if (!this.pushReady && !this.telegramOn) {
      return { ok:false, devices:0, detail:'no VAPID keys and no Telegram configured on the VPS' };
    }
    const subs = this.pushReady ? await this._subs() : { list: [], sha: null };
    const body = 'If you can read this, your filters can reach this device.';
    let sent = 0;
    const dead = new Set();

    if (this.pushReady && subs.list.length) {
      const r = await sendPush(subs.list, '✅ ForexPro test', body);
      sent = r.sent;
      r.dead.forEach(e => dead.add(e));
    }
    if (this.telegramOn) await this.telegram.send(`✅ <b>ForexPro test</b>\n${body}`).catch(() => {});

    if (dead.size) {
      const cleaned = subs.list.filter(s => !dead.has(s.endpoint));
      await this.github.writeJSON(SUBS_PATH, { subscriptions: cleaned },
        'bot: prune dead subscriptions', subs.sha).catch(() => {});
    }

    this.log(`Feed push test: ${sent} delivered, ${dead.size} dead, telegram=${this.telegramOn}`);
    return {
      ok: sent > 0 || this.telegramOn,
      devices: sent,
      registered: subs.list.length,
      pruned: dead.size,
      telegram: this.telegramOn,
      detail: sent > 0 ? `delivered to ${sent} device(s)`
        : subs.list.length ? `${subs.list.length} device(s) registered but none accepted delivery`
        : 'no devices registered — enable push in the app first',
    };
  }

  async _subs() {
    try {
      const f = await this.github.readJSON(SUBS_PATH);
      return { list: f?.content?.subscriptions || [], sha: f?.sha || null };
    } catch { return { list: [], sha: null }; }
  }
}

module.exports = { FeedNotifier, FILTERS_PATH, NOTIFIED_PATH };

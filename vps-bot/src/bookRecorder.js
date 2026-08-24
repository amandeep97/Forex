'use strict';
// vps-bot/src/bookRecorder.js
//
// Writes down where OANDA's clients are positioned, so that one day the
// question can be asked.
//
// This is the only real sentiment data in the project — actual retail books,
// not a number inferred from the same candles everyone else has. The app has
// been fetching it live in the browser for months and throwing every reading
// away the moment the tab closed. So "what followed a crowded retail long" has
// never been answerable here, and never could be: no past state existed.
//
// Nothing in this file measures anything. It is a recorder. The study that
// reads it cannot be written for another two or three months, and saying so is
// the honest version of shipping it — the alternative was to keep offering a
// study of data that does not exist, which I did twice today before checking.
//
// Deliberately small. One number per instrument per sample: the share of
// accounts long. The full book is hundreds of price buckets and this file has
// to survive being rewritten for months.

const BOOK_PATH = 'bot/position-history.json';

// Every four hours. The book moves slowly — it is a census of open accounts,
// not a tick stream — and six samples a day for ninety days across thirty
// instruments is about a quarter of a megabyte. Sampling every minute would
// produce a file nobody could ship and no more information.
const SAMPLE_MS = 4 * 3600e3;
const KEEP_DAYS = 120;

class BookRecorder {
  constructor({ oanda, github, instruments, log }) {
    this.oanda = oanda;
    this.github = github;
    this.instruments = instruments;
    this.log = log || (() => {});
    this.sha = null;
    this.lastRun = 0;
    // Instruments whose book OANDA refuses. Recorded once and not retried every
    // pass — a refusal is a property of the account, not a transient failure,
    // and hammering thirty endpoints for a 403 apiece helps nobody.
    this.refused = new Set();
  }

  due(now = Date.now()) {
    return now - this.lastRun >= SAMPLE_MS;
  }

  async tick(now = Date.now()) {
    if (!this.due(now)) return null;
    this.lastRun = now;

    // OANDA instruments only. Crypto and the stock perps come from Binance,
    // which has no equivalent of a retail position book.
    const targets = this.instruments.filter(i => i.oanda && !this.refused.has(i.sym));
    if (!targets.length) return null;

    const samples = [];
    const failures = [];
    for (const inst of targets) {
      const b = await this.oanda.getPositionBook(inst.oanda);
      if (!b) { this.refused.add(inst.sym); failures.push(`${inst.sym}: empty`); continue; }
      if (b.error) {
        // A 4xx is the account not being entitled; anything else may be
        // transient, so only the former is remembered as a refusal.
        if (/\b4\d\d\b/.test(b.error)) this.refused.add(inst.sym);
        failures.push(`${inst.sym}: ${b.error}`);
        continue;
      }
      samples.push({ sym: inst.sym, t: b.t, longPct: b.longPct, price: b.price });
    }

    if (!samples.length) {
      this.log(`Book: no instrument returned a position book (${failures.slice(0, 3).join('; ')})`);
      return null;
    }

    let prev = { version: 1, samples: {} };
    try {
      const cur = await this.github.readJSON(BOOK_PATH).catch(() => null);
      if (cur?.content?.samples) prev = cur.content;
      this.sha = cur?.sha || null;
    } catch { /* first run — start fresh rather than lose today's sample */ }

    // Stored per symbol as [t, longPct, price] triples: an array of arrays is
    // roughly a third the size of an array of objects, and this file is written
    // every four hours for months.
    const cutoff = now - KEEP_DAYS * 86400e3;
    let dropped = 0;
    const out = {};
    for (const [sym, rows] of Object.entries(prev.samples || {})) {
      const kept = rows.filter(r => r[0] >= cutoff);
      dropped += rows.length - kept.length;
      if (kept.length) out[sym] = kept;
    }
    for (const s of samples) {
      (out[s.sym] ||= []).push([s.t, s.longPct, s.price]);
    }

    const total = Object.values(out).reduce((n, r) => n + r.length, 0);
    const payload = {
      version: 1,
      updatedAt: new Date(now).toISOString(),
      sampleEveryMs: SAMPLE_MS,
      keepDays: KEEP_DAYS,
      // Named so a future study does not have to guess the column order.
      columns: ['t', 'longPct', 'price'],
      instruments: Object.keys(out).length,
      total,
      // What was asked for and refused, so an empty series reads as "the
      // account is not entitled" rather than as "retail had no opinion".
      refused: [...this.refused],
      samples: out,
    };

    try {
      this.sha = await this.github.writeJSON(BOOK_PATH, payload,
        `bot: position book (${samples.length} instruments)`, this.sha, { pretty: false });
      const span = spanOf(out);
      this.log(`Book: ${samples.length} sampled, ${total} rows over ${span} days`
        + `${dropped ? `, ${dropped} aged out` : ''}`
        + `${this.refused.size ? `, ${this.refused.size} refused` : ''}`);
    } catch (e) {
      this.log(`Book: write failed (${e.message})`);
      this.sha = null;
    }
    return payload;
  }
}

// How much history has actually accumulated. The only number that matters while
// this is still just collecting: a study of it is not worth writing until this
// reads sixty or more.
function spanOf(samples) {
  let lo = Infinity, hi = 0;
  for (const rows of Object.values(samples)) {
    for (const r of rows) { if (r[0] < lo) lo = r[0]; if (r[0] > hi) hi = r[0]; }
  }
  return hi > lo ? Math.round((hi - lo) / 86400e3) : 0;
}

module.exports = { BookRecorder, spanOf, BOOK_PATH, SAMPLE_MS, KEEP_DAYS };

// shared/sessions.mjs
// Which session a thing happened in — the one copy.
//
// This lived inside vps-bot/src/liquidityStudy.js, where the study used it to
// bucket sixty days of replayed entries. The live scanner never had it at all,
// and the app's hunt feed reached for `e.session` to look up the study's verdict
// for a row — a field nothing ever set, so every lookup missed. One definition,
// three readers, and the study's buckets and the screen's labels now mean the
// same thing by construction rather than by coincidence.
//
// ── Why not fixed UTC hours ─────────────────────────────────────────────────
//
// The original was `new Date(ms).getUTCHours()` against fixed boundaries. That
// is right for about half the year. London opens at 08:00 London time, which is
// 08:00 UTC in winter and 07:00 UTC in summer, so a fixed-UTC bucket puts an
// hour of every summer London session into Asia and an hour of every winter
// New York session into London. Two months a year the two zones disagree about
// whether it is summer at all.
//
// So the boundaries are read in the zone that owns them. A sweep at the London
// open is in the London session in June and in December.
//
// ── The honest limit ────────────────────────────────────────────────────────
//
// These are still four exclusive buckets on a clock, and a clock is a proxy for
// what is actually being asked: how much size is in the market. It is a good
// proxy and a cheap one. It is not the thing itself, and a public holiday in
// London is a quiet "London session" that this cannot see.

/** @type {{ id:'asia'|'london'|'ny'|'late', label:string, from:number, to:number }[]} */
const SESSION_HOURS = [
  { id: 'asia', label: 'Asia', from: 0, to: 7 },
  { id: 'london', label: 'London', from: 7, to: 12 },
  { id: 'ny', label: 'New York', from: 12, to: 17 },
  { id: 'late', label: 'Late/rollover', from: 17, to: 24 },
];

export const SESSIONS = SESSION_HOURS;

export const SESSION_LABEL = Object.fromEntries(SESSIONS.map(s => [s.id, s.label]));

const LONDON = 'Europe/London';
const NEWYORK = 'America/New_York';

const fmts = new Map();
function fmtFor(tz) {
  let f = fmts.get(tz);
  if (!f) {
    // hourCycle h23 rather than hour12:false — some engines render midnight as
    // "24" under hour12:false, which reads as a valid hour and is off by a day.
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
    fmts.set(tz, f);
  }
  return f;
}

// The replay asks this for every one of forty thousand bars an instrument, and
// Intl formatting is not free. The answer only changes on the hour, so it is
// cached on the hour. Bounded because a sixty-day replay would otherwise hold
// fourteen hundred entries per zone and never release them — which is small,
// but a cache with no bound is a leak waiting for a longer history.
const hourCache = new Map();
function hourIn(tz, ms) {
  const bucket = Math.floor(ms / 3600e3);
  const key = `${tz}|${bucket}`;
  const hit = hourCache.get(key);
  if (hit !== undefined) return hit;
  const h = Number(fmtFor(tz).format(new Date(ms)));
  if (hourCache.size > 20000) hourCache.clear();
  hourCache.set(key, h);
  return Number.isFinite(h) ? h : new Date(ms).getUTCHours();
}

/**
 * The session id for a moment, by London's clock.
 *
 * London is the anchor because it is the zone whose open the boundaries were
 * written around, and because the FX day is built on it.
 *
 * @param {number} ms epoch milliseconds
 * @returns {'asia'|'london'|'ny'|'late'}
 */
export function sessionOf(ms) {
  if (!Number.isFinite(ms)) return 'asia';
  const h = hourIn(LONDON, ms);
  return (SESSIONS.find(s => h >= s.from && h < s.to) || SESSIONS[0]).id;
}

/**
 * Is this moment inside the London/New York overlap — both desks open at once?
 *
 * This is the part of the day that actually matters for gold and the indices:
 * the deepest book and the largest share of the day's range. A sweep here and
 * a sweep at 03:00 are different events wearing the same name, and nothing in
 * the four-bucket split says so, because "ny" covers both the overlap and the
 * thin hours after London has gone home.
 *
 * Both zones are read in their own time, so this is right in both DST regimes
 * and in the fortnight each spring and autumn when they disagree.
 *
 * @param {number} ms
 */
export function inOverlap(ms) {
  if (!Number.isFinite(ms)) return false;
  const lon = hourIn(LONDON, ms);
  const ny = hourIn(NEWYORK, ms);
  return lon >= 8 && lon < 17 && ny >= 8 && ny < 17;
}

/**
 * Everything about when, as one object — what a row wants to carry.
 *
 * @param {number} ms
 */
export function sessionStamp(ms) {
  if (!Number.isFinite(ms)) return null;
  const id = sessionOf(ms);
  return { id, label: SESSION_LABEL[id] || id, overlap: inOverlap(ms) };
}

// shared/moveFeatures.mjs
// What is true about an instrument at a given bar — the one copy.
//
// Every study in this project so far has taken a hypothesis somebody else wrote
// down (candle patterns, COT extremes, the gold-silver ratio, hour of day),
// tested it over five years, and come back with "no". That is confirmatory
// testing. It can only rule out things already in the vocabulary, and it
// averages over five years, so anything that started working in March is buried
// under four years of when it did not.
//
// This file is the other approach. It does not name a pattern. It describes the
// STATE of the market at every bar in terms that are computable in real time,
// and leaves it to the study to find which states precede the moves — searching
// on one half of recent history and proving on a half it never looked at.
//
// Two rules govern everything here:
//
//   Nothing may use a bar later than `i`. Not the close of bar i+1, not the
//   zigzag pivot that will not be confirmed for another ten bars. A feature that
//   cheats forward is a feature that cannot be traded, and it will look
//   wonderful right up until it is real money.
//
//   Everything is in ATR, never in dollars. Gold at $2,000 and silver at $25
//   have to produce comparable numbers or the pooled answer is just gold.
//
// ESM and nothing else — no DOM, no fetch, no Node APIs. The app imports it
// directly; the bot loads it with a dynamic import(), the same route
// shared/feedConditions.mjs already takes.

import { macroBuckets, MACRO_PHRASE } from './macroFit.mjs';
import { patternsAt, PATTERN_MAP, detectStrongReversal } from './candlePatterns.mjs';

export const ATR_LEN = 14;
export const EMA_LEN = 50;
export const DRIVE_BARS = 12;      // half a day on H1 — the run into now
export const SWEEP_BARS = 3;       // how recently a level had to be taken
export const VOL_LOOKBACK = 480;   // ~20 trading days of H1, for the vol regime
export const REV_N = 5;            // the prior range a strong reversal must clear

// ── Series ──────────────────────────────────────────────────────────────────

// True range needs the previous close, so index 0 has none. Aligned to `cs`,
// null where there is not yet enough history — a null is a refusal, and every
// caller must skip rather than substitute a zero.
export function atrSeries(cs, len = ATR_LEN) {
  const out = new Array(cs.length).fill(null);
  const tr = new Array(cs.length).fill(null);
  for (let i = 1; i < cs.length; i++) {
    const pc = cs[i - 1].c;
    tr[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - pc), Math.abs(cs[i].l - pc));
  }
  let sum = 0;
  for (let i = 1; i < cs.length; i++) {
    sum += tr[i];
    if (i > len) sum -= tr[i - len];
    if (i >= len) out[i] = sum / len;
  }
  return out;
}

export function emaSeries(cs, len = EMA_LEN) {
  const out = new Array(cs.length).fill(null);
  if (cs.length < len) return out;
  const k = 2 / (len + 1);
  let e = 0;
  for (let i = 0; i < len; i++) e += cs[i].c;
  e /= len;
  out[len - 1] = e;
  for (let i = len; i < cs.length; i++) { e = cs[i].c * k + e * (1 - k); out[i] = e; }
  return out;
}

// The median ATR of the trailing month, so "hot" means hot for this instrument
// lately rather than hot against a five-year average that includes a crisis.
// Trailing only: a bar cannot be ranked against a month it has not lived.
function volBaseline(atr, lookback = VOL_LOOKBACK) {
  const out = new Array(atr.length).fill(null);
  for (let i = 0; i < atr.length; i++) {
    if (i < lookback) continue;
    const win = [];
    for (let j = i - lookback; j < i; j++) if (atr[j] != null) win.push(atr[j]);
    if (win.length < lookback / 2) continue;
    win.sort((a, b) => a - b);
    out[i] = win[Math.floor(win.length / 2)];
  }
  return out;
}

// ── Calendar structure ──────────────────────────────────────────────────────
// "Yesterday's high" means the previous SESSION's high, not the previous
// calendar date's — otherwise every Monday compares against an empty Sunday and
// the level is undefined exactly when the week's first sweep happens.

const dayKey = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; };

function weekKey(t) {
  const d = new Date(t);
  // Week starting Sunday 22:00 UTC is the FX week, but a plain ISO week is
  // enough here and is not off by a session at the boundary the way a
  // rolling-168-hour window would be.
  const day = d.getUTCDay();
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 86400e3;
  return String(start);
}

// For every bar: the previous period's high and low, and the running high and
// low of the period the bar is in (up to and including the bar itself).
function periodLevels(cs, keyOf) {
  const prevHi = new Array(cs.length).fill(null);
  const prevLo = new Array(cs.length).fill(null);
  const runHi  = new Array(cs.length).fill(null);
  const runLo  = new Array(cs.length).fill(null);

  let curKey = null, cHi = -Infinity, cLo = Infinity;
  let pHi = null, pLo = null;

  for (let i = 0; i < cs.length; i++) {
    const k = keyOf(cs[i].t);
    if (k !== curKey) {
      if (curKey !== null) { pHi = cHi; pLo = cLo; }
      curKey = k; cHi = -Infinity; cLo = Infinity;
    }
    cHi = Math.max(cHi, cs[i].h);
    cLo = Math.min(cLo, cs[i].l);
    prevHi[i] = pHi; prevLo[i] = pLo;
    runHi[i] = cHi;  runLo[i] = cLo;
  }
  return { prevHi, prevLo, runHi, runLo };
}

// ── Buckets ─────────────────────────────────────────────────────────────────
// Every feature comes out as one of a small set of labels rather than a number.
// A condition has to be countable to have a base rate, and "stretch = 1.7" is
// not something that ever happens twice.

const bucket = (v, cuts, labels) => {
  if (v == null || !Number.isFinite(v)) return null;
  for (let i = 0; i < cuts.length; i++) if (v < cuts[i]) return labels[i];
  return labels[labels.length - 1];
};

export function sessionOf(hour) {
  if (hour >= 0 && hour < 7) return 'asia';
  if (hour < 12) return 'london';
  if (hour < 17) return 'ny-am';       // the overlap
  if (hour < 21) return 'ny-pm';
  return 'late';
}

// Round numbers people actually watch.
//
// The first version of this fixed the grid at $25 for gold and fifty cents for
// silver, and asked whether price was within a quarter of an ATR of one. Both
// halves were wrong, and the live study showed it in the first line of its own
// output: "sitting on a round number" was true on 38.6% of gold bars this year
// against 12% in the three years before, and 60.2% of silver bars against 13%
// — the largest change on the board, and pure measurement artefact.
//
// Gold is $4,524 now and was $1,800 three years ago. A $25 grid at $1,800 is
// something a trader watches; at $4,524 it is a rounding error, and nobody has
// ever said "gold is holding 4,525". Worse, hourly ATR on gold is now $25.6 —
// the entire grid spacing — so "within a quarter of an ATR of a $25 level" is
// true half the time, and on silver nearly always. The feature had stopped
// carrying any information at all, while reading as the year's biggest change.
//
// So: the grid scales with price, and proximity is a fraction of the grid
// rather than of ATR. Both are then scale-free, and a doubling in price cannot
// move the frequency. Near one percent of price, snapped to a 1/2/5 — gold at
// $4,524 gets $50 levels, at $1,800 it gets $20; silver at $68 gets 50c, at $25
// it gets 20c. Which is what people actually quote.
const ROUND_INSTRUMENTS = new Set(['XAU_USD', 'XAG_USD', 'XPT_USD', 'XPD_USD']);
export const ROUND_NEAR = 0.08;      // within 8% of the spacing, either side

export function roundStepFor(sym, price) {
  if (!ROUND_INSTRUMENTS.has(sym) || !(price > 0)) return null;
  const target = price * 0.01;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  let best = null;
  for (const m of [1, 2, 5, 10]) {
    const s = m * mag;
    if (best === null || Math.abs(Math.log(s / target)) < Math.abs(Math.log(best / target))) best = s;
  }
  return best;
}

// ── The feature pass ────────────────────────────────────────────────────────

/**
 * Build the per-bar state for one instrument.
 *
 * @param cs      candles, ascending, complete only
 * @param sym     OANDA name, for the round-number grid
 * @param partner the other metal's candles (optional). Time-aligned by
 *                timestamp, never by index — the two do not print identical bars
 *                and pairing by position silently compares Tuesday to Wednesday.
 * @param macro   the result of macroSeries() for this instrument (optional).
 *                Indexed on the same bars, so what the dollar and the ten-year
 *                explain — and what they do not — becomes a condition the
 *                holdout can score alongside the price-structure ones, rather
 *                than another number on a screen nobody checked.
 * @returns array aligned to `cs`; entries are null where a feature could not be
 *          computed from history alone, which is a real state and not a zero.
 */
export function featureSeries(cs, { sym = null, partner = null, macro = null } = {}) {
  const atr = atrSeries(cs);
  const ema = emaSeries(cs);
  const vb  = volBaseline(atr);
  const day = periodLevels(cs, dayKey);
  const wk  = periodLevels(cs, weekKey);

  // The partner's close at or before each of our timestamps. Built once by
  // merge rather than searched per bar.
  const pAt = new Array(cs.length).fill(null);
  if (partner?.length) {
    let j = 0;
    for (let i = 0; i < cs.length; i++) {
      while (j + 1 < partner.length && partner[j + 1].t <= cs[i].t) j++;
      // Only if the partner's bar is genuinely near ours. A stale quote from
      // six hours ago is not confirmation of anything.
      pAt[i] = partner[j] && Math.abs(partner[j].t - cs[i].t) <= 2 * 3600e3 ? partner[j].c : null;
    }
  }

  const out = new Array(cs.length).fill(null);
  for (let i = 0; i < cs.length; i++) {
    const a = atr[i];
    if (!a || !(a > 0)) continue;
    const c = cs[i].c;
    const d = new Date(cs[i].t);
    const hour = d.getUTCHours();

    // Volatility regime, against this instrument's own trailing month.
    const volRel = vb[i] ? a / vb[i] : null;

    // How far price has run from the mean it usually returns to.
    const stretch = ema[i] != null ? (c - ema[i]) / a : null;

    // Where in the day's range so far the bar closed. The extremes of this are
    // where a session either breaks out or fails, and they are different bars.
    const dr = day.runHi[i] - day.runLo[i];
    const dayPos = dr > 0 ? (c - day.runLo[i]) / dr : null;

    // The drive into now: net movement over the last half day, in ATR.
    const drive = i >= DRIVE_BARS ? (c - cs[i - DRIVE_BARS].c) / a : null;

    // A level taken and given back. Not a three-bar swing — the previous day's
    // and previous week's extremes, which are the levels orders actually sit at.
    const swept = (hi, lo) => {
      if (hi[i] == null || lo[i] == null) return null;
      let up = false, dn = false;
      for (let j = Math.max(0, i - SWEEP_BARS + 1); j <= i; j++) {
        if (cs[j].h > hi[i]) up = true;
        if (cs[j].l < lo[i]) dn = true;
      }
      // Taken AND back inside. A level broken and held is a breakout, which is
      // the opposite trade, and lumping the two together is how a sweep study
      // reports nothing.
      if (up && c < hi[i]) return 'high';
      if (dn && c > lo[i]) return 'low';
      return null;
    };

    // One bar that moved far more than the instrument's average. Whether a move
    // arrived as a spike or as a grind is not the same market.
    let spike = false;
    for (let j = Math.max(1, i - 2); j <= i; j++) {
      if ((cs[j].h - cs[j].l) / a >= 1.5) spike = true;
    }

    // Does the other metal agree? Gold and silver move together at 0.78 on the
    // day — the interesting bar is the one where they do not.
    let partnerState = null;
    if (pAt[i] != null && i >= DRIVE_BARS && pAt[i - DRIVE_BARS] != null && pAt[i - DRIVE_BARS] > 0) {
      const pDrive = (pAt[i] - pAt[i - DRIVE_BARS]) / pAt[i - DRIVE_BARS] * 100;
      const oDrive = (c - cs[i - DRIVE_BARS].c) / cs[i - DRIVE_BARS].c * 100;
      const both = Math.abs(pDrive) > 0.15 && Math.abs(oDrive) > 0.15;
      if (both) partnerState = Math.sign(pDrive) === Math.sign(oDrive) ? 'agree' : 'diverge';
      else partnerState = 'quiet';
    }

    // Distance to the nearest round level people watch, as a share of the
    // spacing between them. The grid is recomputed from the bar's own price, so
    // it widens as the market goes up instead of dissolving into noise.
    const step = roundStepFor(sym, c);
    let atRound = null;
    if (step) {
      const rem = ((c % step) + step) % step;
      atRound = Math.min(rem, step - rem) / step < ROUND_NEAR;
    }

    const pdSweep = swept(day.prevHi, day.prevLo);
    const pwSweep = swept(wk.prevHi, wk.prevLo);

    // ── Candles ─────────────────────────────────────────────────────────────
    //
    // Two separate questions, so they get two separate keys and the holdout can
    // answer them apart.
    //
    // `rev` is the strict test: the wick clears the entire prior five-bar range
    // and the close comes back inside it. A sweep with a reclaim.
    //
    // `cdl` is the loose one — the app's 34-pattern registry — but graded by
    // the registry's OWN strength label rather than flattened. The strategy
    // builder currently collapses all 34 into bullish / bearish / doji, so a
    // Bullish Harami the registry calls weak passes the same filter as a
    // Bullish Kicker it calls strong. If that label means nothing the two
    // buckets will score the same, and that is worth knowing either way.
    const rev = detectStrongReversal(cs, i, REV_N);

    // A bar can complete several patterns at once. Both directions at once is
    // not a weak signal, it is a contradictory one, and averaging it into
    // whichever happens to be listed first would hide that.
    let cdl = null;
    const ids = patternsAt(cs, i);
    if (ids.length) {
      const rank = { weak: 1, medium: 2, strong: 3 };
      let bull = null, bear = null;
      let indecision = false;
      for (const id of ids) {
        const m = PATTERN_MAP[id];
        if (!m) continue;
        if (m.signal === 'indecision') indecision = true;
        if (m.type === 'bullish' && (!bull || rank[m.strength] > rank[bull.strength])) bull = m;
        if (m.type === 'bearish' && (!bear || rank[m.strength] > rank[bear.strength])) bear = m;
      }
      if (bull && bear) cdl = 'cdl-conflict';
      else if (bull) cdl = `cdl-bull-${bull.strength}`;
      else if (bear) cdl = `cdl-bear-${bear.strength}`;
      else if (indecision) cdl = 'cdl-indecision';
    }

    // What the dollar and the ten-year account for, and what they do not.
    // Absent when no macro series was supplied — which is a real state, not a
    // reason to invent one.
    const mb = macro ? macroBuckets(macro, i) : { macro: null, dollar: null, flow: null, shift: null };

    out[i] = {
      i, t: cs[i].t, atr: a, close: c,
      hour, dow: d.getUTCDay(), session: sessionOf(hour),
      volRel, stretch, dayPos, drive,
      pdSweep, pwSweep,
      spike, partner: partnerState, atRound, rev, cdl,
      // The labels the study counts.
      b: {
        session: sessionOf(hour),
        vol: bucket(volRel, [0.8, 1.3], ['calm', 'normal', 'hot']),
        stretch: bucket(stretch, [-2, -0.75, 0.75, 2],
          ['far-below', 'below', 'mid', 'above', 'far-above']),
        dayPos: bucket(dayPos, [0.2, 0.45, 0.55, 0.8],
          ['at-day-low', 'lower', 'mid', 'upper', 'at-day-high']),
        drive: bucket(drive, [-1.5, -0.5, 0.5, 1.5],
          ['dropping', 'soft', 'flat', 'firm', 'ripping']),
        pd: pdSweep ? `pd-${pdSweep}-swept` : null,
        pw: pwSweep ? `pw-${pwSweep}-swept` : null,
        spike: spike ? 'spike' : null,
        partner: partnerState ? `partner-${partnerState}` : null,
        round: atRound ? 'at-round' : null,
        rev: rev ? `strong-${rev}` : null,
        cdl,
        macro: mb.macro, dollar: mb.dollar, flow: mb.flow, shift: mb.shift,
      },
    };
  }
  return out;
}

// A feature row as a set of condition keys — `vol=hot`, `pd=pd-high-swept`.
// Null buckets contribute nothing: "not measurable" is not a condition, and
// counting it as one is how absent data becomes a signal.
export function keysOf(f) {
  if (!f) return [];
  const out = [];
  for (const [k, v] of Object.entries(f.b)) if (v != null) out.push(`${k}=${v}`);
  return out;
}

// Does a bar satisfy a rule? A rule is a set of condition keys, all of which
// must hold — an AND, because an OR of two weak conditions is just a weaker
// condition and there is no way to read one on a card.
export function fires(rule, f) {
  if (!f) return false;
  const have = new Set(keysOf(f));
  return rule.all.every(k => have.has(k));
}

export function labelOf(rule) {
  return rule.all.map(k => PHRASE[k] || k).join(' + ');
}

// Plain English for the card. A trader should not have to read `dayPos=upper`.
export const PHRASE = {
  'vol=calm': 'quiet volatility', 'vol=normal': 'normal volatility', 'vol=hot': 'volatility running hot',
  'stretch=far-above': 'far above the mean', 'stretch=above': 'above the mean',
  'stretch=mid': 'near the mean',
  'stretch=below': 'below the mean', 'stretch=far-below': 'far below the mean',
  'dayPos=at-day-high': 'at the day\'s high', 'dayPos=upper': 'upper part of the day',
  'dayPos=mid': 'mid-range on the day',
  'dayPos=lower': 'lower part of the day', 'dayPos=at-day-low': 'at the day\'s low',
  'drive=ripping': 'ripping higher', 'drive=firm': 'drifting up', 'drive=flat': 'going nowhere',
  'drive=soft': 'drifting down', 'drive=dropping': 'falling hard',
  'pd=pd-high-swept': 'yesterday\'s high taken and given back',
  'pd=pd-low-swept': 'yesterday\'s low taken and given back',
  'pw=pw-high-swept': 'last week\'s high taken and given back',
  'pw=pw-low-swept': 'last week\'s low taken and given back',
  'spike=spike': 'a spike bar just printed',
  'partner=partner-agree': 'the other metal agrees',
  'partner=partner-diverge': 'the other metal is going the other way',
  'partner=partner-quiet': 'the other metal is quiet',
  'round=at-round': 'sitting on a round number',
  'rev=strong-hammer': 'a strong hammer — the five-bar low swept and reclaimed',
  'rev=strong-star': 'a strong shooting star — the five-bar high swept and rejected',
  'cdl=cdl-bull-strong': 'a strong bullish candle pattern',
  'cdl=cdl-bull-medium': 'a middling bullish candle pattern',
  'cdl=cdl-bull-weak': 'a weak bullish candle pattern',
  'cdl=cdl-bear-strong': 'a strong bearish candle pattern',
  'cdl=cdl-bear-medium': 'a middling bearish candle pattern',
  'cdl=cdl-bear-weak': 'a weak bearish candle pattern',
  'cdl=cdl-conflict': 'bullish and bearish candle patterns at once',
  'cdl=cdl-indecision': 'a doji or spinning top',
  'session=asia': 'Asian session', 'session=london': 'London session',
  'session=ny-am': 'the London-New York overlap', 'session=ny-pm': 'New York afternoon',
  'session=late': 'after the New York close',
  ...MACRO_PHRASE,
};

// What price has done since a given moment.
//
// The bar AT or AFTER the timestamp, so a headline that landed mid-bar is
// measured from the close of the bar it landed in rather than from a price that
// had already moved on it. Null when there is no completed bar after it — over
// a weekend, or in the first minute of a fresh bar, there is nothing to measure
// yet and a zero would read as "the market did nothing", which is a different
// claim entirely.
//
// Lives here rather than in either caller because the phone and the bot both
// need it and must not drift: the app prints it under a breaking headline, and
// the bot puts it in the push notification.
export function moveSincePct(cs, t) {
  if (!cs?.length || !t) return null;
  const i = cs.findIndex(c => c.t >= t);
  if (i < 0 || i >= cs.length - 1) return null;
  const from = cs[i].c, to = cs[cs.length - 1].c;
  if (!(from > 0)) return null;
  return { pct: ((to - from) / from) * 100, bars: cs.length - 1 - i, at: cs[i].t };
}

// ── Finding the moves ───────────────────────────────────────────────────────
//
// An ATR zigzag: a pivot is confirmed once price has come back `k` ATR from the
// extreme. This is used ONLY to describe what happened — it is retrospective by
// construction, because the pivot at bar 100 is not known until bar 112, and
// anything built on it that claims to be tradeable is lying.
//
// The study keeps that separation visible: the zigzag produces the anatomy, the
// features above produce the rules, and only the second is ever scored as a
// trade.
export function zigzag(cs, atr, k = 2) {
  const piv = [];
  if (cs.length < 3) return piv;
  let dir = null;                       // 'up' = tracking a high
  let extI = 0, extP = cs[0].c;

  for (let i = 1; i < cs.length; i++) {
    const a = atr[i];
    if (!a || !(a > 0)) continue;
    const th = k * a;

    if (dir === null) {
      // Seed: the first move of k ATR away from the opening close sets the
      // direction. No pivot is emitted for it — there is no leg before it to
      // measure, and inventing one would put a fake event at bar zero.
      if (cs[i].h - extP >= th) { dir = 'up'; extP = cs[i].h; extI = i; }
      else if (extP - cs[i].l >= th) { dir = 'down'; extP = cs[i].l; extI = i; }
      continue;
    }

    if (dir === 'up') {
      if (cs[i].h > extP) { extP = cs[i].h; extI = i; }
      else if (extP - cs[i].l >= th) {
        piv.push({ i: extI, t: cs[extI].t, price: extP, type: 'high', confirmedAt: i });
        dir = 'down'; extP = cs[i].l; extI = i;
      }
    } else {
      if (cs[i].l < extP) { extP = cs[i].l; extI = i; }
      else if (cs[i].h - extP >= th) {
        piv.push({ i: extI, t: cs[extI].t, price: extP, type: 'low', confirmedAt: i });
        dir = 'up'; extP = cs[i].h; extI = i;
      }
    }
  }
  return piv;
}

// Pivots turned into events: what came in, what went out. The `out` leg is the
// outcome and must never appear in a feature.
export function legsOf(piv, atr) {
  const out = [];
  for (let n = 1; n < piv.length - 1; n++) {
    const prev = piv[n - 1], p = piv[n], next = piv[n + 1];
    const a = atr[p.i];
    if (!a || !(a > 0)) continue;
    out.push({
      i: p.i, t: p.t, type: p.type, price: p.price,
      inAtr: Math.abs(p.price - prev.price) / a,
      inBars: p.i - prev.i,
      outAtr: Math.abs(next.price - p.price) / a,
      outBars: next.i - p.i,
      // 'up' means price went up from here — the trade a reversal at a low is.
      dir: p.type === 'low' ? 'up' : 'down',
    });
  }
  return out;
}

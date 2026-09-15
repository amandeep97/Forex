// shared/pairs.mjs
// "Gold swept the daily low. Silver did not."
//
// A sweep is one instrument's price crossing one level and coming back. That
// tells you what happened; it does not tell you WHY, and the two candidates
// have opposite consequences:
//
//   The whole complex moved.  Gold took its low because the dollar bid and
//                             every metal went with it. The level had nothing
//                             to do with it and the turn, if it comes, is a
//                             dollar turn.
//   This instrument alone.    Gold took its low, silver sat still. Nothing
//                             macro moved; price went and got the stops that
//                             were sitting there, which is the event the whole
//                             model is named after.
//
// The second is the setup. The first is a move being read as a hunt. They are
// indistinguishable on one chart and obvious across two, which is the entire
// reason this file exists.
//
// ── Why the relationship is measured rather than stated ─────────────────────
//
// It would be a shorter file to write `XAU/USD and XAG/USD move together` and
// be done. But "move together" is a claim about right now, not a law: the
// gold/silver correlation over four-hour bars has been above 0.9 and it has
// been near zero inside the same year, and during the near-zero stretches
// "silver held" means nothing at all — silver holds because silver is doing its
// own thing, not because gold's low was a stop hunt.
//
// So this file states only which pairs have a REASON to be related, and the
// strength and the sign are measured from the same four-hour candles the
// scanner already fetches for its levels. No extra requests, and a pair that
// has stopped moving together says so instead of being quoted anyway.
//
// The reason matters as much as the number. Screening all forty instruments
// against each other for the highest correlation would pair GBP/CHF with
// EUR/CHF at 0.95 and announce, daily, that two near-identical crosses did the
// same thing. That is a true number and an empty statement.

/**
 * Pairs with an economic reason to move together, and the reason in words.
 *
 * `why` is shown on screen. A reader who cannot see why two instruments are
 * being compared has no way to judge whether the comparison is worth anything,
 * and "r = 0.81" on its own invites exactly that.
 */
export const PAIRS = [
  { a: 'XAU/USD', b: 'XAG/USD', why: 'both precious metals, same buyers' },
  { a: 'US500', b: 'US100', why: 'the same equity market' },
  { a: 'US500', b: 'US30', why: 'the same equity market' },
  { a: 'US500', b: 'GER40', why: 'global equity risk' },
  { a: 'USOIL', b: 'UKOIL', why: 'the same barrel, two benchmarks' },
  { a: 'USD/CAD', b: 'USOIL', why: "oil is Canada's export" },
  { a: 'EUR/USD', b: 'GBP/USD', why: 'both are the dollar, from the other side' },
  { a: 'AUD/USD', b: 'NZD/USD', why: 'the commodity dollars' },
  { a: 'EUR/USD', b: 'USD/CHF', why: 'the dollar on opposite sides of the quote' },
  { a: 'AUD/JPY', b: 'US500', why: 'the carry trade and risk appetite' },
];

/** Enough overlapping four-hour bars for a correlation to mean anything. */
export const MIN_POINTS = 30;

/**
 * Below this the pair is not moving together right now, whatever the reason
 * says, and no divergence claim is made.
 *
 * 0.5 rather than something stricter because the question being asked is weak:
 * not "can I hedge one with the other" but "did the same thing move both". A
 * pair at 0.55 answers that; a pair at 0.2 does not.
 */
export const MIN_R = 0.5;

/** @param {string} sym @returns {{sym:string, why:string}[]} */
export function partnersOf(sym) {
  const out = [];
  for (const p of PAIRS) {
    if (p.a === sym) out.push({ sym: p.b, why: p.why });
    else if (p.b === sym) out.push({ sym: p.a, why: p.why });
  }
  return out;
}

/**
 * Log returns of a candle series, carried with the timestamp of the bar they
 * end on, so two series can be lined up by time rather than by index.
 *
 * By index would be wrong in the ordinary case, not the exotic one: OANDA's
 * series for two instruments are not the same length — a Tokyo holiday, a late
 * open, a gap in one feed and not the other — and index alignment silently
 * compares Tuesday's gold to Monday's silver from the first missing bar
 * onwards. The correlation still comes out looking fine.
 *
 * @param {{t?:number|string, c:number}[]} cs
 */
export function returnsOf(cs) {
  const out = [];
  if (!cs || cs.length < 2) return out;
  for (let i = 1; i < cs.length; i++) {
    const p = cs[i - 1]?.c, c = cs[i]?.c;
    if (!(p > 0) || !(c > 0)) continue;
    // Both shapes are real and both arrive here: the bot carries epoch
    // milliseconds, the app's OANDA fetch carries an ISO string. Anything else
    // becomes NaN and is dropped rather than coerced into a plausible-looking
    // timestamp that would align against the wrong bar.
    const raw = cs[i].t;
    const t = typeof raw === 'number' ? raw
      : typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (!Number.isFinite(t)) continue;
    out.push([t, Math.log(c / p)]);
  }
  return out;
}

/**
 * Pearson correlation of two return series, aligned on timestamp.
 *
 * @param {[number,number][]} ra
 * @param {[number,number][]} rb
 * @returns {{ r:number, n:number }|null} null when there is not enough overlap
 */
export function correlate(ra, rb) {
  if (!ra?.length || !rb?.length) return null;
  const m = new Map(rb);
  const xs = [], ys = [];
  for (const [t, v] of ra) {
    const w = m.get(t);
    if (w === undefined) continue;
    xs.push(v); ys.push(w);
  }
  const n = xs.length;
  if (n < MIN_POINTS) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return { r: +(sxy / Math.sqrt(sxx * syy)).toFixed(3), n };
}

/**
 * The level kind on the partner that corresponds to `kind` on this instrument.
 *
 * With a positive correlation the two rise and fall together, so gold's daily
 * low corresponds to silver's daily low. With a NEGATIVE one they are mirrors:
 * the move that takes USD/CAD's daily high is the move that takes oil's daily
 * low, and comparing high to high there would report a divergence on every
 * single sweep — which is the shape of bug that produces a screen full of
 * confident nonsense.
 *
 * @param {string} kind
 * @param {number} r
 */
export function mirrorKind(kind, r) {
  if (r >= 0) return kind;
  const flip = { PDH: 'PDL', PDL: 'PDH', PWH: 'PWL', PWL: 'PWH', H4H: 'H4L', H4L: 'H4H' };
  return flip[kind] || kind;
}

/**
 * Did this instrument take its level alone, or did its partner take the
 * matching one too?
 *
 * `together` is not a failure of the setup and is not reported as one. It is a
 * different trade: a move the whole complex made, where the level is incidental
 * and the case for a reversal has to come from somewhere other than stops. The
 * words say which of the two it is and nothing more, because which one is
 * better has not been measured here and saying otherwise would be inventing a
 * result.
 *
 * @param {object} arg
 * @param {string} arg.sym
 * @param {string} arg.kind          the level kind swept on `sym`
 * @param {{sym:string, why:string}} arg.partner
 * @param {{r:number,n:number}|null} arg.corr
 * @param {Record<string,{state:string}>|null} arg.partnerLevels the partner's columns
 * @returns {null|{partner:string, why:string, r:number, n:number, kind:string,
 *   partnerKind:string, partnerState:string|null, verdict:'alone'|'together'|'unknown',
 *   text:string}}
 */
export function divergence({ sym, kind, partner, corr, partnerLevels }) {
  if (!partner || !corr || Math.abs(corr.r) < MIN_R) return null;
  const partnerKind = mirrorKind(kind, corr.r);
  const st = partnerLevels?.[partnerKind]?.state ?? null;

  // `behind` means the partner has been beyond that level for the whole window
  // — it did not take it today, it has been living on the other side of it. It
  // is neither a matching sweep nor a hold, and forcing it into one of those
  // two would be the most misleading thing this function could do.
  const verdict = st === 'swept' || st === 'through' ? 'together'
    : st === 'near' || st === 'quiet' ? 'alone'
      : 'unknown';
  if (verdict === 'unknown') return null;

  const text = verdict === 'alone'
    ? `${sym} took it alone — ${partner.sym} left its own level standing`
    : `${partner.sym} went with it — the whole complex moved, not just ${sym}`;

  return {
    partner: partner.sym, why: partner.why, r: corr.r, n: corr.n,
    kind, partnerKind, partnerState: st, verdict, text,
  };
}

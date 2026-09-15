// The three things that say what KIND of hunt it is —
// shared/sessions.mjs, shared/pairs.mjs, and trendAlign in shared/liquidity.mjs.
//
// Each of these takes a row that already exists and puts a word on it, which is
// the sort of code that is easy to get subtly wrong and hard to notice: a
// mislabelled session still renders, a divergence computed against the wrong
// side of an inverse pair still prints a confident sentence, and an alignment
// that treats "ranging" as a trend still produces a green tag.
//
// So every check here is aimed at one specific way the label could be wrong
// while the screen still looks fine.

import { sessionOf, inOverlap, sessionStamp, SESSIONS, SESSION_LABEL } from '../shared/sessions.mjs';
import { partnersOf, returnsOf, correlate, mirrorKind, divergence, PAIRS, MIN_R }
  from '../shared/pairs.mjs';
import { trendAlign } from '../shared/liquidity.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// ── Sessions ────────────────────────────────────────────────────────────────
//
// These moved here out of liquiditystudy.test.cjs. The study used to own the
// only definition; three callers now share this one, so the tests belong with
// the module rather than with one of its readers.
{
  // Mid-January: London is on GMT, so London local hour equals UTC hour.
  const winter = (h, m = 0) => Date.UTC(2026, 0, 14, h, m);
  check('the session boundaries are the ones a trader works to',
    sessionOf(winter(3)) === 'asia' && sessionOf(winter(8)) === 'london'
    && sessionOf(winter(14)) === 'ny' && sessionOf(winter(20)) === 'late',
    [3, 8, 14, 20].map(h => `${h}h=${sessionOf(winter(h))}`).join(' '));

  check('every hour of the day lands in exactly one session',
    Array.from({ length: 24 }, (_, h) => sessionOf(winter(h))).every(Boolean)
    && new Set(Array.from({ length: 24 }, (_, h) => sessionOf(winter(h)))).size === 4,
    'an hour with no session would silently drop those entries');

  // The whole reason this is not getUTCHours(). In July, London is on BST, so
  // 06:30 UTC is 07:30 in London — the London session has been open half an
  // hour. Fixed-UTC bucketing calls it Asia and does so for four months a year.
  const julyPreOpen = Date.UTC(2026, 6, 14, 6, 30);
  check('the London open is the London open in summer too',
    sessionOf(julyPreOpen) === 'london',
    `06:30 UTC in July = 07:30 London, got "${sessionOf(julyPreOpen)}"`);

  // And the mirror: 06:30 UTC in January really is before the open.
  check('…and is not dragged an hour early in winter',
    sessionOf(Date.UTC(2026, 0, 14, 6, 30)) === 'asia',
    `got "${sessionOf(Date.UTC(2026, 0, 14, 6, 30))}"`);

  check('the overlap is the hours both desks are actually open',
    inOverlap(Date.UTC(2026, 0, 14, 14)) === true
    && inOverlap(Date.UTC(2026, 0, 14, 3)) === false
    && inOverlap(Date.UTC(2026, 0, 14, 20)) === false,
    '14:00 UTC in January is 14:00 London and 09:00 New York');

  // The two-week window in March when New York has changed and London has not.
  // Both clocks are read in their own zone, so this needs no special case — but
  // it is exactly where a hand-rolled offset would be wrong.
  {
    const m = Date.UTC(2026, 2, 12, 17, 0);   // 17:00 London, 13:00 New York
    check('the overlap survives the fortnight the two zones disagree',
      inOverlap(m) === false && sessionOf(m) === 'late',
      `London has shut at 17:00 local; got overlap=${inOverlap(m)} session=${sessionOf(m)}`);
  }

  check('a stamp carries the id, a readable label and the overlap flag',
    (() => {
      const s = sessionStamp(Date.UTC(2026, 0, 14, 14));
      return s?.id === 'ny' && s.label === 'New York' && s.overlap === true;
    })(), JSON.stringify(sessionStamp(Date.UTC(2026, 0, 14, 14))));

  check('a stamp for a missing time is null, not a confident guess',
    sessionStamp(null) === null && sessionStamp(NaN) === null
    && sessionStamp(undefined) === null,
    'a level with no timestamp must not be labelled "Asia" by default');

  check('every session has a label, so nothing renders a bare id',
    SESSIONS.every(s => SESSION_LABEL[s.id]),
    SESSIONS.map(s => s.id).join(' '));

  // The replay asks this forty thousand times an instrument and the answer is
  // cached on the hour. A cache that returned a stale answer across a boundary
  // would mislabel entries in bulk and silently.
  check('the hour cache does not leak across a session boundary',
    sessionOf(Date.UTC(2026, 0, 14, 6, 59)) === 'asia'
    && sessionOf(Date.UTC(2026, 0, 14, 7, 1)) === 'london'
    && sessionOf(Date.UTC(2026, 0, 14, 6, 59)) === 'asia',
    'asked either side of 07:00 and then back again');
}

// ── Trend alignment ─────────────────────────────────────────────────────────
{
  check('a low swept inside an uptrend is with the trend',
    trendAlign('bullish', 'long').align === 'with');
  check('a low swept inside a downtrend is against it',
    trendAlign('bearish', 'long').align === 'against');
  check('a high swept inside a downtrend is with the trend',
    trendAlign('bearish', 'short').align === 'with');

  // Ranging is not rounded to a side. The old structure code kept two different
  // notions of bull-or-bear and they disagreed; inventing a trend here to
  // classify against would be the same mistake in a new place.
  check('ranging is "none", not rounded to with or against',
    trendAlign('ranging', 'long').align === 'none'
    && trendAlign(null, 'short').align === 'none'
    && trendAlign(undefined, 'long').align === 'none',
    'a restored row with no structure reading must not claim one');

  check('the text names both the trend and the turn',
    /up/.test(trendAlign('bullish', 'long').text)
    && /down/.test(trendAlign('bearish', 'long').text),
    trendAlign('bearish', 'long').text);
}

// ── Pairs: the relationship is measured, not asserted ───────────────────────
{
  check('every declared pair carries a reason a person can read',
    PAIRS.every(p => p.a && p.b && typeof p.why === 'string' && p.why.length > 8),
    'r = 0.81 with no reason invites trusting a number that means nothing');

  check('partners are found from either side of the declaration',
    partnersOf('XAU/USD').some(p => p.sym === 'XAG/USD')
    && partnersOf('XAG/USD').some(p => p.sym === 'XAU/USD'),
    'declared as a:XAU/USD b:XAG/USD — both must resolve');

  check('an instrument with no declared partner gets an empty list, not a guess',
    partnersOf('EUR/NZD').length === 0);

  // Returns carry their bar's timestamp, because two OANDA series for two
  // instruments are not the same length — a holiday, a late open, one missing
  // bar — and index alignment compares Tuesday's gold to Monday's silver from
  // the first gap onwards while still looking healthy.
  {
    const mk = (ts, closes) => ts.map((t, i) => ({ t, c: closes[i] }));
    const t = [1, 2, 3, 4, 5].map(i => i * 14400e3);
    const a = returnsOf(mk(t, [100, 101, 102, 103, 104]));
    check('returns are stamped with the time of the bar they end on',
      a.length === 4 && a[0][0] === t[1] && a[3][0] === t[4],
      a.map(x => x[0]).join(','));

    // Same prices, but B is missing the bar at t[2]. From that gap onwards the
    // two series are off by one: a[1] is the move into t[2] and b[1] is the
    // move into t[3]. Index alignment would pair them and report a confident
    // correlation between two different days.
    const b = returnsOf(mk([t[0], t[1], t[3], t[4]], [50, 50.5, 51.5, 52]));
    const sameIndexDifferentDay = a[1][0] !== b[1][0];
    const timeOverlap = a.filter(x => b.some(y => y[0] === x[0])).length;
    check('a series with a missing bar aligns on time, not on index',
      sameIndexDifferentDay && timeOverlap === 3 && a.length === 4 && b.length === 3,
      `index 1 is ${a[1][0]} vs ${b[1][0]}; ${timeOverlap} timestamps line up, not ${a.length}`);
  }

  check('a correlation on too little overlap is null, not a number',
    correlate([[1, 0.1], [2, 0.2]], [[1, 0.1], [2, 0.2]]) === null,
    'two points can be correlated perfectly and mean nothing');

  {
    // Thirty-plus bars, B a clean negative multiple of A.
    const ts = Array.from({ length: 40 }, (_, i) => (i + 1) * 14400e3);
    const a = ts.map((t, i) => [t, Math.sin(i) * 0.01]);
    const b = ts.map((t, i) => [t, -Math.sin(i) * 0.02]);
    const c = correlate(a, b);
    check('an inverse relationship measures as a negative r',
      c && c.r < -0.95 && c.n === 40, JSON.stringify(c));

    const flat = ts.map(t => [t, 0]);
    check('a series that never moves has no correlation rather than NaN',
      correlate(a, flat) === null, String(correlate(a, flat)));
  }

  // The bug this is here to prevent. On an inverse pair the matching level is
  // the OPPOSITE side: the move that takes USD/CAD's daily high is the move
  // that takes oil's daily low. Comparing high to high would report a
  // divergence on literally every sweep.
  check('an inverse pair compares a high against the partner\'s low',
    mirrorKind('PDH', -0.8) === 'PDL' && mirrorKind('H4L', -0.8) === 'H4H'
    && mirrorKind('PDH', 0.8) === 'PDH',
    `${mirrorKind('PDH', -0.8)} / ${mirrorKind('PDH', 0.8)}`);

  {
    const partner = { sym: 'XAG/USD', why: 'both precious metals' };
    const strong = { r: 0.85, n: 60 };

    const alone = divergence({
      sym: 'XAU/USD', kind: 'PDL', partner, corr: strong,
      partnerLevels: { PDL: { state: 'near' } },
    });
    check('gold took the low and silver did not — that is "alone"',
      alone?.verdict === 'alone' && /XAG\/USD/.test(alone.text), alone?.text);

    const together = divergence({
      sym: 'XAU/USD', kind: 'PDL', partner, corr: strong,
      partnerLevels: { PDL: { state: 'swept' } },
    });
    check('both took their lows — that is "together", and is not called a failure',
      together?.verdict === 'together' && !/fail|bad|avoid/i.test(together.text),
      together?.text);

    // A pair that has stopped moving together says nothing. "Silver held" is
    // meaningless when silver has been doing its own thing for a fortnight.
    check('a pair that is not moving together makes no claim at all',
      divergence({ sym: 'XAU/USD', kind: 'PDL', partner, corr: { r: 0.2, n: 60 },
        partnerLevels: { PDL: { state: 'near' } } }) === null,
      `MIN_R is ${MIN_R}`);

    check('no correlation measured yet means no claim either',
      divergence({ sym: 'XAU/USD', kind: 'PDL', partner, corr: null,
        partnerLevels: { PDL: { state: 'near' } } }) === null);

    // "behind" means the partner has been beyond that level for the entire
    // window — it did not take it today, it lives on the other side of it.
    // Forcing that into "held" would be the most misleading read available.
    check('a partner already living beyond its level is neither, and says so',
      divergence({ sym: 'XAU/USD', kind: 'PDL', partner, corr: strong,
        partnerLevels: { PDL: { state: 'behind' } } }) === null);

    check('a partner that has never been scanned makes no claim',
      divergence({ sym: 'XAU/USD', kind: 'PDL', partner, corr: strong,
        partnerLevels: null }) === null,
      'no levels is different from levels that held');

    // The inverse case end to end: USD/CAD takes its daily HIGH; oil is near
    // its daily LOW, which is the same move. That is "together", not a
    // divergence, and getting the mirror wrong would invert this.
    const oil = { sym: 'USOIL', why: "oil is Canada's export" };
    const inv = divergence({
      sym: 'USD/CAD', kind: 'PDH', partner: oil, corr: { r: -0.72, n: 55 },
      partnerLevels: { PDL: { state: 'swept' }, PDH: { state: 'quiet' } },
    });
    check('on an inverse pair, the matching move reads as "together"',
      inv?.verdict === 'together' && inv.partnerKind === 'PDL',
      `${inv?.verdict} against ${inv?.partnerKind}`);
  }
}

console.log(fails ? `\n${fails} failed` : '\nall context checks passed');
process.exit(fails ? 1 : 0);

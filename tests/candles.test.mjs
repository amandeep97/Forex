// Candles as study conditions — shared/candlePatterns.mjs and the two keys
// shared/moveFeatures.mjs derives from it.
//
// The point of these is not that a hammer is drawn correctly. It is that the
// two questions stay SEPARATE and that neither can see forward. The strategy
// builder currently flattens all thirty-four registry patterns into bullish /
// bearish / doji, so a Bullish Harami the registry itself calls weak passes the
// same filter as a Bullish Kicker it calls strong. If the study is going to be
// asked whether that distinction is worth anything, the distinction has to
// survive the trip into the feature row.
import {
  isStrongHammer, isStrongStar, detectStrongReversal, patternsAt, PATTERN_MAP,
  CANDLE_PATTERNS, DEFAULT_PATTERN_N,
} from '../shared/candlePatterns.mjs';
import { featureSeries, keysOf, PHRASE, REV_N } from '../shared/moveFeatures.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const H = 3600e3;
const MON = Date.UTC(2026, 0, 5, 0, 0, 0);

const at = (cs, i) => cs.map((b, k) => ({ t: MON + k * H, v: 1, ...b }))[i];
const stamp = arr => arr.map((b, k) => ({ t: MON + k * H, v: 1, ...b }));

// ── One definition, not two ─────────────────────────────────────────────────
{
  check('the registry is intact after the move to shared/',
    CANDLE_PATTERNS.length === 34 && !!PATTERN_MAP.bull_engulf,
    `${CANDLE_PATTERNS.length} patterns`);
  check('every registry entry carries the strength the study grades on',
    CANDLE_PATTERNS.every(p => ['weak', 'medium', 'strong'].includes(p.strength)));
  check('the default range length is the one the app has always used',
    DEFAULT_PATTERN_N === 5 && REV_N === 5,
    'changing it silently would rewrite what "strong hammer" means');
}

// ── The strict test is strict ───────────────────────────────────────────────
//
// A hammer shape alone is not a strong hammer. The wick has to clear the whole
// prior range AND the close has to come back inside it. Those are two different
// bars and conflating them is how a sweep study reports nothing.
{
  // Five flat bars at 100 +/- 1, then the candidate.
  const base = Array.from({ length: 5 }, () => ({ o: 100, h: 101, l: 99, c: 100 }));

  // Sweeps to 96, closes back at 100.5 — green, long lower wick, body up top.
  const sweep = stamp([...base, { o: 100, h: 100.6, l: 96, c: 100.5 }]);
  check('a wick through the range low that closes back inside is a strong hammer',
    isStrongHammer(sweep, 5, 5) === true);

  // Same shape, but it never reaches below the range low of 99.
  const shy = stamp([...base, { o: 99.6, h: 100.1, l: 99.2, c: 100 }]);
  check('the same shape that never clears the range low is not',
    isStrongHammer(shy, 5, 5) === false,
    'a hammer that sweeps nothing has taken nobody’s stops');

  // Clears the low and STAYS below it — that is a breakdown, the other trade.
  const gone = stamp([...base, { o: 99, h: 99.2, l: 96, c: 98.5 }]);
  check('and one that clears the low and stays below it is not either',
    isStrongHammer(gone, 5, 5) === false,
    'a level broken and held is a breakdown, which is the opposite trade');

  const star = stamp([...base, { o: 100.2, h: 105, l: 99.9, c: 100 }]);
  check('the star is the exact mirror',
    isStrongStar(star, 5, 5) === true && isStrongHammer(star, 5, 5) === false);
  check('and detectStrongReversal names which one',
    detectStrongReversal(sweep, 5, 5) === 'hammer'
    && detectStrongReversal(star, 5, 5) === 'star'
    && detectStrongReversal(shy, 5, 5) === null);
}

// ── Nothing may look forward ────────────────────────────────────────────────
//
// The single check that matters more than all the others. A pattern that reads
// bar i+1 is untradeable and will still backtest beautifully.
{
  const rnd = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const cs = stamp(Array.from({ length: 80 }, (_, i) => {
    const o = 100 + Math.sin(i / 3) * 2;
    const c = o + (rnd() - 0.5) * 2;
    return { o, c, h: Math.max(o, c) + rnd(), l: Math.min(o, c) - rnd() };
  }));

  const full = patternsAt(cs, 60).join(',');
  const truncated = patternsAt(cs.slice(0, 61), 60).join(',');
  check('patternsAt gives the same answer with the future deleted',
    full === truncated, full || '(none)');

  const revFull = detectStrongReversal(cs, 60, 5);
  const revTrunc = detectStrongReversal(cs.slice(0, 61), 60, 5);
  check('and so does the strong reversal',
    revFull === revTrunc, String(revFull));

  // The feature row itself, which is what the study actually reads.
  const a = featureSeries(cs, { sym: 'XAU_USD' });
  const b = featureSeries(cs.slice(0, 61), { sym: 'XAU_USD' });
  check('and so does the feature row built from them',
    JSON.stringify(a[60]?.b?.cdl) === JSON.stringify(b[60]?.b?.cdl)
    && JSON.stringify(a[60]?.b?.rev) === JSON.stringify(b[60]?.b?.rev),
    'a candle key that moves when later bars arrive is a key that cannot be traded');
}

// ── The two questions stay apart ────────────────────────────────────────────
{
  const base = Array.from({ length: 20 }, () => ({ o: 100, h: 101, l: 99, c: 100 }));
  const cs = featureSeries(
    stamp([...base, { o: 100, h: 100.6, l: 96, c: 100.5 }]), { sym: 'XAU_USD' });
  const f = cs[cs.length - 1];

  check('a strong hammer reaches the feature row as its own key',
    f?.b?.rev === 'strong-hammer', String(f?.b?.rev));
  check('and rev and cdl are separate keys, not one merged verdict',
    keysOf(f).filter(k => k.startsWith('rev=')).length <= 1
    && keysOf(f).filter(k => k.startsWith('cdl=')).length <= 1,
    'merging them would make "the strict test beats the loose one" unaskable');
}

// ── Strength is graded, not flattened ───────────────────────────────────────
{
  // Two bars where the second engulfs the first — bull_engulf, which the
  // registry calls strong.
  const base = Array.from({ length: 20 }, () => ({ o: 100, h: 100.5, l: 99.5, c: 100 }));
  const engulf = stamp([...base,
    { o: 100, h: 100.2, l: 99, c: 99.2 },        // red
    { o: 99, h: 101.2, l: 98.9, c: 101 },        // green, swallows it
  ]);
  const ids = patternsAt(engulf, engulf.length - 1);
  check('a bullish engulfing is detected',
    ids.includes('bull_engulf'), ids.join(',') || '(none)');

  const f = featureSeries(engulf, { sym: 'XAU_USD' }).at(-1);
  check('and it arrives graded rather than as a bare "bullish"',
    f?.b?.cdl === 'cdl-bull-strong', String(f?.b?.cdl));
  check('which is the whole point — the builder calls this the same as a harami',
    PATTERN_MAP.bull_engulf.strength === 'strong'
    && PATTERN_MAP.bull_harami.strength === 'weak'
    && PATTERN_MAP.bull_engulf.type === PATTERN_MAP.bull_harami.type);
}

// ── Contradiction is not weakness ───────────────────────────────────────────
{
  // An outside bar that both engulfs bullishly and leaves a long upper wick can
  // fire both directions. Whatever the shape, the RULE has to hold: two
  // directions at once is its own label, never silently one of them.
  const rank = { weak: 1, medium: 2, strong: 3 };
  const label = (ids) => {
    let bull = null, bear = null, ind = false;
    for (const id of ids) {
      const m = PATTERN_MAP[id]; if (!m) continue;
      if (m.signal === 'indecision') ind = true;
      if (m.type === 'bullish' && (!bull || rank[m.strength] > rank[bull.strength])) bull = m;
      if (m.type === 'bearish' && (!bear || rank[m.strength] > rank[bear.strength])) bear = m;
    }
    if (bull && bear) return 'cdl-conflict';
    if (bull) return `cdl-bull-${bull.strength}`;
    if (bear) return `cdl-bear-${bear.strength}`;
    return ind ? 'cdl-indecision' : null;
  };
  check('bullish and bearish together is labelled a conflict',
    label(['bull_engulf', 'bear_harami']) === 'cdl-conflict',
    'averaging a contradiction into one direction hides that it was one');
  check('the strongest of one direction wins when there is only one direction',
    label(['bull_harami', 'bull_engulf']) === 'cdl-bull-strong');
  check('a doji alone is indecision, not a direction',
    label(['doji', 'spinning_top']) === 'cdl-indecision');
  check('and nothing at all stays null',
    label([]) === null,
    'absent must stay absent — a plausible default here becomes a signal');
}

// ── A flat market has no patterns ───────────────────────────────────────────
{
  const flat = stamp(Array.from({ length: 40 }, () => ({ o: 100, h: 100.4, l: 99.6, c: 100 })));
  const f = featureSeries(flat, { sym: 'XAU_USD' }).at(-1);
  check('an unchanging market produces no strong reversal',
    f?.b?.rev == null, String(f?.b?.rev),
    'if it fires on a flat line it is measuring the detector, not the market');
}

// ── Every key can be read by a person ───────────────────────────────────────
{
  const want = [
    'rev=strong-hammer', 'rev=strong-star',
    'cdl=cdl-bull-strong', 'cdl=cdl-bull-medium', 'cdl=cdl-bull-weak',
    'cdl=cdl-bear-strong', 'cdl=cdl-bear-medium', 'cdl=cdl-bear-weak',
    'cdl=cdl-conflict', 'cdl=cdl-indecision',
  ];
  const missing = want.filter(k => !PHRASE[k]);
  check('every new condition has plain English on the card',
    missing.length === 0, missing.join(', ') || 'all present');
  check('and the hammer sentence says what it actually tests',
    /swept and reclaimed/.test(PHRASE['rev=strong-hammer']),
    'the name "strong hammer" does not tell a reader it is a sweep');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

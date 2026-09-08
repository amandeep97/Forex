// The cross-market search — vps-bot/src/regimeSearch.js.
//
// Widening a search multiplies the ways to fool yourself. Sixteen instruments
// over two timeframes is roughly a hundred times more tests than two over one,
// and at that scale something looks wonderful by chance every single run. So
// almost every check here is about the DEFENCES rather than the arithmetic:
// the instrument holdout, the per-market requirement, and the verdict refusing
// to call something real on one of the two holdouts alone.
//
// The instrument holdout is the one that matters most, because it is the only
// dimension that cannot be fitted. A rule can be fitted to gold's particular
// year. It cannot be fitted to eight markets it was never shown.
const path = require('path');
const S = require(path.join(__dirname, '..', 'vps-bot', 'src', 'regimeSearch.js'));

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// ── The split ───────────────────────────────────────────────────────────────
{
  const { search, proof } = S.splitUniverse();
  const all = [...search, ...proof].map(u => u.sym);

  check('every instrument lands on exactly one side',
    new Set(all).size === all.length && all.length === S.UNIVERSE.length,
    `${search.length} searched, ${proof.length} unseen`);
  check('and no instrument is on both',
    !search.some(a => proof.some(b => b.sym === a.sym)),
    'an instrument in both halves is not a holdout, it is the same data twice');

  const mix = list => {
    const m = {};
    for (const u of list) m[u.cls] = (m[u.cls] || 0) + 1;
    return JSON.stringify(m, Object.keys(m).sort());
  };
  check('both halves carry the same mix of asset classes',
    mix(search) === mix(proof), `${mix(search)} vs ${mix(proof)}`,
    'all the FX on one side would test moving between asset classes, a different question');

  // Determinism matters more than it looks. A random split would give a
  // different answer every fortnight and there would be no way to tell a rule
  // dying from the split moving underneath it.
  const again = S.splitUniverse();
  check('the split is deterministic, not random',
    JSON.stringify(again.search) === JSON.stringify(search),
    'a rule dying and the split moving must not look the same');

  // A universe too small to split has to be caught, not silently halved into
  // one instrument against one.
  const tiny = S.splitUniverse([{ sym: 'XAU_USD', cls: 'metal' }, { sym: 'XAG_USD', cls: 'metal' }]);
  check('a two-instrument universe splits one and one',
    tiny.search.length === 1 && tiny.proof.length === 1,
    'the caller checks this is too few; the split itself does not pretend otherwise');
}

// ── One lucky market must not carry a rule ──────────────────────────────────
//
// The pooled number on the unseen half can be produced entirely by a single
// instrument having a good year. Counting how many paid INDIVIDUALLY is the
// check that cannot be passed that way, and it is why MIN_INSTRUMENTS exists.
{
  const H = 3600e3, T0 = Date.UTC(2025, 0, 1);
  // Bars that trend up, so a rule that is always true has something to earn.
  const mk = (sym, drift) => {
    const cs = [], feats = [];
    for (let i = 0; i < 400; i++) {
      const p = 100 + i * drift;
      cs.push({ t: T0 + i * H, o: p, h: p + 1, l: p - 1, c: p, v: 1 });
      feats.push({ t: T0 + i * H, atr: 1, keys: new Set(i % 5 === 0 ? ['x=1'] : []) });
    }
    return { sym, cs, feats };
  };
  const sets = [mk('A', 0.5), mk('B', 0), mk('C', 0), mk('D', 0)];
  // Baselines built exactly the way the study builds them, so this measures the
  // real comparison rather than a stub that always says zero.
  const { baselineFor } = require(path.join(__dirname, '..', 'vps-bot', 'src', 'regimeStudy.js'));
  const perSym = {};
  for (const s of sets) perSym[`${s.sym}|up|12`] = baselineFor([s], 12, 'up', () => true);

  const spread = S.perInstrument(sets, { all: ['x=1'] }, 'up', 12, () => true, perSym);
  check('every unseen market is scored on its own, not just pooled',
    spread.tested === 4, `${spread.tested} scored`);
  check('and the count of markets that actually paid is reported',
    typeof spread.positive === 'number' && spread.positive <= spread.tested,
    `${spread.positive} of ${spread.tested}`);
  check('the bar is at least three markets, so one cannot carry it',
    S.MIN_INSTRUMENTS >= 3, String(S.MIN_INSTRUMENTS));
}

// ── The verdict has to clear BOTH holdouts ──────────────────────────────────
{
  const V = (o) => S.wideVerdict({
    discovery: { edgeR: 0.3, n: 100, t: 3 },
    holdout: { edgeR: 0.25, n: 60, t: 3.2 },
    unseen: { edgeR: 0.2, n: 200, t: 3.0 },
    spread: { positive: 5, tested: 8 },
    ...o,
  });

  check('clearing time and instruments, both significantly, is confirmed',
    V({}) === 'confirmed', V({}));

  // The failure the null test found: a positive sign on both holdouts is a
  // coin flip twice, and calling it a hold reported seven of ten carried rules
  // as holding on pure random-walk data.
  check('positive on both but significant on NEITHER is a fade, not a hold',
    V({ holdout: { edgeR: 0.25, n: 60, t: 0.4 }, unseen: { edgeR: 0.2, n: 200, t: 0.3 } })
      === 'fades',
    'the right sign twice is what noise looks like');
  check('and significant on only one of the two is still a fade',
    V({ unseen: { edgeR: 0.2, n: 200, t: 0.5 } }) === 'fades'
    && V({ holdout: { edgeR: 0.25, n: 60, t: 0.5 } }) === 'fades');
  check('significant on both, but under the corrected threshold, holds rather than confirms',
    V({ holdout: { edgeR: 0.25, n: 60, t: 2.2 }, unseen: { edgeR: 0.2, n: 200, t: 2.2 } })
      === 'holds',
    'confirmed carries the multiple-testing correction; holds does not, and the labels say so');

  check('a rule that works here but not on unseen markets is named as such',
    V({ unseen: { edgeR: -0.1, n: 200, t: -1 }, spread: { positive: 1, tested: 8 } })
      === 'this market only',
    'real for that instrument, and possibly nothing more');

  check('and one that generalises but has stopped working here is named separately',
    V({ holdout: { edgeR: -0.1, n: 60, t: -1 } }) === 'generalises, not current',
    'general but stale is a different warning from local but real');

  check('failing both is a plain fail',
    V({ holdout: { edgeR: -0.2, n: 60, t: -2 }, unseen: { edgeR: -0.2, n: 200, t: -2 },
        spread: { positive: 0, tested: 8 } }) === 'fails');

  check('a pooled edge on unseen markets carried by one of them does NOT hold',
    V({ spread: { positive: 1, tested: 8 } }) === 'this market only',
    'this is the exact failure the per-market count exists to catch');

  check('too few trades on the time holdout is thin, not a verdict',
    V({ holdout: { edgeR: 0.25, n: 3, t: 3 } }) === 'thin');
  check('and too few on the unseen markets says so rather than guessing',
    V({ unseen: { edgeR: 0.2, n: 2, t: 2 } }) === 'untested elsewhere',
    'no data is not the same as no edge');

  // The discovery half and the holdout disagreeing on SIGN is the classic
  // overfit signature and must never read as success.
  check('an edge that flips sign between the halves is not a hold',
    V({ discovery: { edgeR: -0.4, n: 100, t: -3 } }) !== 'confirmed'
    && V({ discovery: { edgeR: -0.4, n: 100, t: -3 } }) !== 'holds',
    'found short, paid long, is noise wearing a result');
}

// ── The bar is higher than the narrow study's, on purpose ───────────────────
{
  const narrow = require(path.join(__dirname, '..', 'vps-bot', 'src', 'regimeStudy.js'));
  check('more entries are required on the search half than the narrow study asks',
    S.MIN_A > narrow.MIN_A, `${S.MIN_A} against ${narrow.MIN_A}`);
  check('more on the time holdout too',
    S.MIN_B > narrow.MIN_B, `${S.MIN_B} against ${narrow.MIN_B}`);
  check('and fewer candidates are carried, so the correction stays tight',
    S.CARRY <= narrow.CARRY, `${S.CARRY} against ${narrow.CARRY}`,
    'a wider search that also carried more would be strictly worse than the narrow one');
  check('the unseen half needs its own minimum before it may speak',
    S.MIN_P >= S.MIN_B, `${S.MIN_P}`);
}

// ── Scope is declared, not implied ──────────────────────────────────────────
{
  check('the universe spans more than one asset class',
    new Set(S.UNIVERSE.map(u => u.cls)).size >= 4,
    [...new Set(S.UNIVERSE.map(u => u.cls))].join(', '),
    'a rule that holds across FX, metals, indices and energy is a fact about markets');
  check('and more than one timeframe is searched',
    S.TIMEFRAMES.length >= 2, S.TIMEFRAMES.map(t => t.tf).join(', '));
  check('every timeframe declares its own holding periods in BARS',
    S.TIMEFRAMES.every(t => t.holds?.length && t.ms > 0),
    'twelve bars means twelve hours on H1 and two days on H4; sharing a number would silently change the question');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

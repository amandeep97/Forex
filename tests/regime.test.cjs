// The regime study — what is working now, and whether it can be believed.
//
// Every other study in this repository tests a named pattern over five years
// and reports "no". This one names nothing: it searches recent history for the
// states that precede the moves. That is a much easier way to find something,
// and therefore a much easier way to find nothing dressed as something, so most
// of what follows is about the machinery that stops it.
//
// The two that matter are at the bottom. On a series with a real effect planted
// in it, the study has to find the effect. On a pure random walk it has to come
// back empty — and it has to come back empty even though the search will
// certainly turn up rules that look wonderful on the half of history they were
// found in. That second one is the whole reason the holdout exists.
const path = require('path');
const R = require(path.join(__dirname, '..', 'vps-bot', 'src', 'regimeStudy.js'));

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const H = 3600e3;
const DAY = 86400e3;

// ── The split ───────────────────────────────────────────────────────────────
// Alternating fortnights, not the first six months and the last six. Split by
// date and the holdout is a different market: a rule dies because November was
// not June, and there is no way to tell that apart from the rule being fake.
{
  const start = Date.UTC(2026, 0, 1);
  const at = d => R.sideOf(start + d * DAY, start, 0);
  check('the first fortnight is where the search happens', at(1) === 'A' && at(13) === 'A');
  check('the second is held back', at(15) === 'B' && at(27) === 'B');
  check('and they keep alternating', at(29) === 'A' && at(43) === 'B');
  check('a bar cannot belong to both halves',
    [1, 15, 29, 43, 57].every(d => ['A', 'B'].includes(at(d))));
  check('anything before the window belongs to neither', at(-3) === null);

  // A trade opened near the end of a block is still running when the block
  // ends, so its outcome would be scored partly on the other half's bars.
  const hold = 24 * H;
  check('a trade that would straddle the fence is dropped',
    R.sideOf(start + 14 * DAY - 6 * H, start, hold) === null,
    'otherwise the holdout is scored on bars the search half selected');
  check('and one with room to finish is kept',
    R.sideOf(start + 14 * DAY - 30 * H, start, hold) === 'A');
}

// ── One condition lasting six hours is one opportunity ──────────────────────
// This is the easiest way in the world to turn thirty independent observations
// into a hundred and eighty fake ones, and it inflates every significance test
// downstream by the square root of the duplication.
{
  const feats = Array.from({ length: 200 }, (_, i) => ({ i, t: i * H, on: i >= 50 && i < 80 }));
  const e = R.entriesOf(feats, f => f.on, 12, null);
  check('a condition true for thirty straight bars gives three entries, not thirty',
    e.length === 3, JSON.stringify(e));
  check('spaced by the holding period', e[1] - e[0] === 12 && e[2] - e[1] === 12);
  check('counting every bar would have said thirty',
    feats.filter(f => f.on).length === 30, 'which is the inflation this avoids');
  check('and an entry with no room to finish is not opened',
    R.entriesOf(feats, f => f.i > 190, 12, null).length === 0);
  check('a slice filter excludes bars rather than shifting them',
    R.entriesOf(feats, f => f.on, 12, f => f.i >= 60).length === 2);
}

// ── The comparison ──────────────────────────────────────────────────────────
// R per trade, not win rate: a win rate can rise while expectancy falls, and
// more small wins against the same big losses is not an improvement.
{
  const a = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 2 : -1));
  const b = Array.from({ length: 600 }, (_, i) => (i % 4 === 0 ? 2 : -1));
  const t = R.welch(a, b);
  check('a better payoff shows as a positive statistic', t > 0, String(t));
  check('the same numbers the other way round flip the sign',
    Math.abs(R.welch(b, a) + t) < 0.01, String(R.welch(b, a)));
  check('two identical samples show nothing', Math.abs(R.welch(a, a)) < 1e-9);
  check('a handful of trades gives no statistic rather than a large one',
    R.welch([1, 2], [3, 4, 5]) === null);
  check('the strict threshold is the ordinary one split across the rules carried',
    R.zFor(R.CARRY) > 2.8 && R.zFor(1) < 2, `${R.zFor(R.CARRY).toFixed(2)} vs ${R.zFor(1)}`);
}

// ── The verdict is graded, because a year of bars cannot do better ──────────
{
  const mk = (aEdge, bEdge, bT, bN = 40) => ({
    discovery: { edgeR: aEdge, n: 60 },
    holdout: { edgeR: bEdge, t: bT, n: bN },
  });
  check('an edge that survives the unseen half at the strict threshold is confirmed',
    R.verdictOf(mk(0.4, 0.35, 3.2)) === 'confirmed');
  check('one that survives at the ordinary threshold holds',
    R.verdictOf(mk(0.4, 0.30, 2.2)) === 'holds');
  check('one that shrinks to nothing fades',
    R.verdictOf(mk(0.4, 0.03, 0.2)) === 'fades');
  check('one that reverses sign fails, which is what noise does',
    R.verdictOf(mk(0.4, -0.2, -1.1)) === 'fails');
  check('too few trades on the unseen half says so instead of guessing',
    R.verdictOf(mk(0.4, 0.9, 4.0, 5)) === 'thin', `MIN_B is ${R.MIN_B}`);
  check('a rule with no discovery number is thin, not confirmed',
    R.verdictOf({ holdout: { edgeR: 1, t: 9, n: 90 } }) === 'thin');
}

// ── "New" has to be measured, not asserted ─────────────────────────────────
{
  const mk = (now, before, n = 80) => ({
    holdout: { edgeR: now, n: 40 }, discovery: { edgeR: now, n: 60 },
    prior: { edgeR: before, n },
  });
  check('works now, did not work in the three years before, is new',
    R.noveltyOf(mk(0.35, -0.02)) === 'new');
  check('worked then and works now is longstanding, not news',
    R.noveltyOf(mk(0.30, 0.25)) === 'longstanding');
  check('worked then and does not now is the warning nobody prints',
    R.noveltyOf(mk(-0.10, 0.30)) === 'faded');
  check('a three-hundredth of an R three years ago is not "it worked before"',
    R.noveltyOf(mk(0.35, 0.03)) === 'new',
    'without a dead band, noise in the prior window relabels every real finding');
  check('and with no comparable sample it says that rather than claiming novelty',
    R.noveltyOf(mk(0.35, 0.0, 4)) === 'no-history');
}

// ── Anatomy: measured against the right thing ──────────────────────────────
// "Price was falling into it" is true of nearly every low, so comparing a turn
// to every bar mostly rediscovers the definition of a low. Turns that RAN
// against turns that DIED are both pivots, and the difference is the part worth
// knowing.
{
  // Sixty pivots. The thirty that ran were all in the London session; the
  // thirty that died were not. Nothing else differs.
  const feats = [];
  const events = [];
  for (let i = 0; i < 600; i++) feats.push({ i, t: i * H, b: { session: i % 2 ? 'london' : 'asia' } });
  for (let n = 0; n < 30; n++) {
    events.push({ i: n * 2 + 1, dir: 'up', inAtr: 2, inBars: 5, outAtr: 4, outBars: 9 });   // london, ran
    events.push({ i: n * 2 + 100, dir: 'up', inAtr: 2, inBars: 5, outAtr: 1, outBars: 9 }); // died
  }
  const keysOf = f => (f?.b?.session ? [`session=${f.b.session}`] : []);
  const a = R.anatomy(events, feats, keysOf, { from: 0 });
  check('turns and fizzles are separated by what happened next',
    a.turns.n === 30 && a.fizzles.n === 30, `${a.turns.n}/${a.fizzles.n}`);
  const lon = a.ranVsDied.find(r => r.key === 'session=london');
  check('the condition that separates them is found',
    lon && lon.ratio > 1.5, JSON.stringify(lon));
  check('and both counts are printed, so nobody has to trust the ratio',
    lon && lon.nRan > 0 && lon.nDied >= 0, JSON.stringify(lon));
  check('the base rate is the same window the events came from, not all of history',
    a.bars === 600, String(a.bars));
  const half = R.anatomy(events, feats, keysOf, { from: 300 * H });
  check('so restricting the window restricts the base too', half.bars === 300, String(half.bars));
  check('an empty window is refused rather than dividing by zero',
    R.anatomy(events, feats, keysOf, { from: 1e15 }).bars === 0);
}

// ── Drift: has the market itself changed ───────────────────────────────────
{
  const mk = (n, session) => Array.from({ length: n }, (_, i) => ({ i, b: { session } }));
  const keysOf = f => [`session=${f.b.session}`];
  const d = R.drift([...mk(80, 'london'), ...mk(20, 'asia')], mk(100, 'asia'), keysOf);
  const lon = d.find(r => r.key === 'session=london');
  check('a state that went from never to most of the time is the top row',
    d[0].key === 'session=london', d[0].key);
  check('with both frequencies shown', lon.nowPct === 80 && lon.thenPct === 0,
    JSON.stringify(lon));
  check('and no ratio invented when it never happened before', lon.ratio === null);
  check('an empty window returns nothing rather than every condition at infinity',
    R.drift([], mk(10, 'asia'), keysOf).length === 0);
}

// ── End to end ──────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 6, 1);
function makeOanda(plant) {
  // Deterministic, so a failure here is reproducible rather than a bad afternoon.
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const series = (px, vol, doPlant) => {
    const cs = [];
    let p = px;
    const n = 2 * 365 * 24;
    const start = NOW - n * H;
    for (let i = 0; i < n; i++) {
      const t = start + i * H;
      const d = new Date(t).getUTCDay();
      if (d === 6 || (d === 0 && new Date(t).getUTCHours() < 22)) continue;
      const o = p;
      let c = o + (rnd() - 0.5) * vol;
      if (doPlant && plant) c += plant(t, vol);
      cs.push({ t, o, h: Math.max(o, c) + rnd() * vol * 0.4,
        l: Math.min(o, c) - rnd() * vol * 0.4, c, v: 100 });
      p = c;
    }
    return cs;
  };
  const au = series(2000, 4, true), ag = series(25, 0.06, false);
  return {
    async getCandlesSince(sym, tf, from, { to }) {
      return (sym === 'XAU_USD' ? au : ag).filter(c => c.t >= from && c.t <= to);
    },
  };
}

const RECENT = NOW - 365 * 24 * H;

(async () => {
  // A real effect, planted only in the recent year: gold drifts up through the
  // London session and nowhere else.
  const found = await R.runRegimeStudy({
    oanda: makeOanda((t, vol) => {
      const h = new Date(t).getUTCHours();
      return (t >= RECENT && h >= 7 && h < 12) ? 0.30 * vol : 0;
    }),
    now: NOW, recentDays: 365, priorDays: 365,
  });
  check('a study runs end to end and publishes a result', !found.error, found.error || '');
  const live = (found.rules || []).filter(r => r.verdict === 'confirmed' || r.verdict === 'holds');
  check('a real effect is found', live.length > 0,
    `${found.method?.searched} combinations searched, tally ${JSON.stringify(found.tally)}`);
  check('and it is the effect that was planted',
    live.some(r => r.all.includes('session=london') && r.dir === 'up'),
    live.map(r => `${r.label} ${r.dir}`).join(' | ') || 'nothing survived');
  check('planted in the recent year only, it is reported as new',
    live.filter(r => r.all.includes('session=london'))
      .some(r => r.novelty === 'new' || r.novelty === 'stronger-now'),
    live.filter(r => r.all.includes('session=london')).map(r => r.novelty).join(','));
  check('the edge is stated against a random entry, not against 50%',
    live[0]?.holdout?.baseExpR != null && live[0].holdout.edgeR
      === +(live[0].holdout.expR - live[0].holdout.baseExpR).toFixed(3),
    JSON.stringify(live[0]?.holdout));
  check('what is true on the last bar is reported for both metals',
    found.now?.XAU_USD?.keys?.length > 0 && found.now?.XAG_USD?.keys?.length > 0);
  // The bot re-runs on a version change as well as on age. Version 1's
  // round-number condition was an artefact of gold doubling in price, and a
  // file six days old would have been six more days of a wrong answer.
  check('the published file states which version of the method produced it',
    found.methodVersion === R.METHOD_VERSION && found.method?.version === R.METHOD_VERSION,
    `${found.methodVersion} vs ${R.METHOD_VERSION}`);
  check('turns and fizzles both exist, or "why did this one run" has no comparison',
    found.anatomy?.XAU_USD?.turns?.n > 0 && found.anatomy?.XAU_USD?.fizzles?.n > 0,
    `${found.anatomy?.XAU_USD?.turns?.n} ran, ${found.anatomy?.XAU_USD?.fizzles?.n} died`);

  // The same machinery on a pure random walk. The search WILL turn up rules
  // that look excellent on the half they were found in — that is what searching
  // a hundred conditions over six thousand bars does. None of them may survive.
  const noise = await R.runRegimeStudy({
    oanda: makeOanda(null), now: NOW, recentDays: 365, priorDays: 365,
  });
  const best = (noise.rules || []).reduce((a, r) =>
    (r.discovery?.edgeR > (a?.discovery?.edgeR ?? -9) ? r : a), null);
  check('on a random walk the search still finds something that looks good',
    best?.discovery?.edgeR > 0.1,
    `best on the search half: ${best?.discovery?.edgeR}R at t=${best?.discovery?.t}`);
  check('and the holdout kills it', (noise.tally?.confirmed || 0) === 0,
    `tally ${JSON.stringify(noise.tally)} — this is the check the whole design exists for`);
  check('every one of them, not just most',
    (noise.tally?.confirmed || 0) + (noise.tally?.holds || 0) === 0,
    JSON.stringify(noise.tally));
  check('the rejected ones are still published, so the list is honest about what was tried',
    (noise.rules || []).length > 0);

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

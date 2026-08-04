// src/utils/indexBreadth.js
// What the index complex is saying about itself.
//
// One index in isolation tells you its own direction. The four together tell
// you WHO is leading, and that is a different and more useful fact: a new high
// on the Nasdaq while the Dow lags is a narrow, tech-led move on fragile
// breadth; the Dow leading while the Nasdaq stalls is rotation into value,
// usually a rates or growth scare. All four aligned is the cleanest trend
// there is.
//
// Russell 2000 carries the most information per point because small caps are
// the purest read on risk appetite — they are domestically exposed, more
// leveraged, and the first thing sold when the mood turns.
//
// Leadership rotates by regime, which is exactly why none of this is hardcoded.
// Everything below is measured from the feed's own daily closes, so the answer
// changes when the market does instead of repeating what was true in 2023.

const US_COMPLEX = [
  { sym:'US100',  label:'Nasdaq 100',   role:'tech / long duration' },
  { sym:'US500',  label:'S&P 500',      role:'the broad market' },
  { sym:'US30',   label:'Dow 30',       role:'value / industrials' },
  { sym:'US2000', label:'Russell 2000', role:'small caps — risk appetite' },
];

const closes = rec => rec?.spark?.D?.c;

export function indexComplex(feed) {
  const members = [];
  for (const m of US_COMPLEX) {
    const c = closes(feed?.instruments?.[m.sym]);
    if (!Array.isArray(c) || c.length < 10) continue;
    const first = c[0], last = c[c.length - 1];
    if (!(first > 0)) continue;
    const hi = Math.max(...c), lo = Math.min(...c);
    members.push({
      ...m,
      chg: +(((last - first) / first) * 100).toFixed(2),
      // "New high" means the highest close in the published window, and the
      // window is stated wherever this is shown. It is not an all-time high and
      // must never be read as one.
      newHigh: last >= hi - 1e-9,
      fromHigh: hi > 0 ? +(((last - hi) / hi) * 100).toFixed(2) : 0,
      fromLow:  lo > 0 ? +(((last - lo) / lo) * 100).toFixed(2) : 0,
      bars: c.length,
    });
  }
  if (members.length < 2) return { members, ok:false };

  const ranked = [...members].sort((a, b) => b.chg - a.chg);
  const leader = ranked[0], laggard = ranked[ranked.length - 1];
  const ups = members.filter(m => m.chg > 0).length;
  const aligned = ups === members.length || ups === 0;

  const by = Object.fromEntries(members.map(m => [m.sym, m]));
  const nq = by['US100'], dow = by['US30'], rut = by['US2000'], spx = by['US500'];

  // The readings the article describes, each stated only when its own
  // precondition actually holds.
  let regime = null;
  if (aligned) {
    regime = { key:'aligned', headline: ups ? 'All aligned higher' : 'All aligned lower',
      detail:'Every index agrees. This is the cleanest trend condition — leadership is not in question.' };
  } else if (nq?.newHigh && dow && !dow.newHigh) {
    regime = { key:'narrow', headline:'Narrow, tech-led',
      detail:`Nasdaq at a ${nq.bars}-day high while the Dow is ${dow.fromHigh}% off its own. Breadth is fragile — the move rests on few names.` };
  } else if (dow && nq && dow.chg > nq.chg && dow.chg > 0) {
    regime = { key:'rotation', headline:'Rotation into value',
      detail:'The Dow is leading and the Nasdaq lagging. Usually a rates or growth-scare signal rather than broad strength.' };
  } else {
    regime = { key:'mixed', headline:'Mixed leadership',
      detail:'No index is clearly leading the complex. Trend signals from any single one are weaker than usual here.' };
  }

  // Small caps against the broad market — the risk-appetite read, and the one
  // most often ignored because the Russell is not what people watch.
  let riskAppetite = null;
  if (rut && spx) {
    const gap = +(rut.chg - spx.chg).toFixed(2);
    riskAppetite = {
      gap,
      state: gap > 1 ? 'risk-on' : gap < -1 ? 'risk-off' : 'neutral',
      detail: gap > 1
        ? `Small caps are beating the S&P by ${gap}% — genuine risk appetite, and it usually leads.`
        : gap < -1
          ? `Small caps are trailing the S&P by ${Math.abs(gap)}% — risk appetite is narrowing, which tends to lead the broad market lower.`
          : 'Small caps are moving with the S&P — no strong signal either way.',
    };
  }

  return {
    ok: true, members, ranked, leader, laggard, aligned, regime, riskAppetite,
    bars: Math.min(...members.map(m => m.bars)),
  };
}

// When does each market actually move?
//
// "London open" and "the New York session" are somebody else's measurement of
// somebody else's instruments. This measures the ones on the board — two months
// of fifteen-minute bars bucketed by UTC hour.
//
// The traps are the usual ones. Gold's dollar range and EUR/USD's cannot be
// added together, so everything is normalised against the instrument's own
// average before pooling. A fast hour with a wide spread is not a fast hour you
// can trade. And a big range that closes where it opened is chop, not a move —
// which is the difference between an hour worth waiting for and an hour worth
// avoiding.
const path = require('path');
const S = require(path.join(__dirname, '..', 'vps-bot', 'src', 'hourStudy.js'));

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// M15 bars across whole days. `spec(hour)` returns { range, carry } so a test
// can make one hour behave differently from the rest.
function series(days, spec) {
  const cs = [];
  let t = Date.UTC(2026, 0, 1, 0, 0, 0);
  let p = 100;
  for (let d = 0; d < days; d++) {
    for (let q = 0; q < 96; q++) {
      const hour = Math.floor(q / 4);
      const { range, carry } = spec(hour);
      const o = p;
      const c = o + range * carry;          // net movement inside the bar
      const hi = Math.max(o, c) + range * (1 - carry) / 2;
      const lo = Math.min(o, c) - range * (1 - carry) / 2;
      cs.push({ t, o, h: hi, l: lo, c });
      p = c;
      t += 15 * 60e3;
    }
  }
  return cs;
}

// ── One busy hour, and it is found ──────────────────────────────────────────
{
  const cs = series(30, h => ({ range: h === 13 ? 0.30 : 0.10, carry: 0.5 }));
  const p = S.profileOne(cs, 0);
  check('every hour is profiled', p.filter(Boolean).length === 24, String(p.filter(Boolean).length));
  check('the busy hour reads as busy', p[13].rel > 2.5, String(p[13].rel));
  // Derived rather than guessed: twenty-three hours at 0.10 and one at 0.30
  // average 0.1083, so an ordinary hour is 0.10/0.1083 — just under 1, because
  // the one busy hour drags the average it is measured against upward.
  const expected = 0.10 / ((23 * 0.10 + 0.30) / 24);
  check('and an ordinary hour sits just below its own average',
    Math.abs(p[7].rel - expected) < 0.01, `${p[7].rel.toFixed(3)} vs ${expected.toFixed(3)}`);
  check('the sample behind each hour is stated', p[13].n === 30 * 4, String(p[13].n));
}

// ── Normalised per instrument, or one big number wins ───────────────────────
// Gold moves in dollars and EUR/USD in ten-thousandths. Pooled raw, gold would
// be the only thing the answer described.
{
  const small = S.profileOne(series(30, h => ({ range: h === 8 ? 0.0003 : 0.0001, carry: 0.5 })), 0);
  const large = S.profileOne(series(30, h => ({ range: h === 8 ? 30 : 10, carry: 0.5 })), 0);
  check('a tiny instrument and a huge one report the same shape',
    Math.abs(small[8].rel - large[8].rel) < 0.01, `${small[8].rel} vs ${large[8].rel}`);
  const pooled = S.pool([small, large]);
  check('so pooling them cannot be dominated by the larger one',
    Math.abs(pooled[8].rel - small[8].rel) < 0.01, String(pooled[8].rel));
  check('and the pool says how many instruments are behind it',
    pooled[8].instruments === 2);
}

// ── Range is not the same question as movement ──────────────────────────────
// Two hours, identical range. One carries; the other gives it all back.
{
  const cs = series(30, h => ({
    range: 0.20,
    carry: h === 9 ? 0.9 : h === 21 ? 0.05 : 0.5,
  }));
  const p = S.profileOne(cs, 0);
  check('a trend hour and a chop hour have the same range',
    Math.abs(p[9].rel - p[21].rel) < 0.01, `${p[9].rel} vs ${p[21].rel}`);
  check('but the trend hour carries and the chop hour does not',
    p[9].carry > 0.8 && p[21].carry < 0.15, `${p[9].carry} vs ${p[21].carry}`);
  check('which is the difference between waiting for an hour and avoiding it',
    p[9].carry > p[21].carry * 5);
}

// ── Cost ────────────────────────────────────────────────────────────────────
{
  const cs = series(30, h => ({ range: h === 3 ? 0.02 : 0.20, carry: 0.5 }));
  const p = S.profileOne(cs, 0.01);
  check('the spread is expressed against the hour\'s own range',
    p[3].cost > p[12].cost, `${p[3].cost} vs ${p[12].cost}`);
  check('so a thin hour reads as expensive even at the same spread',
    p[3].cost > 0.4, String(p[3].cost));
  const free = S.profileOne(cs, 0);
  check('an instrument with no published spread reports unknown, not zero',
    free[3].cost === null,
    '32 of 72 publish no spread and treating those as free is how an '
    + 'untradeable setup became the best on the board');
}

// ── Refusals ────────────────────────────────────────────────────────────────
{
  check('too little history is refused rather than guessed',
    S.profileOne(series(2, () => ({ range: 0.1, carry: 0.5 })), 0) === null,
    `fewer than ${S.MIN_PER_SLOT} bars in a slot is not an hour's behaviour`);
  const patchy = series(30, () => ({ range: 0.1, carry: 0.5 }))
    .filter(c => new Date(c.t).getUTCHours() < 6);
  check('a series covering only part of the day is refused too',
    S.profileOne(patchy, 0) === null, 'six hours is not a profile of a day');
  check('an empty pool is null rather than a zero', S.pool([[null]])[0] === null);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

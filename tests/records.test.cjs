// The forward pass every base rate in the app rests on, and the pooling and
// significance built on top of it.
//
// Three separate holes were being papered over. Candles were never measured
// forward, so most cards could be drawn and never priced. Positioning was
// fetched, published, and read from a shape nothing supplied, so the
// highest-weighted family had never appeared. And a 48% win rate over 33
// samples was reported as "the record says no" when its interval runs from
// 31% to 65%.
const ROOT = require('path').join(__dirname, '..') + '/';
const { forwardOutcome, atrSeries, REVERSAL_DIR } = require(`${ROOT}vps-bot/src/feed.js`);

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const T0 = 1500000000000;

// A series where the answer is known: after every marked bar, price rises by a
// fixed amount over the next 10 bars. A correctly signed 'up' event must score
// 100%; the identical event marked 'down' must score 0%.
function series(n, markEvery) {
  const cs = [];
  let p = 100;
  const marks = [];
  for (let i = 0; i < n; i++) {
    const isMark = i % markEvery === 0 && i > 20 && i < n - 20;
    // Deterministic wobble so ATR is non-zero without being random.
    p += isMark ? 0 : ((i % 7) - 3) * 0.05;
    const bar = { t: T0 + i * 86400e3, o: p, h: p + 0.5, l: p - 0.5, c: p };
    cs.push(bar);
    if (isMark) { marks.push({ at: bar.t, dir: 'up' }); }
    // The drift that follows a mark.
    if (marks.length && i > 0 && marks.some(m => m.at === cs[i - 1]?.t)) p += 0;
  }
  // Apply a clean +2.0 drift over the 10 bars after each mark.
  for (const m of marks) {
    const idx = cs.findIndex(c => c.t === m.at);
    for (let k = idx + 1; k < Math.min(cs.length, idx + 11); k++) {
      const bump = 2.0 * ((k - idx) / 10);
      cs[k].c += bump; cs[k].h += bump; cs[k].l += bump; cs[k].o += bump;
    }
  }
  return { cs, marks };
}

const { cs, marks } = series(400, 40);
const idxOf = new Map(cs.map((c, i) => [c.t, i]));

const up = forwardOutcome(cs, idxOf, marks, 10);
check('a forward outcome is measured over the stated window', up.fwdBars === 10, String(up.fwdBars));
check('it counts only occurrences with a complete future',
  up.fwdN > 0 && up.fwdN <= marks.length, `${up.fwdN} of ${marks.length}`);
check('an up event followed by a rise scores as working', up.fwdWin === 100, `${up.fwdWin}%`);
check('and the median move is positive, in ATR', up.fwdMedAtr > 0, `${up.fwdMedAtr} ATR`);

// The same bars, the same rise, the opposite label.
const down = forwardOutcome(cs, idxOf, marks.map(m => ({ ...m, dir: 'down' })), 10);
check('the same rise scores as failing for a down event', down.fwdWin === 0, `${down.fwdWin}%`);
check('direction is signed, not assumed — the medians mirror',
  Math.abs(up.fwdMedAtr + down.fwdMedAtr) < 0.01, `${up.fwdMedAtr} vs ${down.fwdMedAtr}`);

// ── Too few is reported as too few, never as a rate ───────────────────────
const few = forwardOutcome(cs, idxOf, marks.slice(0, 3), 10);
check('fewer than five occurrences yields no win rate at all',
  few.fwdWin === undefined && few.fwdN === 3, JSON.stringify(few));

// ── ATR is computed once and reused ───────────────────────────────────────
const fn = atrSeries(cs);
check('the shared ATR series gives the same answer as the built-in one',
  JSON.stringify(forwardOutcome(cs, idxOf, marks, 10, fn)) === JSON.stringify(up));
check('ATR is a real number at a mid-series bar', fn(200) > 0, String(fn(200)?.toFixed(4)));

// ── Every pattern that can reach a card can be signed ─────────────────────
const { REVERSAL_UI } = (() => {
  const src = require('fs').readFileSync(`${ROOT}src/utils/confluence.js`, 'utf8');
  const body = src.slice(src.indexOf('const REVERSAL = {'), src.indexOf('};', src.indexOf('const REVERSAL = {')));
  const ids = [...body.matchAll(/(\w+):'(up|down)'/g)].map(m => [m[1], m[2]]);
  return { REVERSAL_UI: Object.fromEntries(ids) };
})();
check('the bot signs every pattern the app is willing to display',
  Object.keys(REVERSAL_UI).every(id => REVERSAL_DIR[id] === REVERSAL_UI[id]),
  Object.keys(REVERSAL_UI).filter(id => REVERSAL_DIR[id] !== REVERSAL_UI[id]).join(' ') || 'all match');
check('and does not sign anything the app would not show',
  Object.keys(REVERSAL_DIR).every(id => REVERSAL_UI[id]),
  Object.keys(REVERSAL_DIR).filter(id => !REVERSAL_UI[id]).join(' ') || 'none extra');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

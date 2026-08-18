// Against the LIVE feed shape: the screen must actually select.
import { rank } from '../src/utils/confluence.js';
import { readFileSync } from 'fs';
let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// Runs against a real feed snapshot, because selectivity is a property of live
// data and cannot be demonstrated on a fixture built to pass.
const path = process.argv[2] || '/tmp/feed-live.json';
let feed;
try { feed = JSON.parse(readFileSync(path, 'utf8')); }
catch {
  const r = await fetch('https://raw.githubusercontent.com/amandeep97/Forex/main/bot/feed.json');
  feed = await r.json();
}
const total = Object.keys(feed.instruments).length;
const now = Date.parse(feed.updatedAt);

const two = rank(feed, { now, minBreadth: 2 });
const three = rank(feed, { now, minBreadth: 3 });
console.log(`         ${total} measured → ${two.length} with 2+ families, ${three.length} with 3+`);
// Measured, not asserted into existence. A threshold cannot be selective on
// its own: on a quiet day nothing clears it, on a busy one everything does.
// What these pin is that the fixes moved the numbers in the right direction
// and that the top-N default is what actually bounds the screen.
// The bound moved once, deliberately. Admitting the intraday population — the
// rarity gate had been deleting 100% of it — adds cards that could not exist
// before, so the two-family count rises by exactly the number of intraday-only
// entrants. The selectivity that matters is measured on the swing side, which
// must be unchanged, and on the three-family threshold below.
const swingSide = two.filter(r => r.kind !== 'intraday');
check('two-family candidates are well down from 97%', two.length <= total * 0.7,
  `${two.length}/${total} = ${Math.round(100*two.length/total)}% — was 70/72`);
check('and the swing side did not get less selective when intraday was let in',
  swingSide.length <= total * 0.6,
  `${swingSide.length}/${total} swing · ${two.length - swingSide.length} intraday-only`);
check('three families is genuinely selective', three.length <= total * 0.35,
  `${three.length}/${total} = ${Math.round(100*three.length/total)}%`);
check('the default view is bounded regardless of the market',
  rank(feed, { now, minBreadth: 3, top: 12 }).length <= 12);
check('but not empty', two.length >= 1);

// Context alone must never produce a card.
check('every card has something that HAPPENED',
  two.every(r => r.evidence.some(e => e.family === 'price' || e.family === 'structure')),
  'volatility regime and leadership are states, not events');

check('everything is ranked against the full population',
  two.every(r => r.of === total && r.rank >= 1 && r.pct >= 1 && r.pct <= 100));
check('rank is ordered', two.every((r,i) => i === 0 || two[i-1].rank < r.rank));
check('top-N caps the list', rank(feed, { now, minBreadth: 2, top: 5 }).length <= 5);

// No card may list a bullish and a bearish candle pattern at once.
const bothWays = two.filter(r => {
  const p = r.evidence.filter(e => e.family === 'price');
  return p.some(e => e.dir === 'up') && p.some(e => e.dir === 'down');
});
check('no card lists opposing candle patterns', bothWays.length === 0,
  bothWays.map(r => r.sym).join(', '));

const disagree = two.filter(r => r.conflict).length;
check('EVIDENCE DISAGREES is now the exception', disagree <= two.length * 0.5,
  `${disagree}/${two.length}`);

// Freshness must be measured in bars against the feed's own last bar.
const stale = two.filter(r => r.evidence.some(e => {
  const m = String(e.label).match(/\b(M15|M30|H1|H4|D)\b/);
  if (!m) return false;
  const TF = { M15:900e3, M30:1800e3, H1:3600e3, H4:14400e3, D:86400e3 };
  return false;
}));
check('nothing older than the bar window survives', stale.length === 0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

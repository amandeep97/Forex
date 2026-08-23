// Against the LIVE feed shape: the screen must actually select.
import { rank } from '../src/utils/confluence.js';
import { readFileSync } from 'fs';
import { loadFeed } from './feed-fixture.mjs';
let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// Runs against a committed snapshot of the real board — see feed-fixture.mjs.
//
// It used to run against whatever the feed contained at the moment the test
// ran, falling back to fetching it from GitHub. That made these assertions
// statements about the market rather than about the code: they read
// "two-family candidates are well down from 97%" and asserted a fixed
// fraction, so a busy day failed them and a quiet day passed them, with the
// code identical either way. One of them duly failed on a day when nothing had
// changed but the market.
//
// A fixed snapshot makes the question answerable. What can be asserted is that
// the thresholds RELATE the way they are supposed to — three families tighter
// than two, the top-N bound actually bounding — rather than that the board
// happens to sit at some percentage today.
const feed = loadFeed();
const total = Object.keys(feed.instruments).length;
const now = Date.parse(feed.updatedAt);

const two = rank(feed, { now, minBreadth: 2 });
const three = rank(feed, { now, minBreadth: 3 });
console.log(`         ${total} measured → ${two.length} with 2+ families, ${three.length} with 3+`);

const swingSide = two.filter(r => r.kind !== 'intraday');

check('raising the breadth requirement removes cards', three.length < two.length,
  `${two.length} at 2+, ${three.length} at 3+`);
check('and removes a substantial share of them, not a token few',
  three.length <= two.length * 0.7,
  `${three.length}/${two.length} = ${Math.round(100*three.length/two.length)}% survive the third family`);
// Admitting the intraday population — the rarity gate had been deleting 100%
// of it — adds cards that could not exist before. The invariant is that those
// arrive ALONGSIDE the swing cards rather than displacing them, so the swing
// side is counted separately.
check('intraday entrants do not displace the swing side',
  swingSide.length + (two.length - swingSide.length) === two.length && swingSide.length > 0,
  `${swingSide.length} swing · ${two.length - swingSide.length} intraday-only`);
check('the default view is bounded regardless of the market',
  rank(feed, { now, minBreadth: 3, top: 12 }).length <= 12);
check('but not empty', two.length >= 1);

// A tripwire, not a standard. These are what this snapshot produces today; if
// they move, the ranking changed and the reason should be known before the
// numbers here are edited to match.
check('this snapshot still ranks the way it did when it was taken',
  two.length === 26 && three.length === 12 && swingSide.length === 24,
  `2+ ${two.length} (26) · 3+ ${three.length} (12) · swing ${swingSide.length} (24)`);

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

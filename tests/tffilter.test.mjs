import { rank } from '../src/utils/confluence.js';
import { readFileSync } from 'fs';
import { loadFeed } from './feed-fixture.mjs';
let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

const feed = loadFeed();
const now = Date.parse(feed.updatedAt);
const total = Object.keys(feed.instruments).length;
const all = rank(feed, { now, minBreadth: 2 });

// The bug: tfs was scraped from the label with a regex listing only H4 and D,
// so every intraday filter matched nothing.
const counts = {};
for (const tf of ['M15','M30','H1','H4','D']) counts[tf] = all.filter(r => (r.tfs||[]).includes(tf)).length;
console.log('         candidates per timeframe:', JSON.stringify(counts));
for (const tf of ['M15','M30','H1']) {
  check(`${tf} filter returns results`, counts[tf] > 0, `${counts[tf]} — was 0`);
}
check('H4 and D still work', counts.H4 > 0 && counts.D > 0);
check('every card has at least one timeframe', all.every(r => (r.tfs||[]).length > 0));
check('only real timeframes are reported',
  all.every(r => (r.tfs||[]).every(t => ['M15','M30','H1','H4','D'].includes(t))),
  'state also holds spreadRatio and posnPct, which are not timeframes');
check('no evidence label mentions a non-timeframe key',
  !all.some(r => r.evidence.some(e => /spreadRatio|posnPct|posnWeeks/.test(e.label))));

// Selectivity must survive going from two timeframes to five.
console.log(`         ${total} measured → ${all.length} at 2 families, ${rank(feed,{now,minBreadth:3}).length} at 3`);
check('the screen is still bounded by rank', rank(feed, { now, minBreadth:3, top:12 }).length <= 12);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

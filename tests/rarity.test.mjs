// Two filters that could never fire, and a score that rewarded contradiction.
//
// The rarity gate was an absolute per-month threshold applied to timeframes
// with 200x different bar counts, so the entire intraday population was
// excluded by construction — not mostly, entirely. And `base` summed every
// piece of evidence regardless of direction, so a card whose evidence
// disagreed outscored one whose evidence agreed.
import { rank, assess, rarityCutoffs } from '../src/utils/confluence.js';
import { readFileSync } from 'fs';
import { loadFeed } from './feed-fixture.mjs';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const NOW = 1786500000000;

const feed = loadFeed();
const now = Date.parse(feed.updatedAt);

// ── The cutoff is per timeframe, and never tighter than it used to be ─────
const cuts = rarityCutoffs(feed);
console.log(`         pattern cutoffs   ${JSON.stringify(cuts.pattern)}`);
console.log(`         structure cutoffs ${JSON.stringify(cuts.structure)}`);
// The guarantee is "never tighter than the cap", not "always equal to it".
// On a day when H4 events are unusually common, H4's own tenth percentile can
// run past 4/month, and admitting those is the same rule rather than a leak.
check('no timeframe is ever held to a tighter threshold than before',
  cuts.pattern.D >= 4 && cuts.pattern.H4 >= 4 && cuts.structure.D >= 8 && cuts.structure.H4 >= 8,
  `D ${cuts.pattern.D}/${cuts.structure.D} · H4 ${cuts.pattern.H4}/${cuts.structure.H4}`);
check('and the slow ones stay near it rather than drifting loose',
  cuts.pattern.D <= 6 && cuts.pattern.H4 <= 6,
  `D ${cuts.pattern.D} · H4 ${cuts.pattern.H4}`);
check('and the fast ones are graded against what they actually do',
  cuts.pattern.M15 > cuts.pattern.M30 && cuts.pattern.M30 > cuts.pattern.H1 && cuts.pattern.H1 > cuts.pattern.H4,
  `M15 ${cuts.pattern.M15} > M30 ${cuts.pattern.M30} > H1 ${cuts.pattern.H1} > H4 ${cuts.pattern.H4}`);
check('a fast cutoff is far looser than the absolute cap that deleted them',
  cuts.pattern.M15 > 20, `M15 admits up to ${cuts.pattern.M15}/month`);

// ── The intraday filters can now return something ─────────────────────────
const all = rank(feed, { now, minBreadth: 1 });
const kinds = all.reduce((m, a) => (m[a.kind] = (m[a.kind] || 0) + 1, m), {});
console.log(`         ${all.length} cards → ${JSON.stringify(kinds)}`);
check('the "Intraday" filter has rows to show', (kinds.intraday || 0) > 0, `${kinds.intraday || 0}`);
check('the "Timed entry" filter has rows to show', (kinds.trigger || 0) > 0, `${kinds.trigger || 0}`);
check('and a timed entry names the fast signal that timed it',
  all.filter(a => a.kind === 'trigger').every(a => a.trigger?.label),
  all.filter(a => a.kind === 'trigger').slice(0, 3).map(a => `${a.sym}: ${a.trigger?.label}`).join(' | '));
check('an intraday card is built only from intraday evidence',
  all.filter(a => a.kind === 'intraday').every(a => !a.swingTfs.length || !a.evidence.some(
    e => (e.tfs || []).some(t => t === 'D' || t === 'H4') && (e.family === 'price' || e.family === 'structure'))));

// ── Swing setups are still the bulk of the board ──────────────────────────
// Intraday being possible must not mean intraday taking over: it is the
// exception the user trades when it is clearly better, not the default.
const swingish = all.filter(a => a.kind !== 'intraday').length;
check('swing setups still dominate the board', swingish > all.length * 0.6,
  `${swingish} of ${all.length}`);

// ── Contradiction is no longer rewarded ───────────────────────────────────
// Same instrument, twice: once with a lone bullish break, once with a bearish
// candle added. The second has MORE total evidence weight and must not score
// higher for it.
const rec = (extra = {}) => ({ cls:'fx', name:'X', price:100, dec:2,
  state:{ D:{ atrPct:2, volPct:50, rangePos:50 } },
  events:[{ type:'break', dir:'up', at:NOW, tf:'D', detail:'closed above the swing high' }],
  rarity:{ 'break.D': { perMonth:1.2, n:20, fwdBars:10, fwdN:20, fwdWin:60, fwdMedAtr:1.2 } },
  patterns:{}, asOf:{ D: NOW, H4: NOW }, ...extra });

const clean = assess('C', rec(), { now: NOW });
const split = assess('S', rec({ patterns:{ D:[{ id:'shooting_star', at:NOW, rate:1.1 }] } }), { now: NOW });
check('the conflicted card really does carry more raw evidence',
  split.evidence.length > clean.evidence.length, `${split.evidence.length} vs ${clean.evidence.length}`);
check('but it no longer outscores the card whose evidence agrees',
  split.score < clean.score, `${split.score} vs ${clean.score}`);
check('coherence is reported so the reason is visible',
  clean.coherence === 1 && split.coherence < 1, `clean ${clean.coherence} · split ${split.coherence}`);
check('and the conflicted card is still shown, not deleted', split.score > 0);

// ── On the live board, conflict no longer floats to the top ───────────────
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const cf = avg(all.filter(a => a.conflict).map(a => a.rank));
const ag = avg(all.filter(a => !a.conflict).map(a => a.rank));
console.log(`         avg rank — conflicted ${cf?.toFixed(1)} · agreed ${ag?.toFixed(1)}`);
check('cards whose evidence agrees now rank ahead of cards that disagree',
  cf == null || ag == null || cf > ag, `${cf?.toFixed(1)} vs ${ag?.toFixed(1)} (was 22.5 vs 30.3)`);

// Not "the top card is never conflicted" — nothing guarantees that, and a
// genuinely busy instrument can still lead the board while its evidence
// argues with itself. What is pinned is that the view the user actually looks
// at is not dominated by them.
const top12 = rank(feed, { now, minBreadth: 3, top: 12 });
check('the default view is not mostly contradictions',
  top12.filter(a => a.conflict).length <= top12.length / 3,
  `${top12.filter(a => a.conflict).length} of ${top12.length}`);
check('a card is only called a contradiction when neither side dominates',
  all.filter(a => a.conflict).every(a => a.coherence < 0.5),
  all.filter(a => a.conflict && a.coherence >= 0.5).map(a => `${a.sym} ${a.coherence}`).join(' '));
check('a timed entry is never built on swing evidence that contradicts itself',
  all.filter(a => a.kind === 'trigger').every(a => !a.conflict),
  all.filter(a => a.kind === 'trigger' && a.conflict).map(a => a.sym).join(' '));

// ── The card leads with what happened ────────────────────────────────────
// Context carries fixed weights while events are scaled by timeframe, so on an
// intraday card the event sorted below the background that merely explains it.
const EVENT = new Set(['price', 'structure']);
check('every card leads with something that happened, not with context',
  all.every(a => EVENT.has(a.evidence[0].family)),
  all.filter(a => !EVENT.has(a.evidence[0].family)).slice(0, 3)
     .map(a => `${a.sym}: ${a.evidence[0].family}`).join(' | '));
check('and context still follows, rather than being dropped',
  all.some(a => a.evidence.some(e => !EVENT.has(e.family))));
check('within the events, the strongest is still first',
  all.every(a => {
    const ev = a.evidence.filter(e => EVENT.has(e.family)).map(e => e.weight);
    return ev.every((w, i) => i === 0 || ev[i - 1] >= w);
  }));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

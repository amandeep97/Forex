// forwardOutcome is the new innovation and the easiest thing to get subtly
// wrong, so it runs against the real feed module rather than a copy.
const ROOT = require('path').join(__dirname, '..') + '/';
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return require.resolve('./stub-fetch.cjs');
  return orig.call(this, req, ...rest);
};
const fs = require('fs');
let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// Imported, not scraped. This used to slice the function out of the module
// source and eval it, which worked only while forwardOutcome referenced
// nothing outside itself — the moment ATR was hoisted into a shared helper the
// extracted copy threw ReferenceError, and the test failed for a reason that
// had nothing to do with the behaviour it checks. The function is exported now.
const { forwardOutcome } = require(`${ROOT}vps-bot/src/feed.js`);

const DAY = 86400e3;
// A series that rises steadily, so an "up" event is always followed by higher
// prices and a "down" event never is.
const rising = Array.from({length: 200}, (_, i) => ({
  t: 1700000000000 + i*DAY, o: 100+i, h: 100.5+i, l: 99.5+i, c: 100+i, v: 1 }));
const idxOf = new Map(rising.map((c,i) => [c.t, i]));
const ev = (i, dir) => ({ at: rising[i].t, dir, type:'sweep' });

const up = forwardOutcome(rising, idxOf, [30,40,50,60,70,80,90].map(i => ev(i,'up')), 20);
check('bullish events on a rising series win every time', up.fwdWin === 100, `${up.fwdWin}%`);
check('sample size reported', up.fwdN === 7, String(up.fwdN));
check('horizon reported', up.fwdBars === 20);
check('median move is positive', up.fwdMedAtr > 0, String(up.fwdMedAtr));

const down = forwardOutcome(rising, idxOf, [30,40,50,60,70,80,90].map(i => ev(i,'down')), 20);
check('bearish events on the same series lose every time', down.fwdWin === 0, `${down.fwdWin}%`);
check('and the median is negative', down.fwdMedAtr < 0, String(down.fwdMedAtr));
check('direction genuinely flips the sign',
  Math.abs(up.fwdMedAtr + down.fwdMedAtr) < 1e-9, `${up.fwdMedAtr} vs ${down.fwdMedAtr}`);

// ── The look-ahead trap ───────────────────────────────────────────────────
// Events too near the end have no complete future. Counting them would bias
// the figure toward whatever just happened.
const nearEnd = forwardOutcome(rising, idxOf,
  [30,40,50,190,195,198].map(i => ev(i,'up')), 20);
check('events without a full forward window are excluded',
  nearEnd.fwdN === 3, `${nearEnd.fwdN} of 6 — 190, 195 and 198 have no 20-bar future`);

// ── Honest refusal on small samples ───────────────────────────────────────
const few = forwardOutcome(rising, idxOf, [30,40,50].map(i => ev(i,'up')), 20);
check('fewer than five occurrences reports no rate', few.fwdWin === undefined, JSON.stringify(few));
check('but still says how many there were', few.fwdN === 3);
check('no events at all returns nothing', Object.keys(forwardOutcome(rising, idxOf, [], 20)).length === 0);
check('a series shorter than the horizon returns nothing',
  Object.keys(forwardOutcome(rising.slice(0,20), idxOf, [ev(5,'up')], 20)).length === 0);

// ── ATR normalisation ─────────────────────────────────────────────────────
// The same shape at ten times the price must give the same ATR-normalised
// answer, or gold and natural gas cannot be compared.
const scaled = rising.map(c => ({ ...c, o:c.o*10, h:c.h*10, l:c.l*10, c:c.c*10 }));
const sIdx = new Map(scaled.map((c,i) => [c.t, i]));
const a = forwardOutcome(rising, idxOf, [30,40,50,60,70,80].map(i => ev(i,'up')), 20);
const b = forwardOutcome(scaled, sIdx, [30,40,50,60,70,80].map(i => ({ at: scaled[i].t, dir:'up', type:'sweep' })), 20);
check('the figure is scale-free', Math.abs(a.fwdMedAtr - b.fwdMedAtr) < 0.01,
  `${a.fwdMedAtr} vs ${b.fwdMedAtr} at 10x the price`);

// ── A coin-flip series must not produce a confident number ────────────────
let seed = 7;
const rnd = () => (seed = (seed*1103515245+12345) % 2147483648) / 2147483648;
let px = 100;
const noise = Array.from({length: 400}, (_, i) => {
  const o = px, c = o + (rnd()-0.5)*2;
  px = c; return { t: 1700000000000+i*DAY, o, h: Math.max(o,c)+0.3, l: Math.min(o,c)-0.3, c, v:1 };
});
const nIdx = new Map(noise.map((c,i) => [c.t, i]));
const noiseEv = Array.from({length: 40}, (_, k) => ({ at: noise[20+k*8].t, dir: k%2 ? 'up':'down', type:'sweep' }));
const nOut = forwardOutcome(noise, nIdx, noiseEv, 20);
check('a random series lands near a coin flip',
  nOut.fwdWin > 25 && nOut.fwdWin < 75, `${nOut.fwdWin}% over ${nOut.fwdN} samples`);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

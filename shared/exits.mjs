// shared/exits.mjs
// How a trade ends — the half of a strategy nobody measures.
//
// Every rule this project has tested was scored with ONE exit: a stop one ATR
// away, a target at twice that, out at the horizon. 232 combinations, 12
// carried, none survived. That is a result about the pair (entry, exit), and it
// has been reported as though it were a result about entries.
//
// One ATR on hourly gold is about twenty-five dollars. Ordinary noise takes
// that out. So a condition could predict direction perfectly well and still
// fail every test run here, and there would be no way to tell that apart from
// the condition being worthless. Those are different findings and they have
// different fixes.
//
// ── The grid, and why it is five and not fifty ──────────────────────────────
//
// Each entry here changes ONE thing about the mechanism, so a result points at
// a cause rather than at a number. A finer grid would find a better-looking
// combination on the discovery half every single time and mean nothing.
//
// TIME-ONLY is the important one and it is why this file exists. It has no stop
// at all: hold for the horizon and take whatever the move gave. If a condition
// pays with no stop and loses with a one-ATR stop, the entry is fine and the
// stop is what is killing it. That is a diagnosis, and nothing here could
// produce it before.
//
// ── Why R is still the unit, even with different stop widths ────────────────
//
// R means "per unit of risk", not "per ATR". A two-ATR stop means half the
// position for the same money at risk, so 0.2R on a wide stop and 0.2R on a
// tight one cost the same to be wrong about and are directly comparable. That
// is only true because the app now sizes from the stop distance rather than
// from a lot table; before that fix this comparison would have been nonsense.
//
// Time-only has no stop and therefore no natural R, so it is measured against
// one ATR as a reference risk. Stated here rather than buried, because it is
// the one number in this file that is a convention rather than a measurement.

/**
 * @typedef {{ t:number, o:number, h:number, l:number, c:number, v?:number }} Candle
 * @typedef {{ id:string, label:string, stopAtr:number|null, rr:number|null }} Exit
 */

/** @type {Exit[]} */
export const EXITS = [
  { id: 's1r2',   stopAtr: 1.0,  rr: 2,    label: '1 ATR stop, target at 2R' },
  { id: 's2r2',   stopAtr: 2.0,  rr: 2,    label: '2 ATR stop, target at 2R' },
  { id: 's1r1',   stopAtr: 1.0,  rr: 1,    label: '1 ATR stop, target at 1R' },
  { id: 's15r3',  stopAtr: 1.5,  rr: 3,    label: '1.5 ATR stop, target at 3R' },
  { id: 'time',   stopAtr: null, rr: null, label: 'no stop, out at the horizon' },
];

export const DEFAULT_EXIT = EXITS[0];
export const TIME_ONLY = EXITS[EXITS.length - 1];

/** The reference risk for an exit with no stop, in ATR. A convention, not a measurement. */
export const TIME_ONLY_RISK_ATR = 1;

export function exitById(id) {
  return EXITS.find(e => e.id === id) || null;
}

/**
 * Run one trade to its end and report the result in R.
 *
 * In at the close of bar `i`. Out at the stop, at the target, or at the horizon,
 * whichever comes first.
 *
 * @param {Candle[]} cs
 * @param {number} i      index of the entry bar
 * @param {number} bars   maximum bars to hold
 * @param {number} atr    ATR at the entry bar
 * @param {'up'|'down'} dir
 * @param {Exit} exit
 * @returns {{ r:number, n:number, open?:boolean, how:'stop'|'target'|'horizon' }}
 */
export function runTrade(cs, i, bars, atr, dir, exit = DEFAULT_EXIT) {
  const entry = cs[i].c;
  const up = dir === 'up';
  const last = Math.min(i + bars, cs.length - 1);

  // No stop: hold to the horizon and measure the move against a reference risk.
  if (exit.stopAtr == null) {
    const risk = TIME_ONLY_RISK_ATR * atr;
    const raw = cs[last].c - entry;
    return { r: (up ? raw : -raw) / risk, n: last - i, open: true, how: 'horizon' };
  }

  const risk = exit.stopAtr * atr;
  const rr = exit.rr ?? 2;
  const stop = up ? entry - risk : entry + risk;
  const tgt = up ? entry + rr * risk : entry - rr * risk;

  for (let j = i + 1; j <= last; j++) {
    const hitStop = up ? cs[j].l <= stop : cs[j].h >= stop;
    const hitTgt = up ? cs[j].h >= tgt : cs[j].l <= tgt;
    // Both inside one bar. The OHLC does not say which came first, and assuming
    // the target is exactly how a backtest manufactures an edge that does not
    // survive contact. The loss is taken.
    if (hitStop) return { r: -1, n: j - i, how: 'stop' };
    if (hitTgt) return { r: rr, n: j - i, how: 'target' };
  }
  const raw = cs[last].c - entry;
  return { r: (up ? raw : -raw) / risk, n: last - i, open: true, how: 'horizon' };
}

/**
 * What a set of exit results says, in the one sentence that matters.
 *
 * The comparison this file was built for: a condition that pays with no stop
 * and loses with one is an entry that works and an exit that does not. Naming
 * that is the whole point — a bare "it failed" hides which half was wrong.
 *
 * @param {Record<string, {edgeR:number|null}|null>} byExit  edge per exit id
 */
export function exitDiagnosis(byExit) {
  const timed = byExit?.[TIME_ONLY.id];
  // Narrowed into plain numbers here rather than carried as maybe-null through
  // four comparisons below. The checker could not follow the guard across them,
  // and neither could a reader.
  const stopped = [];
  for (const e of EXITS) {
    if (e.stopAtr == null) continue;
    const edge = byExit?.[e.id]?.edgeR;
    if (edge == null) continue;
    stopped.push({ e, edgeR: edge });
  }
  if (!timed || timed.edgeR == null || !stopped.length) return null;
  const t = timed.edgeR;

  const best = stopped.reduce((a, b) => (b.edgeR > a.edgeR ? b : a));
  if (t > 0 && best.edgeR <= 0) {
    return {
      kind: 'stop-is-the-problem',
      text: `the entry pays with no stop (+${t}R) and loses with every stop tested — the best `
        + `of them, ${best.e.label}, gives ${best.edgeR}R. The direction is right and the stop `
        + 'is being taken out before it arrives.',
    };
  }
  if (t <= 0 && best.edgeR > 0) {
    return {
      kind: 'exit-is-doing-the-work',
      text: `the entry pays nothing held to the horizon (${t}R) but ${best.e.label} gives `
        + `+${best.edgeR}R. The edge is in the exit rather than in the condition, which is worth `
        + 'knowing before treating the condition as a signal.',
    };
  }
  if (t > 0 && best.edgeR > 0) {
    return {
      kind: 'both',
      text: `the entry pays held to the horizon (+${t}R) and best with ${best.e.label} `
        + `(+${best.edgeR}R).`,
    };
  }
  return {
    kind: 'nothing-there',
    text: `nothing pays: ${t}R held to the horizon, and the best stop tested gives `
      + `${best.edgeR}R. The condition is the problem, not the exit.`,
  };
}

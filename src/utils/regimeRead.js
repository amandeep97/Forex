// src/utils/regimeRead.js
//
// Reads bot/regime-study.json and answers the only question that matters on a
// screen: is any of it true right now.
//
// The COT study, the hour profile and the gold-silver study are all published
// and none of them is shown anywhere. That is most of why they have not helped
// — an answer nobody sees is the same as no answer. This one is read against
// live bars in the browser, using the same condition definitions the study was
// built from, so "volatility is hot" means on the phone exactly what it meant
// in the search.

import { featureSeries, keysOf, PHRASE, labelOf } from '../../shared/moveFeatures.mjs';
import { macroSeries, describe as describeMacro } from '../../shared/macroFit.mjs';

// EUR/USD inverted so the series rises when the DOLLAR strengthens. The sign
// convention is written once, here and in the study, and nowhere else.
export const DOLLAR_INSTRUMENT = 'EUR_USD';
export const RATE_INSTRUMENT = 'USB10Y_USD';
export const invertDollar = cs => (cs || []).map(c => ({ t: c.t, c: 1 / c.c }));

export const REGIME_URL =
  'https://raw.githubusercontent.com/amandeep97/Forex/main/bot/regime-study.json';

// The verdicts that are allowed to say anything on screen. `fades` and `fails`
// are published so the list is honest about what was tried, but a rule that did
// not survive the holdout is not a rule and must never be shown as one.
export const LIVE_VERDICTS = ['confirmed', 'holds'];

export async function fetchRegimeStudy(signal = null) {
  const res = await fetch(`${REGIME_URL}?t=${Math.floor(Date.now() / 3e5)}`, { signal });
  if (!res.ok) throw new Error(`regime study ${res.status}`);
  return res.json();
}

// The state of one instrument at its most recent complete bar.
//
// The whole series is passed, not the last bar: ATR, the previous day's levels
// and the volatility baseline are all built from history, and a "current state"
// computed from a handful of recent candles would silently differ from the one
// the study measured.
export function stateNow(cs, { sym, partner = null, dollarUp = null, rate = null } = {}) {
  if (!cs || cs.length < 500) return null;
  // The decomposition is rebuilt here rather than read from the published file
  // because the published file is up to a week old, and "what is driving gold"
  // is a question about this hour. Same module the study used, so the answer
  // cannot mean something different on the phone than it did in the search.
  const macro = dollarUp?.length && rate?.length
    ? macroSeries(cs, { dollarUp, rate })
    : null;
  const f = featureSeries(cs, { sym, partner, macro });
  for (let i = f.length - 1; i >= 0; i--) {
    if (f[i]) {
      const keys = keysOf(f[i]);
      return {
        at: f[i].t, close: f[i].close, atr: f[i].atr,
        keys, plain: keys.map(k => PHRASE[k] || k), row: f[i],
        driver: macro ? describeMacro(macro, i) : null,
      };
    }
  }
  return null;
}

// Which surviving rules are true on this bar. A rule is an AND of conditions,
// so this is a subset test and nothing more — no scoring happens here, because
// the score was settled on data this session has never seen and re-deriving it
// from a few hundred live bars would only be a worse version of it.
export function firing(study, keys) {
  if (!study?.rules || !keys) return [];
  const have = new Set(keys);
  return study.rules
    .filter(r => LIVE_VERDICTS.includes(r.verdict))
    .filter(r => r.all.every(k => have.has(k)))
    .map(r => ({ ...r, text: r.label || labelOf({ all: r.all }) }));
}

// How close the board is to a rule that is not currently true. One condition
// short of a surviving setup is worth knowing about — it is the difference
// between "nothing today" and "watch the London open".
export function nearMisses(study, keys, within = 1) {
  if (!study?.rules || !keys) return [];
  const have = new Set(keys);
  return study.rules
    .filter(r => LIVE_VERDICTS.includes(r.verdict))
    .map(r => ({ rule: r, missing: r.all.filter(k => !have.has(k)) }))
    .filter(x => x.missing.length > 0 && x.missing.length <= within)
    .map(x => ({
      ...x.rule,
      text: x.rule.label || labelOf({ all: x.rule.all }),
      missing: x.missing.map(k => PHRASE[k] || k),
    }));
}

// The verdicts, in plain words, because "fades" on its own is not English.
export const VERDICT_TEXT = {
  confirmed: 'held up on the half of recent history the search never saw, at the strict threshold',
  holds: 'held up on the unseen half, at the ordinary threshold',
  fades: 'looked good where it was found and shrank to nothing on the unseen half',
  fails: 'reversed sign on the unseen half — it was noise',
  thin: 'too few trades on the unseen half to say anything',
};

export const NOVELTY_TEXT = {
  new: 'new — it did not work in the three years before',
  'stronger-now': 'stronger now than it was in the three years before',
  longstanding: 'has worked for years, not a recent development',
  faded: 'used to work and does not any more',
  marginal: 'about the same as before, and neither is much',
  'no-history': 'no comparable sample in the earlier years',
};

// A one-line summary of the whole file for a header. Says nothing survived when
// nothing survived, which is the case this has to handle well.
export function headline(study) {
  if (!study) return null;
  const t = study.tally || {};
  const live = (t.confirmed || 0) + (t.holds || 0);
  if (!live) {
    return `${study.method?.searched ?? 0} combinations searched, `
      + `${study.method?.carried ?? 0} taken to the holdout, none survived it`;
  }
  return `${live} of ${study.method?.carried ?? 0} survived the holdout`
    + `${t.confirmed ? ` (${t.confirmed} at the strict threshold)` : ''}`;
}

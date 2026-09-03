// src/utils/candlePatterns.js
//
// The detection itself moved to shared/candlePatterns.mjs, because four things
// read it now — the Screener, the alerts engine, the live bot, and the regime
// study — and two copies of a pattern definition is two definitions.
//
// What stays here is the part that cannot move: the range length N is a user
// setting held in localStorage, which the bot does not have.

export * from '../../shared/candlePatterns.mjs'
import { DEFAULT_PATTERN_N } from '../../shared/candlePatterns.mjs'

export const PATTERN_N_KEY = 'pattern_range_n'

export function getPatternN() {
  const v = parseInt(localStorage.getItem(PATTERN_N_KEY) || String(DEFAULT_PATTERN_N), 10)
  return v >= 2 && v <= 30 ? v : DEFAULT_PATTERN_N
}

export function setPatternN(n) {
  const v = Math.max(2, Math.min(30, parseInt(n, 10) || DEFAULT_PATTERN_N))
  localStorage.setItem(PATTERN_N_KEY, String(v))
  return v
}

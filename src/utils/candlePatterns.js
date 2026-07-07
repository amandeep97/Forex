// src/utils/candlePatterns.js
// Candlestick pattern detection for OHLC candle arrays.
// Each candle must have { o, h, l, c } fields.

// ── pattern registry ──────────────────────────────────────────────────────────
export const CANDLE_PATTERNS = [
  // ── Single candle ─────────────────────────────────────────────────────────
  { id: 'doji',             name: 'Doji',                  type: 'neutral', signal: 'indecision',    strength: 'weak',   candles: 1 },
  { id: 'dragonfly_doji',   name: 'Dragonfly Doji',        type: 'bullish', signal: 'reversal',      strength: 'medium', candles: 1 },
  { id: 'gravestone_doji',  name: 'Gravestone Doji',       type: 'bearish', signal: 'reversal',      strength: 'medium', candles: 1 },
  { id: 'long_legged_doji', name: 'Long-Legged Doji',      type: 'neutral', signal: 'indecision',    strength: 'weak',   candles: 1 },
  { id: 'hammer',           name: 'Hammer',                type: 'bullish', signal: 'reversal',      strength: 'medium', candles: 1 },
  { id: 'hanging_man',      name: 'Hanging Man',           type: 'bearish', signal: 'reversal',      strength: 'medium', candles: 1 },
  { id: 'shooting_star',    name: 'Shooting Star',         type: 'bearish', signal: 'reversal',      strength: 'medium', candles: 1 },
  { id: 'inv_hammer',       name: 'Inverted Hammer',       type: 'bullish', signal: 'reversal',      strength: 'weak',   candles: 1 },
  { id: 'spinning_top',     name: 'Spinning Top',          type: 'neutral', signal: 'indecision',    strength: 'weak',   candles: 1 },
  { id: 'marubozu_bull',    name: 'Bullish Marubozu',      type: 'bullish', signal: 'continuation',  strength: 'strong', candles: 1 },
  { id: 'marubozu_bear',    name: 'Bearish Marubozu',      type: 'bearish', signal: 'continuation',  strength: 'strong', candles: 1 },
  // ── Double candle ─────────────────────────────────────────────────────────
  { id: 'bull_engulf',      name: 'Bullish Engulfing',     type: 'bullish', signal: 'reversal',      strength: 'strong', candles: 2 },
  { id: 'bear_engulf',      name: 'Bearish Engulfing',     type: 'bearish', signal: 'reversal',      strength: 'strong', candles: 2 },
  { id: 'piercing_line',    name: 'Piercing Line',         type: 'bullish', signal: 'reversal',      strength: 'medium', candles: 2 },
  { id: 'dark_cloud',       name: 'Dark Cloud Cover',      type: 'bearish', signal: 'reversal',      strength: 'medium', candles: 2 },
  { id: 'bull_harami',      name: 'Bullish Harami',        type: 'bullish', signal: 'reversal',      strength: 'weak',   candles: 2 },
  { id: 'bear_harami',      name: 'Bearish Harami',        type: 'bearish', signal: 'reversal',      strength: 'weak',   candles: 2 },
  { id: 'harami_cross',     name: 'Harami Cross',          type: 'neutral', signal: 'indecision',    strength: 'medium', candles: 2 },
  { id: 'tweezer_top',      name: 'Tweezer Top',           type: 'bearish', signal: 'reversal',      strength: 'medium', candles: 2 },
  { id: 'tweezer_bottom',   name: 'Tweezer Bottom',        type: 'bullish', signal: 'reversal',      strength: 'medium', candles: 2 },
  { id: 'inside_bar',       name: 'Inside Bar',            type: 'neutral', signal: 'continuation',  strength: 'medium', candles: 2 },
  { id: 'outside_bar',      name: 'Outside Bar',           type: 'neutral', signal: 'volatility',    strength: 'medium', candles: 2 },
  { id: 'kicker_bull',      name: 'Bullish Kicker',        type: 'bullish', signal: 'reversal',      strength: 'strong', candles: 2 },
  { id: 'kicker_bear',      name: 'Bearish Kicker',        type: 'bearish', signal: 'reversal',      strength: 'strong', candles: 2 },
  // ── Triple candle ─────────────────────────────────────────────────────────
  { id: 'morning_star',     name: 'Morning Star',          type: 'bullish', signal: 'reversal',      strength: 'strong', candles: 3 },
  { id: 'evening_star',     name: 'Evening Star',          type: 'bearish', signal: 'reversal',      strength: 'strong', candles: 3 },
  { id: 'three_soldiers',   name: 'Three White Soldiers',  type: 'bullish', signal: 'continuation',  strength: 'strong', candles: 3 },
  { id: 'three_crows',      name: 'Three Black Crows',     type: 'bearish', signal: 'continuation',  strength: 'strong', candles: 3 },
  { id: 'three_inside_up',  name: 'Three Inside Up',       type: 'bullish', signal: 'reversal',      strength: 'medium', candles: 3 },
  { id: 'three_inside_dn',  name: 'Three Inside Down',     type: 'bearish', signal: 'reversal',      strength: 'medium', candles: 3 },
  { id: 'abandoned_bull',   name: 'Abandoned Baby Bull',   type: 'bullish', signal: 'reversal',      strength: 'strong', candles: 3 },
  { id: 'abandoned_bear',   name: 'Abandoned Baby Bear',   type: 'bearish', signal: 'reversal',      strength: 'strong', candles: 3 },
  // ── Five candle ──────────────────────────────────────────────────────────
  { id: 'rising_three',     name: 'Rising Three Methods',  type: 'bullish', signal: 'continuation',  strength: 'strong', candles: 5 },
  { id: 'falling_three',    name: 'Falling Three Methods', type: 'bearish', signal: 'continuation',  strength: 'strong', candles: 5 },
]

export const PATTERN_MAP = Object.fromEntries(CANDLE_PATTERNS.map(p => [p.id, p]))

// ── helpers ───────────────────────────────────────────────────────────────────
const body  = c => Math.abs(c.c - c.o)
const rng   = c => c.h - c.l
const upper = c => c.h - Math.max(c.o, c.c)
const lower = c => Math.min(c.o, c.c) - c.l
const mid   = c => (c.o + c.c) / 2
const isGreen = c => c.c >= c.o
const isRed   = c => c.c <  c.o

function isDoji(c) {
  const r = rng(c)
  return r > 0 && body(c) / r < 0.05
}
function isSmallBody(c) {
  const r = rng(c)
  return r > 0 && body(c) / r < 0.30
}
function avgBody(arr) {
  return arr.reduce((s, c) => s + body(c), 0) / (arr.length || 1) || 1
}
function isUptrend(candles) {
  const sl = candles.slice(-11, -1)
  return sl.length >= 5 && sl[sl.length - 1].c > sl[0].c
}
function isDowntrend(candles) {
  const sl = candles.slice(-11, -1)
  return sl.length >= 5 && sl[sl.length - 1].c < sl[0].c
}

function _detectOnWindow(window) {
  const n  = window.length
  if (n < 5) return []
  const c1 = window[n - 1]
  const c2 = window[n - 2]
  const c3 = window[n - 3]
  const c4 = window[n - 4]
  const c5 = window[n - 5]
  const avg = avgBody(window.slice(-20))
  const hit = []

  const r1 = rng(c1), b1 = body(c1), u1 = upper(c1), l1 = lower(c1)
  if (r1 > 0) {
    const bodyPct = b1 / r1
    if (bodyPct > 0.90) {
      if (isGreen(c1)) hit.push('marubozu_bull')
      else             hit.push('marubozu_bear')
    }
    if (bodyPct < 0.05) {
      const hasLong  = l1 >= r1 * 0.3 && u1 >= r1 * 0.3
      const isDragon = l1 >= r1 * 0.6 && u1 <= r1 * 0.08
      const isGrave  = u1 >= r1 * 0.6 && l1 <= r1 * 0.08
      if      (isDragon) hit.push('dragonfly_doji')
      else if (isGrave)  hit.push('gravestone_doji')
      else if (hasLong)  hit.push('long_legged_doji')
      else               hit.push('doji')
    }
    if (bodyPct >= 0.05 && bodyPct < 0.30 && u1 >= b1 * 0.7 && l1 >= b1 * 0.7)
      hit.push('spinning_top')
    if (isSmallBody(c1) && l1 >= b1 * 2 && u1 <= r1 * 0.10) {
      if (isDowntrend(window)) hit.push('hammer')
      else                     hit.push('hanging_man')
    }
    if (isSmallBody(c1) && u1 >= b1 * 2 && l1 <= r1 * 0.10) {
      if (isUptrend(window)) hit.push('shooting_star')
      else                   hit.push('inv_hammer')
    }
  }

  const b2 = body(c2)
  if (isRed(c2) && isGreen(c1) && c1.c > c2.o && c1.o < c2.c && b1 > b2 * 0.8)
    hit.push('bull_engulf')
  if (isGreen(c2) && isRed(c1) && c1.c < c2.o && c1.o > c2.c && b1 > b2 * 0.8)
    hit.push('bear_engulf')
  if (isRed(c2) && isGreen(c1) && c1.o < c2.l && c1.c > mid(c2) && c1.c < c2.o)
    hit.push('piercing_line')
  if (isGreen(c2) && isRed(c1) && c1.o > c2.h && c1.c < mid(c2) && c1.c > c2.o)
    hit.push('dark_cloud')
  const c1InC2body = Math.max(c1.o, c1.c) < Math.max(c2.o, c2.c) &&
                     Math.min(c1.o, c1.c) > Math.min(c2.o, c2.c)
  if (c1InC2body) {
    if (isDoji(c1))                      hit.push('harami_cross')
    else if (isGreen(c2) && isRed(c1))   hit.push('bear_harami')
    else if (isRed(c2)   && isGreen(c1)) hit.push('bull_harami')
  }
  if (isGreen(c2) && isRed(c1) && Math.abs(c1.h - c2.h) / (c2.h || 1) < 0.0025)
    hit.push('tweezer_top')
  if (isRed(c2) && isGreen(c1) && Math.abs(c1.l - c2.l) / (c2.l || 1) < 0.0025)
    hit.push('tweezer_bottom')
  if (c1.h < c2.h && c1.l > c2.l) hit.push('inside_bar')
  if (c1.h > c2.h && c1.l < c2.l) hit.push('outside_bar')
  if (isRed(c2) && isGreen(c1) && c1.o > c2.o && b1 > avg * 0.8 && b2 > avg * 0.8)
    hit.push('kicker_bull')
  if (isGreen(c2) && isRed(c1) && c1.o < c2.o && b1 > avg * 0.8 && b2 > avg * 0.8)
    hit.push('kicker_bear')

  const b3 = body(c3)
  if (isRed(c3) && b3 > avg * 0.7 && isSmallBody(c2) && isGreen(c1) && b1 > avg * 0.7 && c1.c > mid(c3))
    hit.push('morning_star')
  if (isGreen(c3) && b3 > avg * 0.7 && isSmallBody(c2) && isRed(c1) && b1 > avg * 0.7 && c1.c < mid(c3))
    hit.push('evening_star')
  if (isGreen(c3) && isGreen(c2) && isGreen(c1) &&
      c2.o > c3.o && c2.o < c3.c && c1.o > c2.o && c1.o < c2.c &&
      c1.c > c2.c && c2.c > c3.c && b1 > avg * 0.5 && b2 > avg * 0.5 && b3 > avg * 0.5)
    hit.push('three_soldiers')
  if (isRed(c3) && isRed(c2) && isRed(c1) &&
      c2.o < c3.o && c2.o > c3.c && c1.o < c2.o && c1.o > c2.c &&
      c1.c < c2.c && c2.c < c3.c && b1 > avg * 0.5 && b2 > avg * 0.5 && b3 > avg * 0.5)
    hit.push('three_crows')
  if (isRed(c3) && b3 > avg * 0.7 &&
      isGreen(c2) && Math.max(c2.o,c2.c) < c3.o && Math.min(c2.o,c2.c) > c3.c &&
      isGreen(c1) && c1.c > c3.o)
    hit.push('three_inside_up')
  if (isGreen(c3) && b3 > avg * 0.7 &&
      isRed(c2) && Math.min(c2.o,c2.c) > c3.o && Math.max(c2.o,c2.c) < c3.c &&
      isRed(c1) && c1.c < c3.o)
    hit.push('three_inside_dn')
  if (isRed(c3) && isDoji(c2) && c2.h < c3.l && isGreen(c1) && c1.l > c2.h)
    hit.push('abandoned_bull')
  if (isGreen(c3) && isDoji(c2) && c2.l > c3.h && isRed(c1) && c1.h < c2.l)
    hit.push('abandoned_bear')

  const b5 = body(c5)
  const mid3 = [c4, c3, c2]
  if (isGreen(c5) && b5 > avg * 0.8 &&
      mid3.every(c => isRed(c) && c.h < c5.h && c.l > c5.l) &&
      isGreen(c1) && c1.c > c5.c)
    hit.push('rising_three')
  if (isRed(c5) && b5 > avg * 0.8 &&
      mid3.every(c => isGreen(c) && c.h < c5.o && c.l > c5.c) &&
      isRed(c1) && c1.c < c5.c)
    hit.push('falling_three')

  return hit
}

export function detectCandlePatterns(candles, lookback = 10) {
  if (!candles || candles.length < 6) return []
  const closed = candles.slice(0, -1)
  const found = []
  const seen  = new Set()

  for (let offset = 0; offset < lookback && offset <= closed.length - 5; offset++) {
    const win = offset === 0 ? closed : closed.slice(0, closed.length - offset)
    const ids = _detectOnWindow(win)
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id)
        const meta = PATTERN_MAP[id]
        if (meta) found.push({ ...meta, candlesAgo: offset + 1 })
      }
    }
  }
  return found
}

// ── Strong reversal candles (full-range liquidity sweep) ─────────────────────
// A single candle whose wick clears the ENTIRE prior N-candle range, then closes
// back inside it — stops grabbed on the whole range, then reversed. Higher quality
// than a lone hammer/star because it must sweep the full range, not just poke a low.
export const PATTERN_N_KEY = 'pattern_range_n'
export function getPatternN() {
  const v = parseInt(localStorage.getItem(PATTERN_N_KEY) || '5', 10)
  return v >= 2 && v <= 30 ? v : 5
}
export function setPatternN(n) {
  const v = Math.max(2, Math.min(30, parseInt(n, 10) || 5))
  localStorage.setItem(PATTERN_N_KEY, String(v))
  return v
}

// Strong Hammer at index i: range = candles[i-N .. i-1]
export function isStrongHammer(candles, i, N = 5) {
  if (i < N || i >= candles.length) return false
  const c = candles[i]
  const prior = candles.slice(i - N, i)
  const rangeLow = Math.min(...prior.map(x => x.l))
  const b = body(c), u = upper(c), l = lower(c), r = rng(c)
  if (r <= 0) return false
  return (
    c.l < rangeLow &&                     // wick clears the entire range low
    c.c > rangeLow &&                      // closes back inside (reclaim)
    c.c > c.o &&                           // closes green
    l >= 2 * b &&                          // hammer shape
    l > u &&                               // lower wick dominant
    Math.min(c.o, c.c) >= c.l + r * 0.5    // body in upper half
  )
}

// Strong Shooting Star — exact mirror
export function isStrongStar(candles, i, N = 5) {
  if (i < N || i >= candles.length) return false
  const c = candles[i]
  const prior = candles.slice(i - N, i)
  const rangeHigh = Math.max(...prior.map(x => x.h))
  const b = body(c), u = upper(c), l = lower(c), r = rng(c)
  if (r <= 0) return false
  return (
    c.h > rangeHigh &&                     // wick clears the entire range high
    c.c < rangeHigh &&                      // closes back inside
    c.c < c.o &&                           // closes red
    u >= 2 * b &&                          // shooting star shape
    u > l &&                               // upper wick dominant
    Math.max(c.o, c.c) <= c.l + r * 0.5    // body in lower half
  )
}

// 'hammer' | 'star' | null for candle at index i
export function detectStrongReversal(candles, i, N = 5) {
  if (isStrongHammer(candles, i, N)) return 'hammer'
  if (isStrongStar(candles, i, N)) return 'star'
  return null
}

// Pattern on the most recent CLOSED candle (pass an array of complete bars)
export function lastStrongReversal(candles, N = 5) {
  if (!candles || candles.length < N + 1) return null
  return detectStrongReversal(candles, candles.length - 1, N)
}

// Every index in the series that matches (for chart marking)
export function findStrongReversals(candles, N = 5) {
  const out = []
  for (let i = N; i < candles.length; i++) {
    const t = detectStrongReversal(candles, i, N)
    if (t) out.push({ i, type: t })
  }
  return out
}

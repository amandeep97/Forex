// src/utils/contextSeries.js
// Series from OTHER instruments, aligned to the one being tested.
//
// Everything the backtester could condition on lived inside a single candle
// array: RSI, moving averages, order blocks, the shape of the last bar. Those
// are the conditions every retail backtester has, which is a good reason to
// expect them to be arbitraged flat — a million people have tested "RSI under
// 30 on gold" and whatever was there is gone.
//
// What this app has and a chart package does not is the rest of the board:
// what silver was doing while gold did this, whether the S&P was falling at
// the time, where the gold/silver ratio sat against its own year. Those are
// cheap to compute and almost nobody tests them, which is the entire argument
// for looking there.
//
// The alignment rule is the only subtle part. Peer values are taken as the
// last peer close at or BEFORE each base bar's timestamp. Never after, never
// interpolated. Instruments keep different hours — the S&P is shut when Tokyo
// trades — and a peer value sampled from the future is an edge that cannot be
// traded and will look wonderful.

// Percentile of the final value within a trailing window, 0..100.
function rollingPercentile(arr, window) {
  const out = new Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    const from = Math.max(0, i - window + 1);
    let below = 0, total = 0;
    for (let j = from; j <= i; j++) {
      if (arr[j] == null) continue;
      total++;
      if (arr[j] <= arr[i]) below++;
    }
    if (total >= Math.min(30, window / 4)) out[i] = (below / total) * 100;
  }
  return out;
}

function pctChangeSeries(values, n) {
  const out = new Array(values.length).fill(null);
  for (let i = n; i < values.length; i++) {
    const a = values[i - n], b = values[i];
    if (a == null || b == null || a === 0) continue;
    out[i] = ((b - a) / Math.abs(a)) * 100;
  }
  return out;
}

// Last peer close at or before each base timestamp. A two-pointer walk, so it
// stays linear even when the peer series is much denser than the base.
export function alignCloses(baseCandles, peerCandles) {
  const out = new Array(baseCandles.length).fill(null);
  if (!peerCandles?.length) return out;
  let j = 0, last = null;
  for (let i = 0; i < baseCandles.length; i++) {
    const t = baseCandles[i].t;
    while (j < peerCandles.length && peerCandles[j].t <= t) { last = peerCandles[j].c; j++; }
    out[i] = last;
  }
  return out;
}

export const CHG_BARS = [1, 3, 5, 10, 20];
const RATIO_WINDOW = 250;

export const key = {
  peerPx:  p => `px:${p}`,
  peerChg: (p, n) => `chg:${p}:${n}`,
  selfChg: n => `chg:self:${n}`,
  ratioPct: p => `rpct:${p}`,
};

// Build every context array once for a base/peer set. Returned as a plain
// object of index-aligned arrays, which is exactly the shape the engine's
// indicator snapshot already understands — no new plumbing inside the loop.
export function buildContext(baseCandles, peers) {
  const ctx = {};
  const baseCloses = baseCandles.map(c => c.c);
  for (const n of CHG_BARS) ctx[key.selfChg(n)] = pctChangeSeries(baseCloses, n);

  for (const [sym, candles] of Object.entries(peers || {})) {
    if (!candles?.length) continue;
    const px = alignCloses(baseCandles, candles);
    ctx[key.peerPx(sym)] = px;
    for (const n of CHG_BARS) ctx[key.peerChg(sym, n)] = pctChangeSeries(px, n);

    // Where this instrument stands against the peer, relative to its own
    // history. The gold/silver ratio at a one-year extreme is the classic
    // case, and it is not something a single-instrument backtest can see.
    const ratio = baseCloses.map((v, i) => (px[i] ? v / px[i] : null));
    ctx[key.ratioPct(sym)] = rollingPercentile(ratio, RATIO_WINDOW);
  }
  return ctx;
}

// How much of the context is actually usable. A peer whose history does not
// overlap the base — a crypto pair against ten years of gold, say — produces
// all-null arrays, and a condition on it can never fire. Better to know that
// than to watch the search quietly ignore a third of its vocabulary.
export function contextCoverage(ctx) {
  const out = {};
  for (const [k, arr] of Object.entries(ctx)) {
    const filled = arr.reduce((s, v) => s + (v == null ? 0 : 1), 0);
    out[k] = arr.length ? filled / arr.length : 0;
  }
  return out;
}

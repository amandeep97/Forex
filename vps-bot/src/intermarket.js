'use strict';

const IM_KEYS = [
  { key: 'dxy',   oanda: 'EUR_USD',    invert: true  },
  { key: 'gold',  oanda: 'XAU_USD',    invert: false },
  { key: 'oil',   oanda: 'BCO_USD',    invert: false },
  { key: 'bonds', oanda: 'USB10Y_USD', invert: false },
];

// Pearson correlation coefficient between two equal-length close arrays
function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const ax = a.slice(-n), bx = b.slice(-n);
  const mA = ax.reduce((s, v) => s + v, 0) / n;
  const mB = bx.reduce((s, v) => s + v, 0) / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const x = ax[i] - mA, y = bx[i] - mB;
    num += x * y; dA += x * x; dB += y * y;
  }
  const denom = Math.sqrt(dA * dB);
  return denom === 0 ? null : +(num / denom).toFixed(2);
}

async function checkIMFilter(oandaClient, filter, log) {
  if (!filter?.enabled) return true;

  const tf          = filter.tf || 'H1';
  const sigLookback = 5;
  const corrLookback = 50;
  const fetchCount  = corrLookback + sigLookback + 5;

  // Fetch pair candles for dynamic correlation (pair = passed via filter.pairOanda)
  const pairOanda   = filter.pairOanda || null;
  let pairCloses = null;
  if (pairOanda) {
    try {
      const pc = await oandaClient.getCandles(pairOanda, tf, fetchCount);
      pairCloses = pc.map(c => c.c);
    } catch {}
  }

  for (const def of IM_KEYS) {
    const required = filter[def.key];
    if (!required || required === 'any') continue;

    try {
      const candles = await oandaClient.getCandles(def.oanda, tf, fetchCount);
      if (candles.length < sigLookback + 1) continue;

      const n = candles.length;
      const rawRising  = candles[n - 1].c > candles[n - 1 - sigLookback].c;
      const direction  = def.invert ? (rawRising ? 'falling' : 'rising') : (rawRising ? 'rising' : 'falling');

      // Dynamic correlation check — skip filter if correlation is too weak (< 0.3)
      if (pairCloses) {
        const mktCloses = candles.map(c => c.c);
        const rawCorr   = pearsonCorr(pairCloses, mktCloses);
        if (rawCorr !== null) {
          const liveCorr = def.invert ? -rawCorr : rawCorr;
          const strength = Math.abs(liveCorr);
          if (strength < 0.3) {
            if (log) log(`Intermarket: ${def.key} correlation too weak (r=${liveCorr.toFixed(2)}) — skipping filter`);
            continue; // correlation not strong enough — don't block the trade
          }
          if (log) log(`Intermarket: ${def.key} live r=${liveCorr.toFixed(2)}, direction=${direction}, required=${required}`);
        }
      }

      if (direction !== required) {
        if (log) log(`Intermarket: ${def.key} is ${direction}, required ${required} — BLOCKED`);
        return false;
      }
    } catch (e) {
      if (log) log(`Intermarket: ${def.key} fetch failed (${e.message}) — skipping`);
    }
  }
  return true;
}

module.exports = { checkIMFilter };

'use strict';

const IM_KEYS = [
  { key: 'dxy',   oanda: 'EUR_USD',    invert: true  },
  { key: 'gold',  oanda: 'XAU_USD',    invert: false },
  { key: 'oil',   oanda: 'BCO_USD',    invert: false },
  { key: 'bonds', oanda: 'USB10Y_USD', invert: false },
];

async function checkIMFilter(oandaClient, filter, log) {
  if (!filter?.enabled) return true;
  const tf       = filter.tf || 'H1';
  const lookback = 5;

  for (const def of IM_KEYS) {
    const required = filter[def.key];
    if (!required || required === 'any') continue;
    try {
      const candles = await oandaClient.getCandles(def.oanda, tf, lookback + 4);
      const n = candles.length;
      if (n < lookback + 1) continue;
      const rawRising = candles[n - 1].c > candles[n - 1 - lookback].c;
      const direction = def.invert ? (rawRising ? 'falling' : 'rising') : (rawRising ? 'rising' : 'falling');
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

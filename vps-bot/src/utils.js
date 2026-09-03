'use strict';

function getCurrentSession() {
  const h = new Date().getUTCHours();
  const sessions = [];
  if (h >= 7  && h < 16) sessions.push('london');
  if (h >= 12 && h < 21) sessions.push('newyork');
  if (h >= 12 && h < 16) sessions.push('overlap');
  return sessions;
}

function isWeekend() {
  const d = new Date().getUTCDay();
  return d === 0 || d === 6;
}

function getPipSize(pair) {
  if (pair.includes('JPY'))                return 0.01;
  if (pair.includes('XAU'))               return 0.10;
  if (pair.includes('XAG'))               return 0.001;
  if (pair.includes('BTC') || pair.includes('ETH')) return 1;
  return 0.0001;
}

function getPipValuePerUnit(pair, exchangeRate = 1) {
  const pip = getPipSize(pair);
  if (pair.startsWith('USD')) return pip / exchangeRate;
  return pip;
}

// Position sizing lives in shared/position.mjs now, and calcPosition is gone
// rather than deprecated.
//
// It converted the stop distance to "pips", assumed $10 per pip per lot and
// 100,000 units per lot, and clamped up to a 0.01 lot minimum. All three are
// properties of a major FX pair. On SPX500, where getPipSize fell through to
// 0.0001, a thirty-point stop measured 300,000 pips, the lot maths underflowed
// to the clamp, and 0.01 lots became 1,000 units — six million dollars of
// notional against a three-dollar risk budget.
//
// Leaving it here as a deprecated export would leave the trap in place for the
// next caller. The replacement sizes from the stop distance directly and
// refuses when the smallest tradeable position would exceed the budget.

function genTradeId() {
  return 'T' + Date.now().toString(36).toUpperCase();
}

function fmtPrice(price, pair) {
  if (pair.includes('JPY'))  return price.toFixed(3);
  if (pair.includes('XAU'))  return price.toFixed(2);
  if (pair.includes('XAG'))  return price.toFixed(4);
  return price.toFixed(5);
}

module.exports = { getCurrentSession, isWeekend, getPipSize, getPipValuePerUnit, genTradeId, fmtPrice };

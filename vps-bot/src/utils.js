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

function calcPosition({ balance, riskPercent, entryPrice, slPrice, pair }) {
  const riskUsd  = balance * (riskPercent / 100);
  const pip      = getPipSize(pair);
  const slPips   = Math.abs(entryPrice - slPrice) / pip;
  if (slPips < 0.1) return { lots: 0.01, units: 1000 };

  const pipValuePerLot = 10;
  let lots = riskUsd / (slPips * pipValuePerLot);
  lots = Math.max(0.01, Math.floor(lots * 100) / 100);

  const isMetals = pair.includes('XAU') || pair.includes('XAG');
  const units    = isMetals ? lots * 100 : lots * 100_000;

  return { lots, units: Math.round(units) };
}

function genTradeId() {
  return 'T' + Date.now().toString(36).toUpperCase();
}

function fmtPrice(price, pair) {
  if (pair.includes('JPY'))  return price.toFixed(3);
  if (pair.includes('XAU'))  return price.toFixed(2);
  if (pair.includes('XAG'))  return price.toFixed(4);
  return price.toFixed(5);
}

module.exports = { getCurrentSession, isWeekend, getPipSize, getPipValuePerUnit, calcPosition, genTradeId, fmtPrice };

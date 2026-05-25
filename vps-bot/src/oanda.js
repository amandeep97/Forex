'use strict';
const fetch = require('node-fetch');

class OandaClient {
  constructor({ apiKey, accountId, practice = true }) {
    this.apiKey    = apiKey;
    this.accountId = accountId;
    this.base      = practice
      ? 'https://api-fxpractice.oanda.com/v3'
      : 'https://api-fxtrade.oanda.com/v3';
  }

  async _req(path, opts = {}) {
    const url = `${this.base}${path}`;
    const res  = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OANDA ${res.status} ${path}: ${body}`);
    }
    return res.json();
  }

  // Returns candles as { t, o, h, l, c, v }
  async getCandles(instrument, granularity, count = 200) {
    const data = await this._req(
      `/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`,
    );
    return (data.candles || [])
      .filter(c => c.complete)
      .map(c => ({
        t: new Date(c.time).getTime(),
        o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c,
        v: c.volume || 1,
      }));
  }

  async getAccountSummary() {
    const data = await this._req(`/accounts/${this.accountId}/summary`);
    return {
      balance:        +data.account.balance,
      equity:         +data.account.NAV,
      currency:        data.account.currency,
      openTradeCount: +data.account.openTradeCount,
      unrealizedPL:   +data.account.unrealizedPL,
    };
  }

  async getOpenTrades() {
    const data = await this._req(`/accounts/${this.accountId}/openTrades`);
    return data.trades || [];
  }

  async getOpenPositions() {
    const data = await this._req(`/accounts/${this.accountId}/openPositions`);
    return data.positions || [];
  }

  // Get a specific closed/completed transaction by ID
  async getTransaction(txId) {
    const data = await this._req(`/accounts/${this.accountId}/transactions/${txId}`);
    return data.transaction;
  }

  // Place a market order. units > 0 = long, units < 0 = short
  async placeMarketOrder({ instrument, units, sl, tp, clientId }) {
    const order = {
      type:         'MARKET',
      instrument,
      units:        String(Math.round(units)),
      timeInForce:  'FOK',
      positionFill: 'DEFAULT',
    };
    if (sl) order.stopLossOnFill   = { price: sl.toFixed(5), timeInForce: 'GTC' };
    if (tp) order.takeProfitOnFill = { price: tp.toFixed(5), timeInForce: 'GTC' };
    if (clientId) {
      order.clientExtensions = { id: clientId.slice(0, 128), comment: 'ForexPro-Bot' };
    }
    return this._req(`/accounts/${this.accountId}/orders`, {
      method: 'POST',
      body:   JSON.stringify({ order }),
    });
  }

  // Close all units of a position
  async closePosition(instrument) {
    return this._req(
      `/accounts/${this.accountId}/positions/${instrument}/close`,
      { method: 'PUT', body: JSON.stringify({ longUnits: 'ALL', shortUnits: 'ALL' }) },
    );
  }
}

module.exports = { OandaClient };

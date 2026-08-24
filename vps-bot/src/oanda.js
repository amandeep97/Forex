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

  // A request with no timeout is not a slow request, it is a permanent one.
  // node-fetch will wait forever on a black-holed socket, and any caller that
  // holds a lock across the await — the live feed does — stops for good while
  // the rest of the bot carries on looking healthy.
  async _req(path, opts = {}) {
    const url = `${this.base}${path}`;
    const res  = await fetch(url, {
      timeout: 25000,
      ...opts,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      // Gateway errors (Cloudflare 502/504) return a full HTML page, not JSON.
      // Dumping it verbatim floods the pm2 log with thousands of markup lines,
      // so keep a short, useful message instead.
      const raw = await res.text().catch(() => '');
      const body = /^\s*</.test(raw)
        ? `<non-JSON ${raw.length}B response — gateway/outage page>`
        : raw.slice(0, 300);
      throw new Error(`OANDA ${res.status} ${path}: ${body}`);
    }
    return res.json();
  }

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

  // Bid and ask separately — the mid-price candles above cannot show what a
  // trade actually costs, and a spread that has tripled is a reason to stand
  // aside no matter how good the setup looks.
  async getBidAskCandles(instrument, granularity, count = 96) {
    const data = await this._req(
      `/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=BA`,
    );
    return (data.candles || [])
      .filter(c => c.complete && c.bid && c.ask)
      .map(c => ({ t: new Date(c.time).getTime(), bid: +c.bid.c, ask: +c.ask.c }));
  }

  // No getPositionBook here, deliberately, so nobody adds one back.
  //
  // OANDA does not serve /instruments/{x}/positionBook to this account.
  // Verified rather than assumed: the same live token, on the same host, in the
  // same command, listed both accounts from /v3/accounts and returned 401
  // "Invalid authentication credentials" from the position book. The token is
  // valid and that endpoint is not available, so no configuration reaches it.
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

  async getTransaction(txId) {
    const data = await this._req(`/accounts/${this.accountId}/transactions/${txId}`);
    return data.transaction;
  }

  async getTradeDetails(tradeId) {
    const data = await this._req(`/accounts/${this.accountId}/trades/${tradeId}`);
    return data.trade;
  }

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

  // Move the stop on a trade that is already open.
  //
  // OANDA also offers a native trailing stop (`trailingStopLoss`), which is one
  // field at order placement and is handled server-side even if this bot is
  // down. It is deliberately not used: it ratchets on every tick, while the
  // Backtester ratchets on bar closes. Those are different strategies — the
  // tick version is wicked out of trades the tested one holds — and a live
  // result that cannot be compared to its backtest is not worth having.
  async modifyTradeStop(tradeId, price) {
    return this._req(`/accounts/${this.accountId}/trades/${tradeId}/orders`, {
      method: 'PUT',
      body:   JSON.stringify({ stopLoss: { price: price.toFixed(5), timeInForce: 'GTC' } }),
    });
  }

  async closePosition(instrument) {
    return this._req(
      `/accounts/${this.accountId}/positions/${instrument}/close`,
      { method: 'PUT', body: JSON.stringify({ longUnits: 'ALL', shortUnits: 'ALL' }) },
    );
  }
}

module.exports = { OandaClient };

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

  // OANDA returns at most 5000 candles per request, which on H1 is about ten
  // months. That is enough to describe how the market behaves now and not
  // enough to say whether it behaved that way BEFORE, which is the whole
  // question a regime study asks. So: fetch a long history one time window at a
  // time.
  //
  // Windows rather than a rolling cursor, and from/to rather than from/count,
  // because both of those remove a way to be wrong.
  //
  //   A window is bounded by construction. `from` with a `count` returns
  //   whatever the server feels like, and if the last bar of a page is not
  //   later than the last bar of the previous one — which happens at the live
  //   edge, where the newest candle is incomplete and gets filtered out — the
  //   loop never advances.
  //
  //   A window sized well under 5000 bars cannot trip "maximum candle count
  //   exceeded", which a naive from/to over four years does immediately.
  //
  // Pages overlap at the boundary by design and the duplicates are dropped by
  // timestamp, so a bar can never be counted twice.
  static windowFor(granularity) {
    const bar = {
      S5: 5e3, S10: 1e4, S30: 3e4, M1: 60e3, M2: 12e4, M4: 24e4, M5: 3e5,
      M10: 6e5, M15: 9e5, M30: 18e5, H1: 36e5, H2: 72e5, H3: 108e5, H4: 144e5,
      H6: 216e5, H8: 288e5, H12: 432e5, D: 864e5, W: 6048e5,
    }[granularity] || 36e5;
    // Three thousand bars a page: comfortably under the server's limit even in
    // a stretch with no weekends missing from it.
    return bar * 3000;
  }

  async getCandlesSince(instrument, granularity, fromMs, { to = Date.now(), max = 60000 } = {}) {
    const span = OandaClient.windowFor(granularity);
    const seen = new Set();
    const out = [];
    for (let start = fromMs; start < to && out.length < max;) {
      const end = Math.min(start + span, to);
      const data = await this._req(
        `/instruments/${instrument}/candles?granularity=${granularity}`
        + `&from=${encodeURIComponent(new Date(start).toISOString())}`
        + `&to=${encodeURIComponent(new Date(end).toISOString())}&price=M`,
      );
      for (const c of data.candles || []) {
        if (!c.complete) continue;
        const t = new Date(c.time).getTime();
        if (seen.has(t)) continue;
        seen.add(t);
        out.push({ t, o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, v: c.volume || 1 });
      }
      if (end >= to) break;
      start = end;
    }
    out.sort((a, b) => a.t - b.t);
    return out.slice(0, max);
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

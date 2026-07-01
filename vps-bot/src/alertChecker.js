'use strict';
const fetch = require('node-fetch');
let webpush = null;
try { webpush = require('web-push'); } catch { /* installed on setup */ }

const ALERTS_PATH = 'bot/alerts.json';
const SUBS_PATH   = 'bot/push-subscriptions.json';

const OANDA_MAP = {
  'EUR/USD':'EUR_USD','GBP/USD':'GBP_USD','USD/JPY':'USD_JPY','USD/CHF':'USD_CHF','USD/CAD':'USD_CAD',
  'AUD/USD':'AUD_USD','NZD/USD':'NZD_USD','EUR/JPY':'EUR_JPY','GBP/JPY':'GBP_JPY',
  'XAU/USD':'XAU_USD','XAG/USD':'XAG_USD','US30':'US30_USD','NAS100':'NAS100_USD','SPX500':'SPX500_USD',
};
const BINANCE_MAP = { 'BTC/USDT':'BTCUSDT','ETH/USDT':'ETHUSDT','SOL/USDT':'SOLUSDT' };
const BIN_TF = { M15:'15m', M30:'30m', H1:'1h', H4:'4h', D:'1d' };

function dec(sym) {
  if (sym.startsWith('XAU')) return 2;
  if (/^(US|NAS|SPX)/.test(sym)) return 1;
  if (sym.includes('JPY')) return 3;
  if (sym.includes('BTC') || sym.includes('ETH')) return 1;
  if (sym.includes('SOL') || sym.includes('XAG')) return 2;
  return 5;
}

class AlertChecker {
  constructor({ oanda, github, env, log }) {
    this.oanda = oanda;
    this.github = github;
    this.env = env;
    this.log = log || (() => {});
    this.prev = new Map();        // sym -> last price (+ tl_<id> sides)
    this.zoneInside = new Map();  // alertId -> bool
    if (webpush && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:alerts@forexpro.app', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
      this.ready = true;
    } else { this.ready = false; }
  }

  async _price(sym) {
    if (BINANCE_MAP[sym]) {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${BINANCE_MAP[sym]}`);
      if (!r.ok) return null;
      return parseFloat((await r.json()).price) || null;
    }
    const instr = OANDA_MAP[sym];
    if (!instr) return null;
    const c = await this.oanda.getCandles(instr, 'M1', 2);
    return c.length ? c[c.length - 1].c : null;
  }

  async _lastClosed(sym, tf) {
    if (BINANCE_MAP[sym]) {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${BINANCE_MAP[sym]}&interval=${BIN_TF[tf] || '1h'}&limit=2`);
      if (!r.ok) return null;
      const d = await r.json();
      const k = d[0];
      return k ? { o:+k[1], h:+k[2], l:+k[3], c:+k[4], t:k[0] } : null;
    }
    const instr = OANDA_MAP[sym];
    if (!instr) return null;
    const c = await this.oanda.getCandles(instr, tf, 2);
    return c.length ? c[c.length - 1] : null;
  }

  async _push(subs, title, body) {
    if (!this.ready || !subs.length) return { dead: [] };
    const dead = [];
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(s, JSON.stringify({ title, body }));
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint);
      }
    }));
    return { dead };
  }

  async check() {
    if (!this.ready) return;
    const aFile = await this.github.readJSON(ALERTS_PATH).catch(() => null);
    const alerts = aFile?.content?.alerts || [];
    const active = alerts.filter(a => a.enabled);
    if (!active.length) return;

    const sFile = await this.github.readJSON(SUBS_PATH).catch(() => null);
    let subs = sFile?.content?.subscriptions || [];
    if (!subs.length) { this.log('Alerts: no push subscriptions registered'); return; }

    const syms = [...new Set(active.map(a => a.sym))];
    let changed = false;
    const allDead = new Set();

    for (const sym of syms) {
      const symAlerts = active.filter(a => a.sym === sym);
      const needPrice = symAlerts.some(a => ['price','zone','trendline'].includes(a.type));
      const tfs = [...new Set(symAlerts.filter(a => a.type === 'candle').map(a => a.tf))];

      let price = null;
      if (needPrice) price = await this._price(sym).catch(() => null);
      const prev = this.prev.get(sym);
      if (price != null) this.prev.set(sym, price);

      const closes = {};
      for (const tf of tfs) closes[tf] = await this._lastClosed(sym, tf).catch(() => null);

      const d = dec(sym);
      for (const a of symAlerts) {
        const live = alerts.find(x => x.id === a.id);
        if (!live || !live.enabled) continue;
        let msg = null;

        if (a.type === 'price' && price != null && prev != null) {
          const L = a.level;
          let hit = a.dir === 'above' ? (prev < L && price >= L)
                  : a.dir === 'below' ? (prev > L && price <= L)
                  : ((prev - L) * (price - L) < 0);
          if (hit) msg = `Price ${a.dir === 'below' ? 'dropped below' : a.dir === 'above' ? 'rose above' : 'crossed'} ${L} (now ${price.toFixed(d)})`;
        }
        else if (a.type === 'zone' && price != null) {
          const inside = price >= a.bottom && price <= a.top;
          const was = this.zoneInside.get(a.id);
          this.zoneInside.set(a.id, inside);
          if (inside && was === false) msg = `Price entered zone ${a.bottom}–${a.top} (now ${price.toFixed(d)})`;
        }
        else if (a.type === 'trendline' && price != null) {
          const slope = (a.p2 - a.p1) / ((a.t2 - a.t1) || 1);
          const lineP = a.p1 + slope * (Date.now() - a.t1);
          const key = `tl_${a.id}`;
          const side = price >= lineP ? 1 : -1;
          const prevSide = this.prev.get(key);
          this.prev.set(key, side);
          if (prevSide != null && prevSide !== side) msg = `Price crossed your trendline at ${lineP.toFixed(d)} (now ${price.toFixed(d)})`;
        }
        else if (a.type === 'candle') {
          const cd = closes[a.tf];
          if (cd && (a.lastCandleT == null || cd.t > a.lastCandleT)) {
            live.lastCandleT = cd.t; changed = true;
            const cond = a.closeDir === 'above' ? cd.c > a.level : cd.c < a.level;
            if (cond) msg = `${a.tf} candle CLOSED ${a.closeDir} ${a.level} (close ${cd.c.toFixed(d)})`;
          }
        }

        if (msg) {
          this.log(`ALERT ${sym}: ${msg}`);
          const { dead } = await this._push(subs, `🔔 ${sym} alert`, msg);
          dead.forEach(e => allDead.add(e));
          live.lastTriggered = Date.now();
          if (!a.repeat) live.enabled = false;
          changed = true;
        }
      }
    }

    if (changed) {
      await this.github.writeJSON(ALERTS_PATH, { alerts, updatedAt: new Date().toISOString() }, 'bot: alert fired', aFile.sha).catch(e => this.log(`alerts write: ${e.message}`));
    }
    if (allDead.size) {
      const cleaned = subs.filter(s => !allDead.has(s.endpoint));
      await this.github.writeJSON(SUBS_PATH, { subscriptions: cleaned }, 'bot: prune dead subscriptions', sFile.sha).catch(() => {});
    }
  }
}

module.exports = { AlertChecker };

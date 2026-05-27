'use strict';
const { OandaClient }   = require('./oanda');
const { GitHubClient }  = require('./github');
const { TelegramClient } = require('./telegram');
const { analyzeSMC }    = require('./smc');
const {
  getCurrentSession, isWeekend,
  getPipSize, calcPosition, genTradeId, fmtPrice,
} = require('./utils');

const STRATEGY_PATH = 'bot/strategy.json';
const TRADES_PATH   = 'bot/trades.json';
const CONTROL_PATH  = 'bot/vps-control.json';

class ForexBot {
  constructor(env) {
    this.oanda    = new OandaClient({ apiKey: env.OANDA_API_KEY, accountId: env.OANDA_ACCOUNT_ID, practice: env.OANDA_PRACTICE !== 'false' });
    this.github   = new GitHubClient({ token: env.GITHUB_TOKEN, owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH || 'main' });
    this.telegram = new TelegramClient({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
    this.configSha = null;
    this.tradesSha = null;
  }

  log(msg)  { console.log(`[${new Date().toISOString()}] ${msg}`); }
  warn(msg) { console.warn(`[${new Date().toISOString()}] WARN ${msg}`); }
  err(msg, e) { console.error(`[${new Date().toISOString()}] ERR ${msg}`, e?.message || ''); }

  async run() {
    this.log('── Tick ──────────────────────');

    if (isWeekend()) { this.log('Weekend — skipped'); return; }

    const ctrl = await this.github.readJSON(CONTROL_PATH).catch(() => null);
    const ctrlCmd = ctrl?.content?.command;
    if (ctrlCmd === 'stopped' || ctrlCmd === 'paused') {
      this.log(`Bot ${ctrlCmd} by remote control — skipping tick`);
      return;
    }

    const cfgFile = await this.github.readJSON(STRATEGY_PATH).catch(e => { this.err('Config read', e); return null; });
    if (!cfgFile) { this.warn('No strategy.json found in repo'); return; }
    const config   = cfgFile.content;
    this.configSha = cfgFile.sha;

    const tFile = await this.github.readJSON(TRADES_PATH).catch(() => null);
    const tradeLog = tFile?.content || { trades: [] };
    this.tradesSha = tFile?.sha || null;

    const [account, openTrades] = await Promise.all([
      this.oanda.getAccountSummary(),
      this.oanda.getOpenTrades(),
    ]);
    this.log(`Account: $${account.balance.toFixed(2)} | Open trades: ${openTrades.length}`);

    await this._syncClosedTrades(openTrades, tradeLog, account);

    const utcH = new Date().getUTCHours(), utcM = new Date().getUTCMinutes();
    if (utcH === 21 && utcM < 2) {
      await this._sendDailySummary(tradeLog.trades);
    }

    const maxTotal = config.globalSettings?.maxTotalTrades || 3;
    if (openTrades.length >= maxTotal) {
      this.log(`Global limit reached (${openTrades.length}/${maxTotal}) — not scanning`);
      await this._saveTrades(tradeLog);
      return;
    }

    for (const strat of (config.strategies || [])) {
      if (!strat.enabled) continue;
      if (openTrades.length >= maxTotal) break;

      const pairsToScan = strat.pairs?.length ? strat.pairs : (strat.pair ? [strat.pair] : []);

      for (const pair of pairsToScan) {
        if (openTrades.length >= maxTotal) break;

        const maxPerPair   = strat.maxPositionsPerPair || 1;
        const openForPair  = openTrades.filter(t => t.instrument === pair).length;
        if (openForPair >= maxPerPair) {
          this.log(`${pair}: ${openForPair}/${maxPerPair} positions open — skip`);
          continue;
        }

        try {
          const placed = await this._runStrategy({ ...strat, pair }, account, tradeLog);
          if (placed) openTrades.push({ instrument: pair });
        } catch (e) {
          this.err(`Strategy "${strat.name}" / ${pair}`, e);
        }
      }
    }

    await this._saveTrades(tradeLog);
  }

  async _runStrategy(strat, account, tradeLog) {
    const { pair, timeframe = 'H1', direction = 'both', conditions = {}, risk = {} } = strat;

    const sessions    = getCurrentSession();
    const allowedSess = conditions.sessions?.length ? conditions.sessions : ['london', 'newyork'];
    if (!sessions.some(s => allowedSess.includes(s))) {
      this.log(`${pair}: outside session — skip`);
      return false;
    }

    const candles = await this.oanda.getCandles(pair, timeframe, 250);
    if (candles.length < 50) { this.warn(`${pair}: not enough candles`); return false; }

    const smc = analyzeSMC(candles);
    const cp  = smc.currentPrice;

    const dir = this._resolveDirection(direction, smc);
    if (!dir) { this.log(`${pair}: direction mismatch`); return false; }

    const pass = {
      structure: !conditions.structure || conditions.structure === 'any' || smc.structure === conditions.structure,
      bos:       !conditions.requireBOS || smc.hasBOS,
      ob:        !conditions.requireOB  || (dir === 'long' ? smc.hasBullOB : smc.hasBearOB),
      fvg:       !conditions.requireFVG || (dir === 'long' ? smc.hasBullFVG : smc.hasBearFVG),
      ote:       !conditions.requireOTE || (dir === 'long' ? smc.inOTEBull  : smc.inOTEBear),
      rsi:       !conditions.rsiFilter?.enabled || this._checkRSI(smc.rsi, conditions.rsiFilter),
    };

    const failed = Object.entries(pass).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length) { this.log(`${pair}: FAIL [${failed.join(', ')}]`); return false; }
    this.log(`${pair}: ALL PASS — building order`);

    const pip = getPipSize(pair);
    const sl  = this._calcSL(dir, cp, smc, risk, pip);
    const tp  = this._calcTP(dir, cp, sl, risk, pip);

    const slPips = Math.abs(cp - sl) / pip;
    const tpPips = Math.abs(tp - cp) / pip;
    const rr     = +(tpPips / slPips).toFixed(2);

    if (rr < 1.5) { this.log(`${pair}: RR too low (${rr})`); return false; }

    const { lots, units } = calcPosition({
      balance: account.balance,
      riskPercent: risk.riskPercent || 1,
      entryPrice: cp,
      slPrice: sl,
      pair,
    });
    const signedUnits = dir === 'long' ? units : -units;

    const tradeId = genTradeId();
    const result  = await this.oanda.placeMarketOrder({ instrument: pair, units: signedUnits, sl, tp, clientId: tradeId });
    const fillTx  = result.orderFillTransaction;
    const actualEntry = fillTx ? +fillTx.price : cp;

    const session = sessions.includes('overlap') ? 'overlap' : sessions[0] || 'unknown';

    const record = {
      id: tradeId,
      strategyId:   strat.id,
      strategyName: strat.name,
      pair,
      direction: dir,
      entry:     +fmtPrice(actualEntry, pair),
      sl:        +fmtPrice(sl, pair),
      tp:        +fmtPrice(tp, pair),
      lotSize:   lots,
      units:     signedUnits,
      rrPlanned: rr,
      session,
      openedAt:  new Date().toISOString(),
      closedAt:  null,
      closePrice: null,
      status:    'open',
      pnlPips:   null,
      pnlUsd:    null,
      rrAchieved: null,
      source:    'vps_bot',
      oandaId:   fillTx?.tradeOpened?.tradeID || null,
    };

    tradeLog.trades.push(record);

    this.log(`${pair}: ORDER PLACED — ${dir.toUpperCase()} ${lots} lots | Entry ${fmtPrice(actualEntry, pair)} | SL ${fmtPrice(sl, pair)} | TP ${fmtPrice(tp, pair)} | RR 1:${rr}`);

    await this.telegram.send(this.telegram.tradeOpened({
      pair, dir, lots: lots.toFixed(2), rr,
      entry: fmtPrice(actualEntry, pair),
      sl:    fmtPrice(sl, pair),
      tp:    fmtPrice(tp, pair),
      strategy: strat.name,
      session,
    })).catch(e => this.warn(`Telegram: ${e.message}`));

    return true;
  }

  _resolveDirection(dirSetting, smc) {
    if (dirSetting === 'long')  return smc.structure !== 'bearish' ? 'long' : null;
    if (dirSetting === 'short') return smc.structure !== 'bullish' ? 'short' : null;
    if (smc.structure === 'bullish') return 'long';
    if (smc.structure === 'bearish') return 'short';
    return null;
  }

  _checkRSI(rsi, filter) {
    if (filter.comparison === 'above') return rsi > filter.value;
    if (filter.comparison === 'below') return rsi < filter.value;
    return true;
  }

  _calcSL(dir, cp, smc, risk, pip) {
    const method = risk.slMethod || 'atr';
    if (method === 'swing') {
      const buf = pip * 3;
      return dir === 'long'
        ? smc.recentSwingLow  - buf
        : smc.recentSwingHigh + buf;
    }
    if (method === 'fixed') {
      const pips = risk.slPips || 20;
      return dir === 'long' ? cp - pips * pip : cp + pips * pip;
    }
    const mult = risk.slAtr || 1.5;
    return dir === 'long' ? cp - smc.atr * mult : cp + smc.atr * mult;
  }

  _calcTP(dir, cp, sl, risk, pip) {
    const method = risk.tpMethod || 'rr';
    const slDist = Math.abs(cp - sl);
    if (method === 'rr') {
      const rr = risk.rrRatio || 2;
      return dir === 'long' ? cp + slDist * rr : cp - slDist * rr;
    }
    if (method === 'fixed') {
      const pips = risk.tpPips || 40;
      return dir === 'long' ? cp + pips * pip : cp - pips * pip;
    }
    const ext = risk.tpFibLevel || 1.618;
    return dir === 'long' ? cp + slDist * ext : cp - slDist * ext;
  }

  async _syncClosedTrades(openTrades, tradeLog, account) {
    const openIds = new Set(openTrades.map(t => t.id));

    for (const rec of tradeLog.trades) {
      if (rec.status !== 'open' || !rec.oandaId) continue;
      if (openIds.has(rec.oandaId)) continue;

      try {
        const closedTrades = await this.oanda.getOpenTrades().catch(() => []);
        const isStillOpen  = closedTrades.some(t => t.id === rec.oandaId);
        if (isStillOpen) continue;

        rec.status    = 'closed';
        rec.closedAt  = new Date().toISOString();
        this.log(`${rec.pair} trade ${rec.id}: detected as closed`);
      } catch (e) {
        this.warn(`Sync trade ${rec.id}: ${e.message}`);
      }
    }
  }

  async _sendDailySummary(trades) {
    const today  = new Date().toISOString().slice(0, 10);
    const today_ = trades.filter(t => t.openedAt?.startsWith(today));
    if (!today_.length) return;
    const wins   = today_.filter(t => t.status === 'tp_hit').length;
    const losses = today_.filter(t => t.status === 'sl_hit').length;
    const pnl    = today_.reduce((s, t) => s + (t.pnlUsd || 0), 0);
    await this.telegram.send(
      this.telegram.dailySummary({ date: today, total: today_.length, wins, losses, pnl })
    ).catch(() => {});
  }

  async _saveTrades(tradeLog) {
    const newSha = await this.github.writeJSON(
      TRADES_PATH, tradeLog,
      `bot: update trade log [${new Date().toISOString().slice(0, 10)}]`,
      this.tradesSha,
    );
    this.tradesSha = newSha;
  }
}

module.exports = { ForexBot };

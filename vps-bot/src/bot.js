'use strict';
const { OandaClient }   = require('./oanda');
const { GitHubClient }  = require('./github');
const { TelegramClient } = require('./telegram');
const { analyzeSMC }    = require('./smc');
const {
  getCurrentSession, isWeekend,
  getPipSize, calcPosition, genTradeId, fmtPrice,
} = require('./utils');
const { checkIMFilter } = require('./intermarket');
const { fetchAllCOT, checkCOTFilter } = require('./cotFetcher');

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
    this.cotData   = null;
    this.cotFetchedAt = 0;
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
    const tradeLog = tFile?.content?.trades ? tFile.content : { trades: [] };
    this.tradesSha = tFile?.sha || null;

    const [account, openTrades] = await Promise.all([
      this.oanda.getAccountSummary(),
      this.oanda.getOpenTrades(),
    ]);
    this.log(`Account: $${account.balance.toFixed(2)} | Open trades: ${openTrades.length}`);

    const reconcileChanged = await this._reconcileOpenTrades(openTrades, tradeLog);
    const syncChanged      = await this._syncClosedTrades(openTrades, tradeLog, account);

    const utcH = new Date().getUTCHours(), utcM = new Date().getUTCMinutes();
    if (utcH === 21 && utcM < 2) {
      await this._sendDailySummary(tradeLog.trades);
    }

    const maxTotal = config.globalSettings?.maxTotalTrades || 3;
    if (openTrades.length >= maxTotal) {
      this.log(`Global limit reached (${openTrades.length}/${maxTotal}) — not scanning`);
      if (reconcileChanged || syncChanged) await this._saveTrades(tradeLog);
      return;
    }

    let tradePlaced = false;
    for (const strat of (config.strategies || [])) {
      if (!strat.enabled) continue;
      if (openTrades.length >= maxTotal) break;

      const pairsToScan = strat.pairs?.length ? strat.pairs : (strat.pair ? [strat.pair] : []);

      for (const pair of pairsToScan) {
        if (openTrades.length >= maxTotal) break;

        const maxPerPair = strat.maxPositionsPerPair || 1;
        const stratOandaIds = new Set(
          tradeLog.trades
            .filter(t => t.strategyId === strat.id && t.status === 'open' && t.oandaId)
            .map(t => String(t.oandaId))
        );
        const openForPair = openTrades.filter(t =>
          t.instrument === pair && stratOandaIds.has(String(t.id))
        ).length;
        if (openForPair >= maxPerPair) {
          this.log(`${pair}: ${openForPair}/${maxPerPair} positions open for strategy "${strat.name}" — skip`);
          continue;
        }

        try {
          const placed = await this._runStrategy({ ...strat, pair }, account, tradeLog);
          if (placed) { openTrades.push({ instrument: pair }); tradePlaced = true; }
        } catch (e) {
          this.err(`Strategy "${strat.name}" / ${pair}`, e);
        }
      }
    }

    if (reconcileChanged || syncChanged || tradePlaced) await this._saveTrades(tradeLog);
    else this.log('No changes — skipping trades.json write');
  }

  async _runStrategy(strat, account, tradeLog) {
    const { pair, timeframe = 'H1', direction = 'both', conditions = {}, risk = {} } = strat;

    const sessions = getCurrentSession();
    if (conditions.sessions?.length && !sessions.some(s => conditions.sessions.includes(s))) {
      this.log(`${pair}: outside session — skip`);
      return false;
    }

    const candles = await this.oanda.getCandles(pair, timeframe, 250);
    if (candles.length < 50) { this.warn(`${pair}: not enough candles`); return false; }

    const fibLevels = conditions.oteFibLevels
      ? String(conditions.oteFibLevels).split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v))
      : null;
    const smc = analyzeSMC(candles, fibLevels ? { fibLevels } : {});
    const cp  = smc.currentPrice;

    const dir = this._resolveDirection(direction, smc);
    if (!dir) { this.log(`${pair}: direction mismatch`); return false; }

    // Price zone check — discount for longs, premium for shorts
    const zoneRequired = conditions.priceZone || 'any';
    const zoneOk = zoneRequired === 'any' ||
      (zoneRequired === 'discount' && smc.inDiscount) ||
      (zoneRequired === 'premium'  && smc.inPremium);

    const pass = {
      structure:  !conditions.structure || conditions.structure === 'any' || smc.structure === conditions.structure,
      priceZone:  zoneOk,
      bos:        !conditions.requireBOS || smc.hasBOS,
      ob:         !conditions.requireOB  || (dir === 'long' ? smc.hasBullOB : smc.hasBearOB),
      fvg:        !conditions.requireFVG || (dir === 'long' ? smc.hasBullFVG : smc.hasBearFVG),
      ote:        !conditions.requireOTE || (dir === 'long' ? smc.inOTEBull  : smc.inOTEBear),
      rsi:        !conditions.rsiFilter?.enabled || this._checkRSI(smc.rsi, conditions.rsiFilter),
      ratio:      !conditions.ratioFilter?.enabled,
      intermarket: true,
      cot:        true,
    };

    if (conditions.ratioFilter?.enabled) {
      pass.ratio = await this._checkRatioFilter(timeframe, dir);
    }

    if (conditions.intermarketFilter?.enabled) {
      pass.intermarket = await checkIMFilter(this.oanda, { ...conditions.intermarketFilter, pairOanda: pair }, this.log.bind(this));
    }

    if (conditions.cotFilter?.enabled) {
      const now = Date.now();
      if (!this.cotData || now - this.cotFetchedAt > 6 * 3600 * 1000) {
        this.log('Fetching COT data from CFTC…');
        this.cotData = await fetchAllCOT(msg => this.log(msg)).catch(() => null);
        this.cotFetchedAt = now;
      }
      const required = conditions.cotFilter.bias || 'any';
      if (required !== 'any') {
        pass.cot = checkCOTFilter(conditions.cotFilter, this.cotData, pair);
        if (!pass.cot) this.log(`${pair}: COT bias mismatch (required ${required}, got ${this.cotData?.[pair.split('_')[0]]?.bias || 'unknown'})`);
      }
    }

    const failed = Object.entries(pass).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length) { this.log(`${pair}: FAIL [${failed.join(', ')}]`); return false; }
    this.log(`${pair}: ALL PASS — building order`);

    const pip = getPipSize(pair);
    const sl  = this._calcSL(dir, cp, smc, risk, pip);
    const tp  = this._calcTP(dir, cp, sl, risk, pip);

    // Guard: reject if SL is too wide (protects against bad swing detection)
    const slPips = Math.abs(cp - sl) / pip;
    const maxSlPips = risk.maxSlPips || 80;
    if (slPips > maxSlPips) {
      this.log(`${pair}: SL too wide (${slPips.toFixed(0)} pips > max ${maxSlPips}) — skip`);
      return false;
    }

    const tpPips = Math.abs(tp - cp) / pip;
    const rr     = +(tpPips / slPips).toFixed(2);

    if (rr < 1.5) { this.log(`${pair}: RR too low (${rr})`); return false; }

    let lots, units;
    if (risk.riskType === 'lots' && risk.fixedLots) {
      lots  = risk.fixedLots;
      const isMetals = pair.includes('XAU') || pair.includes('XAG');
      units = isMetals ? Math.round(lots * 100) : Math.round(lots * 100_000);
    } else if (risk.riskType === 'usdt' && risk.riskUsdt) {
      const computed = calcPosition({ balance: account.balance, riskPercent: (risk.riskUsdt / account.balance) * 100, entryPrice: cp, slPrice: sl, pair });
      lots  = computed.lots;
      units = computed.units;
    } else {
      const computed = calcPosition({ balance: account.balance, riskPercent: risk.riskPercent || 1, entryPrice: cp, slPrice: sl, pair });
      lots  = computed.lots;
      units = computed.units;
    }
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

  async _checkRatioFilter(timeframe, dir) {
    try {
      const [xau, xag] = await Promise.all([
        this.oanda.getCandles('XAU_USD', timeframe, 20),
        this.oanda.getCandles('XAG_USD', timeframe, 20),
      ]);
      const n = Math.min(xau.length, xag.length);
      if (n < 6) return true;
      const ratioNow  = xau[n - 1].c / xag[n - 1].c;
      const ratioPrev = xau[n - 6].c / xag[n - 6].c;
      const falling   = ratioNow < ratioPrev;
      return dir === 'long' ? falling : !falling;
    } catch (e) {
      this.warn(`Ratio filter: ${e.message}`);
      return true;
    }
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
    let ext = risk.tpFibLevel || 1.618;
    if (risk.tpFibLevels) {
      const parsed = String(risk.tpFibLevels).split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
      if (parsed.length > 0) ext = parsed[0];
    }
    return dir === 'long' ? cp + slDist * ext : cp - slDist * ext;
  }

  async _reconcileOpenTrades(openTrades, tradeLog) {
    const trackedIds = new Set(
      tradeLog.trades
        .filter(t => t.oandaId && t.status === 'open')
        .map(t => String(t.oandaId))
    );
    let changed = false;
    for (const ot of openTrades) {
      if (trackedIds.has(String(ot.id))) continue;
      const units = +ot.currentUnits;
      const dir   = units > 0 ? 'long' : 'short';
      const rec   = {
        id:           genTradeId(),
        strategyId:   'reconciled',
        strategyName: 'Reconciled from OANDA',
        pair:         ot.instrument,
        direction:    dir,
        entry:        ot.price ? +ot.price : null,
        sl:           ot.stopLossOrder?.price   ? +ot.stopLossOrder.price   : null,
        tp:           ot.takeProfitOrder?.price ? +ot.takeProfitOrder.price : null,
        lotSize:      +(Math.abs(units) / 1000).toFixed(2),
        units,
        rrPlanned:    null,
        session:      'unknown',
        openedAt:     ot.openTime || new Date().toISOString(),
        closedAt:     null,
        closePrice:   null,
        status:       'open',
        pnlPips:      null,
        pnlUsd:       null,
        rrAchieved:   null,
        source:       'reconciled',
        oandaId:      String(ot.id),
      };
      tradeLog.trades.push(rec);
      this.log(`Reconciled: ${ot.instrument} ${dir.toUpperCase()} (OANDA ID: ${ot.id})`);
      changed = true;
    }
    return changed;
  }

  async _syncClosedTrades(openTrades, tradeLog, account) {
    const openIds = new Set(openTrades.map(t => t.id));
    let changed = false;

    for (const rec of tradeLog.trades) {
      if (!rec.oandaId) continue;

      const isOpenGone    = rec.status === 'open'   && !openIds.has(rec.oandaId);
      const isClosedNoPnl = rec.status === 'closed' && rec.pnlUsd == null;
      if (!isOpenGone && !isClosedNoPnl) continue;

      try {
        if (isOpenGone) {
          const live = await this.oanda.getOpenTrades().catch(() => []);
          if (live.some(t => t.id === rec.oandaId)) continue;
        }

        const details = await this.oanda.getTradeDetails(rec.oandaId).catch(() => null);
        const pnl     = details ? +details.realizedPL : null;
        rec.closedAt   = details?.closeTime  || rec.closedAt || new Date().toISOString();
        rec.closePrice = details?.averageClosePrice ? +details.averageClosePrice : rec.closePrice;
        rec.pnlUsd     = pnl;

        if (pnl != null) {
          rec.status = pnl > 0 ? 'tp_hit' : 'sl_hit';
          const pip  = getPipSize(rec.pair);
          if (rec.closePrice && rec.entry) {
            rec.pnlPips    = +(((rec.direction === 'long' ? rec.closePrice - rec.entry : rec.entry - rec.closePrice) / pip)).toFixed(1);
            const slPips   = rec.sl ? Math.abs(rec.entry - rec.sl) / pip : 0;
            rec.rrAchieved = slPips > 0 ? +(rec.pnlPips / slPips).toFixed(2) : null;
          }
        } else {
          rec.status = 'closed';
        }

        changed = true;
        this.log(`${rec.pair} trade ${rec.id}: synced — ${rec.status} | PnL $${(pnl || 0).toFixed(2)}`);

        if (isOpenGone) {
          await this.telegram.send(this.telegram.tradeClosed({
            pair:     rec.pair,
            dir:      rec.direction,
            entry:    rec.entry,
            close:    rec.closePrice,
            pnlPips:  rec.pnlPips,
            pnlUsd:   pnl || 0,
            rr:       rec.rrAchieved,
            status:   rec.status,
          })).catch(e => this.warn(`Telegram close: ${e.message}`));
        }
      } catch (e) {
        this.warn(`Sync trade ${rec.id}: ${e.message}`);
      }
    }
    return changed;
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

'use strict';
const { OandaClient }   = require('./oanda');
const { GitHubClient }  = require('./github');
const { TelegramClient } = require('./telegram');
const { analyzeSMC, computeATR } = require('./smc');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  getCurrentSession, isWeekend,
  getPipSize, calcPosition, genTradeId, fmtPrice,
} = require('./utils');
const { checkIMFilter } = require('./intermarket');
const { fetchAllCOT, checkCOTFilter } = require('./cotFetcher');
const { AlertChecker } = require('./alertChecker');
const { FeedBuilder, measure }  = require('./feed');
const { FeedNotifier } = require('./feedNotify');
const { Updater }      = require('./updater');
const { NewsFetcher }  = require('./newsFetcher');
const { runCOTStudy }  = require('./cotStudy');
const { BookRecorder } = require('./bookRecorder');
const { INSTRUMENTS }  = require('./instruments');

const COT_STUDY_PATH = 'bot/cot-study.json';
const STRATEGY_PATH = 'bot/strategy.json';
const TRADES_PATH   = 'bot/trades.json';
const CONTROL_PATH  = 'bot/vps-control.json';

// Timeframe → milliseconds, for the "one entry per bar" guard.
const TF_MS = { M1:60e3, M5:300e3, M15:900e3, M30:1800e3, H1:3600e3, H2:7200e3, H4:14400e3, H6:21600e3, H12:43200e3, D:86400e3, W:604800e3 };
// Start (ms) of the current candle for a timeframe — floor of now to the TF grid.
function barStartMs(tf) {
  const ms = TF_MS[tf] || 900e3;
  return Math.floor(Date.now() / ms) * ms;
}

// Candle patterns come from the app's module, loaded over the same ESM-from-CJS
// bridge the live feed uses. Writing a second engulfing check here would be
// quicker and would eventually disagree with the Backtester — so a rule that
// tested well would trade differently, and there would be no way to tell from
// either screen which one was lying.
const PATTERNS_URL = pathToFileURL(path.join(__dirname, '..', '..', 'src', 'utils', 'candlePatterns.js')).href;

// EMA and VWAP are unambiguous enough to compute here; there is no second
// definition to drift away from.
function emaAt(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let e = candles.slice(0, period).reduce((s, c) => s + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) e = candles[i].c * k + e * (1 - k);
  return e;
}

// Session VWAP, anchored to the start of the current UTC day — the reference
// intraday traders actually use. Anchoring to the fetch window instead would
// give a different number every time the bot restarted.
function vwapToday(candles) {
  const dayStart = Math.floor(Date.now() / 86400e3) * 86400e3;
  let pv = 0, vol = 0;
  for (const c of candles) {
    if (c.t < dayStart) continue;
    const typical = (c.h + c.l + c.c) / 3;
    pv  += typical * (c.v || 1);
    vol += (c.v || 1);
  }
  return vol > 0 ? pv / vol : null;
}

class ForexBot {
  constructor(env) {
    this.oanda    = new OandaClient({
      apiKey: env.OANDA_API_KEY, accountId: env.OANDA_ACCOUNT_ID,
      practice: env.OANDA_PRACTICE !== 'false',
      // Read-only, live-host, used by exactly one endpoint. Absent by default:
      // without it the position book is simply not recorded, which is the state
      // this has always been in. Setting it does NOT move trading anywhere.
      bookApiKey: env.OANDA_BOOK_API_KEY || null,
    });
    this.github   = new GitHubClient({ token: env.GITHUB_TOKEN, owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH || 'main' });
    this.telegram = new TelegramClient({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
    this.configSha = null;
    this.tradesSha = null;
    this.cotData   = null;
    this.cotFetchedAt = 0;
    this.cotStudyRan = false;
    this.alertChecker = new AlertChecker({ oanda: this.oanda, github: this.github, telegram: this.telegram, env, log: this.log.bind(this) });
    this.updater = new Updater({ github: this.github, env, log: this.log.bind(this) });
    this.news = new NewsFetcher({ github: this.github, log: this.log.bind(this) });
    // Records where OANDA's clients are positioned. Measures nothing — it makes
    // a future measurement possible, which is the only thing that can be done
    // about a question whose data was never kept.
    this.book = new BookRecorder({
      oanda: this.oanda, github: this.github, instruments: INSTRUMENTS,
      log: this.log.bind(this),
    });
    this.feed = env.FEED_ENABLED === 'false'
      ? null
      : new FeedBuilder({
          oanda: this.oanda, github: this.github, log: this.log.bind(this),
          notifier: new FeedNotifier({ github: this.github, telegram: this.telegram, env, log: this.log.bind(this) }),
        });
  }

  // Publishes bot/cot-study.json. Once per process, and only when the answer
  // on file is missing or stale — thirteen COT downloads and thirteen candle
  // pulls is not something to repeat every minute.
  async _maybeCOTStudy() {
    if (this.cotStudyRan) return;
    const cur = await this.github.readJSON(COT_STUDY_PATH).catch(() => null);
    const age = cur?.content?.asOf ? Date.now() - Date.parse(cur.content.asOf) : Infinity;
    if (age < 7 * 86400e3) { this.cotStudyRan = true; return; }

    this.cotStudyRan = true;   // set first, so a failure does not retry every tick
    this.log('COT study: measuring what follows a positioning extreme…');
    const result = await runCOTStudy({
      instruments: INSTRUMENTS, oanda: this.oanda, log: this.log.bind(this),
    });
    await this.github.writeJSON(COT_STUDY_PATH, result, 'bot: COT positioning study', cur?.sha || null);
    const cl = result.crowdedLong?.horizons?.[20], cs = result.crowdedShort?.horizons?.[20];
    this.log(`COT study published — crowded long ${result.crowdedLong?.episodes} episodes`
      + `${cl ? ` (${cl.win}% vs ${cl.baseWin}% at 20d, z=${cl.z})` : ''}`
      + `, crowded short ${result.crowdedShort?.episodes} episodes`
      + `${cs ? ` (${cs.win}% vs ${cs.baseWin}%, z=${cs.z})` : ''}`);
  }

  log(msg)  { console.log(`[${new Date().toISOString()}] ${msg}`); }
  warn(msg) { console.warn(`[${new Date().toISOString()}] WARN ${msg}`); }
  err(msg, e) { console.error(`[${new Date().toISOString()}] ERR ${msg}`, e?.message || ''); }

  async run() {
    this.log('── Tick ──────────────────────');

    // Self-update first, so a tick never runs half on old code and half on new.
    // If it updates, the process exits here and pm2 restarts it; everything
    // below simply happens on the next tick with the new build.
    if (await this._maybeUpdate()) return;

    // Price/candle/trendline alerts run every tick, independent of trading (works weekends for crypto)
    await this.alertChecker.check().catch(e => this.warn(`Alert check: ${e.message}`));

    // News runs before the weekend guard for the same reason the feed does: a
    // calendar is most useful on Sunday evening, when nothing is trading and
    // there is still time to read it.
    await this.news.run().catch(e => this.warn(`News: ${e.message}`));

    // The live feed also runs before the weekend guard and before the remote
    // stop switch: it places no orders, and "which instruments are worth
    // looking at on Monday" is a question best answered over the weekend.
    if (this.feed) await this.feed.tick().catch(e => this.warn(`Feed: ${e.message}`));

    // Does an extreme in positioning precede anything? The app has been
    // asserting that it does — "crowded long, the side that unwinds badly" —
    // on an instrument where nobody had measured it. Runs when the published
    // answer is missing or a week old, which on a weekend is free: the only
    // thing this competes with is a feed republishing an unchanged board.
    await this._maybeCOTStudy().catch(e => this.warn(`COT study: ${e.message}`));

    // Before the weekend guard, like the feed and the news: the retail book on
    // a Sunday is still a reading, and skipping weekends would put a two-day
    // hole in every series.
    await this.book.tick().catch(e => this.warn(`Book: ${e.message}`));

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
    // Before the entry scan and before the global-limit early return: managing
    // money already at risk outranks looking for somewhere to put more, and a
    // full book is exactly when the stops most need walking.
    const trailChanged     = await this._manageTrailingStops(openTrades, tradeLog)
      .catch(e => { this.err('Trailing stops', e); return false; });

    const utcH = new Date().getUTCHours(), utcM = new Date().getUTCMinutes();
    if (utcH === 21 && utcM < 2) {
      await this._sendDailySummary(tradeLog.trades);
    }

    const maxTotal = config.globalSettings?.maxTotalTrades || 3;
    if (openTrades.length >= maxTotal) {
      this.log(`Global limit reached (${openTrades.length}/${maxTotal}) — not scanning`);
      if (reconcileChanged || syncChanged || trailChanged) await this._saveTrades(tradeLog);
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

        // One entry attempt per bar: the M15 (etc.) signal stays valid for the whole
        // candle, so without this the bot re-fires every 60s tick. Count ANY logged
        // attempt this bar (including ghost/failed orders) so the loop can't run away.
        const barStart = barStartMs(strat.timeframe);
        const attemptedThisBar = tradeLog.trades.some(t =>
          t.strategyId === strat.id && t.pair === pair &&
          t.openedAt && new Date(t.openedAt).getTime() >= barStart
        );
        if (attemptedThisBar) {
          this.log(`${pair}: already attempted this ${strat.timeframe} bar for "${strat.name}" — skip`);
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

    if (reconcileChanged || syncChanged || trailChanged || tradePlaced) await this._saveTrades(tradeLog);
    else this.log('No changes — skipping trades.json write');
  }

  // Returns true when the process is about to exit for a restart.
  //
  // The "update" command is one-shot: it is cleared before the pull, so a
  // command that somehow crashes the bot cannot put it in a restart loop that
  // pulls, dies, pulls again.
  async _maybeUpdate() {
    const ctrl = await this.github.readJSON(CONTROL_PATH).catch(() => null);

    // Handled on the same read: a second fetch of the same file each tick buys
    // nothing, and both are one-shot requests from the app.
    if (ctrl?.content?.testPush) {
      const result = await this.feed?.notifier?.sendTest().catch(e => ({ ok:false, detail:e.message }))
        || { ok:false, detail:'live feed disabled on this bot' };
      await this.github.writeJSON(
        CONTROL_PATH,
        { ...ctrl.content, testPush:false, testPushAt:new Date().toISOString(), testPushResult:result },
        'bot: push test', ctrl.sha,
      ).catch(e => this.warn(`Test push ack: ${e.message}`));
      this.log(`Push test: ${result.detail}`);
      return false;   // the ack rewrote the file; act on updates next tick
    }

    // A separate field, NOT a value of `command`. Overloading command would mean
    // acknowledging an update rewrites it — silently restarting a bot the user
    // had deliberately stopped.
    const asked = !!ctrl?.content?.updateRequested;

    if (asked) {
      await this.github.writeJSON(
        CONTROL_PATH,
        { ...ctrl.content, updateRequested: false, updateAckAt: new Date().toISOString() },
        'bot: acknowledged update request', ctrl.sha,
      ).catch(e => this.warn(`Control ack: ${e.message}`));
      this.log('Update requested from the app');
    } else if (!this.updater.dueForCheck()) {
      return false;
    }

    let r;
    try { r = await this.updater.update({ force: false }); }
    catch (e) { this.warn(`Updater: ${e.message}`); this.updater.checkedAt = Date.now(); return false; }

    if (r.updated && r.restart) { this.updater.restart(); return true; }
    if (!r.updated && asked) this.log(`Update: ${r.reason}`);
    await this.updater.publish();
    return false;
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
      // These three were configurable in the app and read by nothing. A switch
      // that does not switch anything is worse than a missing feature: a
      // strategy set to enter only on a bullish engulfing entered on every
      // bar, and the screen said it was filtering.
      candle:     await this._checkCandlePattern(candles, conditions.candlePattern),
      ema:        this._checkEMA(candles, conditions.emaFilter),
      vwap:       this._checkVWAP(candles, conditions.vwapFilter),
      feed:       await this._checkFeedMeasures(pair, timeframe, conditions),
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

    // A trailing exit has no planned RR to check. Applying the 1.5 floor to it
    // would reject every trailing trade, since tp is null and the ratio is NaN.
    const rr = tp == null ? null : +((Math.abs(tp - cp) / pip) / slPips).toFixed(2);
    if (rr != null && rr < 1.5) { this.log(`${pair}: RR too low (${rr})`); return false; }

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
    const oandaTradeId = fillTx?.tradeOpened?.tradeID || null;

    // If OANDA didn't actually open a position (order cancelled/rejected — e.g. account
    // locked, insufficient margin, TP/SL invalid), do NOT log a ghost trade. Logging it
    // would both pollute the journal and blind the per-pair guard, causing the bot to
    // re-fire every tick. Record the reject reason (if any) to the log and stand down.
    if (!oandaTradeId) {
      const reject = result.orderCancelTransaction?.reason || result.orderRejectTransaction?.rejectReason || 'no fill (position not opened)';
      this.warn(`${pair}: order did NOT open — ${reject}. Not logging a trade.`);
      return false;
    }

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
      tp:        tp == null ? null : +fmtPrice(tp, pair),
      // Carried on the trade, not looked up from the strategy each tick. If the
      // config is edited or the strategy deleted while a position is open, the
      // stop must keep walking on the terms the trade was opened under.
      trail:     tp == null ? { atr: risk.trailAtr || 3, tf: timeframe } : null,
      trailBar:  null,
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
      oandaId:   oandaTradeId,
    };

    tradeLog.trades.push(record);

    const exitDesc = tp == null ? `TRAIL ${risk.trailAtr || 3} ATR` : `TP ${fmtPrice(tp, pair)} | RR 1:${rr}`;
    this.log(`${pair}: ORDER PLACED — ${dir.toUpperCase()} ${lots} lots | Entry ${fmtPrice(actualEntry, pair)} | SL ${fmtPrice(sl, pair)} | ${exitDesc}`);

    await this.telegram.send(this.telegram.tradeOpened({
      pair, dir, lots: lots.toFixed(2), rr: rr ?? '—',
      entry: fmtPrice(actualEntry, pair),
      sl:    fmtPrice(sl, pair),
      tp:    tp == null ? `trailing ${risk.trailAtr || 3} ATR` : fmtPrice(tp, pair),
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

  // A pattern the app knows about must be present on the last CLOSED bar.
  // `candles` from OandaClient are already complete-only, so the last element
  // is the most recent finished bar and there is no look-ahead to worry about.
  //
  // If the shared module cannot be loaded the answer is false, not true. An
  // unloadable filter that silently passes would place trades the strategy
  // explicitly asked not to place.
  async _checkCandlePattern(candles, want) {
    if (!want || want === 'any') return true;
    let mod;
    try {
      if (!this._patterns) this._patterns = await import(PATTERNS_URL);
      mod = this._patterns;
    } catch (e) {
      this.warn(`Candle patterns not loadable (${e.message}) — treating filter as failed. Run git pull on the VPS.`);
      return false;
    }
    const ids = mod.patternsAt(candles, candles.length - 1) || [];
    if (!ids.length) return false;
    if (want === 'doji') return ids.some(id => /doji|spinning_top/.test(id));
    return ids.some(id => mod.PATTERN_MAP[id]?.type === want);
  }

  // Volatility percentile and range position — the two conditions that appear
  // in nearly every strategy the search turns up, and the two that used to
  // refuse the handoff to live trading outright.
  //
  // measure() is the FEED's own function, imported rather than reimplemented,
  // so the bot cannot drift from the screen. The 520-bar fetch is not
  // arbitrary: the Backtester ranks today's ATR against a trailing 500-bar
  // population, and ranking against 250 instead would answer a different
  // question with the same words — "volatility is in the bottom 30%" of a
  // window half the size is a materially different filter.
  async _checkFeedMeasures(pair, timeframe, conditions) {
    const vp = conditions.volPctFilter, rp = conditions.rangePosFilter;
    if (!vp?.enabled && !rp?.enabled) return true;

    let m;
    try {
      const cs = await this.oanda.getCandles(pair, timeframe, 520);
      m = measure(cs);
    } catch (e) {
      this.warn(`${pair}: feed measures unavailable (${e.message}) — treating filter as failed`);
      return false;
    }
    if (!m) return false;

    if (vp?.enabled) {
      if (m.volPct == null) return false;
      const ok = vp.op === 'below' ? m.volPct <= vp.value : m.volPct >= vp.value;
      if (!ok) { this.log(`${pair}: volatility ${m.volPct}% not ${vp.op} ${vp.value}%`); return false; }
    }
    if (rp?.enabled) {
      if (m.rangePos == null) return false;
      const ok = rp.op === 'below' ? m.rangePos <= rp.value : m.rangePos >= rp.value;
      if (!ok) { this.log(`${pair}: range position ${m.rangePos}% not ${rp.op} ${rp.value}%`); return false; }
    }
    return true;
  }

  _checkEMA(candles, filter) {
    if (!filter?.enabled) return true;
    const e = emaAt(candles, filter.period || 50);
    if (e == null) return false;
    const cp = candles[candles.length - 1].c;
    return (filter.side || 'above') === 'above' ? cp > e : cp < e;
  }

  _checkVWAP(candles, filter) {
    if (!filter?.enabled) return true;
    const v = vwapToday(candles);
    // Before the first bar of the UTC day there is no VWAP yet. Passing would
    // mean the filter quietly switches itself off every night at midnight.
    if (v == null) return false;
    const cp = candles[candles.length - 1].c;
    return (filter.side || 'above') === 'above' ? cp > v : cp < v;
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
    // A trailing exit has no target by definition — that is the whole point of
    // it. The order goes out with a stop and nothing else, and the stop walks
    // forward each bar in _manageTrailingStops.
    if (method === 'trail') return null;
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

  // ── Trailing stops ─────────────────────────────────────────────────────────
  // Walks the stop forward on every open trade that was opened with a trailing
  // exit. Once per COMPLETED BAR, using that bar's close — the same rule the
  // Backtester applies, so a live trade and its backtest can be compared.
  //
  // Ratchet only. A trailing stop that can also widen is not a trailing stop,
  // it is a way to turn every loser into a bigger loser.
  async _manageTrailingStops(openTrades, tradeLog) {
    const live = new Map(openTrades.map(t => [String(t.id), t]));
    const managed = tradeLog.trades.filter(t =>
      t.status === 'open' && t.oandaId && t.trail && live.has(String(t.oandaId)));
    if (!managed.length) return false;

    let changed = false;
    const candleCache = new Map();

    for (const t of managed) {
      const tf  = t.trail.tf || 'H1';
      const bar = barStartMs(tf);
      if (t.trailBar === bar) continue;

      // Claimed before the request, not after. A rejection that repeats every
      // 60s tick would hammer OANDA for the rest of the bar and fill the log;
      // one attempt per bar fails quietly and retries with a fresher level.
      t.trailBar = bar;
      changed = true;

      try {
        const key = `${t.pair}|${tf}`;
        if (!candleCache.has(key)) candleCache.set(key, await this.oanda.getCandles(t.pair, tf, 60));
        const candles = candleCache.get(key);
        if (candles.length < 20) continue;

        const last = candles[candles.length - 1];
        const atr  = computeATR(candles, 14);
        if (!(atr > 0)) continue;

        const cand = t.direction === 'long'
          ? last.c - atr * (t.trail.atr || 3)
          : last.c + atr * (t.trail.atr || 3);

        const current = t.sl;
        const better  = current == null || (t.direction === 'long' ? cand > current : cand < current);
        if (!better) continue;

        await this.oanda.modifyTradeStop(t.oandaId, cand);
        this.log(`${t.pair}: trailing stop ${current == null ? '—' : fmtPrice(current, t.pair)} → ${fmtPrice(cand, t.pair)} (${t.trail.atr} ATR on ${tf} close)`);
        t.sl = +fmtPrice(cand, t.pair);
      } catch (e) {
        // Most often "stop would be on the wrong side of the market" after a
        // gap. Nothing to fix — the next bar's level will be valid or the trade
        // will already have closed at the existing stop.
        this.warn(`Trailing stop ${t.pair}: ${e.message}`);
      }
    }
    return changed;
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

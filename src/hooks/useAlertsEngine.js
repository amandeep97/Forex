'use strict';
import { useEffect, useRef, useCallback } from 'react';
import { instBySym, fetchPrice, fetchLastClosed, fetchRecentCandles } from '../utils/alertFeed';
import { showBrowserNotification, sendTelegram } from '../utils/notifications';
import { detectStrongReversal } from '../utils/candlePatterns';

export const ALERTS_LS = 'forex_alerts_v1';
export const LOG_LS    = 'forex_alert_log_v1';
export const NOTIF_LS  = 'forex_notif_v1';
export const POLL_MS = 30000;

export function loadAlerts() { try { return JSON.parse(localStorage.getItem(ALERTS_LS) || '[]'); } catch { return []; } }
export function saveAlerts(a) { localStorage.setItem(ALERTS_LS, JSON.stringify(a)); window.dispatchEvent(new Event('alerts-updated')); }
export function loadLog() { try { return JSON.parse(localStorage.getItem(LOG_LS) || '[]'); } catch { return []; } }
export function clearLog() { localStorage.setItem(LOG_LS, '[]'); window.dispatchEvent(new Event('alerts-updated')); }
export function notifCfg() { try { return JSON.parse(localStorage.getItem(NOTIF_LS) || '{}'); } catch { return {}; } }
export function saveNotifCfg(cfg) { localStorage.setItem(NOTIF_LS, JSON.stringify(cfg)); }

function pushLog(entry) {
  const log = [entry, ...loadLog()].slice(0, 50);
  localStorage.setItem(LOG_LS, JSON.stringify(log));
  window.dispatchEvent(new Event('alerts-updated'));
}

function fire(alert, price, msg) {
  showBrowserNotification(`🔔 ${alert.sym} alert`, msg);
  const cfg = notifCfg();
  if (cfg.botToken && cfg.chatId) sendTelegram(cfg.botToken, cfg.chatId, `🔔 <b>${alert.sym}</b>\n${msg}`);
  pushLog({ id: alert.id, sym: alert.sym, msg, price, ts: Date.now() });
}

// Runs app-wide (called once in App) — polls prices/candles and fires alerts.
export function useAlertsEngine() {
  const prevPrice  = useRef(new Map());
  const zoneInside = useRef(new Map());

  const tick = useCallback(async () => {
    const active = loadAlerts().filter(a => a.enabled);
    if (!active.length) return;
    const syms = [...new Set(active.map(a => a.sym))];
    const all = loadAlerts();
    let changed = false;

    for (const sym of syms) {
      const inst = instBySym(sym);
      if (!inst) continue;
      const symAlerts = active.filter(a => a.sym === sym);
      const needPrice = symAlerts.some(a => a.type === 'price' || a.type === 'zone' || a.type === 'trendline');
      const candleTfs = [...new Set(symAlerts.filter(a => a.type === 'candle').map(a => a.tf))];
      const patTfs    = [...new Set(symAlerts.filter(a => a.type === 'pattern').map(a => a.tf))];

      let price = null;
      if (needPrice) price = await fetchPrice(inst);
      const prev = prevPrice.current.get(sym);
      if (price != null) prevPrice.current.set(sym, price);

      const closes = {};
      for (const tf of candleTfs) closes[tf] = await fetchLastClosed(inst, tf);
      const series = {};
      for (const tf of patTfs) series[tf] = await fetchRecentCandles(inst, tf, 14);

      for (const a of symAlerts) {
        const live = all.find(x => x.id === a.id);
        if (!live || !live.enabled) continue;

        if (a.type === 'price' && price != null) {
          const L = a.level; let hit = false;
          if (prev != null) {
            if (a.dir === 'above') hit = prev < L && price >= L;
            else if (a.dir === 'below') hit = prev > L && price <= L;
            else hit = (prev - L) * (price - L) < 0;
          }
          if (hit) {
            fire(a, price, `Price ${a.dir === 'below' ? 'dropped below' : a.dir === 'above' ? 'rose above' : 'crossed'} ${L} (now ${price.toFixed(inst.dec)})`);
            live.lastTriggered = Date.now(); if (!a.repeat) live.enabled = false; changed = true;
          }
        }

        if (a.type === 'zone' && price != null) {
          const inside = price >= a.bottom && price <= a.top;
          const was = zoneInside.current.get(a.id);
          zoneInside.current.set(a.id, inside);
          if (inside && was === false) {
            fire(a, price, `Price entered zone ${a.bottom}–${a.top} (now ${price.toFixed(inst.dec)})`);
            live.lastTriggered = Date.now(); if (!a.repeat) live.enabled = false; changed = true;
          }
        }

        if (a.type === 'trendline' && price != null) {
          // Evaluate the diagonal line's price at "now", fire when price crosses it
          const slope = (a.p2 - a.p1) / ((a.t2 - a.t1) || 1);
          const lineP = a.p1 + slope * (Date.now() - a.t1);
          const prevKey = `tl_${a.id}`;
          const prevSide = prevPrice.current.get(prevKey);
          const side = price >= lineP ? 1 : -1;
          prevPrice.current.set(prevKey, side);
          if (prevSide != null && prevSide !== side) {
            fire(a, price, `Price crossed your trendline at ${lineP.toFixed(inst.dec)} (now ${price.toFixed(inst.dec)})`);
            live.lastTriggered = Date.now(); if (!a.repeat) live.enabled = false; changed = true;
          }
        }

        if (a.type === 'candle') {
          const cd = closes[a.tf];
          if (cd && (a.lastCandleT == null || cd.t > a.lastCandleT)) {
            live.lastCandleT = cd.t; changed = true;
            const cond = a.closeDir === 'above' ? cd.c > a.level : cd.c < a.level;
            if (cond) {
              fire(a, cd.c, `${a.tf} candle CLOSED ${a.closeDir} ${a.level} (close ${cd.c.toFixed(inst.dec)})`);
              live.lastTriggered = Date.now(); if (!a.repeat) live.enabled = false;
            }
          }
        }

        if (a.type === 'pattern') {
          const s = series[a.tf];
          if (s && s.length) {
            const last = s[s.length - 1];
            if (a.lastCandleT == null || last.t > a.lastCandleT) {
              live.lastCandleT = last.t; changed = true;
              const pat = detectStrongReversal(s, s.length - 1, a.N || 5);
              const want = a.pattern || 'both';
              if (pat && (want === 'both' || want === pat)) {
                const label = pat === 'hammer' ? 'Strong Hammer 🔨 (bullish sweep)' : 'Strong Shooting Star ⭐ (bearish sweep)';
                fire(a, last.c, `${a.tf} ${label} — swept the ${a.N || 5}-candle ${pat === 'hammer' ? 'low' : 'high'} and reversed (${last.c.toFixed(inst.dec)})`);
                live.lastTriggered = Date.now(); if (!a.repeat) live.enabled = false;
              }
            }
          }
        }
      }
    }
    if (changed) saveAlerts(all);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => { tick(); }, POLL_MS);
    tick();
    return () => clearInterval(timer);
  }, [tick]);
}

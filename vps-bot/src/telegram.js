'use strict';
const fetch = require('node-fetch');

class TelegramClient {
  constructor({ botToken, chatId }) {
    this.botToken = botToken;
    this.chatId   = chatId;
    this.enabled  = !!(botToken && chatId);
  }

  async send(text) {
    if (!this.enabled) return;
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[Telegram] Error: ${body}`);
    }
  }

  tradeOpened({ pair, dir, entry, sl, tp, lots, rr, strategy, session }) {
    const arrow = dir === 'long' ? '🟢' : '🔴';
    return (
`${arrow} <b>TRADE OPENED — ${pair}</b>
📊 ${strategy} | ${session.toUpperCase()}

Direction : <b>${dir.toUpperCase()}</b>
Entry     : <code>${entry}</code>
Stop Loss : <code>${sl}</code>  (${Math.abs(((+entry - +sl) / +entry * 10000)).toFixed(1)} pips)
Take Profit: <code>${tp}</code>
Lot Size  : <code>${lots}</code>
R:R Ratio : <code>1:${rr}</code>`
    );
  }

  tradeClosed({ pair, dir, entry, close, pnlPips, pnlUsd, rr, status }) {
    const win   = status === 'tp_hit';
    const emoji = win ? '✅' : '❌';
    const sign  = pnlUsd >= 0 ? '+' : '';
    return (
`${emoji} <b>TRADE ${win ? 'WIN' : 'LOSS'} — ${pair}</b>

Direction : ${dir.toUpperCase()}
Entry → Close: <code>${entry}</code> → <code>${close}</code>
Pips      : <code>${win ? '+' : ''}${pnlPips.toFixed(1)}</code>
P&amp;L       : <code>$${sign}${pnlUsd.toFixed(2)}</code>
RR Achieved: <code>1:${rr.toFixed(2)}</code>`
    );
  }

  dailySummary({ date, total, wins, losses, pnl }) {
    const up  = pnl >= 0 ? '📈' : '📉';
    const wr  = total > 0 ? Math.round(wins / total * 100) : 0;
    const sign = pnl >= 0 ? '+' : '';
    return (
`${up} <b>DAILY SUMMARY — ${date}</b>

Trades    : ${total}  (${wins}W / ${losses}L)
Win Rate  : <code>${wr}%</code>
Total P&amp;L : <code>$${sign}${pnl.toFixed(2)}</code>`
    );
  }
}

module.exports = { TelegramClient };

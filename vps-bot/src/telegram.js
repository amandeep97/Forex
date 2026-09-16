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

  /**
   * A message with buttons under it, and the message id so it can be edited.
   *
   * Used by the XAG desk, where a proposal has to be answerable from the phone.
   * `buttons` is a flat list of { text, data }; `data` comes back verbatim on
   * the callback and is how a tap is matched to the proposal it answers.
   */
  async sendWithButtons(text, buttons = []) {
    if (!this.enabled) return null;
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id: this.chatId, text, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.data }))] },
      }),
    });
    if (!res.ok) {
      console.error(`[Telegram] sendWithButtons: ${await res.text().catch(() => '')}`);
      return null;
    }
    const body = await res.json().catch(() => null);
    return body?.result?.message_id ?? null;
  }

  /**
   * Replace a message's text and take its buttons away.
   *
   * The buttons have to go once a proposal is answered. Leaving them means a
   * second tap ten minutes later tries to place the same trade again — the desk
   * refuses it, but only because it checks; a screen that still offers a button
   * is telling you something untrue about what will happen.
   */
  async editMessage(messageId, text) {
    if (!this.enabled || !messageId) return;
    await fetch(`https://api.telegram.org/bot${this.botToken}/editMessageText`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id: this.chatId, message_id: messageId, text,
        parse_mode: 'HTML', reply_markup: { inline_keyboard: [] },
      }),
    }).catch(e => console.error(`[Telegram] editMessage: ${e.message}`));
  }

  /** Clears the spinner on a tapped button, with an optional toast. */
  async answerCallback(callbackId, text = '') {
    if (!this.enabled) return;
    await fetch(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
    }).catch(e => console.error(`[Telegram] answerCallback: ${e.message}`));
  }

  /**
   * Button taps since the last call.
   *
   * Long polling is deliberately not used: this is called from the bot's tick,
   * and a call that blocks for thirty seconds waiting for a tap would hold up
   * the feed. timeout=0 returns whatever is queued and gets out of the way.
   *
   * The offset is what stops a tap being replayed forever. Telegram keeps
   * redelivering an update until it is acknowledged by asking for one after it,
   * so the desk persists this — otherwise a restart would re-process every tap
   * still in Telegram's queue and could place a trade the user answered hours
   * ago.
   */
  async getCallbacks(offset = 0) {
    if (!this.enabled) return { updates: [], nextOffset: offset };
    const url = `https://api.telegram.org/bot${this.botToken}/getUpdates`
      + `?timeout=0&allowed_updates=${encodeURIComponent('["callback_query"]')}`
      + (offset ? `&offset=${offset}` : '');
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) return { updates: [], nextOffset: offset };
    const body = await res.json().catch(() => null);
    const list = body?.result || [];
    let next = offset;
    const updates = [];
    for (const u of list) {
      next = Math.max(next, (u.update_id || 0) + 1);
      const cq = u.callback_query;
      if (!cq) continue;
      updates.push({
        id: cq.id,
        data: cq.data || '',
        messageId: cq.message?.message_id ?? null,
        from: cq.from?.id ?? null,
      });
    }
    return { updates, nextOffset: next };
  }

  tradeOpened({ pair, dir, entry, sl, tp, lots, rr, strategy, session }) {
    const arrow = dir === 'long' ? '🟢' : '🔴';
    return (
`${arrow} <b>TRADE OPENED — ${pair}</b>
📊 ${strategy} | ${session.toUpperCase()}

Direction : <b>${dir.toUpperCase()}</b>
Entry     : <code>${entry}</code>
Stop Loss : <code>${sl}</code>
Take Profit: <code>${tp}</code>
Lot Size  : <code>${lots}</code>
R:R Ratio : <code>1:${rr}</code>`
    );
  }

  tradeClosed({ pair, dir, entry, close, pnlPips, pnlUsd, rr, status }) {
    const win   = status === 'tp_hit';
    const emoji = win ? '✅' : '❌';
    const sign  = pnlUsd >= 0 ? '+' : '';
    const pipsStr = pnlPips != null ? `\nPips      : <code>${win ? '+' : ''}${Number(pnlPips).toFixed(1)}</code>` : '';
    const rrStr   = rr      != null ? `\nRR Achieved: <code>1:${Number(rr).toFixed(2)}</code>` : '';
    return (
`${emoji} <b>TRADE ${win ? 'WIN' : 'LOSS'} — ${pair}</b>

Direction : ${(dir || '').toUpperCase()}
Entry → Close: <code>${entry ?? '—'}</code> → <code>${close ?? '—'}</code>${pipsStr}
P&amp;L       : <code>$${sign}${Number(pnlUsd).toFixed(2)}</code>${rrStr}`
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

// Telegram Bot API alert
export async function sendTelegram(token, chatId, text) {
  if (!token || !chatId || !text) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Browser / PWA notification
export function showBrowserNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(reg => {
      reg.showNotification(title, {
        body,
        icon: '/forex-icon.svg',
        badge: '/forex-icon.svg',
        vibrate: [200, 100, 200],
        tag: 'forex-signal',
        renotify: true,
      });
    }).catch(() => new Notification(title, { body, icon: '/forex-icon.svg' }));
  } else {
    new Notification(title, { body, icon: '/forex-icon.svg' });
  }
}

export async function requestBrowserPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

// Grade helper
export function getGrade(quality) {
  if (quality >= 5) return 'A+';
  if (quality === 4) return 'A';
  if (quality === 3) return 'B+';
  if (quality === 2) return 'B';
  return 'C';
}

// Format a signal alert message for Telegram (HTML)
export function formatTelegramMsg(pair, signal, grade) {
  const dir = signal.dir === 'long' ? '▲ LONG' : '▼ SHORT';
  const sym = pair.replace('_', '/');
  const fmt = (n) => n != null ? n.toFixed(pair.includes('JPY') || pair.startsWith('XA') ? 3 : 5) : '—';
  return (
    `🚨 <b>${grade} Setup — ${sym} ${dir}</b>\n\n` +
    `Entry : <code>${fmt(signal.entry)}</code>\n` +
    `SL    : <code>${fmt(signal.sl)}</code>\n` +
    `TP    : <code>${fmt(signal.tp)}</code>\n` +
    `R:R   : ${signal.rr}:1\n` +
    (signal.kz ? `⚡ ${signal.kz.name} active\n` : '') +
    (signal.liqBlock ? `⚠ Liquidity block @ ${fmt(signal.liqBlock)}\n` : '')
  );
}

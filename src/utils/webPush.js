// Web Push subscription + alert sync to the VPS bot (via GitHub as the message bus).
import { ghRead, ghWrite, isGithubConfigured } from './githubSync';
import { loadAlerts } from '../hooks/useAlertsEngine';

// Public VAPID key (safe to ship). The matching PRIVATE key lives only on your VPS.
export const VAPID_PUBLIC_KEY = 'BEFdB4UhSEuInqTtUY8WTXi4Qa37fe7c4Ooc6-qTSh9PCkF1peXJP-lp_a8bxazcs6l6Wrbec3TCPNUHsS4IDws';

const SUBS_PATH   = 'bot/push-subscriptions.json';
const ALERTS_PATH = 'bot/alerts.json';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function swReady() {
  // ensure the SW is registered (main.jsx registers /Forex/sw.js)
  const reg = await navigator.serviceWorker.ready;
  return reg;
}

// Subscribe this device and store the subscription in the repo for the VPS to read.
export async function enableBackgroundPush() {
  if (!pushSupported()) return { ok: false, msg: 'Push not supported on this browser' };
  if (!isGithubConfigured()) return { ok: false, msg: 'Connect GitHub (Settings → not set) so the VPS can read your subscription' };

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, msg: 'Notification permission denied' };

  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  const subJson = sub.toJSON();

  // Merge into the stored list (keyed by endpoint) so multiple devices work.
  let existing = null, sha = null;
  try { const r = await ghRead(SUBS_PATH, { noCache: true }); existing = r?.content; sha = r?.sha; } catch {}
  const list = Array.isArray(existing?.subscriptions) ? existing.subscriptions : [];
  const filtered = list.filter(s => s.endpoint !== subJson.endpoint);
  filtered.push({ ...subJson, ua: navigator.userAgent.slice(0, 80), addedAt: new Date().toISOString() });

  await ghWrite(SUBS_PATH, { subscriptions: filtered }, 'app: register push subscription', sha);
  localStorage.setItem('push_enabled', '1');
  // push current alerts up too so the VPS has something to watch
  await syncAlertsToBot().catch(() => {});
  return { ok: true, msg: 'Background push enabled — the VPS will now alert this device' };
}

export async function disableBackgroundPush() {
  try {
    const reg = await swReady();
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const ep = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      try {
        const r = await ghRead(SUBS_PATH, { noCache: true });
        const list = (r?.content?.subscriptions || []).filter(s => s.endpoint !== ep);
        await ghWrite(SUBS_PATH, { subscriptions: list }, 'app: remove push subscription', r?.sha);
      } catch {}
    }
  } catch {}
  localStorage.removeItem('push_enabled');
  return { ok: true, msg: 'Background push disabled on this device' };
}

export function isPushEnabled() { return localStorage.getItem('push_enabled') === '1'; }

// Push the current alert list to the repo so the VPS bot watches them 24/7.
export async function syncAlertsToBot() {
  if (!isGithubConfigured()) return { ok: false, msg: 'GitHub not connected' };
  let sha = null;
  try { const r = await ghRead(ALERTS_PATH, { noCache: true }); sha = r?.sha; } catch {}
  const alerts = loadAlerts();
  await ghWrite(ALERTS_PATH, { alerts, updatedAt: new Date().toISOString() }, 'app: sync alerts to bot', sha);
  return { ok: true, msg: `Synced ${alerts.length} alert(s) to your VPS` };
}

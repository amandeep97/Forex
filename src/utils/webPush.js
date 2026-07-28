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

// Is this running as an installed app rather than a browser tab?
export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Why push cannot be enabled, specifically enough to act on.
// On iOS the Push API exists ONLY in a Home Screen install — in a Safari tab
// PushManager is undefined, so subscription can never happen no matter what the
// server is doing. Saying merely "not supported" sent people looking in the
// wrong place.
export function pushBlockedReason() {
  if (pushSupported()) return null;
  if (isIOS() && !isStandalone()) return {
    code: 'ios-not-installed',
    title: 'Add to Home Screen first',
    detail: 'On iPhone, background notifications only work when this is installed as an app. '
          + 'Tap Share → Add to Home Screen, open it from the icon, then enable push here. '
          + 'It cannot work in a Safari tab.',
  };
  if (isIOS()) return {
    code: 'ios-old',
    title: 'iOS 16.4 or later required',
    detail: 'Web push arrived in iOS 16.4. Update iOS, then try again from the installed app.',
  };
  return { code:'unsupported', title:'Not supported by this browser',
           detail:'This browser has no Push API. Chrome, Edge, Firefox and installed iOS PWAs support it.' };
}

async function swReady() {
  // ensure the SW is registered (main.jsx registers /Forex/sw.js)
  const reg = await navigator.serviceWorker.ready;
  return reg;
}

// Subscribe this device and store the subscription in the repo for the VPS to read.
export async function enableBackgroundPush() {
  if (!pushSupported()) {
    const r = pushBlockedReason();
    return { ok: false, msg: `${r.title} — ${r.detail}` };
  }
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

// Optimistic flag, kept for instant UI paint. It records only that push was
// enabled at some point — never that it still works. Use verifyPush() for truth.
export function isPushEnabled() { return localStorage.getItem('push_enabled') === '1'; }

// Does a live subscription actually exist, and does the VPS still hold it?
//
// iOS silently expires push subscriptions for installed PWAs that go unopened
// for a while. The VPS then receives 404/410 and correctly prunes the endpoint —
// but nothing told the app, which kept reporting push as enabled because its own
// flag was still set. Notifications simply stopped, and the only symptom was
// alerts appearing in-app the next time the PWA was opened.
export async function verifyPush() {
  if (!pushSupported()) return { ok:false, state:'unsupported', reason: pushBlockedReason() };
  const flagged = isPushEnabled();

  let sub = null;
  try { sub = await (await swReady()).pushManager.getSubscription(); } catch {}
  if (!sub) {
    if (flagged) localStorage.removeItem('push_enabled');
    return { ok:false, state: flagged ? 'expired' : 'off',
             msg: flagged ? 'The browser dropped this device\u2019s subscription — re-enable to restore background alerts.' : null };
  }

  // A local subscription is not enough: the VPS must still have it on file.
  try {
    const r = await ghRead(SUBS_PATH, { noCache: true });
    const list = r?.content?.subscriptions || [];
    const known = list.some(x => x.endpoint === sub.toJSON().endpoint);
    if (!known) return { ok:false, state:'orphaned',
      msg: 'This device is subscribed but the VPS no longer has it — it was pruned after failing to deliver. Re-register to fix.' };
  } catch {
    return { ok:true, state:'unverified', msg:'Subscribed, but the VPS list could not be read to confirm.' };
  }
  return { ok:true, state:'active' };
}

// Re-register this device without the user having to toggle anything off/on.
export async function repairPush() {
  localStorage.removeItem('push_enabled');
  try { const s = await (await swReady()).pushManager.getSubscription(); if (s) await s.unsubscribe().catch(() => {}); } catch {}
  return enableBackgroundPush();
}

// Push the current alert list to the repo so the VPS bot watches them 24/7.
export async function syncAlertsToBot() {
  if (!isGithubConfigured()) return { ok: false, msg: 'GitHub not connected' };
  let sha = null;
  try { const r = await ghRead(ALERTS_PATH, { noCache: true }); sha = r?.sha; } catch {}
  const alerts = loadAlerts();
  await ghWrite(ALERTS_PATH, { alerts, updatedAt: new Date().toISOString() }, 'app: sync alerts to bot', sha);
  return { ok: true, msg: `Synced ${alerts.length} alert(s) to your VPS` };
}

'use strict';
// vps-bot/src/push.js
// Web Push delivery — the one place the bot talks to a device.
//
// Two things need it now: the alert checker and the live feed notifier. Keeping
// a copy in each would mean two places to get VAPID setup wrong and two
// definitions of what a dead subscription is, and dead ones matter — an
// installed iOS PWA that goes unopened has its subscription expired by the
// system, and if 404/410 responses are not pruned the list grows stale until
// nothing anyone can see explains why alerts stopped.

let webpush = null;
try { webpush = require('web-push'); } catch { /* installed during setup */ }

let configured = false;

function configurePush(env) {
  if (!webpush || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  if (!configured) {
    webpush.setVapidDetails(
      env.VAPID_SUBJECT || 'mailto:alerts@forexpro.app',
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
    );
    configured = true;
  }
  return true;
}

const pushReady = () => configured;

// Returns the endpoints that are gone for good, so the caller can prune them.
// A delivery failure that is NOT 404/410 (a timeout, a 500 from the push
// service) is deliberately not treated as death — dropping a live device
// because a push server hiccuped is how notifications silently stop.
async function sendPush(subs, title, body) {
  if (!configured || !subs || !subs.length) return { dead: [], sent: 0 };
  let sent = 0;
  const dead = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s, JSON.stringify({ title, body }));
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint);
    }
  }));
  return { dead, sent };
}

module.exports = { configurePush, pushReady, sendPush };

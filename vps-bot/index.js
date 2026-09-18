'use strict';
require('dotenv').config();
const { ForexBot } = require('./src/bot');

const INTERVAL = parseInt(process.env.BOT_INTERVAL_MS) || 60_000;
const bot = new ForexBot(process.env);

const stamp = () => new Date().toISOString();

// ── Why this process keeps dying ────────────────────────────────────────────
//
// pm2 reports 11,207 restarts, and bot/vps-version.json shows bootedAt moving
// every 60 to 90 seconds with `behind: 0` every time — so it is not the updater
// pulling new code. It is one restart per tick, near enough, and it has been
// quietly breaking everything that needs longer than a minute to finish: the
// level refresh never got round all forty instruments, the liquidity study
// restarted from the first instrument on every pass, and the alert dedup forgot
// what it had sent and mailed the same sweep out a hundred times.
//
// tick() already catches its own errors, so a failing request cannot be it. The
// gap was everything OUTSIDE that try block. Node's default for an unhandled
// promise rejection is to print and EXIT, and this file installed no handler —
// so one floating promise anywhere in the tree, on any transient ECONNRESET
// from OANDA or socket hang up from GitHub (both of which are in the log),
// killed the process. pm2 dutifully started it again, the run lasted longer
// than min_uptime, and `unstable restarts` stayed at 0 the whole time. Nothing
// looked wrong.
//
// So both are caught here and NEITHER exits. That is the unconventional choice
// for uncaughtException, where the usual advice is to die because state may be
// corrupt — but the alternative on this box is a restart every minute, which is
// a worse and much quieter kind of broken. The error is logged in full, with a
// stack, and counted, so this cannot become a way of hiding faults: if the
// counter climbs, something real is wrong and the log says what.
let softFailures = 0;
function survive(kind, e) {
  softFailures++;
  console.error(`[${stamp()}] ${kind} (#${softFailures}) — staying up:`,
    e?.stack || e?.message || e);
}
process.on('unhandledRejection', e => survive('Unhandled rejection', e));
process.on('uncaughtException', e => survive('Uncaught exception', e));

// Exiting on a signal should still be quick and quiet, so pm2 restarts and
// stops are not mistaken for the crashes above.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { console.log(`[${stamp()}] ${sig} — shutting down`); process.exit(0); });
}

async function tick() {
  try {
    await bot.run();
  } catch (e) {
    // Not fatal, and it never was — this is caught and the process continues.
    // The word was left over from a version that did exit here, and it sent
    // every reader looking for a crash that was not happening.
    console.error(`[${stamp()}] Tick error:`, e.message);
  }
}

console.log(`[${new Date().toISOString()}] ForexPro VPS Bot starting — interval ${INTERVAL / 1000}s`);
tick(); // run immediately on start
setInterval(tick, INTERVAL);

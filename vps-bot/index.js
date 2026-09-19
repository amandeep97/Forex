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

// ── Why a signal has to be logged SYNCHRONOUSLY ─────────────────────────────
//
// This was `console.log(...); process.exit(0)`. console.log to a PIPE — which
// is what pm2 gives a managed process — is asynchronous on POSIX, and
// process.exit() does not wait for it, so the line CAN be discarded before it
// lands. Tested directly and a single short write did survive, so this is not
// proven to be what happened here; it is simply not something to rely on when
// the line in question is the only record of how the process died.
//
// The reason it matters: this bot restarts every five minutes with no logged
// cause at all. Not the updater — its one exit line in eight hundred lines of
// log is a genuine update. Not pm2's SIGINT, which stopped appearing after the
// memory ceiling was raised. Something ends the process and leaves nothing
// behind, so the record of it has to be as hard to lose as possible.
//
// fs.writeSync to fd 2 cannot be truncated by the exit that follows it, and
// the memory at the moment of the signal is the number that settles whether a
// ceiling was crossed. The tick-end reading cannot: it is taken after a
// collection and shows the trough, not the peak that pm2 would have sampled.
//
// SIGHUP is added because it is the one ordinary way a process is asked to
// leave that nothing here was listening for.
const fs = require('node:fs');
const path = require('node:path');

// ── A black box, so nobody has to read a log again ──────────────────────────
//
// Diagnosing why this process keeps restarting has cost hours of "run this,
// paste the output", and every one of those round trips went through someone's
// phone. It should never have needed a human. The process knows how it died;
// it just had nowhere durable to write it.
//
// So the last moments are recorded to a LOCAL file, synchronously, and the next
// boot picks it up and publishes it to bot/vps-version.json before deleting it.
// Synchronous because an exiting process cannot be trusted to finish a network
// call, and local-then-forward because the one thing it definitely can do is
// write a small file.
//
// The absence of the file is itself the diagnosis, and it is the answer that
// has been missing all along: if a boot finds no record, the previous process
// did not receive a signal and did not throw. It was SIGKILLed — the OOM
// killer, or something calling kill -9 — and no amount of logging inside the
// process could ever have shown that.
const BLACK_BOX = path.join(__dirname, '.last-shutdown.json');

function recordShutdown(how, extra = {}) {
  const m = process.memoryUsage();
  const mb = v => Math.round(v / 1048576);
  const rec = {
    how, at: stamp(),
    rssMB: mb(m.rss), heapMB: mb(m.heapUsed), extMB: mb(m.external),
    uptimeS: Math.round(process.uptime()),
    softFailures,
    ...extra,
  };
  try { fs.writeFileSync(BLACK_BOX, JSON.stringify(rec)); } catch { /* best effort */ }
  try {
    fs.writeSync(2, `[${rec.at}] ${how} — shutting down · rss ${rec.rssMB}MB `
      + `heap ${rec.heapMB} ext ${rec.extMB} · up ${rec.uptimeS}s · soft ${softFailures}\n`);
  } catch { /* a closed fd at shutdown must not mask the signal itself */ }
  return rec;
}

/** Read and clear the previous process's record. Null means it was killed. */
function takeShutdownRecord() {
  try {
    const raw = fs.readFileSync(BLACK_BOX, 'utf8');
    fs.unlinkSync(BLACK_BOX);
    return JSON.parse(raw);
  } catch { return null; }
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { recordShutdown(sig); process.exit(0); });
}
// A deliberate exit — the updater restarting into new code — is recorded too,
// so a planned restart is never mistaken for an unexplained one.
process.on('exit', code => {
  try {
    if (!fs.existsSync(BLACK_BOX)) recordShutdown(`exit(${code})`);
  } catch { /* nothing left to do at this point */ }
});

bot.lastShutdown = takeShutdownRecord();

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

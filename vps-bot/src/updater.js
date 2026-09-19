'use strict';
// vps-bot/src/updater.js
// The bot updates itself, so shipping bot code stops meaning "go SSH into the box".
//
// Every change to the bot until now needed someone at a terminal running
// git pull && pm2 restart. That is a bad deal: the person who wrote the change
// knows it shipped, and the person running the machine finds out when something
// quietly does not work.
//
// How it restarts: it does not. It exits, and pm2 (autorestart: true) starts it
// again with the new code. Trying to restart yourself from inside the process
// you are restarting is a good way to end up with none running.
//
// What it will NOT do, on purpose:
//   - pull over local modifications — someone editing on the server is telling
//     you something, and overwriting that is how you lose a hotfix
//   - merge, rebase or force anything — fast-forward only
//   - follow a different branch than the one already checked out
// Any of those refusals is logged with the reason rather than failing silently.

const { execFile } = require('child_process');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const VERSION_PATH = 'bot/vps-version.json';

// git puts the actual failure in one line and then several paragraphs of hints.
// Those hints end up in the app as "last error", where a wall of advice about
// rebasing is strictly less useful than the single fatal line.
function gitError(stderr, fallback) {
  const lines = (stderr || '').split('\n').map(l => l.trim()).filter(Boolean);
  const fatal = lines.find(l => /^(fatal|error):/i.test(l));
  const useful = fatal || lines.find(l => !/^hint:/i.test(l));
  return (useful || fallback || 'git failed').replace(/^(fatal|error):\s*/i, '').slice(0, 200);
}

function git(args, cwd, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(gitError(stderr, err.message)));
      resolve(stdout.trim());
    });
  });
}

async function npmInstall(cwd, timeout = 300_000) {
  return new Promise((resolve, reject) => {
    execFile('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd, timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().slice(0, 300)));
        resolve(stdout.trim());
      });
  });
}

const sha = s => (s || '').slice(0, 7);

class Updater {
  constructor({ github, log, env = {}, repo = REPO }) {
    this.github = github;
    this.log = log || (() => {});
    this.repo = repo;
    this.enabled = env.BOT_AUTO_UPDATE !== 'false';
    // One seam, so the restart decision can be tested without a repo. The
    // interesting cases here are a merge that moves HEAD and a merge that does
    // not — the difference between updating and looping forever — and neither
    // is reachable from outside without standing in for git.
    this.git = git;
    this.intervalMs = (parseInt(env.BOT_UPDATE_CHECK_MIN, 10) || 15) * 60_000;
    this.checkedAt = 0;
    this.sha = null;
    this.branch = null;
    this.versionSha = null;
    this.lastError = null;
  }

  async _identify() {
    this.sha = await this.git(['rev-parse', 'HEAD'], this.repo);
    this.branch = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], this.repo);
    return { sha: this.sha, branch: this.branch };
  }

  // Publish what the VPS is actually running. Without this there is no way to
  // tell from the app whether the bot has your latest code or is three weeks
  // behind quietly doing the old thing.
  async publish(extra = {}) {
    try {
      if (!this.sha) await this._identify();
      const behind = await this._behind().catch(() => null);
      const payload = {
        sha: this.sha,
        short: sha(this.sha),
        branch: this.branch,
        behind,
        autoUpdate: this.enabled,
        checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
        bootedAt: this.bootedAt || (this.bootedAt = new Date().toISOString()),
        lastError: this.lastError,
        // The last tick's memory breakdown, so a restart loop can be diagnosed
        // from the published file instead of over someone's shoulder.
        mem: this.mem || null,
        // How the PREVIOUS process died, recorded by it and carried here by
        // this one. `null` is not missing data — it means no signal and no
        // throw, which is to say it was killed outright.
        lastShutdown: this.lastShutdown === undefined ? null : this.lastShutdown,
        ...extra,
      };
      const cur = await this.github.readJSON(VERSION_PATH).catch(() => null);
      // Do not commit an identical file every tick. bootedAt is compared too:
      // the publish that precedes a self-update restart is written by the OLD
      // process and therefore carries the OLD boot time, so without this the
      // file would keep claiming an uptime that ended minutes ago.
      const same = cur?.content && ['sha', 'behind', 'autoUpdate', 'lastError', 'bootedAt', 'mem', 'lastShutdown']
        .every(k => JSON.stringify(cur.content[k]) === JSON.stringify(payload[k]));
      if (same) return;
      this.versionSha = await this.github.writeJSON(
        VERSION_PATH, payload, `bot: running ${sha(this.sha)}`, cur?.sha || this.versionSha);
    } catch (e) { this.log(`Updater: could not publish version (${e.message})`); }
  }

  async _behind() {
    const upstream = `origin/${this.branch}`;
    const out = await this.git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], this.repo);
    const [, ahead] = out.split(/\s+/).map(Number);   // right side = commits we lack
    return Number.isFinite(ahead) ? ahead : null;
  }

  async _dirty() {
    const out = await this.git(['status', '--porcelain', '--untracked-files=no'], this.repo);
    return out ? out.split('\n').filter(Boolean) : [];
  }

  // Returns { updated, from, to, reason }
  async update({ force = false } = {}) {
    if (!this.sha) await this._identify();

    const dirty = await this._dirty();
    if (dirty.length) {
      const reason = `local changes on the VPS (${dirty.length} file(s)) — refusing to overwrite them`;
      this.lastError = reason;
      this.log(`Updater: ${reason}`);
      await this.publish();
      return { updated: false, reason };
    }

    await this.git(['fetch', 'origin', this.branch], this.repo, 120_000);
    const behind = await this._behind();
    if (!behind && !force) {
      this.checkedAt = Date.now();
      this.lastError = null;
      return { updated: false, reason: 'already up to date', from: sha(this.sha) };
    }

    const from = this.sha;

    try {
      await this.git(['merge', '--ff-only', `origin/${this.branch}`], this.repo, 120_000);
    } catch (e) {
      // Not fast-forwardable means the branch history diverged — a human
      // decision, not something to resolve automatically at 3am.
      this.lastError = `cannot fast-forward: ${e.message}`;
      this.log(`Updater: ${this.lastError}`);
      await this.publish();
      return { updated: false, reason: this.lastError };
    }

    const to = await this.git(['rev-parse', 'HEAD'], this.repo);
    this.sha = to;
    this.checkedAt = Date.now();
    this.lastError = null;

    // ── Never restart into the same commit ──────────────────────────────────
    //
    // This is what was restarting the bot every five minutes — the update check
    // interval — with the SAME sha each time, for as long as anyone has looked.
    //
    // `behind` decides whether to attempt a merge, and nothing checked whether
    // the merge actually moved anything. When it reported a non-zero count but
    // the fast-forward was a no-op — a stale remote-tracking ref, a fetch that
    // half-failed, a ref that could not be locked because the bot and a human
    // fetched at the same moment, all of which are in this bot's logs — `from`
    // and `to` came back identical and it exited anyway. pm2 restarted it, the
    // next check came round, and it did it again. Restarting into identical
    // code cannot fix anything, so it can only loop.
    //
    // It hid well: a clean exit(0) keeps pm2's `unstable restarts` at 0, and
    // the published file showed `behind: 0` because publish recomputes it after
    // the merge. Every dashboard said healthy while nothing that took longer
    // than five minutes could finish.
    if (to === from) {
      const reason = `git said ${behind} commit(s) behind but the merge changed nothing`;
      this.lastError = reason;
      this.log(`Updater: ${reason} — not restarting`);
      await this.publish();
      return { updated: false, reason, from: sha(from) };
    }

    // Ask git what actually changed rather than comparing file sizes — a
    // dependency bump that happens to keep the byte count identical would
    // otherwise restart into a tree missing the module it now needs.
    const depsChanged = await this.git(
      ['diff', '--name-only', `${from}..${to}`, '--', 'vps-bot/package.json', 'vps-bot/package-lock.json'],
      this.repo).catch(() => '');

    if (depsChanged) {
      this.log('Updater: dependencies changed — installing');
      try { await npmInstall(path.join(this.repo, 'vps-bot')); }
      catch (e) {
        // Exiting now would restart into a half-installed tree and crash-loop.
        this.lastError = `npm install failed: ${e.message}`;
        this.log(`Updater: ${this.lastError} — staying on the old process`);
        await this.publish({ pendingRestart: true });
        return { updated: true, restart: false, from: sha(from), to: sha(to), reason: this.lastError };
      }
    }

    this.log(`Updater: ${sha(from)} → ${sha(to)} (${behind} commit(s)) — restarting`);
    await this.publish({ restartingInto: sha(to) });
    return { updated: true, restart: true, from: sha(from), to: sha(to) };
  }

  // pm2 brings the process back with the new code. A short delay lets the
  // version file finish writing and any in-flight log lines flush.
  restart() {
    this.log('Updater: exiting for pm2 to restart with the new code');
    setTimeout(() => process.exit(0), 1500);
  }

  dueForCheck() {
    return this.enabled && Date.now() - this.checkedAt > this.intervalMs;
  }
}

module.exports = { Updater, VERSION_PATH };

'use strict';
// The self-updater — vps-bot/src/updater.js.
//
// This restarted the bot every five minutes, with the same commit each time,
// for as long as anyone had looked. Over eleven thousand restarts. Nothing
// that took longer than five minutes could finish: the hourly level refresh
// never got round forty instruments, the liquidity study began again at the
// first one on every pass, and the alert dedup forgot what it had sent.
//
// The decision to restart was made from `behind`, the count git reports, and
// nothing checked whether the merge that followed had actually moved anything.
const { Updater } = require('../vps-bot/src/updater');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * An updater with git stubbed at the seams.
 *
 * `from` is where HEAD starts and `to` is what rev-parse reports after the
 * merge, named separately rather than as a list: the first version walked one
 * array for both, `_identify` read the head without consuming it, and the
 * merge-moved-HEAD case silently became the merge-did-nothing case — a test
 * that passed for the wrong reason and proved nothing about the fix.
 */
function mk({ behind = 0, from = SHA_A, to = SHA_A, dirty = '' } = {}) {
  const u = new Updater({
    github: { async readJSON() { return null; }, async writeJSON() { return 'x'; } },
    env: {}, log: () => {},
  });
  u._identify = async () => { u.sha = from; u.branch = 'dev'; return { sha: from, branch: 'dev' }; };
  u._behind = async () => behind;
  u._dirty = async () => (dirty ? [dirty] : []);
  u.publish = async () => {};
  u.restarted = false;
  u.restart = () => { u.restarted = true; };
  // Stand in for git: fetch and merge do nothing, rev-parse walks the list.
  u.git = async args => (args[0] === 'rev-parse' ? to : '');
  return u;
}

(async () => {
  // The loop. Non-zero behind, merge changes nothing, and it exits anyway.
  {
    const u = mk({ behind: 3, from: SHA_A, to: SHA_A });
    const r = await u.update().catch(e => ({ error: e.message }));
    check('a merge that changes nothing does not trigger a restart',
      r && r.updated === false && !u.restarted,
      JSON.stringify(r?.reason || r?.error || r),
      'restarting into identical code cannot fix anything, so it can only loop');
    check('and it says why, rather than reporting success',
      /changed nothing/.test(r?.reason || ''), r?.reason);
  }

  // A real update still restarts — the fix must not disarm the updater.
  {
    const u = mk({ behind: 2, from: SHA_A, to: SHA_B });
    const r = await u.update().catch(e => ({ error: e.message }));
    check('a merge that DOES move HEAD still updates and restarts',
      r && r.updated === true && r.restart === true,
      JSON.stringify(r?.reason || r),
      'the point is to stop a loop, not to stop updating');
  }

  // Nothing to do at all is unchanged.
  {
    const u = mk({ behind: 0 });
    const r = await u.update().catch(e => ({ error: e.message }));
    check('already up to date is still a quiet no-op',
      r && r.updated === false && !u.restarted && /up to date/.test(r.reason || ''),
      r?.reason);
  }

  // Local edits on the VPS still stop it before anything is overwritten.
  {
    const u = mk({ behind: 5, dirty: 'src/bot.js' });
    const r = await u.update().catch(e => ({ error: e.message }));
    check('local changes on the box still refuse the update',
      r && r.updated === false && !u.restarted && /local changes/.test(r.reason || ''),
      r?.reason);
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

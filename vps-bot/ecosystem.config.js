module.exports = {
  apps: [{
    name: 'forex-bot',
    script: 'index.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    // ── The ceiling that was restarting this bot 11,207 times ──────────────
    //
    // 256M was below what one ordinary tick allocates. Measured on the box:
    // the process climbs from ~62MB to ~288MB within a minute or two, pm2
    // SIGINTs it for crossing 256, and it starts over — about one restart per
    // tick, for months. Everything needing longer than a minute to finish was
    // quietly broken by it: the hourly level refresh never got round all forty
    // instruments, the liquidity study restarted from the first instrument on
    // every pass, and the alert dedup forgot what it had sent and mailed one
    // sweep out more than a hundred times.
    //
    // Nothing reported it. pm2 restarted it, each run outlived min_uptime, and
    // `unstable restarts` stayed at 0 throughout.
    //
    // Two changes, and the second is the one that matters. Raising the ceiling
    // alone would only move the wall. node_args caps V8's old space at 400MB,
    // which makes it collect as it approaches that instead of letting RSS drift
    // up because the machine has spare memory — the actual reason it reached
    // 288MB. The pm2 ceiling then sits above it as a backstop for a real leak
    // rather than as a routine occurrence. Sibling processes on this box run at
    // 300MB+ without trouble, so there is room for both.
    node_args: '--max-old-space-size=400',
    max_memory_restart: '640M',
    // Keep a restart loop visible if one ever returns: pm2 gives up after this
    // many failures inside min_uptime and marks the app errored, which is a
    // state that shows up rather than one that hides.
    min_uptime: '30s',
    max_restarts: 20,
    env: { NODE_ENV: 'production' },
    error_file: 'logs/error.log',
    out_file:   'logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    cron_restart: '0 0 * * 1',
  }],
};

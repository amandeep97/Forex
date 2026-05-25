module.exports = {
  apps: [{
    name: 'forex-bot',
    script: 'index.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: { NODE_ENV: 'production' },
    error_file: 'logs/error.log',
    out_file:   'logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // Restart once per week (Monday midnight)
    cron_restart: '0 0 * * 1',
  }],
};

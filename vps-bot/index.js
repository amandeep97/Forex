'use strict';
require('dotenv').config();
const { ForexBot } = require('./src/bot');

const INTERVAL = parseInt(process.env.BOT_INTERVAL_MS) || 60_000;
const bot = new ForexBot(process.env);

async function tick() {
  try {
    await bot.run();
  } catch (e) {
    console.error(`[${new Date().toISOString()}] FATAL tick error:`, e.message);
  }
}

console.log(`[${new Date().toISOString()}] ForexPro VPS Bot starting — interval ${INTERVAL / 1000}s`);
tick(); // run immediately on start
setInterval(tick, INTERVAL);

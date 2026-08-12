'use strict';
// vps-bot/study.js
// Run the confluence study and publish the answer.
//
//   node vps-bot/study.js            # run, print, publish to bot/confluence-study.json
//   node vps-bot/study.js --dry      # run and print, publish nothing
//
// This runs on the VPS because that is where the candles are. The app cannot
// do it: the published feed carries forty closes per instrument for drawing a
// sparkline, not the four hundred daily bars this needs, and putting them there
// would triple a file that is already over a megabyte.
//
// It answers one question — does the forward edge increase with the number of
// agreeing families — and writes a small result the app can read.

const path = require('path');
const { pathToFileURL } = require('url');
const fetch = require('node-fetch');
const { INSTRUMENTS } = require('./src/instruments');
const { GitHubClient } = require('./src/github');
const { OandaClient } = require('./src/oanda');
const { fetchCOTHistory } = require('./src/cotFetcher');
const S = require('./src/confluenceStudy');

const REPO_ROOT = path.join(__dirname, '..');
const OUT_PATH = 'bot/confluence-study.json';
const BARS = 400;

const log = (...a) => console.log(...a);

async function candles(inst, oanda) {
  const host = inst.binance ? 'https://api.binance.com/api/v3'
             : inst.bfut    ? 'https://fapi.binance.com/fapi/v1'
             : null;
  if (host) {
    const ticker = inst.binance || inst.bfut;
    const r = await fetch(`${host}/klines?symbol=${ticker}&interval=1d&limit=${BARS}`, { timeout: 20000 });
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    const d = await r.json();
    return d.slice(0, -1).map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
  }
  return oanda.getCandles(inst.oanda, 'D', BARS);
}

// Three years of weekly positioning, as a percentile of its own history so it
// is comparable across instruments. Best effort: an instrument without a COT
// code, or a fetch that fails, simply has no positioning family.
async function cotSeries(inst) {
  if (!inst.cot) return null;
  try {
    const rows = await fetchCOTHistory(inst.cot, 160);
    if (rows.length < 60) return null;
    // The percentile at each point uses only the readings that existed BY then.
    // Ranking every week against the full three years would let a reading know
    // how extreme it would turn out to be, which is the whole error this study
    // is meant to avoid.
    return rows.map((r, i) => {
      const hist = rows.slice(0, i + 1).map(x => x.net);
      if (hist.length < 40) return null;
      const pct = (hist.filter(x => x < r.net).length / hist.length) * 100;
      return { t: r.t, val: pct };
    }).filter(Boolean);
  } catch { return null; }
}

async function main() {
  const dry = process.argv.includes('--dry');
  const macro = S.loadMacro(REPO_ROOT);
  log(macro ? `macro series: ${Object.keys(macro).join(', ')}` : 'no macro data found');

  const patternsMod = await import(pathToFileURL(
    path.join(REPO_ROOT, 'src', 'utils', 'candlePatterns.js')).href);
  const patternsAt = patternsMod.patternsAt;

  const oanda = new OandaClient({
    apiKey: process.env.OANDA_API_KEY,
    accountId: process.env.OANDA_ACCOUNT_ID,
    practice: process.env.OANDA_ENV !== 'live',
  });

  const rows = [];
  const baseline = [];
  const perClass = {};
  let done = 0, failed = 0;

  for (const inst of INSTRUMENTS) {
    try {
      const cs = await candles(inst, oanda);
      if (!cs || cs.length < 140) { failed++; continue; }
      const cot = await cotSeries(inst);
      const r = S.scanInstrument({ cs, sym: inst.sym, cls: inst.cls, macro, cot, patternsAt });
      const b = S.baselineRows(cs);
      rows.push(...r);
      baseline.push(...b);
      (perClass[inst.cls] ||= { rows: [], base: [] });
      perClass[inst.cls].rows.push(...r);
      perClass[inst.cls].base.push(...b);
      done++;
      if (done % 10 === 0) log(`  ${done} instruments scanned…`);
    } catch (e) {
      failed++;
      log(`  ${inst.sym}: ${e.message}`);
    }
  }

  log(`\nscanned ${done} instruments (${failed} skipped) → ${rows.length} scored bars, ${baseline.length} baseline bars`);

  const overall = S.summarise(rows, baseline);
  const v = S.verdict(overall);

  log('\nagreeing families → forward edge over the market, 10 days out\n');
  log('  n agree |     n | setup | market |  edge |     z');
  for (const b of overall) {
    if (b.tooFew) { log(`  ${b.agree.padEnd(7)} | ${String(b.n).padStart(5)} | too few to judge`); continue; }
    log(`  ${b.agree.padEnd(7)} | ${String(b.n).padStart(5)} | ${String(b.win).padStart(5)} | ${String(b.baseWin).padStart(6)} | ${(b.edgeWin > 0 ? '+' : '') + b.edgeWin} | ${String(b.z).padStart(5)}`);
  }
  log(`\nverdict: ${v.supported ? 'CONFLUENCE HOLDS' : 'NOT SUPPORTED'} — ${v.reason}`);

  const byClass = {};
  for (const [cls, d] of Object.entries(perClass)) {
    if (d.rows.length < 200) continue;
    byClass[cls] = { summary: S.summarise(d.rows, d.base), verdict: S.verdict(S.summarise(d.rows, d.base)) };
  }

  const payload = {
    version: 1,
    ranAt: new Date().toISOString(),
    horizonBars: S.HORIZON,
    instruments: done,
    scoredBars: rows.length,
    baselineBars: baseline.length,
    overall,
    verdict: v,
    byClass,
    // Stated so a reader can see what the study could and could not look at.
    families: ['price', 'structure', 'volatility', 'fundamental', 'positioning'],
    missing: ['news — only 8 days are retained, so there is no history to measure',
              'cross-asset — leadership has no stored history'],
  };

  if (dry) { log('\n--dry: not publishing'); return; }
  const gh = new GitHubClient({
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER || 'amandeep97',
    repo:  process.env.GITHUB_REPO  || 'Forex',
    branch: process.env.GITHUB_BRANCH || 'main',
  });
  const sha = await gh.readSha(OUT_PATH);
  await gh.writeJSON(OUT_PATH, payload, 'bot: confluence study', sha);
  log(`\npublished to ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });

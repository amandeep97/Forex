#!/usr/bin/env node
// Fetches live metal, index, and energy prices and writes prices.json.
// Runs server-side (GitHub Actions) — no CORS restrictions.
// Usage: node scripts/fetch-prices.js [output-path]
//        Default output: public/prices.json

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const OUT = process.argv[2] || path.join(__dirname, '..', 'public', 'prices.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function get(url, timeoutMs = 8000) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, */*',
      },
    }, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location, timeoutMs));
      }
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

// ── Metals via CryptoCompare (XAU XAG XPT XPD) + Yahoo futures ───────────────
async function fetchMetals() {
  const out = {};

  // Primary: CryptoCompare — precious metals
  const cc = await get('https://min-api.cryptocompare.com/data/pricemulti?fsyms=XAU,XAG,XPT,XPD&tsyms=USD');
  if (cc) {
    if (cc.XAU?.USD) out['XAU/USD'] = cc.XAU.USD;
    if (cc.XAG?.USD) out['XAG/USD'] = cc.XAG.USD;
    if (cc.XPT?.USD) out['XPT/USD'] = cc.XPT.USD;
    if (cc.XPD?.USD) out['XPD/USD'] = cc.XPD.USD;
  }

  // Backup / base metals: Yahoo Finance futures (server-side works fine)
  const yfMetals = {
    'GC%3DF': 'XAU/USD',   // Gold futures
    'SI%3DF': 'XAG/USD',   // Silver futures
    'PL%3DF': 'XPT/USD',   // Platinum futures
    'PA%3DF': 'XPD/USD',   // Palladium futures
    'HG%3DF': 'XCU/USD',   // Copper futures (USD/lb)
  };
  await Promise.all(Object.entries(yfMetals).map(async ([sym, key]) => {
    if (out[key]) return; // already have it from CryptoCompare
    const d = await get(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`);
    const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (p != null) out[key] = p;
  }));

  return out;
}

// ── Indices + Energy via Yahoo Finance ────────────────────────────────────────
const YF_MARKETS = {
  '%5EGSPC':    'US500',   '%5EDJI':    'US30',    '%5ENDX':   'US100',
  '%5ERUT':     'US2000',  '%5EFTSE':   'UK100',   '%5EGDAXI': 'GER40',
  '%5EFCHI':    'FRA40',   '%5EIBEX':   'ESP35',   '%5EN225':  'JPN225',
  '%5EAXJO':    'AUS200',  '%5EHSI':    'HKG50',   '000300.SS':'CHN50',
  'CL%3DF':     'USOIL',   'BZ%3DF':    'UKOIL',   'NG%3DF':   'NATGAS',
  'HO%3DF':     'HEATOIL', 'RB%3DF':    'RBOB',
};

async function fetchMarkets() {
  const results = await Promise.all(
    Object.entries(YF_MARKETS).map(async ([sym, key]) => {
      const d = await get(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`);
      const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      return { key, price: p ?? null };
    })
  );
  const out = {};
  results.forEach(({ key, price }) => { if (price != null) out[key] = price; });
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('[fetch-prices] Starting...');

  const [metals, markets] = await Promise.all([fetchMetals(), fetchMarkets()]);

  const payload = {
    timestamp: new Date().toISOString(),
    metals,
    markets,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  const mCount  = Object.keys(metals).length;
  const mkCount = Object.keys(markets).length;
  console.log(`[fetch-prices] Done — ${mCount} metals, ${mkCount} indices/energy → ${OUT}`);
})();

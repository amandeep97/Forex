'use strict';
const https = require('https');

const COT_CODES = [
  { key:'EUR', code:'099741', invert:false },
  { key:'GBP', code:'096742', invert:false },
  { key:'JPY', code:'097741', invert:true  },
  { key:'AUD', code:'232741', invert:false },
  { key:'CAD', code:'090741', invert:true  },
  { key:'CHF', code:'092741', invert:true  },
  { key:'NZD', code:'112741', invert:false },
  { key:'XAU', code:'088691', invert:false },
  { key:'XAG', code:'084691', invert:false },
];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('JSON parse failed')); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Request timed out')));
  });
}

async function fetchOneCOT(code, weeks = 4) {
  const url = `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${weeks}`;
  return httpsGet(url);
}

// Returns { EUR: { net, long, short, bias, date }, GBP: {...}, ... }
async function fetchAllCOT(log) {
  const result = {};
  for (const m of COT_CODES) {
    try {
      const rows = await fetchOneCOT(m.code, 4);
      if (!rows?.length) continue;
      const r = rows[0];
      const long  = +r.noncomm_positions_long_all  || 0;
      const short = +r.noncomm_positions_short_all || 0;
      const rawNet = long - short;
      const net  = m.invert ? -rawNet : rawNet;
      result[m.key] = {
        net, long, short,
        date: (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
        bias: net >= 0 ? 'bullish' : 'bearish',
      };
    } catch (e) {
      if (log) log(`COT fetch failed for ${m.key}: ${e.message}`);
    }
  }
  return result;
}

// Check if a COT filter matches (called per-trade before entry)
// filter = { enabled, bias: 'any'|'bullish'|'bearish' }
// cotData = { EUR: { bias: 'bullish' }, ... }
// pair = 'EUR_USD'
function checkCOTFilter(filter, cotData, pair) {
  if (!filter?.enabled) return true;
  const required = filter.bias;
  if (!required || required === 'any') return true;
  // derive currency key from pair
  const base = pair.split('_')[0];
  const quote = pair.split('_')[1];
  // For USD-base pairs the COT key tracks the non-USD currency
  const key = base === 'USD' ? quote : base;
  const entry = cotData?.[key];
  if (!entry) return true; // can't fetch = don't block
  return entry.bias === required;
}

module.exports = { fetchAllCOT, checkCOTFilter };

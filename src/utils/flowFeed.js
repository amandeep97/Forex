// src/utils/flowFeed.js
// FLOW — positioning X-ray. Four real data sources, no prediction:
//   1. OANDA order/position book  → where retail orders and stops are piled up
//   2. Binance funding + OI + L/S → who is crowded and paying to stay there
//   3. Taker buy/sell imbalance   → aggressive flow (already in every kline)
//   4. CFTC COT                   → institutional positioning, weekly
// Everything here reports the present. Nothing forecasts.

// ── OANDA ─────────────────────────────────────────────────────────────────────
export function oandaCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) { const e = localStorage.getItem('oanda_env'); return e !== null ? { ...c, practice: e !== 'live' } : c; }
  } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  return apiKey ? { apiKey, practice: localStorage.getItem('oanda_env') !== 'live' } : null;
}
const base = c => (c.practice === false ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3');

// OANDA publishes the book only for majors + metals.
export const BOOK_INSTRUMENTS = [
  { sym:'EUR/USD', oanda:'EUR_USD', dec:5 }, { sym:'GBP/USD', oanda:'GBP_USD', dec:5 },
  { sym:'USD/JPY', oanda:'USD_JPY', dec:3 }, { sym:'AUD/USD', oanda:'AUD_USD', dec:5 },
  { sym:'USD/CAD', oanda:'USD_CAD', dec:5 }, { sym:'USD/CHF', oanda:'USD_CHF', dec:5 },
  { sym:'NZD/USD', oanda:'NZD_USD', dec:5 }, { sym:'EUR/JPY', oanda:'EUR_JPY', dec:3 },
  { sym:'GBP/JPY', oanda:'GBP_JPY', dec:3 }, { sym:'XAU/USD', oanda:'XAU_USD', dec:2 },
];

async function book(kind, instr) {
  const c = oandaCreds();
  if (!c?.apiKey) { const e = new Error('OANDA not connected'); e.code = 'NOKEY'; throw e; }
  const env = c.practice === false ? 'live' : 'practice';
  const r = await fetch(`${base(c)}/instruments/${instr}/${kind}`,
    { headers:{ Authorization:`Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) {
    // Surface OANDA's own reason. A 401 here while candles work on the same
    // token is a permission problem, not a bad key — the books are a live-account
    // feature, so practice tokens are rejected even though they are valid.
    let why = '';
    try { const j = await r.json(); why = j.errorMessage || j.message || ''; } catch {}
    const e = new Error(why || `HTTP ${r.status}`);
    e.code = r.status === 401 || r.status === 403 ? 'DENIED' : r.status === 404 ? 'UNSUPPORTED' : 'ERR';
    e.status = r.status; e.env = env; e.instr = instr;
    throw e;
  }
  const d = await r.json();
  const b = d.orderBook || d.positionBook;
  if (!b) throw new Error('empty book');
  return {
    price: +b.price,
    bucketWidth: +b.bucketWidth,
    time: b.time,
    buckets: (b.buckets || []).map(x => ({
      price: +x.price,
      long:  +x.longCountPercent,
      short: +x.shortCountPercent,
    })).filter(x => x.long + x.short > 0),
  };
}

export const fetchOrderBook    = instr => book('orderBook', instr);
export const fetchPositionBook = instr => book('positionBook', instr);

// ── Auth probe ────────────────────────────────────────────────────────────────
// "Invalid authentication credentials" while candles work is ambiguous: either
// the token belongs to the OTHER environment, or it is fine and only the book
// is refused. Guessing between those wasted a round trip, so test it directly:
// hit a trivial authenticated endpoint on BOTH hosts, then the book on whichever
// accepts the token. The combination identifies the cause exactly.
const ENVS = [
  { name:'live',     host:'https://api-fxtrade.oanda.com/v3' },
  { name:'practice', host:'https://api-fxpractice.oanda.com/v3' },
];

export async function probeOanda(instr = 'EUR_USD') {
  const c = oandaCreds();
  if (!c?.apiKey) return { ok:false, reason:'NOKEY', rows:[] };
  const hdr = { Authorization:`Bearer ${c.apiKey}` };

  const rows = await Promise.all(ENVS.map(async e => {
    const row = { env:e.name, auth:null, book:null, note:'' };
    try {
      const r = await fetch(`${e.host}/accounts`, { headers:hdr, signal:AbortSignal.timeout(12000) });
      row.auth = r.status;
      if (r.ok) {
        const b = await fetch(`${e.host}/instruments/${instr}/positionBook`, { headers:hdr, signal:AbortSignal.timeout(12000) });
        row.book = b.status;
        if (!b.ok) { try { row.note = (await b.json()).errorMessage || ''; } catch {} }
      }
    } catch (err) { row.auth = 0; row.note = err.message; }
    return row;
  }));

  const good = rows.find(r => r.auth === 200);
  const configured = c.practice === false ? 'live' : 'practice';
  let verdict;
  if (!good)                              verdict = 'TOKEN_BAD';        // rejected everywhere
  else if (good.env !== configured)       verdict = 'WRONG_ENV';        // token belongs to the other host
  else if (good.book === 200)             verdict = 'BOOK_OK';          // works — transient failure earlier
  else                                    verdict = 'BOOK_DENIED';      // token fine, book specifically refused
  return { ok:true, verdict, configured, working:good?.env || null, rows };
}

// ── Liquidity pools ───────────────────────────────────────────────────────────
// Stops sit on the losing side of open positions: longs opened BELOW price are
// protected by stops below, shorts opened ABOVE price by stops above. Clusters
// of those positions are therefore pools of resting liquidity — the fuel a
// sweep runs into. This measures where they are, not whether one will be taken.
export function liquidityPools(positionBook, maxPools = 6) {
  if (!positionBook?.buckets?.length) return [];
  const { price, buckets } = positionBook;
  const pools = buckets.map(b => {
    const below = b.price < price;
    // below price → trapped/So-protected LONGS leave sell-side stops beneath
    // above price → SHORTS leave buy-side stops overhead
    const exposed = below ? b.long : b.short;
    const distPct = ((b.price - price) / price) * 100;
    return {
      price: b.price, side: below ? 'sell-side' : 'buy-side',
      pct: +exposed.toFixed(2), long: b.long, short: b.short,
      distPct: +distPct.toFixed(2), below,
    };
  }).filter(p => p.pct > 0);

  const max = Math.max(...pools.map(p => p.pct), 0.0001);
  return pools
    .map(p => ({ ...p, rel: p.pct / max, score: +(p.pct / (1 + Math.abs(p.distPct))).toFixed(3) }))
    .sort((a, b) => b.score - a.score)      // big AND close ranks highest
    .slice(0, maxPools);
}

// Net retail bias from the position book (the "dumb money" side)
export function retailBias(positionBook) {
  if (!positionBook?.buckets?.length) return null;
  const long = positionBook.buckets.reduce((s, b) => s + b.long, 0);
  const short = positionBook.buckets.reduce((s, b) => s + b.short, 0);
  const tot = long + short;
  if (!tot) return null;
  const longPct = Math.round((long / tot) * 100);
  return { longPct, shortPct: 100 - longPct, crowded: Math.abs(longPct - 50) >= 20 };
}

// ── Real order book (Binance spot) ────────────────────────────────────────────
// OANDA refuses its book on most accounts, so for crypto we use the genuine
// article: live bids and asks with real quantities, not bucketed percentages.
// Resting size clustered at a price is a wall — visible support/resistance that
// exists right now, rather than an inference from candles.
export const DEPTH_SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT'];

export async function fetchDepthMap(symbol, { limit = 5000, bucketPct = 0.0005, walls = 7 } = {}) {
  // 5000 is Binance's maximum. On a liquid symbol 1000 levels barely clears the
  // spread, so the "walls" it surfaced were just top-of-book noise.
  const d = await j(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`);
  const bids = (d.bids || []).map(([p, q]) => [+p, +q]);
  const asks = (d.asks || []).map(([p, q]) => [+p, +q]);
  if (!bids.length || !asks.length) throw new Error('empty depth');

  const mid = (bids[0][0] + asks[0][0]) / 2;
  const step = Math.max(mid * bucketPct, 1e-8);
  const bucket = (rows, side) => {
    const m = new Map();
    for (const [p, q] of rows) {
      const k = Math.round(p / step) * step;
      m.set(k, (m.get(k) || 0) + q * p);        // size in quote currency
    }
    return [...m.entries()].map(([price, notional]) => ({ price, notional, side }));
  };
  const all = [...bucket(bids, 'bid'), ...bucket(asks, 'ask')];
  const max = Math.max(...all.map(b => b.notional), 1);

  // A wall is size that STANDS OUT, not merely size that is close. Compare each
  // bucket to the median bucket so ordinary depth near the touch is excluded and
  // a genuine block further out can still qualify.
  const sorted = all.map(b => b.notional).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 1;
  const WALL_MIN = med * 3;

  const bidNotional = bids.reduce((s, [p, q]) => s + p * q, 0);
  const askNotional = asks.reduce((s, [p, q]) => s + p * q, 0);
  const lowest = bids[bids.length - 1][0], highest = asks[asks.length - 1][0];

  const scored = all
    .map(b => ({ ...b, rel: b.notional / max, distPct: +(((b.price - mid) / mid) * 100).toFixed(3) }))
    .filter(b => b.notional >= WALL_MIN)
    // mild distance weighting only — a large block 1% away is still worth seeing
    .map(b => ({ ...b, score: b.notional / (1 + Math.abs(b.distPct) * 0.4), xMedian: +(b.notional / med).toFixed(1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, walls)
    .sort((a, b) => b.price - a.price);

  return {
    symbol, mid, step, walls: scored,
    imbalance: +((bidNotional / (bidNotional + askNotional)) * 100).toFixed(1),
    bidNotional, askNotional,
    levels: bids.length + asks.length,
    // how far the returned book actually reaches — without this the map looks
    // complete when it may only span a fraction of a percent
    rangePct: +(((highest - lowest) / mid) * 100).toFixed(2),
    lowest, highest,
    medianBucket: med,
  };
}

// ── Binance derivatives: who is crowded ───────────────────────────────────────
const FAPI = 'https://fapi.binance.com';

export const SQUEEZE_SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT'];

async function j(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export async function fetchSqueeze(symbol) {
  const [prem, oiNow, oiHist, ls] = await Promise.allSettled([
    j(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`),
    j(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`),
    j(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=24`),
    j(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`),
  ]);
  const get = s => (s.status === 'fulfilled' ? s.value : null);
  const p = get(prem), oi = get(oiNow), hist = get(oiHist), lsr = get(ls);
  if (!p && !oi) return null;

  // Funding is paid every 8h; annualise so the number is comparable to a rate.
  const funding = p ? +p.lastFundingRate : null;
  const fundingAnnual = funding != null ? +(funding * 3 * 365 * 100).toFixed(1) : null;

  let oiChangePct = null;
  if (hist?.length > 1) {
    const first = +hist[0].sumOpenInterest, last = +hist[hist.length - 1].sumOpenInterest;
    if (first > 0) oiChangePct = +(((last - first) / first) * 100).toFixed(1);
  }
  const ratio = lsr?.length ? +lsr[0].longShortRatio : null;

  // Crowding: funding tells you who is PAYING to hold; rising OI says the crowd
  // is still growing. Both stretched the same way is a squeeze setup.
  let state = 'neutral', note = '';
  if (funding != null) {
    const hot = Math.abs(fundingAnnual) >= 15;
    const veryHot = Math.abs(fundingAnnual) >= 40;
    if (funding > 0 && hot)      { state = veryHot ? 'long-squeeze-risk' : 'longs-crowded'; note = 'longs paying shorts'; }
    else if (funding < 0 && hot) { state = veryHot ? 'short-squeeze-risk' : 'shorts-crowded'; note = 'shorts paying longs'; }
  }
  return {
    symbol, funding, fundingAnnual, oi: oi ? +oi.openInterest : null,
    oiChangePct, longShortRatio: ratio, state, note, markPrice: p ? +p.markPrice : null,
  };
}

// ── Aggressive flow (already inside every Binance kline) ──────────────────────
// kline[5] = total base volume, kline[9] = taker BUY base volume.
// The split is market-order aggression: who is lifting offers vs hitting bids.
export async function fetchTakerFlow(symbol, interval = '1h', limit = 24) {
  const d = await j(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  let vol = 0, buy = 0;
  const series = d.map(k => {
    const v = +k[5], b = +k[9];
    vol += v; buy += b;
    return { t: k[0], buyPct: v > 0 ? (b / v) * 100 : 50 };
  });
  return {
    symbol,
    buyPct: vol > 0 ? +((buy / vol) * 100).toFixed(1) : 50,
    series,
    bars: d.length,
  };
}

// ── COT (institutional) ───────────────────────────────────────────────────────
export const COT_CODES = {
  EUR:'099741', GBP:'096742', JPY:'097741', CHF:'092741',
  AUD:'232741', NZD:'112741', CAD:'090741', XAU:'088691', XAG:'084691',
};

export async function fetchCOTNet(code) {
  try {
    const rows = await j(`https://publicreporting.cftc.gov/resource/jun7-fc8e.json`
      + `?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=2`);
    if (!rows?.length) return null;
    const n = r => (+r.noncomm_positions_long_all || 0) - (+r.noncomm_positions_short_all || 0);
    return { net: n(rows[0]), prevNet: rows[1] ? n(rows[1]) : null, date: rows[0].report_date_as_yyyy_mm_dd };
  } catch { return null; }
}

// Institutions (COT net) vs retail (OANDA position book). When they point in
// opposite directions that disagreement is the whole signal — and it is a fact
// about current positioning, not a forecast.
export function smartVsDumb(ccy, cot, bias) {
  if (!cot || !bias) return null;
  const instLong = cot.net > 0;
  const retailLong = bias.longPct > 50;
  const opposed = instLong !== retailLong;
  return {
    ccy, instNet: cot.net, instLong,
    retailLongPct: bias.longPct, retailLong,
    opposed, crowded: bias.crowded,
    strength: opposed && bias.crowded ? 'strong' : opposed ? 'mild' : 'aligned',
  };
}

// ── Correlation break detector ────────────────────────────────────────────────
// Some pairs normally move together (or opposite). When a long-standing
// relationship inverts, something structural is happening — worth flagging,
// without claiming to know what happens next.
export const CORREL_PAIRS = [
  { a:'XAU/USD', b:'DXY',     expect:-1, label:'Gold vs Dollar' },
  { a:'XAU/USD', b:'XAG/USD', expect:+1, label:'Gold vs Silver' },
  { a:'EUR/USD', b:'GBP/USD', expect:+1, label:'EUR vs GBP' },
  { a:'AUD/USD', b:'NZD/USD', expect:+1, label:'AUD vs NZD' },
];

export function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;
  const a = x.slice(-n), b = y.slice(-n);
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const p = a[i] - ma, q = b[i] - mb; num += p * q; da += p * p; db += q * q; }
  const den = Math.sqrt(da * db);
  return den === 0 ? null : +(num / den).toFixed(2);
}

export function returnsOf(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) out.push((candles[i].c - candles[i-1].c) / candles[i-1].c);
  return out;
}

// A break = realised correlation has flipped sign against its usual direction.
export function correlationBreak(label, expect, corr) {
  if (corr == null) return null;
  const flipped = expect > 0 ? corr < -0.1 : corr > 0.1;
  const weak = Math.abs(corr) < 0.2;
  return {
    label, corr, expect,
    status: flipped ? 'broken' : weak ? 'decoupled' : 'normal',
  };
}

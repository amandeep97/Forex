import { venueFor, fetchBinanceKlines, probeInstrument } from '../src/utils/binanceKlines.js';
import { INSTRUMENTS, bySymbol, withCap } from '../src/data/instruments.js';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };

// ── Venue selection is the whole point: a futures-only symbol sent to spot
// returns 400, gets swallowed, and the app backtests invented data. ────────
check('crypto routes to spot', venueFor(bySymbol('BTC/USDT')).venue === 'spot');
check('TradFi perp routes to futures', venueFor(bySymbol('CRWD/USDT')).venue === 'futures');
check('futures host is fapi', venueFor(bySymbol('XLE/USDT')).host.includes('fapi.binance.com'));
check('spot host is api', venueFor(bySymbol('BTC/USDT')).host.includes('api.binance.com'));
check('the right ticker is used', venueFor(bySymbol('CRWD/USDT')).symbol === 'CRWDUSDT',
  venueFor(bySymbol('CRWD/USDT')).symbol);
// Commodity and metal perps are carried alongside their OANDA equivalents on
// purpose — same underlying, different information (24/7, funding, OI). The
// breadth test excludes perps so the overlap cannot distort it.
check('commodity perps carried', ['WTI/USDT','BRENT/USDT','NGAS/USDT','XAG/USDT']
  .every(x => !!bySymbol(x)?.bfut));
check('an OANDA instrument has no Binance venue', venueFor(bySymbol('XAU/USD')) === null);

// ── Registry integrity ────────────────────────────────────────────────────
const tradfi = INSTRUMENTS.filter(i => i.cls === 'tradfi');
check('tradfi instruments added', tradfi.length === 20, String(tradfi.length));
check('none of them claim a spot symbol', tradfi.every(i => !i.binance));
check('all are marked tradeable for candles', tradfi.every(i => i.can.candles));
check('but excluded from spot-only screens', tradfi.every(i => !i.can.spotCandles));
check('and from order-book depth', tradfi.every(i => !i.can.depth));
check('they do carry derivatives data', tradfi.every(i => i.can.derivatives));
check('existing instruments keep spotCandles', bySymbol('BTC/USDT').can.spotCandles === true
  && bySymbol('XAU/USD').can.spotCandles === true);
check('no duplicate symbols anywhere',
  new Set(INSTRUMENTS.map(i=>i.sym)).size === INSTRUMENTS.length);
check('no duplicate Binance tickers',
  (() => { const t = INSTRUMENTS.map(i=>i.binance||i.bfut).filter(Boolean);
           return new Set(t).size === t.length; })());
check('the leveraged inverse ETF is flagged', bySymbol('SOXS/USDT').leveraged === true);
check('spotCandles is a strict subset of candles',
  withCap('spotCandles').length < withCap('candles').length);

// ── Paging against a fake futures venue ───────────────────────────────────
const T0 = 1700000000000, DAY = 86400e3, HIST = 2400;
let calls = [];
globalThis.fetch = async (url) => {
  calls.push(url);
  const u = new URL(url);
  const limit = +u.searchParams.get('limit');
  const end = u.searchParams.get('endTime');
  // Binance's endTime is INCLUSIVE of the bar whose open time is <= endTime.
  // The caller passes firstOpen-1, so the newest bar returned must be the one
  // BEFORE the page already collected. Modelling this as inclusive-of-firstOpen
  // returns a duplicate, dedupe drops it, and the page count silently comes up
  // one short — which is a bug in the fake, not in the pager.
  const endIdx = end ? Math.floor((+end - T0) / DAY) + 1 : HIST;
  const start = Math.max(0, endIdx - limit);
  const out = [];
  for (let i = start; i < endIdx; i++) out.push([T0 + i*DAY, '1', '2', '0.5', '1.5', '100']);
  return { ok: true, json: async () => out };
};
globalThis.AbortSignal = { timeout: () => undefined };

const got = await fetchBinanceKlines(bySymbol('CRWD/USDT'), '1d', 2000);
check('paging returns the full request', got.length === 2000, String(got.length));
check('more than one page fetched', calls.length >= 2, String(calls.length));
check('every request hit the futures host', calls.every(u => u.includes('fapi.binance.com')));
check('bars sorted and unique',
  got.every((c,i) => i === 0 || c.t > got[i-1].t) && new Set(got.map(c=>c.t)).size === got.length);

// Asking past the listing date must stop, not spin.
calls = [];
const all = await fetchBinanceKlines(bySymbol('CRWD/USDT'), '1d', 9000);
check('stops at the start of listed history', all.length === HIST, `${all.length}/${HIST}`);
check('does not spin', calls.length <= 5, String(calls.length));

// ── The probe ─────────────────────────────────────────────────────────────
const p = await probeInstrument(bySymbol('CRWD/USDT'), '1d');
check('probe reports usable for long history', p.ok && p.usable === true, JSON.stringify(p).slice(0,90));
check('probe reports the span in days', p.days === 1999, `${p.days}`);
check('probe names the venue', p.venue === 'futures');

// A short listing must be reported as too new rather than passed through.
const SHORT = 60;
globalThis.fetch = async () => ({ ok: true, json: async () =>
  Array.from({length: SHORT}, (_,i) => [T0 + i*DAY, '1','2','0.5','1.5','100']) });
const p2 = await probeInstrument(bySymbol('XLE/USDT'), '1d');
check('a 60-day listing is flagged unusable', p2.ok && p2.usable === false, `${p2.days} days`);

// A symbol that is not listed must say so, not return an empty series that
// reads as "no history".
globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
const p3 = await probeInstrument(bySymbol('SOXS/USDT'), '1d');
check('an unlisted symbol reports why', p3.ok === false && /not available|400/.test(p3.reason), p3.reason);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

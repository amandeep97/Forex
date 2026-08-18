import { runBacktest, calcStats } from '../src/utils/backtestEngine.js';
import { buildContext, alignCloses, key } from '../src/utils/contextSeries.js';
import { deepSearch, poolFor, crossAssetPool } from '../src/utils/deepSearch.js';

let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'  ok  ':'  FAIL'}  ${n}${e?' — '+e:''}`); if(!c) fails++; };
const DAY = 86400e3, T0 = 1500000000000 - (1500000000000 % DAY);

function walk(seed, n, step = DAY, drift = 0) {
  let s = seed, p = 100; const out = [];
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    const o = p, c = o + (rnd() - 0.5) * 1.4 + drift;
    out.push({ t: T0 + i*step, o, h: Math.max(o,c)+rnd()*0.5, l: Math.min(o,c)-rnd()*0.5, c, v: 60+rnd()*80 });
    p = c;
  }
  return out;
}

// ── Alignment must never look forward ─────────────────────────────────────
const base = walk(1, 100);
const peer = walk(2, 100);
const aligned = alignCloses(base, peer);
check('alignment uses the peer bar at or before each base bar',
  aligned.every((v, i) => v === peer[i].c));

// A peer that lags by half a bar must resolve to the PREVIOUS peer close.
const lagged = peer.map(c => ({ ...c, t: c.t + DAY/2 }));
const al2 = alignCloses(base, lagged);
check('a peer stamped later resolves to its previous bar',
  al2[5] === lagged[4].c, `${al2[5]} vs ${lagged[4].c}`);
check('no look-ahead at the first bar', al2[0] === null);

// Peers with no overlap must produce nulls, not silent zeros.
const future = walk(3, 50).map(c => ({ ...c, t: c.t + 400*DAY }));
check('a non-overlapping peer yields nulls', alignCloses(base, future).every(v => v === null));

// ── Context series ────────────────────────────────────────────────────────
const ctx = buildContext(base, { 'XAG/USD': peer });
check('self change series built', ctx[key.selfChg(5)]?.length === base.length);
check('peer change series built',  ctx[key.peerChg('XAG/USD', 5)]?.length === base.length);
check('ratio percentile built',    ctx[key.ratioPct('XAG/USD')]?.length === base.length);
const sc = ctx[key.selfChg(5)];
check('self change matches hand calc', (() => {
  const i = 60, want = ((base[i].c - base[i-5].c) / Math.abs(base[i-5].c)) * 100;
  return Math.abs(sc[i] - want) < 1e-9;
})());
check('ratio percentile stays in range',
  ctx[key.ratioPct('XAG/USD')].every(v => v == null || (v >= 0 && v <= 100)));

// ── Conditions fire, and mean what they say ───────────────────────────────
// Peer trends up hard; base is flat. "peer moved up, this has not" must fire.
const flat = walk(7, 400, DAY, 0);
const rising = walk(8, 400, DAY, 0.6);
const ctx2 = buildContext(flat, { 'US500': rising });
const runC = (cond, c2 = ctx2, cs = flat) => calcStats(runBacktest(cs, {
  conditions:[cond], ctx:c2, logic:'AND', direction:'long', exitType:'rr', rrRatio:2,
  slType:'atr', slAtr:2, symbol:'XAU/USD' }).trades).totalTrades;

check('lead fires when the peer ran and this did not',
  runC({ type:'lead', peer:'US500', n:3, op:'up', value:1.5 }) > 3,
  `n=${runC({ type:'lead', peer:'US500', n:3, op:'up', value:1.5 })}`);
check('divergence fires', runC({ type:'divergence', peer:'US500', n:5, op:'bear', value:1 }) > 3,
  `n=${runC({ type:'divergence', peer:'US500', n:5, op:'bear', value:1 })}`);
check('peer_chg fires', runC({ type:'peer_chg', peer:'US500', n:10, op:'above', value:2 }) > 3);
check('ratio_pct fires', runC({ type:'ratio_pct', peer:'US500', op:'below', value:20 }) > 3);

// Without context, a cross-asset condition must fire NEVER rather than always.
check('no context means the condition cannot fire',
  runC({ type:'peer_chg', peer:'US500', n:10, op:'above', value:2 }, {}) === 0);
check('an unknown peer cannot fire',
  runC({ type:'peer_chg', peer:'NOPE', n:10, op:'above', value:2 }) === 0);

// ── Calendar ──────────────────────────────────────────────────────────────
const long = walk(9, 1200);
check('turn of month fires', calcStats(runBacktest(long, { conditions:[{type:'dom',op:'turn'}],
  logic:'AND', direction:'long', exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 }).trades).totalTrades > 10);
check('quarter fires', calcStats(runBacktest(long, { conditions:[{type:'quarter',value:4}],
  logic:'AND', direction:'long', exitType:'rr', rrRatio:2, slType:'atr', slAtr:2 }).trades).totalTrades > 5);
// turn-of-month and mid-month must be mutually exclusive, or the search can
// stack two conditions that silently cancel.
const fireOn = cond => long.map((c,i) => {
  const d = new Date(c.t), day = d.getUTCDate();
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 0)).getUTCDate();
  return cond === 'turn' ? (day <= 3 || day > last-3) : (day > 10 && day <= 20);
});
check('turn and mid never overlap', !fireOn('turn').some((v,i) => v && fireOn('mid')[i]));

// ── Pool ──────────────────────────────────────────────────────────────────
const withPeers = poolFor(['US500', 'XAU/USD', 'XAG/USD', 'USOIL']);
check('cross-asset pool adds 8 conditions per peer',
  withPeers.length === poolFor([]).length + 32, `${withPeers.length} vs ${poolFor([]).length}`);
check('every cross-asset id is unique',
  new Set(withPeers.map(p=>p.id)).size === withPeers.length);
check('pool now exceeds 80 conditions', withPeers.length > 80, `${withPeers.length}`);

// ── End to end ────────────────────────────────────────────────────────────
const b = walk(21, 2600), p1 = walk(22, 2600, DAY, 0.05), p2 = walk(23, 2600);
// The neutral exit used to rank single conditions must be a trailing stop,
// not a wide fixed target — this run silently returned nothing when an index
// reference moved it to an 8R target.
const res = await deepSearch(b, { peers: { 'US500': p1, 'XAU/USD': p2 },
  minTrades: 10, beam: 6, maxDepth: 4, keep: 6, calibrate: false });
check('search runs with peers', res.ok === true, res.reason);
check('the pool grew', res.poolSize > 60, `${res.poolSize}`);
check('peers reported', res.peers?.length === 2, JSON.stringify(res.peers));
check('finalists carry portable conditions', res.finalists.every(f => Array.isArray(f.conditions)));
const anyCross = res.finalists.some(f => f.crossAsset > 0);
console.log(`         cross-asset conditions used by a finalist: ${anyCross ? 'yes' : 'no'}`);
console.log(`         top: ${res.finalists[0]?.label?.slice(0,90)}`);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

import { testAcrossInstruments, FOCUS_SET } from '../src/utils/strategySearch.js';

// Synthetic candles: a deterministic drift+noise series, seeded per symbol so
// each instrument gets a genuinely different history.
function candles(seed, n = 700) {
  let s = seed, p = 100;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = (rnd() - 0.5) * 2;
    const o = p, c = p + d, h = Math.max(o, c) + rnd(), l = Math.min(o, c) - rnd();
    out.push({ t: 1600000000000 + i * 86400e3, o, h, l, c, v: 1000 });
    p = c;
  }
  return out;
}

const STRAT = {
  conditions: [{ type:'rsi', period:14, op:'crossBelow', value:30 }],
  logic:'AND', direction:'long', exitType:'rr', rrRatio:2, slType:'atr', slAtr:2,
};

let fails = 0;
const check = (name, cond, extra='') => { console.log(`${cond?'  ok  ':'  FAIL'}  ${name}${extra?' — '+extra:''}`); if(!cond) fails++; };

const syms = ['A','B','C','D','E','F'];
const load = async s => candles(syms.indexOf(s) * 7919 + 13);

const withOrigin = await testAcrossInstruments(STRAT, load, syms, { origin:'A', minTrades:1 });
const noOrigin   = await testAcrossInstruments(STRAT, load, syms, { minTrades:1 });

check('origin row is still returned', withOrigin.rows.some(r => r.sym === 'A'));
check('origin row is flagged',        withOrigin.rows.find(r => r.sym === 'A').origin === true);
check('other rows are not flagged',   withOrigin.rows.filter(r => r.sym !== 'A').every(r => !r.origin));
check('origin excluded from judged',  withOrigin.judged === noOrigin.judged - 1,
      `${withOrigin.judged} vs ${noOrigin.judged}`);
check('origin reported back',         withOrigin.origin === 'A');
check('no origin → nothing excluded', noOrigin.judged === noOrigin.rows.filter(r=>r.enough).length);

// The exclusion must actually be able to change the verdict, or it is cosmetic.
const rowsA = withOrigin.rows.find(r => r.sym === 'A');
check('origin R not counted in median',
      !withOrigin.rows.filter(r=>r.enough && !r.origin).some(r => r.sym === 'A'));

// FOCUS_SET sanity
check('focus set has 12 entries', FOCUS_SET.length === 12, `${FOCUS_SET.length}`);
check('focus set has no duplicates', new Set(FOCUS_SET).size === FOCUS_SET.length);
check('focus set spans 4 asset classes',
      ['XAU/USD','US500','USOIL','EUR/USD'].every(s => FOCUS_SET.includes(s)));
check('focus set excludes alt crypto', !FOCUS_SET.some(s => s.endsWith('/USDT')));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

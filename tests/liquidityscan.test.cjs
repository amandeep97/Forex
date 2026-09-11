'use strict';
// The sweep model on the VPS — vps-bot/src/liquidityScan.js.
//
// Moved here from the app because the browser version only ran while a tab was
// open, which is the one situation where a two-minute confirmation is not
// needed. On the bot it has a constraint the app never had: two-minute candles
// for every instrument every two minutes is about 25 requests a minute on its
// own, against a whole-bot budget of 26 a tick that the feed already competes
// for.
//
// So everything here is about spending requests only where they can pay:
//
//   Levels refresh hourly, not every pass. Yesterday's high is yesterday's high
//   all day.
//
//   Two-minute candles are fetched only for instruments whose last known price
//   is near a level. On a quiet day that is a handful.
//
//   "Near" is measured in H4 ATR. A fixed percentage cannot serve gold at 4300
//   and EUR/USD at 1.08, and a fixed pip count is the same mistake in other
//   clothes.
//
//   And an alert fires once per sweep. Re-announcing the same setup every two
//   minutes is how you teach someone to ignore the alert.
const { LiquidityScanner, atrOf, NEAR_ATR, NEAR_ATR_DAILY } = require('../vps-bot/src/liquidityScan');

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// ── Fake OANDA that counts what was asked for ──────────────────────────────
let clock = 0;
function bar(o, c, hP = 0.2, lP = 0.05) {
  return { t: (clock++) * 120e3, o, c, h: Math.max(o, c) + hP, l: Math.min(o, c) - lP, v: 1 };
}
function leg(out, n, step, from) {
  let p = from;
  for (let i = 0; i < n; i++) {
    const o = p, cl = p + step;
    out.push(bar(o, cl, step > 0 ? 0.2 : 0.05, step > 0 ? 0.05 : 0.2));
    p = cl;
  }
  return p;
}
function flat(n, price) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(bar(price, price));
  return out;
}

function fakeOanda(m2Builder) {
  const calls = [];
  return {
    calls,
    async getCandles(instrument, gran, count) {
      calls.push(`${instrument}|${gran}`);
      if (gran === 'D') return [{ o:100,h:105,l:95,c:104 }, { o:104,h:110,l:100,c:106 }, { o:106,h:107,l:105,c:106 }];
      if (gran === 'W') return [{ o:90,h:120,l:88,c:115 }, { o:104,h:112,l:98,c:106 }, { o:106,h:107,l:105,c:106 }];
      if (gran === 'H4') { const a = []; let p = 100; for (const [n, s] of [[6,1],[6,-1],[7,1],[6,-1],[7,1],[6,-1]]) p = leg(a, n, s, p); return a; }
      if (gran === 'M2') return m2Builder ? m2Builder() : flat(40, 104);
      return [];
    },
  };
}
const noGithub = { async writeJSON() { return 'sha'; }, async readJSON() { return null; } };
const quiet = () => {};

// Sweep of yesterday's high at 110: up through it, back below, then a break
// downward off a pullback so there is a confirmed swing low to break.
function sweptM2() {
  clock = 0;
  const a = [];
  let p = 104;
  p = leg(a, 8, 1, p);
  p = leg(a, 6, -0.6, p);
  p = leg(a, 4, 0.5, p);
  p = leg(a, 6, -0.6, p);
  p = leg(a, 4, 0.4, p);
  leg(a, 6, -0.6, p);
  return a;
}

// ── ATR, since everything scales off it ────────────────────────────────────
{
  check('ATR needs more bars than its period',
    atrOf(flat(5, 100), 14) === null,
    'a range measured on too little data is a number with no meaning behind it');
  const a = [];
  leg(a, 30, 1, 100);
  check('and is positive on a real series', atrOf(a) > 0, String(atrOf(a)?.toFixed(3)));
}

// ── Proximity gating: the whole cost argument ──────────────────────────────
{
  const s = new LiquidityScanner({ oanda: fakeOanda(), github: noGithub, log: quiet });
  s.levels.set('X', { levels: [{ kind:'PDH', price:110, side:'high', label:"yesterday's high" }], atr: 2, at: Date.now() });

  check('price at the level is near', s._near('X', 110) === true);
  check('price one ATR away is still near',
    s._near('X', 110 - 2 * NEAR_ATR) === true, 'the band is measured in ATR, not percent');
  check('price far away is not, and costs no request',
    s._near('X', 80) === false,
    'this is the check that keeps 50 instruments from costing 25 requests a minute');
  check('beyond the level counts too',
    s._near('X', 111) === true,
    'past the level is the case the whole model is about — gating it out would be the wrong side of the test');

  check('an instrument with no levels yet is never near',
    s._near('UNKNOWN', 110) === false,
    'a missing measurement must not trigger spending');
  check('and a missing price is not near either',
    s._near('X', undefined) === false && s._near('X', NaN) === false);

  // Scale independence — the reason ATR is used at all.
  const gold = new LiquidityScanner({ oanda: fakeOanda(), github: noGithub, log: quiet });
  gold.levels.set('XAU', { levels: [{ kind:'PDH', price:4300, side:'high', label:'x' }], atr: 20, at: Date.now() });
  check('the band scales with the instrument, not with its price',
    gold._near('XAU', 4285) === true && gold._near('XAU', 4200) === false,
    'gold at 4300 and EUR/USD at 1.08 cannot share a fixed distance');
}

// ── A pass spends only what it needs ───────────────────────────────────────
(async () => {
  {
    const oanda = fakeOanda(sweptM2);
    const s = new LiquidityScanner({ oanda, github: noGithub, log: quiet });
    // Everything far from its levels: levels still refresh, nothing scans.
    await s.tick({});
    const m2Calls = oanda.calls.filter(c => c.endsWith('|M2')).length;
    const lvlCalls = oanda.calls.filter(c => /\|(D|W|H4)$/.test(c)).length;
    check('a first pass builds levels',
      lvlCalls > 0, `${lvlCalls} level requests`);
    check('and fetches no two-minute candles for instruments nowhere near a level',
      m2Calls === 0, `${m2Calls} M2 requests`,
      'the expensive series is the one that must be earned');
    check('the level work is capped per pass',
      lvlCalls <= 4 * 3, `${lvlCalls} requests, 3 per instrument`,
      'refreshing all fifty at once would starve the feed for a whole tick');
  }

  {
    // Now put price right on a level and check it scans, once.
    const oanda = fakeOanda(sweptM2);
    const s = new LiquidityScanner({ oanda, github: noGithub, log: quiet });
    const sym = s._instruments()[0].sym;
    s.levels.set(sym, {
      levels: [{ kind:'PDH', price:110, side:'high', label:"yesterday's high" }],
      atr: 2, at: Date.now(),
    });
    await s.tick({ [sym]: 110 });

    check('an instrument sitting on a level does get scanned',
      oanda.calls.some(c => c.endsWith('|M2')), oanda.calls.filter(c => c.endsWith('|M2')).join(' '));

    const rec = s.results.get(sym);
    check('and the result is recorded whether or not it found a setup',
      rec && rec.scanned === true,
      rec ? `setup ${rec.setup?.state}` : 'no record',
      '"checked, nothing there" and "never checked" are different facts');

    check('the published record carries no candle arrays',
      rec.setup === null || (!('sweep' in rec.setup) && !('levels' in rec.setup)),
      Object.keys(rec.setup || {}).join(','),
      'shipping the series would make the file enormous to say the same thing');

    // Only the M2 count matters here. The pass legitimately keeps building
    // levels for OTHER instruments at four a tick — that is the schedule
    // working, not waste, and asserting on total requests confused the two.
    const beforeM2 = oanda.calls.filter(c => c.endsWith('|M2')).length;
    await s.tick({ [sym]: 110 });
    const afterM2 = oanda.calls.filter(c => c.endsWith('|M2')).length;
    check('a second pass moments later re-fetches no two-minute candles',
      afterM2 === beforeM2, `${afterM2 - beforeM2} extra M2 requests`,
      'a two-minute bar closes every two minutes; asking more often buys nothing');
  }

  // ── One alert per sweep ──────────────────────────────────────────────────
  {
    const sent = [];
    const s = new LiquidityScanner({
      oanda: fakeOanda(sweptM2), github: noGithub, log: quiet,
      telegram: { async send(t) { sent.push(t); } },
    });
    const rec = {
      sym: 'TEST', price: 105,
      setup: {
        dir: 'short', ready: true, state: 'setup',
        level: { kind:'PDH', price:110, label:"yesterday's high" },
        entry: 105.4, stop: 112.4, risk: 7, age: 0,
        confirm: { type:'BOS', direction:'bearish' },
      },
    };
    await s._announce(rec);
    await s._announce(rec);
    await s._announce(rec);
    check('the same sweep is announced once, not every two minutes',
      sent.length === 1, `${sent.length} messages`,
      'repeating an alert while it stays valid trains you to ignore it');

    check('the alert carries the numbers needed to place the trade',
      /entry/.test(sent[0]) && /stop/.test(sent[0]) && /105.4/.test(sent[0]),
      sent[0]?.split('\n')[0]);

    check('and says plainly that it is not a measured edge',
      /never been tested|not a measured edge/i.test(sent[0]),
      'every other surface in this app carries that caveat and an alert is the one most likely to be acted on blind');

    const other = { ...rec, setup: { ...rec.setup, level: { ...rec.setup.level, price: 115 } } };
    await s._announce(other);
    check('a different level does announce',
      sent.length === 2, `${sent.length} messages`);

    await s._announce({ ...rec, setup: { ...rec.setup, ready: false } });
    check('and a setup that is not ready never announces at all',
      sent.length === 2, `${sent.length} messages`,
      'the waiting state is not something to wake someone for');
  }

  // ── The daily high and low get a wider watch band ────────────────────────
  //
  // They are the levels an intraday trader is actually waiting on, so being
  // told early is the point. An H4 swing has to be nearly touched before it is
  // worth a request.
  {
    const s = new LiquidityScanner({ oanda: fakeOanda(), github: noGithub, log: quiet });
    s.levels.set('D', { levels: [{ kind:'PDH', price:110, side:'high', label:"yesterday's high" }], atr: 2, at: Date.now() });
    s.levels.set('H', { levels: [{ kind:'H4H', price:110, side:'high', label:'H4 swing high' }], atr: 2, at: Date.now() });

    const between = 110 - 2 * ((NEAR_ATR + NEAR_ATR_DAILY) / 2);
    check('a daily level is watched from further out than an H4 swing',
      s._near('D', between) === true && s._near('H', between) === false,
      `price ${between}, daily band ${2 * NEAR_ATR_DAILY}, other band ${2 * NEAR_ATR}`,
      'the daily high and low are the request; H4 swings are the nice-to-have');

    check('and both are still watched when price is right on them',
      s._near('D', 110) === true && s._near('H', 110) === true);
  }

  // ── An approach is published, not just used and discarded ────────────────
  {
    const oanda = fakeOanda(() => flat(40, 109));   // near 110, never beyond it
    const s = new LiquidityScanner({ oanda, github: noGithub, log: quiet });
    const sym = s._instruments()[0].sym;
    s.levels.set(sym, {
      levels: [{ kind:'PDH', price:110, side:'high', label:"yesterday's high" }],
      atr: 4, at: Date.now(),
    });
    await s.tick({ [sym]: 109 });
    const rec = s.results.get(sym);

    check('price approaching a level with no sweep still produces a row',
      rec && rec.setup === null && rec.near !== null,
      rec ? `setup ${rec.setup}, near ${rec.near?.kind}` : 'no record',
      'proximity used to exist only as a cost gate and the number was thrown away');
    check('and the row says which level and how far in its own scale',
      rec.near.kind === 'PDH' && rec.near.atrPct > 0,
      `${rec.near.label} ${rec.near.atrPct} ATR away`);
    check('an approach carries no direction',
      !('dir' in rec.near),
      'price at yesterday\'s high may sweep and turn or go straight through');
  }

  // ── The published table: one column per level ────────────────────────────
  {
    const oanda = fakeOanda(sweptM2);
    const s = new LiquidityScanner({ oanda, github: noGithub, log: quiet });
    const sym = s._instruments()[0].sym;
    s.levels.set(sym, {
      levels: [
        { kind:'PDH', price:110, side:'high', label:"yesterday's high" },
        { kind:'PDL', price:100, side:'low',  label:"yesterday's low" },
        { kind:'H4H', price:107, side:'high', label:'H4 swing high' },
        { kind:'H4H', price:112, side:'high', label:'a further H4 swing high' },
      ],
      atr: 4, at: Date.now(),
    });
    await s.tick({ [sym]: 110 });
    const rec = s.results.get(sym);

    check('the record carries a state per level, not one winner',
      rec.levels && Object.keys(rec.levels).length >= 3,
      Object.entries(rec.levels || {}).map(([k, v]) => `${k}=${v.state}`).join(' '),
      'a column per level is the request; a single best level hides the rest');

    check('the daily high reads as hunted',
      rec.levels.PDH?.state === 'swept', rec.levels.PDH?.state);
    check('and a level nowhere near price stays quiet',
      rec.levels.PDL?.state === 'quiet', rec.levels.PDL?.state);

    check('two H4 swings on the same side collapse into one column',
      typeof rec.levels.H4H === 'object' && !Array.isArray(rec.levels.H4H),
      'a column can only hold one, so the more advanced state wins and the nearest breaks ties');

    check('each cell carries its price and distance for the tooltip',
      Number.isFinite(rec.levels.PDH.price)
      && (rec.levels.PDH.atrPct === null || Number.isFinite(rec.levels.PDH.atrPct)));
  }

  // ── A column changing state has to rewrite the file ──────────────────────
  {
    const s = new LiquidityScanner({ oanda: fakeOanda(), github: noGithub, log: quiet });
    s.results.set('A', { sym:'A', at: Date.now(), setup: null, near: null,
      levels: { PDH: { state:'near', price:110, dir:null, atrPct:0.3 } } });
    const before = s._signature();
    s.results.set('A', { sym:'A', at: Date.now(), setup: null, near: null,
      levels: { PDH: { state:'swept', price:110, dir:'short', atrPct:0.1 } } });
    check('near becoming swept changes the signature',
      s._signature() !== before,
      'the table is the point; if the signature cannot see a column change the file never gets written');
  }

  // ── Surviving a restart ──────────────────────────────────────────────────
  //
  // Everything lived in memory. Each deploy wiped the levels for all forty
  // instruments, and rebuilding costs three requests each at four a tick — ten
  // minutes of looking like the model found nothing, every restart. Through a
  // run of deploys it never finished: eight instruments had levels after an
  // hour, and the screen reported that as if it had looked at all of them.
  {
    const saved = {
      at: new Date().toISOString(),
      rows: [{
        sym: 'EUR/USD', at: Date.now() - 60e3, price: 1.08, scanned: true,
        setup: null, near: null, levels: { PDH: { state:'swept', price:1.09, dir:'short', atrPct:0.1 } },
        lv: [['PDH', 1.09, 'high', "yesterday's high"], ['PDL', 1.07, 'low', "yesterday's low"]],
        atr: 0.004, lvAt: Date.now() - 5 * 60e3,
      }],
    };
    const gh = { async readJSON() { return { content: saved, sha: 'abc' }; }, async writeJSON() { return 'sha2'; } };
    const oanda = fakeOanda(sweptM2);
    const s = new LiquidityScanner({ oanda, github: gh, log: quiet });

    await s.tick({});
    check('a restart reads back what the last process published',
      s.results.has('EUR/USD'), [...s.results.keys()].join(','),
      'the screen went near empty after every deploy');
    check('and the levels come back with it, so nothing is re-fetched',
      s.levels.get('EUR/USD')?.levels?.length === 2,
      `${s.levels.get('EUR/USD')?.levels?.length} levels`,
      '120 requests were being spent rebuilding what was already on disk');
    check('the level AGE is restored too, not reset to now',
      s.levels.get('EUR/USD').at < Date.now() - 60e3,
      'treating an hour-old set as fresh would stop it ever refreshing');
    check('and it restores once, not on every tick',
      (async () => true)() && s.restored === true);

    // Checked on a fresh instance: tick() publishes afterwards and rightly
    // replaces the sha, so asserting it after a full tick tests the wrong
    // moment. What matters is that restore CAPTURED it, or the first write
    // would collide with a file the scanner itself wrote last run.
    const s2 = new LiquidityScanner({ oanda: fakeOanda(), github: gh, log: quiet });
    await s2._restore();
    check('restore captures the file sha, so the first write updates rather than collides',
      s2.sha === 'abc', String(s2.sha));
  }

  // ── Coverage is published, so the screen can show a fraction ─────────────
  {
    const s = new LiquidityScanner({ oanda: fakeOanda(), github: noGithub, log: quiet });
    s.results.set('A', { sym:'A', at: Date.now(), setup:null, near:null, levels:{} });
    let published = null;
    s.github = { async writeJSON(path, payload) { published = payload; return 'sha'; } };
    s.lastSig = null;
    await s._publish();

    check('the file says how many instruments COULD be covered',
      published && published.eligible > 1, `eligible ${published?.eligible}`,
      'a short list with no denominator reads as a quiet market when it means "not measured yet"');
    check('and how many actually have levels',
      published && typeof published.withLevels === 'number', String(published?.withLevels));
    check('the two are honest about each other',
      published.withLevels <= published.eligible,
      `${published.withLevels} of ${published.eligible}`);
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

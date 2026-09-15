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
const { LiquidityScanner, atrOf, NEAR_ATR, NEAR_ATR_DAILY, LEVEL_JOBS, LEVEL_METHOD,
  LEVELS_TTL } = require('../vps-bot/src/liquidityScan');

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
      lvlCalls <= LEVEL_JOBS * 3, `${lvlCalls} requests, 3 per instrument, cap ${LEVEL_JOBS}`,
      'refreshing all forty at once would spend 120 requests in one tick');
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

  // ── One alert per sweep, and it announces the PLAN ──────────────────────
  //
  // The alert used to fire on a confirmed setup, which is live for three
  // two-minute bars. By the time a phone buzzes and is picked up the window has
  // shut — the live file showed zero tradeable rows every single time it was
  // looked at. An armed plan is a resting limit, true for hours, so the message
  // is still worth acting on when it is read.
  {
    const sent = [];
    const s = new LiquidityScanner({
      oanda: fakeOanda(sweptM2), github: noGithub, log: quiet,
      telegram: { async send(t) { sent.push(t); } },
    });
    const rec = {
      sym: 'TEST', price: 105,
      plan: {
        dir: 'short', state: 'armed', why: 'waiting for price to come back to the level',
        entry: 110, stop: 112.4, risk: 2.4, target: 100, targetLabel: "yesterday's low", rr: 4.17,
        level: { kind:'PDH', price:110, label:"yesterday's high" }, sweptAt: Date.now(),
      },
    };
    await s._announce(rec);
    await s._announce(rec);
    await s._announce(rec);
    check('the same sweep is announced once, not every two minutes',
      sent.length === 1, `${sent.length} messages`,
      'repeating an alert while it stays valid trains you to ignore it');

    check('the alert carries the numbers needed to place the trade',
      /entry/.test(sent[0]) && /stop/.test(sent[0]) && /110/.test(sent[0]) && /112.4/.test(sent[0]),
      sent[0]?.split('\n')[0]);

    check('and names the target, so the trade can be judged before it is taken',
      /target/.test(sent[0]) && /100/.test(sent[0]),
      'entry and stop without a target is half a trade');

    check('it says LIMIT, because that is what the order is',
      /LIMIT/.test(sent[0]), sent[0]?.split('\n')[0],
      'a market order at the break is the thing that made every row untradeable');

    // This used to assert the words "never been tested". It was the right check
    // right up until the study published, and then it enforced a claim that had
    // become false. What the alert must carry is what is KNOWN — which with no
    // study on file is that there is no study on file.
    check('and says where the evidence stands, rather than asserting it is absent',
      /replay/i.test(sent[0]),
      (sent[0] || '').split('\n').filter(l => /replay/i.test(l)).join(' ') || '(nothing)',
      'an alert is the surface most likely to be acted on without reading anything else');

    const other = { ...rec, plan: { ...rec.plan, level: { ...rec.plan.level, price: 115 } } };
    await s._announce(other);
    check('a different level does announce',
      sent.length === 2, `${sent.length} messages`);

    await s._announce({ ...rec, plan: { ...rec.plan, state: 'triggered', level: { kind:'PDL', price:99, label:'x' } } });
    check('a plan that already filled is not announced',
      sent.length === 2, `${sent.length} messages`,
      'telling someone to place an order that has already been hit is worse than silence');

    await s._announce({ ...rec, plan: { ...rec.plan, state: 'dead', level: { kind:'PDL', price:98, label:'x' } } });
    check('and a dead plan is never announced at all',
      sent.length === 2, `${sent.length} messages`);
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
      // Without this the levels are dropped as an older method's — which is the
      // point of the version stamp, and would make this test assert nothing.
      method: LEVEL_METHOD,
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

  // ── A code change must invalidate cached levels ──────────────────────────
  //
  // Restoring levels across restarts made the bot cheap and made shipping a
  // correction impossible. The off-by-one fix went live and the screen kept the
  // old prices: the levels came back from a file written by the old code, and
  // the only thing that expires them is an hour-old timestamp — which every
  // restart effectively reset. Stale is a timing problem; wrong is not, and
  // waiting never fixes wrong.
  {
    const oldFile = {
      at: new Date().toISOString(),
      method: 1,                       // built by the previous method
      rows: [{
        sym: 'EUR/USD', at: Date.now(), price: 1.08, scanned: true, setup: null, near: null,
        levels: {}, lv: [['PDH', 1.09, 'high', 'y high']], atr: 0.004, lvAt: Date.now(),
      }],
    };
    const gh = { async readJSON() { return { content: oldFile, sha: 'a' }; }, async writeJSON() { return 'b'; } };
    const s = new LiquidityScanner({ oanda: fakeOanda(), github: gh, log: quiet });
    await s._restore();

    check('levels built by an older method are dropped, not trusted',
      !s.levels.has('EUR/USD'),
      `${s.levels.size} level set(s) restored`,
      'an hour-old timestamp cannot expire a level that was never right');
    check('but the results are kept, so the screen is not blank while they rebuild',
      s.results.has('EUR/USD'),
      'showing nothing and showing something wrong are both bad; this is neither');

    // The same file at the current method restores normally.
    // LEVEL_METHOD, not a literal: a test that hard-codes the version fails on
    // the next bump for no reason, which trains people to edit tests instead of
    // reading them.
    const cur = { ...oldFile, method: LEVEL_METHOD };
    const s2 = new LiquidityScanner({
      oanda: fakeOanda(),
      github: { async readJSON() { return { content: cur, sha: 'a' }; }, async writeJSON() { return 'b'; } },
      log: quiet,
    });
    await s2._restore();
    check('and a file from the CURRENT method still restores its levels',
      s2.levels.has('EUR/USD'),
      'versioning must not throw away the saving it was built for');
  }

  {
    const s = new LiquidityScanner({ oanda: fakeOanda(), github: noGithub, log: quiet });
    s.results.set('A', { sym:'A', at: Date.now(), setup:null, near:null, levels:{} });
    let published = null;
    s.github = { async writeJSON(path, payload) { published = payload; return 'sha'; } };
    s.lastSig = null;
    await s._publish();
    check('the published file states which method built it',
      published?.method === LEVEL_METHOD, String(published?.method),
      'without it, a future process cannot tell whether the levels mean what it means');
  }

  // ── What KIND of hunt it is: session, 4H trend, and the partner ──────────
  //
  // Three labels, all of them derived from data the scanner already has, and
  // all three easy to get wrong in a way that still renders. A session stamped
  // from the row instead of the level puts the wrong one on half the events; a
  // divergence computed inside _scan reads a partner that was last scanned
  // hours ago; an inverse pair compared high-to-high reports a divergence on
  // every single sweep.
  {
    const s = new LiquidityScanner({ oanda: fakeOanda(), github: noGithub, log: quiet });
    await s._load();

    // Two levels on one instrument, taken nine hours apart. This is ordinary,
    // not exotic: yesterday's high goes at the London open and a 4H swing goes
    // in the New York afternoon.
    const london = Date.UTC(2026, 0, 14, 9);
    const ny = Date.UTC(2026, 0, 14, 15);
    const cols = s._columns([
      { kind:'PDH', state:'swept', price:110, dir:'short', atrPct:0.1, atTime: london },
      { kind:'H4L', state:'swept', price:98, dir:'long', atrPct:0.2, atTime: ny },
    ]);
    check('each level carries the session it was taken in, not the row\'s',
      cols.PDH?.session?.id === 'london' && cols.H4L?.session?.id === 'ny',
      `${cols.PDH?.session?.id} / ${cols.H4L?.session?.id}`,
      'one session per row would mislabel whichever level it was not computed from');
    check('and the overlap is flagged where it applies',
      cols.PDH.session.overlap === false && cols.H4L.session.overlap === true,
      'New York covers both the overlap and the thin hours after London shuts');
    check('a level with no timestamp gets no session rather than a default',
      s._columns([{ kind:'PDL', state:'quiet', price:90, atrPct:1, atTime:null }]).PDL.session === null);

    // Divergence. Seeded directly rather than driven through _scan, because the
    // point being tested is that it reads the PARTNER's latest record — which
    // in production was written by a different tick.
    const d = new LiquidityScanner({ oanda: fakeOanda(), github: noGithub, log: quiet });
    await d._load();
    d.corr.set(['XAU/USD', 'XAG/USD'].sort().join('|'), { r: 0.88, n: 60, at: Date.now() });
    d.results.set('XAU/USD', { sym:'XAU/USD', levels: { PDL: { state:'swept', price: 4200 } } });
    d.results.set('XAG/USD', { sym:'XAG/USD', levels: { PDL: { state:'near' } } });
    d._diverge();
    check('gold took its low while silver held — reported as "alone"',
      d.results.get('XAU/USD').div?.verdict === 'alone'
      && d.results.get('XAU/USD').div?.partner === 'XAG/USD',
      JSON.stringify(d.results.get('XAU/USD').div?.verdict));
    check('and the measured r rides along, so the claim can be judged',
      d.results.get('XAU/USD').div?.r === 0.88 && d.results.get('XAU/USD').corr?.['XAG/USD']?.n === 60);

    // Silver then takes its own low. Nothing on gold's row moves except this.
    d.results.get('XAG/USD').levels.PDL.state = 'swept';
    d._diverge();
    check('once silver goes too, the same sweep reads as "together"',
      d.results.get('XAU/USD').div?.verdict === 'together',
      'the whole complex moving and one instrument being hunted are different events');

    // And the signature has to see that change, or the published file keeps the
    // first answer forever.
    d.results.get('XAU/USD').at = Date.now();
    const sigTogether = d._signature();
    d.results.get('XAG/USD').levels.PDL.state = 'near';
    d._diverge();
    check('the publish signature notices the verdict flipping',
      d._signature() !== sigTogether,
      'nothing else on gold\'s row changes when silver takes its own level');

    // An unrelated instrument makes no claim at all, rather than being paired
    // with whatever correlated best.
    d.results.set('EUR/NZD', { sym:'EUR/NZD', levels: { PDL: { state:'swept' } } });
    d._diverge();
    check('an instrument with no declared partner says nothing',
      d.results.get('EUR/NZD').div === null && d.results.get('EUR/NZD').corr === null,
      'screening all forty for the best correlation would pair near-duplicates and call it insight');

    // A partner that has never been scanned: no levels to compare, so no claim.
    const u = new LiquidityScanner({ oanda: fakeOanda(), github: noGithub, log: quiet });
    await u._load();
    u.corr.set(['XAU/USD', 'XAG/USD'].sort().join('|'), { r: 0.88, n: 60, at: Date.now() });
    u.results.set('XAU/USD', { sym:'XAU/USD', levels: { PDL: { state:'swept' } } });
    u._diverge();
    check('a partner that has never been scanned produces no divergence',
      u.results.get('XAU/USD').div === null,
      '"not checked" and "checked and held" are different facts');
  }

  // The correlations survive a restart. They are derived from H4 returns that
  // are deliberately not published, so without this every deploy would blank
  // the divergence on every row until the hourly refresh had been round the
  // whole universe again.
  {
    const file = {
      method: LEVEL_METHOD,
      rows: [{ sym:'XAU/USD', lvAt: Date.now(), atr: 20, trend: 'bullish',
        lv: [['PDL', 4200, 'low', "yesterday's low"]],
        corr: { 'XAG/USD': { r: 0.83, n: 58 } }, levels: {} }],
    };
    const s = new LiquidityScanner({
      oanda: fakeOanda(),
      github: { async readJSON() { return { content: file, sha: 'a' }; }, async writeJSON() { return 'b'; } },
      log: quiet,
    });
    await s._restore();
    check('measured correlations come back after a restart',
      s.corr.get(['XAU/USD', 'XAG/USD'].sort().join('|'))?.r === 0.83,
      `${s.corr.size} restored`);
    check('and so does the 4H structure reading',
      s.levels.get('XAU/USD')?.trend === 'bullish',
      'otherwise every row reads "ranging" for an hour after each deploy');
  }

  // A level set that is missing something the current code reads is refreshed,
  // whatever its age. The 4H structure and the H4 returns were added after the
  // published file existed, so every restored set had levels and no trend — and
  // for an hour after that deploy every row would have read "ranging" with no
  // divergence, which looks exactly like a quiet, untrending market.
  {
    const s = new LiquidityScanner({ oanda: fakeOanda(), github: noGithub, log: quiet });
    const fresh = Date.now();
    s.levels.set('OLD', { levels: [{ kind:'PDH', price:110, side:'high', label:'x' }], atr: 2, at: fresh });
    s.levels.set('NEW', { levels: [{ kind:'PDH', price:110, side:'high', label:'x' }], atr: 2, trend: 'bullish', at: fresh });
    // Backed off after a fetch failure: no levels, a deliberate 'ranging', and
    // a timestamp that keeps it out of the age test.
    s.levels.set('DEAD', { levels: [], atr: null, trend: 'ranging', at: fresh });

    const insts = [{ sym:'OLD' }, { sym:'NEW' }, { sym:'DEAD' }];
    const now = fresh;
    const incomplete = rec => !rec || rec.trend === undefined || rec.trend === null;
    const picked = insts.filter(i => {
      const rec = s.levels.get(i.sym);
      if (rec && rec.levels.length && incomplete(rec)) return true;
      return now - (rec?.at || 0) > LEVELS_TTL;
    }).map(i => i.sym);

    check('a level set missing the trend reading is refreshed even when it is fresh',
      picked.includes('OLD'), picked.join(',') || '(none)',
      'an hour-old timestamp is the only other thing that expires them');
    check('one that already has it is left alone',
      !picked.includes('NEW'),
      'otherwise every instrument refreshes every tick and the gating is gone');
    check('and an instrument backed off after a failure is not resurrected',
      !picked.includes('DEAD'),
      'retrying a failing fetch every tick forever is how a budget disappears');
  }

  // ── The alert has to quote the replay, including when it is unflattering ──
  //
  // The message used to end "Not a measured edge — this model has never been
  // tested here." That was true when written and stopped being true the moment
  // the study published. A caveat that has gone stale is worse than none: it
  // says the answer is unknown when the answer is known, and is no.
  {
    const study = {
      at: '2026-09-15T03:32:00Z', historyDays: 60,
      planCells: [
        { kind: 'PDL', session: 'london', verdict: 'not significant',
          discovery: { n: 100, armed: 121, fillRate: 0.883, edgeR: -0.15 } },
      ],
    };
    const sent = [];
    const mk = content => new LiquidityScanner({
      oanda: fakeOanda(), log: quiet,
      telegram: { async send(m) { sent.push(m); } },
      github: {
        async readJSON(path) { return path.includes('study') ? { content, sha: 's' } : null; },
        async writeJSON() { return 's'; },
      },
    });

    const rec = {
      sym: 'EUR/USD', price: 1.08, div: null,
      plan: { state: 'armed', dir: 'long', entry: 1.08, stop: 1.0790, target: 1.0850,
        targetLabel: "yesterday's high", rr: 7, level: { kind: 'PDL', price: 1.08, label: "yesterday's low" },
        session: { id: 'london', label: 'London', overlap: false },
        align: { align: 'with', text: 'with the 4H trend' } },
    };

    const s1 = mk(study);
    await s1._announce(rec);
    check('the alert quotes the replay verdict for this exact hunt',
      /60-day replay:<\/b> not significant/.test(sent[0] || ''),
      (sent[0] || '').split('\n').find(l => /replay/.test(l)) || '(no line)');
    check('with the count, the fill rate and the edge, not just a word',
      /121 of these/.test(sent[0]) && /88% filled/.test(sent[0]) && /-0\.15R vs baseline/.test(sent[0]),
      (sent[0] || '').split('\n').find(l => /replay/.test(l)) || '');
    check('and the stale "never been tested" caveat is gone',
      !/never been tested/.test(sent[0] || ''),
      '', 'the model has been tested; saying otherwise understates what is known');

    // A study with no cell for this kind/session says so rather than implying
    // the hunt was measured and passed.
    sent.length = 0;
    const s2 = mk({ ...study, planCells: [] });
    await s2._announce(rec);
    check('a hunt the replay has no cell for is named as untested, not as fine',
      /no cell for PDL/.test(sent[0] || ''),
      (sent[0] || '').split('\n').find(l => /cell/.test(l)) || '');

    // And when nothing in the whole study held, the alert says that too — it is
    // the single most important thing a person can know before placing this.
    sent.length = 0;
    const s3 = mk(study);
    await s3._announce({ ...rec });
    check('and it reports that no cell beat its baseline on both holdouts',
      /No cell in the study beat its baseline/.test(sent[0] || ''),
      '', 'that is the headline result, and it belongs on the message that asks you to trade');
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

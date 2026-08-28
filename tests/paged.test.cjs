// Paging four years of hourly candles out of OANDA.
//
// One request returns at most 5000 candles — about ten months on H1. A study
// that asks whether the market behaves differently NOW than it did BEFORE needs
// several years, so the client walks the history one window at a time.
//
// The failure modes are unglamorous and all of them are silent. A page that
// does not advance loops until the process is killed. Overlapping pages
// double-count the bars at every boundary, which quietly doubles the sample and
// halves every standard error. A window wider than 5000 bars is rejected by the
// server. None of these announce themselves, so they are checked here.
const path = require('path');
const { OandaClient } = require(path.join(__dirname, '..', 'vps-bot', 'src', 'oanda.js'));

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const H = 3600e3;

const START = Date.UTC(2022, 0, 3);
const END = Date.UTC(2026, 0, 3);

// A fake OANDA that behaves like the real one: it honours from/to, it refuses
// more than 5000 candles in a range, and it does not return the bar that is
// still forming.
const requests = [];
function install({ limit = 5000, gapFrom = null, gapTo = null } = {}) {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    requests.push(u.search);
    const from = Date.parse(u.searchParams.get('from'));
    const to = Date.parse(u.searchParams.get('to'));
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return { ok: false, status: 400, text: async () => 'from and to are required' };
    }
    const candles = [];
    for (let t = Math.ceil(from / H) * H; t <= to; t += H) {
      if (gapFrom != null && t >= gapFrom && t < gapTo) continue;
      candles.push({
        time: new Date(t).toISOString(), complete: t < END,
        mid: { o: '1', h: '2', l: '0.5', c: '1.5' }, volume: 10,
      });
    }
    if (candles.length > limit) {
      return { ok: false, status: 400, text: async () => 'maximum candle count exceeded' };
    }
    return { ok: true, status: 200, json: async () => ({ candles }) };
  };
}

const client = new OandaClient({ apiKey: 'x', accountId: 'y', practice: false });

(async () => {
  // ── The window is sized so the server cannot refuse it ────────────────────
  {
    const span = OandaClient.windowFor('H1');
    check('an hourly window is well under the server\'s five-thousand-candle limit',
      span / H < 5000, `${span / H} bars`);
    check('and a daily one is scaled to daily bars, not left at hourly',
      OandaClient.windowFor('D') > span, 'or four years of dailies takes a thousand requests');
    check('an unknown granularity falls back to something safe rather than NaN',
      Number.isFinite(OandaClient.windowFor('Z9')) && OandaClient.windowFor('Z9') > 0);
  }

  // ── Four years, paged ─────────────────────────────────────────────────────
  {
    requests.length = 0;
    install();
    const cs = await client.getCandlesSince('XAU_USD', 'H1', START, { to: END });
    const hours = (END - START) / H;
    check('four years of hourly bars come back', cs.length > hours * 0.9,
      `${cs.length} of about ${Math.round(hours)}`);
    check('in more than one request, because one could not hold them',
      requests.length > 5, `${requests.length} requests`);
    check('in ascending order', cs.every((c, i) => i === 0 || c.t > cs[i - 1].t));

    // The boundary bar is inside two windows. Counted twice it would inflate
    // every sample in the study and halve every standard error.
    check('with no bar counted twice', new Set(cs.map(c => c.t)).size === cs.length,
      `${cs.length - new Set(cs.map(c => c.t)).size} duplicates`);
    check('and nothing outside the range asked for',
      cs[0].t >= START && cs[cs.length - 1].t <= END);
    check('the still-forming bar is left out', !cs.some(c => c.t >= END));
    check('every request states both ends of its window',
      requests.every(q => q.includes('from=') && q.includes('to=')),
      'from with a count returns whatever the server feels like');
  }

  // ── A hole in the history is a hole, not a hang ───────────────────────────
  // A month with no bars in it — an outage, a delisting, a feed gap. Anchoring
  // the next request on "the last bar received" would stop dead here.
  {
    const gapFrom = START + 400 * 24 * H, gapTo = gapFrom + 40 * 24 * H;
    install({ gapFrom, gapTo });
    const cs = await client.getCandlesSince('XAU_USD', 'H1', START, { to: END });
    check('a forty-day hole does not stop the walk',
      cs.some(c => c.t > gapTo), 'a cursor anchored on the last bar would never get past it');
    check('and the bars after it are all there',
      cs.filter(c => c.t > gapTo).length > 20000,
      String(cs.filter(c => c.t > gapTo).length));
    check('the hole itself stays empty rather than being filled in',
      !cs.some(c => c.t >= gapFrom && c.t < gapTo));
  }

  // ── A short range is one request ──────────────────────────────────────────
  {
    requests.length = 0;
    install();
    const cs = await client.getCandlesSince('XAU_USD', 'H1', END - 100 * H, { to: END });
    check('a hundred bars does not become a hundred requests', requests.length === 1,
      `${requests.length}`);
    check('and still returns them', cs.length >= 99, String(cs.length));
  }

  // ── The cap is honoured ───────────────────────────────────────────────────
  {
    install();
    const cs = await client.getCandlesSince('XAU_USD', 'H1', START, { to: END, max: 500 });
    check('a caller asking for at most five hundred bars gets five hundred',
      cs.length === 500, String(cs.length));
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();

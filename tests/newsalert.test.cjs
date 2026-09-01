// Geopolitical news, fast and accurate.
//
// FAST was three separate delays stacked on each other: a fifteen-minute poll
// floor, a CDN, and a five-minute cache in the app — an average of about
// fifteen minutes from a wire publishing to it reaching the phone, and that is
// only if the phone was already open. For a missile strike that is not a news
// feed.
//
// ACCURATE is the harder half. One outlet reporting a strike is a CLAIM. Three
// within three quarters of an hour is an event. The feed used to throw
// duplicates away and keep the newest, which destroyed exactly the information
// that tells those apart — and kept the LATEST timestamp, so a story that broke
// at 14:12 and was rewritten at 15:40 was filed as 15:40.
const path = require('path');
const N = require(path.join(__dirname, '..', 'vps-bot', 'src', 'newsFetcher.js'));

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const M = 60e3;
const now = Date.UTC(2026, 8, 1, 15, 0);

// ── The poll floor ──────────────────────────────────────────────────────────
{
  check('the news pass runs every three minutes, not every fifteen',
    N.POLL_MS === 3 * 60e3, `${N.POLL_MS / 60e3} minutes`);
  check('and the list is long enough for twelve sources',
    N.MAX_HEADLINES >= 90, String(N.MAX_HEADLINES),
    'a world desk could otherwise crowd out the markets one');
}

// ── Proper nouns are what tell one story from another ───────────────────────
{
  const p = N.properNouns('US strikes Iranian launchers on Larak Island');
  check('capitalised words are pulled out as entities',
    p.has('iranian') && p.has('larak') && p.has('island'), [...p].join(','));
  check('and ordinary words are not',
    !p.has('strikes') && !p.has('launchers'));
  check('short ones are dropped, so U.S. does not become an entity',
    !N.properNouns('U.S. stock futures slip').has('u'));
  check('a leading capital still counts — it is often the entity',
    N.properNouns('Larak island strikes confirmed').has('larak'),
    'skipping the first word loses exactly the headlines that lead with a place');
}

// ── Corroboration ───────────────────────────────────────────────────────────
{
  const wire = [
    { title: 'US strikes Iranian launchers on Larak Island', source: 'Investing', at: now },
    { title: 'Oil jumps after US attack on Iran Larak island', source: 'ForexLive', at: now - 6 * M },
    { title: 'Larak island strikes confirmed by officials', source: 'BBC World', at: now - 9 * M },
    // The false positive that killed two earlier designs.
    { title: 'U.S. stock futures slip as rate hike chances rise after Warsh comments',
      source: 'MarketWatch', at: now - 3 * M },
    { title: 'U.S. stock futures dip amid renewed Iran hostilities', source: 'CNBC', at: now - 4 * M },
  ];
  const c = N.corroborate(wire);
  const byTitle = t => c.find(x => x.title.includes(t));

  check('one event carried by three outlets counts three',
    byTitle('Larak Island').srcs === 3, String(byTitle('Larak Island').srcs));
  check('and is dated when it BROKE, not when the last outlet rewrote it',
    byTitle('Larak Island').firstAt === now - 9 * M,
    new Date(byTitle('Larak Island').firstAt).toISOString().slice(11, 16) + ' vs 15:00');

  // "stock" and "futures" are how the business talks about everything.
  check('two stories sharing only common nouns are NOT one story',
    byTitle('rate hike chances').srcs === 1 && byTitle('renewed Iran hostilities').srcs === 1,
    'they share "stock" and "futures" and are entirely different events');

  check('the same outlet twice is still one source',
    N.corroborate([
      { title: 'Larak island strikes reported', source: 'BBC World', at: now },
      { title: 'Larak island strikes confirmed', source: 'BBC World', at: now - 5 * M },
    ])[0].srcs === 1, 'an outlet corroborating itself is a rewrite, not a second witness');

  check('an hour apart is two stories, not one',
    N.corroborate([
      { title: 'Larak island strikes reported', source: 'BBC World', at: now },
      { title: 'Larak island strikes reported', source: 'CNBC', at: now - 90 * M },
    ])[0].srcs === 1);

  check('a headline with no timestamp cannot be grouped',
    N.corroborate([
      { title: 'Larak island strikes reported', source: 'BBC', at: null },
      { title: 'Larak island strikes confirmed', source: 'CNBC', at: now },
    ])[0].srcs === 1);

  check('everything gets a count, even alone', c.every(x => x.srcs >= 1 && x.firstAt));
}

// ── The wire sources ────────────────────────────────────────────────────────
// Every source was a MARKETS outlet, and geopolitics reaches those second —
// after a wire has run it and after somebody has written the markets angle.
{
  const src = String(require('fs').readFileSync(
    path.join(__dirname, '..', 'vps-bot', 'src', 'newsFetcher.js'), 'utf8'));
  for (const [name, why] of [
    ['aljazeera', 'fastest on the Middle East, which is where gold\'s safe-haven bid comes from'],
    ['bbci.co.uk', 'a wire that runs a strike before any markets desk does'],
    ['news.google.com/rss/search', 'a standing query aggregates every outlet Google indexes'],
  ]) check(`${name} is in the source list`, src.includes(name), why);
  check('and the geopolitical query names the flashpoints rather than the word "news"',
    /Iran OR Israel OR Russia OR Ukraine/.test(src));
}

// ── How often the phone is allowed to buzz ─────────────────────────────────
//
// The arithmetic that the severity and corroboration gates do NOT solve:
// twenty passes an hour times three alerts a pass is sixty pushes, and during
// an active war four wire feeds will genuinely produce ten to twenty distinct
// geopolitical headlines an hour that clear every other gate. A phone that
// buzzes every few minutes has its notifications switched off, and then the
// whole feature is worth nothing.
//
// Simulated here against a real war: one story, many outlets, over an hour.
{
  check('the ceiling is four an hour, not sixty',
    N.MAX_ALERTS_PER_HOUR === 4, String(N.MAX_ALERTS_PER_HOUR));
  check('with a floor of eight minutes between them',
    N.MIN_ALERT_GAP_MS === 8 * 60e3, `${N.MIN_ALERT_GAP_MS / 60e3} minutes`);
  check('and a two-hour memory, so tomorrow\'s Iran story is a new story',
    N.ALERT_MEMORY_MS === 2 * 3600e3);

  // A NewsFetcher with a telegram that records instead of sending.
  const sent = [];
  const mk = () => new N.NewsFetcher({
    github: { readJSON: async () => ({ content: { subscriptions: [] } }) },
    log: () => {},
    telegram: { enabled: true, send: async (t) => { sent.push(t); } },
  });

  // The alert pass reads the wall clock, so this runs against the real one. A
  // burst inside a single pass, then follow-ups, is enough to prove the three
  // behaviours that matter: collapse, escalation, and the gap.
  const fetcher = mk();
  const burst = [0, 1, 2, 3, 4].map(k => ({
    title: `Israel strikes Iranian positions near Larak (${k})`,
    source: ['Al Jazeera', 'BBC World', 'Wires (geo)', 'ForexLive', 'CNBC'][k],
    link: `https://x/${k}`, at: Date.now() - 60e3, sev: 2, srcs: 3,
  }));

  fetcher._alert(burst).then(() => {
    check('five outlets reporting one war is ONE buzz, not five',
      sent.length === 1, `${sent.length} sent`);

    // A second pass on the same running story stays silent.
    const more = [{ title: 'Iran responds to Larak strikes, officials say',
      source: 'BBC World', link: 'https://x/9', at: Date.now(), sev: 2, srcs: 2 }];
    return fetcher._alert(more).then(() => {
      check('and the follow-up three minutes later is silent',
        sent.length === 1, `${sent.length} sent — it shares "Larak" with one already sent`);

      // An ESCALATION gets through the same-story gate.
      const esc = [{ title: 'BREAKING: Iran declares war after Larak strikes',
        source: 'Wires (geo)', link: 'https://x/10', at: Date.now(), sev: 3, srcs: 4 }];
      return fetcher._alert(esc).then(() => {
        check('but an urgent escalation of the same story DOES get through',
          sent.length === 2,
          'suppressing a war declaration because it mentions the same place is worse than one extra buzz');

        // An unrelated story is still gated by the eight-minute floor.
        const other = [{ title: 'Sanctions imposed on Venezuela oil exports',
          source: 'BBC World', link: 'https://x/11', at: Date.now(), sev: 2, srcs: 2 }];
        return fetcher._alert(other).then(() => {
          check('an unrelated heavy story inside eight minutes waits its turn',
            sent.length === 2, `${sent.length} sent`);
          check('nothing is ever alerted twice',
            new Set(sent).size === sent.length);

          console.log(fails ? `\n${fails} FAILED` : '\nall passed');
          process.exit(fails ? 1 : 0);
        });
      });
    });
  });
}


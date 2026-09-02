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

// ── What KIND of thing happened ────────────────────────────────────────────
//
// Every other gate asks how LOUD a headline is — severity words,
// corroboration, whether the theatre has alerted. None asks what kind of event
// it is, and that is the question that decides whether a market moves.
//
// Seven alerts got through in one day. The price beside each says the same
// thing: a fine (+0.53%), a daily wrap (+0.04%), a human-interest angle
// (+0.26%), a consequence (-0.31%), a statement (-0.22%), a reaction (-0.10%).
// Noise, and the noise is measured.
//
// A market prices a war in when it STARTS and when it ENDS, and re-prices when
// something changes its kind. It does not re-price on the fortieth strike
// report, and it never re-prices on a condemnation.
{
  const mustFire = [
    ['Israel launches full-scale invasion of Lebanon', 'war-start'],
    ['Russia declares war on Poland', 'war-start'],
    ['US and Iran agree ceasefire, ending three weeks of strikes', 'war-end'],
    ['Iran closes the Strait of Hormuz to all shipping', 'escalation'],
    ['North Korea conducts nuclear test, seismic data shows', 'escalation'],
    ['Israeli PM Netanyahu killed in strike, officials confirm', 'escalation'],
    ['Fed calls emergency meeting, cuts rates 50bp', 'macro-shock'],
    ['Bank of Japan intervention lifts yen two percent', 'macro-shock'],
  ];
  for (const [t, kind] of mustFire) {
    check(`"${t.slice(0, 44)}" is ${kind}`, N.marketEvent(t) === kind,
      String(N.marketEvent(t)));
  }

  // Verbatim, every one of them, from a phone.
  const realAlerts = [
    ['BREAKING: Citibank fined £4.7m over Russia sanctions breaches', 'a bank fine'],
    ['Stock Market Today: Dow Rises On Surprise Jobs Data (Live Coverage)', 'a daily wrap'],
    ['Air raid alert shatters first day of school in Kyiv after overnight Russian missile strikes',
      'a human-interest angle on a war already priced'],
    ['Seven US Embassies Issue Security Alert Warnings Over Iran Strikes', 'a consequence'],
    ["EU and Nato vow to step up pressure on Russia after 'new escalation'", 'a statement'],
    ['Iran condemns US strikes, says attack on civilian sites killed, injured dozens', 'a reaction'],
    ['Bessent Tells the World to Stay Away From Iran', 'a statement'],
    ['US strikes Iran as state media reports four killed at wedding party',
      'the fortieth strike in a war the market has priced'],
    ['U.S. military conducting fresh strikes in the Strait of Hormuz - Axios',
      'names the strait without closing it'],
  ];
  for (const [t, why] of realAlerts) {
    check(`"${t.slice(0, 40)}" is silent`, N.marketEvent(t) === null, why);
  }

  // A headline about the POSSIBILITY of an event is a headline about a
  // conversation. "Ceasefire talks collapse" contains the word ceasefire and is
  // the opposite of a ceasefire.
  for (const [t, why] of [
    ['Ceasefire talks collapse as Iran rejects terms', 'talks are not a ceasefire'],
    ['Invasion fears mount along the Polish border', 'a fear is not an invasion'],
    ['Analysts warn of possible nuclear escalation', 'an analyst is not a weapon'],
    ['Fed could call an emergency meeting, economists say', 'could is not did'],
    ['Iran may close the Strait of Hormuz, official threatens', 'a threat is not a closure'],
  ]) check(`"${t.slice(0, 40)}" is silent`, N.marketEvent(t) === null, why);

  check('and a headline with nothing in it at all is silent',
    N.marketEvent('Gold slips on profit taking') === null);
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

  // ── The three that actually got through ──────────────────────────────────
  //
  // These are verbatim from a phone, inside two hours, all severity 2, all one
  // war. Suppressing on shared proper nouns did not stop them and could not:
  //
  //   "US strikes Iran ... wedding party"        -> iran
  //   "Iranian media reports ... near Ahvaz"     -> iranian, ahvaz, middle, east
  //   "US military ... Strait of Hormuz"         -> strait, hormuz, axios
  //
  // Not one word shared between any pair. "Iran" and "Iranian" are different
  // strings and Ahvaz, Hormuz and a wedding are genuinely different places, in
  // the same war. The market prices that war in once.
  check('all three real headlines land in the same theatre',
    ['US strikes Iran as state media reports four killed at wedding party',
     'Iranian media reports US missile attack near Ahvaz - Middle East Eye',
     'U.S. military conducting fresh strikes in the Strait of Hormuz - Axios',
    ].every(t => N.theatresIn(t).has('iran')));
  check('and share no proper noun at all, which is why entities could not work',
    N.properNouns('US strikes Iran as state media reports four killed at wedding party')
      .size && ![...N.properNouns('U.S. military conducting fresh strikes in the Strait of Hormuz')]
        .some(w => N.properNouns('US strikes Iran as state media reports four killed').has(w)));
  check('a Ukraine story is a different theatre',
    N.theatresIn('Russia launches drone strikes on Kyiv power grid').has('ukraine')
    && !N.theatresIn('Russia launches drone strikes on Kyiv power grid').has('iran'));
  check('"Israel strikes Iran" belongs to both, so either later is the same story',
    N.theatresIn('Israel strikes Iranian nuclear sites').has('iran')
    && N.theatresIn('Israel strikes Iranian nuclear sites').has('levant'));
  check('an ordinary markets headline belongs to no theatre',
    N.theatresIn('Fed holds rates as inflation cools').size === 0,
    'or every CPI print would be filed as a war');
  check('the theatre stays quiet for four hours, not two',
    N.THEATRE_QUIET_MS === 4 * 3600e3, `${N.THEATRE_QUIET_MS / 3600e3}h`);

  // The alert pass reads the wall clock, so this runs against the real one. A
  // burst inside a single pass, then follow-ups, is enough to prove the three
  // behaviours that matter: collapse, escalation, and the gap.
  const fetcher = mk();
  const burst = [0, 1, 2, 3, 4].map(k => ({
    title: `Israel launches invasion of Iran near Larak (${k})`,
    source: ['Al Jazeera', 'BBC World', 'Wires (geo)', 'ForexLive', 'CNBC'][k],
    link: `https://x/${k}`, at: Date.now() - 60e3, sev: 2, srcs: 3,
  }));

  fetcher._alert(burst).then(() => {
    check('five outlets reporting one war is ONE buzz, not five',
      sent.length === 1, `${sent.length} sent`);

    // A second pass on the same running story stays silent.
    const more = [{ title: 'Iran declares war after the Larak invasion',
      source: 'BBC World', link: 'https://x/9', at: Date.now(), sev: 2, srcs: 2 }];
    return fetcher._alert(more).then(() => {
      check('and the follow-up three minutes later is silent',
        sent.length === 1, `${sent.length} sent — it shares "Larak" with one already sent`);

      // An ESCALATION gets through the same-story gate.
      const esc = [{ title: 'BREAKING: Iran closes the Strait of Hormuz to shipping',
        source: 'Wires (geo)', link: 'https://x/10', at: Date.now(), sev: 3, srcs: 4 }];
      return fetcher._alert(esc).then(() => {
        check('but an urgent escalation of the same story DOES get through',
          sent.length === 2,
          'suppressing a war declaration because it mentions the same place is worse than one extra buzz');

        // An unrelated story is still gated by the eight-minute floor.
        const other = [{ title: 'Venezuela declares war on neighbouring Guyana',
          source: 'BBC World', link: 'https://x/11', at: Date.now(), sev: 2, srcs: 2 }];
        return fetcher._alert(other).then(() => {
          check('an unrelated heavy story inside eight minutes waits its turn',
            sent.length === 2, `${sent.length} sent`);
          check('nothing is ever alerted twice',
            new Set(sent).size === sent.length);

          // ── The price in the alert ─────────────────────────────────────
          //
          // The line that turns a news alert into a trading one. Buzzing "US
          // strikes Iran" invites buying the news after the market has already
          // taken it; "Gold +0.9% since" is the number that says you are late.
          //
          // M1 bars, not H1. The alert fires three minutes after the wire and
          // an H1 bar that began at 21:00 is not complete until 22:00 — on H1
          // the measurement would be null on every alert it was built for.
          // Five minutes old, not thirty: the boot floor is bootAt minus thirty
          // minutes, so a headline exactly that old is a millisecond coin flip
          // on whether it counts as pre-boot. Correct behaviour, terrible test.
          const now2 = Date.now();
          const t0 = now2 - 5 * M;
          const m1 = [];
          for (let k = 0; k < 60; k++) {
            const p = 4400 + (k >= 55 ? (k - 55) * 8 : 0);     // flat, then a rally
            m1.push({ t: now2 - (59 - k) * M, o: p, h: p + 1, l: p - 1, c: p, v: 1 });
          }
          const priced = new N.NewsFetcher({
            github: { readJSON: async () => ({ content: { subscriptions: [] } }) },
            log: () => {},
            telegram: { enabled: true, send: async (x) => { sent.push(x); } },
            oanda: { getCandles: async () => m1 },
          });
          return priced._alert([{ title: 'BREAKING: Venezuela closes its ports in a blockade',
            source: 'Wires (geo)', link: 'vz', at: t0, sev: 3, srcs: 3 }]).then(() => {
            const last = sent[sent.length - 1];
            check('the alert carries what the metals did since it broke',
              /Gold \+\d/.test(last) && /since/.test(last), last.split('\n').pop());
            // Fifty-five flat minutes, then a rally of eight a bar. The headline
            // sits on the turn five minutes ago, so the move since is 32/4400.
            check('measured on M1 bars, so it is not null five minutes in',
              /Gold \+0\.7\d%/.test(last),
              'on H1 the bar the headline landed in would not close for another hour');

            // No OANDA, or a market that was shut, says nothing rather than 0.00%.
            const dumb = new N.NewsFetcher({
              github: { readJSON: async () => ({ content: { subscriptions: [] } }) },
              log: () => {}, telegram: { enabled: true, send: async (x) => { sent.push(x); } },
            });
            return dumb._alert([{ title: 'BREAKING: Taiwan blockade begins',
              source: 'BBC World', link: 'tw', at: Date.now() - M, sev: 3, srcs: 2 }]);
          }).then(() => {
            check('without prices the alert simply omits the line',
              !/since/.test(sent[sent.length - 1]),
              'a 0.00% would read as "the market did not care", which is a different claim');

            // ── Quiet hours ──────────────────────────────────────────────
            check('the window is 23:00 to 07:00 Toronto',
              N.QUIET_FROM === 23 && N.QUIET_TO === 7 && N.QUIET_TZ === 'America/Toronto');
            const at = (h) => Date.UTC(2026, 8, 2, h, 0);
            check('four in the morning Toronto is quiet', N.inQuietHours(at(8)),
              `${N.hourIn('America/Toronto', at(8))}:00 local`);
            check('and the middle of the New York session is not', !N.inQuietHours(at(18)),
              `${N.hourIn('America/Toronto', at(18))}:00 local`);
            check('the window wraps past midnight rather than being empty',
              N.inQuietHours(at(3)) && N.inQuietHours(at(4)) && N.inQuietHours(at(10))
              && !N.inQuietHours(at(11)),
              'from 23 to 7 has to mean 23, 0, 1 ... 6 — and 07:00 is when it ends');
            check('a named zone, so it does not drift by an hour twice a year',
              N.hourIn('America/Toronto', Date.UTC(2026, 0, 15, 12)) !==
              N.hourIn('America/Toronto', Date.UTC(2026, 6, 15, 12)),
              'January and July differ by exactly the DST hour');
            check('an unknown zone means no quiet hours rather than a crash',
              N.hourIn('Not/AZone') === null && N.inQuietHours(Date.now(), 'Not/AZone') === false);

            return null;
          }).then(() => {

          // And the real sequence, replayed.
          const war = mk();
          // Three genuine escalations in the same theatre — the theatre gate,
          // not the kind gate, is what has to collapse these.
          const real = [
            ['Israel launches invasion of Iran', 'BBC World'],
            ['Iran declares war on Israel', 'Wires (geo)'],
            ['Iranian blockade of the Gulf begins', 'Wires (geo)'],
          ];
          const before = sent.length;
          return real.reduce((chain, [title, source]) => chain.then(() =>
            war._alert([{ title, source, link: title, at: Date.now() - 60e3, sev: 2, srcs: 2 }])
          ), Promise.resolve()).then(() => {
            check('the three real alerts collapse to one',
              sent.length - before === 1, `${sent.length - before} sent, was 3`);
            return war._alert([{ title: 'BREAKING: Iran nuclear weapon detonated in test',
              source: 'Wires (geo)', link: 'esc', at: Date.now(), sev: 3, srcs: 4 }]);
          }).then(() => {
            check('a genuine escalation of that war still gets through',
              sent.length - before === 2,
              'closing Hormuz is a new event to trade, not the same one reported again');
            return war._alert([{ title: 'Russia declares war on Poland',
              source: 'BBC World', link: 'ru', at: Date.now(), sev: 3, srcs: 3 }]);
          }).then(() => {
            check('and a different war is a different alert',
              sent.length - before === 3, `${sent.length - before}`);

            console.log(fails ? `\n${fails} FAILED` : '\nall passed');
            process.exit(fails ? 1 : 0);
          });
          });

        });
      });
    });
  });
}


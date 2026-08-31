// One vocabulary for what a headline is about, because there were two and they
// had drifted into different CAPABILITIES rather than merely different code.
//
// The bot's copy knew currencies and carried a stop-list of names that contain
// a currency word and mean nothing by it. The app's copy knew seventeen
// instruments including every index, and knew to fan a purely macro headline
// across the dollar complex. Neither knew what the other did — so a US500 card
// showed Treasury and Fed stories, tagged USD because that side had no equities
// vocabulary at all, while the news screen three tabs away tagged the same
// headline to US500 correctly.
import { tagInstruments, currenciesIn, severity, relevanceOf, labelHeadline,
         INSTRUMENT_KEYWORDS, isGeopolitical, isJunk } from '../shared/newsTagging.mjs';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

// ── The case that started this ───────────────────────────────────────────────
{
  const t = 'S&P 500 climbs as tech stocks lead Wall Street higher';
  check('an equities headline tags the index, not the dollar',
    tagInstruments(t).includes('US500'), JSON.stringify(tagInstruments(t)));
  check('and the Nasdaq separately', tagInstruments('Nasdaq futures slip on big tech weakness').includes('US100'));
  check('and the Dow', tagInstruments('Dow Jones ends flat').includes('US30'));
  check('indices exist in the vocabulary at all',
    ['US500', 'US100', 'US30'].every(k => k in INSTRUMENT_KEYWORDS),
    'the bot side had no equities words, which is why index cards showed USD stories');
}

// ── The stop-list, which only one side had ───────────────────────────────────
// Word boundaries alone do not catch these: "canada" is a whole word inside
// "Canada Goose". The app's copy had no stop-list and would have tagged it.
{
  const cases = [
    ['Canada Goose shares fall 8% on weak guidance', 'USD/CAD', 'CAD'],
    ['Goldman Sachs raises its S&P 500 target',      'XAU/USD', 'XAU'],
    ['Silver Lake nears deal for software firm',     'XAG/USD', 'XAG'],
    ['Boeing wins order from flag carrier',          'GBP/USD', 'GBP'],
    ['Audit finds errors at regional lender',        'AUD/USD', 'AUD'],
  ];
  for (const [title, inst, ccy] of cases) {
    check(`"${title.slice(0, 34)}…" is not about ${ccy}`,
      !tagInstruments(title).includes(inst) && !currenciesIn(title).includes(ccy),
      `inst ${JSON.stringify(tagInstruments(title))} ccy ${JSON.stringify(currenciesIn(title))}`);
  }
  check('but the real thing still tags', tagInstruments('Gold hits record high above $4,400').includes('XAU/USD'));
  check('and Goldman raising an S&P target is still an equities story',
    tagInstruments('Goldman Sachs raises its S&P 500 target').includes('US500'),
    'suppressing gold must not suppress the headline entirely');
}

// ── Word boundaries ──────────────────────────────────────────────────────────
{
  check('"European" is not "euro"', !tagInstruments('European shares steady').includes('EUR/USD'),
    JSON.stringify(tagInstruments('European shares steady')));
  check('but "euro" is', tagInstruments('Euro slips as ECB holds').includes('EUR/USD'));
  check('a general equities line still reads as market colour',
    relevanceOf('European shares steady', tagInstruments('European shares steady')) >= 1);
}

// ── Macro fan-out, which only the app side had ───────────────────────────────
{
  const macro = tagInstruments('Fed holds rates as Powell signals patience');
  check('a purely macro headline reaches the dollar complex',
    macro.length > 3 && macro.includes('XAU/USD') && macro.includes('US500'),
    JSON.stringify(macro));
  const named = tagInstruments('Gold surges as the dollar weakens after the Fed');
  check('but a named instrument wins over the fan-out',
    named.length === 1 && named[0] === 'XAU/USD', JSON.stringify(named));
}

// ── Severity ─────────────────────────────────────────────────────────────────
{
  check('breaking copy is loudest', severity('BREAKING: central bank announces intervention') === 3);
  check('a scheduled heavyweight is next', severity('US CPI comes in hotter than expected') === 2);
  check('a market wrap is ordinary', severity('Asia-Pacific market news: oil down, AUD firmer') === 1);
}

// ── The description, which was parsed past and thrown away ───────────────────
// RSS carries a lede paragraph. Without it "Fed rate decision delayed" and
// "Fed rate decision shocks markets" are the same headline to a matcher.
{
  const bare = labelHeadline('Board meeting moved to Thursday');
  const withBody = labelHeadline('Board meeting moved to Thursday',
    'The unscheduled delay halted trading in gold futures across Asia.');
  check('the description changes severity when it carries the news',
    bare.sev === 1 && withBody.sev === 3, `${bare.sev} → ${withBody.sev}`);
  check('and adds a tag the headline alone never had',
    !bare.inst.length && withBody.inst.includes('XAU/USD'),
    `${JSON.stringify(bare.inst)} → ${JSON.stringify(withBody.inst)}`);
  check('an absent description changes nothing',
    JSON.stringify(labelHeadline('Gold rises')) === JSON.stringify(labelHeadline('Gold rises', '')));
}

// ── One pass, four labels ────────────────────────────────────────────────────
{
  const l = labelHeadline('Oil prices slide over 2% following report of U.S.-Iran ceasefire');
  check('a headline is labelled with instruments, currencies, severity and relevance',
    l.inst.includes('USOIL') && l.ccy.includes('OIL') && l.sev >= 2 && l.rel === 2,
    JSON.stringify(l));
  const junk = labelHeadline('Zoetis earnings reveal a divided business');
  check('corporate wire copy scores zero relevance and is hidden by default',
    junk.rel === 0 && !junk.inst.length, JSON.stringify(junk));
}


// ── The three lists that disagreed with each other ─────────────────────────
//
// Measured on a live feed: 47 of 60 headlines came back with no instrument and
// no currency. The worst of them was
//
//   "U.S. stock futures slip as chances of rate hike rise after Warsh's
//    Jackson Hole comments"
//
// which this same file scored severity 2 — market-moving — and relevance 2 —
// directly tradeable — while tagging it as being about nothing. The app knew
// the headline mattered and could not say what it was about, so it never
// reached a card and the desk's news analyst read an empty page during a live
// gold selloff and an Iran war.
{
  const H = 'U.S. stock futures slip as chances of rate hike rise after Warsh\u2019s Jackson Hole comments';
  const L = labelHeadline(H);
  check('a rate-hike headline reaches the dollar complex', L.inst.includes('XAU/USD') && L.ccy.includes('USD'),
    JSON.stringify(L));
  check('and is still scored market-moving, as it always was', L.sev === 2);
  check('what it is ABOUT and how much it MATTERS can no longer disagree',
    L.sev >= 2 && (L.inst.length > 0 || L.ccy.length > 0),
    'severity knew fourteen words, relevance knew thirty-seven, tagging knew eleven');

  for (const [h, why] of [
    ['Treasury Secretary Bessent presses G20 on trade surplus', 'fiscal and trade move the dollar too'],
    ['Fed officials signal a slower rate path', 'policy language, not just the word Fed'],
    ['Hawkish tone at the Beige Book briefing', 'the adjectives wires actually use'],
    ['US inflation runs hotter than forecast', 'data'],
  ]) check(`"${h.slice(0, 44)}" reaches the dollar`, labelHeadline(h).ccy.includes('USD'), why);
}

// ── Gold IS the safe-haven trade ───────────────────────────────────────────
// The app had no connection between geopolitics and gold at all, on a board
// whose main instrument is gold.
{
  const iran = labelHeadline('U.S. stock futures dip amid renewed Iran hostilities');
  check('a conflict headline is a gold headline', iran.inst.includes('XAU/USD'), JSON.stringify(iran.inst));
  check('and an oil one when the flashpoint is an oil producer', iran.inst.includes('USOIL'));

  const ceasefire = labelHeadline('Oil prices slide over 2% following report of U.S.-Iran ceasefire');
  check('geopolitics is added to what a headline already names, not instead of it',
    ceasefire.inst.includes('USOIL') && ceasefire.inst.includes('XAU/USD'),
    JSON.stringify(ceasefire.inst) + ' — a named instrument used to short-circuit everything after it');

  check('an unambiguous risk word stands alone', isGeopolitical('Missile strike reported overnight'));
  check('a place alone is not a conflict',
    !isGeopolitical('Ukraine seeks U.S. investment for defence technology fund'),
    'naming a country in a war is not the same as reporting the war');

  // 'attack' and 'strikes' were in the risk list for one run and came out again.
  for (const clean of [
    'Aon strikes a deal to buy USI Insurance from KKR',
    'Union strikes hit Ford plants',
    'Powell strikes a cautious tone',
    'Rival factions stand off in Niger capital after mutineers attack airport',
  ]) check(`"${clean.slice(0, 40)}" is not a gold story`, !isGeopolitical(clean),
    'ordinary English, and it tagged a Niger mutiny as a safe-haven event');

  check('but the same words alongside a flashpoint are',
    isGeopolitical('Oil jumps after US attack on Iran\u2019s Larak island')
    && isGeopolitical('U.S. strikes Iranian launchers on Larak Island'),
    'taking them out entirely dropped two live war headlines');
  check('adjectival forms count, because matching is whole-word',
    isGeopolitical('Israeli military action reported'), '"Iranian" does not contain the word "iran"');
}

// ── Not news at any price ──────────────────────────────────────────────────
// MarketWatch's feed carries an advice column. Those items are newer than a Fed
// story, the fetcher kept the sixty most recent, and they were pushing real news
// off the end of the list.
{
  for (const junk of [
    '\u2018It\u2019s the ultimate regifting\u2019: My mom gave me a house. Should I transfer it back to her?',
    'I\u2019m single, 74, with $10 million burning a hole in my pocket',
    'My father funded my $800,000 Roth IRA. Does that give him the right to say how I invest?',
    'My mother, 91, has dementia. Every bank says I need her signature',
  ]) check(`"${junk.slice(0, 40)}" is not news`, isJunk(junk));

  check('and it is scored zero even when it mentions markets',
    relevanceOf('My mother left me $2 million in stocks. Should I sell?', []) === 0,
    'some of them mention stocks or investors and would otherwise score as market colour, '
    + 'which is why the check runs before relevance rather than inside it');

  // The rule deliberately NOT used: "headline opens with a quotation mark".
  const quoted = '\u2018We are not done\u2019: Powell says more hikes may be needed';
  check('a quoted wire headline is not caught by the junk filter', !isJunk(quoted));
  check('and still reaches the dollar', labelHeadline(quoted).ccy.includes('USD'),
    'a quote-opening rule would have thrown away exactly the headline this change exists to keep');

  check('ordinary corporate news is not junk, only irrelevant',
    !isJunk('Aon close to acquiring USI Insurance from KKR in $17 billion deal')
    && relevanceOf('Aon close to acquiring USI Insurance from KKR in $17 billion deal', []) === 0,
    'it can fill a spare slot; it must never take one');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

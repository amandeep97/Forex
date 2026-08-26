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
         INSTRUMENT_KEYWORDS } from '../shared/newsTagging.mjs';

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

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

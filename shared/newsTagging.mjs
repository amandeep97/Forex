// shared/newsTagging.mjs
// What a headline is about — the one copy.
//
// There were two, and they had drifted into different capabilities rather than
// merely different code. The bot's version knew currencies and carried a
// stop-list of names that contain a currency word and mean nothing by it:
// Goldman is not bullion, Canada Goose is not the loonie. The app's version
// knew seventeen instruments, including every index, and knew that a purely
// macro headline should fan out across the dollar complex.
//
// Neither knew what the other did. So an index card on the Command Center
// received DOLLAR stories — US500 mapped to USD and there was no equities
// vocabulary on that side at all — while the news screen, three tabs away, was
// tagging the same headline to US500 correctly. That is not two bugs. It is one
// vocabulary stored twice.
//
// This is the union: the app's instruments and macro fan-out, the bot's
// currencies and stop-list. Pure ESM, no DOM and no Node, so the app imports it
// directly and the bot loads it with a dynamic import() — the same arrangement
// shared/feedConditions.mjs already uses.

// ── Instruments ──────────────────────────────────────────────────────────────
export const INSTRUMENT_KEYWORDS = {
  'XAU/USD':  ['gold', 'bullion', 'xau', 'precious metal', 'safe haven', 'safe-haven'],
  'XAG/USD':  ['silver', 'xag'],
  'EUR/USD':  ['euro', 'ecb', 'eurozone', 'lagarde', 'bundesbank', 'german', 'germany'],
  'GBP/USD':  ['pound', 'sterling', 'boe', 'bank of england', 'bailey', 'britain', 'british'],
  'USD/JPY':  ['yen', 'boj', 'bank of japan', 'ueda', 'japan', 'japanese'],
  'AUD/USD':  ['aussie', 'rba', 'australia', 'australian'],
  'NZD/USD':  ['kiwi', 'rbnz', 'new zealand'],
  'USD/CAD':  ['loonie', 'boc', 'bank of canada', 'macklem', 'canada', 'canadian'],
  'USD/CHF':  ['franc', 'snb', 'swiss', 'switzerland'],
  'USOIL':    ['oil', 'crude', 'wti', 'opec', 'barrel', 'petroleum'],
  'UKOIL':    ['brent', 'crude', 'opec'],
  'NATGAS':   ['natural gas', 'natgas', 'lng'],
  'US500':    ['s&p', 'sp500', 's&p 500', 'wall street', 'equities', 'stocks'],
  'US100':    ['nasdaq', 'tech stocks', 'big tech'],
  'US30':     ['dow', 'dow jones'],
  'BTC/USDT': ['bitcoin', 'btc', 'crypto'],
  'ETH/USDT': ['ethereum', 'ether', 'eth'],
};

// Macro USD events that genuinely move everything priced in dollars.
// Deliberately excludes the bare word "dollar" — it appears in most FX
// headlines and would fan every story out across seven instruments.
//
// This list was eleven words while severity() knew fourteen and relevanceOf()
// knew thirty-seven, and the three disagreed. Measured on a live feed: 47 of 60
// headlines came back tagged with no instrument and no currency at all, and the
// worst of them was
//
//   "U.S. stock futures slip as chances of RATE HIKE rise after Warsh's
//    Jackson Hole comments"
//
// which the same file scored severity 2 — market-moving — and relevance 2 —
// directly tradeable — while tagging it as being about nothing. The app knew
// the headline mattered and simultaneously could not say what it was about, so
// it never reached a card, and the news analyst read an empty page during a
// live gold selloff.
//
// Only reached when no specific instrument matched, so widening it cannot
// steal a headline that names its own market.
const USD_MACRO = [
  'fed', 'fomc', 'powell', 'treasury', 'nonfarm', 'payroll', 'nfp',
  'cpi', 'pce', 'jobless', 'rate decision',
  // Policy, in the words wires actually use.
  'rate hike', 'rate cut', 'interest rate', 'rate path', 'monetary policy',
  'hawkish', 'dovish', 'quantitative', 'beige book', 'jackson hole',
  'fed chair', 'fed official', 'fed governor', 'federal reserve', 'central bank',
  // Data.
  'ppi', 'inflation', 'unemployment', 'ism', 'retail sales', 'gdp',
  // Fiscal and trade, which move the dollar as hard as the Fed does.
  'tariff', 'trade deficit', 'trade surplus', 'debt ceiling', 'shutdown',
  'treasury secretary', 'yield curve', 'real yield',
  // The one part of this list that ages: the people currently holding the jobs.
  // Worth having anyway — a wire writes the surname, not the office.
  'powell', 'warsh', 'bessent', 'waller', 'bowman', 'williams', 'yellen',
];
const USD_AFFECTED = ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'US500'];

// ── Geopolitics ──────────────────────────────────────────────────────────────
//
// Gold IS the safe-haven trade. That is most of what it is for, and the app had
// no connection between the two at all: "U.S. stock futures dip amid renewed
// Iran hostilities" was tagged as being about nothing, on a board whose main
// instrument is gold.
//
// A risk WORD is required, not just a place. "Ukraine seeks U.S. investment for
// a defence fund" names a country in a war and is not a gold story; "renewed
// Iran hostilities" is. Places alone would tag every trade-delegation wrap as a
// safe-haven event.
//
// 'attack' and the bare 'strikes' were in this list for one run and came out
// again. They are ordinary English — a company strikes a deal, a union strikes,
// an airport is attacked in a local mutiny — and they tagged "Rival factions
// stand off in Niger capital after mutineers attack airport" as a gold story.
// The specific compounds below carry the same meaning without the collisions.
const GEO_RISK = ['war', 'warfare', 'ceasefire', 'truce', 'sanction', 'sanctions', 'invasion',
  'missile', 'airstrike', 'air strike', 'drone strike', 'hostilities', 'military strike',
  'nuclear', 'coup', 'terror', 'escalation', 'retaliation'];

// Words that mean conflict only in the right company. Taking 'attack' and
// 'strikes' out entirely was too blunt the other way: it dropped "US attack on
// Iran's Larak island" and "U.S. strikes Iranian launchers", which are gold
// stories by any reading. So these count only alongside a named flashpoint —
// which is why "mutineers attack airport" in Niger still does not qualify, and
// why "strikes a deal" never will.
const GEO_SOFT = ['attack', 'attacks', 'strike', 'strikes', 'troops', 'military',
  'conflict', 'tensions', 'blockade', 'seizes', 'shelling'];

// The places a conflict has to involve. Adjectival forms are listed explicitly
// because matching is whole-word: "Iranian" does not contain the word "iran".
const GEO_PLACES = ['iran', 'iranian', 'israel', 'israeli', 'gaza', 'lebanon', 'hezbollah',
  'houthi', 'middle east', 'hormuz', 'red sea', 'russia', 'russian', 'ukraine', 'ukrainian',
  'taiwan', 'north korea', 'venezuela', 'venezuelan', 'libya', 'nigeria', 'saudi'];

// The subset of those that moves a barrel as well as an ounce.
const GEO_ENERGY = ['iran', 'iranian', 'israel', 'israeli', 'gaza', 'middle east', 'hormuz',
  'red sea', 'houthi', 'russia', 'russian', 'ukraine', 'ukrainian',
  'opec', 'venezuela', 'libya', 'nigeria', 'saudi'];

// ── Currencies ───────────────────────────────────────────────────────────────
export const CURRENCY_WORDS = {
  USD: ['dollar', 'greenback', 'fed', 'fomc', 'powell', 'treasury', 'nfp', 'payrolls'],
  EUR: ['euro', 'ecb', 'lagarde', 'eurozone', 'bund'],
  GBP: ['pound', 'sterling', 'boe', 'gilt', 'bailey'],
  JPY: ['yen', 'boj', 'ueda', 'japan'],
  CHF: ['franc', 'snb', 'swiss'],
  AUD: ['aussie', 'rba', 'australia'],
  NZD: ['kiwi', 'rbnz', 'new zealand'],
  CAD: ['loonie', 'boc', 'canada'],
  XAU: ['gold', 'bullion'],
  XAG: ['silver'],
  OIL: ['oil', 'crude', 'wti', 'brent', 'opec'],
  BTC: ['bitcoin', 'crypto'],
};

// Names that contain a currency word and have nothing to do with the currency.
// Word boundaries alone do not catch these — "canada" is a whole word inside
// "Canada Goose" — and the match decides which instrument's card a headline
// lands on, so a wrong one is not untidy, it is evidence on the wrong market.
export const NOT_ABOUT = [
  ['goldman', 'XAU'], ['golden', 'XAU'], ['gold coast', 'XAU'], ['goldmine', 'XAU'],
  ['silver lake', 'XAG'], ['silverstone', 'XAG'],
  ['canada goose', 'CAD'],
  ['boeing', 'GBP'],           // 'boe'
  ['audit', 'AUD'], ['audio', 'AUD'], ['audience', 'AUD'],
  ['oilers', 'OIL'],
];

// Which instrument a stop-list entry should also suppress, so the same
// exclusion works on both vocabularies from one list.
const CCY_TO_INSTRUMENTS = {
  XAU: ['XAU/USD'], XAG: ['XAG/USD'], CAD: ['USD/CAD'], GBP: ['GBP/USD'],
  AUD: ['AUD/USD'], OIL: ['USOIL', 'UKOIL'], EUR: ['EUR/USD'], JPY: ['USD/JPY'],
  CHF: ['USD/CHF'], NZD: ['NZD/USD'], BTC: ['BTC/USDT'], USD: [],
};

// Whole-word matching. Plain substring search is wrong here: "euro" appears
// inside "European", so "European shares steady" tagged EUR/USD — a currency
// tag on an equities story. Compiled once; this runs per headline.
const boundary = w => new RegExp(`(^|[^a-z])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
const compile = words => words.map(boundary);
const anyMatch = (rxs, t) => rxs.some(r => r.test(t));

const INSTRUMENT_RX = Object.fromEntries(
  Object.entries(INSTRUMENT_KEYWORDS).map(([k, w]) => [k, compile(w)]));
const CURRENCY_RX = Object.fromEntries(
  Object.entries(CURRENCY_WORDS).map(([k, w]) => [k, compile(w)]));
const USD_MACRO_RX = compile(USD_MACRO);
const GEO_RISK_RX = compile(GEO_RISK);
const GEO_SOFT_RX = compile(GEO_SOFT);
const GEO_PLACES_RX = compile(GEO_PLACES);
const GEO_ENERGY_RX = compile(GEO_ENERGY);

// A geopolitical risk story, which is a gold story whatever else it is about.
//
// Two tiers. An unambiguous risk word on its own — war, ceasefire, invasion,
// airstrike. Or an ambiguous one alongside a named flashpoint, so "US attack on
// Iran's Larak island" counts and "Aon strikes a deal" does not.
export function isGeopolitical(text) {
  const t = String(text || '').toLowerCase();
  if (anyMatch(GEO_RISK_RX, t)) return true;
  return anyMatch(GEO_SOFT_RX, t) && anyMatch(GEO_PLACES_RX, t);
}

// What the stop-list blocks for a given text, as currency codes.
function blockedBy(low) {
  return new Set(NOT_ABOUT.filter(([n]) => low.includes(n)).map(([, c]) => c));
}

export function tagInstruments(text) {
  const t = String(text || '').toLowerCase();
  const blocked = blockedBy(t);
  const blockedInst = new Set([...blocked].flatMap(c => CCY_TO_INSTRUMENTS[c] || []));

  const specific = [];
  for (const [inst, rxs] of Object.entries(INSTRUMENT_RX)) {
    if (blockedInst.has(inst)) continue;
    if (anyMatch(rxs, t)) specific.push(inst);
  }
  // Geopolitics is ADDITIVE rather than a fan-out, because it does not replace
  // what a headline is about — it adds gold to it. "Oil slides on a US-Iran
  // ceasefire" is an oil story AND a gold story, and the old rule returned only
  // the first because a named instrument short-circuited everything after it.
  const geo = isGeopolitical(t);
  const add = [];
  if (geo && !blockedInst.has('XAU/USD')) add.push('XAU/USD');
  if (geo && anyMatch(GEO_ENERGY_RX, t) && !blockedInst.has('USOIL')) add.push('USOIL', 'UKOIL');

  // A named instrument otherwise wins: "Gold surges as dollar weakens" is a gold
  // story, not a seven-instrument story. Only fan out to the USD complex when
  // the headline is purely macro with nothing specific named.
  if (specific.length || add.length) {
    return [...new Set([...specific, ...add])];
  }
  if (anyMatch(USD_MACRO_RX, t)) return [...USD_AFFECTED];
  return [];
}

export function currenciesIn(text) {
  const t = String(text || '').toLowerCase();
  const blocked = blockedBy(t);
  const hit = [];
  for (const [code, rxs] of Object.entries(CURRENCY_RX)) {
    if (blocked.has(code)) continue;
    if (anyMatch(rxs, t)) hit.push(code);
  }
  // The same two additions as on the instrument side, so a card and a currency
  // filter cannot disagree about whether a war is a gold story.
  if (isGeopolitical(t)) {
    if (!blocked.has('XAU') && !hit.includes('XAU')) hit.push('XAU');
    if (anyMatch(GEO_ENERGY_RX, t) && !blocked.has('OIL') && !hit.includes('OIL')) hit.push('OIL');
  }
  if (!hit.includes('USD') && !blocked.has('USD') && anyMatch(USD_MACRO_RX, t)) hit.push('USD');
  return hit;
}

// ── Severity: how much a headline deserves your attention ────────────────────
const URGENT = ['breaking', 'just in', 'alert', 'emergency', 'surprise', 'unscheduled',
                'halts', 'halted', 'intervention'];
// 'ceasefire' and 'tariff' were missing while 'war' and 'sanction' were
// present, which is asymmetric in a way that showed: "Oil prices slide over 2%
// following report of U.S.-Iran ceasefire" scored as ordinary market colour on
// a live feed, next to a routine Asia wrap. The end of a war moves a barrel as
// much as the start of one. Both words are already in MACRO_WORDS below as
// drivers, so this only brings severity into line with what relevance already
// believed.
//
// 'opec' is deliberately NOT here despite being a driver: it is a standing body
// named in every routine crude wrap, and it would mark the whole oil stream
// heavyweight.
// The same asymmetry this comment already describes, one level deeper: 'war'
// and 'ceasefire' were heavyweight while 'hostilities', 'invasion', 'airstrike'
// and 'escalation' were ordinary, so "U.S. stock futures dip amid renewed Iran
// hostilities" scored as market colour. The risk vocabulary is now shared with
// the geopolitical tagger rather than being a third hand-kept list that drifts
// from the other two — which is the defect this whole change is about.
const HEAVY = ['rate decision', 'rate cut', 'rate hike', 'fomc', 'cpi', 'nonfarm', 'payroll',
               'gdp', 'inflation', 'tariff', 'default', 'downgrade', ...GEO_RISK];

export function severity(text) {
  const t = String(text || '').toLowerCase();
  if (URGENT.some(w => t.includes(w))) return 3;   // red
  if (HEAVY.some(w => t.includes(w)))  return 2;   // amber
  return 1;                                        // normal
}

// ── Relevance: is this a markets story at all? ───────────────────────────────
// A forex terminal fed raw wire copy fills with corporate news — airline fares,
// cinema deals, harassment suits. Useful to a general desk, noise here.
const MACRO_WORDS = ['central bank', 'interest rate', 'rate cut', 'rate hike', 'inflation', 'cpi',
  'ppi', 'gdp', 'unemployment', 'payroll', 'jobless', 'recession', 'tariff', 'sanction', 'stimulus',
  'yield', 'bond', 'treasury', 'fed', 'fomc', 'ecb', 'boe', 'boj', 'rba', 'rbnz', 'snb', 'opec',
  'war', 'ceasefire', 'monetary', 'fiscal', 'hawkish', 'dovish'];
const MARKET_WORDS = ['stocks', 'shares', 'equities', 'index', 'futures', 'commodity', 'commodities',
  'currency', 'forex', 'fx', 'market', 'markets', 'rally', 'selloff', 'sell-off', 'dollar',
  'investors', 'trading'];
const MACRO_RX  = compile(MACRO_WORDS);
const MARKET_RX = compile(MARKET_WORDS);

// Not news at any price.
//
// MarketWatch's feed carries a personal-finance advice column, and it was
// filling the board: five of fourteen headlines in one sample were "My mom gave
// me a house", "I'm single, 74, with $10 million burning a hole in my pocket",
// "My mother, 91, has dementia". Those are newer than a Fed story, the fetcher
// keeps the sixty most recent, and so they were pushing real news off the list —
// which is the other half of why the news analyst saw three headlines.
//
// Some of them mention stocks or investors and would otherwise score as market
// colour, so this has to run BEFORE relevance rather than as one more word list
// inside it.
//
// Deliberately narrow. Patterns keyed on family members and retirement accounts
// are unambiguous; a rule like "headline opens with a quotation mark" would also
// catch «'We are not done': Powell says», which is exactly the headline this
// whole change exists to keep.
const NOT_NEWS = [
  /\bmy (mom|mum|mother|father|dad|husband|wife|son|daughter|sister|brother|parents|in-laws?|stepmother|stepfather|boyfriend|girlfriend|widow|late (husband|wife))\b/,
  /\b(roth ira|401\(?k\)?|social security benefits?|estate plan|inheritance|my will|prenup)\b/,
  /\bdear (quentin|moneyist|penny|therapist)\b/,
  /\b(should i|am i (being )?(wrong|unreasonable|entitled|greedy))\b/,
  // "I'm 74" and "I'm single, 74, with $10 million burning a hole in my
  // pocket" are the same column; the age does not always sit next to the verb.
  /\bi'?m\b[a-z,\s]{0,24}\b\d{2}\b/,
  /\bi am\b[a-z,\s]{0,24}\b\d{2}\b/,
];

// Wires punctuate with typographic quotes — I'm, 'regifting' — and a pattern
// written with a straight apostrophe silently matches none of them. Normalised
// before matching rather than doubling every pattern.
const straighten = t => String(t || '').toLowerCase()
  .replace(/[\u2018\u2019\u02bc\u00b4`]/g, "'")
  .replace(/[\u201c\u201d]/g, '"');

export const isJunk = text => NOT_NEWS.some(rx => rx.test(straighten(text)));

// 2 = directly tradeable (tagged instrument or macro driver)
// 1 = general market colour
// 0 = corporate / off-topic / not news at all
export function relevanceOf(text, instruments) {
  const t = String(text || '').toLowerCase();
  if (isJunk(text)) return 0;
  if (instruments?.length) return 2;
  if (anyMatch(MACRO_RX, t)) return 2;
  if (anyMatch(MARKET_RX, t)) return 1;
  return 0;
}

// Everything a headline can be labelled with, from one pass. The bot computes
// this once and publishes it, so the phone does not recompute seventeen regex
// sets over sixty headlines on every render — and so the labels on a card and
// the labels on the news screen cannot disagree.
export function labelHeadline(title, description = '') {
  // The description is scanned too. RSS carries a lede paragraph that this
  // project parsed past and discarded for its whole existence, and it is often
  // the half that says what actually happened.
  const text = description ? `${title} ${description}` : String(title || '');
  const inst = tagInstruments(text);
  return {
    inst,
    ccy: currenciesIn(text),
    sev: severity(text),
    rel: relevanceOf(text, inst),
  };
}

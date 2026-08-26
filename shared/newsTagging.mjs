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
const USD_MACRO = ['fed', 'fomc', 'powell', 'treasury', 'nonfarm', 'payroll', 'nfp',
                   'cpi', 'pce', 'jobless', 'rate decision'];
const USD_AFFECTED = ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'US500'];

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
  // A named instrument always wins: "Gold surges as dollar weakens" is a gold
  // story, not a seven-instrument story. Only fan out to the USD complex when
  // the headline is purely macro with nothing specific named.
  if (specific.length) return specific;
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
const HEAVY  = ['rate decision', 'rate cut', 'rate hike', 'fomc', 'cpi', 'nonfarm', 'payroll',
                'gdp', 'inflation', 'war', 'ceasefire', 'sanction', 'tariff', 'default', 'downgrade'];

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

// 2 = directly tradeable (tagged instrument or macro driver)
// 1 = general market colour
// 0 = corporate / off-topic
export function relevanceOf(text, instruments) {
  const t = String(text || '').toLowerCase();
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

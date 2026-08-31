// The research desk — four analysts, a bull and a bear, a trader, a risk veto.
//
// Built on request after the structure appeared in a multi-agent trading
// framework. The framework's own README says "research purposes, not intended
// as trading advice", and there is no published evidence that a language model
// arguing with itself beats a coin. So the checks here are not about whether
// the desk is right. They are about the three ways it can be quietly useless:
//
//   Levels a model invented. "Long, stop 3200, target 3100" reads perfectly
//   well and is a guaranteed loss. Arithmetic catches it; prose does not.
//
//   Evidence that was defaulted rather than measured. An analyst told
//   "COT: 0 contracts" writes about balanced positioning. One told "no COT
//   data" says there is none. Absent must stay absent.
//
//   A verdict that leaves no trace. If the desk's calls are not logged with the
//   price at the time, nobody can ever check whether it was any good, which is
//   the entire failing of the thing it was copied from.
import {
  parseJSON, checkLevels, marketBrief, newsBrief, positioningBrief, macroBrief,
  calendarBrief, scoreLog, stripThinking, retryAfterMs, isReasoningModel,
} from '../src/utils/deskAgents.js';

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const H = 3600e3;

// ── Levels are checked, never trusted ───────────────────────────────────────
{
  const ok = { action: 'long', entry: 100, stop: 98, target: 105 };
  check('a sound long passes', checkLevels(ok, 100) === null, String(checkLevels(ok, 100)));
  check('a sound short passes',
    checkLevels({ action: 'short', entry: 100, stop: 102, target: 95 }, 100) === null);
  check('standing aside needs no levels at all',
    checkLevels({ action: 'stand aside' }, 100) === null);

  check('a long whose target is BELOW entry is caught',
    /wrong sides/.test(checkLevels({ action: 'long', entry: 100, stop: 98, target: 95 }, 100)),
    'this reads perfectly well in prose and is a guaranteed loss');
  check('a short with the stop below entry is caught',
    /wrong sides/.test(checkLevels({ action: 'short', entry: 100, stop: 98, target: 95 }, 100)));
  check('a stop sitting on the entry is caught',
    /stop is at the entry/.test(checkLevels({ action: 'long', entry: 100, stop: 100, target: 110 }, 100)));
  check('a trade risking more than it can make is refused',
    /reward is only/.test(checkLevels({ action: 'long', entry: 100, stop: 98, target: 100.5 }, 100)),
    checkLevels({ action: 'long', entry: 100, stop: 98, target: 100.5 }, 100));
  check('an entry invented far from the market is caught',
    /2% away/.test(checkLevels({ action: 'long', entry: 130, stop: 128, target: 140 }, 100)),
    'a model recalling last year\'s price writes a confident paragraph around it');
  check('missing numbers are refused rather than coerced to zero',
    /no usable stop/.test(checkLevels({ action: 'long', entry: 100, target: 110 }, 100)));
  check('a missing entry falls back to the live price rather than failing',
    checkLevels({ action: 'long', stop: 98, target: 105 }, 100) === null);
}

// ── JSON out of prose ───────────────────────────────────────────────────────
{
  check('a bare object parses', parseJSON('{"action":"long"}')?.action === 'long');
  check('a fenced one parses', parseJSON('```json\n{"action":"short"}\n```')?.action === 'short');
  check('and one buried in an apology parses',
    parseJSON('Sure! Here is my decision:\n{"action":"stand aside"}\nHope that helps.')?.action
      === 'stand aside');
  check('prose with no object at all is null, not a guess', parseJSON('I think gold goes up.') === null);
  check('malformed JSON is null rather than a partial object',
    parseJSON('{"action": "long", "stop":}') === null);
  check('empty input is null', parseJSON('') === null);
}

// ── Absent evidence stays absent ────────────────────────────────────────────
// The failure that produces confident writing about nothing.
{
  check('no positioning data says there is none rather than reporting zero',
    /No positioning data/.test(positioningBrief({})), positioningBrief({}));
  check('and where there is, the measured caveat travels with it',
    /did NOT precede anything/.test(positioningBrief({ cot: { pct: 95, weeks: 160 } })),
    'positioning extremes were tested here and found to precede nothing — an analyst '
    + 'given the number without the finding will write the folklore');
  check('a 70th percentile is described as nowhere near an extreme',
    /nowhere near an extreme/.test(positioningBrief({ cot: { pct: 70, weeks: 160 } })),
    'gold sits at 70 and a card that calls that "crowded" is the thing being avoided');
  check('and a 95th as crowded long',
    /crowded long/.test(positioningBrief({ cot: { pct: 95, weeks: 160 } })));
  check('an empty news archive says so instead of inventing a narrative',
    /No tagged headlines/.test(newsBrief({ news: [] })));
  check('an empty calendar says nothing is scheduled',
    /Nothing scheduled/.test(calendarBrief({ events: [] })));
  check('a missing macro decomposition is stated as unavailable',
    /unavailable/.test(macroBrief({})), macroBrief({}));
  check('a bar with no measured setup says so — the absence is information',
    /No measured setup/.test(marketBrief({ price: 1, atr: 1, rules: [] })));
}

// ── The briefs carry numbers, because a claim without one is padding ────────
{
  const ev = {
    price: 4524.61, atr: 25.6, dec: 2,
    state: { plain: ['volatility running hot', 'at the day\'s low'] },
    tf: { 'Last month (daily)': { bars: 22, chgPct: 4.2, trend: 'up', fromHigh: 1.4, fromLow: 6.1 } },
    levels: [{ label: 'yesterday high', price: 4560.2 }],
    rules: [{ label: 'at the day\'s high + after the New York close', dir: 'up',
      holdout: { edgeR: 0.358, n: 91 } }],
  };
  const b = marketBrief(ev);
  check('the price and ATR are stated', /4524\.61/.test(b) && /25\.60/.test(b), b.split('\n')[0]);
  check('the live condition set is passed through', /volatility running hot/.test(b));
  check('the timeframe move is a number, not an adjective', /\+4\.20%/.test(b), b);
  check('a firing setup carries its edge AND its sample',
    /\+0\.358R/.test(b) && /91 trades/.test(b), b.split('\n').pop());
  check('and says the sample was not fitted on', /not fitted on/.test(b));

  const m = macroBrief({ driver: { text: 'only 31% of the last 10 days is explained by the dollar',
    r2: 0.309, b1: -2.455, se1: 0.34, b2: -1.514, se2: 0.371, push: -2.08, n: 240,
    dollarSig: true, rateSig: true, shift: { dollar: -1.14 } } });
  check('the macro brief carries the coefficients with their error bars',
    /-2\.46 ±0\.34/.test(m) && /-1\.51 ±0\.37/.test(m), m.split('\n')[1]);
  check('and says whether each is significant rather than leaving it to the reader',
    /significant/.test(m));
  check('a stable relationship is stated as stable', /stable against ten days ago/.test(m));
  const broke = macroBrief({ driver: { text: 'x', r2: 0.1, b1: 1, se1: 0.1, b2: 0, se2: 1,
    push: null, n: 240, dollarSig: true, rateSig: false, shift: { dollar: -3.4 } } });
  check('a broken one warns that the usual intermarket read has stopped operating',
    /stopped operating/.test(broke), broke.split('\n').pop());
}

// ── Headlines are aged, so "stale" is visible ───────────────────────────────
{
  const b = newsBrief({ news: [
    { title: 'Fed holds rates', at: Date.now() - 3 * H, severity: 'high', dir: 'down' },
    { title: 'Gold ETF inflows rise', at: Date.now() - 40 * H },
  ] });
  check('each headline shows how old it is', /\[3h ago/.test(b), b.split('\n')[0]);
  check('the severity travels with it', /high/.test(b));
  check('and so does any direction label', /labelled down/.test(b));
  check('a forty-hour-old headline is visibly forty hours old', /\[40h ago/.test(b));
}

// ── A verdict that leaves no trace is the whole failing of the original ─────
{
  const now = Date.now();
  const rows = [
    { at: now - 48 * H, sym: 'XAU_USD', price: 100, atr: 2, action: 'long', horizon: 24 },
    { at: now - 48 * H, sym: 'XAU_USD', price: 100, atr: 2, action: 'short', horizon: 24 },
    { at: now - 48 * H, sym: 'XAU_USD', price: 100, atr: 2, action: 'stand aside', horizon: 24 },
  ];
  // Price rose four ATR over the horizon.
  const s = scoreLog(rows, () => 108);
  check('only the calls that took a side are scored', s.n === 2, String(s.n));
  check('standing aside is not counted as a win or a loss',
    !s.rows.some(r => r.action === 'stand aside'));
  check('the long is scored as right and the short as wrong',
    s.rows.find(r => r.action === 'long').moveAtr === 4
    && s.rows.find(r => r.action === 'short').moveAtr === -4,
    JSON.stringify(s.rows.map(r => [r.action, r.moveAtr])));
  check('the move is in ATR so instruments can be pooled',
    Math.abs(s.meanAtr) < 1e-9, String(s.meanAtr));
  check('a call whose horizon has not elapsed yet is not scored early',
    scoreLog(rows, () => null) === null,
    'scoring a trade before it finished is how a log flatters itself');
  check('an empty log scores nothing rather than reporting zero percent',
    scoreLog([], () => 100) === null);
}

// ── Reasoning models leak their scratchpad ─────────────────────────────────
// qwen, deepseek and the r1 family emit their working inside <think> tags. The
// first live run opened the market analyst's card with "Here's a thinking
// process: 1. Analyze User Input" and the actual report was somewhere below.
{
  check('a balanced think block is removed',
    stripThinking('<think>step one, step two</think>The report.') === 'The report.');
  check('several of them are removed',
    stripThinking('<think>a</think>One. <think>b</think>Two.') === 'One. Two.');
  check('a stray closing tag drops everything before it, which was the working',
    stripThinking('rambling working...</think>\nThe report.') === 'The report.');
  check('an unterminated opening tag drops what follows',
    stripThinking('The report.<think>still thinking when the budget ran out')
      === 'The report.', stripThinking('The report.<think>x'));
  check('a truncated answer that is ALL thinking returns nothing, not the scratchpad',
    stripThinking('<think>I should consider the evidence and') === '',
    'returning the working as if it were the report is worse than returning nothing');
  check('other tag spellings are handled', stripThinking('<reasoning>x</reasoning>y') === 'y');
  check('ordinary text is untouched', stripThinking('Gold is at 4454.') === 'Gold is at 4454.');
  check('empty stays empty', stripThinking('') === '' && stripThinking(null) === '');
  check('and JSON hidden behind a scratchpad full of braces still parses',
    parseJSON('<think>maybe {"a":1} or {"b":2}?</think>\n{"action":"long","stop":98}')?.action
      === 'long',
    'the scratchpad is full of braces, so parsing before stripping finds the wrong object');
}

// ── The free tier's rate limit ─────────────────────────────────────────────
// Eight thousand tokens a minute; a desk run needs more. Failing on the fifth
// of ten calls throws away four finished reports, so it waits instead — and
// guessing how long is what turns one rate limit into four.
{
  const withHeader = { headers: { get: k => (k === 'retry-after' ? '7' : null) } };
  check('the retry-after header is used when there is one',
    retryAfterMs(withHeader, '') === 7000, String(retryAfterMs(withHeader, '')));
  const none = { headers: { get: () => null } };
  check('otherwise the wait stated in the message is used',
    Math.abs(retryAfterMs(none, 'Please try again in 3.5s') - 4000) < 1,
    String(retryAfterMs(none, 'Please try again in 3.5s')));
  check('milliseconds are read as milliseconds, not seconds',
    retryAfterMs(none, 'try again in 800ms') === 1300,
    'reading 800ms as 800s would stall the desk for a quarter of an hour');
  check('minutes are read as minutes', retryAfterMs(none, 'try again in 1m') === 60500);
  check('an unparseable body falls back to a sane wait rather than zero',
    retryAfterMs(none, 'slow down') === 12000, 'retrying immediately just earns another 429');
  check('and no wait is ever longer than a minute or so',
    retryAfterMs(none, 'try again in 45m') <= 65000,
    String(retryAfterMs(none, 'try again in 45m')));
}

// ── Reasoning models think out of the answer's budget ──────────────────────
// The second live run rendered four analyst cards and every one was blank. A
// reasoning model's scratchpad is spent from the SAME output budget as its
// reply, so a 420-token cap bought 420 tokens of deliberation and no answer.
// Hiding the reasoning does not fix that — it removes the scratchpad from the
// response, not from the budget.
{
  check('the qwen3 family is recognised as thinking models',
    isReasoningModel('qwen/qwen3.6-27b') && isReasoningModel('qwen/qwen3-32b'));
  check('so are deepseek-r1 and qwq',
    isReasoningModel('deepseek-r1-distill-llama-70b') && isReasoningModel('qwen-qwq-32b'));
  check('an instruct model is not',
    !isReasoningModel('llama-3.3-70b-versatile') && !isReasoningModel('llama-3.1-8b-instant'),
    'these answer straight away and run the whole desk in one breath');
  check('and neither is an empty or missing model name',
    !isReasoningModel('') && !isReasoningModel(null),
    'guessing "thinker" would triple the token budget for every model on the list');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

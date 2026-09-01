# Tests

```
npm test                 # all 55
npm test stops plan      # only files whose name contains "stops" or "plan"
```

Each file is a plain script that prints its own checks and exits non-zero on
failure, so any one of them can be run alone while it is being debugged:

```
node --import ./tests/register.mjs tests/stopplan.test.mjs   # ESM
node tests/stops.test.cjs                                    # CJS
```

No framework, deliberately. These grew as a record of specific defects, and
each check reads as the sentence describing what went wrong — which is more
useful when one fails at 2am than a stack trace naming an assertion helper.

## Two environment quirks the runner handles

The app's own source imports without file extensions (`tradePlan.js` says
`from './confluence'`). Vite resolves that and bare Node does not, so
`register.mjs` installs a loader that applies the same rule rather than
rewriting the source to suit the tests.

`NODE_PATH` points at `tests/stubs`, which holds a one-line `node-fetch` that
forwards to the global `fetch`. It exists so a checkout without
`vps-bot/node_modules` installed can still load the bot's modules. It cannot
shadow the real package: Node consults `NODE_PATH` only after `node_modules`.

## What is covered

**The measurement.** `stops` runs single trades bar by bar against hand-built
candles where the answer is known — the shakeout that takes out a tight stop
and not a wide one, the bar that touches stop and target together, the short
side, the horizon as a hard exit. `stopplan` covers the app reading that grid:
which width gets chosen and why it is the edge over a random entry rather than
the raw return, the mixed-direction blend, and the case the whole thing exists
for — two setups with identical horizon records where one survives a stop and
one does not. `refresh` drives the bot's real `_refreshTf` over 500 generated
bars, which is how the 101% rounding bug was found after the pure functions had
all passed.

**The statistics.** `baseline` and `basereate` cover measuring against what the
market did rather than against a coin flip. `pooling` covers aggregating across
an asset class. `sig` and `rarity` cover the Wilson interval and the
multiple-testing correction — a Wald interval declared setups broken on
thirteen samples, which is where several of these checks come from.

**The plan.** `plan` and `cardbase` cover turning a card into an accept or a
refuse, including the refusals: too thin, contradicted, priced but negative.
`swing`, `swingsearch`, `tffilter` and `select` cover keeping swing and
intraday apart.

**The bot.** `feedmerge`, `records`, `ghsize` (the 1 MB Contents API limit that
took the bot down for half an hour), `bot`, `news`, `newsfix` and `archive`
(the country guard, after US CPI was filed against Canada).

**The registries.** `venue`, `venuewide`, `registries`, `publish` and
`discover` cover every instrument reaching the right exchange host — a
futures-only symbol asked of the spot host returns 400 and the caller's catch
swallows it, so the panel silently shows nothing.

**The studies.** `cotstudy`, `hourstudy` and `metalsstudy` each test one named
hypothesis over five years; the checks there are mostly about the four ways
such a study fakes a result — a percentile that can see the future, one
stretched month counted as forty observations, a benchmark of 50% instead of
what the market did, and a hypothesis relabelled after the fact.

`features`, `regime` and `paged` cover the study that does the opposite: it
names nothing, searches recent history for the states that precede the moves,
and proves each survivor on fortnights the search never saw. Different design,
different failure modes. `features` is mostly one question asked several ways —
can any feature see a bar that has not happened yet — because everything
downstream is fiction if one can. `regime` covers the holdout itself: that the
two halves alternate rather than splitting by date, that a trade cannot straddle
the fence between them, that a condition true for six hours is one opportunity
rather than six. Its last two checks are the point of the whole design: a real
effect planted in the data is found, and on a pure random walk the search still
turns up rules that look excellent where they were found — and none of them
survives. `paged` covers fetching four years of hourly bars out of an API that
returns 5000 at a time without double-counting the boundaries or hanging on a
gap in the history.

`macrofit` covers splitting gold's move into the part the dollar and the
ten-year forced and the part they did not. Correlation is measured three times
elsewhere in this app and cannot answer that question, so this is a regression,
and a regression has four ways to be wrong that all look fine: fitting on the
bar it then explains (the residual comes out zero everywhere and gold reads as
perfectly explained forever), regressing on each driver separately (the two are
correlated, so the shared part is counted twice), pairing the series by index
instead of timestamp, and reading OANDA's ten-year as a yield when it quotes a
price — which inverts every sign downstream with nothing looking wrong. The
coefficients are checked against a world where they have a known answer.

`desk` covers the research desk — four analysts, a bull and a bear who argue, a
trader, a risk veto. The checks are not about whether it is right; a language
model arguing with itself has never been shown to beat a coin, and the framework
this structure came from says so in its own README. They are about the three
ways it goes quietly useless: levels a model invented ("long, stop 3200, target
3100" reads perfectly well and is a guaranteed loss, so it is checked with
arithmetic rather than trusted as prose), evidence that was defaulted rather
than measured (an analyst told "COT: 0 contracts" writes about balanced
positioning; one told "no COT data" says there is none), and a verdict that
leaves no trace — every call is logged with the price at the time, because
otherwise nobody can ever check whether it was any good, which is the whole
failing of the thing it was copied from.

`today` covers the screen the app opens on. One rule to protect: the verdict is
arithmetic — either a setup that survived the holdout is true on this bar, or it
is one condition short, or there is nothing. The macro read and the headlines are
printed for a person to read and must never leak into the answer, so the check is
behavioural: hand `verdictFor` the decomposition, a screaming headline and an
imminent release, and the result must be byte-for-byte what it was without them.
Neither has ever been scored against an outcome, and a screen that quietly weighs
them has invented a signal out of decoration. The rest covers a closed market
reading as a closed market rather than a broken feed, which is how a Friday bar
looked on a Sunday.

`indicators` covers the ones the Screener scores instruments with. RSI was not
RSI: a plain average of the last fourteen changes rather than Wilder's smoothed
one, which gives a fixed window with a cliff at its edge — a spike falls out and
the reading collapses thirty-five points on a bar where nothing happened (92 → 44
→ 53, against 85.6 → 78.8 → 82.7 for the real thing). The thresholds it is scored
against are calibrated for Wilder's, so the wrong statistic fires them at the
wrong times. The correct version was already in the same file inside
detectRSIDivergence, so the first check is that the two now agree.

The rest is the "absent must stay absent" rule again, and it bites harder here
than anywhere: a null coerces to zero in a comparison, so `price > ema` reads
TRUE on every instrument on the board. computeEMA used to return the last close
when short of history, which made EMA200 equal to spot and turned the
golden-cross filter into a comparison of the fifty-period EMA against price —
not a weaker test, a different one. computeATR returned zero, which divides into
infinity in every position size downstream. Both now return null, and every
caller is checked.

`newsalert` covers geopolitical news being fast and being right. Fast was three
delays stacked: a fifteen-minute poll floor, a CDN, and a five-minute cache in
the app — about fifteen minutes from a wire publishing to it reaching a phone
that was already open. Right is the harder half, and the checks are mostly the
history of getting it wrong: "three shared words" grouped nothing across sixty
live headlines because two outlets never word it the same way; two shared words
grouped one pair and it was wrong; weighting by how rare a word is in the batch
did not save it, because sixty headlines cannot tell a rare word from a common
one. A shared PROPER NOUN can — Iran and Larak name the event, stock and futures
are how the business talks about everything — so the test that matters is that
"U.S. stock futures slip after Warsh comments" and "U.S. stock futures dip amid
Iran hostilities" stay two stories.

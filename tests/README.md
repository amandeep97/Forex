# Tests

```
npm test                 # all 38
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

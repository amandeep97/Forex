// src/utils/confluence.js
// What is worth looking at right now, and why — across every kind of evidence.
//
// The old Command Center scored five factors that were not five things. Two of
// them were the same momentum reading counted twice, and a third was a clock
// that returned the same number for every instrument. Everything it produced
// came from one source: recent price.
//
// A reversal is not a candlestick. It is a candlestick AND a level being swept
// AND positioning being one-sided AND something in the calendar that explains
// why now. Any one of those alone is noise — the whole point is that they
// rarely line up, and that when they do it is worth knowing.
//
// So evidence is grouped into FAMILIES, and the ranking is driven by how many
// INDEPENDENT families agree rather than by how large any single reading is.
// Three technical signals that all derive from the same twenty candles are one
// piece of evidence wearing three hats; a candle pattern plus a positioning
// extreme plus a scheduled event are three.
//
// Nothing here is a prediction. Every line is something that has happened or
// is scheduled, with a stated rarity. The screen says what is unusual, not
// what will occur.

export const FAMILY = {
  price:     { label: 'Price action', weight: 1.0 },
  structure: { label: 'Structure',    weight: 1.0 },
  volatility:{ label: 'Volatility',   weight: 0.8 },
  crossasset:{ label: 'Cross-asset',  weight: 1.0 },
  positioning:{label: 'Positioning',  weight: 1.2 },   // COT — slow, independent of price
  news:      { label: 'News',         weight: 1.2 },   // scheduled or just happened
};

const DAY = 86400e3;

// Reversal patterns worth surfacing, and which way they point. A tweezer that
// fires thirty times a month is not evidence of anything, so rarity decides
// whether one appears at all — see RARE_ENOUGH below.
const REVERSAL = {
  hammer:'up', inv_hammer:'up', dragonfly_doji:'up', bull_engulf:'up',
  piercing_line:'up', bull_harami:'up', tweezer_bottom:'up', morning_star:'up',
  three_inside_up:'up', abandoned_bull:'up', kicker_bull:'up',
  shooting_star:'down', hanging_man:'down', gravestone_doji:'down',
  bear_engulf:'down', dark_cloud:'down', bear_harami:'down', tweezer_top:'down',
  evening_star:'down', three_inside_dn:'down', abandoned_bear:'down', kicker_bear:'down',
};

// Rarity has to be measured per BAR, not per month.
//
// "Five times a month" means opposite things on different timeframes: M15 has
// roughly 2,900 bars in a month and Daily has 22, so five occurrences is
// extraordinary on one and routine on the other. A flat monthly threshold
// treated them identically, and adding three intraday timeframes promptly put
// most of the board back on the screen.
//
// Per bar it is one number with one meaning: how often does this instrument do
// this, out of the chances it had.
// Corrected once already, in the other direction. Per-bar rarity is the right
// measure of "unusual for this instrument" and the wrong one for this screen:
// a pattern at one bar in seventeen fires about 170 times a month on M15, which
// is rare per bar and constant in wall-clock terms. This tab answers "what is
// happening now", and now is a human unit, so the threshold is per month and
// deliberately strict — on M15 only something genuinely exceptional survives it.
const MAX_PER_MONTH = 4;

// Corrected a second time, and this is the correction that matters.
//
// Per month is the right unit and the wrong threshold. Four a month means
// something on Daily, which has 22 bars in a month; on M15, which has 2,900,
// nothing can be that rare. Measured on a live feed: of 297 fresh M15 candle
// patterns, ZERO cleared it. M30 kept 2, H1 kept 1, against Daily's 121. The
// structure gate was worse — the rarest intraday structure event anywhere in
// the feed fired 7.3 times a month, against a threshold of 8, so the entire
// intraday population was excluded by construction rather than by selection.
//
// That is not strictness. A filter that always returns zero is not selecting.
//
// So the threshold is a RANK within the timeframe's own population — the
// rarest tenth of what M15 does, judged against other M15 events — which is
// the argument this file already makes for ranking instruments rather than
// scoring them against absolutes. The absolute caps stay as a FLOOR, so the
// slow timeframes keep exactly the behaviour they have now and only the fast
// ones, which had nothing, gain a population.
const RARE_PCTL = 0.10;

function pctl(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.floor(sorted.length * p) - 1)];
}

// The cutoffs, measured across every instrument at once. This has to be a
// population pass — an instrument cannot know whether its own M15 event is
// unusual for M15 without seeing what M15 does elsewhere.
export function rarityCutoffs(feed) {
  const pat = {}, str = {};
  for (const rec of Object.values(feed?.instruments || {})) {
    for (const [tf, list] of Object.entries(rec.patterns || {})) {
      for (const p of list || []) {
        if (p.rate != null && freshness(p.at, tf, rec.asOf)) (pat[tf] ||= []).push(p.rate);
      }
    }
    for (const e of rec.events || []) {
      const pm = (rec.rarity || {})[`${e.type}.${e.tf}`]?.perMonth;
      if (pm != null && freshness(e.at, e.tf, rec.asOf)) (str[e.tf] ||= []).push(pm);
    }
  }
  const cut = (m, floor) => Object.fromEntries(Object.entries(m).map(([tf, a]) => {
    a.sort((x, y) => x - y);
    // Floored by the absolute cap, never tighter than it. On the slow
    // timeframes the tenth percentile normally sits well below the cap, so
    // Daily and H4 keep the threshold they have; on a day when H4 events are
    // unusually common its own tenth percentile can run past the cap, and
    // admitting those is the same rule, not an exception to it.
    return [tf, Math.max(floor, pctl(a, RARE_PCTL) ?? floor)];
  }));
  return { pattern: cut(pat, MAX_PER_MONTH), structure: cut(str, MAX_PER_MONTH * 2) };
}

// ── Pooled records ───────────────────────────────────────────────────────────
//
// One instrument's record is usually not enough to say anything.
//
// Measured across a live feed: 707 records, median sample 22, median win rate
// 50%. 188 of them sat above 55% and 198 below 45% — a symmetry that is exactly
// what a coin flip looks like. A card reading "48% went its way over 33 times"
// carries a margin of error of nine points; the true rate is somewhere between
// 31% and 65%, which is not evidence that the setup fails. It is the absence of
// evidence, printed in the tone of a finding.
//
// The same event across an asset class is the same event. Sweeps on one crypto
// pair are 33 samples; sweeps across every crypto pair are several hundred,
// which is enough for the number to mean something. Pooled within class rather
// than across everything, because a sweep on gold and a sweep on a tech stock
// are not obviously the same phenomenon and pooling them would hide it if they
// are not.
// Weighted running sums over the stopped-trade grid. Kept as sums and divided
// once at the end, so an instrument with 400 bars behind it counts for more
// than one with 40 — the same weighting the win rates already use.
function addRow(into, row, w) {
  if (!into) return row.map(v => v * w);
  return into.map((v, i) => v + row[i] * w);
}
function addGrid(into, grid, w) {
  if (!into) return grid.map(r => r.map(v => v * w));
  return into.map((r, k) => r.map((v, j) => v + grid[k][j] * w));
}
const divGrid = (g, w) => (g && w ? g.map(r => r.map(v => v / w)) : null);
const divRow = (r, w) => (r && w ? r.map(v => v / w) : null);

export function pooledRecords(feed) {
  const acc = new Map();
  // What every bar did over the same window, pooled the same way. This is what
  // a setup has to beat — see baselineOutcome in the bot for why 50% is the
  // wrong benchmark.
  const base = new Map();
  for (const rec of Object.values(feed?.instruments || {})) {
    const cls = rec.cls || 'other';
    for (const [tf, b] of Object.entries(rec.baseline || {})) {
      if (!b?.n) continue;
      const bk = `${cls}|${tf}`;
      const x = base.get(bk) || { n: 0, wins: 0, medSum: 0, up: null, dn: null, tp: null, gn: 0 };
      x.n += b.n; x.wins += (b.win / 100) * b.n; x.medSum += b.medAtr * b.n;
      // The stopped-trade grids pool the same way, weighted by how many bars
      // each instrument contributed. Older feeds carry none and simply do not
      // add to the sum, which is why gn is counted separately from n.
      if (b.stUp && b.stDn) {
        x.up = addGrid(x.up, b.stUp, b.n);
        x.dn = addGrid(x.dn, b.stDn, b.n);
        if (b.tp) x.tp = addRow(x.tp, b.tp, b.n);
        x.gn += b.n;
      }
      base.set(bk, x);
    }
    for (const [key, r] of Object.entries(rec.rarity || {})) {
      if (!r?.fwdN || r.fwdWin == null || r.fwdMedAtr == null) continue;
      const k = `${cls}|${key}`;
      const a = acc.get(k) || { n: 0, wins: 0, medSum: 0, upSum: 0, syms: 0, bars: r.fwdBars,
                                st: null, tp: null, stN: 0, costs: [], costUnknown: 0 };
      a.n += r.fwdN;
      // Reconstructed from the reported percentage. Exact enough at these
      // sample sizes, and the alternative is publishing a second field.
      a.wins += (r.fwdWin / 100) * r.fwdN;
      // A weighted mean of medians is not a pooled median. It is the honest
      // approximation available without shipping every observation, and it is
      // used only to size a target, never to claim a distribution.
      a.medSum += r.fwdMedAtr * r.fwdN;
      // Older feeds carry no split. Assuming an even one is the neutral guess:
      // it makes the mirrored baseline exactly 50%, which is the behaviour
      // before baselines existed.
      a.upSum += (r.upShare ?? 0.5) * r.fwdN;
      if (r.st) {
        a.st = addGrid(a.st, r.st, r.fwdN);
        if (r.tp) a.tp = addRow(a.tp, r.tp, r.fwdN);
        a.stN += r.fwdN;
      }
      // Cost is per instrument, so a pooled setup gets the median across the
      // instruments that make it up — and only those that publish a spread. An
      // instrument with no spread does not count as cheap, it does not count.
      const c = stopCosts(rec, key.split('.').pop());
      if (c) a.costs.push(c); else a.costUnknown += 1;
      a.syms += 1;
      acc.set(k, a);
    }
  }
  const out = {};
  for (const [k, a] of acc) {
    if (a.syms < 3) continue;        // a "pool" of two instruments is not one
    const win = Math.round((a.wins / a.n) * 100);
    const tf = k.split('.').pop();
    const b = base.get(`${k.split('|')[0]}|${tf}`);
    const up = a.upSum / a.n;
    let baseWin = null, baseMed = null, baseN = null;
    if (b?.n) {
      const bw = (b.wins / b.n) * 100, bm = b.medSum / b.n;
      // The published baseline is signed for an "up" event. A "down" event's
      // baseline is its mirror, and a mixed population's is the blend — which
      // lands on 50% for an even split, exactly as it should.
      baseWin = +(up * bw + (1 - up) * (100 - bw)).toFixed(1);
      baseMed = +(bm * (2 * up - 1)).toFixed(2);
      baseN = b.n;
    }
    // The same setup run as an actual stopped trade, pooled across the class.
    // This is where the sample sizes live — a per-instrument grid is fifteen
    // occurrences and this is often two thousand.
    // The median cost at each width across the instruments that carry a
    // spread. null when none of them do — which is 32 of 72 here, so it is a
    // real state and not an edge case.
    const cost = a.costs.length
      ? STOPS.map((_, i) => {
          const col = a.costs.map(c => c[i]).sort((x, y) => x - y);
          return col[Math.floor(col.length / 2)];
        })
      : null;
    const stops = a.st && b?.gn
      ? chooseStop(divGrid(a.st, a.stN), blendGrid(divGrid(b.up, b.gn), divGrid(b.dn, b.gn), up), cost)
      : null;
    const prof = a.tp && b?.gn
      ? profileOf(divRow(a.tp, a.stN).map(Math.round), divRow(b.tp, b.gn), up)
      : {};
    out[k] = {
      ...(stops ? { stops } : {}),
      ...prof,
      // How many of the contributing instruments could be costed at all, so a
      // pooled figure cannot quietly rest on the ones that publish nothing.
      costedSyms: a.costs.length,
      uncostedSyms: a.costUnknown,
      n: a.n,
      win,
      med: +(a.medSum / a.n).toFixed(2),
      bars: a.bars,
      syms: a.syms,
      ci: winCI(win, a.n),
      upShare: +up.toFixed(3),
      baseWin, baseMed, baseN,
      // What the setup adds over simply being in this market for the same
      // window. The only version of these numbers that is about the setup.
      edgeWin: baseWin == null ? null : +(win - baseWin).toFixed(1),
      edgeMed: baseMed == null ? null : +(a.medSum / a.n - baseMed).toFixed(2),
      pooled: true,
    };
  }
  return out;
}

// The 95% interval on a win rate, in percentage points. The single most
// important number on the card and the one that was missing: without it, 48%
// over 33 trades and 48% over 3,300 read identically.
//
// Wilson, not the textbook p ± 1.96·√(p(1−p)/n). The simple version is badly
// wrong exactly where this data lives — small samples and rates far from a half
// — and it was wrong in the dangerous direction. Gold's 23% over 13 gets a Wald
// interval of 0–46%, which excludes a coin flip, so the screen declared the
// setup broken on thirteen observations. Wilson puts the same record at 8–50%,
// which touches a coin flip and therefore says nothing. Thirteen samples cannot
// establish that a setup fails, and the arithmetic should not pretend they can.
const Z = 1.96;

// ── Testing many things at once ──────────────────────────────────────────────
//
// A 95% interval is a statement about ONE question. Ask ninety-one and roughly
// one in twenty looks significant by chance alone — so a panel that scans every
// pooled setup and reports the winners will hand back four or five findings
// that are nothing at all, indistinguishable from the real ones.
//
// That is what the first version of the evidence panel did. Eleven setups
// reported as working, out of ninety-one tested, with no correction and no
// mention of how many had been tried.
//
// Bonferroni: split the 5% across every test, so with ninety-one the interval
// has to clear a coin flip at roughly 3.5 standard deviations instead of 2.
// Blunt and over-conservative, and the right kind of wrong when the output is
// a list of setups someone is going to trade.
//
// The correction belongs where the SEARCH happens. Scanning all of them and
// keeping the best is a search; asking whether one particular setup — reached
// because today's price action put that instrument in front of you — has a
// record is not, and correcting it would only manufacture ignorance.
function probit(p) {
  // Acklam's rational approximation. Accurate to about 1e-9 across the range,
  // which is far more than needed to turn a test count into a z-score.
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687,
             138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866,
             66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > 1 - pl) return -probit(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

export function zFor(tests = 1) {
  if (!(tests > 1)) return Z;
  return probit(1 - 0.05 / (2 * tests));
}

// A win rate can be significant and worthless at the same time. FX tweezer
// bottoms on M15 ran 52% over 2,563 samples — comfortably significant, and a
// median move of 0.02 ATR, which the spread eats whole. Significance says the
// effect is real; this says it is large enough to be worth the cost of taking.
export const MIN_EDGE_ATR = 0.25;

// The same floor for a stopped trade, in R.
//
// The stopped verdict originally asked only that the expectancy be positive,
// which let through crypto bear engulfing on M15: +0.03R a trade against
// −0.46R for a random entry. The comparison is enormous and the number is
// nothing — a short in a rising market, losing less badly than the market did,
// which is not a trade. Below about a tenth of R the spread on entry and exit
// eats the whole thing, which is the same reason MAX_COST_SHARE in tradePlan
// refuses a stop the spread claims a tenth of.
export const MIN_EXP_R = 0.1;

export function winInterval(win, n, tests = 1) {
  if (!n || win == null) return null;
  const z = zFor(tests);
  const p = win / 100;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: +((centre - margin) * 100).toFixed(1), hi: +((centre + margin) * 100).toFixed(1) };
}

// Two proportions, not one against a half. The question is whether this setup
// did better than the same window did on every other bar — a difference of
// proportions, with both samples' uncertainty in it.
function diffZ(win1, n1, win2, n2) {
  if (!n1 || !n2) return null;
  const p1 = win1 / 100, p2 = win2 / 100;
  const pool = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  return se > 0 ? (p1 - p2) / se : null;
}

// The panel's question, in one place: does this setup beat simply being in the
// market, by enough to be worth the spread, after accounting for how many
// setups were examined to find it?
//
// The benchmark used to be 50%, and that credited the market's drift to the
// pattern. Measured on a live board: every surviving "works" was a bullish
// pattern and almost every "fails" was a bearish one, across every asset class
// at once. Patterns do not work that way; rising markets do.
export function verdictOf(rec, tests = 1) {
  const z = zFor(tests);
  // Where the stopped-trade grid exists it is the better question, and it
  // replaces the horizon one rather than being asked alongside it. "Was price
  // higher twenty bars later" and "did this pay with a stop on it" are not two
  // views of the same thing, and only the second is a trade.
  if (rec.stops && rec.n && rec.baseN) {
    const s = rec.stops;
    // Priced out is not the same finding as broken, and collapsing them loses
    // the only one that has a remedy: a wider timeframe, a different asset
    // class, or a broker whose spread is not larger than the stop.
    if (s.pricedOut) return 'costly';
    const stat = diffZ(s.hit, rec.n, s.baseHit, rec.baseN);
    if (stat == null) return 'silent';
    // Three widths were compared to pick this one, so the bar it has to clear
    // is three tests higher.
    const zs = zFor(tests * (s.tried || 1));
    if (stat < -zs) return 'fails';
    if (stat <= zs) return 'silent';
    // Significant, and it still has to pay: more per trade than a random entry
    // with the same stop, and enough of it to survive the cost of taking.
    if (!(s.expR > s.baseExpR && s.expR >= MIN_EXP_R)) return 'tiny';
    // Nothing published a spread, so whether it can be taken is unknown. Saying
    // "works" here is the claim that broke this: two of the three setups on the
    // live board were Binance perps with no spread recorded, and the screen
    // presented them beside a costed one as though they had passed the same
    // test.
    return s.costKnown ? 'works' : 'uncosted';
  }
  // With no baseline published yet, fall back to the old benchmark rather than
  // going silent — an older feed should degrade, not disappear.
  if (rec.baseWin == null) {
    const iv = winInterval(rec.win, rec.n, tests);
    if (!iv) return 'silent';
    if (iv.lo > 50 && rec.med >= MIN_EDGE_ATR) return 'works';
    if (iv.hi < 50) return 'fails';
    if (iv.lo > 50) return 'tiny';
    return 'silent';
  }
  const stat = diffZ(rec.win, rec.n, rec.baseWin, rec.baseN);
  if (stat == null) return 'silent';
  if (stat > z && rec.edgeMed >= MIN_EDGE_ATR) return 'works';
  if (stat < -z) return 'fails';
  // Beats the market measurably and by too little to collect after costs.
  if (stat > z) return 'tiny';
  return 'silent';
}

// Kept as a single number for display, as the half-width of that interval.
export function winCI(win, n) {
  const iv = winInterval(win, n);
  return iv ? +((iv.hi - iv.lo) / 2).toFixed(1) : null;
}

// What the market itself did over the same window, pointed the same way as the
// event. The bot publishes the baseline signed for an "up" event, so a bearish
// signal is judged against its mirror.
//
// Attached to every record, because the alternative is what the cards were
// doing: comparing a bearish setup's 37% against 50% and printing THE RECORD
// SAYS NO, when US500 rose on 65% of days and the honest benchmark for a short
// was 35%. The setup had beaten the market by two points and the screen called
// it broken. Every bearish card on a rising instrument read that way.
// upShare, when the record carries it, is the honest weight: a sweep record is
// a mix of ups and downs and its benchmark is the blend, not the mirror of
// whichever direction happens to be firing right now. For a candle pattern the
// share is 1 or 0 and the blend IS the mirror, so nothing changes there.
export function mirroredBaseline(rec, tf, dir, upShare = null) {
  const b = rec?.baseline?.[tf];
  if (!b?.n || b.win == null) return {};
  const up = upShare != null ? upShare : (dir === 'down' ? 0 : 1);
  return {
    baseWin: +(up * b.win + (1 - up) * (100 - b.win)).toFixed(1),
    baseMed: +(b.medAtr * (2 * up - 1)).toFixed(2),
    baseN: b.n,
  };
}

// ── The trade the record actually describes ─────────────────────────────────
//
// Every number above holds the position for the whole window with no stop. That
// is not what anybody does, and it is why this screen could report a setup as
// 60% and have it be untradeable: reaching the horizon on the right side often
// means sitting through an excursion no stop survives.
//
// The bot now runs each setup as a real trade — in at the close, out at a stop,
// a target at twice the stop, or the end of the window — at three stop widths,
// and does the same for every bar in the sample. This picks the width and hands
// back both sides of the comparison. Order and values must stay in step with
// STOPS and RR in vps-bot/src/feed.js.
const STOPS = [0.5, 1, 1.5];
export const STOP_RR = 2;

// Element-wise blend of the up-grid and the down-grid, by the share of the
// population that pointed up. Same reasoning as mirroredBaseline above.
function blendGrid(up, dn, share) {
  if (!Array.isArray(up) || !Array.isArray(dn)) return null;
  return up.map((row, k) => row.map((v, j) => v * share + dn[k][j] * (1 - share)));
}

// Cost that eats this much of the stop makes the maths unrecoverable. Defined
// here rather than in tradePlan because the stop WIDTH now has to know about it
// — see chooseStop.
export const MAX_COST_SHARE = 0.10;

// What the spread costs at each stop width, as a share of the stop.
//
// Returns null when the instrument publishes no spread. Null is not zero: 32 of
// 72 instruments here are Binance perps with no spread recorded, and treating
// those as free is how an untradeable setup gets called the best on the board.
export function stopCosts(rec, tf) {
  const st = rec?.state?.[tf];
  const spread = rec?.state?.spreadAbs;
  const price = rec?.price;
  if (!st?.atrPct || !spread || !price) return null;
  const atr = price * (st.atrPct / 100);
  if (!(atr > 0)) return null;
  return STOPS.map(s => +(spread / (s * atr)).toFixed(3));
}

// Pick the stop width.
//
// This used to pick purely on measured edge, and that was wrong in a way the
// numbers could not show. A tight stop with a 2R target always looks best in a
// frictionless simulation, so on fast timeframes it chose 0.5 ATR every time.
// On EUR/USD M15 a 0.5 ATR stop is 1.2 pips and the spread is 1.6 — the stop is
// INSIDE the spread. The board's best setup, +0.71R over 153 occurrences,
// resolved in half an hour, could not be taken by anybody.
//
// The cost check already existed in tradePlan and ran per card, long after the
// width had been chosen and long after the panel had called the setup working.
// Two correct pieces that never spoke to each other. So the width is chosen
// from the affordable ones, and where none is affordable that is the answer.
export function chooseStop(grid, baseGrid, costs = null) {
  if (!Array.isArray(grid) || !Array.isArray(baseGrid)) return null;
  const known = Array.isArray(costs);

  // The width that beats the market by most — not the width with the highest
  // raw expectancy. On a drifting instrument the widest stop always wins the
  // raw comparison, because it is the one most like simply being long, and the
  // screen would report the market's drift as the setup's edge for the third
  // time.
  let best = null, bestAny = null;
  for (let k = 0; k < grid.length && k < baseGrid.length; k++) {
    const g = grid[k], bl = baseGrid[k];
    if (!g || !bl) continue;
    const over = (g[2] - bl[2]) / 100;
    if (!bestAny || over > bestAny.over) bestAny = { k, over, g, bl };
    if (known && !(costs[k] <= MAX_COST_SHARE)) continue;   // priced out
    if (!best || over > best.over) best = { k, over, g, bl };
  }
  if (!bestAny) return null;

  // Every width is eaten by the spread. Reported rather than swallowed: it is
  // the difference between "this setup does not work" and "this setup works and
  // you cannot afford it", and only one of those is fixed by a better broker or
  // a slower timeframe.
  if (known && !best) {
    const cheapest = costs.indexOf(Math.min(...costs));
    return {
      pricedOut: true,
      costKnown: true,
      cost: costs[cheapest],
      cheapestAt: STOPS[cheapest],
      stopAtr: STOPS[bestAny.k],
      rr: STOP_RR,
      expR: +(bestAny.g[2] / 100).toFixed(2),
      baseExpR: +(bestAny.bl[2] / 100).toFixed(2),
      hit: Math.round(bestAny.g[0]),
      baseHit: Math.round(bestAny.bl[0]),
      tried: grid.length,
    };
  }

  best = best || bestAny;
  return {
    costKnown: known,
    cost: known ? costs[best.k] : null,
    stopAtr: STOPS[best.k],
    rr: STOP_RR,
    hit: Math.round(best.g[0]),
    stopped: Math.round(best.g[1]),
    expR: +(best.g[2] / 100).toFixed(2),
    baseExpR: +(best.bl[2] / 100).toFixed(2),
    baseHit: Math.round(best.bl[0]),
    // Median bars to leave the trade — at a stop, at a target, or at the end of
    // the window. This is the number that answers "how long am I sitting here",
    // and on most records it is nothing like the horizon the hold estimate has
    // been quoting.
    exitBars: Math.round(best.g[3]),
    baseExitBars: Math.round(best.bl[3]),
    // The best any width returned, ignoring the market. Refusing a trade is
    // allowed to say "no width tried pays", and that sentence is only true if
    // this is negative — the chosen width is the one with the largest EDGE, and
    // a width with a worse edge can still be the one that makes money.
    bestExpR: +(Math.max(...grid.filter(Boolean).map(g => g[2])) / 100).toFixed(2),
    // Three widths were compared to choose this one, so the interval on it has
    // to be widened accordingly.
    tried: grid.length,
  };
}

// Win rate at bars 1, 2, 3 and 5 next to the market's own, so an edge that only
// exists at the horizon can be told from one that shows up straight away. Only
// the second is tradeable by somebody who will not hold a loser for days.
function profileOf(tp, baseTp, share) {
  if (!Array.isArray(tp) || !Array.isArray(baseTp)) return {};
  return { profile: tp.map((w, i) => ({
    bar: [1, 2, 3, 5][i],
    win: w,
    base: Math.round(baseTp[i] * share + (100 - baseTp[i]) * (1 - share)),
  })) };
}

export function stopsFor(r, rec, tf, dir) {
  const b = rec?.baseline?.[tf];
  if (!Array.isArray(r?.st) || !b?.stUp || !b?.stDn) return {};
  const share = r.upShare != null ? r.upShare : (dir === 'down' ? 0 : 1);
  const stops = chooseStop(r.st, blendGrid(b.stUp, b.stDn, share), stopCosts(rec, tf));
  if (!stops) return {};
  return { stops, ...profileOf(r.tp, b.tp, share) };
}

// Does this record actually say anything?
//
// Against the market where one is known, against a coin flip where it is not.
// A record whose interval straddles its own benchmark says nothing, however far
// from it the point estimate happens to sit.
export function tellsUsSomething(rec) {
  if (!rec?.n) return false;
  // Same precedence as verdictOf: where the trade was actually run with a stop,
  // that is the record, and the horizon number is a description of something
  // nobody does.
  if (rec.stops && rec.baseN) {
    const s = rec.stops;
    const stat = diffZ(s.hit, rec.n, s.baseHit, rec.baseN);
    return stat != null && Math.abs(stat) > zFor(s.tried || 1);
  }
  if (rec.baseWin != null && rec.baseN) {
    const p1 = rec.win / 100, p2 = rec.baseWin / 100;
    const pool = (p1 * rec.n + p2 * rec.baseN) / (rec.n + rec.baseN);
    const se = Math.sqrt(pool * (1 - pool) * (1 / rec.n + 1 / rec.baseN));
    return se > 0 && Math.abs((p1 - p2) / se) > Z;
  }
  const iv = winInterval(rec.win, rec.n);
  return !!iv && (iv.lo > 50 || iv.hi < 50);
}

// Significance is a separate axis from rarity. A daily strong hammer and an
// M15 one can be equally rare in per-bar terms and are not equally worth
// knowing about — the daily one survived a hundred times as much trading.
const TF_WEIGHT = { M15: 0.45, M30: 0.6, H1: 0.8, H4: 1.0, D: 1.3 };

// ── Horizon ──────────────────────────────────────────────────────────────────
//
// A timeframe is not a preference, it is a holding period, and mixing them
// produced a screen that could not be traded from.
//
// Every record on this screen is measured forward over a window the feed picks
// per timeframe: Daily looks 10 bars ahead (about a fortnight), H4 looks 20
// (about three days), H1 and below look a day or less. Those are two different
// questions. Ranking a Daily setup and an M15 setup against each other on one
// list asks you to compare "this instrument is likely to be higher in two
// weeks" with "this instrument is likely to be higher by lunchtime", and the
// old code went further than that — it let the M15 vote count toward the
// direction of the Daily setup, so an intraday pullback could flip the stated
// bias of a two-week idea.
//
// So evidence is split by the horizon it speaks to, and the two are combined in
// one direction only: the slow evidence sets the bias, the fast evidence can
// time an entry into it. That is the difference between a swing trade and an
// intraday trade, and it is what decides which record prices the trade.
const SWING_TFS = new Set(['D', 'H4']);

// Positioning, cross-asset leadership and the calendar carry no timeframe. They
// move over days to weeks, so they belong with the slow evidence rather than
// being discarded — but they are context, and context alone is never a setup.
export function horizonOf(e) {
  const tfs = e?.tfs || [];
  if (!tfs.length) return 'context';
  return tfs.some(t => SWING_TFS.has(t)) ? 'swing' : 'intraday';
}

// A setup where the slow bias and the fast trigger agree is the thing being
// hunted for, and it is much rarer than either alone. An intraday-only idea is
// still shown — sometimes the better setup really is the fast one — but it has
// to be exceptional to outrank a swing setup rather than merely present.
const KIND_WEIGHT = { trigger: 1.35, swing: 1.0, intraday: 0.55 };


// Freshness is counted in BARS, against the feed's own last bar — not in days
// against the wall clock.
//
// Measuring in days made "recent" mean twelve H4 bars, and with thirty-four
// pattern types across five timeframes every instrument accumulates several
// inside a window that wide. Measured on live data: 100% of seventy-two
// instruments had a "rare" pattern and 99% had a structure event, so almost
// everything cleared two families and the screen selected nothing.
//
// Against the wall clock it was also wrong in a second way. If the feed last
// refreshed an instrument four hours ago, an event on its most recent bar is
// already "old" by a clock and is still the latest thing that happened.
const TF_MS = { M15: 900e3, M30: 1800e3, H1: 3600e3, H4: 14400e3, D: 86400e3 };
const MAX_BARS_AGO = 2;

function freshness(at, tf, asOf) {
  const ms = TF_MS[tf];
  const last = asOf?.[tf];
  if (!ms || !last || !at) return 0;
  const bars = (last - at) / ms;
  if (bars < -0.5 || bars > MAX_BARS_AGO) return 0;
  return 1 - Math.max(0, bars) / (MAX_BARS_AGO + 1);
}

// ── Evidence collectors ──────────────────────────────────────────────────────
// Each returns { family, dir, label, detail, weight } or nothing. `dir` is
// 'up' | 'down' | null, and null means "notable but not directional" — a
// volatility squeeze says something is coming, not which way.

function candleEvidence(rec, asOf, cuts, pools, cls) {
  const out = [];
  const byTf = rec.patterns || {};
  // A pattern on two timeframes at once is the thing being asked for, and it
  // is rare enough to deserve its own line rather than two separate ones.
  const seen = {};
  for (const [tf, list] of Object.entries(byTf)) {
    for (const p of list || []) {
      const dir = REVERSAL[p.id];
      if (!dir) continue;
      if ((p.rate ?? 99) > (cuts?.pattern?.[tf] ?? MAX_PER_MONTH)) continue;
      const f = freshness(p.at, tf, asOf);
      if (!f) continue;
      // One entry per timeframe. The same pattern can appear twice in a
      // timeframe's list — two occurrences within the retained window — and
      // pushing both produced labels reading "bull engulf on H4 + H4 + D".
      const bucket = (seen[p.id] ||= []);
      const existing = bucket.find(x => x.tf === tf);
      if (existing) { if (f > existing.f) { existing.f = f; existing.rate = p.rate; } }
      else bucket.push({ tf, rate: p.rate, f });
    }
  }
  // A bullish and a bearish pattern on the same instrument is not two pieces of
  // evidence, it is an unclear chart. Both were being listed — "bear harami on
  // H4 + D" directly above "bull engulf on H4 + D" — which inflated the count
  // and made almost every card read EVIDENCE DISAGREES. The fresher and rarer
  // side is kept and the other is dropped.
  const score = h => Math.max(...h.map(x => x.f)) * (h.length > 1 ? 1.6 : 1)
                     / Math.max(0.5, Math.min(...h.map(x => x.rate ?? 99)));
  const ups = Object.entries(seen).filter(([id]) => REVERSAL[id] === 'up');
  const dns = Object.entries(seen).filter(([id]) => REVERSAL[id] === 'down');
  if (ups.length && dns.length) {
    const bestUp = Math.max(...ups.map(([, h]) => score(h)));
    const bestDn = Math.max(...dns.map(([, h]) => score(h)));
    const drop = bestUp >= bestDn ? dns : ups;
    for (const [id] of drop) delete seen[id];
  }

  for (const [id, hits] of Object.entries(seen)) {
    const dir = REVERSAL[id];
    const tfs = hits.map(h => h.tf);
    const rarest = Math.min(...hits.map(h => h.rate ?? 99));
    const multi = hits.length > 1;
    // A candle with its consequence attached.
    //
    // Only sweeps and breaks were ever measured forward, so every card whose
    // signal was a candle could be drawn and never priced — 24 of 27 unpriced
    // plans on a live feed. The bot now measures candles the same way, and the
    // record is taken from the slowest timeframe the pattern appeared on, which
    // is the one the trade will be held on.
    const rk = hits.map(h => ({ h, r: (rec.rarity || {})[`${id}.${h.tf}`] }))
                   .filter(x => x.r?.fwdN >= 5)
                   .sort((a, b) => (TF_WEIGHT[b.h.tf] ?? 0) - (TF_WEIGHT[a.h.tf] ?? 0))[0];
    const base = rk ? {
      n: rk.r.fwdN, win: rk.r.fwdWin, med: rk.r.fwdMedAtr, bars: rk.r.fwdBars,
      ci: winCI(rk.r.fwdWin, rk.r.fwdN),
      ...mirroredBaseline(rec, rk.h.tf, dir, rk.r.upShare),
      ...stopsFor(rk.r, rec, rk.h.tf, dir),
    } : null;
    const pool = rk ? (pools?.[`${cls}|${id}.${rk.h.tf}`] || null) : null;
    out.push({
      family: 'price',
      dir, base, pool,
      label: `${id.replace(/_/g, ' ')}${multi ? ` on ${tfs.join(' + ')}` : ` on ${tfs[0]}`}`,
      tfs,
      detail: `${rarest.toFixed(1)}× a month on this instrument`,
      // Two timeframes agreeing is genuinely more than one, and a rarer
      // pattern is stronger evidence than a common one.
      // Weighted by the slowest timeframe it appeared on: a pattern present on
      // both M15 and Daily is a daily event that also shows intraday, not an
      // intraday one.
      weight: (multi ? 1.6 : 1)
              * Math.max(...hits.map(h => TF_WEIGHT[h.tf] ?? 1))
              * Math.max(...hits.map(h => h.f)),
      multiTf: multi,
    });
  }
  return out;
}

function structureEvidence(rec, asOf, cuts, pools, cls) {
  const out = [];
  const rarity = rec.rarity || {};
  for (const e of rec.events || []) {
    const f = freshness(e.at, e.tf, asOf);
    if (!f) continue;
    const r = rarity[`${e.type}.${e.tf}`];
    const perMonth = r?.perMonth;
    // Routine for its own timeframe is not an event worth a line — and "for
    // its own timeframe" is now measured against what that timeframe does,
    // not against a number that only ever made sense on Daily.
    if (perMonth != null && perMonth > (cuts?.structure?.[e.tf] ?? MAX_PER_MONTH * 2)) continue;
    // The feed's "sweep" is detectStrongReversal — a strong hammer or a strong
    // shooting star, where the bar takes out N bars of highs or lows and closes
    // back inside. It already resolves direction: dir 'up' IS the hammer.
    //
    // This used to invert it, reasoning that sweeping the highs is a rejection
    // of up — which is correct reasoning applied to a value that had already
    // had it applied, so every strong hammer was reported as bearish and every
    // star as bullish. Exactly backwards, on the highest-weight signal here.
    const dir = e.dir === 'up' ? 'up' : 'down';
    const label = e.type === 'sweep'
      ? (e.dir === 'up' ? `strong hammer on ${e.tf}` : `strong shooting star on ${e.tf}`)
      : `structure break ${e.dir} on ${e.tf}`;
    // What happened the last time this fired here. A pattern with no
    // consequence attached is the thing every other screen shows; this is the
    // instrument's own record, with its sample size, and it is the only line
    // on the card that answers "so what".
    const base = r?.fwdN >= 5 ? {
      n: r.fwdN, win: r.fwdWin, med: r.fwdMedAtr, bars: r.fwdBars,
      ci: winCI(r.fwdWin, r.fwdN),
      ...mirroredBaseline(rec, e.tf, dir, r.upShare),
      ...stopsFor(r, rec, e.tf, dir),
    } : null;
    // The same event measured across the whole asset class. Usually two orders
    // of magnitude more samples, and the only version of this number with
    // enough behind it to be acted on.
    const pool = pools?.[`${cls}|${e.type}.${e.tf}`] || null;
    out.push({
      family: 'structure',
      dir,
      label,
      tfs: [e.tf],
      detail: e.detail || '',
      rarity: perMonth,
      strong: e.type === 'sweep',
      base, pool,
      // Evidence with a measured history behind it outranks evidence without
      // one — but only mildly, and only when the record is actually favourable.
      // Rarity is graded against the same cutoff that admitted it, for the
      // same reason the cutoff is per-timeframe: an M15 event that fires 14
      // times a month is exceptional for M15, and a fixed "more than 4 a month
      // is routine" scored every one of them as routine.
      // The ratios reproduce the old fixed boundaries exactly on the slow
      // timeframes — 1.5 and 4 against the Daily cutoff of 8.
      weight: f * (TF_WEIGHT[e.tf] ?? 1)
                * (perMonth == null ? 1 : (() => {
                    const ratio = perMonth / (cuts?.structure?.[e.tf] ?? MAX_PER_MONTH * 2);
                    return ratio <= 0.1875 ? 1.5 : ratio <= 0.5 ? 1.2 : 0.7;
                  })())
                * (base && base.n >= 10 ? (base.win >= 60 ? 1.25 : base.win <= 40 ? 0.8 : 1) : 1),
    });
  }
  return out;
}

function volatilityEvidence(rec) {
  const out = [];
  for (const [tf, st] of Object.entries(rec.state || {})) {
    // state also carries non-timeframe keys — spreadRatio, posnPct, posnWeeks —
    // which would otherwise be reported as "volatility at a posnPct floor".
    if (!st || typeof st !== 'object' || !TF_MS[tf]) continue;
    if (st.volPct != null && st.volPct <= 5) {
      out.push({ family:'volatility', dir:null, label:`volatility at a ${tf} floor`, tfs:[tf],
        detail:`bottom ${st.volPct}% of its own range — coiled`, weight:1.1 });
    } else if (st.volPct != null && st.volPct >= 95) {
      out.push({ family:'volatility', dir:null, label:`volatility at a ${tf} extreme`, tfs:[tf],
        detail:`top ${st.volPct}% — moves are already large`, weight:0.9 });
    }
    if (st.rangePos != null && st.rangePos >= 98) {
      out.push({ family:'volatility', dir:'down', label:`pinned at the top of its ${tf} range`, tfs:[tf],
        detail:`${st.rangePos}% of the 60-bar range`, weight:1.0 });
    } else if (st.rangePos != null && st.rangePos <= 2) {
      out.push({ family:'volatility', dir:'up', label:`pinned at the bottom of its ${tf} range`, tfs:[tf],
        detail:`${st.rangePos}% of the 60-bar range`, weight:1.0 });
    }
  }
  return out;
}

function leadershipEvidence(rec) {
  const l = rec.leaders;
  if (!l?.list?.length) return [];
  // Only leaders that clear the noise floor the VPS already computed. Below it
  // the correlation is indistinguishable from chance at this sample size.
  // Clearing the noise floor by a hair is not a finding — 57% of instruments
  // had at least one leader over it, so as a qualifying criterion it selected
  // nothing. Well clear of the floor, and only the strongest.
  const strong = l.list
    .filter(x => Math.abs(x.r) > Math.max((l.floor ?? 0.25) * 1.6, 0.35))
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
    .slice(0, 1);
  return strong.map(x => ({
    family: 'crossasset',
    dir: null,
    label: `${x.sym} leads by ${x.lag} bar${x.lag > 1 ? 's' : ''}`,
    detail: `r=${x.r.toFixed(2)} against a ${(l.floor ?? 0).toFixed(2)} noise floor`,
    weight: 0.9,
  }));
}

// ── News ─────────────────────────────────────────────────────────────────────
// The currencies an instrument is exposed to. A calendar event only matters to
// an instrument that touches the currency it concerns.
export function currenciesOf(sym, cls) {
  if (!sym) return [];
  if (sym.includes('/')) {
    const [a, b] = sym.split('/');
    if (b === 'USDT') return cls === 'tradfi' ? ['USD'] : ['USD', a];
    return [a, b];
  }
  // Indices and single-name symbols
  if (/^(US|SPX|NAS|DJ)/.test(sym)) return ['USD'];
  if (/^UK/.test(sym)) return ['GBP'];
  if (/^GER|^FR|^EU/.test(sym)) return ['EUR'];
  if (/^JPN/.test(sym)) return ['JPY'];
  if (/OIL|NATGAS/.test(sym)) return ['USD', 'OIL'];
  return ['USD'];
}

function newsEvidence(sym, cls, news, now) {
  if (!news) return [];
  const mine = new Set(currenciesOf(sym, cls));
  const out = [];

  // Scheduled, high impact, within the next 24 hours. This is the one piece of
  // evidence that is about the future rather than the past, and the only
  // honest thing to say about it is that it is coming.
  for (const e of news.calendar || []) {
    if (e.impact !== 'high') continue;
    if (!mine.has(e.country)) continue;
    const inMs = e.at - now;
    if (inMs < -2 * 3600e3 || inMs > 24 * 3600e3) continue;
    const hrs = inMs / 3600e3;
    out.push({
      family: 'news',
      dir: null,
      label: hrs < 0 ? `${e.country} ${e.title} — just released`
           : hrs < 1 ? `${e.country} ${e.title} in ${Math.round(hrs * 60)} min`
           : `${e.country} ${e.title} in ${hrs.toFixed(1)}h`,
      detail: [e.forecast && `forecast ${e.forecast}`, e.previous && `prev ${e.previous}`]
        .filter(Boolean).join(' · '),
      // Imminent matters more than merely today.
      weight: hrs < 0 ? 1.3 : hrs < 2 ? 1.4 : hrs < 8 ? 1.0 : 0.7,
      scheduled: true,
      shared: e.country,        // identical on every instrument touching it
      driver: `${e.country} ${e.title}`,
    });
  }

  // Headlines from the last six hours that name one of this instrument's
  // currencies. Older than that and it is context, not news.
  const recent = (news.headlines || [])
    .filter(h => now - h.at < 6 * 3600e3 && (h.ccy || []).some(c => mine.has(c)))
    .slice(0, 2);
  for (const h of recent) {
    out.push({
      family: 'news', dir: null,
      label: h.title.length > 90 ? h.title.slice(0, 88) + '…' : h.title,
      detail: `${h.source} · ${Math.round((now - h.at) / 60000)} min ago`,
      weight: 0.8, headline: true, link: h.link,
      shared: (h.ccy || [])[0] || 'news',
      driver: h.title,
    });
  }
  return out;
}

// Positioning, read from where the bot actually publishes it.
//
// This family carries the highest weight in FAMILY and had never once appeared
// on a card. It was reading a `cot` object keyed by currency, holding values in
// roughly -1..1, supplied by the caller — and nothing in the app has ever
// supplied one. Meanwhile the bot has been fetching CFTC data all along and
// writing it to `state.posnPct`: a percentile of net speculative positioning
// against its own three-year history, on thirteen instruments. Two shapes for
// the same fact, and the one being read did not exist.
//
// Deliberately NOT directional. Crowded positioning is the classic contrarian
// signal, and it is also read as trend confirmation, and I cannot measure which
// applies here — the bot records forward outcomes for events, not for states.
// Having already shipped one inverted signal, asserting a direction I cannot
// back is the worse error. So it reports the fact and contributes to breadth,
// and the direction stays with the evidence that has a record behind it.
const POSN_EXTREME = 10;   // percentile, from either end

function positioningEvidence(rec) {
  const pct = rec.state?.posnPct;
  if (pct == null) return [];
  const long = pct >= 100 - POSN_EXTREME;
  const short = pct <= POSN_EXTREME;
  if (!long && !short) return [];
  const weeks = rec.state.posnWeeks;
  return [{
    family: 'positioning',
    dir: null,
    label: `speculative positioning at a ${long ? 'long' : 'short'} extreme`,
    detail: `${pct}th percentile of the last ${weeks ? Math.round(weeks / 52) : 3} years`
          + `${rec.asOf?.cot ? ` · CFTC ${rec.asOf.cot}` : ''}`,
    // Independent of price in a way nothing else on the card is: every other
    // family is ultimately derived from the same candles.
    weight: 1.2,
  }];
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function assess(sym, rec, { news = null, cot = null, now = Date.now(), cuts = null, pools = null } = {}) {
  if (!rec) return null;
  const cls = rec.cls;
  const evidence = [
    ...candleEvidence(rec, rec.asOf, cuts, pools, cls),
    ...structureEvidence(rec, rec.asOf, cuts, pools, cls),
    ...volatilityEvidence(rec),
    ...leadershipEvidence(rec),
    ...newsEvidence(sym, cls, news, now),
    ...positioningEvidence(rec),
  ];
  if (!evidence.length) return null;

  // Shared vs own.
  //
  // An RBA decision is identical evidence on AUD/NZD, AUD/CHF, AUD/JPY and
  // every other AUD pair. Counting it per instrument put seven near-identical
  // cards at the top of the screen, each listing the same three lines, and
  // buried everything else — the same double-counting the family model exists
  // to prevent, happening across instruments instead of within one.
  //
  // A currency driver cannot discriminate between instruments that all contain
  // that currency, so it does not contribute to the ranking. It is shown as
  // context, once, with the list of what it touches.
  const own = evidence.filter(e => !e.shared);
  const shared = evidence.filter(e => e.shared);
  if (!own.length) return null;

  // Something has to have HAPPENED.
  //
  // Volatility regime, leadership and positioning are states: they are true for
  // a third of the board at any moment, and two of them together were enough to
  // put an instrument on the screen with nothing having occurred on it. They
  // explain an event; they cannot be one. Requiring a price or structure event
  // is what makes this a list of things that just happened rather than a list
  // of things that are currently the case.
  if (!own.some(e => e.family === 'price' || e.family === 'structure')) return null;

  const families = [...new Set(own.map(e => e.family))];

  const wOf = e => e.weight * (FAMILY[e.family]?.weight ?? 1);
  const byWeight = (a, b) => wOf(b) - wOf(a);

  // What HAPPENED goes above what merely IS.
  //
  // Sorting the card purely by weight is right for scoring and wrong for
  // reading. Context evidence carries fixed weights — cross-asset 0.9,
  // volatility 0.8 to 1.1 — while an event is scaled by its timeframe, 0.45 on
  // M15 against 1.3 on Daily. On a daily card the event leads comfortably. On
  // an intraday card it cannot: EUR/JPY listed a cross-asset lead and four
  // volatility floors above the hanging man that was the only reason the card
  // existed, and US100 buried its strong hammer under three lines of context.
  //
  // This file already draws the distinction — a squeeze explains an event and
  // cannot be one — and then displayed them in an order that hid it.
  const EVENT = new Set(['price', 'structure']);
  const byEventFirst = (a, b) =>
    (EVENT.has(b.family) ? 1 : 0) - (EVENT.has(a.family) ? 1 : 0) || byWeight(a, b);

  // Direction is a vote, weighted, and only over evidence that has one. A
  // volatility squeeze and a calendar event are real but say nothing about
  // which way — counting them as agreement would manufacture a bias.
  //
  // The floor is per-population, and it has to be. TF_WEIGHT caps intraday
  // evidence at 0.8 against Daily's 1.3, so the 0.35 that makes a slow signal
  // count is a far higher bar for a fast one. Applied flat to both, it silenced
  // the fast side almost entirely — on a live snapshot the only two instruments
  // with an intraday event both agreed with their daily bias and both scored
  // 0.2, so neither was ever reported as a timed entry.
  //
  // The two votes are also answering different questions. The slow one decides
  // whether there is a trade at all and deserves a real threshold. The fast one
  // only has to say agree, disagree, or nothing — the strength of the case was
  // already settled by the slow evidence.
  const MIN_NET = { swing: 0.35, intra: 0.15 };
  const vote = (list, floor) => {
    let up = 0, down = 0;
    for (const e of list) {
      if (e.dir === 'up') up += e.weight * (FAMILY[e.family]?.weight ?? 1);
      else if (e.dir === 'down') down += e.weight * (FAMILY[e.family]?.weight ?? 1);
    }
    const net = up - down;
    return { up, down, net, dir: Math.abs(net) < floor ? null : net > 0 ? 'up' : 'down' };
  };

  // Two separate votes, never one. Context sits with the slow side: an
  // extreme in positioning is a two-week fact, not a lunchtime one.
  const swingEv = own.filter(e => horizonOf(e) !== 'intraday');
  const intraEv = own.filter(e => horizonOf(e) === 'intraday');
  const isEvent = e => e.family === 'price' || e.family === 'structure';
  const swingSetup = swingEv.some(isEvent);
  const intraSetup = intraEv.some(isEvent);
  const sv = vote(swingEv, MIN_NET.swing);
  const iv = vote(intraEv, MIN_NET.intra);

  // A setup whose own slow evidence contradicts itself is not a timed entry,
  // whatever the fast timeframes are doing. Calling it one promoted exactly the
  // cards the screen should be cautious about — the trigger bonus was cancelling
  // the conflict penalty, and a contradicted card was arriving at the top of the
  // board labelled TIMED ENTRY.
  const MIN_TRIGGER_COHERENCE = 0.5;
  const swingCoherent = (sv.up + sv.down) > 0
    && Math.abs(sv.net) / (sv.up + sv.down) >= MIN_TRIGGER_COHERENCE;

  let kind, dir, trigger = null, pullback = false;
  if (swingSetup) {
    // The slow evidence owns the direction. This is the whole correction: an
    // M15 hammer inside a bearish daily setup is a pullback to sell into, not
    // a reason to relabel the card bullish.
    dir = sv.dir;
    if (intraSetup && iv.dir && dir && iv.dir === dir && swingCoherent) {
      kind = 'trigger';
      trigger = intraEv.filter(e => e.dir === dir && isEvent(e)).sort(byWeight)[0] || null;
    } else {
      kind = 'swing';
      pullback = !!(dir && iv.dir && iv.dir !== dir);
    }
  } else {
    kind = 'intraday';
    dir = iv.dir;
  }

  // The score is driven by breadth across families, not by the loudest single
  // reading. Four price-action signals from the same twenty candles are one
  // piece of evidence; a candle plus positioning plus a scheduled event are
  // three, and that is the case worth surfacing.
  const base = own.reduce((s, e) => s + e.weight * (FAMILY[e.family]?.weight ?? 1), 0);
  const breadth = families.length;

  // Conflict is only meaningful inside one horizon. Slow and fast evidence
  // disagreeing is ordinary and has its own name — see `pullback` above.
  const cv = kind === 'intraday' ? iv : sv;

  // Agreement has to be worth something, because the score was rewarding its
  // opposite — in two separate places.
  //
  // `base` added up every piece of evidence regardless of which way it pointed,
  // so an instrument with a bullish break and a bearish candle carried more
  // total weight than one with the bullish break alone. And the breadth bonus
  // made it worse: the opposing candle arrived from a different FAMILY, so
  // contradicting the setup earned the 35% multiplier for "independent kinds of
  // evidence agree" — which is the exact opposite of what happened.
  //
  // The effect was systematic. On a live feed, conflicted cards averaged rank
  // 22.5 against 30.3 for cards whose evidence agreed, and eight of the
  // seventeen cards clearing three families were conflicted. The top of the
  // list was reliably something the tool then argued against.
  //
  // So the bonus is counted over families that AGREE with the card's direction,
  // plus the ones that carry no direction at all — a volatility squeeze
  // supports a setup without pointing anywhere. Opposing evidence still counts
  // toward `breadth` for qualification and display, because "these disagree" is
  // worth knowing; it just stops being rewarded for it.
  const agreeing = own.filter(e => !e.dir || e.dir === dir);
  const agreeBreadth = new Set(agreeing.map(e => e.family)).size;

  // Coherence is the share of directional weight that points one way. A clean
  // card keeps its score; a card split down the middle keeps a quarter of it
  // and stays on the screen, because "these disagree" is still worth knowing —
  // it just is not worth ranking first.
  const dirTot = cv.up + cv.down;
  const coherence = dirTot > 0 ? Math.abs(cv.net) / dirTot : 1;
  const score = +(base * (1 + 0.35 * Math.max(0, agreeBreadth - 1)) * (KIND_WEIGHT[kind] ?? 1)
                  * (0.25 + 0.75 * coherence)).toFixed(2);

  // Which evidence the trade would actually be built on, so the record shown
  // on the card is measured over the horizon the trade will be held for.
  const scope = kind === 'intraday' ? intraEv : swingEv;

  return {
    sym, cls, price: rec.price, dec: rec.dec, name: rec.name,
    evidence: own.sort(byEventFirst),
    shared: shared.sort(byWeight),
    families, breadth, dir, score,
    coherence: +coherence.toFixed(2),
    agreeBreadth,
    // 'swing'    — a D/H4 event, held over the horizon that record was measured on
    // 'trigger'  — the same, with a faster event agreeing: a timed entry into it
    // 'intraday' — nothing on the slow timeframes; a trade in its own right, and
    //              held to a much shorter clock
    kind, trigger, pullback,
    swingDir: sv.dir, intraDir: iv.dir,
    // Evidence disagrees — worth saying so, but only when it genuinely does.
    // The absolute floor alone flagged cards where one side held 85% of the
    // weight, which reads as a contradiction and is a lopsided agreement. Both
    // sides must carry real weight AND neither may dominate.
    conflict: cv.up > 0.5 && cv.down > 0.5 && coherence < MIN_TRIGGER_COHERENCE,
    hasNews: shared.length > 0,
    strong: own.some(e => e.strong),
    multiTf: own.some(e => e.multiTf),
    // Read off the evidence, not scraped back out of its label.
    //
    // This parsed the display string with /\b(H4|D)\b/ — written when those
    // were the only two timeframes — so when M15, M30 and H1 arrived the
    // filters for them matched nothing and silently returned an empty screen.
    // Recovering data from text meant for humans is how that happens.
    tfs: [...new Set(own.flatMap(e => e.tfs || []))],
    swingTfs: [...new Set(swingEv.flatMap(e => e.tfs || []))],
    intraTfs: [...new Set(intraEv.flatMap(e => e.tfs || []))],
    // The strongest measured record among the evidence the trade is built on.
    // Taken from `scope`, not from everything: on a Daily setup with an M15
    // pattern attached, the M15 record answers a question you are not asking.
    base: scope.map(e => e.base).filter(Boolean).sort((a, b) => b.n - a.n)[0] || null,
    ccy: currenciesOf(sym, cls),
  };
}

// When a whole asset class moves together, that is a different fact.
//
// One metal firing a signal is about that metal. Five of seven metals firing
// the same direction at once is about the dollar, or real rates, or risk — a
// regime, not a setup. Nothing in the app said which of those you were looking
// at, and they call for opposite responses: the idiosyncratic one is a trade,
// the cluster is a reason to check your total exposure.
export function clusters(assessed) {
  const byCls = {};
  for (const a of assessed) {
    if (!a.dir) continue;
    (byCls[a.cls] ||= []).push(a);
  }
  const out = [];
  for (const [cls, list] of Object.entries(byCls)) {
    const up = list.filter(a => a.dir === 'up');
    const down = list.filter(a => a.dir === 'down');
    const side = up.length >= down.length ? up : down;
    // A cluster has to be both a real count AND a majority of what fired in
    // that class. "13 of 23" was neither remarkable nor informative — it is
    // roughly what half a class doing anything looks like.
    if (side.length < 4 || side.length < list.length * 0.6) continue;
    out.push({
      cls, dir: side === up ? 'up' : 'down',
      syms: side.map(a => a.sym),
      n: side.length, total: list.length,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

// Shared drivers, grouped once instead of repeated on every affected card.
//
// "RBA decision in 1.5h → AUD/NZD, AUD/CHF, GBP/AUD and four others" is one
// fact. Printing it seven times is not seven facts, and it pushed everything
// else off the screen.
export function driversOf(assessed) {
  const map = new Map();
  for (const a of assessed) {
    for (const e of a.shared || []) {
      const key = e.driver || e.label;
      if (!map.has(key)) {
        map.set(key, { key, label: e.label, detail: e.detail, ccy: e.shared,
                       scheduled: !!e.scheduled, weight: e.weight, syms: [] });
      }
      const d = map.get(key);
      if (!d.syms.includes(a.sym)) d.syms.push(a.sym);
      // The nearest event wins the label — "in 20 min" beats "in 1.5h".
      if (e.weight > d.weight) { d.weight = e.weight; d.label = e.label; }
    }
  }
  return [...map.values()].sort((a, b) =>
    (b.syms.length * b.weight) - (a.syms.length * a.weight));
}

// Everything worth looking at, most confluent first.
//
// The threshold is on BREADTH, not score: one very loud technical signal is
// what every other screen in this app already shows. This one exists to find
// the moments when unrelated kinds of evidence point at the same instrument.
export function rank(feed, { news = null, cot = null, now = Date.now(),
                             minBreadth = 2, top = null } = {}) {
  const scored = [];
  let total = 0;
  // Measured once over the whole board, then applied to each instrument. What
  // counts as a rare M15 event is a property of the population, not of one
  // chart, so it cannot be decided inside assess().
  const cuts = rarityCutoffs(feed);
  const pools = pooledRecords(feed);
  for (const [sym, rec] of Object.entries(feed?.instruments || {})) {
    total++;
    const a = assess(sym, rec, { news, cot, now, cuts, pools });
    if (a) scored.push(a);
  }
  scored.sort((a, b) => b.score - a.score);

  // Percentile against everything measured, not against everything shown.
  //
  // Absolute thresholds do not survive contact with a real market: on a quiet
  // day nothing clears them and on a volatile one everything does, and either
  // way the screen stops discriminating. A rank is stable — "the third most
  // unusual instrument of seventy-two" means the same thing in both.
  scored.forEach((a, i) => {
    a.rank = i + 1;
    a.of = total;
    a.pct = Math.round(((total - i) / total) * 100);
  });

  let out = scored.filter(a => a.breadth >= minBreadth);
  if (top) out = out.slice(0, top);
  return out;
}

// How stale the data is. A live screen that quietly shows yesterday's readings
// as current is worse than one that is honestly empty.
export function ageOf(feed, news, now = Date.now()) {
  const f = feed?.updatedAt ? now - Date.parse(feed.updatedAt) : null;
  const n = news?.updatedAt ? now - Date.parse(news.updatedAt) : null;
  return {
    feedMs: f, newsMs: n,
    feedStale: f == null || f > 30 * 60e3,
    newsStale: n == null || n > 90 * 60e3,
  };
}

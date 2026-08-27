// The gold-silver ratio, and whether it means anything.
//
// The app has labelled it against fixed numbers for years — above 80 "Extreme
// High", below 45 "Extreme Low" — thresholds from a decade when it lived
// between those two. It has spent long stretches above 80 since, so the card
// has been calling ordinary days extreme, and the question the label implies
// has never been asked: at a stretched ratio, does anything follow?
//
// These check the measurement of that, and most of them check the ways it could
// be faked into looking like a finding.
const path = require('path');
const M = require(path.join(__dirname, '..', 'vps-bot', 'src', 'metalsStudy.js'));

let fails = 0;
const check = (n, c, e = '') => { console.log(`${c ? '  ok  ' : '  FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };
const DAY = 86400e3;

// ── Pairing ─────────────────────────────────────────────────────────────────
// A ratio built from gold on Tuesday and silver on Wednesday is not a ratio.
{
  const au = [{ t: 1, c: 100 }, { t: 2, c: 110 }, { t: 3, c: 120 }];
  const ag = [{ t: 1, c: 2 },                     { t: 3, c: 3 }];
  const p = M.pairSeries(au, ag);
  check('only days both metals printed are paired', p.length === 2, String(p.length));
  check('and the ratio is built from the same day', p[0].ratio === 50 && p[1].ratio === 40,
    JSON.stringify(p.map(x => x.ratio)));
  check('a missing day is skipped rather than carried forward',
    !p.some(x => x.t === 2));
  check('a zero or missing price is refused',
    M.pairSeries([{ t: 1, c: 0 }], [{ t: 1, c: 2 }]).length === 0);
}

// ── The percentile cannot see the future ────────────────────────────────────
{
  const prior = Array.from({ length: 200 }, (_, i) => i);
  check('a value above everything seen so far ranks at the top',
    M.pctileOf(500, prior) === 100);
  check('and below everything at the bottom', M.pctileOf(-5, prior) === 0);
  check('six months of prior days is required before a percentile is real',
    M.pctileOf(50, [1, 2, 3]) === null,
    `MIN_HISTORY is ${M.MIN_HISTORY} — ranking day three against two days is not an extreme`);
}

// ── Episodes, not days ──────────────────────────────────────────────────────
// The ratio sits stretched for weeks. Counting each day turns one event into
// forty and makes almost anything significant.
{
  const rows = [50, 95, 96, 97, 95, 50, 92, 50].map(pct => ({ pct }));
  const eps = M.episodes(rows, p => p >= 90);
  check('a four-day run of extremes is one episode, and a later run is another',
    eps.length === 2, JSON.stringify(eps));
  check('each is dated at its first day, the only one you could have acted on',
    eps[0] === 1 && eps[1] === 6, JSON.stringify(eps));
  check('counting days instead would have said five',
    rows.filter(r => r.pct >= 90).length === 5, 'which is the inflation this avoids');
  check('a day with no percentile yet is never an episode',
    M.episodes([{ pct: null }, { pct: null }], p => p >= 90).length === 0);
}

// ── The hypothesis is pre-specified, and a wrong one shows as wrong ─────────
// A ratio that keeps climbing from every extreme is a trending relationship,
// and "it reverts" must come back negative on it rather than being relabelled.
{
  // Ratio rises relentlessly: every extreme is followed by more of the same.
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const ratio = 50 * Math.pow(1.004, i);
    rows.push({ t: i * DAY, au: 2000, ag: 2000 / ratio, ratio, pct: i > 200 ? 95 : 50 });
  }
  const b = M.bucket(rows, p => p >= 90, 'fall', 'stretched');
  const h = b.horizons[20];
  check('a stretched-then-more-stretched market is found as an episode',
    b.episodes >= 1, String(b.episodes));
  check('and "it reverts" comes back as a loss rather than being flipped',
    h && h.ratioWin === 0, h ? `${h.ratioWin}%` : 'no result');
  check('the baseline is measured the same way and also loses',
    h && h.ratioBase === 0, h ? `${h.ratioBase}%` : '');
  check('so the edge is zero, which is the point of not using 50% as a benchmark',
    h && h.ratioZ === null || h.ratioWin === h.ratioBase,
    h ? `${h.ratioWin} vs ${h.ratioBase}` : '');
}

// ── Both questions are reported, because they are different ────────────────
// "The ratio fell" can mean silver rose OR gold dropped, and only one of those
// is the trade the label implies.
{
  const rows = [];
  for (let i = 0; i < 400; i++) {
    // Gold falls, silver flat: the ratio drops without silver doing anything.
    const au = 2000 * Math.pow(0.998, i);
    const ag = 25;
    rows.push({ t: i * DAY, au, ag, ratio: au / ag, pct: i > 150 && i < 160 ? 95 : 50 });
  }
  const b = M.bucket(rows, p => p >= 90, 'fall', 'stretched');
  const h = b.horizons[20];
  check('the metals are reported separately, not only the ratio',
    h && h.auMedPct != null && h.agMedPct != null, JSON.stringify([h?.auMedPct, h?.agMedPct]));
  check('so a ratio that fell because GOLD dropped is visible as that',
    h && h.auMedPct < -1 && Math.abs(h.agMedPct) < 0.01,
    h ? `gold ${h.auMedPct}%, silver ${h.agMedPct}%` : '');
  check('and the pair trade is scored on its own',
    h && h.pairWin != null && h.pairBase != null, JSON.stringify([h?.pairWin, h?.pairBase]));
}

// ── Lead-lag ────────────────────────────────────────────────────────────────
// A lead only matters if it beats the same-day relationship, which between
// these two is always strong.
{
  // Silver copies gold's move one day later, exactly.
  const rows = [{ t: 0, au: 2000, ag: 25, ratio: 80 }];
  const bumps = Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? 1.02 : 0.997));
  for (let i = 1; i < 300; i++) {
    const au = rows[i - 1].au * bumps[i];
    const ag = rows[i - 1].ag * bumps[i - 1];     // one day behind
    rows.push({ t: i * DAY, au, ag, ratio: au / ag });
  }
  const ll = M.leadLag(rows);
  check('a one-day lead is detected', ll.goldLeadsSilver[0].r > 0.9,
    JSON.stringify(ll.goldLeadsSilver[0]));
  check('and it beats the same-day correlation, which is what makes it a lead',
    ll.goldLeadsSilver[0].r > Math.abs(ll.sameDay), `${ll.goldLeadsSilver[0].r} vs ${ll.sameDay}`);
  check('the other direction is reported too, so a lead cannot be assumed',
    Array.isArray(ll.silverLeadsGold) && ll.silverLeadsGold.length === 5);
  check('too short a series gives null rather than a number',
    M.leadLag(rows.slice(0, 20)).sameDay === null);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

'use strict';
// vps-bot/src/hourStudy.js
//
// When does each market actually move?
//
// "London open" and "the New York session" are things everyone repeats, and
// they are broadly right, but they are somebody else's measurement of somebody
// else's instruments. This measures yours: two months of fifteen-minute bars,
// bucketed by hour of the day, so the answer is about the pairs and the
// commodities on your board rather than about FX in general.
//
// Three things it reports per hour, and they are not the same question:
//
//   RANGE — how far price travels within the hour, as a share of that
//   instrument's own average. This is the one that says "things happen here".
//
//   COST — the spread as a share of that hour's typical range. A fast hour with
//   a wide spread is not a tradeable hour, and on a thin instrument the fastest
//   hour of the day can also be the most expensive.
//
//   DIRECTIONAL SHARE — how much of the hour's range ends up as net movement
//   rather than being given back. A high-range hour that closes where it opened
//   is chop; the same range that carries somewhere is a trend hour, and only
//   the second is worth holding through.
//
// Normalised per instrument before pooling, so gold's dollar range and
// EUR/USD's cannot be added together and so a single volatile instrument
// cannot dominate its class.

const HOURS = 24;
// Two months of M15 bars. Enough for roughly sixty observations per hour slot
// per instrument, which pooled across a class is a real sample rather than a
// suggestion. Fewer bars and the quiet hours are indistinguishable from noise.
const BARS = 5000;
const MIN_PER_SLOT = 20;

// Fifteen-minute bars, four to the hour. Bucketed by the hour the bar OPENS in,
// in UTC, because that is the clock every session and release is quoted in.
function profileOne(cs, spreadAbs) {
  const slots = Array.from({ length: HOURS }, () => ({ range: 0, net: 0, n: 0 }));
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i];
    const h = new Date(c.t).getUTCHours();
    if (!(c.h > 0) || !(c.l > 0)) continue;
    const s = slots[h];
    s.range += (c.h - c.l);
    s.net += Math.abs(c.c - c.o);
    s.n++;
  }
  const used = slots.filter(s => s.n >= MIN_PER_SLOT);
  if (used.length < HOURS / 2) return null;

  // The instrument's own average hourly range, so every instrument contributes
  // on the same scale.
  const meanRange = used.reduce((a, s) => a + s.range / s.n, 0) / used.length;
  if (!(meanRange > 0)) return null;

  return slots.map(s => {
    if (s.n < MIN_PER_SLOT) return null;
    const range = s.range / s.n;
    return {
      // 1.0 is this instrument's average hour. 1.4 means forty percent busier.
      rel: range / meanRange,
      // What share of the movement went somewhere rather than being retraced.
      carry: s.net / s.range,
      // What the spread costs against a typical bar of this hour. Null where
      // the instrument publishes no spread — 32 of 72 do not, and treating
      // those as free is how an untradeable setup became the best on the board.
      cost: spreadAbs > 0 ? spreadAbs / range : null,
      n: s.n,
    };
  });
}

function pool(profiles) {
  const out = [];
  for (let h = 0; h < HOURS; h++) {
    const rows = profiles.map(p => p[h]).filter(Boolean);
    if (!rows.length) { out.push(null); continue; }
    const mean = k => {
      const v = rows.map(r => r[k]).filter(x => x != null && Number.isFinite(x));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const cost = mean('cost');
    out.push({
      hour: h,
      rel: +mean('rel').toFixed(2),
      carry: +mean('carry').toFixed(2),
      cost: cost == null ? null : +cost.toFixed(3),
      instruments: rows.length,
      bars: rows.reduce((a, r) => a + r.n, 0),
    });
  }
  return out;
}

async function runHourStudy({ instruments, oanda, log = () => {}, bars = BARS }) {
  const byClass = {};
  const skipped = [];

  for (const inst of instruments.filter(i => i.oanda)) {
    try {
      const cs = await oanda.getCandles(inst.oanda, 'M15', bars);
      if (!cs || cs.length < 1000) { skipped.push(`${inst.sym}: ${cs?.length || 0} bars`); continue; }
      // The live spread, from the same 24-hour window the feed uses.
      let spread = 0;
      try {
        const ba = await oanda.getBidAskCandles(inst.oanda, 'M15', 96);
        const s = ba.map(c => c.ask - c.bid).filter(v => v > 0).sort((a, b) => a - b);
        spread = s.length ? s[Math.floor(s.length / 2)] : 0;
      } catch { /* no spread is a real state, not a failure */ }

      const p = profileOne(cs, spread);
      if (!p) { skipped.push(`${inst.sym}: too few full hours`); continue; }
      (byClass[inst.cls] ||= []).push(p);
    } catch (e) {
      skipped.push(`${inst.sym}: ${e.message.slice(0, 60)}`);
    }
  }

  const classes = {};
  for (const [cls, profiles] of Object.entries(byClass)) {
    if (profiles.length < 2) continue;
    const hours = pool(profiles);
    const ranked = hours.filter(Boolean).sort((a, b) => b.rel - a.rel);
    // The hour worth being at the screen for is not simply the fastest one: it
    // has to carry rather than chop, and it has to be affordable.
    const tradeable = hours.filter(h => h && h.rel >= 1.1 && (h.cost == null || h.cost <= 0.10))
      .sort((a, b) => (b.rel * b.carry) - (a.rel * a.carry));
    classes[cls] = {
      instruments: profiles.length,
      hours,
      busiest: ranked.slice(0, 4).map(h => h.hour),
      quietest: ranked.slice(-3).map(h => h.hour),
      best: tradeable.slice(0, 4).map(h => h.hour),
    };
    log(`Hour study: ${cls} — busiest ${ranked.slice(0, 3).map(h => `${h.hour}:00 (${h.rel}x)`).join(', ')}`);
  }

  return {
    asOf: new Date().toISOString(),
    bars, timezone: 'UTC', minPerSlot: MIN_PER_SLOT,
    note: 'rel is the hour\'s range against that instrument\'s own average; '
        + 'carry is the share of range that ends as net movement rather than being '
        + 'given back; cost is the spread as a share of the hour\'s typical range.',
    classes,
    skipped,
  };
}

module.exports = { runHourStudy, profileOne, pool, HOURS, MIN_PER_SLOT };

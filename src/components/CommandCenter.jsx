// src/components/CommandCenter.jsx
// What is unusual right now, and everything that agrees.
//
// The previous version scored five factors that were not five things: two were
// the same momentum reading counted twice, one was a clock returning an
// identical number for every instrument, and all of it came from recent price.
// It also ran entirely in the browser against OANDA, so it was blank at the
// weekend and its confidence percentage had never been validated against
// anything.
//
// This reads the VPS feed instead — 72 instruments, measured continuously,
// weekends included — and joins it to the calendar and headlines the bot
// publishes. Nothing here predicts. Every line is something that happened or
// is scheduled, with a stated rarity, and instruments are ranked by how many
// INDEPENDENT kinds of evidence point at them rather than by how loud any one
// reading is.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchFeed } from '../utils/liveFeed';
import { rank, ageOf, driversOf, clusters, FAMILY,
         pooledRecords, winInterval, verdictOf, zFor, MIN_EDGE_ATR,
         stopCosts, MAX_COST_SHARE } from '../utils/confluence';
import ChartModal from './ChartModal';
import { buildPlan, eventLine } from '../utils/tradePlan';
import { fetchMacro, macroDriversFor } from '../utils/macroDrivers';
import { instrumentRead } from '../utils/instrumentRead';

const NEWS_URL = 'https://raw.githubusercontent.com/amandeep97/Forex/main/bot/news.json';
const COT_URL  = 'https://raw.githubusercontent.com/amandeep97/Forex/main/bot/feed.json';

const FAM_COLOR = {
  price:'#818cf8', structure:'#34d399', volatility:'#fbbf24',
  crossasset:'#a78bfa', positioning:'#f472b6', news:'#60a5fa',
};

// Which markets are actually open, so a quiet screen at 3am on Sunday reads as
// "FX is shut" rather than as "nothing is happening".
function marketState(now = new Date()) {
  const day = now.getUTCDay(), h = now.getUTCHours();
  const fxOpen = !(day === 6 || (day === 0 && h < 22) || (day === 5 && h >= 21));
  const usEquity = day >= 1 && day <= 5 && (h > 14 || (h === 14 && now.getUTCMinutes() >= 30)) && h < 21;
  return { fxOpen, usEquity, crypto: true };
}

// "fx|sweep.H1" is a storage key, not a sentence.
const CLASS_WORD = { fx:'FX pairs', metal:'metals', index:'indices',
                     energy:'energy', crypto:'crypto', tradfi:'stocks' };
function prettySetup(key) {
  const [cls, rest] = key.split('|');
  const [type, tf] = (rest || '').split('.');
  const what = type === 'sweep' ? 'strong reversals (sweep and close back inside)'
             : type === 'break' ? 'structure breakouts'
             : type.replace(/_/g, ' ');
  return `${what} on ${tf}, ${CLASS_WORD[cls] || cls}`;
}

const fmtAge = ms => ms == null ? 'never'
  : ms < 90e3 ? 'just now'
  : ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago`
  : `${(ms / 3600e3).toFixed(1)}h ago`;

export default function CommandCenter() {
  const [feed, setFeed] = useState(null);
  const [news, setNews] = useState(null);
  const [macro, setMacro] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(Date.now());
  const [minBreadth, setMinBreadth] = useState(3);
  const [top, setTop] = useState(12);
  const [allOpen, setAllOpen] = useState(false);
  const [showDrivers, setShowDrivers] = useState(true);
  const [showWhatWorks, setShowWhatWorks] = useState(true);
  const [showPacks, setShowPacks] = useState(true);
  const [open, setOpen] = useState({});
  const [cls, setCls] = useState('all');
  const [dir, setDir] = useState('all');
  const [onlyStrong, setOnlyStrong] = useState(false);
  const [onlyMulti, setOnlyMulti] = useState(false);
  const [oneEach, setOneEach] = useState(false);
  const [q, setQ] = useState('');
  const [tf, setTf] = useState('all');
  // Swing first. Intraday ideas are still measured and still shown, but they
  // are a different trade with a different holding period, and mixing them into
  // one list asks you to compare a fortnight with an afternoon.
  const [hz, setHz] = useState('all');
  const [chart, setChart] = useState(null);
  const [balance, setBalance] = useState(() => +(localStorage.getItem('cc_balance') || 10000));
  const [riskPct, setRiskPct] = useState(() => +(localStorage.getItem('cc_risk') || 1));

  const load = useCallback(async () => {
    setErr('');
    const [f, n, m] = await Promise.allSettled([
      fetchFeed({ force: true }),
      fetch(`${NEWS_URL}?t=${Date.now()}`, { cache:'no-store', signal: AbortSignal.timeout(15000) })
        .then(r => r.status === 404 ? null : r.ok ? r.json() : null),
      // The fundamental leg. Fetched on a schedule for a long time and read by
      // three dashboards nobody opens while looking at a setup.
      fetchMacro({ force: true }).catch(() => null),
    ]);
    if (f.status === 'fulfilled' && f.value && !f.value.missing) setFeed(f.value);
    else if (f.status === 'rejected') setErr(f.reason?.message || 'feed unavailable');
    if (n.status === 'fulfilled') setNews(n.value);
    if (m.status === 'fulfilled') setMacro(m.value);
    setLoading(false);
    setTick(Date.now());
  }, []);

  useEffect(() => {
    load();
    // The VPS writes about once a minute; polling faster only burns battery.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const now = tick;
  const all = useMemo(
    () => feed ? rank(feed, { news, now, minBreadth }) : [],
    [feed, news, now, minBreadth]);

  const drivers = useMemo(() => driversOf(all), [all]);
  const packs = useMemo(() => clusters(all), [all]);

  // Which kinds of setup the whole board says work, and which it says fail.
  //
  // Everything else on this screen answers "what is unusual right now". This
  // answers the prior question — whether that kind of unusual has ever been
  // worth anything — and it is the only view where the samples are large enough
  // to answer it. Recomputed off the feed, not off the filtered list, because
  // it is a property of the data rather than of what is currently on screen.
  const evidenceReport = useMemo(() => {
    if (!feed) return { total: 0, works: [], fails: [], silent: 0, tiny: 0, z: 1.96 };
    const pools = pooledRecords(feed);
    // Every setup here is one hypothesis, and they are all being examined at
    // once to find the winners. That is a search, so the threshold has to
    // account for how many were searched.
    const tests = Object.keys(pools).length;
    const works = [], fails = [], costly = [], uncosted = [];
    let silent = 0, tiny = 0;
    for (const [k, v] of Object.entries(pools)) {
      const iv = winInterval(v.win, v.n, tests);
      const row = [k, { ...v, lo: iv.lo, hi: iv.hi }];
      const verdict = verdictOf(v, tests);
      if (verdict === 'works') works.push(row);
      else if (verdict === 'fails') fails.push(row);
      // Two states that used to be invisible, and between them they held every
      // setup this panel was advertising. "costly" is a setup whose edge is
      // real and smaller than the spread — the remedy is a slower timeframe or
      // a cheaper market, not a better pattern. "uncosted" is an instrument
      // that publishes no spread at all, so nobody knows.
      else if (verdict === 'costly') costly.push(row);
      else if (verdict === 'uncosted') uncosted.push(row);
      else if (verdict === 'tiny') tiny++;
      else silent++;
    }
    costly.sort((a, b) => (b[1].stops?.expR ?? 0) - (a[1].stops?.expR ?? 0));
    // Ranked by what a trade in it returns over a random entry with the same
    // stop, where that was measured. The ATR edge is the fallback for a feed
    // published before the trades were run. The two are different units and are
    // never mixed — a given feed either has grids throughout or has none.
    const edge = v => v.stops ? v.stops.expR - v.stops.baseExpR : (v.edgeMed ?? v.med);
    works.sort((a, b) => edge(b[1]) - edge(a[1]));
    fails.sort((a, b) => a[1].win - b[1].win);

    // Where trading is affordable at all — the thing this screen has never
    // said, and the one that explains most of the list above. On FX M15 a 0.5
    // ATR stop is 1.2 pips and the spread is 1.6, so the stop sits inside the
    // spread and no pattern of any quality can be taken there. Same spreads the
    // plans use, so the two can never disagree.
    const classes = [...new Set(Object.values(feed.instruments || {}).map(r => r.cls))];
    const afford = [];
    for (const cls of classes) {
      for (const tf of ['M15', 'M30', 'H1', 'H4', 'D']) {
        const shares = [];
        for (const rec of Object.values(feed.instruments || {})) {
          if (rec.cls !== cls) continue;
          const c = stopCosts(rec, tf);
          // The cheapest width available, because that is the best case.
          if (c) shares.push(Math.min(...c));
        }
        if (!shares.length) continue;
        shares.sort((x, y) => x - y);
        afford.push({ cls, tf, share: shares[Math.floor(shares.length / 2)], n: shares.length });
      }
    }
    const uncostedClasses = classes.filter(c =>
      !afford.some(a => a.cls === c) && Object.values(feed.instruments).some(r => r.cls === c));

    return { total: tests, works, fails, costly, uncosted, silent, tiny,
             afford, uncostedClasses, z: +zFor(tests).toFixed(2) };
  }, [feed]);

  const ranked = useMemo(() => {
    let out = all;
    if (cls !== 'all') out = out.filter(r => r.cls === cls);
    if (dir !== 'all') out = out.filter(r => r.dir === (dir === 'up' ? 'up' : 'down'));
    if (onlyStrong) out = out.filter(r => r.strong);
    if (onlyMulti)  out = out.filter(r => r.multiTf);
    // 'swing' keeps both swing setups and timed ones, because a timed entry IS
    // a swing setup — the fast signal only decided when.
    if (hz === 'swing')    out = out.filter(r => r.kind !== 'intraday');
    if (hz === 'trigger')  out = out.filter(r => r.kind === 'trigger');
    if (hz === 'intraday') out = out.filter(r => r.kind === 'intraday');
    if (tf !== 'all') out = out.filter(r => (r.tfs || []).includes(tf));
    if (q.trim())   out = out.filter(r => r.sym.toLowerCase().includes(q.trim().toLowerCase()));
    // One per currency. When the RBA meets, seven AUD pairs qualify and six of
    // them are the same idea — this keeps the strongest and drops the rest,
    // rather than making you scroll past near-duplicates.
    if (oneEach) {
      const used = new Set();
      out = out.filter(r => {
        if ((r.ccy || []).some(c => used.has(c))) return false;
        (r.ccy || []).forEach(c => used.add(c));
        return true;
      });
    }
    // Bounded by rank, not by a threshold. On a quiet day a threshold shows
    // nothing and on a busy one it shows everything; "the twelve most unusual
    // of seventy-two" means the same thing in both.
    return top ? out.slice(0, top) : out;
  }, [all, cls, dir, onlyStrong, onlyMulti, oneEach, q, tf, hz, top]);
  // The combined read, one per card on screen. Built here rather than inside
  // the render loop because the fundamental leg correlates six macro series
  // against the instrument's daily closes, and doing that again on every
  // keystroke in the search box is work nobody asked for.
  const reads = useMemo(() => {
    const m = new Map();
    if (!feed) return m;
    for (const r of ranked) {
      m.set(r.sym, instrumentRead(r.sym, feed.instruments?.[r.sym], r, {
        news, macro: macro ? macroDriversFor(r.sym, feed, macro) : null, now,
      }));
    }
    return m;
  }, [ranked, feed, news, macro, now]);

  const age = useMemo(() => ageOf(feed, news, now), [feed, news, now]);
  const mkt = useMemo(() => marketState(new Date(now)), [now]);

  const upcoming = useMemo(() => (news?.calendar || [])
    .filter(e => e.impact === 'high' && e.at > now && e.at < now + 12 * 3600e3)
    .slice(0, 4), [news, now]);

  const pill = on => ({
    fontSize:11, fontWeight:700, padding:'3px 9px', borderRadius:6, cursor:'pointer',
    border:`1px solid ${on ? '#a78bfa' : 'var(--border)'}`,
    background: on ? '#a78bfa22' : 'transparent',
    color: on ? '#a78bfa' : 'var(--text3)',
  });

  const S = {
    card:{ background:'var(--bg2, #0b1118)', border:'1px solid var(--border, #1e293b)',
           borderRadius:12, padding:'12px 14px', marginBottom:10 },
    h:{ fontSize:12, fontWeight:800, letterSpacing:'.06em', color:'var(--text3)', marginBottom:8 },
  };

  return (
    <div style={{ padding:12, maxWidth:900, margin:'0 auto' }}>
      {chart && <ChartModal instrument={chart} onClose={() => setChart(null)} />}
      <div style={{ display:'flex', alignItems:'baseline', gap:10, flexWrap:'wrap', marginBottom:4 }}>
        <h2 style={{ fontSize:18, fontWeight:800, margin:0, color:'var(--text)' }}>⚡ Command Center</h2>
        <span style={{ fontSize:11.5, color:'var(--text3)' }}>
          top {ranked.length} of {all[0]?.of ?? 0} measured
        </span>
        <button onClick={() => { setAllOpen(v => !v); setOpen({}); }}
          style={{ fontSize:11, fontWeight:700, padding:'4px 10px', borderRadius:6, cursor:'pointer',
            border:'1px solid var(--border)', background:'transparent', color:'var(--text3)' }}>
          {allOpen ? '⌃ collapse all' : '⌄ expand all'}
        </button>
        <button onClick={load} style={{ marginLeft:'auto', fontSize:11, fontWeight:700, padding:'4px 11px',
          borderRadius:6, cursor:'pointer', border:'1px solid var(--border)', background:'transparent', color:'var(--text3)' }}>
          ⟳ refresh
        </button>
      </div>

      {/* Freshness first. A live screen showing yesterday's readings as current
          is worse than one that is honestly empty. */}
      <div style={{ display:'flex', gap:14, flexWrap:'wrap', fontSize:11, marginBottom:10 }}>
        <span style={{ color: age.feedStale ? '#ef4444' : '#22c55e' }}>
          ● measurements {fmtAge(age.feedMs)}{age.feedStale ? ' — VPS may be down' : ''}
        </span>
        <span style={{ color: !news ? 'var(--text3)' : age.newsStale ? '#f59e0b' : '#22c55e' }}>
          ● news {news ? fmtAge(age.newsMs) : 'not published yet'}
        </span>
        <span style={{ color:'var(--text3)' }}>
          {mkt.fxOpen ? 'FX open' : 'FX closed'} · {mkt.usEquity ? 'US equities open' : 'US equities closed'} · crypto always
        </span>
      </div>

      {err && <div style={{ ...S.card, borderColor:'#ef444455', color:'#fca5a5', fontSize:12 }}>⚠ {err}</div>}

      {!news && (
        <div style={{ ...S.card, borderColor:'#f59e0b44', fontSize:11.5, color:'#c7d2da', lineHeight:1.7 }}>
          News is not published yet. The bot writes it on its next pass — until then this screen shows
          technical and positioning evidence only, and no calendar.
        </div>
      )}

      {packs.length > 0 && (
        <div style={{ ...S.card, borderColor:'#34d39944' }}>
          <div style={{ ...S.h, cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}
            onClick={() => setShowPacks(v => !v)}>
            <span>{showPacks ? '⌄' : '›'}</span> MOVING AS A GROUP
            <span style={{ marginLeft:'auto', fontWeight:600 }}>{packs.length}</span>
          </div>
          {showPacks && (<>
          {packs.map(p => (
            <div key={p.cls + p.dir} style={{ padding:'3px 0', fontSize:12.5 }}>
              <span style={{ color: p.dir === 'up' ? '#22c55e' : '#ef4444', fontWeight:800 }}>
                {p.n} of {p.total} {p.cls}
              </span>
              <span style={{ color:'var(--text)' }}> pointing {p.dir === 'up' ? 'up' : 'down'} together</span>
              <div style={{ fontSize:11, color:'var(--text3)' }}>{p.syms.join(', ')}</div>
            </div>
          ))}
          <div style={{ fontSize:10.5, color:'var(--text3)', marginTop:7, lineHeight:1.6 }}>
            One instrument firing is a setup. Most of a class firing the same way is a regime — the
            dollar, real rates, risk appetite — and it is a reason to check total exposure rather
            than to take another position in the same direction.
          </div></>)}
        </div>
      )}

      {/* Shared drivers, once. One RBA decision is one fact, however many pairs
          contain AUD. */}
      {drivers.length > 0 && (
        <div style={{ ...S.card, borderColor:'#60a5fa44' }}>
          <div style={{ ...S.h, cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}
            onClick={() => setShowDrivers(v => !v)}>
            <span>{showDrivers ? '⌄' : '›'}</span> WHAT IS DRIVING THINGS
            <span style={{ marginLeft:'auto', fontWeight:600 }}>{drivers.length}</span>
          </div>
          {showDrivers && (<>
          {drivers.slice(0, 5).map(d => (
            <div key={d.key} style={{ padding:'4px 0', fontSize:12.5 }}>
              <div style={{ color:'var(--text)' }}>
                {d.scheduled && <span style={{ color:'#60a5fa', fontWeight:800, marginRight:6 }}>◷</span>}
                {d.label}
              </div>
              <div style={{ fontSize:11, color:'var(--text3)', marginTop:2 }}>
                touches {d.syms.length} instrument{d.syms.length === 1 ? '' : 's'} — {d.syms.slice(0, 8).join(', ')}
                {d.syms.length > 8 ? ` +${d.syms.length - 8}` : ''}
              </div>
            </div>
          ))}
          <div style={{ fontSize:10.5, color:'var(--text3)', marginTop:7, lineHeight:1.6 }}>
            Shown once. A currency event is identical on every pair holding that currency, so it is
            context — it cannot tell you which of them is more interesting, and it no longer inflates
            their ranking.
          </div></>)}
        </div>
      )}

      {/* What the whole board says about each kind of setup.
          The point of pooling: one instrument's sweep is thirty samples and
          says nothing; the same sweep across a class is hundreds and can. This
          is the only place in the app that answers "which setups are even
          worth looking for", and the answer is mostly "none of them". */}
      {evidenceReport.total > 0 && (
        <div style={{ ...S.card, borderColor:'#34d39944' }}>
          <div style={{ ...S.h, cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}
            onClick={() => setShowWhatWorks(v => !v)}>
            <span>{showWhatWorks ? '⌄' : '›'}</span> WHAT ACTUALLY WORKS
            <span style={{ marginLeft:'auto', fontWeight:600 }}>
              {evidenceReport.works.length} of {evidenceReport.total}
            </span>
          </div>
          {showWhatWorks && (<>
            {evidenceReport.works.map(([k, v]) => (
              <div key={k} style={{ padding:'4px 0', fontSize:12.5 }}>
                <span style={{ color:'#22c55e', fontWeight:800, marginRight:6 }}>✓</span>
                <span style={{ color:'var(--text)' }}>{prettySetup(k)}</span>
                {/* Where the trades were actually run, the line describes the
                    trade: the stop it was run with, what it returned, and what
                    the same stop returned on a random bar. The horizon win rate
                    describes holding blind for N bars with no stop, which is
                    not what the row above it is offering. */}
                {v.stops
                  ? <div style={{ fontSize:11, color:'var(--text3)', marginTop:2, marginLeft:20 }}>
                      with a {v.stops.stopAtr} ATR stop and a {v.stops.rr}R target, over {v.n.toLocaleString()} occurrences
                      across {v.syms} instruments: target hit {v.stops.hit}% against {v.stops.baseHit}% for a random
                      entry, <strong style={{ color:'#22c55e' }}>{v.stops.expR > 0 ? '+' : ''}{v.stops.expR}R a trade
                      against {v.stops.baseExpR}R</strong> · usually over in {v.stops.exitBars} bars
                    </div>
                  : <div style={{ fontSize:11, color:'var(--text3)', marginTop:2, marginLeft:20 }}>
                      {v.win}% over {v.n.toLocaleString()} occurrences across {v.syms} instruments
                      {v.baseWin != null
                        ? <> · the market itself did {v.baseWin}% over the same window, so the setup
                            adds <strong style={{ color:'#22c55e' }}>{v.edgeWin > 0 ? '+' : ''}{v.edgeWin} points
                            and {v.edgeMed > 0 ? '+' : ''}{v.edgeMed} ATR</strong></>
                        : <> ({v.lo}–{v.hi}%) · median +{v.med} ATR · no market baseline yet</>}
                    </div>}
              </div>
            ))}
            {evidenceReport.fails.slice(0, 4).map(([k, v]) => (
              <div key={k} style={{ padding:'4px 0', fontSize:12.5 }}>
                <span style={{ color:'#ef4444', fontWeight:800, marginRight:6 }}>✗</span>
                <span style={{ color:'var(--text)' }}>{prettySetup(k)}</span>
                <div style={{ fontSize:11, color:'var(--text3)', marginTop:2, marginLeft:20 }}>
                  {v.win}% over {v.n.toLocaleString()} across {v.syms} instruments
                  {v.baseWin != null
                    ? <> against {v.baseWin}% for the market over the same window — {v.edgeWin} points worse</>
                    : <> ({v.lo}–{v.hi}%) · median {v.med} ATR — worse than a coin flip</>}
                </div>
              </div>
            ))}
            {/* Setups whose edge is real and smaller than the cost of taking
                it. These used to be counted as working: the stop width was
                chosen on measured edge alone and the spread was checked
                afterwards, against a width picked without it. The best-looking
                setup on this board was a 1.2 pip stop on a 1.6 pip spread. */}
            {evidenceReport.costly.length > 0 && (
              <div style={{ marginTop:8, paddingTop:7, borderTop:'1px solid var(--border)' }}>
                <div style={{ fontSize:11, color:'#f59e0b', fontWeight:700 }}>
                  {evidenceReport.costly.length} more work and cost more than they pay
                </div>
                {evidenceReport.costly.slice(0, 3).map(([k, v]) => (
                  <div key={k} style={{ fontSize:11, color:'var(--text3)', marginTop:3, marginLeft:2 }}>
                    {prettySetup(k)} — {v.stops.expR}R a trade, spread is{' '}
                    <strong style={{ color:'#f59e0b' }}>{Math.round(v.stops.cost * 100)}% of the stop</strong>
                    {' '}even at {v.stops.cheapestAt} ATR
                  </div>
                ))}
              </div>
            )}
            {evidenceReport.uncosted.length > 0 && (
              <div style={{ fontSize:11, color:'var(--text3)', marginTop:6 }}>
                {evidenceReport.uncosted.length} pass the record and publish no spread, so whether they
                can be taken is unknown: {evidenceReport.uncosted.slice(0,3).map(([k]) => prettySetup(k)).join(', ')}
              </div>
            )}

            {/* Which markets are affordable at all, at the cheapest stop width
                measured. Nothing else on this screen answers it, and it decides
                more than any pattern does. */}
            <div style={{ marginTop:9, paddingTop:7, borderTop:'1px solid var(--border)' }}>
              <div style={{ fontSize:11, fontWeight:700, color:'var(--text2)', marginBottom:4 }}>
                WHERE THE SPREAD LETS YOU TRADE
              </div>
              <div style={{ overflowX:'auto' }}>
                <table style={{ borderCollapse:'collapse', fontSize:10.5, color:'var(--text3)' }}>
                  <thead><tr>
                    <th style={{ textAlign:'left', padding:'2px 8px 2px 0' }}></th>
                    {['M15','M30','H1','H4','D'].map(tf =>
                      <th key={tf} style={{ padding:'2px 7px', fontWeight:600 }}>{tf}</th>)}
                  </tr></thead>
                  <tbody>
                    {[...new Set(evidenceReport.afford.map(a => a.cls))].map(cls => (
                      <tr key={cls}>
                        <td style={{ padding:'2px 8px 2px 0', color:'var(--text2)' }}>{cls}</td>
                        {['M15','M30','H1','H4','D'].map(tf => {
                          const a = evidenceReport.afford.find(x => x.cls === cls && x.tf === tf);
                          if (!a) return <td key={tf} style={{ padding:'2px 7px', textAlign:'center' }}>—</td>;
                          const ok = a.share <= MAX_COST_SHARE;
                          return (
                            <td key={tf} style={{ padding:'2px 7px', textAlign:'right',
                              color: ok ? '#22c55e' : a.share > 0.5 ? '#ef4444' : 'var(--text3)' }}>
                              {Math.round(a.share * 100)}%
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize:10, color:'var(--text3)', marginTop:4, lineHeight:1.55 }}>
                Spread as a share of the stop, at the cheapest width measured, median across the
                instruments in each class. Green is takeable — above {Math.round(MAX_COST_SHARE*100)}%
                the cost outweighs the edge whatever the pattern says.
                {evidenceReport.uncostedClasses.length > 0 &&
                  ` ${evidenceReport.uncostedClasses.join(' and ')} publish no spread and cannot be checked.`}
              </div>
            </div>

            <div style={{ fontSize:10.5, color:'var(--text3)', marginTop:7, lineHeight:1.6 }}>
              {evidenceReport.total} setups tested at once, so the bar is raised to match:
              a 95% interval is a statement about one question, and asking {evidenceReport.total}
              of them would throw up four or five winners by chance alone. Each one here has to
              clear a coin flip at {evidenceReport.z} standard deviations rather than 1.96, and
              show a median move of at least {MIN_EDGE_ATR} ATR beyond the baseline, since a real
              edge of two hundredths of an ATR is eaten whole by the spread. Each setup is measured
              against what <em>every</em> bar did over the same window, not against 50% — otherwise
              a market that drifted up credits its drift to every bullish pattern in it.
              {evidenceReport.tiny > 0 && ` ${evidenceReport.tiny} clear the first bar and fail the second.`}
              {' '}{evidenceReport.silent} say nothing at all. Pooled within an asset class:
              one pair's sweep is a few dozen samples, the class's is thousands.
            </div>
          </>)}
        </div>
      )}

      {/* Scheduled risk. The only forward-looking thing here, and all it says is
          that it is coming. */}
      {upcoming.length > 0 && (
        <div style={{ ...S.card, borderColor:'#60a5fa44' }}>
          <div style={S.h}>NEXT 12 HOURS</div>
          {upcoming.map((e, i) => {
            const hrs = (e.at - now) / 3600e3;
            return (
              <div key={i} style={{ display:'flex', gap:8, alignItems:'baseline', padding:'3px 0', fontSize:12.5 }}>
                <span style={{ width:44, fontWeight:800, color: hrs < 2 ? '#f59e0b' : '#60a5fa' }}>
                  {hrs < 1 ? `${Math.round(hrs*60)}m` : `${hrs.toFixed(1)}h`}
                </span>
                <span style={{ width:38, color:'var(--text3)', fontWeight:700 }}>{e.country}</span>
                <span style={{ color:'var(--text)' }}>{e.title}</span>
                {e.forecast && <span style={{ color:'var(--text3)', fontSize:11 }}>fc {e.forecast}</span>}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ ...S.card, padding:'10px 12px' }}>
        <div style={{ display:'flex', gap:5, flexWrap:'wrap', alignItems:'center' }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="search"
            style={{ fontSize:11.5, padding:'3px 8px', borderRadius:6, width:92,
              background:'var(--bg, #070b12)', color:'var(--text)', border:'1px solid var(--border)' }}/>
          {[['all','All'],['fx','FX'],['metal','Metals'],['index','Indices'],
            ['energy','Energy'],['crypto','Crypto'],['tradfi','TradFi']].map(([v,l]) => (
            <button key={v} onClick={() => setCls(v)} style={pill(cls===v)}>{l}</button>
          ))}
        </div>
        {/* Horizon before anything else, because it decides what the rest of
            the card means: the same instrument is a two-week idea on Daily and
            an afternoon's trade on M15, and they are not comparable. */}
        <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginTop:6, alignItems:'center' }}>
          <span style={{ fontSize:11, color:'var(--text3)' }}>hold</span>
          {[['all','Any'],['swing','Swing'],['trigger','Timed entry'],['intraday','Intraday']].map(([v,l]) => (
            <button key={v} onClick={() => setHz(v)}
              title={v === 'swing' ? 'D and H4 setups, held for days to weeks — includes timed entries'
                   : v === 'trigger' ? 'A swing setup with a faster signal agreeing: the entry is timed'
                   : v === 'intraday' ? 'H1 and below, with nothing on the slow timeframes — held for hours'
                   : ''}
              style={{ ...pill(hz===v),
                ...(hz===v && v!=='all' ? { borderColor:'#34d399', background:'#34d39922', color:'#34d399' } : {}) }}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginTop:6 }}>
          {[['all','Both ways'],['up','Bullish'],['down','Bearish']].map(([v,l]) => (
            <button key={v} onClick={() => setDir(v)} style={pill(dir===v)}>{l}</button>
          ))}
          {[['all','Any TF'],['M15','15m'],['M30','30m'],['H1','1H'],['H4','H4'],['D','Daily']].map(([v,l]) => (
            <button key={v} onClick={() => setTf(v)} style={pill(tf===v)}>{l}</button>
          ))}
          <button onClick={() => setOnlyStrong(v => !v)} style={pill(onlyStrong)}>Strong hammer / star</button>
          <button onClick={() => setOnlyMulti(v => !v)} style={pill(onlyMulti)}>Multi-timeframe</button>
          <button onClick={() => setOneEach(v => !v)} style={pill(oneEach)}
            title="When one event moves a currency, keep the strongest pair instead of seven versions of it">
            One per currency
          </button>
        </div>
      </div>

      <div style={{ display:'flex', gap:6, marginBottom:10, alignItems:'center', flexWrap:'wrap' }}>
        <span style={{ fontSize:11, color:'var(--text3)' }}>show top</span>
        {[8, 12, 25, null].map(n => (
          <button key={String(n)} onClick={() => setTop(n)} style={pill(top===n)}>
            {n ?? 'all'}
          </button>
        ))}
        <span style={{ fontSize:11, color:'var(--text3)', marginLeft:8 }}>with at least</span>
        {[2, 3, 4].map(n => (
          <button key={n} onClick={() => setMinBreadth(n)}
            style={{ fontSize:11, fontWeight:700, padding:'3px 9px', borderRadius:6, cursor:'pointer',
              border:`1px solid ${minBreadth===n ? '#a78bfa' : 'var(--border)'}`,
              background: minBreadth===n ? '#a78bfa22' : 'transparent',
              color: minBreadth===n ? '#a78bfa' : 'var(--text3)' }}>
            {n} kinds
          </button>
        ))}
      </div>

      <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap', marginBottom:10, fontSize:11, color:'var(--text3)' }}>
        <span>size plans for balance</span>
        <input value={balance} onChange={e => { const v = +e.target.value || 0; setBalance(v); localStorage.setItem('cc_balance', v); }}
          style={{ width:80, fontSize:11.5, padding:'3px 7px', borderRadius:6,
            background:'var(--bg, #070b12)', color:'var(--text)', border:'1px solid var(--border)' }}/>
        <span>risking</span>
        <input value={riskPct} onChange={e => { const v = +e.target.value || 0; setRiskPct(v); localStorage.setItem('cc_risk', v); }}
          style={{ width:46, fontSize:11.5, padding:'3px 7px', borderRadius:6,
            background:'var(--bg, #070b12)', color:'var(--text)', border:'1px solid var(--border)' }}/>
        <span>% per trade</span>
      </div>

      {loading && <div style={{ ...S.card, color:'var(--text3)', fontSize:12 }}>Loading measurements…</div>}

      {!loading && ranked.length === 0 && (
        <div style={{ ...S.card, fontSize:12.5, color:'#c7d2da', lineHeight:1.8 }}>
          Nothing has {minBreadth} independent kinds of evidence stacked on it right now.
          <div style={{ color:'var(--text3)', marginTop:4 }}>
            That is the normal state and it is the honest answer — confluence is rare, which is the
            only reason it is worth watching for. Lower the threshold to see less selective results.
          </div>
        </div>
      )}

      {ranked.map(r => {
        const isOpen = open[r.sym] ?? allOpen;
        const show = isOpen ? r.evidence : r.evidence.slice(0, 3);
        // Built once per card. Two separate blocks below need it — the plan
        // itself and the shared-driver line, which has to know what the plan
        // already named so the same event is not printed twice.
        const plan = buildPlan(r, feed?.instruments?.[r.sym], { balance, riskPct, news, now });
        return (
          <div key={r.sym} style={{ ...S.card,
            borderColor: r.dir === 'up' ? '#22c55e44' : r.dir === 'down' ? '#ef444444' : 'var(--border)' }}>
            <div style={{ display:'flex', gap:8, alignItems:'baseline', flexWrap:'wrap' }}>
              <span style={{ fontSize:15, fontWeight:800, color:'var(--text)' }}>{r.sym}</span>
              {r.dir && (
                <span style={{ fontSize:10, fontWeight:900, padding:'1px 7px', borderRadius:4,
                  color: r.dir === 'up' ? '#22c55e' : '#ef4444',
                  border:`1px solid ${r.dir === 'up' ? '#22c55e55' : '#ef444455'}` }}>
                  {r.dir === 'up' ? 'BULLISH' : 'BEARISH'}
                </span>
              )}
              {/* What kind of trade this is, before anything about how good it
                  looks. A timed entry and an intraday idea are different
                  commitments, not different scores. */}
              <span style={{ fontSize:9.5, fontWeight:900, padding:'1px 6px', borderRadius:3,
                color: r.kind === 'trigger' ? '#34d399' : r.kind === 'swing' ? '#7dd3fc' : '#94a3b8',
                border:`1px solid ${r.kind === 'trigger' ? '#34d39955' : r.kind === 'swing' ? '#7dd3fc55' : '#64748b55'}` }}>
                {r.kind === 'trigger' ? 'TIMED ENTRY' : r.kind === 'swing' ? 'SWING' : 'INTRADAY'}
              </span>
              {r.conflict && (
                <span style={{ fontSize:10, fontWeight:800, color:'#f59e0b' }}>EVIDENCE DISAGREES</span>
              )}
              {r.strong && <span style={{ fontSize:10, fontWeight:800, color:'#34d399' }}>STRONG CANDLE</span>}
              {r.multiTf && <span style={{ fontSize:10, fontWeight:800, color:'#a78bfa' }}>MULTI-TF</span>}
              <span style={{ marginLeft:'auto', fontSize:11, color:'var(--text3)' }}>
                #{r.rank} of {r.of} · {r.breadth} kinds · {r.price}
              </span>
            </div>

            {/* Which families are represented — the point of the screen, visible
                without reading the detail. */}
            <div style={{ display:'flex', gap:5, margin:'7px 0', flexWrap:'wrap' }}>
              {r.families.map(f => (
                <span key={f} style={{ fontSize:9.5, fontWeight:800, padding:'1px 6px', borderRadius:3,
                  color: FAM_COLOR[f], border:`1px solid ${FAM_COLOR[f]}44` }}>
                  {FAMILY[f]?.label || f}
                </span>
              ))}
            </div>

            {/* What is going on with this instrument, from every leg at once.
                Each one existed already and none of them talked to each other:
                the chart in confluence, the macro in macroDrivers, positioning
                arriving with the feed as a COT percentile, headlines matched to
                currencies, the calendar, and the lead-lag list. Six readings on
                six screens, and the combining was left to whoever was looking.

                The value is not any single line. It is seeing that three of
                them agree, or that the chart and the positioning flatly
                contradict each other — which no one screen could show. */}
            {(() => {
              const read = reads.get(r.sym);
              if (!read || read.legs.length < 2) return null;
              const tone = read.conflict ? '#f59e0b'
                         : read.dir === 'up' ? '#22c55e'
                         : read.dir === 'down' ? '#ef4444' : 'var(--text3)';
              return (
                <div style={{ margin:'8px 0 4px', padding:'7px 9px', borderRadius:5,
                  background:'var(--bg2)', border:`1px solid ${tone}33` }}>
                  <div style={{ fontSize:11.5, fontWeight:700, color:tone, marginBottom:5 }}>
                    {read.verdict}
                  </div>
                  {read.legs.map((l, i) => (
                    <div key={i} style={{ display:'flex', gap:7, alignItems:'baseline', marginTop:3 }}>
                      <span style={{ fontSize:10, width:12, flexShrink:0, textAlign:'center',
                        color: l.dir === 'up' ? '#22c55e' : l.dir === 'down' ? '#ef4444' : 'var(--text3)' }}>
                        {l.dir === 'up' ? '▲' : l.dir === 'down' ? '▼' : '·'}
                      </span>
                      <span style={{ fontSize:10, textTransform:'uppercase', letterSpacing:0.4,
                        color:'var(--text3)', width:74, flexShrink:0 }}>{l.leg}</span>
                      <span style={{ fontSize:11.5, color:'var(--text)', lineHeight:1.5 }}>
                        {l.headline}
                        <span style={{ color:'var(--text3)' }}> — {l.detail}</span>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}

            {show.map((e, i) => (
              <div key={i} style={{ padding:'3px 0', fontSize:12.5 }}>
                <div style={{ display:'flex', gap:8, alignItems:'baseline' }}>
                  <span style={{ width:6, height:6, borderRadius:3, background:FAM_COLOR[e.family],
                    flexShrink:0, marginTop:5 }}/>
                  <span style={{ color:'var(--text)' }}>
                    {e.label}
                    {e.detail && <span style={{ color:'var(--text3)' }}> — {e.detail}</span>}
                  </span>
                </div>
                {e.base && (
                  <div style={{ fontSize:11, marginLeft:14, marginTop:2,
                    color: e.base.win >= 60 ? '#22c55e' : e.base.win <= 40 ? '#ef4444' : 'var(--text3)' }}>
                    last {e.base.n} times here: {e.base.win}% went its way after {e.base.bars} bars
                    <span style={{ color:'var(--text3)' }}>
                      {' '}· median {e.base.med > 0 ? '+' : ''}{e.base.med} ATR
                      {e.base.n < 15 ? ' · small sample' : ''}
                    </span>
                  </div>
                )}
              </div>
            ))}

            {(() => {
              const p = plan;
              if (!p?.ok) return null;
              // Amber for "we do not know", red only for "we measured it and it fails".
              // The difference is the whole point of the interval.
              const C = p.take ? '#22c55e'
                      : p.verdict === 'record-says-no' ? '#ef4444'
                      : p.verdict === 'inconclusive' ? '#94a3b8' : '#f59e0b';
              const evLine = eventLine(p);
              return (
                <div style={{ marginTop:8, borderTop:'1px solid #16202b', paddingTop:8 }}>
                  {p.take ? (
                    <>
                      <div style={{ display:'flex', gap:14, flexWrap:'wrap', fontSize:12.5 }}>
                        <span style={{ color:'var(--text3)' }}>entry <strong style={{ color:'var(--text)' }}>{p.entry}</strong></span>
                        <span style={{ color:'var(--text3)' }}>stop <strong style={{ color:'#ef4444' }}>{p.stop}</strong></span>
                        <span style={{ color:'var(--text3)' }}>target <strong style={{ color:'#22c55e' }}>{p.target}</strong></span>
                        <span style={{ color:'var(--text3)' }}>size <strong style={{ color:'var(--text)' }}>{p.units}</strong></span>
                      </div>
                      <div style={{ fontSize:11, color:C, marginTop:4, lineHeight:1.6 }}>
                        {p.rr}R — the median move after these, not a chosen ratio ·
                        {' '}<strong>{p.ev > 0 ? '+' : ''}{p.ev}R expected</strong>
                        {p.costShare != null && <span style={{ color:'var(--text3)' }}> · spread is {p.costShare}% of the stop</span>}
                      </div>
                      {/* The sample and its interval, because a win rate
                          without them is not a number you can act on. */}
                      <div style={{ fontSize:11, color:'var(--text3)', marginTop:2, lineHeight:1.6 }}>
                        from {p.pricedFrom} · {p.record?.win ?? '—'}% over {(p.pool?.n ?? p.record?.n)?.toLocaleString()} occurrences
                        {p.pool && p.pricedFrom !== 'this instrument'
                          ? ` (${p.pool.win}% ±${p.pool.ci} pooled)` : ` ±${p.record?.ci}`}
                      </div>
                      {p.fragile && (
                        <div style={{ fontSize:11, color:'#f59e0b', marginTop:2, lineHeight:1.6 }}>
                          ⚠ {p.fragile}
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ fontSize:11.5, color:C, lineHeight:1.65 }}>
                      <strong>{p.blocked ? 'CONDITIONS' : p.verdict === 'record-says-no' ? 'THE RECORD SAYS NO'
                        : p.verdict === 'negative' ? 'NOT WORTH THE RISK'
                        : p.verdict === 'inconclusive' ? 'NOT ENOUGH EVIDENCE' : 'CANNOT PRICE IT'}</strong>
                      {/* The note already names the market's own rate — "46% over
                          13 occurrences against 52% for the market itself". A
                          second sentence repeating "the market itself went that
                          way 52% of the time" put the same number twice in one
                          paragraph, which is the duplication fixed for the
                          calendar line three hours earlier and reintroduced here
                          by writing the explainer without rereading the note. */}
                      {' — '}{p.blocked || p.note}
                    </div>
                  )}
                  {/* What you are actually committing to.
                      Two numbers, not one. The window is the outer bound the
                      record was measured over and the calendar is searched
                      across; the typical hold is the median time to actually
                      leave, at the stop, at the target or at the end. This line
                      quoted only the first, so a trade usually over in four
                      hours was presented as "held about three days" — which is
                      exactly the thing that makes a setup unusable to somebody
                      who will not sit on a loser. */}
                  <div style={{ fontSize:11, color:'var(--text3)', marginTop:4, lineHeight:1.6 }}>
                    priced on {p.tf} · {p.hold.typical
                      ? <>usually over in <strong style={{ color:'var(--text2)' }}>{p.hold.typical.text}</strong>, {p.hold.text} at the outside</>
                      : <>held {p.hold.text}</>}
                    {p.stopFromRecord && <> · stop {p.stopAtr} ATR, the width these trades were measured at</>}
                    {p.triggeredBy && <> · timed by <span style={{ color:'#34d399' }}>{p.triggeredBy}</span></>}
                    {r.pullback && <> · <span style={{ color:'#f59e0b' }}>faster timeframes are pulling the other way</span></>}
                  </div>
                  {evLine && (
                    <div style={{ fontSize:11, marginTop:3, lineHeight:1.6,
                      color: p.events.next.inMs < 12 * 3600e3 ? '#f59e0b' : 'var(--text3)' }}>
                      ◷ {evLine}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Shared drivers, minus whatever the hold-window line already
                named. Both blocks reach for the nearest scheduled event, so a
                card read "7 high-impact releases inside the hold — next is USD
                Core CPI in 11.6h" and then "USD Core CPI in 11.6h +3 more
                drivers" directly underneath: one fact, printed twice, three
                lines apart. */}
            {(() => {
              const named = plan?.events?.next?.title;
              const rest = (r.shared || []).filter(d => !named || !d.label?.includes(named));
              if (!rest.length) return null;
              return (
                <div style={{ fontSize:11, color:'#60a5fa', marginTop:5 }}>
                  ◷ {rest[0].label}{rest.length > 1 ? ` +${rest.length - 1} more driver${rest.length > 2 ? 's' : ''}` : ''}
                </div>
              );
            })()}

            <div style={{ display:'flex', gap:10, alignItems:'center', marginTop:6 }}>
              {r.evidence.length > 3 && (
                <button onClick={() => setOpen(o => ({ ...o, [r.sym]: !isOpen }))}
                  style={{ fontSize:11, padding:0, background:'none', border:'none',
                    color:'#7dd3fc', cursor:'pointer' }}>
                  {isOpen ? 'less' : `+${r.evidence.length - 3} more`}
                </button>
              )}
              <button onClick={() => setChart({ symbol: r.sym, assetType: r.cls })}
                style={{ marginLeft:'auto', fontSize:11, fontWeight:700, padding:'3px 10px',
                  borderRadius:6, cursor:'pointer', border:'1px solid #7dd3fc55',
                  background:'#0b1a2a', color:'#7dd3fc' }}>
                📈 chart
              </button>
            </div>
          </div>
        );
      })}

      <div style={{ fontSize:11, color:'var(--text3)', lineHeight:1.75, marginTop:12 }}>
        Every line above is something that <strong>happened</strong> or is <strong>scheduled</strong>,
        with how often it happens on that instrument. Nothing here is a forecast, and the ordering is
        by how many unrelated kinds of evidence agree — not by how large any single reading is.
        Four signals from the same twenty candles are one piece of evidence, and are counted as one.
        <div style={{ marginTop:6 }}>
          Direction on a <strong>swing</strong> card comes only from its Daily and H4 evidence. A faster
          timeframe can time the entry — that is a <strong>timed entry</strong> — but it never flips the
          bias, because an M15 hammer inside a bearish daily setup is a pullback, not a reversal.
          The holding period on each plan is the window its record was measured over, and the calendar
          is searched across that whole window rather than the next few hours.
        </div>
      </div>
    </div>
  );
}

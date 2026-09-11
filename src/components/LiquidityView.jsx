import { useState, useEffect } from 'react';
import { fetchLiquidity, ago } from '../utils/liveFeed';

// ── LIQUIDITY ────────────────────────────────────────────────────────────────
//
// Who hunted what, and when.
//
// Its own mode rather than a panel inside FEED because it selects on something
// else entirely. FEED shows what matched the filters you wrote; this shows
// whatever is at a level right now whether or not a filter covers it. As a
// panel bolted onto FEED, an instrument sitting on yesterday's high was
// invisible unless some unrelated rule happened to let it through.
//
// Two halves, and the order is deliberate.
//
// THE EVENTS come first, newest at the top, each written as one sentence: what
// was hunted, on which timeframe, how long ago, and whether the two-minute
// reversal has confirmed yet. That sentence is the thing being watched for —
// "gold took the daily low twenty minutes ago and the turn confirmed four
// minutes ago" — and no arrangement of columns says it.
//
// THE TABLE comes second, for the sweep across everything: a row per
// instrument, a column per level, so "which one got hunted" is answered by
// looking rather than by reading.
//
// Everything here is measured on the VPS every minute. Nothing is computed in
// the browser, so closing the app changes nothing.

const C = {
  bg:'#080c11', panel:'#0b1118', line:'#16202b', dim:'#475569', txt:'#cbd5e1',
  accent:'#00d4aa', warn:'#f59e0b', bad:'#ef4444', good:'#22c55e',
  mono:'var(--mono, monospace)',
};

const COLS = [
  { key:'PDH', head:'D-High', title:"yesterday's high", tf:'1D' },
  { key:'PDL', head:'D-Low',  title:"yesterday's low",  tf:'1D' },
  { key:'PWH', head:'W-High', title:"last week's high", tf:'1W' },
  { key:'PWL', head:'W-Low',  title:"last week's low",  tf:'1W' },
  { key:'H4H', head:'4H-Hi',  title:'nearest H4 swing high', tf:'4H' },
  { key:'H4L', head:'4H-Lo',  title:'nearest H4 swing low',  tf:'4H' },
];

const CELL = {
  swept:   { bg:'#f59e0b22', fg:'#fbbf24', mark:'HUNT' },
  through: { bg:'#8b5cf622', fg:'#a78bfa', mark:'THRU' },
  near:    { bg:'#38bdf822', fg:'#38bdf8', mark:'near' },
  behind:  { bg:'transparent', fg:'#334155', mark:'—' },
  quiet:   { bg:'transparent', fg:'#1e293b', mark:'·' },
};

const TF_OF = { PDH:'1D', PDL:'1D', PWH:'1W', PWL:'1W', H4H:'4H', H4L:'4H' };
const SIDE_OF = { PDH:'sell-side above', PDL:'buy-side below', PWH:'sell-side above',
                  PWL:'buy-side below', H4H:'sell-side above', H4L:'buy-side below' };
const LABEL_OF = { PDH:"yesterday's high", PDL:"yesterday's low",
                   PWH:"last week's high", PWL:"last week's low",
                   H4H:'a 4H swing high', H4L:'a 4H swing low' };

const dpFor = p => (Math.abs(p) < 20 ? 5 : Math.abs(p) < 500 ? 3 : 2);

// ── What leads, and what waits behind a toggle ───────────────────────────────
//
// Thirty-four hunts in one list is not a feed, it is a haystack. Most of them
// are crosses nobody here trades — EUR/NZD, NZD/CAD, AUD/CHF — and they push
// gold and the majors off the first screen.
//
// So the list is split by what is actually traded rather than by anything the
// data says. This is a preference, not a measurement, and it is written as one:
// nothing is hidden, the rest is one tap away and still counted.
const MAJORS = new Set([
  'XAU/USD', 'XAG/USD',
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD',
  'US500', 'US100', 'US30', 'JPN225', 'GER40', 'UK100',
  'USOIL', 'UKOIL', 'BTC/USD', 'ETH/USD',
]);
const isMajor = sym => MAJORS.has(sym);

// ── The filter bar ───────────────────────────────────────────────────────────
//
// Modelled on SCAN's, because that idiom already works here and a second
// vocabulary for the same job is a tax on the reader.
//
// Three axes, because there are exactly three questions worth asking of this
// list and no more: is it actionable, which level got taken, and what kind of
// instrument. Anything else would be options for their own sake.
//
// Every chip carries its own count, so the bar answers "is there anything in
// there" without a tap. A filter you have to try before you know whether it is
// empty is a filter that gets used once.
const STATES = [
  { id:'all',     label:'All' },
  { id:'setup',   label:'Ready' },
  { id:'taken',   label:'Waiting' },
  { id:'missed',  label:'Missed' },
];
const TFS = [
  { id:'all', label:'All' },
  { id:'1D',  label:'1D' },
  { id:'1W',  label:'1W' },
  { id:'4H',  label:'4H' },
];
const CLASSES = [
  { id:'all',    label:'All' },
  { id:'major',  label:'Majors' },
  { id:'metal',  label:'Metals' },
  { id:'index',  label:'Indices' },
  { id:'fx',     label:'FX' },
  { id:'energy', label:'Energy' },
  { id:'crypto', label:'Crypto' },
];

function Chips({ options, value, onChange, counts }) {
  return (
    <div style={{ display:'flex', gap:5, flexWrap:'wrap', alignItems:'center' }}>
      {options.map(o => {
        const n = counts?.[o.id];
        // A chip with nothing behind it is shown, dimmed, rather than hidden.
        // Removing it would make the bar's shape change as the market moves,
        // and a control that appears and disappears is harder to learn than one
        // that is simply empty.
        const empty = n === 0;
        const on = value === o.id;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} disabled={empty && !on}
            style={{ fontSize:9, fontWeight:700, padding:'3px 8px', borderRadius:3,
              cursor: empty && !on ? 'default' : 'pointer', fontFamily:C.mono,
              border:`1px solid ${on ? '#38bdf855' : C.line}`,
              background: on ? '#38bdf815' : 'transparent',
              color: on ? '#38bdf8' : empty ? '#243040' : C.dim }}>
            {o.label}{n != null && <span style={{ opacity:0.65 }}> {n}</span>}
          </button>
        );
      })}
    </div>
  );
}

// Local clock, 24-hour. The reader's own time, not UTC: a list is checked
// against the clock on their phone, not against a timezone they have to convert.
const clockOf = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

// ── One event, as a sentence ─────────────────────────────────────────────────
//
// Written out rather than abbreviated because the whole point is that it reads
// as one thing: a hunt on a slow timeframe, then a turn on a fast one, with
// both times attached. A row of codes would need translating in your head every
// time, and the translation is where a wrong read comes from.
// Named HuntEvent, not Event. A module-scoped `function Event` shadows the DOM
// global inside this file, and a bundler that later merges scopes can turn that
// into "Illegal constructor" — a Web API called without `new` — somewhere else
// entirely. The name costs nothing; the class of bug it avoids is one that only
// shows up on some engines.
function HuntEvent({ e, onOpen }) {
  const long = e.dir === 'long';
  const col = e.state === 'setup' ? (long ? C.good : C.bad)
            : e.state === 'missed' ? '#64748b' : C.warn;
  const dp = dpFor(e.price);

  return (
    <div onClick={() => onOpen?.(e.sym)} style={{ padding:'8px 10px', borderTop:`1px solid ${C.line}`,
      cursor: onOpen ? 'pointer' : 'default' }}>
      <div style={{ display:'flex', gap:7, alignItems:'baseline', flexWrap:'wrap' }}>
        <strong style={{ fontSize:12, color:C.txt, fontFamily:C.mono }}>{e.sym}</strong>
        <span style={{ fontSize:9, fontWeight:900, color:C.warn, fontFamily:C.mono,
          border:`1px solid ${C.warn}44`, background:'#f59e0b0d', borderRadius:3, padding:'0 5px' }}>
          {e.tf} HUNT
        </span>
        {/* Clock time as well as the age. "18m ago" cannot be checked against
            the row above it at a glance; 09:22 can, and a list that claims to be
            in time order has to be verifiable. */}
        <span style={{ marginLeft:'auto', fontSize:8, color:'#334155', fontFamily:C.mono,
          textAlign:'right', lineHeight:1.4 }}>
          {e.lastAt ? clockOf(e.lastAt) : ''}
          <div style={{ opacity:0.7 }}>{e.lastAt ? ago(Date.now() - e.lastAt) : ''}</div>
        </span>
      </div>

      <div style={{ fontSize:10, color:C.dim, lineHeight:1.65, marginTop:3 }}>
        Took the <strong style={{ color:C.txt }}>{e.sideWord}</strong> liquidity at{' '}
        <strong style={{ color:C.txt, fontFamily:C.mono }}>{e.levelPrice.toFixed(dp)}</strong>{' '}
        ({e.levelLabel}, {e.tf})
        {e.sweptAt && <> <span style={{ color:'#334155' }}>· {ago(Date.now() - e.sweptAt)}</span></>}
        {e.state === 'setup' && (
          <> and the reversal <strong style={{ color:col }}>confirmed on M2</strong>
            {e.confirmedAt && <> {ago(Date.now() - e.confirmedAt)}</>}.</>
        )}
        {e.state === 'taken' && (
          <> — <strong style={{ color:C.warn }}>no M2 confirmation yet</strong>, waiting for a{' '}
            {long ? 'bullish' : 'bearish'} break.</>
        )}
        {e.state === 'missed' && (
          <> and the reversal confirmed {e.confirmedAt ? ago(Date.now() - e.confirmedAt) : ''}, but{' '}
            <strong style={{ color:'#64748b' }}>the entry has gone</strong>.</>
        )}
      </div>

      {e.state === 'setup' && e.entry != null && (
        <div style={{ display:'flex', gap:9, flexWrap:'wrap', marginTop:4, fontSize:9, fontFamily:C.mono }}>
          <span style={{ fontWeight:900, color:col }}>{long ? 'LONG' : 'SHORT'}</span>
          <span style={{ color:C.dim }}>entry <strong style={{ color:C.txt }}>{e.entry.toFixed(dp)}</strong></span>
          <span style={{ color:C.dim }}>stop <strong style={{ color:C.bad }}>{e.stop.toFixed(dp)}</strong></span>
          <span style={{ color:C.dim }}>risk <strong style={{ color:C.txt }}>{e.risk.toFixed(dp)}</strong></span>
        </div>
      )}
    </div>
  );
}

function Cell({ c }) {
  const st = CELL[c?.state || 'quiet'] || CELL.quiet;
  const title = c
    ? `${c.state} · ${c.price}${c.atrPct != null ? ` · ${c.atrPct} ATR away` : ''}`
      + `${c.at ? ` · ${ago(Date.now() - c.at)}` : ''}`
    : 'no level';
  return (
    <td title={title}
      style={{ background:st.bg, color:st.fg, fontFamily:C.mono, fontSize:8.5, fontWeight:700,
        textAlign:'center', padding:'4px 2px', borderLeft:`1px solid ${C.line}`, whiteSpace:'nowrap' }}>
      {c ? st.mark : ''}
      {c?.state === 'near' && c.atrPct != null && (
        <div style={{ fontSize:7, fontWeight:400, opacity:0.75 }}>{c.atrPct}</div>
      )}
      {c?.state === 'swept' && c.at && (
        <div style={{ fontSize:7, fontWeight:400, opacity:0.75 }}>{ago(Date.now() - c.at)}</div>
      )}
    </td>
  );
}

export default function LiquidityView({ onOpen }) {
  const [liq, setLiq] = useState(null);
  const [err, setErr] = useState(null);
  const [showQuiet, setShowQuiet] = useState(false);
  const [fState, setFState] = useState('all');
  const [fTf, setFTf] = useState('all');
  const [fClass, setFClass] = useState('all');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const pull = () => fetchLiquidity({ force: true })
      .then(d => { if (alive) { setLiq(d); setErr(d ? null : 'not published yet'); } })
      .catch(e => { if (alive) setErr(e.message); });
    pull();
    const id = setInterval(pull, 60e3);
    // A second timer so "18m ago" keeps counting between fetches. Without it the
    // ages freeze at whatever they were when the file last changed, which reads
    // as a stalled bot.
    const t = setInterval(() => setTick(x => x + 1), 30e3);
    return () => { alive = false; clearInterval(id); clearInterval(t); };
  }, []);
  void tick;

  const rows = Object.values(liq?.bySym || {}).filter(r => r.levels);

  // The events: every hunt, newest first. Built from the columns rather than
  // from `setup`, so a daily hunt with no confirmation still appears — the
  // waiting state is most of what you look at, and `setup` only ever names one
  // level per instrument.
  let events = [];
  for (const r of rows) {
    for (const [kind, c] of Object.entries(r.levels)) {
      if (c.state !== 'swept') continue;
      // The setup, if the scanner's chosen level is this one. Matching on price
      // rather than kind because two H4 swings share a kind.
      const s = r.setup && r.setup.level?.price === c.price ? r.setup : null;
      events.push({
        sym: r.sym, price: r.price,
        tf: TF_OF[kind] || '4H',
        levelPrice: c.price, levelLabel: LABEL_OF[kind] || kind,
        sideWord: SIDE_OF[kind] || 'resting',
        dir: c.dir,
        sweptAt: c.at || null,
        state: s?.state || 'taken',
        confirmedAt: s?.confirmedAt || null,
        entry: s?.entry ?? null, stop: s?.stop ?? null, risk: s?.risk ?? null,
        // When something last HAPPENED on this row: the sweep, or the
        // confirmation if one has printed since. This is the sort key, and it
        // is the only one — see the sort below.
        kind, cls: r.cls,
        lastAt: Math.max(c.at || 0, s?.confirmedAt || 0),
      });
    }
  }
  // One event per level TAKEN, not per level DEFINED.
  //
  // Yesterday's low and a 4H swing low are often the same price — EUR/GBP had
  // both at 0.85821, taken by the same bar at the same minute — and the list
  // printed it twice. That is one thing that happened, described two ways, and
  // it made a quiet market look busy. They collapse to the highest-ranked
  // level, so the row says "yesterday's low" rather than "a 4H swing low",
  // which is the one a trader is actually watching.
  const RANK = { PDH:3, PDL:3, PWH:2, PWL:2, H4H:1, H4L:1 };
  const byEvent = new Map();
  for (const e of events) {
    // Same instrument, same price, same minute is the same event. The price is
    // rounded because a daily level and an H4 swing that coincide are equal to
    // the tick, not to the float.
    const key = `${e.sym}|${e.levelPrice.toFixed(6)}|${Math.round((e.lastAt || 0) / 60e3)}`;
    const prev = byEvent.get(key);
    if (!prev || (RANK[e.kind] || 0) > (RANK[prev.kind] || 0)) byEvent.set(key, e);
  }
  events = [...byEvent.values()];

  // Newest first, by time, and by nothing else.
  //
  // This used to sort by a rank — live setups first, then daily levels, then
  // weekly, then H4 — with time only breaking ties inside a group. Every row
  // carries its age on it, so the result read as a list whose timestamps jumped
  // around at random: 18m, 38m, 1h, 2h, 18m. A reader cannot see the ranking,
  // only the times, and a feed whose visible order contradicts its visible
  // labels is worse than one with no order at all.
  //
  // The key is when something last happened, not when the sweep was: a level
  // taken two hours ago whose reversal confirmed four minutes ago IS the newest
  // event on the screen, and burying it under sweeps that have done nothing
  // since would be the same mistake in the other direction.
  events.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  // ── Filtering, and the counts the chips show ──
  //
  // Each axis is counted against the OTHER two, not against everything, so the
  // number on a chip is what you will actually get if you press it. Counting
  // against the unfiltered list would promise rows that the current selection
  // then removes, which is worse than no number at all.
  const matchState = (e, v) => v === 'all' || e.state === v;
  const matchTf = (e, v) => v === 'all' || e.tf === v;
  const matchClass = (e, v) => v === 'all'
    || (v === 'major' ? isMajor(e.sym) : e.cls === v);

  const countBy = (options, axis) => Object.fromEntries(options.map(o => [o.id,
    events.filter(e =>
      (axis === 'state' ? matchState(e, o.id) : matchState(e, fState))
      && (axis === 'tf' ? matchTf(e, o.id) : matchTf(e, fTf))
      && (axis === 'cls' ? matchClass(e, o.id) : matchClass(e, fClass))).length]));

  const stateCounts = countBy(STATES, 'state');
  const tfCounts = countBy(TFS, 'tf');
  const classCounts = countBy(CLASSES, 'cls');

  const shownEvents = events.filter(e =>
    matchState(e, fState) && matchTf(e, fTf) && matchClass(e, fClass));

  const live = new Set(['swept', 'through', 'near']);
  const active = rows.filter(r => Object.values(r.levels).some(v => live.has(v.state)));
  const shown = showQuiet ? rows : active;
  const rank = r => {
    const daily = ['PDH','PDL'].some(k => r.levels?.[k]?.state === 'swept') ? 4
                : ['PDH','PDL'].some(k => r.levels?.[k]?.state === 'near') ? 2 : 0;
    return daily
      + (Object.values(r.levels || {}).some(x => x.state === 'swept') ? 1 : 0)
      + (r.setup?.state === 'setup' ? 8 : 0);
  };
  const sorted = [...shown].sort((a, b) => rank(b) - rank(a) || a.sym.localeCompare(b.sym));

  return (
    <div style={{ background:C.bg, minHeight:'70vh', paddingBottom:20 }}>
      <div style={{ padding:'10px 10px 0' }}>
        <div style={{ display:'flex', gap:8, alignItems:'baseline', flexWrap:'wrap' }}>
          <strong style={{ fontSize:14, color:'#38bdf8', fontFamily:C.mono, letterSpacing:1 }}>LIQUIDITY</strong>
          <span style={{ fontSize:10, color:C.dim }}>who hunted what, and when</span>
          <span style={{ marginLeft:'auto', fontSize:8, color:'#334155', fontFamily:C.mono }}>
            VPS · {liq?.at ? ago(Date.now() - Date.parse(liq.at)) : '—'}
            {' · '}
            {liq?.eligible
              ? `${liq.withLevels ?? rows.length} of ${liq.eligible} measured`
              : `${rows.length} measured`}
          </span>
        </div>
        <div style={{ fontSize:9, color:'#334155', lineHeight:1.7, marginTop:5 }}>
          Measured on the VPS every minute, whether the app is open or not. A hunt is a level
          taken and given back — the stops beyond it were filled and price refused to stay there.
          The reversal is confirmed on 2-minute candles, which is why this cannot be a screen you
          have to sit in front of. <strong style={{ color:C.dim }}>Not a measured edge:</strong> this
          model has never been tested here, and no version of it has survived a holdout.
          {liq?.eligible && (liq.withLevels ?? 0) < liq.eligible && (
            <span style={{ color:C.warn }}>
              {' '}Coverage is {liq.withLevels} of {liq.eligible} instruments — the rest have not been
              measured yet, so their absence here is not a finding. The bot builds levels for four a
              minute after a restart.
            </span>
          )}
        </div>
      </div>

      {err && (
        <div style={{ margin:'10px', padding:'9px', border:'1px dashed #3f2a2a', borderRadius:5,
          fontSize:10, color:C.warn, lineHeight:1.6 }}>
          {err === 'not published yet'
            ? 'The VPS has not published a liquidity scan yet. On a cold start it builds levels four instruments a minute, so this fills in over about ten minutes.'
            : `Could not read the scan: ${err}`}
        </div>
      )}

      {/* ── Events, newest and most important first ── */}
      <div style={{ margin:'10px', background:C.panel, border:`1px solid ${C.line}`, borderRadius:5, overflow:'hidden' }}>
        <div style={{ padding:'7px 10px', borderBottom:`1px solid ${C.line}`, fontSize:10,
          color:C.warn, fontFamily:C.mono, fontWeight:700 }}>
          HUNTS · {shownEvents.length}
          {shownEvents.length !== events.length && (
            <span style={{ color:'#334155' }}> of {events.length}</span>
          )}
        </div>

        {/* Three axes: actionable, which level, what kind. Counted so the bar
            answers "is anything in there" without a tap. */}
        {events.length > 0 && (
          <div style={{ padding:'7px 10px', borderBottom:`1px solid ${C.line}`,
            display:'flex', flexDirection:'column', gap:5 }}>
            <Chips options={STATES} value={fState} onChange={setFState} counts={stateCounts}/>
            <Chips options={TFS} value={fTf} onChange={setFTf} counts={tfCounts}/>
            <Chips options={CLASSES} value={fClass} onChange={setFClass} counts={classCounts}/>
          </div>
        )}

        {events.length === 0 ? (
          <div style={{ padding:12, fontSize:10, color:C.dim, lineHeight:1.6 }}>
            No level has been taken and given back on any watched instrument.
            <div style={{ marginTop:3, color:'#334155' }}>
              This is the normal state. A hunt on the daily high or low happens a few times a
              week per instrument, not a few times an hour, and a screen that always has
              something on it is not measuring anything.
            </div>
          </div>
        ) : shownEvents.length === 0 ? (
          <div style={{ padding:12, fontSize:10, color:C.dim, lineHeight:1.6 }}>
            Nothing matches this filter.
            <div style={{ marginTop:3, color:'#334155' }}>
              {events.length} hunt(s) are live on other instruments or timeframes. The counts on
              each chip say where they are.
            </div>
          </div>
        ) : shownEvents.map((e, i) => (
          <HuntEvent key={`${e.sym}-${e.levelPrice}-${i}`} e={e} onOpen={onOpen}/>
        ))}
      </div>

      {/* ── The table ── */}
      <div style={{ margin:'10px', background:C.panel, border:`1px solid ${C.line}`, borderRadius:5, overflow:'hidden' }}>
        <div style={{ padding:'7px 10px', borderBottom:`1px solid ${C.line}`, fontSize:10,
          color:C.dim, fontFamily:C.mono, fontWeight:700 }}>
          EVERY LEVEL · {shown.length} instrument(s)
        </div>
        <div style={{ display:'flex', gap:10, padding:'5px 10px', flexWrap:'wrap',
          borderBottom:`1px solid ${C.line}`, fontSize:8, fontFamily:C.mono }}>
          <span style={{ color:CELL.swept.fg }}>HUNT = taken and given back</span>
          <span style={{ color:CELL.through.fg }}>THRU = went past and stayed</span>
          <span style={{ color:CELL.near.fg }}>near = ATR away, not taken</span>
          <span style={{ color:CELL.behind.fg }}>— = behind price, nothing recent</span>
        </div>

        {sorted.length === 0 ? (
          <div style={{ padding:12, fontSize:10, color:C.dim }}>
            Nothing at a level on any of the {rows.length} instrument(s) measured so far.
          </div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table style={{ borderCollapse:'collapse', width:'100%', minWidth:330 }}>
              <thead>
                <tr>
                  <th style={{ textAlign:'left', fontSize:8, color:C.dim, fontFamily:C.mono,
                    fontWeight:400, padding:'4px 6px' }}>pair</th>
                  {COLS.map(c => (
                    <th key={c.key} title={c.title}
                      style={{ fontSize:8, color: c.tf === '1D' ? '#38bdf8' : C.dim,
                        fontFamily:C.mono, fontWeight:700, padding:'4px 2px',
                        borderLeft:`1px solid ${C.line}` }}>{c.head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => (
                  <tr key={r.sym} onClick={() => onOpen?.(r.sym)}
                    style={{ borderTop:`1px solid ${C.line}`,
                      opacity: Date.now() - r.at > 10 * 60e3 ? 0.45 : 1,
                      cursor: onOpen ? 'pointer' : 'default' }}>
                    <td style={{ padding:'4px 6px', whiteSpace:'nowrap' }}>
                      <div style={{ fontSize:10, color:C.txt, fontFamily:C.mono, fontWeight:700 }}>{r.sym}</div>
                      {r.setup?.state === 'setup' && (
                        <div style={{ fontSize:8, color: r.setup.dir === 'long' ? C.good : C.bad, fontFamily:C.mono }}>
                          {r.setup.dir === 'long' ? 'LONG' : 'SHORT'} {r.setup.entry}
                        </div>
                      )}
                      {r.setup?.state === 'taken' && (
                        <div style={{ fontSize:8, color:C.warn, fontFamily:C.mono }}>awaiting M2</div>
                      )}
                    </td>
                    {COLS.map(c => <Cell key={c.key} c={r.levels[c.key]}/>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > active.length && (
          <button onClick={() => setShowQuiet(v => !v)}
            style={{ width:'100%', padding:'6px', textAlign:'left', cursor:'pointer',
              border:'none', borderTop:`1px solid ${C.line}`, background:'transparent',
              color:C.dim, fontSize:9, fontFamily:C.mono }}>
            {showQuiet ? '▾ hide' : '▸ show'} {rows.length - active.length} with nothing near a level
          </button>
        )}
      </div>
    </div>
  );
}

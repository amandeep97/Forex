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
        <span style={{ marginLeft:'auto', fontSize:8, color:'#334155', fontFamily:C.mono }}>
          {e.sweptAt ? ago(Date.now() - e.sweptAt) : ''}
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
  const events = [];
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
        rank: (s?.state === 'setup' ? 100 : 0) + (TF_OF[kind] === '1D' ? 10 : TF_OF[kind] === '1W' ? 5 : 1),
      });
    }
  }
  events.sort((a, b) => b.rank - a.rank || (b.sweptAt || 0) - (a.sweptAt || 0));

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
            VPS · {liq?.at ? ago(Date.now() - Date.parse(liq.at)) : '—'} · {rows.length} watched
          </span>
        </div>
        <div style={{ fontSize:9, color:'#334155', lineHeight:1.7, marginTop:5 }}>
          Measured on the VPS every minute, whether the app is open or not. A hunt is a level
          taken and given back — the stops beyond it were filled and price refused to stay there.
          The reversal is confirmed on 2-minute candles, which is why this cannot be a screen you
          have to sit in front of. <strong style={{ color:C.dim }}>Not a measured edge:</strong> this
          model has never been tested here, and no version of it has survived a holdout.
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
          HUNTS · {events.length}
        </div>
        {events.length === 0 ? (
          <div style={{ padding:12, fontSize:10, color:C.dim, lineHeight:1.6 }}>
            No level has been taken and given back on any watched instrument.
            <div style={{ marginTop:3, color:'#334155' }}>
              This is the normal state. A hunt on the daily high or low happens a few times a
              week per instrument, not a few times an hour, and a screen that always has
              something on it is not measuring anything.
            </div>
          </div>
        ) : events.map((e, i) => <HuntEvent key={`${e.sym}-${e.levelPrice}-${i}`} e={e} onOpen={onOpen}/>)}
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

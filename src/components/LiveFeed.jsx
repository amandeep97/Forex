import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  fetchFeed, evaluate, CONDITIONS, CONDITION_GROUPS, defaultParams,
  loadFilters, saveFilters, loadActiveId, saveActiveId, newFilter,
  rarityFor, feedAge, ago, lookbackCapH,
  loadShortlist, shortlistToggle, sinceShortlist,
  syncState, syncFiltersToBot, requestTestPush, readTestPushResult, redundantPicks,
  contradictions,
} from '../utils/liveFeed';
import { INSTRUMENTS } from '../data/instruments';
import { CLASS, CLASS_ORDER } from '../data/instruments';
import { stageFilterForBacktest } from '../utils/feedToBacktest';

const C = {
  bg:'#080c11', panel:'#0b1118', line:'#16202b', dim:'#475569', txt:'#cbd5e1',
  accent:'#00d4aa', warn:'#f59e0b', bad:'#ef4444', good:'#22c55e', mono:'var(--mono, monospace)',
};

const btn = (on) => ({
  fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:2, cursor:'pointer',
  border:`1px solid ${on ? '#00d4aa55' : C.line}`, background: on ? '#00d4aa15' : 'transparent',
  color: on ? C.accent : C.dim,
});


// ── Sparkline ─────────────────────────────────────────────────────────────────
// The row's own evidence. "Swept the 5-bar low and closed back inside" is a
// claim; the shape underneath, with the bar it happened on marked, is the thing
// itself. Drawn from closes the VPS publishes — no extra request, and it looks
// identical whether you are online or not.
function Spark({ series, events, w = 96, h = 30 }) {
  if (!series?.c?.length || series.c.length < 3) return <div style={{ width:w, height:h }}/>;
  const c = series.c;
  const lo = Math.min(...c), hi = Math.max(...c);
  const span = hi - lo || 1;
  const x = i => (i / (c.length - 1)) * (w - 2) + 1;
  const y = v => h - 2 - ((v - lo) / span) * (h - 4);
  const pts = c.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const up = c[c.length - 1] >= c[0];
  const stroke = up ? '#22c55e' : '#ef4444';

  // Position comes from the feed (`si`), never from arithmetic on timestamps —
  // FX bars skip weekends, so elapsed-time over bar-size drifts two days a week
  // and puts every marker after a Friday on the wrong bar.
  const marks = (events || [])
    .filter(e => e.si != null && e.si >= 0 && e.si < c.length)
    .map(e => ({ ...e, i: e.si }));

  return (
    <svg width={w} height={h} style={{ display:'block', flexShrink:0 }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.2"
        strokeLinejoin="round" strokeLinecap="round" opacity="0.85"/>
      {marks.map((m, k) => (
        <g key={k}>
          <line x1={x(m.i)} y1="0" x2={x(m.i)} y2={h} stroke={C.warn} strokeWidth="0.6" opacity="0.35"/>
          <circle cx={x(m.i)} cy={y(c[m.i])} r="2.6" fill={C.warn} stroke={C.bg} strokeWidth="0.8"/>
        </g>
      ))}
      <circle cx={x(c.length - 1)} cy={y(c[c.length - 1])} r="1.8" fill={stroke}/>
    </svg>
  );
}

// ── Rarity meter ──────────────────────────────────────────────────────────────
// A number like "17.6/month" means nothing until you know that 0.3 and 32 are
// both on the same scale. Log-spaced, because the interesting range spans two
// orders of magnitude — and the label always stays, since the bar is a hint and
// the number is the fact.
function Rarity({ perMonth, label }) {
  if (perMonth == null) return null;
  // The bar is log-scaled because the range spans two orders of magnitude, but
  // the WORD comes from fixed thresholds you can act on. Deriving the word from
  // the bar's position made "8 times a month" — every four days — read the same
  // as "30 times a month", which is the distinction that matters most.
  const t = Math.max(0, Math.min(1, Math.log10(Math.max(perMonth, 0.05) / 0.1) / Math.log10(400)));
  const rare = perMonth < 1, occasional = perMonth < 5;
  const col = rare ? C.good : occasional ? C.warn : '#64748b';
  const word = rare ? 'rare' : occasional ? 'occasional' : 'common';
  return (
    <span title={`${label} fires about ${perMonth} times a month on this instrument`}
      style={{ display:'inline-flex', alignItems:'center', gap:5, fontFamily:C.mono }}>
      <span style={{ width:44, height:3, background:'#131c26', borderRadius:2, overflow:'hidden', flexShrink:0 }}>
        <span style={{ display:'block', width:`${t * 100}%`, height:'100%', background:col }}/>
      </span>
      <span style={{ fontSize:8, color:col }}>{word} · {perMonth}/mo</span>
    </span>
  );
}

// ── One matching instrument ───────────────────────────────────────────────────
function Row({ r, filter, shortlisted, onWatch, onOpen }) {
  const cls = CLASS[r.cls];
  const rarity = rarityFor(r.rec, filter);
  const since = sinceShortlist(shortlisted, r.price);

  return (
    <div style={{ borderBottom:'1px solid #0e161e', padding:'7px 9px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:7, fontFamily:C.mono }}>
        <button onClick={() => onWatch(r)} title={shortlisted ? 'Remove from shortlist' : 'Shortlist — records why and at what price, and adds to the Watchlist tab'}
          style={{ background:'none', border:'none', cursor:'pointer', padding:0, fontSize:13, lineHeight:1,
            color: shortlisted ? C.warn : '#28323d' }}>★</button>
        <span onClick={() => onOpen(r.sym)} style={{ fontSize:11, fontWeight:800, color:C.txt, width:80, flexShrink:0, cursor:'pointer' }}>
          {r.sym}
        </span>
        <span style={{ fontSize:8, fontWeight:800, color:cls.color, width:44, flexShrink:0 }}>{cls.label}</span>
        <span style={{ fontSize:10, color:C.dim, flexShrink:0 }}>
          {r.price != null ? r.price.toFixed(r.dec ?? 2) : '—'}
        </span>
        <span style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:7, flexShrink:0 }}>
          <span style={{ fontSize:9, color:C.dim }}>{r.newestAt ? ago(Date.now() - r.newestAt) : ''}</span>
          <Spark series={r.rec?.spark?.[r.sparkTf]} events={r.events}/>
        </span>
        <button onClick={() => onOpen(r.sym)} title="Open instrument"
          style={{ fontSize:10, padding:'1px 6px', borderRadius:3, cursor:'pointer',
            border:`1px solid ${C.line}`, background:'transparent', color:C.dim }}>→</button>
      </div>

      <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginTop:4, paddingLeft:20 }}>
        {r.passed.map((p, i) => (
          <span key={i} style={{ fontSize:9, fontFamily:C.mono, color:C.good,
            border:'1px solid #22c55e33', background:'#22c55e0d', borderRadius:2, padding:'1px 6px' }}>
            <strong style={{ fontWeight:800 }}>{p.label}</strong> · {p.detail}
          </span>
        ))}
        {filter.mode === 'any' && r.failed.map((p, i) => (
          <span key={`f${i}`} style={{ fontSize:9, fontFamily:C.mono, color:'#334155',
            border:'1px solid #1e293b', borderRadius:2, padding:'1px 6px' }}>
            {p.label} · {p.detail}
          </span>
        ))}
        {r.unknown.map((p, i) => (
          <span key={`u${i}`} style={{ fontSize:9, fontFamily:C.mono, color:'#3f4a58',
            border:'1px dashed #26313d', borderRadius:2, padding:'1px 6px' }}>
            {p.label} · {p.detail}
          </span>
        ))}
      </div>

      {shortlisted && (
        <div style={{ fontSize:9, color:C.warn, fontFamily:C.mono, marginTop:4, paddingLeft:20 }}>
          shortlisted {ago(Date.now() - shortlisted.at)}
          {shortlisted.reason ? ` on ${shortlisted.reason}` : ''}
          {since != null && (
            <span style={{ color: since > 0 ? C.good : since < 0 ? C.bad : C.dim }}>
              {' '}· {since > 0 ? '+' : ''}{since}% since
            </span>
          )}
        </div>
      )}

      {rarity.length > 0 && (
        <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginTop:5, paddingLeft:20 }}>
          {rarity.map((x, i) => (
            <Rarity key={i} perMonth={x.perMonth} label={`${CONDITIONS[x.key]?.label ?? x.key} ${x.tf}`}/>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Filter editor ─────────────────────────────────────────────────────────────
function Editor({ filter, feed, onChange, onClose, onDelete, onDuplicate, onExport, onImport, onTestPush, testPush, onBacktest }) {
  const used = new Set((filter.conditions || []).map(c => c.key));
  const [picking, setPicking] = useState(false);

  const setC = (i, patch) => {
    const next = filter.conditions.map((c, j) => j === i ? { ...c, ...patch } : c);
    onChange({ ...filter, conditions: next });
  };
  const setParam = (i, k, v) => {
    const c = filter.conditions[i];
    setC(i, { params: { ...defaultParams(c.key), ...(c.params || {}), [k]: v } });
  };

  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:6, margin:'0 10px 8px', overflow:'hidden' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderBottom:`1px solid ${C.line}`, background:'#0a0f15', flexWrap:'wrap' }}>
        <input value={filter.name} onChange={e => onChange({ ...filter, name: e.target.value })}
          style={{ fontSize:11, fontWeight:800, fontFamily:C.mono, background:'#0f172a', color:C.txt,
            border:`1px solid ${C.line}`, borderRadius:3, padding:'3px 7px', minWidth:0, width:'100%', flex:'1 1 100%' }}/>
        <button onClick={onBacktest} style={{ ...btn(true), fontWeight:800 }}>⏱ backtest this</button>
        <button onClick={onDuplicate} style={btn(false)}>duplicate</button>
        <button onClick={onExport} title="Copy all filters as JSON" style={btn(false)}>export</button>
        <button onClick={onImport} title="Paste filters exported from another device" style={btn(false)}>import</button>
        <button onClick={onDelete} style={{ ...btn(false), color:C.bad, borderColor:'#ef444433' }}>delete</button>
        <button onClick={onClose} style={btn(true)}>done</button>
      </div>

      <div style={{ padding:'9px 10px' }}>
        {/* ── Push ── */}
        <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap', marginBottom:9,
          paddingBottom:8, borderBottom:`1px solid ${C.line}` }}>
          <button onClick={() => onChange({ ...filter, push: !filter.push })} style={btn(!!filter.push)}>
            {filter.push ? '🔔 push on' : '🔕 push off'}
          </button>
          {filter.push && (
            <button onClick={onTestPush} style={btn(false)}>
              {testPush?.state === 'pending' ? 'waiting for the VPS…' : 'send a test now'}
            </button>
          )}
          <span style={{ fontSize:8, color:'#2b3644', fontFamily:C.mono, flex:1, minWidth:160, lineHeight:1.5 }}>
            {filter.push
              ? 'The VPS evaluates this filter with the same rules as this screen and notifies on NEW matches only.'
              : 'Notify me when this filter finds something, even when the app is closed.'}
          </span>
          {testPush?.state === 'done' && (
            <div style={{ width:'100%', fontSize:9, fontFamily:C.mono, lineHeight:1.6,
              color: testPush.ok ? C.good : C.bad }}>
              {testPush.ok ? '✓' : '✗'} {testPush.detail}
              {testPush.pruned > 0 && ` · ${testPush.pruned} dead subscription(s) removed`}
              {testPush.telegram && ' · also sent to Telegram'}
            </div>
          )}
        </div>

        {/* ── How the conditions combine ── */}
        <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap', marginBottom:8 }}>
          <span style={{ fontSize:9, color:C.dim, fontFamily:C.mono }}>match</span>
          <button onClick={() => onChange({ ...filter, mode:'all' })} style={btn(filter.mode === 'all')}>ALL of them</button>
          <button onClick={() => onChange({ ...filter, mode:'any' })} style={btn(filter.mode === 'any')}>ANY</button>
          {filter.mode === 'any' && (
            <>
              <input type="number" min={1} max={Math.max(1, filter.conditions.length)} value={filter.minMatch || 2}
                onChange={e => onChange({ ...filter, minMatch: Math.max(1, +e.target.value || 1) })}
                style={{ width:44, fontSize:10, fontFamily:C.mono, background:'#0f172a', color:C.txt,
                  border:`1px solid ${C.line}`, borderRadius:3, padding:'2px 5px' }}/>
              <span style={{ fontSize:9, color:C.dim, fontFamily:C.mono }}>of {filter.conditions.length}</span>
            </>
          )}
        </div>

        {/* A filter that cannot match must say so. Otherwise it returns nothing
            forever and looks exactly like a quiet market. */}
        {contradictions(filter).map((c, i) => (
          <div key={i} style={{ fontSize:9, color:C.bad, fontFamily:C.mono, marginBottom:8, lineHeight:1.5,
            border:'1px solid #ef444455', borderRadius:4, padding:'6px 8px', background:'#ef44440d' }}>
            <strong>This filter can never match.</strong> “{c.a}” and “{c.b}” are both required under ALL,
            but {c.why}. Switch to ANY, or remove one.
          </div>
        ))}

        {filter.mode === 'all' && filter.conditions.length >= 4 && (
          <div style={{ fontSize:9, color:C.warn, fontFamily:C.mono, marginBottom:8, lineHeight:1.5 }}>
            Four conditions ANDed together will return nothing on most days. ANY {Math.ceil(filter.conditions.length / 2)} of {filter.conditions.length} is usually what you actually want.
          </div>
        )}

        {/* ── Named instruments: a focus list beats a class ── */}
        <div style={{ marginBottom:9 }}>
          <div style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap' }}>
            <span style={{ fontSize:9, color:C.dim, fontFamily:C.mono }}>instruments</span>
            <button onClick={() => onChange({ ...filter, symbols:null })} style={btn(!filter.symbols?.length)}>any</button>
            <button onClick={() => setPicking(v => !v)} style={btn(!!filter.symbols?.length)}>
              {filter.symbols?.length ? `${filter.symbols.length} picked` : 'pick…'}
            </button>
            {filter.symbols?.length > 0 && (
              <span style={{ fontSize:8, color:'#2b3644', fontFamily:C.mono }}>{filter.symbols.join(' · ')}</span>
            )}
          </div>
          {redundantPicks(filter.symbols).map((g, i) => (
            <div key={i} style={{ fontSize:9, color:C.warn, fontFamily:C.mono, marginTop:3, lineHeight:1.5 }}>
              ⚠ {g.picked.join(' + ')} are one {g.name} position, not {g.picked.length} — they move together.
            </div>
          ))}
          {picking && (
            <div style={{ marginTop:6, border:`1px solid ${C.line}`, borderRadius:4, padding:'6px 8px', background:'#0a0f15' }}>
              {CLASS_ORDER.map(cl => (
                <div key={cl} style={{ display:'flex', gap:3, flexWrap:'wrap', alignItems:'center', marginBottom:4 }}>
                  <span style={{ fontSize:8, color:'#2b3644', fontFamily:C.mono, width:52, flexShrink:0 }}>{CLASS[cl].label}</span>
                  {INSTRUMENTS.filter(i => i.cls === cl).map(i => {
                    const on = filter.symbols?.includes(i.sym);
                    return (
                      <button key={i.sym} onClick={() => {
                        const cur = filter.symbols || [];
                        const next = on ? cur.filter(x => x !== i.sym) : [...cur, i.sym];
                        onChange({ ...filter, symbols: next.length ? next : null });
                      }} style={{ ...btn(on), fontSize:8, padding:'1px 5px' }}>{i.sym}</button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Instrument scope ── */}
        <div style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap', marginBottom:9 }}>
          <span style={{ fontSize:9, color:C.dim, fontFamily:C.mono }}>or by class</span>
          <button onClick={() => onChange({ ...filter, classes:null })} style={btn(!filter.classes?.length)}>everything</button>
          {CLASS_ORDER.map(c => {
            const on = filter.classes?.includes(c);
            return (
              <button key={c} onClick={() => {
                const cur = filter.classes || [];
                const next = on ? cur.filter(x => x !== c) : [...cur, c];
                onChange({ ...filter, classes: next.length ? next : null });
              }} style={btn(on)}>{CLASS[c].label}</button>
            );
          })}
        </div>

        {/* ── The conditions ── */}
        {filter.conditions.length === 0 && (
          <div style={{ fontSize:10, color:C.dim, fontFamily:C.mono, padding:'6px 0' }}>
            No conditions yet — a filter with none matches nothing. Add one below.
          </div>
        )}

        {filter.conditions.map((c, i) => {
          const def = CONDITIONS[c.key];
          if (!def) return null;
          const params = { ...defaultParams(c.key), ...(c.params || {}) };
          return (
            <div key={i} style={{ border:`1px solid ${C.line}`, borderRadius:4, padding:'6px 8px', marginBottom:6, background:'#0a0f15' }}>
              <div style={{ display:'flex', alignItems:'center', gap:7, flexWrap:'wrap' }}>
                <span style={{ fontSize:10, fontWeight:800, color:C.txt, fontFamily:C.mono }}>{def.label}</span>
                <span style={{ fontSize:8, color:C.dim, fontFamily:C.mono, border:`1px solid ${C.line}`, borderRadius:2, padding:'0 4px' }}>
                  {def.kind}
                </span>
                <button onClick={() => onChange({ ...filter, conditions: filter.conditions.filter((_, j) => j !== i) })}
                  style={{ marginLeft:'auto', ...btn(false), color:C.bad, borderColor:'#ef444433' }}>remove</button>
              </div>
              {def.help && <div style={{ fontSize:8, color:'#2b3644', fontFamily:C.mono, marginTop:2 }}>{def.help}</div>}
              <div style={{ display:'flex', gap:9, flexWrap:'wrap', marginTop:5 }}>
                {def.params.map(p => {
                  // The bot only keeps so much history; asking for more would
                  // quietly return less, and the filter would look broken.
                  const cap = p.k === 'withinH' ? lookbackCapH(feed, params.tf) : null;
                  const max = cap ? Math.min(p.max, cap) : p.max;
                  const over = cap && params[p.k] > cap;
                  return (
                  <label key={p.k} style={{ display:'flex', alignItems:'center', gap:4, fontSize:9, color:C.dim, fontFamily:C.mono }}>
                    {p.label}{cap ? <span style={{ color:'#2b3644' }}> (max {cap})</span> : null}
                    {p.type === 'select' ? (
                      <select value={params[p.k]} onChange={e => setParam(i, p.k, e.target.value)}
                        style={{ fontSize:9, fontFamily:C.mono, background:'#0f172a', color:C.txt,
                          border:`1px solid ${C.line}`, borderRadius:3, padding:'2px 4px' }}>
                        {p.options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                      </select>
                    ) : (
                      <input type="number" value={params[p.k]} min={p.min} max={max} step={p.step}
                        onChange={e => setParam(i, p.k, e.target.value === '' ? p.def
                          : Math.min(max, +e.target.value))}
                        style={{ width:58, fontSize:9, fontFamily:C.mono, background:'#0f172a',
                          color: over ? C.warn : C.txt,
                          border:`1px solid ${over ? C.warn : C.line}`, borderRadius:3, padding:'2px 5px' }}/>
                    )}
                  </label>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* ── Add ── */}
        <div style={{ borderTop:`1px solid ${C.line}`, paddingTop:8, marginTop:4 }}>
          {CONDITION_GROUPS.map(g => (
            <div key={g} style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap', marginBottom:5 }}>
              <span style={{ fontSize:8, color:'#2b3644', fontFamily:C.mono, width:70, flexShrink:0 }}>{g}</span>
              {Object.entries(CONDITIONS).filter(([, d]) => d.group === g).map(([k, d]) => (
                <button key={k} disabled={used.has(k)}
                  onClick={() => onChange({ ...filter, conditions:[...filter.conditions, { key:k, params:defaultParams(k) }] })}
                  style={{ ...btn(false), cursor: used.has(k) ? 'default' : 'pointer', opacity: used.has(k) ? 0.3 : 1 }}>
                  + {d.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Tab ───────────────────────────────────────────────────────────────────────
export default function LiveFeed({ onOpen }) {
  const [feed,    setFeed]    = useState(null);
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState(null);
  const [filters, setFilters] = useState(loadFilters);
  const [activeId, setActiveId] = useState(() => loadActiveId());
  const [editing, setEditing] = useState(false);
  const [shortlist, setShortlist] = useState(loadShortlist);
  const [syncMsg, setSyncMsg] = useState(null);
  const [testPush, setTestPush] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const started = useRef(false);

  const active = useMemo(
    () => filters.find(f => f.id === activeId) || filters[0] || newFilter(),
    [filters, activeId]);

  const load = useCallback(async (force = false) => {
    setBusy(true); setErr(null);
    try { setFeed(await fetchFeed({ force })); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }, []);

  useEffect(() => { if (!started.current) { started.current = true; load(false); } }, [load]);

  // The VPS keeps measuring while the tab sits open, so pick up new publishes
  useEffect(() => {
    const t = setInterval(() => load(true), 120_000);
    return () => clearInterval(t);
  }, [load]);

  const persist = useCallback((list, id) => {
    setFilters(list); saveFilters(list);
    if (id) { setActiveId(id); saveActiveId(id); }
  }, []);

  const updateActive = useCallback(f => {
    persist(filters.map(x => x.id === f.id ? f : x));
  }, [filters, persist]);

  // Filters live in localStorage, which a new phone or a cleared cache wipes.
  // Rebuilding a tuned combination from memory is exactly the moment someone
  // stops using a tool, so they have to be portable.
  const exportFilters = useCallback(async () => {
    const json = JSON.stringify(filters, null, 2);
    try { await navigator.clipboard.writeText(json); window.alert(`${filters.length} filter(s) copied to the clipboard.`); }
    catch { window.prompt('Copy your filters:', json); }
  }, [filters]);

  const importFilters = useCallback(() => {
    const raw = window.prompt('Paste exported filters:');
    if (!raw) return;
    let incoming;
    try { incoming = JSON.parse(raw); } catch { window.alert('That is not valid filter JSON.'); return; }
    const list = (Array.isArray(incoming) ? incoming : [incoming])
      .filter(f => f && typeof f.name === 'string' && Array.isArray(f.conditions));
    if (!list.length) { window.alert('No usable filters in that text.'); return; }
    // Re-id on the way in so importing twice does not overwrite what is here
    const stamped = list.map((f, i) => ({ ...f, id:`f${Date.now().toString(36)}${i}` }));
    const dropped = list.reduce((n, f) => n + f.conditions.filter(c => !CONDITIONS[c.key]).length, 0);
    persist([...filters, ...stamped], stamped[0].id);
    window.alert(`Imported ${stamped.length} filter(s)${dropped ? ` — ${dropped} unknown condition(s) will show as unusable` : ''}.`);
  }, [filters, persist]);

  const sync = useMemo(() => syncState(filters), [filters, syncMsg]);

  const doSync = useCallback(async () => {
    setSyncing(true);
    try { setSyncMsg(await syncFiltersToBot(filters)); }
    catch (e) { setSyncMsg({ ok:false, msg:`Sync failed: ${e.message}` }); }
    setSyncing(false);
  }, [filters]);

  // Hand the filter to the Backtester, honestly — naming what could not be
  // carried across rather than testing a subset and calling it the filter.
  const doBacktest = useCallback(() => {
    const t = stageFilterForBacktest(active);
    if (!t.testable) {
      window.alert('Nothing in this filter can be backtested yet.\n\n'
        + t.dropped.map(d => `• ${d.label} — ${d.why}`).join('\n'));
      return;
    }
    const notes = [];
    if (t.dropped.length) notes.push(`${t.dropped.length} condition(s) cannot be tested:\n`
      + t.dropped.map(d => `  • ${d.label} — ${d.why}`).join('\n'));
    if (t.mixedTimeframes) notes.push(`This filter mixes ${t.mixedTimeframes.join(' and ')}; the test runs on ${t.timeframe} only.`);
    if (t.minMatchLost) notes.push(`"ANY ${t.minMatchLost} of N" becomes plain OR — the engine has no N-of-M.`);
    window.alert(`Testing ${t.testable} of ${t.total} conditions on ${t.timeframe}.`
      + (notes.length ? '\n\n' + notes.join('\n\n') : '')
      + '\n\nOpening the Backtester.');
    window.dispatchEvent(new CustomEvent('navigate-tab', { detail:'backtester' }));
  }, [active]);

  const doTestPush = useCallback(async () => {
    setTestPush({ state:'pending' });
    try {
      const r = await requestTestPush();
      if (!r.ok) { setTestPush({ state:'done', ok:false, detail:r.msg }); return; }
    } catch (e) { setTestPush({ state:'done', ok:false, detail:e.message }); return; }

    // The bot answers in the same file, so poll rather than leave it spinning
    // forever with no way to tell "in flight" from "the bot is not running".
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 10_000));
      const res = await readTestPushResult();
      if (res.state === 'done') { setTestPush(res); return; }
    }
    setTestPush({ state:'done', ok:false,
      detail:'no answer from the VPS in two minutes — is the bot running?' });
  }, []);

  const res = useMemo(() => {
    if (!feed?.instruments) return null;
    return evaluate(feed, active);
  }, [feed, active]);

  const age = feedAge(feed);
  // An H4 bar closes for every instrument every four hours and moves the price
  // in the payload, so a running bot cannot stay silent much beyond that.
  const stale = age != null && age > 5 * 3600_000;

  return (
    <div style={{ background:C.bg, minHeight:'100vh', paddingBottom:80, fontFamily:C.mono }}>
      {/* ── Header ── */}
      <div style={{ position:'sticky', top:0, zIndex:5, background:C.bg, borderBottom:`1px solid ${C.line}`, padding:'9px 10px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          <span style={{ fontSize:14, fontWeight:900, color:C.accent, letterSpacing:'2px' }}>FEED</span>
          <span style={{ fontSize:9, color:C.dim }}>which instruments are worth a look</span>
          <span style={{ marginLeft:'auto', fontSize:9, color: stale ? C.warn : C.dim }}>
            {busy ? 'reading…' : feed?.missing ? 'not published yet' : age != null ? `VPS ${ago(age)}` : ''}
          </span>
          <button onClick={() => load(true)} disabled={busy} style={{ ...btn(true), padding:'3px 9px', fontSize:10 }}>↻</button>
        </div>

        {/* ── Saved filters ── */}
        <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginTop:7, alignItems:'center' }}>
          {filters.map(f => (
            <button key={f.id} onClick={() => { setActiveId(f.id); saveActiveId(f.id); setEditing(false); }}
              style={btn(f.id === active.id)}>{f.name}</button>
          ))}
          <button onClick={() => { const f = newFilter(); persist([...filters, f], f.id); setEditing(true); }}
            style={{ ...btn(false), color:C.dim }}>+ new</button>
          <button onClick={() => setEditing(v => !v)} style={btn(editing)}>
            {editing ? '▾ close' : '⚙ edit'}
          </button>
          {res && (
            <span style={{ marginLeft:'auto', fontSize:9, color: res.rows.length ? C.accent : C.dim }}>
              {res.rows.length} of {res.considered} match
            </span>
          )}
        </div>
      </div>

      {editing && (
        <div style={{ marginTop:8 }}>
          <Editor
            filter={active}
            feed={feed}
            onChange={updateActive}
            onClose={() => setEditing(false)}
            onExport={exportFilters}
            onImport={importFilters}
            onTestPush={doTestPush}
            testPush={testPush}
            onBacktest={doBacktest}
            onDuplicate={() => {
              const copy = { ...active, id:`f${Date.now().toString(36)}`, name:`${active.name} copy`,
                conditions: active.conditions.map(c => ({ ...c, params:{ ...c.params } })) };
              persist([...filters, copy], copy.id);
            }}
            onDelete={() => {
              const rest = filters.filter(f => f.id !== active.id);
              const list = rest.length ? rest : [newFilter()];
              persist(list, list[0].id);
              setEditing(false);
            }}
          />
        </div>
      )}

      {/* ── Why this is not the Scan tab ── */}
      <div style={{ padding:'8px 10px 0', fontSize:9, color:'#334155', lineHeight:1.6 }}>
        Measured on the VPS every minute, awake or not — so an H4 sweep that happened at 3am is still
        here when you open the app. This is a shortlist, not a signal: it says <strong style={{color:C.dim}}>look at these</strong>,
        never which way to trade. Star a row to shortlist it — the reason and the price are kept, so weeks
        later you can see what it did afterwards — or tap it for the full read.
      </div>

      {/* ── States ── */}
      {err && (
        <div style={{ margin:'8px 10px', padding:10, background:C.panel, border:'1px solid #ef444433', borderRadius:5,
          fontSize:10, color:C.warn }}>
          Could not read the feed: {err}
        </div>
      )}

      {feed?.missing && (
        <div style={{ margin:'8px 10px', padding:12, background:C.panel, border:`1px solid ${C.line}`, borderRadius:5,
          fontSize:10, color:C.dim, lineHeight:1.7 }}>
          <strong style={{ color:C.txt }}>The VPS has not published a feed yet.</strong>
          <div style={{ marginTop:4 }}>
            Pull the latest bot code on the VPS and restart it (<code>git pull &amp;&amp; pm2 restart forex-bot</code>).
            The first publish takes a few minutes — 52 instruments are measured a handful at a time so a
            cold start cannot overrun the 60-second tick.
          </div>
        </div>
      )}

      {/* Measurements stalling is different from the market being quiet, and the
          two looked identical: "VPS 2h ago" reads as calm, not as broken. */}
      {feed?.meta?.failStreak > 3 && (
        <div style={{ margin:'8px 10px', padding:9, background:C.panel, border:'1px solid #ef444455', borderRadius:5,
          fontSize:9, color:C.bad, lineHeight:1.6 }}>
          <strong>The VPS is failing to measure — {feed.meta.failStreak} in a row.</strong>
          {feed.meta.lastFailure && (
            <div style={{ marginTop:2, color:'#8b96a5' }}>
              last: {feed.meta.lastFailure.sym} {feed.meta.lastFailure.kind} — {feed.meta.lastFailure.msg}
            </div>
          )}
          <div style={{ marginTop:2, color:'#8b96a5' }}>
            Everything below is the last good measurement, not the market now.
          </div>
        </div>
      )}

      {/* Bars go stale even when the file keeps being written — positioning can
          refresh while candles have not moved for hours. */}
      {(() => {
        if (!feed?.instruments) return null;
        const now = Date.now();
        const ages = Object.values(feed.instruments).map(r => r.asOf?.H4).filter(Boolean).map(t => (now - t) / 3600e3);
        if (!ages.length) return null;
        const freshest = Math.min(...ages);
        if (freshest < 9) return null;      // an H4 bar plus a weekend gap
        return (
          <div style={{ margin:'8px 10px', padding:9, background:C.panel, border:'1px solid #f59e0b55',
            borderRadius:5, fontSize:9, color:C.warn, lineHeight:1.6 }}>
            <strong>No instrument has a fresh H4 bar — the newest is {Math.round(freshest)}h old.</strong>
            <div style={{ marginTop:2, color:'#8b96a5' }}>
              Crypto trades around the clock, so this is not the weekend. The bot is running but its
              measurements are not landing.
            </div>
          </div>
        );
      })()}

      {stale && !feed?.missing && (
        <div style={{ margin:'8px 10px', padding:9, background:C.panel, border:'1px solid #f59e0b33', borderRadius:5,
          fontSize:9, color:C.warn, lineHeight:1.6 }}>
          Last publish was {ago(age)}. Either nothing has changed on any instrument, or the bot is not running.
          Everything below is as of then, not now.
        </div>
      )}

      {/* ── Push filters only work once the VPS has them ── */}
      {sync.count > 0 && (sync.dirty || !sync.configured) && (
        <div style={{ margin:'8px 10px 0', padding:'8px 9px', background:C.panel,
          border:'1px solid #f59e0b33', borderRadius:5, fontSize:9, color:C.warn, lineHeight:1.6 }}>
          <strong>
            {!sync.configured
              ? 'Push filters cannot reach the VPS — GitHub is not connected.'
              : sync.neverSynced
                ? `${sync.count} filter(s) marked for push have never been sent to the VPS.`
                : `${sync.count} push filter(s) changed since the last sync.`}
          </strong>
          <div style={{ marginTop:2, color:'#5b6b7d' }}>
            {sync.configured
              ? 'The bot reads filters from the repo. Until you sync, notifications use the previous version — or none at all.'
              : 'Connect GitHub in Settings; the VPS reads your filters from there, the same way it reads your alerts.'}
          </div>
          {sync.configured && (
            <button onClick={doSync} disabled={syncing}
              style={{ ...btn(true), marginTop:5, padding:'3px 10px', fontSize:10 }}>
              {syncing ? 'sending…' : 'sync to VPS'}
            </button>
          )}
        </div>
      )}
      {syncMsg && (
        <div style={{ margin:'6px 10px 0', padding:'7px 9px', background:C.panel,
          border:`1px solid ${syncMsg.ok ? '#22c55e33' : '#ef444433'}`, borderRadius:5,
          fontSize:9, color: syncMsg.ok ? C.good : C.bad, lineHeight:1.6 }}>
          {syncMsg.msg}
        </div>
      )}

      {/* ── A filter that silently drops instruments has to say so ── */}
      {res?.blocked?.length > 0 && (
        <div style={{ margin:'8px 10px 0', padding:'7px 9px', background:C.panel,
          border:'1px dashed #26313d', borderRadius:5, fontSize:9, color:'#5b6b7d', lineHeight:1.6 }}>
          <strong style={{ color:C.warn }}>{res.blocked.length} instrument(s) excluded on missing data, not on the market.</strong>
          <div style={{ marginTop:2 }}>
            {[...new Set(res.blocked.map(b => b.why))].join(' · ')} — e.g.{' '}
            {res.blocked.slice(0, 5).map(b => b.sym).join(', ')}{res.blocked.length > 5 ? '…' : ''}.
            {active.mode === 'all' && ' Under ALL, a condition that cannot be measured can never be satisfied. Switch to ANY, or scope this filter to instruments that have the data.'}
          </div>
        </div>
      )}

      {/* ── Matches ── */}
      <div style={{ margin:'8px 10px', background:C.panel, border:`1px solid ${C.line}`, borderRadius:5, overflow:'hidden' }}>
        {!res && !busy && !err && !feed?.missing && (
          <div style={{ padding:16, fontSize:10, color:C.dim }}>Waiting for the feed…</div>
        )}
        {res && res.rows.length === 0 && (
          <div style={{ padding:14, fontSize:10, color:C.dim, lineHeight:1.7 }}>
            <strong style={{ color:C.txt }}>Nothing matches “{active.name}” right now.</strong>
            <div style={{ marginTop:3 }}>
              {active.conditions.length === 0
                ? 'This filter has no conditions yet — open ⚙ edit and add one.'
                : active.mode === 'all'
                  ? `All ${active.conditions.length} conditions have to hold at once. Switch to ANY ${Math.max(1, active.conditions.length - 1)} of ${active.conditions.length} to loosen it.`
                  : `Fewer than ${active.minMatch} conditions hold on any instrument. Lower the threshold or widen the time window.`}
            </div>
            {res.noData > 0 && (
              <div style={{ marginTop:3, color:'#2b3644' }}>
                {res.noData} instrument(s) not in the feed yet — the VPS measures them a few per tick on a cold start.
              </div>
            )}
          </div>
        )}
        {res?.rows.map(r => (
          <Row key={r.sym} r={r} filter={active} shortlisted={shortlist[r.sym]}
            onWatch={row => setShortlist(shortlistToggle(row.sym, {
              price: row.price,
              reason: row.passed.map(p => p.label).join(' + '),
              filterName: active.name,
            }))}
            onOpen={onOpen}/>
        ))}
      </div>

      <div style={{ padding:'0 12px 20px', fontSize:8, color:'#2b3644', lineHeight:1.6 }}>
        Events are re-derived from candle history on every measurement, so a bot restart loses nothing and the
        “×/month” figure is each instrument&apos;s own measured rate rather than a guess. Conditions that cannot be
        measured for an instrument — no COT report, no spread feed — are shown as such instead of counting as false.
        A filter marked for push is evaluated on the VPS by the same rules this screen uses, so a notification can
        only ever name something that is also here.
        {feed?.meta && (
          <div style={{ marginTop:3 }}>
            {feed.meta.instruments} instruments · H4 scanned over {feed.meta.bars?.H4} bars, daily over {feed.meta.bars?.D} ·
            events kept {feed.meta.retainDays?.H4}d (H4) / {feed.meta.retainDays?.D}d (daily)
            {feed.meta.pending > 0 && ` · ${feed.meta.pending} measurement(s) still queued on the VPS`}
          </div>
        )}
      </div>
    </div>
  );
}

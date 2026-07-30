import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  fetchFeed, evaluate, CONDITIONS, CONDITION_GROUPS, defaultParams,
  loadFilters, saveFilters, loadActiveId, saveActiveId, newFilter,
  rarityFor, feedAge, ago,
} from '../utils/liveFeed';
import { CLASS, CLASS_ORDER } from '../data/instruments';

const C = {
  bg:'#080c11', panel:'#0b1118', line:'#16202b', dim:'#475569', txt:'#cbd5e1',
  accent:'#00d4aa', warn:'#f59e0b', bad:'#ef4444', good:'#22c55e', mono:'var(--mono, monospace)',
};

const WATCH_KEY = 'forex_watchlist';
const readWatch = () => { try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); } catch { return []; } };

function toggleWatch(sym) {
  const prev = readWatch();
  const next = prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym];
  localStorage.setItem(WATCH_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event('storage'));
  return next;
}

const btn = (on) => ({
  fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:2, cursor:'pointer',
  border:`1px solid ${on ? '#00d4aa55' : C.line}`, background: on ? '#00d4aa15' : 'transparent',
  color: on ? C.accent : C.dim,
});

// ── One matching instrument ───────────────────────────────────────────────────
function Row({ r, filter, watched, onWatch, onOpen }) {
  const cls = CLASS[r.cls];
  const rarity = rarityFor(r.rec, filter);

  return (
    <div style={{ borderBottom:'1px solid #0e161e', padding:'7px 9px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:7, fontFamily:C.mono }}>
        <button onClick={() => onWatch(r.sym)} title={watched ? 'Remove from watchlist' : 'Shortlist — adds to the Watchlist tab'}
          style={{ background:'none', border:'none', cursor:'pointer', padding:0, fontSize:13, lineHeight:1,
            color: watched ? C.warn : '#28323d' }}>★</button>
        <span onClick={() => onOpen(r.sym)} style={{ fontSize:11, fontWeight:800, color:C.txt, width:80, flexShrink:0, cursor:'pointer' }}>
          {r.sym}
        </span>
        <span style={{ fontSize:8, fontWeight:800, color:cls.color, width:44, flexShrink:0 }}>{cls.label}</span>
        <span style={{ fontSize:10, color:C.dim, flexShrink:0 }}>
          {r.price != null ? r.price.toFixed(r.dec ?? 2) : '—'}
        </span>
        <span style={{ marginLeft:'auto', fontSize:9, color:C.dim, flexShrink:0 }}>
          {r.newestAt ? ago(Date.now() - r.newestAt) : ''}
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

      {rarity.length > 0 && (
        <div style={{ fontSize:8, color:'#2b3644', fontFamily:C.mono, marginTop:4, paddingLeft:20 }}>
          {rarity.map(x => `${CONDITIONS[x.key]?.label ?? x.key} ${x.tf}: ${x.n}× in ${x.days}d (~${x.perMonth}/month here)`).join(' · ')}
        </div>
      )}
    </div>
  );
}

// ── Filter editor ─────────────────────────────────────────────────────────────
function Editor({ filter, onChange, onClose, onDelete, onDuplicate, onExport, onImport }) {
  const used = new Set((filter.conditions || []).map(c => c.key));

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
            border:`1px solid ${C.line}`, borderRadius:3, padding:'3px 7px', minWidth:150, flex:1 }}/>
        <button onClick={onDuplicate} style={btn(false)}>duplicate</button>
        <button onClick={onExport} title="Copy all filters as JSON" style={btn(false)}>export</button>
        <button onClick={onImport} title="Paste filters exported from another device" style={btn(false)}>import</button>
        <button onClick={onDelete} style={{ ...btn(false), color:C.bad, borderColor:'#ef444433' }}>delete</button>
        <button onClick={onClose} style={btn(true)}>done</button>
      </div>

      <div style={{ padding:'9px 10px' }}>
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

        {filter.mode === 'all' && filter.conditions.length >= 4 && (
          <div style={{ fontSize:9, color:C.warn, fontFamily:C.mono, marginBottom:8, lineHeight:1.5 }}>
            Four conditions ANDed together will return nothing on most days. ANY {Math.ceil(filter.conditions.length / 2)} of {filter.conditions.length} is usually what you actually want.
          </div>
        )}

        {/* ── Instrument scope ── */}
        <div style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap', marginBottom:9 }}>
          <span style={{ fontSize:9, color:C.dim, fontFamily:C.mono }}>look at</span>
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
                {def.params.map(p => (
                  <label key={p.k} style={{ display:'flex', alignItems:'center', gap:4, fontSize:9, color:C.dim, fontFamily:C.mono }}>
                    {p.label}
                    {p.type === 'select' ? (
                      <select value={params[p.k]} onChange={e => setParam(i, p.k, e.target.value)}
                        style={{ fontSize:9, fontFamily:C.mono, background:'#0f172a', color:C.txt,
                          border:`1px solid ${C.line}`, borderRadius:3, padding:'2px 4px' }}>
                        {p.options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                      </select>
                    ) : (
                      <input type="number" value={params[p.k]} min={p.min} max={p.max} step={p.step}
                        onChange={e => setParam(i, p.k, e.target.value === '' ? p.def : +e.target.value)}
                        style={{ width:58, fontSize:9, fontFamily:C.mono, background:'#0f172a', color:C.txt,
                          border:`1px solid ${C.line}`, borderRadius:3, padding:'2px 5px' }}/>
                    )}
                  </label>
                ))}
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
  const [watch,   setWatch]   = useState(readWatch);
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
            onChange={updateActive}
            onClose={() => setEditing(false)}
            onExport={exportFilters}
            onImport={importFilters}
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
        never which way to trade. Star a row to send it to the Watchlist tab, or tap it for the full read.
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

      {stale && !feed?.missing && (
        <div style={{ margin:'8px 10px', padding:9, background:C.panel, border:'1px solid #f59e0b33', borderRadius:5,
          fontSize:9, color:C.warn, lineHeight:1.6 }}>
          Last publish was {ago(age)}. Either nothing has changed on any instrument, or the bot is not running.
          Everything below is as of then, not now.
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
          <Row key={r.sym} r={r} filter={active} watched={watch.includes(r.sym)}
            onWatch={sym => setWatch(toggleWatch(sym))} onOpen={onOpen}/>
        ))}
      </div>

      <div style={{ padding:'0 12px 20px', fontSize:8, color:'#2b3644', lineHeight:1.6 }}>
        Events are re-derived from candle history on every measurement, so a bot restart loses nothing and the
        “×/month” figure is each instrument&apos;s own measured rate rather than a guess. Conditions that cannot be
        measured for an instrument — no COT report, no spread feed — are shown as such instead of counting as false.
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

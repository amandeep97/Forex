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
import { rank, ageOf, driversOf, clusters, FAMILY } from '../utils/confluence';
import ChartModal from './ChartModal';

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

const fmtAge = ms => ms == null ? 'never'
  : ms < 90e3 ? 'just now'
  : ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago`
  : `${(ms / 3600e3).toFixed(1)}h ago`;

export default function CommandCenter() {
  const [feed, setFeed] = useState(null);
  const [news, setNews] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(Date.now());
  const [minBreadth, setMinBreadth] = useState(3);
  const [top, setTop] = useState(12);
  const [allOpen, setAllOpen] = useState(false);
  const [showDrivers, setShowDrivers] = useState(true);
  const [showPacks, setShowPacks] = useState(true);
  const [open, setOpen] = useState({});
  const [cls, setCls] = useState('all');
  const [dir, setDir] = useState('all');
  const [onlyStrong, setOnlyStrong] = useState(false);
  const [onlyMulti, setOnlyMulti] = useState(false);
  const [oneEach, setOneEach] = useState(false);
  const [q, setQ] = useState('');
  const [tf, setTf] = useState('all');
  const [chart, setChart] = useState(null);

  const load = useCallback(async () => {
    setErr('');
    const [f, n] = await Promise.allSettled([
      fetchFeed({ force: true }),
      fetch(`${NEWS_URL}?t=${Date.now()}`, { cache:'no-store', signal: AbortSignal.timeout(15000) })
        .then(r => r.status === 404 ? null : r.ok ? r.json() : null),
    ]);
    if (f.status === 'fulfilled' && f.value && !f.value.missing) setFeed(f.value);
    else if (f.status === 'rejected') setErr(f.reason?.message || 'feed unavailable');
    if (n.status === 'fulfilled') setNews(n.value);
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

  const ranked = useMemo(() => {
    let out = all;
    if (cls !== 'all') out = out.filter(r => r.cls === cls);
    if (dir !== 'all') out = out.filter(r => r.dir === (dir === 'up' ? 'up' : 'down'));
    if (onlyStrong) out = out.filter(r => r.strong);
    if (onlyMulti)  out = out.filter(r => r.multiTf);
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
  }, [all, cls, dir, onlyStrong, onlyMulti, oneEach, q, tf, top]);
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

            {r.shared?.length > 0 && (
              <div style={{ fontSize:11, color:'#60a5fa', marginTop:5 }}>
                ◷ {r.shared[0].label}{r.shared.length > 1 ? ` +${r.shared.length - 1} more driver${r.shared.length > 2 ? 's' : ''}` : ''}
              </div>
            )}

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
      </div>
    </div>
  );
}

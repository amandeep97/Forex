'use strict';
import { useState, useEffect, useCallback } from 'react';

const PROXY        = 'https://corsproxy.io/?';
const CALENDAR_URL = PROXY + encodeURIComponent('https://nfs.faireconomy.media/ff_calendar_thisweek.json');

const NEWS_FEEDS = [
  { name: 'Reuters',     url: 'https://feeds.reuters.com/reuters/businessNews',                     color: '#f97316', badge: '🔶' },
  { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/',              color: '#22c55e', badge: '📈' },
  { name: 'CNBC',        url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',             color: '#3b82f6', badge: '📡' },
  { name: 'Yahoo Fin',   url: 'https://finance.yahoo.com/rss/topfinstories',                        color: '#8b5cf6', badge: '💹' },
  { name: 'ForexLive',   url: 'https://forexlive.com/feed/news',                                   color: '#00d4aa', badge: '⚡' },
  { name: 'FXStreet',    url: 'https://www.fxstreet.com/rss/news',                                 color: '#f59e0b', badge: '🌐' },
  { name: 'DailyFX',    url: 'https://feeds.dailyfx.com/forex-market-news',                       color: '#ec4899', badge: '📊' },
];

// Parse RSS XML text into item array using browser DOMParser
function parseRSS(text) {
  const doc   = new DOMParser().parseFromString(text, 'application/xml');
  const items = [...doc.querySelectorAll('item')];
  return items.map(el => {
    const get = tag => el.querySelector(tag)?.textContent?.trim() || '';
    const link = get('link') || el.querySelector('guid')?.textContent?.trim() || '';
    const img  = el.querySelector('enclosure[type^="image"]')?.getAttribute('url')
              || el.querySelector('media\\:thumbnail, thumbnail')?.getAttribute('url')
              || null;
    return { title: get('title'), link, pubDate: get('pubDate'), description: get('description'), author: get('author') || get('dc\\:creator'), thumbnail: img };
  });
}

const TRACKED = ['USD','EUR','GBP','JPY','CHF','AUD','NZD','CAD','CNY'];

const IMP = {
  High:   { dot: '#ef4444', bg: '#ef444418', border: '#ef444435', text: '#ef4444' },
  Medium: { dot: '#f59e0b', bg: '#f59e0b18', border: '#f59e0b35', text: '#f59e0b' },
  Low:    { dot: '#64748b', bg: '#64748b10', border: '#64748b25', text: '#64748b' },
};

function impStyle(impact) { return IMP[impact] || IMP.Low; }

function countdown(dateStr) {
  const diff = new Date(dateStr) - Date.now();
  if (diff < 0) return null;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'NOW';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return null;
}

// ── Economic calendar event row ───────────────────────────────────────────────
function EventRow({ ev }) {
  const s        = impStyle(ev.impact);
  const evDate   = new Date(ev.date);
  const isPast   = evDate < Date.now();
  const cd       = countdown(ev.date);
  const imminent = cd && cd !== null && (cd === 'NOW' || cd.endsWith('m'));

  const numColor = (actual, forecast) => {
    if (!actual || !forecast) return '#f1f5f9';
    return parseFloat(actual) >= parseFloat(forecast) ? '#22c55e' : '#ef4444';
  };

  return (
    <div style={{
      padding: '10px 14px', borderRadius: 8, marginBottom: 6,
      background: imminent ? '#1a1f2e' : '#1e293b',
      border: `1px solid ${imminent ? s.border : '#1e293b'}`,
      opacity: isPast && !ev.actual ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        {/* Impact dot */}
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />

        {/* Currency badge */}
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
          background: '#0c4a6e33', color: '#38bdf8', border: '1px solid #38bdf825',
        }}>{ev.country}</span>

        {/* Impact label */}
        <span style={{ fontSize: 10, fontWeight: 600, color: s.text }}>{ev.impact}</span>

        {/* Countdown / time */}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: imminent ? s.text : '#475569', fontWeight: imminent ? 700 : 400 }}>
          {cd ? cd : evDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9', marginBottom: ev.forecast || ev.previous || ev.actual ? 6 : 0 }}>
        {ev.title}
      </div>

      {(ev.forecast || ev.previous || ev.actual) && (
        <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
          {ev.forecast && (
            <span style={{ color: '#64748b' }}>Fcst <strong style={{ color: '#94a3b8' }}>{ev.forecast}</strong></span>
          )}
          {ev.previous && (
            <span style={{ color: '#64748b' }}>Prev <strong style={{ color: '#94a3b8' }}>{ev.previous}</strong></span>
          )}
          {ev.actual && (
            <span style={{ color: '#64748b' }}>
              Actual <strong style={{ color: numColor(ev.actual, ev.forecast) }}>{ev.actual}</strong>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── News article card ─────────────────────────────────────────────────────────
function NewsCard({ item }) {
  const d   = new Date(item.pubDate);
  const ago = (() => {
    const m = Math.floor((Date.now() - d) / 60000);
    if (m < 1)   return 'just now';
    if (m < 60)  return `${m}m ago`;
    if (m < 1440) return `${Math.floor(m/60)}h ago`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  })();

  return (
    <a href={item.link} target="_blank" rel="noopener noreferrer"
      style={{ display: 'block', textDecoration: 'none', marginBottom: 8 }}>
      <div style={{
        padding: '12px 14px', borderRadius: 8, background: '#1e293b',
        borderLeft: '3px solid #334155', transition: 'border-color 0.15s',
      }}>
        {item.thumbnail && (
          <img src={item.thumbnail} alt="" style={{
            width: '100%', height: 120, objectFit: 'cover',
            borderRadius: 6, marginBottom: 8,
          }} onError={e => { e.target.style.display = 'none'; }} />
        )}
        <div style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9', lineHeight: 1.45, marginBottom: 6 }}>
          {item.title}
        </div>
        {item.description && (
          <div style={{
            fontSize: 11, color: '#64748b', lineHeight: 1.5, marginBottom: 6,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }} dangerouslySetInnerHTML={{ __html: item.description }} />
        )}
        <div style={{ display: 'flex', gap: 6, fontSize: 10, color: '#475569' }}>
          {item.author && <span>{item.author}</span>}
          {item.author && <span>·</span>}
          <span>{ago}</span>
        </div>
      </div>
    </a>
  );
}

const NEWS_CACHE_KEY = 'forex_news_cache';

function getFinnhubKey() {
  try { return localStorage.getItem('finnhub_key') || ''; } catch { return ''; }
}

async function fetchFinnhubNews(key, category = 'forex') {
  const res = await fetch(
    `https://finnhub.io/api/v1/news?category=${category}&token=${key}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const data = await res.json();
  return data.map(a => ({
    title:       a.headline,
    link:        a.url,
    pubDate:     new Date(a.datetime * 1000).toUTCString(),
    description: a.summary,
    author:      a.source,
    thumbnail:   a.image || null,
    source:      a.source,
  }));
}

function cacheNews(items, sourceName) {
  try {
    localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify({
      items: items.slice(0, 12).map(i => ({
        title:  i.title,
        source: sourceName || i.author || '',
        age:    i.pubDate ? Math.round((Date.now() - new Date(i.pubDate)) / 60000) : null,
      })),
      ts: Date.now(),
    }));
  } catch {}
}

// ── Main component ────────────────────────────────────────────────────────────
export default function NewsCalendar() {
  const [subTab,      setSubTab]  = useState('calendar');
  const [events,      setEvents]  = useState([]);
  const [news,        setNews]    = useState([]);
  const [loading,     setLoad]    = useState(false);
  const [error,       setError]   = useState('');
  const [impact,      setImpact]  = useState('High');
  const [feedIdx,     setFeedIdx] = useState(0);
  const [finnhubKey,  setFhKey]   = useState(() => getFinnhubKey());
  const [showFhInput, setShowFh]  = useState(false);
  const [, setTick]               = useState(0);

  // refresh countdown every minute
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 60000);
    return () => clearInterval(t);
  }, []);

  const loadCalendar = useCallback(async () => {
    setLoad(true); setError('');
    try {
      const res  = await fetch(CALENDAR_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEvents(await res.json());
    } catch (e) {
      setError('Could not load calendar. ' + e.message);
    }
    setLoad(false);
  }, []);

  const loadNews = useCallback(async (idx) => {
    setLoad(true); setError('');
    try {
      const feed = NEWS_FEEDS[idx];
      const proxyUrl = PROXY + encodeURIComponent(feed.url);
      const res  = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const items = parseRSS(text);
      if (!items.length) throw new Error('No articles — feed may have moved');
      cacheNews(items, feed.name);
      setNews(items);
    } catch (e) {
      setError(`Could not load ${NEWS_FEEDS[idx]?.name}: ${e.message}`);
    }
    setLoad(false);
  }, []);

  const loadFinnhub = useCallback(async (key) => {
    if (!key) { setShowFh(true); return; }
    setLoad(true); setError('');
    try {
      localStorage.setItem('finnhub_key', key);
      const items = await fetchFinnhubNews(key, 'forex');
      if (!items.length) throw new Error('No articles returned');
      cacheNews(items, 'Finnhub');
      setNews(items);
    } catch (e) {
      setError('Finnhub error: ' + e.message);
    }
    setLoad(false);
  }, []);

  useEffect(() => {
    if (subTab === 'calendar') loadCalendar();
    else loadNews(feedIdx);
  }, [subTab]); // eslint-disable-line

  // Filter & group calendar
  const filtered = events
    .filter(ev => {
      if (!TRACKED.includes(ev.country)) return false;
      if (impact === 'all') return true;
      if (impact === 'High')   return ev.impact === 'High';
      if (impact === 'Medium') return ev.impact === 'High' || ev.impact === 'Medium';
      return true;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const grouped = {};
  filtered.forEach(ev => {
    const d = new Date(ev.date);
    const key = d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(ev);
  });

  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const isToday = k => k === today;

  return (
    <div style={{ paddingBottom: 80, minHeight: '100vh', background: '#0d1117' }}>

      {/* Sub-tabs */}
      <div style={{
        display: 'flex', borderBottom: '1px solid #1e293b',
        background: '#0d1117', position: 'sticky', top: 0, zIndex: 10,
      }}>
        {[
          { id: 'calendar', label: '📅 Calendar' },
          { id: 'news',     label: '📰 News'     },
          { id: 'finnhub',  label: '⚡ Live Feed' },
        ].map(t => (
          <button key={t.id} onClick={() => setSubTab(t.id)} style={{
            flex: 1, padding: '13px 0', background: 'none', border: 'none', cursor: 'pointer',
            borderBottom: `2px solid ${subTab === t.id ? '#00d4aa' : 'transparent'}`,
            color: subTab === t.id ? '#00d4aa' : '#475569',
            fontSize: 13, fontWeight: 600,
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ padding: '12px 14px' }}>

        {/* Error */}
        {error && (
          <div style={{ padding: '10px 14px', borderRadius: 8, background: '#450a0a', color: '#fca5a5', fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: 48, color: '#475569', fontSize: 13 }}>Loading…</div>
        )}

        {/* ── Calendar ── */}
        {subTab === 'calendar' && !loading && (
          <>
            {/* Impact filter chips */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto', paddingBottom: 2 }}>
              {[
                { k: 'High',   label: '🔴 High' },
                { k: 'Medium', label: '🟡 Med+' },
                { k: 'all',    label: 'All'      },
              ].map(f => (
                <button key={f.k} onClick={() => setImpact(f.k)} style={{
                  padding: '5px 14px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                  background: impact === f.k ? '#00d4aa18' : '#0f172a',
                  color:      impact === f.k ? '#00d4aa'   : '#475569',
                  border: `1px solid ${impact === f.k ? '#00d4aa35' : '#1e293b'}`,
                }}>{f.label}</button>
              ))}
              <button onClick={loadCalendar} style={{
                marginLeft: 'auto', padding: '5px 12px', borderRadius: 20, fontSize: 13,
                cursor: 'pointer', background: '#0f172a', color: '#475569', border: '1px solid #1e293b', flexShrink: 0,
              }}>↻</button>
            </div>

            {Object.keys(grouped).length === 0 && !error && (
              <div style={{ textAlign: 'center', padding: 48, color: '#334155', fontSize: 13 }}>
                No {impact !== 'all' ? impact.toLowerCase() + ' impact ' : ''}events this week
              </div>
            )}

            {Object.entries(grouped).map(([date, evs]) => (
              <div key={date} style={{ marginBottom: 18 }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
                  color: isToday(date) ? '#00d4aa' : '#334155',
                  marginBottom: 8, textTransform: 'uppercase',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  {date}
                  {isToday(date) && (
                    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: '#00d4aa20', color: '#00d4aa', border: '1px solid #00d4aa30' }}>TODAY</span>
                  )}
                </div>
                {evs.map((ev, i) => <EventRow key={i} ev={ev} />)}
              </div>
            ))}
          </>
        )}

        {/* ── News ── */}
        {subTab === 'news' && !loading && (
          <>
            <div style={{ display:'flex', gap:6, marginBottom:14, overflowX:'auto', paddingBottom:2 }}>
              {NEWS_FEEDS.map((f, i) => (
                <button key={i} onClick={() => { setFeedIdx(i); loadNews(i); }} style={{
                  padding:'5px 12px', borderRadius:20, fontSize:11, fontWeight:600,
                  cursor:'pointer', whiteSpace:'nowrap', flexShrink:0,
                  background: feedIdx === i ? `${f.color}18` : '#0f172a',
                  color:      feedIdx === i ? f.color : '#475569',
                  border:`1px solid ${feedIdx === i ? f.color + '44' : '#1e293b'}`,
                }}>{f.badge} {f.name}</button>
              ))}
              <button onClick={() => loadNews(feedIdx)} style={{
                marginLeft:'auto', padding:'5px 12px', borderRadius:20, fontSize:13,
                cursor:'pointer', background:'#0f172a', color:'#475569', border:'1px solid #1e293b', flexShrink:0,
              }}>↻</button>
            </div>

            {news.length === 0 && !error && (
              <div style={{ textAlign:'center', padding:48, color:'#334155', fontSize:13 }}>
                Tap a source above to load headlines
              </div>
            )}
            {news.map((item, i) => <NewsCard key={i} item={item} />)}
          </>
        )}

        {/* ── Finnhub Live Feed ── */}
        {subTab === 'finnhub' && !loading && (
          <>
            <div style={{ background:'#0f172a', borderRadius:10, padding:14, marginBottom:14,
              border:'1px solid #1e293b' }}>
              <div style={{ fontSize:12, fontWeight:700, color:'#f1f5f9', marginBottom:6 }}>
                ⚡ Finnhub Real-Time News
                <span style={{ fontSize:10, color:'#475569', fontWeight:400, marginLeft:8 }}>
                  Free key → finnhub.io/dashboard
                </span>
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <input
                  type="password"
                  placeholder="Paste Finnhub API key (free)"
                  value={finnhubKey}
                  onChange={e => setFhKey(e.target.value)}
                  style={{ flex:1, background:'#1e293b', border:'1px solid #334155', borderRadius:8,
                    color:'#f1f5f9', fontSize:12, padding:'8px 10px', outline:'none' }}
                />
                <button onClick={() => loadFinnhub(finnhubKey)} style={{
                  padding:'8px 16px', borderRadius:8, border:'1px solid #00d4aa44',
                  background:'#00d4aa12', color:'#00d4aa', fontSize:12, fontWeight:700, cursor:'pointer',
                }}>Load</button>
              </div>
              <div style={{ display:'flex', gap:8, marginTop:10, flexWrap:'wrap' }}>
                {['forex','general','merger'].map(cat => (
                  <button key={cat} onClick={() => fetchFinnhubNews(finnhubKey, cat).then(items => {
                    if (items.length) { cacheNews(items, 'Finnhub'); setNews(items); }
                  }).catch(e => setError(e.message))} style={{
                    padding:'4px 12px', borderRadius:12, fontSize:10, fontWeight:700,
                    cursor:'pointer', background:'#1e293b', color:'#94a3b8', border:'1px solid #334155',
                  }}>{cat === 'forex' ? '💱 Forex' : cat === 'general' ? '📰 General' : '🔀 M&A'}</button>
                ))}
              </div>
            </div>
            {news.length === 0 && !error && (
              <div style={{ textAlign:'center', padding:48, color:'#334155', fontSize:13 }}>
                Enter your free Finnhub key and tap Load
              </div>
            )}
            {news.map((item, i) => <NewsCard key={i} item={item} />)}
          </>
        )}

      </div>
    </div>
  );
}

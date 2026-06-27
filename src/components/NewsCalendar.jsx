'use strict';
import { useState, useEffect, useCallback, useMemo } from 'react';

// ── CORS proxies — raced simultaneously, first success wins (resilient) ────────
const PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://thingproxy.freeboard.io/fetch/${url}`,
];

const CALENDAR_SRC = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

// Race all proxies, return first OK response text
async function proxyFetch(targetUrl, timeout = 12000) {
  const attempts = PROXIES.map(p => fetch(p(targetUrl), { signal: AbortSignal.timeout(timeout) })
    .then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }));
  return Promise.any(attempts);
}

const NEWS_FEEDS = [
  { name: 'ForexLive',   url: 'https://www.forexlive.com/feed/news',                  color: '#00d4aa', badge: '⚡' },
  { name: 'FXStreet',    url: 'https://www.fxstreet.com/rss/news',                    color: '#f59e0b', badge: '🌐' },
  { name: 'DailyFX',     url: 'https://www.dailyfx.com/feeds/market-news',            color: '#ec4899', badge: '📊' },
  { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/',color: '#22c55e', badge: '📈' },
  { name: 'CNBC',        url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',color: '#3b82f6', badge: '📡' },
  { name: 'Investing',   url: 'https://www.investing.com/rss/news_25.rss',            color: '#8b5cf6', badge: '💹' },
];

// ── Currency + sentiment tagging ──────────────────────────────────────────────
const TRACKED = ['USD','EUR','GBP','JPY','CHF','AUD','NZD','CAD','CNY'];

const CCY_KEYWORDS = {
  USD: ['fed','fomc','powell','dollar','u.s.','united states','treasury','nonfarm','payroll',' nfp','jerome'],
  EUR: ['ecb','lagarde','euro','eurozone','germany','german','france','french','bundesbank'],
  GBP: ['boe','bank of england','bailey','pound','sterling','britain','british','uk '],
  JPY: ['boj','bank of japan','ueda','yen','japan','japanese','tokyo'],
  CHF: ['snb','franc','swiss','switzerland'],
  AUD: ['rba','aussie','australia','australian'],
  NZD: ['rbnz','kiwi','new zealand'],
  CAD: ['boc','bank of canada','loonie','canada','canadian','macklem'],
  CNY: ['pboc','yuan','renminbi','china','chinese','beijing'],
};

const BULLISH_WORDS = ['hike','hikes','hawkish','raise','raises','raised','tighten','tightening','beat','beats','surge','surges','jump','jumps','rally','rallies','strong','stronger','rises','rose','soar','soars','robust','upbeat','accelerat','outperform','higher-than'];
const BEARISH_WORDS = ['cut','cuts','dovish','ease','easing','recession','slowdown','slows','miss','misses','plunge','plunges','tumble','tumbles','weak','weaker','falls','fell','slump','contraction','stimulus','downbeat','lower-than','disappoint'];

// Indicators where a HIGHER actual is bearish for the currency
const INVERSE_INDICATORS = ['unemployment rate','jobless','initial claims','continuing claims','inventories','deficit'];

function detectCurrencies(text) {
  const t = ' ' + text.toLowerCase() + ' ';
  const out = [];
  for (const [ccy, words] of Object.entries(CCY_KEYWORDS)) {
    if (words.some(w => t.includes(w))) out.push(ccy);
  }
  return out;
}

// Returns +1 bullish, -1 bearish, 0 neutral for a headline
function detectBias(text) {
  const t = text.toLowerCase();
  let score = 0;
  BULLISH_WORDS.forEach(w => { if (t.includes(w)) score++; });
  BEARISH_WORDS.forEach(w => { if (t.includes(w)) score--; });
  return score > 0 ? 1 : score < 0 ? -1 : 0;
}

// Event directional bias from actual vs forecast (currency strength)
function eventBias(ev) {
  if (!ev.actual || !ev.forecast) return 0;
  const a = parseFloat(String(ev.actual).replace(/[^0-9.-]/g, ''));
  const f = parseFloat(String(ev.forecast).replace(/[^0-9.-]/g, ''));
  if (isNaN(a) || isNaN(f) || a === f) return 0;
  let strong = a > f;
  const title = (ev.title || '').toLowerCase();
  if (INVERSE_INDICATORS.some(k => title.includes(k))) strong = !strong;
  return strong ? 1 : -1;
}

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
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// ── News Radar: per-currency next event + news bias ───────────────────────────
function buildRadar(events, newsItems) {
  const now = Date.now();
  const radar = {};
  TRACKED.forEach(c => { radar[c] = { ccy: c, nextMs: null, nextTitle: null, impact: null, bull: 0, bear: 0 }; });

  events.forEach(ev => {
    if (!radar[ev.country]) return;
    if (ev.impact !== 'High' && ev.impact !== 'Medium') return;
    const t = new Date(ev.date).getTime();
    if (t < now) return;
    const r = radar[ev.country];
    // prefer the soonest High; only fall back to Medium if no High yet
    if (r.nextMs === null || (ev.impact === 'High' && r.impact !== 'High') ||
        (t < r.nextMs && (ev.impact === r.impact || r.impact !== 'High'))) {
      r.nextMs = t; r.nextTitle = ev.title; r.impact = ev.impact;
    }
  });

  (newsItems || []).forEach(it => {
    const text = `${it.title} ${it.description || ''}`;
    const bias = detectBias(text);
    if (!bias) return;
    detectCurrencies(text).forEach(c => { if (radar[c]) bias > 0 ? radar[c].bull++ : radar[c].bear++; });
  });

  return radar;
}

function persistRadar(radar) {
  try {
    const summary = {};
    Object.values(radar).forEach(r => {
      summary[r.ccy] = {
        nextMs: r.nextMs, nextTitle: r.nextTitle, impact: r.impact,
        newsBias: r.bull - r.bear,
      };
    });
    localStorage.setItem('news_radar', JSON.stringify({ ts: Date.now(), currencies: summary }));
  } catch {}
}

// ── Radar strip ───────────────────────────────────────────────────────────────
function RadarStrip({ radar, selCcy, onSelect }) {
  const cards = TRACKED.map(c => radar[c]).filter(r => r && (r.nextMs || r.bull || r.bear));
  // sort: imminent high-impact events first
  cards.sort((a, b) => {
    if (a.nextMs && b.nextMs) return a.nextMs - b.nextMs;
    if (a.nextMs) return -1;
    if (b.nextMs) return 1;
    return (b.bull + b.bear) - (a.bull + a.bear);
  });
  if (!cards.length) return null;

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: '#475569', marginBottom: 8, textTransform: 'uppercase' }}>
        📡 News Radar — tap a currency to filter
      </div>
      <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4 }}>
        {cards.map(r => {
          const cd = r.nextMs ? countdown(new Date(r.nextMs).toISOString()) : null;
          const imminent = cd && (cd === 'NOW' || cd.endsWith('m'));
          const netBias = r.bull - r.bear;
          const biasColor = netBias > 0 ? '#22c55e' : netBias < 0 ? '#ef4444' : '#64748b';
          const active = selCcy === r.ccy;
          const ring = imminent ? '#ef4444' : r.impact === 'High' ? '#f59e0b' : active ? '#00d4aa' : '#1e293b';
          return (
            <button key={r.ccy} onClick={() => onSelect(active ? 'all' : r.ccy)} style={{
              flexShrink: 0, minWidth: 92, textAlign: 'left', cursor: 'pointer',
              background: active ? '#00d4aa12' : '#0f172a',
              border: `1px solid ${ring}${imminent ? '' : '66'}`,
              borderRadius: 10, padding: '8px 10px',
              boxShadow: imminent ? '0 0 10px #ef444433' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: '#f1f5f9' }}>{r.ccy}</span>
                {netBias !== 0 && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: biasColor }}>
                    {netBias > 0 ? '▲' : '▼'}{Math.abs(netBias)}
                  </span>
                )}
              </div>
              {cd ? (
                <div style={{ fontSize: 10, fontWeight: 700, color: imminent ? '#ef4444' : r.impact === 'High' ? '#f59e0b' : '#94a3b8' }}>
                  {r.impact === 'High' ? '🔴' : '🟡'} {cd}
                </div>
              ) : (
                <div style={{ fontSize: 10, color: '#475569' }}>no event</div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Economic calendar event row ───────────────────────────────────────────────
function EventRow({ ev }) {
  const s        = impStyle(ev.impact);
  const evDate   = new Date(ev.date);
  const isPast   = evDate < Date.now();
  const cd       = countdown(ev.date);
  const imminent = cd && (cd === 'NOW' || cd.endsWith('m'));
  const bias     = isPast ? eventBias(ev) : 0;

  const numColor = (actual, forecast) => {
    if (!actual || !forecast) return '#f1f5f9';
    const b = eventBias(ev);
    return b > 0 ? '#22c55e' : b < 0 ? '#ef4444' : '#f1f5f9';
  };

  return (
    <div style={{
      padding: '10px 14px', borderRadius: 8, marginBottom: 6,
      background: imminent ? '#1a1f2e' : '#1e293b',
      border: `1px solid ${imminent ? s.border : '#1e293b'}`,
      opacity: isPast && !ev.actual ? 0.5 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
          background: '#0c4a6e33', color: '#38bdf8', border: '1px solid #38bdf825',
        }}>{ev.country}</span>
        <span style={{ fontSize: 10, fontWeight: 600, color: s.text }}>{ev.impact}</span>
        {bias !== 0 && (
          <span style={{ fontSize: 10, fontWeight: 700, color: bias > 0 ? '#22c55e' : '#ef4444' }}>
            {bias > 0 ? `▲ ${ev.country} bullish` : `▼ ${ev.country} bearish`}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: imminent ? s.text : '#475569', fontWeight: imminent ? 700 : 400 }}>
          {cd ? cd : evDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9', marginBottom: ev.forecast || ev.previous || ev.actual ? 6 : 0 }}>
        {ev.title}
      </div>

      {(ev.forecast || ev.previous || ev.actual) && (
        <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
          {ev.actual && (
            <span style={{ color: '#64748b' }}>
              Actual <strong style={{ color: numColor(ev.actual, ev.forecast) }}>{ev.actual}</strong>
            </span>
          )}
          {ev.forecast && (
            <span style={{ color: '#64748b' }}>Fcst <strong style={{ color: '#94a3b8' }}>{ev.forecast}</strong></span>
          )}
          {ev.previous && (
            <span style={{ color: '#64748b' }}>Prev <strong style={{ color: '#94a3b8' }}>{ev.previous}</strong></span>
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

  const text  = `${item.title} ${item.description || ''}`;
  const ccys  = detectCurrencies(text);
  const bias  = detectBias(text);
  const biasColor = bias > 0 ? '#22c55e' : bias < 0 ? '#ef4444' : null;

  return (
    <a href={item.link} target="_blank" rel="noopener noreferrer"
      style={{ display: 'block', textDecoration: 'none', marginBottom: 8 }}>
      <div style={{
        padding: '12px 14px', borderRadius: 8, background: '#1e293b',
        borderLeft: `3px solid ${biasColor || '#334155'}`, transition: 'border-color 0.15s',
      }}>
        {item.thumbnail && (
          <img src={item.thumbnail} alt="" style={{
            width: '100%', height: 120, objectFit: 'cover',
            borderRadius: 6, marginBottom: 8,
          }} onError={e => { e.target.style.display = 'none'; }} />
        )}
        {(ccys.length > 0 || bias !== 0) && (
          <div style={{ display: 'flex', gap: 5, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {ccys.map(c => (
              <span key={c} style={{
                fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                background: '#0c4a6e33', color: '#38bdf8', border: '1px solid #38bdf825',
              }}>{c}</span>
            ))}
            {bias !== 0 && (
              <span style={{ fontSize: 9, fontWeight: 700, color: biasColor }}>
                {bias > 0 ? '▲ hawkish/strong' : '▼ dovish/weak'}
              </span>
            )}
          </div>
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
  const [selCcy,      setSelCcy]  = useState('all');
  const [feedIdx,     setFeedIdx] = useState(0);
  const [finnhubKey,  setFhKey]   = useState(() => getFinnhubKey());
  const [, setTick]               = useState(0);

  // refresh countdowns every minute
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 60000);
    return () => clearInterval(t);
  }, []);

  const loadCalendar = useCallback(async () => {
    setLoad(true); setError('');
    try {
      const text = await proxyFetch(CALENDAR_SRC);
      setEvents(JSON.parse(text));
    } catch (e) {
      setError('Could not load calendar — all proxies failed. ' + (e.message || ''));
    }
    setLoad(false);
  }, []);

  const loadNews = useCallback(async (idx) => {
    setLoad(true); setError('');
    try {
      const feed = NEWS_FEEDS[idx];
      const text = await proxyFetch(feed.url);
      const items = parseRSS(text);
      if (!items.length) throw new Error('No articles — feed may have moved');
      cacheNews(items, feed.name);
      setNews(items);
    } catch (e) {
      setError(`Could not load ${NEWS_FEEDS[idx]?.name}: ${e.message}`);
    }
    setLoad(false);
  }, []);

  const loadFinnhub = useCallback(async (key, cat = 'forex') => {
    if (!key) return;
    setLoad(true); setError('');
    try {
      localStorage.setItem('finnhub_key', key);
      const items = await fetchFinnhubNews(key, cat);
      if (!items.length) throw new Error('No articles returned');
      cacheNews(items, 'Finnhub');
      setNews(items);
    } catch (e) {
      setError('Finnhub error: ' + e.message);
    }
    setLoad(false);
  }, []);

  // initial + on sub-tab change
  useEffect(() => {
    if (subTab === 'calendar') { if (!events.length) loadCalendar(); }
    else if (subTab === 'news') loadNews(feedIdx);
  }, [subTab]); // eslint-disable-line

  // Always load calendar once on mount so radar works regardless of tab
  useEffect(() => { loadCalendar(); }, [loadCalendar]);

  // Build + persist radar whenever events/news change
  const radar = useMemo(() => buildRadar(events, news), [events, news]);
  useEffect(() => { if (events.length) persistRadar(radar); }, [radar, events.length]);

  // Filter & group calendar
  const filtered = events
    .filter(ev => {
      if (!TRACKED.includes(ev.country)) return false;
      if (selCcy !== 'all' && ev.country !== selCcy) return false;
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

  // News filtered by selected currency
  const newsFiltered = selCcy === 'all'
    ? news
    : news.filter(it => detectCurrencies(`${it.title} ${it.description || ''}`).includes(selCcy));

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

        {/* News Radar — always visible */}
        <RadarStrip radar={radar} selCcy={selCcy} onSelect={setSelCcy} />

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
              {selCcy !== 'all' && (
                <button onClick={() => setSelCcy('all')} style={{
                  padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                  background: '#00d4aa18', color: '#00d4aa', border: '1px solid #00d4aa35',
                }}>{selCcy} ✕</button>
              )}
              <button onClick={loadCalendar} style={{
                marginLeft: 'auto', padding: '5px 12px', borderRadius: 20, fontSize: 13,
                cursor: 'pointer', background: '#0f172a', color: '#475569', border: '1px solid #1e293b', flexShrink: 0,
              }}>↻</button>
            </div>

            {Object.keys(grouped).length === 0 && !error && (
              <div style={{ textAlign: 'center', padding: 48, color: '#334155', fontSize: 13 }}>
                No {impact !== 'all' ? impact.toLowerCase() + ' impact ' : ''}events
                {selCcy !== 'all' ? ` for ${selCcy}` : ''} this week
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

            {newsFiltered.length === 0 && !error && (
              <div style={{ textAlign:'center', padding:48, color:'#334155', fontSize:13 }}>
                {news.length && selCcy !== 'all'
                  ? `No ${selCcy} headlines in this feed`
                  : 'Tap a source above to load headlines'}
              </div>
            )}
            {newsFiltered.map((item, i) => <NewsCard key={i} item={item} />)}
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
                  <button key={cat} onClick={() => loadFinnhub(finnhubKey, cat)} style={{
                    padding:'4px 12px', borderRadius:12, fontSize:10, fontWeight:700,
                    cursor:'pointer', background:'#1e293b', color:'#94a3b8', border:'1px solid #334155',
                  }}>{cat === 'forex' ? '💱 Forex' : cat === 'general' ? '📰 General' : '🔀 M&A'}</button>
                ))}
              </div>
            </div>
            {newsFiltered.length === 0 && !error && (
              <div style={{ textAlign:'center', padding:48, color:'#334155', fontSize:13 }}>
                Enter your free Finnhub key and tap Load
              </div>
            )}
            {newsFiltered.map((item, i) => <NewsCard key={i} item={item} />)}
          </>
        )}

      </div>
    </div>
  );
}

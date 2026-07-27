'use strict';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { OANDA_MAP } from '../hooks/useLivePrices';
import {
  mergeFeeds, tagInstruments, archiveEvents, archiveStats, archivedEventTypes,
  computeReaction, parseCommand, COMMANDS,
} from '../utils/newsTerminal';

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

// ── Terminal: OANDA window fetch (for ECO reaction stats) ─────────────────────
function oandaCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) { const e = localStorage.getItem('oanda_env'); return e !== null ? { ...c, practice: e !== 'live' } : c; }
  } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  return apiKey ? { apiKey, practice: localStorage.getItem('oanda_env') !== 'live' } : null;
}
const oandaBase = c => (c.practice === false ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3');

function makeWindowFetcher(instrument) {
  const instr = OANDA_MAP[instrument] || instrument.replace('/', '_');
  return async (fromMs, toMs) => {
    const c = oandaCreds();
    if (!c?.apiKey) throw new Error('OANDA not connected');
    const iso = ms => new Date(ms).toISOString();
    const url = `${oandaBase(c)}/instruments/${instr}/candles?granularity=M15&price=M`
      + `&from=${encodeURIComponent(iso(fromMs))}&to=${encodeURIComponent(iso(toMs))}`;
    const r = await fetch(url, { headers:{Authorization:`Bearer ${c.apiKey}`}, signal:AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`OANDA ${r.status}`);
    const d = await r.json();
    return (d.candles || []).filter(x => x.complete)
      .map(x => ({ t:new Date(x.time).getTime(), o:+x.mid.o, h:+x.mid.h, l:+x.mid.l, c:+x.mid.c }));
  };
}

async function fetchOpenPositions() {
  const c = oandaCreds();
  if (!c?.apiKey) return [];
  const acct = localStorage.getItem('oanda_account') || '';
  if (!acct) return [];
  try {
    const r = await fetch(`${oandaBase(c)}/accounts/${acct}/openTrades`,
      { headers:{Authorization:`Bearer ${c.apiKey}`}, signal:AbortSignal.timeout(9000) });
    if (!r.ok) return [];
    const d = await r.json();
    const rev = Object.fromEntries(Object.entries(OANDA_MAP).map(([k, v]) => [v, k]));
    return (d.trades || []).map(t => rev[t.instrument] || t.instrument.replace('_', '/'));
  } catch { return []; }
}

// ── Terminal: command bar ─────────────────────────────────────────────────────
function CommandBar({ value, onChange, onSubmit, hint }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', background:'#000',
      border:'1px solid #1e3a2f', borderRadius:4, fontFamily:'var(--mono, monospace)' }}>
      <span style={{ color:'#00d4aa', fontWeight:800, fontSize:13 }}>&gt;</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onSubmit(value); }}
        placeholder="XAU · USD HIGH · ECO · POS · TODAY · ?"
        spellCheck={false} autoCapitalize="characters"
        style={{ flex:1, background:'transparent', border:'none', outline:'none',
          color:'#d1fae5', fontSize:13, fontFamily:'inherit', letterSpacing:'0.5px', textTransform:'uppercase' }}
      />
      <button onClick={() => onSubmit(value)} style={{ background:'#00d4aa18', border:'1px solid #00d4aa44',
        color:'#00d4aa', borderRadius:3, fontSize:10, fontWeight:800, padding:'3px 9px', cursor:'pointer' }}>GO</button>
      {hint && <span style={{ fontSize:10, color:'#475569' }}>{hint}</span>}
    </div>
  );
}

// ── Terminal: one headline row (dense, monospace) ─────────────────────────────
const SEV_COL = { 3:'#ef4444', 2:'#f59e0b', 1:'#64748b' };
function agoLabel(ms) {
  if (!ms) return '--:--';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'NOW';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function StreamRow({ it, onTag }) {
  const col = SEV_COL[it.sev];
  return (
    <a href={it.link} target="_blank" rel="noopener noreferrer"
      style={{ display:'flex', gap:8, padding:'5px 8px', borderBottom:'1px solid #0f1720',
        textDecoration:'none', alignItems:'baseline', fontFamily:'var(--mono, monospace)' }}>
      <span style={{ color:'#334155', fontSize:10, width:34, flexShrink:0 }}>{agoLabel(it.ms)}</span>
      <span style={{ color:col, fontSize:11, flexShrink:0 }}>{it.sev === 3 ? '●' : it.sev === 2 ? '◆' : '·'}</span>
      <span style={{ flex:1, minWidth:0 }}>
        <span style={{ color: it.sev === 3 ? '#fca5a5' : '#cbd5e1', fontSize:12, lineHeight:1.4 }}>{it.title}</span>
        <span style={{ display:'flex', gap:5, flexWrap:'wrap', marginTop:2, alignItems:'center' }}>
          <span style={{ fontSize:9, color:'#475569' }}>{it.source}</span>
          {it.alsoIn?.length > 0 && <span style={{ fontSize:9, color:'#334155' }}>+{it.alsoIn.length}</span>}
          {it.instruments.slice(0, 4).map(i => (
            <button key={i} onClick={e => { e.preventDefault(); onTag?.(i); }}
              style={{ fontSize:9, fontWeight:700, color:'#00d4aa', background:'#00d4aa12',
                border:'1px solid #00d4aa26', borderRadius:2, padding:'0 4px', cursor:'pointer' }}>{i}</button>
          ))}
        </span>
      </span>
    </a>
  );
}

// ── Terminal: ECO — how price actually reacted to past releases ───────────────
function EcoPanel({ instrument, onInstrument }) {
  const [types,  setTypes]  = useState([]);
  const [sel,    setSel]    = useState(null);
  const [res,    setRes]    = useState(null);
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState('');
  const arch = archiveStats();

  useEffect(() => { setTypes(archivedEventTypes(2)); }, []);

  const run = async (t) => {
    setSel(t); setRes(null); setErr(''); setBusy(true);
    try {
      const r = await computeReaction(t.title, t.country, makeWindowFetcher(instrument), {});
      setRes(r);
      if (!r.instances) setErr('No priceable instances yet — the archive has the events but OANDA returned no candles for those windows.');
    } catch (e) { setErr(e.message || 'Failed'); }
    setBusy(false);
  };

  return (
    <div style={{ fontFamily:'var(--mono, monospace)' }}>
      <div style={{ padding:'8px 10px', background:'#0a0f14', border:'1px solid #1e293b', borderRadius:4, marginBottom:10 }}>
        <div style={{ fontSize:11, color:'#00d4aa', fontWeight:800, marginBottom:4 }}>ECO · EVENT REACTION HISTORY</div>
        <div style={{ fontSize:10, color:'#64748b', lineHeight:1.5 }}>
          How <strong style={{color:'#cbd5e1'}}>{instrument}</strong> actually moved after past releases — measured from
          OANDA candles, split by whether the print beat or missed forecast. No prediction, just the record.
        </div>
        <div style={{ fontSize:10, color:'#475569', marginTop:5 }}>
          Archive: <span style={{color:'#cbd5e1'}}>{arch.n}</span> events
          {arch.days > 0 && <> · spanning <span style={{color:'#cbd5e1'}}>{arch.days}d</span></>}
          {arch.n < 50 && <span style={{ color:'#f59e0b' }}> · builds every time you open this tab</span>}
        </div>
      </div>

      <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:10 }}>
        {['XAU/USD','EUR/USD','GBP/USD','USD/JPY','US500','USOIL'].map(i => (
          <button key={i} onClick={() => { onInstrument(i); setRes(null); setSel(null); }}
            style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:3, cursor:'pointer',
              border:`1px solid ${instrument===i?'#00d4aa55':'#1e293b'}`,
              background: instrument===i?'#00d4aa15':'transparent', color: instrument===i?'#00d4aa':'#64748b' }}>{i}</button>
        ))}
      </div>

      {types.length === 0 ? (
        <div style={{ padding:16, fontSize:11, color:'#64748b', lineHeight:1.6, background:'#0a0f14',
          border:'1px solid #1e293b', borderRadius:4 }}>
          No repeating events archived yet. The calendar feed only publishes the current week, so history is
          accumulated locally — open this tab across a few weeks and reaction stats appear automatically.
          <div style={{ marginTop:6, color:'#475569' }}>Nothing to configure. It builds itself.</div>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:3, marginBottom:10 }}>
          {types.slice(0, 12).map(t => (
            <button key={`${t.country}|${t.title}`} onClick={() => run(t)}
              style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8,
                padding:'6px 9px', borderRadius:3, cursor:'pointer', textAlign:'left',
                border:`1px solid ${sel?.title===t.title&&sel?.country===t.country?'#00d4aa44':'#151f2b'}`,
                background: sel?.title===t.title&&sel?.country===t.country?'#00d4aa0c':'#0a0f14' }}>
              <span style={{ fontSize:11, color:'#cbd5e1' }}>
                <span style={{ color:'#00d4aa', fontWeight:800, marginRight:6 }}>{t.country}</span>{t.title}
              </span>
              <span style={{ fontSize:9, color:'#475569', flexShrink:0 }}>n={t.count}</span>
            </button>
          ))}
        </div>
      )}

      {busy && <div style={{ padding:14, fontSize:11, color:'#00d4aa' }}>Pricing {sel?.title} windows…</div>}
      {err && <div style={{ padding:10, fontSize:11, color:'#fca5a5', background:'#450a0a', borderRadius:4 }}>{err}</div>}

      {res && res.instances > 0 && (
        <div style={{ background:'#0a0f14', border:'1px solid #1e293b', borderRadius:4, padding:10 }}>
          <div style={{ fontSize:11, color:'#cbd5e1', fontWeight:700, marginBottom:8 }}>
            {res.country} {res.eventTitle} → {instrument}
            <span style={{ color:'#475569', fontWeight:400, marginLeft:6 }}>{res.instances} releases priced</span>
          </div>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
            <thead>
              <tr style={{ color:'#475569', fontSize:9, textAlign:'right' }}>
                <th style={{ textAlign:'left', padding:'2px 4px' }}>OUTCOME</th>
                <th style={{ padding:'2px 4px' }}>n</th>
                {res.horizons.map(h => <th key={h} style={{ padding:'2px 4px' }}>{h < 60 ? `${h}m` : `${h/60}h`}</th>)}
              </tr>
            </thead>
            <tbody>
              {res.buckets.map(b => (
                <tr key={b.name} style={{ borderTop:'1px solid #151f2b' }}>
                  <td style={{ padding:'4px', color: b.name==='beat'?'#22c55e':b.name==='miss'?'#ef4444':'#cbd5e1', fontWeight:700 }}>
                    {b.name.toUpperCase()}
                  </td>
                  <td style={{ padding:'4px', textAlign:'right', color: b.n>=8?'#64748b':'#f59e0b' }}>{b.n}</td>
                  {res.horizons.map(h => {
                    const v = b.horizons[h];
                    return (
                      <td key={h} style={{ padding:'4px', textAlign:'right', fontFamily:'inherit',
                        color: !v ? '#334155' : v.median > 0 ? '#22c55e' : v.median < 0 ? '#ef4444' : '#64748b' }}>
                        {v ? `${v.median > 0 ? '+' : ''}${v.median}%` : '—'}
                        {v && <span style={{ color:'#334155', fontSize:9 }}> {v.upPct}↑</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop:7, fontSize:9, color:'#475569', lineHeight:1.5 }}>
            Median % move from the release candle · <span style={{color:'#64748b'}}>N↑</span> = share that closed higher.
            {res.instances < 8 && <span style={{ color:'#f59e0b' }}> Sample is small — treat as indicative, not evidence.</span>}
          </div>
        </div>
      )}
    </div>
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

// ── TERMINAL VIEW ─────────────────────────────────────────────────────────────
function TerminalView({ events }) {
  const [cmd,     setCmd]     = useState('');
  const [f,       setF]       = useState({ view:'LIVE', ccy:null, instrument:null, impact:'High', today:false });
  const [stream,  setStream]  = useState([]);
  const [busy,    setBusy]    = useState(false);
  const [status,  setStatus]  = useState('');
  const [help,    setHelp]    = useState(false);
  const [ecoInst, setEcoInst] = useState('XAU/USD');
  const [pos,     setPos]     = useState([]);
  const [, setTick] = useState(0);
  const loaded = useRef(false);

  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 30000); return () => clearInterval(t); }, []);

  const loadStream = useCallback(async () => {
    setBusy(true); setStatus('fetching all sources…');
    try {
      const items = await mergeFeeds(NEWS_FEEDS, proxyFetch, parseRSS);
      setStream(items);
      setStatus(items.length ? `${items.length} stories · merged & deduped` : 'no stories returned');
    } catch { setStatus('all feeds failed'); }
    setBusy(false);
  }, []);

  useEffect(() => { if (!loaded.current) { loaded.current = true; loadStream(); fetchOpenPositions().then(setPos); } }, [loadStream]);

  const submit = (raw) => {
    const p = parseCommand(raw);
    if (p.help)  { setHelp(true); setCmd(''); return; }
    if (p.clear) { setF({ view:'LIVE', ccy:null, instrument:null, impact:'High', today:false }); setCmd(''); setStatus('filters cleared'); return; }
    setF(prev => ({
      view:       p.view       || prev.view,
      ccy:        p.ccy        ?? (p.instrument ? null : prev.ccy),
      instrument: p.instrument ?? (p.ccy ? null : prev.instrument),
      impact:     p.impact     || prev.impact,
      today:      p.today ? !prev.today : prev.today,
    }));
    if (p.instrument) setEcoInst(p.instrument);
    setStatus(p.unknown.length ? `unknown: ${p.unknown.join(' ')} — type ? for commands` : 'ok');
    setCmd('');
  };

  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);

  const shownStream = useMemo(() => {
    let s = stream;
    if (f.view === 'POS' && pos.length) s = s.filter(i => i.instruments.some(x => pos.includes(x)));
    if (f.instrument) s = s.filter(i => i.instruments.includes(f.instrument));
    if (f.ccy)        s = s.filter(i => detectCurrencies(`${i.title} ${i.description || ''}`).includes(f.ccy));
    if (f.today)      s = s.filter(i => i.ms >= startOfDay.getTime());
    return s.slice(0, 120);
  }, [stream, f, pos]); // eslint-disable-line

  const calEvents = useMemo(() => {
    const now = Date.now();
    return (events || [])
      .filter(ev => TRACKED.includes(ev.country))
      .filter(ev => f.impact === 'High' ? ev.impact === 'High' : (ev.impact === 'High' || ev.impact === 'Medium'))
      .filter(ev => !f.ccy || ev.country === f.ccy)
      .filter(ev => !f.today || new Date(ev.date) >= startOfDay)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map(ev => ({ ...ev, ms:new Date(ev.date).getTime(), future:new Date(ev.date).getTime() > now }));
  }, [events, f]); // eslint-disable-line

  const nextHigh = calEvents.find(e => e.future && e.impact === 'High');
  const chip = (label, on) => ({ fontSize:9, fontWeight:800, padding:'2px 7px', borderRadius:2,
    border:`1px solid ${on?'#00d4aa44':'#1e293b'}`, background:on?'#00d4aa15':'transparent', color:on?'#00d4aa':'#475569' });

  return (
    <div style={{ fontFamily:'var(--mono, monospace)' }}>
      <CommandBar value={cmd} onChange={setCmd} onSubmit={submit} />

      {/* status / filter line */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center', padding:'6px 2px', fontSize:10 }}>
        <span style={chip(f.view, true)}>{f.view}</span>
        {f.instrument && <span style={chip(f.instrument, true)}>{f.instrument}</span>}
        {f.ccy && <span style={chip(f.ccy, true)}>{f.ccy}</span>}
        {f.today && <span style={chip('TODAY', true)}>TODAY</span>}
        <span style={chip(f.impact.toUpperCase(), false)}>{f.impact.toUpperCase()}</span>
        <span style={{ color:'#334155', marginLeft:'auto' }}>{busy ? '···' : status}</span>
        <button onClick={loadStream} style={{ ...chip('↻', false), cursor:'pointer' }}>↻</button>
      </div>

      {/* next high-impact banner — the thing you actually need to know */}
      {nextHigh && (
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', marginBottom:8,
          background:'#ef44440e', border:'1px solid #ef444433', borderRadius:3 }}>
          <span style={{ fontSize:10, fontWeight:800, color:'#ef4444' }}>NEXT HIGH</span>
          <span style={{ fontSize:11, color:'#cbd5e1', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {nextHigh.country} {nextHigh.title}
          </span>
          <span style={{ fontSize:12, fontWeight:800, color:'#fca5a5' }}>{countdown(nextHigh.date) || '—'}</span>
        </div>
      )}

      {help && (
        <div style={{ background:'#000', border:'1px solid #1e3a2f', borderRadius:4, padding:10, marginBottom:10 }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
            <span style={{ fontSize:11, color:'#00d4aa', fontWeight:800 }}>COMMANDS</span>
            <button onClick={() => setHelp(false)} style={{ background:'none', border:'none', color:'#475569', cursor:'pointer', fontSize:12 }}>✕</button>
          </div>
          {COMMANDS.map(([c, d]) => (
            <div key={c} style={{ display:'flex', gap:10, fontSize:10, padding:'2px 0' }}>
              <span style={{ color:'#00d4aa', width:120, flexShrink:0 }}>{c}</span>
              <span style={{ color:'#64748b' }}>{d}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── views ── */}
      {f.view === 'ECO' ? (
        <EcoPanel instrument={ecoInst} onInstrument={setEcoInst} />
      ) : f.view === 'CAL' ? (
        <div style={{ background:'#0a0f14', border:'1px solid #151f2b', borderRadius:4 }}>
          {calEvents.length === 0 && <div style={{ padding:14, fontSize:11, color:'#475569' }}>No events match.</div>}
          {calEvents.map((ev, i) => {
            const s = impStyle(ev.impact);
            const bias = eventBias(ev);
            return (
              <div key={i} style={{ display:'flex', gap:8, padding:'5px 9px', borderBottom:'1px solid #0f1720',
                alignItems:'baseline', opacity: ev.future ? 1 : 0.5 }}>
                <span style={{ fontSize:10, color:'#334155', width:44, flexShrink:0 }}>
                  {new Date(ev.date).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                </span>
                <span style={{ color:s.dot, fontSize:10, flexShrink:0 }}>●</span>
                <span style={{ fontSize:10, fontWeight:800, color:'#00d4aa', width:30, flexShrink:0 }}>{ev.country}</span>
                <span style={{ flex:1, fontSize:11, color:'#cbd5e1', minWidth:0 }}>{ev.title}</span>
                {ev.actual ? (
                  <span style={{ fontSize:10, color: bias>0?'#22c55e':bias<0?'#ef4444':'#64748b', flexShrink:0 }}>
                    {ev.actual}<span style={{color:'#334155'}}>/{ev.forecast||'—'}</span>
                  </span>
                ) : (
                  <span style={{ fontSize:10, color:'#f59e0b', flexShrink:0 }}>{countdown(ev.date) || ''}</span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ background:'#0a0f14', border:'1px solid #151f2b', borderRadius:4 }}>
          {f.view === 'POS' && (
            <div style={{ padding:'6px 9px', borderBottom:'1px solid #151f2b', fontSize:10, color:'#475569' }}>
              {pos.length ? <>Open positions: <span style={{color:'#00d4aa'}}>{pos.join(' · ')}</span></>
                          : 'No open positions found (needs OANDA account ID in Settings).'}
            </div>
          )}
          {shownStream.length === 0 && !busy && (
            <div style={{ padding:14, fontSize:11, color:'#475569' }}>
              No headlines match. <span style={{ color:'#00d4aa' }}>CLR</span> to reset.
            </div>
          )}
          {shownStream.map((it, i) => (
            <StreamRow key={`${it.ms}_${i}`} it={it}
              onTag={inst => { setF(p => ({ ...p, instrument:inst, ccy:null })); setEcoInst(inst); }} />
          ))}
        </div>
      )}
    </div>
  );
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

  // Accumulate the event archive. The calendar feed only serves the current
  // week, so ECO reaction history has to be grown locally — every load merges
  // in new events and back-fills `actual` values once releases land.
  useEffect(() => { if (events.length) archiveEvents(events); }, [events]);

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
          { id: 'terminal', label: '▮ Terminal' },
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

      <div style={{ padding: subTab === 'terminal' ? '8px 10px' : '12px 14px' }}>

        {/* ── Terminal — dense, command-driven, merged stream ── */}
        {subTab === 'terminal' && <TerminalView events={events} />}

        {/* News Radar — hidden in terminal (it has its own header line) */}
        {subTab !== 'terminal' && <RadarStrip radar={radar} selCcy={selCcy} onSelect={setSelCcy} />}

        {/* Error */}
        {error && subTab !== 'terminal' && (
          <div style={{ padding: '10px 14px', borderRadius: 8, background: '#450a0a', color: '#fca5a5', fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && subTab !== 'terminal' && (
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

import { useState, useEffect, useCallback } from 'react';

const PAIRS = [
  { id: 'EUR_USD', label: 'EUR/USD', base: 'EUR', quote: 'USD', cotKey: 'EUR', cotInvert: false },
  { id: 'GBP_USD', label: 'GBP/USD', base: 'GBP', quote: 'USD', cotKey: 'GBP', cotInvert: false },
  { id: 'USD_JPY', label: 'USD/JPY', base: 'USD', quote: 'JPY', cotKey: 'JPY', cotInvert: true  },
  { id: 'AUD_USD', label: 'AUD/USD', base: 'AUD', quote: 'USD', cotKey: 'AUD', cotInvert: false },
  { id: 'USD_CAD', label: 'USD/CAD', base: 'USD', quote: 'CAD', cotKey: 'CAD', cotInvert: true  },
  { id: 'NZD_USD', label: 'NZD/USD', base: 'NZD', quote: 'USD', cotKey: 'NZD', cotInvert: false },
  { id: 'USD_CHF', label: 'USD/CHF', base: 'USD', quote: 'CHF', cotKey: 'CHF', cotInvert: true  },
  { id: 'XAU_USD', label: 'Gold',    base: 'XAU', quote: 'USD', cotKey: 'XAU', cotInvert: false },
  { id: 'XAG_USD', label: 'Silver',  base: 'XAG', quote: 'USD', cotKey: 'XAG', cotInvert: false },
];

const COT_CODES = {
  EUR:'099741', GBP:'096742', JPY:'097741', AUD:'232741',
  CAD:'090741', CHF:'092741', NZD:'112741', XAU:'088691', XAG:'084691',
};

const NEWS_CURRENCIES = {
  USD:'USD', EUR:'EUR', GBP:'GBP', JPY:'JPY',
  AUD:'AUD', CAD:'CAD', CHF:'CHF', NZD:'NZD', XAU:'USD', XAG:'USD',
};

const PROXY       = 'https://corsproxy.io/?';
const CALENDAR_URL = PROXY + encodeURIComponent('https://nfs.faireconomy.media/ff_calendar_thisweek.json');

const FLAGS = {
  EUR:'🇪🇺', USD:'🇺🇸', GBP:'🇬🇧', JPY:'🇯🇵',
  AUD:'🇦🇺', CAD:'🇨🇦', CHF:'🇨🇭', NZD:'🇳🇿',
  XAU:'🥇',  XAG:'🥈',
};

const CARD = {
  background: 'linear-gradient(140deg,#111f38 0%,#0c1422 100%)',
  border: '1px solid rgba(139,92,246,0.38)',
  borderRadius: 12,
  boxShadow: '0 0 20px rgba(139,92,246,0.1),0 6px 24px rgba(0,0,0,0.5)',
};

/* ── helpers ───────────────────────────────────────────────────────────────── */
function getOandaCreds() {
  try { const c = JSON.parse(localStorage.getItem('oanda_creds')||'null'); if (c?.apiKey) return c; } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}

function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const pc = candles[i-1].c;
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
  }
  return sum / period;
}

function getPipSize(id) {
  if (id==='XAU_USD') return 0.1;
  if (id==='XAG_USD') return 0.001;
  if (id.includes('JPY')) return 0.01;
  return 0.0001;
}

function getSignal(total) {
  if (total >= 3)  return { label:'STRONG LONG',  color:'#22c55e', bg:'#22c55e20' };
  if (total >= 1)  return { label:'MILD LONG',    color:'#86efac', bg:'#86efac15' };
  if (total === 0) return { label:'NEUTRAL',      color:'#8b949e', bg:'#8b949e15' };
  if (total >= -2) return { label:'MILD SHORT',   color:'#fca5a5', bg:'#fca5a515' };
  return             { label:'STRONG SHORT', color:'#f43f5e', bg:'#f43f5e20' };
}

function getScoreColor(pct) {
  if (pct >= 70) return '#22c55e';
  if (pct >= 50) return '#f59e0b';
  if (pct >= 30) return '#f97316';
  return '#f43f5e';
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning';
  if (h < 18) return 'Good Afternoon';
  return 'Good Evening';
}

function detectStructure(candles) {
  if (candles.length < 10) return 'ranging';
  const slice = candles.slice(-20);
  const first = slice[0].c, last = slice[slice.length-1].c;
  const pct = (last - first) / first * 100;
  if (pct > 0.25) return 'bullish';
  if (pct < -0.25) return 'bearish';
  return 'ranging';
}

function synthesizeH4(h1) {
  const out = [];
  for (let i = 0; i + 3 < h1.length; i += 4) {
    const g = h1.slice(i, i+4);
    out.push({ o:g[0].o, h:Math.max(...g.map(c=>c.h)), l:Math.min(...g.map(c=>c.l)), c:g[g.length-1].c });
  }
  return out;
}

function getSessionRanges(h1Candles, rawCandles) {
  // rawCandles have .time property (ISO string), h1Candles are mapped {o,h,l,c}
  if (!rawCandles || rawCandles.length < 24) return null;
  const today = new Date();
  today.setUTCHours(0,0,0,0);
  const asian   = { h:-Infinity, l:Infinity, label:'Asian',   color:'#8b5cf6', hours:'00–08 UTC' };
  const london  = { h:-Infinity, l:Infinity, label:'London',  color:'#38bdf8', hours:'07–16 UTC' };
  const ny      = { h:-Infinity, l:Infinity, label:'New York',color:'#22c55e', hours:'12–21 UTC' };

  rawCandles.forEach(rc => {
    const t = new Date(rc.time);
    const hr = t.getUTCHours();
    const daysAgo = (Date.now() - t) / 86400000;
    if (daysAgo > 2) return;
    const hi = +rc.mid.h, lo = +rc.mid.l;
    if (hr >= 0 && hr < 8)   { asian.h  = Math.max(asian.h,  hi); asian.l  = Math.min(asian.l,  lo); }
    if (hr >= 7 && hr < 16)  { london.h = Math.max(london.h, hi); london.l = Math.min(london.l, lo); }
    if (hr >= 12 && hr < 21) { ny.h     = Math.max(ny.h,     hi); ny.l     = Math.min(ny.l,     lo); }
  });

  return [asian, london, ny].map(s => ({
    ...s,
    h: s.h === -Infinity ? null : s.h,
    l: s.l === Infinity  ? null : s.l,
    range: s.h !== -Infinity && s.l !== Infinity ? s.h - s.l : null,
  }));
}

function fmtPrice(id, p) {
  if (p == null) return '—';
  if (id==='XAU_USD' || id==='XAG_USD') return p.toFixed(2);
  if (id.includes('JPY')) return p.toFixed(3);
  return p.toFixed(5);
}

function getJournalStats() {
  try {
    const trades = JSON.parse(localStorage.getItem('bot_trades')||'[]');
    if (!trades.length) return null;
    const closed = trades.filter(t => t.pnl != null);
    if (!closed.length) return null;
    const wins = closed.filter(t => t.pnl > 0).length;
    const wr   = Math.round(wins / closed.length * 100);
    const totalPnl = closed.reduce((s,t) => s+(t.pnl||0), 0);
    return { total: closed.length, wr, totalPnl };
  } catch { return null; }
}

/* ── sub-components ────────────────────────────────────────────────────────── */
function ScoreRing({ pct, color }) {
  const R = 22, C = 2 * Math.PI * R, dash = C * (pct/100);
  return (
    <svg width={54} height={54}>
      <circle cx={27} cy={27} r={R} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={4}/>
      <circle cx={27} cy={27} r={R} fill="none" stroke={color} strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${C-dash}`}
        transform="rotate(-90 27 27)"
        style={{ filter:`drop-shadow(0 0 5px ${color})` }}/>
      <text x={27} y={32} textAnchor="middle" fill={color}
        style={{ fontSize:13, fontWeight:800, fontFamily:'monospace' }}>{pct}</text>
    </svg>
  );
}

function Sparkline({ data, color }) {
  if (!data || data.length < 2) return null;
  const mn=Math.min(...data), mx=Math.max(...data), rng=mx-mn||1;
  const W=56, H=26;
  const pts = data.map((v,i)=>`${(i/(data.length-1))*W},${H-((v-mn)/rng)*H}`).join(' ');
  return (
    <svg width={W} height={H} style={{ overflow:'visible' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5}
        style={{ filter:`drop-shadow(0 0 3px ${color})` }}/>
    </svg>
  );
}

function SectionCard({ title, icon, children, accent='rgba(139,92,246,0.38)' }) {
  return (
    <div style={{ ...CARD, border:`1px solid ${accent}`, padding:14, marginBottom:12 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <span style={{ fontSize:16 }}>{icon}</span>
        <span style={{ fontSize:12, fontWeight:700, color:'#a78bfa', letterSpacing:'0.08em' }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function TFBadge({ s }) {
  if (s==='bullish') return <span style={{ fontSize:10, fontWeight:700, color:'#22c55e', background:'#22c55e18', border:'1px solid #22c55e44', borderRadius:4, padding:'2px 6px' }}>BULL</span>;
  if (s==='bearish') return <span style={{ fontSize:10, fontWeight:700, color:'#f43f5e', background:'#f43f5e18', border:'1px solid #f43f5e44', borderRadius:4, padding:'2px 6px' }}>BEAR</span>;
  return <span style={{ fontSize:10, fontWeight:700, color:'#8b949e', background:'#8b949e18', border:'1px solid #8b949e44', borderRadius:4, padding:'2px 6px' }}>RNG</span>;
}

/* ── main component ─────────────────────────────────────────────────────────── */
export default function TradeDashboard() {
  const [scores,       setScores]       = useState(null);
  const [cotData,      setCotData]      = useState({});
  const [calEvents,    setCalEvents]    = useState([]);
  const [sessionData,  setSessionData]  = useState(null);
  const [tfData,       setTfData]       = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [lastUpdated,  setLastUpdated]  = useState(null);

  const compute = useCallback(async () => {
    setLoading(true);
    const c = getOandaCreds();
    const oandaBase = c?.practice
      ? 'https://api-fxpractice.oanda.com/v3'
      : 'https://api-fxtrade.oanda.com/v3';
    const hdrs = c ? { Authorization:`Bearer ${c.apiKey}` } : {};

    /* 1 — COT */
    const cotMap = {};
    await Promise.allSettled(
      Object.entries(COT_CODES).map(async ([key,code]) => {
        try {
          const url = `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=1`;
          const res = await fetch(url,{signal:AbortSignal.timeout(15000)});
          if (!res.ok) return;
          const rows = await res.json();
          if (rows[0]) {
            cotMap[key] = (+rows[0].noncomm_positions_long_all||0)-(+rows[0].noncomm_positions_short_all||0);
          }
        } catch {}
      })
    );
    setCotData(cotMap);

    /* 2 — News calendar */
    let newsEvents = [];
    try {
      const res = await fetch(CALENDAR_URL,{signal:AbortSignal.timeout(10000)});
      if (res.ok) newsEvents = await res.json();
    } catch {}
    setCalEvents(newsEvents);
    const now=Date.now(), in24h=now+24*3600*1000;
    function hasHighNews(currency) {
      const cc=NEWS_CURRENCIES[currency]||currency;
      return newsEvents.some(e=>{
        const t=new Date(e.date).getTime();
        return e.currency===cc&&e.impact==='High'&&t>=now&&t<=in24h;
      });
    }

    /* 3 — Per-pair candle data */
    const eurusdRaw = { candles:[] };
    const tfResults = {};

    const results = await Promise.allSettled(
      PAIRS.map(async (p) => {
        const s = { cot:0, seasonality:0, strength:0, volatility:0, news:0 };
        const rawNet = cotMap[p.cotKey];
        if (rawNet !== undefined) { const net=p.cotInvert?-rawNet:rawNet; s.cot=net>0?1:-1; }
        s.news = (hasHighNews(p.base)||hasHighNews(p.quote)) ? -1 : 1;

        if (!c) return { ...p, scores:s, total:Object.values(s).reduce((a,b)=>a+b,0), sparkData:null, price:null, change:null, tfH1:'ranging', tfH4:'ranging', tfD1:'ranging' };

        const pip = getPipSize(p.id);
        let sparkData=null, price=null, change=null, tfH1='ranging', tfH4='ranging', tfD1='ranging';

        /* H1 */
        try {
          const res = await fetch(
            `${oandaBase}/instruments/${p.id}/candles?granularity=H1&count=50`,
            { headers:hdrs, signal:AbortSignal.timeout(10000) }
          );
          if (res.ok) {
            const data = await res.json();
            if (p.id==='EUR_USD') eurusdRaw.candles = data.candles||[];
            const candles = (data.candles||[]).filter(c=>c.complete).map(c=>({o:+c.mid.o,h:+c.mid.h,l:+c.mid.l,c:+c.mid.c}));
            if (candles.length>=20) {
              const pctChg=(candles[candles.length-1].c-candles[candles.length-20].o)/candles[candles.length-20].o;
              s.strength=pctChg>0?1:-1;
              const atrPips=computeATR(candles,14)/pip;
              s.volatility=atrPips>=3?1:0;
              const last20=candles.slice(-20);
              sparkData=last20.map(cc=>cc.c);
              price=last20[last20.length-1].c;
              change=((last20[last20.length-1].c-last20[0].c)/last20[0].c)*100;
              tfH1=detectStructure(candles);
              const h4=synthesizeH4(candles);
              tfH4=detectStructure(h4);
            }
          }
        } catch {}

        /* Daily */
        try {
          const res = await fetch(
            `${oandaBase}/instruments/${p.id}/candles?granularity=D&count=730`,
            { headers:hdrs, signal:AbortSignal.timeout(15000) }
          );
          if (res.ok) {
            const data=await res.json();
            const curMon=new Date().getMonth();
            const dCandles=(data.candles||[]).filter(c=>c.complete).map(c=>({o:+c.mid.o,h:+c.mid.h,l:+c.mid.l,c:+c.mid.c,time:c.time}));
            tfD1=detectStructure(dCandles);
            const returns=dCandles.filter(cc=>new Date(cc.time).getMonth()===curMon).map(cc=>(cc.c-cc.o)/cc.o);
            if (returns.length>=3) { const avg=returns.reduce((a,b)=>a+b,0)/returns.length; s.seasonality=avg>0?1:-1; }
          }
        } catch {}

        tfResults[p.id]={ H1:tfH1, H4:tfH4, D1:tfD1 };
        return { ...p, scores:s, total:Object.values(s).reduce((a,b)=>a+b,0), sparkData, price, change, tfH1, tfH4, tfD1 };
      })
    );

    const pairResults = results.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>b.total-a.total);
    setScores(pairResults);
    setTfData(tfResults);

    /* Session ranges from EUR/USD H1 */
    if (eurusdRaw.candles.length) {
      const h1 = eurusdRaw.candles.filter(c=>c.complete).map(c=>({o:+c.mid.o,h:+c.mid.h,l:+c.mid.l,c:+c.mid.c}));
      setSessionData(getSessionRanges(h1, eurusdRaw.candles.filter(c=>c.complete)));
    }

    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => { compute(); }, [compute]);

  const topPairs     = scores ? scores.filter(p=>p.total>=2).slice(0,3) : [];
  const hasOanda     = !!getOandaCreds();
  const journalStats = getJournalStats();

  /* upcoming high-impact events (next 48h) */
  const upcomingEvents = calEvents
    .filter(e => {
      const t=new Date(e.date).getTime();
      return e.impact==='High' && t>=Date.now() && t<=Date.now()+48*3600*1000;
    })
    .sort((a,b)=>new Date(a.date)-new Date(b.date))
    .slice(0,8);

  /* news sentiment per currency */
  const SENT_CURRENCIES = ['USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD'];
  const sentimentMap = {};
  SENT_CURRENCIES.forEach(cc => {
    const hasHigh = calEvents.some(e => {
      const t=new Date(e.date).getTime();
      return e.currency===cc&&e.impact==='High'&&t>=Date.now()&&t<=Date.now()+24*3600*1000;
    });
    sentimentMap[cc] = hasHigh ? 'bearish' : 'bullish';
  });

  /* COT display data */
  const COT_DISPLAY = [
    { key:'EUR', label:'EUR', flag:'🇪🇺' },
    { key:'GBP', label:'GBP', flag:'🇬🇧' },
    { key:'JPY', label:'JPY', flag:'🇯🇵', invert:true },
    { key:'AUD', label:'AUD', flag:'🇦🇺' },
    { key:'CAD', label:'CAD', flag:'🇨🇦', invert:true },
    { key:'CHF', label:'CHF', flag:'🇨🇭', invert:true },
    { key:'NZD', label:'NZD', flag:'🇳🇿' },
    { key:'XAU', label:'GOLD',flag:'🥇' },
  ];
  const maxCot = Math.max(...COT_DISPLAY.map(d=>Math.abs(cotData[d.key]||0)), 1);

  return (
    <div style={{ padding:'16px 14px', maxWidth:900, margin:'0 auto', fontFamily:'system-ui,sans-serif' }}>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:16 }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:'#e2e8f0', letterSpacing:'-0.3px' }}>
            {getGreeting()}, Trader 👋
          </div>
          <div style={{ fontSize:11, color:'#64748b', marginTop:3 }}>Live Confluence Analysis</div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {lastUpdated && <span style={{ fontSize:10, color:'#374151' }}>{lastUpdated.toLocaleTimeString()}</span>}
          <button onClick={compute} disabled={loading} style={{
            padding:'7px 14px', borderRadius:8,
            border:'1px solid rgba(139,92,246,0.5)',
            background:'rgba(139,92,246,0.15)',
            color:'#c4b5fd', fontSize:12, fontWeight:600,
            cursor:loading?'not-allowed':'pointer', opacity:loading?0.6:1,
          }}>
            {loading ? '⟳ …' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* ── No OANDA ─────────────────────────────────────────────────────── */}
      {!hasOanda && (
        <div style={{ ...CARD, border:'1px solid rgba(245,158,11,0.45)', padding:'10px 14px', marginBottom:12,
          color:'#fbbf24', fontSize:12, display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:16 }}>⚠️</span>
          No OANDA API key — price, strength &amp; volatility unavailable. Add in Auto Trading → Broker.
        </div>
      )}

      {/* ── AI Alert ─────────────────────────────────────────────────────── */}
      {scores && topPairs.length > 0 && (
        <div style={{ ...CARD, borderLeft:'3px solid #8b5cf6', padding:'12px 14px', marginBottom:12,
          display:'flex', alignItems:'flex-start', gap:10 }}>
          <span style={{ fontSize:20, lineHeight:1, marginTop:2 }}>🤖</span>
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:'#a78bfa', letterSpacing:'0.08em', marginBottom:4 }}>AI ALERT</div>
            <div style={{ fontSize:12, color:'#cbd5e1', lineHeight:1.6 }}>
              Found <strong style={{ color:'#e2e8f0' }}>{topPairs.length}</strong> high-probability setup{topPairs.length>1?'s':''}. {' '}
              {topPairs.map((p,i) => {
                const sig=getSignal(p.total);
                return (
                  <span key={p.id}>
                    <strong style={{ color:'#e2e8f0' }}>{p.label}</strong>{' '}
                    showing <span style={{ color:sig.color, fontWeight:700 }}>{sig.label}</span>
                    {i<topPairs.length-1?' · ':''}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Loading ───────────────────────────────────────────────────────── */}
      {loading && !scores && (
        <div style={{ ...CARD, padding:'48px 20px', textAlign:'center', color:'#64748b', marginBottom:12 }}>
          <div style={{ fontSize:28, marginBottom:10 }}>⟳</div>
          <div style={{ fontSize:13, color:'#94a3b8' }}>Loading confluence data…</div>
          <div style={{ fontSize:10, marginTop:4 }}>COT · Prices · News · Sessions</div>
        </div>
      )}

      {/* ── Pair Cards — compact 2-col ────────────────────────────────────── */}
      {scores && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))', gap:10, marginBottom:14 }}>
          {scores.map(p => {
            const pct       = Math.round((p.total+5)/10*100);
            const color     = getScoreColor(pct);
            const sig       = getSignal(p.total);
            const changePos = p.change != null ? p.change >= 0 : null;
            const sparkCol  = changePos===false ? '#f43f5e' : '#22c55e';
            return (
              <div key={p.id} style={{ ...CARD, padding:'9px 11px' }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                  {/* Left */}
                  <div style={{ flex:1, minWidth:0 }}>
                    {/* Row 1: flags + name + price + change */}
                    <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:4 }}>
                      <span style={{ fontSize:14 }}>{FLAGS[p.base]||'🏳️'}</span>
                      <span style={{ fontSize:14 }}>{FLAGS[p.quote]||'🏳️'}</span>
                      <span style={{ fontSize:12, fontWeight:800, color:'#e2e8f0' }}>{p.label}</span>
                      {p.change!=null && (
                        <span style={{ fontSize:10, fontWeight:600, color:changePos?'#22c55e':'#f43f5e', marginLeft:'auto' }}>
                          {p.change>=0?'+':''}{p.change.toFixed(2)}%
                        </span>
                      )}
                    </div>
                    {/* Row 2: price + sparkline + signal badge */}
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontFamily:'monospace', fontSize:12, fontWeight:700, color:'#e2e8f0' }}>
                        {fmtPrice(p.id, p.price)}
                      </span>
                      <Sparkline data={p.sparkData} color={sparkCol}/>
                      <span style={{ fontSize:8, fontWeight:700, padding:'2px 6px', borderRadius:3,
                        color:sig.color, background:sig.bg, border:`1px solid ${sig.color}44`,
                        letterSpacing:'0.05em', whiteSpace:'nowrap', marginLeft:'auto' }}>
                        {sig.label}
                      </span>
                    </div>
                  </div>
                  {/* Score ring */}
                  <div style={{ flexShrink:0 }}>
                    <ScoreRing pct={pct} color={color}/>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ══ MARKET INTELLIGENCE ════════════════════════════════════════════ */}
      <div style={{ fontSize:10, fontWeight:700, color:'#4b5563', letterSpacing:'0.12em',
        textTransform:'uppercase', marginBottom:10, paddingLeft:2 }}>
        ── MARKET INTELLIGENCE ──
      </div>

      {/* ── Liquidity Sentinel ───────────────────────────────────────────── */}
      <SectionCard title="LIQUIDITY SENTINEL" icon="💧" accent="rgba(56,189,248,0.4)">
        {sessionData ? (
          <div>
            <div style={{ fontSize:10, color:'#64748b', marginBottom:10 }}>EUR/USD session ranges (last 2 days)</div>
            {sessionData.map(s => {
              const pipRange = s.range ? (s.range / 0.0001).toFixed(1) : null;
              const barPct   = s.range ? Math.min(100, (s.range / 0.003) * 100) : 0;
              return (
                <div key={s.label} style={{ marginBottom:10 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                    <span style={{ fontSize:11, fontWeight:600, color:s.color }}>{s.label}</span>
                    <span style={{ fontSize:10, color:'#64748b' }}>{s.hours}</span>
                    <span style={{ fontSize:11, fontFamily:'monospace', color:'#e2e8f0' }}>
                      {pipRange ? `${pipRange} pips` : '—'}
                    </span>
                  </div>
                  {/* Range bar */}
                  <div style={{ height:6, background:'rgba(255,255,255,0.05)', borderRadius:3, overflow:'hidden' }}>
                    <div style={{ height:'100%', width:`${barPct}%`, background:s.color,
                      borderRadius:3, boxShadow:`0 0 8px ${s.color}88`, transition:'width 0.6s' }}/>
                  </div>
                  {s.h!=null && (
                    <div style={{ display:'flex', justifyContent:'space-between', marginTop:3 }}>
                      <span style={{ fontSize:9, color:'#64748b' }}>L {s.l.toFixed(5)}</span>
                      <span style={{ fontSize:9, color:'#64748b' }}>H {s.h.toFixed(5)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ color:'#4b5563', fontSize:12, textAlign:'center', padding:'16px 0' }}>
            {hasOanda ? 'Loading session data…' : 'Requires OANDA API key'}
          </div>
        )}
      </SectionCard>

      {/* ── Timeframe Analysis ───────────────────────────────────────────── */}
      {scores && tfData && (
        <SectionCard title="TIMEFRAME ANALYSIS" icon="📊" accent="rgba(139,92,246,0.45)">
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
              <thead>
                <tr>
                  {['PAIR','H1','H4','D1'].map(h => (
                    <th key={h} style={{ padding:'4px 8px', textAlign:h==='PAIR'?'left':'center',
                      color:'#4b5563', fontSize:9, fontWeight:700, letterSpacing:'0.08em',
                      borderBottom:'1px solid rgba(139,92,246,0.2)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scores.slice(0,7).map(p => {
                  const tf = tfData[p.id]||{};
                  return (
                    <tr key={p.id} style={{ borderBottom:'1px solid rgba(139,92,246,0.08)' }}>
                      <td style={{ padding:'6px 8px', fontWeight:700, color:'#e2e8f0', whiteSpace:'nowrap' }}>
                        {FLAGS[p.base]}{FLAGS[p.quote]} {p.label}
                      </td>
                      {['H1','H4','D1'].map(tf_key => (
                        <td key={tf_key} style={{ padding:'6px 8px', textAlign:'center' }}>
                          <TFBadge s={tf[tf_key]||'ranging'}/>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize:9, color:'#374151', marginTop:8, paddingTop:6,
            borderTop:'1px solid rgba(139,92,246,0.1)' }}>
            Structure from 20-bar trend · H4 synthesized from H1 candles
          </div>
        </SectionCard>
      )}

      {/* ── Economic Calendar + News Sentiment ───────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:12 }}>

        {/* Calendar */}
        <div style={{ ...CARD, border:'1px solid rgba(245,158,11,0.4)', padding:14 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
            <span style={{ fontSize:16 }}>📅</span>
            <span style={{ fontSize:12, fontWeight:700, color:'#fbbf24', letterSpacing:'0.08em' }}>ECONOMIC CALENDAR</span>
          </div>
          {upcomingEvents.length ? (
            upcomingEvents.map((e,i) => {
              const t=new Date(e.date);
              return (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7,
                  padding:'5px 8px', background:'rgba(245,158,11,0.06)',
                  borderRadius:6, border:'1px solid rgba(245,158,11,0.12)' }}>
                  <span style={{ fontSize:9, color:'#f59e0b', fontFamily:'monospace', whiteSpace:'nowrap' }}>
                    {t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
                  </span>
                  <span style={{ fontSize:10, fontWeight:700, color:'#fbbf24',
                    background:'rgba(245,158,11,0.15)', borderRadius:3, padding:'1px 5px' }}>
                    {e.currency}
                  </span>
                  <span style={{ fontSize:10, color:'#94a3b8', flex:1, overflow:'hidden',
                    textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.title}</span>
                  <span style={{ fontSize:9, color:'#ef4444', fontWeight:700 }}>HIGH</span>
                </div>
              );
            })
          ) : (
            <div style={{ fontSize:11, color:'#374151', textAlign:'center', padding:'12px 0' }}>
              {calEvents.length ? '✅ No high-impact events next 48h' : 'Loading calendar…'}
            </div>
          )}
        </div>

        {/* News Sentiment */}
        <div style={{ ...CARD, border:'1px solid rgba(56,189,248,0.35)', padding:14 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
            <span style={{ fontSize:16 }}>📰</span>
            <span style={{ fontSize:12, fontWeight:700, color:'#38bdf8', letterSpacing:'0.08em' }}>NEWS SENTIMENT</span>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
            {SENT_CURRENCIES.map(cc => {
              const bull = sentimentMap[cc]==='bullish';
              return (
                <div key={cc} style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                  padding:'5px 8px', borderRadius:6,
                  background: bull?'rgba(34,197,94,0.07)':'rgba(244,63,94,0.07)',
                  border:`1px solid ${bull?'rgba(34,197,94,0.25)':'rgba(244,63,94,0.25)'}` }}>
                  <span style={{ fontSize:11, fontWeight:700, color:'#e2e8f0' }}>{cc}</span>
                  <span style={{ fontSize:13 }}>{bull ? '🟢' : '🔴'}</span>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize:9, color:'#374151', marginTop:8, lineHeight:1.5 }}>
            🟢 = No high-impact news next 24h · 🔴 = High-impact event upcoming
          </div>
        </div>
      </div>

      {/* ── Smart Money Flow (COT) ───────────────────────────────────────── */}
      <SectionCard title="SMART MONEY FLOW  (COT Positioning)" icon="🏦" accent="rgba(34,197,94,0.4)">
        {Object.keys(cotData).length ? (
          <div>
            {COT_DISPLAY.map(d => {
              let net = cotData[d.key];
              if (net == null) return null;
              if (d.invert) net = -net;
              const bull  = net >= 0;
              const barW  = Math.round(Math.abs(net)/maxCot*100);
              const color = bull ? '#22c55e' : '#f43f5e';
              const kStr  = net >= 0 ? `+${(net/1000).toFixed(1)}K` : `${(net/1000).toFixed(1)}K`;
              return (
                <div key={d.key} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                  <span style={{ width:26, textAlign:'center', fontSize:14 }}>{d.flag}</span>
                  <span style={{ width:32, fontSize:11, fontWeight:700, color:'#94a3b8' }}>{d.label}</span>
                  <div style={{ flex:1, height:6, background:'rgba(255,255,255,0.05)', borderRadius:3, overflow:'hidden' }}>
                    <div style={{ height:'100%', width:`${barW}%`, background:color,
                      borderRadius:3, boxShadow:`0 0 8px ${color}88`, transition:'width 0.6s',
                      marginLeft: bull ? 0 : 'auto' }}/>
                  </div>
                  <span style={{ width:52, textAlign:'right', fontSize:11, fontFamily:'monospace',
                    fontWeight:700, color }}>
                    {kStr}
                  </span>
                </div>
              );
            })}
            <div style={{ fontSize:9, color:'#374151', marginTop:6, paddingTop:6,
              borderTop:'1px solid rgba(34,197,94,0.1)' }}>
              Non-commercial (speculative) net contracts from CFTC COT report
            </div>
          </div>
        ) : (
          <div style={{ color:'#4b5563', fontSize:12, textAlign:'center', padding:'16px 0' }}>Loading COT data…</div>
        )}
      </SectionCard>

      {/* ── Trader Journal ───────────────────────────────────────────────── */}
      <SectionCard title="TRADER JOURNAL STATS" icon="📓" accent="rgba(139,92,246,0.38)">
        {journalStats ? (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
            {[
              { label:'Win Rate', value:`${journalStats.wr}%`, color: journalStats.wr>=50?'#22c55e':'#f43f5e' },
              { label:'Total Trades', value:journalStats.total, color:'#a78bfa' },
              { label:'Total P&L', value:`$${journalStats.totalPnl.toFixed(2)}`, color:journalStats.totalPnl>=0?'#22c55e':'#f43f5e' },
            ].map(s => (
              <div key={s.label} style={{ textAlign:'center', padding:'10px 8px',
                background:'rgba(139,92,246,0.06)', borderRadius:8,
                border:'1px solid rgba(139,92,246,0.15)' }}>
                <div style={{ fontSize:20, fontWeight:800, color:s.color, fontFamily:'monospace' }}>{s.value}</div>
                <div style={{ fontSize:9, color:'#64748b', marginTop:4, textTransform:'uppercase', letterSpacing:'0.06em' }}>{s.label}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ textAlign:'center', padding:'10px 0', color:'#374151', fontSize:12 }}>
            <div style={{ fontSize:24, marginBottom:8 }}>📊</div>
            No trade history yet — trades from the Auto Trading bot will appear here.
          </div>
        )}
      </SectionCard>

      {/* ── Legend ───────────────────────────────────────────────────────── */}
      <div style={{ ...CARD, border:'1px solid rgba(139,92,246,0.3)', padding:'12px 14px' }}>
        <div style={{ fontSize:10, fontWeight:700, color:'#a78bfa', letterSpacing:'0.08em', marginBottom:8 }}>
          HOW TO READ SCORES
        </div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:'6px 20px', fontSize:11 }}>
          {[
            { label:'70–100 · Strong Long',   color:'#22c55e' },
            { label:'50–69 · Mild / Caution', color:'#f59e0b' },
            { label:'30–49 · Weak',            color:'#f97316' },
            { label:'0–29 · Strong Short',     color:'#f43f5e' },
          ].map(i => (
            <span key={i.label} style={{ color:i.color, fontWeight:600 }}>
              <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%',
                background:i.color, marginRight:5, verticalAlign:'middle',
                boxShadow:`0 0 5px ${i.color}` }}/>
              {i.label}
            </span>
          ))}
        </div>
      </div>

    </div>
  );
}

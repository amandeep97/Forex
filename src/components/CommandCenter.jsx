import { useState, useEffect, useCallback } from 'react';

const PAIRS = [
  'EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','USD_CAD','NZD_USD',
  'EUR_GBP','EUR_JPY','GBP_JPY','AUD_JPY','EUR_AUD','GBP_AUD','EUR_CAD',
  'GBP_CAD','AUD_CAD','EUR_NZD','GBP_NZD','NZD_JPY','AUD_NZD','CAD_JPY',
];

// CFTC legacy COT contract codes
const COT_CODES = {
  EUR:'099741', GBP:'096742', JPY:'097741',
  CHF:'092741', AUD:'232741', NZD:'112741', CAD:'090741',
};

const KZ = [
  { name:'Asian',  start:0,  end:3  },
  { name:'London', start:7,  end:10 },
  { name:'NY AM',  start:12, end:15 },
  { name:'NY PM',  start:17, end:19 },
];

const W = { tech:0.30, dxy:0.20, cot:0.20, str:0.15, time:0.15 };

function sma(arr, n) {
  if (!arr.length) return 0;
  const slice = arr.slice(-Math.min(n, arr.length));
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function midClose(c) {
  return parseFloat(c.mid?.c ?? c.c ?? 0);
}

function techScore(h4, h1) {
  if (!h4 || h4.length < 5) return 0;
  const c4 = h4.map(midClose);
  const last = c4[c4.length - 1];
  const ma20 = sma(c4, 20);
  const prev5 = c4[Math.max(0, c4.length - 6)];

  let s = 0;
  s += last > ma20 ? 0.40 : -0.40;
  s += last > prev5 ? 0.30 : -0.30;

  if (h1 && h1.length >= 5) {
    const c1 = h1.map(midClose);
    const last1 = c1[c1.length - 1];
    const ma10 = sma(c1, 10);
    s += last1 > ma10 ? 0.15 : -0.15;
    s += c1[c1.length - 1] > c1[c1.length - 4] ? 0.15 : -0.15;
  }

  return Math.max(-1, Math.min(1, s));
}

function timingScore() {
  const now = new Date();
  const h = now.getUTCHours();
  const dow = now.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return -1;

  let s = 0;
  if (dow >= 2 && dow <= 4) s += 0.50;
  else if (dow === 5) s -= 0.20;

  const inKZ = KZ.some(kz => h >= kz.start && h < kz.end);
  s += inKZ ? 0.50 : 0;

  return Math.max(-1, Math.min(1, s));
}

function currKZ() {
  const h = new Date().getUTCHours();
  return KZ.find(kz => h >= kz.start && h < kz.end)?.name ?? null;
}

function computeStrengths(h4Map) {
  const acc = {};
  const cnt = {};
  for (const pair of PAIRS) {
    const c = h4Map[pair];
    if (!c || c.length < 2) continue;
    const closes = c.map(midClose);
    if (!closes[0]) continue;
    const pct = (closes[closes.length - 1] - closes[0]) / closes[0];
    const [base, quote] = pair.split('_');
    acc[base] = (acc[base] ?? 0) + pct; cnt[base] = (cnt[base] ?? 0) + 1;
    acc[quote] = (acc[quote] ?? 0) - pct; cnt[quote] = (cnt[quote] ?? 0) + 1;
  }
  const avg = Object.fromEntries(Object.keys(acc).map(k => [k, acc[k] / cnt[k]]));
  const max = Math.max(...Object.values(avg).map(Math.abs), 1e-8);
  return Object.fromEntries(Object.entries(avg).map(([k, v]) => [k, v / max]));
}

const gradeOf = conf =>
  conf >= 70 ? 'A+' : conf >= 55 ? 'A' : conf >= 40 ? 'B+' : conf >= 25 ? 'B' : 'C';
const gradeColor = g =>
  g === 'A+' ? '#22c55e' : g === 'A' ? '#86efac' : g === 'B+' ? '#fbbf24' : '#94a3b8';

const FACTORS = [
  { key:'tech',  label:'Tech',  color:'#818cf8' },
  { key:'dxy',   label:'DXY',   color:'#60a5fa' },
  { key:'cot',   label:'COT',   color:'#f472b6' },
  { key:'str',   label:'Str',   color:'#34d399' },
  { key:'time',  label:'Time',  color:'#fbbf24' },
];

// Top 5 crypto — Binance public API (free, no key needed)
const CRYPTO_PAIRS = [
  { key:'BTC',  label:'BTC/USDT', symbol:'BTCUSDT'  },
  { key:'ETH',  label:'ETH/USDT', symbol:'ETHUSDT'  },
  { key:'SOL',  label:'SOL/USDT', symbol:'SOLUSDT'  },
  { key:'XRP',  label:'XRP/USDT', symbol:'XRPUSDT'  },
  { key:'BNB',  label:'BNB/USDT', symbol:'BNBUSDT'  },
];

// Binance public candle API — no key, free, browser-safe
async function binanceFetch(symbol, interval, limit) {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    // Exclude last candle (still forming). Format: [openTime,o,h,l,close,...]
    return data.slice(0, -1).map(k => ({ c: parseFloat(k[4]) }));
  } catch { return []; }
}

// No COT for crypto. DXY = primary macro driver (strong USD = bearish crypto).
const CRYPTO_W = { tech:0.45, dxy:0.30, time:0.25 };
const CRYPTO_FACTORS = [
  { key:'tech', label:'Tech', color:'#818cf8' },
  { key:'dxy',  label:'DXY',  color:'#60a5fa' },
  { key:'time', label:'Time', color:'#fbbf24' },
];

export default function CommandCenter() {
  const [creds, setCreds] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [results, setResults] = useState([]);
  const [cryptoResults, setCryptoResults] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [cotAvail, setCotAvail] = useState(false);
  const [filter, setFilter] = useState('all');
  const [newsRadar, setNewsRadar] = useState(null);

  useEffect(() => {
    try {
      const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
      if (c?.apiKey) { setCreds(c); return; }
    } catch {}
    const apiKey = localStorage.getItem('oanda_key');
    const practice = localStorage.getItem('oanda_env') !== 'live';
    if (apiKey) setCreds({ apiKey, practice });
  }, []);

  // Read News Radar (written by the News tab) to flag pairs with imminent events
  useEffect(() => {
    const read = () => {
      try {
        const r = JSON.parse(localStorage.getItem('news_radar') || 'null');
        if (r?.currencies) setNewsRadar(r.currencies);
      } catch {}
    };
    read();
    const id = setInterval(read, 60000);
    return () => clearInterval(id);
  }, []);

  // For a pair, return the soonest high-impact event warning across its 2 currencies
  const newsWarn = useCallback((pair) => {
    if (!newsRadar) return null;
    const [base, quote] = pair.split('_');
    let best = null;
    [base, quote].forEach(c => {
      const r = newsRadar[c];
      if (!r?.nextMs) return;
      const mins = Math.round((r.nextMs - Date.now()) / 60000);
      if (mins < 0 || mins > 1440) return; // only within 24h
      if (r.impact !== 'High') return;
      if (!best || mins < best.mins) best = { ccy: c, mins, title: r.nextTitle };
    });
    return best;
  }, [newsRadar]);

  const oandaFetch = useCallback(async (pair, tf, count) => {
    if (!creds) return [];
    const base = creds.practice === false || creds.env === 'live'
      ? 'https://api-fxtrade.oanda.com/v3'
      : 'https://api-fxpractice.oanda.com/v3';
    try {
      const res = await fetch(
        `${base}/instruments/${pair}/candles?granularity=${tf}&count=${count}&price=M`,
        { headers: { Authorization: `Bearer ${creds.apiKey}` } }
      );
      if (!res.ok) return [];
      const d = await res.json();
      return (d.candles ?? []).filter(c => c.complete);
    } catch { return []; }
  }, [creds]);

  const fetchCOT = useCallback(async () => {
    const cot = {};
    for (const [cur, code] of Object.entries(COT_CODES)) {
      try {
        const r = await fetch(
          `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=cftc_contract_market_code='${code}'&$order=report_date_as_yyyy_mm_dd DESC&$limit=1`
        );
        if (!r.ok) continue;
        const [d] = await r.json();
        if (!d) continue;
        const lng = parseFloat(d.noncomm_positions_long_all ?? 0);
        const sht = parseFloat(d.noncomm_positions_short_all ?? 0);
        const tot = lng + sht;
        cot[cur] = tot ? (lng - sht) / tot : 0;
      } catch {}
    }
    return cot;
  }, []);

  const analyze = useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    setError(null);
    setProgress(0);

    try {
      let done = 0;
      const total = PAIRS.length * 2;
      const tick = () => setProgress(Math.round((++done / total) * 80));

      const [h4Entries, h1Entries] = await Promise.all([
        Promise.all(PAIRS.map(p => oandaFetch(p, 'H4', 60).then(c => { tick(); return [p, c]; }))),
        Promise.all(PAIRS.map(p => oandaFetch(p, 'H1', 40).then(c => { tick(); return [p, c]; }))),
      ]);

      const h4 = Object.fromEntries(h4Entries);
      const h1 = Object.fromEntries(h1Entries);
      setProgress(85);

      const strengths = computeStrengths(h4);
      // EUR/USD H4 direction inverted = DXY proxy
      const dxyProxy = -(techScore(h4['EUR_USD'], h1['EUR_USD']));
      const timing = timingScore();
      const kzName = currKZ();

      const cot = await fetchCOT();
      const hasCot = Object.keys(cot).length > 0;
      setCotAvail(hasCot);
      setProgress(95);

      const scored = PAIRS.map(pair => {
        const [base, quote] = pair.split('_');
        const tech = techScore(h4[pair], h1[pair]);

        // DXY influence: strong USD → USD/XXX rises, XXX/USD falls
        let dxy = 0;
        if (quote === 'USD') dxy = -dxyProxy;    // e.g. EUR/USD falls when DXY rises
        else if (base === 'USD') dxy = dxyProxy;  // e.g. USD/JPY rises when DXY rises
        else dxy = dxyProxy * 0.20;               // cross pairs: minor indirect influence

        const cotScore = (cot[base] ?? 0) - (cot[quote] ?? 0);
        const strScore = (strengths[base] ?? 0) - (strengths[quote] ?? 0);

        const composite =
          tech    * W.tech  +
          dxy     * W.dxy   +
          cotScore * W.cot  +
          strScore * W.str  +
          timing  * W.time;

        return {
          pair,
          direction: composite >= 0 ? 'LONG' : 'SHORT',
          confidence: Math.round(Math.min(Math.abs(composite) * 100, 100)),
          composite,
          tech, dxy, cot: cotScore, str: strScore, time: timing,
          kzName,
        };
      });

      scored.sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite));
      setResults(scored);

      // ── Crypto: Binance public API (no OANDA key needed) ─────────────────
      const [cryptoH4, cryptoH1] = await Promise.all([
        Promise.all(CRYPTO_PAIRS.map(p => binanceFetch(p.symbol, '4h', 61).then(c => [p.key, c]))),
        Promise.all(CRYPTO_PAIRS.map(p => binanceFetch(p.symbol, '1h', 41).then(c => [p.key, c]))),
      ]);
      const ch4 = Object.fromEntries(cryptoH4);
      const ch1 = Object.fromEntries(cryptoH1);

      const cryptoScored = CRYPTO_PAIRS
        .filter(p => ch4[p.key]?.length > 0)
        .map(({ key, label }) => {
          const tech = techScore(ch4[key], ch1[key]);
          const dxy  = -dxyProxy; // strong USD always bearish for crypto
          const composite = tech * CRYPTO_W.tech + dxy * CRYPTO_W.dxy + timing * CRYPTO_W.time;
          return {
            pair: key, label,
            direction: composite >= 0 ? 'LONG' : 'SHORT',
            confidence: Math.round(Math.min(Math.abs(composite) * 100, 100)),
            composite, tech, dxy, time: timing, kzName,
          };
        });
      cryptoScored.sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite));
      setCryptoResults(cryptoScored);

      setLastUpdate(new Date());
      setProgress(100);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [creds, oandaFetch, fetchCOT]);

  // Auto-run on first load if creds exist
  useEffect(() => { if (creds) analyze(); }, [creds]); // eslint-disable-line

  const filtered = filter === 'all' ? results : results.filter(r => r.direction === filter.toUpperCase());

  if (!creds) {
    return (
      <div style={{ padding:40, textAlign:'center', color:'#94a3b8', background:'#0a0f1e', minHeight:'100vh' }}>
        <div style={{ fontSize:40, marginBottom:12 }}>🔑</div>
        <div style={{ fontSize:15, marginBottom:6 }}>Connect your OANDA account first</div>
        <div style={{ fontSize:12 }}>Enter API credentials in the Screener tab</div>
      </div>
    );
  }

  return (
    <div style={{ padding:16, fontFamily:'monospace', background:'#0a0f1e', minHeight:'100vh' }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10, flexWrap:'wrap', gap:8 }}>
        <div>
          <div style={{ fontSize:17, fontWeight:700, color:'#e2e8f0', letterSpacing:0.5 }}>
            ⚡ Command Center
          </div>
          <div style={{ fontSize:11, color:'#475569', marginTop:2 }}>
            5-factor FX · 3-factor Crypto · 21+5 instruments ranked
            {!cotAvail && results.length > 0 && (
              <span style={{ color:'#d97706', marginLeft:6 }}>· COT N/A</span>
            )}
          </div>
        </div>
        <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
          {['all','long','short'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding:'3px 9px', borderRadius:5, fontSize:11, border:'none', cursor:'pointer',
              background: filter === f ? (f==='long'?'#14532d':f==='short'?'#7f1d1d':'#312e81') : '#1e293b',
              color: filter === f ? '#fff' : '#64748b',
            }}>
              {f.toUpperCase()}
            </button>
          ))}
          <button onClick={analyze} disabled={loading} style={{
            padding:'5px 14px', background:'#7c3aed', color:'#fff', border:'none',
            borderRadius:7, cursor:loading ? 'not-allowed' : 'pointer', fontSize:12,
            fontWeight:600, opacity:loading ? 0.7 : 1, minWidth:90,
          }}>
            {loading ? `${progress}%…` : '⟳ Refresh'}
          </button>
        </div>
      </div>

      {/* Factor weight pills */}
      <div style={{ display:'flex', gap:6, marginBottom:10, flexWrap:'wrap' }}>
        {[['Tech','30%','#818cf8'],['DXY','20%','#60a5fa'],['COT','20%','#f472b6'],['Str','15%','#34d399'],['Time','15%','#fbbf24']].map(([k,w,c]) => (
          <div key={k} style={{ display:'flex', alignItems:'center', gap:4, background:'#0f172a', border:`1px solid ${c}33`, padding:'2px 8px', borderRadius:20, fontSize:10 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:c }} />
            <span style={{ color:'#94a3b8' }}>{k}</span>
            <span style={{ color:c, fontWeight:700 }}>{w}</span>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      {loading && (
        <div style={{ height:3, background:'#1e293b', borderRadius:2, marginBottom:10, overflow:'hidden' }}>
          <div style={{ width:`${progress}%`, height:'100%', background:'linear-gradient(90deg,#7c3aed,#a78bfa)', transition:'width 0.3s' }} />
        </div>
      )}

      {error && (
        <div style={{ background:'#450a0a', border:'1px solid #7f1d1d', borderRadius:8, padding:10, color:'#fca5a5', fontSize:12, marginBottom:12 }}>
          ⚠ {error}
        </div>
      )}

      {!loading && results.length === 0 && (
        <div style={{ textAlign:'center', padding:60, color:'#475569' }}>
          <div style={{ fontSize:32, marginBottom:10 }}>📡</div>
          <div style={{ fontSize:14, marginBottom:4 }}>Click <strong style={{ color:'#a78bfa' }}>Refresh</strong> to analyze all 21 pairs</div>
          <div style={{ fontSize:11 }}>Fetches H4+H1 candles from OANDA · COT data from CFTC</div>
        </div>
      )}

      {/* Pair cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(265px, 1fr))', gap:10 }}>
        {filtered.map((r, idx) => {
          const bull = r.direction === 'LONG';
          const grade = gradeOf(r.confidence);
          const gc = gradeColor(grade);

          return (
            <div key={r.pair} style={{
              background:'#0f172a',
              borderRadius:10,
              padding:12,
              border:`1px solid ${bull ? '#14532d' : '#7f1d1d'}`,
              position:'relative',
            }}>
              <span style={{ position:'absolute', top:8, right:10, fontSize:9, color:'#334155' }}>#{idx+1}</span>

              {/* Pair header */}
              <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:8, flexWrap:'wrap' }}>
                <span style={{ fontSize:13, fontWeight:700, color:'#e2e8f0', letterSpacing:1 }}>
                  {r.pair.replace('_', '/')}
                </span>
                <span style={{
                  background: bull ? '#14532d' : '#450a0a',
                  color: bull ? '#86efac' : '#fca5a5',
                  padding:'1px 6px', borderRadius:4, fontSize:10, fontWeight:700,
                }}>
                  {r.direction}
                </span>
                <span style={{ color:gc, fontSize:11, fontWeight:700 }}>{grade}</span>
                {r.kzName && (
                  <span style={{ background:'#1e1b4b', color:'#818cf8', padding:'1px 5px', borderRadius:3, fontSize:9 }}>
                    {r.kzName} KZ
                  </span>
                )}
              </div>

              {/* News risk warning — imminent high-impact event for this pair */}
              {(() => {
                const w = newsWarn(r.pair);
                if (!w) return null;
                const cd = w.mins < 1 ? 'NOW' : w.mins < 60 ? `${w.mins}m` : `${Math.floor(w.mins/60)}h ${w.mins%60}m`;
                const hot = w.mins <= 60;
                return (
                  <div title={w.title} style={{
                    display:'flex', alignItems:'center', gap:5, marginBottom:8,
                    padding:'4px 7px', borderRadius:5, fontSize:9.5, fontWeight:700,
                    background: hot ? '#450a0a' : '#1f1300',
                    color: hot ? '#fca5a5' : '#fbbf24',
                    border:`1px solid ${hot ? '#7f1d1d' : '#78350f'}`,
                  }}>
                    ⚠ {w.ccy} high-impact news in {cd}
                  </div>
                );
              })()}

              {/* Confidence bar */}
              <div style={{ marginBottom:8 }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'#475569', marginBottom:3 }}>
                  <span>Confidence</span>
                  <span style={{ color: bull ? '#22c55e' : '#ef4444', fontWeight:700 }}>{r.confidence}%</span>
                </div>
                <div style={{ height:5, background:'#1e293b', borderRadius:3, overflow:'hidden' }}>
                  <div style={{
                    width:`${r.confidence}%`, height:'100%',
                    background: bull
                      ? 'linear-gradient(90deg,#16a34a,#22c55e)'
                      : 'linear-gradient(90deg,#b91c1c,#ef4444)',
                    transition:'width 0.5s ease',
                  }}/>
                </div>
              </div>

              {/* Factor bars */}
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {FACTORS.map(({ key, label, color }) => {
                  const val = r[key] ?? 0;
                  const pctLeft = val >= 0 ? 50 : 50 + val * 50;
                  const pctWidth = Math.abs(val) * 50;
                  return (
                    <div key={key} style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <span style={{ fontSize:9, color:'#475569', width:26, textAlign:'right', flexShrink:0 }}>
                        {label}
                      </span>
                      <div style={{ flex:1, height:4, background:'#1e293b', borderRadius:2, position:'relative', overflow:'hidden' }}>
                        <div style={{ position:'absolute', left:'50%', top:0, width:1, height:'100%', background:'#334155' }}/>
                        <div style={{
                          position:'absolute',
                          left:`${pctLeft}%`,
                          width:`${pctWidth}%`,
                          height:'100%',
                          background: val >= 0 ? color : '#ef4444',
                          opacity:0.9,
                        }}/>
                      </div>
                      <span style={{ fontSize:9, color, width:32, textAlign:'right', flexShrink:0 }}>
                        {val >= 0 ? '+' : ''}{val.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && results.length > 0 && (
        <div style={{ textAlign:'center', padding:40, color:'#475569' }}>No pairs match the selected filter.</div>
      )}

      {/* ── Crypto Section ─────────────────────────────────────────────────── */}
      {cryptoResults.length > 0 && (
        <div style={{ marginTop:20 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
            <div style={{ fontSize:13, fontWeight:700, color:'#e2e8f0' }}>₿ Crypto</div>
            <div style={{ fontSize:10, color:'#475569' }}>Tech · DXY · Timing — no COT</div>
            <div style={{ flex:1, height:1, background:'#1e293b', marginLeft:4 }} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(265px, 1fr))', gap:10 }}>
            {cryptoResults
              .filter(r => filter === 'all' || r.direction === filter.toUpperCase())
              .map((r, idx) => {
                const bull = r.direction === 'LONG';
                const grade = gradeOf(r.confidence);
                const gc = gradeColor(grade);
                return (
                  <div key={r.pair} style={{
                    background:'#0f172a', borderRadius:10, padding:12,
                    border:`1px solid ${bull ? '#1c3a2a' : '#3a1c1c'}`,
                    position:'relative',
                  }}>
                    <span style={{ position:'absolute', top:8, right:10, fontSize:9, color:'#334155' }}>#{idx+1}</span>

                    <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:8, flexWrap:'wrap' }}>
                      <span style={{ fontSize:13, fontWeight:700, color:'#f59e0b', letterSpacing:1 }}>
                        {r.label}
                      </span>
                      <span style={{
                        background: bull ? '#14532d' : '#450a0a',
                        color: bull ? '#86efac' : '#fca5a5',
                        padding:'1px 6px', borderRadius:4, fontSize:10, fontWeight:700,
                      }}>
                        {r.direction}
                      </span>
                      <span style={{ color:gc, fontSize:11, fontWeight:700 }}>{grade}</span>
                      {r.kzName && (
                        <span style={{ background:'#1e1b4b', color:'#818cf8', padding:'1px 5px', borderRadius:3, fontSize:9 }}>
                          {r.kzName} KZ
                        </span>
                      )}
                    </div>

                    <div style={{ marginBottom:8 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'#475569', marginBottom:3 }}>
                        <span>Confidence</span>
                        <span style={{ color: bull ? '#22c55e' : '#ef4444', fontWeight:700 }}>{r.confidence}%</span>
                      </div>
                      <div style={{ height:5, background:'#1e293b', borderRadius:3, overflow:'hidden' }}>
                        <div style={{
                          width:`${r.confidence}%`, height:'100%',
                          background: bull
                            ? 'linear-gradient(90deg,#92400e,#f59e0b)'
                            : 'linear-gradient(90deg,#b91c1c,#ef4444)',
                          transition:'width 0.5s ease',
                        }}/>
                      </div>
                    </div>

                    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                      {CRYPTO_FACTORS.map(({ key, label, color }) => {
                        const val = r[key] ?? 0;
                        const pctLeft = val >= 0 ? 50 : 50 + val * 50;
                        const pctWidth = Math.abs(val) * 50;
                        return (
                          <div key={key} style={{ display:'flex', alignItems:'center', gap:6 }}>
                            <span style={{ fontSize:9, color:'#475569', width:26, textAlign:'right', flexShrink:0 }}>{label}</span>
                            <div style={{ flex:1, height:4, background:'#1e293b', borderRadius:2, position:'relative', overflow:'hidden' }}>
                              <div style={{ position:'absolute', left:'50%', top:0, width:1, height:'100%', background:'#334155' }}/>
                              <div style={{
                                position:'absolute', left:`${pctLeft}%`, width:`${pctWidth}%`,
                                height:'100%', background: val >= 0 ? color : '#ef4444', opacity:0.9,
                              }}/>
                            </div>
                            <span style={{ fontSize:9, color, width:32, textAlign:'right', flexShrink:0 }}>
                              {val >= 0 ? '+' : ''}{val.toFixed(2)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
          </div>
          <div style={{ fontSize:9, color:'#334155', marginTop:6 }}>
            * Crypto via Binance public API (free, no key needed). Tech(45%) · DXY(30%) · Timing(25%). No COT.
          </div>
        </div>
      )}

      {lastUpdate && (
        <div style={{ textAlign:'center', fontSize:10, color:'#334155', marginTop:16, paddingBottom:16 }}>
          Last updated: {lastUpdate.toLocaleString()} · {PAIRS.length} FX + {cryptoResults.length} Crypto · {cotAvail ? 'COT live' : 'COT neutral fallback'}
        </div>
      )}
    </div>
  );
}

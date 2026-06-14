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

const PROXY = 'https://corsproxy.io/?';
const CALENDAR_URL = PROXY + encodeURIComponent('https://nfs.faireconomy.media/ff_calendar_thisweek.json');

const FLAGS = {
  EUR:'🇪🇺', USD:'🇺🇸', GBP:'🇬🇧', JPY:'🇯🇵',
  AUD:'🇦🇺', CAD:'🇨🇦', CHF:'🇨🇭', NZD:'🇳🇿',
  XAU:'🥇',  XAG:'🥈',
};

function getOandaCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) return c;
  } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}

function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const pc = candles[i - 1].c;
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
  }
  return sum / period;
}

function getPipSize(id) {
  if (id === 'XAU_USD') return 0.1;
  if (id === 'XAG_USD') return 0.001;
  if (id.includes('JPY')) return 0.01;
  return 0.0001;
}

function getSignal(total) {
  if (total >= 3)  return { label: 'STRONG LONG',  color: '#22c55e', bg: '#22c55e20' };
  if (total >= 1)  return { label: 'MILD LONG',    color: '#86efac', bg: '#86efac15' };
  if (total === 0) return { label: 'NEUTRAL',      color: '#8b949e', bg: '#8b949e15' };
  if (total >= -2) return { label: 'MILD SHORT',   color: '#fca5a5', bg: '#fca5a515' };
  return             { label: 'STRONG SHORT', color: '#f43f5e', bg: '#f43f5e20' };
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

/* ── ScoreRing ─────────────────────────────────────────────────────────── */
function ScoreRing({ pct, color }) {
  const R = 26, C = 2 * Math.PI * R;
  const dash = C * (pct / 100);
  return (
    <svg width={64} height={64}>
      <circle cx={32} cy={32} r={R} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={5} />
      <circle
        cx={32} cy={32} r={R}
        fill="none"
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${C - dash}`}
        transform="rotate(-90 32 32)"
        style={{ filter: `drop-shadow(0 0 6px ${color})` }}
      />
      <text
        x={32} y={37}
        textAnchor="middle"
        fill={color}
        style={{ fontSize: 15, fontWeight: 800, fontFamily: 'monospace' }}
      >
        {pct}
      </text>
    </svg>
  );
}

/* ── Sparkline ─────────────────────────────────────────────────────────── */
function Sparkline({ data, color }) {
  if (!data || data.length < 2) return null;
  const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1;
  const W = 60, H = 28;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * W},${H - ((v - mn) / rng) * H}`)
    .join(' ');
  return (
    <svg width={W} height={H} style={{ overflow: 'visible' }}>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        style={{ filter: `drop-shadow(0 0 3px ${color})` }}
      />
    </svg>
  );
}

/* ── Card style ────────────────────────────────────────────────────────── */
const CARD_STYLE = {
  background: 'linear-gradient(140deg, #111f38 0%, #0c1422 100%)',
  border: '1px solid rgba(139,92,246,0.4)',
  borderRadius: 12,
  padding: '14px',
  boxShadow: '0 0 24px rgba(139,92,246,0.12), 0 6px 24px rgba(0,0,0,0.5)',
};

/* ── Main component ────────────────────────────────────────────────────── */
export default function TradeDashboard() {
  const [scores,      setScores]      = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error,       setError]       = useState('');

  const compute = useCallback(async () => {
    setLoading(true);
    setError('');
    const c = getOandaCreds();
    const oandaBase = c?.practice
      ? 'https://api-fxpractice.oanda.com/v3'
      : 'https://api-fxtrade.oanda.com/v3';
    const hdrs = c ? { Authorization: `Bearer ${c.apiKey}` } : {};

    // 1 — COT data
    const cotMap = {};
    await Promise.allSettled(
      Object.entries(COT_CODES).map(async ([key, code]) => {
        try {
          const url = `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=1`;
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) return;
          const rows = await res.json();
          if (rows[0]) {
            const net = (+rows[0].noncomm_positions_long_all || 0) - (+rows[0].noncomm_positions_short_all || 0);
            cotMap[key] = net;
          }
        } catch {}
      })
    );

    // 2 — News calendar (high-impact events next 24h)
    let newsEvents = [];
    try {
      const res = await fetch(CALENDAR_URL, { signal: AbortSignal.timeout(10000) });
      if (res.ok) newsEvents = await res.json();
    } catch {}
    const now   = Date.now();
    const in24h = now + 24 * 3600 * 1000;
    function hasHighNews(currency) {
      const cc = NEWS_CURRENCIES[currency] || currency;
      return newsEvents.some(e => {
        const t = new Date(e.date).getTime();
        return e.currency === cc && e.impact === 'High' && t >= now && t <= in24h;
      });
    }

    // 3 — Per-pair candle data
    const results = await Promise.allSettled(
      PAIRS.map(async (p) => {
        const s = { cot: 0, seasonality: 0, strength: 0, volatility: 0, news: 0 };

        // COT
        const rawNet = cotMap[p.cotKey];
        if (rawNet !== undefined) {
          const net = p.cotInvert ? -rawNet : rawNet;
          s.cot = net > 0 ? 1 : -1;
        }

        // News — avoid = -1, clear = +1
        const baseNews  = hasHighNews(p.base);
        const quoteNews = hasHighNews(p.quote);
        s.news = (baseNews || quoteNews) ? -1 : 1;

        if (!c) return { ...p, scores: s, total: Object.values(s).reduce((a, b) => a + b, 0), sparkData: null, price: null, change: null };

        const pip = getPipSize(p.id);

        // H1 candles — strength + volatility + sparkline data
        let sparkData = null, price = null, change = null;
        try {
          const res = await fetch(
            `${oandaBase}/instruments/${p.id}/candles?granularity=H1&count=50`,
            { headers: hdrs, signal: AbortSignal.timeout(10000) }
          );
          if (res.ok) {
            const data = await res.json();
            const candles = (data.candles || [])
              .filter(c => c.complete)
              .map(c => ({ o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c }));

            if (candles.length >= 20) {
              // Strength: pair direction over last 20 bars
              const pctChange = (candles[candles.length - 1].c - candles[candles.length - 20].o)
                / candles[candles.length - 20].o;
              s.strength = pctChange > 0 ? 1 : -1;

              // Volatility: ATR in pips — tradeable if > 3 pips
              const atr     = computeATR(candles, 14);
              const atrPips = atr / pip;
              s.volatility  = atrPips >= 3 ? 1 : 0;

              // Sparkline + price + change (last 20 bars)
              const last20 = candles.slice(-20);
              sparkData    = last20.map(cc => cc.c);
              price        = last20[last20.length - 1].c;
              change       = ((last20[last20.length - 1].c - last20[0].c) / last20[0].c) * 100;
            }
          }
        } catch {}

        // Daily candles — seasonality (current month avg return)
        try {
          const res = await fetch(
            `${oandaBase}/instruments/${p.id}/candles?granularity=D&count=730`,
            { headers: hdrs, signal: AbortSignal.timeout(15000) }
          );
          if (res.ok) {
            const data    = await res.json();
            const curMon  = new Date().getMonth();
            const returns = (data.candles || [])
              .filter(c => c.complete && new Date(c.time).getMonth() === curMon)
              .map(c => (+c.mid.c - +c.mid.o) / +c.mid.o);
            if (returns.length >= 3) {
              const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
              s.seasonality = avg > 0 ? 1 : -1;
            }
          }
        } catch {}

        return { ...p, scores: s, total: Object.values(s).reduce((a, b) => a + b, 0), sparkData, price, change };
      })
    );

    const pairResults = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => b.total - a.total);

    setScores(pairResults);
    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => { compute(); }, [compute]);

  // Derived display values
  const topPairs = scores ? scores.filter(p => p.total >= 2).slice(0, 3) : [];
  const hasOanda = !!getOandaCreds();

  return (
    <div style={{ padding: '20px 16px', maxWidth: 1100, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#e6edf3', letterSpacing: '-0.3px' }}>
            {getGreeting()}, Trader 👋
          </div>
          <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4, letterSpacing: '0.04em' }}>
            Live Confluence Analysis
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {lastUpdated && (
            <span style={{ fontSize: 11, color: '#484f58' }}>
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={compute}
            disabled={loading}
            style={{
              padding: '7px 16px', borderRadius: 8,
              border: '1px solid rgba(139,92,246,0.5)',
              background: 'rgba(139,92,246,0.15)',
              color: '#c4b5fd',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: 12, fontWeight: 600,
              opacity: loading ? 0.6 : 1,
              transition: 'opacity 0.2s',
            }}
          >
            {loading ? '⟳ Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* ── AI Alert card ──────────────────────────────────────────────── */}
      {scores && topPairs.length > 0 && (
        <div style={{
          ...CARD_STYLE,
          borderLeft: '3px solid #8b5cf6',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
        }}>
          <span style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}>🤖</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa', letterSpacing: '0.08em', marginBottom: 4 }}>
              AI ALERT
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.5 }}>
              Found <strong style={{ color: '#e2e8f0' }}>{topPairs.length}</strong> high-probability setup{topPairs.length > 1 ? 's' : ''}.{' '}
              {topPairs.map((p, i) => {
                const sig = getSignal(p.total);
                return (
                  <span key={p.id}>
                    <strong style={{ color: '#e2e8f0' }}>{p.label}</strong>{' '}
                    showing <span style={{ color: sig.color, fontWeight: 700 }}>{sig.label}</span>
                    {i < topPairs.length - 1 ? ' · ' : ''}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── No OANDA warning ───────────────────────────────────────────── */}
      {!hasOanda && (
        <div style={{
          background: 'rgba(217,119,6,0.08)',
          border: '1px solid rgba(245,158,11,0.5)',
          borderRadius: 10,
          padding: '10px 14px',
          marginBottom: 16,
          color: '#fbbf24',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ fontSize: 16 }}>⚠️</span>
          No OANDA API key — Strength, Volatility, Seasonality and price data unavailable.
          Add your key in Auto Trading → Broker settings.
        </div>
      )}

      {/* ── Loading spinner ─────────────────────────────────────────────── */}
      {loading && !scores && (
        <div style={{
          ...CARD_STYLE,
          textAlign: 'center',
          padding: '60px 20px',
          color: '#8b949e',
        }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>⟳</div>
          <div style={{ fontSize: 14, color: '#cbd5e1', marginBottom: 6 }}>Loading confluence data…</div>
          <div style={{ fontSize: 11, color: '#4b5563' }}>
            COT from CFTC · Prices from OANDA · News from ForexFactory
          </div>
        </div>
      )}

      {/* ── Pair cards grid ────────────────────────────────────────────── */}
      {scores && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 12,
          marginBottom: 16,
        }}>
          {scores.map(p => {
            const pct        = Math.round((p.total + 5) / 10 * 100);
            const color      = getScoreColor(pct);
            const sig        = getSignal(p.total);
            const changePos  = p.change != null ? p.change >= 0 : null;
            const sparkColor = changePos === false ? '#f43f5e' : '#22c55e';

            const priceStr = p.price != null
              ? (p.id === 'XAU_USD' || p.id === 'XAG_USD')
                ? p.price.toFixed(2)
                : p.id.includes('JPY')
                  ? p.price.toFixed(3)
                  : p.price.toFixed(5)
              : null;

            const changeStr = p.change != null
              ? `${p.change >= 0 ? '+' : ''}${p.change.toFixed(2)}%`
              : null;

            return (
              <div key={p.id} style={CARD_STYLE}>

                {/* Top row: flags + name | score ring */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>

                  {/* Left: pair identity */}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 20 }}>{FLAGS[p.base] || '🏳️'}</span>
                      <span style={{ fontSize: 20 }}>{FLAGS[p.quote] || '🏳️'}</span>
                      <span style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0', letterSpacing: '0.02em' }}>
                        {p.label}
                      </span>
                    </div>

                    {/* Price + change */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
                      {priceStr ? (
                        <>
                          <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>
                            {priceStr}
                          </span>
                          {changeStr && (
                            <span style={{ fontSize: 11, fontWeight: 600, color: changePos ? '#22c55e' : '#f43f5e' }}>
                              {changeStr}
                            </span>
                          )}
                        </>
                      ) : (
                        <span style={{ fontSize: 11, color: '#4b5563' }}>No price data</span>
                      )}
                    </div>

                    {/* Sparkline */}
                    <div style={{ marginBottom: 10 }}>
                      <Sparkline data={p.sparkData} color={sparkColor} />
                    </div>

                    {/* Signal badge */}
                    <span style={{
                      display: 'inline-block',
                      fontSize: 10, fontWeight: 700,
                      padding: '3px 9px', borderRadius: 5,
                      color: sig.color,
                      background: sig.bg,
                      border: `1px solid ${sig.color}55`,
                      letterSpacing: '0.06em',
                    }}>
                      {sig.label}
                    </span>
                  </div>

                  {/* Right: score ring */}
                  <div style={{ flexShrink: 0, marginLeft: 8 }}>
                    <ScoreRing pct={pct} color={color} />
                  </div>
                </div>

              </div>
            );
          })}
        </div>
      )}

      {/* ── Legend card ────────────────────────────────────────────────── */}
      {scores && (
        <div style={{ ...CARD_STYLE, borderColor: 'rgba(139,92,246,0.55)' }}>
          <div style={{
            fontSize: 12, fontWeight: 700, color: '#a78bfa',
            letterSpacing: '0.08em', marginBottom: 10,
          }}>
            HOW TO READ SCORES
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 22px', fontSize: 12, marginBottom: 8 }}>
            {[
              { label: '70–100 · Strong Long',    color: '#22c55e' },
              { label: '50–69 · Mild / Caution',  color: '#f59e0b' },
              { label: '30–49 · Weak',             color: '#f97316' },
              { label: '0–29 · Strong Short',      color: '#f43f5e' },
            ].map(i => (
              <span key={i.label} style={{ color: i.color, fontWeight: 600 }}>
                <span style={{
                  display: 'inline-block', width: 8, height: 8,
                  borderRadius: '50%', background: i.color,
                  marginRight: 5, verticalAlign: 'middle',
                  boxShadow: `0 0 6px ${i.color}`,
                }} />
                {i.label}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 10, color: '#4b5563', lineHeight: 1.6 }}>
            Score ring maps –5…+5 raw score → 0…100 pct.&nbsp;
            COT = institutional positioning · Seasonality = current month history ·
            Strength = recent pair direction · Volatility = ATR ≥ 3 pips · News = no high-impact event next 24h
          </div>
        </div>
      )}

    </div>
  );
}

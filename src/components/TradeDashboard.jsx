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
  if (total >= 3)  return { label: 'STRONG LONG',  color: '#3fb950', bg: '#3fb95020' };
  if (total >= 1)  return { label: 'MILD LONG',    color: '#86efac', bg: '#86efac15' };
  if (total === 0) return { label: 'NEUTRAL',      color: '#8b949e', bg: '#8b949e15' };
  if (total >= -2) return { label: 'MILD SHORT',   color: '#fca5a5', bg: '#fca5a515' };
  return             { label: 'STRONG SHORT', color: '#f85149', bg: '#f8514920' };
}

function ScoreCell({ val }) {
  if (val === 1)  return <span style={{ color: '#3fb950', fontWeight: 700, fontSize: 15 }}>✓</span>;
  if (val === -1) return <span style={{ color: '#f85149', fontWeight: 700, fontSize: 15 }}>✗</span>;
  return <span style={{ color: '#484f58' }}>—</span>;
}

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

        if (!c) return { ...p, scores: s, total: Object.values(s).reduce((a, b) => a + b, 0) };

        const pip = getPipSize(p.id);

        // H1 candles — strength + volatility
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

        return { ...p, scores: s, total: Object.values(s).reduce((a, b) => a + b, 0) };
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

  const COLS = ['Pair', 'COT', 'Season', 'Strength', 'Volatility', 'News', 'Score', 'Signal'];

  return (
    <div style={{ padding: 16, maxWidth: 960, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#e6edf3' }}>🎯 Trade Dashboard</div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>
            Confluence score — COT · Seasonality · Strength · Volatility · News
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {lastUpdated && (
            <span style={{ fontSize: 10, color: '#8b949e' }}>
              {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={compute}
            disabled={loading}
            style={{
              padding: '6px 14px', borderRadius: 6, border: '1px solid #30363d',
              background: '#21262d', color: '#e6edf3', cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: 12, opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? '⟳ Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* No OANDA key warning */}
      {!getOandaCreds() && (
        <div style={{
          background: '#1c2128', border: '1px solid #d29922', borderRadius: 8,
          padding: '10px 14px', marginBottom: 16, color: '#d29922', fontSize: 12,
        }}>
          ⚠ No OANDA API key — Strength, Volatility and Seasonality unavailable.
          Add your key in Auto Trading → Broker settings.
        </div>
      )}

      {/* Loading spinner */}
      {loading && !scores && (
        <div style={{ textAlign: 'center', padding: 60, color: '#8b949e' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>⟳</div>
          <div>Loading confluence data from all sources…</div>
          <div style={{ fontSize: 10, marginTop: 4 }}>COT from CFTC · Prices from OANDA · News from ForexFactory</div>
        </div>
      )}

      {/* Table */}
      {scores && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #30363d' }}>
                {COLS.map(h => (
                  <th key={h} style={{
                    padding: '8px 10px',
                    textAlign: h === 'Pair' ? 'left' : 'center',
                    color: '#8b949e', fontSize: 10, fontWeight: 600,
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                    whiteSpace: 'nowrap',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scores.map(p => {
                const sig = getSignal(p.total);
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid #21262d' }}>
                    <td style={{ padding: '11px 10px', fontWeight: 700, color: '#e6edf3', whiteSpace: 'nowrap' }}>
                      {p.label}
                    </td>
                    {['cot','seasonality','strength','volatility','news'].map(k => (
                      <td key={k} style={{ textAlign: 'center', padding: '11px 10px' }}>
                        <ScoreCell val={p.scores[k]} />
                      </td>
                    ))}
                    <td style={{ textAlign: 'center', padding: '11px 10px' }}>
                      <span style={{
                        fontFamily: 'monospace', fontWeight: 700, fontSize: 16,
                        color: p.total > 0 ? '#3fb950' : p.total < 0 ? '#f85149' : '#8b949e',
                      }}>
                        {p.total > 0 ? '+' : ''}{p.total}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center', padding: '11px 10px' }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
                        color: sig.color, background: sig.bg,
                        border: `1px solid ${sig.color}44`, whiteSpace: 'nowrap',
                      }}>
                        {sig.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      {scores && (
        <div style={{
          marginTop: 20, padding: '12px 16px', background: '#161b22',
          border: '1px solid #30363d', borderRadius: 8,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#e6edf3', marginBottom: 8 }}>
            How to read
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 20px', fontSize: 11 }}>
            {[
              { label: '+3 to +5 = Strong Long',  color: '#3fb950' },
              { label: '+1 to +2 = Mild Long',    color: '#86efac' },
              { label: '0 = Neutral — skip',      color: '#8b949e' },
              { label: '-1 to -2 = Mild Short',   color: '#fca5a5' },
              { label: '-3 to -5 = Strong Short', color: '#f85149' },
            ].map(i => (
              <span key={i.label} style={{ color: i.color }}>{i.label}</span>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: '#484f58' }}>
            ✓ bullish signal · ✗ bearish signal · — neutral/unavailable &nbsp;|&nbsp;
            COT = institutional bias · Season = current month history · Strength = recent pair direction ·
            Volatility = ATR ≥ 3 pips · News = no high-impact event next 24h
          </div>
        </div>
      )}
    </div>
  );
}

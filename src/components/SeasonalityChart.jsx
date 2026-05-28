import { useState, useEffect, useCallback } from 'react';

const PAIRS = [
  { key: 'EUR_USD', label: 'EUR/USD' },
  { key: 'GBP_USD', label: 'GBP/USD' },
  { key: 'USD_JPY', label: 'USD/JPY' },
  { key: 'USD_CHF', label: 'USD/CHF' },
  { key: 'AUD_USD', label: 'AUD/USD' },
  { key: 'USD_CAD', label: 'USD/CAD' },
  { key: 'NZD_USD', label: 'NZD/USD' },
  { key: 'EUR_GBP', label: 'EUR/GBP' },
  { key: 'EUR_JPY', label: 'EUR/JPY' },
  { key: 'GBP_JPY', label: 'GBP/JPY' },
  { key: 'XAU_USD', label: 'XAU/USD' },
  { key: 'XAG_USD', label: 'XAG/USD' },
];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function getOandaCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) return c;
  } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}

function computeSeasonality(candles) {
  // Monthly aggregation
  const byMonth = Array.from({ length: 12 }, () => ({ returns: [] }));
  // Year breakdown: { year: [avgReturnPerMonth0..11] }
  const byYearMonth = {};

  candles.forEach(c => {
    if (!c.complete) return;
    const date = new Date(c.time);
    const month = date.getMonth();
    const year  = date.getFullYear();
    const open  = parseFloat(c.mid.o);
    const close = parseFloat(c.mid.c);
    if (!open || !close) return;
    const ret = ((close - open) / open) * 100;
    byMonth[month].returns.push(ret);
    if (!byYearMonth[year]) byYearMonth[year] = Array.from({ length: 12 }, () => []);
    byYearMonth[year][month].push(ret);
  });

  const monthly = byMonth.map(({ returns }) => {
    if (returns.length === 0) return { avg: 0, winRate: 0, count: 0 };
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const wins = returns.filter(r => r > 0).length;
    return { avg: +avg.toFixed(3), winRate: +((wins / returns.length) * 100).toFixed(1), count: returns.length };
  });

  // Get last 8 years
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear - 8; y < currentYear; y++) {
    if (byYearMonth[y]) years.push(y);
  }

  const yearBreakdown = years.map(year => {
    const months = byYearMonth[year].map(returns => {
      if (returns.length === 0) return null;
      const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
      return +avg.toFixed(3);
    });
    return { year, months };
  });

  return { monthly, yearBreakdown };
}

function buildNotes(monthly, pairLabel) {
  const indexed = monthly.map((m, i) => ({ ...m, month: MONTHS[i] }));
  const sorted = [...indexed].sort((a, b) => b.avg - a.avg);
  const best = sorted.slice(0, 3).filter(m => m.avg > 0);
  const worst = sorted.slice(-3).reverse().filter(m => m.avg < 0);
  const parts = [];
  if (best.length > 0) parts.push(`Historically strongest months for ${pairLabel}: ${best.map(m => m.month).join(', ')}.`);
  if (worst.length > 0) parts.push(`Historically weakest months: ${worst.map(m => m.month).join(', ')}.`);
  const highWin = indexed.filter(m => m.winRate > 55).map(m => m.month);
  if (highWin.length > 0) parts.push(`Win rate above 55% in: ${highWin.join(', ')}.`);
  return parts.join(' ');
}

export default function SeasonalityChart() {
  const [pair, setPair] = useState('EUR_USD');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [totalCandles, setTotalCandles] = useState(0);

  const creds = getOandaCreds();
  const hasKey = !!creds;

  const pairLabel = PAIRS.find(p => p.key === pair)?.label || pair;

  const fetchData = useCallback(async () => {
    const c = getOandaCreds();
    if (!c) return;
    const baseUrl = c.practice
      ? 'https://api-fxpractice.oanda.com/v3'
      : 'https://api-fxtrade.oanda.com/v3';

    setLoading(true);
    setError('');
    setData(null);

    try {
      const res = await fetch(
        `${baseUrl}/instruments/${pair}/candles?granularity=D&count=3650&price=M`,
        { headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(20000) }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.errorMessage || `HTTP ${res.status}`);
      }
      const json = await res.json();
      const candles = json.candles || [];
      setTotalCandles(candles.length);
      const result = computeSeasonality(candles);
      setData(result);
    } catch (e) {
      setError(`Failed to fetch data: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [pair]);

  useEffect(() => {
    if (hasKey) fetchData();
  }, [fetchData, hasKey]);

  const maxAbs = data ? Math.max(...data.monthly.map(m => Math.abs(m.avg)), 0.001) : 1;

  const cellColor = (val) => {
    if (val === null) return '#161b22';
    if (val > 0.1) return `rgba(63,185,80,${Math.min(Math.abs(val) / 0.5, 1) * 0.7 + 0.1})`;
    if (val < -0.1) return `rgba(248,81,73,${Math.min(Math.abs(val) / 0.5, 1) * 0.7 + 0.1})`;
    return '#1f2937';
  };

  const btnBase = {
    border: '1px solid #30363d', borderRadius: 6, padding: '6px 14px',
    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
  };

  return (
    <div style={{ padding: 20, color: '#e6edf3', fontFamily: 'system-ui, sans-serif', background: '#0d1117', minHeight: '100%' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#e6edf3', margin: '0 0 4px' }}>
          Seasonality Chart
        </h2>
        <p style={{ fontSize: 13, color: '#8b949e', margin: 0 }}>
          Historical monthly performance bias — which months historically go up or down
        </p>
      </div>

      {!hasKey ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#8b949e' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔑</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, color: '#e6edf3' }}>
            OANDA API Key Required
          </div>
          <div style={{ fontSize: 13 }}>
            Connect OANDA first (Auto Trading → Connect Exchange)
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: '#8b949e' }}>Pair:</span>
            <select
              value={pair}
              onChange={e => setPair(e.target.value)}
              style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3', borderRadius: 6, padding: '6px 10px', fontSize: 13, cursor: 'pointer' }}
            >
              {PAIRS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            <button onClick={fetchData} disabled={loading} style={{ ...btnBase, background: '#21262d', color: '#e6edf3' }}>
              {loading ? '⟳ Loading...' : '↻ Refresh'}
            </button>
          </div>

          {error && (
            <div style={{ background: '#f8514918', border: '1px solid #f85149', borderRadius: 8, padding: '12px 16px', color: '#f85149', marginBottom: 16 }}>
              {error}
            </div>
          )}

          {loading && (
            <div style={{ textAlign: 'center', padding: 40, color: '#8b949e' }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>⟳</div>
              Fetching ~10 years of daily candles...
            </div>
          )}

          {data && !loading && (
            <>
              {/* Monthly bars */}
              <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#8b949e', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Monthly Average Return — {pairLabel}
                </div>
                {data.monthly.map((m, i) => {
                  const pct = Math.abs(m.avg) / maxAbs * 100;
                  const isPos = m.avg >= 0;
                  const barColor = isPos ? '#3fb950' : '#f85149';
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                      <span style={{ width: 28, fontSize: 12, fontWeight: 600, color: '#8b949e', fontFamily: 'monospace' }}>
                        {MONTHS[i]}
                      </span>
                      {/* Negative bar (left side) */}
                      <div style={{ width: '35%', display: 'flex', justifyContent: 'flex-end' }}>
                        {!isPos && (
                          <div style={{ width: `${pct}%`, height: 14, background: barColor, borderRadius: '4px 0 0 4px', minWidth: 2 }} />
                        )}
                      </div>
                      {/* Center line */}
                      <div style={{ width: 2, height: 14, background: '#30363d' }} />
                      {/* Positive bar (right side) */}
                      <div style={{ width: '35%' }}>
                        {isPos && (
                          <div style={{ width: `${pct}%`, height: 14, background: barColor, borderRadius: '0 4px 4px 0', minWidth: 2 }} />
                        )}
                      </div>
                      <span style={{ fontSize: 12, fontFamily: 'monospace', color: isPos ? '#3fb950' : '#f85149', minWidth: 60 }}>
                        {isPos ? '+' : ''}{m.avg.toFixed(3)}%
                      </span>
                      <span style={{ fontSize: 11, color: '#8b949e', minWidth: 60 }}>
                        Win: {m.winRate}%
                      </span>
                      <span style={{ fontSize: 11, color: '#30363d' }}>
                        n={m.count}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Historical Notes */}
              <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#8b949e', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Historical Notes
                </div>
                <p style={{ fontSize: 13, color: '#e6edf3', margin: 0, lineHeight: 1.7 }}>
                  {buildNotes(data.monthly, pairLabel)}
                </p>
              </div>

              {/* Year breakdown table */}
              {data.yearBreakdown.length > 0 && (
                <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: '16px 20px', marginBottom: 16, overflowX: 'auto' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#8b949e', marginBottom: 14, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Year-by-Year Breakdown
                  </div>
                  <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 700 }}>
                    <thead>
                      <tr>
                        <th style={{ padding: '6px 10px', textAlign: 'left', color: '#8b949e', fontWeight: 600, width: 50 }}>Year</th>
                        {MONTHS.map(m => (
                          <th key={m} style={{ padding: '6px 8px', textAlign: 'center', color: '#8b949e', fontWeight: 600, width: 46 }}>{m}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.yearBreakdown.map(({ year, months }) => (
                        <tr key={year}>
                          <td style={{ padding: '5px 10px', color: '#e6edf3', fontWeight: 700, fontFamily: 'monospace' }}>{year}</td>
                          {months.map((val, mi) => (
                            <td key={mi} style={{ padding: '5px 8px', textAlign: 'center', background: cellColor(val), borderRadius: 3, border: '1px solid #0d111755' }}>
                              <span style={{ fontSize: 11, fontFamily: 'monospace', color: val === null ? '#30363d' : val > 0 ? '#3fb950' : '#f85149' }}>
                                {val === null ? '—' : `${val > 0 ? '+' : ''}${val.toFixed(2)}`}
                              </span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div style={{ fontSize: 12, color: '#8b949e', marginTop: 8 }}>
                Based on <strong style={{ color: '#e6edf3' }}>{totalCandles}</strong> daily candles from OANDA historical data.
                Average daily % return grouped by calendar month.
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

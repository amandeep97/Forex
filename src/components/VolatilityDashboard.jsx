import { useState, useEffect, useCallback } from 'react';

const INSTRUMENTS = [
  { key: 'EUR_USD', label: 'EUR/USD', pipSize: 0.0001 },
  { key: 'GBP_USD', label: 'GBP/USD', pipSize: 0.0001 },
  { key: 'USD_JPY', label: 'USD/JPY', pipSize: 0.01   },
  { key: 'USD_CHF', label: 'USD/CHF', pipSize: 0.0001 },
  { key: 'AUD_USD', label: 'AUD/USD', pipSize: 0.0001 },
  { key: 'USD_CAD', label: 'USD/CAD', pipSize: 0.0001 },
  { key: 'NZD_USD', label: 'NZD/USD', pipSize: 0.0001 },
  { key: 'EUR_GBP', label: 'EUR/GBP', pipSize: 0.0001 },
  { key: 'EUR_JPY', label: 'EUR/JPY', pipSize: 0.01   },
  { key: 'GBP_JPY', label: 'GBP/JPY', pipSize: 0.01   },
  { key: 'AUD_JPY', label: 'AUD/JPY', pipSize: 0.01   },
  { key: 'XAU_USD', label: 'XAU/USD', pipSize: 0.1    },
  { key: 'XAG_USD', label: 'XAG/USD', pipSize: 0.01   },
  { key: 'GBP_CHF', label: 'GBP/CHF', pipSize: 0.0001 },
  { key: 'EUR_CAD', label: 'EUR/CAD', pipSize: 0.0001 },
];

// Static heatmap data: activity level 0-3 (0=inactive, 1=low, 2=med, 3=high)
// Rows: pairs; Cols: UTC hours 0-23
const HEATMAP_PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','XAU/USD'];

function buildHeatmapData() {
  // For each pair define active hour ranges
  const config = {
    'EUR/USD': [[7,21,2],[13,16,3]],   // London active, NY/London overlap peak
    'GBP/USD': [[7,21,2],[13,16,3]],
    'USD/JPY': [[0,9,2],[13,21,2],[22,24,2]],
    'USD/CHF': [[7,16,2],[13,16,3]],
    'AUD/USD': [[0,4,2],[22,24,2],[13,21,1]],
    'XAU/USD': [[7,21,2],[13,16,3]],
  };
  const result = {};
  HEATMAP_PAIRS.forEach(pair => {
    const row = new Array(24).fill(1); // base: low
    (config[pair] || []).forEach(([start, end, level]) => {
      for (let h = start; h < Math.min(end, 24); h++) row[h] = level;
    });
    result[pair] = row;
  });
  return result;
}

const HEATMAP = buildHeatmapData();

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
  if (!candles || candles.length < period) return 0;
  const last = candles.slice(-period);
  const trs = last.map(c => parseFloat(c.mid.h) - parseFloat(c.mid.l));
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function getVolatilityRank(h1Pips, isMetals) {
  if (isMetals) return { label: 'HIGH', color: '#3fb950' };
  if (h1Pips < 5)  return { label: 'LOW',  color: '#8b949e' };
  if (h1Pips < 12) return { label: 'MED',  color: '#d29922' };
  return { label: 'HIGH', color: '#3fb950' };
}

function heatmapColor(level) {
  if (level === 3) return '#3fb950';
  if (level === 2) return '#d29922';
  if (level === 1) return '#1f3a2a';
  return '#161b22';
}

export default function VolatilityDashboard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState(null);
  const [view, setView] = useState('h1'); // 'h1' | 'daily'
  const [lastUpdated, setLastUpdated] = useState(null);
  const currentHour = new Date().getUTCHours();

  const creds = getOandaCreds();
  const hasKey = !!creds;

  const fetchData = useCallback(async () => {
    const c = getOandaCreds();
    if (!c) return;
    const baseUrl = c.practice
      ? 'https://api-fxpractice.oanda.com/v3'
      : 'https://api-fxtrade.oanda.com/v3';

    setLoading(true);
    setError('');

    try {
      // Fetch H1 candles (100 bars) and D candles (14 bars) in parallel
      const [h1Results, dResults] = await Promise.all([
        Promise.all(INSTRUMENTS.map(inst =>
          fetch(`${baseUrl}/instruments/${inst.key}/candles?granularity=H1&count=100&price=M`, {
            headers: { Authorization: `Bearer ${c.apiKey}` },
            signal: AbortSignal.timeout(10000),
          }).then(r => r.json()).catch(() => null)
        )),
        Promise.all(INSTRUMENTS.map(inst =>
          fetch(`${baseUrl}/instruments/${inst.key}/candles?granularity=D&count=14&price=M`, {
            headers: { Authorization: `Bearer ${c.apiKey}` },
            signal: AbortSignal.timeout(10000),
          }).then(r => r.json()).catch(() => null)
        )),
      ]);

      // Try to get spreads (optional — needs account ID)
      const acctId = localStorage.getItem('oanda_account_id');
      let spreads = {};
      if (acctId) {
        try {
          const pairsParam = INSTRUMENTS.map(i => i.key).join(',');
          const pricingRes = await fetch(`${baseUrl}/accounts/${acctId}/pricing?instruments=${pairsParam}`, {
            headers: { Authorization: `Bearer ${c.apiKey}` },
            signal: AbortSignal.timeout(8000),
          });
          if (pricingRes.ok) {
            const pricingData = await pricingRes.json();
            (pricingData.prices || []).forEach(p => {
              const bid = parseFloat(p.bids?.[0]?.price || 0);
              const ask = parseFloat(p.asks?.[0]?.price || 0);
              spreads[p.instrument] = ask - bid;
            });
          }
        } catch {}
      }

      const built = INSTRUMENTS.map((inst, i) => {
        const h1Data = h1Results[i];
        const dData  = dResults[i];
        const h1Candles = h1Data?.candles || [];
        const dCandles  = dData?.candles  || [];
        const isMetals = inst.key.startsWith('X');

        const h1Atr  = computeATR(h1Candles, 14);
        const dAtr   = computeATR(dCandles, 14);
        const h1Pips = h1Atr > 0 ? +(h1Atr / inst.pipSize).toFixed(1) : null;
        const dPips  = dAtr  > 0 ? +(dAtr  / inst.pipSize).toFixed(1) : null;

        const rawSpread = spreads[inst.key] || null;
        const spreadPips = rawSpread != null ? +(rawSpread / inst.pipSize).toFixed(1) : null;

        const rank = h1Pips != null ? getVolatilityRank(h1Pips, isMetals) : null;

        return { ...inst, h1Pips, dPips, spreadPips, rank };
      });

      // Sort by H1 ATR descending
      built.sort((a, b) => (b.h1Pips || 0) - (a.h1Pips || 0));
      setRows(built);
      setLastUpdated(new Date());
    } catch (e) {
      setError(`Failed to fetch data: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasKey) fetchData();
  }, [fetchData, hasKey]);

  const maxPips = rows ? Math.max(...rows.map(r => (view === 'h1' ? r.h1Pips : r.dPips) || 0), 1) : 1;

  const btnBase = {
    border: '1px solid #30363d', borderRadius: 6, padding: '6px 14px',
    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
  };

  return (
    <div style={{ padding: 20, color: '#e6edf3', fontFamily: 'system-ui, sans-serif', background: '#0d1117', minHeight: '100%' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#e6edf3', margin: '0 0 4px' }}>
          Volatility Dashboard
        </h2>
        <p style={{ fontSize: 13, color: '#8b949e', margin: 0 }}>
          ATR-based volatility, live spreads, and 24h trading activity heatmap
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: '#8b949e' }}>View:</span>
            {[['h1','H1 ATR'],['daily','Daily ATR']].map(([val, lbl]) => (
              <button key={val} onClick={() => setView(val)} style={{
                ...btnBase,
                background: view === val ? '#1f6feb' : '#21262d',
                borderColor: view === val ? '#1f6feb' : '#30363d',
                color: view === val ? '#fff' : '#e6edf3',
              }}>{lbl}</button>
            ))}
            <button onClick={fetchData} disabled={loading} style={{ ...btnBase, background: '#21262d', color: '#e6edf3', marginLeft: 8 }}>
              {loading ? '⟳ Loading...' : '↻ Refresh'}
            </button>
            {lastUpdated && (
              <span style={{ fontSize: 11, color: '#8b949e' }}>
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </div>

          {error && (
            <div style={{ background: '#f8514918', border: '1px solid #f85149', borderRadius: 8, padding: '12px 16px', color: '#f85149', marginBottom: 16 }}>
              {error}
            </div>
          )}

          {loading && !rows && (
            <div style={{ textAlign: 'center', padding: 40, color: '#8b949e' }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>⟳</div>
              Fetching ATR data for 15 instruments...
            </div>
          )}

          {rows && (
            <>
              {/* Volatility Table */}
              <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, marginBottom: 20, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #30363d' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Volatility Table — sorted by H1 ATR
                  </span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#0d1117' }}>
                        {['Pair','H1 ATR (pips)','Daily ATR (pips)','Spread (pips)','Rank','Volatility'].map(h => (
                          <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: '#8b949e', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, idx) => {
                        const activePips = view === 'h1' ? row.h1Pips : row.dPips;
                        const barPct = activePips != null ? Math.min((activePips / maxPips) * 100, 100) : 0;
                        const barColor = row.rank?.color || '#8b949e';
                        return (
                          <tr key={row.key} style={{ borderTop: '1px solid #30363d22', background: idx % 2 === 0 ? 'transparent' : '#0d111755' }}>
                            <td style={{ padding: '10px 14px', fontWeight: 700, fontFamily: 'monospace', color: '#e6edf3', whiteSpace: 'nowrap' }}>
                              {row.label}
                            </td>
                            <td style={{ padding: '10px 14px', fontFamily: 'monospace', color: '#e6edf3' }}>
                              {row.h1Pips != null ? row.h1Pips : '—'}
                            </td>
                            <td style={{ padding: '10px 14px', fontFamily: 'monospace', color: '#8b949e' }}>
                              {row.dPips != null ? row.dPips : '—'}
                            </td>
                            <td style={{ padding: '10px 14px', fontFamily: 'monospace', color: '#8b949e' }}>
                              {row.spreadPips != null ? row.spreadPips : '—'}
                            </td>
                            <td style={{ padding: '10px 14px' }}>
                              {row.rank ? (
                                <span style={{
                                  fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                                  color: row.rank.color, background: `${row.rank.color}18`,
                                  border: `1px solid ${row.rank.color}44`,
                                }}>{row.rank.label}</span>
                              ) : '—'}
                            </td>
                            <td style={{ padding: '10px 14px', minWidth: 120 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div style={{ flex: 1, height: 8, background: '#0d1117', borderRadius: 4, overflow: 'hidden' }}>
                                  <div style={{ width: `${barPct}%`, height: '100%', background: barColor, borderRadius: 4, transition: 'width 0.5s ease' }} />
                                </div>
                                <span style={{ fontSize: 11, color: '#8b949e', fontFamily: 'monospace', minWidth: 36 }}>
                                  {activePips != null ? `${activePips}p` : '—'}
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 24h Heatmap */}
              <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: '16px 20px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#8b949e', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  24h Activity Heatmap (UTC)
                </div>
                <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 16 }}>
                  Current hour: <strong style={{ color: '#58a6ff' }}>{String(currentHour).padStart(2,'0')}:00 UTC</strong>
                  &nbsp;·&nbsp;Asian session 00–09 · London 07–16 · New York 13–21 · Overlap 13–16
                </div>

                {/* Hour labels */}
                <div style={{ display: 'grid', gridTemplateColumns: '80px repeat(24, 1fr)', gap: 2, marginBottom: 2 }}>
                  <div />
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} style={{
                      fontSize: 9, color: h === currentHour ? '#58a6ff' : '#8b949e',
                      textAlign: 'center', fontWeight: h === currentHour ? 700 : 400,
                    }}>{h}</div>
                  ))}
                </div>

                {HEATMAP_PAIRS.map(pair => (
                  <div key={pair} style={{ display: 'grid', gridTemplateColumns: '80px repeat(24, 1fr)', gap: 2, marginBottom: 2 }}>
                    <div style={{ fontSize: 11, color: '#8b949e', display: 'flex', alignItems: 'center', fontFamily: 'monospace' }}>
                      {pair}
                    </div>
                    {(HEATMAP[pair] || []).map((level, h) => (
                      <div key={h} style={{
                        height: 20, borderRadius: 3,
                        background: heatmapColor(level),
                        border: h === currentHour ? '1px solid #58a6ff' : '1px solid transparent',
                      }} title={`${pair} ${h}:00 UTC`} />
                    ))}
                  </div>
                ))}

                {/* Legend */}
                <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
                  {[
                    { color: '#1f3a2a', label: 'Low activity' },
                    { color: '#d29922', label: 'Medium activity' },
                    { color: '#3fb950', label: 'High activity' },
                  ].map(({ color, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#8b949e' }}>
                      <div style={{ width: 14, height: 14, background: color, borderRadius: 3 }} />
                      {label}
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#8b949e' }}>
                    <div style={{ width: 14, height: 14, background: 'transparent', border: '1px solid #58a6ff', borderRadius: 3 }} />
                    Current hour
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

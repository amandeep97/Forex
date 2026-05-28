import { useState, useEffect, useCallback } from 'react';

const INSTRUMENTS = [
  { key: 'EUR_USD', label: 'EUR/USD', roundSmall: 0.0050, roundLarge: 0.0100, pipSize: 0.0001 },
  { key: 'GBP_USD', label: 'GBP/USD', roundSmall: 0.0050, roundLarge: 0.0100, pipSize: 0.0001 },
  { key: 'USD_JPY', label: 'USD/JPY', roundSmall: 0.50,   roundLarge: 1.00,   pipSize: 0.01   },
  { key: 'USD_CHF', label: 'USD/CHF', roundSmall: 0.0050, roundLarge: 0.0100, pipSize: 0.0001 },
  { key: 'AUD_USD', label: 'AUD/USD', roundSmall: 0.0050, roundLarge: 0.0100, pipSize: 0.0001 },
  { key: 'USD_CAD', label: 'USD/CAD', roundSmall: 0.0050, roundLarge: 0.0100, pipSize: 0.0001 },
  { key: 'NZD_USD', label: 'NZD/USD', roundSmall: 0.0050, roundLarge: 0.0100, pipSize: 0.0001 },
  { key: 'XAU_USD', label: 'XAU/USD', roundSmall: 10,     roundLarge: 50,     pipSize: 0.1    },
  { key: 'XAG_USD', label: 'XAG/USD', roundSmall: 0.25,   roundLarge: 0.50,   pipSize: 0.01   },
  { key: 'EUR_JPY', label: 'EUR/JPY', roundSmall: 0.50,   roundLarge: 1.00,   pipSize: 0.01   },
  { key: 'GBP_JPY', label: 'GBP/JPY', roundSmall: 0.50,   roundLarge: 1.00,   pipSize: 0.01   },
];

const TYPE_COLORS = {
  'Weekly R1':   { color: '#58a6ff', bg: '#58a6ff18', label: 'W-R1'  },
  'Weekly R2':   { color: '#58a6ff', bg: '#58a6ff18', label: 'W-R2'  },
  'Weekly R3':   { color: '#58a6ff', bg: '#58a6ff18', label: 'W-R3'  },
  'Weekly PP':   { color: '#58a6ff', bg: '#58a6ff18', label: 'W-PP'  },
  'Weekly S1':   { color: '#58a6ff', bg: '#58a6ff18', label: 'W-S1'  },
  'Weekly S2':   { color: '#58a6ff', bg: '#58a6ff18', label: 'W-S2'  },
  'Weekly S3':   { color: '#58a6ff', bg: '#58a6ff18', label: 'W-S3'  },
  'Monthly R1':  { color: '#a371f7', bg: '#a371f718', label: 'M-R1'  },
  'Monthly R2':  { color: '#a371f7', bg: '#a371f718', label: 'M-R2'  },
  'Monthly R3':  { color: '#a371f7', bg: '#a371f718', label: 'M-R3'  },
  'Monthly PP':  { color: '#a371f7', bg: '#a371f718', label: 'M-PP'  },
  'Monthly S1':  { color: '#a371f7', bg: '#a371f718', label: 'M-S1'  },
  'Monthly S2':  { color: '#a371f7', bg: '#a371f718', label: 'M-S2'  },
  'Monthly S3':  { color: '#a371f7', bg: '#a371f718', label: 'M-S3'  },
  'Round Number':       { color: '#d29922', bg: '#d2992218', label: 'RND' },
  'Big Round Number':   { color: '#d29922', bg: '#d2992218', label: 'BIG' },
  'Equal Highs':        { color: '#bc8cff', bg: '#bc8cff18', label: 'EQH' },
  'Equal Lows':         { color: '#bc8cff', bg: '#bc8cff18', label: 'EQL' },
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

function calcPivots(h, l, c, prefix) {
  const pp = (h + l + c) / 3;
  return [
    { type: `${prefix} PP`, price: pp },
    { type: `${prefix} R1`, price: 2 * pp - l },
    { type: `${prefix} R2`, price: pp + (h - l) },
    { type: `${prefix} R3`, price: h + 2 * (pp - l) },
    { type: `${prefix} S1`, price: 2 * pp - h },
    { type: `${prefix} S2`, price: pp - (h - l) },
    { type: `${prefix} S3`, price: l - 2 * (h - pp) },
  ];
}

function generateRoundLevels(currentPrice, roundSmall, roundLarge, count = 10) {
  const levels = [];
  // Nearest small rounds
  const baseSmall = Math.round(currentPrice / roundSmall) * roundSmall;
  for (let i = -count; i <= count; i++) {
    if (i === 0) continue;
    const price = +(baseSmall + i * roundSmall).toFixed(8);
    levels.push({ type: 'Round Number', price });
  }
  // Big rounds
  const baseLarge = Math.round(currentPrice / roundLarge) * roundLarge;
  for (let i = -count; i <= count; i++) {
    if (i === 0) continue;
    const price = +(baseLarge + i * roundLarge).toFixed(8);
    levels.push({ type: 'Big Round Number', price });
  }
  return levels;
}

function findEqualHighsLows(candles, pipSize) {
  const tolerance = 0.5 * pipSize;
  const highs = candles.map((c, i) => ({ price: parseFloat(c.mid.h), idx: i }));
  const lows  = candles.map((c, i) => ({ price: parseFloat(c.mid.l), idx: i }));
  const eqH = [];
  const eqL = [];

  // Find groups of equal highs
  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      if (Math.abs(highs[i].price - highs[j].price) <= tolerance) {
        const mid = (highs[i].price + highs[j].price) / 2;
        if (!eqH.some(l => Math.abs(l.price - mid) < tolerance * 2)) {
          eqH.push({ type: 'Equal Highs', price: +mid.toFixed(8) });
        }
      }
    }
  }
  // Find groups of equal lows
  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      if (Math.abs(lows[i].price - lows[j].price) <= tolerance) {
        const mid = (lows[i].price + lows[j].price) / 2;
        if (!eqL.some(l => Math.abs(l.price - mid) < tolerance * 2)) {
          eqL.push({ type: 'Equal Lows', price: +mid.toFixed(8) });
        }
      }
    }
  }

  return [...eqH.slice(0, 5), ...eqL.slice(0, 5)];
}

function formatPrice(price, pipSize) {
  if (pipSize >= 0.01 && pipSize < 0.1) return price.toFixed(3);
  if (pipSize >= 0.1) return price.toFixed(2);
  return price.toFixed(5);
}

export default function LiquidityMap() {
  const [selectedPair, setSelectedPair] = useState('EUR_USD');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [levels, setLevels] = useState(null);
  const [currentPrice, setCurrentPrice] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const creds = getOandaCreds();
  const hasKey = !!creds;
  const inst = INSTRUMENTS.find(i => i.key === selectedPair);

  const fetchData = useCallback(async () => {
    const c = getOandaCreds();
    if (!c) return;
    const baseUrl = c.practice
      ? 'https://api-fxpractice.oanda.com/v3'
      : 'https://api-fxtrade.oanda.com/v3';
    const { key, roundSmall, roundLarge, pipSize } = INSTRUMENTS.find(i => i.key === selectedPair);

    setLoading(true);
    setError('');
    setLevels(null);

    try {
      const [dailyRes, weeklyRes, monthlyRes] = await Promise.all([
        fetch(`${baseUrl}/instruments/${key}/candles?granularity=D&count=50&price=M`, {
          headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(10000),
        }).then(r => r.json()),
        fetch(`${baseUrl}/instruments/${key}/candles?granularity=W&count=8&price=M`, {
          headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(10000),
        }).then(r => r.json()),
        fetch(`${baseUrl}/instruments/${key}/candles?granularity=M&count=3&price=M`, {
          headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(10000),
        }).then(r => r.json()),
      ]);

      const dCandles = (dailyRes.candles || []).filter(c => c.complete);
      const wCandles = (weeklyRes.candles || []).filter(c => c.complete);
      const mCandles = (monthlyRes.candles || []).filter(c => c.complete);

      if (dCandles.length === 0) throw new Error('No daily candle data returned');

      // Current price from latest daily close (or incomplete candle)
      const allDaily = dailyRes.candles || [];
      const latestCandle = allDaily[allDaily.length - 1];
      const price = parseFloat(latestCandle.mid.c);
      setCurrentPrice(price);

      // Weekly pivots
      let allLevels = [];
      if (wCandles.length >= 1) {
        const wc = wCandles[wCandles.length - 1];
        const wH = parseFloat(wc.mid.h), wL = parseFloat(wc.mid.l), wC = parseFloat(wc.mid.c);
        allLevels.push(...calcPivots(wH, wL, wC, 'Weekly'));
      }

      // Monthly pivots
      if (mCandles.length >= 1) {
        const mc = mCandles[mCandles.length - 1];
        const mH = parseFloat(mc.mid.h), mL = parseFloat(mc.mid.l), mC = parseFloat(mc.mid.c);
        allLevels.push(...calcPivots(mH, mL, mC, 'Monthly'));
      }

      // Round numbers
      allLevels.push(...generateRoundLevels(price, roundSmall, roundLarge, 10));

      // Equal highs/lows
      allLevels.push(...findEqualHighsLows(dCandles, pipSize));

      // Deduplicate levels that are within 2 pips
      const deduped = [];
      for (const lvl of allLevels) {
        const tooClose = deduped.some(d => Math.abs(d.price - lvl.price) < pipSize * 2);
        if (!tooClose) deduped.push(lvl);
      }

      // Add distance in pips and sort by price
      const withDist = deduped.map(lvl => ({
        ...lvl,
        distPips: +((lvl.price - price) / pipSize).toFixed(1),
        above: lvl.price > price,
      })).sort((a, b) => b.price - a.price);

      // Take 10 above and 10 below
      const above = withDist.filter(l => l.above).slice(-10).reverse();
      const below = withDist.filter(l => !l.above).slice(0, 10);
      setLevels([...above, ...below]);
      setLastUpdated(new Date());
    } catch (e) {
      setError(`Failed to fetch data: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedPair]);

  useEffect(() => {
    if (hasKey) fetchData();
  }, [fetchData, hasKey]);

  const btnBase = {
    border: '1px solid #30363d', borderRadius: 6, padding: '6px 14px',
    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
  };

  return (
    <div style={{ padding: 20, color: '#e6edf3', fontFamily: 'system-ui, sans-serif', background: '#0d1117', minHeight: '100%' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#e6edf3', margin: '0 0 4px' }}>
          Liquidity Map
        </h2>
        <p style={{ fontSize: 13, color: '#8b949e', margin: 0 }}>
          Key institutional levels — pivot points, round numbers, and stop clusters near current price
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
              value={selectedPair}
              onChange={e => setSelectedPair(e.target.value)}
              style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3', borderRadius: 6, padding: '6px 10px', fontSize: 13, cursor: 'pointer' }}
            >
              {INSTRUMENTS.map(i => <option key={i.key} value={i.key}>{i.label}</option>)}
            </select>
            <button onClick={fetchData} disabled={loading} style={{ ...btnBase, background: '#21262d', color: '#e6edf3' }}>
              {loading ? '⟳ Loading...' : '↻ Refresh'}
            </button>
            {lastUpdated && (
              <span style={{ fontSize: 11, color: '#8b949e' }}>
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            {currentPrice && inst && (
              <span style={{ fontSize: 13, fontFamily: 'monospace', color: '#3fb950', fontWeight: 700, marginLeft: 8 }}>
                Current: {formatPrice(currentPrice, inst.pipSize)}
              </span>
            )}
          </div>

          {error && (
            <div style={{ background: '#f8514918', border: '1px solid #f85149', borderRadius: 8, padding: '12px 16px', color: '#f85149', marginBottom: 16 }}>
              {error}
            </div>
          )}

          {loading && (
            <div style={{ textAlign: 'center', padding: 40, color: '#8b949e' }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>⟳</div>
              Calculating liquidity levels...
            </div>
          )}

          {levels && inst && currentPrice && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16, maxWidth: 1100 }}>
              {/* Price Ladder */}
              <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #30363d' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Price Ladder — {inst.label}
                  </span>
                </div>
                <div>
                  {levels.map((lvl, i) => {
                    const isAbove = lvl.above;
                    const tc = TYPE_COLORS[lvl.type] || { color: '#8b949e', bg: '#8b949e18', label: '?' };
                    return (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '9px 16px',
                        borderBottom: '1px solid #30363d22',
                        background: 'transparent',
                      }}>
                        <span style={{
                          fontFamily: 'monospace', fontWeight: 700, fontSize: 14,
                          color: isAbove ? '#3fb950' : '#f85149', minWidth: 80,
                        }}>
                          {formatPrice(lvl.price, inst.pipSize)}
                        </span>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                          color: tc.color, background: tc.bg, border: `1px solid ${tc.color}44`,
                          minWidth: 36, textAlign: 'center',
                        }}>
                          {tc.label}
                        </span>
                        <span style={{ fontSize: 13, color: '#8b949e', flex: 1 }}>
                          {lvl.type}
                        </span>
                        <span style={{ fontSize: 12, fontFamily: 'monospace', color: isAbove ? '#3fb950' : '#f85149', minWidth: 70, textAlign: 'right' }}>
                          {isAbove ? '+' : ''}{lvl.distPips} pips
                        </span>
                      </div>
                    );
                  })}

                  {/* Current price row */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '11px 16px',
                    background: '#1f6feb22', border: '1px solid #1f6feb55',
                    margin: '0 8px',
                    borderRadius: 6,
                  }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 15, color: '#58a6ff', minWidth: 80 }}>
                      {formatPrice(currentPrice, inst.pipSize)}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#58a6ff' }}>
                      ← CURRENT PRICE
                    </span>
                  </div>
                </div>
              </div>

              {/* Institutional Notes Panel */}
              <div>
                <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: '16px', marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#8b949e', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Level Types
                  </div>
                  {[
                    { color: '#58a6ff', label: 'Weekly Pivots', desc: 'Calculated from last completed week\'s H/L/C. PP = (H+L+C)/3. Major R/S levels used by institutions.' },
                    { color: '#a371f7', label: 'Monthly Pivots', desc: 'Same formula using last month\'s data. Longer-term institutional reference levels.' },
                    { color: '#d29922', label: 'Round Numbers', desc: 'Banks and algorithms cluster orders at round price levels (0.0050 / 0.0100 increments). Strong S/R zones.' },
                    { color: '#bc8cff', label: 'Equal Highs/Lows', desc: 'Multiple candles touching same price = liquidity pool. Institutions hunt these stops. Expect breakout or reversal.' },
                  ].map(item => (
                    <div key={item.label} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #30363d22' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <div style={{ width: 10, height: 10, borderRadius: 2, background: item.color }} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3' }}>{item.label}</span>
                      </div>
                      <p style={{ fontSize: 11, color: '#8b949e', margin: 0, lineHeight: 1.6 }}>{item.desc}</p>
                    </div>
                  ))}
                </div>

                <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#8b949e', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Note
                  </div>
                  <p style={{ fontSize: 11, color: '#8b949e', margin: 0, lineHeight: 1.6 }}>
                    True CME options data requires a paid subscription. These levels are algorithmic proxies
                    that institutional traders actively watch. Use confluence of multiple level types for
                    highest probability entries.
                  </p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

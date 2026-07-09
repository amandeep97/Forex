import { useState, useEffect, useCallback } from 'react';

const PAIRS = [
  'EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','USD_CAD','NZD_USD',
  'EUR_GBP','EUR_JPY','GBP_JPY','AUD_JPY','EUR_CHF','GBP_CHF','AUD_CAD',
];

const CURRENCIES = ['USD','EUR','GBP','JPY','CHF','AUD','CAD','NZD'];

const FLAGS = {
  USD:'🇺🇸', EUR:'🇪🇺', GBP:'🇬🇧', JPY:'🇯🇵',
  CHF:'🇨🇭', AUD:'🇦🇺', CAD:'🇨🇦', NZD:'🇳🇿',
};

// Extended pairs list for setup matching
const SETUP_PAIRS = [
  'EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','USD_CAD','NZD_USD',
  'EUR_GBP','EUR_JPY','GBP_JPY','AUD_JPY','EUR_CHF','GBP_CHF','AUD_CAD',
  'EUR_CAD','EUR_AUD','GBP_AUD','GBP_CAD','NZD_JPY','CHF_JPY','USD_NZD',
];

const TF_OPTIONS = ['M15','H1','H4','D'];
const PERIOD_OPTIONS = [10, 20, 50];

function getOandaCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) { const _e = localStorage.getItem('oanda_env'); return _e !== null ? { ...c, practice: _e !== 'live' } : c; }
  } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}

function getBarColor(score) {
  if (score > 70) return '#3fb950';
  if (score >= 40) return '#d29922';
  return '#f85149';
}

function getLabel(score) {
  if (score > 70) return { text: 'STRONG', color: '#3fb950', bg: '#3fb95018' };
  if (score >= 40) return { text: 'NEUTRAL', color: '#d29922', bg: '#d2992218' };
  return { text: 'WEAK', color: '#f85149', bg: '#f8514918' };
}

function findPair(base, quote) {
  const direct = `${base}_${quote}`;
  const inverse = `${quote}_${base}`;
  if (SETUP_PAIRS.includes(direct)) return { pair: direct, invert: false };
  if (SETUP_PAIRS.includes(inverse)) return { pair: inverse, invert: true };
  return null;
}

export default function CurrencyStrength() {
  const [tf, setTf] = useState('H1');
  const [period, setPeriod] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scores, setScores] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const creds = getOandaCreds();
  const hasKey = !!creds;

  const fetchStrength = useCallback(async () => {
    const c = getOandaCreds();
    if (!c) return;
    const base = c.practice
      ? 'https://api-fxpractice.oanda.com/v3'
      : 'https://api-fxtrade.oanda.com/v3';

    setLoading(true);
    setError('');

    try {
      const count = period + 1;
      const results = await Promise.all(
        PAIRS.map(pair =>
          fetch(
            `${base}/instruments/${pair}/candles?granularity=${tf}&count=${count}&price=M`,
            { headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(10000) }
          ).then(r => r.json()).catch(() => null)
        )
      );

      const acc = {};
      CURRENCIES.forEach(cur => { acc[cur] = { sum: 0, n: 0 }; });

      results.forEach((data, i) => {
        if (!data) return;
        const pair = PAIRS[i];
        const candles = data.candles || [];
        if (candles.length < 2) return;
        const openPrice  = parseFloat(candles[0].mid.o);
        const closePrice = parseFloat(candles[candles.length - 1].mid.c);
        if (!openPrice || !closePrice) return;
        const pct = ((closePrice - openPrice) / openPrice) * 100;
        const [baseCur, quoteCur] = pair.split('_');
        if (acc[baseCur])  { acc[baseCur].sum  += pct; acc[baseCur].n  += 1; }
        if (acc[quoteCur]) { acc[quoteCur].sum -= pct; acc[quoteCur].n += 1; }
      });

      const rawScores = {};
      CURRENCIES.forEach(cur => {
        rawScores[cur] = acc[cur].n > 0 ? acc[cur].sum / acc[cur].n : 0;
      });

      const vals = Object.values(rawScores);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const range = max - min || 1;

      const normalized = {};
      CURRENCIES.forEach(cur => {
        normalized[cur] = Math.round(((rawScores[cur] - min) / range) * 100);
      });

      const sorted = CURRENCIES
        .map(cur => ({ currency: cur, score: normalized[cur], raw: rawScores[cur] }))
        .sort((a, b) => b.score - a.score);

      setScores(sorted);
      setLastUpdated(new Date());
    } catch (e) {
      setError(`Failed to fetch data: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [tf, period]);

  useEffect(() => {
    if (hasKey) fetchStrength();
  }, [fetchStrength, hasKey]);

  // Build best setups: top 3 strongest vs bottom 3 weakest
  const setups = [];
  if (scores) {
    const strong = scores.slice(0, 3);
    const weak = [...scores].reverse().slice(0, 3);
    for (const st of strong) {
      for (const wk of weak) {
        if (st.currency === wk.currency) continue;
        const found = findPair(st.currency, wk.currency);
        if (found) {
          const dir = found.invert ? 'SHORT' : 'LONG';
          setups.push({
            pair: found.pair.replace('_', '/'),
            dir,
            strong: st.currency,
            weak: wk.currency,
            diff: st.score - wk.score,
          });
        }
      }
    }
    setups.sort((a, b) => b.diff - a.diff);
    setups.splice(5);
  }

  const btnBase = {
    border: '1px solid #30363d', borderRadius: 6, padding: '6px 14px',
    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
  };

  return (
    <div style={{ padding: 20, color: '#e6edf3', fontFamily: 'system-ui, sans-serif', background: '#0d1117', minHeight: '100%' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#e6edf3', margin: '0 0 4px' }}>
          Currency Strength Meter
        </h2>
        <p style={{ fontSize: 13, color: '#8b949e', margin: 0 }}>
          Relative strength of 8 major currencies computed from 14 pairs
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
          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: '#8b949e' }}>Timeframe:</span>
            {TF_OPTIONS.map(t => (
              <button key={t} onClick={() => setTf(t)} style={{
                ...btnBase,
                background: tf === t ? '#1f6feb' : '#21262d',
                borderColor: tf === t ? '#1f6feb' : '#30363d',
                color: tf === t ? '#fff' : '#e6edf3',
              }}>{t}</button>
            ))}
            <span style={{ fontSize: 12, color: '#8b949e', marginLeft: 8 }}>Bars:</span>
            {PERIOD_OPTIONS.map(p => (
              <button key={p} onClick={() => setPeriod(p)} style={{
                ...btnBase,
                background: period === p ? '#1f6feb' : '#21262d',
                borderColor: period === p ? '#1f6feb' : '#30363d',
                color: period === p ? '#fff' : '#e6edf3',
              }}>{p}</button>
            ))}
            <button onClick={fetchStrength} disabled={loading} style={{
              ...btnBase, background: '#21262d', color: '#e6edf3', marginLeft: 8,
            }}>
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

          {loading && !scores && (
            <div style={{ textAlign: 'center', padding: 40, color: '#8b949e' }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>⟳</div>
              Fetching candles for 14 pairs...
            </div>
          )}

          {scores && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, maxWidth: 1100 }}>
              {/* Rankings card */}
              <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: '16px 20px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#8b949e', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Currency Rankings — {tf} · {period} bars
                </div>
                {scores.map((item, idx) => {
                  const lbl = getLabel(item.score);
                  const barColor = getBarColor(item.score);
                  return (
                    <div key={item.currency} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                      <span style={{ width: 20, textAlign: 'right', fontSize: 12, color: '#8b949e', fontWeight: 600 }}>
                        #{idx + 1}
                      </span>
                      <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>{FLAGS[item.currency]}</span>
                      <span style={{ width: 36, fontSize: 13, fontWeight: 700, color: '#e6edf3', fontFamily: 'monospace' }}>
                        {item.currency}
                      </span>
                      <div style={{ flex: 1, height: 10, background: '#0d1117', borderRadius: 5, overflow: 'hidden' }}>
                        <div style={{
                          width: `${item.score}%`, height: '100%',
                          background: barColor, borderRadius: 5,
                          transition: 'width 0.6s ease',
                        }} />
                      </div>
                      <span style={{ width: 30, textAlign: 'right', fontSize: 12, fontFamily: 'monospace', color: '#e6edf3' }}>
                        {item.score}
                      </span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                        minWidth: 54, textAlign: 'center',
                        color: lbl.color, background: lbl.bg, border: `1px solid ${lbl.color}44`,
                      }}>
                        {lbl.text}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Best Setups card */}
              <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: '16px 20px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#8b949e', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Best Trade Setups
                </div>
                {setups.length === 0 ? (
                  <div style={{ color: '#8b949e', fontSize: 13 }}>No matching pairs found for current rankings.</div>
                ) : (
                  setups.map((setup, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '10px 12px', background: '#0d1117', borderRadius: 8 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                        background: setup.dir === 'LONG' ? '#3fb95018' : '#f8514918',
                        color: setup.dir === 'LONG' ? '#3fb950' : '#f85149',
                        border: `1px solid ${setup.dir === 'LONG' ? '#3fb950' : '#f85149'}44`,
                        minWidth: 44, textAlign: 'center',
                      }}>{setup.dir}</span>
                      <span style={{ fontWeight: 700, fontSize: 14, fontFamily: 'monospace', color: '#e6edf3', width: 72 }}>
                        {setup.pair}
                      </span>
                      <span style={{ fontSize: 12, color: '#8b949e', flex: 1 }}>
                        {FLAGS[setup.strong]} {setup.strong} strong · {FLAGS[setup.weak]} {setup.weak} weak
                      </span>
                      <span style={{ fontSize: 11, color: '#58a6ff', fontFamily: 'monospace' }}>
                        +{setup.diff}pt
                      </span>
                    </div>
                  ))
                )}
                <div style={{ marginTop: 16, padding: '10px 12px', background: '#0d1117', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#8b949e', marginBottom: 6, textTransform: 'uppercase' }}>How it works</div>
                  <div style={{ fontSize: 12, color: '#8b949e', lineHeight: 1.6 }}>
                    Scores derived from % price change over <strong style={{ color: '#e6edf3' }}>{period} bars</strong> across 14 pairs.
                    Base currency gains score; quote currency loses it.
                    Normalized 0–100. Best setups pair the strongest vs weakest currency.
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

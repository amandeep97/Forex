import { useState, useMemo, useRef, useEffect } from 'react';
import { generateCandles } from '../utils/generateCandles';
import { detectCandlePatterns } from '../utils/candlePatterns';

const TIMEFRAMES = ['1M', '5M', '15M', '1H', '4H', 'D'];

const PATTERN_COLORS = {
  bullish: '#22c55e',
  bearish: '#ef4444',
  neutral: '#94a3b8',
};
const STRENGTH_OPACITY = { strong: 1, medium: 0.75, weak: 0.5 };

function fmtPrice(v, instrument) {
  if (!v && v !== 0) return '—';
  if (v >= 10000) return v.toFixed(0);
  if (v >= 100)   return v.toFixed(2);
  if (v >= 1)     return v.toFixed(4);
  return v.toFixed(5);
}

function fmtTime(ts, tf) {
  const d = new Date(ts);
  if (tf === 'D') return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function CandleChart({ instrument, onClose }) {
  const [timeframe, setTimeframe] = useState('1H');
  const [hover, setHover]         = useState(null);
  const svgRef = useRef(null);

  const candles = useMemo(
    () => generateCandles(instrument, timeframe, 80),
    [instrument, timeframe]
  );

  const patterns = useMemo(() => detectCandlePatterns(candles, 12), [candles]);

  // Chart dimensions
  const W = 800, H = 340, VOL_H = 60, PAD = { top: 14, right: 64, bottom: 24, left: 8 };
  const chartH = H - VOL_H - 8;

  const priceMin = Math.min(...candles.map(c => c.l));
  const priceMax = Math.max(...candles.map(c => c.h));
  const priceRange = priceMax - priceMin || 1;
  const volMax = Math.max(...candles.map(c => c.v)) || 1;

  const cw     = (W - PAD.left - PAD.right) / candles.length;
  const bodyW  = Math.max(1, cw * 0.7);

  const py = (price) => PAD.top + chartH - ((price - priceMin) / priceRange) * chartH;
  const cx = (i)     => PAD.left + i * cw + cw / 2;
  const vy = (v)     => H - PAD.bottom - (v / volMax) * VOL_H;

  // Price grid lines
  const gridPrices = useMemo(() => {
    const steps = 5;
    return Array.from({ length: steps + 1 }, (_, i) => priceMin + (priceRange / steps) * i);
  }, [priceMin, priceRange]);

  // Pattern index map: candlesAgo → pattern
  const patternAtCandle = useMemo(() => {
    const map = {};
    patterns.forEach(p => {
      const idx = candles.length - 1 - p.candlesAgo;
      if (!map[idx]) map[idx] = [];
      map[idx].push(p);
    });
    return map;
  }, [patterns, candles.length]);

  const handleMouseMove = (e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const i = Math.floor((x - PAD.left) / cw);
    if (i >= 0 && i < candles.length) setHover(i);
  };

  const hc = hover !== null ? candles[hover] : candles[candles.length - 1];

  return (
    <div className="candle-chart-overlay">
      <div className="candle-chart-box">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="cc-header">
          <div>
            <span className="cc-symbol">{instrument.symbol}</span>
            <span className="cc-category">{instrument.assetType} · {instrument.category}</span>
          </div>

          {/* OHLCV readout */}
          {hc && (
            <div className="cc-ohlcv">
              <span>O <strong style={{ color: '#94a3b8' }}>{fmtPrice(hc.o, instrument)}</strong></span>
              <span>H <strong style={{ color: '#22c55e' }}>{fmtPrice(hc.h, instrument)}</strong></span>
              <span>L <strong style={{ color: '#ef4444' }}>{fmtPrice(hc.l, instrument)}</strong></span>
              <span>C <strong style={{ color: hc.c >= hc.o ? '#22c55e' : '#ef4444' }}>{fmtPrice(hc.c, instrument)}</strong></span>
              <span className="cc-vol">Vol <strong>{hc.v.toLocaleString()}</strong></span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Timeframe selector */}
            <div className="cc-tf-row">
              {TIMEFRAMES.map(tf => (
                <button
                  key={tf}
                  className={`cc-tf-btn ${timeframe === tf ? 'active' : ''}`}
                  onClick={() => setTimeframe(tf)}
                >{tf}</button>
              ))}
            </div>
            <button className="cc-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* ── SVG Chart ───────────────────────────────────────────────── */}
        <div className="cc-svg-wrap">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            style={{ display: 'block', cursor: 'crosshair' }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* Grid lines */}
            {gridPrices.map((p, i) => (
              <g key={i}>
                <line x1={PAD.left} y1={py(p)} x2={W - PAD.right} y2={py(p)}
                  stroke="#1e2a3d" strokeWidth="1" />
                <text x={W - PAD.right + 4} y={py(p) + 4}
                  fill="#475569" fontSize="9" fontFamily="JetBrains Mono">
                  {fmtPrice(p, instrument)}
                </text>
              </g>
            ))}

            {/* Volume bars */}
            {candles.map((c, i) => (
              <rect
                key={`v${i}`}
                x={cx(i) - bodyW / 2}
                y={vy(c.v)}
                width={bodyW}
                height={H - PAD.bottom - vy(c.v)}
                fill={c.c >= c.o ? '#22c55e22' : '#ef444422'}
              />
            ))}

            {/* Vol divider */}
            <line x1={PAD.left} y1={H - PAD.bottom - VOL_H} x2={W - PAD.right} y2={H - PAD.bottom - VOL_H}
              stroke="#1e2a3d" strokeWidth="1" strokeDasharray="3,3" />

            {/* Candles */}
            {candles.map((c, i) => {
              const green   = c.c >= c.o;
              const color   = green ? '#22c55e' : '#ef4444';
              const bodyTop = py(Math.max(c.o, c.c));
              const bodyBot = py(Math.min(c.o, c.c));
              const bh      = Math.max(1, bodyBot - bodyTop);
              const pats    = patternAtCandle[i];
              const isHov   = hover === i;
              return (
                <g key={i}>
                  {/* Highlight */}
                  {isHov && (
                    <rect x={cx(i) - cw / 2} y={PAD.top} width={cw} height={chartH}
                      fill="#ffffff06" />
                  )}
                  {/* Pattern marker */}
                  {pats && (
                    <circle
                      cx={cx(i)} cy={py(c.h) - 8} r={4}
                      fill={PATTERN_COLORS[pats[0].type]}
                      opacity={STRENGTH_OPACITY[pats[0].strength]}
                    />
                  )}
                  {/* Wick */}
                  <line x1={cx(i)} y1={py(c.h)} x2={cx(i)} y2={py(c.l)}
                    stroke={color} strokeWidth="1" />
                  {/* Body */}
                  <rect
                    x={cx(i) - bodyW / 2} y={bodyTop}
                    width={bodyW} height={bh}
                    fill={green ? color : color}
                    opacity={green ? 0.9 : 0.85}
                    rx="1"
                  />
                  {/* Time label (every ~10 candles) */}
                  {i % Math.max(1, Math.floor(candles.length / 8)) === 0 && (
                    <text x={cx(i)} y={H - 2} textAnchor="middle"
                      fill="#334155" fontSize="8" fontFamily="JetBrains Mono">
                      {fmtTime(c.t, timeframe)}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Crosshair */}
            {hover !== null && (
              <>
                <line x1={cx(hover)} y1={PAD.top} x2={cx(hover)} y2={H - PAD.bottom}
                  stroke="#475569" strokeWidth="1" strokeDasharray="3,3" />
                <line x1={PAD.left} y1={py(hc.c)} x2={W - PAD.right} y2={py(hc.c)}
                  stroke="#475569" strokeWidth="1" strokeDasharray="3,3" />
                <rect x={W - PAD.right + 2} y={py(hc.c) - 8} width={PAD.right - 4} height={14}
                  fill={hc.c >= hc.o ? '#22c55e' : '#ef4444'} rx="2" />
                <text x={W - PAD.right + 4} y={py(hc.c) + 3}
                  fill="#fff" fontSize="8" fontFamily="JetBrains Mono">
                  {fmtPrice(hc.c, instrument)}
                </text>
              </>
            )}
          </svg>
        </div>

        {/* ── Pattern detection results ────────────────────────────────── */}
        <div className="cc-patterns">
          <div className="cc-patterns-title">
            Detected Patterns
            <span style={{ color: '#475569', fontWeight: 400, marginLeft: 8 }}>
              ({patterns.length} found in last {candles.length} candles)
            </span>
          </div>
          {patterns.length === 0 ? (
            <span style={{ color: '#475569', fontSize: 12 }}>No patterns detected in current view</span>
          ) : (
            <div className="cc-pattern-list">
              {patterns.map((p, i) => (
                <div key={i} className="cc-pattern-chip"
                  style={{ borderColor: PATTERN_COLORS[p.type] + '55', background: PATTERN_COLORS[p.type] + '12' }}>
                  <span style={{ color: PATTERN_COLORS[p.type], fontWeight: 700, fontSize: 11 }}>
                    {p.type === 'bullish' ? '▲' : p.type === 'bearish' ? '▼' : '◆'}
                  </span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)' }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: '#475569' }}>
                      {p.signal} · {p.strength} · {p.candlesAgo} candle{p.candlesAgo > 1 ? 's' : ''} ago
                    </div>
                  </div>
                  <span className={`cc-strength-dot strength-${p.strength}`} />
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

import { useState } from 'react';
import ChartModal from './ChartModal';

// ── Inline SVG icons (replacing lucide-react) ─────────────────────────────────
function StarIcon({ filled, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  );
}
function StarOffIcon({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      style={{opacity:0.2}}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
      <line x1="2" y1="2" x2="22" y2="22"/>
    </svg>
  );
}

// ── Sparkline (from candles array {c} format) ─────────────────────────────────
function Sparkline({ candles, width = 60, height = 22 }) {
  if (!candles || candles.length < 2) return <span style={{color:'var(--text3)',fontSize:10}}>—</span>;
  const closes = candles.map(c => c.c);
  const min = Math.min(...closes), max = Math.max(...closes), range = max - min || 1;
  const pts = closes.map((v, i) => {
    const x = (i / (closes.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const isUp = closes[closes.length - 1] >= closes[0];
  return (
    <svg width={width} height={height} style={{overflow:'visible'}}>
      <polyline points={pts} fill="none" stroke={isUp ? '#22c55e' : '#ef4444'}
        strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  );
}

// ── Price formatter ───────────────────────────────────────────────────────────
function fmtPrice(p, symbol) {
  if (!p) return '—';
  const s = symbol || '';
  if (p >= 10000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (s.startsWith('XAU')) return p.toFixed(2);
  if (/^(US|GER|JPN|AUS|UK)/.test(s)) return p.toFixed(1);
  if (s.includes('JPY')) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(5);
}

// ── SMC Badge ─────────────────────────────────────────────────────────────────
const BADGE_STYLES = {
  default: { color:'#94a3b8', background:'#1e293b55', border:'1px solid #334155' },
  blue:    { color:'#60a5fa', background:'#1e40af22', border:'1px solid #3b82f655' },
  green:   { color:'#22c55e', background:'#15803d22', border:'1px solid #22c55e55' },
  red:     { color:'#ef4444', background:'#991b1b22', border:'1px solid #ef444455' },
  yellow:  { color:'#eab308', background:'#78350f22', border:'1px solid #eab30855' },
  teal:    { color:'#00d4aa', background:'#00d4aa12', border:'1px solid #00d4aa44' },
  pink:    { color:'#f472b6', background:'#9d174d22', border:'1px solid #f472b655' },
  purple:  { color:'#a78bfa', background:'#4c1d9522', border:'1px solid #a78bfa55' },
  orange:  { color:'#fb923c', background:'#92400e22', border:'1px solid #fb923c55' },
};
function Badge({ children, variant = 'default' }) {
  return (
    <span style={{
      ...BADGE_STYLES[variant] || BADGE_STYLES.default,
      display:'inline-flex', alignItems:'center', gap:2,
      padding:'1px 5px', borderRadius:3, fontSize:9, fontWeight:700,
    }}>{children}</span>
  );
}

// ── WatchCard ─────────────────────────────────────────────────────────────────
function WatchCard({ item, onOpenChart, onRemove }) {
  const isPos = (item.change || 0) >= 0;
  return (
    <div className="wl-card" onClick={() => onOpenChart(item)}>
      {/* Colored bar */}
      <div style={{width:3,height:40,borderRadius:2,background:isPos?'#22c55e':'#ef4444',flexShrink:0}}/>

      {/* Symbol + SMC badges */}
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:700,color:'var(--text)',lineHeight:1.2}}>{item.symbol}</div>
        <div style={{display:'flex',flexWrap:'wrap',gap:3,marginTop:3}}>
          {item.bos    && <Badge variant="blue">BOS</Badge>}
          {item.choch  && <Badge variant="yellow">ChoCh</Badge>}
          {item.fvg    && <Badge variant={item.fvg==='bullish'?'teal':'pink'}>{item.fvg==='bullish'?'Bull':'Bear'} FVG</Badge>}
          {item.ob     && <Badge variant={item.ob==='bullish'?'green':'red'}>{item.ob==='bullish'?'Bull':'Bear'} OB</Badge>}
          {item.sweep  && <Badge variant="purple">Sweep</Badge>}
          {item.zone==='premium'  && <Badge variant="red">Prem</Badge>}
          {item.zone==='discount' && <Badge variant="green">Disc</Badge>}
          {item.brokeResistance  && <Badge variant="red">BrkR</Badge>}
          {item.brokeSupport     && <Badge variant="green">BrkS</Badge>}
          {item.nearResistance   && !item.brokeResistance && <Badge variant="orange">NrR</Badge>}
          {item.nearSupport      && !item.brokeSupport    && <Badge variant="teal">NrS</Badge>}
          {item.trendlineBreakout  && <Badge variant="blue">TL↑</Badge>}
          {item.trendlineBreakdown && <Badge variant="pink">TL↓</Badge>}
          {item.trendlineBull    && !item.trendlineBreakout  && <Badge variant="teal">TL Bull</Badge>}
          {item.trendlineBear    && !item.trendlineBreakdown && <Badge variant="pink">TL Bear</Badge>}
        </div>
      </div>

      {/* Sparkline */}
      <div style={{flexShrink:0}}>
        <Sparkline candles={item.candles} width={60} height={22}/>
      </div>

      {/* Price + change */}
      <div style={{textAlign:'right',flexShrink:0}}>
        <div style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--text)',fontWeight:600}}>{fmtPrice(item.bid||item.price, item.symbol)}</div>
        <div style={{fontSize:11,fontWeight:700,color:isPos?'#22c55e':'#ef4444'}}>
          {isPos?'+':''}{(item.change||0).toFixed(2)}%
        </div>
      </div>

      {/* Structure badge */}
      {item.structure && (
        <div style={{flexShrink:0}}>
          <Badge variant={item.structure==='bullish'?'green':item.structure==='bearish'?'red':'default'}>
            {item.structure}
          </Badge>
        </div>
      )}

      {/* Star / Remove button */}
      <button
        className="wl-star-btn active"
        title="Remove from watchlist"
        onClick={e => { e.stopPropagation(); onRemove(item.symbol); }}
      >
        <StarIcon filled size={14}/>
      </button>
    </div>
  );
}

// ── WatchlistTab ──────────────────────────────────────────────────────────────
export default function WatchlistTab({ pairs, watchlist, onToggleWatch }) {
  const [chartInst, setChartInst] = useState(null);
  const watched = pairs.filter(p => watchlist.includes(p.symbol));

  return (
    <div className="wl-root">
      {chartInst && <ChartModal instrument={chartInst} onClose={() => setChartInst(null)}/>}

      {/* Header */}
      <div className="wl-header-card">
        <div className="wl-header-icon"><StarIcon filled size={16}/></div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:700,color:'var(--text)'}}>Watchlist</div>
          <div style={{fontSize:11,color:'var(--text3)',marginTop:1}}>
            Star any pair from the Screener to track it here with live data &amp; SMC signals
          </div>
        </div>
        <span style={{fontSize:10,color:'var(--text3)',flexShrink:0}}>{watched.length} pairs</span>
      </div>

      {/* Empty state */}
      {watched.length === 0 ? (
        <div className="wl-empty">
          <StarOffIcon size={36}/>
          <div style={{fontSize:14,fontWeight:600,color:'var(--text2)',marginTop:10}}>No pairs in watchlist</div>
          <div style={{fontSize:12,color:'var(--text3)',marginTop:4}}>
            Go to the <span style={{color:'var(--accent2)',fontWeight:600}}>Screener</span> tab and click the ⭐ icon on any pair to add it here
          </div>
        </div>
      ) : (
        <div className="wl-list-card">
          <div className="wl-list-head">
            <span style={{fontSize:11,color:'var(--text3)'}}>
              <span style={{color:'var(--text)',fontWeight:600}}>{watched.length}</span> watched pairs · live updates every 15s
            </span>
            <button className="wl-clear-btn" onClick={() => watched.forEach(p => onToggleWatch(p.symbol))}>
              Clear all
            </button>
          </div>
          <div className="wl-list-body">
            {watched.map(item => (
              <WatchCard
                key={item.symbol}
                item={item}
                onOpenChart={inst => setChartInst(typeof inst === 'string' ? { symbol: inst } : inst)}
                onRemove={onToggleWatch}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

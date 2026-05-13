import { Star, StarOff, BarChart2 } from 'lucide-react'
import { Sparkline } from './Chart'

function fmtPrice(p) {
  if (p >= 10000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (p >= 1)     return p.toFixed(3)
  if (p >= 0.001) return p.toFixed(5)
  return p.toFixed(8)
}

function Badge({ children, variant = 'default' }) {
  const styles = {
    default: 'bg-slate-700/40 text-slate-400 border-slate-600/40',
    blue:    'bg-blue-900/40 text-blue-400 border-blue-700/40',
    green:   'bg-green-900/40 text-green-400 border-green-700/40',
    red:     'bg-red-900/40 text-red-400 border-red-700/40',
    yellow:  'bg-yellow-900/40 text-yellow-400 border-yellow-700/40',
    teal:    'bg-teal-900/40 text-teal-400 border-teal-700/40',
    pink:    'bg-pink-900/40 text-pink-400 border-pink-700/40',
    purple:  'bg-purple-900/40 text-purple-400 border-purple-700/40',
    orange:  'bg-orange-900/40 text-orange-400 border-orange-700/40',
  }
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold border ${styles[variant]}`}>
      {children}
    </span>
  )
}

function WatchCard({ item, onOpenChart, onRemove }) {
  const isPos = item.change >= 0
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface border border-surface-border hover:border-slate-600 hover:bg-surface-hover transition-all group">
      <div className={`w-1 h-10 rounded-full shrink-0 ${isPos ? 'bg-green-500' : 'bg-red-500'}`} />

      {/* Name + badges */}
      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onOpenChart(item.symbol)}>
        <p className="text-sm font-bold text-slate-100 leading-tight">
          {item.base}<span className="text-slate-600 text-xs font-normal">/USDT</span>
        </p>
        <div className="flex gap-1 mt-0.5 flex-wrap">
          {item.bos    && <Badge variant="blue">BOS</Badge>}
          {item.choch  && <Badge variant="yellow">ChoCh</Badge>}
          {item.fvg    && <Badge variant={item.fvg === 'bullish' ? 'teal' : 'pink'}>{item.fvg === 'bullish' ? 'Bull' : 'Bear'} FVG</Badge>}
          {item.ob     && <Badge variant={item.ob  === 'bullish' ? 'green' : 'red'}>{item.ob === 'bullish' ? 'Bull' : 'Bear'} OB</Badge>}
          {item.sweep  && <Badge variant="purple">Sweep</Badge>}
          {item.zone === 'premium'  && <Badge variant="red">Prem</Badge>}
          {item.zone === 'discount' && <Badge variant="green">Disc</Badge>}
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
      <div className="shrink-0 cursor-pointer" onClick={() => onOpenChart(item.symbol)}>
        <Sparkline candles={item.candles} width={60} height={22} />
      </div>

      {/* Price + change */}
      <div className="text-right shrink-0 cursor-pointer" onClick={() => onOpenChart(item.symbol)}>
        <p className="text-xs font-mono text-slate-200 font-semibold">{fmtPrice(item.price)}</p>
        <p className={`text-xs font-bold ${isPos ? 'text-green-400' : 'text-red-400'}`}>
          {isPos ? '+' : ''}{item.change.toFixed(2)}%
        </p>
      </div>

      {/* Structure */}
      {item.structure && (
        <div className="shrink-0">
          <Badge variant={item.structure === 'bullish' ? 'green' : item.structure === 'bearish' ? 'red' : 'default'}>
            {item.structure}
          </Badge>
        </div>
      )}

      {/* Remove */}
      <button
        onClick={() => onRemove(item.symbol)}
        title="Remove from watchlist"
        className="p-1.5 rounded-lg text-yellow-400 hover:bg-yellow-900/20 transition-colors shrink-0"
      >
        <Star size={14} className="fill-current" />
      </button>
    </div>
  )
}

export default function WatchlistTab({ pairs, watchlist, onToggleWatch, onOpenChart }) {
  const watched = pairs.filter(p => watchlist.includes(p.symbol))

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-yellow-500/20 border border-yellow-500/30 flex items-center justify-center shrink-0">
            <Star size={16} className="text-yellow-400 fill-current" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-100">Watchlist</p>
            <p className="text-[11px] text-slate-500">
              Star any pair from the Screener to track it here with live data &amp; signals
            </p>
          </div>
          <span className="text-[10px] text-slate-500 shrink-0">{watched.length} coins</span>
        </div>
      </div>

      {/* Empty state */}
      {watched.length === 0 ? (
        <div className="bg-surface-card border border-surface-border rounded-xl p-12 text-center text-slate-500">
          <StarOff size={32} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm font-semibold mb-1">No coins in watchlist</p>
          <p className="text-xs text-slate-600">
            Go to the <span className="text-accent-blue font-semibold">Screener</span> tab and click the ⭐ star icon on any pair to add it here
          </p>
        </div>
      ) : (
        <div className="bg-surface-card border border-surface-border rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-surface-border bg-surface-hover flex items-center justify-between">
            <span className="text-[11px] text-slate-500">
              <span className="text-slate-200 font-semibold">{watched.length}</span> watched pairs · live updates every 30s
            </span>
            <button
              onClick={() => watched.forEach(p => onToggleWatch(p.symbol))}
              className="text-[10px] text-slate-600 hover:text-red-400 transition-colors"
            >
              Clear all
            </button>
          </div>
          <div className="p-3 space-y-2">
            {watched.map(item => (
              <WatchCard
                key={item.symbol}
                item={item}
                onOpenChart={onOpenChart}
                onRemove={onToggleWatch}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

import { SlidersHorizontal, RotateCcw, Search, ChevronDown, ChevronUp, BookmarkPlus, Trash2 } from 'lucide-react'
import { useState, useEffect } from 'react'
import {
  STRUCTURES, HTF_BIASES, ZONES, STRUCTURE_TIMEFRAMES, DEFAULT_FILTERS,
} from '../data/forexData'
import { CANDLE_PATTERNS } from '../utils/candlePatterns'

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-surface-border last:border-0">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between py-2.5 px-4 hover:bg-surface-hover transition-colors text-left">
        <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">{title}</span>
        {open ? <ChevronUp size={13} className="text-slate-500" /> : <ChevronDown size={13} className="text-slate-500" />}
      </button>
      {open && <div className="px-4 pb-3 space-y-2.5">{children}</div>}
    </div>
  )
}

function SelectField({ label, value, options, onChange }) {
  return (
    <div>
      {label && <label className="block text-[11px] text-slate-500 mb-1">{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full appearance-none border border-surface-border rounded px-2 py-1.5 text-xs placeholder-slate-500 focus:outline-none focus:border-accent-blue cursor-pointer"
        style={{ colorScheme: 'dark', backgroundColor: '#0f1117', color: '#f8fafc' }}>
        {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
      </select>
    </div>
  )
}

function Toggle({ label, checked, onChange, description }) {
  return (
    <label className="flex items-center justify-between cursor-pointer group">
      <div>
        <span className="text-xs text-slate-300 group-hover:text-slate-200 transition-colors">{label}</span>
        {description && <p className="text-[10px] text-slate-600">{description}</p>}
      </div>
      <div onClick={() => onChange(!checked)} className={`relative w-8 h-4 rounded-full transition-colors ${checked ? 'bg-accent-blue' : 'bg-surface-border'}`}>
        <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </div>
    </label>
  )
}

const SIGNAL_TF_OPTIONS = [
  { value: '15m', label: '15m' }, { value: '30m', label: '30m' },
  { value: '1h',  label: '1H'  }, { value: '2h',  label: '2H'  },
  { value: '4h',  label: '4H'  }, { value: '6h',  label: '6H'  },
  { value: '12h', label: '12H' }, { value: '1d',  label: '1D'  },
  { value: '3d',  label: '3D'  }, { value: '1w',  label: '1W'  },
]

function ToggleWithTF({ label, checked, onChange, tfValue, onTfChange, signalLabel }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs text-slate-300">{label}</span>
          <p className="text-[10px] text-slate-600">{signalLabel} on <span className="text-accent-blue font-semibold">{SIGNAL_TF_OPTIONS.find(t => t.value === tfValue)?.label ?? tfValue}</span></p>
        </div>
        <div onClick={() => onChange(!checked)} className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${checked ? 'bg-accent-blue' : 'bg-surface-border'}`}>
          <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {SIGNAL_TF_OPTIONS.map(tf => (
          <button key={tf.value} onClick={() => onTfChange(tf.value)}
            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${tfValue === tf.value ? 'bg-accent-blue/20 text-accent-blue border-accent-blue/40 font-semibold' : 'text-slate-600 border-surface-border hover:text-slate-300 hover:border-slate-500'}`}>
            {tf.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function RangeRow({ label, minKey, maxKey, minVal, maxVal, step, onChange }) {
  const toStr = v => (v == null || v === '') ? '' : String(v)
  const [minStr, setMinStr] = useState(() => toStr(minVal))
  const [maxStr, setMaxStr] = useState(() => toStr(maxVal))
  useEffect(() => setMinStr(toStr(minVal)), [minVal])
  useEffect(() => setMaxStr(toStr(maxVal)), [maxVal])
  const commitMin = (raw) => { const n = parseFloat(raw); if (!isNaN(n)) onChange(minKey, n); else setMinStr(toStr(minVal)) }
  const commitMax = (raw) => { const n = parseFloat(raw); if (!isNaN(n)) onChange(maxKey, n); else setMaxStr(toStr(maxVal)) }
  return (
    <div>
      <label className="block text-[11px] text-slate-500 mb-1">{label}</label>
      <div className="flex gap-1.5 items-center">
        <input type="text" inputMode="decimal" value={minStr}
          onChange={e => { setMinStr(e.target.value); const n = parseFloat(e.target.value); if (!isNaN(n)) onChange(minKey, n) }}
          onBlur={() => commitMin(minStr)}
          className="w-full appearance-none border border-surface-border rounded px-2 py-1.5 text-xs placeholder-slate-500 focus:outline-none focus:border-accent-blue"
          style={{ colorScheme: 'dark', backgroundColor: '#0f1117', color: '#f8fafc' }} placeholder="Min" />
        <span className="text-slate-600 text-xs shrink-0">–</span>
        <input type="text" inputMode="decimal" value={maxStr}
          onChange={e => { setMaxStr(e.target.value); const n = parseFloat(e.target.value); if (!isNaN(n)) onChange(maxKey, n) }}
          onBlur={() => commitMax(maxStr)}
          className="w-full appearance-none border border-surface-border rounded px-2 py-1.5 text-xs placeholder-slate-500 focus:outline-none focus:border-accent-blue"
          style={{ colorScheme: 'dark', backgroundColor: '#0f1117', color: '#f8fafc' }} placeholder="Max" />
      </div>
    </div>
  )
}

const PRESETS_KEY = 'screenerPresets'
function loadPresets() { try { const s = localStorage.getItem(PRESETS_KEY); return s ? JSON.parse(s) : [] } catch { return [] } }
function savePresets(list) { try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)) } catch {} }

function countActiveFilters(f) {
  if (!f) return 0
  let count = 0
  if (f.requireBos)   count++
  if (f.requireChoch) count++
  if (f.requireFvg)   count++
  if (f.requireOb)    count++
  if (f.requireSweep) count++
  if (f.structure && f.structure !== 'All') count++
  if (f.zone && f.zone !== 'All') count++
  if ((f.volumeMin ?? 0) > 0) count++
  if ((f.volSpikeMin ?? 0) > 0) count++
  if (f.search && f.search.trim()) count++
  return count
}

function describeFilters(f) {
  if (!f) return []
  const parts = []
  if (f.structure && f.structure !== 'All') parts.push(f.structure)
  if (f.htfBias && f.htfBias !== 'All') parts.push(`HTF:${f.htfBias}`)
  if (f.requireBos)   parts.push(`BOS${f.bosTF ? ' '+f.bosTF.toUpperCase() : ''}`)
  if (f.requireChoch) parts.push(`ChoCh${f.chochTF ? ' '+f.chochTF.toUpperCase() : ''}`)
  if (f.requireFvg)   parts.push('FVG')
  if (f.requireOb)    parts.push(`OB${f.obDir && f.obDir !== 'All' ? ':'+f.obDir : ''}`)
  if (f.requireSweep) parts.push('Sweep')
  if (f.zone && f.zone !== 'All') parts.push(`Zone:${f.zone}`)
  if ((f.rsiMin != null && f.rsiMin !== '') || (f.rsiMax != null && f.rsiMax !== '')) {
    const min = f.rsiMin != null && f.rsiMin !== '' ? `>${f.rsiMin}` : ''
    const max = f.rsiMax != null && f.rsiMax !== '' ? `<${f.rsiMax}` : ''
    parts.push(`RSI${min}${max}`)
  }
  if (f.emaPriceFilter && f.emaPriceFilter !== 'Any') parts.push(f.emaPriceFilter)
  if (f.candlePattern && f.candlePattern !== 'All') parts.push(f.candlePattern)
  if (f.chartPattern && f.chartPattern !== 'All') parts.push(f.chartPattern.split(':')[0].replace(/_/g,' '))
  return parts
}

export default function FilterPanel({ filters, onChange, onReset, onClose, resultCount, totalCount, allPairs = [] }) {
  const set = (key, val) => onChange({ ...filters, [key]: val })
  const baseCurrencies = ['All', ...Array.from(new Set(
    allPairs.map(p => p.symbol?.split('/')[0] || p.symbol?.slice(0, 3))
  )).filter(Boolean).sort()]

  const [presets,     setPresets]     = useState(() => loadPresets())
  const [presetName,  setPresetName]  = useState('')
  const [presetsOpen, setPresetsOpen] = useState(false)

  const handleSavePreset = () => {
    const name = presetName.trim()
    if (!name) return
    const updated = [{ name, filters }, ...presets.filter(p => p.name !== name)]
    setPresets(updated); savePresets(updated); setPresetName(''); setPresetsOpen(false)
  }
  const handleDeletePreset = (name) => {
    const updated = presets.filter(p => p.name !== name)
    setPresets(updated); savePresets(updated)
  }

  return (
    <aside className="w-64 shrink-0 bg-surface-card border border-surface-border rounded-xl flex flex-col h-fit sticky top-4 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border bg-surface-hover">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={14} className="text-accent-blue" />
          <span className="text-sm font-bold text-slate-100">Screener</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setPresetsOpen(o => !o)} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-amber-400 transition-colors">
            <BookmarkPlus size={11} /> Presets
          </button>
          <span className="text-slate-700 text-[11px]">·</span>
          <button onClick={onReset} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-accent-blue transition-colors">
            <RotateCcw size={11} /> Reset
          </button>
          {onClose && (
            <button onClick={onClose} title="Close filters"
              className="flex items-center justify-center w-6 h-6 ml-1 rounded text-slate-500 hover:text-white hover:bg-slate-700 transition-colors text-base leading-none">
              ×
            </button>
          )}
        </div>
      </div>

      {/* Presets panel */}
      {presetsOpen && (
        <div className="px-3 py-2.5 border-b border-surface-border bg-surface space-y-2">
          <div className="flex gap-1">
            <input type="text" value={presetName} onChange={e => setPresetName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSavePreset() }}
              placeholder="Preset name…"
              className="flex-1 bg-surface-card border border-surface-border rounded px-2 py-1 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-accent-blue" />
            <button onClick={handleSavePreset} disabled={!presetName.trim()}
              className="text-[11px] bg-accent-blue/20 text-accent-blue border border-accent-blue/40 rounded px-2 py-1 font-semibold hover:bg-accent-blue/30 disabled:opacity-40 transition-colors">Save</button>
          </div>
          {presets.length === 0 && <p className="text-[10px] text-slate-600 italic">No presets yet — name and save your current filters above.</p>}
          {presets.map(p => {
            const activeCount = countActiveFilters(p.filters)
            return (
              <div key={p.name} className="flex items-center gap-1">
                <button onClick={() => { onChange({ ...filters, ...p.filters }); setPresetsOpen(false) }}
                  className="flex-1 text-left text-[11px] text-slate-300 hover:text-white bg-surface-card border border-surface-border hover:border-slate-500 rounded px-2 py-1 transition-colors">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="font-semibold text-slate-200">{p.name}</span>
                    {activeCount > 0 && <span className="text-[9px] font-bold text-accent-blue bg-accent-blue/15 border border-accent-blue/30 rounded-full px-1.5 py-0.5">{activeCount}</span>}
                  </div>
                  {describeFilters(p.filters).length > 0 && (
                    <div className="flex flex-wrap gap-0.5">
                      {describeFilters(p.filters).map((tag, i) => (
                        <span key={i} className="text-[9px] font-semibold bg-slate-700/50 text-slate-300 border border-slate-600/40 rounded px-1 py-0.5">{tag}</span>
                      ))}
                    </div>
                  )}
                </button>
                <button onClick={() => handleDeletePreset(p.name)} className="shrink-0 text-slate-600 hover:text-red-400 transition-colors p-1"><Trash2 size={11} /></button>
              </div>
            )
          })}
        </div>
      )}

      <div className="overflow-y-auto max-h-[calc(100vh-140px)]">

        {/* Search */}
        <div className="px-4 py-3 border-b border-surface-border">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input type="text" value={filters.search || ''} onChange={e => set('search', e.target.value)}
              placeholder="Search pair… EUR/USD, GOLD"
              className="w-full bg-surface-DEFAULT border border-surface-border rounded pl-7 pr-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-accent-blue placeholder-slate-600" />
          </div>
        </div>

        {/* Pair */}
        <Section title="Pair">
          <SelectField label="Base Currency" value={filters.baseCurrency || 'All'}
            options={baseCurrencies} onChange={v => set('baseCurrency', v)} />
        </Section>

        {/* Market Structure */}
        <Section title="Market Structure">
          <div>
            <label className="block text-[11px] mb-1">
              <span className="text-slate-500">Signal TF </span>
              <span className="text-accent-blue font-bold text-[10px]">(BOS · ChoCh · FVG · OB)</span>
            </label>
            <select value={filters.structureTF || '4h'} onChange={e => set('structureTF', e.target.value)}
              className="w-full appearance-none border border-surface-border rounded px-2 py-1.5 text-xs focus:outline-none focus:border-accent-blue cursor-pointer"
              style={{ colorScheme: 'dark', backgroundColor: '#0f1117', color: '#f8fafc' }}>
              {STRUCTURE_TIMEFRAMES.map(tf => <option key={tf.value} value={tf.value}>{tf.label}</option>)}
            </select>
            <p className="text-[10px] text-slate-600 mt-1">Reloads candles &amp; recomputes all signals</p>
          </div>
          <SelectField label="Structure Direction" value={filters.structure || 'All'}
            options={STRUCTURES.map(s => ({ value: s, label: s === 'All' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1) }))}
            onChange={v => set('structure', v)} />
          <SelectField label="HTF Bias" value={filters.htfBias || 'All'}
            options={HTF_BIASES.map(s => ({ value: s, label: s === 'All' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1) }))}
            onChange={v => set('htfBias', v)} />
          <div className="space-y-3">
            <ToggleWithTF label="BOS Detected" checked={!!filters.requireBos} onChange={v => set('requireBos', v)}
              tfValue={filters.bosTF || '4h'} onTfChange={v => onChange({ ...filters, bosTF: v, structureTF: v })} signalLabel="Break of Structure" />
            <ToggleWithTF label="ChoCh Detected" checked={!!filters.requireChoch} onChange={v => set('requireChoch', v)}
              tfValue={filters.chochTF || '4h'} onTfChange={v => onChange({ ...filters, chochTF: v, structureTF: v })} signalLabel="Change of Character" />
            <Toggle label="Liquidity Sweep" checked={!!filters.requireSweep} onChange={v => set('requireSweep', v)} description="Recent sweep of highs/lows" />
          </div>
        </Section>

        {/* Order Blocks & FVG */}
        <Section title="Order Blocks & FVG">
          <SelectField label="Order Block" value={filters.obDir || 'All'}
            options={[{ value: 'All', label: 'Any' }, { value: 'bullish', label: 'Bullish OB' }, { value: 'bearish', label: 'Bearish OB' }]}
            onChange={v => set('obDir', v)} />
          <Toggle label="Require OB Tap" checked={!!filters.requireOb} onChange={v => set('requireOb', v)} description="Price must be inside OB zone right now" />
          <SelectField label="Fair Value Gap" value={filters.fvgDir || 'All'}
            options={[{ value: 'All', label: 'Any' }, { value: 'bullish', label: 'Bullish FVG' }, { value: 'bearish', label: 'Bearish FVG' }]}
            onChange={v => set('fvgDir', v)} />
          <Toggle label="Require FVG Tap" checked={!!filters.requireFvg} onChange={v => set('requireFvg', v)} description="Price must be inside FVG zone right now" />
          {filters.requireFvg && filters.requireOb && (
            <SelectField label="FVG + OB Mode" value={filters.fvgObMode || 'AND'}
              options={[{ value: 'AND', label: 'AND — both zones must be tapped' }, { value: 'OR', label: 'OR — either zone tapped is enough' }]}
              onChange={v => set('fvgObMode', v)} />
          )}
        </Section>

        {/* Liquidity & Zone */}
        <Section title="Liquidity & Zone" defaultOpen={false}>
          <SelectField label="Liquidity Pool" value={filters.liqType || 'All'}
            options={[{ value: 'All', label: 'Any' }, { value: 'bsl', label: 'BSL – Buy-side liquidity' }, { value: 'ssl', label: 'SSL – Sell-side liquidity' }]}
            onChange={v => set('liqType', v)} />
          <SelectField label="Price Zone" value={filters.zone || 'All'}
            options={ZONES.map(z => ({ value: z, label: z === 'All' ? 'All' : z.charAt(0).toUpperCase() + z.slice(1) }))}
            onChange={v => set('zone', v)} />
        </Section>

        {/* Support & Resistance */}
        <Section title="Support & Resistance" defaultOpen={false}>
          <Toggle label="Near Resistance" checked={!!filters.requireNearResistance} onChange={v => set('requireNearResistance', v)} description="Price within 1.5% below a resistance level" />
          <Toggle label="Near Support" checked={!!filters.requireNearSupport} onChange={v => set('requireNearSupport', v)} description="Price within 1.5% above a support level" />
          <Toggle label="Broke Resistance" checked={!!filters.requireBrokeResistance} onChange={v => set('requireBrokeResistance', v)} description="Last candle closed above a resistance level" />
          <Toggle label="Broke Support" checked={!!filters.requireBrokeSupport} onChange={v => set('requireBrokeSupport', v)} description="Last candle closed below a support level" />
        </Section>

        {/* Trendlines */}
        <Section title="Trendlines" defaultOpen={false}>
          <Toggle label="Near Bull Trendline" checked={!!filters.requireTrendlineBull} onChange={v => set('requireTrendlineBull', v)} description="Price bouncing off ascending support line" />
          <Toggle label="Near Bear Trendline" checked={!!filters.requireTrendlineBear} onChange={v => set('requireTrendlineBear', v)} description="Price rejecting descending resistance line" />
          <Toggle label="Trendline Break" checked={!!filters.requireTrendlineBreak} onChange={v => set('requireTrendlineBreak', v)} description="Price just broke through a trendline" />
        </Section>

        {/* Technicals */}
        <Section title="Technicals" defaultOpen={false}>
          <RangeRow label="% Change" minKey="changeMin" maxKey="changeMax" minVal={filters.changeMin} maxVal={filters.changeMax} step={0.1} onChange={set} />
          <RangeRow label="RSI (28)" minKey="rsiMin" maxKey="rsiMax" minVal={filters.rsiMin} maxVal={filters.rsiMax} step={1} onChange={set} />
          <RangeRow label="MFI (70)" minKey="mfiMin" maxKey="mfiMax" minVal={filters.mfiMin} maxVal={filters.mfiMax} step={1} onChange={set} />
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Volume Spike <span className="text-slate-600">(above avg)</span></label>
            <div className="flex flex-wrap gap-1.5">
              {[{ label: 'Off', val: 0 }, { label: '+50%', val: 1.5 }, { label: '+100%', val: 2.0 }, { label: '+200%', val: 3.0 }, { label: '+300%', val: 4.0 }].map(opt => (
                <button key={opt.val} onClick={() => set('volSpikeMin', opt.val)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors font-semibold ${(filters.volSpikeMin ?? 0) === opt.val ? 'bg-amber-500/20 text-amber-400 border-amber-600/40' : 'text-slate-500 border-surface-border hover:text-slate-300 hover:border-slate-500'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </Section>

        {/* EMA */}
        <Section title="EMA" defaultOpen={false}>
          <SelectField label="Price vs EMA" value={filters.emaPriceFilter ?? 'Any'} onChange={v => set('emaPriceFilter', v)}
            options={[
              { value: 'Any', label: 'Any (off)' },
              { value: 'above20', label: 'Above EMA 20' }, { value: 'below20', label: 'Below EMA 20' },
              { value: 'above50', label: 'Above EMA 50' }, { value: 'below50', label: 'Below EMA 50' },
              { value: 'above100', label: 'Above EMA 100' }, { value: 'below100', label: 'Below EMA 100' },
              { value: 'above200', label: 'Above EMA 200' }, { value: 'below200', label: 'Below EMA 200' },
            ]} />
          <SelectField label="EMA Alignment" value={filters.emaAlignFilter ?? 'Any'} onChange={v => set('emaAlignFilter', v)}
            options={[
              { value: 'Any', label: 'Any (off)' },
              { value: '20_50', label: 'EMA20 > EMA50 (bullish)' },
              { value: '50_200', label: 'EMA50 > EMA200 (Golden zone)' },
            ]} />
          <SelectField label="EMA Cross" value={filters.emaCrossFilter ?? 'Any'} onChange={v => set('emaCrossFilter', v)}
            options={[
              { value: 'Any', label: 'Any (off)' },
              { value: 'cross_up_20_50', label: 'EMA20 ↑ EMA50 (bullish cross)' },
              { value: 'cross_dn_20_50', label: 'EMA20 ↓ EMA50 (bearish cross)' },
              { value: 'golden', label: 'Golden Cross (EMA50 ↑ EMA200)' },
              { value: 'death', label: 'Death Cross (EMA50 ↓ EMA200)' },
            ]} />
        </Section>

        {/* Signals */}
        <Section title="Signals" defaultOpen={false}>
          <SelectField label="RSI Divergence" value={filters.divFilter ?? 'Any'} onChange={v => set('divFilter', v)}
            options={[
              { value: 'Any', label: 'Any (off)' },
              { value: 'bull', label: 'Classic Bullish Div' },
              { value: 'bear', label: 'Classic Bearish Div' },
              { value: 'hiddenBull', label: 'Hidden Bullish Div' },
              { value: 'hiddenBear', label: 'Hidden Bearish Div' },
            ]} />
          <SelectField label="MACD Signal" value={filters.macdFilter ?? 'Any'} onChange={v => set('macdFilter', v)}
            options={[
              { value: 'Any', label: 'Any (off)' },
              { value: 'crossUp', label: 'MACD Cross Up (bullish)' },
              { value: 'crossDown', label: 'MACD Cross Down (bearish)' },
              { value: 'aboveZero', label: 'MACD Above Zero' },
              { value: 'belowZero', label: 'MACD Below Zero' },
            ]} />
          <SelectField label="Equal Highs / Lows" value={filters.equalFilter ?? 'Any'} onChange={v => set('equalFilter', v)}
            options={[
              { value: 'Any', label: 'Any (off)' },
              { value: 'equalHighs', label: 'Equal Highs (BSL above)' },
              { value: 'equalLows', label: 'Equal Lows (SSL below)' },
              { value: 'either', label: 'Either EQH or EQL' },
            ]} />
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Min Signal Score: <span className="text-accent-blue font-bold">{filters.signalScoreMin ?? -5}</span></label>
            <input type="range" min={-5} max={5} step={1} value={filters.signalScoreMin ?? -5}
              onChange={e => set('signalScoreMin', Number(e.target.value))} className="w-full accent-accent-blue" />
            <div className="flex justify-between text-[9px] text-slate-600 mt-0.5">
              <span>-5 Strong Sell</span><span>0 Neutral</span><span>+5 Strong Buy</span>
            </div>
          </div>
        </Section>

        {/* ICT / SMC Advanced */}
        <Section title="ICT / SMC Advanced" defaultOpen={false}>
          <SelectField label="Displacement" value={filters.dispFilter ?? 'Any'} onChange={v => set('dispFilter', v)}
            options={[{ value: 'Any', label: 'Any (off)' }, { value: 'bull', label: 'Bullish Displacement' }, { value: 'bear', label: 'Bearish Displacement' }, { value: 'either', label: 'Any Displacement' }]} />
          <SelectField label="Breaker Block" value={filters.breakerFilter ?? 'Any'} onChange={v => set('breakerFilter', v)}
            options={[{ value: 'Any', label: 'Any (off)' }, { value: 'bull', label: 'Bullish Breaker' }, { value: 'bear', label: 'Bearish Breaker' }, { value: 'either', label: 'Any Breaker Block' }]} />
          <SelectField label="OTE Zone" value={filters.oteFilter ?? 'Any'} onChange={v => set('oteFilter', v)}
            options={[{ value: 'Any', label: 'Any (off)' }, { value: 'bull', label: 'Bullish OTE (buy zone)' }, { value: 'bear', label: 'Bearish OTE (sell zone)' }, { value: 'either', label: 'Any OTE Zone' }]} />
          {filters.oteFilter && filters.oteFilter !== 'Any' && (
            <div style={{ marginTop: 4 }}>
              <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 3 }}>Fib Levels (zone min, max)</label>
              <input
                value={filters.oteFibLevels ?? '0.618, 0.786'}
                onChange={e => set('oteFibLevels', e.target.value)}
                placeholder="e.g. 0.618, 0.786"
                style={{ width: '100%', background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px', fontSize: 11 }}
              />
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>Any two levels: 0.702, 0.893 · 0.5, 1.0 · etc.</div>
            </div>
          )}
          <SelectField label="Consolidation / Coiling" value={filters.consolidatingFilter ?? 'Any'} onChange={v => set('consolidatingFilter', v)}
            options={[{ value: 'Any', label: 'Any (off)' }, { value: 'yes', label: 'Consolidating (ATR squeeze)' }, { value: 'no', label: 'Trending (not consolidating)' }]} />
        </Section>

        {/* VWAP & POC */}
        <Section title="VWAP & POC" defaultOpen={false}>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">VWAP Bias</label>
            <div className="flex gap-1.5">
              {[{ label: 'Any', val: 'All' }, { label: '↑ Above', val: 'above' }, { label: '↓ Below', val: 'below' }].map(opt => (
                <button key={opt.val} onClick={() => set('vwapBias', opt.val)}
                  className={`flex-1 text-[10px] px-2 py-1 rounded border transition-colors font-semibold ${(filters.vwapBias ?? 'All') === opt.val ? 'bg-violet-500/20 text-violet-300 border-violet-600/40' : 'text-slate-500 border-surface-border hover:text-slate-300 hover:border-slate-500'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">POC Bias</label>
            <div className="flex gap-1.5">
              {[{ label: 'Any', val: 'All' }, { label: '↑ Above', val: 'above' }, { label: '↓ Below', val: 'below' }].map(opt => (
                <button key={opt.val} onClick={() => set('pocBias', opt.val)}
                  className={`flex-1 text-[10px] px-2 py-1 rounded border transition-colors font-semibold ${(filters.pocBias ?? 'All') === opt.val ? 'bg-amber-500/20 text-amber-300 border-amber-600/40' : 'text-slate-500 border-surface-border hover:text-slate-300 hover:border-slate-500'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </Section>

        {/* Candlestick Patterns */}
        <Section title="🕯️ Candlestick Patterns" defaultOpen={false}>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Pattern Type</label>
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: 'All', val: 'All', color: 'bg-slate-700/40 text-slate-300 border-slate-600/40' },
                { label: '🟢 Bull', val: 'bullish', color: 'bg-green-900/40 text-green-400 border-green-700/40' },
                { label: '🔴 Bear', val: 'bearish', color: 'bg-red-900/40 text-red-400 border-red-700/40' },
                { label: '⚪ Neut', val: 'neutral', color: 'bg-slate-800 text-slate-400 border-slate-600' },
              ].map(opt => (
                <button key={opt.val} onClick={() => set('candleType', opt.val)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors font-semibold ${(filters.candleType ?? 'All') === opt.val ? opt.color : 'text-slate-500 border-surface-border hover:text-slate-300 hover:border-slate-500'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Specific Pattern</label>
            <select value={filters.candlePattern ?? 'All'} onChange={e => set('candlePattern', e.target.value)}
              className="w-full appearance-none border border-surface-border rounded px-2 py-1.5 text-xs focus:outline-none focus:border-accent-blue cursor-pointer"
              style={{ colorScheme: 'dark', backgroundColor: '#0f1117', color: '#f8fafc' }}>
              <option value="All">— Any Pattern —</option>
              <optgroup label="Single Candle">{CANDLE_PATTERNS.filter(p => p.candles === 1).map(p => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}</optgroup>
              <optgroup label="2-Candle">{CANDLE_PATTERNS.filter(p => p.candles === 2).map(p => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}</optgroup>
              <optgroup label="3-Candle">{CANDLE_PATTERNS.filter(p => p.candles === 3).map(p => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}</optgroup>
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Formed within (closed candles)</label>
            <div className="flex flex-wrap gap-1.5">
              {['1','2','3','5','10'].map(n => (
                <button key={n} onClick={() => set('candleInterval', n)}
                  className={`text-[10px] px-2.5 py-0.5 rounded border transition-colors font-semibold ${(filters.candleInterval ?? '1') === n ? 'bg-amber-900/40 text-amber-300 border-amber-600/50' : 'text-slate-500 border-surface-border hover:text-slate-300 hover:border-slate-500'}`}>
                  last {n}
                </button>
              ))}
            </div>
          </div>
        </Section>

        {/* Chart Patterns */}
        <Section title="Chart Patterns" defaultOpen={false}>
          <select value={filters.chartPattern ?? 'All'} onChange={e => set('chartPattern', e.target.value)}
            className="w-full bg-surface border border-surface-border text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-accent-blue">
            <option value="All">All patterns</option>
            <optgroup label="Bullish">
              <option value="falling_wedge:any">Falling Wedge</option>
              <option value="ascending_triangle:any">Ascending Triangle</option>
              <option value="double_bottom:any">Double Bottom</option>
              <option value="inv_head_shoulders:any">Inverse H&amp;S</option>
              <option value="bull_flag:any">Bull Flag</option>
              <option value="channel_up:any">Channel Up</option>
            </optgroup>
            <optgroup label="Bearish">
              <option value="rising_wedge:any">Rising Wedge</option>
              <option value="descending_triangle:any">Descending Triangle</option>
              <option value="double_top:any">Double Top</option>
              <option value="head_shoulders:any">Head &amp; Shoulders</option>
              <option value="bear_flag:any">Bear Flag</option>
              <option value="channel_down:any">Channel Down</option>
            </optgroup>
            <optgroup label="Neutral">
              <option value="symmetrical_triangle:any">Symmetrical Triangle</option>
            </optgroup>
          </select>
          {filters.chartPattern && filters.chartPattern !== 'All' && (
            <div className="flex gap-1">
              {['any','emerging','breakout'].map(s => (
                <button key={s} onClick={() => { const base = (filters.chartPattern ?? 'All').split(':')[0]; set('chartPattern', `${base}:${s}`) }}
                  className={`text-[10px] px-2.5 py-0.5 rounded border transition-colors font-semibold capitalize ${(filters.chartPattern ?? '').split(':')[1] === s ? 'bg-violet-900/40 text-violet-300 border-violet-600/50' : 'text-slate-500 border-surface-border hover:text-slate-300'}`}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </Section>

      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-surface-border bg-surface-hover">
        <p className="text-xs text-center">
          <span className="text-accent-blue font-bold">{resultCount}</span>
          <span className="text-slate-500"> / {totalCount} pairs</span>
        </p>
      </div>
    </aside>
  )
}

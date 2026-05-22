import { useState, useEffect } from 'react'
import { ASSET_TYPES, ASSET_COLORS } from '../data/forexData'
import { CANDLE_PATTERNS } from '../utils/candlePatterns'

// ── Inline icons ──────────────────────────────────────────────────────────────
function IconSliders({ size = 14, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
      <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
      <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
      <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>
      <line x1="17" y1="16" x2="23" y2="16"/>
    </svg>
  )
}
function IconReset({ size = 11, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.55"/>
    </svg>
  )
}
function IconSearch({ size = 12, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}
function IconChevronDown({ size = 13, color = 'currentColor' }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
}
function IconChevronUp({ size = 13, color = 'currentColor' }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
}
function IconBookmark({ size = 11, color = 'currentColor' }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="9" y1="10" x2="15" y2="10"/></svg>
}
function IconTrash({ size = 11, color = 'currentColor' }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
}

// ── Constants ─────────────────────────────────────────────────────────────────
const STRUCTURES = ['All', 'bullish', 'bearish']
const HTF_BIASES = ['All', 'bullish', 'bearish', 'sideways']
const ZONES      = ['All', 'premium', 'discount']
const STRUCTURE_TIMEFRAMES = [
  { value: '15m', label: '15M' }, { value: '30m', label: '30M' },
  { value: '1h',  label: '1H'  }, { value: '2h',  label: '2H'  },
  { value: '4h',  label: '4H'  }, { value: '8h',  label: '8H'  },
  { value: '12h', label: '12H' }, { value: '1d',  label: '1D'  },
  { value: '3d',  label: '3D'  }, { value: '1w',  label: '1W'  },
]
const CATEGORIES = ['All', ...ASSET_TYPES.filter(t => t !== 'All')]

const SIGNAL_TF_OPTIONS = [
  { value: '15m', label: '15m' }, { value: '30m', label: '30m' },
  { value: '1h',  label: '1H'  }, { value: '2h',  label: '2H'  },
  { value: '4h',  label: '4H'  }, { value: '6h',  label: '6H'  },
  { value: '12h', label: '12H' }, { value: '1d',  label: '1D'  },
  { value: '3d',  label: '3D'  }, { value: '1w',  label: '1W'  },
]

// ── Style helpers ─────────────────────────────────────────────────────────────
const S = {
  panel:      { width: 256, flexShrink: 0, background: '#0d1117', border: '1px solid #1e293b', borderRadius: 12, display: 'flex', flexDirection: 'column', alignSelf: 'flex-start', position: 'sticky', top: 16, overflow: 'hidden' },
  sectionWrap:{ borderBottom: '1px solid #1e293b' },
  sectionHead:{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', background: 'none', border: 'none', width: '100%', cursor: 'pointer', textAlign: 'left' },
  sectionLabel:{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' },
  sectionBody:{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 10 },
  label:      { display: 'block', fontSize: 11, color: '#64748b', marginBottom: 4 },
  input:      { width: '100%', background: '#0b0f1a', border: '1px solid #1e293b', borderRadius: 4, padding: '6px 8px', fontSize: 12, color: '#f1f5f9', outline: 'none', boxSizing: 'border-box' },
  select:     { width: '100%', appearance: 'none', background: '#0b0f1a', border: '1px solid #1e293b', borderRadius: 4, padding: '6px 8px', fontSize: 12, color: '#f1f5f9', outline: 'none', cursor: 'pointer', colorScheme: 'dark' },
  chip:       { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, border: '1px solid #1e293b', background: 'none', color: '#475569', cursor: 'pointer' },
  chipActive: { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, border: '1px solid #00d4aa55', background: '#00d4aa18', color: '#00d4aa', cursor: 'pointer' },
  note:       { fontSize: 10, color: '#475569' },
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={S.sectionWrap}>
      <button style={S.sectionHead} onClick={() => setOpen(o => !o)}>
        <span style={S.sectionLabel}>{title}</span>
        {open ? <IconChevronUp color="#475569"/> : <IconChevronDown color="#475569"/>}
      </button>
      {open && <div style={S.sectionBody}>{children}</div>}
    </div>
  )
}

function SelectField({ label, value, options, onChange }) {
  return (
    <div>
      {label && <label style={S.label}>{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)} style={S.select}>
        {options.map(o => (
          <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
        ))}
      </select>
    </div>
  )
}

function Toggle({ label, checked, onChange, description }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', cursor: 'pointer', gap: 8 }}>
      <div>
        <span style={{ fontSize: 12, color: '#cbd5e1' }}>{label}</span>
        {description && <p style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>{description}</p>}
      </div>
      <div
        onClick={() => onChange(!checked)}
        style={{ width: 32, height: 16, borderRadius: 8, background: checked ? '#00d4aa' : '#1e293b', position: 'relative', flexShrink: 0, cursor: 'pointer', transition: 'background 0.2s' }}
      >
        <div style={{ position: 'absolute', top: 2, left: 2, width: 12, height: 12, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.4)', transform: checked ? 'translateX(16px)' : 'none', transition: 'transform 0.2s' }}/>
      </div>
    </label>
  )
}

function ToggleWithTF({ label, checked, onChange, tfValue, onTfChange, signalLabel }) {
  const tfLabel = SIGNAL_TF_OPTIONS.find(t => t.value === tfValue)?.label ?? tfValue
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <span style={{ fontSize: 12, color: '#cbd5e1' }}>{label}</span>
          <p style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>{signalLabel} on <span style={{ color: '#00d4aa', fontWeight: 600 }}>{tfLabel}</span></p>
        </div>
        <div
          onClick={() => onChange(!checked)}
          style={{ width: 32, height: 16, borderRadius: 8, background: checked ? '#00d4aa' : '#1e293b', position: 'relative', flexShrink: 0, cursor: 'pointer', transition: 'background 0.2s' }}
        >
          <div style={{ position: 'absolute', top: 2, left: 2, width: 12, height: 12, borderRadius: '50%', background: '#fff', transform: checked ? 'translateX(16px)' : 'none', transition: 'transform 0.2s' }}/>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {SIGNAL_TF_OPTIONS.map(tf => (
          <button
            key={tf.value}
            onClick={() => onTfChange(tf.value)}
            style={tfValue === tf.value
              ? { fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #00d4aa55', background: '#00d4aa18', color: '#00d4aa', fontWeight: 700, cursor: 'pointer' }
              : { fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #1e293b', background: 'none', color: '#475569', cursor: 'pointer' }}
          >{tf.label}</button>
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

  const commitMin = (raw) => {
    const n = parseFloat(raw)
    if (!isNaN(n)) onChange(minKey, n)
    else setMinStr(toStr(minVal))
  }
  const commitMax = (raw) => {
    const n = parseFloat(raw)
    if (!isNaN(n)) onChange(maxKey, n)
    else setMaxStr(toStr(maxVal))
  }

  return (
    <div>
      <label style={S.label}>{label}</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="text" inputMode="decimal" value={minStr} placeholder="Min"
          onChange={e => { setMinStr(e.target.value); const n = parseFloat(e.target.value); if (!isNaN(n)) onChange(minKey, n) }}
          onBlur={() => commitMin(minStr)}
          style={S.input}
        />
        <span style={{ color: '#475569', fontSize: 12, flexShrink: 0 }}>–</span>
        <input
          type="text" inputMode="decimal" value={maxStr} placeholder="Max"
          onChange={e => { setMaxStr(e.target.value); const n = parseFloat(e.target.value); if (!isNaN(n)) onChange(maxKey, n) }}
          onBlur={() => commitMax(maxStr)}
          style={S.input}
        />
      </div>
    </div>
  )
}

// ── Preset persistence ────────────────────────────────────────────────────────
const PRESETS_KEY = 'forexScreenerPresets'
function loadPresets() { try { const s = localStorage.getItem(PRESETS_KEY); return s ? JSON.parse(s) : [] } catch { return [] } }
function savePresets(list) { try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)) } catch {} }

function countActiveFilters(f) {
  if (!f) return 0
  let count = 0
  if (f.category && f.category !== 'All') count++
  if (f.requireBos)   count++
  if (f.requireChoch) count++
  if (f.requireFvg)   count++
  if (f.requireOb)    count++
  if (f.requireSweep) count++
  if (f.structure && f.structure !== 'All') count++
  if (f.zone && f.zone !== 'All') count++
  if ((f.volumeMin ?? 0) > 0) count++
  if ((f.volSpikeMin ?? 0) > 0) count++
  if (f.smartFlow && f.smartFlow !== 'Any') count++
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
  if (f.category && f.category !== 'All') parts.push(f.category)
  if (f.zone && f.zone !== 'All') parts.push(`Zone:${f.zone}`)
  if ((f.rsiMin != null && f.rsiMin !== '') || (f.rsiMax != null && f.rsiMax !== '')) {
    const min = f.rsiMin != null && f.rsiMin !== '' ? `>${f.rsiMin}` : ''
    const max = f.rsiMax != null && f.rsiMax !== '' ? `<${f.rsiMax}` : ''
    parts.push(`RSI${min}${max}`)
  }
  if (f.smartFlow && f.smartFlow !== 'Any') parts.push(f.smartFlow.replace('_', ' '))
  if (f.emaPriceFilter && f.emaPriceFilter !== 'Any') parts.push(f.emaPriceFilter)
  if ((f.volSpikeMin ?? 0) > 0) parts.push(`VolSpike×${f.volSpikeMin}`)
  if (f.candlePattern && f.candlePattern !== 'All') parts.push(f.candlePattern)
  if (f.chartPattern && f.chartPattern !== 'All') parts.push(f.chartPattern.split(':')[0].replace(/_/g, ' '))
  return parts
}

// ── Main component ────────────────────────────────────────────────────────────
export default function FilterPanel({ filters, onChange, onReset, resultCount, totalCount, allPairs = [] }) {
  const set = (key, val) => onChange({ ...filters, [key]: val })

  const baseCurrencies = ['All', ...Array.from(new Set(
    allPairs.map(p => p.symbol?.split('/')[0] || p.symbol?.slice(0, 3) || 'ALL')
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
    <aside style={S.panel}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #1e293b', background: '#111827' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconSliders color="#00d4aa"/>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>Screener</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={() => setPresetsOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: presetsOpen ? '#f59e0b' : '#64748b', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <IconBookmark color="currentColor"/>Presets
          </button>
          <span style={{ color: '#334155', fontSize: 11 }}>·</span>
          <button
            onClick={onReset}
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <IconReset color="currentColor"/>Reset
          </button>
        </div>
      </div>

      {/* Presets panel */}
      {presetsOpen && (
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #1e293b', background: '#0b0f1a', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              type="text" value={presetName} onChange={e => setPresetName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSavePreset() }}
              placeholder="Preset name…"
              style={{ flex: 1, ...S.input }}
            />
            <button
              onClick={handleSavePreset} disabled={!presetName.trim()}
              style={{ fontSize: 11, background: '#00d4aa18', color: '#00d4aa', border: '1px solid #00d4aa44', borderRadius: 4, padding: '4px 8px', fontWeight: 600, cursor: 'pointer', opacity: presetName.trim() ? 1 : 0.4 }}
            >Save</button>
          </div>
          {presets.length === 0 && (
            <p style={{ fontSize: 10, color: '#475569', fontStyle: 'italic' }}>No presets yet — name and save your current filters above.</p>
          )}
          {presets.map(p => {
            const activeCount = countActiveFilters(p.filters)
            return (
              <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                  onClick={() => { onChange({ ...filters, ...p.filters }); setPresetsOpen(false) }}
                  style={{ flex: 1, textAlign: 'left', fontSize: 11, color: '#cbd5e1', background: '#0d1117', border: '1px solid #1e293b', borderRadius: 4, padding: '6px 8px', cursor: 'pointer', minWidth: 0 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, color: '#f1f5f9' }}>{p.name}</span>
                    {activeCount > 0 && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: '#00d4aa', background: '#00d4aa15', border: '1px solid #00d4aa33', borderRadius: 9999, padding: '1px 6px' }}>
                        {activeCount}
                      </span>
                    )}
                  </div>
                  {describeFilters(p.filters).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {describeFilters(p.filters).map((tag, i) => (
                        <span key={i} style={{ fontSize: 9, fontWeight: 600, background: '#1e293b80', color: '#94a3b8', border: '1px solid #33415580', borderRadius: 3, padding: '1px 4px' }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
                <button onClick={() => handleDeletePreset(p.name)} style={{ color: '#475569', background: 'none', border: 'none', cursor: 'pointer', padding: 4, flexShrink: 0 }}>
                  <IconTrash color="currentColor"/>
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 140px)' }}>

        {/* Search */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <IconSearch color="#475569"/>
            </span>
            <input
              type="text" value={filters.search || ''}
              onChange={e => set('search', e.target.value)}
              placeholder="Search pair or symbol…"
              style={{ ...S.input, paddingLeft: 28 }}
            />
          </div>
        </div>

        {/* Category */}
        <Section title="Category">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CATEGORIES.map(cat => {
              const c = cat !== 'All' ? (ASSET_COLORS[cat] ?? { color: '#94a3b8', bg: '#1e293b55' }) : null
              const active = (filters.category ?? 'All') === cat
              return (
                <button
                  key={cat}
                  onClick={() => set('category', cat)}
                  style={active
                    ? { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, border: `1px solid ${c ? c.color+'55' : '#00d4aa55'}`, background: c ? c.bg : '#00d4aa18', color: c ? c.color : '#00d4aa', cursor: 'pointer' }
                    : S.chip}
                >{cat}</button>
              )
            })}
          </div>
        </Section>

        {/* Pair (Base Currency) */}
        <Section title="Pair">
          <SelectField
            label="Base Currency"
            value={filters.baseCurrency || 'All'}
            options={baseCurrencies}
            onChange={v => set('baseCurrency', v)}
          />
        </Section>

        {/* Market Structure (SMC) */}
        <Section title="Market Structure">
          <div>
            <label style={S.label}>
              Signal TF <span style={{ color: '#00d4aa', fontWeight: 700, fontSize: 10 }}>(BOS · ChoCh · FVG · OB)</span>
            </label>
            <select
              value={filters.structureTF || '4h'}
              onChange={e => set('structureTF', e.target.value)}
              style={S.select}
            >
              {STRUCTURE_TIMEFRAMES.map(tf => (
                <option key={tf.value} value={tf.value}>{tf.label}</option>
              ))}
            </select>
            <p style={{ ...S.note, marginTop: 4 }}>Reloads candles &amp; recomputes all signals</p>
          </div>
          <SelectField
            label="Structure Direction"
            value={filters.structure || 'All'}
            options={STRUCTURES.map(s => ({ value: s, label: s === 'All' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1) }))}
            onChange={v => set('structure', v)}
          />
          <SelectField
            label="HTF Bias"
            value={filters.htfBias || 'All'}
            options={HTF_BIASES.map(s => ({ value: s, label: s === 'All' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1) }))}
            onChange={v => set('htfBias', v)}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ToggleWithTF
              label="BOS Detected"
              checked={!!filters.requireBos}
              onChange={v => set('requireBos', v)}
              tfValue={filters.bosTF || '4h'}
              onTfChange={v => onChange({ ...filters, bosTF: v, structureTF: v })}
              signalLabel="Break of Structure"
            />
            <ToggleWithTF
              label="ChoCh Detected"
              checked={!!filters.requireChoch}
              onChange={v => set('requireChoch', v)}
              tfValue={filters.chochTF || '4h'}
              onTfChange={v => onChange({ ...filters, chochTF: v, structureTF: v })}
              signalLabel="Change of Character"
            />
            <Toggle
              label="Liquidity Sweep"
              checked={!!filters.requireSweep}
              onChange={v => set('requireSweep', v)}
              description="Recent sweep of highs/lows"
            />
          </div>
        </Section>

        {/* Order Blocks & FVG */}
        <Section title="Order Blocks & FVG">
          <SelectField
            label="Order Block"
            value={filters.obDir || 'All'}
            options={[
              { value: 'All', label: 'Any' },
              { value: 'bullish', label: 'Bullish OB' },
              { value: 'bearish', label: 'Bearish OB' },
            ]}
            onChange={v => set('obDir', v)}
          />
          <Toggle
            label="Require OB Tap"
            checked={!!filters.requireOb}
            onChange={v => set('requireOb', v)}
            description="Price must be inside OB zone right now"
          />
          <SelectField
            label="Fair Value Gap"
            value={filters.fvgDir || 'All'}
            options={[
              { value: 'All', label: 'Any' },
              { value: 'bullish', label: 'Bullish FVG' },
              { value: 'bearish', label: 'Bearish FVG' },
            ]}
            onChange={v => set('fvgDir', v)}
          />
          <Toggle
            label="Require FVG Tap"
            checked={!!filters.requireFvg}
            onChange={v => set('requireFvg', v)}
            description="Price must be inside FVG zone right now"
          />
          {filters.requireFvg && filters.requireOb && (
            <SelectField
              label="FVG + OB Mode"
              value={filters.fvgObMode || 'AND'}
              options={[
                { value: 'AND', label: 'AND — both zones must be tapped' },
                { value: 'OR',  label: 'OR — either zone tapped is enough' },
              ]}
              onChange={v => set('fvgObMode', v)}
            />
          )}
        </Section>

        {/* Liquidity & Zone */}
        <Section title="Liquidity & Zone" defaultOpen={false}>
          <SelectField
            label="Liquidity Pool"
            value={filters.liqType || 'All'}
            options={[
              { value: 'All', label: 'Any' },
              { value: 'bsl', label: 'BSL – Buy-side liquidity' },
              { value: 'ssl', label: 'SSL – Sell-side liquidity' },
            ]}
            onChange={v => set('liqType', v)}
          />
          <SelectField
            label="Price Zone"
            value={filters.zone || 'All'}
            options={ZONES.map(z => ({
              value: z,
              label: z === 'All' ? 'All' : z.charAt(0).toUpperCase() + z.slice(1),
            }))}
            onChange={v => set('zone', v)}
          />
        </Section>

        {/* Support & Resistance */}
        <Section title="Support & Resistance" defaultOpen={false}>
          <Toggle
            label="Near Resistance"
            checked={!!filters.requireNearResistance}
            onChange={v => set('requireNearResistance', v)}
            description="Price within 1.5% below a resistance level"
          />
          <Toggle
            label="Near Support"
            checked={!!filters.requireNearSupport}
            onChange={v => set('requireNearSupport', v)}
            description="Price within 1.5% above a support level"
          />
          <Toggle
            label="Broke Resistance"
            checked={!!filters.requireBrokeResistance}
            onChange={v => set('requireBrokeResistance', v)}
            description="Last candle closed above a resistance level"
          />
          <Toggle
            label="Broke Support"
            checked={!!filters.requireBrokeSupport}
            onChange={v => set('requireBrokeSupport', v)}
            description="Last candle closed below a support level"
          />
        </Section>

        {/* Trendlines */}
        <Section title="Trendlines" defaultOpen={false}>
          <Toggle
            label="Near Bull Trendline"
            checked={!!filters.requireTrendlineBull}
            onChange={v => set('requireTrendlineBull', v)}
            description="Price bouncing off ascending support line"
          />
          <Toggle
            label="Near Bear Trendline"
            checked={!!filters.requireTrendlineBear}
            onChange={v => set('requireTrendlineBear', v)}
            description="Price rejecting descending resistance line"
          />
          <Toggle
            label="Trendline Break"
            checked={!!filters.requireTrendlineBreak}
            onChange={v => set('requireTrendlineBreak', v)}
            description="Price just broke through a trendline"
          />
        </Section>

        {/* Technicals */}
        <Section title="Technicals" defaultOpen={false}>
          <RangeRow
            label="% Change (24h)"
            minKey="changeMin" maxKey="changeMax"
            minVal={filters.changeMin} maxVal={filters.changeMax}
            step={0.1} onChange={set}
          />
          <RangeRow
            label="RSI (28)"
            minKey="rsiMin" maxKey="rsiMax"
            minVal={filters.rsiMin} maxVal={filters.rsiMax}
            step={1} onChange={set}
          />
          <RangeRow
            label="MFI (70) — needs candles"
            minKey="mfiMin" maxKey="mfiMax"
            minVal={filters.mfiMin} maxVal={filters.mfiMax}
            step={1} onChange={set}
          />
          <div>
            <label style={S.label}>Min Volume 24h ($)</label>
            <input
              type="number" value={filters.volumeMin || ''} step={1_000_000}
              onChange={e => set('volumeMin', Number(e.target.value))}
              placeholder="0"
              style={S.input}
            />
          </div>
          <div>
            <label style={S.label}>Volume Spike <span style={{ color: '#475569' }}>(above avg)</span></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[
                { label: 'Off',   val: 0   },
                { label: '+50%',  val: 1.5 },
                { label: '+100%', val: 2.0 },
                { label: '+200%', val: 3.0 },
                { label: '+300%', val: 4.0 },
              ].map(opt => (
                <button
                  key={opt.val}
                  onClick={() => set('volSpikeMin', opt.val)}
                  style={(filters.volSpikeMin ?? 0) === opt.val
                    ? { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, border: '1px solid #f59e0b55', background: '#f59e0b18', color: '#f59e0b', cursor: 'pointer' }
                    : S.chip}
                >{opt.label}</button>
              ))}
            </div>
            <p style={{ ...S.note, marginTop: 4 }}>Needs candles loaded</p>
          </div>
        </Section>

        {/* EMA */}
        <Section title="EMA" defaultOpen={false}>
          <SelectField
            label="Price vs EMA"
            value={filters.emaPriceFilter ?? 'Any'}
            onChange={v => set('emaPriceFilter', v)}
            options={[
              { value: 'Any',      label: 'Any (off)' },
              { value: 'above9',   label: 'Above EMA 9' },
              { value: 'below9',   label: 'Below EMA 9' },
              { value: 'above20',  label: 'Above EMA 20' },
              { value: 'below20',  label: 'Below EMA 20' },
              { value: 'above50',  label: 'Above EMA 50' },
              { value: 'below50',  label: 'Below EMA 50' },
              { value: 'above100', label: 'Above EMA 100' },
              { value: 'below100', label: 'Below EMA 100' },
              { value: 'above200', label: 'Above EMA 200' },
              { value: 'below200', label: 'Below EMA 200' },
            ]}
          />
          <SelectField
            label="EMA Alignment"
            value={filters.emaAlignFilter ?? 'Any'}
            onChange={v => set('emaAlignFilter', v)}
            options={[
              { value: 'Any',    label: 'Any (off)' },
              { value: '9_20',   label: 'EMA9 > EMA20 (bullish)' },
              { value: '20_50',  label: 'EMA20 > EMA50 (bullish)' },
              { value: '50_200', label: 'EMA50 > EMA200 (Golden zone)' },
            ]}
          />
          <SelectField
            label="EMA Cross"
            value={filters.emaCrossFilter ?? 'Any'}
            onChange={v => set('emaCrossFilter', v)}
            options={[
              { value: 'Any',            label: 'Any (off)' },
              { value: 'cross_up_9_20',  label: 'EMA9 ↑ EMA20 (bullish cross)' },
              { value: 'cross_dn_9_20',  label: 'EMA9 ↓ EMA20 (bearish cross)' },
              { value: 'cross_up_20_50', label: 'EMA20 ↑ EMA50 (bullish cross)' },
              { value: 'cross_dn_20_50', label: 'EMA20 ↓ EMA50 (bearish cross)' },
              { value: 'golden',         label: 'Golden Cross (EMA50 ↑ EMA200)' },
              { value: 'death',          label: 'Death Cross (EMA50 ↓ EMA200)' },
            ]}
          />
          <p style={S.note}>Requires candles to be loaded</p>
        </Section>

        {/* LuxAlgo Signals */}
        <Section title="LuxAlgo Signals" defaultOpen={false}>
          <SelectField
            label="RSI Divergence"
            value={filters.divFilter ?? 'Any'}
            onChange={v => set('divFilter', v)}
            options={[
              { value: 'Any',        label: 'Any (off)' },
              { value: 'bull',       label: 'Classic Bullish Div (price LL, RSI HL)' },
              { value: 'bear',       label: 'Classic Bearish Div (price HH, RSI LH)' },
              { value: 'hiddenBull', label: 'Hidden Bullish Div (uptrend continuation)' },
              { value: 'hiddenBear', label: 'Hidden Bearish Div (downtrend continuation)' },
              { value: 'anyBull',    label: 'Any Bullish Divergence' },
              { value: 'anyBear',    label: 'Any Bearish Divergence' },
            ]}
          />
          <SelectField
            label="MACD Signal"
            value={filters.macdFilter ?? 'Any'}
            onChange={v => set('macdFilter', v)}
            options={[
              { value: 'Any',       label: 'Any (off)' },
              { value: 'crossUp',   label: 'MACD Cross Up (bullish)' },
              { value: 'crossDown', label: 'MACD Cross Down (bearish)' },
              { value: 'aboveZero', label: 'MACD Above Zero (bull momentum)' },
              { value: 'belowZero', label: 'MACD Below Zero (bear momentum)' },
            ]}
          />
          <SelectField
            label="Fibonacci Zone"
            value={filters.fibFilter ?? 'Any'}
            onChange={v => set('fibFilter', v)}
            options={[
              { value: 'Any',        label: 'Any (off)' },
              { value: 'bullZone',   label: 'Bullish Golden Zone (0.5–0.786 pullback)' },
              { value: 'bearZone',   label: 'Bearish Golden Zone (0.5–0.786 retrace)' },
              { value: 'goldenZone', label: 'Either Golden Zone' },
            ]}
          />
          <SelectField
            label="Equal Highs / Lows"
            value={filters.equalFilter ?? 'Any'}
            onChange={v => set('equalFilter', v)}
            options={[
              { value: 'Any',        label: 'Any (off)' },
              { value: 'equalHighs', label: 'Equal Highs (BSL above)' },
              { value: 'equalLows',  label: 'Equal Lows (SSL below)' },
              { value: 'either',     label: 'Either EQH or EQL' },
            ]}
          />
          <div>
            <label style={S.label}>
              Min Signal Score: <span style={{ color: '#00d4aa', fontWeight: 700 }}>{filters.signalScoreMin ?? -5}</span>
            </label>
            <input
              type="range" min={-5} max={5} step={1}
              value={filters.signalScoreMin ?? -5}
              onChange={e => set('signalScoreMin', Number(e.target.value))}
              style={{ width: '100%', accentColor: '#00d4aa' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#475569', marginTop: 2 }}>
              <span>-5 Strong Sell</span><span>0 Neutral</span><span>+5 Strong Buy</span>
            </div>
          </div>
          <p style={S.note}>Requires candles to be loaded</p>
        </Section>

        {/* ICT / SMC Advanced */}
        <Section title="ICT / SMC Advanced" defaultOpen={false}>
          <SelectField
            label="Displacement"
            value={filters.dispFilter ?? 'Any'}
            onChange={v => set('dispFilter', v)}
            options={[
              { value: 'Any',    label: 'Any (off)' },
              { value: 'bull',   label: 'Bullish Displacement' },
              { value: 'bear',   label: 'Bearish Displacement' },
              { value: 'either', label: 'Any Displacement' },
            ]}
          />
          <SelectField
            label="Breaker Block"
            value={filters.breakerFilter ?? 'Any'}
            onChange={v => set('breakerFilter', v)}
            options={[
              { value: 'Any',    label: 'Any (off)' },
              { value: 'bull',   label: 'Bullish Breaker (support)' },
              { value: 'bear',   label: 'Bearish Breaker (resistance)' },
              { value: 'either', label: 'Any Breaker Block' },
            ]}
          />
          <SelectField
            label="OTE Zone (0.618–0.786)"
            value={filters.oteFilter ?? 'Any'}
            onChange={v => set('oteFilter', v)}
            options={[
              { value: 'Any',    label: 'Any (off)' },
              { value: 'bull',   label: 'Bullish OTE (buy zone)' },
              { value: 'bear',   label: 'Bearish OTE (sell zone)' },
              { value: 'either', label: 'Any OTE Zone' },
            ]}
          />
          <SelectField
            label="Consolidation / Coiling"
            value={filters.consolidatingFilter ?? 'Any'}
            onChange={v => set('consolidatingFilter', v)}
            options={[
              { value: 'Any', label: 'Any (off)' },
              { value: 'yes', label: 'Consolidating (ATR squeeze)' },
              { value: 'no',  label: 'Not consolidating (trending)' },
            ]}
          />
          <p style={S.note}>Requires candles to be loaded</p>
        </Section>

        {/* VWAP & POC */}
        <Section title="VWAP & POC" defaultOpen={false}>
          <div>
            <label style={S.label}>VWAP Bias</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {[{ label: 'Any', val: 'All' }, { label: '↑ Above', val: 'above' }, { label: '↓ Below', val: 'below' }].map(opt => (
                <button
                  key={opt.val}
                  onClick={() => set('vwapBias', opt.val)}
                  style={(filters.vwapBias ?? 'All') === opt.val
                    ? { flex: 1, fontSize: 10, fontWeight: 700, padding: '4px 8px', borderRadius: 4, border: '1px solid #a78bfa55', background: '#a78bfa18', color: '#a78bfa', cursor: 'pointer' }
                    : { flex: 1, fontSize: 10, fontWeight: 700, padding: '4px 8px', borderRadius: 4, border: '1px solid #1e293b', background: 'none', color: '#475569', cursor: 'pointer' }}
                >{opt.label}</button>
              ))}
            </div>
            <p style={{ ...S.note, marginTop: 4 }}>Price above/below VWAP — needs candles loaded</p>
          </div>
          <div>
            <label style={S.label}>POC Bias</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {[{ label: 'Any', val: 'All' }, { label: '↑ Above', val: 'above' }, { label: '↓ Below', val: 'below' }].map(opt => (
                <button
                  key={opt.val}
                  onClick={() => set('pocBias', opt.val)}
                  style={(filters.pocBias ?? 'All') === opt.val
                    ? { flex: 1, fontSize: 10, fontWeight: 700, padding: '4px 8px', borderRadius: 4, border: '1px solid #f59e0b55', background: '#f59e0b18', color: '#f59e0b', cursor: 'pointer' }
                    : { flex: 1, fontSize: 10, fontWeight: 700, padding: '4px 8px', borderRadius: 4, border: '1px solid #1e293b', background: 'none', color: '#475569', cursor: 'pointer' }}
                >{opt.label}</button>
              ))}
            </div>
            <p style={{ ...S.note, marginTop: 4 }}>Price above/below Point of Control — needs candles loaded</p>
          </div>
        </Section>

        {/* Smart Money Flow */}
        <Section title="Smart Money Flow" defaultOpen={false}>
          <div>
            <label style={S.label}>Smart Flow Signal</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[
                { label: 'Any',         val: 'Any' },
                { label: '📈 Accum',    val: 'accumulation' },
                { label: '📉 Distrib',  val: 'distribution' },
                { label: '💥 LongSqz',  val: 'long_squeeze' },
                { label: '🚀 ShortSqz', val: 'short_squeeze' },
                { label: '↗ Div↑',      val: 'div_bull' },
                { label: '↘ Div↓',      val: 'div_bear' },
              ].map(opt => (
                <button
                  key={opt.val}
                  onClick={() => set('smartFlow', opt.val)}
                  style={(filters.smartFlow ?? 'Any') === opt.val
                    ? { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, border: '1px solid #22c55e55', background: '#22c55e18', color: '#22c55e', cursor: 'pointer' }
                    : S.chip}
                >{opt.label}</button>
              ))}
            </div>
          </div>
        </Section>

        {/* Candlestick Patterns */}
        <Section title="🕯️ Candlestick Patterns" defaultOpen={false}>
          <div>
            <label style={S.label}>Pattern Type</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[
                { label: 'All',     val: 'All',     color: '#94a3b8', bg: '#1e293b55' },
                { label: '🟢 Bull', val: 'bullish', color: '#22c55e', bg: '#22c55e18' },
                { label: '🔴 Bear', val: 'bearish', color: '#ef4444', bg: '#ef444418' },
                { label: '⚪ Neut', val: 'neutral', color: '#94a3b8', bg: '#1e293b55' },
              ].map(opt => (
                <button
                  key={opt.val}
                  onClick={() => set('candleType', opt.val)}
                  style={(filters.candleType ?? 'All') === opt.val
                    ? { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, border: `1px solid ${opt.color}55`, background: opt.bg, color: opt.color, cursor: 'pointer' }
                    : S.chip}
                >{opt.label}</button>
              ))}
            </div>
          </div>
          <div>
            <label style={S.label}>Specific Pattern</label>
            <select
              value={filters.candlePattern ?? 'All'}
              onChange={e => set('candlePattern', e.target.value)}
              style={S.select}
            >
              <option value="All">— Any Pattern —</option>
              <optgroup label="Single Candle">
                {CANDLE_PATTERNS.filter(p => p.candles === 1).map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                ))}
              </optgroup>
              <optgroup label="2-Candle Patterns">
                {CANDLE_PATTERNS.filter(p => p.candles === 2).map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                ))}
              </optgroup>
              <optgroup label="3-Candle Patterns">
                {CANDLE_PATTERNS.filter(p => p.candles === 3).map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                ))}
              </optgroup>
              <optgroup label="5-Candle Patterns">
                {CANDLE_PATTERNS.filter(p => p.candles === 5).map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                ))}
              </optgroup>
            </select>
          </div>
          <div>
            <label style={S.label}>Formed within (closed candles)</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {['1', '2', '3', '5', '10'].map(n => (
                <button
                  key={n}
                  onClick={() => set('candleInterval', n)}
                  style={(filters.candleInterval ?? '1') === n
                    ? { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, border: '1px solid #f59e0b55', background: '#f59e0b18', color: '#f59e0b', cursor: 'pointer' }
                    : S.chip}
                >last {n}</button>
              ))}
            </div>
          </div>
          <p style={S.note}>Only closed candles. "last 1" = most recent closed candle only.</p>
        </Section>

        {/* Chart Patterns */}
        <Section title="Chart Patterns">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ ...S.note, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Pattern Type</p>
            <select
              value={filters.chartPattern ?? 'All'}
              onChange={e => set('chartPattern', e.target.value)}
              style={S.select}
            >
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
              <div style={{ display: 'flex', gap: 4 }}>
                {['any', 'emerging', 'breakout'].map(s => (
                  <button key={s}
                    onClick={() => {
                      const base = (filters.chartPattern ?? 'All').split(':')[0]
                      set('chartPattern', `${base}:${s}`)
                    }}
                    style={(filters.chartPattern ?? '').split(':')[1] === s
                      ? { fontSize: 10, fontWeight: 700, padding: '2px 10px', borderRadius: 4, border: '1px solid #a78bfa55', background: '#a78bfa18', color: '#a78bfa', cursor: 'pointer', textTransform: 'capitalize' }
                      : { ...S.chip, textTransform: 'capitalize' }}
                  >{s}</button>
                ))}
              </div>
            )}
          </div>
        </Section>

      </div>

      {/* Footer */}
      <div style={{ padding: '10px 16px', borderTop: '1px solid #1e293b', background: '#111827', textAlign: 'center' }}>
        <p style={{ fontSize: 12 }}>
          <span style={{ color: '#00d4aa', fontWeight: 700 }}>{resultCount}</span>
          <span style={{ color: '#475569' }}> / {totalCount} pairs</span>
        </p>
      </div>
    </aside>
  )
}

import { useState } from 'react';
import { STRATEGIES, samplePositions, tradeHistory, SIGNALS, forexPairs } from '../data/forexData';

// ── Toggle switch ─────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, label }) {
  return (
    <label className="toggle-wrap">
      <div className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
        <div className="toggle-knob" />
      </div>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}

// ── Status dot ────────────────────────────────────────────────────────────────
function StatusDot({ active }) {
  return (
    <span className={`status-dot ${active ? 'active' : ''}`} />
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <div className="stat-card">
      <div className="stat-value" style={color ? { color } : {}}>{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// ── Position row ──────────────────────────────────────────────────────────────
function PositionRow({ pos, onClose }) {
  return (
    <tr className="pair-row">
      <td><span className="pair-symbol" style={{ fontSize: 13 }}>{pos.pair}</span></td>
      <td>
        <span className={`type-badge ${pos.type.toLowerCase()}`}>{pos.type}</span>
      </td>
      <td className="mono">{pos.lots}</td>
      <td className="mono muted">{typeof pos.openPrice === 'number' ? pos.openPrice.toFixed(pos.openPrice > 10 ? 3 : 5) : pos.openPrice}</td>
      <td className="mono">{typeof pos.currentPrice === 'number' ? pos.currentPrice.toFixed(pos.currentPrice > 10 ? 3 : 5) : pos.currentPrice}</td>
      <td className="mono" style={{ color: '#ef4444' }}>{typeof pos.sl === 'number' ? pos.sl.toFixed(pos.sl > 10 ? 3 : 5) : pos.sl}</td>
      <td className="mono" style={{ color: '#22c55e' }}>{typeof pos.tp === 'number' ? pos.tp.toFixed(pos.tp > 10 ? 3 : 5) : pos.tp}</td>
      <td>
        <span className={pos.pips >= 0 ? 'up' : 'down'}>
          {pos.pips >= 0 ? '+' : ''}{pos.pips} pips
        </span>
      </td>
      <td>
        <span className={pos.pnl >= 0 ? 'up' : 'down'} style={{ fontWeight: 600 }}>
          {pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(2)}
        </span>
      </td>
      <td className="muted" style={{ fontSize: 11 }}>{pos.openTime} · {pos.duration}</td>
      <td>
        <button className="close-btn" onClick={() => onClose(pos.id)}>Close</button>
      </td>
    </tr>
  );
}

// ── History row ───────────────────────────────────────────────────────────────
function HistoryRow({ trade }) {
  return (
    <tr className="pair-row">
      <td className="mono muted" style={{ fontSize: 11 }}>{trade.id}</td>
      <td><span className="pair-symbol" style={{ fontSize: 13 }}>{trade.pair}</span></td>
      <td><span className={`type-badge ${trade.type.toLowerCase()}`}>{trade.type}</span></td>
      <td className="mono muted">{trade.lots}</td>
      <td className="mono muted">{typeof trade.openPrice === 'number' ? trade.openPrice.toFixed(trade.openPrice > 10 ? 3 : 5) : trade.openPrice}</td>
      <td className="mono muted">{typeof trade.closePrice === 'number' ? trade.closePrice.toFixed(trade.closePrice > 10 ? 3 : 5) : trade.closePrice}</td>
      <td><span className={trade.pips >= 0 ? 'up' : 'down'}>{trade.pips >= 0 ? '+' : ''}{trade.pips}p</span></td>
      <td>
        <span className={trade.pnl >= 0 ? 'up' : 'down'} style={{ fontWeight: 600 }}>
          {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
        </span>
      </td>
      <td>
        <span className={`result-badge ${trade.result.toLowerCase()}`}>{trade.result}</span>
      </td>
      <td className="muted" style={{ fontSize: 11 }}>{trade.closeTime}</td>
    </tr>
  );
}

// ── Number input ──────────────────────────────────────────────────────────────
function NumberInput({ label, value, onChange, min, max, step, unit }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      <div className="field-input-wrap">
        <input
          type="number"
          className="field-input"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={e => onChange(parseFloat(e.target.value))}
        />
        {unit && <span className="field-unit">{unit}</span>}
      </div>
    </div>
  );
}

// ── Main AutoTrading ──────────────────────────────────────────────────────────
export default function AutoTrading() {
  const [botActive, setBotActive] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState(STRATEGIES[0]);
  const [positions, setPositions] = useState(samplePositions);
  const [history, setHistory] = useState(tradeHistory);
  const [activeTab, setActiveTab] = useState('positions');

  // Risk settings state (initialized from strategy defaults)
  const [lotSize, setLotSize] = useState(selectedStrategy.defaultLot);
  const [stopLoss, setStopLoss] = useState(selectedStrategy.defaultSL);
  const [takeProfit, setTakeProfit] = useState(selectedStrategy.defaultTP);
  const [maxTrades, setMaxTrades] = useState(selectedStrategy.maxTrades);
  const [maxDrawdown, setMaxDrawdown] = useState(5);
  const [trailingStop, setTrailingStop] = useState(false);
  const [martingale, setMartingale] = useState(false);
  const [selectedPairs, setSelectedPairs] = useState(['EUR/USD', 'GBP/USD', 'USD/JPY']);

  // Stats derived from history
  const totalPnl = history.reduce((s, t) => s + t.pnl, 0);
  const wins = history.filter(t => t.result === 'WIN').length;
  const winRate = history.length > 0 ? ((wins / history.length) * 100).toFixed(1) : '0.0';
  const activePnl = positions.reduce((s, p) => s + p.pnl, 0);

  const handleStrategyChange = (s) => {
    setSelectedStrategy(s);
    setLotSize(s.defaultLot);
    setStopLoss(s.defaultSL);
    setTakeProfit(s.defaultTP);
    setMaxTrades(s.maxTrades);
  };

  const handleClosePosition = (id) => {
    const pos = positions.find(p => p.id === id);
    if (pos) {
      setHistory(prev => [{
        id: `H${String(prev.length + 1).padStart(3, '0')}`,
        pair: pos.pair,
        type: pos.type,
        lots: pos.lots,
        openPrice: pos.openPrice,
        closePrice: pos.currentPrice,
        pnl: pos.pnl,
        pips: pos.pips,
        result: pos.pnl >= 0 ? 'WIN' : 'LOSS',
        closeTime: new Date().toLocaleString(),
      }, ...prev]);
      setPositions(prev => prev.filter(p => p.id !== id));
    }
  };

  const togglePair = (symbol) => {
    setSelectedPairs(prev =>
      prev.includes(symbol) ? prev.filter(s => s !== symbol) : [...prev, symbol]
    );
  };

  const majorPairs = forexPairs.filter(p => p.category === 'Majors').map(p => p.symbol);

  return (
    <div className="autotrading-root">

      {/* ── TOP: Bot control + stats ─────────────────────────────────────── */}
      <div className="at-top-row">

        {/* Bot status card */}
        <div className="bot-status-card">
          <div className="bot-status-header">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <StatusDot active={botActive} />
                <span className="bot-status-title">{botActive ? 'Bot Running' : 'Bot Offline'}</span>
              </div>
              <div className="bot-strategy-name">{selectedStrategy.name}</div>
              <div className="bot-tf">{selectedStrategy.timeframe}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <Toggle checked={botActive} onChange={setBotActive} />
              <div style={{ fontSize: 10, color: '#475569', marginTop: 6 }}>
                {botActive ? 'Click to stop' : 'Click to start'}
              </div>
            </div>
          </div>

          <div className="bot-indicator-row">
            {selectedStrategy.indicators.map(ind => (
              <span key={ind} className="indicator-chip">{ind}</span>
            ))}
          </div>

          {botActive && (
            <div className="bot-live-row">
              <span className="live-dot" />
              <span style={{ color: '#22c55e', fontSize: 12 }}>LIVE — scanning {selectedPairs.length} pair{selectedPairs.length !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>

        {/* Stats */}
        <StatCard label="Open Positions"  value={positions.length}              color={positions.length > 0 ? '#00d4aa' : undefined} />
        <StatCard label="Floating P&L"    value={`${activePnl >= 0 ? '+' : ''}$${activePnl.toFixed(2)}`}  color={activePnl >= 0 ? '#22c55e' : '#ef4444'} sub="unrealised" />
        <StatCard label="Total P&L"       value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}    color={totalPnl >= 0 ? '#22c55e' : '#ef4444'}  sub={`${history.length} trades`} />
        <StatCard label="Win Rate"        value={`${winRate}%`}                 color={parseFloat(winRate) >= 60 ? '#22c55e' : parseFloat(winRate) >= 40 ? '#f59e0b' : '#ef4444'} sub={`${wins}W / ${history.length - wins}L`} />
      </div>

      {/* ── MIDDLE: Strategy + Risk config ──────────────────────────────── */}
      <div className="at-config-row">

        {/* Strategy selector */}
        <div className="config-panel">
          <div className="panel-title">Strategy</div>
          <div className="strategy-grid">
            {STRATEGIES.map(s => (
              <div
                key={s.id}
                className={`strategy-card ${selectedStrategy.id === s.id ? 'active' : ''}`}
                onClick={() => handleStrategyChange(s)}
              >
                <div className="strategy-card-name">{s.name}</div>
                <div className="strategy-card-tf">{s.timeframe}</div>
                <div className="strategy-card-desc">{s.description}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Risk management */}
        <div className="config-panel">
          <div className="panel-title">Risk Management</div>
          <div className="fields-grid">
            <NumberInput label="Lot Size"      value={lotSize}    onChange={setLotSize}    min={0.01} max={10}   step={0.01} unit="lots" />
            <NumberInput label="Stop Loss"     value={stopLoss}   onChange={setStopLoss}   min={1}    max={500}  step={1}    unit="pips" />
            <NumberInput label="Take Profit"   value={takeProfit} onChange={setTakeProfit} min={1}    max={1000} step={1}    unit="pips" />
            <NumberInput label="Max Trades"    value={maxTrades}  onChange={setMaxTrades}  min={1}    max={50}   step={1}    unit="open" />
            <NumberInput label="Max Drawdown"  value={maxDrawdown} onChange={setMaxDrawdown} min={1} max={50}   step={0.5}  unit="%" />
            <div className="field" />
          </div>
          <div className="toggle-row">
            <Toggle checked={trailingStop} onChange={setTrailingStop} label="Trailing Stop Loss" />
            <Toggle checked={martingale}   onChange={setMartingale}   label="Martingale (risky)" />
          </div>
          <div className="rr-display">
            R:R Ratio <strong style={{ color: '#00d4aa' }}> 1:{(takeProfit / stopLoss).toFixed(1)}</strong>
          </div>
        </div>

        {/* Pair selector */}
        <div className="config-panel pair-selector-panel">
          <div className="panel-title">Trading Pairs <span style={{ color: '#475569', fontWeight: 400, fontSize: 12 }}>({selectedPairs.length} selected)</span></div>
          <div className="pair-chips">
            {majorPairs.map(sym => (
              <button
                key={sym}
                className={`pair-chip ${selectedPairs.includes(sym) ? 'active' : ''}`}
                onClick={() => togglePair(sym)}
              >
                {sym}
              </button>
            ))}
          </div>
          <div className="pair-selector-hint">
            Click pairs to toggle. Bot will only trade selected pairs.
          </div>
        </div>
      </div>

      {/* ── BOTTOM: Positions + History ──────────────────────────────────── */}
      <div className="at-bottom-panel">
        <div className="panel-tabs">
          <button
            className={`panel-tab ${activeTab === 'positions' ? 'active' : ''}`}
            onClick={() => setActiveTab('positions')}
          >
            Open Positions
            {positions.length > 0 && <span className="tab-badge">{positions.length}</span>}
          </button>
          <button
            className={`panel-tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            Trade History
            {history.length > 0 && <span className="tab-badge">{history.length}</span>}
          </button>
        </div>

        <div className="table-wrap" style={{ marginTop: 0 }}>
          {activeTab === 'positions' && (
            <table className="screener-table">
              <thead>
                <tr>
                  {['Pair','Type','Lots','Open','Current','SL','TP','Pips','P&L','Opened',''].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan={11} style={{ textAlign: 'center', padding: '32px 0', color: '#475569' }}>
                      {botActive ? 'No open positions — bot is scanning…' : 'No open positions'}
                    </td>
                  </tr>
                ) : positions.map(pos => (
                  <PositionRow key={pos.id} pos={pos} onClose={handleClosePosition} />
                ))}
              </tbody>
            </table>
          )}

          {activeTab === 'history' && (
            <table className="screener-table">
              <thead>
                <tr>
                  {['ID','Pair','Type','Lots','Open','Close','Pips','P&L','Result','Closed'].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ textAlign: 'center', padding: '32px 0', color: '#475569' }}>
                      No trade history yet
                    </td>
                  </tr>
                ) : history.map(t => (
                  <HistoryRow key={t.id} trade={t} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import Screener from './components/Screener';
import AutoTrading from './components/AutoTrading';
import './App.css';

const TABS = [
  { id: 'screener',    label: 'Screener',     icon: '⊞' },
  { id: 'autotrading', label: 'Auto Trading', icon: '⚡' },
];

// ── Real-money warning modal ─────────────────────────────────────────────────
function RealMoneyModal({ onConfirm, onCancel }) {
  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div className="modal-icon">⚠️</div>
        <h2 className="modal-title">Switch to Real Money?</h2>
        <p className="modal-body">
          You are about to switch to <strong>Real Money mode</strong>. All trades
          placed in this mode will use <strong>real funds</strong> from your
          connected broker account.
        </p>
        <ul className="modal-list">
          <li>Real losses can occur</li>
          <li>Ensure your broker is connected</li>
          <li>Use proper risk management</li>
          <li>Only trade what you can afford to lose</li>
        </ul>
        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={onCancel}>Cancel</button>
          <button className="modal-btn confirm" onClick={onConfirm}>I Understand — Switch</button>
        </div>
      </div>
    </div>
  );
}

// ── Account mode switcher ────────────────────────────────────────────────────
function AccountSwitcher({ mode, onChange }) {
  return (
    <div className="acc-switcher">
      <button
        className={`acc-btn ${mode === 'demo' ? 'active-demo' : ''}`}
        onClick={() => onChange('demo')}
      >
        Demo
      </button>
      <button
        className={`acc-btn ${mode === 'real' ? 'active-real' : ''}`}
        onClick={() => onChange('real')}
      >
        Real
      </button>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab]   = useState('screener');
  const [accountMode, setAccountMode] = useState('demo');   // 'demo' | 'real'
  const [showModal, setShowModal]   = useState(false);
  const [realBalance] = useState(2548.30);
  const [demoBalance] = useState(10000.00);

  const now     = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  const isReal   = accountMode === 'real';
  const balance  = isReal ? realBalance : demoBalance;

  const handleModeChange = (mode) => {
    if (mode === 'real' && accountMode === 'demo') {
      setShowModal(true);
    } else {
      setAccountMode(mode);
    }
  };

  return (
    <div className={`app-root ${isReal ? 'real-mode' : ''}`}>

      {/* ── Real money warning modal ───────────────────────────────────────── */}
      {showModal && (
        <RealMoneyModal
          onConfirm={() => { setAccountMode('real'); setShowModal(false); }}
          onCancel={() => setShowModal(false)}
        />
      )}

      {/* ── Real-mode top banner ───────────────────────────────────────────── */}
      {isReal && (
        <div className="real-banner">
          <span className="real-banner-dot" />
          REAL MONEY MODE — Trades affect your actual broker account
          <button className="real-banner-switch" onClick={() => setAccountMode('demo')}>
            Switch to Demo
          </button>
        </div>
      )}

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className={`app-header ${isReal ? 'header-real' : ''}`}>
        <div className="header-left">
          <div className="logo">
            <span className="logo-icon">₣</span>
            <div>
              <span className="logo-name">ForexPro</span>
              <span className="logo-tag">TRADING SUITE</span>
            </div>
          </div>

          <nav className="main-nav">
            {TABS.map(t => (
              <button
                key={t.id}
                className={`nav-tab ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}
              >
                <span className="nav-tab-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="header-right">
          <div className="market-badge open">
            <span className="market-dot" />
            Markets Open
          </div>

          {/* Account switcher */}
          <AccountSwitcher mode={accountMode} onChange={handleModeChange} />

          <div className="header-time">
            <span className="time-val">{timeStr}</span>
            <span className="time-date">{dateStr} UTC</span>
          </div>

          <div className={`account-chip ${isReal ? 'account-chip-real' : ''}`}>
            <span className="account-icon">{isReal ? '💳' : '◉'}</span>
            <div>
              <div className="account-label">{isReal ? 'Real Account' : 'Demo Account'}</div>
              <div className={`account-balance ${isReal ? 'balance-real' : ''}`}>
                ${balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ── Tab indicator strip ────────────────────────────────────────────── */}
      <div className="tab-indicator-strip">
        <div
          className="tab-indicator-bar"
          style={{ left: activeTab === 'screener' ? '0%' : '50%', width: '50%' }}
        />
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <main className="app-main">
        {activeTab === 'screener'    && <Screener />}
        {activeTab === 'autotrading' && <AutoTrading accountMode={accountMode} />}
      </main>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="app-footer">
        <span>
          {isReal
            ? '⚠️ Real Money Mode — Trade responsibly'
            : 'ForexPro v1.0 · Demo data for illustration only'}
        </span>
        <span>Session: {dateStr}</span>
      </footer>
    </div>
  );
}

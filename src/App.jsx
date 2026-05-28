import { useState } from 'react';
import Screener from './components/Screener';
import AutoTrading from './components/AutoTrading';
import Backtester from './components/Backtester';
import WatchlistTab from './components/WatchlistTab';
import RatioChart from './components/RatioChart';
import Journal from './components/Journal';
import NewsCalendar from './components/NewsCalendar';
import COTTab from './components/COTTab';
import MetalsDashboard from './components/MetalsDashboard';
import CorrelationMatrix from './components/CorrelationMatrix';
import AIAnalysis from './components/AIAnalysis';
import { allInstruments } from './data/forexData';
import './App.css';

const TABS = [
  { id: 'ai',          label: 'AI',           icon: '🤖' },
  { id: 'screener',    label: 'Screener',     icon: '⊞' },
  { id: 'watchlist',   label: 'Watchlist',    icon: '★' },
  { id: 'autotrading', label: 'Auto Trading', icon: '⚡' },
  { id: 'backtester',  label: 'Backtester',   icon: '📊' },
  { id: 'ratio',       label: 'Au/Ag Ratio',  icon: '⚖' },
  { id: 'cot',         label: 'COT Report',   icon: '🏦' },
  { id: 'metals',      label: 'Metals',       icon: '⚜' },
  { id: 'correlation', label: 'Correlation',  icon: '⬡' },
  { id: 'journal',     label: 'Journal',      icon: '📋' },
  { id: 'news',        label: 'News',         icon: '📰' },
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
  const [activeTab, setActiveTab]     = useState('screener');
  const [accountMode, setAccountMode] = useState('demo');
  const [showModal, setShowModal]     = useState(false);
  const [realBalance] = useState(2548.30);
  const [demoBalance] = useState(10000.00);

  // ── Broker state lifted here so it persists on tab switch ─────────────────
  const [brokerConnected, setBrokerConnected]   = useState(false);
  const [brokerName, setBrokerName]             = useState('');
  const [brokerEnv, setBrokerEnv]               = useState('live');
  const [brokerAuthMethod, setBrokerAuthMethod] = useState('login');

  const brokerState = {
    connected: brokerConnected,
    name: brokerName,
    env: brokerEnv,
    authMethod: brokerAuthMethod,
    setConnected: setBrokerConnected,
    setName: setBrokerName,
    setEnv: setBrokerEnv,
    setAuthMethod: setBrokerAuthMethod,
  };

  const now     = new Date();
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

        {/* ── Top bar: logo + controls ─────────────────────────────────── */}
        <div className="header-topbar">
          <div className="logo">
            <span className="logo-icon">₣</span>
            <span className="logo-name">ForexPro</span>
          </div>

          <div className="header-controls">
            <div className={`account-chip ${isReal ? 'account-chip-real' : ''}`}>
              <div className="account-label">{isReal ? 'Real' : 'Demo'}</div>
              <div className={`account-balance ${isReal ? 'balance-real' : ''}`}>
                ${balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
              </div>
            </div>
            <AccountSwitcher mode={accountMode} onChange={handleModeChange} />
          </div>
        </div>

        {/* ── Nav tabs: full width, always visible ─────────────────────── */}
        <nav className="main-nav">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`nav-tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              <span className="nav-tab-icon">{t.icon}</span>
              <span className="nav-tab-label">{t.label}</span>
            </button>
          ))}
        </nav>

      </header>


      {/* ── Content ───────────────────────────────────────────────────────── */}
      <main className="app-main">
        {/* Keep both mounted (hidden) so state is preserved on tab switch */}
        <div style={{ display: activeTab === 'ai' ? 'flex' : 'none', flexDirection:'column', height:'calc(100vh - 120px)' }}>
          <AIAnalysis />
        </div>
        <div style={{ display: activeTab === 'screener' ? 'block' : 'none' }}>
          <Screener />
        </div>
        <div style={{ display: activeTab === 'watchlist' ? 'block' : 'none' }}>
          <WatchlistTab pairs={allInstruments} watchlist={JSON.parse(localStorage.getItem('forex_watchlist')||'[]')} onToggleWatch={sym => {
            const prev = JSON.parse(localStorage.getItem('forex_watchlist')||'[]');
            const next = prev.includes(sym) ? prev.filter(s=>s!==sym) : [...prev,sym];
            localStorage.setItem('forex_watchlist', JSON.stringify(next));
            window.dispatchEvent(new Event('storage'));
          }}/>
        </div>
        <div style={{ display: activeTab === 'autotrading' ? 'block' : 'none' }}>
          <AutoTrading accountMode={accountMode} brokerState={brokerState} />
        </div>
        <div style={{ display: activeTab === 'backtester' ? 'block' : 'none' }}>
          <Backtester />
        </div>
        <div style={{ display: activeTab === 'ratio' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          <RatioChart />
        </div>
        <div style={{ display: activeTab === 'cot' ? 'flex' : 'none', flexDirection:'column', height:'calc(100vh - 120px)' }}>
          <COTTab />
        </div>
        <div style={{ display: activeTab === 'metals' ? 'flex' : 'none', flexDirection:'column', height:'calc(100vh - 120px)' }}>
          <MetalsDashboard />
        </div>
        <div style={{ display: activeTab === 'correlation' ? 'flex' : 'none', flexDirection:'column', height:'calc(100vh - 120px)' }}>
          <CorrelationMatrix />
        </div>
        <div style={{ display: activeTab === 'journal' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          <Journal />
        </div>
        <div style={{ display: activeTab === 'news' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          <NewsCalendar />
        </div>
      </main>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="app-footer">
        <span>
          {isReal
            ? '⚠️ Real Money Mode — Trade responsibly'
            : 'ForexPro v1.3 · Demo data for illustration only'}
        </span>
        <span>Session: {dateStr}</span>
      </footer>
    </div>
  );
}

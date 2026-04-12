import { useState } from 'react';
import Screener from './components/Screener';
import AutoTrading from './components/AutoTrading';
import './App.css';

const TABS = [
  { id: 'screener',    label: 'Screener',     icon: '⊞' },
  { id: 'autotrading', label: 'Auto Trading', icon: '⚡' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('screener');
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="app-root">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="app-header">
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
          <div className="header-time">
            <span className="time-val">{timeStr}</span>
            <span className="time-date">{dateStr} UTC</span>
          </div>
          <div className="account-chip">
            <span className="account-icon">◉</span>
            <div>
              <div className="account-label">Demo Account</div>
              <div className="account-balance">$10,000.00</div>
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
        {activeTab === 'autotrading' && <AutoTrading />}
      </main>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="app-footer">
        <span>ForexPro v1.0 · Data is simulated for demonstration purposes</span>
        <span>Session: {dateStr}</span>
      </footer>
    </div>
  );
}

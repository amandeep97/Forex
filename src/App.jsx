import { useState, useEffect, lazy, Suspense } from 'react';
import Screener from './components/Screener';          // eager — default tab
import { allInstruments } from './data/forexData';
import './App.css';

// All non-default tabs load only when first visited (code + data)
const AIAnalysis       = lazy(() => import('./components/AIAnalysis'));
const PairHub          = lazy(() => import('./components/PairHub'));
const TradeDashboard   = lazy(() => import('./components/TradeDashboard'));
const WatchlistTab     = lazy(() => import('./components/WatchlistTab'));
const AutoTrading      = lazy(() => import('./components/AutoTrading'));
const Backtester       = lazy(() => import('./components/Backtester'));
const RatioChart       = lazy(() => import('./components/RatioChart'));
const COTTab           = lazy(() => import('./components/COTTab'));
const MetalsDashboard  = lazy(() => import('./components/MetalsDashboard'));
const IndicesDashboard = lazy(() => import('./components/IndicesDashboard'));
const ForexPairsDashboard = lazy(() => import('./components/ForexPairsDashboard'));
const TopDownSignals   = lazy(() => import('./components/TopDownSignals'));
const CorrelationMatrix= lazy(() => import('./components/CorrelationMatrix'));
const CurrencyStrength = lazy(() => import('./components/CurrencyStrength'));
const VolatilityDashboard= lazy(() => import('./components/VolatilityDashboard'));
const SeasonalityChart = lazy(() => import('./components/SeasonalityChart'));
const LiquidityMap     = lazy(() => import('./components/LiquidityMap'));
const Journal          = lazy(() => import('./components/Journal'));
const TradingNotebook  = lazy(() => import('./components/TradingNotebook'));
const NewsCalendar     = lazy(() => import('./components/NewsCalendar'));
const AlphaLab         = lazy(() => import('./components/AlphaLab'));
const SetupPlanner     = lazy(() => import('./components/SetupPlanner'));
const Analytics        = lazy(() => import('./components/Analytics'));
const DXYDashboard     = lazy(() => import('./components/DXYDashboard'));
const CommandCenter    = lazy(() => import('./components/CommandCenter'));
const PositionCalculator = lazy(() => import('./components/PositionCalculator'));
const Settings           = lazy(() => import('./components/Settings'));

function TabSpinner() {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'60vh', gap:10 }}>
      <div style={{ width:20, height:20, border:'2px solid var(--border)', borderTopColor:'var(--accent)',
        borderRadius:'50%', animation:'spin 0.7s linear infinite' }}/>
      <span style={{ color:'var(--text3)', fontSize:13 }}>Loading…</span>
    </div>
  );
}

const TABS = [
  { id: 'cmd',         label: 'Command',      icon: '⚡' },
  { id: 'ai',          label: 'AI',           icon: '🤖' },
  { id: 'dxy',         label: 'DXY',          icon: '💵' },
  { id: 'pairhub',     label: 'Pair Hub',     icon: '💱' },
  { id: 'dashboard',   label: 'Dashboard',    icon: '🎯' },
  { id: 'screener',    label: 'Screener',     icon: '⊞' },
  { id: 'signals',     label: 'Signals',      icon: '🎯' },
  { id: 'watchlist',   label: 'Watchlist',    icon: '★' },
  { id: 'autotrading', label: 'Auto Trading', icon: '⚡' },
  { id: 'backtester',  label: 'Backtester',   icon: '📊' },
  { id: 'ratio',       label: 'Au/Ag Ratio',  icon: '⚖' },
  { id: 'cot',         label: 'COT Report',   icon: '🏦' },
  { id: 'metals',      label: 'Metals',       icon: '⚜' },
  { id: 'indices',     label: 'Indices',      icon: '📊' },
  { id: 'pairs',       label: 'FX Pairs',     icon: '💱' },
  { id: 'correlation', label: 'Correlation',  icon: '⬡' },
  { id: 'strength',    label: 'Strength',     icon: '💪' },
  { id: 'volatility',  label: 'Volatility',   icon: '🌊' },
  { id: 'seasonality', label: 'Seasonality',  icon: '📅' },
  { id: 'liquidity',   label: 'Liquidity',    icon: '🏛' },
  { id: 'setups',      label: 'Setups',       icon: '📌' },
  { id: 'analytics',  label: 'Analytics',    icon: '📈' },
  { id: 'journal',    label: 'Journal',      icon: '📋' },
  { id: 'notebook',   label: 'Notebook',     icon: '📓' },
  { id: 'news',        label: 'News',         icon: '📰' },
  { id: 'alphalab',   label: 'Alpha Lab',    icon: '⚗' },
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
  const [visitedTabs, setVisitedTabs] = useState(() => new Set(['screener']));
  const [showCalc, setShowCalc]       = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const handler = e => {
      const tab = e.detail;
      setActiveTab(tab);
      setVisitedTabs(prev => new Set([...prev, tab]));
    };
    window.addEventListener('navigate-tab', handler);
    return () => window.removeEventListener('navigate-tab', handler);
  }, []);
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
            <button onClick={() => setShowCalc(true)} title="Position size calculator"
              style={{ background:'#0f172a', border:'1px solid #00d4aa44', borderRadius:9, cursor:'pointer',
                color:'#00d4aa', fontSize:17, padding:'5px 10px', lineHeight:1, marginRight:2 }}>
              🧮
            </button>
            <button onClick={() => setShowSettings(true)} title="Settings & API keys"
              style={{ background:'#0f172a', border:'1px solid #334155', borderRadius:9, cursor:'pointer',
                color:'#94a3b8', fontSize:17, padding:'5px 10px', lineHeight:1, marginRight:2 }}>
              ⚙️
            </button>
            {brokerConnected && (
              <>
                <div className={`account-chip ${isReal ? 'account-chip-real' : ''}`}>
                  <div className="account-label">{isReal ? 'Real' : 'Demo'}</div>
                  <div className={`account-balance ${isReal ? 'balance-real' : ''}`}>
                    ${balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </div>
                </div>
                <AccountSwitcher mode={accountMode} onChange={handleModeChange} />
              </>
            )}
          </div>
        </div>

        {/* ── Nav tabs: full width, always visible ─────────────────────── */}
        <nav className="main-nav">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`nav-tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => {
                setActiveTab(t.id);
                setVisitedTabs(prev => { prev.add(t.id); return new Set(prev); });
              }}
            >
              <span className="nav-tab-icon">{t.icon}</span>
              <span className="nav-tab-label">{t.label}</span>
            </button>
          ))}
        </nav>

      </header>

      {/* ── Global position size calculator ───────────────────────────────── */}
      {showCalc && (
        <Suspense fallback={null}>
          <PositionCalculator onClose={() => setShowCalc(false)} />
        </Suspense>
      )}

      {/* ── Global settings & API keys ────────────────────────────────────── */}
      {showSettings && (
        <Suspense fallback={null}>
          <Settings onClose={() => setShowSettings(false)} />
        </Suspense>
      )}

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <main className="app-main">
      <Suspense fallback={<TabSpinner />}>
        <div style={{ display: activeTab === 'cmd' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('cmd') && <CommandCenter />}
        </div>
        <div style={{ display: activeTab === 'ai' ? 'flex' : 'none', flexDirection:'column', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('ai') && <AIAnalysis />}
        </div>
        <div style={{ display: activeTab === 'dxy' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('dxy') && <DXYDashboard />}
        </div>
        <div style={{ display: activeTab === 'pairhub' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('pairhub') && <PairHub />}
        </div>
        <div style={{ display: activeTab === 'dashboard' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('dashboard') && <TradeDashboard />}
        </div>
        <div style={{ display: activeTab === 'screener' ? 'block' : 'none' }}>
          {visitedTabs.has('screener') && <Screener />}
        </div>
        <div style={{ display: activeTab === 'signals' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('signals') && <TopDownSignals />}
        </div>
        <div style={{ display: activeTab === 'watchlist' ? 'block' : 'none' }}>
          {visitedTabs.has('watchlist') && <WatchlistTab pairs={allInstruments} watchlist={JSON.parse(localStorage.getItem('forex_watchlist')||'[]')} onToggleWatch={sym => {
            const prev = JSON.parse(localStorage.getItem('forex_watchlist')||'[]');
            const next = prev.includes(sym) ? prev.filter(s=>s!==sym) : [...prev,sym];
            localStorage.setItem('forex_watchlist', JSON.stringify(next));
            window.dispatchEvent(new Event('storage'));
          }}/>}
        </div>
        <div style={{ display: activeTab === 'autotrading' ? 'block' : 'none' }}>
          {visitedTabs.has('autotrading') && <AutoTrading accountMode={accountMode} brokerState={brokerState} />}
        </div>
        <div style={{ display: activeTab === 'backtester' ? 'block' : 'none' }}>
          {visitedTabs.has('backtester') && <Backtester />}
        </div>
        <div style={{ display: activeTab === 'ratio' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('ratio') && <RatioChart />}
        </div>
        <div style={{ display: activeTab === 'cot' ? 'flex' : 'none', flexDirection:'column', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('cot') && <COTTab />}
        </div>
        <div style={{ display: activeTab === 'metals' ? 'flex' : 'none', flexDirection:'column', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('metals') && <MetalsDashboard />}
        </div>
        <div style={{ display: activeTab === 'indices' ? 'flex' : 'none', flexDirection:'column', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('indices') && <IndicesDashboard />}
        </div>
        <div style={{ display: activeTab === 'pairs' ? 'flex' : 'none', flexDirection:'column', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('pairs') && <ForexPairsDashboard />}
        </div>
        <div style={{ display: activeTab === 'correlation' ? 'flex' : 'none', flexDirection:'column', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('correlation') && <CorrelationMatrix />}
        </div>
        <div style={{ display: activeTab === 'strength' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('strength') && <CurrencyStrength />}
        </div>
        <div style={{ display: activeTab === 'volatility' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('volatility') && <VolatilityDashboard />}
        </div>
        <div style={{ display: activeTab === 'seasonality' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('seasonality') && <SeasonalityChart />}
        </div>
        <div style={{ display: activeTab === 'liquidity' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('liquidity') && <LiquidityMap />}
        </div>
        <div style={{ display: activeTab === 'setups' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('setups') && <SetupPlanner />}
        </div>
        <div style={{ display: activeTab === 'analytics' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('analytics') && <Analytics />}
        </div>
        <div style={{ display: activeTab === 'journal' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('journal') && <Journal />}
        </div>
        <div style={{ display: activeTab === 'notebook' ? 'block' : 'none', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('notebook') && <TradingNotebook />}
        </div>
        <div style={{ display: activeTab === 'news' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('news') && <NewsCalendar />}
        </div>
        <div style={{ display: activeTab === 'alphalab' ? 'block' : 'none', overflowY:'auto', height:'calc(100vh - 120px)' }}>
          {visitedTabs.has('alphalab') && <AlphaLab />}
        </div>
      </Suspense>
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

import { useState } from 'react';

export default function OandaConnect({ status, onConnect, onDisconnect }) {
  const [open,      setOpen]     = useState(false);
  const [apiKey,    setApiKey]   = useState('');
  const [practice,  setPractice] = useState(true);
  const [testing,   setTesting]  = useState(false);
  const [testError, setTestError]= useState('');

  const handleConnect = async () => {
    if (!apiKey.trim()) { setTestError('Please enter your API key'); return; }
    setTesting(true); setTestError('');
    const result = await onConnect(apiKey.trim(), practice);
    setTesting(false);
    if (result.ok) {
      setOpen(false);
      setApiKey('');
    } else {
      setTestError(result.error || 'Connection failed');
    }
  };

  const handleDisconnect = () => {
    onDisconnect();
    setOpen(false);
  };

  if (status.connected) {
    return (
      <>
        <button className="oanda-badge connected" onClick={()=>setOpen(true)}>
          <span className="oanda-dot"/>
          OANDA {status.practice ? 'Practice' : 'Live'}
        </button>
        {open && (
          <div className="oanda-modal-overlay" onClick={e=>e.target===e.currentTarget&&setOpen(false)}>
            <div className="oanda-modal">
              <div className="oanda-modal-head">
                <span>OANDA Connection</span>
                <button className="oanda-close" onClick={()=>setOpen(false)}>✕</button>
              </div>
              <div className="oanda-modal-body">
                <div className="oanda-connected-info">
                  <span className="oanda-dot large"/>
                  <div>
                    <div style={{fontWeight:600,color:'var(--text)'}}>Connected</div>
                    <div style={{fontSize:11,color:'var(--text2)',marginTop:2}}>
                      {status.practice ? 'Practice account' : 'Live account'} · ID: {status.accountId}
                    </div>
                  </div>
                </div>
                <p style={{fontSize:11,color:'var(--text3)',marginTop:8,lineHeight:1.5}}>
                  All Forex, Metals, Indices, and Energy prices are sourced from your OANDA account in real time.
                </p>
                <button className="oanda-disconnect-btn" onClick={handleDisconnect}>
                  Disconnect OANDA
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <button className="oanda-badge" onClick={()=>setOpen(true)}>
        🔌 Connect OANDA
      </button>
      {open && (
        <div className="oanda-modal-overlay" onClick={e=>e.target===e.currentTarget&&setOpen(false)}>
          <div className="oanda-modal">
            <div className="oanda-modal-head">
              <span>Connect OANDA API</span>
              <button className="oanda-close" onClick={()=>setOpen(false)}>✕</button>
            </div>
            <div className="oanda-modal-body">

              {/* Account type */}
              <div className="oanda-field-label">Account Type</div>
              <div className="oanda-type-row">
                <button
                  className={`oanda-type-btn ${practice?'active':''}`}
                  onClick={()=>setPractice(true)}>
                  Practice (Demo)
                </button>
                <button
                  className={`oanda-type-btn ${!practice?'active live':''}`}
                  onClick={()=>setPractice(false)}>
                  Live
                </button>
              </div>

              {/* API key */}
              <div className="oanda-field-label" style={{marginTop:14}}>API Key (Access Token)</div>
              <input
                className="oanda-input"
                type="password"
                placeholder="Paste your OANDA access token…"
                value={apiKey}
                onChange={e=>setApiKey(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&handleConnect()}
                autoComplete="off"
              />
              <div className="oanda-hint">
                Get a free API key: log in at{' '}
                <strong style={{color:'var(--text2)'}}>oanda.com</strong>
                {' '}→ My Account → Manage API Access → Generate Token
              </div>

              {testError && (
                <div className="oanda-error">⚠ {testError}</div>
              )}

              <button
                className="oanda-connect-btn"
                onClick={handleConnect}
                disabled={testing || !apiKey.trim()}>
                {testing ? '⟳ Testing connection…' : '⚡ Connect & Load Prices'}
              </button>

              <div className="oanda-footer-note">
                OANDA provides real-time prices for Forex, Metals, Indices, and Energy.
                A free practice account is sufficient — no deposit required.
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

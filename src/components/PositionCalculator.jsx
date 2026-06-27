'use strict';
import { useState, useEffect, useMemo, useCallback } from 'react';

// ── Instrument specs ──────────────────────────────────────────────────────────
// contract = units per 1 lot · pip = smallest tracked move · quote/base used for USD conversion
// oanda / binance = symbol for live price autofill
const INSTRUMENTS = [
  // Forex majors & crosses
  { sym:'EUR/USD', type:'Forex', contract:100000, pip:0.0001, oanda:'EUR_USD' },
  { sym:'GBP/USD', type:'Forex', contract:100000, pip:0.0001, oanda:'GBP_USD' },
  { sym:'USD/JPY', type:'Forex', contract:100000, pip:0.01,   oanda:'USD_JPY' },
  { sym:'USD/CHF', type:'Forex', contract:100000, pip:0.0001, oanda:'USD_CHF' },
  { sym:'USD/CAD', type:'Forex', contract:100000, pip:0.0001, oanda:'USD_CAD' },
  { sym:'AUD/USD', type:'Forex', contract:100000, pip:0.0001, oanda:'AUD_USD' },
  { sym:'NZD/USD', type:'Forex', contract:100000, pip:0.0001, oanda:'NZD_USD' },
  { sym:'EUR/GBP', type:'Forex', contract:100000, pip:0.0001, oanda:'EUR_GBP' },
  { sym:'EUR/JPY', type:'Forex', contract:100000, pip:0.01,   oanda:'EUR_JPY' },
  { sym:'GBP/JPY', type:'Forex', contract:100000, pip:0.01,   oanda:'GBP_JPY' },
  // Metals
  { sym:'XAU/USD', type:'Metals', contract:100,  pip:0.1,  unit:'oz', oanda:'XAU_USD' },
  { sym:'XAG/USD', type:'Metals', contract:5000, pip:0.01, unit:'oz', oanda:'XAG_USD' },
  // Indices (CFD: 1 unit = $1 per point)
  { sym:'US30',    type:'Indices', contract:1, pip:1,   unit:'contracts', oanda:'US30_USD' },
  { sym:'NAS100',  type:'Indices', contract:1, pip:1,   unit:'contracts', oanda:'NAS100_USD' },
  { sym:'SPX500',  type:'Indices', contract:1, pip:0.1, unit:'contracts', oanda:'SPX500_USD' },
  { sym:'GER40',   type:'Indices', contract:1, pip:1,   unit:'contracts', oanda:'DE30_EUR' },
  // Crypto (USDT ≈ USD)
  { sym:'BTC/USDT', type:'Crypto', contract:1, pip:1,    unit:'BTC', binance:'BTCUSDT' },
  { sym:'ETH/USDT', type:'Crypto', contract:1, pip:0.1,  unit:'ETH', binance:'ETHUSDT' },
  { sym:'SOL/USDT', type:'Crypto', contract:1, pip:0.01, unit:'SOL', binance:'SOLUSDT' },
];
const TYPES = ['Forex','Metals','Indices','Crypto'];
const TYPE_COLOR = { Forex:'#8b5cf6', Metals:'#f59e0b', Indices:'#22c55e', Crypto:'#f97316' };

// Value (USD) of a 1.0 price move for ONE lot. Precise for USD-quote & USD-base FX.
function valuePerPricePerLot(inst, entry) {
  const parts = inst.sym.split('/');
  const base = parts[0], quote = parts[1]; // quote undefined for index symbols (treated USD)
  if (!quote || quote === 'USD' || quote === 'USDT') return { v: inst.contract, approx:false };
  if (base === 'USD' && entry > 0) return { v: inst.contract / entry, approx:false };
  return { v: inst.contract, approx:true }; // cross pair — approximate
}

function getOandaCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) return c;
  } catch {}
  const apiKey = localStorage.getItem('oanda_key');
  const practice = localStorage.getItem('oanda_env') !== 'live';
  return apiKey ? { apiKey, practice } : null;
}

async function fetchLivePrice(inst) {
  if (inst.binance) {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${inst.binance}`, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) return null;
    const d = await r.json();
    return parseFloat(d.price) || null;
  }
  if (inst.oanda) {
    const creds = getOandaCreds();
    if (!creds?.apiKey) return null;
    const base = creds.practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
    const r = await fetch(`${base}/instruments/${inst.oanda}/candles?granularity=M5&count=1&price=M`,
      { headers:{ Authorization:`Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(7000) });
    if (!r.ok) return null;
    const d = await r.json();
    const c = d.candles?.[d.candles.length - 1];
    return c ? parseFloat(c.mid.c) : null;
  }
  return null;
}

const LS = 'forex_pos_calc_v2';
const USD_CHIPS = [0.5, 1, 2, 5, 10, 25, 50, 100];
const PCT_CHIPS = [0.5, 1, 2, 3];
const LEVS = [30, 100, 500];

export default function PositionCalculator({ onClose }) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } })();
  const [riskMode, setRiskMode] = useState(saved.riskMode ?? 'usd'); // 'usd' | 'pct'
  const [riskUsdIn, setRiskUsdIn] = useState(saved.riskUsdIn ?? '10');
  const [balance, setBalance]   = useState(saved.balance ?? '');
  const [riskPct, setRiskPct]   = useState(saved.riskPct ?? '1');
  const [sym, setSym]           = useState(saved.sym ?? 'EUR/USD');
  const [entry, setEntry]       = useState('');
  const [sl, setSl]             = useState('');
  const [tp, setTp]             = useState('');
  const [lev, setLev]           = useState(saved.lev ?? 100);
  const [fetching, setFetching] = useState(false);
  const [liveErr, setLiveErr]   = useState('');

  const inst = INSTRUMENTS.find(i => i.sym === sym) || INSTRUMENTS[0];

  useEffect(() => {
    localStorage.setItem(LS, JSON.stringify({ riskMode, riskUsdIn, balance, riskPct, sym, lev }));
  }, [riskMode, riskUsdIn, balance, riskPct, sym, lev]);

  const getLive = useCallback(async () => {
    setFetching(true); setLiveErr('');
    try {
      const p = await fetchLivePrice(inst);
      if (p) setEntry(String(p));
      else setLiveErr(inst.oanda ? 'Need OANDA key for live FX/metals/indices price' : 'Live price unavailable');
    } catch { setLiveErr('Live price fetch failed'); }
    setFetching(false);
  }, [inst]);

  const calc = useMemo(() => {
    const e = parseFloat(entry), s = parseFloat(sl);
    const riskUsd = riskMode === 'usd'
      ? parseFloat(riskUsdIn)
      : (parseFloat(balance) > 0 && parseFloat(riskPct) > 0 ? parseFloat(balance) * parseFloat(riskPct) / 100 : NaN);
    if (!(riskUsd > 0) || !(e > 0) || !(s > 0) || e === s) return null;

    const stopDist = Math.abs(e - s);
    const stopPips = stopDist / inst.pip;
    const { v, approx } = valuePerPricePerLot(inst, e);
    const lots  = riskUsd / (stopDist * v);
    const units = lots * inst.contract;
    const perPip = lots * v * inst.pip;
    const direction = s < e ? 'LONG' : 'SHORT';

    // Reward / R:R when TP provided
    const t = parseFloat(tp);
    let reward = null;
    if (t > 0 && t !== e) {
      const rewardDist = Math.abs(t - e);
      const rewardUsd  = lots * v * rewardDist;
      const rr = rewardDist / stopDist;
      const tpValid = direction === 'LONG' ? t > e : t < e;
      reward = { rewardUsd, rr, tpPips: rewardDist / inst.pip, tpValid };
    }

    // Notional & margin
    const notionalUsd = (inst.sym.split('/')[0] === 'USD') ? units : units * e;
    const margin = notionalUsd / lev;
    const acctPct = parseFloat(balance) > 0 ? riskUsd / parseFloat(balance) * 100 : null;

    return { riskUsd, stopDist, stopPips, lots, units, perPip, direction, reward, notionalUsd, margin, acctPct, approx };
  }, [entry, sl, tp, riskMode, riskUsdIn, balance, riskPct, inst, lev]);

  const isLot = inst.type === 'Forex' || inst.type === 'Metals';
  const sizeUnitLabel = inst.unit || 'units';

  const inp = (style={}) => ({ background:'#0f172a', color:'#e2e8f0', border:'1px solid #334155',
    borderRadius:8, padding:'9px 12px', fontSize:13, outline:'none', width:'100%', boxSizing:'border-box', ...style });
  const lbl = { fontSize:10, color:'#64748b', fontWeight:700, marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'0.04em' };
  const chip = (active, col='#00d4aa') => ({ padding:'6px 0', borderRadius:7, fontSize:12, fontWeight:700, cursor:'pointer',
    flex:1, textAlign:'center', border:`1px solid ${active ? col+'66' : '#1e293b'}`, background: active ? col+'18' : '#0f172a',
    color: active ? col : '#64748b' });

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.82)', display:'flex',
      alignItems:'flex-start', justifyContent:'center', zIndex:5000, padding:'40px 14px', overflowY:'auto' }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:'#0b111e', border:'1px solid #1e293b', borderRadius:16,
        width:'100%', maxWidth:460, padding:'18px 20px' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', marginBottom:3 }}>
          <div style={{ fontSize:16, fontWeight:800, color:'#f8fafc', flex:1 }}>🧮 Position Size Calculator</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#64748b', fontSize:24, cursor:'pointer', lineHeight:1 }}>×</button>
        </div>
        <div style={{ fontSize:10, color:'#475569', marginBottom:15 }}>Risk a fixed amount — never let one trade blow your account.</div>

        {/* Risk mode toggle */}
        <div style={{ display:'flex', gap:6, marginBottom:10 }}>
          <button onClick={()=>setRiskMode('usd')} style={chip(riskMode==='usd')}>Risk in $</button>
          <button onClick={()=>setRiskMode('pct')} style={chip(riskMode==='pct')}>Risk in % of account</button>
        </div>

        {/* Risk inputs */}
        {riskMode === 'usd' ? (
          <div style={{ marginBottom:12 }}>
            <label style={lbl}>Risk per trade ($)</label>
            <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:7 }}>
              {USD_CHIPS.map(v => (
                <button key={v} onClick={()=>setRiskUsdIn(String(v))}
                  style={{ ...chip(parseFloat(riskUsdIn)===v), flex:'0 0 auto', padding:'5px 12px' }}>${v}</button>
              ))}
            </div>
            <input type="number" step="any" placeholder="custom $ amount" value={riskUsdIn}
              onChange={e=>setRiskUsdIn(e.target.value)} style={inp()}/>
          </div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:12 }}>
            <div>
              <label style={lbl}>Account balance ($)</label>
              <input type="number" step="any" placeholder="e.g. 5000" value={balance}
                onChange={e=>setBalance(e.target.value)} style={inp()}/>
            </div>
            <div>
              <label style={lbl}>Risk %</label>
              <input type="number" step="any" placeholder="1" value={riskPct}
                onChange={e=>setRiskPct(e.target.value)} style={inp()}/>
              <div style={{ display:'flex', gap:4, marginTop:5 }}>
                {PCT_CHIPS.map(v => (
                  <button key={v} onClick={()=>setRiskPct(String(v))} style={chip(parseFloat(riskPct)===v)}>{v}%</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Instrument by type */}
        <label style={lbl}>Instrument</label>
        <div style={{ display:'flex', gap:5, marginBottom:7, flexWrap:'wrap' }}>
          {TYPES.map(tp2 => {
            const active = inst.type === tp2;
            const col = TYPE_COLOR[tp2];
            return (
              <button key={tp2} onClick={()=>setSym(INSTRUMENTS.find(i=>i.type===tp2).sym)}
                style={{ ...chip(active, col), flex:'0 0 auto', padding:'5px 13px' }}>{tp2}</button>
            );
          })}
        </div>
        <select value={sym} onChange={e=>{ setSym(e.target.value); setEntry(''); setSl(''); setTp(''); }} style={{ ...inp(), marginBottom:12 }}>
          {INSTRUMENTS.filter(i=>i.type===inst.type).map(i => <option key={i.sym}>{i.sym}</option>)}
        </select>

        {/* Price inputs */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:4 }}>
          <div style={{ gridColumn:'1 / -1' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <label style={lbl}>Entry price</label>
              <button onClick={getLive} disabled={fetching}
                style={{ background:'none', border:'none', color:'#00d4aa', fontSize:10, fontWeight:700, cursor:'pointer', marginBottom:5 }}>
                {fetching ? '⟳ loading…' : '⟳ use live'}
              </button>
            </div>
            <input type="number" step="any" placeholder="entry" value={entry}
              onChange={e=>setEntry(e.target.value)} style={inp()}/>
          </div>
          <div>
            <label style={lbl}>Stop loss</label>
            <input type="number" step="any" placeholder="stop" value={sl}
              onChange={e=>setSl(e.target.value)} style={inp({ border:'1px solid #ef444455' })}/>
          </div>
          <div>
            <label style={lbl}>Take profit <span style={{ textTransform:'none', color:'#334155' }}>(optional)</span></label>
            <input type="number" step="any" placeholder="target" value={tp}
              onChange={e=>setTp(e.target.value)} style={inp({ border:'1px solid #22c55e44' })}/>
          </div>
        </div>
        {liveErr && <div style={{ fontSize:9.5, color:'#f59e0b', marginBottom:6 }}>{liveErr}</div>}

        {/* Result */}
        {calc ? (
          <div style={{ background:'#0b1426', borderRadius:12, padding:'15px 16px', border:'1px solid #1e293b', marginTop:10 }}>
            {/* Headline size */}
            <div style={{ textAlign:'center', marginBottom:12 }}>
              <div style={{ fontSize:10, color:'#64748b', textTransform:'uppercase', letterSpacing:1, marginBottom:3 }}>
                {calc.direction} · Position Size
              </div>
              {isLot ? (
                <>
                  <div style={{ fontSize:32, fontWeight:900, color:'#00d4aa', lineHeight:1 }}>
                    {calc.lots.toFixed(calc.lots < 0.1 ? 3 : 2)} <span style={{ fontSize:15 }}>lots</span>
                  </div>
                  <div style={{ fontSize:11, color:'#94a3b8', marginTop:4 }}>
                    {(calc.lots*10).toFixed(1)} mini · {Math.round(calc.units).toLocaleString()} {sizeUnitLabel}
                  </div>
                </>
              ) : (
                <div style={{ fontSize:30, fontWeight:900, color:'#00d4aa', lineHeight:1 }}>
                  {calc.units < 1 ? calc.units.toFixed(4) : calc.units.toFixed(2)} <span style={{ fontSize:14 }}>{sizeUnitLabel}</span>
                </div>
              )}
            </div>

            {/* Metric rows */}
            {[
              ['Risk amount', `$${calc.riskUsd.toFixed(2)}`, '#f59e0b'],
              ['Stop distance', `${calc.stopPips.toFixed(1)} pips`, '#e2e8f0'],
              ['Value per pip', `$${calc.perPip.toFixed(2)}`, '#e2e8f0'],
            ].map(([k,v,c]) => (
              <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid #111c2e' }}>
                <span style={{ fontSize:11, color:'#64748b' }}>{k}</span>
                <span style={{ fontSize:12, fontWeight:700, color:c, fontFamily:'monospace' }}>{v}</span>
              </div>
            ))}

            {/* Reward / R:R */}
            {calc.reward && (
              <>
                <div style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid #111c2e' }}>
                  <span style={{ fontSize:11, color:'#64748b' }}>Potential reward</span>
                  <span style={{ fontSize:12, fontWeight:700, color:'#22c55e', fontFamily:'monospace' }}>
                    +${calc.reward.rewardUsd.toFixed(2)}
                  </span>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid #111c2e' }}>
                  <span style={{ fontSize:11, color:'#64748b' }}>Risk : Reward</span>
                  <span style={{ fontSize:12, fontWeight:800, fontFamily:'monospace',
                    color: calc.reward.rr >= 2 ? '#22c55e' : calc.reward.rr >= 1 ? '#f59e0b' : '#ef4444' }}>
                    1 : {calc.reward.rr.toFixed(2)}
                  </span>
                </div>
                {!calc.reward.tpValid && (
                  <div style={{ fontSize:9.5, color:'#ef4444', marginTop:5 }}>
                    ⚠ TP is on the wrong side of entry for a {calc.direction} trade
                  </div>
                )}
              </>
            )}

            {/* Margin / exposure */}
            <div style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid #111c2e' }}>
              <span style={{ fontSize:11, color:'#64748b' }}>Notional exposure</span>
              <span style={{ fontSize:12, fontWeight:700, color:'#94a3b8', fontFamily:'monospace' }}>${Math.round(calc.notionalUsd).toLocaleString()}</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0' }}>
              <span style={{ fontSize:11, color:'#64748b', display:'flex', alignItems:'center', gap:6 }}>
                Margin needed
                <select value={lev} onChange={e=>setLev(+e.target.value)}
                  style={{ background:'#0f172a', color:'#94a3b8', border:'1px solid #1e293b', borderRadius:5, fontSize:9, padding:'1px 4px' }}>
                  {LEVS.map(l => <option key={l} value={l}>1:{l}</option>)}
                </select>
              </span>
              <span style={{ fontSize:12, fontWeight:700, color:'#94a3b8', fontFamily:'monospace' }}>${Math.round(calc.margin).toLocaleString()}</span>
            </div>

            {calc.acctPct != null && (
              <div style={{ marginTop:8, fontSize:10, textAlign:'center',
                color: calc.acctPct > 3 ? '#ef4444' : calc.acctPct > 2 ? '#f59e0b' : '#22c55e' }}>
                Risking {calc.acctPct.toFixed(2)}% of account {calc.acctPct > 2 ? '— high, most pros risk ≤1-2%' : '✓ within safe range'}
              </div>
            )}

            {calc.approx && (
              <div style={{ marginTop:8, fontSize:9.5, color:'#f59e0b', lineHeight:1.4 }}>
                ⚠ Cross pair — pip value approximated (quote currency isn't USD). Verify with your broker.
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign:'center', padding:'18px 0', color:'#475569', fontSize:12, marginTop:6 }}>
            {riskMode === 'pct' && !(parseFloat(balance) > 0)
              ? 'Enter account balance, risk %, entry and stop'
              : 'Enter risk, entry and stop loss to calculate'}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useCallback } from 'react';
import Scanner from './Scanner';
import LiveFeed from './LiveFeed';
import InstrumentView from './InstrumentView';

// One screen, two modes and a detail view — the terminal idiom.
//
// This replaces three separate tabs (FLOW, Scan, Instrument) that overlapped
// badly: FLOW and Scan called the same feeds and answered nearly the same
// question, while Instrument sat apart from both. A terminal has one entry
// point and you navigate inside it, so the market list and the single-instrument
// view are now the same screen: pick a row to drill in, back to return.
//
// FLOW's panels were not lost — positioning and spread stress are what the scan
// ranks on, and its order book, funding and taker flow moved onto the crypto
// instruments they always described.
//
// FEED and SCAN are modes rather than separate tabs for the same reason: they
// ask related questions of overlapping measurements. SCAN is a snapshot
// computed when you press refresh; FEED is the same measures taken every minute
// by the VPS and filtered by rules you write. Putting them side by side in the
// nav bar would recreate exactly the FLOW/Scan duplication this file undid.
const MODES = [
  { id:'feed', label:'FEED', hint:'24/7 · your filters' },
  { id:'scan', label:'SCAN', hint:'snapshot · fixed rules' },
];

export default function Terminal() {
  const [mode, setMode]   = useState('feed');
  const [focus, setFocus] = useState(null);   // null = list, symbol = detail

  const open = useCallback(sym => setFocus(sym), []);
  const back = useCallback(() => setFocus(null), []);

  if (focus) return <InstrumentView sym={focus} onBack={back} />;

  return (
    <div>
      <div style={{ display:'flex', gap:6, alignItems:'center', padding:'7px 10px 0',
        background:'#080c11', fontFamily:'var(--mono, monospace)' }}>
        {MODES.map(m => (
          <button key={m.id} onClick={() => setMode(m.id)}
            style={{ fontSize:10, fontWeight:800, letterSpacing:'1px', padding:'3px 10px', borderRadius:3,
              cursor:'pointer', border:`1px solid ${mode === m.id ? '#00d4aa55' : '#16202b'}`,
              background: mode === m.id ? '#00d4aa15' : 'transparent',
              color: mode === m.id ? '#00d4aa' : '#475569' }}>
            {m.label}
          </button>
        ))}
        <span style={{ fontSize:8, color:'#2b3644' }}>
          {MODES.find(m => m.id === mode)?.hint}
        </span>
      </div>
      {mode === 'feed' ? <LiveFeed onOpen={open}/> : <Scanner onOpen={open}/>}
    </div>
  );
}

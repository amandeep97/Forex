import { useState, useCallback } from 'react';
import Scanner from './Scanner';
import InstrumentView from './InstrumentView';

// One screen, two states — the terminal idiom.
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
export default function Terminal() {
  const [focus, setFocus] = useState(null);   // null = market scan, symbol = detail

  const open  = useCallback(sym => setFocus(sym), []);
  const back  = useCallback(() => setFocus(null), []);

  return focus
    ? <InstrumentView sym={focus} onBack={back} />
    : <Scanner onOpen={open} />;
}

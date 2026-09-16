import { useState, useEffect, useCallback } from 'react';
import { ghRead, ghWrite } from '../utils/githubSync';
import { ago } from '../utils/liveFeed';

// ── THE SILVER DESK ──────────────────────────────────────────────────────────
//
// The same proposal that arrives on the phone, answerable here.
//
// Not a second engine. The bot proposes, this writes a decision, and the bot
// executes — the identical path Telegram's buttons take, which is why the two
// cannot both place an order for one proposal. Whichever answers first wins and
// the other finds it already closed.
//
// The reason to have it at all is that a phone can be off, in another room, or
// out of signal, and a proposal has an hour to live. The reason it is small is
// that there is nothing to decide here beyond yes or no: the size, the stop and
// the target were settled when the plan was built, and re-deciding them on a
// second screen is how two surfaces come to disagree about one trade.

const C = {
  bg: '#080c11', panel: '#0b1118', line: '#16202b', dim: '#475569', txt: '#cbd5e1',
  good: '#22c55e', bad: '#ef4444', warn: '#f59e0b', accent: '#38bdf8',
  mono: 'var(--mono, monospace)',
};

const DESK = 'bot/xag-desk.json';
const DECISIONS = 'bot/xag-decisions.json';

const STATE_TONE = {
  placed: { fg: C.good, label: 'PLACED' },
  rejected: { fg: '#64748b', label: 'SKIPPED' },
  expired: { fg: '#475569', label: 'EXPIRED' },
  failed: { fg: C.bad, label: 'NOT PLACED' },
  pending: { fg: C.warn, label: 'WAITING' },
  placing: { fg: C.accent, label: 'PLACING…' },
};

const px = (v, dp = 4) => (Number.isFinite(+v) ? Number(v).toFixed(dp) : '—');

function Row({ p }) {
  const t = STATE_TONE[p.state] || { fg: C.dim, label: String(p.state || '').toUpperCase() };
  return (
    <div style={{ padding: '7px 10px', borderTop: `1px solid ${C.line}`,
      display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 10 }}>
      <strong style={{ fontFamily: C.mono, color: C.txt }}>
        {p.dir === 'long' ? 'BUY' : 'SELL'} {p.units} oz
      </strong>
      <span style={{ fontFamily: C.mono, color: C.dim }}>
        @ {px(p.entry, p.precision)} · stop {px(p.stop, p.precision)}
      </span>
      <span style={{ fontSize: 8.5, fontWeight: 900, fontFamily: C.mono, color: t.fg,
        border: `1px solid ${t.fg}44`, background: `${t.fg}0d`, borderRadius: 3, padding: '0 5px' }}>
        {t.label}
      </span>
      {p.approvedBy && (
        <span style={{ fontSize: 8.5, color: '#334155', fontFamily: C.mono }}>via {p.approvedBy}</span>
      )}
      <span style={{ marginLeft: 'auto', fontSize: 8.5, color: '#334155', fontFamily: C.mono }}>
        {p.closedAt ? ago(Date.now() - p.closedAt) : p.proposedAt ? ago(Date.now() - p.proposedAt) : ''}
      </span>
      {p.why && (
        <div style={{ flexBasis: '100%', fontSize: 9, color: C.dim }}>{p.why}</div>
      )}
    </div>
  );
}

export default function XagDeskPanel({ onLog }) {
  const [desk, setDesk] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [, setTick] = useState(0);

  const pull = useCallback(async () => {
    try {
      const r = await ghRead(DESK, { noCache: true });
      setDesk(r?.content || null);
      setErr('');
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => {
    pull();
    const id = setInterval(pull, 20e3);
    // A separate, faster clock for the countdown, so "expires in 41 min" is not
    // frozen between polls. Re-rendering is cheap; a stale deadline on a screen
    // that asks for money is not.
    const t = setInterval(() => setTick(x => x + 1), 15e3);
    return () => { clearInterval(id); clearInterval(t); };
  }, [pull]);

  const decide = async (id, decision) => {
    setBusy(decision);
    try {
      // Read-modify-write against the live sha. Two decisions for two different
      // proposals must not clobber each other, and a blind write would.
      const cur = await ghRead(DECISIONS, { noCache: true }).catch(() => null);
      await ghWrite(DECISIONS,
        { ...(cur?.content || {}), [id]: decision },
        `XAG desk: ${decision} ${id}`, cur?.sha || null);
      onLog?.('INFO', `XAG desk: ${decision} ${id}`);
      // Optimistic only on the screen. The bot is what actually decides, and the
      // next poll replaces this with whatever really happened.
      setDesk(d => (d?.pending?.id === id
        ? { ...d, pending: { ...d.pending, state: decision === 'approve' ? 'placing' : 'rejected' } }
        : d));
      setTimeout(pull, 4000);
    } catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const p = desk?.pending;
  const live = desk?.live;
  const expired = p && p.expiresAt <= Date.now();
  const mins = p ? Math.max(0, Math.round((p.expiresAt - Date.now()) / 60e3)) : 0;

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 6 }}>
      <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.line}`,
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 11, color: C.txt, fontFamily: C.mono }}>SILVER DESK</strong>
        <span style={{ fontSize: 8.5, fontWeight: 900, fontFamily: C.mono,
          color: desk?.enabled ? C.good : '#475569',
          border: `1px solid ${desk?.enabled ? C.good : '#475569'}44`,
          borderRadius: 3, padding: '0 5px' }}>
          {desk?.enabled ? 'ARMED' : 'OFF'}
        </span>
        {live && (
          <span style={{ fontSize: 8.5, fontWeight: 900, fontFamily: C.mono, color: C.bad,
            border: `1px solid ${C.bad}44`, background: '#ef44440d', borderRadius: 3, padding: '0 5px' }}>
            LIVE MONEY
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 8.5, color: '#334155', fontFamily: C.mono }}>
          ${desk?.riskUsd ?? 3} risk · {desk?.at ? ago(Date.now() - Date.parse(desk.at)) : '—'}
        </span>
      </div>

      {err && <div style={{ padding: '7px 10px', fontSize: 9.5, color: C.bad }}>{err}</div>}

      {/* The proposal. Everything needed to say yes or no, and nothing to fiddle
          with — the size and the stop were settled when the plan was built. */}
      {p && p.state === 'pending' && !expired ? (
        <div style={{ padding: '10px' }}>
          <div style={{ fontSize: 12, fontWeight: 800, fontFamily: C.mono,
            color: p.dir === 'long' ? C.good : C.bad }}>
            {p.dir === 'long' ? 'BUY' : 'SELL'} LIMIT · {p.units} oz
          </div>
          <div style={{ fontSize: 10, color: C.dim, marginTop: 4, lineHeight: 1.7 }}>
            {p.level?.label} at <strong style={{ color: C.txt, fontFamily: C.mono }}>
              {px(p.level?.price, p.precision)}</strong> was swept and reclaimed
            {p.session && <> · {p.session} session</>}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6,
            fontSize: 10, fontFamily: C.mono }}>
            <span style={{ color: C.dim }}>entry <strong style={{ color: C.txt }}>{px(p.entry, p.precision)}</strong></span>
            <span style={{ color: C.dim }}>stop <strong style={{ color: C.bad }}>{px(p.stop, p.precision)}</strong></span>
            {p.target != null && (
              <span style={{ color: C.dim }}>target <strong style={{ color: C.txt }}>{px(p.target, p.precision)}</strong></span>
            )}
            <span style={{ color: C.dim }}>risk <strong style={{ color: C.txt }}>${p.riskUsd?.toFixed(2)}</strong></span>
          </div>

          <div style={{ fontSize: 9.5, color: C.warn, marginTop: 7, lineHeight: 1.6 }}>
            The replay found no edge in this model. This is a plan and a size,
            not a recommendation. Expires in {mins} min.
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
            <button onClick={() => decide(p.id, 'approve')} disabled={!!busy}
              style={{ flex: 1, padding: '9px 10px', borderRadius: 4, fontSize: 11, fontWeight: 800,
                fontFamily: C.mono, cursor: busy ? 'default' : 'pointer',
                border: `1px solid ${C.good}66`, background: '#22c55e14', color: C.good }}>
              {busy === 'approve' ? 'SENDING…' : `PLACE ${p.units} OZ`}
            </button>
            <button onClick={() => decide(p.id, 'reject')} disabled={!!busy}
              style={{ padding: '9px 14px', borderRadius: 4, fontSize: 11, fontWeight: 800,
                fontFamily: C.mono, cursor: busy ? 'default' : 'pointer',
                border: `1px solid ${C.line}`, background: 'transparent', color: C.dim }}>
              SKIP
            </button>
          </div>
        </div>
      ) : (
        <div style={{ padding: '12px 10px', fontSize: 10, color: C.dim, lineHeight: 1.7 }}>
          {!desk ? 'The desk has not published yet.'
            : !desk.enabled
              ? 'The desk is off. It places real orders, so it stays off until XAG_DESK=on is set on the VPS.'
              : p && (expired || p.state !== 'pending')
                ? 'Nothing waiting — the last proposal has been answered or has lapsed.'
                : 'Nothing waiting. A proposal appears here when silver takes a level and the plan arms.'}
        </div>
      )}

      {/* What happened before, so the panel can be checked against the account. */}
      {!!desk?.history?.length && (
        <div>
          <div style={{ padding: '6px 10px', fontSize: 8.5, fontWeight: 900, letterSpacing: 0.4,
            color: '#334155', fontFamily: C.mono, borderTop: `1px solid ${C.line}` }}>
            RECENT
          </div>
          {desk.history.slice(0, 8).map(h => <Row key={h.id} p={h}/>)}
        </div>
      )}
    </div>
  );
}

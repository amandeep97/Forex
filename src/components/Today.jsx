import { useState, useEffect, useCallback } from 'react';
import { loadToday } from '../utils/todayRead.js';

// The screen the app opens on.
//
// Twenty-eight tabs in a horizontal scroll and nothing saying where to start:
// the answer to "is there anything to do today" was four swipes and four cards
// away, and on some days it was ten model calls away as well.
//
// This loads in about a second from measured data — no language model, nothing
// to press. Three states per instrument, from arithmetic: a rule that survived
// the holdout is true on this bar, or it is one condition short, or there is
// nothing. Then the context behind it, and the clock.
//
// It deliberately does not score the macro read or the headlines into the
// verdict. Those have never been measured against an outcome, and turning them
// into a number would be inventing a signal — which is the habit the rest of
// this work exists to break. They are printed for a person to read.

const C = { bull: '#22c55e', bear: '#ef4444', neutral: '#94a3b8', warn: '#f59e0b' };

const Row = ({ children, ...s }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', ...s }}>{children}</div>
);

function Countdown({ ms }) {
  const h = Math.floor(ms / 3600e3);
  const m = Math.round((ms % 3600e3) / 60e3);
  const soon = ms < 2 * 3600e3;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: soon ? C.warn : 'var(--text2)' }}>
      {h > 0 ? `${h}h ${m}m` : `${m}m`}
    </span>
  );
}


// The headline at the top, with the clock on it.
//
// A severity-3 wire and a two-percent dump were on the same screen, twenty
// scrolls apart: the metals at the top, the headline at the bottom under the
// calendar. Whether one had anything to do with the other was left entirely to
// the reader's memory of what time it was.
//
// This states two measured facts adjacently — when it landed, and what the
// metals have done since that bar — and stops there. It does not say the
// headline caused the move; nothing in this app has ever measured that, and
// asserting cause from adjacency is exactly the habit the rest of this work
// exists to break. The sequence is the information.
function Breaking({ items }) {
  if (!items?.length) return null;
  const when = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const ago = m => (m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`);
  return (
    <div style={{ marginBottom: 14 }}>
      {items.map((h, i) => {
        const urgent = h.sev >= 3;
        const tone = urgent ? C.bear : C.warn;
        return (
          <a key={i} href={h.link} target="_blank" rel="noreferrer"
            style={{ display: 'block', textDecoration: 'none', marginBottom: 8,
              padding: '11px 13px', borderRadius: 8,
              background: `${tone}14`, border: `1px solid ${tone}55` }}>
            <Row style={{ gap: 7 }}>
              <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 3,
                background: `${tone}26`, color: tone, letterSpacing: '0.5px' }}>
                {urgent ? 'URGENT' : 'HEAVY'}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: tone }}>{when(h.at)}</span>
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>{ago(h.ageMin)}</span>
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>· {h.source}</span>
              {!h.direct && (
                <span style={{ fontSize: 9, color: 'var(--text3)' }}>· via a currency that prices it</span>
              )}
            </Row>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text1)',
              marginTop: 5, lineHeight: 1.45 }}>{h.title}</div>
            {h.since.length > 0 && (
              <Row style={{ gap: 14, marginTop: 7 }}>
                {h.since.map(s => (
                  <span key={s.label} style={{ fontSize: 11 }}>
                    <span style={{ color: 'var(--text3)' }}>{s.label} </span>
                    <b style={{ color: s.move.pct >= 0 ? C.bull : C.bear }}>
                      {s.move.pct >= 0 ? '+' : ''}{s.move.pct.toFixed(2)}%
                    </b>
                    <span style={{ color: 'var(--text3)' }}> since</span>
                  </span>
                ))}
                <span style={{ fontSize: 9, color: 'var(--text3)' }}>
                  measured from the bar it landed in — sequence, not cause
                </span>
              </Row>
            )}
          </a>
        );
      })}
    </div>
  );
}

function Instrument({ r }) {
  if (r.missing) {
    return (
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
        padding: 14, marginBottom: 12 }}>
        <Row>
          <span style={{ fontSize: 14, fontWeight: 800, color: r.inst.color }}>{r.inst.label}</span>
          <span style={{ fontSize: 11, color: C.warn }}>{r.missing}</span>
        </Row>
      </div>
    );
  }
  const v = r.verdict;
  const tone = C[v.tone] || C.neutral;
  const up = r.dayPct != null && r.dayPct >= 0;

  return (
    <div style={{ background: 'var(--bg2)', border: `1px solid ${tone}44`, borderRadius: 8,
      padding: 14, marginBottom: 12 }}>

      <Row>
        <span style={{ fontSize: 15, fontWeight: 800, color: r.inst.color }}>{r.inst.label}</span>
        <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text1)' }}>
          {r.price?.toFixed(r.inst.dec)}
        </span>
        {r.dayPct != null && (
          <span style={{ fontSize: 12, fontWeight: 700, color: up ? C.bull : C.bear }}>
            {up ? '+' : ''}{r.dayPct.toFixed(2)}% <span style={{ fontSize: 9, color: 'var(--text3)' }}>24h</span>
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 9,
          color: r.age?.stale ? C.warn : 'var(--text3)' }}>{r.age?.text}</span>
      </Row>

      {/* The answer. */}
      <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 6,
        background: `${tone}14`, border: `1px solid ${tone}44` }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: tone, letterSpacing: '0.4px' }}>
          {v.word}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4, lineHeight: 1.55 }}>
          {v.line}
        </div>
      </div>

      {/* What is driving it — the decomposition, not a correlation. */}
      {r.driver && (
        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 10, lineHeight: 1.55 }}>
          {r.driver.text}.
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
        {r.state.map(p => (
          <span key={p} style={{ fontSize: 9.5, padding: '2px 7px', borderRadius: 10,
            background: 'var(--bg1)', color: 'var(--text3)', border: '1px solid var(--border)' }}>{p}</span>
        ))}
      </div>
    </div>
  );
}

export default function Today() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setBusy(true); setErr(null);
    try { setData(await loadToday()); }
    catch (e) { setErr(e?.message || 'could not load'); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '12px 16px' }}>

      <Row>
        <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--text1)' }}>Today</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>
          {new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}
        </span>
        <button onClick={load} disabled={busy}
          style={{ marginLeft: 'auto', padding: '4px 12px', borderRadius: 5, fontSize: 11,
            cursor: busy ? 'default' : 'pointer', background: 'var(--bg2)', color: 'var(--text3)',
            border: '1px solid var(--border)' }}>
          {busy ? '⟳' : '↺'}
        </button>
      </Row>

      {err && <div style={{ fontSize: 11, color: C.bear, marginTop: 10 }}>{err}</div>}
      {busy && !data && (
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 14 }}>Reading the market…</div>
      )}

      {data && !data.connected && (
        <div style={{ fontSize: 11, color: C.warn, marginTop: 10, lineHeight: 1.55 }}>
          OANDA is not connected, so there are no prices to read. Add your key in the
          <b> Auto Trading</b> tab. The news and the calendar below work without it.
        </div>
      )}
      {data && !data.haveStudy && (
        <div style={{ fontSize: 11, color: C.warn, marginTop: 10 }}>
          The measured setups have not been published yet — the bot writes them on its next
          weekend tick. Everything else below is live.
        </div>
      )}

      {/* What just happened, before anything else on the page. */}
      <div style={{ marginTop: 12 }}><Breaking items={data?.breaking} /></div>

      {data?.rows.map(r => <Instrument key={r.inst.sym} r={r} />)}

      {/* ── The clock ────────────────────────────────────────────────────── */}
      {data?.events?.length > 0 && (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase',
            letterSpacing: '0.5px', marginBottom: 7 }}>High impact, next 36 hours</div>
          {data.events.map((e, i) => (
            <Row key={i} style={{ padding: '4px 0',
              borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <Countdown ms={e.inMs} />
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                <b style={{ color: 'var(--text3)' }}>{e.country}</b> {e.title}
              </span>
              {e.forecast ? (
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)' }}>
                  forecast {e.forecast}{e.previous ? ` · prev ${e.previous}` : ''}
                </span>
              ) : null}
            </Row>
          ))}
        </div>
      )}

      {/* ── What is being said ───────────────────────────────────────────── */}
      {data?.headlines?.length > 0 && (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase',
            letterSpacing: '0.5px', marginBottom: 7 }}>Headlines that touch these markets</div>
          {data.headlines.map((h, i) => (
            <a key={i} href={h.link} target="_blank" rel="noreferrer"
              style={{ display: 'block', padding: '5px 0', textDecoration: 'none',
                borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <Row style={{ gap: 6 }}>
                {h.sev >= 2 && (
                  <span style={{ fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                    background: `${C.warn}22`, color: C.warn, flexShrink: 0 }}>
                    {h.sev >= 3 ? 'URGENT' : 'HEAVY'}
                  </span>
                )}
                <span style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.45 }}>{h.title}</span>
              </Row>
              <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 2 }}>
                {h.source}{h.ageH != null ? ` · ${h.ageH}h ago` : ''}
                {h.direct ? '' : ' · about a currency that prices it'}
              </div>
            </a>
          ))}
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.55, marginBottom: 30 }}>
        The verdict is arithmetic, not an opinion: either a setup that survived the holdout is
        true on this bar, or it is one condition short, or there is nothing. The driver line and
        the headlines are context — they have never been scored against an outcome and are not
        part of the answer. For the argument on both sides, open the <b>Desk</b>.
      </div>
    </div>
  );
}

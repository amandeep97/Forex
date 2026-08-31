import { useState, useCallback, useEffect } from 'react';
import { DESK_INSTRUMENTS, gatherEvidence } from '../utils/deskEvidence.js';
import { runDesk, readLog, aiConfig, isReasoningModel } from '../utils/deskAgents.js';

// The desk: four analysts, a bull and a bear who argue, a trader who decides,
// a risk manager with a veto.
//
// Built on request, after the same structure appeared in a multi-agent trading
// framework. Two things travel with it and neither is decoration.
//
// It reads only measured evidence. The agents are told, in the system prompt,
// that their memory of markets is stale and unusable, and every figure they
// see comes from live OANDA bars, the published feed, the headline archive,
// COT, or the macro decomposition.
//
// And every verdict is logged with the price at the time, so the desk's own
// record can be checked later against what price did. That is the difference
// between this and the diagram it came from — the frameworks with thousands of
// stars have no measurement in them at all, which is why their own README says
// "research purposes, not intended as trading advice".

const STAGES = [
  { id: 'market', label: 'Market', icon: '📈' },
  { id: 'news', label: 'News', icon: '📰' },
  { id: 'macro', label: 'Macro', icon: '🏛' },
  { id: 'positioning', label: 'Positioning', icon: '🐘' },
];

const C = { bull: '#22c55e', bear: '#ef4444', neutral: '#94a3b8', warn: '#f59e0b' };

const Card = ({ children, tone, ...s }) => (
  <div style={{ background: 'var(--bg2)', border: `1px solid ${tone || 'var(--border)'}`,
    borderRadius: 8, padding: 12, ...s }}>{children}</div>
);

const Label = ({ children }) => (
  <div style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase',
    letterSpacing: '0.5px', marginBottom: 5 }}>{children}</div>
);

const Body = ({ children }) => (
  <div style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--text2)', whiteSpace: 'pre-wrap' }}>
    {children}
  </div>
);

// The evidence each analyst was handed, foldable. Without this the desk is a
// machine that produces paragraphs and there is no way to check whether it was
// told the truth.
function Evidence({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={() => setOpen(v => !v)}
        style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
          background: 'transparent', color: 'var(--text3)', border: '1px solid var(--border)' }}>
        {open ? 'hide' : 'show'} what it was given
      </button>
      {open && (
        <pre style={{ fontSize: 10, lineHeight: 1.5, color: 'var(--text3)', marginTop: 5,
          whiteSpace: 'pre-wrap', background: 'var(--bg1)', padding: 8, borderRadius: 5,
          maxHeight: 260, overflow: 'auto' }}>{text}</pre>
      )}
    </div>
  );
}

function Decision({ d, levelIssue, review, dec }) {
  if (!d) return null;
  const side = d.action === 'long' ? 'bull' : d.action === 'short' ? 'bear' : 'neutral';
  const vetoed = review?.verdict === 'veto';
  const n = v => (v == null || !Number.isFinite(+v) ? '—' : (+v).toFixed(dec ?? 2));
  return (
    <Card tone={vetoed ? `${C.warn}55` : `${C[side]}55`} style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 800, color: C[side] }}>
          {d.action === 'long' ? '▲ LONG' : d.action === 'short' ? '▼ SHORT' : '— STAND ASIDE'}
        </span>
        {d.conviction != null && (
          <span style={{ fontSize: 10, color: 'var(--text3)' }}>
            conviction {d.conviction}/5 · {d.horizon_hours}h
          </span>
        )}
        {vetoed && (
          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
            background: `${C.warn}22`, color: C.warn }}>VETOED BY RISK</span>
        )}
      </div>

      {d.action !== 'stand aside' && (
        <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
          {[['entry', d.entry], ['stop', d.stop], ['target', d.target]].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: 9, color: 'var(--text3)' }}>{k}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text1)' }}>{n(v)}</div>
            </div>
          ))}
        </div>
      )}

      {levelIssue && (
        <div style={{ fontSize: 10, color: C.warn, marginTop: 7 }}>
          ⚠ The levels do not check out — {levelIssue}. Arithmetic, not opinion: these were
          verified rather than trusted, because a target on the wrong side of entry reads
          perfectly well in prose.
        </div>
      )}

      {d.why && <div style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--text2)', marginTop: 8 }}>{d.why}</div>}

      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
        {d.invalidated_by && (
          <div style={{ fontSize: 10.5, color: 'var(--text3)' }}>
            <b style={{ color: '#94a3b8' }}>Wrong if:</b> {d.invalidated_by}
          </div>
        )}
        {d.strongest_opposing_point && (
          <div style={{ fontSize: 10.5, color: 'var(--text3)' }}>
            <b style={{ color: '#94a3b8' }}>Best point against:</b> {d.strongest_opposing_point}
          </div>
        )}
      </div>

      {review && (
        <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--border)' }}>
          <Label>Risk manager — {review.verdict}</Label>
          <Body>{review.reason}</Body>
          {review.changes && (
            <div style={{ fontSize: 10.5, color: C.warn, marginTop: 5 }}>Changes: {review.changes}</div>
          )}
          {review.biggest_risk && (
            <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 5 }}>
              <b style={{ color: '#94a3b8' }}>Biggest risk:</b> {review.biggest_risk}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export default function TradingDesk() {
  const [inst, setInst] = useState(DESK_INSTRUMENTS[0]);
  const [ev, setEv] = useState(null);
  const [reports, setReports] = useState([]);
  const [debate, setDebate] = useState([]);
  const [trader, setTrader] = useState(null);
  const [risk, setRisk] = useState(null);
  const [levelIssue, setLevelIssue] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState(null);
  const [log, setLog] = useState([]);
  const [rounds, setRounds] = useState(0);
  const [wait, setWait] = useState(0);

  useEffect(() => { setLog(readLog()); }, []);

  const cfg = aiConfig();

  const run = useCallback(async () => {
    setErr(null); setReports([]); setDebate([]); setTrader(null); setRisk(null);
    setLevelIssue(null); setEv(null);
    try {
      setBusy('gathering evidence');
      const pack = await gatherEvidence(inst, { onStep: s => setBusy(`gathering ${s}`) });
      setEv(pack);

      await runDesk(pack, {
        rounds,
        onStage: (s) => {
          if (s.stage === 'analyst') {
            setBusy(`${s.report.label} done`);
            setReports(r => [...r, s.report]);
          } else if (s.stage === 'bull' || s.stage === 'bear') {
            setBusy(`${s.stage} case, round ${s.round + 1}`);
            setDebate(d => {
              const next = [...d];
              next[s.round] = { ...(next[s.round] || {}), [s.stage]: s.text };
              return next;
            });
          } else if (s.stage === 'trader') {
            setBusy('trader deciding');
            setTrader(s.decision || { action: 'stand aside', why: s.raw });
            setLevelIssue(s.levelIssue);
          } else if (s.stage === 'risk') {
            setBusy('risk review');
            setRisk(s.review);
          } else if (s.stage === 'wait') {
            // A free tier allows about 8,000 tokens a minute and a full desk run
            // needs more, so it waits rather than failing halfway. Saying so
            // beats a spinner that looks hung.
            setWait(s.secs);
            setBusy(`rate limited — waiting ${s.secs}s`);
          }
        },
      });
      setLog(readLog());
    } catch (e) {
      setErr(e.message || String(e));
    } finally { setBusy(''); setWait(0); }
  }, [inst, rounds]);

  const thin = ev && Object.entries(ev.have || {}).filter(([, v]) => !v).map(([k]) => k);

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '12px 16px' }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text1)' }}>🏛 Research Desk</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>
          four analysts · bull vs bear · trader · risk veto
        </span>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6, marginTop: 8,
        padding: '8px 10px', background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 6 }}>
        <b style={{ color: C.warn }}>Read this once.</b> This is an opinion, not a signal. There
        is no evidence — in this app or in any published multi-agent trading framework — that a
        language model arguing with itself beats a coin. What it is good for is reading a lot of
        evidence quickly and stating the case against you, which is the part people skip.
        <div style={{ marginTop: 5 }}>
          Two things make it worth having: the agents see <b>only measured evidence</b> and are
          told their own market memory is stale and unusable, and <b>every verdict is logged with
          the price at the time</b> so this panel can eventually show you its own record.
          {log.length > 0 && (
            <> It has issued <b>{log.length}</b> verdict{log.length === 1 ? '' : 's'} so far
              ({log.filter(r => r.action === 'long').length} long,
              {' '}{log.filter(r => r.action === 'short').length} short,
              {' '}{log.filter(r => r.action === 'stand aside').length} stand aside).</>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {DESK_INSTRUMENTS.map(i => (
          <button key={i.sym} onClick={() => setInst(i)} disabled={!!busy}
            style={{ padding: '4px 10px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
              fontWeight: inst.sym === i.sym ? 700 : 400,
              background: inst.sym === i.sym ? '#3b82f622' : 'transparent',
              color: inst.sym === i.sym ? '#3b82f6' : 'var(--text3)',
              border: `1px solid ${inst.sym === i.sym ? '#3b82f644' : 'var(--border)'}` }}>
            {i.label}
          </button>
        ))}
        <select value={rounds} onChange={e => setRounds(+e.target.value)} disabled={!!busy}
          style={{ fontSize: 11, padding: '4px 6px', borderRadius: 5, background: 'var(--bg2)',
            color: 'var(--text2)', border: '1px solid var(--border)' }}>
          <option value={0}>1 exchange · ~8 calls</option>
          <option value={1}>2 exchanges · ~10 calls</option>
          <option value={2}>3 exchanges · ~12 calls</option>
        </select>
        <button onClick={run} disabled={!!busy || !cfg.key}
          style={{ marginLeft: 'auto', padding: '6px 16px', borderRadius: 5, fontSize: 12,
            fontWeight: 700, cursor: busy || !cfg.key ? 'default' : 'pointer',
            background: busy ? 'var(--bg2)' : '#3b82f6', color: busy ? 'var(--text3)' : '#fff',
            border: 'none', opacity: cfg.key ? 1 : 0.5 }}>
          {busy ? `⟳ ${busy}…` : 'Run the desk'}
        </button>
      </div>

      {cfg.key && isReasoningModel(cfg.model) && (
        <div style={{ fontSize: 11, color: C.warn, marginTop: 10, lineHeight: 1.55 }}>
          <b>{cfg.model}</b> is a reasoning model. It thinks before it answers and the thinking
          comes out of the same budget as the reply, which makes a desk run three times more
          expensive and can return blank cards. The desk asks Groq to switch the thinking off and
          gives it extra room, but an instruct model is faster, cheaper and will not do this at
          all — change it in the <b>AI</b> tab.
        </div>
      )}
      {!cfg.key && (
        <div style={{ fontSize: 11, color: C.warn, marginTop: 10 }}>
          No AI key. Add one in the <b>AI</b> tab → Settings. Groq is free — console.groq.com.
        </div>
      )}
      {err && <div style={{ fontSize: 11, color: C.bear, marginTop: 10 }}>Failed: {err}</div>}
      {wait > 0 && busy && (
        <div style={{ fontSize: 11, color: C.warn, marginTop: 10 }}>
          Rate limited by the free tier — waiting {wait}s and carrying on. The reports already
          below are finished and will not be re-run.
        </div>
      )}

      {ev && (
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 10 }}>
          {ev.label} {ev.price?.toFixed(ev.dec)} · hourly ATR {ev.atr?.toFixed(ev.dec)}
          {ev.spread != null ? ` · spread ${ev.spread.toFixed(ev.dec)}` : ' · spread unavailable'}
          {' · '}{ev.news.length} tagged headline{ev.news.length === 1 ? '' : 's'}
          {' · '}{ev.events.length} scheduled in 48h
          {ev.rules.length ? ` · ${ev.rules.length} measured setup firing` : ' · no measured setup firing'}
          {thin?.length ? (
            <span style={{ color: C.warn }}> · missing: {thin.join(', ')}</span>
          ) : null}
        </div>
      )}

      {/* ── The four analysts ───────────────────────────────────────────────── */}
      {reports.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 10, marginTop: 12 }}>
          {reports.map(r => (
            <Card key={r.id}>
              <Label>{r.icon} {r.label}</Label>
              {r.text
                ? <Body>{r.text}</Body>
                : (
                  <div style={{ fontSize: 11, color: C.warn, lineHeight: 1.55 }}>
                    This one came back empty. A reasoning model spends its scratchpad out of the
                    same output budget as its answer, so it can deliberate until the budget is
                    gone and reply with nothing. Pick a non-reasoning model in the AI tab.
                  </div>
                )}
              <Evidence text={r.evidence} />
            </Card>
          ))}
        </div>
      )}

      {/* ── The argument ────────────────────────────────────────────────────── */}
      {debate.length > 0 && debate.map((d, i) => (
        <div key={i} style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>
            Exchange {i + 1}{i > 0 ? ' — each side answering the other' : ''}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 10 }}>
            {d.bull && (
              <Card tone={`${C.bull}44`}>
                <Label><span style={{ color: C.bull }}>▲ Bull researcher</span></Label>
                <Body>{d.bull}</Body>
              </Card>
            )}
            {d.bear && (
              <Card tone={`${C.bear}44`}>
                <Label><span style={{ color: C.bear }}>▼ Bear researcher</span></Label>
                <Body>{d.bear}</Body>
              </Card>
            )}
          </div>
        </div>
      ))}

      {/* ── The decision ────────────────────────────────────────────────────── */}
      <Decision d={trader} levelIssue={levelIssue} review={risk} dec={ev?.dec} />

      {/* ── The record ──────────────────────────────────────────────────────── */}
      {log.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Label>Its own record — every verdict, with the price at the time</Label>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>
            Kept so this can be scored against what price actually did, the same way every
            setup in this app is scored. Until there are enough of them it is a list, not a
            record — and a list is still more than any of these frameworks publish.
          </div>
          {log.slice(0, 12).map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 10.5,
              padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--text3)', width: 96, flexShrink: 0 }}>
                {new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span style={{ width: 54, flexShrink: 0, color: 'var(--text2)' }}>{r.sym?.replace('_', '/')}</span>
              <span style={{ width: 74, flexShrink: 0, fontWeight: 700,
                color: r.action === 'long' ? C.bull : r.action === 'short' ? C.bear : C.neutral }}>
                {r.action}
              </span>
              <span style={{ color: 'var(--text3)' }}>at {r.price}</span>
              {r.verdict === 'veto' && <span style={{ color: C.warn }}>vetoed</span>}
              <span style={{ marginLeft: 'auto', color: 'var(--text3)' }}>{r.horizon}h</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ height: 40 }} />
    </div>
  );
}

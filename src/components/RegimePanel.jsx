import { useState, useEffect, useCallback } from 'react';
import {
  fetchRegimeStudy, stateNow, firing, nearMisses,
  headline, VERDICT_TEXT, NOVELTY_TEXT,
  DOLLAR_INSTRUMENT, RATE_INSTRUMENT, invertDollar,
} from '../utils/regimeRead.js';
import { PHRASE } from '../../shared/moveFeatures.mjs';

// What is working now, and what the moves that mattered had in common.
//
// Three studies before this one were published to the repository and shown
// nowhere, which is most of the reason they never helped anybody. This one is
// on screen, it is evaluated against live bars, and when nothing survived it
// says so in the first line rather than filling the space with numbers.

const C = {
  confirmed: '#22c55e', holds: '#84cc16', fades: '#f59e0b',
  fails: '#ef4444', thin: '#64748b',
};
const NOVEL = {
  new: '#22c55e', 'stronger-now': '#84cc16', longstanding: '#94a3b8',
  faded: '#f59e0b', marginal: '#64748b', 'no-history': '#64748b',
};

const METALS = [
  { sym: 'XAU_USD', label: 'Gold', color: '#fbbf24' },
  { sym: 'XAG_USD', label: 'Silver', color: '#94a3b8' },
];

function creds() {
  try {
    const c = JSON.parse(localStorage.getItem('oanda_creds') || 'null');
    if (c?.apiKey) {
      const e = localStorage.getItem('oanda_env');
      return e !== null ? { ...c, practice: e !== 'live' } : c;
    }
  } catch { /* a corrupt blob in storage is not a reason to blank the panel */ }
  const apiKey = localStorage.getItem('oanda_key');
  return apiKey ? { apiKey, practice: localStorage.getItem('oanda_env') !== 'live' } : null;
}

// Two thousand hourly bars, not two hundred. The volatility baseline is the
// median ATR of the trailing month and the previous-week levels need a previous
// week; on a short series both come back null and every condition that depends
// on them silently disappears from the live read.
async function bars(sym) {
  const c = creds();
  if (!c) return null;
  const base = c.practice
    ? 'https://api-fxpractice.oanda.com/v3'
    : 'https://api-fxtrade.oanda.com/v3';
  const res = await fetch(
    `${base}/instruments/${sym}/candles?granularity=H1&count=2000&price=M`,
    { headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(20000) });
  // An instrument the account cannot see is a real state — the macro read
  // simply does not appear. It must not blank the rest of the panel.
  if (!res.ok) return null;
  const d = await res.json();
  return (d.candles || []).filter(x => x.complete).map(x => ({
    t: new Date(x.time).getTime(),
    o: +x.mid.o, h: +x.mid.h, l: +x.mid.l, c: +x.mid.c, v: x.volume || 1,
  }));
}

const ago = (iso) => {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 86400e3;
  if (d < 1) return 'measured today';
  const n = Math.round(d);
  return `measured ${n} day${n === 1 ? '' : 's'} ago`;
};

const Row = ({ children, ...s }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...s }}>{children}</div>
);

// A number with its label and, where there is one, its error bar. A coefficient
// printed without an error bar is an opinion with a decimal point on it.
const Stat = ({ label, value, note, tone }) => (
  <div>
    <div style={{ fontSize: 9, color: 'var(--text3)' }}>{label}</div>
    <div style={{ fontSize: 13, fontWeight: 700, color: tone || 'var(--text1)' }}>{value}</div>
    {note && <div style={{ fontSize: 9, color: 'var(--text3)' }}>{note}</div>}
  </div>
);

const Head = ({ children, note }) => (
  <div style={{ marginTop: 16, marginBottom: 6 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8',
      textTransform: 'uppercase', letterSpacing: '0.5px' }}>{children}</div>
    {note && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{note}</div>}
  </div>
);

// A ratio around 1 means the condition was equally common at the turns that ran
// and the turns that died — which is the answer "it does not separate them",
// and it needs to look like one rather than like a small bar.
function RatioBar({ ratio }) {
  const lg = Math.max(-1.2, Math.min(1.2, Math.log(ratio || 1)));
  const w = Math.abs(lg) / 1.2 * 50;
  const up = lg >= 0;
  return (
    <div style={{ position: 'relative', height: 10, flex: 1, minWidth: 90,
      background: '#0f172a', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: '50%', top: 0, width: 1, height: '100%',
        background: '#334155' }} />
      <div style={{ position: 'absolute', top: 1, height: 8, borderRadius: 2,
        left: up ? '50%' : `${50 - w}%`, width: `${w}%`,
        background: up ? '#22c55e' : '#ef4444' }} />
    </div>
  );
}

export default function RegimePanel() {
  const [study, setStudy] = useState(null);
  const [live, setLive] = useState({});
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState('now');

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const s = await fetchRegimeStudy();
      setStudy(s);
      const cs = {};
      for (const m of METALS) cs[m.sym] = await bars(m.sym);
      // The two things gold is mostly a function of. Fetched separately so a
      // missing entitlement on the bond costs the metals nothing.
      const dollarUp = invertDollar(await bars(DOLLAR_INSTRUMENT).catch(() => null));
      const rate = await bars(RATE_INSTRUMENT).catch(() => null);

      const out = {};
      for (const m of METALS) {
        const other = METALS.find(x => x.sym !== m.sym);
        if (!cs[m.sym]) continue;
        const st = stateNow(cs[m.sym], {
          sym: m.sym, partner: cs[other.sym], dollarUp, rate, name: m.label.toLowerCase(),
        });
        if (!st) continue;
        out[m.sym] = {
          ...st,
          firing: firing(s, st.keys),
          near: nearMisses(s, st.keys, 1),
        };
      }
      setLive(out);
    } catch (e) {
      // The study is published weekly and the bars need OANDA. Which of the two
      // failed changes what the user should do about it, so say which.
      setErr(e?.message?.includes('regime study')
        ? 'The study has not been published yet — the bot writes it on its next weekend tick.'
        : (e?.message || 'could not load'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const live1 = study?.rules?.filter(r => r.verdict === 'confirmed' || r.verdict === 'holds') || [];
  const dead = study?.rules?.filter(r => !(r.verdict === 'confirmed' || r.verdict === 'holds')) || [];
  const anyFiring = METALS.some(m => live[m.sym]?.firing?.length);

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
      padding: 14, marginBottom: 14 }}>

      <Row>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text1)' }}>
          What is working now
        </span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>
          gold &amp; silver · hourly · {study ? ago(study.asOf) : ''}
        </span>
        <button onClick={load} disabled={loading}
          style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 4, fontSize: 10,
            cursor: 'pointer', background: 'var(--bg1)', color: 'var(--text3)',
            border: '1px solid var(--border)' }}>
          {loading ? '⟳' : '↺'}
        </button>
      </Row>

      {err && <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 8 }}>{err}</div>}

      {study && (
        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6, lineHeight: 1.5 }}>
          {headline(study)}. Candidates were searched on alternating fortnights of the
          last year and scored on the fortnights in between, which the search never
          saw — so a rule here has already survived the test that killed the others.
        </div>
      )}

      {study && (
        <Row style={{ marginTop: 10, gap: 4 }}>
          {[['now', 'Right now'], ['rules', `Rules (${live1.length})`],
            ['why', 'Why moves run'], ['changed', 'What changed'],
            ['dead', `Rejected (${dead.length})`]].map(([k, t]) => (
            <button key={k} onClick={() => setOpen(k)}
              style={{ padding: '3px 9px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
                fontWeight: open === k ? 700 : 400,
                background: open === k ? '#3b82f622' : 'transparent',
                color: open === k ? '#3b82f6' : 'var(--text3)',
                border: `1px solid ${open === k ? '#3b82f644' : 'var(--border)'}` }}>{t}</button>
          ))}
        </Row>
      )}

      {/* ── Right now ──────────────────────────────────────────────────────── */}
      {study && open === 'now' && (
        <div>
          {!Object.keys(live).length && !loading && (
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 10 }}>
              Connect OANDA to read the live state. The study below is readable without it.
            </div>
          )}
          {METALS.map(m => {
            const s = live[m.sym];
            if (!s) return null;
            return (
              <div key={m.sym} style={{ marginTop: 12, paddingTop: 10,
                borderTop: '1px solid var(--border)' }}>
                <Row>
                  <span style={{ fontSize: 12, fontWeight: 700, color: m.color }}>{m.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                    {s.close?.toFixed(m.sym === 'XAU_USD' ? 2 : 3)}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>
                    bar of {new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })}
                  </span>
                </Row>

                {/* What is actually moving it. Not a correlation — the move
                    split into the part the dollar and the ten-year forced and
                    the part they did not, which are different trades. */}
                {s.driver && (
                  <div style={{ marginTop: 7, padding: '8px 10px', borderRadius: 6,
                    background: 'var(--bg1)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 11, color: 'var(--text1)', lineHeight: 1.55 }}>
                      {s.driver.text}.
                    </div>
                    <Row style={{ marginTop: 6, gap: 12, flexWrap: 'wrap' }}>
                      <Stat label="macro explains" value={`${Math.round(s.driver.r2 * 100)}%`}
                        tone={s.driver.r2 >= 0.4 ? '#94a3b8' : '#f59e0b'} />
                      <Stat label="vs dollar" value={s.driver.b1.toFixed(2)}
                        note={s.driver.dollarSig ? `±${s.driver.se1.toFixed(2)}` : 'not significant'}
                        tone={s.driver.dollarSig ? (s.driver.b1 < 0 ? '#94a3b8' : '#f59e0b') : '#64748b'} />
                      <Stat label="vs yields" value={s.driver.b2.toFixed(2)}
                        note={s.driver.rateSig ? `±${s.driver.se2.toFixed(2)}` : 'not significant'}
                        tone={s.driver.rateSig ? (s.driver.b2 < 0 ? '#94a3b8' : '#f59e0b') : '#64748b'} />
                      {s.driver.push != null && (
                        <Stat label="beyond the macro" value={`${s.driver.push > 0 ? '+' : ''}${s.driver.push}σ`}
                          note={`over ${12}h`}
                          tone={Math.abs(s.driver.push) >= 1.5
                            ? (s.driver.push > 0 ? '#22c55e' : '#ef4444') : '#64748b'} />
                      )}
                    </Row>
                    {s.driver.shift?.dollar != null && Math.abs(s.driver.shift.dollar) >= 2.5 && (
                      <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 5 }}>
                        ⚠ Its relationship with the dollar has changed since ten days ago
                        (z={s.driver.shift.dollar}). The usual intermarket read is describing
                        something that has stopped operating.
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {s.plain.map(p => (
                    <span key={p} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10,
                      background: 'var(--bg1)', color: 'var(--text2)',
                      border: '1px solid var(--border)' }}>{p}</span>
                  ))}
                </div>

                {s.firing.length > 0 ? s.firing.map(r => (
                  <div key={r.id} style={{ marginTop: 8, padding: '7px 10px', borderRadius: 6,
                    background: '#22c55e14', border: '1px solid #22c55e44' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e' }}>
                      {r.dir === 'up' ? '▲ long' : '▼ short'} · {r.text}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 3 }}>
                      {r.holdout?.expR > 0 ? '+' : ''}{r.holdout?.expR}R a trade against{' '}
                      {r.holdout?.baseExpR}R for any entry, over {r.holdout?.n} trades on the
                      unseen half. Stop {study.method?.stopAtr} ATR, target {study.method?.rr}×,
                      out within {r.hold} hours.
                    </div>
                  </div>
                )) : (
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 7 }}>
                    No surviving rule is true on this bar.
                  </div>
                )}

                {s.near.length > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>
                    One condition away:{' '}
                    {s.near.slice(0, 3).map(r => `${r.text} (needs ${r.missing.join(', ')})`).join(' · ')}
                  </div>
                )}
              </div>
            );
          })}
          {anyFiring && (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 10, lineHeight: 1.5 }}>
              A firing rule is a reason to look, not an order. It was measured on hourly
              bars with a fixed stop and a fixed target and it says nothing about what is
              in the news — read the instrument card for that.
            </div>
          )}
        </div>
      )}

      {/* ── The rules ──────────────────────────────────────────────────────── */}
      {study && open === 'rules' && (
        <div>
          {!live1.length && (
            <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 10, lineHeight: 1.6 }}>
              Nothing survived the holdout this week. {study.method?.searched} combinations
              were searched and the best {study.method?.carried} were carried forward; on the
              fortnights the search never saw, their edge went to nothing. That is the
              result — the alternative was to show you the discovery numbers, which is
              what a backtest that has never been checked looks like.
              <div style={{ marginTop: 8 }}>
                The <b>Why moves run</b> and <b>What changed</b> tabs do not depend on this
                and are still worth reading.
              </div>
            </div>
          )}
          {live1.map(r => (
            <div key={r.id} style={{ marginTop: 10, paddingTop: 9,
              borderTop: '1px solid var(--border)' }}>
              <Row>
                <span style={{ fontSize: 11, fontWeight: 700,
                  color: r.dir === 'up' ? '#22c55e' : '#ef4444' }}>
                  {r.dir === 'up' ? '▲' : '▼'}
                </span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text1)' }}>{r.label}</span>
                <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3,
                  background: `${C[r.verdict]}22`, color: C[r.verdict] }}>{r.verdict}</span>
                {r.novelty && (
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3,
                    background: `${NOVEL[r.novelty]}22`, color: NOVEL[r.novelty] }}>{r.novelty}</span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)' }}>
                  {r.hold}h hold
                </span>
              </Row>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
                marginTop: 6 }}>
                {[['Unseen half', r.holdout], ['Where it was found', r.discovery],
                  ['Three years before', r.prior]].map(([t, d]) => (
                  <div key={t} style={{ background: 'var(--bg1)', borderRadius: 5, padding: '6px 8px' }}>
                    <div style={{ fontSize: 9, color: 'var(--text3)' }}>{t}</div>
                    {d ? (
                      <>
                        <div style={{ fontSize: 12, fontWeight: 700,
                          color: d.edgeR > 0 ? '#22c55e' : '#ef4444' }}>
                          {d.edgeR > 0 ? '+' : ''}{d.edgeR}R
                        </div>
                        <div style={{ fontSize: 9, color: 'var(--text3)' }}>
                          {d.expR}R vs {d.baseExpR}R · {d.n} trades · t={d.t ?? '—'}
                        </div>
                        <div style={{ fontSize: 9, color: 'var(--text3)' }}>
                          {d.win}% hit target · {d.openPct}% still open at the horizon
                        </div>
                      </>
                    ) : <div style={{ fontSize: 10, color: 'var(--text3)' }}>—</div>}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 5 }}>
                {VERDICT_TEXT[r.verdict]}{r.novelty ? ` · ${NOVELTY_TEXT[r.novelty]}` : ''}
              </div>
            </div>
          ))}
          {live1.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 12, lineHeight: 1.5 }}>
              Every edge is against what a random entry in the same fortnight, same
              direction and same stop would have paid — not against 50%. The strict
              threshold is t ≥ {study.method?.holdoutZ}, which is 5% split
              {' '}{study.method?.carried} ways for the rules carried to the holdout.
            </div>
          )}
        </div>
      )}

      {/* ── Why moves run ──────────────────────────────────────────────────── */}
      {study && open === 'why' && (
        <div>
          <Head note={'Every pivot in the last year, split by what happened next. Both groups '
            + 'are turns, so what is left is the difference between the one that ran and the '
            + 'one that cost money. Nothing here is tradeable on its own — a pivot is only '
            + 'known hours after it happens.'}>
            Why one turn runs and another dies
          </Head>
          {METALS.map(m => {
            const a = study.anatomy?.[m.sym];
            if (!a?.ranVsDied?.length) return null;
            return (
              <div key={m.sym} style={{ marginTop: 10 }}>
                <Row>
                  <span style={{ fontSize: 11, fontWeight: 700, color: m.color }}>{m.label}</span>
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>
                    {a.turns?.n} ran {'≥'}3 ATR · {a.fizzles?.n} went nowhere ·
                    median run in {a.turns?.inAtr} ATR over {a.turns?.inBars}h
                  </span>
                </Row>
                {a.ranVsDied.slice(0, 8).map(r => (
                  <Row key={r.key} style={{ marginTop: 4 }}>
                    <span style={{ fontSize: 10, color: 'var(--text2)', width: 190, flexShrink: 0 }}>
                      {PHRASE[r.key] || r.key}
                    </span>
                    <RatioBar ratio={r.ratio} />
                    <span style={{ fontSize: 10, width: 132, flexShrink: 0, textAlign: 'right',
                      color: r.ratio >= 1 ? '#22c55e' : '#ef4444' }}>
                      {r.atRan}% vs {r.atDied}% ({r.nRan}/{r.nDied})
                    </span>
                  </Row>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* ── What changed ───────────────────────────────────────────────────── */}
      {study && open === 'changed' && (
        <div>
          <Head note={'How often each state simply occurs, this last year against the three '
            + 'before it. Not a trade — a description of what kind of market this is now, '
            + 'which is the part of "how does it behave these days" that no win rate answers.'}>
            What kind of market this has become
          </Head>
          {METALS.map(m => {
            const d = study.drift?.[m.sym];
            if (!d?.length) return null;
            return (
              <div key={m.sym} style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: m.color }}>{m.label}</div>
                {d.slice(0, 8).map(r => (
                  <Row key={r.key} style={{ marginTop: 4 }}>
                    <span style={{ fontSize: 10, color: 'var(--text2)', width: 190, flexShrink: 0 }}>
                      {PHRASE[r.key] || r.key}
                    </span>
                    <RatioBar ratio={r.ratio ?? 1} />
                    <span style={{ fontSize: 10, width: 132, flexShrink: 0, textAlign: 'right',
                      color: r.changePct >= 0 ? '#22c55e' : '#ef4444' }}>
                      {r.nowPct}% now vs {r.thenPct}% before
                    </span>
                  </Row>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Rejected ───────────────────────────────────────────────────────── */}
      {study && open === 'dead' && (
        <div>
          <Head note={'Published so the list is honest about what was tried. Every one of '
            + 'these looked good on the half of history it was found in.'}>
            Carried to the holdout and rejected
          </Head>
          {dead.map(r => (
            <Row key={r.id} style={{ marginTop: 5 }}>
              <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, flexShrink: 0,
                background: `${C[r.verdict]}22`, color: C[r.verdict] }}>{r.verdict}</span>
              <span style={{ fontSize: 10, color: 'var(--text2)' }}>
                {r.dir === 'up' ? '▲' : '▼'} {r.label}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}>
                found {r.discovery?.edgeR > 0 ? '+' : ''}{r.discovery?.edgeR}R →
                {' '}{r.holdout?.edgeR > 0 ? '+' : ''}{r.holdout?.edgeR ?? '—'}R unseen
              </span>
            </Row>
          ))}

          {/* Never tested at all, which is a different answer from "it failed".
              A condition that fired thirty times in a year cannot be measured on
              a year, and without this line its absence from the list above reads
              as rejection. That distinction matters most for the rarest and most
              wanted conditions — a strong hammer is exactly the shape of thing
              that fires a few dozen times and gets quietly dropped. */}
          {!!study.untested?.length && (
            <>
              <Head note={'Not tested. These fired too rarely to measure on a year of '
                + 'hourly bars, or were true on so many bars that they describe the market '
                + 'rather than a condition in it. Neither is a verdict — the study has no '
                + 'opinion on these.'}>
                Not enough to measure ({study.untested.length})
              </Head>
              {study.untested.slice(0, 14).map(u => (
                <Row key={u.key} style={{ marginTop: 5 }}>
                  <span style={{ fontSize: 10, color: 'var(--text2)' }}>
                    {PHRASE[u.key] || u.key}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}>
                    {u.n} bars ({u.pct}%) — {u.why}
                  </span>
                </Row>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// src/utils/deskAgents.js
//
// A research desk, run as a sequence of language-model agents: four analysts,
// a bull and a bear who argue with each other, a trader who decides, and a risk
// manager who can veto.
//
// This is the structure in the multi-agent trading frameworks going around, and
// it is built here on request, with one thing they do not have and one honest
// warning that has to travel with it.
//
// THE WARNING FIRST. Nothing below predicts anything. A language model reading
// evidence and arguing with itself produces a well-organised opinion, and there
// is no published evidence — none, in any of these frameworks, including the
// ones with thousands of stars — that the opinion beats a coin. Their own
// README says "research purposes, not intended as trading advice". Treat every
// word this produces as a way of reading the evidence faster, never as a signal.
//
// THE THING THEY DO NOT HAVE. Every verdict this desk issues is written to a
// log with a timestamp, a direction and the price at the time. That log is
// scored forward — the same way every setup in this app is scored, against what
// a random entry in the same window would have returned. So after enough calls
// this panel can print its own track record above its own opinion, and if the
// record is bad you will be able to see that it is bad. That is the entire
// difference between this and a diagram.
//
// THE EVIDENCE IS REAL. Every number handed to the agents comes from something
// measured: live OANDA bars, the bot's published feed and its base rates, the
// headline archive, COT positioning, and the macro decomposition. The agents
// are not asked to recall anything about the market — only to read what is in
// front of them. A model asked "what do you think about gold" answers from
// training data that is a year old; a model asked "here are eleven facts, argue
// the bear case" is doing something it is actually good at.

import { cachedGroqDefault } from './groqModels.js';
import { PHRASE } from '../../shared/moveFeatures.mjs';

export const LOG_KEY = 'desk_verdicts_v1';
export const MAX_LOG = 300;

const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

export function aiConfig() {
  const provider = localStorage.getItem('ai_provider') || 'groq';
  let keys = {};
  try { keys = JSON.parse(localStorage.getItem('ai_keys') || '{}'); } catch { /* corrupt is empty */ }
  const defaults = {
    openrouter: 'google/gemini-2.0-flash-exp:free',
    gemini: 'gemini-2.0-flash-exp', claude: 'claude-haiku-4-5',
  };
  const fallback = provider === 'groq' ? cachedGroqDefault() : (defaults[provider] || '');
  return {
    provider,
    key: (keys[provider] || '').trim(),
    model: localStorage.getItem(`ai_model_${provider}`) || fallback,
  };
}

// Reasoning models — qwen, deepseek, the r1 family — emit their scratchpad
// inside <think> tags before the answer. Left in, the market analyst's card
// opens with "Here's a thinking process: 1. Analyze User Input" and the actual
// report is somewhere below the fold. It also breaks JSON parsing, because the
// scratchpad is full of braces.
//
// Groq can strip it server-side, which is better because the tokens never
// arrive; this is the second line of defence for the models and providers that
// cannot. The truncated case matters most: when the output budget runs out
// mid-thought there is an opening tag and no answer at all, and returning the
// scratchpad as if it were the report is worse than returning nothing.
export function stripThinking(t) {
  if (!t) return '';
  let s = t.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
  const close = s.search(/<\/(think|thinking|reasoning)>/i);
  if (close >= 0) s = s.slice(close).replace(/^<\/(think|thinking|reasoning)>/i, '');
  const open = s.search(/<(think|thinking|reasoning)>/i);
  if (open >= 0) s = s.slice(0, open);
  return s.replace(/<\/?(think|thinking|reasoning)>/gi, '').trim();
}

// Groq says how long to wait, in a header on some responses and in the message
// on others. Guessing is what turns one rate limit into four.
export function retryAfterMs(res, body) {
  const h = +(res?.headers?.get?.('retry-after') || 0);
  if (h > 0) return Math.min(h * 1000, 65000);
  const m = /try again in ([\d.]+)\s*(ms|s|m)\b/i.exec(body || '');
  if (m) {
    const v = parseFloat(m[1]);
    const ms = (m[2] === 'ms' ? v : m[2] === 'm' ? v * 60000 : v * 1000) + 500;
    // Capped after the padding, not before, or the cap is not a cap.
    return Math.min(ms, 65000);
  }
  return 12000;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One call, with the two things a free tier makes mandatory: it waits out a
// rate limit rather than failing the whole desk on the fifth of ten calls, and
// it says what happened in English when it finally gives up.
async function ask(cfg, system, user, { maxTokens = 900, temperature = 0.4, onWait = null } = {}) {
  const url = ENDPOINTS[cfg.provider];
  if (!url) throw new Error(`the desk runs on Groq or OpenRouter; ${cfg.provider} is not wired up`);
  let hideReasoning = cfg.provider === 'groq';

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model, temperature, max_tokens: maxTokens,
        // Strips the scratchpad server-side, so it never spends output budget.
        ...(hideReasoning ? { reasoning_format: 'hidden' } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });

    if (res.ok) {
      const j = await res.json();
      return stripThinking(j.choices?.[0]?.message?.content || '');
    }

    const body = await res.text().catch(() => '');

    // A model that does not know the flag rejects the whole request. Drop it
    // and try once more rather than telling the user their model is broken.
    if (res.status === 400 && hideReasoning && /reasoning/i.test(body)) {
      hideReasoning = false;
      continue;
    }

    if (res.status === 429) {
      if (attempt === 3) {
        throw new Error('rate limit — the free tier allows about 8,000 tokens a minute and a '
          + 'full desk run needs more. Wait a minute, or choose "1 exchange", or pick a '
          + 'smaller model in the AI tab.');
      }
      const wait = retryAfterMs(res, body);
      onWait?.(Math.ceil(wait / 1000));
      await sleep(wait);
      continue;
    }

    throw new Error(`${res.status} ${body.slice(0, 160)}`);
  }
  throw new Error('gave up after four attempts');
}

// Models wrap JSON in prose, in fences, or in an apology. Take the object.
export function parseJSON(raw) {
  const text = stripThinking(raw);
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

// ── The evidence pack ───────────────────────────────────────────────────────
//
// Assembled from what the platform already measures. Written as plain lines
// rather than JSON because every one of these has to be readable by a person
// checking whether the agents were given the truth.

const n = (v, d = 2) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toFixed(d));

export function marketBrief(ev) {
  const L = [];
  const { price, atr, state, tf } = ev;
  L.push(`Price ${n(price, ev.dec ?? 2)}, hourly ATR ${n(atr, ev.dec ?? 2)}.`);
  if (state?.plain?.length) L.push(`Right now: ${state.plain.join('; ')}.`);
  for (const [k, t] of Object.entries(tf || {})) {
    if (!t) continue;
    L.push(`${k}: trend ${t.trend || '—'}, ${t.chgPct >= 0 ? '+' : ''}${n(t.chgPct)}% over the last ${t.bars} bars, `
      + `${n(t.fromHigh)}% below the period high and ${n(t.fromLow)}% above the low.`);
  }
  if (ev.levels?.length) {
    L.push(`Levels that matter: ${ev.levels.map(l => `${l.label} ${n(l.price, ev.dec ?? 2)}`).join(', ')}.`);
  }
  if (ev.rules?.length) {
    L.push(`Measured setups currently true on this bar: `
      + ev.rules.map(r => `${r.label} (${r.dir}, ${r.holdout?.edgeR > 0 ? '+' : ''}${r.holdout?.edgeR}R over ${r.holdout?.n} trades on data it was not fitted on)`).join('; ') + '.');
  } else {
    L.push('No measured setup is currently true on this bar.');
  }
  return L.join('\n');
}

export function newsBrief(ev) {
  if (!ev.news?.length) return 'No tagged headlines in the archive for this instrument in the window.';
  return ev.news.slice(0, 7).map(h => {
    const age = Math.round((Date.now() - (h.at || Date.now())) / 3600e3);
    // "About this instrument" and "about a currency that prices it" are not the
    // same weight of evidence, and an analyst cannot tell them apart otherwise.
    return `- [${age}h ago, ${h.severity}, ${h.direct ? 'directly about it' : 'about a currency that prices it'}]`
      + ` ${h.title}${h.dir ? ` (labelled ${h.dir})` : ''}`;
  }).join('\n');
}

export function calendarBrief(ev) {
  if (!ev.events?.length) return 'Nothing scheduled in the next 48 hours that is tagged to this instrument.';
  return ev.events.slice(0, 5).map(e => {
    const h = Math.round(((e.at || 0) - Date.now()) / 3600e3);
    return `- in ${h}h: ${e.country || ''} ${e.title}${e.forecast ? ` (forecast ${e.forecast}, previous ${e.previous ?? '—'})` : ''}${e.impact ? ` [${e.impact}]` : ''}`;
  }).join('\n');
}

export function positioningBrief(ev) {
  const L = [];
  if (ev.cot) {
    L.push(`Large speculators sit at the ${ev.cot.pct}th percentile of their positioning`
      + `${ev.cot.weeks ? ` over ${ev.cot.weeks} weeks` : ''} — `
      + `${ev.cot.pct >= 80 ? 'crowded long' : ev.cot.pct <= 20 ? 'crowded short' : 'nowhere near an extreme'}. `
      + `The report is taken on Tuesday and published on Friday, so it is days old by construction.`);
    L.push('MEASURED CAVEAT: positioning extremes were tested on this platform across thirteen instruments '
      + 'and three horizons, counting each stretched run once rather than once a week. The largest effect '
      + 'was z=0.82 against a significance bar of 3.08. Crowded positioning did NOT precede anything. '
      + 'Describe the crowd; do not claim it predicts a reversal.');
  } else L.push('No positioning data for this instrument.');
  if (ev.partner) L.push(`The other metal: ${ev.partner}.`);
  return L.join('\n');
}

export function macroBrief(ev) {
  if (!ev.driver) return 'The macro decomposition is unavailable for this instrument.';
  const d = ev.driver;
  return [
    d.text + '.',
    `Numbers: R² ${n(d.r2, 3)} over ${d.n} hourly bars; dollar beta ${n(d.b1)} ±${n(d.se1)}`
    + ` (${d.dollarSig ? 'significant' : 'NOT significant'}); yield beta ${n(d.b2)} ±${n(d.se2)}`
    + ` (${d.rateSig ? 'significant' : 'NOT significant'}); residual push ${d.push == null ? '—' : `${d.push}σ`} over 12 hours.`,
    d.shift?.dollar != null && Math.abs(d.shift.dollar) >= 2.5
      ? `The dollar relationship has CHANGED since ten days ago (z=${d.shift.dollar}). Intermarket reads based on the usual relationship are describing something that has stopped operating.`
      : 'The dollar relationship is stable against ten days ago.',
  ].join('\n');
}

// ── The agents ──────────────────────────────────────────────────────────────

const HOUSE = `You work on a small trading desk covering gold, silver and FX.

Rules you do not break:
- You are given evidence. Use ONLY the evidence given. You have no memory of
  recent markets and your training data is stale; anything you "recall" about
  price levels, news or policy is wrong and must not appear.
- Cite the number. Every claim must point at a figure in the evidence. A
  sentence with no number in it is padding and will be cut.
- Say what would change your mind, and say what you cannot see.
- No hedging phrases used to avoid committing. Take a position, attach the
  uncertainty to it honestly.
- Never invent a price level, a headline, an economic release or a statistic.`;

const ANALYSTS = [
  {
    id: 'market', label: 'Market analyst', icon: '📈',
    brief: marketBrief,
    task: `Read the price structure. Where is this instrument in its range, what has it
been doing, and what would have to happen for that to change? If a measured setup is
listed, say plainly what its edge is and how thin the sample is. If none is listed, say
so — the absence of a measured setup is information.
Six sentences maximum.`,
  },
  {
    id: 'news', label: 'News analyst', icon: '📰',
    brief: newsBrief,
    task: `Read the headlines. What is the market being told about this instrument, and
does the flow point one way? Distinguish a headline that MOVES an instrument from one
that merely MENTIONS it. If the archive is thin or stale, say that rather than
manufacturing a narrative from three items.
Five sentences maximum.`,
  },
  {
    id: 'macro', label: 'Macro analyst', icon: '🏛',
    brief: ev => `${macroBrief(ev)}\n\nScheduled:\n${calendarBrief(ev)}`,
    task: `This is a decomposition, not a correlation: the instrument's move split into the
part the dollar and the ten-year forced and the part they did not. Say what is actually
driving it right now — macro, or its own flow — and what the scheduled events could do to
that. If R² is low, the usual intermarket read is not operating and you should say so.
Six sentences maximum.`,
  },
  {
    id: 'positioning', label: 'Positioning analyst', icon: '🐘',
    brief: positioningBrief,
    task: `Read the positioning. Who is on which side and how stretched is it? You must
respect the measured caveat in the evidence: on this platform, positioning extremes were
tested and did NOT precede anything. So describe the crowd, and do not claim it predicts a
reversal. If there is no data, say there is none.
Four sentences maximum.`,
  },
];

export async function runAnalyst(cfg, a, ev, onWait) {
  const text = await ask(cfg, HOUSE,
    `INSTRUMENT: ${ev.name} (${ev.sym})\n\nEVIDENCE:\n${a.brief(ev)}\n\nYOUR TASK:\n${a.task}`,
    { maxTokens: 420, temperature: 0.3, onWait });
  return { id: a.id, label: a.label, icon: a.icon, text, evidence: a.brief(ev) };
}

const SIDE_RULES = `You will be scored on whether your argument survives contact with the
other side, not on whether you sound confident. Attack the evidence, not the person.
If the evidence genuinely does not support your side, say the strongest version of your
case and then state plainly that it is weak — a bull who admits the bull case is thin is
worth more than one who fabricates.`;

export async function runSide(cfg, side, reports, ev, rebuttal = null, onWait = null) {
  const other = side === 'bull' ? 'bear' : 'bull';
  const body = [
    `INSTRUMENT: ${ev.name} (${ev.sym}) at ${n(ev.price, ev.dec ?? 2)}`,
    '',
    'THE DESK\'S FOUR REPORTS:',
    ...reports.map(r => `\n[${r.label}]\n${r.text}`),
    rebuttal ? `\n\nTHE ${other.toUpperCase()} CASE, WHICH YOU MUST ANSWER:\n${rebuttal}` : '',
    '',
    rebuttal
      ? `Answer the ${other} case point by point, then restate your own in three sentences.
Concede anything they got right — a rebuttal that concedes nothing is not a rebuttal.`
      : `Make the strongest ${side === 'bull' ? 'LONG' : 'SHORT'} case from these reports.
Four to six sentences. Every one must cite a figure from the reports.`,
  ].join('\n');
  return ask(cfg, `${HOUSE}\n\nYou are the ${side.toUpperCase()} researcher. ${SIDE_RULES}`,
    body, { maxTokens: 460, temperature: 0.5, onWait });
}

const TRADER = `${HOUSE}

You are the trader. The researchers argue; you take the risk. Produce a decision.

Return ONLY a JSON object:
{
  "action": "long" | "short" | "stand aside",
  "conviction": 1-5,
  "horizon_hours": number,
  "entry": number | null,
  "stop": number,
  "target": number,
  "why": "two sentences, each citing a figure",
  "invalidated_by": "the one observation that would mean you were wrong",
  "strongest_opposing_point": "the best point from the side you did not take"
}

"stand aside" is a real answer and is correct more often than not. A desk that
takes a position every day is not a desk. Stop and target must sit on the
correct sides of entry for the direction chosen.`;

export async function runTrader(cfg, reports, bull, bear, ev, onWait = null) {
  const text = await ask(cfg, TRADER, [
    `INSTRUMENT: ${ev.name} (${ev.sym}) at ${n(ev.price, ev.dec ?? 2)}, hourly ATR ${n(ev.atr, ev.dec ?? 2)}`,
    '',
    'REPORTS:', ...reports.map(r => `\n[${r.label}]\n${r.text}`),
    `\n\nBULL CASE:\n${bull}`,
    `\n\nBEAR CASE:\n${bear}`,
  ].join('\n'), { maxTokens: 520, temperature: 0.2, onWait });
  return { raw: text, decision: parseJSON(text) };
}

const RISK = `${HOUSE}

You are the risk manager and you have a veto. You are not here to agree.

Check, in this order:
1. Do the levels make sense? Stop and target on the correct sides, reward at
   least 1.2 times risk, stop not inside normal hourly noise (roughly one ATR).
2. Event risk: is there a scheduled release inside the holding period?
3. Cost: the spread against the stop distance. Above a tenth of the stop the
   trade is not worth taking however good it looks.
4. Is the conviction supported by the evidence, or by the confidence of the
   writing?

Return ONLY JSON:
{
  "verdict": "approve" | "approve with changes" | "veto",
  "changes": "what to change, or null",
  "reason": "one or two sentences",
  "biggest_risk": "the thing most likely to make this lose"
}`;

export async function runRisk(cfg, decision, ev, onWait = null) {
  const text = await ask(cfg, RISK, [
    `INSTRUMENT: ${ev.name} (${ev.sym}) at ${n(ev.price, ev.dec ?? 2)}, hourly ATR ${n(ev.atr, ev.dec ?? 2)}`,
    ev.spread ? `Current spread ${n(ev.spread, ev.dec ?? 2)}.` : 'Spread unknown — say so if it matters.',
    '',
    'THE PROPOSED TRADE:', JSON.stringify(decision, null, 1),
    '',
    'SCHEDULED IN THE NEXT 48 HOURS:', calendarBrief(ev),
  ].join('\n'), { maxTokens: 340, temperature: 0.2, onWait });
  return { raw: text, review: parseJSON(text) };
}

// Levels a model invented rather than derived. Checked here rather than trusted,
// because a target on the wrong side of entry reads perfectly well in prose.
export function checkLevels(d, price) {
  if (!d || d.action === 'stand aside') return null;
  const entry = Number.isFinite(+d.entry) ? +d.entry : price;
  const stop = +d.stop, target = +d.target;
  if (!Number.isFinite(stop) || !Number.isFinite(target)) return 'no usable stop or target';
  const long = d.action === 'long';
  const risk = Math.abs(entry - stop), reward = Math.abs(target - entry);
  // Checked before the sides, so a stop written at the entry price is reported
  // as what it is rather than as a direction error — the two are fixed
  // differently and the message is the only thing telling anyone which.
  if (!(risk > 0)) return 'the stop is at the entry';
  if (long && !(stop < entry && target > entry)) return 'stop and target are on the wrong sides for a long';
  if (!long && !(stop > entry && target < entry)) return 'stop and target are on the wrong sides for a short';
  if (reward / risk < 1.2) return `reward is only ${(reward / risk).toFixed(2)}x risk`;
  if (Math.abs(entry - price) / price > 0.02) return 'the entry is more than 2% away from the current price';
  return null;
}

// ── The run ─────────────────────────────────────────────────────────────────
//
// `onStage` is called as each stage lands so the panel fills in progressively —
// four analysts, then the argument, then the decision. A desk that shows nothing
// for ninety seconds and then everything at once is worse to read and harder to
// interrupt.
export async function runDesk(ev, { onStage = () => {}, rounds = 0 } = {}) {
  const onWait = secs => onStage({ stage: 'wait', secs });
  const cfg = aiConfig();
  if (!cfg.key) throw new Error('no AI key — add one in the AI tab');
  if (!cfg.model) throw new Error('no model selected — open the AI tab once so it can fetch the list');

  const reports = [];
  for (const a of ANALYSTS) {
    const r = await runAnalyst(cfg, a, ev, onWait);
    reports.push(r);
    onStage({ stage: 'analyst', report: r });
  }

  let bull = await runSide(cfg, 'bull', reports, ev, null, onWait);
  onStage({ stage: 'bull', text: bull, round: 0 });
  let bear = await runSide(cfg, 'bear', reports, ev, bull, onWait);
  onStage({ stage: 'bear', text: bear, round: 0 });

  const debate = [{ bull, bear }];
  for (let r = 1; r <= rounds; r++) {
    bull = await runSide(cfg, 'bull', reports, ev, bear, onWait);
    onStage({ stage: 'bull', text: bull, round: r });
    bear = await runSide(cfg, 'bear', reports, ev, bull, onWait);
    onStage({ stage: 'bear', text: bear, round: r });
    debate.push({ bull, bear });
  }

  const t = await runTrader(cfg, reports, bull, bear, ev, onWait);
  const levelIssue = checkLevels(t.decision, ev.price);
  onStage({ stage: 'trader', ...t, levelIssue });

  const risk = await runRisk(cfg, t.decision, ev, onWait);
  onStage({ stage: 'risk', ...risk });

  const out = {
    at: Date.now(), sym: ev.sym, name: ev.name, price: ev.price, atr: ev.atr,
    model: cfg.model, provider: cfg.provider,
    reports, debate, decision: t.decision, traderRaw: t.raw,
    review: risk.review, riskRaw: risk.raw, levelIssue,
  };
  logVerdict(out);
  return out;
}

// ── The log ─────────────────────────────────────────────────────────────────
//
// Every verdict, with the price at the time. This is the part the frameworks do
// not have: it makes the desk's own record checkable later against what price
// actually did, so the panel can print how it has been doing above what it
// currently thinks.
export function logVerdict(v) {
  if (!v?.decision) return;
  const rows = readLog();
  rows.unshift({
    at: v.at, sym: v.sym, price: v.price, atr: v.atr,
    action: v.decision.action, conviction: v.decision.conviction,
    horizon: v.decision.horizon_hours, stop: v.decision.stop, target: v.decision.target,
    verdict: v.review?.verdict || null, model: v.model,
  });
  try { localStorage.setItem(LOG_KEY, JSON.stringify(rows.slice(0, MAX_LOG))); } catch { /* full is not fatal */ }
}

export function readLog() {
  try {
    const r = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    return Array.isArray(r) ? r : [];
  } catch { return []; }
}

// Score the log against what price did afterwards.
//
// The same standard everything else in this app is held to: against what the
// instrument did anyway over the same window, not against zero. A desk that
// says "long" every day in a rising market is right most of the time and has
// told you nothing.
export function scoreLog(rows, priceAt) {
  const scored = [];
  for (const r of rows) {
    if (r.action !== 'long' && r.action !== 'short') continue;
    const then = priceAt(r.sym, r.at + (r.horizon || 24) * 3600e3);
    if (then == null || !(r.price > 0) || !(r.atr > 0)) continue;
    const move = (then - r.price) / r.atr;
    scored.push({ ...r, atr: r.atr, moveAtr: r.action === 'long' ? move : -move });
  }
  if (!scored.length) return null;
  const wins = scored.filter(s => s.moveAtr > 0).length;
  const mean = scored.reduce((a, s) => a + s.moveAtr, 0) / scored.length;
  return {
    n: scored.length,
    win: Math.round((wins / scored.length) * 100),
    meanAtr: +mean.toFixed(3),
    // Filled in by the caller, which has the market's own move over the same
    // windows. Without it the win rate is meaningless.
    rows: scored,
  };
}

export const PHRASE_MAP = PHRASE;

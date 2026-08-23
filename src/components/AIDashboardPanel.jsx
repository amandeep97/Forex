import { useState, useRef } from 'react';
import { cachedGroqDefault } from '../utils/groqModels.js';

function getAIConfig() {
  const provider = localStorage.getItem('ai_provider') || 'groq';
  const keys = (() => { try { return JSON.parse(localStorage.getItem('ai_keys') || '{}'); } catch { return {}; } })();
  const defaults = { openrouter:'google/gemini-2.0-flash-exp:free', gemini:'gemini-2.0-flash-exp', claude:'claude-haiku-4-5' };
  // Groq's default comes from the list the AI tab fetched from Groq, so this
  // panel cannot drift onto a retired id while the tab beside it is current.
  const fallback = provider === 'groq' ? cachedGroqDefault() : (defaults[provider] || '');
  const model = localStorage.getItem(`ai_model_${provider}`) || fallback;
  return { provider, key: keys[provider]?.trim() || '', model };
}

const PROVIDER_META = {
  groq:       { label:'Groq ⚡',       color:'#f97316' },
  openrouter: { label:'OpenRouter 🔀', color:'#6366f1' },
  gemini:     { label:'Gemini ✦',      color:'#4285f4' },
  claude:     { label:'Claude ◈',      color:'#cc785c' },
};

async function* streamOpenAI(url, key, model, messages, extra = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extra },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 1600, temperature: 0.7 }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const ln of lines) {
      if (!ln.startsWith('data: ')) continue;
      const d = ln.slice(6).trim();
      if (d === '[DONE]') return;
      try { const c = JSON.parse(d).choices?.[0]?.delta?.content; if (c) yield c; } catch {}
    }
  }
}

async function* streamGemini(key, model, messages) {
  const sys = messages.find(m => m.role === 'system');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, ...(sys ? { system_instruction: { parts: [{ text: sys.content }] } } : {}), generationConfig: { maxOutputTokens: 1600, temperature: 0.7 } }) }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const ln of lines) {
      if (!ln.startsWith('data: ')) continue;
      try { const t = JSON.parse(ln.slice(6)).candidates?.[0]?.content?.parts?.[0]?.text; if (t) yield t; } catch {}
    }
  }
}

async function* streamClaude(key, model, messages) {
  const sys = messages.find(m => m.role === 'system');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({
      model, max_tokens: 1600, stream: true,
      system: sys?.content || 'You are a professional trading analyst.',
      messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const ln of lines) {
      if (!ln.startsWith('data: ')) continue;
      try {
        const j = JSON.parse(ln.slice(6));
        if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') yield j.delta.text;
      } catch {}
    }
  }
}

// ── Minimal markdown renderer ─────────────────────────────────────────────────
function MsgText({ text }) {
  return (
    <div style={{ fontSize: 11, lineHeight: 1.75, color: 'var(--text)' }}>
      {text.split('\n').map((line, i) => {
        if (!line.trim()) return <div key={i} style={{ height: 4 }} />;
        if (line.startsWith('### ')) return <div key={i} style={{ fontWeight: 700, color: '#00d4aa', fontSize: 11, marginTop: 8 }}>{line.slice(4)}</div>;
        if (line.startsWith('## '))  return <div key={i} style={{ fontWeight: 800, color: 'var(--text)', fontSize: 12, marginTop: 8 }}>{line.slice(3)}</div>;
        if (line.startsWith('# '))   return <div key={i} style={{ fontWeight: 800, color: 'var(--text)', fontSize: 13, marginTop: 8 }}>{line.slice(2)}</div>;
        const isBullet = /^[-•*]\s/.test(line);
        const content = isBullet ? line.replace(/^[-•*]\s/, '') : line;
        const parts = content.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((p, j) => {
          if (p.startsWith('**') && p.endsWith('**')) return <strong key={j}>{p.slice(2, -2)}</strong>;
          if (p.startsWith('`') && p.endsWith('`'))   return <code key={j} style={{ background: '#1e293b', padding: '1px 4px', borderRadius: 3, fontSize: 10, fontFamily: 'monospace' }}>{p.slice(1, -1)}</code>;
          return p;
        });
        return (
          <div key={i} style={{ display: 'flex', gap: isBullet ? 6 : 0, marginBottom: isBullet ? 3 : 0 }}>
            {isBullet && <span style={{ color: '#00d4aa', flexShrink: 0, marginTop: 1 }}>•</span>}
            <span>{parts}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function AIDashboardPanel({ context, quickPrompts = [] }) {
  const [open, setOpen]       = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [response, setResponse]   = useState('');
  const [error, setError]         = useState('');
  const [customQ, setCustomQ]     = useState('');
  const abortRef = useRef(false);

  const { provider, key, model } = getAIConfig();
  const hasKey = !!key;
  const pm = PROVIDER_META[provider] || { label: provider, color: '#00d4aa' };

  const SYS = `You are ForexPro AI — an expert forex and metals/indices trading analyst embedded in a professional trading platform.

Always reference actual numbers from the dashboard data. Be concise and direct. Use bullet points. Format trade setups clearly with Entry, SL, TP, and R:R. Flag any conflicting signals. Maximum 2 trade setups per response. If signals are mixed, say "wait for alignment" rather than forcing a trade.`;

  const run = async (question) => {
    if (streaming || !hasKey) return;
    abortRef.current = false;
    setStreaming(true);
    setResponse('');
    setError('');

    const userMsg = question || 'Give me a complete professional analysis of all signals above. Identify the best trade setup(s) with specific entry, SL, TP, and R:R. Call out any key risks or conflicting signals.';
    const messages = [
      { role: 'system', content: `${SYS}\n\n${context}` },
      { role: 'user',   content: userMsg },
    ];

    try {
      let gen;
      if (provider === 'groq') {
        gen = streamOpenAI('https://api.groq.com/openai/v1/chat/completions', key, model, messages);
      } else if (provider === 'openrouter') {
        gen = streamOpenAI('https://openrouter.ai/api/v1/chat/completions', key, model, messages, {
          'HTTP-Referer': 'https://amandeep97.github.io/Forex', 'X-Title': 'ForexPro AI',
        });
      } else if (provider === 'gemini') {
        gen = streamGemini(key, model, messages);
      } else {
        gen = streamClaude(key, model, messages);
      }
      for await (const chunk of gen) {
        if (abortRef.current) break;
        setResponse(prev => prev + chunk);
      }
    } catch (e) {
      setError(e.message || 'AI request failed');
    } finally {
      setStreaming(false);
    }
  };

  const defaultQuickPrompts = [
    'What are the biggest risks right now?',
    'Any conflicting signals I should watch?',
    'Best entry timing for today?',
  ];
  const allQuickPrompts = quickPrompts.length ? quickPrompts : defaultQuickPrompts;

  return (
    <div style={{ background: 'var(--card)', border: `1px solid ${open ? pm.color + '44' : 'var(--border)'}`, borderRadius: 8, marginBottom: 12, overflow: 'hidden', transition: 'border-color 0.2s' }}>
      {/* Header toggle */}
      <button
        onClick={() => { setOpen(o => !o); if (!open && !response && hasKey) run(); }}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ fontSize: 16 }}>🤖</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', flex: 1 }}>AI Analysis</span>
        {hasKey ? (
          <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 10, background: pm.color + '22', color: pm.color, border: `1px solid ${pm.color}44`, fontWeight: 700 }}>
            {pm.label}
          </span>
        ) : (
          <span style={{ fontSize: 9, color: '#f59e0b', fontWeight: 600 }}>⚠ No AI key</span>
        )}
        <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 4 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 14px 12px', borderTop: `1px solid ${pm.color}33` }}>
          {!hasKey ? (
            <div style={{ padding: '12px 0', fontSize: 11, color: '#f59e0b', lineHeight: 1.6 }}>
              No AI key found. Go to the <strong style={{ color: '#f59e0b' }}>AI Analysis tab</strong> → Settings → add a Groq/OpenRouter/Gemini/Claude key first.
              <div style={{ fontSize: 10, marginTop: 4, color: 'var(--text3)' }}>Groq is free — get a key at console.groq.com</div>
            </div>
          ) : (
            <>
              {/* Response */}
              <div style={{ minHeight: 48, paddingTop: 10, paddingBottom: 6 }}>
                {streaming && !response && (
                  <div style={{ color: 'var(--text3)', fontSize: 11, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, display: 'inline-block', animation: 'spin 0.8s linear infinite' }}>⟳</span>
                    Analyzing all signals…
                  </div>
                )}
                {response && <MsgText text={response} />}
                {streaming && response && (
                  <span style={{ display: 'inline-block', width: 7, height: 13, background: 'var(--text)', marginLeft: 2,
                    animation: 'blink 1s step-start infinite', verticalAlign: 'text-bottom' }} />
                )}
                {error && (
                  <div style={{ color: '#ef4444', fontSize: 11, padding: '6px 8px', background: '#ef444412', borderRadius: 4, border: '1px solid #ef444433' }}>
                    {error}
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
                <button onClick={() => run()}
                  disabled={streaming}
                  style={{ padding: '4px 12px', borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                    background: '#00d4aa22', color: '#00d4aa', border: '1px solid #00d4aa55',
                    opacity: streaming ? 0.5 : 1 }}>
                  {response ? '↺ Re-analyze' : '▶ Analyze'}
                </button>
                {streaming && (
                  <button onClick={() => { abortRef.current = true; setStreaming(false); }}
                    style={{ padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                      background: '#ef444422', color: '#ef4444', border: '1px solid #ef444444' }}>
                    ■ Stop
                  </button>
                )}
                {allQuickPrompts.map(q => (
                  <button key={q} onClick={() => run(q)}
                    disabled={streaming}
                    style={{ padding: '3px 8px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
                      background: 'var(--bg2)', color: 'var(--text3)', border: '1px solid var(--border)',
                      opacity: streaming ? 0.5 : 1 }}>
                    {q}
                  </button>
                ))}
              </div>

              {/* Custom question */}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input
                  value={customQ}
                  onChange={e => setCustomQ(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && customQ.trim()) { run(customQ); setCustomQ(''); } }}
                  placeholder="Ask anything about these signals…"
                  style={{ flex: 1, padding: '4px 8px', borderRadius: 4, fontSize: 11,
                    background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', outline: 'none' }}
                />
                <button onClick={() => { if (customQ.trim()) { run(customQ); setCustomQ(''); } }}
                  disabled={streaming || !customQ.trim()}
                  style={{ padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                    background: pm.color + '22', color: pm.color, border: `1px solid ${pm.color}44`,
                    opacity: (streaming || !customQ.trim()) ? 0.5 : 1 }}>
                  Ask
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

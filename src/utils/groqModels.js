// src/utils/groqModels.js
//
// The Groq model list used to be four ids typed into a component. Groq retires
// ids on a schedule, so that list goes stale silently: the dropdown keeps
// offering a model that no longer exists and the request comes back 404 with
// nothing on screen explaining why. Upgrading it by hand means somebody has to
// notice, and nobody notices until it breaks.
//
// So the app asks Groq instead. The key is already stored — Settings calls this
// exact endpoint to validate it — and the answer carries everything needed to
// build the list and to pick a sensible default without anybody hardcoding a
// name that will expire.

const ENDPOINT = 'https://api.groq.com/openai/v1/models';
const CACHE_KEY = 'ai_models_groq';
const TTL_MS = 24 * 3600e3;

// Groq serves speech, moderation and embedding models from the same list. They
// are not chat completions endpoints, and offering one silently produces a 400.
const NOT_CHAT = /whisper|^distil|tts|guard|embed|moderation|^playai/i;

// Speed variants. Real models, and not what you want defaulted for analysis —
// the whole reason to be on Groq is that the large ones are already fast.
const SPEED_TIER = /instant|mini|nano|\b[1-9]b\b|\b[1-9]-?b-/i;

const isChat = m => !NOT_CHAT.test(m.id || '') && m.active !== false;

// Newest full-size model first. `created` is Groq's own timestamp, so "newest"
// is read off the data rather than guessed from a name — which is the point,
// since the names of models that do not exist yet cannot be guessed at all.
function rank(a, b) {
  const tier = m => (SPEED_TIER.test(m.id) ? 0 : 1);
  return (tier(b) - tier(a)) || ((b.created || 0) - (a.created || 0));
}

// llama-3.3-70b-versatile -> Llama 3.3 70B Versatile
export function prettyModel(id) {
  const tail = String(id).split('/').pop();
  return tail
    .replace(/[-_]/g, ' ')
    .replace(/\b(\d+)b\b/gi, (_, n) => `${n}B`)
    .replace(/\b[a-z]/g, c => c.toUpperCase())
    .replace(/\bAi\b/g, 'AI')
    .trim();
}

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c && Array.isArray(c.models) && c.models.length) return c;
  } catch { /* a corrupt cache is the same as no cache */ }
  return null;
}

// What the dropdown should default to, without a network call. Used by panels
// that render before any fetch has run.
export function cachedGroqModels() {
  return readCache()?.models || null;
}

export function cachedGroqDefault(fallback = 'llama-3.3-70b-versatile') {
  return readCache()?.models?.[0]?.id || fallback;
}

// Fetches, ranks and caches. Never throws: a failure returns null and the
// caller keeps whatever list it already had, because a dead network should not
// empty the model picker.
export async function fetchGroqModels(key, { force = false } = {}) {
  if (!key?.trim()) return null;
  const cached = readCache();
  if (!force && cached && Date.now() - (cached.at || 0) < TTL_MS) return cached.models;

  try {
    const r = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: AbortSignal.timeout?.(12000),
    });
    if (!r.ok) return cached?.models || null;
    const body = await r.json();
    const models = (body?.data || [])
      .filter(isChat)
      .sort(rank)
      .map(m => ({
        id: m.id,
        label: prettyModel(m.id),
        // Carried so the picker can say what it is choosing between.
        ctx: m.context_window || null,
      }));
    if (!models.length) return cached?.models || null;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), models })); } catch { /* quota */ }
    return models;
  } catch {
    return cached?.models || null;
  }
}

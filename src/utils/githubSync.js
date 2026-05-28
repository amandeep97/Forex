// GitHub REST API helper — reads/writes JSON files in the repo.
// Credentials stored in localStorage: 'github_pat' (Personal Access Token)
// Set: localStorage.setItem('github_pat', 'ghp_xxx...')

const GITHUB_OWNER  = 'amandeep97';
const GITHUB_REPO   = 'Forex';
const GITHUB_BRANCH = 'main';

function getToken() {
  return localStorage.getItem('github_pat') || '';
}

function headers() {
  return {
    Authorization:  `token ${getToken()}`,
    Accept:         'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

// Returns { content: parsedJSON, sha } or null if not found
// noCache=true bypasses CDN cache so the SHA is always current (used before writes)
export async function ghRead(path, { noCache = false } = {}) {
  // Append a timestamp to bust the 60-second GitHub CDN cache when freshness matters
  const bust = noCache ? `&_=${Date.now()}` : '';
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}${bust}`;
  const res = await fetch(url, {
    headers: headers(),
    cache: noCache ? 'no-store' : 'default',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read ${res.status}: ${path}`);
  const data    = await res.json();
  const text    = atob(data.content.replace(/\n/g, ''));
  return { content: JSON.parse(text), sha: data.sha };
}

// Write / overwrite a JSON file. Returns new sha.
export async function ghWrite(path, content, message, sha = null) {
  const url  = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
    branch:  GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub write ${res.status}: ${err.message || path}`);
  }
  const result = await res.json();
  return result.content.sha;
}

export function isGithubConfigured() {
  return !!getToken();
}

'use strict';
const fetch = require('node-fetch');

class GitHubClient {
  constructor({ token, owner, repo, branch = 'main' }) {
    this.token  = token;
    this.owner  = owner;
    this.repo   = repo;
    this.branch = branch;
  }

  _headers() {
    return {
      Authorization: `token ${this.token}`,
      Accept:        'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  async readJSON(path) {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}?ref=${this.branch}`;
    const res  = await fetch(url, { headers: this._headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read ${res.status}: ${path}`);
    const data    = await res.json();
    const text    = Buffer.from(data.content, 'base64').toString('utf8');
    return { content: JSON.parse(text), sha: data.sha };
  }

  async writeJSON(path, content, message, sha = null) {
    const url     = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;
    const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');

    const attempt = async (currentSha) => {
      const body = { message, content: encoded, branch: this.branch };
      if (currentSha) body.sha = currentSha;
      const res = await fetch(url, {
        method:  'PUT',
        headers: this._headers(),
        body:    JSON.stringify(body),
      });
      if (res.status === 409) {
        // SHA conflict — fetch latest and retry once
        const latest = await this.readJSON(path);
        const freshSha = latest?.sha || null;
        const body2 = { message, content: encoded, branch: this.branch };
        if (freshSha) body2.sha = freshSha;
        const res2 = await fetch(url, {
          method:  'PUT',
          headers: this._headers(),
          body:    JSON.stringify(body2),
        });
        if (!res2.ok) {
          const err = await res2.json().catch(() => ({}));
          throw new Error(`GitHub write ${res2.status}: ${err.message || path}`);
        }
        return (await res2.json()).content.sha;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`GitHub write ${res.status}: ${err.message || path}`);
      }
      return (await res.json()).content.sha;
    };

    return attempt(sha);
  }
}

module.exports = { GitHubClient };

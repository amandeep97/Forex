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
    const url  = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;
    const body = {
      message,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
      branch:  this.branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method:  'PUT',
      headers: this._headers(),
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`GitHub write ${res.status}: ${err.message || path}`);
    }
    const result = await res.json();
    return result.content.sha;
  }
}

module.exports = { GitHubClient };

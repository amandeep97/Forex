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

  // The SHA of a file, at any size.
  //
  // The Contents API refuses to return a blob over 1 MB — it answers 403 with
  // "This API returns blobs up to 1 MB in size". A DIRECTORY listing has no
  // such limit, because it returns each entry's SHA and no content at all.
  //
  // This is not a hypothetical. The live feed grew past 1 MB, and updating a
  // file requires its SHA: the bot held one in memory so writes kept working,
  // and the first restart after crossing the line wiped it. Every write from
  // then on asked for the SHA, got a 403, and failed. The feed stopped
  // publishing for half an hour while news and alerts — both small — carried
  // on normally, which is exactly the shape of failure that looks like
  // anything except a size limit.
  async readSha(path) {
    const slash = path.lastIndexOf('/');
    const dir   = slash > 0 ? path.slice(0, slash) : '';
    const name  = path.slice(slash + 1);
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${dir}?ref=${this.branch}`;
    const res = await fetch(url, { headers: this._headers() });
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list)) return null;
    return list.find(e => e.name === name)?.sha || null;
  }

  async readJSON(path) {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}?ref=${this.branch}`;
    const res  = await fetch(url, { headers: this._headers() });
    if (res.status === 404) return null;
    // Too large for this endpoint. The Git Data blob API serves the same object
    // with no practical size limit, once the SHA is in hand.
    if (res.status === 403) {
      const sha = await this.readSha(path);
      if (!sha) throw new Error(`GitHub read 403 and no SHA: ${path}`);
      const blob = await fetch(
        `https://api.github.com/repos/${this.owner}/${this.repo}/git/blobs/${sha}`,
        { headers: { ...this._headers(), Accept: 'application/vnd.github.raw' } });
      if (!blob.ok) throw new Error(`GitHub blob ${blob.status}: ${path}`);
      return { content: JSON.parse(await blob.text()), sha };
    }
    if (!res.ok) throw new Error(`GitHub read ${res.status}: ${path}`);
    const data    = await res.json();
    const text    = Buffer.from(data.content, 'base64').toString('utf8');
    return { content: JSON.parse(text), sha: data.sha };
  }

  // pretty defaults to true because strategy.json, alerts.json and the control
  // file are read and sometimes hand-edited on GitHub. The live feed is neither:
  // it is machine-written every few minutes and machine-read, and indenting it
  // doubles both the commit and the download for no reader's benefit.
  async writeJSON(path, content, message, sha = null, { pretty = true } = {}) {
    const url     = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;
    const encoded = Buffer.from(pretty ? JSON.stringify(content, null, 2) : JSON.stringify(content)).toString('base64');

    const attempt = async (currentSha) => {   // uses `encoded` above, so a retry keeps the same formatting
      const body = { message, content: encoded, branch: this.branch };
      if (currentSha) body.sha = currentSha;
      const res = await fetch(url, {
        method:  'PUT',
        headers: this._headers(),
        body:    JSON.stringify(body),
      });
      if (res.status === 409 || res.status === 422) {
        // 409 = SHA conflict; 422 = file exists but sha not supplied
        // Either way: fetch current SHA and retry once.
        //
        // The SHA alone, not the whole file. Downloading a megabyte to read
        // forty characters off it was wasteful even when it worked, and it
        // stopped working the moment the file it was recovering exceeded the
        // size the Contents API will return.
        const freshSha = await this.readSha(path);
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

import { Component } from 'react';

// ── TabBoundary ──────────────────────────────────────────────────────────────
//
// Every tab except the first is loaded on demand. When one of those chunk
// requests fails, React's lazy() throws during render, and with nothing to
// catch it the error propagates to the root and unmounts the entire
// application. The result is a completely black screen — no header, no tab bar,
// nothing to press — which looks like the app is broken rather than like one
// tab failed to download.
//
// That is not hypothetical. It happened after a deploy: the browser had an
// older index.html in its HTTP cache, pointing at a chunk filename that no
// longer existed on the CDN, so opening the Terminal tab blanked the whole app.
// The code was fine. The delivery was one file out of date.
//
// So the failure is caught here, and the message says the one thing that
// actually fixes it. Reloading is not a superstition in this case — it fetches
// the current index.html, which names the chunks that do exist.
//
// `resetKey` matters as much as the catch. React keeps an error boundary in its
// failed state until something forces it to re-render, so without a key tied to
// the active tab, one failed chunk would leave every OTHER tab showing the same
// error for the rest of the session.
export default class TabBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { err: null, where: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  // The message alone is not enough to act on. "Illegal constructor" says a Web
  // API was called without `new`, and nothing about WHICH component did it —
  // and an error that only reproduces on one engine cannot be chased without
  // that. React hands the component stack here and nowhere else, so it is kept.
  componentDidCatch(err, info) {
    this.setState({ where: info?.componentStack || null });
    // Also to the console, where a remote-inspected device can see the whole
    // thing rather than the three frames that fit on a phone.
    console.error('[TabBoundary]', err, info?.componentStack);
  }

  componentDidUpdate(prev) {
    // Switching tabs clears the error. The next tab deserves its own attempt.
    if (prev.resetKey !== this.props.resetKey && this.state.err) {
      this.setState({ err: null, where: null });
    }
  }

  // A stale service worker or HTTP cache is the usual cause, so the retry
  // clears both rather than reloading into the same stale files. Best effort:
  // if either call is unavailable the reload still happens.
  async hardReload() {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch { /* the reload is the part that matters */ }
    window.location.reload();
  }

  render() {
    const { err, where } = this.state;
    if (!err) return this.props.children;

    // A chunk that failed to download reads differently from a bug in the tab,
    // and the fix is different too, so they are not given the same message.
    const isChunk = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i
      .test(err.message || '');

    return (
      <div style={{ margin:'14px 10px', padding:'14px', borderRadius:6,
        background:'#0b1118', border:'1px solid #2b1f1f', color:'#cbd5e1',
        fontFamily:'var(--mono, monospace)', fontSize:11, lineHeight:1.7 }}>
        <strong style={{ color:'#f59e0b', fontSize:12 }}>
          {isChunk ? 'This tab could not be downloaded' : 'This tab hit an error'}
        </strong>
        <div style={{ marginTop:6, color:'#475569' }}>
          {isChunk
            ? 'Almost always a cached copy of the app pointing at files from an older deploy. Reloading fetches the current version.'
            : 'The rest of the app is fine — switch tabs, or reload if it keeps happening.'}
        </div>
        <div style={{ marginTop:8, fontSize:9, color:'#334155', wordBreak:'break-word' }}>
          {String(err.message || err)}
        </div>
        {where && (
          <pre style={{ marginTop:6, fontSize:8, color:'#475569', lineHeight:1.5,
            whiteSpace:'pre-wrap', wordBreak:'break-word', maxHeight:150, overflowY:'auto',
            background:'#080c11', border:'1px solid #16202b', borderRadius:4, padding:'6px' }}>
            {where.trim().split('\n').slice(0, 8).join('\n')}
          </pre>
        )}
        <button onClick={() => this.hardReload()}
          style={{ marginTop:10, fontSize:11, fontWeight:700, padding:'6px 12px', borderRadius:4,
            cursor:'pointer', border:'1px solid #00d4aa55', background:'#00d4aa15', color:'#00d4aa',
            fontFamily:'inherit' }}>
          Clear cache and reload
        </button>
      </div>
    );
  }
}

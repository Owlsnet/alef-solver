/* Minimal Chrome DevTools Protocol client. No dependencies — Node 24 has a
 * global WebSocket and fetch built in, which is all this needs.
 *
 * Requires Chrome running with --remote-debugging-port. */

// Read the port at call time, not at require time — the test harness launches
// its own Chrome on a different port and sets CDP_PORT after loading this file.
const port = () => Number(process.env.CDP_PORT) || 9222;
const base = () => `http://127.0.0.1:${port()}`;

async function api(path) {
  const r = await fetch(base() + path);
  if (!r.ok) throw new Error(`CDP GET ${path} -> HTTP ${r.status}`);
  return r.json();
}

/** Browser-level info: proves the debug port is live. */
const version = () => api('/json/version');

/** All debuggable targets (pages, workers, iframes, extensions). */
const targets = () => api('/json/list');

class Session {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timed out connecting to CDP socket')), 8000);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error('failed to open CDP socket')); };
    });
    const s = new Session(ws);
    ws.onmessage = ev => s._recv(ev.data);
    ws.onclose = () => {
      s.closed = true;
      for (const p of s.pending.values()) p.rej(new Error('CDP socket closed'));
      s.pending.clear();
    };
    return s;
  }

  _recv(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.id != null) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.rej(new Error(`${m.error.message} (code ${m.error.code})`));
      else p.res(m.result);
      return;
    }
    if (m.method) {
      for (const h of this.handlers.get(m.method) || []) {
        try { h(m.params); } catch (e) { console.error('[cdp handler]', m.method, e.message); }
      }
    }
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  once(method, timeout = 30000) {
    return new Promise(res => {
      const h = params => {
        const arr = this.handlers.get(method);
        if (arr) arr.splice(arr.indexOf(h), 1);
        res(params);
      };
      this.on(method, h);
      setTimeout(() => {
        const arr = this.handlers.get(method);
        if (arr) { const i = arr.indexOf(h); if (i >= 0) arr.splice(i, 1); }
        res(null); // timed out — caller decides what that means
      }, timeout);
    });
  }

  send(method, params = {}, timeout = 60000) {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'));
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP timeout: ${method} (${timeout}ms)`));
      }, timeout);
      this.pending.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Run JS in the page and get its value back. */
  async eval(expression, { awaitPromise = true, timeout = 60000, contextId } = {}) {
    // `contextId`: an isolated world (Page.createIsolatedWorld) — where an extension's page script
    // really runs. Without it, the page's own world.
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
      ...(contextId ? { contextId } : {}),
    }, timeout);

    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = d.exception?.description || d.exception?.value || d.text || 'page exception';
      throw new Error(`page: ${msg}`);
    }
    return r.result?.value;
  }

  async goto(url, timeout = 45000) {
    const arrived = this.once('Page.loadEventFired', timeout);
    await this.send('Page.navigate', { url });
    await arrived;
    await new Promise(r => setTimeout(r, 400)); // let the SPA settle
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(); } catch { }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.rej(new Error('closed')); }
    this.pending.clear();
    this.handlers.clear();
  }

  /** Full-page screenshot in a single call — captureBeyondViewport beats
   *  scroll-and-stitch, and the extension can't do this at all. */
  async screenshot({ beyondViewport = true, quality = 80 } = {}) {
    const r = await this.send('Page.captureScreenshot', {
      format: 'jpeg', quality, captureBeyondViewport: beyondViewport,
    }, 30000);
    return r.data; // base64, no data: prefix
  }
}

/** Pick the page target most likely to hold the question. */
async function findPage(match = /alefed|alef/i) {
  const list = await targets();
  const pages = list.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
  const hit = pages.find(t => match.test(t.url)) || pages.find(t => match.test(t.title)) || pages[0];
  return hit || null;
}

module.exports = { version, targets, findPage, Session, port, base };

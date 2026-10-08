// Shared by the background script, the popup and the pairing page.
// Plain script, no build: everything hangs off globalThis.HS.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const t = (key, substitutions) => api.i18n.getMessage(key, substitutions) || key;

  /** Fills every element with data-i18n="messageName" in the current language. */
  function localize(root) {
    for (const element of root.querySelectorAll('[data-i18n]')) {
      element.textContent = t(element.dataset.i18n);
    }
    root.documentElement.lang = api.i18n.getUILanguage().startsWith('ru') ? 'ru' : 'en';
  }

  /** "hub.lan:8080/homescribe/" -> "http://hub.lan:8080/homescribe" (a base path is kept). */
  function normalizeServer(input) {
    const raw = input.trim();
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }

  const originPattern = (server) => `${new URL(server).origin}/*`;

  /**
   * Homescribe only serves its local network, so its address is a private IP,
   * localhost or a home name. Anything else gets a warning before pairing: a
   * link to pair.html could come from any web page.
   */
  function looksLocal(server) {
    const host = new URL(server).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || !host.includes('.') || host === '::1') return true;
    if (/\.(lan|local|home|internal|home\.arpa)$/.test(host)) return true;
    if (/^(fc|fd)[0-9a-f]{2}:/.test(host)) return true;
    const ip = host.split('.').map(Number);
    if (ip.length !== 4 || ip.some((n) => !Number.isInteger(n))) return false;
    const [a, b] = ip;
    return (
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  /** youtube.com cookies in Netscape format, as yt-dlp's --cookies reads them. */
  async function netscapeCookies() {
    const cookies = await api.cookies.getAll({ domain: 'youtube.com' });
    const lines = ['# Netscape HTTP Cookie File', ''];
    for (const c of cookies) {
      const domain = c.hostOnly || c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
      const expires = c.session ? 0 : Math.floor(c.expirationDate ?? 0);
      lines.push(
        [
          `${c.httpOnly ? '#HttpOnly_' : ''}${domain}`,
          c.hostOnly ? 'FALSE' : 'TRUE',
          c.path,
          c.secure ? 'TRUE' : 'FALSE',
          String(expires),
          c.name,
          c.value,
        ].join('\t'),
      );
    }
    return { text: `${lines.join('\n')}\n`, count: cookies.length };
  }

  const load = () =>
    api.storage.local.get(['server', 'token', 'lastSentAt', 'lastError', 'serverStatus']);
  const store = (values) => api.storage.local.set(values);

  /** Sends the cookies to the paired server; remembers the outcome for the popup. */
  async function send() {
    const { server, token } = await load();
    if (!server || !token) return;
    try {
      const { text, count } = await netscapeCookies();
      if (count === 0) return store({ lastError: 'errorNoCookies' });
      const response = await fetch(`${server}/api/v1/cookies`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', authorization: `Bearer ${token}` },
        body: text,
      });
      if (response.status === 401) return store({ lastError: 'errorUnpaired' });
      if (!response.ok) return store({ lastError: 'errorServer' });
      const status = await response.json();
      await store({ lastSentAt: Date.now(), lastError: null, serverStatus: status.status });
    } catch {
      await store({ lastError: 'errorUnreachable' });
    }
  }

  /**
   * Asks for access to the server (and to youtube.com, which Firefox does not
   * grant at install). Must run straight from a click, before any await.
   */
  function requestAccess(server) {
    return api.permissions.request({ origins: [originPattern(server), 'https://*.youtube.com/*'] });
  }

  /** Trades the one-time code for a token and sends the cookies right away. */
  async function pair(server, code) {
    const response = await fetch(`${server}/api/v1/cookies/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) throw new Error(response.status === 400 ? 'errorCode' : 'errorServer');
    const { token } = await response.json();
    await store({ server, token, lastSentAt: null, lastError: null, serverStatus: null });
    await send();
  }

  /** Forgets the server; it deletes the cookies it got from here. */
  async function unpair() {
    const { server } = await load();
    if (server) {
      await fetch(`${server}/api/v1/cookies`, { method: 'DELETE' }).catch(() => undefined);
      await api.permissions.remove({ origins: [originPattern(server)] }).catch(() => undefined);
    }
    await api.storage.local.clear();
  }

  globalThis.HS = {
    api,
    t,
    localize,
    normalizeServer,
    looksLocal,
    requestAccess,
    pair,
    unpair,
    send,
    load,
  };
})();

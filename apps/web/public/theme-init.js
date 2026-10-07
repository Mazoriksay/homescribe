// Runs before the first paint (SPEC.md §11): sets <html data-theme> from the
// saved preference, ?theme= or the system, and data-framed inside a frame.
// An external file because the CSP allows no inline scripts.
/* global document, localStorage, location, URLSearchParams, window */
(function () {
  var root = document.documentElement;
  var preference = 'auto';
  try {
    var saved = JSON.parse(localStorage.getItem('homescribe.prefs') || '{}');
    if (saved && typeof saved.theme === 'string') preference = saved.theme;
  } catch {
    // Storage blocked: fall back to ?theme= or the system.
  }
  var fromUrl = new URLSearchParams(location.search).get('theme');
  if (fromUrl === 'auto' || fromUrl === 'light' || fromUrl === 'dark') preference = fromUrl;
  var dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  var framed;
  try {
    framed = window.self !== window.top;
  } catch {
    framed = true; // a cross-origin parent throws, which also means framed
  }
  if (framed) root.dataset.framed = '';
  var meta = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < meta.length; i++) meta[i].content = dark ? '#151412' : '#f4f2ed';
})();

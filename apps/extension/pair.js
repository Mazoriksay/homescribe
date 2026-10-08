// Opened by "Connect the extension" in Homescribe's settings:
// pair.html#server=<address>&code=<one-time code>
const { t } = HS;
const $ = (id) => document.getElementById(id);

HS.localize(document);

const params = new URLSearchParams(location.hash.slice(1));
let server = null;
try {
  server = HS.normalizeServer(params.get('server') ?? '');
} catch {
  server = null;
}
const code = params.get('code') ?? '';

function fail(key) {
  $('error').hidden = false;
  $('error').textContent = t(key);
}

if (!server || !code) {
  $('connect').hidden = true;
  fail('errorLink');
} else {
  $('server').textContent = server;
  $('remote').hidden = HS.looksLocal(server);
}

$('connect').addEventListener('click', () => {
  $('connect').disabled = true;
  // The permission prompt needs the click itself, so it comes before any await.
  HS.requestAccess(server)
    .then((granted) => {
      if (!granted) throw new Error('errorPermission');
      return HS.pair(server, code);
    })
    .then(() => {
      $('connect').hidden = true;
      $('error').hidden = true;
      $('done').hidden = false;
    })
    .catch((error) => {
      $('connect').disabled = false;
      fail(/^error[A-Z]/.test(error.message) ? error.message : 'errorUnreachable');
    });
});

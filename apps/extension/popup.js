const { api, t } = HS;
const $ = (id) => document.getElementById(id);

HS.localize(document);

function showError(element, key) {
  element.hidden = !key;
  element.textContent = key ? t(key) : '';
}

async function render() {
  const { server, token, lastSentAt, lastError, serverStatus } = await HS.load();
  $('paired').hidden = !token;
  $('pair').hidden = Boolean(token);
  if (!token) return;
  $('server').textContent = server;
  $('last-sent').textContent = lastSentAt ? new Date(lastSentAt).toLocaleString() : t('never');
  $('status').textContent = serverStatus ? t(`status_${serverStatus}`) : '—';
  showError($('error'), lastError);
}

$('send').addEventListener('click', async () => {
  $('send').disabled = true;
  await api.runtime.sendMessage({ type: 'send' });
  $('send').disabled = false;
  await render();
});

$('unpair').addEventListener('click', async () => {
  await HS.unpair();
  await render();
});

$('pair').addEventListener('submit', (event) => {
  event.preventDefault();
  let server;
  try {
    server = HS.normalizeServer($('server-input').value);
  } catch {
    return showError($('pair-error'), 'errorAddress');
  }
  // The permission prompt needs the click itself, so it comes before any await.
  HS.requestAccess(server)
    .then((granted) => {
      if (!granted) throw new Error('errorPermission');
      return HS.pair(server, $('code-input').value);
    })
    .then(render)
    .catch((error) =>
      showError(
        $('pair-error'),
        /^error[A-Z]/.test(error.message) ? error.message : 'errorUnreachable',
      ),
    );
});

void render();

// Chrome runs this as a service worker (common.js imported here); Firefox
// loads both files as background scripts (manifest "scripts").
if (typeof importScripts === 'function') importScripts('common.js');

const { api } = HS;
const PERIODIC = 'periodic';
const CHANGED = 'changed';

function schedule() {
  api.alarms.create(PERIODIC, { periodInMinutes: 6 * 60 });
}
api.runtime.onInstalled.addListener(schedule);
api.runtime.onStartup.addListener(schedule);

// Cookies change in bursts; send once things settle (an alarm of the same name restarts).
api.cookies.onChanged.addListener(({ cookie }) => {
  const host = cookie.domain.replace(/^\./, '');
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    api.alarms.create(CHANGED, { delayInMinutes: 0.5 });
  }
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC || alarm.name === CHANGED) void HS.send();
});

// "Update now" in the popup.
api.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'send') return false;
  HS.send().then(() => reply(true));
  return true;
});

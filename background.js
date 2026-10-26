import { Coordinator } from './coordinator.js';
const coordinator = new Coordinator(chrome);
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'AUTHORIZE_SUBMIT') {
    coordinator.authorize(message, sender).then(reply, error => reply({ authorized: false, error: error.message })); return true;
  }
  // Content scripts cannot start batches or control extension state.
  if (!sender.url?.startsWith(chrome.runtime.getURL('')) || sender.tab) return;
  const actions = {
    GET_STATE: () => coordinator.snapshot(),
    DISCOVER: () => coordinator.discover(message.sourceUrl),
    IMPORT_JOINED: () => coordinator.importJoined(message.tabId),
    CHECK_POST: () => coordinator.discover(message.sourceUrl, true),
    START: () => coordinator.start(message),
    CONTROL: () => coordinator.control(message.action),
    FAVORITE: () => coordinator.favorite(message.group, message.enabled)
  };
  const action = actions[message?.type];
  if (!action) return;
  Promise.resolve().then(action).then(state => reply({ ok: true, state }), error => reply({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'gsa-next') void coordinator.tick();
  if (alarm.name === 'gsa-watchdog') void coordinator.ready.then(() => coordinator.tx(s => {
    if (!s.operation) return;
    if (s.batch?.status === 'running') { s.batch.status = 'paused'; s.batch.message = 'Facebook action took too long. Check the working tab before resuming.'; }
    s.operation.cancelled = true;
  }));
});
chrome.tabs.onRemoved.addListener(tabId => { void coordinator.interrupted(tabId, 'Working tab closed. Resume when ready to open a new working tab.'); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) void coordinator.interrupted(tabId, 'Working tab navigated. Review progress before resuming.');
});
chrome.permissions.onRemoved.addListener(() => { void coordinator.control('pause'); });

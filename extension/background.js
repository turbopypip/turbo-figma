import { t } from './i18n.js';
import { createStatusBadge } from './badge.js';
import { createConnection } from './connection.js';
const connection = createConnection(chrome, { onState: createStatusBadge(chrome) });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'bridge-control' || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  void connection.control(message).then(reply, () => reply({ error: t('action_failed') }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bridge-reconnect') void connection.wake(); });
chrome.tabs.onRemoved.addListener(id => { void connection.tabChanged(id, {}, undefined); });
chrome.tabs.onUpdated.addListener((id, change, tab) => { void connection.tabChanged(id, change, tab); });

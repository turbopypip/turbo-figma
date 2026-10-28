import { t } from './i18n.js';
const states = {
  connected: { text: 'ON', color: '#167541', title: 'badge_connected' },
  busy: { text: 'RUN', color: '#2459a6', title: 'badge_busy' },
  connecting: { text: '…', color: '#a66b00', title: 'badge_connecting' },
  disconnected: { text: 'OFF', color: '#666666', title: 'badge_disconnected' },
  stale: { text: '!', color: '#b63030', title: 'badge_stale' },
  error: { text: '!', color: '#b63030', title: 'badge_error' },
};

export function createStatusBadge(chrome) {
  let work = Promise.resolve();
  return state => {
    const value = states[state];
    if (!value) return work;
    work = work.catch(() => {}).then(async () => {
      await chrome.action.setBadgeBackgroundColor({ color: value.color });
      await chrome.action.setBadgeText({ text: value.text });
      await chrome.action.setTitle({ title: `turbo-figma: ${t(value.title)}` });
    });
    work.catch(() => {});
    return work;
  };
}

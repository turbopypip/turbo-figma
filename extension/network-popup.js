import { t } from './i18n.js';
const status = document.getElementById('capture-status');
async function refresh() {
  try {
    const value = await chrome.runtime.sendMessage({ type: 'bridge-control', action: 'status' });
    status.textContent = value.capture?.message || t('capture_unavailable');
  } catch { status.textContent = t('capture_status_error'); }
}
void refresh();
const timer = setInterval(refresh, 1000);
window.addEventListener('pagehide', () => clearInterval(timer));

const status = document.getElementById('capture-status');
async function refresh() {
  try {
    const value = await chrome.runtime.sendMessage({ type: 'bridge-control', action: 'status' });
    status.textContent = value.capture?.message || 'Сетевой захват недоступен.';
  } catch { status.textContent = 'Не удалось получить состояние макета.'; }
}
void refresh();
const timer = setInterval(refresh, 1000);
window.addEventListener('pagehide', () => clearInterval(timer));

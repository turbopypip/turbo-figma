const start = document.getElementById('capture-start');
const reload = document.getElementById('capture-reload');
const stop = document.getElementById('capture-stop');
const status = document.getElementById('capture-status');
let pending = false, lastError = '';
const send = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'bridge-control', action, ...extra });
async function refresh() {
  if (pending) return;
  try {
    const [value, tabs] = await Promise.all([send('status'), chrome.tabs.query({ active: true, currentWindow: true })]);
    if (pending) return;
    const active = ['starting', 'capturing', 'stopping', 'finishing'].includes(value.capture?.state);
    status.textContent = lastError || value.capture?.message || 'Сетевой захват недоступен.';
    start.disabled = active || value.state !== 'connected' || value.tabId !== tabs[0]?.id || value.capture?.state === 'unavailable';
    reload.disabled = start.disabled;
    stop.disabled = !active;
  } catch { status.textContent = 'Не удалось получить состояние захвата.'; start.disabled = true; reload.disabled = true; stop.disabled = true; }
}
async function action(name) {
  if (pending) return;
  pending = true; lastError = ''; start.disabled = true; reload.disabled = true; stop.disabled = true;
  status.textContent = name === 'capture-reload' ? 'Вкладка Figma будет перезагружена для нового снимка…' : name === 'capture-start' ? 'Начинаю захват…' : 'Снимаю перехват…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const value = await send(name, { tabId: tab?.id });
    lastError = value.error || '';
  } catch { lastError = 'Не удалось выполнить действие захвата.'; }
  finally { pending = false; await refresh(); }
}
start.addEventListener('click', () => action('capture-start'));
reload.addEventListener('click', () => action('capture-reload'));
stop.addEventListener('click', () => action('capture-stop'));
void refresh();
const timer = setInterval(refresh, 1000);
window.addEventListener('pagehide', () => clearInterval(timer));

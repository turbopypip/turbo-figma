const status = document.getElementById('status');
const secretInput = document.getElementById('secret');
function showSecretState(pairing) {
  const saved = typeof pairing?.secret === 'string' && pairing.secret.length >= 32 && pairing.secret.length <= 256;
  document.getElementById('saved-secret').hidden = !saved;
  document.getElementById('secret-field').hidden = saved;
  secretInput.required = !saved;
  secretInput.value = '';
  document.getElementById('forget').hidden = !saved;
}
document.getElementById('change-secret').addEventListener('click', () => {
  document.getElementById('saved-secret').hidden = true;
  document.getElementById('secret-field').hidden = false;
  secretInput.required = true;
  secretInput.focus();
});
const onStorageChanged = (changes, area) => {
  if (area === 'local' && changes.pairing) showSecretState(changes.pairing.newValue);
};
chrome.storage.onChanged.addListener(onStorageChanged);
let selected, pending = false, errorUntil = 0, connected = false;
const cacheStatus = document.getElementById('cache-status');
function cacheButtons() {
  document.getElementById('cache-clear').disabled = pending || !connected;
}
let cacheUpdatedAt = 0;
const size = bytes => `${(bytes / 1048576).toFixed(2)} МиБ`;
async function cacheAction(name) {
  if (pending) return;
  pending = true; cacheButtons();
  if (name === 'cache-clear') cacheStatus.textContent = 'Очищаю кэш…';
  try {
    const value = await send(name);
    if (value.error) { cacheStatus.textContent = value.error; return; }
    if (!value.cache || !Number.isFinite(value.cache.bytes)) throw new Error('Invalid cache response');
    const info = value.cache;
    cacheStatus.textContent = `Кеш: ${size(info.bytes)}.`;
    cacheStatus.title = info.protectedEntries
      ? `Посторонних или непроверенных записей: ${info.protectedEntries}; они сохранены и не включены в размер.`
      : '';
  } catch { cacheStatus.textContent = 'Не удалось получить данные кеша. Проверь соединение с MCP.'; }
  finally { cacheUpdatedAt = Date.now(); pending = false; cacheButtons(); }
}
document.getElementById('cache-clear').addEventListener('click', () => cacheAction('cache-clear'));
const send = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'bridge-control', action, tabId: selected?.id, ...extra });
async function refresh() {
  if (pending || Date.now() < errorUntil) return;
  try {
    const value = await send('status');
    status.textContent = value.message || 'Отключено';
    const wasConnected = connected;
    connected = ['connected', 'busy'].includes(value.state); cacheButtons();
    const loading = ['starting', 'capturing', 'finishing', 'updating', 'stopping'].includes(value.capture?.state);
    if (connected && !loading && !value.busy && (!wasConnected || Date.now() - cacheUpdatedAt >= 10000)) await cacheAction('cache-info');
    if (connected && loading && !cacheUpdatedAt) cacheStatus.textContent = 'Кеш: размер появится после загрузки макета.';
    if (!connected) {
      cacheUpdatedAt = 0;
      cacheStatus.textContent = 'Кеш: подключись к MCP, чтобы узнать размер.';
    }
    if (value.tabId && selected?.id !== value.tabId) document.getElementById('target').textContent = 'Подключён другой макет. «Подключить» переключит мост на текущий.';
  } catch { connected = false; cacheButtons(); status.textContent = 'Расширение обновилось. Закрой это окно и открой значок снова.'; }
}
async function action(name, extra = {}) {
  if (pending) return;
  pending = true; cacheButtons();
  document.getElementById('submit').disabled = true;
  try {
    const value = await send(name, extra);
    status.textContent = value.error || value.message || 'Готово';
    errorUntil = value.error ? Date.now() + 5000 : 0;
    if (value.state) connected = value.state === 'connected';
  } catch { status.textContent = 'Не удалось выполнить действие. Открой значок расширения ещё раз.'; }
  finally { pending = false; cacheButtons(); document.getElementById('submit').disabled = !selected; }
}
document.getElementById('connect').addEventListener('submit', event => {
  event.preventDefault();
  const secret = document.getElementById('secret').value;
  void action('connect', { port: Number(document.getElementById('port').value), secret });
});
for (const name of ['disconnect', 'forget']) document.getElementById(name).addEventListener('click', () => action(name));
async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  selected = /^https:\/\/www\.figma\.com\/(design|file)\/[^/]+/.test(tab?.url || '') ? tab : undefined;
  document.getElementById('submit').disabled = !selected;
  document.getElementById('target').textContent = selected ? 'Подключение к текущей вкладке Figma' : 'Для нового подключения открой макет Figma и нажми значок расширения.';
  const { pairing } = await chrome.storage.local.get('pairing');
  if (pairing) document.getElementById('port').value = pairing.port;
  showSecretState(pairing);
  await refresh();
}
start().catch(() => { status.textContent = 'Не удалось прочитать настройки подключения.'; });
const timer = setInterval(refresh, 1000);
window.addEventListener('pagehide', () => {
  clearInterval(timer);
  chrome.storage.onChanged.removeListener(onStorageChanged);
});

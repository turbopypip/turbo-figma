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
  for (const name of ['cache-info', 'cache-clear']) document.getElementById(name).disabled = pending || !connected;
}
const size = bytes => `${(bytes / 1048576).toFixed(2)} МиБ`;
async function cacheAction(name) {
  if (pending) return;
  pending = true; cacheButtons();
  cacheStatus.textContent = name === 'cache-clear' ? 'Очищаю кэш…' : 'Считаю размер…';
  try {
    const value = await send(name);
    if (value.error) { cacheStatus.textContent = value.error; return; }
    if (!value.cache || !Number.isFinite(value.cache.bytes)) throw new Error('Invalid cache response');
    const info = value.cache;
    cacheStatus.textContent = name === 'cache-clear'
      ? `Удалено ${info.removedGenerations} записей (${size(info.removedBytes)}). Кэш будет создан заново при следующем сетевом захвате.`
      : `Кэш: ${size(info.bytes)}, записей: ${info.generations}, незавершённых: ${info.incomplete}.`;
    if (info.protectedEntries) cacheStatus.textContent += ` Посторонних или непроверенных записей: ${info.protectedEntries}; они сохранены и не включены в размер.`;
  } catch { cacheStatus.textContent = 'Не удалось получить результат. Проверь соединение с MCP и запроси размер кэша.'; }
  finally { pending = false; cacheButtons(); }
}
for (const name of ['cache-info', 'cache-clear']) document.getElementById(name).addEventListener('click', () => cacheAction(name));
const send = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'bridge-control', action, tabId: selected?.id, ...extra });
async function refresh() {
  if (pending || Date.now() < errorUntil) return;
  try {
    const value = await send('status');
    status.textContent = value.message || 'Отключено';
    connected = value.state === 'connected'; cacheButtons();
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

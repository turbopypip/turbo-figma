import { createNetworkCollector } from './network-collector.js';
import { figmaAction } from './dom.js';
import { parseSelectionLink } from './link.js';
import { installDownloadCapture, readDownloadCapture } from './download.js';

export function createConnection(chrome, { WebSocket = globalThis.WebSocket, timers = globalThis, onState = () => {}, createCollector = createNetworkCollector } = {}) {
  let tabId, fileKey, socket, heartbeat, busy = false, exportUncertain = false;
  let cacheRequest, captureConnection, captureOnReady = false;
  const collector = chrome.debugger ? createCollector(chrome) : undefined;
  let currentState = 'disconnected', message = 'Отключено';
  const connectionState = state => { currentState = state; onState(state); };
  const setStatus = text => { message = text; };
  const snapshot = () => {
    const capture = collector?.status || { state: 'unavailable', message: 'Для захвата требуется разрешение debugger и Chrome 125+.' };
    const connected = currentState === 'connected';
    const needsCapture = connected && ['idle', 'stopped', 'stale', 'error'].includes(capture.state);
    return { state: currentState,
      message: currentState === 'busy' ? 'Выполняется запрос MCP…' : needsCapture
        ? 'Мост подключён. Для чтения актуального макета нажми «Подключить». Прежнее чтение нужно начать заново.' : message,
      tabId, fileKey, busy, readReady: connected && capture.state === 'ready',
      capture: needsCapture ? { ...capture, message: `${capture.message} Нажми «Подключить».` } : capture };
  };
  const saveSession = () => persist(() => chrome.storage.session.set({ connection: { tabId, fileKey, wanted: !stopped, exportUncertain } }));
  const targetFile = tab => /^https:\/\/www\.figma\.com\/(design|file)\/([^/?#]+)/.exec(tab?.url || '')?.[2];
  async function invoke(method, params) {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: figmaAction, args: [method, params, fileKey] });
    const value = results[0]?.result;
    if (!value || value.error) {
      const error = new Error(value?.error || 'No response from the Figma tab. Click the extension icon on that tab again.');
      if (value?.nativeCopyStarted === false) error.nativeCopyStarted = false;
      throw error;
    }
    return value.result;
  }
  async function nativeDownload(func, args) {
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
    return results[0]?.result;
  }
  async function request(method, params, connection) {
    if (!['get_screenshot', 'export_asset'].includes(method)) throw new Error('Unsupported MCP method');
    if (params.url) {
      const tab = await chrome.tabs.get(tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
    }
    if (params.url) {
      const target = parseSelectionLink(params.url, fileKey, params.nodeId);
      let ready = false;
      // Figma may retain its existing selection on same-file URL navigation.
      // Prefer selecting the exact linked ID through Layers when already mounted.
      try { await invoke('select_node', { nodeId: target.nodeId, ...(Array.isArray(params.ancestors) ? { ancestors: params.ancestors } : { mountedOnly: true }) }); ready = true; }
      catch (error) {
        // Navigation destroys the observed snapshot. Screenshot selection must
        // succeed in the current document or fail without ending the capture.
        if (method === 'get_screenshot' || Array.isArray(params.ancestors)) throw error;
        // Asset export retains its existing link navigation fallback.
      }
      if (!ready) {
        const currentTab = await chrome.tabs.get(tabId);
        const currentUrl = new URL(currentTab.url || 'about:blank');
        const sameTarget = currentUrl.origin === 'https://www.figma.com' && currentUrl.pathname.split('/')[2] === fileKey &&
          (currentUrl.searchParams.get('node-id') || '').replaceAll('-', ':') === target.nodeId;
        await chrome.tabs.update(tabId, sameTarget ? { active: true } : { url: target.url, active: true });
        const until = Date.now() + 6000;
        while (Date.now() < until) {
          if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Connection closed.');
          try { await invoke('select_node', { nodeId: target.nodeId, ...(Array.isArray(params.ancestors) ? { ancestors: params.ancestors } : { mountedOnly: true }) }); ready = true; break; }
          catch { /* Same-file navigation can briefly unload the document. */ }
          await new Promise(resolve => timers.setTimeout(resolve, 150));
        }
        if (!ready) {
          try { await invoke('select_node', { nodeId: target.nodeId, ...(Array.isArray(params.ancestors) ? { ancestors: params.ancestors } : {}) }); ready = true; } catch { /* Report the exact limitation. */ }
        }
      }
      if (!ready) throw new Error('Linked node is not available in Layers yet. Retry after the file loads; if its ancestors remain collapsed, retry with a fresh network capture.');
      params = { ...params, nodeId: target.nodeId };
    }
    if (!['get_screenshot', 'export_asset'].includes(method)) return invoke(method, params);
    if (exportUncertain) throw new Error('Previous native copy did not finish reliably. Reload Figma and reconnect using the extension icon before exporting again.');
    // Clipboard operations require focus. Only the tab explicitly paired by the user is activated.
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    const marker = `turbo-figma-export:${crypto.randomUUID()}`;
    const format = method === 'get_screenshot' ? 'PNG' : params.format;
    if (format === 'SVG') {
      const node = await invoke('prepare_svg', params);
      await nativeDownload(installDownloadCapture, [marker, fileKey]);
      try {
        await invoke('download_svg', { nodeId: node.id });
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Connection closed; export stopped.');
          const result = await nativeDownload(readDownloadCapture, [marker, fileKey]);
          if (result?.error) throw new Error(result.error);
          if (result?.data) {
            await invoke('assert_selection', { nodeId: node.id });
            return { nodeId: node.id, name: node.name, format: 'SVG', data: result.data };
          }
          await new Promise(resolve => timers.setTimeout(resolve, 200));
        }
        throw new Error('Native SVG export timed out. No SVG was received.');
      } finally { await nativeDownload(readDownloadCapture, [marker, fileKey, true]).catch(() => {}); }
    }
    exportUncertain = true;
    await saveSession();
    let node;
    try { node = await invoke('begin_export', { ...params, marker, format }); }
    catch (error) {
      // A proven preparation failure cannot leave a late clipboard result.
      // Missing/true evidence remains uncertain, including after worker restart.
      if (error.nativeCopyStarted === false) { exportUncertain = false; await saveSession(); }
      throw error;
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Connection closed; export stopped.');
      const image = await invoke('read_export', { ...params, nodeId: node.id, marker, format });
      if (image) { exportUncertain = false; await saveSession(); return image; }
      await new Promise(resolve => timers.setTimeout(resolve, 200));
    }
    throw new Error('Figma copy timed out. Keep the tab focused and check that Copy as is permitted.');
  }
  let credentials, retryTimer, attempt = 0, stopped = true;
  let storageWork = Promise.resolve();
  const persist = operation => {
    storageWork = storageWork.catch(() => {}).then(operation);
    storageWork.catch(() => setStatus('Не удалось сохранить настройки подключения. Проверь расширение.'));
    return storageWork;
  };
  const validCredentials = value => value && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535 &&
    typeof value.secret === 'string' && value.secret.length >= 32 && value.secret.length <= 256;

  function rejectCache(message) {
    cacheRequest?.finish(new Error(message));
  }
  function cacheControl(action) {
    if (busy || cacheRequest) return Promise.reject(new Error('Кэш занят: дождись завершения запроса.'));
    if (!socket || socket.readyState !== WebSocket.OPEN || currentState !== 'connected') return Promise.reject(new Error('Для управления кэшем подключи расширение к MCP.'));
    const connection = socket, id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => finish(new Error('Нет ответа от MCP. Результат очистки неизвестен; обнови сведения о кэше.')), 30000);
      const finish = (error, result) => {
        if (cacheRequest?.id !== id) return;
        timers.clearTimeout(timer); cacheRequest = undefined;
        if (error) reject(error); else resolve(result);
      };
      cacheRequest = { id, finish };
      try { connection.send(JSON.stringify({ type: 'cache-control', id, action })); }
      catch { finish(new Error('Не удалось отправить команду MCP.')); }
    });
  }
  async function stop() {
    rejectCache('Соединение закрыто. Результат операции с кэшем неизвестен.');
    stopped = true;
    captureOnReady = false;
    timers.clearInterval(heartbeat);
    void chrome.alarms.clear("bridge-reconnect");
    connectionState('disconnected');
    timers.clearTimeout(retryTimer);
    const previous = socket;
    socket = undefined;
    previous?.close();
    captureConnection = undefined;
    await collector?.stop();
  }
  function retry() {
    if (stopped) return;
    const delay = Math.min(1000 * 2 ** Math.min(attempt++, 5), 30000);
    connectionState('connecting');
    setStatus('Связь прервана. Жду MCP и подключусь автоматически…');
    retryTimer = timers.setTimeout(() => { if (busy) retry(); else connect(); }, delay);
  }
  function connect() {
    if (stopped || !validCredentials(credentials) || !fileKey) return;
    const connection = socket = new WebSocket(`ws://127.0.0.1:${credentials.port}`);
    connectionState('connecting');
    setStatus('Подключение…');
    connection.onopen = () => {
      if (connection === socket && !stopped) connection.send(JSON.stringify({ type: 'auth', secret: credentials.secret, fileKey }));
    };
    connection.onerror = () => {}; // close schedules a single retry.
    connection.onclose = event => {
      if (connection !== socket || stopped) return;
      void collector?.stop('Связь с MCP прервана; захват неполон.', true);
      rejectCache('Связь с MCP прервана. Результат операции с кэшем неизвестен.');
      socket = undefined;
      timers.clearInterval(heartbeat);
      const captureEnded = captureConnection === connection;
      if (captureEnded) captureConnection = undefined;
      if (event.code === 1008 || event.code === 4008) {
        stopped = true;
        void saveSession().catch(() => {});
        void chrome.alarms.clear('bridge-reconnect');
        connectionState(captureEnded ? 'stale' : 'error');
        setStatus(captureEnded ? 'Сетевой захват завершён. Проверь его состояние и нажми «Подключить» для повтора.'
          : 'Подключение отклонено: проверь ключ или отключи другое расширение. Нажми «Подключить» для повтора.');
        return;
      }
      retry();
    };
    connection.onmessage = async event => {
      if (connection !== socket || stopped) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { connection.close(4008); return; }
      if (msg.type === 'cache-result') {
        if (cacheRequest?.id === msg.id) cacheRequest.finish(typeof msg.error === 'string' ? new Error(msg.error) : undefined, msg.result);
        return;
      }
      if (msg.type === 'ready') {
        attempt = 0;
        timers.clearInterval(heartbeat);
        heartbeat = timers.setInterval(() => { if (connection === socket && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'ping' })); }, 20000);
        connectionState('connected');
        const saved = { ...credentials };
        void persist(() => chrome.storage.local.set({ pairing: saved })).catch(() => {});
        setStatus('Подключено к turbo-figma MCP.');
        if (captureOnReady) {
          captureOnReady = false;
          try {
            if (!collector) throw new Error('Для чтения макета требуется разрешение debugger и Chrome 125+.');
            const tab = await chrome.tabs.get(tabId);
            if (connection !== socket || stopped) return;
            if (targetFile(tab) !== fileKey) throw new Error('Вкладка Figma изменилась. Подключись заново.');
            captureConnection = connection;
            await collector.start({ tabId, fileKey, socket: connection, reload: true });
          } catch (error) {
            if (connection === socket && !stopped) setStatus(`Не удалось подготовить макет: ${error.message} Нажми «Подключить» для повтора.`);
          }
        }
        return;
      }
      if (msg.type !== 'request' || typeof msg.id !== 'string' || msg.id.length > 100) return;
      const reply = value => { if (connection === socket && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'response', id: msg.id, ...value })); };
      if (busy || (collector?.active && collector.status.state !== 'ready')) { reply({ error: 'Browser adapter is busy' }); return; }
      busy = true;
      connectionState('busy');
      try { reply({ result: await request(msg.method, msg.params || {}, connection) }); }
      catch (error) { reply({ error: error.message || 'Browser adapter failed' }); }
      finally {
        busy = false;
        if (connection === socket && connection.readyState === WebSocket.OPEN && !stopped) connectionState('connected');
      }
    };
  }

  async function restore() {
    const [{ pairing }, { connection }] = await Promise.all([chrome.storage.local.get('pairing'), chrome.storage.session.get('connection')]);
    credentials = validCredentials(pairing) ? pairing : undefined;
    if (!connection) return;
    tabId = connection.tabId; fileKey = connection.fileKey; exportUncertain = !!connection.exportUncertain;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (connection.wanted && credentials && fileKey && targetFile(tab) === fileKey) {
      stopped = false;
      await chrome.alarms.create('bridge-reconnect', { periodInMinutes: 1 });
      connect();
    }
  }
  const ready = restore().catch(() => { connectionState('error'); setStatus('Не удалось восстановить подключение. Подключись заново.'); });
  let changing = false;
  async function control(input) {
    await ready;
    if (input.action === 'status') return snapshot();
    if (changing) return { error: 'Дождись завершения предыдущего действия.' };
    changing = true;
    try {
      if (input.action === 'capture-start' || input.action === 'capture-reload') {
        if (!collector) throw new Error('Требуется разрешение debugger и Chrome 125+.');
        if (busy || cacheRequest || currentState !== 'connected' || !socket) throw new Error('Подключи свободный мост к MCP.');
        if (input.tabId !== tabId) throw new Error('Сначала подключи мост к текущей вкладке Figma.');
        const connection = socket;
        const tab = await chrome.tabs.get(tabId);
        if (socket !== connection || targetFile(tab) !== fileKey) throw new Error('Вкладка или соединение изменились.');
        captureConnection = connection;
        await collector.start({ tabId, fileKey, socket: connection, reload: input.action === 'capture-reload' });
        return snapshot();
      }
      if (input.action === 'capture-stop') { await collector?.stop(); return snapshot(); }
      if (input.action === 'cache-info' || input.action === 'cache-clear') {
        const cache = await cacheControl(input.action);
        return { cache, message: input.action === 'cache-clear' ? 'Кэш очищен.' : 'Размер кэша получен.' };
      }
      if (input.action === 'connect') {
        if (busy) throw new Error('Дождись завершения текущего запроса.');
        const tab = await chrome.tabs.get(input.tabId);
        const file = targetFile(tab);
        const candidate = { port: input.port, secret: input.secret || credentials?.secret };
        if (!file || !validCredentials(candidate)) throw new Error('Открой макет Figma и проверь порт и секрет.');
        await stop();
        if (tabId !== tab.id || fileKey !== file) exportUncertain = false;
        tabId = tab.id; fileKey = file; credentials = candidate; attempt = 0; stopped = false; captureOnReady = true;
        await saveSession();
        await chrome.alarms.create('bridge-reconnect', { periodInMinutes: 1 });
        connect();
      } else if (input.action === 'disconnect' || input.action === 'forget') {
        await stop(); await saveSession();
        if (input.action === 'forget') { credentials = undefined; await persist(() => chrome.storage.local.remove('pairing')); }
        setStatus(input.action === 'forget' ? 'Ключ удалён.' : 'Отключено. Ключ сохранён.');
      } else throw new Error('Неизвестное действие.');
      return snapshot();
    } catch (error) { return { error: error.message }; }
    finally { changing = false; }
  }
  async function wake() {
    await ready;
    if (!stopped && !socket && !busy) { timers.clearTimeout(retryTimer); connect(); }
  }
  async function tabChanged(id, change, tab) {
    await ready;
    if (id !== tabId) return;
    if (change.status === 'complete') collector?.navigation(change);
    if (!tab || (change.url && targetFile(tab) !== fileKey)) {
      await stop(); await saveSession(); setStatus('Вкладка Figma закрыта или открыла другой файл.');
    } else if (change.status === 'loading') {
      if (!collector?.navigation(change)) await collector?.stop('Вкладка перезагружается; прежний захват неполон.');
      if (!busy) { exportUncertain = false; await saveSession(); }
    }
  }
  connectionState('disconnected');
  return { control, ready, wake, tabChanged };
}

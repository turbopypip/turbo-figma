import { t } from './i18n.js';
import { createNetworkCollector } from './network-collector.js';
import { figmaAction } from './dom.js';
import { parseSelectionLink } from './link.js';
import { withBackgroundRendering } from './background-render.js';
import { installDownloadCapture, readDownloadCapture } from './download.js';

export function createConnection(chrome, { WebSocket = globalThis.WebSocket, timers = globalThis, onState = () => {}, createCollector = createNetworkCollector } = {}) {
  let tabId, fileKey, socket, heartbeat, busy = false;
  let cacheRequest, captureConnection, captureOnReady = false;
  const collector = chrome.debugger ? createCollector(chrome) : undefined;
  let currentState = 'disconnected', message = t('disconnected');
  const connectionState = state => { currentState = state; onState(state); };
  const setStatus = text => { message = text; };
  const snapshot = () => {
    const capture = collector?.status || { state: 'unavailable', message: t('capture_requirements') };
    const connected = currentState === 'connected';
    const needsCapture = connected && ['idle', 'stopped', 'stale', 'error'].includes(capture.state);
    return { state: currentState,
      message: currentState === 'busy' ? t('mcp_busy') : needsCapture
        ? t('recapture_required') : message,
      tabId, fileKey, busy, readReady: connected && capture.state === 'ready',
      capture: needsCapture ? { ...capture, message: t('click_connect', [capture.message]) } : capture };
  };
  const saveSession = () => persist(() => chrome.storage.session.set({ connection: { tabId, fileKey, wanted: !stopped } }));
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
    const format = method === 'get_screenshot' ? 'PNG' : params.format;
    if (!['PNG', 'SVG'].includes(format)) throw new Error('Unsupported export format');
    const target = params.url ? parseSelectionLink(params.url, fileKey, params.nodeId) : { nodeId: params.nodeId };
    return withBackgroundRendering(chrome, tabId, collector?.attachedTo?.(tabId) === true, async () => {
      const node = await invoke('select_node', { nodeId: target.nodeId, ancestors: params.ancestors || [] });
      await invoke('prepare_export', { nodeId: node.id, format });
      const marker = `turbo-figma-export:${crypto.randomUUID()}`;
      await nativeDownload(installDownloadCapture, [marker, fileKey, format, params.scale || 1]);
      try {
        await invoke('download_export', { nodeId: node.id });
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Connection closed; export stopped.');
          const result = await nativeDownload(readDownloadCapture, [marker, fileKey]);
          if (result?.error) throw new Error(result.error);
          if (result?.data) {
            await invoke('assert_selection', { nodeId: node.id });
            return { nodeId: node.id, name: node.name, format, ...result };
          }
          await new Promise(resolve => timers.setTimeout(resolve, 200));
        }
        throw new Error('Native export timed out. No file was received.');
      } finally { await nativeDownload(readDownloadCapture, [marker, fileKey, true]); }
    });
  }
  let credentials, retryTimer, attempt = 0, stopped = true;
  let storageWork = Promise.resolve();
  const persist = operation => {
    storageWork = storageWork.catch(() => {}).then(operation);
    storageWork.catch(() => setStatus(t('settings_save_error')));
    return storageWork;
  };
  const validCredentials = value => value && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535 &&
    typeof value.secret === 'string' && value.secret.length >= 32 && value.secret.length <= 256;

  function rejectCache(message) {
    cacheRequest?.finish(new Error(message));
  }
  function cacheControl(action) {
    if (busy || cacheRequest) return Promise.reject(new Error(t('cache_busy')));
    if (!socket || socket.readyState !== WebSocket.OPEN || currentState !== 'connected') return Promise.reject(new Error(t('cache_requires_connection')));
    const connection = socket, id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => finish(new Error(t('cache_timeout'))), 30000);
      const finish = (error, result) => {
        if (cacheRequest?.id !== id) return;
        timers.clearTimeout(timer); cacheRequest = undefined;
        if (error) reject(error); else resolve(result);
      };
      cacheRequest = { id, finish };
      try { connection.send(JSON.stringify({ type: 'cache-control', id, action })); }
      catch { finish(new Error(t('command_failed'))); }
    });
  }
  async function stop() {
    rejectCache(t('cache_closed'));
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
    setStatus(t('reconnecting'));
    retryTimer = timers.setTimeout(() => { if (busy) retry(); else connect(); }, delay);
  }
  function connect() {
    if (stopped || !validCredentials(credentials) || !fileKey) return;
    const connection = socket = new WebSocket(`ws://127.0.0.1:${credentials.port}`);
    connectionState('connecting');
    setStatus(t('connecting'));
    connection.onopen = () => {
      if (connection === socket && !stopped) connection.send(JSON.stringify({ type: 'auth', secret: credentials.secret, fileKey }));
    };
    connection.onerror = () => {}; // close schedules a single retry.
    connection.onclose = event => {
      if (connection !== socket || stopped) return;
      void collector?.stop(t('capture_connection_lost'), true);
      rejectCache(t('cache_connection_lost'));
      socket = undefined;
      timers.clearInterval(heartbeat);
      const captureEnded = captureConnection === connection;
      if (captureEnded) captureConnection = undefined;
      if (event.code === 1008 || event.code === 4008) {
        stopped = true;
        void saveSession().catch(() => {});
        void chrome.alarms.clear('bridge-reconnect');
        connectionState(captureEnded ? 'stale' : 'error');
        setStatus(captureEnded ? t('capture_ended')
          : t('connection_rejected'));
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
        setStatus(t('connected'));
        if (captureOnReady) {
          captureOnReady = false;
          try {
            if (!collector) throw new Error(t('read_requirements'));
            const tab = await chrome.tabs.get(tabId);
            if (connection !== socket || stopped) return;
            if (targetFile(tab) !== fileKey) throw new Error(t('figma_changed'));
            captureConnection = connection;
            await collector.start({ tabId, fileKey, socket: connection, reload: true });
          } catch (error) {
            if (connection === socket && !stopped) setStatus(t('prepare_failed', [error.message]));
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
    tabId = connection.tabId; fileKey = connection.fileKey;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (connection.wanted && credentials && fileKey && targetFile(tab) === fileKey) {
      stopped = false;
      await chrome.alarms.create('bridge-reconnect', { periodInMinutes: 1 });
      connect();
    }
  }
  const ready = restore().catch(() => { connectionState('error'); setStatus(t('restore_failed')); });
  let changing = false;
  async function control(input) {
    await ready;
    if (input.action === 'status') return snapshot();
    if (changing) return { error: t('wait_action') };
    changing = true;
    try {
      if (input.action === 'capture-start' || input.action === 'capture-reload') {
        if (!collector) throw new Error(t('debugger_requirements'));
        if (busy || cacheRequest || currentState !== 'connected' || !socket) throw new Error(t('connect_idle'));
        if (input.tabId !== tabId) throw new Error(t('connect_current'));
        const connection = socket;
        const tab = await chrome.tabs.get(tabId);
        if (socket !== connection || targetFile(tab) !== fileKey) throw new Error(t('target_changed'));
        captureConnection = connection;
        await collector.start({ tabId, fileKey, socket: connection, reload: input.action === 'capture-reload' });
        return snapshot();
      }
      if (input.action === 'capture-stop') { await collector?.stop(); return snapshot(); }
      if (input.action === 'cache-info' || input.action === 'cache-clear') {
        const cache = await cacheControl(input.action);
        return { cache, message: input.action === 'cache-clear' ? t('cache_cleared') : t('cache_received') };
      }
      if (input.action === 'connect') {
        if (busy) throw new Error(t('wait_request'));
        const tab = await chrome.tabs.get(input.tabId);
        const file = targetFile(tab);
        const candidate = { port: input.port, secret: input.secret || credentials?.secret };
        if (!file || !validCredentials(candidate)) throw new Error(t('check_credentials'));
        await stop();
        tabId = tab.id; fileKey = file; credentials = candidate; attempt = 0; stopped = false; captureOnReady = true;
        await saveSession();
        await chrome.alarms.create('bridge-reconnect', { periodInMinutes: 1 });
        connect();
      } else if (input.action === 'disconnect' || input.action === 'forget') {
        await stop(); await saveSession();
        if (input.action === 'forget') { credentials = undefined; await persist(() => chrome.storage.local.remove('pairing')); }
        setStatus(input.action === 'forget' ? t('key_forgotten') : t('disconnected_saved'));
      } else throw new Error(t('unknown_action'));
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
      await stop(); await saveSession(); setStatus(t('figma_closed'));
    } else if (change.status === 'loading') {
      if (!collector?.navigation(change)) await collector?.stop(t('tab_reloading'));
      if (!busy) await saveSession();
    }
  }
  connectionState('disconnected');
  return { control, ready, wake, tabChanged };
}

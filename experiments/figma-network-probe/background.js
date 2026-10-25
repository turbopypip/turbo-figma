// Deliberately no headers, cookies, request bodies, or URL query strings.
// Payloads themselves are private diagnostic data; keep the exported file local.
let capture = null;
let activeTab = null;
let usedBytes = 0;
const MAX_BYTES = 24 * 1024 * 1024;
const sockets = new Set();
const pending = new Set();
const safeUrl = raw => { try { const u = new URL(raw); return u.origin + u.pathname; } catch { return ''; } };
const isFigma = raw => { try { const h = new URL(raw).hostname; return h === 'figma.com' || h.endsWith('.figma.com'); } catch { return false; } };
const keyOf = (source, id) => `${source.sessionId || 'main'}:${id}`;
function record(event) {
  if (!capture) return;
  const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
  if (usedBytes + bytes > MAX_BYTES || capture.events.length >= 10000) { capture.dropped++; return; }
  usedBytes += bytes;
  capture.events.push({ at: Date.now(), ...event });
}
async function enable(source) {
  await chrome.debugger.sendCommand(source, 'Network.enable', {});
  await chrome.debugger.sendCommand(source, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
}
async function onEvent(source, method, p) {
  if (source.tabId !== activeTab || activeTab === null) return;
  if (method === 'Target.attachedToTarget') {
    record({ kind: 'target', type: p.targetInfo.type, url: safeUrl(p.targetInfo.url) });
    try { await enable({ tabId: activeTab, sessionId: p.sessionId }); }
    catch (e) { record({ kind: 'error', stage: 'child-target', message: e.message }); }
    return;
  }
  const key = keyOf(source, p.requestId);
  if (method === 'Network.webSocketCreated') {
    let url;
    try { url = new URL(p.url); } catch { return; }
    if (url.origin !== 'wss://www.figma.com' || url.pathname !== `/api/multiplayer/${capture.fileKey}`) return;
    sockets.add(key); record({ kind: 'ws-open', key, url: safeUrl(p.url) });
  } else if (sockets.has(key) && method === 'Network.webSocketFrameReceived') {
    record({ kind: 'ws-received', key, opcode: p.response.opcode, payload: p.response.payloadData });
  } else if (method === 'Network.webSocketClosed') {
    if (sockets.has(key)) record({ kind: 'ws-close', key });
    sockets.delete(key);
  }
}
chrome.debugger.onEvent.addListener((...args) => {
  const task = onEvent(...args).catch(e => record({ kind: 'error', message: e.message }));
  pending.add(task); task.finally(() => pending.delete(task));
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (activeTab !== null && source.tabId === activeTab && !source.sessionId) {
    activeTab = null; record({ kind: 'detached', reason });
    void Promise.allSettled([...pending]).then(() => chrome.storage.local.set({ capture })).catch(() => {});
  }
});
async function handle(action) {
  if (!capture && activeTab === null) {
    capture = (await chrome.storage.local.get('capture')).capture || null;
    usedBytes = capture ? new TextEncoder().encode(JSON.stringify(capture.events)).length : 0;
  }
  if (action === 'start') {
    if (activeTab !== null) throw new Error('Сначала останови текущую запись');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !isFigma(tab.url) || !/^\/(design|file|board)\//.test(new URL(tab.url).pathname)) throw new Error('Открой вкладку с файлом Figma');
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    activeTab = tab.id;
    capture = { version: 2, fileKey: new URL(tab.url).pathname.split('/')[2], startedAt: new Date().toISOString(), fileUrl: safeUrl(tab.url), nodeId: new URL(tab.url).searchParams.get('node-id'), dropped: 0, events: [], notes: ['Only incoming multiplayer WebSocket messages for this file.', 'No HTTP bodies, livegraph, fonts or outgoing messages.', 'Late worker attachment and size limits may cause gaps.'] };
    usedBytes = 0; sockets.clear();
    try { await enable({ tabId: tab.id }); await chrome.tabs.reload(tab.id); }
    catch (error) { await chrome.debugger.detach({ tabId: tab.id }).catch(() => {}); activeTab = null; throw error; }
  } else if (action === 'stop') {
    if (activeTab !== null) { const tabId = activeTab; activeTab = null; await Promise.allSettled([...pending]); await chrome.debugger.detach({ tabId }).catch(() => {}); }
    if (capture) capture.stoppedAt = new Date().toISOString();
    if (capture) await chrome.storage.local.set({ capture });
  } else if (action === 'export') {
    if (activeTab !== null) throw new Error('Сначала останови запись');
    if (!capture) capture = (await chrome.storage.local.get('capture')).capture;
    if (!capture) throw new Error('Запись ещё не сделана');
    return capture;
  } else if (action === 'clear') {
    if (activeTab !== null) throw new Error('Сначала останови запись');
    capture = null; usedBytes = 0; await chrome.storage.local.remove('capture');
  } else if (action !== 'status') throw new Error('Unknown action');
  return { version: '0.2.0', recording: activeTab !== null, events: capture?.events.length || 0, bytes: usedBytes, dropped: capture?.dropped || 0, counts: (capture?.events || []).reduce((a, e) => { a[e.kind] = (a[e.kind] || 0) + 1; return a; }, {}) };
}
let controls = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  controls = controls.catch(() => {}).then(() => handle(message.action));
  controls.then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error.message }));
  return true;
});

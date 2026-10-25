import { createCaptureSender, TRANSFER_PART_BYTES } from './network-transfer.js';

// Limits include the record currently being written, not only waiting records.
export const CAPTURE_LIMITS = Object.freeze({ payloadChars: 8 * 1024 * 1024, queueBytes: 16 * 1024 * 1024,
  records: 64, sessions: 32, sockets: 32 });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
export function createNetworkCollector(chrome, { createSender = createCaptureSender, timers = globalThis, initialTimeout = 120000 } = {}) {
  let current;
  let status = { state: 'idle', message: 'Сетевой захват выключен.', complete: false, events: 0, bytes: 0 };
  const publish = (ctx, state, message) => {
    if (current === ctx) status = { state, message, complete: state === 'ready', events: ctx.events, bytes: ctx.bytes };
  };
  function stop(reason = 'Захват остановлен. Начальный снимок не подтверждён.', error = false) {
    const ctx = current;
    if (!ctx) return Promise.resolve();
    if (ctx.closing) return ctx.closing;
    ctx.closed = true;
    ctx.abort.abort();
    timers.clearTimeout(ctx.timer);
    publish(ctx, error ? 'error' : 'stopping', reason);
    ctx.queue.length = 0;
    ctx.socket.removeEventListener('close', ctx.disconnected);
    // Attach may still be pending. Always detach if it succeeds after cancellation.
    ctx.closing = Promise.resolve().then(async () => {
      await ctx.attach?.catch(() => {});
      let detached = false;
      if (ctx.attached) {
        try { await chrome.debugger.detach({ tabId: ctx.tabId }); detached = true; }
        catch { ctx.detachFailed = true; publish(ctx, 'error', 'Не удалось снять debugger. Отключи отладку в панели Chrome или закрой вкладку.'); }
      }
      if (!ctx.attached || detached) {
        publish(ctx, error ? 'error' : 'stopped', reason);
        if (current === ctx) current = undefined;
      }
      ctx.sessions.clear(); ctx.sockets.clear();
    });
    ctx.sender.cancel();
    return ctx.closing;
  }
  const fail = (ctx, reason) => { if (current === ctx && !ctx.closed) void stop(reason, true); };
  async function cancellable(ctx, operation) {
    if (ctx.abort.signal.aborted) throw new Error('Захват отменён.');
    let cancel;
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(new Error('Захват отменён.'));
      ctx.abort.signal.addEventListener('abort', cancel, { once: true });
    });
    try { return await Promise.race([operation, cancelled]); }
    finally { ctx.abort.signal.removeEventListener('abort', cancel); }
  }
  async function enable(ctx, source) {
    if (ctx.closed) return;
    await chrome.debugger.sendCommand(source, 'Network.enable', {});
    if (ctx.closed) return;
    await chrome.debugger.sendCommand(source, 'Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: ctx.reload, flatten: true,
      filter: [{ type: 'worker', exclude: false }, { type: 'iframe', exclude: false }, { exclude: true }],
    });
    if (!ctx.closed && source.sessionId && ctx.reload) await chrome.debugger.sendCommand(source, 'Runtime.runIfWaitingForDebugger', {});
  }
  async function complete(ctx, parts) {
    ctx.sealed = true;
    ctx.queue.length = 0; ctx.queuedBytes = 0;
    publish(ctx, 'finishing', 'Начальная загрузка получена. Сохраняю снимок…');
    try {
      await chrome.debugger.detach({ tabId: ctx.tabId });
      ctx.attached = false;
      if (ctx.closed) return;
      await ctx.sender.finish({ schemaReceived: true, joinStarted: true, joinEnded: true,
        receivedParts: parts, droppedParts: 0, sequenceComplete: true });
      if (ctx.closed) return;
      timers.clearTimeout(ctx.timer);
      ctx.socket.removeEventListener('close', ctx.disconnected);
      publish(ctx, 'ready', 'Начальный снимок сохранён. Это состояние на момент загрузки; последующие изменения не отслеживаются.');
      ctx.closed = true; ctx.sessions.clear(); ctx.sockets.clear();
      if (current === ctx) current = undefined;
    } catch (error) { fail(ctx, `Не удалось завершить снимок: ${error.message}`); }
  }
  async function drain(ctx) {
    if (ctx.draining || ctx.closed) return;
    ctx.draining = true;
    try {
      while (!ctx.closed && ctx.queue.length) {
        const record = ctx.queue[0];
        for (let offset = 0; offset < record.length && !ctx.closed; offset += TRANSFER_PART_BYTES) {
          const ack = await ctx.sender.append(record.subarray(offset, offset + TRANSFER_PART_BYTES));
          if (ack?.initial?.initialComplete) {
            if (offset + TRANSFER_PART_BYTES < record.length) throw new Error('Premature initial completion');
            if (ctx.closed) return;
            ctx.events++; ctx.bytes += record.length;
            await complete(ctx, ack.nextSequence);
            return;
          }
        }
        if (ctx.closed) return;
        ctx.queue.shift(); ctx.queuedBytes -= record.length;
        ctx.events++; ctx.bytes += record.length;
        publish(ctx, 'capturing', 'Запись начального снимка. Ожидаю JOIN_END; если файл уже загружен, выбери «Перезагрузить и захватить».');
      }
    } catch (error) { fail(ctx, `Передача захвата остановлена: ${error.message}`); }
    finally { ctx.draining = false; }
  }
  function received(ctx, source, p) {
    const payload = p.response?.payloadData, opcode = p.response?.opcode;
    if (opcode === 9 || opcode === 10) return;
    if (opcode !== 1 && opcode !== 2) { fail(ctx, 'Неподдерживаемая фрагментация multiplayer; снимок неполон.'); return; }
    if (typeof payload !== 'string' || payload.length > CAPTURE_LIMITS.payloadChars) {
      fail(ctx, 'Сетевое сообщение превышает лимит или повреждено; захват неполон.'); return;
    }
    // NDJSON records may cross part boundaries. No URLs, headers, HTTP or outgoing data.
    // Upper bound avoids allocating a JSON escape expansion beyond the queue budget.
    let estimate = 512;
    for (let i = 0; i < payload.length; i++) {
      const code = payload.charCodeAt(i);
      estimate += code < 32 ? 6 : code === 34 || code === 92 ? 2 : code < 128 ? 1 : code < 2048 ? 2 : 3;
      if (estimate + ctx.queuedBytes > CAPTURE_LIMITS.queueBytes) { fail(ctx, 'Переполнение очереди захвата; снимок неполон.'); return; }
    }
    if (ctx.queue.length >= CAPTURE_LIMITS.records) { fail(ctx, 'Переполнение очереди захвата; снимок неполон.'); return; }
    const record = new TextEncoder().encode(JSON.stringify({ version: 1, kind: 'ws-received',
      session: source.sessionId || 'main', requestId: p.requestId, eventSequence: ctx.recordSequence++, opcode, payload }) + '\n');
    if (record.length + ctx.queuedBytes > CAPTURE_LIMITS.queueBytes) { fail(ctx, 'Переполнение очереди захвата; снимок неполон.'); return; }
    ctx.queue.push(record); ctx.queuedBytes += record.length;
    void drain(ctx);
  }
  function onEvent(source, method, p) {
    const ctx = current;
    if (!ctx || ctx.closed || ctx.sealed || !ctx.attached || source.tabId !== ctx.tabId || (source.sessionId && !ctx.sessions.has(source.sessionId))) return;
    if (method === 'Target.attachedToTarget') {
      if (!['worker', 'iframe'].includes(p.targetInfo?.type) || !validId(p.sessionId)) {
        fail(ctx, 'Неподдерживаемая дочерняя debugger-сессия; захват остановлен.'); return;
      }
      if (ctx.sessions.has(p.sessionId)) return;
      if (ctx.sessions.size >= CAPTURE_LIMITS.sessions) { fail(ctx, 'Превышен лимит дочерних сессий.'); return; }
      ctx.sessions.add(p.sessionId);
      const task = enable(ctx, { tabId: ctx.tabId, sessionId: p.sessionId })
        .catch(() => { if (ctx.sessions.has(p.sessionId)) fail(ctx, 'Не удалось включить захват worker/iframe.'); })
        .finally(() => ctx.setup.delete(task));
      ctx.setup.add(task);
      return;
    }
    if (method === 'Target.detachedFromTarget' && ctx.sessions.has(p.sessionId)) {
      const ownedStream = [...ctx.sockets].some(key => JSON.parse(key)[0] === p.sessionId);
      ctx.sessions.delete(p.sessionId);
      if (ownedStream) fail(ctx, 'Дочерняя сессия отключена; захват неполон.');
      return;
    }
    if (!ctx.accepting) return;
    if (!validId(p.requestId)) return;
    const key = JSON.stringify([source.sessionId || null, p.requestId]);
    if (method === 'Network.webSocketCreated') {
      let url;
      try { url = new URL(p.url); } catch { return; }
      if (url.origin !== 'wss://www.figma.com' || url.pathname !== `/api/multiplayer/${ctx.fileKey}`) return;
      if (ctx.sockets.size >= CAPTURE_LIMITS.sockets) { fail(ctx, 'Превышен лимит multiplayer-соединений.'); return; }
      ctx.sockets.add(key);
    } else if (ctx.sockets.has(key)) {
      if (method === 'Network.webSocketFrameReceived') received(ctx, source, p);
      else if (method === 'Network.webSocketClosed' || method === 'Network.webSocketFrameError') fail(ctx, 'Поток multiplayer прерван; захват неполон.');
    }
  }
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(source => {
    const ctx = current;
    if (ctx && source.tabId === ctx.tabId && !source.sessionId) {
      ctx.attached = false;
      if (ctx.closed) { if (ctx.detachFailed && current === ctx) current = undefined; return; }
      if (ctx.sealed) return;
      fail(ctx, 'Debugger отключён. Захват неполон; подключись и запусти его заново.');
    }
  });
  return {
    get status() { return { ...status }; },
    get active() { return !!current; },
    navigation(change = {}) {
      if (!current?.reloadPending) return false;
      // Figma can emit complete/loading again while its initial workers are starting.
      // The explicit capture remains bounded by JOIN_END/timeout. A real stream
      // replacement still fails through socket close or owning-target detach.
      return change.status === 'loading' || change.status === 'complete';
    },
    async start({ tabId, fileKey, socket, reload = false }) {
      if (current) throw new Error('Предыдущий захват ещё не остановлен.');
      const ctx = { tabId, fileKey, socket, reload, abort: new AbortController(), accepting: !reload, recordSequence: 0, closed: false, attached: false, queue: [], queuedBytes: 0,
        setup: new Set(), sessions: new Set(), sockets: new Set(), events: 0, bytes: 0, draining: false };
      current = ctx;
      publish(ctx, 'starting', 'Подключаю debugger к выбранной вкладке…');
      ctx.sender = createSender(socket, { fileKey, sessionId: crypto.randomUUID(), generation: 1 }, { format: 'ndjson-v1' });
      ctx.disconnected = () => fail(ctx, 'Связь с MCP прервана; захват неполон.');
      socket.addEventListener('close', ctx.disconnected);
      ctx.timer = timers.setTimeout(() => fail(ctx, 'Таймаут начальной загрузки. Подключись заново и выбери «Перезагрузить и захватить».'), initialTimeout);
      try {
        await ctx.sender.begin();
        if (ctx.closed) throw new Error('Захват отменён.');
        ctx.attach = chrome.debugger.attach({ tabId }, '1.3').then(() => { ctx.attached = true; });
        await cancellable(ctx, ctx.attach);
        if (ctx.closed) throw new Error('Захват отменён.');
        await cancellable(ctx, enable(ctx, { tabId }));
        if (ctx.closed) throw new Error('Захват отменён.');
        if (reload) {
          while (ctx.setup.size && !ctx.closed) await cancellable(ctx, Promise.all([...ctx.setup]));
          if (ctx.closed) throw new Error('Захват отменён.');
          ctx.reloadPending = true; ctx.accepting = true;
          publish(ctx, 'capturing', 'Перезагружаю Figma для получения полного начального снимка…');
          await cancellable(ctx, chrome.tabs.reload(tabId));
          if (ctx.closed) throw new Error('Захват отменён.');
        }
        publish(ctx, 'capturing', 'Ожидаю входящие multiplayer-сообщения. Позднее подключение не даёт полного снимка.');
      } catch (error) {
        if (current === ctx && !ctx.closed) await stop(`Не удалось начать захват: ${error.message}`, true);
        throw error;
      }
    },
    stop,
  };
}

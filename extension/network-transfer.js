// Transport only; the Figma collector and its initial-snapshot evidence arrive in TODO 05–06.
export const TRANSFER_PART_BYTES = 256 * 1024;
export function createCaptureSender(socket, snapshot, { timeout = 30000, timers = globalThis, format } = {}) {
  snapshot = Object.freeze({ fileKey: snapshot.fileKey, sessionId: snapshot.sessionId, generation: snapshot.generation });
  let pending, heartbeat, state = 'new', next = 0, revision = 0;
  const cleanup = () => {
    timers.clearTimeout(heartbeat);
    socket.removeEventListener('message', receive);
    socket.removeEventListener('close', disconnected);
  };
  function fail(reason) {
    state = 'error';
    const request = pending; pending = undefined;
    if (request) { request.resolveDone(); timers.clearTimeout(request.timer); request.reject(new Error(reason)); }
    cleanup();
    socket.close(4008, 'Capture failed');
  }
  function disconnected() { fail('Capture disconnected; start a new generation after reconnecting'); }
  function receive(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { fail('Invalid bridge message'); return; }
    if (msg.type === 'capture-error') { fail(msg.error || 'Capture failed'); return; }
    if (msg.type !== 'capture-result') return;
    if (!pending || msg.id !== pending.id || msg.action !== pending.action ||
      msg.snapshot?.fileKey !== snapshot.fileKey || msg.snapshot?.sessionId !== snapshot.sessionId ||
      msg.snapshot?.generation !== snapshot.generation || msg.nextSequence !== pending.expected ||
      (msg.revision ?? 0) !== revision + (pending.action === 'delta' ? 1 : 0) ||
      msg.status !== (['finish', 'heartbeat', 'delta'].includes(pending.action) ? 'ready' : 'capturing')) { fail('Invalid capture acknowledgement'); return; }
    const request = pending; pending = undefined;
    timers.clearTimeout(request.timer);
    next = msg.nextSequence; revision = msg.revision ?? 0;
    state = ['finish', 'heartbeat', 'delta'].includes(request.action) ? 'ready' : 'capturing';
    if (state === 'ready') heartbeat = timers.setTimeout(() => { void send('heartbeat').catch(() => {}); }, 5000);
    request.resolveDone(); request.resolve(msg);
  }
  socket.addEventListener('message', receive);
  socket.addEventListener('close', disconnected);
  function send(action, fields = {}) {
    if (state === 'error' || (state === 'ready' && !['heartbeat', 'delta'].includes(action))) return Promise.reject(new Error('Capture is closed'));
    // Zero queued parts: producer must await each acknowledgement. A live source that
    // cannot pause must fail the capture, never silently drop or accumulate messages.
    if (pending || socket.bufferedAmount > 0) { fail('Capture queue overflow'); return Promise.reject(new Error('Capture queue overflow')); }
    if (socket.readyState !== 1 || (action === 'begin' ? state !== 'new' : ['heartbeat', 'delta'].includes(action) ? state !== 'ready' : state !== 'capturing')) {
      fail('Invalid capture state'); return Promise.reject(new Error('Invalid capture state'));
    }
    timers.clearTimeout(heartbeat);
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = timers.setTimeout(() => fail('Capture acknowledgement timeout'), timeout);
      let resolveDone;
      const done = new Promise(resolve => { resolveDone = resolve; });
      pending = { done, resolveDone, id, action, expected: next + (action === 'part' ? 1 : 0), timer, resolve, reject };
      try { socket.send(JSON.stringify({ type: 'capture', id, snapshot, action, ...fields })); }
      catch { fail('Could not send capture'); }
    });
  }
  return {
    begin: () => send('begin', format ? { format } : {}),
    append(bytes) {
      if (pending) { fail('Capture queue overflow'); return Promise.reject(new Error('Capture queue overflow')); }
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > TRANSFER_PART_BYTES) {
        fail('Invalid capture part size'); return Promise.reject(new Error('Invalid capture part size'));
      }
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return send('part', { sequence: next, data: btoa(binary) });
    },
    async delta(bytes) {
      // A producer may arrive while the periodic heartbeat is awaiting its ACK.
      // Wait for that single request; the collector owns the bounded data queue.
      if (pending?.action === 'heartbeat') await pending.done;
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > TRANSFER_PART_BYTES) {
        fail('Live record limit exceeded'); return Promise.reject(new Error('Live record limit exceeded'));
      }
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return send('delta', { sequence: revision, data: btoa(binary) });
    },
    finish: evidence => send('finish', { evidence }),
    cancel: () => fail('Capture cancelled'),
    get status() { return { state, nextSequence: next, pendingParts: pending?.action === 'part' ? 1 : 0 }; },
  };
}

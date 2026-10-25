import { NetworkTransfer } from './network-transfer.js';
import type { NetworkStore } from './network-store.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

export const MAX_MESSAGE = 6 * 1024 * 1024;
export class Bridge {
  private server: WebSocketServer;
  private peer?: WebSocket;
  private pairedFile?: string;
  get fileKey(): string | undefined { return this.peer?.readyState === WebSocket.OPEN ? this.pairedFile : undefined; }
  private connectedAt: string | null = null;
  private disconnectedAt: string | null = null;
  private lastDisconnect?: { code: number; reason: string };
  private captureError?: string;
  private pending?: { id: string; finish: (error?: Error, value?: unknown) => void };
  private cacheBusy = false;
  private transfers = new Set<NetworkTransfer>();
  private get captureBusy() { return [...this.transfers].some(transfer => transfer.busy); }
  readonly ready: Promise<void>;
  constructor(private secret: string, port = 3055, private timeout = 30_000, private cacheControl?: (action: 'cache-info' | 'cache-clear') => Promise<unknown>, private captureStore?: Pick<NetworkStore, 'begin' | 'observe' | 'renewObservation' | 'applyLive' | 'setSelection'>) {
    this.server = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: MAX_MESSAGE,
      perMessageDeflate: false, backlog: 8 });
    this.ready = new Promise((resolve, reject) => {
      this.server.once('listening', resolve);
      this.server.once('error', reject);
    });
    this.server.on('error', () => {});
    this.server.on('connection', socket => {
      // Unauthenticated connections have a short lifetime and cannot displace a paired browser extension.
      if (this.server.clients.size > 8) { socket.terminate(); return; }
      let authenticated = false;
      let transfer: NetworkTransfer | undefined;
      const timer = setTimeout(() => socket.terminate(), 3000);
      socket.on('error', () => {});
      socket.on('close', (code, reason) => {
        clearTimeout(timer);
        if (transfer) void transfer.close().finally(() => this.transfers.delete(transfer!));
        if (this.peer === socket) {
          this.peer = undefined;
          this.connectedAt = null;
          this.disconnectedAt = new Date().toISOString();
          this.lastDisconnect = { code, reason: reason.toString().slice(0, 500) };
          this.pending?.finish(new Error('Figma browser extension disconnected. Reconnect the browser extension.'));
        }
      });
      socket.on('message', async raw => {
        try {
          const msg = JSON.parse(raw.toString());
          if (!authenticated) {
            const supplied = Buffer.from(typeof msg.secret === 'string' ? msg.secret : '');
            const expected = Buffer.from(this.secret);
            if (msg.type !== 'auth' || supplied.length !== expected.length ||
                !timingSafeEqual(supplied, expected) || this.peer?.readyState === WebSocket.OPEN) {
              socket.close(1008, 'Pairing failed or another browser extension is connected'); return;
            }
            if (msg.fileKey !== undefined && (typeof msg.fileKey !== 'string' || !/^[A-Za-z0-9]{1,256}$/.test(msg.fileKey))) { socket.close(1008, 'Invalid file'); return; }
            authenticated = true;
            clearTimeout(timer);
            // A tab switch may authenticate before the previous socket emits close.
            // Its CLOSING state no longer owns the bridge; do not reject the new tab.
            if (this.peer) {
              this.pending?.finish(new Error('Previous Figma connection closed during reconnection.'));
              for (const previous of this.transfers) void previous.close();
            }
            this.peer = socket;
            this.pairedFile = msg.fileKey;
            // Reserve the peer, but do not announce ready until the preceding
            // capture has released its disk writer and read leases.
            await Promise.all([...this.transfers].map(previous => previous.close()));
            if (this.peer !== socket || socket.readyState !== WebSocket.OPEN) return;
            this.connectedAt = new Date().toISOString();
            this.lastDisconnect = undefined;
            this.captureError = undefined;
            if (this.captureStore) {
              transfer = new NetworkTransfer(this.captureStore, msg.fileKey, message => {
                if ((message as {type?: string}).type === 'capture-error') this.captureError = (message as {error: string}).error;
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
              }, () => socket.close(1008, 'Capture failed'), this.timeout);
              this.transfers.add(transfer);
            }
            socket.send(JSON.stringify({ type: 'ready' }));
            return;
          }
          if (this.peer !== socket) return;
          if (msg.type === 'capture') {
            if (!transfer) { socket.close(1008, 'Capture unavailable'); return; }
            transfer.receive(msg, !!this.pending || this.cacheBusy || [...this.transfers].some(other => other !== transfer && other.busy));
            return;
          }
          if (msg.type === 'cache-control') {
            if (typeof msg.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(msg.id) || !['cache-info', 'cache-clear'].includes(msg.action)) {
              socket.close(1008, 'Invalid cache control'); return;
            }
            void this.controlCache(socket, msg.id, msg.action);
            return;
          }
          if (msg.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
          if (msg.type !== 'response' || msg.id !== this.pending?.id) return;
          if (typeof msg.error === 'string') this.pending?.finish(new Error(msg.error.slice(0, 500)));
          else this.pending?.finish(undefined, msg.result);
        } catch {
          if (transfer) void transfer.close();
          socket.close(1008, 'Invalid bridge message');
        }
      });
    });
  }
  private async controlCache(socket: WebSocket, id: string, action: 'cache-info' | 'cache-clear') {
    const reply = (value: unknown) => {
      if (this.peer === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cache-result', id, ...value as object }));
    };
    if (this.pending || this.cacheBusy || this.captureBusy) { reply({ error: 'Кэш занят: дождись завершения текущего запроса.' }); return; }
    if (!this.cacheControl) { reply({ error: 'Управление кэшем недоступно. Обнови и перезапусти MCP.' }); return; }
    this.cacheBusy = true;
    try { reply({ result: await this.cacheControl(action) }); }
    catch (error) { reply({ error: error instanceof Error ? error.message.slice(0, 500) : 'Не удалось обработать кэш.' }); }
    finally { this.cacheBusy = false; }
  }
  get port(): number { return (this.server.address() as { port: number }).port; }
  get status() {
    const connected = this.peer?.readyState === WebSocket.OPEN;
    const busy = connected && (!!this.pending || this.cacheBusy || this.captureBusy);
    return {
      connected, busy, state: connected ? (busy ? 'busy' : 'connected') : 'disconnected',
      checkedAt: new Date().toISOString(), connectedAt: connected ? this.connectedAt : null,
      disconnectedAt: this.disconnectedAt,
      ...(this.lastDisconnect ? {lastDisconnect: this.lastDisconnect} : {}),
      ...(this.captureError ? {captureError: this.captureError} : {}),
      message: connected ? (busy ? 'Figma подключена, выполняется запрос.' : 'Расширение Figma подключено.')
        : 'Расширение Figma не подключено. Открой макет и нажми значок расширения; сохранённый ключ загрузится автоматически. Если вкладка подключения уже открыта, дождись восстановления связи или нажми «Подключить».',
      scope: 'Authenticated browser bridge connection only; Figma tab availability and export readiness are not checked.'
    };
  }
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('Request cancelled'));
    const peer = this.peer;
    if (!peer || peer.readyState !== WebSocket.OPEN) return Promise.reject(new Error(
      'Figma browser extension is not connected. Open the file in Chrome, click Figma Kilo Browser Bridge and pair it using the local secret.'));
    if (this.pending || this.cacheBusy || this.captureBusy) return Promise.reject(new Error('Figma is busy. Wait for the current request.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cancel = () => {
        // Native Figma copy cannot be interrupted. Disconnect so repeated cancellations cannot queue work.
        peer.terminate();
        finish(new Error(signal?.aborted ? 'Request cancelled; reconnect browser extension.' : 'Figma request timed out; reconnect browser extension.'));
      };
      const timer = setTimeout(cancel, this.timeout);
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (this.pending?.id === id) this.pending = undefined;
        if (error) reject(error); else resolve(value);
      };
      this.pending = { id, finish };
      signal?.addEventListener('abort', cancel, { once: true });
      peer.send(JSON.stringify({ type: 'request', id, method, params }), error => {
        if (error) finish(new Error('Could not send request to Figma'));
      });
    });
  }
  async close(): Promise<void> {
    this.pending?.finish(new Error('Server is shutting down'));
    this.peer = undefined;
    this.connectedAt = null;
    this.disconnectedAt = new Date().toISOString();
    for (const socket of this.server.clients) socket.terminate();
    await Promise.all([...this.transfers].map(transfer => transfer.close()));
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}

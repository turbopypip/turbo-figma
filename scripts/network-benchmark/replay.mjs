// Executes production collector in Node with synthetic CDP events. This is NOT Chrome memory.
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createNetworkCollector } from '../../extension/network-collector.js';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const emit = value => { if (process.connected) process.send(value); };
let onEvent, collector, socket;
const sample = stage => emit({ type: 'replay-metrics', stage, memory: process.memoryUsage(), processPeakRssBytes: process.resourceUsage().maxRSS * 1024 });
try {
  socket = new WebSocket(`ws://127.0.0.1:${config.port}`); await once(socket, 'open');
  const ready = once(socket, 'message'); socket.send(JSON.stringify({ type: 'auth', secret: config.secret, fileKey: config.fileKey }));
  if (JSON.parse((await ready)[0]).type !== 'ready') throw new Error('Replay authentication failed');
  const chrome = { debugger: { onEvent: { addListener: fn => { onEvent = fn; } }, onDetach: { addListener() {} },
    attach: async () => {}, detach: async () => {}, sendCommand: async () => {} } };
  collector = createNetworkCollector(chrome); sample('before-capture');
  await collector.start({ tabId: 1, fileKey: config.fileKey, socket });
  const source = { tabId: 1 };
  onEvent(source, 'Network.webSocketCreated', { requestId: 'replay', url: `wss://www.figma.com/api/multiplayer/${config.fileKey}` });
  let count = 0;
  for await (const line of createInterface({ input: createReadStream(config.events), crlfDelay: Infinity })) {
    const event = JSON.parse(line); if (collector.status.state === 'ready') break;
    onEvent(source, 'Network.webSocketFrameReceived', { requestId: 'replay', response: { opcode: event.opcode, payloadData: event.payload } });
    count++;
    const deadline = performance.now() + 35000;
    while (collector.status.events < count && collector.status.state !== 'ready') {
      if (collector.status.state === 'error' || performance.now() > deadline) throw new Error('Replay capture failed or timed out');
      await new Promise(r => setTimeout(r, 2));
    }
    sample('record-acknowledged');
  }
  const deadline = performance.now() + 35000;
  while (collector.status.state === 'finishing' && performance.now() < deadline) await new Promise(r => setTimeout(r, 2));
  if (collector.status.state !== 'ready') throw new Error('Replay did not produce a ready snapshot');
  sample('capture-ready'); emit({ type: 'done', events: collector.status.events, bytes: collector.status.bytes });
} catch { emit({ type: 'failed', error: 'Capture replay failed; inspect fixture and supported initial protocol.' }); process.exitCode = 1; }
finally { await collector?.stop(); socket?.close(); if (process.connected) process.disconnect(); }

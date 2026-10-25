import { once } from 'node:events';
import { WebSocket } from 'ws';
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCTcAAAAASUVORK5CYII=';
// Transport fixture only. This does not simulate or validate Chrome/Figma rendering.
export function mockBrowser(method, params) {
  const node = { id: '1:1', name: '../../CON:Макет', type: 'FRAME' };
  if (method === 'get_selection') return { adapter: 'chrome-dom', nodes: [node], total: 1, incomplete: true };
  if (method === 'get_design_context') return { node, nodeCount: 2, truncated: true, properties: [{ section: 'Layout', text: 'Width 100px' }] };
  if (params.nodeId && params.nodeId !== node.id) throw new Error('Node is not mounted in Layers');
  const format = method === 'get_screenshot' ? 'PNG' : params.format;
  return { nodeId: node.id, name: node.name, format, scale: 1,
    data: format === 'SVG' ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') : PNG };
}
export async function pair(port, secret, respond, fileKey) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'auth', secret, fileKey }));
  const [raw] = await ready;
  if (JSON.parse(raw).type !== 'ready') throw new Error('Pair failed');
  if (respond) ws.on('message', async raw => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'request') return;
    let value;
    try { value = { result: await respond(msg.method, msg.params) }; }
    catch (error) { value = { error: error.message }; }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response', id: msg.id, ...value }));
  });
  return ws;
}

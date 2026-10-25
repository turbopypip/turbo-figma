import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Bridge } from './bridge.js';
import { AssetStore } from './assets.js';
import path from 'node:path';
import { NetworkStore } from './network-store.js';
import { createServer } from './server.js';

const configSchema = z.object({ secret: z.string().min(32).max(256),
  assetDirectory: z.string().min(1), port: z.number().int().min(1024).max(65535).default(3055),
  variablesFile: z.string().min(1).optional(), adapter: z.literal('browser').default('browser') });
async function main() {
  const configPath = process.env.FIGMA_KILO_CONFIG || fileURLToPath(new URL('../.local/config.json', import.meta.url));
  const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const assets = await AssetStore.create(config.assetDirectory);
  // Resolve against this installation, never against Kilo's working directory.
  const cache = await NetworkStore.create(fileURLToPath(new URL('../', import.meta.url)));
  if (assets.root === cache.root || assets.root.startsWith(cache.root + path.sep)) throw new Error('Asset directory must be outside the managed cache');
  const bridge = new Bridge(config.secret, config.port, 30_000, async action => {
    if (action === 'cache-clear') return cache.clean('all');
    return cache.info();
  }, cache);
  try { await bridge.ready; }
  catch { throw new Error(`Cannot listen on 127.0.0.1:${config.port}. Close the other MCP session or change the port in the server and extension.`); }
  try { await cache.clean('prune'); }
  catch (error) { await bridge.close(); throw error; }
  const handle = serveStdio(() => createServer(bridge, assets, config.variablesFile, cache), { onerror: () => console.error('MCP transport error') });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await bridge.close();
    await handle.close();
  };
  process.stdin.once('end', () => void close());
  process.stdin.once('close', () => void close());
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  console.error(`Figma bridge listening on ws://127.0.0.1:${config.port}. Pair the ${config.adapter} adapter. Assets: ${assets.root}`);
}
main().catch(error => {
  console.error(error instanceof Error && 'code' in error && error.code === 'ENOENT'
    ? 'Configuration not found. Run npm run setup -- --assets <absolute-directory> first.'
    : error instanceof z.ZodError ? 'Invalid configuration; run setup again.'
    : error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});

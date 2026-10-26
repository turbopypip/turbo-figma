import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--assets' || !path.isAbsolute(args[1])) {
  console.error('Usage: npm run setup -- --assets <absolute-directory>');
  process.exit(1);
}
const binary = process.env.FIGMA_RUST_BINARY ?? path.join(root, `rust/helper/target/release/figma-rust-helper${process.platform === 'win32' ? '.exe' : ''}`);
if (!existsSync(binary)) throw new Error('Rust binary not found. Run npm run build first.');
const local = path.join(root, '.local');
await mkdir(local, { recursive: true, mode: 0o700 });
const configPath = path.join(local, 'config.json');
let config;
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (config) {
  if (path.resolve(config.assetDirectory) !== path.resolve(args[1])) throw new Error('Existing asset directory differs. Edit .local/config.json explicitly.');
  config.adapter = 'browser';
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
} else {
  config = { secret: randomBytes(32).toString('hex'), port: 3055, assetDirectory: path.resolve(args[1]), adapter: 'browser' };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
await writeFile(path.join(local, 'pairing.txt'), `Figma Kilo Browser Bridge\nEndpoint: ws://127.0.0.1:${config.port}\nSecret: ${config.secret}\n`, { mode: 0o600 });
const command = [binary, '--server', configPath, root];
await writeFile(path.join(local, 'kilo.json'), JSON.stringify({ mcp: { figma: {
  type: 'local', command, enabled: true,
  timeout: 60000
} } }, null, 2) + '\n');
console.log(`Setup ready. Merge ${path.join(local, 'kilo.json')} into your Kilo config.\nLoad ${path.join(root, 'extension')} as an unpacked Chrome extension.\nPaste the secret from ${path.join(local, 'pairing.txt')} into its connection form. Do not share these files.`);

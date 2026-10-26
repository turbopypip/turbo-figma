import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = process.env.FIGMA_RUST_BINARY ?? fileURLToPath(new URL(`../rust/helper/target/release/figma-rust-helper${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const mode = process.env.FIGMA_NETWORK_BACKEND ?? (['darwin', 'win32'].includes(process.platform) ? 'rust' : 'node');
if (!['rust','node'].includes(mode)) throw new Error('FIGMA_NETWORK_BACKEND must be rust or node');
const available = mode === 'rust' && await access(binary).then(()=>true,()=>false);
if (available) {
  const config = process.env.FIGMA_KILO_CONFIG ?? fileURLToPath(new URL('../.local/config.json', import.meta.url));
  const child = spawn(binary, ['--server', config, root], {stdio:'inherit',windowsHide:true});
  const kill = () => child.kill('SIGKILL');
  process.once('exit', kill);
  process.once('SIGINT', () => child.kill('SIGINT'));
  process.once('SIGTERM', () => child.kill('SIGTERM'));
  child.once('error', error => { console.error(error.message); process.exitCode=1; });
  child.once('close', (code, signal) => { process.off('exit',kill); process.exitCode=code ?? (signal ? 1 : 0); });
} else {
  await import('./fallback-entry.js');
}

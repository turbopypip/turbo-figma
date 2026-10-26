import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const defaultBinary = fileURLToPath(new URL(`../rust/helper/target/release/figma-rust-helper${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const LIMIT = 65536;
const failure = (code, message = code) => Object.assign(new Error(message), { code });

// Resolve/reject only after close: the direct child has exited and its pipes closed.
export function callHelper({ binary = defaultBinary, operation = 'ping', argument = '', version = 1, timeoutMs = 2000, signal } = {}) {
  if (signal?.aborted) return Promise.reject(failure('ABORTED'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) return Promise.reject(failure('INVALID_TIMEOUT'));
  const fields = [String(version), '1', operation, argument];
  if (fields.some(value => typeof value !== 'string' || /[\t\r\n]/.test(value))) return Promise.reject(failure('INVALID_FRAME'));
  const frame = `${fields.join('\t')}\n`;
  if (Buffer.byteLength(frame) > LIMIT) return Promise.reject(failure('INVALID_FRAME'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let error;
    let output = Buffer.alloc(0);
    let stderrBytes = 0;
    const stop = (reason) => {
      error ??= reason;
      child.kill('SIGKILL');
    };
    const abort = () => stop(failure('ABORTED'));
    const timer = setTimeout(() => stop(failure('TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', cause => { error ??= failure('SPAWN_FAILED', cause.message); });
    child.stdin.on('error', cause => { error ??= failure('WRITE_FAILED', cause.message); });
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length > LIMIT) return stop(failure('OUTPUT_LIMIT'));
      output = Buffer.concat([output, chunk]);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > LIMIT) stop(failure('LOG_LIMIT'));
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) return reject(Object.assign(error, { pid: child.pid }));
      if (code !== 0) return reject(failure('HELPER_EXIT', `Helper exited: ${code ?? exitSignal}`));
      const response = output.toString('utf8');
      const match = /^1\t([01])\t(ok|error)\t([A-Za-z_]+)\n$/.exec(response);
      if (!match || (match[1] !== '1' && match[2] === 'ok')) return reject(failure('PROTOCOL_ERROR'));
      if (match[2] === 'error') return reject(failure(match[3]));
      resolve({ value: match[3], pid: child.pid });
    });
    child.stdin.end(frame);
  });
}

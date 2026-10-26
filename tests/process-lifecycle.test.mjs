import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { callDiagnostic, defaultBinary } from './native-process.mjs';

const available = existsSync(defaultBinary);
if (process.env.REQUIRE_TURBO_FIGMA === '1' && !available) throw new Error('Build the release turbo-figma binary before testing');
const native = { skip: available ? false : 'Release turbo-figma binary not built' };

test('Rust ping and shutdown exit before resolving', native, async () => {
  for (const operation of ['ping', 'shutdown']) {
    const result = await callDiagnostic({ operation });
    assert.equal(result.value, operation === 'ping' ? 'pong' : 'bye');
    assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
  }
});
test('Rust rejects incompatible and invalid requests', native, async () => {
  for (const [options, code] of [[{ version: 2 }, 'UNSUPPORTED_VERSION'], [{ operation: 'unknown' }, 'UNKNOWN_OPERATION'], [{ operation: 'delay', argument: '60001' }, 'INVALID_ARGUMENT']]) {
    await assert.rejects(callDiagnostic(options), { code });
  }
});
test('Rust deadline, cancellation, crash and subsequent recovery', native, async () => {
  await assert.rejects(callDiagnostic({ operation: 'delay', argument: '60000', timeoutMs: 100 }), error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.throws(() => process.kill(error.pid, 0), { code: 'ESRCH' });
    return true;
  });
  const controller = new AbortController();
  const pending = callDiagnostic({ operation: 'delay', argument: '60000', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'ABORTED');
    assert.throws(() => process.kill(error.pid, 0), { code: 'ESRCH' });
    return true;
  });
  await assert.rejects(callDiagnostic({ operation: 'crash' }), { code: 'PROCESS_EXIT' });
  assert.equal((await callDiagnostic()).value, 'pong');
});
test('host validates before spawning and handles missing binary', async () => {
  await assert.rejects(callDiagnostic({ operation: 'ping\n' }), { code: 'INVALID_FRAME' });
  await assert.rejects(callDiagnostic({ timeoutMs: NaN }), { code: 'INVALID_TIMEOUT' });
  await assert.rejects(callDiagnostic({ signal: AbortSignal.abort() }), { code: 'ABORTED' });
  await assert.rejects(callDiagnostic({ binary: '/nonexistent/turbo-figma' }), { code: 'SPAWN_FAILED' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkVersion } from '../scripts/check-version.mjs';
import { packageRelease, releaseFiles } from '../scripts/package-release.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = ['Cargo.toml', 'Cargo.lock', 'package-lock.json'];

test('release versions agree and mismatched tags or extension versions are rejected', async t => {
  const version = await checkVersion(root);
  assert.equal(await checkVersion(root, `v${version}`), version);
  await assert.rejects(checkVersion(root, 'v0.0.0'), /Tag must be/);
  const fixture = await mkdtemp(path.join(tmpdir(), 'turbo release versions '));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const file of [...metadata, 'package.json', 'extension/manifest.json', 'resources/tools.json']) {
    await mkdir(path.dirname(path.join(fixture, file)), { recursive: true });
    await cp(path.join(root, file), path.join(fixture, file));
  }
  const manifest = JSON.parse(await readFile(path.join(fixture, 'extension/manifest.json'), 'utf8'));
  manifest.version = '0.0.0';
  await writeFile(path.join(fixture, 'extension/manifest.json'), JSON.stringify(manifest));
  await assert.rejects(checkVersion(fixture), /extension\/manifest.json/);
});

test('release archive installs without dependencies, preserves binary mode and excludes local data', async t => {
  const output = await realpath(await mkdtemp(path.join(tmpdir(), 'turbo release archive ')));
  t.after(() => rm(output, { recursive: true, force: true }));
  const archive = await packageRelease(root, output);
  const unpacked = path.join(output, 'unpacked');
  await mkdir(unpacked);
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:TURBO_TEST_ARCHIVE -DestinationPath $env:TURBO_TEST_OUTPUT'],
    { encoding: 'utf8', env: { ...process.env, TURBO_TEST_ARCHIVE: archive, TURBO_TEST_OUTPUT: unpacked } })
    : spawnSync('tar', ['-xzf', archive, '-C', unpacked], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const entries = await readdir(unpacked);
  assert.equal(entries.length, 1);
  const bundle = path.join(unpacked, entries[0]);
  for (const file of releaseFiles) await stat(path.join(bundle, file));
  for (const file of ['.local', '.cache', 'node_modules', '.git', 'src']) {
    await assert.rejects(stat(path.join(bundle, file)), { code: 'ENOENT' });
  }
  for (const locale of ['en', 'ru']) await stat(path.join(bundle, `extension/_locales/${locale}/messages.json`));
  const binary = path.join(bundle, `target/release/turbo-figma${process.platform === 'win32' ? '.exe' : ''}`);
  if (process.platform !== 'win32') assert.ok((await stat(binary)).mode & 0o111);
  // Executing the actual packaged binary also catches missing dynamic libraries.
  const usage = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(usage.status, 1, usage.error?.message);
  assert.match(usage.stderr, /Usage: turbo-figma/);
  const env = { ...process.env }; delete env.TURBO_FIGMA_BINARY;
  const setup = spawnSync(process.execPath, ['scripts/setup.mjs', '--assets', path.join(output, 'assets')],
    { cwd: bundle, env, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);
  const config = JSON.parse(await readFile(path.join(bundle, '.local/kilo.json'), 'utf8'));
  assert.deepEqual(config.mcp.turbo_figma.command, [binary, '--server', path.join(bundle, '.local/config.json'), bundle + path.sep]);
});

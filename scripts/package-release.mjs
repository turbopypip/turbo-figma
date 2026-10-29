import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { checkVersion } from './check-version.mjs';

// Explicit allowlist: never package pairing secrets, caches or developer files.
export const releaseFiles = ['extension', 'resources', 'examples', 'README.md', 'README.ru.md',
  'LICENSE', 'package.json', 'scripts/setup.mjs', 'scripts/start.mjs'];

export async function packageRelease(root, output = path.join(root, 'dist')) {
  const version = await checkVersion(root);
  const platform = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform];
  if (!platform) throw new Error(`Unsupported release platform: ${process.platform}`);
  const name = `turbo-figma-v${version}-${platform}-${process.arch}`;
  const binary = `target/release/turbo-figma${process.platform === 'win32' ? '.exe' : ''}`;
  if (!(await stat(path.join(root, binary))).isFile()) throw new Error('Build the Rust binary first');
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(path.join(output, '.release-'));
  const bundle = path.join(staging, name);
  const archive = path.join(output, `${name}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`);
  try {
    for (const file of [...releaseFiles, binary]) {
      const destination = path.join(bundle, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(root, file), destination, { recursive: true });
    }
    // tar preserves executable permissions on Unix. PowerShell creates a native Windows ZIP.
    const result = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Compress-Archive -LiteralPath $env:TURBO_RELEASE_SOURCE -DestinationPath $env:TURBO_RELEASE_ARCHIVE -Force'],
      { encoding: 'utf8', env: { ...process.env, TURBO_RELEASE_SOURCE: bundle, TURBO_RELEASE_ARCHIVE: archive } })
      : spawnSync('tar', ['-czf', archive, '-C', staging, name], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || 'Archive creation failed');
    return archive;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(await packageRelease(fileURLToPath(new URL('../', import.meta.url))));
}

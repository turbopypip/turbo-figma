import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

export async function checkVersion(root, tag) {
  const json = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const pkg = await json('package.json');
  const lock = await json('package-lock.json');
  const cargo = await readFile(path.join(root, 'Cargo.toml'), 'utf8');
  const cargoLock = await readFile(path.join(root, 'Cargo.lock'), 'utf8');
  const versions = {
    'package.json': pkg.version,
    'package-lock.json': lock.version,
    'package-lock.json root': lock.packages[''].version,
    'Cargo.toml': cargo.match(/^version = "([^"]+)"/m)?.[1],
    'Cargo.lock': cargoLock.split('[[package]]').find(block => /^name = "turbo-figma"$/m.test(block))?.match(/^version = "([^"]+)"/m)?.[1],
    'extension/manifest.json': (await json('extension/manifest.json')).version,
    'resources/tools.json': (await json('resources/tools.json')).info.version,
  };
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Release version must be X.Y.Z');
  for (const [name, version] of Object.entries(versions)) {
    if (version !== pkg.version) throw new Error(`${name}: expected ${pkg.version}, got ${version}`);
  }
  if (tag !== undefined && tag !== `v${pkg.version}`) throw new Error(`Tag must be v${pkg.version}, got ${tag}`);
  return pkg.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
  console.log(`Version verified: ${await checkVersion(fileURLToPath(new URL('../', import.meta.url)), tag)}`);
}

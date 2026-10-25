import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, readFile, mkdir, symlink, rename, open, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NetworkStore, MAX_PART_BYTES } from '../dist/network-store.js';
const id = { fileKey: 'file1', sessionId: 'session1', generation: 1 };
const evidence = { schemaReceived: true, joinStarted: true, joinEnded: true, receivedParts: 2, droppedParts: 0, sequenceComplete: true };
async function fixture(t) {
  const project = await mkdtemp(path.join(tmpdir(), 'figma-cache-Юникод '));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = await NetworkStore.create(project);
  const generation = async () => path.join(store.root, (await readdir(store.root))[0]);
  return { project, store, generation };
}
async function ready(store) {
  const writer = await store.begin(id);
  await writer.append(0, Buffer.from('first'));
  await writer.append(1, Buffer.from('second'));
  await writer.commit(evidence);
  return writer;
}
test('parts persist independently; only committed generations can be read after restart', async t => {
  const { project, store, generation } = await fixture(t);
  const writer = await store.begin(id);
  await writer.append(0, Buffer.from('first'));
  assert.equal((await readFile(path.join(await generation(), 'part-0.bin'))).toString(), 'first');
  await assert.rejects(store.readManifest(id), /ENOENT/);
  await assert.rejects(store.readPart(id, 0), /ENOENT/);
  const restarted = await NetworkStore.create(project);
  await assert.rejects(restarted.readManifest(id), /ENOENT/);
  await writer.append(1, Buffer.from('second'));
  const manifest = await writer.commit(evidence);
  assert.equal(writer.state.status, 'ready');
  assert.equal(manifest.parts.length, 2);
  assert.deepEqual(await restarted.readManifest(id), manifest);
  assert.equal((await restarted.readPart(id, 1)).toString(), 'second');
  await assert.rejects(store.begin(id), /EEXIST/);
  await assert.rejects(writer.append(2, Buffer.from('late')), /closed/);
});
test('gaps, duplicates, oversized parts and incomplete evidence fail closed', async t => {
  const { store } = await fixture(t);
  const operations = [
    w => w.append(1, Buffer.from('gap')),
    async w => { await w.append(0, Buffer.from('a')); await w.append(0, Buffer.from('duplicate')); },
    w => w.append(0, Buffer.alloc(MAX_PART_BYTES + 1)),
    w => w.append(0, Buffer.alloc(0)),
    async w => { await w.append(0, Buffer.from('a')); await w.commit({ ...evidence, receivedParts: 1, joinEnded: false }); },
    async w => { await w.append(0, Buffer.from('a')); await w.commit(evidence); },
    async w => { await w.append(0, Buffer.from('a')); await w.commit({ ...evidence, receivedParts: 1, droppedParts: 1 }); },
  ];
  for (const [index, operation] of operations.entries()) {
    const snapshot = { ...id, generation: index + 1 };
    const writer = await store.begin(snapshot);
    await assert.rejects(operation(writer));
    assert.equal(writer.state.status, 'error');
    await assert.rejects(store.readManifest(snapshot), /ENOENT/);
  }
});
test('partial disk write and sync failure leave no ready manifest and release writer', async t => {
  const { store, project, generation } = await fixture(t);
  const probe = await open(path.join(project, 'probe'), 'wx');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const writer = await store.begin(id);
  const partial = t.mock.method(proto, 'writeFile', async function () {
    await this.write(Buffer.from('partial'));
    throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
  });
  await assert.rejects(writer.append(0, Buffer.from('full part')), { code: 'ENOSPC' });
  partial.mock.restore();
  assert.equal(writer.state.status, 'error');
  assert.equal((await readFile(path.join(await generation(), 'part-0.bin'))).toString(), 'partial');
  await assert.rejects(store.readManifest(id), /ENOENT/);
  const next = await store.begin({ ...id, generation: 2 });
  await next.append(0, Buffer.from('ok'));
  const sync = t.mock.method(proto, 'sync', async function () { throw new Error('sync failed'); });
  await assert.rejects(next.commit({ ...evidence, receivedParts: 1 }), /sync failed/);
  sync.mock.restore();
  assert.equal(next.state.status, 'error');
  await assert.rejects(store.readManifest({ ...id, generation: 2 }), /ENOENT/);
});
test('commit publication failure does not publish ready state', async t => {
  const { store, generation } = await fixture(t);
  const writer = await store.begin(id);
  await writer.append(0, Buffer.from('a'));
  await mkdir(path.join(await generation(), 'ready.json'));
  await assert.rejects(writer.commit({ ...evidence, receivedParts: 1 }));
  assert.equal(writer.state.status, 'error');
  await assert.rejects(store.readManifest(id), /Unsafe cache file/);
});
test('concurrent operations reject instead of queuing; abort is terminal', async t => {
  const { store } = await fixture(t);
  const writer = await store.begin(id);
  await assert.rejects(store.begin({ ...id, generation: 2 }), /BUSY/);
  const writing = writer.append(0, Buffer.alloc(MAX_PART_BYTES, 7));
  await assert.rejects(writer.append(1, Buffer.from('b')), /BUSY/);
  await assert.rejects(writer.commit(evidence), /BUSY/);
  await writing;
  assert.equal(writer.state.status, 'capturing');
  await writer.abort();
  assert.equal(writer.state.status, 'error');
  await assert.rejects(store.readManifest(id), /ENOENT/);
  const next = await store.begin({ ...id, generation: 2 });
  await assert.rejects(writer.abort(), /closed/);
  // A late call on a closed writer must not release the new writer's lease.
  await assert.rejects(store.begin({ ...id, generation: 3 }), /BUSY/);
  await next.abort();
});
test('path inputs and symlinked cache roots cannot escape project cache', async t => {
  const { project, store } = await fixture(t);
  for (const change of [{ fileKey: '../../outside' }, { sessionId: '../x' }, { sessionId: 'x/y' }, { generation: -1 }]) {
    await assert.rejects(store.begin({ ...id, ...change }));
    await assert.rejects(store.readManifest({ ...id, ...change }));
  }
  const outside = path.join(project, 'outside');
  await mkdir(outside);
  await rename(store.root, `${store.root}-old`);
  await symlink(outside, store.root, 'dir');
  await assert.rejects(store.begin(id), /Unsafe cache directory/);
  await assert.rejects(NetworkStore.create(project), /Unsafe cache directory/);
  assert.deepEqual(await readdir(outside), []);
});
test('generation and part symlinks are rejected; replacement directories invalidate writers', async t => {
  const { project, store, generation } = await fixture(t);
  const writer = await store.begin(id);
  const dir = await generation();
  const outside = path.join(project, 'outside');
  await mkdir(outside);
  await rename(dir, `${dir}-old`);
  await symlink(outside, dir, 'dir');
  await assert.rejects(writer.append(0, Buffer.from('escape')), /Unsafe cache directory/);
  assert.deepEqual(await readdir(outside), []);
  await rm(dir);
  await mkdir(dir);
  await assert.rejects(store.readManifest(id), /ENOENT/);
  const nextId = { ...id, generation: 2 };
  const next = await store.begin(nextId);
  await next.append(0, Buffer.from('a'));
  await next.commit({ ...evidence, receivedParts: 1 });
  const nextDir = path.join(store.root, (await readdir(store.root)).find(n => n !== path.basename(dir) && !n.endsWith('-old')));
  const part = path.join(nextDir, 'part-0.bin');
  await rm(part);
  await writeFile(path.join(outside, 'secret'), 'a');
  await symlink(path.join(outside, 'secret'), part);
  await assert.rejects(store.readPart(nextId, 0), /Unsafe cache file/);
});
test('read validates part integrity, bounded metadata and identity', async t => {
  const { store, generation } = await fixture(t);
  await ready(store);
  const dir = await generation();
  await writeFile(path.join(dir, 'part-0.bin'), 'wrong');
  await assert.rejects(store.readPart(id, 0), /Corrupt/);
  await truncate(path.join(dir, 'part-1.bin'), MAX_PART_BYTES + 1);
  await assert.rejects(store.readPart(id, 1), /size/);
  await assert.rejects(store.readPart(id, -1), /sequence/);
  const manifest = await store.readManifest(id);
  manifest.snapshot.fileKey = 'other';
  await writeFile(path.join(dir, 'ready.json'), JSON.stringify(manifest));
  await assert.rejects(store.readManifest(id), /identity/);
  await truncate(path.join(dir, 'ready.json'), 3 * 1024 * 1024);
  await assert.rejects(store.readManifest(id), /size/);
});
test('ordinary directory replacement is detected and incomplete metadata stays unreadable', async t => {
  const { store, generation } = await fixture(t);
  const writer = await store.begin(id);
  const dir = await generation();
  await writeFile(path.join(dir, 'manifest.tmp'), '{"status":"ready"}');
  await assert.rejects(store.readManifest(id), /ENOENT/);
  await rename(dir, `${dir}-old`);
  await mkdir(dir);
  await assert.rejects(writer.append(0, Buffer.from('a')), /replaced/);
  assert.equal(writer.state.status, 'error');
  await rename(store.root, `${store.root}-old`);
  await mkdir(store.root);
  await assert.rejects(store.begin({ ...id, generation: 2 }), /replaced/);
});
test('missing parts and symlinked manifests fail explicitly', async t => {
  const { store, generation, project } = await fixture(t);
  await ready(store);
  const dir = await generation();
  await rm(path.join(dir, 'part-0.bin'));
  await assert.rejects(store.readPart(id, 0), /ENOENT/);
  const saved = path.join(project, 'saved-manifest');
  await rename(path.join(dir, 'ready.json'), saved);
  await symlink(saved, path.join(dir, 'ready.json'));
  await assert.rejects(store.readManifest(id), /Unsafe cache file/);
});

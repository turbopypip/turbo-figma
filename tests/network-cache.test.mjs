import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, utimes, symlink, truncate, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { NetworkStore, CACHE_RETENTION } from '../dist/network-store.js';
const id = { fileKey: 'file1', sessionId: 'session1', generation: 1 };
const frame = { pageId: '1:1', frameId: '2:2' };
const evidence = { schemaReceived: true, joinStarted: true, joinEnded: true, receivedParts: 1, droppedParts: 0, sequenceComplete: true };
async function fixture(t) {
  const project = await mkdtemp(path.join(tmpdir(), 'figma-retention-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = await NetworkStore.create(project);
  return { project, store };
}
async function save(store, snapshot = id, selection = frame, value = 'frame data') {
  const writer = await store.begin(snapshot, selection);
  await writer.append(0, Buffer.from(value));
  await writer.commit(evidence);
}
async function directories(store) {
  return Promise.all((await readdir(store.root)).filter(n => /^[a-f0-9]{64}$/.test(n)).map(async name => {
    const directory = path.join(store.root, name);
    return { directory, owner: JSON.parse(await readFile(path.join(directory, 'capture.json'), 'utf8')) };
  }));
}
test('frame cache isolates files, pages, frames and snapshot generations', async t => {
  const { store } = await fixture(t);
  const samples = [
    [id, frame, 'first'], [id, { ...frame, pageId: '1:3' }, 'other page'],
    [{ ...id, fileKey: 'otherFile' }, frame, 'other file'], [id, { ...frame, frameId: '2:3' }, 'other frame'],
    [{ ...id, generation: 2 }, frame, 'new generation'],
  ];
  for (const sample of samples) await save(store, ...sample);
  for (const [snapshot, selection, value] of samples) assert.equal((await store.readPart(snapshot, 0, selection)).toString(), value);
  await assert.rejects(store.readPart(id, 0), /ENOENT/); // File-wide capture is a distinct namespace.
  for (const bad of [{ ...frame, pageId: '../x' }, { frameId: frame.frameId }, { ...frame, frameId: '' }]) {
    await assert.rejects(store.begin(id, bad));
  }
  const result = await store.clean('prune');
  assert.equal(result.removedGenerations, 1);
  await assert.rejects(store.readPart(id, 0, frame), /ENOENT/);
  assert.equal((await store.readPart(id, 0, { ...frame, pageId: '1:3' })).toString(), 'other page');
});
test('clear is confined to owned cache and allows recreation without deleting settings or assets', async t => {
  const { project, store } = await fixture(t);
  assert.equal(store.root, path.join(await realpath(project), '.cache', 'figma-network'));
  await mkdir(path.join(project, '.local'));
  await writeFile(path.join(project, '.local', 'config.json'), 'secret settings');
  await writeFile(path.join(project, '.cache', 'export.png'), 'export');
  await writeFile(path.join(store.root, 'unknown.txt'), 'keep me');
  await save(store);
  const before = await store.info();
  assert.equal(before.generations, 1); assert.ok(before.bytes > 10); assert.equal(before.protectedEntries, 1);
  const result = await store.clean();
  assert.equal(result.removedBytes, before.bytes); assert.equal(result.removedGenerations, 1);
  assert.equal((await store.info()).generations, 0);
  assert.equal(await readFile(path.join(project, '.local', 'config.json'), 'utf8'), 'secret settings');
  assert.equal(await readFile(path.join(project, '.cache', 'export.png'), 'utf8'), 'export');
  assert.equal(await readFile(path.join(store.root, 'unknown.txt'), 'utf8'), 'keep me');
  await save(store, { ...id, generation: 2 });
  assert.equal((await store.readPart({ ...id, generation: 2 }, 0, frame)).toString(), 'frame data');
});
test('cleanup and next capture cannot interrupt multi-part reads or writers across instances', async t => {
  const { project, store } = await fixture(t);
  await save(store);
  const second = await NetworkStore.create(project);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const reading = store.withRead(async () => {
    await store.readPart(id, 0, frame); entered(); await barrier;
    return store.readPart(id, 0, frame);
  });
  await started;
  await assert.rejects(second.clean(), /BUSY/);
  await assert.rejects(second.begin({ ...id, generation: 2 }), /BUSY/);
  release(); assert.equal((await reading).toString(), 'frame data');
  const writer = await store.begin({ ...id, generation: 2 }, frame);
  await assert.rejects(second.clean(), /BUSY/);
  await assert.rejects(second.withRead(async () => {}), /BUSY/);
  await writer.abort();
  await second.clean();
  assert.equal((await store.info()).generations, 0);
  await assert.rejects(store.withRead(async () => { throw new Error('reader failed'); }), /reader failed/);
  await second.clean(); // Reader failure must release the lease too.
});
test('retention removes incomplete, expired and oversized data; latest is retained per selection', async t => {
  const { store } = await fixture(t);
  await save(store);
  const first = (await directories(store))[0].directory;
  const old = new Date(Date.now() - CACHE_RETENTION.maxAgeMs - 10000);
  await utimes(path.join(first, 'ready.json'), old, old);
  assert.equal((await store.clean('prune')).removedGenerations, 1);
  const incomplete = await store.begin({ ...id, generation: 2 }, frame);
  await incomplete.append(0, Buffer.from('partial')); await incomplete.abort();
  assert.equal((await store.info()).incomplete, 1);
  // Starting a new capture also prunes an abandoned previous one.
  await save(store, { ...id, generation: 3 });
  assert.equal((await store.info()).generations, 1);
  const dir = (await directories(store))[0].directory;
  // Sparse file verifies the byte budget without allocating gigabytes of RAM/disk blocks.
  await truncate(path.join(dir, 'part-0.bin'), CACHE_RETENTION.maxBytes + 1);
  assert.equal((await store.clean('prune')).removedGenerations, 1);
});
test('unknown files, unowned directories and symlinks are protected, never recursively removed', async t => {
  const { project, store } = await fixture(t);
  await save(store);
  const dir = (await directories(store))[0].directory;
  await writeFile(path.join(dir, 'export.svg'), 'asset');
  const unowned = path.join(store.root, 'f'.repeat(64));
  await mkdir(unowned); await writeFile(path.join(unowned, 'part-0.bin'), 'not ours');
  const outside = path.join(project, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'private'), 'keep');
  await symlink(outside, path.join(store.root, 'e'.repeat(64)), 'dir');
  const result = await store.clean();
  assert.equal(result.removedGenerations, 0); assert.equal(result.protectedEntries, 3);
  assert.equal(await readFile(path.join(dir, 'export.svg'), 'utf8'), 'asset');
  assert.equal(await readFile(path.join(unowned, 'part-0.bin'), 'utf8'), 'not ours');
  assert.equal(await readFile(path.join(outside, 'private'), 'utf8'), 'keep');
});

test('retention breaks equal filesystem timestamps by generation number', async t => {
  const { store } = await fixture(t);
  await save(store);
  await save(store, { ...id, generation: 2 });
  const timestamp = new Date();
  for (const { directory } of await directories(store)) await utimes(path.join(directory, 'ready.json'), timestamp, timestamp);
  await store.clean('prune');
  await assert.rejects(store.readPart(id, 0, frame), /ENOENT/);
  assert.equal((await store.readPart({ ...id, generation: 2 }, 0, frame)).toString(), 'frame data');
});

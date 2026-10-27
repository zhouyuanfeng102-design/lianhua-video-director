import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStateStore } = require('../electron/statePersistenceStore.cjs');
const { createStatePersistence } = require('../electron/statePersistence.cjs');
const { stateChecksum } = require('../electron/stateSerialization.cjs');
const keepVault = async () => ({ mode: 'keep' });
const project = (id) => ({ id, name: id, description: `preserve ${id}`, createdAt: 1, updatedAt: 2,
  sourceDocuments: [{ id: `doc-${id}`, content: 'synthetic original' }], scenes: [], storyboards: [], assets: [], generationTasks: [] });
const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-compact-library-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('lianhua-compact-library-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let reads = 0;
  const countedFs = new Proxy(fs, { get(target, property) {
    if (property === 'readFileSync') return (file, ...args) => {
      if (path.basename(path.dirname(String(file))) === 'project-library') reads += 1;
      return fs.readFileSync(file, ...args);
    };
    return Reflect.get(target, property);
  } });
  const makeStore = () => createStateStore({ dataRoot: root, fs: countedFs });
  const current = project('active');
  const state = { schemaVersion: 6, project: current, projects: [{ id: current.id, __activeProjectReference: true }, project('other')],
    activeProjectId: current.id, settings: {} };
  return { root, state, store: makeStore(), makeStore, resetReads: () => { reads = 0; }, reads: () => reads,
    manifest: () => JSON.parse(fs.readFileSync(path.join(root, 'project-state.json'), 'utf8')) };
};
const refFor = (full) => ({ id: full.id, name: full.name, description: full.description, createdAt: full.createdAt, updatedAt: full.updatedAt,
  __projectLibraryReference: { hash: full.__persistedProjectHash, schemaVersion: full.__projectSchemaVersion,
    counts: Object.fromEntries(['sourceDocuments', 'scenes', 'storyboards', 'assets'].map((key) => [key, full[key]?.length || 0])) } });

test('warm startup reads only current and unfinished-task bodies; project summaries remain immediately available', async (t) => {
  const h = fixture(t);
  for (let i = 2; i < 100; i++) h.state.projects.push(project(`project-${i}`));
  h.state.projects[2].generationTasks = [{ id: 'pending', kind: 'video', status: 'succeeded', resultUrl: 'https://invalid.test/video' }];
  await h.store.save(JSON.stringify(h.state), keepVault);
  const store = h.makeStore();
  h.resetReads();
  const loaded = JSON.parse(store.loadWorkspace(null).content);
  assert.equal(loaded.projects.length, 100);
  assert.equal(loaded.projects.filter((item) => item.__projectLibraryReference).length, 98);
  assert.equal(loaded.projects[1].__projectLibraryReference.counts.sourceDocuments, 1);
  assert.equal(loaded.projects[2].generationTasks[0].id, 'pending');
  assert.equal(h.reads(), 2);
  const selected = store.loadProject('other', loaded.projects[1].__projectLibraryReference.hash);
  assert.equal(selected.project.sourceDocuments[0].content, 'synthetic original');
  assert.equal(selected.schemaVersion, 6);
  assert.equal(h.reads(), 3);
});

test('missing or damaged summary cache is rebuilt without changing project bodies or the committed manifest', async (t) => {
  const h = fixture(t);
  await h.store.save(JSON.stringify(h.state), keepVault);
  const manifest = fs.readFileSync(path.join(h.root, 'project-state.json'), 'utf8');
  const other = h.manifest().projects[1];
  fs.writeFileSync(path.join(h.root, 'project-library-index', `${other.hash}.6.json`), 'damaged cache');
  const loaded = JSON.parse(h.makeStore().loadWorkspace(null).content);
  assert.equal(loaded.projects[1].name, 'other');
  assert.equal(loaded.projects[1].__projectLibraryReference.counts.sourceDocuments, 1);
  assert.equal(fs.readFileSync(path.join(h.root, 'project-state.json'), 'utf8'), manifest);
});

test('saving compact references reads no unchanged bodies and never overwrites unloaded project content', async (t) => {
  const h = fixture(t);
  await h.store.save(JSON.stringify(h.state), keepVault);
  const store = h.makeStore();
  const loaded = JSON.parse(store.loadWorkspace(null).content);
  loaded.project = refFor(loaded.project);
  loaded.settings.theme = 'dark';
  h.resetReads();
  const saved = await store.save(JSON.stringify(loaded), keepVault);
  assert.equal(h.reads(), 0);
  assert.equal(saved.projectHashes.other, loaded.projects[1].__projectLibraryReference.hash);
  const restored = JSON.parse(store.load(null).content);
  assert.deepEqual(restored.projects[1], h.state.projects[1]);
  assert.equal(restored.settings.theme, 'dark');
});

test('tampered/unknown references and reference-body mixtures fail without replacing committed state', async (t) => {
  const h = fixture(t);
  await h.store.save(JSON.stringify(h.state), keepVault);
  const loaded = JSON.parse(h.store.loadWorkspace(null).content);
  const before = fs.readFileSync(path.join(h.root, 'project-state.json'), 'utf8');
  for (const mutate of [
    (item) => { item.name = 'unloaded edit'; },
    (item) => { item.__projectLibraryReference.hash = '0'.repeat(64); },
    (item) => { item.__projectLibraryReference.schemaVersion = 99; },
    (item) => { item.sourceDocuments = [{ id: 'overwrite', content: 'must reject' }]; },
  ]) {
    const copy = structuredClone(loaded);
    mutate(copy.projects[1]);
    await assert.rejects(h.store.save(JSON.stringify(copy), keepVault));
    assert.equal(fs.readFileSync(path.join(h.root, 'project-state.json'), 'utf8'), before);
  }
  const pointer = h.manifest().projects[1];
  fs.writeFileSync(path.join(h.root, 'project-library', `${pointer.hash}.json`), 'corrupted after startup');
  await assert.rejects(h.store.save(JSON.stringify(loaded), keepVault), /完整性/u);
  assert.equal(fs.readFileSync(path.join(h.root, 'project-state.json'), 'utf8'), before);
});

test('light recovery reads zero bodies and full recovery verifies each shared block once across snapshots', async (t) => {
  const h = fixture(t);
  await h.store.save(JSON.stringify(h.state), keepVault);
  const raw = fs.readFileSync(path.join(h.root, 'project-state.json'), 'utf8');
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(h.root, 'project-snapshots', `project-shared-${i}.json`), raw);
  h.resetReads();
  const light = h.store.recoveryStatus({ light: true });
  assert.equal(light.validation, 'pending');
  assert.ok(light.snapshots.every((item) => item.validation === 'pending' && !item.valid));
  assert.equal(h.reads(), 0);
  const full = h.store.recoveryStatus();
  assert.equal(full.validation, 'valid');
  assert.ok(full.snapshots.every((item) => item.valid));
  assert.equal(h.reads(), 2);
});

test('per-project migration versions survive a mixed-version save, full load and snapshot restoration', async (t) => {
  const h = fixture(t);
  await h.store.save(JSON.stringify(h.state), keepVault);
  const compact = JSON.parse(h.store.loadWorkspace(null).content);
  compact.schemaVersion = 24;
  compact.project.__projectSchemaVersion = 24;
  compact.project.description = 'current project migrated';
  await h.store.save(JSON.stringify(compact), keepVault);
  const manifest = h.manifest();
  assert.equal(manifest.project.schemaVersion, 24);
  assert.equal(manifest.projects[1].schemaVersion, 6);
  const snapshot = h.store.createRestorePoint(JSON.stringify(compact));
  const full = JSON.parse(h.store.load(null).content);
  assert.equal(full.projects[1].__projectSchemaVersion, 6);
  const restored = JSON.parse(h.store.restoreSnapshot(path.basename(snapshot.path), null));
  assert.equal(restored.projects[1].__projectSchemaVersion, 6);
  assert.equal(h.manifest().projects[1].schemaVersion, 6);
});

test('compact saves retain inactive project content without writing cross-drive backups', async (t) => {
  const h = fixture(t);
  await h.store.save(JSON.stringify(h.state), keepVault);
  const compact = JSON.parse(h.store.loadWorkspace(null).content);
  const backupDirectory = path.join(h.root, 'backup');
  fs.writeFileSync(path.join(h.root, 'recovery-config.json'), JSON.stringify({ backupDirectory, backupOnSave: true }));
  const saved = await h.store.save(JSON.stringify(compact), keepVault);
  assert.equal(saved.ok, true);
  const full = JSON.parse(h.store.load(null).content);
  assert.deepEqual(full.projects[1], h.state.projects[1]);
  assert.equal(fs.existsSync(backupDirectory), false);
});
test('ordered worker dispatch exposes compact startup, project hydration and light status operations', async (t) => {
  const h = fixture(t);
  const persistence = createStatePersistence({ dataRoot: h.root, encryptSecrets: keepVault });
  try {
    await persistence.run('save', { content: JSON.stringify(h.state) });
    const compact = JSON.parse((await persistence.run('load-workspace')).content);
    assert.ok(compact.projects[1].__projectLibraryReference);
    const loaded = await persistence.run('load-project', { projectId: 'other', hash: compact.projects[1].__projectLibraryReference.hash });
    assert.equal(loaded.project.sourceDocuments[0].content, 'synthetic original');
    assert.equal(loaded.schemaVersion, 6);
    assert.equal((await persistence.run('status', { light: true })).validation, 'pending');
  } finally { await persistence.close(); }
});

test('startup keeps ambiguous remote, batch continuation and pending image/result selection projects hydrated', async (t) => {
  const h = fixture(t);
  const work = [
    { status: 'unknown', remoteTaskId: 'remote' },
    { status: 'succeeded', videoJob: { stage: 'succeeded', resultAssetIds: ['a', 'b'] } },
    { status: 'failed', videoJob: { stage: 'failed', batchContinuation: { planId: 'continue' } } },
    { kind: 'image', status: 'succeeded', customImageSavePending: true },
  ];
  h.state.projects.push(...work.map((task, i) => ({ ...project(`work-${i}`), generationTasks: [{ id: `task-${i}`, ...task }] })));
  await h.store.save(JSON.stringify(h.state), keepVault);
  const compact = JSON.parse(h.makeStore().loadWorkspace(null).content);
  for (const loaded of compact.projects.slice(2)) assert.equal(loaded.generationTasks.length, 1);
  assert.ok(compact.projects[1].__projectLibraryReference);
});

test('legacy incomplete metadata and old summary caches normalize without modifying immutable project bodies', async (t) => {
  const h = fixture(t);
  const legacy = h.state.projects[1];
  delete legacy.name;
  legacy.description = null;
  legacy.createdAt = 'legacy-invalid-time';
  delete legacy.updatedAt;
  legacy.backgroundSuspended = 'legacy-false';
  await h.store.save(JSON.stringify(h.state), keepVault);
  const pointer = h.manifest().projects[1];
  const block = path.join(h.root, 'project-library', `${pointer.hash}.json`);
  const original = fs.readFileSync(block, 'utf8');
  const summaryFile = path.join(h.root, 'project-library-index', `${pointer.hash}.6.json`);
  const { checksum: oldChecksum, ...cache } = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  cache.storageFormat = 'lianhua-project-summary-v1';
  cache.summary = { id: legacy.id };
  fs.writeFileSync(summaryFile, JSON.stringify({ ...cache, checksum: stateChecksum(JSON.stringify(cache)) }));
  const store = h.makeStore();
  const loaded = JSON.parse(store.loadWorkspace(null).content);
  const reference = loaded.projects[1];
  assert.equal(reference.name, '');
  assert.equal(reference.description, '');
  assert.equal(reference.createdAt, 0);
  assert.equal(reference.updatedAt, 0);
  assert.equal(reference.backgroundSuspended, false);
  const result = await store.save(JSON.stringify(loaded), keepVault);
  assert.equal(result.projectHashes.other, pointer.hash);
  assert.equal(fs.readFileSync(block, 'utf8'), original);
  assert.equal(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).storageFormat, 'lianhua-project-summary-v2');
  reference.name = 'must reject';
  await assert.rejects(store.save(JSON.stringify(loaded), keepVault), /项目 ID：other；字段：name/u);
});

test('startup hydrates archived workbench projects with interrupted local jobs', async (t) => {
  const h = fixture(t);
  h.state.projects[1].videoWorkbench = { jobs: [{ id: 'local-job', status: 'running' }] };
  h.state.projects.push({ ...project('finished-workbench'), videoWorkbench: { jobs: [{ id: 'finished-job', status: 'succeeded' }] } });
  await h.store.save(JSON.stringify(h.state), keepVault);
  const loaded = JSON.parse(h.makeStore().loadWorkspace(null).content);
  assert.equal(loaded.projects[1].videoWorkbench.jobs[0].status, 'running');
  assert.ok(!loaded.projects[1].__projectLibraryReference);
  assert.ok(loaded.projects[2].__projectLibraryReference);
});

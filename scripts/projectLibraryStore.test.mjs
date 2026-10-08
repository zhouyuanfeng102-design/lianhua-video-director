import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStateStore, atomicWriteFile } = require('../electron/statePersistenceStore.cjs');
const { readProjectLibrary, writeProjectLibrary, PROJECT_LIBRARY_FORMAT } = require('../electron/projectLibraryStore.cjs');
const { prepareStateForSave, stateChecksum } = require('../electron/stateSerialization.cjs');
const keepVault = async () => ({ mode: 'keep' });
const state = (description = 'active', other = 'unchanged') => ({
  project: { id: 'active', description, shots: [{ id: 'shot', finalPrompt: '原稿 English 中文' }], assets: [] },
  projects: [{ id: 'active', __activeProjectReference: true }, { id: 'other', description: other, assets: [] }],
  activeProjectId: 'active', settings: {}, arbitraryMetadata: { preserved: true },
});
const content = (...args) => JSON.stringify(state(...args));
const setup = (t, options = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-project-library-'));
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot);
  t.after(() => {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('lianhua-project-library-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const file = path.join(dataRoot, 'project-state.json');
  return { root, dataRoot, file, store: createStateStore({ dataRoot, ...options }) };
};

test('library writes independent immutable project blocks and preserves the exact logical state', async (t) => {
  const h = setup(t);
  const source = content('active '.repeat(20000));
  await h.store.save(source, keepVault);
  const raw = fs.readFileSync(h.file, 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.storageFormat, PROJECT_LIBRARY_FORMAT);
  assert.ok(Buffer.byteLength(raw) < 2000, 'index must not contain project text');
  assert.equal(manifest.project.id, 'active');
  assert.equal(manifest.projects.length, 2);
  assert.equal(manifest.projects[0].hash, manifest.project.hash, 'active reference reuses the full project block');
  assert.deepEqual(readProjectLibrary(raw, { root: h.dataRoot }), JSON.parse(source));
  assert.deepEqual(JSON.parse(h.store.load(null).content), JSON.parse(source));
  const status = h.store.recoveryStatus();
  assert.equal(status.stateValid, true);
  assert.ok(status.stateSize > status.indexSize * 10);
  assert.equal(status.storageFormat, PROJECT_LIBRARY_FORMAT);
});

test('an unchanged project is not rewritten when another project or root settings changes', async (t) => {
  const h = setup(t);
  await h.store.save(content(), keepVault);
  const first = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  const inactiveBlock = path.join(h.dataRoot, 'project-library', `${first.projects[1].hash}.json`);
  fs.utimesSync(inactiveBlock, new Date(1000), new Date(1000));
  const next = state('changed active');
  next.settings.theme = 'light';
  await h.store.save(JSON.stringify(next), keepVault);
  const second = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  assert.notEqual(first.project.hash, second.project.hash);
  assert.equal(first.projects[1].hash, second.projects[1].hash);
  assert.equal(fs.statSync(inactiveBlock).mtimeMs, 1000);
  assert.ok(fs.existsSync(path.join(h.dataRoot, 'project-library', `${first.project.hash}.json`)), 'old snapshot block remains');
});

test('legacy migration keeps the original bytes once and never changes old snapshots', async (t) => {
  const h = setup(t);
  const legacy = prepareStateForSave(content('legacy'), 123).payload;
  fs.writeFileSync(h.file, legacy);
  fs.mkdirSync(path.join(h.dataRoot, 'project-snapshots'));
  const oldSnapshot = path.join(h.dataRoot, 'project-snapshots', 'project-old.json');
  fs.writeFileSync(oldSnapshot, legacy);
  assert.equal(JSON.parse(h.store.load(null).content).project.description, 'legacy');
  await h.store.save(content('new'), keepVault);
  const preserved = path.join(h.dataRoot, 'project-state.legacy-original.json');
  assert.equal(fs.readFileSync(preserved, 'utf8'), legacy);
  assert.equal(fs.readFileSync(oldSnapshot, 'utf8'), legacy);
  await h.store.save(content('later'), keepVault);
  assert.equal(fs.readFileSync(preserved, 'utf8'), legacy);
});

test('a failed legacy-preservation write cannot switch the main state to the new format', async (t) => {
  const h = setup(t);
  const legacy = prepareStateForSave(content('legacy')).payload;
  fs.writeFileSync(h.file, legacy);
  const proxy = new Proxy(fs, { get(target, name) {
    if (name === 'renameSync') return (from, to) => {
      if (to.endsWith('project-state.legacy-original.json')) throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
      return fs.renameSync(from, to);
    };
    return Reflect.get(target, name);
  } });
  const store = createStateStore({ dataRoot: h.dataRoot, fs: proxy });
  await assert.rejects(store.save(content('new'), keepVault), /ENOSPC/u);
  assert.equal(fs.readFileSync(h.file, 'utf8'), legacy);
  assert.equal(JSON.parse(store.load(null).content).project.description, 'legacy');
});

test('project block write failure leaves committed manifest and all previous prompts unchanged', async (t) => {
  const h = setup(t);
  await h.store.save(content('old'), keepVault);
  const before = fs.readFileSync(h.file, 'utf8');
  const proxy = new Proxy(fs, { get(target, name) {
    if (name === 'renameSync') return (from, to) => {
      if (path.dirname(to) === path.join(h.dataRoot, 'project-library') && from.endsWith('.tmp')) {
        throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
      }
      return fs.renameSync(from, to);
    };
    return Reflect.get(target, name);
  } });
  const store = createStateStore({ dataRoot: h.dataRoot, fs: proxy });
  await assert.rejects(store.save(content('new'), keepVault), /ENOSPC/u);
  assert.equal(fs.readFileSync(h.file, 'utf8'), before);
  assert.deepEqual(JSON.parse(store.load(null).content), state('old'));
});

test('manifest rename failure rolls back both state and its changed encrypted vault', async (t) => {
  const h = setup(t);
  await h.store.save(content('old'), async () => ({ mode: 'write', encrypted: Buffer.from('vault-old') }));
  const before = fs.readFileSync(h.file, 'utf8');
  const proxy = new Proxy(fs, { get(target, name) {
    if (name === 'renameSync') return (from, to) => {
      if (to === h.file && from.endsWith('.tmp')) throw Object.assign(new Error('fixture locked'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    };
    return Reflect.get(target, name);
  } });
  const store = createStateStore({ dataRoot: h.dataRoot, fs: proxy });
  await assert.rejects(store.save(content('new'), async () => ({ mode: 'write', encrypted: Buffer.from('vault-new') })), /EPERM/u);
  assert.equal(fs.readFileSync(h.file, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(h.dataRoot, 'credentials.safe'), 'utf8'), 'vault-old');
  assert.equal(fs.existsSync(path.join(h.dataRoot, 'state-vault-transaction.json')), false);
});

test('snapshots restore independent project blocks after current projects are removed', async (t) => {
  const h = setup(t);
  const snapshot = h.store.createRestorePoint(content('old-active', 'old-other'));
  const next = state('new');
  next.projects = [];
  await h.store.save(JSON.stringify(next), keepVault);
  const restored = JSON.parse(h.store.restoreSnapshot(path.basename(snapshot.path), null));
  assert.deepEqual(restored, state('old-active', 'old-other'));
  assert.deepEqual(JSON.parse(h.store.load(null).content), restored);
  assert.ok(h.store.recoveryStatus().snapshots.every((item) => item.valid));
});

test('legacy snapshot restoration migrates its representation but preserves the snapshot original', async (t) => {
  const h = setup(t);
  fs.mkdirSync(path.join(h.dataRoot, 'project-snapshots'));
  const raw = prepareStateForSave(content('old-snapshot'), 123).payload;
  const file = path.join(h.dataRoot, 'project-snapshots', 'project-legacy.json');
  fs.writeFileSync(file, raw);
  const restored = JSON.parse(h.store.restoreSnapshot(path.basename(file), null));
  assert.equal(restored.project.description, 'old-snapshot');
  assert.equal(JSON.parse(fs.readFileSync(h.file, 'utf8')).storageFormat, PROJECT_LIBRARY_FORMAT);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('missing/corrupted project blocks are rejected; a complete earlier snapshot is used without rewriting files', async (t) => {
  const h = setup(t);
  await h.store.save(content('snapshot-good'), keepVault);
  await h.store.save(content('current-corrupt'), keepVault);
  const before = fs.readFileSync(h.file, 'utf8');
  const current = JSON.parse(before);
  fs.writeFileSync(path.join(h.dataRoot, 'project-library', `${current.project.hash}.json`), '{"id":"active","description":"tampered"}');
  assert.throws(() => readProjectLibrary(before, { root: h.dataRoot }), /完整性/u);
  const loaded = h.store.load(null);
  assert.equal(JSON.parse(loaded.content).project.description, 'snapshot-good');
  assert.match(loaded.notice, /恢复点/u);
  assert.equal(fs.readFileSync(h.file, 'utf8'), before);
  assert.equal(h.store.recoveryStatus().stateValid, false);
});

test('manifest pointer traversal and symlinks outside the project directory are rejected', (t) => {
  const h = setup(t);
  const made = writeProjectLibrary(state(), { root: h.dataRoot, writeFile: atomicWriteFile });
  const broken = JSON.parse(made.payload);
  broken.project.hash = '../outside';
  delete broken.integrity;
  broken.integrity = { algorithm: 'sha256', checksum: stateChecksum(JSON.stringify(broken)), savedAt: 1 };
  assert.throws(() => readProjectLibrary(JSON.stringify(broken), { root: h.dataRoot }), /校验值/u);
  const outside = path.join(h.root, 'outside');
  fs.mkdirSync(outside);
  const linkedRoot = path.join(h.root, 'linked');
  fs.mkdirSync(linkedRoot);
  try { fs.symlinkSync(outside, path.join(linkedRoot, 'project-library'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.diagnostic('Symlink unavailable; pointer traversal verified'); throw error; }
  assert.throws(() => writeProjectLibrary(state(), { root: linkedRoot, writeFile: atomicWriteFile }), /越界/u);
});

test('external backup is self-contained with project blocks, media and secret-free manifests', async (t) => {
  const h = setup(t);
  const backupDirectory = path.join(h.root, 'backup');
  fs.writeFileSync(path.join(h.dataRoot, 'recovery-config.json'), JSON.stringify({ backupDirectory }));
  fs.mkdirSync(path.join(h.dataRoot, 'assets'));
  fs.writeFileSync(path.join(h.dataRoot, 'assets', 'fixture.png'), 'synthetic-bytes');
  const source = state();
  source.project.assets = [{ id: 'fixture', relativePath: 'fixture.png' }];
  source.settings.imageApi = { apiKey: 'secret-must-stay-outside-json' };
  const result = await h.store.save(JSON.stringify(source), keepVault);
  assert.equal(result.backupError, '');
  const backupRoot = path.dirname(result.externalBackup);
  const saved = readProjectLibrary(fs.readFileSync(result.externalBackup, 'utf8'), { root: backupRoot });
  assert.equal(saved.settings.imageApi.apiKey, '');
  assert.equal(saved.project.shots[0].finalPrompt, source.project.shots[0].finalPrompt);
  assert.equal(fs.readFileSync(path.join(backupRoot, 'assets', 'fixture.png'), 'utf8'), 'synthetic-bytes');
  const integrity = JSON.parse(fs.readFileSync(path.join(backupRoot, 'backup-integrity.json'), 'utf8'));
  assert.equal(integrity.stateChecksum, result.checksum);
  assert.equal(integrity.projectFiles.length, 2);
  assert.ok(integrity.assets.every((item) => !item.missing));
});

test('external backup block failure preserves its prior manifest and still confirms local save', async (t) => {
  const h = setup(t);
  const backupDirectory = path.join(h.root, 'backup');
  fs.writeFileSync(path.join(h.dataRoot, 'recovery-config.json'), JSON.stringify({ backupDirectory }));
  const first = await h.store.save(content('old'), keepVault);
  const oldBackup = fs.readFileSync(first.externalBackup, 'utf8');
  const backupRoot = path.dirname(first.externalBackup);
  const oldIntegrity = fs.readFileSync(path.join(backupRoot, 'backup-integrity.json'), 'utf8');
  const proxy = new Proxy(fs, { get(target, name) {
    if (name === 'renameSync') return (from, to) => {
      if (to.startsWith(path.join(backupRoot, 'project-library'))) throw Object.assign(new Error('fixture backup full'), { code: 'ENOSPC' });
      return fs.renameSync(from, to);
    };
    return Reflect.get(target, name);
  } });
  const store = createStateStore({ dataRoot: h.dataRoot, fs: proxy });
  const result = await store.save(content('new'), keepVault);
  assert.equal(result.ok, true);
  assert.match(result.backupError, /ENOSPC/u);
  assert.equal(JSON.parse(store.load(null).content).project.description, 'new');
  assert.equal(fs.readFileSync(first.externalBackup, 'utf8'), oldBackup);
  assert.equal(fs.readFileSync(path.join(backupRoot, 'backup-integrity.json'), 'utf8'), oldIntegrity);
});

test('automatic snapshot failure reports a backup warning without claiming the durable local save failed', async (t) => {
  const h = setup(t);
  const proxy = new Proxy(fs, { get(target, name) {
    if (name === 'renameSync') return (from, to) => {
      if (path.dirname(to) === path.join(h.dataRoot, 'project-snapshots')) throw Object.assign(new Error('fixture snapshots locked'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    };
    return Reflect.get(target, name);
  } });
  const store = createStateStore({ dataRoot: h.dataRoot, fs: proxy });
  const saved = await store.save(content('saved'), keepVault);
  assert.equal(saved.ok, true);
  assert.match(saved.snapshotError, /EPERM/u);
  assert.equal(JSON.parse(store.load(null).content).project.description, 'saved');
});

test('backup media copy failure preserves its previous complete manifest and reports the failed backup', async (t) => {
  const h = setup(t);
  const backupDirectory = path.join(h.root, 'backup');
  fs.writeFileSync(path.join(h.dataRoot, 'recovery-config.json'), JSON.stringify({ backupDirectory }));
  fs.mkdirSync(path.join(h.dataRoot, 'assets'));
  fs.writeFileSync(path.join(h.dataRoot, 'assets', 'first.png'), 'first-fixture');
  fs.writeFileSync(path.join(h.dataRoot, 'assets', 'second.png'), 'second-fixture');
  const before = state('first');
  before.project.assets = [{ id: 'first', relativePath: 'first.png' }];
  const first = await h.store.save(JSON.stringify(before), keepVault);
  assert.equal(first.backupError, '');
  const backupRoot = path.dirname(first.externalBackup);
  const originalIntegrity = fs.readFileSync(path.join(backupRoot, 'backup-integrity.json'), 'utf8');
  const originalIndexes = fs.readdirSync(backupRoot).filter((name) => name.startsWith('project-latest-'));
  const proxy = new Proxy(fs, { get(target, name) {
    if (name === 'copyFileSync') return (source, destination, flags) => {
      if (destination.startsWith(path.join(backupRoot, 'assets'))) {
        fs.writeFileSync(destination, 'partial');
        throw Object.assign(new Error('fixture full while copying'), { code: 'ENOSPC' });
      }
      return fs.copyFileSync(source, destination, flags);
    };
    return Reflect.get(target, name);
  } });
  const store = createStateStore({ dataRoot: h.dataRoot, fs: proxy });
  const next = state('second');
  next.project.assets = [{ id: 'second', relativePath: 'second.png' }];
  const result = await store.save(JSON.stringify(next), keepVault);
  assert.equal(result.ok, true);
  assert.match(result.backupError, /ENOSPC/u);
  assert.equal(fs.readFileSync(path.join(backupRoot, 'backup-integrity.json'), 'utf8'), originalIntegrity);
  assert.deepEqual(fs.readdirSync(backupRoot).filter((name) => name.startsWith('project-latest-')), originalIndexes);
  assert.equal(fs.readFileSync(path.join(backupRoot, 'assets', 'first.png'), 'utf8'), 'first-fixture');
  assert.equal(fs.existsSync(path.join(backupRoot, 'assets', 'second.png')), false);
  assert.equal(fs.readdirSync(path.join(backupRoot, 'assets')).some((name) => name.endsWith('.tmp')), false);
  assert.equal(JSON.parse(store.load(null).content).project.description, 'second');
});

test('migration original is the final read-only fallback when all shared project blocks are damaged', async (t) => {
  const h = setup(t);
  const legacy = prepareStateForSave(content('before-upgrade')).payload;
  fs.writeFileSync(h.file, legacy);
  await h.store.save(content('after-upgrade'), keepVault);
  const manifest = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  fs.writeFileSync(path.join(h.dataRoot, 'project-library', `${manifest.project.hash}.json`), 'damaged');
  const rawMain = fs.readFileSync(h.file, 'utf8');
  const loaded = h.store.load(null);
  assert.equal(JSON.parse(loaded.content).project.description, 'before-upgrade');
  assert.match(loaded.notice, /首次升级前.*较旧/u);
  assert.equal(fs.readFileSync(h.file, 'utf8'), rawMain);
  assert.equal(fs.readFileSync(path.join(h.dataRoot, 'project-state.legacy-original.json'), 'utf8'), legacy);
});

test('an unreadable existing library rejects load instead of returning an empty startup state', (t) => {
  const h = setup(t);
  assert.deepEqual(h.store.load(null), { content: null, notice: '' });
  fs.writeFileSync(h.file, 'broken-existing-state');
  assert.throws(() => h.store.load(null), /停止自动建立空项目库/u);
  assert.equal(fs.readFileSync(h.file, 'utf8'), 'broken-existing-state');
});

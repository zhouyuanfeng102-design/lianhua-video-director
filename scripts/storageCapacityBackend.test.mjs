import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStatePersistence } = require('../electron/statePersistence.cjs');

const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const core = main.slice(main.indexOf('const MAX_STATE_BYTES ='), main.indexOf('const stripSecrets ='));
const saveStart = main.indexOf("handleTrustedIpc('lianhua:save-state'");
const saveHandler = main.slice(saveStart, main.indexOf("handleTrustedIpc('lianhua:recovery-status'", saveStart));
const loadStart = main.indexOf("handleTrustedIpc('lianhua:load-state'");
const loadHandler = main.slice(loadStart, saveStart);

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-state-capacity-'));
  const dataRoot = path.join(root, 'data');
  const assetRoot = path.join(dataRoot, 'assets');
  const snapshotRoot = path.join(dataRoot, 'project-snapshots');
  const stateFile = path.join(dataRoot, 'project-state.json');
  const recoveryConfigFile = path.join(dataRoot, 'recovery-config.json');
  for (const directory of [dataRoot, assetRoot, snapshotRoot]) fs.mkdirSync(directory, { recursive: true });
  const persistence = createStatePersistence({ dataRoot, encryptSecrets: () => ({ mode: 'keep' }) });
  t.after(async () => {
    await persistence.discard();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('lianhua-state-capacity-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const controls = { failWrite: false, failReplacement: false, failRestore: false, forcedByteLength: undefined };
  const fsProxy = new Proxy(fs, { get(target, property) {
    if (property === 'renameSync') return (from, to) => {
      if (controls.failReplacement && String(from).endsWith('.tmp')) throw Object.assign(new Error('EPERM: rename failed'), { code: 'EPERM' });
      if (controls.failRestore && String(from).endsWith('.previous')) throw Object.assign(new Error('EPERM: restore failed'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    };
    if (property === 'writeFileSync') return (file, content, ...args) => {
      if (controls.failWrite) {
        controls.failWrite = false;
        fs.writeFileSync(file, 'partial fixture');
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return fs.writeFileSync(file, content, ...args);
    };
    return Reflect.get(target, property);
  } });
  const handlers = new Map();
  const bufferProxy = new Proxy(Buffer, { get(target, property) {
    if (property === 'byteLength') return (...args) => controls.forcedByteLength ?? Buffer.byteLength(...args);
    return Reflect.get(target, property);
  } });
  const serializerContext = vm.createContext({ Buffer: bufferProxy, require, module: { exports: {} }, Error });
  vm.runInContext(fs.readFileSync(new URL('../electron/stateSerialization.cjs', import.meta.url), 'utf8'), serializerContext);
  const context = vm.createContext({
    fs: fsProxy, path, process: { pid: process.pid }, Error, Date, createHash, randomUUID,
    Buffer: bufferProxy,
    stateSerialization: serializerContext.module.exports,
    getStatePersistence: () => persistence,
    dataRoot, assetRoot, snapshotRoot, stateFile, recoveryConfigFile, lastSnapshotAt: 0, lastRecoveryNotice: '', startupRecoveryNotice: '',
    ensureDirectory: (directory) => { fs.mkdirSync(directory, { recursive: true }); return directory; },
    isSamePath: (left, right) => path.resolve(left) === path.resolve(right),
    isPathInside: (parent, child) => { const relative = path.relative(parent, child); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); },
    assetPathFromRelative: (relative) => path.join(assetRoot, relative),
    collectSecrets: () => ({}), secretCount: () => 0, saveSecrets: () => true,
    stripSecrets: (state) => JSON.parse(JSON.stringify(state)),
    hydrateSecrets: (state) => state,
    handleTrustedIpc: (name, handler) => { handlers.set(name, handler); },
  });
  vm.runInContext(`${core}\n${loadHandler}\n${saveHandler}\n;globalThis.helpers = { MAX_STATE_BYTES, MAX_IMAGE_EXPORT_BYTES, validateStateText, stateAssets, atomicWriteFile, writeExternalBackup };`, context);
  return {
    ...context.helpers, controls, root, dataRoot, assetRoot, snapshotRoot, stateFile, recoveryConfigFile,
    save: (...args) => handlers.get('lianhua:save-state')({}, ...args),
    load: () => handlers.get('lianhua:load-state')(),
  };
}

test('state limit is finite and independent from media limits, with actual size in errors', (t) => {
  const h = harness(t);
  assert.equal(h.MAX_STATE_BYTES, 256 * 1024 * 1024);
  assert.equal(h.MAX_IMAGE_EXPORT_BYTES, 64 * 1024 * 1024);
  const text = JSON.stringify({ project: { id: 'fixture' }, settings: {} });
  h.controls.forcedByteLength = h.MAX_STATE_BYTES;
  assert.equal(h.validateStateText(text).project.id, 'fixture');
  h.controls.forcedByteLength = h.MAX_STATE_BYTES + 1;
  assert.throws(() => h.validateStateText(text), /256\.0 MiB，超过 256 MiB.*现有文件和素材未被删除/u);
  assert.equal(fs.existsSync(h.stateFile), false);
});

test('real 65 MiB state saves, reloads and produces a valid local recovery snapshot', async (t) => {
  const h = harness(t);
  const description = 'x'.repeat(65 * 1024 * 1024);
  const content = JSON.stringify({ project: { id: 'large-fixture', description }, projects: [{ id: 'large-fixture', __activeProjectReference: true }], settings: {} });
  assert.ok(Buffer.byteLength(content) > 64 * 1024 * 1024);
  const result = await h.save(content);
  assert.equal(result.ok, true);
  const saved = fs.readFileSync(h.stateFile, 'utf8');
  assert.equal(h.validateStateText(saved).project.description.length, description.length);
  const snapshots = fs.readdirSync(h.snapshotRoot).filter((name) => name.endsWith('.json'));
  assert.equal(snapshots.length, 1);
  assert.equal(h.validateStateText(fs.readFileSync(path.join(h.snapshotRoot, snapshots[0]), 'utf8')).project.description.length, description.length);
});

test('compact active references do not omit active or archived assets from external backups', async (t) => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.assetRoot, 'active.png'), 'active asset fixture');
  fs.writeFileSync(path.join(h.assetRoot, 'archived.png'), 'archived asset fixture');
  const state = {
    project: { id: 'active', assets: [{ id: 'a', relativePath: 'active.png' }] },
    projects: [{ id: 'archived', assets: [{ id: 'b', relativePath: 'archived.png' }] }, { id: 'active', __activeProjectReference: true }],
    activeProjectId: 'active', settings: {},
  };
  assert.deepEqual(Array.from(h.stateAssets(state), (asset) => asset.id), ['a', 'b']);
  const external = path.join(h.root, 'external');
  fs.writeFileSync(h.recoveryConfigFile, JSON.stringify({ backupDirectory: external, backupOnSave: true, keepCount: 3 }));
  const target = await h.writeExternalBackup(JSON.stringify(state));
  assert.ok(target.startsWith(external));
  assert.equal(fs.readFileSync(path.join(external, '莲华视频导演台备份', 'assets', 'active.png'), 'utf8'), 'active asset fixture');
  assert.equal(fs.readFileSync(path.join(external, '莲华视频导演台备份', 'assets', 'archived.png'), 'utf8'), 'archived asset fixture');
});

test('interrupted/ENOSPC write keeps the original state and removes only its partial temporary file', (t) => {
  const h = harness(t);
  fs.writeFileSync(h.stateFile, 'ORIGINAL FIXTURE');
  h.controls.failWrite = true;
  assert.throws(() => h.atomicWriteFile(h.stateFile, 'NEW FIXTURE'), /磁盘空间不足.*ENOSPC/u);
  assert.equal(fs.readFileSync(h.stateFile, 'utf8'), 'ORIGINAL FIXTURE');
  assert.deepEqual(fs.readdirSync(h.dataRoot).filter((name) => name.endsWith('.tmp')), []);
});

test('a surviving previous file is never discarded before a failed replacement can restore it', (t) => {
  const h = harness(t);
  fs.writeFileSync(`${h.stateFile}.previous`, 'ONLY ORIGINAL FIXTURE');
  h.controls.failReplacement = true;
  assert.throws(() => h.atomicWriteFile(h.stateFile, 'NEW FIXTURE'), /EPERM/u);
  assert.equal(fs.readFileSync(h.stateFile, 'utf8'), 'ONLY ORIGINAL FIXTURE');
});

test('blocked replacement and rollback retain complete recovery candidates; load reads previous without overwriting it', async (t) => {
  const h = harness(t);
  const original = JSON.stringify({ project: { id: 'previous-fixture', description: 'retain original' }, settings: {} });
  fs.writeFileSync(`${h.stateFile}.previous`, original);
  h.controls.failReplacement = true;
  h.controls.failRestore = true;
  assert.throws(() => h.atomicWriteFile(h.stateFile, 'NEW FIXTURE'), /EPERM/u);
  assert.equal(fs.readFileSync(`${h.stateFile}.previous`, 'utf8'), original);
  assert.equal(fs.readdirSync(h.dataRoot).filter((name) => name.endsWith('.tmp')).length, 1);
  assert.equal(JSON.parse(await h.load()).project.description, 'retain original');
  assert.equal(fs.existsSync(h.stateFile), false, 'recovery load is read-only');
  assert.equal(fs.readFileSync(`${h.stateFile}.previous`, 'utf8'), original);
});

test('desktop state entry points retain shared validation while durable worker saves avoid main-thread full-library parsing', () => {
  for (const name of ['export-project-package', 'import-project-package']) {
    const start = main.indexOf(`handleTrustedIpc('lianhua:${name}'`);
    assert.ok(start >= 0);
    const next = main.indexOf('handleTrustedIpc(', start + 1);
    assert.ok(main.slice(start, next >= 0 ? next : undefined).includes('validateStateText('), `${name} must use the shared finite state boundary`);
  }
  for (const [name, operation] of [['load-state', 'load'], ['save-state', 'save'], ['recovery-status', 'status'], ['create-restore-point', 'restore-point'], ['restore-snapshot', 'restore']]) {
    const start = main.indexOf(`handleTrustedIpc('lianhua:${name}'`);
    const next = main.indexOf('handleTrustedIpc(', start + 1);
    assert.ok(main.slice(start, next >= 0 ? next : undefined).includes(`getStatePersistence().run('${operation}'`));
  }
  const store = fs.readFileSync(new URL('../electron/statePersistenceStore.cjs', import.meta.url), 'utf8');
  const save = store.slice(store.indexOf('const save = async'), store.indexOf('const load ='));
  assert.ok(save.indexOf('prepareStateForSave(content') < save.indexOf('await encryptSecrets('));
  assert.ok(save.indexOf('await encryptSecrets(') < save.indexOf('atomicWriteFile('));
  assert.doesNotMatch(saveHandler, /JSON\.(?:parse|stringify)\(/u);
  assert.match(main, /const exportedState = JSON\.stringify\(stripSecrets\(state\)\);\s*validateStateText\(exportedState\);/u);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createStatePersistence } = require('../electron/statePersistence.cjs');
const { createStateStore, atomicWriteFile } = require('../electron/statePersistenceStore.cjs');
const { prepareStateForSave, validateStateText, stripSecrets, stateChecksum, secretCount, MAX_STATE_BYTES } = require('../electron/stateSerialization.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const content = (id, more = {}) => JSON.stringify({ project: { id, ...more }, projects: [{ id, __activeProjectReference: true }], activeProjectId: id, settings: {} });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-state-worker-'));
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const stateFile = path.join(dataRoot, 'project-state.json');
  const secretVaultFile = path.join(dataRoot, 'credentials.safe');
  const encryptSecrets = (secrets) => ({ mode: 'write', encrypted: Buffer.from(Buffer.from(JSON.stringify(secrets)).toString('base64')) });
  const loadSecrets = () => fs.existsSync(secretVaultFile) ? JSON.parse(Buffer.from(fs.readFileSync(secretVaultFile, 'utf8'), 'base64')) : null;
  const persistence = createStatePersistence({ dataRoot, encryptSecrets, loadSecrets, ...options });
  t.after(async () => {
    await persistence.discard();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('lianhua-state-worker-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, dataRoot, stateFile, secretVaultFile, persistence };
}

test('shared serialization strips every credential without cloning project trees or mutating input', () => {
  const original = JSON.parse(content('credentials'));
  for (const key of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi', 'comfyuiVideo']) original.settings[key] = { apiKey: `fake-${key}`, model: 'fixture-model' };
  for (const key of ['apiCredentialBook', 'textApiProfiles', 'visionApiProfiles', 'imageApiProfiles', 'videoApiProfiles']) original.settings[key] = [{ id: `${key}-1`, apiKey: `fake-${key}` }];
  const before = JSON.stringify(original);
  const safe = stripSecrets(original);
  assert.equal(safe.project, original.project);
  assert.equal(safe.projects, original.projects);
  assert.equal(JSON.stringify(original), before);
  for (const record of Object.values(safe.settings)) {
    if (Array.isArray(record)) assert.equal(record[0].apiKey, '');
    else assert.equal(record.apiKey, '');
  }
  const prepared = prepareStateForSave(before, 123);
  assert.doesNotMatch(prepared.payload, /fake-/u);
  assert.equal(validateStateText(prepared.payload).integrity.savedAt, 123);
  assert.equal(prepared.checksum, stateChecksum(prepared.payload));
  const next = prepareStateForSave(prepared.payload, 456);
  assert.equal(validateStateText(next.payload).integrity.savedAt, 456, 'loaded integrity is replaced, not nested into the checksum');
  assert.throws(() => prepareStateForSave(prepared.payload.replace('credentials', 'tampered')), /完整性/u);
});

test('normal worker save persists state, secret-free snapshots and matching encrypted vault before resolving', async (t) => {
  const h = fixture(t);
  const source = JSON.parse(content('with-secret'));
  source.settings = { comfyuiVideo: { apiKey: 'fake-comfy-key' }, videoTaskApi: { apiKey: 'fake-video-key' } };
  const result = await h.persistence.run('save', { content: JSON.stringify(source) });
  assert.equal(result.ok, true);
  assert.equal(result.checksum, stateChecksum(fs.readFileSync(h.stateFile, 'utf8')));
  const saved = validateStateText(fs.readFileSync(h.stateFile, 'utf8'));
  assert.equal(saved.settings.comfyuiVideo.apiKey, '');
  const snapshots = fs.readdirSync(path.join(h.dataRoot, 'project-snapshots'));
  assert.equal(snapshots.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(h.dataRoot, 'project-snapshots', snapshots[0]), 'utf8'), /fake-(?:comfy|video)-key/u);
  assert.doesNotMatch(fs.readFileSync(h.secretVaultFile, 'utf8'), /fake-(?:comfy|video)-key/u);
  const loaded = await h.persistence.run('load');
  assert.equal(validateStateText(loaded.content).settings.comfyuiVideo.apiKey, 'fake-comfy-key');
});

test('queued saves are strict FIFO and read/credential hydration cannot overtake a pending vault update', async (t) => {
  const gate = deferred();
  const entered = deferred();
  const order = [];
  let savedKey = '';
  const h = fixture(t, {
    encryptSecrets: async (secrets) => {
      const key = secrets.current.text;
      order.push(key);
      if (key === 'fake-A') { entered.resolve(); await gate.promise; }
      savedKey = key;
      return { mode: 'keep' };
    },
    loadSecrets: () => ({ current: { text: savedKey } }),
  });
  const input = (id) => JSON.stringify({ project: { id }, settings: { textApi: { apiKey: `fake-${id}` } } });
  const first = h.persistence.run('save', { content: input('A') });
  await entered.promise;
  const second = h.persistence.run('save', { content: input('B') });
  const load = h.persistence.run('load');
  await tick();
  assert.deepEqual(order, ['fake-A']);
  assert.equal(fs.existsSync(h.stateFile), false);
  gate.resolve();
  const [a, b, loaded] = await Promise.all([first, second, load]);
  assert.notEqual(a.checksum, b.checksum);
  assert.deepEqual(order, ['fake-A', 'fake-B']);
  assert.equal(validateStateText(fs.readFileSync(h.stateFile, 'utf8')).project.id, 'B');
  assert.equal(JSON.parse(loaded.content).settings.textApi.apiKey, 'fake-B');
});

test('invalid or encryption-failed saves reject before changing state/vault; a later successful retry clears the close blocker', async (t) => {
  let encryptionCalls = 0;
  let fail = false;
  const h = fixture(t, { encryptSecrets: () => {
    encryptionCalls += 1;
    if (fail) throw new Error('fixture encryption unavailable');
    return { mode: 'write', encrypted: Buffer.from('encrypted-fixture') };
  } });
  await h.persistence.run('save', { content: content('original') });
  const original = fs.readFileSync(h.stateFile, 'utf8');
  const vault = fs.readFileSync(h.secretVaultFile, 'utf8');
  await assert.rejects(h.persistence.run('save', { content: '{broken' }), /JSON|property|position/iu);
  assert.equal(encryptionCalls, 1);
  fail = true;
  await assert.rejects(h.persistence.run('save', { content: content('never-committed') }), /encryption/iu);
  await assert.rejects(h.persistence.flush(), /encryption/iu);
  assert.equal(fs.readFileSync(h.stateFile, 'utf8'), original);
  assert.equal(fs.readFileSync(h.secretVaultFile, 'utf8'), vault);
  fail = false;
  await h.persistence.run('save', { content: content('retry') });
  await h.persistence.flush();
  assert.equal(h.persistence.lastSaveError, undefined);
  assert.equal(validateStateText(fs.readFileSync(h.stateFile, 'utf8')).project.id, 'retry');
});

test('worker size limit includes the generated integrity envelope and does not depend on main IPC validation', async (t) => {
  const h = fixture(t);
  await assert.rejects(h.persistence.run('save', { content: '' }), /项目状态为空/u);
  await assert.rejects(h.persistence.run('save', { content: JSON.stringify({ settings: {} }) }), /结构无效/u);
  const prepared = prepareStateForSave(content('limit'));
  assert.ok(Buffer.byteLength(prepared.payload) > Buffer.byteLength(content('limit')));
  assert.equal(MAX_STATE_BYTES, 256 * 1024 * 1024);
  assert.equal(fs.existsSync(h.stateFile), false);
});

test('close waits for every accepted save; accepted operations are not coalesced or abandoned during shutdown', async (t) => {
  const gate = deferred();
  const entered = deferred();
  let calls = 0;
  const h = fixture(t, { encryptSecrets: async () => {
    if (++calls === 1) { entered.resolve(); await gate.promise; }
    return { mode: 'keep' };
  } });
  const first = h.persistence.run('save', { content: content('A') });
  await entered.promise;
  const second = h.persistence.run('save', { content: content('B') });
  let closed = false;
  const closing = h.persistence.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  assert.equal(h.persistence.pendingCount, 2);
  await assert.rejects(h.persistence.run('save', { content: content('rejected-after-close') }), /正在关闭/u);
  gate.resolve();
  await Promise.all([first, second, closing]);
  assert.equal(closed, true);
  assert.equal(calls, 2);
  assert.equal(validateStateText(fs.readFileSync(h.stateFile, 'utf8')).project.id, 'B');
});

test('worker death rejects the uncertain persistence barrier without retrying; next explicit save can restart safely', async (t) => {
  let worker;
  let block = false;
  const entered = deferred();
  const h = fixture(t, {
    workerFactory: (file, options) => { worker = new Worker(file, options); return worker; },
    encryptSecrets: () => { if (block) { entered.resolve(); return new Promise(() => {}); } return { mode: 'keep' }; },
  });
  await h.persistence.run('save', { content: content('safe-original') });
  block = true;
  const pending = h.persistence.run('save', { content: content('not-confirmed') });
  const rejection = assert.rejects(pending, /退出|未确认|停止/u);
  await entered.promise;
  await worker.terminate();
  await rejection;
  assert.equal(validateStateText(fs.readFileSync(h.stateFile, 'utf8')).project.id, 'safe-original');
  await assert.rejects(h.persistence.flush(), /退出|未确认|停止/u);
  block = false;
  await h.persistence.run('save', { content: content('explicit-retry') });
  assert.equal(validateStateText(fs.readFileSync(h.stateFile, 'utf8')).project.id, 'explicit-retry');
});

test('snapshot restoration is ordered after older pending saves and keeps the displaced state as a restore point', async (t) => {
  const h = fixture(t);
  const point = await h.persistence.run('restore-point', { content: content('restore-target') });
  const saving = h.persistence.run('save', { content: content('pending-old-save') });
  const restoring = h.persistence.run('restore', { snapshotId: path.basename(point.path) });
  await saving;
  const restored = JSON.parse(await restoring);
  assert.equal(restored.project.id, 'restore-target');
  assert.equal(validateStateText(fs.readFileSync(h.stateFile, 'utf8')).project.id, 'restore-target');
  const snapshots = fs.readdirSync(path.join(h.dataRoot, 'project-snapshots')).map((name) => validateStateText(fs.readFileSync(path.join(h.dataRoot, 'project-snapshots', name), 'utf8')).project.id);
  assert.ok(snapshots.includes('pending-old-save'));
  await assert.rejects(h.persistence.run('restore', { snapshotId: `../${path.basename(point.path)}` }), /名称无效/u);
});

test('external worker backup covers archived assets, rejects traversal, strips secrets and does not convert backup failure into local save failure', async (t) => {
  const h = fixture(t);
  const assets = path.join(h.dataRoot, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'active.png'), 'active synthetic asset');
  fs.writeFileSync(path.join(assets, 'archived.png'), 'archived synthetic asset');
  const backupDirectory = path.join(h.root, 'backup');
  fs.writeFileSync(path.join(h.dataRoot, 'recovery-config.json'), JSON.stringify({ backupDirectory, keepCount: 3 }));
  const input = JSON.stringify({ project: { id: 'active', assets: [{ id: 'active', relativePath: 'active.png' }] },
    projects: [{ id: 'archived', assets: [{ id: 'archived', relativePath: 'archived.png' }, { id: 'escape', relativePath: '../outside.png' }] }],
    settings: { imageApi: { apiKey: 'fake-key-never-in-backup' } } });
  const result = await h.persistence.run('save', { content: input });
  assert.equal(result.backupError, '');
  assert.doesNotMatch(fs.readFileSync(result.externalBackup, 'utf8'), /fake-key/u);
  const targetRoot = path.join(backupDirectory, '莲华视频导演台备份');
  const manifest = JSON.parse(fs.readFileSync(path.join(targetRoot, 'backup-integrity.json'), 'utf8'));
  assert.equal(manifest.stateChecksum, result.checksum);
  assert.equal(manifest.assets.find((item) => item.id === 'escape').missing, true);
  assert.equal(fs.readFileSync(path.join(targetRoot, 'assets', 'archived.png'), 'utf8'), 'archived synthetic asset');
  const blockedPath = path.join(h.root, 'not-a-directory');
  fs.writeFileSync(blockedPath, 'fixture');
  fs.writeFileSync(path.join(h.dataRoot, 'recovery-config.json'), JSON.stringify({ backupDirectory: blockedPath }));
  const failedBackup = await h.persistence.run('save', { content: content('saved-with-backup-error') });
  assert.equal(failedBackup.ok, true);
  assert.ok(failedBackup.backupError);
  assert.equal(validateStateText(fs.readFileSync(h.stateFile, 'utf8')).project.id, 'saved-with-backup-error');
});

test('worker atomic writes retain original or complete .previous candidates after ENOSPC and blocked rename recovery', (t) => {
  const h = fixture(t);
  fs.writeFileSync(h.stateFile, 'original');
  let failWrite = true;
  let blockReplacement = false;
  let blockRollback = false;
  const proxy = new Proxy(fs, { get(target, property) {
    if (property === 'writeFileSync') return (file, data, ...args) => {
      if (failWrite) { fs.writeFileSync(file, 'partial'); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
      return fs.writeFileSync(file, data, ...args);
    };
    if (property === 'renameSync') return (from, to) => {
      if ((blockReplacement && from.endsWith('.tmp')) || (blockRollback && from.endsWith('.previous'))) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    };
    return Reflect.get(target, property);
  } });
  assert.throws(() => atomicWriteFile(h.stateFile, 'replacement', proxy), /磁盘空间不足.*ENOSPC/u);
  assert.equal(fs.readFileSync(h.stateFile, 'utf8'), 'original');
  assert.equal(fs.readdirSync(h.dataRoot).some((name) => name.endsWith('.tmp')), false);
  failWrite = false; blockReplacement = true; blockRollback = true;
  assert.throws(() => atomicWriteFile(h.stateFile, 'complete-replacement', proxy), /EPERM/u);
  assert.equal(fs.existsSync(h.stateFile), false);
  assert.equal(fs.readFileSync(`${h.stateFile}.previous`, 'utf8'), 'original');
  const temp = fs.readdirSync(h.dataRoot).find((name) => name.endsWith('.tmp'));
  assert.equal(fs.readFileSync(path.join(h.dataRoot, temp), 'utf8'), 'complete-replacement');
});

test('worker read-only recovery reads the .previous candidate without rewriting the failed main state', async (t) => {
  const h = fixture(t);
  fs.writeFileSync(h.stateFile, 'damaged original preserved');
  fs.writeFileSync(`${h.stateFile}.previous`, prepareStateForSave(content('previous')).payload);
  const result = await h.persistence.run('load');
  assert.equal(JSON.parse(result.content).project.id, 'previous');
  assert.match(result.notice, /上一份/u);
  assert.equal(fs.readFileSync(h.stateFile, 'utf8'), 'damaged original preserved');
});

test('synthetic 73 MiB library saves off-thread while the main event loop remains responsive', async (t) => {
  const h = fixture(t);
  await h.persistence.run('status'); // warm the worker before measuring the operation
  const source = content('large-performance-fixture', { description: 'x'.repeat(73 * 1024 * 1024) });
  let ticks = 0;
  let maximumGap = 0;
  let previous = performance.now();
  const timer = setInterval(() => { const current = performance.now(); maximumGap = Math.max(maximumGap, current - previous); previous = current; ticks += 1; }, 10);
  const started = performance.now();
  let result;
  try { result = await h.persistence.run('save', { content: source }); }
  finally { clearInterval(timer); }
  const duration = performance.now() - started;
  assert.equal(result.ok, true);
  assert.ok(ticks >= 8, `main loop should keep ticking during full-library processing (ticks=${ticks})`);
  // Includes one structured-clone of the IPC string. The long JSON/hash/fsync
  // stages must not monopolize main for most of the total operation.
  assert.ok(maximumGap < duration * 0.6, `max main-loop gap ${maximumGap.toFixed(1)}ms / save ${duration.toFixed(1)}ms`);
  assert.equal(validateStateText(fs.readFileSync(h.stateFile, 'utf8')).project.description.length, 73 * 1024 * 1024);
  t.diagnostic(`73 MiB save=${duration.toFixed(0)}ms; main-loop ticks=${ticks}; maximum gap=${maximumGap.toFixed(0)}ms`);
});

test('store rejects an invalid vault handshake without committing any state', async (t) => {
  const h = fixture(t);
  const store = createStateStore({ dataRoot: h.dataRoot });
  await assert.rejects(store.save(content('no-vault'), async () => ({ mode: 'write', encrypted: Buffer.alloc(0) })), /空密钥/u);
  assert.equal(fs.existsSync(h.stateFile), false);
});

test('state write failure rolls a changed encrypted vault back before rejecting the save', async (t) => {
  const h = fixture(t);
  await h.persistence.run('save', { content: content('old-endpoint') });
  const previousState = fs.readFileSync(h.stateFile, 'utf8');
  const previousVault = fs.readFileSync(h.secretVaultFile);
  const transactionFile = path.join(h.dataRoot, 'state-vault-transaction.json');
  const fsProxy = new Proxy(fs, { get(target, property) {
    if (property === 'renameSync') return (from, to) => {
      if (from.endsWith('.tmp') && to === h.stateFile) throw Object.assign(new Error('state file locked'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    };
    return Reflect.get(target, property);
  } });
  const store = createStateStore({ dataRoot: h.dataRoot, fs: fsProxy });
  await assert.rejects(store.save(content('new-endpoint'), async () => ({ mode: 'write', encrypted: Buffer.from('new-encrypted-vault') })), /EPERM/u);
  assert.equal(fs.readFileSync(h.stateFile, 'utf8'), previousState);
  assert.deepEqual(fs.readFileSync(h.secretVaultFile), previousVault);
  assert.equal(fs.existsSync(transactionFile), false, 'successful rollback removes only the completed transaction');
});

test('explicit credential removal is not silently successful when the vault cannot be deleted', async (t) => {
  const h = fixture(t);
  await h.persistence.run('save', { content: content('before-clear') });
  const previousState = fs.readFileSync(h.stateFile, 'utf8');
  const previousVault = fs.readFileSync(h.secretVaultFile);
  const fsProxy = new Proxy(fs, { get(target, property) {
    if (property === 'unlinkSync') return (file) => {
      if (file === h.secretVaultFile) throw Object.assign(new Error('vault locked'), { code: 'EPERM' });
      return fs.unlinkSync(file);
    };
    return Reflect.get(target, property);
  } });
  const store = createStateStore({ dataRoot: h.dataRoot, fs: fsProxy });
  await assert.rejects(store.save(content('after-clear'), async () => ({ mode: 'remove' })), /EPERM/u);
  assert.equal(fs.readFileSync(h.stateFile, 'utf8'), previousState);
  assert.deepEqual(fs.readFileSync(h.secretVaultFile), previousVault);
});

test('restarted worker reconciles interrupted vault commits before decrypting credentials for load', async (t) => {
  for (const committed of [false, true]) {
    const h = fixture(t);
    const previous = prepareStateForSave(JSON.stringify({ project: { id: 'previous' }, settings: { textApi: { apiKey: '' } } })).payload;
    const next = prepareStateForSave(JSON.stringify({ project: { id: 'next' }, settings: { textApi: { apiKey: '' } } })).payload;
    const encryptedVault = (key) => Buffer.from(Buffer.from(JSON.stringify({ current: { text: key } })).toString('base64'));
    const previousVault = encryptedVault('fake-previous-key');
    const nextVault = encryptedVault('fake-next-key');
    fs.writeFileSync(h.stateFile, committed ? next : previous);
    // Deliberately simulate the mismatched half of the state/vault pair.
    fs.writeFileSync(h.secretVaultFile, committed ? previousVault : nextVault);
    const transactionFile = path.join(h.dataRoot, 'state-vault-transaction.json');
    fs.writeFileSync(transactionFile, JSON.stringify({ version: 1,
      previousStateChecksum: stateChecksum(previous), nextStateChecksum: stateChecksum(next),
      previousVault: previousVault.toString('base64'), nextVault: nextVault.toString('base64'),
    }));
    assert.doesNotMatch(fs.readFileSync(transactionFile, 'utf8'), /fake-(?:previous|next)-key/u);
    const loaded = JSON.parse((await h.persistence.run('load')).content);
    assert.equal(loaded.project.id, committed ? 'next' : 'previous');
    assert.equal(loaded.settings.textApi.apiKey, committed ? 'fake-next-key' : 'fake-previous-key');
    assert.equal(fs.existsSync(transactionFile), false);
  }
});

test('interrupted state rename restores matching vault before read-only .previous recovery', async (t) => {
  const h = fixture(t);
  const previous = prepareStateForSave(content('previous-after-crash')).payload;
  const next = prepareStateForSave(content('not-committed')).payload;
  fs.writeFileSync(`${h.stateFile}.previous`, previous);
  fs.writeFileSync(h.secretVaultFile, 'changed-opaque-vault');
  const store = createStateStore({ dataRoot: h.dataRoot });
  fs.writeFileSync(path.join(h.dataRoot, 'state-vault-transaction.json'), JSON.stringify({ version: 1,
    previousStateChecksum: stateChecksum(previous), nextStateChecksum: stateChecksum(next),
    previousVault: Buffer.from('previous-opaque-vault').toString('base64'), nextVault: Buffer.from('changed-opaque-vault').toString('base64'),
  }));
  store.recoverVaultTransaction();
  assert.equal(fs.readFileSync(h.secretVaultFile, 'utf8'), 'previous-opaque-vault');
  assert.equal(fs.existsSync(h.stateFile), false, 'reconciliation must not rewrite the user state');
  assert.equal(JSON.parse(store.load(null).content).project.id, 'previous-after-crash');
});

test('unknown or unmatched save transactions fail closed and preserve both state and vault', async (t) => {
  const h = fixture(t);
  const previous = prepareStateForSave(content('previous')).payload;
  const actual = prepareStateForSave(content('external-change')).payload;
  const next = prepareStateForSave(content('next')).payload;
  fs.writeFileSync(h.stateFile, actual);
  fs.writeFileSync(h.secretVaultFile, 'opaque-preserved');
  const transactionFile = path.join(h.dataRoot, 'state-vault-transaction.json');
  for (const version of [1, 999]) {
    fs.writeFileSync(transactionFile, JSON.stringify({ version,
      previousStateChecksum: stateChecksum(previous), nextStateChecksum: stateChecksum(next),
      previousVault: null, nextVault: Buffer.from('opaque-next').toString('base64'),
    }));
    await assert.rejects(h.persistence.run('load'), /事务/u);
    await assert.rejects(h.persistence.run('save', { content: content('must-not-overwrite') }), /事务/u);
    assert.equal(fs.readFileSync(h.stateFile, 'utf8'), actual);
    assert.equal(fs.readFileSync(h.secretVaultFile, 'utf8'), 'opaque-preserved');
    assert.equal(fs.existsSync(transactionFile), true);
  }
});

test('backup integrity never claims altered source media matches the recorded checksum', async (t) => {
  const h = fixture(t);
  const assetRoot = path.join(h.dataRoot, 'assets');
  fs.mkdirSync(assetRoot);
  fs.writeFileSync(path.join(assetRoot, 'changed.mp4'), 'altered fixture');
  const backupDirectory = path.join(h.root, 'backup');
  fs.writeFileSync(path.join(h.dataRoot, 'recovery-config.json'), JSON.stringify({ backupDirectory }));
  const result = await h.persistence.run('save', { content: content('backup-integrity', {
    assets: [{ id: 'changed', relativePath: 'changed.mp4', checksum: stateChecksum('original fixture') }],
  }) });
  assert.equal(result.ok, true);
  const targetRoot = path.join(backupDirectory, '莲华视频导演台备份');
  const manifest = JSON.parse(fs.readFileSync(path.join(targetRoot, 'backup-integrity.json'), 'utf8'));
  assert.equal(manifest.assets[0].missing, true);
  assert.equal(fs.existsSync(path.join(targetRoot, 'assets', 'changed.mp4')), false);
});

test('flush includes a follow-up save enqueued as the first persistence barrier resolves', async (t) => {
  const h = fixture(t);
  let next;
  const first = h.persistence.run('save', { content: content('first') });
  void first.then(() => { next = h.persistence.run('save', { content: content('latest') }); });
  await h.persistence.flush();
  assert.equal(h.persistence.pendingCount, 0);
  assert.ok(next);
  assert.equal(validateStateText(fs.readFileSync(h.stateFile, 'utf8')).project.id, 'latest');
  await next;
});

test('main safeStorage cache encrypts changed credentials only and never bypasses unavailable encryption', () => {
  const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf('let statePersistence;');
  const end = main.indexOf('const hydrateSecrets =', start);
  assert.ok(start >= 0 && end > start);
  let options;
  let encryptions = 0;
  let available = true;
  const context = vm.createContext({
    dataRoot: 'unused-isolated-path', loadSecrets: () => null, secretCount,
    createStatePersistence: (input) => { options = input; return {}; },
    safeStorage: { isEncryptionAvailable: () => available, encryptString: () => Buffer.from(`opaque-${++encryptions}`) },
  });
  vm.runInContext(`${main.slice(start, end)}\n;getStatePersistence();`, context);
  const input = (key) => ({ current: { text: key } });
  const first = options.encryptSecrets(input('fake-A'));
  const repeated = options.encryptSecrets(input('fake-A'));
  assert.deepEqual(first.encrypted, repeated.encrypted);
  assert.equal(encryptions, 1);
  assert.notDeepEqual(options.encryptSecrets(input('fake-B')).encrypted, first.encrypted);
  assert.equal(encryptions, 2);
  assert.equal(options.encryptSecrets(input('')).mode, 'remove');
  options.encryptSecrets(input('fake-B'));
  assert.equal(encryptions, 3, 'clearing keys also clears the in-memory encrypted cache');
  available = false;
  assert.throws(() => options.encryptSecrets(input('fake-B')), /系统加密不可用/u);
  assert.equal(options.encryptSecrets(input('')).mode, 'keep');
});

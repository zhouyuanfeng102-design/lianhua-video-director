import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { collectImageReferenceSnapshotsForExport } = require('../electron/imageReferenceSnapshots.cjs');
const { readManagedImageDataUrl } = require('../electron/imageReferenceTransport.cjs');
const { createStateStore } = require('../electron/statePersistenceStore.cjs');
const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const ref = (overrides = {}) => ({ id: 'reference-a', relativePath: 'image/original.png', checksum: checksum(png), ...overrides });
const task = (overrides = {}) => ({ id: 'image-a', kind: 'image', imageGenerationMode: 'image-to-image', referenceAssetSnapshots: [ref()], ...overrides });
const resultAsset = (overrides = {}) => ({
  id: 'result-a', relativePath: 'image/result.png', checksum: checksum(png), imageGenerationMode: 'image-to-image',
  imageRegenerationSnapshot: { version: 1, model: 'saved-image-model', referenceAssetSnapshots: [ref()],
    imageApiSnapshot: { version: 1, profileId: null, connectionFingerprint: 'a'.repeat(64), executionFingerprint: 'b'.repeat(64),
      config: { enabled: true, backend: 'openai', model: 'saved-image-model' } },
  }, ...overrides,
});
const slice = (start, end) => {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `main source anchors ${start} / ${end}`);
  return mainSource.slice(startIndex, endIndex);
};

test('package collection covers task-owned originals in every project without secrets or duplicate files', () => {
  const state = {
    project: { id: 'active', assets: [], generationTasks: [task(), task({ id: 'image-2' })] },
    projects: [
      { id: 'active', __activeProjectReference: true },
      { id: 'archived', generationTasks: [task({ id: 'other', referenceAssetSnapshots: [ref({ id: 'reference-b', relativePath: 'image/other.png' })] })] },
    ],
  };
  assert.deepEqual(collectImageReferenceSnapshotsForExport(state), [ref(), ref({ id: 'reference-b', relativePath: 'image/other.png' })]);
  const noisy = { ...ref(), apiKey: 'secret', url: 'https://example.invalid/?token=secret', dataUrl: 'data:image/png;base64,AA==' };
  assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { generationTasks: [task({ referenceAssetSnapshots: [noisy] })] } }), [ref()]);
  assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { generationTasks: [
    task({ imageGenerationMode: undefined }), task({ kind: 'video' }),
    task({ referenceAssetSnapshots: [ref({ relativePath: '../outside.png' }), ref({ relativePath: 'C:/outside.png' }), ref({ checksum: 'invalid' })] }),
  ] } }), []);
  assert.throws(() => collectImageReferenceSnapshotsForExport({ project: { generationTasks: [
    task(), task({ id: 'conflict', referenceAssetSnapshots: [ref({ checksum: 'f'.repeat(64) })] }),
  ] } }), /快照存在冲突/u);
  assert.deepEqual(collectImageReferenceSnapshotsForExport({
    project: { assets: [resultAsset()], generationTasks: [] },
    projects: [{ id: 'archived', assets: [resultAsset({ imageRegenerationSnapshot: {
      ...resultAsset().imageRegenerationSnapshot, referenceAssetSnapshots: [ref({ relativePath: 'image/archived.png' })],
    } })] }],
  }), [ref(), ref({ relativePath: 'image/archived.png' })], 'active and archived result assets retain originals after both task/card deletion');
  assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { assets: [resultAsset({ imageGenerationMode: undefined })] } }), [], 'old unmarked assets are never inferred as direct');
  assert.throws(() => collectImageReferenceSnapshotsForExport({ project: { assets: [resultAsset({ imageRegenerationSnapshot: {
    ...resultAsset().imageRegenerationSnapshot, referenceAssetSnapshots: [ref({ checksum: 'f'.repeat(64) })],
  } })], generationTasks: [task()] } }), /快照存在冲突/u);
});

const packageHarness = (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-image-snapshot-package-'));
  const exportRoot = path.join(temporaryRoot, 'original-assets');
  const importRoot = path.join(temporaryRoot, 'restored-assets');
  const bundlePath = path.join(temporaryRoot, 'portable-bundle');
  const handlers = new Map();
  const ensureDirectory = (directory) => { fs.mkdirSync(directory, { recursive: true }); return directory; };
  [exportRoot, importRoot].forEach(ensureDirectory);
  const context = vm.createContext({
    fs, path, Map, Set, Buffer, randomUUID,
    assetRoot: exportRoot,
    tempRoot: ensureDirectory(path.join(temporaryRoot, 'staging')),
    ALLOWED_MEDIA_EXTENSIONS: new Set(['.png', '.jpg', '.jpeg', '.webp']),
    collectImageReferenceSnapshotsForExport,
    collectVideoFrozenAssets: () => [],
    handleTrustedIpc: (channel, callback) => handlers.set(channel, callback),
    validateStateText: JSON.parse,
    qaPath: () => bundlePath,
    ensureDirectory,
    stripSecrets: (state) => state,
    atomicWriteFile: (file, bytes) => fs.writeFileSync(file, bytes),
    fileSha256: (file) => checksum(fs.readFileSync(file)),
    mediaKindFromExtension: () => 'image',
    isPathInside: (parent, child) => {
      const relative = path.relative(path.resolve(parent), path.resolve(child));
      return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
    },
    powershellArchive: async (stage, destination) => fs.cpSync(stage, destination, { recursive: true }),
    powershellExpand: async (source, stage) => fs.cpSync(source, stage, { recursive: true }),
    readJsonFile: (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } },
    syncImportedGeneratedVideoNames: () => {},
    getStatePersistence: () => ({ flush: async () => {} }),
    hydrateSecrets: (state) => state,
  });
  // Exercise the real export/import handlers and real collision/remap helpers.
  // Only the outer archive container is represented by a test directory.
  vm.runInContext([
    slice('const stateAssets =', 'const fsyncDirectory ='),
    slice('const assetPathFromRelative =', 'const readManagedImageDataUrlForRenderer ='),
    slice('const MAX_READABLE_MEDIA_STEM_LENGTH =', 'const allocateReadableMediaRelativePathAsync ='),
    slice('const copyImportedAssetIntoStore =', 'const syncImportedGeneratedVideoNames ='),
    slice("handleTrustedIpc('lianhua:export-project-package'", "handleTrustedIpc('lianhua:submit-video-task'"),
  ].join('\n'), context);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporaryRoot).startsWith('lianhua-image-snapshot-package-'));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { context, handlers, exportRoot, importRoot, bundlePath, ensureDirectory };
};

test('export/import preserves deleted asset-card originals and remaps snapshots on destination name collisions', async (t) => {
  const h = packageHarness(t);
  h.ensureDirectory(path.join(h.exportRoot, 'image'));
  fs.writeFileSync(path.join(h.exportRoot, 'image/original.png'), png);
  const state = {
    activeProjectId: 'active', project: { id: 'active', assets: [], generationTasks: [task(), task({ id: 'retry-2' })] },
    projects: [],
  };
  const result = await h.handlers.get('lianhua:export-project-package')({}, { content: JSON.stringify(state), fileName: 'snapshot-project' });
  assert.equal(result.assetCount, 1, 'the removed card still has one shared task-owned original');
  assert.equal(result.missingCount, 0);
  assert.deepEqual(fs.readFileSync(path.join(h.bundlePath, 'assets/image/original.png')), png);
  const manifest = JSON.parse(fs.readFileSync(path.join(h.bundlePath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].checksum, checksum(png));

  h.ensureDirectory(path.join(h.importRoot, 'image'));
  const collision = Buffer.concat([png, Buffer.from('a different existing image')]);
  fs.writeFileSync(path.join(h.importRoot, 'image/original.png'), collision);
  h.context.assetRoot = h.importRoot;
  const imported = JSON.parse(await h.handlers.get('lianhua:import-project-package')({}, { path: h.bundlePath }));
  assert.equal(imported.project.assets.length, 0);
  const snapshots = imported.project.generationTasks.map((item) => item.referenceAssetSnapshots[0]);
  assert.notEqual(snapshots[0].relativePath, 'image/original.png');
  assert.equal(snapshots[0].relativePath, snapshots[1].relativePath);
  assert.equal(snapshots[0].checksum, checksum(png));
  assert.deepEqual(fs.readFileSync(path.join(h.importRoot, 'image/original.png')), collision, 'import never overwrites an unrelated file');
  const loaded = readManagedImageDataUrl({ assetRoot: h.importRoot, relativePath: snapshots[0].relativePath, expectedChecksum: snapshots[0].checksum });
  assert.equal(loaded.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
});

test('a replaced task-owned file is reported missing instead of exporting different pixels under the old snapshot', async (t) => {
  const h = packageHarness(t);
  h.ensureDirectory(path.join(h.exportRoot, 'image'));
  fs.writeFileSync(path.join(h.exportRoot, 'image/original.png'), Buffer.concat([png, Buffer.from('replaced')]));
  const result = await h.handlers.get('lianhua:export-project-package')({}, {
    content: JSON.stringify({ project: { id: 'active', assets: [ref()], generationTasks: [task()] }, projects: [] }),
  });
  assert.equal(result.assetCount, 0);
  assert.equal(result.missingCount, 1);
  assert.equal(fs.existsSync(path.join(h.bundlePath, 'assets/image/original.png')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(h.bundlePath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.assets[0].missing, true);
});

test('result-only project exports and imports original references after both source task and asset cards are deleted', async (t) => {
  const h = packageHarness(t);
  h.ensureDirectory(path.join(h.exportRoot, 'image'));
  fs.writeFileSync(path.join(h.exportRoot, 'image/original.png'), png);
  fs.writeFileSync(path.join(h.exportRoot, 'image/result.png'), png);
  const state = { project: { id: 'active', assets: [resultAsset()], generationTasks: [] }, projects: [] };
  const result = await h.handlers.get('lianhua:export-project-package')({}, { content: JSON.stringify(state), fileName: 'result-owned-originals' });
  assert.equal(result.assetCount, 2);
  assert.equal(result.missingCount, 0);
  assert.deepEqual(fs.readFileSync(path.join(h.bundlePath, 'assets/image/original.png')), png);
  h.ensureDirectory(path.join(h.importRoot, 'image'));
  const conflictingOriginal = Buffer.concat([png, Buffer.from('another original')]);
  fs.writeFileSync(path.join(h.importRoot, 'image/original.png'), conflictingOriginal);
  h.context.assetRoot = h.importRoot;
  const imported = JSON.parse(await h.handlers.get('lianhua:import-project-package')({}, { path: h.bundlePath }));
  assert.equal(imported.project.generationTasks.length, 0);
  assert.equal(imported.project.assets.length, 1, 'import does not invent source asset cards');
  const restoredResult = imported.project.assets[0];
  const frozen = restoredResult.imageRegenerationSnapshot.referenceAssetSnapshots[0];
  assert.equal(restoredResult.imageGenerationMode, 'image-to-image');
  assert.notEqual(frozen.relativePath, 'image/original.png');
  assert.equal(frozen.checksum, checksum(png));
  assert.equal(readManagedImageDataUrl({ assetRoot: h.importRoot, relativePath: frozen.relativePath, expectedChecksum: frozen.checksum }).dataUrl,
    `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(fs.readFileSync(path.join(h.importRoot, 'image/original.png')), conflictingOriginal);
});

test('external backups include deleted-card originals and preserve task checksum verification', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-image-snapshot-backup-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporaryRoot).startsWith('lianhua-image-snapshot-backup-'));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const dataRoot = path.join(temporaryRoot, 'data');
  const backupDirectory = path.join(temporaryRoot, 'external');
  fs.mkdirSync(path.join(dataRoot, 'assets/image'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'assets/image/original.png'), png);
  fs.writeFileSync(path.join(dataRoot, 'assets/image/archived.png'), png);
  fs.writeFileSync(path.join(dataRoot, 'recovery-config.json'), JSON.stringify({ backupDirectory, backupOnSave: true }));
  const store = createStateStore({ dataRoot });
  const state = {
    project: { id: 'active', assets: [], generationTasks: [task(), task({ id: 'retry-2' })] },
    projects: [{ id: 'archived', generationTasks: [task({ referenceAssetSnapshots: [ref({ relativePath: 'image/archived.png' })] })] }],
    settings: {},
  };
  const result = await store.save(JSON.stringify(state), async () => ({ mode: 'keep' }));
  assert.equal(result.ok, true);
  assert.equal(result.backupError, '');
  assert.ok(result.externalBackup);
  const backupRoot = path.dirname(result.externalBackup);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'backup-integrity.json'), 'utf8'));
  assert.equal(manifest.assets.length, 2, 'active and archived task references are backed up once per path');
  assert.ok(manifest.assets.every((asset) => !asset.missing && asset.checksum === checksum(png)));
  for (const relativePath of ['image/original.png', 'image/archived.png']) {
    assert.deepEqual(fs.readFileSync(path.join(backupRoot, 'assets', relativePath)), png);
  }
  const backupState = JSON.parse(fs.readFileSync(result.externalBackup, 'utf8'));
  const frozen = backupState.project.generationTasks[0].referenceAssetSnapshots[0];
  assert.equal(readManagedImageDataUrl({ assetRoot: path.join(backupRoot, 'assets'), relativePath: frozen.relativePath, expectedChecksum: frozen.checksum }).dataUrl,
    `data:image/png;base64,${png.toString('base64')}`);

  // A surviving asset card must not override the older task's frozen pixels.
  const replacement = Buffer.concat([png, Buffer.from('changed original')]);
  fs.writeFileSync(path.join(dataRoot, 'assets/image/original.png'), replacement);
  state.project.assets = [ref({ checksum: checksum(replacement) })];
  store.backup(JSON.stringify(state));
  const replacedManifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'backup-integrity.json'), 'utf8'));
  assert.equal(replacedManifest.assets.find((asset) => asset.relativePath === 'image/original.png').missing, true);
  assert.deepEqual(fs.readFileSync(path.join(backupRoot, 'assets/image/original.png')), png, 'the saved original is never overwritten with changed pixels');
});

test('external backups retain result-owned originals without a source task or reference asset record', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-image-result-backup-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporaryRoot).startsWith('lianhua-image-result-backup-'));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const dataRoot = path.join(temporaryRoot, 'data');
  const backupDirectory = path.join(temporaryRoot, 'external');
  fs.mkdirSync(path.join(dataRoot, 'assets/image'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'assets/image/original.png'), png);
  fs.writeFileSync(path.join(dataRoot, 'assets/image/result.png'), png);
  fs.writeFileSync(path.join(dataRoot, 'recovery-config.json'), JSON.stringify({ backupDirectory, backupOnSave: true }));
  const store = createStateStore({ dataRoot });
  const state = { project: { id: 'active', assets: [resultAsset()], generationTasks: [] }, projects: [], settings: {} };
  const saved = await store.save(JSON.stringify(state), async () => ({ mode: 'keep' }));
  assert.equal(saved.backupError, '');
  const backupRoot = path.dirname(saved.externalBackup);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'backup-integrity.json'), 'utf8'));
  assert.deepEqual(manifest.assets.map((asset) => asset.relativePath).sort(), ['image/original.png', 'image/result.png']);
  assert.ok(manifest.assets.every((asset) => !asset.missing));
  const restored = JSON.parse(fs.readFileSync(saved.externalBackup, 'utf8'));
  const frozen = restored.project.assets[0].imageRegenerationSnapshot.referenceAssetSnapshots[0];
  assert.equal(readManagedImageDataUrl({ assetRoot: path.join(backupRoot, 'assets'), relativePath: frozen.relativePath, expectedChecksum: frozen.checksum }).dataUrl,
    `data:image/png;base64,${png.toString('base64')}`);
  fs.writeFileSync(path.join(dataRoot, 'assets/image/original.png'), Buffer.concat([png, Buffer.from('changed')]));
  store.backup(JSON.stringify(state));
  const changed = JSON.parse(fs.readFileSync(path.join(backupRoot, 'backup-integrity.json'), 'utf8'));
  assert.equal(changed.assets.find((asset) => asset.relativePath === frozen.relativePath).missing, true);
  assert.deepEqual(fs.readFileSync(path.join(backupRoot, 'assets/image/original.png')), png);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { collectImageReferenceSnapshotsForExport } = require('../electron/imageReferenceSnapshots.cjs');
const { collectStateMediaFiles, createStateMediaExternalizer } = require('../electron/stateMediaFiles.cjs');
const { writeProjectLibrary } = require('../electron/projectLibraryStore.cjs');
const { readProjectLibraryImport } = require('../electron/projectLibraryImport.cjs');
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const checksum = createHash('sha256').update(bytes).digest('hex');
const snapshot = { id: 'original', name: '原图', type: 'reference', role: 'composition',
  relativePath: 'image/original.png', checksum, managed: true, mediaType: 'image' };
const task = (overrides = {}) => ({ id: 'reverse-task', kind: 'image-prompt-reverse', name: '图片反推',
  status: 'succeeded', referenceAssetId: snapshot.id, referenceAssetSnapshots: [snapshot],
  result: { prompt: '原始提示词', characters: '没有人物', objects: '花瓶', scene: '桌面', style: '摄影' }, ...overrides });
const locator = { id: snapshot.id, relativePath: snapshot.relativePath, checksum };
const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-reverse-media-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('lianhua-reverse-media-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
};

test('reverse originals are exported and backed up after source asset-card deletion in active/background projects', () => {
  const state = { project: { id: 'active', assets: [], generationTasks: [task()] },
    projects: [{ id: 'background', assets: [], generationTasks: [task({ id: 'other' })] }] };
  assert.deepEqual(collectImageReferenceSnapshotsForExport(state), [locator]);
  assert.deepEqual(collectStateMediaFiles(state), [locator]);
  assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { assets: [], generationTasks: [] } }), []);
  const noisy = { ...snapshot, apiKey: 'secret', url: 'https://secret.invalid', dataUrl: 'data:image/png;base64,AA==' };
  assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { generationTasks: [task({ referenceAssetSnapshots: [noisy] })] } }), [locator]);
  assert.throws(() => collectImageReferenceSnapshotsForExport({ project: { generationTasks: [task(), task({
    id: 'conflict', referenceAssetSnapshots: [{ ...snapshot, checksum: 'b'.repeat(64) }],
  })] } }), /快照存在冲突/u);
  for (const relativePath of ['../escape.png', 'C:/escape.png', 'https://unsafe.invalid/a.png']) {
    assert.deepEqual(collectImageReferenceSnapshotsForExport({ project: { generationTasks: [task({ referenceAssetSnapshots: [{ ...snapshot, relativePath }] })] } }), []);
  }
});

test('typed reverse snapshots externalize exact original pixels without rewriting prompt or response text', (t) => {
  const assetRoot = path.join(fixture(t), 'assets');
  const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
  const original = task({ referenceAssetSnapshots: [{ ...snapshot, dataUrl }], customRequirement: dataUrl,
    result: { ...task().result, prompt: dataUrl } });
  const converted = createStateMediaExternalizer({ assetRoot }).externalize({ project: { assets: [], generationTasks: [original] } });
  const stored = converted.project.generationTasks[0].referenceAssetSnapshots[0];
  assert.equal(stored.dataUrl, undefined);
  assert.equal(stored.relativePath, `image/${checksum}.png`);
  assert.equal(stored.checksum, checksum);
  assert.deepEqual(fs.readFileSync(path.join(assetRoot, stored.relativePath)), bytes);
  assert.equal(converted.project.generationTasks[0].customRequirement, dataUrl);
  assert.equal(converted.project.generationTasks[0].result.prompt, dataUrl);
  assert.deepEqual(collectStateMediaFiles(converted), [{ id: snapshot.id, relativePath: stored.relativePath, checksum, sizeBytes: bytes.length }]);
});

test('library import restores task-only original and remaps path collision while preserving old local files and analysis', (t) => {
  const root = fixture(t);
  const source = path.join(root, 'backup');
  const dataRoot = path.join(root, 'current');
  const assetRoot = path.join(dataRoot, 'assets');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const state = { project: { id: 'active', assets: [], generationTasks: [task()] },
    projects: [{ id: 'active', __activeProjectReference: true }, { id: 'background', assets: [], generationTasks: [task({ id: 'other' })] }], settings: {} };
  const { payload } = writeProjectLibrary(state, { root: source, writeFile: (file, content) => fs.writeFileSync(file, content), savedAt: 1 });
  const filePath = path.join(source, 'project-latest.json');
  fs.writeFileSync(filePath, payload);
  const originalPath = path.join(source, 'assets', snapshot.relativePath);
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.writeFileSync(originalPath, bytes);
  const localPath = path.join(assetRoot, snapshot.relativePath);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, 'older local original');
  const restored = JSON.parse(readProjectLibraryImport(payload, { filePath, dataRoot, assetRoot }));
  const remapped = `image/${checksum}.png`;
  assert.equal(restored.project.generationTasks[0].referenceAssetSnapshots[0].relativePath, remapped);
  assert.equal(restored.projects[1].generationTasks[0].referenceAssetSnapshots[0].relativePath, remapped);
  assert.deepEqual(restored.project.generationTasks[0].result, task().result);
  assert.equal(restored.project.generationTasks[0].referenceAssetId, snapshot.id);
  assert.deepEqual(fs.readFileSync(path.join(assetRoot, remapped)), bytes);
  assert.equal(fs.readFileSync(localPath, 'utf8'), 'older local original');
  assert.deepEqual(fs.readFileSync(originalPath), bytes);
  assert.deepEqual(JSON.parse(readProjectLibraryImport(payload, { filePath, dataRoot, assetRoot })), restored);
});

test('missing task-only original fails library import without authorizing partial restored state', (t) => {
  const root = fixture(t);
  const source = path.join(root, 'backup');
  const dataRoot = path.join(root, 'current');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(path.join(source, 'assets', 'image'), { recursive: true });
  const state = { project: { id: 'active', assets: [], generationTasks: [task()] }, projects: [], settings: {} };
  const { payload } = writeProjectLibrary(state, { root: source, writeFile: (file, content) => fs.writeFileSync(file, content), savedAt: 1 });
  assert.throws(() => readProjectLibraryImport(payload, { filePath: path.join(source, 'project-latest.json'), dataRoot,
    assetRoot: path.join(dataRoot, 'assets') }), /缺少此素材.*未导入项目/u);
});

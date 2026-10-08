import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { writeProjectLibrary } = require('../electron/projectLibraryStore.cjs');
const { readProjectLibraryImport } = require('../electron/projectLibraryImport.cjs');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('exact original image bytes, never reencoded');
const media = (relativePath = 'image/reference.png') => ({ id: 'hero-image', relativePath, checksum: digest(bytes),
  name: '人物图原名', fileName: '原名.png', characterReferenceId: 'hero', managed: true, url: `lianhua-asset://local/${relativePath}` });
const fixture = (t, change = (state) => state) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-library-import-'));
  const source = path.join(temporary, 'external-backup');
  const dataRoot = path.join(temporary, 'current-data');
  const assetRoot = path.join(dataRoot, 'assets');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const reference = media();
  const state = change({ project: { id: 'active', prompt: '中文原稿\nEnglish original', assets: [reference], generationTasks: [
    { id: 'image-task', kind: 'image', referenceAssetSnapshots: [{ ...reference }] },
    { id: 'video-task', requestBody: { relativePath: reference.relativePath, prompt: 'original request' }, videoJob: {
      snapshot: { images: [{ ...reference, assetId: reference.id, freezeState: 'frozen', frozenAt: 12 }] },
      tailPreparation: { selection: { frame: { ...reference } }, sourceRelativePath: reference.relativePath },
    } },
  ] }, projects: [{ id: 'active', __activeProjectReference: true }, { id: 'other', assets: [{ ...reference }] }], settings: {} });
  const { payload } = writeProjectLibrary(state, { root: source, writeFile: (file, content) => fs.writeFileSync(file, content), savedAt: 1 });
  const filePath = path.join(source, 'project-latest.json');
  fs.writeFileSync(filePath, payload);
  const sourceFile = path.join(source, 'assets', reference.relativePath);
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, bytes);
  t.after(() => {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('lianhua-library-import-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { temporary, source, dataRoot, assetRoot, sourceFile, state, payload, filePath,
    read(options = {}) { return readProjectLibraryImport(payload, { filePath, dataRoot, assetRoot, ...options }); } };
};

test('external backup imports all projects and actual media before returning expanded JSON', (t) => {
  const f = fixture(t);
  const after = JSON.parse(f.read());
  assert.deepEqual(after, f.state);
  assert.deepEqual(fs.readFileSync(path.join(f.assetRoot, 'image/reference.png')), bytes);
  assert.deepEqual(fs.readFileSync(f.sourceFile), bytes);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), f.payload);
  assert.equal(fs.existsSync(path.join(f.dataRoot, 'project-state.json')), false, 'caller decides whether to import returned data');
});

test('same-name different local image stays intact and only typed asset/frozen-image locators remap', (t) => {
  const f = fixture(t);
  const original = path.join(f.assetRoot, 'image/reference.png');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, 'local original must remain');
  const after = JSON.parse(f.read());
  const expected = `image/${digest(bytes)}.png`;
  assert.equal(after.project.assets[0].relativePath, expected);
  assert.equal(after.project.assets[0].url, `lianhua-asset://local/${expected}`);
  assert.equal(after.project.assets[0].fileName, '原名.png');
  assert.equal(after.project.assets[0].name, '人物图原名');
  assert.equal(after.project.assets[0].characterReferenceId, 'hero');
  assert.equal(after.projects[1].assets[0].relativePath, expected);
  assert.equal(after.project.generationTasks[0].referenceAssetSnapshots[0].relativePath, expected);
  const video = after.project.generationTasks[1];
  assert.equal(video.videoJob.snapshot.images[0].relativePath, expected);
  assert.equal(video.videoJob.snapshot.images[0].frozenAt, 12);
  assert.equal(video.videoJob.tailPreparation.selection.frame.relativePath, expected);
  assert.equal(video.videoJob.tailPreparation.sourceRelativePath, expected);
  assert.deepEqual(video.requestBody, f.state.project.generationTasks[1].requestBody);
  assert.equal(after.project.prompt, f.state.project.prompt);
  assert.deepEqual(fs.readFileSync(path.join(f.assetRoot, expected)), bytes);
  assert.equal(fs.readFileSync(original, 'utf8'), 'local original must remain');
  assert.deepEqual(JSON.parse(f.read()), after, 'repeat import reuses the verified imported content');
});

test('legacy JSON/text is returned byte for byte without any media copy', () => {
  for (const raw of ['not json', '{"project": {"id":"old"}, "settings":{}}\n']) {
    assert.equal(readProjectLibraryImport(raw, {}), raw);
  }
});

test('local snapshot manifests resolve blocks from their parent data directory', (t) => {
  const f = fixture(t);
  const snapshotPath = path.join(f.source, 'project-snapshots', 'project-test.json');
  fs.mkdirSync(path.dirname(snapshotPath));
  fs.writeFileSync(snapshotPath, f.payload);
  fs.unlinkSync(f.sourceFile);
  const after = JSON.parse(readProjectLibraryImport(f.payload, { filePath: snapshotPath, dataRoot: f.source,
    assetRoot: path.join(f.source, 'assets'), copyImportedAssetIntoStore() { throw new Error('local restore must not copy'); } }));
  assert.deepEqual(after, f.state, 'local hydration does not block on historical missing image');
});

test('missing external media or checksum mismatch fails explicitly without returning a partial import', (t) => {
  const missing = fixture(t);
  fs.unlinkSync(missing.sourceFile);
  assert.throws(() => missing.read(), /备份中缺少此素材文件.*未导入项目/u);
  const corrupt = fixture(t);
  fs.writeFileSync(corrupt.sourceFile, 'corrupted external image');
  assert.throws(() => corrupt.read(), /SHA-256 校验失败/u);
  assert.equal(fs.existsSync(corrupt.assetRoot), false);
});

test('failed copy/disk-full/post-write corruption never reports an import and preserves backup bytes', (t) => {
  const f = fixture(t);
  assert.throws(() => f.read({ copyImportedAssetIntoStore() { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } }), /磁盘空间不足/u);
  assert.throws(() => f.read({ copyImportedAssetIntoStore(_source, relative) {
    fs.writeFileSync(path.join(f.assetRoot, relative), 'partial'); return relative;
  } }), /写入后 SHA-256 校验失败/u);
  assert.deepEqual(fs.readFileSync(f.sourceFile), bytes);
});

test('source and destination directory junctions cannot escape their asset roots', (t) => {
  const f = fixture(t);
  const outside = path.join(f.temporary, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(f.assetRoot);
  fs.symlinkSync(outside, path.join(f.assetRoot, 'image'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.read(), /符号链接/u);
  assert.deepEqual(fs.readdirSync(outside), []);
  const s = fixture(t);
  const externalImage = path.join(s.temporary, 'escape');
  fs.renameSync(path.join(s.source, 'assets', 'image'), externalImage);
  fs.symlinkSync(externalImage, path.join(s.source, 'assets', 'image'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => s.read(), /符号链接/u);
});

test('manifest project corruption and media path traversal are refused before copying', (t) => {
  const f = fixture(t, (state) => ({ ...state, project: { ...state.project, assets: [media('../outside.png')] } }));
  assert.throws(() => f.read(), /路径无效/u);
  const g = fixture(t);
  const manifest = JSON.parse(g.payload);
  fs.writeFileSync(path.join(g.source, 'project-library', `${manifest.project.hash}.json`), '{"id":"wrong"}');
  assert.throws(() => g.read(), /完整性校验失败/u);
  assert.equal(fs.existsSync(g.assetRoot), false);
});

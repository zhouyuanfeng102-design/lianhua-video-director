import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createStateMediaExternalizer, collectStateMediaFiles } = require('../electron/stateMediaFiles.cjs');
const samples = require('./fixtures/generatedImageSamples.json');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dataUrl = (bytes = png, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
const asset = (overrides = {}) => ({ id: 'picture', name: '人物参考图', type: 'character', role: 'subject', dataUrl: dataUrl(), ...overrides });
const stateOf = (...assets) => ({ project: { id: 'active', assets }, projects: [{ id: 'active', __activeProjectReference: true }], settings: {} });
const fixture = (t, options = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-state-media-'));
  const assetRoot = path.join(directory, 'assets');
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('lianhua-state-media-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, assetRoot, ...createStateMediaExternalizer({ assetRoot, ...options }) };
};
const deepFreeze = (value) => {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
};

test('externalizes original pixels and actual type while preserving ids, bindings, names, prompts and source metadata', (t) => {
  const f = fixture(t);
  const before = deepFreeze(stateOf(asset({ fileName: 'user-named.jpeg', mimeType: 'image/jpeg',
    characterReferenceId: 'hero', sourceEntityId: 'original', sourceEntityKind: 'character',
    width: 3072, height: 2048, prompt: '精确中文\nEnglish original', sourceFingerprint: 'frozen', updatedAt: 123 })));
  const after = f.externalize(before);
  const migrated = after.project.assets[0];
  assert.notEqual(after, before);
  assert.equal(before.project.assets[0].dataUrl, dataUrl());
  assert.equal(migrated.dataUrl, undefined);
  assert.equal(migrated.relativePath, `image/${checksum(png)}.png`);
  assert.equal(migrated.url, `lianhua-asset://local/image/${checksum(png)}.png`);
  assert.equal(migrated.mimeType, 'image/png');
  assert.equal(migrated.sizeBytes, png.length);
  assert.equal(migrated.managed, true);
  assert.equal(migrated.missing, false);
  for (const key of ['id', 'name', 'fileName', 'characterReferenceId', 'sourceEntityId', 'sourceEntityKind', 'width', 'height', 'prompt', 'sourceFingerprint', 'updatedAt']) {
    assert.equal(migrated[key], before.project.assets[0][key], key);
  }
  assert.deepEqual(fs.readFileSync(path.join(f.assetRoot, migrated.relativePath)), png);
  assert.equal(after.settings, before.settings);
  assert.equal(f.externalize(after), after, 'second save is a no-op');
});

test('one durable file is reused across current/archived projects and task/result-owned frozen reference snapshots', (t) => {
  let writes = 0;
  const f = fixture(t, { atomicWriteFile(file, bytes, fileSystem) { writes += 1; fileSystem.writeFileSync(file, bytes); } });
  const inline = asset({ checksum: checksum(png) });
  const task = { id: 'video', requestBody: { originalInline: dataUrl() }, videoJob: { snapshot: { images: [{ assetId: 'picture', dataUrl: dataUrl(), freezeState: 'frozen', frozenAt: 55 }] },
    tailPreparation: { selection: { frame: { dataUrl: dataUrl(), assetId: 'tail', sourceVideoAssetId: 'video-a' } } } } };
  const before = deepFreeze({
    ...stateOf({ ...inline, imageRegenerationSnapshot: { version: 1, referenceAssetSnapshots: [inline] }, videoSourceTask: task }),
    projects: [{ id: 'archive', assets: [inline], generationTasks: [{ kind: 'image', referenceAssetSnapshots: [inline] }, task] }],
  });
  const after = f.externalize(before);
  assert.equal(writes, 1);
  const refPath = after.project.assets[0].relativePath;
  assert.equal(after.project.assets[0].imageRegenerationSnapshot.referenceAssetSnapshots[0].relativePath, refPath);
  assert.equal(after.project.assets[0].videoSourceTask.videoJob.snapshot.images[0].relativePath, refPath);
  assert.equal(after.projects[0].assets[0].relativePath, refPath);
  assert.equal(after.projects[0].generationTasks[0].referenceAssetSnapshots[0].relativePath, refPath);
  assert.equal(after.projects[0].generationTasks[1].videoJob.tailPreparation.selection.frame.relativePath, refPath);
  assert.equal(after.projects[0].generationTasks[1].videoJob.snapshot.images[0].frozenAt, 55);
  assert.equal(after.projects[0].generationTasks[1].requestBody, task.requestBody);
  assert.equal(collectStateMediaFiles(after).length, 1);
  assert.equal(f.externalize(before).project.assets[0].relativePath, refPath);
  assert.equal(writes, 1, 'existing hash-addressed file is checked and reused');
});

test('only media records change; prompts, arbitrary fields, HTTP bodies, audio and video data remain untouched', (t) => {
  const f = fixture(t);
  const before = deepFreeze({ ...stateOf(asset({ type: 'video', dataUrl: 'data:video/mp4;base64,YQ==' })),
    sourceDocuments: [{ text: dataUrl() }], payload: { dataUrl: dataUrl() },
  });
  before.project.assets[0];
  assert.equal(f.externalize(before), before);
  assert.equal(fs.existsSync(f.assetRoot), false);
  const empty = { project: { id: 'empty' }, settings: {} };
  assert.equal(f.externalize(empty), empty);
});

test('lossless migration detects PNG/JPEG/WebP/GIF bytes despite misleading filename or MIME labels', (t) => {
  const f = fixture(t);
  const formats = [['png', png, '.png'], ['jpeg', Buffer.from(samples.jpeg, 'base64'), '.jpg'],
    ['webp', Buffer.from(samples.webp, 'base64'), '.webp'],
    ['gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), '.gif']];
  for (const [name, bytes, extension] of formats) {
    const result = f.externalize(stateOf(asset({ id: name, dataUrl: dataUrl(bytes, 'application/octet-stream') }))).project.assets[0];
    assert.equal(result.relativePath, `image/${checksum(bytes)}${extension}`);
    assert.deepEqual(fs.readFileSync(path.join(f.assetRoot, result.relativePath)), bytes);
  }
});

test('inline url and percent-encoded SVG are stored as exact UTF-8 bytes, not rasterized', (t) => {
  const f = fixture(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><title>测试</title></svg>';
  const before = stateOf(asset({ dataUrl: undefined, url: `data:image/svg+xml,${encodeURIComponent(svg)}` }));
  const result = f.externalize(before).project.assets[0];
  assert.equal(result.mimeType, 'image/svg+xml');
  assert.equal(fs.readFileSync(path.join(f.assetRoot, result.relativePath), 'utf8'), svg);
});

test('corrupt base64, truncated image and mismatching frozen checksum fail without mutating state', (t) => {
  const f = fixture(t);
  for (const invalid of ['data:image/png;base64,%%%', dataUrl(png.subarray(0, 20)), 'data:image/png;base64,YR==']) {
    const before = deepFreeze(stateOf(asset({ dataUrl: invalid })));
    assert.throws(() => f.externalize(before), /内嵌图片.*保存失败.*原存档和内嵌图片未修改/u);
    assert.equal(before.project.assets[0].dataUrl, invalid);
  }
  const mismatch = deepFreeze(stateOf(asset({ checksum: 'f'.repeat(64) })));
  assert.throws(() => f.externalize(mismatch), /SHA-256 不一致/u);
  assert.equal(mismatch.project.assets[0].dataUrl, dataUrl());
});

test('incomplete disk write and ENOSPC cannot remove the source pixels or commit a bad reference', (t) => {
  const before = deepFreeze(stateOf(asset()));
  const partial = fixture(t, { atomicWriteFile(file, bytes, fileSystem) { fileSystem.writeFileSync(file, bytes.subarray(0, 10)); } });
  assert.throws(() => partial.externalize(before), /写入后 SHA-256 校验不一致/u);
  assert.equal(before.project.assets[0].relativePath, undefined);
  const full = fixture(t, { atomicWriteFile() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  assert.throws(() => full.externalize(before), (error) => error.code === 'ENOSPC' && /磁盘空间不足/u.test(error.message));
  assert.equal(before.project.assets[0].dataUrl, dataUrl());
});

test('already present corrupted content-addressed file is neither reused nor overwritten', (t) => {
  const f = fixture(t);
  const destination = path.join(f.assetRoot, 'image', `${checksum(png)}.png`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, 'original corrupt file');
  assert.throws(() => f.externalize(stateOf(asset())), /SHA-256 校验不一致/u);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'original corrupt file');
});

test('symlink/junction destinations are rejected without writing outside the assets root', (t) => {
  const f = fixture(t);
  const outside = path.join(f.directory, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(f.assetRoot);
  fs.symlinkSync(outside, path.join(f.assetRoot, 'image'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.externalize(stateOf(asset())), /符号链接/u);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('backup collection covers media-bearing records and rejects path traversal/checksum conflict', () => {
  const reference = { assetId: 'frozen', relativePath: 'image/frozen.png', checksum: 'a'.repeat(64) };
  const state = { project: { assets: [{ id: 'video', relativePath: 'video/movie.mp4' }], generationTasks: [{
    videoJob: { snapshot: { images: [reference] }, tailPreparation: { selection: { frame: { assetId: 'tail', relativePath: 'image/tail.png' } } } },
  }] } };
  assert.deepEqual(collectStateMediaFiles(state).map((file) => file.relativePath), ['video/movie.mp4', 'image/frozen.png', 'image/tail.png']);
  assert.throws(() => collectStateMediaFiles(stateOf({ relativePath: '../outside.png' })), /路径无效/u);
  assert.throws(() => collectStateMediaFiles(stateOf(reference, { ...reference, checksum: 'b'.repeat(64) })), /SHA-256 冲突/u);
});

test('storage migration does not impose the generation API 32 MiB upload quota', (t) => {
  const f = fixture(t);
  const bytes = Buffer.concat([png, Buffer.alloc(33 * 1024 * 1024)]);
  const result = f.externalize(stateOf(asset({ dataUrl: dataUrl(bytes) }))).project.assets[0];
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(fs.statSync(path.join(f.assetRoot, result.relativePath)).size, bytes.length);
  assert.equal(checksum(fs.readFileSync(path.join(f.assetRoot, result.relativePath))), checksum(bytes));
});

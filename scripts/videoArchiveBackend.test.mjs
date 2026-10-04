import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const mainPath = path.join(root, 'electron', 'main.cjs');
const require = createRequire(mainPath);
const { importVideoArchive, updateCrc32 } = require('./videoArchive.cjs');
const temporary = (t) => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-video-archive-test-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const makeZip = (entries, options = {}) => {
  const chunks = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'); const bytes = Buffer.from(entry.bytes || '');
    const method = entry.method ?? 8; const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    const flags = entry.flags ?? 0x800; const crc = entry.crc ?? updateCrc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(options.zip64 ? 45 : 20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);
    let extra = Buffer.alloc(0);
    if (options.zip64) { extra = Buffer.alloc(28); extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(bytes.length), 4); extra.writeBigUInt64LE(BigInt(compressed.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20); }
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x31e, 4); cd.writeUInt16LE(options.zip64 ? 45 : 20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(options.zip64 ? 0xffffffff : compressed.length, 20); cd.writeUInt32LE(options.zip64 ? 0xffffffff : bytes.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(extra.length, 30); cd.writeUInt32LE(entry.attributes ?? ((entry.name.endsWith('/') ? 0o040755 : 0o100644) * 65536) >>> 0, 38); cd.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 42); central.push(cd, name, extra); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central); chunks.push(directory);
  if (options.zip64) { const end = Buffer.alloc(56); end.writeUInt32LE(0x06064b50, 0); end.writeBigUInt64LE(44n, 4); end.writeUInt16LE(45, 12); end.writeUInt16LE(45, 14); end.writeBigUInt64LE(BigInt(entries.length), 24); end.writeBigUInt64LE(BigInt(entries.length), 32); end.writeBigUInt64LE(BigInt(directory.length), 40); end.writeBigUInt64LE(BigInt(offset), 48); const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16); chunks.push(end, locator); }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 10); end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12); end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16); chunks.push(end); return Buffer.concat(chunks);
};
let mp4;
const realMp4 = (directory) => {
  if (!mp4) { const target = path.join(directory, 'synthetic-source.mp4'); execFileSync(path.join(root, 'build/media-tools/win32-x64/ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=5:d=0.6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=0.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', target], { windowsHide: true }); mp4 = fs.readFileSync(target); }
  return mp4;
};
const loadMain = (t) => {
  const directory = temporary(t), paths = {};
  const electron = { app: { getPath: (name) => paths[name] || path.join(directory, name), setPath: (name, value) => { paths[name] = value; }, setAppLogsPath() {} }, BrowserWindow: class {}, dialog: {}, ipcMain: {}, net: {}, shell: {}, protocol: { registerSchemesAsPrivileged() {} }, safeStorage: { isEncryptionAvailable: () => false } };
  const context = vm.createContext({ AbortController, Buffer, URL, Response, console, setTimeout, clearTimeout, process: { argv: ['node', mainPath], env: { ...process.env, LIANHUA_DATA_DIR: path.join(directory, 'data'), LIANHUA_ALLOW_PRIVATE_NETWORK: '1' }, execPath: process.execPath, platform: process.platform, pid: process.pid }, require: (specifier) => specifier === 'electron' ? electron : require(specifier), __dirname: path.dirname(mainPath), __filename: mainPath });
  const source = fs.readFileSync(mainPath, 'utf8'); vm.runInContext(`${source.slice(0, source.indexOf("if (process.platform === 'win32')"))}\n;globalThis.harness={downloadIntoAssetStore,sniffDownloadedMediaExtension,tempRoot,assetRoot};`, context); return { ...context.harness, directory };
};
const httpFixture = async (t, bytes, contentType = 'application/zip') => { const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(bytes.length) }); res.end(bytes); }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise((resolve) => server.close(resolve))); return `http://127.0.0.1:${server.address().port}/result`; };
const standalone = (harness, bytes, extra = {}) => { const archivePath = path.join(harness.tempRoot, 'test-download.zip'); fs.writeFileSync(archivePath, bytes); return { archivePath, assetRoot: harness.assetRoot, tempRoot: harness.tempRoot, checksum: sha256(bytes), sniffMediaExtension: harness.sniffDownloadedMediaExtension, projectRoot: root, ...extra }; };
const cleanStages = (harness) => { assert.equal(fs.readdirSync(harness.tempRoot).some((name) => /^video-archive-|^download-/u.test(name)), false); const video = path.join(harness.assetRoot, 'video'); if (fs.existsSync(video)) assert.equal(fs.readdirSync(video).some((name) => name.startsWith('.archive-pending-')), false); };

test('HTTP ZIP result with Chinese paths and text extracts a real video, preserves audio/bytes and reuses exact manifest', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory);
  const zip = makeZip([{ name: '输出视频/', bytes: '', method: 0 }, { name: '输出视频/成片.mp4', bytes: source }, { name: '说明/提示词.txt', bytes: '云端说明文本，不是视频' }]);
  const url = await httpFixture(t, zip); const progress = [];
  const result = await harness.downloadIntoAssetStore(url, {}, { noTimeout: true, allowVideoArchive: true, archiveHint: true, fileName: '第一段成片', onProgress: (value) => progress.push(value) });
  assert.equal(result.mediaType, 'video'); assert.equal(result.fileName, '第一段成片.mp4'); assert.equal(result.probe.hasAudio, true); assert.equal(result.checksum, sha256(source)); assert.equal(result.additionalVideos, undefined);
  assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, result.relativePath)), source); assert.ok(progress.some((item) => item.phase === 'verifying'));
  const again = await harness.downloadIntoAssetStore(url, {}, { noTimeout: true, allowVideoArchive: true, fileName: '第一段成片' }); assert.equal(again.relativePath, result.relativePath); cleanStages(harness);
});

test('a test-only ZIP has a typed candidate-local error and the next cloud-style ZIP still imports an ordinary flags=0 MP4', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory);
  const testZip = makeZip([{ name: 'test-only.txt', bytes: 'workflow test output; no media', flags: 0 }]);
  const videoZip = makeZip([{ name: 'video_output_00001-audio.mp4', bytes: source, flags: 0, method: 8 }]);
  const firstUrl = await httpFixture(t, testZip), secondUrl = await httpFixture(t, videoZip);
  await assert.rejects(harness.downloadIntoAssetStore(firstUrl, {}, { noTimeout: true, allowVideoArchive: true, archiveHint: true }), (error) => {
    assert.equal(error.code, 'VIDEO_ARCHIVE_NO_VIDEO');
    assert.match(error.message, /当前 ZIP.*没有可用.*视频候选/u);
    assert.deepEqual(error.details, { entryCount: 1, fileCount: 1, skippedFileCount: 1, videoCandidateCount: 0 });
    assert.doesNotMatch(JSON.stringify(error.details), /test-only|workflow|https?:|token|apiKey/iu);
    return true;
  });
  assert.equal(fs.existsSync(path.join(harness.assetRoot, 'video')), false); cleanStages(harness);

  const result = await harness.downloadIntoAssetStore(secondUrl, {}, { noTimeout: true, allowVideoArchive: true, archiveHint: true });
  assert.equal(result.mediaType, 'video'); assert.equal(result.fileName, 'video_output_00001-audio.mp4');
  assert.equal(result.probe.hasAudio, true); assert.equal(result.checksum, sha256(source));
  assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, result.relativePath)), source); cleanStages(harness);
});

test('signature-detected octet-stream ZIP64 with stored/deflated multi videos returns every video, never text', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory);
  const zip = makeZip([{ name: '甲/成片.mp4', bytes: source, method: 0 }, { name: '乙/成片.mp4', bytes: source }, { name: '提示词.txt', bytes: 'text' }], { zip64: true });
  const result = await harness.downloadIntoAssetStore(await httpFixture(t, zip, 'application/octet-stream'), {}, { noTimeout: true, allowVideoArchive: true });
  assert.equal(result.additionalVideos.length, 1); assert.notEqual(result.fileName, result.additionalVideos[0].fileName);
  for (const file of [result, ...result.additionalVideos]) { assert.equal(file.probe.hasAudio, true); assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, file.relativePath)), source); }
  cleanStages(harness);
});

test('archive opt-in does not change direct MP4 and does not authorize ordinary download entries to unpack ZIP', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory);
  const result = await harness.downloadIntoAssetStore(await httpFixture(t, source, 'video/mp4'), {}, { noTimeout: true, allowVideoArchive: true });
  assert.equal(result.archiveFileName, undefined); assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, result.relativePath)), source);
  const zip = makeZip([{ name: 'video.mp4', bytes: source }]);
  await assert.rejects(harness.downloadIntoAssetStore(await httpFixture(t, zip), {}, { noTimeout: true }), /非媒体/u);
  await assert.rejects(harness.downloadIntoAssetStore(await httpFixture(t, zip, 'application/octet-stream'), {}, { noTimeout: true }), /未启用/u); cleanStages(harness);
});

test('ZIP hints and MIME never override an actual direct-video signature; unknown bytes still fail', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory);
  for (const contentType of ['application/zip', 'application/octet-stream']) {
    const result = await harness.downloadIntoAssetStore(await httpFixture(t, source, contentType), {}, { noTimeout: true, allowVideoArchive: true, archiveHint: true });
    assert.equal(result.mimeType, 'video/mp4'); assert.equal(result.archiveFileName, undefined); assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, result.relativePath)), source);
  }
  await assert.rejects(harness.downloadIntoAssetStore(await httpFixture(t, Buffer.from('not zip or media')), {}, { noTimeout: true, allowVideoArchive: true, archiveHint: true }), /不是有效 ZIP/u); cleanStages(harness);
});

test('unsafe ZIP paths, case collisions, symlinks, encryption and unsupported methods are rejected before publishing', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory);
  const badNames = ['../escape.mp4', '/abs.mp4', 'C:/drive.mp4', '\\\\server\\share.mp4', 'folder\\clip.mp4', 'clip.mp4:ads', 'NUL.mp4', 'COM¹.mp4', 'LPT².mp4', 'CLOCK$.mp4', 'CONIN$.mp4', 'CONOUT$.mp4', 'a./clip.mp4', 'a /clip.mp4', 'a\u0000.mp4'];
  for (const name of badNames) await assert.rejects(importVideoArchive(standalone(harness, makeZip([{ name, bytes: source }]))), /ZIP|invalid|absolute|backslash/u, name);
  for (const entries of [[{ name: 'A.mp4', bytes: source }, { name: 'a.mp4', bytes: source }], [{ name: 'link.mp4', bytes: source, attributes: (0o120777 * 65536) >>> 0 }], [{ name: 'video.mp4', bytes: source, flags: 0x801 }], [{ name: 'video.mp4', bytes: source, method: 12 }]]) await assert.rejects(importVideoArchive(standalone(harness, makeZip(entries))), /ZIP/u);
  assert.equal(fs.existsSync(path.join(harness.assetRoot, 'video')), false); cleanStages(harness);
});

test('CRC corruption, fake MP4, text-only archives and expansion quotas fail without media or leftover stages', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory);
  await assert.rejects(importVideoArchive(standalone(harness, makeZip([{ name: 'video.mp4', bytes: source, crc: 0 }]))), /CRC/u);
  await assert.rejects(importVideoArchive(standalone(harness, makeZip([{ name: 'video.mp4', bytes: 'not a video' }]))), /签名/u);
  await assert.rejects(importVideoArchive(standalone(harness, makeZip([{ name: 'video.mp4', bytes: source.subarray(0, 40) }]))), /完整|有效/u);
  await assert.rejects(importVideoArchive(standalone(harness, makeZip([{ name: 'prompt.txt', bytes: 'only text' }]))), /没有可用/u);
  await assert.rejects(importVideoArchive(standalone(harness, makeZip([{ name: 'a.mp4', bytes: source }]), { limits: { expandedBytes: 100 } })), /总量/u);
  await assert.rejects(importVideoArchive(standalone(harness, makeZip([{ name: 'a.txt', bytes: Buffer.alloc(100_000) }]), { limits: { ratioThreshold: 1, ratio: 2 } })), /倍率/u);
  await assert.rejects(importVideoArchive(standalone(harness, makeZip([{ name: 'a', bytes: '1' }, { name: 'b', bytes: '2' }]), { limits: { entries: 1 } })), /数量/u); cleanStages(harness);
});

test('cancelling extraction/probe removes only isolated stages and preserves pre-existing managed files', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory); const video = path.join(harness.assetRoot, 'video'); fs.mkdirSync(video); fs.writeFileSync(path.join(video, 'keep.mp4'), source);
  const controller = new AbortController();
  await assert.rejects(importVideoArchive(standalone(harness, makeZip([{ name: 'a.mp4', bytes: source }]), { signal: controller.signal, onProgress: ({ phase }) => { if (phase === 'verifying') controller.abort(); } })), /取消/u);
  assert.deepEqual(fs.readdirSync(video), ['keep.mp4']); assert.deepEqual(fs.readFileSync(path.join(video, 'keep.mp4')), source); cleanStages(harness);
});

test('cancellation in the middle of decompression releases the stream and clears all partial files', { timeout: 10_000 }, async (t) => {
  const harness = loadMain(t), controller = new AbortController();
  const zip = makeZip([{ name: 'notes.txt', bytes: Buffer.alloc(2 * 1024 * 1024, 'x') }]);
  await assert.rejects(importVideoArchive(standalone(harness, zip, { signal: controller.signal, onProgress: ({ phase }) => { if (phase === 'extracting') controller.abort(); } })), /取消/u);
  cleanStages(harness); assert.equal(fs.existsSync(path.join(harness.assetRoot, 'video')), false);
});

test('inconsistent local headers and file/directory ambiguities are rejected', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory);
  const zip = makeZip([{ name: 'a.mp4', bytes: source }]); zip.writeUInt16LE(0x801, 6);
  await assert.rejects(importVideoArchive(standalone(harness, zip)), /文件头/u);
  await assert.rejects(importVideoArchive(standalone(harness, makeZip([{ name: 'folder', bytes: 'file' }, { name: 'folder/a.mp4', bytes: source }]))), /歧义/u); cleanStages(harness);
});

test('an unfamiliar existing archive directory is not overwritten or deleted', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory), zip = makeZip([{ name: 'a.mp4', bytes: source }]);
  const existing = path.join(harness.assetRoot, 'video', `archive-${sha256(zip)}`); fs.mkdirSync(existing, { recursive: true }); fs.writeFileSync(path.join(existing, 'keep.txt'), 'user-owned');
  const result = await importVideoArchive(standalone(harness, zip)); assert.notEqual(path.dirname(path.join(harness.assetRoot, result.relativePath)), existing); assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'user-owned'); cleanStages(harness);
});

test('requested names and archive display names remain safe for Windows and checkpoint metadata', async (t) => {
  const harness = loadMain(t), source = realMp4(harness.directory), zip = makeZip([{ name: 'a.mp4', bytes: source }]);
  const result = await importVideoArchive(standalone(harness, zip, { fileName: 'CONOUT$', archiveFileName: `../unsafe\u0000\r\n${'😀'.repeat(100)}.zip` }));
  assert.equal(result.fileName, '_CONOUT$.mp4'); assert.ok(result.archiveFileName.length <= 1024); assert.doesNotMatch(result.archiveFileName, /[\u0000-\u001f\u007f/\\]/u); assert.equal(result.archiveFileName.isWellFormed(), true); cleanStages(harness);
});

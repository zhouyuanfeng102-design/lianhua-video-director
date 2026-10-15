import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { readVideoReferenceImage, storeVideoReferenceImage } from '../electron/videoReferenceImage.cjs';
import { readManagedImageDataUrl } from '../electron/imageReferenceTransport.cjs';

const root = path.resolve(import.meta.dirname, '..');
const samples = JSON.parse(fs.readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asDataUrl = (bytes, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
const fixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-video-reference-'));
  const assetRoot = path.join(directory, 'assets'); fs.mkdirSync(path.join(assetRoot, 'image'), { recursive: true });
  return { directory, assetRoot, dispose() {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('lianhua-video-reference-'));
    fs.rmSync(target, { recursive: true, force: true });
  } };
};

test('video originals and stored copies preserve real PNG/JPEG/WebP bytes and MIME', () => {
  const data = fixture();
  try {
    for (const [key, mime, extension] of [['png', 'image/png', '.png'], ['jpeg', 'image/jpeg', '.jpg'], ['webp', 'image/webp', '.webp']]) {
      const bytes = Buffer.from(samples[key], 'base64'); const checksum = hash(bytes);
      const originalPath = path.join(data.assetRoot, 'image', `original-${key}${extension}`);
      fs.writeFileSync(originalPath, bytes);
      const loaded = readVideoReferenceImage({ assetRoot: data.assetRoot,
        relativePath: `image/original-${key}${extension}`, expectedChecksum: checksum });
      assert.deepEqual(loaded, { dataUrl: asDataUrl(bytes, mime), mimeType: mime, sizeBytes: bytes.length, checksum });
      // The declared MIME and filename can be wrong; verified bytes govern the copy.
      const stored = storeVideoReferenceImage({ assetRoot: data.assetRoot, dataUrl: asDataUrl(bytes, 'image/png'), fileName: 'wrong-name.png' });
      assert.equal(stored.mimeType, mime); assert.equal(stored.fileName, `wrong-name${extension}`);
      assert.equal(stored.relativePath, `image/${checksum}${extension}`);
      assert.equal(stored.sizeBytes, bytes.length); assert.equal(stored.checksum, checksum);
      assert.equal(stored.managed, true); assert.equal(stored.missing, false);
      assert.deepEqual(fs.readFileSync(path.join(data.assetRoot, stored.relativePath)), bytes);
      assert.equal(hash(fs.readFileSync(originalPath)), checksum, 'saving a copy never overwrites the original');
      assert.deepEqual(storeVideoReferenceImage({ assetRoot: data.assetRoot, dataUrl: asDataUrl(bytes, mime), fileName: 'wrong-name.png' }), stored,
        'repeating a save verifies the content-addressed file without replacing it');
    }
    assert.deepEqual(fs.readdirSync(path.join(data.assetRoot, 'image')).filter((name) => name.endsWith('.tmp')), []);
  } finally { data.dispose(); }
});

test('video read and copy support original bytes above 32 MiB without resizing or changing the old reader', () => {
  const data = fixture();
  try {
    // A complete, decodable tiny PNG with accepted trailing padding. It tests
    // actual byte transport above the old budget without a giant pixel allocation.
    const bytes = Buffer.concat([Buffer.from(samples.png, 'base64'), Buffer.alloc(32 * 1024 * 1024, 32)]);
    const originalPath = path.join(data.assetRoot, 'image', 'large-original.png'); fs.writeFileSync(originalPath, bytes);
    const checksum = hash(bytes);
    assert.throws(() => readManagedImageDataUrl({ assetRoot: data.assetRoot, relativePath: 'image/large-original.png' }), /32 MB/u,
      'the existing general-reference budget remains intact');
    const loaded = readVideoReferenceImage({ assetRoot: data.assetRoot, relativePath: 'image/large-original.png', expectedChecksum: checksum });
    assert.equal(loaded.sizeBytes, bytes.length); assert.equal(loaded.checksum, checksum);
    assert.deepEqual(Buffer.from(loaded.dataUrl.slice(loaded.dataUrl.indexOf(',') + 1), 'base64'), bytes);
    const stored = storeVideoReferenceImage({ assetRoot: data.assetRoot, dataUrl: loaded.dataUrl, fileName: 'large-copy.png' });
    assert.equal(stored.sizeBytes, bytes.length); assert.equal(stored.checksum, checksum);
    assert.deepEqual(fs.readFileSync(path.join(data.assetRoot, stored.relativePath)), bytes);
    assert.equal(hash(fs.readFileSync(originalPath)), checksum);
  } finally { data.dispose(); }
});

test('video reads reject outside paths, damaged content and changed original checksum', () => {
  const data = fixture();
  try {
    const bytes = Buffer.from(samples.png, 'base64');
    fs.writeFileSync(path.join(data.assetRoot, 'image', 'original.png'), bytes);
    fs.writeFileSync(path.join(data.directory, 'outside.png'), bytes);
    fs.writeFileSync(path.join(data.assetRoot, 'image', 'broken.png'), bytes.subarray(0, bytes.length - 9));
    for (const relativePath of ['../outside.png', path.join(data.directory, 'outside.png'), 'image/../../outside.png']) {
      assert.throws(() => readVideoReferenceImage({ assetRoot: data.assetRoot, relativePath }), /越界|相对路径/u);
    }
    assert.throws(() => readVideoReferenceImage({ assetRoot: data.assetRoot, relativePath: 'image/original.png', expectedChecksum: '0'.repeat(64) }), /校验/u);
    assert.throws(() => readVideoReferenceImage({ assetRoot: data.assetRoot, relativePath: 'image/original.png', expectedChecksum: 'invalid' }), /校验码/u);
    assert.throws(() => readVideoReferenceImage({ assetRoot: data.assetRoot, relativePath: 'image/broken.png' }), /损坏|截断/u);
    assert.throws(() => storeVideoReferenceImage({ assetRoot: data.assetRoot, dataUrl: 'https://remote.invalid/reference.png' }), /Base64/u);
    assert.throws(() => storeVideoReferenceImage({ assetRoot: data.assetRoot, dataUrl: asDataUrl(Buffer.from('<html>error</html>')) }), /签名|格式/u);
  } finally { data.dispose(); }
});

test('video read and atomic copy support a valid original above 64 MiB without a local model-size veto', () => {
  const data = fixture();
  try {
    // Legal ancillary metadata grows a small PNG past the removed limit. It
    // remains a real, complete image rather than a sparse/truncated large file.
    const png = Buffer.from(samples.png, 'base64');
    const chunkLength = 64 * 1024 * 1024 + 1 - png.length - 12;
    const chunk = Buffer.alloc(chunkLength + 12, 65);
    chunk.writeUInt32BE(chunkLength, 0); chunk.write('tEXt', 4, 'ascii'); chunk.write('Comment\0', 8, 'ascii');
    const table = Array.from({ length: 256 }, (_, index) => {
      let crc = index; for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      return crc >>> 0;
    });
    let crc = 0xffffffff;
    for (let index = 4; index < chunk.length - 4; index += 1) crc = table[(crc ^ chunk[index]) & 255] ^ (crc >>> 8);
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
    const bytes = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
    const checksum = hash(bytes);
    const originalPath = path.join(data.assetRoot, 'image', 'above-64MiB.png'); fs.writeFileSync(originalPath, bytes);
    const loaded = readVideoReferenceImage({ assetRoot: data.assetRoot, relativePath: 'image/above-64MiB.png', expectedChecksum: checksum });
    assert.equal(loaded.sizeBytes, 64 * 1024 * 1024 + 1); assert.equal(loaded.checksum, checksum); assert.equal(loaded.mimeType, 'image/png');
    assert.equal(hash(Buffer.from(loaded.dataUrl.split(',')[1], 'base64')), checksum);
    const stored = storeVideoReferenceImage({ assetRoot: data.assetRoot, dataUrl: loaded.dataUrl, fileName: 'large-copy.png' });
    assert.equal(stored.sizeBytes, bytes.length); assert.equal(stored.checksum, checksum);
    const copyPath = path.join(data.assetRoot, stored.relativePath); const modifiedAt = fs.statSync(copyPath).mtimeMs;
    assert.equal(hash(fs.readFileSync(copyPath)), checksum);
    assert.equal(hash(fs.readFileSync(originalPath)), checksum, 'original bytes stay unchanged');
    assert.deepEqual(storeVideoReferenceImage({ assetRoot: data.assetRoot, dataUrl: loaded.dataUrl, fileName: 'large-copy.png' }), stored);
    assert.equal(fs.statSync(copyPath).mtimeMs, modifiedAt, 'existing valid copies are verified rather than rewritten');
    assert.deepEqual(fs.readdirSync(path.join(data.assetRoot, 'image')).filter((name) => name.endsWith('.tmp')), []);
  } finally { data.dispose(); }
});

test('read and copy paths follow real directories and reject junction escape', () => {
  const data = fixture();
  try {
    const outside = path.join(data.directory, 'outside'); fs.mkdirSync(outside);
    const bytes = Buffer.from(samples.png, 'base64'); fs.writeFileSync(path.join(outside, 'original.png'), bytes);
    fs.symlinkSync(outside, path.join(data.assetRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readVideoReferenceImage({ assetRoot: data.assetRoot, relativePath: 'linked/original.png' }), /真实路径越界/u);
    fs.rmdirSync(path.join(data.assetRoot, 'image'));
    fs.symlinkSync(outside, path.join(data.assetRoot, 'image'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => storeVideoReferenceImage({ assetRoot: data.assetRoot, dataUrl: asDataUrl(bytes) }), /真实路径越界/u);
    assert.deepEqual(fs.readdirSync(outside), ['original.png']);
  } finally { data.dispose(); }
});

test('an existing conflicting hash file is never overwritten', () => {
  const data = fixture();
  try {
    const bytes = Buffer.from(samples.png, 'base64'); const name = `${hash(bytes)}.png`;
    const original = Buffer.from('original remains unchanged');
    fs.writeFileSync(path.join(data.assetRoot, 'image', name), original);
    assert.throws(() => storeVideoReferenceImage({ assetRoot: data.assetRoot, dataUrl: asDataUrl(bytes) }), /校验失败.*未覆盖/u);
    assert.deepEqual(fs.readFileSync(path.join(data.assetRoot, 'image', name)), original);
  } finally { data.dispose(); }
});

test('video-image IPC checks renderer trust and ignores client asset-root overrides', async () => {
  const data = fixture();
  try {
    const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8'); const handlers = new Map();
    const rendererEntryPath = path.join(data.directory, 'dist', 'index.html');
    const trust = main.slice(main.indexOf('const trustedLoopbackHostname ='), main.indexOf('const activeModelRequests ='));
    const ipc = main.slice(main.indexOf("  handleTrustedIpc('lianhua:read-video-reference-image'"), main.indexOf("  handleTrustedIpc('lianhua:read-managed-audio-data-url'"));
    assert.ok(ipc.includes("handleTrustedIpc('lianhua:store-video-reference-image'"));
    const context = vm.createContext({ URL, fileURLToPath, isDev: false, rendererEntryPath, devServerUrl: '',
      isSamePath: (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(),
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, assetRoot: data.assetRoot,
      readVideoReferenceImage, storeVideoReferenceImage });
    vm.runInContext(`${trust}\n${ipc}`, context);
    const frame = { url: pathToFileURL(rendererEntryPath).href }; frame.top = frame;
    const foreign = { url: 'https://foreign.invalid/' }; foreign.top = foreign;
    const iframe = { url: frame.url, top: frame };
    const bytes = Buffer.from(samples.png, 'base64'); const checksum = hash(bytes);
    fs.writeFileSync(path.join(data.assetRoot, 'image', 'original.png'), bytes);
    const read = handlers.get('lianhua:read-video-reference-image'); const store = handlers.get('lianhua:store-video-reference-image');
    for (const senderFrame of [undefined, foreign, iframe]) {
      await assert.rejects(read({ senderFrame }, { relativePath: 'image/original.png' }), /不受信任/u);
      await assert.rejects(store({ senderFrame }, { dataUrl: asDataUrl(bytes) }), /不受信任/u);
    }
    const loaded = await read({ senderFrame: frame }, { assetRoot: path.join(data.directory, 'outside'), relativePath: 'image/original.png', expectedChecksum: checksum });
    assert.equal(loaded.checksum, checksum); assert.equal(loaded.sizeBytes, bytes.length);
    const stored = await store({ senderFrame: frame }, { assetRoot: path.join(data.directory, 'outside'), dataUrl: asDataUrl(bytes), fileName: '../../wrong.webp' });
    assert.equal(stored.mimeType, 'image/png'); assert.equal(stored.fileName, 'wrong.png');
    assert.ok(fs.existsSync(path.join(data.assetRoot, stored.relativePath)));
    assert.equal(fs.existsSync(path.join(data.directory, 'outside')), false);
    assert.equal(hash(fs.readFileSync(path.join(data.assetRoot, 'image', 'original.png'))), checksum);
  } finally { data.dispose(); }
});

test('preload forwards the video original reader and copy writer without thumbnail calls', async () => {
  const invocations = []; let exposed;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8'), {
    require: (name) => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
        ipcRenderer: { invoke: async (...args) => { invocations.push(args); return null; } }, webUtils: {} };
    },
  });
  const readPayload = { relativePath: 'image/original.png', expectedChecksum: 'a'.repeat(64) };
  const writePayload = { dataUrl: asDataUrl(Buffer.from(samples.png, 'base64')), fileName: 'copy.png' };
  await exposed.readVideoReferenceImage(readPayload); await exposed.storeVideoReferenceImage(writePayload);
  assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
    ['lianhua:read-video-reference-image', readPayload], ['lianhua:store-video-reference-image', writePayload],
  ]);
});

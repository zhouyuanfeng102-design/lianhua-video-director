const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { app, nativeImage } = require('electron');
const { isCompleteWebP } = require('../electron/webpValidation.cjs');
const samples = require('./fixtures/generatedImageSamples.json');

if (!nativeImage) throw new Error('Run this focused test with the bundled Electron executable, not node.');
app.disableHardwareAcceleration();
void (async () => { try {
  const image = nativeImage.createFromBitmap(Buffer.from([0x20, 0x80, 0xe0, 0xff, 0xd0, 0x40, 0x60, 0xff, 0x90, 0xc0, 0x20, 0xff, 0x10, 0x50, 0xb0, 0xff]), { width: 2, height: 2 });
  const fixtures = {
    png: image.toPNG(),
    jpeg: image.toJPEG(90),
    webp: Buffer.from(samples.webp, 'base64'),
    webpLossless: Buffer.from(samples.webpLossless, 'base64'),
    webpExtended: Buffer.from(samples.webpExtended, 'base64'),
  };
  for (const kind of ['png', 'jpeg']) assert.equal(nativeImage.createFromBuffer(Buffer.from(samples[kind], 'base64')).isEmpty(), false, `recorded ${kind} fixture must genuinely decode`);
  const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const code = mainSource.slice(mainSource.indexOf('const GENERATED_IMAGE_FORMATS ='), mainSource.indexOf('const generatedImageFileName ='));
  const decode = vm.runInNewContext(`${code}\ndecodeGeneratedImageDataUrl`, { Buffer, nativeImage, isCompleteWebP, MAX_GENERATED_IMAGE_BYTES: 32 * 1024 * 1024 });
  for (const [kind, bytes] of Object.entries(fixtures)) {
    const format = kind.startsWith('webp') ? 'webp' : kind;
    const original = Buffer.from(bytes);
    const originalImage = nativeImage.createFromBuffer(bytes);
    // WebP fixtures were fully decoded with Pillow when created. This bundled
    // nativeImage only decodes PNG/JPEG; do not mistake that API limitation for
    // invalid WebP or claim full WebP pixel validation in the main process.
    if (format !== 'webp') assert.equal(originalImage.isEmpty(), false, `${kind} fixture is a genuinely decodable SFW tiny image`);
    else assert.equal(isCompleteWebP(bytes), true);
    for (const declared of ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream']) {
      const result = decode(`data:${declared};base64,${bytes.toString('base64')}`);
      assert.equal(result.mimeType, `image/${format}`);
      assert.equal(result.extension, format === 'jpeg' ? '.jpg' : `.${format}`);
      assert.deepEqual(result.bytes, original, 'detecting MIME must not transcode or resize');
      if (format !== 'webp') assert.deepEqual(nativeImage.createFromBuffer(result.bytes).getSize(), originalImage.getSize());
    }
    assert.throws(() => decode(`data:image/png;base64,${bytes.subarray(0, Math.floor(bytes.length / 2)).toString('base64')}`), /签名|损坏|截断/u);
    assert.throws(() => decode(`data:image/png;base64,${bytes.subarray(0, bytes.length - 1).toString('base64')}`), /签名|损坏|截断/u);
    const padded = Buffer.concat([bytes, Buffer.from([0, 0, 32, 10])]);
    assert.deepEqual(decode(`data:image/png;base64,${padded.toString('base64')}`).bytes, padded, 'reasonable padding must survive unchanged');
    console.log(`ok - ${kind}, ${bytes.length} bytes, ${format === 'webp' ? 'RIFF/chunk/frame validation (fixture independently pixel-decoded)' : 'native PNG/JPEG pixel decode'}, mislabeled MIME corrected without byte changes`);
  }
  for (const bytes of [Buffer.from('{"error":"not an image"}'), Buffer.from('<html>not an image</html>'), Buffer.from([0x89, 0x50]), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.concat([fixtures.png.subarray(0, 8), fixtures.png.subarray(-12)])]) {
    assert.throws(() => decode(`data:image/png;base64,${bytes.toString('base64')}`), /签名|损坏|截断/u);
  }
  let downloadedBytes = fixtures.jpeg;
  let httpMime = 'image/png';
  let handler;
  const downloadCode = mainSource.slice(mainSource.indexOf("  handleTrustedIpc('lianhua:download-image'"), mainSource.indexOf("  handleTrustedIpc('lianhua:open-external'"));
  vm.runInNewContext(downloadCode, {
    handleTrustedIpc: (_name, callback) => { handler = callback; },
    headersObject: (headers) => headers, AbortController, setTimeout, clearTimeout,
    fetchWithLimit: async () => ({ bytes: downloadedBytes, response: { ok: true, status: 200, headers: { get: () => httpMime } } }),
    decodeGeneratedImageDataUrl: decode,
  });
  assert.ok(handler);
  for (const format of ['png', 'jpeg', 'webp']) {
    downloadedBytes = fixtures[format]; httpMime = format === 'jpeg' ? 'image/png' : 'application/octet-stream';
    const result = await handler(undefined, 'https://mock-download.invalid/image');
    assert.ok(result.startsWith(`data:image/${format};base64,`));
    assert.deepEqual(Buffer.from(result.slice(result.indexOf(',') + 1), 'base64'), downloadedBytes);
  }
  downloadedBytes = Buffer.from('<html>upstream error</html>'); httpMime = 'image/png';
  await assert.rejects(handler(undefined, 'https://mock-download.invalid/image'), /签名|图片/u);
  console.log('generated-image safety checks passed: native PNG/JPEG decode; WebP structural validation; mocked HTTP MIME correction; unchanged bytes/dimensions; malformed/truncated/error payload rejection');
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
} })();

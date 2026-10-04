const assert = require('node:assert/strict');
const { app, nativeImage } = require('electron');
const { decodeReferenceImageDataUrl, buildImageEditMultipart } = require('../electron/imageReferenceTransport.cjs');
const samples = require('./fixtures/generatedImageSamples.json');
const compatibilitySamples = require('./fixtures/referenceImageCompatibilitySamples.json');

if (!nativeImage) throw new Error('Run with the bundled Electron executable, not node.');
app.disableHardwareAcceleration();
try {
  const cases = [
    ['png', samples.png, 'image/png'],
    ['jpeg', samples.jpeg, 'image/jpeg'],
    ['metadata PNG', compatibilitySamples.pngMetadata, 'image/png'],
    ['progressive JPEG', compatibilitySamples.jpegProgressive, 'image/jpeg'],
    ['lossy WebP', samples.webp, 'image/webp'],
    ['lossless WebP', samples.webpLossless, 'image/webp'],
    ['extended WebP', samples.webpExtended, 'image/webp'],
  ];
  for (const [name, encoded, expectedMime] of cases) {
    const bytes = Buffer.from(encoded, 'base64');
    if (expectedMime !== 'image/webp') assert.equal(nativeImage.createFromBuffer(bytes).isEmpty(), false, name);
    for (const declared of ['image/png', 'image/jpeg', 'image/webp']) {
      const dataUrl = `data:${declared};base64,${encoded}`;
      const decoded = decodeReferenceImageDataUrl(dataUrl);
      assert.equal(decoded.mimeType, expectedMime);
      assert.deepEqual(decoded.bytes, bytes);
      const multipart = buildImageEditMultipart({ files: [{ name: 'image[]', fileName: 'wrong.ext', dataUrl }] });
      assert.ok(multipart.body.includes(Buffer.from(`Content-Type: ${expectedMime}\r\n\r\n`)));
      assert.ok(multipart.body.includes(bytes));
    }
    assert.throws(() => decodeReferenceImageDataUrl(`data:image/png;base64,${bytes.subarray(0, bytes.length - 1).toString('base64')}`), /损坏|截断/u);
    console.log(`PASS ${name}: corrected MIME, original bytes, complete structure${expectedMime !== 'image/webp' ? ', native pixel decode' : ''}`);
  }
  console.log('All 7 reference fixtures passed under the bundled Electron runtime; no network requests or user data accessed.');
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}

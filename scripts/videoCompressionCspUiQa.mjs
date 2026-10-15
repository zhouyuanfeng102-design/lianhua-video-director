import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Focused real-CSP regression. No real assets, accounts or generation APIs.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `video-compression-csp-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const csp = indexHtml.match(/content="(default-src[^"]*)"/u)?.[1];
assert.ok(csp, 'Use the actual application CSP');
const connectSources = csp.match(/(?:^|;)\s*connect-src\s+([^;]+)/u)?.[1];
assert.ok(connectSources && !/(?:data|blob):/u.test(connectSources), 'The regression must retain the restrictive connect-src');
const server = await createServer({ root,
  plugins: [{ name: 'compression-csp-no-watch', configResolved(config) { config.server.watch = null; } }],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.watcher.close(); await server.listen();
const origin = new URL(server.resolvedUrls.local[0]).origin;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage(); page.setDefaultTimeout(30_000);
const consoleErrors = []; const pageErrors = []; const blockedRequests = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => pageErrors.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(); const url = new URL(request.url());
  if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
    blockedRequests.push({ method: request.method(), url: request.url() }); await route.abort(); return;
  }
  if (url.pathname === '/__compression_csp_fixture.html') {
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><main>视频轻压缩 · 真实 CSP 隔离验证</main></body></html>` }); return;
  }
  await route.continue();
});
let result; let failure;
try {
  await page.goto(`${origin}/__compression_csp_fixture.html`);
  result = await page.evaluate(async () => {
    const api = await import('/src/videoReferenceCompression.ts');
    const { normalizeReferenceImageDataUrl } = await import('/src/imageReferenceData.ts');
    const MiB = 1024 * 1024;
    const digest = async (buffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map((value) => value.toString(16).padStart(2, '0')).join('');
    const asData = (blob) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
    const png = async (transparent) => {
      const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 72;
      const ctx = canvas.getContext('2d'); const image = ctx.createImageData(canvas.width, canvas.height);
      let seed = 72591;
      for (let offset = 0; offset < image.data.length; offset += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        image.data[offset] = seed & 255; image.data[offset + 1] = seed >>> 8 & 255; image.data[offset + 2] = seed >>> 16 & 255;
        image.data[offset + 3] = transparent ? Math.floor(offset / 4) % 256 : 255;
      }
      ctx.putImageData(image, 0, 0);
      return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Fixture PNG encoding failed')), 'image/png'));
    };
    const alpha = async (blob) => {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        return { width: bitmap.width, height: bitmap.height, alpha: Array.from({ length: pixels.length / 4 }, (_, index) => pixels[index * 4 + 3]) };
      } finally { bitmap.close(); }
    };
    // A valid ancillary PNG chunk grows the encoded original without enlarging
    // decoded dimensions or allocating an artificial multi-gigapixel Canvas.
    const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1; return value >>> 0; });
    const paddedPng = async (source, targetBytes) => {
      const bytes = new Uint8Array(await source.arrayBuffer());
      const chunkLength = targetBytes - bytes.length - 12;
      if (chunkLength < 8) throw new Error('Fixture padding is too short');
      const chunk = new Uint8Array(chunkLength + 12); const view = new DataView(chunk.buffer);
      view.setUint32(0, chunkLength); chunk.set([116, 69, 88, 116], 4); // tEXt
      chunk.fill(65, 8, 8 + chunkLength); chunk.set([67, 111, 109, 109, 101, 110, 116, 0], 8);
      let crc = 0xffffffff;
      for (let index = 4; index < 8 + chunkLength; index++) crc = crcTable[(crc ^ chunk[index]) & 255] ^ crc >>> 8;
      view.setUint32(8 + chunkLength, (crc ^ 0xffffffff) >>> 0);
      return new Blob([bytes.subarray(0, bytes.length - 12), chunk, bytes.subarray(bytes.length - 12)], { type: 'image/png' });
    };
    const sources = new Map(); const reads = []; const prohibited = [];
    window.lianhuaDesktop = {
      readVideoReferenceImage: async (payload) => { reads.push(payload); const source = sources.get(payload.relativePath); if (!source) throw new Error('Unknown synthetic original'); return source; },
      request: async () => { prohibited.push('desktop.request'); throw new Error('A local original must not use desktop network transport'); },
      readManagedImageDataUrl: async () => { prohibited.push('generic32MiBReader'); throw new Error('Compression must use its full-original reader'); },
      getAssetThumbnail: async () => { prohibited.push('thumbnail'); throw new Error('A thumbnail is not an original'); },
    };
    const nativeFetch = window.fetch;
    window.fetch = async () => { prohibited.push('fetch'); throw new Error('Local image compression must not use fetch'); };
    const captured = new Map(); const nativeCreate = URL.createObjectURL.bind(URL); const nativeRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = nativeCreate(blob); captured.set(url, blob); return url; };
    URL.revokeObjectURL = (url) => { captured.delete(url); nativeRevoke(url); };
    const cases = [];
    const run = async (name, original, managed, transparent) => {
      const dataUrl = await asData(original); const originalBytes = await original.arrayBuffer(); const sourceHash = await digest(originalBytes);
      const asset = { id: name, name, type: 'reference', role: 'composition', fileName: `${name}.png`, checksum: sourceHash, width: 128, height: 72, tags: [], createdAt: 1, updatedAt: 1,
        ...(managed ? { relativePath: `image/${name}.png`, url: `lianhua-asset://local/image/${name}.png`, dataUrl: 'invalid-thumbnail-must-not-be-used' } : { dataUrl }) };
      if (managed) sources.set(asset.relativePath, { dataUrl, checksum: sourceHash, sizeBytes: original.size, mimeType: original.type });
      const before = JSON.stringify(asset);
      const candidate = await api.createVideoCompressionCandidate(asset);
      try {
        const originalBlob = captured.get(candidate.originalUrl); const outputBlob = captured.get(candidate.previewUrl);
        if (!(originalBlob instanceof Blob) || !(outputBlob instanceof Blob)) throw new Error('Preview URLs must contain real original/result Blobs');
        const outputBytes = await outputBlob.arrayBuffer(); const actualOriginalHash = await digest(await originalBlob.arrayBuffer());
        const originalPixels = await alpha(originalBlob); const outputPixels = await alpha(outputBlob);
        cases.push({ name, managed, transparent, assetUnchanged: JSON.stringify(asset) === before,
          image: candidate.image, smaller: candidate.smaller, hasTransparency: candidate.hasTransparency,
          originalBytes: originalBlob.size, outputBytes: outputBlob.size, originalType: originalBlob.type, outputType: outputBlob.type,
          sourceHash, actualOriginalHash, outputHash: await digest(outputBytes),
          originalWidth: originalPixels.width, originalHeight: originalPixels.height, width: outputPixels.width, height: outputPixels.height,
          alphaMatches: JSON.stringify(originalPixels.alpha) === JSON.stringify(outputPixels.alpha) });
      } finally { api.disposeVideoCompressionCandidate(candidate); if (managed) sources.delete(asset.relativePath); }
      return dataUrl;
    };
    let ordinaryLimitError = '';
    try {
      const opaque = await png(false); const transparent = await png(true);
      await run('managed-original', opaque, true, false);
      await run('inline-original-alpha', transparent, false, true);
      const big = await paddedPng(opaque, 33 * MiB);
      const bigData = await run('managed-33MiB-metadata', big, true, false);
      try { normalizeReferenceImageDataUrl(bigData); } catch (error) { ordinaryLimitError = error.message; }
      const above64 = await paddedPng(opaque, 64 * MiB + 1);
      await run('managed-above-64MiB-metadata', above64, true, false);
      return { cases, prohibited, reads, ordinaryLimitError, capturedBlobsRemaining: captured.size };
    } finally { window.fetch = nativeFetch; URL.createObjectURL = nativeCreate; URL.revokeObjectURL = nativeRevoke; }
  });
  assert.deepEqual(result.prohibited, [], 'No fetch, desktop HTTP, generic 32MiB or thumbnail channel may read local originals');
  assert.equal(result.reads.length, 3, 'Exactly three managed originals use the dedicated IPC reader');
  assert.equal(result.cases.length, 4);
  for (const testCase of result.cases) {
    assert.equal(testCase.assetUnchanged, true, `${testCase.name}: asset metadata was changed`);
    assert.equal(testCase.sourceHash, testCase.actualOriginalHash, `${testCase.name}: original pixels changed`);
    assert.equal(testCase.image.sourceChecksum, testCase.sourceHash);
    assert.equal(testCase.image.checksum, testCase.outputHash);
    assert.equal(testCase.image.originalSizeBytes, testCase.originalBytes);
    assert.equal(testCase.image.sizeBytes, testCase.outputBytes);
    assert.equal(testCase.image.mimeType, testCase.outputType);
    assert.deepEqual([testCase.width, testCase.height], [testCase.originalWidth, testCase.originalHeight]);
    assert.deepEqual([testCase.width, testCase.height], [128, 72]);
    assert.equal(testCase.hasTransparency, testCase.transparent);
    assert.equal(testCase.alphaMatches, true, `${testCase.name}: alpha changed`);
    assert.equal(testCase.smaller, testCase.outputBytes < testCase.originalBytes);
    assert.equal(testCase.smaller, true);
  }
  assert.equal(result.cases[1].outputType, 'image/webp');
  assert.equal(result.cases[2].originalBytes, 33 * 1024 * 1024);
  assert.equal(result.cases[3].originalBytes, 64 * 1024 * 1024 + 1);
  assert.match(result.ordinaryLimitError, /32\s*MB/u, 'Unrelated ordinary-reference compatibility remains unchanged; it is not a video-image limit');
  assert.equal(result.capturedBlobsRemaining, 0, 'All preview resources are disposed');
  assert.deepEqual(consoleErrors, []); assert.deepEqual(pageErrors, []); assert.deepEqual(blockedRequests, []);
} catch (error) { failure = error; }
finally {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ csp, connectSources, result, consoleErrors, pageErrors, blockedRequests, failure: failure?.stack }, null, 2));
  await browser.close(); await server.close();
}
console.log(JSON.stringify({ output, cases: result?.cases.map(({ name, originalBytes, outputBytes, outputType }) => ({ name, originalBytes, outputBytes, outputType })), failure: failure?.message }, null, 2));
if (failure) throw failure;

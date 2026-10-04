import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const transport = await import('../electron/imageReferenceTransport.cjs').catch(() => ({}));
const samples = JSON.parse(fs.readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8'));
const pngDataUrl = `data:image/png;base64,${samples.png}`;
const webpDataUrl = `data:image/webp;base64,${samples.webp}`;
const compatibilitySamples = JSON.parse(fs.readFileSync(new URL('./fixtures/referenceImageCompatibilitySamples.json', import.meta.url), 'utf8'));

test('managed storyboard references are read only from the asset root and verified as real images', () => {
  assert.equal(typeof transport.readManagedImageDataUrl, 'function');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-reference-'));
  try {
    const assetRoot = path.join(temporaryRoot, 'assets');
    const imageDirectory = path.join(assetRoot, 'image');
    fs.mkdirSync(imageDirectory, { recursive: true });
    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const imagePath = path.join(imageDirectory, 'frame-10.png');
    fs.writeFileSync(imagePath, imageBytes);
    const checksum = createHash('sha256').update(imageBytes).digest('hex');

    const result = transport.readManagedImageDataUrl({
      assetRoot,
      relativePath: 'image/frame-10.png',
      expectedChecksum: checksum,
    });
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.checksum, checksum);
    assert.equal(result.sizeBytes, imageBytes.length);
    assert.equal(result.dataUrl, `data:image/png;base64,${imageBytes.toString('base64')}`);

    assert.throws(
      () => transport.readManagedImageDataUrl({ assetRoot, relativePath: '../outside.png' }),
      /越界|相对路径/u,
    );
    assert.throws(
      () => transport.readManagedImageDataUrl({
        assetRoot,
        relativePath: 'image/frame-10.png',
        expectedChecksum: '0'.repeat(64),
      }),
      /校验/u,
    );

    const fakeImagePath = path.join(imageDirectory, 'fake.png');
    fs.writeFileSync(fakeImagePath, Buffer.from('not an image'));
    assert.throws(
      () => transport.readManagedImageDataUrl({ assetRoot, relativePath: 'image/fake.png' }),
      /格式|签名/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('OpenAI image edits multipart preserves repeated image fields and binary bytes', () => {
  assert.equal(typeof transport.buildImageEditMultipart, 'function');
  const first = pngDataUrl;
  const second = webpDataUrl;
  const result = transport.buildImageEditMultipart({
    fields: [
      { name: 'model', value: 'gpt-image-2' },
      { name: 'prompt', value: '保持人物与画风一致' },
    ],
    files: [
      { name: 'image[]', fileName: 'reference-1.png', dataUrl: first },
      { name: 'image[]', fileName: 'reference-2.webp', dataUrl: second },
    ],
  });
  assert.ok(Buffer.isBuffer(result.body));
  assert.match(result.contentType, /^multipart\/form-data; boundary=/u);
  assert.equal(result.contentLength, result.body.length);
  const latin1 = result.body.toString('latin1');
  assert.equal((latin1.match(/name="image\[\]"/gu) || []).length, 2);
  assert.match(latin1, /name="model"\r\n\r\ngpt-image-2/u);
  assert.match(latin1, /filename="reference-1.png"/u);
  assert.ok(result.body.includes(Buffer.from(first.split(',')[1], 'base64')));
  assert.ok(result.body.includes(Buffer.from(second.split(',')[1], 'base64')));
  assert.doesNotMatch(latin1, /data:image\//u, 'base64 data URLs must be decoded before transport');
});

for (const count of [9, 13, 16, 17]) {
  test(`compatible image edits preserve all ${count} references without a local count cutoff`, () => {
    const files = Array.from({ length: count }, (_, index) => {
      const bytes = Buffer.concat([Buffer.from(samples.png, 'base64'), Buffer.alloc(index + 1, 32)]);
      return {
        name: 'image[]',
        fileName: `reference-${index + 1}.png`,
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      };
    });
    const before = structuredClone(files);
    const result = transport.buildImageEditMultipart({
      fields: [{ name: 'model', value: 'compatible-image-model' }],
      files,
    });
    const body = result.body.toString('latin1');
    assert.equal((body.match(/name="image\[\]"/gu) || []).length, count);
    let previousOffset = -1;
    for (const file of files) {
      const offset = body.indexOf(`filename="${file.fileName}"`);
      assert.ok(offset > previousOffset, 'preserve the primary/supplemental reference order');
      previousOffset = offset;
      assert.ok(result.body.includes(Buffer.from(file.dataUrl.split(',')[1], 'base64')));
    }
    assert.equal(result.contentLength, result.body.length);
    assert.deepEqual(files, before, 'transport must not mutate selected references');
  });
}

test('multipart byte budget counts fields, framing and image bytes before allocating the final body', () => {
  const input = {
    fields: [{ name: 'prompt', value: '保持人物与画风一致' }],
    files: [{ name: 'image[]', fileName: 'reference.png', dataUrl: pngDataUrl }],
  };
  const baseline = transport.buildImageEditMultipart(input);
  const exact = transport.buildImageEditMultipart(input, { maxMultipartBytes: baseline.contentLength });
  assert.equal(exact.contentLength, baseline.contentLength);
  assert.throws(
    () => transport.buildImageEditMultipart(input, { maxMultipartBytes: baseline.contentLength - 1 }),
    /multipart.*上限/u,
    'even the closing boundary must fit inside the byte budget',
  );
  assert.throws(
    () => transport.buildImageEditMultipart(input, { maxMultipartBytes: 1 }),
    /multipart.*上限/u,
    'field headers must count toward the byte budget',
  );

  // Reject as soon as one part exceeds the budget; do not parse later images
  // or allocate a combined body for a request that cannot be sent.
  const laterFile = {
    get name() { throw new Error('later reference must not be visited'); },
  };
  const firstFile = {
    name: 'image[]', fileName: 'reference.png', dataUrl: pngDataUrl,
  };
  const firstOnly = transport.buildImageEditMultipart({ files: [firstFile] });
  const boundary = firstOnly.contentType.split('boundary=')[1];
  const budgetBeforeFirstImageEnds = firstOnly.contentLength - Buffer.byteLength(`\r\n--${boundary}--\r\n`) - 1;
  assert.throws(
    () => transport.buildImageEditMultipart({ files: [firstFile, laterFile] }, {
      maxMultipartBytes: budgetBeforeFirstImageEnds,
    }),
    /multipart.*上限/u,
  );
});

test('removing the count cutoff retains per-image format and size protections', () => {
  assert.throws(
    () => transport.buildImageEditMultipart({ files: [] }),
    /缺少参考图/u,
  );
  assert.throws(
    () => transport.buildImageEditMultipart({ files: [{ name: 'image[]', dataUrl: 'data:image/png;base64,bm90IGEgcG5n' }] }),
    /格式|签名/u,
  );
  assert.throws(
    () => transport.buildImageEditMultipart({ files: [{ name: 'image[]', dataUrl: pngDataUrl }] }, {
      maxImageBytes: 8,
    }),
    /参考图片.*上限/u,
  );
});

for (const kind of ['png', 'jpeg', 'webp', 'webpLossless', 'webpExtended']) {
  test(`${kind} reference MIME is detected from complete bytes instead of the filename-derived data URL`, () => {
    const bytes = Buffer.from(samples[kind], 'base64');
    const actual = kind.startsWith('webp') ? 'webp' : kind;
    const mimeType = `image/${actual}`;
    const extension = actual === 'jpeg' ? '.jpg' : `.${actual}`;
    for (const declared of ['image/png', 'image/jpeg', 'image/webp']) {
      const dataUrl = `data:${declared};base64,${samples[kind]}`;
      const decoded = transport.decodeReferenceImageDataUrl(dataUrl);
      assert.equal(decoded.mimeType, mimeType);
      assert.equal(decoded.extension, extension);
      assert.deepEqual(decoded.bytes, bytes, 'MIME correction never resizes or re-encodes the image');
      const multipart = transport.buildImageEditMultipart({ files: [{ name: 'image[]', fileName: 'reference.wrong-extension', dataUrl }] });
      const header = multipart.body.subarray(0, multipart.body.indexOf('\r\n\r\n')).toString('utf8');
      assert.ok(header.includes(`filename="reference${extension}"`));
      assert.ok(header.includes(`Content-Type: ${mimeType}`));
      const start = multipart.body.indexOf('\r\n\r\n') + 4;
      assert.deepEqual(multipart.body.subarray(start, start + bytes.length), bytes);
    }
  });

  test(`${kind} truncated and appended error-body reference files are rejected even with a real image signature`, () => {
    const bytes = Buffer.from(samples[kind], 'base64');
    for (const truncated of [bytes.subarray(0, Math.floor(bytes.length / 2)), bytes.subarray(0, bytes.length - 1)]) {
      assert.throws(() => transport.decodeReferenceImageDataUrl(`data:image/png;base64,${truncated.toString('base64')}`), /签名|损坏|截断/u);
    }
    const polluted = Buffer.concat([bytes, Buffer.from('<html>error</html>')]);
    assert.throws(() => transport.decodeReferenceImageDataUrl(`data:image/png;base64,${polluted.toString('base64')}`), /损坏|截断/u);
    const padded = Buffer.concat([bytes, Buffer.from([0, 9, 10, 13, 32])]);
    assert.deepEqual(transport.decodeReferenceImageDataUrl(`data:image/jpeg;base64,${padded.toString('base64')}`).bytes, padded);
  });
}

test('signature-only, forged PNG CRC, unknown formats and malformed base64 remain rejected', () => {
  for (const sample of ['iVBORw0KGgo=', '/9j/2Q==', 'UklGRgAAAABXRUJQ']) {
    assert.throws(() => transport.decodeReferenceImageDataUrl(`data:image/png;base64,${sample}`), /损坏|截断/u);
  }
  const png = Buffer.from(samples.png, 'base64');
  png[29] ^= 1;
  assert.throws(() => transport.decodeReferenceImageDataUrl(`data:image/jpeg;base64,${png.toString('base64')}`), /损坏|截断/u);
  for (const invalid of ['', 'A', 'AAAA===', 'AA=A', '%%%', 'AB==', 'AAA=AAAA', `${samples.png}=`]) {
    assert.throws(() => transport.decodeReferenceImageDataUrl(`data:image/png;base64,${invalid}`), /Base64|data URL|签名/u);
  }
  assert.throws(() => transport.decodeReferenceImageDataUrl('data:image/png;base64,R0lGODlh'), /签名/u);
  assert.throws(() => transport.decodeReferenceImageDataUrl(`data:image/gif;base64,${samples.png}`), /只允许/u);
});

test('metadata PNG and progressive multi-scan JPEG remain valid references with their original pixels and metadata', () => {
  for (const [kind, expected] of [['pngMetadata', 'image/png'], ['jpegProgressive', 'image/jpeg']]) {
    const bytes = Buffer.from(compatibilitySamples[kind], 'base64');
    const result = transport.decodeReferenceImageDataUrl(`data:image/webp;base64,${bytes.toString('base64')}`);
    assert.equal(result.mimeType, expected);
    assert.deepEqual(result.bytes, bytes);
    assert.throws(() => transport.decodeReferenceImageDataUrl(`data:image/webp;base64,${bytes.subarray(0, bytes.length - 1).toString('base64')}`), /损坏|截断/u);
  }
});

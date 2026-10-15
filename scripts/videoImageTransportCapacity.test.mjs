import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { createVideoTransport, videoRequestOptions } from '../electron/videoTransport.cjs';

// Only injected transport mocks run: no sockets, credentials or paid requests.
const MiB = 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const samples = JSON.parse(fs.readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8'));
const paddedPng = (size) => {
  const png = Buffer.from(samples.png, 'base64'); const length = size - png.length - 12;
  const chunk = Buffer.alloc(length + 12, 65); chunk.writeUInt32BE(length); chunk.write('tEXt', 4, 'ascii'); chunk.write('Comment\0', 8, 'ascii');
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1;
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (let index = 4; index < chunk.length - 4; index++) crc = table[(crc ^ chunk[index]) & 255] ^ crc >>> 8;
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
};
const encodeResponse = (bytes, responseType, mimeType) => ({ body: bytes.toString(responseType === 'base64' ? 'base64' : 'utf8'), responseType, mimeType });

test('video JSON and binary bodies above 128 MiB reach the injected transport unchanged', async () => {
  const seen = []; let verify;
  const transport = createVideoTransport({
    fetchWithLimit: async (url, options, responseBudget) => {
      assert.equal(url, 'https://never-contacted.invalid/video'); assert.equal(options.noTimeout, true);
      assert.ok(options.signal instanceof AbortSignal); assert.equal(responseBudget, undefined);
      verify(options.body); seen.push(Buffer.byteLength(options.body));
      return { response: { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }, bytes: Buffer.from('{"ok":true}') };
    }, encodeResponse,
  });
  try {
    const json = `{"prompt":"${'x'.repeat(128 * MiB + 1)}"}`;
    verify = (body) => assert.equal(body, json);
    assert.equal((await transport.request({ requestId: 'large-json', url: 'https://never-contacted.invalid/video', body: json })).status, 200);
    const binary = Buffer.alloc(128 * MiB + 1, 173); const checksum = hash(binary);
    verify = (body) => { assert.ok(Buffer.isBuffer(body)); assert.equal(hash(body), checksum); assert.equal(body.length, binary.length); };
    assert.equal((await transport.request({ requestId: 'large-binary', url: 'https://never-contacted.invalid/video', method: 'PUT', bodyEncoding: 'base64', body: binary.toString('base64') })).status, 200);
    assert.ok(seen.every((size) => size > 128 * MiB)); assert.equal(seen.length, 2);
  } finally { transport.close(); }
});

test('video multipart retains an image above 32 MiB and a complete form above 128 MiB', async () => {
  const png = paddedPng(33 * MiB); const checksum = hash(png); let calls = 0;
  const transport = createVideoTransport({
    fetchWithLimit: async (_url, options) => {
      calls++;
      assert.ok(options.body.length > 128 * MiB); assert.equal(options.headers['Content-Length'], String(options.body.length));
      assert.match(options.headers['Content-Type'], /^multipart\/form-data; boundary=/u);
      const start = options.body.indexOf(png);
      assert.ok(start >= 0, 'all exact original PNG bytes reach the form');
      assert.equal(hash(options.body.subarray(start, start + png.length)), checksum);
      assert.ok(options.body.includes(Buffer.from('Content-Type: image/png\r\n')));
      assert.equal(options.noTimeout, true);
      return { response: { status: 200, headers: new Headers() }, bytes: Buffer.from('accepted') };
    }, encodeResponse,
  });
  try {
    const result = await transport.request({ requestId: 'large-multipart', url: 'https://never-contacted.invalid/upload', multipart: {
      fields: { evidence: 'x'.repeat(96 * MiB + 1) }, files: [{ fieldName: 'image', fileName: 'original.png', dataUrl: `data:image/png;base64,${png.toString('base64')}` }],
    } });
    assert.equal(result.status, 200); assert.equal(calls, 1);
  } finally { transport.close(); }
});

test('base64 original-image download opts out of the JSON response budget; validation and cancellation remain', async () => {
  const bytes = paddedPng(33 * MiB); const calls = [];
  let pendingStarted; const started = new Promise((resolve) => { pendingStarted = resolve; });
  const transport = createVideoTransport({
    fetchWithLimit: async (url, options, responseBudget) => {
      calls.push({ url, responseBudget });
      if (url.endsWith('/pending')) { pendingStarted(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })); }
      assert.equal(responseBudget, Number.POSITIVE_INFINITY);
      return { response: { status: 200, headers: new Headers({ 'content-type': 'image/png' }) }, bytes };
    }, encodeResponse,
  });
  try {
    const result = await transport.request({ requestId: 'original-download', url: 'https://never-contacted.invalid/original', method: 'GET', responseType: 'base64' });
    assert.equal(hash(Buffer.from(result.body, 'base64')), hash(bytes));
    assert.equal(calls[0].responseBudget, Number.POSITIVE_INFINITY);
    const pending = transport.request({ requestId: 'cancel-large-download', url: 'https://never-contacted.invalid/pending', method: 'GET', responseType: 'base64' });
    await started; assert.equal(transport.cancel('cancel-large-download'), true); await assert.rejects(pending, /取消|cancelled/u);
    assert.equal(calls.length, 2, 'cancellation must not retry');
    for (const body of ['%%%%', 'YWJj\n', 'YQ=', 'YQ=A', 'YR==']) assert.throws(() => videoRequestOptions({ body, bodyEncoding: 'base64' }), /Base64/u);
    assert.throws(() => videoRequestOptions({ method: 'GET', body: '{}' }), /GET\/HEAD/u);
    assert.throws(() => videoRequestOptions({ multipart: { files: [{ fieldName: 'bad\r\nfield', dataUrl: `data:image/png;base64,${samples.png}` }] } }), /字段名/u);
    assert.throws(() => videoRequestOptions({ multipart: { files: [{ fieldName: 'image', dataUrl: 'data:image/png;base64,AAAA' }] } }), /格式|签名/u);
  } finally { transport.close(); }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildLaoliVideoApiBody, uploadLaoliVideoImage } from '../src/genericVideoApi';
import { assertVideoTransportImageData, assertVideoTransportImageSource, normalizeVideoTransportImage } from '../src/videoTransportImage';
import type { ReferenceAsset } from '../src/types';
import type { VideoGenerationDraft, VideoTransportImage } from '../src/videoGenerationTypes';

const samples = JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8'));
const smallBytes = Buffer.from(samples.png, 'base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// A real PNG followed by inert bytes exercises the transport's format/signature
// normalization and byte hashing. This test does not invoke an image decoder.
const copyBytes = Buffer.alloc(65 * 1024 * 1024); smallBytes.copy(copyBytes);
const originalBytes = Buffer.alloc(66 * 1024 * 1024); smallBytes.copy(originalBytes);
const copyPixels = `data:image/png;base64,${copyBytes.toString('base64')}`;
const originalPixels = `data:image/png;base64,${originalBytes.toString('base64')}`;
const copyChecksum = sha(copyBytes), originalChecksum = sha(originalBytes);
const draft: VideoGenerationDraft = { name: '大图只读模拟', backend: 'api', prompt: '原始视频提示词保持。',
  references: [{ assetId: 'large-original', role: 'general' }], parameters: { duration: 5, resolution: '720p' } };
const body = buildLaoliVideoApiBody({ model: '3.0' }, draft, [copyPixels]);
assert.deepEqual(body.images, [copyPixels], 'classic request accepts a >64 MiB original without local 32/64 MiB checks');
assert.equal(body.prompt, draft.prompt);

const config = { baseUrl: 'https://upstream-size-fixture.invalid', endpoint: '', model: 'H3-KS' };
const upstreamError = Object.assign(new Error('HTTP 413: IMAGES_TOO_LARGE — synthetic upstream refusal'), { status: 413, code: 'IMAGES_TOO_LARGE' });
let largeInitializations = 0;
await assert.rejects(uploadLaoliVideoImage(config, copyPixels, {}, async (payload) => {
  largeInitializations += 1;
  assert.equal(payload.url, 'https://upstream-size-fixture.invalid/v1/media/uploads');
  assert.equal(payload.method, 'POST');
  assert.deepEqual(JSON.parse(payload.body!), { size: copyBytes.length, sha256: copyChecksum, mime_type: 'image/png' });
  throw upstreamError;
}), (error: unknown) => error === upstreamError, 'the actual upstream refusal is preserved, rather than replaced by a guessed model byte limit');
assert.equal(largeInitializations, 1, 'even H3 reaches mock init with >64 MiB; no local 5/30/32/64 MiB block');

const transport: VideoTransportImage = { version: 1, checksum: copyChecksum, sourceChecksum: originalChecksum,
  originalSizeBytes: originalBytes.length, sizeBytes: copyBytes.length, originalWidth: 1, originalHeight: 1, width: 1, height: 1,
  mimeType: 'image/png', quality: 0.95, relativePath: `image/${copyChecksum}.png` };
assert.deepEqual(normalizeVideoTransportImage(transport), transport);
await assertVideoTransportImageData(transport, copyPixels);
const original: ReferenceAsset = { id: 'large-original', name: '大原图', type: 'reference', role: 'composition', dataUrl: originalPixels,
  sizeBytes: originalBytes.length, width: 1, height: 1, tags: [], createdAt: 1, updatedAt: 1 };
await assertVideoTransportImageSource({ assetId: original.id, role: 'composition', transportImage: transport }, original);

const smallPixels = `data:image/png;base64,${samples.png}`;
const smallImage = { ...transport, checksum: sha(smallBytes), sizeBytes: smallBytes.length };
await assert.rejects(assertVideoTransportImageData({ ...smallImage, sizeBytes: smallBytes.length + 1 }, smallPixels), /副本记录无效/u);
await assert.rejects(assertVideoTransportImageData({ ...smallImage, checksum: 'f'.repeat(64) }, smallPixels), /副本记录无效/u);
await assert.rejects(assertVideoTransportImageData({ ...smallImage, mimeType: 'image/jpeg' }, smallPixels), /副本记录无效/u);
let emptyCalls = 0;
await assert.rejects(uploadLaoliVideoImage(config, 'data:image/png;base64,', {}, async () => { emptyCalls += 1; return {}; }));
assert.equal(emptyCalls, 0, 'empty image is still rejected before upload');

// Honor an explicit upstream chunk choice greater than the former local 8 MiB.
const source = 'https://upstream-size-fixture.invalid/assets/synthetic-image.png';
const smallSha = sha(smallBytes); const chunkRequests: string[] = [];
const uploaded = await uploadLaoliVideoImage(config, smallPixels, {}, async (payload) => {
  chunkRequests.push(`${payload.method} ${payload.url}`);
  if (payload.url.endsWith('/chunks/0')) {
    assert.equal(payload.bodyEncoding, 'base64'); assert.deepEqual(Buffer.from(payload.body!, 'base64'), smallBytes); return {};
  }
  if (payload.url.endsWith('/complete')) return { id: 'explicit-chunk', status: 'complete', type: 'image', bytes: smallBytes.length, sha256: smallSha, source };
  return { id: 'explicit-chunk', status: 'pending', bytes: smallBytes.length, sha256: smallSha,
    chunk_size: 16 * 1024 * 1024, chunk_count: 1, received: [] };
});
assert.equal(uploaded, source); assert.equal(chunkRequests.length, 3);
await assert.rejects(uploadLaoliVideoImage(config, smallPixels, {}, async () => ({ id: 'bad-count', status: 'pending', chunk_size: 16 * 1024 * 1024, chunk_count: 2 })), /分片规格无效/u);
await assert.rejects(uploadLaoliVideoImage(config, smallPixels, {}, async () => ({ id: 'bad-index', status: 'pending', chunk_size: 16 * 1024 * 1024, chunk_count: 1, received: [1] })), /分片回执无效/u);

console.log('video upstream size: >64 MiB classic request/init/copy/source hashes pass; service error preserved; explicit 16 MiB chunks honored; empty/format/MIME/hash/size/receipt guards retained; zero real requests');

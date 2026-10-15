import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInitialState } from '../src/storage';
import { preflightVideoBatchManagedReferences } from '../src/videoBatch';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { VideoDesktopRequest, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const samples = JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8'));
const smallPng = Buffer.from(samples.png, 'base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Add a valid ancillary text chunk to the tiny PNG. This exercises actual
// >64 MiB transport bytes without generating or persisting large pixel images.
const largePng = (): Buffer => {
  const output = Buffer.alloc(64 * 1024 * 1024 + 1, 0x61);
  const prefixLength = smallPng.length - 12; // Preserve the original IEND last.
  smallPng.copy(output, 0, 0, prefixLength);
  const textLength = output.length - prefixLength - 24;
  output.writeUInt32BE(textLength, prefixLength);
  output.write('tEXt', prefixLength + 4, 'ascii');
  output.write('Video fixture\0', prefixLength + 8, 'ascii');
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    table[n] = value >>> 0;
  }
  let crc = 0xffffffff;
  for (let index = prefixLength + 4; index < prefixLength + 8 + textLength; index += 1) {
    crc = table[(crc ^ output[index]) & 255] ^ crc >>> 8;
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, prefixLength + 8 + textLength);
  smallPng.copy(output, output.length - 12, smallPng.length - 12);
  return output;
};

const fixture = (bytes: Buffer, dedicated: boolean) => {
  const checksum = sha(bytes);
  const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
  const sourcePath = `image/${checksum}.png`;
  const frozenPath = `image/frozen-${checksum}.png`;
  const asset: ReferenceAsset = { id: 'model-limit-original', name: '未压缩视频参考原图', type: 'reference', role: 'composition',
    fileName: 'original.png', relativePath: sourcePath, checksum, sizeBytes: bytes.length, width: 1, height: 1,
    tags: [], createdAt: 1, updatedAt: 1 };
  let state: AppState = createInitialState();
  state.project.assets = [asset];
  state.project.generationTasks = [];
  state.settings.videoTaskApi = { ...state.settings.videoTaskApi, enabled: true, provider: 'generic',
    baseUrl: 'https://video-image-model-limit.invalid', endpoint: '', statusEndpointTemplate: '', apiKey: '', model: 'upstream-unrestricted-fixture',
    taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'download_url' };
  const beforeAsset = JSON.stringify(asset);
  const draft: VideoGenerationDraft = { backend: 'api', name: '按当前服务限制提交原图', prompt: '保留此段视频提示词。',
    references: [{ assetId: asset.id, role: 'general', slotIndex: 0 }], parameters: {} };
  const calls = { dedicatedRead: 0, dedicatedStore: 0, legacyRead: 0, legacyStore: 0, posts: 0 };
  const read = async ({ relativePath, expectedChecksum }: { relativePath: string; expectedChecksum?: string }) => {
    assert.ok(relativePath === sourcePath || relativePath === frozenPath);
    assert.equal(expectedChecksum, checksum);
    return { dataUrl, mimeType: 'image/png' as const, sizeBytes: bytes.length, checksum };
  };
  const store = async (input: { dataUrl: string }) => {
    assert.equal(input.dataUrl, dataUrl, 'the freeze stores original bytes without resizing or re-encoding');
    return { fileName: 'original.png', relativePath: frozenPath, checksum, sizeBytes: bytes.length,
      mediaType: 'image' as const, mimeType: 'image/png', managed: true, missing: false };
  };
  const desktop = {
    readManagedImageDataUrl: async (input: { relativePath: string; expectedChecksum?: string }) => {
      calls.legacyRead += 1;
      assert.equal(dedicated, false, 'video originals must prefer the video reader when available');
      return read(input);
    },
    storeGeneratedImage: async (input: { dataUrl: string }) => {
      calls.legacyStore += 1;
      assert.equal(dedicated, false, 'video originals must prefer the video store when available');
      return store(input);
    },
    ...(dedicated ? {
      readVideoReferenceImage: async (input: { relativePath: string; expectedChecksum?: string }) => {
        calls.dedicatedRead += 1; return read(input);
      },
      storeVideoReferenceImage: async (input: { dataUrl: string }) => {
        calls.dedicatedStore += 1; return store(input);
      },
    } : {}),
    setVideoTaskCredential: async () => ({ persisted: true }),
    videoRequest: async (payload: VideoDesktopRequest) => {
      assert.equal(payload.method, 'POST');
      assert.match(payload.url, /^https:\/\/video-image-model-limit\.invalid\//u);
      const body = payload.body || '';
      // Avoid parsing or keeping another 90 MiB object solely for the assertion.
      const imagesStart = body.indexOf('"images":["');
      assert.ok(imagesStart >= 0, 'the generic request contains its images array');
      const imageStart = imagesStart + '"images":["'.length;
      assert.ok(body.startsWith(dataUrl, imageStart), 'the mock upstream receives the full original, not a thumbnail');
      assert.equal(body.slice(imageStart + dataUrl.length, imageStart + dataUrl.length + 2), '"]');
      assert.ok(body.includes(draft.prompt));
      calls.posts += 1;
      return { status: 200, body: '{"id":"model-limit-mock","status":"completed","download_url":"https://model-limit-result.invalid/mock.mp4"}' };
    },
    downloadGeneratedMedia: async () => ({ fileName: 'mock.mp4', relativePath: 'video/mock.mp4', checksum: 'mock-video', sizeBytes: 200,
      mediaType: 'video' as const, managed: true, missing: false }),
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); },
    desktop, onRuntime: () => undefined, persistState: async () => {}, pollIntervalMs: 5 });
  return { engine, desktop, draft, calls, checksum, sourcePath, frozenPath, beforeAsset,
    getState: () => state, asset, assertSourceUnchanged: () => {
      assert.equal(JSON.stringify(asset), beforeAsset);
      assert.equal(sha(bytes), checksum, 'freezing never mutates the original image bytes');
    } };
};

// One large source is shared by preflight, freezing, and the mock request.
// No real desktop storage, project data, network, or paid video API is used.
{
  const bytes = largePng();
  assert.ok(bytes.length > 64 * 1024 * 1024);
  const f = fixture(bytes, true);
  try {
    assert.equal(f.draft.references[0].transportImage, undefined, 'this is an original, not a compression-copy special case');
    await preflightVideoBatchManagedReferences(f.getState(), {
      projectId: f.getState().project.id, items: [{ itemKey: 'large-original', draft: f.draft }],
    }, f.desktop);
    assert.equal(f.calls.dedicatedRead, 1, 'batch preflight uses the video reader for ordinary original references');
    assert.equal(f.calls.posts, 0, 'preflight remains read-only');
    const id = await f.engine.start(f.draft);
    const task = f.getState().project.generationTasks.find((entry) => entry.id === id) as VideoGenerationTask;
    assert.equal(task.videoJob?.stage, 'succeeded', task.error);
    const frozen = task.videoJob!.snapshot.images[0];
    assert.equal(frozen.freezeState, 'frozen');
    assert.equal(frozen.relativePath, f.frozenPath);
    assert.equal(frozen.checksum, f.checksum, 'the frozen copy keeps the exact original SHA-256');
    assert.equal(frozen.assetId, f.asset.id);
    assert.equal(frozen.transportImage, undefined);
    assert.equal(frozen.dataUrl, undefined, 'desktop task snapshots persist the managed file rather than large inline pixels');
    assert.equal(f.calls.dedicatedStore, 1);
    assert.ok(f.calls.dedicatedRead >= 2);
    assert.equal(f.calls.legacyRead, 0);
    assert.equal(f.calls.legacyStore, 0);
    assert.equal(f.calls.posts, 1);
    assert.equal(JSON.stringify(f.getState().project.assets.find((asset) => asset.id === f.asset.id)), f.beforeAsset);
    f.assertSourceUnchanged();
  } finally { f.engine.dispose(); }
}

// Preserve compatibility with old bridges using a tiny fixture, without
// allocating or resubmitting another large source.
{
  const f = fixture(smallPng, false);
  try {
    await preflightVideoBatchManagedReferences(f.getState(), {
      projectId: f.getState().project.id, items: [{ itemKey: 'legacy-original', draft: f.draft }],
    }, f.desktop);
    const id = await f.engine.start(f.draft);
    const task = f.getState().project.generationTasks.find((entry) => entry.id === id) as VideoGenerationTask;
    assert.equal(task.videoJob?.stage, 'succeeded', task.error);
    assert.ok(f.calls.legacyRead >= 2);
    assert.equal(f.calls.legacyStore, 1);
    assert.equal(f.calls.posts, 1);
    f.assertSourceUnchanged();
  } finally { f.engine.dispose(); }
}

console.log('videoImageModelLimit: >64 MiB original batch preflight and engine mock submission use video image bridges, preserve frozen SHA/originals, and retain legacy fallback');

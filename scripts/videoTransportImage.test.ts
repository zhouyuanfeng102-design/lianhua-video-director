import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInitialState, normalizeState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { preflightVideoBatchManagedReferences, videoBatchConnectionIdentity, videoBatchReferenceFingerprint, videoBatchRequestFingerprint, videoTaskRequestFingerprint } from '../src/videoBatch';
import { videoDraftReferenceAsset } from '../src/videoDirectorReferences';
import { readVideoDirectorChapterDraft } from '../src/videoDirectorDraft';
import { normalizeVideoTransportImage } from '../src/videoTransportImage';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft, VideoTransportImage, VideoDesktopRequest } from '../src/videoGenerationTypes';

const samples = JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8'));
const sourceBytes = Buffer.from(samples.png, 'base64');
const outputBytes = Buffer.from(samples.webpLossless, 'base64');
const sourcePixels = `data:image/png;base64,${samples.png}`;
const outputPixels = `data:image/webp;base64,${samples.webpLossless}`;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceChecksum = sha(sourceBytes), outputChecksum = sha(outputBytes);
const sourcePath = `image/${sourceChecksum}.png`, outputPath = `image/${outputChecksum}.webp`;
const transport: VideoTransportImage = { version: 1, relativePath: outputPath, checksum: outputChecksum, sourceChecksum,
  fileName: '视频参考轻压缩.webp', originalSizeBytes: sourceBytes.length, sizeBytes: outputBytes.length,
  originalWidth: 1, originalHeight: 1, width: 1, height: 1, mimeType: 'image/webp', quality: 0.95 };
const asset: ReferenceAsset = { id: 'original-image', name: '原人物图', type: 'reference', role: 'composition',
  relativePath: sourcePath, checksum: sourceChecksum, sizeBytes: sourceBytes.length, width: 1, height: 1, tags: [], createdAt: 1, updatedAt: 1 };
const draft: VideoGenerationDraft = { name: '本次引用轻压缩', backend: 'api', prompt: '原始视频正文与对白保持完整。',
  references: [{ assetId: asset.id, role: 'middle-frame', slotIndex: 2, characterIds: [], transportImage: transport }],
  referenceSlotRoles: ['general', 'general', 'middle-frame'], parameters: {},
  source: { chapterId: 'compression-chapter', language: 'zh', promptFormat: 'ordinary', sourceFingerprint: 'authored-source-unchanged' } };
const originalDraft = { ...draft, references: draft.references.map(({ transportImage: _transport, ...reference }) => reference) };
const originals = JSON.stringify({ asset, originalDraft });

assert.deepEqual(normalizeVideoTransportImage(transport), transport);
assert.equal(normalizeVideoTransportImage({ ...transport, version: 2 }), undefined);
assert.equal(normalizeVideoTransportImage({ ...transport, relativePath: '../outside.webp' }), undefined);
assert.equal(normalizeVideoTransportImage({ ...transport, sizeBytes: transport.originalSizeBytes }), undefined);
assert.equal(normalizeVideoTransportImage({ ...transport, width: 2 }), undefined, 'light compression cannot silently reduce/change pixel dimensions');
assert.equal(videoDraftReferenceAsset({ assets: [asset] }, draft.references[0])?.checksum, outputChecksum);
assert.equal(videoDraftReferenceAsset({ assets: [asset] }, draft.references[0])?.relativePath, outputPath);
assert.equal(videoDraftReferenceAsset({ assets: [{ ...asset, checksum: 'f'.repeat(64) }] }, draft.references[0])?.missing, true, 'a stale copy never falls back to another original');

const fixture = () => {
  let state: AppState = createInitialState();
  state.project.assets = [structuredClone(asset)];
  state.project.generationTasks = [];
  state.project.sourceDocuments = [{ id: 'compression-chapter', name: '第 1 章', content: '', order: 0, createdAt: 1, updatedAt: 1 }];
  state.project.activeChapterId = 'compression-chapter';
  state.settings.videoTaskApi = { ...state.settings.videoTaskApi, enabled: true, provider: 'generic',
    baseUrl: 'https://transport-fixture.invalid', endpoint: '', statusEndpointTemplate: '', apiKey: '', model: 'fixture-model',
    taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'download_url' };
  const requests: VideoDesktopRequest[] = [], reads: string[] = [], writes: string[] = [];
  const desktop = {
    readManagedImageDataUrl: async () => { assert.fail('compressed video copies use the dedicated video reference reader'); },
    readVideoReferenceImage: async ({ relativePath, expectedChecksum }: { relativePath: string; expectedChecksum?: string }) => {
      reads.push(relativePath);
      assert.equal(relativePath, outputPath, 'submission reads the selected copy, never the source image');
      assert.equal(expectedChecksum, outputChecksum);
      return { dataUrl: outputPixels, mimeType: 'image/webp' as const, sizeBytes: outputBytes.length, checksum: outputChecksum };
    },
    storeGeneratedImage: async () => { assert.fail('compressed video copies use the dedicated video reference store'); },
    storeVideoReferenceImage: async ({ dataUrl }: { dataUrl: string }) => {
      writes.push(dataUrl); assert.equal(dataUrl, outputPixels);
      return { fileName: '视频参考轻压缩.webp', relativePath: outputPath, checksum: outputChecksum, sizeBytes: outputBytes.length,
        mediaType: 'image' as const, mimeType: 'image/webp', managed: true, missing: false, url: `lianhua-asset://local/${outputPath}` };
    },
    setVideoTaskCredential: async () => ({ persisted: true }),
    videoRequest: async (payload: VideoDesktopRequest) => {
      requests.push(payload); assert.equal(payload.method, 'POST');
      const body = JSON.parse(payload.body!);
      assert.deepEqual(body.images, [outputPixels]); assert.equal(body.prompt, draft.prompt);
      return { status: 200, body: JSON.stringify({ id: `mock-video-${requests.length}`, status: 'completed', download_url: 'https://result-fixture.invalid/video.mp4' }) };
    },
    downloadGeneratedMedia: async () => ({ fileName: 'mock-video.mp4', relativePath: 'video/mock-video.mp4', checksum: 'mock-result', sizeBytes: 200,
      mediaType: 'video' as const, managed: true, missing: false, url: 'lianhua-asset://local/video/mock-video.mp4' }),
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); },
    desktop, onRuntime: () => undefined, persistState: async () => {}, pollIntervalMs: 5 });
  return { engine, desktop, requests, reads, writes, getState: () => state, setState: (next: AppState) => { state = next; } };
};
const task = (state: AppState, id: string) => state.project.generationTasks.find((entry) => entry.id === id) as VideoGenerationTask;
const waitFor = async (predicate: () => boolean) => {
  for (let n = 0; n < 200; n += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail('mock transport image task did not complete');
};

// Single request, immutable source, frozen copy, and explicit snapshot reuse.
{
  const f = fixture(); const connection = videoBatchConnectionIdentity(f.getState().settings, draft);
  const originalFingerprint = videoBatchRequestFingerprint(originalDraft, [asset], connection);
  const compressedFingerprint = videoBatchRequestFingerprint(draft, [asset], connection);
  assert.notEqual(compressedFingerprint, originalFingerprint, 'sending different encoded pixels changes only the request identity');
  assert.notEqual(videoBatchReferenceFingerprint(draft, [asset]), videoBatchReferenceFingerprint(originalDraft, [asset]));
  const id = await f.engine.start(draft);
  const saved = task(f.getState(), id), snapshot = saved.videoJob!.snapshot;
  assert.equal(saved.videoJob?.stage, 'succeeded');
  assert.equal(snapshot.images[0].checksum, outputChecksum); assert.equal(snapshot.images[0].relativePath, outputPath);
  assert.equal(snapshot.images[0].assetId, asset.id); assert.equal(snapshot.images[0].slotIndex, 2);
  assert.deepEqual(snapshot.images[0].characterIds, []); assert.equal(snapshot.images[0].role, 'middle-frame');
  assert.equal(snapshot.draft.source?.sourceFingerprint, draft.source?.sourceFingerprint);
  assert.equal(snapshot.draft.prompt, draft.prompt);
  assert.equal(videoTaskRequestFingerprint(saved), compressedFingerprint, 'UI and the actual frozen submission use the same checksum identity');
  assert.deepEqual(f.getState().project.assets.find((entry) => entry.id === asset.id), asset);
  const changed = structuredClone(f.getState()); changed.project.assets = changed.project.assets.filter((entry) => entry.id !== asset.id);
  f.setState(changed);
  assert.equal(videoDraftReferenceAsset(changed.project, draft.references[0], snapshot)?.checksum, outputChecksum);
  const reused = await f.engine.start({ ...snapshot.draft, reuseTaskId: id });
  assert.equal(task(f.getState(), reused).videoJob?.stage, 'succeeded');
  assert.equal(f.requests.length, 2); assert.ok(f.reads.every((path) => path === outputPath));
  f.engine.dispose();
}

// A batch preflight reads the copy; each task submits and freezes the same bytes.
{
  const f = fixture();
  const input = { projectId: f.getState().project.id, label: '轻压缩批次', items: [{ itemKey: 'copy-segment', draft }], concurrency: 1 };
  await preflightVideoBatchManagedReferences(f.getState(), input, f.desktop);
  const started = await f.engine.startBatch(input);
  await waitFor(() => task(f.getState(), started.taskIds[0])?.videoJob?.stage === 'succeeded');
  const saved = task(f.getState(), started.taskIds[0]);
  assert.equal(saved.requestFingerprint, videoBatchRequestFingerprint(draft, [asset], videoBatchConnectionIdentity(f.getState().settings, draft)));
  assert.equal(saved.videoJob?.snapshot.images[0].transportImage?.checksum, outputChecksum);
  assert.equal(f.requests.length, 1); f.engine.dispose();
}

// Inline copy tampering fails before a write, task shell, upload, or generation POST.
{
  const f = fixture();
  const invalid = { ...draft, references: [{ ...draft.references[0], transportImage: { ...transport, relativePath: undefined, dataUrl: outputPixels, checksum: 'f'.repeat(64) } }] };
  await assert.rejects(f.engine.start(invalid), /压缩副本记录无效|文件已变化/u);
  assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.getState().project.generationTasks.length, 0);
  const stale = structuredClone(f.getState()); stale.project.assets[0].checksum = 'e'.repeat(64); f.setState(stale);
  await assert.rejects(f.engine.start(draft), /原参考图已变化/u); assert.equal(f.requests.length, 0);
  f.engine.dispose();
}

// A storage receipt must confirm the bytes that were checked locally.
{
  const f = fixture();
  f.desktop.storeVideoReferenceImage = async () => ({ fileName: 'wrong.webp', relativePath: outputPath, checksum: 'f'.repeat(64),
    sizeBytes: outputBytes.length, mediaType: 'image', managed: true, missing: false });
  const id = await f.engine.start(draft);
  assert.equal(task(f.getState(), id).status, 'failed');
  assert.match(task(f.getState(), id).error || '', /压缩副本记录无效|文件已变化/u);
  assert.equal(f.requests.length, 0, 'an inconsistent storage receipt cannot authorize generation');
  f.engine.dispose();
}

// Saved chapter single/batch drafts retain request-only metadata and authored identity.
{
  const f = fixture(), state = f.getState();
  state.project.chapterWorkspaces = { 'compression-chapter': { videoDirector: { draft: structuredClone(draft), parameterText: '{}', parameterDrafts: [], generationMode: 'single',
    batch: { planId: '', backend: 'api', workflowId: '', apiProfileId: '', parameterText: '{}', parameterDrafts: [], selectedKeys: [], languages: {}, referenceOverrides: { segment: structuredClone(draft.references) },
      referenceRoleOverrides: {}, automaticTails: {}, tailCharacterModes: {}, previewSegmentId: '', previewPane: 'prompt', settingsCollapsed: false, query: '' } } } };
  const loaded = normalizeState(JSON.parse(JSON.stringify(state)));
  const persisted = readVideoDirectorChapterDraft(loaded.project.chapterWorkspaces?.['compression-chapter'].videoDirector)!;
  assert.deepEqual(persisted.draft.references[0].transportImage, transport);
  assert.deepEqual(persisted.batch?.referenceOverrides.segment[0].transportImage, transport);
  assert.equal(persisted.draft.source?.sourceFingerprint, draft.source?.sourceFingerprint);
  assert.equal(persisted.draft.references[0].assetId, asset.id);
  assert.equal(persisted.draft.references[0].slotIndex, 2);
  f.engine.dispose();
}
assert.equal(JSON.stringify({ asset, originalDraft }), originals, 'source asset and original authored draft remain immutable');
console.log('videoTransportImage: single/batch actual copy bytes, immutable source, frozen reuse, request identity and saved chapter references passed');

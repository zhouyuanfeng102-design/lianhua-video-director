import assert from 'node:assert/strict';
import {
  createImageReferenceAssetSnapshot,
  imageReferenceSnapshotAssets,
  normalizeImageReferenceAssetSnapshots,
  normalizeStoryboardImageToImageSettings,
} from '../src/imageGeneration';
import {
  appendRegeneratedImageResult,
  buildImageRegenerationTask,
  canRegenerateImageTask,
  executeImageRegeneration,
  resolveImageAssetRegenerationTask,
  resolveImageRegenerationSource,
} from '../src/imageRegeneration';
import { createImageGenerationTask } from '../src/generationTasks';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { resolveStoryboardReferenceImages } from '../src/storyboardImages';
import { storyboardReferencesAsset } from '../src/assetDeletion';
import { normalizeImageAssetRegenerationSnapshot, withDirectImageRegenerationSnapshot } from '../src/imageAssetRegenerationSnapshot';
import type { ImageGenerationTask, Project, ReferenceAsset, Storyboard } from '../src/types';

const reference = (overrides: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id: 'reference-a', name: '第 16 段 · 人物 1 完整参考图名称', type: 'character', role: 'character',
  managed: true, mediaType: 'image', relativePath: 'image/original-a.png', checksum: 'a'.repeat(64),
  sourceEntityId: 'character-a', sourceEntityKind: 'character',
  tags: [], createdAt: 1, updatedAt: 1, ...overrides,
});
const board: Storyboard = {
  id: 'board-a', sceneId: 'scene-a', workflow: 'drama', inputMode: 'reference', durationSec: 15,
  durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '2K',
  audioMode: 'stereo', stylePresetId: 'style', ruleSetId: 'timeline_director_cn', converterPresetId: 'converter',
  globalLock: '', shots: [], finalPrompt: '【0s-15s】主体：保留原 H3 画面正文。',
  officialPromptZh: 'integrated_multimodal_description: [Shot 1] 原始画面\naudio: 原始声音',
  globalReferenceAssetIds: ['video-reference-only'],
  imageToImage: {
    referenceAssetIds: ['reference-a'], selectedShotIds: ['shot-2', 'shot-4'],
    referenceAssetIdsByShotId: { 'shot-2': ['reference-a'], 'shot-4': ['reference-b'] },
  },
  createdAt: 1, updatedAt: 1,
};
const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-a', name: '独立分镜图生图', description: '', sourceDocuments: [],
  characters: [], locations: [], props: [], scenes: [], storyboards: [structuredClone(board)],
  sequencePlans: [], assets: [reference()], generationTasks: [], createdAt: 1, updatedAt: 1,
  ...overrides,
});
const snapshot = createImageReferenceAssetSnapshot(reference());
const task = (overrides: Partial<ImageGenerationTask> = {}): ImageGenerationTask => ({
  id: 'image-a', kind: 'image', name: '第 16 段 · 第 2 镜', assetKind: 'storyboard', imageVariant: 'storyboard-frame',
  imageGenerationMode: 'image-to-image', status: 'succeeded', prompt: '保存的当前分镜画面描述，不得重新转换',
  width: 3840, height: 2160, sizeOverride: true, backend: 'openai', model: 'original-image-model',
  imageApiSnapshot: {
    version: 1, profileId: 'original-profile', connectionFingerprint: 'c'.repeat(64), executionFingerprint: 'd'.repeat(64),
    config: { enabled: true, backend: 'openai', model: 'original-image-model' },
  },
  sourceStoryboardId: board.id, sourceShotId: 'shot-2', sourceFingerprint: 'image-only-source',
  referenceAssetIds: ['reference-a'], primaryReferenceAssetIds: ['reference-a'], referenceAssetSnapshots: [snapshot],
  conversionSource: '历史文本转换输入不得使用', converterSystemPrompt: '历史转换规则不得使用',
  batchId: 'direct-batch', batchIndex: 16, batchCount: 16, createdAt: 2, updatedAt: 3, ...overrides,
});

// A direct task records actual immutable locators, not a live asset id or a copy
// of a data URL / signed remote URL / arbitrary import credential properties.
const noisy = {
  ...reference(), dataUrl: 'data:image/png;base64,YQ==', url: 'https://example.invalid/image?token=secret', apiKey: 'secret',
};
const safe = createImageReferenceAssetSnapshot(noisy);
assert.equal(safe.relativePath, 'image/original-a.png');
assert.equal(safe.checksum, 'a'.repeat(64));
assert.equal(safe.name, noisy.name);
assert.equal('dataUrl' in safe, false);
assert.equal('url' in safe, false);
assert.equal('apiKey' in safe, false);
assert.equal(JSON.stringify(safe).includes('secret'), false);
assert.throws(() => createImageReferenceAssetSnapshot(reference({ relativePath: undefined, checksum: undefined })), /可校验的本地图片/u);
assert.throws(() => createImageReferenceAssetSnapshot(reference({ relativePath: '../outside.png' })), /可校验的本地图片/u);
assert.throws(() => createImageReferenceAssetSnapshot(reference({ missing: true })), /图片不存在/u);
assert.deepEqual(normalizeImageReferenceAssetSnapshots([{ ...safe, relativePath: 'C:/outside.png' }]), []);
assert.throws(() => imageReferenceSnapshotAssets(undefined), /快照缺失/u);
const persistedInline = createImageReferenceAssetSnapshot(reference({ relativePath: undefined, checksum: undefined, managed: false }), {
  relativePath: 'image/once-persisted.png', checksum: 'b'.repeat(64), mimeType: 'image/png', sizeBytes: 1024,
});
assert.equal(persistedInline.relativePath, 'image/once-persisted.png');
assert.equal('dataUrl' in persistedInline, false);
const privateSnapshot = createImageReferenceAssetSnapshot(reference({ referenceScope: 'nsfw-private-profile', nsfwPrivatePart: 'full-body' }));
assert.equal(privateSnapshot.referenceScope, 'nsfw-private-profile', 'snapshot normalization never relabels private media as ordinary');
assert.equal(privateSnapshot.nsfwPrivatePart, 'full-body');

// Image-only settings stay separate from H3/video refs. Historical per-shot
// preferences remain readable without becoming the new public picker inputs.
const normalizedSettings = normalizeStoryboardImageToImageSettings({
  referenceAssetIds: ['reference-a', 'reference-a', ' reference-b ', null],
  selectedShotIds: ['shot-2', 'shot-4', 'shot-2'],
  referenceAssetIdsByShotId: { 'shot-2': ['reference-b'], 'shot-4': [], '': ['invalid'] },
});
assert.deepEqual(normalizedSettings, {
  referenceAssetIds: ['reference-a', 'reference-b'], selectedShotIds: ['shot-2', 'shot-4'],
  referenceAssetIdsByShotId: { 'shot-2': ['reference-b'], 'shot-4': [] },
});
const initial = createInitialState();
const customTask = task({
  id: 'custom-frame', imageFrameBatchId: 'custom-batch', imageFrameIndex: 16, imageFrameCount: 16,
  imageFrameDescription: 'AI 选中的第十六张独立静帧', imageFrameTimeSec: 14.5,
});
const boundaryTasks = [task({ id: 'boundary-first', imageVariant: 'first-frame' }), task({ id: 'boundary-last', imageVariant: 'last-frame' })];
const currentProject = project({ generationTasks: [task(), customTask, ...boundaryTasks,
  task({ id: 'legacy', imageGenerationMode: undefined, referenceAssetSnapshots: undefined, batchIndex: 0, batchCount: 2 }),
] });
const state = { ...initial, project: currentProject, projects: [currentProject], activeProjectId: currentProject.id };
const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
assert.deepEqual(restored.project.storyboards[0].imageToImage, board.imageToImage);
assert.deepEqual(restored.project.storyboards[0].globalReferenceAssetIds, board.globalReferenceAssetIds);
assert.equal(restored.project.storyboards[0].finalPrompt, board.finalPrompt);
assert.equal(restored.project.storyboards[0].officialPromptZh, board.officialPromptZh);
assert.equal(storyboardReferencesAsset(restored.project.storyboards[0], 'reference-a'), false,
  'deleting an image-only selection does not rebuild or invalidate the H3/video prompt');
assert.equal(storyboardReferencesAsset(restored.project.storyboards[0], 'video-reference-only'), true,
  'actual historical video reference bindings retain their established invalidation behavior');
const restoredTask = restored.project.generationTasks.find((item) => item.id === 'image-a') as ImageGenerationTask;
assert.equal(restoredTask.imageGenerationMode, 'image-to-image');
assert.deepEqual(restoredTask.referenceAssetSnapshots, [snapshot]);
assert.deepEqual(restoredTask.imageApiSnapshot, task().imageApiSnapshot);
assert.equal(restoredTask.batchIndex, 16);
assert.equal(restoredTask.batchCount, 16);
const restoredLegacy = restored.project.generationTasks.find((item) => item.id === 'legacy') as ImageGenerationTask;
assert.equal(restoredLegacy.imageGenerationMode, undefined);
assert.equal(restoredLegacy.referenceAssetSnapshots, undefined);
assert.equal(restoredLegacy.batchIndex, 0);
const imageFrameMetadata = (item: ImageGenerationTask) => ({
  imageVariant: item.imageVariant, imageFrameBatchId: item.imageFrameBatchId,
  imageFrameIndex: item.imageFrameIndex, imageFrameCount: item.imageFrameCount,
  imageFrameDescription: item.imageFrameDescription, imageFrameTimeSec: item.imageFrameTimeSec,
});
for (const original of [customTask, ...boundaryTasks]) {
  const restoredImage = restored.project.generationTasks.find((item) => item.id === original.id) as ImageGenerationTask;
  assert.deepEqual(imageFrameMetadata(restoredImage), imageFrameMetadata(original), 'custom still and boundary identity survive serialization');
  const restoredSource = resolveImageRegenerationSource(restoredImage, project({ assets: [] }));
  const retry = buildImageRegenerationTask(restoredImage, project(), {
    id: `${original.id}-retry`, timestamp: 30, backend: 'openai', model: 'ignored-current-model', source: restoredSource,
  });
  assert.deepEqual(imageFrameMetadata(retry), imageFrameMetadata(original), 'retry preserves the exact static moment and boundary variant without replanning');
  assert.equal(retry.prompt, original.prompt);
  assert.deepEqual(retry.referenceAssetSnapshots, original.referenceAssetSnapshots);
  assert.deepEqual(retry.imageApiSnapshot, original.imageApiSnapshot);
}
const created = createImageGenerationTask({ ...task(), id: 'queued-direct' }, 10, 'queued');
assert.equal(created.imageGenerationMode, 'image-to-image');
assert.deepEqual(created.referenceAssetSnapshots, [snapshot]);
assert.equal(created.status, 'queued');

// Changing/relinking/deleting the asset card cannot substitute another image
// into a queued task. The loader receives the old path and checksum instead.
const changedProject = project({ assets: [reference({ relativePath: 'image/new-a.png', checksum: 'b'.repeat(64), name: '替换后的图' })] });
const source = resolveImageRegenerationSource(task(), changedProject);
assert.equal(source.conversionSource, '');
assert.equal(source.converterSystemPrompt, '');
assert.deepEqual(source.referenceAssetSnapshots, [snapshot]);
assert.deepEqual(resolveImageRegenerationSource(task(), project({ assets: [], storyboards: [] })), source);
let loaded = 0;
const pixels = await resolveStoryboardReferenceImages(source.referenceAssetIds, imageReferenceSnapshotAssets(source.referenceAssetSnapshots), {
  readManagedImageDataUrl: async (request) => {
    loaded += 1;
    assert.equal(request.relativePath, 'image/original-a.png');
    assert.equal(request.expectedChecksum, 'a'.repeat(64));
    return { dataUrl: 'data:image/png;base64,YQ==' };
  },
});
assert.equal(loaded, 1);
await assert.rejects(resolveStoryboardReferenceImages(source.referenceAssetIds, imageReferenceSnapshotAssets(source.referenceAssetSnapshots), {
  readManagedImageDataUrl: async () => { throw new Error('checksum mismatch'); },
}), /checksum mismatch/u);

const regenerated = buildImageRegenerationTask(task(), changedProject, {
  id: 'retry-a', timestamp: 20, backend: 'openai', model: 'new-model-must-not-replace-original', source,
});
assert.equal(regenerated.model, 'original-image-model');
assert.deepEqual(regenerated.imageApiSnapshot, task().imageApiSnapshot);
assert.deepEqual(regenerated.referenceAssetSnapshots, [snapshot]);
assert.notEqual(regenerated.referenceAssetSnapshots?.[0], source.referenceAssetSnapshots?.[0]);
let generated = 0;
const execution = await executeImageRegeneration(regenerated, {
  referenceImages: pixels, primaryReferenceImageCount: 1,
  convertPrompt: async () => { throw new Error('must not call a text API'); },
  persistPrompt: () => { throw new Error('must not rewrite the saved H3/image prompt'); },
  generateImage: async (request) => {
    generated += 1;
    assert.equal(request.prompt, task().prompt);
    assert.equal(request.width, 3840);
    assert.equal(request.height, 2160);
    assert.equal(request.sizeOverride, true);
    assert.deepEqual(request.referenceImages, pixels);
    return 'result';
  },
});
assert.equal(generated, 1);
assert.equal(execution.finalPrompt, task().prompt);
assert.throws(() => resolveImageRegenerationSource(task({ referenceAssetSnapshots: undefined }), changedProject), /快照缺失或不完整/u);
assert.throws(() => resolveImageRegenerationSource(task({ prompt: '' }), changedProject), /没有保存镜头画面描述/u);
await assert.rejects(executeImageRegeneration(task(), {
  referenceImages: [], primaryReferenceImageCount: 0,
  convertPrompt: async () => { throw new Error('must not convert'); }, persistPrompt: () => {},
  generateImage: async () => { throw new Error('must not submit without originals'); },
}), /实际读取 0 张/u);
const resultAsset = reference({ id: 'new-result', sourceStoryboardId: board.id, sourceShotId: 'shot-2', prompt: task().prompt });
const appended = appendRegeneratedImageResult(changedProject, regenerated, resultAsset);
assert.deepEqual(appended.storyboards, changedProject.storyboards, 'retry only associates the output asset: no H3 or video reference rewrites');
assert.equal(appended.assets[0].sourceShotId, 'shot-2');
assert.equal(appended.assets[1].relativePath, 'image/new-a.png');
assert.equal(appended.assets[0].imageGenerationMode, 'image-to-image');
assert.deepEqual(appended.assets[0].imageRegenerationSnapshot?.referenceAssetSnapshots, [snapshot]);

const currentApi = { enabled: true, backend: 'openai' as const, baseUrl: 'https://current.invalid', apiKey: 'never-store-current-key', model: 'later-current-model' };
const sdDefaultTask = task({
  id: 'sd-server-default', backend: 'sd_webui', model: '',
  imageApiSnapshot: { ...task().imageApiSnapshot!, config: { enabled: true, backend: 'sd_webui', model: '' } },
});
for (const original of [customTask, ...boundaryTasks, sdDefaultTask]) {
  const result = withDirectImageRegenerationSnapshot(reference({ id: `result-${original.id}`, source: 'generated' }), original);
  const noisyResult = { ...result, imageRegenerationSnapshot: {
    ...result.imageRegenerationSnapshot!, apiKey: 'forbidden-key', dataUrl: 'data:image/png;base64,forbidden',
    imageApiSnapshot: { ...result.imageRegenerationSnapshot!.imageApiSnapshot,
      config: { ...result.imageRegenerationSnapshot!.imageApiSnapshot.config, apiKey: 'nested-forbidden-key', baseUrl: 'https://secret.invalid', workflowJson: '{"apiKey":"secret"}' } },
    referenceAssetSnapshots: result.imageRegenerationSnapshot!.referenceAssetSnapshots.map((item) => ({ ...item, dataUrl: 'data:image/png;base64,forbidden', url: 'https://secret.invalid', apiKey: 'reference-secret' })),
  } };
  const resultOnlyProject = project({ assets: [noisyResult], generationTasks: [], storyboards: [] });
  const restoredResultState = normalizeState({ ...initial, project: resultOnlyProject, projects: [resultOnlyProject] });
  const restoredResult = restoredResultState.project.assets[0];
  assert.equal(restoredResult.imageGenerationMode, 'image-to-image');
  assert.equal(JSON.stringify(restoredResult.imageRegenerationSnapshot).includes('secret'), false);
  assert.equal(JSON.stringify(restoredResult.imageRegenerationSnapshot).includes('forbidden'), false);
  assert.equal(JSON.stringify(restoredResult.imageRegenerationSnapshot).includes('data:image'), false);
  const recovered = resolveImageAssetRegenerationTask(restoredResult, restoredResultState.project, currentApi)!;
  assert.equal(recovered.imageGenerationMode, 'image-to-image', 'deleting source tasks and reference cards must not downgrade result-card retries');
  assert.equal(recovered.prompt, original.prompt);
  assert.equal(recovered.model, original.model);
  assert.deepEqual(recovered.imageApiSnapshot, original.imageApiSnapshot);
  assert.deepEqual(recovered.referenceAssetSnapshots, original.referenceAssetSnapshots);
  assert.deepEqual([recovered.width, recovered.height, recovered.sizeOverride], [original.width, original.height, original.sizeOverride]);
  assert.deepEqual(imageFrameMetadata(recovered), imageFrameMetadata(original));
  const damagedModeTask = { ...original, resultAssetId: restoredResult.id, imageGenerationMode: undefined };
  assert.equal(resolveImageAssetRegenerationTask(restoredResult, { ...restoredResultState.project, generationTasks: [damagedModeTask] }, currentApi)?.imageGenerationMode,
    'image-to-image', 'an incomplete source task cannot downgrade an explicitly marked direct asset');
  assert.equal(canRegenerateImageTask(recovered, [{ ...original, id: 'already-retrying', status: 'queued', regenerationRootTaskId: original.id }]), false,
    'asset-owned root identity preserves the existing duplicate-retry guard after source deletion');
  const recoveredSource = resolveImageRegenerationSource(recovered, restoredResultState.project);
  const recoveredRetry = buildImageRegenerationTask(recovered, restoredResultState.project, {
    id: `${original.id}-result-card-retry`, timestamp: 40, backend: original.backend, model: currentApi.model, source: recoveredSource,
  });
  let conversionCalls = 0;
  await executeImageRegeneration(recoveredRetry, {
    referenceImages: pixels, primaryReferenceImageCount: 1,
    convertPrompt: async () => { conversionCalls += 1; throw new Error('must not convert'); }, persistPrompt: () => {},
    generateImage: async (request) => {
      assert.equal(request.prompt, original.prompt);
      assert.deepEqual(request.referenceImages, pixels);
      assert.deepEqual([request.width, request.height, request.sizeOverride], [original.width, original.height, original.sizeOverride]);
      return 'direct-result-card-retry';
    },
  });
  assert.equal(conversionCalls, 0);
  const repeated = appendRegeneratedImageResult(restoredResultState.project, recoveredRetry, reference({ id: `again-${original.id}` }));
  assert.deepEqual(repeated.assets[0].imageRegenerationSnapshot?.referenceAssetSnapshots, original.referenceAssetSnapshots,
    'every retry result retains its original images for another task deletion');
  assert.equal(repeated.assets[0].imageRegenerationSnapshot?.regenerationRootTaskId, original.id);
  const unavailable = { ...restoredResult, imageRegenerationSnapshot: undefined };
  assert.throws(() => resolveImageAssetRegenerationTask(unavailable, restoredResultState.project, currentApi), /快照缺失\/损坏.*不会改用/u);
  assert.throws(() => resolveImageAssetRegenerationTask({ ...restoredResult, imageRequestSize: undefined }, restoredResultState.project, currentApi), /快照缺失\/损坏/u);
  assert.throws(() => resolveImageAssetRegenerationTask({ ...restoredResult, prompt: '' }, restoredResultState.project, currentApi), /快照缺失\/损坏/u);
  assert.throws(() => resolveImageAssetRegenerationTask({ ...restoredResult, imageRegenerationSnapshot: {
    ...restoredResult.imageRegenerationSnapshot!, referenceAssetSnapshots: [],
  } }, restoredResultState.project, currentApi), /快照缺失\/损坏/u);
  const corruptedProject = project({ assets: [unavailable], generationTasks: [] });
  const corrupted = normalizeState({ ...initial, project: corruptedProject, projects: [corruptedProject], activeProjectId: corruptedProject.id });
  assert.equal(corrupted.project.assets[0].imageGenerationMode, 'image-to-image', 'malformed snapshots never erase the direct marker');
  assert.throws(() => resolveImageAssetRegenerationTask(corrupted.project.assets[0], corrupted.project, currentApi), /快照缺失\/损坏/u);
}
assert.equal(normalizeImageAssetRegenerationSnapshot({ version: 99 }), undefined);
assert.equal(normalizeImageAssetRegenerationSnapshot({ version: 1, model: '',
  imageApiSnapshot: task().imageApiSnapshot, referenceAssetSnapshots: [snapshot],
}), undefined, 'Images API still requires a saved model; only SD WebUI permits its server-default checkpoint');
const oldResult = reference({ id: 'old-unmarked', source: 'generated', prompt: '历史文生图提示词' });
assert.equal(resolveImageAssetRegenerationTask(oldResult, project({ assets: [oldResult] }), currentApi)?.imageGenerationMode, undefined,
  'unmarked legacy assets are not guessed or migrated from prompt text');
const oldDirectResult = reference({ id: 'old-direct-result' });
const oldDirectTask = task({ resultAssetId: oldDirectResult.id });
assert.equal(resolveImageAssetRegenerationTask(oldDirectResult, project({ assets: [oldDirectResult], generationTasks: [oldDirectTask] }), currentApi), oldDirectTask,
  'existing 0.8.9 direct task records remain authoritative without forcing asset migration');

console.log('storyboard image-to-image state, immutable references and direct retry tests passed');

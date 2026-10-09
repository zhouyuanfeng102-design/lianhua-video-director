import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createInitialState, normalizeState, serializeStateForStorage, type ManagedMediaResult } from '../src/storage';
import { createImageGenerationTask } from '../src/generationTasks';
import { normalizePrivateFullBodyOutputSize, resolveImageOutputSize } from '../src/imageOutputSize';
import { resolveStoryboardImageOutputSize } from '../src/storyboardImageOutputSize';
import { assertImageResolutionPlanForConfig } from '../src/imageResolution';
import { buildImageRegenerationTask, executeImageRegeneration, resolveImageAssetRegenerationTask, resolveImageRegenerationSource } from '../src/imageRegeneration';
import { createStoryboardImageBatchLifecycle } from '../src/storyboardImages';
import { generateDirectStoryboardImages, type DirectStoryboardImageGenerationContext } from '../src/storyboardImageToImageGeneration';
import type { AppState, ImageApiConfig, ImageGenerationTask, ReferenceAsset, Storyboard, VideoShot } from '../src/types';

// Synthetic fixtures only. This suite never loads a real project or calls an API.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const gemini: ImageApiConfig = {
  enabled: true, backend: 'openai', baseUrl: 'https://fixture-image.invalid', apiKey: 'synthetic-fixture-key',
  model: 'gemini-3-pro-image-preview', imageProtocol: 'gemini', imageResolutionProfile: 'gemini-k',
};
const preferences = {
  ordinary: { mode: '4k' as const, aspect: '9:16' as const, width: 3072, height: 5504, resolutionVersion: 1 as const },
  private: { mode: '2k' as const, aspect: 'variant' as const, width: 1696, height: 2528, resolutionVersion: 1 as const },
};
const ordinarySize = resolveImageOutputSize(preferences.ordinary, { width: 1024, height: 1024 }, gemini, 'portrait');
const privateSize = resolveImageOutputSize({ ...preferences.private, mode: '4k' }, { width: 1024, height: 1536 }, gemini, 'private-full-body');
assert.equal(ordinarySize.issue, '');
assert.equal(privateSize.issue, '');
assert.deepEqual([ordinarySize.width, ordinarySize.height], [3072, 5504]);
assert.deepEqual([privateSize.width, privateSize.height], [3392, 5056]);
assert.deepEqual(ordinarySize.resolutionPlan?.encoding, { kind: 'tier', value: '4K' });
assert.deepEqual(normalizePrivateFullBodyOutputSize(3392, 5056), { width: 3392, height: 5056 },
  'known native 2:3 dimensions must not be forced through an exact-ratio legacy correction');

const initial = createInitialState();
const ordinaryTask = createImageGenerationTask({
  id: 'resolution-ordinary', name: 'Synthetic ordinary image', assetKind: 'character', imageVariant: 'portrait',
  prompt: 'Saved synthetic portrait', width: ordinarySize.width, height: ordinarySize.height,
  sizeOverride: true, resolutionPlan: ordinarySize.resolutionPlan, backend: 'openai', model: gemini.model,
  conversionSource: 'Frozen synthetic facts', converterSystemPrompt: 'Frozen synthetic rules',
}, 1, 'succeeded');
const privateTask = createImageGenerationTask({
  id: 'resolution-private', name: 'Synthetic private image', assetKind: 'character', imageVariant: 'private-full-body',
  referenceScope: 'nsfw-private-profile', nsfwPrivatePart: 'full-body', prompt: 'Saved synthetic full-body reference',
  width: privateSize.width, height: privateSize.height, sizeOverride: true, resolutionPlan: privateSize.resolutionPlan,
  backend: 'openai', model: gemini.model, conversionSource: 'Frozen synthetic private facts', converterSystemPrompt: 'Frozen synthetic private rules',
}, 2, 'queued');
const makeResult = (id: string, task: ImageGenerationTask): ReferenceAsset => ({
  id, name: task.name, type: 'character', role: 'character', mediaType: 'image', source: 'generated',
  dataUrl: png, width: 2, height: 2, prompt: task.prompt, imageVariant: task.imageVariant,
  imageBackend: task.backend, imagePromptFormat: 'natural-language',
  referenceScope: task.referenceScope, nsfwPrivatePart: task.nsfwPrivatePart,
  imageRequestSize: { width: task.width, height: task.height, sizeOverride: task.sizeOverride, resolutionPlan: task.resolutionPlan },
  tags: [], createdAt: 1, updatedAt: 1,
});
const project = {
  ...initial.project, id: 'resolution-storage-fixture', name: 'Synthetic resolution fixture',
  characters: [], locations: [], props: [], scenes: [], storyboards: [],
  generationTasks: [ordinaryTask, privateTask], assets: [makeResult('ordinary-result', ordinaryTask), makeResult('private-result', privateTask)],
};
const state: AppState = { ...initial, project, projects: [project], activeProjectId: project.id,
  settings: { ...initial.settings, imageApi: gemini, imageApiProfiles: [], activeImageApiProfileId: null,
    privateImageApiProfileId: null, imageOutputSizes: clone(preferences), storyboardImageOutputSize: { mode: '4k', width: 3072, height: 5504, resolutionVersion: 1 } },
};
const restore = (input: AppState): AppState => normalizeState(JSON.parse(serializeStateForStorage(input).serialized));
const restored = restore(state);
assert.deepEqual(restored.settings.imageOutputSizes, preferences, 'ordinary and private resolution preferences persist independently');
assert.notStrictEqual(restored.settings.imageOutputSizes?.ordinary, restored.settings.imageOutputSizes?.private);
assert.equal(restored.settings.imageApi.imageProtocol, 'gemini');
assert.equal(restored.settings.imageApi.imageResolutionProfile, 'gemini-k');
assert.deepEqual(restored.settings.storyboardImageOutputSize, state.settings.storyboardImageOutputSize);
for (const original of [ordinaryTask, privateTask]) {
  const loaded = restored.project.generationTasks.find((task): task is ImageGenerationTask => task.kind === 'image' && task.id === original.id)!;
  assert.deepEqual([loaded.width, loaded.height], [original.width, original.height]);
  assert.deepEqual(loaded.resolutionPlan, original.resolutionPlan);
  assert.equal(loaded.sizeOverride, true);
  assert.equal(loaded.converterSystemPrompt, original.converterSystemPrompt);
}
assert.equal(restored.project.generationTasks.find((task) => task.id === privateTask.id)?.status, 'failed',
  'interrupted local generation restores as failed while retaining its frozen plan');

// Damaged explicit plans must remain unavailable, rather than turning into
// unplanned legacy requests after loading. Unknown connection fields are removed.
const damaged = clone(state);
(damaged.project.generationTasks[0] as unknown as { resolutionPlan: unknown }).resolutionPlan = { version: 99, apiKey: 'fixture-not-a-real-key' };
damaged.project.assets[0].imageRequestSize!.resolutionPlan = { version: 99, apiKey: 'fixture-not-a-real-key' } as never;
const damagedRestored = restore(damaged);
const damagedTask = damagedRestored.project.generationTasks[0] as ImageGenerationTask;
assert.ok(damagedTask.resolutionPlan);
assert.throws(() => assertImageResolutionPlanForConfig(damagedTask.resolutionPlan!, gemini), /分辨率计划无效/u);
assert.ok(!JSON.stringify(damagedTask.resolutionPlan).includes('apiKey'));
assert.throws(() => resolveImageAssetRegenerationTask(damagedRestored.project.assets[0],
  { ...damagedRestored.project, generationTasks: [] }, gemini), /计划损坏|不一致/u);

// The returned thumbnail is 2×2. Recovery must use the saved request, never the
// actual thumbnail size, the old 4096 cap, or the user's new 1K selection.
restored.settings.imageOutputSizes!.ordinary.mode = '1k';
assert.equal(restored.settings.imageOutputSizes!.private.mode, '2k');
const resultOnlyProject = { ...restored.project, generationTasks: [] };
for (const result of resultOnlyProject.assets) {
  const expected = result.imageRequestSize!;
  assert.ok(expected.width > 4096 || expected.height > 4096);
  const recovered = resolveImageAssetRegenerationTask(result, resultOnlyProject, { ...gemini, model: 'later-model' });
  assert.ok(recovered);
  assert.deepEqual([recovered.width, recovered.height], [expected.width, expected.height]);
  assert.deepEqual(recovered.resolutionPlan, expected.resolutionPlan);
  assert.equal(recovered.sizeOverride, true);
  const retry = buildImageRegenerationTask(recovered, resultOnlyProject, {
    id: `retry-${result.id}`, timestamp: 10, backend: recovered.backend, model: 'later-model',
    source: { conversionSource: 'Synthetic frozen facts', converterSystemPrompt: 'Synthetic frozen rules', referenceAssetIds: [], primaryReferenceAssetIds: [] },
  });
  assert.deepEqual([retry.width, retry.height], [expected.width, expected.height]);
  assert.deepEqual(retry.resolutionPlan, expected.resolutionPlan);
  let submitted = 0;
  await executeImageRegeneration(retry, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => { throw new Error('A saved prompt must not require conversion'); }, persistPrompt: () => {},
    generateImage: async (input) => {
      submitted++;
      assert.deepEqual([input.width, input.height], [expected.width, expected.height]);
      assert.deepEqual(input.resolutionPlan, expected.resolutionPlan);
      return { dataUrl: png };
    },
  });
  assert.equal(submitted, 1);
}

const shot: VideoShot = {
  id: 'resolution-shot', index: 1, startSec: 0, endSec: 3, purpose: '固定静帧', subject: '一尊石雕',
  action: '石雕静止', camera: '中景平视', transition: 'cut', lighting: '自然光', sound: '', dialogue: '',
  result: '石雕保持静止', referenceAssetIds: [], prompt: '', locked: false,
};
const board: Storyboard = {
  id: 'resolution-board', sceneId: 'synthetic-scene', workflow: 'drama', inputMode: 'reference',
  durationSec: 3, durationPreset: 'custom', shotMode: 'exact', shotCount: 1, pace: 'standard',
  aspectRatio: '9:16', resolution: '2K', audioMode: 'stereo', stylePresetId: 'cinematic',
  ruleSetId: 'h3', converterPresetId: 'h3', globalLock: '固定石雕', shots: [shot],
  finalPrompt: 'Synthetic frozen H3', officialPromptZh: '[Shot 1] At 00:00.000, 一尊石雕位于庭院，保持中景平视。',
  imageToImage: { referenceAssetIds: ['direct-reference'], selectedShotIds: [shot.id] }, createdAt: 1, updatedAt: 1,
};
const reference: ReferenceAsset = { id: 'direct-reference', name: 'Synthetic original pixels', type: 'reference', role: 'character',
  mediaType: 'image', referenceScope: 'general', dataUrl: png, tags: [], createdAt: 1, updatedAt: 1 };
const directProject = { ...initial.project, id: 'resolution-direct-fixture', name: 'Synthetic direct fixture',
  characters: [], locations: [], props: [], scenes: [], assets: [reference], storyboards: [board], generationTasks: [] };
let directState: AppState = { ...initial, project: directProject, projects: [directProject], activeProjectId: directProject.id,
  settings: { ...state.settings, textApi: { ...initial.settings.textApi, enabled: false, baseUrl: '', apiKey: '', model: '' },
    storyboardImageOutputSize: { mode: '4k', width: 1024, height: 1024, resolutionVersion: 1 } },
};
const media = new Map<string, { dataUrl: string; checksum: string }>();
const notices: string[] = [];
let directSubmissions = 0;
let textCalls = 0;
const update: DirectStoryboardImageGenerationContext['update'] = (updater) => { directState = updater(directState); };
const ctx: DirectStoryboardImageGenerationContext = {
  getState: () => directState, update, updateBackground: update, lifecycle: createStoryboardImageBatchLifecycle(),
  loader: { readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
    const saved = media.get(relativePath);
    assert.ok(saved);
    assert.equal(saved.checksum, expectedChecksum);
    return saved.dataUrl;
  } },
  storeImage: async (payload): Promise<ManagedMediaResult> => {
    const checksum = createHash('sha256').update(payload.dataUrl).digest('hex');
    const relativePath = `images/${checksum}.png`;
    media.set(relativePath, { dataUrl: payload.dataUrl, checksum });
    return { relativePath, checksum, fileName: payload.fileName || 'synthetic.png', managed: true, missing: false,
      sizeBytes: payload.dataUrl.length, mediaType: 'image', mimeType: 'image/png', url: `lianhua-asset://fixture/${relativePath}` };
  },
  generateImage: async (_api, input, onStart) => {
    assert.equal(typeof input, 'object');
    if (typeof input !== 'object') throw new Error('Expected a structured direct image request');
    await onStart?.();
    directSubmissions++;
    assert.deepEqual([input.width, input.height], [3072, 5504]);
    assert.deepEqual(input.resolutionPlan, ordinarySize.resolutionPlan);
    assert.deepEqual(input.referenceImages, [png]);
    assert.equal(input.preserveReferenceImageOrder, true);
    return { dataUrl: png };
  },
  requestText: async () => { textCalls++; throw new Error('Direct image generation must not call a text API'); },
  convertPrompt: async () => { textCalls++; throw new Error('Direct image generation must not invoke a converter'); },
  planFrames: async () => { textCalls++; throw new Error('Selected direct shots do not require a text frame plan'); },
  notify: (message) => { notices.push(message); },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Real network requests are forbidden in this synthetic persistence test'); };
try {
  await generateDirectStoryboardImages(ctx, directProject.id, board.id, { mode: 'selected-shots', shotIds: [shot.id] });
  assert.equal(directSubmissions, 1, notices.join('\n'));
  assert.equal(textCalls, 0);
  const directTask = directState.project.generationTasks.find((task): task is ImageGenerationTask => task.kind === 'image')!;
  assert.equal(directTask.status, 'succeeded', notices.join('\n'));
  assert.equal(directTask.imageGenerationMode, 'image-to-image');
  assert.deepEqual(directTask.resolutionPlan, ordinarySize.resolutionPlan);
  assert.equal(directState.project.storyboards[0].finalPrompt, board.finalPrompt);
  const directRestored = restore(directState);
  const directResult = directRestored.project.assets.find((result) => result.id === directTask.resultAssetId)!;
  assert.deepEqual(directResult.imageRequestSize?.resolutionPlan, ordinarySize.resolutionPlan);
  assert.deepEqual([directResult.imageRequestSize?.width, directResult.imageRequestSize?.height], [3072, 5504]);
  const directResultOnly = { ...directRestored.project, generationTasks: [] };
  const recovered = resolveImageAssetRegenerationTask(directResult, directResultOnly, gemini)!;
  assert.ok(recovered);
  assert.equal(recovered.imageGenerationMode, 'image-to-image');
  assert.deepEqual(recovered.resolutionPlan, ordinarySize.resolutionPlan);
  const retry = buildImageRegenerationTask(recovered, directResultOnly, {
    id: 'direct-resolution-retry', timestamp: 20, backend: 'openai', model: 'later-model',
    source: resolveImageRegenerationSource(recovered, directResultOnly),
  });
  assert.equal(retry.imageGenerationMode, 'image-to-image');
  assert.equal(retry.model, gemini.model);
  assert.deepEqual(retry.resolutionPlan, ordinarySize.resolutionPlan);
  assert.deepEqual([retry.width, retry.height], [3072, 5504]);
  await executeImageRegeneration(retry, {
    referenceImages: [png], primaryReferenceImageCount: 1,
    convertPrompt: async () => { textCalls++; throw new Error('Direct retry must remain direct'); }, persistPrompt: () => {},
    generateImage: async (input) => {
      assert.deepEqual(input.resolutionPlan, ordinarySize.resolutionPlan);
      assert.deepEqual([input.width, input.height], [3072, 5504]);
      assert.deepEqual(input.referenceImages, [png]);
      return { dataUrl: png };
    },
  });
  assert.equal(textCalls, 0);
} finally {
  globalThis.fetch = originalFetch;
}
assert.deepEqual(resolveStoryboardImageOutputSize({ mode: '4k', width: 1024, height: 1024, resolutionVersion: 1 }, '9:16', gemini).resolutionPlan, ordinarySize.resolutionPlan);
console.log('image resolution persistence: native K plans, independent preferences, result-only recovery and direct retries passed');

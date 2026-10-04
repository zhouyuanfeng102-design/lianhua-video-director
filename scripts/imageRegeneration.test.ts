import assert from 'node:assert/strict';
import {
  appendRegeneratedImageResult,
  buildImageRegenerationTask,
  canRegenerateImageTask,
  executeImageRegeneration,
  imageRegenerationRootId,
  resolveImageAssetRegenerationTask,
  resolveImageRegenerationSource,
} from '../src/imageRegeneration';
import type { ImageApiConfig, ImageGenerationTask, Project, ReferenceAsset } from '../src/types';
import { createInitialState, normalizeState } from '../src/storage';
import { getImageVariantGenerationSpec, FIVE_VIEW_NEGATIVE_PROMPT } from '../src/imageGeneration';
import { isNsfwPrivateProfileAsset, nsfwPrivatePartForAsset, canUseNsfwPrivateProfileAsset } from '../src/nsfwPrivateAssets';

const task = (overrides: Partial<ImageGenerationTask> = {}): ImageGenerationTask => ({
  id: 'image-1', kind: 'image', name: '月下剑客', assetKind: 'character', imageVariant: 'reference',
  status: 'succeeded', prompt: 'saved final prompt', width: 1024, height: 1024,
  backend: 'openai', model: 'gpt-image', sourceEntityId: 'character-1',
  createdAt: 1, updatedAt: 1, ...overrides,
});

const asset = (overrides: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id: 'asset-1', name: '月下剑客', type: 'character', role: 'character', dataUrl: 'data:image/png;base64,AA==',
  tags: [], createdAt: 1, updatedAt: 1, ...overrides,
});

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1', name: '测试项目', description: '', sourceDocuments: [],
  characters: [{ id: 'character-1', name: '月下剑客', gender: '男', apparentAge: '青年', race: '人类', appearance: '黑发', outfit: '白衣', signatureProps: '长剑', personality: '冷静', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: ['asset-1'] }],
  locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [], assets: [asset()], generationTasks: [task()], createdAt: 1, updatedAt: 1, ...overrides,
});

const imageApi = (overrides: Partial<ImageApiConfig> = {}): ImageApiConfig => ({
  enabled: true, backend: 'openai', baseUrl: '', apiKey: '', model: 'gpt-image', ...overrides,
});

// A saved failed storyboard task must not replay all8+5 historical images.
// Existing explicit selections and the original task remain untouched.
const automaticHistoryAssets = ['character-1', 'character-2'].flatMap((sourceEntityId, entityIndex) => (
  Array.from({ length: entityIndex === 0 ? 8 : 5 }, (_, index) => asset({
    id: `${sourceEntityId}-image-${index + 1}`, sourceEntityId, sourceEntityKind: 'character',
    createdAt: index + 1, updatedAt: index + 1,
  }))
));
const automaticHistoryProject = project({
  assets: automaticHistoryAssets,
  characters: ['character-1', 'character-2'].map((id) => ({
    ...project().characters[0], id,
    assetIds: automaticHistoryAssets.filter((item) => item.sourceEntityId === id).map((item) => item.id).reverse(),
  })),
});
const automaticHistoryTask = task({
  assetKind: 'storyboard', sourceStoryboardId: 'saved-board', sourceShotId: 'saved-shot',
  conversionSource: 'frozen converter input', prompt: 'frozen final image prompt',
  referenceAssetIds: automaticHistoryAssets.map((item) => item.id), primaryReferenceAssetIds: [],
});
const unchangedHistory = structuredClone(automaticHistoryTask);
const compactHistorySource = resolveImageRegenerationSource(automaticHistoryTask, automaticHistoryProject);
assert.deepEqual(compactHistorySource.referenceAssetIds, ['character-1-image-8', 'character-2-image-5']);
assert.match(compactHistorySource.warning || '', /13 张 → 2 张/u);
assert.equal(compactHistorySource.conversionSource, 'frozen converter input');
assert.deepEqual(automaticHistoryTask, unchangedHistory, 'do not mutate a historical failed task');
const compactHistoryChild = buildImageRegenerationTask(automaticHistoryTask, automaticHistoryProject, {
  id: 'compact-history-child', timestamp: 30, backend: 'openai', model: 'gpt-image', source: compactHistorySource,
});
assert.deepEqual(compactHistoryChild.referenceAssetIds, compactHistorySource.referenceAssetIds);
assert.equal(compactHistoryChild.prompt, automaticHistoryTask.prompt);
assert.match(compactHistoryChild.bindingWarning || '', /13 张 → 2 张/u);
const explicitHistorySource = resolveImageRegenerationSource({
  ...automaticHistoryTask, primaryReferenceAssetIds: ['character-1-image-2', 'character-1-image-3'],
}, automaticHistoryProject);
assert.deepEqual(explicitHistorySource.referenceAssetIds, ['character-1-image-2', 'character-1-image-3', 'character-2-image-5']);
assert.deepEqual(resolveImageRegenerationSource({
  ...automaticHistoryTask, referenceAssetIds: ['character-1-image-1'],
  primaryReferenceAssetIds: ['character-1-image-2', 'character-1-image-3'],
}, automaticHistoryProject).referenceAssetIds, ['character-1-image-2', 'character-1-image-3'],
  'manual references stored separately still replace that entity automatic history');
const { primaryReferenceAssetIds: _unknownPrimary, ...unknownHistoryTask } = automaticHistoryTask;
assert.deepEqual(resolveImageRegenerationSource(unknownHistoryTask, automaticHistoryProject).referenceAssetIds, automaticHistoryTask.referenceAssetIds,
  'legacy snapshots without explicit/manual provenance must not guess which images can be removed');
const newerOutsidePool = asset({ id: 'outside-frozen-pool', sourceEntityId: 'character-1', sourceEntityKind: 'character', createdAt: 99, updatedAt: 99 });
assert.deepEqual(resolveImageRegenerationSource(automaticHistoryTask, {
  ...automaticHistoryProject, assets: [newerOutsidePool, ...automaticHistoryAssets],
  characters: automaticHistoryProject.characters.map((item) => item.id === 'character-1' ? { ...item, assetIds: [newerOutsidePool.id, ...item.assetIds] } : item),
}).referenceAssetIds, compactHistorySource.referenceAssetIds, 'a retry cannot silently introduce an image outside its saved pool');

// Break caught: losing the original's root means repeated regeneration becomes “-2-2”.
assert.equal(imageRegenerationRootId(task({ id: 'child', regenerationRootTaskId: 'image-1' })), 'image-1');

// Break caught: a terminal source should remain regenerable, but an in-flight family member must block it.
assert.equal(canRegenerateImageTask(task({ status: 'failed' }), [task({ status: 'failed' })]), true);
assert.equal(canRegenerateImageTask(task(), [task(), task({ id: 'pending', status: 'queued', regenerationRootTaskId: 'image-1' })]), false);
assert.equal(canRegenerateImageTask(task({ status: 'running' }), [task({ status: 'running' })]), false);

// Break caught: an asset result must lead back to its real task, retaining its snapshots and lineage.
const existingAssetTask = task({ resultAssetId: 'asset-1', regenerationRootTaskId: 'image-root' });
assert.strictEqual(
  resolveImageAssetRegenerationTask(asset(), project({ generationTasks: [existingAssetTask] }), imageApi()),
  existingAssetTask,
);

// Break caught: deleting a task must not make a generated asset's saved prompt impossible to regenerate.
const deletedTaskAsset = asset({
  id: 'deleted-result', name: '已删除任务的设定图', source: 'generated', prompt: 'saved asset prompt',
  negativePrompt: 'bad anatomy', imageVariant: 'turnaround', width: 1500, height: 1000,
  sourceEntityId: 'character-1', sourceEntityKind: 'character', imagePromptFormat: 'nai-tags', imageBackend: 'novelai',
});
const syntheticTask = resolveImageAssetRegenerationTask(deletedTaskAsset, project({ assets: [deletedTaskAsset], generationTasks: [] }), imageApi());
assert.ok(syntheticTask);
assert.equal(syntheticTask.id, 'asset-regeneration-deleted-result');
assert.equal(syntheticTask.name, '已删除任务的设定图');
assert.equal(syntheticTask.status, 'succeeded');
assert.equal(syntheticTask.backend, 'novelai');
assert.equal(syntheticTask.prompt, 'saved asset prompt');
assert.equal(syntheticTask.referenceAssetIds, undefined, 'synthetic task must use legacy reference recovery');
const assetRegeneration = buildImageRegenerationTask(syntheticTask, project({ assets: [deletedTaskAsset], generationTasks: [] }), {
  id: 'asset-child', timestamp: 19, backend: 'novelai', model: 'nai',
  source: { conversionSource: 'asset facts', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [] },
});
assert.equal(assetRegeneration.name, '已删除任务的设定图-2');
assert.equal(assetRegeneration.regenerationRootTaskId, syntheticTask.id);
assert.equal(canRegenerateImageTask(syntheticTask, [assetRegeneration]), false, 'asset-card and task entries share a pending root family');

const adultPrivateProject = project({
  sourceDocuments: [{
    id: 'adult-source', name: '成年资料', content: '月下剑客为25岁成年人。', createdAt: 1, updatedAt: 1,
  }],
  characters: [{
    ...project().characters[0],
    apparentAge: '25岁',
    nsfwProfile: {
      fullBody: '稳定裸体全身比例资料；年龄：25岁；禁止添加服装；柔和肤色与清晰身体轮廓',
      vulva: '稳定外阴外貌资料',
      provenance: 'manual',
    },
  }],
});
const privateAsset = asset({
  id: 'private-result', name: '月下剑客私密资料图', source: 'generated', prompt: 'saved private final prompt',
  negativePrompt: 'historical negative text that must not be restored',
  imageVariant: 'private-close-up', referenceScope: 'nsfw-private-profile', nsfwPrivatePart: 'vulva',
  sourceEntityKind: 'character', sourceEntityId: 'character-1',
});
const recoveredPrivateTask = resolveImageAssetRegenerationTask(
  privateAsset,
  { ...adultPrivateProject, assets: [privateAsset], generationTasks: [] },
  imageApi(),
);
assert.ok(recoveredPrivateTask);
assert.equal(recoveredPrivateTask.referenceScope, 'nsfw-private-profile');
assert.equal(recoveredPrivateTask.nsfwPrivatePart, 'vulva');
assert.equal(recoveredPrivateTask.negativePrompt, '', 'legacy private assets must not restore a saved negative prompt');
const recoveredPrivateSource = resolveImageRegenerationSource(recoveredPrivateTask, adultPrivateProject);
assert.deepEqual(recoveredPrivateSource.referenceAssetIds, [], 'a legacy private result must not infer an ordinary character reference');
assert.deepEqual(recoveredPrivateSource.primaryReferenceAssetIds, []);
assert.match(recoveredPrivateSource.conversionSource, /稳定外阴外貌资料/u, 'a saved legacy private prompt must be rebuilt from verifiable private facts');
assert.doesNotMatch(
  recoveredPrivateSource.conversionSource,
  /黑发|白衣|长剑|身高\/高度比例/u,
  'a rebuilt local close-up must not restore distant face, hair, outfit, prop, or height anchors',
);
assert.match(recoveredPrivateSource.warning || '', /当前私密资料和当前规则重新转换/u);
const privateChild = buildImageRegenerationTask(recoveredPrivateTask, adultPrivateProject, {
  id: 'private-child', timestamp: 22, backend: recoveredPrivateTask.backend, model: recoveredPrivateTask.model,
  source: recoveredPrivateSource,
});
assert.equal(privateChild.referenceScope, 'nsfw-private-profile');
assert.equal(privateChild.nsfwPrivatePart, 'vulva');
assert.equal(privateChild.negativePrompt, '', 'every new private regeneration task must persist an empty negative prompt');

const rebuiltPrivateFullBody = resolveImageRegenerationSource(task({
  id: 'private-full-body-task', name: '月下剑客私密全身图', prompt: '', sourceEntityId: 'character-1',
  imageVariant: 'private-full-body', referenceScope: 'nsfw-private-profile', nsfwPrivatePart: 'full-body',
}), adultPrivateProject);
assert.match(rebuiltPrivateFullBody.conversionSource, /稳定裸体全身比例资料/u);
assert.match(rebuiltPrivateFullBody.conversionSource, /柔和肤色与清晰身体轮廓/u);
assert.doesNotMatch(rebuiltPrivateFullBody.conversionSource, /白衣|长剑/u, 'private source rebuilding must not restore ordinary outfit or props');
assert.doesNotMatch(
  rebuiltPrivateFullBody.conversionSource,
  /25\s*岁|成年|未成年|18\+|年龄|审核|禁止|不得|负面提示词/iu,
  'the local adult gate and negative-control metadata must not leak into model-facing private image facts',
);
assert.deepEqual(rebuiltPrivateFullBody.referenceAssetIds, []);
const privateFullBodySourceTask = task({
  id: 'private-full-body-landscape', name: '月下剑客私密全身横图', prompt: '',
  imageVariant: 'private-full-body', referenceScope: 'nsfw-private-profile', nsfwPrivatePart: 'full-body',
  width: 3072, height: 2048,
});
const privateFullBodyChild = buildImageRegenerationTask(privateFullBodySourceTask, adultPrivateProject, {
  id: 'private-full-body-portrait-child', timestamp: 23, backend: privateFullBodySourceTask.backend,
  model: privateFullBodySourceTask.model, source: rebuiltPrivateFullBody,
});
assert.equal(privateFullBodyChild.width, 2048);
assert.equal(privateFullBodyChild.height, 3072);
assert.match(privateFullBodyChild.negativePrompt || '', /second person.*duplicate person.*multiple views/iu);
assert.doesNotMatch(privateFullBodyChild.negativePrompt || '', /\bage\b|\badult\b|\bminor\b|\bchild\b|\bteen\b|年龄|成年|未成年/iu);
const rebuiltPrivateWithoutAgeMetadata = resolveImageRegenerationSource(task({
  id: 'private-no-age-metadata', prompt: '', sourceEntityId: 'character-1', imageVariant: 'private-full-body',
  referenceScope: 'nsfw-private-profile', nsfwPrivatePart: 'full-body',
}), project({
  sourceDocuments: [],
  characters: [{ ...project().characters[0], apparentAge: '', nsfwProfile: { fullBody: '稳定私密全身资料' } }],
}));
assert.match(rebuiltPrivateWithoutAgeMetadata.conversionSource, /稳定私密全身资料/u);
assert.doesNotMatch(
  rebuiltPrivateWithoutAgeMetadata.conversionSource,
  /18\+|年龄|成年|未成年|禁止|不得|负面/iu,
  'private regeneration without age metadata remains positive-only and age-free',
);
assert.throws(
  () => resolveImageRegenerationSource(task({
    id: 'private-part-missing', prompt: '', sourceEntityId: 'character-1', imageVariant: 'private-close-up',
    referenceScope: 'nsfw-private-profile', nsfwPrivatePart: undefined,
  }), adultPrivateProject),
  /缺少具体部位元数据/u,
);
assert.throws(
  () => resolveImageRegenerationSource(task({
    id: 'private-profile-missing', prompt: '', sourceEntityId: 'character-1', imageVariant: 'private-close-up',
    referenceScope: 'nsfw-private-profile', nsfwPrivatePart: 'penis',
  }), adultPrivateProject),
  /没有对应部位的私密外貌资料/u,
);

let replayedPrivateNegativePrompt: string | undefined;
await executeImageRegeneration(task({
  prompt: 'saved private image prompt',
  negativePrompt: 'legacy negative text',
  imageVariant: 'private-close-up',
  referenceScope: 'nsfw-private-profile',
  nsfwPrivatePart: 'vulva',
}), {
  referenceImages: [], primaryReferenceImageCount: 0,
  convertPrompt: async () => { throw new Error('a saved private prompt must not be converted'); },
  persistPrompt: () => { throw new Error('a saved private prompt must not be persisted again'); },
  generateImage: async (input) => {
    replayedPrivateNegativePrompt = input.negativePrompt;
    return input.prompt;
  },
});
assert.equal(replayedPrivateNegativePrompt, '', 'private replay must clear a historical task negative prompt at transport time');

let convertedPrivateNegativePrompt: string | undefined;
await executeImageRegeneration(task({
  prompt: '',
  negativePrompt: 'legacy negative text',
  conversionSource: 'private visual facts',
  imageVariant: 'private-full-body',
  referenceScope: 'nsfw-private-profile',
  nsfwPrivatePart: 'full-body',
}), {
  referenceImages: [], primaryReferenceImageCount: 0,
  convertPrompt: async () => 'A cinematic full body portrait in warm window light.',
  persistPrompt: () => undefined,
  generateImage: async (input) => {
    convertedPrivateNegativePrompt = input.negativePrompt;
    return input.prompt;
  },
});
assert.match(convertedPrivateNegativePrompt || '', /second person.*duplicate person.*multiple views/iu,
  'private full-body regeneration must send only the current layout guard');
assert.doesNotMatch(convertedPrivateNegativePrompt || '', /\bage\b|\badult\b|\bminor\b|\bchild\b|\bteen\b|年龄|成年|未成年/iu);

// A deleted ComfyUI task must remain regenerable with every supported prompt
// syntax. Format and the rule's recommended backend cannot choose transport.
for (const format of ['natural-language', 'nai-tags', 'sd-tags'] as const) {
  const comfyAsset = asset({
    id: `comfy-${format}`, source: 'generated', prompt: `original ${format} final prompt`,
    imagePromptFormat: format, imagePromptRuleSetId: format === 'natural-language' ? 'image-rule-openai' : 'image-rule-novelai',
    sourceEntityKind: 'character', sourceEntityId: 'character-1', width: 1280, height: 720,
  });
  const comfyProject = project({ assets: [comfyAsset], generationTasks: [] });
  const comfyApi = imageApi({ backend: 'comfyui', model: 'current-comfy-model' });
  const snapshot = JSON.stringify(comfyAsset);
  const recovered = resolveImageAssetRegenerationTask(comfyAsset, comfyProject, comfyApi);
  assert.ok(recovered);
  assert.equal(recovered.backend, 'comfyui', `legacy ${format} must use the selected physical ComfyUI backend`);
  assert.equal(recovered.model, 'current-comfy-model', 'rule metadata must not switch the selected model');
  assert.equal(recovered.imagePromptFormat, format);
  assert.equal(recovered.imagePromptRuleSetId, comfyAsset.imagePromptRuleSetId);
  const retry = buildImageRegenerationTask(recovered, comfyProject, {
    id: `retry-${format}`, timestamp: 20, backend: comfyApi.backend, model: comfyApi.model,
    source: { conversionSource: '', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [] },
  });
  assert.equal(retry.backend, 'comfyui');
  assert.equal(retry.model, comfyApi.model);
  let transportCalls = 0;
  const replay = await executeImageRegeneration(retry, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => { throw new Error('saved prompt must not be rewritten when choosing transport'); },
    persistPrompt: () => { throw new Error('saved prompt must not be replaced'); },
    generateImage: async (input) => {
      transportCalls += 1;
      assert.equal(input.prompt, comfyAsset.prompt);
      assert.equal(input.width, 1280);
      assert.equal(input.height, 720);
      return 'mock-comfy-result';
    },
  });
  assert.equal(replay.finalPrompt, comfyAsset.prompt);
  assert.equal(transportCalls, 1);
  assert.equal(JSON.stringify(comfyAsset), snapshot);
}

for (const backend of ['openai', 'sd_webui', 'comfyui', 'novelai'] as const) {
  const ambiguous = asset({ source: 'generated', prompt: 'keep this exact legacy prompt', imagePromptFormat: 'nai-tags' });
  const inferred = resolveImageAssetRegenerationTask(ambiguous, project({ generationTasks: [] }), imageApi({ backend, model: 'selected-model' }));
  assert.equal(inferred?.backend, backend, 'an unrecorded legacy asset must follow the current API, not its prompt format');
  assert.equal(inferred?.model, 'selected-model');
  assert.equal(inferred?.prompt, ambiguous.prompt);
}

const recordedOpenAiAsset = asset({ source: 'generated', prompt: 'saved recorded prompt', imageBackend: 'openai', imagePromptFormat: 'sd-tags' });
const mismatchedApi = imageApi({ backend: 'comfyui', model: 'unchanged-current-model' });
const recordedProject = project({ assets: [recordedOpenAiAsset], generationTasks: [] });
const recordedTask = resolveImageAssetRegenerationTask(recordedOpenAiAsset, recordedProject, mismatchedApi);
assert.ok(recordedTask);
assert.equal(recordedTask.backend, 'openai', 'explicit physical provenance must survive a different current API and prompt syntax');
assert.throws(() => buildImageRegenerationTask(recordedTask, recordedProject, {
  id: 'mismatched-retry', timestamp: 20, backend: mismatchedApi.backend, model: mismatchedApi.model,
  source: { conversionSource: '', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [] },
}), /openai.*comfyui.*不会自动更换后端或模型/u, 'a recorded backend mismatch must remain an explicit stop, not a silent reroute');
assert.equal(recordedProject.generationTasks.length, 0);
assert.equal(mismatchedApi.model, 'unchanged-current-model');

const originalComfyTask = task({ resultAssetId: 'asset-1', backend: 'comfyui', model: 'recorded-task-model' });
assert.strictEqual(
  resolveImageAssetRegenerationTask(recordedOpenAiAsset, project({ generationTasks: [originalComfyTask] }), imageApi()),
  originalComfyTask,
  'an existing original task remains authoritative, retaining its actual backend/model and snapshots',
);
const recordedComfyAsset = asset({ source: 'generated', prompt: 'saved natural-language image', imageBackend: 'comfyui', imagePromptFormat: 'natural-language' });
assert.equal(resolveImageAssetRegenerationTask(recordedComfyAsset, project({ generationTasks: [] }), imageApi())?.backend, 'comfyui');
const recordedAssetState = createInitialState();
recordedAssetState.project.assets = [recordedComfyAsset];
assert.equal(normalizeState(JSON.parse(JSON.stringify(recordedAssetState))).project.assets[0]?.imageBackend, 'comfyui', 'optional physical backend metadata must survive ordinary storage normalization');

assert.equal(resolveImageAssetRegenerationTask(
  asset({ id: 'upload-plain', source: 'upload', prompt: undefined, sourceEntityId: undefined, sourceStoryboardId: undefined }),
  project(), imageApi(),
), null, 'plain uploads have no reproducible source');
assert.equal(resolveImageAssetRegenerationTask(
  asset({ id: 'video-asset', type: 'video', mediaType: 'video', source: 'generated', prompt: 'not an image' }),
  project(), imageApi(),
), null, 'video assets must never enter image regeneration');

const first = buildImageRegenerationTask(task(), project(), {
  id: 'image-2', timestamp: 20, backend: 'openai', model: 'gpt-image',
  source: { conversionSource: 'source', converterSystemPrompt: 'rules', referenceAssetIds: ['asset-1'], primaryReferenceAssetIds: [] },
});
assert.equal(first.name, '月下剑客-2');
assert.equal(first.regenerationRootTaskId, 'image-1');
assert.equal(first.regenerationSourceTaskId, 'image-1');
assert.equal(first.prompt, 'saved final prompt');
assert.equal(first.resultAssetId, undefined);

const failedRetry = buildImageRegenerationTask(task({ id: 'failed-image', status: 'failed', name: '失败图' }), project({
  assets: [], generationTasks: [task({ id: 'failed-image', status: 'failed', name: '失败图' })],
}), {
  id: 'failed-image-2', timestamp: 21, backend: 'openai', model: 'gpt-image',
  source: { conversionSource: 'source', converterSystemPrompt: 'rules', referenceAssetIds: [], primaryReferenceAssetIds: [] },
});
assert.equal(failedRetry.name, '失败图-2');

const second = buildImageRegenerationTask({ ...first, status: 'succeeded' }, project({ generationTasks: [task(), { ...first, status: 'succeeded' }], assets: [asset(), asset({ id: 'asset-2', name: '月下剑客-2' })] }), {
  id: 'image-3', timestamp: 30, backend: 'openai', model: 'gpt-image',
  source: { conversionSource: 'source', converterSystemPrompt: 'rules', referenceAssetIds: [], primaryReferenceAssetIds: [] },
});
assert.equal(second.name, '月下剑客-3');
assert.equal(second.regenerationBaseName, '月下剑客');

const digitChild = buildImageRegenerationTask(task({ name: '角色2', id: 'digits' }), project({ assets: [], generationTasks: [task({ name: '角色2', id: 'digits' })] }), {
  id: 'digits-2', timestamp: 30, backend: 'openai', model: 'gpt-image',
  source: { conversionSource: 'source', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [] },
});
assert.equal(digitChild.name, '角色2-2');

// Break caught: Windows folds Greek final sigma (ς) with capital sigma (Σ), unlike lowercasing.
const sigmaSource = task({ id: 'sigma-source', name: 'ς' });
const sigmaChild = buildImageRegenerationTask(sigmaSource, project({
  assets: [asset({ id: 'sigma-asset', name: 'Σ-2' })], generationTasks: [sigmaSource],
}), {
  id: 'sigma-child', timestamp: 31, backend: 'openai', model: 'gpt-image',
  source: { conversionSource: 'source', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [] },
});
assert.equal(sigmaChild.name, 'ς-3');

// Break caught: saved prompts must not pay for a second conversion.
let converted = 0;
let generated = 0;
const reused = await executeImageRegeneration(task({ prompt: 'a valid final picture prompt' }), {
  referenceImages: ['image'], primaryReferenceImageCount: 1,
  convertPrompt: async () => { converted += 1; return 'unused'; },
  persistPrompt: () => { throw new Error('saved prompt must not be persisted again'); },
  generateImage: async ({ prompt }) => { generated += 1; return prompt; },
});
assert.equal(reused.finalPrompt, 'a valid final picture prompt');
assert.equal(converted, 0);
assert.equal(generated, 1);

// Break caught: a recorded final storyboard prompt is replayed verbatim, even if current rules would reject it.
const legacyStoryboardPrompt = '镜头位置：旧版最终提示词';
const replayed = await executeImageRegeneration(task({
  assetKind: 'storyboard', imageVariant: 'storyboard-frame', prompt: legacyStoryboardPrompt,
  conversionSource: 'different current storyboard source', imagePromptFormat: 'natural-language',
}), {
  referenceImages: [], primaryReferenceImageCount: 0,
  convertPrompt: async () => { throw new Error('saved storyboard prompt must not convert'); },
  persistPrompt: () => { throw new Error('saved storyboard prompt must not persist'); },
  generateImage: async ({ prompt }) => prompt,
});
assert.equal(replayed.finalPrompt, legacyStoryboardPrompt);
assert.equal(replayed.generated, legacyStoryboardPrompt);

let persisted = '';
await assert.rejects(
  executeImageRegeneration(task({ prompt: '', conversionSource: 'facts' }), {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => 'recovered final picture prompt',
    persistPrompt: (prompt) => { persisted = prompt; },
    generateImage: async () => { generated += 1; throw new Error('network broke'); },
  }),
  /network broke/u,
);
assert.equal(persisted, 'recovered final picture prompt');
assert.equal(generated, 2, 'generation errors must not cause an automatic retry');

const snapshotSource = resolveImageRegenerationSource(task({
  conversionSource: '', converterSystemPrompt: 'saved rules', referenceAssetIds: [], primaryReferenceAssetIds: [],
}), project());
assert.deepEqual(snapshotSource, { conversionSource: '', converterSystemPrompt: 'saved rules', referenceAssetIds: [], primaryReferenceAssetIds: [] });

// Break caught: migration that drops explicit empty snapshots would silently recover different references later.
const persistedState = createInitialState();
persistedState.project.generationTasks = [task({
  conversionSource: '', converterSystemPrompt: 'saved rules', referenceAssetIds: [], primaryReferenceAssetIds: [],
})];
const reloadedTask = normalizeState(JSON.parse(JSON.stringify(persistedState))).project.generationTasks[0] as ImageGenerationTask;
assert.deepEqual(reloadedTask.referenceAssetIds, []);
assert.deepEqual(reloadedTask.primaryReferenceAssetIds, []);
assert.equal(reloadedTask.conversionSource, '');
assert.equal(reloadedTask.converterSystemPrompt, 'saved rules');

const old = task({ resultAssetId: 'asset-1' });
const regenerated = task({ id: 'image-2', name: '月下剑客-2', status: 'running', regenerationRootTaskId: 'image-1' });
const result = asset({ id: 'asset-2', name: '月下剑客-2' });
const appended = appendRegeneratedImageResult(project({ generationTasks: [old, regenerated] }), regenerated, result);
assert.equal(appended.assets.length, 2);
assert.strictEqual(appended.assets[0], result, 'new result should appear first like other generated assets');
assert.equal(appended.generationTasks[0], old, 'old task must remain byte-for-byte untouched');
assert.equal((appended.generationTasks[1] as ImageGenerationTask).resultAssetId, 'asset-2');
assert.match((appended.generationTasks[1] as ImageGenerationTask).bindingWarning || '', /未替换原始绑定/u);
assert.deepEqual(appended.characters[0].assetIds, ['asset-1']);

// Break caught: undo must not discard a paid result when its queued child was removed before completion.
const undoneProject = project({ generationTasks: [old] });
const restored = appendRegeneratedImageResult(undoneProject, regenerated, result);
assert.strictEqual(restored.assets[0], result);
assert.equal(restored.generationTasks[0].id, regenerated.id);
assert.equal((restored.generationTasks[0] as ImageGenerationTask).status, 'succeeded');
assert.equal((restored.generationTasks[0] as ImageGenerationTask).resultAssetId, result.id);
assert.strictEqual(restored.generationTasks[1], old, 'existing terminal task remains untouched after undo recovery');
assert.strictEqual(restored.assets[1], undoneProject.assets[0], 'old physical asset is never rewritten');
assert.deepEqual(restored.characters[0].assetIds, ['asset-1']);

// Five-view layouts are one image/task. The new IDs survive restart and
// replay; historical four-view and private four-in-one snapshots keep theirs.
const fiveViewProject = project({
  characters: [{ ...adultPrivateProject.characters[0], nsfwProfile: { fullBody: 'PRIVATE_PROFILE_LAYOUT_SENTINEL' } }],
  assets: [], generationTasks: [],
});
const layoutVariants = ['five-view', 'private-five-view', 'turnaround', 'private-turnaround', 'private-four-in-one'] as const;
const layoutTasks = layoutVariants.map((imageVariant, index) => task({
  id: `layout-${imageVariant}`, name: `布局-${imageVariant}`, imageVariant,
  prompt: `SAVED_FINAL_${imageVariant}`, conversionSource: `SAVED_SOURCE_${imageVariant}`,
  converterSystemPrompt: `SAVED_RULES_${imageVariant}`, referenceAssetIds: [], primaryReferenceAssetIds: [],
  negativePrompt: `SAVED_NEGATIVE_${imageVariant}`,
  width: 1536, height: 1024,
  ...(imageVariant.startsWith('private-') ? { referenceScope: 'nsfw-private-profile' as const, nsfwPrivatePart: 'full-body' as const } : {}),
  createdAt: index + 1, updatedAt: index + 1,
}));
const layoutAssets = layoutTasks.map((source) => asset({
  id: `asset-${source.imageVariant}`, name: source.name, imageVariant: source.imageVariant,
  prompt: source.prompt, negativePrompt: source.negativePrompt, source: 'generated', sourceEntityId: 'character-1', sourceEntityKind: 'character',
  width: source.width, height: source.height, referenceScope: source.referenceScope, nsfwPrivatePart: source.nsfwPrivatePart,
}));
const layoutState = createInitialState();
layoutState.project = { ...fiveViewProject, generationTasks: layoutTasks, assets: layoutAssets };
layoutState.projects = [layoutState.project];
layoutState.activeProjectId = layoutState.project.id;
const layoutReloaded = normalizeState(JSON.parse(JSON.stringify({
  ...layoutState, settings: { ...layoutState.settings, imagePromptPresetIdByAssetKind: {
    'five-view': 'user-five-sheet-preset', 'private-five-view': 'user-private-five-sheet-preset',
  } },
})));
assert.equal(layoutReloaded.settings.imagePromptPresetIdByAssetKind?.['character-sheet'], 'user-five-sheet-preset');
assert.equal(layoutReloaded.settings.imagePromptPresetIdByAssetKind?.['character-private'], 'user-private-five-sheet-preset');
assert.deepEqual(layoutReloaded.project.generationTasks.map((entry) => entry.kind === 'image' ? entry.imageVariant : ''), layoutVariants);
assert.deepEqual(layoutReloaded.project.assets.map((entry) => entry.imageVariant), layoutVariants);
for (const source of layoutTasks) {
  const before = JSON.stringify(source);
  const recoveredSource = resolveImageRegenerationSource(source, fiveViewProject);
  assert.equal(recoveredSource.conversionSource, source.conversionSource);
  assert.equal(recoveredSource.converterSystemPrompt, source.converterSystemPrompt);
  const child = buildImageRegenerationTask(source, fiveViewProject, {
    id: `child-${source.id}`, timestamp: 100, backend: source.backend, model: source.model, source: recoveredSource,
  });
  assert.equal(child.imageVariant, source.imageVariant);
  assert.equal(child.prompt, source.prompt);
  assert.equal(child.converterSystemPrompt, source.converterSystemPrompt);
  assert.equal(child.width, 1536);
  assert.equal(child.height, 1024);
  if (source.imageVariant === 'five-view' || source.imageVariant === 'private-five-view') {
    assert.equal(child.negativePrompt, FIVE_VIEW_NEGATIVE_PROMPT);
    assert.doesNotMatch(child.negativePrompt, /cropped body|duplicate person|multiple views|contact sheet/iu);
  }
  if (source.imageVariant === 'turnaround') assert.equal(child.negativePrompt, source.negativePrompt);
  let layoutGenerationCalls = 0;
  await executeImageRegeneration(child, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => { throw new Error('a layout replay must retain its saved final prompt'); },
    persistPrompt: () => { throw new Error('a layout replay must not rewrite its saved prompt'); },
    generateImage: async (request) => { layoutGenerationCalls += 1; assert.equal(request.prompt, source.prompt); return 'MOCK_IMAGE'; },
  });
  assert.equal(layoutGenerationCalls, 1, 'one layout produces one image request, not one request per region');
  assert.equal(JSON.stringify(source), before);
}
const untaggedPrivateFiveAsset = asset({ imageVariant: 'private-five-view', source: 'generated', prompt: 'SAVED_PRIVATE_FIVE_LAYOUT', sourceEntityId: 'character-1', sourceEntityKind: 'character' });
assert.equal(isNsfwPrivateProfileAsset(untaggedPrivateFiveAsset), true);
assert.equal(nsfwPrivatePartForAsset(untaggedPrivateFiveAsset), 'full-body');
assert.equal(canUseNsfwPrivateProfileAsset(untaggedPrivateFiveAsset, { evidence: '人物衣着完整走进门厅。', characterIds: ['character-1'] }), false);
const recoveredPrivateFive = resolveImageAssetRegenerationTask(untaggedPrivateFiveAsset, fiveViewProject, imageApi());
assert.ok(recoveredPrivateFive);
assert.equal(recoveredPrivateFive.imageVariant, 'private-five-view');
assert.equal(recoveredPrivateFive.referenceScope, 'nsfw-private-profile');
assert.equal(recoveredPrivateFive.nsfwPrivatePart, 'full-body');
assert.deepEqual([recoveredPrivateFive.width, recoveredPrivateFive.height], [1536, 1024]);
for (const imageVariant of ['five-view', 'private-five-view'] as const) {
  const rebuilt = resolveImageRegenerationSource(task({
    id: `rebuild-${imageVariant}`, prompt: '', imageVariant,
    ...(imageVariant === 'private-five-view' ? { referenceScope: 'nsfw-private-profile' as const, nsfwPrivatePart: 'full-body' as const } : {}),
  }), fiveViewProject);
  assert.ok(rebuilt.conversionSource.includes(getImageVariantGenerationSpec(imageVariant).direction));
  assert.match(rebuilt.conversionSource, /左上|左侧上/u);
  assert.match(rebuilt.conversionSource, /左下|左侧下/u);
  assert.deepEqual(rebuilt.referenceAssetIds, []);
}

console.log('image regeneration tests passed');

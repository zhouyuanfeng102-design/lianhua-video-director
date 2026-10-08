import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendRegeneratedImageResult,
  buildCurrentShotImageRegenerationVisualAnchor,
  buildImageRegenerationTask,
  canReconvertStoryboardImageTask,
  executeImageRegeneration,
  prepareCurrentShotImageRegenerationTask,
  resolveImageAssetCurrentShotRegenerationTask,
  resolveImageAssetRegenerationTask,
  resolveImageRegenerationSource,
} from '../src/imageRegeneration';
import { createInitialState } from '../src/storage';
import type { ImageGenerationTask, Project, ReferenceAsset, Storyboard, VideoShot } from '../src/types';

const shot = (index: number): VideoShot => ({
  id: `shot-${index}`, index, startSec: (index - 1) * 5, endSec: index * 5,
  purpose: '雨巷对峙', subject: '月下剑客', action: '持剑看向对面的人', camera: '中景侧面机位',
  lighting: '街灯柔光', sound: '雨声', result: '握紧剑柄', transition: '顺接',
  referenceAssetIds: [], prompt: '当前镜头：月下剑客侧身面对巷口的人，目光锁定对方。', locked: false,
});
const board: Storyboard = {
  id: 'board-1', sceneId: 'scene-1', sourceStoryTitle: '雨巷', sourceStoryContent: '月下剑客与巷口的人相对而立。',
  workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: 'custom',
  shotMode: 'exact', shotCount: 2, pace: 'standard', aspectRatio: '16:9', resolution: '1080p',
  audioMode: 'stereo', stylePresetId: 'cinematic', ruleSetId: 'timeline_director_cn', converterPresetId: 'converter',
  globalLock: '湿润青石街道', shots: [shot(1), { ...shot(2), camera: '镜头末尾下移至持剑的手部特写',
    prompt: '当前尾镜：月下剑客看向巷口对手，镜头最后下移，只拍握剑的手。' }],
  finalPrompt: '当前分镜全文', officialPromptZh: '', createdAt: 1, updatedAt: 2,
};
const original: ImageGenerationTask = {
  id: 'old-task', kind: 'image', assetKind: 'storyboard', imageVariant: 'last-frame', name: '雨巷尾帧',
  status: 'succeeded', backend: 'openai', model: 'old-image-model', width: 2048, height: 1152,
  sourceStoryboardId: board.id, sourceShotId: 'shot-2', resultAssetId: 'old-result',
  imageGenerationMode: 'image-to-image', prompt: '旧错误提示词：人物转头看摄影机。',
  conversionSource: '旧错误转换资料', conversionIdentityContext: '旧错误身份资料', converterSystemPrompt: '旧错误系统规则',
  referenceAssetIds: ['stale-image'], primaryReferenceAssetIds: ['stale-image'], referenceAssetSnapshots: [],
  imagePromptRuleSetId: 'old-rule', imagePromptRuleSetVersion: '0', imagePromptPresetId: 'old-preset',
  imagePromptPresetVersion: '0', imagePromptFormat: 'sd-tags', sourceFingerprint: 'stale-fingerprint',
  imageApiSnapshot: { fixture: 'frozen-api' } as unknown as ImageGenerationTask['imageApiSnapshot'],
  createdAt: 1, updatedAt: 1,
};
const oldAsset: ReferenceAsset = {
  id: 'old-result', name: '雨巷尾帧', type: 'last-frame', role: 'last-frame', tags: [],
  source: 'generated', sourceStoryboardId: board.id, sourceShotId: 'shot-2', imageVariant: 'last-frame',
  imageGenerationMode: 'image-to-image', prompt: original.prompt, visualAnchor: '旧错误画面描述',
  dataUrl: 'data:image/png;base64,AA==', createdAt: 1, updatedAt: 1,
};
const project = (): Project => ({
  ...createInitialState().project,
  id: 'current-shot-project', name: '雨巷', storyboards: [structuredClone(board)],
  characters: [], locations: [], props: [], scenes: [], sourceDocuments: [],
  assets: [structuredClone(oldAsset)], generationTasks: [structuredClone(original)],
});

test('current-shot action rebuilds current source, clears frozen inputs and leaves original records untouched', () => {
  const before = project();
  const snapshot = structuredClone(before);
  const seed = prepareCurrentShotImageRegenerationTask(before.generationTasks[0] as ImageGenerationTask, before);
  assert.equal(seed.prompt, '');
  assert.equal(seed.converterSystemPrompt, '');
  assert.equal(seed.imageGenerationMode, 'text-to-image');
  assert.equal(seed.imageApiSnapshot, undefined);
  assert.equal(seed.imagePromptRuleSetId, undefined);
  assert.equal(seed.imagePromptFormat, undefined);
  assert.equal(seed.sourceFingerprint, undefined);
  assert.equal(seed.referenceAssetSnapshots, undefined);
  assert.deepEqual(seed.referenceAssetIds, []);
  assert.doesNotMatch(seed.conversionSource || '', /旧错误|stale-image/u);
  assert.match(seed.conversionSource || '', /当前尾镜|握剑的手/u);
  assert.doesNotMatch(seed.conversionIdentityContext || '', /旧错误身份资料/u);
  const anchor = buildCurrentShotImageRegenerationVisualAnchor(seed, before);
  assert.match(anchor, /持剑的手部特写/u);
  assert.doesNotMatch(anchor, /旧错误画面描述/u);
  assert.deepEqual(before, snapshot, 'preparation must not rewrite the existing H3, task, asset or bindings');
});

test('one current-shot task converts once, submits once and appends a separate result', async () => {
  const before = project();
  const seed = { ...prepareCurrentShotImageRegenerationTask(original, before), imagePromptFormat: 'natural-language' as const };
  const source = resolveImageRegenerationSource(seed, before);
  const created = buildImageRegenerationTask(seed, before, {
    id: 'new-task', timestamp: 20, backend: 'openai', model: 'current-model', source,
  });
  assert.equal(created.prompt, '');
  assert.equal(created.model, 'current-model');
  assert.equal(created.regenerationSourceTaskId, original.id);
  assert.equal(created.regenerationRootTaskId, original.id);
  const calls: string[] = [];
  const final = '湿润青石街道上的持剑手部特写，手指握紧剑柄，摄影机处于剑客侧面，背景巷口散焦，街灯映亮金属和皮革。';
  const result = await executeImageRegeneration(created, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => { calls.push('convert'); return final; },
    persistPrompt: (prompt) => { calls.push('persist'); assert.equal(prompt, final); },
    generateImage: async (input) => { calls.push('image'); assert.equal(input.prompt, final); return 'new-pixels'; },
  });
  assert.deepEqual(calls, ['convert', 'persist', 'image']);
  assert.equal(result.generated, 'new-pixels');
  const queued = { ...before, generationTasks: [created, ...before.generationTasks] };
  const updated = appendRegeneratedImageResult(queued, created, { ...oldAsset, id: 'new-result', prompt: final, updatedAt: 21 });
  assert.equal(updated.assets.length, 2);
  assert.deepEqual(updated.assets.find((asset) => asset.id === oldAsset.id), oldAsset);
  assert.deepEqual(updated.storyboards, before.storyboards);
  assert.deepEqual(updated.generationTasks.find((task) => task.id === original.id), original);
});

test('deleted source or changed boundary cannot silently fall back to the saved prompt', () => {
  const noBoard = { ...project(), storyboards: [] };
  assert.equal(canReconvertStoryboardImageTask(original, noBoard), false);
  assert.throws(() => prepareCurrentShotImageRegenerationTask(original, noBoard), /不会改用旧图片提示词/u);
  const moved = project();
  moved.storyboards[0].shots.push(shot(3));
  assert.equal(canReconvertStoryboardImageTask(original, moved), false);
  assert.throws(() => prepareCurrentShotImageRegenerationTask(original, moved), /对应首尾镜/u);
  assert.equal(canReconvertStoryboardImageTask({ ...original, assetKind: 'character' }, project()), false);
});

test('legacy direct result can be rebuilt after its task/snapshot was lost, while ordinary exact replay remains strict', () => {
  const current = { ...project(), generationTasks: [] };
  const api = createInitialState().settings.imageApi;
  assert.throws(() => resolveImageAssetRegenerationTask(oldAsset, current, api), /快照缺失/u);
  const resolved = resolveImageAssetCurrentShotRegenerationTask(oldAsset, current, api);
  assert.ok(resolved);
  assert.equal(resolved.id, `asset-regeneration-${oldAsset.id}`);
  assert.equal(resolved.prompt, oldAsset.prompt, 'asset-card eligibility does not build conversion input until clicked');
  const seed = prepareCurrentShotImageRegenerationTask(resolved, current);
  assert.equal(seed.prompt, '');
  assert.match(seed.conversionSource || '', /当前尾镜/u);
  assert.equal(resolveImageAssetCurrentShotRegenerationTask(oldAsset, { ...current, storyboards: [] }, api), null);
});

test('old custom-frame captions are replaced by current shot facts; explicit requested pixel size remains', () => {
  const current = project();
  const custom = { ...original, imageVariant: 'storyboard-frame' as const, imageFrameBatchId: 'old-batch',
    imageFrameIndex: 5, imageFrameCount: 9, imageFrameDescription: '旧错误瞬间：回头看观众。', imageFrameTimeSec: 7,
    sizeOverride: true, width: 1280, height: 720 };
  const seed = prepareCurrentShotImageRegenerationTask(custom, current);
  assert.equal(seed.imageFrameDescription, undefined);
  assert.equal(seed.imageFrameIndex, undefined);
  assert.equal(seed.imageFrameTimeSec, undefined);
  assert.equal(seed.imageFrameBatchId, undefined);
  assert.doesNotMatch(seed.conversionSource || '', /旧错误瞬间/u);
  assert.match(seed.conversionSource || '', /1280×720/u);
  assert.equal(seed.width, 1280);
  assert.equal(seed.height, 720);
  assert.equal(seed.sizeOverride, true);
});

test('failed current conversion makes no image request and ordinary saved-prompt replay still skips conversion', async () => {
  const current = project();
  const seed = prepareCurrentShotImageRegenerationTask(original, current);
  let imageCalls = 0;
  await assert.rejects(() => executeImageRegeneration(seed, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => { throw new Error('converter unavailable'); },
    persistPrompt: () => { throw new Error('must not persist'); },
    generateImage: async () => { imageCalls += 1; },
  }), /converter unavailable/u);
  assert.equal(imageCalls, 0);
  await executeImageRegeneration({ ...original, imageGenerationMode: 'text-to-image' }, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => { throw new Error('ordinary saved-prompt replay must not convert'); },
    persistPrompt: () => { throw new Error('ordinary saved-prompt replay must not persist'); },
    generateImage: async (input) => { imageCalls += 1; assert.equal(input.prompt, original.prompt); },
  });
  assert.equal(imageCalls, 1);
});

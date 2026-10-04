import assert from 'node:assert/strict';
import { deriveWorkspaceUiState } from '../src/appEffects';
import { activeDirectorWorkflow, activeImageAssetKind, GRID_CREATION_RETIRED_MESSAGE } from '../src/gridRetirement';
import {
  appendRegeneratedImageResult,
  buildImageRegenerationTask,
  canRegenerateImageTask,
  executeImageRegeneration,
  resolveImageAssetRegenerationTask,
  resolveImageRegenerationSource,
} from '../src/imageRegeneration';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { applyVideoPromptChoice, emptyVideoDraft, isVideoDirectorImage, videoPromptChoices } from '../src/videoDirectorDraft';
import type { AppState, ImageGenerationTask, Project, ReferenceAsset, Storyboard, VideoShot } from '../src/types';

// All data is synthetic and in-memory. Image execution below uses a stub, never
// a model transport, desktop storage bridge, or a user's application data.
assert.equal(activeDirectorWorkflow('grid'), 'drama', 'old grid controls cannot reopen a new grid director flow');
assert.equal(activeDirectorWorkflow('drama'), 'drama');
assert.equal(activeDirectorWorkflow('action'), 'action', 'ordinary smart-director action classification is not retired');
assert.equal(activeDirectorWorkflow(), 'drama');
assert.equal(activeImageAssetKind('grid'), 'character', 'a stale grid workbench control falls back to an active creation kind');
for (const kind of ['character', 'location', 'prop'] as const) assert.equal(activeImageAssetKind(kind), kind);
assert.equal(activeImageAssetKind(), 'character');
assert.match(GRID_CREATION_RETIRED_MESSAGE, /新建流程已停用/u);
assert.match(GRID_CREATION_RETIRED_MESSAGE, /历史提示词、素材和任务仍保留/u);
assert.match(GRID_CREATION_RETIRED_MESSAGE, /9张独立画面/u);
assert.match(GRID_CREATION_RETIRED_MESSAGE, /不需要九宫格母版/u);

const timestamp = 1_700_000_000_000;
const base = createInitialState();
const savedPrompt = '  历史九宫格原稿\r\n第一格保持雨夜光线；第二格人物转身。\n  ';
const savedImagePrompt = 'A saved 3 by 3 cinematic contact sheet; nine ordered panels depict a traveler opening a wooden door in a rainy courtyard.';
const asset: ReferenceAsset = {
  id: 'legacy-grid-asset', name: '历史九宫格', type: 'grid', role: 'grid',
  imageVariant: 'grid', source: 'generated', mediaType: 'image',
  dataUrl: 'data:image/png;base64,SYNTHETIC_FIXTURE_ONLY',
  prompt: savedImagePrompt, imageBackend: 'openai',
  imageRequestSize: { width: 1536, height: 1024, sizeOverride: true },
  gridStates: Array.from({ length: 9 }, (_, index) => ({
    index: index + 1, subject: '旅人', action: `历史动作 ${index + 1}`,
    camera: '固定镜头', transition: '连续动作', lighting: '雨夜', result: `历史格 ${index + 1}`,
  })),
  tags: ['历史九宫格'], createdAt: timestamp, updatedAt: timestamp,
};
const shot: VideoShot = {
  id: 'legacy-grid-shot', index: 1, startSec: 0, endSec: 9,
  purpose: '历史提示词片段', subject: '旅人', action: '推开木门', camera: '缓慢推近',
  transition: '连续动作', lighting: '雨夜', sound: '雨声', result: '门已打开',
  referenceAssetIds: [asset.id], prompt: '历史单镜提示词\r\n保留原样。', locked: true,
};
const board: Storyboard = {
  id: 'legacy-grid-board', sceneId: 'legacy-grid-scene', sourceSceneIds: ['legacy-grid-scene'],
  sourceStoryTitle: '旧九宫格剧情', sourceStoryContent: '旅人在雨夜推开木门。',
  workflow: 'grid', inputMode: 'text', durationSec: 9, durationPreset: 'custom',
  shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9',
  resolution: '2K', audioMode: 'stereo', stylePresetId: 'style_cinema',
  ruleSetId: 'timeline_director_cn', converterPresetId: 'converter_grid',
  globalLock: '保留旧九宫格视觉状态', globalReferenceAssetIds: [asset.id],
  shots: [shot], finalPrompt: savedPrompt, promptMigrationPending: false,
  englishPrompt: '  Historical grid prompt\r\nKeep every character.  ',
  englishPromptSource: savedPrompt,
  officialPromptZh: '旧格式中文输出\n不要自动重写。',
  officialPromptEn: 'Historical official output.',
  officialPromptSource: savedPrompt,
  officialPromptEnSource: '旧格式中文输出\n不要自动重写。',
  promptPlan: {
    canonicalPrompt: savedPrompt, durationSec: 9, aspectRatio: '16:9', resolution: '2K',
    audioMode: 'stereo', workflow: 'grid', inputMode: 'text', shotIds: [shot.id],
    referenceAssetIds: [asset.id], constraints: ['保留历史九宫格规则'],
    trace: { ruleSetId: 'timeline_director_cn', converterId: 'converter_grid' },
  },
  revisions: [{
    id: 'legacy-grid-revision', storyboardId: 'legacy-grid-board', revision: 1,
    label: '旧稿版本', createdAt: timestamp - 1, finalPrompt: savedPrompt,
    englishPrompt: 'Historical saved revision.', officialPromptZh: '', officialPromptEn: '',
    officialPromptSource: '', officialPromptEnSource: '', sequencePromptHandoff: undefined,
    shots: [structuredClone(shot)], metadata: { workflow: 'grid', selectedAssetIds: [asset.id] },
  }],
  activeRevisionId: 'legacy-grid-revision', createdAt: timestamp, updatedAt: timestamp,
};
const task: ImageGenerationTask = {
  id: 'legacy-grid-task', kind: 'image', name: asset.name, assetKind: 'grid', imageVariant: 'grid',
  status: 'failed', prompt: savedImagePrompt, negativePrompt: 'saved negative prompt',
  width: 1536, height: 1024, sizeOverride: true, backend: 'openai', model: 'legacy-image-model',
  imageApiSnapshot: {
    version: 1, profileId: 'synthetic-legacy-image-profile',
    connectionFingerprint: 'a'.repeat(64), executionFingerprint: 'b'.repeat(64),
    config: { enabled: true, backend: 'openai', model: 'legacy-image-model' },
  },
  conversionSource: '历史九宫格转化输入\r\n不得以当前剧情覆盖。',
  converterSystemPrompt: '历史九宫格转换规则', referenceAssetIds: [asset.id],
  primaryReferenceAssetIds: [asset.id], imagePromptFormat: 'natural-language',
  imagePromptRuleSetId: 'legacy-grid-rule', imagePromptRuleSetVersion: '1.0',
  imagePromptPresetId: 'legacy-grid-preset', imagePromptPresetVersion: '1.0',
  resultAssetId: asset.id, error: '合成失败记录', createdAt: timestamp, updatedAt: timestamp,
};
const directorFingerprint = JSON.stringify([
  'grid', 'text', 'exact', 1, 'standard', '16:9', '2K', 'stereo',
  'style_cinema', 'timeline_director_cn', 'converter_grid', 'standard_cinema',
  [], [], '电影写实', '历史导演要求', [asset.id],
]);
const project: Project = {
  id: 'grid-retirement-project', name: '九宫格退休兼容性测试', description: 'Synthetic fixture only',
  sourceDocuments: [{
    id: 'legacy-grid-source', name: '确认原文', content: '旅人在雨夜推开木门。',
    createdAt: timestamp, updatedAt: timestamp,
  }],
  storyDraft: { name: '未提交草稿', content: '  未提交的九宫格剧情\r\n保留空格。  ', updatedAt: timestamp + 1 },
  characters: [], locations: [], props: [],
  scenes: [{
    id: board.sceneId, title: '雨夜庭院', content: board.sourceStoryContent || '', summary: '旧场景',
    characterIds: [], propIds: [], storyboardIds: [board.id], createdAt: timestamp, updatedAt: timestamp,
  }],
  storyboards: [board], sequencePlans: [], assets: [asset], generationTasks: [task],
  directorSettingsConfirmedFingerprint: directorFingerprint, directorSettingsConfirmedAt: timestamp,
  createdAt: timestamp, updatedAt: timestamp,
};
const state: AppState = { ...base, project, projects: [project], activeProjectId: project.id };
const before = structuredClone(state);
const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
const historicalBoard = restored.project.storyboards[0];
const historicalAsset = restored.project.assets[0];
const historicalTask = restored.project.generationTasks[0];
assert.equal(historicalTask.kind, 'image');
assert.ok(historicalTask.kind === 'image');

assert.equal(historicalBoard.workflow, 'grid', 'retiring entry points must not migrate old boards to drama');
assert.equal(historicalBoard.inputMode, 'text', 'legacy grid/text snapshots remain unmodified in storage');
for (const key of [
  'finalPrompt', 'englishPrompt', 'englishPromptSource', 'officialPromptZh', 'officialPromptEn',
  'officialPromptSource', 'officialPromptEnSource', 'promptPlan', 'shots', 'revisions',
  'globalReferenceAssetIds', 'activeRevisionId', 'createdAt', 'updatedAt',
] as const) {
  assert.deepEqual(historicalBoard[key], board[key], `historical board field ${key} must survive export/import`);
}
assert.equal(historicalAsset.type, 'grid');
assert.equal(historicalAsset.role, 'grid');
assert.equal(historicalAsset.imageVariant, 'grid');
assert.equal(historicalAsset.prompt, asset.prompt);
assert.equal(historicalAsset.dataUrl, asset.dataUrl);
assert.deepEqual(historicalAsset.gridStates, asset.gridStates);
assert.deepEqual(JSON.parse(JSON.stringify(historicalTask)), task,
  'terminal grid task and its exact persisted retry snapshot must survive export/import');
assert.deepEqual(restored.project.storyDraft, project.storyDraft);
assert.equal(restored.project.directorSettingsConfirmedFingerprint, directorFingerprint);
assert.deepEqual(state, before, 'compatibility reads must not rewrite the original in-memory project');
assert.ok(restored.converterPresets.some((preset) => preset.workflow === 'grid'), 'legacy grid converter rules remain stored');
assert.ok(restored.imagePromptRules.categoryPresets.some((preset) => preset.assetKind === 'grid'), 'legacy grid image rules remain available to retries');

const beforeUiRead = structuredClone(restored.project);
const restoredUi = deriveWorkspaceUiState(restored);
assert.equal(restoredUi.activeStoryboardId, board.id, 'a historical grid board remains selectable');
assert.equal(restoredUi.directorWorkflow, 'grid', 'the compatibility reader reports original workflow rather than rewriting it');
assert.equal(restoredUi.storyInput, project.storyDraft?.content, 'unsubmitted editor drafts are not replaced by old source text');
assert.equal(restoredUi.storyName, project.storyDraft?.name);
assert.deepEqual(restoredUi.selectedAssetIds, [asset.id]);
assert.equal(activeDirectorWorkflow(restoredUi.directorWorkflow), 'drama', 'only the new creation control is normalized');
assert.equal(historicalBoard.workflow, 'grid', 'normalizing a creation control cannot relabel the historical board');
assert.deepEqual(restored.project, beforeUiRead, 'deriving compatibility UI fields does not edit a historical project');

assert.equal(isVideoDirectorImage(historicalAsset), true, 'retired grid images remain manually selectable video references');
const historicalChoice = videoPromptChoices(restored.project).find((choice) => choice.storyboardId === historicalBoard.id && choice.language === 'zh');
assert.ok(historicalChoice, 'a saved grid prompt remains available to the video director');
const historicalVideoDraft = applyVideoPromptChoice(emptyVideoDraft(restored.settings), historicalChoice, restored.project, true);
assert.equal(historicalVideoDraft.prompt, historicalChoice.prompt, 'video draft copies the saved historical text verbatim');
assert.deepEqual(historicalVideoDraft.references, [{ assetId: asset.id, role: 'composition' }],
  'custom still-output filtering must not suppress an explicitly bound historical grid reference');
const shotOnlyGridProject = { ...restored.project, storyboards: [{ ...historicalBoard, globalReferenceAssetIds: [] }] };
assert.deepEqual(applyVideoPromptChoice(emptyVideoDraft(restored.settings), historicalChoice, shotOnlyGridProject, true).references,
  historicalVideoDraft.references, 'a historical shot/plan grid reference is not a custom imageFrame batch output');
assert.deepEqual(restored.project, beforeUiRead, 'selecting a historical video prompt does not rewrite grid source data');

const source = resolveImageRegenerationSource(historicalTask, restored.project);
assert.deepEqual(source, {
  conversionSource: task.conversionSource, converterSystemPrompt: task.converterSystemPrompt,
  referenceAssetIds: [asset.id], primaryReferenceAssetIds: [asset.id],
}, 'retry uses the saved grid snapshot, not a new director workflow');
assert.equal(canRegenerateImageTask(historicalTask, restored.project.generationTasks), true);
const retry = buildImageRegenerationTask(historicalTask, restored.project, {
  id: 'legacy-grid-retry', timestamp: timestamp + 2,
  backend: historicalTask.backend, model: historicalTask.model, source,
});
assert.equal(retry.assetKind, 'grid');
assert.equal(retry.imageVariant, 'grid');
assert.equal(retry.prompt, task.prompt);
assert.equal(retry.conversionSource, task.conversionSource);
assert.equal(retry.converterSystemPrompt, task.converterSystemPrompt);
assert.deepEqual(retry.referenceAssetIds, task.referenceAssetIds);
assert.deepEqual(retry.primaryReferenceAssetIds, task.primaryReferenceAssetIds);
assert.equal(retry.width, task.width);
assert.equal(retry.height, task.height);
assert.equal(retry.sizeOverride, true);
assert.deepEqual(retry.imageApiSnapshot, task.imageApiSnapshot, 'retry retains its saved API identity instead of following new workbench defaults');
assert.equal(retry.regenerationSourceTaskId, task.id);
assert.equal(retry.regenerationRootTaskId, task.id);
assert.equal(canRegenerateImageTask(historicalTask, [historicalTask, retry]), false, 'an active retry still blocks duplicate paid work');

let imageStubCalls = 0;
const execution = await executeImageRegeneration(retry, {
  referenceImages: ['synthetic-reference-pixels'], primaryReferenceImageCount: 1,
  convertPrompt: async () => { throw new Error('A saved grid prompt must not be reconverted.'); },
  persistPrompt: () => { throw new Error('A saved grid prompt must not be replaced.'); },
  generateImage: async (input) => {
    imageStubCalls += 1;
    assert.equal(input.prompt, savedImagePrompt);
    assert.equal(input.width, task.width);
    assert.equal(input.height, task.height);
    assert.equal(input.sizeOverride, true);
    assert.deepEqual(input.referenceImages, ['synthetic-reference-pixels']);
    assert.equal(input.primaryReferenceImageCount, 1);
    return { id: 'synthetic-retry-output' };
  },
});
assert.equal(imageStubCalls, 1);
assert.equal(execution.finalPrompt, savedImagePrompt);
const retryAsset: ReferenceAsset = { ...asset, id: 'legacy-grid-retry-asset', name: retry.name, createdAt: timestamp + 3, updatedAt: timestamp + 3 };
const appended = appendRegeneratedImageResult({
  ...restored.project, generationTasks: [retry, ...restored.project.generationTasks],
}, retry, retryAsset);
assert.deepEqual(appended.storyboards, restored.project.storyboards, 'a successful retry must not bind its output over the historical board');
assert.deepEqual(appended.assets.find((item) => item.id === asset.id), historicalAsset, 'the original grid image remains intact');
assert.deepEqual(appended.generationTasks.find((item) => item.id === task.id), historicalTask, 'the original task remains intact');
const completedRetry = appended.generationTasks.find((item) => item.id === retry.id);
assert.ok(completedRetry?.kind === 'image');
assert.equal(completedRetry.status, 'succeeded');
assert.match(completedRetry.bindingWarning || '', /未替换原始绑定/u);

const assetOnlyProject = { ...restored.project, generationTasks: [] };
const syntheticTask = resolveImageAssetRegenerationTask(historicalAsset, assetOnlyProject, base.settings.imageApi);
assert.ok(syntheticTask, 'a legacy grid asset with a saved prompt remains regenerable even without its task');
assert.equal(syntheticTask.assetKind, 'grid');
assert.equal(syntheticTask.imageVariant, 'grid');
assert.equal(syntheticTask.prompt, savedImagePrompt);
assert.equal(syntheticTask.width, task.width);
assert.equal(syntheticTask.height, task.height);
assert.equal(syntheticTask.sizeOverride, true);
assert.equal(resolveImageAssetRegenerationTask(historicalAsset, restored.project, base.settings.imageApi), historicalTask);

const emptyReferenceSnapshot = { ...historicalTask, referenceAssetIds: [], primaryReferenceAssetIds: [] };
assert.deepEqual(resolveImageRegenerationSource(emptyReferenceSnapshot, restored.project).referenceAssetIds, [],
  'retry must not auto-bind an available grid image when the historical snapshot explicitly had none');
assert.deepEqual(state, before);
console.log('grid retirement compatibility: historical text, drafts, enums, rules, media, snapshots and offline retries passed');

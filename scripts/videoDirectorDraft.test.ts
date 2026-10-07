import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { buildOfficialH3SourceFingerprint, hasCurrentOfficialH3Prompt, officialH3MissingReferenceNotice } from '../src/officialPrompt';
import { buildVideoBatchRows } from '../src/videoBatch';
import type { ImageGenerationTask, ReferenceAsset, Storyboard, VideoGenerationTask } from '../src/types';
import { bindStoryboardImageAsset, buildCustomStoryboardImageRequests } from '../src/storyboardImages';
import { addVideoDraftAssets, applyVideoPromptChoice, draftFromVideoTask, emptyVideoDraft, formatVideoElapsed, isVideoDirectorImage, reorderVideoReference, videoExecutionElapsedMs, videoPromptChoices, videoPromptReferencePreviews } from '../src/videoDirectorDraft';

const state = createInitialState();
const project = state.project;
const asset = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'reference', role: 'composition', referenceRole: 'composition', dataUrl: 'data:image/png;base64,AA==', tags: [], createdAt: 1, updatedAt: 1, ...patch,
});
project.assets = [asset('composition'), asset('character', { type: 'character', role: 'character', referenceRole: 'character' }), asset('first', { type: 'first-frame', role: 'first-frame', referenceRole: 'first-frame' }), asset('movie', { type: 'video', mediaType: 'video' }), asset('audio', { type: 'audio', mediaType: 'audio' }), asset('disguised-movie', { mimeType: 'video/mp4' })];
const board: Storyboard = {
  id: 'board-1', sceneId: project.scenes[0].id, sourceStoryTitle: '长剧情', workflow: 'drama', inputMode: 'text_reference', durationSec: 15, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '',
  sequencePlanId: 'sequence', segmentId: 'segment-2', segmentIndex: 2, segmentCount: 3,
  shots: [{ id: 'shot-1', index: 1, startSec: 0, endSec: 15, purpose: '', subject: '', action: '', camera: '', transition: '', lighting: '', sound: '林澜：“别走，我有话要说。”', result: '', referenceAssetIds: ['character'], prompt: '', locked: false }],
  globalReferenceAssetIds: ['composition'], firstFrameAssetId: 'first', finalPrompt: '内部稿',
  officialPromptZh: '【第2段】\n林澜：“别走，我有话要说。”\n细节与对白原字不动。\n',
  officialPromptEn: '【第2段】\n林澜：“别走，我有话要说。”\nNatural medium shot.\n',
  activeRevisionId: 'revision-a', revisions: [{ id: 'revision-a', label: '已确认版本', createdAt: 1, finalPrompt: '内部稿' }], createdAt: 1, updatedAt: 2,
};
project.storyboards = [board, { ...board, id: 'board-2', segmentId: 'segment-3', segmentIndex: 3, officialPromptZh: '第三段，独立对白。', officialPromptEn: undefined, updatedAt: 3 }];
const before = JSON.stringify(project);
const choices = videoPromptChoices(project);
assert.equal(choices.length, 3);
assert.equal(choices[0].storyboardId, 'board-2');
const chinese = choices.find((choice) => choice.id === 'board-1:zh')!;
const english = choices.find((choice) => choice.id === 'board-1:en')!;
assert.equal(chinese.version, '已确认版本');
assert.equal(chinese.segmentIndex, 2);
const empty = emptyVideoDraft(state.settings);
assert.deepEqual(empty.parameters, {});
const selected = applyVideoPromptChoice(empty, chinese, project, true);
assert.equal(selected.prompt, board.officialPromptZh, 'prompt copied byte-for-byte including dialogue and final newline');
assert.ok(!selected.prompt.includes('第三段'), 'single-segment selection never appends whole sequence');
assert.equal(selected.source?.segmentId, 'segment-2');
assert.equal(selected.source?.promptVersion, 'revision-a');
assert.deepEqual(selected.parameters, {}, 'selecting a prompt never overwrites seeds, duration or sampling defaults');
assert.deepEqual(selected.references, [{ assetId: 'composition', role: 'composition' }, { assetId: 'character', role: 'character' }, { assetId: 'first', role: 'first-frame' }]);
const translated = applyVideoPromptChoice(selected, english, project, false);
assert.equal(translated.prompt, board.officialPromptEn, 'English selection uses existing generated description only');
assert.ok(translated.prompt.includes('别走，我有话要说。'), 'Chinese dialogue is not translated');
assert.equal(translated.source?.language, 'en');
assert.equal(JSON.stringify(project), before, 'all source storyboards, references and assets remain unmodified');
const manualSelection = addVideoDraftAssets(empty, ['composition', 'character', 'composition', 'movie', 'audio', 'disguised-movie'], project.assets);
assert.deepEqual(manualSelection.references.map((reference) => reference.assetId), ['composition', 'character']);
assert.equal(manualSelection.references[0].role, 'composition', 'composition never silently becomes a first-frame image');
assert.ok(isVideoDirectorImage(asset('clay', { type: 'clay-render', mediaType: 'clay-render' })));

// Exercise the real image-output binding path, not an invented asset count.
// These nine independent stills remain in the board/library but are not nine
// automatic video references. No image or text transport is called here.
const customRequests = buildCustomStoryboardImageRequests(board, Array.from({ length: 9 }, (_, index) => ({
  sourceShotId: board.shots[0].id, description: `合成静帧 ${index + 1}：人物停在门边。`, timeSec: index,
}))).map((request) => ({ ...request, imageFrameBatchId: 'synthetic-custom-batch' }));
const customAssets = customRequests.map((request, index) => asset(`custom-${index + 1}`, {
  source: 'generated', sourceStoryboardId: board.id, sourceShotId: request.shotId,
  imageVariant: request.imageVariant, imageFrameBatchId: request.imageFrameBatchId,
  imageFrameIndex: request.imageFrameIndex, imageFrameCount: request.imageFrameCount,
  imageFrameDescription: request.imageFrameDescription, imageFrameTimeSec: request.imageFrameTimeSec,
}));
const customIds = customAssets.map((item) => item.id);
const boundCustomBoard = customRequests.reduce((current, request, index) => (
  bindStoryboardImageAsset(current, request, customIds[index])
), board);
const customBoard: Storyboard = {
  ...boundCustomBoard,
  storyboardImageCount: 9,
  promptPlan: {
    canonicalPrompt: board.finalPrompt, durationSec: board.durationSec, aspectRatio: board.aspectRatio,
    resolution: board.resolution, audioMode: board.audioMode, workflow: board.workflow, inputMode: board.inputMode,
    shotIds: board.shots.map((shot) => shot.id), referenceAssetIds: customIds, constraints: [],
    trace: { ruleSetId: board.ruleSetId, converterId: board.converterPresetId },
  },
  promptTrace: {
    modelRuleSetId: board.ruleSetId, converterPresetId: board.converterPresetId,
    sourceDocumentIds: [], referenceAssetIds: customIds, generatedAt: 2, mode: 'text-api',
  },
};
const customProject = { ...project, assets: [...project.assets, ...customAssets], storyboards: [customBoard], generationTasks: [] };
const customBefore = structuredClone(customProject);
const customSelected = applyVideoPromptChoice(empty, chinese, customProject, true);
assert.deepEqual(customSelected.references, selected.references,
  'all nine same-board custom outputs are excluded across shot, prompt-plan and prompt-trace automatic references');
assert.equal(customSelected.prompt, chinese.prompt, 'custom images never rewrite the selected prompt');
assert.deepEqual(customSelected.parameters, empty.parameters);
assert.equal(customProject.assets.filter((item) => customIds.includes(item.id)).length, 9);
assert.deepEqual(customBoard.shots[0].referenceAssetIds, ['character', ...customIds], 'image output bindings remain present');
assert.deepEqual(customProject, customBefore, 'video reference selection never removes image outputs or changes the source board');
assert.deepEqual(addVideoDraftAssets(empty, customIds, customProject.assets).references.map((reference) => reference.assetId), customIds,
  'all nine images remain available when the user explicitly selects them');
for (const count of [1, 100]) {
  const outputs = Array.from({ length: count }, (_, index) => asset(`custom-${count}-${index + 1}`, {
    source: 'generated', sourceStoryboardId: board.id, imageVariant: 'storyboard-frame',
    imageFrameIndex: index + 1, imageFrameCount: count,
    // Older custom outputs may predate batch ids; their valid slots still prove
    // the custom-image origin independently of today's image-count control.
  }));
  assert.deepEqual(applyVideoPromptChoice(empty, chinese, {
    ...project, assets: [...project.assets, ...outputs], generationTasks: [],
    storyboards: [{ ...board, storyboardImageCount: undefined, shots: [{
      ...board.shots[0], referenceAssetIds: [...board.shots[0].referenceAssetIds, ...outputs.map((item) => item.id)],
    }] }],
  }, true).references, selected.references, `custom output filtering applies to all ${count} slots without needing the task or current count setting`);
}

const manualCustomDraft = addVideoDraftAssets(empty, [customIds[3]], customProject.assets);
manualCustomDraft.references[0].role = 'style';
const explicitCustomProject = { ...customProject, storyboards: [{
  ...customBoard, globalReferenceAssetIds: ['composition', customIds[0]], firstFrameAssetId: customIds[1], lastFrameAssetId: customIds[8],
}] };
assert.deepEqual(applyVideoPromptChoice(manualCustomDraft, chinese, explicitCustomProject, true).references, [
  { assetId: customIds[3], role: 'style' },
  { assetId: 'composition', role: 'composition' },
  { assetId: customIds[0], role: 'composition' },
  { assetId: customIds[1], role: 'first-frame' },
  { assetId: customIds[8], role: 'last-frame' },
  { assetId: 'character', role: 'character' },
], 'explicit global/boundary selections and an existing manually chosen draft image override automatic-output exclusion');
assert.deepEqual(applyVideoPromptChoice(manualCustomDraft, chinese, customProject, true).references, [
  ...manualCustomDraft.references, ...selected.references,
], 'an existing manual draft choice survives even if it is not selected globally or as a boundary');
assert.deepEqual(applyVideoPromptChoice(manualCustomDraft, chinese, explicitCustomProject, false).references, manualCustomDraft.references,
  'turning off automatic references preserves only the current manual selection');
assert.deepEqual(manualCustomDraft.references, [{ assetId: customIds[3], role: 'style' }], 'the original draft remains unchanged');

const preservedAssets: ReferenceAsset[] = [
  asset('ordinary-shot-output', { ...customAssets[0], id: 'ordinary-shot-output', imageFrameIndex: undefined, imageFrameCount: undefined }),
  asset('other-board-output', { ...customAssets[0], id: 'other-board-output', sourceStoryboardId: 'other-board' }),
  asset('missing-board-output', { ...customAssets[0], id: 'missing-board-output', sourceStoryboardId: undefined }),
  asset('legacy-grid', { type: 'grid', role: 'grid', referenceRole: undefined, source: 'generated', sourceStoryboardId: board.id, imageVariant: 'grid' }),
  ...(['upload', 'remote', 'imported', 'derived'] as const).map((source) => (
    asset(`${source}-image`, { ...customAssets[0], id: `${source}-image`, source })
  )),
  ...[
    { imageFrameIndex: undefined }, { imageFrameCount: undefined }, { imageFrameIndex: 0 },
    { imageFrameIndex: -1 }, { imageFrameIndex: 1.5 }, { imageFrameIndex: 10 },
    { imageFrameCount: Number.POSITIVE_INFINITY }, { imageFrameCount: 9.5 },
  ].map((metadata, index) => asset(`unknown-frame-${index}`, { ...customAssets[0], id: `unknown-frame-${index}`, ...metadata })),
];
const preservationBoard: Storyboard = {
  ...board, globalReferenceAssetIds: [], firstFrameAssetId: undefined,
  shots: [{ ...board.shots[0], referenceAssetIds: preservedAssets.map((item) => item.id) }],
};
assert.deepEqual(applyVideoPromptChoice(empty, chinese, {
  ...project, assets: preservedAssets, storyboards: [preservationBoard], generationTasks: [],
}, true).references.map((reference) => reference.assetId), preservedAssets.map((item) => item.id),
'ordinary per-shot batch ids, other-board images, imported references and unknown metadata are not blanket-filtered');

const imageTask = (id: string, resultAssetId: string, patch: Partial<ImageGenerationTask> = {}): ImageGenerationTask => ({
  id, resultAssetId, kind: 'image', name: id, assetKind: 'storyboard', imageVariant: 'storyboard-frame', status: 'succeeded',
  sourceStoryboardId: board.id, sourceShotId: board.shots[0].id, imageFrameIndex: 1, imageFrameCount: 9,
  prompt: 'Synthetic saved image prompt', width: 1024, height: 1024, backend: 'openai', model: 'synthetic-only', createdAt: 1, updatedAt: 2,
  ...patch,
});
const provenTaskAssets = [asset('task-proven-output'), asset('task-proven-generated-output', { source: 'generated' })];
const unsupportedTaskCases: Array<{ asset: ReferenceAsset; taskPatch?: Partial<ImageGenerationTask> }> = [
  { asset: asset('failed-task-output'), taskPatch: { status: 'failed' } },
  { asset: asset('running-task-output'), taskPatch: { status: 'running' } },
  { asset: asset('queued-task-output'), taskPatch: { status: 'queued' } },
  { asset: asset('other-board-task-output'), taskPatch: { sourceStoryboardId: 'other-board' } },
  { asset: asset('ordinary-task-output'), taskPatch: { imageFrameIndex: undefined, imageFrameCount: undefined, imageFrameBatchId: 'ordinary-batch' } },
  { asset: asset('grid-task-output'), taskPatch: { assetKind: 'grid', imageVariant: 'grid' } },
  { asset: asset('entity-task-output'), taskPatch: { assetKind: 'character' } },
  { asset: asset('conflicting-board', { sourceStoryboardId: 'other-board' }) },
  { asset: asset('conflicting-source', { source: 'upload' }) },
  { asset: asset('conflicting-variant', { imageVariant: 'grid' }) },
  { asset: asset('conflicting-entity', { sourceEntityId: 'character-1', sourceEntityKind: 'character' }) },
];
const unsupportedTaskAssets = unsupportedTaskCases.map((item) => item.asset);
const taskEvidenceAssets = [...provenTaskAssets, ...unsupportedTaskAssets];
const taskEvidenceProject = {
  ...project, assets: taskEvidenceAssets,
  storyboards: [{ ...preservationBoard, shots: [{ ...board.shots[0], referenceAssetIds: taskEvidenceAssets.map((item) => item.id) }] }],
  generationTasks: [
    ...provenTaskAssets.map((item) => imageTask(`task-${item.id}`, item.id)),
    ...unsupportedTaskCases.map((item) => imageTask(`task-${item.asset.id}`, item.asset.id, item.taskPatch)),
    imageTask('task-with-missing-result', 'missing-result'),
  ],
};
const evidenceBefore = structuredClone(taskEvidenceProject);
assert.deepEqual(applyVideoPromptChoice(empty, chinese, taskEvidenceProject, true).references.map((reference) => reference.assetId),
  unsupportedTaskAssets.map((item) => item.id),
  'a succeeded same-board custom task may prove missing output metadata but never overrides conflicting source identity');
assert.deepEqual(taskEvidenceProject, evidenceBefore, 'task provenance reads do not modify historical tasks or image assets');

const privateBreastAsset = asset('private-breasts', {
  type: 'character',
  role: 'character',
  referenceRole: 'character',
  sourceEntityId: 'adult-a-lian',
  sourceEntityKind: 'character',
  referenceScope: 'nsfw-private-profile',
  nsfwPrivatePart: 'breasts',
  imageVariant: 'private-close-up',
});
assert.equal(isVideoDirectorImage(privateBreastAsset), true, 'manual video image pickers include every image asset from the library');
assert.deepEqual(
  addVideoDraftAssets(empty, [privateBreastAsset.id], [privateBreastAsset]).references,
  [{ assetId: privateBreastAsset.id, role: 'character' }],
  'a manual launch request may use an explicitly selected library image',
);

const adultCharacter = {
  ...project.characters[0],
  id: 'adult-a-lian',
  name: '阿莲',
  apparentAge: '二十五岁',
  assetIds: [privateBreastAsset.id],
};
const privateShot = {
  ...board.shots[0],
  id: 'private-shot',
  visiblePrivatePartsByCharacter: { [adultCharacter.id]: ['breasts' as const] },
  subject: '阿莲独自位于卧室中央',
  action: '二十五岁的阿莲上身裸露，镜头明确表现她的胸部与乳头。',
  result: '阿莲仍保持上身裸露',
  referenceAssetIds: [privateBreastAsset.id],
};
const privateBoard: Storyboard = {
  ...board,
  id: 'private-board',
  sourceStoryContent: '阿莲二十五岁。阿莲上身裸露，镜头明确表现她的胸部与乳头。',
  shots: [privateShot],
  globalReferenceAssetIds: [],
  firstFrameAssetId: undefined,
};
const privateProject = {
  ...project,
  characters: [...project.characters, adultCharacter],
  assets: [...project.assets, privateBreastAsset],
  storyboards: [privateBoard],
};
const privateChoice = {
  ...chinese,
  id: 'private-board:zh',
  storyboardId: privateBoard.id,
  prompt: '成人 NSFW 镜头提示词',
};
assert.deepEqual(
  applyVideoPromptChoice(empty, privateChoice, {
    ...privateProject,
    storyboards: [{ ...privateBoard, shots: [{ ...privateShot, visiblePrivatePartsByCharacter: undefined }] }],
  }, true).references,
  [],
  'body words or a stored private asset do not authorize automatic inclusion without an explicit current-shot scope',
);
assert.deepEqual(
  applyVideoPromptChoice(empty, privateChoice, privateProject, true).references,
  [{ assetId: privateBreastAsset.id, role: 'character' }],
  'an explicitly adult, same-character, body-part-matched shot may opt in its private reference',
);
assert.deepEqual(
  applyVideoPromptChoice(empty, privateChoice, {
    ...privateProject,
    storyboards: [{
      ...privateBoard,
      shots: [{ ...privateShot, visiblePrivatePartsByCharacter: { [adultCharacter.id]: ['vulva' as const] }, action: '二十五岁的阿莲下身裸露，镜头明确表现外阴。' }],
    }],
  }, true).references,
  [],
  'a private asset for a different body part must not enter the video draft',
);
assert.deepEqual(
  applyVideoPromptChoice(empty, privateChoice, {
    ...privateProject,
    characters: [...project.characters, { ...adultCharacter, apparentAge: '' }],
    storyboards: [{ ...privateBoard, sourceStoryContent: '阿莲上身裸露，镜头明确表现她的胸部与乳头。' }],
  }, true).references,
  [{ assetId: privateBreastAsset.id, role: 'character' }],
  'private-reference routing must not depend on age metadata',
);
assert.deepEqual(
  applyVideoPromptChoice(empty, privateChoice, {
    ...privateProject,
    storyboards: [{
      ...privateBoard,
      globalReferenceAssetIds: [privateBreastAsset.id],
      shots: [{ ...privateShot, referenceAssetIds: [] }],
    }],
  }, true).references,
  [],
  'a project-wide/global binding is not a shot-scoped private opt-in',
);
assert.deepEqual(reorderVideoReference(manualSelection.references, 0, 1).map((reference) => reference.assetId), ['character', 'composition']);
assert.deepEqual(manualSelection.references.map((reference) => reference.assetId), ['composition', 'character'], 'reorder does not mutate existing array');
assert.equal(reorderVideoReference(manualSelection.references, 0, -1), manualSelection.references);
const { apiKey: _apiKey, ...safeApi } = state.settings.videoTaskApi;
const task: VideoGenerationTask = {
  id: 'task-1', kind: 'video', storyboardId: board.id, targetId: 'mock', status: 'succeeded', requestBody: {}, createdAt: 1, updatedAt: 2,
  videoJob: { stage: 'succeeded', snapshot: { projectId: project.id, draft: { ...selected, parameters: { seed: 42, nested: { cfg: 4 } } }, connection: { backend: 'api', api: safeApi }, images: [], clientId: 'client' } },
};
const reused = draftFromVideoTask(task)!;
assert.equal(reused.reuseTaskId, task.id, 'engine receives source task for exact workflow/connection snapshot reuse');
assert.deepEqual(reused.parameters, { seed: 42, nested: { cfg: 4 } });
reused.references[0].role = 'style';
(reused.parameters.nested as { cfg: number }).cfg = 9;
assert.equal(task.videoJob!.snapshot.draft.references[0].role, 'composition');
assert.equal((task.videoJob!.snapshot.draft.parameters.nested as { cfg: number }).cfg, 4, 'reuse draft cannot mutate old task snapshot');
assert.equal(draftFromVideoTask({ ...task, videoJob: undefined }), undefined);
assert.equal(formatVideoElapsed(3661000), '1小时 1分 1秒');
assert.equal(formatVideoElapsed(-1000), '0分 0秒');
assert.equal(videoExecutionElapsedMs(undefined, 90_000), undefined, 'missing runtime never invents an execution clock');
assert.equal(videoExecutionElapsedMs({ startedAt: undefined }, 90_000), undefined, 'queued time is excluded until the backend really starts');
assert.equal(videoExecutionElapsedMs({ startedAt: 80_000 }, 90_000), 10_000, 'running time begins at the observed execution start');
assert.equal(videoExecutionElapsedMs({ startedAt: 80_000, generatedAt: 85_000, completedAt: 88_000 }, 99_000), 5_000, 'successful generation freezes when backend output is ready, excluding save time');
assert.equal(videoExecutionElapsedMs({ startedAt: 80_000, completedAt: 86_000 }, 99_000), 6_000, 'failed execution freezes at completion');
assert.equal(draftFromVideoTask({ ...task, videoJob: { ...task.videoJob!, legacyMetadataIncomplete: true } }), undefined);
const wrongEnglish = { ...board, officialPromptEn: '【第2段】\n林澜：“Do not go. I have something to say.”\n', englishPrompt: '【第2段】\n林澜：“Do not go.”\n' };
assert.equal(videoPromptChoices({ ...project, storyboards: [wrongEnglish] }).find((choice) => choice.language === 'en')?.prompt, wrongEnglish.officialPromptEn,
  'a nonempty saved AI result remains selectable without a local dialogue-language gate');
const staleGenericEnglish = { ...wrongEnglish, officialPromptEnSource: 'older official source', englishPromptSource: 'older canonical source' };
assert.ok(!videoPromptChoices({ ...project, storyboards: [staleGenericEnglish] }).some((choice) => choice.language === 'en'),
  'removing semantic checks must not offer generic English from a different saved source');
const staleH3 = { ...board, targetModelId: 'minimax-h3', officialPromptSource: 'official-h3-v1:old-cache', finalPrompt: '当前结构化原稿：林澜：“别走，我有话要说。”' };
const staleChoices = videoPromptChoices({ ...project, storyboards: [staleH3] });
assert.equal(staleChoices.length, 0, 'stale H3 does not fall back to the ordinary canonical prompt as an H3 choice');
const h3Context = { assets: project.assets, characters: project.characters, locations: project.locations, props: project.props, sceneContent: project.scenes[0].content };
const chineseH3 = `integrated_multimodal_description: [Shot 1] ${board.officialPromptZh}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const englishH3 = `integrated_multimodal_description: [Shot 1] ${board.officialPromptEn}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const currentH3: Storyboard = { ...board, targetModelId: 'minimax-h3', officialPromptZh: chineseH3, officialPromptEn: englishH3, targetOutput: { targetId: 'minimax-h3', prompt: chineseH3, parameters: {}, referenceManifest: [], warnings: [], generatedAt: 1 }, officialPromptEnSource: chineseH3 };
currentH3.officialPromptSource = buildOfficialH3SourceFingerprint(currentH3, h3Context);
const currentChoices = videoPromptChoices({ ...project, storyboards: [currentH3] });
assert.equal(currentChoices.find((choice) => choice.language === 'en')?.prompt, englishH3, 'valid current H3 English retains original dialogue and remains selectable');
const currentH3ModelEnglish = { ...currentH3, officialPromptEn: englishH3.replace('别走，我有话要说。', 'Do not go. I have something to say.') };
assert.equal(videoPromptChoices({ ...project, storyboards: [currentH3ModelEnglish] }).find((choice) => choice.language === 'en')?.prompt, currentH3ModelEnglish.officialPromptEn,
  'current H3 English also remains selectable after model-authored dialogue wording changes');
// A missing source picture exposes the exact saved original without making it
// a valid candidate. The pure output-deletion path is covered by assetDeletion.
const missingReferenceBoard: Storyboard = { ...currentH3, globalReferenceAssetIds: [],
  targetOutput: { ...currentH3.targetOutput!, referenceManifest: [{ id: 'composition', token: '<Picture 1>', mediaType: 'image' }] },
};
const missingReferenceProject = { ...project, assets: project.assets.filter((item) => item.id !== 'composition'), storyboards: [missingReferenceBoard] };
const beforeMissingPreview = JSON.stringify(missingReferenceProject);
assert.equal(hasCurrentOfficialH3Prompt(missingReferenceBoard), true, 'the saved canonical and official body still agree');
assert.equal(hasCurrentOfficialH3Prompt(missingReferenceBoard, { ...h3Context, assets: missingReferenceProject.assets }), false);
const savedReferencePreviews = videoPromptReferencePreviews(missingReferenceProject);
assert.deepEqual(savedReferencePreviews.map((item) => item.prompt), [chineseH3, englishH3], 'both original languages remain available byte for byte');
assert.ok(savedReferencePreviews.every((item) => item.referenceNotice.startsWith('参考图待更新')));
assert.equal(videoPromptChoices(missingReferenceProject).length, 0, 'read-only original previews must never enter single submission choices');
const referencePlan = { id: 'sequence', title: '参考图测试', sourceStoryTitle: '剧情', sourceStoryContent: '原剧情',
  durationMode: 'fixed' as const, totalDurationSec: 15, segmentDurationSec: 15, segmentationMode: 'fixed' as const,
  fitStatus: 'balanced' as const, segments: [{ id: 'segment-2', index: 2, title: '原段', globalStartSec: 0, globalEndSec: 15,
    durationSec: 15, content: '原剧情', summary: '原剧情', sourceSceneIds: [board.sceneId], sourceBeatIds: [], sourceShotIds: [],
    narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: board.id, status: 'ready' as const }], createdAt: 1, updatedAt: 1 };
const missingRows = buildVideoBatchRows(missingReferenceProject, referencePlan, state.settings);
assert.equal(missingRows.length, 1);
assert.equal(missingRows[0].zh, undefined, 'batch selection remains guarded');
assert.equal(missingRows[0].en, undefined, 'batch English selection remains guarded');
assert.equal(JSON.stringify(missingReferenceProject), beforeMissingPreview, 'preview cannot change source hashes or saved text');
assert.equal(videoPromptReferencePreviews({ ...missingReferenceProject, storyboards: [{ ...missingReferenceBoard, finalPrompt: '用户改过剧情' }] }).length, 0,
  'canonical story edits are not classified as a reference-only recovery');
assert.equal(videoPromptReferencePreviews({ ...missingReferenceProject, storyboards: [{ ...missingReferenceBoard, sourceStale: true }] }).length, 0);
assert.equal(videoPromptReferencePreviews({ ...missingReferenceProject, storyboards: [{ ...missingReferenceBoard, officialPromptEnSource: '旧中文' }] }).length, 1,
  'mismatched English is not exposed as a recoverable current translation');
assert.equal(officialH3MissingReferenceNotice(currentH3, h3Context), undefined, 'valid output remains normal');
assert.equal(videoPromptReferencePreviews({ ...project, storyboards: [staleH3] }).length, 0, 'legacy invalid artifacts do not bypass validation');
console.log('videoDirectorDraft: prompt selection, missing-reference original previews, explicit references and snapshot tests passed');

import assert from 'node:assert/strict';
import {
  allVideoBatchChoiceKeys,
  buildVideoBatchRows,
  cancelledVideoBatchTaskBeforePost,
  findVideoBatchDuplicate,
  preflightVideoBatchManagedReferences,
  toggleVideoBatchChoice,
  ungeneratedVideoBatchChoiceKeys,
  videoBatchReferenceFingerprint,
  videoTaskRequestFingerprint,
  type VideoBatchChoiceCandidate,
} from '../src/videoBatch';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { createInitialState } from '../src/storage';
import type {
  AppState,
  Project,
  ReferenceAsset,
  Storyboard,
  VideoGenerationTask,
  VideoSegment,
  VideoSequencePlan,
} from '../src/types';
import type { VideoGenerationSnapshot } from '../src/videoGenerationTypes';
import type { VideoImageReference } from '../src/videoGenerationTypes';

const state = createInitialState();
const settings = structuredClone(state.settings);
settings.videoBackend = 'api';
settings.activeVideoApiProfileId = null;
settings.videoApiProfiles = [];
settings.videoTaskApi = {
  ...settings.videoTaskApi,
  enabled: true,
  endpoint: 'https://video.example.test/generate',
  statusEndpointTemplate: 'https://video.example.test/status/{id}',
  apiKey: 'must-not-enter-fingerprints',
  provider: 'generic',
  model: 'batch-test-model',
};

const asset = (
  id: string,
  checksum: string,
  role: 'character' | 'scene',
): ReferenceAsset => ({
  id,
  name: id,
  type: role === 'character' ? 'character' : 'reference',
  role,
  referenceRole: role,
  mediaType: 'image',
  relativePath: `image/${id}.png`,
  checksum,
  tags: ['批量测试'],
  createdAt: 1,
  updatedAt: 1,
});

const assets = [
  asset('character-a', 'checksum-a', 'character'),
  asset('scene-b', 'checksum-b', 'scene'),
];

const segment = (index: number): VideoSegment => ({
  id: `segment-${index}`,
  index,
  title: `第 ${index} 段`,
  globalStartSec: (index - 1) * 15,
  globalEndSec: index * 15,
  durationSec: 15,
  content: `第 ${index} 段剧情`,
  summary: `第 ${index} 段摘要`,
  sourceSceneIds: ['scene'],
  sourceBeatIds: [`beat-${index}`],
  narrativePurpose: '推进剧情',
  entryState: '进入',
  exitState: '离开',
  transitionHint: '连续',
  storyboardId: `board-${index}`,
  status: 'ready',
});

const plan: VideoSequencePlan = {
  id: 'plan-15',
  title: '十五段长剧情',
  sourceStoryTitle: '十五段长剧情',
  sourceStoryContent: '测试剧情',
  durationMode: 'ai-estimated',
  totalDurationSec: 225,
  segmentDurationSec: 15,
  segmentationMode: 'natural',
  fitStatus: 'balanced',
  masterStoryboardId: 'master-board',
  planningStage: 'segmented',
  // Deliberately shuffled: batch rows must follow the explicit segment index.
  segments: Array.from({ length: 15 }, (_, offset) => segment(offset + 1))
    .sort((left, right) => (left.index % 4) - (right.index % 4)),
  createdAt: 1,
  updatedAt: 1,
};

const board = (index: number): Storyboard => {
  const sameLanguageText = index === 7;
  const zh = sameLanguageText ? '第七段中英文故意完全相同。' : `第 ${index} 段中文提示词。`;
  const en = sameLanguageText ? zh : `Segment ${index} English description.`;
  const referenceAssetIds = index === 1 ? ['character-a'] : index === 2 ? ['scene-b'] : [];
  return {
    id: `board-${index}`,
    sceneId: 'scene',
    sourceStoryTitle: '十五段长剧情',
    workflow: 'drama',
    inputMode: 'text_reference',
    durationSec: 15,
    durationPreset: '15s',
    shotMode: 'auto',
    pace: 'standard',
    aspectRatio: '16:9',
    resolution: '1080p',
    audioMode: 'stereo',
    stylePresetId: '',
    ruleSetId: '',
    converterPresetId: '',
    globalLock: '',
    globalReferenceAssetIds: referenceAssetIds,
    shots: [{
      id: `shot-${index}`,
      index: 1,
      startSec: 0,
      endSec: 15,
      purpose: '推进剧情',
      subject: '测试主体',
      action: '完成动作',
      camera: '中景',
      transition: '自然衔接',
      lighting: '自然光',
      sound: '环境声',
      result: '动作完成',
      referenceAssetIds,
      prompt: zh,
      locked: false,
    }],
    finalPrompt: zh,
    englishPrompt: en,
    englishPromptSource: zh,
    officialPromptZh: zh,
    officialPromptEn: en,
    officialPromptSource: zh,
    officialPromptEnSource: zh,
    targetModelId: 'custom',
    sequencePlanId: plan.id,
    segmentId: `segment-${index}`,
    segmentIndex: index,
    segmentCount: 15,
    createdAt: index,
    updatedAt: 100 + index,
  };
};

const master: Storyboard = {
  ...board(1),
  id: 'master-board',
  segmentId: undefined,
  segmentIndex: undefined,
  finalPrompt: '母版不能进入批量列表',
  officialPromptZh: '母版不能进入批量列表',
  officialPromptEn: 'Master must not enter the batch.',
  updatedAt: 10_000,
};
const orphan: Storyboard = {
  ...board(2),
  id: 'orphan-board',
  segmentId: 'deleted-segment',
  segmentIndex: 99,
  finalPrompt: '孤立分镜不能进入批量列表',
  officialPromptZh: '孤立分镜不能进入批量列表',
  officialPromptEn: 'Orphan must not enter the batch.',
  updatedAt: 20_000,
};

const project: Project = {
  ...structuredClone(state.project),
  id: 'video-batch-project',
  name: '批量视频测试',
  scenes: [{
    id: 'scene', title: '测试剧情', content: '十五段测试剧情', summary: '测试',
    characterIds: [], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1,
  }],
  storyboards: [master, orphan, ...Array.from({ length: 15 }, (_, offset) => board(offset + 1))],
  sequencePlans: [plan],
  assets,
  generationTasks: [],
};

const initialRows = buildVideoBatchRows(project, plan, settings);
assert.equal(initialRows.length, 15, 'one row is returned for every real segment');
assert.deepEqual(initialRows.map((row) => row.index), Array.from({ length: 15 }, (_, index) => index + 1));
assert.equal(initialRows.some((row) => row.storyboardId === master.id), false, 'master is excluded');
assert.equal(initialRows.some((row) => row.storyboardId === orphan.id), false, 'orphan is excluded');
assert.equal(allVideoBatchChoiceKeys(initialRows).size, 30, '15 complete bilingual segments expose 30 independent choices');
assert.equal(allVideoBatchChoiceKeys(initialRows, 'zh').size, 15);
assert.equal(allVideoBatchChoiceKeys(initialRows, 'en').size, 15);

const seventh = initialRows[6];
assert.equal(seventh.zh?.choice.prompt, seventh.en?.choice.prompt, 'fixture really has identical text');
assert.notEqual(seventh.zh?.key, seventh.en?.key, 'language remains part of choice identity');
assert.equal(seventh.zh?.draft.name, '十五段长剧情 · 第 7 段 · 中文');
assert.equal(seventh.en?.draft.name, '十五段长剧情 · 第 7 段 · English');
assert.notEqual(seventh.zh?.promptFingerprint, seventh.en?.promptFingerprint, 'language remains part of prompt identity even when text is equal');
assert.notEqual(seventh.zh?.requestFingerprint, seventh.en?.requestFingerprint, 'identical bilingual text still represents two requested videos');

const first = initialRows[0];
assert.deepEqual(first.zh?.draft.references, [{ assetId: 'character-a', role: 'character' }]);
assert.deepEqual(first.en?.draft.references, [{ assetId: 'character-a', role: 'character' }]);
assert.notEqual(first.zh?.draft.references, first.en?.draft.references, 'each language owns a separate reference array');
assert.notEqual(first.zh?.draft.references[0], first.en?.draft.references[0], 'each language owns separate reference objects');
first.zh!.draft.references[0]!.role = 'style';
assert.equal(first.en!.draft.references[0]!.role, 'character', 'editing one row cannot leak references into its sibling language');
assert.deepEqual(initialRows[1].zh?.draft.references, [{ assetId: 'scene-b', role: 'scene' }], 'the next segment receives only its own references');

const firstZhKey = first.zh!.key;
const firstEnKey = first.en!.key;
const firstZhOverride: VideoImageReference[] = [{ assetId: 'scene-b', role: 'scene' }];
const firstEnOverride: VideoImageReference[] = [{ assetId: 'character-a', role: 'subject' }];
const overrideRows = buildVideoBatchRows(project, plan, settings, {
  referenceOverrides: {
    [firstZhKey]: firstZhOverride,
    [firstEnKey]: firstEnOverride,
  },
});
assert.deepEqual(overrideRows[0].zh?.draft.references, [{ assetId: 'scene-b', role: 'scene' }]);
assert.deepEqual(overrideRows[0].en?.draft.references, [{ assetId: 'character-a', role: 'subject' }]);
assert.notEqual(overrideRows[0].zh?.referenceFingerprint, overrideRows[0].en?.referenceFingerprint);
const missingOverrideRows = buildVideoBatchRows(project, plan, settings, {
  referenceOverrides: {
    [firstZhKey]: [{ assetId: 'deleted-after-selection', role: 'character' }] as VideoImageReference[],
  },
});
assert.deepEqual(
  missingOverrideRows[0].zh?.draft.references,
  [{ assetId: 'deleted-after-selection', role: 'character' }],
  'an explicitly selected image that later disappears remains visible to engine preflight',
);

const referenceDraft = structuredClone(overrideRows[0].zh!.draft);
const referenceFingerprint = videoBatchReferenceFingerprint(referenceDraft, assets);
referenceDraft.references.reverse();
assert.equal(videoBatchReferenceFingerprint(referenceDraft, assets), referenceFingerprint, 'a one-image order is stable');
referenceDraft.references.push({ assetId: 'character-a', role: 'character' });
const orderedFingerprint = videoBatchReferenceFingerprint(referenceDraft, assets);
referenceDraft.references.reverse();
assert.notEqual(videoBatchReferenceFingerprint(referenceDraft, assets), orderedFingerprint, 'reference order and role are fingerprinted');

const comfySettings = structuredClone(settings);
comfySettings.videoBackend = 'comfyui';
comfySettings.comfyuiVideo = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8188',
  apiKey: '',
  promptPath: '/prompt',
  workflows: [{
    id: 'workflow-a',
    name: '批量工作流',
    workflowJson: '{"1":{"class_type":"Prompt","inputs":{"text":"old"}}}',
    mapping: { prompt: [{ nodeId: '1', inputName: 'text' }], images: [] },
    createdAt: 1,
    updatedAt: 1,
  }],
  activeWorkflowId: 'workflow-a',
};
const comfyRows = buildVideoBatchRows(project, plan, comfySettings, { parameters: { seed: 7 } });
const changedParameters = buildVideoBatchRows(project, plan, comfySettings, { parameters: { seed: 8 } });
assert.notEqual(comfyRows[0].zh?.requestFingerprint, changedParameters[0].zh?.requestFingerprint, 'parameters are part of request identity');
comfySettings.comfyuiVideo.workflows[0]!.workflowJson = '{"1":{"class_type":"Prompt","inputs":{"text":"changed"}}}';
const changedWorkflow = buildVideoBatchRows(project, plan, comfySettings, { parameters: { seed: 7 } });
assert.notEqual(comfyRows[0].zh?.requestFingerprint, changedWorkflow[0].zh?.requestFingerprint, 'workflow content is part of request identity');

const snapshotFor = (candidate: VideoBatchChoiceCandidate): VideoGenerationSnapshot => {
  const { apiKey: _apiKey, ...safeApi } = settings.videoTaskApi;
  return {
    projectId: project.id,
    draft: structuredClone(candidate.draft),
    connection: { backend: 'api', api: safeApi },
    images: candidate.draft.references.map((reference) => {
      const source = assets.find((item) => item.id === reference.assetId)!;
      return {
        ...reference,
        name: source.name,
        fileName: source.fileName,
        relativePath: source.relativePath,
        checksum: source.checksum,
        freezeState: 'frozen' as const,
        frozenAt: 10,
      };
    }),
    clientId: `client-${candidate.key}`,
  };
};
const taskFor = (
  candidate: VideoBatchChoiceCandidate,
  id: string,
  status: VideoGenerationTask['status'],
): VideoGenerationTask => ({
  id,
  kind: 'video',
  storyboardId: candidate.storyboardId,
  targetId: 'batch-test-model',
  status,
  requestBody: { prompt: candidate.draft.prompt },
  sequencePlanId: candidate.sequencePlanId,
  segmentId: candidate.segmentId,
  segmentIndex: candidate.segmentIndex,
  videoJob: {
    snapshot: snapshotFor(candidate),
    stage: status === 'succeeded' ? 'succeeded' : status === 'running' ? 'running' : 'queued',
  },
  createdAt: 1,
  updatedAt: 1,
});

const thirdZh = initialRows[2].zh!;
const fourthZh = initialRows[3].zh!;
const failedFifthZh = initialRows[4].zh!;
const succeededTask = taskFor(thirdZh, 'existing-success', 'succeeded');
const runningTask = taskFor(fourthZh, 'existing-running', 'running');
const failedTask = taskFor(failedFifthZh, 'existing-failed', 'failed');
assert.equal(videoTaskRequestFingerprint(succeededTask), thirdZh.requestFingerprint, 'stored snapshots reproduce current request fingerprints');

const projectWithExisting = {
  ...project,
  generationTasks: [succeededTask, runningTask, failedTask],
};
const duplicateRows = buildVideoBatchRows(projectWithExisting, plan, settings);
assert.deepEqual(duplicateRows[2].zh?.duplicate, {
  kind: 'succeeded', taskId: succeededTask.id, status: 'succeeded',
});
assert.deepEqual(duplicateRows[3].zh?.duplicate, {
  kind: 'in-flight', taskId: runningTask.id, status: 'running',
});
assert.equal(duplicateRows[4].zh?.duplicate, undefined, 'failed tasks do not block an explicit retry');
const stillDownloading: VideoGenerationTask = {
  ...succeededTask,
  videoJob: { ...succeededTask.videoJob!, stage: 'downloading' },
};
assert.deepEqual(findVideoBatchDuplicate({ generationTasks: [stillDownloading] }, thirdZh.requestFingerprint), {
  kind: 'in-flight', taskId: stillDownloading.id, status: 'succeeded',
}, 'remote success without a saved asset must not offer a second POST while downloading');
const savedWithStaleStage: VideoGenerationTask = {
  ...stillDownloading,
  resultAssetId: 'already-saved-result',
};
assert.deepEqual(findVideoBatchDuplicate({ generationTasks: [savedWithStaleStage] }, thirdZh.requestFingerprint), {
  kind: 'succeeded', taskId: savedWithStaleStage.id, status: 'succeeded',
}, 'saved success remains eligible for explicit regeneration despite an old progress stage');
assert.equal(ungeneratedVideoBatchChoiceKeys(duplicateRows, 'zh').size, 13, 'default ungenerated selection skips current and successful exact requests');
assert.equal(ungeneratedVideoBatchChoiceKeys(duplicateRows, 'en').size, 15, 'English choices are independent from matching Chinese tasks');

const cancelledCandidate = initialRows[6].zh!;
const cancelledBeforePostTask: VideoGenerationTask = {
  ...taskFor(cancelledCandidate, 'cancelled-before-post', 'failed'),
  batchId: 'old-cancelled-batch',
  requestFingerprint: cancelledCandidate.requestFingerprint,
  videoJob: {
    ...taskFor(cancelledCandidate, 'cancelled-before-post-snapshot', 'submitting').videoJob!,
    stage: 'stopped',
    trackingStopped: true,
    batchQueueState: 'cancelled',
    preparation: { version: 1, phase: 'preparing', uploadedImages: [] },
  },
};
assert.equal(cancelledVideoBatchTaskBeforePost(cancelledBeforePostTask), true);
assert.equal(
  findVideoBatchDuplicate({ generationTasks: [cancelledBeforePostTask] }, cancelledCandidate.requestFingerprint),
  undefined,
  'a cancelled task proven not to have POSTed must not permanently block a newly confirmed batch',
);

const cancelledAfterPostTask: VideoGenerationTask = {
  ...cancelledBeforePostTask,
  id: 'cancelled-after-post',
  status: 'unknown',
  videoJob: {
    ...cancelledBeforePostTask.videoJob!,
    stage: 'submission-unknown',
    preparation: { version: 1, phase: 'post-started', uploadedImages: [] },
  },
};
assert.equal(cancelledVideoBatchTaskBeforePost(cancelledAfterPostTask), false);
assert.deepEqual(
  findVideoBatchDuplicate({ generationTasks: [cancelledAfterPostTask] }, cancelledCandidate.requestFingerprint),
  { kind: 'in-flight', taskId: cancelledAfterPostTask.id, status: 'unknown' },
  'a cancelled-looking record that crossed POST must still block duplicate billing',
);

const one = allVideoBatchChoiceKeys(duplicateRows, 'zh');
const toggledOff = toggleVideoBatchChoice(one, duplicateRows[0].zh!.key);
assert.equal(toggledOff.size, 14);
assert.equal(one.size, 15, 'selection helpers do not mutate the input Set');
assert.equal(toggleVideoBatchChoice(toggledOff, duplicateRows[0].zh!.key).size, 15);

// The controller-level batch gate reads every managed file before the engine
// can create or POST any task. Reused paths are checked once per batch.
const managedPreflightState: AppState = {
  ...structuredClone(state),
  project: structuredClone(project),
  projects: [structuredClone(project)],
  activeProjectId: project.id,
  settings: structuredClone(settings),
};
const managedPreflightInput = {
  projectId: project.id,
  items: [
    { itemKey: initialRows[0].zh!.key, draft: initialRows[0].zh!.draft },
    { itemKey: initialRows[0].en!.key, draft: initialRows[0].en!.draft },
  ],
};
const managedReads: string[] = [];
await preflightVideoBatchManagedReferences(managedPreflightState, managedPreflightInput, {
  readManagedImageDataUrl: async ({ relativePath }) => {
    managedReads.push(relativePath);
    return { dataUrl: 'data:image/png;base64,AA==' };
  },
});
assert.deepEqual(managedReads, ['image/character-a.png'], 'the same immutable managed image is read only once for the whole batch');
await assert.rejects(
  () => preflightVideoBatchManagedReferences(managedPreflightState, managedPreflightInput, {
    readManagedImageDataUrl: async () => { throw new Error('ENOENT'); },
  }),
  /批量第 1 项.*无法读取.*ENOENT/u,
  'a physically missing managed file fails the entire gate even when asset.missing is false',
);
let skippedDuplicateReads = 0;
const replacedMissingInput = {
  projectId: project.id,
  items: [{
    itemKey: initialRows[0].zh!.key,
    draft: { ...structuredClone(initialRows[0].zh!.draft), references: [{ assetId: 'missing-replaced-image', role: 'first-frame' as const }] },
    previousTail: {
      predecessorItemKey: 'previous-segment:zh',
      placement: { mode: 'replace' as const, index: 0, role: 'first-frame' as const, replacedAssetId: 'missing-replaced-image' },
    },
  }],
};
let replacedImageReads = 0;
await preflightVideoBatchManagedReferences(managedPreflightState, replacedMissingInput, {
  readManagedImageDataUrl: async () => { replacedImageReads += 1; throw new Error('unused original must not be read'); },
});
assert.equal(replacedImageReads, 0, 'a confirmed replaced tail slot never reads unused original bytes');
const replacedAllReferences = [{ assetId: 'missing-storyboard-image', role: 'subject' as const }, { assetId: 'missing-character-image', role: 'character' as const }];
const replacedAllMissingInput = {
  projectId: project.id, items: [{ ...replacedMissingInput.items[0],
    draft: { ...replacedMissingInput.items[0].draft, references: replacedAllReferences },
    previousTail: { predecessorItemKey: 'previous-segment:zh', placement: {
      mode: 'replace-all' as const, index: 0, role: 'first-frame' as const, replacedReferences: structuredClone(replacedAllReferences),
    } },
  }],
};
await preflightVideoBatchManagedReferences(managedPreflightState, replacedAllMissingInput, {
  readManagedImageDataUrl: async () => { replacedImageReads += 1; throw new Error('replaced storyboard images must not be read'); },
});
assert.equal(replacedImageReads, 0, 'a reviewed one-image replacement excludes every unused storyboard file');
const staleReplaceAll = structuredClone(replacedAllMissingInput);
staleReplaceAll.items[0].draft.references.reverse();
await assert.rejects(preflightVideoBatchManagedReferences(managedPreflightState, staleReplaceAll, {
  readManagedImageDataUrl: async () => { throw new Error('stale confirmation should fail before any read'); },
}), /参考图已变化/u);
const retainedMissingInput = structuredClone(replacedMissingInput);
retainedMissingInput.items[0].draft.references.push({ assetId: 'missing-retained-image', role: 'first-frame' });
await assert.rejects(preflightVideoBatchManagedReferences(managedPreflightState, retainedMissingInput, {
  readManagedImageDataUrl: async () => ({ dataUrl: 'data:image/png;base64,AA==' }),
}), /所选图片已不存在/u, 'replacing one slot must not exempt the remaining selected references');
const managedSuccessfulTask = taskFor(initialRows[0].zh!, 'managed-existing-success', 'succeeded');
const managedProjectWithExisting: Project = {
  ...project,
  generationTasks: [managedSuccessfulTask],
};
const duplicatePreflightState: AppState = {
  ...managedPreflightState,
  project: structuredClone(managedProjectWithExisting),
  projects: [structuredClone(managedProjectWithExisting)],
};
const successfulDuplicateInput = {
  projectId: managedProjectWithExisting.id,
  items: [{ itemKey: initialRows[0].zh!.key, draft: initialRows[0].zh!.draft }],
};
await preflightVideoBatchManagedReferences(duplicatePreflightState, successfulDuplicateInput, {
  readManagedImageDataUrl: async () => {
    skippedDuplicateReads += 1;
    throw new Error('a skipped successful duplicate must not read current mutable assets');
  },
});
assert.equal(skippedDuplicateReads, 0);
await assert.rejects(
  () => preflightVideoBatchManagedReferences(duplicatePreflightState, {
    ...successfulDuplicateInput,
    force: true,
  }, {
    readManagedImageDataUrl: async () => { throw new Error('forced image is gone'); },
  }),
  /forced image is gone/u,
  'an explicit successful-result override validates the actual bytes that will be submitted',
);

// Cross-layer contract: the real engine writes the exact fingerprint consumed
// by this pure UI model, so rebuilding rows immediately sees its durable shell.
let engineState: AppState = {
  ...structuredClone(state),
  project: structuredClone(project),
  projects: [structuredClone(project)],
  activeProjectId: project.id,
  settings: structuredClone(settings),
};
const engine = new VideoGenerationEngine({
  getState: () => engineState,
  setState: (updater) => { engineState = updater(engineState); },
  persistState: async () => {},
  onRuntime: () => {},
});
const engineCandidate = buildVideoBatchRows(
  engineState.project,
  plan,
  engineState.settings,
)[5].en!;
const started = await engine.startBatch({
  projectId: project.id,
  label: '交叉指纹测试',
  items: [{ itemKey: engineCandidate.key, draft: engineCandidate.draft }],
  concurrency: 1,
});
engine.dispose();
assert.equal(started.taskIds.length, 1);
const rebuiltAfterEngineStart = buildVideoBatchRows(
  engineState.project,
  plan,
  engineState.settings,
);
assert.equal(rebuiltAfterEngineStart[5].en?.duplicate?.kind, 'in-flight');
assert.equal(rebuiltAfterEngineStart[5].en?.duplicate?.taskId, started.taskIds[0], 'an engine-created task shell is immediately recognized by the batch chooser');
assert.ok(
  ['draft', 'submitting'].includes(rebuiltAfterEngineStart[5].en?.duplicate?.status || ''),
  'the duplicate remains protected whether the scheduler is waiting or has begun preparation',
);

console.log('videoBatch: ordered bilingual rows, isolated references, stable fingerprints, duplicate detection and selection helpers passed');

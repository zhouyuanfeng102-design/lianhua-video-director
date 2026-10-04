import assert from 'node:assert/strict';
import { createInitialState, CURRENT_SCHEMA_VERSION, normalizeState } from '../src/storage';
import { diagnoseState } from '../src/stateIntegrity';
import { masterPromptConfirmationFingerprint } from '../src/masterTimeline';

const current = createInitialState();
assert.equal(current.schemaVersion, CURRENT_SCHEMA_VERSION);
assert.deepEqual(current.project.generationTasks, []);
assert.deepEqual(current.project.sequencePlans, []);
assert.equal(current.settings.assetFilter, 'all');
assert.equal(current.settings.videoTaskApi.enabled, false);
assert.equal(diagnoseState(current).valid, true);

const legacy = JSON.parse(JSON.stringify(current));
delete legacy.schemaVersion;
delete legacy.project.generationTasks;
delete legacy.project.sequencePlans;
delete legacy.settings.videoTaskApi;
delete legacy.settings.assetFilter;
legacy.project.assets.push({ id: 'managed-video', name: 'clip.mp4', type: 'video', role: 'motion', relativePath: 'video/hash.mp4', missing: true, tags: [], createdAt: 1, updatedAt: 1 });
legacy.project.storyboards.push({
  id: 'board', sceneId: legacy.project.scenes[0].id, workflow: 'drama', inputMode: 'text', durationSec: 5,
  durationPreset: '5s', shotMode: 'exact', pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
  stylePresetId: 'style_cinema', ruleSetId: 'timeline_director_cn', converterPresetId: 'converter_drama', globalLock: '',
  shots: [{ id: 'shot', index: 1, startSec: 0, endSec: 5, purpose: '', subject: '', action: '', camera: '', transition: '', lighting: '', sound: '', result: '', referenceAssetIds: ['missing-id'], prompt: '', locked: false }],
  finalPrompt: '', createdAt: 1, updatedAt: 1
});
const migrated = normalizeState(legacy);
assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
assert.deepEqual(migrated.project.generationTasks, []);
assert.equal(migrated.project.sequencePlans.length, 0);
assert.equal(migrated.settings.videoTaskApi.authHeader, 'Authorization');
migrated.project.sequencePlans.push({
  id: 'plan-1',
  title: '测试拆分计划',
  sourceStoryTitle: '雨夜客栈',
  sourceStoryContent: '测试内容',
  durationMode: 'fixed',
  requestedTotalDurationSec: 5,
  totalDurationSec: 5,
  segmentDurationSec: 5,
  segmentationMode: 'fixed',
  fitStatus: 'balanced',
  segments: [{
    id: 'segment-1',
    index: 1,
    title: '片段一',
    globalStartSec: 0,
    globalEndSec: 5,
    durationSec: 5,
    content: '李云收到来信。',
    summary: '建立悬念',
    sourceSceneIds: [legacy.project.scenes[0].id],
    sourceBeatIds: [],
    narrativePurpose: '建立悬念',
    entryState: '走进客栈',
    exitState: '看向门外',
    transitionHint: '敲门声接续',
    storyboardId: 'missing-board',
    status: 'planned',
  }],
  createdAt: 2,
  updatedAt: 3,
});
const diagnostic = diagnoseState(migrated);
assert.equal(diagnostic.valid, true);
assert.equal(diagnostic.counts.missingAssets, 1);
assert.equal(diagnostic.counts.orphanReferences, 1);
assert.ok(diagnostic.warnings.some((warning) => warning.includes('missing-board')));

// A persisted "ready" marker is trustworthy only when its storyboard and
// actual final prompt still exist. These cases should be surfaced as warnings
// so the UI can direct the user to retry without invalidating the whole state.
const readyResultState = JSON.parse(JSON.stringify(migrated));
const readyPlan = readyResultState.project.sequencePlans[0];
readyPlan.segments.push(
  {
    ...readyPlan.segments[0],
    id: 'ready-without-board',
    storyboardId: undefined,
    status: 'ready',
  },
  {
    ...readyPlan.segments[0],
    id: 'ready-with-missing-board',
    storyboardId: 'missing-ready-board',
    status: 'ready',
  },
  {
    ...readyPlan.segments[0],
    id: 'ready-with-empty-prompt',
    storyboardId: 'board',
    status: 'ready',
  },
);
const readyDiagnostic = diagnoseState(readyResultState);
assert.ok(
  readyDiagnostic.warnings.some((warning) => /ready-without-board.*已完成.*分镜 ID/u.test(warning)),
  'ready segments without a storyboard ID must be diagnosed',
);
assert.ok(
  readyDiagnostic.warnings.some((warning) => /ready-with-missing-board.*缺失.*分镜/u.test(warning)),
  'ready segments pointing to a missing storyboard must be diagnosed',
);
assert.ok(
  readyDiagnostic.warnings.some((warning) => /ready-with-empty-prompt.*最终提示词为空/u.test(warning)),
  'ready segments whose storyboard has no final prompt must be diagnosed',
);

const masterLinkedState = JSON.parse(JSON.stringify(migrated));
masterLinkedState.project.sequencePlans[0].masterStoryboardId = 'missing-master-board';
masterLinkedState.project.sequencePlans[0].segments[0].sourceShotIds = undefined;
const masterLinkedDiagnostic = diagnoseState(masterLinkedState);
assert.ok(
  masterLinkedDiagnostic.warnings.some((warning) => warning.includes('missing-master-board')),
  'missing master storyboard links must be diagnosed',
);
assert.ok(
  masterLinkedDiagnostic.warnings.some((warning) => /sourceShotIds/u.test(warning)),
  'missing source shot links for a master storyboard must be diagnosed',
);

const draftDiagnosticState = JSON.parse(JSON.stringify(migrated));
const draftDiagnosticPlan = {
  ...JSON.parse(JSON.stringify(readyPlan)),
  id: 'diagnostic-master-draft',
  planningStage: 'master-draft',
  masterStoryboardId: 'diagnostic-master-board',
  segments: [],
};
const diagnosticMasterBoard = {
  ...JSON.parse(JSON.stringify(migrated.project.storyboards[0])),
  id: 'diagnostic-master-board',
  sequencePlanId: draftDiagnosticPlan.id,
  segmentId: undefined,
  durationSec: draftDiagnosticPlan.totalDurationSec,
  sourceStoryContent: draftDiagnosticPlan.sourceStoryContent,
  finalPrompt: '真实、非空的全片总视频提示词',
  promptTrace: {
    modelRuleSetId: 'rule',
    converterPresetId: 'converter',
    sourceDocumentIds: [],
    referenceAssetIds: [],
    generatedAt: 1,
    mode: 'text-api',
    shotRecommendationMode: 'text-api',
    shotPlanMode: 'ai-complete',
  },
  shots: [{
    ...JSON.parse(JSON.stringify(migrated.project.storyboards[0].shots[0])),
    id: 'diagnostic-master-shot',
    index: 1,
    startSec: 0,
    endSec: draftDiagnosticPlan.totalDurationSec,
    prompt: '真实、非空的镜头提示词',
  }],
};
draftDiagnosticState.project.storyboards = [diagnosticMasterBoard];
draftDiagnosticState.project.sequencePlans = [draftDiagnosticPlan];
const draftStageDiagnostic = diagnoseState(draftDiagnosticState);
const draftPlanWarnings = draftStageDiagnostic.warnings
  .filter((warning) => warning.includes(draftDiagnosticPlan.id));
assert.ok(
  draftPlanWarnings.some((warning) => /总提示词待确认/u.test(warning)),
  'a real master board in draft stage must be reported as awaiting confirmation',
);
assert.ok(!draftPlanWarnings.some((warning) => /sourceShotIds|至少需要一个视频段/u.test(warning)));

const missingDraftBoardState = JSON.parse(JSON.stringify(draftDiagnosticState));
missingDraftBoardState.project.sequencePlans[0].masterStoryboardId = 'missing-draft-master-board';
const missingDraftBoardDiagnostic = diagnoseState(missingDraftBoardState);
assert.ok(
  missingDraftBoardDiagnostic.warnings.some((warning) => warning.includes('missing-draft-master-board')),
  'a draft stage must retain the concrete missing-master warning',
);

const emptyDraftBoardState = JSON.parse(JSON.stringify(draftDiagnosticState));
emptyDraftBoardState.project.storyboards[0].finalPrompt = '   ';
const emptyDraftBoardDiagnostic = diagnoseState(emptyDraftBoardState);
assert.ok(
  emptyDraftBoardDiagnostic.warnings.some((warning) => /总视频提示词为空/u.test(warning)),
  'a draft stage must retain the concrete empty-master warning',
);

const confirmedDiagnosticState = JSON.parse(JSON.stringify(draftDiagnosticState));
confirmedDiagnosticState.project.sequencePlans[0].planningStage = 'master-confirmed';
confirmedDiagnosticState.project.sequencePlans[0].masterPromptConfirmedAt = 404;
confirmedDiagnosticState.project.sequencePlans[0].masterPromptConfirmedFingerprint = masterPromptConfirmationFingerprint(
  confirmedDiagnosticState.project.sequencePlans[0],
  confirmedDiagnosticState.project.storyboards[0],
);
const confirmedStageDiagnostic = diagnoseState(confirmedDiagnosticState);
const confirmedPlanWarnings = confirmedStageDiagnostic.warnings
  .filter((warning) => warning.includes(draftDiagnosticPlan.id));
assert.ok(
  !confirmedPlanWarnings.some((warning) => /sourceShotIds|至少需要一个视频段|缺失|不存在|为空/u.test(warning)),
  'a confirmed plan with a real master board and no segments is waiting for segmentation, not damaged',
);

const invalidConfirmedMetadataState = JSON.parse(JSON.stringify(confirmedDiagnosticState));
delete invalidConfirmedMetadataState.project.sequencePlans[0].masterPromptConfirmedFingerprint;
delete invalidConfirmedMetadataState.project.sequencePlans[0].masterPromptConfirmedAt;
const invalidConfirmedMetadataDiagnostic = diagnoseState(invalidConfirmedMetadataState);
assert.ok(
  invalidConfirmedMetadataDiagnostic.warnings.some((warning) => (
    warning.includes(draftDiagnosticPlan.id)
    && /确认状态失效|重新确认/u.test(warning)
  )),
  'missing confirmation metadata must be diagnosed even before storage normalization',
);

const invalidConfirmedOwnerState = JSON.parse(JSON.stringify(confirmedDiagnosticState));
delete invalidConfirmedOwnerState.project.storyboards[0].sequencePlanId;
const invalidConfirmedOwnerDiagnostic = diagnoseState(invalidConfirmedOwnerState);
assert.ok(
  invalidConfirmedOwnerDiagnostic.warnings.some((warning) => (
    warning.includes(draftDiagnosticPlan.id)
    && /确认状态失效|重新确认/u.test(warning)
  )),
  'an ownerless confirmed master board must be diagnosed as an invalid confirmation',
);

const staleConfirmedFingerprintState = JSON.parse(JSON.stringify(confirmedDiagnosticState));
staleConfirmedFingerprintState.project.storyboards[0].finalPrompt += '（确认后编辑）';
const staleConfirmedFingerprintDiagnostic = diagnoseState(staleConfirmedFingerprintState);
assert.ok(
  staleConfirmedFingerprintDiagnostic.warnings.some((warning) => (
    warning.includes(draftDiagnosticPlan.id)
    && /确认状态失效|重新确认/u.test(warning)
  )),
  'a live master prompt change must invalidate the persisted confirmation diagnostic',
);

const contradictoryDraftState = JSON.parse(JSON.stringify(draftDiagnosticState));
contradictoryDraftState.project.sequencePlans[0].segments = JSON.parse(JSON.stringify(readyPlan.segments));
const contradictoryDraftDiagnostic = diagnoseState(contradictoryDraftState);
assert.ok(
  contradictoryDraftDiagnostic.warnings.some((warning) => (
    warning.includes(draftDiagnosticPlan.id)
    && /阶段.*分段.*矛盾|分段.*阶段.*矛盾/u.test(warning)
  )),
  'a draft stage with persisted segments must be diagnosed without deleting those segments',
);

const contradictoryConfirmedState = JSON.parse(JSON.stringify(confirmedDiagnosticState));
contradictoryConfirmedState.project.sequencePlans[0].segments = JSON.parse(JSON.stringify(readyPlan.segments));
const contradictoryConfirmedDiagnostic = diagnoseState(contradictoryConfirmedState);
assert.ok(
  contradictoryConfirmedDiagnostic.warnings.some((warning) => (
    warning.includes(draftDiagnosticPlan.id)
    && /阶段.*分段.*矛盾|分段.*阶段.*矛盾/u.test(warning)
  )),
  'a confirmed stage with persisted segments must be diagnosed without deleting those segments',
);
console.log(`schema v${CURRENT_SCHEMA_VERSION} migration and integrity diagnostics passed`);

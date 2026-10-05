import assert from 'node:assert/strict';
import { preserveConfirmedCharacterFields } from '../src/characterDossierPolicy';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import {
  createRestorePointWithNotice,
  pendingPromptMigrationIds,
} from '../src/appEffects';
import * as appEffects from '../src/appEffects';
import { conversionReviewFixture } from './converterAiReview.test';
import {
  applyOfficialH3Prompt,
  type OfficialH3ProjectContext,
} from '../src/officialPrompt';
import { sourceContentHash } from '../src/sourceIntegrity';
import { canonicalCharacterVariantName } from '../src/characterVariants';
import { DEFAULT_FIRST_PERSON_SUBJECT } from '../src/semanticEvents';
import { createInitialState } from '../src/storage';
import type {
  AppSettings,
  CharacterNsfwProfile,
  ConverterPreset,
  Project,
  ReferenceAsset,
  RuleSet,
  SourceDocument,
  Storyboard,
  VideoSegment,
  VideoSequencePlan,
  VideoShot,
} from '../src/types';

const regressionEffects = appEffects;

const localReferenceAssetFactory = regressionEffects as typeof regressionEffects & {
  buildLocalReferenceAsset?: (input: {
    id: string;
    fileName: string;
    dataUrl: string;
    mimeType?: string;
    role?: 'composition' | 'grid';
    now?: number;
  }) => {
    id: string;
    name: string;
    type: string;
    role: string;
    referenceRole?: string;
    source?: string;
    dataUrl?: string;
    fileName?: string;
    mimeType?: string;
    tags: string[];
    createdAt: number;
    updatedAt: number;
  };
};

assert.equal(
  typeof localReferenceAssetFactory.buildLocalReferenceAsset,
  'function',
  'director view must expose a local-reference asset factory for direct uploads',
);
const localReferenceAsset = localReferenceAssetFactory.buildLocalReferenceAsset?.({
  id: 'asset-local-1',
  fileName: 'hero.png',
  dataUrl: 'data:image/png;base64,AAAA',
  mimeType: 'image/png',
  now: 1234,
});
assert.deepEqual(
  localReferenceAsset && {
    id: localReferenceAsset.id,
    name: localReferenceAsset.name,
    type: localReferenceAsset.type,
    role: localReferenceAsset.role,
    referenceRole: localReferenceAsset.referenceRole,
    source: localReferenceAsset.source,
    dataUrl: localReferenceAsset.dataUrl,
    fileName: localReferenceAsset.fileName,
    mimeType: localReferenceAsset.mimeType,
    tags: localReferenceAsset.tags,
    createdAt: localReferenceAsset.createdAt,
    updatedAt: localReferenceAsset.updatedAt,
  },
  {
    id: 'asset-local-1',
    name: 'hero.png',
    type: 'reference',
    role: 'composition',
    referenceRole: 'general',
    source: 'upload',
    dataUrl: 'data:image/png;base64,AAAA',
    fileName: 'hero.png',
    mimeType: 'image/png',
    tags: ['参考图', '本地图片'],
    createdAt: 1234,
    updatedAt: 1234,
  },
  'direct local uploads must become reusable project reference assets',
);
const localGridAsset = localReferenceAssetFactory.buildLocalReferenceAsset?.({
  id: 'asset-grid-local',
  fileName: 'grid.png',
  dataUrl: 'data:image/png;base64,AAAA',
  mimeType: 'image/png',
  role: 'grid',
  now: 1235,
});
assert.deepEqual(
  localGridAsset && {
    type: localGridAsset.type,
    role: localGridAsset.role,
    referenceRole: localGridAsset.referenceRole,
    tags: localGridAsset.tags,
  },
  {
    type: 'grid',
    role: 'grid',
    referenceRole: 'composition',
    tags: ['九宫格', '本地图片'],
  },
  'a direct upload made in grid mode must be a real grid master asset',
);

const gridSelectionAssets: ReferenceAsset[] = [
  localReferenceAsset as ReferenceAsset,
  localGridAsset as ReferenceAsset,
  {
    ...(localGridAsset as ReferenceAsset),
    id: 'asset-grid-new',
    name: 'new-grid.png',
  },
  {
    ...(localGridAsset as ReferenceAsset),
    id: 'asset-grid-missing',
    name: 'missing-grid.png',
    dataUrl: undefined,
    missing: true,
  },
];
assert.deepEqual(
  regressionEffects.resolveGridDirectorAssetIds(
    ['asset-local-1', 'asset-grid-missing', 'asset-grid-local', 'asset-grid-new'],
    gridSelectionAssets,
  ),
  ['asset-grid-local'],
  'grid mode must discard non-grid and missing choices and keep exactly one usable master',
);
assert.deepEqual(
  regressionEffects.resolveGridDirectorAssetIds(
    ['asset-grid-local'],
    gridSelectionAssets,
    { preferredAssetId: 'asset-grid-new' },
  ),
  ['asset-grid-new'],
  'an exact generated, uploaded or library-picked grid must replace the old master',
);
assert.deepEqual(
  regressionEffects.resolveGridDirectorAssetIds(
    ['asset-grid-local'],
    gridSelectionAssets,
    { preferredAssetId: 'asset-local-1', fallbackToFirstAvailable: true },
  ),
  [],
  'an explicit invalid or non-grid choice must not silently bind another asset',
);
assert.deepEqual(
  regressionEffects.resolveGridDirectorAssetIds([], gridSelectionAssets, {
    fallbackToFirstAvailable: true,
  }),
  ['asset-grid-local'],
  'entering grid mode may recover the first usable grid only when no exact choice was requested',
);

const mergeReferenceAssetIds = regressionEffects as typeof regressionEffects & {
  mergeReferenceAssetIds?: (...groups: readonly (readonly string[])[]) => string[];
};
assert.equal(
  typeof mergeReferenceAssetIds.mergeReferenceAssetIds,
  'function',
  'reference selection must expose a stable asset-id merge helper',
);
assert.deepEqual(
  mergeReferenceAssetIds.mergeReferenceAssetIds?.(
    ['shot-ref', 'global-ref'],
    ['global-ref', 'local-ref'],
  ),
  ['shot-ref', 'global-ref', 'local-ref'],
  'global local selections must merge with existing storyboard references without duplicates',
);

assert.equal(
  regressionEffects.canUseStoryAnalysisApi({ enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' }),
  true,
  'a complete text API configuration must enable automatic AI story enrichment even without an API key',
);
for (const config of [
  { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' },
  { enabled: true, baseUrl: '   ', model: 'local-model' },
  { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: '   ' },
]) {
  assert.equal(
    regressionEffects.canUseStoryAnalysisApi(config),
    false,
    'automatic AI story enrichment requires enabled, baseUrl and model together',
  );
}

const stateCoreEffects = regressionEffects as typeof regressionEffects & {
  takeHistoryStep?: <T>(
    current: T,
    source: readonly T[],
    destination: readonly T[],
    limit?: number,
  ) => {
    current: T;
    source: T[];
    destination: T[];
    changed: boolean;
  };
  commitStateTransition?: <T>(
    current: T,
    next: T,
    undo: readonly T[],
    redo: readonly T[],
    recordHistory: boolean,
    limit?: number,
    replayBackgroundUpdate?: (snapshot: T) => T,
  ) => {
    current: T;
    undo: T[];
    redo: T[];
    changed: boolean;
  };
  mergeImportedProjectState?: <TState extends {
    project: { id: string };
    projects: Array<{ id: string }>;
    activeProjectId: string;
    settings: unknown;
  }>(latest: TState, imported: TState) => TState;
  applyOwnedProjectUpdate?: <
    TProject extends { id: string; updatedAt: number },
    TState extends {
      project: TProject;
      projects: TProject[];
      activeProjectId: string;
    },
  >(
    current: TState,
    requestedProjectId: string,
    updater: (project: TProject) => TProject,
    updatedAt?: number,
  ) => TState;
  selectNextPendingVideoTask?: <TTask extends {
    id: string;
    status: string;
    remoteTaskId?: string;
  }>(tasks: readonly TTask[], afterTaskId?: string) => TTask | undefined;
  normalizeImportedRulePreset?: (
    item: Record<string, unknown>,
    index: number,
    updatedAt: number,
    id: string,
  ) => RuleSet;
  normalizeImportedConverterPreset?: (
    item: Record<string, unknown>,
    index: number,
    updatedAt: number,
    id: string,
  ) => ConverterPreset;
  normalizeImportedStoryExpansionPreset?: (
    item: Record<string, unknown>,
    index: number,
    updatedAt: number,
    id: string,
  ) => {
    id: string;
    name: string;
    systemPrompt: string;
    outputRules: string;
    enabled: boolean;
    version: string;
    updatedAt: number;
  };
  mergeImportedApiSettings?: (
    settings: AppSettings,
    incoming: {
      textApi?: unknown;
      visionApi?: unknown;
      imageApi?: unknown;
    },
    updatedAt?: number,
  ) => AppSettings;
  canImportPresetPayload?: (
    fromMoRan: boolean,
    payload: {
      ruleSets: readonly unknown[];
      converterPresets: readonly unknown[];
      storyExpansionPresets: readonly unknown[];
      stylePresets: readonly unknown[];
      textApi?: unknown;
      visionApi?: unknown;
      imageApi?: unknown;
    },
  ) => boolean;
};

const sourceWorkflowEffects = regressionEffects as typeof regressionEffects & {
  buildStoryAnalysisRequestIdentity?: (
    project: { id: string; updatedAt?: number },
    storyInput: string,
  ) => string;
  buildStoryAnalysisCompletionNotice?: (input: {
    requestedAi: boolean;
    sceneCount: number;
    characterCount: number;
    locationCount: number;
    incompleteKinds: string[];
    analysisError: unknown;
    enrichmentError: unknown;
  }) => { text: string; tone?: 'error' };
  runIndependentStoryAnalysisEnrichment?: <TAnalysis, TEnrichment>(
    requestAnalysis: () => Promise<TAnalysis>,
    requestEnrichment: (analysis: TAnalysis | null) => Promise<TEnrichment>,
  ) => Promise<{
    analysis: TAnalysis | null;
    enrichment: TEnrichment | null;
    analysisError: unknown;
    enrichmentError: unknown;
  }>;
  confirmSourceIntegrityAction?: (
    issue: {
      type: string;
      original: { start: number; end: number };
      duplicate: { start: number; end: number };
      description: string;
    },
    actionLabel: string,
    confirm: (message: string) => boolean,
  ) => 'keep-first' | 'continue' | 'cancel';
  replaceProjectSourceDocument?: (
    project: Project,
    sourceDocument: SourceDocument,
  ) => {
    project: Project;
    sourceChanged: boolean;
    invalidatedStoryboardIds: string[];
    invalidatedPlanIds: string[];
  };
  mergeAuthoritativeStorySceneBlocks?: (
    localBlocks: Array<{ title: string; content: string; summary: string }>,
    apiScenes: Array<Record<string, any>> | null,
  ) => Array<{
    title: string;
    content: string;
    summary: string;
    apiCharacters: string[];
    apiLocation: string;
    apiProps: string[];
  }>;
  mergeAuthoritativeSequenceSegmentMetadata?: (
    localPlan: VideoSequencePlan,
    aiPlan: Pick<VideoSequencePlan, 'segments'>,
  ) => VideoSequencePlan;
  resolveSequenceSegmentDuration?: (
    preset: '5s' | '10s' | '15s' | 'custom',
    custom: number,
  ) => number;
  resolveSequenceTotalDuration?: (
    durationMode: 'ai-estimated' | 'fixed',
    candidateTotalDurationSec: number,
    segmentDurationSec: number,
  ) => number;
  resolveSequenceSegmentCount?: (
    totalDurationSec: number,
    segmentDurationSec: number,
  ) => number;
};

assert.equal(
  typeof sourceWorkflowEffects.runIndependentStoryAnalysisEnrichment,
  'function',
  'story-bible enrichment needs an independently testable request stage',
);
const analysisFailure = new Error('剧情分析返回的 scenes 无效');
const partialEnrichment = {
  characters: [{ name: '西娅', appearance: '高挑的类人菌丝生命，银白菌丝长发' }],
  locations: [{ name: '清泉市', description: '被菌毯覆盖的废土城市与断裂高架' }],
  props: [],
  incompleteKinds: ['道具'],
};
const independentEnrichmentResult = await sourceWorkflowEffects.runIndependentStoryAnalysisEnrichment!(
  async () => { throw analysisFailure; },
  async (analysis) => {
    assert.equal(analysis, null, 'enrichment must receive a null analysis after the analysis stage fails');
    return partialEnrichment;
  },
);
assert.equal(independentEnrichmentResult.analysis, null);
assert.equal(independentEnrichmentResult.analysisError, analysisFailure);
assert.deepEqual(
  independentEnrichmentResult.enrichment,
  partialEnrichment,
  'usable character and location details must survive an independent enrichment attempt',
);
assert.equal(independentEnrichmentResult.enrichmentError, null);
const storyAbort = new Error('request superseded');
storyAbort.name = 'AbortError';
let enrichmentStartedAfterAbort = false;
await assert.rejects(
  () => sourceWorkflowEffects.runIndependentStoryAnalysisEnrichment!(
    async () => { throw storyAbort; },
    async () => {
      enrichmentStartedAfterAbort = true;
      return partialEnrichment;
    },
  ),
  (error: unknown) => error === storyAbort,
  'a real project switch or story edit must propagate cancellation',
);
assert.equal(
  enrichmentStartedAfterAbort,
  false,
  'an aborted scene-analysis request must not start another network request',
);

assert.equal(
  typeof sourceWorkflowEffects.buildStoryAnalysisCompletionNotice,
  'function',
  'story-bible enrichment needs one observable completion notice boundary',
);
const enrichmentFailureNotice = sourceWorkflowEffects.buildStoryAnalysisCompletionNotice!({
  requestedAi: true,
  sceneCount: 12,
  characterCount: 2,
  locationCount: 7,
  incompleteKinds: ['人物', '地点'],
  analysisError: null,
  enrichmentError: new Error('上游返回 429：请求额度已用尽'),
});
assert.equal(enrichmentFailureNotice.tone, 'error');
assert.match(
  enrichmentFailureNotice.text,
  /上游返回 429：请求额度已用尽/u,
  'the user-visible notice must retain the real enrichment failure reason',
);
assert.doesNotMatch(
  enrichmentFailureNotice.text,
  /AI 增强完成|详细资料已完整补全/u,
  'a failed enrichment request must never be reported as successful',
);

assert.equal(
  typeof sourceWorkflowEffects.buildStoryAnalysisRequestIdentity,
  'function',
  'story analysis needs a stable request identity boundary',
);
const stableStoryIdentityBeforeTask = sourceWorkflowEffects.buildStoryAnalysisRequestIdentity!(
  { id: 'project-a', updatedAt: 100 },
  '西娅站在清泉市的菌毯上。',
);
const stableStoryIdentityAfterImageTask = sourceWorkflowEffects.buildStoryAnalysisRequestIdentity!(
  { id: 'project-a', updatedAt: 999 },
  '西娅站在清泉市的菌毯上。',
);
assert.equal(
  stableStoryIdentityAfterImageTask,
  stableStoryIdentityBeforeTask,
  'image-task project.updatedAt changes must not cancel an unchanged story-bible request',
);
assert.notEqual(
  sourceWorkflowEffects.buildStoryAnalysisRequestIdentity!(
    { id: 'project-b', updatedAt: 999 },
    '西娅站在清泉市的菌毯上。',
  ),
  stableStoryIdentityBeforeTask,
  'switching projects must invalidate the in-flight request',
);
assert.notEqual(
  sourceWorkflowEffects.buildStoryAnalysisRequestIdentity!(
    { id: 'project-a', updatedAt: 999 },
    '西娅离开清泉市。',
  ),
  stableStoryIdentityBeforeTask,
  'editing the story input must invalidate the in-flight request',
);

const duplicateSourceIssue = {
  type: 'whole-document-duplicate',
  original: { start: 0, end: 1257 },
  duplicate: { start: 1257, end: 2514 },
  description: '检测到整篇来源文本连续重复两遍。',
};

assert.equal(
  typeof sourceWorkflowEffects.mergeAuthoritativeStorySceneBlocks,
  'function',
  'story analysis must expose one boundary that keeps local source blocks authoritative',
);
const mergedStoryBlocks = sourceWorkflowEffects.mergeAuthoritativeStorySceneBlocks!(
  [
    { title: '本地一', content: '原文第一段。', summary: '本地摘要一' },
    { title: '本地二', content: '原文第二段。', summary: '本地摘要二' },
  ],
  [
    {
      title: 'AI 标题一',
      content: '模型擅自改写的第一段。',
      summary: 'AI 摘要一',
      characters: ['甲', { name: '乙' }],
      location: { name: '大厅' },
      props: [{ name: '钥匙' }],
    },
    {
      title: 'AI 标题二',
      content: '模型擅自改写的第二段。',
      summary: 'AI 摘要二',
      characters: ['丙'],
      location: '走廊',
      props: ['手电'],
    },
    { title: 'AI 多出来的场景', content: '不得进入项目。' },
  ],
);
assert.deepEqual(
  mergedStoryBlocks.map((block) => block.content),
  ['原文第一段。', '原文第二段。'],
  'AI scene excerpts must never replace, reorder, duplicate, or append source prose',
);
assert.deepEqual(
  mergedStoryBlocks.map((block) => block.title),
  ['AI 标题一', 'AI 标题二'],
  'AI scene metadata may enrich the corresponding local source block',
);
assert.deepEqual(mergedStoryBlocks[0].apiCharacters, ['甲', '乙']);
assert.equal(mergedStoryBlocks[0].apiLocation, '大厅');
assert.deepEqual(mergedStoryBlocks[0].apiProps, ['钥匙']);

assert.equal(
  typeof sourceWorkflowEffects.mergeAuthoritativeSequenceSegmentMetadata,
  'function',
  'AI segment metadata must pass through one boundary that keeps the local cut authoritative',
);
const localAuthoritativePlan: VideoSequencePlan = {
  id: 'sequence_local_authority',
  title: '本地权威分段',
  sourceStoryTitle: '本地权威分段',
  sourceStoryContent: '甲出门。乙跟随。丙关门。丁上锁。',
  durationMode: 'fixed',
  requestedTotalDurationSec: 16,
  totalDurationSec: 16,
  segmentDurationSec: 8,
  segmentationMode: 'fixed',
  fitStatus: 'balanced',
  segments: [
    {
      id: 'local_segment_1',
      index: 1,
      title: '本地一',
      globalStartSec: 0,
      globalEndSec: 8,
      durationSec: 8,
      content: '甲出门。乙跟随。',
      summary: '本地摘要一',
      sourceSceneIds: ['scene_1'],
      sourceBeatIds: ['beat_1', 'beat_2'],
      sourceShotIds: ['shot_1', 'shot_2'],
      narrativePurpose: '本地目标一',
      entryState: '本地入口一',
      exitState: '本地出口一',
      transitionHint: '本地衔接一',
      status: 'planned',
      locked: false,
    },
    {
      id: 'local_segment_2',
      index: 2,
      title: '本地二',
      globalStartSec: 8,
      globalEndSec: 16,
      durationSec: 8,
      content: '丙关门。丁上锁。',
      summary: '本地摘要二',
      sourceSceneIds: ['scene_2'],
      sourceBeatIds: ['beat_3', 'beat_4'],
      sourceShotIds: ['shot_3', 'shot_4'],
      narrativePurpose: '本地目标二',
      entryState: '本地出口一',
      exitState: '本地出口二',
      transitionHint: '本地衔接二',
      status: 'planned',
      locked: false,
    },
  ],
  createdAt: 100,
  updatedAt: 200,
};
const aiUnevenPlan: Pick<VideoSequencePlan, 'segments'> = {
  segments: [
    {
      ...localAuthoritativePlan.segments[0],
      id: 'ai_segment_1',
      title: 'AI 标题一',
      globalEndSec: 15,
      durationSec: 15,
      content: '模型改写正文一',
      summary: 'AI 摘要一',
      sourceSceneIds: ['ai_scene'],
      sourceBeatIds: ['beat_1'],
      sourceShotIds: ['ai_shot'],
      narrativePurpose: 'AI 目标一',
      entryState: 'AI 入口一',
      exitState: 'AI 出口一',
      transitionHint: 'AI 衔接一',
      status: 'failed',
      locked: true,
    },
    {
      ...localAuthoritativePlan.segments[1],
      id: 'ai_segment_2',
      title: 'AI 标题二',
      globalStartSec: 15,
      durationSec: 1,
      content: '模型改写正文二',
      summary: 'AI 摘要二',
      sourceSceneIds: ['ai_scene'],
      sourceBeatIds: ['beat_2', 'beat_3', 'beat_4'],
      sourceShotIds: ['ai_shot'],
      narrativePurpose: 'AI 目标二',
      entryState: 'AI 出口一',
      exitState: 'AI 出口二',
      transitionHint: 'AI 衔接二',
      status: 'failed',
      locked: true,
    },
  ],
};
const metadataEnrichedPlan = sourceWorkflowEffects.mergeAuthoritativeSequenceSegmentMetadata!(
  localAuthoritativePlan,
  aiUnevenPlan,
);
assert.deepEqual(
  metadataEnrichedPlan.segments.map((segment) => ({
    id: segment.id,
    index: segment.index,
    globalStartSec: segment.globalStartSec,
    globalEndSec: segment.globalEndSec,
    durationSec: segment.durationSec,
    content: segment.content,
    sourceSceneIds: segment.sourceSceneIds,
    sourceBeatIds: segment.sourceBeatIds,
    sourceShotIds: segment.sourceShotIds,
    status: segment.status,
    locked: segment.locked,
  })),
  [
    {
      id: 'local_segment_1',
      index: 1,
      globalStartSec: 0,
      globalEndSec: 8,
      durationSec: 8,
      content: '甲出门。乙跟随。',
      sourceSceneIds: ['scene_1'],
      sourceBeatIds: ['beat_1', 'beat_2'],
      sourceShotIds: ['shot_1', 'shot_2'],
      status: 'planned',
      locked: false,
    },
    {
      id: 'local_segment_2',
      index: 2,
      globalStartSec: 8,
      globalEndSec: 16,
      durationSec: 8,
      content: '丙关门。丁上锁。',
      sourceSceneIds: ['scene_2'],
      sourceBeatIds: ['beat_3', 'beat_4'],
      sourceShotIds: ['shot_3', 'shot_4'],
      status: 'planned',
      locked: false,
    },
  ],
  'AI changes to text, beat/shot ownership, timing, order, identity, and workflow state must be discarded',
);
assert.deepEqual(
  metadataEnrichedPlan.segments.map((segment) => ({
    title: segment.title,
    summary: segment.summary,
    narrativePurpose: segment.narrativePurpose,
    entryState: segment.entryState,
    exitState: segment.exitState,
    transitionHint: segment.transitionHint,
  })),
  [
    {
      title: 'AI 标题一',
      summary: 'AI 摘要一',
      narrativePurpose: 'AI 目标一',
      entryState: 'AI 入口一',
      exitState: 'AI 出口一',
      transitionHint: 'AI 衔接一',
    },
    {
      title: 'AI 标题二',
      summary: 'AI 摘要二',
      narrativePurpose: 'AI 目标二',
      entryState: 'AI 出口一',
      exitState: 'AI 出口二',
      transitionHint: 'AI 衔接二',
    },
  ],
  'only the six descriptive metadata fields may enrich the corresponding local segment',
);

assert.equal(
  typeof sourceWorkflowEffects.resolveSequenceSegmentDuration,
  'function',
  'long-story planning must use a duration parser separate from single-storyboard duration',
);
assert.equal(sourceWorkflowEffects.resolveSequenceSegmentDuration!('custom', 300), 300);
assert.equal(sourceWorkflowEffects.resolveSequenceSegmentDuration!('custom', 30), 30);
assert.equal(sourceWorkflowEffects.resolveSequenceSegmentDuration!('custom', 301), 300);
assert.equal(sourceWorkflowEffects.resolveSequenceSegmentDuration!('10s', 300), 10);
assert.equal(
  sourceWorkflowEffects.resolveSequenceSegmentDuration!('custom', 7.555),
  7.56,
  'custom segment durations must normalize to centiseconds before grid arithmetic',
);

assert.equal(
  typeof sourceWorkflowEffects.resolveSequenceTotalDuration,
  'function',
  'long-story planning must expose one total-duration resolver for every duration-mode entry point',
);
const resolveSequenceTotalDuration = sourceWorkflowEffects.resolveSequenceTotalDuration!;
for (const { candidateTotalDurationSec, segmentDurationSec, expected } of [
  { candidateTotalDurationSec: 28, segmentDurationSec: 15, expected: 30 },
  { candidateTotalDurationSec: 30, segmentDurationSec: 15, expected: 30 },
  { candidateTotalDurationSec: 28, segmentDurationSec: 7.5, expected: 30 },
  { candidateTotalDurationSec: 30.004, segmentDurationSec: 15, expected: 30 },
  { candidateTotalDurationSec: 30.005, segmentDurationSec: 15, expected: 45 },
  { candidateTotalDurationSec: 3599.99, segmentDurationSec: 15, expected: 3600 },
]) {
  assert.equal(
    resolveSequenceTotalDuration('ai-estimated', candidateTotalDurationSec, segmentDurationSec),
    expected,
    `AI total duration ${candidateTotalDurationSec}s must align to the ${segmentDurationSec}s fixed segment grid`,
  );
}
assert.throws(
  () => resolveSequenceTotalDuration('ai-estimated', 3600.01, 15),
  /3600/u,
  'AI estimates that round up past the 3600-second total-duration cap must fail instead of truncating the story',
);
assert.throws(
  () => resolveSequenceTotalDuration('fixed', 28, 15),
  /30/u,
  'a fixed total duration that misses the segment grid must tell the user the nearest upward legal duration',
);
assert.throws(
  () => resolveSequenceTotalDuration('fixed', 3600, 7),
  /3600 秒上限内无法兼容/u,
  'a fixed duration whose next grid value exceeds the total-duration cap must not suggest an unavailable duration',
);
assert.throws(
  () => resolveSequenceTotalDuration('ai-estimated', 0.001, 15),
  /大于 0/u,
  'durations that normalize to zero centiseconds must be rejected instead of producing a zero-second plan',
);
assert.equal(
  typeof sourceWorkflowEffects.resolveSequenceSegmentCount,
  'function',
  'long-story planning must expose centisecond-based segment counting instead of dividing binary seconds',
);
assert.equal(
  sourceWorkflowEffects.resolveSequenceSegmentCount?.(52.92, 7.56),
  7,
  '52.92 seconds must produce exactly seven 7.56-second segments',
);

assert.equal(
  typeof sourceWorkflowEffects.confirmSourceIntegrityAction,
  'function',
  'source-integrity warnings must use one deterministic explicit-choice helper',
);
const confirmSourceIntegrityAction = sourceWorkflowEffects.confirmSourceIntegrityAction!;
const keepFirstPrompts: string[] = [];
assert.equal(
  confirmSourceIntegrityAction(duplicateSourceIssue, '解析剧情', (message) => {
    keepFirstPrompts.push(message);
    return true;
  }),
  'keep-first',
  'the first affirmative choice must explicitly retain the first source copy',
);
assert.equal(keepFirstPrompts.length, 1);
assert.match(keepFirstPrompts[0], /保留第一份/u);

const continueAnswers = [false, true];
const continuePrompts: string[] = [];
assert.equal(
  confirmSourceIntegrityAction(duplicateSourceIssue, '生成全片总提示词', (message) => {
    continuePrompts.push(message);
    return continueAnswers.shift() || false;
  }),
  'continue',
  'continuing with duplicate source must require a separate affirmative confirmation',
);
assert.equal(continuePrompts.length, 2);
assert.match(continuePrompts[1], /仍按当前原文继续/u);

const cancelAnswers = [false, false];
assert.equal(
  confirmSourceIntegrityAction(duplicateSourceIssue, '保存原文', () => cancelAnswers.shift() || false),
  'cancel',
  'rejecting both explicit actions must cancel the source operation',
);

assert.equal(
  typeof sourceWorkflowEffects.replaceProjectSourceDocument,
  'function',
  'source replacement must invalidate source-derived project artifacts through a pure helper',
);
const replaceProjectSourceDocument = sourceWorkflowEffects.replaceProjectSourceDocument!;
const sourceFixtureState = createInitialState();
const sourceFixtureProject: Project = {
  ...sourceFixtureState.project,
  sourceDocuments: [{
    id: 'source-old',
    name: '旧剧情',
    content: '旧稿',
    createdAt: 1,
    updatedAt: 1,
  }],
  scenes: sourceFixtureState.project.scenes.length
    ? sourceFixtureState.project.scenes
    : [{
        id: 'scene-old',
        title: '旧场景',
        content: '旧稿',
        summary: '旧稿',
        characterIds: [],
        locationIds: [],
        propIds: [],
        storyboardIds: ['board-old'],
        createdAt: 1,
        updatedAt: 1,
      }],
  storyboards: sourceFixtureState.project.storyboards.length
    ? sourceFixtureState.project.storyboards
    : [{ id: 'board-old' } as unknown as Project['storyboards'][number]],
  sequencePlans: [{ id: 'plan-old' } as unknown as VideoSequencePlan],
};
const changedSourceResult = replaceProjectSourceDocument(sourceFixtureProject, {
  id: 'source-old',
  name: '新剧情',
  content: '新稿',
  createdAt: 1,
  updatedAt: 2,
});
assert.equal(changedSourceResult.sourceChanged, true);
assert.equal(changedSourceResult.project.scenes.length, sourceFixtureProject.scenes.length);
assert.equal(changedSourceResult.project.storyboards.length, sourceFixtureProject.storyboards.length);
assert.equal(changedSourceResult.project.sequencePlans.length, sourceFixtureProject.sequencePlans.length);
assert.ok(changedSourceResult.project.scenes.every((scene) => scene.sourceStale));
assert.ok(changedSourceResult.project.storyboards.every((board) => board.sourceStale));
assert.ok(changedSourceResult.project.sequencePlans.every((plan) => plan.sourceStale));
assert.deepEqual(
  changedSourceResult.invalidatedStoryboardIds,
  sourceFixtureProject.storyboards.map((board) => board.id),
);
assert.deepEqual(changedSourceResult.invalidatedPlanIds, ['plan-old']);
assert.equal(changedSourceResult.project.sourceDocuments[0].content, '新稿');
assert.match(changedSourceResult.project.sourceDocuments[0].contentHash || '', /^src-v1-[0-9a-f]{16}$/u);

const renamedSourceResult = replaceProjectSourceDocument(sourceFixtureProject, {
  ...sourceFixtureProject.sourceDocuments[0],
  name: '只改标题',
  updatedAt: 3,
});
assert.equal(renamedSourceResult.sourceChanged, false);
assert.equal(renamedSourceResult.project.scenes.length, sourceFixtureProject.scenes.length);
assert.equal(renamedSourceResult.project.storyboards.length, sourceFixtureProject.storyboards.length);
assert.equal(renamedSourceResult.project.sequencePlans.length, sourceFixtureProject.sequencePlans.length);
assert.equal(renamedSourceResult.project.sourceDocuments[0].name, '只改标题');

const stalePersistedHashProject: Project = {
  ...sourceFixtureProject,
  sourceDocuments: [{
    ...sourceFixtureProject.sourceDocuments[0],
    content: '旧稿',
    contentHash: sourceContentHash('新稿'),
  }],
};
const stalePersistedHashResult = replaceProjectSourceDocument(stalePersistedHashProject, {
  ...stalePersistedHashProject.sourceDocuments[0],
  content: '新稿',
  updatedAt: 4,
});
assert.equal(
  stalePersistedHashResult.sourceChanged,
  true,
  'source replacement must recompute the old body hash instead of trusting stale persisted metadata',
);
assert.ok(stalePersistedHashResult.project.scenes.every((scene) => scene.sourceStale));
assert.ok(stalePersistedHashResult.project.storyboards.every((board) => board.sourceStale));
assert.ok(stalePersistedHashResult.project.sequencePlans.every((plan) => plan.sourceStale));

const makeVideoShot = (overrides: Partial<VideoShot> = {}): VideoShot => ({
  id: 'shot-fixture',
  index: 1,
  startSec: 0,
  endSec: 1,
  purpose: '',
  subject: '',
  action: '',
  camera: '',
  transition: '',
  lighting: '',
  sound: '',
  result: '',
  referenceAssetIds: [],
  prompt: '',
  locked: false,
  ...overrides,
});

// Converter contracts live in the focused integration suite; this fixture is
// also reused by the derived-board provenance checks below.
const conversionDraftPrompt = conversionReviewFixture.finalPrompt.replace(/台词：[^\n]*?；音效：/u, '台词：无；音效：');
const conversionDraft: Storyboard = {
  ...conversionReviewFixture,
  // These older official-artifact provenance checks use an English fixture
  // without spoken words; keep its Chinese draft dialogue-free too.
  finalPrompt: conversionDraftPrompt,
  shots: conversionReviewFixture.shots.map((shot) => ({ ...shot, prompt: conversionDraftPrompt })),
  promptPlan: { ...conversionReviewFixture.promptPlan!, canonicalPrompt: conversionDraftPrompt },
};

assert.equal(
  typeof regressionEffects.composeDerivedLocalPrompt,
  'function',
  'master-derived segment prompts must have a pure exact-text composition helper',
);
const exactDerivedPrompts = [
  '【0s-2s】 第一镜：用户编辑后的正文；不允许重写。',
  '【2s-4s】 第二镜：跨边界剪辑后的正文。',
];
assert.equal(
  regressionEffects.composeDerivedLocalPrompt(
    exactDerivedPrompts.map((prompt) => ({ prompt })),
  ),
  exactDerivedPrompts.join('\n'),
  'derived local canonical text must be the exact ordered concatenation of retimed slice prompts',
);

const composeDerivedPromptWithContinuity = regressionEffects.composeDerivedLocalPrompt as unknown as (
  shots: ReadonlyArray<{ prompt: string }>,
  continuityIn?: string,
  continuityOut?: string,
) => string;
const continuityAwarePrompt = composeDerivedPromptWithContinuity([
  {
    prompt: '【0s-4s】 主体：@西娅（警觉）[朝向：前方] 正在 [抬头看向火光]（建立冲突）；空间：前景-碎石 中景-@西娅 背景-街道；光影：左侧4500K硬光；镜头：中景跟拍；台词：无；音效：环境层-[炮火] 动作层-[脚步] 情绪层-[低频鼓点]',
  },
  {
    prompt: '【4s-8s】 主体：@西娅（坚定）[朝向：北侧] 正在 [转身冲向防线]（推进冲突）；空间：前景-尘雾 中景-@西娅 背景-防线；光影：后侧3200K硬光；镜头：低机位跟拍；台词：无；音效：环境层-[炮火] 动作层-[奔跑] 情绪层-[鼓点增强]',
  },
], '西娅位于街口，面朝北侧。', '西娅抵达防线入口。');
assert.equal(
  continuityAwarePrompt,
  [
    '【0s-4s】 主体：@西娅（警觉）[朝向：前方] 正在 [承接上一段：西娅位于街口，面朝北侧；抬头看向火光]（建立冲突）；空间：前景-碎石 中景-@西娅 背景-街道；光影：左侧4500K硬光；镜头：中景跟拍；台词：无；音效：环境层-[炮火] 动作层-[脚步] 情绪层-[低频鼓点]',
    '【4s-8s】 主体：@西娅（坚定）[朝向：北侧] 正在 [转身冲向防线；本段结束状态：西娅抵达防线入口，交接下一段]（推进冲突）；空间：前景-尘雾 中景-@西娅 背景-防线；光影：后侧3200K硬光；镜头：低机位跟拍；台词：无；音效：环境层-[炮火] 动作层-[奔跑] 情绪层-[鼓点增强]',
  ].join('\n'),
  'a master-derived segment must inject its entry state into only the first shot and its exit state into only the final shot',
);

const presetVisualAtom = '风格预设视觉〔人物与环境保持统一电影质感｜服装与道具跨镜一致〕';
const catalogVisualAtom = '视觉风格锚点〔色彩：冷蓝与暖金｜材质：真实金属和湿润石面〕';
const aggregatedDerivedStylePrompt = composeDerivedPromptWithContinuity([
  {
    prompt: `【0s-4s】 主体：@西娅（警觉）[朝向：前方] 正在 [抬头]（建立冲突）；空间：街口；光影：左侧硬光 ${presetVisualAtom}｜${catalogVisualAtom}；镜头：中景；台词：无；音效：炮火`,
  },
  {
    prompt: `【4s-8s】 主体：@西娅（坚定）[朝向：北侧] 正在 [转身冲刺]（推进冲突）；空间：防线；光影：后侧逆光 ${presetVisualAtom}｜${catalogVisualAtom}；镜头：跟拍；台词：无；音效：脚步`,
  },
]);
assert.equal(
  (aggregatedDerivedStylePrompt.match(/风格预设视觉〔/gu) || []).length,
  1,
  'a master-derived segment must aggregate the shared preset visual body only once',
);
assert.equal(
  (aggregatedDerivedStylePrompt.match(/视觉风格锚点〔/gu) || []).length,
  1,
  'a master-derived segment must aggregate the shared catalog visual anchor only once',
);
assert.doesNotMatch(
  aggregatedDerivedStylePrompt.split('\n')[0],
  /(?:风格预设视觉|视觉风格锚点)〔/u,
  'shared visual style atoms must not be repeated on every derived shot',
);
assert.match(
  aggregatedDerivedStylePrompt.split('\n')[1],
  /光影：后侧逆光 风格预设视觉〔[^〕]+〕｜视觉风格锚点〔[^〕]+〕；镜头：/u,
  'the final derived shot must retain one aggregate visual-style bundle in its lighting field',
);

const segmentGenerationSourceResolver = (
  regressionEffects as typeof regressionEffects & {
    resolveSequenceSegmentGenerationSource?: (input: {
      segment?: { content: string; contentOverridden?: boolean };
      fallbackContent: string;
      masterSourceContentHash?: string;
    }) => {
      sourceStoryContent: string;
      sourceContentHash: string;
      reuseMasterShots: boolean;
    };
  }
).resolveSequenceSegmentGenerationSource;
assert.equal(
  typeof segmentGenerationSourceResolver,
  'function',
  'sequence generation must expose one policy for choosing master shots versus an overridden segment rebuild',
);
const canonicalSegmentSource = segmentGenerationSourceResolver!({
  segment: { content: '阿甲推开旧木门。' },
  fallbackContent: '不应使用的场景正文。',
  masterSourceContentHash: 'master-source-hash',
});
assert.deepEqual(
  canonicalSegmentSource,
  {
    sourceStoryContent: '阿甲推开旧木门。',
    sourceContentHash: 'master-source-hash',
    reuseMasterShots: true,
  },
  'an unedited segment must keep the confirmed master slice and its authoritative source hash',
);
const overriddenSegmentSource = segmentGenerationSourceResolver!({
  segment: {
    content: '阿甲打开蓝色暗门。',
    contentOverridden: true,
  },
  fallbackContent: '阿甲推开旧木门。',
  masterSourceContentHash: 'master-source-hash',
});
assert.equal(
  overriddenSegmentSource.sourceStoryContent,
  '阿甲打开蓝色暗门。',
  'an overridden segment must generate from the exact edited body',
);
assert.equal(
  overriddenSegmentSource.reuseMasterShots,
  false,
  'an overridden segment must rebuild local shots instead of silently reusing stale master prompts',
);
assert.notEqual(
  overriddenSegmentSource.sourceContentHash,
  'master-source-hash',
  'an overridden segment must not claim the original master source hash',
);
assert.match(
  overriddenSegmentSource.sourceContentHash,
  /^src-v1-[0-9a-f]{16}$/u,
  'an overridden segment must carry a deterministic hash of its edited body',
);

type SequencePlanningRequestStaleInput = {
  signalAborted: boolean;
  requestOperation: number;
  currentOperation: number;
  requestEpoch: number;
  currentEpoch: number;
  requestPlanningIdentity: string;
  currentPlanningIdentity: string;
  requestPlanId?: string;
  requestPlanRevision?: number;
  currentPlanRevision?: number;
  requestMasterStoryboardId?: string;
  requestMasterSnapshot?: string;
  currentMasterSnapshot?: string;
};

const sequencePlanningRequestStaleResolver = (
  regressionEffects as typeof regressionEffects & {
    isSequencePlanningRequestStale?: (input: SequencePlanningRequestStaleInput) => boolean;
  }
).isSequencePlanningRequestStale;
assert.equal(
  typeof sequencePlanningRequestStaleResolver,
  'function',
  'sequence planning must expose one behavioral stale-request policy',
);
const isSequencePlanningRequestStale = sequencePlanningRequestStaleResolver!;
const currentSequencePlanningRequest: SequencePlanningRequestStaleInput = {
  signalAborted: false,
  requestOperation: 7,
  currentOperation: 7,
  requestEpoch: 12,
  currentEpoch: 12,
  requestPlanningIdentity: 'identity-a',
  currentPlanningIdentity: 'identity-a',
  requestPlanId: 'plan-a',
  requestPlanRevision: 91,
  currentPlanRevision: 91,
  requestMasterStoryboardId: 'master-a',
  requestMasterSnapshot: 'master-snapshot-a',
  currentMasterSnapshot: 'master-snapshot-a',
};
assert.equal(
  isSequencePlanningRequestStale(currentSequencePlanningRequest),
  false,
  'a request whose complete planning snapshot still matches must remain current',
);
assert.equal(
  isSequencePlanningRequestStale({
    ...currentSequencePlanningRequest,
    currentPlanningIdentity: 'identity-b',
  }),
  true,
  'an identity-only change must invalidate the request even when its operation number is unchanged',
);
for (const [dimension, overrides] of [
  ['abort signal', { signalAborted: true }],
  ['operation number', { currentOperation: 8 }],
  ['workspace epoch', { currentEpoch: 13 }],
  ['plan revision', { currentPlanRevision: 92 }],
  ['master snapshot', { currentMasterSnapshot: 'master-snapshot-b' }],
] as const) {
  assert.equal(
    isSequencePlanningRequestStale({ ...currentSequencePlanningRequest, ...overrides }),
    true,
    `a changed ${dimension} must invalidate the sequence-planning request`,
  );
}

const serializeVideoTaskRequestDraft = (
  regressionEffects as typeof regressionEffects & {
    serializeVideoTaskRequestDraft?: (board?: {
      finalPrompt: string;
      targetModelId?: string;
      officialPromptZh?: string;
      targetOutput?: {
        targetId: string;
        prompt: string;
        parameters: Record<string, unknown>;
        referenceManifest: Array<Record<string, unknown>>;
      };
    }) => string;
  }
).serializeVideoTaskRequestDraft;
assert.equal(
  typeof serializeVideoTaskRequestDraft,
  'function',
  'video task JSON must have one content-derived serializer',
);
const firstTaskDraft = serializeVideoTaskRequestDraft!({
  finalPrompt: '旧分段提示词',
  targetModelId: 'video-model',
});
const changedTaskDraft = serializeVideoTaskRequestDraft!({
  finalPrompt: '新分段提示词：阿甲打开蓝色暗门。',
  targetModelId: 'video-model',
});
assert.notEqual(
  changedTaskDraft,
  firstTaskDraft,
  'same-board prompt edits must produce a new request draft even when no generatedAt value changes',
);
assert.equal(
  JSON.parse(changedTaskDraft).prompt,
  '新分段提示词：阿甲打开蓝色暗门。',
);
const changedParameterDraft = serializeVideoTaskRequestDraft!({
  finalPrompt: '本地提示词',
  targetModelId: 'video-model',
  targetOutput: {
    targetId: 'video-model',
    prompt: '适配后提示词',
    parameters: { duration: 12, ratio: '16:9' },
    referenceManifest: [{ assetId: 'asset-1' }],
  },
});
assert.deepEqual(
  JSON.parse(changedParameterDraft),
  {
    model: 'video-model',
    prompt: '适配后提示词',
    duration: 12,
    ratio: '16:9',
    references: [{ assetId: 'asset-1' }],
  },
  'the request draft must reflect the live adapted prompt, parameters, and references',
);
const emptyOfficialPlaceholderDraft = serializeVideoTaskRequestDraft!({
  finalPrompt: '内部规范时间轴',
  officialPromptZh: '',
});
assert.deepEqual(
  JSON.parse(emptyOfficialPlaceholderDraft),
  {
    model: '',
    prompt: '内部规范时间轴',
    references: [],
  },
  'an empty official-prompt placeholder must not implicitly select MiniMax H3',
);
const whitespaceOfficialPlaceholderDraft = serializeVideoTaskRequestDraft!({
  finalPrompt: '内部规范时间轴',
  officialPromptZh: '   ',
});
assert.equal(
  JSON.parse(whitespaceOfficialPlaceholderDraft).model,
  '',
  'whitespace-only official prompt placeholders must remain unselected',
);
const implicitOfficialDraft = serializeVideoTaskRequestDraft!({
  finalPrompt: '内部规范时间轴',
  officialPromptZh: '官方 H3 中文交付稿',
});
assert.deepEqual(
  JSON.parse(implicitOfficialDraft),
  {
    model: 'minimax-h3',
    prompt: '官方 H3 中文交付稿',
    references: [],
  },
  'a non-empty official prompt may infer the H3 target for legacy boards',
);
for (const [boardTargetId, outputTargetId] of [
  ['h3', 'minimaxh3'],
  ['minimaxh3', 'h3'],
] as const) {
  const aliasedOfficialDraft = JSON.parse(serializeVideoTaskRequestDraft!({
    finalPrompt: '内部规范时间轴',
    targetModelId: boardTargetId,
    officialPromptZh: '官方 H3 中文交付稿',
    targetOutput: {
      targetId: outputTargetId,
      prompt: '官方 H3 中文交付稿',
      parameters: { duration: 5 },
      referenceManifest: [],
    },
  }));
  assert.equal(
    aliasedOfficialDraft.model,
    'minimax-h3',
    `legacy ${boardTargetId}/${outputTargetId} aliases must serialize as canonical H3`,
  );
  assert.equal(
    aliasedOfficialDraft.prompt,
    '官方 H3 中文交付稿',
    `legacy ${boardTargetId}/${outputTargetId} aliases must use the official artifact`,
  );
}

assert.equal(
  typeof regressionEffects.shouldHandleAppHistoryShortcut,
  'function',
  'history shortcut routing must be implemented as a testable helper',
);
assert.equal(
  regressionEffects.shouldHandleAppHistoryShortcut({
    ctrlKey: true,
    metaKey: false,
    key: 'z',
    target: { tagName: 'TEXTAREA', isContentEditable: false },
  }),
  false,
  'Ctrl+Z inside a textarea must remain native text undo',
);
assert.equal(
  regressionEffects.shouldHandleAppHistoryShortcut({
    ctrlKey: true,
    metaKey: false,
    key: 'z',
    target: { tagName: 'BUTTON', isContentEditable: false },
  }),
  true,
  'Ctrl+Z outside an editor must use app history',
);
assert.equal(
  regressionEffects.shouldHandleAppHistoryShortcut({
    ctrlKey: true,
    metaKey: false,
    key: 's',
    target: { tagName: 'DIV', isContentEditable: false },
  }),
  false,
  'only undo and redo shortcuts belong to app history routing',
);

const takeHistoryStep = stateCoreEffects.takeHistoryStep;
assert.equal(
  typeof takeHistoryStep,
  'function',
  'undo and redo must share one history transition that snapshots the pre-transition state',
);
assert.ok(takeHistoryStep);
const historyA = { label: 'A' };
const historyB = { label: 'B' };
const undoneHistory = takeHistoryStep(historyB, [historyA], []);
assert.strictEqual(undoneHistory.current, historyA);
assert.deepEqual(undoneHistory.source, []);
assert.deepEqual(
  undoneHistory.destination,
  [historyB],
  'undo must push B, not the already-restored A, onto the redo stack',
);
const redoneHistory = takeHistoryStep(
  undoneHistory.current,
  undoneHistory.destination,
  undoneHistory.source,
);
assert.strictEqual(
  redoneHistory.current,
  historyB,
  'A -> B -> undo -> redo must restore B',
);
assert.deepEqual(redoneHistory.destination, [historyA]);

const commitStateTransition = stateCoreEffects.commitStateTransition;
assert.equal(
  typeof commitStateTransition,
  'function',
  'background task progress needs the same state commit path without recording undo history',
);
assert.ok(commitStateTransition);
let backgroundCurrent = { edit: 'after-user-edit', progress: 0 };
let backgroundUndo = [{ edit: 'before-user-edit', progress: 0 }];
let backgroundRedo = [{ edit: 'future-user-edit', progress: 0 }];
for (let progress = 1; progress <= 900; progress += 1) {
  const transition = commitStateTransition(
    backgroundCurrent,
    { ...backgroundCurrent, progress },
    backgroundUndo,
    backgroundRedo,
    false,
  );
  backgroundCurrent = transition.current;
  backgroundUndo = transition.undo;
  backgroundRedo = transition.redo;
}
assert.equal(backgroundCurrent.progress, 900);
assert.deepEqual(
  backgroundUndo,
  [{ edit: 'before-user-edit', progress: 0 }],
  '900 image-progress updates must not displace the last real user edit from undo history',
);
assert.deepEqual(
  backgroundRedo,
  [{ edit: 'future-user-edit', progress: 0 }],
  'background progress must not clear redo history',
);
const recordedEdit = commitStateTransition(
  backgroundCurrent,
  { edit: 'second-user-edit', progress: 900 },
  backgroundUndo,
  backgroundRedo,
  true,
);
assert.deepEqual(recordedEdit.undo, [
  { edit: 'before-user-edit', progress: 0 },
  { edit: 'after-user-edit', progress: 900 },
]);
assert.deepEqual(recordedEdit.redo, [], 'a real user edit must still clear redo history');

const settledTaskUpdate = (snapshot: {
  edit: string;
  taskStatus: 'missing' | 'running' | 'succeeded';
  bindingWarning?: string;
}) => ({
  ...snapshot,
  taskStatus: 'succeeded' as const,
  bindingWarning: '撤销后完成，未自动绑定',
});
const settledAcrossHistory = commitStateTransition(
  { edit: 'after-undo', taskStatus: 'missing' },
  settledTaskUpdate({ edit: 'after-undo', taskStatus: 'missing' }),
  [{ edit: 'older-edit', taskStatus: 'running' }],
  [{ edit: 'redo-target', taskStatus: 'running' }],
  false,
  50,
  settledTaskUpdate,
);
assert.deepEqual(
  settledAcrossHistory.redo,
  [{
    edit: 'redo-target',
    taskStatus: 'succeeded',
    bindingWarning: '撤销后完成，未自动绑定',
  }],
  'redo after a background completion must not resurrect a stale running task',
);
assert.deepEqual(
  settledAcrossHistory.undo,
  [{
    edit: 'older-edit',
    taskStatus: 'succeeded',
    bindingWarning: '撤销后完成，未自动绑定',
  }],
  'background completion must remain settled across later undo navigation too',
);
type HistoryOnlyTaskState = {
  edit: string;
  taskStatus: 'missing' | 'running' | 'succeeded';
};
const unchangedVisibleState: HistoryOnlyTaskState = {
  edit: 'project-was-removed',
  taskStatus: 'missing',
};
const historyOnlySettlement = commitStateTransition(
  unchangedVisibleState,
  unchangedVisibleState,
  [],
  [{ edit: 'restore-project', taskStatus: 'running' as const }],
  false,
  50,
  (snapshot) => ({ ...snapshot, taskStatus: 'succeeded' as const }),
);
assert.equal(
  historyOnlySettlement.changed,
  true,
  'a no-op visible update must still commit a terminal status into stale redo snapshots',
);
assert.deepEqual(historyOnlySettlement.redo, [
  { edit: 'restore-project', taskStatus: 'succeeded' },
]);

const applyOwnedProjectUpdate = stateCoreEffects.applyOwnedProjectUpdate;
assert.equal(
  typeof applyOwnedProjectUpdate,
  'function',
  'async results need a project-owner reducer instead of mutating whichever project is active',
);
assert.ok(applyOwnedProjectUpdate);
const ownedProjectA = { id: 'project-a', name: 'A', assets: [] as string[], updatedAt: 1 };
const activeProjectB = { id: 'project-b', name: 'B', assets: [] as string[], updatedAt: 2 };
const activeBState = {
  project: activeProjectB,
  projects: [ownedProjectA, activeProjectB],
  activeProjectId: activeProjectB.id,
  settings: { apiKey: 'local-secret' },
};
const routedAsyncResult = applyOwnedProjectUpdate(
  activeBState,
  ownedProjectA.id,
  (project) => ({ ...project, assets: ['asset-from-a'] }),
  50,
);
assert.strictEqual(
  routedAsyncResult.project,
  activeProjectB,
  'a result started in A must never replace or mutate active project B',
);
assert.deepEqual(routedAsyncResult.project.assets, []);
assert.deepEqual(
  routedAsyncResult.projects.find((project) => project.id === ownedProjectA.id)?.assets,
  ['asset-from-a'],
  'the completed result must be retained in its owning project A',
);
assert.equal(
  routedAsyncResult.projects.find((project) => project.id === ownedProjectA.id)?.updatedAt,
  50,
);
let unknownOwnerUpdaterCalls = 0;
const unknownOwnerResult = applyOwnedProjectUpdate(
  activeBState,
  'missing-project',
  (project) => {
    unknownOwnerUpdaterCalls += 1;
    return project;
  },
);
assert.strictEqual(unknownOwnerResult, activeBState);
assert.equal(unknownOwnerUpdaterCalls, 0);

const mergeImportedProjectState = stateCoreEffects.mergeImportedProjectState;
assert.equal(
  typeof mergeImportedProjectState,
  'function',
  'project import must merge into the latest workspace while preserving local global settings',
);
assert.ok(mergeImportedProjectState);
const latestImportState = createInitialState();
const latestProject = {
  ...latestImportState.project,
  id: 'local-live-project',
  name: '导入等待期间继续编辑的项目',
  description: 'latest edit',
  updatedAt: 40,
};
const latestSettings = {
  ...latestImportState.settings,
  theme: 'light' as const,
  textApi: {
    ...latestImportState.settings.textApi,
    apiKey: 'must-survive-import',
  },
};
const latestWorkspace = {
  ...latestImportState,
  project: latestProject,
  projects: [latestProject],
  activeProjectId: latestProject.id,
  settings: latestSettings,
};
const importedStateBase = createInitialState();
const importedProject = {
  ...importedStateBase.project,
  id: 'imported-project',
  name: '导入项目',
  updatedAt: 10,
};
const importedWorkspace = {
  ...importedStateBase,
  project: importedProject,
  projects: [importedProject],
  activeProjectId: importedProject.id,
  settings: {
    ...importedStateBase.settings,
    textApi: { ...importedStateBase.settings.textApi, apiKey: '' },
  },
};
const mergedImport = mergeImportedProjectState(latestWorkspace, importedWorkspace);
assert.strictEqual(
  mergedImport.settings,
  latestSettings,
  'sanitized settings from an exported project must not overwrite this machine settings or API keys',
);
assert.strictEqual(
  mergedImport.projects.find((project) => project.id === latestProject.id),
  latestProject,
  'edits made while file reading was pending must remain in the project library',
);
assert.strictEqual(mergedImport.project, importedProject);
assert.equal(mergedImport.activeProjectId, importedProject.id);

const selectNextPendingVideoTask = stateCoreEffects.selectNextPendingVideoTask;
assert.equal(
  typeof selectNextPendingVideoTask,
  'function',
  'automatic video polling needs a fair round-robin selector',
);
assert.ok(selectNextPendingVideoTask);
const pollingTasks = [
  { id: 'task-a', status: 'running', remoteTaskId: 'remote-a' },
  { id: 'task-b', status: 'submitted', remoteTaskId: 'remote-b' },
  { id: 'task-no-remote', status: 'running' },
  { id: 'task-done', status: 'succeeded', remoteTaskId: 'remote-done' },
  { id: 'task-c', status: 'unknown', remoteTaskId: 'remote-c' },
];
assert.equal(selectNextPendingVideoTask(pollingTasks)?.id, 'task-a');
assert.equal(selectNextPendingVideoTask(pollingTasks, 'task-a')?.id, 'task-b');
assert.equal(selectNextPendingVideoTask(pollingTasks, 'task-b')?.id, 'task-c');
assert.equal(
  selectNextPendingVideoTask(pollingTasks, 'task-c')?.id,
  'task-a',
  'the cursor must wrap so every long-running task keeps being refreshed',
);

assert.equal(
  typeof regressionEffects.isCurrentProjectOperation,
  'function',
  'async project ownership must be testable',
);

assert.equal(
  typeof regressionEffects.removeProjectFromLibrary,
  'function',
  'project deletion must use a deterministic, testable library helper',
);
assert.equal(
  typeof regressionEffects.removeProjectsFromLibrary,
  'function',
  'batch project deletion must use a deterministic, testable library helper',
);
const projectLibraryFixture = [
  { id: 'project-current', name: '当前项目', updatedAt: 30 },
  { id: 'project-archived', name: '已归档项目', updatedAt: 20 },
  { id: 'project-old', name: '旧项目', updatedAt: 10 },
];
const projectLibrarySnapshot = JSON.stringify(projectLibraryFixture);
const removedArchived = regressionEffects.removeProjectFromLibrary(
  projectLibraryFixture,
  'project-current',
  'project-archived',
);
assert.deepEqual(
  removedArchived.projects.map((project) => project.id),
  ['project-current', 'project-old'],
  'deleting a non-active project must preserve the active project and order',
);
assert.equal(removedArchived.activeProjectId, 'project-current');
assert.equal(removedArchived.activeProject?.id, 'project-current');
assert.equal(removedArchived.removedProject?.id, 'project-archived');
assert.equal(JSON.stringify(projectLibraryFixture), projectLibrarySnapshot);

const removedCurrent = regressionEffects.removeProjectFromLibrary(
  projectLibraryFixture,
  'project-current',
  'project-current',
);
assert.deepEqual(
  removedCurrent.projects.map((project) => project.id),
  ['project-archived', 'project-old'],
  'deleting the active project must leave every other project available',
);
assert.equal(removedCurrent.activeProjectId, 'project-archived');
assert.equal(removedCurrent.activeProject?.id, 'project-archived');
assert.equal(removedCurrent.removedProject?.id, 'project-current');

const cannotDeleteLast = regressionEffects.removeProjectFromLibrary(
  [projectLibraryFixture[0]],
  'project-current',
  'project-current',
);
assert.equal(cannotDeleteLast.reason, 'last-project');
assert.deepEqual(cannotDeleteLast.projects.map((project) => project.id), ['project-current']);
assert.equal(cannotDeleteLast.removedProject, undefined);

const missingProject = regressionEffects.removeProjectFromLibrary(
  projectLibraryFixture,
  'project-current',
  'missing-project',
);
assert.equal(missingProject.reason, 'not-found');
assert.deepEqual(
  missingProject.projects.map((project) => project.id),
  projectLibraryFixture.map((project) => project.id),
  'a missing project ID must not mutate the library',
);
const projectLibraryBatchSnapshot = JSON.stringify(projectLibraryFixture);
const removedBatch = regressionEffects.removeProjectsFromLibrary(
  projectLibraryFixture,
  'project-current',
  ['project-archived', 'project-old', 'project-archived', 'missing-project'],
);
assert.deepEqual(
  removedBatch.projects.map((project) => project.id),
  ['project-current'],
  'batch deletion must remove every matched project in one operation',
);
assert.deepEqual(
  removedBatch.removedProjects.map((project) => project.id),
  ['project-archived', 'project-old'],
  'batch deletion must de-duplicate selected IDs and preserve source order',
);
assert.equal(removedBatch.removedProject?.id, 'project-archived');
assert.equal(removedBatch.activeProjectId, 'project-current');
assert.equal(removedBatch.activeProject?.id, 'project-current');
assert.equal(JSON.stringify(projectLibraryFixture), projectLibraryBatchSnapshot);

const removedActiveBatch = regressionEffects.removeProjectsFromLibrary(
  projectLibraryFixture,
  'project-current',
  ['project-current', 'project-archived'],
);
assert.deepEqual(
  removedActiveBatch.projects.map((project) => project.id),
  ['project-old'],
  'deleting the active project in a batch must leave every unselected project',
);
assert.deepEqual(
  removedActiveBatch.removedProjects.map((project) => project.id),
  ['project-current', 'project-archived'],
);
assert.equal(removedActiveBatch.activeProjectId, 'project-old');
assert.equal(removedActiveBatch.activeProject?.id, 'project-old');

const cannotDeleteAllBatch = regressionEffects.removeProjectsFromLibrary(
  projectLibraryFixture,
  'project-current',
  projectLibraryFixture.map((project) => project.id),
);
assert.equal(cannotDeleteAllBatch.reason, 'last-project');
assert.deepEqual(
  cannotDeleteAllBatch.projects.map((project) => project.id),
  projectLibraryFixture.map((project) => project.id),
  'a batch that selects every project must leave the library unchanged',
);
assert.deepEqual(cannotDeleteAllBatch.removedProjects, []);

const missingBatch = regressionEffects.removeProjectsFromLibrary(
  projectLibraryFixture,
  'project-current',
  ['missing-project', ''],
);
assert.equal(missingBatch.reason, 'not-found');
assert.deepEqual(missingBatch.removedProjects, []);
assert.equal(regressionEffects.isCurrentProjectOperation('project-a', 'project-a'), true);
assert.equal(
  regressionEffects.isCurrentProjectOperation('project-a', 'project-b'),
  false,
  'an async result must not be applied after the active project changes',
);
assert.equal(
  typeof regressionEffects.applyProjectUpdateForRequest,
  'function',
  'the guarded project reducer must be implemented',
);
const currentProjectState = {
  project: { id: 'project-b', name: 'current', updatedAt: 1 },
  settings: {},
};
let staleUpdaterCalls = 0;
const staleProjectState = regressionEffects.applyProjectUpdateForRequest(
  currentProjectState,
  'project-a',
  (project) => {
    staleUpdaterCalls += 1;
    return { ...project, name: 'stale write' };
  },
  100,
);
assert.strictEqual(staleProjectState, currentProjectState);
assert.equal(staleUpdaterCalls, 0, 'a stale updater must never run against the new project');
const acceptedProjectState = regressionEffects.applyProjectUpdateForRequest(
  currentProjectState,
  'project-b',
  (project) => ({ ...project, name: 'accepted write' }),
  100,
);
assert.equal(acceptedProjectState.project.name, 'accepted write');
assert.equal(acceptedProjectState.project.updatedAt, 100);

assert.equal(
  typeof regressionEffects.isCurrentOperationIdentity,
  'function',
  'long-running operations must compare their complete request identity',
);
assert.equal(regressionEffects.isCurrentOperationIdentity('request-a', 'request-a'), true);
assert.equal(
  regressionEffects.isCurrentOperationIdentity('request-a', 'request-b'),
  false,
  'changed story or director inputs must invalidate an older request',
);

assert.equal(
  typeof regressionEffects.isCurrentStoryboardOperation,
  'function',
  'async storyboard transformations must validate their source identity',
);
const storyboardRequest = {
  workspaceEpoch: 2,
  projectId: 'project-b',
  storyboardId: 'board-1',
  sourcePrompt: '原始逐镜稿',
  sourceStoryboardSnapshot: '{"shots":[{"id":"shot-1","action":"推门"}]}',
};
assert.equal(
  regressionEffects.isCurrentStoryboardOperation(storyboardRequest, { ...storyboardRequest }),
  true,
);
assert.equal(
  regressionEffects.isCurrentStoryboardOperation(storyboardRequest, {
    ...storyboardRequest,
    storyboardId: 'board-2',
  }),
  false,
  'a response for a previously selected storyboard must be discarded',
);
assert.equal(
  regressionEffects.isCurrentStoryboardOperation(storyboardRequest, {
    ...storyboardRequest,
    sourcePrompt: '用户已编辑的新稿',
  }),
  false,
  'a response for an edited source prompt must be discarded',
);
assert.equal(
  regressionEffects.isCurrentStoryboardOperation(storyboardRequest, {
    ...storyboardRequest,
    sourceStoryboardSnapshot: '{"shots":[{"id":"shot-1","action":"停步回头"}]}',
  }),
  false,
  'editing structured shot fields without changing finalPrompt must also invalidate an older storyboard operation',
);

assert.equal(
  typeof regressionEffects.cloneRecordsForEnrichment,
  'function',
  'AI enrichment cloning must be testable',
);
const originalEntity = {
  id: 'character-1',
  name: '李云',
  appearance: '',
  assetIds: ['asset-old'],
  nsfwBodyAnchors: { stableTraits: ['左腰有浅色小痣'], sourceEvidence: '剧情原文明示' },
  nsfwProfile: { fullBody: '稳定全身比例', provenance: 'manual' as const },
};
const clonedEntities = regressionEffects.cloneRecordsForEnrichment([originalEntity]);
clonedEntities[0].appearance = '冷静眉眼';
clonedEntities[0].assetIds.push('asset-new');
clonedEntities[0].nsfwBodyAnchors.stableTraits.push('克隆新增锚点');
clonedEntities[0].nsfwProfile.fullBody = '克隆修改的全身比例';
assert.equal(
  originalEntity.appearance,
  '',
  'enriching a cloned entity must not mutate the undo snapshot object',
);
assert.deepEqual(originalEntity.assetIds, ['asset-old']);
assert.deepEqual(originalEntity.nsfwBodyAnchors.stableTraits, ['左腰有浅色小痣']);
assert.equal(originalEntity.nsfwProfile.fullBody, '稳定全身比例');

type StoryEntityReconciliationFixture = {
  id: string;
  name: string;
  appearance: string;
  outfit: string;
  assetIds: string[];
};
type StoryEntityReconciliationOptions = {
  aiSucceeded: boolean;
  kind: 'character' | 'location' | 'prop';
  localCandidateNames?: readonly string[];
  previousSceneEntityIds?: readonly string[];
  provenanceById?: Readonly<Record<string, 'manual' | 'ai' | 'local'>>;
};
const reconcileAuthoritativeStoryEntities = (regressionEffects as unknown as {
  reconcileAuthoritativeStoryEntities?: <T extends {
    id: string;
    name: string;
    assetIds?: readonly string[];
  }>(
    existing: readonly T[],
    authoritative: readonly T[],
    options: StoryEntityReconciliationOptions,
  ) => { records: T[]; removedIds: string[] };
}).reconcileAuthoritativeStoryEntities;
const coreAuthorityResult = reconcileAuthoritativeStoryEntities
  ? reconcileAuthoritativeStoryEntities<StoryEntityReconciliationFixture>(
      [
        { id: 'old-snow', name: '雪衣道侣', appearance: '旧外观', outfit: '', assetIds: [] },
        { id: 'old-fragment', name: '雪衣道侣走', appearance: '误识别动作片段', outfit: '', assetIds: [] },
        { id: 'manual-extra', name: '茶楼说书人', appearance: '用户自定义配角', outfit: '青布长衫', assetIds: [] },
        { id: 'asset-extra', name: '旧蒙面客', appearance: '旧项目角色', outfit: '黑衣', assetIds: ['asset-mask'] },
      ],
      [
        { id: 'ai-snow', name: '雪衣道侣', appearance: 'AI 外观', outfit: '雪衣', assetIds: [] },
        { id: 'ai-owner', name: '摊主', appearance: '方脸短须', outfit: '灰布衣', assetIds: [] },
      ],
      {
        aiSucceeded: true,
        kind: 'character',
        previousSceneEntityIds: ['old-snow', 'old-fragment', 'asset-extra'],
      },
    )
  : { records: [] as StoryEntityReconciliationFixture[], removedIds: [] as string[] };
assert.deepEqual(
  coreAuthorityResult.records.map((item) => item.name),
  ['雪衣道侣', '摊主', '茶楼说书人', '旧蒙面客'],
  'successful AI analysis must rebuild from authoritative names, remove an unasseted legacy scene-derived fragment, and retain safe extras',
);
assert.deepEqual(
  coreAuthorityResult.records[0],
  { id: 'old-snow', name: '雪衣道侣', appearance: '旧外观', outfit: '雪衣', assetIds: [] },
  'an authoritative same-name record must keep the old id and nonblank user fields while AI fills blank fields',
);
assert.deepEqual(coreAuthorityResult.removedIds, ['old-fragment']);

const legacyAgeReconciliation = reconcileAuthoritativeStoryEntities
  ? reconcileAuthoritativeStoryEntities<any>(
      [{
        id: 'legacy-mother',
        name: '母巢',
        race: '浪潮母体/巨型聚合生物',
        morphology: 'monster',
        bodyPlan: '巨大无定形肉质体',
        apparentAge: '约四十岁的中年母性面容',
        actualAge: '约四十岁的中年面容',
        appearance: '巨大肉质与菌毯结构',
        assetIds: [],
      }],
      [{
        id: 'fresh-mother',
        name: '母巢',
        race: '浪潮母体/巨型聚合生物',
        morphology: 'monster',
        bodyPlan: '巨大无定形肉质体',
        apparentAge: '成熟期大型个体',
        actualAge: '约八十年',
        assetIds: [],
      }],
      {
        aiSucceeded: true,
        kind: 'character',
      },
    )
  : { records: [], removedIds: [] };
assert.equal(
  legacyAgeReconciliation.records[0]?.apparentAge,
  '约四十岁的中年母性面容',
  'project reconciliation must preserve an existing user-authored age without local species judgment',
);
assert.equal(
  legacyAgeReconciliation.records[0]?.actualAge,
  '约四十岁的中年面容',
  'existing actual-age prose must not be erased or replaced by a local semantic guard',
);

const firstNonHumanAuthoritativeRecord = reconcileAuthoritativeStoryEntities
  ? reconcileAuthoritativeStoryEntities<any>(
      [],
      [{
        id: 'fresh-beast',
        name: '潮汐巨兽',
        race: '深海异兽',
        morphology: 'monster',
        bodyPlan: '四足甲壳与长尾',
        apparentAge: '约四十岁的中年母性面容',
        actualAge: '人类年龄相当于四十岁，面容成熟',
        appearance: '蓝黑鳞甲与发光触须',
        assetIds: [],
      }],
      {
        aiSucceeded: true,
        kind: 'character',
      },
    )
  : { records: [], removedIds: [] };
assert.equal(
  firstNonHumanAuthoritativeRecord.records[0]?.apparentAge,
  '约四十岁的中年母性面容',
  'new AI records preserve apparent-age text without local anatomy classification',
);
assert.equal(
  firstNonHumanAuthoritativeRecord.records[0]?.actualAge,
  '人类年龄相当于四十岁，面容成熟',
  'new AI records preserve actual-age text without local species judgment',
);
assert.equal(
  firstNonHumanAuthoritativeRecord.records[0]?.appearance,
  '蓝黑鳞甲与发光触须',
  'age repair must retain the rest of a first-time authoritative character record',
);

const firstHumanAuthoritativeRecord = reconcileAuthoritativeStoryEntities
  ? reconcileAuthoritativeStoryEntities<any>(
      [],
      [{
        id: 'fresh-human',
        name: '山城剑客',
        race: '人族',
        morphology: 'human-like',
        apparentAge: '约四十岁的成熟面容',
        actualAge: '四十岁',
        appearance: '黑发与剑眉',
        assetIds: [],
      }],
      {
        aiSucceeded: true,
        kind: 'character',
      },
    )
  : { records: [], removedIds: [] };
assert.equal(
  firstHumanAuthoritativeRecord.records[0]?.apparentAge,
  '约四十岁的成熟面容',
  'human authoritative records must keep valid human visual-age wording',
);
assert.equal(
  firstHumanAuthoritativeRecord.records[0]?.actualAge,
  '四十岁',
  'human authoritative records must keep their actual age metadata',
);

const firstPersonAuthorityResult = reconcileAuthoritativeStoryEntities
  ? reconcileAuthoritativeStoryEntities<StoryEntityReconciliationFixture>(
      [
        { id: 'old-self', name: '我', appearance: '用户保存的黑发月白长袍', outfit: '', assetIds: [] },
      ],
      [
        { id: 'ai-self', name: '无名主角', appearance: 'AI 默认外观', outfit: '月白长袍', assetIds: [] },
      ],
      {
        aiSucceeded: true,
        kind: 'character',
        previousSceneEntityIds: ['old-self'],
      },
    )
  : { records: [] as StoryEntityReconciliationFixture[], removedIds: [] as string[] };
assert.deepEqual(
  firstPersonAuthorityResult,
  {
    records: [{
      id: 'old-self',
      name: '无名主角',
      appearance: '用户保存的黑发月白长袍',
      outfit: '月白长袍',
      assetIds: [],
    }],
    removedIds: [],
  },
  'a legacy first-person character must match the authoritative unnamed protagonist without losing its id or user-authored fields',
);

const provenanceAuthorityResult = reconcileAuthoritativeStoryEntities
  ? reconcileAuthoritativeStoryEntities<StoryEntityReconciliationFixture>(
      [
        { id: 'manual-linked', name: '用户自定义护卫', appearance: '人工设定', outfit: '银甲', assetIds: [] },
        { id: 'local-stale', name: '目光只落', appearance: '旧本地误识别', outfit: '', assetIds: [] },
        { id: 'ai-stale', name: '旧 AI 群演', appearance: '旧 AI 派生', outfit: '', assetIds: [] },
      ],
      [],
      {
        aiSucceeded: true,
        kind: 'character',
        previousSceneEntityIds: ['manual-linked'],
        provenanceById: {
          'manual-linked': 'manual',
          'local-stale': 'local',
          'ai-stale': 'ai',
        },
      },
    )
  : { records: [] as StoryEntityReconciliationFixture[], removedIds: [] as string[] };
assert.deepEqual(
  provenanceAuthorityResult.records.map((item) => item.id),
  ['manual-linked'],
  'explicit manual provenance must protect a linked record while known automatic records missing from current AI authority self-heal',
);
assert.deepEqual(provenanceAuthorityResult.removedIds, ['local-stale', 'ai-stale']);

const legacyLocalCandidateResult = reconcileAuthoritativeStoryEntities
  ? reconcileAuthoritativeStoryEntities<StoryEntityReconciliationFixture>(
      [
        { id: 'location-valid', name: '符材摊', appearance: '旧场景资料', outfit: '', assetIds: [] },
        { id: 'location-fragment', name: '珠光下轻轻发亮', appearance: '旧本地误识别地点', outfit: '', assetIds: [] },
        { id: 'location-manual', name: '用户自定义密室', appearance: '人工场景', outfit: '', assetIds: [] },
      ],
      [
        { id: 'ai-location', name: '符材摊', appearance: 'AI 场景资料', outfit: '', assetIds: [] },
      ],
      {
        aiSucceeded: true,
        kind: 'location',
        localCandidateNames: ['珠光下轻轻发亮'],
        previousSceneEntityIds: ['location-valid'],
      },
    )
  : { records: [] as StoryEntityReconciliationFixture[], removedIds: [] as string[] };
assert.deepEqual(
  legacyLocalCandidateResult.records.map((item) => item.id),
  ['location-valid', 'location-manual'],
  'an unasseted legacy local-parser candidate may self-heal even when old scenes did not link it, while an unrelated manual extra remains',
);
assert.deepEqual(legacyLocalCandidateResult.removedIds, ['location-fragment']);

const fallbackEntityResult = reconcileAuthoritativeStoryEntities
  ? reconcileAuthoritativeStoryEntities<StoryEntityReconciliationFixture>(
      [
        { id: 'fallback-old', name: '旧本地人物', appearance: '已有资料', outfit: '', assetIds: [] },
      ],
      [
        { id: 'fallback-new', name: '新识别人物', appearance: '本地结果', outfit: '', assetIds: [] },
      ],
      {
        aiSucceeded: false,
        kind: 'character',
        previousSceneEntityIds: ['fallback-old'],
      },
    )
  : { records: [] as StoryEntityReconciliationFixture[], removedIds: [] as string[] };
assert.deepEqual(
  fallbackEntityResult.records.map((item) => item.id),
  ['fallback-old', 'fallback-new'],
  'without a successful AI authority pass, fallback records must be merged without destructively pruning existing local data',
);
assert.deepEqual(fallbackEntityResult.removedIds, []);

type StoryEntityNameCollection = {
  characters: string[];
  locations: string[];
  props: string[];
  aiSucceeded: boolean;
};
const collectAuthoritativeStoryEntityNames = (regressionEffects as unknown as {
  collectAuthoritativeStoryEntityNames?: (
    analysis: {
      characters?: readonly unknown[];
      locations?: readonly unknown[];
      props?: readonly unknown[];
      scenes?: readonly {
        characters?: readonly unknown[];
        location?: unknown;
        props?: readonly unknown[];
      }[];
    } | null | undefined,
    fallback: {
      characters: readonly string[];
      locations: readonly string[];
      props: readonly string[];
    },
  ) => StoryEntityNameCollection;
}).collectAuthoritativeStoryEntityNames;
const collectedAiEntityNames = collectAuthoritativeStoryEntityNames
  ? collectAuthoritativeStoryEntityNames(
      {
        characters: [{ name: '我' }, { name: '雪衣道侣' }],
        locations: [{ name: '修仙界集市' }],
        props: [{ name: '黄符纸' }],
        scenes: [
          {
            characters: ['玄衣道侣', { name: '雪衣道侣' }],
            location: { name: '符材摊' },
            props: ['镇灵石', { name: '黄符纸' }],
          },
        ],
      },
      {
        characters: ['雪衣道侣走', '目光只落'],
        locations: ['珠光下轻轻发亮'],
        props: ['本地候选道具'],
      },
    )
  : { characters: [], locations: [], props: [], aiSucceeded: false };
assert.deepEqual(
  collectedAiEntityNames,
  {
    characters: ['无名主角', '雪衣道侣', '玄衣道侣'],
    locations: ['修仙界集市', '符材摊'],
    props: ['黄符纸', '镇灵石'],
    aiSucceeded: true,
  },
  'a successful AI analysis must collect only root and scene entity names, deduplicate them, and normalize first person without unioning local fallback candidates',
);
const collectedFallbackEntityNames = collectAuthoritativeStoryEntityNames
  ? collectAuthoritativeStoryEntityNames(
      null,
      {
        characters: ['我', '本地剑客', '本地剑客'],
        locations: ['山城客栈', '山城客栈'],
        props: ['旧铜灯'],
      },
    )
  : { characters: [], locations: [], props: [], aiSucceeded: true };
assert.deepEqual(
  collectedFallbackEntityNames,
  {
    characters: ['无名主角', '本地剑客'],
    locations: ['山城客栈'],
    props: ['旧铜灯'],
    aiSucceeded: false,
  },
  'when AI analysis is unavailable, the collector must retain deduplicated local fallback names instead of returning an empty project bible',
);

const mergedEnrichmentDetails = (regressionEffects as unknown as {
  mergeEntityEnrichmentDetails?: (
    items: ReadonlyArray<Record<string, unknown>>,
  ) => Map<string, Record<string, string>>;
}).mergeEntityEnrichmentDetails?.([
  {
    name: '阿莲',
    appearance: '乌黑长发、眉间小痣',
    outfit: '灰色旧衣',
  },
  {
    name: '阿莲',
    appearance: '',
    outfit: '青色棉麻长衣与黑色布靴',
  },
  {
    name: '阿莲',
    appearance: '  ',
  },
]);
assert.deepEqual(
  mergedEnrichmentDetails?.get('阿莲') || null,
  {
    name: '阿莲',
    appearance: '乌黑长发、眉间小痣',
    outfit: '青色棉麻长衣与黑色布靴',
  },
  'same-name partial AI records must merge field by field without blank values erasing usable details',
);

for (const authoredText of ['未知', '待补充', '根据剧情', '无资料', '默认', '按默认设定保留用户外观']) {
  const ordinary = regressionEffects.mergeEntityEnrichmentDetails([
    { name: '语义保留夹具', appearance: '先前资料' },
    { name: '语义保留夹具', appearance: authoredText },
    { name: '语义保留夹具', appearance: '  ', numberOnly: 123 },
  ]).get('语义保留夹具');
  assert.equal(ordinary?.appearance, authoredText, 'nonempty ordinary fields follow the response merge order without word filtering');
  assert.equal(ordinary?.numberOnly, undefined, 'wrong-typed values are still ignored');
  const character = regressionEffects.mergeCharacterEnrichmentDetails([
    { name: '语义保留夹具', apparentAge: authoredText, appearance: authoredText, nsfwProfile: { fullBody: authoredText, provenance: 'story-enrichment' } },
    { name: '语义保留夹具', apparentAge: '  ', appearance: '  ', nsfwProfile: { fullBody: '  ' } },
  ]).get('语义保留夹具');
  assert.equal(character?.apparentAge, authoredText, 'age prose is not a missing-field classification');
  assert.equal(character?.appearance, authoredText, 'appearance prose is not a missing-field classification');
  assert.equal(character?.nsfwProfile?.fullBody, authoredText, 'private-profile transport uses the same nonempty string contract');
}

const mergedCharacterEnrichmentDetails = regressionEffects.mergeCharacterEnrichmentDetails([
  {
    name: '阿莲',
    appearance: '乌黑长发、眉间小痣',
    nsfwProfile: {
      fullBody: '稳定全身比例',
      breasts: '稳定胸部轮廓',
      provenance: 'story-analysis',
      sourceHash: 'story-a',
    },
  },
  {
    name: '阿莲',
    appearance: '',
    nsfwProfile: {
      breasts: '补全后的稳定胸部轮廓',
      vulva: '稳定外阴轮廓',
      anus: '稳定后庭轮廓',
      provenance: 'story-enrichment',
      sourceHash: 'story-a',
    },
  },
]);
assert.deepEqual(
  mergedCharacterEnrichmentDetails.get('阿莲'),
  {
    name: '阿莲',
    appearance: '乌黑长发、眉间小痣',
    nsfwProfile: {
      fullBody: '稳定全身比例',
      breasts: '补全后的稳定胸部轮廓',
      vulva: '稳定外阴轮廓',
      anus: '稳定后庭轮廓',
      provenance: 'story-enrichment',
      sourceHash: 'story-a',
    },
  },
  'character enrichment must deep-merge private slots instead of dropping the nested object',
);

const nonHumanAgeMerge = regressionEffects.mergeCharacterEnrichmentDetails([
  {
    name: '母巢',
    race: '浪潮母体/巨型聚合生物',
    morphology: 'monster',
    bodyPlan: '巨大无定形肉质体',
    apparentAge: '成熟期大型个体',
    actualAge: '约八十年',
  },
  // Later scene facts follow the ordinary field merge order; local code no
  // longer rejects them by interpreting age/anatomy prose.
  {
    name: '母巢',
    apparentAge: '约四十岁的中年母性面容',
    actualAge: '约四十岁的中年面容',
  },
]);
assert.deepEqual(
  nonHumanAgeMerge.get('母巢'),
  {
    name: '母巢',
    race: '浪潮母体/巨型聚合生物',
    morphology: 'monster',
    bodyPlan: '巨大无定形肉质体',
    apparentAge: '约四十岁的中年母性面容',
    actualAge: '约四十岁的中年面容',
  },
  'scene-level text follows normal merge order with no semantic age exception',
);
const lateMorphologyMerge = regressionEffects.mergeCharacterEnrichmentDetails([
  { name: '壳兽', apparentAge: '约四十岁的中年母性面容' },
  { name: '壳兽', race: '六足甲壳巨兽', bodyPlan: '六足甲壳、昆虫口器' },
]);
assert.deepEqual(
  lateMorphologyMerge.get('壳兽'),
  {
    name: '壳兽',
    race: '六足甲壳巨兽',
    bodyPlan: '六足甲壳、昆虫口器',
    apparentAge: '约四十岁的中年母性面容',
  },
  'later morphology evidence must not invalidate a previously returned age string',
);

assert.deepEqual(
  regressionEffects.mergeCharacterNsfwProfiles(
    { fullBody: '新剧情档案', provenance: 'story-enrichment', sourceHash: 'story-new' },
    { fullBody: '旧剧情档案', vulva: '旧字段', provenance: 'story-analysis', sourceHash: 'story-old' },
  ),
  { fullBody: '新剧情档案', provenance: 'story-enrichment', sourceHash: 'story-new' },
  'a new source hash must replace rather than contaminate an older AI dossier',
);
assert.deepEqual(
  regressionEffects.mergeCharacterNsfwProfiles(
    { fullBody: 'AI 建议', vulva: 'AI 补齐', provenance: 'story-enrichment', sourceHash: 'story-new' },
    { fullBody: '用户手工设定', provenance: 'manual' },
  ),
  { fullBody: '用户手工设定', vulva: 'AI 补齐', provenance: 'manual', sourceHash: 'story-new' },
  'manual private fields remain authoritative while AI may fill an empty slot',
);
assert.deepEqual(
  regressionEffects.mergeCharacterNsfwProfiles(
    undefined,
    { fullBody: '旧自动档案', provenance: 'story-analysis', sourceHash: 'story-old' },
  ),
  { fullBody: '旧自动档案', provenance: 'story-analysis', sourceHash: 'story-old' },
  'an ordinary reparse preserves the established automatic private dossier',
);
assert.deepEqual(
  regressionEffects.mergeCharacterNsfwProfiles(
    undefined,
    { fullBody: '用户手工设定', provenance: 'manual' },
  ),
  { fullBody: '用户手工设定', provenance: 'manual' },
  'a SFW reparse preserves explicitly manual private data',
);
const previousAutomaticDossier: {
  id: string;
  name: string;
  appearance: string;
  assetIds: string[];
  nsfwBodyAnchors?: { stableTraits: string[]; sourceEvidence?: string };
  nsfwProfile?: CharacterNsfwProfile;
} = {
  id: 'character-private-refresh',
  name: '阿莲',
  appearance: '旧外观',
  assetIds: [],
  nsfwBodyAnchors: {
    stableTraits: ['私密全身：旧自动档案', '腰侧有一颗浅色小痣'],
    sourceEvidence: '人物分析结果明确提供',
  },
  nsfwProfile: {
    fullBody: '旧自动档案',
    provenance: 'story-analysis' as const,
    sourceHash: 'story-old',
  },
};
const fallbackDossierReconciliation = reconcileAuthoritativeStoryEntities?.(
  [previousAutomaticDossier],
  [{ id: 'character-new', name: '阿莲', appearance: '本地回退外观', assetIds: [], nsfwProfile: undefined }],
  { aiSucceeded: false, kind: 'character' },
);
assert.deepEqual(
  fallbackDossierReconciliation?.records[0]?.nsfwProfile,
  previousAutomaticDossier.nsfwProfile,
  'an unavailable AI analysis must not erase the last usable automatic dossier',
);
const successfulSfwDossierReconciliation = reconcileAuthoritativeStoryEntities?.(
  [previousAutomaticDossier],
  [{ id: 'character-new', name: '阿莲', appearance: '新 SFW 外观', assetIds: [], nsfwProfile: undefined }],
  { aiSucceeded: true, kind: 'character' },
);
assert.deepEqual(
  successfulSfwDossierReconciliation?.records[0]?.nsfwProfile,
  previousAutomaticDossier.nsfwProfile,
  'a successful ordinary authoritative reparse preserves the stable private dossier',
);
assert.deepEqual(
  successfulSfwDossierReconciliation?.records[0]?.nsfwBodyAnchors?.stableTraits,
  ['腰侧有一颗浅色小痣', '私密全身：旧自动档案'],
  'a successful ordinary reparse keeps private body anchors aligned with the preserved dossier',
);

assert.equal(
  typeof regressionEffects.filterStoryboardReferenceAssets,
  'function',
  'storyboard reference filtering must be testable',
);
const thirteenAssets = Array.from({ length: 13 }, (_, index) => ({
  id: `asset-${index + 1}`,
  role: 'character',
  type: 'reference',
  mediaType: 'image',
  dataUrl: `data:image/png;base64,${index % 2 ? 'AQ==' : 'AA=='}`,
}));
assert.equal(
  regressionEffects.filterStoryboardReferenceAssets(thirteenAssets).length,
  13,
  'the storyboard editor must not silently discard the 13th reference asset',
);
assert.deepEqual(
  regressionEffects.filterStoryboardReferenceAssets([
    { id: 'first', role: 'first-frame', type: 'first-frame', mediaType: 'image', dataUrl: 'data:image/png;base64,AA==' },
    { id: 'last', role: 'last-frame', type: 'last-frame', mediaType: 'image', dataUrl: 'data:image/png;base64,AQ==' },
    { id: 'shot', role: 'composition', type: 'reference', mediaType: 'image', dataUrl: 'data:image/webp;base64,Ag==' },
    { id: 'arbitrary-motion-image', role: 'motion', type: 'reference', mediaType: 'image', dataUrl: 'data:image/jpeg;base64,Aw==' },
    { id: 'audio', role: 'audio', type: 'audio', mediaType: 'audio', dataUrl: 'data:image/png;base64,BA==' },
    { id: 'video', role: 'motion', type: 'video', mediaType: 'video', dataUrl: 'data:image/png;base64,BQ==' },
    { id: 'missing-image', role: 'style', type: 'reference', mediaType: 'image', dataUrl: 'data:image/png;base64,Bg==', missing: true },
    { id: 'prompt-only', role: 'character', type: 'reference', mediaType: 'image', prompt: '没有真实图片像素' },
  ]).map((asset) => asset.id),
  ['first', 'last', 'shot', 'arbitrary-motion-image'],
  'every readable asset-library image must be selectable regardless of its role, while non-images and missing pixels stay excluded',
);

assert.equal(
  typeof regressionEffects.normalizePresetImportRoot,
  'function',
  'preset round-trip normalization must be testable',
);
const exportedRule = { id: 'rule-1', name: '规则一' };
const exportedStoryExpansion = {
  id: 'story-expansion-1',
  name: '剧情扩写规则',
  systemPrompt: '扩写系统规则',
  outputRules: '只返回完整剧情正文',
};
assert.deepEqual(
  regressionEffects.normalizePresetImportRoot({
    format: 'lianhua-preset/v1',
    type: 'rules',
    preset: exportedRule,
  }),
  { ruleSets: [exportedRule] },
  'a rules preset exported by the app must map back to the importer ruleSets key',
);
for (const type of ['expansions', 'storyExpansionPresets']) {
  assert.deepEqual(
    regressionEffects.normalizePresetImportRoot({
      format: 'lianhua-preset/v1',
      type,
      preset: exportedStoryExpansion,
    }),
    { storyExpansionPresets: [exportedStoryExpansion] },
    `the explicit ${type} envelope must route to storyExpansionPresets`,
  );
}
assert.deepEqual(
  regressionEffects.normalizePresetImportRoot({
    format: 'lianhua-preset/v1',
    type: 'unrecognized-kind',
    preset: exportedRule,
  }),
  { converterPresets: [exportedRule] },
  'unknown preset envelopes must use a supported fallback instead of disappearing',
);

const normalizeImportedRulePreset = stateCoreEffects.normalizeImportedRulePreset;
assert.equal(
  typeof normalizeImportedRulePreset,
  'function',
  'rule import needs a semantic normalizer that preserves exported mode',
);
assert.ok(normalizeImportedRulePreset);
const roundTripRule = normalizeImportedRulePreset({
  name: '中性命名规则',
  description: '自导出回导',
  mode: 'timeline',
  baseRules: '基础规则',
  continuityRules: '连续性规则',
  outputRules: '输出规则',
  enabled: true,
  version: '2.0.0',
}, 0, 123, 'ruleset-imported');
assert.equal(
  roundTripRule.mode,
  'timeline',
  'an exported timeline rule must not be downgraded to custom during re-import',
);

const normalizeImportedConverterPreset = stateCoreEffects.normalizeImportedConverterPreset;
assert.equal(
  typeof normalizeImportedConverterPreset,
  'function',
  'converter import needs a semantic normalizer that prefers explicit exported fields',
);
assert.ok(normalizeImportedConverterPreset);
const roundTripConverter = normalizeImportedConverterPreset({
  name: '没有动作关键词的中性名称',
  workflow: 'action',
  inputMode: 'text',
  scope: 'video',
  systemPrompt: '转换提示词',
  outputRules: '转换输出规则',
  enabled: true,
  version: '3.0.0',
}, 0, 456, 'converter-imported');
assert.deepEqual(
  {
    workflow: roundTripConverter.workflow,
    inputMode: roundTripConverter.inputMode,
    scope: roundTripConverter.scope,
  },
  { workflow: 'action', inputMode: 'text', scope: 'video' },
  'self-exported workflow, inputMode, and scope must survive a round trip without name guessing',
);
const roundTripUnifiedConverter = normalizeImportedConverterPreset({
  name: '通用视频转换器',
  workflow: 'all',
  inputMode: 'all',
  scope: 'video',
  systemPrompt: '不分题材自动转化',
  outputRules: '输出结构化时间轴',
  enabled: true,
  version: '1.0.0',
}, 0, 457, 'converter-unified-imported');
assert.equal(
  roundTripUnifiedConverter.workflow,
  'all',
  'a self-exported unified converter must remain universal after re-import',
);

const normalizeImportedStoryExpansionPreset = stateCoreEffects.normalizeImportedStoryExpansionPreset;
assert.equal(
  typeof normalizeImportedStoryExpansionPreset,
  'function',
  'story expansion import needs its own semantic normalizer',
);
assert.ok(normalizeImportedStoryExpansionPreset);
assert.deepEqual(
  normalizeImportedStoryExpansionPreset({
    title: '成人剧情扩写',
    prompt: '仅在输入已经进入对应内容时具体扩写',
    rules: '保持人物和事件连续，只输出正文',
    enabled: false,
    version: '2.1.0',
  }, 1, 458, 'story-expansion-imported'),
  {
    id: 'story-expansion-imported',
    name: '成人剧情扩写',
    systemPrompt: '仅在输入已经进入对应内容时具体扩写',
    outputRules: '保持人物和事件连续，只输出正文',
    enabled: false,
    version: '2.1.0',
    updatedAt: 458,
  },
  'story expansion imports must preserve their independent prompt, output contract, switch, and version',
);

const canImportPresetPayload = stateCoreEffects.canImportPresetPayload;
assert.equal(
  typeof canImportPresetPayload,
  'function',
  'preset import acceptance must be a testable payload decision',
);
assert.ok(canImportPresetPayload);
const emptyPresetPayload = {
  ruleSets: [],
  converterPresets: [],
  storyExpansionPresets: [],
  stylePresets: [],
};
assert.equal(
  canImportPresetPayload(false, {
    ...emptyPresetPayload,
    storyExpansionPresets: [exportedStoryExpansion],
  }),
  true,
  'a story-expansion-only preset payload must be importable',
);
[
  { label: 'text', api: { textApi: { baseUrl: 'http://127.0.0.1:11434/v1' } } },
  { label: 'vision', api: { visionApi: { model: 'local-vision' } } },
  { label: 'image', api: { imageApi: { backend: 'sd_webui' } } },
].forEach(({ label, api }) => {
  assert.equal(
    canImportPresetPayload(true, { ...emptyPresetPayload, ...api }),
    true,
    `a MoRan ${label} API object must make a zero-preset payload importable`,
  );
});
assert.equal(
  canImportPresetPayload(false, {
    ...emptyPresetPayload,
    textApi: { baseUrl: 'http://127.0.0.1:11434/v1' },
  }),
  false,
  'ordinary preset import must not accept an API-only payload',
);
assert.equal(
  canImportPresetPayload(true, emptyPresetPayload),
  false,
  'MoRan import must still reject a payload with neither presets nor API objects',
);
assert.equal(
  canImportPresetPayload(true, { ...emptyPresetPayload, textApi: [] }),
  false,
  'an array under a known API key is not a recognizable API object',
);
assert.equal(
  canImportPresetPayload(true, { ...emptyPresetPayload, textApi: {} }),
  false,
  'an empty object under a known API key must not report a successful import',
);
assert.equal(
  canImportPresetPayload(true, {
    ...emptyPresetPayload,
    imageApi: { unrelated: 'not an API setting' },
  }),
  false,
  'an API-only payload must contain at least one recognized API field',
);
assert.equal(
  canImportPresetPayload(false, {
    ...emptyPresetPayload,
    ruleSets: [{ name: '可导入规则' }],
  }),
  true,
  'ordinary preset import must continue accepting a recognized preset',
);

const mergeImportedApiSettings = stateCoreEffects.mergeImportedApiSettings;
assert.equal(
  typeof mergeImportedApiSettings,
  'function',
  'MoRan API import must update both live configs and their active saved profiles',
);
assert.ok(mergeImportedApiSettings);
const apiImportBase = createInitialState().settings;
const apiSettingsBeforeImport: AppSettings = {
  ...apiImportBase,
  textApi: {
    ...apiImportBase.textApi,
    enabled: true,
    apiKey: '',
    provider: 'openai_compatible',
    temperature: 0.7,
    maxTokens: 4096,
  },
  imageApi: {
    ...apiImportBase.imageApi,
    enabled: true,
    apiKey: '',
    backend: 'openai',
  },
  activeTextApiProfileId: 'text-active',
  activeImageApiProfileId: 'image-active',
  textApiProfiles: [{
    ...apiImportBase.textApi,
    id: 'text-active',
    name: '当前文本配置',
    enabled: true,
    apiKey: '',
    provider: 'openai_compatible',
    temperature: 0.7,
    maxTokens: 4096,
    createdAt: 1,
    updatedAt: 2,
  }],
  imageApiProfiles: [{
    ...apiImportBase.imageApi,
    id: 'image-active',
    name: '当前图像配置',
    enabled: true,
    apiKey: '',
    backend: 'openai',
    createdAt: 1,
    updatedAt: 2,
  }],
};
const apiSettingsAfterImport = mergeImportedApiSettings(
  apiSettingsBeforeImport,
  {
    textApi: {
      provider: 'claude',
      baseUrl: 'http://127.0.0.1:11434/v1/messages',
      model: 'local-claude',
      temperature: 0.25,
      maxTokens: 8192,
    },
    imageApi: {
      backend: 'sd_webui',
      baseUrl: 'http://127.0.0.1:7860',
      model: 'local-sd',
    },
  },
  999,
);
assert.deepEqual(
  {
    enabled: apiSettingsAfterImport.textApi.enabled,
    provider: apiSettingsAfterImport.textApi.provider,
    temperature: apiSettingsAfterImport.textApi.temperature,
    maxTokens: apiSettingsAfterImport.textApi.maxTokens,
  },
  { enabled: true, provider: 'claude', temperature: 0.25, maxTokens: 8192 },
  'a keyless local API without an enabled field must remain enabled and retain imported tuning fields',
);
assert.equal(apiSettingsAfterImport.imageApi.enabled, true);
assert.equal(apiSettingsAfterImport.imageApi.backend, 'sd_webui');
assert.deepEqual(
  {
    provider: apiSettingsAfterImport.textApiProfiles[0].provider,
    baseUrl: apiSettingsAfterImport.textApiProfiles[0].baseUrl,
    temperature: apiSettingsAfterImport.textApiProfiles[0].temperature,
    maxTokens: apiSettingsAfterImport.textApiProfiles[0].maxTokens,
    enabled: apiSettingsAfterImport.textApiProfiles[0].enabled,
    updatedAt: apiSettingsAfterImport.textApiProfiles[0].updatedAt,
  },
  {
    provider: 'claude',
    baseUrl: 'http://127.0.0.1:11434/v1/messages',
    temperature: 0.25,
    maxTokens: 8192,
    enabled: true,
    updatedAt: 999,
  },
  'switching away from and back to the active profile must not restore pre-import values',
);
assert.equal(apiSettingsAfterImport.imageApiProfiles[0].backend, 'sd_webui');
assert.equal(apiSettingsAfterImport.imageApiProfiles[0].updatedAt, 999);

assert.equal(
  typeof regressionEffects.credentialDraftFromEntry,
  'function',
  'credential-book selection must derive a matching edit draft',
);
assert.deepEqual(
  regressionEffects.credentialDraftFromEntry({
    name: '主用接口',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret-placeholder',
  }),
  {
    name: '主用接口',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret-placeholder',
  },
  'the initially selected credential must populate every edit field',
);
assert.deepEqual(
  regressionEffects.credentialDraftFromEntry(undefined),
  { name: '', baseUrl: '', apiKey: '' },
  'new credential mode must start with an empty draft',
);

assert.equal(
  typeof regressionEffects.deriveWorkspaceUiState,
  'function',
  'restored workspace UI state must be derived in one testable place',
);
const initialWorkspaceState = createInitialState();
const restoredWorkspaceSettings = {
  ...initialWorkspaceState.settings,
  defaultDurationPreset: '15s' as const,
  defaultDurationSec: 15,
  defaultShotMode: 'auto' as const,
  defaultShotCount: 6,
  defaultStylePresetId: 'style-default',
  defaultRuleSetId: 'rule-default',
  defaultStoryExpansionPresetId: 'story-expansion-default',
};
const restoredUi = regressionEffects.deriveWorkspaceUiState({
  project: {
    ...initialWorkspaceState.project,
    sourceDocuments: [{
      id: 'source-a',
      name: '旧稿',
      content: '恢复后的剧情',
      createdAt: 1,
      updatedAt: 1,
    }],
    scenes: [{
      id: 'scene-a',
      title: '场景 A',
      content: '恢复后的剧情',
      summary: '场景摘要',
      characterIds: [],
      propIds: [],
      storyboardIds: ['board-a'],
      createdAt: 1,
      updatedAt: 1,
    }],
    storyboards: [{
      id: 'board-a',
      sceneId: 'scene-a',
      sourceSceneIds: ['scene-a'],
      workflow: 'grid',
      inputMode: 'reference',
      durationPreset: 'custom',
      durationSec: 42,
      shotMode: 'exact',
      shotCount: 9,
      pace: 'tight',
      aspectRatio: '9:16',
      resolution: '4K',
      audioMode: 'none',
      stylePresetId: 'style-a',
      ruleSetId: 'rule-a',
      converterPresetId: 'converter-a',
      directorStyleId: 'director-a',
      cameraTerms: ['航拍'],
      lightingTerms: ['雨夜湿润'],
      visualStyle: '水墨幻想',
      globalLock: '',
      extraRequirement: '恢复后的要求',
      globalReferenceAssetIds: ['asset-1', 'asset-1', 'asset-missing'],
      shots: [makeVideoShot({ referenceAssetIds: ['asset-2'] })],
      finalPrompt: '',
      createdAt: 1,
      updatedAt: 1,
    } as Storyboard & { globalReferenceAssetIds: string[] }],
    assets: [
      {
        id: 'asset-1',
        name: '资产 1',
        type: 'reference',
        role: 'character',
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'asset-2',
        name: '资产 2',
        type: 'reference',
        role: 'character',
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  },
  settings: restoredWorkspaceSettings,
});
assert.deepEqual(
  {
    storyInput: restoredUi.storyInput,
    storyName: restoredUi.storyName,
    selectedDirectorSceneIds: restoredUi.selectedDirectorSceneIds,
    activeStoryboardId: restoredUi.activeStoryboardId,
    directorWorkflow: restoredUi.directorWorkflow,
    durationSec: restoredUi.customDuration,
    shotCount: restoredUi.shotCount,
    selectedAssetIds: restoredUi.selectedAssetIds,
    selectedRuleId: restoredUi.selectedRuleId,
  },
  {
    storyInput: '恢复后的剧情',
    storyName: '旧稿',
    selectedDirectorSceneIds: ['scene-a'],
    activeStoryboardId: 'board-a',
    directorWorkflow: 'grid',
    durationSec: 42,
    shotCount: 9,
    selectedAssetIds: ['asset-1'],
    selectedRuleId: 'rule-a',
  },
);
const emptyGlobalSelectionUi = regressionEffects.deriveWorkspaceUiState({
  project: {
    ...initialWorkspaceState.project,
    storyboards: [{
      ...(initialWorkspaceState.project.storyboards[0] || restoredUi),
      id: 'board-empty-global-selection',
      sceneId: initialWorkspaceState.project.scenes[0]?.id || '',
      inputMode: 'reference',
      globalReferenceAssetIds: [],
      shots: [makeVideoShot({ referenceAssetIds: ['asset-2'] })],
    } as Storyboard & { globalReferenceAssetIds: string[] }],
    assets: [{
      id: 'asset-2',
      name: '仅属于单镜的自动生成图',
      type: 'reference',
      role: 'composition',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }],
  },
  settings: initialWorkspaceState.settings,
});
assert.deepEqual(
  emptyGlobalSelectionUi.selectedAssetIds,
  [],
  'an explicit empty global selection must not restore shot-local generated references as checked global images',
);
assert.equal(restoredUi.extraRequirement, '恢复后的要求');
assert.equal(
  (restoredUi as typeof restoredUi & { selectedStoryExpansionPresetId?: string })
    .selectedStoryExpansionPresetId,
  'story-expansion-default',
  'workspace restore must select the saved default story expansion preset',
);
assert.equal(
  regressionEffects.deriveWorkspaceUiState({
    project: {
      ...initialWorkspaceState.project,
      storyboards: [],
    },
    settings: initialWorkspaceState.settings,
  }).extraRequirement,
  '',
  'a workspace without a saved requirement must start with an empty extra-requirement field',
);

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
assert.match(appSource, /const fullCharacterContext = assetKind === "character"/u);
assert.match(appSource, /const autofillDocuments = fullCharacterContext\s*\? state\.project\.sourceDocuments :/u,
  'character autofill must include later source documents rather than only the opening two');
assert.match(appSource, /fullCharacterContext \? document\.content\.trim\(\) : document\.content\.trim\(\)\.slice/u,
  'late ownership/return facts stay in the existing character-completion request');
assert.match(appSource, /const projectContext = useStoryForDossier \? \(fullCharacterContext \? projectContextParts : projectContextParts\.slice/u,
  'the final client context limit must not truncate the complete character story again');
assert.match(
  appSource,
  /handleDeleteSelectedProjects/u,
  'the project library must expose a batch-delete handler',
);
assert.match(
  appSource,
  /project-library-bulk-toolbar/u,
  'the project library must expose a dedicated multi-select toolbar',
);
assert.match(
  appSource,
  /aria-label=\{`选择项目/u,
  'each project row must expose an accessible selection checkbox',
);
assert.match(
  appSource,
  /removeProjectsFromLibrary\(/u,
  'the UI must remove selected projects in one pure batch operation',
);
assert.match(
  appSource,
  /shouldHandleAppHistoryShortcut\(event\)/u,
  'the global keydown listener must delegate undo/redo routing',
);
const restoreSnapshotSource = appSource.slice(
  appSource.indexOf('const restoreSnapshot ='),
  appSource.indexOf('const renderView ='),
);
assert.match(
  restoreSnapshotSource,
  /syncWorkspaceUiState\(restored\)/u,
  'snapshot restoration must synchronize every controlled workspace field',
);
const historySource = appSource.slice(
  appSource.indexOf('const undo ='),
  appSource.indexOf('const onKeyDown', appSource.indexOf('const redo =')),
);
assert.equal(
  [...historySource.matchAll(/if\s*\(step\.current\.project\.id !== previousProjectId\)\s*\{\s*syncWorkspaceUiState\(step\.current\);\s*\}/gu)].length,
  2,
  'undo and redo must synchronize controlled drafts only when crossing project boundaries',
);
const newProjectSource = appSource.slice(
  appSource.indexOf('const handleNewProject ='),
  appSource.indexOf('const handleSaveStory ='),
);
assert.match(
  newProjectSource,
  /syncWorkspaceUiState\(nextState\)/u,
  'new projects must reset every controlled field through the shared derivation path',
);
const projectDeletionSource = appSource.slice(
  appSource.indexOf('const handleDeleteProject ='),
  appSource.indexOf('const handleSaveStory ='),
);
assert.match(
  projectDeletionSource,
  /window\.confirm\(/u,
  'project deletion must ask for confirmation before removing user data',
);
assert.match(
  projectDeletionSource,
  /removeProjectFromLibrary\(/u,
  'project deletion must go through the deterministic library helper',
);
assert.match(
  appSource,
  /project-library-delete/u,
  'the project library must expose a dedicated delete button',
);
assert.match(
  appSource,
  /至少保留一个项目/u,
  'the UI must explain why the last remaining project cannot be deleted',
);
assert.ok(
  (appSource.match(/applyProjectUpdateForRequest\(/gu) || []).length >= 2,
  'story analysis and storyboard generation must both use guarded project reducers',
);
assert.match(
  appSource,
  /cloneRecordsForEnrichment\(\s*(?:analysisProject|state\.project)\.characters\s*,?\s*\)/u,
  'AI enrichment must clone character records before Object.assign',
);
assert.match(
  appSource,
  /isCurrentOperationIdentity\(requestIdentity,\s*storyAnalysisIdentityRef\.current\)/u,
  'story analysis must discard results when the source text changes in the same project',
);
const storyAnalysisLifecycleSource = appSource.slice(
  appSource.indexOf('const storyAnalysisAbortRef ='),
  appSource.indexOf('const syncWorkspaceUiState ='),
);
assert.match(
  storyAnalysisLifecycleSource,
  /activeRequest\.abort\(\)[\s\S]*\[storyAnalysisIdentity\]/u,
  'changing the active project or story input must abort an in-flight story analysis request',
);
const storyAnalysisSource = appSource.slice(
  appSource.indexOf('const handleAnalyzeStory ='),
  appSource.indexOf('const handleImportStoryFile ='),
);
const storyCharacterRefreshSource = appSource.slice(
  appSource.indexOf('export const STORY_REANALYSIS_CHARACTER_REFRESH_FIELDS ='),
  appSource.indexOf('type ImageWorkbenchStyleSource ='),
);
// App.tsx also exports the refresh as a tiny pure function. Load just that
// source slice for a focused regression fixture without booting React/CSS.
const refreshRuntime = vm.createContext({ canonicalCharacterVariantName, DEFAULT_FIRST_PERSON_SUBJECT, preserveConfirmedCharacterFields });
const refreshRuntimeSource = transpileModule(
  storyCharacterRefreshSource.replace(/^export\s+/gmu, ''),
  { compilerOptions: { target: ScriptTarget.ES2020, module: ModuleKind.ESNext } },
).outputText;
new vm.Script(`${refreshRuntimeSource}\nglobalThis.__refreshReanalyzedCharacterFields = refreshReanalyzedCharacterFields;`)
  .runInContext(refreshRuntime);
const refreshReanalyzedCharacterFields = (refreshRuntime as typeof refreshRuntime & {
  __refreshReanalyzedCharacterFields?: unknown;
}).__refreshReanalyzedCharacterFields as (
  existing: readonly Record<string, unknown>[],
  authoritative: readonly Record<string, unknown>[],
) => Array<Record<string, unknown>>;
const legacyCharacterRefreshFixture = refreshReanalyzedCharacterFields(
  [{
    id: 'legacy-莲', name: '阿莲', gender: '女', outfit: '青色棉麻长衣',
    signatureProps: '荷叶碟、腰间储物袋', anchor: '人工锁定的身份锚点',
    motionHabits: '人工记录的步态', negativeContinuity: '人工禁改项',
    appearance: '人工设定外观', assetIds: ['asset-阿莲参考图'],
  }],
  [{
    id: 'ai-莲', name: '阿莲', signatureProps: '腰间储物袋',
    anchor: 'AI 全文判断的稳定锚点', motionHabits: 'AI 全文判断的动作习惯',
    negativeContinuity: 'AI 全文判断的禁改项', appearance: 'AI 全文判断的外观',
  }],
);
assert.equal(
  legacyCharacterRefreshFixture[0]?.signatureProps,
  '腰间储物袋',
  'full-story reclassification clears the polluted 荷叶碟 while retaining the stable 腰间储物袋',
);
assert.equal(legacyCharacterRefreshFixture[0]?.id, 'legacy-莲', 'reclassification preserves the existing character id');
assert.deepEqual(
  Array.from((legacyCharacterRefreshFixture[0]?.assetIds || []) as string[]),
  ['asset-阿莲参考图'],
  'reclassification preserves every existing character asset link',
);
assert.equal(legacyCharacterRefreshFixture[0]?.gender, '女', 'fields outside the targeted refresh remain manually authored');
const preservedCharacterRefreshInput = {
  id: 'stable-character-id', name: '阿莲', gender: '女', outfit: '青色棉麻长衣',
  signatureProps: '腰间储物袋', anchor: '人工锁定的身份锚点',
  motionHabits: '人工记录的步态', negativeContinuity: '人工禁改项',
  appearance: '人工设定外观', assetIds: ['asset-阿莲参考图'],
  nsfwProfile: { fullBody: '用户已有资料' },
};
const explicitEmptyCharacterRefresh = refreshReanalyzedCharacterFields(
  [preservedCharacterRefreshInput],
  [{ name: '阿莲', signatureProps: '  ', anchor: '', motionHabits: '  ' }],
)[0];
assert.equal(explicitEmptyCharacterRefresh?.signatureProps, '', 'an explicitly empty stable-prop classification clears the old value');
assert.equal(explicitEmptyCharacterRefresh?.anchor, preservedCharacterRefreshInput.anchor, 'blank non-prop fields do not erase manual continuity prose');
assert.equal(explicitEmptyCharacterRefresh?.motionHabits, preservedCharacterRefreshInput.motionHabits, 'blank non-prop whitespace is not a deletion');
assert.equal(explicitEmptyCharacterRefresh?.outfit, preservedCharacterRefreshInput.outfit, 'reanalyzing props does not overwrite wardrobe');
assert.equal(explicitEmptyCharacterRefresh?.nsfwProfile, preservedCharacterRefreshInput.nsfwProfile, 'unrelated private-profile data is preserved');
assert.equal(preservedCharacterRefreshInput.signatureProps, '腰间储物袋', 'the refresh must not mutate the previous project or undo snapshot');
assert.notEqual(explicitEmptyCharacterRefresh?.assetIds, preservedCharacterRefreshInput.assetIds, 'refreshed asset links use a separate array');
for (const partialRecord of [
  { name: '阿莲' },
  { name: '阿莲', signatureProps: undefined },
  { name: '阿莲', signatureProps: null },
  { name: '阿莲', signatureProps: [] },
]) {
  const partialCharacterRefresh = refreshReanalyzedCharacterFields([preservedCharacterRefreshInput], [partialRecord])[0];
  assert.equal(partialCharacterRefresh?.signatureProps, '腰间储物袋', 'omitted or malformed stable-prop data cannot silently clear legitimate equipment');
}
const partialLatestStageRefresh = refreshReanalyzedCharacterFields(
  [preservedCharacterRefreshInput],
  [
    { name: '阿莲', signatureProps: '全文分析确认的铜铃', anchor: '全文分析确认的锚点' },
    { name: '阿莲', appearance: '完整剧情确认的最新外貌' },
  ],
)[0];
assert.equal(partialLatestStageRefresh?.signatureProps, '全文分析确认的铜铃', 'same-run enrichment omissions do not negate explicit full-source analysis decisions');
assert.equal(partialLatestStageRefresh?.anchor, '全文分析确认的锚点', 'latest explicit fields come from this successful run, not stale data from a prior operation');
assert.equal(partialLatestStageRefresh?.appearance, '完整剧情确认的最新外貌', 'explicit usable fields of the latest stage still refresh normally');
const clearedPropSurvivesPartialEnrichment = refreshReanalyzedCharacterFields(
  [{ ...preservedCharacterRefreshInput, signatureProps: '始终手端一碗莲藕' }],
  [
    { name: '阿莲', signatureProps: '' },
    { name: '阿莲', appearance: '完整剧情确认的最新外貌' },
  ],
)[0];
assert.equal(clearedPropSurvivesPartialEnrichment?.signatureProps, '', 'an analysis no-prop correction must not restore the old lotus bowl when enrichment omits that field');
assert.equal(clearedPropSurvivesPartialEnrichment?.id, preservedCharacterRefreshInput.id, 'same-run field merging preserves character identity');
assert.deepEqual(Array.from(clearedPropSurvivesPartialEnrichment?.assetIds as string[]), preservedCharacterRefreshInput.assetIds,
  'same-run field merging preserves linked reference assets');
assert.equal(clearedPropSurvivesPartialEnrichment?.outfit, preservedCharacterRefreshInput.outfit,
  'same-run field merging leaves unrelated user-authored wardrobe untouched');
const latestEmptyStageRefresh = refreshReanalyzedCharacterFields(
  [preservedCharacterRefreshInput],
  [
    { name: '阿莲', signatureProps: '第一阶段旧碟子' },
    { name: '阿莲', signatureProps: '' },
  ],
)[0];
assert.equal(latestEmptyStageRefresh?.signatureProps, '', 'a later explicit no-prop classification takes precedence over the earlier stage');
const variantRefresh = refreshReanalyzedCharacterFields(
  [
    { ...preservedCharacterRefreshInput, id: 'taro-original', name: '泰罗·原始形态', signatureProps: '原始形态装备' },
    { ...preservedCharacterRefreshInput, id: 'taro-female', name: '泰罗（女性形态）', signatureProps: '女性形态旧碟子' },
    { ...preservedCharacterRefreshInput, id: 'ordinary-dotted', name: '哈利·波特', signatureProps: '魔杖' },
    { ...preservedCharacterRefreshInput, id: 'unnamed-first-person', name: DEFAULT_FIRST_PERSON_SUBJECT, signatureProps: '临时碗' },
  ],
  [
    { name: '泰罗', originalName: '泰罗', genderForm: '女性形态', signatureProps: '女性形态稳定装备' },
    { name: '泰罗', signatureProps: '不属于具体形态的装备' },
    { name: '哈利', signatureProps: '' },
    { name: '我', signatureProps: '' },
  ],
);
assert.equal(variantRefresh[0]?.signatureProps, '原始形态装备', 'updating one explicit form must not alter the original form');
assert.equal(variantRefresh[1]?.signatureProps, '女性形态稳定装备', 'legacy bracket names and model form aliases share the canonical form identity');
assert.equal(variantRefresh[1]?.id, 'taro-female', 'form aliases keep the existing form id');
assert.equal(variantRefresh[2]?.signatureProps, '魔杖', 'a middle dot in an ordinary name is not a transformation separator');
assert.equal(variantRefresh[3]?.signatureProps, '', 'legacy first-person aliases target the canonical unnamed protagonist');
assert.match(
  storyCharacterRefreshSource,
  /"signatureProps"[\s\S]*"anchor"[\s\S]*"motionHabits"[\s\S]*"negativeContinuity"[\s\S]*"appearance"/u,
  'a successful full-story rerun must refresh the polluted stable-prop field and only the targeted continuity slice',
);
assert.match(
  storyCharacterRefreshSource,
  /field !== "signatureProps" && !value\.trim\(\)/u,
  'an empty AI signatureProps result must clear the legacy value while blank non-prop enrichment remains non-destructive',
);
assert.match(
  storyCharacterRefreshSource,
  /assetIds:\s*\[\.\.\.character\.assetIds\]/u,
  'character reclassification must clone and preserve every existing asset link',
);
assert.match(
  storyAnalysisSource,
  /const nextCharacters = storyEnrichmentError\s*\?\s*reconciledCharacters\s*:/u,
  'failed enrichment must retain the pre-existing character dossier instead of applying a partial repair',
);
assert.match(
  storyAnalysisSource,
  /refreshReanalyzedCharacterFields\(\s*reconciledCharacters/u,
  'the normal explicit full-story reanalysis must apply the targeted legacy character repair after conservative reconciliation',
);
assert.doesNotMatch(
  storyAnalysisSource,
  /signatureProps:\s*typeof record\.signatureProps === "string"[\s\S]*\? record\.signatureProps[\s\S]*: ""/u,
  'a missing signatureProps field must not be synthesized as an intentional empty classification',
);
assert.match(
  storyAnalysisSource,
  /if\s*\(busy\s*\|\|\s*storyExpansionAbortRef\.current\s*\|\|\s*storyAnalysisAbortRef\.current\)\s*return/u,
  'a new analysis cannot overlap an existing analysis, expansion or busy operation',
);
assert.ok(
  (storyAnalysisSource.match(/requestController\.signal/gu) || []).length >= 2,
  'story analysis and story-bible enrichment must share the caller-owned abort signal',
);
assert.match(
  storyAnalysisSource,
  /if\s*\(isAbortError\(error\)\s*\|\|\s*!isAnalysisCurrent\(\)\)\s*return;/u,
  'cancelled or superseded analysis/enrichment cannot display a stale failure notice or continue to commit',
);
assert.match(storyAnalysisSource, /const sourceStory = storyInput;/u,
  'analysis must give the complete current draft to AI without local preprocessing');
assert.doesNotMatch(storyAnalysisSource,
  /\b(?:splitIntoScenes|analyzeTextLocally|mergeAuthoritativeStorySceneBlocks|runIndependentStoryAnalysisEnrichment|persistPrimarySourceDocument|resolveSourceIntegrityForAction)\s*\(/u,
  'the full-source AI analysis path must not create local scene/entity candidates, fallback content or an early source write');
assert.match(storyAnalysisSource, /if\s*\(!useApi\)\s*\{[\s\S]*?setView\("settings"\);\s*return;/u,
  'missing text API configuration must stop analysis instead of silently running a local replacement');
assert.equal((storyAnalysisSource.match(/\brequestStoryAnalysis\s*\(/gu) || []).length, 1,
  'analysis uses one full-source service call instead of a local chunk loop');
assert.match(storyAnalysisSource,
  /requestStoryAnalysis\(\s*analysisState\.settings\.textApi,\s*sourceStory,\s*requestController\.signal,?\s*\)/u);
assert.match(storyAnalysisSource, /const blocks = analysisResponse\.scenes\.map\(/u,
  'only a successful AI scene list may define the new scene content and ordering');
assert.match(storyAnalysisSource,
  /const noLocalCandidates = \{ characters: \[\], locations: \[\], props: \[\] \}/u,
  'entity reconciliation may read AI output but must not nominate local fallback names');
assert.match(storyAnalysisSource, /requestController\.signal,\s*\{ fullSourceContext: true \}/u,
  'follow-up character/location/prop completion must retain the same whole source and cancellation scope');
const firstAnalysisRequest = storyAnalysisSource.indexOf('await requestStoryAnalysis(');
const atomicAnalysisCommit = storyAnalysisSource.indexOf('setState((current) => applyProjectUpdateForRequest(');
assert.ok(firstAnalysisRequest >= 0 && atomicAnalysisCommit > firstAnalysisRequest);
assert.doesNotMatch(storyAnalysisSource.slice(0, firstAnalysisRequest), /\b(?:setState|setStoryInput|setStoryName|persistPrimarySourceDocument)\s*\(/u,
  'source invalidation is staged without modifying the original project before AI succeeds');
assert.equal((storyAnalysisSource.match(/\bsetState\s*\(/gu) || []).length, 1,
  'all source, entity and scene changes are published in one guarded project commit');
assert.match(storyAnalysisSource.slice(0, atomicAnalysisCommit),
  /if\s*\(!isAnalysisCurrent\(\)\)\s*return;\s*if\s*\(relevantProjectState\(stateRef\.current\.project\) !== originalProjectSignature\)\s*\{[\s\S]*?return;/u,
  'the final commit must reject source/API/project changes and intervening user edits to project records');
for (const requiredGuard of [
  '!requestController.signal.aborted', 'requestOperation === storyAnalysisOperationRef.current',
  'requestEpoch === workspaceEpochRef.current', 'stateRef.current.project.id === requestProjectId',
  'storyDraftRef.current.storyInput === sourceStory', 'storyDraftRef.current.storyName === sourceStoryName',
  'requestApiFingerprint',
]) assert.ok(storyAnalysisSource.includes(requiredGuard), `analysis currentness must retain ${requiredGuard}`);
const analysisFailureTail = storyAnalysisSource.slice(storyAnalysisSource.lastIndexOf('} catch (error) {'));
assert.match(analysisFailureTail, /reportRuntimeError\("story-analysis", error\)/u);
assert.match(analysisFailureTail, /原项目未改动/u);
assert.doesNotMatch(analysisFailureTail, /\b(?:setState|setStoryInput|setStoryName|persistPrimarySourceDocument)\s*\(/u,
  'a rejected AI response or request cannot write guessed scenes or replace the previous source');
assert.match(
  storyAnalysisSource,
  /storyAnalysisOperationRef\.current === requestOperation[\s\S]*setBusy\(false\)/u,
  'a superseded story analysis must not clear the busy state owned by its replacement',
);
assert.match(
  appSource,
  /isCurrentOperationIdentity\(\s*requestIdentity,\s*storyboardGenerationIdentityRef\.current,?\s*\)/u,
  'storyboard generation must discard results when its director inputs change',
);
assert.match(
  appSource,
  /isSequenceSegmentComplete\(\s*liveSegment/u,
  'batch generation must verify the actual linked storyboard before skipping a segment',
);
assert.match(
  appSource,
  /failureReason/u,
  'sequence generation must persist an actionable failure reason',
);
assert.match(
  appSource,
  /masterPromptDirectorSettingsFingerprint/u,
  'sequence planning must persist a director-settings snapshot with the authoritative master prompt',
);
for (const [start, end] of [
  ['const generateSemanticSequencePlan =', 'const generateSequenceMasterPrompt ='],
  ['const generateSequenceMasterPrompt =', 'const updateSequenceMasterPrompt ='],
]) {
  const generationSource = appSource.slice(appSource.indexOf(start), appSource.indexOf(end));
  assert.match(generationSource, /if\s*\(!directorSettingsConfirmed\)\s*\{[\s\S]*?notify\(directorSettingsConfirmationIssue,[\s\S]*?return;/u,
    `${start} must refuse to run before the director parameters are explicitly confirmed`);
}
assert.match(
  appSource,
  /确认导演参数/u,
  'the sequence planning UI must expose an explicit director-parameter confirmation action',
);
assert.match(
  appSource,
  /重试本段/u,
  'the sequence UI must expose a retry action for an individual segment',
);
assert.match(
  appSource,
  /rebuildStoryboard\(next,\s*next\.shots,\s*current\)/u,
  'functional storyboard updates must rebuild from the reducer current state',
);
assert.match(
  appSource,
  /filterStoryboardReferenceAssets\(\s*state\.project\.assets\s*,?\s*\)/u,
  'the storyboard editor must use the uncapped reference selector',
);
const promptDirectorReferenceSelector = readFileSync(new URL('../src/components/StoryboardImageToImagePanel.tsx', import.meta.url), 'utf8');
assert.match(
  promptDirectorReferenceSelector,
  /assets\.filter\(isUsableStoryboardReferenceAsset\)/u,
  'the independent storyboard image picker uses readable ordinary references, with private image routing unchanged',
);
assert.doesNotMatch(
  promptDirectorReferenceSelector,
  /directorWorkflow|asset\.role\s*===\s*"grid"/u,
  'the active prompt director must not inherit a retired grid-only reference filter',
);
assert.doesNotMatch(
  promptDirectorReferenceSelector,
  /globalReferenceAssetIds|setDirectorInputMode|selectedAssetIds|requestTextModel|requestVisionAnalysis/u,
  'image selections must never enter video/H3 state or require a text/vision request',
);
const imageWorkbenchReferenceSelector = appSource.slice(
  appSource.indexOf('const selectableReferenceAssets ='),
  appSource.indexOf('const selectedReferenceAsset ='),
);
assert.match(imageWorkbenchReferenceSelector, /privateVariantSelected[\s\S]*isMatchingNsfwPrivateWorkbenchReference\(/u,
  'retiring grid creation does not loosen the dedicated private-image reference scope');
assert.match(imageWorkbenchReferenceSelector, /:\s*filterStoryboardReferenceAssets\(state\.project\.assets\)/u,
  'ordinary image creation uses its existing storyboard reference filter for every active asset kind');
assert.doesNotMatch(imageWorkbenchReferenceSelector, /usableGridAssets|assetKind\s*===\s*"grid"/u,
  'ordinary image creation cannot restore a retired grid-only selection branch');
assert.doesNotMatch(
  appSource,
  /const toggleAsset =|const uploadDirectorLocalReference =|onClick=\{startReferenceOnly\}|className="source-mode-card input-mode-card"/u,
  'the retired shared video-prompt image picker and input-mode controls must not remain accessible',
);
assert.match(appSource, /<StoryboardDirectImageTools ctx=\{ctx\} storyboard=\{directorResultStoryboard\}/u);
assert.match(appSource, /<StoryboardDirectImageTools ctx=\{ctx\} storyboard=\{selectedStoryboard\}/u);
assert.match(appSource, /normalizeGridDirectorInputMode\(\s*preflightWorkflow,\s*"text",?\s*\)/u,
  'new video-prompt generation cannot inherit the retired hidden reference input mode');
assert.match(
  appSource,
  /\.filter\(\(\{ asset \}\) => !hasUsableStoryboardReferencePixels\(asset\)\)/u,
  'storyboard image preflight must accept every manually selected readable image asset',
);
assert.match(
  appSource,
  /normalizePresetImportRoot\(source\)/u,
  'preset import must normalize the app export envelope',
);
assert.match(
  appSource,
  /const importedRules = arrays\(\s*"ruleSets",\s*"rules"/u,
  'preset import must accept the common direct rules alias',
);
const presetImportSource = appSource.slice(
  appSource.indexOf('const importPresets ='),
  appSource.indexOf('const setDefault ='),
);
assert.match(
  presetImportSource,
  /normalizeImportedRulePreset\(\s*item,\s*index,\s*stamp,\s*createId\("ruleset"\),?\s*\)/u,
  'the actual preset importer must preserve an exported rule mode through the shared normalizer',
);
assert.match(
  presetImportSource,
  /normalizeImportedConverterPreset\(\s*item,\s*index,\s*stamp,\s*createId\("converter"\),?\s*\)/u,
  'the actual preset importer must preserve exported workflow, inputMode, and scope fields',
);
assert.match(
  presetImportSource,
  /mergeImportedApiSettings\(\s*current\.settings,\s*\{[\s\S]*textApi:\s*importedTextApi,[\s\S]*visionApi:\s*importedVisionApi,[\s\S]*imageApi:\s*importedImageApi,[\s\S]*\},\s*stamp,?\s*\)/u,
  'the actual MoRan importer must synchronize imported API values into active saved profiles',
);
assert.match(
  presetImportSource,
  /canImportPresetPayload\(\s*fromMoRan,\s*\{[\s\S]*ruleSets:\s*importedRules,[\s\S]*converterPresets:\s*importedConverters,[\s\S]*stylePresets:\s*importedStyles,[\s\S]*textApi:\s*importedTextApi,[\s\S]*visionApi:\s*importedVisionApi,[\s\S]*imageApi:\s*importedImageApi/u,
  'the actual importer must validate zero-preset MoRan API payloads after resolving their API objects',
);
const dashboardSource = appSource.slice(
  appSource.indexOf('function DashboardView'),
  appSource.indexOf('function StoryView'),
);
assert.match(dashboardSource, /chooseScene\(scene\.id\)/u);
assert.doesNotMatch(
  dashboardSource,
  /setActiveSceneId\(scene\.id\)/u,
  'dashboard scene navigation must not bypass shared director selection state',
);
const directorSource = appSource.slice(
  appSource.indexOf('function DirectorView'),
  appSource.indexOf('function StoryboardView'),
);
assert.ok(
  (directorSource.match(/getCurrentStoryboardOperationIdentity\(\)/gu) || []).length >= 2,
  'polish and translation must validate against the root workspace identity',
);
assert.doesNotMatch(
  directorSource,
  /const storyboardOperationRef = useRef/u,
  'a request guard inside an unmounted director view can freeze on the old project',
);

assert.equal(
  typeof regressionEffects.deriveSceneSelection,
  'function',
  'scene selection must have one shared derivation path',
);
assert.deepEqual(
  regressionEffects.deriveSceneSelection('scene-b', [
    { id: 'board-a', sceneId: 'scene-a' },
    { id: 'board-b', sceneId: 'scene-b' },
  ]),
  {
    activeSceneId: 'scene-b',
    selectedDirectorSceneIds: ['scene-b'],
    activeStoryboardId: 'board-b',
  },
);

const boards = [
  { id: 'stuck', shots: [{}], finalPrompt: '' },
  { id: 'ready', shots: [{}], finalPrompt: 'already rebuilt' },
  { id: 'empty', shots: [], finalPrompt: '' },
];
const attempted = new Set<string>();

assert.deepEqual(pendingPromptMigrationIds(boards, attempted), ['stuck']);
attempted.add('stuck');
assert.deepEqual(
  pendingPromptMigrationIds(boards, attempted),
  [],
  'a storyboard whose rebuild produced no prompt must not be retried forever',
);

const notices: Array<{ text: string; tone?: 'error' }> = [];
assert.equal(
  await createRestorePointWithNotice(
    async () => {
      throw new Error('disk full');
    },
    '{"state":true}',
    (notice) => notices.push(notice),
  ),
  false,
);
assert.deepEqual(notices, [{ text: '创建恢复点失败：disk full', tone: 'error' }]);

notices.length = 0;
assert.equal(
  await createRestorePointWithNotice(
    async () => ({ ok: true }),
    '{"state":true}',
    (notice) => notices.push(notice),
  ),
  true,
);
assert.deepEqual(notices, [{ text: '恢复点已创建。' }]);

notices.length = 0;
assert.equal(
  await createRestorePointWithNotice(undefined, '{}', (notice) => notices.push(notice)),
  false,
);
assert.deepEqual(notices, []);

const sequencePlanFixture: VideoSequencePlan = {
  id: 'plan-long-story',
  title: '门后怪兽全片计划',
  sourceStoryTitle: '门后怪兽',
  sourceStoryContent: '他推开门。怪兽从梁上扑下。',
  durationMode: 'fixed',
  requestedTotalDurationSec: 24,
  totalDurationSec: 24,
  segmentDurationSec: 8,
  segmentationMode: 'fixed',
  fitStatus: 'balanced',
  createdAt: 1,
  updatedAt: 2,
  segments: [
    {
      id: 'segment-3',
      index: 3,
      title: '逃离',
      globalStartSec: 16,
      globalEndSec: 24,
      durationSec: 8,
      content: '他逃出门外。',
      summary: '逃离',
      sourceSceneIds: [],
      sourceBeatIds: ['beat-3'],
      narrativePurpose: '收束',
      entryState: '怪兽逼近',
      exitState: '主角脱险',
      transitionHint: '动作接力',
      status: 'generating',
    },
    {
      id: 'segment-1',
      index: 1,
      title: '开门',
      globalStartSec: 0,
      globalEndSec: 8,
      durationSec: 8,
      content: '他推开门。',
      summary: '进入',
      sourceSceneIds: [],
      sourceBeatIds: ['beat-1'],
      narrativePurpose: '建立',
      entryState: '门外静止',
      exitState: '门已开启',
      transitionHint: '硬切',
      storyboardId: 'board-1',
      status: 'ready',
    },
    {
      id: 'segment-4',
      index: 4,
      title: '锁定段',
      globalStartSec: 24,
      globalEndSec: 32,
      durationSec: 8,
      content: '锁定内容。',
      summary: '锁定',
      sourceSceneIds: [],
      sourceBeatIds: ['beat-4'],
      narrativePurpose: '补充',
      entryState: '静止',
      exitState: '静止',
      transitionHint: '无',
      status: 'failed',
      locked: true,
    },
    {
      id: 'segment-2',
      index: 2,
      title: '怪兽突袭',
      globalStartSec: 8,
      globalEndSec: 16,
      durationSec: 8,
      content: '怪兽从梁上扑下。',
      summary: '突袭',
      sourceSceneIds: [],
      sourceBeatIds: ['beat-2'],
      narrativePurpose: '冲突',
      entryState: '门已开启',
      exitState: '怪兽逼近',
      transitionHint: '视线接力',
      status: 'stale',
    },
  ],
};
const sequenceFixtureSnapshot = JSON.stringify(sequencePlanFixture);

const segmentedMasterPlan: VideoSequencePlan = {
  ...sequencePlanFixture,
  masterStoryboardId: 'master-board-before-edit',
  planningStage: 'segmented',
  masterPromptConfirmedFingerprint: 'confirmed-master-before-edit',
  masterPromptConfirmedAt: 80,
  reviewConfirmedFingerprint: 'confirmed-segments-before-edit',
  compressedRiskAcknowledgedFingerprint: 'acknowledged-before-edit',
  reviewConfirmedAt: 81,
  segmentOrderOverridden: true,
};
const segmentedMasterBoards = [
  {
    id: 'master-board-before-edit',
    sequencePlanId: segmentedMasterPlan.id,
    finalPrompt: '旧总提示词',
  },
  {
    id: 'board-1',
    sequencePlanId: segmentedMasterPlan.id,
    segmentId: 'segment-1',
    finalPrompt: '旧第1段结果',
  },
  {
    id: 'orphaned-old-segment-board',
    sequencePlanId: segmentedMasterPlan.id,
    segmentId: 'segment-no-longer-listed',
    finalPrompt: '旧孤儿分段结果也不能复用',
  },
  {
    id: 'other-plan-board',
    sequencePlanId: 'another-plan',
    segmentId: 'segment-1',
    finalPrompt: '其他计划结果必须保留',
  },
];
const segmentedMasterPlanSnapshot = JSON.stringify(segmentedMasterPlan);
const segmentedMasterBoardsSnapshot = JSON.stringify(segmentedMasterBoards);

assert.equal(
  typeof regressionEffects.invalidateSequenceSegmentsForMasterPrompt,
  'function',
  'editing or regenerating an authoritative master prompt needs one pure derived-state invalidation helper',
);
const invalidatedMasterState = regressionEffects.invalidateSequenceSegmentsForMasterPrompt(
  segmentedMasterPlan,
  segmentedMasterBoards,
  90,
);
assert.equal(invalidatedMasterState.plan.planningStage, 'master-draft');
assert.deepEqual(
  invalidatedMasterState.invalidatedSegmentIds,
  segmentedMasterPlan.segments.map((segment) => segment.id),
  'every old segment must be invalidated, regardless of its previous generation status',
);
assert.deepEqual(invalidatedMasterState.plan.segments, []);
assert.equal(invalidatedMasterState.plan.masterPromptConfirmedFingerprint, undefined);
assert.equal(invalidatedMasterState.plan.masterPromptConfirmedAt, undefined);
assert.equal(invalidatedMasterState.plan.reviewConfirmedFingerprint, undefined);
assert.equal(invalidatedMasterState.plan.compressedRiskAcknowledgedFingerprint, undefined);
assert.equal(invalidatedMasterState.plan.reviewConfirmedAt, undefined);
assert.equal(invalidatedMasterState.plan.segmentOrderOverridden, undefined);
assert.deepEqual(
  invalidatedMasterState.storyboards.map((board) => board.id),
  ['master-board-before-edit', 'other-plan-board'],
  'all old derived boards for this plan must be discarded while the master board and other plans remain',
);
assert.deepEqual(
  invalidatedMasterState.invalidatedStoryboardIds,
  ['board-1', 'orphaned-old-segment-board'],
  'callers need exact invalidated board IDs to remove dangling scene links',
);
assert.equal(invalidatedMasterState.plan.updatedAt, 90);
assert.equal(JSON.stringify(segmentedMasterPlan), segmentedMasterPlanSnapshot);
assert.equal(JSON.stringify(segmentedMasterBoards), segmentedMasterBoardsSnapshot);

const completedPrompt = '第1段真实结构化提示词';
const completeAiTrace = {
  modelRuleSetId: 'rule',
  converterPresetId: 'converter',
  sourceDocumentIds: [],
  referenceAssetIds: [],
  generatedAt: 1,
  mode: 'text-api' as const,
  convertedPromptFingerprint: sourceContentHash(completedPrompt),
  shotRecommendationMode: 'text-api' as const,
  shotPlanMode: 'ai-complete' as const,
};
const completionBoards = [
  {
    id: 'board-1',
    sequencePlanId: 'plan-long-story',
    segmentId: 'segment-1',
    finalPrompt: completedPrompt,
    promptTrace: completeAiTrace,
  },
];

const sequencePromptActionEffects = regressionEffects as typeof regressionEffects & {
  resolveSequenceSegmentPromptAction?: (
    segment: VideoSegment | undefined,
    storyboards: readonly Storyboard[],
    planId: string,
    context: OfficialH3ProjectContext,
  ) => { action: 'generate-storyboard' | 'refresh-official' | 'translate-english' | 'complete'; storyboard?: Storyboard };
  pendingSequencePromptSegmentIds?: (
    plan: Pick<VideoSequencePlan, 'id' | 'segments'>,
    storyboards: readonly Storyboard[],
    contextForStoryboard: (storyboard: Storyboard) => OfficialH3ProjectContext,
  ) => string[];
  sequenceSegmentPromptStatusLabel?: (
    segment: Pick<VideoSegment, 'status' | 'failureReason'>,
    action: 'generate-storyboard' | 'refresh-official' | 'translate-english' | 'complete',
  ) => string;
};
assert.equal(
  typeof sequencePromptActionEffects.resolveSequenceSegmentPromptAction,
  'function',
  'sequence generation must resolve canonical completion and official H3 freshness together',
);
const newlySelectedSequenceReference: ReferenceAsset = {
  id: 'sequence-reference-new',
  name: '新选择的人物参考图',
  type: 'reference',
  role: 'character',
  mediaType: 'image',
  source: 'upload',
  dataUrl: 'data:image/png;base64,AAAA',
  checksum: 'sha256-sequence-reference-new',
  tags: ['参考图'],
  createdAt: 2,
  updatedAt: 2,
};
const sequenceOfficialContext: OfficialH3ProjectContext = {
  assets: [newlySelectedSequenceReference],
  characters: [],
  locations: [],
  props: [],
  sceneContent: conversionDraft.sourceStoryContent,
};
const sequenceOfficialBaseBoard = applyOfficialH3Prompt(
  {
    ...conversionDraft,
    id: 'board-1',
    sequencePlanId: sequencePlanFixture.id,
    segmentId: 'segment-1',
    globalReferenceAssetIds: [],
    promptTrace: {
      ...completeAiTrace,
      convertedPromptFingerprint: sourceContentHash(conversionDraft.finalPrompt),
    },
  },
  sequenceOfficialContext,
);
const completedSequenceSegment = {
  ...sequencePlanFixture.segments.find((segment) => segment.id === 'segment-1')!,
  status: 'ready' as const,
  storyboardId: sequenceOfficialBaseBoard.id,
};
sequenceOfficialBaseBoard.officialPromptEn = 'integrated_multimodal_description: [Shot 1] A traveler walks toward the gate.\n\noverall_soundscape: Forest wind and clothing movement.\n\nnon_diegetic_music: Sparse soft music below dialogue.';
sequenceOfficialBaseBoard.officialPromptEnSource = sequenceOfficialBaseBoard.officialPromptZh;
assert.deepEqual(
  sequencePromptActionEffects.resolveSequenceSegmentPromptAction?.(
    completedSequenceSegment,
    [sequenceOfficialBaseBoard],
    sequencePlanFixture.id,
    sequenceOfficialContext,
  ),
  { action: 'complete', storyboard: sequenceOfficialBaseBoard },
  'a current official H3 artifact must retain the existing no-op protection',
);
for (const translationPending of [
  { ...sequenceOfficialBaseBoard, officialPromptEn: '', officialPromptEnSource: '', officialPromptEnError: '英文接口暂时不可用' },
  { ...sequenceOfficialBaseBoard, officialPromptEnSource: 'old Chinese' },
]) {
  assert.deepEqual(sequencePromptActionEffects.resolveSequenceSegmentPromptAction?.(
    completedSequenceSegment, [translationPending], sequencePlanFixture.id, sequenceOfficialContext,
  ), { action: 'translate-english', storyboard: translationPending }, 'valid Chinese with missing or stale English must retry translation only');
  assert.equal(regressionEffects.isSequenceSegmentComplete?.(completedSequenceSegment, [translationPending], sequencePlanFixture.id), true,
    'English failure must not invalidate an already converted canonical segment');
}
for (const length of [7001, 7254, 19281, 25000]) {
  const completeLongEnglish: Storyboard = { ...sequenceOfficialBaseBoard, officialPromptEn: sequenceOfficialBaseBoard.officialPromptEn + 'x'.repeat(length - sequenceOfficialBaseBoard.officialPromptEn!.length) };
  assert.deepEqual(sequencePromptActionEffects.resolveSequenceSegmentPromptAction?.(
    completedSequenceSegment, [completeLongEnglish], sequencePlanFixture.id, sequenceOfficialContext,
  ), { action: 'complete', storyboard: completeLongEnglish }, `a current ${length}-character English artifact must not be queued for another translation`);
}
const sequenceBoardAfterReferenceSelection: Storyboard = {
  ...sequenceOfficialBaseBoard,
  globalReferenceAssetIds: [newlySelectedSequenceReference.id],
  updatedAt: 3,
};
assert.deepEqual(
  sequencePromptActionEffects.resolveSequenceSegmentPromptAction?.(
    completedSequenceSegment,
    [sequenceBoardAfterReferenceSelection],
    sequencePlanFixture.id,
    sequenceOfficialContext,
  ),
  { action: 'refresh-official', storyboard: sequenceBoardAfterReferenceSelection },
  'selecting a new reference must refresh only the stale H3 artifact instead of deadlocking on the valid canonical storyboard',
);
assert.deepEqual(
  sequencePromptActionEffects.resolveSequenceSegmentPromptAction?.(
    { ...completedSequenceSegment, storyboardId: 'missing-board' },
    [sequenceBoardAfterReferenceSelection],
    sequencePlanFixture.id,
    sequenceOfficialContext,
  ),
  { action: 'generate-storyboard' },
  'a genuinely missing canonical storyboard must still use the full generation path',
);
assert.equal(
  typeof sequencePromptActionEffects.pendingSequencePromptSegmentIds,
  'function',
  'the batch queue must expose the same canonical-versus-official prompt policy as the current-segment action',
);
const sequencePromptQueuePlan: VideoSequencePlan = {
  ...sequencePlanFixture,
  segments: sequencePlanFixture.segments.map((segment) => (
    segment.id === completedSequenceSegment.id ? completedSequenceSegment : segment
  )),
};
assert.deepEqual(
  sequencePromptActionEffects.pendingSequencePromptSegmentIds?.(
    sequencePromptQueuePlan,
    [sequenceOfficialBaseBoard],
    () => sequenceOfficialContext,
  ),
  ['segment-2', 'segment-3'],
  'the batch queue must skip a canonical board whose official H3 artifact is current',
);
assert.deepEqual(
  sequencePromptActionEffects.pendingSequencePromptSegmentIds?.(
    sequencePromptQueuePlan,
    [sequenceBoardAfterReferenceSelection],
    () => sequenceOfficialContext,
  ),
  ['segment-1', 'segment-2', 'segment-3'],
  'the batch queue must include a completed canonical board after its selected reference makes the official H3 artifact stale',
);
assert.deepEqual(
  sequencePromptActionEffects.pendingSequencePromptSegmentIds?.(
    {
      ...sequencePromptQueuePlan,
      segments: sequencePromptQueuePlan.segments.map((segment) => (
        segment.id === completedSequenceSegment.id ? { ...segment, locked: true } : segment
      )),
    },
    [sequenceBoardAfterReferenceSelection],
    () => sequenceOfficialContext,
  ),
  ['segment-2', 'segment-3'],
  'reference-only refresh must not place locked canonical segments in the batch queue',
);
assert.equal(
  typeof sequencePromptActionEffects.sequenceSegmentPromptStatusLabel,
  'function',
  'the filmstrip and segment editor must share the same prompt-freshness status labels',
);
for (const [segment, action, expected] of [
  [{ status: 'ready' }, 'complete', '已完成'],
  [{ status: 'ready' }, 'refresh-official', '提示词需刷新'],
  [{ status: 'ready' }, 'translate-english', '中文已就绪 · 英文待完成'],
  [{ status: 'ready' }, 'generate-storyboard', '待生成'],
  [{ status: 'ready', failureReason: '结果缺失' }, 'generate-storyboard', '失败'],
  [{ status: 'generating' }, 'generate-storyboard', '生成中'],
  [{ status: 'stale' }, 'generate-storyboard', '需更新'],
  [{ status: 'failed' }, 'generate-storyboard', '失败'],
  [{ status: 'planned' }, 'generate-storyboard', '待生成'],
] as const) {
  assert.equal(
    sequencePromptActionEffects.sequenceSegmentPromptStatusLabel?.(segment, action),
    expected,
    `segment status ${segment.status} and prompt action ${action} must have an accurate visible label`,
  );
}
const sequenceFilmstripSource = appSource.slice(
  appSource.indexOf('function SequenceFilmstrip('),
  appSource.indexOf('function SequencePlannerPanel('),
);
assert.match(sequenceFilmstripSource, /resolveSequenceSegmentPromptAction\(/u);
assert.match(sequenceFilmstripSource, /sequenceSegmentPromptStatusLabel\(/u);
assert.match(
  appSource,
  /activeSequencePromptAction\?\.action === "refresh-official"\s*\? "刷新当前段提示词"/u,
  'the director primary button must tell the user when it refreshes an existing canonical segment',
);
const sequenceRefreshSource = appSource.slice(
  appSource.indexOf('const refreshSequenceSegmentOfficialPrompt ='),
  appSource.indexOf('const generateCurrentSequenceSegment ='),
);
const storyboardGenerationSource = appSource.slice(
  appSource.indexOf('const buildStoryboard ='),
  appSource.indexOf('const refreshSequenceSegmentOfficialPrompt ='),
);
assert.match(storyboardGenerationSource, /await generateSingleSegmentPrompt\(/u, 'short-story generation must actually use the shared single-segment service');
assert.doesNotMatch(storyboardGenerationSource, /convertStoryboardDraftToFinal\(|translateVideoPromptToEnglish\(/u, 'the short caller must not retain a divergent inline conversion/translation path');
assert.doesNotMatch(storyboardGenerationSource, /planningOnly:|maxCharacters:|MINIMAX_H3_PROMPT_CHARACTER_LIMIT/u, 'short stories, long segments and full masters must all omit a local character cap');
const sequenceAdapterSource = readFileSync(new URL('../src/sequenceReferencePrompt.ts', import.meta.url), 'utf8');
assert.match(sequenceAdapterSource, /generateSingleSegmentPrompt\(/u, 'long current-segment refresh must call the identical shared service');
assert.doesNotMatch(sequenceAdapterSource, /sequence_reference_data|sequence_reference_conversion_contract|h3_translation_units|translateH3PromptWithinBudget|applyOfficialH3Prompt\(/u, 'the adapter may scope the evidence, but cannot own a second generation protocol');
assert.match(sequenceRefreshSource, /await regenerateSequenceReferencePrompt\(/u, 'reference refresh must actually call the API regeneration pipeline');
assert.doesNotMatch(sequenceRefreshSource, /applyOfficialH3Prompt\(sourceBoard/u, 'an overlong old local H3 draft must not prevent conversion API execution');
assert.match(sequenceRefreshSource, /sourceContentHash\(JSON\.stringify\(liveBoard\.shots\)\) !== requestShotsIdentity/u, 'a pending refresh must not overwrite a newly locked or edited shot');
assert.match(sequenceRefreshSource, /hasImageInputs: referenceImages\.length > 0/u, 'image presence claims must reflect the real attached pixels');
assert.match(
  sequenceRefreshSource,
  /sequenceStoryboardGenerationIdentity\(\s*current\.project\.id,\s*livePlan\.id,\s*liveSegment,\s*livePlan\.segments\.length/u,
  'an asynchronous official-only refresh must revalidate the segment source identity before committing',
);

assert.equal(
  typeof regressionEffects.pendingSequenceSegmentIds,
  'function',
  'the all-segment queue selector must be implemented as a pure helper',
);
assert.deepEqual(
  regressionEffects.pendingSequenceSegmentIds(sequencePlanFixture, completionBoards),
  ['segment-2', 'segment-3'],
  'the queue must skip only segments with a real linked non-empty storyboard prompt',
);
assert.equal(
  typeof regressionEffects.isSequenceSegmentComplete,
  'function',
  'completion must be determined from a linked storyboard with a non-empty prompt',
);
assert.equal(
  regressionEffects.isSequenceSegmentComplete(
    sequencePlanFixture.segments.find((segment) => segment.id === 'segment-1'),
    completionBoards,
    sequencePlanFixture.id,
  ),
  true,
);
assert.equal(
  regressionEffects.isSequenceSegmentComplete(
    { ...sequencePlanFixture.segments[0], status: 'ready', storyboardId: 'missing-board' },
    completionBoards,
    sequencePlanFixture.id,
  ),
  false,
  'a ready segment with a missing storyboard must be retried',
);
const legacyCountOnlyCompletionBoard = {
  ...completionBoards[0],
  id: 'legacy-count-only-board',
  promptTrace: {
    ...completeAiTrace,
    shotPlanMode: undefined,
  },
};
assert.equal(
  regressionEffects.isSequenceSegmentComplete(
    {
      ...sequencePlanFixture.segments[0],
      status: 'ready',
      storyboardId: legacyCountOnlyCompletionBoard.id,
    },
    [legacyCountOnlyCompletionBoard],
    sequencePlanFixture.id,
  ),
  false,
  'a legacy count-only text-api result must be retried because its per-shot plan was local',
);
assert.deepEqual(
  regressionEffects.pendingSequenceSegmentIds(
    {
      ...sequencePlanFixture,
      segments: [{
        ...sequencePlanFixture.segments.find((segment) => segment.id === 'segment-1')!,
        status: 'ready',
        storyboardId: legacyCountOnlyCompletionBoard.id,
      }],
    },
    [legacyCountOnlyCompletionBoard],
  ),
  ['segment-1'],
  'legacy count-only results must return to the AI generation queue',
);
assert.equal(
  typeof regressionEffects.repairSequencePlanResults,
  'function',
  'startup normalization must repair orphaned and interrupted segment results',
);
const repairedPlan = regressionEffects.repairSequencePlanResults(
  {
    ...sequencePlanFixture,
    segments: sequencePlanFixture.segments.map((segment): VideoSegment => (
      segment.id === 'segment-1'
        ? { ...segment, status: 'ready', storyboardId: 'missing-board' }
        : segment.id === 'segment-3'
          ? { ...segment, status: 'generating' }
          : segment
    )),
  },
  completionBoards,
);
const repairedSegment1 = repairedPlan.segments.find((segment) => segment.id === 'segment-1');
const repairedSegment3 = repairedPlan.segments.find((segment) => segment.id === 'segment-3');
assert.equal(repairedSegment1?.status, 'planned');
assert.equal(repairedSegment1?.storyboardId, undefined);
assert.match(repairedSegment1?.failureReason || '', /结果缺失|重新生成/u);
assert.equal(repairedSegment3?.status, 'failed');
assert.match(repairedSegment3?.failureReason || '', /中断|重试/u);

const staleFailureReason = '源剧情已调整，本段分镜需要更新。';
const repairedStalePlan = regressionEffects.repairSequencePlanResults(
  {
    ...sequencePlanFixture,
    segments: sequencePlanFixture.segments.map((segment): VideoSegment => (
      segment.id === 'segment-2'
        ? {
            ...segment,
            status: 'stale',
            storyboardId: 'missing-stale-board',
            failureReason: staleFailureReason,
          }
        : segment
    )),
  },
  completionBoards,
);
const repairedStaleSegment = repairedStalePlan.segments.find(
  (segment) => segment.id === 'segment-2',
);
assert.equal(
  repairedStaleSegment?.status,
  'stale',
  'a stale segment with a missing linked result must remain visibly stale instead of becoming planned',
);
assert.equal(repairedStaleSegment?.storyboardId, undefined);
assert.equal(
  repairedStaleSegment?.failureReason,
  staleFailureReason,
  'repairing a stale orphan must preserve its actionable update reason',
);
assert.equal(
  JSON.stringify(sequencePlanFixture),
  sequenceFixtureSnapshot,
  'building a generation queue must not reorder or mutate the stored plan',
);

const staleAlignedManifest = regressionEffects.buildSequencePromptManifest(
  {
    ...sequencePlanFixture,
    segments: sequencePlanFixture.segments.map((segment): VideoSegment => (
      segment.id === 'segment-1' ? { ...segment, status: 'stale' } : segment
    )),
  },
  completionBoards,
);
assert.equal(
  staleAlignedManifest.segments[0].promptStatus,
  'pending',
  'a stale board from before automatic boundary alignment must not export as ready',
);
assert.equal(staleAlignedManifest.segments[0].finalPrompt, '');

assert.equal(
  typeof regressionEffects.upsertSequencePlan,
  'function',
  'completed sequence plans must be upserted through one deterministic helper',
);
const planA = { ...sequencePlanFixture, id: 'plan-a', title: '旧计划 A' };
const planB = { ...sequencePlanFixture, id: 'plan-b', title: '已有计划 B' };
const planBefore = { ...sequencePlanFixture, id: 'plan-before', title: '前置计划' };
const planAfter = { ...sequencePlanFixture, id: 'plan-after', title: '后置计划' };
const refreshedPlanA = { ...planA, title: '重新完成的计划 A' };
const noActivePlanResult = regressionEffects.upsertSequencePlan(
  [planBefore, planA, { ...planA }, planAfter],
  refreshedPlanA,
);
assert.deepEqual(
  noActivePlanResult.map((plan) => plan.id),
  ['plan-before', 'plan-a', 'plan-after'],
  'an empty active-plan replacement must update the existing completed ID without inserting duplicates',
);
assert.strictEqual(
  noActivePlanResult[1],
  refreshedPlanA,
  'same-ID refresh must keep the first existing position and use the completed object',
);

const aiPlanWithExistingTargetId = { ...planB, title: 'AI 新计划 B' };
const aiReplacementResult = regressionEffects.upsertSequencePlan(
  [planBefore, planA, planAfter, planB],
  aiPlanWithExistingTargetId,
  planA.id,
);
assert.deepEqual(
  aiReplacementResult.map((plan) => plan.id),
  ['plan-before', 'plan-b', 'plan-after'],
  'an AI plan with a new ID must replace A in place and remove the pre-existing B ID',
);
assert.strictEqual(aiReplacementResult[1], aiPlanWithExistingTargetId);
assert.equal(
  aiReplacementResult.filter((plan) => plan.id === aiPlanWithExistingTargetId.id).length,
  1,
  'the completed plan ID must occur exactly once',
);

assert.equal(
  typeof regressionEffects.isCurrentSequenceOperation,
  'function',
  'serial generation cancellation must compare a complete operation identity',
);
const sequenceOperation = {
  epoch: 7,
  projectId: 'project-a',
  planId: 'plan-long-story',
  sourceSnapshot: '他推开门。怪兽从梁上扑下。',
  planSnapshot: 'review-fingerprint-with-locks',
  configurationSnapshot: 'director-config-a',
};
assert.equal(
  regressionEffects.isCurrentSequenceOperation(sequenceOperation, { ...sequenceOperation }),
  true,
);
assert.equal(
  regressionEffects.isCurrentSequenceOperation(sequenceOperation, {
    ...sequenceOperation,
    epoch: 8,
  }),
  false,
  'incrementing the cancellation epoch must stop the old queue',
);
assert.equal(
  regressionEffects.isCurrentSequenceOperation(sequenceOperation, {
    ...sequenceOperation,
    planId: 'plan-new',
  }),
  false,
  'switching plans must stop the old queue',
);
assert.equal(
  regressionEffects.isCurrentSequenceOperation(sequenceOperation, {
    ...sequenceOperation,
    sourceSnapshot: '用户修改后的剧情',
  }),
  false,
  'changing the plan source must stop the old queue',
);
assert.equal(
  regressionEffects.isCurrentSequenceOperation(sequenceOperation, {
    ...sequenceOperation,
    planSnapshot: 'edited-future-segment',
  }),
  false,
  'editing or locking any segment must stop the old queue',
);
assert.equal(
  regressionEffects.isCurrentSequenceOperation(sequenceOperation, {
    ...sequenceOperation,
    configurationSnapshot: 'director-config-b',
  }),
  false,
  'changing director settings must stop the old queue',
);

assert.equal(
  typeof regressionEffects.buildSequencePromptManifest,
  'function',
  'ordered sequence JSON export must be implemented as a pure helper',
);
const sequenceBoards = [
  { id: 'orphan-board', finalPrompt: '不应进入清单' },
  { ...completionBoards[0], finalPrompt: '第1段最终提示词' },
];
const sequenceManifest = regressionEffects.buildSequencePromptManifest(
  sequencePlanFixture,
  sequenceBoards,
);
assert.equal(sequenceManifest.format, 'lianhua-sequence-prompts/v1');
assert.deepEqual(
  sequenceManifest.segments.map((segment) => segment.segmentId),
  ['segment-1', 'segment-2', 'segment-3', 'segment-4'],
  'manifest segments must be deterministic and ordered by segment index',
);
assert.deepEqual(
  sequenceManifest.segments.map((segment) => segment.planId),
  Array(4).fill('plan-long-story'),
  'every manifest item must retain its owning plan ID',
);
assert.equal(sequenceManifest.segments[0].finalPrompt, '第1段最终提示词');
assert.equal(sequenceManifest.segments[0].promptStatus, 'ready');
assert.equal(sequenceManifest.segments[1].finalPrompt, '');
assert.equal(
  sequenceManifest.segments[1].promptStatus,
  'pending',
  'a segment without a linked board must remain visible and be marked pending',
);

const officialSegmentManifest = regressionEffects.buildSequencePromptManifest(
  sequencePlanFixture,
  [sequenceOfficialBaseBoard],
);
assert.equal(
  officialSegmentManifest.segments[0].finalPrompt,
  sequenceOfficialBaseBoard.officialPromptZh,
  'a current saved official H3 delivery takes priority over the canonical segment source',
);
assert.equal(officialSegmentManifest.segments[0].promptFormat, 'h3');
assert.equal(officialSegmentManifest.segments[0].officialH3Prompt, sequenceOfficialBaseBoard.officialPromptZh);
assert.equal(officialSegmentManifest.segments[0].canonicalPrompt, sequenceOfficialBaseBoard.finalPrompt);

const masterExportPlan = {
  ...sequencePlanFixture,
  masterStoryboardId: 'master-export-board',
};
const masterExportBoard = {
  id: 'master-export-board',
  finalPrompt: '全片总提示词：从起点到结尾的权威时间轴。',
  durationSec: masterExportPlan.totalDurationSec,
  shots: [makeVideoShot({ id: 'master-shot-1' })],
};
const derivedLocalPrompt = '【0s-2s】 编辑后的局部镜头正文；保留确认后的原文。';
const derivedLocalBoard = {
  ...completionBoards[0],
  finalPrompt: '',
  shots: [makeVideoShot({ id: 'local-shot-1', prompt: derivedLocalPrompt })],
};
const masterExportManifest = regressionEffects.buildSequencePromptManifest(
  masterExportPlan,
  [derivedLocalBoard, masterExportBoard],
);
assert.equal(masterExportManifest.plan.masterStoryboardId, 'master-export-board');
assert.equal(masterExportManifest.plan.masterPromptStatus, 'ready');
assert.equal(masterExportManifest.plan.masterPromptFormat, 'canonical-total');
assert.equal(masterExportManifest.plan.masterPromptIsSegmentExecutable, false);
assert.equal(masterExportManifest.plan.masterCanonicalPrompt, masterExportBoard.finalPrompt);
assert.equal(masterExportManifest.plan.masterFinalPrompt, masterExportBoard.finalPrompt);
assert.equal(masterExportManifest.plan.masterShotCount, 1);
assert.equal(
  masterExportManifest.segments[0].finalPrompt,
  derivedLocalPrompt,
  'JSON export must retain derived local prompt text when it is composed from sliced shot prompts',
);
assert.deepEqual(
  masterExportManifest.segments[0].shotPrompts,
  [derivedLocalPrompt],
  'JSON export must expose each derived local shot prompt alongside the master prompt',
);
const malformedMasterBoards = [
  {
    label: 'missing master finalPrompt',
    board: {
      id: 'master-export-board',
      durationSec: masterExportPlan.totalDurationSec,
      shots: [makeVideoShot({ id: 'missing-master-final-prompt-shot' })],
    },
  },
  {
    label: 'non-string master finalPrompt',
    board: {
      ...masterExportBoard,
      finalPrompt: 2026,
    },
  },
] as const;
malformedMasterBoards.forEach(({ label, board }) => {
  const manifest = regressionEffects.buildSequencePromptManifest(
    masterExportPlan,
    [derivedLocalBoard, board] as unknown as Parameters<
      typeof regressionEffects.buildSequencePromptManifest
    >[1],
  );
  assert.equal(
    manifest.plan.masterFinalPrompt,
    '',
    `${label} must fall back to an empty prompt instead of crashing`,
  );
  assert.equal(
    manifest.plan.masterPromptStatus,
    'pending',
    `${label} must remain pending until a valid string prompt exists`,
  );
  assert.equal(
    manifest.plan.masterStoryboardId,
    'master-export-board',
    `${label} must retain the linked master storyboard identity`,
  );
});
const malformedImportShotPrompt = '【0s-3s】 异常导入仍保留的局部镜头提示词。';
const malformedImportedBoards = [
  {
    label: 'missing finalPrompt',
    board: {
      id: completionBoards[0].id,
      sequencePlanId: completionBoards[0].sequencePlanId,
      segmentId: completionBoards[0].segmentId,
      shots: [makeVideoShot({ id: 'missing-final-prompt-shot', prompt: malformedImportShotPrompt })],
    },
  },
  {
    label: 'non-string finalPrompt',
    board: {
      ...completionBoards[0],
      finalPrompt: 2026,
      shots: [makeVideoShot({ id: 'non-string-final-prompt-shot', prompt: malformedImportShotPrompt })],
    },
  },
] as const;
malformedImportedBoards.forEach(({ label, board }) => {
  const manifest = regressionEffects.buildSequencePromptManifest(
    sequencePlanFixture,
    [board] as unknown as Parameters<typeof regressionEffects.buildSequencePromptManifest>[1],
  );
  assert.equal(
    manifest.segments[0].finalPrompt,
    malformedImportShotPrompt,
    `${label} must fall back to the retained shot prompt instead of crashing`,
  );
  assert.equal(
    manifest.segments[0].promptStatus,
    'ready',
    `${label} with a usable shot prompt must remain exportable`,
  );
});
assert.match(
  regressionEffects.buildSequencePromptText(masterExportPlan, [derivedLocalBoard, masterExportBoard]),
  /全片总视频提示词：\s*全片总提示词/u,
  'TXT export must preserve the authoritative master prompt before segment sections',
);
assert.match(
  regressionEffects.buildSequencePromptText(masterExportPlan, [derivedLocalBoard, masterExportBoard]),
  new RegExp(derivedLocalPrompt.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
  'TXT export must retain the derived local prompt text as well as the master prompt',
);

assert.equal(
  typeof regressionEffects.buildSequencePromptText,
  'function',
  'ordered sequence TXT export must be implemented as a pure helper',
);
const sequenceText = regressionEffects.buildSequencePromptText(
  sequencePlanFixture,
  sequenceBoards,
);
assert.ok(
  sequenceText.indexOf('第 1 段：开门') < sequenceText.indexOf('第 2 段：怪兽突袭'),
  'TXT sections must follow segment index order',
);
assert.match(sequenceText, /计划 ID：plan-long-story/u);
assert.match(sequenceText, /视频段 ID：segment-2/u);
assert.match(sequenceText, /全局时间：8–16 秒/u);
assert.match(sequenceText, /本段局部时长：8 秒/u);
assert.match(sequenceText, /入场状态：门已开启/u);
assert.match(sequenceText, /出场状态：怪兽逼近/u);
assert.match(sequenceText, /最终提示词：\n\[待生成\]/u);

console.log('app effect regression checks passed');

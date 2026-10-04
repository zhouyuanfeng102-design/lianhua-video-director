import type {
  SequenceFitStatus,
  SequenceSegmentationMode,
  Storyboard,
  VideoSegment,
  VideoSequencePlan,
} from './types';
import {
  masterTimelineInternalSegmentBoundaries,
  masterPromptConfirmationFingerprint,
  validateMasterTimelineSegmentGrid,
} from './masterTimeline';
import { sourceContentHash } from './sourceIntegrity';
import { assertMasterSegmentDurationContract, assertSequenceSegmentDurationContract } from './sequenceDurationContract';
import { isSemanticSequencePlan, validateSemanticSequencePlan } from './semanticSequencePlan';
import {
  extractSemanticStoryBeats,
  stripDialogueTurns,
} from './semanticEvents';
import type {
  SemanticStoryBeat,
  SemanticStoryBeatExtractionOptions,
  SemanticStoryBeatKind,
} from './semanticEvents';

export {
  extractSemanticStoryBeats,
  normalizeSemanticAction,
  semanticActionsEquivalent,
} from './semanticEvents';
export type {
  SemanticStoryBeat,
  SemanticStoryBeatExtractionOptions,
  SemanticStoryBeatKind,
  SemanticStoryBeatStrategy,
} from './semanticEvents';

export interface StoryBeat {
  id: string;
  index: number;
  text: string;
  /** UTF-16 source range start, inclusive. */
  sourceStart: number;
  /** UTF-16 source range end, exclusive. */
  sourceEnd: number;
  weight: number;
  actionSignature?: string;
  kind: SemanticStoryBeatKind;
}

export interface LocalSequencePlanInput {
  title: string;
  story: string;
  totalDurationSec: number;
  segmentDurationSec: number;
  segmentationMode: SequenceSegmentationMode;
  sourceSceneIds: string[];
}

const TIME_EPSILON = 0.005;
/** Legacy/default video-endpoint ceiling; current user-selected planning
 * windows have a separate numeric contract and may target other backends. */
export const MAX_SEQUENCE_SEGMENT_DURATION_SEC = 15;

const roundToTwo = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** Runtime shape needed when checking the authoritative full-duration board. */
export type SequenceMasterStoryboardCandidate = Pick<
  Storyboard,
  'id' | 'finalPrompt' | 'shots' | 'promptTrace'
> & Partial<Pick<
  Storyboard,
  'sequencePlanId' | 'segmentId' | 'durationSec' | 'sourceStoryContent'
>>;

/** Complete model-authored timelines keep the model's shot boundaries.
 * Timing contract failures must be repaired by AI, never by local splitting. */
export const hasAiAuthoredMasterTimeline = (
  board: SequenceMasterStoryboardCandidate | undefined,
): boolean => Boolean(
  board?.promptTrace?.shotPlanMode === 'ai-complete'
  && Array.isArray(board.shots)
  && board.shots.length > 0
  && board.shots.every((shot) => shot?.authoredBy === 'text-api'),
);

export interface SequencePlanValidationOptions {
  /** Storyboards currently persisted with the active project. */
  storyboards?: readonly SequenceMasterStoryboardCandidate[];
  /** Require a valid authoritative full-duration board in addition to beats/timing. */
  requireMasterStoryboard?: boolean;
  /** Live director-settings fingerprint that confirmed master prompts must still match. */
  directorSettingsFingerprint?: string;
}

/** Metadata-only callers can retain AI shot links; a supplied master must still prove them. */
export const hasAiSequenceShotLinks = (
  plan: Pick<VideoSequencePlan, 'segmentationSource' | 'segments'>,
): boolean => (
  plan.segmentationSource === 'ai'
  && Array.isArray(plan.segments)
  && plan.segments.length > 0
  && plan.segments.every((segment) => (
    Array.isArray(segment.sourceShotIds)
    && segment.sourceShotIds.length > 0
    && segment.sourceShotIds.every((shotId) => typeof shotId === 'string' && Boolean(shotId.trim()))
  ))
);

const MASTER_TIMELINE_EPSILON = 0.05;

const approximatelyMasterEqual = (left: number, right: number): boolean => (
  Math.abs(left - right) <= MASTER_TIMELINE_EPSILON
);

/**
 * Explain why a plan cannot safely reuse its authoritative full timeline.
 * Segment generation must never silently fall back to compiling shortened
 * segment text when this returns a reason.
 */
export const sequencePlanMasterStoryboardIssue = (
  plan: Pick<VideoSequencePlan, 'id' | 'sourceStoryContent' | 'totalDurationSec' | 'segmentDurationSec' | 'masterStoryboardId' | 'planningMode'>,
  storyboards: readonly SequenceMasterStoryboardCandidate[] = [],
): string | undefined => {
  // An explicit semantic plan is sourced directly from the original story.
  // A missing master on a legacy plan is still an error, never an implicit
  // migration into this mode. Its own technical contract is checked below by
  // validateSequencePlan instead of manufacturing a master confirmation.
  if (isSemanticSequencePlan(plan)) return undefined;
  let fixedGridIssue: string | undefined;
  try {
    // Validate the grid dimensions before looking up a board so persisted
    // drafts and confirmations cannot hide a legacy non-multiple duration.
    masterTimelineInternalSegmentBoundaries(
      plan.totalDurationSec,
      plan.segmentDurationSec,
    );
  } catch (error) {
    fixedGridIssue = error instanceof Error
      ? `${error.message} 旧计划必须重新生成。`
      : '固定分段时长网格无效，旧计划必须重新生成。';
  }
  const masterId = typeof plan.masterStoryboardId === 'string'
    ? plan.masterStoryboardId.trim()
    : '';
  if (!masterId) return fixedGridIssue || '全片总视频提示词缺失，请重新分析并生成全片总提示词。';
  const board = storyboards.find((candidate) => candidate.id === masterId);
  if (!board) return `全片总视频提示词对应的总分镜 ${masterId} 不存在，请重新生成全片总提示词。`;
  if (board.sequencePlanId && board.sequencePlanId !== plan.id) {
    return '全片总视频提示词与当前计划不匹配，请重新生成全片总提示词。';
  }
  if (board.segmentId) {
    return '当前计划引用了分段分镜而不是全片总分镜，请重新生成全片总提示词。';
  }
  if (board.promptTrace?.shotPlanMode !== 'ai-complete') {
    return '全片总分镜缺少“AI 返回完整逐镜方案”的新凭据；旧版仅由 AI 推荐镜数、本地拆镜的结果不能继续复用，请重新生成完整 AI 分镜。';
  }
  if (typeof board.finalPrompt !== 'string' || !board.finalPrompt.trim()) {
    return '全片总视频提示词为空，请重新生成全片总提示词。';
  }
  const shots = Array.isArray(board.shots) ? board.shots : [];
  if (!shots.length) return '全片总分镜没有真实镜头，无法切分视频段，请重新生成全片总提示词。';
  const invalidShot = shots.find((shot) => (
    !shot
    || typeof shot.id !== 'string'
    || !Number.isFinite(shot.startSec)
    || !Number.isFinite(shot.endSec)
    || shot.endSec <= shot.startSec
    || typeof shot.prompt !== 'string'
    || !shot.prompt.trim()
  ));
  if (invalidShot) return '全片总分镜存在无效镜头或空镜头提示词，请重新生成全片总提示词。';
  // A shorter edited plan can safely re-cut the prefix of a longer master
  // timeline. Extending beyond the master is unsafe and requires regeneration.
  if (typeof board.durationSec === 'number' && board.durationSec + MASTER_TIMELINE_EPSILON < plan.totalDurationSec) {
    return `全片总分镜只有 ${roundToTwo(board.durationSec)} 秒，无法覆盖计划 ${roundToTwo(plan.totalDurationSec)} 秒，请重新生成总提示词。`;
  }
  if (typeof board.sourceStoryContent === 'string'
    && board.sourceStoryContent.trim()
    && board.sourceStoryContent !== plan.sourceStoryContent) {
    return '全片总分镜对应的剧情快照已过期，请重新生成全片总提示词。';
  }
  const ordered = [...shots].sort((left, right) => left.startSec - right.startSec || left.index - right.index);
  if (!approximatelyMasterEqual(ordered[0].startSec, 0)) {
    return '全片总时间轴没有从 0 秒开始，请重新生成全片总提示词。';
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (!approximatelyMasterEqual(ordered[index].startSec, ordered[index - 1].endSec)) {
      return '全片总时间轴存在空档或重叠，无法安全切段，请重新生成全片总提示词。';
    }
  }
  if (ordered[ordered.length - 1].endSec + MASTER_TIMELINE_EPSILON < plan.totalDurationSec) {
    return '全片总时间轴没有覆盖到计划结束时间，请重新生成全片总提示词。';
  }
  const roundedPlanEnd = roundToTwo(plan.totalDurationSec);
  const endsAtCompleteShot = ordered.some(
    (shot) => roundToTwo(shot.endSec) === roundedPlanEnd,
  );
  if (!endsAtCompleteShot) {
    return '计划结束时间切进了总镜头，必须落在完整总镜头边界；请重新生成全片总提示词。';
  }
  if (hasAiAuthoredMasterTimeline(board)) {
    try {
      assertMasterSegmentDurationContract(ordered.filter((shot) => shot.endSec <= plan.totalDurationSec + MASTER_TIMELINE_EPSILON), plan.totalDurationSec, plan.segmentDurationSec);
      return undefined;
    } catch (error) {
      return `当前全片总稿不符合所选${plan.segmentDurationSec}秒分段时长：${error instanceof Error ? error.message : String(error)}请重新生成全片总提示词，由AI安排镜头边界；旧稿保持不变。`;
    }
  }
  if (fixedGridIssue) return fixedGridIssue;
  try {
    validateMasterTimelineSegmentGrid(
      ordered,
      plan.totalDurationSec,
      plan.segmentDurationSec,
    );
  } catch (error) {
    return error instanceof Error
      ? `${error.message} 请重新生成全片总提示词。`
      : '全片总时间轴不符合固定分段时长网格，请重新生成全片总提示词。';
  }
  return undefined;
};

/**
 * Explain why a persisted master-confirmed marker is no longer trustworthy.
 * Unlike the legacy storyboard check, confirmation requires an explicit board
 * owner and an exact fingerprint of the live plan and master timeline.
 */
export const sequencePlanMasterConfirmationIssue = (
  plan: Pick<
    VideoSequencePlan,
    | 'id'
    | 'sourceStoryContent'
    | 'totalDurationSec'
    | 'segmentDurationSec'
    | 'masterStoryboardId'
    | 'masterPromptConfirmedFingerprint'
    | 'masterPromptConfirmedAt'
    | 'planningMode'
  >,
  storyboards: readonly SequenceMasterStoryboardCandidate[] = [],
): string | undefined => {
  if (isSemanticSequencePlan(plan)) return undefined;
  const fingerprint = typeof plan.masterPromptConfirmedFingerprint === 'string'
    ? plan.masterPromptConfirmedFingerprint.trim()
    : '';
  const hasConfirmedAt = typeof plan.masterPromptConfirmedAt === 'number'
    && Number.isFinite(plan.masterPromptConfirmedAt)
    && plan.masterPromptConfirmedAt > 0;
  if (!fingerprint && !hasConfirmedAt) {
    return '总提示词确认状态失效：缺少有效的确认指纹或确认时间，请重新确认总提示词。';
  }
  if (!fingerprint) {
    return '总提示词确认状态失效：确认指纹不能为空，请重新确认总提示词。';
  }
  if (!hasConfirmedAt) {
    return '总提示词确认状态失效：确认时间必须是大于 0 的有限时间戳，请重新确认总提示词。';
  }

  const masterId = typeof plan.masterStoryboardId === 'string'
    ? plan.masterStoryboardId.trim()
    : '';
  const board = storyboards.find((candidate) => candidate.id === masterId);
  if (board && board.sequencePlanId !== plan.id) {
    return '总提示词确认状态失效：总分镜未明确归属于当前序列计划，请重新生成或重新确认总提示词。';
  }
  const masterIssue = sequencePlanMasterStoryboardIssue(plan, storyboards);
  if (masterIssue) return `总提示词确认状态失效：${masterIssue}`;

  const expectedFingerprint = masterPromptConfirmationFingerprint(
    { ...plan, masterStoryboardId: masterId },
    board as SequenceMasterStoryboardCandidate,
  );
  if (fingerprint !== expectedFingerprint) {
    return '总提示词确认状态失效：剧情、时长或总分镜内容已变化，请重新确认总提示词。';
  }
  return undefined;
};

/**
 * Explain why the current director settings cannot reuse a previously
 * confirmed master prompt snapshot.
 */
export const sequencePlanMasterDirectorSettingsIssue = (
  plan: Pick<VideoSequencePlan, 'masterPromptDirectorSettingsFingerprint' | 'planningMode' | 'semanticPlanningSnapshot'>,
  currentDirectorSettingsFingerprint: string,
): string | undefined => {
  const semantic = isSemanticSequencePlan(plan);
  const savedValue = semantic
    ? plan.semanticPlanningSnapshot?.directorSettingsFingerprint
    : plan.masterPromptDirectorSettingsFingerprint;
  const savedFingerprint = typeof savedValue === 'string'
    ? savedValue.trim()
    : '';
  const liveFingerprint = typeof currentDirectorSettingsFingerprint === 'string'
    ? currentDirectorSettingsFingerprint.trim()
    : '';
  if (!savedFingerprint) {
    return semantic
      ? '语义分段的导演参数快照缺失，请重新进行 AI 语义分段。'
      : '导演参数尚未确认，请先确认导演参数，再生成全片总提示词。';
  }
  // A semantic plan owns its frozen director settings. Selecting another
  // plan or preparing a different story may change live UI settings without
  // invalidating this plan's generation/retry source.
  if (semantic) return undefined;
  if (!liveFingerprint) {
    return '当前导演参数快照缺失，请先重新确认导演参数。';
  }
  if (savedFingerprint !== liveFingerprint) {
    return '当前导演参数已变化，请重新生成全片总提示词。';
  }
  return undefined;
};

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

/**
 * Source-preserving form of the same semantic event beats used by estimation
 * and prompt planning. IDs are intentionally distinct from prompt-only IDs,
 * while the text spans remain contiguous and reconstruct the story exactly.
 */
export const extractStoryBeats = (
  story: string,
  options: SemanticStoryBeatExtractionOptions = {},
): StoryBeat[] => (
  extractSemanticStoryBeats(story, options).map((beat, index) => ({
    id: `beat_${index + 1}`,
    index: index + 1,
    text: beat.text,
    sourceStart: beat.sourceStart,
    sourceEnd: beat.sourceEnd,
    weight: beat.weight,
    actionSignature: beat.actionSignature,
    kind: beat.kind,
  }))
);

const roundToHalfSecond = (value: number): number => Math.round(value * 2) / 2;
const roundUpToHalfSecond = (value: number): number => Math.ceil((value - Number.EPSILON) * 2) / 2;

const DIALOGUE_LEAD_SEC = 0.18;
const DIALOGUE_TAIL_SEC = 0.28;
const DIALOGUE_CHARACTERS_PER_SEC = 4.5;
const NARRATIVE_CHARACTERS_PER_SEC = 12;
const QUOTED_DIALOGUE_PATTERN = /(?:“([^”]*)”|‘([^’]*)’|「([^」]*)」|『([^』]*)』|"([^"\r\n]*)")/gu;

const meaningfulCharacterCount = (value: string): number => (
  [...value].filter((character) => /[\p{L}\p{N}]/u.test(character)).length
);

const dialogueTextOf = (value: string): string => {
  const quoted = [...value.matchAll(QUOTED_DIALOGUE_PATTERN)]
    .map((match) => match.slice(1).find((part) => typeof part === 'string') || '')
    .join('');
  return quoted || value;
};

const dialogueUnits = (value: string): number => {
  const text = dialogueTextOf(value).replace(/[\s，。！？、；：…—,.!?;:]/gu, '');
  const chinese = (text.match(/[\u3400-\u9fff]/gu) || []).length;
  const latinWords = (text.match(/[A-Za-z0-9]+/gu) || []).length;
  const latinCharacters = (text.match(/[A-Za-z0-9]/gu) || []).length;
  const other = Math.max(0, [...text].length - chinese - latinCharacters);
  return chinese + latinWords * 1.6 + other * 0.25;
};

const recommendedSecondsForBeat = (beat: SemanticStoryBeat): number => {
  const characters = meaningfulCharacterCount(beat.text);
  switch (beat.kind) {
    case 'dialogue': {
      const units = dialogueUnits(beat.text);
      if (units <= 0) return 0.5;
      return Math.max(
        0.45 + DIALOGUE_LEAD_SEC + DIALOGUE_TAIL_SEC,
        units / DIALOGUE_CHARACTERS_PER_SEC + DIALOGUE_LEAD_SEC + DIALOGUE_TAIL_SEC,
      );
    }
    case 'visible-action':
      return Math.max(2.5, characters / NARRATIVE_CHARACTERS_PER_SEC);
    case 'state-change':
      return Math.max(1.5, characters / NARRATIVE_CHARACTERS_PER_SEC);
    case 'internal-thought':
      return Math.max(0.5, characters / NARRATIVE_CHARACTERS_PER_SEC);
    case 'exposition':
    default:
      return Math.max(0.35, characters / NARRATIVE_CHARACTERS_PER_SEC);
  }
};

const STORY_BEAT_KIND_LABELS: Record<SemanticStoryBeatKind, string> = {
  'visible-action': '可视动作',
  dialogue: '对白',
  'state-change': '状态变化',
  exposition: '说明',
  'internal-thought': '心理',
};

export const estimateStoryDurationLocally = (
  story: string,
  options: SemanticStoryBeatExtractionOptions = {},
): {
  minSec: number;
  recommendedSec: number;
  maxSec: number;
  fitStatus: SequenceFitStatus;
  reason: string;
} => {
  const semanticBeats = extractSemanticStoryBeats(story, options);
  if (semanticBeats.length === 0) {
    return {
      minSec: 0,
      recommendedSec: 0,
      maxSec: 0,
      fitStatus: 'insufficient',
      reason: '剧情为空，无法估算叙事时长。',
    };
  }

  const meaningfulCharacters = meaningfulCharacterCount(story);
  const classifiedRecommendedRaw = semanticBeats.reduce(
    (total, beat) => total + recommendedSecondsForBeat(beat),
    0,
  );
  const densityFloorRaw = meaningfulCharacters / NARRATIVE_CHARACTERS_PER_SEC;
  const recommendedRaw = Math.max(classifiedRecommendedRaw, densityFloorRaw);
  const recommendedSec = Math.max(0.5, roundUpToHalfSecond(recommendedRaw));
  const minSec = Math.max(0.5, roundToHalfSecond(recommendedSec * 0.65));
  const maxSec = Math.max(recommendedSec, roundToHalfSecond(recommendedSec * 1.6));
  const kindSummary = (Object.keys(STORY_BEAT_KIND_LABELS) as SemanticStoryBeatKind[])
    .map((kind) => ({
      kind,
      count: semanticBeats.filter((beat) => beat.kind === kind).length,
    }))
    .filter(({ count }) => count > 0)
    .map(({ kind, count }) => `${STORY_BEAT_KIND_LABELS[kind]} ${count}`)
    .join('、');

  return {
    minSec,
    recommendedSec,
    maxSec,
    fitStatus: 'balanced',
    reason: `本地按 ${semanticBeats.length} 个语义事件节拍（${kindSummary}）、${meaningfulCharacters} 个有效字符分类估算；对白遵守自然朗读窗口，标点不单独增加时长。`,
  };
};

const assertPositiveTime = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}必须是大于 0 的有限数字。`);
  }
  const rounded = roundToTwo(value);
  if (rounded <= 0) throw new Error(`${label}精确到 0.01 秒后必须大于 0。`);
  return rounded;
};

/** AI plans retain the requested total; a preferred segment length must not
 * round it up or force an exact divisor before the model chooses boundaries. */
export const resolveAiSequenceTotalDuration = (candidateTotalDurationSec: number): number => {
  const total = assertPositiveTime(candidateTotalDurationSec, '全片总时长');
  if (total > 3600) throw new Error('全片总时长不能超过 3600 秒。');
  return total;
};

const CENTISECOND_PRECISION_EPSILON = 1e-8;

const hasExactCentisecondPrecision = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isFinite(value)
  && Math.abs(value * 100 - Math.round(value * 100)) <= CENTISECOND_PRECISION_EPSILON
);

const assertExactCentisecondTime = (value: number, label: string): number => {
  if (!hasExactCentisecondPrecision(value)) {
    throw new Error(`${label}必须精确到 0.01 秒（百分之一秒），不能包含更多小数位。`);
  }
  return assertPositiveTime(value, label);
};

const assertSequenceSegmentDuration = (value: number): number => {
  if (
    typeof value === 'number'
    && Number.isFinite(value)
    && value > MAX_SEQUENCE_SEGMENT_DURATION_SEC
  ) {
    throw new Error(
      `目标单段时长 ${value} 秒超过模型单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒。`,
    );
  }
  const durationSec = assertPositiveTime(value, '目标单段时长');
  if (durationSec > MAX_SEQUENCE_SEGMENT_DURATION_SEC) {
    throw new Error(
      `目标单段时长 ${durationSec} 秒超过模型单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒。`,
    );
  }
  return durationSec;
};

const assertExactSequenceSegmentDuration = (value: number): number => {
  if (
    typeof value === 'number'
    && Number.isFinite(value)
    && value > MAX_SEQUENCE_SEGMENT_DURATION_SEC
  ) {
    throw new Error(
      `目标单段时长 ${value} 秒超过模型单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒。`,
    );
  }
  const durationSec = assertExactCentisecondTime(value, '目标单段时长');
  if (durationSec > MAX_SEQUENCE_SEGMENT_DURATION_SEC) {
    throw new Error(
      `目标单段时长 ${durationSec} 秒超过模型单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒。`,
    );
  }
  return durationSec;
};

const finalizeDurations = (values: number[], totalDurationSec: number, segmentDurationSec: number): number[] => {
  const durations = values.map(roundToTwo);
  const precedingTotal = durations.slice(0, -1).reduce((total, duration) => roundToTwo(total + duration), 0);
  durations[durations.length - 1] = roundToTwo(totalDurationSec - precedingTotal);

  if (durations.some((duration) => duration <= 0 || duration - segmentDurationSec > TIME_EPSILON)) {
    throw new Error('无法在单段时长上限内精确分配总时长，请调整总时长或单段时长。');
  }
  return durations;
};

const allocateSupportedDurations = (
  totalDurationSec: number,
  segmentDurationSec: number,
  mode: SequenceSegmentationMode,
  supportedDurationsSec: number[],
): number[] => {
  const segmentDurationUnits = Math.round(segmentDurationSec * 100);
  const supportedUnits = [...new Set(supportedDurationsSec
    .filter((duration) => Number.isFinite(duration))
    .map((duration) => Math.round(duration * 100))
    .filter((durationUnits) => durationUnits >= 1 && durationUnits <= segmentDurationUnits))]
    .sort((left, right) => right - left);
  const supported = supportedUnits.map((durationUnits) => durationUnits / 100);

  if (supportedUnits.length === 0) {
    throw new Error(`离散模型时长与单段上限 ${segmentDurationSec} 秒不兼容：没有可用的支持时长。`);
  }

  const target = Math.round(totalDurationSec * 100);
  const largest = supportedUnits[0];
  const smallest = supportedUnits[supportedUnits.length - 1];
  const minimumCount = Math.ceil(target / largest);
  const maximumCount = Math.floor(target / smallest);

  const findForCount = (count: number): number[] | undefined => {
    const ideal = target / count;
    const orderedUnits = mode === 'fixed'
      ? supportedUnits
      : [...supportedUnits].sort((left, right) => Math.abs(left - ideal) - Math.abs(right - ideal) || right - left);
    const failed = new Set<string>();

    const visit = (remaining: number, slots: number): number[] | undefined => {
      if (slots === 0) return remaining === 0 ? [] : undefined;
      if (remaining < slots * smallest || remaining > slots * largest) return undefined;
      const key = `${remaining}:${slots}`;
      if (failed.has(key)) return undefined;

      for (const unit of orderedUnits) {
        if (unit > remaining) continue;
        const tail = visit(remaining - unit, slots - 1);
        if (tail) return [unit, ...tail];
      }
      failed.add(key);
      return undefined;
    };

    return visit(target, count);
  };

  for (let count = minimumCount; count <= maximumCount; count += 1) {
    const allocation = findForCount(count);
    if (allocation) return allocation.map((duration) => duration / 100);
  }

  throw new Error(
    `离散模型时长不兼容：总时长 ${totalDurationSec} 秒无法由支持时长 ${[...supported].sort((left, right) => left - right).join('、')} 秒精确组成；请修改总时长或单段时长。`,
  );
};

export const allocateSegmentDurations = (
  totalDurationSec: number,
  segmentDurationSec: number,
  mode: SequenceSegmentationMode,
  supportedDurationsSec?: number[],
): number[] => {
  const total = assertPositiveTime(totalDurationSec, '总时长');
  const maximum = assertSequenceSegmentDuration(segmentDurationSec);

  if (supportedDurationsSec) {
    return allocateSupportedDurations(total, maximum, mode, supportedDurationsSec);
  }

  const totalUnits = Math.round(total * 100);
  const maximumUnits = Math.round(maximum * 100);
  const count = Math.ceil(totalUnits / maximumUnits);
  if (count === 1) return [total];

  if (mode === 'natural') {
    const baseUnits = Math.floor(totalUnits / count);
    const remainderUnits = totalUnits - baseUnits * count;
    return Array.from({ length: count }, (_, index) => (
      baseUnits + (index >= count - remainderUnits ? 1 : 0)
    ) / 100);
  }

  const finalRemainder = (totalUnits - maximumUnits * (count - 1)) / 100;
  if (finalRemainder < maximum / 2) {
    const stablePrefix = Array.from({ length: Math.max(0, count - 2) }, () => maximum);
    const balancedTail = roundToTwo((maximum + finalRemainder) / 2);
    return finalizeDurations([...stablePrefix, balancedTail, balancedTail], total, maximum);
  }

  return finalizeDurations([
    ...Array.from({ length: count - 1 }, () => maximum),
    finalRemainder,
  ], total, maximum);
};

/**
 * Allocate the only legal ranges for a newly-created fixed-duration video
 * plan.  Unlike the legacy allocator above, this deliberately never balances
 * a tail or treats the requested duration as a soft target.
 */
export const allocateStrictSegmentDurations = (
  totalDurationSec: number,
  segmentDurationSec: number,
): number[] => {
  const total = assertExactCentisecondTime(totalDurationSec, '全片总时长');
  const segmentDuration = assertExactSequenceSegmentDuration(segmentDurationSec);
  const totalUnits = Math.round(total * 100);
  const segmentUnits = Math.round(segmentDuration * 100);

  if (totalUnits % segmentUnits !== 0) {
    throw new Error(
      `全片总时长 ${total} 秒必须是固定分段时长 ${segmentDuration} 秒的整数倍，不能生成短尾段。`,
    );
  }

  return Array.from({ length: totalUnits / segmentUnits }, () => segmentDuration);
};

/**
 * Validate persisted segmented plans against the exact centisecond grid used
 * for new fixed-duration requests.  It is intentionally separate from the
 * legacy soft-target allocator so old low-level callers can retain their
 * historical allocation behavior while every finalized plan has one rule.
 */
export const validateStrictSegmentDurationGrid = (
  plan: Pick<VideoSequencePlan, 'totalDurationSec' | 'segmentDurationSec' | 'segments'>,
): string[] => {
  const errors: string[] = [];
  let total: number;
  let segmentDuration: number;
  try {
    total = assertExactCentisecondTime(plan.totalDurationSec, '全片总时长');
    segmentDuration = assertExactSequenceSegmentDuration(plan.segmentDurationSec);
  } catch (error) {
    errors.push(
      `固定分段时长网格无效：${error instanceof Error ? error.message : '时长必须是有效数字。'}`,
    );
    return errors;
  }

  const totalUnits = Math.round(total * 100);
  const segmentUnits = Math.round(segmentDuration * 100);
  if (totalUnits % segmentUnits !== 0) {
    errors.push(
      `全片总时长 ${total} 秒不是固定分段时长 ${segmentDuration} 秒的整数倍，旧计划必须重新生成。`,
    );
    return errors;
  }

  const expectedSegmentCount = totalUnits / segmentUnits;
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  if (segments.length !== expectedSegmentCount) {
    errors.push(
      `视频段数 ${segments.length} 不符合固定分段时长网格要求：${total} 秒应为 ${expectedSegmentCount} 段。`,
    );
  }

  segments.forEach((segment, index) => {
    const expectedStartUnits = index * segmentUnits;
    const expectedEndUnits = expectedStartUnits + segmentUnits;
    const startUnits = hasExactCentisecondPrecision(segment.globalStartSec)
      ? Math.round(segment.globalStartSec * 100)
      : undefined;
    const endUnits = hasExactCentisecondPrecision(segment.globalEndSec)
      ? Math.round(segment.globalEndSec * 100)
      : undefined;
    const durationUnits = hasExactCentisecondPrecision(segment.durationSec)
      ? Math.round(segment.durationSec * 100)
      : undefined;

    if (!hasExactCentisecondPrecision(segment.globalStartSec)
      || !hasExactCentisecondPrecision(segment.globalEndSec)
      || !hasExactCentisecondPrecision(segment.durationSec)) {
      errors.push(`第 ${index + 1} 段起止时间和段时长必须精确到 0.01 秒（百分之一秒）。`);
    }

    if (startUnits !== expectedStartUnits || endUnits !== expectedEndUnits) {
      errors.push(
        `第 ${index + 1} 段不在固定分段时长网格范围 [${expectedStartUnits / 100}, ${expectedEndUnits / 100}] 秒内。`,
      );
    }
    if (durationUnits !== segmentUnits) {
      errors.push(
        `第 ${index + 1} 段时长必须等于固定分段时长网格 ${segmentDuration} 秒。`,
      );
    }
  });

  return errors;
};

/** Validate the persisted fixed-grid dimensions even before a draft has any
 * video segments.  This keeps old non-multiple plans readable, while every
 * confirm/segment action can explain that they must be regenerated. */
const validateFixedSegmentGridDimensions = (
  plan: Pick<VideoSequencePlan, 'totalDurationSec' | 'segmentDurationSec'>,
): string[] => {
  try {
    const total = assertExactCentisecondTime(plan.totalDurationSec, '全片总时长');
    const segmentDuration = assertExactSequenceSegmentDuration(plan.segmentDurationSec);
    if (Math.round(total * 100) % Math.round(segmentDuration * 100) !== 0) {
      return [
        `全片总时长 ${total} 秒不是固定分段时长 ${segmentDuration} 秒的整数倍，旧计划必须重新生成。`,
      ];
    }
  } catch (error) {
    return [
      `固定分段时长网格无效：${error instanceof Error ? error.message : '时长必须是有效数字。'}`,
    ];
  }
  return [];
};

export interface ShotCapacitySegmentAllocation {
  durations: number[];
  effectiveSegmentDurationSec: number;
  autoExtended: boolean;
}

/**
 * Keep every segment non-empty when semantic shot limiting produces fewer
 * master shots than the user's soft segment-duration target would create.
 * The target is automatically extended just enough to keep segment count at
 * or below the authoritative master-shot capacity.
 */
export const allocateSegmentDurationsForShotCapacity = (
  totalDurationSec: number,
  requestedSegmentDurationSec: number,
  mode: SequenceSegmentationMode,
  masterShotCapacity: number,
): ShotCapacitySegmentAllocation => {
  if (!Number.isInteger(masterShotCapacity) || masterShotCapacity < 1) {
    throw new Error('总时间轴镜头容量必须是大于 0 的整数。');
  }
  const requested = assertSequenceSegmentDuration(requestedSegmentDurationSec);
  const initial = allocateSegmentDurations(totalDurationSec, requested, mode);
  if (initial.length <= masterShotCapacity) {
    return {
      durations: initial,
      effectiveSegmentDurationSec: requested,
      autoExtended: false,
    };
  }

  const total = assertPositiveTime(totalDurationSec, '总时长');
  const minimumUnits = Math.ceil(Math.round(total * 100) / masterShotCapacity);
  const effectiveSegmentDurationSec = Math.max(requested, minimumUnits / 100);
  if (effectiveSegmentDurationSec > MAX_SEQUENCE_SEGMENT_DURATION_SEC + TIME_EPSILON) {
    throw new Error(
      `总时间轴只有 ${masterShotCapacity} 镜，自动延长后的单段时长 ${effectiveSegmentDurationSec} 秒超过硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒。`,
    );
  }
  const durations = allocateSegmentDurations(
    total,
    effectiveSegmentDurationSec,
    mode,
  );
  if (durations.length > masterShotCapacity) {
    throw new Error('自动延长单段时长后仍超过总时间轴镜头容量。');
  }
  return {
    durations,
    effectiveSegmentDurationSec,
    autoExtended: true,
  };
};

const allocateBeats = (beats: StoryBeat[], durations: number[]): StoryBeat[][] => {
  const groups: StoryBeat[][] = [];
  let cursor = 0;
  let remainingDuration = durations.reduce((total, duration) => total + duration, 0);
  let remainingWeight = beats.reduce((total, beat) => total + beat.weight, 0);

  durations.forEach((duration, segmentIndex) => {
    const segmentsAfter = durations.length - segmentIndex - 1;
    if (segmentIndex === durations.length - 1) {
      groups.push(beats.slice(cursor));
      return;
    }

    const maximumTake = beats.length - cursor - segmentsAfter;
    const targetWeight = remainingDuration > 0 ? remainingWeight * (duration / remainingDuration) : 0;
    let bestTake = 1;
    let runningWeight = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let take = 1; take <= maximumTake; take += 1) {
      runningWeight += beats[cursor + take - 1].weight;
      const distance = Math.abs(runningWeight - targetWeight);
      if (distance < bestDistance) {
        bestTake = take;
        bestDistance = distance;
      }
    }

    const group = beats.slice(cursor, cursor + bestTake);
    groups.push(group);
    cursor += bestTake;
    remainingWeight -= group.reduce((total, beat) => total + beat.weight, 0);
    remainingDuration -= duration;
  });

  return groups;
};

const summarize = (content: string): string => {
  const characters = [...content.trim()];
  return characters.length <= 48 ? characters.join('') : `${characters.slice(0, 47).join('')}…`;
};

const localBoundaryState = (segmentIndex: number, lastBeatText: string): string => {
  const withoutDialogue = stripDialogueTurns(lastBeatText);
  if (withoutDialogue === lastBeatText) {
    return `第 ${segmentIndex + 1} 段结束于：${summarize(lastBeatText)}`;
  }

  const speaker = lastBeatText.match(
    /(?:^|[。！？!?]\s*)([^，。！？!?：“”「」『』]{1,24}?)(?:说(?:道)?|问道|喊道|吼道|答道|回答(?:道)?|低声说|大声喊|呼唤)\s*[：:，,]?\s*[“‘「『"]/u,
  )?.[1]?.trim() || '当前说话者';
  const narrativeState = withoutDialogue
    .replace(
      /(?:^|[。！？!?]\s*)[^，。！？!?：“”「」『』]{1,24}?(?:说(?:道)?|问道|喊道|吼道|答道|回答(?:道)?|低声说|大声喊|呼唤)\s*[：:，,]?/u,
      '',
    )
    .replace(/^[，,；;：:\s]+|[。！？!?；;：:\s]+$/gu, '')
    .trim();
  const completedDialogueState = `${speaker}已完成当前对白，保持段末姿态、位置、视线、道具状态和情绪。`;
  return `第 ${segmentIndex + 1} 段结束于：${narrativeState
    ? `${summarize(narrativeState)}；`
    : ''}${completedDialogueState}`;
};

export const resolveSequenceFitStatus = (
  totalDurationSec: number,
  estimate: ReturnType<typeof estimateStoryDurationLocally>,
  beatCount: number,
  segmentCount: number,
  options: { allowMultipleSegmentsPerBeat?: boolean } = {},
): SequenceFitStatus => {
  // A locally authored fixed plan still requires one or more source beats per
  // segment.  An AI-authored full-film timeline is different: the model may
  // (and often must) distribute several 15-second windows across one long
  // semantic beat.  Do not turn that valid AI decision into a false
  // “increase the duration” gate in the UI.
  if ((!options.allowMultipleSegmentsPerBeat && beatCount < segmentCount)
    || totalDurationSec < estimate.minSec * 0.65) return 'insufficient';
  if (totalDurationSec < estimate.minSec) return 'compressed';
  if (totalDurationSec > estimate.maxSec) return 'comfortable';
  return 'balanced';
};

export const buildLocalSequencePlan = (input: LocalSequencePlanInput): VideoSequencePlan => {
  const title = input.title.trim() || '未命名剧情';
  const story = input.story;
  const extractedBeats = extractStoryBeats(story);
  if (extractedBeats.length === 0) throw new Error('剧情内容不能为空，无法创建视频分段计划。');
  const requestedSegmentDurationSec = assertSequenceSegmentDuration(input.segmentDurationSec);

  const durations = allocateSegmentDurations(
    input.totalDurationSec,
    requestedSegmentDurationSec,
    input.segmentationMode,
  );
  const beats = extractedBeats;
  if (beats.length < durations.length) {
    throw new Error(
      `剧情只有 ${beats.length} 个有效节拍，与 ${durations.length} 个视频段不兼容；请缩短总时长、增加单段时长，或补充剧情细节。`,
    );
  }

  const groups = allocateBeats(beats, durations);
  const totalDurationSec = roundToTwo(input.totalDurationSec);
  const segmentDurationSec = requestedSegmentDurationSec;
  const identity = stableHash(`${title}\u0000${story}\u0000${totalDurationSec}\u0000${segmentDurationSec}\u0000${input.segmentationMode}`);
  const planId = `sequence_${identity}`;
  const timestamp = Date.now();
  let globalStartSec = 0;
  let previousExitState = '故事起始，保持原剧情设定。';

  const segments: VideoSegment[] = groups.map((group, index) => {
    const durationSec = durations[index];
    const globalEndSec = roundToTwo(globalStartSec + durationSec);
    const content = group.map((beat) => beat.text).join('');
    const lastBeat = group[group.length - 1];
    const exitState = localBoundaryState(index, lastBeat?.text || content);
    const segment: VideoSegment = {
      id: `${planId}_segment_${index + 1}`,
      index: index + 1,
      title: `第 ${index + 1} 段 · ${summarize(content)}`,
      globalStartSec,
      globalEndSec,
      durationSec,
      content,
      summary: summarize(content),
      sourceSceneIds: [...new Set(input.sourceSceneIds.filter(Boolean))],
      sourceBeatIds: group.map((beat) => beat.id),
      narrativePurpose: durations.length === 1
        ? '完整呈现剧情'
        : index === 0
          ? '建立人物、场景与冲突起点'
          : index === durations.length - 1
            ? '完成关键动作并形成阶段收束'
            : '推进冲突并承接前后动作',
      entryState: previousExitState,
      exitState,
      transitionHint: index === durations.length - 1
        ? '自然收束'
        : '保持主体、场景、光线与动作方向连续，衔接下一段',
      status: 'planned',
      locked: false,
    };
    globalStartSec = globalEndSec;
    previousExitState = exitState;
    return segment;
  });

  const estimate = estimateStoryDurationLocally(story);
  const fitStatus = resolveSequenceFitStatus(totalDurationSec, estimate, beats.length, durations.length);
  return {
    id: planId,
    title,
    sourceStoryTitle: title,
    sourceStoryContent: story,
    sourceContentHash: sourceContentHash(story),
    durationMode: 'fixed',
    requestedTotalDurationSec: totalDurationSec,
    totalDurationSec,
    segmentDurationSec,
    segmentationMode: input.segmentationMode,
    fitStatus,
    estimateReason: `${estimate.reason} 当前总时长 ${totalDurationSec} 秒，评估为 ${fitStatus}。`,
    segments,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const approximatelyEqual = (left: number, right: number): boolean => Math.abs(left - right) < TIME_EPSILON;

const planningStageOf = (plan: VideoSequencePlan): NonNullable<VideoSequencePlan['planningStage']> => {
  if (
    plan.planningStage === 'master-draft'
    || plan.planningStage === 'master-confirmed'
    || plan.planningStage === 'segmented'
  ) {
    return plan.planningStage;
  }
  return Array.isArray(plan.segments) && plan.segments.length > 0
    ? 'segmented'
    : 'master-draft';
};

export const validateSequencePlan = (
  plan: VideoSequencePlan,
  options: SequencePlanValidationOptions = {},
): string[] => {
  if (isSemanticSequencePlan(plan)) {
    const errors = validateSemanticSequencePlan(plan);
    if (options.directorSettingsFingerprint !== undefined) {
      const directorIssue = sequencePlanMasterDirectorSettingsIssue(plan, options.directorSettingsFingerprint);
      if (directorIssue) errors.push(directorIssue);
    }
    return errors;
  }
  const errors: string[] = [];
  if (!Number.isFinite(plan.totalDurationSec) || plan.totalDurationSec <= 0) errors.push('全片总时长必须大于 0。');
  if (!Number.isFinite(plan.segmentDurationSec) || plan.segmentDurationSec <= 0) errors.push('单段时长必须大于 0。');
  const hasExplicitPlanningStage = plan.planningStage === 'master-draft'
    || plan.planningStage === 'master-confirmed'
    || plan.planningStage === 'segmented';
  if (plan.sourceContentHash === undefined && hasExplicitPlanningStage) {
    errors.push('当前计划的来源正文哈希缺失，请重新分析并生成全片计划。');
  } else if (
    plan.sourceContentHash !== undefined
    && plan.sourceContentHash !== sourceContentHash(plan.sourceStoryContent)
  ) {
    errors.push('计划的来源正文哈希与剧情快照不一致，请重新分析并生成全片计划。');
  }
  const planningStage = planningStageOf(plan);
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  const masterStoryboardId = typeof plan.masterStoryboardId === 'string'
    ? plan.masterStoryboardId.trim()
    : '';
  const availableMasterBoard = (options.storyboards || []).find((board) => board.id === masterStoryboardId);
  const usesAiShotTiming = plan.segmentationSource === 'ai'
    || hasAiAuthoredMasterTimeline(availableMasterBoard);
  if (!usesAiShotTiming) errors.push(...validateFixedSegmentGridDimensions(plan));
  if (typeof plan.masterStoryboardId === 'string' && !masterStoryboardId) {
    errors.push('总时间轴分镜 ID 不能为空。');
  }
  const hasPersistedMasterConfirmation = plan.masterPromptConfirmedFingerprint !== undefined
    || plan.masterPromptConfirmedAt !== undefined;
  const mustValidateMasterConfirmation = planningStage === 'master-confirmed'
    || (
      planningStage === 'segmented'
      && options.requireMasterStoryboard === true
      && hasPersistedMasterConfirmation
    );
  if (mustValidateMasterConfirmation) {
    const confirmationIssue = sequencePlanMasterConfirmationIssue(
      plan,
      options.storyboards || [],
    );
    if (confirmationIssue) errors.push(confirmationIssue);
    if (
      planningStage === 'master-confirmed'
      && options.directorSettingsFingerprint !== undefined
    ) {
      const directorSettingsIssue = sequencePlanMasterDirectorSettingsIssue(
        plan,
        options.directorSettingsFingerprint,
      );
      if (directorSettingsIssue) errors.push(directorSettingsIssue);
    }
  }
  if (segments.length > 0 && planningStage !== 'segmented') {
    errors.push('全片规划阶段与已存在的视频分段数据矛盾，请先修复阶段状态。');
  }
  if (segments.length === 0) {
    if (planningStage === 'segmented') {
      errors.push('视频分段计划至少需要一个视频段。');
    }
    if (options.requireMasterStoryboard && planningStage !== 'master-confirmed') {
      const masterIssue = sequencePlanMasterStoryboardIssue(plan, options.storyboards || []);
      if (masterIssue) errors.push(masterIssue);
    }
    return errors;
  }

  if (!usesAiShotTiming) errors.push(...validateStrictSegmentDurationGrid(plan));
  else {
    try { assertSequenceSegmentDurationContract(segments, plan.totalDurationSec, plan.segmentDurationSec); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }

  const expectedBeats = extractStoryBeats(plan.sourceStoryContent);
  const expectedById = new Map(expectedBeats.map((beat) => [beat.id, beat]));
  const hasAiShotReferences = hasAiSequenceShotLinks(plan);
  // Source beats are optional provenance for a complete model-authored shot
  // graph. Metadata-only callers cannot re-prove prose semantics; when a
  // master is supplied its IDs, grouping and timeline are still checked below.
  const modelOwnsNarrative = hasAiShotReferences && (!availableMasterBoard || Boolean(
    availableMasterBoard.shots.length
    && availableMasterBoard.shots.every((shot) => shot.authoredBy === 'text-api'),
  ));
  const beatReferenceCounts = new Map<string, number>();
  segments.forEach((segment) => {
    (Array.isArray(segment.sourceBeatIds) ? segment.sourceBeatIds : []).forEach((beatId) => {
      beatReferenceCounts.set(beatId, (beatReferenceCounts.get(beatId) || 0) + 1);
    });
  });
  const seenBeatIds = new Set<string>();
  const linkedShotIds = new Set<string>();
  const flattenedBeatIds: string[] = [];
  let expectedStartSec = 0;
  let durationTotal = 0;

  segments.forEach((segment, index) => {
    const label = `第 ${index + 1} 段`;
    if (segment.index !== index + 1) errors.push(`${label}序号不连续。`);
    if (!approximatelyEqual(segment.globalStartSec, expectedStartSec)) {
      errors.push(`${label}时间不连续：应从 ${roundToTwo(expectedStartSec)} 秒开始。`);
    }
    if (!Number.isFinite(segment.durationSec) || segment.durationSec <= 0) {
      errors.push(`${label}时长必须大于 0。`);
    }
    if (!usesAiShotTiming && segment.durationSec > MAX_SEQUENCE_SEGMENT_DURATION_SEC) {
      errors.push(`${label}时长超过单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒。`);
    }
    if (!approximatelyEqual(segment.globalEndSec - segment.globalStartSec, segment.durationSec)) {
      errors.push(`${label}起止时间与段时长不一致。`);
    }
    if (!modelOwnsNarrative && index > 0 && segment.entryState !== segments[index - 1].exitState) {
      errors.push(`${label}入口状态未承接上一段出口状态。`);
    }

    const sourceBeatIds = Array.isArray(segment.sourceBeatIds) ? segment.sourceBeatIds : [];
    if (!modelOwnsNarrative && sourceBeatIds.length === 0) errors.push(`${label}至少需要一个剧情节拍，不能生成空段。`);
    if (!segment.content.trim()) errors.push(`${label}正文不能为空。`);
    if (segment.sourceShotIds !== undefined) {
      if (
        !Array.isArray(segment.sourceShotIds)
        || segment.sourceShotIds.some((shotId) => typeof shotId !== 'string' || !shotId.trim())
      ) {
        errors.push(`${label}的 sourceShotIds 必须是字符串 ID 数组。`);
      }
    }
    if (hasAiShotReferences) {
      segment.sourceShotIds!.forEach((shotId) => {
        if (linkedShotIds.has(shotId.trim())) errors.push(`${label}总镜头存在重复归属：${shotId}。`);
        linkedShotIds.add(shotId.trim());
      });
    }
    if (modelOwnsNarrative) {
      expectedStartSec = segment.globalEndSec;
      durationTotal = roundToTwo(durationTotal + segment.durationSec);
      return;
    }
    const knownBeatTexts: string[] = [];
    const knownBeatIndexes: number[] = [];
    const segmentBeatIds = new Set<string>();
    sourceBeatIds.forEach((beatId) => {
      if (!hasAiShotReferences || !seenBeatIds.has(beatId)) flattenedBeatIds.push(beatId);
      if (seenBeatIds.has(beatId) && (!hasAiShotReferences || segmentBeatIds.has(beatId))) {
        errors.push(`${label}重复使用剧情节拍 ${beatId}。`);
      }
      segmentBeatIds.add(beatId);
      seenBeatIds.add(beatId);
      const beat = expectedById.get(beatId);
      if (!beat) errors.push(`${label}引用了未知剧情节拍 ${beatId}。`);
      else {
        knownBeatTexts.push(beat.text);
        knownBeatIndexes.push(beat.index);
      }
    });
    if (knownBeatIndexes.length !== sourceBeatIds.length) errors.push(`${label}必须只引用已知剧情节拍。`);
    if (knownBeatIndexes.some((beatIndex, position) => position > 0 && beatIndex !== knownBeatIndexes[position - 1] + 1)) {
      errors.push(`${label}内部剧情节拍不连续。`);
    }
    if (segment.contentOverridden !== true && knownBeatTexts.join('') !== segment.content) {
      errors.push(`${label}正文不是由原始剧情节拍按顺序重组。`);
    }

    expectedStartSec = segment.globalEndSec;
    durationTotal = roundToTwo(durationTotal + segment.durationSec);
  });

  const missingBeatIds = expectedBeats.filter((beat) => !seenBeatIds.has(beat.id)).map((beat) => beat.id);
  if (!modelOwnsNarrative && missingBeatIds.length > 0) errors.push(`剧情节拍存在遗漏：${missingBeatIds.join('、')}。`);
  if (
    !modelOwnsNarrative
    && plan.segmentOrderOverridden !== true
    && flattenedBeatIds.join('|') !== expectedBeats.map((beat) => beat.id).join('|')
  ) {
    errors.push('剧情节拍顺序不连续，或存在重复、遗漏。');
  }
  if (!approximatelyEqual(durationTotal, plan.totalDurationSec)) errors.push('所有视频段时长之和与全片总时长不一致。');
  if (!approximatelyEqual(segments[segments.length - 1].globalEndSec, plan.totalDurationSec)) {
    errors.push('最后一段结束时间与全片总时长不一致。');
  }
  if ((options.requireMasterStoryboard || (plan.segmentationSource === 'ai' && availableMasterBoard))
    && (planningStage !== 'master-confirmed' || segments.length > 0)) {
    const masterIssue = sequencePlanMasterStoryboardIssue(
      plan,
      options.storyboards || [],
    );
    if (masterIssue) errors.push(masterIssue);
    else if (planningStage === 'segmented' || segments.length > 0) {
      const masterBoard = (options.storyboards || []).find(
        (board) => board.id === plan.masterStoryboardId,
      );
      const legalBoundarySeconds = (masterBoard?.shots || [])
        .map((shot) => shot.endSec)
        .filter((endSec) => endSec < plan.totalDurationSec - MASTER_TIMELINE_EPSILON);
      const invalidBoundary = segments.slice(0, -1).find((segment) => (
        !legalBoundarySeconds.some((endSec) => approximatelyMasterEqual(endSec, segment.globalEndSec))
      ));
      if (invalidBoundary) {
        errors.push(
          plan.segmentationSource === 'ai'
            ? `第 ${invalidBoundary.index} 段 AI 分段边界 ${roundToTwo(invalidBoundary.globalEndSec)} 秒切进了完整总镜头，请重新请求 AI 分段。`
            : `第 ${invalidBoundary.index} 段分段边界 ${roundToTwo(invalidBoundary.globalEndSec)} 秒切进了完整总镜头，请自动调整分段时长。`,
        );
      }
      const masterShotIds = new Set((masterBoard?.shots || []).map((shot) => shot.id));
      const assignedShotIds: string[] = [];
      let hasMissingLinks = false;
      segments.forEach((segment) => {
        if (!Array.isArray(segment.sourceShotIds) || segment.sourceShotIds.length === 0) {
          hasMissingLinks = true;
          return;
        }
        assignedShotIds.push(...segment.sourceShotIds);
      });
      if (hasMissingLinks) {
        errors.push(
          plan.segmentationSource === 'ai'
            ? '部分视频段缺少完整总镜头归属，请重新请求 AI 分段。'
            : '部分视频段缺少完整总镜头归属，请自动修复分段边界。',
        );
      }
      const seenShotIds = new Set<string>();
      const duplicateShotIds = new Set<string>();
      assignedShotIds.forEach((shotId) => {
        if (seenShotIds.has(shotId)) duplicateShotIds.add(shotId);
        seenShotIds.add(shotId);
      });
      if (duplicateShotIds.size > 0) {
        errors.push(`总镜头存在重复归属：${[...duplicateShotIds].join('、')}。`);
      }
      const unknownShotIds = [...seenShotIds].filter((shotId) => !masterShotIds.has(shotId));
      if (unknownShotIds.length > 0) {
        errors.push(`视频段引用了未知总镜头：${unknownShotIds.join('、')}。`);
      }
      const missingShotIds = [...masterShotIds].filter((shotId) => !seenShotIds.has(shotId));
      if (missingShotIds.length > 0) {
        errors.push(`总镜头存在遗漏归属：${missingShotIds.join('、')}。`);
      }

      // An AI-authored plan is only valid when its persisted provenance still
      // describes the exact contiguous groups returned by the model.  The
      // checks above catch set membership; this additional pass catches a
      // reordered group or a range that was edited away from the referenced
      // master-shot boundaries.  It deliberately reports the problem instead
      // of selecting a replacement boundary locally.
      if (plan.segmentationSource === 'ai' && masterBoard) {
        const orderedMasterShots = [...(masterBoard.shots || [])]
          .filter((shot) => (
            Number.isFinite(shot.startSec)
            && Number.isFinite(shot.endSec)
            && shot.endSec > shot.startSec
          ))
          .sort((left, right) => left.startSec - right.startSec || left.index - right.index);
        const masterPositionById = new Map(
          orderedMasterShots.map((shot, shotIndex) => [shot.id, shotIndex] as const),
        );
        let expectedShotPosition = 0;
        segments.forEach((segment, segmentIndex) => {
          const label = `第 ${segmentIndex + 1} 段`;
          const ids = Array.isArray(segment.sourceShotIds)
            ? segment.sourceShotIds
            : [];
          const positions = ids
            .map((shotId) => masterPositionById.get(shotId))
            .filter((position): position is number => position !== undefined);
          if (positions.length !== ids.length || positions.length === 0) return;
          const contiguous = positions.every((position, positionIndex) => (
            positionIndex === 0 || position === positions[positionIndex - 1] + 1
          ));
          if (!contiguous || positions[0] !== expectedShotPosition) {
            errors.push(`${label} AI 总镜头归属不是按母时间轴连续排列，请重新请求 AI 分段。`);
            return;
          }
          const firstShot = orderedMasterShots[positions[0]];
          const lastShot = orderedMasterShots[positions[positions.length - 1]];
          const shotBeatIds = new Set(positions.flatMap((position) => orderedMasterShots[position].sourceBeatIds || []));
          const declaredBeatIds = Array.isArray(segment.sourceBeatIds) ? segment.sourceBeatIds : [];
          const hasSharedBeat = declaredBeatIds.some((beatId) => (beatReferenceCounts.get(beatId) || 0) > 1);
          if (!modelOwnsNarrative && (shotBeatIds.size > 0 || hasSharedBeat)
            && (declaredBeatIds.length !== shotBeatIds.size || declaredBeatIds.some((beatId) => !shotBeatIds.has(beatId)))) {
            errors.push(`${label} sourceBeatIds 与所选总镜头的剧情来源不一致。`);
          }
          const expectedStart = firstShot.startSec;
          const expectedEnd = lastShot.endSec;
          const expectedDuration = expectedEnd - expectedStart;
          if (!approximatelyMasterEqual(segment.globalStartSec, expectedStart)
            || !approximatelyMasterEqual(segment.globalEndSec, expectedEnd)
            || !approximatelyMasterEqual(segment.durationSec, expectedDuration)) {
            errors.push(`${label} AI 分段时间必须与所引用完整总镜头边界一致，请重新请求 AI 分段。`);
          }
          expectedShotPosition = positions[positions.length - 1] + 1;
        });
        if (expectedShotPosition !== orderedMasterShots.length) {
          errors.push('AI 分段没有按顺序覆盖全部完整总镜头，请重新请求 AI 分段。');
        }
      }

      // Repeated or synonymous action wording may be intentional coverage,
      // continuity or a different shot. For all plan origins, local acceptance
      // is limited to the ID, reference, timing and coverage contract above.
    }
  }
  return errors;
};

import type {
  AiSequenceSegmentPlan,
  VideoSegment,
  VideoSequencePlan,
  VideoShot,
} from './types';
import {
  extractStoryBeats,
  hasAiSequenceShotLinks,
  MAX_SEQUENCE_SEGMENT_DURATION_SEC,
} from './storySegmentation';
import type { StoryBeat } from './storySegmentation';
import {
  normalizeAbsoluteSoundCueTimes,
  normalizeMasterShotPromptSoundCueTimes,
  retimeMasterShotPrompt,
} from './masterTimeline';
import { stripDialogueTurns } from './semanticEvents';
import { isSemanticSequencePlan, semanticSequenceSourceFingerprint, validateSemanticSequencePlan } from './semanticSequencePlan';

const SECOND_PRECISION = 100;
const EPSILON = 1 / (SECOND_PRECISION * 10);

const roundSeconds = (value: number): number => (
  Math.round((value + Number.EPSILON) * SECOND_PRECISION) / SECOND_PRECISION
);

const modelOwnsMasterNarrative = (shots: readonly VideoShot[]): boolean => (
  shots.length > 0 && shots.every((shot) => shot.authoredBy === 'text-api')
);

const buildSequencePlanReviewFingerprint = (
  plan: VideoSequencePlan,
  includeSourceShotIds: boolean,
  includeAiMetadata: boolean,
): string => JSON.stringify([
    plan.id,
    plan.sourceStoryTitle,
    plan.sourceStoryContent,
    plan.durationMode,
    plan.requestedTotalDurationSec ?? plan.totalDurationSec,
    plan.totalDurationSec,
    plan.segmentDurationSec,
    plan.segmentationMode,
    ...(includeAiMetadata ? [plan.segmentationSource, plan.segmentationReason] : []),
    plan.masterStoryboardId,
    plan.fitStatus,
    plan.segments.map((segment) => [
      segment.id,
      segment.index,
      segment.title,
      segment.durationSec,
      segment.content,
      segment.summary,
      segment.sourceSceneIds,
      segment.sourceBeatIds,
      segment.narrativePurpose,
      segment.entryState,
      segment.exitState,
      segment.transitionHint,
      ...(includeAiMetadata ? [segment.boundaryReason, segment.continuityPack] : []),
      ...(includeSourceShotIds ? [segment.sourceShotIds ?? []] : []),
    ]),
    // Preserve the exact legacy fingerprint schema. New mode reviews are
    // additionally tied to source evidence, dialogue ownership and the saved
    // director snapshot, not to a nonexistent full-film master.
    ...(isSemanticSequencePlan(plan) ? [semanticSequenceSourceFingerprint(plan)] : []),
  ]);

/** Pre-0.5.14 review identity, retained only to migrate valid saved plans. */
export const legacySequencePlanReviewFingerprint = (plan: VideoSequencePlan): string =>
  // Keep the exact pre-shot-ownership schema so saved projects from older
  // releases can be recognized and upgraded once.  Do not include the AI
  // segmentation metadata introduced after that schema.
  buildSequencePlanReviewFingerprint(plan, false, false);

/** Stable review identity shared by the UI and startup migrations. */
export const sequencePlanReviewFingerprint = (plan: VideoSequencePlan): string =>
  buildSequencePlanReviewFingerprint(plan, true, true);

export interface MasterShotSlice {
  sourceShotIds: string[];
  shots: VideoShot[];
}

/**
 * Verify that an AI-authored plan still points at every complete master shot
 * exactly once and that persisted ranges have not been rewritten locally.
 * This is intentionally a structural check; it never chooses a replacement
 * boundary. Callers should request a fresh AI plan when it fails.
 */
export const assertAiSequenceSegmentShotCoverage = (
  plan: Pick<VideoSequencePlan, 'segmentationSource' | 'totalDurationSec' | 'segments' | 'planningMode'>,
  masterShots: readonly VideoShot[],
): void => {
  if (isSemanticSequencePlan(plan)) return;
  if (plan.segmentationSource !== 'ai') return;
  const orderedShots = masterShots
    .filter((shot) => Number.isFinite(shot.startSec) && Number.isFinite(shot.endSec))
    .filter((shot) => shot.endSec > shot.startSec)
    .sort((left, right) => left.startSec - right.startSec || left.index - right.index);
  if (!orderedShots.length) throw new Error('AI 分段缺少可用的全片总镜头');
  if (orderedShots.length !== masterShots.length) throw new Error('全片总镜头包含无效时间范围，不能忽略后继续分段');
  if (new Set(orderedShots.map((shot) => shot.id)).size !== orderedShots.length) throw new Error('全片总镜头 ID 重复');
  if (orderedShots.some((shot, index) => !shot.id.trim() || (index > 0 && Math.abs(shot.startSec - orderedShots[index - 1].endSec) > EPSILON))) {
    throw new Error('全片总镜头 ID 缺失或时间轴存在空档、重叠');
  }
  const shotIndexById = new Map(orderedShots.map((shot, index) => [shot.id, index] as const));
  const modelOwnsNarrative = modelOwnsMasterNarrative(orderedShots);
  const seen = new Set<string>();
  let cursor = 0;
  plan.segments.forEach((segment, segmentIndex) => {
    const ids = Array.isArray(segment.sourceShotIds)
      ? segment.sourceShotIds.map((id) => String(id).trim()).filter(Boolean)
      : [];
    if (!ids.length) throw new Error(`AI 第 ${segmentIndex + 1} 段缺少完整总镜头归属`);
    const positions = ids.map((id) => {
      const position = shotIndexById.get(id);
      if (position === undefined) throw new Error(`AI 第 ${segmentIndex + 1} 段引用未知总镜头：${id}`);
      if (seen.has(id)) throw new Error(`AI 总镜头 ${id} 被重复归属`);
      seen.add(id);
      return position;
    });
    if (positions[0] !== cursor || positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段总镜头范围不连续`);
    }
    const firstShot = orderedShots[positions[0]];
    const lastShot = orderedShots[positions[positions.length - 1]];
    const expectedStart = roundSeconds(firstShot.startSec);
    const expectedEnd = roundSeconds(lastShot.endSec);
    const expectedDuration = roundSeconds(expectedEnd - expectedStart);
    if (Math.abs(segment.globalStartSec - expectedStart) > EPSILON
      || Math.abs(segment.globalEndSec - expectedEnd) > EPSILON
      || Math.abs(segment.durationSec - expectedDuration) > EPSILON) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段时间范围与完整总镜头不一致`);
    }
    // A planning preference cannot reject or shorten the model's saved shot.
    // Actual video-provider duration limits are checked at video submission.
    if (!modelOwnsNarrative && expectedDuration > MAX_SEQUENCE_SEGMENT_DURATION_SEC + EPSILON) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段超过单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒`);
    }
    cursor = positions[positions.length - 1] + 1;
  });
  if (cursor !== orderedShots.length || seen.size !== orderedShots.length) {
    const missing = orderedShots.filter((shot) => !seen.has(shot.id)).map((shot) => shot.id);
    throw new Error(`AI 分段遗漏总镜头：${missing.join('、') || '未知'}`);
  }
  if (Math.abs((plan.segments[0]?.globalStartSec ?? 0)) > EPSILON
    || Math.abs((plan.segments[plan.segments.length - 1]?.globalEndSec ?? 0) - plan.totalDurationSec) > EPSILON) {
    throw new Error('AI 分段没有覆盖完整全片时间轴');
  }
};

export interface SequenceBoundaryAlignmentResult {
  plan: VideoSequencePlan;
  adjustedBoundaryCount: number;
  extendedSegments: Array<{ index: number; extensionSec: number }>;
  changedSegmentIds: string[];
}

/** Typed repair blocker so persistence can surface affected locked segments
 * without parsing localized error text. */
export class SequenceBoundaryAlignmentLockedError extends Error {
  readonly segmentIds: string[];

  constructor(segments: readonly Pick<VideoSegment, 'id' | 'index'>[]) {
    const indexes = segments.map((segment) => segment.index).join('、');
    super(`第 ${indexes} 段已锁定，自动调整会改变其完整镜头范围；请先解锁后重试`);
    this.name = 'SequenceBoundaryAlignmentLockedError';
    this.segmentIds = segments.map((segment) => segment.id);
  }
}

const sameStringArray = (left: readonly string[] | undefined, right: readonly string[]): boolean => (
  Array.isArray(left)
  && left.length === right.length
  && left.every((value, index) => value === right[index])
);

const additionalBoundaryTimes = (
  segments: readonly VideoSegment[],
  alignedBoundaryTimes: readonly number[],
): number[] => {
  const sourceBoundaryTimes = segments.slice(0, -1).map((segment) => segment.globalEndSec);
  const matchedAlignedIndexes = new Set<number>();
  let minimumAlignedIndex = 0;

  sourceBoundaryTimes.forEach((sourceBoundary, sourceIndex) => {
    const maximumAlignedIndex = alignedBoundaryTimes.length
      - (sourceBoundaryTimes.length - sourceIndex);
    let closestIndex = minimumAlignedIndex;
    for (let index = minimumAlignedIndex + 1; index <= maximumAlignedIndex; index += 1) {
      if (
        Math.abs(alignedBoundaryTimes[index] - sourceBoundary)
        < Math.abs(alignedBoundaryTimes[closestIndex] - sourceBoundary)
      ) {
        closestIndex = index;
      }
    }
    matchedAlignedIndexes.add(closestIndex);
    minimumAlignedIndex = closestIndex + 1;
  });

  return alignedBoundaryTimes.filter((_, index) => !matchedAlignedIndexes.has(index));
};

const splitTextAtBeatCuts = (
  text: string,
  beatCount: number,
  beatCuts: readonly number[],
): string[] => {
  const characters = [...text];
  if (characters.length < beatCuts.length + 1) {
    throw new Error('自动镜头边界切分后没有足够正文可分配到每个非空视频段');
  }
  const characterCuts: number[] = [];
  let previousCut = 0;
  beatCuts.forEach((beatCut, index) => {
    const remainingPieces = beatCuts.length - index;
    const proportionalCut = Math.round(characters.length * (beatCut / beatCount));
    const nextCut = Math.max(
      previousCut + 1,
      Math.min(characters.length - remainingPieces, proportionalCut),
    );
    characterCuts.push(nextCut);
    previousCut = nextCut;
  });
  const boundaries = [0, ...characterCuts, characters.length];
  return boundaries.slice(0, -1).map((start, index) => (
    characters.slice(start, boundaries[index + 1]).join('')
  ));
};

const expandSegmentsAtAlignedBoundaries = (
  input: VideoSequencePlan,
  segments: readonly VideoSegment[],
  alignedBoundaryTimes: readonly number[],
): VideoSegment[] => {
  const splitBoundaryTimes = additionalBoundaryTimes(segments, alignedBoundaryTimes);
  if (!splitBoundaryTimes.length) return segments.map((segment) => ({ ...segment }));

  const sourceBeatsById = new Map(
    extractStoryBeats(input.sourceStoryContent).map((beat) => [beat.id, beat.text]),
  );
  const usedIds = new Set(segments.map((segment) => segment.id));
  const nextAutomaticSplitId = (baseId: string): string => {
    const root = `${baseId}-auto-split`;
    if (!usedIds.has(root)) {
      usedIds.add(root);
      return root;
    }
    let suffix = 2;
    while (usedIds.has(`${root}-${suffix}`)) suffix += 1;
    const id = `${root}-${suffix}`;
    usedIds.add(id);
    return id;
  };

  const expanded: VideoSegment[] = [];
  segments.forEach((source) => {
    const innerBoundaries = splitBoundaryTimes.filter((boundary) => (
      boundary > source.globalStartSec + EPSILON
      && boundary < source.globalEndSec - EPSILON
    ));
    if (!innerBoundaries.length) {
      expanded.push({ ...source });
      return;
    }
    if (source.locked) {
      throw new SequenceBoundaryAlignmentLockedError([source]);
    }

    const pieceCount = innerBoundaries.length + 1;
    const beatCount = source.sourceBeatIds.length;
    if (beatCount < pieceCount) {
      throw new Error(
        `第 ${source.index} 段需要在完整总镜头边界拆成 ${pieceCount} 段，但只有 ${beatCount} 个剧情节拍可安全分配`,
      );
    }

    const beatCuts: number[] = [];
    let previousBeatCut = 0;
    innerBoundaries.forEach((boundary, boundaryIndex) => {
      const remainingPieces = innerBoundaries.length - boundaryIndex;
      const proportionalCut = Math.round(
        beatCount
        * ((boundary - source.globalStartSec) / (source.globalEndSec - source.globalStartSec)),
      );
      const beatCut = Math.max(
        previousBeatCut + 1,
        Math.min(beatCount - remainingPieces, proportionalCut),
      );
      beatCuts.push(beatCut);
      previousBeatCut = beatCut;
    });
    const beatBoundaries = [0, ...beatCuts, beatCount];
    const beatPartitions = beatBoundaries.slice(0, -1).map((start, index) => (
      source.sourceBeatIds.slice(start, beatBoundaries[index + 1])
    ));
    const canonicalContentPartitions = beatPartitions.map((beatIds) => (
      beatIds.map((beatId) => sourceBeatsById.get(beatId)).filter((value): value is string => value !== undefined)
    ));
    const canUseCanonicalContent = source.contentOverridden !== true
      && canonicalContentPartitions.every((texts, index) => texts.length === beatPartitions[index].length)
      && canonicalContentPartitions.flat().join('') === source.content;
    const contentPartitions = canUseCanonicalContent
      ? canonicalContentPartitions.map((texts) => texts.join(''))
      : splitTextAtBeatCuts(source.content, beatCount, beatCuts);
    const timeBoundaries = [source.globalStartSec, ...innerBoundaries, source.globalEndSec];

    for (let pieceIndex = 0; pieceIndex < pieceCount; pieceIndex += 1) {
      const firstPiece = pieceIndex === 0;
      const lastPiece = pieceIndex === pieceCount - 1;
      const piece: VideoSegment = {
        ...source,
        id: firstPiece ? source.id : nextAutomaticSplitId(source.id),
        index: expanded.length + 1,
        title: firstPiece ? source.title : `${source.title}（续）`,
        globalStartSec: timeBoundaries[pieceIndex],
        globalEndSec: timeBoundaries[pieceIndex + 1],
        durationSec: roundSeconds(timeBoundaries[pieceIndex + 1] - timeBoundaries[pieceIndex]),
        content: contentPartitions[pieceIndex],
        sourceBeatIds: beatPartitions[pieceIndex],
        sourceShotIds: undefined,
        entryState: firstPiece ? source.entryState : source.exitState,
        exitState: lastPiece ? source.exitState : source.exitState,
        storyboardId: firstPiece ? source.storyboardId : undefined,
        status: firstPiece ? source.status : 'stale',
        contentOverridden: canUseCanonicalContent ? undefined : true,
      };
      delete piece.autoExtendedBySec;
      delete piece.failureReason;
      expanded.push(piece);
    }
  });

  return expanded.map((segment, index) => ({
    ...segment,
    index: index + 1,
  }));
};

/**
 * Move video-segment boundaries onto authoritative master-shot endings.
 * The selected per-segment duration remains a soft target; the full duration
 * is unchanged and every master shot is assigned to exactly one segment.
 */
export const alignSequenceSegmentsToMasterShotBoundaries = (
  input: VideoSequencePlan,
  masterShots: readonly VideoShot[],
): SequenceBoundaryAlignmentResult => {
  if (isSemanticSequencePlan(input)) {
    return { plan: input, adjustedBoundaryCount: 0, extendedSegments: [], changedSegmentIds: [] };
  }
  let segments = input.segments.map((segment, index) => cloneSegment(segment, index));
  if (segments.length === 0) throw new Error('全片计划至少包含一个视频段');
  const totalDurationSec = roundSeconds(input.totalDurationSec);
  const orderedShots = masterShots
    .filter((shot) => Number.isFinite(shot.startSec) && Number.isFinite(shot.endSec))
    .filter((shot) => shot.endSec > EPSILON && shot.startSec < totalDurationSec - EPSILON)
    .sort((left, right) => left.startSec - right.startSec || left.index - right.index);
  if (orderedShots.length < segments.length) {
    throw new Error(`全片总分镜只有 ${orderedShots.length} 个完整镜头，无法拆成 ${segments.length} 个非空视频段`);
  }
  if (!orderedShots.length || Math.abs(orderedShots[0].startSec) > EPSILON) {
    throw new Error('全片总时间轴必须从 0 秒开始，才能自动对齐视频段');
  }
  for (let index = 1; index < orderedShots.length; index += 1) {
    if (Math.abs(orderedShots[index].startSec - orderedShots[index - 1].endSec) > EPSILON) {
      throw new Error('全片总时间轴存在空档或重叠，无法自动对齐视频段');
    }
  }
  if (orderedShots[orderedShots.length - 1].endSec + EPSILON < totalDurationSec) {
    throw new Error('全片总时间轴没有覆盖计划结束时间，无法自动对齐视频段');
  }
  if (
    Math.abs(
      roundSeconds(orderedShots[orderedShots.length - 1].endSec) - totalDurationSec,
    ) > EPSILON
  ) {
    throw new Error('计划结束时间切进了总镜头，必须落在完整总镜头边界后才能自动分段');
  }
  const overlongShot = orderedShots.find(
    (shot) => shot.endSec - shot.startSec > MAX_SEQUENCE_SEGMENT_DURATION_SEC + EPSILON,
  );
  if (overlongShot) {
    const shotDurationSec = roundSeconds(overlongShot.endSec - overlongShot.startSec);
    throw new Error(
      `总镜头 ${overlongShot.id}（第 ${overlongShot.index} 镜）时长 ${shotDurationSec} 秒，超过模型单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒；请先拆分该镜头`,
    );
  }

  const shotEnds = orderedShots.map((shot, index) => (
    index === orderedShots.length - 1
      ? totalDurationSec
      : roundSeconds(Math.min(totalDurationSec, shot.endSec))
  ));
  type PartitionState = { maxDurationSec: number; cost: number; previousShotIndex: number };
  const choosePartition = (
    groupCount: number,
    desiredEnds: readonly number[],
  ): number[] | undefined => {
    const shotCount = orderedShots.length;
    const layers: Array<Map<number, PartitionState>> = Array.from(
      { length: groupCount },
      () => new Map<number, PartitionState>(),
    );
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const minimumShotIndex = groupIndex;
      const maximumShotIndex = shotCount - (groupCount - groupIndex);
      for (let shotIndex = minimumShotIndex; shotIndex <= maximumShotIndex; shotIndex += 1) {
        if (groupIndex === groupCount - 1 && shotIndex !== shotCount - 1) continue;
        const endSec = shotEnds[shotIndex];
        if (groupIndex === 0) {
          if (endSec > MAX_SEQUENCE_SEGMENT_DURATION_SEC + EPSILON) continue;
          const delta = groupIndex === groupCount - 1 ? 0 : endSec - desiredEnds[groupIndex];
          const backwardTieBreaker = delta < -EPSILON ? 0.000001 : 0;
          layers[groupIndex].set(shotIndex, {
            maxDurationSec: endSec,
            cost: delta * delta + backwardTieBreaker,
            previousShotIndex: -1,
          });
          continue;
        }
        let best: PartitionState | undefined;
        for (const [previousShotIndex, previous] of layers[groupIndex - 1]) {
          if (previousShotIndex >= shotIndex) continue;
          const durationSec = endSec - shotEnds[previousShotIndex];
          if (durationSec <= EPSILON || durationSec > MAX_SEQUENCE_SEGMENT_DURATION_SEC + EPSILON) continue;
          const delta = groupIndex === groupCount - 1 ? 0 : endSec - desiredEnds[groupIndex];
          // Choose the closest complete-shot boundary. If two choices are
          // equally distant, the tiny tie-breaker keeps the crossing shot in
          // the preceding segment, matching the intuitive "auto extend"
          // behavior without allowing large cumulative drift.
          const backwardTieBreaker = delta < -EPSILON ? 0.000001 : 0;
          const cost = previous.cost + delta * delta + backwardTieBreaker;
          const maxDurationSec = Math.max(previous.maxDurationSec, durationSec);
          if (
            !best
            || maxDurationSec < best.maxDurationSec - EPSILON
            || (Math.abs(maxDurationSec - best.maxDurationSec) <= EPSILON && cost < best.cost)
          ) {
            best = { maxDurationSec, cost, previousShotIndex };
          }
        }
        if (best) layers[groupIndex].set(shotIndex, best);
      }
    }
    let shotIndex = orderedShots.length - 1;
    if (!layers[groupCount - 1].has(shotIndex)) return undefined;
    const boundaries = Array<number>(groupCount);
    for (let groupIndex = groupCount - 1; groupIndex >= 0; groupIndex -= 1) {
      boundaries[groupIndex] = shotIndex;
      shotIndex = layers[groupIndex].get(shotIndex)!.previousShotIndex;
    }
    return boundaries;
  };

  const originalSegmentCount = segments.length;
  let boundaryShotIndexes: number[] | undefined;
  for (let groupCount = originalSegmentCount; groupCount <= orderedShots.length; groupCount += 1) {
    const desiredEnds = groupCount === originalSegmentCount
      ? segments.map((segment, index) => (
          index === segments.length - 1 ? totalDurationSec : roundSeconds(segment.globalEndSec)
        ))
      : Array.from({ length: groupCount }, (_, index) => (
          index === groupCount - 1
            ? totalDurationSec
            : roundSeconds(totalDurationSec * ((index + 1) / groupCount))
        ));
    boundaryShotIndexes = choosePartition(groupCount, desiredEnds);
    if (boundaryShotIndexes) break;
  }
  if (!boundaryShotIndexes) {
    throw new Error(`无法在单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒内按完整总镜头自动分段`);
  }
  if (boundaryShotIndexes.length > segments.length) {
    const alignedBoundaryTimes = boundaryShotIndexes
      .slice(0, -1)
      .map((shotIndex) => shotEnds[shotIndex]);
    segments = expandSegmentsAtAlignedBoundaries(input, segments, alignedBoundaryTimes);
    if (segments.length !== boundaryShotIndexes.length) {
      throw new Error('无法把新增的完整总镜头边界安全映射到原视频段');
    }
  }

  let previousShotIndex = -1;
  let globalStartSec = 0;
  let adjustedBoundaryCount = 0;
  const extendedSegments: Array<{ index: number; extensionSec: number }> = [];
  const changedSegmentIds: string[] = [];
  const lockedChangedSegments: Array<Pick<VideoSegment, 'id' | 'index'>> = [];
  const alignedSegments = segments.map((source, index) => {
    const boundaryShotIndex = boundaryShotIndexes[index];
    const globalEndSec = index === segments.length - 1
      ? totalDurationSec
      : shotEnds[boundaryShotIndex];
    const durationSec = roundSeconds(globalEndSec - globalStartSec);
    const sourceShotIds = orderedShots
      .slice(previousShotIndex + 1, boundaryShotIndex + 1)
      .map((shot) => shot.id);
    const timingChanged = Math.abs(source.globalStartSec - globalStartSec) > EPSILON
      || Math.abs(source.globalEndSec - globalEndSec) > EPSILON
      || Math.abs(source.durationSec - durationSec) > EPSILON;
    const linksChanged = !sameStringArray(source.sourceShotIds, sourceShotIds);
    if ((timingChanged || linksChanged) && source.locked) {
      lockedChangedSegments.push({ id: source.id, index: index + 1 });
    }
    const extensionSec = roundSeconds(durationSec - source.durationSec);
    if (index < segments.length - 1 && Math.abs(source.globalEndSec - globalEndSec) > EPSILON) {
      adjustedBoundaryCount += 1;
    }
    if (extensionSec > EPSILON) {
      extendedSegments.push({ index: index + 1, extensionSec });
    }
    const aligned: VideoSegment = {
      ...source,
      globalStartSec,
      globalEndSec,
      durationSec,
      sourceShotIds,
    };
    if (timingChanged) {
      if (extensionSec > EPSILON) aligned.autoExtendedBySec = extensionSec;
      else delete aligned.autoExtendedBySec;
    }
    if (timingChanged || linksChanged) {
      if (aligned.status !== 'planned') aligned.status = 'stale';
      delete aligned.failureReason;
    }
    if (timingChanged || linksChanged) changedSegmentIds.push(source.id);
    previousShotIndex = boundaryShotIndex;
    globalStartSec = globalEndSec;
    return aligned;
  });
  if (lockedChangedSegments.length) {
    throw new SequenceBoundaryAlignmentLockedError(lockedChangedSegments);
  }

  return {
    plan: {
      ...input,
      totalDurationSec,
      segments: alignedSegments,
    },
    adjustedBoundaryCount,
    extendedSegments,
    changedSegmentIds,
  };
};

interface ProvenanceBeat {
  id: string;
  index: number;
  text: string;
  sourceStart?: number;
  sourceEnd?: number;
}

interface ProvenanceScene {
  id: string;
  content: string;
  sourceStart?: number;
  sourceEnd?: number;
}

type ProvenanceShot = VideoShot & { sourceBeatIds?: string[] };

export interface ReconcileSequenceSegmentsOptions {
  /**
   * Preserve metadata authored by the AI semantic segmenter.  Source text,
   * beat ownership and descriptive fields are kept exactly as authored by
   * the model.  Scene links are still derived mechanically from the selected
   * beats because scenes are an index into the source story, not an AI cut
   * decision.
   */
  preserveAiMetadata?: boolean;
}

const compactSourceText = (value: string): string => String(value || '')
  .replace(/\s+/gu, '')
  .replace(/[，。！？!?；;：:、“”"'‘’「」『』（）()【】\[\]…—-]/gu, '');

const sourceRangesForScenes = (
  story: string,
  scenes: readonly ProvenanceScene[],
): Map<string, { start: number; end: number }> => {
  const ranges = new Map<string, { start: number; end: number }>();
  let cursor = 0;
  scenes.forEach((scene) => {
    const content = String(scene.content || '');
    if (!content) return;
    const hasPersistedStart = scene.sourceStart !== undefined;
    const hasPersistedEnd = scene.sourceEnd !== undefined;
    if (hasPersistedStart !== hasPersistedEnd) {
      throw new Error(`剧情场景 ${scene.id} 的 sourceStart 与 sourceEnd 必须成对提供。`);
    }
    const persistedStart = Number(scene.sourceStart);
    const persistedEnd = Number(scene.sourceEnd);
    const persistedRangeIsValid = hasPersistedStart
      && Number.isInteger(persistedStart)
      && Number.isInteger(persistedEnd)
      && persistedStart >= 0
      && persistedEnd > persistedStart
      && persistedEnd <= story.length
      && story.slice(persistedStart, persistedEnd) === content;
    if (hasPersistedStart && !persistedRangeIsValid) {
      throw new Error(`剧情场景 ${scene.id} 的来源区间无效或与原文不一致。`);
    }
    let start = persistedRangeIsValid ? persistedStart : story.indexOf(content, cursor);
    if (start < 0) start = story.indexOf(content);
    if (start < 0) return;
    const end = persistedRangeIsValid ? persistedEnd : start + content.length;
    ranges.set(scene.id, { start, end });
    cursor = Math.max(cursor, end);
  });
  return ranges;
};

const sourceRangesForBeats = (
  story: string,
  beats: readonly ProvenanceBeat[],
): Map<string, { start: number; end: number }> => {
  const ranges = new Map<string, { start: number; end: number }>();
  let cursor = 0;
  let previousPersistedEnd: number | undefined;
  beats.forEach((beat) => {
    const text = String(beat.text || '');
    const hasPersistedStart = beat.sourceStart !== undefined;
    const hasPersistedEnd = beat.sourceEnd !== undefined;
    if (hasPersistedStart !== hasPersistedEnd) {
      throw new Error(`剧情节拍 ${beat.id} 的 sourceStart 与 sourceEnd 必须成对提供。`);
    }
    const persistedStart = Number(beat.sourceStart);
    const persistedEnd = Number(beat.sourceEnd);
    const persistedRangeIsValid = hasPersistedStart
      && Number.isInteger(persistedStart)
      && Number.isInteger(persistedEnd)
      && persistedStart >= 0
      && persistedEnd > persistedStart
      && persistedEnd <= story.length
      && story.slice(persistedStart, persistedEnd) === text;
    if (hasPersistedStart && !persistedRangeIsValid) {
      throw new Error(`剧情节拍 ${beat.id} 的来源区间无效或与原文不一致。`);
    }
    if (
      persistedRangeIsValid
      && previousPersistedEnd !== undefined
      && persistedStart < previousPersistedEnd
    ) {
      throw new Error(`剧情节拍 ${beat.id} 的来源区间顺序错误或与前一节拍重叠。`);
    }
    let start = persistedRangeIsValid ? persistedStart : story.indexOf(text, cursor);
    if (start < 0) start = story.indexOf(text);
    if (start < 0) return;
    const end = persistedRangeIsValid ? persistedEnd : start + text.length;
    ranges.set(beat.id, { start, end });
    cursor = Math.max(cursor, end);
    if (persistedRangeIsValid) previousPersistedEnd = persistedEnd;
  });
  return ranges;
};

const validateMasterShotSourceRanges = (
  story: string,
  shots: readonly ProvenanceShot[],
  beatById: ReadonlyMap<string, ProvenanceBeat>,
  beatRanges: ReadonlyMap<string, { start: number; end: number }>,
  requireCompleteBeatCoverage = false,
): void => {
  const rangedCoverageByBeatId = new Map<string, Array<{ start: number; end: number; shotId: string }>>();
  const beatsWithUnrangedShot = new Set<string>();
  shots.forEach((shot) => {
    const sourceBeatIds = Array.isArray(shot.sourceBeatIds) ? shot.sourceBeatIds : [];
    if (!sourceBeatIds.length) return;
    if (new Set(sourceBeatIds).size !== sourceBeatIds.length) {
      throw new Error(`总镜头 ${shot.id} 的剧情节拍来源包含重复 ID。`);
    }
    const sourceBeats = sourceBeatIds.map((beatId) => {
      const beat = beatById.get(beatId);
      if (!beat) throw new Error(`总镜头 ${shot.id} 引用了未知剧情节拍 ${beatId}。`);
      return beat;
    });
    const shotHasStart = shot.sourceStart !== undefined;
    const shotHasEnd = shot.sourceEnd !== undefined;
    if (shotHasStart !== shotHasEnd) {
      throw new Error(`总镜头 ${shot.id} 的 sourceStart 与 sourceEnd 必须成对提供。`);
    }
    if (!shotHasStart) {
      sourceBeatIds.forEach((beatId) => beatsWithUnrangedShot.add(beatId));
      return;
    }
    const beatWithoutPersistedRange = sourceBeats.find(
      (beat) => beat.sourceStart === undefined || beat.sourceEnd === undefined,
    );
    if (beatWithoutPersistedRange) {
      throw new Error(`总镜头 ${shot.id} 引用的剧情节拍 ${beatWithoutPersistedRange.id} 缺少 sourceStart 与 sourceEnd。`);
    }
    const sourceStart = Number(shot.sourceStart);
    const sourceEnd = Number(shot.sourceEnd);
    if (
      !Number.isInteger(sourceStart)
      || !Number.isInteger(sourceEnd)
      || sourceStart < 0
      || sourceEnd <= sourceStart
      || sourceEnd > story.length
    ) {
      throw new Error(`总镜头 ${shot.id} 的来源区间无效。`);
    }
    const ranges = sourceBeats.map((beat) => beatRanges.get(beat.id));
    if (ranges.some((range) => !range)) {
      throw new Error(`总镜头 ${shot.id} 无法解析全部剧情节拍来源区间。`);
    }
    const knownRanges = ranges as Array<{ start: number; end: number }>;
    const overlappingBeatIds = [...beatRanges.entries()]
      .filter(([, range]) => range.end > sourceStart && range.start < sourceEnd)
      .map(([beatId]) => beatId);
    if (
      overlappingBeatIds.length !== sourceBeatIds.length
      || overlappingBeatIds.some((beatId, index) => beatId !== sourceBeatIds[index])
    ) {
      throw new Error(
        `总镜头 ${shot.id} 的来源区间 [${sourceStart},${sourceEnd}) 与实际相交的剧情节拍 ${overlappingBeatIds.join('、') || '无'} 不一致。`,
      );
    }
    sourceBeatIds.forEach((beatId, index) => {
      const range = knownRanges[index];
      rangedCoverageByBeatId.set(beatId, [
        ...(rangedCoverageByBeatId.get(beatId) || []),
        {
          start: Math.max(sourceStart, range.start),
          end: Math.min(sourceEnd, range.end),
          shotId: shot.id,
        },
      ]);
    });
  });

  beatRanges.forEach((range, beatId) => {
    if (beatsWithUnrangedShot.has(beatId)) return;
    const coverage = (rangedCoverageByBeatId.get(beatId) || [])
      .filter((item) => item.end > item.start)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    if (!coverage.length) {
      if (requireCompleteBeatCoverage) {
        throw new Error(`总镜头来源区间未覆盖剧情节拍 ${beatId}，两者不一致。`);
      }
      return;
    }
    let cursor = range.start;
    const uncovered: Array<{ start: number; end: number }> = [];
    coverage.forEach((item) => {
      if (item.start > cursor) uncovered.push({ start: cursor, end: item.start });
      cursor = Math.max(cursor, item.end);
    });
    if (cursor < range.end) uncovered.push({ start: cursor, end: range.end });
    const meaningfulGap = uncovered.find(({ start, end }) => /\S/u.test(story.slice(start, end)));
    if (meaningfulGap) {
      const shotIds = [...new Set(coverage.map((item) => item.shotId))].join('、');
      throw new Error(
        `总镜头 ${shotIds} 的来源区间未完整覆盖剧情节拍 ${beatId}（正文缺口 [${meaningfulGap.start},${meaningfulGap.end})），两者不一致。`,
      );
    }
  });
};

const shortSourceSummary = (value: string): string => {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length <= 72 ? compact : `${compact.slice(0, 70)}…`;
};

const sourceBoundaryState = (
  segmentIndex: number,
  lastBeatText: string,
  lastShot?: ProvenanceShot,
): string => {
  const withoutDialogue = stripDialogueTurns(lastBeatText);
  if (withoutDialogue === lastBeatText) {
    return `第 ${segmentIndex + 1} 段结束于：${shortSourceSummary(lastBeatText)}`;
  }

  const narrativeState = withoutDialogue
    .replace(/\s+/gu, ' ')
    .replace(/^[，,；;：:\s]+|[。！？!?；;：:\s]+$/gu, '')
    .trim();
  const subject = String(lastShot?.subject || '').replace(/\s+/gu, ' ').trim() || '当前说话者';
  const completedDialogueState = `${subject}已完成当前对白，保持段末姿态、位置、视线、道具状态和情绪。`;
  return `第 ${segmentIndex + 1} 段结束于：${narrativeState
    ? `${shortSourceSummary(narrativeState)}；`
    : ''}${completedDialogueState}`;
};

interface BeatPartitionState {
  cost: number;
  previousBeatEnd: number;
}

/**
 * Assign one non-empty, ordered source-beat slice to every segment. Shot
 * candidates may overlap at a boundary, so this must be solved globally
 * instead of letting the first segment greedily consume every shared beat.
 */
const solveOrderedBeatPartitions = (
  orderedBeatIds: readonly string[],
  candidateBeatIdsBySegment: readonly ReadonlySet<string>[],
  preferredBeatIdsBySegment: readonly ReadonlySet<string>[],
): string[][] | undefined => {
  const segmentCount = candidateBeatIdsBySegment.length;
  if (segmentCount === 0) return orderedBeatIds.length === 0 ? [] : undefined;
  const layers: Array<Map<number, BeatPartitionState>> = Array.from(
    { length: segmentCount + 1 },
    () => new Map<number, BeatPartitionState>(),
  );
  layers[0].set(0, { cost: 0, previousBeatEnd: -1 });

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const candidates = candidateBeatIdsBySegment[segmentIndex];
    const preferred = preferredBeatIdsBySegment[segmentIndex];
    const remainingSegmentCount = segmentCount - segmentIndex - 1;
    const maximumBeatEnd = orderedBeatIds.length - remainingSegmentCount;
    for (const [beatStart, previous] of layers[segmentIndex]) {
      let preferredMatchCount = 0;
      for (let beatEnd = beatStart + 1; beatEnd <= maximumBeatEnd; beatEnd += 1) {
        const beatId = orderedBeatIds[beatEnd - 1];
        if (!candidates.has(beatId)) break;
        if (preferred.has(beatId)) preferredMatchCount += 1;
        const sliceLength = beatEnd - beatStart;
        const preferenceCost = sliceLength + preferred.size - 2 * preferredMatchCount;
        const cost = previous.cost + preferenceCost;
        const existing = layers[segmentIndex + 1].get(beatEnd);
        if (!existing || cost < existing.cost) {
          layers[segmentIndex + 1].set(beatEnd, {
            cost,
            previousBeatEnd: beatStart,
          });
        }
      }
    }
  }

  if (!layers[segmentCount].has(orderedBeatIds.length)) return undefined;
  const partitions = Array<string[]>(segmentCount);
  let beatEnd = orderedBeatIds.length;
  for (let segmentIndex = segmentCount; segmentIndex > 0; segmentIndex -= 1) {
    const state = layers[segmentIndex].get(beatEnd);
    if (!state) return undefined;
    partitions[segmentIndex - 1] = orderedBeatIds.slice(state.previousBeatEnd, beatEnd);
    beatEnd = state.previousBeatEnd;
  }
  return partitions;
};

/**
 * Validate an AI-owned beat partition without selecting a replacement cut.
 *
 * The legacy reconciliation path uses `solveOrderedBeatPartitions` to repair
 * beat ownership from shot candidates.  That is intentionally not allowed for
 * an AI-authored plan: doing so would silently move a beat to another segment
 * and make the persisted plan disagree with the model's semantic decision.
 * This helper therefore only checks that each segment declares a non-empty,
 * known, contiguous slice and full source coverage. Beat-only plans retain an
 * exact cover; complete AI shot groups may reference a boundary beat again
 * only when every occurrence is backed by its selected master shots.
 */
const validateAiBeatPartition = (
  segments: readonly VideoSegment[],
  orderedBeatIds: readonly string[],
  beatById: ReadonlyMap<string, ProvenanceBeat>,
  shotById?: ReadonlyMap<string, ProvenanceShot>,
): string[][] => {
  const beatOrder = new Map(orderedBeatIds.map((beatId, index) => [beatId, index] as const));
  const seen = new Set<string>();
  const shotBackedBeats = new Map<string, boolean>();
  let cursor = 0;

  const partitions = segments.map((segment, segmentIndex) => {
    const rawIds = Array.isArray(segment.sourceBeatIds)
      ? segment.sourceBeatIds
      : [];
    const ids = rawIds.map((beatId) => String(beatId).trim()).filter(Boolean);
    if (!ids.length) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段缺少剧情节拍归属`);
    }
    const shotBeatIds = new Set((segment.sourceShotIds || [])
      .flatMap((shotId) => shotById?.get(shotId)?.sourceBeatIds || []));
    const positions = ids.map((beatId) => {
      if (!beatById.has(beatId)) {
        throw new Error(`AI 第 ${segmentIndex + 1} 段引用未知剧情节拍：${beatId}`);
      }
      const position = beatOrder.get(beatId);
      if (position === undefined) {
        throw new Error(`AI 第 ${segmentIndex + 1} 段引用未知剧情节拍：${beatId}`);
      }
      if (seen.has(beatId) && (!shotBackedBeats.get(beatId) || !shotBeatIds.has(beatId))) {
        throw new Error(`AI 剧情节拍 ${beatId} 被多个视频段重复归属`);
      }
      return position;
    });
    const newPositions = positions.filter((position) => !seen.has(orderedBeatIds[position]));
    if (
      (newPositions.length > 0 && newPositions[0] !== cursor)
      || positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)
    ) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段剧情节拍范围不连续或顺序错误`);
    }
    ids.forEach((beatId) => {
      seen.add(beatId);
      shotBackedBeats.set(beatId, (shotBackedBeats.get(beatId) ?? true) && shotBeatIds.has(beatId));
    });
    if (newPositions.length) cursor = newPositions[newPositions.length - 1] + 1;
    return ids;
  });
  if (cursor !== orderedBeatIds.length || seen.size !== orderedBeatIds.length) {
    const missing = orderedBeatIds.filter((beatId) => !seen.has(beatId));
    throw new Error(`AI 分段遗漏剧情节拍：${missing.join('、') || '未知'}`);
  }
  return partitions;
};

/**
 * Make the authoritative master-shot provenance the sole owner of segment
 * beats, source text and local scene context after shot-boundary alignment.
 * This prevents a pre-alignment beat allocation from drifting away from the
 * actual shots delivered in a segment.
 */
export const reconcileSequenceSegmentsToShotProvenance = (
  plan: VideoSequencePlan,
  masterShots: readonly ProvenanceShot[],
  sourceBeats: readonly ProvenanceBeat[],
  sourceScenes: readonly ProvenanceScene[],
  options: ReconcileSequenceSegmentsOptions = {},
): VideoSequencePlan => {
  // Semantic ownership is AI-authored original-story evidence. It must not
  // enter the legacy beat allocator or inherit unrelated master-shot links.
  if (isSemanticSequencePlan(plan)) return plan;
  const preserveAiMetadata = options.preserveAiMetadata === true;
  const beatById = new Map(sourceBeats.map((beat) => [beat.id, beat]));
  const beatOrder = new Map(sourceBeats.map((beat, index) => [beat.id, index]));
  const shotById = new Map(masterShots.map((shot) => [shot.id, shot]));
  const beatRanges = sourceRangesForBeats(plan.sourceStoryContent, sourceBeats);
  const hasAiShotReferences = preserveAiMetadata && hasAiSequenceShotLinks(plan);
  const modelOwnsNarrative = hasAiShotReferences && modelOwnsMasterNarrative(masterShots);
  if (!modelOwnsNarrative) validateMasterShotSourceRanges(
    plan.sourceStoryContent,
    masterShots,
    beatById,
    beatRanges,
    preserveAiMetadata,
  );
  const sceneRanges = sourceRangesForScenes(plan.sourceStoryContent, sourceScenes);
  const orderedBeatIds = sourceBeats.map((beat) => beat.id);
  if (hasAiShotReferences) assertAiSequenceSegmentShotCoverage(plan, masterShots);
  if (!hasAiShotReferences && orderedBeatIds.length < plan.segments.length) {
    throw new Error(
      `剧情节拍数量 ${orderedBeatIds.length} 少于视频段数量 ${plan.segments.length}，无法让每段唯一认领至少一个剧情节拍`,
    );
  }

  // The AI segmenter already owns the semantic beat partition.  Keep that
  // partition and all of its descriptive fields intact; only derive scene
  // links (an index into the source story) and canonicalize shot IDs.  In
  // particular, do not call the legacy dynamic-programming allocator here:
  // it would silently move beats between AI-authored segments.
  if (preserveAiMetadata) {
    const aiBeatPartitions = modelOwnsNarrative
      ? plan.segments.map((segment) => [...new Set(segment.sourceBeatIds || [])].filter((id) => beatById.has(id)))
      : validateAiBeatPartition(plan.segments, orderedBeatIds, beatById, hasAiShotReferences ? shotById : undefined);
    const seenShotIds = new Set<string>();
    const segments = plan.segments.map((segment, segmentIndex) => {
      const sourceShotIds = segment.sourceShotIds === undefined
        ? undefined
        : [...new Set(segment.sourceShotIds.map((shotId) => shotId.trim()).filter(Boolean))];
      (sourceShotIds || []).forEach((shotId) => {
        if (!shotById.has(shotId)) {
          throw new Error(`AI 第 ${segmentIndex + 1} 段引用未知总镜头：${shotId}`);
        }
        if (seenShotIds.has(shotId)) {
          throw new Error(`AI 总镜头 ${shotId} 被多个视频段重复归属`);
        }
        seenShotIds.add(shotId);
      });

      const sourceBeatIds = aiBeatPartitions[segmentIndex];
      const selectedBeats = sourceBeatIds
        .map((beatId) => beatById.get(beatId))
        .filter((beat): beat is ProvenanceBeat => Boolean(beat));
      const selectedRanges = sourceBeatIds
        .map((beatId) => beatRanges.get(beatId))
        .filter((range): range is { start: number; end: number } => Boolean(range));
      const selectedContent = selectedBeats.map((beat) => beat.text).join('');
      const selectedCompact = compactSourceText(selectedContent);
      const sourceSceneIds = sourceScenes
        .filter((scene) => {
          const sceneRange = sceneRanges.get(scene.id);
          if (sceneRange) {
            return selectedRanges.some((range) => (
              range.end > sceneRange.start && range.start < sceneRange.end
            ));
          }
          const sceneCompact = compactSourceText(scene.content);
          return Boolean(
            selectedCompact
            && sceneCompact
            && (selectedCompact.includes(sceneCompact) || sceneCompact.includes(selectedCompact)),
          );
        })
        .map((scene) => scene.id);

      // Preserve AI content, summary, continuity and all other metadata. The
      // materializer has already reconstructed canonical content from the
      // source beats; this pass must not replace it with a locally repartitioned
      // string or a locally derived exit state.
      return {
        ...segment,
        sourceBeatIds,
        sourceSceneIds: modelOwnsNarrative && sourceSceneIds.length === 0
          ? [...segment.sourceSceneIds]
          : sourceSceneIds,
        sourceShotIds,
      };
    });
    return { ...plan, segments };
  }

  const shotOwnerById = new Map<string, number>();
  const segmentCandidates = plan.segments.map((segment, segmentIndex) => {
    const sourceShotIds = segment.sourceShotIds === undefined
      ? undefined
      : [...new Set(segment.sourceShotIds.map((shotId) => shotId.trim()).filter(Boolean))];
    (sourceShotIds || []).forEach((shotId) => {
      const previousOwner = shotOwnerById.get(shotId);
      if (previousOwner !== undefined && previousOwner !== segmentIndex) {
        throw new Error(
          `总镜头 ${shotId} 重复归属多个视频段（第 ${previousOwner + 1} 段与第 ${segmentIndex + 1} 段）`,
        );
      }
      shotOwnerById.set(shotId, segmentIndex);
    });
    const referencedShots = (sourceShotIds || [])
      .map((shotId) => shotById.get(shotId))
      .filter((shot): shot is ProvenanceShot => Boolean(shot));
    const hasShotBeatProvenance = referencedShots.some(
      (shot) => Array.isArray(shot.sourceBeatIds) && shot.sourceBeatIds.length > 0,
    );
    const orderedKnownBeatIds = (beatIds: readonly string[]): string[] => [...new Set(beatIds)]
      .filter((beatId) => beatById.has(beatId))
      .sort((left, right) => (
        (beatOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
        - (beatOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
      ));
    const legacyBeatIds = orderedKnownBeatIds(
      Array.isArray(segment.sourceBeatIds) ? segment.sourceBeatIds : [],
    );
    const shotBeatIds = orderedKnownBeatIds(
      referencedShots.flatMap((shot) => (
        Array.isArray(shot.sourceBeatIds) ? shot.sourceBeatIds : []
      )),
    );
    return {
      sourceShotIds,
      candidateBeatIds: hasShotBeatProvenance ? shotBeatIds : legacyBeatIds,
      preferredBeatIds: legacyBeatIds,
    };
  });
  const beatPartitions = solveOrderedBeatPartitions(
    orderedBeatIds,
    segmentCandidates.map((candidate) => new Set(candidate.candidateBeatIds)),
    segmentCandidates.map((candidate) => new Set(candidate.preferredBeatIds)),
  );
  if (!beatPartitions) {
    throw new Error(
      '无法按总镜头来源把剧情节拍按顺序唯一分配给每个视频段；请调整分段边界或总镜头节拍来源',
    );
  }

  let previousExitState = '故事起始，保持原剧情设定。';

  const segments = plan.segments.map((segment, segmentIndex) => {
    const contentOverridden = segment.contentOverridden === true;
    const sourceBeatIds = beatPartitions[segmentIndex];
    const selectedBeats = sourceBeatIds
      .map((beatId) => beatById.get(beatId))
      .filter((beat): beat is ProvenanceBeat => Boolean(beat));
    const content = selectedBeats.map((beat) => beat.text).join('');
    const selectedRanges = sourceBeatIds
      .map((beatId) => beatRanges.get(beatId))
      .filter((range): range is { start: number; end: number } => Boolean(range));
    const selectedCompact = compactSourceText(content);
    const sourceSceneIds = sourceScenes
      .filter((scene) => {
        const sceneRange = sceneRanges.get(scene.id);
        if (sceneRange) {
          return selectedRanges.some((range) => (
            range.end > sceneRange.start && range.start < sceneRange.end
          ));
        }
        const sceneCompact = compactSourceText(scene.content);
        return Boolean(
          selectedCompact
          && sceneCompact
          && (selectedCompact.includes(sceneCompact) || sceneCompact.includes(selectedCompact)),
        );
      })
      .map((scene) => scene.id);
    const lastBeatText = selectedBeats[selectedBeats.length - 1]?.text || content || segment.content;
    const lastShot = [...(segmentCandidates[segmentIndex].sourceShotIds || [])]
      .reverse()
      .map((shotId) => shotById.get(shotId))
      .find((shot): shot is ProvenanceShot => Boolean(shot));
    const derivedExitState = sourceBoundaryState(segmentIndex, lastBeatText, lastShot);
    const preservedExitState = typeof segment.exitState === 'string' && segment.exitState.trim()
      ? segment.exitState.trim()
      : derivedExitState;
    const reconciled: VideoSegment = {
      ...segment,
      content: contentOverridden ? segment.content : content,
      summary: contentOverridden || preserveAiMetadata
        ? segment.summary
        : shortSourceSummary(content),
      sourceBeatIds,
      sourceSceneIds,
      sourceShotIds: segmentCandidates[segmentIndex].sourceShotIds,
      entryState: preserveAiMetadata
        ? (typeof segment.entryState === 'string' && segment.entryState.trim()
          ? segment.entryState.trim()
          : segmentIndex === 0 ? '故事起始，保持原剧情设定。' : previousExitState)
        : segmentIndex === 0 ? '故事起始，保持原剧情设定。' : previousExitState,
      exitState: preserveAiMetadata ? preservedExitState : derivedExitState,
    };
    previousExitState = reconciled.exitState;
    return reconciled;
  });

  return { ...plan, segments };
};

/**
 * Cut a master timeline at a segment's global range and reset the copied
 * shots to the segment's local zero. A shot crossing a boundary is clipped,
 * never regenerated from the segment's raw story text.
 */
const RENDERER_CAMERA_AXIS_REFERENCE = /(^|；)(镜头：[^；\r\n]*?)（轴线：(主体运动方向与第\d+镜连续|建立当前主体运动方向|与前一镜保持主体运动方向连续)）/u;

const rebaseDerivedShotAxis = (
  prompt: string,
  localIndex: number,
  isOpeningSegment: boolean,
): string => prompt.replace(
  RENDERER_CAMERA_AXIS_REFERENCE,
  (_match, fieldBoundary: string, cameraPrefix: string, sourceAxis: string) => {
    const rebasedAxis = localIndex === 0
      ? isOpeningSegment
        ? '（轴线：建立本镜轴线）'
        : '（轴线：承接上一段末镜）'
      : sourceAxis.startsWith('主体运动方向与第')
        ? '（轴线：主体运动方向与上一镜连续）'
        : '（轴线：与前一镜保持主体运动方向连续）';
    return `${fieldBoundary}${cameraPrefix}${rebasedAxis}`;
  },
);

export const sliceMasterShotsForSegment = (
  masterShots: readonly VideoShot[],
  segment: Pick<VideoSegment, 'id' | 'globalStartSec' | 'globalEndSec' | 'durationSec'>,
): MasterShotSlice => {
  const start = Number(segment.globalStartSec);
  const end = Number(segment.globalEndSec);
  const duration = Number(segment.durationSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(duration) || end <= start || duration <= 0) {
    return { sourceShotIds: [], shots: [] };
  }
  const overlapping = masterShots
    .filter((shot) => Number.isFinite(shot.startSec) && Number.isFinite(shot.endSec))
    .filter((shot) => shot.endSec > start + EPSILON && shot.startSec < end - EPSILON)
    .sort((left, right) => left.startSec - right.startSec || left.index - right.index);
  const clipped = overlapping.flatMap((shot) => {
    const localStart = roundSeconds(Math.max(0, shot.startSec - start));
    const localEnd = roundSeconds(Math.min(duration, shot.endSec - start));
    return localEnd - localStart > EPSILON
      ? [{ shot, localStart, localEnd }]
      : [];
  });
  const sourceShotIds = clipped.map(({ shot }) => shot.id);
  const shots = clipped.map(({ shot, localStart, localEnd }, index) => {
    const prompt = shot.prompt?.trim()
      ? rebaseDerivedShotAxis(
          retimeMasterShotPrompt(
            normalizeMasterShotPromptSoundCueTimes(shot.prompt, shot.startSec, shot.endSec),
            localStart,
            localEnd,
          ),
          index,
          start <= EPSILON,
        )
      : '';
    return {
      ...shot,
      id: `${shot.id}__${segment.id}`,
      index: index + 1,
      startSec: localStart,
      endSec: localEnd,
      sound: normalizeAbsoluteSoundCueTimes(shot.sound, shot.startSec, shot.endSec),
      prompt,
    };
  });
  return { sourceShotIds, shots };
};

/**
 * Materialize the boundaries authored by the AI long-story planner.  The
 * planner is allowed to choose only complete master-shot groups; this helper
 * deliberately performs no character/word-weight allocation.  It merely
 * resolves the referenced shot IDs to their authoritative time ranges and
 * creates the persistence shape consumed by the existing sequence UI.
 */
export const materializeAiSequenceSegments = (
  plan: VideoSequencePlan,
  masterShots: readonly VideoShot[],
  aiSegments: readonly AiSequenceSegmentPlan[],
  sourceBeats: readonly Pick<StoryBeat, 'id' | 'index' | 'text'>[],
  sourceSceneIds: readonly string[] = [],
): VideoSequencePlan => {
  if (!Array.isArray(aiSegments) || aiSegments.length === 0) {
    throw new Error('AI 没有返回可用的视频段');
  }
  const orderedShots = masterShots
    .filter((shot) => Number.isFinite(shot.startSec) && Number.isFinite(shot.endSec))
    .filter((shot) => shot.endSec > shot.startSec)
    .sort((left, right) => left.startSec - right.startSec || left.index - right.index);
  if (orderedShots.length === 0) throw new Error('全片总时间轴没有可用镜头');
  if (orderedShots.length !== masterShots.length) throw new Error('全片总镜头包含无效时间范围，不能忽略后继续分段');
  if (new Set(orderedShots.map((shot) => shot.id)).size !== orderedShots.length) throw new Error('全片总镜头 ID 重复');
  if (orderedShots.some((shot, index) => !shot.id.trim() || (index > 0 && Math.abs(shot.startSec - orderedShots[index - 1].endSec) > EPSILON))) {
    throw new Error('全片总镜头 ID 缺失或时间轴存在空档、重叠');
  }
  const modelOwnsNarrative = modelOwnsMasterNarrative(orderedShots);
  const shotPosition = new Map(orderedShots.map((shot, index) => [shot.id, index] as const));
  const expectedShotIds = orderedShots.map((shot) => shot.id);
  const seenShotIds = new Set<string>();
  const beatById = new Map(sourceBeats.map((beat) => [beat.id, beat] as const));
  const beatOrder = new Map(sourceBeats.map((beat, index) => [beat.id, index] as const));
  const assignedBeatOwner = new Map<string, { segmentIndex: number; shotBacked: boolean }>();
  let nextShotPosition = 0;
  let previousExitState = '故事起始，保持原剧情设定。';

  const segments: VideoSegment[] = aiSegments.map((draft, segmentIndex) => {
    if (!draft || typeof draft !== 'object') {
      throw new Error(`AI 第 ${segmentIndex + 1} 段不是有效对象`);
    }
    // `Array.isArray` intentionally narrows to `any[]`; keep the value
    // unknown until the explicit string guard below so strict mode does not
    // leak an implicit-any callback into the materializer.
    const rawShotIds: readonly unknown[] = Array.isArray(draft.sourceShotIds)
      ? draft.sourceShotIds
      : [];
    const shotIds: string[] = rawShotIds
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
    if (shotIds.length === 0) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段没有完整总镜头归属`);
    }
    const positions: number[] = shotIds.map((shotId: string) => {
      const position = shotPosition.get(shotId);
      if (position === undefined) throw new Error(`AI 引用了未知总镜头：${shotId}`);
      if (seenShotIds.has(shotId)) throw new Error(`AI 重复归属总镜头：${shotId}`);
      return position;
    });
    if (positions[0] !== nextShotPosition) {
      throw new Error(
        `AI 第 ${segmentIndex + 1} 段没有从下一个连续总镜头开始（应为 ${expectedShotIds[nextShotPosition] || '无'}）`,
      );
    }
    if (positions.some((position: number, index: number) => index > 0 && position !== positions[index - 1] + 1)) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段的总镜头范围不连续`);
    }
    shotIds.forEach((shotId: string) => seenShotIds.add(shotId));
    nextShotPosition = positions[positions.length - 1] + 1;
    const groupedShots: VideoShot[] = positions.map((position: number) => orderedShots[position]);
    const globalStartSec = roundSeconds(groupedShots[0].startSec);
    const globalEndSec = roundSeconds(groupedShots[groupedShots.length - 1].endSec);
    const durationSec = roundSeconds(globalEndSec - globalStartSec);
    if (durationSec <= 0) throw new Error(`AI 第 ${segmentIndex + 1} 段时长无效`);
    if (!modelOwnsNarrative && durationSec > MAX_SEQUENCE_SEGMENT_DURATION_SEC + EPSILON) {
      throw new Error(
        `AI 第 ${segmentIndex + 1} 段时长 ${durationSec} 秒超过单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒`,
      );
    }
    if (draft.durationSec !== undefined) {
      const reported = Number(draft.durationSec);
      if (!Number.isFinite(reported) || Math.abs(roundSeconds(reported) - durationSec) > EPSILON) {
        throw new Error(`AI 第 ${segmentIndex + 1} 段自报时长与总镜头时间不一致`);
      }
    }
    const rawShotBeatIds: string[] = [...new Set<string>(groupedShots.flatMap((shot: VideoShot) => shot.sourceBeatIds || []))];
    const unknownShotBeatIds = rawShotBeatIds.filter((beatId: string) => !beatById.has(beatId));
    if (!modelOwnsNarrative && unknownShotBeatIds.length) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段所选总镜头引用未知剧情节拍：${unknownShotBeatIds.join('、')}`);
    }
    const shotBeatIds: string[] = rawShotBeatIds
      .filter((beatId) => !modelOwnsNarrative || beatById.has(beatId))
      .sort((left: string, right: string) => (beatOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (beatOrder.get(right) ?? Number.MAX_SAFE_INTEGER));
    const rawDeclaredBeatIds: string[] = Array.isArray(draft.sourceBeatIds)
      ? (draft.sourceBeatIds as readonly unknown[])
        .filter((value): value is string => typeof value === 'string')
        .map((value: string) => value.trim())
        .filter(Boolean)
      : [];
    const declaredBeatIds = modelOwnsNarrative
      ? [...new Set(rawDeclaredBeatIds)].filter((beatId) => beatById.has(beatId))
      : rawDeclaredBeatIds;
    declaredBeatIds.forEach((beatId: string) => {
      if (!beatById.has(beatId)) {
        throw new Error(`AI 第 ${segmentIndex + 1} 段引用了未知剧情节拍：${beatId}`);
      }
    });
    if (
      !modelOwnsNarrative
      && declaredBeatIds.length > 0
      && shotBeatIds.length > 0
      && (
        declaredBeatIds.length !== shotBeatIds.length
        || declaredBeatIds.some((beatId: string) => !shotBeatIds.includes(beatId))
      )
    ) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段 sourceBeatIds 与所选总镜头的剧情来源不一致`);
    }
    // Prefer the model declaration when present (it is already validated for
    // original-story order); otherwise use the authoritative shot provenance.
    const sourceBeatIds: string[] = (declaredBeatIds.length > 0 ? declaredBeatIds : shotBeatIds)
      .sort((left: string, right: string) => (beatOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (beatOrder.get(right) ?? Number.MAX_SAFE_INTEGER));
    if (!modelOwnsNarrative && sourceBeatIds.length === 0) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段没有可追踪的剧情节拍`);
    }
    if (!modelOwnsNarrative && sourceBeatIds.some((beatId: string, index: number) => (
      index > 0
      && (beatOrder.get(beatId) ?? -1) !== (beatOrder.get(sourceBeatIds[index - 1]) ?? -1) + 1
    ))) {
      throw new Error(`AI 第 ${segmentIndex + 1} 段剧情节拍范围不连续`);
    }
    sourceBeatIds.forEach((beatId: string) => {
      if (modelOwnsNarrative) return;
      const previousOwner = assignedBeatOwner.get(beatId);
      const shotBacked = shotBeatIds.includes(beatId);
      if (previousOwner !== undefined && (!previousOwner.shotBacked || !shotBacked)) {
        throw new Error(`AI 剧情节拍 ${beatId} 被多个视频段重复归属（第 ${previousOwner.segmentIndex + 1} 段与第 ${segmentIndex + 1} 段），缺少对应总镜头来源`);
      }
      assignedBeatOwner.set(beatId, { segmentIndex, shotBacked });
    });
    // A full model-authored timeline need not have byte-for-byte source
    // excerpts. Keep the AI's segment prose (or its actual shot prose), not a
    // replacement assembled from a partial local beat match. The full original
    // story remains unchanged in plan.sourceStoryContent.
    const content = modelOwnsNarrative
      ? (typeof draft.content === 'string' && draft.content.trim() ? draft.content.trim()
        : [...new Set(groupedShots.map((shot) => shot.sourceExcerpt?.trim() || shot.action?.trim() || shot.prompt?.trim() || '').filter(Boolean))].join('\n')
          || (typeof draft.summary === 'string' ? draft.summary.trim() : ''))
      : sourceBeatIds.map((beatId) => beatById.get(beatId)?.text || '').join('');
    const title = typeof draft.title === 'string' && draft.title.trim()
      ? draft.title.trim()
      : `第 ${segmentIndex + 1} 段`;
    const summary = typeof draft.summary === 'string' && draft.summary.trim()
      ? draft.summary.trim()
      : content.slice(0, 72);
    const narrativePurpose = typeof draft.narrativePurpose === 'string' && draft.narrativePurpose.trim()
      ? draft.narrativePurpose.trim()
      : '推进当前剧情节拍并完成本段动作结果';
    const exitState = typeof draft.exitState === 'string' && draft.exitState.trim()
      ? draft.exitState.trim()
      : `第 ${segmentIndex + 1} 段结束，保持最后一镜的姿态、位置、视线、道具和声音状态。`;
    const transitionHint = typeof draft.transitionHint === 'string' && draft.transitionHint.trim()
      ? draft.transitionHint.trim()
      : '承接下一段的入口状态，保持人物、场景、光线、动作方向和声音连续';
    const boundaryReason = typeof draft.boundaryReason === 'string' && draft.boundaryReason.trim()
      ? draft.boundaryReason.trim()
      : undefined;
    const continuityPack = typeof draft.continuityPack === 'string' && draft.continuityPack.trim()
      ? draft.continuityPack.trim()
      : undefined;
    const segment: VideoSegment = {
      id: `${plan.id}_segment_${segmentIndex + 1}`,
      index: segmentIndex + 1,
      title,
      globalStartSec,
      globalEndSec,
      durationSec,
      content,
      summary,
      sourceSceneIds: [...new Set(sourceSceneIds.map((id) => id.trim()).filter(Boolean))],
      sourceBeatIds,
      sourceShotIds: shotIds,
      narrativePurpose,
      entryState: segmentIndex === 0 || modelOwnsNarrative ? (typeof draft.entryState === 'string' && draft.entryState.trim() ? draft.entryState.trim() : previousExitState) : previousExitState,
      exitState,
      transitionHint,
      boundaryReason,
      continuityPack,
      status: 'planned',
      locked: false,
    };
    previousExitState = exitState;
    return segment;
  });

  if (nextShotPosition !== orderedShots.length || seenShotIds.size !== orderedShots.length) {
    const missing = expectedShotIds.filter((shotId) => !seenShotIds.has(shotId));
    throw new Error(`AI 分段遗漏总镜头：${missing.join('、') || '未知'}`);
  }
  const missingBeatIds = sourceBeats
    .map((beat) => beat.id)
    .filter((beatId) => !assignedBeatOwner.has(beatId));
  if (!modelOwnsNarrative && missingBeatIds.length) {
    throw new Error(`AI 分段遗漏剧情节拍：${missingBeatIds.join('、')}`);
  }
  if (Math.abs(segments[0].globalStartSec) > EPSILON) {
    throw new Error('AI 分段没有从 0 秒开始');
  }
  if (Math.abs(segments[segments.length - 1].globalEndSec - plan.totalDurationSec) > EPSILON) {
    throw new Error('AI 分段没有覆盖到全片结束时间');
  }
  return {
    ...plan,
    segmentationSource: 'ai',
    segments,
  };
};

const cloneStringArray = (
  value: unknown,
  field: 'sourceSceneIds' | 'sourceBeatIds',
  position: number,
): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`第 ${position + 1} 段 ${field} 必须是字符串数组`);
  }
  return [...value];
};

const cloneOptionalStringArray = (
  value: unknown,
  field: 'sourceShotIds',
  position: number,
): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`第 ${position + 1} 段 ${field} 必须是字符串数组`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
};

const cloneSegment = (segment: VideoSegment, position = Math.max(0, (segment?.index || 1) - 1)): VideoSegment => {
  if (!segment || typeof segment !== 'object') {
    throw new Error(`第 ${position + 1} 段数据格式无效`);
  }
  return {
    ...segment,
    sourceSceneIds: cloneStringArray(segment.sourceSceneIds, 'sourceSceneIds', position),
    sourceBeatIds: cloneStringArray(segment.sourceBeatIds, 'sourceBeatIds', position),
    sourceShotIds: cloneOptionalStringArray(segment.sourceShotIds, 'sourceShotIds', position),
    ...(segment.semanticSource !== undefined ? { semanticSource: structuredClone(segment.semanticSource) } : {}),
  };
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const segmentIndexById = (plan: VideoSequencePlan, segmentId: string): number => {
  const index = plan.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) throw new Error(`找不到视频段 ${segmentId}`);
  return index;
};

const markStaleWindow = (
  segments: VideoSegment[],
  startIndex: number,
  count: number,
): void => {
  segments.forEach((segment, index) => {
    if (index >= startIndex && index < startIndex + count) segment.status = 'stale';
  });
};

/** Segment ranges may move when a plan is edited; cached master-shot links
 * must then be rebuilt from the authoritative timeline on the next run. */
const clearSourceShotIds = (segments: VideoSegment[]): void => {
  segments.forEach((segment) => delete segment.sourceShotIds);
};

/**
 * Clone a plan, rebuild its one-based indexes and continuous global timeline,
 * and reject structures that cannot be safely saved.
 */
export const validateAndNormalizeSequencePlan = (
  input: VideoSequencePlan,
): VideoSequencePlan => {
  if (!Number.isFinite(input.segmentDurationSec) || input.segmentDurationSec <= 0) {
    throw new Error('目标单段时长必须是大于 0 的有限秒数');
  }
  if (!Array.isArray(input.segments) || input.segments.length === 0) {
    throw new Error('全片计划至少包含一个视频段');
  }

  if (isSemanticSequencePlan(input)) {
    const segmentDurationSec = roundSeconds(input.segmentDurationSec);
    const segments = input.segments.map((source, position) => {
      const segment = cloneSegment(source, position);
      if (!Number.isFinite(segment.durationSec) || Math.abs(segment.durationSec - segmentDurationSec) > EPSILON) {
        throw new Error(`第 ${position + 1} 段必须保持所选 ${segmentDurationSec} 秒；需要增减段数时，请由 AI 重新规划语义分段。`);
      }
      return {
        ...segment,
        index: position + 1,
        durationSec: segmentDurationSec,
        globalStartSec: roundSeconds(position * segmentDurationSec),
        globalEndSec: roundSeconds((position + 1) * segmentDurationSec),
      };
    });
    const normalized: VideoSequencePlan = {
      ...input,
      segmentDurationSec,
      totalDurationSec: roundSeconds(segments.length * segmentDurationSec),
      ...(input.semanticPlanningSnapshot !== undefined
        ? { semanticPlanningSnapshot: structuredClone(input.semanticPlanningSnapshot) }
        : {}),
      segments,
    };
    const errors = validateSemanticSequencePlan(normalized);
    if (errors.length) throw new Error(errors.join('；'));
    return normalized;
  }

  const segmentDurationSec = roundSeconds(input.segmentDurationSec);
  const segmentIds = new Set<string>();
  const beatIds = new Set<string>();
  const hasAiShotReferences = hasAiSequenceShotLinks(input);
  const shotIds = new Set<string>();
  let cursor = 0;
  let previousExitState: string | undefined;

  const segments = input.segments.map((source, position) => {
    const segment = cloneSegment(source, position);
    if (typeof segment.id !== 'string' || !segment.id.trim()) {
      throw new Error(`第 ${position + 1} 段缺少有效的视频段 ID`);
    }
    if (segmentIds.has(segment.id)) throw new Error(`存在重复的视频段 ID：${segment.id}`);
    segmentIds.add(segment.id);

    if (!Number.isFinite(segment.durationSec) || segment.durationSec <= 0) {
      throw new Error(`第 ${position + 1} 段时长必须大于 0 秒`);
    }
    const durationSec = roundSeconds(segment.durationSec);
    if (durationSec <= 0) throw new Error(`第 ${position + 1} 段时长精度不足 0.01 秒`);
    if (!hasAiShotReferences && durationSec > MAX_SEQUENCE_SEGMENT_DURATION_SEC + EPSILON) {
      throw new Error(`第 ${position + 1} 段时长 ${durationSec} 秒超过单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒`);
    }

    if (!Array.isArray(segment.sourceBeatIds) || (!hasAiShotReferences && segment.sourceBeatIds.length === 0)) {
      throw new Error(`第 ${position + 1} 段至少需要一个剧情节拍`);
    }
    if (hasAiShotReferences) {
      segment.sourceShotIds!.forEach((shotId) => {
        if (shotIds.has(shotId)) throw new Error(`存在重复归属的总镜头：${shotId}`);
        shotIds.add(shotId);
      });
    }
    const segmentBeatIds = new Set<string>();
    segment.sourceBeatIds.forEach((beatId) => {
      if (!beatId.trim()) throw new Error(`第 ${position + 1} 段包含空剧情节拍 ID`);
      if (beatIds.has(beatId) && (!hasAiShotReferences || segmentBeatIds.has(beatId))) {
        throw new Error(`存在重复的剧情节拍：${beatId}`);
      }
      segmentBeatIds.add(beatId);
      beatIds.add(beatId);
    });

    const globalStartSec = roundSeconds(cursor);
    const globalEndSec = roundSeconds(globalStartSec + durationSec);
    cursor = globalEndSec;
    const normalized: VideoSegment = {
      ...segment,
      index: position + 1,
      globalStartSec,
      globalEndSec,
      durationSec,
      sourceSceneIds: unique(segment.sourceSceneIds),
      sourceBeatIds: [...segment.sourceBeatIds],
      ...(position > 0 && !hasAiShotReferences ? { entryState: previousExitState ?? '' } : {}),
    };
    previousExitState = normalized.exitState;
    return normalized;
  });

  return {
    ...input,
    segmentDurationSec,
    totalDurationSec: roundSeconds(cursor),
    ...(typeof input.masterStoryboardId === 'string' && input.masterStoryboardId.trim()
      ? { masterStoryboardId: input.masterStoryboardId.trim() }
      : {}),
    segments,
  };
};

export type SequenceSegmentPatch = Partial<Pick<
  VideoSegment,
  | 'title'
  | 'durationSec'
  | 'content'
  | 'summary'
  | 'narrativePurpose'
  | 'entryState'
  | 'exitState'
  | 'transitionHint'
>>;

const editableKeys: ReadonlyArray<keyof SequenceSegmentPatch> = [
  'title',
  'durationSec',
  'content',
  'summary',
  'narrativePurpose',
  'entryState',
  'exitState',
  'transitionHint',
];
const editableKeySet = new Set<string>(editableKeys);
const hasOwn = (value: object, key: PropertyKey): boolean => (
  Object.prototype.hasOwnProperty.call(value, key)
);

const valuesEqual = (left: unknown, right: unknown): boolean => (
  Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right
);

/**
 * Apply a user edit by segment ID. An explicit edit is allowed on a locked
 * segment, but its lock is retained so batch generation still cannot replace it.
 */
export const updateSequenceSegment = (
  input: VideoSequencePlan,
  segmentId: string,
  patch: SequenceSegmentPatch,
): VideoSequencePlan => {
  const plan = validateAndNormalizeSequencePlan(input);
  const index = segmentIndexById(plan, segmentId);
  const target = plan.segments[index];
  let changed = false;

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('段落更新 patch 必须是对象');
  }
  const structuralKeys = Object.keys(patch).filter((key) => !editableKeySet.has(key));
  if (structuralKeys.includes('sourceBeatIds')) {
    throw new Error('剧情节拍边界只能通过拆分或合并操作修改');
  }
  if (structuralKeys.length > 0) {
    throw new Error(`普通段落更新不能修改结构字段：${structuralKeys.join('、')}`);
  }

  editableKeys.forEach((key) => {
    if (!hasOwn(patch, key)) return;
    const value = patch[key] as unknown;
    let normalizedValue: string | number;
    if (key === 'durationSec') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error('durationSec 必须是大于 0 的有限数字');
      }
      normalizedValue = roundSeconds(value);
      if (normalizedValue <= 0) throw new Error('durationSec 精确到 0.01 秒后必须大于 0');
    } else {
      if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`);
      normalizedValue = value;
    }
    if (valuesEqual(target[key], normalizedValue)) return;
    changed = true;
    Object.assign(target, { [key]: normalizedValue });
    if (key === 'content') target.contentOverridden = true;
  });

  if (!changed) {
    const normalized = validateAndNormalizeSequencePlan(plan);
    return hasOwn(patch, 'durationSec')
      ? { ...normalized, requestedTotalDurationSec: normalized.totalDurationSec }
      : normalized;
  }

  // entryState is the same boundary as the previous segment's exitState.
  if (!isSemanticSequencePlan(plan) && index > 0 && hasOwn(patch, 'entryState')) {
    plan.segments[index - 1].exitState = target.entryState;
    plan.segments[index - 1].status = 'stale';
  }
  markStaleWindow(plan.segments, index, 2);
  if (hasOwn(patch, 'durationSec')) clearSourceShotIds(plan.segments);
  const normalized = validateAndNormalizeSequencePlan(plan);
  return hasOwn(patch, 'durationSec')
    ? { ...normalized, requestedTotalDurationSec: normalized.totalDurationSec }
    : normalized;
};

export interface SplitSequenceSegmentOptions {
  atSec?: number;
  newSegmentId?: string;
  handoffState?: string;
  firstTitle?: string;
  secondTitle?: string;
  firstContent?: string;
  secondContent?: string;
  firstSourceBeatIds?: string[];
  secondSourceBeatIds?: string[];
}

const nextSplitId = (plan: VideoSequencePlan, baseId: string): string => {
  const ids = new Set(plan.segments.map((segment) => segment.id));
  const root = `${baseId}-split`;
  if (!ids.has(root)) return root;
  let suffix = 2;
  while (ids.has(`${root}-${suffix}`)) suffix += 1;
  return `${root}-${suffix}`;
};

const beatContentFor = (
  plan: VideoSequencePlan,
  beatIds: readonly string[],
  label: string,
  unavailableMessage = '无法按节拍边界拆分正文',
): string => {
  const beatsById = new Map(extractStoryBeats(plan.sourceStoryContent).map((beat) => [beat.id, beat.text]));
  return beatIds.map((beatId) => {
    const text = beatsById.get(beatId);
    if (text === undefined) throw new Error(`${label}引用未知剧情节拍 ${beatId}，${unavailableMessage}`);
    return text;
  }).join('');
};

/** Restore one segment's exact source-beat text after a user content override. */
export const restoreSequenceSegmentSourceContent = (
  input: VideoSequencePlan,
  segmentId: string,
): VideoSequencePlan => {
  // Original evidence can describe an event shared by several AI-authored
  // stages. It is provenance, not a saved copy of a stage's generated body.
  // The legacy beat restore therefore has no operation in semantic mode.
  if (isSemanticSequencePlan(input)) return input;
  const plan = validateAndNormalizeSequencePlan(input);
  const index = segmentIndexById(plan, segmentId);
  const target = plan.segments[index];
  const sourceContent = beatContentFor(
    plan,
    target.sourceBeatIds,
    `第 ${index + 1} 段`,
    '无法从规划使用的原剧情恢复正文',
  );
  const contentChanged = target.content !== sourceContent || target.contentOverridden === true;

  target.content = sourceContent;
  delete target.contentOverridden;
  if (contentChanged) markStaleWindow(plan.segments, index, 2);
  return validateAndNormalizeSequencePlan(plan);
};

const assertBeatPartition = (
  original: readonly string[],
  first: readonly string[],
  second: readonly string[],
): void => {
  const combined = [...first, ...second];
  if (
    first.length === 0
    || second.length === 0
    || combined.length !== original.length
    || combined.some((beatId, index) => beatId !== original[index])
  ) {
    throw new Error('拆分后的剧情节拍必须恰好一次覆盖原节拍并保持原顺序');
  }
};

/** Split one segment at a local time. `atSec` is measured from this segment's 0. */
export const splitSequenceSegment = (
  input: VideoSequencePlan,
  segmentId: string,
  atOrOptions: number | SplitSequenceSegmentOptions = {},
): VideoSequencePlan => {
  if (isSemanticSequencePlan(input)) {
    throw new Error(`语义分段须保持每段 ${input.segmentDurationSec} 秒；拆分请由 AI 重新规划，不按本地节拍切正文。`);
  }
  const plan = validateAndNormalizeSequencePlan(input);
  const index = segmentIndexById(plan, segmentId);
  const source = plan.segments[index];
  const options = typeof atOrOptions === 'number' ? { atSec: atOrOptions } : atOrOptions;
  const atSec = roundSeconds(options.atSec ?? source.durationSec / 2);
  if (atSec <= 0 || atSec >= source.durationSec) {
    throw new Error(`拆分时间必须大于 0 且小于本段 ${source.durationSec} 秒`);
  }

  const hasExplicitBeatPartition = options.firstSourceBeatIds !== undefined
    || options.secondSourceBeatIds !== undefined;
  let firstSourceBeatIds: string[];
  let secondSourceBeatIds: string[];
  if (hasExplicitBeatPartition) {
    firstSourceBeatIds = [...(options.firstSourceBeatIds ?? [])];
    secondSourceBeatIds = [...(options.secondSourceBeatIds ?? [])];
  } else {
    if (source.sourceBeatIds.length < 2) {
      throw new Error('视频段至少包含两个剧情节拍才能拆分');
    }
    const beatCut = Math.max(
      1,
      Math.min(
        source.sourceBeatIds.length - 1,
        Math.round(source.sourceBeatIds.length * (atSec / source.durationSec)),
      ),
    );
    firstSourceBeatIds = source.sourceBeatIds.slice(0, beatCut);
    secondSourceBeatIds = source.sourceBeatIds.slice(beatCut);
  }
  assertBeatPartition(source.sourceBeatIds, firstSourceBeatIds, secondSourceBeatIds);

  const firstBeatContent = beatContentFor(plan, firstSourceBeatIds, '拆分前半段');
  const secondBeatContent = beatContentFor(plan, secondSourceBeatIds, '拆分后半段');
  const sourceIsOverridden = source.contentOverridden === true;
  if (!sourceIsOverridden && source.content !== `${firstBeatContent}${secondBeatContent}`) {
    throw new Error('待拆分正文与其剧情节拍不一致，请先修复计划或明确覆盖正文');
  }

  const hasExplicitContent = options.firstContent !== undefined || options.secondContent !== undefined;
  if (hasExplicitContent && (options.firstContent === undefined || options.secondContent === undefined)) {
    throw new Error('明确拆分正文时必须同时提供 firstContent 和 secondContent');
  }
  if (sourceIsOverridden && !hasExplicitContent) {
    throw new Error('该段正文已由用户覆盖，请明确提供与节拍分区对应的 firstContent 和 secondContent');
  }
  const [firstContent, secondContent] = sourceIsOverridden
    ? [options.firstContent ?? '', options.secondContent ?? '']
    : [firstBeatContent, secondBeatContent];
  if (!firstContent.trim() || !secondContent.trim()) {
    throw new Error('拆分后的两个视频段都必须保留正文');
  }
  if (sourceIsOverridden && `${firstContent}${secondContent}` !== source.content) {
    throw new Error('拆分正文必须完整保留原文且不得改写');
  }
  if (
    !sourceIsOverridden
    && hasExplicitContent
    && (options.firstContent !== firstBeatContent || options.secondContent !== secondBeatContent)
  ) {
    throw new Error('拆分正文切点必须与 sourceBeatIds 的节拍分区一致');
  }

  const newSegmentId = (options.newSegmentId ?? nextSplitId(plan, source.id)).trim();
  if (!newSegmentId) throw new Error('新视频段 ID 不能为空');
  if (plan.segments.some((segment) => segment.id === newSegmentId)) {
    throw new Error(`存在重复的视频段 ID：${newSegmentId}`);
  }
  const handoffState = options.handoffState ?? source.exitState;
  const secondDurationSec = roundSeconds(source.durationSec - atSec);
  const first: VideoSegment = {
    ...cloneSegment(source),
    title: options.firstTitle ?? source.title,
    durationSec: atSec,
    content: firstContent,
    sourceBeatIds: firstSourceBeatIds,
    exitState: handoffState,
    status: 'stale',
    contentOverridden: sourceIsOverridden || undefined,
  };
  const second: VideoSegment = {
    ...cloneSegment(source),
    id: newSegmentId,
    title: options.secondTitle ?? `${source.title}（续）`,
    durationSec: secondDurationSec,
    content: secondContent,
    sourceBeatIds: secondSourceBeatIds,
    entryState: handoffState,
    storyboardId: undefined,
    status: 'stale',
    contentOverridden: sourceIsOverridden || undefined,
  };

  plan.segments.splice(index, 1, first, second);
  markStaleWindow(plan.segments, index, 3);
  clearSourceShotIds(plan.segments);
  return validateAndNormalizeSequencePlan(plan);
};

const joinDistinctText = (left: string, right: string, separator: string): string => {
  if (!left) return right;
  if (!right || left === right) return left;
  return `${left}${separator}${right}`;
};

/** Merge a segment with its immediate next segment (or the explicit adjacent ID). */
export const mergeSequenceSegments = (
  input: VideoSequencePlan,
  firstSegmentId: string,
  secondSegmentId?: string,
): VideoSequencePlan => {
  if (isSemanticSequencePlan(input)) {
    throw new Error(`语义分段须保持每段 ${input.segmentDurationSec} 秒；合并请由 AI 重新规划，不拼接本地节拍。`);
  }
  const plan = validateAndNormalizeSequencePlan(input);
  const firstIndex = segmentIndexById(plan, firstSegmentId);
  const resolvedSecondId = secondSegmentId ?? plan.segments[firstIndex + 1]?.id;
  if (!resolvedSecondId) throw new Error('最后一个视频段没有可合并的下一段');
  const secondIndex = segmentIndexById(plan, resolvedSecondId);
  if (secondIndex !== firstIndex + 1) throw new Error('只能合并按顺序相邻的两个视频段');

  const first = plan.segments[firstIndex];
  const second = plan.segments[secondIndex];
  const durationSec = roundSeconds(first.durationSec + second.durationSec);
  if (durationSec > MAX_SEQUENCE_SEGMENT_DURATION_SEC + EPSILON) {
    throw new Error(`合并后 ${durationSec} 秒超过单段生成硬上限 ${MAX_SEQUENCE_SEGMENT_DURATION_SEC} 秒`);
  }

  const merged: VideoSegment = {
    ...cloneSegment(first),
    durationSec,
    content: `${first.content}${second.content}`,
    summary: joinDistinctText(first.summary, second.summary, '；'),
    sourceSceneIds: unique([...first.sourceSceneIds, ...second.sourceSceneIds]),
    sourceBeatIds: [...first.sourceBeatIds, ...second.sourceBeatIds],
    narrativePurpose: joinDistinctText(first.narrativePurpose, second.narrativePurpose, '；'),
    exitState: second.exitState,
    transitionHint: second.transitionHint,
    storyboardId: undefined,
    status: 'stale',
    locked: Boolean(first.locked || second.locked),
    contentOverridden: first.contentOverridden === true || second.contentOverridden === true || undefined,
  };
  plan.segments.splice(firstIndex, 2, merged);
  markStaleWindow(plan.segments, firstIndex, 2);
  clearSourceShotIds(plan.segments);
  return validateAndNormalizeSequencePlan(plan);
};

/** Move a segment to a one-based target position. */
export const reorderSequenceSegment = (
  input: VideoSequencePlan,
  segmentId: string,
  targetIndex: number,
): VideoSequencePlan => {
  const plan = validateAndNormalizeSequencePlan(input);
  const sourceIndex = segmentIndexById(plan, segmentId);
  if (!Number.isInteger(targetIndex) || targetIndex < 1 || targetIndex > plan.segments.length) {
    throw new Error(`目标序号必须在 1 到 ${plan.segments.length} 之间`);
  }
  const destinationIndex = targetIndex - 1;
  if (destinationIndex === sourceIndex) return validateAndNormalizeSequencePlan(plan);

  const initialEntryState = plan.segments[0].entryState;
  const affectedIds = new Set<string>([
    plan.segments[sourceIndex].id,
    plan.segments[sourceIndex - 1]?.id,
    plan.segments[sourceIndex + 1]?.id,
  ].filter((id): id is string => Boolean(id)));
  const [moved] = plan.segments.splice(sourceIndex, 1);
  plan.segments.splice(destinationIndex, 0, moved);
  plan.segmentOrderOverridden = true;
  if (!isSemanticSequencePlan(plan)) plan.segments[0].entryState = initialEntryState;
  [plan.segments[destinationIndex - 1]?.id, plan.segments[destinationIndex + 1]?.id]
    .filter((id): id is string => Boolean(id))
    .forEach((id) => affectedIds.add(id));
  plan.segments.forEach((segment) => {
    if (affectedIds.has(segment.id)) segment.status = 'stale';
  });
  clearSourceShotIds(plan.segments);
  return validateAndNormalizeSequencePlan(plan);
};

/** Set or clear a segment lock without changing its generation status. */
export const lockSequenceSegment = (
  input: VideoSequencePlan,
  segmentId: string,
  locked = true,
): VideoSequencePlan => {
  const plan = validateAndNormalizeSequencePlan(input);
  const index = segmentIndexById(plan, segmentId);
  plan.segments[index].locked = locked;
  if (locked && plan.segments[index].status === 'generating') {
    plan.segments[index].status = 'stale';
  }
  return validateAndNormalizeSequencePlan(plan);
};

/** Link a completed storyboard and mark only that segment ready. */
export const linkSegmentStoryboard = (
  input: VideoSequencePlan,
  segmentId: string,
  storyboardId: string,
): VideoSequencePlan => {
  const normalizedStoryboardId = storyboardId.trim();
  if (!normalizedStoryboardId) throw new Error('Storyboard ID 不能为空');
  const plan = validateAndNormalizeSequencePlan(input);
  const index = segmentIndexById(plan, segmentId);
  const existingOwner = plan.segments.find((segment, position) => (
    position !== index && segment.storyboardId?.trim() === normalizedStoryboardId
  ));
  if (existingOwner) {
    throw new Error(`Storyboard ${normalizedStoryboardId} 已由第 ${existingOwner.index} 段占用`);
  }
  plan.segments[index].storyboardId = normalizedStoryboardId;
  plan.segments[index].status = 'ready';
  delete plan.segments[index].failureReason;
  return validateAndNormalizeSequencePlan(plan);
};

export interface SequencePlanSourceSnapshot {
  title?: string;
  content: string;
}

export function sequencePlanSourceChanged(
  plan: VideoSequencePlan,
  sourceStoryContent: string,
): boolean;
export function sequencePlanSourceChanged(
  plan: VideoSequencePlan,
  source: SequencePlanSourceSnapshot,
): boolean;
export function sequencePlanSourceChanged(
  plan: VideoSequencePlan,
  sourceStoryTitle: string,
  sourceStoryContent: string,
): boolean;
/** Compare the live story with the exact title/content snapshot used by a plan. */
export function sequencePlanSourceChanged(
  plan: VideoSequencePlan,
  source: string | SequencePlanSourceSnapshot,
  sourceStoryContent?: string,
): boolean {
  if (typeof source === 'object') {
    return source.content !== plan.sourceStoryContent
      || (source.title !== undefined && source.title !== plan.sourceStoryTitle);
  }
  if (sourceStoryContent !== undefined) {
    return source !== plan.sourceStoryTitle || sourceStoryContent !== plan.sourceStoryContent;
  }
  return source !== plan.sourceStoryContent;
}

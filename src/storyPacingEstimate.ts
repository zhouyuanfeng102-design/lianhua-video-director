import type { StoryDurationEstimate } from './services/llm';
import type { StoryPacingContext } from './storyPacing';
import type { VideoSequencePlan } from './types';
import { requestedSegmentDurationWindows } from './sequenceDurationContract';

/** A completed estimate belongs to the exact story and pacing request that
 * produced it, not to whichever director settings happen to be visible now. */
export type SourcedStoryDurationEstimate = StoryDurationEstimate & {
  sourceFingerprint: string;
};

export interface SequenceDurationEstimateSnapshot {
  version: 1 | 2;
  /** Present on v2: the selected per-segment duration is part of the AI request. */
  segmentDurationSec?: number;
  sourceFingerprint: string;
  pacing: StoryPacingContext;
  estimate: StoryDurationEstimate;
}

const ESTIMATE_RULE_VERSION = 'story-pacing-event-progression-v4';
const OPTIONAL_PACING_FIELDS = [
  'directorCategory',
  'directorStyle',
  'directorStyleSummary',
  'extraRequirement',
] as const;

/** Include the complete source and all timing-relevant creative context.
 * No keyword classification, trimming of the story, or local duration quota
 * participates in the cache identity. Field order in caller objects is inert. */
export const sequenceEstimateSourceFingerprint = (
  title: string,
  story: string,
  pacing: StoryPacingContext,
  segmentDurationSec?: number,
): string => JSON.stringify([
  segmentDurationSec === undefined ? ESTIMATE_RULE_VERSION : 'story-pacing-event-progression-full-segments-v4',
  title.trim() || '未命名剧情',
  story,
  pacing.pace,
  ...OPTIONAL_PACING_FIELDS.map((field) => pacing[field] ?? null),
  ...(segmentDurationSec === undefined ? [] : [segmentDurationSec]),
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const readPacing = (value: unknown): StoryPacingContext | null => {
  if (!isRecord(value) || typeof value.pace !== 'string') return null;
  const pacing: StoryPacingContext = { pace: value.pace };
  for (const field of OPTIONAL_PACING_FIELDS) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'string') return null;
    pacing[field] = value[field];
  }
  return pacing;
};

/** Only validate the persisted numeric/JSON contract. A model's reasoning,
 * chosen pacing, subjects and fit assessment are never semantically judged. */
const readEstimate = (value: unknown): StoryDurationEstimate | null => {
  if (!isRecord(value)) return null;
  const { minSec, recommendedSec, maxSec, fitStatus, reason } = value;
  if (
    typeof minSec !== 'number' || !Number.isFinite(minSec) || minSec <= 0
    || typeof recommendedSec !== 'number' || !Number.isFinite(recommendedSec)
    || typeof maxSec !== 'number' || !Number.isFinite(maxSec)
    || minSec > recommendedSec || recommendedSec > maxSec
    || (fitStatus !== 'comfortable' && fitStatus !== 'balanced'
      && fitStatus !== 'compressed' && fitStatus !== 'insufficient')
    || typeof reason !== 'string'
  ) return null;
  return { minSec, recommendedSec, maxSec, fitStatus, reason };
};

/** Copy request-owned primitive fields so later UI mutations cannot silently
 * change the saved estimate's source. Call only when committing a new plan. */
export const createSequenceDurationEstimateSnapshot = (
  title: string,
  story: string,
  pacing: StoryPacingContext,
  estimate: StoryDurationEstimate,
  segmentDurationSec?: number,
): SequenceDurationEstimateSnapshot => {
  const savedPacing = readPacing(pacing);
  const savedEstimate = readEstimate(estimate);
  if (!savedPacing || !savedEstimate) {
    throw new TypeError('无法保存估时快照：节奏字段或时长 JSON 结构无效。');
  }
  if (segmentDurationSec !== undefined) {
    for (const value of [savedEstimate.minSec, savedEstimate.recommendedSec, savedEstimate.maxSec]) {
      requestedSegmentDurationWindows(value, segmentDurationSec);
    }
  }
  return {
    version: segmentDurationSec === undefined ? 1 : 2,
    ...(segmentDurationSec === undefined ? {} : { segmentDurationSec }),
    sourceFingerprint: sequenceEstimateSourceFingerprint(title, story, savedPacing, segmentDurationSec),
    pacing: savedPacing,
    estimate: savedEstimate,
  };
};

/** Legacy plans have no request-owned estimate snapshot. Leave them intact
 * and return null rather than manufacturing a current-rules estimate from
 * their old reason, local heuristics, or the live director controls. */
export const readSequencePlanDurationEstimate = (
  plan: Pick<VideoSequencePlan, 'sourceStoryTitle' | 'sourceStoryContent' | 'durationEstimateSnapshot'> & Partial<Pick<VideoSequencePlan, 'segmentDurationSec'>>,
): SourcedStoryDurationEstimate | null => {
  const snapshot: unknown = plan.durationEstimateSnapshot;
  if (
    typeof plan.sourceStoryTitle !== 'string'
    || typeof plan.sourceStoryContent !== 'string'
    || !isRecord(snapshot)
    || (snapshot.version !== 1 && snapshot.version !== 2)
    || typeof snapshot.sourceFingerprint !== 'string'
  ) return null;
  const pacing = readPacing(snapshot.pacing);
  const estimate = readEstimate(snapshot.estimate);
  if (!pacing || !estimate) return null;
  const segmentDurationSec = snapshot.version === 2 ? snapshot.segmentDurationSec : undefined;
  if (snapshot.version === 2) {
    if (typeof segmentDurationSec !== 'number' || segmentDurationSec < 1 || segmentDurationSec > 300
      || plan.segmentDurationSec !== segmentDurationSec) return null;
    try {
      for (const value of [estimate.minSec, estimate.recommendedSec, estimate.maxSec]) requestedSegmentDurationWindows(value, segmentDurationSec);
    } catch { return null; }
  }
  const expectedFingerprint = sequenceEstimateSourceFingerprint(
    plan.sourceStoryTitle,
    plan.sourceStoryContent,
    pacing,
    typeof segmentDurationSec === 'number' ? segmentDurationSec : undefined,
  );
  if (snapshot.sourceFingerprint !== expectedFingerprint) return null;
  return { ...estimate, sourceFingerprint: expectedFingerprint };
};

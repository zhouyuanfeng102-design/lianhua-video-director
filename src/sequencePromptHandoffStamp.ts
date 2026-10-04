import type { SequencePromptHandoffStamp } from './types';

/** Persistence/serialization contract only. Keep this module a pure leaf:
 * it is shared by revision history and storage before the prompt domain loads. */
export const SEQUENCE_PROMPT_HANDOFF_VERSION = 'sequence-prompt-handoff-v1' as const;
export const SEQUENCE_PROMPT_OPENING_OVERLAP_SEC = 0.5 as const;
/** The saved stamp format remains v1. This new timing contract belongs to the
 * request evidence/source fingerprint, so old stamps stay readable without
 * silently claiming their old prose received this tighter AI review. */
export const SEQUENCE_PROMPT_HANDOFF_TIMING_VERSION = 'sequence-prompt-opening-window-v2' as const;
export const SEQUENCE_PROMPT_MAX_OPENING_OVERLAP_SEC = 0.8 as const;

const hashValue = (value: unknown): value is string => typeof value === 'string' && /^src-v1-[a-f0-9]{16}$/u.test(value);
const idValue = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();

/** Structural normalization only. Unknown/partial stamps never become valid
 * provenance after reload, and legacy boards receive no synthesized stamp.
 * A readable v1 stamp is not proof of current timing compliance: preserve its
 * original source fingerprint and let the current evidence comparison decide. */
export const normalizeSequencePromptHandoffStamp = (value: unknown): SequencePromptHandoffStamp | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== SEQUENCE_PROMPT_HANDOFF_VERSION
    || !idValue(raw.projectId) || !idValue(raw.planId) || !idValue(raw.segmentId) || !idValue(raw.storyboardId)
    || !idValue(raw.previousSegmentId) || !idValue(raw.previousStoryboardId)
    || raw.segmentId === raw.previousSegmentId || raw.storyboardId === raw.previousStoryboardId
    || !Number.isInteger(raw.segmentIndex) || (raw.segmentIndex as number) < 2
    || raw.previousSegmentIndex !== (raw.segmentIndex as number) - 1
    || raw.openingOverlapSec !== SEQUENCE_PROMPT_OPENING_OVERLAP_SEC
    || !hashValue(raw.previousPromptFingerprint) || !hashValue(raw.sourceFingerprint)
    || !hashValue(raw.resultFingerprint)) return undefined;
  return {
    version: SEQUENCE_PROMPT_HANDOFF_VERSION,
    projectId: raw.projectId,
    planId: raw.planId,
    segmentId: raw.segmentId,
    segmentIndex: raw.segmentIndex as number,
    previousSegmentId: raw.previousSegmentId,
    previousSegmentIndex: raw.previousSegmentIndex as number,
    previousStoryboardId: raw.previousStoryboardId,
    previousPromptFingerprint: raw.previousPromptFingerprint,
    sourceFingerprint: raw.sourceFingerprint,
    openingOverlapSec: SEQUENCE_PROMPT_OPENING_OVERLAP_SEC,
    storyboardId: raw.storyboardId,
    resultFingerprint: raw.resultFingerprint,
  };
};

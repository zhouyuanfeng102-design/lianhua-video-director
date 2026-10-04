/**
 * Pure planning helpers for a low-cost pilot generation run (0.3).
 * Generation units are intentionally abstract: callers can supply a model
 * profile's unit weights without coupling this module to a billing provider.
 */

import { estimateDialogueDurationSec, type ContinuityIssue, type ContinuityReport, type ContinuityShotLike } from './continuity';

export interface GenerationShotLike extends ContinuityShotLike {
  prompt?: string;
  riskReasons?: readonly string[];
}

export interface GenerationStoryboardLike {
  durationSec?: number;
  shots: readonly GenerationShotLike[];
}

export interface GenerationTargetProfileLike {
  id?: string;
  maxShotsPerBatch?: number;
  maxDurationPerBatchSec?: number;
  /** Alias used by some adapters. */
  maxBatchDurationSec?: number;
  maxReferencesPerShot?: number;
  unitsPerSecond?: number;
  baseUnitsPerShot?: number;
  unitsPerReference?: number;
}

export interface GenerationPlanOptions {
  targetId?: string;
  target?: GenerationTargetProfileLike;
  continuityReport?: ContinuityReport;
  pilotShotIds?: readonly string[];
  pilotShotCount?: number;
  /** Alias for pilotShotCount. */
  pilotCount?: number;
  batchSize?: number;
  includePilotBatch?: boolean;
  unitsPerSecond?: number;
  baseUnitsPerShot?: number;
  unitsPerReference?: number;
}

export interface GenerationShotEstimate {
  shotId: string;
  index: number;
  durationSec: number;
  referenceCount: number;
  imageReferenceCount: number;
  videoReferenceCount: number;
  audioReferenceCount: number;
  estimatedUnits: number;
  riskScore: number;
  riskReasons: string[];
  selectedForPilot: boolean;
}

export interface GenerationBatch {
  id: string;
  kind: 'pilot' | 'batch';
  status: 'pilot' | 'queued';
  shotIds: string[];
  durationSec: number;
  referenceCount: number;
  estimatedUnits: number;
}

export interface GenerationPlan {
  targetId?: string;
  pilotShotIds: string[];
  shots: GenerationShotEstimate[];
  batches: GenerationBatch[];
  totalDurationSec: number;
  totalReferenceCount: number;
  uniqueReferenceCount: number;
  totalEstimatedUnits: number;
  warnings: string[];
}

const asText = (value: unknown): string => typeof value === 'string' ? value : '';
const round = (value: number): number => Math.round(value * 100) / 100;
const finite = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const mediaTypeOf = (shot: GenerationShotLike, id: string): 'image' | 'video' | 'audio' => {
  const record = shot as unknown as Record<string, unknown>;
  const map = record.referenceAssetTypes;
  const raw = map && typeof map === 'object' ? asText((map as Record<string, unknown>)[id]) : '';
  if (/(?:video|视频|movie|clip)/iu.test(raw)) return 'video';
  if (/(?:audio|音频|sound|voice)/iu.test(raw)) return 'audio';
  return 'image';
};

const issueWeight = (issue: ContinuityIssue): number => issue.severity === 'error' ? 35 : issue.severity === 'warning' ? 16 : 4;

const riskForShot = (
  shot: GenerationShotLike,
  report: ContinuityReport | undefined
): { score: number; reasons: string[] } => {
  const explicit = finite(shot.riskScore, NaN);
  const reasons: string[] = [...(shot.riskReasons || [])].filter(Boolean);
  let score = Number.isFinite(explicit) ? explicit : 0;
  const duration = Math.max(0, finite(shot.endSec) - finite(shot.startSec));
  const refs = new Set(shot.referenceAssetIds || []).size;
  const body = `${shot.purpose || ''} ${shot.action || ''} ${shot.camera || ''} ${shot.lighting || ''}`;
  const dialogue = (body.match(/[“「『"']([^”」』"']{1,})[”」』"']/gu) || []).join('');
  if (!Number.isFinite(explicit)) {
    if (duration >= 8) { score += 10; reasons.push('long-shot'); }
    if (refs >= 3) { score += 12; reasons.push('many-references'); }
    if (dialogue && estimateDialogueDurationSec(dialogue) > duration * 0.8) { score += 24; reasons.push('dialogue-tight'); }
    if (/(?:爆炸|打斗|追逐|高速|战斗|action|chase|fight|explosion)/iu.test(body)) { score += 15; reasons.push('high-motion'); }
    if (/(?:复杂|连续|一镜到底|长镜头|complex|one[- ]take)/iu.test(body)) { score += 10; reasons.push('complex-blocking'); }
  }
  if (report) {
    report.issues.forEach((issue) => {
      if (issue.shotIds.includes(shot.id)) {
        score += issueWeight(issue);
        reasons.push(issue.code);
      }
    });
  }
  const uniqueReasons = [...new Set(reasons)];
  return { score: Math.max(0, Math.min(100, round(score))), reasons: uniqueReasons };
};

/** Select the most risky one or two shots while preserving deterministic ties. */
export const selectPilotShots = (
  shots: readonly GenerationShotLike[],
  options: Pick<GenerationPlanOptions, 'pilotShotIds' | 'pilotShotCount' | 'pilotCount'> = {},
  report?: ContinuityReport
): string[] => {
  const byId = new Map(shots.map((shot) => [shot.id, shot]));
  if (options.pilotShotIds && options.pilotShotIds.length) {
    return [...new Set(options.pilotShotIds)].filter((id) => byId.has(id)).slice(0, 2);
  }
  const count = Math.max(0, Math.min(2, Math.floor(options.pilotShotCount ?? options.pilotCount ?? 2)));
  return [...shots]
    .map((shot, position) => ({ shot, position, risk: riskForShot(shot, report) }))
    .sort((left, right) => right.risk.score - left.risk.score || (left.shot.index ?? left.position) - (right.shot.index ?? right.position))
    .slice(0, count)
    .sort((left, right) => (left.shot.index ?? left.position) - (right.shot.index ?? right.position))
    .map(({ shot }) => shot.id);
};

const inputShots = (input: GenerationStoryboardLike | readonly GenerationShotLike[]): readonly GenerationShotLike[] => (
  Array.isArray(input) ? input as readonly GenerationShotLike[] : (input as GenerationStoryboardLike).shots
);

/** Build a pilot + queued batch plan for any target model profile. */
export const buildGenerationPlan = (
  input: GenerationStoryboardLike | readonly GenerationShotLike[],
  options: GenerationPlanOptions = {}
): GenerationPlan => {
  const source = [...inputShots(input)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.startSec - b.startSec);
  const target = options.target;
  const targetId = options.targetId ?? target?.id;
  const unitsPerSecond = Math.max(0, options.unitsPerSecond ?? target?.unitsPerSecond ?? 1);
  const baseUnitsPerShot = Math.max(0, options.baseUnitsPerShot ?? target?.baseUnitsPerShot ?? 1);
  const unitsPerReference = Math.max(0, options.unitsPerReference ?? target?.unitsPerReference ?? 0.25);
  const pilotIds = selectPilotShots(source, options, options.continuityReport);
  const pilotSet = new Set(pilotIds);
  const warnings: string[] = [];
  const estimates = source.map((shot, position) => {
    const referenceIds = [...new Set((shot.referenceAssetIds || []).filter(Boolean))];
    const imageReferenceCount = referenceIds.filter((id) => mediaTypeOf(shot, id) === 'image').length;
    const videoReferenceCount = referenceIds.filter((id) => mediaTypeOf(shot, id) === 'video').length;
    const audioReferenceCount = referenceIds.filter((id) => mediaTypeOf(shot, id) === 'audio').length;
    const durationSec = Math.max(0, finite(shot.endSec) - finite(shot.startSec));
    const risk = riskForShot(shot, options.continuityReport);
    const estimatedUnits = round(durationSec * unitsPerSecond + baseUnitsPerShot + referenceIds.length * unitsPerReference);
    if (target?.maxReferencesPerShot !== undefined && referenceIds.length > target.maxReferencesPerShot) {
      warnings.push(`Shot ${shot.id} exceeds ${targetId || 'target'} reference limit (${referenceIds.length}/${target.maxReferencesPerShot}).`);
    }
    return {
      shotId: shot.id,
      index: shot.index ?? position + 1,
      durationSec: round(durationSec),
      referenceCount: referenceIds.length,
      imageReferenceCount,
      videoReferenceCount,
      audioReferenceCount,
      estimatedUnits,
      riskScore: risk.score,
      riskReasons: risk.reasons,
      selectedForPilot: pilotSet.has(shot.id)
    } satisfies GenerationShotEstimate;
  });

  const byId = new Map(estimates.map((estimate) => [estimate.shotId, estimate]));
  const makeBatch = (kind: GenerationBatch['kind'], ids: readonly string[], ordinal: number): GenerationBatch => {
    const rows = ids.map((id) => byId.get(id)).filter((row): row is GenerationShotEstimate => !!row);
    return {
      id: `${kind}-${ordinal}`,
      kind,
      status: kind === 'pilot' ? 'pilot' : 'queued',
      shotIds: rows.map((row) => row.shotId),
      durationSec: round(rows.reduce((sum, row) => sum + row.durationSec, 0)),
      referenceCount: rows.reduce((sum, row) => sum + row.referenceCount, 0),
      estimatedUnits: round(rows.reduce((sum, row) => sum + row.estimatedUnits, 0))
    };
  };

  const batches: GenerationBatch[] = [];
  let ordinal = 1;
  if (options.includePilotBatch !== false && pilotIds.length) {
    batches.push(makeBatch('pilot', pilotIds, ordinal));
    ordinal += 1;
  }

  const remaining = source.map((shot) => shot.id).filter((id) => !pilotSet.has(id));
  const configuredBatchSize = Math.max(1, Math.floor(options.batchSize ?? target?.maxShotsPerBatch ?? 4));
  const maxBatchDuration = target?.maxDurationPerBatchSec ?? target?.maxBatchDurationSec;
  let current: string[] = [];
  let currentDuration = 0;
  const flush = (): void => {
    if (current.length) {
      batches.push(makeBatch('batch', current, ordinal));
      ordinal += 1;
      current = [];
      currentDuration = 0;
    }
  };
  remaining.forEach((id) => {
    const row = byId.get(id);
    if (!row) return;
    const wouldExceedCount = current.length >= configuredBatchSize;
    const wouldExceedDuration = maxBatchDuration !== undefined && current.length > 0 && currentDuration + row.durationSec > maxBatchDuration;
    if (wouldExceedCount || wouldExceedDuration) flush();
    current.push(id);
    currentDuration += row.durationSec;
    if (maxBatchDuration !== undefined && row.durationSec > maxBatchDuration) {
      warnings.push(`Shot ${id} is longer than ${targetId || 'target'} batch duration (${row.durationSec.toFixed(2)}s/${maxBatchDuration}s).`);
      flush();
    }
  });
  flush();

  const allReferenceIds = new Set<string>();
  source.forEach((shot) => (shot.referenceAssetIds || []).filter(Boolean).forEach((id) => allReferenceIds.add(id)));
  return {
    targetId,
    pilotShotIds: pilotIds,
    shots: estimates,
    batches,
    totalDurationSec: round(estimates.reduce((sum, row) => sum + row.durationSec, 0)),
    totalReferenceCount: estimates.reduce((sum, row) => sum + row.referenceCount, 0),
    uniqueReferenceCount: allReferenceIds.size,
    totalEstimatedUnits: round(estimates.reduce((sum, row) => sum + row.estimatedUnits, 0)),
    warnings: [...new Set(warnings)]
  };
};

export const createGenerationPlan = buildGenerationPlan;
export const makeGenerationPlan = buildGenerationPlan;
export const estimateGenerationUnits = (
  shot: GenerationShotLike,
  options: Pick<GenerationPlanOptions, 'target' | 'unitsPerSecond' | 'baseUnitsPerShot' | 'unitsPerReference'> = {}
): number => buildGenerationPlan([shot], { ...options, pilotShotCount: 0 }).totalEstimatedUnits;

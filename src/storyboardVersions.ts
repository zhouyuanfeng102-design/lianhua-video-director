/** Immutable storyboard revisions, prompt diffs, and A/B candidate helpers. */
import type {
  SequencePromptHandoffStamp,
  Storyboard as ProjectStoryboard,
  StoryboardRevision as ProjectStoryboardRevision,
  H3IdentityBindings,
  AudioCue,
  PromptPlanSnapshot,
  PromptTrace,
  ShotMode,
  Seedance25Output,
} from './types';
import { normalizeSequencePromptHandoffStamp } from './sequencePromptHandoffStamp';
import { normalizeH3IdentityBindings } from './h3IdentityBindings';
import { normalizeVideoCreativeDirection, type VideoCreativeDirection } from './videoCreativeDirection';

export interface VersionShotLike {
  id: string;
  index?: number;
  startSec?: number;
  endSec?: number;
  prompt?: string;
  [key: string]: unknown;
}

export interface VersionTargetOutput {
  targetId: string;
  prompt: string;
  parameters: Record<string, unknown>;
  referenceManifest: Array<Record<string, unknown>>;
  warnings: string[];
  generatedAt: number;
}

export interface StoryboardRevisionSource {
  id?: string;
  storyboardId?: string;
  finalPrompt?: string;
  englishPrompt?: string;
  officialPromptZh?: string;
  officialPromptEn?: string;
  officialPromptSource?: string;
  officialPromptEnSource?: string;
  h3IdentityBindings?: H3IdentityBindings;
  h3IdentityBindingsEn?: H3IdentityBindings;
  shotMode?: ShotMode;
  shotCount?: number;
  recommendedShotCount?: number;
  durationSec?: number;
  audioLedger?: AudioCue[];
  sequencePromptHandoff?: SequencePromptHandoffStamp;
  creativeDirection?: VideoCreativeDirection;
  /** Target model paired with the saved adapted prompt, when any. */
  targetModelId?: string;
  targetOutput?: VersionTargetOutput;
  seedance25Output?: Seedance25Output;
  shots?: readonly VersionShotLike[];
  updatedAt?: number;
  createdAt?: number;
  [key: string]: unknown;
}

export interface StoryboardRevision {
  id: string;
  storyboardId: string;
  revision: number;
  createdAt: number;
  label?: string;
  reason?: string;
  finalPrompt: string;
  englishPrompt?: string;
  officialPromptZh?: string;
  officialPromptEn?: string;
  officialPromptSource?: string;
  officialPromptEnSource?: string;
  h3IdentityBindings?: H3IdentityBindings;
  h3IdentityBindingsEn?: H3IdentityBindings;
  shotMode?: ShotMode;
  shotCount?: number;
  recommendedShotCount?: number;
  durationSec?: number;
  audioLedger?: AudioCue[];
  promptPlan?: PromptPlanSnapshot;
  promptTrace?: PromptTrace;
  sequencePromptHandoff?: SequencePromptHandoffStamp;
  creativeDirection?: VideoCreativeDirection;
  /** Target model paired with the saved adapted prompt, when any. */
  targetModelId?: string;
  targetOutput?: VersionTargetOutput;
  seedance25Output?: Seedance25Output;
  shots: VersionShotLike[];
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RevisionOptions {
  id?: string;
  revision?: number;
  createdAt?: number;
  label?: string;
  reason?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface TextDiffEntry {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
  leftLine?: number;
  rightLine?: number;
}

export interface TextComparison {
  leftText: string;
  rightText: string;
  changed: boolean;
  added: string[];
  removed: string[];
  unchanged: string[];
  entries: TextDiffEntry[];
  similarity: number;
}

export interface RevisionComparison {
  changed: boolean;
  prompt: TextComparison;
  englishPrompt?: TextComparison;
  changedShotIds: string[];
  addedShotIds: string[];
  removedShotIds: string[];
  shotPromptDiffs: Record<string, TextComparison>;
}

export interface ABCandidateInput {
  id?: string;
  label?: string;
  prompt?: string;
  englishPrompt?: string;
  revision?: StoryboardRevision;
  source?: StoryboardRevisionSource;
  reason?: string;
}

export interface ABCandidate {
  id: string;
  label: string;
  prompt: string;
  englishPrompt?: string;
  revisionId?: string;
  source: 'base' | 'variant';
  reason?: string;
  changedFromBase: boolean;
  diffFromBase?: TextComparison;
}

export interface ABCandidateSet {
  base: ABCandidate;
  candidates: ABCandidate[];
  recommendedId?: string;
}

const clone = <T>(value: T): T => {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
};

const textOf = (value: unknown): string => typeof value === 'string' ? value : '';

/** Create an immutable revision snapshot without mutating the live storyboard. */
export function createStoryboardRevision(
  source: ProjectStoryboard,
  revisionsOrOptions?: readonly ProjectStoryboardRevision[] | RevisionOptions,
  explicitOptions?: RevisionOptions,
): StoryboardRevision & ProjectStoryboardRevision;
export function createStoryboardRevision(
  source: StoryboardRevisionSource,
  revisionsOrOptions?: readonly StoryboardRevision[] | RevisionOptions,
  explicitOptions?: RevisionOptions,
): StoryboardRevision;
export function createStoryboardRevision(
  incomingSource: StoryboardRevisionSource | ProjectStoryboard,
  revisionsOrOptions: readonly (StoryboardRevision | ProjectStoryboardRevision)[] | RevisionOptions = [],
  explicitOptions: RevisionOptions = {}
): StoryboardRevision {
  // A full application storyboard carries stricter VideoShot fields than the
  // lightweight diff utility. Cloning preserves those fields without forcing
  // app callers to cast their strongly typed revision snapshots.
  const source = incomingSource as unknown as StoryboardRevisionSource;
  const previous = Array.isArray(revisionsOrOptions) ? revisionsOrOptions : [];
  const options: RevisionOptions = Array.isArray(revisionsOrOptions) ? explicitOptions : revisionsOrOptions as RevisionOptions;
  const storyboardId = textOf(source.storyboardId || source.id) || 'storyboard';
  const nextRevision = options.revision ?? (previous.reduce((max, item) => Math.max(max, item.revision || 0), 0) + 1);
  const baseId = options.id || `${storyboardId}-r${nextRevision}`;
  const previousIds = new Set(previous.map((item) => item.id));
  let id = baseId;
  let suffix = previous.length + 1;
  while (previousIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  const shots = (source.shots || []).map((shot) => clone(shot));
  return {
    id,
    storyboardId,
    revision: nextRevision,
    createdAt: options.createdAt ?? source.updatedAt ?? source.createdAt ?? 0,
    ...(options.label ? { label: options.label } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    finalPrompt: textOf(source.finalPrompt),
    ...(source.englishPrompt !== undefined ? { englishPrompt: textOf(source.englishPrompt) } : {}),
    ...(source.officialPromptZh !== undefined ? { officialPromptZh: textOf(source.officialPromptZh) } : {}),
    ...(source.officialPromptEn !== undefined ? { officialPromptEn: textOf(source.officialPromptEn) } : {}),
    ...(source.officialPromptSource !== undefined ? { officialPromptSource: textOf(source.officialPromptSource) } : {}),
    ...(source.officialPromptEnSource !== undefined ? { officialPromptEnSource: textOf(source.officialPromptEnSource) } : {}),
    ...(source.h3IdentityBindings !== undefined ? { h3IdentityBindings: normalizeH3IdentityBindings(source.h3IdentityBindings) } : {}),
    ...(source.h3IdentityBindingsEn !== undefined ? { h3IdentityBindingsEn: normalizeH3IdentityBindings(source.h3IdentityBindingsEn) } : {}),
    ...(source.shotMode !== undefined ? { shotMode: source.shotMode } : {}),
    ...(typeof source.shotCount === 'number' ? { shotCount: source.shotCount } : {}),
    ...(typeof source.recommendedShotCount === 'number' ? { recommendedShotCount: source.recommendedShotCount } : {}),
    ...(typeof source.durationSec === 'number' ? { durationSec: source.durationSec } : {}),
    ...(source.audioLedger !== undefined ? { audioLedger: clone(source.audioLedger) } : {}),
    // A new revision owns its exact adapter inputs and API provenance. Do not
    // reconstruct either field from current controls when restoring later.
    ...(source.promptPlan !== undefined ? { promptPlan: clone(source.promptPlan as PromptPlanSnapshot) } : {}),
    ...(source.promptTrace !== undefined ? { promptTrace: clone(source.promptTrace as PromptTrace) } : {}),
    ...(source.sequencePromptHandoff !== undefined
      ? { sequencePromptHandoff: normalizeSequencePromptHandoffStamp(source.sequencePromptHandoff) }
      : {}),
    ...(source.creativeDirection !== undefined
      ? { creativeDirection: normalizeVideoCreativeDirection(source.creativeDirection) }
      : {}),
    ...(source.targetModelId !== undefined ? { targetModelId: textOf(source.targetModelId) } : {}),
    ...(source.targetOutput !== undefined ? { targetOutput: clone(source.targetOutput) } : {}),
    ...(source.seedance25Output !== undefined ? { seedance25Output: clone(source.seedance25Output) } : {}),
    shots,
    ...(options.metadata ? { metadata: clone(options.metadata) } : {})
  };
}

export const createRevision = createStoryboardRevision;
export const revisionFromStoryboard = createStoryboardRevision;

/** Restore the exact text and shot snapshot saved in a revision. */
export function restoreStoryboardRevisionSnapshot<
  T extends StoryboardRevisionSource,
>(
  current: T,
  revision: StoryboardRevision,
): T {
  const creativeDirection = normalizeVideoCreativeDirection(revision.creativeDirection);
  return {
    ...current,
    finalPrompt: revision.finalPrompt,
    englishPrompt: revision.englishPrompt,
    englishPromptSource: revision.englishPrompt ? revision.finalPrompt : '',
    officialPromptZh: revision.officialPromptZh,
    officialPromptEn: revision.officialPromptEn,
    officialPromptSource: revision.officialPromptSource,
    officialPromptEnSource: revision.officialPromptEnSource,
    h3IdentityBindings: normalizeH3IdentityBindings(revision.h3IdentityBindings),
    h3IdentityBindingsEn: normalizeH3IdentityBindings(revision.h3IdentityBindingsEn),
    // New snapshots distinguish an absent auto-mode user setting from the
    // actual AI shot count. Legacy snapshots keep their former fallback.
    ...(revision.shotMode !== undefined ? {
      shotMode: revision.shotMode,
      shotCount: revision.shotCount,
      recommendedShotCount: revision.recommendedShotCount,
    } : typeof revision.shotCount === 'number' ? { shotCount: revision.shotCount }
      : revision.shots.length ? { shotCount: revision.shots.length } : {}),
    ...(typeof revision.durationSec === 'number' ? { durationSec: revision.durationSec } : {}),
    // A newer layout's voice windows cannot be attached to an older prompt.
    audioLedger: clone(revision.audioLedger),
    // Restoring a legacy revision must clear a later handoff claim. Never
    // manufacture a fresh stamp for text that the AI did not align.
    sequencePromptHandoff: normalizeSequencePromptHandoffStamp(revision.sequencePromptHandoff),
    // Old revisions have no matching creative evidence. Clear a newer board's
    // snapshot rather than associating today's controls with historical text.
    creativeDirection,
    // Board-level controls are authoritative when this snapshot is consumed.
    // Restore the fields actually known by the revision so newer controls
    // cannot override its saved evidence. Missing optional identities are not
    // inferred from names or the current preset library.
    ...(creativeDirection ? {
      ...(creativeDirection.directorStyle?.id !== undefined
        ? { directorStyleId: creativeDirection.directorStyle.id } : {}),
      ...(creativeDirection.directorStyle?.name !== undefined
        ? { directorStyleName: creativeDirection.directorStyle.name } : {}),
      ...(creativeDirection.directorStyle?.summary !== undefined
        ? { directorStyleSummary: creativeDirection.directorStyle.summary } : {}),
      ...(creativeDirection.visualStyle?.name !== undefined
        ? { visualStyle: creativeDirection.visualStyle.name } : {}),
      ...(creativeDirection.stylePreset?.id !== undefined
        ? { stylePresetId: creativeDirection.stylePreset.id } : {}),
      cameraTerms: [...creativeDirection.cameraTerms],
      lightingTerms: [...creativeDirection.lightingTerms],
      extraRequirement: creativeDirection.extraRequirement,
    } : {}),
    targetModelId: revision.targetModelId,
    targetOutput: clone(revision.targetOutput),
    seedance25Output: clone(revision.seedance25Output),
    shots: revision.shots.map((shot) => clone(shot)),
    // Missing legacy evidence stays missing; never borrow a newer trace or
    // manufacture an API-complete marker for historical text.
    promptPlan: clone(revision.promptPlan),
    promptTrace: clone(revision.promptTrace),
  } as T;
}

const splitLines = (text: string): string[] => text.replace(/\r\n?/gu, '\n').split('\n');

/** Line-level LCS diff. It is deterministic and keeps unchanged lines in order. */
export const comparePromptText = (leftValue: string, rightValue: string): TextComparison => {
  const leftText = leftValue || '';
  const rightText = rightValue || '';
  const left = splitLines(leftText);
  const right = splitLines(rightText);
  const entries: TextDiffEntry[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  const appendRemoved = (index: number) => {
    entries.push({ type: 'removed', text: left[index], leftLine: index + 1 });
    removed.push(left[index]);
  };
  const appendAdded = (index: number) => {
    entries.push({ type: 'added', text: right[index], rightLine: index + 1 });
    added.push(right[index]);
  };
  const appendUnchanged = (leftIndex: number, rightIndex: number) => {
    entries.push({
      type: 'unchanged',
      text: left[leftIndex],
      leftLine: leftIndex + 1,
      rightLine: rightIndex + 1,
    });
    unchanged.push(left[leftIndex]);
  };

  if (left.length * right.length <= 1_000_000) {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const table: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
    for (let i = left.length - 1; i >= 0; i -= 1) {
      for (let j = right.length - 1; j >= 0; j -= 1) {
        table[i][j] = left[i] === right[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        appendUnchanged(i, j);
        i += 1;
        j += 1;
      } else if (i < left.length && (j >= right.length || table[i + 1][j] >= table[i][j + 1])) {
        appendRemoved(i);
        i += 1;
      } else if (j < right.length) {
        appendAdded(j);
        j += 1;
      }
    }
  } else {
    // A full LCS matrix grows quadratically and can freeze the revision view.
    // For large prompts, recover a global ordered match while the number of
    // equal-line pairs is bounded. Highly repetitive inputs fall back to the
    // linear-memory greedy path rather than allocating an unbounded graph.
    const rightPositions = new Map<string, number[]>();
    right.forEach((line, index) => {
      const positions = rightPositions.get(line);
      if (positions) positions.push(index);
      else rightPositions.set(line, [index]);
    });
    const matches: Array<[number, number]> = [];
    const maximumMatchPairs = 250_000;
    let matchPairCount = 0;
    for (const line of left) {
      matchPairCount += rightPositions.get(line)?.length || 0;
      if (matchPairCount > maximumMatchPairs) break;
    }
    if (matchPairCount <= maximumMatchPairs) {
      // Hunt-Szymanski: an LIS over matching right-side line numbers gives a
      // maximum ordered match without constructing the full LCS matrix.
      const maximumMatchLength = Math.min(left.length, right.length);
      const tailRightIndexes = new Int32Array(maximumMatchLength);
      const tailNodeIndexes = new Int32Array(maximumMatchLength);
      const nodeLeftIndexes = new Int32Array(matchPairCount);
      const nodeRightIndexes = new Int32Array(matchPairCount);
      const nodePreviousIndexes = new Int32Array(matchPairCount);
      let tailCount = 0;
      let nodeCount = 0;
      left.forEach((line, leftIndex) => {
        const positions = rightPositions.get(line);
        if (!positions) return;
        for (let positionIndex = positions.length - 1; positionIndex >= 0; positionIndex -= 1) {
          const rightIndex = positions[positionIndex];
          let low = 0;
          let high = tailCount;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (tailRightIndexes[middle] < rightIndex) low = middle + 1;
            else high = middle;
          }
          const nodeIndex = nodeCount;
          nodeCount += 1;
          nodeLeftIndexes[nodeIndex] = leftIndex;
          nodeRightIndexes[nodeIndex] = rightIndex;
          nodePreviousIndexes[nodeIndex] = low > 0 ? tailNodeIndexes[low - 1] : -1;
          tailRightIndexes[low] = rightIndex;
          tailNodeIndexes[low] = nodeIndex;
          if (low === tailCount) tailCount += 1;
        }
      });
      let nodeIndex = tailCount > 0 ? tailNodeIndexes[tailCount - 1] : -1;
      while (nodeIndex >= 0) {
        matches.push([nodeLeftIndexes[nodeIndex], nodeRightIndexes[nodeIndex]]);
        nodeIndex = nodePreviousIndexes[nodeIndex];
      }
      matches.reverse();
    } else {
      const forwardMatches: Array<[number, number]> = [];
      let lastRightIndex = -1;
      left.forEach((line, leftIndex) => {
        const positions = rightPositions.get(line);
        if (!positions?.length) return;
        let low = 0;
        let high = positions.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (positions[middle] <= lastRightIndex) low = middle + 1;
          else high = middle;
        }
        if (low >= positions.length) return;
        lastRightIndex = positions[low];
        forwardMatches.push([leftIndex, lastRightIndex]);
      });
      const reverseMatches: Array<[number, number]> = [];
      let nextRightIndex = right.length;
      for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
        const positions = rightPositions.get(left[leftIndex]);
        if (!positions?.length) continue;
        let low = 0;
        let high = positions.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (positions[middle] < nextRightIndex) low = middle + 1;
          else high = middle;
        }
        const positionIndex = low - 1;
        if (positionIndex < 0) continue;
        nextRightIndex = positions[positionIndex];
        reverseMatches.push([leftIndex, nextRightIndex]);
      }
      reverseMatches.reverse();
      matches.push(...(
        reverseMatches.length > forwardMatches.length
          ? reverseMatches
          : forwardMatches
      ));
    }
    let leftIndex = 0;
    let rightIndex = 0;
    for (const [matchedLeft, matchedRight] of matches) {
      while (leftIndex < matchedLeft) appendRemoved(leftIndex++);
      while (rightIndex < matchedRight) appendAdded(rightIndex++);
      appendUnchanged(matchedLeft, matchedRight);
      leftIndex = matchedLeft + 1;
      rightIndex = matchedRight + 1;
    }
    while (leftIndex < left.length) appendRemoved(leftIndex++);
    while (rightIndex < right.length) appendAdded(rightIndex++);
  }
  const common = unchanged.length;
  const similarity = left.length === 0 && right.length === 0 ? 1 : common / Math.max(left.length, right.length, 1);
  return { leftText, rightText, changed: leftText !== rightText, added, removed, unchanged, entries, similarity };
};

export const diffPromptText = comparePromptText;
export const compareText = comparePromptText;

const revisionPrompt = (revision: StoryboardRevision): string => revision.finalPrompt || '';

/** Compare two immutable revisions, including per-shot prompt changes. */
export const compareStoryboardRevisions = (
  left: StoryboardRevision,
  right: StoryboardRevision
): RevisionComparison => {
  const prompt = comparePromptText(revisionPrompt(left), revisionPrompt(right));
  const englishPrompt = left.englishPrompt !== undefined || right.englishPrompt !== undefined
    ? comparePromptText(left.englishPrompt || '', right.englishPrompt || '')
    : undefined;
  const leftShots = new Map((left.shots || []).map((shot) => [shot.id, shot]));
  const rightShots = new Map((right.shots || []).map((shot) => [shot.id, shot]));
  const changedShotIds: string[] = [];
  const addedShotIds: string[] = [];
  const removedShotIds: string[] = [];
  const shotPromptDiffs: Record<string, TextComparison> = {};
  rightShots.forEach((shot, id) => {
    if (!leftShots.has(id)) {
      addedShotIds.push(id);
      shotPromptDiffs[id] = comparePromptText('', textOf(shot.prompt));
      changedShotIds.push(id);
      return;
    }
    const before = leftShots.get(id);
    const diff = comparePromptText(textOf(before?.prompt), textOf(shot.prompt));
    if (diff.changed || before?.startSec !== shot.startSec || before?.endSec !== shot.endSec) {
      changedShotIds.push(id);
      shotPromptDiffs[id] = diff;
    }
  });
  leftShots.forEach((_shot, id) => {
    if (!rightShots.has(id)) {
      removedShotIds.push(id);
      changedShotIds.push(id);
      shotPromptDiffs[id] = comparePromptText(textOf(leftShots.get(id)?.prompt), '');
    }
  });
  return {
    changed: prompt.changed || !!englishPrompt?.changed || changedShotIds.length > 0,
    prompt,
    ...(englishPrompt ? { englishPrompt } : {}),
    changedShotIds: [...new Set(changedShotIds)],
    addedShotIds,
    removedShotIds,
    shotPromptDiffs
  };
};

export const compareRevisions = compareStoryboardRevisions;

const candidateFrom = (
  input: StoryboardRevision | ABCandidateInput | StoryboardRevisionSource,
  source: ABCandidate['source'],
  fallbackId: string,
  fallbackLabel: string
): ABCandidate => {
  const maybe = input as ABCandidateInput;
  const revision = typeof (input as StoryboardRevision).revision === 'number'
    ? input as StoryboardRevision
    : maybe.revision;
  const sourceRecord = maybe.source || (!(maybe.prompt !== undefined) ? input as StoryboardRevisionSource : undefined);
  const prompt = revision?.finalPrompt ?? maybe.prompt ?? sourceRecord?.finalPrompt ?? '';
  const englishPrompt = revision?.englishPrompt ?? maybe.englishPrompt ?? sourceRecord?.englishPrompt;
  const id = revision?.id || maybe.id || sourceRecord?.id || fallbackId;
  return {
    id,
    label: maybe.label || fallbackLabel,
    prompt,
    ...(englishPrompt !== undefined ? { englishPrompt } : {}),
    ...(revision?.id ? { revisionId: revision.id } : {}),
    source,
    ...(maybe.reason ? { reason: maybe.reason } : {}),
    changedFromBase: false
  };
};

/** Build an A/B set from a base revision and one or more candidate prompts. */
export const createABCandidates = (
  base: StoryboardRevision | ABCandidateInput | StoryboardRevisionSource,
  variants: readonly (StoryboardRevision | ABCandidateInput | StoryboardRevisionSource)[] = [],
  options: { maxCandidates?: number; baseLabel?: string; recommendedId?: string } = {}
): ABCandidateSet => {
  const baseCandidate = candidateFrom(base, 'base', 'candidate-a', options.baseLabel || 'A');
  const maxCandidates = Math.max(1, Math.floor(options.maxCandidates ?? 2));
  const candidates: ABCandidate[] = [baseCandidate];
  variants.slice(0, Math.max(0, maxCandidates - 1)).forEach((variant, index) => {
    const candidate = candidateFrom(variant, 'variant', `candidate-${String.fromCharCode(66 + index).toLowerCase()}`, String.fromCharCode(66 + index));
    candidate.changedFromBase = candidate.prompt !== baseCandidate.prompt || candidate.englishPrompt !== baseCandidate.englishPrompt;
    candidate.diffFromBase = comparePromptText(baseCandidate.prompt, candidate.prompt);
    candidates.push(candidate);
  });
  return { base: baseCandidate, candidates, ...(options.recommendedId ? { recommendedId: options.recommendedId } : {}) };
};

export const buildABCandidates = createABCandidates;
export const makeABCandidates = createABCandidates;

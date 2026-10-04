import { composeDerivedLocalPrompt, hasCurrentTextApiConversion } from './appEffects';
import { applyConvertedPromptToShots, masterPromptConfirmationFingerprint } from './masterTimeline';
import { sliceMasterShotsForSegment } from './sequencePlan';
import { sourceContentHash } from './sourceIntegrity';
import type { Storyboard, VideoSegment, VideoSequencePlan } from './types';

export interface ConfirmedMasterSliceSourceContext {
  plan: VideoSequencePlan;
  masterBoard: Storyboard;
  segment: VideoSegment;
}

export interface ConfirmedMasterSliceSource {
  sourceStoryContent: string;
  conversionDraft: Storyboard;
}

const sameNumbers = (left: number, right: number): boolean => Number.isFinite(left)
  && Number.isFinite(right) && Math.abs(left - right) < 0.000001;

/** A segment may own a fraction of one coarse story beat. Its confirmed
 * master shots own the exact source ranges; beat-derived segment.content is
 * still preserved for provenance, never rewritten to match generated prose.
 * Any unproven/edited/clipped case falls back to the caller's full source. */
export const resolveConfirmedMasterSliceSource = (
  board: Storyboard,
  context: ConfirmedMasterSliceSourceContext | undefined,
  conversionDraft: Storyboard = board,
): ConfirmedMasterSliceSource | undefined => {
  if (!context) return undefined;
  const { plan, masterBoard: master, segment } = context;
  const storedSegment = plan.segments.find((candidate) => candidate.id === segment.id);
  const source = master.sourceStoryContent || '';
  if (!storedSegment || segment.contentOverridden || storedSegment.contentOverridden
    || storedSegment.content !== segment.content
    || JSON.stringify(storedSegment.sourceShotIds) !== JSON.stringify(segment.sourceShotIds)
    || !sameNumbers(storedSegment.globalStartSec, segment.globalStartSec)
    || !sameNumbers(storedSegment.globalEndSec, segment.globalEndSec)
    || !sameNumbers(storedSegment.durationSec, segment.durationSec)
    || !source.trim() || plan.sourceStoryContent !== source
    || plan.masterStoryboardId !== master.id || master.segmentId
    || master.sequencePlanId && master.sequencePlanId !== plan.id
    || board.sequencePlanId && board.sequencePlanId !== plan.id
    || board.segmentId && board.segmentId !== segment.id
    || !sameNumbers(board.durationSec, segment.durationSec)
    || board.globalStartSec !== undefined && !sameNumbers(board.globalStartSec, segment.globalStartSec)
    || board.globalEndSec !== undefined && !sameNumbers(board.globalEndSec, segment.globalEndSec)
    || master.promptTrace?.shotPlanMode !== 'ai-complete'
    || !hasCurrentTextApiConversion(master)
    || master.promptPlan?.canonicalPrompt && master.promptPlan.canonicalPrompt !== master.finalPrompt
    || !plan.masterPromptConfirmedFingerprint
    || plan.masterPromptConfirmedFingerprint !== masterPromptConfirmationFingerprint(plan, master)
    || master.sourceContentHash && master.sourceContentHash !== sourceContentHash(source)
    || plan.sourceContentHash && plan.sourceContentHash !== sourceContentHash(source)) return undefined;

  try {
    const slice = sliceMasterShotsForSegment(master.shots, segment);
    const selectedIds = segment.sourceShotIds || [];
    if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length
      || JSON.stringify(slice.sourceShotIds) !== JSON.stringify(selectedIds)
      || slice.shots.length !== board.shots.length) return undefined;
    const selected = selectedIds.map((id) => master.shots.find((shot) => shot.id === id));
    if (selected.some((shot) => !shot)) return undefined;
    // The slice helper supports clipping elsewhere. Narrowed source evidence
    // only supports complete selected shots, never a partial time interval.
    if (!sameNumbers(selected[0]!.startSec, segment.globalStartSec)
      || !sameNumbers(selected[selected.length - 1]!.endSec, segment.globalEndSec)
      || !sameNumbers(segment.globalEndSec - segment.globalStartSec, segment.durationSec)
      || selected.some((shot, index) => shot!.startSec < segment.globalStartSec
        || shot!.endSec > segment.globalEndSec
        || index > 0 && !sameNumbers(selected[index - 1]!.endSec, shot!.startSec))) return undefined;

    const expectedPrompt = composeDerivedLocalPrompt(slice.shots, segment.entryState, segment.exitState);
    if (board.finalPrompt !== expectedPrompt
      || board.promptPlan?.canonicalPrompt && board.promptPlan.canonicalPrompt !== expectedPrompt) return undefined;
    const synchronized = applyConvertedPromptToShots(slice.shots, expectedPrompt, segment.durationSec);
    if (board.shots.some((shot, index) => {
      const original = slice.shots[index];
      const displayed = synchronized[index];
      return shot.id !== original.id
        || !sameNumbers(shot.startSec, original.startSec) || !sameNumbers(shot.endSec, original.endSec)
        || shot.sourceStart !== original.sourceStart || shot.sourceEnd !== original.sourceEnd
        || shot.sourceLocationStatus === 'unlocated'
        || ![original.subject, displayed.subject].includes(shot.subject)
        || ![original.action, displayed.action].includes(shot.action)
        || ![original.prompt, displayed.prompt].includes(shot.prompt);
    })) return undefined;

    const insideSurrogatePair = (offset: number): boolean => offset > 0 && offset < source.length
      && /[\uD800-\uDBFF]/u.test(source[offset - 1]) && /[\uDC00-\uDFFF]/u.test(source[offset]);
    const ranges = selected.map((shot) => ({ start: shot!.sourceStart!, end: shot!.sourceEnd! }));
    if (selected.some((shot) => shot!.sourceLocationStatus === 'unlocated')
      || ranges.some(({ start, end }) => !Number.isInteger(start) || !Number.isInteger(end)
        || start < 0 || end <= start || end > source.length
        || insideSurrogatePair(start) || insideSurrogatePair(end)
        || !source.slice(start, end).trim())) return undefined;

    const merged: Array<{ start: number; end: number; localStart: number }> = [];
    for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range, localStart: 0 });
    }
    let scopedSource = '';
    for (const range of merged) {
      if (scopedSource) scopedSource += '\n';
      range.localStart = scopedSource.length;
      scopedSource += source.slice(range.start, range.end);
    }
    const scopedShots = board.shots.map((shot, index) => {
      const range = ranges[index];
      const owner = merged.find((span) => span.start <= range.start && span.end >= range.end)!;
      return {
        ...shot,
        sourceStart: owner.localStart + range.start - owner.start,
        sourceEnd: owner.localStart + range.end - owner.start,
        sourceLocationStatus: 'located' as const,
        sourceBeatIds: [],
      };
    });
    return {
      sourceStoryContent: scopedSource,
      conversionDraft: { ...conversionDraft, sourceStoryContent: scopedSource, sourceSceneSnapshots: [], shots: scopedShots },
    };
  } catch {
    // A stale/unparseable master is not permission to delete dialogue from the
    // segment source. The existing conservative conversion route handles it.
    return undefined;
  }
};

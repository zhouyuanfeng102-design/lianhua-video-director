import type { VideoBatchChoiceCandidate } from './videoBatch';
import type { VideoBatchItemInput } from './videoGenerationTypes';

/** UI previews are advisory; the engine remains the final duplicate/active-task guard. */
export const videoBatchCandidateWillSubmit = (candidate: Pick<VideoBatchChoiceCandidate, 'duplicate'>, regenerateSucceeded: boolean): boolean =>
  !candidate.duplicate || Boolean(regenerateSucceeded && candidate.duplicate.kind === 'succeeded');

export const videoBatchConfirmationPendingCount = (selected: readonly VideoBatchChoiceCandidate[], items: readonly VideoBatchItemInput[]): number =>
  selected.filter((candidate) => videoBatchCandidateWillSubmit(candidate,
    Boolean(items.find((item) => item.itemKey === candidate.key)?.force))).length;

export const videoBatchConfirmationItemStatus = (
  candidate: Pick<VideoBatchChoiceCandidate, 'duplicate' | 'draft'>,
  item: VideoBatchItemInput | undefined,
  automaticChain: boolean,
): string => {
  if (candidate.duplicate?.kind === 'in-flight') return automaticChain
    ? '已有进行中或待确认任务，整链待核对'
    : '进行中或结果待确认，将跳过';
  if (item?.force) return '允许重新生成（可能再次收费）';
  if (item?.previousTail) return '等待上段尾帧后提交';
  if (candidate.duplicate) return automaticChain ? '存在相同任务，启动前整链核对' : '已生成，将跳过';
  return candidate.draft.reuseTaskId ? '失败项复核后待提交' : '待提交';
};

/** Explicit regeneration is a batch intent, not a property of the UI's duplicate
 * cache. Archived results and dependency-aware fingerprints are resolved later
 * by the engine, so every selected item must carry the same authorization. */
export const buildVideoBatchSubmissionItems = (
  selected: readonly VideoBatchChoiceCandidate[],
  regenerateSucceeded: boolean,
  previousTailFor: (candidate: VideoBatchChoiceCandidate) => VideoBatchItemInput['previousTail'],
): VideoBatchItemInput[] => selected.map((candidate) => ({
  itemKey: candidate.key,
  draft: structuredClone(candidate.draft),
  force: regenerateSucceeded || undefined,
  previousTail: previousTailFor(candidate),
}));

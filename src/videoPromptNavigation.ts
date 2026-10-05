import type { Project } from './types';
import type { VideoPromptSource } from './videoGenerationTypes';
import { chapterIdForStoryboard } from './chapters';

/** Resolve the displayed director context from the actual board membership.
 * Never let a stale saved plan hint point the viewer at another segment. */
export const resolveVideoPromptNavigation = (project: Project, storyboardId: string, source?: VideoPromptSource) => {
  const board = project.storyboards.find((item) => item.id === storyboardId);
  if (!board) return undefined;
  const chapterId = chapterIdForStoryboard(project, board);
  const chapter = chapterId ? { chapterId } : {};
  const plans = [...project.sequencePlans].sort((left, right) =>
    Number(right.id === source?.sequencePlanId || right.id === board.sequencePlanId)
      - Number(left.id === source?.sequencePlanId || left.id === board.sequencePlanId));
  for (const plan of plans) {
    const segment = plan.segments.find((item) => item.storyboardId === board.id);
    if (segment) return { storyboardId: board.id, ...chapter, mode: 'sequence' as const, planId: plan.id, segmentId: segment.id, language: source?.language || 'zh' as const };
  }
  // A previous/orphaned board is still viewable; do not replace it with the
  // segment's newer board merely because its old metadata names that segment.
  return { storyboardId: board.id, ...chapter, mode: 'single' as const, planId: undefined, segmentId: undefined, language: source?.language || 'zh' as const };
};

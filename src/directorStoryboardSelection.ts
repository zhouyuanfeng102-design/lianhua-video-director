import type { Project, Storyboard } from './types';

type DirectorProject = Pick<Project, 'storyboards' | 'sequencePlans'>;

/** A segment or master never becomes a standalone result just because it was
 * selected most recently. Plan membership also covers older sparse records. */
export const selectSingleDirectorStoryboard = (
  project: DirectorProject, selectedId?: string, rememberedId?: unknown,
): Storyboard | undefined => {
  const sequenceIds = new Set(project.sequencePlans.flatMap((plan) => [
    plan.masterStoryboardId, ...plan.segments.map((segment) => segment.storyboardId),
  ]));
  const singles = project.storyboards.filter((board) => !board.sequencePlanId && !board.segmentId
    && !board.segmentIndex && !sequenceIds.has(board.id));
  return singles.find((board) => board.id === selectedId)
    || singles.find((board) => board.id === rememberedId)
    || singles.reduce<Storyboard | undefined>((latest, board) => !latest || board.updatedAt > latest.updatedAt ? board : latest, undefined);
};

/** The explicit source link can still open an orphaned historical segment.
 * Normal mode switching and saved single-mode state only select standalone work. */
export const selectDirectorStoryboard = (project: DirectorProject, selection: {
  mode: 'single' | 'sequence';
  selectedId?: string;
  rememberedSingleId?: unknown;
  sequenceStoryboardId?: string;
  sourceStoryboardId?: string;
}): Storyboard | undefined => {
  if (selection.mode === 'sequence') return project.storyboards.find((board) => board.id === selection.sequenceStoryboardId);
  if (selection.sourceStoryboardId && selection.sourceStoryboardId === selection.selectedId) {
    return project.storyboards.find((board) => board.id === selection.sourceStoryboardId);
  }
  return selectSingleDirectorStoryboard(project, selection.selectedId, selection.rememberedSingleId);
};

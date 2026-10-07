import type { ChapterWorkspace, Project, VideoSequencePlan } from './types';

export interface SequencePlanDeletionResult {
  project: Project;
  removedStoryboardIds: string[];
  /** Only IDs no longer present in any surviving plan. */
  removedSegmentIds: string[];
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object' && !Array.isArray(value);

const linkedStoryboardIds = (plan: VideoSequencePlan): Set<string> => new Set([
  ...(plan.masterStoryboardId ? [plan.masterStoryboardId] : []),
  ...plan.segments.flatMap((segment) => segment.storyboardId ? [segment.storyboardId] : []),
]);

/** Remove editable selections, never historical media/task provenance or the
 * user's single-video draft. Keep its source evidence too: deletion must not
 * silently turn a sourced request into an unrestricted manual request. */
const detachWorkspace = (
  workspace: ChapterWorkspace,
  planId: string,
  storyboardIds: Set<string>,
  segmentIds: Set<string>,
): ChapterWorkspace => {
  let directorControls = workspace.directorControls;
  if (directorControls) {
    const removesPlan = directorControls.activePlanId === planId;
    const removesBoard = typeof directorControls.activeStoryboardId === 'string'
      && storyboardIds.has(directorControls.activeStoryboardId);
    const removesSegment = typeof directorControls.activeSegmentId === 'string'
      && segmentIds.has(directorControls.activeSegmentId);
    if (removesPlan || removesBoard || removesSegment) {
      directorControls = { ...directorControls };
      if (removesPlan) {
        delete directorControls.activePlanId;
        delete directorControls.confirmedSequencePlanFingerprint;
        delete directorControls.acknowledgedCompressedPlanFingerprint;
        delete directorControls.acceptedSequencePlanMismatchFingerprint;
      }
      if (removesBoard) delete directorControls.activeStoryboardId;
      if (removesPlan || removesSegment) delete directorControls.activeSegmentId;
    }
  }

  let videoDirector = workspace.videoDirector;
  if (record(videoDirector)) {
    let nextVideoDirector = videoDirector;
    if (record(videoDirector.batch) && videoDirector.batch.planId === planId) {
      nextVideoDirector = { ...nextVideoDirector, generationMode: 'single' };
      delete nextVideoDirector.batch;
    }
    videoDirector = nextVideoDirector;
  }
  return directorControls === workspace.directorControls && videoDirector === workspace.videoDirector
    ? workspace
    : { ...workspace,
      ...(directorControls !== workspace.directorControls ? { directorControls } : {}),
      ...(videoDirector !== workspace.videoDirector ? { videoDirector } : {}),
    };
};

/** Delete one timeline plan and only its exclusive editable storyboards.
 * Shared or contradictory links must never authorize deleting another plan's
 * prompts. Keeping the old project immutable lets workspace undo restore it.
 * Generated assets and frozen generation tasks are intentionally untouched. */
export const deleteSequencePlanFromProject = (
  project: Project,
  planId: string,
  updatedAt = Date.now(),
): SequencePlanDeletionResult => {
  const plan = project.sequencePlans.find((entry) => entry.id === planId);
  if (!plan) return { project, removedStoryboardIds: [], removedSegmentIds: [] };
  const sequencePlans = project.sequencePlans.filter((entry) => entry.id !== planId);
  const planBoards = linkedStoryboardIds(plan);
  const protectedBoards = new Set(sequencePlans.flatMap((entry) => [...linkedStoryboardIds(entry)]));
  const survivingSegments = new Set(sequencePlans.flatMap((entry) => entry.segments.map((segment) => segment.id)));
  const removedSegmentIds = [...new Set(plan.segments.map((segment) => segment.id))]
    .filter((id) => !survivingSegments.has(id));
  const removedStoryboardIds = project.storyboards.filter((board) => {
    if (protectedBoards.has(board.id)) return false;
    if (board.sequencePlanId && board.sequencePlanId !== planId) return false;
    if (board.chapterId && plan.chapterId && board.chapterId !== plan.chapterId) return false;
    return board.sequencePlanId === planId || planBoards.has(board.id);
  }).map((board) => board.id);
  const removedBoards = new Set(removedStoryboardIds);
  const removedSegments = new Set(removedSegmentIds);
  const storyboards = removedBoards.size
    ? project.storyboards.filter((board) => !removedBoards.has(board.id)) : project.storyboards;
  const scenes = project.scenes.map((scene) => scene.storyboardIds.some((id) => removedBoards.has(id))
    ? { ...scene, storyboardIds: scene.storyboardIds.filter((id) => !removedBoards.has(id)) } : scene);
  const scenesChanged = scenes.some((scene, index) => scene !== project.scenes[index]);
  let chapterWorkspaces = project.chapterWorkspaces;
  if (chapterWorkspaces) {
    const workspaces = Object.entries(chapterWorkspaces).map(([id, workspace]) => (
      [id, detachWorkspace(workspace, planId, removedBoards, removedSegments)] as const
    ));
    if (workspaces.some(([id, workspace]) => workspace !== chapterWorkspaces![id])) {
      chapterWorkspaces = Object.fromEntries(workspaces);
    }
  }
  return {
    project: {
      ...project, sequencePlans, storyboards, updatedAt,
      ...(scenesChanged ? { scenes } : {}),
      ...(chapterWorkspaces !== project.chapterWorkspaces ? { chapterWorkspaces } : {}),
    },
    removedStoryboardIds,
    removedSegmentIds,
  };
};

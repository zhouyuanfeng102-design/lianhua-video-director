import { isVideoGenerationTask, isVisibleGenerationTask } from './generationTasks';
import { findProjectVideoTask, preserveVideoProvenanceBeforeTaskRemoval } from './videoProvenance';
import { videoTaskDeletionBlocked } from './videoTaskDeletionSafety';
import type { GenerationTask, ReferenceAsset, VideoGenerationTask } from './types';
import type { VideoGenerationRuntime } from './videoGenerationTypes';

type BatchDeletionProject = {
  id: string;
  generationTasks: GenerationTask[];
  assets: ReferenceAsset[];
};

export interface VideoBatchDeletionOptions {
  /** The project captured by the clicked batch card, never the current tab by inference. */
  projectId: string;
  batchId: string;
  /** Read the live runtime again inside the state commit, not a render-time copy. */
  getRuntime?: (taskId: string) => VideoGenerationRuntime | undefined;
  activeLocalTaskId?: string;
}

export interface VideoBatchDeletionInspection {
  taskIds: string[];
  blockedTaskIds: string[];
  canDelete: boolean;
  reason?: string;
}

const unsafeTask = (task: VideoGenerationTask, options: VideoBatchDeletionOptions): boolean => (
  videoTaskDeletionBlocked(task, options.getRuntime?.(task.id), options.activeLocalTaskId)
);

const exactContinuationChild = (source: VideoGenerationTask, child: VideoGenerationTask | undefined, projectId: string): child is VideoGenerationTask => {
  const claim = source.videoJob?.batchContinuation;
  const lineage = child?.videoJob?.snapshot.continuedFrom;
  return Boolean(claim && child?.videoJob && child.id === claim.taskId && child.batchId === claim.batchId && child.videoJob.snapshot.projectId === projectId
    && source.requestFingerprint && lineage?.version === 1 && lineage.planId === claim.planId
    && lineage.taskId === source.id && lineage.batchId === source.batchId && lineage.requestFingerprint === source.requestFingerprint);
};

const pendingContinuation = (
  project: BatchDeletionProject,
  task: VideoGenerationTask,
  options: VideoBatchDeletionOptions,
  ancestors = new Set<string>(),
): boolean => {
  const claim = task.videoJob?.batchContinuation;
  if (!claim || claim.released) return false;
  if (ancestors.has(task.id)) return true;
  const nextAncestors = new Set(ancestors); nextAncestors.add(task.id);
  // A created child owns its own execution. Keep validating lineage, but its
  // runtime must not prevent removal of a terminal source from the task list.
  // Such sources stay as history-only records, so no parent claim is released.
  const child = findProjectVideoTask(project, claim.taskId);
  if (!exactContinuationChild(task, child, project.id)
    || project.generationTasks.filter((entry) => entry.id === claim.taskId).length > 1) return true;
  return pendingContinuation(project, child, options, nextAncestors);
};

/** Pure eligibility for both the card and the final synchronous state update. */
export const inspectVideoBatchDeletion = (
  project: BatchDeletionProject,
  options: VideoBatchDeletionOptions,
): VideoBatchDeletionInspection => {
  if (!options.projectId || project.id !== options.projectId) {
    return { taskIds: [], blockedTaskIds: [], canDelete: false, reason: '项目已切换，未删除其他项目的任务。' };
  }
  if (!options.batchId.trim()) return { taskIds: [], blockedTaskIds: [], canDelete: false };
  const tasks = project.generationTasks.filter((task): task is VideoGenerationTask => (
    isVideoGenerationTask(task) && isVisibleGenerationTask(task) && task.batchId === options.batchId
  ));
  if (!tasks.length) return { taskIds: [], blockedTaskIds: [], canDelete: false };
  const occurrences = new Map<string, number>();
  for (const task of project.generationTasks) occurrences.set(task.id, (occurrences.get(task.id) || 0) + 1);
  const taskIds = tasks.map((task) => task.id);
  const blockedTaskIds = tasks.filter((task) => (
    task.videoJob && task.videoJob.snapshot.projectId !== project.id
    || occurrences.get(task.id) !== 1
    || unsafeTask(task, options)
    || pendingContinuation(project, task, options)
  )).map((task) => task.id);
  return {
    taskIds, blockedTaskIds, canDelete: !blockedTaskIds.length,
    ...(blockedTaskIds.length ? { reason: '本批次仍有运行、下载、取消中、结果待确认的任务，或续跑关联尚未建立完整；请处理后再删除。' } : {}),
  };
};

/** Remove list entries atomically. Needed terminal lineage stays as history;
 * this never cancels work, releases a live successor or touches files/APIs. */
export const removeVideoBatchKeepingProvenance = <TProject extends BatchDeletionProject>(
  project: TProject,
  options: VideoBatchDeletionOptions,
): VideoBatchDeletionInspection & { project: TProject; removedTaskIds: string[] } => {
  const inspection = inspectVideoBatchDeletion(project, options);
  if (!inspection.canDelete) return { ...inspection, project, removedTaskIds: [] };
  let preserved = project;
  for (const taskId of inspection.taskIds) preserved = preserveVideoProvenanceBeforeTaskRemoval(preserved, taskId);
  const ids = new Set(inspection.taskIds);
  const removed = new Map(project.generationTasks.filter(isVideoGenerationTask).filter((task) => ids.has(task.id)).map((task) => [task.id, task]));
  const remaining = { ...preserved, generationTasks: preserved.generationTasks.flatMap((task): GenerationTask[] => {
    if (!ids.has(task.id)) return [task];
    const claim = isVideoGenerationTask(task) ? task.videoJob?.batchContinuation : undefined;
    // Preserve identities/timestamps/checkpoints during child initialization
    // as well as after it. Visibility does not change the continuation lock.
    return claim && !claim.released ? [{ ...task, historyOnly: true } as VideoGenerationTask] : [];
  }) };
  const timestamp = Date.now();
  const generationTasks = remaining.generationTasks.map((entry) => {
    if (!isVideoGenerationTask(entry) || entry.videoJob?.snapshot.projectId !== project.id) return entry;
    const claim = entry.videoJob.batchContinuation;
    if (!claim || claim.released || !ids.has(claim.taskId)) return entry;
    const child = removed.get(claim.taskId);
    if (!exactContinuationChild(entry, child, project.id) || findProjectVideoTask(remaining, claim.taskId)) return entry;
    // A deliberately deleted terminal child with no archived video cannot be
    // followed anymore. Release only that exact parent claim in this same
    // immutable update; undo restores child and claim together. A higher
    // revision prevents its old independent journal from reclaiming the slot.
    return { ...entry, updatedAt: timestamp, videoJob: { ...entry.videoJob,
      batchContinuation: { ...claim, revision: claim.revision + 1, released: true as const },
    } };
  });
  return {
    ...inspection,
    project: { ...remaining, generationTasks },
    removedTaskIds: inspection.taskIds,
  };
};

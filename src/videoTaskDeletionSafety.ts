import { videoTaskExplicitlyStopped, videoTaskHasUnresolvedSubmission, videoTaskStoppedLocally } from './videoGenerationQueue';
import { videoTaskBatchStatus } from './videoTaskBatchStatus';
import type { VideoGenerationTask } from './types';
import type { VideoGenerationRuntime } from './videoGenerationTypes';

const activeStages = new Set<VideoGenerationRuntime['stage']>([
  'preparing', 'submitting', 'queued', 'running', 'reconnecting', 'downloading', 'submission-unknown',
]);

/** Shared by list removal and visibility. Explicitly stopped uncertain
 * submissions may be hidden while their original records remain in history;
 * live work and results that still need recovery always stay visible. */
export const videoTaskDeletionBlocked = (
  task: VideoGenerationTask,
  runtime?: VideoGenerationRuntime,
  activeLocalTaskId?: string,
): boolean => {
  const live = runtime || task.videoJob;
  const explicitlyStopped = videoTaskExplicitlyStopped(task);
  if (task.id === activeLocalTaskId || task.videoJob?.cancellationPending || runtime?.cancellationPending) return true;
  if (!explicitlyStopped && (task.videoJob && activeStages.has(task.videoJob.stage) || runtime && activeStages.has(runtime.stage))) return true;
  if (task.videoJob?.resultSelectionRequired || !task.resultAssetId && (
    task.resultUrl || task.status === 'succeeded' || task.videoJob?.generatedAt
    || task.videoJob?.resultAssetIds?.length || task.videoJob?.downloadError || runtime?.downloadError
  )) return true;
  const stoppedLocally = videoTaskStoppedLocally(task)
    && (!runtime || runtime.stage === 'stopped' && runtime.trackingStopped === true);
  if (videoTaskHasUnresolvedSubmission(task) && !stoppedLocally) return true;
  return !['stopped', 'failed', 'succeeded'].includes(videoTaskBatchStatus(task, runtime))
    || !(task.status === 'failed' || task.status === 'succeeded' || live?.trackingStopped && live.stage === 'stopped');
};

/** List removal is an explicit abandonment of local tracking. Keep the old
 * uncertain POST as evidence, but allow a separately confirmed new task. A
 * hidden marker alone cannot release active work or a continuation claim. */
export const videoTaskIsClearedStoppedHistory = (task: VideoGenerationTask): boolean => (
  task.historyOnly === true && videoTaskStoppedLocally(task)
  && videoTaskHasUnresolvedSubmission(task)
  && !videoTaskDeletionBlocked(task)
  && (!task.videoJob?.batchContinuation || task.videoJob.batchContinuation.released === true)
);

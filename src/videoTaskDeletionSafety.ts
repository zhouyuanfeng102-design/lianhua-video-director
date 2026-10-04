import { videoTaskHasUnresolvedSubmission } from './videoGenerationQueue';
import { videoTaskBatchStatus } from './videoTaskBatchStatus';
import type { VideoGenerationTask } from './types';
import type { VideoGenerationRuntime } from './videoGenerationTypes';

const activeStages = new Set<VideoGenerationRuntime['stage']>([
  'preparing', 'submitting', 'queued', 'running', 'reconnecting', 'downloading', 'submission-unknown',
]);

/** Shared by deletion and visibility: a historical marker can never hide live
 * work, an uncertain paid submission or a result that still needs recovery. */
export const videoTaskDeletionBlocked = (
  task: VideoGenerationTask,
  runtime?: VideoGenerationRuntime,
  activeLocalTaskId?: string,
): boolean => {
  const live = runtime || task.videoJob;
  if (task.id === activeLocalTaskId || task.videoJob?.cancellationPending || runtime?.cancellationPending) return true;
  if (task.videoJob && activeStages.has(task.videoJob.stage) || runtime && activeStages.has(runtime.stage)) return true;
  if (task.videoJob?.resultSelectionRequired || !task.resultAssetId && (
    task.resultUrl || task.status === 'succeeded' || task.videoJob?.generatedAt
    || task.videoJob?.resultAssetIds?.length || task.videoJob?.downloadError || runtime?.downloadError
  )) return true;
  if (videoTaskHasUnresolvedSubmission(task)) return true;
  return !['stopped', 'failed', 'succeeded'].includes(videoTaskBatchStatus(task, runtime))
    || !(task.status === 'failed' || task.status === 'succeeded' || live?.trackingStopped && live.stage === 'stopped');
};

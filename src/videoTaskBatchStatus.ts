import type { VideoGenerationTask } from './types';
import type { VideoGenerationRuntime } from './videoGenerationTypes';
import { runningHubRemoteSucceeded } from './videoResultRecovery';

export type VideoTaskBatchStatus = 'pending' | 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'stopped';

/** Remote generation success is not the same as a saved local result. A
 * dependency waiting/blocked state is never described as a successful video. */
export const videoTaskBatchStatus = (task: VideoGenerationTask, runtime?: VideoGenerationRuntime): VideoTaskBatchStatus => {
  const job = task.videoJob;
  const stage = runtime?.stage || job?.stage;
  if (job?.batchQueueState === 'cancelled' || stage === 'stopped' || job?.tailPreparation?.phase === 'cancelled') return 'stopped';
  if (runtime?.downloadError || job?.downloadError) return 'failed';
  if (job?.resultSelectionRequired) return 'pending';
  if (stage === 'downloading') return 'running';
  if (!task.resultAssetId && (task.status === 'failed' || stage === 'failed') && runningHubRemoteSucceeded(task)) return 'pending';
  if (task.status === 'unknown' || stage === 'submission-unknown') return 'unknown';
  if (job?.tailPreparation?.phase === 'waiting' || job?.tailPreparation?.phase === 'blocked') return 'pending';
  if (job?.tailPreparation?.phase === 'extracting') return 'submitting';
  if (task.status === 'failed' || stage === 'failed') return 'failed';
  if (task.status === 'succeeded' || stage === 'succeeded') return job && !task.resultAssetId ? 'running' : 'succeeded';
  if (job?.batchQueueState === 'waiting' || job?.batchQueueState === 'ready' || task.status === 'draft') return 'pending';
  if (task.status === 'submitting' || job?.batchQueueState === 'active' || stage === 'preparing' || stage === 'submitting') return 'submitting';
  if (task.status === 'running' || stage === 'running' || stage === 'reconnecting') return 'running';
  if (task.status === 'submitted' || stage === 'queued') return 'queued';
  return 'running';
};

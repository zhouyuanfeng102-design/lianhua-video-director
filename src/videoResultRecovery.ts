import type { VideoGenerationTask } from './types';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isRunningHubVideoTask = (task: VideoGenerationTask): boolean =>
  task.videoJob?.snapshot?.connection?.backend === 'api' && task.videoJob.snapshot.connection.api?.provider === 'runninghub';

/** Describe the provider's result independently from this app's download state. */
export const runningHubRemoteSucceeded = (task: VideoGenerationTask): boolean => {
  if (!isRunningHubVideoTask(task) || !record(task.response)) return false;
  const response = task.response;
  return /^(?:success|succeeded|completed|done)$/iu.test(String(response.status || ''))
    && (response.errorCode === undefined || response.errorCode === null || response.errorCode === '' || String(response.errorCode) === '0')
    && (response.code === undefined || response.code === null || response.code === '' || String(response.code) === '0');
};

/** Recovery only addresses an existing remote result; it never authorizes a new job. */
export const canRecoverRunningHubResult = (task: VideoGenerationTask): boolean =>
  isRunningHubVideoTask(task)
  && Boolean(task.remoteTaskId || task.resultUrl || runningHubRemoteSucceeded(task))
  && (!task.resultAssetId || Boolean(task.videoJob?.downloadError));

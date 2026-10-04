import type { VideoGenerationTask } from './types';

export type VideoTaskStatus = VideoGenerationTask['status'];

export const nestedValue = (source: unknown, dottedPath: string): unknown => dottedPath
  .split('.')
  .filter(Boolean)
  .reduce<unknown>((value, key) => (
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)[key]
      : undefined
  ), source);

export const normalizeVideoTaskStatus = (value: unknown): VideoTaskStatus => {
  const status = String(value || '').toLowerCase();
  if (/^(success|succeeded|completed|done)$/u.test(status)) return 'succeeded';
  if (/^(fail|failed|error|cancelled|canceled)$/u.test(status)) return 'failed';
  if (/^(running|processing|generating|in_progress)$/u.test(status)) return 'running';
  if (/^(queued|pending|submitted|created)$/u.test(status)) return 'submitted';
  return 'unknown';
};

const scalarText = (value: unknown): string => (
  typeof value === 'string' || typeof value === 'number' ? String(value) : ''
);

export const mapVideoTaskResponse = (
  body: unknown,
  paths: { taskIdPath: string; statusPath: string; resultUrlPath: string },
): { remoteTaskId: string; status: VideoTaskStatus; resultUrl?: string } => {
  const remoteTaskId = scalarText(nestedValue(body, paths.taskIdPath));
  const resultUrl = scalarText(nestedValue(body, paths.resultUrlPath));
  const mappedStatus = normalizeVideoTaskStatus(nestedValue(body, paths.statusPath));
  return {
    remoteTaskId,
    status: mappedStatus === 'failed' ? 'failed' : resultUrl ? 'succeeded' : mappedStatus,
    resultUrl: resultUrl || undefined,
  };
};

import type { VideoGenerationTask } from './types';

/** Persistence/protocol identity only. Never infer lineage from equal prompts,
 * generated-frame pixels, filenames or the newest video in the project. */
export function videoBatchContinuationPersistenceIssue(task: VideoGenerationTask, projectId: string): string | undefined {
  const job = task.videoJob;
  const snapshot = job?.snapshot;
  const claim = job?.batchContinuation;
  const source = snapshot?.continuedFrom;
  if (claim === undefined && source === undefined) return undefined;
  const invalid = '视频续跑来源或认领记录无效，已保留原记录并停止新建任务；请恢复任务记录后再继续。';
  const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!snapshot || snapshot.projectId !== projectId || !identity(task.id) || !identity(task.batchId)
    || !identity(task.requestFingerprint) || !identity(snapshot.clientId)) return invalid;
  if (claim !== undefined && (!object(claim) || claim.version !== 1
    || Object.keys(claim).some((key) => !['version', 'planId', 'batchId', 'taskId', 'revision', 'released'].includes(key))
    || !identity(claim.planId) || !identity(claim.batchId) || !identity(claim.taskId)
    || claim.taskId === task.id || claim.batchId === task.batchId
    || !Number.isSafeInteger(claim.revision) || claim.revision < 1
    || claim.released !== undefined && claim.released !== true)) return invalid;
  if (source !== undefined && (!object(source) || source.version !== 1
    || Object.keys(source).some((key) => !['version', 'planId', 'batchId', 'taskId', 'requestFingerprint'].includes(key))
    || !identity(source.planId) || !identity(source.batchId) || !identity(source.taskId) || !identity(source.requestFingerprint)
    || source.taskId === task.id || source.batchId === task.batchId)) return invalid;
  return undefined;
}

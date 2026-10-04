import type { GenerationTask } from './types';

type TaskIdentity = Pick<GenerationTask, 'id' | 'kind' | 'createdAt'>;

// Session-local revocations outlive undo/redo snapshots and asynchronous workers.
// Persisted cancelled statuses (and normal restart recovery) take over on reload.
// Keep the project and task instance in the key: imported IDs are not globally unique.
const revokedTaskInstances = new Set<string>();
const taskInstanceKey = (projectId: string, task: TaskIdentity): string => JSON.stringify([
  projectId, task.kind, task.id, task.createdAt,
]);

export const revokeQueuedGenerationTask = (projectId: string, task: GenerationTask): boolean => {
  if (!projectId || !task.id || (task.kind !== 'image' && task.kind !== 'autofill')
    || (task.status !== 'queued' && task.status !== 'cancelled')) return false;
  revokedTaskInstances.add(taskInstanceKey(projectId, task));
  return true;
};

export const isGenerationTaskRevoked = (projectId: string, task: TaskIdentity): boolean => (
  revokedTaskInstances.has(taskInstanceKey(projectId, task))
);

export class GenerationTaskCancelledError extends Error {
  constructor(message = '排队任务已取消，未继续调用生成接口。') {
    super(message);
    this.name = 'GenerationTaskCancelledError';
  }
}

export const isGenerationTaskCancelledError = (error: unknown): error is GenerationTaskCancelledError => (
  error instanceof GenerationTaskCancelledError
);

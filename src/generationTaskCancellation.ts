import type { GenerationTask, ImageGenerationTask } from './types';

type TaskIdentity = Pick<GenerationTask, 'id' | 'kind' | 'createdAt'>;

// Session-local revocations outlive undo/redo snapshots and asynchronous workers.
// Persisted cancelled statuses (and normal restart recovery) take over on reload.
// Keep the project and task instance in the key: imported IDs are not globally unique.
const revokedTaskInstances = new Set<string>();
const activeImageTaskControllers = new Map<string, Set<AbortController>>();
const taskInstanceKey = (projectId: string, task: TaskIdentity): string => JSON.stringify([
  projectId, task.kind, task.id, task.createdAt,
]);

export const revokeQueuedGenerationTask = (projectId: string, task: GenerationTask): boolean => {
  if (!projectId || !task.id || (task.kind !== 'image' && task.kind !== 'autofill' && task.kind !== 'image-prompt-reverse')
    || (task.status !== 'queued' && task.status !== 'cancelled')) return false;
  revokedTaskInstances.add(taskInstanceKey(projectId, task));
  return true;
};

/** Vision analysis can be stopped while running; its late response must remain revoked through undo/redo. */
export const revokeImagePromptReverseTask = (projectId: string, task: GenerationTask): boolean => {
  if (!projectId || !task.id || task.kind !== 'image-prompt-reverse'
    || !['queued', 'running', 'cancelled'].includes(task.status)) return false;
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

/** Stop this exact local task even when a provider or local image write never settles. */
export const forceStopImageTask = (projectId: string, task: GenerationTask): boolean => {
  if (!projectId || !task.id || task.kind !== 'image'
    || !['queued', 'running', 'cancelled'].includes(task.status)) return false;
  const key = taskInstanceKey(projectId, task);
  // Revoke before signalling: even a synchronous abort listener cannot commit a late result.
  revokedTaskInstances.add(key);
  activeImageTaskControllers.get(key)?.forEach((controller) => controller.abort());
  return true;
};

/** Place this inside the FIFO worker so cancellation releases its queue slot immediately. */
export const runImageTask = async <T>(
  projectId: string,
  task: ImageGenerationTask,
  worker: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  if (task.status === 'cancelled' || isGenerationTaskRevoked(projectId, task)) throw new GenerationTaskCancelledError();
  const key = taskInstanceKey(projectId, task);
  const controller = new AbortController();
  const controllers = activeImageTaskControllers.get(key) || new Set<AbortController>();
  controllers.add(controller);
  activeImageTaskControllers.set(key, controllers);
  let onAbort!: () => void;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(new GenerationTaskCancelledError('生图任务已强制停止。'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      // Both handlers remain attached after cancellation, consuming any late settlement.
      void Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new GenerationTaskCancelledError('生图任务已强制停止。');
        return worker(controller.signal);
      }).then(resolve, reject);
    });
  } finally {
    controller.signal.removeEventListener('abort', onAbort);
    controllers.delete(controller);
    if (!controllers.size && activeImageTaskControllers.get(key) === controllers) activeImageTaskControllers.delete(key);
  }
};

import type { AppState, ImageApiConfig, ImageGenerationTask } from './types';
import { enqueueImageTask } from './imageTaskQueue';
import { isGenerationTaskRevoked } from './generationTaskCancellation';

export const IMAGE_BATCH_MAX = 8;

export const normalizeImageBatchCount = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(IMAGE_BATCH_MAX, Math.max(1, Math.floor(number))) : 1;
};

/** Configurations contain JSON values only. Never leave nested workflow objects live in a queued request. */
export const cloneImageBatchConfig = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const createImageBatchSeeds = (count: number, initial = Math.floor(Math.random() * 2_147_483_647)): number[] => (
  Array.from({ length: normalizeImageBatchCount(count) }, (_, index) => ((Math.floor(initial) >>> 0) + index) % 2_147_483_647)
);

/** Only standard, numeric sampling inputs are overridden; links and unrelated integers are left alone. */
const withSamplingSeed = (workflowJson: string | undefined, seed: number): string | undefined => {
  if (!workflowJson?.trim()) return workflowJson;
  try {
    const workflow = JSON.parse(workflowJson) as Record<string, unknown>;
    for (const node of Object.values(workflow)) {
      if (!node || typeof node !== 'object') continue;
      const entry = node as { class_type?: unknown; inputs?: Record<string, unknown> };
      if (typeof entry.class_type !== 'string' || !/^(?:KSampler(?:Advanced)?|SamplerCustom(?:Advanced)?|RandomNoise)$/u.test(entry.class_type)) continue;
      for (const key of ['seed', 'noise_seed']) {
        if (entry.inputs && typeof entry.inputs[key] === 'number') entry.inputs[key] = seed;
      }
    }
    return JSON.stringify(workflow);
  } catch {
    // Workflow validation still happens at the normal transport boundary.
    return workflowJson;
  }
};

export const imageBatchMemberApi = (frozen: ImageApiConfig, seed?: number): ImageApiConfig => {
  const config = cloneImageBatchConfig(frozen);
  if (config.backend !== 'comfyui' || seed === undefined) return config;
  config.workflowJson = withSamplingSeed(config.workflowJson, seed);
  config.comfyuiWorkflows = config.comfyuiWorkflows?.map((preset) => ({
    ...preset, workflowJson: withSamplingSeed(preset.workflowJson, seed) || '',
  }));
  return config;
};

/** Missing, cancelled, replaced or restored terminal tasks can never authorize a queued image POST. */
export const imageBatchTaskIsActive = (
  state: AppState,
  projectId: string,
  task: ImageGenerationTask,
  queuedOnly = false,
): boolean => {
  if (isGenerationTaskRevoked(projectId, task)) return false;
  const project = state.project.id === projectId ? state.project : state.projects.find((item) => item.id === projectId);
  const current = project?.generationTasks.find((item) => item.id === task.id);
  return current?.kind === 'image'
    && current.createdAt === task.createdAt
    && current.batchId === task.batchId
    && current.sourceEntityId === task.sourceEntityId
    && current.imageVariant === task.imageVariant
    && current.nsfwPrivatePart === task.nsfwPrivatePart
    && current.referenceScope === task.referenceScope
    && JSON.stringify(current.imageApiSnapshot) === JSON.stringify(task.imageApiSnapshot)
    && current.width === task.width && current.height === task.height
    && current.batchIndex === task.batchIndex && current.batchCount === task.batchCount
    && (current.status === 'queued' || (!queuedOnly && current.status === 'running'));
};

export const isImageTaskActiveInWorkspace = (state: AppState, taskId: string): boolean => (
  [state.project, ...state.projects.filter((project) => project.id !== state.project.id)]
    .some((project) => project.generationTasks.some((task) => task.id === taskId && task.kind === 'image'
      && !isGenerationTaskRevoked(project.id, task)
      && (task.status === 'queued' || task.status === 'running')))
);

/** Enqueue immediately, but retain the existing one-worker FIFO through generation and saving. */
export const enqueueImageBatchMembers = <T>(
  members: readonly T[],
  canStart: (member: T) => boolean,
  worker: (member: T, index: number) => Promise<void>,
): Promise<void> => Promise.all(members.map((member, index) => enqueueImageTask(async () => {
  if (!canStart(member)) return;
  await worker(member, index);
}))).then(() => undefined);

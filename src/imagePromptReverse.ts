import type { AppState, ImagePromptReverseTask, ImageReferenceAssetSnapshot, ReferenceAsset, VisionApiConfig } from './types';
import type { CustomImageGenerationContext } from './customImageGeneration';
import { applyOwnedProjectUpdate } from './appEffects';
import { cloneImageBatchConfig } from './imageBatch';
import { createId, safeFileName, type ManagedMediaResult } from './storage';
import { createImageReferenceAssetSnapshot, imageReferenceSnapshotAssets } from './imageGeneration';
import { resolveDirectStoryboardReferenceImages } from './storyboardImageToImage';
import { readGeneratedImageDimensions } from './imageDimensions';
import { normalizeReferenceImageDataUrl, referenceImageFileName } from './imageReferenceData';
import { requestImagePromptReverse } from './services/llm';
import { createImagePromptReverseTask, GenerationTaskCancelledError, isGenerationTaskCancelledError,
  isGenerationTaskRevoked, patchImagePromptReverseTask, revokeImagePromptReverseTask } from './generationTasks';
import { getSafeErrorDiagnostics } from './errorDiagnostics';

export { imagePromptReverseStatusLabel } from './generationTasks';
export interface ImagePromptReverseContext extends CustomImageGenerationContext {
  analyzeImage?: typeof requestImagePromptReverse;
}
export interface ImagePromptReverseSubmission { referenceAssetId: string; customRequirement?: string }

const workers = new Map<string, Promise<void>>();
const controllers = new Map<string, AbortController>();
const retrying = new Set<string>();
const submissions = new Set<string>();
let queueTail = Promise.resolve();
const key = (projectId: string, task: ImagePromptReverseTask) => JSON.stringify([projectId, task.id, task.createdAt]);
const ownerProject = (state: AppState, projectId: string) => state.project.id === projectId
  ? state.project : state.projects.find((project) => project.id === projectId);
const findOwner = (state: AppState, task: ImagePromptReverseTask) => [state.project,
  ...state.projects.filter((project) => project.id !== state.project.id)]
  .find((project) => project.generationTasks.some((item) => item.kind === 'image-prompt-reverse'
    && item.id === task.id && item.createdAt === task.createdAt));
const announce = (ctx: ImagePromptReverseContext, projectId: string, message: string, tone?: 'normal' | 'error') => {
  if (ctx.getState().project.id === projectId) ctx.notify(message, tone);
};
const active = (ctx: ImagePromptReverseContext, projectId: string, task: ImagePromptReverseTask): boolean => {
  const live = ownerProject(ctx.getState(), projectId)?.generationTasks.find((item) => item.id === task.id);
  return live?.kind === 'image-prompt-reverse' && live.createdAt === task.createdAt
    && ['queued', 'running'].includes(live.status) && !isGenerationTaskRevoked(projectId, live);
};
const patch = (ctx: ImagePromptReverseContext, projectId: string, task: ImagePromptReverseTask,
  changes: Parameters<typeof patchImagePromptReverseTask>[2]) => {
  ctx.updateBackground((state) => applyOwnedProjectUpdate(state, projectId, (project) => {
    const live = project.generationTasks.find((item) => item.id === task.id);
    if (live?.kind !== 'image-prompt-reverse' || live.createdAt !== task.createdAt
      || live.status === 'cancelled' || changes.status !== 'cancelled' && isGenerationTaskRevoked(projectId, live)) return project;
    return { ...project, generationTasks: patchImagePromptReverseTask(project.generationTasks, task.id, changes) };
  }));
};
const validateVisionApi = (api: VisionApiConfig) => {
  if (!api.enabled || !api.vision || !api.baseUrl.trim() || !api.model.trim()) {
    throw new Error('图片反推需要已配置并启用、支持图片输入的视觉 API。');
  }
};
const errorDiagnostic = (error: unknown, api: VisionApiConfig, task?: ImagePromptReverseTask) => getSafeErrorDiagnostics(error,
  { knownSecrets: [api.apiKey], sensitiveTexts: [task?.customRequirement || ''] });

export const waitForImagePromptReverseTask = async (taskId: string): Promise<void> => { await workers.get(taskId); };

const loadFrozenImage = async (ctx: ImagePromptReverseContext, task: ImagePromptReverseTask): Promise<string> => {
  if (task.referenceAssetSnapshots.length !== 1 || task.referenceAssetSnapshots[0].id !== task.referenceAssetId) {
    throw new Error('原反推任务的图片快照缺失或不匹配，不能使用当前图片替代。');
  }
  const [dataUrl] = await resolveDirectStoryboardReferenceImages([task.referenceAssetId],
    imageReferenceSnapshotAssets(task.referenceAssetSnapshots), ctx.loader);
  return normalizeReferenceImageDataUrl(dataUrl);
};

const startWorker = (ctx: ImagePromptReverseContext, projectId: string, originalTask: ImagePromptReverseTask,
  api: VisionApiConfig, originalAsset?: ReferenceAsset): void => {
  let task = originalTask;
  const controller = new AbortController();
  const requestKey = key(projectId, task);
  controllers.set(requestKey, controller);
  const assertActive = () => { if (controller.signal.aborted || !active(ctx, projectId, task)) throw new GenerationTaskCancelledError(); };
  const previous = queueTail;
  const job = (async () => {
    try {
      assertActive();
      if (originalAsset) {
        const [loaded] = await resolveDirectStoryboardReferenceImages([originalAsset.id], [originalAsset], ctx.loader);
        assertActive();
        const dataUrl = normalizeReferenceImageDataUrl(loaded);
        const dimensions = readGeneratedImageDimensions(dataUrl);
        let managed: ManagedMediaResult | undefined;
        if (originalAsset.dataUrl || !originalAsset.managed || !originalAsset.relativePath
          || !/^[a-f0-9]{64}$/iu.test(originalAsset.checksum || '')) {
          if (!ctx.storeImage) throw new Error('当前环境无法固定反推原图，请在桌面版提交。');
          managed = await ctx.storeImage({ dataUrl,
            fileName: referenceImageFileName(`${safeFileName(originalAsset.name)}-反推原图`, dataUrl) });
          assertActive();
        }
        const snapshot = createImageReferenceAssetSnapshot({ ...originalAsset, ...dimensions }, managed);
        task = { ...task, referenceAssetSnapshots: [snapshot], ...dimensions, preparationStage: undefined };
        patch(ctx, projectId, task, { referenceAssetSnapshots: [snapshot], ...dimensions, preparationStage: undefined });
      }
      await previous;
      assertActive();
      const image = await loadFrozenImage(ctx, task);
      assertActive();
      const dimensions = readGeneratedImageDimensions(image);
      task = { ...task, ...dimensions };
      patch(ctx, projectId, task, { status: 'running', ...dimensions, preparationStage: undefined, error: undefined });
      const result = await (ctx.analyzeImage || requestImagePromptReverse)(api, image, task.customRequirement, controller.signal);
      assertActive();
      if (!result || !['prompt', 'characters', 'objects', 'scene', 'style'].every((field) =>
        typeof result[field as keyof typeof result] === 'string' && String(result[field as keyof typeof result]).trim())) {
        throw new Error('图片反推结果不完整，请重试。');
      }
      patch(ctx, projectId, task, { status: 'succeeded', result, error: undefined });
      announce(ctx, projectId, '图片反推已完成，结果已同步到聊天和资料任务。');
    } catch (error) {
      if (controller.signal.aborted || isGenerationTaskCancelledError(error) || isGenerationTaskRevoked(projectId, task)) {
        patch(ctx, projectId, task, { status: 'cancelled', error: undefined });
        return;
      }
      const diagnostic = errorDiagnostic(error, api, task);
      const message = `图片反推失败：${diagnostic.message}`;
      patch(ctx, projectId, task, { status: 'failed', error: message });
      announce(ctx, projectId, message, 'error');
      ctx.reportError?.(diagnostic);
    }
  })();
  queueTail = job.catch(() => {});
  workers.set(task.id, job);
  void job.finally(() => {
    if (workers.get(task.id) === job) workers.delete(task.id);
    if (controllers.get(requestKey) === controller) controllers.delete(requestKey);
  });
};

/** A task is registered immediately; reference preparation and vision run in the project-owned worker. */
export const submitImagePromptReverse = async (ctx: ImagePromptReverseContext,
  input: ImagePromptReverseSubmission): Promise<string | undefined> => {
  const initial = ctx.getState();
  const projectId = initial.project.id;
  const api = cloneImageBatchConfig(initial.settings.visionApi);
  const submissionKey = JSON.stringify([projectId, input.referenceAssetId, input.customRequirement || '']);
  if (submissions.has(submissionKey) || initial.project.generationTasks.some((task) => task.kind === 'image-prompt-reverse'
    && ['queued', 'running'].includes(task.status) && task.referenceAssetId === input.referenceAssetId
    && (task.customRequirement || '') === (input.customRequirement || ''))) {
    announce(ctx, projectId, '这张图片与相同要求已有反推任务正在进行。');
    return undefined;
  }
  submissions.add(submissionKey);
  let submittedTaskId: string | undefined;
  try {
    validateVisionApi(api);
    const asset = initial.project.assets.find((item) => item.id === input.referenceAssetId);
    if (!asset) throw new Error('请先上传或选择一张反推参考图。');
    const frozenAsset = cloneImageBatchConfig(asset);
    const task = createImagePromptReverseTask({ id: createId('image_reverse_task'),
      name: `${asset.name || '参考图'} · 图片反推`, referenceAssetId: asset.id, referenceAssetSnapshots: [],
      customRequirement: input.customRequirement, model: api.model.trim(), preparationStage: 'reference' }, Date.now());
    ctx.updateBackground((state) => applyOwnedProjectUpdate(state, projectId,
      (project) => ({ ...project, generationTasks: [task, ...project.generationTasks] })));
    startWorker(ctx, projectId, task, api, frozenAsset);
    submittedTaskId = task.id;
    announce(ctx, projectId, '已加入图片反推任务。');
    return task.id;
  } catch (error) {
    const diagnostic = errorDiagnostic(error, api);
    announce(ctx, projectId, diagnostic.message, 'error'); ctx.reportError?.(diagnostic);
    return undefined;
  } finally {
    if (submittedTaskId) void waitForImagePromptReverseTask(submittedTaskId).then(() => { submissions.delete(submissionKey); });
    else submissions.delete(submissionKey);
  }
};

export const stopImagePromptReverse = (ctx: ImagePromptReverseContext, source: ImagePromptReverseTask): void => {
  const project = findOwner(ctx.getState(), source);
  const live = project?.generationTasks.find((task) => task.id === source.id);
  if (!project || live?.kind !== 'image-prompt-reverse' || !['queued', 'running'].includes(live.status)) return;
  revokeImagePromptReverseTask(project.id, live);
  patch(ctx, project.id, live, { status: 'cancelled', error: undefined });
  controllers.get(key(project.id, live))?.abort();
  announce(ctx, project.id, '图片反推已停止。');
};

/** Retry owns the original snapshot/requirements, but visibly selects the current vision model. */
export const retryImagePromptReverse = async (ctx: ImagePromptReverseContext,
  source: ImagePromptReverseTask): Promise<string | undefined> => {
  const initial = ctx.getState();
  const api = cloneImageBatchConfig(initial.settings.visionApi);
  const project = findOwner(initial, source);
  if (!project) { ctx.notify('原图片反推任务已不存在。', 'error'); return undefined; }
  const live = project.generationTasks.find((task) => task.id === source.id);
  if (live?.kind !== 'image-prompt-reverse' || ['queued', 'running'].includes(live.status)) return undefined;
  if (project.generationTasks.some((task) => task.kind === 'image-prompt-reverse'
    && ['queued', 'running'].includes(task.status) && task.referenceAssetId === live.referenceAssetId
    && (task.customRequirement || '') === (live.customRequirement || ''))) {
    announce(ctx, project.id, '这张原图与原要求已有反推任务正在进行。'); return undefined;
  }
  const requestKey = key(project.id, live);
  if (retrying.has(requestKey)) return undefined;
  retrying.add(requestKey);
  let retryTaskId: string | undefined;
  try {
    validateVisionApi(api);
    if (live.referenceAssetSnapshots.length !== 1 || live.referenceAssetSnapshots[0].id !== live.referenceAssetId) {
      throw new Error('原任务尚未保存完整图片快照，请恢复原图后创建新任务；不会使用当前参考图替代。');
    }
    // Validate only the frozen locator shape here. Missing files are retained
    // as a visible failed retry task rather than silently using library media.
    imageReferenceSnapshotAssets(live.referenceAssetSnapshots);
    const snapshot: ImageReferenceAssetSnapshot[] = cloneImageBatchConfig(live.referenceAssetSnapshots);
    const task = createImagePromptReverseTask({ id: createId('image_reverse_task'),
      name: `${live.name} · 重试`, referenceAssetId: live.referenceAssetId, referenceAssetSnapshots: snapshot,
      customRequirement: live.customRequirement, model: api.model.trim(), width: live.width, height: live.height }, Date.now());
    ctx.updateBackground((state) => applyOwnedProjectUpdate(state, project.id,
      (owner) => ({ ...owner, generationTasks: [task, ...owner.generationTasks] })));
    startWorker(ctx, project.id, task, api);
    retryTaskId = task.id;
    announce(ctx, project.id, `已用原图和原要求重新反推，使用当前视觉模型：${api.model.trim()}。`);
    return task.id;
  } catch (error) {
    const diagnostic = errorDiagnostic(error, api, live);
    announce(ctx, project.id, diagnostic.message, 'error'); ctx.reportError?.(diagnostic);
    return undefined;
  } finally {
    if (retryTaskId) void waitForImagePromptReverseTask(retryTaskId).then(() => { retrying.delete(requestKey); });
    else retrying.delete(requestKey);
  }
};

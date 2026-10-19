import type { AppState, CustomImageInput, ImageApiConfig, ImageGenerationTask, ImageReferenceAssetSnapshot, ReferenceAsset, TextApiConfig } from './types';
import type { ManagedMediaResult } from './storage';
import { createId, safeFileName } from './storage';
import { applyOwnedProjectUpdate } from './appEffects';
import { cloneImageBatchConfig, imageBatchTaskIsActive } from './imageBatch';
import { captureImageApiSnapshot, resolveImageApiForRegeneration, resolveWorkbenchImageApi } from './imageApiSelection';
import { createImageGenerationTask, GenerationTaskCancelledError, isGenerationTaskCancelledError, isGenerationTaskRevoked, runImageTask } from './generationTasks';
import { createImageReferenceAssetSnapshot, imageReferenceSnapshotAssets } from './imageGeneration';
import { enqueueImageTask } from './imageTaskQueue';
import { resolveImageOutputSize, imageReturnedSizeWarning, type ImageOutputSizePreference } from './imageOutputSize';
import { requestImageModel } from './services/llm';
import { captureCustomImageRule, requestCustomImagePrompt } from './customImagePrompt';
import { assertDirectStoryboardImageApiSupport, resolveDirectStoryboardReferenceImages } from './storyboardImageToImage';
import type { StoryboardReferenceImageLoader } from './storyboardImages';
import { withCustomImageRegenerationSnapshot } from './imageAssetRegenerationSnapshot';
import { readGeneratedImageDimensions } from './imageDimensions';
import { getSafeErrorDiagnostics } from './errorDiagnostics';
import { resolveImageAssetRegenerationTask } from './imageRegeneration';
import { validateRunningHubImageConfig, selectedRunningHubImageWorkflow } from './runningHubImage';

type Update = (updater: (state: AppState) => AppState) => void;
type ImageGenerationResult = Awaited<ReturnType<typeof requestImageModel>>;
export interface CustomImageGenerationContext {
  getState: () => AppState;
  update: Update;
  updateBackground: Update;
  loader: StoryboardReferenceImageLoader;
  storeImage?: (payload: { dataUrl: string; fileName?: string }) => Promise<ManagedMediaResult>;
  generateImage?: typeof requestImageModel;
  convertPrompt?: typeof requestCustomImagePrompt;
  notify: (message: string, tone?: 'normal' | 'error') => void;
  reportError?: (error: unknown) => void;
}
export interface CustomImageSubmission {
  userPrompt: string;
  referenceAssetIds?: readonly string[];
  sizePreference: ImageOutputSizePreference;
  promptMode?: 'raw' | 'rules';
  ruleSetId?: string;
}

// Results are retained until local saving succeeds. The task also carries its
// result locator, so a restart can retry saving without another billable POST.
const pendingResults = new Map<string, ImageGenerationResult>();
const workers = new Map<string, Promise<void>>();
const savingTasks = new Set<string>();
const retryingFamilies = new Set<string>();
const taskKey = (projectId: string, taskId: string) => `${projectId}:${taskId}`;
const ownerProject = (state: AppState, projectId: string) => state.project.id === projectId
  ? state.project : state.projects.find((project) => project.id === projectId);
const announce = (ctx: CustomImageGenerationContext, projectId: string, message: string, tone?: 'normal' | 'error') => {
  if (ctx.getState().project.id === projectId) ctx.notify(message, tone);
};
const patchTask = (ctx: CustomImageGenerationContext, projectId: string, task: ImageGenerationTask, patch: Partial<ImageGenerationTask>) => {
  ctx.updateBackground((state) => applyOwnedProjectUpdate(state, projectId, (project) => ({
    ...project, generationTasks: project.generationTasks.map((current) => current.kind === 'image'
      && current.id === task.id && current.createdAt === task.createdAt && current.status !== 'cancelled'
      && !isGenerationTaskRevoked(projectId, current)
      ? { ...current, ...patch, id: current.id, kind: 'image', createdAt: current.createdAt, updatedAt: Date.now() } : current),
  })));
};
const findOwner = (state: AppState, task: ImageGenerationTask) => {
  const projects = [state.project, ...state.projects.filter((project) => project.id !== state.project.id)];
  return projects.find((project) => project.generationTasks.some((current) => current.kind === 'image'
    && current.id === task.id && current.createdAt === task.createdAt))
    || projects.find((project) => task.resultAssetId && project.assets.some((asset) => asset.id === task.resultAssetId
      && asset.imageRegenerationSnapshot?.sourceKind === 'custom'));
};
const validateImageApi = (api: ImageApiConfig, referenceCount: number) => {
  if (api.backend === 'runninghub') {
    const issue = validateRunningHubImageConfig(api, referenceCount);
    if (issue) throw new Error(issue);
    return;
  }
  if (!api.enabled || !api.baseUrl.trim() || ['openai', 'novelai'].includes(api.backend) && !api.model.trim()) {
    throw new Error('请先配置并启用生图 API。');
  }
  if (referenceCount) assertDirectStoryboardImageApiSupport(api, referenceCount);
};
const validateTextApi = (api: TextApiConfig) => {
  if (!api.enabled || !api.baseUrl.trim() || !api.model.trim()) throw new Error('使用规则转换需要已配置并启用的文本 API；本次未提交生图。');
};
const orderedIds = (ids: readonly string[] = []) => Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
const retryFacts = (task: ImageGenerationTask) => JSON.stringify({
  assetKind: task.assetKind, prompt: task.prompt, negativePrompt: task.negativePrompt,
  width: task.width, height: task.height, sizeOverride: task.sizeOverride, resolutionPlan: task.resolutionPlan,
  backend: task.backend, model: task.model, imageApiSnapshot: task.imageApiSnapshot,
  referenceAssetIds: task.referenceAssetIds, referenceAssetSnapshots: task.referenceAssetSnapshots,
  customImageInput: task.customImageInput, resultAssetId: task.resultAssetId,
  regenerationRootTaskId: task.regenerationRootTaskId, regenerationBaseName: task.regenerationBaseName,
});
const retryName = (base: string, project: AppState['project']) => {
  const names = new Set([...project.assets.map((asset) => asset.name), ...project.generationTasks.flatMap((task) => 'name' in task ? [task.name] : [])]);
  for (let index = 2; ; index += 1) { const name = `${base}-${index}`; if (!names.has(name)) return name; }
};

/** Await a particular background submission in behavior tests or controllers. */
export const waitForCustomImageTask = async (taskId: string): Promise<void> => { await workers.get(taskId); };

const loadFrozenReferences = (ctx: CustomImageGenerationContext, task: ImageGenerationTask): Promise<string[]> => {
  if (!(task.referenceAssetIds || []).length) {
    if ((task.referenceAssetSnapshots || []).length) throw new Error('原任务参考图快照不匹配，不能重新提交。');
    return Promise.resolve([]);
  }
  if ((task.referenceAssetSnapshots || []).map((asset) => asset.id).join('\u0000') !== task.referenceAssetIds!.join('\u0000')) {
    throw new Error('原任务参考图快照不完整，不能用当前图片代替。');
  }
  return resolveDirectStoryboardReferenceImages(task.referenceAssetIds!, imageReferenceSnapshotAssets(task.referenceAssetSnapshots), ctx.loader);
};

const saveResult = async (ctx: CustomImageGenerationContext, projectId: string, task: ImageGenerationTask, result: ImageGenerationResult): Promise<void> => {
  const assertSaveActive = (): ImageGenerationTask => {
    const live = ownerProject(ctx.getState(), projectId)?.generationTasks.find((item) => item.id === task.id);
    if (live?.kind !== 'image' || live.createdAt !== task.createdAt || live.status === 'cancelled'
      || isGenerationTaskRevoked(projectId, live)) throw new GenerationTaskCancelledError();
    return live;
  };
  const current = assertSaveActive();
  if (current.status === 'succeeded' && current.resultAssetId && ownerProject(ctx.getState(), projectId)?.assets.some((asset) => asset.id === current.resultAssetId)) return;
  if (!ctx.storeImage) throw new Error('当前环境无法保存生成图片，请在桌面版重试保存。');
  let dataUrl = result.dataUrl;
  if (!dataUrl && result.url) {
    if (result.url.startsWith('data:image/')) dataUrl = result.url;
    else if (result.url.startsWith('lianhua-asset://') && ctx.loader.readManagedImageDataUrl) {
      throw new Error('本地保存记录缺少原图路径，请恢复原记录后重试保存。');
    } else {
      if (!ctx.loader.downloadImage) throw new Error('图片已生成，但当前环境无法下载原图；请重试保存。');
      dataUrl = await ctx.loader.downloadImage(result.url);
    }
    result.dataUrl = dataUrl;
  }
  assertSaveActive();
  if (!dataUrl || !/^data:image\//iu.test(dataUrl)) throw new Error('图片已生成，但接口未返回可保存的图片内容。');
  const actual = readGeneratedImageDimensions(dataUrl);
  const managed = await ctx.storeImage({ dataUrl, fileName: `${safeFileName(task.name)}.png` });
  assertSaveActive();
  if (!managed.managed || !managed.relativePath || !managed.url || !managed.checksum) throw new Error('图片托管未完成，请重试保存。');
  const timestamp = Date.now();
  const asset = withCustomImageRegenerationSnapshot({
    id: task.resultAssetId || `custom_asset_${task.id}`, name: task.name,
    type: 'reference', role: 'composition', referenceRole: 'general', referenceScope: 'general', mediaType: 'image',
    source: 'generated', managed: true, missing: false, url: managed.url, relativePath: managed.relativePath,
    checksum: managed.checksum, sizeBytes: managed.sizeBytes, fileName: managed.fileName, mimeType: managed.mimeType,
    width: actual?.width, height: actual?.height, customImageInput: cloneImageBatchConfig(task.customImageInput),
    tags: ['自定义生图'], createdAt: timestamp, updatedAt: timestamp,
  }, task);
  let committed = false;
  ctx.updateBackground((state) => applyOwnedProjectUpdate(state, projectId, (project) => {
    const live = project.generationTasks.find((item) => item.id === task.id);
    if (live?.kind !== 'image' || live.createdAt !== task.createdAt || live.status === 'cancelled' || isGenerationTaskRevoked(projectId, live)) return project;
    committed = true;
    return {
      ...project, assets: project.assets.some((item) => item.id === asset.id) ? project.assets : [asset, ...project.assets],
      generationTasks: project.generationTasks.map((item) => item.id === task.id && item.kind === 'image'
        ? { ...item, status: 'succeeded', preparationStage: undefined, customImageSavePending: false,
          resultAssetId: asset.id, resultUrl: managed.url, error: undefined,
          bindingWarning: imageReturnedSizeWarning(task, actual) || undefined, updatedAt: timestamp } : item),
    };
  }));
  if (!committed) throw new GenerationTaskCancelledError();
  pendingResults.delete(taskKey(projectId, task.id));
  announce(ctx, projectId, '自定义图片已生成并保存到资产库。');
};

const startWorker = (
  ctx: CustomImageGenerationContext, projectId: string, originalTask: ImageGenerationTask,
  api: ImageApiConfig, textApi: TextApiConfig,
  prepareReferences?: () => Promise<ImageReferenceAssetSnapshot[]>,
): void => {
  let task = originalTask;
  const active = () => imageBatchTaskIsActive(ctx.getState(), projectId, task);
  const assertActive = () => { if (!active()) throw new GenerationTaskCancelledError(); };
  const job = (async () => {
    const stage: { value: 'reference' | 'convert' | 'generation' | 'save' } = { value: 'reference' };
    try {
      assertActive();
      if (prepareReferences) {
        const referenceAssetSnapshots = await prepareReferences();
        assertActive();
        task = { ...task, referenceAssetSnapshots, preparationStage: undefined };
        patchTask(ctx, projectId, task, { referenceAssetSnapshots, preparationStage: undefined });
      }
      await enqueueImageTask(() => runImageTask(projectId, task, async (signal) => {
        assertActive();
        patchTask(ctx, projectId, task, { status: 'running', error: undefined });
        const referenceImages = await loadFrozenReferences(ctx, task);
        assertActive();
        if (task.customImageInput?.promptMode === 'rules' && !task.prompt.trim()) {
          stage.value = 'convert';
          const rule = task.customImageInput.ruleSelection;
          if (!rule) throw new Error('原任务所选规则快照缺失，不能使用当前规则代替。');
          validateTextApi(textApi);
          patchTask(ctx, projectId, task, { preparationStage: 'prompt-convert' });
          const prompt = await (ctx.convertPrompt || requestCustomImagePrompt)(textApi, {
            userPrompt: task.customImageInput.userPrompt, rule, width: task.width, height: task.height, signal,
          });
          assertActive();
          if (!prompt.trim()) throw new Error('规则转换未返回有效提示词；本次未提交生图。');
          task = { ...task, prompt, preparationStage: undefined };
          patchTask(ctx, projectId, task, { prompt, preparationStage: undefined });
        }
        stage.value = 'generation';
        const raw = task.customImageInput?.promptMode === 'raw';
        const generated = await (ctx.generateImage || requestImageModel)(api, {
          prompt: task.prompt, ...(raw ? { promptMode: 'verbatim' as const } : { negativePrompt: task.negativePrompt }),
          width: task.width, height: task.height, sizeOverride: task.sizeOverride, resolutionPlan: task.resolutionPlan,
          referenceImages, primaryReferenceImageCount: referenceImages.length, preserveReferenceImageOrder: true,
          signal,
        }, assertActive);
        assertActive();
        stage.value = 'save';
        if (!generated.dataUrl && !generated.url) throw new Error('图像接口没有返回图片内容或地址。');
        pendingResults.set(taskKey(projectId, task.id), generated);
        task = { ...task, resultUrl: generated.url || generated.dataUrl, customImageSavePending: true };
        patchTask(ctx, projectId, task, { resultUrl: task.resultUrl, customImageSavePending: true });
        await saveResult(ctx, projectId, task, generated);
      }), { canStart: active });
    } catch (error) {
      if (isGenerationTaskCancelledError(error) || isGenerationTaskRevoked(projectId, task)) {
        pendingResults.delete(taskKey(projectId, task.id));
        patchTask(ctx, projectId, task, { status: 'cancelled', preparationStage: undefined });
        return;
      }
      const diagnostic = getSafeErrorDiagnostics(error, {
        knownSecrets: [api.apiKey, textApi.apiKey],
        sensitiveTexts: [task.customImageInput?.userPrompt || '', task.customImageInput?.ruleSelection?.systemPrompt || ''],
      });
      const prefix = stage.value === 'convert' ? '规则转换未完成，尚未提交生图：' : stage.value === 'save' && task.customImageSavePending
        ? '图片已生成，但保存未完成；请重试保存，无需重新生图：' : '自定义生图失败：';
      const message = `${prefix}${diagnostic.message}`;
      patchTask(ctx, projectId, task, { status: 'failed', preparationStage: undefined, error: message,
        ...(stage.value === 'save' && task.customImageSavePending ? { customImageSavePending: true, resultUrl: task.resultUrl } : {}) });
      announce(ctx, projectId, message, 'error');
      ctx.reportError?.(diagnostic);
    }
  })();
  workers.set(task.id, job);
  void job.finally(() => { if (workers.get(task.id) === job) workers.delete(task.id); });
};

/** Freeze this message only. No story, entity preset or earlier chat is added. */
export const submitCustomImage = async (ctx: CustomImageGenerationContext, input: CustomImageSubmission): Promise<string | undefined> => {
  const initial = ctx.getState();
  const projectId = initial.project.id;
  try {
    if (!input.userPrompt.trim()) throw new Error('请输入本次生图要求。');
    const ids = orderedIds(input.referenceAssetIds);
    const selection = resolveWorkbenchImageApi(initial.settings, 'ordinary');
    if (selection.issue) throw new Error(selection.issue);
    const api = cloneImageBatchConfig(selection.config);
    validateImageApi(api, ids.length);
    const size = resolveImageOutputSize(input.sizePreference, { width: 1024, height: 1024 }, api, 'reference');
    if (size.issue) throw new Error(`生图分辨率无效：${size.issue}`);
    const promptMode = input.promptMode || 'raw';
    const textApi = cloneImageBatchConfig(initial.settings.textApi);
    const ruleSelection = promptMode === 'rules'
      ? captureCustomImageRule(initial.imagePromptRules.ruleSets, input.ruleSetId || '', api) : undefined;
    if (promptMode === 'rules') validateTextApi(textApi);
    const assets = ids.map((id) => {
      const asset = initial.project.assets.find((item) => item.id === id);
      if (!asset) throw new Error(`参考图已不存在：${id}`);
      return { ...asset, tags: [...asset.tags] };
    });
    const imageApiSnapshot = await captureImageApiSnapshot(api, selection.profileId);
    if (!ownerProject(ctx.getState(), projectId)) throw new Error('原项目已不存在，未创建生图任务。');
    const customImageInput: CustomImageInput = { version: 1, userPrompt: input.userPrompt, promptMode, ruleSelection, operation: 'initial' };
    const task = createImageGenerationTask({
      id: createId('image_task'), name: `${initial.project.name} · 自定义生图 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
      assetKind: 'custom', imageVariant: 'reference', imageGenerationMode: ids.length ? 'image-to-image' : 'text-to-image',
      imageInputMode: ids.length ? 'image-to-image' : 'text-to-image', customImageInput,
      prompt: promptMode === 'raw' ? input.userPrompt : '', negativePrompt: ruleSelection?.negativePrompt,
      conversionSource: input.userPrompt, imagePromptFormat: ruleSelection?.format || 'natural-language',
      imagePromptRuleSetId: ruleSelection?.id, imagePromptRuleSetName: ruleSelection?.name, imagePromptRuleSetVersion: ruleSelection?.ruleVersion,
      width: size.width, height: size.height, sizeOverride: size.sizeOverride, resolutionPlan: size.resolutionPlan,
      backend: api.backend, model: api.backend === 'comfyui'
        ? api.comfyuiWorkflows?.find((workflow) => workflow.id === api.activeComfyuiWorkflowId)?.name || 'ComfyUI Workflow'
        : api.backend === 'runninghub' ? selectedRunningHubImageWorkflow(api)?.name || 'RunningHub 图像工作流' : api.model, imageApiSnapshot,
      referenceAssetIds: ids, primaryReferenceAssetIds: ids, referenceAssetSnapshots: [],
      ...(ids.length ? { preparationStage: 'reference' } : {}),
    }, Date.now(), 'queued');
    ctx.updateBackground((state) => applyOwnedProjectUpdate(state, projectId, (project) => ({ ...project, generationTasks: [task, ...project.generationTasks] })));
    startWorker(ctx, projectId, task, api, textApi, async () => {
      const snapshots: ImageReferenceAssetSnapshot[] = [];
      for (const asset of assets) {
        if (!imageBatchTaskIsActive(ctx.getState(), projectId, task)) throw new GenerationTaskCancelledError();
        const [dataUrl] = await resolveDirectStoryboardReferenceImages([asset.id], assets, ctx.loader);
        let managed: ManagedMediaResult | undefined;
        if (asset.dataUrl || !asset.managed || !asset.relativePath || !/^[a-f0-9]{64}$/iu.test(asset.checksum || '')) {
          if (!ctx.storeImage) throw new Error('参考图尚未托管，当前环境不能固定参考图；请在桌面版提交。');
          managed = await ctx.storeImage({ dataUrl, fileName: `${safeFileName(asset.name)}-自定义生图参考.png` });
        }
        snapshots.push(createImageReferenceAssetSnapshot(asset, managed));
      }
      return snapshots;
    });
    announce(ctx, projectId, '已加入自定义生图队列。');
    return task.id;
  } catch (error) {
    const diagnostic = getSafeErrorDiagnostics(error, { knownSecrets: [initial.settings.imageApi.apiKey, initial.settings.textApi.apiKey] });
    announce(ctx, projectId, diagnostic.message, 'error');
    ctx.reportError?.(diagnostic);
    return undefined;
  }
};

/** Saved final words are reused; explicit reconvert uses the frozen rule. */
export const retryCustomImageTask = async (
  ctx: CustomImageGenerationContext, source: ImageGenerationTask, options: { reconvert?: boolean } = {},
): Promise<void> => {
  const initial = ctx.getState();
  const project = findOwner(initial, source);
  if (!project || source.assetKind !== 'custom' || !source.customImageInput) { ctx.notify('自定义生图原任务不存在或快照缺失。', 'error'); return; }
  const live = project.generationTasks.find((task) => task.id === source.id);
  if (live && (live.kind !== 'image' || live.status === 'queued' || live.status === 'running')) return;
  if (live?.kind === 'image' && live.customImageSavePending) { await retryCustomImageSave(ctx, live); return; }
  if (live?.kind === 'image') source = cloneImageBatchConfig(live);
  const familyRoot = source.regenerationRootTaskId || source.id;
  const familyKey = taskKey(project.id, familyRoot);
  if (retryingFamilies.has(familyKey) || project.generationTasks.some((task) => task.kind === 'image'
    && (task.regenerationRootTaskId || task.id) === familyRoot && (task.status === 'queued' || task.status === 'running'))) return;
  retryingFamilies.add(familyKey);
  try {
    if (!live) {
      const asset = project.assets.find((item) => item.id === source.resultAssetId);
      const restored = asset ? resolveImageAssetRegenerationTask(asset, project, initial.settings.imageApi) : null;
      if (!restored || retryFacts(restored) !== retryFacts(source)) throw new Error('这张自定义图片的原任务恢复快照不匹配，请从原资产重新生成。');
      source = cloneImageBatchConfig(restored);
    }
    if (!source.imageApiSnapshot) throw new Error('原任务生图 API 快照缺失，不能使用当前配置代替。');
    const api = await resolveImageApiForRegeneration(initial.settings, source.imageApiSnapshot);
    validateImageApi(api, source.referenceAssetIds?.length || 0);
    const sourceInput = source.customImageInput;
    if (!sourceInput) throw new Error('原任务自定义生图输入快照缺失，不能使用当前要求代替。');
    const customImageInput = cloneImageBatchConfig(sourceInput);
    const reconvert = Boolean(options.reconvert || customImageInput.promptMode === 'rules' && !source.prompt.trim());
    if (reconvert && customImageInput.promptMode !== 'rules') throw new Error('原任务未选择规则，请在自定义生图栏选择规则后创建新任务。');
    if (reconvert && !customImageInput.ruleSelection) throw new Error('原任务规则快照缺失，不能使用当前规则代替。');
    if (!reconvert && !source.prompt.trim()) throw new Error('原任务没有最终提示词，请创建新任务。');
    const textApi = cloneImageBatchConfig(initial.settings.textApi);
    if (reconvert) validateTextApi(textApi);
    const currentProject = ownerProject(ctx.getState(), project.id);
    if (!currentProject || (live ? !currentProject.generationTasks.some((task) => task.id === source.id && task.createdAt === source.createdAt)
      : !currentProject.assets.some((asset) => asset.id === source.resultAssetId))) throw new GenerationTaskCancelledError('原任务或资产已删除，未继续提交生图。');
    const task = createImageGenerationTask({
      ...source, id: createId('image_task'), name: retryName(source.regenerationBaseName || source.name, currentProject),
      prompt: reconvert ? '' : source.prompt,
      customImageInput: { ...customImageInput, operation: reconvert ? 'reconvert' : 'saved-final' },
      regenerationSourceTaskId: source.id, regenerationRootTaskId: source.regenerationRootTaskId || source.id,
      regenerationBaseName: source.regenerationBaseName || source.name,
      customImageSavePending: false, preparationStage: undefined,
    }, Date.now(), 'queued');
    delete task.resultUrl;
    delete task.resultAssetId;
    delete task.error;
    ctx.updateBackground((state) => applyOwnedProjectUpdate(state, project.id, (owner) => ({ ...owner, generationTasks: [task, ...owner.generationTasks] })));
    startWorker(ctx, project.id, task, api, textApi);
    announce(ctx, project.id, reconvert ? '已按原规则快照加入转换和生图队列。' : '已用原最终提示词加入生图队列。');
  } catch (error) {
    const diagnostic = getSafeErrorDiagnostics(error, { knownSecrets: [initial.settings.imageApi.apiKey, initial.settings.textApi.apiKey] });
    announce(ctx, project.id, diagnostic.message, 'error');
    ctx.reportError?.(diagnostic);
  } finally { retryingFamilies.delete(familyKey); }
};

/** A failed download or write is retried without invoking a model. */
export const retryCustomImageSave = async (ctx: CustomImageGenerationContext, source: ImageGenerationTask): Promise<void> => {
  const project = findOwner(ctx.getState(), source);
  if (!project || source.assetKind !== 'custom') return;
  const current = project.generationTasks.find((task) => task.id === source.id);
  if (current?.kind !== 'image' || !current.customImageSavePending || ['queued', 'running', 'cancelled'].includes(current.status)
    || isGenerationTaskRevoked(project.id, current)) return;
  const key = taskKey(project.id, source.id);
  if (savingTasks.has(key)) return;
  savingTasks.add(key);
  const result = pendingResults.get(key) || { ...(current.resultUrl?.startsWith('data:image/') ? { dataUrl: current.resultUrl } : { url: current.resultUrl }) };
  try {
    if (!result.dataUrl && !result.url) throw new Error('原图内容已不可读取；未重新调用生图接口，请恢复图片后再保存。');
    patchTask(ctx, project.id, current, { status: 'running', error: undefined });
    await runImageTask(project.id, current, () => saveResult(ctx, project.id, current, result));
  } catch (error) {
    if (isGenerationTaskCancelledError(error) || isGenerationTaskRevoked(project.id, current)) {
      pendingResults.delete(key);
      return;
    }
    const diagnostic = getSafeErrorDiagnostics(error);
    patchTask(ctx, project.id, current, { status: 'failed', customImageSavePending: true, error: `图片保存未完成：${diagnostic.message}` });
    announce(ctx, project.id, `图片保存未完成：${diagnostic.message}`, 'error');
    ctx.reportError?.(diagnostic);
  } finally { savingTasks.delete(key); }
};

import type { AppState, ImageGenerationTask, ImageReferenceAssetSnapshot, ReferenceAsset, Storyboard, StoryboardImageToImageSettings } from './types';
import type { ManagedMediaResult } from './storage';
import { createId, safeFileName } from './storage';
import { applyOwnedProjectUpdate } from './appEffects';
import { cloneImageBatchConfig, imageBatchTaskIsActive } from './imageBatch';
import { captureImageApiSnapshot, resolveWorkbenchImageApi } from './imageApiSelection';
import { createImageReferenceAssetSnapshot, imageReferenceSnapshotAssets } from './imageGeneration';
import { createImageGenerationTask, GenerationTaskCancelledError, isGenerationTaskCancelledError, isGenerationTaskRevoked, patchImageGenerationTask, settleImageGenerationTask } from './generationTasks';
import { requestImageModel, requestImagePromptConverter, requestTextModel } from './services/llm';
import { readGeneratedImageDimensions } from './imageDimensions';
import { imageReturnedSizeWarning } from './imageOutputSize';
import { buildImagePromptConverterSystemPrompt, gptImage25MicroNsfwConverterExtraRule, isGptImage25MicroNsfwPromptSelection, resolveImagePromptSelection, type ImagePromptBackend } from './imagePromptRules';
import { buildImagePromptIdentityContext } from './imagePromptIdentityContext';
import { getSafeErrorDiagnostics } from './errorDiagnostics';
import { defaultStoryboardImageOutputSize, resolveStoryboardImageOutputSize } from './storyboardImageOutputSize';
import { runStoryboardImageBatch, type StoryboardImageBatchLifecycle, type StoryboardReferenceImageLoader } from './storyboardImages';
import { assertDirectStoryboardImageApiSupport, buildDirectStoryboardImageBatchRequests, buildDirectStoryboardImagePromptWithReferences, directStoryboardImageSourceFingerprint, normalizeStoryboardImageToImageSettings, resolveDirectStoryboardReferenceImages, type DirectStoryboardImagePromptConversion } from './storyboardImageToImage';
import { requestStoryboardImageFramePlan, validateStoryboardImagePlanCount, type StoryboardImageFramePlan } from './storyboardImagePlan';
import { withDirectImageRegenerationSnapshot } from './imageAssetRegenerationSnapshot';

type Update = (updater: (state: AppState) => AppState) => void;

export interface DirectStoryboardImageErrorDetail {
  stage: 'image-preparation' | 'image-reference-load' | 'image-frame-plan' | 'image-prompt-convert' | 'image-generation' | 'image-result-save';
  /** Request-owned scalar metadata only; never credentials or live settings. */
  context: { projectId: string; projectName: string; provider: string; model: string; endpoint: string };
}

export interface DirectStoryboardImageGenerationContext {
  getState: () => AppState;
  update: Update;
  updateBackground: Update;
  lifecycle: StoryboardImageBatchLifecycle;
  loader: StoryboardReferenceImageLoader;
  storeImage?: (payload: { dataUrl: string; fileName?: string }) => Promise<ManagedMediaResult>;
  generateImage?: typeof requestImageModel;
  /** Only custom-count static-frame planning uses text; selected image pixels
   * never enter this call, a prompt converter or identity enrichment. */
  planFrames?: typeof requestStoryboardImageFramePlan;
  requestText?: typeof requestTextModel;
  convertPrompt?: typeof requestImagePromptConverter;
  notify: (message: string, tone?: 'normal' | 'error') => void;
  reportError?: (error: unknown, detail?: DirectStoryboardImageErrorDetail) => void;
}

export interface DirectStoryboardImageGenerationOptions {
  mode: 'storyboard-shots' | 'boundary-frames' | 'selected-shots';
  shotIds?: readonly string[];
  count?: number;
}

/** Track authored source facts only. Picker settings, resolution controls,
 * output links and unrelated task writes cannot invalidate a captured batch. */
const planningSourceIdentity = (state: AppState, board: Storyboard): string => {
  const sourceSceneIds = new Set([board.sceneId, ...(board.sourceSceneIds || [])]);
  return JSON.stringify({
    projectId: state.project.id,
    sourceDocuments: state.project.sourceDocuments.map(({ id, name, content }) => ({ id, name, content })),
    scenes: state.project.scenes.filter((scene) => sourceSceneIds.has(scene.id)).map(({ id, title, content, summary }) => ({ id, title, content, summary })),
    board: {
      id: board.id, sceneId: board.sceneId, sourceSceneIds: board.sourceSceneIds,
      sourceStoryTitle: board.sourceStoryTitle, sourceStoryContent: board.sourceStoryContent,
      sourceContentHash: board.sourceContentHash, sourceSceneSnapshots: board.sourceSceneSnapshots,
      durationSec: board.durationSec, aspectRatio: board.aspectRatio, resolution: board.resolution,
      globalLock: board.globalLock, continuityIn: board.continuityIn, continuityOut: board.continuityOut,
      visualStyle: board.visualStyle, extraRequirement: board.extraRequirement,
      finalPrompt: board.finalPrompt, promptPlan: board.promptPlan,
      officialPromptZh: board.officialPromptZh, officialPromptEn: board.officialPromptEn,
      shots: board.shots.map(({ referenceAssetIds: _references, ...shot }) => shot),
    },
  });
};

const imagePromptBackendForApi = (
  backend: AppState['settings']['imageApi']['backend'],
): Exclude<ImagePromptBackend, 'all'> => (
  backend === 'sd_webui' ? 'sd-webui' : backend
);

const directMicroNsfwReferenceRule = [
  '本次转换结果将用于分镜图生图：参考图会随同一请求上传并负责身份、外貌或场景外观；最终提示词只描述当前目标静帧，不写上传图片编号、规则名称、字段名或制作说明。',
  '保留当前镜头的主体数量、动作、站位、机位、遮挡层、衣着基底和参考图身份；不要改成多视图、拼图、设定板、私密资料图、部位特写、直接裸露或性行为画面。',
].join('\n');

/** Only image-only preferences change: no H3, shot fields or video bindings. */
export const updateStoryboardImageToImageSettings = (
  state: AppState, projectId: string, storyboardId: string, settings: StoryboardImageToImageSettings,
): AppState => applyOwnedProjectUpdate(state, projectId, (project) => ({
  ...project,
  storyboards: project.storyboards.map((board) => board.id === storyboardId ? {
    ...board, imageToImage: normalizeStoryboardImageToImageSettings(settings, board.shots.map((shot) => shot.id)),
  } : board),
}));

/** All existing image buttons use the same captured public image selection.
 * Defaults and boundary frames do not need a text API; a custom total performs
 * only the existing source-text still planning, never image-to-text conversion. */
export const generateDirectStoryboardImages = async (
  ctx: DirectStoryboardImageGenerationContext, projectId: string, storyboardId: string,
  options: DirectStoryboardImageGenerationOptions = { mode: 'storyboard-shots' },
): Promise<void> => {
  const initial = ctx.getState();
  if (initial.project.id !== projectId) return;
  const liveBoard = initial.project.storyboards.find((item) => item.id === storyboardId);
  if (!liveBoard) { ctx.notify('所选分镜已不存在，请重新选择。', 'error'); return; }
  const board = cloneImageBatchConfig(liveBoard);
  const requested = cloneImageBatchConfig(options);
  const projectContextSnapshot = { projectId, projectName: initial.project.name };
  const textApi = cloneImageBatchConfig(initial.settings.textApi);
  const textErrorContext: DirectStoryboardImageErrorDetail['context'] = {
    ...projectContextSnapshot, provider: textApi.provider, model: textApi.model, endpoint: textApi.baseUrl,
  };
  let imageErrorContext: DirectStoryboardImageErrorDetail['context'] = {
    ...projectContextSnapshot, provider: initial.settings.imageApi.backend,
    model: initial.settings.imageApi.model, endpoint: initial.settings.imageApi.baseUrl,
  };
  let failureDetail: DirectStoryboardImageErrorDetail = { stage: 'image-preparation', context: imageErrorContext };
  let conversionErrorSensitiveTexts: readonly string[] | undefined;
  // The original button paths and every direct mode own the same board lease.
  const lease = ctx.lifecycle.begin(`${projectId}:${storyboardId}`);
  if (!lease) { ctx.notify('当前分镜已有图片批次正在生成，请等待任务完成。', 'normal'); return; }
  const sourceIdentity = planningSourceIdentity(initial, board);
  const sourceIsCurrent = () => {
    const current = ctx.getState();
    const currentBoard = current.project.storyboards.find((item) => item.id === storyboardId);
    return ctx.lifecycle.canBind(lease) && current.project.id === projectId && Boolean(currentBoard)
      && planningSourceIdentity(current, currentBoard!) === sourceIdentity;
  };
  const assertSourceCurrent = () => {
    if (!sourceIsCurrent()) throw new GenerationTaskCancelledError('项目、剧情或 H3 分镜已变化，本次未提交生图请求。');
  };
  const announce = (message: string, tone?: 'normal' | 'error') => {
    if (ctx.getState().project.id === projectId) ctx.notify(message, tone);
  };
  try {
    const settings = normalizeStoryboardImageToImageSettings(board.imageToImage, board.shots.map((shot) => shot.id));
    if (requested.count !== undefined) {
      if (requested.mode !== 'storyboard-shots') throw new Error('自定义图片数量仅用于分镜图片生成。');
      validateStoryboardImagePlanCount(requested.count);
    }
    const selection = resolveWorkbenchImageApi(initial.settings, 'ordinary');
    if (selection.issue) throw new Error(selection.issue);
    const api = cloneImageBatchConfig(selection.config);
    imageErrorContext = { ...projectContextSnapshot, provider: api.backend, model: api.model, endpoint: api.baseUrl };
    failureDetail = { stage: 'image-preparation', context: imageErrorContext };
    if (!api.enabled || !api.baseUrl.trim() || (api.backend === 'openai' && !api.model.trim())) {
      throw new Error('请先配置并启用可用的生图 API；默认分镜和首尾帧图生图不需要文本 API。');
    }
    assertDirectStoryboardImageApiSupport(api, settings.referenceAssetIds.length);
    let directPromptConversion: DirectStoryboardImagePromptConversion | undefined;
    let imagePromptTrace: Pick<ImageGenerationTask,
      | 'imagePromptRuleSetId'
      | 'imagePromptRuleSetName'
      | 'imagePromptRuleSetVersion'
      | 'imagePromptPresetId'
      | 'imagePromptPresetName'
      | 'imagePromptPresetVersion'
      | 'imagePromptFormat'
    > | undefined;
    let imagePromptConverterRules = '';
    let conversionIdentityContext = '';
    try {
      const imagePromptSelection = resolveImagePromptSelection({
        backend: imagePromptBackendForApi(api.backend),
        model: api.model,
        assetKind: 'storyboard',
        manualRuleSetId: initial.settings.imagePromptRuleSetIdByBackend?.[api.backend],
        manualPresetId: initial.settings.imagePromptPresetIdByAssetKind?.storyboard,
        state: initial.imagePromptRules,
      });
      if (isGptImage25MicroNsfwPromptSelection(imagePromptSelection)) {
        const sourceSceneIds = new Set([board.sceneId, ...(board.sourceSceneIds || [])]);
        const sourceScenes = [
          ...(board.sourceSceneSnapshots || []),
          ...initial.project.scenes.filter((scene) => sourceSceneIds.has(scene.id)),
        ];
        const sourceCharacterIds = new Set(sourceScenes.flatMap((scene) => scene.characterIds));
        const characterNames = initial.project.characters
          .filter((character) => !character.dossier?.archivedIntoCharacterId && sourceCharacterIds.has(character.id))
          .map((character) => character.name);
        // Give the existing converter immutable authored identity evidence,
        // with this board's own story before any broader project context.
        // This text never changes H3, direct visual sources or image prompts.
        conversionIdentityContext = buildImagePromptIdentityContext(initial.project, characterNames, board);
        imagePromptTrace = {
          imagePromptRuleSetId: imagePromptSelection.ruleSet.id,
          imagePromptRuleSetName: imagePromptSelection.ruleSet.name,
          imagePromptRuleSetVersion: imagePromptSelection.ruleSet.version,
          imagePromptPresetId: imagePromptSelection.preset.id,
          imagePromptPresetName: imagePromptSelection.preset.name,
          imagePromptPresetVersion: imagePromptSelection.preset.version,
          imagePromptFormat: imagePromptSelection.ruleSet.format,
        };
        directPromptConversion = {
          ruleSetId: imagePromptSelection.ruleSet.id,
          ruleSetVersion: imagePromptSelection.ruleSet.version,
          presetId: imagePromptSelection.preset.id,
          presetVersion: imagePromptSelection.preset.version,
          format: imagePromptSelection.ruleSet.format,
          mode: 'gpt-image-2-5-micro-nsfw',
          version: 3,
        };
        imagePromptConverterRules = buildImagePromptConverterSystemPrompt(
          imagePromptSelection,
          [
            directMicroNsfwReferenceRule,
            gptImage25MicroNsfwConverterExtraRule(imagePromptSelection, 'storyboard', 'storyboard-frame'),
          ].join('\n'),
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error || '未知错误');
      throw new Error(`分镜图生图规则解析失败：${detail}`);
    }
    if (requested.count !== undefined && (!textApi.enabled || !textApi.baseUrl.trim() || !textApi.model.trim())) {
      failureDetail = { stage: 'image-frame-plan', context: textErrorContext };
      throw new Error('自定义分镜图片数量需要已配置的文本 API 规划原剧情中的静帧；参考图仍直接提交生图接口，不会用于图片转文字。');
    }
    if (directPromptConversion && (!textApi.enabled || !textApi.baseUrl.trim() || !textApi.model.trim())) {
      failureDetail = { stage: 'image-prompt-convert', context: textErrorContext };
      throw new Error('GPT Image 2.5 微 NSFW 分镜图生图必须先由文本模型转换成最终微 NSFW 生图提示词；请先启用并配置文本 API，本次没有调用图像模型。');
    }
    const size = resolveStoryboardImageOutputSize(initial.settings.storyboardImageOutputSize || defaultStoryboardImageOutputSize(), board.aspectRatio, api.backend);
    if (size.issue) throw new Error(`分镜图片分辨率无效：${size.issue}`);
    const projectContext = {
      characters: cloneImageBatchConfig(initial.project.characters.filter((character) => !character.dossier?.archivedIntoCharacterId)), locations: cloneImageBatchConfig(initial.project.locations),
      props: cloneImageBatchConfig(initial.project.props), scenes: cloneImageBatchConfig(initial.project.scenes),
      // Top-level copies freeze image locators/immutable pixel strings without
      // JSON-duplicating the entire project's potentially large media library.
      assets: initial.project.assets.map((asset) => ({ ...asset, tags: [...asset.tags] })), projectName: initial.project.name,
      generationTaskNames: initial.project.generationTasks.flatMap((task) => 'name' in task ? [task.name] : []),
      currentImagePromptsByShotId: Object.fromEntries(initial.project.generationTasks
        .filter((task) => task.kind === 'image' && task.imageGenerationMode === 'image-to-image'
          && task.imageVariant === 'storyboard-frame' && !task.imageFrameDescription
          && task.sourceStoryboardId === storyboardId && task.sourceShotId && task.prompt.trim() && task.sourceFingerprint)
        .slice().reverse().flatMap((task) => task.kind === 'image' ? [[task.sourceShotId!, {
          prompt: task.prompt, sourceFingerprint: task.sourceFingerprint!,
        }]] : [])),
      ...(directPromptConversion ? { directPromptConversion, conversionIdentityContext } : {}),
    };
    announce(`正在固定本段 ${settings.referenceAssetIds.length} 张公共参考图，全部生成图片使用同一组原图。`);
    const apiSnapshot = await captureImageApiSnapshot(api, selection.profileId);
    const cache = new Map<string, Promise<string>>();
    const snapshots = new Map<string, ImageReferenceAssetSnapshot>();
    // Resolve and freeze all originals before queueing. A reference used by
    // many shots is stored once, not copied as base64 into every task record.
    failureDetail = { stage: 'image-reference-load', context: imageErrorContext };
    for (const id of settings.referenceAssetIds) {
      assertSourceCurrent();
      const asset = projectContext.assets.find((item) => item.id === id);
      const [dataUrl] = await resolveDirectStoryboardReferenceImages([id], projectContext.assets, ctx.loader, cache);
      if (!asset) throw new Error(`参考图已不存在：${id}`);
      let managed: ManagedMediaResult | undefined;
      if (asset.dataUrl || !asset.managed || !asset.relativePath || !/^[a-f0-9]{64}$/iu.test(asset.checksum || '')) {
        if (!ctx.storeImage) throw new Error(`当前环境无法保存参考图快照：${asset.name}，请在桌面版使用图生图。`);
        managed = await ctx.storeImage({ dataUrl, fileName: `${safeFileName(asset.name)}-图生图参考.png` });
      }
      snapshots.set(id, createImageReferenceAssetSnapshot(asset, managed));
    }
    assertSourceCurrent();
    let frames: StoryboardImageFramePlan[] | undefined;
    if (requested.count !== undefined) {
      failureDetail = { stage: 'image-frame-plan', context: textErrorContext };
      announce(`AI 正在按原剧情和 H3 规划 ${requested.count} 张静帧；参考图不参与文字规划，稍后直接用于图生图。`);
      frames = await (ctx.planFrames || requestStoryboardImageFramePlan)({
        storyboard: board, count: requested.count, isCurrent: sourceIsCurrent,
        onRepair: () => { if (sourceIsCurrent()) announce(`AI 正在修复 ${requested.count} 张静帧的返回结构，尚未提交生图。`); },
        request: (system, user) => {
          assertSourceCurrent();
          return (ctx.requestText || requestTextModel)(textApi, system, user, undefined, { disableThinking: true });
        },
      });
      assertSourceCurrent();
    }
    failureDetail = { stage: 'image-preparation', context: imageErrorContext };
    const rawRequests = buildDirectStoryboardImageBatchRequests(board, {
      mode: requested.mode, shotIds: requested.shotIds, referenceAssetIds: settings.referenceAssetIds, frames,
    }, projectContext, size);
    const assetById = new Map(projectContext.assets.map((asset) => [asset.id, asset]));
    if (directPromptConversion) {
      failureDetail = { stage: 'image-prompt-convert', context: textErrorContext };
      // Conversion can fail before tasks exist. Capture its request-owned
      // evidence here so that UI notices and diagnostics cannot echo it.
      conversionErrorSensitiveTexts = [
        conversionIdentityContext, imagePromptConverterRules,
        ...rawRequests.map((request) => request.conversionSource),
      ];
    }
    const requests = directPromptConversion
      ? await Promise.all(rawRequests.map(async (request) => {
          if (request.directPromptSource === 'current-image-prompt') return request;
          assertSourceCurrent();
          const converted = await (ctx.convertPrompt || requestImagePromptConverter)(
            textApi,
            'storyboard',
            request.conversionSource,
            imagePromptTrace!.imagePromptFormat!,
            imagePromptConverterRules,
            conversionIdentityContext,
          );
          assertSourceCurrent();
          const orderedAssets = request.referenceAssetIds.map((id) => {
            const asset = assetById.get(id);
            if (!asset) throw new Error(`参考图已不存在：${id}`);
            return asset;
          });
          return {
            ...request,
            directPrompt: buildDirectStoryboardImagePromptWithReferences(converted, orderedAssets),
          };
        }))
      : rawRequests;
    failureDetail = { stage: 'image-preparation', context: imageErrorContext };
    for (const request of requests) assertDirectStoryboardImageApiSupport(api, request.referenceAssetIds.length);
    assertSourceCurrent();
    const createdAt = Date.now();
    const batchId = createId('direct_image_batch');
    const tasks = requests.map((request, index) => createImageGenerationTask({
      id: createId('image_task'), name: request.name, assetKind: 'storyboard', imageVariant: request.imageVariant,
      imageFrameBatchId: request.purpose === 'storyboard-shot' ? batchId : undefined,
      imageFrameIndex: request.imageFrameIndex, imageFrameCount: request.imageFrameCount,
      imageFrameDescription: request.imageFrameDescription, imageFrameTimeSec: request.imageFrameTimeSec,
      imageGenerationMode: 'image-to-image', prompt: request.directPrompt, imagePromptFormat: 'natural-language',
      ...(imagePromptTrace || {}),
      conversionSource: request.conversionSource, width: request.width, height: request.height, sizeOverride: request.sizeOverride,
      ...(directPromptConversion ? { conversionIdentityContext } : {}),
      backend: api.backend, model: api.backend === 'comfyui'
        ? api.comfyuiWorkflows?.find((item) => item.id === api.activeComfyuiWorkflowId)?.name || 'ComfyUI Workflow'
        : api.model.trim(),
      imageApiSnapshot: apiSnapshot, sourceStoryboardId: board.id, sourceShotId: request.shotId,
      sourceFingerprint: directStoryboardImageSourceFingerprint(board, request, projectContext),
      referenceAssetIds: [...request.referenceAssetIds], primaryReferenceAssetIds: [...request.referenceAssetIds],
      referenceAssetSnapshots: request.referenceAssetIds.map((id) => snapshots.get(id)!),
      batchId, batchIndex: index + 1, batchCount: requests.length,
    }, createdAt + index, 'queued'));
    ctx.lifecycle.trackBatchSubmissions(lease, tasks.map((task) => task.id));
    let committed = false;
    ctx.update((state) => {
      const currentBoard = state.project.storyboards.find((item) => item.id === storyboardId);
      if (!ctx.lifecycle.canBind(lease) || state.project.id !== projectId || !currentBoard
        || planningSourceIdentity(state, currentBoard) !== sourceIdentity) return state;
      committed = true;
      return applyOwnedProjectUpdate(state, projectId, (project) => ({
        ...project, generationTasks: [...tasks, ...project.generationTasks],
      }));
    });
    if (!committed) throw new GenerationTaskCancelledError('项目、剧情或 H3 分镜已变化，本次未提交生图请求。');
    announce(`已加入 ${tasks.length} 个分镜图生图任务，可在“生成任务”取消排队、查看参考图及失败原因。`);
    failureDetail = { stage: 'image-generation', context: imageErrorContext };
    const results = await runStoryboardImageBatch(requests, async (request, index) => {
      const task = tasks[index];
      const assertActive = () => {
        if (!ctx.lifecycle.canSubmit(lease) || !imageBatchTaskIsActive(ctx.getState(), projectId, task)) throw new GenerationTaskCancelledError();
      };
      let taskFailureStage: DirectStoryboardImageErrorDetail['stage'] = 'image-reference-load';
      try {
        assertActive();
        ctx.updateBackground((state) => applyOwnedProjectUpdate(state, projectId, (project) => ({
          ...project, generationTasks: patchImageGenerationTask(project.generationTasks, task.id, { status: 'running', error: undefined }),
        })));
        const referenceImages = await resolveDirectStoryboardReferenceImages(task.referenceAssetIds!, imageReferenceSnapshotAssets(task.referenceAssetSnapshots), ctx.loader);
        assertActive();
        taskFailureStage = 'image-generation';
        const generated = await (ctx.generateImage || requestImageModel)(api, {
          prompt: task.prompt, width: task.width, height: task.height, sizeOverride: task.sizeOverride,
          referenceImages, primaryReferenceImageCount: referenceImages.length, preserveReferenceImageOrder: true,
        }, assertActive);
        taskFailureStage = 'image-result-save';
        const actual = readGeneratedImageDimensions(generated.dataUrl || '');
        const managed = generated.dataUrl && ctx.storeImage
          ? await ctx.storeImage({ dataUrl: generated.dataUrl, fileName: `${safeFileName(task.name)}.png` }) : undefined;
        const dataUrl = managed ? undefined : generated.dataUrl;
        const url = managed?.url || generated.url;
        if (!dataUrl && !url) throw new Error('图像接口没有返回可保存的图片。');
        const timestamp = Date.now();
        const asset: ReferenceAsset = withDirectImageRegenerationSnapshot({
          id: createId('asset'), name: task.name, type: request.assetType, role: request.assetRole, referenceRole: request.referenceRole,
          mediaType: 'image', source: 'generated', managed: Boolean(managed?.managed), missing: false,
          dataUrl, url, relativePath: managed?.relativePath, checksum: managed?.checksum, sizeBytes: managed?.sizeBytes,
          fileName: managed?.fileName, mimeType: generated.dataUrl?.match(/^data:([^;,]+)[;,]/iu)?.[1],
          sourceStoryboardId: board.id, sourceShotId: request.shotId, imageVariant: task.imageVariant,
          imageFrameBatchId: task.imageFrameBatchId, imageFrameIndex: task.imageFrameIndex,
          imageFrameCount: task.imageFrameCount, imageFrameDescription: task.imageFrameDescription, imageFrameTimeSec: task.imageFrameTimeSec,
          prompt: task.prompt, imageBackend: task.backend, imagePromptRuleSetId: task.imagePromptRuleSetId,
          imagePromptRuleSetName: task.imagePromptRuleSetName,
          imagePromptRuleSetVersion: task.imagePromptRuleSetVersion, imagePromptPresetId: task.imagePromptPresetId,
          imagePromptPresetName: task.imagePromptPresetName,
          imagePromptPresetVersion: task.imagePromptPresetVersion, imagePromptFormat: task.imagePromptFormat || 'natural-language',
          width: actual?.width, height: actual?.height,
          imageRequestSize: { width: task.width, height: task.height, sizeOverride: task.sizeOverride },
          tags: ['剧情分镜', `第${request.shotIndex}镜`, '图生图', ...(request.purpose === 'first-frame' ? ['首帧'] : request.purpose === 'last-frame' ? ['尾帧'] : [])], createdAt: timestamp, updatedAt: timestamp,
        }, task);
        ctx.updateBackground((state) => applyOwnedProjectUpdate(state, projectId, (project) => ({
          ...project, assets: [asset, ...project.assets],
          // Association lives on the output asset/task. Never change shot refs,
          // confirmed H3 fingerprints, first/last-frame or video slot bindings.
          generationTasks: settleImageGenerationTask(project.generationTasks, task, {
            status: 'succeeded', resultAssetId: asset.id, resultUrl: url, error: undefined,
            bindingWarning: imageReturnedSizeWarning(task, actual) || undefined,
          }, timestamp, projectId),
        })));
        return asset.id;
      } catch (error) {
        if (isGenerationTaskCancelledError(error) || isGenerationTaskRevoked(projectId, task)) throw new GenerationTaskCancelledError();
        const message = `第 ${request.shotIndex} 镜图生图失败：${error instanceof Error ? error.message : String(error)}`;
        ctx.reportError?.(error, { stage: taskFailureStage, context: imageErrorContext });
        ctx.updateBackground((state) => applyOwnedProjectUpdate(state, projectId, (project) => ({
          ...project, generationTasks: settleImageGenerationTask(project.generationTasks, task, { status: 'failed', error: message }, Date.now(), projectId),
        })));
        throw new Error(message);
      }
    }, (_request, index) => ctx.lifecycle.canSubmit(lease) && imageBatchTaskIsActive(ctx.getState(), projectId, tasks[index], true));
    const count = (status: 'succeeded' | 'failed' | 'cancelled') => results.filter((item) => item.status === status).length;
    announce(`分镜图生图完成：成功 ${count('succeeded')}，失败 ${count('failed')}，取消 ${count('cancelled')}。${count('failed') ? '具体原因已记录在生成任务中。' : ''}`, count('failed') ? 'error' : 'normal');
  } catch (error) {
    const cancelled = isGenerationTaskCancelledError(error) || error instanceof Error && error.name === 'AbortError';
    const conversionDiagnostic = failureDetail.stage === 'image-prompt-convert' && conversionErrorSensitiveTexts
      ? getSafeErrorDiagnostics(error, { sensitiveTexts: conversionErrorSensitiveTexts, knownSecrets: [textApi.apiKey] })
      : undefined;
    const message = conversionDiagnostic?.message || (error instanceof Error ? error.message : String(error));
    const prefix = !cancelled && failureDetail.stage === 'image-frame-plan'
      ? '分镜静帧规划未完成，尚未提交生图：'
      : !cancelled && failureDetail.stage === 'image-prompt-convert'
        ? '生图提示词转换未完成，尚未提交生图：' : '';
    announce(`${prefix}${message}`, cancelled ? 'normal' : 'error');
    // Converter diagnostics retain protocol status/code/stage/route without
    // request data. Other direct paths keep their existing error behavior;
    // provider failures never become JSON retries here.
    if (!cancelled) ctx.reportError?.(conversionDiagnostic || error, failureDetail);
  } finally {
    ctx.lifecycle.finish(lease);
  }
};

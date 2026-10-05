import {
  getImageVariantGenerationSpec,
  normalizeImageReferenceAssetSnapshots,
  imageWorkbenchEntityToForm,
  ordinaryImageVariantNegativePrompt,
  privateImageVariantNegativePrompt,
} from './imageGeneration';
import { normalizePrivateFullBodyOutputSize } from './imageOutputSize';
import { normalizeImageAssetRegenerationSnapshot, withDirectImageRegenerationSnapshot } from './imageAssetRegenerationSnapshot';
import { assertValidFinalImagePrompt } from './imagePromptRules';
import { buildImagePromptIdentityContext } from './imagePromptIdentityContext';
import { characterDossierFormForRequest, dossierUsesStory } from './characterDossierPolicy';
import { buildLandscapeImageSource, IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT, isLandscapeImageRequest } from './imageLocationScope';
import { buildImagePrompt } from './promptEngine';
import { assertUsableConvertedStoryboardImagePrompt, buildStoryboardImageRequestFromFrame, buildStoryboardImageRequests, selectStoryboardImageReferences } from './storyboardImages';
import { isGenerationTaskRevoked, settleImageGenerationTask } from './generationTasks';
import {
  isNsfwPrivateProfileAsset,
  nsfwPrivatePartForAsset,
} from './nsfwPrivateAssets';
import type { GenerationTask, ImageApiConfig, ImageGenerationTask, ImageReferenceAssetSnapshot, NsfwPrivatePart, Project, ReferenceAsset } from './types';

type RegenerationSource = {
  conversionSource: string;
  conversionIdentityContext?: string;
  converterSystemPrompt: string;
  referenceAssetIds: string[];
  primaryReferenceAssetIds: string[];
  referenceAssetSnapshots?: ImageReferenceAssetSnapshot[];
  warning?: string;
};

const active = (task: ImageGenerationTask): boolean => task.status === 'queued' || task.status === 'running';
const cleanIdList = (value: unknown): string[] => Array.isArray(value)
  ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)))
  : [];
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** Windows treats case, compatibility glyphs, forbidden filename characters and trailing dots/spaces alike. */
const collisionKey = (value: string): string => value.normalize('NFKC')
  .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_')
  .replace(/[. ]+$/gu, '')
  .trim()
  .toUpperCase();

const truncateUtf16 = (value: string, limit: number): string => {
  const truncated = value.slice(0, Math.max(0, limit));
  return /[\uD800-\uDBFF]$/u.test(truncated) ? truncated.slice(0, -1) : truncated;
};

const imageAssetHasPixels = (asset: ReferenceAsset | undefined): boolean => Boolean(
  asset && (asset.dataUrl || asset.url || asset.relativePath),
);

export const imageRegenerationRootId = (task: ImageGenerationTask): string => (
  task.regenerationRootTaskId?.trim() || task.id
);

export const canRegenerateImageTask = (
  task: ImageGenerationTask,
  tasks: readonly GenerationTask[],
): boolean => {
  if (active(task)) return false;
  const rootId = imageRegenerationRootId(task);
  return !tasks.some((candidate) => (
    candidate.kind === 'image'
    && active(candidate)
    && imageRegenerationRootId(candidate) === rootId
  ));
};

const inferAssetKind = (asset: ReferenceAsset): ImageGenerationTask['assetKind'] | null => {
  if (asset.sourceEntityKind) return asset.sourceEntityKind;
  if (asset.sourceStoryboardId || asset.type === 'first-frame' || asset.type === 'last-frame') return 'storyboard';
  if (asset.type === 'character' || asset.type === 'location' || asset.type === 'prop' || asset.type === 'grid') return asset.type;
  if (asset.imageVariant === 'storyboard-frame' || asset.imageVariant === 'first-frame' || asset.imageVariant === 'last-frame' || asset.role === 'composition') return 'storyboard';
  return asset.type === 'reference' ? 'storyboard' : null;
};

const fallbackVariant = (asset: ReferenceAsset, assetKind: ImageGenerationTask['assetKind']): ImageGenerationTask['imageVariant'] => (
  asset.imageVariant
  || (asset.type === 'first-frame' ? 'first-frame'
    : asset.type === 'last-frame' ? 'last-frame'
      : assetKind === 'character' ? 'reference'
        : assetKind === 'location' ? 'landscape'
          : assetKind === 'prop' ? 'showcase'
            : assetKind === 'grid' ? 'grid'
              : 'storyboard-frame')
);

const backendForAsset = (asset: ReferenceAsset, imageApi: ImageApiConfig): ImageApiConfig['backend'] => {
  // Prompt syntax is not transport provenance: ComfyUI can consume natural
  // language, SD tags or NAI tags. A saved physical backend wins; an older
  // ambiguous asset uses the user's current API instead of guessing from text.
  if (asset.imageBackend === 'openai' || asset.imageBackend === 'sd_webui'
    || asset.imageBackend === 'comfyui' || asset.imageBackend === 'novelai') return asset.imageBackend;
  return imageApi.backend;
};

const savedImageRequestSize = (asset: ReferenceAsset): ReferenceAsset['imageRequestSize'] => {
  const request: unknown = asset.imageRequestSize;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined;
  const values = request as Record<string, unknown>;
  if (![values.width, values.height].every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 64 && value <= 4096)
    || values.sizeOverride !== undefined && typeof values.sizeOverride !== 'boolean') return undefined;
  return {
    width: values.width as number,
    height: values.height as number,
    ...(typeof values.sizeOverride === 'boolean' ? { sizeOverride: values.sizeOverride } : {}),
  };
};

/** Locate the source task for an asset card or synthesize a stable legacy task without credentials/pixels. */
export const resolveImageAssetRegenerationTask = (
  asset: ReferenceAsset,
  project: Project,
  imageApi: ImageApiConfig,
): ImageGenerationTask | null => {
  if (asset.type === 'video' || asset.type === 'audio' || asset.type === 'clay-render'
    || asset.mediaType === 'video' || asset.mediaType === 'audio' || asset.mediaType === 'clay-render') return null;
  const existing = project.generationTasks.find((candidate): candidate is ImageGenerationTask => (
    candidate.kind === 'image' && candidate.resultAssetId === asset.id
  ));
  // An explicit direct result marker cannot be downgraded by an incomplete
  // imported/deleted-and-restored task record lacking its execution mode.
  if (existing && (asset.imageGenerationMode !== 'image-to-image' || existing.imageGenerationMode === 'image-to-image')) return existing;
  if (asset.imageGenerationMode === 'image-to-image') {
    const snapshot = normalizeImageAssetRegenerationSnapshot(asset.imageRegenerationSnapshot);
    const requestSize = savedImageRequestSize(asset);
    const customFrame = asset.imageFrameIndex !== undefined || asset.imageFrameCount !== undefined
      || asset.imageFrameDescription !== undefined || asset.imageFrameTimeSec !== undefined;
    const validFrame = !customFrame || Number.isInteger(asset.imageFrameIndex) && (asset.imageFrameIndex || 0) >= 1
      && Number.isInteger(asset.imageFrameCount) && (asset.imageFrameCount || 0) >= (asset.imageFrameIndex || 0)
      && (asset.imageFrameCount || 0) <= 100 && Boolean(asset.imageFrameDescription?.trim())
      && (asset.imageFrameTimeSec === undefined || Number.isFinite(asset.imageFrameTimeSec));
    if (!snapshot || !requestSize || !asset.prompt?.trim() || !asset.sourceStoryboardId || !asset.sourceShotId
      || !['storyboard-frame', 'first-frame', 'last-frame'].includes(asset.imageVariant || '') || !validFrame
      || asset.imageBackend !== snapshot.imageApiSnapshot.config.backend) {
      throw new Error('这张图生图结果的原始参考图、API、提示词、尺寸或静帧快照缺失/损坏，不能按原图重新生成；不会改用当前选图、文字转换或文生图。请从对应分镜创建新任务。');
    }
    const references = snapshot.referenceAssetSnapshots.map((reference) => reference.id);
    return {
      id: `asset-regeneration-${asset.id}`, kind: 'image', name: asset.name, assetKind: 'storyboard',
      imageGenerationMode: 'image-to-image', status: 'succeeded', imageVariant: asset.imageVariant!,
      prompt: asset.prompt, negativePrompt: asset.negativePrompt,
      ...requestSize, backend: snapshot.imageApiSnapshot.config.backend, model: snapshot.model,
      imageApiSnapshot: snapshot.imageApiSnapshot, imagePromptFormat: asset.imagePromptFormat || 'natural-language',
      imagePromptRuleSetId: asset.imagePromptRuleSetId, imagePromptRuleSetVersion: asset.imagePromptRuleSetVersion,
      imagePromptRuleSetName: asset.imagePromptRuleSetName,
      imagePromptPresetId: asset.imagePromptPresetId, imagePromptPresetVersion: asset.imagePromptPresetVersion,
      imagePromptPresetName: asset.imagePromptPresetName,
      sourceStoryboardId: asset.sourceStoryboardId, sourceShotId: asset.sourceShotId,
      sourceFingerprint: snapshot.sourceFingerprint, referenceAssetIds: [...references], primaryReferenceAssetIds: [...references],
      referenceAssetSnapshots: snapshot.referenceAssetSnapshots, conversionSource: '', converterSystemPrompt: '',
      regenerationRootTaskId: snapshot.regenerationRootTaskId, regenerationBaseName: snapshot.regenerationBaseName,
      imageFrameBatchId: asset.imageFrameBatchId, imageFrameIndex: asset.imageFrameIndex, imageFrameCount: asset.imageFrameCount,
      imageFrameDescription: asset.imageFrameDescription, imageFrameTimeSec: asset.imageFrameTimeSec,
      resultAssetId: asset.id, resultUrl: asset.url, createdAt: asset.createdAt, updatedAt: asset.updatedAt,
    };
  }
  const hasSavedPrompt = Boolean(asset.prompt?.trim());
  const recoverableStoryboard = asset.source === 'generated'
    && Boolean(asset.sourceStoryboardId && asset.sourceShotId)
    && project.storyboards.some((board) => (
      board.id === asset.sourceStoryboardId && board.shots.some((shot) => shot.id === asset.sourceShotId)
    ));
  if (!hasSavedPrompt && !recoverableStoryboard) return null;
  const assetKind = inferAssetKind(asset);
  if (!assetKind) return null;
  const imageVariant = fallbackVariant(asset, assetKind);
  const privateAsset = isNsfwPrivateProfileAsset(asset);
  const privatePart = privateAsset
    ? nsfwPrivatePartForAsset(asset)
    : undefined;
  const canvas = getImageVariantGenerationSpec(imageVariant).canvas;
  const requestSize = savedImageRequestSize(asset);
  const savedWidth = requestSize?.width ?? (typeof asset.width === 'number' && asset.width > 0 ? asset.width : canvas.width);
  const savedHeight = requestSize?.height ?? (typeof asset.height === 'number' && asset.height > 0 ? asset.height : canvas.height);
  const resolvedSize = privateAsset && imageVariant === 'private-full-body'
    ? normalizePrivateFullBodyOutputSize(savedWidth, savedHeight)
    : { width: savedWidth, height: savedHeight };
  const backend = backendForAsset(asset, imageApi);
  const model = imageApi.model.trim() || (backend === 'novelai' ? 'NovelAI' : backend === 'comfyui' ? 'ComfyUI Workflow' : '');
  return {
    id: `asset-regeneration-${asset.id}`,
    kind: 'image', name: asset.name, assetKind, imageVariant, status: 'succeeded',
    prompt: asset.prompt || '', negativePrompt: privateAsset
      ? privateImageVariantNegativePrompt(imageVariant)
      : isLandscapeImageRequest(assetKind, imageVariant)
        ? landscapeRegenerationNegativePrompt(asset.negativePrompt)
        : ordinaryImageVariantNegativePrompt(imageVariant) || asset.negativePrompt,
    width: resolvedSize.width,
    height: resolvedSize.height,
    ...(typeof requestSize?.sizeOverride === 'boolean' ? { sizeOverride: requestSize.sizeOverride } : {}),
    backend, model,
    sourceEntityId: asset.sourceEntityId, sourceStoryboardId: asset.sourceStoryboardId, sourceShotId: asset.sourceShotId,
    imageFrameBatchId: asset.imageFrameBatchId,
    imageFrameIndex: asset.imageFrameIndex, imageFrameCount: asset.imageFrameCount,
    imageFrameDescription: asset.imageFrameDescription, imageFrameTimeSec: asset.imageFrameTimeSec,
    referenceScope: privateAsset ? 'nsfw-private-profile' : asset.referenceScope,
    nsfwPrivatePart: privatePart,
    imagePromptRuleSetId: asset.imagePromptRuleSetId, imagePromptRuleSetVersion: asset.imagePromptRuleSetVersion,
    imagePromptRuleSetName: asset.imagePromptRuleSetName,
    imagePromptPresetId: asset.imagePromptPresetId, imagePromptPresetVersion: asset.imagePromptPresetVersion,
    imagePromptPresetName: asset.imagePromptPresetName,
    imagePromptFormat: asset.imagePromptFormat,
    resultAssetId: asset.id, resultUrl: asset.url,
    createdAt: asset.createdAt, updatedAt: asset.updatedAt,
  };
};

const storyboardPurpose = (task: ImageGenerationTask): 'first-frame' | 'last-frame' | 'storyboard-shot' => (
  task.imageVariant === 'first-frame' ? 'first-frame'
    : task.imageVariant === 'last-frame' ? 'last-frame'
      : 'storyboard-shot'
);

const snapshotSource = (task: ImageGenerationTask): RegenerationSource | null => {
  const sourceIsSaved = hasOwn(task, 'conversionSource');
  const referencesAreSaved = hasOwn(task, 'referenceAssetIds') || hasOwn(task, 'primaryReferenceAssetIds');
  if (!sourceIsSaved && !referencesAreSaved) return null;
  return {
    conversionSource: typeof task.conversionSource === 'string' ? task.conversionSource : '',
    ...(typeof task.conversionIdentityContext === 'string'
      ? { conversionIdentityContext: task.conversionIdentityContext } : {}),
    converterSystemPrompt: typeof task.converterSystemPrompt === 'string' ? task.converterSystemPrompt : '',
    referenceAssetIds: cleanIdList(task.referenceAssetIds),
    primaryReferenceAssetIds: cleanIdList(task.primaryReferenceAssetIds),
  };
};

const privatePartProfileValue = (
  profile: Project['characters'][number]['nsfwProfile'],
  part: NsfwPrivatePart,
): string => ({
  'full-body': profile?.fullBody,
  breasts: profile?.breasts,
  vulva: profile?.vulva,
  anus: profile?.anus,
  penis: profile?.penis,
  scrotum: profile?.scrotum,
}[part] || '').trim();

const privateTaskPart = (task: ImageGenerationTask): NsfwPrivatePart | undefined => task.nsfwPrivatePart
  || (task.imageVariant === 'private-full-body'
    || task.imageVariant === 'private-turnaround'
    || task.imageVariant === 'private-five-view'
    || task.imageVariant === 'private-four-in-one'
    ? 'full-body'
    : undefined);

const isNsfwPrivateImageTask = (task: ImageGenerationTask): boolean => (
  task.referenceScope === 'nsfw-private-profile'
  || task.imageVariant === 'private-full-body'
  || task.imageVariant === 'private-turnaround'
  || task.imageVariant === 'private-five-view'
  || task.imageVariant === 'private-four-in-one'
  || task.imageVariant === 'private-close-up'
  || Boolean(task.nsfwPrivatePart)
);

const directStoryboardReferenceSnapshots = (task: ImageGenerationTask): ImageReferenceAssetSnapshot[] => {
  const snapshots = normalizeImageReferenceAssetSnapshots(task.referenceAssetSnapshots);
  const selectedIds = cleanIdList([...(task.primaryReferenceAssetIds || []), ...(task.referenceAssetIds || [])]);
  if (!task.referenceAssetSnapshots?.length || snapshots.length !== task.referenceAssetSnapshots.length
    || !selectedIds.length || selectedIds.length !== snapshots.length
    || selectedIds.some((id) => !snapshots.some((snapshot) => snapshot.id === id))) {
    throw new Error('原图生图任务的参考图快照缺失或不完整，无法按原图重试；不会自动补图、改用当前图片或退回文生图。');
  }
  return snapshots;
};

export const imageTaskNeedsLandscapeScopeRepair = (task: ImageGenerationTask): boolean => (
  isLandscapeImageRequest(task.assetKind, task.imageVariant)
  && !(task.converterSystemPrompt || '').includes(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT)
);

const landscapeRegenerationNegativePrompt = (negativePrompt?: string): string => {
  const variantNegative = ordinaryImageVariantNegativePrompt('landscape');
  return negativePrompt?.includes(variantNegative)
    ? negativePrompt : [negativePrompt, variantNegative].filter(Boolean).join(', ');
};

const regenerationNegativePrompt = (task: ImageGenerationTask): string | undefined => {
  if (isNsfwPrivateImageTask(task)) return privateImageVariantNegativePrompt(task.imageVariant);
  const variantNegative = ordinaryImageVariantNegativePrompt(task.imageVariant);
  if (isLandscapeImageRequest(task.assetKind, task.imageVariant)) {
    return landscapeRegenerationNegativePrompt(task.negativePrompt);
  }
  return variantNegative || task.negativePrompt;
};

export const resolveImageRegenerationSource = (
  task: ImageGenerationTask,
  project: Project,
): RegenerationSource => {
  const privateTask = isNsfwPrivateImageTask(task);
  const privatePart = privateTaskPart(task);
  if (task.imageGenerationMode === 'image-to-image' && task.assetKind === 'storyboard' && !privateTask) {
    if (!task.prompt.trim()) throw new Error('原图生图任务没有保存镜头画面描述，不能调用文本 API 猜测或改写原任务；请从对应分镜重新创建任务。');
    const snapshots = directStoryboardReferenceSnapshots(task);
    return {
      conversionSource: '', converterSystemPrompt: '',
      referenceAssetIds: cleanIdList(task.referenceAssetIds),
      primaryReferenceAssetIds: cleanIdList(task.primaryReferenceAssetIds),
      referenceAssetSnapshots: snapshots,
    };
  }
  const saved = snapshotSource(task);
  if (!privateTask && isLandscapeImageRequest(task.assetKind, task.imageVariant)) {
    const needsRepair = imageTaskNeedsLandscapeScopeRepair(task);
    const location = project.locations.find((item) => item.id === task.sourceEntityId);
    // Prefer the original frozen evidence, even if the live location was edited.
    // Legacy final prompts are evidence to extract from, never direct image input.
    const originalSource = saved?.conversionSource.trim() || task.prompt.trim();
    const conversionSource = originalSource
      ? needsRepair ? buildLandscapeImageSource({ name: task.name, description: originalSource }) : saved?.conversionSource || originalSource
      : location ? buildImagePrompt('location', imageWorkbenchEntityToForm('location', location), 'landscape') : '';
    if (!conversionSource) throw new Error('无法恢复风景场景资料，请在图像工作台补全地点后重新生成。');
    return {
      conversionSource,
      conversionIdentityContext: '',
      converterSystemPrompt: needsRepair ? '' : task.converterSystemPrompt || '',
      referenceAssetIds: cleanIdList(task.referenceAssetIds),
      primaryReferenceAssetIds: cleanIdList(task.primaryReferenceAssetIds),
      ...(task.referenceAssetSnapshots ? { referenceAssetSnapshots: normalizeImageReferenceAssetSnapshots(task.referenceAssetSnapshots) } : {}),
      ...(needsRepair ? { warning: '旧风景场景将重新提取无人环境提示词；原任务、原图和地点资料保留。' } : {}),
    };
  }
  if (saved && !hasOwn(saved, 'conversionIdentityContext') && (!task.prompt.trim() || privateTask)) {
    const character = task.assetKind === 'character'
      ? project.characters.find((item) => item.id === task.sourceEntityId) : undefined;
    saved.conversionIdentityContext = character && !dossierUsesStory(character.dossier) ? '' : buildImagePromptIdentityContext(project,
      character ? [imageWorkbenchEntityToForm('character', character).name] : [],
      task.assetKind === 'storyboard' ? project.storyboards.find((board) => board.id === task.sourceStoryboardId) : undefined);
  }
  if (saved && !privateTask) {
    // Old storyboard tasks froze every historical image linked to a character.
    // Compact only their inferred references, within that same frozen pool;
    // never pull in newer project images or discard an explicit selection.
    if (task.assetKind === 'storyboard' && hasOwn(task, 'primaryReferenceAssetIds')) {
      const references = selectStoryboardImageReferences(saved.referenceAssetIds, saved.primaryReferenceAssetIds, project);
      const originalCount = new Set([...saved.primaryReferenceAssetIds, ...saved.referenceAssetIds]).size;
      if (references.length < originalCount) return {
        ...saved,
        referenceAssetIds: references,
        warning: `已收敛同一实体的历史自动参考图：${originalCount} 张 → ${references.length} 张；手选图、原提示词与原任务保持不变。`,
      };
    }
    return saved;
  }
  if (privateTask && task.assetKind !== 'character') {
    throw new Error('私密图片任务必须绑定角色，不能按分镜、场景、道具或九宫格任务恢复。');
  }
  if (task.assetKind === 'storyboard') {
    const storyboard = project.storyboards.find((item) => item.id === task.sourceStoryboardId);
    if (storyboard) {
      const purpose = storyboardPurpose(task);
      const context = {
        projectName: project.name, characters: project.characters, locations: project.locations,
        props: project.props, scenes: project.scenes, assets: project.assets,
        generationTaskNames: project.generationTasks.flatMap((item) => item.kind === 'image' || item.kind === 'autofill' ? [item.name] : []),
      };
      const hasCustomFrame = task.imageFrameIndex !== undefined || task.imageFrameCount !== undefined
        || task.imageFrameDescription !== undefined || task.imageFrameTimeSec !== undefined;
      if (purpose === 'storyboard-shot' && hasCustomFrame) {
        try {
          const request = buildStoryboardImageRequestFromFrame(storyboard, task.sourceShotId || '', task, context);
          return {
            conversionSource: request.conversionSource, converterSystemPrompt: '',
            conversionIdentityContext: buildImagePromptIdentityContext(project, [], storyboard),
            referenceAssetIds: [...request.referenceAssetIds], primaryReferenceAssetIds: [...request.primaryReferenceAssetIds],
          };
        } catch (error) {
          if (!task.prompt.trim()) throw error;
          return {
            conversionSource: '', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [],
            warning: '自定义静帧的来源镜头或规划记录不完整，已使用该张已保存的最终提示词重新生成。',
          };
        }
      }
      const requests = buildStoryboardImageRequests(storyboard,
        purpose === 'storyboard-shot' ? 'storyboard-shots' : 'boundary-frames', context);
      const request = requests.find((item) => item.shotId === task.sourceShotId && item.purpose === purpose);
      if (request) return {
        conversionSource: request.conversionSource,
        conversionIdentityContext: buildImagePromptIdentityContext(project, [], storyboard),
        converterSystemPrompt: '',
        referenceAssetIds: [...request.referenceAssetIds],
        primaryReferenceAssetIds: [...request.primaryReferenceAssetIds],
      };
      if (task.prompt.trim()) return {
        conversionSource: '', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [],
        warning: '未能恢复原分镜镜头，已使用已保存的最终提示词重新生成。',
      };
      throw new Error('无法找到该分镜图片对应的镜头，且没有已保存的最终提示词可用于重新生成。');
    }
    if (task.prompt.trim()) return {
      conversionSource: '', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [],
      warning: '原分镜已不存在，已使用已保存的最终提示词重新生成。',
    };
    throw new Error('原分镜已不存在，且该任务没有可恢复的最终提示词。');
  }
  const entity = task.assetKind === 'character'
    ? project.characters.find((item) => item.id === task.sourceEntityId)
    : task.assetKind === 'location'
      ? project.locations.find((item) => item.id === task.sourceEntityId)
      : task.assetKind === 'prop'
        ? project.props.find((item) => item.id === task.sourceEntityId)
        : undefined;
  if (privateTask) {
    if (task.assetKind !== 'character' || !entity || !('nsfwProfile' in entity)) {
      throw new Error('旧私密图片任务没有绑定可核验的角色，不能按普通人物提示词恢复；请在图像工作台重新创建。');
    }
    if (!privatePart) {
      throw new Error('旧私密特写任务缺少具体部位元数据，不能猜测恢复；请在图像工作台重新选择部位。');
    }
    if (!privatePartProfileValue(entity.nsfwProfile, privatePart)) {
      throw new Error('该角色当前没有对应部位的私密外貌资料，请先在图像工作台补全。');
    }
    if (saved) return saved;
    return {
      conversionSource: buildImagePrompt(
        'character',
        imageWorkbenchEntityToForm('character', entity),
        task.imageVariant,
        privatePart,
      ),
      conversionIdentityContext: !dossierUsesStory(entity.dossier) ? '' : buildImagePromptIdentityContext(project, [imageWorkbenchEntityToForm('character', entity).name]),
      converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [],
      warning: task.prompt.trim()
        ? '旧私密任务未保存生成快照，已按当前私密资料和当前规则重新转换且不附加普通人物参考图。'
        : '旧私密任务未保存生成快照，已按当前私密资料恢复且不附加普通人物参考图。',
    };
  }
  if (entity && task.assetKind !== 'grid') {
    const form = imageWorkbenchEntityToForm(task.assetKind, entity);
    const dossier = task.assetKind === 'character' ? (entity as Project['characters'][number]).dossier : undefined;
    return {
    conversionSource: buildImagePrompt(task.assetKind, task.assetKind === 'character' ? characterDossierFormForRequest(form, dossier) : form, task.imageVariant),
    conversionIdentityContext: !dossierUsesStory(dossier) ? '' : buildImagePromptIdentityContext(project,
      task.assetKind === 'character' ? [imageWorkbenchEntityToForm('character', entity).name] : []),
    converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [],
    warning: '旧任务未保存参考图快照，已按当前资料恢复且不附加参考图。',
  };
  }
  if (task.prompt.trim()) return {
    conversionSource: '', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [],
    warning: '原资料已不存在，已使用已保存的最终提示词重新生成。',
  };
  throw new Error('无法恢复原始生图资料，且该任务没有已保存的最终提示词；请先恢复资料或重新创建图像任务。');
};

const sourceBaseName = (source: ImageGenerationTask, project: Project): string => {
  const rootId = imageRegenerationRootId(source);
  const root = project.generationTasks.find((item): item is ImageGenerationTask => item.kind === 'image' && item.id === rootId);
  if (root?.regenerationBaseName?.trim()) return root.regenerationBaseName.trim();
  if (source.regenerationBaseName?.trim()) return source.regenerationBaseName.trim();
  const result = project.assets.find((asset) => asset.id === (root || source).resultAssetId);
  return result && imageAssetHasPixels(result) ? result.name : (root || source).name;
};

const nextName = (base: string, project: Project): string => {
  const reserved = new Set<string>();
  project.assets.forEach((asset) => {
    reserved.add(collisionKey(asset.name));
    if (asset.fileName) reserved.add(collisionKey(asset.fileName.replace(/\.[^.]+$/u, '')));
  });
  project.generationTasks.forEach((task) => {
    if (task.kind === 'image' || task.kind === 'autofill') reserved.add(collisionKey(task.name));
  });
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${truncateUtf16(base, 140 - suffix.length)}${suffix}`;
    if (!reserved.has(collisionKey(candidate))) return candidate;
  }
};

export const buildImageRegenerationTask = (
  source: ImageGenerationTask,
  project: Project,
  input: {
    id: string;
    timestamp: number;
    backend: ImageApiConfig['backend'];
    model: string;
    source: ReturnType<typeof resolveImageRegenerationSource>;
  },
): ImageGenerationTask => {
  if (!input.id.trim()) throw new Error('重新生成任务必须有唯一 ID。');
  if (input.backend !== source.backend) {
    throw new Error(`原图任务使用 ${source.backend} 后端，当前为 ${input.backend}；请切换到原后端后重新生成，不会自动更换后端或模型。`);
  }
  if (project.generationTasks.some((task) => task.id === input.id)) throw new Error('重新生成任务 ID 已存在，无法覆盖已有任务。');
  if (!canRegenerateImageTask(source, project.generationTasks)) throw new Error('该图像任务或其重新生成队列正在处理，请等待完成后再试。');
  const rootId = imageRegenerationRootId(source);
  const baseName = sourceBaseName(source, project);
  const requestSize = source.imageVariant === 'private-full-body'
    ? normalizePrivateFullBodyOutputSize(source.width, source.height)
    : { width: source.width, height: source.height };
  return {
    ...source,
    id: input.id,
    name: nextName(baseName, project),
    status: 'queued', backend: input.backend,
    model: source.imageGenerationMode === 'image-to-image' ? source.model : input.model,
    ...(source.imageApiSnapshot ? { imageApiSnapshot: { ...source.imageApiSnapshot, config: { ...source.imageApiSnapshot.config } } } : {}),
    prompt: imageTaskNeedsLandscapeScopeRepair(source) ? '' : source.prompt,
    negativePrompt: regenerationNegativePrompt(source),
    width: requestSize.width,
    height: requestSize.height,
    regenerationSourceTaskId: source.id,
    regenerationRootTaskId: rootId,
    regenerationBaseName: baseName,
    conversionSource: input.source.conversionSource,
    ...(typeof input.source.conversionIdentityContext === 'string'
      ? { conversionIdentityContext: input.source.conversionIdentityContext } : {}),
    converterSystemPrompt: input.source.converterSystemPrompt,
    referenceAssetIds: [...input.source.referenceAssetIds],
    primaryReferenceAssetIds: [...input.source.primaryReferenceAssetIds],
    ...(input.source.referenceAssetSnapshots
      ? { referenceAssetSnapshots: input.source.referenceAssetSnapshots.map((snapshot) => ({ ...snapshot })) } : {}),
    batchId: undefined, resultAssetId: undefined, resultUrl: undefined, error: undefined, bindingWarning: input.source.warning,
    createdAt: input.timestamp, updatedAt: input.timestamp,
  };
};

export const executeImageRegeneration = async <T>(
  task: ImageGenerationTask,
  options: {
    referenceImages: string[]; primaryReferenceImageCount: number;
    convertPrompt: () => Promise<string>;
    persistPrompt: (prompt: string) => void | Promise<void>;
    generateImage: (input: { prompt: string; negativePrompt?: string; width: number; height: number; sizeOverride?: boolean; referenceImages: string[]; primaryReferenceImageCount: number }) => Promise<T>;
  },
): Promise<{ finalPrompt: string; generated: T }> => {
  const hasSavedPrompt = Boolean(task.prompt.trim()) && !imageTaskNeedsLandscapeScopeRepair(task);
  if (task.imageGenerationMode === 'image-to-image' && task.assetKind === 'storyboard' && !isNsfwPrivateImageTask(task)) {
    if (!hasSavedPrompt) throw new Error('图生图任务缺少已保存的镜头画面描述，不能自动改用文本转换或文生图。');
    const snapshots = directStoryboardReferenceSnapshots(task);
    // Explicit slots retain their order even when two selected files contain
    // identical pixels. Direct-mode transport must not silently merge slots.
    const expectedImages = snapshots.length;
    if (options.referenceImages.length !== expectedImages || options.referenceImages.some((image) => !image.trim())) {
      throw new Error(`图生图参考图读取不完整：需要 ${expectedImages} 张原图，实际读取 ${options.referenceImages.length} 张；未提交生图请求。`);
    }
  }
  const negativePrompt = regenerationNegativePrompt(task);
  if (hasSavedPrompt) {
    const generated = await options.generateImage({
      prompt: task.prompt, negativePrompt, width: task.width, height: task.height,
      ...(typeof task.sizeOverride === 'boolean' ? { sizeOverride: task.sizeOverride } : {}),
      referenceImages: [...options.referenceImages], primaryReferenceImageCount: options.primaryReferenceImageCount,
    });
    return { finalPrompt: task.prompt, generated };
  }
  const convertedPrompt = await options.convertPrompt();
  if (!convertedPrompt.trim()) throw new Error('图像提示词转换失败：文本模型返回了空内容。');
  const validated = task.assetKind === 'storyboard'
    ? assertUsableConvertedStoryboardImagePrompt(convertedPrompt, task.conversionSource || '', task.imagePromptFormat || 'natural-language')
    : assertValidFinalImagePrompt(convertedPrompt, task.imagePromptFormat || 'natural-language', task.conversionSource || '已保存提示词');
  await options.persistPrompt(validated);
  const generated = await options.generateImage({
    prompt: validated, negativePrompt, width: task.width, height: task.height,
    ...(typeof task.sizeOverride === 'boolean' ? { sizeOverride: task.sizeOverride } : {}),
    referenceImages: [...options.referenceImages], primaryReferenceImageCount: options.primaryReferenceImageCount,
  });
  return { finalPrompt: validated, generated };
};

export const appendRegeneratedImageResult = (
  project: Project,
  task: ImageGenerationTask,
  asset: ReferenceAsset,
): Project => {
  const currentTask = project.generationTasks.find((item) => item.id === task.id && item.kind === 'image');
  if (isGenerationTaskRevoked(project.id, task) || currentTask?.status === 'cancelled'
    || (currentTask && currentTask.createdAt !== task.createdAt)) return project;
  if (project.assets.some((item) => item.id === asset.id)) throw new Error('图像素材 ID 已存在，无法覆盖原图。');
  const durableAsset = withDirectImageRegenerationSnapshot(asset, task);
  return {
    ...project,
    assets: [durableAsset, ...project.assets],
    generationTasks: settleImageGenerationTask(project.generationTasks, task, {
      status: 'succeeded', resultAssetId: asset.id, resultUrl: asset.url || task.resultUrl,
      error: undefined, bindingWarning: '重新生成图片已保存，未替换原始绑定。',
    }, asset.updatedAt, project.id),
    updatedAt: Math.max(project.updatedAt, asset.updatedAt),
  };
};

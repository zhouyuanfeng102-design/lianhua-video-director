import type {
  AssetRole,
  AssetType,
  Character,
  ImageGenerationTask,
  ImageVariant,
  Location,
  Prop,
  ReferenceAsset,
  ReferenceRole,
  Scene,
  StoryAnalysisCharacter,
  Storyboard,
  StoryboardImageFrameMetadata,
  VideoShot,
} from './types';
import { enqueueImageTask } from './imageTaskQueue';
import { isGenerationTaskCancelledError } from './generationTaskCancellation';
import { assertValidFinalImagePrompt } from './imagePromptRules';
import type { ImagePromptFormat } from './imagePromptRules';
import {
  appendLegacyMorphologyDescription,
  getImageMorphologyNegativePrompt,
  imageWorkbenchEntityToForm,
  normalizeCharacterMorphologyForPersistence,
  resolveExplicitImageCharacterMorphology,
} from './imageGeneration';
import { publicVideoContinuityLock } from './videoPrivateScope';
import { readStoryboardImageH3Source } from './storyboardImageH3Source';
export { readStoryboardImageH3Source } from './storyboardImageH3Source';
import { STORYBOARD_SPATIAL_FRAME_RULE } from './spatialContinuityRules';
import { DEFAULT_FIRST_PERSON_SUBJECT } from './semanticEvents';
import { buildStoryboardImageBaseName, createStoryboardImageNameAllocator } from './storyboardImageNames';
import type { StoryboardImageFramePlan } from './storyboardImagePlan';
import type { ResolvedImageOutputSize } from './imageOutputSize';
import {
  hasExplicitClothingStateChange,
  resolveNsfwShotContinuityBoundaries,
} from './continuity';
import {
  characterNsfwProfileText,
  filterNsfwPrivateProfileAssetsForShot,
  isNsfwPrivateProfileAsset,
  nsfwPrivatePartForAsset,
  nsfwPrivateProfilePartsForCharacter,
  nsfwPrivateReferenceResponsibility,
} from './nsfwPrivateAssets';
import {
  getMorphologyPromptLocks,
} from './characterMorphology';

export type StoryboardImageBatchMode = 'boundary-frames' | 'storyboard-shots';
export type StoryboardImagePurpose = 'first-frame' | 'last-frame' | 'storyboard-shot';

export interface StoryboardImageRequest extends StoryboardImageFrameMetadata {
  purpose: StoryboardImagePurpose;
  name: string;
  storyboardId: string;
  shotId: string;
  shotIndex: number;
  assetKind: ImageGenerationTask['assetKind'];
  assetType: AssetType;
  assetRole: AssetRole;
  referenceRole: ReferenceRole;
  imageVariant: ImageVariant;
  /** Ordered real image assets available to lock this shot's identity/space. */
  referenceAssetIds: string[];
  /** User-checked global or per-shot references that must take priority over inferred supplemental assets. */
  primaryReferenceAssetIds: string[];
  /** Rules and project facts for the text converter; never send directly to an image model. */
  conversionSource: string;
  width: number;
  height: number;
  /** Explicit per-batch pixel selection; absent on legacy requests. */
  sizeOverride?: boolean;
}

/** Apply only image-output parameters, never the video storyboard or its H3.
 * The last specification line is the builder's own metadata, after all source
 * story text. Replacing it keeps explicit pixel choices out of user prose. */
export const applyStoryboardImageOutputSize = <T extends StoryboardImageRequest>(
  request: T,
  size: ResolvedImageOutputSize,
): T => {
  if (size.issue) throw new Error(`分镜图片分辨率无效：${size.issue}`);
  let conversionSource = request.conversionSource;
  if (size.sizeOverride) {
    const specification = `画面规格：${size.width}×${size.height} 像素，宽高比 ${size.width}:${size.height}，单幅画面；本次图片像素独立于视频输出分辨率。`;
    const lines = conversionSource.split('\n');
    let specIndex = lines.length - 1;
    while (specIndex >= 0 && !lines[specIndex].startsWith('画面规格：')) specIndex -= 1;
    if (specIndex >= 0) lines[specIndex] = specification;
    else lines.push(specification);
    conversionSource = lines.join('\n');
  }
  return { ...request, width: size.width, height: size.height, sizeOverride: size.sizeOverride, conversionSource };
};

/** Immutable converter identity attached before a storyboard image enters the queue. */
export interface StoryboardImagePromptTrace {
  imagePromptRuleSetId: NonNullable<ImageGenerationTask['imagePromptRuleSetId']>;
  imagePromptRuleSetName?: ImageGenerationTask['imagePromptRuleSetName'];
  imagePromptRuleSetVersion: NonNullable<ImageGenerationTask['imagePromptRuleSetVersion']>;
  imagePromptPresetId: NonNullable<ImageGenerationTask['imagePromptPresetId']>;
  imagePromptPresetName?: ImageGenerationTask['imagePromptPresetName'];
  imagePromptPresetVersion: NonNullable<ImageGenerationTask['imagePromptPresetVersion']>;
  imagePromptFormat: NonNullable<ImageGenerationTask['imagePromptFormat']>;
}

/** A queueable image request must identify the exact converter rule and preset. */
export type StoryboardImageGenerationRequest = StoryboardImageRequest & StoryboardImagePromptTrace;

export interface StoryboardImageBuildContext {
  /** Project name used as the stable prefix for generated image task names. */
  projectName?: string;
  characters: readonly Character[];
  locations: readonly Location[];
  props: readonly Prop[];
  scenes: readonly Scene[];
  assets: readonly ReferenceAsset[];
  /** Reserve queued/running names too, before their result assets exist. */
  generationTaskNames?: readonly string[];
  /** Batch-level text-AI decision of who is physically visible in each shot.
   * An empty array is authoritative for a pure environment/object shot. */
  visibleCharacterNamesByShotId?: Readonly<Record<string, readonly string[]>>;
}

export interface StoryboardImageBatchLease {
  key: string;
  bindingEpoch: number;
}

export interface StoryboardImageBatchLifecycle {
  begin: (key: string) => StoryboardImageBatchLease | null;
  finish: (lease: StoryboardImageBatchLease) => void;
  invalidateBindings: () => void;
  trackSubmission: (lease: StoryboardImageBatchLease, taskId: string) => void;
  trackBatchSubmissions: (lease: StoryboardImageBatchLease, taskIds: readonly string[]) => void;
  releaseCancelledQueuedBatches: (isTaskActive: (taskId: string) => boolean) => void;
  revokeMissingSubmissions: (isTaskActive: (taskId: string) => boolean) => void;
  isActive: (key: string) => boolean;
  canBind: (lease: StoryboardImageBatchLease) => boolean;
  canSubmit: (lease: StoryboardImageBatchLease) => boolean;
}

/** Own duplicate-start guards and binding invalidation above any one view mount. */
export const createStoryboardImageBatchLifecycle = (): StoryboardImageBatchLifecycle => {
  let bindingEpoch = 0;
  const activeBatches = new Map<string, StoryboardImageBatchLease>();
  const submissionTasks = new Map<StoryboardImageBatchLease, string>();
  const batchSubmissionTasks = new Map<StoryboardImageBatchLease, readonly string[]>();
  const revokedSubmissions = new WeakSet<StoryboardImageBatchLease>();
  return {
    begin: (key) => {
      if (activeBatches.has(key)) return null;
      const lease = { key, bindingEpoch };
      activeBatches.set(key, lease);
      return lease;
    },
    finish: (lease) => {
      if (activeBatches.get(lease.key) === lease) activeBatches.delete(lease.key);
      submissionTasks.delete(lease);
      batchSubmissionTasks.delete(lease);
    },
    invalidateBindings: () => {
      bindingEpoch += 1;
    },
    trackSubmission: (lease, taskId) => {
      if (activeBatches.get(lease.key) !== lease) return;
      submissionTasks.set(lease, taskId);
      batchSubmissionTasks.set(lease, [taskId]);
    },
    trackBatchSubmissions: (lease, taskIds) => {
      if (activeBatches.get(lease.key) === lease && taskIds.length) {
        batchSubmissionTasks.set(lease, [...new Set(taskIds)]);
      }
    },
    // Explicit queue cancellation can release a batch while its inert FIFO
    // callbacks still wait behind unrelated work. Do not release untracked
    // planning, any active worker, or a replacement lease for the same board.
    releaseCancelledQueuedBatches: (isTaskActive) => {
      batchSubmissionTasks.forEach((taskIds, lease) => {
        if (taskIds.some(isTaskActive)) return;
        if (activeBatches.get(lease.key) === lease) activeBatches.delete(lease.key);
        revokedSubmissions.add(lease);
        submissionTasks.delete(lease);
        batchSubmissionTasks.delete(lease);
      });
    },
    // A later redo cannot reauthorize the old worker. Unrelated history edits
    // leave still-present queued tasks authorized.
    revokeMissingSubmissions: (isTaskActive) => {
      submissionTasks.forEach((taskId, lease) => {
        if (!isTaskActive(taskId)) revokedSubmissions.add(lease);
      });
    },
    isActive: (key) => activeBatches.has(key),
    canBind: (lease) => (
      activeBatches.get(lease.key) === lease
      && lease.bindingEpoch === bindingEpoch
    ),
    canSubmit: (lease) => (
      activeBatches.get(lease.key) === lease
      && !revokedSubmissions.has(lease)
    ),
  };
};

export interface StoryboardImageBindingDecisionInput {
  lifecycleCurrent: boolean;
  taskTracked: boolean;
  storyboardPresent: boolean;
  sourceUnchanged: boolean;
}

export interface StoryboardImageBindingDecision {
  shouldBind: boolean;
  warning?: string;
}

/** Explain why a completed image may be saved but must not mutate a stale board. */
export const resolveStoryboardImageBinding = (
  input: StoryboardImageBindingDecisionInput,
): StoryboardImageBindingDecision => {
  if (!input.storyboardPresent) {
    return {
      shouldBind: false,
      warning: '原分镜已不存在，图片已保存到资产库但未自动绑定。',
    };
  }
  if (!input.lifecycleCurrent) {
    return {
      shouldBind: false,
      warning: '生成期间项目状态已撤销、重做或恢复，图片已保存到资产库但未自动绑定。',
    };
  }
  if (!input.taskTracked) {
    return {
      shouldBind: false,
      warning: '原图片任务已不存在或被移除，图片已保存到资产库但未自动绑定。',
    };
  }
  if (!input.sourceUnchanged) {
    return {
      shouldBind: false,
      warning: '生成期间分镜内容已变化，图片已保存到资产库但未自动绑定。',
    };
  }
  return { shouldBind: true };
};

/** A whole-storyboard image run has a durable binding batch id. Its first
 * successful image replaces the older automatic storyboard-frame selection;
 * later successes retain other slots in this same run. History pixels are
 * never deleted. Legacy/per-shot requests without that id keep slot semantics. */
export const samePurposeGeneratedStoryboardAssetIds = (
  assets: readonly ReferenceAsset[],
  storyboardId: string,
  request: Pick<StoryboardImageRequest, 'shotId' | 'imageVariant' | 'imageFrameIndex' | 'imageFrameCount' | 'imageFrameBatchId'>,
): string[] => assets
  .filter((asset) => {
    if (asset.source !== 'generated' || asset.sourceStoryboardId !== storyboardId
      || asset.imageVariant !== request.imageVariant) return false;
    if (request.imageFrameBatchId && request.imageVariant === 'storyboard-frame') {
      if (asset.imageFrameBatchId !== request.imageFrameBatchId) return true;
      // Custom slots are segment-wide, not keyed by sourceShotId or total.
      // A reselected moment may legitimately move to another original shot.
      return request.imageFrameIndex !== undefined
        ? asset.imageFrameIndex === request.imageFrameIndex
        : asset.imageFrameIndex === undefined && asset.sourceShotId === request.shotId;
    }
    return asset.sourceShotId === request.shotId
      && asset.imageFrameIndex === request.imageFrameIndex
      && asset.imageFrameCount === request.imageFrameCount;
  })
  .map((asset) => asset.id);

const cleanText = (value: unknown): string => String(value || '').replace(/\s+/gu, ' ').trim();

/** Retain all authored identity facts. Add template locks only for an explicit
 * concrete morphology; prose and unknown/auto shapes are interpreted by AI. */
const characterMorphologyPromptLines = (character: Character): string[] => {
  const item = character as Character & {
    morphology?: string;
    bodyPlan?: string;
  };
  const resolved = resolveExplicitImageCharacterMorphology(item);
  const locks = resolved ? getMorphologyPromptLocks(resolved) : undefined;
  return [
    line('物种形态', resolved?.summary || item.morphology),
    line('身体结构', item.bodyPlan || resolved?.bodyPlan),
    line('物种结构正向锁', locks?.positiveText),
    line('物种结构防漂移', locks?.negativeText),
  ].filter(Boolean);
};

const clippedStory = (value: unknown, maxChars = 6000): string => {
  const story = cleanText(value);
  if (story.length <= maxChars) return story;
  return `${story.slice(0, maxChars - 1)}…`;
};

const canvasForAspectRatio = (aspectRatio: string): { width: number; height: number } => {
  const match = cleanText(aspectRatio).match(/(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)/u);
  const ratio = match ? Number(match[1]) / Number(match[2]) : 16 / 9;
  if (ratio < 0.9) return { width: 1024, height: 1536 };
  if (ratio <= 1.1) return { width: 1024, height: 1024 };
  return { width: 1536, height: 1024 };
};

const line = (label: string, value: unknown): string => {
  const text = cleanText(value);
  return text ? `${label}：${text}` : '';
};

interface FinalPromptShotSegment {
  startSec: number;
  endSec: number;
  text: string;
}

const finalPromptShotSegments = (value: unknown): FinalPromptShotSegment[] => {
  const prompt = String(value || '').trim();
  const matches = Array.from(
    prompt.matchAll(/【\s*(\d+(?:\.\d+)?)s\s*[-–—~～至]\s*(\d+(?:\.\d+)?)s\s*】/gu),
  );
  return matches.map((match, index) => ({
    startSec: Number(match[1]),
    endSec: Number(match[2]),
    text: cleanText(prompt.slice(match.index, matches[index + 1]?.index ?? prompt.length)),
  }));
};

const authoritativeShotDescription = (storyboard: Storyboard, shot: VideoShot): string => {
  const shotOffset = storyboard.shots.findIndex((item) => item.id === shot.id);
  const officialShot = readStoryboardImageH3Source(storyboard)?.shots[shotOffset];
  if (officialShot) return officialShot;
  const segments = finalPromptShotSegments(storyboard.finalPrompt);
  const matchingTimes = segments.find((segment) => (
    Math.abs(segment.startSec - shot.startSec) <= 0.02
    && Math.abs(segment.endSec - shot.endSec) <= 0.02
  ));
  if (matchingTimes?.text) return matchingTimes.text;
  if (segments.length === storyboard.shots.length && shotOffset >= 0) {
    return segments[shotOffset]?.text || shot.prompt;
  }
  return shot.prompt;
};

export const buildStoryboardVisibleCharacterAnalysisShots = (
  storyboard: Storyboard,
): Array<{
  id: string;
  index: number;
  subject: string;
  action: string;
  result: string;
  description: string;
}> => {
  const subjectDefinitions = readStoryboardImageH3Source(storyboard)?.subjectDefinitions;
  return storyboard.shots.map((shot) => ({
    id: shot.id,
    index: shot.index,
    subject: shot.subject,
    action: shot.action,
    result: shot.result,
    description: [
      authoritativeShotDescription(storyboard, shot),
      line('最终 H3 主体标签对应（仅供姓名解析，不表示这些人全部入画）', subjectDefinitions),
    ].filter(Boolean).join('\n'),
  }));
};

const storyboardHasDynamicClothing = (storyboard: Storyboard): boolean => hasExplicitClothingStateChange([
  storyboard.sourceStoryContent,
  ...(storyboard.sourceSceneSnapshots || []).map((scene) => scene.content),
  ...storyboard.shots.flatMap((shot) => [shot.purpose, shot.action, shot.result, shot.prompt]),
].filter(Boolean).join('\n'));

const imageSafeGlobalLock = (storyboard: Storyboard): string => {
  const lock = cleanText(publicVideoContinuityLock(storyboard.globalLock));
  if (!lock || !storyboardHasDynamicClothing(storyboard)) return lock;
  return lock
    .replace(/默认衣橱\/身份服装基底\s*[：:]/gu, '衣橱基底（不是本镜着装指令）：')
    .replace(/[，,；;]{2,}/gu, '，')
    .trim();
};

const firstFrameActionCue = (shot: VideoShot): string => {
  const action = cleanText(shot.action);
  if (!action) return '保持动作真正发生前的入镜准备姿态';
  const transitionIndex = action.search(/(?:脱下|脱掉|脱去|褪下|解下|扯下|剥下|穿上|穿回|套上|披上|全裸|赤裸|一丝不挂|插入|进入(?:阴道|后穴|身体)|抽插|抽送|射精|高潮|抽离|退出(?:阴道|后穴|身体))/u);
  if (transitionIndex < 0) return action;
  const preparation = action.slice(0, transitionIndex).replace(/[，,；;\s]+$/gu, '').trim();
  return preparation
    ? `${preparation}，动作停在状态改变前的准备瞬间`
    : '保持动作真正发生前的入镜准备姿态，尚未改变衣物、裸露、接触或残留状态';
};

const sharedPromptLines = (
  storyboard: Storyboard,
  purpose?: StoryboardImagePurpose,
): string[] => [
  '生成单张电影剧情静帧。严格依据当前剧情和当前镜头，不改写剧情，不随机添加人物、动作、道具、地点或事件。',
  '剧情原文与全局锁用于理解世界观、人物身份、场景陈设和道具的前后状态；曾经出现、购买或持有的物件不是每张图都必须出现。按本张选定瞬间的持有、交接、放下、使用或消耗结果决定可见道具，不能把后续动作提前画进首帧。',
  line('剧情标题', storyboard.sourceStoryTitle || '当前视频剧情'),
  // A first frame is an entry boundary. Supplying the whole removal/contact
  // chain here lets an image model jump straight to the shot's final state.
  line('剧情原文', purpose === 'first-frame'
    ? ''
    : clippedStory(storyboard.sourceStoryContent || storyboard.sourceSceneSnapshots?.map((scene) => scene.content).join('\n'))),
  line('全局人物、场景与道具连续性锁', imageSafeGlobalLock(storyboard)),
  line('承接上一段的可见状态', storyboard.continuityIn),
  line('交给下一段的可见状态', purpose === 'first-frame' ? '' : storyboard.continuityOut),
  line('视觉风格', storyboard.visualStyle),
  `画面规格：${cleanText(storyboard.aspectRatio) || '16:9'}，${cleanText(storyboard.resolution) || '高清'}，单幅画面。`,
].filter(Boolean);

const shotPromptLines = (shot: VideoShot, total: number): string[] => [
  `镜头位置：第 ${shot.index} 镜，共 ${total} 镜。`,
  line('本镜剧情目的', shot.purpose),
  line('画面主体与站位', shot.subject),
  line('结构化镜头空间关系（H3未明确处的补充依据）', shot.space),
  line('结构化镜头人物朝向与运动方向（H3未明确处的补充依据）', shot.direction),
  line('人物动作', shot.action),
  line('镜头景别、机位与运动', shot.camera),
  line('光线与环境气氛', shot.lighting),
].filter(Boolean);

const uniqueIds = (values: readonly (string | undefined)[]): string[] => Array.from(
  new Set(values.map((value) => cleanText(value)).filter(Boolean)),
);

export interface StoryboardReferenceImageLoader {
  readManagedImageDataUrl?: (payload: {
    relativePath: string;
    expectedChecksum?: string;
  }) => Promise<string | { dataUrl: string }>;
  downloadImage?: (
    remote: string | { url: string; headers?: Record<string, string> },
  ) => Promise<string>;
}

const supportedReferenceDataUrl = (value: unknown): string => {
  const dataUrl = String(value || '').trim();
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/\s]+={0,2}$/iu.test(dataUrl)
    ? dataUrl
    : '';
};

/** Pixel/media validation shared by the ordinary picker and the explicitly
 * scoped private-shot route. It deliberately does not decide disclosure. */
export const hasUsableStoryboardReferencePixels = (
  asset: ReferenceAsset | undefined,
): asset is ReferenceAsset => Boolean(
  asset
  && !asset.missing
  && (asset.mediaType == null || asset.mediaType === 'image')
  && asset.type !== 'video'
  && asset.type !== 'audio'
  && asset.type !== 'clay-render'
  && (
    supportedReferenceDataUrl(asset.dataUrl)
    || asset.relativePath?.trim()
    || asset.url?.startsWith('lianhua-asset://')
    || /^https?:\/\//iu.test(asset.url || '')
  ),
);

/** Ordinary pickers and generic character locks must never expose a private
 * profile image. The per-shot path below opts in only after all NSFW gates. */
export const isUsableStoryboardReferenceAsset = (
  asset: ReferenceAsset | undefined,
): asset is ReferenceAsset => Boolean(
  hasUsableStoryboardReferencePixels(asset)
  && !isNsfwPrivateProfileAsset(asset)
);

/** Choose current entity references from an already-scoped pool, never the
 * whole asset library. Explicit selections survive unchanged. Automatic
 * history contributes one current image per entity (and per private part),
 * rather than every portrait/variant ever generated for that entity. */
export const selectStoryboardImageReferences = (
  referenceAssetIds: readonly string[],
  primaryReferenceAssetIds: readonly string[],
  context: Pick<StoryboardImageBuildContext, 'assets' | 'characters' | 'locations' | 'props'>,
): string[] => {
  const primaryIds = uniqueIds(primaryReferenceAssetIds);
  const primaryIdSet = new Set(primaryIds);
  const candidateIds = uniqueIds([...primaryIds, ...referenceAssetIds]);
  const assetsById = new Map(context.assets.map((asset) => [asset.id, asset]));
  type Owner = { key: string; assetIds: readonly string[] };
  const ownersByKey = new Map<string, Owner>();
  const boundOwnersByAssetId = new Map<string, Owner[]>();
  const ownerKey = (kind: string, id: string): string => JSON.stringify([kind, id]);
  for (const [kind, entities] of [
    ['character', context.characters],
    ['location', context.locations],
    ['prop', context.props],
  ] as const) {
    for (const entity of entities) {
      const owner = { key: ownerKey(kind, entity.id), assetIds: uniqueIds(entity.assetIds || []) };
      ownersByKey.set(owner.key, owner);
      for (const id of owner.assetIds) {
        const owners = boundOwnersByAssetId.get(id) || [];
        owners.push(owner);
        boundOwnersByAssetId.set(id, owners);
      }
    }
  }
  const groupFor = (asset: ReferenceAsset | undefined): { key: string; owner: Owner } | undefined => {
    if (!asset) return undefined;
    const directKey = asset.sourceEntityKind && asset.sourceEntityId
      ? ownerKey(asset.sourceEntityKind, asset.sourceEntityId)
      : undefined;
    const boundOwners = boundOwnersByAssetId.get(asset.id) || [];
    // Provenance is authoritative. An unowned/shared composition is not a
    // character just because its name happens to contain a character's name.
    const owner = directKey
      ? ownersByKey.get(directKey) || { key: directKey, assetIds: [] }
      : boundOwners.length === 1 ? boundOwners[0] : undefined;
    if (!owner) return undefined;
    const privatePart = nsfwPrivatePartForAsset(asset);
    const category = !isNsfwPrivateProfileAsset(asset)
      ? 'ordinary'
      : asset.imageVariant === 'private-four-in-one'
        ? 'private-four-in-one'
        : privatePart ? `private-${privatePart}` : undefined;
    // Do not guess the part of a legacy private image, or merge a dedicated
    // part reference into the ordinary identity/full-body reference group.
    return category ? { key: JSON.stringify([owner.key, category]), owner } : undefined;
  };
  const coveredGroups = new Set(primaryIds.flatMap((id) => {
    const group = groupFor(assetsById.get(id));
    return group ? [group.key] : [];
  }));
  const groups = new Map<string, { owner: Owner; ids: string[] }>();
  const orderedAutomaticSlots: Array<{ id: string } | { groupKey: string }> = [];
  for (const id of candidateIds) {
    if (primaryIdSet.has(id)) continue;
    const group = groupFor(assetsById.get(id));
    if (!group) {
      orderedAutomaticSlots.push({ id });
      continue;
    }
    if (coveredGroups.has(group.key)) continue;
    const existing = groups.get(group.key);
    if (existing) existing.ids.push(id);
    else {
      groups.set(group.key, { owner: group.owner, ids: [id] });
      orderedAutomaticSlots.push({ groupKey: group.key });
    }
  }
  const selectedByGroup = new Map(Array.from(groups, ([key, group]) => {
    const usableIds = group.ids.filter((id) => hasUsableStoryboardReferencePixels(assetsById.get(id)));
    const usableIdSet = new Set(usableIds);
    // Entity bindings are newest-first in the workbench. Keep that preference
    // when it exists, but never pull a newer image outside this request's pool.
    const bound = group.owner.assetIds.find((id) => usableIdSet.has(id));
    const newest = usableIds.reduce<string | undefined>((current, id) => {
      const createdAt = assetsById.get(id)?.createdAt || 0;
      return !current || createdAt > (assetsById.get(current)?.createdAt || 0) ? id : current;
    }, undefined);
    // A wholly missing frozen group must still fail in the existing loader,
    // not silently turn an image-conditioned retry into text-to-image.
    return [key, bound || newest || group.ids[0]];
  }));
  return uniqueIds([
    ...primaryIds,
    ...orderedAutomaticSlots.map((slot) => 'id' in slot ? slot.id : selectedByGroup.get(slot.groupKey)),
  ]);
};

const managedRelativePathFromAsset = (asset: ReferenceAsset): string => {
  if (asset.relativePath?.trim()) return asset.relativePath.trim();
  if (!asset.url?.startsWith('lianhua-asset://')) return '';
  try {
    return new URL(asset.url).pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)
      .join('/');
  } catch {
    return '';
  }
};

/** Resolve ordered asset IDs to real pixels without writing base64 back into project state. */
export const resolveStoryboardReferenceImages = async (
  referenceAssetIds: readonly string[],
  assets: readonly ReferenceAsset[],
  loader: StoryboardReferenceImageLoader,
  cache = new Map<string, Promise<string>>(),
): Promise<string[]> => {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const resolved = await Promise.all(uniqueIds(referenceAssetIds).map(async (id) => {
    const asset = assetsById.get(id);
    if (!asset || asset.missing) throw new Error(`参考图不存在或已丢失：${asset?.name || id}`);
    const cacheKey = cleanText(asset.checksum)
      || managedRelativePathFromAsset(asset)
      || cleanText(asset.url)
      || id;
    const existing = cache.get(cacheKey);
    if (existing) return existing;
    const pending = (async (): Promise<string> => {
      const inline = supportedReferenceDataUrl(asset.dataUrl);
      if (inline) return inline;
      const relativePath = managedRelativePathFromAsset(asset);
      if (relativePath) {
        if (!loader.readManagedImageDataUrl) {
          throw new Error(`当前环境无法读取托管参考图：${asset.name}`);
        }
        const loaded = await loader.readManagedImageDataUrl({
          relativePath,
          expectedChecksum: asset.checksum,
        });
        const dataUrl = supportedReferenceDataUrl(
          typeof loaded === 'string' ? loaded : loaded?.dataUrl,
        );
        if (!dataUrl) throw new Error(`托管参考图数据无效：${asset.name}`);
        return dataUrl;
      }
      if (asset.url && /^https?:\/\//iu.test(asset.url)) {
        if (!loader.downloadImage) throw new Error(`当前环境无法下载参考图：${asset.name}`);
        const dataUrl = supportedReferenceDataUrl(await loader.downloadImage(asset.url));
        if (!dataUrl) throw new Error(`远程参考图数据无效：${asset.name}`);
        return dataUrl;
      }
      throw new Error(`参考图没有可读取的图片内容：${asset.name}`);
    })();
    cache.set(cacheKey, pending);
    try {
      return await pending;
    } catch (error) {
      cache.delete(cacheKey);
      throw error;
    }
  }));
  return Array.from(new Set(resolved));
};

const entityNameAppears = (name: string, source: string): boolean => {
  const normalizedName = cleanText(name);
  return normalizedName.length > 0 && source.includes(normalizedName);
};

const STORYBOARD_IMAGE_REQUIRED_CHARACTER_FIELDS = [
  'gender',
  'race',
  'appearance',
  'outfit',
  'anchor',
] as const satisfies readonly (keyof Character)[];

const STORYBOARD_IMAGE_REQUIRED_NONHUMAN_FIELDS = [
  'morphology',
  'bodyPlan',
] as const satisfies readonly (keyof Character)[];

const STORYBOARD_IMAGE_CHARACTER_DETAIL_FIELDS = [
  'gender',
  'apparentAge',
  'actualAge',
  'height',
  'bodyPlan',
  // Apply bodyPlan before morphology so a legacy descriptive morphology can
  // be preserved alongside (rather than accidentally masking) an incoming
  // concrete body-plan detail.
  'morphology',
  'race',
  'appearance',
  'outfit',
  'signatureProps',
  'personality',
  'motionHabits',
  'anchor',
  'negativeContinuity',
] as const satisfies readonly (keyof Character & keyof StoryAnalysisCharacter)[];

const usableIdentityDetail = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

/** Only explicitly selected non-human identities need the
 * additional structure locks before storyboard image generation.  Ordinary
 * human characters keep the historical required-field contract so an absent
 * morphology field never blocks their batch. */
const characterNeedsNonHumanStructureFields = (character: Character): boolean => {
  const resolved = resolveExplicitImageCharacterMorphology(character);
  return resolved?.family === 'nonhuman' || resolved?.family === 'anthropomorphic';
};

const normalizedCharacterName = (value: unknown): string => {
  const name = cleanText(value).replace(/^@/u, '');
  return name === '我' ? DEFAULT_FIRST_PERSON_SUBJECT : name;
};

const currentShotCharacterEvidence = (
  storyboard: Storyboard,
  shot: VideoShot,
): string => cleanText([
  shot.subject,
  shot.action,
  shot.result,
  authoritativeShotDescription(storyboard, shot),
].filter(Boolean).join('\n'));

const structuredVisibleSpace = (storyboard: Storyboard, shot: VideoShot): string | null => {
  const description = authoritativeShotDescription(storyboard, shot);
  const match = description.match(
    /(?:^|[；;\n])\s*空间\s*[：:]\s*([\s\S]*?)(?=(?:[；;\n]\s*(?:光影|镜头|台词|音效|风格|画面|负面)\s*[：:])|$)/u,
  );
  return match ? cleanText(match[1]) : null;
};

const taggedSubjectCharacterNames = (storyboard: Storyboard, shot: VideoShot): string[] => {
  const authoritativeDescription = authoritativeShotDescription(storyboard, shot);
  const structuredSubject = authoritativeDescription.match(
    /(?:^|[；;\n】])\s*主体\s*[：:]\s*([\s\S]*?)(?=(?:[；;\n]\s*(?:空间|光影|镜头|台词|音效|风格|画面|负面)\s*[：:])|$)/u,
  )?.[1] || '';
  const exactTaggedName = (value: string): string => normalizedCharacterName(
    value.match(/^@([A-Za-z0-9_·\u3400-\u9FFF]{1,32})$/u)?.[1],
  );
  const names = [exactTaggedName(cleanText(shot.subject)), exactTaggedName(cleanText(structuredSubject))]
    .filter(Boolean);
  Array.from(structuredSubject.matchAll(
    /@([A-Za-z0-9_·\u3400-\u9FFF]{1,32}?)(?=\s*(?:正在|[（(\[【]))/gu,
  )).forEach((match) => names.push(normalizedCharacterName(match[1])));
  return Array.from(new Set(names));
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** A tagged name can occur in source prose only to explain that the person is
 * outside the frame. Keep that relationship fact out of the visible identity
 * block instead of accidentally drawing an extra person. */
const characterIsExplicitlyNotVisible = (source: string, name: string): boolean => {
  const escapedName = escapeRegExp(name);
  const taggedName = `@?${escapedName}`;
  return [
    new RegExp(`(?:画外|镜头外|镜外|场外|画面外|未入镜|未出镜|不在画面(?:中)?)(?:的)?\\s*${taggedName}`, 'u'),
    new RegExp(`${taggedName}.{0,16}(?:没有|并未|未|不曾|不)(?:实际)?(?:出镜|入镜|出现在画面(?:中)?)`, 'u'),
    new RegExp(`${taggedName}.{0,12}(?:只|仅).{0,12}(?:在画外|在镜外|被提及|被谈及|被讨论)`, 'u'),
  ].some((pattern) => pattern.test(source));
};

const characterAppearsInCurrentShot = (
  storyboard: Storyboard,
  shot: VideoShot,
  name: string,
): boolean => {
  const normalizedName = normalizedCharacterName(name);
  if (!normalizedName) return false;
  const subject = cleanText(shot.subject);
  const evidence = currentShotCharacterEvidence(storyboard, shot);
  if (entityNameAppears(normalizedName, subject)) return true;
  const visibleSpace = structuredVisibleSpace(storyboard, shot);
  if (visibleSpace != null) {
    return visibleSpace.includes(`@${normalizedName}`);
  }
  return evidence.includes(`@${normalizedName}`)
    && !characterIsExplicitlyNotVisible(evidence, normalizedName);
};

const visibleCharactersForShot = (
  storyboard: Storyboard,
  shot: VideoShot,
  context: StoryboardImageBuildContext,
): Character[] => {
  const aiResolvedNames = context.visibleCharacterNamesByShotId?.[shot.id];
  if (aiResolvedNames) {
    const visibleNames = new Set(aiResolvedNames.map(normalizedCharacterName).filter(Boolean));
    return context.characters.filter((character) => visibleNames.has(normalizedCharacterName(character.name)));
  }
  return context.characters.filter((character) => (
    characterAppearsInCurrentShot(storyboard, shot, character.name)
  ));
};

/** Resolve structure negatives for exactly the characters visible in one
 * storyboard shot.  Keeping this at request level avoids applying a monster's
 * negative tags to unrelated human-only shots in the same project. */
export const getStoryboardMorphologyNegativePrompt = (
  storyboard: Storyboard,
  request: Pick<StoryboardImageRequest, 'shotId'>,
  context: StoryboardImageBuildContext,
  format: ImagePromptFormat = 'natural-language',
): string => {
  const shot = storyboard.shots.find((item) => item.id === request.shotId);
  if (!shot) return '';
  const visibleCharacters = visibleCharactersForShot(storyboard, shot, context);
  // A shot may legitimately contain both a human and a non-human character.
  // Human-face suppression is a whole-image negative prompt, so applying the
  // non-human clause in that case would also suppress the human cast.  The
  // per-character identity lines already carry the non-human structure locks;
  // leave the global negative empty whenever any visible character is
  // human-like or not explicitly classified. Unknown/auto character records
  // must not inherit another character's global face/anatomy suppression.
  // Homogeneous explicitly non-human shots retain the stronger guard.
  if (visibleCharacters.length === 0 || visibleCharacters.some((character) => {
    const resolved = resolveExplicitImageCharacterMorphology(character);
    return !resolved || resolved.family === 'human-like';
  })) {
    return '';
  }
  const negatives = visibleCharacters
    .map((character) => getImageMorphologyNegativePrompt(
      imageWorkbenchEntityToForm('character', character),
      format,
    ))
    .flatMap((value) => value.split(/[,，；;]+/u).map((item) => item.trim()))
    .filter(Boolean);
  return Array.from(new Set(negatives)).join(format === 'natural-language' ? '；' : ', ');
};

export interface StoryboardImageIdentityEnrichmentTarget {
  name: string;
  characterId?: string;
  shotIds: string[];
  reason: 'incomplete-character' | 'missing-character';
  missingFields: string[];
}

export interface StoryboardImageIdentityEnrichmentPlan {
  needsAiEnrichment: boolean;
  targets: StoryboardImageIdentityEnrichmentTarget[];
}

/** Identify only characters that really appear in a shot and lack reusable
 * identity facts. This is intentionally separate from prompt conversion so
 * one AI-authored identity is persisted and reused across the whole batch. */
export const planStoryboardImageIdentityEnrichment = (
  storyboard: Storyboard,
  context: StoryboardImageBuildContext,
): StoryboardImageIdentityEnrichmentPlan => {
  const charactersByName = new Map(
    context.characters.map((character) => [normalizedCharacterName(character.name), character]),
  );
  const orderedNames: string[] = [];
  const shotIdsByName = new Map<string, string[]>();
  const addVisible = (rawName: string, shotId: string) => {
    const name = normalizedCharacterName(rawName);
    if (!name) return;
    if (!shotIdsByName.has(name)) {
      orderedNames.push(name);
      shotIdsByName.set(name, []);
    }
    const shotIds = shotIdsByName.get(name)!;
    if (!shotIds.includes(shotId)) shotIds.push(shotId);
  };

  storyboard.shots.forEach((shot) => {
    const aiResolvedNames = context.visibleCharacterNamesByShotId?.[shot.id];
    if (aiResolvedNames) {
      aiResolvedNames.forEach((name) => addVisible(name, shot.id));
      return;
    }
    taggedSubjectCharacterNames(storyboard, shot).forEach((name) => addVisible(name, shot.id));
    context.characters.forEach((character) => {
      if (characterAppearsInCurrentShot(storyboard, shot, character.name)) {
        addVisible(character.name, shot.id);
      }
    });
    if (characterAppearsInCurrentShot(storyboard, shot, DEFAULT_FIRST_PERSON_SUBJECT)) {
      addVisible(DEFAULT_FIRST_PERSON_SUBJECT, shot.id);
    }
  });

  const targets = orderedNames.flatMap((name): StoryboardImageIdentityEnrichmentTarget[] => {
    const character = charactersByName.get(name);
    const requiredFields: readonly (keyof Character)[] = character && characterNeedsNonHumanStructureFields(character)
      ? [...STORYBOARD_IMAGE_REQUIRED_CHARACTER_FIELDS, ...STORYBOARD_IMAGE_REQUIRED_NONHUMAN_FIELDS]
      : STORYBOARD_IMAGE_REQUIRED_CHARACTER_FIELDS;
    const missingFields = requiredFields.filter(
      (field) => !usableIdentityDetail(character?.[field]),
    );
    if (character && missingFields.length === 0) return [];
    return [{
      name,
      ...(character ? { characterId: character.id } : {}),
      shotIds: [...(shotIdsByName.get(name) || [])],
      reason: character ? 'incomplete-character' : 'missing-character',
      missingFields: [...missingFields],
    }];
  });
  return {
    needsAiEnrichment: targets.length > 0,
    targets,
  };
};

/** Merge one batch-level AI identity design without overwriting any usable
 * user fact or accepting extra characters the request did not name. */
export const mergeStoryboardImageIdentityEnrichment = (
  current: readonly Character[],
  details: readonly StoryAnalysisCharacter[],
  targets: readonly StoryboardImageIdentityEnrichmentTarget[],
  createCharacterId: (name: string) => string,
): Character[] => {
  const targetNames = new Set(targets.map((target) => normalizedCharacterName(target.name)));
  const detailsByName = new Map<string, StoryAnalysisCharacter>();
  details.forEach((detail) => {
    const name = normalizedCharacterName(detail.name);
    if (name && targetNames.has(name)) detailsByName.set(name, detail);
  });
  const merged: Character[] = current.map((character) => ({
    ...character,
    assetIds: [...character.assetIds],
    nsfwProfile: character.nsfwProfile ? { ...character.nsfwProfile } : undefined,
  }));
  const existingByName = new Map(
    merged.map((character) => [normalizedCharacterName(character.name), character]),
  );

  targets.forEach((target) => {
    const name = normalizedCharacterName(target.name);
    const detail = detailsByName.get(name);
    if (!name || !detail) return;
    let character = existingByName.get(name);
    if (!character) {
      character = {
        id: createCharacterId(name),
        name,
        gender: '',
        apparentAge: '',
        actualAge: '',
        height: '',
        morphology: undefined,
        bodyPlan: '',
        race: '',
        appearance: '',
        outfit: '',
        signatureProps: '',
        personality: '',
        motionHabits: '',
        anchor: '',
        negativeContinuity: '',
        assetIds: [],
      };
      merged.push(character);
      existingByName.set(name, character);
    }
    const targetCharacter = character;
    STORYBOARD_IMAGE_CHARACTER_DETAIL_FIELDS.forEach((field) => {
      const incoming = usableIdentityDetail(detail[field]);
      if (!incoming) return;
      if (field === 'morphology') {
        // Never replace a usable user-authored morphology.  For an empty
        // target, normalize both canonical and legacy/free-form labels; the
        // latter's exact wording is retained in bodyPlan for downstream
        // prompts and future saves.
        if (usableIdentityDetail(targetCharacter.morphology)) {
          // A legacy/non-human target may already have a manually selected
          // canonical kind but no body-plan text.  Preserve that selection,
          // yet retain a descriptive incoming label as the missing structure
          // fact so the conditional required-field check can still complete.
          if (!usableIdentityDetail(targetCharacter.bodyPlan)) {
            const targetMorphology = resolveExplicitImageCharacterMorphology(targetCharacter);
            if (targetMorphology && targetMorphology.family !== 'human-like') {
              const normalizedIncoming = normalizeCharacterMorphologyForPersistence(incoming, {
                bodyPlan: targetCharacter.bodyPlan,
                race: targetCharacter.race || detail.race,
                appearance: targetCharacter.appearance || detail.appearance,
                anchor: targetCharacter.anchor || detail.anchor,
                motion: targetCharacter.motionHabits || detail.motionHabits,
              });
              if (normalizedIncoming.legacyDescription) {
                targetCharacter.bodyPlan = normalizedIncoming.legacyDescription;
              }
            }
          }
          return;
        }
        const normalized = normalizeCharacterMorphologyForPersistence(incoming, {
          bodyPlan: targetCharacter.bodyPlan,
          race: usableIdentityDetail(targetCharacter.race) || usableIdentityDetail(detail.race),
          appearance: usableIdentityDetail(targetCharacter.appearance) || usableIdentityDetail(detail.appearance),
          anchor: usableIdentityDetail(targetCharacter.anchor) || usableIdentityDetail(detail.anchor),
          motion: usableIdentityDetail(targetCharacter.motionHabits) || usableIdentityDetail(detail.motionHabits),
        });
        if (!normalized.morphology) return;
        targetCharacter.morphology = normalized.morphology;
        if (normalized.legacyDescription) {
          targetCharacter.bodyPlan = appendLegacyMorphologyDescription(
            usableIdentityDetail(targetCharacter.bodyPlan),
            normalized.legacyDescription,
          );
        }
        return;
      }
      if (usableIdentityDetail(targetCharacter[field])) return;
      (targetCharacter as Character & Record<string, unknown>)[field] = incoming;
    });
    if (detail.nsfwProfile) {
      targetCharacter.nsfwProfile = {
        ...detail.nsfwProfile,
        ...(targetCharacter.nsfwProfile || {}),
        provenance: targetCharacter.nsfwProfile?.provenance || detail.nsfwProfile.provenance,
        sourceHash: targetCharacter.nsfwProfile?.sourceHash || detail.nsfwProfile.sourceHash,
      };
    }
  });
  return merged;
};

export interface PrepareStoryboardImageIdentityContextInput {
  storyboard: Storyboard;
  context: StoryboardImageBuildContext;
  requestVisibleCharacters?: () => Promise<{
    visibleCharacterNamesByShotId: Readonly<Record<string, readonly string[]>>;
  }>;
  requestIdentityDetails: (
    names: readonly string[],
  ) => Promise<readonly StoryAnalysisCharacter[]>;
  createCharacterId: (name: string) => string;
}

export interface PreparedStoryboardImageIdentityContext {
  context: StoryboardImageBuildContext;
  plan: StoryboardImageIdentityEnrichmentPlan;
  enriched: boolean;
}

/** Ask the text AI once for missing identities before any per-shot conversion.
 * This prevents each shot from independently inventing a different face. */
export const prepareStoryboardImageIdentityContext = async (
  input: PrepareStoryboardImageIdentityContextInput,
): Promise<PreparedStoryboardImageIdentityContext> => {
  const visibility = input.requestVisibleCharacters
    ? await input.requestVisibleCharacters()
    : undefined;
  const initialContext = visibility
    ? {
        ...input.context,
        visibleCharacterNamesByShotId: visibility.visibleCharacterNamesByShotId,
      }
    : input.context;
  const plan = planStoryboardImageIdentityEnrichment(input.storyboard, initialContext);
  if (!plan.needsAiEnrichment) {
    return { context: initialContext, plan, enriched: false };
  }
  const details = await input.requestIdentityDetails(plan.targets.map((target) => target.name));
  const characters = mergeStoryboardImageIdentityEnrichment(
    initialContext.characters,
    details,
    plan.targets,
    input.createCharacterId,
  );
  const context = { ...initialContext, characters };
  const remaining = planStoryboardImageIdentityEnrichment(input.storyboard, context).targets;
  if (remaining.length > 0) {
    const summary = remaining
      .map((target) => `${target.name}（${target.missingFields.join('、')}）`)
      .join('；');
    throw new Error(`AI 自动补齐人物身份与外貌后仍缺少连续性资料：${summary}`);
  }
  return { context, plan, enriched: true };
};

const storyboardContextScenes = (
  storyboard: Storyboard,
  context: StoryboardImageBuildContext,
): Scene[] => {
  const sceneIds = new Set(uniqueIds([
    storyboard.sceneId,
    ...(storyboard.sourceSceneIds || []),
    ...(storyboard.sourceSceneSnapshots || []).map((scene) => scene.id),
  ]));
  const byId = new Map(context.scenes.map((scene) => [scene.id, scene]));
  const resolved = Array.from(sceneIds).map((id) => byId.get(id)).filter((scene): scene is Scene => Boolean(scene));
  const snapshots = storyboard.sourceSceneSnapshots || [];
  return [...resolved, ...snapshots.filter((scene) => !resolved.some((item) => item.id === scene.id))];
};

const imageVariantForStoryboardPurpose = (
  purpose: StoryboardImagePurpose,
): ImageVariant => purpose === 'first-frame'
  ? 'first-frame'
  : purpose === 'last-frame'
    ? 'last-frame'
    : 'storyboard-frame';

const storyboardImageContinuityContext = (
  storyboard: Storyboard,
  shot: VideoShot,
  purpose: StoryboardImagePurpose,
  context?: StoryboardImageBuildContext,
  customFrame?: StoryboardImageFrameMetadata,
): {
  lines: string[];
  referenceAssetIds: string[];
  primaryReferenceAssetIds: string[];
} => {
  if (!context) return { lines: [], referenceAssetIds: [], primaryReferenceAssetIds: [] };
  const scenes = storyboardContextScenes(storyboard, context);
  const sceneLocationIds = new Set(scenes.flatMap((scene) => uniqueIds([
    scene.locationId,
    ...(scene.locationIds || []),
  ])));
  const scenePropIds = new Set(scenes.flatMap((scene) => scene.propIds || []));
  const evidenceSource = cleanText([
    storyboard.sourceStoryTitle,
    storyboard.sourceStoryContent,
    publicVideoContinuityLock(storyboard.globalLock),
    shot.purpose,
    shot.subject,
    shot.action,
    shot.result,
    shot.prompt,
  ].filter(Boolean).join('\n'));
  const locatedSourceExcerpt = Number.isInteger(shot.sourceStart)
    && Number.isInteger(shot.sourceEnd)
    && (shot.sourceStart as number) >= 0
    && (shot.sourceEnd as number) > (shot.sourceStart as number)
      ? (storyboard.sourceStoryContent || '').slice(shot.sourceStart, shot.sourceEnd)
      : '';
  const shotNsfwEvidence = cleanText([
    locatedSourceExcerpt,
    shot.purpose,
    shot.subject,
    shot.action,
    shot.result,
    shot.prompt,
    authoritativeShotDescription(storyboard, shot),
  ].filter(Boolean).join('\n'));
  const characters = visibleCharactersForShot(storyboard, shot, context)
    .sort((left, right) => right.name.length - left.name.length);
  const locations = context.locations
    .filter((item) => sceneLocationIds.has(item.id) || entityNameAppears(item.name, evidenceSource))
    .sort((left, right) => right.name.length - left.name.length);
  const props = context.props
    .filter((item) => (
      scenePropIds.has(item.id)
      || entityNameAppears(item.name, evidenceSource)
      || characters.some((character) => entityNameAppears(item.name, character.signatureProps))
    ))
    .sort((left, right) => right.name.length - left.name.length);
  // Scene membership is a catalogue, not a request to attach every prop image.
  // Name matching only routes supplementary references for the current frame
  // or stable equipment. It does not decide visibility, ownership or whether a
  // prop has been put down/consumed; the converter receives those state facts.
  const currentPropEvidence = cleanText(customFrame?.imageFrameIndex
    ? customFrame.imageFrameDescription
    : purpose === 'first-frame'
      ? [shot.subject, storyboard.continuityIn].filter(Boolean).join('\n')
      : [shot.purpose, shot.subject, shot.action, shot.result, authoritativeShotDescription(storyboard, shot)].filter(Boolean).join('\n'));
  const referencedProps = props.filter((item) => (
    entityNameAppears(item.name, currentPropEvidence)
    || characters.some((character) => entityNameAppears(item.name, character.signatureProps))
  ));
  const shotOffset = storyboard.shots.findIndex((item) => item.id === shot.id);
  const currentBoundary = shotOffset >= 0
    ? resolveNsfwShotContinuityBoundaries(storyboard.shots)[shotOffset]
    : undefined;
  // An AI-selected intermediate still may precede the source shot's end state.
  // Keep the identity facts, but let its saved AI description define the moment.
  const currentNsfwState = customFrame?.imageFrameIndex
    ? undefined
    : purpose === 'first-frame'
    ? currentBoundary?.entry
    : currentBoundary?.end;
  const hasDynamicClothing = Boolean(
    currentNsfwState?.nudity
    || currentNsfwState?.clothingState
    || hasExplicitClothingStateChange(shotNsfwEvidence)
  );
  const privateShotEvidence = purpose === 'first-frame'
    ? cleanText([
        shot.subject,
        currentNsfwState?.nudity,
        currentNsfwState?.clothingState,
        currentNsfwState?.contact,
        currentNsfwState?.actionStage,
        currentNsfwState?.residue,
      ].filter(Boolean).join('\n'))
    : shotNsfwEvidence;
  const privateProfileContext = {
    evidence: privateShotEvidence,
    state: currentNsfwState,
    characterIds: characters.map((character) => character.id),
    characterNamesById: Object.fromEntries(
      characters.map((character) => [character.id, character.name]),
    ),
    // A whole-shot selection does not establish the visibility of a different
    // intermediate still or the moment before the shot's action begins.
    visiblePrivatePartsByCharacter: customFrame?.imageFrameIndex || purpose === 'first-frame'
      ? undefined : shot.visiblePrivatePartsByCharacter,
  };

  const characterLines = characters.map((item) => {
    const privateProfileParts = nsfwPrivateProfilePartsForCharacter(
      privateProfileContext,
      item.id,
    );
    return line(
      `人物“${item.name}”连续性事实`,
      [
        line('性别', item.gender),
        line('外观年龄', hasDynamicClothing ? '' : item.apparentAge),
        line('种族/身份外形', item.race),
        ...characterMorphologyPromptLines(item),
        line('外观', item.appearance),
        line('默认衣橱/身份服装基底', hasDynamicClothing ? '' : item.outfit),
        line('衣橱基底（不是本镜着装指令，入口衣着与本镜可见变化优先，未涉及衣物保持原状）', hasDynamicClothing ? item.outfit : ''),
        line('稳定长期装备/辨识物', item.signatureProps),
        line('动作习惯', item.motionHabits),
        line('正向锚点', hasDynamicClothing ? '' : item.anchor),
        line('稳定私密外貌', characterNsfwProfileText(
          item.nsfwProfile,
          privateProfileParts,
        )),
        line('禁止漂移', hasDynamicClothing ? '' : item.negativeContinuity),
      ].filter(Boolean).join('；'),
    );
  }).filter(Boolean);
  const locationLines = locations.map((item) => line(
    `地点“${item.name}”连续性事实`,
    [
      line('空间结构与材质', item.description),
      line('时间天气', item.timeWeather),
      line('固定光线', item.lighting),
      line('固定色彩', item.palette),
      line('固定陈设', item.fixedProps),
      line('空间锚点', item.anchor),
    ].filter(Boolean).join('；'),
  )).filter(Boolean);
  const propLines = props.map((item) => line(
    `场景道具“${item.name}”候选资料（只在本张可见时采用）`,
    [
      line('类别', item.category),
      line('材质', item.material),
      line('可见外形', item.appearance),
      line('可见作用', item.effect),
      line('状态规则', item.stateRules),
    ].filter(Boolean).join('；'),
  )).filter(Boolean);

  const assetsById = new Map(context.assets.map((asset) => [asset.id, asset]));
  const validImageAsset = hasUsableStoryboardReferencePixels;
  const allowedReferenceAssetIds = new Set(filterNsfwPrivateProfileAssetsForShot(
    context.assets,
    privateProfileContext,
  ).map((asset) => asset.id));
  const linkedAssetIds = (
    kind: NonNullable<ReferenceAsset['sourceEntityKind']>,
    entities: readonly { id: string; assetIds: string[] }[],
  ): string[] => [
    ...entities.flatMap((item) => item.assetIds || []),
    ...context.assets
      .filter((asset) => (
        asset.sourceEntityKind === kind
        && entities.some((item) => item.id === asset.sourceEntityId)
      ))
      .map((asset) => asset.id),
  ];
  const entityAssetIds = [
    ...linkedAssetIds('character', characters),
    ...linkedAssetIds('location', locations),
    ...linkedAssetIds('prop', referencedProps),
  ];
  const globalPrimaryReferenceAssetIds = uniqueIds(
    storyboard.globalReferenceAssetIds || [],
  ).filter((id) => allowedReferenceAssetIds.has(id) && validImageAsset(assetsById.get(id)));
  const automaticallyBoundShotAssetIds = new Set(
    context.assets
      .filter((asset) => (
        asset.source === 'generated'
        && asset.sourceStoryboardId === storyboard.id
        && asset.sourceShotId === shot.id
      ))
      .map((asset) => asset.id),
  );
  const primaryReferenceAssetIds = uniqueIds([
    ...globalPrimaryReferenceAssetIds,
    ...shot.referenceAssetIds.filter((id) => !automaticallyBoundShotAssetIds.has(id)),
  ]).filter((id) => allowedReferenceAssetIds.has(id) && validImageAsset(assetsById.get(id)));
  const primaryReferenceAssetIdSet = new Set(primaryReferenceAssetIds);
  // Sibling custom frames are outputs too. Do not infer all N pictures as the
  // next request's references; an explicitly selected global image still wins.
  const replacedOutputAssetIds = new Set(context.assets
    .filter((asset) => (
      automaticallyBoundShotAssetIds.has(asset.id)
      && asset.imageVariant === imageVariantForStoryboardPurpose(purpose)
    ))
    .map((asset) => asset.id));
  const referenceAssetIds = selectStoryboardImageReferences(uniqueIds([
    ...primaryReferenceAssetIds,
    ...shot.referenceAssetIds.filter((id) => (
      primaryReferenceAssetIdSet.has(id) || !replacedOutputAssetIds.has(id)
    )),
    ...entityAssetIds,
  ]).filter((id) => allowedReferenceAssetIds.has(id) && validImageAsset(assetsById.get(id))), primaryReferenceAssetIds, {
    assets: context.assets,
    characters,
    locations,
    props,
  });
  const referenceLines = referenceAssetIds
    .map((id) => assetsById.get(id))
    .filter(validImageAsset)
    .map((asset) => line(
      `参考图“${asset.name}”可见锚点`,
      clippedStory(Array.from(new Set([
        ...(isNsfwPrivateProfileAsset(asset)
          ? [nsfwPrivateReferenceResponsibility(asset)]
          : [asset.visualAnchor, asset.prompt]),
      ].map(cleanText).filter(Boolean))).join('；'), 3200),
    ))
    .filter(Boolean);
  return {
    lines: [
      ...(characterLines.length
        ? [customFrame?.imageFrameIndex
            ? '来源视频镜头人物身份资料：以下资料仅供 AI 已选定静帧中的实际可见人物保持身份；未在本张静帧中出现的人物不必入画，不得为了列全身份资料而添加人物。可见人物的姓名或称谓不能替代其可见外貌。'
            : '本镜实际出镜人物身份锁：按本镜可见范围保留对应人物必要身份与外貌，姓名或称谓不能替代外貌；资料本身不代表本镜动作或衣着变化。']
        : []),
      ...characterLines,
      ...locationLines,
      ...(propLines.length ? ['场景道具资料及自动关联的道具参考图都是候选依据，不表示每个物件都在当前静帧入画；AI 按当前镜头或选帧的时刻判断实际可见道具。手持、交接、放下、吃完等动作状态不得从别的时刻或参考图姿态继承。'] : []),
      ...propLines,
      ...(referenceLines.length ? ['参考图资料说明：下列锚点来自已保存的文字资料，不代表本次已查看图像像素。人物参考仅锁定身份外貌，道具参考仅锁定当前确实可见物件的外形，不沿用旧图的手持动作；非当前时刻的构图参考不能覆盖最终 H3 的具名人物站位、机位和身体侧别。资料排列与图片上传顺序均不代表画面左右顺序。'] : []),
      ...referenceLines,
      line(purpose === 'first-frame' ? '首帧入镜裸露状态' : '目标画面裸露状态', currentNsfwState?.nudity),
      line(purpose === 'first-frame' ? '首帧入镜衣物状态' : '目标画面衣物状态', currentNsfwState?.clothingState),
      line(purpose === 'first-frame' ? '首帧入镜关键接触' : '目标画面关键接触', currentNsfwState?.contact),
      line(purpose === 'first-frame' ? '首帧入镜动作阶段' : '目标画面动作阶段', currentNsfwState?.actionStage),
      line(purpose === 'first-frame' ? '首帧入镜残留状态' : '目标画面残留状态', currentNsfwState?.residue),
      ...(currentNsfwState?.nudity || currentNsfwState?.clothingState
        ? ['衣物状态优先级：本镜当前衣物与裸露状态高于人物默认衣橱；不得把默认衣橱中的衣物重新穿回。已脱衣物只作为离身道具保留，直到剧情明确重新穿上。']
        : []),
    ],
    referenceAssetIds,
    primaryReferenceAssetIds,
  };
};

/** Persist stable character design together with the shot state. Future image
 * batches can then recover appearance continuity from an older generated
 * asset even when no dedicated character reference was created. */
export const buildStoryboardImageAssetVisualAnchor = (
  storyboard: Storyboard,
  request: Pick<StoryboardImageRequest, 'shotId'> & Partial<Pick<StoryboardImageRequest, 'purpose'>> & StoryboardImageFrameMetadata,
  context: StoryboardImageBuildContext,
): string => {
  const shot = storyboard.shots.find((item) => item.id === request.shotId);
  if (!shot) return '';
  const shotOffset = storyboard.shots.findIndex((item) => item.id === shot.id);
  const purpose = request.purpose || 'storyboard-shot';
  const officialSource = readStoryboardImageH3Source(storyboard);
  const officialShot = officialSource?.shots[shotOffset];
  const currentBoundary = resolveNsfwShotContinuityBoundaries(storyboard.shots)[shotOffset];
  const currentNsfwState = request.imageFrameIndex
    ? undefined
    : purpose === 'first-frame'
    ? currentBoundary?.entry
    : currentBoundary?.end;
  const anchorEvidence = purpose === 'first-frame'
    ? cleanText([
        shot.subject,
        currentNsfwState?.nudity,
        currentNsfwState?.clothingState,
        currentNsfwState?.contact,
        currentNsfwState?.actionStage,
        currentNsfwState?.residue,
      ].filter(Boolean).join('\n'))
    : cleanText([
        Number.isInteger(shot.sourceStart)
          && Number.isInteger(shot.sourceEnd)
          && (shot.sourceStart as number) >= 0
          && (shot.sourceEnd as number) > (shot.sourceStart as number)
            ? (storyboard.sourceStoryContent || '').slice(shot.sourceStart, shot.sourceEnd)
            : '',
        shot.purpose,
        shot.subject,
        shot.action,
        shot.result,
        shot.prompt,
      ].filter(Boolean).join('\n'));
  const hasDynamicClothing = Boolean(
    currentNsfwState?.nudity
    || currentNsfwState?.clothingState
    || hasExplicitClothingStateChange(anchorEvidence)
  );
  const visibleCharacters = visibleCharactersForShot(storyboard, shot, context)
    .sort((left, right) => right.name.length - left.name.length);
  const privateProfileContext = {
    evidence: anchorEvidence,
    state: currentNsfwState,
    characterIds: visibleCharacters.map((character) => character.id),
    characterNamesById: Object.fromEntries(
      visibleCharacters.map((character) => [character.id, character.name]),
    ),
    visiblePrivatePartsByCharacter: request.imageFrameIndex || purpose === 'first-frame'
      ? undefined : shot.visiblePrivatePartsByCharacter,
  };
  const characterLines = visibleCharacters
    .map((character) => {
      const privateProfileParts = nsfwPrivateProfilePartsForCharacter(
        privateProfileContext,
        character.id,
      );
      return line(
        `人物“${character.name}”固定身份与外貌`,
        [
          line('性别', character.gender),
          line('种族/物种', character.race),
          ...characterMorphologyPromptLines(character),
          line('外观', character.appearance),
          line('默认衣橱/身份服装基底', hasDynamicClothing ? '' : character.outfit),
          line('衣橱基底（不是本镜着装指令，入口衣着与本镜可见变化优先，未涉及衣物保持原状）', hasDynamicClothing ? character.outfit : ''),
          line('稳定长期装备/辨识物', character.signatureProps),
          line('连续性锚点', hasDynamicClothing ? '' : character.anchor),
          line('稳定私密外貌', characterNsfwProfileText(
            character.nsfwProfile,
            privateProfileParts,
          )),
        ].filter(Boolean).join('；'),
      );
    })
    .filter(Boolean);
  return [
    ...(officialShot ? [
      '本图生成依据是以下最终 H3 镜头文字，不是对已生成像素的重新观测；旧结构化资料与参考图构图不能反向覆盖其中的空间事实。',
      'H3 主体定义供标签与姓名对应，下面本次提供的人物固定身份与外貌是当前项目资料；后续编辑过的外貌以当前资料为准，不按旧 H3 外貌回滚，也不因此更换本镜空间站位。',
      line(purpose === 'first-frame' ? '最终 H3 首镜原文（仅入口状态用于首帧，后续动作尚未发生）' : '最终 H3 对应镜头原文（按本张选定时刻取景）', officialShot),
      line('最终 H3 主体标签对应', officialSource?.subjectDefinitions),
    ] : []),
    line('AI 选定的本张静帧', request.imageFrameDescription),
    ...characterLines,
    line('本镜画面主体与站位', shot.subject),
    line('结构化镜头空间关系（H3未明确处的补充依据）', shot.space),
    line('结构化镜头人物朝向与运动方向（H3未明确处的补充依据）', shot.direction),
    line('结构化镜头机位（H3未明确处的补充依据）', shot.camera),
    line('本镜可见动作', request.imageFrameIndex ? '' : purpose === 'first-frame' ? firstFrameActionCue(shot) : shot.action),
    line('本镜可见结果', request.imageFrameIndex || purpose === 'first-frame' ? '' : shot.result),
    line(purpose === 'first-frame' ? '首帧入镜裸露状态' : '目标画面裸露状态', currentNsfwState?.nudity),
    line(purpose === 'first-frame' ? '首帧入镜衣物状态' : '目标画面衣物状态', currentNsfwState?.clothingState),
    line(purpose === 'first-frame' ? '首帧入镜关键接触' : '目标画面关键接触', currentNsfwState?.contact),
    line(purpose === 'first-frame' ? '首帧入镜动作阶段' : '目标画面动作阶段', currentNsfwState?.actionStage),
    line(purpose === 'first-frame' ? '首帧入镜残留状态' : '目标画面残留状态', currentNsfwState?.residue),
  ].filter(Boolean).join('\n');
};

const finalRestrictions = [
  '只表现上述剧情在该镜头中的一个明确可见瞬间，保持人物身份、外观、当前衣物状态、当前实际可见道具、空间方位和光线连续；默认衣橱只作身份基底，不能覆盖本镜当前衣物或裸露状态。长期装备按其稳定携带方式呈现，临时物件只在剧情当前状态需要时呈现。',
  '物种形态与身体结构是不可改写的连续性事实：非类人主体必须保持资料指定的头部/感知结构、躯干、肢体与附肢数量、体表材质和运动方式；除剧情明确拟人化外，不得人类化或擅自改成另一种身体结构。',
  '禁止拼贴、九宫格、多格漫画、前后对比图；禁止字幕、文字、Logo、水印、UI、边框和镜头编号。',
].join('\n');

const buildRequest = (
  storyboard: Storyboard,
  shot: VideoShot,
  purpose: StoryboardImagePurpose,
  context?: StoryboardImageBuildContext,
  customFrame?: StoryboardImageFrameMetadata,
): StoryboardImageRequest => {
  const total = storyboard.shots.length;
  const shotOffset = storyboard.shots.findIndex((item) => item.id === shot.id);
  const previousShot = shotOffset > 0 ? storyboard.shots[shotOffset - 1] : undefined;
  const officialSource = readStoryboardImageH3Source(storyboard);
  const officialShot = officialSource?.shots[shotOffset];
  const authoritativeDescription = authoritativeShotDescription(storyboard, shot);
  const continuityContext = storyboardImageContinuityContext(storyboard, shot, purpose, context, customFrame);
  const imageVariant = imageVariantForStoryboardPurpose(purpose);
  const purposeLines = purpose === 'first-frame'
    ? [
        '帧位要求：这是视频首帧，必须定格在第一镜动作起始状态，即动作真正开始前或刚开始的姿态；不得提前表现动作结果。',
        `镜头位置：第 ${shot.index} 镜，共 ${total} 镜。`,
        ...(officialShot ? [
          '首帧时间边界高于整镜动作链：下面最终 H3 首镜原文用于确定已确认的入口人物、空间与机位；其中随后、镜尾或动作完成后的变化尚未发生，不得提前画进首帧。',
          line('最终 H3 首镜原文（仅入口状态用于当前首帧）', officialShot),
        ] : []),
        line('本镜剧情目的', shot.purpose),
        line('画面主体与站位', shot.subject),
        line('结构化镜头空间关系（H3未明确处的补充依据）', shot.space),
        line('结构化镜头人物朝向与运动方向（H3未明确处的补充依据）', shot.direction),
        line('入镜动作边界', firstFrameActionCue(shot)),
        line('镜头景别、机位与运动', shot.camera),
        line('光线与环境气氛', shot.lighting),
      ]
    : purpose === 'last-frame'
      ? [
          '帧位要求：这是视频尾帧，必须呈现最后一镜动作完成后的最终状态，不自行续写下一动作或下一事件。',
          line('最后一镜权威画面描述', authoritativeDescription),
          ...shotPromptLines(shot, total),
          line('承接上一镜的可见结果', previousShot?.result),
          line('动作完成后的可见结果', shot.result),
        ]
      : customFrame?.imageFrameIndex
        ? [
            `帧位要求：这是用户指定的本段 ${customFrame.imageFrameCount} 张分镜图片中的第 ${customFrame.imageFrameIndex} 张，只生成这一张单幅静帧。`,
            '本张画面采用下面 AI 已选定的明确瞬间；来源镜头的动作过程、结束状态与完整剧情只用于理解连续性，不要求把多个时刻合并到画面，也不修改视频镜头、时长或台词。',
            line('AI 选定的本张静帧', customFrame.imageFrameDescription),
            typeof customFrame.imageFrameTimeSec === 'number'
              ? `AI 选定的本段时刻：${customFrame.imageFrameTimeSec} 秒（仅供定位单个瞬间，不渲染为文字）。`
              : '',
            line('来源镜头权威画面描述（空间与机位依据，动作过程是连续性背景）', authoritativeDescription),
            ...shotPromptLines(shot, total),
            line('来源镜头入口状态（连续性背景）', previousShot?.result),
            line('来源镜头结束结果（连续性背景）', shot.result),
          ]
        : [
          '帧位要求：这是当前镜头的分镜图片，定格在最能体现本镜剧情因果、人物动作和可见结果的瞬间。',
          line('本镜权威画面描述', authoritativeDescription),
          ...shotPromptLines(shot, total),
          line('本镜入口状态（上一镜可见结果）', previousShot?.result),
          line('本镜结束时的可见结果', shot.result),
        ];
  const canvas = canvasForAspectRatio(storyboard.aspectRatio);
  return {
    purpose,
    name: buildStoryboardImageBaseName(storyboard, shot.index, purpose, context?.projectName, customFrame),
    storyboardId: storyboard.id,
    shotId: shot.id,
    shotIndex: shot.index,
    assetKind: 'storyboard',
    assetType: purpose === 'first-frame' ? 'first-frame' : purpose === 'last-frame' ? 'last-frame' : 'reference',
    assetRole: purpose === 'first-frame' ? 'first-frame' : purpose === 'last-frame' ? 'last-frame' : 'composition',
    referenceRole: purpose === 'first-frame' ? 'first-frame' : purpose === 'last-frame' ? 'last-frame' : 'composition',
    imageVariant,
    ...(customFrame?.imageFrameBatchId ? { imageFrameBatchId: customFrame.imageFrameBatchId } : {}),
    ...(customFrame?.imageFrameIndex ? {
      imageFrameIndex: customFrame.imageFrameIndex,
      imageFrameCount: customFrame.imageFrameCount,
      imageFrameDescription: customFrame.imageFrameDescription,
      ...(typeof customFrame.imageFrameTimeSec === 'number' ? { imageFrameTimeSec: customFrame.imageFrameTimeSec } : {}),
    } : {}),
    referenceAssetIds: continuityContext.referenceAssetIds,
    primaryReferenceAssetIds: continuityContext.primaryReferenceAssetIds,
    conversionSource: [
      customFrame?.imageFrameIndex
        ? '当前图片规划优先：只表现 AI 选定的本张静帧中实际可见的人物、局部与单个瞬间；完整人物名单、动作过程和结束状态不要求全部入画，但最终 H3 明确的站位、机位、身体侧别与在画/画外状态始终有效，选帧描述不能借构图覆盖或重排它们。'
        : '当前镜事实优先：先锁定本镜实际出镜人物及其完整外貌，再组织这个镜头的唯一可见瞬间。',
      STORYBOARD_SPATIAL_FRAME_RULE,
      ...purposeLines,
      ...(officialShot ? [
        '上述权威镜头描述是最终已确认 H3 的原文；下方结构化旧稿、人物默认资料及参考图文字只补充未明确的事实，冲突时由 AI 保留最终 H3 中的空间、机位与在画/画外语义，不回滚成旧稿。',
        line('最终 H3 主体标签对应', officialSource?.subjectDefinitions),
        line('最终 H3 整体视觉前言', officialSource?.visualPreamble),
      ] : []),
      ...(previousShot ? [
        line('上一镜权威画面原文（只承接末状态与空间，不重复上一镜动作）', authoritativeShotDescription(storyboard, previousShot)),
        line('上一镜结构化空间（最终 H3 未明确处的补充）', previousShot.space),
        line('上一镜结构化朝向（最终 H3 未明确处的补充）', previousShot.direction),
        line('上一镜结构化机位（最终 H3 未明确处的补充）', previousShot.camera),
      ] : []),
      ...continuityContext.lines,
      ...sharedPromptLines(storyboard, purpose),
      finalRestrictions,
    ].filter(Boolean).join('\n'),
    ...canvas,
  };
};

/** Reconstruct one frozen AI-selected still without selecting a different moment.
 * The name is a base name; a caller starting a batch reserves it before enqueue. */
export const buildStoryboardImageRequestFromFrame = (
  storyboard: Storyboard,
  sourceShotId: string,
  frame: StoryboardImageFrameMetadata,
  context?: StoryboardImageBuildContext,
): StoryboardImageRequest => {
  const shot = storyboard.shots.find((item) => item.id === sourceShotId);
  if (!shot) throw new Error('AI 图片规划对应的来源镜头已不存在，请重新生成分镜图片。');
  if (!Number.isInteger(frame.imageFrameIndex) || (frame.imageFrameIndex || 0) < 1
    || !Number.isInteger(frame.imageFrameCount) || (frame.imageFrameCount || 0) < (frame.imageFrameIndex || 0)
    || typeof frame.imageFrameDescription !== 'string' || !frame.imageFrameDescription.trim()) {
    throw new Error('自定义分镜图片缺少可恢复的图片序号、总数或 AI 静帧描述。');
  }
  return buildRequest(storyboard, shot, 'storyboard-shot', context, frame);
};

/** Each entry is authored by the text AI. Never duplicate shots or synthesize
 * timestamps locally to meet the requested image total. */
export const buildCustomStoryboardImageRequests = (
  storyboard: Storyboard,
  frames: readonly StoryboardImageFramePlan[],
  context?: StoryboardImageBuildContext,
): StoryboardImageRequest[] => {
  const allocateName = createStoryboardImageNameAllocator([
    ...(context?.assets || []).flatMap((asset) => [asset.name, (asset.fileName || '').replace(/\.[^.]+$/u, '')]),
    ...(context?.generationTaskNames || []),
  ]);
  return frames.map((frame, index) => {
    const request = buildStoryboardImageRequestFromFrame(storyboard, frame.sourceShotId, {
      imageFrameIndex: index + 1,
      imageFrameCount: frames.length,
      imageFrameDescription: frame.description,
      ...(typeof frame.timeSec === 'number' ? { imageFrameTimeSec: frame.timeSec } : {}),
    }, context);
    return { ...request, name: allocateName(request.name) };
  });
};

export const buildStoryboardImageRequests = (
  storyboard: Storyboard,
  mode: StoryboardImageBatchMode,
  context?: StoryboardImageBuildContext,
): StoryboardImageRequest[] => {
  if (!storyboard.shots.length) return [];
  const allocateName = createStoryboardImageNameAllocator([
    ...(context?.assets || []).flatMap((asset) => [
      asset.name,
      (asset.fileName || '').replace(/\.[^.]+$/u, ''),
    ]),
    ...(context?.generationTaskNames || []),
  ]);
  const namedRequest = (shot: VideoShot, purpose: StoryboardImagePurpose) => {
    const request = buildRequest(storyboard, shot, purpose, context);
    return { ...request, name: allocateName(request.name) };
  };
  if (mode === 'storyboard-shots') {
    return storyboard.shots.map((shot) => namedRequest(shot, 'storyboard-shot'));
  }
  const first = storyboard.shots[0];
  const last = storyboard.shots[storyboard.shots.length - 1];
  return [
    namedRequest(first, 'first-frame'),
    namedRequest(last, 'last-frame'),
  ];
};

/** Build only the storyboard-image requests selected by the user while
 * preserving the authoritative shot order from the storyboard. */
export const buildSelectedStoryboardImageRequests = (
  storyboard: Storyboard,
  selectedShotIds: readonly string[],
  context?: StoryboardImageBuildContext,
): StoryboardImageRequest[] => {
  const selected = new Set(selectedShotIds.map((id) => id.trim()).filter(Boolean));
  if (!selected.size) return [];
  return buildStoryboardImageRequests(storyboard, 'storyboard-shots', context)
    .filter((request) => selected.has(request.shotId));
};

const addReference = (ids: readonly string[], assetId: string): string[] => (
  ids.includes(assetId) ? [...ids] : [...ids, assetId]
);

export const bindStoryboardImageAsset = (
  storyboard: Storyboard,
  request: StoryboardImageRequest,
  assetId: string,
  samePurposeAssetIds: readonly string[] = [],
): Storyboard => {
  const replacedAssetIds = new Set(samePurposeAssetIds);
  if (request.purpose === 'first-frame' && storyboard.firstFrameAssetId) {
    replacedAssetIds.add(storyboard.firstFrameAssetId);
  }
  if (request.purpose === 'last-frame' && storyboard.lastFrameAssetId) {
    replacedAssetIds.add(storyboard.lastFrameAssetId);
  }
  // A checked global image is an explicit user input, even if it originally
  // came from an older generated batch. Never remove that user's selection.
  for (const id of storyboard.globalReferenceAssetIds || []) replacedAssetIds.delete(id);
  const replacesWholeBatch = Boolean(request.imageFrameBatchId && request.imageVariant === 'storyboard-frame');
  const shots = storyboard.shots.map((shot) => {
    const retained = shot.id === request.shotId || replacesWholeBatch
      ? shot.referenceAssetIds.filter((id) => !replacedAssetIds.has(id))
      : [...shot.referenceAssetIds];
    return { ...shot, referenceAssetIds: shot.id === request.shotId ? addReference(retained, assetId) : retained };
  });
  return {
    ...storyboard,
    shots,
    ...(request.purpose === 'first-frame' ? { firstFrameAssetId: assetId } : {}),
    ...(request.purpose === 'last-frame' ? { lastFrameAssetId: assetId } : {}),
  };
};

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const storyboardImageSourceFingerprint = (
  storyboard: Storyboard,
  request: Pick<
    StoryboardImageGenerationRequest,
    | 'purpose'
    | 'shotId'
    | 'imagePromptRuleSetId'
    | 'imagePromptRuleSetVersion'
    | 'imagePromptPresetId'
    | 'imagePromptPresetVersion'
    | 'imagePromptFormat'
    | 'imageFrameIndex'
    | 'imageFrameCount'
    | 'imageFrameDescription'
    | 'imageFrameTimeSec'
  >,
  context?: StoryboardImageBuildContext,
): string => {
  // Generated images from this storyboard are outputs, not source facts. Exclude
  // them so an earlier FIFO item cannot make the remaining batch look stale.
  const generatedStoryboardAssetIds = new Set(
    (context?.assets || [])
      .filter((asset) => (
        asset.source === 'generated'
        && asset.sourceStoryboardId === storyboard.id
        && !(storyboard.globalReferenceAssetIds || []).includes(asset.id)
      ))
      .map((asset) => asset.id),
  );
  const fingerprintStoryboard = generatedStoryboardAssetIds.size
    ? {
        ...storyboard,
        firstFrameAssetId: storyboard.firstFrameAssetId
          && !generatedStoryboardAssetIds.has(storyboard.firstFrameAssetId)
          ? storyboard.firstFrameAssetId
          : undefined,
        lastFrameAssetId: storyboard.lastFrameAssetId
          && !generatedStoryboardAssetIds.has(storyboard.lastFrameAssetId)
          ? storyboard.lastFrameAssetId
          : undefined,
        shots: storyboard.shots.map((item) => ({
          ...item,
          referenceAssetIds: item.referenceAssetIds.filter((id) => !generatedStoryboardAssetIds.has(id)),
        })),
      }
    : storyboard;
  const fingerprintContext = context
    ? {
        ...context,
        assets: context.assets.filter((asset) => !generatedStoryboardAssetIds.has(asset.id)),
      }
    : undefined;
  const shotOffset = fingerprintStoryboard.shots.findIndex((shot) => shot.id === request.shotId);
  const shot = shotOffset >= 0 ? fingerprintStoryboard.shots[shotOffset] : undefined;
  const previousShot = shotOffset > 0 ? fingerprintStoryboard.shots[shotOffset - 1] : undefined;
  const builtRequest = shot
    ? buildRequest(fingerprintStoryboard, shot, request.purpose, fingerprintContext, request)
    : undefined;
  const referenceAssetsById = new Map(
    (fingerprintContext?.assets || []).map((asset) => [asset.id, asset] as const),
  );
  return `storyboard-image-${fnv1a(JSON.stringify({
    storyboardId: fingerprintStoryboard.id,
    purpose: request.purpose,
    imagePromptRuleSetId: request.imagePromptRuleSetId,
    imagePromptRuleSetVersion: request.imagePromptRuleSetVersion,
    imagePromptPresetId: request.imagePromptPresetId,
    imagePromptPresetVersion: request.imagePromptPresetVersion,
    imagePromptFormat: request.imagePromptFormat,
    imageFrameIndex: request.imageFrameIndex,
    imageFrameCount: request.imageFrameCount,
    imageFrameDescription: request.imageFrameDescription,
    imageFrameTimeSec: request.imageFrameTimeSec,
    sourceStoryTitle: fingerprintStoryboard.sourceStoryTitle || '',
    sourceStoryContent: fingerprintStoryboard.sourceStoryContent || '',
    globalLock: fingerprintStoryboard.globalLock,
    visualStyle: fingerprintStoryboard.visualStyle || '',
    continuityIn: fingerprintStoryboard.continuityIn || '',
    continuityOut: fingerprintStoryboard.continuityOut || '',
    aspectRatio: fingerprintStoryboard.aspectRatio,
    resolution: fingerprintStoryboard.resolution,
    orderedShotIds: fingerprintStoryboard.shots.map((item) => item.id),
    conversionSource: builtRequest?.conversionSource || '',
    referenceAssets: (builtRequest?.referenceAssetIds || []).map((id) => {
      const asset = referenceAssetsById.get(id);
      return asset ? {
        id: asset.id,
        checksum: asset.checksum || '',
        relativePath: asset.relativePath || '',
        url: asset.url || '',
        visualAnchor: asset.visualAnchor || '',
        prompt: asset.prompt || '',
        updatedAt: asset.updatedAt,
      } : { id };
    }),
    primaryReferenceAssetIds: builtRequest?.primaryReferenceAssetIds || [],
    previousResult: previousShot?.result || '',
    shot: shot ? {
      id: shot.id,
      index: shot.index,
      startSec: shot.startSec,
      endSec: shot.endSec,
      purpose: shot.purpose,
      subject: shot.subject,
      action: shot.action,
      camera: shot.camera,
      lighting: shot.lighting,
      result: shot.result,
      prompt: shot.prompt,
    } : null,
  }))}`;
};

export interface StoryboardImageBatchResult<
  T,
  TRequest extends StoryboardImageRequest = StoryboardImageRequest,
> {
  request: TRequest;
  status: 'succeeded' | 'failed' | 'cancelled';
  value?: T;
  error?: string;
}

export interface ExecuteStoryboardImageGenerationInput<T> {
  request: StoryboardImageGenerationRequest;
  negativePrompt?: string;
  referenceImage?: string;
  referenceImages?: string[];
  primaryReferenceImageCount?: number;
  convertPrompt: (source: string) => Promise<string>;
  persistConvertedPrompt: (prompt: string) => void | Promise<void>;
  generateImage: (input: {
    prompt: string;
    negativePrompt?: string;
    referenceImage?: string;
    referenceImages?: string[];
    primaryReferenceImageCount?: number;
    width: number;
    height: number;
    sizeOverride?: boolean;
  }) => Promise<T>;
}

export interface ExecutedStoryboardImageGeneration<T> {
  finalPrompt: string;
  generated: T;
}

export const assertUsableConvertedStoryboardImagePrompt = (
  value: unknown,
  conversionSource: string,
  format: StoryboardImageGenerationRequest['imagePromptFormat'],
): string => {
  const prompt = typeof value === 'string' ? value.trim() : '';
  if (!prompt) throw new Error('分镜图片提示词转换失败：文本模型返回了空内容');
  try {
    return assertValidFinalImagePrompt(prompt, format, conversionSource);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error || '最终格式不合格');
    throw new Error(`分镜图片提示词转换失败：${detail}`);
  }
};

/** Enforce the non-bypassable conversion boundary before any image request. */
export const executeStoryboardImageGeneration = async <T>(
  input: ExecuteStoryboardImageGenerationInput<T>,
): Promise<ExecutedStoryboardImageGeneration<T>> => {
  const finalPrompt = assertUsableConvertedStoryboardImagePrompt(
    await input.convertPrompt(input.request.conversionSource),
    input.request.conversionSource,
    input.request.imagePromptFormat,
  );
  await input.persistConvertedPrompt(finalPrompt);
  const generated = await input.generateImage({
    prompt: finalPrompt,
    negativePrompt: input.negativePrompt,
    referenceImage: input.referenceImage,
    referenceImages: input.referenceImages,
    primaryReferenceImageCount: input.primaryReferenceImageCount,
    width: input.request.width,
    height: input.request.height,
    ...(typeof input.request.sizeOverride === 'boolean' ? { sizeOverride: input.request.sizeOverride } : {}),
  });
  return { finalPrompt, generated };
};

export const runStoryboardImageBatch = async <
  T,
  TRequest extends StoryboardImageRequest = StoryboardImageRequest,
>(
  requests: readonly TRequest[],
  worker: (request: TRequest, index: number) => Promise<T>,
  canStart: (request: TRequest, index: number) => boolean = () => true,
): Promise<Array<StoryboardImageBatchResult<T, TRequest>>> => {
  if (!requests.length) return [];
  return Promise.all(requests.map((request, index) => enqueueImageTask(async () => {
    try {
      if (!canStart(request, index)) return { request, status: 'cancelled' } as const;
      return { request, status: 'succeeded', value: await worker(request, index) } as const;
    } catch (error) {
      if (isGenerationTaskCancelledError(error)) return { request, status: 'cancelled' } as const;
      return {
        request,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error || '图像生成失败'),
      } as const;
    }
  })));
};

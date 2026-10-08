import type {
  ImageApiConfig, ReferenceAsset, Storyboard, StoryboardImageFrameMetadata, StoryboardImageToImageSettings, VideoShot,
} from './types';
import type { ResolvedImageOutputSize } from './imageOutputSize';
import type {
  StoryboardImageBuildContext, StoryboardImageRequest, StoryboardReferenceImageLoader,
} from './storyboardImages';
import { hasUsableStoryboardReferencePixels, resolveStoryboardReferenceImages } from './storyboardImages';
import { readStoryboardImageH3Source } from './storyboardImageH3Source';
import { buildStoryboardImageBaseName, createStoryboardImageNameAllocator } from './storyboardImageNames';
import { resolveStoryboardImageOutputSize, defaultStoryboardImageOutputSize } from './storyboardImageOutputSize';
import { assertComfyUIWorkflowCanBindReferenceImages } from './comfyui';
import { canUseNsfwPrivateProfileAssetForStoryboardShot } from './nsfwPrivateAssets';
import { parseStoryboardImageFramePlan, validateStoryboardImagePlanCount, type StoryboardImageFramePlan } from './storyboardImagePlan';
import { buildStoryboardImagePromptWithReferences, stripStoryboardImageReferenceMetadata, storyboardImageFramingInstruction, type StoryboardImageReferenceContext } from './storyboardImageReferences';

const ids = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean))]
  : [];

/** The draft selection never becomes an implicit global reference fallback. */
export const normalizeStoryboardImageToImageSettings = (
  value: unknown,
  shotIds?: readonly string[],
): StoryboardImageToImageSettings => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const known = shotIds ? new Set(shotIds) : undefined;
  const bindings = source.referenceAssetIdsByShotId;
  return {
    referenceAssetIds: ids(source.referenceAssetIds),
    selectedShotIds: ids(source.selectedShotIds).filter((id) => !known || known.has(id)),
    referenceAssetIdsByShotId: Object.fromEntries(
      bindings && typeof bindings === 'object' && !Array.isArray(bindings)
        ? Object.entries(bindings).filter(([id]) => id && (!known || known.has(id)))
          .map(([id, values]) => [id, ids(values)])
        : [],
    ),
  };
};

export const resolveStoryboardImageToImageReferences = (
  settings: StoryboardImageToImageSettings | undefined,
  shotId: string,
): string[] => ids(settings?.referenceAssetIdsByShotId?.[shotId]);

export interface DirectStoryboardImageSelection {
  shotIds: readonly string[];
  referenceAssetIdsByShotId: Readonly<Record<string, readonly string[]>>;
}

/** The reference picker selects original images for this segment only. The
 * existing result buttons, not the picker, choose which stills to generate. */
export interface DirectStoryboardImageBatchSelection {
  mode: 'storyboard-shots' | 'boundary-frames' | 'selected-shots';
  referenceAssetIds: readonly string[];
  shotIds?: readonly string[];
  /** Already authored still plan; this builder never calls a text model. */
  frames?: readonly StoryboardImageFramePlan[];
}

export interface DirectStoryboardImageRequest extends StoryboardImageRequest {
  /** Already usable by the image API; it must never enter the text converter. */
  directPrompt: string;
  directPromptSource: 'current-image-prompt' | 'confirmed-h3' | 'shot-visual';
}

export interface DirectStoryboardImagePromptConversion {
  ruleSetId: string;
  ruleSetVersion?: string;
  presetId: string;
  presetVersion?: string;
  format: string;
  mode: 'gpt-image-2-5-micro-nsfw';
  /** Version 3 requires specific work identity; 2 is retained for old provenance. */
  version: 2 | 3;
}

export interface DirectStoryboardImageBuildContext extends StoryboardImageBuildContext {
  /** Explicitly opted in only for an OpenAI natural-language image request. */
  includeReferenceMetadata?: boolean;
  /** An old asset prompt without matching provenance is deliberately not reused. */
  currentImagePromptsByShotId?: Readonly<Record<string, { prompt: string; sourceFingerprint: string }>>;
  /** Converter provenance for direct image prompts that must not reuse plain old direct prompts. */
  directPromptConversion?: DirectStoryboardImagePromptConversion;
  /** Frozen authored evidence for the existing converter only, never a direct prompt prefix. */
  conversionIdentityContext?: string;
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const line = (label: string, value: unknown): string => text(value) ? `${label}：${text(value)}` : '';

/** Remove only explicit video protocol payload, not phrases or story semantics.
 * No value in the storyboard is changed. Mixed visual/audio prose remains literal
 * visual context; there is no local NLP rewrite and no whole-film audio section. */
const imageExcerpt = (value: string): string => value
  .replace(/<d>[\s\S]*?<\/d>/gu, '')
  .replace(/<(?:scenetrans|cutoff)>|<Audio \d+>|\(S\d+(?:,S?\d+)*\)/gu, '')
  .replace(/^\s*\[Shot\s*\d+\]\s*(?:At \d{2}:\d{2}\.\d{3}[,，\s]*)?/u, '')
  .trim();

const directVisualSource = (storyboard: Storyboard, shot: VideoShot): {
  body: string; source: 'confirmed-h3' | 'shot-visual';
} => {
  const h3 = readStoryboardImageH3Source(storyboard);
  const offset = storyboard.shots.findIndex((item) => item.id === shot.id);
  const h3Shot = h3?.shots[offset];
  if (h3Shot) return {
    source: 'confirmed-h3',
    body: [
      line('原稿主体定义（只作身份文字说明，不是本次上传图片编号）', imageExcerpt(h3.subjectDefinitions)),
      line('已确认整体视觉', imageExcerpt(h3.visualPreamble)),
      line('当前镜头已确认画面原文', imageExcerpt(h3Shot)),
    ].filter(Boolean).join('\n'),
  };
  // VideoShot.prompt may contain the entire video protocol, voices or dialogue.
  // These already separated visual fields are the unambiguous legacy source.
  return {
    source: 'shot-visual',
    body: [
      line('画面主体', shot.subject), line('空间', shot.space), line('动作', shot.action),
      line('表演', shot.performance), line('朝向', shot.direction), line('机位与景别', shot.camera),
      line('光线', shot.lighting), line('可见结果', shot.result), line('画面风格', storyboard.visualStyle),
    ].filter(Boolean).join('\n'),
  };
};

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const directPromptReferenceLines = (): string[] => [
  '根据实际随请求上传的参考图片生成当前目标分镜的一张独立静帧，不生成拼图或多格分镜。',
  '参考图提供对应人物身份、外貌或场景外观；当前镜头画面描述决定本镜动作、衣着状态、站位、机位和构图，不照搬参考图中的临时持物、姿态或背景。',
  '只采用下面当前镜头的可见画面；声音和发话文字不是画面文字，不增加字幕、对话气泡或协议标签。原稿中的 Subject/Picture/Video 标签只属于原视频描述，不能按编号匹配本次上传图片。',
];

export const buildDirectStoryboardImagePromptWithReferences = (
  body: string,
  assets: readonly ReferenceAsset[],
  context: StoryboardImageReferenceContext = {},
  includeReferenceMetadata = false,
): string => {
  if (includeReferenceMetadata) {
    const authoredBody = stripStoryboardImageReferenceMetadata(body);
    const introduction = directPromptReferenceLines().join('\n');
    return buildStoryboardImagePromptWithReferences(
      authoredBody.startsWith(`${introduction}\n`) ? authoredBody : `${introduction}\n${authoredBody}`,
      assets, context,
    );
  }
  return [
  ...directPromptReferenceLines(),
  '本次实际上传图片（严格按此顺序）：',
  ...assets.map((asset, index) => `${index + 1}. ${JSON.stringify(asset.name)} — ${
    asset.sourceEntityKind === 'character' || (asset.referenceRole || asset.role) === 'character' ? '人物身份与外貌'
      : asset.sourceEntityKind === 'location' || (asset.referenceRole || asset.role) === 'scene' ? '场景环境'
        : asset.sourceEntityKind === 'prop' || (asset.referenceRole || asset.role) === 'prop' ? '道具外观' : '画面参考'
  }`),
  body,
].join('\n');
};

/** Unrelated library additions, generated outputs and video-ref picks do not
 * invalidate a frozen direct image request. Actual visual/source-pixel edits do. */
export const directStoryboardImageSourceFingerprint = (
  storyboard: Storyboard,
  request: Pick<StoryboardImageRequest, 'shotId' | 'referenceAssetIds'>
    & Partial<Pick<StoryboardImageRequest, 'purpose'>> & StoryboardImageFrameMetadata,
  context: Pick<DirectStoryboardImageBuildContext, 'assets' | 'directPromptConversion' | 'conversionIdentityContext' | 'includeReferenceMetadata'>,
): string => {
  const shot = storyboard.shots.find((item) => item.id === request.shotId);
  const assets = new Map(context.assets.map((asset) => [asset.id, asset]));
  const hasConversion = Boolean(context.directPromptConversion);
  return `direct-storyboard-image-${hasConversion ? `v${context.directPromptConversion?.version ?? 2}` : 'v1'}-${fnv1a(JSON.stringify({
    referenceFramingVersion: 2,
    includeReferenceMetadata: Boolean(context.includeReferenceMetadata),
    boardId: storyboard.id, shotId: request.shotId,
    // Keep ordinary per-shot legacy fingerprints stable, but never reuse one
    // moment's image prompt for another moment, first frame or last frame.
    purpose: request.purpose === 'storyboard-shot' ? undefined : request.purpose,
    imageFrameIndex: request.imageFrameIndex, imageFrameCount: request.imageFrameCount,
    imageFrameDescription: request.imageFrameDescription, imageFrameTimeSec: request.imageFrameTimeSec,
    directPromptConversion: context.directPromptConversion,
    // Ordinary direct requests retain their exact legacy fingerprint. Only
    // converter-authored prompts depend on their frozen identity evidence.
    ...(hasConversion ? { conversionIdentityContext: context.conversionIdentityContext || '' } : {}),
    visual: shot ? directVisualSource(storyboard, shot) : null,
    references: request.referenceAssetIds.map((id) => {
      const asset = assets.get(id);
      return asset ? {
        id, name: asset.name, role: asset.referenceRole || asset.role,
        characterReferenceId: asset.characterReferenceId,
        checksum: asset.checksum, relativePath: asset.relativePath, url: asset.url,
        // Inline-only imports do not necessarily have a checksum.
        inlineFingerprint: asset.dataUrl ? fnv1a(asset.dataUrl) : undefined,
        missing: asset.missing,
      } : { id, missing: true };
    }),
  }))}`;
};

/** Direct image requests behind the original result-panel controls. Every
 * request uses the exact same explicitly selected segment originals; legacy
 * per-shot/video/global selections never participate. Custom count is the
 * length of an existing AI still plan, not a request to repeat every shot N
 * times or synthesize new moments locally. */
export const buildDirectStoryboardImageBatchRequests = (
  storyboard: Storyboard,
  selection: DirectStoryboardImageBatchSelection,
  context: DirectStoryboardImageBuildContext,
  size?: ResolvedImageOutputSize,
): DirectStoryboardImageRequest[] => {
  if (!storyboard.shots.length) throw new Error('当前没有可生成图片的视频分镜，请先生成视频提示词。');
  const referenceAssetIds = ids(selection.referenceAssetIds);
  if (!referenceAssetIds.length) throw new Error('请先在参考图栏选择图片，直接图生图不会自动使用历史图片或改为文生图。');
  if (!['storyboard-shots', 'boundary-frames', 'selected-shots'].includes(selection.mode)) {
    throw new Error('无法识别本次分镜图片生成模式。');
  }
  if (selection.frames !== undefined && selection.mode !== 'storyboard-shots') {
    throw new Error('自定义图片规划仅用于分镜图片生成，不能代替首尾帧或所选镜头。');
  }
  type Moment = { shotId: string; purpose: StoryboardImageRequest['purpose']; frame?: StoryboardImageFrameMetadata };
  let moments: Moment[];
  if (selection.frames !== undefined) {
    validateStoryboardImagePlanCount(selection.frames.length);
    // Existing transport parser validates only count, shot IDs and required
    // fields. It does not choose, rewrite, merge or reorder the AI's moments.
    const frames = parseStoryboardImageFramePlan(JSON.stringify(selection.frames), selection.frames.length, storyboard.shots.map((shot) => shot.id));
    moments = frames.map((frame, index) => ({
      shotId: frame.sourceShotId, purpose: 'storyboard-shot',
      frame: {
        imageFrameIndex: index + 1, imageFrameCount: frames.length, imageFrameDescription: frame.description,
        ...(frame.timeSec === undefined ? {} : { imageFrameTimeSec: frame.timeSec }),
      },
    }));
  } else if (selection.mode === 'boundary-frames') {
    moments = [
      { shotId: storyboard.shots[0].id, purpose: 'first-frame' },
      { shotId: storyboard.shots[storyboard.shots.length - 1].id, purpose: 'last-frame' },
    ];
  } else {
    const selected = selection.mode === 'selected-shots' ? ids(selection.shotIds) : storyboard.shots.map((shot) => shot.id);
    if (!selected.length) throw new Error('请至少选择一个目标分镜。');
    const known = new Set(storyboard.shots.map((shot) => shot.id));
    const unknown = selected.find((id) => !known.has(id));
    if (unknown) throw new Error(`所选目标分镜已不存在：${unknown}，不会自动生成其它镜头。`);
    const selectedSet = new Set(selected);
    moments = storyboard.shots.filter((shot) => selectedSet.has(shot.id)).map((shot) => ({ shotId: shot.id, purpose: 'storyboard-shot' }));
  }
  const sourceIds = [...new Set(moments.map((moment) => moment.shotId))];
  // A cache for a whole shot is not a first/last frame or a custom instant.
  const templateContext = selection.frames !== undefined || selection.mode === 'boundary-frames'
    ? { ...context, currentImagePromptsByShotId: undefined } : context;
  const templates = new Map(buildDirectStoryboardImageRequests(storyboard, {
    shotIds: sourceIds,
    referenceAssetIdsByShotId: Object.fromEntries(sourceIds.map((id) => [id, [...referenceAssetIds]])),
  }, templateContext, size).map((request) => [request.shotId, request]));
  const allocateName = createStoryboardImageNameAllocator([
    ...context.assets.flatMap((asset) => [asset.name, (asset.fileName || '').replace(/\.[^.]+$/u, '')]),
    ...(context.generationTaskNames || []),
  ]);
  return moments.map(({ shotId, purpose, frame }) => {
    const template = templates.get(shotId)!;
    const momentLines = purpose === 'first-frame' ? [
      '本张是视频首帧：只表现第一镜的开始或动作刚开始的状态。原镜完整动作描述只用于理解空间与身份，之后的动作结果、镜尾状态和后续事件尚未发生，不能提前画入首帧。',
    ] : purpose === 'last-frame' ? [
      '本张是视频尾帧：只表现最后一镜结束时的最终可见状态，保持原镜人物、衣着、物件、空间和机位；不自行续写下一动作或下一事件。',
    ] : frame ? [
      `本张是本段自定义 ${frame.imageFrameCount} 张分镜图片中的第 ${frame.imageFrameIndex} 张，只生成下面已选定的一张独立静帧。`,
      '已选静帧决定本张具体时刻；原镜完整过程和结果仅作为连续性背景，不能把多个时刻拼在一张图里。已确认 H3 的身份、空间、站位、朝向和机位事实仍然有效，不改写视频镜头、时长或对白。',
      line('已选定的本张静帧', imageExcerpt(frame.imageFrameDescription || '')),
      ...(frame.imageFrameTimeSec === undefined ? [] : [`本段画面时刻：${frame.imageFrameTimeSec} 秒，仅作静帧定位，不渲染时间文字。`]),
    ] : [];
    const request: DirectStoryboardImageRequest = {
      ...template, ...frame, purpose,
      name: allocateName(buildStoryboardImageBaseName(storyboard, template.shotIndex, purpose, context.projectName, frame)),
      assetType: purpose === 'storyboard-shot' ? 'reference' : purpose,
      assetRole: purpose === 'storyboard-shot' ? 'composition' : purpose,
      referenceRole: purpose === 'storyboard-shot' ? 'composition' : purpose,
      imageVariant: purpose === 'storyboard-shot' ? 'storyboard-frame' : purpose,
      referenceAssetIds: [...referenceAssetIds], primaryReferenceAssetIds: [...referenceAssetIds],
      directPrompt: [...momentLines, storyboardImageFramingInstruction(purpose), template.directPrompt].join('\n'),
      conversionSource: [...momentLines, storyboardImageFramingInstruction(purpose), template.conversionSource].join('\n'),
    };
    return request;
  });
};

const assertSelectedReferenceAssets = (
  storyboard: Storyboard, shot: VideoShot, selectedIds: readonly string[], context: StoryboardImageBuildContext,
): ReferenceAsset[] => {
  if (!selectedIds.length) throw new Error(`第 ${shot.index} 镜没有绑定参考图，请为该镜选择图片；不会改为文生图。`);
  const assets = new Map(context.assets.map((asset) => [asset.id, asset]));
  return selectedIds.map((id) => {
    const asset = assets.get(id);
    if (!asset || asset.missing) throw new Error(`第 ${shot.index} 镜参考图不存在或已丢失：${asset?.name || id}`);
    const assetName = asset.name;
    if (!hasUsableStoryboardReferencePixels(asset)) {
      throw new Error(`第 ${shot.index} 镜参考图不是可读取的 PNG/JPEG/WebP 图片：${assetName}`);
    }
    // Keep the existing per-shot private asset scope; do not infer new scope,
    // add profile data or silently drop an explicitly selected file.
    if (!canUseNsfwPrivateProfileAssetForStoryboardShot(asset, storyboard, shot, context.characters)) {
      throw new Error(`第 ${shot.index} 镜参考图“${asset.name}”不属于该镜现有私密资料使用范围；不会自动换图或少传图片。`);
    }
    return asset;
  });
};

/** Only explicit per-shot IDs enter the request. No global references,
 * character inference, identity enrichment or text-model call is involved. */
export const buildDirectStoryboardImageRequests = (
  storyboard: Storyboard,
  selection: DirectStoryboardImageSelection,
  context: DirectStoryboardImageBuildContext,
  size?: ResolvedImageOutputSize,
): DirectStoryboardImageRequest[] => {
  const selectedIds = ids(selection.shotIds);
  if (!selectedIds.length) throw new Error('请至少选择一个目标分镜。');
  const known = new Set(storyboard.shots.map((shot) => shot.id));
  const missing = selectedIds.find((id) => !known.has(id));
  if (missing) throw new Error(`所选目标分镜已不存在：${missing}，不会自动生成其它镜头。`);
  const output = size || resolveStoryboardImageOutputSize(defaultStoryboardImageOutputSize(), storyboard.aspectRatio, 'openai');
  if (output.issue || !Number.isInteger(output.width) || !Number.isInteger(output.height) || output.width < 1 || output.height < 1) {
    throw new Error(`分镜图片分辨率无效：${output.issue || '宽高必须为正整数'}`);
  }
  const allocateName = createStoryboardImageNameAllocator([
    ...context.assets.flatMap((asset) => [asset.name, (asset.fileName || '').replace(/\.[^.]+$/u, '')]),
    ...(context.generationTaskNames || []),
  ]);
  const selected = new Set(selectedIds);
  return storyboard.shots.filter((shot) => selected.has(shot.id)).map((shot) => {
    const referenceAssetIds = ids(selection.referenceAssetIdsByShotId[shot.id]);
    const assets = assertSelectedReferenceAssets(storyboard, shot, referenceAssetIds, context);
    const visual = directVisualSource(storyboard, shot);
    if (!visual.body) throw new Error(`第 ${shot.index} 镜没有现成的画面描述，请先生成或填写该镜内容。`);
    const cached = context.currentImagePromptsByShotId?.[shot.id];
    const reusable = cached && text(cached.prompt) && cached.sourceFingerprint === directStoryboardImageSourceFingerprint(
      storyboard, { shotId: shot.id, referenceAssetIds }, context,
    );
    const directPrompt = reusable ? cached.prompt : buildDirectStoryboardImagePromptWithReferences(
      [storyboardImageFramingInstruction('storyboard-shot'), visual.body].join('\n'), assets, context, context.includeReferenceMetadata,
    );
    return {
      purpose: 'storyboard-shot',
      name: allocateName(buildStoryboardImageBaseName(storyboard, shot.index, 'storyboard-shot', context.projectName)),
      storyboardId: storyboard.id, shotId: shot.id, shotIndex: shot.index,
      assetKind: 'storyboard', assetType: 'reference', assetRole: 'composition', referenceRole: 'composition',
      imageVariant: 'storyboard-frame',
      referenceAssetIds: [...referenceAssetIds], primaryReferenceAssetIds: [...referenceAssetIds],
      // Retained as provenance only. The direct path submits directPrompt.
      conversionSource: visual.body,
      directPrompt, directPromptSource: reusable ? 'current-image-prompt' : visual.source,
      width: output.width, height: output.height, sizeOverride: output.sizeOverride,
    };
  });
};

/** Capability checks only, before consuming a queued image-generation request. */
export const assertDirectStoryboardImageApiSupport = (config: ImageApiConfig, referenceCount: number): void => {
  if (!Number.isInteger(referenceCount) || referenceCount < 1) throw new Error('直接图生图必须提交至少一张真实参考图。');
  if (!config.enabled) throw new Error('尚未启用生图 API，无法提交直接图生图。');
  if (config.backend === 'novelai') {
    throw new Error('当前 NovelAI 接口未实现真实参考图输入，不能用于分镜图生图；不会退回文生图。');
  }
  if (config.backend === 'sd_webui' && referenceCount > 1) {
    throw new Error(`当前 SD WebUI 图生图接口只支持一张输入底图，不支持将 ${referenceCount} 张图共同作为人物参考；请换用支持多图的接口或工作流。`);
  }
  if (config.backend === 'comfyui') {
    // Match requestImageModel's workflow choice exactly, including old configs.
    // Preflight must not normalize to a different, apparently capable workflow.
    const workflowJson = config.comfyuiWorkflows?.find((item) => item.id === config.activeComfyuiWorkflowId)?.workflowJson?.trim()
      || config.workflowJson?.trim() || '';
    assertComfyUIWorkflowCanBindReferenceImages(workflowJson, referenceCount);
  }
};

/** Every bound asset must resolve. Preserve distinct selected IDs even when two
 * assets happen to contain the same pixels; never silently reduce the count. */
export const resolveDirectStoryboardReferenceImages = async (
  referenceAssetIds: readonly string[],
  assets: readonly ReferenceAsset[],
  loader: StoryboardReferenceImageLoader,
  cache = new Map<string, Promise<string>>(),
): Promise<string[]> => {
  const selectedIds = ids(referenceAssetIds);
  if (!selectedIds.length) throw new Error('直接图生图没有可读取的参考图，不会改为文生图。');
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return Promise.all(selectedIds.map(async (id) => {
    const asset = byId.get(id);
    const assetName = asset?.name || id;
    if (!hasUsableStoryboardReferencePixels(asset)) throw new Error(`参考图不存在、不是图片或已无法读取：${assetName}`);
    const result = await resolveStoryboardReferenceImages([id], assets, loader, cache);
    if (result.length !== 1) throw new Error(`参考图读取数量异常：${asset.name}，不会少传图片。`);
    return result[0];
  }));
};

import type { PromptReferenceInput } from './promptAdapters';
import type { Location, ReferenceAsset, Scene, Storyboard } from './types';

/** Request-only public scene evidence. Never carries media URLs, credentials,
 * generated prompts, task payloads or an inferred metric layout. */
export interface VideoSceneContext {
  kind: 'video-scene-context-v1';
  usage: 'understanding-only';
  locationSelection: 'linked-locations' | 'chapter-candidates' | 'project-candidates';
  locations: Array<Pick<Location, 'id' | 'name' | 'description' | 'fixedProps' | 'anchor' | 'lighting'> & { aliases?: string[] }>;
  scenes: Array<{ id: string; title: string; content: string; locationIds: string[] }>;
  references: Array<{
    id: string; name: string; mediaType?: string; role?: string; responsibility: string;
    locationId?: string; boundary?: 'first-frame' | 'last-frame';
    sourceStoryboardId?: string; sourceShotId?: string; sourceVideoAssetId?: string;
    sourceTimeSec?: number; imageFrameTimeSec?: number;
  }>;
}

export interface BuildVideoSceneContextInput {
  locations?: readonly Location[];
  scenes?: readonly Scene[];
  assets?: readonly ReferenceAsset[];
  board?: Storyboard;
  sourceSceneIds?: readonly string[];
  selectedAssetIds?: readonly string[];
  references?: readonly PromptReferenceInput[];
  chapterId?: string;
}

export const VIDEO_SCENE_CONTEXT_RULE = [
  'sceneContext是只读场地及参考职责资料，不是增加剧情或强制入画的清单。linked-locations来自当前场景或实际选中场景参考的明确关联；chapter/project-candidates只供你阅读全文后判断本段对应场地，不能把所有候选拼成同一空间或新增换场。',
  '结合当前原文、关联场地description/fixedProps/anchor、已确认镜头空间和真实附图确定同一可通行布局；人物身高、通道净宽、武器够及范围、门槛和固定障碍彼此协调。高柱或远景构图不等于两人间距很远，没有可靠比例尺的图不能推定精确米数；未提供尺寸时用有依据且前后一致的相对尺度，不能每镜重新编造距离。',
  '参考role/responsibility只规定素材职责。人物身份图不规定每镜正面朝镜头；场景图不授权新增剧情；首尾帧的boundary与sourceVideoAssetId/sourceTimeSec仅说明真实衔接来源，不把已结束动作或台词重新演一次。仅在请求确实附图片像素时描述观察结果，只有文字资料时不声称已看到图片。',
  '资料只辅助当前生成权限；用户修改正文、已确认排时和本次修复范围优先，英文阶段仅忠实保留最终中文布局与动作，不利用场地资料重新导演。',
].join('\n');

export const buildVideoSceneContext = (input: BuildVideoSceneContextInput): VideoSceneContext => {
  const board = input.board;
  const sceneIds = new Set(input.sourceSceneIds ?? [board?.sceneId, ...(board?.sourceSceneIds ?? [])].filter((id): id is string => Boolean(id)));
  const scenes = (input.scenes ?? board?.sourceSceneSnapshots ?? []).filter((scene) => sceneIds.has(scene.id));
  const assetIds = new Set(input.selectedAssetIds ?? [
    ...(board?.globalReferenceAssetIds ?? []), ...(board?.shots.flatMap((shot) => shot.referenceAssetIds ?? []) ?? []),
    board?.firstFrameAssetId, board?.lastFrameAssetId,
  ].filter((id): id is string => Boolean(id)));
  for (const reference of input.references ?? []) if (reference.id) assetIds.add(reference.id);
  const assets = (input.assets ?? []).filter((asset) => assetIds.has(asset.id));
  const linkedLocationIds = new Set(scenes.flatMap((scene) => [...(scene.locationIds ?? []), ...(scene.locationId ? [scene.locationId] : [])]));
  const knownLocations = input.locations ?? [];
  const locationIdForAsset = (asset: ReferenceAsset): string | undefined => {
    if (asset.referenceEntityBinding !== undefined) {
      const binding = asset.referenceEntityBinding;
      return binding?.kind === 'location' && knownLocations.filter((location) => location.id === binding.entityId).length === 1
        ? binding.entityId : undefined;
    }
    return asset.sourceEntityKind === 'location' ? asset.sourceEntityId : undefined;
  };
  for (const asset of assets) {
    const locationId = locationIdForAsset(asset);
    if (locationId) linkedLocationIds.add(locationId);
  }
  const legacyAssetIds = new Set([...assetIds].filter((id) => assets.find((asset) => asset.id === id)?.referenceEntityBinding === undefined));
  const linkedLocations = knownLocations.filter((location) => linkedLocationIds.has(location.id)
    || location.assetIds.some((id) => legacyAssetIds.has(id)));
  const chapterLocations = input.chapterId
    ? knownLocations.filter((location) => !location.sourceChapterIds?.length || location.sourceChapterIds.includes(input.chapterId!)) : [];
  const selectedLocations = linkedLocations.length ? linkedLocations : input.chapterId ? chapterLocations : knownLocations;
  const referenceById = new Map((input.references ?? []).flatMap((reference) => reference.id ? [[reference.id, reference] as const] : []));
  const allReferenceIds = [...new Set([...assets.map((asset) => asset.id), ...referenceById.keys()])];
  return {
    kind: 'video-scene-context-v1', usage: 'understanding-only',
    locationSelection: linkedLocations.length ? 'linked-locations' : input.chapterId ? 'chapter-candidates' : 'project-candidates',
    locations: selectedLocations.map((location) => ({
      id: location.id, name: location.name, description: location.description,
      fixedProps: location.fixedProps, anchor: location.anchor, lighting: location.lighting,
      ...(location.aliases?.length ? { aliases: [...location.aliases] } : {}),
    })),
    scenes: scenes.map((scene) => ({ id: scene.id, title: scene.title, content: scene.content,
      locationIds: [...new Set([...(scene.locationIds ?? []), ...(scene.locationId ? [scene.locationId] : [])])] })),
    references: allReferenceIds.map((id) => {
      const asset = assets.find((item) => item.id === id);
      const reference = referenceById.get(id);
      const locationId = asset && locationIdForAsset(asset);
      const binding = asset?.referenceEntityBinding;
      return {
        id, name: reference?.name || asset?.name || id,
        mediaType: reference?.mediaType || asset?.mediaType,
        role: binding ? binding.kind === 'location' ? 'scene' : binding.kind
          : reference?.referenceRole || reference?.role || asset?.referenceRole || asset?.role,
        responsibility: reference?.responsibility || reference?.description || asset?.visualAnchor || '',
        ...(locationId ? { locationId } : {}),
        ...(id === board?.firstFrameAssetId ? { boundary: 'first-frame' as const }
          : id === board?.lastFrameAssetId ? { boundary: 'last-frame' as const } : {}),
        ...(asset?.sourceStoryboardId ? { sourceStoryboardId: asset.sourceStoryboardId } : {}),
        ...(asset?.sourceShotId ? { sourceShotId: asset.sourceShotId } : {}),
        ...(asset?.sourceVideoAssetId ? { sourceVideoAssetId: asset.sourceVideoAssetId } : {}),
        ...(asset?.sourceTimeSec !== undefined ? { sourceTimeSec: asset.sourceTimeSec } : {}),
        ...(asset?.imageFrameTimeSec !== undefined ? { imageFrameTimeSec: asset.imageFrameTimeSec } : {}),
      };
    }),
  };
};

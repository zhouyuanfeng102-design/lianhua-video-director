import type { Project, Storyboard } from './types';
import { detachDeletedStoryReferenceAsset } from './storyReferences';

/**
 * Locate current video references and saved delivery provenance. A match is
 * not permission to rebuild authored prompts: generated images may be bound
 * back to their source shots without becoming new video source material.
 */
export const storyboardReferencesAsset = (board: Storyboard, assetId: string): boolean => Boolean(
  assetId && (
    board.shots.some((shot) => shot.referenceAssetIds.includes(assetId))
    || board.globalReferenceAssetIds?.includes(assetId)
    || board.promptTrace?.referenceAssetIds.includes(assetId)
    || board.promptPlan?.referenceAssetIds.includes(assetId)
    || board.targetOutput?.referenceManifest.some((reference) => (
      reference.id === assetId || reference.assetId === assetId
    ))
    || board.firstFrameAssetId === assetId
    || board.lastFrameAssetId === assetId
    || board.audioLedger?.some((cue) => cue.sourceAssetId === assetId)
  )
);

const withoutAssetId = (ids: string[], assetId: string): string[] => (
  ids.includes(assetId) ? ids.filter((id) => id !== assetId) : ids
);

/** Remove live media bindings while retaining every authored delivery and its
 * exact source identity. Prompt plans, manifests, traces, revisions and task
 * snapshots describe saved work, not editable media selection lists. */
const unbindStoryboardAsset = (
  board: Storyboard,
  assetId: string,
  updatedAt: number,
): Storyboard => {
  const shots = board.shots.map((shot) => {
    const referenceAssetIds = withoutAssetId(shot.referenceAssetIds, assetId);
    return referenceAssetIds === shot.referenceAssetIds ? shot : { ...shot, referenceAssetIds };
  });
  const shotsChanged = shots.some((shot, index) => shot !== board.shots[index]);
  const globalReferenceAssetIds = board.globalReferenceAssetIds
    && withoutAssetId(board.globalReferenceAssetIds, assetId);
  const audioLedger = board.audioLedger?.map((cue) => {
    if (cue.sourceAssetId !== assetId) return cue;
    const { sourceAssetId: _sourceAssetId, ...unboundCue } = cue;
    return unboundCue;
  });
  const audioChanged = audioLedger?.some((cue, index) => cue !== board.audioLedger?.[index]);
  let imageToImage = board.imageToImage;
  if (imageToImage) {
    const referenceAssetIds = withoutAssetId(imageToImage.referenceAssetIds, assetId);
    const bindings = Object.entries(imageToImage.referenceAssetIdsByShotId).map(([shotId, ids]) => (
      [shotId, withoutAssetId(ids, assetId)] as const
    ));
    const bindingsChanged = bindings.some(([shotId, ids]) => ids !== imageToImage!.referenceAssetIdsByShotId[shotId]);
    if (referenceAssetIds !== imageToImage.referenceAssetIds || bindingsChanged) {
      imageToImage = {
        ...imageToImage,
        referenceAssetIds,
        referenceAssetIdsByShotId: bindingsChanged
          ? Object.fromEntries(bindings)
          : imageToImage.referenceAssetIdsByShotId,
      };
    }
  }
  const removesFirstFrame = board.firstFrameAssetId === assetId;
  const removesLastFrame = board.lastFrameAssetId === assetId;
  if (!shotsChanged
    && globalReferenceAssetIds === board.globalReferenceAssetIds
    && !audioChanged
    && imageToImage === board.imageToImage
    && !removesFirstFrame
    && !removesLastFrame) return board;

  const result: Storyboard = {
    ...board,
    ...(shotsChanged ? { shots } : {}),
    ...(globalReferenceAssetIds !== board.globalReferenceAssetIds ? { globalReferenceAssetIds } : {}),
    ...(audioChanged ? { audioLedger } : {}),
    ...(imageToImage !== board.imageToImage ? { imageToImage } : {}),
    updatedAt,
  };
  if (removesFirstFrame) delete result.firstFrameAssetId;
  if (removesLastFrame) delete result.lastFrameAssetId;
  return result;
};

/** Asset deletion is a media operation, never a prompt regeneration operation.
 * Genuine missing input references are handled separately by submission checks;
 * retaining their saved provenance lets those checks explain the missing media
 * without replacing Chinese/English text or discarding complete segments. */
export const deleteAssetFromProject = (
  project: Project,
  assetId: string,
  updatedAt = Date.now(),
): Project => {
  if (!project.assets.some((asset) => asset.id === assetId)) return project;
  const unbindEntities = <T extends { assetIds: string[] }>(entities: T[]): T[] => {
    const mapped = entities.map((entity) => {
      const assetIds = withoutAssetId(entity.assetIds, assetId);
      return assetIds === entity.assetIds ? entity : { ...entity, assetIds };
    });
    return mapped.some((entity, index) => entity !== entities[index]) ? mapped : entities;
  };
  const storyboards = project.storyboards.map((board) => unbindStoryboardAsset(board, assetId, updatedAt));
  const presets = project.voicePresets;
  const removesVoicePreset = presets && (Object.values(presets.characters).some((preset) => preset.assetId === assetId)
    || presets.narrator?.assetId === assetId);
  const voicePresets = removesVoicePreset ? {
    ...presets,
    characters: Object.fromEntries(Object.entries(presets.characters).filter(([, preset]) => preset.assetId !== assetId)),
    ...(presets.narrator?.assetId === assetId ? { narrator: undefined } : {}),
  } : presets;
  return detachDeletedStoryReferenceAsset({
    ...project,
    assets: project.assets.filter((asset) => asset.id !== assetId),
    characters: unbindEntities(project.characters),
    locations: unbindEntities(project.locations),
    props: unbindEntities(project.props),
    storyboards: storyboards.some((board, index) => board !== project.storyboards[index])
      ? storyboards
      : project.storyboards,
    ...(removesVoicePreset ? { voicePresets } : {}),
    updatedAt,
  }, assetId, updatedAt);
};

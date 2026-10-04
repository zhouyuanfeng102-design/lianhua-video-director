import type { Project, ReferenceAsset } from './types';
import type { VideoGenerationDraft, VideoGenerationSnapshot, VideoImageReference } from './videoGenerationTypes';
import { frozenVideoReferenceAsset } from './videoProvenance';
import { addVideoDraftAssets, isVideoDirectorImage } from './videoDirectorDraft';
import { removeVideoReference, videoReferenceSelection } from './videoReferenceSlots';

/** The thumbnail must represent the same frozen bytes the engine will submit. */
export const videoDraftReferenceAsset = (
  project: Pick<Project, 'assets'>,
  reference: VideoImageReference,
  reusedSnapshot?: VideoGenerationSnapshot,
): ReferenceAsset | undefined => {
  const frozen = reusedSnapshot?.images.find((image) => image.assetId === reference.assetId);
  return frozen ? frozenVideoReferenceAsset(frozen) : project.assets.find((asset) => asset.id === reference.assetId && isVideoDirectorImage(asset));
};

/** Confirming the library picker explicitly switches to today's selected
 * pictures; do not let the old same-ID snapshot silently override this choice. */
export const useCurrentVideoDraftImages = (
  draft: VideoGenerationDraft, assetIds: string[], assets: ReferenceAsset[],
): VideoGenerationDraft => {
  const selected = assetIds.filter((id) => assets.some((asset) => asset.id === id && isVideoDirectorImage(asset)));
  let selection = videoReferenceSelection(draft.references, draft.referenceSlotRoles);
  for (const reference of draft.references) if (!selected.includes(reference.assetId)) selection = removeVideoReference(selection, reference.assetId);
  return addVideoDraftAssets({ ...draft, reuseTaskId: undefined, ...selection }, selected, assets);
};

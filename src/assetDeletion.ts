import type { Storyboard } from './types';

/**
 * Only a current reference can make deletion invalidate a storyboard. Entity
 * asset libraries and saved revisions are not automatic bindings: prompt
 * compilation intersects entity asset IDs with this board's selected assets.
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

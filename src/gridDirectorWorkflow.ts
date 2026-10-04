import { hasUsableStoryboardReferencePixels } from './storyboardImages';
import type { InputMode, ReferenceAsset, Workflow } from './types';

export interface GridDirectorPreflightInput {
  workflow: Workflow;
  inputMode: InputMode;
  selectedAssetIds: readonly string[];
  assets: readonly ReferenceAsset[];
}

export interface GridDirectorPreflightResult {
  normalizedInputMode: InputMode;
  ready: boolean;
  selectedGridAsset?: ReferenceAsset;
  reason?: string;
}

/** A grid workflow always needs both story text and an actual grid master. */
export const normalizeGridDirectorInputMode = (
  workflow: Workflow,
  inputMode: InputMode,
): InputMode => workflow === 'grid' && inputMode === 'text'
  ? 'text_reference'
  : inputMode;

/**
 * Resolve the selected grid master before any director/model work starts.
 * Non-grid workflows deliberately pass through without imposing grid rules.
 */
export const resolveGridDirectorPreflight = ({
  workflow,
  inputMode,
  selectedAssetIds,
  assets,
}: GridDirectorPreflightInput): GridDirectorPreflightResult => {
  const normalizedInputMode = normalizeGridDirectorInputMode(workflow, inputMode);
  if (workflow !== 'grid') return { normalizedInputMode, ready: true };

  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const selectedGridAssets = selectedAssetIds
    .map((id) => assetsById.get(id))
    .filter((asset): asset is ReferenceAsset => asset?.role === 'grid');
  const usableGridAsset = selectedGridAssets.find(hasUsableStoryboardReferencePixels);

  if (usableGridAsset) {
    return {
      normalizedInputMode,
      ready: true,
      selectedGridAsset: usableGridAsset,
    };
  }

  const selectedGridAsset = selectedGridAssets[0];
  if (selectedGridAsset) {
    return {
      normalizedInputMode,
      ready: false,
      selectedGridAsset,
      reason: '已绑定的九宫格母版没有可用图像，请重新生成、上传或修复该图片后再试。',
    };
  }

  return {
    normalizedInputMode,
    ready: false,
    reason: '九宫格视频需要先在图像工作台生成或上传九宫格母版，并将它绑定到导演台。',
  };
};

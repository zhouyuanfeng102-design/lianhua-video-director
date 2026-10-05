import type { ImageAssetRegenerationSnapshot, ImageGenerationTask, ReferenceAsset } from './types';
import { normalizeImageApiSnapshot } from './imageApiSelection';
import { normalizeImageReferenceAssetSnapshots } from './imageGeneration';

/** Only safe small fields survive import. The separate asset mode marker is
 * retained by storage even when this returns undefined, preventing fallback. */
export const normalizeImageAssetRegenerationSnapshot = (value: unknown): ImageAssetRegenerationSnapshot | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.model !== 'string'
    || !Array.isArray(record.referenceAssetSnapshots) || !record.referenceAssetSnapshots.length) return undefined;
  const imageApiSnapshot = normalizeImageApiSnapshot(record.imageApiSnapshot);
  const referenceAssetSnapshots = normalizeImageReferenceAssetSnapshots(record.referenceAssetSnapshots);
  if (!imageApiSnapshot?.config.enabled || !imageApiSnapshot.connectionFingerprint
    || !imageApiSnapshot.executionFingerprint || referenceAssetSnapshots.length !== record.referenceAssetSnapshots.length) return undefined;
  // SD WebUI may deliberately omit a model to use the server's current
  // checkpoint. Preserve that request rather than inventing a model label.
  if (!record.model.trim() && imageApiSnapshot.config.backend !== 'sd_webui') return undefined;
  const optional = (field: 'sourceFingerprint' | 'regenerationRootTaskId' | 'regenerationBaseName') => (
    typeof record[field] === 'string' && record[field].trim() ? { [field]: record[field] } : {}
  );
  return {
    version: 1, model: record.model, imageApiSnapshot, referenceAssetSnapshots,
    ...optional('sourceFingerprint'), ...optional('regenerationRootTaskId'), ...optional('regenerationBaseName'),
  };
};

/** The original and every regenerated result carry the same frozen inputs.
 * Pixels/URLs/workflows/API keys are never copied into this snapshot. */
export const withDirectImageRegenerationSnapshot = (asset: ReferenceAsset, task: ImageGenerationTask): ReferenceAsset => {
  if (task.imageGenerationMode !== 'image-to-image' || task.assetKind !== 'storyboard') return asset;
  const snapshot = normalizeImageAssetRegenerationSnapshot({
    version: 1, model: task.model, imageApiSnapshot: task.imageApiSnapshot,
    referenceAssetSnapshots: task.referenceAssetSnapshots, sourceFingerprint: task.sourceFingerprint,
    regenerationRootTaskId: task.regenerationRootTaskId || task.id,
    regenerationBaseName: task.regenerationBaseName || task.name,
  });
  if (!snapshot || !task.prompt.trim()
    || snapshot.referenceAssetSnapshots.map((reference) => reference.id).join('\u0000') !== (task.referenceAssetIds || []).join('\u0000')) {
    throw new Error('图生图原任务的参考图或 API 快照不完整，无法保存可安全重试的结果资料；不会使用当前图片或配置代替。');
  }
  return {
    ...asset, imageGenerationMode: 'image-to-image', imageRegenerationSnapshot: snapshot,
    prompt: task.prompt, negativePrompt: task.negativePrompt, imageBackend: task.backend,
    imagePromptRuleSetId: task.imagePromptRuleSetId, imagePromptRuleSetVersion: task.imagePromptRuleSetVersion,
    imagePromptRuleSetName: task.imagePromptRuleSetName,
    imagePromptPresetId: task.imagePromptPresetId, imagePromptPresetVersion: task.imagePromptPresetVersion,
    imagePromptPresetName: task.imagePromptPresetName,
    imagePromptFormat: task.imagePromptFormat, imageVariant: task.imageVariant,
    imageRequestSize: { width: task.width, height: task.height, ...(task.sizeOverride === undefined ? {} : { sizeOverride: task.sizeOverride }) },
    sourceStoryboardId: task.sourceStoryboardId, sourceShotId: task.sourceShotId,
    imageFrameBatchId: task.imageFrameBatchId, imageFrameIndex: task.imageFrameIndex,
    imageFrameCount: task.imageFrameCount, imageFrameDescription: task.imageFrameDescription, imageFrameTimeSec: task.imageFrameTimeSec,
  };
};

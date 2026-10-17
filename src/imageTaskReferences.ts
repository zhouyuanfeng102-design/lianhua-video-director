import type { ImageGenerationTask, ReferenceAsset } from './types';

/** Saved snapshots own historical names; current assets only label ID-only history. */
export function imageTaskReferenceNames(task: ImageGenerationTask, assets: readonly ReferenceAsset[]): string[] {
  const snapshots = task.referenceAssetSnapshots || [];
  const savedIds = task.referenceAssetIds?.filter((id) => id.trim()) || [];
  const primaryIds = task.primaryReferenceAssetIds?.filter((id) => id.trim()) || [];
  // Primary selections may predate converter filtering; never append them to
  // the final submitted list. A snapshot records the actual frozen input order.
  const ids = Array.from(new Set(snapshots.length ? snapshots.map((asset) => asset.id)
    : savedIds.length ? savedIds : primaryIds));
  return ids.map((id) => snapshots.find((asset) => asset.id === id)?.name.trim()
    || assets.find((asset) => asset.id === id)?.name.trim()
    || `名称未记录（${id}）`);
}

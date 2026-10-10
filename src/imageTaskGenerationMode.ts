import type { ImageGenerationTask } from './types';

type ImageInputMode = 'text-to-image' | 'image-to-image';
type TaskInputs = Pick<ImageGenerationTask, 'imageInputMode' | 'imageGenerationMode' | 'referenceAssetIds' | 'primaryReferenceAssetIds' | 'referenceAssetSnapshots'>;

/** Read only saved task inputs; the current library is unrelated to historical mode. */
export const imageTaskGenerationMode = (task: TaskInputs): ImageInputMode | undefined => {
  if (task.imageInputMode === 'text-to-image' || task.imageInputMode === 'image-to-image') return task.imageInputMode;
  const hasReferences = [task.referenceAssetIds, task.primaryReferenceAssetIds]
    .some((ids) => ids?.some((id) => typeof id === 'string' && Boolean(id.trim())))
    || task.referenceAssetSnapshots?.some((asset) => typeof asset?.id === 'string' && Boolean(asset.id.trim()));
  if (hasReferences || task.imageGenerationMode === 'image-to-image') return 'image-to-image';
  // An empty saved input list records text-only input. Missing history does not.
  if (Array.isArray(task.referenceAssetIds) || Array.isArray(task.referenceAssetSnapshots)
    || task.imageGenerationMode === 'text-to-image') return 'text-to-image';
  return undefined;
};

export const imageTaskGenerationModeLabel = (mode: ImageInputMode | undefined): string => mode === 'image-to-image'
  ? '图生图' : mode === 'text-to-image' ? '文生图' : '方式未记录';

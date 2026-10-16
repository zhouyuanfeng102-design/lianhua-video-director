import type { StoryboardImageBuildContext, StoryboardReferenceImageLoader, StoryboardReferenceInputs } from './storyboardImages';
import { mergeStoryboardReferenceInputs, resolveStoryboardReferenceInputs } from './storyboardImages';
import { supplementStoryboardImageCharacterReferences } from './storyboardImageCharacterReferences';

/** Resolve identity images named by the converted picture, after the original
 * selection was loaded. Original primary slots retain priority and order. */
export const completeStoryboardImageReferenceInputs = async (
  prompt: string,
  references: StoryboardReferenceInputs & { primaryReferenceImageCount: number },
  context: Pick<StoryboardImageBuildContext, 'assets' | 'characters'>,
  loader: StoryboardReferenceImageLoader,
  cache?: Map<string, Promise<string>>,
): Promise<StoryboardReferenceInputs & { primaryReferenceImageCount: number }> => {
  const existingIds = references.referenceAssets.map((asset) => asset.id);
  const completedIds = supplementStoryboardImageCharacterReferences(prompt, existingIds, context);
  const additions = completedIds.filter((id) => !existingIds.includes(id));
  if (!additions.length) return references;
  const extra = await resolveStoryboardReferenceInputs(additions, context.assets, loader, cache);
  const count = references.primaryReferenceImageCount;
  return mergeStoryboardReferenceInputs({
    referenceImages: references.referenceImages.slice(0, count),
    referenceAssets: references.referenceAssets.slice(0, count),
  }, {
    referenceImages: [...references.referenceImages.slice(count), ...extra.referenceImages],
    referenceAssets: [...references.referenceAssets.slice(count), ...extra.referenceAssets],
  });
};

import type { ChapterWorkspace } from './types';

/** Input controls become a story source only while at least one image is enabled. */
export const hasStoryReferenceSource = (workspace: ChapterWorkspace): boolean => workspace.storyInputMode === 'image'
  && (workspace.storyReferences ?? []).some((reference) => reference.enabled);

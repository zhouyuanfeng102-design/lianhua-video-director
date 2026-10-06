import type { Project, StoryVisualConversionSnapshot } from './types';

/** Only the exact adopted draft in its owning chapter may lend an original.
 * A similar title, a character name or another chapter is never evidence. */
export const matchingStoryVisualConversion = (
  project: Pick<Project, 'storyVisualConversions'>,
  chapterId: string | undefined,
  story: string,
): StoryVisualConversionSnapshot | undefined => {
  if (!chapterId || !story.trim()) return undefined;
  return project.storyVisualConversions?.filter((entry) => entry.chapterId === chapterId
    && entry.sourceText.trim() && entry.resultText.trim() === story.trim())
    .reduce<StoryVisualConversionSnapshot | undefined>((latest, entry) => (
      !latest || entry.createdAt >= latest.createdAt ? entry : latest
    ), undefined);
};

/** Called only after the user adopts the result. Keep the untrimmed input and
 * returned text so review and restore never fabricate an earlier manuscript. */
export const rememberStoryVisualConversion = (
  project: Project,
  snapshot: StoryVisualConversionSnapshot,
): Project => ({
  ...project,
  updatedAt: snapshot.createdAt,
  storyVisualConversions: [
    ...(project.storyVisualConversions || []).filter((entry) => entry.id !== snapshot.id),
    { ...snapshot },
  ],
});

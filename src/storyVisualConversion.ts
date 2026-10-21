import type { AppState, Project, StoryVisualConversionSnapshot } from './types';
import { sourceContentHash } from './sourceContentHash';
import { STORY_VISUAL_ENGINE_VERSION, type StoryVisualDetailMode } from './storyVisualAction';

/** Preview reuse and adoption have the same dependencies as a fresh request. */
export const storyVisualPreparationFingerprint = (
  state: Pick<AppState, 'settings' | 'storyExpansionPresets' | 'project'>,
  detailMode: StoryVisualDetailMode,
): string => {
  const preset = state.storyExpansionPresets.find((item) => (
    item.id === state.settings.defaultStoryExpansionPresetId && item.enabled
  )) || state.storyExpansionPresets.find((item) => item.enabled);
  return sourceContentHash(JSON.stringify({
    engineVersion: STORY_VISUAL_ENGINE_VERSION, detailMode,
    api: state.settings.textApi, preset: preset || null,
    characters: state.project.characters, locations: state.project.locations, props: state.project.props,
  }));
};

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

/** Follow only an explicit adopted-draft lineage. Edited text is a new source,
 * so a user's manual changes are never silently replaced with an old novel. */
export const storyVisualOriginalSource = (
  project: Pick<Project, 'storyVisualConversions'>, chapterId: string | undefined, story: string,
): string => {
  let source = story;
  const visited = new Set<string>();
  for (let entry = matchingStoryVisualConversion(project, chapterId, source); entry && !visited.has(entry.id);
    entry = matchingStoryVisualConversion(project, chapterId, source)) {
    visited.add(entry.id);
    source = entry.sourceText;
  }
  return source;
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
    structuredClone(snapshot),
  ],
});

import type { OfficialH3ProjectContext } from './officialPrompt';
import { isSemanticSequencePlan, semanticSequenceCharacters } from './semanticSequencePlan';
import type { Project, Storyboard } from './types';

/** Generation, display, selection and submission must validate the same source.
 * Semantic sequences own frozen public character facts and segment-local text;
 * live same-ID media/private bindings still follow semanticSequenceCharacters.
 * Legacy and standalone boards keep their existing live scene context. */
export const officialH3ContextForStoryboard = (
  project: Pick<Project, 'assets' | 'characters' | 'locations' | 'props' | 'scenes'> & Partial<Pick<Project, 'sequencePlans'>>,
  storyboard?: Pick<Storyboard, 'sceneId'> & Partial<Pick<Storyboard, 'sequencePlanId' | 'sourceStoryContent'>>,
): OfficialH3ProjectContext => {
  const plan = storyboard?.sequencePlanId
    ? project.sequencePlans?.find((candidate) => candidate.id === storyboard.sequencePlanId) : undefined;
  return {
    assets: project.assets,
    characters: semanticSequenceCharacters(plan, project.characters.filter((character) => !character.dossier?.archivedIntoCharacterId)),
    locations: project.locations,
    props: project.props,
    sceneContent: isSemanticSequencePlan(plan) ? storyboard?.sourceStoryContent : storyboard
      ? project.scenes.find((scene) => scene.id === storyboard.sceneId)?.content
      : undefined,
  };
};

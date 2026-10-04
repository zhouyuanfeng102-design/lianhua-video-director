import type { Scene, VideoSegment, VideoSequencePlan } from './types';

export interface DirectorLookSourceInput {
  productionMode: 'single' | 'sequence';
  sequenceSettingsOpen: boolean;
  plan?: Pick<VideoSequencePlan, 'id' | 'sourceStoryTitle' | 'sourceStoryContent'>;
  segment?: Pick<VideoSegment, 'id' | 'title' | 'content'>;
  sourceScenes: readonly Pick<Scene, 'title' | 'content'>[];
  storyInput: string;
  storyName: string;
  sceneTitle?: string;
}

/** Full-film settings use the full story, not the currently selected segment. */
export function directorLookSource(input: DirectorLookSourceInput): { title: string; story: string; scope: string } {
  if (input.productionMode === 'sequence' && !input.sequenceSettingsOpen && input.segment) {
    return { title: input.segment.title, story: input.segment.content, scope: `segment:${input.plan?.id || ''}:${input.segment.id}` };
  }
  if (input.productionMode === 'sequence' && input.plan) {
    return { title: input.plan.sourceStoryTitle, story: input.plan.sourceStoryContent, scope: `film:${input.plan.id}` };
  }
  return {
    title: input.storyName.trim() || input.sceneTitle || '当前剧情',
    story: input.sourceScenes.length
      ? input.sourceScenes.map((scene) => `【${scene.title}】\n${scene.content}`).join('\n\n')
      : input.storyInput,
    scope: input.productionMode === 'sequence' ? 'film:new' : 'single',
  };
}

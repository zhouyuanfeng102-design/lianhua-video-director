import { buildOfficialH3CompileInput, buildOfficialH3References, buildOfficialH3SubjectDefinitions } from './officialPrompt';
import { officialH3ContextForStoryboard } from './officialH3Context';
import { getOfficialSeedanceSourceFingerprint, type OfficialSeedancePromptInput } from './seedancePrompt';
import { getVideoPromptInstructionLeak } from './videoPromptInstructionLeak';
import type { Project, Storyboard } from './types';

/** Generation, copying and video source selection share this exact evidence snapshot. */
export const buildOfficialSeedanceInput = (project: Project, board: Storyboard): OfficialSeedancePromptInput => {
  const context = officialH3ContextForStoryboard(project, board);
  const references = buildOfficialH3References(board, context.assets, context.characters).map((reference) => {
    // Binary data belongs to the media transport. The writer consumes complete
    // recognized text facts, identities and checksum metadata, not base64 blobs.
    const evidence = Object.fromEntries(Object.entries(reference).filter(([key]) => !/dataUrl$/iu.test(key)));
    return { ...evidence, tags: reference.tags || [], targetBindings: reference.targetBindings || [] } as typeof reference;
  });
  return {
    canonicalPrompt: board.promptPlan?.canonicalPrompt || board.finalPrompt,
    durationSec: board.promptPlan?.durationSec || board.durationSec,
    aspectRatio: board.promptPlan?.aspectRatio || board.aspectRatio,
    resolution: board.promptPlan?.resolution || board.resolution,
    audioMode: board.promptPlan?.audioMode || board.audioMode,
    references,
    subjectDefinitions: buildOfficialH3SubjectDefinitions(board, context, references),
    shotPrivateDetails: buildOfficialH3CompileInput(board, context).shotPrivateDetails,
    detailMode: 'director', targetId: 'seedance-2.5',
    constraints: board.promptPlan?.constraints || [board.globalLock, board.extraRequirement ? `制作要求：${board.extraRequirement}` : ''].filter(Boolean),
    sourceEvidence: {
      sourceStoryContent: board.sourceStoryContent || context.sceneContent || '',
      sourceSceneSnapshots: (board.sourceSceneSnapshots || []).map((scene) => ({ id: scene.id, title: scene.title, content: scene.content })),
      shots: board.shots.map((shot) => ({ ...shot, referenceAssetIds: shot.referenceAssetIds || [], prompt: shot.prompt || '' })),
      shotMode: board.shotMode,
      shotCount: board.shotCount,
      confirmedShotCount: board.shots.length,
      creativeDirection: board.creativeDirection,
      directorStyleSummary: board.directorStyleSummary,
      visualStyle: board.visualStyle,
      extraRequirement: board.extraRequirement,
    },
  };
};

export const hasCurrentSeedancePrompt = (project: Project, board: Storyboard, language: 'zh' | 'en' = 'zh'): boolean => {
  const output = board.seedance25Output;
  if (board.sourceStale || !output?.promptZh || getVideoPromptInstructionLeak(output.promptZh)
    || output.sourceFingerprint !== getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board))) return false;
  return language === 'zh' || Boolean(output.promptEn && output.englishSourceFingerprint === output.sourceFingerprint
    && !getVideoPromptInstructionLeak(output.promptEn));
};

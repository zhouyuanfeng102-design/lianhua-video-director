import { buildOfficialH3CompileInput, buildOfficialH3References, buildOfficialH3SubjectDefinitions } from './officialPrompt';
import { officialH3ContextForStoryboard } from './officialH3Context';
import { getOfficialSeedanceSourceFingerprint, hasMatchingSeedanceSourceFingerprint, type OfficialSeedancePromptInput } from './seedancePrompt';
import { getVideoPromptInstructionLeak } from './videoPromptInstructionLeak';
import { isSemanticSequencePlan, semanticSegmentSourceContext, semanticSegmentStoryContent } from './semanticSequencePlan';
import type { Project, Storyboard } from './types';
import { buildVideoSceneContext } from './videoSceneContext';
import { characterVoiceIdentityFacts, currentCharacterVoiceFacts } from './characterVoiceFacts';

/** Only the exact board/segment binding may contribute assigned action facts.
 * Older boards retain their own saved source when a plan has since been edited. */
const currentSemanticSourceContext = (project: Project, board: Storyboard) => {
  if (!board.sequencePlanId || !board.segmentId || board.sourceStale) return undefined;
  const plan = project.sequencePlans.find((candidate) => candidate.id === board.sequencePlanId);
  if (!isSemanticSequencePlan(plan) || plan.chapterId !== board.chapterId) return undefined;
  const segment = plan.segments.find((candidate) => candidate.id === board.segmentId);
  if (!segment || segment.storyboardId !== board.id
    || board.sourceStoryContent?.trim() !== semanticSegmentStoryContent(segment).trim()) return undefined;
  try { return semanticSegmentSourceContext(plan, segment); }
  catch { return undefined; } // Malformed historical evidence cannot replace saved board text.
};

/** Generation, copying and video source selection share this exact evidence snapshot. */
export const buildOfficialSeedanceInput = (project: Project, board: Storyboard): OfficialSeedancePromptInput => {
  const context = officialH3ContextForStoryboard(project, board);
  // Generated storyboard images are outputs of this source. Their automatic
  // shot bindings must not invalidate the video draft that produced them.
  // Explicitly promoting an image to a global source still changes identity.
  const automaticImageIds = new Set(context.assets.filter((asset) => asset.source === 'generated'
    && asset.sourceStoryboardId === board.id && !(board.globalReferenceAssetIds || []).includes(asset.id))
    .map((asset) => asset.id));
  const sequenceSegmentContext = currentSemanticSourceContext(project, board);
  const references = buildOfficialH3References(board, context.assets, context.characters).map((reference) => {
    // Binary data belongs to the media transport. The writer consumes complete
    // recognized text facts, identities and checksum metadata, not base64 blobs.
    const evidence = Object.fromEntries(Object.entries(reference).filter(([key]) => !/dataUrl$/iu.test(key)));
    return { ...evidence, tags: reference.tags || [], targetBindings: reference.targetBindings || [] } as typeof reference;
  });
  const input: OfficialSeedancePromptInput = {
    canonicalPrompt: board.promptPlan?.canonicalPrompt || board.finalPrompt,
    durationSec: board.promptPlan?.durationSec || board.durationSec,
    aspectRatio: board.promptPlan?.aspectRatio || board.aspectRatio,
    resolution: board.promptPlan?.resolution || board.resolution,
    audioMode: board.promptPlan?.audioMode || board.audioMode,
    voiceFactScope: 'source-grounded-new-draft',
    references,
    sceneContext: buildVideoSceneContext({ board, locations: context.locations, scenes: project.scenes,
      assets: context.assets, references, chapterId: board.chapterId }),
    subjectDefinitions: buildOfficialH3SubjectDefinitions(board, context, references),
    shotPrivateDetails: buildOfficialH3CompileInput(board, context).shotPrivateDetails,
    detailMode: 'director', targetId: 'seedance-2.5',
    constraints: board.promptPlan?.constraints || [board.globalLock, board.extraRequirement ? `制作要求：${board.extraRequirement}` : ''].filter(Boolean),
    sourceEvidence: {
      characterIdentityFacts: (context.characters || []).map(characterVoiceIdentityFacts),
      currentCharacterVoiceFacts: currentCharacterVoiceFacts(context.characters || [], project.characters),
      audioLedgerFacts: structuredClone(board.audioLedger || []),
      sourceStoryContent: board.sourceStoryContent || context.sceneContent || '',
      ...(sequenceSegmentContext ? { sequenceSegmentContext } : {}),
      sourceSceneSnapshots: (board.sourceSceneSnapshots || []).map((scene) => ({ id: scene.id, title: scene.title, content: scene.content })),
      shots: board.shots.map((shot) => ({ ...shot,
        referenceAssetIds: (shot.referenceAssetIds || []).filter((id) => !automaticImageIds.has(id)), prompt: shot.prompt || '' })),
      shotMode: board.shotMode,
      shotCount: board.shotCount,
      confirmedShotCount: board.shots.length,
      creativeDirection: board.creativeDirection,
      directorStyleSummary: board.directorStyleSummary,
      visualStyle: board.visualStyle,
      extraRequirement: board.extraRequirement,
    },
  };
  if (board.shots.some((shot) => (shot.referenceAssetIds || []).some((id) => automaticImageIds.has(id)))) {
    // A saved draft made after images already existed can carry the old exact
    // fingerprint. Accept only that fully reconstructed identity, without
    // rewriting saved text or relaxing checks on real source changes.
    input.legacySourceFingerprint = getOfficialSeedanceSourceFingerprint({ ...input,
      sourceEvidence: { ...input.sourceEvidence,
        shots: board.shots.map((shot) => ({ ...shot, referenceAssetIds: shot.referenceAssetIds || [], prompt: shot.prompt || '' })) } });
  }
  return input;
};

export const hasCurrentSeedancePrompt = (project: Project, board: Storyboard, language: 'zh' | 'en' = 'zh'): boolean => {
  const output = board.seedance25Output;
  if (board.sourceStale || !output?.promptZh || getVideoPromptInstructionLeak(output.promptZh)
    || !hasMatchingSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board), output.sourceFingerprint)) return false;
  return language === 'zh' || Boolean(output.promptEn && output.englishSourceFingerprint === output.sourceFingerprint
    && !getVideoPromptInstructionLeak(output.promptEn));
};

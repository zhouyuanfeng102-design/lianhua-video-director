import { pendingSequencePromptSegmentIds, resolveSequenceSegmentPromptAction } from './appEffects';
import { officialH3ContextForStoryboard } from './officialH3Context';
import { buildOfficialSeedanceInput, hasCurrentSeedancePrompt } from './seedanceSource';
import { buildSequencePromptHandoff, getSequencePromptHandoffStatus } from './sequencePromptHandoff';
import type { Project, Storyboard, VideoSegment, VideoSequencePlan } from './types';

type PromptFormat = 'h3' | 'seedance';
type PromptLanguage = 'zh' | 'en';

const readOnce = <K, V>(cache: Map<K, V>, key: K, read: () => V): V => {
  if (cache.has(key)) return cache.get(key)!;
  const value = read();
  cache.set(key, value);
  return value;
};

/** Display-only reads for one immutable chapter/source snapshot. The parent
 * keeps this through controls-only saves and replaces it when source collections
 * or the chapter change. Generation and submission keep their live checks. */
export const createPromptDirectorReadCache = (project: Project) => {
  const contexts = new Map<Storyboard | undefined, ReturnType<typeof officialH3ContextForStoryboard>>();
  const inputs = new Map<Storyboard, ReturnType<typeof buildOfficialSeedanceInput>>();
  const readiness = new Map<Storyboard, Map<PromptLanguage, boolean>>();
  const actions = new Map<VideoSequencePlan, Map<VideoSegment | undefined, Map<PromptFormat, ReturnType<typeof resolveSequenceSegmentPromptAction>>>>();
  const handoffs = new Map<Storyboard, Map<PromptFormat, ReturnType<typeof getSequencePromptHandoffStatus>>>();
  const evidence = new Map<VideoSequencePlan, Map<VideoSegment, Map<PromptFormat, ReturnType<typeof buildSequencePromptHandoff>>>>();
  const pending = new Map<VideoSequencePlan, Map<PromptFormat, string[]>>();

  const officialContext = (board?: Storyboard) => readOnce(contexts, board,
    () => officialH3ContextForStoryboard(project, board));

  return {
    officialContext,
    seedanceInput: (board: Storyboard) => readOnce(inputs, board,
      () => buildOfficialSeedanceInput(project, board)),
    seedanceReady: (board: Storyboard, language: PromptLanguage = 'zh') => readOnce(
      readOnce(readiness, board, () => new Map()), language,
      () => hasCurrentSeedancePrompt(project, board, language)),
    promptAction: (plan: VideoSequencePlan, segment: VideoSegment | undefined, format: PromptFormat = 'h3') => readOnce(
      readOnce(readOnce(actions, plan, () => new Map()), segment, () => new Map()), format,
      () => resolveSequenceSegmentPromptAction(segment, project.storyboards, plan.id,
        officialContext(project.storyboards.find((board) => board.id === segment?.storyboardId)), format, project)),
    handoff: (board: Storyboard, format: PromptFormat = 'h3') => readOnce(
      readOnce(handoffs, board, () => new Map()), format,
      () => getSequencePromptHandoffStatus(board, project, format)),
    handoffEvidence: (plan: VideoSequencePlan, segment: VideoSegment, format: PromptFormat = 'h3') => readOnce(
      readOnce(readOnce(evidence, plan, () => new Map()), segment, () => new Map()), format,
      () => buildSequencePromptHandoff(project, plan.id, segment.id, format)),
    pendingSegmentIds: (plan: VideoSequencePlan, format: PromptFormat = 'h3') => readOnce(
      readOnce(pending, plan, () => new Map()), format,
      () => pendingSequencePromptSegmentIds(plan, project.storyboards, officialContext, format, project)),
  };
};

export type PromptDirectorReadCache = ReturnType<typeof createPromptDirectorReadCache>;

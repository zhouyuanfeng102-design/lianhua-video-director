import {
  generateSingleSegmentPrompt as generate,
  type GenerateSingleSegmentPromptInput,
} from '../../src/singleSegmentPrompt';
import {
  regenerateSequenceReferencePrompt as regenerate,
  type RegenerateSequenceReferencePromptInput,
} from '../../src/sequenceReferencePrompt';

export type { GenerateSingleSegmentPromptInput, SingleSegmentPromptStage } from '../../src/singleSegmentPrompt';
export { getSingleSegmentReferences, SEMANTIC_SEGMENT_SOURCE_RULE } from '../../src/singleSegmentPrompt';
export type { RegenerateSequenceReferencePromptInput, SequenceReferencePromptStage } from '../../src/sequenceReferencePrompt';

/** Existing audio/camera/handoff fixtures author H3 prose only. Package that
 * mock answer with its unchanged synthetic schedule using the NEW delivery
 * protocol. This helper never touches production or patches assertions. The
 * raw protocol/error/retiming tests use the real service directly, without
 * this wrapper, so an H3-only reply must still fail and be repaired by AI.
 * Confirmed-schedule, English and format-only replies remain untouched. */
export const h3PipelineMockResponse = (user: string, response: string): string => {
  const match = user.match(/<video_staging_review_data>\s*([\s\S]*?)\s*<\/video_staging_review_data>/u);
  if (!match) return response;
  const data = JSON.parse(match[1]);
  if (data.taskAuthority !== 'current-segment-staging-replan' || !response.trim() || response.trim().startsWith('{')) return response;
  return JSON.stringify({
    canonicalPrompt: data.canonicalPrompt,
    h3Prompt: response.trim(),
    shotSourceIds: data.shots.map((shot: { id: string }) => [shot.id]),
  });
};

const requestFor = (request: GenerateSingleSegmentPromptInput['request']): GenerateSingleSegmentPromptInput['request'] =>
  async (system, user, stage, transport) => h3PipelineMockResponse(user, await request(system, user, stage, transport));

export const generateSingleSegmentPrompt = (input: GenerateSingleSegmentPromptInput) =>
  generate({ ...input, request: requestFor(input.request) });

export const regenerateSequenceReferencePrompt = (input: RegenerateSequenceReferencePromptInput) =>
  regenerate({ ...input, request: requestFor(input.request) });

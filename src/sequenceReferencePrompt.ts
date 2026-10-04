import type { OfficialH3ProjectContext } from './officialPrompt';
import { generateSingleSegmentPrompt, type SingleSegmentPromptStage, type SingleSegmentPromptTransport } from './singleSegmentPrompt';
import type { ConfirmedMasterSliceSourceContext } from './confirmedMasterSliceSource';
import type { SequencePromptHandoffContext } from './sequencePromptHandoff';
import type { SemanticSegmentSourceContext } from './semanticSequencePlan';
import { semanticSegmentStoryContent } from './semanticSequencePlan';
import type { ConverterPreset, RuleSet, Storyboard, VideoSegment, VideoShot } from './types';

export type SequenceReferencePromptStage = SingleSegmentPromptStage;

export interface RegenerateSequenceReferencePromptInput {
  mode?: 'regenerate' | 'reference-refresh' | 'translate-english' | 'continuity-repair' | 'dialogue-repair';
  board: Storyboard;
  segment: VideoSegment;
  masterSource?: ConfirmedMasterSliceSourceContext;
  sequenceHandoff?: SequencePromptHandoffContext;
  sequenceSegmentContext?: SemanticSegmentSourceContext;
  context: OfficialH3ProjectContext;
  converter?: ConverterPreset;
  ruleSet?: RuleSet;
  clean: (value: string) => string;
  maxOutputTokens?: number;
  request: (systemPrompt: string, userPrompt: string, stage: SequenceReferencePromptStage, transport?: SingleSegmentPromptTransport) => Promise<string>;
  isCurrent?: () => boolean;
  /** Forward the same full-source AI English review used by standalone prompts. */
  reviewWithAi?: boolean;
  onAiTranslationReview?: () => void;
  onStage?: (stage: SequenceReferencePromptStage) => void;
  /** True only when the request callback actually attaches these image pixels. */
  hasImageInputs?: boolean;
  now?: () => number;
}

/** A stored shot can carry whole-story UTF-16 offsets. Never apply those
 * offsets directly to the shorter segment text just because they fit it. */
function scopedEvidenceShot(shot: VideoShot, board: Storyboard, content: string): VideoShot {
  let sourceStart: number | undefined;
  let sourceEnd: number | undefined;
  const fullSource = board.sourceStoryContent || '';
  const segmentOffset = fullSource.indexOf(content);
  const uniqueSegmentOffset = segmentOffset >= 0
    && fullSource.indexOf(content, segmentOffset + 1) < 0;
  if (
    fullSource !== content
    && uniqueSegmentOffset
    && Number.isInteger(shot.sourceStart)
    && Number.isInteger(shot.sourceEnd)
    && (shot.sourceStart as number) >= segmentOffset
    && (shot.sourceEnd as number) > (shot.sourceStart as number)
    && (shot.sourceEnd as number) <= segmentOffset + content.length
  ) {
    sourceStart = (shot.sourceStart as number) - segmentOffset;
    sourceEnd = (shot.sourceEnd as number) - segmentOffset;
  } else if (shot.action.trim()) {
    const actionOffset = content.indexOf(shot.action.trim());
    if (actionOffset >= 0 && content.indexOf(shot.action.trim(), actionOffset + 1) < 0) {
      sourceStart = actionOffset;
      sourceEnd = actionOffset + shot.action.trim().length;
    }
  }
  return { ...shot, sourceStart, sourceEnd, sourceBeatIds: [] };
}

/** Long-story adapter only: scope the evidence to the selected segment, then
 * use the exact same conversion/compilation/translation service as short stories. */
export async function regenerateSequenceReferencePrompt(
  input: RegenerateSequenceReferencePromptInput,
): Promise<Storyboard> {
  const { board, segment } = input;
  if (board.segmentId && board.segmentId !== segment.id) throw new Error('当前分镜不属于选中的分段。');
  if (segment.storyboardId && segment.storyboardId !== board.id) throw new Error('当前分段已关联另一组分镜。');
  if (board.durationSec !== segment.durationSec) throw new Error('当前分段时长与原分镜不一致，不能修改固定时间边界。');
  if (input.mode === 'translate-english') {
    return generateSingleSegmentPrompt({ ...input, mode: 'translate-english' });
  }
  const segmentSource = input.sequenceSegmentContext
    ? input.sequenceSegmentContext.generationStoryContent ?? semanticSegmentStoryContent(segment)
    : segment.content.trim();
  if (!segmentSource) throw new Error('当前分段缺少剧情原文，不能重新转换。');
  if (!board.shots.length) throw new Error('当前分段没有可复用的分镜。');
  if (input.mode === 'continuity-repair' || input.mode === 'dialogue-repair') {
    return generateSingleSegmentPrompt({
      ...input, mode: 'generate', purpose: input.mode, sourceStoryContent: segmentSource,
    });
  }
  const scopedContinuity = [
    segment.entryState ? `本段入场状态：${segment.entryState}` : '',
    segment.exitState ? `本段离场状态：${segment.exitState}` : '',
  ].filter(Boolean).join('\n');
  const conversionDraft: Storyboard = {
    ...board,
    sourceStoryContent: segmentSource,
    sourceSceneSnapshots: [],
    globalLock: scopedContinuity,
    // These temporary coordinates match the converter's trimmed source.
    // The shared service synchronizes output from original board.shots.
    shots: board.shots.map((shot) => scopedEvidenceShot(shot, board, segmentSource)),
    finalPrompt: board.promptPlan?.canonicalPrompt || board.finalPrompt,
  };
  return generateSingleSegmentPrompt({
    ...input,
    mode: 'generate',
    conversionDraft,
    sourceStoryContent: segmentSource,
    // An explicit regeneration must receive current content/audio policy.
    // Only a genuine reference-only refresh is locked to the saved mix.
    purpose: input.mode === 'reference-refresh' ? 'reference-refresh' : 'initial',
  });
}

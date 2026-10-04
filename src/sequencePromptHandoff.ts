import { readH3PromptProtocol } from './h3PromptProtocol';
import { parseMasterTimelinePrompt } from './masterTimeline';
import { hasCurrentOfficialH3Prompt } from './officialPrompt';
import { sourceContentHash } from './sourceIntegrity';
import type { Project, SequencePromptHandoffStamp, Storyboard, VideoSegment, VideoSequencePlan } from './types';
import {
  normalizeSequencePromptHandoffStamp,
  SEQUENCE_PROMPT_HANDOFF_VERSION,
  SEQUENCE_PROMPT_HANDOFF_TIMING_VERSION,
  SEQUENCE_PROMPT_OPENING_OVERLAP_SEC,
  SEQUENCE_PROMPT_MAX_OPENING_OVERLAP_SEC,
} from './sequencePromptHandoffStamp';
export {
  normalizeSequencePromptHandoffStamp,
  SEQUENCE_PROMPT_HANDOFF_VERSION,
  SEQUENCE_PROMPT_HANDOFF_TIMING_VERSION,
  SEQUENCE_PROMPT_OPENING_OVERLAP_SEC,
  SEQUENCE_PROMPT_MAX_OPENING_OVERLAP_SEC,
} from './sequencePromptHandoffStamp';

/** Read-only evidence coordinates and output-action coordinates are separate.
 * The ranges describe the AI task; they never locally trim or rewrite prose. */
export interface SequencePromptOpeningTiming {
  readonly contractVersion: typeof SEQUENCE_PROMPT_HANDOFF_TIMING_VERSION;
  readonly previousPromptEvidence: {
    readonly source: 'previousFinalPrompt';
    readonly literalLastShot: 'previousLastShot';
    readonly access: 'read-only-text-provenance';
    readonly coordinate: 'previous-segment-seconds';
    readonly startSec: number;
    readonly endSec: number;
    readonly usage: 'infer-terminal-action-state-only-not-replay-duration';
  };
  readonly currentOpeningWindow: {
    readonly coordinate: 'current-segment-seconds';
    readonly startSec: 0;
    readonly endSec: typeof SEQUENCE_PROMPT_OPENING_OVERLAP_SEC;
    readonly maxEndSec: typeof SEQUENCE_PROMPT_MAX_OPENING_OVERLAP_SEC;
    readonly placement: 'inside-existing-first-shot';
  };
  readonly currentStoryStartsAtSec: typeof SEQUENCE_PROMPT_OPENING_OVERLAP_SEC;
  readonly currentStoryStartsNoLaterThanSec: typeof SEQUENCE_PROMPT_MAX_OPENING_OVERLAP_SEC;
  readonly currentStorySource: 'segmentContent';
  readonly remainderOfFirstShot: 'advance-current-story-without-extending-replay';
  readonly previousWholeShotReplay: 'not-allowed';
  readonly previousDialogueReplay: 'not-allowed';
  readonly additionalShotOrCut: 'not-allowed';
  readonly overlapIncludedInSegmentDuration: true;
  readonly firstShotTimingInstruction: string;
}

/** All fields are text/plan evidence for the AI. A tail window is a range in
 * the preceding PROMPT, never a claim that a video or frame already exists. */
export interface SequencePromptHandoffContext {
  version: typeof SEQUENCE_PROMPT_HANDOFF_VERSION;
  projectId: string;
  planId: string;
  segmentId: string;
  segmentIndex: number;
  durationSec: number;
  segmentContent: string;
  previousSegmentId: string;
  previousSegmentIndex: number;
  previousStoryboardId: string;
  previousDurationSec: number;
  previousSegmentContent: string;
  previousPromptKind: 'official-h3' | 'canonical';
  /** Literal read-only provenance, not a new-segment replay instruction. */
  readonly previousFinalPrompt: string;
  /** The complete last shot is context for its terminal state, not a replay. */
  readonly previousLastShot?: Readonly<{ marker: string; startSec: number; endSec: number; prompt: string }>;
  /** Previous-segment reading focus only; never the new segment's duration. */
  readonly previousTailWindow: Readonly<{ startSec: number; endSec: number }>;
  previousEntryState: string;
  previousExitState: string;
  previousContinuityPack: string;
  entryState: string;
  exitState: string;
  continuityPack: string;
  transitionHint: string;
  openingOverlapSec: typeof SEQUENCE_PROMPT_OPENING_OVERLAP_SEC;
  /** Explicit timing semantics, included in the source provenance fingerprint. */
  readonly openingTiming: SequencePromptOpeningTiming;
  previousPromptFingerprint: string;
  /** Stable identity for async guards, independent of task/video timestamps. */
  sourceFingerprint: string;
}

export interface SequencePromptHandoffBuildResult {
  context?: SequencePromptHandoffContext;
  /** Prepared only; seal against the AI-reviewed output before persisting. */
  stamp?: SequencePromptHandoffStamp;
  issue?: string;
}

type HandoffProject = Pick<Project, 'id' | 'sequencePlans' | 'storyboards'>;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
// Normalize line endings only. Never remove words, tags or dialogue to make a
// semantically altered prompt appear equivalent to the saved AI result.
const promptText = (value: unknown): string => text(value).replace(/\r\n?/gu, '\n').trim();
const promptHash = (value: string): string => sourceContentHash(promptText(value));
const finitePositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** This selects literal shot blocks by protocol, not characters/actions. A
 * malformed/unsupported shape just omits the convenience excerpt; it never
 * substitutes stale board.shots or locally writes a narrative summary. */
const lastPromptShot = (
  prompt: string,
  kind: SequencePromptHandoffContext['previousPromptKind'],
  durationSec: number,
): SequencePromptHandoffContext['previousLastShot'] => {
  if (kind === 'canonical') {
    try {
      const shots = parseMasterTimelinePrompt(prompt, durationSec);
      const last = shots[shots.length - 1];
      return last ? { marker: `【${last.startSec}s-${last.endSec}s】`, ...last } : undefined;
    } catch {
      return undefined;
    }
  }
  const protocol = readH3PromptProtocol(prompt);
  if (!protocol) return undefined;
  const section = /^((?:integrated_multimodal_description|detailed_description)):([^]*?)(?=^overall_soundscape:)/mu.exec(prompt);
  if (!section) return undefined;
  const description = section[2];
  const matches = [...description.matchAll(/\[Shot (\d+)\]/gu)];
  const last = matches[matches.length - 1];
  const lastProtocol = protocol.shots[protocol.shots.length - 1];
  if (!last || last[0] !== lastProtocol?.marker) return undefined;
  const cut = lastProtocol.cut?.match(/^At (\d{2}):([0-5]\d)\.(\d{3})$/u);
  const startSec = cut ? Number(cut[1]) * 60 + Number(cut[2]) + Number(cut[3]) / 1000 : 0;
  if (startSec >= durationSec) return undefined;
  return { marker: last[0], startSec, endSec: durationSec, prompt: description.slice(last.index).trim() };
};

const locateSegment = (
  project: HandoffProject, planId: string, segmentId: string,
): { plan?: VideoSequencePlan; segment?: VideoSegment; previous?: VideoSegment; issue?: string } => {
  const plans = project.sequencePlans.filter((plan) => plan.id === planId);
  if (plans.length !== 1) return { issue: '分段计划不存在或身份不唯一，不能确定上段提示词。' };
  const plan = plans[0];
  const segments = plan.segments.filter((segment) => segment.id === segmentId);
  if (segments.length !== 1) return { issue: '当前分段不存在或身份不唯一，不能确定上段提示词。' };
  const segment = segments[0];
  const index = plan.segments.indexOf(segment);
  if (segment.index !== index + 1 || plan.segments.some((item, position) => item.index !== position + 1)
    || new Set(plan.segments.map((item) => item.id)).size !== plan.segments.length) {
    return { issue: '分段顺序或编号不一致，请先确认分段计划；不会跳过缺失段借用其他提示词。' };
  }
  if (!finitePositive(segment.durationSec)) return { issue: '当前分段缺少有效时长，不能建立文本衔接。' };
  return { plan, segment, ...(index > 0 ? { previous: plan.segments[index - 1] } : {}) };
};

const preparedStamp = (context: SequencePromptHandoffContext): SequencePromptHandoffStamp => ({
  version: SEQUENCE_PROMPT_HANDOFF_VERSION,
  projectId: context.projectId,
  planId: context.planId,
  segmentId: context.segmentId,
  segmentIndex: context.segmentIndex,
  previousSegmentId: context.previousSegmentId,
  previousSegmentIndex: context.previousSegmentIndex,
  previousStoryboardId: context.previousStoryboardId,
  previousPromptFingerprint: context.previousPromptFingerprint,
  sourceFingerprint: context.sourceFingerprint,
  openingOverlapSec: SEQUENCE_PROMPT_OPENING_OVERLAP_SEC,
});

export const buildSequencePromptHandoff = (
  project: HandoffProject, planId: string, segmentId: string,
): SequencePromptHandoffBuildResult => {
  const { plan, segment, previous, issue } = locateSegment(project, planId, segmentId);
  if (issue || !plan || !segment) return { issue };
  // The first segment has no preceding scene. No media dependency is created.
  if (!previous) return {};
  const precedingBoards = project.storyboards.filter((board) => board.id === previous.storyboardId);
  const board = precedingBoards.length === 1 ? precedingBoards[0] : undefined;
  if (!board || board.id === plan.masterStoryboardId || board.sequencePlanId !== plan.id
    || board.segmentId !== previous.id || board.segmentIndex !== previous.index
    || !finitePositive(previous.durationSec) || board.durationSec !== previous.durationSec) {
    return { issue: `第 ${previous.index} 段尚无正确关联的最终提示词，请先完成该段提示词；不会跳段或借用全片总稿。` };
  }
  if (previous.status === 'stale') {
    return { issue: `第 ${previous.index} 段剧情已修改，旧提示词尚未更新，请先完成该段提示词。` };
  }
  if (board.promptPlan?.canonicalPrompt && board.promptPlan.canonicalPrompt !== board.finalPrompt) {
    return { issue: `第 ${previous.index} 段的正文与生成快照不一致，请先更新该段最终提示词。` };
  }
  let previousPromptKind: SequencePromptHandoffContext['previousPromptKind'];
  let previousFinalPrompt: string;
  if (text(board.officialPromptZh).trim()) {
    if (!hasCurrentOfficialH3Prompt(board)) {
      return { issue: `第 ${previous.index} 段的中文H3稿已失效或尚未完整保存，请先更新该段提示词。` };
    }
    previousPromptKind = 'official-h3';
    previousFinalPrompt = board.officialPromptZh!;
  } else if (board.promptTrace?.mode === 'text-api' && text(board.finalPrompt).trim()
    && board.promptTrace.convertedPromptFingerprint === sourceContentHash(board.finalPrompt)
    && (!board.promptPlan?.canonicalPrompt || board.promptPlan.canonicalPrompt === board.finalPrompt)) {
    previousPromptKind = 'canonical';
    previousFinalPrompt = board.finalPrompt;
  } else {
    return { issue: `第 ${previous.index} 段尚未保存AI生成的最终中文提示词，请先完成该段；分镜草稿不作为最终衔接依据。` };
  }
  const lastShot = lastPromptShot(previousFinalPrompt, previousPromptKind, previous.durationSec);
  const previousTailWindow = { startSec: Math.max(0, previous.durationSec - 2), endSec: previous.durationSec };
  const evidence: Omit<SequencePromptHandoffContext, 'sourceFingerprint'> = {
    version: SEQUENCE_PROMPT_HANDOFF_VERSION,
    projectId: project.id,
    planId: plan.id,
    segmentId: segment.id,
    segmentIndex: segment.index,
    durationSec: segment.durationSec,
    segmentContent: text(segment.content),
    previousSegmentId: previous.id,
    previousSegmentIndex: previous.index,
    previousStoryboardId: board.id,
    previousDurationSec: previous.durationSec,
    previousSegmentContent: text(previous.content),
    previousPromptKind,
    previousFinalPrompt,
    ...(lastShot ? { previousLastShot: lastShot } : {}),
    previousTailWindow,
    previousEntryState: text(previous.entryState),
    previousExitState: text(previous.exitState),
    previousContinuityPack: text(previous.continuityPack),
    entryState: text(segment.entryState),
    exitState: text(segment.exitState),
    continuityPack: text(segment.continuityPack),
    transitionHint: text(segment.transitionHint),
    openingOverlapSec: SEQUENCE_PROMPT_OPENING_OVERLAP_SEC,
    openingTiming: {
      contractVersion: SEQUENCE_PROMPT_HANDOFF_TIMING_VERSION,
      previousPromptEvidence: {
        source: 'previousFinalPrompt', literalLastShot: 'previousLastShot',
        access: 'read-only-text-provenance', coordinate: 'previous-segment-seconds',
        ...previousTailWindow,
        usage: 'infer-terminal-action-state-only-not-replay-duration',
      },
      currentOpeningWindow: {
        coordinate: 'current-segment-seconds', startSec: 0,
        endSec: SEQUENCE_PROMPT_OPENING_OVERLAP_SEC,
        maxEndSec: SEQUENCE_PROMPT_MAX_OPENING_OVERLAP_SEC,
        placement: 'inside-existing-first-shot',
      },
      currentStoryStartsAtSec: SEQUENCE_PROMPT_OPENING_OVERLAP_SEC,
      currentStoryStartsNoLaterThanSec: SEQUENCE_PROMPT_MAX_OPENING_OVERLAP_SEC,
      currentStorySource: 'segmentContent',
      remainderOfFirstShot: 'advance-current-story-without-extending-replay',
      previousWholeShotReplay: 'not-allowed', previousDialogueReplay: 'not-allowed',
      additionalShotOrCut: 'not-allowed', overlapIncludedInSegmentDuration: true,
      firstShotTimingInstruction: 'previousTailWindow的上段末1–2秒只供读取、理解末端动作，previousLastShot整镜也只作只读证据，不是下段复播时长。仅在既有首镜正文内标清“本段0.00–0.50秒：接续上段末端动作；从0.50秒起：立即推进本段新动作或对白”，首镜剩余时间不得继续重演上段。若动作确需微调，由AI明确实际短重合的结束时刻并同步新内容起点，最晚0.80秒即推进本段；0.80秒是上限，不是默认复播时长，更不是整个首镜。不能复制上段完整末镜、已说完对白或其他旧事件，不新增镜头或At切点，短重合计入既定段长，不把15秒变成15.5秒。原文明确换场或跳时则保留原转场，不虚构连续动作，也不借此回放上段。',
    },
    previousPromptFingerprint: promptHash(previousFinalPrompt),
  };
  const context = { ...evidence, sourceFingerprint: sourceContentHash(JSON.stringify(evidence)) };
  return { context, stamp: preparedStamp(context) };
};

/** Only source/result prompt content and fixed segment coordinates count.
 * English translation, saved image results and job progress cannot stale a
 * Chinese handoff. Canonical and reviewed official prose both remain bound. */
const resultFingerprint = (board: Storyboard): string => sourceContentHash(JSON.stringify({
  id: board.id,
  planId: board.sequencePlanId,
  segmentId: board.segmentId,
  segmentIndex: board.segmentIndex,
  durationSec: board.durationSec,
  finalPrompt: promptText(board.finalPrompt),
  canonicalPrompt: promptText(board.promptPlan?.canonicalPrompt || board.finalPrompt),
  officialPromptZh: promptText(board.officialPromptZh),
}));

export const sealSequencePromptHandoff = (
  board: Storyboard, stamp: SequencePromptHandoffStamp,
): SequencePromptHandoffStamp => {
  const sealed = normalizeSequencePromptHandoffStamp({
    ...stamp, storyboardId: board.id, resultFingerprint: resultFingerprint(board),
  });
  if (!sealed || sealed.planId !== board.sequencePlanId || sealed.segmentId !== board.segmentId
    || sealed.segmentIndex !== board.segmentIndex || !text(board.finalPrompt).trim()) {
    throw new Error('文本衔接来源与当前分段不一致，不能保存为已对齐。');
  }
  return sealed;
};

export const stampSequencePromptHandoff = (
  board: Storyboard, context: SequencePromptHandoffContext,
): Storyboard => {
  const { sourceFingerprint, ...evidence } = context;
  if (sourceFingerprint !== sourceContentHash(JSON.stringify(evidence))) {
    throw new Error('上段文本衔接资料已变化，本次结果不能标记为已对齐。');
  }
  return { ...board, sequencePromptHandoff: sealSequencePromptHandoff(board, preparedStamp(context)) };
};

export interface SequencePromptHandoffStatus {
  kind: 'not-sequence' | 'first' | 'legacy' | 'current' | 'stale' | 'unavailable';
  label: string;
  issue?: string;
  previousSegmentIndex?: number;
}

export const getSequencePromptHandoffStatus = (
  board: Storyboard, project: HandoffProject,
): SequencePromptHandoffStatus => {
  if (!board.sequencePlanId && !board.segmentId) return { kind: 'not-sequence', label: '独立提示词' };
  if (!board.sequencePlanId || !board.segmentId) return { kind: 'unavailable', label: '分段关联不完整', issue: '当前提示词缺少完整的分段关联。' };
  const location = locateSegment(project, board.sequencePlanId, board.segmentId);
  if (location.issue || !location.segment || location.segment.storyboardId !== board.id
    || location.segment.index !== board.segmentIndex || location.plan?.masterStoryboardId === board.id) {
    return { kind: 'unavailable', label: '分段关联已变化', issue: location.issue || '当前提示词不再对应此分段。' };
  }
  if (!location.previous) return { kind: 'first', label: '首段，无需上段衔接' };
  const previousSegmentIndex = location.previous.index;
  if (!board.sequencePromptHandoff) return { kind: 'legacy', label: '尚未按上段末镜对齐', previousSegmentIndex };
  const stamp = normalizeSequencePromptHandoffStamp(board.sequencePromptHandoff);
  const build = buildSequencePromptHandoff(project, board.sequencePlanId, board.segmentId);
  if (!stamp || !build.stamp || stamp.projectId !== project.id || stamp.planId !== board.sequencePlanId || stamp.segmentId !== board.segmentId
    || stamp.segmentIndex !== board.segmentIndex || stamp.storyboardId !== board.id
    || stamp.previousSegmentId !== build.stamp.previousSegmentId
    || stamp.previousSegmentIndex !== build.stamp.previousSegmentIndex
    || stamp.previousStoryboardId !== build.stamp.previousStoryboardId
    || stamp.previousPromptFingerprint !== build.stamp.previousPromptFingerprint
    || stamp.sourceFingerprint !== build.stamp.sourceFingerprint
    || stamp.resultFingerprint !== resultFingerprint(board)) {
    return { kind: 'stale', label: '衔接依据或本稿已变化，需重新对齐', previousSegmentIndex,
      issue: build.issue || '保存时的上段末镜、本段剧情、最终提示词或衔接时间合同与当前内容不一致，旧稿不会自动视为已按新规则修复。' };
  }
  return { kind: 'current', label: `已按第 ${previousSegmentIndex} 段末镜完成文本衔接`, previousSegmentIndex };
};

export const isSequencePromptHandoffCurrent = (board: Storyboard, project: HandoffProject): boolean => (
  ['not-sequence', 'first', 'current'].includes(getSequencePromptHandoffStatus(board, project).kind)
);

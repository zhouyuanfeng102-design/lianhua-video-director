import type { Project, ReferenceRole } from './types';
import type { VideoGenerationDraft } from './videoGenerationTypes';
import { prepareVideoH3ReferenceDraft, type VideoH3ReferenceContext } from './videoH3ReferenceBinding';
import { readExistingH3PromptProtocol } from './h3PromptProtocol';
import { sourceContentHash } from './sourceContentHash';
import { videoReferenceSlotIndex } from './videoReferenceSlots';
import { stripVideoMotionPromptBinding } from './videoMotionReferences';

export type VideoH3MediaMode = 'base' | 'keyframe' | 'full-reference';
export interface VideoH3MediaModeContract {
  version: 1;
  mode: VideoH3MediaMode;
  authoredMode: 'integrated' | 'full-reference' | 'unreadable';
  /** Selected first/last uses never prove a third-party workflow's hard frame constraint. */
  boundarySemantics: 'explicit-keyframe-input' | 'composition-reference';
  images: Array<{ assetId: string; slotIndex: number; role: ReferenceRole }>;
  audioCount: number;
  videoCount: number;
  inputIdentity: string;
  /** Only explicit request updates carry a freshness claim. */
  referenceUpdateCurrent?: boolean;
}
export interface VideoH3MediaModeUpdate {
  version: 1;
  sourcePrompt: string;
  updatedPrompt: string;
  inputIdentity: string;
}

const referenceTemplateHash = (context: VideoH3ReferenceContext): string => {
  const raw = context.api?.requestTemplate || '';
  if (context.api?.provider !== 'runninghub') return sourceContentHash(raw);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('nodeInfoList' in parsed) || !Array.isArray(parsed.nodeInfoList)) return sourceContentHash(raw);
    const parameterFields = context.api.runningHubMappedFields?.filter((field) => field.kind === 'parameter') || [];
    // UI previews resolve connection capabilities without overrides; execution
    // resolves the same template with explicit parameter values. Those values
    // are already frozen separately and do not change image reference wiring.
    const nodes = parsed.nodeInfoList.map((node: unknown) => node && typeof node === 'object' && 'nodeId' in node && 'fieldName' in node
      && parameterFields.some((field) => field.nodeId === node.nodeId && field.fieldName === node.fieldName)
      ? { ...node, fieldValue: '__explicit_task_parameter__' } : node);
    return sourceContentHash(JSON.stringify({ ...parsed, nodeInfoList: nodes }));
  } catch { return sourceContentHash(raw); }
};

export const videoH3MediaModeContract = (
  draft: VideoGenerationDraft, context: VideoH3ReferenceContext,
): VideoH3MediaModeContract => {
  const images = draft.references.map((reference, index) => ({ assetId: reference.assetId,
    slotIndex: videoReferenceSlotIndex(reference, index), role: reference.role }));
  const audioCount = draft.audioReferences?.length || 0;
  const videoCount = draft.videoReferences?.length || 0;
  const boundaryOnly = images.length <= 2 && images.every((image) => image.role === 'first-frame' || image.role === 'last-frame')
    && images.filter((image) => image.role === 'first-frame').length <= 1
    && images.filter((image) => image.role === 'last-frame').length <= 1;
  const mode: VideoH3MediaMode = !images.length && !audioCount && !videoCount ? 'base'
    : boundaryOnly && !audioCount && !videoCount ? 'keyframe' : 'full-reference';
  const protocol = readExistingH3PromptProtocol(draft.prompt);
  const authoredMode = !protocol ? 'unreadable' as const : protocol.sections[0] === 'subject_definitions' ? 'full-reference' as const : 'integrated' as const;
  const boundarySemantics = context.backend === 'api' && (context.api?.provider === 'minimax'
    || context.api?.provider === 'rhtv_web' && ['first', 'first_last'].includes(String(draft.parameters.rhtv_mode || context.api.rhtvMode)))
    ? 'explicit-keyframe-input' as const : 'composition-reference' as const;
  const identityImages = images.map((image) => ({ ...image,
    assetId: image.assetId === '__future_tail_binding__' || draft.h3ReferenceBinding?.pendingPictureSlots?.some((slot) =>
      slot.slotIndex === image.slotIndex && slot.role === image.role)
      ? `pending-tail-slot:${image.slotIndex}` : image.assetId }));
  const videoMappings = context.api?.runningHubMappedFields?.filter((field) => field.kind === 'video');
  const workflowVideos = context.workflow?.mapping.videos;
  const inputIdentity = sourceContentHash(JSON.stringify([identityImages, draft.audioReferences || [], draft.backend,
    draft.workflowId, draft.runningHubWorkflowId, draft.apiProfileId, boundarySemantics,
    { provider: context.api?.provider, model: context.api?.model, endpoint: context.api?.endpoint,
      requestTemplateHash: referenceTemplateHash(context),
      imageRoles: context.api?.runningHubImageRoles,
      imageMappings: context.api?.runningHubMappedFields?.filter((field) => field.kind === 'image'),
      ...(videoMappings?.length ? { videoMappings } : {}),
      rhtvMode: draft.parameters.rhtv_mode || context.api?.rhtvMode },
    context.workflow ? { id: context.workflow.id, images: context.workflow.mapping.images,
      ...(workflowVideos?.length ? { videos: workflowVideos } : {}),
      workflowHash: sourceContentHash(context.workflow.workflowJson) } : undefined,
    ...(videoCount ? [{ videoReferences: draft.videoReferences }] : [])]));
  return { version: 1, mode, authoredMode, boundarySemantics, images, audioCount, videoCount, inputIdentity,
    ...(draft.h3MediaModeUpdate ? { referenceUpdateCurrent: draft.h3MediaModeUpdate.inputIdentity === inputIdentity } : {}) };
};

export const videoH3MediaModeIssue = (contract: VideoH3MediaModeContract): string | undefined =>
  contract.referenceUpdateCurrent === false
    ? '本次参考图片、音频、视频或连接映射已变化，可直接使用当前稿生成，也可“更新本次参考”。'
    : contract.mode === 'full-reference' && contract.authoredMode !== 'full-reference'
      ? '本次使用多参考图片、音频或视频，已有稿采用三字段格式。可直接生成，也可“更新本次参考”调整参考说明。' : undefined;

/** The same deterministic compiler is used by explicit reference updates and
 * submission. Unknown historical prose stays compatible without an LLM call. */
export const refreshVideoH3MediaModeDraft = async (input: {
  project: Project; draft: VideoGenerationDraft; context: VideoH3ReferenceContext;
  /** Retained for call-site compatibility; reference compilation does not call it. */
  request: (system: string, user: string) => Promise<string>;
  isCurrent?: () => boolean;
}): Promise<VideoGenerationDraft> => {
  const assertCurrent = () => { if (input.isCurrent?.() === false) throw new Error('当前选图或视频稿已变化，参考更新未应用。'); };
  assertCurrent();
  let draft = structuredClone(input.draft);
  draft = { ...draft, prompt: stripVideoMotionPromptBinding(draft), videoReferenceBinding: undefined };
  if (draft.audioReferenceBinding && draft.prompt === draft.audioReferenceBinding.renderedPrompt) {
    draft = { ...draft, prompt: draft.audioReferenceBinding.basePrompt, audioReferenceBinding: undefined };
  }
  if (draft.reuseTaskId) throw new Error('原任务快照保持原稿；请先改用当前图片，再更新本次 H3。');
  const prepared = prepareVideoH3ReferenceDraft(input.project, draft, input.context).draft;
  assertCurrent();
  const contract = videoH3MediaModeContract(prepared, input.context);
  if (contract.mode === 'full-reference' && !prepared.h3ReferenceBinding?.executionIdentities) return { ...draft,
    h3ReferenceWarnings: prepared.h3ReferenceWarnings, h3MediaMode: videoH3MediaModeContract(draft, input.context) };
  const originalPrompt = draft.h3MediaModeUpdate?.sourcePrompt || draft.h3ReferenceBinding?.basePrompt || draft.prompt;
  const result: VideoGenerationDraft = { ...prepared,
    h3MediaModeUpdate: { version: 1, sourcePrompt: originalPrompt, updatedPrompt: prepared.prompt, inputIdentity: contract.inputIdentity } };
  result.h3MediaMode = videoH3MediaModeContract(result, input.context);
  return result;
};

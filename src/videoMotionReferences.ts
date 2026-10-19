import type { Project, ReferenceAsset, VideoTaskApiConfig } from './types';
import type { ComfyVideoWorkflowPreset, VideoGenerationDraft } from './videoGenerationTypes';
import type { VideoMotionReference } from './videoMotionTypes';
import { sourceContentHash } from './sourceContentHash';

export interface VideoMotionContext {
  backend: 'api' | 'comfyui';
  api?: Omit<VideoTaskApiConfig, 'apiKey'>;
  workflow?: Pick<ComfyVideoWorkflowPreset, 'mapping'>;
}
export interface VideoMotionCapability {
  supported: boolean;
  slotCount: number;
  slots: Array<{ slotIndex: number; bindingId: string; label: string }>;
  source: 'runninghub-mapping' | 'request-template' | 'comfyui-mapping' | 'unsupported';
}
export const isVideoDirectorMotionVideo = (asset: ReferenceAsset): boolean =>
  asset.mediaType === 'video' || asset.type === 'video' || Boolean(asset.mimeType?.startsWith('video/'));

/** A workflow label never establishes media capability. Only explicit input bindings do. */
export const videoMotionCapability = (context: VideoMotionContext): VideoMotionCapability => {
  let source: VideoMotionCapability['source'] = 'unsupported';
  let slots: VideoMotionCapability['slots'] = [];
  if (context.backend === 'comfyui') {
    slots = (context.workflow?.mapping.videos || []).map((binding, slotIndex) => ({ slotIndex,
      bindingId: JSON.stringify([binding.nodeId, binding.inputName]), label: `视频槽 ${slotIndex + 1}` }));
    if (slots.length) source = 'comfyui-mapping';
  } else if (context.api?.provider === 'runninghub' && context.api.runningHubMappedFields) {
    slots = context.api.runningHubMappedFields.filter((field) => field.kind === 'video' && Number.isSafeInteger(field.videoIndex) && field.videoIndex! >= 0)
      .map((field) => ({ slotIndex: field.videoIndex!, bindingId: JSON.stringify([field.nodeId, field.fieldName]), label: `视频槽 ${field.videoIndex! + 1}` }));
    if (slots.length) source = 'runninghub-mapping';
  } else if (context.api?.requestTemplate) {
    const indices = [...context.api.requestTemplate.matchAll(/\{\{video_([1-9]\d*)\}\}/gu)].map((match) => Number(match[1]) - 1);
    // An array template has no declared upper limit; the existing picker offers one clip.
    if (/\{\{(?:videos|video_references)\}\}/u.test(context.api.requestTemplate) && !indices.length) indices.push(0);
    slots = [...new Set(indices)].sort((a, b) => a - b).map((slotIndex) => ({ slotIndex, bindingId: `template-video-${slotIndex + 1}`, label: `视频槽 ${slotIndex + 1}` }));
    if (slots.length) source = 'request-template';
  }
  return { supported: slots.length > 0, slotCount: slots.length ? Math.max(...slots.map((slot) => slot.slotIndex)) + 1 : 0, slots, source };
};

export const stripVideoMotionPromptBinding = (draft: VideoGenerationDraft): string => {
  const binding = draft.videoReferenceBinding;
  if (!binding) return draft.prompt;
  if (draft.prompt === binding.renderedPrompt) return binding.basePrompt;
  let prompt = draft.prompt;
  for (const insertion of [...(binding.insertions || [])].reverse()) {
    const at = prompt.indexOf(insertion.text);
    if (at >= 0 && at === prompt.lastIndexOf(insertion.text)) prompt = prompt.slice(0, at) + (insertion.replacedText || '') + prompt.slice(at + insertion.text.length);
  }
  return prompt;
};

/** Array-only APIs enumerate actual attachments densely; named/template slot metadata is physical. */
export const videoMotionReferenceNumbers = (references: readonly VideoMotionReference[], context: { backend: 'api' | 'comfyui'; api?: Pick<VideoTaskApiConfig, 'provider' | 'requestTemplate'> }): number[] => {
  const template = context.backend === 'api' && context.api?.provider !== 'runninghub' ? context.api?.requestTemplate || '' : '';
  const dense = /\{\{videos\}\}/u.test(template) && !/\{\{(?:video_references|video_[1-9]\d*)\}\}/u.test(template);
  return references.map((reference, index) => (dense ? index : reference.slotIndex) + 1);
};

/** Render after image/audio bindings. This adds no actions, duration, camera moves or audio sources. */
export const renderVideoMotionDraft = (_project: Project, draft: VideoGenerationDraft, context: VideoMotionContext): VideoGenerationDraft => {
  if (draft.reuseTaskId) return draft;
  const basePrompt = stripVideoMotionPromptBinding(draft);
  const capability = videoMotionCapability(context);
  const references = capability.supported ? (draft.videoReferences || []).filter((reference) =>
    capability.slots.some((slot) => slot.slotIndex === reference.slotIndex && slot.bindingId === reference.bindingId)
    || capability.source === 'request-template' && /\{\{(?:videos|video_references)\}\}/u.test(context.api?.requestTemplate || '')) : [];
  if (!references.length) return { ...draft, prompt: basePrompt, videoReferences: [], videoReferenceBinding: undefined };
  const seedance = draft.source?.promptFormat === 'seedance';
  const numbers = videoMotionReferenceNumbers(references, context);
  const lines = references.map((reference, index) => `${seedance ? '@' : '<'}Video ${numbers[index]}${seedance ? '' : '>'} → Motion reference only: use the visible action timing, weight transfer and contact response where applicable to the authored actions. Keep the authored action order and counts; do not copy the clip's people, plot, camera edits or music.${reference.notes?.trim() ? ` Reference use: ${reference.notes.trim()}` : ''}`).join('\n');
  const section = seedance
    ? /^[ \t]*(?:#{1,6}[ \t]+)?(?:参考素材与职责|(?:References?|Reference materials?|Reference assets?) and responsibilities)[ \t]*(?:[:：][ \t]*|(?=\r?$))/imu.exec(basePrompt)
    : /^(?:subject_definitions|integrated_multimodal_description)[ \t]*:[ \t]*/mu.exec(basePrompt);
  const at = section ? section.index + section[0].length : basePrompt.length;
  const text = `\n${lines}\n`;
  const prompt = basePrompt.slice(0, at) + text + basePrompt.slice(at);
  return { ...draft, prompt, videoReferences: references,
    videoReferenceBinding: { version: 1, basePrompt, renderedPrompt: prompt, insertions: [{ at, text }] },
    ...(draft.source ? { source: { ...draft.source, promptFingerprint: sourceContentHash(prompt) } } : {}) };
};
export const prepareVideoMotionDraft = renderVideoMotionDraft;

import type { Project, ReferenceAsset, VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft } from './videoGenerationTypes';
import type { AudioRetainMode, FrozenVideoAudioReference, ProjectVoicePresets, VideoAudioReference, VideoAudioTarget } from './videoAudioTypes';
import { sourceContentHash } from './sourceIntegrity';

export const audioRetainModes: ReadonlyArray<{ id: AudioRetainMode; label: string }> = [
  { id: 'reference', label: '参考音色，使用本段台词' },
  { id: 'fully_copy', label: '完全使用原声音' },
  { id: 'partially_copy', label: '部分使用原音频' },
  { id: 'weak_reference', label: '参考曲风、氛围' },
];

type AudioApi = VideoTaskApiConfig | Omit<VideoTaskApiConfig, 'apiKey'> | undefined;
export const isVideoDirectorAudio = (asset: ReferenceAsset): boolean => asset.mediaType === 'audio'
  || asset.type === 'audio' || Boolean(asset.mimeType?.startsWith('audio/'));
export const videoAudioMappedFields = (api: AudioApi) => api?.provider === 'runninghub'
  ? (api.runningHubMappedFields || []).filter((field) => field.kind === 'audio').sort((a, b) => (a.audioIndex || 0) - (b.audioIndex || 0)) : [];
export const videoAudioSlotCount = (api: AudioApi): number => videoAudioMappedFields(api)
  .reduce((count, field) => Math.max(count, (field.audioIndex || 0) + 1), 0);
export const videoAudioBindingId = (api: AudioApi, slotIndex: number): string => {
  const field = videoAudioMappedFields(api).find((entry) => entry.audioIndex === slotIndex);
  return field ? JSON.stringify([field.nodeId, field.fieldName]) : `unmapped-audio-${slotIndex + 1}`;
};
export const videoAudioTargetLabel = (project: Pick<Project, 'characters'>, target: VideoAudioTarget): string => target.kind === 'character'
  ? project.characters.find((character) => character.id === target.characterId)?.name || '人物已不存在'
  : target.kind === 'voiceover' ? '旁白' : '音乐 / 环境氛围';

const scalarText = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 2048;
export const normalizeProjectVoicePresets = (value: unknown): ProjectVoicePresets | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Partial<ProjectVoicePresets>;
  const preset = (entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !scalarText((entry as { assetId?: unknown }).assetId)) return undefined;
    const candidate = entry as { assetId: string; retainMode?: AudioRetainMode; notes?: string };
    return { assetId: candidate.assetId, retainMode: audioRetainModes.some((mode) => mode.id === candidate.retainMode) ? candidate.retainMode : 'reference' as const,
      ...(typeof candidate.notes === 'string' ? { notes: candidate.notes.slice(0, 2000) } : {}) };
  };
  const characters = Object.fromEntries(Object.entries(source.characters && typeof source.characters === 'object' ? source.characters : {})
    .flatMap(([id, entry]) => { const next = preset(entry); return scalarText(id) && next ? [[id, next]] : []; }));
  return { characters, ...(preset(source.narrator) ? { narrator: preset(source.narrator) } : {}) };
};

/** Remove only the exact generated insertion, even when the surrounding authored text was edited. */
export const stripVideoAudioPromptBinding = (prompt: string, binding: VideoGenerationDraft['audioReferenceBinding']): string => {
  if (!binding || binding.renderedPrompt.length <= binding.basePrompt.length) return prompt;
  const { basePrompt, renderedPrompt } = binding;
  let prefix = 0;
  while (prefix < basePrompt.length && basePrompt[prefix] === renderedPrompt[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < basePrompt.length - prefix
    && basePrompt[basePrompt.length - suffix - 1] === renderedPrompt[renderedPrompt.length - suffix - 1]) suffix += 1;
  // A replacement is not our renderer's single insertion, so it cannot authorize deleting user text.
  if (prefix + suffix !== basePrompt.length) return prompt;
  const inserted = renderedPrompt.slice(prefix, renderedPrompt.length - suffix);
  const at = prompt.indexOf(inserted);
  if (at < 0 || at !== prompt.lastIndexOf(inserted)) return prompt;
  return prompt.slice(0, at) + prompt.slice(at + inserted.length);
};

const authoredPrompt = (draft: VideoGenerationDraft): string => {
  const prompt = stripVideoAudioPromptBinding(draft.prompt, draft.audioReferenceBinding);
  return draft.h3ReferenceBinding && prompt === draft.h3ReferenceBinding.renderedPrompt ? draft.h3ReferenceBinding.basePrompt : prompt;
};
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only actual dialogue evidence can bring in a preset. Visible cast is insufficient. */
export const videoAudioSpeakingCharacterIds = (project: Project, draft: VideoGenerationDraft): string[] => {
  const prompt = authoredPrompt(draft);
  const board = project.storyboards.find((entry) => entry.id === draft.source?.storyboardId);
  const paired = board && [board.finalPrompt, board.englishPrompt, board.officialPromptZh, board.officialPromptEn, board.seedance25Output?.promptZh, board.seedance25Output?.promptEn].includes(prompt);
  const ids = new Set<string>();
  const uniqueSpeaker = (speaker?: string) => {
    if (!speaker) return undefined;
    const matches = project.characters.filter((character) => [character.name, ...(character.aliases || [])].some((name) => name === speaker.trim()));
    return matches.length === 1 ? matches[0].id : undefined;
  };
  if (paired) {
    for (const cue of board.audioLedger || []) if (cue.kind === 'dialogue' && cue.text?.trim()) {
      const id = cue.speakerId || uniqueSpeaker(cue.speaker);
      if (id && project.characters.some((character) => character.id === id)) ids.add(id);
    }
    const participation = board.h3CharacterParticipation;
    if (participation && board.officialPromptZh && participation.promptFingerprint === sourceContentHash(board.officialPromptZh)
      && (prompt === board.officialPromptZh || prompt === board.officialPromptEn && board.officialPromptEnSource === board.officialPromptZh)) {
      for (const entry of participation.characters) if (entry.speaking && entry.presence !== 'mentioned') ids.add(entry.characterId);
    }
  }
  const identities = draft.h3ReferenceBinding?.identities.characters || (paired ? draft.source?.language === 'en' ? board.h3IdentityBindingsEn?.characters : board.h3IdentityBindings?.characters : []) || [];
  for (const character of project.characters) {
    const identity = identities.find((entry) => entry.characterId === character.id);
    const uniqueToken = identity?.speakerToken && identities.filter((entry) => entry.speakerToken === identity.speakerToken).length === 1;
    const labels = [...[character.name, ...(character.aliases || [])].filter((label) => uniqueSpeaker(label) === character.id),
      ...(uniqueToken ? [identity!.speakerToken!] : [])];
    // Exact speaker labels around dialogue tags or explicit said/说 cues; never a filename or cast order.
    if (labels.some((label) => new RegExp(`(?:^|[\\n。.!?；;])\\s*${escaped(label)}\\s*(?:(?:说道|说|问|答|喊|低语|says?|asks?|replies?)\\s*[:：]\\s*\\S|[:：]\\s*(?:[“"「『]\\s*[^\\s”"」』]|<d>\\s*[^\\s<]))`, 'imu').test(prompt)
      || new RegExp(`<s>\\s*${escaped(label)}\\s*</s>`, 'iu').test(prompt))) ids.add(character.id);
  }
  return project.characters.filter((character) => ids.has(character.id)).map((character) => character.id);
};

export const resolveVideoAudioReferences = (project: Project, draft: VideoGenerationDraft, api: AudioApi): VideoAudioReference[] => {
  if (draft.audioSelectionMode === 'none') return [];
  if (draft.reuseTaskId || draft.audioSelectionMode === 'override' || !draft.audioSelectionMode && draft.audioReferences?.length) return structuredClone(draft.audioReferences || []);
  if (!videoAudioSlotCount(api)) return [];
  const presets = project.voicePresets;
  if (!presets) return [];
  const references: VideoAudioReference[] = [];
  const add = (assetId: string, target: VideoAudioTarget, retainMode: AudioRetainMode = 'reference', notes?: string) => {
    const slotIndex = references.length;
    references.push({ bindingId: videoAudioBindingId(api, slotIndex), slotIndex, assetId, target, retainMode, ...(notes ? { notes } : {}) });
  };
  for (const id of videoAudioSpeakingCharacterIds(project, draft)) {
    const preset = presets.characters[id];
    if (preset) add(preset.assetId, { kind: 'character', characterId: id }, preset.retainMode, preset.notes);
  }
  const board = project.storyboards.find((entry) => entry.id === draft.source?.storyboardId);
  const prompt = authoredPrompt(draft);
  const paired = board && [board.finalPrompt, board.englishPrompt, board.officialPromptZh, board.officialPromptEn, board.seedance25Output?.promptZh, board.seedance25Output?.promptEn].includes(prompt);
  if (presets.narrator && (paired && board.audioLedger?.some((cue) => cue.kind === 'voiceover' && Boolean(cue.text?.trim()))
    || /(?:^|\n)\s*(?:旁白|画外旁白|narrator|voiceover)\s*[:：]/imu.test(prompt))) {
    add(presets.narrator.assetId, { kind: 'voiceover' }, presets.narrator.retainMode, presets.narrator.notes);
  }
  return references;
};

export const validateVideoAudioReferences = (project: Project, draft: VideoGenerationDraft, api: AudioApi, frozenAudios?: readonly FrozenVideoAudioReference[]): string[] => {
  const references = draft.audioReferences || [];
  if (!references.length) return [];
  const issues: string[] = [];
  if (draft.backend !== 'api' || api?.provider !== 'runninghub') return ['参考音频需要选择已配置音频槽的 RunningHub 工作流。'];
  const capacity = videoAudioSlotCount(api);
  const occupied = new Set<number>();
  for (const reference of references) {
    const slot = reference.slotIndex;
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= capacity) { issues.push(`音频槽 ${slot + 1} 超出当前工作流的 ${capacity} 个输入，请调整本段声源。`); continue; }
    if (occupied.has(slot)) issues.push(`音频槽 ${slot + 1} 重复绑定。`);
    occupied.add(slot);
    if (reference.bindingId !== videoAudioBindingId(api, slot)) issues.push(`音频槽 ${slot + 1} 的工作流节点已变化，请重新选择本段音频映射。`);
    const frozen = frozenAudios?.find((entry) => entry.bindingId === reference.bindingId && entry.assetId === reference.assetId && entry.slotIndex === slot);
    const asset = project.assets.find((entry) => entry.id === reference.assetId);
    if (!frozen && (!asset || !isVideoDirectorAudio(asset) || asset.missing)) issues.push(`音频槽 ${slot + 1} 的文件不可用，请重新选择。`);
    if (!frozen && asset && !/\.(?:mp3|wav|flac)$/iu.test(asset.fileName || asset.name) && !/^(?:audio\/(?:mpeg|mp3|wav|x-wav|flac|x-flac))$/iu.test(asset.mimeType || '')) issues.push(`音频槽 ${slot + 1} 请使用 MP3、WAV 或 FLAC。`);
    if (!audioRetainModes.some((mode) => mode.id === reference.retainMode)) issues.push(`音频槽 ${slot + 1} 的参考方式无效。`);
    if (!reference.target || !['character', 'voiceover', 'ambience'].includes(reference.target.kind)) issues.push(`音频槽 ${slot + 1} 请设置人物、旁白或氛围用途。`);
    else if (reference.target.kind === 'character' && !frozen) {
      const characterId = reference.target.characterId;
      if (!project.characters.some((entry) => entry.id === characterId)) issues.push(`音频槽 ${slot + 1} 的人物已不存在，请重新绑定。`);
    }
  }
  return issues;
};

/** Image serialization runs first; this renderer changes only the submitted draft. */
export const prepareVideoAudioDraft = (project: Project, draft: VideoGenerationDraft, api: AudioApi): VideoGenerationDraft => {
  if (draft.reuseTaskId) return draft;
  const references = resolveVideoAudioReferences(project, draft, api);
  return renderVideoAudioDraft(project, { ...draft, audioReferences: references }, api);
};

/** Re-render a frozen selection after image rebinding; never resolve current project presets. */
export const renderVideoAudioDraft = (project: Project, draft: VideoGenerationDraft, _api?: AudioApi): VideoGenerationDraft => {
  const references = draft.audioReferences || [];
  const previous = draft.audioReferenceBinding;
  const basePrompt = stripVideoAudioPromptBinding(draft.prompt, previous);
  if (!references.length) return previous
    ? { ...draft, prompt: basePrompt, audioReferences: [], audioReferenceBinding: undefined,
      ...(draft.source ? { source: { ...draft.source, promptFingerprint: sourceContentHash(basePrompt) } } : {}) }
    : draft.audioReferences?.length || draft.audioSelectionMode === 'none' ? { ...draft, audioReferences: [] } : draft;
  const english = draft.source?.language === 'en';
  const identities = draft.h3ReferenceBinding?.identities.characters || [];
  const lines = references.map((reference) => {
    const targetCharacterId = reference.target.kind === 'character' ? reference.target.characterId : undefined;
    const identity = targetCharacterId ? identities.find((entry) => entry.characterId === targetCharacterId) : undefined;
    const target = videoAudioTargetLabel(project, reference.target).replace(/[\r\n]/gu, ' ');
    const speaker = identity?.speakerToken ? ` (${identity.speakerToken})` : '';
    const mode = reference.retainMode;
    const use = mode === 'reference' ? english ? 'Use the voice timbre with this segment’s existing dialogue and speaker timing.' : '参考音色，使用本段已有台词和原说话时序。'
      : mode === 'fully_copy' ? english ? 'Use the original sound according to the workflow’s audio retention behavior.' : '按工作流留存方式使用原声音。'
        : mode === 'partially_copy' ? english ? 'Partially use the original audio as specified.' : '按使用说明部分使用原音频。'
          : english ? 'Reference only the musical style or ambience.' : '参考曲风或声音氛围。';
    return `${english ? 'Audio' : '音频'} ${reference.slotIndex + 1} <Audio ${reference.slotIndex + 1}> → ${target}${speaker}; ${mode}: ${use}${reference.notes?.trim() ? ` ${reference.notes.trim().replace(/[\r\n]/gu, ' ')}` : ''}`;
  });
  const instruction = lines.join(' ');
  const h3 = /(^|\n)([ \t]*integrated_multimodal_description[ \t]*:[ \t]*)([^\n]*)/u;
  const renderedPrompt = h3.test(basePrompt) ? basePrompt.replace(h3, (_whole, prefix: string, header: string, body: string) => `${prefix}${header}${body}${body ? ' ' : ''}${instruction}`)
    : `${basePrompt}\n\n${instruction}`;
  return { ...draft, prompt: renderedPrompt, audioReferences: references,
    audioReferenceBinding: { version: 1, basePrompt, renderedPrompt },
    ...(draft.source ? { source: { ...draft.source, promptFingerprint: sourceContentHash(renderedPrompt) } } : {}) };
};

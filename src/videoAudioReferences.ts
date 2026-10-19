import type { Project, ReferenceAsset, VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft } from './videoGenerationTypes';
import type { AudioRetainMode, FrozenVideoAudioReference, ProjectVoicePresets, VideoAudioReference, VideoAudioTarget, VideoVoicePreset } from './videoAudioTypes';
import { sourceContentHash } from './sourceIntegrity';
import { videoAudioCapability } from './videoAudioCapabilities';
import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';
import { cleanSeedanceReferenceClaims } from './seedanceReferenceClaims';

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
  ? (Array.isArray(api.runningHubMappedFields) ? api.runningHubMappedFields : []).filter((field) => field?.kind === 'audio'
    && typeof field.nodeId === 'string' && field.nodeId.trim() && typeof field.fieldName === 'string' && field.fieldName.trim()
    && Number.isSafeInteger(field.audioIndex) && field.audioIndex! >= 0).sort((a, b) => a.audioIndex! - b.audioIndex!) : [];
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
  if (binding?.insertions?.length) {
    if (prompt === binding.renderedPrompt) return binding.basePrompt;
    let result = prompt;
    // A changed instruction is authored text now. Never remove a partial match or a duplicate occurrence.
    for (const insertion of [...binding.insertions].reverse()) {
      const at = result.indexOf(insertion.text);
      if (at >= 0 && at === result.lastIndexOf(insertion.text)) result = result.slice(0, at) + (insertion.replacedText || '') + result.slice(at + insertion.text.length);
    }
    return result;
  }
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
  if (draft.seedanceReferenceBinding && prompt === draft.seedanceReferenceBinding.renderedPrompt) return draft.seedanceReferenceBinding.basePrompt;
  return draft.h3ReferenceBinding && prompt === draft.h3ReferenceBinding.renderedPrompt ? draft.h3ReferenceBinding.basePrompt : prompt;
};
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const audibleDialogue = (text?: string): boolean => {
  const content = text?.replace(/^\s*\[[^\]\r\n]+\]\s*/u, '').trim();
  return Boolean(content) && !/^(?:[（(]?\s*)?(?:无(?:台词|对白|发话)|全员无(?:台词|对白)|沉默|静默|闭口(?:倾听)?|不说话|silence|silent|no\s+(?:dialogue|speech)|N\/A)(?:\s*[）)]?[。.!！]?\s*)$/iu.test(content!);
};

const labelledDialogue = (prompt: string, labels: string[]): boolean => labels.some((label) => {
  const name = escaped(label);
  const clock = '(?:\\d{1,2}:\\d{2}(?:\\.\\d+)?|\\d+(?:\\.\\d+)?\\s*s)';
  const timing = `(?:(?:At\\s+)?${clock}(?:\\s*[-–—~至]\\s*${clock})?\\s*(?:[（(][^\\n）)]*[）)]\\s*)?)?`;
  const qualifiers = '(?:\\s*[（(][^\\n）)]*[）)])*';
  const cue = '(?:说道|说|问|答|回答|喊|低语|says?|asks?|replies?|answers?|whispers?)';
  const line = new RegExp(`(?:^|[\\n。.!?；;])\\s*(?:[-*•]\\s*)?${timing}${name}${qualifiers}\\s*(?:${cue}\\s*)?[:：]\\s*(?:[“"「『]([^”"」』\\n]+)[”"」』]|<d>([^<]+)</d>)`, 'gimu');
  for (const match of prompt.matchAll(line)) if (audibleDialogue(match[1] || match[2])) return true;
  // H3 speaker tokens count only beside a nonempty dialogue, never in a subject definition or silent cast list.
  const tag = new RegExp(`<s>\\s*${name}\\s*</s>\\s*(?:[:：]\\s*)?<d>([^<]+)</d>`, 'gimu');
  for (const match of prompt.matchAll(tag)) if (audibleDialogue(match[1])) return true;
  const h3 = new RegExp(`${name}${qualifiers}\\s*(?:${cue}\\s*)?[:：]?\\s*<d>([^<]+)</d>`, 'gimu');
  for (const match of prompt.matchAll(h3)) if (audibleDialogue(match[1])) return true;
  return false;
});

/** Only actual dialogue evidence can bring in a preset. Visible cast is insufficient. */
export const videoAudioSpeakingCharacterIds = (project: Project, draft: VideoGenerationDraft): string[] => {
  const prompt = authoredPrompt(draft);
  const board = project.storyboards.find((entry) => entry.id === draft.source?.storyboardId);
  const paired = board && [board.finalPrompt, board.englishPrompt, board.officialPromptZh, board.officialPromptEn, board.seedance25Output?.promptZh, board.seedance25Output?.promptEn].includes(prompt);
  const ids = new Set<string>();
  const directIds = new Set<string>();
  const uniqueSpeaker = (speaker?: string) => {
    if (!speaker) return undefined;
    const matches = project.characters.filter((character) => [character.name, ...(character.aliases || [])].some((name) => name === speaker.trim()));
    return matches.length === 1 ? matches[0].id : undefined;
  };
  if (paired) {
    for (const cue of board.audioLedger || []) if (cue.kind === 'dialogue' && audibleDialogue(cue.text)) {
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
    if (labelledDialogue(prompt, labels)) directIds.add(character.id);
  }
  // The current explicit dialogue outranks a paired board's older ledger.
  return project.characters.filter((character) => (directIds.size ? directIds : ids).has(character.id)).map((character) => character.id);
};

export const resolveVideoAudioReferences = (project: Project, draft: VideoGenerationDraft, api: AudioApi): VideoAudioReference[] => {
  if (draft.audioSelectionMode === 'none') return [];
  if (draft.reuseTaskId || draft.audioSelectionMode === 'override' || !draft.audioSelectionMode && draft.audioReferences?.length) return structuredClone(draft.audioReferences || []);
  if (!videoAudioSlotCount(api)) return [];
  const presets = project.voicePresets;
  const references: VideoAudioReference[] = [];
  const add = (assetId: string, target: VideoAudioTarget, retainMode: AudioRetainMode = 'reference', notes?: string) => {
    const slotIndex = references.length;
    references.push({ bindingId: videoAudioBindingId(api, slotIndex), slotIndex, assetId, target, retainMode, ...(notes ? { notes } : {}) });
  };
  for (const id of videoAudioSpeakingCharacterIds(project, draft)) {
    const preset = videoAudioCharacterPreset(project, id);
    if (preset) add(preset.assetId, { kind: 'character', characterId: id }, preset.retainMode, preset.notes);
  }
  const board = project.storyboards.find((entry) => entry.id === draft.source?.storyboardId);
  const prompt = authoredPrompt(draft);
  const paired = board && [board.finalPrompt, board.englishPrompt, board.officialPromptZh, board.officialPromptEn, board.seedance25Output?.promptZh, board.seedance25Output?.promptEn].includes(prompt);
  if (presets?.narrator && (paired && board.audioLedger?.some((cue) => cue.kind === 'voiceover' && audibleDialogue(cue.text))
    || /(?:^|\n)\s*(?:旁白|画外旁白|narrator|voiceover)\s*[:：]/imu.test(prompt))) {
    add(presets.narrator.assetId, { kind: 'voiceover' }, presets.narrator.retainMode, presets.narrator.notes);
  }
  return references;
};

/** A separately chosen legacy preset wins; a character's confirmed sample is the inheritance fallback. */
export const videoAudioCharacterPreset = (project: Project, characterId: string): VideoVoicePreset | undefined => {
  const explicit = project.voicePresets?.characters[characterId];
  if (explicit) return explicit;
  const character = project.characters.find((entry) => entry.id === characterId);
  const profile = (character as typeof character & { voiceProfile?: { referenceAssetId?: string; notes?: string } })?.voiceProfile;
  return profile?.referenceAssetId ? { assetId: profile.referenceAssetId, retainMode: 'reference', ...(profile.notes ? { notes: profile.notes } : {}) } : undefined;
};

export const validateVideoAudioReferences = (project: Project, draft: VideoGenerationDraft, api: AudioApi, frozenAudios?: readonly FrozenVideoAudioReference[]): string[] => {
  const references = draft.audioReferences || [];
  if (!references.length) return [];
  const issues: string[] = [];
  const capability = videoAudioCapability(api, draft.backend);
  if (capability.status !== 'supported') return [capability.reason];
  const authored = stripVideoAudioPromptBinding(draft.prompt, draft.audioReferenceBinding);
  if (isSeedanceAudioDraft(draft, authored) && !seedanceAudioSection(authored)) issues.push('当前 Seedance 稿无法唯一定位“参考素材与职责”章节，请先确认原稿；参考音频用途尚未写入。');
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

const isSeedanceAudioDraft = (draft: VideoGenerationDraft, prompt: string): boolean => draft.source?.promptFormat === 'seedance'
  || Boolean(draft.seedanceReferenceBinding) || /^\s*(?:#{1,6}\s+)?(?:参考素材与职责|(?:References?|Reference materials?|Reference assets?) and responsibilities)\s*[:：]?\s*$/imu.test(prompt);
const seedanceAudioSection = (prompt: string): { start: number; end: number } | undefined => {
  const masked = maskVideoPictureReferenceLiterals(prompt);
  const headings = [...masked.matchAll(/^[ \t]*(?:#{1,6}[ \t]+)?(?:参考素材与职责|(?:References?|Reference materials?|Reference assets?) and responsibilities)[ \t]*(?:[:：][ \t]*|(?=\r?$))/gimu)];
  if (headings.length !== 1) return undefined;
  const start = headings[0].index! + headings[0][0].length;
  const following = /^[ \t]*(?:#{1,6}[ \t]+)?(?:主体连续性|(?:Subject|Character) continuity)[ \t]*(?:[:：][ \t]*|(?=\r?$))/imu.exec(masked.slice(start));
  return following ? { start, end: start + following.index } : undefined;
};

const audioUse = (mode: AudioRetainMode, english: boolean): string => mode === 'reference'
  ? english ? 'Use the voice timbre with this segment’s existing dialogue and speaker timing.' : '参考音色，使用本段已有台词和原说话时序。'
  : mode === 'fully_copy' ? english ? 'Use the original sound according to the workflow’s audio retention behavior.' : '按工作流留存方式使用原声音。'
    : mode === 'partially_copy' ? english ? 'Partially use the original audio as specified.' : '按使用说明部分使用原音频。'
      : english ? 'Reference only the musical style or ambience.' : '参考曲风或声音氛围。';
const audioLiteral = (text: string): string => text.replace(/[\r\n\t]+/gu, ' ').replace(/@(?=Audio\s+\d+)/gu, '＠')
  .replace(/<(\/?(?:Audio|Subject|Picture|Video)\s*\d*)>/gu, '〈$1〉').trim();

/** Image serialization runs first; this renderer changes only the submitted draft. */
export const prepareVideoAudioDraft = (project: Project, draft: VideoGenerationDraft, api: AudioApi): VideoGenerationDraft => {
  if (draft.reuseTaskId) return draft;
  const references = resolveVideoAudioReferences(project, draft, api);
  return renderVideoAudioDraft(project, { ...draft, audioReferences: references }, api);
};

/** Re-render a frozen selection after image rebinding; never resolve current project presets. */
export const renderVideoAudioDraft = (project: Project, draft: VideoGenerationDraft, _api?: AudioApi): VideoGenerationDraft => {
  if (draft.reuseTaskId) return draft;
  const references = draft.audioReferences || [];
  const previous = draft.audioReferenceBinding;
  const basePrompt = stripVideoAudioPromptBinding(draft.prompt, previous);
  if (!references.length) return previous
    ? { ...draft, prompt: basePrompt, audioReferences: [], audioReferenceBinding: undefined,
      ...(draft.source ? { source: { ...draft.source, promptFingerprint: sourceContentHash(basePrompt) } } : {}) }
    : draft.audioReferences?.length || draft.audioSelectionMode === 'none' ? { ...draft, audioReferences: [] } : draft;
  const english = draft.source?.language === 'en';
  const h3Binding = draft.h3ReferenceBinding;
  const identities = (basePrompt === h3Binding?.renderedPrompt ? h3Binding.executionIdentities : undefined)?.characters
    || h3Binding?.identities.characters || [];
  const entries = references.map((reference) => {
    const targetCharacterId = reference.target.kind === 'character' ? reference.target.characterId : undefined;
    const identity = targetCharacterId ? identities.find((entry) => entry.characterId === targetCharacterId) : undefined;
    const target = audioLiteral(videoAudioTargetLabel(project, reference.target));
    const speaker = identity?.speakerToken ? ` (${identity.speakerToken.replace(/^[（(]|[）)]$/gu, '')})` : '';
    const mode = reference.retainMode;
    const use = `${audioUse(mode, english)}${reference.notes?.trim() ? ` ${audioLiteral(reference.notes)}` : ''}`;
    return { reference, target, speaker, use, character: targetCharacterId ? project.characters.find((entry) => entry.id === targetCharacterId) : undefined, identity };
  });
  const newline = basePrompt.includes('\r\n') ? '\r\n' : '\n';
  const insertions: NonNullable<NonNullable<VideoGenerationDraft['audioReferenceBinding']>['insertions']> = [];
  const structural = maskVideoPictureReferenceLiterals(basePrompt);
  const definition = /^subject_definitions:[ \t]*/mu.exec(structural);
  const detailed = /^detailed_description:[ \t]*/mu.exec(structural);
  if (definition && detailed) {
    const subjectEnd = /^summary:/mu.exec(structural.slice(definition.index + definition[0].length));
    const subjects = basePrompt.slice(definition.index + definition[0].length, subjectEnd ? definition.index + definition[0].length + subjectEnd.index : detailed.index);
    const lines = entries.filter(({ reference }) => !subjects.includes(`<Audio ${reference.slotIndex + 1}>`))
      .map(({ reference, target, speaker, use }) => `<Audio ${reference.slotIndex + 1}> → ${target}${speaker}; ${reference.retainMode}: ${use}`);
    if (lines.length) insertions.push({ at: definition.index + definition[0].length, text: `${newline}${lines.join(newline)}${newline}` });
    const descriptionStart = detailed.index + detailed[0].length;
    const end = /^overall_soundscape:/mu.exec(structural.slice(descriptionStart));
    const description = basePrompt.slice(descriptionStart, end ? descriptionStart + end.index : undefined);
    const shots = [...structural.slice(descriptionStart, descriptionStart + description.length).matchAll(/\[Shot\s+(\d+)\]/gu)];
    for (const [index, shot] of shots.entries()) {
      const shotBodyStart = descriptionStart + shot.index! + shot[0].length;
      const body = basePrompt.slice(shotBodyStart, index + 1 < shots.length ? descriptionStart + shots[index + 1].index! : descriptionStart + description.length);
      const applicable = entries.filter(({ reference }) => !body.includes(`<Audio ${reference.slotIndex + 1}>`)).filter(({ reference, character, identity }) => reference.target.kind === 'character'
        ? labelledDialogue(body, [...(character ? [character.name, ...(character.aliases || [])] : []), ...(identity?.speakerToken ? [identity.speakerToken] : [])])
        : reference.target.kind === 'voiceover' ? /(?:旁白|画外旁白|narrator|voiceover)\s*(?:[:：]|(?:says?|说)\s*<d>)/iu.test(body)
          : /<sound>|音效|环境声|风声|水声|声响|\b(?:ambience|ambient|sound|wind|music)\b/iu.test(body));
      const cutHeader = /^\s*At \d{2}:[0-5]\d\.\d{3}\b[,，.:：]?/u.exec(body);
      if (applicable.length) insertions.push({ at: shotBodyStart + (cutHeader?.[0].length || 0),
        text: ` ${english ? `Shot ${shot[1]} audio use` : `镜头 ${shot[1]} 音频用途`}：${applicable.map(({ reference, target }) => `${target} <Audio ${reference.slotIndex + 1}>`).join(english ? '; ' : '；')}${english ? '. Keep the existing dialogue and sound timing.' : '；沿用本镜原有对白与声音时序。'}` });
    }
  } else if (/^integrated_multimodal_description:/mu.test(basePrompt)) {
    // Keep the authored three-field prompt usable with the selected audio.
    // Never manufacture a mixed three/six-field document from an authored H3 prompt.
  } else if (isSeedanceAudioDraft(draft, basePrompt)) {
    const section = seedanceAudioSection(basePrompt);
    if (section) {
      const lines = entries.map(({ reference, target, use }) => `@Audio ${reference.slotIndex + 1}${english ? ': ' : '：'}${target}; ${reference.retainMode}: ${use}`);
      const sectionBody = basePrompt.slice(section.start, section.end);
      const current = cleanSeedanceReferenceClaims(sectionBody, { hasImages: draft.references.length > 0, hasAudio: true, hasVideo: Boolean(draft.videoReferences?.length) });
      // Record the exact replacement so clearing the voice selection restores
      // the image-bound draft, including authored scene facts and quotations.
      insertions.push({ at: section.start, replacedText: sectionBody,
        text: `${newline}${lines.join(newline)}${newline}${current.text}${current.text.endsWith(newline) ? '' : newline}` });
    }
  } else {
    // Unstructured, non-H3 drafts keep the legacy single audio-note convention.
    const lines = entries.map(({ reference, target, speaker, use }) => `${english ? 'Audio' : '音频'} ${reference.slotIndex + 1} <Audio ${reference.slotIndex + 1}> → ${target}${speaker}; ${reference.retainMode}: ${use}`);
    insertions.push({ at: basePrompt.length, text: `${newline}${newline}${lines.join(' ')}` });
  }
  let renderedPrompt = basePrompt;
  for (const insertion of [...insertions].sort((left, right) => right.at - left.at)) renderedPrompt = renderedPrompt.slice(0, insertion.at) + insertion.text
    + renderedPrompt.slice(insertion.at + (insertion.replacedText?.length || 0));
  return { ...draft, prompt: renderedPrompt, audioReferences: references,
    audioReferenceBinding: insertions.length ? { version: 1, basePrompt, renderedPrompt, insertions } : undefined,
    ...(draft.source ? { source: { ...draft.source, promptFingerprint: sourceContentHash(renderedPrompt) } } : {}) };
};

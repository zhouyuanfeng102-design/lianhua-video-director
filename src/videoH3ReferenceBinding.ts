import type { Character, H3IdentityBindings, H3PerformancePlan, Location, Project, ReferenceAsset, ReferenceRole, VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft, VideoImageReference } from './videoGenerationTypes';
import type { VideoReferenceUsageContext } from './videoReferenceUsage';
import { videoMiddleFrameOrdinal, videoReferenceSlotIndex } from './videoReferenceSlots';
import { getH3IdentityBindingIssues, normalizeH3IdentityBindings } from './h3IdentityBindings';
import { officialH3ContextForStoryboard } from './officialH3Context';
import { characterParticipationAliases, resolvePromptCharacterParticipation, resolveStoryboardCharacterParticipation } from './characterParticipation';
import { videoReferenceCharacterOwners, videoReferenceCharacterBindingWarning, type VideoCharacterReferenceState } from './videoReferenceCharacters';
import { maskVideoPictureReferenceLiterals as maskReferenceLiterals, videoPictureReferencePattern as pictureReferencePattern } from './videoPictureReferences';
import { prepareVideoSeedanceReferenceDraft } from './videoSeedanceReferenceBinding';
import { videoSeedanceReferencePlan } from './videoSeedanceReferencePlan';
import { renderVideoSeedanceSpecification } from './videoSeedanceSpecification';
import { sourceContentHash } from './sourceContentHash';
import { videoH3MediaModeContract, videoH3MediaModeIssue } from './videoH3MediaMode';
import { assetReferenceLocationOwners } from './assetCharacterBinding';
import { renderH3ReferenceExecution, type H3ReferenceExecutionCharacter } from './h3ReferenceExecution';
import { videoMotionReferenceNumbers } from './videoMotionReferences';
import { resolveRunningHubH3PictureNumbers } from './runningHubH3ReferenceImages';
import { resolveComfyH3PictureNumbers } from './h3ReferenceImageOrder';
export { collectVideoPictureReferenceNumbers } from './videoPictureReferences';
export { videoReferenceCharacterOwners, videoReferenceCharacterBindingWarning } from './videoReferenceCharacters';

/** This is an editing provenance record, not a second prompt or an AI review.
 * Rendering always starts from the same authored text, so repeated selections
 * cannot accumulate instructions or move dialogue/shot timing. */
export interface VideoH3ReferenceBinding {
  version: 1;
  projectId: string;
  basePrompt: string;
  identities: H3IdentityBindings;
  renderedPrompt: string;
  /** Exact authored language, recorded only with this source provenance. */
  sourceLanguage?: 'zh' | 'en';
  /** Original persisted manifest, never reconstructed from current slot order. */
  sourcePictures?: Array<{ number: number; assetId: string }>;
  /** Explicit future-tail slots; only their eventual pixels are unresolved. */
  pendingPictureSlots?: Array<{ number: number; slotIndex: number; role: ReferenceRole }>;
  /** Picture provenance can remain valid when legacy identity metadata is damaged. */
  identityBindingWarning?: string;
  /** Actual result of rendering this exact request, retained by frozen retries. */
  characterStates?: VideoH3CharacterReferenceState[];
  /** Request-local Subject/Picture/voice rendering; source identities stay paired with basePrompt. */
  executionIdentities?: H3IdentityBindings;
  executionCharacters?: H3ReferenceExecutionCharacter[];
}

export type VideoH3CharacterReferenceState = VideoCharacterReferenceState;

export interface PreparedVideoH3ReferenceDraft {
  draft: VideoGenerationDraft;
  warnings: string[];
  characterStates: VideoH3CharacterReferenceState[];
  /** Proven source pictures were partly remapped but an unresolved old number
   * could now alias a different image. The caller must not submit this draft. */
  issue?: string;
}

export type VideoH3ReferenceContext = Omit<VideoReferenceUsageContext, 'api'> & {
  api?: VideoReferenceUsageContext['api'] & Pick<VideoTaskApiConfig, 'runningHubMappedFields' | 'runningHubH3ReferenceImages' | 'requestTemplate' | 'rhtvMode'>
    & Partial<Pick<VideoTaskApiConfig, 'baseUrl' | 'endpoint'>>;
};

const unique = <T,>(values: readonly T[]): T[] => [...new Set(values)];
const runningHubPictureMappingInfo = 'H3 图片编号按已配置的 RunningHub 输入槽绑定；云端工作流内部是否重排图片，不能由本地映射核实。';
/** Compatibility: old frozen drafts store this explanation among warnings. */
export const isVideoH3ReferenceInfo = (message: string): boolean => message === runningHubPictureMappingInfo;
const normalizedSourcePictures = (value: unknown): Array<{ number: number; assetId: string }> => Array.isArray(value)
  ? value.flatMap((entry) => entry && typeof entry === 'object' && Number.isSafeInteger(entry.number) && entry.number > 0
    && typeof entry.assetId === 'string' && entry.assetId.trim() && entry.assetId.length <= 512 ? [{ number: entry.number, assetId: entry.assetId }] : []) : [];
const manifestSourcePictures = (value: unknown): Array<{ number: number; assetId: string }> => Array.isArray(value)
  ? value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.token !== 'string') return [];
    const token = entry.token.trim().match(new RegExp(`^(?:${pictureReferencePattern().source})$`, 'iu'));
    const number = token ? Number(token[1] ?? token[2] ?? token[3]) : 0;
    const assetId = typeof entry.id === 'string' && entry.id.trim() ? entry.id
      : typeof entry.assetId === 'string' ? entry.assetId : '';
    if (!Number.isSafeInteger(number) || number < 1 || !assetId.trim() || assetId.length > 512
      || typeof entry.id === 'string' && entry.id.trim() && typeof entry.assetId === 'string' && entry.assetId.trim() && entry.id !== entry.assetId) return [];
    return [{ number, assetId }];
  }) : [];
const isH3 = (text: string): boolean => /(?:^|\n)(?:integrated_multimodal_description|subject_definitions):/u.test(text);
const imageAsset = (asset: ReferenceAsset): boolean => !['video', 'audio'].includes(asset.type)
  && !['video', 'audio'].includes(asset.mediaType || '') && !/^(?:video|audio)\//u.test(asset.mimeType || '');

/** Scene replacement needs the same explicit provenance as an identity photo.
 * A scene-looking filename, asset category or selected use is not location ID. */
export const videoReferenceLocationOwners = (project: Project, asset: ReferenceAsset): Location[] => {
  return assetReferenceLocationOwners(project, asset);
};

/** Only a unique same-location selection replaces an old scene binding. If
 * the user chose supplemental non-character pictures, an unproven scene must
 * not silently bind to the continuity tail instead of those choices. */
export const videoReferenceSceneReplacement = (
  project: Project, original: ReferenceAsset, references: readonly VideoImageReference[],
): { scene: boolean; referenceIndex?: number; preventTailFallback: boolean } => {
  const owners = videoReferenceLocationOwners(project, original);
  const scene = original.type !== 'last-frame' && original.referenceRole !== 'last-frame'
    && (original.referenceEntityBinding !== undefined ? original.referenceEntityBinding?.kind === 'location'
      : owners.length > 0 || ['location', 'first-frame'].includes(original.type)
        || ['scene', 'composition', 'first-frame', 'grid'].includes(original.referenceRole || original.role));
  if (!scene) return { scene: false, preventTailFallback: false };
  const selections = references.map((reference, referenceIndex) => {
    const assets = project.assets.filter((asset) => asset.id === reference.assetId && !asset.missing && imageAsset(asset));
    const locationOwners = assets.length === 1 ? videoReferenceLocationOwners(project, assets[0]) : [];
    return { reference, referenceIndex, locationOwners };
  });
  const matches = owners.length === 1 ? selections.filter(({ locationOwners }) => locationOwners.length === 1 && locationOwners[0].id === owners[0].id) : [];
  return {
    scene: true,
    ...(matches.length === 1 ? { referenceIndex: matches[0].referenceIndex } : {}),
    preventTailFallback: original.referenceEntityBinding !== undefined && owners.length !== 1
      || selections.some(({ reference, locationOwners }) => locationOwners.length > 0
      || !['character', 'subject', 'first-frame', 'last-frame'].includes(reference.role)),
  };
};

export const videoH3BindingForPrompt = (
  project: Project, draft: VideoGenerationDraft,
): VideoH3ReferenceBinding | undefined => {
  if (draft.source?.promptFormat && draft.source.promptFormat !== 'h3') return undefined;
  const existing = draft.h3ReferenceBinding;
  const normalizedIdentities = existing && normalizeH3IdentityBindings(existing.identities);
  const existingPictures = normalizedSourcePictures(existing?.sourcePictures);
  if (existing?.version === 1 && existing.projectId === project.id
    && (normalizedIdentities || existingPictures.length) && typeof existing.basePrompt === 'string' && typeof existing.renderedPrompt === 'string'
    && (draft.prompt === existing.renderedPrompt || draft.prompt === existing.basePrompt)) return { ...existing,
      identities: normalizedIdentities || { version: 1, characters: [] }, sourcePictures: existingPictures,
      ...(!normalizedIdentities ? { identityBindingWarning: '原 H3 人物锚点资料损坏，仅按已保存的原图片清单同步编号；未猜测人物或改写剧情。' } : {}) };
  // A manual edit invalidates the exact anchors; do not silently reattach by
  // scanning names. A frozen task also must not borrow a later board revision.
  if (existing || draft.reuseTaskId || !draft.source?.storyboardId) return undefined;
  const matches = project.storyboards.filter((board) => board.id === draft.source!.storyboardId);
  if (matches.length !== 1) return undefined;
  const board = matches[0];
  const english = draft.source.language === 'en' || draft.source.language === undefined
    && draft.prompt === board.officialPromptEn && draft.prompt !== board.officialPromptZh;
  const basePrompt = english ? board.officialPromptEn : board.officialPromptZh;
  const savedIdentities = english ? board.h3IdentityBindingsEn : board.h3IdentityBindings;
  const identities = savedIdentities === undefined ? { version: 1 as const, characters: [] } : normalizeH3IdentityBindings(savedIdentities);
  if (!basePrompt || draft.prompt !== basePrompt) return undefined;
  // A translated official derivative can use its saved Chinese compiler
  // manifest only when its source link proves that exact original delivery.
  const manifestPromptMatches = board.targetOutput?.prompt === basePrompt || board.targetOutput?.prompt === board.officialPromptZh
    && (!english || board.officialPromptEnSource === board.officialPromptZh);
  const sourcePictures = manifestPromptMatches ? manifestSourcePictures(board.targetOutput?.referenceManifest) : [];
  if (!identities && !sourcePictures.length) return undefined;
  return { version: 1, projectId: project.id, basePrompt, identities: structuredClone(identities || { version: 1, characters: [] }), renderedPrompt: basePrompt, sourcePictures, sourceLanguage: english ? 'en' : 'zh',
    ...(!identities ? { identityBindingWarning: '原 H3 人物锚点资料损坏，仅按已保存的原图片清单同步编号；未猜测人物或改写剧情。' } : {}) };
};

/** Picture N follows the model consumer's image order, which can differ from
 * both the picker slots and the upload loop. Opaque graphs are not guessed. */
export const videoH3PictureNumbers = (
  references: readonly VideoImageReference[], context: VideoH3ReferenceContext,
): { numbers?: number[]; warning?: string } => {
  const slots = references.map(videoReferenceSlotIndex);
  if (slots.some((slot) => !Number.isSafeInteger(slot) || slot < 0) || new Set(slots).size !== slots.length) {
    return { warning: '参考图槽号无效，未猜测 H3 图片编号；请核对实际输入槽。' };
  }
  if (context.backend === 'comfyui') {
    const numbers = context.workflow && resolveComfyH3PictureNumbers(context.workflow, slots);
    if (numbers) return { numbers };
    return { warning: '当前 ComfyUI 工作流未声明 H3 实际图片消费顺序，已保留正文，未按输入槽猜测图片编号。' };
  }
  const api = context.api;
  if (api?.provider === 'rhtv_web') {
    if (api.rhtvMode && api.rhtvMode !== 'reference') return { warning: 'rhTV 首尾帧按明确用途放置，不添加多人物 Picture 引用。' };
    return { numbers: references.map((_, index) => index + 1) };
  }
  if (api?.provider === 'minimax') return { warning: '当前接口只传首尾帧，不提供 H3 多人物 Picture 引用；未虚构人物图片编号。' };
  if (api?.provider === 'runninghub') {
    const numbers = resolveRunningHubH3PictureNumbers(api, slots);
    if (numbers) return { numbers };
    return { warning: 'RunningHub 工作流未声明 H3 实际图片消费顺序，已保留正文，未按输入槽或上传顺序猜测图片编号。' };
  }
  if (!api) return { warning: '尚未确定本次视频接口，H3 图片引用将在明确输入映射后同步。' };
  const template = api.requestTemplate?.trim();
  if (!template || /\{\{(?:images|references)\}\}/u.test(template) && !/\{\{(?:image_\d+|first_image|last_image)\}\}/u.test(template)) {
    return { numbers: references.map((_, index) => index + 1) };
  }
  // Named fields are slot-scoped, but a custom template may reorder them or
  // combine them before the model. Only an explicit workflow mapping proves
  // the ordinal; warn rather than inventing a provider's image semantics.
  return { warning: '此自定义接口未声明 H3 图片引用顺序，已保留正文；图片仍按现有模板提交，不阻止生成。' };
};

export interface VideoPictureReferenceEdit { start: number; end: number; text: string }
const pictureReferenceToken = `(?:${pictureReferencePattern().source})`;
const pictureReferenceList = `${pictureReferenceToken}(?:(?:[ \\t]*[、,，][ \\t]*|[ \\t]+(?:and[ \\t]+)?|(?=<|\\[))${pictureReferenceToken})*`;

/** Edit image-reference syntax only. Removing an unsafe binding must not leave
 * its old number pointing to a newly selected person, or an empty H3 envelope.
 * Literal dialogue/sound/quoted text and all authored prose stay untouched. */
export const videoPictureReferenceEdits = (
  prompt: string, numbers: ReadonlyMap<number, readonly number[] | null>, masked = maskReferenceLiterals(prompt),
): VideoPictureReferenceEdit[] => {
  const edits: VideoPictureReferenceEdit[] = [];
  const envelopes = new RegExp(`\\b(referenced from|reference)([ \\t]+)(${pictureReferenceList})`, 'giu');
  for (const envelope of masked.matchAll(envelopes)) {
    const tokens = [...envelope[3].matchAll(pictureReferencePattern())];
    if (!tokens.some((token) => numbers.get(Number(token[1] ?? token[2] ?? token[3])) === null)) continue;
    const rendered = tokens.flatMap((token) => {
      const mapped = numbers.get(Number(token[1] ?? token[2] ?? token[3]));
      return mapped === null ? [] : mapped === undefined ? [token[0]] : mapped.map((number) => token[0].replace(/\d+/u, String(number)));
    });
    const separator = tokens.length > 1 ? envelope[3].slice(tokens[0].index! + tokens[0][0].length, tokens[1].index) : ', ';
    edits.push({ start: envelope.index!, end: envelope.index! + envelope[0].length,
      text: rendered.length ? `${envelope[1]}${envelope[2]}${rendered.join(separator)}`
        : envelope[1].toLowerCase() === 'referenced from' ? 'defined by the canonical prompt' : '' });
  }
  for (const token of masked.matchAll(pictureReferencePattern())) {
    const start = token.index!;
    if (edits.some((edit) => edit.start <= start && start < edit.end)) continue;
    const mapped = numbers.get(Number(token[1] ?? token[2] ?? token[3]));
    if (mapped === undefined) continue;
    edits.push({ start, end: start + token[0].length,
      text: mapped === null ? '' : mapped.map((number) => token[0].replace(/\d+/u, String(number))).join(', ') });
  }
  return edits;
};

const videoH3ReferenceProject = (project: Project, draft: VideoGenerationDraft): Project => {
  const sourceBoards = project.storyboards.filter((board) => board.id === draft.source?.storyboardId);
  if (sourceBoards.length !== 1) return project;
  const explicitlyBoundIds = new Set(draft.references.flatMap((reference) => project.assets
    .filter((asset) => asset.id === reference.assetId && typeof asset.characterReferenceId === 'string')
    .map((asset) => asset.characterReferenceId as string)));
  const characters = [...(officialH3ContextForStoryboard(project, sourceBoards[0]).characters || project.characters)].filter((character) => {
    if (!explicitlyBoundIds.has(character.id)) return true;
    const live = project.characters.filter((entry) => entry.id === character.id);
    return live.length === 1 && !live[0].dossier?.archivedIntoCharacterId;
  });
  // Keep the plan's authored names for existing IDs. A newly selected explicit
  // asset binding can still refer to a current character created after the plan;
  // absence of a matching visual identity remains a warning, not a guessed bind.
  for (const reference of draft.references) {
    const assets = project.assets.filter((asset) => asset.id === reference.assetId);
    if (assets.length !== 1 || assets[0].characterReferenceId === undefined) continue;
    for (const owner of videoReferenceCharacterOwners(project, assets[0], reference)) {
      if (!characters.some((character) => character.id === owner.id)) characters.push(owner);
    }
  }
  return { ...project, characters };
};

/** IDs come only from the current explicit selection and asset provenance. */
export const videoH3ReferenceCharacterIds = (project: Project, draft: VideoGenerationDraft): string[] => {
  const referenceProject = videoH3ReferenceProject(project, draft);
  return unique(draft.references.flatMap((reference) => {
    if (!['character', 'subject'].includes(reference.role) && reference.characterIds === undefined) return [];
    const assets = project.assets.filter((asset) => asset.id === reference.assetId);
    return assets.length === 1 ? videoReferenceCharacterOwners(referenceProject, assets[0], reference).map((owner) => owner.id) : [];
  }));
};

/** Both request-local reference paths already have a trusted authored source.
 * Read its real section/shot offsets by the same rules, including legacy
 * bodies without headings. Masking preserves offsets and excludes literal
 * dialogue, sound payloads and quoted examples from structural boundaries. */
const videoH3ReferenceProseRanges = (prompt: string) => {
  const masked = maskReferenceLiterals(prompt);
  const description = /^(?:integrated_multimodal_description|detailed_description):/mu.exec(masked);
  const sectionStart = description ? description.index + description[0].length : 0;
  const nextSection = /^(?:overall_soundscape|non_diegetic_music):/mu.exec(masked.slice(sectionStart));
  const sectionEnd = nextSection ? sectionStart + nextSection.index : prompt.length;
  const markers = [...masked.slice(sectionStart, sectionEnd).matchAll(/\[Shot[ \t]*([1-9]\d*)\]/gu)];
  const shots = markers.map((marker, index) => ({
    index: Number(marker[1]),
    start: sectionStart + marker.index!,
    bodyStart: sectionStart + marker.index! + marker[0].length,
    end: sectionStart + (markers[index + 1]?.index ?? sectionEnd - sectionStart),
  }));
  return { masked, sectionStart, shots };
};

/** Add only a request-local identity association inside a proven visual shot.
 * It never creates Subject/voice IDs or moves a later character to Shot 1. */
const participationReferenceEdit = (
  prompt: string,
  character: Character,
  characters: readonly Character[],
  shotIndexes: readonly number[],
  numbers: readonly number[],
): VideoPictureReferenceEdit | undefined => {
  const { masked, shots } = videoH3ReferenceProseRanges(prompt);
  const shot = shots.find((entry) => shotIndexes.includes(entry.index));
  if (!shot) return undefined;
  const { bodyStart: start, end } = shot;
  const visualText = masked.slice(start, end);
  const aliases = characterParticipationAliases(character, characters).slice().sort((a, b) => b.length - a.length);
  const alias = aliases.find((value) => {
    let at = visualText.toLocaleLowerCase('en-US').indexOf(value.toLocaleLowerCase('en-US'));
    while (at >= 0) {
      const before = visualText[at - 1] || ''; const after = visualText[at + value.length] || '';
      if (!/[A-Za-z0-9_]/u.test(value[0]) && !/[A-Za-z0-9_]/u.test(value[value.length - 1])
        || !/[A-Za-z0-9_]/u.test(before) && !/[A-Za-z0-9_]/u.test(after)) return true;
      at = visualText.toLocaleLowerCase('en-US').indexOf(value.toLocaleLowerCase('en-US'), at + value.length);
    }
    return false;
  });
  const name = character.name.replace(/[\u200B-\u200D\uFEFF]/gu, '').trim();
  if (!name || /[<>\r\n]/u.test(name) || alias && /[<>\r\n]/u.test(alias)) return undefined;
  const label = alias && alias !== name ? `${name} (known as ${alias})` : name;
  // Later shots must still begin with their authored At cut. Put the
  // association after the visual body, before its original trailing spacing,
  // never between [Shot N] and At or inside the next shot/section.
  const insertion = end - (prompt.slice(start, end).match(/\s*$/u)?.[0].length || 0);
  return { start: insertion, end: insertion,
    text: ` Visual identity reference for ${label}: ${numbers.map((number) => `<Picture ${number}>`).join(', ')}.` };
};

interface VideoH3ReferenceUse {
  role: ReferenceRole;
  description?: readonly [string, string];
}

/** Custom storyboard pictures capture an existing action phase. Their picker
 * positions do not turn a 3.5s / 13.5s pose into the opening / ending state.
 * Actual boundary assets, explicit board boundaries and continuation tails
 * keep their selected first/last use. Only request-local prose changes. */
const videoH3ReferenceUses = (project: Project, draft: VideoGenerationDraft): VideoH3ReferenceUse[] => {
  const board = project.storyboards.find((entry) => entry.id === draft.source?.storyboardId);
  return draft.references.map((reference): VideoH3ReferenceUse => {
    const asset = project.assets.find((entry) => entry.id === reference.assetId);
    const boundary = reference.role === 'first-frame'
      ? board?.firstFrameAssetId === reference.assetId || draft.automaticStoryboardFrames?.firstFrameAssetId === reference.assetId
      : reference.role === 'last-frame'
        ? board?.lastFrameAssetId === reference.assetId || draft.automaticStoryboardFrames?.lastFrameAssetId === reference.assetId : false;
    if (!asset || asset.imageVariant !== 'storyboard-frame' || boundary
      || asset.type === 'first-frame' || asset.type === 'last-frame'
      || !['first-frame', 'middle-frame', 'last-frame', 'composition', 'motion', 'general', 'unknown'].includes(reference.role)) {
      return { role: reference.role };
    }
    const sameBoard = board && asset.sourceStoryboardId === board.id;
    const shot = sameBoard ? board.shots.find((entry) => entry.id === asset.sourceShotId) : undefined;
    const time = sameBoard && typeof asset.imageFrameTimeSec === 'number' && Number.isFinite(asset.imageFrameTimeSec)
      && asset.imageFrameTimeSec >= 0 ? asset.imageFrameTimeSec : undefined;
    const zhPhase = time !== undefined ? `本段 ${time} 秒${shot ? `、第 ${shot.index} 镜` : ''}对应动作阶段`
      : shot ? `本段第 ${shot.index} 镜对应动作阶段` : '图中对应动作阶段';
    const enPhase = time !== undefined ? `the action phase at ${time}s in this clip${shot ? ` (Shot ${shot.index})` : ''}`
      : shot ? `the action phase in Shot ${shot.index} of this clip` : 'the depicted action phase';
    return { role: 'composition', description: [
      `${zhPhase}的构图与空间参考`, `composition and spatial reference for ${enPhase}`,
    ] };
  });
};

/** Describe an explicitly selected image's use, never infer its subjects or
 * rewrite shot actions. These are composition references in multi-image
 * requests: a picker label does not prove first/last-frame conditioning in
 * the remote workflow. Existing authored Picture uses remain authoritative. */
const videoH3ReferenceUsageEdit = (
  prompt: string, references: readonly VideoImageReference[], numbers: readonly number[],
  language: 'zh' | 'en', authoredPictureNumbers: ReadonlySet<number>,
  rememberedRoles?: readonly ReferenceRole[], multiViewNumbers: readonly number[] = [],
  referenceUses: readonly VideoH3ReferenceUse[] = [],
): VideoPictureReferenceEdit | undefined => {
  const uses: Partial<Record<ReferenceRole, readonly [string, string]>> = {
    'first-frame': ['开场构图参考', 'opening composition reference'],
    'last-frame': ['结束构图参考', 'ending composition reference'],
    scene: ['场景空间与光照参考', 'environment layout and lighting reference'],
    prop: ['道具外观参考', 'prop appearance reference'],
    style: ['视觉风格参考', 'visual style reference'],
    motion: ['动作姿态参考', 'action pose reference'],
    composition: ['画面构图参考', 'composition reference'],
    camera: ['摄影构图参考', 'camera composition reference'],
    'clay-render': ['形体与空间结构参考', 'form and spatial structure reference'],
    creative: ['视觉创意参考', 'visual concept reference'],
    general: ['通用视觉参考', 'general visual reference'],
  };
  const selectedUses = references.flatMap((reference, index) => {
    const number = numbers[index];
    const ordinal = reference.role === 'middle-frame'
      ? videoMiddleFrameOrdinal(references, videoReferenceSlotIndex(reference, index), rememberedRoles) : undefined;
    const use = referenceUses[index]?.description || (ordinal ? [`中间帧 ${ordinal} 的过程构图与连续性参考`, `intermediate frame ${ordinal} progression composition and continuity reference`]
      : uses[reference.role]);
    return number && use && !authoredPictureNumbers.has(number)
      ? [`<Picture ${number}> ${use[language === 'zh' ? 0 : 1]}`] : [];
  });
  if (!selectedUses.length && !multiViewNumbers.length) return undefined;
  const { sectionStart, shots } = videoH3ReferenceProseRanges(prompt);
  // Insert before the real shot header, never inside its At time prefix or
  // a masked dialogue/quote. Unsectioned source prose needs no new envelope.
  const start = shots.find((shot) => shot.index === 1)?.start ?? sectionStart;
  const multiViewPictures = unique(multiViewNumbers).map((number) => `<Picture ${number}>`).join(language === 'zh' ? '、' : ', ');
  const text = [
    selectedUses.length ? language === 'zh'
      ? `本段参考图用途：${selectedUses.join('；')}。人物朝向与动作时序按正文推进，静态姿态不延长动作。`
      : `Reference uses for this clip: ${selectedUses.join('; ')}. Facing and action timing follow the written sequence; still poses do not prolong actions.` : '',
    multiViewPictures ? language === 'zh'
      ? `多视图身份参考：${multiViewPictures} 各自展示其已关联的同一个人物的多个角度，仅参考身份与外观；图内不同视角不是同时入画的多个人，实际人数、站位、朝向与动作沿用本镜正文。`
      : `Multi-view identity references: ${multiViewPictures} each show multiple angles of their respective single bound character, for identity and appearance only; the views are not multiple people entering the frame. Character count, placement, facing and action follow the current shot.` : '',
  ].filter(Boolean).join('\n');
  return { start, end: start, text: `${text}\n` };
};

/** Pure serialization of explicit identity anchors. Warning-only failures
 * return the untouched text and never ask a model to regenerate a story. */
const prepareVideoH3ReferenceDraftInternal = (
  project: Project, draft: VideoGenerationDraft, context: VideoH3ReferenceContext,
): PreparedVideoH3ReferenceDraft => {
  if (draft.source?.promptFormat === 'seedance') return prepareVideoSeedanceReferenceDraft(project, draft,
    videoSeedanceReferencePlan(draft.references, context), videoMotionReferenceNumbers(draft.videoReferences || [], context));
  const referenceProject = videoH3ReferenceProject(project, draft);
  const binding = videoH3BindingForPrompt(project, draft);
  const basePrompt = binding?.basePrompt || draft.prompt;
  // Saved H3 deliveries can start directly with [Shot 1]. The exact source
  // binding (or explicit format) identifies H3; headings are only a fallback
  // for older unlabelled drafts, not a prerequisite for using proven anchors.
  const h3Prompt = draft.source?.promptFormat === 'h3' || Boolean(binding) || isH3(basePrompt);
  const sourceBoard = referenceProject.storyboards.filter((board) => board.id === draft.source?.storyboardId);
  const participation = h3Prompt ? sourceBoard.length === 1
    ? resolveStoryboardCharacterParticipation({ ...sourceBoard[0],
      h3IdentityBindings: normalizeH3IdentityBindings(sourceBoard[0].h3IdentityBindings),
      h3IdentityBindingsEn: normalizeH3IdentityBindings(sourceBoard[0].h3IdentityBindingsEn),
    }, referenceProject.characters, basePrompt)
    : resolvePromptCharacterParticipation(basePrompt, referenceProject.characters, { identityBindings: binding?.identities })
    : { characters: [], ambiguousNames: [], usedFallback: true };
  const plan = videoH3PictureNumbers(draft.references, context.api?.provider === 'rhtv_web'
    ? { ...context, api: { ...context.api, rhtvMode: (draft.parameters.rhtv_mode || context.api.rhtvMode) as VideoTaskApiConfig['rhtvMode'] } } : context);
  const selectedSlots = new Map<string, number[]>();
  for (const [index, reference] of draft.references.entries()) {
    if (!['character', 'subject'].includes(reference.role) && reference.characterIds === undefined) continue;
    const assets = project.assets.filter((asset) => asset.id === reference.assetId && !asset.missing);
    if (assets.length !== 1) continue;
    for (const owner of videoReferenceCharacterOwners(referenceProject, assets[0], reference)) {
      selectedSlots.set(owner.id, unique([...(selectedSlots.get(owner.id) || []), plan.numbers?.[index] || videoReferenceSlotIndex(reference, index) + 1]));
    }
  }
  const relevantIds = unique([...participation.characters.map((entry) => entry.characterId),
    ...(binding?.identities.characters || []).map((entry) => entry.characterId), ...selectedSlots.keys()]);
  const characterStates: VideoH3CharacterReferenceState[] = relevantIds.flatMap((characterId) => {
    const character = referenceProject.characters.find((entry) => entry.id === characterId);
    if (!character) return [];
    const slots = selectedSlots.get(characterId) || [];
    return [{ characterId, name: character.name, status: slots.length ? 'pending' : 'unselected', slots,
      ...(slots.length ? { reason: plan.numbers ? '尚未证明本次图片与正文人物的对应关系。' : plan.warning || '图片编号尚未确定。' } : {}) }];
  });
  const markBound = (characterId: string, numbers: number[]) => {
    const item = characterStates.find((entry) => entry.characterId === characterId);
    if (item) { item.status = 'bound'; item.slots = [...numbers]; delete item.reason; }
  };
  const markPending = (characterId: string, reason: string) => {
    const item = characterStates.find((entry) => entry.characterId === characterId);
    if (item && item.slots.length) item.reason = reason;
  };
  const referenceWarnings = draft.references.flatMap((reference, index) => {
    const warning = videoReferenceCharacterBindingWarning(reference);
    return warning ? [`图片槽 ${videoReferenceSlotIndex(reference, index) + 1} ${warning}`] : [];
  });
  const unchanged = (issues: string[]): PreparedVideoH3ReferenceDraft => {
    const warnings = unique([...referenceWarnings, ...issues]);
    return { draft: { ...draft, h3ReferenceWarnings: warnings }, warnings, characterStates };
  };
  // The selected format takes precedence over headings retained in ordinary
  // drafts; their pictures do not require H3 identity-anchor serialization.
  if (draft.source?.promptFormat === 'ordinary' || !h3Prompt) return unchanged([]);
  // A true retry retains its frozen, already-displayed submission. Selecting
  // current images explicitly removes reuseTaskId in the picker.
  if (draft.reuseTaskId) {
    const savedStates = binding?.renderedPrompt === draft.prompt ? binding.characterStates : undefined;
    const frozenStates = Array.isArray(savedStates) ? structuredClone(savedStates) : characterStates.map((entry) => entry.status === 'pending'
      ? { ...entry, reason: '沿用原任务冻结的提示词与图片；缺少已保存的关联状态，不依据当前资料重新绑定。' } : entry);
    if (referenceWarnings.length) return { ...unchanged(draft.h3ReferenceWarnings || []), characterStates: frozenStates };
    return { draft, warnings: draft.h3ReferenceWarnings || [], characterStates: frozenStates };
  }
  if (!binding) return unchanged(draft.references.length
    ? ['这份 H3 稿没有可信的可定位人物绑定，已保留原文；未猜测参考图是谁，不阻止生成。需要补齐时请明确修复本段提示词。'] : []);
  const warnings: string[] = [...referenceWarnings, ...(binding.identityBindingWarning ? [binding.identityBindingWarning] : [])];
  // Match the frozen public identities used to author this segment. Same-ID
  // live asset associations and this submission's explicit characterIds are
  // still authoritative for pictures, while later display-name edits are not.
  if (draft.references.length && plan.warning) warnings.push(plan.warning);
  const characterPictures = new Map<string, number[]>();
  for (const [index, reference] of draft.references.entries()) {
    if (videoReferenceCharacterBindingWarning(reference)) continue;
    // A continuity/scene picture is not an extra face or voice source.
    if (!['character', 'subject'].includes(reference.role) && reference.characterIds === undefined) continue;
    const assets = project.assets.filter((asset) => asset.id === reference.assetId && !asset.missing);
    const asset = assets.length === 1 ? assets[0] : undefined;
    const owners = asset ? videoReferenceCharacterOwners(referenceProject, asset, reference) : [];
    if (!owners.length) {
      warnings.push(`图片槽 ${videoReferenceSlotIndex(reference, index) + 1} 尚未明确绑定本项目人物或形态，仅提示，不阻止生成。`);
      continue;
    }
    if (reference.characterIds?.some((id) => !owners.some((owner) => owner.id === id))) {
      warnings.push(`图片槽 ${videoReferenceSlotIndex(reference, index) + 1} 的部分人物绑定已失效，未借用其他人物或形态。`);
    }
    const number = plan.numbers?.[index];
    if (!number) continue;
    owners.forEach((owner) => characterPictures.set(owner.id, unique([...(characterPictures.get(owner.id) || []), number])));
  }
  const identities = binding.identities.characters || [];
  const identityIssues = getH3IdentityBindingIssues(binding.basePrompt, binding.identities, referenceProject.characters);
  const pictureNumbers = new Map<number, number[] | null>();
  // A six-field prompt may already cite pictures in definitions/retention or
  // shot prose. All such tokens must have an unambiguous saved manifest; do
  // not append a second contradictory mapping and leave the old ones behind.
  const pictureSourceIssues: string[] = [];
  const pictureTokens = [...maskReferenceLiterals(binding.basePrompt).matchAll(pictureReferencePattern())];
  for (const token of pictureTokens) {
    const originalNumber = Number(token[1] ?? token[2] ?? token[3]);
    if (pictureNumbers.has(originalNumber)) continue;
    const source = binding.sourcePictures?.filter((entry) => entry.number === originalNumber);
    const assetId = source?.length === 1 ? source[0].assetId : undefined;
    const selected = assetId ? draft.references.flatMap((reference, index) => reference.assetId === assetId ? [index] : []) : [];
    const sourceAssets = assetId ? project.assets.filter((asset) => asset.id === assetId) : [];
    const sourceAsset = sourceAssets.length === 1 ? sourceAssets[0] : undefined;
    if (sourceAsset && (sourceAsset.referenceEntityBinding === undefined
      ? sourceAsset.characterReferenceId !== undefined
      : sourceAsset.referenceEntityBinding === null || sourceAsset.referenceEntityBinding.kind === 'character'
        || sourceAsset.sourceEntityKind === 'character')) {
      // Generation provenance cannot prove who an older prompt associated with
      // this image. Rebuild only this request's picture syntax from the current
      // explicit binding and valid identity anchors, even if the old source ID
      // happens to equal the newly chosen character.
      pictureNumbers.set(originalNumber, null);
      warnings.push(`原 H3 的 ${token[0]} 已按本次明确人物绑定重建图片引用；原稿、人物和剧情保持不变，不阻止生成。`);
      continue;
    }
    let numbers = selected.flatMap((index) => plan.numbers?.[index] ? [plan.numbers[index]] : []);
    const pending = binding.pendingPictureSlots?.filter((entry) => entry.number === originalNumber);
    if (!numbers.length && pending?.length === 1) {
      numbers = draft.references.flatMap((reference, index) => videoReferenceSlotIndex(reference, index) === pending[0].slotIndex
        && reference.role === pending[0].role && plan.numbers?.[index] ? [plan.numbers[index]] : []);
    }
    if (!numbers.length && assetId) {
      const originalAssets = project.assets.filter((asset) => asset.id === assetId);
      const owners = originalAssets.length === 1 ? videoReferenceCharacterOwners(referenceProject, originalAssets[0]) : [];
      if (owners.length && owners.every((owner) => characterPictures.has(owner.id))) numbers = unique(owners.flatMap((owner) => characterPictures.get(owner.id)!));
      else if (originalAssets.length === 1) {
        const replacement = videoReferenceSceneReplacement(project, originalAssets[0], draft.references);
        if (replacement.referenceIndex !== undefined && plan.numbers?.[replacement.referenceIndex]) {
          numbers = [plan.numbers[replacement.referenceIndex]];
        } else if (replacement.scene && replacement.preventTailFallback) {
          pictureNumbers.set(originalNumber, null);
          warnings.push(`原 H3 的 ${token[0]} 场景图没有唯一可证明的本次对应图片，已仅移除这条图片引用；未改剧情或绑定到本地末帧，不阻止生成。`);
          continue;
        } else if (replacement.scene) {
          const starts = draft.references.flatMap((reference, index) => reference.role === 'first-frame' && plan.numbers?.[index] ? [plan.numbers[index]] : []);
          if (starts.length === 1) numbers = starts;
        }
      }
    }
    if (!numbers.length) {
      if (assetId && plan.numbers) {
        // The original asset is proven, but it was deliberately left out of
        // this submission. Keeping its old ordinal would bind some other
        // selected image; remove only the obsolete picture syntax instead.
        pictureNumbers.set(originalNumber, null);
        warnings.push(`原 H3 的 ${token[0]} 对应图片未在本次选择中且没有可证明的替图，已仅移除这条图片引用；人物、剧情和对白保留，不阻止生成。`);
        continue;
      }
      const sourceIssue = `原 H3 的 ${token[0]} 缺少可证明的原资产与本次图片对应，已保留该原始标签；未附加冲突引用。请恢复该图的原图片清单，或明确重新选择参考图并更新本段引用。`;
      pictureSourceIssues.push(sourceIssue);
      warnings.push(sourceIssue);
      continue;
    }
    pictureNumbers.set(originalNumber, unique(numbers));
  }
  const edits = videoPictureReferenceEdits(binding.basePrompt, pictureNumbers);
  // Known source pictures are still synchronized when a different old token
  // lacks provenance. Never add a second identity association to that partial
  // result, and never silently delete or reinterpret the unresolved token.
  for (const identity of pictureSourceIssues.length ? [] : identities) {
    const numbers = characterPictures.get(identity.characterId) || [];
    if (!numbers.length) continue;
    const issues = identityIssues.filter((issue) => issue.characterId === identity.characterId);
    if (issues.length) {
      const reason = `人物“${identity.name || '未命名'}”的 H3 身份锚点已失效：${unique(issues.map((issue) => issue.message)).join('；')}。本次未绑定该人物图片，未猜测或改写其剧情。`;
      warnings.push(reason); markPending(identity.characterId, reason);
      continue;
    }
    const end = binding.basePrompt.indexOf(identity.referenceAnchor) + identity.referenceAnchor.length;
    edits.push({ start: end, end,
      text: ` Visual identity reference for ${identity.name}: ${numbers.map((number) => `<Picture ${number}>`).join(', ')}.` });
    markBound(identity.characterId, numbers);
  }
  for (const id of pictureSourceIssues.length ? [] : characterPictures.keys()) if (!identities.some((identity) => identity.characterId === id)) {
    const character = referenceProject.characters.find((entry) => entry.id === id);
    const visible = participation.characters.find((entry) => entry.characterId === id && entry.presence === 'visible');
    const edit = character && visible ? participationReferenceEdit(binding.basePrompt, character, referenceProject.characters, visible.visibleShotIndexes, characterPictures.get(id)!) : undefined;
    if (edit) {
      edits.push(edit); markBound(id, characterPictures.get(id)!);
    } else {
      const reason = `人物“${character?.name || '未命名'}”已选图但尚未关联：本段缺少唯一且可定位的出镜身份依据；仅提示，不阻止生成。`;
      warnings.push(reason); markPending(id, reason);
    }
  }
  let prompt = binding.basePrompt;
  for (const edit of edits.sort((a, b) => b.start - a.start)) prompt = prompt.slice(0, edit.start) + edit.text + prompt.slice(edit.end);
  const language = binding.sourceLanguage || draft.source?.language;
  const changedKnownMapping = [...pictureNumbers].some(([number, mapped]) => mapped !== null && (mapped.length !== 1 || mapped[0] !== number));
  if (pictureSourceIssues.length && changedKnownMapping) return unchanged([
    ...pictureSourceIssues,
    '旧 H3 图片清单只能对应部分引用，本次保留当前提示词，可直接生成，也可主动更新本段参考说明。',
  ]);
  const remapPictures = (source: string): string => videoPictureReferenceEdits(source, pictureNumbers)
    .sort((left, right) => right.start - left.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
  const remapOptional = (source: string | undefined): string | undefined => source === undefined ? undefined : remapPictures(source);
  const performance = binding.identities.performance;
  const executionPerformance: H3PerformancePlan | undefined = performance ? { ...performance,
    preamble: remapOptional(performance.preamble), summary: remapOptional(performance.summary),
    retentionAnalysis: remapOptional(performance.retentionAnalysis),
    overallSoundscape: remapPictures(performance.overallSoundscape), nonDiegeticMusic: remapPictures(performance.nonDiegeticMusic),
    characters: performance.characters?.map((entry) => ({ ...entry,
      visualDescription: remapPictures(entry.visualDescription), voiceDescription: remapOptional(entry.voiceDescription) })),
    shots: performance.shots.map((shot) => ({ ...shot, visualDescription: remapPictures(shot.visualDescription),
      events: shot.events.map((event) => event.kind === 'visual' ? { ...event,
        description: remapPictures(event.description), soundDescription: remapOptional(event.soundDescription) }
        : { ...event, delivery: remapOptional(event.delivery), speakerAction: remapOptional(event.speakerAction),
          ...(event.kind === 'vocal' ? { vocalDescription: remapPictures(event.vocalDescription) } : {}),
          reactions: event.reactions?.map((reaction) => ({ ...reaction, description: remapPictures(reaction.description) })) }) })),
  } : undefined;
  const executionIdentities: H3IdentityBindings = { ...binding.identities,
    ...(executionPerformance ? { performance: executionPerformance } : {}),
    ...(binding.identities.events ? { events: binding.identities.events.map((event) => {
      let referenceAnchor = event.referenceAnchor;
      if (referenceAnchor) for (const edit of videoPictureReferenceEdits(referenceAnchor, pictureNumbers).sort((left, right) => right.start - left.start)) {
        referenceAnchor = referenceAnchor.slice(0, edit.start) + edit.text + referenceAnchor.slice(edit.end);
      }
      return { ...event, ...(referenceAnchor !== undefined ? { referenceAnchor } : {}) };
    }) } : {}) };
  const executionMode = videoH3MediaModeContract(draft, context).mode;
  const referenceUses = videoH3ReferenceUses(referenceProject, draft);
  const execution = !pictureSourceIssues.length && plan.numbers && !identityIssues.length
    && (Boolean(executionPerformance) || characterPictures.size > 0)
    && [...characterPictures.keys()].every((id) => identities.some((identity) => identity.characterId === id))
    && (Boolean(executionPerformance) || executionMode === 'full-reference')
    ? renderH3ReferenceExecution({ prompt, identities: executionIdentities, characterPictures,
      mode: executionMode === 'full-reference' ? 'full-reference' : 'integrated',
      language: binding.sourceLanguage || draft.source?.language,
      pictureUses: referenceUses.map((use, index) => ({ number: plan.numbers![index], role: use.role })) }) : undefined;
  if (execution) prompt = execution.prompt;
  // Serialize uses after any existing execution rendering, so a saved
  // performance plan cannot discard this request's image responsibilities.
  // Missing old manifest entries still cannot authorize a competing mapping.
  if (!pictureSourceIssues.length && plan.numbers && language) {
    const authoredPictureNumbers = new Set([...pictureNumbers.values()].flatMap((numbers) => numbers || []));
    const multiViewNumbers = draft.references.flatMap((reference, index) => {
      if (!['character', 'subject'].includes(reference.role) && reference.characterIds === undefined) return [];
      const assets = project.assets.filter((asset) => asset.id === reference.assetId && !asset.missing);
      const asset = assets.length === 1 ? assets[0] : undefined;
      if (!asset || !['five-view', 'three-view', 'turnaround', 'private-five-view', 'private-turnaround'].includes(asset.imageVariant || '')) return [];
      const owners = videoReferenceCharacterOwners(referenceProject, asset, reference);
      if (owners.length !== 1) return [];
      const state = characterStates.find((entry) => entry.characterId === owners[0].id);
      const number = plan.numbers![index];
      // This describes the bound asset, not who must enter the shot. Reusing
      // fallback prose visibility here could discard a proven identity use.
      return state?.status === 'bound' && state.slots.includes(number) ? [number] : [];
    });
    const usage = videoH3ReferenceUsageEdit(prompt, draft.references, plan.numbers, language,
      authoredPictureNumbers, draft.referenceSlotRoles, multiViewNumbers, referenceUses);
    if (usage) prompt = prompt.slice(0, usage.start) + usage.text + prompt.slice(usage.end);
  }
  return { draft: { ...draft, prompt,
    ...(!draft.reuseTaskId && !draft.h3ReferenceBinding && draft.source && draft.source.language === undefined
      && binding.sourceLanguage === 'en' && sourceBoard.length === 1
      && binding.basePrompt === sourceBoard[0].officialPromptEn
      && sourceBoard[0].officialPromptEnSource === sourceBoard[0].officialPromptZh
      ? { source: { ...draft.source, language: 'en' as const } } : {}),
    h3ReferenceBinding: { ...binding, renderedPrompt: prompt, characterStates: structuredClone(characterStates),
      executionIdentities: execution?.identities, executionCharacters: execution?.characters }, h3ReferenceWarnings: unique(warnings) }, warnings: unique(warnings), characterStates };
};

/** The mode is determined after the final selected slots have been resolved.
 * Historical retries retain their exact snapshot; no old prompt is rewritten. */
export const prepareVideoH3ReferenceDraft = (
  project: Project, draft: VideoGenerationDraft, context: VideoH3ReferenceContext,
): PreparedVideoH3ReferenceDraft => {
  const prepared = prepareVideoH3ReferenceDraftInternal(project, draft, context);
  if (!draft.reuseTaskId && draft.source?.promptFormat === 'seedance') {
    const specification = renderVideoSeedanceSpecification(prepared.draft.prompt, draft.parameters, context.api);
    const trusted = prepared.draft.seedanceReferenceBinding;
    const prompt = trusted ? specification.prompt : prepared.draft.prompt;
    const warnings = unique([...prepared.warnings, ...specification.warnings,
      ...(!trusted && specification.prompt !== prompt ? ['本次参数与手动稿的视频规格不一致，原文已保留，请核对分辨率与画幅。'] : [])]);
    return { ...prepared, warnings, draft: { ...prepared.draft, prompt, h3ReferenceWarnings: warnings,
      ...(trusted ? { seedanceReferenceBinding: { ...trusted, renderedPrompt: prompt } } : {}),
      ...(prepared.draft.source ? { source: { ...prepared.draft.source, promptFingerprint: sourceContentHash(prompt) } } : {}),
    } };
  }
  if (draft.reuseTaskId || draft.source?.promptFormat === 'seedance' || draft.source?.promptFormat === 'ordinary'
    || !isH3(prepared.draft.prompt)) return prepared;
  const h3MediaMode = videoH3MediaModeContract(prepared.draft, context);
  const mismatch = videoH3MediaModeIssue(h3MediaMode);
  // Reference mode is guidance, never a local content gate for submission.
  const notice = draft.source?.promptFormat === 'h3' || draft.h3MediaModeUpdate ? mismatch : undefined;
  const warnings = unique([...prepared.warnings, ...(notice ? [notice] : [])]);
  return { ...prepared, draft: { ...prepared.draft, h3MediaMode, h3ReferenceWarnings: warnings }, warnings };
};

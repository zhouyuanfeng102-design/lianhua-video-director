import type { Character, H3IdentityBindings, Location, Project, ReferenceAsset, VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft, VideoImageReference } from './videoGenerationTypes';
import type { VideoReferenceUsageContext } from './videoReferenceUsage';
import { videoReferenceSlotIndex } from './videoReferenceSlots';
import { getH3IdentityBindingIssues, normalizeH3IdentityBindings } from './h3IdentityBindings';
import { officialH3ContextForStoryboard } from './officialH3Context';
import { characterParticipationAliases, resolvePromptCharacterParticipation, resolveStoryboardCharacterParticipation } from './characterParticipation';
import { assetReferenceCharacterOwners } from './assetCharacterBinding';
import { maskVideoPictureReferenceLiterals as maskReferenceLiterals, videoPictureReferencePattern as pictureReferencePattern } from './videoPictureReferences';
export { collectVideoPictureReferenceNumbers } from './videoPictureReferences';

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
  /** Picture provenance can remain valid when legacy identity metadata is damaged. */
  identityBindingWarning?: string;
  /** Actual result of rendering this exact request, retained by frozen retries. */
  characterStates?: VideoH3CharacterReferenceState[];
}

export interface VideoH3CharacterReferenceState {
  characterId: string;
  name: string;
  status: 'unselected' | 'bound' | 'pending';
  /** Actual Picture numbers when known; otherwise selected physical slots. */
  slots: number[];
  reason?: string;
}

export interface PreparedVideoH3ReferenceDraft {
  draft: VideoGenerationDraft;
  warnings: string[];
  characterStates: VideoH3CharacterReferenceState[];
  /** Proven source pictures were partly remapped but an unresolved old number
   * could now alias a different image. The caller must not submit this draft. */
  issue?: string;
}

export type VideoH3ReferenceContext = Omit<VideoReferenceUsageContext, 'api'> & {
  api?: VideoReferenceUsageContext['api'] & Pick<VideoTaskApiConfig, 'runningHubMappedFields' | 'requestTemplate' | 'rhtvMode'>;
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

/** A corrupt explicit selection is not permission to fall back to asset ownership. */
export const videoReferenceCharacterBindingWarning = (reference: Pick<VideoImageReference, 'characterIds'>): string | undefined => {
  const ids: unknown = reference.characterIds;
  return ids !== undefined && (!Array.isArray(ids) || Array.from(ids).some((id) => typeof id !== 'string'))
    ? '人物绑定资料格式无效，已按未绑定处理；未借用资产人物，仅提示，不阻止生成。' : undefined;
};

/** Only explicit provenance is evidence. Never infer a person from filename,
 * face position, character ordinal, baseName or another visual form. */
export const videoReferenceCharacterOwners = (
  project: Project, asset: ReferenceAsset, reference?: VideoImageReference,
): Character[] => {
  if (!imageAsset(asset) || project.assets.filter((entry) => entry.id === asset.id).length !== 1) return [];
  const exactCharacters = (ids: readonly string[]): Character[] => unique(ids).flatMap((id) => {
    const matches = project.characters.filter((character) => character.id === id);
    // Archived dossiers remain in storage for old tasks, but are not current
    // owners. Do not silently redirect a stale explicit ID to its replacement.
    return matches.length === 1 && !matches[0].dossier?.archivedIntoCharacterId ? matches : [];
  });
  if (reference?.characterIds !== undefined) return videoReferenceCharacterBindingWarning(reference) ? [] : exactCharacters(reference.characterIds);
  return assetReferenceCharacterOwners(project, asset);
};

/** Scene replacement needs the same explicit provenance as an identity photo.
 * A scene-looking filename, asset category or selected use is not location ID. */
export const videoReferenceLocationOwners = (project: Project, asset: ReferenceAsset): Location[] => {
  if (!imageAsset(asset) || project.assets.filter((entry) => entry.id === asset.id).length !== 1) return [];
  if (typeof asset.characterReferenceId === 'string' && asset.characterReferenceId.trim()) return [];
  const exactLocations = (ids: readonly string[]): Location[] => unique(ids).flatMap((id) => {
    const matches = project.locations.filter((location) => location.id === id);
    return matches.length === 1 ? matches : [];
  });
  if (asset.sourceEntityId || asset.sourceEntityKind) {
    if (!asset.sourceEntityId || asset.sourceEntityKind && asset.sourceEntityKind !== 'location' || ['character', 'prop'].includes(asset.type)) return [];
    if (project.characters.some((entity) => entity.id === asset.sourceEntityId) || project.props.some((entity) => entity.id === asset.sourceEntityId)) return [];
    const owners = exactLocations([asset.sourceEntityId]);
    return asset.sourceEntityKind === 'location' ? owners : owners.filter((owner) => owner.assetIds.includes(asset.id));
  }
  return exactLocations(project.locations.filter((location) => location.assetIds.includes(asset.id)).map((location) => location.id));
};

/** Only a unique same-location selection replaces an old scene binding. If
 * the user chose supplemental non-character pictures, an unproven scene must
 * not silently bind to the continuity tail instead of those choices. */
export const videoReferenceSceneReplacement = (
  project: Project, original: ReferenceAsset, references: readonly VideoImageReference[],
): { scene: boolean; referenceIndex?: number; preventTailFallback: boolean } => {
  const owners = videoReferenceLocationOwners(project, original);
  const scene = original.type !== 'last-frame' && original.referenceRole !== 'last-frame'
    && (owners.length > 0 || ['location', 'first-frame'].includes(original.type)
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
    preventTailFallback: selections.some(({ reference, locationOwners }) => locationOwners.length > 0
      || !['character', 'subject', 'first-frame', 'last-frame'].includes(reference.role)),
  };
};

export const videoH3BindingForPrompt = (
  project: Project, draft: VideoGenerationDraft,
): VideoH3ReferenceBinding | undefined => {
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

/** Mirrors input serialization, not the dense upload loop. Picture N refers
 * to an explicitly mapped physical input for node workflows, and to the
 * actual array position for array APIs. Opaque templates are not guessed. */
export const videoH3PictureNumbers = (
  references: readonly VideoImageReference[], context: VideoH3ReferenceContext,
): { numbers?: number[]; warning?: string } => {
  const slots = references.map(videoReferenceSlotIndex);
  if (slots.some((slot) => !Number.isSafeInteger(slot) || slot < 0) || new Set(slots).size !== slots.length) {
    return { warning: '参考图槽号无效，未猜测 H3 图片编号；请核对实际输入槽。' };
  }
  if (context.backend === 'comfyui') {
    if (slots.every((slot) => context.workflow?.mapping.images[slot])) return { numbers: slots.map((slot) => slot + 1) };
    return { warning: '当前 ComfyUI 输入映射不完整，未自动写入 H3 图片编号。' };
  }
  const api = context.api;
  if (api?.provider === 'rhtv_web') {
    if (api.rhtvMode && api.rhtvMode !== 'reference') return { warning: 'rhTV 首尾帧按明确用途放置，不添加多人物 Picture 引用。' };
    return { numbers: references.map((_, index) => index + 1) };
  }
  if (api?.provider === 'minimax') return { warning: '当前接口只传首尾帧，不提供 H3 多人物 Picture 引用；未虚构人物图片编号。' };
  if (api?.provider === 'runninghub') {
    const imageFields = api.runningHubMappedFields?.filter((field) => field.kind === 'image') || [];
    if (imageFields.length && slots.every((slot) => imageFields.filter((field) => field.imageIndex === slot).length === 1)) {
      return { numbers: slots.map((slot) => slot + 1), warning: runningHubPictureMappingInfo };
    }
    return { warning: 'RunningHub 缺少明确图片槽映射，未根据上传顺序猜测 H3 图片编号。' };
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

/** Add only a request-local identity association inside a proven visual shot.
 * It never creates Subject/voice IDs or moves a later character to Shot 1. */
const participationReferenceEdit = (
  prompt: string,
  character: Character,
  characters: readonly Character[],
  shotIndexes: readonly number[],
  numbers: readonly number[],
): VideoPictureReferenceEdit | undefined => {
  const masked = maskReferenceLiterals(prompt);
  const description = /^(?:integrated_multimodal_description|detailed_description):/mu.exec(masked);
  if (!description) return undefined;
  const sectionStart = description.index + description[0].length;
  const nextSection = /^(?:overall_soundscape|non_diegetic_music):/mu.exec(masked.slice(sectionStart));
  const sectionEnd = nextSection ? sectionStart + nextSection.index : prompt.length;
  const shots = [...masked.slice(sectionStart, sectionEnd).matchAll(/\[Shot[ \t]*([1-9]\d*)\]/gu)];
  const index = shots.findIndex((shot) => shotIndexes.includes(Number(shot[1])));
  if (index < 0) return undefined;
  const start = sectionStart + shots[index].index! + shots[index][0].length;
  const end = sectionStart + (shots[index + 1]?.index ?? sectionEnd - sectionStart);
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

/** Pure serialization of explicit identity anchors. Warning-only failures
 * return the untouched text and never ask a model to regenerate a story. */
export const prepareVideoH3ReferenceDraft = (
  project: Project, draft: VideoGenerationDraft, context: VideoH3ReferenceContext,
): PreparedVideoH3ReferenceDraft => {
  const referenceProject = videoH3ReferenceProject(project, draft);
  const binding = videoH3BindingForPrompt(project, draft);
  const basePrompt = binding?.basePrompt || draft.prompt;
  const sourceBoard = referenceProject.storyboards.filter((board) => board.id === draft.source?.storyboardId);
  const participation = isH3(basePrompt) ? sourceBoard.length === 1
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
  if (!isH3(draft.prompt)) return unchanged([]);
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
  const unresolvedPictureNumbers = new Set<number>();
  const pictureTokens = [...maskReferenceLiterals(binding.basePrompt).matchAll(pictureReferencePattern())];
  for (const token of pictureTokens) {
    const originalNumber = Number(token[1] ?? token[2] ?? token[3]);
    if (pictureNumbers.has(originalNumber)) continue;
    const source = binding.sourcePictures?.filter((entry) => entry.number === originalNumber);
    const assetId = source?.length === 1 ? source[0].assetId : undefined;
    const selected = assetId ? draft.references.flatMap((reference, index) => reference.assetId === assetId ? [index] : []) : [];
    const sourceAssets = assetId ? project.assets.filter((asset) => asset.id === assetId) : [];
    const sourceAsset = sourceAssets.length === 1 ? sourceAssets[0] : undefined;
    if (sourceAsset && sourceAsset.characterReferenceId !== undefined) {
      // Generation provenance cannot prove who an older prompt associated with
      // this image. Rebuild only this request's picture syntax from the current
      // explicit binding and valid identity anchors, even if the old source ID
      // happens to equal the newly chosen character.
      pictureNumbers.set(originalNumber, null);
      warnings.push(`原 H3 的 ${token[0]} 已按本次明确人物绑定重建图片引用；原稿、人物和剧情保持不变，不阻止生成。`);
      continue;
    }
    let numbers = selected.flatMap((index) => plan.numbers?.[index] ? [plan.numbers[index]] : []);
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
      unresolvedPictureNumbers.add(originalNumber);
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
      text: ` Visual identity reference for ${identity.name}${identity.subjectToken ? ` ${identity.subjectToken}` : ''}${identity.speakerToken ? ` ${identity.speakerToken}` : ''}: ${numbers.map((number) => `<Picture ${number}>`).join(', ')}.` });
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
  const changedKnownMapping = [...pictureNumbers].some(([number, mapped]) => mapped !== null && (mapped.length !== 1 || mapped[0] !== number));
  const issue = pictureSourceIssues.length && changedKnownMapping
    ? `旧 H3 图片清单仅能证明部分引用，本次已同步已知图片编号，但剩余 ${[...unresolvedPictureNumbers].map((number) => `<Picture ${number}>`).join('、')} 的来源尚未证明；不能将这份混合编号稿提交。请恢复原图片清单或明确更新本段参考图引用后重试。`
    : undefined;
  return { draft: { ...draft, prompt,
    ...(!draft.reuseTaskId && !draft.h3ReferenceBinding && draft.source && draft.source.language === undefined
      && binding.sourceLanguage === 'en' && sourceBoard.length === 1
      && binding.basePrompt === sourceBoard[0].officialPromptEn
      && sourceBoard[0].officialPromptEnSource === sourceBoard[0].officialPromptZh
      ? { source: { ...draft.source, language: 'en' as const } } : {}),
    h3ReferenceBinding: { ...binding, renderedPrompt: prompt, characterStates: structuredClone(characterStates) }, h3ReferenceWarnings: unique(warnings) }, warnings: unique(warnings), characterStates, ...(issue ? { issue } : {}) };
};

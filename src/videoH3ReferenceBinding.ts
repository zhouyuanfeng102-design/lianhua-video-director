import type { Character, H3IdentityBindings, Location, Project, ReferenceAsset, VideoTaskApiConfig } from './types';
import type { VideoGenerationDraft, VideoImageReference } from './videoGenerationTypes';
import type { VideoReferenceUsageContext } from './videoReferenceUsage';
import { videoReferenceSlotIndex } from './videoReferenceSlots';
import { getH3IdentityBindingIssues, normalizeH3IdentityBindings } from './h3IdentityBindings';
import { officialH3ContextForStoryboard } from './officialH3Context';

/** This is an editing provenance record, not a second prompt or an AI review.
 * Rendering always starts from the same authored text, so repeated selections
 * cannot accumulate instructions or move dialogue/shot timing. */
export interface VideoH3ReferenceBinding {
  version: 1;
  projectId: string;
  basePrompt: string;
  identities: H3IdentityBindings;
  renderedPrompt: string;
  /** Original persisted manifest, never reconstructed from current slot order. */
  sourcePictures?: Array<{ number: number; assetId: string }>;
}

export interface PreparedVideoH3ReferenceDraft {
  draft: VideoGenerationDraft;
  warnings: string[];
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
  if (asset.sourceEntityId || asset.sourceEntityKind) {
    if (!asset.sourceEntityId || asset.sourceEntityKind && asset.sourceEntityKind !== 'character' || ['location', 'prop'].includes(asset.type)) return [];
    if (project.locations.some((entity) => entity.id === asset.sourceEntityId) || project.props.some((entity) => entity.id === asset.sourceEntityId)) return [];
    const owners = exactCharacters([asset.sourceEntityId]);
    return asset.sourceEntityKind === 'character' ? owners : owners.filter((owner) => owner.assetIds.includes(asset.id));
  }
  return exactCharacters(project.characters.filter((character) => character.assetIds.includes(asset.id)).map((character) => character.id));
};

/** Scene replacement needs the same explicit provenance as an identity photo.
 * A scene-looking filename, asset category or selected use is not location ID. */
export const videoReferenceLocationOwners = (project: Project, asset: ReferenceAsset): Location[] => {
  if (!imageAsset(asset) || project.assets.filter((entry) => entry.id === asset.id).length !== 1) return [];
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
  if (existing?.version === 1 && existing.projectId === project.id
    && normalizedIdentities && typeof existing.basePrompt === 'string' && typeof existing.renderedPrompt === 'string'
    && (draft.prompt === existing.renderedPrompt || draft.prompt === existing.basePrompt)) return { ...existing,
      identities: normalizedIdentities, sourcePictures: normalizedSourcePictures(existing.sourcePictures) };
  // A manual edit invalidates the exact anchors; do not silently reattach by
  // scanning names. A frozen task also must not borrow a later board revision.
  if (existing || draft.reuseTaskId || !draft.source?.storyboardId) return undefined;
  const matches = project.storyboards.filter((board) => board.id === draft.source!.storyboardId);
  if (matches.length !== 1) return undefined;
  const board = matches[0];
  const english = draft.source.language === 'en';
  const basePrompt = english ? board.officialPromptEn : board.officialPromptZh;
  const identities = normalizeH3IdentityBindings(english ? board.h3IdentityBindingsEn : board.h3IdentityBindings);
  if (!basePrompt || draft.prompt !== basePrompt || !identities) return undefined;
  const sourcePictures = (board.targetOutput?.referenceManifest || []).flatMap((entry) => {
    const token = typeof entry.token === 'string' ? entry.token.match(/^<Picture ([1-9]\d*)>$/u) : undefined;
    return token && typeof entry.id === 'string' && entry.id ? [{ number: Number(token[1]), assetId: entry.id }] : [];
  });
  return { version: 1, projectId: project.id, basePrompt, identities: structuredClone(identities), renderedPrompt: basePrompt, sourcePictures };
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

/** Literal dialogue, sound payloads and quoted on-screen text are not asset
 * references. Keep UTF-16 offsets so edits apply to the untouched source. */
const maskReferenceLiterals = (value: string): string => {
  const ranges = [...value.matchAll(/<(d|sound)>[\s\S]*?(?:<\/\1>|$)/giu)].map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
  const pairs: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' };
  for (let index = 0; index < value.length; index += 1) {
    const protectedRange = ranges.find((range) => range.start <= index && index < range.end);
    if (protectedRange) { index = protectedRange.end - 1; continue; }
    const opening = value[index]; const closing = pairs[opening];
    if (!closing || opening === "'" && /[\p{L}\p{N}_]/u.test(value[index - 1] || '')) continue;
    let end = index + 1; let escaped = false;
    for (; end < value.length; end += 1) {
      if ((opening === '"' || opening === "'") && value[end] === '\\' && !escaped) { escaped = true; continue; }
      if (value[end] === closing && !escaped) break;
      escaped = false;
    }
    if (end < value.length) { ranges.push({ start: index, end: end + 1 }); index = end; }
  }
  let masked = value;
  for (const range of ranges) masked = masked.slice(0, range.start) + masked.slice(range.start, range.end).replace(/[^\r\n]/gu, (character) => ' '.repeat(character.length)) + masked.slice(range.end);
  return masked;
};

export interface VideoPictureReferenceEdit { start: number; end: number; text: string }
const pictureReferencePattern = (): RegExp => /<Picture\s+(\d+)>|\[(?:Pic|Picture)\s*(\d+)\]/giu;
const pictureReferenceToken = String.raw`(?:<Picture\s+\d+>|\[(?:Pic|Picture)\s*\d+\])`;
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
    if (!tokens.some((token) => numbers.get(Number(token[1] ?? token[2])) === null)) continue;
    const rendered = tokens.flatMap((token) => {
      const mapped = numbers.get(Number(token[1] ?? token[2]));
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
    const mapped = numbers.get(Number(token[1] ?? token[2]));
    if (mapped === undefined) continue;
    edits.push({ start, end: start + token[0].length,
      text: mapped === null ? '' : mapped.map((number) => token[0].replace(/\d+/u, String(number))).join(', ') });
  }
  return edits;
};

const videoH3ReferenceProject = (project: Project, draft: VideoGenerationDraft): Project => {
  const sourceBoards = project.storyboards.filter((board) => board.id === draft.source?.storyboardId);
  return sourceBoards.length === 1
    ? { ...project, characters: [...(officialH3ContextForStoryboard(project, sourceBoards[0]).characters || project.characters)] }
    : project;
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

/** Pure serialization of explicit identity anchors. Warning-only failures
 * return the untouched text and never ask a model to regenerate a story. */
export const prepareVideoH3ReferenceDraft = (
  project: Project, draft: VideoGenerationDraft, context: VideoH3ReferenceContext,
): PreparedVideoH3ReferenceDraft => {
  const referenceWarnings = draft.references.flatMap((reference, index) => {
    const warning = videoReferenceCharacterBindingWarning(reference);
    return warning ? [`图片槽 ${videoReferenceSlotIndex(reference, index) + 1} ${warning}`] : [];
  });
  const unchanged = (issues: string[]): PreparedVideoH3ReferenceDraft => {
    const warnings = unique([...referenceWarnings, ...issues]);
    return { draft: { ...draft, h3ReferenceWarnings: warnings }, warnings };
  };
  if (!isH3(draft.prompt)) return unchanged([]);
  // A true retry retains its frozen, already-displayed submission. Selecting
  // current images explicitly removes reuseTaskId in the picker.
  if (draft.reuseTaskId) return referenceWarnings.length ? unchanged(draft.h3ReferenceWarnings || []) : { draft, warnings: draft.h3ReferenceWarnings || [] };
  const binding = videoH3BindingForPrompt(project, draft);
  if (!binding) return unchanged(draft.references.length
    ? ['这份 H3 稿没有可信的可定位人物绑定，已保留原文；未猜测参考图是谁，不阻止生成。需要补齐时请明确修复本段提示词。'] : []);
  const warnings: string[] = [...referenceWarnings];
  // Match the frozen public identities used to author this segment. Same-ID
  // live asset associations and this submission's explicit characterIds are
  // still authoritative for pictures, while later display-name edits are not.
  const referenceProject = videoH3ReferenceProject(project, draft);
  const plan = videoH3PictureNumbers(draft.references, context.api?.provider === 'rhtv_web'
    ? { ...context, api: { ...context.api, rhtvMode: (draft.parameters.rhtv_mode || context.api.rhtvMode) as VideoTaskApiConfig['rhtvMode'] } } : context);
  if (draft.references.length && plan.warning) warnings.push(plan.warning);
  const characterPictures = new Map<string, number[]>();
  for (const [index, reference] of draft.references.entries()) {
    if (videoReferenceCharacterBindingWarning(reference)) continue;
    // A continuity/scene picture is not an extra face or voice source.
    if (!['character', 'subject'].includes(reference.role) && reference.characterIds === undefined) continue;
    const assets = project.assets.filter((asset) => asset.id === reference.assetId);
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
  const pictureTokens = [...maskReferenceLiterals(binding.basePrompt).matchAll(/<Picture ([1-9]\d*)>/gu)];
  for (const token of pictureTokens) {
    const source = binding.sourcePictures?.filter((entry) => entry.number === Number(token[1]));
    const assetId = source?.length === 1 ? source[0].assetId : undefined;
    const selected = assetId ? draft.references.findIndex((reference) => reference.assetId === assetId) : -1;
    let numbers = selected >= 0 && plan.numbers?.[selected] ? [plan.numbers[selected]] : [];
    if (!numbers.length && assetId) {
      const originalAssets = project.assets.filter((asset) => asset.id === assetId);
      const owners = originalAssets.length === 1 ? videoReferenceCharacterOwners(referenceProject, originalAssets[0]) : [];
      if (owners.length && owners.every((owner) => characterPictures.has(owner.id))) numbers = unique(owners.flatMap((owner) => characterPictures.get(owner.id)!));
      else if (originalAssets.length === 1) {
        const replacement = videoReferenceSceneReplacement(project, originalAssets[0], draft.references);
        if (replacement.referenceIndex !== undefined && plan.numbers?.[replacement.referenceIndex]) {
          numbers = [plan.numbers[replacement.referenceIndex]];
        } else if (replacement.scene && replacement.preventTailFallback) {
          pictureNumbers.set(Number(token[1]), null);
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
        pictureNumbers.set(Number(token[1]), null);
        warnings.push(`原 H3 的 ${token[0]} 对应图片未在本次选择中且没有可证明的替图，已仅移除这条图片引用；人物、剧情和对白保留，不阻止生成。`);
        continue;
      }
      return unchanged(unique([...warnings,
        `原 H3 的 ${token[0]} 缺少可证明的原资产与本次图片对应，已保留当前完整稿；未附加冲突引用，不阻止生成。`]));
    }
    pictureNumbers.set(Number(token[1]), numbers);
  }
  const edits = videoPictureReferenceEdits(binding.basePrompt, pictureNumbers);
  for (const identity of identities) {
    const numbers = characterPictures.get(identity.characterId) || [];
    if (!numbers.length) continue;
    const issues = identityIssues.filter((issue) => issue.characterId === identity.characterId);
    if (issues.length) {
      warnings.push(`人物“${identity.name || '未命名'}”的 H3 身份锚点已失效：${unique(issues.map((issue) => issue.message)).join('；')}。本次未绑定该人物图片，未猜测或改写其剧情。`);
      continue;
    }
    const end = binding.basePrompt.indexOf(identity.referenceAnchor) + identity.referenceAnchor.length;
    edits.push({ start: end, end,
      text: ` Visual identity reference for ${identity.name}${identity.subjectToken ? ` ${identity.subjectToken}` : ''}${identity.speakerToken ? ` ${identity.speakerToken}` : ''}: ${numbers.map((number) => `<Picture ${number}>`).join(', ')}.` });
  }
  for (const id of characterPictures.keys()) if (!identities.some((identity) => identity.characterId === id)) {
    warnings.push('部分已选人物图不在本段已保存身份清单中，未新增角色或台词；仅提示，不阻止生成。');
  }
  let prompt = binding.basePrompt;
  for (const edit of edits.sort((a, b) => b.start - a.start)) prompt = prompt.slice(0, edit.start) + edit.text + prompt.slice(edit.end);
  return { draft: { ...draft, prompt, h3ReferenceBinding: { ...binding, renderedPrompt: prompt }, h3ReferenceWarnings: unique(warnings) }, warnings: unique(warnings) };
};

import type { Character, Project, ReferenceAsset, Storyboard } from './types';
import type { VideoGenerationDraft, VideoImageReference } from './videoGenerationTypes';
import { collectOfficialH3ReferenceAssets, hasCurrentOfficialH3Prompt } from './officialPrompt';
import { officialH3ContextForStoryboard } from './officialH3Context';
import { isNsfwPrivateProfileAsset } from './nsfwPrivateAssets';
import { assertVideoReferenceSlots, videoReferenceSlotIndex } from './videoReferenceSlots';
import { videoH3BindingForPrompt, videoPictureReferenceEdits, videoReferenceCharacterOwners, videoReferenceSceneReplacement } from './videoH3ReferenceBinding';

export interface PreparedVideoTailCharacterDraft {
  /** References after the tail. The caller inserts the selected tail at slot zero.
   * prompt is ready to submit: only existing image bindings have changed. */
  draft: VideoGenerationDraft;
  issue?: string;
  characterLabels?: string[];
  /** Default selection decisions are disclosed; source assets are never deleted. */
  notices?: string[];
}

const picturePattern = (): RegExp => /<Picture\s+(\d+)>|\[(?:Pic|Picture)\s*(\d+)\]/giu;
/** Literal dialogue, sound payloads and quoted text are authored content, not
 * image bindings. Mask them without moving offsets or changing line breaks so
 * every edit can be applied to the untouched source text. */
const maskPromptLiterals = (value: string): string => {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(/<(d|sound)>[\s\S]*?(?:<\/\1>|$)/giu)) {
    ranges.push({ start: match.index!, end: match.index! + match[0].length });
  }
  const quotePairs: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' };
  for (let index = 0; index < value.length; index += 1) {
    const protectedRange = ranges.find((range) => range.start <= index && index < range.end);
    if (protectedRange) { index = protectedRange.end - 1; continue; }
    const opening = value[index]; const closing = quotePairs[opening];
    // English contractions/possessives are prose, not quote delimiters.
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
  for (const range of ranges) {
    masked = masked.slice(0, range.start) + masked.slice(range.start, range.end).replace(/[^\r\n]/gu, (character) => ' '.repeat(character.length)) + masked.slice(range.end);
  }
  return masked;
};
const pictureNumbers = (value: string): number[] => [...maskPromptLiterals(value).matchAll(picturePattern())]
  .map((match) => Number(match[1] ?? match[2]));
const unique = <T,>(values: readonly T[]): T[] => [...new Set(values)];
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const replaceableSceneRoles = new Set(['scene', 'composition', 'first-frame', 'grid']);

const isImage = (asset: ReferenceAsset): boolean => asset.mediaType !== 'audio' && asset.mediaType !== 'video'
  && asset.type !== 'audio' && asset.type !== 'video'
  && !asset.mimeType?.startsWith('audio/') && !asset.mimeType?.startsWith('video/');

/** A generated character card is allowed; a generated shot/extracted face is
 * not a stable identity source. This is provenance routing, not visual review. */
const isOrdinaryIdentityImage = (asset: ReferenceAsset): boolean => isImage(asset) && !asset.missing
  && !isNsfwPrivateProfileAsset(asset)
  && (typeof asset.characterReferenceId === 'string' && Boolean(asset.characterReferenceId.trim())
  || !asset.sourceStoryboardId && !asset.sourceShotId && !asset.sourceVideoTaskId
  && !asset.sourceVideoAssetId && !asset.sourceVideoEditId && !asset.sourceClipId
  && !['first-frame', 'last-frame', 'storyboard-frame', 'snapshot', 'grid'].includes(asset.imageVariant || '')
  && asset.type !== 'first-frame' && asset.type !== 'last-frame');

const characterOwners = (project: Project, asset: ReferenceAsset): Character[] => videoReferenceCharacterOwners(project, asset);

const ownsCharacterReference = (project: Project, asset: ReferenceAsset, reference?: VideoImageReference): boolean => (
  Boolean(characterOwners(project, asset).length)
  || reference?.role === 'character' || reference?.role === 'subject'
  || asset.referenceRole === 'character' || asset.referenceRole === 'subject'
  || asset.role === 'character' || asset.type === 'character'
);

const canReplaceWithTail = (asset: ReferenceAsset, reference?: VideoImageReference): boolean => (
  reference?.role !== 'last-frame' && asset.type !== 'last-frame'
  && (replaceableSceneRoles.has(reference?.role || '')
    || replaceableSceneRoles.has(asset.referenceRole || '')
    || replaceableSceneRoles.has(asset.role)
    || asset.type === 'first-frame' || asset.type === 'location')
);

const segmentCharacterIds = (project: Project, board: Storyboard | undefined): Set<string> => {
  const ids = new Set<string>();
  if (!board) return ids;
  // This is name-to-existing-binding lookup, never an audit of whether the
  // AI's story/character choice is correct. Only this segment's authored
  // visual subject/action fields participate; never the entire source novel.
  const subjects = board.shots.map((shot) => `${shot.subject || ''}\n${shot.action || ''}`).join('\n');
  const currentCharacters = project.characters.filter((character) => !character.dossier?.archivedIntoCharacterId);
  for (const character of currentCharacters) {
    const name = clean(character.name);
    if (!name) continue;
    const occurrences = [...subjects.matchAll(new RegExp(escapePattern(name), 'gu'))];
    const exactOccurrence = occurrences.some((match) => {
      const start = match.index!; const end = start + name.length;
      if (/^[\x00-\x7F]+$/u.test(name)
        && (/[A-Za-z0-9_]/u.test(subjects[start - 1] || '') || /[A-Za-z0-9_]/u.test(subjects[end] || ''))) return false;
      // A character named 林 must not be auto-added merely because 林峰 is
      // on screen. Longest explicit name wins for that same text occurrence.
      return !currentCharacters.some((other) => {
        const otherName = clean(other.name);
        if (otherName.length <= name.length || !otherName.includes(name)) return false;
        return [...subjects.matchAll(new RegExp(escapePattern(otherName), 'gu'))]
          .some((otherMatch) => otherMatch.index! <= start && otherMatch.index! + otherName.length >= end);
      });
    });
    if (exactOccurrence) ids.add(character.id);
  }
  return ids;
};

interface PictureSourceMap { sources: Map<number, string>; issue?: string; trustedSubjectPrompt?: string }

const originalPictureSources = (
  project: Project, board: Storyboard | undefined, draft: VideoGenerationDraft,
): PictureSourceMap => {
  const used = unique(pictureNumbers(draft.prompt));
  if (!used.length) return { sources: new Map() };
  const exact = (value: string | undefined): boolean => Boolean(value?.trim() && value.trim() === draft.prompt.trim());
  const savedZh = Boolean(board && exact(board.officialPromptZh)
    && board.targetOutput?.prompt === board.officialPromptZh);
  const savedEn = Boolean(board && exact(board.officialPromptEn)
    && board.officialPromptEnSource === board.officialPromptZh
    && board.targetOutput?.prompt === board.officialPromptZh);
  const savedTarget = Boolean(board && exact(board.targetOutput?.prompt));
  const savedText = Boolean(board && [board.officialPromptZh, board.officialPromptEn, board.finalPrompt, board.englishPrompt, board.promptPlan?.canonicalPrompt].some(exact));
  const officialContext = officialH3ContextForStoryboard(project, board);
  const sources = new Map<number, string>();
  if (board && (savedZh || savedEn || savedTarget)) {
    const manifest = board.targetOutput?.referenceManifest || [];
    for (const entry of manifest) {
      const token = clean(entry.token);
      const match = token.match(/^(?:<Picture\s+(\d+)>|\[(?:Pic|Picture)\s*(\d+)\])$/iu);
      if (!match) continue;
      const index = Number(match[1] ?? match[2]); const assetId = clean(entry.id);
      if (!assetId || index < 1 || sources.has(index)) {
        return { sources, issue: '这份提示词保存的图片编号清单不完整或重复，无法确定原图片与人物的对应关系。' };
      }
      sources.set(index, assetId);
    }
    // Older official artifacts may lack the saved manifest. Only a verified
    // current source fingerprint permits reconstructing its compiler order.
    if (!sources.size && hasCurrentOfficialH3Prompt(board, officialContext)) {
      let index = 0;
      for (const asset of collectOfficialH3ReferenceAssets(board, project.assets, officialContext.characters)) {
        if (isImage(asset)) sources.set(++index, asset.id);
      }
    }
    if (sources.size || manifest.length) {
      const unknown = used.find((index) => !sources.has(index));
      return unknown === undefined
        ? { sources, trustedSubjectPrompt: savedEn ? board.officialPromptZh : draft.prompt }
        : { sources, issue: `提示词引用了图片${unknown}，但保存的图片清单没有该编号，不能猜测人物绑定。` };
    }
  }
  if (board && savedText) {
    const imageIds = new Set(project.assets.filter(isImage).map((asset) => asset.id));
    const cleanOrder = (ids: readonly string[]): string[] => unique(ids).filter((id) => imageIds.has(id));
    const compilerOrder = collectOfficialH3ReferenceAssets(board, project.assets, officialContext.characters).filter(isImage).map((asset) => asset.id);
    const editorSourceOrder = cleanOrder([
      ...(board.globalReferenceAssetIds || []), ...(board.promptPlan?.referenceAssetIds || []), ...(board.promptTrace?.referenceAssetIds || []),
      ...board.shots.flatMap((shot) => shot.referenceAssetIds || []), board.firstFrameAssetId || '', board.lastFrameAssetId || '',
    ]);
    const savedOrders = [compilerOrder, editorSourceOrder].filter((order) => order.length);
    for (const number of used) {
      const candidates = unique(savedOrders.map((order) => order[number - 1]).filter(Boolean));
      if (number < 1 || candidates.length !== 1 || savedOrders.some((order) => !order[number - 1])) {
        return { sources, issue: `这份已保存提示词缺少原图片编号清单，图片${number}在现有绑定顺序中没有唯一对应；未猜测或改写原稿。` };
      }
      sources.set(number, candidates[0]);
    }
    return { sources, trustedSubjectPrompt: savedEn ? board.officialPromptZh : draft.prompt };
  }
  // Standalone drafts use the visible slot order as their only explicit
  // manifest. A modified saved H3 artifact is different: its compiler order
  // may differ from the editor, so never silently reinterpret it as slot order.
  if (board && /(?:^|\n)subject_definitions:|<Picture\s+\d+>/u.test(draft.prompt)) {
    return { sources, issue: '当前H3正文已不同于保存的交付稿，无法可靠核对旧图片编号；原稿与选图保持不变。' };
  }
  draft.references.forEach((reference, index) => sources.set(videoReferenceSlotIndex(reference, index) + 1, reference.assetId));
  const unknown = used.find((index) => !sources.has(index));
  return unknown === undefined ? { sources, trustedSubjectPrompt: draft.prompt }
    : { sources, issue: `提示词引用了图片${unknown}，当前只有${draft.references.length}张原参考图，无法对应。` };
};

interface SubjectBinding { indices: number[] }

/** Read the compiler's name/source envelope only. No character profile or
 * authored shot prose is regenerated, summarized or filtered. */
const subjectBindings = (
  project: Project, sourcePrompt: string, characterIndices: ReadonlyMap<string, number[]>,
  unreferencedCharacterIds: ReadonlySet<string>,
): Map<number, SubjectBinding> => {
  const result = new Map<number, SubjectBinding>();
  const section = maskPromptLiterals(sourcePrompt).match(/(?:^|\n)subject_definitions:\s*([\s\S]*?)(?=\r?\nsummary:|$)/u)?.[1] || '';
  for (const line of section.split(/\r?\n/u)) {
    const match = line.match(/^\s*<Subject (\d+)>\s+is\s+(.+?)\s+(?:referenced from|defined by the canonical prompt)(?=\s|:)/u);
    if (!match) continue;
    const name = match[2].trim(); const index = Number(match[1]);
    const characters = project.characters.filter((character) => !character.dossier?.archivedIntoCharacterId && character.name.trim() === name);
    if (characters.length === 1 && characterIndices.has(characters[0].id)) {
      result.set(index, { indices: characterIndices.get(characters[0].id)! });
    } else if (characters.length === 1 && unreferencedCharacterIds.has(characters[0].id)) {
      result.set(index, { indices: [] });
    }
  }
  return result;
};

interface PromptEdit { start: number; end: number; value: string }
const pictureTokenSource = String.raw`(?:<Picture\s+\d+>|\[(?:Pic|Picture)\s*\d+\])`;
const pictureListSource = `${pictureTokenSource}(?:(?:[ \\t]*[、,，][ \\t]*|[ \\t]+(?:and[ \\t]+)?|(?=<|\\[))${pictureTokenSource})*`;

/** Keep each original token spelling, separator and whitespace when only its
 * number changes. A count change replaces this binding list, never prose. */
const renderPictureList = (source: string, indices: readonly number[]): string => {
  const tokens = [...source.matchAll(picturePattern())];
  if (tokens.length === indices.length) {
    let index = 0;
    return source.replace(picturePattern(), (token) => token.replace(/\d+/u, String(indices[index++])));
  }
  const token = tokens[0]?.[0] || '<Picture 1>';
  const separator = tokens.length > 1 ? source.slice(tokens[0].index! + tokens[0][0].length, tokens[1].index) : '、';
  return indices.map((index) => token.replace(/\d+/u, String(index))).join(separator);
};

const bindPrompt = (
  project: Project, draft: VideoGenerationDraft, sources: PictureSourceMap,
  indices: ReadonlyMap<number, number | null>, characterIndices: ReadonlyMap<string, number[]>,
  unreferencedCharacterIds: ReadonlySet<string>,
): string => {
  const subjectMap = subjectBindings(project, sources.trustedSubjectPrompt || '', characterIndices, unreferencedCharacterIds);
  const referenceNumbers = new Map([...indices].map(([index, value]) => [index, value === null ? null : [value]]));
  const maskedLines = maskPromptLiterals(draft.prompt).split(/(\r\n|\r|\n)/u);
  let section = '';
  return draft.prompt.split(/(\r\n|\r|\n)/u).map((line, lineIndex) => {
    if (/^(?:\r\n|\r|\n)$/u.test(line)) return line;
    const maskedLine = maskedLines[lineIndex];
    const sectionMatch = maskedLine.match(/^(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):/u);
    if (sectionMatch) section = sectionMatch[1];
    const edits: PromptEdit[] = [];
    const subject = maskedLine.match(/^\s*<Subject (\d+)>/u);
    const binding = subject ? subjectMap.get(Number(subject[1])) : undefined;
    if (binding && section === 'subject_definitions') {
      const source = maskedLine.match(new RegExp(`\\breferenced from([ \\t]+)(${pictureListSource})(?=[ \\t]*[:：])`, 'iu'));
      if (source) {
        const value = binding.indices.length
          ? `${source[0].slice(0, -source[2].length)}${renderPictureList(source[2], binding.indices)}` : 'defined by the canonical prompt';
        edits.push({ start: source.index!, end: source.index! + source[0].length, value });
      } else if (binding.indices.length) {
        const canonical = maskedLine.match(/\bdefined by the canonical prompt(?=[ \t]*[:：])/u);
        if (canonical) edits.push({ start: canonical.index!, end: canonical.index! + canonical[0].length,
          value: `referenced from ${renderPictureList('', binding.indices)}` });
      }
    }
    if (section === 'retention_analysis') {
      // Only a recognized Subject's existing reference envelope may change;
      // unknown prose is not semantically audited or rewritten here.
      for (const part of maskedLine.matchAll(/<Subject (\d+)>[^\r\n]*?(?=<Subject \d+>|$)/gu)) {
        const retained = subjectMap.get(Number(part[1]));
        if (!retained) continue;
        for (const source of part[0].matchAll(new RegExp(`\\breference([ \\t]+)(${pictureListSource})`, 'giu'))) {
          const start = part.index! + source.index!;
          edits.push({ start, end: start + source[0].length, value: retained.indices.length
            ? `${source[0].slice(0, -source[2].length)}${renderPictureList(source[2], retained.indices)}` : '' });
        }
      }
    }
    // Preserve the character-specific envelopes above. Scene/other references
    // share the final serializer's safe syntax editing, including empty binding
    // removal; multiline dialogue/sound masks come from the whole prompt.
    for (const edit of videoPictureReferenceEdits(line, referenceNumbers, maskedLine)) {
      if (edits.some((existing) => edit.start < existing.end && edit.end > existing.start)) continue;
      edits.push({ start: edit.start, end: edit.end, value: edit.text });
    }
    let result = line;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
    }
    return result;
  }).join('');
};

/** Prepare tail+reference slots without rewriting the saved video prompt or
 * requesting text AI. Only existing image token/binding references change;
 * all authored plot, dialogue, shots and sound remain the source's own text. */
export const prepareVideoTailCharacterDraft = (
  project: Project, draft: VideoGenerationDraft,
  options: { /** Explicit post-tail selections: preserve any image, use and hole; do not auto-add identities. */ preserveSlots?: boolean } = {},
): PreparedVideoTailCharacterDraft => {
  const fail = (issue: string): PreparedVideoTailCharacterDraft => ({ draft, issue });
  try { assertVideoReferenceSlots(draft.references); }
  catch (cause) { return fail(cause instanceof Error ? cause.message : String(cause)); }
  const boards = project.storyboards.filter((board) => board.id === draft.source?.storyboardId);
  if (boards.length > 1) return fail('本段分镜ID重复，无法确定对应的人物与图片清单。');
  const board = boards[0];
  if (draft.source?.storyboardId && !board) return fail('本段原分镜已不存在，无法核对人物参考绑定。');
  const byId = new Map(project.assets.map((asset) => [asset.id, asset]));
  const references: VideoImageReference[] = [];
  const selectedAssets: ReferenceAsset[] = [];
  const notices: string[] = [];
  const replacedIds = new Set<string>();
  const seen = new Set<string>();
  for (const reference of draft.references) {
    if (seen.has(reference.assetId)) return fail('当前参考图ID重复，无法可靠同步图片槽与提示词编号。');
    seen.add(reference.assetId);
    const asset = byId.get(reference.assetId);
    if (!asset || !isImage(asset) || asset.missing) return fail(`参考图“${asset?.name || reference.assetId}”已缺失或不是可用图片，原选图未改变。`);
    if (options.preserveSlots) {
      // Explicit image choice and use belong to the user, even when the asset's
      // category differs. Neither a scene nor a user-selected private/general
      // image is rejected, coerced into a character or silently replaced by the tail.
      references.push({ ...reference }); selectedAssets.push(asset);
    } else if (reference.role !== 'last-frame' && isOrdinaryIdentityImage(asset) && ownsCharacterReference(project, asset, reference)) {
      const { slotIndex: _previousSlot, ...identityReference } = reference;
      references.push({ ...identityReference, assetId: asset.id, role: 'character' }); selectedAssets.push(asset);
    } else if (!isNsfwPrivateProfileAsset(asset) && canReplaceWithTail(asset, reference)) {
      replacedIds.add(asset.id);
      notices.push(`“${asset.name}”的开场画面职责改由图片1的本地真实末帧承担，原图片和原稿保留。`);
    } else {
      notices.push(`默认未选“${asset.name}”：本地末帧后的图片默认使用普通人物参考；需要时可在选择参考图中手动选用此图，类型不限制。`);
    }
  }
  const activeCharacterIds = segmentCharacterIds(project, board);
  const boundIds = unique([
    ...(board?.shots.flatMap((shot) => shot.referenceAssetIds || []) || []),
    ...(board?.globalReferenceAssetIds || []), ...(board?.promptPlan?.referenceAssetIds || []),
  ]);
  const unreferencedCharacterIds = new Set<string>();
  const selectedCharacterOwners = (asset: ReferenceAsset, index: number): Character[] => {
    const reference = references[index];
    // Match the final H3 serializer: scene/prop/etc. uses are not identity
    // sources unless the user explicitly supplied a character binding.
    return ['character', 'subject'].includes(reference.role) || reference.characterIds !== undefined
      ? videoReferenceCharacterOwners(project, asset, reference) : [];
  };
  if (options.preserveSlots) {
    for (const character of project.characters.filter((item) => !item.dossier?.archivedIntoCharacterId)) {
      if (!selectedAssets.some((asset, index) => selectedCharacterOwners(asset, index).some((owner) => owner.id === character.id))) {
        unreferencedCharacterIds.add(character.id);
      }
    }
  }
  for (const character of project.characters.filter((item) => !item.dossier?.archivedIntoCharacterId && activeCharacterIds.has(item.id))) {
    if (selectedAssets.some((asset, index) => selectedCharacterOwners(asset, index).some((owner) => owner.id === character.id))) continue;
    if (options.preserveSlots) continue;
    // Mentioning an incidental cast member is not a request for another
    // identity photo. Only explicit character-card/segment image bindings
    // create that requirement; do not guess narrative importance from names.
    const hasIdentityBinding = character.assetIds.length > 0 || boundIds.some((id) => {
      const asset = byId.get(id);
      return asset && isImage(asset) && characterOwners(project, asset).some((owner) => owner.id === character.id);
    });
    if (!hasIdentityBinding) { unreferencedCharacterIds.add(character.id); continue; }
    // The first ordinary image in the character's explicit assetIds is its
    // current primary binding. Never sweep the complete asset/history library.
    const ids = unique([...character.assetIds, ...boundIds]);
    const asset = ids.map((id) => byId.get(id)).find((candidate): candidate is ReferenceAsset => Boolean(
      candidate && isOrdinaryIdentityImage(candidate)
      && characterOwners(project, candidate).some((owner) => owner.id === character.id),
    ));
    if (!asset) {
      unreferencedCharacterIds.add(character.id);
      notices.push(`本段人物“${character.name}”没有可用的普通身份参考图，未自动选用私密资料或历史画面；可手动选择其它图片，也可仅使用本地末帧，不阻止生成。`);
      continue;
    }
    if (!references.some((reference) => reference.assetId === asset.id)) {
      references.push({ assetId: asset.id, role: 'character' }); selectedAssets.push(asset);
    }
  }
  if (!references.length && !options.preserveSlots) notices.push('本段未默认选中普通人物参考图；可以仅使用本地末帧，或手动选择场景、人物及其它参考图，不阻止生成。');
  const characterIndices = new Map<string, number[]>();
  const labels = selectedAssets.map((asset, index) => {
    const owners = selectedCharacterOwners(asset, index);
    owners.forEach((owner) => characterIndices.set(owner.id, [...(characterIndices.get(owner.id) || []), videoReferenceSlotIndex(references[index], index) + 2]));
    return owners.map((owner) => owner.name).join('、') || asset.name;
  });
  const identityBinding = videoH3BindingForPrompt(project, draft);
  if (identityBinding) {
    // Only the final transport mapping knows whether Picture numbers follow
    // physical nodes or a dense array. Defer pure serialization until the
    // caller has inserted the real/reserved tail; never assume slot + 2 here.
    return { draft: { ...draft, references, h3ReferenceBinding: identityBinding,
      referenceSlotRoles: options.preserveSlots ? draft.referenceSlotRoles : undefined }, characterLabels: labels, notices };
  }
  const sources = originalPictureSources(project, board, draft);
  const unchanged = (warning: string): PreparedVideoTailCharacterDraft => ({ draft: { ...draft, references,
    referenceSlotRoles: options.preserveSlots ? draft.referenceSlotRoles : undefined }, characterLabels: labels,
    notices: [...notices, `${warning} 仅提示，原提示词未改写，不阻止生成。`] });
  if (sources.issue) return unchanged(sources.issue);
  if (/(?:^|\n)(?:integrated_multimodal_description|subject_definitions):/u.test(draft.prompt)
    && (!board?.targetOutput?.referenceManifest.length || !sources.trustedSubjectPrompt)) {
    return unchanged('这份旧 H3 稿缺少可信的身份锚点或图片清单，未猜测人物与图片编号。');
  }
  const indices = new Map<number, number | null>();
  for (const oldIndex of unique(pictureNumbers(draft.prompt))) {
    const assetId = sources.sources.get(oldIndex)!;
    const retainedIndex = references.findIndex((reference) => reference.assetId === assetId);
    if (retainedIndex >= 0) { indices.set(oldIndex, videoReferenceSlotIndex(references[retainedIndex], retainedIndex) + 2); continue; }
    const asset = byId.get(assetId);
    if (!asset) {
      indices.set(oldIndex, null);
      notices.push(`图片${oldIndex}对应的原资产已不存在，已仅移除这条图片引用；未借用其它槽位，剧情和对白保留，不阻止生成。`);
      continue;
    }
    if (isNsfwPrivateProfileAsset(asset)) {
      indices.set(oldIndex, null);
      notices.push(`提示词中的图片${oldIndex}原绑定未选中的私密资料图，已仅移除这条图片引用；未改资料或剧情，也未误接到其它参考槽，不阻止生成。`);
      continue;
    }
    const ownerSlots = unique(characterOwners(project, asset).flatMap((owner) => characterIndices.get(owner.id) || []));
    if (ownerSlots.length === 1 && isOrdinaryIdentityImage(asset)) {
      indices.set(oldIndex, ownerSlots[0]); continue;
    }
    if (isOrdinaryIdentityImage(asset) && characterOwners(project, asset).length
      && characterOwners(project, asset).every((owner) => unreferencedCharacterIds.has(owner.id))) {
      // Explicitly deselecting a photo does not remove its authored character.
      // Only the image-binding token disappears; the definition, shots and
      // dialogue remain canonical and no missing identity photo is re-added.
      indices.set(oldIndex, null); continue;
    }
    const sceneReplacement = videoReferenceSceneReplacement(project, asset, references);
    if (sceneReplacement.referenceIndex !== undefined) {
      indices.set(oldIndex, videoReferenceSlotIndex(references[sceneReplacement.referenceIndex], sceneReplacement.referenceIndex) + 2);
      continue;
    }
    if (sceneReplacement.scene && sceneReplacement.preventTailFallback) {
      indices.set(oldIndex, null);
      notices.push(`提示词中的图片${oldIndex}（${asset.name}）场景引用没有唯一可证明的本次对应图片，已仅移除这条图片引用；未改剧情或绑定到本地末帧，不阻止生成。`);
      continue;
    }
    if (replacedIds.has(assetId) || canReplaceWithTail(asset)) {
      indices.set(oldIndex, 1);
      if (!replacedIds.has(assetId)) notices.push(`提示词中的图片${oldIndex}原为“${asset.name}”，其开场画面引用现绑定图片1的本地真实末帧。`);
      continue;
    }
    indices.set(oldIndex, null);
    notices.push(`提示词中的图片${oldIndex}（${asset.name}）本次未选中且没有唯一可证明的替图，已仅移除这条图片引用；人物、剧情和对白保留，不阻止生成。`);
  }
  const prompt = bindPrompt(project, draft, sources, indices, characterIndices, unreferencedCharacterIds);
  return { draft: { ...draft, prompt, references,
    referenceSlotRoles: options.preserveSlots ? draft.referenceSlotRoles : undefined }, characterLabels: labels, notices };
};

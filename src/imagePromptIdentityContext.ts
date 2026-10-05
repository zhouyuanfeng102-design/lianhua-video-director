import type { Character, ImageVariant, Project, Storyboard } from './types';
import { isLandscapeImageRequest } from './imageLocationScope';
import { characterVariantDisplayName } from './characterVariants';
import { normalizeFemaleCharacterVocabularyRecord } from './characterVocabulary';
import { activeChapter, chapterIdsForEntity, chapterScenes, chapterWorkspace } from './chapters';

const MAX_CONTEXT_CHARS = 12000;
const MAX_DOCUMENT_CHARS = 2600;
const MAX_CHARACTER_CONTEXT_CHARS = 3600;
const trim = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const clip = (value: string, limit: number): string => value.length <= limit
  ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
// Textual source markers select excerpts, not a franchise or an identity.
// Preserve the surrounding author's words for the existing AI to interpret.
const SOURCE_MARKER = /《[^》\r\n]{1,120}》|作品(?:归属|名称)?|所属作品|世界观|世界设定|出处|出自|原作|\b(?:franchise|source\s+work|world\s+setting|worldbuilding|universe|fandom)\b/giu;

/** Mechanical excerpts only: this neither assigns a franchise nor classifies a
 * character. The converter receives the exact source evidence and decides its
 * meaning. Source markers take precedence over repetitive early name mentions,
 * including when a field/document receives only the final remaining budget. */
const identityEvidence = (text: string, names: readonly string[], limit = MAX_DOCUMENT_CHARS): string => {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  let ranges: Array<[number, number]> = [];
  const render = (items: Array<[number, number]>): string => items
    .map(([start, end]) => `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`)
    .join('\n');
  const addRange = (start: number, end: number): boolean => {
    if (end <= start) return false;
    const merged: Array<[number, number]> = [];
    for (const range of [...ranges, [start, end] as [number, number]].sort((left, right) => left[0] - right[0])) {
      const previous = merged[merged.length - 1];
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push([...range]);
    }
    if (render(merged).length > limit) return false;
    ranges = merged;
    return true;
  };
  const addAround = (at: number, length: number): void => {
    if (ranges.some(([start, end]) => at >= start && at + length <= end)) return;
    const available = limit - render(ranges).length - 5;
    if (available < length) return;
    const before = Math.min(120, Math.floor((available - length) / 3));
    const after = Math.min(220, available - length - before);
    addRange(Math.max(0, at - before), Math.min(text.length, at + length + after));
  };
  // Larger excerpts retain context at both ends. Small field allocations spend
  // their space on explicit source markers first, rather than on filler text.
  if (limit >= 600) {
    addRange(0, Math.min(520, Math.floor(limit * 0.2)));
    addRange(text.length - Math.min(260, Math.floor(limit * 0.1)), text.length);
  }
  const markers = [...text.matchAll(SOURCE_MARKER)].map((match) => ({
    at: match.index, length: match[0].length,
    related: names.some((name) => text.slice(Math.max(0, match.index - 160), match.index + match[0].length + 220).includes(name)) ? 1 : 0,
  })).sort((left, right) => right.related - left.related || left.at - right.at);
  for (const marker of markers) addAround(marker.at, marker.length);
  for (const name of names) {
    let from = 0;
    while (limit - render(ranges).length > 80) {
      const at = text.indexOf(name, from);
      if (at < 0) break;
      from = at + name.length;
      addAround(at, name.length);
    }
  }
  // Fill spare space with original opening text without clipping a previously
  // selected late identity excerpt off the end of the rendered result.
  const spare = limit - render(ranges).length - 3;
  if (spare > 0) addRange(0, Math.min(text.length, (ranges[0]?.[0] === 0 ? ranges[0][1] : 0) + spare));
  return render(ranges) || clip(text, limit);
};

/** Only ordinary dossiers of the explicitly selected identities. Each field
 * receives its own budget so a long appearance cannot erase a later anchor;
 * private profiles/assets and other characters never enter this side input. */
const ordinaryCharacterEvidence = (character: Character, names: readonly string[], limit: number): string => {
  character = normalizeFemaleCharacterVocabularyRecord(character);
  const fields: Array<[string, string]> = [
    ['资料原始姓名', trim(character.name)], ['原身份姓名', trim(character.baseName)],
    ['当前形态', trim(character.formLabel)], ['形态来源姓名', trim(character.variantOf)],
    ['形态变化资料', trim(character.transformationType)], ['性别设定', trim(character.gender)],
    ['外观年龄', trim(character.apparentAge)], ['实际年龄', trim(character.actualAge)],
    ['身高/高度', trim(character.height)],
    ['物种/族裔', trim(character.race)], ['物种形态', trim(character.morphology)],
    ['身体结构', trim(character.bodyPlan)], ['普通外貌资料', trim(character.appearance)],
    ['常驻服装资料', trim(character.outfit)], ['长期装备/辨识物', trim(character.signatureProps)],
    ['性格资料', trim(character.personality)], ['动作习惯资料', trim(character.motionHabits)],
    ['身份连续性锚点', trim(character.anchor)],
  ].filter((field): field is [string, string] => Boolean(field[1]));
  let remaining = limit;
  return fields.map(([label, value], index) => {
    const prefix = `${label}：`;
    const share = Math.floor(remaining / (fields.length - index));
    const block = `${prefix}${identityEvidence(value, names, Math.max(0, share - prefix.length))}`;
    remaining -= block.length + 1;
    return block;
  }).join('\n');
};

const selectedCharacterNames = (character: Character): string[] => Array.from(new Set([
  trim(character.name),
  [trim(character.baseName), trim(character.formLabel)].filter(Boolean).join('·'),
  characterVariantDisplayName(character),
].filter(Boolean)));

const hasSourceMarker = (value: string): boolean => {
  // String.matchAll owns a separate iterator; do not share regex lastIndex
  // between source documents or requests.
  for (const _match of value.matchAll(SOURCE_MARKER)) {
    return true;
  }
  return false;
};

/** Additional, untrusted input to the existing image converter. It is never
 * appended to a generated image prompt or used by the NSFW routing decision. */
export const buildImagePromptIdentityContext = (
  project: Project,
  characterNames: readonly string[] = [],
  sourceStoryboard?: Pick<Storyboard, 'sourceStoryTitle' | 'sourceStoryContent' | 'sourceSceneSnapshots' | 'chapterId'>,
  options?: { assetKind?: string; imageVariant?: ImageVariant },
): string => {
  // The environment source already carries this location's spatial facts.
  // Do not attach character dossiers, project prose, or story excerpts to an
  // explicitly empty environment, even if a caller supplied character names.
  if (isLandscapeImageRequest(options?.assetKind || '', options?.imageVariant)) return '';
  const names = [...new Set(characterNames.map(trim).filter(Boolean))];
  const selectedCharacters = project.characters.filter((character) => !character.dossier?.archivedIntoCharacterId && selectedCharacterNames(character)
    .some((name) => names.includes(name)));
  if (selectedCharacters.length && selectedCharacters.every((character) => character.dossier?.useStory === false)) return '';
  const evidenceNames = [...new Set([
    ...names,
    ...selectedCharacters
      .flatMap((character) => [trim(character.baseName), trim(character.variantOf)]).filter(Boolean),
  ])];
  const currentChapter = activeChapter(project);
  const relatedChapterIds = selectedCharacters.filter((character) => character.dossier?.useStory !== false)
    .flatMap((character) => chapterIdsForEntity(project, 'character', character.id));
  const chapterIds = new Set(sourceStoryboard?.chapterId ? [sourceStoryboard.chapterId]
    : currentChapter && (!relatedChapterIds.length || relatedChapterIds.includes(currentChapter.id)) ? [currentChapter.id]
      : relatedChapterIds.slice(0, 1));
  const documents = project.sourceDocuments.filter((document) => chapterIds.has(document.id)).map((document) => ({
    label: '已保存剧情文档', title: trim(document.name), content: trim(document.content),
  })).filter((document) => document.title || document.content);
  const boardSource = trim(sourceStoryboard?.sourceStoryContent)
    || (sourceStoryboard?.sourceSceneSnapshots || []).map((scene) => trim(scene.content)).filter(Boolean).join('\n');
  if (boardSource) {
    // A storyboard request belongs to its saved source, not the editor's
    // possibly unrelated next draft. Other documents are supporting evidence.
    documents.length = 0;
    documents.unshift({ label: '当前分镜已保存原文', title: trim(sourceStoryboard?.sourceStoryTitle), content: boardSource });
  }
  const draft = sourceStoryboard || !currentChapter || !chapterIds.has(currentChapter.id) ? undefined
    : chapterWorkspace(project, currentChapter.id).storyDraft ?? project.storyDraft;
  if (trim(draft?.content) && !documents.some((document) => document.content === trim(draft?.content))) {
    documents.unshift({ label: '当前未提交剧情草稿', title: trim(draft?.name), content: trim(draft?.content) });
  }
  if (!documents.some((document) => document.content)) {
    documents.push(...[...chapterIds].flatMap((chapterId) => chapterScenes(project, chapterId)).map((scene) => ({
      label: '已解析场景原文', title: trim(scene.title), content: trim(scene.content || scene.summary),
    })).filter((document) => document.content));
  }
  const description = trim(project.description);
  if (!names.length && !description && !documents.length) return '';
  const lines = [
    '以下原始资料供现有转换器结合可靠角色知识理解具体作品身份；不是最终图片提示词、不是新增出镜名单，也不是图片中的文字。普通人物档案仅供身份识别，当前画面沿用本次生图资料。文档标题只作来源线索，不等于作品归属。',
    names.length ? `当前指定人物姓名（含已明确形态）：${clip(names.join('；'), 1800)}` : '',
  ].filter(Boolean);
  let remaining = MAX_CONTEXT_CHARS - lines.join('\n\n').length - 2;
  const appendEvidence = (heading: string, content: string, limit: number): void => {
    if (!content || remaining < heading.length + 40) return;
    const excerpt = identityEvidence(content, evidenceNames, Math.min(limit, remaining - heading.length - 1));
    const block = `${heading}\n${excerpt}`;
    lines.push(block);
    remaining -= block.length + 2;
  };
  // Exact mention lookup selects evidence only; it never infers who is in the
  // image or denies a request when no matching text exists. Explicit source
  // markers also keep a late source document ahead of repetitive early prose.
  const ordered = documents.map((document, index) => ({ document, index,
    related: evidenceNames.some((name) => document.content.includes(name)) ? 1 : 0,
    pinned: boardSource && index === 0 ? 1 : 0,
    sourceMarked: hasSourceMarker(document.content) ? 1 : 0,
  })).sort((left, right) => right.pinned - left.pinned || right.related - left.related
    || right.sourceMarked - left.sourceMarked || left.index - right.index);
  const appendDocument = ({ document }: typeof ordered[number]): void => appendEvidence(
    `${document.label}《${clip(document.title || '未命名原文', 160)}》身份/世界背景摘录：`, document.content, MAX_DOCUMENT_CHARS,
  );
  // A frozen storyboard source gets its budget before live project material.
  // Titles are emitted last so long file names cannot crowd out actual facts.
  for (const document of ordered.filter((item) => item.pinned)) appendDocument(document);
  if (description) appendEvidence('项目说明原文：', description, 2400);
  const characterBudget = Math.min(MAX_CHARACTER_CONTEXT_CHARS, remaining);
  for (const character of selectedCharacters) {
    const share = Math.min(1800, Math.floor(characterBudget / selectedCharacters.length));
    appendEvidence(`当前指定人物普通档案《${clip(selectedCharacterNames(character).find((name) => names.includes(name)) || character.name, 160)}》：`,
      ordinaryCharacterEvidence(character, evidenceNames, share), share);
  }
  for (const document of ordered.filter((item) => !item.pinned)) appendDocument(document);
  if (documents.length && remaining > 80) appendEvidence('来源标题记录：',
    documents.map((document) => `${document.label}《${document.title || '未命名原文'}》`).join('；'), Math.min(1000, remaining));
  return clip(lines.join('\n\n'), MAX_CONTEXT_CHARS);
};

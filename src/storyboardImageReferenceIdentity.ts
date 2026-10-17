import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';

export interface StoryboardReferenceIdentity {
  pictureNumber: number;
  characterId: string;
  name: string;
}

interface NamedCharacter { id: string; name: string }
interface SourceFragment { start: number; end: number }

/** Only a specifically selected frozen instant is attachment-space evidence.
 * Full conversion source/H3 can contain later actions and is never a fallback. */
export const currentStoryboardFrameSpatialSource = (request: {
  currentFrameSpatialSource?: string;
  imageFrameDescription?: string;
}): string => request.currentFrameSpatialSource || request.imageFrameDescription || '';

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const spatialCue = /画面|屏幕|镜头[内外]|画外|站位|站在|站于|位于|处于|身处|左侧|右侧|左边|右边|中间|中央|前方|后方|门内|门外|面向|朝向|相距|距离|之间|并肩|\b(?:screen[ -](?:left|right)|frame[ -](?:left|right)|stands?|standing|located|positioned|faces?|facing|between|beside|behind|in front of|off[ -]?screen)\b/iu;

/** Read exact visible source spans only. Quoted speech and <d>/<sound>
 * payloads cannot become evidence for where a referenced person stands. */
const visibleSourceFragments = (source: string): SourceFragment[] => {
  const visible = maskVideoPictureReferenceLiterals(source);
  const fragments: SourceFragment[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (visible[index] === source[index]) continue;
    if (start < index) fragments.push({ start, end: index });
    while (index < source.length && visible[index] !== source[index]) index += 1;
    start = index;
  }
  if (start < source.length) fragments.push({ start, end: source.length });
  return fragments;
};

const containsUniqueName = (text: string, name: string, characters: readonly NamedCharacter[]): boolean => {
  if (!name || characters.filter((entry) => entry.name === name).length !== 1) return false;
  const pattern = new RegExp(escaped(name), 'gu');
  for (const match of text.matchAll(pattern)) {
    const at = match.index!; const end = at + name.length;
    if (/^[A-Za-z0-9_]/u.test(name) && /[\p{L}\p{N}_]/u.test(text[at - 1] || '')
      || /[A-Za-z0-9_]$/u.test(name) && /[\p{L}\p{N}_]/u.test(text[end] || '')) continue;
    const belongsToLongerName = characters.some((entry) => entry.name.length > name.length
      && [...entry.name.matchAll(pattern)].some((part) => text.startsWith(entry.name, at - part.index!) && at >= part.index!));
    if (!belongsToLongerName) return true;
  }
  return false;
};

/** Attachment identity is keyed by the caller's final pixel order. Source
 * space is quoted verbatim, never calculated from upload order, body sides,
 * another portrait, or converter-written staging. Undefined evidence still
 * emits the proven attachment identities without assigning a frame position. */
export const buildStoryboardReferenceIdentityLines = (
  identities: readonly StoryboardReferenceIdentity[],
  currentFrameSpatialSource: string | undefined,
  characters: readonly NamedCharacter[],
): string[] => {
  if (!identities.length) return [];
  const sourcePrompt = currentFrameSpatialSource || '';
  const sourceSentences = visibleSourceFragments(sourcePrompt).flatMap((fragment) => {
    const text = sourcePrompt.slice(fragment.start, fragment.end);
    return [...text.matchAll(/[^\r\n。！？!?]+[。！？!?]?/gu)].map((match) => match[0].trim()).filter(Boolean);
  });
  const lines = ['逐图人物身份与当前原稿空间对应：'];
  for (const identity of identities) {
    lines.push(`图片 ${identity.pictureNumber} → 角色 ID ${JSON.stringify(identity.characterId)} → 中文原名 ${JSON.stringify(identity.name)}；仅沿用此人物参考中该人物自己的脸部、发型与服饰特征。`);
    const evidence = [...new Set(sourceSentences.filter((sentence) => spatialCue.test(sentence)
      && containsUniqueName(sentence, identity.name, characters)))];
    for (const sentence of evidence) lines.push(`图片 ${identity.pictureNumber} 对应人物的原稿空间原句：${sentence}`);
  }
  lines.push('各人物只使用各自对应参考的身份外观，不互换脸部、发型或服装；当前衣着状态、动作、持物和取景沿用正文。');
  lines.push('以上原句只记录当前来源中的空间关系，不新增时刻或镜头，不因参考人物存在而补入画外身体；上传顺序与人物自身左、右均不换算为屏幕站位。');
  return lines;
};

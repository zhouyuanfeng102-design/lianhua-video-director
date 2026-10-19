import type { Project, ReferenceRole } from './types';
import type { VideoGenerationDraft } from './videoGenerationTypes';
import type { VideoSeedanceReferencePlan } from './videoSeedanceReferencePlan';
import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';
import { sourceContentHash } from './sourceContentHash';
import { resolveSeedanceCharacterParticipation } from './characterParticipation';
import { characterVariantDisplayName } from './characterVariants';
import { videoMiddleFrameOrdinal, videoReferenceSlotIndex } from './videoReferenceSlots';
import { videoReferenceCharacterBindingWarning, videoReferenceCharacterOwners, type VideoCharacterReferenceState } from './videoReferenceCharacters';
import { readSeedanceSections } from './seedanceSections';
import { cleanSeedanceReferenceClaims } from './seedanceReferenceClaims';

interface SeedanceSourceReference {
  token: string;
  assetId: string;
  responsibility?: string;
  characterIds?: string[];
}

interface SeedanceCurrentReference {
  token: string;
  assetId: string;
  role: ReferenceRole;
  characterIds: string[];
  slotIndex: number;
}

export interface VideoSeedanceReferenceBinding {
  version: 1 | 2;
  projectId: string;
  basePrompt: string;
  renderedPrompt: string;
  /** The original mapping never changes when the request's images change. */
  references: SeedanceSourceReference[];
  sourceLanguage?: 'zh' | 'en';
  basePromptFingerprint?: string;
  referenceSection?: { start: number; end: number; fingerprint: string };
  currentReferences?: SeedanceCurrentReference[];
  characterStates?: VideoCharacterReferenceState[];
  imageTokenStyle?: 'english' | 'chinese';
}

interface TextEdit { start: number; end: number; text: string }
const unique = <T,>(values: readonly T[]): T[] => [...new Set(values)];
const tokenPattern = (): RegExp => /@(?:Image\s+\d+|(?:图片|图)\s*\d+|Video\s+\d+|Audio\s+\d+|Clay Render\s+\d+|(?:视频|音频|粘土渲染)\s*\d+)/gu;
const imageNumber = (token: string): number | undefined => {
  const match = token.match(/^@(?:Image\s+|(?:图片|图)\s*)(\d+)$/u);
  const number = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};
const videoNumber = (token: string): number | undefined => {
  const match = token.match(/^@(?:Video\s+|视频\s*)(\d+)$/u);
  return match ? Number(match[1]) : undefined;
};
const audioNumber = (token: string): number | undefined => {
  const match = token.match(/^@(?:Audio\s+|音频\s*)(\d+)$/u);
  return match ? Number(match[1]) : undefined;
};
const tokenKey = (token: string): string => imageNumber(token) ? `image:${imageNumber(token)}`
  : videoNumber(token) ? `video:${videoNumber(token)}` : audioNumber(token) ? `audio:${audioNumber(token)}` : token;
const imageToken = (number: number, style?: 'english' | 'chinese'): string => style === 'chinese' ? `@图片${number}` : `@Image ${number}`;
/** Labels and saved description fields are data, never another media ordinal
 * or a chapter boundary. Preserve their words as one literal display line. */
const referenceText = (value: string): string => value.replace(/[\r\n\t\u0000-\u001f\u007f]+/gu, ' ')
  .trim().replace(tokenPattern(), (token) => token.replace('@', '＠'));
const referenceLabel = (value: string): string => JSON.stringify(referenceText(value));
const applyEdits = (prompt: string, edits: TextEdit[]): string => {
  let result = prompt;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
};

const roleResponsibility = (role: ReferenceRole, language: 'zh' | 'en', middleFrameOrdinal?: number): string => {
  if (role === 'middle-frame') return language === 'en'
    ? `Intermediate frame ${middleFrameOrdinal || 1}: action progression and continuity reference`
    : `中间帧 ${middleFrameOrdinal || 1}：过程画面与连续性参考`;
  const chinese: Partial<Record<ReferenceRole, string>> = {
    character: '人物身份与外观参考', subject: '主体身份与外观参考', scene: '场景空间与环境参考',
    'first-frame': '开场画面与连续性参考', 'last-frame': '结束画面与连续性参考', prop: '道具外观参考',
    style: '视觉风格参考', composition: '构图参考', camera: '摄影参考', motion: '已有动作的视觉参考',
  };
  const english: Partial<Record<ReferenceRole, string>> = {
    character: 'Character identity and appearance reference', subject: 'Subject identity and appearance reference', scene: 'Scene layout and environment reference',
    'first-frame': 'Opening frame and continuity reference', 'last-frame': 'Ending frame and continuity reference', prop: 'Prop appearance reference',
    style: 'Visual style reference', composition: 'Composition reference', camera: 'Cinematography reference', motion: 'Visual reference for the existing action',
  };
  return language === 'en' ? english[role] || 'Visual reference' : chinese[role] || '视觉参考';
};

/** Request-only serialization. Every render starts at the same saved text;
 * authored dialogue, shot timing and the other five sections remain intact. */
export const prepareVideoSeedanceReferenceDraft = (
  project: Project, draft: VideoGenerationDraft, plan: VideoSeedanceReferencePlan, videoNumbers?: readonly number[],
): { draft: VideoGenerationDraft; warnings: string[]; characterStates: VideoCharacterReferenceState[] } => {
  if (draft.reuseTaskId) return { draft, warnings: draft.h3ReferenceWarnings || [], characterStates: draft.seedanceReferenceBinding?.characterStates || [] };
  const saved = draft.seedanceReferenceBinding;
  const boards = project.storyboards.filter((item) => item.id === draft.source?.storyboardId);
  const board = boards.length === 1 ? boards[0] : undefined;
  const sourceLanguage = draft.source?.language === 'en' || draft.source?.language === undefined
    && draft.prompt === board?.seedance25Output?.promptEn && draft.prompt !== board?.seedance25Output?.promptZh ? 'en' : 'zh';
  const sourcePrompt = sourceLanguage === 'en' ? board?.seedance25Output?.promptEn : board?.seedance25Output?.promptZh;
  const sourceBinding: VideoSeedanceReferenceBinding | undefined = saved && [1, 2].includes(saved.version)
    && saved.projectId === project.id && typeof saved.basePrompt === 'string' && typeof saved.renderedPrompt === 'string'
    && Array.isArray(saved.references) && (draft.prompt === saved.basePrompt || draft.prompt === saved.renderedPrompt)
    && (!saved.basePromptFingerprint || saved.basePromptFingerprint === sourceContentHash(saved.basePrompt)) ? saved
    : !saved && sourcePrompt === draft.prompt ? {
      version: 1, projectId: project.id, basePrompt: draft.prompt, renderedPrompt: draft.prompt, sourceLanguage,
      references: (board?.seedance25Output?.referenceManifest || []).flatMap((entry) => typeof entry.token === 'string' && typeof entry.id === 'string'
        ? [{ token: entry.token, assetId: entry.id, ...(typeof entry.responsibility === 'string' ? { responsibility: entry.responsibility } : {}) }] : []),
    } : undefined;
  const binding = sourceBinding;
  const basePrompt = binding?.basePrompt || draft.prompt;
  const sections = binding ? readSeedanceSections(basePrompt) : undefined;
  const section = sections?.sections.references;
  const language = binding?.sourceLanguage || sections?.language || sourceLanguage;
  const warnings: string[] = [];
  const masked = maskVideoPictureReferenceLiterals(basePrompt);
  const matches = [...masked.matchAll(tokenPattern())];
  const sources = new Map<string, SeedanceSourceReference[]>();
  for (const reference of binding?.references || []) {
    if (!reference || typeof reference.token !== 'string' || typeof reference.assetId !== 'string') continue;
    const key = tokenKey(reference.token);
    sources.set(key, [...(sources.get(key) || []), reference]);
  }
  const unknownTokens = unique(matches.filter((match) => imageNumber(match[0]) && unique((sources.get(tokenKey(match[0])) || []).map((entry) => entry.assetId)).length !== 1).map((match) => match[0]));
  if (!binding && (draft.references.length || matches.length)) warnings.push('本次 Seedance 正文已手动修改或缺少可证明的原稿来源，已保留正文；素材关联待确认。');
  if (binding && !section && draft.references.length) warnings.push('Seedance 六个章节无法唯一定位，已保留参考说明；图片已选入，人物关联待确认。');
  if (unknownTokens.length) warnings.push(`${unknownTokens.join('、')} 缺少可证明的原素材对应，已保留原编号，未附加冲突图片引用；请核对当前参考说明。`);
  if (draft.references.length && !plan.numbers) warnings.push(plan.warning || '当前接口未明确 Seedance 图片引用顺序，已保留正文；人物关联待确认。');
  const canAssociate = Boolean(binding && section && !unknownTokens.length && plan.numbers);
  const currentReferences: SeedanceCurrentReference[] = [];
  const lines: string[] = [];
  const selectedCharacters = new Map<string, { name: string; slots: number[]; associated: boolean }>();
  const fallbackSelected = new Map<string, number[]>();
  draft.references.forEach((reference, index) => {
    const slotIndex = videoReferenceSlotIndex(reference, index);
    const number = plan.numbers?.[index];
    const knownNumber = Number.isSafeInteger(number) && (number || 0) > 0 ? number : undefined;
    const assets = project.assets.filter((asset) => asset.id === reference.assetId && !asset.missing);
    const asset = assets.length === 1 ? assets[0] : undefined;
    const identityRole = ['character', 'subject'].includes(reference.role) || reference.characterIds !== undefined;
    const bindingWarning = videoReferenceCharacterBindingWarning(reference);
    if (bindingWarning) warnings.push(bindingWarning);
    const owners = asset && identityRole ? videoReferenceCharacterOwners(project, asset, reference) : [];
    if (Array.isArray(reference.characterIds) && reference.characterIds.length && owners.length !== unique(reference.characterIds).length) warnings.push(`图片槽 ${slotIndex + 1} 的部分人物对应已失效，未借用其它人物或形态。`);
    if (identityRole && !owners.length && reference.characterIds === undefined) warnings.push(`图片槽 ${slotIndex + 1} 未明确对应人物，图片已选入，人物关联待确认。`);
    // Empty overrides retain an unselected hint, never asset-owned identity.
    if (asset && identityRole && reference.characterIds !== undefined && !owners.length) {
      for (const owner of videoReferenceCharacterOwners(project, asset)) fallbackSelected.set(owner.id, []);
    }
    for (const owner of owners) {
      const prior = selectedCharacters.get(owner.id);
      selectedCharacters.set(owner.id, { name: characterVariantDisplayName(owner) || owner.name,
        slots: unique([...(prior?.slots || []), knownNumber || slotIndex + 1]), associated: (prior?.associated ?? true) && canAssociate && Boolean(knownNumber) });
    }
    if (!knownNumber) {
      if (plan.numbers) warnings.push(`图片槽 ${slotIndex + 1} 缺少有效 Seedance 图片编号，未猜测对应。`);
      return;
    }
    const token = imageToken(knownNumber, plan.imageTokenStyle);
    currentReferences.push({ token, assetId: reference.assetId, role: reference.role, characterIds: owners.map((owner) => owner.id), slotIndex });
    const boundary = ['first-frame', 'last-frame'].includes(reference.role);
    const name = asset?.name || (boundary ? language === 'en' ? 'Continuity reference frame' : '上段衔接参考帧'
      : language === 'en' ? `Selected image ${knownNumber}` : `本次图片 ${knownNumber}`);
    const sourceResponsibility = (binding?.references || []).find((entry) => entry.assetId === reference.assetId)?.responsibility;
    const usage = roleResponsibility(reference.role, language,
      reference.role === 'middle-frame' ? videoMiddleFrameOrdinal(draft.references, slotIndex, draft.referenceSlotRoles) : undefined);
    const responsibility = sourceResponsibility?.trim()
      ? language === 'en' ? `${usage}; Saved reference details: ${referenceText(sourceResponsibility)}`
        : `${usage}；原参考说明：${referenceText(sourceResponsibility)}`
      : usage;
    const names = owners.map((owner) => referenceLabel(characterVariantDisplayName(owner) || owner.name));
    const identity = names.length ? language === 'en' ? `; Characters: ${names.join(', ')}` : `；对应人物：${names.join('、')}` : '';
    lines.push(language === 'en' ? `${token}: ${referenceLabel(name)}; ${responsibility}${identity}.` : `${token}：${referenceLabel(name)}；${responsibility}${identity}。`);
  });
  const edits: TextEdit[] = [];
  if (binding && !unknownTokens.length) for (const match of matches) {
    if (!imageNumber(match[0])) {
      const video = videoNumber(match[0]);
      const audio = audioNumber(match[0]);
      const selected = video ? draft.videoReferences : audio ? draft.audioReferences : undefined;
      const source = sources.get(tokenKey(match[0]));
      const original = source?.length === 1 ? source[0] : undefined;
      const matching = original ? selected?.filter((entry) => entry.assetId === original.assetId)
        : selected?.filter((entry) => entry.slotIndex + 1 === (video || audio));
      if (matching?.length) {
        if (original) edits.push({ start: match.index!, end: match.index! + match[0].length,
          text: unique(matching.map((entry) => `@${video ? 'Video' : 'Audio'} ${video
            ? videoNumbers?.[(draft.videoReferences || []).indexOf(entry)] ?? entry.slotIndex + 1 : entry.slotIndex + 1}`)).join(language === 'en' ? ', ' : '、') });
      } else warnings.push(`${match[0]}：未对应本次已选的${video ? '视频' : audio ? '音频' : '该类型'}参考输入，已保留原说明；请核对实际素材。`);
      continue;
    }
    const original = sources.get(tokenKey(match[0]))![0];
    const selected = currentReferences.filter((reference) => reference.assetId === original.assetId);
    if (selected.length) edits.push({ start: match.index!, end: match.index! + match[0].length, text: unique(selected.map((reference) => reference.token)).join(language === 'en' ? ', ' : '、') });
    else if (!draft.references.some((reference) => reference.assetId === original.assetId)) {
      warnings.push(`${match[0]} 原参考素材（${original.assetId}）未选中，已移除旧编号以免指向另一张图片；主体和动作正文保留。`);
      edits.push({ start: match.index!, end: match.index! + match[0].length, text: language === 'en' ? 'unbound reference material' : '未绑定参考素材' });
    }
  }
  const noSourceAndNoMedia = !binding?.references.length && !draft.references.length
    && !draft.audioReferences?.length && !draft.videoReferences?.length;
  if (canAssociate && section && !noSourceAndNoMedia) {
    const body = basePrompt.slice(section.start, section.end);
    const bodyEdits = edits.filter((edit) => edit.start >= section.start && edit.end <= section.end);
    const newline = basePrompt.includes('\r\n') ? '\r\n' : '\n';
    const selectedBody = lines.length ? [ ...lines,
      language === 'en' ? 'Use these images only for their stated visual purposes. Keep the existing timeline, appearances, actions and dialogue.'
        : '以上图片仅按所述用途参考，出场、动作、衣着变化与对白沿用原时间轴。',
    ].join(newline) : language === 'en' ? 'No images are selected for this request.' : '本次未选择图片参考素材。';
    // A reference section can mix outdated input declarations with story facts.
    // Remove only proven conflicting declarations from this request copy; the
    // original source, quoted text and unrelated story facts remain intact.
    // Existing image-entry labels are replaced by the single current image list.
    // Keep every word after their colon as unnumbered authored prose: a reference
    // entry may also contain scene or action facts absent from the manifest.
    const declarationEdits = [...masked.slice(section.start, section.end).matchAll(/(^|[\r\n。;；])[ \t]*(@(?:Image\s+\d+|(?:图片|图)\s*\d+))[ \t]*[:：][ \t]*/gmu)]
      .map((match): TextEdit => ({ start: match.index! + match[0].indexOf(match[2]), end: match.index! + match[0].length, text: '' }));
    const preservationEdits = bodyEdits.map((edit) => ({ ...edit, start: edit.start - section.start, end: edit.end - section.start }))
      .filter((edit) => !declarationEdits.some((declaration) => edit.start >= declaration.start && edit.end <= declaration.end));
    const remappedBody = applyEdits(body, [...preservationEdits, ...declarationEdits]);
    const currentBody = cleanSeedanceReferenceClaims(remappedBody, {
      hasImages: draft.references.length > 0, hasAudio: Boolean(draft.audioReferences?.length), hasVideo: Boolean(draft.videoReferences?.length),
    }).text;
    const replacement = [
        section.inline ? '' : newline,
        ...(currentBody.trim() ? [currentBody.trim(), newline, newline] : []),
        language === 'en' ? 'Reference images for this request:' : '本次提交的参考图片：',
        newline, selectedBody, newline, newline,
      ].join('');
    for (let index = edits.length - 1; index >= 0; index -= 1) if (edits[index].start >= section.start && edits[index].end <= section.end) edits.splice(index, 1);
    edits.push({ start: section.start, end: section.end, text: replacement });
  }
  const renderedPrompt = noSourceAndNoMedia ? basePrompt : applyEdits(basePrompt, edits);
  const participation = resolveSeedanceCharacterParticipation(basePrompt, project.characters, board?.seedance25Output);
  const relevant = unique([
    ...participation.characters.filter((entry) => entry.presence !== 'mentioned').map((entry) => entry.characterId),
    ...(binding?.characterStates || []).map((entry) => entry.characterId),
    ...(binding?.currentReferences || []).flatMap((entry) => entry.characterIds),
    ...selectedCharacters.keys(), ...fallbackSelected.keys(),
  ]);
  const characterStates: VideoCharacterReferenceState[] = relevant.flatMap((characterId): VideoCharacterReferenceState[] => {
    const character = project.characters.find((entry) => entry.id === characterId);
    const oldState = binding?.characterStates?.find((entry) => entry.characterId === characterId);
    const selected = selectedCharacters.get(characterId);
    const name = selected?.name || (character ? characterVariantDisplayName(character) || character.name : oldState?.name);
    if (!name) return [];
    return [{ characterId, name, status: selected ? selected.associated ? 'bound' : 'pending' : 'unselected', slots: selected?.slots || [],
      ...(selected && !selected.associated ? { reason: !binding ? '原稿来源或手动编辑未确认，图片已选入，人物关联待确认。'
        : plan.warning || '正文参考章节或本次图片编号未确认，人物关联待确认。' } : {}) }];
  });
  const uniqueWarnings = unique(warnings);
  const outputBinding: VideoSeedanceReferenceBinding | undefined = binding ? {
    ...binding, version: 2, renderedPrompt, sourceLanguage: language, basePromptFingerprint: sourceContentHash(basePrompt),
    ...(section ? { referenceSection: { start: section.start, end: section.end, fingerprint: sourceContentHash(basePrompt.slice(section.start, section.end)) } } : {}),
    currentReferences, characterStates, imageTokenStyle: plan.imageTokenStyle,
  } : undefined;
  return { draft: { ...draft, prompt: renderedPrompt, h3ReferenceBinding: undefined,
    source: draft.source && { ...draft.source, promptFingerprint: sourceContentHash(renderedPrompt) },
    seedanceReferenceBinding: outputBinding, h3ReferenceWarnings: uniqueWarnings }, warnings: uniqueWarnings, characterStates };
};

import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';

export interface SeedanceReferenceMediaState {
  hasImages: boolean;
  hasAudio: boolean;
}

export interface SeedanceReferenceClaim {
  start: number;
  end: number;
  text: string;
  kind: 'images' | 'audio' | 'media' | 'text-only';
}

const zhMedia = '(?:图片|图像|图像像素|照片|视频|音频|声音|音色|声线|参考图片|参考图像|参考照片|参考图|参考音频|Clay\\s+Render)';
const zhMediaList = `${zhMedia}(?:[ \\t]*(?:、|，|,|或|与|和|及|以及)[ \\t]*${zhMedia})*`;
const enMedia = '(?:images?|pictures?|photos?|videos?|audios?|audio\\s+clips?|sound|voices?|clay\\s+renders?)';
const enMediaList = `${enMedia}(?:[ \\t]*(?:,[ \\t]*(?:(?:and|or|nor)[ \\t]+)?|(?:and|or|nor)[ \\t]+)${enMedia})*`;
const zhPrefix = '(?:(?:本次请求|当前请求|本次|此次|当前|本段)[ \\t]*)?(?:也|并且|并)?';
const enPrefix = '(?:(?:for this request|currently|this request)[ \\t]*:?[ \\t]*)?(?:and[ \\t]+)?';
const patterns: Array<{ source: string; kind?: SeedanceReferenceClaim['kind'] }> = [
  { source: `${zhPrefix}(?:未|没有|未曾)(?:实际)?(?:提供|上传|选择|选用|使用|配置|绑定|映射)(?:任何|外部|实际|可用){0,3}(?:的)?[ \\t]*(?:${zhMediaList})[ \\t]*(?:参考素材|参考材料|媒体素材|参考|素材|材料)?` },
  { source: `${zhPrefix}(?:没有|不存在|未有|无)(?:任何|外部|实际|可用){0,3}(?:实际映射的|映射的|已提供的|已上传的)?[ \\t]*(?:${zhMediaList})[ \\t]*(?:参考素材|参考材料|媒体素材|参考|素材|材料)?` },
  { source: `${zhPrefix}(?:不|不要|不得|无需|不可)(?:再)?(?:使用|采用|参考|依赖)(?:任何|外部|已提供的){0,3}[ \\t]*(?:${zhMediaList})[ \\t]*(?:参考素材|参考材料|媒体素材|参考|素材|材料)?` },
  { source: `${zhPrefix}(?:未|没有|无)(?:提供|上传|选择|选用|使用|配置|绑定|映射)?(?:任何|外部|实际){0,3}参考(?:素材|材料)|${zhPrefix}(?:不|不要|不得|无需|不可)(?:使用|采用|依赖)(?:任何|外部|实际){0,3}参考(?:素材|材料)`, kind: 'media' },
  { source: `${zhPrefix}referenceManifest[ \\t]*(?:为|是)?空(?:的)?`, kind: 'media' },
  { source: `${zhPrefix}不依据未提供的(?:图片|图像)(?:像素)?补充画面细节`, kind: 'images' },
  { source: `${zhPrefix}(?:(?:全部|所有)(?:人物|角色|主体|道具|场景|画面)(?:[、与和及](?:人物|角色|主体|道具|场景|画面))*(?:均|都)?|(?:一切|全部))(?:仅|只)?(?:以|依据|依照)文字(?:设定|描述|提示词)?(?:为(?:唯一)?执行依据|执行|生成)?`, kind: 'text-only' },
  { source: `${zhPrefix}(?:仅|只)(?:以|依据|依照)文字(?:设定|描述|提示词)?(?:为(?:唯一)?执行依据|执行|生成)?`, kind: 'text-only' },
  { source: `${enPrefix}no[ \\t]+(?:external[ \\t]+|actual[ \\t]+|mapped[ \\t]+)?${enMediaList}(?:[ \\t]+reference[ \\t]+(?:materials?|assets?))?(?:[ \\t]+(?:is|are|was|were|has been|have been)[ \\t]+(?:supplied|provided|uploaded|selected|used|mapped|available))?(?:[ \\t]+(?:for|in)[ \\t]+this[ \\t]+request)?` },
  { source: `${enPrefix}(?:do not|don't|must not|never)[ \\t]+(?:use|rely on)[ \\t]+(?:any[ \\t]+|external[ \\t]+)?${enMediaList}(?:[ \\t]+reference[ \\t]+(?:materials?|assets?))?` },
  { source: `${enPrefix}no[ \\t]+(?:sound|voices?)[ \\t]+(?:references?|samples?)(?:[ \\t]+(?:is|are|was|were|has been|have been)[ \\t]+(?:supplied|provided|uploaded|mapped))?`, kind: 'audio' },
  { source: `${enPrefix}no[ \\t]+(?:external[ \\t]+)?reference[ \\t]+(?:materials?|assets?)(?:[ \\t]+(?:is|are|was|were|has been|have been)[ \\t]+(?:supplied|provided|uploaded|selected|used|mapped|available))?|${enPrefix}(?:do not|don't|must not|never)[ \\t]+(?:use|rely on)[ \\t]+(?:any[ \\t]+|external[ \\t]+)?reference[ \\t]+(?:materials?|assets?)`, kind: 'media' },
  { source: `${enPrefix}(?:use|follow|rely on)[ \\t]+(?:only[ \\t]+(?:the[ \\t]+)?text(?:ual)?[ \\t]+(?:descriptions?|settings?|prompt)|(?:the[ \\t]+)?text(?:ual)?[ \\t]+(?:descriptions?|settings?|prompt)[ \\t]+only)`, kind: 'text-only' },
  { source: `${enPrefix}all[ \\t]+(?:characters?|subjects?|props?|settings?|scenes?)(?:[ \\t]*(?:,[ \\t]*(?:and[ \\t]+)?|and[ \\t]+)(?:characters?|subjects?|props?|settings?|scenes?))*[ \\t]+(?:are[ \\t]+based[ \\t]+(?:only|solely)[ \\t]+on|(?:use|follow|rely on)[ \\t]+only)[ \\t]+(?:the[ \\t]+)?text(?:ual)?[ \\t]+(?:descriptions?|settings?|prompt)`, kind: 'text-only' },
];

const claimKind = (text: string): SeedanceReferenceClaim['kind'] => {
  const images = /图片|图像|照片|参考图|\b(?:images?|pictures?|photos?)\b/iu.test(text);
  const audio = /音频|声音|音色|声线|\b(?:audio|audios|sound|voices?)\b/iu.test(text);
  return images && audio ? 'media' : images ? 'images' : audio ? 'audio' : 'media';
};

/** Find only complete, explicit availability/use clauses. A narrative clause
 * containing similar words, quoted speech or screen text is not a media claim.
 * The same narrow recognizer powers cleanup and final request diagnostics. */
export const findSeedanceReferenceConflicts = (
  text: string, state: SeedanceReferenceMediaState,
): SeedanceReferenceClaim[] => {
  if (!state.hasImages && !state.hasAudio) return [];
  const masked = maskVideoPictureReferenceLiterals(text);
  const claims: SeedanceReferenceClaim[] = [];
  for (const pattern of patterns) {
    const regex = new RegExp(`(^|[，,。.!?！？；;\\r\\n])[ \\t]*((?:[-*][ \\t]+)?(?:${pattern.source}))[ \\t]*(?=$|[，,。.!?！？；;\\r\\n])`, 'gimu');
    for (const match of masked.matchAll(regex)) {
      const start = match.index! + match[0].indexOf(match[2], match[1].length);
      const end = start + match[2].length;
      // Masked quotations must never be swept into an adjacent recognized clause.
      if (text.slice(start, end) !== masked.slice(start, end)) continue;
      // Silence and absent voices can be authored scene facts. These words are
      // media declarations only with explicit reference/input-supply context.
      if (/声音|音色|声线|\b(?:sound|voices?)\b/iu.test(match[2])
        && !/参考|素材|材料|样本|提供|上传|配置|绑定|映射|\b(?:references?|samples?|materials?|assets?|supplied|provided|uploaded|mapped)\b/iu.test(match[2])) continue;
      const kind = pattern.kind || claimKind(match[2]);
      if (kind === 'images' && !state.hasImages || kind === 'audio' && !state.hasAudio) continue;
      // A video-only absence is accurate when this application sends pictures/audio.
      if (!pattern.kind && /视频|\bvideos?\b/iu.test(match[2]) && !/图片|图像|照片|参考图|音频|声音|音色|声线|\b(?:images?|pictures?|photos?|audio|audios|sound|voices?)\b/iu.test(match[2])) continue;
      if (!claims.some((claim) => claim.start < end && claim.end > start)) claims.push({ start, end, text: text.slice(start, end), kind });
    }
  }
  return claims.sort((left, right) => left.start - right.start);
};

/** Remove obsolete input declarations from a request copy, preserving all
 * unrelated prose. This never modifies the saved source or invents story facts. */
export const cleanSeedanceReferenceClaims = (
  text: string, state: SeedanceReferenceMediaState,
): { text: string; removedClaims: SeedanceReferenceClaim[] } => {
  const removedClaims = findSeedanceReferenceConflicts(text, state);
  if (!removedClaims.length) return { text, removedClaims };
  let result = text;
  for (const claim of [...removedClaims].reverse()) {
    let start = claim.start;
    let end = claim.end;
    while (/[ \t]/u.test(result[end] || '') && end < result.length) end += 1;
    let before = start;
    while (before > 0 && /[ \t]/u.test(result[before - 1])) before -= 1;
    if (/[，,；;]/u.test(result[before - 1] || '') && (end === result.length || /[。.!?！？\r\n]/u.test(result[end] || ''))) {
      // A final obsolete clause must not leave a dangling comma after a fact.
      start = before - 1;
    } else if (/[，,。.!?！？；;]/u.test(result[end] || '')) end += 1;
    result = result.slice(0, start) + result.slice(end);
  }
  return { text: result.trim(), removedClaims };
};

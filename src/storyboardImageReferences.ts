import type { Character, Location, Prop, ReferenceAsset } from './types';

export interface StoryboardImageReferenceContext {
  characters?: readonly Character[];
  locations?: readonly Location[];
  props?: readonly Prop[];
}

const REFERENCE_METADATA_START = '【莲华程序参考用途 v1 开始】';
const REFERENCE_METADATA_END = '【莲华程序参考用途 v1 结束】';
const REFERENCE_METADATA_HEADING = '本次实际上传图片（严格按此顺序）：';

/** Only a complete, trailing, versioned application block is ours. A mention
 * in authored prose, an incomplete block, or legacy unmarked text stays intact.
 * Natural-language sanitization may replace its line breaks with commas. */
const referenceMetadataStart = (prompt: string): number => {
  const end = prompt.trimEnd();
  if (!end.endsWith(REFERENCE_METADATA_END)) return -1;
  let start = end.lastIndexOf(REFERENCE_METADATA_START);
  while (start >= 0) {
    const afterStart = end.slice(start + REFERENCE_METADATA_START.length).replace(/^[\r\n，]+/u, '');
    if (afterStart.startsWith(REFERENCE_METADATA_HEADING)) return start;
    if (start === 0) return -1;
    start = end.lastIndexOf(REFERENCE_METADATA_START, start - 1);
  }
  return -1;
};

export const hasStoryboardImageReferenceMetadata = (prompt: string): boolean => referenceMetadataStart(prompt) >= 0;

export const stripStoryboardImageReferenceMetadata = (prompt: string): string => {
  let body = prompt;
  for (let start = referenceMetadataStart(body); start >= 0; start = referenceMetadataStart(body)) {
    const prefix = body.slice(0, start);
    // Remove exactly the application separator, not authored body whitespace.
    body = /(?:\r?\n){2}$/u.test(prefix) ? prefix.replace(/(?:\r?\n){2}$/u, '')
      : prefix.endsWith('，') ? prefix.slice(0, -1) : prefix;
  }
  return body;
};

/** User binding wins over immutable generation provenance. A cleared/stale
 * binding stays unbound; image names and old prompts are never ownership proof. */
export const storyboardReferenceCharacters = (
  asset: ReferenceAsset,
  context: StoryboardImageReferenceContext = {},
): Character[] => {
  const characters = context.characters || [];
  const exact = (id: string): Character[] => {
    const matches = characters.filter((character) => character.id === id && !character.dossier?.archivedIntoCharacterId);
    return matches.length === 1 ? matches : [];
  };
  if (asset.characterReferenceId !== undefined) {
    return typeof asset.characterReferenceId === 'string' ? exact(asset.characterReferenceId) : [];
  }
  if (asset.sourceEntityKind || asset.sourceEntityId) {
    if (asset.sourceEntityKind && asset.sourceEntityKind !== 'character') return [];
    const owners = exact(asset.sourceEntityId || '');
    return asset.sourceEntityKind === 'character' ? owners : owners.filter((character) => character.assetIds.includes(asset.id));
  }
  return characters.filter((character) => !character.dossier?.archivedIntoCharacterId && character.assetIds.includes(asset.id));
};

export const storyboardImageReferenceRole = (
  asset: ReferenceAsset,
  context: StoryboardImageReferenceContext = {},
): string => {
  const characters = storyboardReferenceCharacters(asset, context);
  if (characters.length) return `人物 ${characters.map((character) => JSON.stringify(character.name)).join('、')} 的身份、外貌与服装设计参考`;
  if (asset.characterReferenceId !== undefined) return '未绑定当前人物的普通画面参考，由本镜画面决定用途';
  const role = asset.referenceRole || asset.role;
  if (role === 'character' || asset.sourceEntityKind === 'character') return '人物身份与外貌参考，具体对应以本镜描述为准';
  if (role === 'scene' || asset.sourceEntityKind === 'location') {
    const location = context.locations?.find((item) => item.id === asset.sourceEntityId || item.assetIds.includes(asset.id));
    return `场景${location ? ` ${JSON.stringify(location.name)}` : ''}的环境外观参考`;
  }
  if (role === 'prop' || asset.sourceEntityKind === 'prop') {
    const prop = context.props?.find((item) => item.id === asset.sourceEntityId || item.assetIds.includes(asset.id));
    return `道具${prop ? ` ${JSON.stringify(prop.name)}` : ''}的外形参考`;
  }
  return '普通画面参考，由本镜画面决定用途';
};

/** This is submission metadata, not another AI review or a rewrite of the
 * authored image prompt. Caller supplies the assets in actual upload order. */
export const buildStoryboardImagePromptWithReferences = (
  body: string,
  assetsInActualUploadOrder: readonly ReferenceAsset[],
  context: StoryboardImageReferenceContext = {},
): string => {
  const authoredBody = stripStoryboardImageReferenceMetadata(body);
  if (!assetsInActualUploadOrder.length) return authoredBody;
  return [
    authoredBody,
    '',
    REFERENCE_METADATA_START,
    REFERENCE_METADATA_HEADING,
    ...assetsInActualUploadOrder.map((asset, index) => `${index + 1}. ${JSON.stringify(asset.name)} — ${storyboardImageReferenceRole(asset, context)}`),
    '人物参考只保持对应身份、外貌和服装设计；本镜当前衣着状态、姿态、身体朝向、视线对象、机位、景别和裁切以以上画面描述为准。不要复制参考图中朝向观众的头部、正脸展示、临时持物、动作或背景；允许侧脸、背面和局部特写，未入画的脸与身体不必补全。',
    '场景和道具参考只保持相关外观，不带入历史动作与人物站位。上传顺序不代表人物左右站位；原视频 Subject/Picture 编号不是本次图片编号。',
    REFERENCE_METADATA_END,
  ].join('\n');
};

/** Ordinary retries keep old unmarked prompts byte-for-byte. Only our new
 * explicit metadata is refreshed after the caller resolves real image slots. */
export const refreshStoryboardImageReferenceMetadata = (
  prompt: string,
  assetsInActualUploadOrder: readonly ReferenceAsset[],
  context: StoryboardImageReferenceContext = {},
): string => hasStoryboardImageReferenceMetadata(prompt)
  ? buildStoryboardImagePromptWithReferences(prompt, assetsInActualUploadOrder, context)
  : prompt;

/** Boundary frames inherit the camera at that moment, not the widest view of
 * the shot. Interpret the original motion semantically in the existing call. */
export const storyboardImageFramingInstruction = (
  purpose: 'first-frame' | 'last-frame' | 'storyboard-shot',
): string => [
  purpose === 'first-frame'
    ? '首帧取景：按第一镜起始时刻的摄影机位置、景别、视轴和裁切生成；随后的推近、下摇、转向或镜尾特写还未发生。'
    : purpose === 'last-frame'
      ? '尾帧取景：按最后一镜结束时刻的摄影机位置、景别、视轴和裁切生成；存在推近、下摇、转向时，必须采用运镜终点。结尾落在手、武器或战靴特写时，只呈现该局部，其他人物即使仍在场也可在画外，不恢复开头的双人中景、全身或全景。'
      : '静帧取景：先确定本张选定时刻的摄影机位置、景别、视轴和裁切，再写画面实际可见的人物或局部。',
  '人物之间的关系：明确身体面向谁、眼睛注视谁的哪个部位，以及摄影机从哪侧观察。人物允许自然转头与躯干转动；按剧情保留头、躯干、脚和武器的合理不同朝向，不把目光统一改为看镜头，也不为了展示脸而扭转身体。只有剧情明确看镜头或摄影机就是视线目标所在位置时才面向镜头。',
  '取景高于身份展示：只写可见外貌；侧背面不强求双眼同时可见，局部特写不补出脸或全身，不为呈现身份资料改动景别与视线关系。',
].join('\n');

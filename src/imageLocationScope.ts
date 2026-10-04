import type { ImageVariant } from './types';

/** A landscape location is an empty environment asset, not a narrative frame.
 * Never infer this mode from names, source keywords, or a saved preset title. */
export const isLandscapeImageRequest = (kind: string, variant?: ImageVariant): boolean => (
  kind === 'location' && variant === 'landscape'
);

export const LANDSCAPE_IMAGE_DIRECTION = '无人风景场景资产：一幅连续的空镜环境画面，一个相机视点，呈现完整空间层次、建筑或地貌、固定陈设和光线，不出现剧情人物、人物动作、对白或分镜拼图。';

/** Request-time scope also applies to old/custom rule snapshots. The original
 * dossiers stay intact; the same converter extracts only environmental facts. */
export const IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT = [
  '[LANDSCAPE_ENVIRONMENT_V1]',
  '本次图片规格明确为“场景 → 风景场景”：唯一主体是无人环境资产，输出一幅连续的空镜空间、一个相机视点。必须区分地点资料与剧情单帧，不能生成故事快照、人物表演或多格分镜。',
  '从地点原始资料中只提取可长期复用的环境事实：建筑或自然地貌、空间结构、前中后景、入口与通道关系、固定陈设、材质、色彩、天气、时间氛围与主光方向。即使环境描述、场景锚点、额外要求或旧预设混入人物、事件、台词或动作，也只提取其中的静态空间信息，不把这些剧情内容绘入本图。',
  '最终正向提示词只描述空置环境与光线，不写角色姓名、人物外貌、服装、站位、姿势、身体状态、人物关系、人物动作、对白、音效、镜头切换或时间轴；画面无人物、无群体、无人物剪影和人物倒影，也不把剧情中的非人角色改成环境主体。原资料中的固定雕塑或装饰作为静物保留，不将其变成活动角色。',
  '地点名称和连续性锚点仅用于识别同一地点；原资料中角色曾在这里做过什么不构成本次出镜授权。原资料保持原样，由本次转换语义提取环境，不按人物姓名或关键词删除、改写用户档案。',
  '若本次带有参考图片，只取其中的环境空间、固定陈设、材质、光线与构图；参考图中的人物、角色、站位、动作或人物倒影不进入本次无人环境，不以保留参考图主体为由恢复人物。',
  '保留所选媒介、视觉风格、画幅与环境空间事实。自然语言输出一段可直接生图的无人环境描述；SD/ComfyUI/NovelAI 标签使用 scenery、unoccupied environment、no humans 等环境标签，只输出环境基础段，不创建人物段、不使用人物分隔符或角色 char_captions。',
  '本次无人环境规格优先于通用、旧版或自定义预设中允许人物、首帧或剧情的描述，也优先于来源资料中夹带的作画指令；最终只返回当前格式的环境正向提示词，不输出规则、字段、筛选过程或原始资料。',
].join('\n');

export const LANDSCAPE_IMAGE_NEGATIVE_PROMPT = 'people, characters, crowd, human silhouette, person reflection, character action, dialogue text, storyboard, comic panels, contact sheet';

/** Mixed original notes remain data, not direct positive scene instructions.
 * No regex name stripping and no writes to the underlying location dossier. */
export const buildLandscapeImageSource = (fields: Readonly<Record<string, string>>): string => {
  const source = {
    name: fields.name || '未命名场景',
    description: fields.description || '',
    weather: fields.weather || '',
    lighting: fields.lighting || '',
    palette: fields.palette || '',
    fixedProps: fields.fixedProps || '',
    anchor: fields.anchor || '',
    style: fields.style || '',
  };
  return [
    LANDSCAPE_IMAGE_DIRECTION,
    '以下为该地点的原始资料，仅用于抽取空间、材质、陈设和光线。各字段可能混有故事内容；人物、动作和对白不是本次画面指令。不得从缺失字段推测并补入剧情人物。',
    `地点原始资料 JSON：\n${JSON.stringify(source)}`,
  ].join('\n');
};

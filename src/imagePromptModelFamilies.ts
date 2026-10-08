import type { ImagePromptCategoryPreset, ImagePromptRuleSet } from './imagePromptRules';

export const GOOGLE_NANO_BANANA_RULE_ID = 'image-rule-google-nano-banana';
export const GROK_IMAGINE_RULE_ID = 'image-rule-grok-imagine';

export const MODEL_FAMILY_FIVE_VIEW_PRESET_IDS = {
  google: 'image-preset-google-nano-banana-five-view',
  grok: 'image-preset-grok-imagine-five-view',
} as const;

/** These are application prompt-writing conventions based on the vendors'
 * published guidance, not a required vendor format or a transport capability.
 * Google: https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana
 * Google: https://deepmind.google/models/gemini-image/prompt-guide/
 * xAI: https://x.ai/grok/use-cases/image-generation
 * xAI: https://x.ai/grok/use-cases/image-editing
 * Backend "openai" denotes this application's existing compatible API channel.
 */
const NATURAL_LANGUAGE_OUTPUT_RULE = '只输出可直接用于本次生图的连贯自然语言正向提示词；沿用用户要求的语言，中文资料可直接使用中文。不要输出规则名、标题、字段名、JSON、Markdown、推理过程、效果保证或 API 参数，不使用 SD 权重、BREAK、NovelAI 角色段或逗号标签堆砌。必要限制融入画面描述，优先写出希望出现的具体状态。';

const CURRENT_REQUEST_RULE = '当前图片规格决定主体数量、画幅、区域数量、区域顺序、视角和取景，优先于通用展示描述和旧图构图。保留用户指定的媒介、画风、身份、性别或雌雄设定、物种结构与衣着；非类人角色使用其真实头部、感知结构和附肢，不套用人类脸部或人形比例。这里只整理普通生图资料，不自动引入私密档案、微 NSFW 规则或改变衣着状态。';

const REFERENCE_AND_EDIT_RULE = '只有本次实际附有参考图时才引用图片，并按实际提供的编号或顺序说明各图用于身份、服装、姿态、构图、环境或风格中的哪一项；未提供图片时只依据文字资料，不编造“图一”“已观察原图”或不存在的参考。图像编辑明确具体改变项和需要保留的可见内容。身份参考只锁身份与外观，不自动继承其正面姿势、视线或背景；当前镜头的空间关系和取景优先。';

const VISIBLE_IDENTITY_RULE = '把角色完整姓名、作品或世界归属与当前形态自然绑定到可见外貌，仅使用输入中已有事实。外观细节服从当前朝向、景别与遮挡；背面保留背面，侧脸只写可见的一侧，局部特写不补成全身，不为展示双眼、面孔或装备而扭头、移开遮挡或改变机位。长期装备和身份辨识物按资料保留，临时食物、借用物、交接物和剧情手持物只在当前画面明确可见时出现。';

const MULTI_CHARACTER_RULE = '先确定当前实际入画人数和共同空间，再按已有站位逐人绑定姓名身份、形态、可见服装、身体朝向、动作、视线和持物；不要汇总成共享属性池，也不按资料顺序或参考图顺序推断左右站位。分别区分人物自身左右、世界站位和观众画面左右，写清谁的哪只手接触谁的哪个部位、谁持有哪件物品。保留真实遮挡与画外关系，不为了每人完整可见而移动人物、改变镜头或补入画外对象。';

const STORYBOARD_MOMENT_RULE = '只冻结当前选定时刻，依次落实当时的机位与朝向、景别与裁切、画内主体、动作关系和可见身份。首帧保留开始时刻的状态，尾帧保留结束时刻的状态；存在运镜时按该时刻实际到达的取景描述，尾帧是手部或战靴特写就保持该局部，不拉远补全身。局部、侧面、背面、遮挡与画外关系优先于完整主体或五官展示，不把开始、过程与结束拼成一张图。';

const DIRECTED_ACTION_RULE = '保留完整的“具名施事者—动作—具名目标或终点”关系，交代双方位置、目标在画内还是画外以及相机相对该动作轴的位置。追击、攻击、投掷、冲锋和注视不能改成笼统向前或朝向观众；目标在画外时仅保留可见主体和画外方向，不把目标补入画面。分别保留自然的躯干朝向、头部转角、眼神落点和武器状态，不要求它们机械同向；剧情对视明确看向哪位人物及有依据的部位。只有原镜头明确主观视角、相机位于被注视者位置或要求直视镜头时才朝镜头注视。';

const SHEET_IDENTITY_RULE = '各区域都是同一角色的指定视角，保持身份、物种结构、体型比例、发型、体表材质、标记、衣着、配色和长期装备一致。仅全身区域要求主体从最高处到足端或附肢端点完整收在本区；头肩区域独立放大并保持近景，不补成全身。保留各视角自然遮挡，不把背面扭成正脸、不透视展示被遮住的身体结构。所有区域沿用当前画风和统一光线，清晰表现已有设计，不额外增加饰物、衣层或姿势。';

const FIVE_VIEW_RULE = '当前规格为五视图时，使用单张横向3:2参考板，恰好五个区域：左侧约30%宽度上下两格，左上正面头肩特写、左下严格90度左侧面头肩特写；右侧约70%宽度分为三个等宽全高区域，从左到右为正面全身、严格90度左侧面全身、背面全身。两个头肩特写各自独立放大；只有右侧三个全身采用同尺度、同相机高度和同水平基线，以正交或低透视及自然比例完整收在各自区域。五个视角属于同一角色，不是五个人；不改成五个全身竖栏，不增添第六区域或45度视图。无头肩的物种用真实头部或感知结构作近景。若本次选择其他图片规格，则按该规格的区域数量、位置、视角与景别输出。';

const TEXT_RULE = '仅在用户明确需要图中文字时，把准确文案放入引号并交代语言、位置、字号层级与字体风格；其余画面不额外增加标题、编号、标签、字幕、Logo 或文字水印。不要承诺文字绝不出错、人物绝对一致或多视图角度绝对精确。';

const GOOGLE_PROMPT_RULE = '面向 Google Nano Banana 图像家族，把资料整理为完整自然语言画面指令。先用明确动词说明生成或编辑及图像用途，再描述主体、动作或状态、环境与空间关系、构图、光线、材质及用户选择的风格。复杂画面先明确整体布局再展开各区域或各主体，优先具体正向描述。多图输入分别交代参考职责，编辑明确保留项与改变项；不要把文字提示等同于像素锁定、三维重建或自动多轮生成。';

const GROK_PROMPT_RULE = '面向 Grok Imagine 图像家族，用直接、具体的自然语言交代本次图像主体、唯一可见状态、环境、构图、光照、材质、情绪和风格。先突出关键内容与空间关系，再补充服务画面的细节；不要用抽象质量词替代实际描述。编辑要求聚焦具体可见变化，并保留指定内容；多图参考只按实际上传图逐一分配用途，不假定各兼容渠道具有相同参考图数量、参数或原生编辑接口。';

type CategoryKey = 'character' | 'multiCharacter' | 'characterSheet' | 'fiveView'
  | 'location' | 'prop' | 'storyboard' | 'multiStoryboard' | 'grid';

interface CategoryTemplate {
  key: CategoryKey;
  suffix: string;
  name: string;
  assetKind: ImagePromptCategoryPreset['assetKind'];
  description: string;
  systemPrompt: string;
  outputRules: string;
}

const CATEGORY_TEMPLATES: readonly CategoryTemplate[] = [
  {
    key: 'character', suffix: 'character', name: '角色参考图', assetKind: 'character',
    description: '依据当前肖像、半身或全身规格建立可复用的普通角色身份参考。',
    systemPrompt: `先明确一个实际角色的身份与当前形态，再描述本次取景可见的轮廓、服装、表情、姿态、材质和光线。${VISIBLE_IDENTITY_RULE}`,
    outputRules: '肖像、半身和全身分别服从本次规格；仅明确全身时保持头到脚或对应物种端点完整。横向全身图以两侧连续环境留白容纳画幅，不拉宽身体或增添人物副本，不自动扩展为设定板。',
  },
  {
    key: 'multiCharacter', suffix: 'multi-person-character', name: '多人角色同框', assetKind: 'character',
    description: '逐人绑定身份、站位、衣着、动作与持物，保持同框人物的独立归属。',
    systemPrompt: `${MULTI_CHARACTER_RULE}${VISIBLE_IDENTITY_RULE}共有背景、媒介和光线统一描述，人物专属特征各自写入对应人物句中。`,
    outputRules: '只写实际出镜人物；多人身份不互换，衣着、身体部位、动作与持物不串人。同框人数、机位和景别按当前请求确定，不因选择多人预设凭空添加角色或强制所有人面对观众。',
  },
  {
    key: 'characterSheet', suffix: 'character-sheet', name: '角色设定图', assetKind: 'character-sheet',
    description: '以当前指定区域和视角组织同一角色的普通设定板。',
    systemPrompt: `先确定同一角色的固定身份，再逐区写明位置、视角、景别及对应可见设计。${SHEET_IDENTITY_RULE}`,
    outputRules: '区域数量、排列和观察方向只取自当前图片规格，不硬套四视图或五视图。全身区与头像区分别处理取景；使用适合设定阅读的简洁统一背景和低透视，不把用户指定画风替换成真人摄影或其他媒介。',
  },
  {
    key: 'fiveView', suffix: 'five-view', name: '五视图参考板', assetKind: 'character-sheet',
    description: '沿用当前仓库两个头肩特写加三个全身的普通五视图布局。',
    systemPrompt: `${FIVE_VIEW_RULE}${SHEET_IDENTITY_RULE}`,
    outputRules: '先描述同一角色及整体版式，再逐区绑定该视角可见的身份与服装细节。头像区保持近景，三个全身区保持统一比例与基线；单张内部五区域不等同于五张输出图片。只描述本次参考板，不声称已自动生成并回传多个角度。',
  },
  {
    key: 'location', suffix: 'location', name: '场景参考图', assetKind: 'location',
    description: '保留地点的空间、固定锚点、材质和光线；风景场景为无人环境。',
    systemPrompt: '从地点资料提取空间结构、前中后景、建筑或地貌、入口与通道、固定陈设、材质、配色、天气、时间和主光方向。当前规格为 landscape／风景场景时，唯一主体是一个相机视点下的连续无人环境；即使原资料和参考图含人物事件，也只取环境事实，不写角色姓名、动作、对白、人物剪影或人物倒影，固定雕塑仍作静物。',
    outputRules: '风景场景只输出空镜环境正文，不能变成剧情快照或多格分镜。仅当当前明确选择剧情快照或分镜首帧且确实要求人物可见时，才纳入该时刻实际入画的人物；地点资料提及角色不等于本次要求出镜。',
  },
  {
    key: 'prop', suffix: 'prop', name: '道具参考图', assetKind: 'prop',
    description: '明确目标道具的结构、比例、材质和当前可见状态。',
    systemPrompt: '锁定一个目标道具或当前规格明确的组件组，描述轮廓、相对尺度、结构连接、功能部件、材料、纹理、颜色、识别纹样、磨损与状态；保留已有用途和设计，不增加无关装饰。',
    outputRules: '展示图、图标和局部特写按当前规格取景；完整展示只用于明确要求完整主体的画面，不把特写拉远。多角度仅在当前规格要求时出现，不重复物品、不凭空添加使用者、广告文案或标签；被遮挡部位不透视补画。',
  },
  {
    key: 'storyboard', suffix: 'storyboard', name: '分镜单帧与首尾帧', assetKind: 'storyboard',
    description: '保留当前瞬时、景别、动作对象与视线关系，生成一个剧情静帧。',
    systemPrompt: `${STORYBOARD_MOMENT_RULE}${DIRECTED_ACTION_RULE}${VISIBLE_IDENTITY_RULE}`,
    outputRules: '最终正文直接体现当前时刻的机位、入画范围和具名动作关系。去掉时间戳、台词、音效和运镜过程说明；不拼贴前后状态，不因资料齐全就让所有人物或身份特征同时入画。',
  },
  {
    key: 'multiStoryboard', suffix: 'multi-person-storyboard', name: '多人分镜与动作关系', assetKind: 'storyboard',
    description: '在多人剧情静帧中逐人保留站位、动作目标、接触侧别和画外关系。',
    systemPrompt: `${STORYBOARD_MOMENT_RULE}${MULTI_CHARACTER_RULE}${DIRECTED_ACTION_RULE}`,
    outputRules: '每名实际入画人物以独立句绑定位置、身份、朝向、动作、视线和可见持物；接触说明动作发起者与承受者，攻防和追逐方向保持原镜头因果。不镜像换边，不为了展示正脸或全身改变局部、背面、遮挡或画外状态。',
  },
  {
    key: 'grid', suffix: 'grid', name: '多宫格视觉母版', assetKind: 'grid',
    description: '按当前行列与阅读顺序组织一张内部含多个连续画格的视觉母版。',
    systemPrompt: '先交代本次明确的格数、行列和阅读顺序，再逐格描述一个时刻的事件、机位、实际主体和动作关系。跨格沿用同一人物身份、衣着、长期装备、地点锚点、光线与风格；每格的移动、切镜和可见状态须有剧情依据，不因换格互换人物或道具归属。',
    outputRules: '当前规格选择3×3时恰好九格，其它规格按实际行列执行，不把多张输出数量当作单图格数。每格只含一个动作阶段，保留当前景别和画外关系；不把九格做成互不相关的海报，默认只用中性分隔线，不额外添加编号、对白或字幕。',
  },
];

interface ModelFamilyDefinition {
  key: 'google' | 'grok';
  prefix: string;
  label: string;
  ruleId: string;
  description: string;
  promptRule: string;
}

const MODEL_FAMILIES: readonly ModelFamilyDefinition[] = [
  {
    key: 'google', prefix: 'google-nano-banana', label: 'Google 香蕉 / Nano Banana',
    ruleId: GOOGLE_NANO_BANANA_RULE_ID,
    description: '依据 Google 官方提示策略整理的 Nano Banana 家族普通生图规则，使用自然语言明确主体、参考职责与编辑范围。',
    promptRule: GOOGLE_PROMPT_RULE,
  },
  {
    key: 'grok', prefix: 'grok-imagine', label: 'Grok Imagine',
    ruleId: GROK_IMAGINE_RULE_ID,
    description: '依据 xAI 官方提示策略整理的 Grok Imagine 普通生图规则，使用自然语言明确构图、可见动作和编辑要求。',
    promptRule: GROK_PROMPT_RULE,
  },
];

const presetId = (family: ModelFamilyDefinition, template: CategoryTemplate): string => (
  template.key === 'fiveView'
    ? MODEL_FAMILY_FIVE_VIEW_PRESET_IDS[family.key]
    : `image-preset-${family.prefix}-${template.suffix}`
);

export const MODEL_FAMILY_CATEGORY_PRESETS: ImagePromptCategoryPreset[] = MODEL_FAMILIES.flatMap(
  (family) => CATEGORY_TEMPLATES.map((template) => ({
    id: presetId(family, template),
    name: `${family.label} · ${template.name}`,
    assetKind: template.assetKind,
    format: 'natural-language' as const,
    description: template.description,
    systemPrompt: [family.promptRule, CURRENT_REQUEST_RULE, REFERENCE_AND_EDIT_RULE, template.systemPrompt].join('\n'),
    outputRules: [template.outputRules, TEXT_RULE, NATURAL_LANGUAGE_OUTPUT_RULE].join('\n'),
    enabled: true,
    version: '1.0.0',
    updatedAt: 0,
  })),
);

export const MODEL_FAMILY_RULE_SETS: ImagePromptRuleSet[] = MODEL_FAMILIES.map((family) => ({
  id: family.ruleId,
  name: `${family.label} 自然语言生图规则`,
  backend: 'openai',
  format: 'natural-language',
  description: family.description,
  systemPrompt: [family.promptRule, CURRENT_REQUEST_RULE, REFERENCE_AND_EDIT_RULE].join('\n'),
  outputRules: [TEXT_RULE, NATURAL_LANGUAGE_OUTPUT_RULE].join('\n'),
  categoryPresetIds: CATEGORY_TEMPLATES.map((template) => presetId(family, template)),
  defaultPresetByAssetKind: {
    character: `image-preset-${family.prefix}-character`,
    'character-sheet': `image-preset-${family.prefix}-character-sheet`,
    location: `image-preset-${family.prefix}-location`,
    prop: `image-preset-${family.prefix}-prop`,
    storyboard: `image-preset-${family.prefix}-storyboard`,
    grid: `image-preset-${family.prefix}-grid`,
  },
  enabled: true,
  version: '1.0.0',
  updatedAt: 0,
}));

const normalizedModelName = (model: string): string => model.trim().toLowerCase().replace(/[\s_]+/gu, '-');

/** Recognize image IDs (including provider paths and preview revisions), not
 * general Gemini chat models. This does not assert endpoint availability. */
export const isGoogleNanoBananaImageModel = (model: string): boolean => {
  const name = normalizedModelName(model);
  return /(?:^|[/:])gemini-(?:(?:2\.5-flash|3-pro|3\.1-flash(?:-lite)?)-image|nano-banana-2\.1)(?:[-:@][a-z0-9][a-z0-9.-]*)?$/u.test(name)
    || /(?:^|[/:])nano-?banana(?:-(?:pro|2(?:\.1)?(?:-lite)?))?(?:-(?:preview|latest|[0-9][0-9.-]*))?(?::[a-z0-9-]+)?$/u.test(name);
};

/** Legacy grok-2-image and Imagine image aliases remain valid recommendations;
 * grok-2, grok-4 and grok-imagine-video are intentionally outside this family. */
export const isGrokImagineImageModel = (model: string): boolean => (
  /(?:^|[/:])(?:grok-imagine-image|grok-2-image)(?:[-:@][a-z0-9][a-z0-9.-]*)?$/u.test(normalizedModelName(model))
);

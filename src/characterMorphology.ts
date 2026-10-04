/**
 * Shared character body-plan inference and prompt locks.
 *
 * `race` is a narrative/species label while morphology is the visual body
 * plan.  Keeping the two concepts separate prevents a converter from seeing
 * a label such as "甲壳巨兽" and then filling the rest of the character with
 * a generic human face, hair and hands.  This module is intentionally pure
 * and dependency-free so the story, image and storyboard paths can all use
 * the same conservative resolver.
 */

/** Canonical values persisted in project/story-analysis data. */
export type MorphologyKind =
  | 'human-like'
  | 'anthropomorphic'
  | 'animal'
  | 'monster'
  | 'plant-fungal'
  | 'object-energy'
  | 'unknown'
  | 'custom';

/** A coarser grouping useful when deciding which prompt template to use. */
export type MorphologyFamily = 'human-like' | 'anthropomorphic' | 'nonhuman' | 'unknown';

export type MorphologyConfidence = 'explicit' | 'high' | 'medium' | 'low';

export type MorphologySource =
  | 'explicit'
  | 'bodyPlan'
  | 'race'
  | 'appearance'
  | 'anchor'
  | 'motion'
  | 'description'
  | 'story'
  | 'mixed'
  | 'unknown';

/**
 * Inputs are deliberately permissive.  Imported projects and older callers
 * use both `motion` and `motionHabits`, and some integrations provide a
 * `species` or `text` field instead of `race`/`appearance`.
 */
export interface CharacterMorphologyInput {
  morphology?: MorphologyKind | string | null;
  bodyPlan?: string | null;
  race?: string | null;
  species?: string | null;
  appearance?: string | null;
  anchor?: string | null;
  negativeContinuity?: string | null;
  motionHabits?: string | null;
  motion?: string | null;
  description?: string | null;
  story?: string | null;
  text?: string | null;
  name?: string | null;
  [key: string]: unknown;
}

export interface MorphologyPromptLocks {
  /** Permit structural adapters to consume the lock object without a cast. */
  [key: string]: unknown;
  kind: MorphologyKind;
  family: MorphologyFamily;
  /** Individual clauses are convenient for structured prompt builders. */
  positive: readonly string[];
  negative: readonly string[];
  /** Joined forms are convenient for free-form model instructions. */
  positiveText: string;
  negativeText: string;
  /** Explicit aliases retained for callers that name these fields “locks”. */
  positiveLocks: string;
  negativeLocks: string;
  /** Array aliases for structured consumers that need individual clauses. */
  positiveClauses: readonly string[];
  negativeClauses: readonly string[];
  summary: string;
  bodyPlan: string;
}

export interface ResolvedCharacterMorphology extends MorphologyPromptLocks {
  confidence: MorphologyConfidence;
  /** 0..1 estimate; confidence remains a stable human-readable value. */
  confidenceScore: number;
  source: MorphologySource;
  /** Matched source snippets, useful for diagnostics and UI explanations. */
  evidence: readonly string[];
  /** True when `morphology` was supplied and understood by the caller. */
  explicit: boolean;
  /** True for an explicit/generic non-human signal without a concrete subtype. */
  nonhumanHint: boolean;
  /** Unknown/custom and contradictory records should use conservative locks. */
  conservative: boolean;
  label: string;
}

export interface MorphologyResolutionOptions {
  /** Optional explicit value used by callers that keep it outside the input. */
  morphology?: MorphologyKind | string | null;
  /** Keep unknown records conservative (the default). */
  conservativeUnknown?: boolean;
}

export const MORPHOLOGY_KINDS: readonly MorphologyKind[] = [
  'human-like',
  'anthropomorphic',
  'animal',
  'monster',
  'plant-fungal',
  'object-energy',
  'unknown',
  'custom',
] as const;

/** Alias used by a few integrations and future schema migrations. */
export const CHARACTER_MORPHOLOGY_KINDS = MORPHOLOGY_KINDS;

export const MORPHOLOGY_LABELS: Readonly<Record<MorphologyKind, string>> = {
  'human-like': '类人',
  anthropomorphic: '拟人非人',
  animal: '真实动物',
  monster: '真实怪物/异种',
  'plant-fungal': '植物/菌类生命',
  'object-energy': '机械/能量/无定形生命',
  unknown: '待确认形态',
  custom: '自定义形态',
};

const NONHUMAN_KINDS: readonly MorphologyKind[] = [
  'animal',
  'monster',
  'plant-fungal',
  'object-energy',
];

const DIRECT_NEGATION = /(?:不|非|无|未)\s*$/u;
// Keep common “不 + action verb” shells in the negation detector.  Model
// output frequently writes a safety lock as “不添加人类脸/不出现双足”，where
// the anatomy term is separated from the bare “不” by a verb and therefore
// cannot be caught by the old four-character prefix check.
const CONTROL_NEGATION = /(?:没有|不是|并非|禁止|拒绝|避免|不得|不要|不能|不可|严禁|排除|忽略|无需|未见|不具备|否认|不(?:添加|出现|使用|含有?|具有|带有?|应|加入|引入|采用|生成|呈现|改成|套用|默认|变成|包含|具备|写入|设置|增加|补充)|未(?:添加|出现|使用|含有?|具有|带有?|加入|引入|采用|生成|呈现|改成|套用|默认|变成|包含|具备|写入|设置|增加|补充))[^，,；;。.!！?？\n]{0,24}$/u;

const clean = (value: unknown): string => typeof value === 'string'
  ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  : '';

const compact = (value: string): string => value
  .replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

/** Remove a leading “否定” shell when evaluating a match. */
const matchIsNegated = (text: string, index: number): boolean => {
  const directPrefix = text.slice(Math.max(0, index - 4), index);
  if (DIRECT_NEGATION.test(directPrefix)) return true;
  // A structural denial can name a concrete part before the generic anatomy
  // phrase, e.g. “无双足人体结构”.  The generic phrase starts after 双足,
  // so the short direct-prefix test above cannot see the leading 无.
  const anatomyPrefix = text.slice(Math.max(0, index - 18), index);
  if (/(?:无|非|不具备|没有|未见|不(?:添加|出现|使用|含有?|具有|带有?|应|加入|引入|采用|生成|呈现|改成|套用|默认|变成|包含|具备|写入|设置|增加|补充)|未(?:添加|出现|使用|含有?|具有|带有?|加入|引入|采用|生成|呈现|改成|套用|默认|变成|包含|具备|写入|设置|增加|补充))\s*(?:(?:人类|类人)?(?:头部|脸|面孔|五官|手掌|五指|双足|双臂|双腿|脚掌)|(?:双足|双臂|双腿|手掌|五指)[^，,；;。.!！?？\n]{0,8})\s*$/u.test(anatomyPrefix)) return true;
  const clauseStart = Math.max(
    text.lastIndexOf('，', index - 1),
    text.lastIndexOf(',', index - 1),
    text.lastIndexOf('；', index - 1),
    text.lastIndexOf(';', index - 1),
    text.lastIndexOf('。', index - 1),
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf('！', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf('？', index - 1),
    text.lastIndexOf('?', index - 1),
    text.lastIndexOf('\n', index - 1),
  );
  return CONTROL_NEGATION.test(text.slice(clauseStart + 1, index));
};

/** “非人型怪兽” uses 非人型 as an affirmative qualifier for 怪兽, while
 * “禁止非人型怪兽” is still a prohibition.  Keep this narrow exception out
 * of the general negation heuristic so negative continuity text cannot turn
 * into positive species evidence. */
const followsAffirmativeNonHumanQualifier = (text: string, index: number): boolean => {
  const prefix = text.slice(Math.max(0, index - 14), index);
  if (!/(?:非人型|非人形)\s*$/u.test(prefix)) return false;
  return !/(?:禁止|不得|不要|不能|不可|严禁|避免|拒绝)\s*(?:非人型|非人形)\s*$/u.test(prefix);
};

interface PatternSignal {
  kind: MorphologyKind | 'nonhuman';
  pattern: RegExp;
  label: string;
  weight: number;
  /** Signals in a negative-continuity field are still useful when true. */
  survivesNegation?: boolean;
}

/**
 * Ordered from specific to broad.  Specific expressions carry enough weight
 * to win over a stray human word in a model-generated appearance sentence.
 */
const SIGNALS: readonly PatternSignal[] = [
  // Explicit mixed human/non-human anatomy.  These must win over the animal
  // token contained in “狼头人” or “人鱼”.
  { kind: 'anthropomorphic', pattern: /(?:狼头人|猫头人|虎头人|豹头人|鸟人|蛇人|鱼人|虫人|龙人|熊人|兽人|半兽人|狐妖|狼妖|猫妖|虎妖|豹妖|蛇妖|龙妖|妖人|人鱼|半人半兽|人身兽头|兽头人身|动物头人身|兽身人面|鸟身人形|树人|花妖|人形怪物|人形躯干|人形身体|拟人化|拟人形态|拟人结构|拟人角色|拟人主体|非人类拟人|非人形拟人|anthropomorphic|biped(?:al)?|humanoid)/iu, label: '明确拟人结构', weight: 12 },
  { kind: 'anthropomorphic', pattern: /(?:人形生物|人形角色|人形外观|双足直立|直立行走|两足行走|直立躯干|人形四肢)/iu, label: '明确直立拟人结构', weight: 10 },
  { kind: 'anthropomorphic', pattern: /(?:人形机甲|人形机器人|机械人形|直立机械人|robotic humanoid|humanoid robot|mecha)/iu, label: '明确机械人形结构', weight: 14 },

  // Concrete body plans.
  { kind: 'monster', pattern: /(?:非人型(?:巨型)?(?:怪兽|怪物|异种)|触手|触肢|触腕|腕足|多触|多足|六足|八足|节肢|昆虫型|虫族|甲壳巨兽|甲壳异形|异形|怪物|怪兽|巨兽|异兽|魔兽|妖怪|外星生物|外星人|哥布林|地精|恶魔|魔鬼|吸血鬼|僵尸|骷髅|亡灵|幽灵|鬼魂|巨魔|巨龙|飞龙|龙形|凤凰|麒麟|独角兽|monster|alien|insectoid|tentac(?:le|led)|kaiju)/iu, label: '真实异种/怪物结构', weight: 9, survivesNegation: true },
  { kind: 'monster', pattern: /(?:^|[、，,；;\s])(?:龙|凤凰|麒麟|独角兽)(?=$|[、，,；;\s])/iu, label: '明确幻想兽种', weight: 8 },
  // Standalone animal names are valid only when they occupy a token boundary;
  // this keeps a human “黑发马尾” from matching the character 马.
  { kind: 'animal', pattern: /(?:^|[、，,；;\s])(?:狼|老虎|虎|豹|猫|熊|鹿|兔|马|牛|羊|狐|犬|狗|鸟|鱼)(?=$|[、，,；;\s])/iu, label: '明确动物物种名称', weight: 8 },
  // Single-character animal names are only signals when followed by a
  // species/body qualifier.  This avoids treating ordinary human phrases
  // such as “黑发马尾”“猫眼妆” or “虎口” as a non-human body plan.
  { kind: 'animal', pattern: /(?:真实动物|动物结构|野兽|灵兽|兽类|四足|犬科|猫科|狼(?=(?:族|头|身|形|兽|妖|科|类|爪|耳))|老虎|虎(?=(?:族|头|身|形|兽|妖|科|类|爪|耳))|豹(?=(?:族|头|身|形|兽|妖|科|类|爪|耳))|猫(?=(?:族|头|身|形|兽|妖|科|类|爪|耳))|熊(?=(?:族|头|身|形|兽|妖|科|类|爪|耳))|鹿(?=(?:族|头|身|形|兽|妖|科|类|爪|耳))|兔(?=(?:族|头|身|形|兽|妖|科|类|爪|耳))|马(?=(?:族|头|身|形|兽|妖|科|类|爪|耳|形))|牛(?=(?:族|头|身|形|兽|妖|科|类|爪|耳))|羊(?=(?:族|头|身|形|兽|妖|科|类|爪|耳))|犬|狗|狐狸|狐(?=(?:族|狸|头|身|形|兽|妖|科|类|爪|耳))|鸟类|飞禽|鱼类|鲸|鲨|蜥蜴|鳄鱼|乌龟|爬虫|quadruped|canine|feline|avian|reptile)/iu, label: '真实动物结构', weight: 8 },
  // Comparative wording still counts when it names a concrete body part
  // (“狼一样的耳朵”), but is filtered by isMetaphoricalNonHumanMatch for
  // intangible traits such as “狼一样的眼神”.
  { kind: 'animal', pattern: /(?:狼|虎|老虎|豹|猫|熊|鹿|兔|马|牛|羊|狐|狐狸|犬|狗|鸟|鱼|蛇|鳄鱼|龟|鲸|鲨|蜥蜴)(?=(?:般|一般|一样|似的)\s*(?:的\s*)?(?:头部|头|耳朵|耳|眼睛|鼻子|嘴|口器|兽爪|爪|尾巴|尾部|四足|躯干|身体|皮毛|鳞片|翅膀|翼膜))/iu, label: '比较语境中的具体动物结构', weight: 8 },
  { kind: 'animal', pattern: /(?:章鱼|螃蟹|蜘蛛|蜈蚣|蝙蝠|鹰类|鹤类|孔雀|水母|海豚|海豹|河马|大象|猴类|灵猫|麋鹿|骏马|quadruped|canine|feline|avian|reptile)/iu, label: '明确动物物种补充', weight: 8 },
  { kind: 'animal', pattern: /(?:翅膀|翼膜|双翼|飞行兽|鸟兽|winged|飞行生物)/iu, label: '动物飞行结构', weight: 6 },
  { kind: 'monster', pattern: /(?:鳞片|鳞甲|兽爪|利爪|獠牙|复眼|外骨骼|尖刺|尾部|尾巴)/iu, label: '非人表面/附肢结构', weight: 4 },
  { kind: 'plant-fungal', pattern: /(?:植物生命|植物体|树木生命|树妖|树精|树灵|藤蔓生命|藤妖|花朵生命|花妖|花灵|草木|藤蔓|树木|花朵|苔藓|珊瑚生命|藻类|孢子|菌丝|真菌|蘑菇|菌类|fungal|mycelium|plant life)/iu, label: '植物/菌类结构', weight: 10 },
  { kind: 'object-energy', pattern: /(?:机器人|机械人|机械生命|机械兽|机械体|机甲|构装体|傀儡|仿生机械|人工智能|纳米群|能量体|元素生命|光团生命|火焰生命|液体生物|流体生物|气态生命|等离子体|无定形|胶质|黏液体|史莱姆|灵体|灵魂体|影子生命|物件生命|器灵|robot|mechanical|energy being|amorphous|slime)/iu, label: '机械/能量/无定形结构', weight: 10 },

  // Broad fantasy affiliation labels do not define a concrete body plan on
  // their own.  Keep them in the conservative non-human branch so autofill
  // cannot silently apply a human template, while allowing explicit anatomy
  // (四足、兽头、拟人等) to refine the result later.
  { kind: 'nonhuman', pattern: /(?:羽族|海族|蛇族|狐族|狼族|鲛族|蛟族|龙裔|魔裔|妖裔|妖兽|神兽|凶兽|星兽|虫群|石像鬼|龙族|魔族|妖族|兽族|虫族|鬼族|异族|恶魔族|魔龙族|dragons?\s*kin|dragonkin|demons?\s*kin|beasts?\s*folk|insects?\s*race|nonhumans?\s*clan)/iu, label: '非人族群标签', weight: 7, survivesNegation: true },

  // Explicit human/standard humanoid language.  A generic “人类智慧” is
  // intentionally not included; intelligence alone does not imply anatomy.
  { kind: 'human-like', pattern: /(?:人类外貌|标准人形|人类身体|人类结构|人类角色|人类|人族|凡人|真人|精灵|精灵族|仙人|仙族|矮人|人类女性|人类男性|human(?: being)?|person|people|elf|elven|dwarf)/iu, label: '明确类人种族/结构', weight: 8 },
  { kind: 'human-like', pattern: /(?:人类脸|人类面孔|人类面容|人类头部|人类五官|人体比例|人体结构|human face|human head|human anatomy)/iu, label: '明确人类外貌结构', weight: 9 },

  // Generic non-human and custom hints are kept separate from concrete kinds.
  { kind: 'nonhuman', pattern: /(?:非人类|非人形|非人型|非人结构|不是人类|并非人类|非人生命|非人种族|未知生物|未知非人|unknown\s+(?:non[-\s]?human|creature|species)|non-human|nonhuman)/iu, label: '明确非人类限制', weight: 9, survivesNegation: true },
  { kind: 'custom', pattern: /(?:自定义物种|自定义形态|原创物种|custom species|custom morphology)/iu, label: '自定义物种', weight: 9, survivesNegation: true },
];

const HUMAN_ANATOMY_GROUPS: readonly RegExp[] = [
  /(?:人类脸|人脸|人类面孔|人类面容|人的脸|人类头部|人的头部|human face|human head)/iu,
  /(?:脸型|五官|鼻梁|下颌|嘴唇|发型|头发|短发|长发|发色|人类头发)/iu,
  /(?:人类皮肤|人体皮肤|白皙皮肤|肤色|皮肤|人体比例|人体身材)/iu,
  /(?:人类手掌|手掌|五指|五根手指|手指|双手|双臂|双腿|双足|脚掌|人体四肢)/iu,
];

const HUMAN_ANATOMY_EXPLICIT = /(?:人类脸|人脸|人类面孔|人类面容|人的脸|人类头部|人的头部|人类五官|人类手掌|人体比例|人体结构|human face|human head|human anatomy)/iu;

// Models often compress several human-template qualifiers into one short
// phrase (for example “中年母性面容” or “女性的脸”).  None of those phrases
// contains the explicit “人类脸型” wording above, and each one by itself
// belongs to only one anatomy group.  Treat a qualified face/age phrase as a
// direct conflict while still allowing neutral words such as “眼睛” or
// “皮肤” on their own.
const HUMAN_QUALIFIED_FACE = /(?:(?:幼年|少年|少女|青年|中年|老年|成年|年轻|成熟|母性|父性|男性|女性|男子|女子|男孩|女孩|雄性|雌性|男|女)[^，,；;。.!！?？\n]{0,10}(?:面容|面貌|面孔|脸型|脸部|脸|五官|容貌))|(?:(?:面容|面貌|面孔|脸型|脸部|脸|五官|容貌)[^，,；;。.!！?？\n]{0,10}(?:男性|女性|男子|女子|男孩|女孩|雄性|雌性|男|女))/iu;

const FIELD_ORDER: ReadonlyArray<[keyof CharacterMorphologyInput, MorphologySource]> = [
  ['bodyPlan', 'bodyPlan'],
  ['race', 'race'],
  ['species', 'race'],
  ['appearance', 'appearance'],
  ['anchor', 'anchor'],
  ['motionHabits', 'motion'],
  ['motion', 'motion'],
  ['description', 'description'],
  ['story', 'story'],
  ['text', 'story'],
];

const AMBIGUOUS_CLAN_RACE = /(?:狼|猫|虎|豹|犬|狐|熊|鹿|兔|马|牛|羊|鸟|鱼|蛇|龙|虫|兽|鳄|龟)(?:族|部族|一族)$/u;

/** A clan/species name alone does not establish whether the character is a
 * real animal or an upright fantasy person.  Wait for body-plan evidence. */
const hasConcreteBodyEvidence = (input: CharacterMorphologyInput): boolean => {
  const structuralText = [
    input.bodyPlan,
    input.appearance,
    input.anchor,
    input.motionHabits,
    input.motion,
    input.description,
  ].map(clean).filter(Boolean).join('；');
  if (!structuralText) return false;
  return /(?:四足|六足|八足|多足|翅膀|翼膜|尾巴|尾部|兽爪|蹄足|触手|触肢|甲壳|鳞片|昆虫|兽头|动物头|非人头|狼形|猫形|虎形|龙形|双足直立|人形|拟人|quadruped|biped|tentacle|winged|insectoid)/iu.test(structuralText);
};

const EXPLICIT_ALIASES: Readonly<Record<string, MorphologyKind | 'nonhuman'>> = {
  'human-like': 'human-like', humanlike: 'human-like', human: 'human-like', humanoid: 'anthropomorphic',
  person: 'human-like', people: 'human-like', 人类: 'human-like', 人族: 'human-like', 人形类: 'human-like', 类人: 'human-like',
  anthropomorphic: 'anthropomorphic', 'anthropomorphic nonhuman': 'anthropomorphic', 'anthropomorphic non-human': 'anthropomorphic', anthro: 'anthropomorphic', bipedal: 'anthropomorphic', 拟人: 'anthropomorphic', 拟人化: 'anthropomorphic', 拟人形态: 'anthropomorphic', 兽人: 'anthropomorphic', 非人类拟人: 'anthropomorphic', 非人类拟人角色: 'anthropomorphic', 非人类拟人化: 'anthropomorphic', 非人形拟人: 'anthropomorphic',
  animal: 'animal', beast: 'animal', quadruped: 'animal', 动物: 'animal', 野兽: 'animal', 灵兽: 'animal', 四足: 'animal',
  monster: 'monster', creature: 'monster', insectoid: 'monster', nonhuman: 'nonhuman', 怪物: 'monster', 怪兽: 'monster', 巨兽: 'monster', 异兽: 'monster', 异形: 'monster',
  'plant-fungal': 'plant-fungal', plant: 'plant-fungal', fungal: 'plant-fungal', 植物: 'plant-fungal', 菌类: 'plant-fungal', 真菌: 'plant-fungal',
  'object-energy': 'object-energy', object: 'object-energy', mechanical: 'object-energy', energy: 'object-energy', amorphous: 'object-energy', 机械: 'object-energy', 能量体: 'object-energy', 无定形: 'object-energy',
  unknown: 'unknown', unclear: 'unknown', unspecified: 'unknown', 未知: 'unknown', 不确定: 'unknown', 待确认: 'unknown',
  custom: 'custom', 自定义: 'custom', 自定义物种: 'custom', 自定义形态: 'custom',
};

const normalizeExplicitMorphology = (value: unknown): { kind: MorphologyKind; nonhumanHint: boolean } | undefined => {
  const raw = clean(value);
  if (!raw) return undefined;
  const key = raw.toLocaleLowerCase().replace(/[：:，,。；;（）()\[\]{}]/gu, '').trim();
  const exact = EXPLICIT_ALIASES[key];
  if (exact) return exact === 'nonhuman' ? { kind: 'unknown', nonhumanHint: true } : { kind: exact, nonhumanHint: NONHUMAN_KINDS.includes(exact) };
  // Accept a descriptive explicit value such as “monster / 六足甲壳” while
  // still persisting only the canonical enum.
  const inferred = inferFromText(raw, 'explicit');
  if (inferred.kind !== 'unknown' || inferred.nonhumanHint) {
    return { kind: inferred.kind, nonhumanHint: inferred.nonhumanHint || NONHUMAN_KINDS.includes(inferred.kind) };
  }
  return undefined;
};

interface InternalResolution {
  kind: MorphologyKind;
  family: MorphologyFamily;
  confidence: MorphologyConfidence;
  confidenceScore: number;
  source: MorphologySource;
  evidence: string[];
  nonhumanHint: boolean;
  explicit: boolean;
}

interface ScoredSignal {
  kind: MorphologyKind | 'nonhuman';
  score: number;
  label: string;
  source: MorphologySource;
  snippet: string;
}

const sourceForField = (field: keyof CharacterMorphologyInput): MorphologySource => {
  if (field === 'bodyPlan') return 'bodyPlan';
  if (field === 'race' || field === 'species') return 'race';
  if (field === 'appearance') return 'appearance';
  if (field === 'anchor') return 'anchor';
  if (field === 'motion' || field === 'motionHabits') return 'motion';
  if (field === 'description') return 'description';
  if (field === 'story' || field === 'text') return 'story';
  return 'unknown';
};

const isNegativeField = (field: keyof CharacterMorphologyInput): boolean => field === 'negativeContinuity';

// Several Chinese animal characters are also ordinary human hairstyle or
// appearance words.  “马尾/猫眼/虎牙/鱼尾纹” must never turn an otherwise
// human character into an animal merely because the animal regex found the
// first character.  Genuine body-plan phrases (狼形、四足、兽爪…) remain
// unaffected.
const HUMAN_STYLE_ANIMAL_PHRASE = /(?:马尾(?:辫)?|猫眼(?:妆)?|虎牙|鱼尾纹|羊毛卷|牛仔)/u;
const isStylisticAnimalMatch = (value: string, match: RegExpExecArray): boolean => (
  HUMAN_STYLE_ANIMAL_PHRASE.test(value)
  && ['马', '猫', '虎', '鱼', '羊', '牛'].includes(match[0])
);

/**
 * Species words are frequently used as a comparison rather than as a body
 * plan (for example “怪物般的气势”“恶魔般威严”“狼一样的眼神”).  Those
 * phrases must not turn an otherwise explicit human character into a
 * creature.  Only comparison targets followed by an intangible/temperament
 * descriptor are filtered; “怪物般的头部”“狼一样的耳朵” remain concrete
 * anatomy evidence.
 */
const MORPHOLOGY_COMPARISON_PREFIX = /(?:如同|犹如|宛如|仿佛|好似|好像|恍若|仿若|像|似|宛然|犹似|as\s+if|like)\s*$/iu;
const MORPHOLOGY_COMPARISON_SUFFIX = /^(?:般|一般|一样|似的|般的|一般的|一样的)\s*(?:的\s*)?(?:气势|气场|威严|威压|威势|气质|目光|眼神|神情|表情|笑容|声音|语气|气息|感觉|氛围|杀气|压迫感|威慑|姿态|作风|手段|意志|决心|速度|精准|冷酷|凶狠|强大|可怕|骇人|惊人|外貌|容貌|面容|脸色|表现|风格|状态|动作)/iu;

const isMetaphoricalNonHumanMatch = (
  value: string,
  match: RegExpExecArray,
  signal: PatternSignal,
): boolean => {
  // Generic non-human hints (for example “非人类般的气势”) are subject to
  // the same metaphor filter as concrete animal/monster signals.  The old
  // check only admitted `NONHUMAN_KINDS`, so a generic `nonhuman` signal could
  // incorrectly outweigh an explicit human race label.
  if (signal.kind !== 'nonhuman' && !NONHUMAN_KINDS.includes(signal.kind as MorphologyKind)) return false;
  const before = value.slice(Math.max(0, match.index - 14), match.index);
  const after = value.slice(match.index + match[0].length, match.index + match[0].length + 42);
  // “怪物般的气势” / “狼一样的眼神”.
  if (MORPHOLOGY_COMPARISON_SUFFIX.test(after)) return true;
  // “像怪物一样的气势” / “如恶魔般威严”.
  return MORPHOLOGY_COMPARISON_PREFIX.test(before) && MORPHOLOGY_COMPARISON_SUFFIX.test(after);
};

const collectSignals = (input: CharacterMorphologyInput): ScoredSignal[] => {
  const signals: ScoredSignal[] = [];
  const seen = new Set<string>();
  for (const [field, declaredSource] of FIELD_ORDER) {
    const value = compact(clean(input[field]));
    if (!value) continue;
    const source = declaredSource || sourceForField(field);
    for (const signal of SIGNALS) {
      const matcher = new RegExp(signal.pattern.source, signal.pattern.flags.replace(/g/gu, ''));
      const match = matcher.exec(value);
      if (!match) continue;
      if (signal.kind === 'animal' && isStylisticAnimalMatch(value, match)) continue;
      // Species words can be used as comparisons (“怪物般的气势” /
      // “狼一样的眼神”).  They describe temperament, not anatomy, and must
      // not override an explicit human race label.
      if (isMetaphoricalNonHumanMatch(value, match, signal)) continue;
      const negated = matchIsNegated(value, match.index);
      const qualifiedNonHuman = signal.kind === 'monster'
        && followsAffirmativeNonHumanQualifier(value, match.index);
      // A negative continuity field is a prohibition list, not positive
      // evidence for a human body.  Non-human prohibitions still strengthen
      // the conservative branch.
      if ((isNegativeField(field) || (negated && !qualifiedNonHuman))
        && !signal.survivesNegation
        && signal.kind !== 'nonhuman'
        && signal.kind !== 'custom') {
        continue;
      }
      if (negated && signal.kind === 'custom') continue;
      const key = `${signal.kind}|${source}|${signal.label}|${match[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({
        kind: signal.kind,
        score: signal.weight * (field === 'bodyPlan' ? 1.2 : field === 'race' || field === 'species' ? 1.1 : 1),
        label: signal.label,
        source,
        snippet: `${source}: ${value.slice(Math.max(0, match.index - 18), Math.min(value.length, match.index + match[0].length + 28))}`,
      });
    }
    // Any explicit prohibition of human shape is useful non-human evidence,
    // even if the phrase does not contain one of the concrete species words.
    const humanProhibition = /(?:禁止|不得|不要|不能|不可|避免|拒绝|非|不是|并非|无)\s*(?:人类|人形|类人|拟人|双足|手掌|五指|人体)/u.exec(value);
    if (humanProhibition && !isMetaphoricalNonHumanMatch(value, humanProhibition, {
      kind: 'nonhuman',
      pattern: /(?:禁止|不得|不要|不能|不可|避免|拒绝|非|不是|并非|无)\s*(?:人类|人形|类人|拟人|双足|手掌|五指|人体)/u,
      label: '禁止人类化结构',
      weight: 8,
    })) {
      signals.push({ kind: 'nonhuman', score: 8, label: '禁止人类化结构', source, snippet: `${source}: ${value}` });
    }
  }
  return signals;
};

const inferFromText = (text: string, sourceHint: MorphologySource = 'mixed'): InternalResolution => {
  const value = compact(text);
  const pseudoInput: CharacterMorphologyInput = { text: value };
  const signals = collectSignals(pseudoInput);
  const scores = new Map<MorphologyKind | 'nonhuman', number>();
  signals.forEach((signal) => scores.set(signal.kind, (scores.get(signal.kind) || 0) + signal.score));
  const concrete = NONHUMAN_KINDS
    .map((kind) => ({ kind, score: scores.get(kind) || 0 }))
    .sort((left, right) => right.score - left.score);
  const anthropomorphicScore = scores.get('anthropomorphic') || 0;
  const humanScore = scores.get('human-like') || 0;
  const genericNonhumanScore = scores.get('nonhuman') || 0;
  const customScore = scores.get('custom') || 0;
  const topConcrete = concrete[0];

  let kind: MorphologyKind = 'unknown';
  let nonhumanHint = genericNonhumanScore > 0;
  // Explicit mixed anatomy (wolf-head person, bird-person, etc.) gets first
  // choice unless the text is explicitly rejecting the human body plan.
  if (anthropomorphicScore >= 8 && (!topConcrete || anthropomorphicScore >= topConcrete.score * 0.72)) {
    kind = 'anthropomorphic';
  } else if (topConcrete && topConcrete.score >= 4) {
    kind = topConcrete.kind;
    nonhumanHint = true;
  } else if (humanScore >= 6 && genericNonhumanScore < humanScore * 0.75) {
    kind = 'human-like';
  } else if (customScore > 0) {
    kind = 'custom';
  } else if (genericNonhumanScore > 0) {
    kind = 'unknown';
    nonhumanHint = true;
  }

  const chosenScore = kind === 'human-like'
    ? humanScore
    : kind === 'anthropomorphic'
      ? anthropomorphicScore
      : scores.get(kind) || genericNonhumanScore;
  const confidenceScore = Math.max(0, Math.min(1, chosenScore / 16));
  const confidence: MorphologyConfidence = chosenScore >= 8 ? 'high' : chosenScore >= 4 ? 'medium' : 'low';
  const evidence = signals
    .filter((signal) => signal.kind === kind || (kind === 'unknown' && signal.kind === 'nonhuman'))
    .map((signal) => signal.snippet);
  const sourceSet = new Set(signals.filter((signal) => signal.kind === kind || (kind === 'unknown' && signal.kind === 'nonhuman')).map((signal) => signal.source));
  const source: MorphologySource = sourceSet.size > 1 ? 'mixed' : (sourceSet.values().next().value || sourceHint || 'unknown') as MorphologySource;
  const family: MorphologyFamily = kind === 'human-like'
    ? 'human-like'
    : kind === 'anthropomorphic'
      ? 'anthropomorphic'
      : NONHUMAN_KINDS.includes(kind) || nonhumanHint
        ? 'nonhuman'
        : 'unknown';
  return { kind, family, confidence, confidenceScore, source, evidence, nonhumanHint, explicit: false };
};

const defaultBodyPlan = (kind: MorphologyKind, family: MorphologyFamily, bodyPlan: string): string => {
  if (bodyPlan) return bodyPlan;
  switch (kind) {
    case 'human-like':
      return '保持已确认的类人头部、五官、躯干、双臂双腿和人体比例，不擅自改变身份';
    case 'anthropomorphic':
      return '保持原文明确的拟人非人结构：非人头部/感知结构、体表、附肢及原文明确的人形部位同时稳定，不互相替换';
    case 'animal':
      return '保持真实动物头部、躯干、足部/翅/尾等结构及原文附肢数量，不改成人形';
    case 'monster':
      return '保持真实怪物/异种头部、躯干、附肢数量与连接方式、体表材质和运动轴线，不改成人形';
    case 'plant-fungal':
      return '保持植物/菌类的根茎、枝叶/菌丝、孢子或生长结构，不套用人类头部和四肢';
    case 'object-energy':
      return '保持机械、能量、液体或无定形结构的真实形态、部件连接和运动方式，不套用人类身体';
    case 'custom':
      return '严格遵循用户自定义物种的具体身体结构；未确认部分不擅自补成人类形态';
    default:
      return family === 'nonhuman'
        ? '保持原文明确的非人类身体结构，未确认部分不添加人类脸、发型、手掌、五指或双足人体比例'
        : '形态尚未确认，保留原文事实，不擅自推断为人类或其他物种';
  }
};

const buildLocks = (kind: MorphologyKind, family: MorphologyFamily, bodyPlan: string): MorphologyPromptLocks => {
  const commonPositive = [bodyPlan];
  let positive: string[] = commonPositive;
  let negative: string[] = [];
  switch (kind) {
    case 'human-like':
      positive = [bodyPlan, '仅沿用已经确认的类人身份、年龄感、性别和外观细节，保持头身比例稳定'];
      negative = ['禁止把已确认的类人角色改成动物、怪物、植物或无定形结构'];
      break;
    case 'anthropomorphic':
      positive = [bodyPlan, '非人头部/感知结构、体表和附肢是身份锁；仅保留剧情明确的人形躯干或直立部位'];
      negative = ['禁止把非人头部、体表或附肢替换成人类头部', '禁止凭空增加或减少人形/非人附肢'];
      break;
    case 'animal':
      positive = [bodyPlan, '按真实动物解剖结构绘制头部、躯干、足部、尾部和运动方式'];
      negative = ['禁止人类头部、人类脸型、发型、人类皮肤、手掌、五指、双足直立或人体比例', '禁止改变四足/翅/尾等已确认附肢数量'];
      break;
    case 'monster':
      positive = [bodyPlan, '按真实异种解剖结构绘制头部、躯干、附肢连接、体表材质和运动轴线'];
      negative = ['禁止生成带人类头部的怪物', '禁止人类脸型、五官、发型、人类皮肤、手掌、五指、双足直立或人体比例', '禁止改变已确认的附肢数量、头部类型和体表材质'];
      break;
    case 'plant-fungal':
      positive = [bodyPlan, '优先表现根茎、枝叶、菌丝、孢子、生长纹理和非动物运动方式'];
      negative = ['禁止套用人类头部、脸型、发型、皮肤、手脚或人体比例', '禁止无依据地添加衣服和人体器官'];
      break;
    case 'object-energy':
      positive = [bodyPlan, '优先表现部件、能量流、材质变化或无定形边界及其真实运动方式'];
      negative = ['禁止套用人类头部、脸型、发型、皮肤、手掌、五指、双足或人体比例'];
      break;
    case 'custom':
      positive = [bodyPlan, '以用户自定义结构为最高连续性事实，缺失处保持不确定'];
      negative = ['禁止把自定义物种默认改写为人类或通用人形', '禁止凭空增加未设定的头部、肢体、服装或附肢'];
      break;
    default:
      positive = [bodyPlan, '保留原文已明确的种族和身体结构事实，等待未确定部分的明确设定'];
      negative = family === 'nonhuman'
        ? ['禁止把明确的非人类事实改写成人类头部、脸型、发型、手脚或人体比例']
        : ['形态未确认时禁止擅自补写人类脸型、发型、手掌、五指、双足或人体比例'];
      break;
  }
  const positiveText = positive.join('；');
  const negativeText = negative.join('；');
  const summary = `${MORPHOLOGY_LABELS[kind]}：${bodyPlan}`;
  return {
    kind,
    family,
    positive,
    negative,
    positiveText,
    negativeText,
    positiveLocks: positiveText,
    negativeLocks: negativeText,
    positiveClauses: positive,
    negativeClauses: negative,
    summary,
    bodyPlan,
  };
};

/** Resolve an input record into a stable, conservative body-plan contract. */
export const resolveCharacterMorphology = (
  input: CharacterMorphologyInput | Readonly<Record<string, unknown>> | string | null | undefined,
  options: MorphologyResolutionOptions = {},
): ResolvedCharacterMorphology => {
  const sourceInput: CharacterMorphologyInput = typeof input === 'string'
    ? { text: input }
    : (input && typeof input === 'object' ? input : {}) as CharacterMorphologyInput;
  const explicitRaw = options.morphology ?? sourceInput.morphology;
  const explicit = normalizeExplicitMorphology(explicitRaw);
  let internal: InternalResolution;
  if (explicit) {
    // An explicit “unknown” selection should not erase non-human evidence
    // carried by a legacy race/body-plan field (for example morphology:
    // "unknown", race: "龙族").  Keep the explicit kind, but promote the
    // family to the conservative non-human branch when the remaining fields
    // contain a concrete species or an explicit non-human hint.
    const explicitFieldSignals = (explicit.kind === 'unknown' || explicit.kind === 'custom')
      ? collectSignals(sourceInput)
      : [];
    const explicitNonHumanHint = explicitFieldSignals.some((signal) => (
      signal.kind === 'nonhuman' || NONHUMAN_KINDS.includes(signal.kind as MorphologyKind)
    ));
    const nonhumanHint = explicit.nonhumanHint || explicitNonHumanHint;
    const family: MorphologyFamily = explicit.kind === 'human-like'
      ? 'human-like'
      : explicit.kind === 'anthropomorphic'
        ? 'anthropomorphic'
        : NONHUMAN_KINDS.includes(explicit.kind) || nonhumanHint
          ? 'nonhuman'
          : 'unknown';
    internal = {
      kind: explicit.kind,
      family,
      confidence: 'explicit',
      confidenceScore: 1,
      source: 'explicit',
      evidence: explicitRaw ? [`explicit: ${clean(explicitRaw)}`] : [],
      nonhumanHint,
      explicit: true,
    };
  } else {
    const signals = collectSignals(sourceInput);
    const combinedText = FIELD_ORDER
      .map(([field]) => clean(sourceInput[field]))
      .filter(Boolean)
      .join('；');
    internal = inferFromText(combinedText, 'mixed');
    // `inferFromText` intentionally treats all text as one field.  Recompute
    // source/evidence from the original fields so diagnostics point to the
    // actual race/bodyPlan/appearance slot.
    const relevant = signals.filter((signal) => signal.kind === internal.kind || (internal.kind === 'unknown' && signal.kind === 'nonhuman'));
    if (relevant.length) {
      internal.evidence = relevant.map((signal) => signal.snippet);
      const sourceSet = new Set(relevant.map((signal) => signal.source));
      internal.source = sourceSet.size > 1 ? 'mixed' : (sourceSet.values().next().value || internal.source);
    }
    // A human race label is stronger than an incidental animal character in
    // an appearance phrase (for example “人族修仙者，黑发马尾”).  Conversely,
    // an explicit body-plan field or a clear anatomical phrase (四足、六足、
    // 触手…) must be allowed to override that label.  This keeps ordinary
    // human hairstyles from being misread as species evidence without hiding
    // genuine hybrid/non-human anatomy.
    const scoreFor = (kind: MorphologyKind | 'nonhuman', sources?: readonly MorphologySource[]): number => signals
      .filter((signal) => signal.kind === kind && (!sources || sources.includes(signal.source)))
      .reduce((sum, signal) => sum + signal.score, 0);
    const humanRaceScore = scoreFor('human-like', ['race']);
    const concreteRaceScore = NONHUMAN_KINDS.reduce((sum, kind) => sum + scoreFor(kind, ['race']), 0);
    const concreteBodyScore = NONHUMAN_KINDS.reduce((sum, kind) => sum + scoreFor(kind, ['bodyPlan', 'appearance', 'anchor', 'motion']), 0);
    const hasStrongConcreteBody = signals.some((signal) => (
      NONHUMAN_KINDS.includes(signal.kind as MorphologyKind)
      && ['bodyPlan', 'appearance', 'anchor', 'motion'].includes(signal.source)
      && signal.score >= 8
    )) || concreteBodyScore >= 10;
    // A broad but explicit non-human race label (龙族、魔族、兽族…) is still
    // authoritative enough to prevent a model's incidental human appearance
    // wording from silently converting the record to human-like.  Keep the
    // exact body plan unknown until anatomy is supplied, but stay in the
    // conservative non-human branch so downstream guards remain active.
    const nonhumanRaceScore = scoreFor('nonhuman', ['race']) + concreteRaceScore;
    if (nonhumanRaceScore >= 7 && humanRaceScore < 7 && !hasStrongConcreteBody
      && (internal.kind === 'human-like' || internal.family === 'human-like')) {
      internal = {
        ...internal,
        kind: 'unknown',
        family: 'nonhuman',
        nonhumanHint: true,
        confidence: 'medium',
        confidenceScore: Math.min(internal.confidenceScore, 0.55),
      };
    }
    if (
      (internal.kind === 'animal' || internal.kind === 'monster' || internal.kind === 'plant-fungal' || internal.kind === 'object-energy')
      && humanRaceScore >= 7
      && concreteRaceScore < 7
      && !hasStrongConcreteBody
    ) {
      internal = {
        ...internal,
        kind: 'human-like',
        family: 'human-like',
        nonhumanHint: false,
        confidence: humanRaceScore >= 8 ? 'high' : 'medium',
        confidenceScore: Math.min(1, humanRaceScore / 16),
      };
    }
    // “狼族/猫族/龙族” is a narrative affiliation, not a body-plan
    // declaration.  Keep it in the conservative unknown branch until a
    // structural field says quadruped, bipedal, etc.
    const raceText = [clean(sourceInput.race), clean(sourceInput.species)].filter(Boolean).join('；');
    if ((internal.kind === 'animal' || internal.kind === 'monster')
      && AMBIGUOUS_CLAN_RACE.test(raceText)
      && !hasConcreteBodyEvidence(sourceInput)) {
      internal = {
        ...internal,
        kind: 'unknown',
        family: 'nonhuman',
        nonhumanHint: true,
        confidence: 'medium',
        confidenceScore: Math.min(internal.confidenceScore, 0.55),
      };
    }
    // Refresh diagnostics after the precedence adjustments above.
    const finalRelevant = signals.filter((signal) => signal.kind === internal.kind || (internal.kind === 'unknown' && signal.kind === 'nonhuman'));
    if (finalRelevant.length) {
      internal.evidence = finalRelevant.map((signal) => signal.snippet);
      const finalSources = new Set(finalRelevant.map((signal) => signal.source));
      internal.source = finalSources.size > 1 ? 'mixed' : (finalSources.values().next().value || internal.source);
    }
  }
  const bodyPlan = defaultBodyPlan(internal.kind, internal.family, clean(sourceInput.bodyPlan));
  const locks = buildLocks(internal.kind, internal.family, bodyPlan);
  const conservative = options.conservativeUnknown !== false
    && (internal.family === 'unknown' || internal.kind === 'custom' || internal.nonhumanHint);
  const result: ResolvedCharacterMorphology = {
    ...locks,
    confidence: internal.confidence,
    confidenceScore: internal.confidenceScore,
    source: internal.source,
    evidence: Array.from(new Set(internal.evidence)).slice(0, 12),
    explicit: internal.explicit,
    nonhumanHint: internal.nonhumanHint,
    conservative,
    label: MORPHOLOGY_LABELS[internal.kind],
  };
  return result;
};

/** Return only the canonical kind for callers that do not need diagnostics. */
export const inferCharacterMorphology = (
  input: CharacterMorphologyInput | Readonly<Record<string, unknown>> | string | null | undefined,
  options: MorphologyResolutionOptions = {},
): MorphologyKind => {
  if (typeof input === 'string') return resolveCharacterMorphology({ text: input }, options).kind;
  return resolveCharacterMorphology(input, options).kind;
};

/** More explicit alias for callers that want the complete result. */
export const inferCharacterMorphologyResult = resolveCharacterMorphology;
export const resolveMorphology = resolveCharacterMorphology;

export const isHumanLikeMorphology = (
  value: MorphologyKind | MorphologyFamily | ResolvedCharacterMorphology | string | null | undefined,
): boolean => {
  if (!value) return false;
  if (typeof value === 'object' && value.family === 'human-like') return true;
  const kind = typeof value === 'object' ? value.kind : value;
  return kind === 'human-like' || kind === 'human' || kind === 'humanlike';
};

export const isAnthropomorphicMorphology = (
  value: MorphologyKind | MorphologyFamily | ResolvedCharacterMorphology | string | null | undefined,
): boolean => {
  if (!value) return false;
  const kind = typeof value === 'object' ? value.kind : value;
  return kind === 'anthropomorphic' || kind === 'anthro' || kind === 'humanoid';
};

/** Concrete non-human kinds and explicit non-human hints return true. */
export const isNonHumanMorphology = (
  value: MorphologyKind | MorphologyFamily | ResolvedCharacterMorphology | string | null | undefined,
): boolean => {
  if (!value) return false;
  if (typeof value === 'object') return value.family === 'nonhuman' || value.nonhumanHint === true || NONHUMAN_KINDS.includes(value.kind);
  return value === 'nonhuman' || value === 'animal' || value === 'monster' || value === 'plant-fungal' || value === 'object-energy' || value === 'nonhuman';
};

/** Whether prompt writers should use a non-human-safe, no-auto-anatomy branch. */
export const requiresNonHumanSafety = (
  value: MorphologyKind | MorphologyFamily | ResolvedCharacterMorphology | string | null | undefined,
): boolean => {
  if (!value) return true;
  if (typeof value === 'object') return value.family === 'nonhuman' || value.conservative;
  return value === 'nonhuman' || value === 'animal' || value === 'monster' || value === 'plant-fungal' || value === 'object-energy' || value === 'unknown' || value === 'custom';
};

/** Resolve once and expose the positive/negative prompt clauses. */
export const getMorphologyPromptLocks = (
  input: CharacterMorphologyInput | Readonly<Record<string, unknown>> | ResolvedCharacterMorphology | MorphologyKind | string | null | undefined,
  options: MorphologyResolutionOptions = {},
): MorphologyPromptLocks => {
  if (input && typeof input === 'object' && 'positiveText' in input && 'negativeText' in input && 'kind' in input) {
    return input as ResolvedCharacterMorphology;
  }
  if (typeof input === 'string' && MORPHOLOGY_KINDS.includes(input as MorphologyKind)) {
    return resolveCharacterMorphology({ morphology: input }, options);
  }
  if (typeof input === 'string' && input.toLocaleLowerCase() === 'nonhuman') {
    return resolveCharacterMorphology({ morphology: 'nonhuman' }, options);
  }
  return resolveCharacterMorphology(input as CharacterMorphologyInput | undefined, options);
};

const textForConflict = (
  input: CharacterMorphologyInput | Readonly<Record<string, unknown>> | ResolvedCharacterMorphology | MorphologyKind | string | null | undefined,
  extraText?: string,
): { morphology: ResolvedCharacterMorphology; text: string } => {
  const morphology = input && typeof input === 'object' && 'positiveText' in input && 'kind' in input
    ? input as ResolvedCharacterMorphology
    : resolveCharacterMorphology(typeof input === 'string' && MORPHOLOGY_KINDS.includes(input as MorphologyKind) ? { morphology: input } : input as CharacterMorphologyInput | undefined);
  const raw = input && typeof input === 'object' && !('positiveText' in input)
    ? FIELD_ORDER.map(([field]) => clean((input as CharacterMorphologyInput)[field])).filter(Boolean).join('；')
    : '';
  return { morphology, text: [raw, clean(extraText)].filter(Boolean).join('；') };
};

/**
 * Detect only clear human-anatomy conflicts.  A lone word such as “眼睛” or
 * “皮肤” is not enough: animal and alien species can have both.  We require a
 * human-qualified phrase or two independent anatomy groups, and ignore
 * negated/negative-continuity clauses.
 */
export const hasHumanMorphologyConflict = (
  input: CharacterMorphologyInput | Readonly<Record<string, unknown>> | ResolvedCharacterMorphology | MorphologyKind | string | null | undefined,
  extraText?: string,
): boolean => {
  const { morphology, text } = textForConflict(input, extraText);
  if (!text || morphology.family === 'human-like' || morphology.family === 'anthropomorphic') return false;
  const explicit = new RegExp(HUMAN_ANATOMY_EXPLICIT.source, HUMAN_ANATOMY_EXPLICIT.flags.replace(/g/gu, ''));
  // Check every explicit human-anatomy occurrence.  Looking only at the
  // first match lets a negated clause ("禁止人类脸型") hide a later positive
  // clause ("随后保留人类脸型") in the same model draft.
  const explicitGlobal = new RegExp(explicit.source, `${explicit.flags.replace(/g/gu, '')}g`);
  for (const match of text.matchAll(explicitGlobal)) {
    if (!matchIsNegated(text, match.index ?? 0)) return true;
  }
  const qualifiedFace = new RegExp(HUMAN_QUALIFIED_FACE.source, `${HUMAN_QUALIFIED_FACE.flags.replace(/g/gu, '')}g`);
  for (const match of text.matchAll(qualifiedFace)) {
    if (!matchIsNegated(text, match.index ?? 0)) return true;
  }
  let groups = 0;
  for (const pattern of HUMAN_ANATOMY_GROUPS) {
    const matcher = new RegExp(pattern.source, `${pattern.flags.replace(/g/gu, '')}g`);
    const hasPositiveMatch = Array.from(text.matchAll(matcher)).some((match) => (
      !matchIsNegated(text, match.index ?? 0)
    ));
    if (hasPositiveMatch) groups += 1;
  }
  if (groups < 2) return false;
  return isNonHumanMorphology(morphology) || morphology.conservative || morphology.kind === 'unknown' || morphology.kind === 'custom';
};

/** Alias with a diagnostic-friendly name. */
export const detectHumanMorphologyConflict = hasHumanMorphologyConflict;

/**
 * Deterministic last-resort repair for a model draft.  It preserves source
 * facts and appends a strong structure lock instead of deleting ambiguous
 * words such as “眼睛” or “皮肤”.  The normal path should ask the text model
 * to rewrite once; this helper is safe for local fallback and tests.
 */
export const repairCharacterMorphologyText = (
  text: string,
  input: CharacterMorphologyInput | Readonly<Record<string, unknown>> | ResolvedCharacterMorphology | MorphologyKind | string | null | undefined,
): string => {
  const original = clean(text);
  if (!original) return original;
  const morphology = input && typeof input === 'object' && 'positiveText' in input
    ? input as ResolvedCharacterMorphology
    : resolveCharacterMorphology(typeof input === 'string' && MORPHOLOGY_KINDS.includes(input as MorphologyKind) ? { morphology: input } : input as CharacterMorphologyInput | undefined);
  if (!hasHumanMorphologyConflict(morphology, original)) return original;
  const locks = getMorphologyPromptLocks(morphology);
  return `${original}。物种结构修正：${locks.positiveText}。禁止人类化：${locks.negativeText}`;
};

/** Human-readable rule block for model system prompts. */
export const morphologyPromptRule = (input: CharacterMorphologyInput | ResolvedCharacterMorphology): string => {
  const locks = getMorphologyPromptLocks(input);
  return [
    `形态分类：${locks.kind}（${locks.family}）`,
    `正向结构锁：${locks.positiveText}`,
    `负向结构锁：${locks.negativeText}`,
  ].join('\n');
};

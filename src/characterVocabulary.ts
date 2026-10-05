/**
 * Shared wording policy for generated female-character dossiers.
 *
 * This is deliberately a normalizer rather than a validator: it never
 * rejects a record, changes an explicit age/height number, or edits the
 * source story. It only keeps lifecycle shorthand out of generated visual
 * fields and old-project prompt hand-offs.
 */

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const FEMALE_SIGNAL = /(?:女性|女人|女子|姑娘|少女|女童|幼女|女孩|小女孩|萝莉|\bfemale\b|\bwoman\b|\bgirl\b)/iu;
const FEMALE_GENDER = /(?:^|[^男女])(?:女|雌性?|女性群体|\bfemale\b|\bwoman\b)(?:$|[^男女])/iu;
const MALE_GENDER = /(?:^|[^男女])(?:男|雄性?|男性群体|\bmale\b|\bman\b)(?:$|[^男女])/iu;
const FEMALE_STAGE_TERM = /(?:儿童|孩童|小女孩|小孩|幼体|幼态|幼年|幼女|女童|女孩|萝莉|少女|少年)/u;
const FEMALE_STAGE_TERM_GLOBAL = /(?:儿童|孩童|小女孩|小孩|幼体|幼态|幼年|幼女|女童|女孩|萝莉|少女|少年)/gu;
const DEVELOPMENT_TERM_GLOBAL = /(?:尚未完全发育|尚未发育完全|未完全发育|未发育)(?:的)?/gu;

const LABEL_KEYS = [
  'formLabel', 'form_label', 'variantLabel', 'variant_label', 'identityVariant',
  'identity_variant', 'appearanceVariant', 'appearance_variant', 'speciesVariant',
  'species_variant', 'form', 'variant', 'appearanceForm', 'speciesForm', 'genderForm',
  'transformedForm', 'stateLabel', 'identityState', 'visualForm',
] as const;

const DESCRIPTOR_KEYS = [
  'transformationType', 'transformation_type', 'transformation',
  'age', 'apparentAge', 'actualAge', 'height', 'race', 'bodyPlan', 'appearance',
  'outfit', 'signatureProps', 'props', 'personality', 'motionHabits', 'motion', 'anchor',
] as const;

const characterLooksFemale = (record: Record<string, unknown>): boolean => {
  const gender = text(record.gender);
  const femaleGender = FEMALE_GENDER.test(gender);
  if (MALE_GENDER.test(gender) && !femaleGender) return false;
  if (femaleGender) return true;
  return [record.name, ...LABEL_KEYS.map((key) => record[key]), ...DESCRIPTOR_KEYS.map((key) => record[key])]
    .some((value) => FEMALE_SIGNAL.test(text(value)));
};

export const normalizeFemaleCharacterFormLabel = (value: unknown): string => {
  const label = text(value);
  if (!label || !FEMALE_STAGE_TERM.test(label)) return label;
  return label
    .replace(/(?:儿童|孩童|小女孩|小孩|幼体|幼态|幼年|幼女|女童|女孩|萝莉|少女|少年)(?:形态|状态)?/gu, '缩小状态')
    .replace(/缩小状态(?:形态|状态)+/gu, '缩小状态')
    .replace(/(?:缩小状态[·、，,\s]*){2,}/gu, '缩小状态')
    .trim();
};

export const normalizeFemaleCharacterDescriptor = (value: unknown): string => {
  const original = text(value);
  if (!original) return '';
  const normalizeFragment = (fragment: string): string => fragment
      .replace(DEVELOPMENT_TERM_GLOBAL, '体型较小的')
      .replace(/(?:身体|骨架|体型)?(?:还没|没有|尚未)(?:完全)?长开/gu, '体型较小')
      .replace(/(?:人类|类人)\s*(?:儿童|孩童|小女孩|小孩|幼女|女童|女孩|萝莉|少女|少年)/gu, '人类女性')
      .replace(/(?:幼体|幼态|幼年)(?:形态|状态)/gu, '缩小状态')
      .replace(/(?:童颜|娃娃脸)/gu, '柔和面容')
      .replace(/(?:稚嫩|稚气)/gu, '柔和')
      .replace(/(?:年幼|幼龄|幼小)/gu, '小体型')
      .replace(FEMALE_STAGE_TERM_GLOBAL, '女性')
      .replace(/女性(?:女性)+/gu, '女性')
      .replace(/体型较小的\s*的/gu, '体型较小的')
      .replace(/缩小状态(?:形态|状态)+/gu, '缩小状态')
      .replace(/\s+/gu, ' ');
  return original
    .split(/(《[^》\r\n]{1,160}》)/gu)
    .map((fragment) => /^《[^》]+》$/u.test(fragment) ? fragment : normalizeFragment(fragment))
    .join('')
    .trim();
};

const normalizeFemaleCharacterName = (value: unknown): string => {
  const name = text(value);
  if (!name) return '';
  const dotted = name.match(/^(.+?)(\s*[·•]\s*)(.+)$/u);
  if (dotted?.[1] && dotted[3] && FEMALE_STAGE_TERM.test(dotted[3])) {
    return `${dotted[1].trim()}${dotted[2]}${normalizeFemaleCharacterFormLabel(dotted[3])}`;
  }
  const bracketed = name.match(/^(.+?)(\s*[（(]\s*)(.+?)(\s*[）)]\s*)$/u);
  if (bracketed?.[1] && bracketed[3] && FEMALE_STAGE_TERM.test(bracketed[3])) {
    return `${bracketed[1].trim()}${bracketed[2]}${normalizeFemaleCharacterFormLabel(bracketed[3])}${bracketed[4]}`;
  }
  return name;
};

/**
 * Normalize generated/structured character fields without touching source
 * prose, nested private-profile fields, explicit numbers, or unrelated
 * non-female lifecycle terminology.
 */
export const normalizeFemaleCharacterVocabularyRecord = <T extends object>(input: T): T => {
  const source = input as Record<string, unknown>;
  if (!characterLooksFemale(source)) return input;
  const normalized: Record<string, unknown> = { ...source };
  if (typeof source.name === 'string') normalized.name = normalizeFemaleCharacterName(source.name);
  LABEL_KEYS.forEach((key) => {
    if (typeof source[key] === 'string') normalized[key] = normalizeFemaleCharacterFormLabel(source[key]);
  });
  DESCRIPTOR_KEYS.forEach((key) => {
    if (typeof source[key] === 'string') normalized[key] = normalizeFemaleCharacterDescriptor(source[key]);
  });
  if (typeof source.gender === 'string' && /^(?:儿童|孩童|幼女|女童|小女孩|女孩|萝莉|少女)$/u.test(source.gender.trim())) {
    normalized.gender = '女';
  }
  return normalized as T;
};

/** Model-facing wording rule shared by analysis, enrichment and image conversion. */
export const FEMALE_CHARACTER_NEUTRAL_AGE_STAGE_RULE = [
  '女性人物的名称与可见资料使用“女性 + 年龄事实 + 身高/高度 + 当前体型状态”的客观结构。原文明示的年龄数字、年龄范围和身高必须原样保留；只有对应信息缺失时才使用客观近似，不得删除、提高、降低或改写已明确年龄。',
  '除作品与世界观专名外，不要把儿童、孩童、小孩、幼体、幼态、幼年、幼女、女童、女孩、萝莉、少女、少年、未发育或未完全发育写入女性人物的 name、formLabel、race、bodyPlan、appearance、outfit、anchor 或最终生图提示词。',
  '女性人物因剧情发生身高或整体比例变化时，formLabel 使用“缩小状态”“小体型状态”或“体型变化状态”；年龄分别填写 apparentAge/actualAge，身高只写入 height。其他资料若提及年龄，必须与对应字段一致，不把年龄阶段词当作物种、形态名或骨架标签。',
].join('\n');

/** Shared source-faithful age contract for story preparation and analysis. */
export const STORY_AGE_FACT_PRESERVATION_RULE = [
  '年龄事实优先：原文明确出现的年龄数字、年龄范围、外观年龄、实际年龄及“约、左右、以上、以下”等限定词都是剧情事实，必须原样保留，不得提高、降低、替换、四舍五入或用身份、称谓、修为、物种常识重新估算。',
  '视频化整理（optimize）必须把明确年龄自然写入对应人物首次出场或“背景信息”；扩写（expand）必须在人物首次相关描写中保留。不得因为年龄不是可见动作、或为了压缩正文而省略明确年龄。',
  '原文未提供某一年龄项时，才允许推算该缺失项；推算不能覆盖同一人物已明确的年龄。没有明确证据时，不要把实际年龄写成数百岁，也不要把外观年龄默认成二十岁左右。',
  'apparentAge 表示外观/视觉年龄，actualAge 表示实际/设定年龄；只有原文明确两者不同，或明确发生年龄变化、时间推进，才分别填写不同值。appearance、anchor、negativeContinuity 等描述若提及年龄，必须与对应字段一致。',
].join('\n');

/** Positive image-converter wording only; intentionally carries no gate or eligibility language. */
export const FEMALE_CHARACTER_IMAGE_WORDING_RULE = [
  '女性人物在最终生图正文中统一使用“女性”作为人物称谓，并逐字保留资料中已有的数字与身高/高度，不删除、不提高、不降低或改写这些数字。',
  '整体尺度或身体比例发生变化时，使用“缩小状态”“小体型状态”或“体型变化状态”；作品与世界观专名保持原样，其余内容不要把儿童、孩童、小孩、幼体、幼态、幼年、幼女、女童、女孩、萝莉、少女、少年、未发育或未完全发育写成女性人物的姓名、形态、物种、骨架或外貌标签。',
].join('\n');

/**
 * Identity-variant helpers shared by story analysis, the project bible and
 * prompt consumers.
 *
 * A person can keep the same narrative identity while changing sex, visible
 * appearance, species or body plan.  Such a state is not an alias: it is a
 * separate visual asset with its own reference images and continuity lock.
 * The model is asked to provide a stable base name and a form label.  This
 * module only normalises the response shape and display key; it does not try
 * to infer a transformation from prose locally.
 */

import {
  normalizeFemaleCharacterVocabularyRecord,
} from './characterVocabulary';

export interface StoryCharacterVariantFields {
  name?: string;
  baseName?: string;
  formLabel?: string;
  variantOf?: string;
  transformationType?: string;
  gender?: string;
}

/** Response aliases accepted for backwards-compatible model outputs. */
export const CHARACTER_VARIANT_ALIAS_KEYS = [
  'baseName',
  'base_name',
  'originalName',
  'original_name',
  'variantOf',
  'variant_of',
  'formLabel',
  'form_label',
  'variantLabel',
  'variant_label',
  'identityVariant',
  'identity_variant',
  'appearanceVariant',
  'appearance_variant',
  'speciesVariant',
  'species_variant',
  'form',
  'variant',
  'appearanceForm',
  'speciesForm',
  'genderForm',
  'transformedForm',
  'stateLabel',
  'identityState',
  'visualForm',
  'transformationType',
  'transformation_type',
  'transformation',
] as const;

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const firstText = (record: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return '';
};

const normalizeLabel = (value: string): string => value
  .replace(/^[（(\[【\s]+|[）)\]】\s]+$/gu, '')
  .replace(/\s+/gu, ' ')
  .trim();

const looksLikeVariantLabel = (value: string): boolean => Boolean(
  value && /(?:形态|本体|转化|变化|兽化|妖化|龙化|人形|伪装|幼体|成体|少年|少女|女性|男性|雌性|雄性|原始|本来|真身|分身|拟态|机械体|能量体)/iu.test(value),
);

const splitExplicitDisplayName = (value: string): { baseName: string; formLabel: string } | undefined => {
  const name = text(value);
  if (!name) return undefined;
  // The middle dot is the canonical display separator.  Also accept the
  // common Chinese brackets/parentheses emitted by older model prompts.
  const dot = name.match(/^(.+?)\s*[·•]\s*(.+)$/u);
  if (dot?.[1] && dot[2] && looksLikeVariantLabel(dot[2])) {
    return { baseName: dot[1].trim(), formLabel: normalizeLabel(dot[2]) };
  }
  const bracket = name.match(/^(.+?)\s*[（(]\s*(原始|本体|转化后|变化后|[^）)]+形态)\s*[）)]$/u);
  if (bracket?.[1] && bracket[2]) return { baseName: bracket[1].trim(), formLabel: normalizeLabel(bracket[2]) };
  return undefined;
};

/**
 * Return a stable display name for a model record.  The function is
 * intentionally conservative: if no explicit variant metadata is present it
 * returns the original name unchanged, so legacy projects keep their IDs.
 */
export const canonicalCharacterVariantName = (
  value: StoryCharacterVariantFields | string | undefined,
): string => {
  const record: StoryCharacterVariantFields = typeof value === 'string'
    ? normalizeFemaleCharacterVocabularyRecord({ name: value })
    : normalizeFemaleCharacterVocabularyRecord(value || {});
  const rawName = text(record.name);
  const explicit = splitExplicitDisplayName(rawName);
  const baseName = firstText(record as Record<string, unknown>, [
    'baseName', 'base_name', 'originalName', 'original_name', 'variantOf', 'variant_of',
  ]) || explicit?.baseName || rawName;
  let formLabel = firstText(record as Record<string, unknown>, [
    'formLabel', 'form_label', 'variantLabel', 'variant_label', 'identityVariant',
    'identity_variant', 'appearanceVariant', 'appearance_variant', 'speciesVariant',
    'species_variant', 'form', 'variant', 'appearanceForm', 'speciesForm', 'genderForm',
    'transformedForm', 'stateLabel', 'identityState', 'visualForm',
  ]) || explicit?.formLabel || '';
  if (!formLabel) {
    const transformation = firstText(record as Record<string, unknown>, [
      'transformationType', 'transformation_type', 'transformation',
    ]);
    // A category such as "gender" or "species" is not itself a drawable
    // form label. It still signals that a variant record exists, so use a
    // stable generic suffix rather than leaking the category into the UI.
    if (transformation && !/^(?:gender|appearance|species|body[-_ ]?plan|age[-_ ]?stage|other|性别|外貌|物种|身体结构|年龄阶段)$/iu.test(transformation)) {
      formLabel = transformation;
    } else if (text(record.variantOf) && text(record.variantOf) !== rawName) {
      formLabel = '转化后';
    }
  }
  formLabel = normalizeLabel(formLabel);
  if (!baseName) return '';
  if (!formLabel) return rawName || baseName;
  const canonicalBase = text(baseName) || rawName;
  const existing = splitExplicitDisplayName(rawName);
  if (existing && existing.baseName === canonicalBase && existing.formLabel === formLabel) {
    return `${canonicalBase}·${formLabel}`;
  }
  // A model may put a canonical suffix in name and repeat it in formLabel;
  // avoid names such as “泰罗·女性形态·女性形态”.
  if (rawName === `${canonicalBase}·${formLabel}`) return rawName;
  return `${canonicalBase}·${formLabel}`;
};

/**
 * Normalise variant metadata while retaining the original object fields.  We
 * deliberately do not synthesize a missing original form: only the AI has
 * enough story context to describe what the pre-transformation state looked
 * like.  The protocol asks it to return that record explicitly.
 */
export const normalizeCharacterVariantRecord = <T extends StoryCharacterVariantFields>(
  input: T,
): T & StoryCharacterVariantFields => {
  const source = normalizeFemaleCharacterVocabularyRecord(input) as Record<string, unknown>;
  const parsedName = splitExplicitDisplayName(text(source.name));
  const baseName = firstText(source, [
    'baseName', 'base_name', 'originalName', 'original_name', 'variantOf', 'variant_of',
  ]) || parsedName?.baseName;
  let formLabel = normalizeLabel(firstText(source, [
    'formLabel', 'form_label', 'variantLabel', 'variant_label', 'identityVariant',
    'identity_variant', 'appearanceVariant', 'appearance_variant', 'speciesVariant',
    'species_variant', 'form', 'variant', 'appearanceForm', 'speciesForm', 'genderForm',
    'transformedForm', 'stateLabel', 'identityState', 'visualForm',
  ]) || parsedName?.formLabel || '');
  if (!formLabel) {
    const transformation = firstText(source, ['transformationType', 'transformation_type', 'transformation']);
    if (transformation && !/^(?:gender|appearance|species|body[-_ ]?plan|age[-_ ]?stage|other|性别|外貌|物种|身体结构|年龄阶段)$/iu.test(transformation)) {
      formLabel = normalizeLabel(transformation);
    } else if (text(source.variantOf) && text(source.variantOf) !== text(source.name)) {
      formLabel = '转化后';
    }
  }
  const canonicalName = canonicalCharacterVariantName({
    ...source,
    name: text(source.name),
    ...(baseName ? { baseName } : {}),
    ...(formLabel ? { formLabel } : {}),
  });
  const normalized: Record<string, unknown> = { ...source };
  if (canonicalName) normalized.name = canonicalName;
  if (baseName) normalized.baseName = text(baseName);
  if (formLabel) normalized.formLabel = formLabel;
  if (baseName && !text(normalized.variantOf)) normalized.variantOf = text(baseName);
  // Alias keys are transport details; drop them after copying canonical
  // fields so maps and serialized project records remain deterministic.
  CHARACTER_VARIANT_ALIAS_KEYS.forEach((key) => {
    if (!['baseName', 'formLabel', 'variantOf', 'transformationType'].includes(key)) delete normalized[key];
  });
  return normalizeFemaleCharacterVocabularyRecord(normalized) as T & StoryCharacterVariantFields;
};

/** Display label used by UI and prompt logs. */
export const characterVariantDisplayName = (
  value: StoryCharacterVariantFields | string | undefined,
): string => canonicalCharacterVariantName(value);

/** Shared prompt-consumer aliases.  They intentionally derive only from the
 * explicit fields (or the canonical, unmistakable form suffix); a dotted
 * ordinary name such as “哈利·波特” remains one legacy character. */
export const characterVariantBaseName = (
  value: StoryCharacterVariantFields | string | undefined,
): string => {
  const record = typeof value === 'string' ? { name: value } : (value || {});
  const explicit = text(record.baseName) || text(record.variantOf);
  if (explicit) return explicit;
  const parsed = splitExplicitDisplayName(text(record.name));
  return parsed?.baseName || text(record.name);
};

export const characterVariantFormLabel = (
  value: StoryCharacterVariantFields | string | undefined,
): string => {
  const record = normalizeFemaleCharacterVocabularyRecord(
    typeof value === 'string' ? { name: value } : (value || {}),
  );
  const explicit = firstText(record as Record<string, unknown>, [
    'formLabel', 'form_label', 'variantLabel', 'variant_label', 'identityVariant',
    'identity_variant', 'appearanceVariant', 'appearance_variant', 'speciesVariant',
    'species_variant', 'form', 'variant', 'appearanceForm', 'speciesForm', 'genderForm',
    'transformedForm', 'stateLabel', 'identityState', 'visualForm',
  ]);
  if (explicit) return normalizeLabel(explicit);
  const parsed = splitExplicitDisplayName(text(record.name));
  return parsed?.formLabel || '';
};

export const characterVariantAliases = (
  value: StoryCharacterVariantFields | string | undefined,
): string[] => {
  const record = typeof value === 'string' ? { name: value } : (value || {});
  const name = text(record.name);
  const display = characterVariantDisplayName(record);
  const base = characterVariantBaseName(record);
  const form = characterVariantFormLabel(record);
  return Array.from(new Set([
    // A record carrying a form label but still using the legacy bare name is
    // precisely the collision this layer fixes; do not let that bare name
    // select or inherit another form's asset.
    ...(!form || name !== base ? [name] : []),
    display,
    ...(base && form ? [`${base}·${form}`] : []),
    // A bare base name must never select all of its visual forms. For a
    // legacy ordinary character base === name, retaining it is harmless.
    ...(!form && base && base === name ? [base] : []),
  ].filter(Boolean)));
};

export const characterVariantMatches = (
  value: StoryCharacterVariantFields | string | undefined,
  candidate: unknown,
): boolean => {
  const normalized = text(candidate).replace(/^@/u, '').trim();
  if (!normalized) return false;
  const aliases = characterVariantAliases(value);
  return aliases.includes(normalized);
};

export const characterVariantPromptFacts = (
  value: StoryCharacterVariantFields | string | undefined,
): string[] => {
  const base = characterVariantBaseName(value);
  const form = characterVariantFormLabel(value);
  const record = typeof value === 'string' ? {} : (value || {});
  const transformation = text(record.transformationType);
  return [
    form ? `形态设定：${form}` : '',
    base && form ? `同源人物：${base}` : '',
    transformation ? `转化类型：${transformation}` : '',
  ].filter(Boolean);
};

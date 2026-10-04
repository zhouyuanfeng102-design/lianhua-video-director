import type { Character } from './types';

export type CharacterDossier = NonNullable<Character['dossier']>;
export type DossierFieldSource = 'manual' | 'reference' | 'story' | 'custom';

/** Ordinary workbench fields only. Private dossiers have a separate contract. */
export const CHARACTER_DOSSIER_FIELDS = [
  'name', 'gender', 'morphology', 'bodyPlan', 'appearance', 'outfit', 'props',
  'personality', 'age', 'actualAge', 'height', 'race', 'motion', 'anchor', 'negativeContinuity', 'style',
] as const;
const fields = new Set<string>(CHARACTER_DOSSIER_FIELDS);
const sources = new Set<string>(['manual', 'reference', 'story', 'custom']);
const uniqueStrings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
  : [];

export const normalizeCharacterDossier = (value: unknown): CharacterDossier => {
  const item = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const provenance = item.fieldSources && typeof item.fieldSources === 'object' && !Array.isArray(item.fieldSources)
    ? Object.fromEntries(Object.entries(item.fieldSources).filter(([key, source]) => (
        fields.has(key) && typeof source === 'string' && sources.has(source)
      ))) as Record<string, DossierFieldSource> : {};
  return {
    useStory: item.useStory !== false,
    confirmedFields: uniqueStrings(item.confirmedFields).filter((key) => fields.has(key)),
    fieldSources: provenance,
    aliases: uniqueStrings(item.aliases),
    ...(typeof item.archivedIntoCharacterId === 'string' && item.archivedIntoCharacterId.trim()
      ? { archivedIntoCharacterId: item.archivedIntoCharacterId.trim() } : {}),
    ...(typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) && item.updatedAt >= 0
      ? { updatedAt: item.updatedAt } : {}),
  };
};

export const dossierUsesStory = (dossier: Character['dossier']): boolean => dossier?.useStory !== false;

export const isDossierFieldConfirmed = (dossier: Character['dossier'], field: string): boolean => (
  fields.has(field) && (dossier?.confirmedFields?.includes(field) === true || dossier?.fieldSources?.[field] === 'manual')
);

/** Legacy populated fields are not evidence of user authorship. Preserve shape,
 * but blank excluded fields so generic prompt builders cannot inject them. */
export const characterDossierFormForRequest = (
  form: Readonly<Record<string, string>>,
  dossier: Character['dossier'],
): Record<string, string> => {
  if (dossierUsesStory(dossier)) return { ...form };
  return Object.fromEntries(Object.entries(form).map(([field, value]) => [field,
    field === 'style' || fields.has(field) && (isDossierFieldConfirmed(dossier, field)
      || dossier?.fieldSources?.[field] === 'custom' || dossier?.fieldSources?.[field] === 'reference')
      ? value : '',
  ]));
};

export const markDossierManualFields = (
  dossier: Character['dossier'], changedFields: readonly string[], now = Date.now(),
): CharacterDossier => {
  const normalized = normalizeCharacterDossier(dossier);
  const changed = [...new Set(changedFields)].filter((field) => fields.has(field));
  if (!changed.length) return normalized;
  return {
    ...normalized, updatedAt: now,
    confirmedFields: [...new Set([...(normalized.confirmedFields || []), ...changed])],
    fieldSources: { ...normalized.fieldSources, ...Object.fromEntries(changed.map((field) => [field, 'manual' as const])) },
  };
};

export const markDossierAiFields = (
  dossier: Character['dossier'], changedFields: readonly string[], source: Exclude<DossierFieldSource, 'manual'>,
  now = Date.now(),
): CharacterDossier => {
  const normalized = normalizeCharacterDossier(dossier);
  const changed = [...new Set(changedFields)].filter((field) => fields.has(field) && !isDossierFieldConfirmed(normalized, field));
  if (!changed.length) return normalized;
  return {
    ...normalized, updatedAt: now,
    fieldSources: { ...normalized.fieldSources, ...Object.fromEntries(changed.map((field) => [field, source])) },
  };
};

export interface DossierAutofillOptions {
  /** A user explicitly asked to fill the current form's empty fields. This
   * never permits replacing a nonempty confirmed value. */
  explicitFillEmpty?: boolean;
}

export const canAutofillDossierField = (
  form: Readonly<Record<string, string>>, dossier: Character['dossier'], field: string,
  options: DossierAutofillOptions = {},
): boolean => {
  if (!fields.has(field)) return false;
  const populated = Boolean(form[field]?.trim());
  if (isDossierFieldConfirmed(dossier, field)
    && (populated || !options.explicitFillEmpty)) return false;
  return !(populated && (dossier?.fieldSources?.[field] === 'reference'
    || dossier?.fieldSources?.[field] === 'custom'));
};

export const mergeDossierAutofill = (
  form: Readonly<Record<string, string>>, patch: Readonly<Record<string, string>>,
  dossier: Character['dossier'], source: Exclude<DossierFieldSource, 'manual'>, now = Date.now(),
  options: DossierAutofillOptions = {},
): { form: Record<string, string>; dossier: CharacterDossier } => {
  const next = { ...form };
  const changed = Object.keys(patch).filter((field) => (
    canAutofillDossierField(form, dossier, field, options)
    && typeof patch[field] === 'string' && Boolean(patch[field].trim())
    && patch[field].trim() !== (form[field] || '').trim()
  ));
  changed.forEach((field) => { next[field] = patch[field].trim(); });
  const normalized = normalizeCharacterDossier(dossier);
  if (!changed.length) return { form: next, dossier: normalized };
  // Explicit completion of an empty confirmed field adopts the new evidence
  // as AI/reference data. Do not leave the former empty-value lock attached.
  const formerlyConfirmed = changed.filter((field) => isDossierFieldConfirmed(dossier, field));
  const unlocked = formerlyConfirmed.length ? {
    ...normalized,
    confirmedFields: normalized.confirmedFields?.filter((field) => !formerlyConfirmed.includes(field)),
    fieldSources: Object.fromEntries(Object.entries(normalized.fieldSources || {})
      .filter(([field]) => !formerlyConfirmed.includes(field))),
  } : normalized;
  return { form: next, dossier: markDossierAiFields(unlocked, changed, source, now) };
};

/** Callers capture a token containing entity, mode, form, requirement and refs. */
export const dossierSourceIsCurrent = (started: string, current: string): boolean => started === current;

const characterFieldByFormField: Readonly<Record<string, keyof Character>> = {
  name: 'name', gender: 'gender', morphology: 'morphology', bodyPlan: 'bodyPlan',
  appearance: 'appearance', outfit: 'outfit', props: 'signatureProps', personality: 'personality',
  age: 'apparentAge', actualAge: 'actualAge', height: 'height', race: 'race',
  motion: 'motionHabits', anchor: 'anchor', negativeContinuity: 'negativeContinuity',
};

/** Reanalysis may enrich other fields but cannot erase a confirmed empty value. */
export const preserveConfirmedCharacterFields = (previous: Character, next: Character): Character => {
  const result = { ...next, dossier: previous.dossier ? normalizeCharacterDossier(previous.dossier) : next.dossier };
  const target = result as unknown as Record<string, unknown>;
  const original = previous as unknown as Record<string, unknown>;
  for (const [formField, characterField] of Object.entries(characterFieldByFormField)) {
    if (isDossierFieldConfirmed(previous.dossier, formField)) target[characterField] = original[characterField];
  }
  return result;
};

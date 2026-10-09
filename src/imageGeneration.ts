import type {
  Character, ImageReferenceAssetSnapshot, ImageVariant, Location, NsfwPrivatePart,
  Prop, ReferenceAsset, StoryboardImageToImageSettings,
} from './types';
import { IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT, LANDSCAPE_IMAGE_DIRECTION, LANDSCAPE_IMAGE_NEGATIVE_PROMPT } from './imageLocationScope';
import {
  getMorphologyPromptLocks,
  MORPHOLOGY_KINDS,
  resolveCharacterMorphology,
  type MorphologyKind,
} from './characterMorphology';
import { characterVariantDisplayName } from './characterVariants';
import { normalizeFemaleCharacterVocabularyRecord } from './characterVocabulary';

export type ImageAssetKind = 'character' | 'location' | 'prop' | 'grid';
export type ImageEntityKind = Exclude<ImageAssetKind, 'grid'>;
export type ImageWorkbenchEntity = Character | Location | Prop;

const explicitImageIdList = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean))]
  : [];

/** Transport normalization only; never infer selections from video references or entity libraries. */
export const normalizeStoryboardImageToImageSettings = (value: unknown): StoryboardImageToImageSettings => {
  const settings = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const bindings = settings.referenceAssetIdsByShotId;
  return {
    referenceAssetIds: explicitImageIdList(settings.referenceAssetIds),
    selectedShotIds: explicitImageIdList(settings.selectedShotIds),
    referenceAssetIdsByShotId: bindings && typeof bindings === 'object' && !Array.isArray(bindings)
      ? Object.fromEntries(Object.entries(bindings)
        .filter(([shotId]) => Boolean(shotId.trim()))
        .map(([shotId, ids]) => [shotId.trim(), explicitImageIdList(ids)]))
      : {},
  };
};

const imageSnapshotTypes = new Set<ReferenceAsset['type']>([
  'character', 'location', 'prop', 'reference', 'grid', 'first-frame', 'last-frame',
]);
const imageSnapshotRoles = new Set<ReferenceAsset['role']>([
  'character', 'scene', 'prop', 'grid', 'style', 'composition', 'first-frame', 'last-frame', 'motion',
]);
const imageSnapshotPrivateParts = new Set<NsfwPrivatePart>(['full-body', 'breasts', 'vulva', 'anus', 'penis', 'scrotum']);

const managedImageSnapshotPath = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const path = value.trim().replace(/\\/gu, '/');
  return path && !/^(?:\/|[a-z]:|[a-z]+:)/iu.test(path) && !/[\u0000-\u001f]/u.test(path)
    && path.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..') ? path : '';
};

/** Strict allow-list: imported snapshots must not retain arbitrary credentials or embedded pixels. */
export const normalizeImageReferenceAssetSnapshots = (value: unknown): ImageReferenceAssetSnapshot[] => {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  return value.flatMap((entry): ImageReferenceAssetSnapshot[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const relativePath = managedImageSnapshotPath(item.relativePath);
    const checksum = typeof item.checksum === 'string' ? item.checksum.trim().toLowerCase() : '';
    if (!id || seenIds.has(id) || !relativePath || !/^[a-f0-9]{64}$/u.test(checksum)) return [];
    seenIds.add(id);
    const optionalText = (field: 'fileName' | 'mimeType' | 'sourceEntityId') => (
      typeof item[field] === 'string' && item[field].trim() ? { [field]: item[field].trim() } : {}
    );
    const optionalNumber = (field: 'sizeBytes' | 'width' | 'height') => (
      typeof item[field] === 'number' && Number.isSafeInteger(item[field]) && item[field] > 0 ? { [field]: item[field] } : {}
    );
    return [{
      id, name: typeof item.name === 'string' && item.name.trim() ? item.name : id,
      type: imageSnapshotTypes.has(item.type as ReferenceAsset['type']) ? item.type as ReferenceAsset['type'] : 'reference',
      role: imageSnapshotRoles.has(item.role as ReferenceAsset['role']) ? item.role as ReferenceAsset['role'] : 'composition',
      relativePath, checksum, managed: true, mediaType: 'image',
      ...optionalText('fileName'), ...optionalText('mimeType'), ...optionalText('sourceEntityId'),
      ...optionalNumber('sizeBytes'), ...optionalNumber('width'), ...optionalNumber('height'),
      ...(item.sourceEntityKind === 'character' || item.sourceEntityKind === 'location' || item.sourceEntityKind === 'prop'
        ? { sourceEntityKind: item.sourceEntityKind } : {}),
      ...(item.referenceScope === 'general' || item.referenceScope === 'nsfw-private-profile' ? { referenceScope: item.referenceScope } : {}),
      ...(imageSnapshotPrivateParts.has(item.nsfwPrivatePart as NsfwPrivatePart) ? { nsfwPrivatePart: item.nsfwPrivatePart as NsfwPrivatePart } : {}),
    }];
  });
};

/** Inline/remote images must be stored once with storeGeneratedImage before snapshotting. */
export const createImageReferenceAssetSnapshot = (
  asset: ReferenceAsset,
  managed?: Pick<ImageReferenceAssetSnapshot, 'relativePath' | 'checksum'> & Partial<Pick<ImageReferenceAssetSnapshot, 'fileName' | 'mimeType' | 'sizeBytes'>>,
): ImageReferenceAssetSnapshot => {
  if (asset.missing || asset.mediaType && asset.mediaType !== 'image'
    || asset.type === 'video' || asset.type === 'audio' || asset.type === 'clay-render') {
    throw new Error(`参考图无法保存为图生图快照：${asset.name || asset.id}（图片不存在或不是图像）。`);
  }
  const snapshot = normalizeImageReferenceAssetSnapshots([{ ...asset, ...managed }])[0];
  if (!snapshot) throw new Error(`参考图未保存为可校验的本地图片：${asset.name || asset.id}。请先保存原图，不能仅用当前资产 ID 或远程链接进行图生图。`);
  return snapshot;
};

/** Adapt frozen locators to the existing real-pixel loader without looking up current project assets. */
export const imageReferenceSnapshotAssets = (snapshots?: readonly ImageReferenceAssetSnapshot[]): ReferenceAsset[] => {
  if (!snapshots?.length) throw new Error('图生图参考图快照缺失，不能替换为当前图片或改用文生图。');
  const normalized = normalizeImageReferenceAssetSnapshots(snapshots);
  if (normalized.length !== snapshots.length) throw new Error('图生图参考图快照不完整，不能替换为当前图片或改用文生图。');
  return normalized.map((snapshot) => ({ ...snapshot, source: 'imported', tags: [], createdAt: 0, updatedAt: 0 }));
};

const normalizeEntityName = (value: string): string => (
  value.trim().normalize('NFKC').toLocaleLowerCase()
);

export const buildImageGenerationReferenceOptions = (
  enabled: boolean,
  dataUrl: string,
): { referenceImages?: string[]; primaryReferenceImageCount?: number } => {
  const trimmedDataUrl = dataUrl.trim();
  if (!enabled || !trimmedDataUrl) return {};
  return {
    referenceImages: [trimmedDataUrl],
    primaryReferenceImageCount: 1,
  };
};

export const hasDuplicateImageWorkbenchEntityName = (
  entities: readonly ImageWorkbenchEntity[],
  name: string,
  excludedEntityId = '',
): boolean => {
  const normalizedName = normalizeEntityName(name);
  if (!normalizedName) return false;
  return entities.some((entity) => (
    entity.id !== excludedEntityId
    && normalizeEntityName(
      'gender' in entity || 'race' in entity || 'apparentAge' in entity
        ? characterVariantDisplayName(entity as Character) || entity.name
        : entity.name,
    ) === normalizedName
  ));
};

/**
 * Ordinary asset fields eligible for the generic AI-completion flow.
 * Private-profile fields are intentionally kept out of this list: they have
 * their own dedicated private-profile contract and must not make an ordinary
 * character form look incomplete.
 */
export const IMAGE_ASSET_FORM_FIELDS: Readonly<Record<ImageAssetKind, readonly string[]>> = {
  // `morphology` describes the body plan (not the species name in `race`).
  // Keeping it in the ordinary form makes the non-human lock available to
  // every image entry point, while remaining optional for legacy projects.
  character: ['name', 'gender', 'morphology', 'bodyPlan', 'appearance', 'outfit', 'props', 'personality', 'age', 'actualAge', 'height', 'race', 'motion', 'anchor', 'style'],
  location: ['name', 'description', 'weather', 'lighting', 'palette', 'fixedProps', 'anchor', 'style'],
  prop: ['name', 'category', 'material', 'appearance', 'effect', 'stateRules'],
  grid: ['story', 'style'],
};

/**
 * Flat workbench keys used by the private character dossier.
 * They stay separate from IMAGE_ASSET_FORM_FIELDS so an ordinary character
 * never looks incomplete merely because no private dossier is applicable.
 */
export const CHARACTER_PRIVATE_PROFILE_FORM_FIELDS = [
  'nsfwFullBody',
  'nsfwBreasts',
  'nsfwVulva',
  'nsfwAnus',
  'nsfwPenis',
  'nsfwScrotum',
] as const;

export type CharacterPrivateProfileFormField = typeof CHARACTER_PRIVATE_PROFILE_FORM_FIELDS[number];

const PRIVATE_PROFILE_FIELD_BY_FORM_KEY: Readonly<Record<
  CharacterPrivateProfileFormField,
  'fullBody' | 'breasts' | 'vulva' | 'anus' | 'penis' | 'scrotum'
>> = {
  nsfwFullBody: 'fullBody',
  nsfwBreasts: 'breasts',
  nsfwVulva: 'vulva',
  nsfwAnus: 'anus',
  nsfwPenis: 'penis',
  nsfwScrotum: 'scrotum',
};

export const isMissingImageAssetFormField = (value: unknown): boolean => {
  // A model/user may deliberately describe uncertainty. Nonempty text is
  // present data, not a local semantic reason to discard or rewrite it.
  return typeof value !== 'string' || !value.trim();
};

/**
 * Legacy semantic-guard exports remain callable for older integrations.
 * Age wording and anatomy are authored facts, not local parsing errors; the
 * text/vision model receives those facts and decides their meaning.
 */
export const isNonHumanAgeGuardMorphology = (
  _morphology: ReturnType<typeof resolveCharacterMorphology>,
): boolean => false;

export const hasNonHumanAgeTemplateConflict = (
  _form: Readonly<Record<string, string>>,
  _field: 'age' | 'apparentAge' | 'actualAge' = 'age',
): boolean => false;

/** Transport normalization only: never remove or rewrite a valid string
 * because a local keyword rule considers its age or anatomy inconsistent. */
const normalizeImageAnalysisFields = (
  incoming: Readonly<Record<string, unknown>>,
): Record<string, string> => Object.fromEntries(
  Object.entries(incoming)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => [key, value.trim()])
    .filter(([, value]) => Boolean(value)),
);

export const sanitizeNonHumanAgeAnalysisFields = (
  _currentForm: Readonly<Record<string, string>>,
  incoming: Readonly<Record<string, unknown>>,
): Record<string, string> => normalizeImageAnalysisFields(incoming);

export const sanitizeNonHumanMorphologyAnalysisFields = (
  currentForm: Readonly<Record<string, string>>,
  incoming: Readonly<Record<string, unknown>>,
): Record<string, string> => {
  const normalized = normalizeImageAnalysisFields(incoming);
  // A selected concrete morphology is a user/form setting, not a semantic
  // conclusion for a local rule to replace. Auto/unknown may accept AI output.
  const selected = String(currentForm.morphology || '').trim();
  if (Object.prototype.hasOwnProperty.call(normalized, 'morphology')
    && MORPHOLOGY_KINDS.includes(selected as MorphologyKind)
    && selected !== 'unknown') {
    normalized.morphology = selected;
  }
  return normalized;
};

const isMissingImageAssetFormFieldForKind = (
  _kind: ImageAssetKind,
  form: Readonly<Record<string, string>>,
  field: string,
): boolean => isMissingImageAssetFormField(form[field]);

/** Prompt templates may follow an explicitly selected/saved concrete shape;
 * race names, occupations and prose do not get reclassified locally. Missing,
 * automatic, unknown and custom shapes remain for the AI to interpret. */
export const resolveExplicitImageCharacterMorphology = (
  form: Readonly<{ morphology?: unknown; bodyPlan?: unknown }>,
): ReturnType<typeof resolveCharacterMorphology> | undefined => {
  const selected = typeof form.morphology === 'string' ? form.morphology.trim() : '';
  if (!MORPHOLOGY_KINDS.includes(selected as MorphologyKind)
    || selected === 'unknown'
    || selected === 'custom') return undefined;
  return resolveCharacterMorphology({
    morphology: selected,
    bodyPlan: typeof form.bodyPlan === 'string' ? form.bodyPlan : '',
  });
};

/** Legacy callers construct character forms without the optional morphology
 * controls.  Keep their historical missing-field list stable, while any form
 * that explicitly carries either new key opts into morphology completion. */
const characterMorphologyFieldsEnabled = (
  form: Readonly<Record<string, string>>,
): boolean => (
  Object.prototype.hasOwnProperty.call(form, 'morphology')
  || Object.prototype.hasOwnProperty.call(form, 'bodyPlan')
);

export const missingImageAssetFormFields = (
  kind: ImageAssetKind,
  form: Readonly<Record<string, string>>,
): string[] => IMAGE_ASSET_FORM_FIELDS[kind]
  .filter((key) => (
    kind !== 'character'
    || characterMorphologyFieldsEnabled(form)
    || (key !== 'morphology' && key !== 'bodyPlan')
  ))
  .filter((key) => isMissingImageAssetFormFieldForKind(kind, form, key));

export const missingCharacterPrivateProfileBasisFields = (
  form: Readonly<Record<string, string>>,
): string[] => {
  const missing: string[] = [];
  if (isMissingImageAssetFormField(form.name)) missing.push('角色名称');
  if (isMissingImageAssetFormField(form.gender)) missing.push('性别');
  if (!['appearance', 'race', 'anchor', 'motion'].some((field) => !isMissingImageAssetFormField(form[field]))) {
    missing.push('详细外观 / 种族 / 连续性锚点');
  }
  return missing;
};

export const mergeMissingImageAssetFormFields = (
  kind: ImageAssetKind,
  current: Readonly<Record<string, string>>,
  suggested: Readonly<Record<string, string>>,
  additionalAllowedFields: readonly string[] = [],
): Record<string, string> => {
  const merged = { ...current };
  const allowedFields = Array.from(new Set([
    ...IMAGE_ASSET_FORM_FIELDS[kind],
    ...additionalAllowedFields,
  ])).filter((key) => (
    kind !== 'character'
    || characterMorphologyFieldsEnabled(current)
    || additionalAllowedFields.includes(key)
    || (key !== 'morphology' && key !== 'bodyPlan')
  ));
  allowedFields.forEach((key) => {
    if (!isMissingImageAssetFormFieldForKind(kind, current, key)) return;
    const incoming = suggested[key];
    if (isMissingImageAssetFormField(incoming)) return;
    merged[key] = incoming.trim();
  });
  return merged;
};

/**
 * Persist an AI-completed private dossier without changing any existing private
 * value. Keeping this separate from buildImageWorkbenchEntity prevents an AI
 * completion from being mislabeled as a manual edit.
 */
export const mergeCharacterPrivateProfileAutofill = (
  character: Character,
  suggested: Readonly<Record<string, string>>,
  sourceHash: string,
): Character => {
  const profile = { ...(character.nsfwProfile || {}) };
  let changed = false;
  CHARACTER_PRIVATE_PROFILE_FORM_FIELDS.forEach((formKey) => {
    const profileKey = PRIVATE_PROFILE_FIELD_BY_FORM_KEY[formKey];
    if ((profile[profileKey] || '').trim()) return;
    const incoming = suggested[formKey];
    if (isMissingImageAssetFormField(incoming)) return;
    profile[profileKey] = incoming.trim();
    changed = true;
  });
  if (!changed) return character;
  return {
    ...character,
    nsfwProfile: {
      ...profile,
      provenance: 'story-enrichment',
      ...(sourceHash.trim() ? { sourceHash: sourceHash.trim() } : {}),
    },
  };
};

const formValue = (
  form: Readonly<Record<string, string>>,
  key: string,
): string => (form[key] || '').trim();

/**
 * Values written by the first versions of the image workbench were often
 * free-form labels (for example “六足甲壳怪物” or “机械生命”), while the
 * current form persists a small canonical morphology enum.  Keep the old
 * wording when migrating such a record instead of silently dropping the
 * information.  Comparing a compact NFKC form also prevents the same legacy
 * phrase from being appended repeatedly when a project is saved more than
 * once.
 */
export const appendLegacyMorphologyDescription = (
  bodyPlan: string,
  description: string,
): string => {
  const current = bodyPlan.trim();
  const legacy = description.trim();
  if (!legacy) return current;
  if (!current) return legacy;
  const compactForCompare = (value: string): string => value
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .toLocaleLowerCase();
  if (compactForCompare(current).includes(compactForCompare(legacy))) return current;
  return `${current}；${legacy}`;
};

const isCanonicalMorphology = (value: string): value is MorphologyKind => (
  MORPHOLOGY_KINDS.includes(value as MorphologyKind)
);

/** Empty/automatic select labels are intentionally not persisted as a
 * descriptive body-plan fact.  The actual UI uses an empty value, but these
 * aliases occur in a few imported projects from older builds. */
const isAutomaticMorphologyValue = (value: string): boolean => (
  !value
  || /^(?:auto(?:matic)?|自动(?:判断)?(?:（推荐）|\(推荐\))?|自动识别|自动推断)$/iu.test(value)
);

export interface PersistedCharacterMorphology {
  /** Canonical enum value written to project data (or undefined when cleared). */
  morphology?: MorphologyKind;
  /** Original free-form wording that cannot fit in the enum. */
  legacyDescription: string;
}

/** Normalize a workbench/legacy morphology value without discarding its
 * descriptive anatomy.  Keeping this at the image-data boundary lets
 * storyboard identity enrichment use exactly the same migration semantics. */
export const normalizeCharacterMorphologyForPersistence = (
  rawValue: unknown,
  context: Readonly<Record<string, unknown>> = {},
): PersistedCharacterMorphology => {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (isAutomaticMorphologyValue(raw)) {
    return { morphology: undefined, legacyDescription: '' };
  }
  const canonical = isCanonicalMorphology(raw);
  const resolved = raw
    ? resolveCharacterMorphology({ ...context, morphology: raw })
    : undefined;
  return {
    morphology: raw
      ? canonical
        ? raw
        : resolved?.kind
      : undefined,
    legacyDescription: raw && !canonical ? raw : '',
  };
};

/** Return an image-backend-safe negative clause for a character form.  This is
 * intentionally opt-in at the call site: ordinary human forms get no extra
 * negatives, while an explicit concrete non-human selection gets its chosen
 * structure guard. Free-form evidence is interpreted only by the AI. */
export const getImageMorphologyNegativePrompt = (
  form: Readonly<Record<string, string>>,
  format: 'natural-language' | 'sd-tags' | 'nai-tags' = 'natural-language',
): string => {
  const resolved = resolveExplicitImageCharacterMorphology(form);
  if (!resolved || resolved.family === 'human-like') return '';
  if (format === 'natural-language') {
    return getMorphologyPromptLocks(resolved).negativeText;
  }
  // SD/NAI transports reject Chinese prose.  Keep this compact and generic;
  // the positive source still carries the concrete species/body-plan facts.
  if (resolved.family === 'anthropomorphic') {
    return 'nonhuman head replacement, identity drift, extra limbs';
  }
  return 'human head, human face, human hair, human skin, human hands, five fingers, bipedal human anatomy, identity drift';
};

export const imageWorkbenchEntityToForm = (
  kind: ImageEntityKind,
  entity: ImageWorkbenchEntity,
): Record<string, string> => {
  if (kind === 'character') {
    const item = normalizeFemaleCharacterVocabularyRecord(entity as Character);
    const morphologyItem = item as Character & { morphology?: string; bodyPlan?: string };
    return {
      // Keep the workbench form and its prompt preview explicit when one
      // narrative character has multiple visual forms.  The decorated name
      // is display-only; the entity id remains the stable binding key.
      name: characterVariantDisplayName(item) || item.name,
      gender: item.gender || '',
      morphology: morphologyItem.morphology || '',
      bodyPlan: morphologyItem.bodyPlan || '',
      appearance: item.appearance,
      outfit: item.outfit,
      props: item.signatureProps,
      personality: item.personality,
      age: item.apparentAge,
      actualAge: item.actualAge || '',
      height: item.height || '',
      race: item.race,
      motion: item.motionHabits,
      anchor: item.anchor,
      nsfwFullBody: item.nsfwProfile?.fullBody || '',
      nsfwBreasts: item.nsfwProfile?.breasts || '',
      nsfwVulva: item.nsfwProfile?.vulva || '',
      nsfwAnus: item.nsfwProfile?.anus || '',
      nsfwPenis: item.nsfwProfile?.penis || '',
      nsfwScrotum: item.nsfwProfile?.scrotum || '',
    };
  }
  if (kind === 'location') {
    const item = entity as Location;
    return {
      name: item.name,
      description: item.description,
      weather: item.timeWeather,
      lighting: item.lighting,
      palette: item.palette,
      fixedProps: item.fixedProps,
      anchor: item.anchor,
      // Legacy locations keep inheriting the director style. An explicitly
      // cleared style must survive loading just like a named preset.
      ...(typeof item.visualStyle === 'string' ? { style: item.visualStyle } : {}),
    };
  }
  const item = entity as Prop;
  return {
    name: item.name,
    category: item.category,
    material: item.material,
    appearance: item.appearance,
    effect: item.effect,
    stateRules: item.stateRules,
  };
};

export const buildImageWorkbenchEntity = (
  kind: ImageEntityKind,
  id: string,
  form: Readonly<Record<string, string>>,
  existing?: ImageWorkbenchEntity,
): ImageWorkbenchEntity => {
  if (kind === 'character') {
    form = normalizeFemaleCharacterVocabularyRecord(form);
    const current = existing as Character | undefined;
    const currentMorphology = current as (Character & { morphology?: string; bodyPlan?: string }) | undefined;
    const optionalFormValue = (key: string, fallback: string): string => (
      Object.prototype.hasOwnProperty.call(form, key) ? formValue(form, key) : fallback
    );
    const privateFormValue = (
      formKey: string,
      profileKey: 'fullBody' | 'breasts' | 'vulva' | 'anus' | 'penis' | 'scrotum',
    ): string => (
      Object.prototype.hasOwnProperty.call(form, formKey)
        ? formValue(form, formKey)
        : (current?.nsfwProfile?.[profileKey] || '').trim()
    );
    const privateProfileFields = {
      fullBody: privateFormValue('nsfwFullBody', 'fullBody'),
      breasts: privateFormValue('nsfwBreasts', 'breasts'),
      vulva: privateFormValue('nsfwVulva', 'vulva'),
      anus: privateFormValue('nsfwAnus', 'anus'),
      penis: privateFormValue('nsfwPenis', 'penis'),
      scrotum: privateFormValue('nsfwScrotum', 'scrotum'),
    };
    const hasMorphologyFormField = Object.prototype.hasOwnProperty.call(form, 'morphology');
    const rawMorphology = optionalFormValue('morphology', currentMorphology?.morphology || '');
    // Resolve legacy free-form labels before persisting.  The resolver is
    // given the surrounding fields as well, so a label such as “非人类” can
    // retain its conservative non-human branch while concrete labels such as
    // “六足甲壳怪物” become the appropriate canonical kind.
    const morphologyPersistence = normalizeCharacterMorphologyForPersistence(
      rawMorphology,
      {
        bodyPlan: optionalFormValue('bodyPlan', currentMorphology?.bodyPlan || ''),
        race: optionalFormValue('race', current?.race || ''),
        appearance: optionalFormValue('appearance', current?.appearance || ''),
        anchor: optionalFormValue('anchor', current?.anchor || ''),
        motion: optionalFormValue('motion', current?.motionHabits || ''),
      },
    );
    const normalizedMorphology = morphologyPersistence.morphology;
    // A non-canonical value cannot be represented by the persisted enum.  Move
    // the original wording into bodyPlan so old projects keep their concrete
    // species/body facts and the next prompt still has the exact user/model
    // description available.
    const legacyMorphologyDescription = morphologyPersistence.legacyDescription;
    const hasBodyPlanFormField = Object.prototype.hasOwnProperty.call(form, 'bodyPlan');
    const bodyPlanValue = optionalFormValue('bodyPlan', currentMorphology?.bodyPlan || '');
    const persistedBodyPlan = appendLegacyMorphologyDescription(
      bodyPlanValue,
      legacyMorphologyDescription,
    );
    const shouldPersistBodyPlan = hasBodyPlanFormField
      || Boolean(currentMorphology?.bodyPlan)
      || Boolean(legacyMorphologyDescription);
    const privateProfileChanged = Object.entries(privateProfileFields).some(([key, value]) => (
      value !== (current?.nsfwProfile?.[key as keyof typeof privateProfileFields] || '').trim()
    ));
    const populatedPrivateProfileFields = Object.fromEntries(
      Object.entries(privateProfileFields).filter(([, value]) => Boolean(value)),
    );
    const nsfwProfile = Object.keys(populatedPrivateProfileFields).length
      ? {
          ...(!privateProfileChanged && current?.nsfwProfile?.provenance
            ? { provenance: current.nsfwProfile.provenance }
            : { provenance: 'manual' as const }),
          ...(!privateProfileChanged && current?.nsfwProfile?.sourceHash
            ? { sourceHash: current.nsfwProfile.sourceHash }
            : {}),
          ...populatedPrivateProfileFields,
        }
      : undefined;
    return {
      ...current,
      id,
      name: formValue(form, 'name'),
      gender: formValue(form, 'gender'),
      // Preserve these optional fields when an old caller does not render the
      // new controls; an explicitly rendered empty value is still allowed to
      // clear a previous manual choice.
      ...(hasMorphologyFormField
        ? { morphology: normalizedMorphology }
        : currentMorphology?.morphology
          ? { morphology: normalizedMorphology || currentMorphology.morphology }
          : {}),
      ...(shouldPersistBodyPlan
        ? { bodyPlan: persistedBodyPlan }
        : {}),
      apparentAge: formValue(form, 'age'),
      actualAge: formValue(form, 'actualAge'),
      height: formValue(form, 'height'),
      race: formValue(form, 'race'),
      appearance: formValue(form, 'appearance'),
      outfit: formValue(form, 'outfit'),
      signatureProps: formValue(form, 'props'),
      personality: formValue(form, 'personality'),
      motionHabits: formValue(form, 'motion'),
      anchor: formValue(form, 'anchor'),
      negativeContinuity: current?.negativeContinuity || '',
      assetIds: [...(current?.assetIds || [])],
      nsfwProfile,
    };
  }
  if (kind === 'location') {
    const current = existing as Location | undefined;
    return {
      ...current,
      id,
      name: formValue(form, 'name'),
      description: formValue(form, 'description'),
      timeWeather: formValue(form, 'weather'),
      lighting: formValue(form, 'lighting'),
      palette: formValue(form, 'palette'),
      fixedProps: formValue(form, 'fixedProps'),
      anchor: formValue(form, 'anchor'),
      ...(Object.prototype.hasOwnProperty.call(form, 'style')
        ? { visualStyle: formValue(form, 'style') }
        : {}),
      assetIds: [...(current?.assetIds || [])],
    };
  }
  const current = existing as Prop | undefined;
  return {
    ...current,
    id,
    name: formValue(form, 'name'),
    category: formValue(form, 'category'),
    material: formValue(form, 'material'),
    appearance: formValue(form, 'appearance'),
    effect: formValue(form, 'effect'),
    stateRules: formValue(form, 'stateRules'),
    assetIds: [...(current?.assetIds || [])],
  };
};

export interface ImageVariantGenerationSpec {
  id: ImageVariant;
  label: string;
  direction: string;
  canvas: {
    width: number;
    height: number;
  };
}

/** Frozen request metadata for the converter, separate from visible image text.
 * Optional fields keep legacy callers and stored task dimensions usable. */
export interface ImagePromptOutputSpecification {
  width: number;
  height: number;
  aspectRatio?: string;
  resolution?: string;
}

const imagePromptOutputFrame = (
  specification: ImagePromptOutputSpecification | undefined,
): { width: number; height: number; aspect: string; orientation: string } | undefined => {
  if (!specification || !Number.isSafeInteger(specification.width) || !Number.isSafeInteger(specification.height)
    || specification.width <= 0 || specification.height <= 0) return undefined;
  const { width, height } = specification;
  const orientation = width === height ? '方形' : width > height ? '横向' : '竖向';
  const declaredAspect = (specification.aspectRatio || '').trim().replace(/\s+/gu, '');
  const parsed = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u.exec(declaredAspect);
  const declaredRatio = parsed ? Number(parsed[1]) / Number(parsed[2]) : 0;
  // Native K tables round edges to model alignment. Keep a matching logical
  // aspect, but do not let stale requested metadata describe a new canvas.
  const declaredMatches = declaredRatio > 0 && Number.isFinite(declaredRatio)
    && Math.abs(width / height / declaredRatio - 1) <= 0.02;
  let divisor = width;
  let remainder = height;
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
  const aspect = declaredMatches ? declaredAspect : `${width / divisor}:${height / divisor}`;
  return { width, height, aspect, orientation };
};

/** Adapt only generated layout instructions. Saved presets and user text keep
 * their own wording and receive the final output contract at request time. */
const imageVariantLayoutForOutput = (
  layout: string,
  specification: ImagePromptOutputSpecification | undefined,
): string => {
  const frame = imagePromptOutputFrame(specification);
  if (!frame) return layout;
  return layout.replace(/横向\s*3\s*:\s*2|2\s*:\s*3\s*竖向|1\s*:\s*1\s*方形/gu,
    `${frame.aspect} ${frame.orientation}`);
};

export const imagePromptOutputSpecificationRule = (
  specification: ImagePromptOutputSpecification | undefined,
  variant?: ImageVariant,
): string => {
  const frame = imagePromptOutputFrame(specification);
  if (!specification || !frame) return '';
  const { width, height, aspect, orientation } = frame;
  const resolution = /^(?:1K|2K|4K)$/iu.test(specification.resolution || '')
    ? specification.resolution!.toUpperCase() : '当前请求';
  const framing = variant === 'private-close-up'
    ? '本次仍只绘制一个指定部位的连续近景或微距画面，保留裁切与部位占画面比例；指定部位只出现一次，邻近结构只作方位锚点，不拉远补全身或另开窗口。'
    : variant === 'private-full-body' || variant === 'full-body'
      ? '本次仍是一个完整主体的单幅全身图，头到脚或对应物种端点完整入画，身体比例与主体相对画面高度保持自然。'
      : variant === 'five-view' || variant === 'private-five-view'
        ? '本次仍是同一人物的五区域参考板：左侧上下两头肩特写，右侧三个指定角度全身；固定区域、顺序与各区取景保持。'
        : variant === 'turnaround' || variant === 'private-turnaround'
          ? '本次仍是同一人物的历史四视图参考板，四个全身视角及其顺序保持。'
          : variant === 'private-four-in-one'
            ? '本次仍是四个固定槽位：左侧约70%为一个全身主画面，右侧约30%为三个辅助部位窗；每个槽位只绘制一次指定内容。'
            : variant === 'grid'
              ? '本次仍是一张当前实际画幅的3×3九宫格母版，九格数量、阅读顺序与逐格时刻保持；九格在当前画布内等大分配，不要求每个画格为方形。'
              : '本次人物或物件数量、选定时刻、机位、景别、裁切和主体相对画面占比保持当前目标。';
  return [
    '<current_image_output_specification>',
    `当前生图规格：${resolution}分辨率档位；逻辑画幅${aspect}，${orientation}画幅；实际请求${width}×${height}像素。`,
    '本块给出的实际请求画幅与宽高是本次最终画布依据，优先于前文规则、预设、图片规格中默认或推荐的画布比例；前文比例与这里不一致时，最终画面采用这里的实际画幅。',
    '这里的档位和宽高是本次请求元数据，不是画面内容、图中文字或质量标签；最终正文只落实当前实际画幅与可见构图，不输出档位、像素数字、API参数或此规格说明。',
    framing,
    '画幅调整只在当前画布内重新分配各区域尺寸、等比适配主体及连续背景留白；完整保留当前槽位数量、左右或上下关系、视角顺序和各槽位指定的取景，不删槽位、不把近景补成全身、不拉伸身体，也不增加区域填充画布。',
    '提高分辨率不会增加人物、物件、区域、角度或身体部位；留白延续同一背景，不以重复主体填充画布，不改变当前身份、风格、服装或内容状态。',
    '</current_image_output_specification>',
  ].join('\n');
};

const SQUARE_CANVAS = { width: 1024, height: 1024 } as const;
const PRIVATE_FULL_BODY_CANVAS = { width: 1024, height: 1536 } as const;
const FOUR_VIEW_CANVAS = { width: 1536, height: 1024 } as const;
const FIVE_VIEW_CANVAS = { width: 1536, height: 1024 } as const;
const LANDSCAPE_CANVAS = { width: 1536, height: 1024 } as const;

/** Shared by initial generation, conversion and retries. The two portraits
 * intentionally use a different framing/scale from the three full bodies. */
export const FIVE_VIEW_LAYOUT_RULE = [
  '单张横向3:2角色五视图参考板，恰好五个区域：两个头肩特写加三个全身视图',
  '左侧约占画布30%宽度，上下分成两格：左上为正面头肩特写，左下为严格90度左侧面头肩特写',
  '两个头肩特写各自独立放大，清晰表现面容、头部轮廓和发型，不要求在特写格内展示完整全身',
  '右侧约占画布70%宽度，分为三个等宽全高区域，从左到右依次为正面全身、严格90度左侧面全身、背面全身',
  '仅右侧三个全身视图保持同一尺度、同一相机高度和同一水平基线，以中性静态姿态展示，从最高头部或角尖到足底、尾尖及全部附肢完整收在各自区域内，不裁切、不遮挡、不跨格、不重叠；保持对应物种真实且稳定的头身比例、肩胯比例和四肢/附肢长度，不横向拉伸、不纵向压缩、不挤扁主体',
  '五个区域始终属于同一且唯一的角色，保持身份、物种结构、体型、肤色或体表材质、发型、标记与当前资料指定的衣着状态一致；无头肩的物种以其真实头部或感知结构作近景，不添加人形结构',
  '不要改成五个全身、五个等宽竖栏或四个全身，不增加45度三分之四视图或额外图块',
  '统一简洁背景、统一光照和当前用户指定的视觉风格，不照搬版式示例的人物、服装、裸露状态或室内场景；无文字、编号、Logo和水印',
  '采用正交或低透视的标准镜头和自然相机距离，避免广角、鱼眼、近距离透视造成主体边缘变宽、近大远小或局部变形',
].join('；') + '。';

/** Do not reuse single-image negatives such as "multiple views" or
 * "cropped body": the layout intentionally contains two portrait crops. */
export const FIVE_VIEW_NEGATIVE_PROMPT = 'extra sixth panel, five full-body columns, repeated full-body angle, extra three-quarter view, repeated body part, duplicate body part, duplicated inset, extra anatomical inset, mixed anatomy, mismatched identity between views, inconsistent anatomy between views, inconsistent outfit state between views, cut-off feet in full-body regions, overlapping regions, stretched body, compressed body, squashed body, distorted body proportions, wide-angle distortion, fisheye distortion, text, logo, watermark';

/** Shared geometry contract for body-bearing reference images.  This only
 * constrains framing and lens geometry; it does not alter clothing, private
 * profile fields, or the existing NSFW content rules. */
export const BODY_PROPORTION_STABILITY_RULE = [
  '保持资料与当前视觉风格指定的稳定头身比例、肩胯比例、躯干比例和四肢/附肢长度，身体沿对应物种的自然轴线连续连接',
  '主体保持原始纵横比例，不出现横向拉伸、纵向压缩、挤扁、局部放大或缩短；不同视图使用同一身体尺度与基线',
  '使用正交或低透视的标准镜头和自然相机距离，避免广角、鱼眼或过近机位造成近大远小、边缘变宽和比例变形',
].join('；') + '。';

/** Shared contract for the ordinary single-image full-body variant.  Keeping
 * this in the generation spec, converter rules and negative prompt prevents
 * the model from treating “全身” as a loose style hint and returning a
 * waist-up, knee-up, or lower-body crop. */
export const FULL_BODY_LAYOUT_RULE = [
  '当前规格是单幅全身人物图，不是头像、半身、膝上、中景或下半身裁切',
  '画面中只有一个主体，主体从头顶（或最高点）到双脚/足底（或最低附肢端点）完整入画，头顶与足底保留窄边',
  '双臂、双手、双腿、双脚和鞋靴（或该物种全部附肢）都完整可见，不被画框、前景或其他物体截断',
  '主体居中并成为主要视觉焦点；画幅服从当前实际生图规格，以完整身体高度为优先，不为填满横向、竖向或方形画布而放大或拉伸身体，周围保留连续环境和自然留白',
  '使用自然静态全身站姿、正常透视和自然相机距离，禁止近景放大或只展示腰部以下',
  BODY_PROPORTION_STABILITY_RULE,
].join('；') + '。';

export const FULL_BODY_NEGATIVE_PROMPT = 'half body, upper body, bust, waist-up, knee-up, lower-body crop, legs-only, torso-only, cropped head, cropped legs, cut-off feet, cut-off shoes, out of frame, close-up, medium shot, partial body, duplicate body, extra person, stretched body, compressed body, squashed body, distorted body proportions, wide-angle distortion, fisheye distortion, text, logo, watermark';

/** Private multi-region sheets need their own structural addendum.  The shared
 * five-view negative intentionally allows multiple regions; these terms only
 * reject duplicated content inside the regions that were already requested. */
export const PRIVATE_FIVE_VIEW_LAYOUT_RULE = [
  '这是私密资料五视图，仍然严格只有五个固定区域：左上正面头肩、左下严格90度左侧面头肩、右侧正面全身、右侧严格90度左侧面全身、右侧背面全身',
  '私密全身资料和局部资料只作为同一人物的身份与身体锚点；局部资料不能另开辅助窗、不能替换头肩区域、不能重复进入多个区域',
  '五个区域各自只承担指定的一种取景，右侧三个全身区域只出现一次且不混入其它私密部位特写，所有区域共享同一人物和同一身体比例',
].join('；') + '。';

export const PRIVATE_FOUR_IN_ONE_LAYOUT_RULE = [
  '这是严格私密四合一资料板，横向3:2画布固定为恰好四个区域：左侧约70%是唯一私密全身主画面，右侧约30%从上到下是三个辅助部位窗（辅助窗一、辅助窗二、辅助窗三）',
  '左侧主画面从头到脚完整入画且只出现一次；右侧三个辅助窗各只表现当前提示词指定的一个不同私密部位，按槽位顺序各出现一次',
  '四个槽位属于同一人物和同一身体锚点，主画面与辅助窗按槽位一一对应；全身内容只归入主画面，部位内容各归入自己的辅助窗，总区域保持四块，单个辅助窗保持单一部位边界',
  '所有区域使用统一中性背景、统一光线和稳定比例，主画面保持完整身体比例，辅助窗保持对应部位的局部比例与清晰边界',
].join('；') + '。';

export const PRIVATE_FOUR_IN_ONE_NEGATIVE_PROMPT = 'extra fifth panel, extra inset, extra anatomical window, duplicate inset, repeated body part, duplicate body part, repeated full body, duplicate full body, extra full body, multiple full bodies, mixed anatomy, swapped anatomy, merged body parts, overlapping panels, split screen, random collage, contact sheet, unrequested view, text, logo, watermark';

/** Request-time layout adaptation only. Preserve the stored preset and all
 * non-layout restrictions; intentional portraits/multiple depictions are not
 * accidental cropped/duplicate bodies. Explicit user negatives bypass this. */
export const fiveViewCompatibleNegativePrompt = (value: string | undefined): string => (value || '')
  .split(/[,，;；]/u)
  .map((part) => part.trim())
  .filter((part) => part && !/^(?:cropped body|duplicate body|duplicated body|multiple views|contact sheet|collage|panels|split screen)$/iu.test(part))
  .join(', ');

const IMAGE_VARIANT_SPECS: Readonly<Record<ImageVariant, ImageVariantGenerationSpec>> = {
  portrait: {
    id: 'portrait',
    label: '头像',
    direction: '头像近景，正面清晰可辨，背景简洁。',
    canvas: SQUARE_CANVAS,
  },
  'half-body': {
    id: 'half-body',
    label: '半身',
    direction: '半身构图，双手和服装层次可见。',
    canvas: SQUARE_CANVAS,
  },
  'full-body': {
    id: 'full-body',
    label: '全身',
    direction: `全身立绘，站姿完整，鞋靴和比例清晰。${FULL_BODY_LAYOUT_RULE}`,
    canvas: SQUARE_CANVAS,
  },
  'private-full-body': {
    id: 'private-full-body',
    label: '私密全身图',
    direction: `一幅连续的私密全身外貌参考图，2:3竖向画布中只有一个完整主体，沿画面中央竖轴采用中性静态站姿，从头到脚完整入画，头顶与足底保留窄边，左右两侧只延续同一片纯净背景；裸体身体的稳定比例、轮廓、肤色、纹理与永久标记清晰可见。${BODY_PROPORTION_STABILITY_RULE}`,
    canvas: PRIVATE_FULL_BODY_CANVAS,
  },
  'private-five-view': {
    id: 'private-five-view',
    label: '私密五视图',
    direction: `私密人物五视图资料板，沿用当前人物的私密资料模式和已确认身份，仅改变参考板布局。${FIVE_VIEW_LAYOUT_RULE}${PRIVATE_FIVE_VIEW_LAYOUT_RULE}`,
    canvas: FIVE_VIEW_CANVAS,
  },
  'private-turnaround': {
    id: 'private-turnaround',
    label: '私密四视图',
    direction: [
      '私密全身外貌四视图资料板，横向3:2画布，同一且唯一的角色恰好展示四个等比例裸体全身视图',
      '从左到右依次为正面、严格90度左侧面、背面、45度前侧三分之四视图，每个角度仅出现一次',
      '四个视图保持完全相同的身份、物种、头身比例、体型、肤色、体表纹理、永久标记与私密身体锚点',
      '采用相同中性静态展示姿态、相同尺寸、相同相机高度、同一水平基线，四个等宽栏位间距一致',
      '从头顶到足底、尾尖及全部附肢都完整收在各自栏位内，不裁切、不遮挡、不跨栏、不重叠',
      `正交设定图，固定机位，无透视夸张、无广角、无景深、无动作变化；${BODY_PROPORTION_STABILITY_RULE}`,
      '纯无彩色哑光中性灰无缝背景，均匀柔和棚拍光，无场景、无地平线、无文字、无编号、无Logo、无水印',
    ].join('；') + '。',
    canvas: FOUR_VIEW_CANVAS,
  },
  'private-four-in-one': {
    id: 'private-four-in-one',
    label: '私密四合一',
    direction: `私密资料四合一设定板。${PRIVATE_FOUR_IN_ONE_LAYOUT_RULE}${BODY_PROPORTION_STABILITY_RULE}纯净中性灰无缝背景，均匀柔和棚拍光，无文字、无编号、无Logo、无水印。`,
    canvas: FOUR_VIEW_CANVAS,
  },
  'five-view': {
    id: 'five-view',
    label: '五视图',
    direction: `普通人物五视图资料板，保留当前普通人物资料指定的衣着和外观，不引入私密档案或改变衣着状态。${FIVE_VIEW_LAYOUT_RULE}`,
    canvas: FIVE_VIEW_CANVAS,
  },
  turnaround: {
    id: 'turnaround',
    label: '四视图',
    direction: [
      '一张横向3:2画布的角色四视图技术设定板，同一且唯一的角色恰好展示四个等比例全身视图',
      '从左到右依次为正面、严格90度左侧面、背面、45度前侧三分之四视图，每个角度仅出现一次',
      '四个视图保持完全相同的身份、物种、头身比例、体型、附肢数量、纹理、伤痕、配色和装备',
      '采用相同中性静态展示姿态、相同尺寸、相同相机高度、同一水平基线，四个等宽栏位间距一致',
      '从最高角尖到足底、尾尖及全部附肢都完整收在各自栏位内，不裁切、不遮挡、不跨栏、不重叠',
      `正交设定图，固定机位，无透视夸张、无广角、无景深、无动作变化；${BODY_PROPORTION_STABILITY_RULE}`,
      '纯无彩色哑光中性灰无缝背景，均匀柔和棚拍光，无场景、无地平线、无文字、无编号、无Logo、无水印',
    ].join('；') + '。',
    canvas: FOUR_VIEW_CANVAS,
  },
  reference: {
    id: 'reference',
    label: '参考图',
    direction: '标准角色参考图，构图稳定，适合后续视频绑定。',
    canvas: SQUARE_CANVAS,
  },
  landscape: {
    id: 'landscape',
    label: '风景场景',
    direction: LANDSCAPE_IMAGE_DIRECTION,
    canvas: SQUARE_CANVAS,
  },
  snapshot: {
    id: 'snapshot',
    label: '故事快照',
    direction: '剧情发生瞬间的故事快照，主体动作和环境关系清晰。',
    canvas: SQUARE_CANVAS,
  },
  'first-frame': {
    id: 'first-frame',
    label: '分镜首帧',
    direction: '视频分镜首帧，明确初始构图、人物站位和主光源。',
    canvas: SQUARE_CANVAS,
  },
  'last-frame': {
    id: 'last-frame',
    label: '分镜尾帧',
    direction: '视频分镜尾帧，明确动作完成后的可见结果、最终构图和人物状态。',
    canvas: LANDSCAPE_CANVAS,
  },
  'storyboard-frame': {
    id: 'storyboard-frame',
    label: '分镜图片',
    direction: '单镜头剧情分镜图片，严格表现该镜主体、动作、构图、光线和结果。',
    canvas: LANDSCAPE_CANVAS,
  },
  icon: {
    id: 'icon',
    label: '图标',
    direction: '物品图标式干净构图，轮廓清楚。',
    canvas: SQUARE_CANVAS,
  },
  'close-up': {
    id: 'close-up',
    label: '特写',
    direction: '物品近距离特写，材质和磨损细节清楚。',
    canvas: SQUARE_CANVAS,
  },
  'private-close-up': {
    id: 'private-close-up',
    label: '私密部位特写',
    direction: '一幅连续的指定私密部位近景或微距参考图，当前部位占据画面主体，紧邻皮肤提供解剖方位，稳定形状、比例、颜色、纹理、肤质与光影清晰可见。',
    canvas: SQUARE_CANVAS,
  },
  showcase: {
    id: 'showcase',
    label: '展示图',
    direction: '物品展示构图，完整轮廓与关键结构可见。',
    canvas: SQUARE_CANVAS,
  },
  grid: {
    id: 'grid',
    label: '3×3视觉母版',
    direction: '3×3九宫格连续视觉母版。',
    canvas: SQUARE_CANVAS,
  },
};

export const IMAGE_VARIANT_OPTIONS: Readonly<Record<ImageAssetKind, readonly ImageVariant[]>> = {
  character: ['portrait', 'half-body', 'full-body', 'five-view'],
  location: ['landscape', 'snapshot', 'first-frame'],
  prop: ['icon', 'close-up', 'showcase'],
  grid: ['grid'],
};

export const getImageVariantGenerationSpec = (variant: ImageVariant): ImageVariantGenerationSpec =>
  IMAGE_VARIANT_SPECS[variant];

export const isPrivateImageVariant = (variant: ImageVariant | undefined): boolean => (
  variant === 'private-full-body'
  || variant === 'private-five-view'
  || variant === 'private-turnaround'
  || variant === 'private-four-in-one'
  || variant === 'private-close-up'
);

/** Legacy turnaround remains a four-view snapshot; never reinterpret an old
 * saved task as the new five-region layout when it is retried. */
export const ordinaryImageVariantConverterRule = (
  variant: ImageVariant,
  outputSpecification?: ImagePromptOutputSpecification,
): string => {
  const withOutputSpecification = (rule: string): string => [
    imageVariantLayoutForOutput(rule, outputSpecification), imagePromptOutputSpecificationRule(outputSpecification, variant),
  ].filter(Boolean).join('\n');
  if (variant === 'landscape') return withOutputSpecification(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT);
  if (variant === 'full-body') {
    return withOutputSpecification(`当前目标是普通人物单幅全身参考图。${FULL_BODY_LAYOUT_RULE}优先服从当前全身画面规格，再组织角色身份、物种结构、服装、道具和风格；不要把全身目标改成半身、膝上、下半身或局部特写。`);
  }
  if (variant === 'five-view') {
    return withOutputSpecification(`当前目标是普通人物五视图参考板。${FIVE_VIEW_LAYOUT_RULE}仅使用当前普通人物外观与衣着资料，私密档案不属于本次普通生图内容。`);
  }
  if (variant === 'turnaround') {
    return withOutputSpecification(`当前目标是历史四视图参考板，保留其原有版式。${IMAGE_VARIANT_SPECS.turnaround.direction}`);
  }
  return '';
};

export const ordinaryImageVariantNegativePrompt = (variant: ImageVariant): string => (
  variant === 'landscape'
    ? LANDSCAPE_IMAGE_NEGATIVE_PROMPT
    : variant === 'five-view'
    ? FIVE_VIEW_NEGATIVE_PROMPT
    : variant === 'full-body'
      ? FULL_BODY_NEGATIVE_PROMPT
      : ''
);

export const privateFourInOnePromptProblem = (value: string): string => {
  if (!value.trim()) return '私密四合一提示词为空';
  if (/(?:四视图|五视图|5[-\s]?views?|five[-\s]?views?|turnaround|正面[^。；;\n]{0,32}(?:侧面|左侧面)[^。；;\n]{0,32}背面|front[^.;\n]{0,32}side[^.;\n]{0,32}back)/iu.test(value)) {
    return '私密四合一被写成四视图或五视图';
  }
  if (/(?:第五(?:个)?(?:视图|图块|窗|面板)|第\s*5\s*(?:个)?(?:view|panel|inset)|(?:extra|additional)\s+(?:view|panel|inset))/iu.test(value)) {
    return '私密四合一出现额外第五视图或第五面板';
  }
  const duplicateCheckText = value.replace(/互不重复|各自?出现一次|只出现一次|仅出现一次/giu, '');
  if (/(?:多个|重复|两个|两张|两幅|四个全身|四张全身|four\s+full[-\s]?body)[^。；;\n]{0,12}(?:全身|full[-\s]?body)|(?:全身|full[-\s]?body)[^。；;\n]{0,12}(?:多个|重复|两个|两张|两幅|four)/iu.test(duplicateCheckText)) {
    return '私密四合一重复出现全身主体';
  }
  if (/(?:重复|两个|两张|多个)[^。；;\n]{0,12}(?:辅助窗|部位窗|局部窗|inset|detail\s+panel)|(?:辅助窗|部位窗|局部窗|inset|detail\s+panel)[^。；;\n]{0,12}(?:重复|两个|两张|多个)/iu.test(duplicateCheckText)) {
    return '私密四合一重复出现辅助部位窗';
  }
  if (/四格平均|平均四格|均分|随机拼贴|多人物|剧情场景|single\s+(?:portrait|full[-\s]?body\s*(?:image|portrait)?\s*$)/iu.test(value)) {
    return '未保持私密四合一资料板结构';
  }
  const requiredPatterns: Array<[RegExp, string]> = [
    [/(?:四合一|四个(?:区域|图块|窗格|面板)|4\s*(?:panels?|tiles?|regions?)|辅助窗|部位窗|inset|detail\s+panel|detail\s+windows?)/iu, '缺少四合一辅助窗结构'],
    [/(?:主画面|主体画面|主要画面|占据(?:画布)?大部分|最大主画面|dominant|main\s+panel|primary\s+panel)/iu, '缺少私密全身主画面约束'],
    [/(?:全身|full[-\s]?body)/iu, '缺少私密全身主图'],
    [/(?:胸部|乳房|外阴|后庭|阴茎|阴囊|breasts?|vulva|anus|penis|scrotum)/iu, '缺少私密部位格'],
    [/(?:同一人物|同一主体|同一身体锚点|same\s+(?:character|subject)|consistent\s+(?:identity|body))/iu, '缺少同一人物约束'],
  ];
  return requiredPatterns.find(([pattern]) => !pattern.test(value))?.[1] || '';
};

const PRIVATE_EXTRA_LAYOUT_PATTERN =
  /(?:四视图|三视图|五视图|多视图|多角度|四合一|分格|窗格|面板|辅助窗|局部窗|头像窗|特写窗|资料板|设定板|reference\s+sheet|character\s+sheet|turnaround|multi[-\s]?view|multiple\s+views?|insets?|panels?|tiles?|detail\s+windows?)/iu;

const PRIVATE_FULL_BODY_DUPLICATE_PATTERN =
  /(?:多个|重复|两个|两张|两幅)[^。；;\n]{0,16}(?:全身|主体|人物)|(?:full[-\s]?body|subject|character)[^.;\n]{0,24}(?:duplicate|two|multiple|extra)/iu;

const PRIVATE_PART_PATTERNS: Readonly<Record<Exclude<NsfwPrivatePart, 'full-body'>, RegExp>> = {
  breasts: /(?:胸部|乳房|乳头|breasts?|nipples?|chest)/iu,
  vulva: /(?:外阴|阴唇|vulva|labia)/iu,
  anus: /(?:后庭|肛门|anus|anal)/iu,
  penis: /(?:阴茎|龟头|penis|glans)/iu,
  scrotum: /(?:阴囊|睾丸|scrotum|testicles?|balls)/iu,
};

const PRIVATE_PART_LABELS: Readonly<Record<NsfwPrivatePart, string>> = {
  'full-body': '私密全身',
  breasts: '胸部',
  vulva: '外阴',
  anus: '后庭',
  penis: '阴茎',
  scrotum: '阴囊',
};

export const privateImageVariantConverterRule = (
  variant: ImageVariant,
  selectedPart?: NsfwPrivatePart,
  outputSpecification?: ImagePromptOutputSpecification,
): string => {
  const withOutputSpecification = (rule: string): string => [
    imageVariantLayoutForOutput(rule, outputSpecification), imagePromptOutputSpecificationRule(outputSpecification, variant),
  ].filter(Boolean).join('\n');
  if (variant === 'private-full-body') {
    return withOutputSpecification(`当前目标是私密全身单幅参考图：最终提示词采用 2:3 竖向的一幅连续单画面，唯一完整主体沿画面中央竖轴站立，从头到脚完整入画，头顶和足底保留窄边，主体左右只延续同一片干净背景；视觉焦点是整体裸体比例、轮廓、肤色、纹理与长期标记。\n${BODY_PROPORTION_STABILITY_RULE}`);
  }
  if (variant === 'private-close-up') {
    const label = selectedPart ? PRIVATE_PART_LABELS[selectedPart] : '当前指定部位';
    return withOutputSpecification(`当前目标是${label}单部位近景：最终提示词采用一幅连续近景或微距画面，${label}占据画面主体，紧邻皮肤提供解剖方位；人物一致性由当前部位的肤色、肤质、体表纹理与比例锚定，画面只建立这一处部位资料。`);
  }
  if (variant === 'private-five-view') {
    return withOutputSpecification(`当前目标是私密五视图参考板：横向 3:2 画布沿用当前人物的私密资料模式和已确认身份，仅改变参考板布局。${FIVE_VIEW_LAYOUT_RULE}${PRIVATE_FIVE_VIEW_LAYOUT_RULE}当前全身资料用于右侧三个完整全身视图；左侧两格呈现同一人物的头肩近景，头像区保持头肩取景，全身区保持完整全身取景。`);
  }
  if (variant === 'private-turnaround') {
    return withOutputSpecification(`当前目标是私密四视图参考板：横向 3:2 画布，恰好四个同身份、同裸体身体锚点、同尺寸、同基线的完整全身视图；依次表现正面、严格 90 度左侧面、背面、45 度前三分之四视图；正交或低透视，中性灰无缝背景。\n${BODY_PROPORTION_STABILITY_RULE}`);
  }
  if (variant === 'private-four-in-one') {
    return withOutputSpecification(`当前目标是严格私密四合一参考板。${PRIVATE_FOUR_IN_ONE_LAYOUT_RULE}\n${BODY_PROPORTION_STABILITY_RULE}`);
  }
  return '';
};

export const privateImageVariantRepairRule = (
  variant: ImageVariant,
  selectedPart?: NsfwPrivatePart,
  outputSpecification?: ImagePromptOutputSpecification,
): string => {
  const targetRule = privateImageVariantConverterRule(variant, selectedPart, outputSpecification);
  return targetRule
    ? `这是自动返修请求。上一轮没有落实当前唯一画面规格。请依据原始人物资料重新写一条完整正向提示词。${targetRule}`
    : '';
};

export const privateImageVariantNegativePrompt = (variant: ImageVariant): string => (
  variant === 'private-full-body'
    ? 'extra person, second person, two people, duplicate person, cloned person, mirrored person, repeated body, repeated full body, multiple full bodies, multiple views, split screen, diptych, triptych, contact sheet, character sheet, turnaround, collage, panels, inset, extra limbs, stretched body, compressed body, squashed body, distorted body proportions, wide-angle distortion, fisheye distortion, text, logo, watermark'
    : variant === 'private-five-view' ? FIVE_VIEW_NEGATIVE_PROMPT
      : variant === 'private-four-in-one' ? PRIVATE_FOUR_IN_ONE_NEGATIVE_PROMPT : ''
);

export const normalizePrivateSingleImagePrompt = (
  value: string,
  variant: ImageVariant,
  format: 'natural-language' | 'sd-tags' | 'nai-tags' = 'natural-language',
): string => {
  if (variant !== 'private-full-body' && variant !== 'private-close-up') return value.trim();
  const normalized = value
    .replace(/(?:未|不)分格(?:的)?(?:(?:单一?|一幅|一张|一个)\s*)?(?:画面|图像|构图)?/gu, '一幅连续单画面')
    .replace(/\b(?:ungridded|unpaneled|unpanelled)\b/giu, 'continuous')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  if (variant !== 'private-full-body'
    || /(?:左右两侧|主体两侧|两侧.*背景|both sides|either side|surrounding background|symmetrical negative space)/iu.test(normalized)) {
    return normalized;
  }
  if (format !== 'natural-language') {
    return [normalized, 'solo, single subject, centered full body, head to toe, symmetrical negative space, simple continuous background']
      .filter(Boolean)
      .join(', ');
  }
  const frameAnchor = /[\u3400-\u9FFF]/u.test(normalized)
    ? '唯一完整主体沿画面中央竖轴站立，头顶和足底都保留窄边，主体左右两侧只延续同一片干净背景。'
    : 'Exactly one complete subject stands on the central vertical axis, with the head and feet inside the frame and the same clean background continuing on both sides.';
  return [normalized, frameAnchor].filter(Boolean).join(/[^.!?。！？]$/u.test(normalized) ? '. ' : ' ');
};

export const privateFullBodyPromptProblem = (value: string): string => {
  if (!value.trim()) return '私密全身提示词为空';
  const normalizedValue = normalizePrivateSingleImagePrompt(value, 'private-full-body');
  if (PRIVATE_EXTRA_LAYOUT_PATTERN.test(normalizedValue)) {
    return '私密全身图混入多视图、资料板、辅助窗或额外面板';
  }
  if (PRIVATE_FULL_BODY_DUPLICATE_PATTERN.test(normalizedValue.replace(/唯一主体|只出现一次|仅出现一次/giu, ''))) {
    return '私密全身图重复出现主体或全身人物';
  }
  if (!/(?:从头到脚|完整全身|全身|full[-\s]?body|head[-\s]?to[-\s]?toe)/iu.test(normalizedValue)) {
    return '私密全身图缺少完整全身构图';
  }
  return '';
};

export const privateCloseUpPromptProblem = (
  value: string,
  selectedPart?: NsfwPrivatePart,
): string => {
  if (!value.trim()) return '私密部位特写提示词为空';
  const normalizedValue = normalizePrivateSingleImagePrompt(value, 'private-close-up');
  if (PRIVATE_EXTRA_LAYOUT_PATTERN.test(normalizedValue)) {
    return '私密部位特写混入多视图、资料板、辅助窗或额外面板';
  }
  if (/(?:完整全身|从头到脚|全身主画面|full[-\s]?body|head[-\s]?to[-\s]?toe)/iu.test(normalizedValue)) {
    return '私密部位特写混入全身画面';
  }
  if (!selectedPart || selectedPart === 'full-body') return '';
  const currentPattern = PRIVATE_PART_PATTERNS[selectedPart];
  if (currentPattern && !currentPattern.test(normalizedValue)) {
    return `私密部位特写缺少当前指定部位：${PRIVATE_PART_LABELS[selectedPart]}`;
  }
  const otherPart = (Object.keys(PRIVATE_PART_PATTERNS) as Array<Exclude<NsfwPrivatePart, 'full-body'>>)
    .find((part) => part !== selectedPart && PRIVATE_PART_PATTERNS[part].test(normalizedValue));
  return otherPart ? `私密部位特写混入其它部位：${PRIVATE_PART_LABELS[otherPart]}` : '';
};

export const privateImagePromptProblem = (
  variant: ImageVariant,
  value: string,
  selectedPart?: NsfwPrivatePart,
): string => {
  if (variant === 'private-full-body') return privateFullBodyPromptProblem(value);
  if (variant === 'private-close-up') return privateCloseUpPromptProblem(value, selectedPart);
  if (variant === 'private-four-in-one') return privateFourInOnePromptProblem(value);
  return '';
};

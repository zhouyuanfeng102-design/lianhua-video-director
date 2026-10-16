import type { AssetReferenceEntityBinding, Character, Location, Project, Prop, ReferenceAsset } from './types';

export const isAssetCharacterBindingImage = (asset: ReferenceAsset): boolean => (
  !['video', 'audio'].includes(asset.type)
  && !['video', 'audio'].includes(asset.mediaType || '')
  && !/^(?:video|audio)\//u.test(asset.mimeType || '')
);

/** Explicit malformed metadata is a clear, never permission to infer an owner. */
export const normalizeAssetReferenceEntityBinding = (
  value: unknown,
): AssetReferenceEntityBinding | null | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  if (!['character', 'location', 'prop'].includes(binding.kind as string)
    || typeof binding.entityId !== 'string' || !binding.entityId.trim()) return null;
  return { kind: binding.kind as AssetReferenceEntityBinding['kind'], entityId: binding.entityId };
};

export type AssetReferenceEntityOwner =
  | { kind: 'character'; entity: Character }
  | { kind: 'location'; entity: Location }
  | { kind: 'prop'; entity: Prop };

const exactEntityOwners = (
  project: Project, kind: AssetReferenceEntityBinding['kind'], ids: readonly string[],
): AssetReferenceEntityOwner[] => {
  const entities = kind === 'character' ? project.characters : kind === 'location' ? project.locations : project.props;
  return [...new Set(ids)].flatMap((id): AssetReferenceEntityOwner[] => {
    const matches = entities.filter((entity) => entity.id === id);
    if (matches.length !== 1 || kind === 'character' && (matches[0] as Character).dossier?.archivedIntoCharacterId) return [];
    return [{ kind, entity: matches[0] } as AssetReferenceEntityOwner];
  });
};

const legacyCharacterOwners = (project: Project, asset: ReferenceAsset): Character[] => {
  const exactCharacters = (ids: readonly string[]): Character[] => exactEntityOwners(project, 'character', ids)
    .flatMap((owner) => owner.kind === 'character' ? [owner.entity] : []);
  if (asset.characterReferenceId !== undefined) {
    return typeof asset.characterReferenceId === 'string' && asset.characterReferenceId.trim()
      ? exactCharacters([asset.characterReferenceId]) : [];
  }
  if (asset.storyReferenceSubjects?.length) {
    return exactCharacters(asset.storyReferenceSubjects.filter((subject) => subject.kind === 'character').map((subject) => subject.entityId));
  }
  if (asset.sourceEntityId || asset.sourceEntityKind) {
    if (!asset.sourceEntityId || asset.sourceEntityKind && asset.sourceEntityKind !== 'character' || ['location', 'prop'].includes(asset.type)) return [];
    if (project.locations.some((entity) => entity.id === asset.sourceEntityId) || project.props.some((entity) => entity.id === asset.sourceEntityId)) return [];
    const owners = exactCharacters([asset.sourceEntityId]);
    return asset.sourceEntityKind === 'character' ? owners : owners.filter((owner) => owner.assetIds.includes(asset.id));
  }
  return exactCharacters(project.characters.filter((character) => character.assetIds.includes(asset.id)).map((character) => character.id));
};

const legacyOtherOwners = (
  project: Project, asset: ReferenceAsset, kind: 'location' | 'prop',
): AssetReferenceEntityOwner[] => {
  if (typeof asset.characterReferenceId === 'string' && asset.characterReferenceId.trim()) return [];
  if (asset.storyReferenceSubjects?.length) {
    return exactEntityOwners(project, kind, asset.storyReferenceSubjects.filter((subject) => subject.kind === kind).map((subject) => subject.entityId));
  }
  if (asset.sourceEntityId || asset.sourceEntityKind) {
    if (!asset.sourceEntityId || asset.sourceEntityKind && asset.sourceEntityKind !== kind
      || ['character', kind === 'location' ? 'prop' : 'location'].includes(asset.type)) return [];
    const otherEntities = kind === 'location' ? [...project.characters, ...project.props] : [...project.characters, ...project.locations];
    if (otherEntities.some((entity) => entity.id === asset.sourceEntityId)) return [];
    const owners = exactEntityOwners(project, kind, [asset.sourceEntityId]);
    return asset.sourceEntityKind === kind ? owners : owners.filter((owner) => owner.entity.assetIds.includes(asset.id));
  }
  const entities = kind === 'location' ? project.locations : project.props;
  return exactEntityOwners(project, kind, entities.filter((entity) => entity.assetIds.includes(asset.id)).map((entity) => entity.id));
};

/** An explicit association is authoritative across every kind. Legacy assets
 * retain exact-ID provenance/list ownership; names and appearance prove nothing. */
export const assetReferenceEntityOwners = (project: Project, asset: ReferenceAsset): AssetReferenceEntityOwner[] => {
  if (!isAssetCharacterBindingImage(asset) || project.assets.filter((entry) => entry.id === asset.id).length !== 1) return [];
  const binding = normalizeAssetReferenceEntityBinding(asset.referenceEntityBinding);
  if (binding !== undefined) return binding ? exactEntityOwners(project, binding.kind, [binding.entityId]) : [];
  return [
    ...legacyCharacterOwners(project, asset).map((entity): AssetReferenceEntityOwner => ({ kind: 'character', entity })),
    ...legacyOtherOwners(project, asset, 'location'),
    ...legacyOtherOwners(project, asset, 'prop'),
  ];
};

export const assetReferenceCharacterOwners = (project: Project, asset: ReferenceAsset): Character[] => (
  assetReferenceEntityOwners(project, asset).flatMap((owner) => owner.kind === 'character' ? [owner.entity] : [])
);

export const assetReferenceLocationOwners = (project: Project, asset: ReferenceAsset): Location[] => (
  assetReferenceEntityOwners(project, asset).flatMap((owner) => owner.kind === 'location' ? [owner.entity] : [])
);

export const assetReferencePropOwners = (project: Project, asset: ReferenceAsset): Prop[] => (
  assetReferenceEntityOwners(project, asset).flatMap((owner) => owner.kind === 'prop' ? [owner.entity] : [])
);

const sameBinding = (left: unknown, right: AssetReferenceEntityBinding | null): boolean => {
  if (left === null || right === null) return left === right;
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false;
  const binding = left as Record<string, unknown>;
  return binding.kind === right.kind && binding.entityId === right.entityId;
};

/** Changes only optional current-use metadata, never immutable generation
 * provenance, entity asset lists, asset roles/types or authored storyboards. */
export const bindAssetEntity = (
  project: Project, assetId: string, binding: AssetReferenceEntityBinding | null, now = Date.now(),
): Project => {
  const assets = project.assets.filter((asset) => asset.id === assetId);
  if (assets.length !== 1 || !isAssetCharacterBindingImage(assets[0])) throw new Error('这张图片已不存在或不是可绑定的图片，请重新选择。');
  const normalized = normalizeAssetReferenceEntityBinding(binding);
  if (binding !== null && (!normalized || exactEntityOwners(project, normalized.kind, [normalized.entityId]).length !== 1)) {
    throw new Error('所选人物、场景或物品已不存在、已归档或存在重复 ID，请重新选择当前项目的实体。');
  }
  const nextBinding = normalized ?? null;
  const characterReferenceId = nextBinding?.kind === 'character' ? nextBinding.entityId : null;
  if (sameBinding(assets[0].referenceEntityBinding, nextBinding) && assets[0].characterReferenceId === characterReferenceId) return project;
  return { ...project, updatedAt: now,
    assets: project.assets.map((asset) => asset.id === assetId
      ? { ...asset, referenceEntityBinding: nextBinding, characterReferenceId, updatedAt: now } : asset) };
};

/** Preserve the legacy character-only API, updating generic authority when it
 * already exists so old callers cannot leave conflicting associations. */
export const bindAssetCharacter = (
  project: Project, assetId: string, characterId: string | null, now = Date.now(),
): Project => {
  const assets = project.assets.filter((asset) => asset.id === assetId);
  if (assets.length !== 1 || !isAssetCharacterBindingImage(assets[0])) throw new Error('这张图片已不存在或不是可绑定的图片，请重新选择。');
  if (characterId !== null) {
    const characters = project.characters.filter((character) => character.id === characterId);
    if (typeof characterId !== 'string' || !characterId.trim() || characters.length !== 1 || characters[0].dossier?.archivedIntoCharacterId) {
      throw new Error('所选人物已不存在或已归档，请重新选择当前项目的人物。');
    }
  }
  if (assets[0].referenceEntityBinding !== undefined) {
    return bindAssetEntity(project, assetId, characterId === null ? null : { kind: 'character', entityId: characterId }, now);
  }
  if (assets[0].characterReferenceId === characterId) return project;
  return { ...project, updatedAt: now,
    assets: project.assets.map((asset) => asset.id === assetId ? { ...asset, characterReferenceId: characterId, updatedAt: now } : asset) };
};

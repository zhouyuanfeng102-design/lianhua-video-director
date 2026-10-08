import type { Character, Project, ReferenceAsset } from './types';

export const isAssetCharacterBindingImage = (asset: ReferenceAsset): boolean => (
  !['video', 'audio'].includes(asset.type)
  && !['video', 'audio'].includes(asset.mediaType || '')
  && !/^(?:video|audio)\//u.test(asset.mimeType || '')
);

/** An explicit unbind or stale ID never falls back to the generated image's
 * original character. Names, filenames and appearances are not ID evidence. */
export const assetReferenceCharacterOwners = (project: Project, asset: ReferenceAsset): Character[] => {
  if (!isAssetCharacterBindingImage(asset) || project.assets.filter((entry) => entry.id === asset.id).length !== 1) return [];
  const exactCharacters = (ids: readonly string[]): Character[] => [...new Set(ids)].flatMap((id) => {
    const matches = project.characters.filter((character) => character.id === id);
    return matches.length === 1 && !matches[0].dossier?.archivedIntoCharacterId ? matches : [];
  });
  if (asset.characterReferenceId !== undefined) {
    return typeof asset.characterReferenceId === 'string' && asset.characterReferenceId.trim()
      ? exactCharacters([asset.characterReferenceId]) : [];
  }
  if (asset.sourceEntityId || asset.sourceEntityKind) {
    if (!asset.sourceEntityId || asset.sourceEntityKind && asset.sourceEntityKind !== 'character' || ['location', 'prop'].includes(asset.type)) return [];
    if (project.locations.some((entity) => entity.id === asset.sourceEntityId) || project.props.some((entity) => entity.id === asset.sourceEntityId)) return [];
    const owners = exactCharacters([asset.sourceEntityId]);
    return asset.sourceEntityKind === 'character' ? owners : owners.filter((owner) => owner.assetIds.includes(asset.id));
  }
  return exactCharacters(project.characters.filter((character) => character.assetIds.includes(asset.id)).map((character) => character.id));
};

/** Changes only optional asset metadata. Existing storyboards, authored prompt
 * strings, generation sources and character asset lists remain untouched. */
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
  if (assets[0].characterReferenceId === characterId) return project;
  return { ...project, updatedAt: now,
    assets: project.assets.map((asset) => asset.id === assetId ? { ...asset, characterReferenceId: characterId, updatedAt: now } : asset) };
};

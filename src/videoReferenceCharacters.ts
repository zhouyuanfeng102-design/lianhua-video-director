import type { Character, Project, ReferenceAsset } from './types';
import type { VideoImageReference } from './videoGenerationTypes';
import { assetReferenceCharacterOwners, isAssetCharacterBindingImage } from './assetCharacterBinding';

export interface VideoCharacterReferenceState {
  characterId: string;
  name: string;
  status: 'unselected' | 'bound' | 'pending';
  /** Actual media ordinals when proven, otherwise the selected physical slots. */
  slots: number[];
  reason?: string;
}

/** Invalid explicit selection metadata never authorizes an ownership fallback. */
export const videoReferenceCharacterBindingWarning = (reference: Pick<VideoImageReference, 'characterIds'>): string | undefined => {
  const ids: unknown = reference.characterIds;
  return ids !== undefined && (!Array.isArray(ids) || Array.from(ids).some((id) => typeof id !== 'string'))
    ? '人物绑定资料格式无效，已按未绑定处理；未借用资产人物，仅提示，不阻止生成。' : undefined;
};

/** Both prompt formats use explicit identities, never filenames or cast order. */
export const videoReferenceCharacterOwners = (
  project: Project, asset: ReferenceAsset, reference?: VideoImageReference,
): Character[] => {
  if (!isAssetCharacterBindingImage(asset) || project.assets.filter((entry) => entry.id === asset.id).length !== 1) return [];
  if (reference?.characterIds !== undefined) {
    if (videoReferenceCharacterBindingWarning(reference)) return [];
    return [...new Set(reference.characterIds)].flatMap((id) => {
      const matches = project.characters.filter((character) => character.id === id);
      return matches.length === 1 && !matches[0].dossier?.archivedIntoCharacterId ? matches : [];
    });
  }
  return assetReferenceCharacterOwners(project, asset);
};

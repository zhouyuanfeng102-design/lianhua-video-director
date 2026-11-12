import { hasNsfwDetailSignal } from './promptConstraints';
import type {
  Character,
  CharacterNsfwProfile,
  NsfwPrivatePart,
  NsfwShotContinuityState,
  ReferenceAsset,
  Storyboard,
  VideoShot,
} from './types';
import { resolveNsfwShotContinuityStates } from './continuity';
import { VIDEO_PRIVATE_PARTS, type VideoPrivateScope } from './videoPrivateScope';

const privatePartPatterns: Readonly<Record<Exclude<NsfwPrivatePart, 'full-body'>, RegExp>> = {
  breasts: /(?:胸部|乳房|乳头|乳晕|双乳|breasts?|nipples?|areola)/iu,
  vulva: /(?:外阴|阴唇|阴蒂|阴道|小穴|穴口|vulva|vagina|clitoris)/iu,
  anus: /(?:肛门|后穴|臀缝|菊穴|anus|anal\s+(?:opening|area))/iu,
  penis: /(?:阴茎|阳具|肉棒|龟头|penis|glans)/iu,
  scrotum: /(?:阴囊|睾丸|卵蛋|scrotum|testicles?)/iu,
};

const privatePartLabels: Readonly<Record<NsfwPrivatePart, string>> = {
  'full-body': '私密全身',
  breasts: '胸部',
  vulva: '外阴',
  anus: '后庭',
  penis: '阴茎',
  scrotum: '阴囊',
};

const privateProfileValueByPart = (
  profile: CharacterNsfwProfile,
  part: NsfwPrivatePart,
): string => ({
  'full-body': profile.fullBody,
  breasts: profile.breasts,
  vulva: profile.vulva,
  anus: profile.anus,
  penis: profile.penis,
  scrotum: profile.scrotum,
}[part] || '').trim();

export const characterNsfwProfileText = (
  profile: CharacterNsfwProfile | undefined,
  parts: readonly NsfwPrivatePart[] = ['full-body', 'breasts', 'vulva', 'anus', 'penis', 'scrotum'],
): string => profile
  ? parts.flatMap((part) => {
      const value = privateProfileValueByPart(profile, part);
      return value ? [`${privatePartLabels[part]}：${value}`] : [];
    }).join('；')
  : '';

const compact = (value: unknown): string => typeof value === 'string'
  ? value.replace(/[\r\n]+/gu, ' ').trim()
  : '';

const stateEvidence = (state?: NsfwShotContinuityState): string => state
  ? [state.nudity, state.clothingState, state.contact, state.actionStage, state.residue]
      .map(compact)
      .filter(Boolean)
      .join('；')
  : '';

export const isNsfwPrivateProfileAsset = (
  asset: Pick<ReferenceAsset, 'referenceScope' | 'imageVariant' | 'nsfwPrivatePart' | 'tags'> | undefined,
): boolean => Boolean(asset && (
  asset.referenceScope === 'nsfw-private-profile'
  || asset.nsfwPrivatePart
  || asset.imageVariant === 'private-full-body'
  || asset.imageVariant === 'private-turnaround'
  || asset.imageVariant === 'private-five-view'
  || asset.imageVariant === 'private-four-in-one'
  || asset.imageVariant === 'private-close-up'
  || (asset.tags || []).some((tag) => /^(?:nsfw-private-profile|私密资料图)$/iu.test(compact(tag)))
));

export const nsfwPrivatePartForAsset = (
  asset: Pick<ReferenceAsset, 'imageVariant' | 'nsfwPrivatePart'>,
): NsfwPrivatePart | undefined => asset.nsfwPrivatePart
  || (asset.imageVariant === 'private-full-body'
    || asset.imageVariant === 'private-turnaround'
    || asset.imageVariant === 'private-five-view'
    || asset.imageVariant === 'private-four-in-one'
    ? 'full-body'
    : undefined);

export const nsfwPrivatePartsInEvidence = (...values: unknown[]): NsfwPrivatePart[] => {
  const evidence = values.map(compact).filter(Boolean).join('\n');
  return (Object.entries(privatePartPatterns) as Array<[Exclude<NsfwPrivatePart, 'full-body'>, RegExp]>)
    .filter(([, pattern]) => pattern.test(evidence))
    .map(([part]) => part);
};

export const isNsfwShotContext = (
  evidence: string,
  state?: NsfwShotContinuityState,
): boolean => hasNsfwDetailSignal(evidence, stateEvidence(state));

export interface NsfwPrivateAssetShotContext {
  /** Exact current-shot prose and source excerpt, never a project-wide story dump. */
  evidence: string;
  state?: NsfwShotContinuityState;
  /** Visible character ids. Supplying this list prevents cross-character leakage. */
  characterIds?: readonly string[];
  /** Names used to attribute an anatomy/state mention in a multi-person shot. */
  characterNamesById?: Readonly<Record<string, string>>;
  /** Explicit current-shot selection authored by the planning/review AI. */
  visiblePrivatePartsByCharacter?: VideoPrivateScope;
}

/** Return only the stable private-profile fields that this exact performer is
 * allowed to contribute to the current shot text/reference context. */
export const nsfwPrivateProfilePartsForCharacter = (
  context: NsfwPrivateAssetShotContext,
  characterId: string,
): NsfwPrivatePart[] => {
  if (!context.characterIds?.includes(characterId)) return [];
  const requested = context.visiblePrivatePartsByCharacter?.[characterId];
  // Do not infer permission from body words, contact, clothing state, or a
  // project-wide NSFW flag. Only the AI's explicit per-shot selection routes
  // stored private data; its authored source/visible actions stay untouched.
  return Array.isArray(requested) ? VIDEO_PRIVATE_PARTS.filter((part) => requested.includes(part)) : [];
};

/**
 * Private reference images are opt-in per shot. They never participate in an
 * ordinary character lock and cannot be borrowed by a different performer.
 */
export const canUseNsfwPrivateProfileAsset = (
  asset: ReferenceAsset,
  context: NsfwPrivateAssetShotContext,
): boolean => {
  if (!isNsfwPrivateProfileAsset(asset)) return true;
  if (!asset.sourceEntityId) return false;
  if (asset.imageVariant === 'private-four-in-one') {
    // This multi-panel dossier necessarily carries additional unrelated
    // anatomy. It remains available in the explicitly selected private-image
    // workbench, but is not an automatic shot reference.
    return false;
  }
  const part = nsfwPrivatePartForAsset(asset);
  if (!part) return false;
  return nsfwPrivateProfilePartsForCharacter(context, asset.sourceEntityId).includes(part);
};

export const filterNsfwPrivateProfileAssetsForShot = (
  assets: readonly ReferenceAsset[],
  context: NsfwPrivateAssetShotContext,
): ReferenceAsset[] => assets.filter((asset) => canUseNsfwPrivateProfileAsset(asset, context));

export const nsfwPrivateAssetContextForStoryboardShot = (
  storyboard: Pick<Storyboard, 'shots' | 'sourceStoryContent'>,
  shot: VideoShot,
  characters: readonly Pick<Character, 'id' | 'name'>[],
): NsfwPrivateAssetShotContext => {
  const offset = storyboard.shots.findIndex((candidate) => candidate.id === shot.id);
  const sourceExcerpt = Number.isInteger(shot.sourceStart)
    && Number.isInteger(shot.sourceEnd)
    && (shot.sourceStart as number) >= 0
    && (shot.sourceEnd as number) > (shot.sourceStart as number)
      ? (storyboard.sourceStoryContent || '').slice(shot.sourceStart, shot.sourceEnd)
      : shot.sourceExcerpt || '';
  const evidence = [
    sourceExcerpt,
    shot.purpose,
    shot.subject,
    shot.action,
    shot.result,
    shot.prompt,
  ].map(compact).filter(Boolean).join('\n');
  const visibleCharacters = characters.filter(
    (character) => character.name.trim() && (
      evidence.includes(character.name.trim())
      || Boolean(shot.visiblePrivatePartsByCharacter?.[character.id]?.length)
    ),
  );
  return {
    evidence,
    state: offset >= 0 ? resolveNsfwShotContinuityStates(storyboard.shots)[offset] : undefined,
    characterIds: visibleCharacters.map((character) => character.id),
    characterNamesById: Object.fromEntries(
      visibleCharacters.map((character) => [character.id, character.name]),
    ),
    visiblePrivatePartsByCharacter: shot.visiblePrivatePartsByCharacter,
  };
};

export const canUseNsfwPrivateProfileAssetForStoryboardShot = (
  asset: ReferenceAsset,
  storyboard: Pick<Storyboard, 'shots' | 'sourceStoryContent'>,
  shot: VideoShot,
  characters: readonly Pick<Character, 'id' | 'name'>[],
): boolean => canUseNsfwPrivateProfileAsset(
  asset,
  nsfwPrivateAssetContextForStoryboardShot(storyboard, shot, characters),
);

const privatePartEnglish: Readonly<Record<NsfwPrivatePart, string>> = {
  'full-body': 'private full body',
  breasts: 'chest',
  vulva: 'vulva',
  anus: 'anus',
  penis: 'penis',
  scrotum: 'scrotum',
};

export const privateReferencePronoun = (gender: string | undefined): '她' | '他' | '这个人' => {
  const value = gender || '';
  if (/女|female|woman/iu.test(value)) return '她';
  if (/男|male|\bman\b/iu.test(value)) return '他';
  return '这个人';
};

/** Picture duty for one selected private image. The shot action stays the model's text. */
export const privatePartReferenceDuty = (
  asset: Pick<ReferenceAsset, 'nsfwPrivatePart' | 'imageVariant'>,
  ownerName?: string,
  gender?: string,
): readonly [string, string] => {
  const named = Boolean(ownerName?.trim()) && ownerName?.trim() !== '本槽已选人物';
  const name = named ? ownerName!.trim() : '本槽已选人物';
  const enName = named ? ownerName!.trim() : 'the person selected for this slot';
  const several = named && name.includes('、');
  const pronoun = named && !several ? privateReferencePronoun(gender) : '这个人';
  const person = !named ? '这个人仍用人物参考'
    : several ? `${name}仍用各自的人物参考`
    : `${name}这个人仍用${pronoun}的人物参考`;
  const enPerson = !named ? 'That person remains the person in the character reference'
    : several ? `${enName} remain the people in their character references`
    : `${enName} remains the person in the character reference`;
  const sheet = asset.imageVariant === 'private-four-in-one';
  const part = nsfwPrivatePartForAsset(asset);
  const label = part ? privatePartLabels[part] : '私密部位';
  const enLabel = part ? privatePartEnglish[part] : 'private part';
  if (sheet) {
    return [
      `是${name}的私密资料板。只取正文已经写到的那一格的形状、颜色和纹理。分格版式留在资料里。${person}。正文已经呈现对应部位时，形状、颜色和纹理沿用那一格；这一镜的衣着和遮挡仍按该镜原文。这张图留在部位参考，不占开场画面`,
      `is ${enName}'s private reference sheet. Use only the panel for the part this shot already writes, and keep its shape, color and texture. The grid stays in the sheet. ${enPerson}. When the written shot shows that part, its shape, color and texture remain those in that panel, and the clothes in that shot remain as written. This picture stays a part reference and remains out of the opening frame`,
    ];
  }
  return [
    `是${name}的${label}，提供这一部位的形状、颜色和纹理。${person}。正文已经呈现这个部位时，形状、颜色和纹理沿用这张图；这一镜的衣着和遮挡仍按该镜原文。这张图留在部位参考，不占开场画面`,
    `is ${enName}'s ${enLabel} and supplies that part's shape, color and texture. ${enPerson}. When the written shot shows this part, its shape, color and texture remain those in this picture, and the clothes in that shot remain as written. This picture stays a part reference and remains out of the opening frame`,
  ];
};

export const nsfwPrivateReferenceResponsibility = (
  asset: Pick<ReferenceAsset, 'nsfwPrivatePart' | 'imageVariant'>,
): string => privatePartReferenceDuty(asset)[0];

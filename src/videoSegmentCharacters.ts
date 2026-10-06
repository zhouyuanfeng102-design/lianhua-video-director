import { characterVariantAliases, characterVariantDisplayName } from './characterVariants';
import { semanticSequenceCharacters } from './semanticSequencePlan';
import type { Character, Project, ReferenceAsset, Storyboard, VideoSegment, VideoSequencePlan, VideoShot } from './types';

export interface VideoSegmentCharacterHint {
  id: string;
  name: string;
  /** Number of distinct source fields that identified this character. */
  evidenceCount: number;
  /** Explicitly associated image assets, when available. */
  referenceImageCount: number;
}

export interface VideoSegmentCharacterHintResult {
  characters: VideoSegmentCharacterHint[];
  usedFallback: boolean;
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const unique = <T,>(values: readonly T[]): T[] => [...new Set(values)];

const isImageAsset = (asset: ReferenceAsset): boolean => (
  asset.type !== 'video' && asset.type !== 'audio'
  && asset.mediaType !== 'video' && asset.mediaType !== 'audio'
  && !asset.mimeType?.startsWith('video/') && !asset.mimeType?.startsWith('audio/')
);

const characterNames = (character: Character): string[] => unique([
  characterVariantDisplayName(character), character.name,
  ...(character.aliases || []),
  ...characterVariantAliases(character), ...(character.dossier?.aliases || []),
].map(text).filter((value) => value.length >= 2));

const textFieldsForShot = (shot: VideoShot): string[] => [
  shot.subject, shot.action, shot.purpose, shot.space, shot.performance,
  shot.direction, shot.dialogue, shot.result, shot.sourceExcerpt,
].map(text).filter((value): value is string => Boolean(value));

const textFieldsForSegment = (segment: VideoSegment): string[] => [
  segment.content, segment.summary, segment.narrativePurpose, segment.entryState,
  segment.exitState, segment.transitionHint, segment.continuityPack,
  ...(segment.semanticSource?.sourceEvidence || []).map((item) => text(item.text)),
  ...(segment.semanticSource?.dialogues || []).flatMap((item) => [text(item.speaker), text(item.text)]),
].filter((value): value is string => Boolean(value));

const sourceScenes = (project: Project, segment: VideoSegment, board?: Storyboard): Project['scenes'] => {
  const ids = unique([...(segment.sourceSceneIds || []), ...(board?.sourceSceneIds || [])]);
  const live = project.scenes.filter((scene) => ids.includes(scene.id));
  const snapshots = (board?.sourceSceneSnapshots || []).filter((scene) => !live.some((item) => item.id === scene.id)
    && (!ids.length || ids.includes(scene.id)));
  return [...live, ...snapshots];
};

const sourceShots = (segment: VideoSegment, board?: Storyboard): VideoShot[] => {
  if (!board) return [];
  const ids = segment.sourceShotIds || [];
  if (ids.length) return ids.flatMap((id) => board.shots.filter((shot) => shot.id === id));
  // Legacy segment boards contain only the shots for that segment. Keeping
  // this fallback makes the hint useful without inventing source IDs.
  return board.shots;
};

/**
 * Resolve the characters that a video segment is about for a display-only
 * picker hint. Structured scene/shot IDs are preferred; text matching is only
 * a compatibility fallback for semantic and legacy projects. This function
 * never changes selection, prompts, or generation state.
 */
export const videoSegmentCharacterHints = (
  project: Project,
  plan: VideoSequencePlan | undefined,
  segment: VideoSegment,
  board?: Storyboard,
): VideoSegmentCharacterHintResult => {
  const characters = semanticSequenceCharacters(plan, project.characters)
    .filter((character) => !character.dossier?.archivedIntoCharacterId);
  const byId = new Map(characters.map((character) => [character.id, character]));
  const evidence = new Map<string, number>();
  const add = (id: string | undefined) => {
    if (!id || !byId.has(id)) return;
    evidence.set(id, (evidence.get(id) || 0) + 1);
  };
  const addByText = (values: readonly string[]) => {
    const joined = values.join('\n');
    if (!joined) return;
    characters.forEach((character) => {
      if (characterNames(character).some((name) => joined.includes(name))) add(character.id);
    });
  };

  sourceScenes(project, segment, board).forEach((scene) => scene.characterIds.forEach(add));
  const shots = sourceShots(segment, board);
  const shotTexts = shots.flatMap(textFieldsForShot);
  addByText([...textFieldsForSegment(segment), ...shotTexts]);
  // A storyboard may have a saved source excerpt even when the segment was
  // imported without scene IDs. It is evidence, not a replacement for the
  // segment's own text.
  if (!evidence.size && board?.sourceStoryContent) addByText([board.sourceStoryContent]);

  const assetCounts = new Map<string, number>();
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  characters.forEach((character) => {
    const count = unique(character.assetIds || [])
      .map((id) => assets.get(id))
      .filter((asset): asset is ReferenceAsset => Boolean(asset && isImageAsset(asset) && !asset.missing)).length;
    if (count) assetCounts.set(character.id, count);
  });

  const result = [...evidence.entries()].flatMap(([id, evidenceCount]) => {
    const character = byId.get(id);
    if (!character) return [];
    return [{
      id,
      name: characterVariantDisplayName(character) || character.name,
      evidenceCount,
      referenceImageCount: assetCounts.get(id) || 0,
    }];
  });
  return { characters: result, usedFallback: !segment.sourceShotIds?.length || !segment.sourceSceneIds?.length };
};

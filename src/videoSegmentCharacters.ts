import { characterVariantDisplayName } from './characterVariants';
import { resolvePromptCharacterParticipation, resolveStoryboardCharacterParticipation } from './characterParticipation';
import { semanticSequenceCharacters } from './semanticSequencePlan';
import type { Project, ReferenceAsset, Storyboard, VideoSegment, VideoSequencePlan } from './types';

export interface VideoSegmentCharacterHint {
  id: string;
  name: string;
  presence: 'visible' | 'offscreen' | 'mentioned';
  shotIndexes: number[];
  evidenceCount: number;
  /** Available images explicitly owned by the same character ID. */
  referenceImageCount: number;
}

export interface VideoSegmentCharacterHintResult {
  characters: VideoSegmentCharacterHint[];
  mentionedCharacters: VideoSegmentCharacterHint[];
  ambiguousNames: string[];
  usedFallback: boolean;
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const unique = <T,>(values: readonly T[]): T[] => [...new Set(values)];
const isImageAsset = (asset: ReferenceAsset): boolean => (
  asset.type !== 'video' && asset.type !== 'audio'
  && asset.mediaType !== 'video' && asset.mediaType !== 'audio'
  && !asset.mimeType?.startsWith('video/') && !asset.mimeType?.startsWith('audio/')
);

/** A display-only view of the same participation resolver used by submission.
 * The selected final prompt is authoritative. Source prose is used only before
 * a prompt exists, so surrounding chapters and mere dialogue mentions cannot
 * silently become on-screen characters. This never selects images or edits a
 * saved prompt, character dossier or frozen planning snapshot. */
export const videoSegmentCharacterHints = (
  project: Project,
  plan: VideoSequencePlan | undefined,
  segment?: VideoSegment,
  board?: Storyboard,
  selectedPrompt?: string,
): VideoSegmentCharacterHintResult => {
  const characters = semanticSequenceCharacters(plan, project.characters)
    .filter((character) => !character.dossier?.archivedIntoCharacterId);
  const prompt = selectedPrompt !== undefined ? selectedPrompt
    : board?.officialPromptZh || board?.finalPrompt || board?.shots.map((shot) => shot.prompt).filter(Boolean).join('\n') || '';
  const fallbackText = segment ? [segment.content, segment.summary, segment.narrativePurpose,
    ...(segment.semanticSource?.sourceEvidence || []).map((item) => item.text),
    ...(segment.semanticSource?.dialogues || []).map((item) => `${item.speaker}：“${item.text}”`),
  ].map(text).filter(Boolean).join('\n') : '';
  const participation = board && prompt
    ? resolveStoryboardCharacterParticipation(board, characters, prompt)
    : resolvePromptCharacterParticipation(prompt || fallbackText, characters);
  const byId = new Map(characters.map((character) => [character.id, character]));
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const hints = participation.characters.flatMap((entry): VideoSegmentCharacterHint[] => {
    const character = byId.get(entry.characterId);
    if (!character) return [];
    const referenceImageCount = unique(character.assetIds || []).map((id) => assets.get(id))
      .filter((asset) => Boolean(asset && isImageAsset(asset) && !asset.missing)).length;
    return [{ id: character.id, name: characterVariantDisplayName(character) || character.name,
      presence: entry.presence, shotIndexes: entry.shotIndexes,
      evidenceCount: entry.evidence.length, referenceImageCount }];
  });
  return {
    characters: hints.filter((entry) => entry.presence !== 'mentioned'),
    mentionedCharacters: hints.filter((entry) => entry.presence === 'mentioned'),
    ambiguousNames: participation.ambiguousNames,
    usedFallback: participation.usedFallback,
  };
};

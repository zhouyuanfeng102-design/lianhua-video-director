import { characterParticipationAliases } from './characterParticipation';
import type { Character, SemanticSegmentSource, VideoSegment } from './types';

type IdentityCharacter = Pick<Character, 'id' | 'name'> & Partial<Pick<Character,
  'aliases' | 'baseName' | 'formLabel' | 'variantOf' | 'transformationType' | 'dossier'>>;

export interface SemanticSegmentIdentityReferenceInput {
  characters: readonly IdentityCharacter[];
  content: string;
  contentOverridden?: boolean;
  segment: Pick<VideoSegment, 'entryState' | 'exitState'> & { semanticSource?: SemanticSegmentSource };
  /** Already saved scene identities are reference candidates, never a cast list. */
  savedSceneCharacterIds?: readonly string[];
}

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const containsAlias = (content: string, alias: string): boolean => (
  /^[\x00-\x7f]+$/u.test(alias)
    ? new RegExp(`(?<![A-Za-z0-9_])${escaped(alias)}(?![A-Za-z0-9_])`, 'iu').test(content)
    : content.includes(alias)
);

/** Collect only identity facts already linked to this segment. Matching a
 * name supplies its saved identity; it does not decide whether that person is
 * visible, off-screen, mentioned, or required in any shot. Full-story prose,
 * source evidence and character dossiers are not performance instructions.
 * A replaced body does not inherit removed actors from historical metadata. */
export const semanticSegmentIdentityReferenceIds = (
  input: SemanticSegmentIdentityReferenceInput,
): string[] => {
  const catalog = input.characters.filter((character) => !character.dossier?.archivedIntoCharacterId);
  const knownIds = new Set(catalog.map((character) => character.id));
  const aliases = catalog.map((character) => ({
    id: character.id, aliases: characterParticipationAliases(character, catalog),
  }));
  const references = new Set<string>();
  const addAliases = (content: string): void => {
    for (const character of aliases) {
      if (character.aliases.some((alias) => containsAlias(content, alias))) references.add(character.id);
    }
  };
  const addIdentity = (id: string | undefined, label: string): void => {
    if (id && knownIds.has(id)) references.add(id);
    else if (knownIds.has(label.trim())) references.add(label.trim());
    else addAliases(label);
  };

  addAliases(input.content);
  if (!input.contentOverridden) {
    addAliases([input.segment.entryState, input.segment.exitState].join('\n'));
    for (const id of input.savedSceneCharacterIds || []) {
      if (knownIds.has(id)) references.add(id);
    }
    for (const { causality } of input.segment.semanticSource?.events || []) {
      if (!causality) continue;
      if (causality.certainty !== 'unknown') addIdentity(causality.actorCharacterId, causality.actor);
      addIdentity(causality.targetCharacterId, causality.target);
    }
    for (const dialogue of input.segment.semanticSource?.dialogues || []) {
      addIdentity(undefined, dialogue.speaker);
    }
  }
  return catalog.filter((character) => references.has(character.id)).map((character) => character.id);
};

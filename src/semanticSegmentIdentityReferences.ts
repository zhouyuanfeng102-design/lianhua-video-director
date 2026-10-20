import { characterParticipationAliases } from './characterParticipation';
import type { SceneStaging } from './sceneStaging';
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

/** Adopted participants describe scene identity, not camera visibility. Local
 * participant IDs can name the same saved character through an explicit name;
 * a phase can also reference a stable character ID directly. */
export const sceneStagingIdentityReferenceIds = (
  characters: readonly IdentityCharacter[],
  stages: readonly SceneStaging[],
): string[] => {
  const catalog = characters.filter((character) => !character.dossier?.archivedIntoCharacterId);
  const knownIds = new Set(catalog.map((character) => character.id));
  const aliases = catalog.map((character) => ({
    id: character.id, aliases: characterParticipationAliases(character, catalog),
  }));
  const references = new Set<string>();
  for (const stage of stages) {
    const localIds = new Map<string, string>();
    for (const participant of stage.participants || []) {
      const id = knownIds.has(participant.id) ? participant.id
        : aliases.find((character) => character.aliases.includes(participant.name?.trim() || participant.id))?.id;
      if (id) {
        localIds.set(participant.id, id);
        references.add(id);
      }
    }
    for (const phase of stage.phases || []) for (const participantId of phase.participantIds || []) {
      const id = knownIds.has(participantId) ? participantId : localIds.get(participantId);
      if (id) references.add(id);
    }
  }
  return catalog.filter((character) => references.has(character.id)).map((character) => character.id);
};

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
      for (const id of causality.targetCharacterIds || []) if (knownIds.has(id)) references.add(id);
    }
    for (const dialogue of input.segment.semanticSource?.dialogues || []) {
      addIdentity(dialogue.speakerCharacterId, dialogue.speaker);
      for (const id of [...(dialogue.listenerCharacterIds || []), ...(dialogue.addressedCharacterIds || [])]) {
        if (knownIds.has(id)) references.add(id);
      }
    }
    for (const id of sceneStagingIdentityReferenceIds(catalog, input.segment.semanticSource?.sceneStaging || [])) references.add(id);
  }
  return catalog.filter((character) => references.has(character.id)).map((character) => character.id);
};

import type { Character } from './types';
import { normalizeCharacterVoiceProfile } from './characterVoiceProfile';

/** Read-only source facts for text models. Visual and actual age remain
 * separate; this helper never infers a voice age, pitch or speaking cast. */
export const characterVoiceIdentityFacts = (character: Pick<Character, 'name'> & Partial<Pick<Character,
  'id' | 'gender' | 'apparentAge' | 'actualAge' | 'voiceProfile'
>>) => {
  const voiceProfile = normalizeCharacterVoiceProfile(character.voiceProfile);
  return {
    ...(character.id ? { id: character.id } : {}),
    name: character.name,
    gender: character.gender,
    apparentAge: character.apparentAge,
    actualAge: character.actualAge,
    ...(voiceProfile ? { voiceProfile } : {}),
  };
};

export type CharacterVoiceIdentityFacts = ReturnType<typeof characterVoiceIdentityFacts>;

/** Current same-ID voice edits are explicit overrides for new casting only.
 * Frozen narrative names and ordinary character facts are never replaced. */
export const currentCharacterVoiceFacts = (
  frozenCharacters: readonly (Pick<Character, 'name'> & Partial<Pick<Character, 'id'>>)[],
  currentCharacters: readonly (Pick<Character, 'id'> & Partial<Pick<Character, 'voiceProfile'>>)[],
) => frozenCharacters.flatMap((frozen) => {
  const current = frozen.id ? currentCharacters.find((character) => character.id === frozen.id) : undefined;
  return current ? [{ id: current.id, name: frozen.name, voiceProfile: normalizeCharacterVoiceProfile(current.voiceProfile) || null }] : [];
});

export type CurrentCharacterVoiceFacts = ReturnType<typeof currentCharacterVoiceFacts>;

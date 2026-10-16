/** A deliberate voice identity, independent from a character's visual or actual age. */
export interface CharacterVoiceProfile {
  version: number;
  perceivedAge?: string;
  timbre?: string;
  language?: string;
  accent?: string;
  style?: string;
  notes?: string;
  referenceAssetId?: string;
  source?: 'manual' | 'story' | 'reference';
}

export const CHARACTER_VOICE_PROFILE_FIELDS = [
  'perceivedAge', 'timbre', 'language', 'accent', 'style', 'notes', 'referenceAssetId',
] as const;
export type CharacterVoiceProfileField = typeof CHARACTER_VOICE_PROFILE_FIELDS[number];

/** Missing/empty input stays absent. Metadata alone never creates a voice identity. */
export const normalizeCharacterVoiceProfile = (value: unknown): CharacterVoiceProfile | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const profile: CharacterVoiceProfile = {
    version: typeof input.version === 'number' && Number.isSafeInteger(input.version) && input.version > 0
      ? input.version : 1,
  };
  for (const field of CHARACTER_VOICE_PROFILE_FIELDS) {
    const content = input[field];
    if (typeof content === 'string' && content.trim()) profile[field] = content.trim();
  }
  if (!CHARACTER_VOICE_PROFILE_FIELDS.some((field) => profile[field])) return undefined;
  if (input.source === 'manual' || input.source === 'story' || input.source === 'reference') profile.source = input.source;
  return profile;
};

const contentKey = (profile: CharacterVoiceProfile | undefined): string => JSON.stringify(profile
  ? { ...profile, version: undefined } : null);

/** Replace an edited profile. Whitespace-only/no-op saves do not revise its identity. */
export const updateCharacterVoiceProfile = (previous: unknown, value: unknown): CharacterVoiceProfile | undefined => {
  const current = normalizeCharacterVoiceProfile(previous);
  const candidate = normalizeCharacterVoiceProfile(value);
  if (!candidate) return undefined;
  if (contentKey(current) === contentKey(candidate)) return current;
  return { ...candidate, version: current ? Math.min(current.version + 1, Number.MAX_SAFE_INTEGER) : 1 };
};

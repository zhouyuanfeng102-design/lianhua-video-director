import type { Character, CharacterNsfwProfile, NsfwPrivatePart } from './types';

export type VideoPrivateScope = Readonly<Record<string, readonly NsfwPrivatePart[]>>;

export const VIDEO_PRIVATE_PARTS = ['full-body', 'breasts', 'vulva', 'anus', 'penis', 'scrotum'] as const;
const privateProfileKey: Readonly<Record<NsfwPrivatePart, keyof CharacterNsfwProfile>> = {
  'full-body': 'fullBody', breasts: 'breasts', vulva: 'vulva', anus: 'anus', penis: 'penis', scrotum: 'scrotum',
};

/** Metadata for the planning API: names of available fields, never values. */
export const availableVideoPrivateParts = (
  character: Pick<Character, 'nsfwProfile'>,
): NsfwPrivatePart[] => VIDEO_PRIVATE_PARTS.filter((part) => {
  const value = character.nsfwProfile?.[privateProfileKey[part]];
  return typeof value === 'string' && Boolean(value.trim());
});

export interface SelectedVideoPrivateFact {
  characterId: string;
  name: string;
  parts: NsfwPrivatePart[];
  profile: Partial<CharacterNsfwProfile>;
}

/** The AI's explicit per-shot selection is a data projection, not a semantic
 * veto. No scope means ordinary identity only. Unscoped aggregate body
 * anchors are intentionally never promoted to a visual instruction. */
export const selectedVideoPrivateFacts = (
  characters: readonly Pick<Character, 'id' | 'name' | 'nsfwProfile'>[],
  scope: VideoPrivateScope | undefined,
): SelectedVideoPrivateFact[] => {
  if (!scope) return [];
  return characters.flatMap((character) => {
    const requested = Array.isArray(scope[character.id]) ? scope[character.id] : [];
    const parts = availableVideoPrivateParts(character).filter((part) => requested.includes(part));
    if (!parts.length) return [];
    return [{
      characterId: character.id,
      name: character.name,
      parts,
      profile: Object.fromEntries(parts.map((part) => [
        privateProfileKey[part], character.nsfwProfile![privateProfileKey[part]],
      ])),
    }];
  });
};

/**
 * Request-time compatibility for the old automatically generated character
 * lock. Its private anchors were a complete dossier, not authored shot facts.
 * Never run this helper over a story, canonical prompt, or user instructions.
 * Stored source records remain untouched; ordinary identity is supplied by
 * the current character projection/subject definitions at the call site.
 */
const LEGACY_PRIVATE_LOCK_FIELD = /(?:稳定身体锚点|NSFW身体锚点)\s*[：:]/u;
const LEGACY_DYNAMIC_CLOTHING_LINE = '动态衣物优先：当前衣物与裸露状态逐镜继承；脱下后不得自动穿回，离身衣物保持位置，只有剧情明确穿回时才恢复对应着装。';

export const publicVideoContinuityLock = (value: string): string => {
  let changed = false;
  const lines = value.split(/\r?\n/u).map((line) => {
    const trimmed = line.trim();
    if (trimmed === LEGACY_DYNAMIC_CLOTHING_LINE) {
      changed = true;
      return '';
    }
    if (/^固定人物\s*[：:]/u.test(trimmed) && LEGACY_PRIVATE_LOCK_FIELD.test(trimmed)) {
      // Private values themselves may contain commas/semicolons. Dropping
      // only up to the next punctuation mark leaves the rest of the dossier.
      changed = true;
      return '';
    }
    if (!/^连续性锚点\s*[：:]/u.test(trimmed)) return line;
    // PromptPlan used to flatten the whole automatic lock into one metadata
    // constraint. Only this recognized wrapper gets compatibility handling.
    const characterStart = trimmed.search(/固定人物\s*[：:]/u);
    if (characterStart < 0 || !LEGACY_PRIVATE_LOCK_FIELD.test(trimmed.slice(characterStart))) return line;
    changed = true;
    const followingField = trimmed.slice(characterStart).search(/(?:固定场景\s*[：:]|场景序列\s*[：:]|固定道具\s*[：:]|同一镜头组中的人物身份)/u);
    const remaining = [
      trimmed.slice(0, characterStart),
      followingField >= 0 ? trimmed.slice(characterStart + followingField) : '',
    ].join('').replace(LEGACY_DYNAMIC_CLOTHING_LINE, '').trim();
    return /^连续性锚点\s*[：:]\s*$/u.test(remaining) ? '' : remaining;
  });
  return changed ? lines.filter((line) => line.trim()).join('\n') : value;
};

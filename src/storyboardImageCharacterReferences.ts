import { isUsableStoryboardReferenceAsset } from './storyboardImages';
import type { StoryboardImageBuildContext } from './storyboardImages';
import {
  storyboardReferenceCharacters,
  stripStoryboardImageReferenceMetadata,
} from './storyboardImageReferences';
import type { Character } from './types';

type CharacterReferenceContext = Pick<StoryboardImageBuildContext, 'characters' | 'assets'>;
interface NamedOccurrence { start: number; end: number; characterIds: string[] }

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const ascii = (value: string): boolean => /^[\x00-\x7f]+$/u.test(value);
const aliasKey = (value: string): string => ascii(value) ? value.toLowerCase() : value;
const aliasesFor = (character: Character): string[] => [...new Set([
  character.name, ...(character.aliases || []), ...(character.dossier?.aliases || []),
].map((name) => name.trim().replace(/^@+/u, '')).filter(Boolean))];

/** Exclude explicit absence/mention labels next to this occurrence. This is
 * deliberately not a general visibility parser: a distant figure or a back
 * view still needs its saved identity, and looking at someone says nothing
 * about whether that other person is visible. */
const explicitlyAbsent = (body: string, occurrence: NamedOccurrence): boolean => {
  const before = body.slice(Math.max(0, occurrence.start - 48), occurrence.start);
  const after = body.slice(occurrence.end, occurrence.end + 64);
  return [
    /(?:画外|镜头外|镜外|场外|画面外|未入镜|未出镜|不入镜)(?:的)?\s*[@“"「『]?$/u.test(before),
    /(?:只|仅)(?:是|在)?(?:提及|提到|谈及|讨论)(?:了|的)?\s*[@“"「『]?$/u.test(before),
    /\b(?:off[- ]?screen|out of (?:the )?(?:frame|shot)|outside (?:the )?frame)\s*[:：,，-]?\s*[@“"]?$/iu.test(before),
    /^[”"」』]?\s*(?:[（(]\s*)?(?:(?:本人|本镜|此时|仍然|依然|明确|实际|始终|并|则|完全|仅|只)\s*)*(?:没有|并未|未|不曾|不)(?:实际)?(?:出镜|入镜|出现在画面|在画面(?:中|内)?)/u.test(after),
    /^[”"」』]?\s*(?:[（(]\s*)?(?:(?:本人|本镜|此时|仍然|依然|明确|始终|完全)\s*)*(?:位于|处于|留在|仍在|在)?(?:画外|镜头外|镜外|场外|画面外)/u.test(after),
    /^[”"」』]?\s*(?:只|仅)(?:是|在)?(?:被提及|被谈及|被讨论|出现在对白|出现在台词)/u.test(after),
    /^[”"]?\s*(?:[,，:(（-]\s*)?(?:(?:is|remains?|stays?)\s+)?(?:off[- ]?screen|out of (?:the )?(?:frame|shot)|outside (?:the )?frame|not (?:visible|shown|in (?:the )?frame)|only mentioned)\b/iu.test(after),
  ].some(Boolean);
};

/** The final picture prose can name a secondary character omitted by the
 * earlier shot-level cast decision. Attach one current ordinary identity
 * image for each uniquely named character without rewriting that prose or
 * changing any explicitly selected reference or its upload order. */
export const supplementStoryboardImageCharacterReferences = (
  prompt: string,
  referenceAssetIds: readonly string[],
  context: CharacterReferenceContext,
): string[] => {
  const result = [...referenceAssetIds];
  const body = stripStoryboardImageReferenceMetadata(prompt);
  const characters = context.characters.filter((character) => !character.dossier?.archivedIntoCharacterId);
  const aliases = new Map<string, { name: string; characterIds: string[] }>();
  for (const character of characters) {
    for (const name of aliasesFor(character)) {
      const key = aliasKey(name);
      const entry = aliases.get(key) || { name, characterIds: [] };
      if (!entry.characterIds.includes(character.id)) entry.characterIds.push(character.id);
      aliases.set(key, entry);
    }
  }
  const occurrences: NamedOccurrence[] = [];
  for (const { name, characterIds } of aliases.values()) {
    const pattern = new RegExp(ascii(name)
      ? `(?<![A-Za-z0-9_])${escaped(name)}(?![A-Za-z0-9_])`
      : escaped(name), ascii(name) ? 'giu' : 'gu');
    for (const match of body.matchAll(pattern)) {
      occurrences.push({ start: match.index!, end: match.index! + match[0].length, characterIds });
    }
  }
  const namedCharacterIds = new Set(occurrences.filter((occurrence) => (
    occurrence.characterIds.length === 1
    && !occurrences.some((longer) => longer.start <= occurrence.start && longer.end >= occurrence.end
      && longer.end - longer.start > occurrence.end - occurrence.start)
    && !explicitlyAbsent(body, occurrence)
  )).flatMap((occurrence) => occurrence.characterIds));
  const usableAssets = context.assets.filter(isUsableStoryboardReferenceAsset);
  const ownersByAssetId = new Map(usableAssets.map((asset) => [
    asset.id, storyboardReferenceCharacters(asset, { characters }).map((character) => character.id),
  ]));
  const coveredCharacterIds = new Set(referenceAssetIds.flatMap((id) => ownersByAssetId.get(id) || []));
  const selectedIds = new Set(referenceAssetIds);
  for (const character of characters) {
    if (!namedCharacterIds.has(character.id) || coveredCharacterIds.has(character.id)) continue;
    const candidates = usableAssets.filter((asset) => ownersByAssetId.get(asset.id)?.includes(character.id));
    const byId = new Map(candidates.map((asset) => [asset.id, asset]));
    const preferred = (character.assetIds || []).map((id) => byId.get(id)).find(Boolean)
      || candidates.reduce<(typeof candidates)[number] | undefined>((latest, asset) => (
        !latest || asset.createdAt > latest.createdAt ? asset : latest
      ), undefined);
    if (!preferred) continue;
    if (!selectedIds.has(preferred.id)) {
      result.push(preferred.id);
      selectedIds.add(preferred.id);
    }
    for (const id of ownersByAssetId.get(preferred.id) || []) coveredCharacterIds.add(id);
  }
  return result;
};

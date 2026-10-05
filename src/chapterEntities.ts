import type { Character, Location, Prop, Project } from './types';
import type { StoryAnalysisResponse } from './services/llm';
import { canonicalCharacterVariantName } from './characterVariants';
import { isDossierFieldConfirmed } from './characterDossierPolicy';

export type ChapterEntityKind = 'character' | 'location' | 'prop';
export interface ChapterEntityCatalogEntry {
  id: string;
  name: string;
  aliases: string[];
  baseCharacterId?: string;
  baseName?: string;
  formLabel?: string;
  description?: string;
}
export interface ChapterEntityCatalog {
  characters: ChapterEntityCatalogEntry[];
  locations: ChapterEntityCatalogEntry[];
  props: ChapterEntityCatalogEntry[];
}
export interface ChapterEntityConflict {
  kind: ChapterEntityKind;
  name: string;
  candidateIds: string[];
  reason: string;
}
type EntityRecord = {
  id: string;
  name: string;
  aliases?: string[];
  sourceChapterIds?: string[];
  existingEntityId?: string;
  baseCharacterId?: string;
  baseName?: string;
  formLabel?: string;
  dossier?: Character['dossier'];
  assetIds?: readonly string[];
};
const strings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))] : [];
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const canonicalName = (value: unknown, kind: ChapterEntityKind): string => kind === 'character'
  ? canonicalCharacterVariantName(typeof value === 'string' ? value : value as Record<string, unknown>)
  : typeof value === 'string' ? value.trim() : text((value as Record<string, unknown>)?.name);
const entityAliases = (record: EntityRecord | ChapterEntityCatalogEntry): string[] => strings([
  ...(record.aliases || []), ...('dossier' in record ? record.dossier?.aliases || [] : []),
]);
const catalogKey = (kind: ChapterEntityKind): keyof ChapterEntityCatalog => kind === 'character' ? 'characters' : kind === 'location' ? 'locations' : 'props';

/** A compact shared identity directory. Full chapter text is never truncated. */
export const buildChapterEntityCatalog = (project: Pick<Project, 'characters' | 'locations' | 'props'>): ChapterEntityCatalog => {
  const entry = (record: Character | Location | Prop, kind: ChapterEntityKind): ChapterEntityCatalogEntry => {
    const source = record as unknown as Record<string, unknown>;
    return {
      id: record.id, name: canonicalName(record, kind), aliases: entityAliases(record),
      ...(text(source.baseCharacterId) ? { baseCharacterId: text(source.baseCharacterId) } : {}),
      ...(text(source.baseName) ? { baseName: text(source.baseName) } : {}),
      ...(text(source.formLabel) ? { formLabel: text(source.formLabel) } : {}),
      description: [source.race, source.bodyPlan, source.appearance, source.description, source.material]
        .map(text).filter(Boolean).join('；').slice(0, 220),
    };
  };
  return {
    characters: project.characters.filter((record) => !record.dossier?.archivedIntoCharacterId).map((record) => entry(record, 'character')),
    locations: project.locations.map((record) => entry(record, 'location')),
    props: project.props.map((record) => entry(record, 'prop')),
  };
};

export const matchChapterEntity = (
  incoming: { name?: string; aliases?: string[]; existingEntityId?: string; formLabel?: string },
  entries: readonly ChapterEntityCatalogEntry[], kind: ChapterEntityKind,
): { match?: ChapterEntityCatalogEntry; conflict?: ChapterEntityConflict } => {
  const name = canonicalName(incoming, kind);
  const explicitId = text(incoming.existingEntityId);
  if (explicitId) {
    const match = entries.find((entry) => entry.id === explicitId);
    if (match && !(kind === 'character' && incoming.formLabel && incoming.formLabel !== match.formLabel)) return { match };
    if (match) return { conflict: { kind, name, candidateIds: [match.id], reason: '本章形态与已有资料不同，请指定独立形态资料，或为新形态命名。' } };
    return { conflict: { kind, name, candidateIds: [], reason: 'AI 引用了项目中不存在的资料 ID，请重新指定资料。' } };
  }
  const names = new Set([name, ...strings(incoming.aliases)]);
  // A form label identifies a different drawable state; a base-name alias must
  // never silently collapse a new form into an existing ordinary character.
  const candidates = entries.filter((entry) => {
    if (kind === 'character' && text(incoming.formLabel) !== text(entry.formLabel)) return false;
    return [entry.name, ...entry.aliases].some((alias) => names.has(alias));
  });
  if (candidates.length === 1) return { match: candidates[0] };
  return candidates.length > 1 ? { conflict: {
    kind, name, candidateIds: candidates.map((entry) => entry.id), reason: '名称或别名对应多份资料，请选择本章引用哪一份。',
  } } : {};
};

/** Resolve only explicit model identity decisions or unique exact aliases. */
export const resolveChapterAnalysisEntities = (
  input: StoryAnalysisResponse,
  projectOrCatalog: Pick<Project, 'characters' | 'locations' | 'props'> | ChapterEntityCatalog,
): { analysis: StoryAnalysisResponse; conflicts: ChapterEntityConflict[] } => {
  const catalog = buildChapterEntityCatalog(projectOrCatalog as Pick<Project, 'characters' | 'locations' | 'props'>);
  const conflicts: ChapterEntityConflict[] = [];
  const maps = new Map<ChapterEntityKind, Map<string, Record<string, unknown>>>();
  const normalize = (value: unknown, kind: ChapterEntityKind): Record<string, unknown> => {
    const raw: Record<string, unknown> = typeof value === 'string' ? { name: value } : { ...(value as Record<string, unknown>) };
    const originalName = canonicalName(raw, kind);
    const result = matchChapterEntity(raw, catalog[catalogKey(kind)], kind);
    if (result.conflict && !conflicts.some((item) => item.kind === kind && item.name === result.conflict!.name)) conflicts.push(result.conflict);
    if (!result.match) return { ...raw, name: originalName };
    return {
      ...raw, name: result.match.name, existingEntityId: result.match.id,
      aliases: strings([...strings(raw.aliases), ...result.match.aliases, originalName !== result.match.name ? originalName : '']),
      ...(result.match.baseCharacterId ? { baseCharacterId: result.match.baseCharacterId } : {}),
    };
  };
  const normalizeTop = (kind: ChapterEntityKind): Record<string, unknown>[] => {
    const references = new Map<string, Record<string, unknown>>();
    maps.set(kind, references);
    return (input[catalogKey(kind)] || []).map((raw) => {
      const normalized = normalize(raw, kind);
      for (const name of [canonicalName(raw, kind), text(normalized.name), ...strings(normalized.aliases)]) {
        if (name) references.set(name, normalized);
      }
      return normalized;
    });
  };
  const characters = normalizeTop('character');
  const locations = normalizeTop('location');
  const props = normalizeTop('prop');
  const reference = (raw: unknown, kind: ChapterEntityKind) => {
    const known = maps.get(kind)?.get(canonicalName(raw, kind));
    return known ? { ...(typeof raw === 'object' ? raw : {}), name: known.name,
      ...(known.existingEntityId ? { existingEntityId: known.existingEntityId } : {}),
      ...(known.formLabel ? { formLabel: known.formLabel, baseName: known.baseName } : {}),
    } : normalize(raw, kind);
  };
  return { conflicts, analysis: {
    characters, locations, props,
    scenes: input.scenes.map((scene) => ({
      ...scene,
      characters: (scene.characters || []).map((raw) => reference(raw, 'character')),
      location: scene.location ? reference(scene.location, 'location') : undefined,
      props: (scene.props || []).map((raw) => reference(raw, 'prop')),
    })),
  } };
};

const protectedRecordFields = new Set(['id', 'name', 'assetIds', 'aliases', 'sourceChapterIds', 'dossier', 'existingEntityId', 'baseCharacterId']);
const formFieldFor = (field: string): string => ({ signatureProps: 'props', apparentAge: 'age', motionHabits: 'motion' }[field] || field);

/** Chapter parsing only adds or fills unlocked blanks; another chapter's
 * absence never removes a shared entity or changes a confirmed empty field. */
export const reconcileChapterEntities = <T extends EntityRecord>(
  existing: readonly T[], incoming: readonly T[],
  options: { kind: ChapterEntityKind; chapterId: string; provenanceById?: Readonly<Record<string, string>> },
): { records: T[]; removedIds: string[]; conflicts: ChapterEntityConflict[] } => {
  const records: T[] = existing.map((record) => ({ ...record, ...(record.assetIds ? { assetIds: [...record.assetIds] } : {}) }));
  const conflicts: ChapterEntityConflict[] = [];
  for (const item of incoming) {
    const result = matchChapterEntity(item, records.filter((record) => !record.dossier?.archivedIntoCharacterId)
      .map((record) => ({ ...record, aliases: entityAliases(record) })), options.kind);
    if (result.conflict) { conflicts.push(result.conflict); continue; }
    const found = result.match ? records.findIndex((record) => record.id === result.match!.id) : -1;
    if (found < 0) {
      const { existingEntityId: _transientId, ...newRecord } = item;
      records.push({ ...newRecord, sourceChapterIds: strings([...(item.sourceChapterIds || []), options.chapterId]),
        aliases: entityAliases(item), ...(item.assetIds ? { assetIds: [...item.assetIds] } : {}),
        ...(item.baseCharacterId && !records.some((record) => record.id === item.baseCharacterId) ? { baseCharacterId: undefined } : {}),
      } as T);
      continue;
    }
    const previous = records[found];
    const merged = { ...previous } as Record<string, unknown>;
    const allProtected = previous.dossier?.useStory === false || options.provenanceById?.[previous.id] === 'manual';
    if (!allProtected) for (const [field, value] of Object.entries(item)) {
      if (protectedRecordFields.has(field) || isDossierFieldConfirmed(previous.dossier, formFieldFor(field))) continue;
      const current = merged[field];
      if ((current === undefined || current === null || current === '') && typeof value === 'string' && value.trim()) merged[field] = value;
    }
    merged.aliases = strings([...entityAliases(previous), ...entityAliases(item), item.name !== previous.name ? item.name : '']);
    merged.sourceChapterIds = strings([...(previous.sourceChapterIds || []), options.chapterId]);
    records[found] = merged as T;
  }
  // Stable base IDs are attached only when the base identity is unambiguous.
  if (options.kind === 'character') for (const record of records) {
    if (!record.formLabel || record.baseCharacterId) continue;
    const candidates = records.filter((candidate) => candidate.id !== record.id && !candidate.formLabel && candidate.name === record.baseName);
    if (candidates.length === 1) record.baseCharacterId = candidates[0].id;
  }
  return { records, removedIds: [], conflicts };
};

export interface ChapterSourceChunk { sourceStart: number; sourceEnd: number; content: string }
/** Exact UTF-16 ranges partition the chapter without losing whitespace or
 * splitting surrogate pairs. Paragraph breaks are preferred, never required. */
export const splitChapterAnalysisSource = (source: string, maxChars = 16000): ChapterSourceChunk[] => {
  const limit = Math.max(1000, Math.floor(maxChars));
  const chunks: ChapterSourceChunk[] = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(start + limit, source.length);
    if (end < source.length) {
      const paragraph = source.lastIndexOf('\n', end - 1);
      if (paragraph > start + limit / 2) end = paragraph + 1;
      else if (source.charCodeAt(end - 1) >= 0xd800 && source.charCodeAt(end - 1) <= 0xdbff) end -= 1;
    }
    chunks.push({ sourceStart: start, sourceEnd: end, content: source.slice(start, end) });
    start = end;
  }
  return chunks;
};

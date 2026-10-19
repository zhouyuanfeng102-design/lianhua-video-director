import type {
  ChapterWorkspace, ComicPageAnalysis, ComicPanelText, ComicStoryDraft,
  Project, StoryComicSettings, StoryImageSourceMode, StoryReference,
} from './types';
import { sourceContentHash } from './sourceContentHash';
import { hasStoryReferenceSource } from './storyReferenceSource';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const positiveInteger = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
const timestamp = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const panelBounds = (value: unknown): ComicPageAnalysis['panels'][number]['bounds'] => {
  if (!record(value) || !['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))) return undefined;
  const { x, y, width, height } = value as { x: number; y: number; width: number; height: number };
  if (x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0 || width > 1 || height > 1) return undefined;
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
};

/** Saved page evidence preserves panel order, exact original text and uncertain attribution. */
export const normalizeComicPageAnalysis = (value: unknown): ComicPageAnalysis | undefined => {
  if (!record(value) || !Array.isArray(value.panels)) return undefined;
  const ids = new Set<string>();
  const panels: ComicPageAnalysis['panels'] = value.panels.flatMap((raw, index) => {
    if (!record(raw)) return [];
    let id = text(raw.id).trim() || `panel-${index + 1}`;
    while (ids.has(id)) id += '-duplicate';
    ids.add(id);
    const bounds = panelBounds(raw.bounds);
    const texts: ComicPanelText[] = Array.isArray(raw.texts) ? raw.texts.flatMap((item, textIndex) => {
      if (!record(item)) return [];
      return [{ id: text(item.id).trim() || `${id}-text-${textIndex + 1}`,
        type: ['dialogue', 'thought', 'narration', 'sfx', 'unknown'].includes(text(item.type)) ? item.type as ComicPanelText['type'] : 'unknown',
        text: text(item.text), language: text(item.language),
        ...(typeof item.chineseText === 'string' ? { chineseText: item.chineseText } : {}),
        ...(text(item.speakerId).trim() ? { speakerId: text(item.speakerId) } : {}),
        ...(typeof item.uncertainty === 'string' ? { uncertainty: item.uncertainty } : {}),
      }];
    }) : [];
    const actions: ComicPageAnalysis['panels'][number]['actions'] = Array.isArray(raw.actions) ? raw.actions.flatMap((item, actionIndex) => {
      if (!record(item)) return [];
      const actionId = text(item.id).trim() || `${id}-action-${actionIndex + 1}`;
      return [{ id: actionId, eventId: text(item.eventId).trim() || actionId,
        ...(text(item.actorId).trim() ? { actorId: text(item.actorId) } : {}),
        ...(text(item.targetId).trim() ? { targetId: text(item.targetId) } : {}),
        action: text(item.action), result: text(item.result),
        ...(typeof item.phase === 'string' ? { phase: item.phase } : {}),
      }];
    }) : [];
    return [{ id, order: positiveInteger(raw.order, index + 1), ...(bounds ? { bounds } : {}),
      description: text(raw.description), characterIds: strings(raw.characterIds), texts, actions,
      entryState: text(raw.entryState), exitState: text(raw.exitState), uncertainties: strings(raw.uncertainties),
    }];
  });
  return panels.length ? { panels, uncertainties: strings(value.uncertainties) } : undefined;
};

export const normalizeStoryComicSettings = (value: unknown): StoryComicSettings => {
  const raw = record(value) ? value : {};
  return {
    readingDirection: raw.readingDirection === 'ltr' || raw.readingDirection === 'vertical' ? raw.readingDirection : 'rtl',
    dialogueMode: raw.dialogueMode === 'chinese' ? 'chinese' : 'original',
    renderMode: raw.renderMode === 'motion_comic' ? 'motion_comic' : 'animation',
  };
};

export const normalizeComicStoryDraft = (value: unknown): ComicStoryDraft | undefined => {
  if (!record(value) || typeof value.storyText !== 'string' || !text(value.sourceFingerprint).trim()) return undefined;
  return { storyText: value.storyText, sourceFingerprint: text(value.sourceFingerprint), generatedAt: timestamp(value.generatedAt),
    model: text(value.model), ...(typeof value.adoptedAt === 'number' && Number.isFinite(value.adoptedAt) && value.adoptedAt >= 0 ? { adoptedAt: value.adoptedAt } : {}),
  };
};

const chapterIdOf = (project: Project, chapterId?: string): string | undefined => chapterId
  ?? project.sourceDocuments.find((chapter) => chapter.id === project.activeChapterId)?.id
  ?? project.sourceDocuments.find((chapter) => !chapter.archived)?.id ?? project.sourceDocuments[0]?.id;
const workspaceOf = (project: Project, chapterId?: string): ChapterWorkspace => project.chapterWorkspaces?.[chapterIdOf(project, chapterId) || ''] ?? {};

export const storyComicSettings = (project: Project, chapterId?: string): StoryComicSettings => normalizeStoryComicSettings(workspaceOf(project, chapterId).storyComicSettings);

/** Page order is separate from permanent chapter image labels. */
export const orderedComicReferences = (project: Project, chapterId?: string, includeDisabled = false): StoryReference[] => (
  (workspaceOf(project, chapterId).storyReferences ?? []).filter((reference) => reference.sourceRole === 'comic' && (includeDisabled || reference.enabled))
    .map((reference, index) => ({ reference, index })).sort((left, right) =>
      (left.reference.pageOrder ?? left.reference.number) - (right.reference.pageOrder ?? right.reference.number) || left.index - right.index)
    .map(({ reference }) => reference)
);

/** Match the identity facts sent to the recognizer, without task or media bookkeeping. */
export const comicIdentityCatalog = (project: Pick<Project, 'characters' | 'locations' | 'props'>) => ({
  characters: project.characters.map((character) => ({
    id: character.id, name: character.name,
    aliases: [...(character.aliases ?? [])],
    ...(character.dossier ? { dossier: clone(character.dossier) } : {}),
    gender: text(character.gender), apparentAge: text(character.apparentAge), actualAge: text(character.actualAge), race: text(character.race),
    appearance: text(character.appearance), outfit: text(character.outfit), anchor: text(character.anchor),
  })),
  locations: project.locations.map((location) => ({ id: location.id, name: location.name })),
  props: project.props.map((prop) => ({ id: prop.id, name: prop.name })),
});

/** Include all participating identity references, page evidence and current original pixels. */
export const comicSourceFingerprint = (project: Project, chapterId?: string): string => {
  const id = chapterIdOf(project, chapterId);
  const workspace = workspaceOf(project, id);
  const references = (workspace.storyReferences ?? []).filter((reference) => reference.enabled).map((reference) => {
    const asset = project.assets.find((item) => item.id === reference.assetId);
    return { id: reference.id, number: reference.number, sourceRole: reference.sourceRole ?? 'reference',
      pageOrder: reference.pageOrder, enabled: reference.enabled, assetId: reference.assetId, assetChecksum: reference.assetChecksum,
      currentAssetChecksum: asset ? asset.checksum || sourceContentHash(asset.dataUrl || asset.url || asset.relativePath || asset.id) : undefined,
      missing: !asset || asset.missing === true || !(asset.dataUrl || asset.url || asset.relativePath),
      analysis: reference.analysis, fullDescription: reference.fullDescription, notes: reference.notes, subjectBindings: reference.subjectBindings,
    };
  });
  return sourceContentHash(JSON.stringify(stable({ chapterId: id, inputMode: workspace.storyInputMode,
    sourceMode: workspace.storyImageSourceMode ?? 'reference', settings: storyComicSettings(project, id), narrator: workspace.storyNarrator, references,
    identityCatalog: comicIdentityCatalog(project),
  })));
};

const patchWorkspace = (project: Project, chapterId: string | undefined, patch: Partial<ChapterWorkspace>, invalidates: boolean): Project => {
  const id = chapterIdOf(project, chapterId);
  if (!id || !project.sourceDocuments.some((chapter) => chapter.id === id)) return project;
  const now = Date.now();
  const next: Project = { ...project, updatedAt: now, chapterWorkspaces: { ...project.chapterWorkspaces,
    [id]: { ...workspaceOf(project, id), ...patch } } };
  // Preparation controls do not replace a source while neither workspace has
  // enabled image input. Keep the full async fingerprint and saved stale state.
  if (!hasStoryReferenceSource(workspaceOf(project, id)) && !hasStoryReferenceSource(workspaceOf(next, id))) return next;
  if (!invalidates || comicSourceFingerprint(project, id) === comicSourceFingerprint(next, id)) return next;
  return { ...next,
    scenes: next.scenes.map((scene) => scene.chapterId === id ? { ...scene, sourceStale: true } : scene),
    storyboards: next.storyboards.map((board) => board.chapterId === id ? { ...board, sourceStale: true } : board),
    sequencePlans: next.sequencePlans.map((plan) => plan.chapterId === id ? { ...plan, sourceStale: true,
      segments: plan.segments.map((segment) => ({ ...segment, status: 'stale' as const })) } : plan),
  };
};

export const setStoryImageSourceMode = (project: Project, mode: StoryImageSourceMode, chapterId?: string): Project => (
  patchWorkspace(project, chapterId, { storyImageSourceMode: mode }, true)
);

export const setStoryComicSettings = (project: Project, patch: Partial<StoryComicSettings>, chapterId?: string): Project => (
  patchWorkspace(project, chapterId, { storyComicSettings: normalizeStoryComicSettings({ ...storyComicSettings(project, chapterId), ...patch }) },
    workspaceOf(project, chapterId).storyImageSourceMode === 'comic')
);

export const moveComicPage = (project: Project, referenceId: string, direction: -1 | 1, chapterId?: string): Project => {
  const pages = orderedComicReferences(project, chapterId, true);
  const index = pages.findIndex((page) => page.id === referenceId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= pages.length) return project;
  [pages[index], pages[target]] = [pages[target], pages[index]];
  const positions = new Map(pages.map((page, pageIndex) => [page.id, pageIndex + 1]));
  return patchWorkspace(project, chapterId, { storyReferences: (workspaceOf(project, chapterId).storyReferences ?? []).map((reference) =>
    positions.has(reference.id) ? { ...reference, pageOrder: positions.get(reference.id), updatedAt: Date.now() } : reference) }, true);
};

export const storeComicStoryDraft = (project: Project, draft: ComicStoryDraft | undefined, chapterId?: string): Project => {
  const normalized = normalizeComicStoryDraft(draft);
  return patchWorkspace(project, chapterId, { comicStoryDraft: normalized ? clone(normalized) : undefined }, false);
};

/** A comic source remains evidence across chapters, even when that page is disabled. */
export const isComicSourceAsset = (project: Project, assetId: string, chapterId?: string): boolean => {
  const workspaces = chapterId ? [workspaceOf(project, chapterId)] : Object.values(project.chapterWorkspaces ?? {});
  return workspaces.some((workspace) => workspace.storyReferences?.some((reference) => reference.sourceRole === 'comic' && reference.assetId === assetId))
    || project.scenes.some((scene) => (!chapterId || scene.chapterId === chapterId)
      && scene.storyReferenceContext?.references.some((reference) => reference.sourceRole === 'comic' && reference.assetId === assetId))
    || project.storyboards.some((board) => (!chapterId || board.chapterId === chapterId)
      && board.storyReferenceContext?.references.some((reference) => reference.sourceRole === 'comic' && reference.assetId === assetId));
};

/** Use on automatic reference collection; explicit shot reference choices remain caller-owned. */
export const storyReferenceVideoAssetIds = (project: Project, assetIds: readonly string[], chapterId?: string): string[] => (
  [...new Set(assetIds)].filter((assetId) => !isComicSourceAsset(project, assetId, chapterId))
);

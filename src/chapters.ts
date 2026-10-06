import type { ChapterWorkspace, GenerationTask, Project, ReferenceAsset, Scene, SourceDocument, Storyboard, VideoSequencePlan } from './types';
import { sourceContentHash } from './sourceContentHash';
import { normalizeDirectorLookDraft } from './directorLookDraft';

type ChapterProject = Pick<Project, 'sourceDocuments'> & Partial<Pick<Project, 'activeChapterId' | 'chapterWorkspaces' | 'storyDraft'>>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
const sourceIndexes = new WeakMap<SourceDocument[], { ids: Set<string>; byHash: Map<string, string[]>; byText: Map<string, string[]> }>();
const sourceIndex = (project: ChapterProject) => {
  const existing = sourceIndexes.get(project.sourceDocuments);
  if (existing) return existing;
  const next = { ids: new Set<string>(), byHash: new Map<string, string[]>(), byText: new Map<string, string[]>() };
  for (const chapter of project.sourceDocuments) {
    next.ids.add(chapter.id);
    const hash = sourceContentHash(chapter.content);
    next.byHash.set(hash, [...(next.byHash.get(hash) ?? []), chapter.id]);
    next.byText.set(chapter.content, [...(next.byText.get(chapter.content) ?? []), chapter.id]);
  }
  sourceIndexes.set(project.sourceDocuments, next);
  return next;
};
const validChapterId = (project: ChapterProject, id: unknown): id is string => typeof id === 'string' && sourceIndex(project).ids.has(id);

export const orderedChapters = (project: Pick<Project, 'sourceDocuments'>, includeArchived = false): SourceDocument[] => project.sourceDocuments
  .filter((chapter) => includeArchived || !chapter.archived)
  .map((chapter, index) => ({ chapter, index }))
  .sort((a, b) => (a.chapter.order ?? a.index) - (b.chapter.order ?? b.index) || a.index - b.index)
  .map(({ chapter }) => chapter);

export const activeChapter = (project: ChapterProject): SourceDocument | undefined => (
  project.sourceDocuments.find((chapter) => chapter.id === project.activeChapterId && !chapter.archived)
  ?? orderedChapters(project)[0]
  ?? project.sourceDocuments.find((chapter) => chapter.id === project.activeChapterId)
  ?? orderedChapters(project, true)[0]
);

export const chapterWorkspace = (project: ChapterProject, chapterId = activeChapter(project)?.id): ChapterWorkspace => (
  chapterId ? project.chapterWorkspaces?.[chapterId] ?? {} : {}
);

export const withChapterWorkspace = <T extends ChapterProject>(project: T, patch: Partial<ChapterWorkspace>, chapterId = activeChapter(project)?.id): T => {
  if (!chapterId || !validChapterId(project, chapterId)) return project;
  return { ...project, chapterWorkspaces: { ...project.chapterWorkspaces, [chapterId]: { ...chapterWorkspace(project, chapterId), ...patch } } };
};

const chapterControls = (project: Pick<Project, 'directorSettingsConfirmedFingerprint' | 'directorSettingsConfirmedAt' | 'directorLookRequirement' | 'directorLookDraft'>): Pick<ChapterWorkspace, 'directorSettingsConfirmedFingerprint' | 'directorSettingsConfirmedAt' | 'directorLookRequirement' | 'directorLookDraft'> => ({
  ...(project.directorSettingsConfirmedFingerprint !== undefined ? { directorSettingsConfirmedFingerprint: project.directorSettingsConfirmedFingerprint } : {}),
  ...(project.directorSettingsConfirmedAt !== undefined ? { directorSettingsConfirmedAt: project.directorSettingsConfirmedAt } : {}),
  ...(project.directorLookRequirement !== undefined ? { directorLookRequirement: project.directorLookRequirement } : {}),
  ...(project.directorLookDraft !== undefined ? { directorLookDraft: project.directorLookDraft } : {}),
});

/** Global compatibility fields mirror the selected chapter, never another chapter's draft. */
export const withChapterSelection = (project: Project, chapterId: string): Project => {
  const chapter = project.sourceDocuments.find((item) => item.id === chapterId && !item.archived);
  if (!chapter) return project;
  const previous = activeChapter(project);
  const saved = previous ? withChapterWorkspace(project, { ...chapterControls(project), storyDraft: project.storyDraft ?? chapterWorkspace(project).storyDraft }, previous.id) : project;
  const workspace = chapterWorkspace(saved, chapter.id);
  return {
    ...saved, activeChapterId: chapter.id, storyDraft: workspace.storyDraft,
    directorSettingsConfirmedFingerprint: workspace.directorSettingsConfirmedFingerprint,
    directorSettingsConfirmedAt: workspace.directorSettingsConfirmedAt,
    directorLookRequirement: workspace.directorLookRequirement,
    directorLookDraft: workspace.directorLookDraft,
  };
};

const uniqueChapter = (values: Array<string | undefined>): string | undefined => {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))];
  return unique.length === 1 ? unique[0] : undefined;
};

const chapterForSource = (project: ChapterProject, item: { chapterId?: string; sourceContentHash?: string; sourceStoryContent?: string }): string | undefined => {
  if (validChapterId(project, item.chapterId)) return item.chapterId;
  if (item.sourceContentHash) {
    const matching = sourceIndex(project).byHash.get(item.sourceContentHash);
    if (matching?.length === 1) return matching[0];
  }
  if (item.sourceStoryContent) {
    const matching = sourceIndex(project).byText.get(item.sourceStoryContent);
    if (matching?.length === 1) return matching[0];
  }
  return project.sourceDocuments.length === 1 ? project.sourceDocuments[0].id : undefined;
};

export const chapterIdForScene = (project: Project, sceneOrId: Scene | string): string | undefined => {
  const scene = typeof sceneOrId === 'string' ? project.scenes.find((item) => item.id === sceneOrId) : sceneOrId;
  return scene ? chapterForSource(project, scene) : undefined;
};

export const chapterIdForStoryboard = (project: Project, boardOrId: Storyboard | string): string | undefined => {
  const board = typeof boardOrId === 'string' ? project.storyboards.find((item) => item.id === boardOrId) : boardOrId;
  if (!board) return undefined;
  const source = chapterForSource(project, board);
  if (source) return source;
  const plan = project.sequencePlans.find((item) => item.id === board.sequencePlanId || item.masterStoryboardId === board.id || item.segments?.some((segment) => segment.storyboardId === board.id));
  return (plan && chapterForSource(project, plan))
    || uniqueChapter([board.sceneId, ...(board.sourceSceneIds ?? [])].map((id) => chapterIdForScene(project, id)));
};

export const chapterIdForPlan = (project: Project, planOrId: VideoSequencePlan | string): string | undefined => {
  const plan = typeof planOrId === 'string' ? project.sequencePlans.find((item) => item.id === planOrId) : planOrId;
  if (!plan) return undefined;
  return chapterForSource(project, plan) || uniqueChapter(project.storyboards
    .filter((board) => board.sequencePlanId === plan.id || board.id === plan.masterStoryboardId || plan.segments?.some((segment) => segment.storyboardId === board.id))
    .map((board) => chapterForSource(project, board)));
};

export const chapterScenes = (project: Project, chapterId = activeChapter(project)?.id): Scene[] => project.scenes.filter((scene) => chapterIdForScene(project, scene) === chapterId);
export const chapterBoards = (project: Project, chapterId = activeChapter(project)?.id): Storyboard[] => project.storyboards.filter((board) => chapterIdForStoryboard(project, board) === chapterId);
export const chapterPlans = (project: Project, chapterId = activeChapter(project)?.id): VideoSequencePlan[] => project.sequencePlans.filter((plan) => chapterIdForPlan(project, plan) === chapterId);

/** A read-only editor view. Do not persist it or pass it to background workers. */
export const chapterScopeProject = (project: Project, chapterId = activeChapter(project)?.id): Project => {
  const chapter = project.sourceDocuments.find((item) => item.id === chapterId);
  const workspace = chapterWorkspace(project, chapterId);
  const isActive = chapterId === activeChapter(project)?.id;
  return {
    ...project, activeChapterId: chapterId, sourceDocuments: chapter ? [chapter] : [],
    scenes: chapterScenes(project, chapterId), storyboards: chapterBoards(project, chapterId), sequencePlans: chapterPlans(project, chapterId),
    storyDraft: workspace.storyDraft ?? (isActive ? project.storyDraft : undefined),
    ...(isActive ? {} : {
      directorSettingsConfirmedFingerprint: workspace.directorSettingsConfirmedFingerprint,
      directorSettingsConfirmedAt: workspace.directorSettingsConfirmedAt,
      directorLookRequirement: workspace.directorLookRequirement,
      directorLookDraft: workspace.directorLookDraft,
    }),
  };
};

const normalizeWorkspace = (value: unknown): ChapterWorkspace => {
  if (!record(value)) return {};
  const workspace: ChapterWorkspace = {};
  if (record(value.storyDraft) && typeof value.storyDraft.name === 'string' && typeof value.storyDraft.content === 'string') workspace.storyDraft = {
    name: value.storyDraft.name, content: value.storyDraft.content,
    updatedAt: typeof value.storyDraft.updatedAt === 'number' && Number.isFinite(value.storyDraft.updatedAt) ? value.storyDraft.updatedAt : 0,
  };
  if (record(value.directorControls)) workspace.directorControls = { ...value.directorControls };
  if (record(value.videoDirector)) workspace.videoDirector = value.videoDirector;
  if (typeof value.directorSettingsConfirmedFingerprint === 'string') workspace.directorSettingsConfirmedFingerprint = value.directorSettingsConfirmedFingerprint;
  if (typeof value.directorSettingsConfirmedAt === 'number' && Number.isFinite(value.directorSettingsConfirmedAt)) workspace.directorSettingsConfirmedAt = value.directorSettingsConfirmedAt;
  if (typeof value.directorLookRequirement === 'string') workspace.directorLookRequirement = value.directorLookRequirement;
  const lookDraft = normalizeDirectorLookDraft(value.directorLookDraft);
  if (lookDraft) workspace.directorLookDraft = lookDraft;
  return workspace;
};

/** Add chapter provenance without rewriting prompts, media, task snapshots or IDs. */
export const migrateProjectChapters = (project: Project): Project => {
  let sourceDocuments: SourceDocument[] = project.sourceDocuments.map((chapter, index) => ({
    ...chapter,
    order: typeof chapter.order === 'number' && Number.isFinite(chapter.order) ? chapter.order : index,
    ...(chapter.archived === true ? { archived: true } : { archived: false }),
  }));
  if (!sourceDocuments.length) sourceDocuments = [{ id: `chapter-${project.id}`, name: '第 1 章', content: '', order: 0, archived: false, createdAt: project.createdAt || 0, updatedAt: project.updatedAt || 0 }];
  let next: Project = { ...project, sourceDocuments };
  // Source hashes and explicit links establish provenance. Ambiguous multi-source
  // legacy records are retained in a visible historical chapter for assignment.
  let scenes = project.scenes.map((scene) => ({ ...scene, chapterId: chapterIdForScene(next, scene) }));
  next = { ...next, scenes };
  let storyboards = project.storyboards.map((board) => ({ ...board, chapterId: chapterIdForStoryboard(next, board) }));
  next = { ...next, storyboards };
  let sequencePlans = project.sequencePlans.map((plan) => ({ ...plan, chapterId: chapterIdForPlan(next, plan) }));
  next = { ...next, sequencePlans };
  storyboards = storyboards.map((board) => board.chapterId ? board : { ...board, chapterId: chapterIdForStoryboard(next, board) });
  scenes = scenes.map((scene) => scene.chapterId ? scene : { ...scene, chapterId: uniqueChapter(storyboards.filter((board) => board.sceneId === scene.id || board.sourceSceneIds?.includes(scene.id)).map((board) => board.chapterId)) });
  if ([...scenes, ...storyboards, ...sequencePlans].some((item) => !item.chapterId)) {
    let history = sourceDocuments.find((chapter) => chapter.historical);
    if (!history) {
      const historyId = `${project.id}-chapter-history`;
      history = { id: sourceDocuments.some((chapter) => chapter.id === historyId) ? `${historyId}-legacy` : historyId,
        name: '待归属历史内容', content: '', historical: true, order: sourceDocuments.length, archived: false, createdAt: project.createdAt || 0, updatedAt: project.updatedAt || 0 };
      sourceDocuments = [...sourceDocuments, history];
    }
    const historyId = history.id;
    scenes = scenes.map((scene) => scene.chapterId ? scene : { ...scene, chapterId: historyId });
    storyboards = storyboards.map((board) => board.chapterId ? board : { ...board, chapterId: historyId });
    sequencePlans = sequencePlans.map((plan) => plan.chapterId ? plan : { ...plan, chapterId: historyId });
  }
  next = { ...next, sourceDocuments, scenes, storyboards, sequencePlans };
  const selected = activeChapter(next)!;
  const chapterWorkspaces: Record<string, ChapterWorkspace> = {};
  for (const chapter of sourceDocuments) chapterWorkspaces[chapter.id] = normalizeWorkspace(project.chapterWorkspaces?.[chapter.id]);
  if (!project.chapterWorkspaces || !own(project.chapterWorkspaces, selected.id)) {
    chapterWorkspaces[selected.id] = { ...chapterWorkspaces[selected.id], ...chapterControls(project), ...(project.storyDraft ? { storyDraft: project.storyDraft } : {}) };
  }
  // The compatibility fields are edited by existing director controls. Capture
  // those current values before selecting a different chapter or saving source.
  const workspace = chapterWorkspaces[selected.id];
  for (const key of ['directorSettingsConfirmedFingerprint', 'directorSettingsConfirmedAt', 'directorLookRequirement', 'directorLookDraft'] as const) {
    // `undefined` is the canonical representation for an absent optional
    // value. Do not materialize it as an own property: persisted JSON drops
    // those keys, so doing so would make the next normalization non-idempotent.
    if (own(project, key) && project[key] !== undefined) Object.assign(workspace, { [key]: project[key] });
  }
  if (project.storyDraft !== undefined) workspace.storyDraft = project.storyDraft;
  const compatibilityControls = chapterControls(workspace);
  return {
    ...next, activeChapterId: selected.id, chapterWorkspaces,
    ...(workspace.storyDraft !== undefined ? { storyDraft: workspace.storyDraft } : {}),
    ...compatibilityControls,
  };
};

export interface ChapterImportPiece {
  name: string;
  content: string;
  volume?: string;
  sourceStart: number;
  sourceEnd: number;
}

const headingName = (line: string): string => line.replace(/^\uFEFF/u, '').trim().replace(/^#{1,6}\s*/u, '').trim();
const isChapterHeading = (line: string): boolean => {
  const name = headingName(line);
  if (!name || name.length > 100 || /[.．·…]{2,}\s*\d+\s*$/u.test(name) || /^(?:目录|目次|contents|table of contents)$/iu.test(name)) return false;
  return /^(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章回节集](?:\s|[：:、.．]|[^\d零一二三四五六七八九十百千万])?.*|chapter\s+(?:\d+|[ivxlcdm]+)\b.*|(?:序章|楔子|序言|前言|后记|尾声|番外)(?:\s|[：:、一二三四五六七八九十\d]).*|序章|楔子|序言|前言|后记|尾声|番外)$/iu.test(name)
    || (/^\s*#{1,3}\s+\S/u.test(line) && !/^第\s*.+卷/u.test(name));
};

/** Pure local title detection. Concatenating every returned content equals text exactly. */
export const splitNovelChapters = (text: string, fileName = '导入小说'): ChapterImportPiece[] => {
  const lines: Array<{ line: string; start: number; end: number }> = [];
  const matcher = /[^\r\n]*(?:\r\n|\r|\n|$)/gu;
  for (const match of text.matchAll(matcher)) {
    if (!match[0]) continue;
    lines.push({ line: match[0].replace(/[\r\n]+$/u, ''), start: match.index!, end: match.index! + match[0].length });
  }
  const candidates = lines.map((line, index) => isChapterHeading(line.line) ? index : -1).filter((index) => index >= 0);
  // Compact repeated headings at a document's start are normally the contents.
  // Keep them byte-for-byte in the preface, rather than creating empty chapters.
  const accepted = candidates.filter((lineIndex, index) => {
    const nextIndex = candidates[index + 1];
    if (nextIndex === undefined) return true;
    const between = text.slice(lines[lineIndex].end, lines[nextIndex].start).trim();
    const laterSameHeading = candidates.slice(index + 1).some((other) => headingName(lines[other].line) === headingName(lines[lineIndex].line));
    return !(laterSameHeading && (!between || /^[\d\s.．·…]+$/u.test(between)));
  });
  const baseName = fileName.replace(/\.(?:txt|md|markdown)$/iu, '') || '导入小说';
  if (!accepted.length) return [{ name: baseName, content: text, sourceStart: 0, sourceEnd: text.length }];
  const pieces: ChapterImportPiece[] = [];
  const prefix = text.slice(0, lines[accepted[0]].start);
  if (prefix.trim()) pieces.push({ name: `${baseName} · 前言与目录`, content: prefix, sourceStart: 0, sourceEnd: lines[accepted[0]].start });
  accepted.forEach((lineIndex, index) => {
    const start = index === 0 && !prefix.trim() ? 0 : lines[lineIndex].start;
    const end = index + 1 < accepted.length ? lines[accepted[index + 1]].start : text.length;
    const precedingVolume = lines.slice(0, lineIndex + 1).reverse().find((line) => /^第\s*[零〇一二三四五六七八九十百千万两\d]+\s*卷/u.test(headingName(line.line)));
    pieces.push({ name: headingName(lines[lineIndex].line), content: text.slice(start, end), sourceStart: start, sourceEnd: end, ...(precedingVolume ? { volume: headingName(precedingVolume.line) } : {}) });
  });
  return pieces;
};

export const splitChapterPiece = (piece: ChapterImportPiece, offset: number): ChapterImportPiece[] => {
  if (!Number.isInteger(offset) || offset <= 0 || offset >= piece.content.length) return [piece];
  return [
    { ...piece, content: piece.content.slice(0, offset), sourceEnd: piece.sourceStart + offset },
    { ...piece, name: `${piece.name} · 续`, content: piece.content.slice(offset), sourceStart: piece.sourceStart + offset },
  ];
};

export const mergeChapterPieces = (pieces: ChapterImportPiece[], firstIndex: number): ChapterImportPiece[] => {
  if (firstIndex < 0 || firstIndex + 1 >= pieces.length) return pieces;
  const first = pieces[firstIndex];
  const second = pieces[firstIndex + 1];
  return [...pieces.slice(0, firstIndex), { ...first, content: first.content + second.content, sourceEnd: second.sourceEnd }, ...pieces.slice(firstIndex + 2)];
};

export const appendChapters = (project: Project, drafts: Array<{ name: string; content: string; volume?: string }>, now = Date.now()): Project => {
  if (!drafts.length) return project;
  const current = migrateProjectChapters(project);
  const ids = new Set(current.sourceDocuments.map((chapter) => chapter.id));
  const created = drafts.map((draft, index): SourceDocument => {
    let id = `chapter-${project.id}-${now.toString(36)}-${index}`;
    while (ids.has(id)) id += '-new';
    ids.add(id);
    return { id, name: draft.name.trim() || `第 ${current.sourceDocuments.length + index + 1} 章`, content: draft.content, contentHash: sourceContentHash(draft.content), order: current.sourceDocuments.length + index, ...(draft.volume ? { volume: draft.volume } : {}), createdAt: now, updatedAt: now };
  });
  return withChapterSelection({ ...current, sourceDocuments: [...current.sourceDocuments, ...created], updatedAt: now }, created[0].id);
};

export const addChapter = (project: Project, draft: { name?: string; content?: string } = {}, now = Date.now()): Project => appendChapters(project, [{ name: draft.name || `第 ${project.sourceDocuments.length + 1} 章`, content: draft.content ?? '' }], now);

export const archiveChapter = (project: Project, chapterId: string, archived = true): Project => {
  if (!validChapterId(project, chapterId)) return project;
  // Preserve one editable chapter so archiving cannot strand the editor.
  if (archived && orderedChapters(project).filter((chapter) => chapter.id !== chapterId).length === 0) return project;
  const previous = activeChapter(project)?.id;
  let next = { ...project, sourceDocuments: project.sourceDocuments.map((chapter) => chapter.id === chapterId ? { ...chapter, archived } : chapter) };
  if (archived && previous === chapterId) {
    next = withChapterWorkspace(next, { ...chapterControls(project), storyDraft: project.storyDraft ?? chapterWorkspace(project, chapterId).storyDraft }, chapterId);
    const target = orderedChapters(next)[0];
    const workspace = chapterWorkspace(next, target.id);
    next = { ...next, activeChapterId: target.id, storyDraft: workspace.storyDraft,
      directorSettingsConfirmedFingerprint: workspace.directorSettingsConfirmedFingerprint,
      directorSettingsConfirmedAt: workspace.directorSettingsConfirmedAt,
      directorLookRequirement: workspace.directorLookRequirement,
      directorLookDraft: workspace.directorLookDraft };
  }
  return next;
};

export const reorderChapters = (project: Project, chapterIds: string[]): Project => {
  const ordered = [...new Set([...chapterIds, ...orderedChapters(project, true).map((chapter) => chapter.id)])].filter((id) => validChapterId(project, id));
  return { ...project, sourceDocuments: ordered.map((id, order) => ({ ...project.sourceDocuments.find((chapter) => chapter.id === id)!, order })) };
};

/** Rename/update only the selected chapter. Prior work stays inspectable and jobs retain immutable inputs. */
export const replaceChapterSourceDocument = (project: Project, sourceDocument: SourceDocument) => {
  const normalized = migrateProjectChapters(project);
  const currentSource = normalized.sourceDocuments.find((chapter) => chapter.id === sourceDocument.id) ?? activeChapter(normalized)!;
  const chapterId = currentSource.id;
  const nextHash = sourceContentHash(sourceDocument.content);
  const sourceChanged = sourceContentHash(currentSource.content) !== nextHash;
  const boardIds = new Set(sourceChanged ? chapterBoards(normalized, chapterId).map((board) => board.id) : []);
  const planIds = new Set(sourceChanged ? chapterPlans(normalized, chapterId).map((plan) => plan.id) : []);
  const sceneIds = new Set(sourceChanged ? chapterScenes(normalized, chapterId).map((scene) => scene.id) : []);
  const workspacePatch: Partial<ChapterWorkspace> = { storyDraft: undefined, ...(sourceChanged ? { directorSettingsConfirmedFingerprint: undefined, directorSettingsConfirmedAt: undefined } : {}) };
  const next = withChapterWorkspace({ ...normalized,
    sourceDocuments: normalized.sourceDocuments.map((chapter) => chapter.id === chapterId ? { ...chapter, ...sourceDocument, id: chapterId, contentHash: nextHash } : chapter),
    scenes: normalized.scenes.map((scene) => sceneIds.has(scene.id) ? { ...scene, sourceStale: true } : scene),
    storyboards: normalized.storyboards.map((board) => boardIds.has(board.id) ? { ...board, sourceStale: true } : board),
    sequencePlans: normalized.sequencePlans.map((plan) => planIds.has(plan.id) ? { ...plan, sourceStale: true, segments: (plan.segments ?? []).map((segment) => ({ ...segment, status: 'stale' as const })) } : plan),
    ...(activeChapter(normalized)?.id === chapterId ? { storyDraft: undefined, ...(sourceChanged ? { directorSettingsConfirmedFingerprint: undefined, directorSettingsConfirmedAt: undefined } : {}) } : {}),
  }, workspacePatch, chapterId);
  return { project: next, sourceChanged, invalidatedStoryboardIds: [...boardIds], invalidatedPlanIds: [...planIds] };
};

export const chapterIdsForEntity = (project: Project, kind: 'character' | 'location' | 'prop', id: string): string[] => {
  const collection = kind === 'character' ? project.characters : kind === 'location' ? project.locations : project.props;
  const entity = collection.find((item) => item.id === id);
  const scenes = project.scenes.filter((scene) => kind === 'character' ? scene.characterIds.includes(id) : kind === 'location' ? scene.locationId === id || scene.locationIds?.includes(id) : scene.propIds.includes(id));
  return [...new Set([...(entity?.sourceChapterIds ?? []).filter((chapterId) => validChapterId(project, chapterId)), ...scenes.map((scene) => chapterIdForScene(project, scene)).filter((value): value is string => Boolean(value))])];
};

export const chapterContentForEntity = (project: Project, kind: 'character' | 'location' | 'prop', id: string): string => {
  const ids = chapterIdsForEntity(project, kind, id);
  const active = activeChapter(project);
  // One relevant chapter only: a recurring protagonist may have hundreds of
  // chapter links, which must never turn dossier completion into a whole novel request.
  if (active && (!ids.length || ids.includes(active.id))) return active.content;
  const ordered = orderedChapters(project, true);
  const activeIndex = ordered.findIndex((chapter) => chapter.id === active?.id);
  const preceding = ordered.slice(0, activeIndex < 0 ? ordered.length : activeIndex + 1).reverse().find((chapter) => ids.includes(chapter.id));
  return (preceding ?? ordered.find((chapter) => ids.includes(chapter.id)))?.content ?? '';
};

export const chapterIdForTask = (project: Project, task: GenerationTask): string | undefined => {
  const item = task as unknown as Record<string, any>;
  if (validChapterId(project, item.chapterId)) return item.chapterId;
  const frozenSource = item.videoJob?.snapshot?.draft?.source ?? item.videoJob?.draft?.source ?? item.videoJob?.source;
  if (validChapterId(project, frozenSource?.chapterId)) return frozenSource.chapterId;
  const board = item.sourceStoryboardId || item.storyboardId || frozenSource?.storyboardId;
  if (board) { const id = chapterIdForStoryboard(project, board); if (id) return id; }
  if (item.sequencePlanId) { const id = chapterIdForPlan(project, item.sequencePlanId); if (id) return id; }
  return item.sourceEntityId && ['character', 'location', 'prop'].includes(item.assetKind) ? uniqueChapter(chapterIdsForEntity(project, item.assetKind, item.sourceEntityId)) : undefined;
};

export const chapterIdForAsset = (project: Project, asset: ReferenceAsset): string | undefined => {
  const item = asset as unknown as Record<string, any>;
  if (validChapterId(project, item.chapterId)) return item.chapterId;
  const boardId = item.sourceStoryboardId || item.storyboardId;
  if (boardId) { const id = chapterIdForStoryboard(project, boardId); if (id) return id; }
  if (asset.videoSourceTask) { const id = chapterIdForTask(project, asset.videoSourceTask); if (id) return id; }
  const task = project.generationTasks.find((task) => ('resultAssetId' in task && task.resultAssetId === asset.id) || task.id === asset.sourceVideoTaskId);
  if (task) { const id = chapterIdForTask(project, task); if (id) return id; }
  return asset.sourceEntityId && asset.sourceEntityKind ? uniqueChapter(chapterIdsForEntity(project, asset.sourceEntityKind, asset.sourceEntityId)) : undefined;
};

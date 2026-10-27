export type AssetPathMove = { projectId: string; from: string; to: string };

const MEDIA_KINDS = new Set(['image', 'video', 'audio']);

const normalizeRelative = (value: string): string => value.replace(/\\/gu, '/').replace(/^\/+/u, '');

const assetUrl = (relative: string): string => (
  `lianhua-asset://local/${relative.split('/').map((part) => encodeURIComponent(part)).join('/')}`
);

const decodeAssetUrl = (value: string): string => {
  if (!value.startsWith('lianhua-asset://local/')) return '';
  try {
    return new URL(value).pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part)).join('/');
  } catch {
    return '';
  }
};

const isLegacyAssetRelative = (value: string): boolean => {
  const [kind] = normalizeRelative(value).split('/');
  return MEDIA_KINDS.has(kind);
};

/** A saved project still pointing at the old image/video/audio pile should be written again. */
export const projectNeedsAssetFolderPlacement = (project: object): boolean => {
  const record = project as { name?: unknown };
  if (typeof record.name !== 'string') return false;
  const seen = new Set<object>();
  const walk = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some((item) => walk(item));
    const entries = value as { relativePath?: unknown; sourceRelativePath?: unknown };
    if (typeof entries.relativePath === 'string' && isLegacyAssetRelative(entries.relativePath)) return true;
    if (typeof entries.sourceRelativePath === 'string' && isLegacyAssetRelative(entries.sourceRelativePath)) return true;
    return Object.values(value).some((child) => walk(child));
  };
  return walk(project);
};

const applyNode = (value: unknown, replacements: ReadonlyMap<string, string>, seen: WeakMap<object, unknown>): unknown => {
  if (!value || typeof value !== 'object') return value;
  const cached = seen.get(value);
  if (cached) return cached;
  seen.set(value, value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const child = applyNode(item, replacements, seen);
      changed ||= child !== item;
      return child;
    });
    const result = changed ? next : value;
    seen.set(value, result);
    return result;
  }
  let changed = false;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if ((key === 'relativePath' || key === 'sourceRelativePath') && typeof child === 'string') {
      const replacement = replacements.get(normalizeRelative(child));
      if (replacement && replacement !== normalizeRelative(child)) {
        output[key] = replacement;
        changed = true;
        continue;
      }
    }
    if (key === 'url' && typeof child === 'string') {
      const decoded = decodeAssetUrl(child);
      const replacement = replacements.get(decoded);
      if (decoded && replacement && replacement !== decoded) {
        output[key] = assetUrl(replacement);
        changed = true;
        continue;
      }
    }
    const mapped = applyNode(child, replacements, seen);
    if (mapped !== child) changed = true;
    output[key] = mapped;
  }
  if (!changed) return value;
  const result = { ...source, ...output };
  seen.set(value, result);
  return result;
};

/** Patch only paths that still match the file that was moved. Newer edits stay put. */
export const applyAssetPathMoves = <T extends { project?: { id?: string }; projects?: Array<{ id?: string }> }>(
  state: T,
  moves: readonly AssetPathMove[] | undefined,
): T => {
  if (!moves?.length || !state) return state;
  const byProject = new Map<string, Map<string, string>>();
  for (const move of moves) {
    if (!move?.projectId || !move.from || !move.to || move.from === move.to) continue;
    let replacements = byProject.get(move.projectId);
    if (!replacements) byProject.set(move.projectId, replacements = new Map());
    replacements.set(normalizeRelative(move.from), move.to);
  }
  if (!byProject.size) return state;
  const seen = new WeakMap<object, unknown>();
  const applyProject = <P extends { id?: string }>(project: P): P => {
    const replacements = project?.id ? byProject.get(project.id) : undefined;
    if (!replacements?.size) return project;
    return applyNode(project, replacements, seen) as P;
  };
  let projectsChanged = false;
  const projects = Array.isArray(state.projects) ? state.projects.map((project) => {
    const next = applyProject(project);
    projectsChanged ||= next !== project;
    return next;
  }) : state.projects;
  const activeIndex = Array.isArray(state.projects) ? state.projects.findIndex((project) => project === state.project) : -1;
  const project = activeIndex >= 0 && projects ? projects[activeIndex] : state.project ? applyProject(state.project) : state.project;
  if (!projectsChanged && project === state.project) return state;
  return { ...state, project, projects };
};

let assetPathMoveListener: ((moves: readonly AssetPathMove[]) => void) | undefined;

export const setAssetPathMoveListener = (listener: ((moves: readonly AssetPathMove[]) => void) | undefined): void => {
  assetPathMoveListener = listener;
};

export const publishAssetPathMoves = (moves: readonly AssetPathMove[] | undefined): void => {
  if (moves?.length) assetPathMoveListener?.(moves);
};

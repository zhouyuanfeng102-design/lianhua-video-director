import type { AppState, Project, ProjectLibraryReference } from './types';

export type ProjectLibraryMetadata = Pick<Project, 'id' | 'name' | 'description' | 'createdAt' | 'updatedAt' | 'backgroundSuspended'>;
export type PersistedProjectLibraryEntry = ProjectLibraryMetadata & { __projectLibraryReference: ProjectLibraryReference };

const digestPattern = /^[a-f0-9]{64}$/u;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const countKeys = ['sourceDocuments', 'scenes', 'storyboards', 'assets'] as const;

/** References are accepted only as checked immutable block locators. The main
 * process still verifies the referenced file before loading or committing it. */
export const projectLibraryReferenceOf = (project: unknown): ProjectLibraryReference | undefined => {
  if (!record(project)) return undefined;
  const reference = project.__projectLibraryReference;
  if (!record(reference) || !digestPattern.test(String(reference.hash || ''))
    || typeof reference.schemaVersion !== 'number' || !Number.isInteger(reference.schemaVersion) || reference.schemaVersion < 0
    || !record(reference.counts)) return undefined;
  const counts = reference.counts;
  if (countKeys.some((key) => typeof counts[key] !== 'number'
    || !Number.isSafeInteger(counts[key]) || Number(counts[key]) < 0)) return undefined;
  return reference as unknown as ProjectLibraryReference;
};

export const isProjectLibraryReference = (project: unknown): boolean => Boolean(projectLibraryReferenceOf(project));

export const projectLibraryMetadata = (project: ProjectLibraryMetadata): ProjectLibraryMetadata => ({
  id: project.id,
  name: project.name,
  description: project.description,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  ...(project.backgroundSuspended === undefined ? {} : { backgroundSuspended: project.backgroundSuspended }),
});

export const createProjectLibraryPlaceholder = (
  project: ProjectLibraryMetadata,
  reference: ProjectLibraryReference,
): Project => ({
  ...projectLibraryMetadata(project),
  __projectLibraryReference: reference,
  sourceDocuments: [], characters: [], locations: [], props: [], scenes: [],
  storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
});

/** Only the locator/summary goes on the wire. Placeholder collections must
 * never be mistaken for an emptied project by persistence or export code. */
export const projectForStateSerialization = (project: Project): Project | PersistedProjectLibraryEntry => {
  const reference = projectLibraryReferenceOf(project);
  if (project.__projectLibraryReference !== undefined && !reference) throw new Error('项目目录引用无效，现有项目未被覆盖');
  if (!reference) return project;
  return { ...projectLibraryMetadata(project), __projectLibraryReference: reference };
};

type PersistedProject = { hash: string; schemaVersion: number; snapshot: Project };
const persistedProjects = new WeakMap<Project, PersistedProject>();
const projectSchemas = new WeakMap<Project, number>();

/** Copy the JSON object structure while reusing immutable string values. The
 * native worker post still freezes the transport, while this small retained
 * graph lets us detect edits made to the caller's objects before or after ACK.
 * It visits hydrated projects only and never parses or copies unopened blocks. */
const captureProjectSnapshot = (project: Project): Project => {
  const copied = new WeakMap<object, object>();
  const copy = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    const cached = copied.get(value);
    if (cached) return cached;
    if (value instanceof Date) return new Date(value.getTime());
    const result: any = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value));
    copied.set(value, result);
    for (const key of Object.keys(value)) result[key] = copy((value as Record<string, unknown>)[key]);
    return result;
  };
  return copy(project) as Project;
};

export const rememberProjectSchema = (project: Project, schemaVersion: number): void => {
  projectSchemas.set(project, schemaVersion);
};

export const rememberPersistedProject = (project: Project, hash: unknown, schemaVersion: number, snapshot?: Project): void => {
  if (typeof hash !== 'string' || !digestPattern.test(hash) || isProjectLibraryReference(project)) return;
  persistedProjects.set(project, { hash, schemaVersion, snapshot: snapshot || captureProjectSnapshot(project) });
  projectSchemas.set(project, schemaVersion);
};

export const hasUnsavedDesktopProjects = (state: AppState): boolean => (
  [state.project, ...state.projects].some((project) => {
    if (isProjectLibraryReference(project)) return false;
    const persisted = persistedProjects.get(project);
    return !persisted || !samePersistedData(project, persisted.snapshot);
  })
);

export const stateHasProjectLibraryReferences = (state: Pick<AppState, 'project' | 'projects'>): boolean => (
  isProjectLibraryReference(state.project) || state.projects.some(isProjectLibraryReference)
);

/** Capture identities and contents at encode time. Both a new same-ID object
 * and an in-place edit must stay dirty when an older snapshot is acknowledged. */
export const prepareDesktopStateSave = (state: AppState, currentSchemaVersion: number) => {
  const captures = new Map<string, Map<Project, { snapshot: Project; schemaVersion: number }>>();
  const converted = new WeakMap<Project, Project>();
  const convert = (project: Project): Project => {
    const cached = converted.get(project);
    if (cached) return cached;
    if (isProjectLibraryReference(project)) return project;
    let owners = captures.get(project.id);
    if (!owners) captures.set(project.id, owners = new Map());
    let persisted = persistedProjects.get(project);
    if (persisted && !samePersistedData(project, persisted.snapshot)) {
      persistedProjects.delete(project);
      persisted = undefined;
    }
    const schemaVersion = projectSchemas.get(project) ?? Math.max(currentSchemaVersion, state.schemaVersion || 0);
    const snapshot = persisted?.snapshot || captureProjectSnapshot(project);
    owners.set(project, { snapshot, schemaVersion });
    const wire = persisted
      ? createProjectLibraryPlaceholder(snapshot, { hash: persisted.hash, schemaVersion: persisted.schemaVersion, counts: {
        sourceDocuments: snapshot.sourceDocuments.length, scenes: snapshot.scenes.length,
        storyboards: snapshot.storyboards.length, assets: snapshot.assets.length,
      } })
      : { ...snapshot, __projectSchemaVersion: schemaVersion };
    converted.set(project, wire);
    return wire;
  };
  const project = convert(state.project);
  const projects = state.projects.map(convert);
  return {
    state: { ...state, project, projects },
    acknowledge: (hashes: Record<string, string> | undefined) => {
      if (!hashes) return;
      captures.forEach((owners, id) => {
        // A malformed legacy state may hold unequal same-ID copies. A single
        // returned hash cannot safely stand for both distinct objects.
        if (owners.size !== 1) return;
        const [owner, captured] = owners.entries().next().value as [Project, { snapshot: Project; schemaVersion: number }];
        if (!samePersistedData(owner, captured.snapshot)) {
          persistedProjects.delete(owner);
          return;
        }
        rememberPersistedProject(owner, hashes[id], captured.schemaVersion, captured.snapshot);
      });
    },
  };
};

/** JSON-shaped equality ignoring object key order and optional undefined
 * properties. This checks only hydrated projects, never unopened blocks. */
export const samePersistedData = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => samePersistedData(value, right[index]));
  if (!record(left) || !record(right)) return false;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
    && samePersistedData(left[key], right[key]));
};

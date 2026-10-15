import assert from 'node:assert/strict';
import {
  CURRENT_SCHEMA_VERSION,
  createInitialState,
  hasUnsavedDesktopProjects,
  loadDesktopProject,
  loadDesktopState,
  loadState,
  needsInitialDesktopSave,
  normalizeState,
  saveStateAsync,
  serializeStateForStorage,
} from '../src/storage';
import {
  createProjectLibraryPlaceholder,
  isProjectLibraryReference,
  prepareDesktopStateSave,
  projectLibraryReferenceOf,
  samePersistedData,
} from '../src/projectLibraryRuntime';
import { encodeStateSnapshot } from '../src/stateSerialization';
import type { AppState, Project, ProjectLibraryReference } from '../src/types';

const clone = <T>(value: T): T => structuredClone(value);
const initial = normalizeState(createInitialState());
const canonical = normalizeState(JSON.parse(serializeStateForStorage(initial).serialized));
assert.ok(samePersistedData(initial, canonical), 'current normalization is stable before persistence tracking is tested');
const activeHash = 'a'.repeat(64);
const archiveHash = 'b'.repeat(64);
const updatedHash = 'c'.repeat(64);
const archiveReference: ProjectLibraryReference = {
  hash: archiveHash, schemaVersion: 8, counts: { sourceDocuments: 9, scenes: 42, storyboards: 27, assets: 18 },
};
const archived = createProjectLibraryPlaceholder({
  id: 'archive', name: 'archive title', description: 'summary only', createdAt: 1, updatedAt: 2,
}, archiveReference);
const raw = {
  ...clone(canonical),
  project: { ...clone(canonical.project), __persistedProjectHash: activeHash, __projectSchemaVersion: CURRENT_SCHEMA_VERSION },
  projects: [{ id: canonical.project.id, __activeProjectReference: true }, archived],
};
const state = normalizeState(raw);
assert.equal(state.projects.length, 2);
assert.equal(state.project, state.projects[0]);
assert.equal(isProjectLibraryReference(state.project), false);
assert.ok(isProjectLibraryReference(state.projects[1]));
assert.equal(state.projects[1].sourceDocuments.length, 0);
assert.equal(state.projects[1].storyboards.length, 0);
assert.deepEqual(projectLibraryReferenceOf(state.projects[1]), archiveReference);
assert.equal(state.project.__persistedProjectHash, undefined, 'disk hash is held by immutable object identity, not a spreadable field');
assert.equal(state.project.__projectSchemaVersion, undefined);
assert.equal(hasUnsavedDesktopProjects(state), false, 'checked unchanged full project and unopened references are clean');
assert.equal(needsInitialDesktopSave(state), false, 'opening an already current workspace needs no startup write');

const invalidReference = { ...archived, __projectLibraryReference: { ...archiveReference, hash: '../bad-path' } };
assert.throws(() => normalizeState({ ...raw, projects: [invalidReference] }), /目录引用无效/u);
const malformedUnopenedContents = { ...archived, storyboards: [{ id: 'never-normalize-this', shots: [{ referenceAssetIds: null }] }] };
const unopened = normalizeState({ ...raw, projects: [malformedUnopenedContents] }).projects.find((item) => item.id === archived.id)!;
assert.equal(unopened.storyboards.length, 0, 'directory references never run full content migrations or accept placeholder content');

const changedSettings = normalizeState({ ...raw, settings: { ...raw.settings, uiFontScalePercent: 999 } });
assert.equal(hasUnsavedDesktopProjects(changedSettings), false);
assert.equal(needsInitialDesktopSave(changedSettings), true, 'required settings normalization is still persisted');
const oldActive = normalizeState({ ...raw, project: { ...raw.project, __projectSchemaVersion: 8 } });
assert.equal(needsInitialDesktopSave(oldActive), true, 'a project has its own schema even when the workspace envelope is current');
assert.equal(prepareDesktopStateSave(oldActive, CURRENT_SCHEMA_VERSION).state.project.__projectSchemaVersion, CURRENT_SCHEMA_VERSION);
assert.equal(projectLibraryReferenceOf(prepareDesktopStateSave(state, CURRENT_SCHEMA_VERSION).state.projects[1])?.schemaVersion, 8);

const exported = serializeStateForStorage(state);
assert.equal(exported.serializedState.project, state.project, 'exports/restorepoints retain the loaded active project body');
const exportedArchive = exported.serializedState.projects.find((item) => item.id === archived.id)!;
assert.deepEqual(Object.keys(exportedArchive).sort(), ['__projectLibraryReference', 'createdAt', 'description', 'id', 'name', 'updatedAt']);
assert.ok(exported.serialized.includes(archiveHash));
const policy = { currentSchemaVersion: CURRENT_SCHEMA_VERSION, maxBytes: Infinity, desktopBrowserCacheBytes: 2 * 1024 * 1024 };
assert.equal(encodeStateSnapshot(state, policy, true).browserCache, undefined, 'an incomplete lazy workspace never replaces the browser mirror');
assert.throws(() => encodeStateSnapshot(state, policy, false), /完整浏览器存档/u);

const originalWindow = globalThis.window;
const originalWorker = globalThis.Worker;
let browserReads = 0;
let browserWrites = 0;
let oldLoads = 0;
let compactLoads = 0;
let projectLoads = 0;
const writes: any[] = [];
let gate: { promise: Promise<void>; resolve: () => void } | undefined;
let rejectWrite = false;
const archivedFull: Project = { ...clone(canonical.project), id: archived.id, name: archived.name, createdAt: 1, updatedAt: 2 };
Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: undefined });
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  localStorage: { getItem: () => { browserReads++; return 'stale browser content'; }, setItem: () => { browserWrites++; } },
  lianhuaDesktop: {
    loadState: async () => { oldLoads++; throw new Error('legacy all-project load must not run'); },
    loadWorkspaceState: async () => { compactLoads++; return JSON.stringify(raw); },
    loadProject: async (id: string, hash: string) => {
      projectLoads++;
      assert.equal(id, archived.id); assert.equal(hash, archiveHash);
      return { project: archivedFull, schemaVersion: archiveReference.schemaVersion, hash: archiveHash };
    },
    saveState: async (content: string) => {
      const value = JSON.parse(content); writes.push(value);
      const capturedGate = gate; gate = undefined;
      if (capturedGate) await capturedGate.promise;
      if (rejectWrite) return { ok: false, checksum: '' };
      return { ok: true, checksum: 'mock', projectHashes: { [state.project.id]: updatedHash, [archived.id]: archiveHash } };
    },
  },
} });

try {
  loadState();
  assert.equal(browserReads, 0, 'desktop startup does not synchronously load stale localStorage');
  const loaded = await loadDesktopState();
  assert.ok(loaded); assert.equal(compactLoads, 1); assert.equal(oldLoads, 0);
  assert.equal(loaded!.projects.length, 2); assert.equal(projectLoads, 0, 'the unopened project is not fetched at startup');
  const hydrated = await loadDesktopProject(archived.id, archiveReference, loaded!);
  assert.equal(projectLoads, 1); assert.equal(hydrated.id, archived.id);
  assert.equal(isProjectLibraryReference(hydrated), false);
  assert.ok(hydrated.sourceDocuments.length > 0, 'opening a project fetches its real contents');
  assert.ok(hasUnsavedDesktopProjects({ ...loaded!, project: hydrated, projects: [hydrated] }), 'older per-project schema remains dirty after normalization');

  await saveStateAsync(state);
  assert.ok(writes[0].project.__projectLibraryReference, 'an unchanged loaded active project is sent as a checked hash');
  assert.deepEqual(writes[0].projects[0], { id: state.project.id, __activeProjectReference: true });
  assert.equal(writes[0].project.sourceDocuments, undefined, 'full project bytes are absent from an unchanged save');
  assert.equal(writes[0].projects[1].sourceDocuments, undefined, 'placeholder empty arrays never overwrite an unopened block');
  assert.equal(browserWrites, 0);

  const editedProject = { ...state.project, name: 'edited once' };
  const edited: AppState = { ...state, project: editedProject, projects: state.projects.map((item) => item.id === editedProject.id ? editedProject : item) };
  let resolve!: () => void;
  gate = { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
  const finishWrite = gate.resolve;
  const saving = saveStateAsync(edited);
  for (let index = 0; index < 15; index++) await Promise.resolve();
  const editedAgainProject = { ...editedProject, description: 'edited while acknowledgement pending' };
  const editedAgain: AppState = { ...edited, project: editedAgainProject, projects: edited.projects.map((item) => item.id === editedAgainProject.id ? editedAgainProject : item) };
  assert.equal(hasUnsavedDesktopProjects(editedAgain), true);
  finishWrite(); await saving;
  assert.equal(hasUnsavedDesktopProjects(edited), false, 'acknowledgement marks exactly its captured immutable project');
  assert.equal(hasUnsavedDesktopProjects(editedAgain), true, 'a newer same-ID object never inherits the older save hash');
  assert.equal(writes[1].project.name, 'edited once');
  assert.equal(writes[1].project.__projectSchemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(writes[1].project.__projectLibraryReference, undefined);
  await saveStateAsync(editedAgain);
  assert.equal(writes[2].project.description, 'edited while acknowledgement pending');
  assert.equal(writes[2].projects[1].__projectLibraryReference.hash, archiveHash);
  assert.equal(hasUnsavedDesktopProjects(editedAgain), false);

  const failedProject = { ...editedAgainProject, name: 'failed write stays dirty' };
  const failed = { ...editedAgain, project: failedProject, projects: [failedProject, state.projects[1]] };
  rejectWrite = true;
  await assert.rejects(saveStateAsync(failed), /本地保存未完成/u);
  assert.equal(hasUnsavedDesktopProjects(failed), true, 'failed acknowledgement cannot mark a changed object persisted');
  rejectWrite = false;
  await saveStateAsync(failed);
  assert.equal(hasUnsavedDesktopProjects(failed), false, 'failed saves release the existing FIFO queue');

  // The serialization API permits callers to mutate their live graph after
  // posting. A later acknowledgement must describe the posted snapshot only.
  const mutableProject = { ...failedProject, name: 'before in-place edit',
    sourceDocuments: failedProject.sourceDocuments.map((document) => ({ ...document })) };
  const mutableState: AppState = { ...failed, project: mutableProject, projects: [mutableProject, state.projects[1]] };
  let releaseMutable!: () => void;
  gate = { promise: new Promise<void>((done) => { releaseMutable = done; }), resolve: () => releaseMutable() };
  const finishMutable = gate.resolve;
  const saveMutable = saveStateAsync(mutableState);
  for (let index = 0; index < 15; index++) await Promise.resolve();
  mutableProject.name = 'in-place edit while acknowledgement pending';
  finishMutable(); await saveMutable;
  assert.equal(hasUnsavedDesktopProjects(mutableState), true, 'in-place edits after capture cannot inherit a stale save hash');
  await saveStateAsync(mutableState);
  assert.equal(writes.at(-1).project.name, mutableProject.name);
  assert.equal(writes.at(-1).project.__projectLibraryReference, undefined, 'the next save includes the changed live body');
  assert.equal(hasUnsavedDesktopProjects(mutableState), false);
  mutableProject.sourceDocuments[0].content += '\nNested in-place source edit after successful save.';
  assert.equal(hasUnsavedDesktopProjects(mutableState), true, 'nested edits after acknowledgement invalidate the known block too');
  await saveStateAsync(mutableState);
  assert.equal(writes.at(-1).project.sourceDocuments[0].content, mutableProject.sourceDocuments[0].content);
  assert.equal(writes.at(-1).project.__projectLibraryReference, undefined);
} finally {
  gate?.resolve();
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: originalWorker });
}

console.log('Lazy project storage checks passed: compact startup, checked single-project hydration, per-project migration, clean startup/settings migration, incremental identity acknowledgements, failed-write recovery, full active export and no partial browser mirror.');

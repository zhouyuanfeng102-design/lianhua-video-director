import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { removeProjectFromLibrary, removeProjectsFromLibrary } from '../src/appEffects';
import { isVideoGenerationTask } from '../src/generationTasks';
import { videoTaskHasUnresolvedSubmission } from '../src/videoGenerationQueue';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, Project, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDesktop } from '../src/videoGenerationTypes';

// Actual App handlers plus the production video engine, using only in-memory
// projects and a synthetic desktop bridge. No real storage or network calls.
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const librarySource = appSource.slice(appSource.indexOf('const withProjectLibrary ='), appSource.indexOf('export default function App()'));
const handlersSource = appSource.slice(appSource.indexOf('const projectDeletionVideoReminder ='), appSource.indexOf('const handleNewProject ='));
const fixtureProject = (id: string, tasks: Project['generationTasks'] = []): Project => ({
  ...createInitialState().project, id, name: id, generationTasks: tasks, assets: [],
});
const running = { id: 'running-video', kind: 'video', status: 'running', remoteTaskId: 'remote-running', requestBody: {}, createdAt: 1, updatedAt: 1 } as VideoGenerationTask;
const stoppedUnknown = { ...running, id: 'stopped-unknown-video', status: 'unknown' as const,
  videoJob: { stage: 'stopped', trackingStopped: true } } as VideoGenerationTask;
const handlers = (projects: Project[], selectedIds: string[], accepted: boolean) => {
  let state: AppState = { ...createInitialState(), project: projects[0], projects, activeProjectId: projects[0].id };
  const stateRef = { current: state };
  const confirmations: string[] = []; const notices: string[] = []; let reconciliations = 0;
  const context = vm.createContext({
    stateRef, selectedProjectIds: selectedIds,
    stateWithCurrentDraft: (value: AppState) => value,
    removeProjectFromLibrary, removeProjectsFromLibrary, isVideoGenerationTask, videoTaskHasUnresolvedSubmission,
    notify: (message: string) => notices.push(message),
    window: { confirm: (message: string) => { confirmations.push(message); return accepted; } },
    setState: (next: AppState) => { state = next; stateRef.current = next; },
    videoController: { reconcileProjectLibrary: () => { reconciliations++; assert.equal(stateRef.current, state); } },
    syncWorkspaceUiState: () => {}, setView: () => {}, setSelectedProjectIds: () => {},
  });
  const output = transpileModule(`${librarySource}\n${handlersSource}\nglobalThis.single = handleDeleteProject; globalThis.batch = handleDeleteSelectedProjects;`, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  new vm.Script(output).runInContext(context);
  return { single: context.single as (id: string) => void, batch: context.batch as () => void,
    state: () => state, confirmations, notices, reconciliations: () => reconciliations };
};

{
  const h = handlers([fixtureProject('delete-running', [running]), fixtureProject('keep')], [], true);
  h.single('delete-running');
  assert.equal(h.confirmations.length, 1); assert.match(h.confirmations[0], /1 个远端生成中或结果待确认/u);
  assert.match(h.confirmations[0], /仍可能继续运行和计费/u);
  assert.deepEqual(Array.from(h.state().projects, (project) => project.id), ['keep']);
  assert.equal(h.state().project.id, 'keep'); assert.equal(h.reconciliations(), 1);
}
{
  const h = handlers([fixtureProject('running', [running]), fixtureProject('stopped', [stoppedUnknown]), fixtureProject('keep')], ['running', 'stopped'], true);
  h.batch(); assert.equal(h.confirmations.length, 1); assert.match(h.confirmations[0], /2 个远端生成中或结果待确认/u);
  assert.deepEqual(Array.from(h.state().projects, (project) => project.id), ['keep']); assert.equal(h.reconciliations(), 1);
}
for (const batch of [false, true]) {
  const h = handlers([fixtureProject('cancel', [running]), fixtureProject('keep')], ['cancel'], false);
  const original = JSON.stringify(h.state());
  if (batch) h.batch(); else h.single('cancel');
  assert.equal(h.confirmations.length, 1); assert.equal(JSON.stringify(h.state()), original);
  assert.equal(h.reconciliations(), 0, 'declining deletion keeps local tracking intact');
}
{
  const h = handlers([fixtureProject('completed', [{ ...running, status: 'succeeded' }]), fixtureProject('keep')], [], true);
  h.single('completed'); assert.equal(h.confirmations.length, 1);
  assert.doesNotMatch(h.confirmations[0], /提醒/u, 'terminal tasks do not produce an unresolved-task warning');
}
{
  const h = handlers([fixtureProject('last', [running])], ['last'], true);
  h.batch(); assert.equal(h.confirmations.length, 0); assert.match(h.notices[0], /至少保留一个项目/u);
}

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 3));
const waitFor = async (predicate: () => boolean, label: string) => {
  for (let index = 0; index < 500; index++) { if (predicate()) return; await tick(); }
  assert.fail(label);
};
const api: VideoTaskApiConfig = { enabled: true, provider: 'generic', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  endpoint: 'https://delete.fixture.test/generate', statusEndpointTemplate: 'https://delete.fixture.test/tasks/{id}',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' };
const result = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const taskDraft = (name: string) => ({ name, prompt: `Synthetic ${name}`, backend: 'api' as const, references: [], parameters: {} });

for (const delayedOperation of ['post', 'checkpoint', 'query'] as const) {
  const owner = fixtureProject(`delete-${delayedOperation}`); const keep = fixtureProject('survivor');
  let state = { ...createInitialState(), project: owner, projects: [owner, keep], activeProjectId: owner.id };
  state.settings = { ...state.settings, videoTaskApi: api, videoExecutionMode: 'queue', videoExecutionConcurrency: 1 };
  const gate = deferred<void>(); const requests: Array<{ method?: string; url: string; requestId: string }> = [];
  const journals = new Map<string, VideoGenerationTask>(); const cancellations: string[] = [];
  const saves: string[] = []; let held = false;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      requests.push(request); assert.equal(new URL(request.url).hostname, 'delete.fixture.test');
      const belongsToRemovedProject = request.body?.includes(`Synthetic ${owner.id}`) || request.url.endsWith('/remote-owner');
      if (belongsToRemovedProject && (delayedOperation === 'post' && request.method === 'POST'
        || delayedOperation === 'query' && request.method === 'GET')) { held = true; await gate.promise; }
      return result(request.method === 'POST'
        ? { id: belongsToRemovedProject ? 'remote-owner' : 'remote-survivor', status: 'running' }
        : { id: request.url.split('/').at(-1), status: 'running' });
    },
    cancelVideoRequest: async (requestId) => { cancellations.push(requestId); return true; },
    watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (task) => {
      if (delayedOperation === 'checkpoint' && task.videoJob?.snapshot.projectId === owner.id && !held) { held = true; await gate.promise; }
      journals.set(task.id, structuredClone(task)); return { persisted: true };
    },
    getVideoTaskCheckpoint: async (id) => structuredClone(journals.get(id) || null),
    deleteVideoTaskCheckpoint: async (id) => journals.delete(id),
    downloadGeneratedMedia: async () => { assert.fail('a deleted project must not accept a download'); },
  };
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop,
    onRuntime: () => {}, pollIntervalMs: 60_000, persistState: async () => { saves.push(serializeStateForStorage(state).serialized); } });
  let oldStart: Promise<string> | undefined;
  try {
    oldStart = engine.start(taskDraft(owner.id));
    if (delayedOperation === 'query') { await oldStart; await engine.resume(state.project.generationTasks[0].id); }
    await waitFor(() => held, `missing delayed ${delayedOperation}`);
    state = { ...state, project: keep, projects: [keep], activeProjectId: keep.id };
    engine.reconcile();
    const survivorId = await engine.start(taskDraft('survivor'));
    assert.ok(state.project.generationTasks.some((task) => task.id === survivorId && task.remoteTaskId === 'remote-survivor'),
      'removed non-settling work releases local admission immediately');
    assert.ok(requests.filter((request) => request.method === 'POST').every((request) => request.url.endsWith('/generate')),
      'deletion sends no remote cancellation or global interrupt');
    if (delayedOperation !== 'checkpoint') assert.ok(cancellations.length > 0, 'only local requests are stopped');
    gate.resolve(); await oldStart; await tick(); await tick();
    engine.reconcile();
    assert.deepEqual(state.projects.map((project) => project.id), ['survivor']);
    assert.equal(state.project.generationTasks.length, 1, 'late reply does not recreate a removed project or task');
    const persisted = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
    assert.deepEqual(persisted.projects.map((project) => project.id), ['survivor']);
    assert.ok(saves.length > 0);
  } finally { gate.resolve(); engine.dispose(); await oldStart?.catch(() => {}); }
}
console.log('Project deletion advisory: single/batch confirmation, cancel, terminal/last-project handling, delayed POST/checkpoint/query cleanup and no project resurrection passed');

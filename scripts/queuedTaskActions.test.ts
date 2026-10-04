import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as tasks from '../src/generationTasks';
import { applyOwnedProjectUpdate, commitStateTransition, takeHistoryStep } from '../src/appEffects';
import { isImageTaskActiveInWorkspace } from '../src/imageBatch';
import { createStoryboardImageBatchLifecycle } from '../src/storyboardImages';
import { createInitialState } from '../src/storage';
import { isUnsubmittedVideoTask, videoTaskHasUnresolvedSubmission } from '../src/videoGenerationQueue';
import { removeVideoTaskKeepingProvenance } from '../src/videoProvenance';
import { videoTaskBatchStatus } from '../src/videoTaskBatchStatus';
import { formatUserFacingError } from '../src/userFacingError';
import type { AppState, GenerationTask, ImageGenerationTask, VideoGenerationTask } from '../src/types';

// Execute the actual task-center button callbacks, not duplicated reducers.
// The video controller below is an in-memory boundary mock. No network, user
// data, desktop IPC, generated media, or live queue is opened by these checks.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const view = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'GenerationTasksView');
assert.ok(view && ts.isFunctionDeclaration(view) && view.body);
const actionSource = ['cancelQueuedTask', 'removeTask'].map((name) => {
  const statement = view.body!.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === name));
  assert.ok(statement, `production ${name} callback must remain covered`);
  return statement.getText(ast);
}).join('\n');
const compiled = ts.transpileModule(actionSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const image = (id: string, overrides: Partial<ImageGenerationTask> = {}): ImageGenerationTask => ({
  id, kind: 'image', name: id, assetKind: 'character', imageVariant: 'five-view', status: 'queued',
  prompt: '', width: 1536, height: 1024, backend: 'openai', model: 'mock', createdAt: 100, updatedAt: 100, ...overrides,
});
const autofill = (id: string): GenerationTask => ({
  id, kind: 'autofill', name: id, assetKind: 'character', status: 'queued', requestedFields: ['appearance'],
  model: 'mock', createdAt: 100, updatedAt: 100,
});
const video = (id: string): VideoGenerationTask => ({
  id, kind: 'video', status: 'draft', targetId: 'mock', storyboardId: 'mock-board', requestBody: {}, createdAt: 100, updatedAt: 100,
  videoJob: {
    stage: 'queued', preparation: { version: 1, phase: 'preparing', uploadedImages: [] }, batchQueueState: 'ready',
    snapshot: {
      projectId: 'fixture', clientId: 'fixture-client', images: [],
      draft: { name: id, backend: 'api', prompt: 'fixture prompt', references: [], parameters: {} },
      connection: { backend: 'api', api: { ...createInitialState().settings.videoTaskApi, provider: 'generic', enabled: true, endpoint: 'https://never-called.invalid/generate' } },
    },
  },
});
const confirmedCancellation = (task: VideoGenerationTask): VideoGenerationTask => ({
  ...task, status: 'failed', updatedAt: 101,
  videoJob: { ...task.videoJob!, stage: 'stopped', batchQueueState: 'cancelled', trackingStopped: true, cancellationConfirmed: true },
});

let fixtureSequence = 0;
const fixture = (initialTasks: GenerationTask[]) => {
  const initial = createInitialState();
  const projectId = `queued-action-project-${++fixtureSequence}`;
  const project = { ...initial.project, id: projectId, assets: [], generationTasks: initialTasks };
  let state: AppState = { ...initial, project, projects: [project], activeProjectId: projectId };
  const renderState = state;
  let undo: AppState[] = [];
  let redo: AppState[] = [];
  let historyWrites = 0;
  let backgroundWrites = 0;
  let cancelledIds: string[] = [];
  const notices: string[] = [];
  const lifecycle = createStoryboardImageBatchLifecycle();
  const update = (recordHistory: boolean) => (reduce: (current: AppState) => AppState) => {
    if (recordHistory) historyWrites += 1; else backgroundWrites += 1;
    const transition = commitStateTransition(state, reduce(state), undo, redo, recordHistory, 50, recordHistory ? undefined : reduce);
    state = transition.current; undo = transition.undo; redo = transition.redo;
  };
  const replaceTask = (replacement: GenerationTask) => update(false)((current) => applyOwnedProjectUpdate(current, projectId, (owner) => ({
    ...owner, generationTasks: owner.generationTasks.map((entry) => entry.id === replacement.id ? replacement : entry),
  })));
  let onCancel = async (task: VideoGenerationTask): Promise<void> => { replaceTask(confirmedCancellation(task)); };
  const ctx = {
    getCurrentState: () => state,
    setBackgroundState: update(false),
    videoController: { cancel: async (id: string) => {
      cancelledIds.push(id);
      const task = state.project.generationTasks.find((entry): entry is VideoGenerationTask => entry.id === id && tasks.isVideoGenerationTask(entry));
      assert.ok(task, 'the App must cancel the requested live task');
      await onCancel(task);
    } },
  };
  const dependencies = {
    ...tasks, ctx, state: renderState, setState: update(true), busyId: '', runtimeById: {},
    storyboardImageBatchLifecycle: lifecycle, isImageTaskActiveInWorkspace, applyOwnedProjectUpdate,
    isUnsubmittedVideoTask, videoTaskHasUnresolvedSubmission, videoTaskBatchStatus, removeVideoTaskKeepingProvenance,
    formatUserFacingError, notify: (message: string) => notices.push(message),
  };
  const actions = new Function('d', `with(d){${compiled};return {cancelQueuedTask,removeTask};}`)(dependencies) as {
    cancelQueuedTask: (id: string) => void;
    removeTask: (id: string) => Promise<void>;
  };
  const historyState = (entries: GenerationTask[], label: string): AppState => {
    const owner = { ...state.project, generationTasks: entries, description: label };
    return { ...state, project: owner, projects: [owner] };
  };
  return {
    ...actions, projectId, lifecycle, notices, replaceTask,
    setCancel: (handler: typeof onCancel) => { onCancel = handler; },
    addHistory: (entries: GenerationTask[], label: string, toRedo = false) => {
      if (toRedo) redo.push(historyState(entries, label)); else undo.push(historyState(entries, label));
    },
    undo: () => { const moved = takeHistoryStep(state, undo, redo); state = moved.current; undo = moved.source; redo = moved.destination; },
    redo: () => { const moved = takeHistoryStep(state, redo, undo); state = moved.current; redo = moved.source; undo = moved.destination; },
    current: () => state,
    history: () => ({ undo, redo }),
    writes: () => ({ historyWrites, backgroundWrites }),
    cancelledIds: () => [...cancelledIds],
  };
};

for (const category of ['ordinary', 'storyboard', 'regeneration', 'autofill'] as const) {
  for (const operation of ['cancel', 'delete'] as const) {
    test(`production ${operation} acts immediately on ${category} queued tasks and retains unrelated work`, async () => {
      const target = category === 'autofill' ? autofill(`target-${category}-${operation}`) : image(`target-${category}-${operation}`, {
        ...(category === 'storyboard' ? { assetKind: 'storyboard', imageVariant: 'storyboard-frame', sourceStoryboardId: 'board', batchId: 'batch' } : {}),
        ...(category === 'regeneration' ? { regenerationRootTaskId: 'original', regenerationSourceTaskId: 'original' } : {}),
      });
      const other = image('unrelated-running', { status: 'running' });
      const env = fixture([target, other]);
      env.addHistory([target, other], 'undo-current-task');
      env.addHistory([target, other], 'redo-current-task', true);
      const lease = env.lifecycle.begin('target-lease')!;
      env.lifecycle.trackBatchSubmissions(lease, [target.id]);
      if (operation === 'cancel') env.cancelQueuedTask(target.id); else await env.removeTask(target.id);
      assert.equal(env.current().project.generationTasks.find((entry) => entry.id === target.id)?.status, operation === 'cancel' ? 'cancelled' : undefined);
      assert.strictEqual(env.current().project.generationTasks.find((entry) => entry.id === other.id), other);
      assert.equal(tasks.isGenerationTaskRevoked(env.projectId, target), true);
      assert.equal(env.lifecycle.isActive('target-lease'), false, 'cancelled batches immediately release their local start guard');
      assert.equal(env.writes().historyWrites, 0, 'queue removal rebases existing history instead of creating a reversible submission');
      assert.deepEqual(env.cancelledIds(), [], 'local image/autofill cancellation must not call a video or remote API');
      for (const snapshot of [...env.history().undo, ...env.history().redo]) {
        assert.equal(snapshot.project.generationTasks.find((entry) => entry.id === target.id)?.status, operation === 'cancel' ? 'cancelled' : undefined);
      }
      env.undo(); env.redo();
      assert.equal(env.current().project.generationTasks.find((entry) => entry.id === target.id)?.status, operation === 'cancel' ? 'cancelled' : undefined);
    });
  }
}

for (const operation of ['cancel', 'delete'] as const) {
  test(`production ${operation} background history replay preserves a different task instance or kind with the same ID`, async () => {
    const target = image(`identity-${operation}`);
    const older = { ...target, createdAt: target.createdAt - 1 };
    const differentKind = { ...autofill(target.id), createdAt: target.createdAt };
    const env = fixture([target]);
    env.addHistory([older], 'different-createdAt');
    env.addHistory([differentKind], 'different-kind', true);
    if (operation === 'cancel') env.cancelQueuedTask(target.id); else await env.removeTask(target.id);
    assert.deepEqual(env.history().undo[0].project.generationTasks, [older]);
    assert.deepEqual(env.history().redo[0].project.generationTasks, [differentKind]);
    assert.equal(tasks.isGenerationTaskRevoked(env.projectId, older), false);
    assert.equal(tasks.isGenerationTaskRevoked(env.projectId, differentKind), false);
  });
}

test('production image/autofill running tasks reject stale cancel and delete clicks', async () => {
  for (const target of [image('running-image', { status: 'running' }), { ...autofill('running-autofill'), status: 'running' as const }]) {
    const env = fixture([target]);
    env.cancelQueuedTask(target.id);
    await env.removeTask(target.id);
    assert.deepEqual(env.current().project.generationTasks, [target]);
    assert.equal(tasks.isGenerationTaskRevoked(env.projectId, target), false);
    assert.equal(env.writes().backgroundWrites, 0);
    assert.equal(env.writes().historyWrites, 0);
  }
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test('production local-video delete awaits confirmed cancellation then removes via background history updates', async () => {
  const target = video('local-queued-video');
  const unrelated = image('keep-running', { status: 'running' });
  const env = fixture([target, unrelated]);
  env.addHistory([target, unrelated], 'video-undo');
  env.addHistory([target, unrelated], 'video-redo', true);
  const cancelStarted = deferred();
  const finishCancel = deferred();
  env.setCancel(async (task) => {
    cancelStarted.resolve(); await finishCancel.promise;
    env.replaceTask(confirmedCancellation(task));
  });
  const pending = env.removeTask(target.id);
  await cancelStarted.promise;
  assert.equal(env.current().project.generationTasks.some((entry) => entry.id === target.id), true, 'no deletion while the controller is checking durable state');
  finishCancel.resolve(); await pending;
  assert.deepEqual(env.cancelledIds(), [target.id]);
  assert.deepEqual(env.current().project.generationTasks, [unrelated]);
  assert.equal(env.writes().historyWrites, 0, 'local queued video deletion must not be undone into an auto-resuming task');
  for (const snapshot of [...env.history().undo, ...env.history().redo]) {
    assert.equal(snapshot.project.generationTasks.some((entry) => entry.id === target.id), false);
  }
  env.undo(); env.redo();
  assert.equal(env.current().project.generationTasks.some((entry) => entry.id === target.id), false);
  assert.match(env.notices.at(-1) || '', /取消并删除/u);
});

for (const recovered of ['remote', 'unknown', 'unconfirmed', 'replacement'] as const) {
  test(`production local-video delete retains a ${recovered} record discovered while awaiting cancellation`, async () => {
    const target = video(`recover-${recovered}`);
    const env = fixture([target]);
    let retained = target;
    env.setCancel(async (task) => {
      await Promise.resolve();
      retained = recovered === 'remote' ? {
        ...task, status: 'submitted', remoteTaskId: 'recovered-remote-id',
        videoJob: { ...task.videoJob!, stage: 'stopped', trackingStopped: true, preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] } },
      } : recovered === 'unknown' ? {
        ...task, status: 'unknown',
        videoJob: { ...task.videoJob!, stage: 'submission-unknown', trackingStopped: true, preparation: { version: 1, phase: 'post-started', uploadedImages: [] } },
      } : recovered === 'replacement' ? { ...confirmedCancellation(task), createdAt: task.createdAt + 1 } : task;
      env.replaceTask(retained);
    });
    await env.removeTask(target.id);
    assert.deepEqual(env.cancelledIds(), [target.id]);
    assert.deepEqual(env.current().project.generationTasks, [retained], 'the App must re-read controller state and preserve a newer/uncertain request');
    assert.equal(env.writes().historyWrites, 0);
  });
}

test('production stopped-looking local video still checks the controller before deletion', async () => {
  const target = video('stale-stopped-local');
  target.status = 'failed'; target.videoJob = { ...target.videoJob!, stage: 'stopped', trackingStopped: true };
  const env = fixture([target]);
  const remote: VideoGenerationTask = {
    ...target, status: 'unknown', remoteTaskId: 'newer-journal-task',
    videoJob: { ...target.videoJob!, preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] } },
  };
  env.setCancel(async () => { env.replaceTask(remote); });
  await env.removeTask(target.id);
  assert.deepEqual(env.cancelledIds(), [target.id]);
  assert.deepEqual(env.current().project.generationTasks, [remote]);
});

test('production remote queued video deletion requests cancellation but preserves its recovery record', async () => {
  const target: VideoGenerationTask = {
    ...video('remote-already-queued'), status: 'submitted', remoteTaskId: 'remote-original',
  };
  target.videoJob = { ...target.videoJob!, preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] } };
  const env = fixture([target]);
  env.setCancel(async () => {});
  await env.removeTask(target.id);
  assert.deepEqual(env.cancelledIds(), [target.id]);
  assert.deepEqual(env.current().project.generationTasks, [target]);
  assert.match(env.notices.at(-1) || '', /远端任务记录暂时保留/u);
});

test('production video cancel errors retain the task and display the cause', async () => {
  const target = video('cancel-error');
  const env = fixture([target]);
  env.setCancel(async () => { throw new Error('取消接口暂不可用，请稍后重试'); });
  await env.removeTask(target.id);
  assert.deepEqual(env.current().project.generationTasks, [target]);
  assert.match(env.notices.at(-1) || '', /取消接口暂不可用/u);
});

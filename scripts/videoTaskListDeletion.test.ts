import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';
import * as generationTasks from '../src/generationTasks';
import { applyOwnedProjectUpdate, commitStateTransition, takeHistoryStep } from '../src/appEffects';
import { createInitialState, normalizeState } from '../src/storage';
import { inspectVideoTaskDeletion, removeVideoTaskFromListKeepingProvenance } from '../src/videoBatchDeletion';
import { videoTaskBatchStatus } from '../src/videoTaskBatchStatus';
import { isUnsubmittedVideoTask, videoTaskHasUnresolvedSubmission } from '../src/videoGenerationQueue';
import { findVideoAssetSourceTask, removeVideoTaskKeepingProvenance, snapshotVideoAssetSourceTask } from '../src/videoProvenance';
import { runningHubRemoteSucceeded } from '../src/videoResultRecovery';
import { formatUserFacingError } from '../src/userFacingError';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { VideoGenerationRuntime } from '../src/videoGenerationTypes';

// Exercise the real single-card JSX and removal callback against isolated state.
// Controller calls are recorded boundaries; no network, desktop profile or media is opened.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const view = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'GenerationTasksView');
assert.ok(view && ts.isFunctionDeclaration(view) && view.body);
const declarations = ['removeTask', 'renderVideoTask'].map((name) => {
  const statement = view.body!.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === name));
  assert.ok(statement, `production ${name} must remain covered`);
  return statement.getText(ast);
}).join('\n');
const compiled = ts.transpileModule(declarations, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;
type Element = React.ReactElement<{ children?: React.ReactNode; [key: string]: any }>;
const descendants = (node: React.ReactNode): Element[] => Array.isArray(node) ? node.flatMap(descendants)
  : React.isValidElement(node) ? [node as Element, ...descendants((node as Element).props.children)] : [];
const text = (node: React.ReactNode): string => Array.isArray(node) ? node.map(text).join('')
  : React.isValidElement(node) ? text((node as Element).props.children)
    : node == null || typeof node === 'boolean' ? '' : String(node);
const empty = () => undefined;
const projectId = 'single-video-deletion-fixture';
const stoppedTask = (id: string, patch: Partial<VideoGenerationTask> = {}): VideoGenerationTask => ({
  id, kind: 'video', status: 'unknown', remoteTaskId: `remote-${id}`, requestFingerprint: `fingerprint-${id}`,
  storyboardId: 'fixture-board', targetId: 'fixture-api', createdAt: 100, updatedAt: 200,
  requestBody: { prompt: 'Synthetic frozen prompt' }, response: { code: 'TaskNotFound', message: 'Task not found' }, error: 'Task not found',
  videoJob: {
    stage: 'stopped', trackingStopped: true, cancellationConfirmed: false, cancellationPending: false,
    preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] }, submittedAt: 150,
    snapshot: {
      projectId, clientId: `client-${id}`, images: [],
      draft: { name: id, backend: 'api', prompt: 'Synthetic frozen prompt', references: [], parameters: {} },
      connection: { backend: 'api', api: { ...createInitialState().settings.videoTaskApi,
        provider: 'generic', enabled: true, endpoint: 'https://never-called.invalid/generate' } },
    },
  }, ...patch,
});

const fixture = (tasks: VideoGenerationTask[], assets: ReferenceAsset[] = []) => {
  const initial = createInitialState();
  const project = { ...initial.project, id: projectId, generationTasks: tasks, assets };
  const foreign = { ...initial.project, id: 'unrelated-project', generationTasks: [], assets: [] };
  let state: AppState = { ...initial, project, projects: [project, foreign], activeProjectId: projectId };
  let undo: AppState[] = [];
  let redo: AppState[] = [];
  let beforeCommit: (() => void) | undefined;
  const runtimes: Record<string, VideoGenerationRuntime> = {};
  const calls: string[] = [];
  const notices: string[] = [];
  const update = (recordHistory: boolean) => (reduce: (current: AppState) => AppState) => {
    const pending = beforeCommit; beforeCommit = undefined; pending?.();
    const transition = commitStateTransition(state, reduce(state), undo, redo, recordHistory, 50, recordHistory ? undefined : reduce);
    state = transition.current; undo = transition.undo; redo = transition.redo;
  };
  const boundary = (name: string) => async () => { calls.push(name); };
  const ctx = {
    getCurrentState: () => state, setBackgroundState: update(false),
    openVideoDirector: empty, openPromptSource: empty,
    videoController: {
      runtimeById: runtimes, runtimeStore: { getTaskSnapshot: (id: string) => runtimes[id] },
      cancel: boundary('cancel'), start: boundary('start'), startBatch: boundary('startBatch'), resume: boundary('resume'),
      retryDownload: boundary('retryDownload'), recoverResult: boundary('recoverResult'), selectResultVideo: boundary('selectResultVideo'),
    },
  };
  const actions = () => new Function('d', `with(d){${compiled};return {removeTask,renderVideoTask};}`)({
    ...generationTasks, React, Fragment: React.Fragment, Button: 'button', VideoTaskCard: 'article', X: empty, Trash2: empty,
    ctx, state, setState: update(true), busyId: '', runtimeById: { ...runtimes }, taskErrorKnownSecrets: [], taskChapterLabel: () => '',
    applyOwnedProjectUpdate, isUnsubmittedVideoTask, videoTaskHasUnresolvedSubmission, videoTaskBatchStatus,
    inspectVideoTaskDeletion, removeVideoTaskFromListKeepingProvenance, removeVideoTaskKeepingProvenance,
    runningHubRemoteSucceeded, formatUserFacingError, notify: (message: string) => notices.push(message),
  }) as { removeTask: (id: string) => Promise<void>; renderVideoTask: (task: VideoGenerationTask) => React.ReactNode };
  const target = (id: string) => state.project.generationTasks.find((task): task is VideoGenerationTask => task.id === id && generationTasks.isVideoGenerationTask(task));
  const deleteButton = (id: string) => {
    const task = target(id);
    if (!task || !generationTasks.isVisibleGenerationTask(task)) return undefined;
    return descendants(actions().renderVideoTask(task)).find((node) => node.type === 'button' && text(node.props.children).includes('删除任务记录'));
  };
  const click = async (button: Element) => {
    assert.equal(Boolean(button.props.disabled), false);
    button.props.onClick(); await Promise.resolve(); await Promise.resolve();
  };
  return {
    calls, notices, target, deleteButton, click, removeTask: (id: string) => actions().removeTask(id), current: () => state,
    setRuntime: (id: string, runtime: VideoGenerationRuntime) => { runtimes[id] = runtime; },
    onCommit: (callback: () => void) => { beforeCommit = callback; },
    undo: () => { const moved = takeHistoryStep(state, undo, redo); state = moved.current; undo = moved.source; redo = moved.destination; },
    redo: () => { const moved = takeHistoryStep(state, redo, undo); state = moved.current; redo = moved.source; undo = moved.destination; },
    reopen: () => { state = normalizeState(JSON.parse(JSON.stringify(state))); },
  };
};

test('stopped TaskNotFound card exposes deletion and preserves recovery identity through undo and save/load', async () => {
  const original = stoppedTask('standalone');
  const h = fixture([original]);
  const before = h.current();
  assert.equal(videoTaskHasUnresolvedSubmission(original), true);
  const button = h.deleteButton(original.id);
  assert.ok(button, 'the actual stopped single-task card must offer deletion');
  await h.click(button);
  assert.deepEqual(h.target(original.id), { ...original, historyOnly: true }, 'keep remote identity, POST boundary, response, frozen inputs and timestamps');
  assert.equal(h.deleteButton(original.id), undefined);
  assert.deepEqual(h.calls, [], 'local removal does not cancel, query, download or submit work');
  assert.equal(before.project.generationTasks[0], original, 'undo snapshot stays unchanged');
  h.undo();
  assert.deepEqual(h.target(original.id), original);
  assert.ok(h.deleteButton(original.id), 'undo restores the original recovery row');
  h.redo(); h.reopen();
  const reopened = h.target(original.id)!;
  assert.equal(generationTasks.isVisibleGenerationTask(reopened), false);
  assert.equal(reopened.remoteTaskId, original.remoteTaskId);
  assert.equal(reopened.requestFingerprint, original.requestFingerprint);
  assert.equal(reopened.videoJob?.preparation?.phase, 'acknowledged');
  assert.equal(reopened.videoJob?.trackingStopped, true);
  assert.deepEqual(h.calls, []);
});

test('a single-row removal never removes its batch sibling or another project', async () => {
  const chosen = stoppedTask('chosen', { batchId: 'shared-batch' });
  const sibling = stoppedTask('sibling', { batchId: 'shared-batch' });
  const h = fixture([chosen, sibling]);
  const foreign = h.current().projects.find((project) => project.id !== projectId);
  await h.removeTask(chosen.id);
  assert.equal(h.target(chosen.id)?.historyOnly, true);
  assert.equal(h.target(sibling.id), sibling);
  assert.ok(h.deleteButton(sibling.id));
  assert.equal(h.current().projects.find((project) => project.id !== projectId), foreign);
  assert.deepEqual(h.calls, []);
});

test('a stale deletion click rechecks download and cancellation state inside the actual App commit', async () => {
  for (const runtime of [
    { stage: 'downloading' as const },
    { stage: 'stopped' as const, trackingStopped: true, cancellationPending: true },
  ]) {
    const original = stoppedTask(`race-${runtime.stage}-${Boolean(runtime.cancellationPending)}`);
    const h = fixture([original]);
    const before = h.current();
    const button = h.deleteButton(original.id)!;
    assert.ok(button);
    h.onCommit(() => h.setRuntime(original.id, runtime));
    await h.click(button);
    // The shared project updater refreshes project.updatedAt even on a no-op.
    // The deletion contract is that task records and media remain untouched.
    assert.equal(h.current().project.generationTasks, before.project.generationTasks, 'new live work blocks the previously eligible removal');
    assert.equal(h.current().project.assets, before.project.assets);
    assert.equal(h.target(original.id), original);
    assert.equal(h.deleteButton(original.id), undefined);
    assert.deepEqual(h.calls, [], 'the stale delete callback must not initiate cancellation or generation');
  }
});

test('single deletion retains an exact continuation parent and leaves its running child untouched', async () => {
  const parent = stoppedTask('parent', { batchId: 'source-batch' });
  parent.videoJob!.batchContinuation = { version: 1, planId: 'continuation-plan', batchId: 'child-batch', taskId: 'child', revision: 1 };
  const child = stoppedTask('child', { batchId: 'child-batch', status: 'running' });
  child.videoJob = { ...child.videoJob!, stage: 'running', trackingStopped: false, snapshot: {
    ...child.videoJob!.snapshot, continuedFrom: { version: 1, planId: 'continuation-plan', taskId: parent.id,
      batchId: parent.batchId!, requestFingerprint: parent.requestFingerprint! },
  } };
  const h = fixture([parent, child]);
  await h.removeTask(parent.id);
  assert.deepEqual(h.target(parent.id), { ...parent, historyOnly: true });
  assert.equal(h.target(child.id), child);
  assert.deepEqual(h.target(parent.id)?.videoJob?.batchContinuation, parent.videoJob.batchContinuation);
  assert.deepEqual(h.calls, []);
});

test('single deletion of a saved success retains the video file identity and frozen provenance', async () => {
  const successful = stoppedTask('saved', { status: 'succeeded', resultAssetId: 'saved-video', response: { status: 'completed' }, error: undefined });
  successful.videoJob = { ...successful.videoJob!, stage: 'succeeded', trackingStopped: false, remoteGenerationEnded: true, generatedAt: 180 };
  const asset: ReferenceAsset = { id: 'saved-video', name: 'Fixture video', type: 'video', mediaType: 'video', role: 'motion', tags: [],
    createdAt: 180, updatedAt: 180, fileName: 'fixture.mp4', relativePath: 'generated/fixture.mp4', checksum: 'fixture-checksum' };
  const h = fixture([successful], [asset]);
  await h.removeTask(successful.id);
  assert.equal(h.target(successful.id), undefined);
  const kept = h.current().project.assets[0];
  assert.equal(kept.relativePath, asset.relativePath);
  assert.equal(kept.checksum, asset.checksum);
  assert.deepEqual(findVideoAssetSourceTask(h.current().project, kept), snapshotVideoAssetSourceTask(successful));
  assert.deepEqual(h.calls, []);
});

import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  createImageGenerationTask, forceStopImageGenerationTask, forceStopImageTask,
  isGenerationTaskCancelledError, isGenerationTaskRevoked, runImageTask, settleImageGenerationTask,
} from '../src/generationTasks';
import { enqueueImageTask } from '../src/imageTaskQueue';
import { createInitialState, normalizeState, type ManagedMediaResult } from '../src/storage';
import { submitCustomImage, waitForCustomImageTask, type CustomImageGenerationContext } from '../src/customImageGeneration';
import type { AppState, ImageGenerationTask } from '../src/types';
import type { ImageGenerationOptions } from '../src/services/llm';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Force-stop did not release the task')), 3000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
};
const makeTask = (id: string, timestamp = 100): ImageGenerationTask => createImageGenerationTask({
  id, name: id, assetKind: 'character', imageVariant: 'five-view', prompt: 'fixture',
  width: 1024, height: 1024, backend: 'openai', model: 'mock-only',
}, timestamp);

// Revoke synchronously and release FIFO ownership even if the worker ignores abort forever.
{
  const first = makeTask('hung-fifo');
  const started = deferred<void>();
  const late = deferred<string>();
  let signal: AbortSignal | undefined;
  const blocked = enqueueImageTask(() => runImageTask('fifo-project', first, async (currentSignal) => {
    signal = currentSignal;
    started.resolve();
    return late.promise;
  }));
  const stopped = assert.rejects(blocked, isGenerationTaskCancelledError);
  let nextRan = false;
  const next = enqueueImageTask(async () => { nextRan = true; });
  await bounded(started.promise);
  assert.equal(forceStopImageTask('fifo-project', first), true);
  assert.equal(signal?.aborted, true);
  assert.equal(isGenerationTaskRevoked('fifo-project', first), true);
  await bounded(Promise.all([stopped, next]));
  assert.equal(nextRan, true, 'the next member starts while the cancelled provider is still pending');
  late.resolve('too late');
  await setImmediate();
  await assert.rejects(runImageTask('fifo-project', first, async () => 'undo'), isGenerationTaskCancelledError);
  assert.deepEqual(settleImageGenerationTask([], first, { status: 'succeeded', resultAssetId: 'late' }, 200, 'fifo-project'), []);
  assert.deepEqual(settleImageGenerationTask([{ ...first, status: 'queued' }], first, { status: 'succeeded' }, 200, 'fifo-project'), [{ ...first, status: 'queued' }]);
}

// Imported IDs and replacement instances keep their own cancellation signals.
{
  const task = makeTask('shared-id');
  const replacement = makeTask('shared-id', 101);
  const gate = deferred<void>();
  const signals: AbortSignal[] = [];
  const jobs = [['scope-A', task], ['scope-B', task], ['scope-A', replacement]].map(([projectId, member]) =>
    runImageTask(projectId as string, member as ImageGenerationTask, async (signal) => {
      signals.push(signal);
      await gate.promise;
    }));
  const stopped = assert.rejects(jobs[0], isGenerationTaskCancelledError);
  await setImmediate();
  forceStopImageTask('scope-A', task);
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, false, false]);
  await bounded(stopped);
  gate.resolve();
  await bounded(Promise.all(jobs.slice(1)));
  assert.equal(forceStopImageTask('scope-A', { ...task, status: 'succeeded' }), false);
}

// The stop action rebases older queued history, clears unfinished-save flags, and persists.
{
  const task = { ...makeTask('state-stop'), preparationStage: 'prompt-convert' as const,
    customImageSavePending: true, error: 'old error', bindingWarning: 'old warning' };
  const done = { ...makeTask('keep-complete'), status: 'succeeded' as const, resultAssetId: 'existing-asset' };
  for (const status of ['queued', 'running'] as const) {
    const original = { ...task, status };
    const stopped = forceStopImageGenerationTask([original, done], original.id, 250);
    assert.equal(stopped.cancelled, true);
    assert.equal(stopped.tasks[0].status, 'cancelled');
    assert.equal((stopped.tasks[0] as ImageGenerationTask).preparationStage, undefined);
    assert.equal((stopped.tasks[0] as ImageGenerationTask).customImageSavePending, false);
    assert.equal(stopped.tasks[0].error, undefined);
    assert.equal((stopped.tasks[0] as ImageGenerationTask).bindingWarning, undefined);
    assert.strictEqual(stopped.tasks[1], done);
    assert.equal(forceStopImageGenerationTask(stopped.tasks, original.id).blocked, false);
    const state = createInitialState();
    state.project.generationTasks = stopped.tasks;
    state.projects = [state.project];
    assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(state))).project.generationTasks.map((entry) => entry.status), ['cancelled', 'succeeded']);
  }
}

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const sizePreference = { mode: 'custom' as const, aspect: '1:1' as const, width: 768, height: 768, resolutionVersion: 1 as const };

// Exercise actual custom-image workers at all three blocking stages, with providers ignoring abort.
for (const blockedStage of ['convert', 'generate', 'save'] as const) {
  let state: AppState = createInitialState();
  state.project.id = `custom-force-stop-${blockedStage}`;
  state.project.assets = [];
  state.project.generationTasks = [];
  state.projects = [state.project];
  state.activeProjectId = state.project.id;
  state.settings.imageApiProfiles = [];
  state.settings.activeImageApiProfileId = null;
  state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture' };
  state.settings.textApi = { ...state.settings.textApi, enabled: true, baseUrl: 'https://fixture.invalid/v1', model: 'fixture' };
  const projectId = state.project.id;
  const started = deferred<void>();
  const late = deferred<void>();
  let shouldBlock = true;
  let activeSignal: AbortSignal | undefined;
  let imageCalls = 0;
  let stores = 0;
  const block = async (stage: typeof blockedStage, signal?: AbortSignal) => {
    if (stage !== blockedStage || !shouldBlock) return;
    activeSignal = signal;
    shouldBlock = false;
    started.resolve();
    await late.promise;
  };
  const update = (updater: (current: AppState) => AppState) => { state = updater(state); };
  const ctx: CustomImageGenerationContext = {
    getState: () => state, update, updateBackground: update, loader: {}, notify: () => undefined,
    convertPrompt: async (_api, input) => { await block('convert', input.signal); return '最终静帧提示词'; },
    generateImage: async (_api, input, onStart) => {
      await onStart?.();
      imageCalls += 1;
      await block('generate', (input as ImageGenerationOptions).signal);
      return { dataUrl: png };
    },
    storeImage: async (): Promise<ManagedMediaResult> => {
      stores += 1;
      await block('save');
      return { managed: true, missing: false, relativePath: `images/${stores}.png`, checksum: 'a'.repeat(64),
        url: `lianhua-asset://fixture/images/${stores}.png`, fileName: 'fixture.png', mediaType: 'image', mimeType: 'image/png', sizeBytes: 1 };
    },
  };
  const rule = state.imagePromptRules.ruleSets.find((entry) => entry.enabled && entry.format === 'natural-language')!;
  const id = await submitCustomImage(ctx, { userPrompt: '卡住的任务', sizePreference,
    ...(blockedStage === 'convert' ? { promptMode: 'rules' as const, ruleSetId: rule.id } : {}) });
  assert.ok(id);
  await bounded(started.promise);
  const task = state.project.generationTasks.find((entry) => entry.id === id)! as ImageGenerationTask;
  assert.equal(task.status, 'running');
  forceStopImageTask(projectId, task);
  state.project = { ...state.project, generationTasks: forceStopImageGenerationTask(state.project.generationTasks, id).tasks };
  state.projects = [state.project];
  if (blockedStage !== 'save') assert.equal(activeSignal?.aborted, true);
  await bounded(waitForCustomImageTask(id));
  const nextId = await submitCustomImage(ctx, { userPrompt: '继续下一张', sizePreference });
  assert.ok(nextId);
  await bounded(waitForCustomImageTask(nextId));
  assert.equal(state.project.generationTasks.find((entry) => entry.id === nextId)?.status, 'succeeded');
  assert.equal(state.project.assets.length, 1);
  const completedAssetId = state.project.assets[0].id;
  // An undo snapshot cannot re-authorize the stopped worker's late response.
  state.project = { ...state.project, generationTasks: state.project.generationTasks.map((entry) => entry.id === id ? task : entry) };
  state.projects = [state.project];
  late.resolve();
  await setImmediate();
  await setImmediate();
  assert.deepEqual(state.project.assets.map((asset) => asset.id), [completedAssetId], `${blockedStage}: no late result is stored or bound`);
  assert.equal(imageCalls, blockedStage === 'convert' ? 1 : 2, 'force-stop never resubmits a model request');
  assert.equal(stores, blockedStage === 'save' ? 2 : 1, 'late conversion/generation cannot start local saving');
}

console.log('Image force-stop runtime: hung FIFO release, abort signals, project/instance isolation, queued history rebasing, persistence, custom conversion/generation/saving and late-result isolation passed.');

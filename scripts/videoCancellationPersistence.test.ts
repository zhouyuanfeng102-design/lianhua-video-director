import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInitialState, isCoalescedAutoSaveCancellation, saveStateAsync, withStateRestore } from '../src/storage';
import { handleStateSerializationRequest, type StateSerializationRequest } from '../src/stateSerialization';
import type { StateSerializationWorkerPort } from '../src/stateSerializationClient';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { isVideoGenerationTask } from '../src/generationTasks';
import type { AppState, VideoGenerationTask } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

// Exercise the actual engine and storage scheduler, with tiny synthetic data.
// No user data, real video provider, or Electron profile is touched.
class DelayedWorker implements StateSerializationWorkerPort {
  static current: DelayedWorker;
  requests: StateSerializationRequest[] = [];
  replied = 0;
  onmessage: StateSerializationWorkerPort['onmessage'] = null;
  onerror: StateSerializationWorkerPort['onerror'] = null;
  onmessageerror: StateSerializationWorkerPort['onmessageerror'] = null;
  constructor() { DelayedWorker.current = this; }
  postMessage(request: StateSerializationRequest) { this.requests.push(structuredClone(request)); }
  terminate() {}
  completeNext(error?: string) {
    const request = this.requests[this.replied++];
    assert.ok(request, 'the encoder must have received a snapshot before completion');
    this.onmessage?.({ data: error ? { id: request.id, ok: false, error } : handleStateSerializationRequest(request) });
  }
}
const tick = async () => { for (let index = 0; index < 60; index += 1) await Promise.resolve(); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const fixture = (name: string) => {
  const state = createInitialState(); state.project.name = name; state.projects = [state.project]; return state;
};
const draft: VideoGenerationDraft = { name: 'Synthetic video', prompt: 'Synthetic prompt', backend: 'api', references: [], parameters: {} };
const api = { enabled: true, endpoint: 'https://example.invalid/generate', statusEndpointTemplate: 'https://example.invalid/tasks/{id}', apiKey: 'synthetic-key', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'output.url', provider: 'generic' as const, model: 'synthetic-model' };
const originalWorker = globalThis.Worker;
const originalWindow = globalThis.window;
const writes: AppState[] = [];
let beforeWrite: (state: AppState) => Promise<void> = async () => {};
Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: DelayedWorker });
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  localStorage: { setItem() {} }, lianhuaDesktop: { saveState: async (raw: string) => {
    const state = JSON.parse(raw) as AppState;
    writes.push(state); await beforeWrite(state);
    return { ok: true, checksum: state.project.name };
  } },
} });

try {
  for (const taskCount of [1, 6]) {
    let state = fixture(`cancel-${taskCount}`);
    const tasks = Array.from({ length: taskCount }, (_, index): VideoGenerationTask => ({
      id: `task-${index}`, kind: 'video', storyboardId: '', targetId: 'synthetic-api',
      status: 'running', remoteTaskId: `remote-${index}`, createdAt: 1, updatedAt: 1, requestBody: {},
      videoJob: { stage: 'running', snapshot: { projectId: state.project.id, clientId: `client-${index}`, images: [],
        draft, connection: { backend: 'api', api },
      } },
    }));
    state.project.generationTasks = tasks;
    let checkpoints = 0;
    const startPosts = DelayedWorker.current?.requests.length || 0;
    const initialAuto = saveStateAsync(state, { coalesce: true });
    const engine = new VideoGenerationEngine({
      getState: () => state, setState: (updater) => { state = updater(state); }, onRuntime: () => {},
      persistState: async () => { await saveStateAsync(state, { coalesce: 'checkpoint' }); },
      desktop: { saveVideoTaskCheckpoint: async () => { checkpoints += 1; return { persisted: true }; } } as unknown as VideoGenerationDesktop,
    });
    let completedCancels = 0;
    const cancels = tasks.map((task) => engine.cancel(task.id).then(() => { completedCancels += 1; }));
    await tick();
    const worker = DelayedWorker.current;
    assert.equal(worker.requests.length - startPosts, 1, 'cancelling does not clone another entire library while autosave is encoding');
    assert.equal(checkpoints, taskCount, 'each task still has an independent durable cancellation journal');
    assert.equal(completedCancels, 0);
    worker.completeNext(); await initialAuto; await tick();
    assert.equal(worker.requests.length - startPosts, 2, 'all pending runtime snapshots merge into one latest state');
    assert.equal(worker.requests.at(-1)!.state.project.generationTasks.filter(isVideoGenerationTask).filter((task) => task.videoJob?.trackingStopped).length, taskCount);
    const diskGate = deferred(); beforeWrite = async () => diskGate.promise;
    worker.completeNext(); await tick();
    assert.equal(completedCancels, 0, 'encoding is not a durability acknowledgement');
    diskGate.resolve(); await Promise.all(cancels); beforeWrite = async () => {};
    assert.equal(writes.at(-1)!.project.generationTasks.filter(isVideoGenerationTask).filter((task) => task.videoJob?.trackingStopped).length, taskCount);
    engine.dispose();
  }

  // An encoder rejection fails its barrier and releases the next latest state;
  // it must not leave the shared autosave/runtime channel permanently occupied.
  {
    const broken = saveStateAsync(fixture('broken-encoder'), { coalesce: 'checkpoint' });
    const rejected = assert.rejects(broken, /synthetic encoder failure/u);
    const next = saveStateAsync(fixture('after-encoder-failure'), { coalesce: 'checkpoint' });
    const worker = DelayedWorker.current;
    const posted = worker.requests.length;
    worker.completeNext('synthetic encoder failure'); await rejected; await tick();
    assert.equal(worker.requests.length, posted + 1);
    worker.completeNext(); await next;
    assert.equal(writes.at(-1)!.project.name, 'after-encoder-failure');
  }

  // Explicit saves retain immediate snapshots. A pending video barrier waits
  // for the replacing explicit write; ordinary autosave remains superseded.
  for (const fail of [false, true]) {
    const first = saveStateAsync(fixture('active-auto'), { coalesce: true });
    const pendingAuto = saveStateAsync(fixture('old-pending-auto'), { coalesce: true });
    let barrierSettled = false;
    const barrier = saveStateAsync(fixture('pending-checkpoint'), { coalesce: 'checkpoint' });
    void barrier.then(() => { barrierSettled = true; }, () => { barrierSettled = true; });
    const replacementState = fixture('explicit-replacement');
    const diskGate = deferred();
    beforeWrite = async (state) => {
      if (state.project.name !== 'explicit-replacement') return;
      await diskGate.promise;
      if (fail) throw new Error('synthetic disk failure');
    };
    const replacement = saveStateAsync(replacementState);
    const replacementOutcome = replacement.then(() => 'saved', () => 'failed');
    const barrierOutcome = barrier.then(() => 'saved', () => 'failed');
    replacementState.project.name = 'mutation-after-call';
    await assert.rejects(pendingAuto, isCoalescedAutoSaveCancellation);
    const worker = DelayedWorker.current;
    assert.equal(worker.requests.at(-1)!.state.project.name, 'explicit-replacement', 'explicit call-time freeze remains intact');
    worker.completeNext(); await first; worker.completeNext(); await tick();
    assert.equal(barrierSettled, false, 'superseding a checkpoint does not resolve it before the actual write');
    diskGate.resolve();
    assert.equal(await barrierOutcome, fail ? 'failed' : 'saved');
    assert.equal(await replacementOutcome, fail ? 'failed' : 'saved');
    beforeWrite = async () => {};
  }

  // A runtime request arriving while an explicit write owns the large snapshot
  // is held without posting another graph. A failed explicit save also releases it.
  for (const fail of [false, true]) {
    const diskGate = deferred();
    beforeWrite = async (state) => {
      if (state.project.name !== 'explicit-owner') return;
      await diskGate.promise;
      if (fail) throw new Error('owner failed');
    };
    const owner = saveStateAsync(fixture('explicit-owner'));
    const ownerOutcome = owner.then(() => {}, () => {});
    const worker = DelayedWorker.current;
    const posted = worker.requests.length;
    const runtime = saveStateAsync(fixture('runtime-after-owner'), { coalesce: 'checkpoint' });
    const latest = saveStateAsync(fixture('newest-runtime-state'), { coalesce: true });
    worker.completeNext(); await tick();
    assert.equal(worker.requests.length, posted, 'coalesced encoder waits through explicit IPC/write acknowledgement');
    diskGate.resolve(); await ownerOutcome; await tick();
    assert.equal(worker.requests.length, posted + 1);
    assert.equal(worker.requests.at(-1)!.state.project.name, 'newest-runtime-state');
    worker.completeNext(); await Promise.all([runtime, latest]); beforeWrite = async () => {};
  }

  // Preserve restore ordering: old pending runtime waiters share the final old
  // write, and no old coalesced snapshot survives to overwrite restored state.
  {
    const first = saveStateAsync(fixture('old-auto'), { coalesce: true });
    const checkpoint = saveStateAsync(fixture('old-checkpoint'), { coalesce: 'checkpoint' });
    const restoreGate = deferred(); let restored = false;
    const restore = withStateRestore(fixture('final-old-state'), async () => { await restoreGate.promise; return fixture('restored-state'); }, () => { restored = true; });
    const worker = DelayedWorker.current;
    const posted = worker.requests.length;
    worker.completeNext(); await first; worker.completeNext(); await checkpoint;
    assert.equal(restored, false);
    await assert.rejects(saveStateAsync(fixture('during-restore'), { coalesce: 'checkpoint' }), /正在恢复/u);
    assert.equal(worker.requests.length, posted, 'restore lock rejects runtime snapshots before worker cloning');
    restoreGate.resolve(); await restore;
    const newest = saveStateAsync(fixture('restored-state'), { coalesce: true });
    worker.completeNext(); await newest;
    assert.equal(writes.at(-1)!.project.name, 'restored-state');
  }

  // Real generation initiation cannot POST while a merged preflight save is
  // pending or if its superseding write fails. No native video checkpoint is
  // supplied here, covering the controller's main-state-only fallback too.
  for (const fail of [false, true]) {
    let state = fixture('before-post'); state.settings.videoTaskApi = api;
    let posts = 0;
    let persistenceCalls = 0;
    const first = saveStateAsync(state, { coalesce: true });
    const engine = new VideoGenerationEngine({
      getState: () => state, setState: (updater) => { state = updater(state); }, onRuntime: () => {},
      persistState: async () => { persistenceCalls += 1; await saveStateAsync(state, { coalesce: 'checkpoint' }); },
      desktop: {
        setVideoTaskCredential: async () => ({ persisted: true }),
        videoRequest: async (request: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => { if (request.method === 'POST') posts += 1; return { status: 200, body: JSON.stringify({ id: 'synthetic-remote', status: 'queued' }) }; },
      } as unknown as VideoGenerationDesktop,
      pollIntervalMs: 60_000,
    });
    let startSettled = false;
    const start = engine.start(draft).then(() => { startSettled = true; }, () => { startSettled = true; });
    for (let index = 0; index < 40 && !persistenceCalls; index += 1) {
      await tick(); await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(persistenceCalls, 'generation must reach its real preflight save');
    assert.equal(posts, 0);
    const worker = DelayedWorker.current;
    const diskGate = deferred();
    beforeWrite = async (saved) => {
      if (!saved.project.generationTasks.length) return;
      await diskGate.promise;
      if (fail) throw new Error('preflight disk failed');
    };
    const replacement = saveStateAsync(state);
    const replacementOutcome = replacement.then(() => {}, () => {});
    worker.completeNext(); await first; worker.completeNext(); await tick();
    assert.equal(posts, 0, 'a paid POST must await replacement disk acknowledgement');
    diskGate.resolve(); await replacementOutcome; await tick();
    beforeWrite = async () => {};
    for (let index = 0; index < 40 && !startSettled; index += 1) {
      if (worker.replied < worker.requests.length) worker.completeNext();
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(startSettled, JSON.stringify({ fail, posts, posted: worker.requests.length, replied: worker.replied, stages: state.project.generationTasks.filter(isVideoGenerationTask).map((task) => ({ status: task.status, stage: task.videoJob?.stage, error: task.error })) }));
    await start;
    assert.equal(posts, fail ? 0 : 1);
    engine.dispose();
  }

  const source = readFileSync(new URL('../src/useVideoGenerationController.ts', import.meta.url), 'utf8');
  assert.match(source, /saveStateAsync\([^;]+coalesce:\s*'checkpoint'/u, 'the production controller must use the bounded durability path');
} finally {
  beforeWrite = async () => {};
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: originalWorker });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log('Video cancellation persistence passed: one shared encoder for 1/6 concurrent cancellations, latest state merge, disk barriers, explicit supersession success/failure, explicit backpressure, restore ordering, and real pre-POST success/failure fallback.');

import assert from 'node:assert/strict';
import { COMFY_MISSING_TASK_POLICY, ComfyMissingTaskTracker, ComfyQueuePresenceCache, type ComfyQueuePresence } from '../src/comfyPolling';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { createInitialState } from '../src/storage';
import type { AppState, VideoGenerationTask } from '../src/types';
import type { ComfyVideoWorkflowPreset, VideoGenerationDesktop, VideoGenerationRuntime } from '../src/videoGenerationTypes';

type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
type Event = Parameters<Parameters<VideoGenerationDesktop['onVideoProgress']>[0]>[0];
type InternalEngine = {
  poll(taskId: string): Promise<void>;
  watch(task: VideoGenerationTask): Promise<void>;
  rememberKey(task: VideoGenerationTask, apiKey: string): Promise<unknown>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
};
const response = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
const emptyQueue = () => ({ queue_pending: [], queue_running: [] });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('isolated engine fixture did not reach expected state');
};
const workflow: ComfyVideoWorkflowPreset = {
  id: 'performance-workflow', name: '隔离性能工作流', createdAt: 1, updatedAt: 1,
  workflowJson: JSON.stringify({
    '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'mock prompt' }, _meta: { title: '文本节点' } },
    '2': { class_type: 'SamplerCustom', inputs: { positive: ['1', 0] }, _meta: { title: '采样器' } },
    '9': { class_type: 'VHS_VideoCombine', inputs: { images: ['2', 0] } },
  }),
  mapping: { prompt: [{ nodeId: '1', inputName: 'value' }], images: [], outputNodeId: '9' },
};

function fixture(count = 1, request?: (payload: Request) => Promise<ReturnType<typeof response>>) {
  let state = createInitialState();
  const tasks: VideoGenerationTask[] = Array.from({ length: count }, (_, index) => ({
    id: `local-${index}`, kind: 'video', storyboardId: '', targetId: workflow.name,
    status: 'submitted', remoteTaskId: `remote-${index}`, requestBody: {},
    createdAt: Date.now() - 60 * 60_000, updatedAt: Date.now() - 60 * 60_000,
    videoJob: {
      stage: 'queued', submittedAt: Date.now() - 60 * 60_000,
      preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] },
      snapshot: {
        projectId: state.project.id, clientId: `client-${index}`,
        draft: { name: `性能样本 ${index}`, prompt: `isolated prompt ${index}`, backend: 'comfyui', references: [], parameters: {}, workflowId: workflow.id },
        images: [], connection: { backend: 'comfyui', comfyui: { enabled: true, baseUrl: 'http://performance.invalid:8188' }, workflow },
      },
    },
  }));
  state.project.generationTasks = tasks;
  state.projects = [state.project];
  let stateWrites = 0, persistenceWrites = 0;
  const requests: Request[] = [];
  const runtimes: Array<{ taskId: string; runtime: VideoGenerationRuntime }> = [];
  const watches: Array<{ watchId: string; url: string }> = [], unwatches: string[] = [];
  const checkpoints: VideoGenerationTask[] = [];
  let listener: ((event: Event) => void) | undefined;
  const desktop = {
    videoRequest: async (payload: Request) => {
      requests.push(payload);
      assert.equal(payload.method, 'GET', 'performance/recovery checks never submit or cancel a remote task');
      return request ? request(payload) : response(payload.url.endsWith('/queue') ? emptyQueue() : {});
    },
    onVideoProgress: (callback: (event: Event) => void) => { listener = callback; return () => { listener = undefined; }; },
    watchVideoProgress: async (payload: { watchId: string; url: string }) => { watches.push(payload); },
    unwatchVideoProgress: async (watchId: string) => { unwatches.push(watchId); return true; },
    getVideoTaskCredential: async () => '',
    setVideoTaskCredential: async () => ({ persisted: true }),
    saveVideoTaskCheckpoint: async (task: VideoGenerationTask) => { checkpoints.push(structuredClone(task)); return { persisted: true }; },
  } as unknown as VideoGenerationDesktop;
  const options = {
    getState: () => state,
    setState: (updater: (current: AppState) => AppState) => {
      const next = updater(state);
      if (next !== state) stateWrites += 1;
      state = next;
    },
    onRuntime: (taskId: string, runtime: VideoGenerationRuntime) => { runtimes.push({ taskId, runtime }); },
    persistState: async () => { persistenceWrites += 1; }, desktop, pollIntervalMs: 60_000,
  };
  const engine = new VideoGenerationEngine(options);
  const internal = engine as unknown as InternalEngine;
  return {
    engine, internal, options, tasks, requests, watches, unwatches, checkpoints, runtimes,
    get stateWrites() { return stateWrites; }, get persistenceWrites() { return persistenceWrites; },
    task: (index = 0) => state.project.generationTasks[index] as VideoGenerationTask,
    replaceTask: (task: VideoGenerationTask) => {
      const project = { ...state.project, generationTasks: state.project.generationTasks.map((entry) => entry.id === task.id ? task : entry) };
      state = { ...state, project, projects: [project] };
    },
    clearTimers: () => { internal.timers.forEach(clearTimeout); internal.timers.clear(); },
    event: (data: unknown, watchIndex = 0) => listener?.({ type: 'message', watchId: watches[watchIndex].watchId, data }),
  };
}

const originalNow = Date.now;
let now = 1_900_000_000_000;
Date.now = () => now;
try {
  // Cached queue bodies are reduced to IDs. Both pending reads and one-second
  // completed reads are shared, but other credentials/base paths never mix.
  {
    const cache = new ComfyQueuePresenceCache();
    const gate = deferred<unknown>();
    let reads = 0;
    const read = () => { reads += 1; return gate.promise; };
    const first = cache.get('http://queue.invalid/base/queue', { Authorization: 'Bearer scope-a' }, read);
    const second = cache.get('http://queue.invalid/base/queue', { authorization: 'Bearer scope-a' }, read);
    await Promise.resolve();
    assert.equal(reads, 1, 'inflight queue requests are merged');
    gate.resolve({ queue_pending: [[1, 'remote-a', { huge_workflow: 'x'.repeat(100_000) }, { client_id: 'client-a' }]], queue_running: [] });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    assert.ok(a.pendingIds.has('remote-a'));
    assert.equal(a.taskIdByClient.get('client-a'), 'remote-a');
    assert.equal(JSON.stringify(a).includes('huge_workflow'), false);
    assert.equal(await cache.get('http://queue.invalid/base/queue', { Authorization: 'Bearer scope-a' }, read), a);
    const differentKey = await cache.get('http://queue.invalid/base/queue', { Authorization: 'Bearer scope-b' }, async () => emptyQueue());
    const differentPath = await cache.get('http://queue.invalid/other/queue', { Authorization: 'Bearer scope-a' }, async () => emptyQueue());
    assert.notEqual(differentKey.observationId, a.observationId);
    assert.notEqual(differentPath.observationId, a.observationId);
    now += 1001;
    assert.notEqual(await cache.get('http://queue.invalid/base/queue', { Authorization: 'Bearer scope-a' }, read), a);
    assert.equal(reads, 2);
    await assert.rejects(cache.get('http://error.invalid/queue', {}, async () => { throw new Error('network interrupted'); }));
    assert.ok((await cache.get('http://error.invalid/queue', {}, async () => emptyQueue())).valid, 'failed reads are not cached');
    assert.equal((await cache.get('http://malformed.invalid/queue', {}, async () => ({ error: 'backend not ready' }))).valid, false);
    cache.clear();
  }

  // Missing policy needs six fresh observations AND the full two-minute
  // interval. A repeated cached result, a fresh submission, or a new identity
  // cannot inherit enough evidence to pause.
  {
    const tracker = new ComfyMissingTaskTracker();
    const presence = (observationId: number): ComfyQueuePresence => ({ observationId, observedAt: now, valid: true, pendingIds: new Set(), runningIds: new Set(), taskIdByClient: new Map() });
    const old = now - COMFY_MISSING_TASK_POLICY.minimumTaskAgeMs;
    assert.equal(tracker.observe('fresh', now, presence(1)), false);
    assert.equal(tracker.observe('old', old, presence(1)), false);
    now += 120_000;
    for (let index = 0; index < 20; index += 1) assert.equal(tracker.observe('old', old, presence(1)), false);
    for (let index = 2; index < 6; index += 1) assert.equal(tracker.observe('old', old, presence(index)), false);
    assert.equal(tracker.observe('old', old, presence(6)), true);
    assert.equal(tracker.observe('old', old, presence(7), now, 'replaced-remote-id'), false);
    tracker.clear();
  }

  // Six old tasks still perform their own exact-ID history checks, while one
  // queue body/JSON parse/identity scan serves the same endpoint+credential.
  {
    const gate = deferred<void>();
    const test = fixture(6, async (request) => {
      if (request.url.endsWith('/queue')) { await gate.promise; return response(emptyQueue()); }
      return response({});
    });
    const polls = Promise.all(test.tasks.map((task) => test.internal.poll(task.id)));
    await waitFor(() => test.requests.filter((request) => request.url.includes('/history/')).length === 6);
    gate.resolve();
    await polls;
    assert.equal(test.requests.filter((request) => request.url.endsWith('/queue')).length, 1);
    assert.equal(new Set(test.requests.filter((request) => request.url.includes('/history/')).map((request) => request.url)).size, 6);
    test.engine.dispose();
  }

  // Same endpoint but another key and another base URL are isolated in the
  // actual engine, not merely in a cache unit test.
  {
    const test = fixture(3, async (request) => response(request.url.endsWith('/queue')
      ? { queue_running: [], queue_pending: [[1, request.headers?.Authorization === 'Bearer second' ? 'remote-1' : request.url.startsWith('http://different') ? 'remote-2' : 'remote-0']] }
      : {}));
    const third = test.task(2);
    test.replaceTask({ ...third, videoJob: { ...third.videoJob!, snapshot: { ...third.videoJob!.snapshot, connection: { ...third.videoJob!.snapshot.connection, comfyui: { enabled: true, baseUrl: 'http://different.invalid' } } } } });
    await test.internal.rememberKey(test.task(0), 'first');
    await test.internal.rememberKey(test.task(1), 'second');
    await test.internal.rememberKey(test.task(2), 'first');
    await Promise.all([0, 1, 2].map((index) => test.internal.poll(test.task(index).id)));
    assert.equal(test.requests.filter((request) => request.url.endsWith('/queue')).length, 3);
    for (const index of [0, 1, 2]) assert.equal(test.task(index).videoJob?.stage, 'queued');
    test.engine.dispose();
  }

  // Progress bursts no longer repeatedly parse workflows or broadcast unchanged
  // values, and neither callbacks nor their runtime values contain snapshots.
  {
    const test = fixture();
    await test.internal.watch(test.task());
    const originalParse = JSON.parse;
    let workflowParses = 0;
    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (text === workflow.workflowJson) workflowParses += 1;
      return originalParse(text, reviver);
    }) as typeof JSON.parse;
    try {
      for (let index = 0; index < 1000; index += 1) {
        test.event({ type: 'status', data: { status: { exec_info: { queue_remaining: 3 } } } });
        test.event({ type: 'executing', data: { prompt_id: 'foreign-task', node: '2' } });
        test.event({ type: 'executed', data: { prompt_id: 'foreign-task', node: '2' } });
      }
      assert.equal(workflowParses, 0, 'unrelated events never parse the frozen workflow');
      assert.equal(test.internal.timers.size, 0, 'foreign completion cannot trigger another history poll');
      assert.equal(test.runtimes.length, 0);
      test.event({ type: 'executing', data: { prompt_id: 'remote-0', node: '2' } });
      const afterFirst = test.runtimes.length, afterFirstState = test.stateWrites;
      for (let index = 0; index < 1000; index += 1) {
        now += 16_000;
        test.event({ type: 'executing', data: { prompt_id: 'remote-0', node: '2' } });
      }
      assert.equal(workflowParses, 1);
      assert.equal(test.runtimes.length, afterFirst);
      assert.equal(test.stateWrites, afterFirstState, 'elapsed checkpoint interval alone never writes the same progress');
      test.event({ type: 'progress', data: { prompt_id: 'remote-0', value: 1, max: 30 } });
      const progressEvents = test.runtimes.length, progressStateWrites = test.stateWrites;
      for (let index = 0; index < 1000; index += 1) {
        now += 16_000;
        test.event({ type: 'progress', data: { prompt_id: 'remote-0', value: 1, max: 30 } });
      }
      assert.equal(test.runtimes.length, progressEvents);
      assert.equal(test.stateWrites, progressStateWrites);
      for (let value = 2; value <= 30; value += 1) {
        now += 16_000;
        test.event({ type: 'progress', data: { prompt_id: 'remote-0', value, max: 30 } });
      }
      assert.equal(test.stateWrites, progressStateWrites, 'even changing cosmetic progress must not periodically serialize a large project library');
      assert.equal(test.runtimes.at(-1)?.runtime.step, 30, 'progress stays live through the task store');
      test.event({ type: 'progress', data: { value: 2, max: 30 } });
      assert.equal(test.runtimes.at(-1)?.runtime.step, 2, 'legacy prompt-less progress is allowed only on the owned unique-client lease');
      for (const { runtime } of test.runtimes) assert.equal('snapshot' in runtime || 'preparation' in runtime, false);
      test.event({ type: 'execution_error', data: { prompt_id: 'remote-0', exception_message: 'isolated node failure' } });
      assert.equal(test.task().status, 'failed', 'critical terminal stages still persist immediately');
    } finally { JSON.parse = originalParse; test.engine.dispose(); }
  }

  // A known remote ID missing from both authoritative sources pauses exactly
  // once; restart stays paused and explicit resume only queries the original ID.
  {
    let queued = false;
    const test = fixture(1, async (request) => response(request.url.endsWith('/queue')
      ? { queue_running: [], queue_pending: queued ? [[1, 'remote-0']] : [] } : {}));
    await test.internal.watch(test.task());
    const originalSnapshot = structuredClone(test.task().videoJob!.snapshot);
    for (let index = 0; index < 6; index += 1) {
      await test.internal.poll(test.task().id);
      if (index < 5) assert.notEqual(test.task().videoJob?.trackingStopped, true);
      now += 25_000;
    }
    assert.equal(test.task().status, 'unknown');
    assert.equal(test.task().videoJob?.stage, 'stopped');
    assert.equal(test.task().videoJob?.trackingStopped, true);
    assert.equal(test.task().videoJob?.cancellationConfirmed, undefined);
    assert.equal(test.task().remoteTaskId, 'remote-0');
    assert.deepEqual(test.task().videoJob!.snapshot, originalSnapshot);
    assert.equal(test.checkpoints.length, 1);
    assert.equal(test.persistenceWrites, 1);
    assert.equal(test.unwatches.length, 1);
    const writes = test.stateWrites, reads = test.requests.length;
    test.engine.reconcile();
    await test.internal.poll(test.task().id);
    assert.equal(test.requests.length, reads);
    assert.equal(test.stateWrites, writes);
    const restarted = new VideoGenerationEngine(test.options);
    restarted.reconcile();
    assert.equal((restarted as unknown as InternalEngine).timers.size, 0, 'restart does not revive a paused ghost task');
    restarted.dispose();
    queued = true;
    await test.engine.resume(test.task().id);
    test.clearTimers();
    await test.internal.poll(test.task().id);
    assert.equal(test.task().videoJob?.trackingStopped, false);
    assert.equal(test.task().videoJob?.stage, 'queued');
    assert.equal(test.task().remoteTaskId, 'remote-0');
    assert.equal(test.requests.some((request) => request.method === 'POST'), false);
    test.engine.dispose();
  }

  // A slow acknowledgement/queue visibility race for a newly submitted task
  // gets the full 30-minute grace period, even with successful empty polls.
  {
    let queued = false;
    const test = fixture(1, async (request) => response(request.url.endsWith('/queue')
      ? { queue_pending: queued ? [[1, 'remote-0']] : [], queue_running: [] } : {}));
    const task = test.task();
    test.replaceTask({ ...task, videoJob: { ...task.videoJob!, submittedAt: now } });
    for (let index = 0; index < 9; index += 1) { await test.internal.poll(task.id); now += 30_000; }
    assert.notEqual(test.task().videoJob?.trackingStopped, true);
    queued = true;
    await test.internal.poll(task.id);
    assert.equal(test.task().videoJob?.stage, 'queued');
    test.engine.dispose();
  }

  // Every reliable presence signal and every unsuccessful/invalid check resets
  // the missing evidence. An ongoing WS workload can never be paused as a ghost.
  for (const interruption of ['network', 'malformed', 'history', 'queue', 'websocket'] as const) {
    let mode: typeof interruption | 'missing' = 'missing';
    const test = fixture(1, async (request) => {
      if (mode === 'network') throw new Error('isolated temporary network failure');
      if (request.url.endsWith('/queue')) return response(mode === 'malformed' ? { error: 'not a queue response' }
        : mode === 'queue' ? { queue_running: [[1, 'remote-0']], queue_pending: [] } : emptyQueue());
      return response(mode === 'history' ? { 'remote-0': { status: { completed: false } } } : {});
    });
    await test.internal.watch(test.task());
    for (let index = 0; index < 5; index += 1) { await test.internal.poll(test.task().id); now += 25_000; }
    mode = interruption;
    if (interruption === 'websocket') test.event({ type: 'progress', data: { prompt_id: 'remote-0', value: 12, max: 30 } });
    else await test.internal.poll(test.task().id);
    mode = 'missing';
    now += 1500;
    for (let index = 0; index < 4; index += 1) { await test.internal.poll(test.task().id); now += 25_000; }
    assert.notEqual(test.task().videoJob?.trackingStopped, true, `${interruption} resets the uninterrupted missing window`);
    test.engine.dispose();
  }
} finally { Date.now = originalNow; }

console.log('ComfyUI performance regression passed: shared scoped queue reads; one workflow parse; unchanged progress is a no-op; conservative missing-task pause; safe grace/resume/network/WS behavior; no real API or data writes');

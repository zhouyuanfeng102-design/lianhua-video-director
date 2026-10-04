import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { isUnsubmittedVideoTask, resolveVideoExecutionLimit, videoTaskHasUnresolvedSubmission, videoTaskOccupiesGenerationSlot } from '../src/videoGenerationQueue';
import { removeVideoTaskKeepingProvenance } from '../src/videoProvenance';
import type { AppState, Project, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoBatchStartInput, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { VideoTailFrameSelectionResult } from '../src/videoFrameSelection';

// All endpoints, media, credentials and journals below are memory-only fixtures.
// No real project is read, no generation service is contacted and no files are written.
type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let index = 0; index < 15; index += 1) await tick(); };
const waitFor = async (predicate: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 600; attempt += 1) { if (predicate()) return; await tick(); }
  assert.fail(label);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
const config: VideoTaskApiConfig = {
  enabled: true, endpoint: 'https://serial-fixture.example.test/generate',
  statusEndpointTemplate: 'https://serial-fixture.example.test/tasks/{id}',
  apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', provider: 'generic', model: 'serial-fixture',
};
const draft = (name: string, index = 1): VideoGenerationDraft => ({
  name, prompt: `frozen prompt ${name}`, backend: 'api', references: [], parameters: { seed: index },
  source: { storyboardId: `board-${name}`, sequencePlanId: `plan-${name}`, segmentId: `segment-${name}`,
    segmentIndex: index, language: 'zh', label: name },
});
const frame = (index: number) => ({
  fileName: `selected-${index}.png`, relativePath: `image/selected-${index}.png`, checksum: `selected-${index}`,
  sizeBytes: 8, mediaType: 'image' as const, mimeType: 'image/png', managed: true, missing: false,
  url: `lianhua-asset://local/image/selected-${index}.png`, timeSec: 8.5, frameIndex: 85,
  width: 640, height: 360, role: 'custom-frame' as const,
});
const selectedFrame = (index: number): VideoTailFrameSelectionResult => ({
  frame: frame(index),
  selection: { source: 'ai', selectedId: `candidate-${index}`, reason: '沿用准确前驱成片的衔接状态。',
    selectedTimeSec: 8.5, lastFrameTimeSec: 9.9, offsetFromEndSec: 1.4, candidateCount: 1 },
  candidates: [{ id: `candidate-${index}`, timeSec: 8.5, isLastFrame: false, frame: frame(index) }],
});

type RemoteState = 'running' | 'succeeded' | 'failed';
const fixture = () => {
  const holder = { state: createInitialState() };
  holder.state.settings.videoTaskApi = { ...config };
  Object.assign(holder.state.settings, { videoExecutionMode: 'queue', videoExecutionConcurrency: 1 });
  const requests: Request[] = [];
  const journals = new Map<string, VideoGenerationTask>();
  const remoteStates = new Map<string, RemoteState>();
  const selectedSources: Array<{ assetId?: string; relativePath: string; expectedChecksum?: string }> = [];
  let postBehavior: ((index: number, request: Request) => Promise<ReturnType<typeof response>>) | undefined;
  let journalRead: ((taskId: string) => Promise<VideoGenerationTask | null>) | undefined;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      requests.push(request);
      if (request.method === 'POST' && request.url === config.endpoint) {
        const index = requests.filter((entry) => entry.method === 'POST' && entry.url === config.endpoint).length;
        if (postBehavior) return postBehavior(index, request);
        remoteStates.set(`remote-${index}`, 'running');
        return response({ id: `remote-${index}`, status: 'running' });
      }
      assert.match(request.url, /^https:\/\/serial-fixture\.example\.test\/tasks\//u, 'fixture must not silently allow a second submission/cancel endpoint');
      const id = decodeURIComponent(request.url.split('/').at(-1)!);
      const status = remoteStates.get(id) || 'running';
      return response({ id, status, ...(status === 'succeeded' ? { url: `https://cdn.example.test/${id}.mp4` }
        : status === 'failed' ? { message: 'fixture provider terminal failure' } : {}) });
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true,
    onVideoProgress: () => () => {}, setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (task) => { journals.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => journalRead ? journalRead(taskId) : structuredClone(journals.get(taskId) || null),
    deleteVideoTaskCheckpoint: async () => true,
    downloadGeneratedMedia: async (request) => ({ fileName: `${request.fileName}.mp4`, relativePath: `video/${request.fileName}.mp4`,
      checksum: `movie-${request.requestId}`, sizeBytes: 8, mediaType: 'video', managed: true, missing: false,
      url: `lianhua-asset://local/video/${request.fileName}.mp4` }),
    readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => ({ dataUrl: `data:image/png;base64,${expectedChecksum || relativePath}` }),
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'fixture' }),
    extractWorkbenchFrames: async () => { throw new Error('strict AI fixture must not silently extract raw tail'); },
    cancelWorkbenchJob: async () => true,
  };
  const options: VideoGenerationEngineOptions = {
    getState: () => holder.state,
    setState: (updater: (state: AppState) => AppState) => { holder.state = updater(holder.state); },
    desktop, onRuntime: () => {}, pollIntervalMs: 60_000, persistState: async () => {},
    selectTailFrame: async (input) => {
      assert.equal(input.requireAiSelection, true);
      selectedSources.push(structuredClone(input.source));
      await input.onBeforeAI?.();
      return selectedFrame(selectedSources.length);
    },
  };
  const h = {
    holder, requests, journals, remoteStates, selectedSources, desktop, options,
    engine: new VideoGenerationEngine(options),
    posts: () => requests.filter((entry) => entry.method === 'POST' && entry.url === config.endpoint),
    tasks: (batchId?: string) => {
      const projects = [holder.state.project, ...holder.state.projects.filter((project) => project.id !== holder.state.project.id)];
      return projects.flatMap((project) => project.generationTasks.filter((task): task is VideoGenerationTask => task.kind === 'video'
        && (!batchId || task.batchId === batchId))).sort((left, right) => (left.batchIndex || 0) - (right.batchIndex || 0));
    },
    task: (taskId: string) => h.tasks().find((task) => task.id === taskId)!,
    setPostBehavior: (behavior: typeof postBehavior) => { postBehavior = behavior; },
    setJournalRead: (behavior: typeof journalRead) => { journalRead = behavior; },
    configure: (mode: 'queue' | 'concurrent', concurrency = 1) => {
      Object.assign(holder.state.settings, { videoExecutionMode: mode, videoExecutionConcurrency: concurrency });
      h.engine.reconcile();
    },
    restart: () => { h.engine.dispose(); h.engine = new VideoGenerationEngine(options); h.engine.reconcile(); },
  };
  return h;
};
type Fixture = ReturnType<typeof fixture>;
const batchInput = (h: Fixture, prefix: string, count: number, chain = false): VideoBatchStartInput => ({
  projectId: h.holder.state.project.id, label: prefix, concurrency: 1,
  items: Array.from({ length: count }, (_, index) => ({ itemKey: `${prefix}-${index + 1}:zh`,
    draft: { ...draft(`${prefix}-${index + 1}`, index + 1), source: { ...draft(`${prefix}-${index + 1}`, index + 1).source, sequencePlanId: `plan-${prefix}` } },
    ...(chain && index > 0 ? { previousTail: { predecessorItemKey: `${prefix}-${index}:zh`,
      placement: { mode: 'append' as const, index: 0, role: 'first-frame' as const },
      selectionMode: 'ai-assisted' as const, requireAiSelection: true as const } } : {}) })),
});
const complete = async (h: Fixture, taskId: string, status: 'succeeded' | 'failed' = 'succeeded') => {
  const task = h.task(taskId); assert.ok(task.remoteTaskId, 'only an acknowledged remote task may complete');
  h.remoteStates.set(task.remoteTaskId, status);
  await h.engine.resume(taskId);
  await waitFor(() => h.task(taskId)?.status === status && (status === 'failed' || Boolean(h.task(taskId).resultAssetId)), `remote ${taskId} did not settle`);
  h.engine.reconcile();
};
const switchProject = (h: Fixture, id: string) => {
  const state = h.holder.state;
  const saved = { ...state.project };
  const other: Project = { ...structuredClone(saved), id, name: id, generationTasks: [], assets: [] };
  h.holder.state = { ...state, project: other, activeProjectId: other.id,
    projects: [...state.projects.filter((project) => project.id !== saved.id && project.id !== id), saved, other] };
};
const tests: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });

test('mode/count values fail safe and slot evidence is not just local presentation', async () => {
  for (const settings of [{}, { videoExecutionMode: 'queue', videoExecutionConcurrency: 100 },
    { videoExecutionMode: 'garbage', videoExecutionConcurrency: 3 }, { videoExecutionMode: 'concurrent', videoExecutionConcurrency: 0 },
    { videoExecutionMode: 'concurrent', videoExecutionConcurrency: 101 }, { videoExecutionMode: 'concurrent', videoExecutionConcurrency: 2.5 }]) {
    assert.equal(resolveVideoExecutionLimit(settings), 1);
  }
  assert.equal(resolveVideoExecutionLimit({ videoExecutionMode: 'concurrent', videoExecutionConcurrency: 3 }), 3);
  assert.equal(resolveVideoExecutionLimit({ videoExecutionMode: 'concurrent', videoExecutionConcurrency: 100 }), 100);
  const h = fixture();
  try {
    const id = await h.engine.start(draft('slot evidence'));
    const running = h.task(id);
    assert.equal(videoTaskOccupiesGenerationSlot(running), true);
    assert.equal(videoTaskOccupiesGenerationSlot({ ...running, status: 'unknown', videoJob: { ...running.videoJob!, stage: 'submission-unknown' } }), true);
    const stopped = { ...running, videoJob: { ...running.videoJob!, stage: 'stopped' as const, trackingStopped: true, cancellationConfirmed: false } };
    assert.equal(videoTaskOccupiesGenerationSlot(stopped), false);
    assert.equal(videoTaskHasUnresolvedSubmission(stopped), true, 'release local capacity without fabricating provider cancellation');
    assert.equal(videoTaskOccupiesGenerationSlot({ ...running, status: 'failed', error: 'HTTP 401 while querying',
      videoJob: { ...running.videoJob!, stage: 'failed' } }), true, 'a local query failure does not certify remote termination');
    assert.equal(videoTaskOccupiesGenerationSlot({ ...running, status: 'failed', response: { base_resp: { status_code: 1004, status_msg: 'authentication failed' } },
      videoJob: { ...running.videoJob!, stage: 'failed' } }), true, 'an API query envelope error must not release an existing remote task');
    assert.equal(videoTaskOccupiesGenerationSlot({ ...running, status: 'failed', error: 'local download failed',
      videoJob: { ...running.videoJob!, stage: 'failed', remoteGenerationEnded: true, downloadError: 'local disk full' } }), false,
    'an explicit remote terminal result still frees capacity when local saving fails');
    assert.equal(videoTaskOccupiesGenerationSlot({ ...running, videoJob: undefined }), true, 'legacy remote jobs also share the global cap');
    await complete(h, id);
    assert.equal(videoTaskOccupiesGenerationSlot(h.task(id)), false);
  } finally { h.engine.dispose(); }
});

test('concurrent single starts reserve capacity before delayed POST acknowledgements exist', async () => {
  const h = fixture(); const postGate = deferred();
  try {
    h.configure('concurrent', 2);
    h.setPostBehavior(async (index) => {
      await postGate.promise;
      h.remoteStates.set(`remote-${index}`, 'running');
      return response({ id: `remote-${index}`, status: 'running' });
    });
    const starts = [1, 2, 3].map((index) => h.engine.start(draft(`in-flight start ${index}`)));
    await waitFor(() => h.posts().length === 2, 'two configured POST slots did not start');
    await settle(); assert.equal(h.posts().length, 2, 'a missing acknowledgement must not look like a free slot');
    h.engine.reconcile(); await settle(); assert.equal(h.posts().length, 2);
    postGate.resolve(); const taskIds = await Promise.all(starts);
    await settle(); assert.equal(h.posts().length, 2, 'acknowledgement alone cannot admit the third remote task');
    const running = taskIds.find((id) => Boolean(h.task(id).remoteTaskId))!;
    await complete(h, running);
    await waitFor(() => h.posts().length === 3, 'one completed remote should admit the remaining authorized single start');
    assert.equal(new Set(taskIds).size, 3);
  } finally { postGate.resolve(); h.engine.dispose(); }
});

test('queue holds the slot after POST acknowledgement across another batch and single start', async () => {
  const h = fixture();
  try {
    const original = await h.engine.startBatch(batchInput(h, 'original', 2));
    await waitFor(() => Boolean(h.task(original.taskIds[0])?.remoteTaskId), 'first remote did not start');
    const other = await h.engine.startBatch(batchInput(h, 'another', 1));
    const single = await h.engine.start(draft('separate single'));
    await settle();
    assert.equal(h.posts().length, 1, 'POST response is not generation completion');
    assert.equal(h.task(single).remoteTaskId, undefined);
    assert.equal(h.task(single).videoJob?.stage, 'queued');
    assert.equal(h.task(other.taskIds[0]).remoteTaskId, undefined);
    await complete(h, original.taskIds[0]);
    await waitFor(() => h.posts().length === 2, 'free generation slot did not admit one queued task');
    await settle(); assert.equal(h.posts().length, 2, 'only one successor may use a released queue slot');
  } finally { h.engine.dispose(); }
});

test('raising concurrency during an unacknowledged batch POST wakes additional slots in that same batch', async () => {
  const h = fixture(); const postGate = deferred();
  try {
    h.setPostBehavior(async (index) => {
      await postGate.promise;
      h.remoteStates.set(`remote-${index}`, 'running');
      return response({ id: `remote-${index}`, status: 'running' });
    });
    const batch = await h.engine.startBatch(batchInput(h, 'raise during POST', 4));
    await waitFor(() => h.posts().length === 1, 'initial queue POST not dispatched');
    h.configure('concurrent', 3);
    await waitFor(() => h.posts().length === 3, 'one delayed POST must not keep the newly configured slots idle');
    await settle(); assert.equal(h.posts().length, 3);
    postGate.resolve();
    await waitFor(() => h.tasks(batch.batchId).filter((task) => task.remoteTaskId).length === 3, 'all three POST acknowledgements missing');
    await settle(); assert.equal(h.posts().length, 3, 'the fourth row still needs true remote completion');
  } finally { postGate.resolve(); h.engine.dispose(); }
});

test('lowering capacity while images prepare prevents already-preparing surplus rows from POSTing', async () => {
  const h = fixture(); const imageGate = deferred(); let preparingImages = 0;
  try {
    h.configure('concurrent', 3);
    const image = { ...frame(888), id: 'fixture-source-image', name: 'fixture frozen input', type: 'reference' as const,
      role: 'composition' as const, source: 'derived' as const, tags: [], createdAt: 1, updatedAt: 1 };
    h.holder.state.project.assets.push(image);
    h.desktop.readManagedImageDataUrl = async () => { preparingImages += 1; await imageGate.promise; return { dataUrl: 'data:image/png;base64,AA==' }; };
    const input = batchInput(h, 'lower during image preparation', 3);
    for (const item of input.items) item.draft.references = [{ assetId: image.id, role: 'first-frame' }];
    const batch = await h.engine.startBatch(input);
    await waitFor(() => preparingImages === 3, 'three preparations did not acquire their permitted slots');
    h.configure('queue'); imageGate.resolve();
    await waitFor(() => h.posts().length === 1, 'the earliest preparation should retain one dispatch slot');
    await settle(); assert.equal(h.posts().length, 1, 'lowering capacity before POST must park surplus prepared requests');
    const first = h.tasks(batch.batchId).find((task) => task.remoteTaskId)!;
    await complete(h, first.id);
    await waitFor(() => h.posts().length === 2, 'a prepared waiting task should safely reuse the next available slot');
    await settle(); assert.equal(h.posts().length, 2);
  } finally { imageGate.resolve(); h.engine.dispose(); }
});

test('concurrency 3 is shared by two projects, independent batches, and a single task', async () => {
  const h = fixture();
  try {
    h.configure('concurrent', 3);
    const first = await h.engine.startBatch(batchInput(h, 'project A', 2));
    switchProject(h, 'project-B');
    const single = await h.engine.start(draft('project B single'));
    await h.engine.startBatch(batchInput(h, 'project B batch', 3));
    await waitFor(() => h.posts().length === 3, 'configured concurrency did not fill three slots');
    await settle(); assert.equal(h.posts().length, 3, 'separate batch/project must not each receive a private limit');
    assert.equal(h.tasks().filter((task) => task.remoteTaskId).length, 3);
    const live = h.tasks().find((task) => task.remoteTaskId && [single, ...first.taskIds].includes(task.id))!;
    await complete(h, live.id);
    await waitFor(() => h.posts().length === 4, 'a remote completion did not free exactly one global slot');
    await settle(); assert.equal(h.posts().length, 4);
  } finally { h.engine.dispose(); }
});

test('lowering concurrency preserves existing work; raising it explicitly admits waiting work', async () => {
  const h = fixture();
  try {
    h.configure('concurrent', 3);
    const result = await h.engine.startBatch(batchInput(h, 'dynamic limit', 6));
    await waitFor(() => h.tasks(result.batchId).filter((task) => task.remoteTaskId).length === 3, 'three remote generations did not start');
    const started = h.tasks(result.batchId).filter((task) => task.remoteTaskId).map((task) => [task.id, task.remoteTaskId]);
    h.configure('queue'); await settle();
    assert.equal(h.posts().length, 3); assert.ok(h.tasks(result.batchId).slice(0, 3).every((task) => !task.videoJob?.trackingStopped));
    await complete(h, started[0][0]!); await complete(h, started[1][0]!); await settle();
    assert.equal(h.posts().length, 3, 'lowering the cap waits until all old excess work ends');
    await complete(h, started[2][0]!);
    await waitFor(() => h.posts().length === 4, 'last legacy active task did not release queue mode');
    h.configure('concurrent', 3);
    await waitFor(() => h.posts().length === 6, 'explicitly raising the cap should wake two already-authorized queued tasks');
    assert.deepEqual(h.tasks(result.batchId).slice(0, 3).map((task) => [task.id, task.remoteTaskId]), started);
    assert.equal(h.requests.filter((request) => request.method === 'DELETE').length, 0);
  } finally { h.engine.dispose(); }
});

test('upgrade/restart with three existing running tasks waits for all, never cancels or reposts them', async () => {
  const h = fixture();
  try {
    h.configure('concurrent', 3);
    const running = await h.engine.startBatch(batchInput(h, 'old release', 3));
    await waitFor(() => h.tasks(running.batchId).every((task) => task.remoteTaskId), 'fixture did not reach three already-running tasks');
    const oldIds = h.tasks(running.batchId).map((task) => [task.id, task.remoteTaskId]);
    Object.assign(h.holder.state.settings, { videoExecutionMode: 'queue' });
    h.restart();
    const next = await h.engine.startBatch(batchInput(h, 'new release', 1));
    await settle(); assert.equal(h.posts().length, 3);
    for (const id of running.taskIds.slice(0, 2)) { await complete(h, id); await settle(); assert.equal(h.posts().length, 3); }
    await complete(h, running.taskIds[2]);
    await waitFor(() => Boolean(h.task(next.taskIds[0]).remoteTaskId), 'queued upgrade task did not start after all old remotes finished');
    assert.equal(h.posts().length, 4);
    assert.deepEqual(h.tasks(running.batchId).map((task) => [task.id, task.remoteTaskId]), oldIds);
  } finally { h.engine.dispose(); }
});

test('unknown POST result holds capacity across resume and restart without billing twice', async () => {
  const h = fixture();
  try {
    h.setPostBehavior(async () => { throw new Error('fixture transport disconnected after POST'); });
    const unknown = await h.engine.start(draft('uncertain request'));
    assert.equal(h.task(unknown).status, 'unknown');
    assert.equal(h.task(unknown).videoJob?.preparation?.phase, 'post-started');
    h.setPostBehavior(undefined);
    await h.engine.startBatch(batchInput(h, 'waiting behind uncertainty', 2));
    await assert.rejects(() => h.engine.resume(unknown), /不能安全恢复|没有远端任务/u);
    await settle(); assert.equal(h.posts().length, 1);
    h.restart(); await settle(); assert.equal(h.posts().length, 1);
    h.configure('concurrent', 2);
    await waitFor(() => h.posts().length === 2, 'unknown request should consume exactly one of two explicit slots');
    await settle(); assert.equal(h.posts().length, 2);
  } finally { h.engine.dispose(); }
});

test('local stop releases software capacity without remote cancellation or replaying the stopped task', async () => {
  const h = fixture();
  try {
    const first = await h.engine.start(draft('remote cannot cancel'));
    const result = await h.engine.startBatch(batchInput(h, 'waiting cancellable', 2));
    await h.engine.cancel(result.taskIds[0]);
    await h.engine.cancel(first); await settle();
    assert.equal(h.task(first).videoJob?.trackingStopped, true);
    assert.equal(h.task(first).videoJob?.cancellationConfirmed, false);
    h.engine.reconcile();
    await waitFor(() => Boolean(h.task(result.taskIds[1]).remoteTaskId), 'stopped remote still consumed the local slot');
    assert.equal(h.posts().length, 2);
    assert.equal(h.task(result.taskIds[0]).remoteTaskId, undefined);
    h.restart(); await settle(); assert.equal(h.posts().length, 2, 'reopening must not resubmit the stopped remote');
    await complete(h, first);
    assert.equal(h.posts().length, 2);
    assert.equal(h.task(result.taskIds[0]).remoteTaskId, undefined);
  } finally { h.engine.dispose(); }
});

test('stopping an unresolved in-flight POST releases its claim before the request settles', async () => {
  const h = fixture(); const postGate = deferred();
  let firstStart: Promise<string> | undefined;
  try {
    h.setPostBehavior(async (index) => {
      if (index === 1) { await postGate.promise; throw new Error('stopped POST transport settled late'); }
      h.remoteStates.set(`remote-${index}`, 'running');
      return response({ id: `remote-${index}`, status: 'running' });
    });
    firstStart = h.engine.start(draft('unresolved POST to stop'));
    await waitFor(() => h.posts().length === 1, 'first POST never crossed the submission boundary');
    const first = h.tasks().find((task) => task.videoJob?.preparation?.phase === 'post-started')!.id;
    const next = await h.engine.start(draft('waiting for local stop'));
    assert.equal(h.task(next).remoteTaskId, undefined);
    await h.engine.cancel(first);
    await waitFor(() => Boolean(h.task(next).remoteTaskId), 'stopped in-flight claim blocked the next task');
    assert.equal(videoTaskOccupiesGenerationSlot(h.task(first)), false);
    assert.equal(videoTaskHasUnresolvedSubmission(h.task(first)), true);
    assert.equal(h.journals.get(first)?.videoJob?.preparation?.phase, 'post-started');
    const third = await h.engine.start(draft('still subject to the current limit'));
    await settle(); assert.equal(h.posts().length, 2);
    assert.equal(h.task(third).remoteTaskId, undefined);
    postGate.resolve(); assert.equal(await firstStart, first);
    assert.equal(h.task(first).videoJob?.stage, 'stopped');
    h.restart(); await settle();
    assert.equal(h.posts().length, 2, 'late settlement or restart must never replay the stopped POST');
    assert.equal(videoTaskOccupiesGenerationSlot(h.task(first)), false);
    assert.equal(videoTaskHasUnresolvedSubmission(h.task(first)), true);
  } finally { postGate.resolve(); h.engine.dispose(); await firstStart; }
});

test('one-click local queue deletion cancels dispatch and cannot revive from an orphan journal', async () => {
  const h = fixture();
  try {
    const first = await h.engine.start(draft('occupied while deleting'));
    const waiting = await h.engine.startBatch(batchInput(h, 'delete one queued row', 2));
    const removedId = waiting.taskIds[0];
    assert.equal(isUnsubmittedVideoTask(h.task(removedId)), true);
    await h.engine.cancel(removedId);
    assert.equal(isUnsubmittedVideoTask(h.task(removedId)), true);
    assert.equal(h.task(removedId).videoJob?.cancellationConfirmed, true);
    const removed = removeVideoTaskKeepingProvenance(h.holder.state.project, removedId);
    assert.equal(removed.removed, true, 'one action may remove the already-cancelled local queue record');
    h.holder.state.project = removed.project;
    h.engine.reconcile();
    // This fixture deliberately retains the old journal. Only live project
    // records authorize restoration, so even late checkpoint cleanup is safe.
    assert.equal(h.journals.has(removedId), true);
    h.restart(); await settle();
    assert.equal(h.task(removedId), undefined);
    assert.equal(h.posts().length, 1);
    await complete(h, first);
    await waitFor(() => Boolean(h.task(waiting.taskIds[1]).remoteTaskId), 'the unaffected next queue row did not start');
    assert.equal(h.posts().length, 2);
    assert.equal(h.task(removedId), undefined, 'deleted queued work must never be resurrected or submitted');
  } finally { h.engine.dispose(); }
});

test('contradictory preparing metadata cannot certify cancellation of a known remote task', async () => {
  const h = fixture();
  try {
    const taskId = await h.engine.start(draft('known remote wins over old metadata'));
    const task = h.task(taskId);
    task.videoJob = { ...task.videoJob!, stage: 'queued', preparation: { version: 1, phase: 'preparing', uploadedImages: [] } };
    assert.equal(isUnsubmittedVideoTask(task), false);
    await h.engine.cancel(taskId); await settle();
    assert.equal(h.task(taskId).videoJob?.cancellationConfirmed, false);
    assert.equal(videoTaskOccupiesGenerationSlot(h.task(taskId)), false);
    assert.equal(videoTaskHasUnresolvedSubmission(h.task(taskId)), true);
    assert.ok(h.task(taskId).remoteTaskId);
    assert.equal(h.posts().length, 1);
  } finally { h.engine.dispose(); }
});

test('cancel during restart reads the newer POST journal before authorizing deletion', async () => {
  const h = fixture(); const journalGate = deferred(); let reads = 0;
  try {
    const taskId = await h.engine.start(draft('stale queued cancellation'));
    const task = h.task(taskId);
    const remoteId = task.remoteTaskId;
    const stale: VideoGenerationTask = { ...task, remoteTaskId: undefined, status: 'draft', response: undefined,
      videoJob: { ...task.videoJob!, stage: 'queued', submittedAt: undefined, startedAt: undefined,
        preparation: { version: 1, phase: 'preparing', uploadedImages: [] } } };
    h.holder.state.project.generationTasks = h.holder.state.project.generationTasks.map((entry) => entry.id === taskId ? stale : entry);
    h.setJournalRead(async (id) => {
      const saved = structuredClone(h.journals.get(id) || null);
      if (id === taskId) { reads += 1; await journalGate.promise; }
      return saved;
    });
    h.restart();
    await waitFor(() => reads > 0, 'restart did not inspect its native journal');
    const cancelling = h.engine.cancel(taskId);
    await waitFor(() => reads > 1, 'cancel did not verify the untrusted queue snapshot');
    assert.equal(h.journals.get(taskId)?.remoteTaskId, remoteId, 'cancellation must not erase the durable remote ID');
    journalGate.resolve(); await cancelling; await settle();
    assert.equal(h.task(taskId).remoteTaskId, remoteId);
    assert.equal(isUnsubmittedVideoTask(h.task(taskId)), false);
    assert.equal(h.task(taskId).videoJob?.cancellationConfirmed, false);
    assert.equal(videoTaskOccupiesGenerationSlot(h.task(taskId)), false);
    assert.equal(videoTaskHasUnresolvedSubmission(h.task(taskId)), true);
    assert.equal(h.posts().length, 1, 'journal recovery only queries/cancels the original task');
  } finally { journalGate.resolve(); h.engine.dispose(); }
});

test('unsubmitted predicate rejects remote and unknown evidence even when the card says queued', async () => {
  const h = fixture();
  try {
    await h.engine.start(draft('predicate blocker'));
    const taskId = await h.engine.start(draft('predicate queued'));
    const task = h.task(taskId);
    assert.equal(isUnsubmittedVideoTask(task), true);
    for (const patch of [{ status: 'unknown' as const }, { status: 'submitted' as const }, { status: 'running' as const },
      { remoteTaskId: 'remote' }, { resultUrl: 'https://cdn.example.test/video.mp4' }, { resultAssetId: 'asset' }]) {
      assert.equal(isUnsubmittedVideoTask({ ...task, ...patch }), false);
    }
    for (const patch of [{ stage: 'submission-unknown' as const }, { stage: 'submitting' as const },
      { submittedAt: 1 }, { generatedAt: 1 }, { resultAssetIds: ['saved-video'] },
      { preparation: { version: 1 as const, phase: 'post-started' as const, uploadedImages: [] } }]) {
      assert.equal(isUnsubmittedVideoTask({ ...task, videoJob: { ...task.videoJob!, ...patch } }), false);
    }
  } finally { h.engine.dispose(); }
});

test('definite provider failure releases ordinary next row without relaxing tail dependencies', async () => {
  const h = fixture();
  try {
    const ordinary = await h.engine.startBatch(batchInput(h, 'independent failure', 2));
    await waitFor(() => Boolean(h.task(ordinary.taskIds[0]).remoteTaskId), 'ordinary first task did not start');
    await complete(h, ordinary.taskIds[0], 'failed');
    await waitFor(() => Boolean(h.task(ordinary.taskIds[1]).remoteTaskId), 'definite failure should not deadlock independent tasks');
    await complete(h, ordinary.taskIds[1]);
    h.configure('concurrent', 3);
    const chain = await h.engine.startBatch(batchInput(h, 'dependent failure', 2, true));
    await waitFor(() => Boolean(h.task(chain.taskIds[0]).remoteTaskId), 'chain parent did not start');
    await complete(h, chain.taskIds[0], 'failed');
    await h.engine.startBatch(batchInput(h, 'unrelated ready', 1));
    await waitFor(() => h.posts().length === 4, 'failed chain must not occupy remote capacity for unrelated jobs');
    await settle(); assert.equal(h.task(chain.taskIds[1]).remoteTaskId, undefined);
    assert.equal(h.selectedSources.length, 0, 'a failed parent must not be replaced with any other recent successful video');
  } finally { h.engine.dispose(); }
});

test('new starts cannot race a stale project snapshot before its newer POST checkpoint is read', async () => {
  const h = fixture(); const readGate = deferred(); let blockedRead = false;
  try {
    const original = await h.engine.start(draft('journal owns remote'));
    const task = h.task(original);
    const stale: VideoGenerationTask = { ...task, remoteTaskId: undefined, status: 'submitting', response: undefined,
      videoJob: { ...task.videoJob!, stage: 'preparing', preparation: { version: 1, phase: 'preparing', uploadedImages: [] } } };
    h.holder.state.project.generationTasks = h.holder.state.project.generationTasks.map((entry) => entry.id === original ? stale : entry);
    h.setJournalRead(async (taskId) => { if (taskId === original) { blockedRead = true; await readGate.promise; } return structuredClone(h.journals.get(taskId) || null); });
    h.restart();
    await waitFor(() => blockedRead, 'new engine did not inspect the stale preparation journal');
    const waiting = await h.engine.startBatch(batchInput(h, 'new start while reading journal', 1));
    await settle(); assert.equal(h.posts().length, 1, 'no generation may bypass an unresolved older POST checkpoint');
    readGate.resolve();
    await waitFor(() => h.task(original)?.remoteTaskId === task.remoteTaskId, 'newer acknowledgement was not restored');
    await settle(); assert.equal(h.posts().length, 1);
    await complete(h, original);
    await waitFor(() => Boolean(h.task(waiting.taskIds[0]).remoteTaskId), 'trusted checkpoint completion did not release the waiting task');
    assert.equal(h.posts().length, 2);
  } finally { readGate.resolve(); h.engine.dispose(); }
});

test('concurrent startBatch and resumeBatch calls do not multiply authorized queue rows', async () => {
  const h = fixture();
  try {
    const input = batchInput(h, 'same click', 3);
    const [first, duplicate] = await Promise.all([h.engine.startBatch(input), h.engine.startBatch(structuredClone(input))]);
    assert.equal(first.batchId, duplicate.batchId);
    await waitFor(() => h.posts().length === 1, 'deduplicated batch did not start');
    const originalIds = [...first.taskIds];
    h.restart();
    await Promise.all([h.engine.resumeBatch(first.batchId), h.engine.resumeBatch(first.batchId)]);
    await settle(); assert.equal(h.posts().length, 1);
    for (let index = 0; index < originalIds.length; index += 1) {
      await waitFor(() => Boolean(h.task(originalIds[index]).remoteTaskId), `queue row ${index + 1} missing remote id`);
      await complete(h, originalIds[index]);
    }
    assert.equal(h.posts().length, 3);
    assert.deepEqual(h.tasks(first.batchId).map((task) => task.id), originalIds);
  } finally { h.engine.dispose(); }
});

test('continued suffix uses the original successful parent and one new lineage, not a parallel old suffix', async () => {
  const h = fixture();
  try {
    h.configure('concurrent', 3);
    h.setPostBehavior(async (index) => {
      const status = index === 2 ? 'failed' : index === 3 ? 'running' : 'succeeded';
      h.remoteStates.set(`remote-${index}`, status);
      return response({ id: `remote-${index}`, status, ...(status === 'succeeded' ? { url: `https://cdn.example.test/remote-${index}.mp4` }
        : status === 'failed' ? { message: 'fixture failure at the second segment' } : {}) });
    });
    const original = await h.engine.startBatch(batchInput(h, 'continued exact chain', 3, true));
    await waitFor(() => h.task(original.taskIds[1])?.status === 'failed', 'original second segment did not fail');
    await h.engine.cancelBatch(original.batchId);
    const firstParent = h.task(original.taskIds[0]);
    assert.ok(firstParent.resultAssetId);
    const summary = await h.engine.resumeBatch(original.batchId);
    assert.ok(summary.continuation);
    assert.equal(summary.continuation.predecessorTaskId, firstParent.id);
    const [continued, repeated] = await Promise.all([h.engine.confirmContinueBatch(summary.continuation.id), h.engine.confirmContinueBatch(summary.continuation.id)]);
    assert.equal(continued.batchId, repeated.batchId);
    await waitFor(() => h.posts().length === 3, 'continued first suffix row did not start');
    await settle(); assert.equal(h.posts().length, 3, 'high concurrency cannot bypass a running tail predecessor');
    assert.equal(h.selectedSources[0].assetId, firstParent.resultAssetId);
    assert.equal(h.selectedSources.length, 1, 'the continuation first frame must reuse the exact frozen original-parent frame');
    const continuedFirst = h.task(continued.taskIds[0]);
    await complete(h, continuedFirst.id);
    await waitFor(() => h.posts().length === 4 && h.task(continued.taskIds[1])?.resultAssetId != null, 'continued second suffix row did not finish');
    assert.equal(h.selectedSources[1].assetId, h.task(continuedFirst.id).resultAssetId);
    assert.equal(h.task(continued.taskIds[1]).videoJob?.snapshot.previousTail?.predecessorTaskId, continuedFirst.id);
    assert.equal(h.task(original.taskIds[2]).remoteTaskId, undefined);
    const postCount = h.posts().length;
    await h.engine.resumeBatch(original.batchId); await settle();
    assert.equal(h.posts().length, postCount, 'continuing the old parent follows existing lineage instead of billing another suffix');
  } finally { h.engine.dispose(); }
});

for (const { name, run } of tests) { await run(); console.log(`PASS ${name}`); }
console.log(`Video generation serial/global-slot safety: ${tests.length} groups passed (memory-only fixtures).`);

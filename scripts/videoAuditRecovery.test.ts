import assert from 'node:assert/strict';
import { createInitialState, normalizeState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { importComfyVideoWorkflow } from '../src/comfyuiVideo';
import { removeVideoTaskKeepingProvenance } from '../src/videoProvenance';
import { videoTaskBatchStatus } from '../src/videoTaskBatchStatus';
import type { AppState, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (predicate: () => boolean, message: string) => {
  for (let index = 0; index < 300; index += 1) { if (predicate()) return; await tick(); }
  assert.fail(message);
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const config: VideoTaskApiConfig = {
  enabled: true, provider: 'generic', endpoint: 'https://audit.invalid/run',
  statusEndpointTemplate: 'https://audit.invalid/status/{id}', apiKey: '',
  authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url',
};
const draft = (index = 1): VideoGenerationDraft => ({
  name: `audit-${index}`, prompt: `第 ${index} 段`, backend: 'api', references: [], parameters: {},
  source: { storyboardId: `board-${index}`, sequencePlanId: 'audit-plan', segmentId: `segment-${index}`, segmentIndex: index, language: 'zh' },
});
const movie = (name: string) => ({ fileName: `${name}.mp4`, relativePath: `video/${name}.mp4`, checksum: `sha-${name}`, mediaType: 'video' as const, managed: true, missing: false });
const harness = () => {
  let state = createInitialState(); state.settings.videoTaskApi = { ...config };
  const checkpoints = new Map<string, VideoGenerationTask>();
  const requests: Parameters<VideoGenerationDesktop['videoRequest']>[0][] = [];
  let downloads = 0; let extractions = 0;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => { requests.push(request); return response({ id: 'remote', status: 'queued' }); },
    cancelVideoRequest: async () => true,
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (task) => { checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (id) => structuredClone(checkpoints.get(id) || null), deleteVideoTaskCheckpoint: async (id) => checkpoints.delete(id),
    downloadGeneratedMedia: async (request) => { downloads += 1; return { ...movie(request.fileName || `movie-${downloads}`), sizeBytes: 8, url: `lianhua-asset://video/${downloads}` }; },
    readManagedImageDataUrl: async ({ expectedChecksum }) => ({ dataUrl: 'data:image/png;base64,AAAA', checksum: expectedChecksum || 'sha', mimeType: 'image/png', sizeBytes: 3 }),
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'mock' }),
    extractWorkbenchFrames: async () => ({ probe: { durationSec: 10, width: 640, height: 360, fps: 10, hasAudio: false, videoCodec: 'h264' }, frames: [{
      fileName: `tail-${++extractions}.png`, relativePath: `image/tail-${extractions}.png`, checksum: `sha-tail-${extractions}`,
      mediaType: 'image' as const, mimeType: 'image/png', managed: true, missing: false, role: 'last-frame' as const, sizeBytes: 8,
      url: `lianhua-asset://image/tail-${extractions}.png`,
      timeSec: 9.9, frameIndex: 99, width: 640, height: 360,
    }] }),
    watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
  };
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop, onRuntime: () => {}, persistState: async () => {}, pollIntervalMs: 20 };
  return { desktop, checkpoints, requests, options, engine: new VideoGenerationEngine(options),
    get state() { return state; }, set state(value: AppState) { state = value; },
    get downloads() { return downloads; }, task: (id: string) => state.project.generationTasks.find((task) => task.id === id) as VideoGenerationTask,
  };
};
const chain = (projectId: string) => ({ projectId, label: 'audit chain', concurrency: 1, items: [1, 2, 3].map((index) => ({
  itemKey: `board-${index}:zh`, draft: draft(index), previousTail: index > 1
    ? { predecessorItemKey: `board-${index - 1}:zh`, placement: { mode: 'append' as const, index: 0, role: 'first-frame' as const } }
    : undefined,
})) });
const comfyWorkflow = {
  id: 'audit-comfy', name: 'audit-comfy', createdAt: 1, updatedAt: 1,
  ...importComfyVideoWorkflow(JSON.stringify({
    '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'prompt' }, _meta: { title: 'Input Text (Prompt)' } },
    '2': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0], format: 'video/h264-mp4', frame_rate: 24 } },
  })),
};
const comfyDraft = (h: ReturnType<typeof harness>): VideoGenerationDraft => {
  h.state.settings.comfyuiVideo = { enabled: true, baseUrl: 'https://comfy.audit.invalid', apiKey: '', workflows: [comfyWorkflow], activeWorkflowId: comfyWorkflow.id };
  return { ...draft(), backend: 'comfyui', workflowId: comfyWorkflow.id };
};

// Removing a finished card must not remove a chain dependency: its exact
// persisted result and provenance remain in the owning project's asset library.
for (const restart of [false, true]) {
  const h = harness(); const second = deferred<void>(); const archiveRead = deferred<void>(); let posts = 0;
  h.desktop.videoRequest = async () => {
    const index = ++posts; if (index === 2) await second.promise;
    return response({ id: `remote-${index}`, status: 'succeeded', url: `https://cdn.invalid/${index}.mp4` });
  };
  const batch = await h.engine.startBatch(chain(h.state.project.id));
  await waitFor(() => posts === 2, 'second chain item did not start');
  const readCheckpoint = h.desktop.getVideoTaskCheckpoint!;
  if (restart) h.desktop.getVideoTaskCheckpoint = async (id) => {
    if (id === batch.taskIds[0]) await archiveRead.promise;
    return readCheckpoint(id);
  };
  const removal = removeVideoTaskKeepingProvenance(h.state.project, batch.taskIds[0]);
  assert.equal(removal.removed, true);
  h.state = { ...h.state, project: removal.project };
  h.engine.reconcile(); second.resolve();
  if (restart) {
    await waitFor(() => h.checkpoints.get(batch.taskIds[1])?.videoJob?.stage === 'succeeded', 'second result did not durably save');
    assert.equal(posts, 2, 'restart test must really stop before the third POST');
    h.engine.dispose(); h.state = normalizeState(JSON.parse(JSON.stringify(h.state)));
    h.desktop.getVideoTaskCheckpoint = readCheckpoint;
    h.engine = new VideoGenerationEngine(h.options); h.engine.reconcile();
    archiveRead.resolve();
  }
  await waitFor(() => Boolean(h.task(batch.taskIds[2]).resultAssetId), `deleted predecessor stalled chain (restart=${restart})`);
  assert.equal(posts, 3); assert.equal(h.task(batch.taskIds[0]), undefined, 'archived predecessor must not be recreated as a runnable task');
  h.engine.dispose();
}

// A forged/unsaved archive must never replace a live failed dependency or
// authorize the next billable POST. Each mutation invalidates a different trust boundary.
for (const tamper of ['project', 'batch', 'checkpoint', 'asset', 'live-failed'] as const) {
  const h = harness(); const second = deferred<void>(); let posts = 0;
  h.desktop.videoRequest = async () => { const index = ++posts; if (index === 2) await second.promise; return response({ id: `remote-${index}`, status: 'succeeded', url: `https://cdn.invalid/${index}.mp4` }); };
  const batch = await h.engine.startBatch(chain(h.state.project.id));
  await waitFor(() => posts === 2, 'second chain item did not start');
  const first = h.task(batch.taskIds[0]);
  const project = removeVideoTaskKeepingProvenance(h.state.project, first.id).project;
  const asset = project.assets.find((entry) => entry.sourceVideoTaskId === first.id)!;
  if (tamper === 'project') asset.videoSourceTask!.videoJob!.snapshot.projectId = 'foreign-project';
  if (tamper === 'batch') asset.videoSourceTask!.batchId = 'foreign-batch';
  if (tamper === 'checkpoint') h.checkpoints.set(first.id, { ...first, status: 'submitted', resultAssetId: undefined, videoJob: { ...first.videoJob!, stage: 'downloading' } });
  if (tamper === 'asset') asset.missing = true;
  if (tamper === 'live-failed') project.generationTasks.push({ ...first, status: 'failed', videoJob: { ...first.videoJob!, stage: 'failed' } });
  h.state = { ...h.state, project }; h.engine.reconcile(); second.resolve();
  await waitFor(() => Boolean(h.task(batch.taskIds[1]).resultAssetId), 'second result did not save');
  for (let index = 0; index < 12; index += 1) { h.engine.reconcile(); await tick(); }
  assert.equal(posts, 2, `untrusted archive ${tamper} authorized a POST`); h.engine.dispose();
}

// The OS/IPC can deliver a response after abort was requested. Cancel, or
// cancel then resume, must retire both success and error callbacks from old polls.
for (const kind of ['status', 'file', 'file-after-status'] as const) for (const resume of [false, true]) for (const fail of [false, true]) {
  const h = harness(); const gate = deferred<ReturnType<typeof response>>(); let queried = false; let oldStarted = false;
  if (kind !== 'status') Object.assign(h.state.settings.videoTaskApi, { fileIdPath: 'file_id', fileEndpointTemplate: 'https://audit.invalid/file/{id}', fileUrlPath: 'url' });
  h.desktop.videoRequest = async (request) => {
    if (request.url.endsWith('/run')) return response(kind === 'file' ? { id: 'remote', status: 'succeeded', file_id: 'first-file' } : { id: 'remote', status: 'queued' });
    queried = true;
    if (kind === 'file-after-status' && !request.url.includes('/file/')) return response({ id: 'remote', status: 'succeeded', file_id: 'first-file' });
    if (!oldStarted) { oldStarted = true; return gate.promise; }
    return response({ id: 'remote', status: 'queued' });
  };
  const id = await h.engine.start(draft()); await waitFor(() => queried && oldStarted, 'old poll did not start');
  await h.engine.cancel(id);
  if (resume) await h.engine.resume(id);
  if (fail) gate.reject(new Error('OLD_QUERY_ERROR')); else gate.resolve(response({ id: 'remote', status: 'succeeded', url: 'https://cdn.invalid/OLD.mp4' }));
  for (let index = 0; index < 10; index += 1) await tick();
  assert.equal(h.downloads, 0, `${kind}/${resume}/${fail} accepted an obsolete output`);
  assert.equal(h.task(id).resultUrl, undefined);
  assert.equal(h.task(id).videoJob!.trackingStopped, !resume);
  assert.notEqual(h.task(id).videoJob!.stage, 'downloading');
  assert.ok(!h.task(id).videoJob!.message?.includes('OLD_QUERY_ERROR'));
  h.engine.dispose();
}

// Restarting while remote cancellation is unresolved must not preserve a
// forever-pending ownerless operation. Local stop is not remote confirmation.
{
  const h = harness(); const cancel = deferred<ReturnType<typeof response>>(); let cancellationStarted = false;
  h.state.settings.videoTaskApi.cancelEndpointTemplate = 'https://audit.invalid/cancel/{id}';
  h.desktop.videoRequest = async (request) => {
    if (request.url.includes('/cancel/')) { cancellationStarted = true; return cancel.promise; }
    return response(request.url.endsWith('/run') ? { id: 'remote', status: 'queued' } : { id: 'remote', status: 'succeeded', url: 'https://cdn.invalid/final.mp4' });
  };
  const id = await h.engine.start(draft()); await h.engine.cancel(id);
  await waitFor(() => cancellationStarted, 'remote cancellation did not start');
  h.engine.dispose(); h.state = normalizeState(JSON.parse(JSON.stringify(h.state)));
  h.engine = new VideoGenerationEngine(h.options); h.engine.reconcile();
  await waitFor(() => !h.task(id).videoJob!.cancellationPending, 'orphan cancellation was not cleared after restart');
  assert.equal(h.task(id).videoJob!.trackingStopped, true); assert.notEqual(h.task(id).videoJob!.cancellationConfirmed, true);
  assert.equal(videoTaskBatchStatus(h.task(id)), 'stopped');
  await h.engine.resume(id); cancel.resolve(response({}));
  await waitFor(() => Boolean(h.task(id).resultAssetId), 'original result did not recover');
  assert.equal(h.task(id).videoJob!.cancellationPending, false); assert.equal(videoTaskBatchStatus(h.task(id)), 'succeeded');
  h.engine.dispose();
}

// Two stop/resume generations can coexist in transport. The older remote
// cancellation callback must not clear the newer cancellation's pending state.
{
  const h = harness(); const cancellations = [deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>()]; let calls = 0;
  h.state.settings.videoTaskApi.cancelEndpointTemplate = 'https://audit.invalid/cancel/{id}';
  h.desktop.videoRequest = async (request) => request.url.includes('/cancel/') ? cancellations[calls++].promise : response({ id: 'remote', status: 'queued' });
  const id = await h.engine.start(draft()); await h.engine.cancel(id); await waitFor(() => calls === 1, 'first cancel did not start');
  await h.engine.resume(id); assert.equal(h.task(id).videoJob!.cancellationPending, false);
  await h.engine.cancel(id); await waitFor(() => calls === 2, 'second cancel did not start');
  cancellations[0].resolve(response({})); for (let index = 0; index < 8; index += 1) await tick();
  assert.equal(h.task(id).videoJob!.cancellationPending, true, 'old cancellation settled the newer operation');
  cancellations[1].resolve(response({})); await waitFor(() => !h.task(id).videoJob!.cancellationPending, 'current cancellation did not settle');
  h.engine.dispose();
}

// A lost Comfy POST acknowledgement is recovered through read-only queue or
// history observations. Retiring that observation must free the new session
// even if the old transport never settles, including the shared queue cache.
for (const kind of ['queue', 'history'] as const) for (const mode of ['cancel', 'cancel-resume', 'resume'] as const) for (const oldResult of ['found', 'empty', 'error'] as const) {
  const h = harness(); const old = deferred<ReturnType<typeof response>>(); const current = deferred<ReturnType<typeof response>>();
  let clientId = ''; let posts = 0; let recoveryQueries = 0; let historyReads = 0;
  const emptyQueue = { queue_pending: [], queue_running: [] };
  const found = (remoteTaskId: string) => kind === 'queue'
    ? { queue_pending: [[0, remoteTaskId, {}, { client_id: clientId }]], queue_running: [] }
    : { [remoteTaskId]: { prompt: [0, remoteTaskId, {}, { client_id: clientId }] } };
  h.desktop.videoRequest = async (request) => {
    if (request.url.endsWith('/prompt')) {
      posts += 1; clientId = JSON.parse(request.body!).client_id; throw new Error('POST_ACK_LOST');
    }
    assert.equal(request.method, 'GET', 'acknowledgement recovery must never issue a new POST');
    if (request.url.endsWith('/queue')) {
      if (kind === 'history') return response(emptyQueue);
      recoveryQueries += 1;
      return recoveryQueries === 1 ? old.promise : recoveryQueries === 2 ? current.promise : response(emptyQueue);
    }
    if (request.url.includes('/history?')) {
      historyReads += 1;
      if (kind === 'queue') return response({});
      recoveryQueries += 1;
      return recoveryQueries === 1 ? old.promise : recoveryQueries === 2 ? current.promise : response({});
    }
    assert.ok(request.url.endsWith('/history/current-original'));
    return response({ 'current-original': { status: { completed: true, status_str: 'success' }, outputs: { '2': { videos: [{ filename: 'current.mp4', type: 'output' }] } } } });
  };
  const id = await h.engine.start(comfyDraft(h)); h.engine.reconcile();
  await waitFor(() => recoveryQueries === 1, `${kind}/${mode} initial acknowledgement lookup did not start`);
  if (mode !== 'resume') {
    await h.engine.cancel(id);
    assert.equal(h.task(id).videoJob!.trackingStopped, true);
  }
  let resumeError: unknown;
  const resumed = mode === 'cancel' ? undefined : h.engine.resume(id).catch((error: unknown) => { resumeError = error; });
  if (resumed) await waitFor(() => recoveryQueries === 2, `${kind}/${mode} new lookup remained occupied by the old lease/cache`);
  if (oldResult === 'error') old.reject(new Error('OLD_ACK_QUERY_ERROR'));
  else old.resolve(response(oldResult === 'found' ? found('old-observation') : kind === 'queue' ? emptyQueue : {}));
  for (let index = 0; index < 10; index += 1) { await tick(); h.engine.reconcile(); }
  assert.equal(h.task(id).remoteTaskId, undefined, `${kind}/${mode}/${oldResult} accepted an old acknowledgement`);
  assert.equal(recoveryQueries, resumed ? 2 : 1, 'old finally released or rescheduled a replacement lookup');
  assert.equal(historyReads, kind === 'queue' ? 0 : resumed ? 2 : 1, 'retired queue reply started another history request');
  assert.ok(!h.task(id).videoJob!.message?.includes('OLD_ACK_QUERY_ERROR'));
  if (resumed) {
    current.resolve(response(found('current-original'))); await resumed;
    assert.equal(resumeError, undefined, 'current recovery was incorrectly rejected after adopting its own remote ID');
    await waitFor(() => Boolean(h.task(id).resultAssetId), `${kind}/${mode} valid original result was not queried and saved`);
    assert.equal(h.task(id).remoteTaskId, 'current-original');
  } else {
    assert.equal(h.task(id).videoJob!.stage, 'stopped');
    assert.equal(h.task(id).videoJob!.trackingStopped, true);
    assert.equal(h.downloads, 0);
  }
  assert.equal(posts, 1, 'lost acknowledgement must never resubmit the generation request'); h.engine.dispose();
}

// Credential restoration is also asynchronous after restart. A cancelled
// lookup must not begin its first queue request when those credentials arrive.
{
  const h = harness(); const credential = deferred<null>(); let restoringCredential = false; let requests = 0;
  h.desktop.videoRequest = async (request) => {
    requests += 1; assert.ok(request.url.endsWith('/prompt')); throw new Error('POST_ACK_LOST');
  };
  const id = await h.engine.start(comfyDraft(h)); h.engine.dispose();
  h.desktop.getVideoTaskCredential = async () => { restoringCredential = true; return credential.promise; };
  h.engine = new VideoGenerationEngine(h.options); h.engine.reconcile();
  await waitFor(() => restoringCredential, 'acknowledgement credential restoration did not start');
  await h.engine.cancel(id); credential.resolve(null);
  for (let index = 0; index < 10; index += 1) await tick();
  assert.equal(requests, 1, 'retired credential lookup started another request');
  assert.equal(h.task(id).videoJob!.trackingStopped, true);
  assert.equal(h.task(id).videoJob!.stage, 'stopped');
  assert.equal(removeVideoTaskKeepingProvenance(h.state.project, id).removed, true);
  h.engine.dispose();
}

// Finding the ID is legitimate, but a delayed watch registration still belongs
// to its old epoch. Cancellation during that await must remain a local stop.
{
  const h = harness(); const watch = deferred<void>(); let clientId = ''; let watchStarted = false; let historyReads = 0; let posts = 0;
  h.desktop.watchVideoProgress = async () => { watchStarted = true; await watch.promise; };
  h.desktop.videoRequest = async (request) => {
    if (request.url.endsWith('/prompt')) { posts += 1; clientId = JSON.parse(request.body!).client_id; throw new Error('POST_ACK_LOST'); }
    assert.equal(request.method, 'GET');
    if (request.url.endsWith('/queue')) return response({ queue_pending: [], queue_running: [[0, 'watch-original', {}, { client_id: clientId }]] });
    historyReads += 1; return response({});
  };
  const id = await h.engine.start(comfyDraft(h)); h.engine.reconcile();
  await waitFor(() => watchStarted, 'recovered acknowledgement did not register its watch');
  assert.equal(h.task(id).remoteTaskId, 'watch-original');
  await h.engine.cancel(id);
  await waitFor(() => !h.task(id).videoJob!.cancellationPending, 'local stop did not finish checking the running queue');
  watch.resolve(); for (let index = 0; index < 10; index += 1) await tick();
  assert.equal(h.task(id).videoJob!.trackingStopped, true);
  assert.equal(h.task(id).videoJob!.stage, 'stopped');
  assert.equal(historyReads, 0, 'old watch registration scheduled a history lookup after cancellation');
  assert.equal(posts, 1);
  assert.equal(removeVideoTaskKeepingProvenance(h.state.project, id).removed, true);
  h.engine.dispose();
}
console.log('video audit recovery: 41 cancellation/archived-chain regression cases passed');

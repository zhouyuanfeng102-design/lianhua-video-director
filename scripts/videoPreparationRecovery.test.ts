import assert from 'node:assert/strict';
import { createInitialState, normalizeState, type ManagedMediaResult } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { importComfyVideoWorkflow } from '../src/comfyuiVideo';
import { removeVideoTaskKeepingProvenance } from '../src/videoProvenance';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
const config = { enabled: true, endpoint: 'https://original.test/generate', statusEndpointTemplate: 'https://original.test/tasks/{id}', apiKey: 'original-private-key', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', provider: 'generic' as const, model: 'original-model' };
const draft: VideoGenerationDraft = { name: '原图复用', prompt: '中景，人物说：“完整中文对白。”', backend: 'api', references: [{ assetId: 'reference-a', role: 'composition' }], parameters: { seed: 1234, steps: 30 } };
const sourceImage = (id: string, dataUrl = 'data:image/png;base64,AAAA'): ReferenceAsset => ({ id, name: id, type: 'reference', role: 'composition', dataUrl, tags: [], createdAt: 1, updatedAt: 1 });
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const movie: ManagedMediaResult = { fileName: 'result-audio.mp4', relativePath: 'video/result.mp4', checksum: 'movie-checksum', sizeBytes: 1024, mediaType: 'video', managed: true, missing: false, url: 'lianhua-asset://local/video/result.mp4' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (predicate: () => boolean) => {
  for (let count = 0; count < 200; count += 1) { if (predicate()) return; await tick(); }
  assert.fail('video recovery mock did not reach expected state');
};
const taskById = (state: AppState, id: string): VideoGenerationTask => state.project.generationTasks.find((task) => task.id === id) as VideoGenerationTask;
const fixture = (request: (payload: Request) => Promise<Awaited<ReturnType<VideoGenerationDesktop['videoRequest']>>>) => {
  const files = new Map<string, string>();
  const journal = new Map<string, VideoGenerationTask>();
  const credentials = new Map<string, string>();
  const desktop: VideoGenerationDesktop = {
    videoRequest: request, cancelVideoRequest: async () => true,
    watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => { if (apiKey) credentials.set(taskId, apiKey); else credentials.delete(taskId); return { persisted: true }; },
    getVideoTaskCredential: async (taskId) => credentials.get(taskId) || null,
    downloadGeneratedMedia: async () => movie,
    storeGeneratedImage: async ({ dataUrl, fileName }) => {
      const checksum = dataUrl.split(',')[1]; const relativePath = `image/${checksum}.png`;
      files.set(relativePath, dataUrl);
      return { fileName: fileName || 'reference.png', relativePath, checksum, sizeBytes: 3, mediaType: 'image', managed: true, missing: false, url: `lianhua-asset://local/${relativePath}` };
    },
    readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
      const dataUrl = files.get(relativePath); assert.ok(dataUrl, 'snapshot bytes must still exist independently from the asset entry');
      assert.equal(dataUrl.split(',')[1], expectedChecksum, 'managed snapshot cannot silently read changed bytes');
      return { dataUrl };
    },
    saveVideoTaskCheckpoint: async (task) => { journal.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(journal.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId) => journal.delete(taskId),
  };
  return { desktop, files, journal, credentials };
};

// Desktop inline/remote inputs are real immutable bytes, even after source edits/deletion and task deletion.
for (const remote of [false, true]) {
  let state = createInitialState(); state.settings.videoTaskApi = structuredClone(config);
  state.project.assets = [remote ? { ...sourceImage('reference-a'), dataUrl: undefined, url: 'https://image.test/mutable.png' } : sourceImage('reference-a')];
  const requests: Request[] = []; let remotePixels = 'AAAA';
  const f = fixture(async (request) => {
    requests.push(request);
    if (request.url.startsWith('https://image.test/')) return { status: 200, body: remotePixels, contentType: 'image/png', bodyEncoding: 'base64' };
    assert.equal(request.url, config.endpoint, 'reuse must not select a newly edited API connection');
    assert.equal(request.headers?.Authorization, `Bearer ${config.apiKey}`);
    return response({ id: 'generated', status: 'succeeded', url: 'https://cdn.test/result.mp4' });
  });
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop: f.desktop, onRuntime: () => {} };
  const engine = new VideoGenerationEngine(options);
  const originalId = await engine.start(draft);
  const original = taskById(state, originalId);
  assert.ok(original.resultAssetId);
  assert.deepEqual(original.videoJob!.snapshot.draft.parameters, draft.parameters);
  assert.equal(original.videoJob!.snapshot.images[0].freezeState, 'frozen');
  assert.equal(original.videoJob!.snapshot.images[0].relativePath, 'image/AAAA.png');
  assert.equal(original.videoJob!.snapshot.images[0].dataUrl, undefined, 'desktop project JSON does not duplicate raw pixels');
  assert.equal(original.videoJob!.snapshot.images[0].url, undefined, 'mutable remote URL is not used as the frozen source');
  const video = state.project.assets.find((asset) => asset.id === original.resultAssetId)!;
  assert.equal(video.videoSourceTask?.videoJob?.snapshot.images[0].checksum, 'AAAA');
  state.project.assets = state.project.assets.map((asset) => asset.id === 'reference-a' ? { ...asset, dataUrl: 'data:image/png;base64,BBBB' } : asset);
  remotePixels = 'BBBB';
  state.settings.videoTaskApi = { ...config, endpoint: 'https://new-provider.test/generate', apiKey: 'different-key' };
  state.project = removeVideoTaskKeepingProvenance(state.project, originalId).project;
  state.projects = [state.project];
  engine.reconcile();
  assert.ok(f.credentials.size, 'deleting a task must retain credentials needed by the finished asset snapshot');
  state.project.assets = state.project.assets.filter((asset) => asset.id !== 'reference-a');
  const nextId = await engine.start({ ...structuredClone(original.videoJob!.snapshot.draft), reuseTaskId: originalId });
  const posts = requests.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(JSON.parse(posts[1].body!).images, ['data:image/png;base64,AAAA']);
  assert.equal(JSON.parse(posts[1].body!).seed, 1234);
  assert.equal(taskById(state, nextId).videoJob!.snapshot.images[0].checksum, 'AAAA');
  assert.equal(requests.filter((request) => request.url.startsWith('https://image.test/')).length, remote ? 1 : 0, 'same-settings reuse does not download the mutable source again');
  engine.dispose();
}

// Browser fallback persists inline bytes, while unfrozen .82 references cannot pretend to be original pixels.
{
  let state = createInitialState(); state.settings.videoTaskApi = config; state.project.assets = [sourceImage('reference-a')];
  const bodies: Record<string, unknown>[] = [];
  const desktop = { videoRequest: async (request: Request) => { bodies.push(JSON.parse(request.body!)); return response({ status: 'failed' }); } } as unknown as VideoGenerationDesktop;
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop, onRuntime: () => {} };
  const engine = new VideoGenerationEngine(options);
  const originalId = await engine.start(draft);
  state = normalizeState(JSON.parse(JSON.stringify(state)));
  state.project.assets = [];
  const original = taskById(state, originalId);
  assert.equal(original.videoJob!.snapshot.images[0].dataUrl, 'data:image/png;base64,AAAA');
  await engine.start({ ...draft, reuseTaskId: originalId });
  assert.deepEqual(bodies[1].images, ['data:image/png;base64,AAAA']);
  original.videoJob!.snapshot.images[0] = { assetId: 'reference-a', role: 'composition', name: '旧远程图', url: 'https://image.test/new.png' };
  await assert.rejects(() => engine.start({ ...draft, reuseTaskId: originalId }), /没有保存原始字节/u);
  assert.equal(bodies.length, 2);
  engine.dispose();
}

// An interrupted second upload resumes the original preparation, keeps the first upload, and POSTs once.
{
  let state = createInitialState();
  const workflowJson = JSON.stringify({ '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'ORIGINAL' } }, '2': { class_type: 'LoadImage', inputs: { image: 'a.png' } }, '3': { class_type: 'LoadImage', inputs: { image: 'b.png' } }, '4': { class_type: 'RandomNoise', inputs: { noise_seed: 987654321 } }, '5': { class_type: 'VHS_VideoCombine', inputs: { images: ['4', 0], audio: ['4', 1], frame_rate: 24, format: 'video/h264-mp4' } } });
  const imported = importComfyVideoWorkflow(workflowJson);
  const workflow = { id: 'h3', name: 'two original images', ...imported, mapping: { ...imported.mapping, prompt: [{ nodeId: '1', inputName: 'value' }], images: [{ nodeId: '2', inputName: 'image' }, { nodeId: '3', inputName: 'image' }] }, createdAt: 1, updatedAt: 1 };
  state.settings.comfyuiVideo = { enabled: true, baseUrl: 'http://comfy.test', apiKey: '', workflows: [workflow], activeWorkflowId: workflow.id };
  state.project.assets = [sourceImage('reference-a'), sourceImage('reference-b', 'data:image/png;base64,CCCC')];
  let uploadA = 0; let uploadB = 0; let posts = 0; let interrupt = true; let secondStarted = false; let rejectSecond: (error: Error) => void = () => {};
  const f = fixture(async (request) => {
    if (request.url.endsWith('/upload/image')) {
      const data = request.multipart!.files[0].dataUrl;
      if (data.endsWith('AAAA')) { uploadA += 1; return response({ name: 'a-original.png' }); }
      assert.equal(data, 'data:image/png;base64,CCCC'); uploadB += 1;
      if (interrupt) { secondStarted = true; return new Promise((_resolve, reject) => { rejectSecond = reject; }); }
      return response({ name: 'b-original.png' });
    }
    if (request.url.endsWith('/prompt')) {
      posts += 1; const body = JSON.parse(request.body!);
      assert.equal(body.prompt['2'].inputs.image, 'a-original.png'); assert.equal(body.prompt['3'].inputs.image, 'b-original.png');
      assert.equal(body.prompt['4'].inputs.noise_seed, 987654321);
      assert.equal(body.prompt['1'].inputs.value, draft.prompt);
      return response({ prompt_id: 'one-video-only' });
    }
    return response({ queue_pending: [], queue_running: [] });
  });
  let persisted: AppState | undefined;
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop: f.desktop, onRuntime: () => {}, persistState: async () => { persisted = structuredClone(state); } };
  const engine = new VideoGenerationEngine(options);
  const work = engine.start({ ...draft, backend: 'comfyui', workflowId: 'h3', references: [...draft.references, { assetId: 'reference-b', role: 'composition' }], parameters: {} });
  await waitFor(() => secondStarted);
  const taskId = state.project.generationTasks[0].id;
  assert.equal(f.journal.get(taskId)?.videoJob?.preparation?.phase, 'preparing');
  assert.deepEqual(f.journal.get(taskId)?.videoJob?.preparation?.uploadedImages, ['a-original.png']);
  engine.dispose(); rejectSecond(new Error('process exited during image preparation')); await work;
  state = normalizeState(JSON.parse(JSON.stringify(persisted)));
  assert.equal(taskById(state, taskId).videoJob?.stage, 'preparing', 'proved pre-POST preparation remains resumable on load');
  state.project.assets = []; state.projects = [state.project]; interrupt = false;
  const resumed = new VideoGenerationEngine(options); resumed.reconcile(); resumed.reconcile();
  await waitFor(() => taskById(state, taskId).remoteTaskId === 'one-video-only');
  assert.equal(uploadA, 1, 'confirmed first upload is not redone'); assert.equal(uploadB, 2, 'only the unconfirmed attachment upload is retried');
  assert.equal(posts, 1, 'preparation recovery cannot duplicate the video generation POST');
  assert.equal(taskById(state, taskId).videoJob?.preparation?.phase, 'acknowledged');
  resumed.dispose();
}

// A stale whole-project autosave cannot override a durable POST boundary or cause a second generation.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  let posts = 0; let persisted: AppState | undefined;
  const f = fixture(async (request) => { assert.equal(request.method, 'POST'); posts += 1; throw new Error('lost POST acknowledgement'); });
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop: f.desktop, onRuntime: () => {}, persistState: async () => { persisted = structuredClone(state); } };
  const engine = new VideoGenerationEngine(options);
  const taskId = await engine.start({ ...draft, references: [] });
  engine.dispose();
  assert.equal(f.journal.get(taskId)?.videoJob?.preparation?.phase, 'post-started');
  state = normalizeState(JSON.parse(JSON.stringify(persisted)));
  assert.equal(taskById(state, taskId).videoJob!.preparation!.phase, 'preparing');
  taskById(state, taskId).updatedAt = Date.now() + 100_000; // deliberately newer stale project state
  const recovered = new VideoGenerationEngine(options); recovered.reconcile();
  await waitFor(() => taskById(state, taskId).videoJob?.stage === 'submission-unknown');
  await assert.rejects(() => recovered.resume(taskId), /不能安全恢复/u);
  assert.equal(posts, 1);
  recovered.dispose();
}

// Failure to persist the boundary never submits video, and an old .82 preparing record remains uncertain.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  let posts = 0;
  const f = fixture(async () => { posts += 1; return response({}); });
  f.desktop.saveVideoTaskCheckpoint = async (task) => { if (task.videoJob?.preparation?.phase === 'post-started') throw new Error('disk write failed'); return { persisted: true }; };
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop: f.desktop, onRuntime: () => {} });
  const taskId = await engine.start({ ...draft, references: [] });
  assert.equal(posts, 0); assert.equal(taskById(state, taskId).status, 'failed');
  const legacy = structuredClone(taskById(state, taskId)); legacy.status = 'submitting'; legacy.videoJob!.stage = 'preparing'; delete legacy.videoJob!.preparation;
  state.project.generationTasks = [legacy]; state.projects = [state.project];
  const restored = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(taskById(restored, taskId).videoJob?.stage, 'submission-unknown');
  engine.dispose();
}

// Stopping before video POST stays stopped across restart; explicit continuation resumes the saved bytes.
{
  let state = createInitialState(); state.settings.videoTaskApi = { ...config, imageUploadEndpoint: 'https://original.test/upload' };
  state.project.assets = [sourceImage('reference-a')];
  let uploading = false; let holdUpload = true; let posts = 0; let rejectUpload: (error: Error) => void = () => {};
  const f = fixture(async (request) => {
    if (request.url.endsWith('/upload')) {
      assert.equal(request.multipart?.files[0].dataUrl, 'data:image/png;base64,AAAA');
      if (holdUpload) { uploading = true; return new Promise((_resolve, reject) => { rejectUpload = reject; }); }
      return response({ url: 'https://uploaded.test/original-a.png' });
    }
    posts += 1; return response({ status: 'failed', message: 'mock terminal result' });
  });
  f.desktop.cancelVideoRequest = async () => { rejectUpload(new Error('upload stopped locally')); return true; };
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop: f.desktop, onRuntime: () => {} };
  const engine = new VideoGenerationEngine(options);
  const work = engine.start(draft); await waitFor(() => uploading);
  const taskId = state.project.generationTasks[0].id;
  await engine.cancel(taskId); await work;
  assert.equal(taskById(state, taskId).videoJob?.trackingStopped, true); assert.equal(posts, 0);
  engine.dispose(); state = normalizeState(JSON.parse(JSON.stringify(state)));
  state.project.assets = [];
  const resumed = new VideoGenerationEngine(options); resumed.reconcile(); await tick(); await tick();
  assert.equal(taskById(state, taskId).videoJob?.trackingStopped, true, 'restart cannot override an explicit local stop');
  assert.equal(posts, 0);
  holdUpload = false; await resumed.resume(taskId);
  assert.equal(posts, 1); resumed.dispose();
}

// A damaged or identity-mismatched journal cannot be bypassed by clicking Resume on stale preparing state.
for (const issue of ['corrupt', 'createdAt', 'prompt', 'connection'] as const) {
  let state = createInitialState(); state.settings.videoTaskApi = config;
  let persisted: AppState | undefined; let posts = 0;
  const f = fixture(async () => { posts += 1; throw new Error('POST acknowledgement lost'); });
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop: f.desktop, onRuntime: () => {}, persistState: async () => { persisted = structuredClone(state); } };
  const engine = new VideoGenerationEngine(options); const taskId = await engine.start({ ...draft, references: [] }); engine.dispose();
  state = normalizeState(JSON.parse(JSON.stringify(persisted)));
  const stale = taskById(state, taskId);
  if (issue === 'corrupt') f.desktop.getVideoTaskCheckpoint = async () => { throw new Error('journal damaged'); };
  else if (issue === 'createdAt') stale.createdAt += 1;
  else if (issue === 'prompt') stale.videoJob!.snapshot.draft.prompt = 'tampered replacement prompt';
  else stale.videoJob!.snapshot.connection.api!.endpoint = 'https://different.test/generate';
  const resumed = new VideoGenerationEngine(options); resumed.reconcile();
  await waitFor(() => taskById(state, taskId).videoJob?.trackingStopped === true);
  await assert.rejects(() => resumed.resume(taskId), /不一致|不可读/u);
  assert.equal(posts, 1, `${issue} cannot turn a possibly submitted old task into a second POST`);
  resumed.dispose();
}

// Finished assets remain finished even when their now-unneeded preparation journal is missing or damaged.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  const f = fixture(async () => response({ id: 'finished', status: 'succeeded', url: 'https://cdn.test/done.mp4' }));
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop: f.desktop, onRuntime: () => {} };
  const engine = new VideoGenerationEngine(options); const taskId = await engine.start({ ...draft, references: [] }); engine.dispose();
  assert.ok(taskById(state, taskId).resultAssetId);
  f.desktop.getVideoTaskCheckpoint = async () => { throw new Error('irrelevant old checkpoint is damaged'); };
  const restored = new VideoGenerationEngine(options); restored.reconcile(); await tick();
  assert.equal(taskById(state, taskId).videoJob?.stage, 'succeeded');
  assert.notEqual(taskById(state, taskId).videoJob?.trackingStopped, true);
  restored.dispose();
}

// After an ACK, a journal write failure must not discard the known remote ID or cause another POST.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  let posts = 0; let queries = 0;
  const f = fixture(async (request) => {
    if (request.method === 'POST') { posts += 1; return response({ id: 'known-even-if-disk-fails', status: 'queued' }); }
    queries += 1; return response({ id: 'known-even-if-disk-fails', status: 'failed' });
  });
  const originalSave = f.desktop.saveVideoTaskCheckpoint!;
  f.desktop.saveVideoTaskCheckpoint = async (task) => { if (task.videoJob?.preparation?.phase === 'acknowledged') throw new Error('disk unavailable after remote acknowledgement'); return originalSave(task); };
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop: f.desktop, onRuntime: () => {}, pollIntervalMs: 5 };
  const engine = new VideoGenerationEngine(options); const taskId = await engine.start({ ...draft, references: [] });
  assert.equal(taskById(state, taskId).remoteTaskId, 'known-even-if-disk-fails'); engine.dispose();
  f.desktop.getVideoTaskCheckpoint = async () => { throw new Error('unreadable preparation journal'); };
  const restored = new VideoGenerationEngine(options); restored.reconcile();
  await waitFor(() => queries > 0);
  assert.equal(posts, 1); restored.dispose();
}

// Failure of the primary project save also blocks POST, even if the independent journal is healthy.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  let posts = 0;
  const f = fixture(async () => { posts += 1; return response({}); });
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop: f.desktop, onRuntime: () => {}, persistState: async () => { throw new Error('视频任务记录保存失败'); } });
  const taskId = await engine.start({ ...draft, references: [] });
  assert.equal(posts, 0); assert.equal(taskById(state, taskId).status, 'failed'); engine.dispose();
}

// Imported/stale preparing JSON is not authority to POST when its trusted native journal is absent.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  let persisted: AppState | undefined; let posts = 0; const order: string[] = [];
  const f = fixture(async () => { posts += 1; throw new Error('mock old POST acknowledgement lost'); });
  const save = f.desktop.saveVideoTaskCheckpoint!;
  f.desktop.saveVideoTaskCheckpoint = async (task) => { order.push(`journal:${task.videoJob?.preparation?.phase}`); return save(task); };
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop: f.desktop, onRuntime: () => {}, persistState: async () => { order.push('project'); persisted = structuredClone(state); } };
  const engine = new VideoGenerationEngine(options); const taskId = await engine.start({ ...draft, references: [] }); engine.dispose();
  assert.deepEqual(order.slice(0, 2), ['journal:preparing', 'project'], 'normal creation cannot save a resumable project record before its trusted journal');
  state = normalizeState(JSON.parse(JSON.stringify(persisted))); f.journal.clear(); posts = 0;
  assert.ok(f.credentials.size, 'even an existing scoped credential must not authorize a forged preparing record');
  const restored = new VideoGenerationEngine(options); restored.reconcile();
  await waitFor(() => taskById(state, taskId).videoJob?.trackingStopped === true);
  assert.match(taskById(state, taskId).videoJob!.message!, /缺少可信/u);
  await assert.rejects(() => restored.resume(taskId), /缺少可信/u);
  assert.equal(posts, 0, 'missing native journal cannot be recreated from imported preparing JSON and resubmitted');
  assert.equal(f.journal.size, 0);
  restored.dispose();
}

console.log('video preparation recovery: frozen inline/remote originals, deleted source reuse, durable pre-POST resume, upload checkpoints, stale-save ACK protection, and persistence failure tests passed');

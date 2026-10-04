import assert from 'node:assert/strict';
import { importComfyVideoWorkflow, bindComfyVideoWorkflow, collectComfyVideoOutputs, comfyVideoExecutionStartedAt, mapComfyVideoProgress } from '../src/comfyuiVideo';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { assertNoEmbeddedVideoCredentials, buildVideoApiBody, defaultMiniMaxVideoApi, parseVideoApiResult } from '../src/videoGenerationApi';
import { createInitialState, normalizeState } from '../src/storage';
import type { AppState, VideoGenerationTask } from '../src/types';
import type { GeneratedMediaDownloadRequest, VideoGenerationDraft, ComfyVideoWorkflowPreset, VideoGenerationRuntime, VideoGenerationDesktop } from '../src/videoGenerationTypes';

const workflowNodes = {
  '312': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'ORIGINAL 中文对白：“别走。”' }, _meta: { title: 'Input Text (Prompt)' } },
  '321': { class_type: 'RandomNoise', inputs: { noise_seed: 123456789 } },
  '335': { class_type: 'LoadImage', inputs: { image: 'original.png' } },
  '333': { class_type: 'MiniMaxH3Condition', inputs: { prompt: ['312', 0], image: ['335', 0] } },
  '325': { class_type: 'SamplerCustom', inputs: { noise: ['321', 0], positive: ['333', 0], steps: 30, cfg: 5.5 } },
  '326': { class_type: 'MiniMaxAudioDecoder', inputs: { samples: ['325', 0] } },
  '328': { class_type: 'VHS_VideoCombine', inputs: { images: ['325', 0], audio: ['326', 0], frame_rate: 24, format: 'video/h264-mp4', filename_prefix: 'original-prefix' } },
};
const workflowJson = JSON.stringify(workflowNodes);
const imported = importComfyVideoWorkflow(workflowJson);
const preset: ComfyVideoWorkflowPreset = { id: 'h3', name: 'H3 full audio', ...imported, createdAt: 1, updatedAt: 1 };
assert.equal(imported.workflowJson, workflowJson);
assert.deepEqual(imported.mapping.prompt, [{ nodeId: '312', inputName: 'value' }]);
assert.deepEqual(imported.mapping.images, [{ nodeId: '335', inputName: 'image' }]);
assert.equal(imported.mapping.outputNodeId, '328');
assert.deepEqual(imported.mapping.parameters?.seed, { nodeId: '321', inputName: 'noise_seed' });
const bound = bindComfyVideoWorkflow(preset, '镜头中她说：“不要走。”', ['uploaded.png']);
assert.equal(bound['312'].inputs.value, '镜头中她说：“不要走。”');
assert.equal(bound['335'].inputs.image, 'uploaded.png');
assert.equal(bound['321'].inputs.noise_seed, 123456789);
assert.deepEqual(bound['328'], workflowNodes['328']);
assert.deepEqual(bound['325'], workflowNodes['325']);
assert.equal(JSON.stringify(workflowNodes), workflowJson);
assert.equal(bindComfyVideoWorkflow(preset, 'prompt', [], { seed: 777 })['321'].inputs.noise_seed, 777);
assert.throws(() => bindComfyVideoWorkflow(preset, 'prompt', ['a', 'b']), /不会丢弃图片/u);
assert.throws(() => bindComfyVideoWorkflow(preset, 'prompt', [], { arbitrary: 8 }), /尚未绑定/u);
assert.throws(() => importComfyVideoWorkflow('{"nodes":[],"links":[]}'), /API 格式/u);

const outputs = collectComfyVideoOutputs({ outputs: {
  2: { videos: [{ filename: 'wrong-silent.mp4' }] },
  328: { gifs: [{ filename: 'film.mp4', subfolder: 'clip', type: 'output' }, { filename: 'film-audio.mp4', subfolder: 'clip', type: 'output' }], images: [{ filename: 'preview.png' }] },
} }, 'http://localhost:8188', '328');
assert.equal(outputs.length, 2);
assert.equal(outputs[0].filename, 'film-audio.mp4');
assert.ok(outputs[0].url.includes('filename=film-audio.mp4'));
assert.deepEqual(mapComfyVideoProgress({ type: 'progress', data: { prompt_id: 'other', value: 20, max: 30 } }, 'ours'), null);
assert.equal(mapComfyVideoProgress({ type: 'progress', data: { prompt_id: 'ours', value: 30, max: 30 } }, 'ours')?.stage, 'running');
assert.equal(mapComfyVideoProgress({ type: 'execution_start', data: { prompt_id: 'ours', timestamp: 1_725_000_000_123 } }, 'ours')?.startedAt, 1_725_000_000_123);
assert.equal(comfyVideoExecutionStartedAt({ status: { messages: [
  ['execution_start', { prompt_id: 'other', timestamp: 1_725_000_000_000 }],
  ['execution_start', { prompt_id: 'ours', timestamp: 1_725_000_001_234 }],
] } }, 'ours'), 1_725_000_001_234);
assert.equal(comfyVideoExecutionStartedAt({ status: { messages: [['execution_start', { prompt_id: 'ours', timestamp: 1_725_000_002 }]] } }, 'ours'), 1_725_000_002_000, 'compatible second timestamps normalize to milliseconds');

const draft: VideoGenerationDraft = { name: '中文对白测试', prompt: '中景，她说：“不要走。”脚步轻响，无配乐。', backend: 'api', references: [], parameters: { seed: 42 } };
const config = { enabled: true, endpoint: 'https://old.example.test/generate', statusEndpointTemplate: 'https://old.example.test/tasks/{id}', apiKey: 'private-old-key', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'output.url', provider: 'generic' as const, model: 'original-model', progressPath: 'progress' };
assert.equal(buildVideoApiBody(config, draft, []).prompt, draft.prompt);
assert.equal(buildVideoApiBody(config, draft, []).seed, 42);
const imageDraft: VideoGenerationDraft = { ...draft, references: [{ assetId: 'reference', role: 'first-frame' }] };
assert.equal(buildVideoApiBody(defaultMiniMaxVideoApi, imageDraft, ['data:image/png;base64,AAAA']).first_frame_image, 'data:image/png;base64,AAAA');
assert.equal(buildVideoApiBody(defaultMiniMaxVideoApi, imageDraft, ['image']).prompt_optimizer, false);
assert.throws(() => buildVideoApiBody(defaultMiniMaxVideoApi, { ...imageDraft, references: [{ assetId: 'reference', role: 'composition' }] }, ['image']), /不会把参考图擅自改成首帧/u);
assert.equal(parseVideoApiResult({ status: 'Success', task_id: 'a', file_id: 'file-1', base_resp: { status_code: 0 } }, defaultMiniMaxVideoApi).fileId, 'file-1');
assert.equal(parseVideoApiResult({ status: 'Preparing', task_id: 'a' }, defaultMiniMaxVideoApi).stage, 'queued');
assert.equal(parseVideoApiResult({ status: 'Success', base_resp: { status_code: 1004, status_msg: 'bad key' } }, defaultMiniMaxVideoApi).status, 'failed');
const template = JSON.stringify({ text: '{{prompt}}', photos: '{{images}}', model: '{{model}}', parameters: '{{parameters}}' });
assert.deepEqual(buildVideoApiBody({ ...config, requestTemplate: template }, imageDraft, ['data:image/png;base64,AAAA']).photos, ['data:image/png;base64,AAAA']);
assert.throws(() => buildVideoApiBody({ ...config, requestTemplate: '{"text":"{{prompt}}"}' }, imageDraft, ['data:image/png;base64,AAAA']), /没有包含所有选图/u);
assert.throws(() => assertNoEmbeddedVideoCredentials({ nodes: { inputs: { api_key: 'private-key' } } }, '工作流'), /密钥只能填写/u);
assert.throws(() => assertNoEmbeddedVideoCredentials({ headers: { Authorization: 'Bearer secret' } }, '模板'), /内嵌凭据/u);
assert.doesNotThrow(() => assertNoEmbeddedVideoCredentials({ inputs: { api_key: '' }, prompt: '人物说出“密码”两个字' }, '工作流'));

type Desktop = VideoGenerationDesktop;
type Request = Parameters<Desktop['videoRequest']>[0];
type Progress = Parameters<Parameters<Desktop['onVideoProgress']>[0]>[0];
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (predicate: () => boolean) => {
  for (let count = 0; count < 200; count += 1) { if (predicate()) return; await tick(); }
  assert.fail('targeted mock task did not reach expected state');
};
const managed = { fileName: 'result-audio.mp4', relativePath: 'generated/result-audio.mp4', checksum: 'checksum', sizeBytes: 1024, mediaType: 'video' as const, managed: true, missing: false, url: 'lianhua-media://asset/result-audio.mp4' };
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const job = (state: AppState, taskId: string) => [...state.project.generationTasks, ...state.projects.flatMap((project) => project.generationTasks)].find((item) => item.id === taskId) as VideoGenerationTask;

// Generic API, frozen credentials/config, background project ownership, then download-only retry.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  const ownerId = state.project.id;
  const vault = new Map<string, string>(); const requests: Request[] = []; let downloads = 0;
  let releaseResult = false;
  const desktop = {
    videoRequest: async (payload: Request) => {
      requests.push(payload);
      assert.equal('timeoutMs' in payload, false);
      assert.equal(payload.headers?.Authorization, 'Bearer private-old-key');
      if (payload.method === 'POST') return response({ id: 'remote-api', status: 'queued' });
      assert.equal(payload.method, 'GET', 'desktop bridge defaults to POST, so every polling GET must be explicit');
      assert.ok(payload.url.startsWith('https://old.example.test/'));
      return response(releaseResult ? { id: 'remote-api', status: 'success', output: { url: 'https://cdn.example.test/result.mp4' } } : { id: 'remote-api', status: 'processing', progress: 33 });
    },
    setVideoTaskCredential: async ({ taskId, apiKey }: { taskId: string; apiKey: string }) => { vault.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId: string) => vault.get(taskId) || null,
    downloadGeneratedMedia: async (payload: GeneratedMediaDownloadRequest) => {
      downloads += 1;
      assert.equal(payload.noTimeout, true);
      assert.equal(payload.headers, undefined, 'do not forward API credentials to arbitrary CDN');
      assert.equal(payload.fileName, draft.name, 'the frozen readable task name must reach every initial/retry download');
      if (downloads === 1) throw new Error('disk temporarily unavailable');
      return managed;
    },
  } as unknown as Desktop;
  const runtimes: Record<string, VideoGenerationRuntime> = {};
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop, onRuntime: (taskId: string, runtime: VideoGenerationRuntime) => { runtimes[taskId] = runtime; }, pollIntervalMs: 5 };
  const engine = new VideoGenerationEngine(options);
  const taskId = await engine.start(draft);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(JSON.parse(requests[0].body!).prompt, draft.prompt);
  assert.equal(JSON.stringify(job(state, taskId)).includes('private-old-key'), false);
  await waitFor(() => runtimes[taskId]?.progress === 33);
  assert.ok(job(state, taskId).videoJob?.startedAt, 'the first authoritative API running status starts execution timing');
  const apiStartedAt = job(state, taskId).videoJob!.startedAt;
  await tick(); await tick();
  assert.equal(job(state, taskId).videoJob?.startedAt, apiStartedAt, 'repeated API running polls never reset the execution start');
  engine.dispose();
  state.settings.videoTaskApi = { ...config, endpoint: 'https://new.example.test/generate', statusEndpointTemplate: 'https://new.example.test/status/{id}', apiKey: 'new-key' };
  const other = { ...structuredClone(state.project), id: 'other-project', generationTasks: [], assets: [] };
  state = { ...state, project: other, activeProjectId: other.id, projects: [...state.projects, other] };
  const restored = new VideoGenerationEngine(options); releaseResult = true; restored.reconcile();
  await waitFor(() => Boolean(job(state, taskId).videoJob?.downloadError));
  assert.equal(job(state, taskId).status, 'succeeded');
  assert.equal(job(state, taskId).videoJob?.snapshot.projectId, ownerId);
  await restored.retryDownload(taskId);
  assert.equal(downloads, 2);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(state.project.assets.length, 0);
  assert.ok(state.projects.find((project) => project.id === ownerId)?.assets.some((asset) => asset.sourceVideoTaskId === taskId));
  assert.equal(job(state, taskId).videoJob?.stage, 'succeeded');
  assert.equal(job(state, taskId).videoJob?.startedAt, apiStartedAt, 'restart and completion preserve the original execution start');
  restored.dispose();
}

// New video tasks reserve the same readable/versioned name surface as generated images.
{
  let state = createInitialState();
  state.settings.videoTaskApi = config;
  state.project.assets.push({
    id: 'existing-video', name: draft.name, fileName: `${draft.name}.mp4`, type: 'video', role: 'motion',
    mediaType: 'video', url: 'lianhua-asset://local/video/existing.mp4', tags: [], createdAt: 1, updatedAt: 1,
  });
  const downloads: GeneratedMediaDownloadRequest[] = [];
  const desktop = {
    videoRequest: async () => response({ id: 'readable-name-task', status: 'success', output: { url: 'https://cdn.example.test/opaque-result' } }),
    setVideoTaskCredential: async () => ({ persisted: true }),
    downloadGeneratedMedia: async (payload: GeneratedMediaDownloadRequest) => {
      downloads.push(payload);
      return {
        ...managed,
        fileName: `${payload.fileName}.mp4`,
        relativePath: `video/${payload.fileName}.mp4`,
      };
    },
  } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {} });
  const taskId = await engine.start(draft);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].fileName, `${draft.name} · 第 2 版`);
  assert.equal(job(state, taskId).videoJob?.snapshot.draft.name, `${draft.name} · 第 2 版`);
  const asset = state.project.assets.find((candidate) => candidate.sourceVideoTaskId === taskId);
  assert.equal(asset?.name, `${draft.name} · 第 2 版`);
  assert.equal(asset?.fileName, `${draft.name} · 第 2 版.mp4`);
  assert.equal(asset?.videoSourceTask?.videoJob?.snapshot.draft.name, `${draft.name} · 第 2 版`);
  engine.dispose();
}

// The desktop store sees every project's files and can add a version that the
// project-local task allocator cannot predict. Its final stem must become the
// asset, live-task and embedded provenance name, including after a save retry.
{
  let state = createInitialState();
  state.settings.videoTaskApi = config;
  const downloadNames: string[] = [];
  const requestedName = '跨项目同名视频';
  const storedName = `${requestedName} · 第 2 版`;
  const desktop = {
    videoRequest: async () => response({ id: 'global-name-collision-task', status: 'success', output: { url: 'https://cdn.example.test/global-collision' } }),
    setVideoTaskCredential: async () => ({ persisted: true }),
    downloadGeneratedMedia: async (payload: GeneratedMediaDownloadRequest) => {
      downloadNames.push(payload.fileName || '');
      if (downloadNames.length === 1) throw new Error('首次保存失败');
      return {
        ...managed,
        fileName: `${storedName}.webm`,
        relativePath: `video/${storedName}.webm`,
        url: `lianhua-asset://local/video/${encodeURIComponent(storedName)}.webm`,
      };
    },
  } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {} });
  const taskId = await engine.start({ ...draft, name: requestedName });
  assert.equal(job(state, taskId).videoJob?.downloadError, '首次保存失败');
  await engine.retryDownload(taskId);

  assert.deepEqual(downloadNames, [requestedName, requestedName], '保存重试使用同一个冻结任务名，不另行预留版本');
  const completedTask = job(state, taskId);
  const asset = state.project.assets.find((candidate) => candidate.sourceVideoTaskId === taskId);
  assert.equal(asset?.name, storedName);
  assert.equal(asset?.fileName, `${storedName}.webm`);
  assert.equal(asset?.relativePath, `video/${storedName}.webm`);
  assert.equal(completedTask.videoJob?.snapshot.draft.name, storedName);
  assert.equal(asset?.videoSourceTask?.videoJob?.snapshot.draft.name, storedName);
  engine.dispose();
}

// Two starts can both await inline-image persistence before either task is inserted.
// Their readable names must still reserve distinct versions.
{
  let state = createInitialState();
  state.settings.videoExecutionMode = 'concurrent';
  state.settings.videoExecutionConcurrency = 2;
  state.settings.videoTaskApi = config;
  state.project.assets.push({
    id: 'inline-reference', name: '内嵌参考图', type: 'reference', role: 'composition', referenceRole: 'composition',
    dataUrl: 'data:image/png;base64,AAAA', tags: [], createdAt: 1, updatedAt: 1,
  });
  let blockedStores = 0;
  let releaseStores!: () => void;
  let bothStoresStarted!: () => void;
  const storeRelease = new Promise<void>((resolve) => { releaseStores = resolve; });
  const storesStarted = new Promise<void>((resolve) => { bothStoresStarted = resolve; });
  const downloadNames: string[] = [];
  const desktop = {
    storeGeneratedImage: async ({ fileName }: { dataUrl: string; fileName?: string }) => {
      blockedStores += 1;
      if (blockedStores <= 2) {
        if (blockedStores === 2) bothStoresStarted();
        await storeRelease;
      }
      return {
        fileName: fileName || 'reference.png', relativePath: 'image/frozen-reference.png', checksum: 'frozen-reference',
        sizeBytes: 4, mediaType: 'image' as const, managed: true, missing: false, url: 'lianhua-asset://local/image/frozen-reference.png',
      };
    },
    readManagedImageDataUrl: async () => ({ dataUrl: 'data:image/png;base64,AAAA' }),
    videoRequest: async () => response({ id: `parallel-${Math.random()}`, status: 'success', output: { url: 'https://cdn.example.test/parallel.mp4' } }),
    setVideoTaskCredential: async () => ({ persisted: true }),
    downloadGeneratedMedia: async (payload: GeneratedMediaDownloadRequest) => {
      downloadNames.push(payload.fileName || '');
      return { ...managed, fileName: `${payload.fileName}.mp4`, relativePath: `video/${payload.fileName}.mp4` };
    },
  } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {} });
  const concurrentDraft: VideoGenerationDraft = {
    ...draft,
    name: '并发视频',
    references: [{ assetId: 'inline-reference', role: 'composition' }],
  };
  const first = engine.start(concurrentDraft);
  const second = engine.start(concurrentDraft);
  await storesStarted;
  releaseStores();
  await Promise.all([first, second]);
  assert.deepEqual([...downloadNames].sort(), ['并发视频', '并发视频 · 第 2 版'].sort());
  engine.dispose();
}

// A lost acknowledgement is unknown, not a retry opportunity, including after state migration.
// MiniMax's completed file_id requires a second explicit GET to retrieve the download URL.
{
  let state = createInitialState(); state.settings.videoTaskApi = { ...defaultMiniMaxVideoApi, apiKey: 'minimax-key' };
  const requests: Request[] = [];
  const desktop = { videoRequest: async (request: Request) => {
    requests.push(request);
    if (request.url.endsWith('/video_generation')) { assert.equal(request.method, 'POST'); return response({ task_id: 'minimax-task', status: 'Preparing' }); }
    assert.equal(request.method, 'GET', 'MiniMax query and file retrieval must explicitly be GET on desktop');
    if (request.url.includes('/query/video_generation?')) return response({ task_id: 'minimax-task', status: 'Success', file_id: 'minimax-file' });
    if (request.url.includes('/files/retrieve?')) return response({ file: { download_url: 'https://cdn.example.test/minimax.mp4' } });
    throw new Error(`unexpected MiniMax URL ${request.url}`);
  }, downloadGeneratedMedia: async () => managed } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 });
  const taskId = await engine.start(draft);
  await waitFor(() => Boolean(job(state, taskId).resultAssetId));
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  assert.ok(requests.some((request) => request.url.includes('/files/retrieve?file_id=minimax-file')));
  engine.dispose();
}

// Success+file_id on the initial submit must download even without a remote task ID or polling URL.
{
  let state = createInitialState(); state.settings.videoTaskApi = { ...defaultMiniMaxVideoApi, apiKey: 'minimax-key', statusEndpointTemplate: '' };
  let posts = 0; let fileGets = 0;
  const desktop = { videoRequest: async (request: Request) => {
    if (request.method === 'POST') { posts += 1; return response({ status: 'Success', file_id: 'instant-file', base_resp: { status_code: 0 } }); }
    assert.equal(request.method, 'GET');
    assert.ok(request.url.includes('/files/retrieve?file_id=instant-file'));
    fileGets += 1;
    return response({ file: { download_url: 'https://cdn.example.test/instant.mp4' } });
  }, downloadGeneratedMedia: async () => managed } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 });
  const taskId = await engine.start(draft);
  await waitFor(() => Boolean(job(state, taskId).resultAssetId));
  assert.equal(posts, 1); assert.equal(fileGets, 1);
  assert.equal(job(state, taskId).videoJob?.stage, 'succeeded');
  engine.dispose();
}

// A lost acknowledgement is unknown, not a retry opportunity, including after state migration.
{
  let state = createInitialState(); state.settings.videoTaskApi = config; let calls = 0;
  const desktop = { videoRequest: async () => { calls += 1; throw new Error('connection reset after upload'); } } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 });
  const taskId = await engine.start(draft);
  assert.equal(job(state, taskId).status, 'unknown');
  assert.equal(job(state, taskId).videoJob?.stage, 'submission-unknown');
  engine.reconcile(); await tick(); await tick();
  assert.equal(calls, 1);
  await assert.rejects(() => engine.resume(taskId), /不能安全恢复/u);
  const stored = JSON.parse(JSON.stringify(state));
  stored.project.generationTasks[0].status = 'submitting';
  stored.projects[0].generationTasks[0].status = 'submitting';
  const normalized = normalizeState(stored);
  assert.equal(job(normalized, taskId).status, 'unknown');
  assert.equal(job(normalized, taskId).videoJob?.snapshot.draft.prompt, draft.prompt);
  engine.dispose();
}

// ComfyUI upload uses real pixels; final audio video is discovered through gifs; no seed or edge changes.
{
  let state = createInitialState();
  state.settings.comfyuiVideo = { enabled: true, baseUrl: 'http://comfy.example.test:8188', apiKey: '', workflows: [preset], activeWorkflowId: preset.id };
  state.project.assets.push({ id: 'ref', name: '角色构图', type: 'reference', role: 'composition', referenceRole: 'composition', url: 'https://images.example.test/ref.png', tags: [], createdAt: 1, updatedAt: 1 });
  let progressListener: ((event: Progress) => void) | undefined; let completed = false; let running = false; let exactHistoryStartedAt = 0; let wsUrl = ''; let wsWatchId = ''; const requests: Request[] = [];
  const desktop = {
    onVideoProgress: (callback: (event: Progress) => void) => { progressListener = callback; return () => { progressListener = undefined; }; },
    watchVideoProgress: async (payload: { url: string; watchId: string }) => { wsUrl = payload.url; wsWatchId = payload.watchId; }, unwatchVideoProgress: async () => true,
    videoRequest: async (payload: Request) => {
      requests.push(payload);
      assert.ok(payload.method, 'no request may accidentally inherit the desktop bridge POST default');
      if (payload.url === 'https://images.example.test/ref.png') { assert.equal(payload.method, 'GET'); return { status: 200, body: 'AAAA', bodyEncoding: 'base64', contentType: 'image/png' }; }
      if (payload.url.endsWith('/upload/image')) { assert.equal(payload.multipart?.files[0].dataUrl, 'data:image/png;base64,AAAA'); return response({ name: 'uploaded-reference.png', subfolder: 'uploads' }); }
      if (payload.url.endsWith('/prompt')) return response({ prompt_id: 'our-comfy-id' });
      assert.equal(payload.method, 'GET', 'Comfy history and queue use GET');
      if (payload.url.includes('/history/')) return response(completed ? { 'our-comfy-id': { status: { completed: true, status_str: 'success', messages: [['execution_start', { prompt_id: 'our-comfy-id', timestamp: exactHistoryStartedAt }]] }, outputs: { 328: { gifs: [{ filename: 'render-audio.mp4', type: 'output' }] } } } } : {});
      if (payload.url.endsWith('/queue')) return response(running
        ? { queue_pending: [], queue_running: [[0, 'our-comfy-id']] }
        : { queue_pending: [[0, 'our-comfy-id']], queue_running: [] });
      throw new Error(`unexpected request ${payload.url}`);
    },
    downloadGeneratedMedia: async () => managed,
  } as unknown as Desktop;
  const runtimes: Record<string, VideoGenerationRuntime> = {};
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: (taskId, runtime) => { runtimes[taskId] = runtime; }, pollIntervalMs: 5 });
  const taskId = await engine.start({ ...draft, backend: 'comfyui', workflowId: preset.id, references: [{ assetId: 'ref', role: 'composition' }], parameters: {} });
  const post = JSON.parse(requests.find((request) => request.url.endsWith('/prompt'))!.body!);
  assert.equal(post.prompt['312'].inputs.value, draft.prompt);
  assert.equal(post.prompt['335'].inputs.image, 'uploads/uploaded-reference.png');
  assert.equal(post.prompt['321'].inputs.noise_seed, 123456789);
  assert.deepEqual(post.prompt['328'], workflowNodes['328']);
  assert.equal(new URL(wsUrl).searchParams.get('clientId'), post.client_id);
  assert.ok(wsWatchId && wsWatchId !== taskId, 'each live progress registration uses a distinct, non-persisted lease ID');
  await waitFor(() => runtimes[taskId]?.stage === 'queued');
  assert.equal(job(state, taskId).videoJob?.startedAt, undefined, 'ComfyUI queue acknowledgement does not start execution timing');
  await tick(); await tick(); await tick();
  assert.equal(job(state, taskId).videoJob?.startedAt, undefined, 'time spent in queue remains excluded');
  running = true;
  await waitFor(() => Boolean(job(state, taskId).videoJob?.startedAt));
  const queueObservedStartedAt = job(state, taskId).videoJob!.startedAt;
  progressListener?.({ watchId: wsWatchId, type: 'message', data: { type: 'execution_start', data: { prompt_id: 'our-comfy-id', timestamp: queueObservedStartedAt! + 10_000 } } });
  progressListener?.({ watchId: wsWatchId, type: 'message', data: { type: 'progress', data: { prompt_id: 'our-comfy-id', value: 18, max: 30 } } });
  assert.equal(runtimes[taskId].step, 18);
  assert.equal(runtimes[taskId].progress, undefined);
  assert.ok(runtimes[taskId].startedAt);
  assert.equal(runtimes[taskId].startedAt, queueObservedStartedAt, 'later duplicate running events never reset the first execution start');
  exactHistoryStartedAt = queueObservedStartedAt! - 1_000;
  completed = true;
  await waitFor(() => Boolean(job(state, taskId).resultAssetId));
  assert.equal(job(state, taskId).videoJob?.startedAt, exactHistoryStartedAt, 'ComfyUI history refines a queue observation to the true earlier execution_start');
  assert.ok(job(state, taskId).resultUrl?.includes('render-audio.mp4'));
  assert.equal(requests.filter((request) => request.url.endsWith('/prompt')).length, 1);
  assert.equal(state.settings.comfyuiVideo.workflows[0].workflowJson, workflowJson);
  state.settings.comfyuiVideo.workflows[0] = { ...preset, workflowJson: workflowJson.replace('123456789', '999'), updatedAt: 99 };
  await engine.start({ ...draft, backend: 'comfyui', workflowId: preset.id, references: [{ assetId: 'ref', role: 'composition' }], parameters: {}, reuseTaskId: taskId });
  const rerunPost = JSON.parse(requests.filter((request) => request.url.endsWith('/prompt'))[1].body!);
  assert.equal(rerunPost.prompt['321'].inputs.noise_seed, 123456789, 'same-settings rerun must use frozen original workflow even after preset edits');
  engine.dispose();
}

// Independent ComfyUI tasks remain untimed while pending and begin only when
// that exact remote ID enters queue_running, including sequential execution.
{
  let state = createInitialState();
  state.settings.videoExecutionMode = 'concurrent';
  state.settings.videoExecutionConcurrency = 2;
  state.settings.comfyuiVideo = { enabled: true, baseUrl: 'http://queue-order.example.test', apiKey: '', workflows: [preset], activeWorkflowId: preset.id };
  const submittedIds: string[] = [];
  let activeId = '';
  const desktop = { videoRequest: async (request: Request) => {
    if (request.url.endsWith('/prompt')) {
      const remoteTaskId = `ordered-${submittedIds.length + 1}`;
      submittedIds.push(remoteTaskId);
      return response({ prompt_id: remoteTaskId });
    }
    if (request.url.includes('/history/')) return response({});
    if (request.url.endsWith('/queue')) return response({
      queue_running: activeId ? [[0, activeId]] : [],
      queue_pending: submittedIds.filter((remoteTaskId) => remoteTaskId !== activeId).map((remoteTaskId, index) => [index + 1, remoteTaskId]),
    });
    throw new Error(`unexpected request ${request.url}`);
  } } as unknown as Desktop;
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 };
  const engine = new VideoGenerationEngine(options);
  const firstId = await engine.start({ ...draft, name: '顺序任务 A', backend: 'comfyui', workflowId: preset.id, parameters: {} });
  const secondId = await engine.start({ ...draft, name: '顺序任务 B', backend: 'comfyui', workflowId: preset.id, parameters: {} });
  await waitFor(() => job(state, firstId).videoJob?.stage === 'queued' && job(state, secondId).videoJob?.stage === 'queued');
  assert.equal(job(state, firstId).videoJob?.startedAt, undefined);
  assert.equal(job(state, secondId).videoJob?.startedAt, undefined);
  activeId = 'ordered-1';
  await waitFor(() => Boolean(job(state, firstId).videoJob?.startedAt));
  const firstStartedAt = job(state, firstId).videoJob!.startedAt;
  assert.equal(job(state, secondId).videoJob?.startedAt, undefined, 'a task waiting behind another task remains untimed');
  await tick(); await tick();
  engine.dispose();
  activeId = 'ordered-2';
  const restoredEngine = new VideoGenerationEngine(options);
  restoredEngine.reconcile();
  await waitFor(() => Boolean(job(state, secondId).videoJob?.startedAt));
  assert.equal(job(state, firstId).videoJob?.startedAt, firstStartedAt, 'restart and a later task starting cannot reset the earlier task clock');
  assert.ok(job(state, secondId).videoJob!.startedAt! >= firstStartedAt!, 'each sequential task receives its own execution start');
  assert.equal(submittedIds.length, 2, 'queue polling never resubmits either task');
  restoredEngine.dispose();
}

// Authentication failures stop polling. Explicit resume may correct a key only at the exact old endpoint.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  const requests: Request[] = []; let authenticated = false;
  const desktop = { videoRequest: async (request: Request) => {
    requests.push(request);
    if (request.method === 'POST') return response({ id: 'auth-task', status: 'queued' });
    if (!authenticated) return { status: 401, body: '{}' };
    assert.equal(request.headers?.Authorization, 'Bearer fixed-key');
    return response({ id: 'auth-task', status: 'processing' });
  } } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 });
  const taskId = await engine.start(draft);
  await waitFor(() => job(state, taskId).videoJob?.trackingStopped === true);
  const count = requests.length; engine.reconcile(); await tick(); await tick(); assert.equal(requests.length, count);
  state.settings.videoTaskApi = { ...config, apiKey: 'fixed-key' }; authenticated = true;
  await engine.resume(taskId); await waitFor(() => requests.length > count);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  engine.dispose();
}

// Comfy acknowledgement loss can be recovered by the unique client ID without a second POST.
{
  let state = createInitialState(); state.settings.comfyuiVideo = { enabled: true, baseUrl: 'http://comfy.test', apiKey: '', workflows: [preset], activeWorkflowId: preset.id };
  let clientId = ''; let posts = 0; let recoveryQueries = 0; let connectionRecovered = false;
  const desktop = { videoRequest: async (request: Request) => {
    if (request.method === 'POST') { posts += 1; clientId = JSON.parse(request.body!).client_id; throw new Error('ack lost'); }
    if (request.url.endsWith('/queue')) {
      assert.equal(request.method, 'GET');
      recoveryQueries += 1;
      if (!connectionRecovered) throw new Error('network still disconnected during initial acknowledgement check');
      return response({ queue_pending: [[1, 'recovered-id', {}, { client_id: clientId }]], queue_running: [] });
    }
    return response({});
  } } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 });
  const taskId = await engine.start({ ...draft, backend: 'comfyui', workflowId: preset.id, parameters: {} });
  assert.equal(job(state, taskId).videoJob?.stage, 'submission-unknown');
  engine.reconcile(); await waitFor(() => recoveryQueries > 0);
  connectionRecovered = true;
  // No user resume or additional state/reconcile call: reconnect must autonomously recheck the original client ID.
  await waitFor(() => job(state, taskId).remoteTaskId === 'recovered-id');
  assert.ok(recoveryQueries >= 2);
  assert.equal(posts, 1);
  engine.dispose();
}

// Running ComfyUI cancellation is local only, never global /interrupt or a false confirmed server stop.
{
  let state = createInitialState();
  state.settings.comfyuiVideo = { enabled: true, baseUrl: 'http://comfy.test', apiKey: '', workflows: [preset], activeWorkflowId: preset.id };
  const urls: string[] = [];
  const desktop = { videoRequest: async (request: Request) => { urls.push(request.url); return response(request.url.endsWith('/prompt') ? { prompt_id: 'running-id' } : request.url.endsWith('/queue') ? { queue_running: [[1, 'running-id']], queue_pending: [] } : {}); }, unwatchVideoProgress: async () => true, cancelVideoRequest: async () => true } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 });
  const taskId = await engine.start({ ...draft, backend: 'comfyui', workflowId: preset.id, parameters: {} });
  await engine.cancel(taskId);
  assert.equal(job(state, taskId).videoJob?.trackingStopped, true);
  assert.match(job(state, taskId).videoJob!.message!, /未确认取消服务器任务/u);
  assert.equal(urls.some((url) => url.includes('/interrupt')), false);
  await tick(); // allow the independent directed-cancellation check to finish
  const count = urls.length; engine.reconcile(); await tick(); await tick(); assert.equal(urls.length, count);
  engine.dispose();
}

// Pre-upgrade completed videos can still be saved; current provider keys are never attached.
// A tampered project cannot borrow another task's encrypted or in-memory credential just by reusing its ID.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  const vault = new Map<string, string>(); const sent: Request[] = [];
  const desktop = {
    setVideoTaskCredential: async ({ taskId, apiKey }: { taskId: string; apiKey: string }) => { if (apiKey) vault.set(taskId, apiKey); else vault.delete(taskId); return { persisted: true }; },
    getVideoTaskCredential: async (taskId: string) => vault.get(taskId) || null,
    videoRequest: async (request: Request) => {
      sent.push(request);
      if (request.method === 'POST') return response({ id: 'scope-protected-task', status: 'queued' });
      return { status: 401, body: '{}' };
    },
  } as unknown as Desktop;
  const options = { getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 };
  let engine = new VideoGenerationEngine(options);
  const taskId = await engine.start(draft);
  const original = structuredClone(job(state, taskId));
  assert.equal(vault.has(taskId), false, 'vault cannot be keyed solely by importable task ID');
  assert.match([...vault.keys()][0], /^video-task-scope-[a-f0-9]{64}$/u);
  let firstTamper = true;
  for (const [field, altered] of [
    ['statusEndpointTemplate', 'https://attacker.example.test/status/{id}'],
    ['imageUploadEndpoint', 'https://attacker.example.test/upload'],
    ['cancelEndpointTemplate', 'https://attacker.example.test/cancel/{id}'],
  ]) {
    const forged = structuredClone(original);
    Object.assign(forged.videoJob!.snapshot.connection.api!, { [field]: altered });
    state.project = { ...state.project, generationTasks: [forged] }; state.projects = [state.project];
    const before = sent.length;
    if (!firstTamper) engine = new VideoGenerationEngine(options);
    firstTamper = false;
    engine.reconcile();
    await waitFor(() => job(state, taskId).videoJob?.trackingStopped === true);
    assert.ok(sent.length > before);
    assert.equal(sent[before].headers?.Authorization, undefined, `${field} mutation must invalidate the saved credential scope`);
    // Even manual Resume must not copy a current key merely because the POST endpoint stayed unchanged.
    await engine.resume(taskId);
    await waitFor(() => sent.length > before + 1);
    assert.equal(sent[before + 1].headers?.Authorization, undefined);
    assert.equal(vault.size, 1);
    engine.dispose();
  }
}

// Removing the owning project aborts local requests and WS subscriptions without cancelling any global server job.
{
  let state = createInitialState(); state.settings.comfyuiVideo = { enabled: true, baseUrl: 'http://comfy.test', apiKey: '', workflows: [preset], activeWorkflowId: preset.id };
  const pendingRequests = new Map<string, (reason: unknown) => void>(); const cancelled: string[] = []; const unwatched: string[] = []; const urls: string[] = [];
  let watchId = '';
  const desktop = {
    videoRequest: async (request: Request) => {
      urls.push(request.url);
      if (request.method === 'POST') return response({ prompt_id: 'project-owned-remote' });
      return new Promise((_resolve, reject) => { pendingRequests.set(request.requestId, reject); });
    },
    watchVideoProgress: async (payload: { watchId: string }) => { watchId = payload.watchId; }, onVideoProgress: () => () => {},
    unwatchVideoProgress: async (taskId: string) => { unwatched.push(taskId); return true; },
    cancelVideoRequest: async (requestId: string) => { cancelled.push(requestId); pendingRequests.get(requestId)?.(new Error('local request cancelled')); pendingRequests.delete(requestId); return true; },
  } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 });
  const taskId = await engine.start({ ...draft, backend: 'comfyui', workflowId: preset.id, parameters: {} });
  await waitFor(() => pendingRequests.size > 0);
  const replacement = { ...createInitialState().project, id: 'remaining-project', generationTasks: [] };
  state = { ...state, project: replacement, projects: [replacement], activeProjectId: replacement.id };
  engine.reconcile(); await waitFor(() => pendingRequests.size === 0);
  assert.ok(watchId && watchId !== taskId && unwatched.includes(watchId)); assert.ok(cancelled.length > 0);
  const count = urls.length; await tick(); await tick(); assert.equal(urls.length, count);
  assert.equal(urls.some((url) => url.includes('/interrupt')), false);
  engine.dispose();
}

// Embedded connection secrets are rejected before creating a task or making any network request.
{
  let state = createInitialState(); state.settings.videoTaskApi = { ...config, requestTemplate: '{"prompt":"{{prompt}}","api_key":"do-not-persist"}' };
  let calls = 0;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop: { videoRequest: async () => { calls += 1; return response({}); } } as unknown as Desktop, onRuntime: () => {} });
  await assert.rejects(() => engine.start(draft), /密钥只能填写/u);
  assert.equal(state.project.generationTasks.length, 0); assert.equal(calls, 0);
  engine.dispose();
}

// A ComfyUI task that is still in queue_pending can be cancelled and removed
// without issuing the global /interrupt command.  The task-center relies on
// this directed queue deletion when the user chooses “取消并删除任务”.
{
  let state = createInitialState();
  state.settings.comfyuiVideo = { enabled: true, baseUrl: 'http://comfy.test', apiKey: '', workflows: [preset], activeWorkflowId: preset.id };
  const queueCalls: string[] = [];
  const desktop = {
    videoRequest: async (request: Request) => {
      if (request.method === 'POST' && request.url.endsWith('/prompt')) return response({ prompt_id: 'queued-id' });
      if (request.url.endsWith('/queue')) {
        queueCalls.push(`${request.method}:${request.body || ''}`);
        if (request.method === 'POST') return response({});
        // The first read exposes the task in ComfyUI's pending queue; after
        // the directed delete, the verification read must be empty.
        return response(queueCalls.filter((entry) => entry.startsWith('POST:')).length
          ? { queue_pending: [], queue_running: [] }
          : { queue_pending: [[1, 'queued-id', {}, {}]], queue_running: [] });
      }
      if (request.url.includes('/history/')) return response({});
      return response({});
    },
    unwatchVideoProgress: async () => true,
    cancelVideoRequest: async () => true,
  } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 60_000 });
  const taskId = await engine.start({ ...draft, backend: 'comfyui', workflowId: preset.id, parameters: {} });
  await waitFor(() => job(state, taskId).remoteTaskId === 'queued-id');
  await engine.cancel(taskId);
  // Removing the local card immediately must not cause reconcile() to abort
  // the in-flight directed cancellation request.
  state.project = { ...state.project, generationTasks: state.project.generationTasks.filter((task) => task.id !== taskId) };
  state.projects = [state.project];
  engine.reconcile();
  await tick(); await tick();
  assert.ok(queueCalls.some((entry) => entry.startsWith('POST:') && entry.includes('queued-id')), 'queued ComfyUI task cancellation must delete only its own queue ID');
  assert.equal(queueCalls.some((entry) => entry.includes('/interrupt')), false);
  assert.equal(job(state, taskId), undefined, 'the local task record can be removed after the queued remote ID is directed to cancellation');
  engine.dispose();
}

// Pre-upgrade completed videos can still be saved; current provider keys are never attached.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  state.project.generationTasks = [{ id: 'legacy-result', kind: 'video', storyboardId: 'old-board', targetId: 'old-model', status: 'succeeded', requestBody: { prompt: 'old prompt' }, resultUrl: 'https://old-cdn.example.test/result.mp4', createdAt: 1, updatedAt: 2 }];
  let downloads = 0;
  const desktop = { downloadGeneratedMedia: async (request: { headers?: unknown }) => { assert.equal(request.headers, undefined); downloads += 1; return managed; } } as unknown as Desktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {} });
  await engine.retryDownload('legacy-result');
  assert.equal(downloads, 1);
  assert.ok(job(state, 'legacy-result').resultAssetId);
  assert.equal(job(state, 'legacy-result').videoJob?.legacyMetadataIncomplete, true);
  assert.equal(job(state, 'legacy-result').videoJob?.snapshot.connection.api?.endpoint, '');
  engine.dispose();
}

const deferredValue = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
type WatchPayload = Parameters<Desktop['watchVideoProgress']>[0];
const progressLeaseFixture = (handlers: { credential?: () => Promise<string | null>; watch?: (payload: WatchPayload) => Promise<void> } = {}) => {
  let state = createInitialState();
  const original: VideoGenerationTask = {
    id: 'lease-task', kind: 'video', storyboardId: '', targetId: 'comfy-fixture', status: 'submitted', remoteTaskId: 'lease-remote',
    requestBody: {}, createdAt: 1, updatedAt: 1,
    videoJob: { stage: 'queued', snapshot: { projectId: state.project.id, clientId: 'lease-client',
      draft: { ...draft, backend: 'comfyui', workflowId: preset.id }, images: [],
      connection: { backend: 'comfyui', comfyui: { enabled: true, baseUrl: 'http://old-comfy.example.test' }, workflow: preset },
    } },
  };
  state.project.generationTasks = [original];
  state.projects = [state.project];
  const watched: WatchPayload[] = [], unwatched: string[] = [], requests: Request[] = [];
  const runtimes: Record<string, VideoGenerationRuntime> = {};
  let credentialReads = 0;
  let listener: ((event: Progress) => void) | undefined;
  const desktop: Desktop = {
    getVideoTaskCredential: async () => { credentialReads += 1; return handlers.credential ? handlers.credential() : null; },
    onVideoProgress: (callback) => { listener = callback; return () => { listener = undefined; }; },
    watchVideoProgress: async (payload) => { watched.push(payload); await handlers.watch?.(payload); },
    unwatchVideoProgress: async (watchId) => { unwatched.push(watchId); return true; },
    videoRequest: async (payload) => { requests.push(payload); return response({ queue_running: [], queue_pending: [] }); },
    cancelVideoRequest: async () => true,
    setVideoTaskCredential: async () => ({ persisted: true }),
    downloadGeneratedMedia: async () => managed,
    readManagedImageDataUrl: async () => ({ dataUrl: 'data:image/png;base64,AAAA' }),
  };
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (updater) => { state = updater(state); }, desktop,
    onRuntime: (taskId, runtime) => { runtimes[taskId] = runtime; }, pollIntervalMs: 60_000 });
  const replaceTask = (replacement?: VideoGenerationTask) => {
    const project = { ...state.project, generationTasks: replacement ? [replacement] : [] };
    state = { ...state, project, projects: [project] };
  };
  return { engine, original, watched, unwatched, requests, runtimes, replaceTask,
    get task() { return state.project.generationTasks[0] as VideoGenerationTask; },
    get credentialReads() { return credentialReads; },
    dispatch: (watchId: string, value: number) => listener?.({ watchId, type: 'message', data: { type: 'progress', data: { prompt_id: 'lease-remote', value, max: 30 } } }),
    disconnect: (watchId: string) => listener?.({ watchId, type: 'disconnected' }),
  };
};

// Credential retrieval is asynchronous: cancellation, disposal, completion or removal must prevent a late IPC watch.
for (const action of ['cancel', 'dispose', 'complete', 'remove']) {
  const gate = deferredValue<string | null>();
  const fixture = progressLeaseFixture({ credential: () => gate.promise });
  fixture.engine.reconcile();
  await waitFor(() => fixture.credentialReads > 0);
  if (action === 'cancel') await fixture.engine.cancel(fixture.original.id);
  else if (action === 'dispose') fixture.engine.dispose();
  else {
    fixture.replaceTask(action === 'remove' ? undefined : { ...fixture.task, status: 'succeeded', resultAssetId: 'saved-result', videoJob: { ...fixture.task.videoJob!, stage: 'succeeded' } });
    fixture.engine.reconcile();
  }
  gate.resolve('original-task-key');
  await tick(); await tick();
  assert.equal(fixture.watched.length, 0, `${action} during credential wait prevents late watch dispatch`);
  assert.equal(fixture.requests.some((request) => request.method === 'POST'), false, 'progress lifecycle never resubmits generation');
  fixture.engine.dispose();
}

// Replacing the task while the old key is pending cannot send that old credential to a new connection.
{
  const oldKey = deferredValue<string | null>();
  let reads = 0;
  const fixture = progressLeaseFixture({ credential: () => ++reads === 1 ? oldKey.promise : Promise.resolve('new-task-key') });
  fixture.engine.reconcile();
  await waitFor(() => fixture.credentialReads === 1);
  fixture.replaceTask({ ...fixture.original, createdAt: 2, videoJob: { ...fixture.original.videoJob!, snapshot: {
    ...fixture.original.videoJob!.snapshot, clientId: 'replacement-client', connection: { ...fixture.original.videoJob!.snapshot.connection,
      comfyui: { enabled: true, baseUrl: 'http://new-comfy.example.test' } },
  } } });
  fixture.engine.reconcile();
  await waitFor(() => fixture.watched.length === 1);
  assert.match(fixture.watched[0].url, /new-comfy\.example\.test/u);
  assert.equal(fixture.watched[0].headers?.Authorization, 'Bearer new-task-key');
  oldKey.resolve('old-task-key');
  await tick(); await tick();
  assert.equal(fixture.watched.length, 1, 'late old credentials cannot recreate the obsolete registration');
  fixture.engine.dispose();
}

// Late completion/rejection and events from an old same-task subscription cannot alter its replacement.
for (const outcome of ['resolve', 'reject']) {
  const oldRegistration = deferredValue<void>();
  let registrations = 0;
  const fixture = progressLeaseFixture({ watch: () => ++registrations === 1 ? oldRegistration.promise : Promise.resolve() });
  fixture.engine.reconcile();
  await waitFor(() => fixture.watched.length === 1);
  const oldId = fixture.watched[0].watchId;
  fixture.replaceTask({ ...fixture.original, createdAt: 2, videoJob: { ...fixture.original.videoJob!, snapshot: { ...fixture.original.videoJob!.snapshot, clientId: 'new-owner-client' } } });
  fixture.engine.reconcile();
  await waitFor(() => fixture.watched.length === 2);
  const newId = fixture.watched[1].watchId;
  assert.notEqual(oldId, newId);
  assert.ok(fixture.unwatched.includes(oldId));
  fixture.dispatch(newId, 7);
  fixture.dispatch(oldId, 29);
  fixture.disconnect(oldId);
  assert.equal(fixture.runtimes[fixture.original.id].step, 7, 'old matching prompt_id is still rejected by the subscription lease');
  assert.equal(fixture.runtimes[fixture.original.id].stage, 'running');
  if (outcome === 'resolve') oldRegistration.resolve(); else oldRegistration.reject(new Error('old IPC rejected'));
  await tick(); await tick();
  assert.equal(fixture.unwatched.includes(newId), false, 'old IPC cleanup cannot unwatch the replacement');
  fixture.dispatch(newId, 8);
  assert.equal(fixture.runtimes[fixture.original.id].step, 8);
  await fixture.engine.cancel(fixture.original.id);
  fixture.dispatch(newId, 30);
  assert.equal(fixture.runtimes[fixture.original.id].stage, 'stopped');
  assert.ok(fixture.unwatched.includes(newId));
  assert.equal(fixture.requests.some((request) => request.method === 'POST'), false);
  fixture.engine.dispose();
}

for (const status of ['succeeded', 'failed'] as const) {
  const fixture = progressLeaseFixture();
  fixture.engine.reconcile();
  await waitFor(() => fixture.watched.length === 1);
  const watchId = fixture.watched[0].watchId;
  fixture.replaceTask({ ...fixture.task, status, videoJob: { ...fixture.task.videoJob!, stage: status } });
  fixture.disconnect(watchId);
  fixture.dispatch(watchId, 30);
  assert.equal(fixture.task.status, status, 'late progress cannot revive a terminal task');
  assert.equal(fixture.runtimes[fixture.original.id], undefined);
  assert.ok(fixture.unwatched.includes(watchId));
  fixture.engine.dispose();
}

console.log('video generation targeted tests passed: immutable H3/audio outputs, API mappings, references, progress ownership/leases, cross-project restore, download-only retry, no duplicate POST, safe cancel and legacy download');

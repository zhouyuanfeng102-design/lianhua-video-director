import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildLaoliVideoApiBody, decodeVideoBinaryBody, fetchGenericVideoModels, genericVideoApiBaseUrl, genericVideoApiEndpoints, isLaoliVideoBuiltinProtocol, parseGenericVideoModelIds, uploadLaoliVideoImage } from '../src/genericVideoApi';
import { buildVideoApiBody, parseVideoApiResult, videoApiSubmitEndpoint } from '../src/videoGenerationApi';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { createInitialState, normalizeState } from '../src/storage';
import type { AppState, ReferenceRole, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { GeneratedMediaDownloadRequest, VideoDesktopRequest, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const samples = JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8'));
const png = `data:image/png;base64,${samples.png}`;
const bytes = Buffer.from(samples.png, 'base64');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const config: VideoTaskApiConfig = { ...createInitialState().settings.videoTaskApi, enabled: true, provider: 'generic', baseUrl: 'https://video.laoliimage2.win', model: '原生不卡人脸-全参2.0', apiKey: 'mock-video-token' };
const draft: VideoGenerationDraft = { name: '通用视频测试', backend: 'api', prompt: '原提示词，角色说：“请保留这句话。”', references: [], parameters: { duration: 5, resolution: '720p', aspect_ratio: '16:9' } };
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const source = 'https://accept-auth.laoliimage2.win/v1/media/assets/upload-1?signature=mock-signed-source';

// Root, versioned and full standard-operation addresses all avoid duplicate /v1.
for (const baseUrl of ['https://video.laoliimage2.win', 'https://video.laoliimage2.win/', 'https://video.laoliimage2.win/v1', 'https://video.laoliimage2.win/v1/videos']) {
  assert.deepEqual(genericVideoApiEndpoints({ ...config, baseUrl }), {
    submit: 'https://video.laoliimage2.win/v1/videos', status: 'https://video.laoliimage2.win/v1/videos/{id}', models: 'https://video.laoliimage2.win/v1/models',
  });
  assert.equal(videoApiSubmitEndpoint({ ...config, baseUrl }), 'https://video.laoliimage2.win/v1/videos');
}
assert.equal(genericVideoApiBaseUrl({ endpoint: 'https://legacy.invalid/v1/videos' }), 'https://legacy.invalid/v1');
assert.equal(genericVideoApiBaseUrl({ endpoint: '', baseUrl: 'h' }), 'h');
assert.equal(genericVideoApiEndpoints({ ...config, baseUrl: '', endpoint: '' }).submit, '');
const legacy = { ...config, baseUrl: undefined, endpoint: 'https://legacy.invalid/generate', statusEndpointTemplate: 'https://legacy.invalid/jobs/{id}' };
assert.equal(videoApiSubmitEndpoint(legacy), legacy.endpoint);
assert.equal(genericVideoApiEndpoints(legacy).status, legacy.statusEndpointTemplate);
assert.equal(genericVideoApiEndpoints({ ...config, endpoint: legacy.endpoint, statusEndpointTemplate: legacy.statusEndpointTemplate }).submit, legacy.endpoint);
assert.equal(isLaoliVideoBuiltinProtocol({ ...config, requestTemplate: '{"custom":"{{prompt}}"}' }), false);
assert.equal(isLaoliVideoBuiltinProtocol({ ...config, baseUrl: 'https://api.laoliimage2.win' }), false, 'the supplied token host is never silently changed to the video host');
const saved = normalizeState({ ...createInitialState(), settings: { ...createInitialState().settings, videoTaskApi: config } });
assert.equal(saved.settings.videoTaskApi.baseUrl, config.baseUrl);
assert.equal(Object.hasOwn(createInitialState().settings.videoTaskApi, 'baseUrl'), false, 'legacy semantic identities remain unchanged');

// Return every ID, including image/text models and aliases; never infer availability.
assert.deepEqual(parseGenericVideoModelIds({ data: [{ id: 'H3-KS', supported_endpoint_types: ['openai-video'] }, { id: '图片模型', supported_endpoint_types: ['image-generation'] }, { id: '文字模型' }, { id: 'H3-KS' }, '3.0'] }), ['3.0', 'H3-KS', '文字模型', '图片模型'].sort((a, b) => a.localeCompare(b)));
const originalWindow = globalThis.window;
const modelRequests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
  request: async (payload: { url: string; method: string; headers: Record<string, string> }) => { modelRequests.push(payload); return response({ data: [{ id: 'H3-KS' }, { id: '图片模型' }] }); },
} } });
try {
  assert.equal((await fetchGenericVideoModels(config)).length, 2);
  assert.equal(modelRequests[0].method, 'GET');
  assert.equal(modelRequests[0].url, 'https://video.laoliimage2.win/v1/models');
  assert.equal(modelRequests[0].headers.Authorization, 'Bearer mock-video-token');
  (globalThis.window as unknown as { lianhuaDesktop: { request: unknown } }).lianhuaDesktop.request = async () => ({ status: 403, body: JSON.stringify({ code: 'GROUP_DELETED', message: 'API Key 所属分组已删除 mock-video-token' }) });
  await assert.rejects(fetchGenericVideoModels(config), (error: Error) => /GROUP_DELETED.*所属分组已删除/u.test(error.message) && !error.message.includes(config.apiKey));
  const pending = new Promise<never>(() => undefined);
  let cancelled = false;
  Object.assign(globalThis.window.lianhuaDesktop!, { request: async () => pending, cancelModelRequest: async () => { cancelled = true; return true; } });
  const controller = new AbortController();
  const interrupted = fetchGenericVideoModels(config, { signal: controller.signal }); controller.abort();
  await assert.rejects(interrupted, { name: 'AbortError' });
  assert.equal(cancelled, true, 'aborting a model fetch cancels the desktop request');
} finally { Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }); }

// Laoli canonical fields preserve parameters, literal prompt and selected image order.
const referenceDraft: VideoGenerationDraft = { ...draft, references: [{ assetId: 'one', role: 'character' }, { assetId: 'two', role: 'scene' }] };
const body = buildVideoApiBody(config, referenceDraft, ['https://assets.invalid/one.png', 'https://assets.invalid/two.png']);
assert.equal(body.prompt, draft.prompt);
assert.equal(body.seconds, 5);
assert.equal(body.duration, undefined);
assert.deepEqual(body.references, [
  { type: 'image', role: 'reference', source: 'https://assets.invalid/one.png' }, { type: 'image', role: 'reference', source: 'https://assets.invalid/two.png' },
]);
assert.deepEqual(buildVideoApiBody({ ...config, model: '3.0' }, { ...draft, references: [{ assetId: 'one', role: 'general' }] }, [png]), {
  model: '3.0', prompt: draft.prompt, duration: 5, resolution: '720p', ratio: '16:9', images: [png],
});
assert.equal(buildVideoApiBody({ ...config, model: 'H3-KS' }, { ...draft, parameters: { duration: '5', resolution: '1080P' } }, []).seconds, 5);
assert.throws(() => buildLaoliVideoApiBody({ model: '3.5' }, draft, []), /时长无效/u);
assert.throws(() => buildVideoApiBody(config, { ...draft, parameters: { ...draft.parameters, seed: 42 } }, []), /seed/u);
assert.throws(() => buildVideoApiBody(config, { ...draft, parameters: {} }, []), /请求时长/u);
assert.throws(() => buildVideoApiBody({ ...config, model: 'H3-KS' }, { ...draft, parameters: { duration: 5, resolution: '1080p' }, references: [{ assetId: 'one', role: 'first-frame' }] }, ['https://assets.invalid/one.png']), /不支持首尾帧/u);
assert.throws(() => buildVideoApiBody(config, { ...draft, audioReferences: [{ bindingId: 'audio', assetId: 'a', slotIndex: 0, target: 'reference', retainMode: 'reference', notes: '' }] }, [], ['audio.wav']), /不支持参考音频/u);
assert.deepEqual(buildVideoApiBody({ ...config, requestTemplate: '{"text":"{{prompt}}","photos":"{{images}}","params":"{{parameters}}"}' }, referenceDraft, ['one', 'two']).photos, ['one', 'two']);
assert.equal(buildVideoApiBody(legacy, { ...draft, parameters: { seed: 7 } }, []).seed, 7, 'old custom API JSON remains unchanged');

// Classic images describe reference responsibilities, not a native frame mode.
// Preserve every picture, literal prompt and the user's role snapshot.
const classicRoles: ReferenceRole[] = ['first-frame', 'middle-frame', 'middle-frame', 'middle-frame', 'middle-frame', 'last-frame'];
const classicReferences = classicRoles.map((role, index) => ({ assetId: `classic-frame-${index}`, role, slotIndex: index }));
const classicSources = classicReferences.map((reference) => `https://assets.invalid/${reference.assetId}.png`);
const classicFrameDraft: VideoGenerationDraft = { ...draft, name: '首帧、四张中间帧与尾帧',
  references: classicReferences, referenceSlotRoles: classicRoles,
  parameters: { duration: 30, resolution: '720p', aspect_ratio: '16:9' } };
for (const model of ['3.0', '特价2.0', '3.5', '特价2.5-需过人脸技术']) {
  const duration = /2\.0|^3\.0$/u.test(model) ? 15 : 30;
  const input = { ...classicFrameDraft, parameters: { ...classicFrameDraft.parameters, duration } };
  const before = structuredClone(input);
  assert.deepEqual(buildVideoApiBody({ ...config, model }, input, classicSources), {
    model, prompt: input.prompt, duration, resolution: '720p', ratio: '16:9', images: classicSources,
  }, `${model}: first, all four middle pictures and last stay in one ordered images array`);
  assert.deepEqual(input, before, `${model}: building a request never rewrites prompt or role memory`);
  assert.deepEqual(buildVideoApiBody({ ...config, model }, { ...input,
    references: [classicReferences[5]], referenceSlotRoles: ['last-frame'] }, [classicSources[5]]).images, [classicSources[5]],
  `${model}: last-frame responsibility alone does not invent a required native first frame`);
  assert.deepEqual(buildVideoApiBody({ ...config, model }, { ...input,
    references: classicReferences.slice(0, 2).map((reference) => ({ ...reference, role: 'first-frame' as const })),
    referenceSlotRoles: ['first-frame', 'first-frame'] }, classicSources.slice(0, 2)).images, classicSources.slice(0, 2),
  `${model}: multiple labelled references do not select a native frame protocol`);
}

// Resume only missing binary chunks. Cross-origin signed assets stay data, not requests.
const uploads: Array<Omit<VideoDesktopRequest, 'requestId'>> = [];
const uploaded = await uploadLaoliVideoImage(config, png, { Authorization: 'Bearer mock-video-token' }, async (payload) => {
  uploads.push(payload);
  if (payload.url.endsWith('/uploads')) {
    assert.deepEqual(JSON.parse(payload.body!), { size: bytes.length, sha256, mime_type: 'image/png' });
    return { id: 'upload-1', status: 'uploading', type: 'image', bytes: bytes.length, sha256, chunk_size: 32, chunk_count: Math.ceil(bytes.length / 32), received: [0] };
  }
  if (payload.method === 'PUT') {
    const index = Number(payload.url.split('/').at(-1));
    assert.equal(payload.bodyEncoding, 'base64');
    assert.equal(payload.headers?.['Content-Type'], 'application/octet-stream');
    assert.deepEqual(Buffer.from(decodeVideoBinaryBody(payload.body!)), bytes.subarray(index * 32, (index + 1) * 32));
    return {};
  }
  assert.equal(payload.url.endsWith('/complete'), true);
  return { id: 'upload-1', status: 'complete', type: 'image', bytes: bytes.length, sha256, source };
});
assert.equal(uploaded, source);
assert.equal(uploads.some((request) => request.url.includes('/chunks/0')), false);
assert.equal(uploads.some((request) => request.url.includes('accept-auth.')), false);
let deduplicatedRequests = 0;
assert.equal(await uploadLaoliVideoImage(config, png, {}, async () => { deduplicatedRequests += 1; return { id: 'upload-1', status: 'complete', type: 'image', bytes: bytes.length, sha256, source }; }), source);
assert.equal(deduplicatedRequests, 1);
await assert.rejects(uploadLaoliVideoImage(config, png, {}, async () => ({ id: 'upload-1', status: 'complete', bytes: bytes.length + 1, source })), /字节不一致/u);

// Running preview URLs are never terminal; completed relative URLs fetch original media.
assert.equal(parseVideoApiResult({ id: 'remote', status: 'in_progress', url: '/preview.mp4', progress: 29 }, config).resultUrl, undefined);
assert.equal(parseVideoApiResult({ id: 'remote', status: 'in_progress', progress: 29 }, config).progress, 29);
assert.equal(parseVideoApiResult({ task_id: 'remote', status: 'completed', url: '/v1/videos/remote/content', download_url: '/v1/videos/remote/download' }, config).resultUrl, 'https://video.laoliimage2.win/v1/videos/remote/download');
assert.equal(parseVideoApiResult({ id: 'remote', status: 'completed', url: '/v1/videos/remote/content' }, config).resultUrl, 'https://video.laoliimage2.win/v1/videos/remote/content?download=1');
assert.equal(parseVideoApiResult({ id: 'remote', status: 'completed' }, { ...config, baseUrl: 'https://openai-video.invalid/v1', endpoint: '' }).resultUrl, 'https://openai-video.invalid/v1/videos/remote/content');
assert.equal(parseVideoApiResult({ id: 'remote', status: 'failed', error: { message: '审核拒绝' }, url: '/preview.mp4' }, config).message, '审核拒绝');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (predicate: () => boolean) => { for (let n = 0; n < 200; n += 1) { if (predicate()) return; await tick(); } assert.fail('mock video task did not reach the expected state'); };
const task = (state: AppState, id: string) => state.project.generationTasks.find((item) => item.id === id) as VideoGenerationTask;
const managed = { fileName: 'generic-result.mp4', relativePath: 'generated/generic-result.mp4', checksum: 'checksum', sizeBytes: 200, mediaType: 'video' as const, managed: true, missing: false, url: 'lianhua-media://generic-result.mp4' };

// Engine: upload, one durable submission, authenticated content, download-only retry.
{
  let state = createInitialState(); state.settings.videoTaskApi = config;
  state.project.assets.push({ id: 'reference', name: '原图', type: 'reference', role: 'composition', dataUrl: png, tags: [], createdAt: 1, updatedAt: 1 });
  const requests: VideoDesktopRequest[] = []; const downloads: GeneratedMediaDownloadRequest[] = []; const vault = new Map<string, string>();
  const desktop = {
    setVideoTaskCredential: async ({ taskId, apiKey }: { taskId: string; apiKey: string }) => { vault.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (id: string) => vault.get(id) || null,
    videoRequest: async (payload: VideoDesktopRequest) => {
      requests.push(payload);
      assert.equal(payload.headers?.Authorization, 'Bearer mock-video-token');
      if (payload.url.endsWith('/media/uploads')) return response({ id: 'upload-1', status: 'uploading', chunk_size: 1024, chunk_count: 1, received: [] });
      if (payload.method === 'PUT') { assert.deepEqual(Buffer.from(payload.body!, 'base64'), bytes); return response({}); }
      if (payload.url.endsWith('/complete')) return response({ id: 'upload-1', status: 'complete', type: 'image', source });
      if (payload.method === 'POST') {
        const current = state.project.generationTasks[0] as VideoGenerationTask;
        assert.equal(current.videoJob?.preparation?.phase, 'post-started');
        assert.equal(payload.headers?.['Idempotency-Key'], current.id, 'the durable task ID is the per-result idempotency key');
        assert.deepEqual(JSON.parse(payload.body!).references, [{ type: 'image', role: 'reference', source }]);
        assert.equal(JSON.parse(payload.body!).prompt, draft.prompt);
        return response({ id: 'remote-engine', status: 'queued' });
      }
      assert.equal(payload.url, 'https://video.laoliimage2.win/v1/videos/remote-engine');
      assert.equal(payload.method, 'GET');
      return response({ id: 'remote-engine', status: 'completed' });
    },
    downloadGeneratedMedia: async (payload: GeneratedMediaDownloadRequest) => {
      downloads.push(payload);
      assert.equal(payload.url, 'https://video.laoliimage2.win/v1/videos/remote-engine/download');
      assert.equal(payload.headers?.Authorization, 'Bearer mock-video-token');
      if (downloads.length === 1) throw new Error('mock disk unavailable');
      return managed;
    },
  } as unknown as VideoGenerationDesktop;
  const options = { getState: () => state, setState: (update: (state: AppState) => AppState) => { state = update(state); }, desktop, onRuntime: () => undefined, pollIntervalMs: 5 };
  const engine = new VideoGenerationEngine(options);
  const id = await engine.start({ ...draft, references: [{ assetId: 'reference', role: 'character' }] });
  await waitFor(() => Boolean(task(state, id).videoJob?.downloadError));
  await engine.retryDownload(id);
  assert.equal(requests.filter((request) => request.url.endsWith('/v1/videos') && request.method === 'POST').length, 1);
  assert.equal(downloads.length, 2);
  assert.equal(task(state, id).videoJob?.stage, 'succeeded');
  assert.equal(JSON.stringify(task(state, id)).includes(config.apiKey), false);
  engine.dispose();
}

// Classic inline references never use an old optional upload endpoint.
{
  let state = createInitialState(); state.settings.videoTaskApi = { ...config, model: '3.0', imageUploadEndpoint: 'https://obsolete-upload.invalid/image' };
  state.project.assets.push({ id: 'reference', name: '原图', type: 'reference', role: 'composition', dataUrl: png, tags: [], createdAt: 1, updatedAt: 1 });
  const requests: VideoDesktopRequest[] = [];
  const desktop = { videoRequest: async (payload: VideoDesktopRequest) => { requests.push(payload); assert.deepEqual(JSON.parse(payload.body!).images, [png]); return response({ id: 'classic-engine', status: 'completed', download_url: 'https://cdn.invalid/video.mp4' }); },
    setVideoTaskCredential: async () => ({ persisted: true }), downloadGeneratedMedia: async (payload: GeneratedMediaDownloadRequest) => { assert.equal(payload.headers, undefined); return managed; },
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); }, desktop, onRuntime: () => undefined });
  const id = await engine.start({ ...draft, references: [{ assetId: 'reference', role: 'general' }] });
  assert.equal(task(state, id).videoJob?.stage, 'succeeded');
  assert.equal(requests.length, 1);
  engine.dispose();
}

// The engine preflight and frozen snapshot accept the same six classic inputs.
// The desktop is a local mock: no upload, fetch or paid API is performed.
{
  let state = createInitialState();
  state.settings.videoTaskApi = { ...config, model: '特价2.5-需过人脸技术' };
  state.project.assets = classicReferences.map((reference) => ({ id: reference.assetId, name: reference.assetId,
    type: 'reference', role: 'composition', dataUrl: png, tags: [], createdAt: 1, updatedAt: 1 }));
  const requests: VideoDesktopRequest[] = [];
  const desktop = {
    setVideoTaskCredential: async () => ({ persisted: true }),
    videoRequest: async (payload: VideoDesktopRequest) => {
      requests.push(payload);
      assert.equal(payload.url, 'https://video.laoliimage2.win/v1/videos');
      assert.equal(payload.method, 'POST');
      const submitted = JSON.parse(payload.body!);
      assert.equal(submitted.prompt, classicFrameDraft.prompt);
      assert.deepEqual(submitted.images, classicReferences.map(() => png));
      assert.equal(submitted.duration, 30); assert.equal(submitted.resolution, '720p');
      assert.equal(Object.hasOwn(submitted, 'references'), false);
      assert.equal(Object.hasOwn(submitted, 'first_frame'), false); assert.equal(Object.hasOwn(submitted, 'last_frame'), false);
      return response({ id: 'classic-keyframe-mock', status: 'completed', download_url: 'https://cdn.invalid/mock.mp4' });
    },
    downloadGeneratedMedia: async () => managed,
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); },
    desktop, onRuntime: () => undefined });
  try {
    const id = await engine.start(classicFrameDraft);
    const snapshot = task(state, id).videoJob!.snapshot;
    assert.equal(task(state, id).videoJob?.stage, 'succeeded', 'classic role labels never fail preflight');
    assert.equal(snapshot.draft.prompt, classicFrameDraft.prompt);
    assert.deepEqual(snapshot.draft.references, classicReferences);
    assert.deepEqual(snapshot.draft.referenceSlotRoles, classicRoles);
    assert.deepEqual(snapshot.images.map((image) => ({ assetId: image.assetId, role: image.role, slotIndex: image.slotIndex })), classicReferences);
    assert.equal(requests.length, 1, 'only the mock submission is called; no upload or polling request is added');
    assert.deepEqual(classicFrameDraft.references, classicReferences);
    assert.deepEqual(classicFrameDraft.referenceSlotRoles, classicRoles);
  } finally { engine.dispose(); }
}

// An uncertain generation POST is retained across reconciliation, never auto-replayed.
{
  let state = createInitialState(); state.settings.videoTaskApi = config; let submissions = 0;
  const desktop = { setVideoTaskCredential: async () => ({ persisted: true }), videoRequest: async (payload: VideoDesktopRequest) => { assert.equal(payload.headers?.['Idempotency-Key'], state.project.generationTasks[0].id); submissions += 1; throw new Error('mock acknowledgement lost'); } } as unknown as VideoGenerationDesktop;
  const options = { getState: () => state, setState: (update: (state: AppState) => AppState) => { state = update(state); }, desktop, onRuntime: () => undefined };
  const engine = new VideoGenerationEngine(options); const id = await engine.start(draft);
  assert.equal(task(state, id).videoJob?.stage, 'submission-unknown'); engine.dispose();
  const recovered = new VideoGenerationEngine(options); recovered.reconcile(); await tick(); await tick();
  assert.equal(submissions, 1); assert.equal(task(state, id).status, 'unknown'); recovered.dispose();
}
console.log('generic video API: address/model list, canonical bodies, binary upload resume, authenticated result and no-repost tests passed');

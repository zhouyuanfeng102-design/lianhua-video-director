import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { defaultRunningHubVideoApi } from '../src/videoGenerationApi';
import type { AppState, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { GeneratedMediaDownloadRequest, GeneratedMediaDownloadResult, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let n = 0; n < 8; n += 1) await tick(); };
const waitFor = async (test: () => boolean, label: string) => {
  for (let n = 0; n < 600; n += 1) { if (test()) return; await tick(); }
  assert.fail(label);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const media = (name: string): GeneratedMediaDownloadResult => ({
  fileName: `${name}.mp4`, relativePath: `video/archive-test/${name}.mp4`, checksum: `sha256-${name}`, sizeBytes: 4096,
  managed: true, missing: false, mediaType: 'video', mimeType: 'video/mp4', url: `lianhua-asset://local/video/archive-test/${name}.mp4`,
});
const cloudResult = (remoteTaskId = 'original-remote', url = 'https://files.example.test/生成结果.zip') => ({
  status: 'SUCCESS', taskId: remoteTaskId, results: [
    { nodeId: '187', outputType: 'txt', url: 'https://files.example.test/prompt.txt' },
    { nodeId: '186', outputType: 'zip', url },
  ],
});
const config: VideoTaskApiConfig = {
  ...defaultRunningHubVideoApi, runningHubAppId: '130', apiKey: 'archive-fixture-key', runningHubOutputNodeIds: ['186'],
  endpoint: 'https://cloud.example.test/openapi/v2/run/ai-app/{appId}', statusEndpointTemplate: 'https://cloud.example.test/openapi/v2/query',
  requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: '1', fieldName: 'text', fieldValue: '{{prompt}}' }] }),
};
const draft: VideoGenerationDraft = { name: '生成成片', prompt: '完整原提示词', backend: 'api', references: [], parameters: {} };
const createHarness = (overrides: Partial<VideoTaskApiConfig> = {}) => {
  const configuredApi = { ...config, ...overrides };
  let state = createInitialState(); state.settings.videoTaskApi = { ...configuredApi };
  const downloads: GeneratedMediaDownloadRequest[] = [];
  const requests: Parameters<VideoGenerationDesktop['videoRequest']>[0][] = [];
  const checkpoints = new Map<string, VideoGenerationTask>();
  const cancelled: string[] = [];
  let persists = 0;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (input) => {
      requests.push(input);
      assert.match(input.url, /\/query$/u, 'result recovery must never call run/prompt');
      assert.equal(input.method, 'POST');
      const body = JSON.parse(input.body || '{}');
      assert.deepEqual(Object.keys(body), ['taskId']);
      return { status: 200, body: JSON.stringify(cloudResult(body.taskId)) };
    },
    cancelVideoRequest: async (requestId) => { cancelled.push(requestId); return true; },
    watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => configuredApi.apiKey,
    saveVideoTaskCheckpoint: async (task) => { checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(checkpoints.get(taskId) || null), deleteVideoTaskCheckpoint: async () => true,
    downloadGeneratedMedia: async (input) => { downloads.push(input); return { ...media('成片'), archiveFileName: '生成结果.zip' }; },
    readManagedImageDataUrl: async () => ({ dataUrl: 'data:image/png;base64,dGFpbA==' }),
  };
  const options = {
    getState: () => state, setState: (updater: (current: AppState) => AppState) => { state = updater(state); },
    desktop, onRuntime: () => {}, pollIntervalMs: 60_000, persistState: async () => { persists += 1; },
  };
  const seed = (taskId = 'legacy-zip', response: unknown = cloudResult(), status: VideoGenerationTask['status'] = 'failed') => {
    const { apiKey: _key, ...safe } = configuredApi;
    const task: VideoGenerationTask = {
      id: taskId, kind: 'video', storyboardId: '', targetId: '云端工作流', status, remoteTaskId: 'original-remote', response,
      error: status === 'failed' ? '旧版本不支持 ZIP，显示生成失败' : undefined, requestBody: {}, createdAt: 100, updatedAt: 200,
      videoJob: { stage: status === 'failed' ? 'failed' : 'running', preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] },
        snapshot: { projectId: state.project.id, clientId: `${taskId}-client`, draft: { ...draft }, images: [], connection: { backend: 'api', api: safe } } },
    };
    state = { ...state, project: { ...state.project, generationTasks: [...state.project.generationTasks, task] } };
    return task;
  };
  return { state: () => state, set: options.setState, options, desktop, downloads, requests, cancelled, checkpoints, seed, persists: () => persists,
    task: (taskId = 'legacy-zip') => state.project.generationTasks.find((task) => task.id === taskId) as VideoGenerationTask,
    engine: new VideoGenerationEngine(options) };
};

// The exact old-version failure shown by the user is recovered entirely from
// the already saved SUCCESS response. No generation or result-query POST.
{
  const h = createHarness(); h.seed();
  await h.engine.recoverResult('legacy-zip');
  const task = h.task();
  assert.equal(h.requests.length, 0); assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].url, cloudResult().results[1].url);
  assert.equal(h.downloads[0].allowVideoArchive, true); assert.equal(h.downloads[0].archiveHint, true);
  assert.equal(task.status, 'succeeded'); assert.equal(task.videoJob?.stage, 'succeeded'); assert.equal(task.error, undefined);
  assert.equal(task.videoJob?.downloadError, undefined); assert.ok(task.resultAssetId);
  assert.deepEqual(task.videoJob?.resultAssetIds, [task.resultAssetId]); assert.equal(task.videoJob?.resultSelectionRequired, false);
  assert.equal(h.state().project.assets.length, 1); assert.equal(h.state().project.assets[0].mediaType, 'video');
  assert.equal(h.state().project.assets[0].videoSourceTask?.remoteTaskId, 'original-remote');
  assert.ok(h.persists() > 0); assert.equal(h.checkpoints.get(task.id)?.resultAssetId, task.resultAssetId);
  await h.engine.recoverResult(task.id); assert.equal(h.downloads.length, 1, 'saved results never redownload');
  h.engine.dispose();
}

// A newly submitted task can finish synchronously with ZIP. The one allowed
// generation request is explicit start(); accepting ZIP must not resubmit it.
{
  const h = createHarness(); let submissions = 0;
  h.desktop.videoRequest = async (input) => {
    h.requests.push(input); assert.match(input.url, /\/run\/ai-app\/130$/u); submissions += 1;
    return { status: 200, body: JSON.stringify(cloudResult('new-remote')) };
  };
  const taskId = await h.engine.start(draft);
  assert.equal(submissions, 1); assert.equal(h.downloads.length, 1); assert.ok(h.task(taskId).resultAssetId);
  assert.equal(h.downloads[0].archiveHint, true); h.engine.dispose();
}

// A normal remote poll succeeds with ZIP too, including a preceding TXT.
{
  const h = createHarness(); h.seed('poll-zip', { status: 'RUNNING', taskId: 'original-remote' }, 'running');
  h.engine.reconcile(); await waitFor(() => Boolean(h.task('poll-zip').resultAssetId), 'poll ZIP was not saved');
  assert.equal(h.requests.length, 1); assert.equal(h.downloads[0].archiveHint, true);
  h.engine.dispose();
}

// Missing saved results, or an expired download, only query the ORIGINAL ID.
for (const scenario of ['missing', 'expired'] as const) {
  const h = createHarness(); const task = h.seed('legacy-zip', scenario === 'missing' ? { status: 'RUNNING' } : cloudResult());
  if (scenario === 'expired') task.videoJob!.downloadError = 'HTTP 403 signed URL expired';
  await h.engine.recoverResult(task.id);
  assert.equal(h.requests.length, 1); assert.deepEqual(JSON.parse(h.requests[0].body!), { taskId: 'original-remote' });
  assert.equal(h.downloads.length, 1); assert.ok(h.task().resultAssetId); h.engine.dispose();
}

// Provider SUCCESS with no suitable file stays SUCCESS + a local receipt issue.
{
  const h = createHarness(); h.seed('legacy-zip', { status: 'RUNNING' });
  h.desktop.videoRequest = async (input) => { h.requests.push(input); return { status: 200, body: JSON.stringify({ status: 'SUCCESS', taskId: 'original-remote', results: [{ outputType: 'txt', url: 'https://files.example.test/text.txt' }] }) }; };
  await h.engine.recoverResult('legacy-zip');
  assert.equal(h.task().status, 'succeeded'); assert.ok(h.task().videoJob?.downloadError); assert.equal(h.task().error, undefined);
  assert.equal(h.downloads.length, 0); h.engine.dispose();
}

// A mismatched cached/query response may not attach another cloud task's files.
for (const location of ['cache', 'query'] as const) {
  const h = createHarness(); h.seed('legacy-zip', location === 'cache' ? cloudResult('foreign-task') : { status: 'RUNNING' });
  if (location === 'query') h.desktop.videoRequest = async (input) => { h.requests.push(input); return { status: 200, body: JSON.stringify(cloudResult('foreign-task')) }; };
  await assert.rejects(h.engine.recoverResult('legacy-zip'), /任务 ID|结果与原任务/u);
  assert.equal(h.downloads.length, 0); assert.equal(h.state().project.assets.length, 0); h.engine.dispose();
}

// Download/ZIP decode failure remains a retryable save error, never generation
// failure. Repeated retryDownload uses the same URL and issues no new request.
{
  const h = createHarness(); h.seed(); let attempts = 0;
  h.desktop.downloadGeneratedMedia = async (input) => { h.downloads.push(input); attempts += 1; if (attempts === 1) throw new Error('ZIP CRC 校验失败'); return media('恢复成片'); };
  await h.engine.recoverResult('legacy-zip');
  assert.equal(h.task().status, 'succeeded'); assert.match(h.task().videoJob!.downloadError!, /CRC/u); assert.equal(h.state().project.assets.length, 0);
  await h.engine.retryDownload('legacy-zip'); assert.equal(h.requests.length, 0); assert.equal(attempts, 2); assert.ok(h.task().resultAssetId);
  h.engine.dispose();
}

// ZIP containing multiple files: keep EVERY video and require explicit choice.
{
  const h = createHarness(); h.seed();
  h.desktop.downloadGeneratedMedia = async (input) => { h.downloads.push(input); return { ...media('版本甲'), additionalVideos: [media('版本乙'), media('版本丙')], archiveFileName: 'all.zip' }; };
  await h.engine.recoverResult('legacy-zip');
  assert.equal(h.state().project.assets.length, 3); assert.equal(h.task().resultAssetId, undefined); assert.equal(h.task().videoJob?.resultSelectionRequired, true);
  assert.equal(h.task().videoJob?.resultAssetIds?.length, 3); assert.equal(h.task().videoJob?.resultArchiveFileName, 'all.zip');
  h.engine.reconcile(); await h.engine.retryDownload('legacy-zip'); await settle(); assert.equal(h.downloads.length, 1);
  await assert.rejects(h.engine.selectResultVideo('legacy-zip', 'not-owned'), /不属于/u);
  const ids = h.task().videoJob!.resultAssetIds!;
  await h.engine.selectResultVideo('legacy-zip', ids[1]);
  assert.equal(h.task().resultAssetId, ids[1]); assert.equal(h.task().videoJob?.resultSelectionRequired, false);
  assert.equal(h.checkpoints.get('legacy-zip')?.resultAssetId, ids[1]);
  await assert.rejects(h.engine.selectResultVideo('legacy-zip', ids[2]), /不能更换/u);
  assert.equal(h.state().project.assets.length, 3); assert.equal(h.requests.length, 0); h.engine.dispose();
}

// Cancellation and removal must discard a late ZIP result, even if the fake
// desktop service completes after cancellation instead of rejecting.
for (const action of ['cancel', 'remove'] as const) {
  const h = createHarness(); h.seed(); const hold = deferred();
  h.desktop.downloadGeneratedMedia = async (input) => { h.downloads.push(input); await hold.promise; return { ...media('late'), additionalVideos: [media('late-2')], archiveFileName: 'late.zip' }; };
  const recovery = h.engine.recoverResult('legacy-zip'); await waitFor(() => h.downloads.length === 1, 'download did not begin');
  if (action === 'cancel') await h.engine.cancel('legacy-zip');
  else { h.set((state) => ({ ...state, project: { ...state.project, generationTasks: [] } })); h.engine.reconcile(); }
  hold.resolve(); await recovery; await settle(); assert.equal(h.state().project.assets.length, 0);
  if (action === 'cancel') { assert.equal(h.task().videoJob?.trackingStopped, true); assert.equal(h.task().resultAssetId, undefined); }
  assert.ok(h.cancelled.some((requestId) => requestId.startsWith('video_download_'))); h.engine.dispose();
}

// Cross-project navigation must put all returned videos only in their owner.
{
  const h = createHarness(); h.seed(); const hold = deferred(); const owner = h.state().project.id;
  h.desktop.downloadGeneratedMedia = async (input) => { h.downloads.push(input); await hold.promise; return { ...media('owner-1'), additionalVideos: [media('owner-2')], archiveFileName: 'owner.zip' }; };
  const recovery = h.engine.recoverResult('legacy-zip'); await waitFor(() => h.downloads.length === 1, 'owner download did not begin');
  h.set((state) => ({ ...state, projects: [state.project], project: { ...createInitialState().project, id: 'other-project', assets: [] } }));
  hold.resolve(); await recovery;
  assert.equal(h.state().project.assets.length, 0); assert.equal(h.state().projects.find((project) => project.id === owner)?.assets.length, 2); h.engine.dispose();
}

// Persist failure never redownloads already-saved videos. Retry only flushes
// the exact result list and then permits selection.
{
  const h = createHarness(); h.seed(); let fail = true;
  h.desktop.downloadGeneratedMedia = async (input) => { h.downloads.push(input); return { ...media('persist-A'), additionalVideos: [media('persist-B')], archiveFileName: 'persist.zip' }; };
  h.options.persistState = async () => { if (fail) throw new Error('disk full'); };
  await h.engine.recoverResult('legacy-zip'); await settle();
  assert.ok(h.task().videoJob?.downloadError); assert.equal(h.state().project.assets.length, 2);
  fail = false; await h.engine.retryDownload('legacy-zip');
  assert.equal(h.downloads.length, 1); assert.equal(h.task().videoJob?.downloadError, undefined);
  await h.engine.selectResultVideo('legacy-zip', h.task().videoJob!.resultAssetIds![1]);
  assert.ok(h.task().resultAssetId); h.engine.dispose();
}

// On restart a newer selected journal can coexist with an older main snapshot.
// Reuse ONLY the same saved IDs; no download, no choosing a different result.
{
  const h = createHarness(); h.seed();
  h.desktop.downloadGeneratedMedia = async (input) => { h.downloads.push(input); return { ...media('restart-A'), additionalVideos: [media('restart-B')], archiveFileName: 'restart.zip' }; };
  await h.engine.recoverResult('legacy-zip'); const oldState = structuredClone(h.state());
  const chosen = h.task().videoJob!.resultAssetIds![1]; await h.engine.selectResultVideo('legacy-zip', chosen);
  h.engine.dispose(); h.set(() => oldState);
  const restarted = new VideoGenerationEngine(h.options); restarted.reconcile();
  await waitFor(() => h.task().resultAssetId === chosen, 'newer journal selection was not recovered');
  await settle(); assert.equal(h.task().videoJob?.resultSelectionRequired, false); assert.equal(h.downloads.length, 1); assert.equal(h.requests.length, 0);
  await assert.rejects(restarted.selectResultVideo('legacy-zip', h.task().videoJob!.resultAssetIds![0]), /不能更换/u); restarted.dispose();
}

const multipleCloudOutputs = () => ({ status: 'SUCCESS', taskId: 'original-remote', results: [
  { nodeId: '203', outputType: 'zip', url: 'https://files.example.test/测试专用，无需下载.zip' },
  { nodeId: '186', outputType: 'zip', url: 'https://files.example.test/输出视频，下载这个.zip' },
  { nodeId: '229', outputType: 'txt', url: 'https://files.example.test/提示词.txt' },
] });

// RunningHub can put a debug ZIP before the actual video ZIP. A failed saved
// task upgrades in place: try every allowed output, with no query/create POST.
{
  const h = createHarness({ runningHubOutputNodeIds: [] }); const response = multipleCloudOutputs();
  const old = h.seed('legacy-zip', response, 'succeeded');
  old.resultUrl = response.results[0].url;
  old.videoJob!.downloadError = '云端 ZIP 已接收，但其中没有可用的 MP4、MOV 或 WebM 视频';
  h.desktop.downloadGeneratedMedia = async (input) => {
    h.downloads.push(input);
    if (input.url === response.results[0].url) throw new Error('ZIP 中没有可用视频');
    assert.equal(input.url, response.results[1].url);
    return { ...media('真正成片'), archiveFileName: '输出视频，下载这个.zip' };
  };
  await h.engine.recoverResult(old.id);
  assert.deepEqual(h.downloads.map((request) => request.url), response.results.slice(0, 2).map((entry) => entry.url));
  assert.equal(h.requests.length, 0, 'saved output candidates need neither re-query nor new generation');
  assert.ok(h.downloads.every((request) => request.archiveHint && request.allowVideoArchive));
  assert.notEqual(h.downloads[0].requestId, h.downloads[1].requestId, 'each download has a distinct cancellation/progress lease');
  assert.equal(h.task().resultUrl, response.results[1].url);
  assert.equal(h.task().videoJob?.downloadError, undefined); assert.ok(h.task().resultAssetId);
  assert.equal(h.state().project.assets[0].videoSourceTask?.resultUrl, response.results[1].url);
  assert.equal(h.checkpoints.get(old.id)?.resultUrl, response.results[1].url);
  await h.engine.recoverResult(old.id); assert.equal(h.downloads.length, 2, 'a saved winner never redownloads alternatives');
  h.engine.dispose();
}

// Synchronous generation and polling use the same multi-output receipt path.
for (const mode of ['start', 'poll'] as const) {
  const h = createHarness({ runningHubOutputNodeIds: [] }); const response = multipleCloudOutputs();
  h.desktop.videoRequest = async (input) => { h.requests.push(input); return { status: 200, body: JSON.stringify(response) }; };
  h.desktop.downloadGeneratedMedia = async (input) => {
    h.downloads.push(input); if (input.url === response.results[0].url) throw new Error('测试 ZIP 没有视频'); return media('自动接收成片');
  };
  let taskId: string;
  if (mode === 'start') taskId = await h.engine.start(draft);
  else {
    taskId = h.seed('poll-zip', { status: 'RUNNING', taskId: 'original-remote' }, 'running').id;
    h.engine.reconcile(); await waitFor(() => Boolean(h.task(taskId).resultAssetId), 'multi-output poll was not saved');
  }
  assert.equal(h.requests.length, 1); assert.equal(h.downloads.length, 2); assert.ok(h.task(taskId).resultAssetId);
  assert.match(h.requests[0].url, mode === 'start' ? /\/run\/ai-app\/130$/u : /\/query$/u);
  assert.equal(h.task(taskId).resultUrl, response.results[1].url); h.engine.dispose();
}

// Explicit output-node filters are hard boundaries, including stale resultUrl
// fields from older releases. Never escape them to obtain a different video.
for (const selectedNodes of [['203'], ['999']] as const) {
  const h = createHarness({ runningHubOutputNodeIds: [...selectedNodes] }); const response = multipleCloudOutputs();
  const old = h.seed('legacy-zip', response, 'succeeded'); old.resultUrl = response.results[1].url;
  old.videoJob!.downloadError = 'previous receipt failed';
  h.desktop.downloadGeneratedMedia = async (input) => { h.downloads.push(input); throw new Error('指定节点 ZIP 中没有视频'); };
  await h.engine.retryDownload(old.id);
  assert.equal(h.requests.length, 0); assert.equal(h.state().project.assets.length, 0);
  assert.deepEqual(h.downloads.map((request) => request.url), selectedNodes[0] === '203' ? [response.results[0].url] : []);
  assert.match(h.task().videoJob!.downloadError!, selectedNodes[0] === '203' ? /已尝试 1 个云端输出/u : /允许输出节点/u);
  h.engine.dispose();
}

// A current resultUrl is preferred only when it is still in the allowed list.
for (const action of ['retry', 'recover'] as const) {
  const h = createHarness({ runningHubOutputNodeIds: [] }); const response = multipleCloudOutputs();
  const old = h.seed('legacy-zip', response, 'succeeded'); old.resultUrl = response.results[1].url;
  old.videoJob!.downloadError = 'retry allowed result';
  if (action === 'retry') await h.engine.retryDownload(old.id);
  else await h.engine.recoverResult(old.id);
  assert.deepEqual(h.downloads.map((request) => request.url), [response.results[1].url]);
  assert.equal(h.requests.length, 0); h.engine.dispose();
}

// Headers are resolved separately for each candidate, not carried from the
// authenticated provider endpoint onto an unauthenticated CDN alternative.
{
  const h = createHarness({ runningHubOutputNodeIds: [] }); const response = multipleCloudOutputs();
  response.results[0].url = 'https://cloud.example.test/first.zip';
  h.seed('legacy-zip', response);
  h.desktop.getVideoTaskCredential = async () => 'scope-private-secret';
  h.desktop.downloadGeneratedMedia = async (input) => {
    h.downloads.push(input);
    if (input.url === response.results[0].url) throw new Error('ZIP 没有视频');
    return media('CDN成片');
  };
  await h.engine.recoverResult('legacy-zip');
  assert.equal(h.downloads[0].headers?.Authorization, 'Bearer scope-private-secret');
  assert.equal(h.downloads[1].headers, undefined); assert.equal(h.requests.length, 0); h.engine.dispose();
}

// All failures identify each attempted node and strip signed links/credentials
// from diagnostics, while preserving a retryable cloud-success state.
{
  const h = createHarness({ runningHubOutputNodeIds: [] }); const response = multipleCloudOutputs();
  response.results[0].url = 'https://cloud.example.test/first.zip';
  h.seed('legacy-zip', response); h.desktop.getVideoTaskCredential = async () => 'scope-private-secret';
  h.desktop.downloadGeneratedMedia = async (input) => {
    h.downloads.push(input);
    throw new Error(input.url === response.results[0].url
      ? 'ZIP 内没有视频 Authorization: Bearer scope-private-secret'
      : 'ZIP CRC 校验失败 https://files.example.test/second.zip?signature=private-signature token=token-secret');
  };
  await h.engine.recoverResult('legacy-zip');
  const error = h.task().videoJob!.downloadError!;
  assert.match(error, /已尝试 2 个云端输出/u); assert.match(error, /节点 203.*没有视频/u); assert.match(error, /节点 186.*CRC/u);
  assert.doesNotMatch(error, /scope-private-secret|private-signature|token-secret|https:\/\//u);
  assert.equal(h.task().status, 'succeeded'); assert.equal(h.task().resultAssetId, undefined);
  assert.equal(h.state().project.assets.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.downloads.length, 2);
  h.engine.dispose();
}

// Aborting/removing/cancelling while a failed first ZIP returns cannot trigger
// a second download. Pending chain tasks remain stopped, never auto-resubmitted.
for (const action of ['cancel', 'remove', 'abort', 'stale'] as const) {
  const h = createHarness({ runningHubOutputNodeIds: [] }); const response = multipleCloudOutputs();
  h.seed('legacy-zip', response); const hold = deferred();
  h.desktop.downloadGeneratedMedia = async (input) => {
    h.downloads.push(input); await hold.promise;
    if (action === 'abort') throw Object.assign(new Error('receipt aborted'), { name: 'AbortError' });
    throw new Error('测试 ZIP 没有视频');
  };
  const recovery = h.engine.recoverResult('legacy-zip'); await waitFor(() => h.downloads.length === 1, 'candidate receipt did not begin');
  if (action === 'cancel') await h.engine.cancel('legacy-zip');
  if (action === 'remove') { h.set((state) => ({ ...state, project: { ...state.project, generationTasks: [] } })); h.engine.reconcile(); }
  if (action === 'stale') h.set((state) => ({ ...state, project: { ...state.project, generationTasks: state.project.generationTasks.map((entry) => entry.id === 'legacy-zip' ? {
    ...entry, remoteTaskId: 'replacement-remote', videoJob: { ...(entry as VideoGenerationTask).videoJob!, downloadError: 'replacement receipt awaiting explicit retry' },
  } : entry) } }));
  hold.resolve(); await recovery; await settle();
  assert.equal(h.downloads.length, 1); assert.equal(h.requests.length, 0); assert.equal(h.state().project.assets.length, 0);
  if (action === 'cancel') assert.equal(h.task().videoJob?.trackingStopped, true);
  if (action === 'stale') assert.equal(h.task().videoJob?.downloadError, 'replacement receipt awaiting explicit retry');
  h.engine.dispose();
}

console.log('ZIP video engine tests passed: legacy/synchronous/poll recovery, query-only retries, all videos saved, explicit selection, cancellation, owner isolation and restart journal selection');

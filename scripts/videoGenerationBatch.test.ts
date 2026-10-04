import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInitialState, normalizeState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { videoTaskRequestFingerprint } from '../src/videoBatch';
import type { AppState, ReferenceAsset, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type {
  GeneratedMediaDownloadRequest,
  VideoBatchStartInput,
  VideoGenerationDesktop,
  VideoGenerationDraft,
  VideoGenerationRuntime,
} from '../src/videoGenerationTypes';

type Desktop = VideoGenerationDesktop;
type Request = Parameters<Desktop['videoRequest']>[0];

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (predicate: () => boolean, message: string) => {
  for (let count = 0; count < 400; count += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const response = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
const apiConfig: VideoTaskApiConfig = {
  enabled: true,
  endpoint: 'https://batch.example.test/generate',
  statusEndpointTemplate: 'https://batch.example.test/tasks/{id}',
  apiKey: 'batch-key',
  authHeader: 'Authorization',
  authScheme: 'Bearer',
  taskIdPath: 'id',
  statusPath: 'status',
  resultUrlPath: 'output.url',
  provider: 'generic',
  model: 'batch-model',
};

const batchDraft = (index: number, patch: Partial<VideoGenerationDraft> = {}): VideoGenerationDraft => ({
  name: `批量视频 ${index}`,
  prompt: `batch prompt ${index}`,
  backend: 'api',
  references: [],
  parameters: { seed: index },
  source: {
    storyboardId: `batch-board-${index}`,
    sequencePlanId: 'batch-plan',
    segmentId: `batch-segment-${index}`,
    segmentIndex: index,
    language: 'zh',
    label: `第 ${index} 段`,
  },
  ...patch,
});

const batchInput = (count: number, label = '长剧情一键生成'): VideoBatchStartInput => ({
  projectId: '',
  label,
  items: Array.from({ length: count }, (_, index) => ({
    itemKey: `batch-board-${index + 1}:zh`,
    draft: batchDraft(index + 1),
  })),
});

interface HarnessOptions {
  request?: (payload: Request) => Promise<{ status: number; body: string; bodyEncoding?: 'text' | 'base64'; contentType?: string }>;
  saveCheckpoint?: (task: VideoGenerationTask) => Promise<void>;
  persistState?: () => Promise<void>;
  transformState?: (next: AppState, current: AppState) => AppState;
}

const createHarness = (options: HarnessOptions = {}) => {
  const holder = { state: createInitialState() };
  holder.state.settings.videoTaskApi = { ...apiConfig };
  const requests: Request[] = [];
  const checkpoints = new Map<string, VideoGenerationTask>();
  const credentials = new Map<string, string>();
  const desktop = {
    videoRequest: async (payload: Request) => {
      requests.push(payload);
      if (options.request) return options.request(payload);
      if (payload.method === 'POST') return response({ id: `remote-${requests.length}`, status: 'queued' });
      return response({ status: 'processing', progress: 1 });
    },
    cancelVideoRequest: async () => true,
    setVideoTaskCredential: async ({ taskId, apiKey }: { taskId: string; apiKey: string }) => {
      if (apiKey) credentials.set(taskId, apiKey);
      else credentials.delete(taskId);
      return { persisted: true };
    },
    getVideoTaskCredential: async (taskId: string) => credentials.get(taskId) || null,
    saveVideoTaskCheckpoint: async (task: VideoGenerationTask) => {
      await options.saveCheckpoint?.(structuredClone(task));
      checkpoints.set(task.id, structuredClone(task));
      return { persisted: true };
    },
    getVideoTaskCheckpoint: async (taskId: string) => structuredClone(checkpoints.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId: string) => checkpoints.delete(taskId),
    downloadGeneratedMedia: async (payload: GeneratedMediaDownloadRequest) => ({
      fileName: `${payload.fileName || 'batch-video'}.mp4`,
      relativePath: `video/${payload.fileName || 'batch-video'}.mp4`,
      checksum: `checksum-${payload.requestId}`,
      sizeBytes: 1024,
      mediaType: 'video' as const,
      managed: true,
      missing: false,
      url: `lianhua-media://asset/${encodeURIComponent(payload.fileName || 'batch-video')}.mp4`,
    }),
  } as unknown as Desktop;
  const runtimes: Record<string, VideoGenerationRuntime> = {};
  const engineOptions = {
    getState: () => holder.state,
    setState: (updater: (current: AppState) => AppState) => {
      const current = holder.state;
      const next = updater(current);
      holder.state = options.transformState?.(next, current) || next;
    },
    desktop,
    onRuntime: (taskId: string, runtime: VideoGenerationRuntime) => { runtimes[taskId] = runtime; },
    pollIntervalMs: 60_000,
    persistState: options.persistState,
  };
  return {
    holder, requests, checkpoints, desktop, runtimes, engineOptions,
    engine: new VideoGenerationEngine(engineOptions),
  };
};

const videoTasks = (state: AppState, projectId = state.project.id): VideoGenerationTask[] => {
  const project = state.project.id === projectId
    ? state.project
    : state.projects.find((candidate) => candidate.id === projectId);
  return (project?.generationTasks || []).filter((task): task is VideoGenerationTask => task.kind === 'video' || task.kind == null);
};

// The entire selection is structurally preflighted before task creation or POST.
{
  const harness = createHarness();
  const input = batchInput(2);
  input.projectId = harness.holder.state.project.id;
  input.items[1] = {
    ...input.items[1],
    draft: { ...input.items[1].draft, references: [{ assetId: 'missing-image', role: 'first-frame' }] },
  };
  await assert.rejects(() => harness.engine.startBatch(input), /所选图片已不存在/u);
  assert.equal(videoTasks(harness.holder.state).length, 0);
  assert.equal(harness.requests.filter((request) => request.method === 'POST').length, 0);
  assert.equal(harness.checkpoints.size, 0);
  harness.engine.dispose();
}

// Queue mode waits for each remote completion, then admits the next row in order.
{
  const postReleases: Array<() => void> = [];
  const prompts: string[] = [];
  let activePosts = 0;
  let maxActivePosts = 0;
  const harness = createHarness({
    request: async (payload) => {
      if (payload.method !== 'POST') return response({ status: 'success', output: { url: 'https://cdn.example.test/ordered.mp4' } });
      const body = JSON.parse(payload.body || '{}') as { prompt?: string };
      prompts.push(body.prompt || '');
      activePosts += 1;
      maxActivePosts = Math.max(maxActivePosts, activePosts);
      await new Promise<void>((resolve) => postReleases.push(() => { activePosts -= 1; resolve(); }));
      return response({ id: `ordered-${prompts.length}`, status: 'queued' });
    },
  });
  const input = batchInput(15);
  input.projectId = harness.holder.state.project.id;
  const result = await harness.engine.startBatch(input);
  assert.equal(result.taskIds.length, 15);
  for (let index = 0; index < 15; index += 1) {
    await waitFor(() => prompts.length === index + 1, `batch row ${index + 1} was not submitted`);
    assert.equal(activePosts, 1);
    postReleases[index]();
  }
  await waitFor(() => videoTasks(harness.holder.state).every((task) => Boolean(task.remoteTaskId)), 'ordered batch did not finish submission');
  assert.equal(maxActivePosts, 1);
  assert.deepEqual(prompts, Array.from({ length: 15 }, (_, index) => `batch prompt ${index + 1}`));
  harness.engine.dispose();
}

// Async completion remains owned by the project that launched the batch.
{
  const releasePost = deferred();
  let postStarted = false;
  const harness = createHarness({
    request: async (payload) => {
      if (payload.method !== 'POST') return response({ status: 'processing' });
      postStarted = true;
      await releasePost.promise;
      return response({ id: 'cross-project-remote', status: 'queued' });
    },
  });
  const ownerId = harness.holder.state.project.id;
  const input = batchInput(1);
  input.projectId = ownerId;
  const result = await harness.engine.startBatch(input);
  await waitFor(() => postStarted, 'cross-project POST did not start');
  const owner = harness.holder.state.projects.find((project) => project.id === ownerId)!;
  const other = { ...structuredClone(owner), id: 'batch-other-project', name: '另一个项目', assets: [] as ReferenceAsset[], generationTasks: [] };
  harness.holder.state = {
    ...harness.holder.state,
    project: other,
    activeProjectId: other.id,
    projects: [...harness.holder.state.projects, other],
  };
  releasePost.resolve();
  await waitFor(() => videoTasks(harness.holder.state, ownerId).some((task) => task.id === result.taskIds[0] && Boolean(task.remoteTaskId)), 'owner project did not receive completion');
  assert.equal(videoTasks(harness.holder.state).length, 0);
  assert.equal(videoTasks(harness.holder.state, ownerId)[0].videoJob?.snapshot.projectId, ownerId);
  harness.engine.dispose();
}

// Same-click Promise coalescing and cross-call request fingerprints prevent duplicate billing.
{
  const releasePost = deferred();
  const harness = createHarness({
    request: async (payload) => {
      if (payload.method !== 'POST') return response({ status: 'processing' });
      await releasePost.promise;
      return response({ id: 'deduplicated-remote', status: 'queued' });
    },
  });
  const input = batchInput(1, '双击测试');
  input.projectId = harness.holder.state.project.id;
  const first = harness.engine.startBatch(input);
  const doubleClick = harness.engine.startBatch(structuredClone(input));
  assert.equal(first, doubleClick);
  const [firstResult, doubleResult] = await Promise.all([first, doubleClick]);
  assert.equal(firstResult.batchId, doubleResult.batchId);
  await waitFor(() => harness.requests.some((request) => request.method === 'POST'), 'deduplication POST did not start');
  const anotherBatch = await harness.engine.startBatch({ ...structuredClone(input), label: '另一批相同请求', force: true });
  assert.equal(anotherBatch.taskIds.length, 0);
  assert.equal(anotherBatch.skipped[0]?.reason, 'in-flight', 'force must never bypass in-flight protection');
  assert.equal(harness.requests.filter((request) => request.method === 'POST').length, 1);
  releasePost.resolve();
  await waitFor(() => Boolean(videoTasks(harness.holder.state)[0]?.remoteTaskId), 'deduplicated task was not acknowledged');
  harness.engine.dispose();
}

// A pre-batch/single-item task has no stored requestFingerprint. Its frozen
// snapshot is still the request identity and must block an identical batch POST.
{
  const releasePost = deferred();
  let posts = 0;
  const harness = createHarness({
    request: async (payload) => {
      if (payload.method !== 'POST') return response({ status: 'processing' });
      posts += 1;
      await releasePost.promise;
      return response({ id: 'single-item-remote', status: 'queued' });
    },
  });
  const draft = batchDraft(1);
  const singleStart = harness.engine.start(draft);
  await waitFor(() => posts === 1, 'single-item POST did not start');
  const singleTask = videoTasks(harness.holder.state)[0];
  assert.equal(singleTask.requestFingerprint, undefined);
  assert.ok(videoTaskRequestFingerprint(singleTask), 'single-item frozen snapshot did not produce a fallback fingerprint');
  harness.engine.reconcile();
  const input = batchInput(1, '单段任务兼容去重');
  input.projectId = harness.holder.state.project.id;
  const duplicate = await harness.engine.startBatch(input);
  assert.equal(duplicate.taskIds.length, 0);
  assert.equal(duplicate.skipped[0]?.reason, 'in-flight');
  assert.equal(duplicate.skipped[0]?.taskId, singleTask.id);
  assert.equal(posts, 1, 'an identical batch request bypassed the single-item task fingerprint');
  releasePost.resolve();
  await singleStart;
  harness.engine.dispose();
}

// Fingerprint ownership is project-scoped: identical requests in two projects
// are independent user actions and neither project may suppress the other.
{
  const releasePosts = deferred();
  let posts = 0;
  const harness = createHarness({
    request: async (payload) => {
      if (payload.method !== 'POST') return response({ status: 'processing' });
      posts += 1;
      await releasePosts.promise;
      return response({ id: `project-scoped-${posts}`, status: 'queued' });
    },
  });
  const firstProjectId = harness.holder.state.project.id;
  const secondProject = {
    ...structuredClone(harness.holder.state.project),
    id: 'batch-independent-project',
    name: '独立批量项目',
    generationTasks: [],
    assets: [] as ReferenceAsset[],
  };
  harness.holder.state = {
    ...harness.holder.state,
    projects: [...harness.holder.state.projects, secondProject],
  };
  const firstInput = batchInput(1, '项目甲相同请求');
  firstInput.projectId = firstProjectId;
  harness.holder.state.settings.videoExecutionMode = 'concurrent';
  harness.holder.state.settings.videoExecutionConcurrency = 2;
  const first = await harness.engine.startBatch(firstInput);
  await waitFor(() => posts === 1, 'first project POST did not start');
  const secondInput = batchInput(1, '项目乙相同请求');
  secondInput.projectId = secondProject.id;
  const second = await harness.engine.startBatch(secondInput);
  assert.equal(first.taskIds.length, 1);
  assert.equal(second.taskIds.length, 1, 'another project was incorrectly treated as the same fingerprint owner');
  await waitFor(() => posts === 2, 'second project identical request was not independently submitted');
  releasePosts.resolve();
  await waitFor(() => Boolean(videoTasks(harness.holder.state, firstProjectId)[0]?.remoteTaskId)
    && Boolean(videoTasks(harness.holder.state, secondProject.id)[0]?.remoteTaskId), 'project-scoped requests were not both acknowledged');
  harness.engine.dispose();
}

// A completed identical request is skipped by default and repeated only with explicit force.
{
  let posts = 0;
  const harness = createHarness({
    request: async (payload) => {
      if (payload.method !== 'POST') return response({ status: 'success', output: { url: 'https://cdn.example.test/batch.mp4' } });
      posts += 1;
      return response({ id: `success-${posts}`, status: 'success', output: { url: `https://cdn.example.test/batch-${posts}.mp4` } });
    },
  });
  const input = batchInput(1, '成功去重');
  input.projectId = harness.holder.state.project.id;
  await harness.engine.startBatch(input);
  await waitFor(() => videoTasks(harness.holder.state)[0]?.status === 'succeeded', 'first successful batch task did not complete');
  const skipped = await harness.engine.startBatch({ ...structuredClone(input), label: '成功去重再次点击' });
  assert.equal(skipped.taskIds.length, 0);
  assert.equal(skipped.skipped[0]?.reason, 'succeeded');
  const mixed = batchInput(3, '跳过后连续编号');
  mixed.projectId = harness.holder.state.project.id;
  const mixedResult = await harness.engine.startBatch(mixed);
  assert.equal(mixedResult.skipped[0]?.itemKey, 'batch-board-1:zh');
  assert.equal(mixedResult.taskIds.length, 2);
  const mixedTasks = mixedResult.taskIds.map((taskId) => videoTasks(harness.holder.state).find((task) => task.id === taskId)!);
  assert.deepEqual(mixedTasks.map((task) => task.batchIndex), [1, 2]);
  assert.deepEqual(mixedTasks.map((task) => task.batchTotal), [2, 2]);
  await waitFor(() => posts === 3, 'mixed batch did not submit its two new rows');
  const forced = await harness.engine.startBatch({ ...structuredClone(input), label: '明确再生成', force: true });
  assert.equal(forced.taskIds.length, 1);
  await waitFor(() => posts === 4, 'forced successful duplicate did not submit');
  harness.engine.dispose();
}

// Historical completion records may retain a stale transient job stage. Once a
// succeeded task has a saved asset, explicit regeneration must create a new
// task/asset instead of treating the old stage as an outstanding paid request.
for (const staleStage of ['preparing', 'queued', 'reconnecting', 'downloading'] as const) {
  let posts = 0;
  const harness = createHarness({
    request: async () => response({ id: `repeat-${++posts}`, status: 'success', output: { url: `https://cdn.example.test/repeat-${posts}.mp4` } }),
  });
  const input = batchInput(1, `历史完成状态-${staleStage}`);
  input.projectId = harness.holder.state.project.id;
  const first = await harness.engine.startBatch(input);
  await waitFor(() => Boolean(videoTasks(harness.holder.state)[0]?.resultAssetId), 'historical task did not save its video');
  await tick();
  const oldAsset = structuredClone(harness.holder.state.project.assets[0]);
  const oldTask = videoTasks(harness.holder.state)[0];
  oldTask.videoJob!.stage = staleStage;
  const forced = await harness.engine.startBatch({ ...structuredClone(input), force: true });
  assert.equal(forced.taskIds.length, 1, `saved success with stale ${staleStage} must allow explicit regeneration`);
  assert.notEqual(forced.taskIds[0], first.taskIds[0]);
  await waitFor(() => Boolean(videoTasks(harness.holder.state).find((task) => task.id === forced.taskIds[0])?.resultAssetId), 'regenerated task did not save');
  assert.equal(posts, 2);
  assert.deepEqual(harness.holder.state.project.assets.find((asset) => asset.id === oldAsset.id), oldAsset, 'regeneration must preserve the old video asset');
  assert.equal(videoTasks(harness.holder.state).find((task) => task.id === first.taskIds[0])?.resultAssetId, oldAsset.id);
  harness.engine.dispose();
}

// A generated remote result is not a saved video yet. Force never bypasses the
// real download in progress or an unknown POST outcome.
{
  const downloadGate = deferred();
  const harness = createHarness({
    request: async () => response({ id: 'download-boundary', status: 'success', output: { url: 'https://cdn.example.test/download-boundary.mp4' } }),
  });
  const download = harness.desktop.downloadGeneratedMedia;
  harness.desktop.downloadGeneratedMedia = async (payload) => { await downloadGate.promise; return download(payload); };
  const input = batchInput(1, '下载中不得再生成');
  input.projectId = harness.holder.state.project.id;
  const first = await harness.engine.startBatch(input);
  await waitFor(() => videoTasks(harness.holder.state)[0]?.videoJob?.stage === 'downloading', 'download gate was not reached');
  const downloading = await harness.engine.startBatch({ ...structuredClone(input), force: true });
  assert.equal(downloading.taskIds.length, 0);
  assert.equal(downloading.skipped[0]?.reason, 'in-flight');
  downloadGate.resolve();
  await waitFor(() => Boolean(videoTasks(harness.holder.state)[0]?.resultAssetId), 'gated download did not save');
  await tick();
  const uncertain = videoTasks(harness.holder.state)[0];
  uncertain.status = 'unknown';
  uncertain.videoJob!.stage = 'submission-unknown';
  const unknown = await harness.engine.startBatch({ ...structuredClone(input), force: true });
  assert.equal(unknown.taskIds.length, 0, 'unknown POST remains protected even when a damaged record contains an asset id');
  assert.equal(unknown.skipped[0]?.reason, 'in-flight');
  assert.equal(unknown.skipped[0]?.taskId, first.taskIds[0]);
  assert.equal(harness.requests.filter((request) => request.method === 'POST').length, 1);
  harness.engine.dispose();
}

// One known submission failure is isolated; later rows continue through the pump.
{
  const posted: string[] = [];
  const harness = createHarness({
    request: async (payload) => {
      if (payload.method !== 'POST') return response({ status: 'success', output: { url: 'https://cdn.example.test/isolated.mp4' } });
      const prompt = String((JSON.parse(payload.body || '{}') as { prompt?: string }).prompt || '');
      posted.push(prompt);
      if (prompt === 'batch prompt 2') return response({ message: 'rejected row' }, 400);
      return response({ id: `isolated-${posted.length}`, status: 'queued' });
    },
  });
  const input = batchInput(3, '失败隔离');
  input.projectId = harness.holder.state.project.id;
  const result = await harness.engine.startBatch(input);
  await waitFor(() => posted.length === 3, 'a failed row prevented later submissions');
  await waitFor(() => videoTasks(harness.holder.state).every((task) => task.videoJob?.batchQueueState === 'done'), 'batch rows did not leave the submission pump');
  const tasks = result.taskIds.map((taskId) => videoTasks(harness.holder.state).find((task) => task.id === taskId)!);
  assert.deepEqual(posted, ['batch prompt 1', 'batch prompt 2', 'batch prompt 3']);
  assert.ok(tasks[0].remoteTaskId);
  assert.equal(tasks[1].status, 'failed');
  assert.ok(tasks[2].remoteTaskId);
  harness.engine.dispose();
}

// Restarted ready/active rows are recovered only by the persisted bounded pump.
{
  const oldCheckpointRelease = deferred();
  let blockedOldActive = false;
  let blockFirstActive = true;
  const postReleases: Array<() => void> = [];
  let activePosts = 0;
  let maxActivePosts = 0;
  let posts = 0;
  const harness = createHarness({
    saveCheckpoint: async (task) => {
      if (blockFirstActive && task.videoJob?.batchQueueState === 'active' && task.videoJob.preparation?.phase === 'preparing') {
        blockFirstActive = false;
        blockedOldActive = true;
        await oldCheckpointRelease.promise;
      }
    },
    request: async (payload) => {
      if (payload.method !== 'POST') return response({ status: 'success', output: { url: 'https://cdn.example.test/restarted.mp4' } });
      posts += 1;
      activePosts += 1;
      maxActivePosts = Math.max(maxActivePosts, activePosts);
      await new Promise<void>((resolve) => postReleases.push(() => { activePosts -= 1; resolve(); }));
      return response({ id: `restart-${posts}`, status: 'queued' });
    },
  });
  const input = batchInput(6, '重启恢复');
  harness.holder.state.settings.videoExecutionMode = 'concurrent';
  harness.holder.state.settings.videoExecutionConcurrency = 2;
  input.projectId = harness.holder.state.project.id;
  input.concurrency = 2;
  await harness.engine.startBatch(input);
  await waitFor(() => blockedOldActive, 'old engine did not reach the recoverable active checkpoint');
  assert.equal(posts, 0);
  harness.engine.dispose();
  harness.holder.state = normalizeState(JSON.parse(JSON.stringify(harness.holder.state)));
  assert.equal(videoTasks(harness.holder.state).filter((task) => task.videoJob?.batchQueueState === 'active').length, 2);
  assert.equal(videoTasks(harness.holder.state).filter((task) => task.videoJob?.batchQueueState === 'ready').length, 4);
  const restored = new VideoGenerationEngine(harness.engineOptions);
  restored.reconcile();
  await waitFor(() => posts === 2, 'restored batch did not respect/start its two workers');
  assert.equal(maxActivePosts, 2);
  oldCheckpointRelease.resolve();
  for (let index = 0; index < 6; index += 1) {
    await waitFor(() => postReleases.length > index, `restored row ${index + 1} did not reach POST`);
    postReleases[index]();
  }
  await waitFor(() => videoTasks(harness.holder.state).every((task) => Boolean(task.remoteTaskId)), 'restored batch did not submit every row');
  assert.equal(posts, 6);
  assert.equal(maxActivePosts, 2);
  restored.dispose();
}

// A durable POST boundary with an unknown response is never treated as permission to retry after restart.
{
  let posts = 0;
  const harness = createHarness({
    request: async (payload) => {
      if (payload.method !== 'POST') return response({ status: 'processing' });
      posts += 1;
      throw new Error('connection dropped after POST');
    },
  });
  const input = batchInput(1, '未知提交结果');
  input.projectId = harness.holder.state.project.id;
  await harness.engine.startBatch(input);
  await waitFor(() => videoTasks(harness.holder.state)[0]?.videoJob?.stage === 'submission-unknown', 'task did not retain its uncertain POST boundary');
  harness.engine.dispose();
  harness.holder.state = normalizeState(JSON.parse(JSON.stringify(harness.holder.state)));
  const restored = new VideoGenerationEngine(harness.engineOptions);
  restored.reconcile();
  await tick(); await tick(); await tick();
  assert.equal(posts, 1);
  assert.equal(videoTasks(harness.holder.state)[0].status, 'unknown');
  const duplicate = await restored.startBatch({ ...structuredClone(input), label: '未知提交结果不得重投' });
  assert.equal(duplicate.taskIds.length, 0);
  assert.equal(duplicate.skipped[0]?.reason, 'in-flight');
  assert.equal(posts, 1, 'a submission-unknown task crossed POST and must retain duplicate ownership');
  restored.dispose();
}

// A shell whose initial project save failed has no trusted ready checkpoint.
// Reconciliation terminates it instead of leaving a permanent duplicate lock.
{
  let posts = 0;
  const harness = createHarness({
    persistState: async () => { throw new Error('disk unavailable'); },
    request: async (payload) => {
      if (payload.method === 'POST') posts += 1;
      return response({ id: 'must-not-submit', status: 'queued' });
    },
  });
  const input = batchInput(1, '无可信断点');
  input.projectId = harness.holder.state.project.id;
  await assert.rejects(() => harness.engine.startBatch(input), /disk unavailable/u);
  assert.equal(videoTasks(harness.holder.state)[0]?.videoJob?.batchQueueState, 'cancelled');
  assert.equal(harness.checkpoints.size, 0);
  assert.equal(posts, 0);
  harness.engine.reconcile();
  assert.equal(videoTasks(harness.holder.state)[0].status, 'failed');
  assert.equal(posts, 0);
  harness.engine.dispose();
}

// React may reconcile immediately after the batch shells enter state, while
// the initial project save and per-row journals are still pending.  Those
// in-process waiting shells must survive the effect, reach ready, and submit
// normally; they are not a restarted task with a missing journal.
{
  const initialPersistEntered = deferred();
  const releaseInitialPersist = deferred();
  const finalPersistEntered = deferred();
  const releaseFinalPersist = deferred();
  const firstCheckpointEntered = deferred();
  const releaseFirstCheckpoint = deferred();
  const releasePosts = deferred();
  let persistCalls = 0;
  let firstCheckpoint = true;
  let reconciledFromStateEffect = false;
  let activeEngine: VideoGenerationEngine | undefined;
  let posts = 0;
  const readyCheckpointIds = new Set<string>();
  const harness = createHarness({
    persistState: async () => {
      persistCalls += 1;
      if (persistCalls === 1) {
        initialPersistEntered.resolve();
        await releaseInitialPersist.promise;
      } else if (persistCalls === 2) {
        finalPersistEntered.resolve();
        await releaseFinalPersist.promise;
      }
    },
    saveCheckpoint: async (task) => {
      if (task.videoJob?.batchQueueState === 'ready') readyCheckpointIds.add(task.id);
      if (firstCheckpoint) {
        firstCheckpoint = false;
        firstCheckpointEntered.resolve();
        await releaseFirstCheckpoint.promise;
      }
    },
    transformState: (next, current) => {
      if (!reconciledFromStateEffect && videoTasks(next).some((task) => task.videoJob?.batchQueueState === 'waiting')) {
        reconciledFromStateEffect = true;
        // createHarness assigns holder.state after this transformer returns;
        // queue the effect so reconcile observes the committed shell state,
        // just as React's post-commit effect does.
        queueMicrotask(() => activeEngine?.reconcile());
      }
      return next;
    },
    request: async (payload) => {
      if (payload.method === 'POST') {
        posts += 1;
        await releasePosts.promise;
        return response({ id: `initialization-race-${posts}`, status: 'queued' });
      }
      return response({ status: 'success', output: { url: 'https://cdn.example.test/initialization-race.mp4' } });
    },
  });
  activeEngine = harness.engine;
  const input = batchInput(2, '初始化竞态保护');
  input.projectId = harness.holder.state.project.id;
  const started = harness.engine.startBatch(input);

  await initialPersistEntered.promise;
  assert.equal(reconciledFromStateEffect, true, 'the test must reconcile from the shell insertion state effect');
  let shells = videoTasks(harness.holder.state);
  assert.equal(shells.length, 2);
  assert.ok(shells.every((task) => task.videoJob?.batchQueueState === 'waiting'));
  assert.ok(shells.every((task) => task.videoJob?.trackingStopped !== true && task.videoJob?.stage !== 'stopped' && task.status !== 'failed'));
  assert.equal(posts, 0, 'a state effect must not submit before the initial project save');

  releaseInitialPersist.resolve();
  await firstCheckpointEntered.promise;
  shells = videoTasks(harness.holder.state);
  assert.ok(shells.every((task) => task.videoJob?.batchQueueState === 'waiting'));
  assert.ok(shells.every((task) => task.videoJob?.trackingStopped !== true && task.videoJob?.stage !== 'stopped' && task.status !== 'failed'));
  assert.equal(posts, 0, 'a state effect must not submit while the first journal is pending');

  releaseFirstCheckpoint.resolve();
  await waitFor(() => readyCheckpointIds.size === 2, 'all batch rows did not receive a ready checkpoint');
  await finalPersistEntered.promise;
  shells = videoTasks(harness.holder.state);
  assert.ok(shells.every((task) => task.videoJob?.batchQueueState === 'ready'));
  assert.ok(shells.every((task) => task.videoJob?.trackingStopped !== true && task.videoJob?.stage !== 'stopped' && task.status !== 'failed'));
  assert.equal(posts, 0, 'ready checkpoints must be established before the submission pump starts');

  releaseFinalPersist.resolve();
  await started;
  await waitFor(() => posts === 1, 'the initialized batch did not start its first POST');
  assert.ok(videoTasks(harness.holder.state).every((task) => task.videoJob?.trackingStopped !== true && task.videoJob?.stage !== 'stopped' && task.status !== 'failed'));
  releasePosts.resolve();
  await waitFor(() => videoTasks(harness.holder.state).every((task) => Boolean(task.remoteTaskId)), 'the initialized batch did not submit every row');
  assert.equal(posts, 2);
  harness.engine.dispose();
}

// The initialization guard is local to the live engine.  A genuinely
// restarted engine with a waiting/preparing record and no trusted journal
// must still stop it rather than treating the stale project JSON as POST
// permission.
{
  const persistEntered = deferred();
  const releasePersist = deferred();
  let posts = 0;
  const harness = createHarness({
    persistState: async () => {
      persistEntered.resolve();
      await releasePersist.promise;
      throw new Error('simulated process exit before journal');
    },
    request: async (payload) => {
      if (payload.method === 'POST') posts += 1;
      return response({ id: 'must-not-submit-after-restart', status: 'queued' });
    },
  });
  const input = batchInput(1, '重启缺少批量断点');
  input.projectId = harness.holder.state.project.id;
  const started = harness.engine.startBatch(input);
  await persistEntered.promise;
  const staleState = normalizeState(JSON.parse(JSON.stringify(harness.holder.state)));
  assert.equal(videoTasks(staleState)[0].videoJob?.batchQueueState, 'waiting');
  assert.equal(harness.checkpoints.size, 0);
  harness.engine.dispose();
  harness.holder.state = staleState;

  const restarted = new VideoGenerationEngine(harness.engineOptions);
  restarted.reconcile();
  await waitFor(() => videoTasks(harness.holder.state)[0]?.videoJob?.trackingStopped === true, 'a restarted batch without its journal was not stopped');
  assert.equal(videoTasks(harness.holder.state)[0].status, 'unknown');
  assert.equal(videoTasks(harness.holder.state)[0].videoJob?.batchQueueState, 'active');
  assert.equal(posts, 0);
  restarted.dispose();

  releasePersist.resolve();
  await assert.rejects(started, /simulated process exit/u);
}

// A project removed between preflight and insertion cannot produce ghost task IDs.
{
  let removed = false;
  let posts = 0;
  const harness = createHarness({
    transformState: (next, current) => {
      if (removed || next.project.generationTasks.length <= current.project.generationTasks.length) return next;
      removed = true;
      const replacement = {
        ...structuredClone(current.project), id: 'replacement-project',
        name: '保留项目', generationTasks: [], assets: [] as ReferenceAsset[],
      };
      return { ...next, project: replacement, activeProjectId: replacement.id, projects: [replacement] };
    },
    request: async (payload) => {
      if (payload.method === 'POST') posts += 1;
      return response({ id: 'ghost', status: 'queued' });
    },
  });
  const input = batchInput(2, '项目删除竞争');
  input.projectId = harness.holder.state.project.id;
  await assert.rejects(() => harness.engine.startBatch(input), /项目在创建任务前已被移除/u);
  assert.equal(removed, true);
  assert.equal(videoTasks(harness.holder.state).length, 0);
  assert.equal(posts, 0);
  harness.engine.dispose();
}

// Cancelling a batch stops only rows that have not crossed the POST boundary.
{
  const releasePost = deferred();
  let posts = 0;
  const harness = createHarness({
    request: async (payload) => {
      if (payload.method !== 'POST') return response({ status: 'processing' });
      posts += 1;
      await releasePost.promise;
      return response({ id: 'retained-server-task', status: 'queued' });
    },
  });
  const input = batchInput(3, '批次取消');
  input.projectId = harness.holder.state.project.id;
  const started = await harness.engine.startBatch(input);
  await waitFor(() => posts === 1 && videoTasks(harness.holder.state).some((task) => task.videoJob?.preparation?.phase === 'post-started'), 'first task did not cross POST boundary');
  const cancelled = await harness.engine.cancelBatch(started.batchId);
  assert.equal(cancelled.retainedTaskIds.length, 1);
  assert.equal(cancelled.cancelledTaskIds.length, 2);
  assert.equal(posts, 1);
  for (const taskId of cancelled.cancelledTaskIds) {
    const task = videoTasks(harness.holder.state).find((candidate) => candidate.id === taskId)!;
    assert.equal(task.videoJob?.batchQueueState, 'cancelled');
    assert.equal(task.status, 'failed');
    await assert.rejects(
      () => harness.engine.resume(taskId),
      /已在提交前停止/u,
      'a cancelled pre-POST batch row must never resume into a new billable POST',
    );
  }
  assert.equal(posts, 1, 'resuming cancelled pre-POST rows issued another POST');
  const fingerprintOwnerIds = [...(harness.engine as unknown as {
    requestFingerprintOwners: Map<string, string>;
  }).requestFingerprintOwners.values()];
  cancelled.cancelledTaskIds.forEach((taskId) => {
    assert.equal(fingerprintOwnerIds.includes(taskId), false, 'cancelled pre-POST row retained an engine fingerprint owner');
  });
  releasePost.resolve();
  await waitFor(() => Boolean(videoTasks(harness.holder.state).find((task) => task.id === cancelled.retainedTaskIds[0])?.remoteTaskId), 'already POST-started task was not retained');
  assert.equal(posts, 1);

  // Older app versions could leave this combination as `submitting + stopped`.
  // The durable preparation phase still proves no POST occurred.
  const legacyCancelled = videoTasks(harness.holder.state).find((task) => task.id === cancelled.cancelledTaskIds[0])!;
  legacyCancelled.status = 'submitting';
  const retryItem = input.items.find((item) => item.itemKey === legacyCancelled.batchItemKey)!;
  const restarted = await harness.engine.startBatch({
    projectId: input.projectId,
    label: '重新确认已取消段落',
    items: [structuredClone(retryItem)],
  });
  assert.equal(restarted.taskIds.length, 1, 'a newly confirmed batch must replace a cancelled pre-POST task');
  assert.notEqual(restarted.taskIds[0], legacyCancelled.id);
  await tick();
  assert.equal(posts, 1, 'a new confirmation must still wait for the retained remote task');
  harness.holder.state.settings.videoExecutionMode = 'concurrent';
  harness.holder.state.settings.videoExecutionConcurrency = 2;
  harness.engine.reconcile();
  await waitFor(() => posts === 2, 'an explicit concurrency increase did not admit the new confirmed row');
  harness.engine.dispose();
}

// cancelBatch must classify after its asynchronous cancel call. This controlled
// race advances the durable boundary while cancel() is delayed; the newer
// post-started state must be retained instead of overwritten as pre-POST cancelled.
{
  const activeCheckpoint = deferred();
  const releaseActiveCheckpoint = deferred();
  let blocked = false;
  const harness = createHarness({
    saveCheckpoint: async (task) => {
      if (!blocked && task.videoJob?.batchQueueState === 'active'
        && task.videoJob.preparation?.phase === 'preparing') {
        blocked = true;
        activeCheckpoint.resolve();
        await releaseActiveCheckpoint.promise;
      }
    },
  });
  const input = batchInput(1, '取消边界竞态');
  input.projectId = harness.holder.state.project.id;
  const started = await harness.engine.startBatch(input);
  await activeCheckpoint.promise;

  const cancelEntered = deferred();
  const releaseCancel = deferred();
  const originalCancel = harness.engine.cancel.bind(harness.engine);
  harness.engine.cancel = async (taskId: string) => {
    cancelEntered.resolve();
    await releaseCancel.promise;
    await originalCancel(taskId);
  };
  const cancelling = harness.engine.cancelBatch(started.batchId);
  await cancelEntered.promise;
  harness.holder.state = {
    ...harness.holder.state,
    project: {
      ...harness.holder.state.project,
      generationTasks: harness.holder.state.project.generationTasks.map((item) => {
        if (item.id !== started.taskIds[0]) return item;
        const task = item as VideoGenerationTask;
        return {
            ...task,
            status: 'submitting' as const,
            videoJob: task.videoJob ? {
              ...task.videoJob,
              batchQueueState: 'active' as const,
              stage: 'submitting' as const,
              preparation: { ...task.videoJob.preparation!, phase: 'post-started' as const },
            } : task.videoJob,
          };
      }),
    },
  };
  releaseCancel.resolve();
  const result = await cancelling;
  assert.deepEqual(result.cancelledTaskIds, []);
  assert.deepEqual(result.retainedTaskIds, started.taskIds);
  const retained = videoTasks(harness.holder.state).find((task) => task.id === started.taskIds[0])!;
  assert.notEqual(retained.videoJob?.batchQueueState, 'cancelled');
  assert.equal(retained.videoJob?.preparation?.phase, 'post-started');
  assert.equal(retained.videoJob?.trackingStopped, true, 'the possibly submitted remote task must remain explicitly trackable/resumable');
  releaseActiveCheckpoint.resolve();
  await tick();
  harness.engine.dispose();
}

// The task card follows the engine boundary and does not offer "resume query"
// for a cancelled row that never reached POST.
{
  const taskCardSource = readFileSync(new URL('../src/components/VideoDirectorView.tsx', import.meta.url), 'utf8');
  assert.match(taskCardSource, /const cancelledBeforePost = \(task\.videoJob\?\.batchQueueState === 'cancelled' \|\| task\.videoJob\?\.tailPreparation\?\.phase === 'cancelled'\)[\s\S]*?preparation\?\.phase === 'preparing'[\s\S]*?!task\.remoteTaskId && task\.status !== 'unknown';/u);
  assert.match(taskCardSource, /onResume && !cancelledBeforePost &&/u);
}

console.log('video batch generation tests passed: atomic preflight, bounded order, project ownership, idempotency, failure isolation, restart safety and pre-POST cancellation');

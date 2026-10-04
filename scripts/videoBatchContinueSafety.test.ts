import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { AppState, Project, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoBatchResumeResult, VideoBatchStartInput, VideoBatchStartResult, VideoGenerationDesktop } from '../src/videoGenerationTypes';
import type { VideoTailFrameSelectionResult } from '../src/videoFrameSelection';

// Independent boundary tests. No real API, credentials, media, production
// project storage or production task is read or written. The journal round-trip
// cases use only fresh, checked temporary directories for fixture JSON.
const require = createRequire(import.meta.url);
const { createVideoTaskCheckpointJournal } = require('../electron/videoTaskCheckpoint.cjs') as {
  createVideoTaskCheckpointJournal: (options: { directory: string; atomicWriteFile: (file: string, content: string) => void }) => {
    save: (task: VideoGenerationTask) => { persisted: boolean };
    get: (taskId: string) => VideoGenerationTask | null;
  };
};
type ContinueEngine = VideoGenerationEngine & {
  resumeBatch(batchId: string): Promise<VideoBatchResumeResult>;
  confirmContinueBatch(planId: string, signal?: AbortSignal): Promise<VideoBatchStartResult>;
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let index = 0; index < 10; index += 1) await tick(); };
const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 600; attempt += 1) { if (condition()) return; await tick(); }
  assert.fail(label);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const config: VideoTaskApiConfig = {
  enabled: true, endpoint: 'https://continue-fixture.example.test/generate',
  statusEndpointTemplate: 'https://continue-fixture.example.test/tasks/{id}',
  apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', provider: 'generic', model: 'fixture-model',
};
const frame = (index: number) => ({
  fileName: `selected-${index}.png`, relativePath: `image/selected-${index}.png`, checksum: `selected-${index}`,
  sizeBytes: 8, mediaType: 'image' as const, mimeType: 'image/png', managed: true, missing: false,
  url: `lianhua-asset://local/image/selected-${index}.png`, timeSec: 8.5, frameIndex: 85,
  width: 640, height: 360, role: 'custom-frame' as const,
});
const selectedFrame = (index: number): VideoTailFrameSelectionResult => ({
  frame: frame(index),
  selection: { source: 'ai', selectedId: `candidate-${index}`, reason: 'AI根据准确上一段成片选择衔接状态。',
    selectedTimeSec: 8.5, lastFrameTimeSec: 9.9, offsetFromEndSec: 1.4, candidateCount: 1 },
  candidates: [{ id: `candidate-${index}`, timeSec: 8.5, isLastFrame: false, frame: frame(index) }],
});
type PostMode = 'failed' | 'unknown' | 'success';
const harness = (mode: PostMode = 'failed') => {
  const holder = { state: createInitialState(), failAi: false, failLocal: false, failedPosts: new Set<number>(),
    holdAi: undefined as ReturnType<typeof deferred> | undefined, holdLocal: undefined as ReturnType<typeof deferred> | undefined };
  holder.state.settings.videoTaskApi = { ...config };
  const requests: Array<Parameters<VideoGenerationDesktop['videoRequest']>[0]> = [];
  const journals = new Map<string, VideoGenerationTask>();
  const selectedSources: unknown[] = [];
  const rawExtractions: unknown[] = [];
  const cancelledExtractions: string[] = [];
  let posts = 0;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (payload) => {
      requests.push(payload);
      if (payload.method === 'POST' && payload.url === config.endpoint) {
        posts += 1;
        if (posts === 2 && mode === 'unknown') throw new Error('fixture connection lost after generation POST');
        if (posts === 2 && mode === 'failed' || holder.failedPosts.has(posts)) return response({ id: `remote-failed-${posts}`, status: 'failed', message: 'fixture provider terminal failure' });
        return response({ id: `remote-success-${posts}`, status: 'succeeded', url: `https://cdn.example.test/continue-${posts}.mp4` });
      }
      if (/\/remote-failed-\d+$/u.test(payload.url)) return response({ id: payload.url.split('/').at(-1), status: 'failed', message: 'fixture provider terminal failure' });
      return response({ status: 'processing' });
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (task) => { journals.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(journals.get(taskId) || null), deleteVideoTaskCheckpoint: async () => true,
    downloadGeneratedMedia: async (payload) => ({
      fileName: `${payload.fileName}.mp4`, relativePath: `video/${payload.fileName}.mp4`, checksum: `movie-${payload.requestId}`,
      sizeBytes: 8, mediaType: 'video', managed: true, missing: false, url: `lianhua-asset://local/video/${payload.fileName}.mp4`,
    }),
    readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => ({ dataUrl: `data:image/png;base64,${expectedChecksum || relativePath}`, mimeType: 'image/png', sizeBytes: 8, checksum: expectedChecksum || relativePath }),
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'mock' }),
    extractWorkbenchFrames: async (request) => {
      rawExtractions.push(request);
      if (holder.failLocal) throw new Error('fixture local extraction temporarily unavailable');
      if (holder.holdLocal) await holder.holdLocal.promise;
      return { probe: { durationSec: 10, width: 640, height: 360, fps: 10, hasAudio: true, videoCodec: 'h264' },
        frames: [{ ...frame(999), role: 'last-frame', timeSec: 9.9, frameIndex: 99 }] };
    },
    cancelWorkbenchJob: async (jobId) => { cancelledExtractions.push(jobId); return true; },
  };
  const options: VideoGenerationEngineOptions = {
    getState: () => holder.state,
    setState: (updater: (current: AppState) => AppState) => { holder.state = updater(holder.state); },
    desktop, onRuntime: () => {}, pollIntervalMs: 60_000, persistState: async () => {},
    selectTailFrame: async (input) => {
      assert.equal(input.requireAiSelection, true);
      selectedSources.push(structuredClone(input.source));
      await input.onBeforeAI?.();
      if (holder.failAi) throw new Error('fixture vision failed before a selected frame');
      const selected = selectedFrame(selectedSources.length);
      if (holder.holdAi) await holder.holdAi.promise;
      return selected;
    },
  };
  const engine = new VideoGenerationEngine(options) as ContinueEngine;
  const generationRequests = () => requests.filter((request) => request.method === 'POST' && request.url === config.endpoint);
  const tasks = (batchId?: string) => holder.state.project.generationTasks
    .filter((task): task is VideoGenerationTask => task.kind === 'video' && (!batchId || task.batchId === batchId))
    .sort((left, right) => (left.batchIndex || 0) - (right.batchIndex || 0));
  return { holder, engine, options, desktop, journals, requests, tasks, generationRequests, selectedSources, rawExtractions, cancelledExtractions };
};
type Harness = ReturnType<typeof harness>;
const restart = (h: Harness) => {
  h.engine.dispose();
  // Exercise the actual production JSON encoder/normalizer, not just an object
  // clone: a dropped continuation claim must not become another paid request.
  h.holder.state = normalizeState(JSON.parse(serializeStateForStorage(h.holder.state).serialized));
  for (const [taskId, task] of h.journals) h.journals.set(taskId, JSON.parse(JSON.stringify(task)) as VideoGenerationTask);
  h.engine = new VideoGenerationEngine(h.options) as ContinueEngine;
};
const inputFor = (projectId: string, count = 3, aiAssisted = true): VideoBatchStartInput => ({
  projectId, label: '续跑安全测试', concurrency: 1,
  items: Array.from({ length: count }, (_, index) => ({
    itemKey: `board-${index + 1}:zh`,
    draft: { name: `段${index + 1}`, prompt: `unchanged-prompt-${index + 1}`, backend: 'api', references: [], parameters: { seed: 100 + index },
      source: { storyboardId: `board-${index + 1}`, sequencePlanId: 'sequence', segmentId: `segment-${index + 1}`, segmentIndex: index + 1, language: 'zh', label: `段${index + 1}` } },
    ...(index > 0 ? { previousTail: { predecessorItemKey: `board-${index}:zh`, placement: { mode: 'append' as const, index: 0, role: 'first-frame' as const },
      ...(aiAssisted ? { selectionMode: 'ai-assisted' as const, requireAiSelection: true as const } : {}) } } : {}),
  })),
});
const stopFixture = async (h: Harness, tailBlocked = false) => {
  h.holder.failAi = tailBlocked;
  const batch = await h.engine.startBatch(inputFor(h.holder.state.project.id));
  await waitFor(() => tailBlocked ? h.tasks(batch.batchId)[1]?.videoJob?.tailPreparation?.phase === 'blocked'
    : ['failed', 'unknown'].includes(h.tasks(batch.batchId)[1]?.status || ''), 'fixture did not reach failed/unknown second task');
  await h.engine.cancelBatch(batch.batchId);
  await settle();
  return batch;
};
const stopLocalFixture = async (h: Harness, cancelled = true) => {
  h.holder.failLocal = true;
  const batch = await h.engine.startBatch(inputFor(h.holder.state.project.id, 3, false));
  await waitFor(() => h.tasks(batch.batchId)[1]?.videoJob?.tailPreparation?.phase === 'blocked', 'local fixture did not stop before a tail was frozen');
  if (cancelled) await h.engine.cancelBatch(batch.batchId);
  await settle();
  h.holder.failLocal = false;
  return batch;
};
const tests: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });

for (const cancelled of [false, true]) test(`local ${cancelled ? 'cancelled' : 'blocked'} chain continuation extracts the exact parent last frame without vision`, async () => {
  const h = harness('success');
  try {
    if (cancelled) h.options.selectTailFrame = undefined;
    else h.options.selectTailFrame = async () => { throw new Error('vision must not run for a local tail chain'); };
    const batch = await stopLocalFixture(h, cancelled);
    const parent = h.tasks(batch.batchId)[0];
    const parentAsset = h.holder.state.project.assets.find((asset) => asset.id === parent.resultAssetId)!;
    h.holder.state.project.assets.push({ ...parentAsset, id: 'newer-unrelated-local-movie', sourceVideoTaskId: 'unrelated-task',
      relativePath: 'video/unrelated-local.mp4', checksum: 'unrelated-local-checksum', createdAt: Date.now() + 10000, updatedAt: Date.now() + 10000 });
    const beforeExtractions = h.rawExtractions.length;
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation);
    assert.equal(summary.continuation.requiresAiTail, false, 'local preparation must not be advertised as an AI operation');
    assert.equal(h.rawExtractions.length, beforeExtractions, 'opening continuation does not prepare a new frame');
    const continued = await h.engine.confirmContinueBatch(summary.continuation.id);
    await waitFor(() => h.tasks(continued.batchId).length === 2 && h.tasks(continued.batchId).every((task) => Boolean(task.resultAssetId)), 'local continued suffix did not finish');
    const request = h.rawExtractions[beforeExtractions] as { mode: string; source: { assetId: string; relativePath: string; expectedChecksum: string } };
    assert.equal(request.mode, 'last');
    assert.deepEqual(request.source, { assetId: parentAsset.id, relativePath: parentAsset.relativePath, expectedChecksum: parentAsset.checksum },
      'continuation must use its saved predecessor, never a newer unrelated video');
    const first = h.tasks(continued.batchId)[0];
    const image = first.videoJob!.snapshot.images[0];
    const asset = h.holder.state.project.assets.find((candidate) => candidate.id === image.assetId)!;
    assert.equal(asset.type, 'last-frame');
    assert.equal(asset.role, 'last-frame');
    assert.equal(asset.referenceRole, 'first-frame');
    assert.equal(asset.sourceVideoAssetId, parentAsset.id);
    assert.equal(asset.sourceVideoChecksum, parentAsset.checksum);
    assert.equal(asset.sourceTimeSec, 9.9);
    assert.equal(asset.sourceFrameIndex, 99);
    assert.equal(asset.checksum, 'selected-999');
    assert.equal(image.dataUrl, 'data:image/png;base64,selected-999', 'the fixture without a managed snapshot writer freezes the exact selected pixels');
    assert.equal(image.freezeState, 'frozen');
    assert.equal(h.selectedSources.length, 0);
    assert.deepEqual(h.generationRequests().map((entry) => JSON.parse(entry.body!).prompt), ['unchanged-prompt-1', 'unchanged-prompt-2', 'unchanged-prompt-3']);
    assert.equal(h.journals.get(h.tasks(batch.batchId)[1].id)?.videoJob?.batchContinuation?.taskId, first.id,
      'local preparation keeps the same durable source-to-child claim');
  } finally { h.engine.dispose(); }
});

test('cancelling local continuation cancels its extraction job and rejects a late saved frame', async () => {
  const h = harness('success');
  try {
    h.options.selectTailFrame = undefined;
    const batch = await stopLocalFixture(h);
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation);
    h.holder.holdLocal = deferred();
    const beforeExtractions = h.rawExtractions.length;
    const controller = new AbortController();
    const pending = h.engine.confirmContinueBatch(summary.continuation.id, controller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitFor(() => h.rawExtractions.length > beforeExtractions, 'local continuation did not reach delayed extraction');
    const request = h.rawExtractions[beforeExtractions] as { jobId: string };
    controller.abort();
    assert.ok(h.cancelledExtractions.includes(request.jobId), 'abort must stop the exact local workbench job');
    h.holder.holdLocal.resolve();
    await rejected;
    await settle();
    assert.equal(h.generationRequests().length, 1);
    assert.equal(h.selectedSources.length, 0);
    assert.equal(h.holder.state.project.assets.some((asset) => asset.id.startsWith('asset_continue_tail')), false,
      'a late cancelled extraction cannot be bound to the project');
    assert.ok(h.tasks(batch.batchId).slice(1).every((task) => task.videoJob?.batchContinuation?.released));
  } finally { h.holder.holdLocal?.resolve(); h.engine.dispose(); }
});

for (const change of ['source', 'project'] as const) test(`local continuation rejects a delayed frame after its ${change} changes`, async () => {
  const h = harness('success');
  try {
    h.options.selectTailFrame = async () => { throw new Error('no vision allowed'); };
    const batch = await stopLocalFixture(h);
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation);
    h.holder.holdLocal = deferred();
    const beforeExtractions = h.rawExtractions.length;
    const pending = h.engine.confirmContinueBatch(summary.continuation.id);
    const rejected = assert.rejects(pending, /变化|项目|取消|失效|批次/u);
    await waitFor(() => h.rawExtractions.length > beforeExtractions, 'local continuation did not reach delayed extraction');
    let untouchedProject: string | undefined;
    if (change === 'source') {
      const parent = h.tasks(batch.batchId)[0];
      h.holder.state.project.assets.find((asset) => asset.id === parent.resultAssetId)!.checksum = 'changed-local-parent-bytes';
    } else {
      const previous = h.holder.state.project;
      const next = createInitialState().project;
      next.id = 'local-next-project';
      untouchedProject = JSON.stringify(next);
      h.holder.state = { ...h.holder.state, project: next, projects: [previous, next] };
    }
    h.holder.holdLocal.resolve();
    await rejected;
    await settle();
    assert.equal(h.generationRequests().length, 1);
    assert.equal(h.selectedSources.length, 0);
    assert.equal(h.holder.state.project.assets.some((asset) => asset.id.startsWith('asset_continue_tail')), false);
    if (untouchedProject) assert.equal(JSON.stringify(h.holder.state.project), untouchedProject);
  } finally { h.holder.holdLocal?.resolve(); h.engine.dispose(); }
});

test('success prefix is not regenerated; duplicate confirmations create only one frozen suffix', async () => {
  const h = harness();
  try {
    const batch = await stopFixture(h);
    const originals = structuredClone(h.tasks(batch.batchId));
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation, 'failed and cancelled suffix requires explicit new-generation confirmation');
    assert.deepEqual(summary.completedTaskIds, [originals[0].id]);
    assert.deepEqual(summary.continuation.items.map((item) => item.taskId), originals.slice(1).map((task) => task.id));
    assert.equal(h.generationRequests().length, 2, 'opening continuation does not secretly generate');
    const [first, duplicate] = await Promise.all([h.engine.confirmContinueBatch(summary.continuation.id), h.engine.confirmContinueBatch(summary.continuation.id)]);
    assert.equal(first.batchId, duplicate.batchId);
    await waitFor(() => h.tasks(first.batchId).length === 2 && h.tasks(first.batchId).every((task) => Boolean(task.resultAssetId)), 'new suffix did not complete');
    const posts = h.generationRequests().map((request) => JSON.parse(request.body!));
    assert.deepEqual(posts.map((body) => body.prompt), ['unchanged-prompt-1', 'unchanged-prompt-2', 'unchanged-prompt-2', 'unchanged-prompt-3']);
    assert.equal(posts[2].seed, 101, 'continuation preserves original per-item parameters');
    assert.equal(posts[2].first_frame_image, posts[1].first_frame_image, 'first suffix reuses the exact frozen frame from the old successful parent');
    assert.equal(h.selectedSources.length, 2, 'old ready frame incurs no additional AI selection; only new successor needs it');
    assert.deepEqual(h.tasks(batch.batchId).map((task) => [task.id, task.remoteTaskId, task.videoJob?.preparation?.phase]), originals.map((task) => [task.id, task.remoteTaskId, task.videoJob?.preparation?.phase]));
    assert.equal(h.rawExtractions.length, 0, 'strict AI continuation never falls back to raw last-frame extraction');
  } finally { h.engine.dispose(); }
});

test('unknown POST without remote ID never becomes a billable suffix', async () => {
  const h = harness('unknown');
  try {
    const batch = await stopFixture(h);
    const unknown = h.tasks(batch.batchId)[1];
    assert.equal(unknown.videoJob?.preparation?.phase, 'post-started');
    assert.equal(unknown.remoteTaskId, undefined);
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.equal(summary.continuation, undefined);
    assert.ok(summary.issues.length || summary.waitingTaskIds.includes(unknown.id));
    await settle();
    assert.equal(h.generationRequests().length, 2, 'the uncertain paid request is never repeated');
  } finally { h.engine.dispose(); }
});

test('previewing a not-cancelled AI-preparation failure cannot select AI or submit a first POST before confirmation', async () => {
  const h = harness('success');
  try {
    h.holder.failAi = true;
    const batch = await h.engine.startBatch(inputFor(h.holder.state.project.id));
    await waitFor(() => h.tasks(batch.batchId)[1]?.videoJob?.tailPreparation?.phase === 'blocked', 'uncancelled fixture did not stop at local AI preparation failure');
    const originals = h.tasks(batch.batchId);
    assert.equal(originals[1].videoJob?.preparation?.phase, 'preparing');
    assert.equal(originals[1].remoteTaskId, undefined);
    assert.notEqual(originals[1].videoJob?.batchQueueState, 'cancelled');
    h.holder.failAi = false;
    const postsBefore = h.generationRequests().length;
    const aiBefore = h.selectedSources.length;
    const preview = await h.engine.resumeBatch(batch.batchId);
    await settle();
    assert.equal(h.generationRequests().length, postsBefore, 'Continue preview is not authorization for a never-submitted failed preparation to POST');
    assert.equal(h.selectedSources.length, aiBefore, 'Continue preview is not authorization for another potentially paid AI selection');
    assert.ok(preview.continuation, 'safe pre-POST failures still need a usable explicit confirmation plan');
    assert.deepEqual(preview.continuation.items.map((item) => item.taskId), originals.slice(1).map((task) => task.id));
  } finally { h.engine.dispose(); }
});

test('previewing an ordinary image-preparation failure cannot submit its first generation POST', async () => {
  const h = harness('success');
  try {
    const sourceImage = { ...frame(101), id: 'fixture-input-image', name: '冻结原参考图', type: 'reference' as const,
      role: 'composition' as const, source: 'derived' as const, tags: [], createdAt: 1, updatedAt: 1 };
    h.holder.state.project.assets.push(sourceImage);
    const input = inputFor(h.holder.state.project.id, 1);
    input.items[0].draft.references = [{ assetId: sourceImage.id, role: 'first-frame' }];
    const readImage = h.desktop.readManagedImageDataUrl;
    h.desktop.readManagedImageDataUrl = async () => { throw new Error('fixture image temporarily unavailable during preparation'); };
    const batch = await h.engine.startBatch(input);
    await waitFor(() => h.tasks(batch.batchId)[0]?.status === 'failed', 'ordinary fixture did not reach image preparation failure');
    assert.equal(h.tasks(batch.batchId)[0].videoJob?.preparation?.phase, 'preparing');
    assert.equal(h.tasks(batch.batchId)[0].remoteTaskId, undefined);
    assert.notEqual(h.tasks(batch.batchId)[0].videoJob?.batchQueueState, 'cancelled');
    assert.equal(h.generationRequests().length, 0);
    h.desktop.readManagedImageDataUrl = readImage;
    const preview = await h.engine.resumeBatch(batch.batchId);
    await settle();
    assert.equal(h.generationRequests().length, 0, 'opening confirmation cannot silently perform a first paid POST after ordinary local preparation recovery');
    assert.ok(preview.continuation);
    assert.equal(preview.continuation.items.length, 1);
    assert.equal(preview.continuation.items[0].willRegenerate, false, 'no original generation POST was made');
  } finally { h.engine.dispose(); }
});

test('same batch ID in another project cannot mutate or submit that project', async () => {
  const h = harness();
  try {
    const batch = await stopFixture(h);
    const other: Project = structuredClone(h.holder.state.project);
    other.id = 'other-project';
    other.generationTasks = other.generationTasks.map((raw) => {
      const task = raw as VideoGenerationTask;
      return { ...task, id: `other-${task.id}`, videoJob: task.videoJob ? { ...task.videoJob, snapshot: { ...task.videoJob.snapshot, projectId: other.id, connection: { ...task.videoJob.snapshot.connection, api: { ...task.videoJob.snapshot.connection.api!, endpoint: 'https://other-project.example.test/generate' } } } } : undefined };
    });
    h.holder.state = { ...h.holder.state, projects: [...h.holder.state.projects, other] };
    const savedOther = JSON.stringify(other);
    try {
      const summary = await h.engine.resumeBatch(batch.batchId);
      if (summary.continuation) assert.equal(summary.continuation.projectId, h.holder.state.project.id);
      assert.ok(!summary.resumedTaskIds.some((id) => id.startsWith('other-')));
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /项目|批次|唯一|归属/u, 'ambiguous IDs may be safely refused');
    }
    await settle();
    assert.equal(JSON.stringify(h.holder.state.projects.find((project) => project.id === other.id)), savedOther);
    assert.ok(!h.requests.some((request) => request.url.includes('other-project')));
  } finally { h.engine.dispose(); }
});

test('missing first suffix frame uses the exact old selected parent, not a newer unrelated video', async () => {
  const h = harness('success');
  try {
    const batch = await stopFixture(h, true);
    const parent = h.tasks(batch.batchId)[0];
    const parentAsset = h.holder.state.project.assets.find((asset) => asset.id === parent.resultAssetId)!;
    h.holder.state.project.assets.push({ ...parentAsset, id: 'unrelated-newest-movie', sourceVideoTaskId: 'unrelated-task', relativePath: 'video/unrelated.mp4', checksum: 'unrelated-checksum', createdAt: Date.now() + 100000, updatedAt: Date.now() + 100000 });
    h.holder.failAi = false;
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation?.requiresAiTail);
    const resumed = await h.engine.confirmContinueBatch(summary.continuation.id);
    await waitFor(() => h.tasks(resumed.batchId).length === 2 && h.tasks(resumed.batchId).every((task) => Boolean(task.resultAssetId)), 'strict-AI suffix did not finish');
    const restoredSource = h.selectedSources[1] as { assetId?: string; relativePath?: string; expectedChecksum?: string };
    assert.equal(restoredSource.assetId, parentAsset.id);
    assert.equal(restoredSource.relativePath, parentAsset.relativePath);
    assert.equal(restoredSource.expectedChecksum, parentAsset.checksum);
    assert.equal(h.generationRequests().filter((request) => JSON.parse(request.body!).prompt === 'unchanged-prompt-1').length, 1);
  } finally { h.engine.dispose(); }
});

test('cancellation while AI returns late never starts suffix generation', async () => {
  const h = harness('success');
  try {
    const batch = await stopFixture(h, true);
    h.holder.failAi = false;
    h.holder.holdAi = deferred();
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation?.requiresAiTail);
    const controller = new AbortController();
    const pending = h.engine.confirmContinueBatch(summary.continuation.id, controller.signal);
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof Error && (error.name === 'AbortError' || /取消|失效/u.test(error.message)));
    await waitFor(() => h.selectedSources.length === 2, 'continuation did not reach delayed AI selection');
    controller.abort();
    h.holder.holdAi.resolve();
    await rejected;
    await settle();
    assert.equal(h.generationRequests().length, 1, 'a late selected frame cannot release any new generation POST');
    assert.ok(h.tasks(batch.batchId).slice(1).every((task) => task.videoJob?.batchQueueState === 'cancelled'));
  } finally { h.engine.dispose(); }
});

test('changed parent after confirmation planning invalidates the suffix before generation', async () => {
  const h = harness();
  try {
    const batch = await stopFixture(h);
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation);
    const parent = h.tasks(batch.batchId)[0];
    const asset = h.holder.state.project.assets.find((candidate) => candidate.id === parent.resultAssetId)!;
    asset.checksum = 'changed-parent-bytes';
    await assert.rejects(h.engine.confirmContinueBatch(summary.continuation.id), /变化|失效|校验|不一致|衔接/u);
    assert.equal(h.generationRequests().length, 2);
  } finally { h.engine.dispose(); }
});

test('historical chain holes never regenerate successful middle tasks or reconnect across them', async () => {
  const h = harness('success');
  try {
    const batch = await h.engine.startBatch(inputFor(h.holder.state.project.id, 4));
    await waitFor(() => h.tasks(batch.batchId).length === 4 && h.tasks(batch.batchId).every((task) => Boolean(task.resultAssetId)), 'four-task completed fixture was not saved');
    const originals = structuredClone(h.tasks(batch.batchId));
    const failedIds = new Set([originals[1].id, originals[3].id]);
    h.holder.state.project.generationTasks = h.holder.state.project.generationTasks.map((raw) => {
      if (!failedIds.has(raw.id)) return raw;
      const task = raw as VideoGenerationTask;
      const failed: VideoGenerationTask = { ...task, status: 'failed', resultAssetId: undefined, resultUrl: undefined,
        response: { id: task.remoteTaskId, status: 'failed' }, videoJob: { ...task.videoJob!, stage: 'failed', resultAssetIds: undefined, downloadError: undefined } };
      h.journals.set(failed.id, structuredClone(failed));
      return failed;
    });
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.equal(summary.continuation, undefined);
    assert.ok(summary.issues.some((issue) => /夹有已成功段|前驱|新链/u.test(issue.message)));
    assert.ok(summary.completedTaskIds.includes(originals[0].id) && summary.completedTaskIds.includes(originals[2].id));
    await settle();
    assert.equal(h.generationRequests().length, 4, 'a gap cannot cause regeneration of the old successful middle task');
  } finally { h.engine.dispose(); }
});

test('reopening the original batch after successful continuation does not create another AI frame or video copy', async () => {
  const h = harness('success');
  try {
    const batch = await stopFixture(h, true);
    h.holder.failAi = false;
    const first = await h.engine.resumeBatch(batch.batchId);
    assert.ok(first.continuation);
    const continued = await h.engine.confirmContinueBatch(first.continuation.id);
    await waitFor(() => h.tasks(continued.batchId).length === 2 && h.tasks(continued.batchId).every((task) => Boolean(task.resultAssetId)), 'first continuation has not completed');
    const submitted = h.generationRequests().length;
    const analyses = h.selectedSources.length;
    const reopened = await h.engine.resumeBatch(batch.batchId);
    if (reopened.continuation) await h.engine.confirmContinueBatch(reopened.continuation.id);
    await settle();
    assert.equal(h.generationRequests().length, submitted, 'Continue is not permission to create another copy of already-continued successful items');
    assert.equal(h.selectedSources.length, analyses, 'an already-continued original cannot repeat AI analysis with a fresh fingerprint');
  } finally { h.engine.dispose(); }
});

test('normalized restart retains continuation ownership and opening an old batch cannot regenerate its completed suffix', async () => {
  const h = harness('success');
  try {
    const batch = await stopFixture(h, true);
    h.holder.failAi = false;
    const initial = await h.engine.resumeBatch(batch.batchId);
    assert.ok(initial.continuation);
    const continued = await h.engine.confirmContinueBatch(initial.continuation.id);
    await waitFor(() => h.tasks(continued.batchId).length === 2 && h.tasks(continued.batchId).every((task) => Boolean(task.resultAssetId)), 'suffix did not complete before restart');
    const posted = h.generationRequests().length;
    const aiCalls = h.selectedSources.length;
    const resultIds = h.tasks(continued.batchId).map((task) => task.resultAssetId);
    restart(h);
    const reopened = await h.engine.resumeBatch(batch.batchId);
    if (reopened.continuation) await h.engine.confirmContinueBatch(reopened.continuation.id);
    await settle();
    assert.equal(h.generationRequests().length, posted, 'persisted ownership must prevent regeneration after process restart');
    assert.equal(h.selectedSources.length, aiCalls, 'restart must not forget that the old selected suffix has already continued');
    assert.deepEqual(h.tasks(continued.batchId).map((task) => task.resultAssetId), resultIds);
  } finally { h.engine.dispose(); }
});

test('two distinct confirmation plans for one stopped suffix share ownership before paid AI or video work', async () => {
  const h = harness('success');
  try {
    const batch = await stopFixture(h, true);
    h.holder.failAi = false;
    const first = await h.engine.resumeBatch(batch.batchId);
    const second = await h.engine.resumeBatch(batch.batchId);
    assert.ok(first.continuation && second.continuation);
    h.holder.holdAi = deferred();
    const confirmations = Promise.allSettled([
      h.engine.confirmContinueBatch(first.continuation.id),
      h.engine.confirmContinueBatch(second.continuation.id),
    ]);
    await waitFor(() => h.selectedSources.length >= 2, 'neither plan started the requested AI selection');
    h.holder.holdAi.resolve();
    const results = await confirmations;
    const completed = results.filter((result): result is PromiseFulfilledResult<VideoBatchStartResult> => result.status === 'fulfilled');
    assert.ok(completed.length, 'one confirmed plan should continue');
    assert.equal(new Set(completed.map((result) => result.value.batchId)).size, 1, 'different confirmation tokens cannot own two replacement batches for the same source items');
    const next = completed[0].value;
    await waitFor(() => h.tasks(next.batchId).length === 2 && h.tasks(next.batchId).every((task) => Boolean(task.resultAssetId)), 'winning plan suffix did not complete');
    await settle();
    assert.equal(h.generationRequests().length, 3, 'only original success and two requested replacement items may POST');
    assert.equal(h.selectedSources.length, 3, 'losing plan must not spend another AI request before losing source ownership');
  } finally { h.holder.holdAi?.resolve(); h.engine.dispose(); }
});

test('unknown POST checkpoint dominates a stale preparing main-state entry after restart', async () => {
  const h = harness('unknown');
  try {
    const batch = await stopFixture(h);
    const ambiguous = h.tasks(batch.batchId)[1];
    assert.equal(ambiguous.videoJob?.preparation?.phase, 'post-started');
    const journal = h.journals.get(ambiguous.id)!;
    assert.equal(journal.videoJob?.preparation?.phase, 'post-started');
    h.engine.dispose();
    // Simulate the main file lagging behind the durable pre-POST boundary.
    h.holder.state.project.generationTasks = h.holder.state.project.generationTasks.map((raw) => raw.id !== ambiguous.id ? raw : {
      ...ambiguous, status: 'draft', error: undefined, response: undefined, updatedAt: ambiguous.createdAt,
      videoJob: { ...ambiguous.videoJob!, stage: 'preparing', trackingStopped: false, batchQueueState: 'ready',
        preparation: { ...ambiguous.videoJob!.preparation!, phase: 'preparing' } },
    });
    restart(h);
    const recovered = await h.engine.resumeBatch(batch.batchId);
    assert.equal(recovered.continuation, undefined, 'ambiguous original POST is not a terminal failed-generation authorization');
    await settle();
    assert.equal(h.generationRequests().length, 2, 'higher-ranked checkpoint must prevent a repeated unknown POST');
    assert.equal(h.tasks(batch.batchId)[1].videoJob?.preparation?.phase, 'post-started');
    assert.ok(recovered.issues.length || recovered.waitingTaskIds.includes(ambiguous.id));
  } finally { h.engine.dispose(); }
});

test('original batch cannot create a second suffix when its continued descendant has an unknown POST', async () => {
  const h = harness('unknown');
  try {
    const batch = await stopFixture(h, true);
    h.holder.failAi = false;
    const initial = await h.engine.resumeBatch(batch.batchId);
    assert.ok(initial.continuation);
    const continued = await h.engine.confirmContinueBatch(initial.continuation.id);
    await waitFor(() => h.tasks(continued.batchId)[0]?.status === 'unknown', 'continued descendant did not reach unknown POST');
    const submitted = h.generationRequests().length;
    const aiCalls = h.selectedSources.length;
    restart(h);
    const reopened = await h.engine.resumeBatch(batch.batchId);
    if (reopened.continuation) await h.engine.confirmContinueBatch(reopened.continuation.id);
    await settle();
    assert.equal(h.generationRequests().length, submitted, 'opening ancestor must preserve uncertainty of the already-submitted descendant');
    assert.equal(h.selectedSources.length, aiCalls, 'unknown descendant must not pay for selecting a replacement ancestor frame');
  } finally { h.engine.dispose(); }
});

test('newer continuation journals protect an older main file that contains neither claims nor descendant tasks', async () => {
  const h = harness('success');
  try {
    const batch = await stopFixture(h, true);
    const olderMain = serializeStateForStorage(h.holder.state).serialized;
    h.holder.failAi = false;
    const initial = await h.engine.resumeBatch(batch.batchId);
    assert.ok(initial.continuation);
    const continued = await h.engine.confirmContinueBatch(initial.continuation.id);
    await waitFor(() => h.tasks(continued.batchId).length === 2 && h.tasks(continued.batchId).every((task) => Boolean(task.resultAssetId)), 'suffix did not finish before crash-snapshot simulation');
    const submitted = h.generationRequests().length;
    const aiCalls = h.selectedSources.length;
    h.engine.dispose();
    h.holder.state = normalizeState(JSON.parse(olderMain));
    restart(h);
    const reopened = await h.engine.resumeBatch(batch.batchId);
    if (reopened.continuation) await h.engine.confirmContinueBatch(reopened.continuation.id);
    await settle();
    assert.equal(h.generationRequests().length, submitted, 'durable source ownership must survive a main-state rollback without regenerating missing descendant shells');
    assert.equal(h.selectedSources.length, aiCalls, 'journal recovery must happen before paid replacement AI selection');
  } finally { h.engine.dispose(); }
});

test('continuing an ancestor follows only the latest failed descendant and retains every successful prefix', async () => {
  const h = harness('success');
  try {
    const original = await stopFixture(h, true);
    h.holder.failAi = false;
    h.holder.failedPosts.add(3);
    const first = await h.engine.resumeBatch(original.batchId);
    assert.ok(first.continuation);
    const child = await h.engine.confirmContinueBatch(first.continuation.id);
    await waitFor(() => h.tasks(child.batchId)[1]?.status === 'failed' && Boolean(h.tasks(child.batchId)[0]?.resultAssetId), 'child suffix fixture did not reach successful second segment and failed third');
    const previousSuccessId = h.tasks(child.batchId)[0].resultAssetId;
    restart(h);
    const second = await h.engine.resumeBatch(original.batchId);
    assert.ok(second.continuation, 'ancestor should follow the latest failed child, not require finding a hidden new batch manually');
    assert.deepEqual(second.continuation.items.map((item) => item.taskId), [h.tasks(child.batchId)[1].id]);
    assert.equal(h.generationRequests().length, 3, 'merely displaying the second confirmation does not submit again');
    const grandchild = await h.engine.confirmContinueBatch(second.continuation.id);
    await waitFor(() => h.tasks(grandchild.batchId).length === 1 && Boolean(h.tasks(grandchild.batchId)[0].resultAssetId), 'last failed segment was not continued');
    assert.deepEqual(h.generationRequests().map((request) => JSON.parse(request.body!).prompt), ['unchanged-prompt-1', 'unchanged-prompt-2', 'unchanged-prompt-3', 'unchanged-prompt-3']);
    assert.equal(h.tasks(child.batchId)[0].resultAssetId, previousSuccessId, 'already-successful child prefix is not replaced');
    const analysisCount = h.selectedSources.length;
    restart(h);
    const complete = await h.engine.resumeBatch(original.batchId);
    assert.equal(complete.continuation, undefined);
    assert.equal(complete.completedTaskIds.length, 3, 'completion should map the descendant results back to all original logical items');
    await settle();
    assert.equal(h.generationRequests().length, 4);
    assert.equal(h.selectedSources.length, analysisCount);
  } finally { h.engine.dispose(); }
});

test('parent bytes changed while AI was selecting invalidate the late result and never POST', async () => {
  const h = harness('success');
  try {
    const batch = await stopFixture(h, true);
    h.holder.failAi = false;
    h.holder.holdAi = deferred();
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation?.requiresAiTail);
    const confirmation = h.engine.confirmContinueBatch(summary.continuation.id);
    const rejection = assert.rejects(confirmation, /变化|失效|校验|不一致|衔接/u);
    await waitFor(() => h.selectedSources.length === 2, 'selection did not start');
    const parent = h.tasks(batch.batchId)[0];
    const asset = h.holder.state.project.assets.find((candidate) => candidate.id === parent.resultAssetId)!;
    asset.checksum = 'different-parent-while-selecting';
    h.holder.holdAi.resolve();
    await rejection;
    await settle();
    assert.equal(h.generationRequests().length, 1, 'late selection tied to old bytes cannot authorize generation');
  } finally { h.holder.holdAi?.resolve(); h.engine.dispose(); }
});

test('project switch while AI was selecting cannot submit the frozen suffix into either project', async () => {
  const h = harness('success');
  try {
    const batch = await stopFixture(h, true);
    h.holder.failAi = false;
    h.holder.holdAi = deferred();
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation?.requiresAiTail);
    const confirmation = h.engine.confirmContinueBatch(summary.continuation.id);
    const rejection = assert.rejects(confirmation, /项目|取消|失效|批次/u);
    await waitFor(() => h.selectedSources.length === 2, 'selection did not start before project switch');
    const previous = h.holder.state.project;
    const next = createInitialState().project;
    next.id = 'new-active-project';
    const nextBefore = JSON.stringify(next);
    h.holder.state = { ...h.holder.state, project: next, projects: [previous, next] };
    h.holder.holdAi.resolve();
    await rejection;
    await settle();
    assert.equal(h.generationRequests().length, 1, 'switching project invalidates outstanding continuation authority');
    assert.equal(JSON.stringify(h.holder.state.project), nextBefore);
  } finally { h.holder.holdAi?.resolve(); h.engine.dispose(); }
});

for (const unavailable of ['main-state', 'checkpoint'] as const) test(`unavailable ${unavailable} persistence cannot authorize continuation AI or generation`, async () => {
  const h = harness('success');
  try {
    const batch = await stopFixture(h, true);
    h.holder.failAi = false;
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation?.requiresAiTail);
    const beforePosts = h.generationRequests().length;
    const beforeAi = h.selectedSources.length;
    if (unavailable === 'main-state') h.options.persistState = async () => { throw new Error('fixture state persistence unavailable'); };
    else h.desktop.saveVideoTaskCheckpoint = async () => { throw new Error('fixture checkpoint persistence unavailable'); };
    await assert.rejects(h.engine.confirmContinueBatch(summary.continuation.id), /persistence unavailable|保存|断点|记录/u);
    await settle();
    assert.equal(h.generationRequests().length, beforePosts, 'a suffix whose ownership is not durable cannot POST');
    assert.equal(h.selectedSources.length, beforeAi, 'durable ownership must be established before a potentially paid AI selection');
  } finally { h.engine.dispose(); }
});

for (const blockedAi of [true, false]) test(`real disk journal preserves ${blockedAi ? 'cancelled AI preparation' : 'acknowledged failure'} ownership through continuation and restart`, async () => {
  const h = harness(blockedAi ? 'success' : 'failed');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-continue-journal-'));
  const atomicWriteFile = (file: string, content: string) => {
    fs.writeFileSync(`${file}.tmp`, content);
    fs.renameSync(`${file}.tmp`, file);
  };
  let diskJournal = createVideoTaskCheckpointJournal({ directory, atomicWriteFile });
  h.desktop.saveVideoTaskCheckpoint = async (task) => {
    const saved = diskJournal.save(task);
    h.journals.set(task.id, structuredClone(task));
    return saved;
  };
  h.desktop.getVideoTaskCheckpoint = async (taskId) => diskJournal.get(taskId);
  try {
    const batch = await stopFixture(h, blockedAi);
    h.holder.failAi = false;
    const summary = await h.engine.resumeBatch(batch.batchId);
    assert.ok(summary.continuation, `disk-backed fixture could not continue: ${JSON.stringify(summary.issues)}`);
    const continued = await h.engine.confirmContinueBatch(summary.continuation.id);
    await waitFor(() => h.tasks(continued.batchId).length === 2 && h.tasks(continued.batchId).every((task) => Boolean(task.resultAssetId)), 'real-journal suffix did not finish');
    const originals = h.tasks(batch.batchId);
    const childTasks = h.tasks(continued.batchId);
    const submitted = h.generationRequests().length;
    const analyses = h.selectedSources.length;
    for (let index = 0; index < childTasks.length; index += 1) {
      assert.equal(diskJournal.get(originals[index + 1].id)?.videoJob?.batchContinuation?.taskId, childTasks[index].id, 'cancelled source tombstone must also retain its new continuation claim');
      assert.equal(diskJournal.get(childTasks[index].id)?.videoJob?.snapshot.continuedFrom?.taskId, originals[index + 1].id, 'child journal must preserve immutable source identity');
    }
    restart(h);
    diskJournal = createVideoTaskCheckpointJournal({ directory, atomicWriteFile });
    const reopened = await h.engine.resumeBatch(batch.batchId);
    if (reopened.continuation) await h.engine.confirmContinueBatch(reopened.continuation.id);
    await settle();
    assert.equal(h.generationRequests().length, submitted, 'disk journal reload cannot authorize another copy of the continued suffix');
    assert.equal(h.selectedSources.length, analyses, 'disk journal reload cannot authorize repeated AI selection');
  } finally {
    h.engine.dispose();
    await settle();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('lianhua-continue-journal-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => { throw new Error('No external network allowed in continuation safety tests'); };
  const failures: unknown[] = [];
  for (const item of tests) {
    try { await item.run(); console.log(`ok - ${item.name}`); }
    catch (error) { failures.push(error); console.error(`not ok - ${item.name}`); console.error(error); }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} batch continuation safety tests failed`);
} finally { globalThis.fetch = originalFetch; }
console.log(`${tests.length} independent batch continuation safety checks passed; zero real requests or production state changes.`);

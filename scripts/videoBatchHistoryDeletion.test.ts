import assert from 'node:assert/strict';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { inspectVideoBatchDeletion, removeVideoBatchKeepingProvenance } from '../src/videoBatchDeletion';
import { isVisibleGenerationTask } from '../src/generationTasks';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { AppState, ReferenceAsset, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoBatchStartInput, VideoGenerationDesktop } from '../src/videoGenerationTypes';

// All requests, credentials, pixels and checkpoint journals are synthetic. This
// suite constructs the continuation chain through public engine operations.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const config: VideoTaskApiConfig = {
  enabled: true, provider: 'generic', endpoint: 'https://history-fixture.example.test/generate',
  statusEndpointTemplate: 'https://history-fixture.example.test/tasks/{id}',
  imageUploadEndpoint: 'https://history-fixture.example.test/upload', imageUploadField: 'file', imageUploadUrlPath: 'url',
  apiKey: 'synthetic-history-key', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', model: 'history-fixture',
};
const image: ReferenceAsset = {
  id: 'history-reference', name: 'Synthetic reference', type: 'reference', role: 'composition', mediaType: 'image',
  tags: [], createdAt: 1, updatedAt: 1, fileName: 'history-reference.png',
  relativePath: 'image/history-reference.png', checksum: 'synthetic-pixel-checksum', managed: true,
};
const response = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let i = 0; i < 10; i += 1) await tick(); };
const waitFor = async (condition: () => boolean, message: string) => {
  for (let i = 0; i < 800; i += 1) { if (condition()) return; await tick(); }
  assert.fail(message);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const makeHarness = () => {
  const holder = {
    state: createInitialState(), uploadFailuresRemaining: 2, remoteComplete: false,
    requests: [] as Array<Parameters<VideoGenerationDesktop['videoRequest']>[0]>,
    checkpoints: new Map<string, VideoGenerationTask>(), credentials: new Map<string, string>(),
    deletedCheckpoints: [] as string[], cancelledRequests: [] as string[], posts: 0,
    persistenceGate: undefined as { taskCount: number; promise: Promise<void> } | undefined,
  };
  holder.state.settings.videoTaskApi = { ...config };
  holder.state.project.assets = [structuredClone(image)];
  holder.state.projects = [holder.state.project];
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      holder.requests.push(structuredClone(request));
      assert.equal(request.headers?.Authorization, 'Bearer synthetic-history-key', 'the current continuation keeps its own credential');
      if (request.url === config.imageUploadEndpoint) {
        if (holder.uploadFailuresRemaining-- > 0) throw new Error('synthetic pre-submission upload failure');
        return response({ url: 'https://history-fixture.example.test/images/reference.png' });
      }
      if (request.url === config.endpoint) {
        holder.posts += 1;
        return response({ id: `history-remote-${holder.posts}`, status: 'running' });
      }
      assert.ok(request.url.startsWith('https://history-fixture.example.test/tasks/'));
      const id = request.url.split('/').at(-1);
      return response(holder.remoteComplete
        ? { id, status: 'succeeded', url: `https://cdn.example.test/${id}.mp4` }
        : { id, status: 'running' });
    },
    cancelVideoRequest: async (requestId) => { holder.cancelledRequests.push(requestId); return true; },
    watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => {
      if (apiKey) holder.credentials.set(taskId, apiKey); else holder.credentials.delete(taskId);
      return { persisted: true };
    },
    getVideoTaskCredential: async (taskId) => holder.credentials.get(taskId) ?? null,
    saveVideoTaskCheckpoint: async (task) => { holder.checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(holder.checkpoints.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId) => { holder.deletedCheckpoints.push(taskId); return holder.checkpoints.delete(taskId); },
    readManagedImageDataUrl: async () => ({ dataUrl: png }),
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'synthetic workbench' }),
    extractWorkbenchFrames: async () => { throw new Error('This fixture has independent static references'); },
    downloadGeneratedMedia: async (request) => ({
      fileName: `${request.fileName}.mp4`, relativePath: `video/${request.fileName}.mp4`, checksum: `movie-${request.requestId}`,
      mediaType: 'video', mimeType: 'video/mp4', sizeBytes: 100, managed: true, missing: false,
      url: `lianhua-media://video/${request.fileName}.mp4`,
    }),
  };
  const options: VideoGenerationEngineOptions = {
    getState: () => holder.state,
    setState: (updater: (state: AppState) => AppState) => { holder.state = updater(holder.state); },
    desktop, onRuntime: () => {}, pollIntervalMs: 60_000,
    persistState: async () => {
      if (holder.persistenceGate && holder.state.project.generationTasks.length >= holder.persistenceGate.taskCount) {
        await holder.persistenceGate.promise;
      }
    },
  };
  const harness = {
    holder, engine: new VideoGenerationEngine(options),
    restart() {
      harness.engine.dispose();
      holder.state = normalizeState(JSON.parse(serializeStateForStorage(holder.state).serialized));
      harness.engine = new VideoGenerationEngine(options);
      harness.engine.reconcile();
    },
  };
  return harness;
};
type Harness = ReturnType<typeof makeHarness>;
const tasks = (h: Harness, batchId?: string) => h.holder.state.project.generationTasks
  .filter((task): task is VideoGenerationTask => task.kind === 'video' && (!batchId || task.batchId === batchId))
  .sort((left, right) => (left.batchIndex || 0) - (right.batchIndex || 0));
const input = (projectId: string): VideoBatchStartInput => ({
  projectId, label: 'Synthetic deletion chain', completionOrder: true, concurrency: 1,
  items: [1, 2].map((index) => ({ itemKey: `history-item-${index}`,
    draft: { name: `History segment ${index}`, backend: 'api', prompt: `Landscape fixture ${index}`,
      references: [{ assetId: image.id, role: 'general' }], parameters: { seed: index },
      source: { sequencePlanId: 'history-plan', segmentId: `history-segment-${index}`, segmentIndex: index, language: 'en', label: `Segment ${index}` },
    },
  })),
});
const buildChain = async (h: Harness) => {
  const a = await h.engine.startBatch(input(h.holder.state.project.id));
  await waitFor(() => tasks(h, a.batchId)[0]?.status === 'failed', 'A did not reach its synthetic upload failure');
  const aResume = await h.engine.resumeBatch(a.batchId);
  assert.ok(aResume.continuation);
  const b = await h.engine.confirmContinueBatch(aResume.continuation.id);
  await waitFor(() => tasks(h, b.batchId)[0]?.status === 'failed', 'B did not reach its synthetic upload failure');
  const bResume = await h.engine.resumeBatch(b.batchId);
  assert.ok(bResume.continuation);
  const c = await h.engine.confirmContinueBatch(bResume.continuation.id);
  await waitFor(() => tasks(h, c.batchId)[0]?.remoteTaskId === 'history-remote-1', 'C did not reach its original remote task');
  assert.equal(h.holder.posts, 1);
  assert.ok([...tasks(h, a.batchId), ...tasks(h, b.batchId)].every((task) => task.videoJob?.stage === 'stopped'));
  return { a, b, c };
};
const removeBatch = (h: Harness, batchId: string) => {
  const result = removeVideoBatchKeepingProvenance(h.holder.state.project, { projectId: h.holder.state.project.id, batchId });
  assert.equal(result.canDelete, true, result.reason);
  assert.equal(result.removedTaskIds.length, 2);
  h.holder.state = { ...h.holder.state, project: result.project,
    projects: h.holder.state.projects.map((project) => project.id === result.project.id ? result.project : project) };
  return result;
};

for (const order of ['ancestor-first', 'middle-first'] as const) {
  const h = makeHarness();
  try {
    const { a, b, c } = await buildChain(h);
    const before = h.holder.state;
    const sources = [...tasks(h, a.batchId), ...tasks(h, b.batchId)];
    const childSnapshot = structuredClone(tasks(h, c.batchId).map((task) => task.videoJob!.snapshot));
    const childCredentials = new Map(h.holder.credentials);
    for (const batch of order === 'ancestor-first' ? [a, b] : [b, a]) removeBatch(h, batch.batchId);
    assert.ok([...tasks(h, a.batchId), ...tasks(h, b.batchId)].every((task) => task.historyOnly === true));
    assert.deepEqual(tasks(h, c.batchId).map((task) => task.videoJob!.snapshot), childSnapshot);
    for (const source of sources) {
      const saved = tasks(h).find((task) => task.id === source.id)!;
      assert.deepEqual(saved.videoJob, source.videoJob, 'deletion preserves exact claims, snapshots and stopped state');
      assert.equal(saved.updatedAt, source.updatedAt, 'visibility alone must not invalidate an in-flight continuation signature');
    }
    assert.equal(inspectVideoBatchDeletion(h.holder.state.project, { projectId: h.holder.state.project.id, batchId: a.batchId }).canDelete, false,
      'history-only rows cannot be deleted repeatedly from a stale card');
    h.engine.reconcile(); await settle();
    assert.equal(h.holder.posts, 1, 'reconcile never schedules the hidden stopped source tasks');
    assert.deepEqual(h.holder.credentials, childCredentials, 'deleting history never clears continuation credentials');
    assert.deepEqual(h.holder.deletedCheckpoints, [], 'lineage journals remain available after history removal');
    assert.equal(h.holder.cancelledRequests.length, 0, 'history removal never cancels an active successor request');
    const fromA = await h.engine.resumeBatch(a.batchId);
    assert.ok(fromA.resumedTaskIds.includes(c.taskIds[0]), 'a retained source follows the precise live continuation');
    assert.equal(fromA.continuation, undefined, 'an already-running continuation cannot offer a replacement paid batch');
    assert.equal(h.holder.posts, 1);

    h.restart(); await settle();
    assert.ok([...tasks(h, a.batchId), ...tasks(h, b.batchId)].every((task) => task.historyOnly === true), 'production save/load preserves hidden history');
    const restarted = await h.engine.resumeBatch(a.batchId);
    assert.ok(restarted.resumedTaskIds.includes(c.taskIds[0]));
    assert.equal(restarted.continuation, undefined);
    assert.equal(h.holder.posts, 1, 'restart and continue use the existing remote ID');

    // Undo restores the prior immutable state while newer independent journals
    // still exist. It may reveal old rows, but cannot lose their ownership.
    h.holder.state = before;
    h.engine.reconcile(); await settle();
    assert.ok([...tasks(h, a.batchId), ...tasks(h, b.batchId)].every((task) => !task.historyOnly));
    const undone = await h.engine.resumeBatch(a.batchId);
    assert.ok(undone.resumedTaskIds.includes(c.taskIds[0]));
    assert.equal(undone.continuation, undefined);
    assert.equal(h.holder.posts, 1);
    removeBatch(h, b.batchId); removeBatch(h, a.batchId);

    h.holder.remoteComplete = true;
    await h.engine.resume(c.taskIds[0]);
    await waitFor(() => tasks(h, c.batchId)[1]?.remoteTaskId === 'history-remote-2', 'remaining C segment did not continue after its predecessor completed');
    await h.engine.resume(c.taskIds[1]);
    await waitFor(() => tasks(h, c.batchId).every((task) => Boolean(task.resultAssetId)), 'C failed to save its completed videos');
    assert.equal(h.holder.posts, 2, 'only the two original C segments generated after deleting A and B');
    assert.equal(h.holder.state.project.assets.filter((asset) => asset.type === 'video').length, 2);
    assert.ok([...tasks(h, a.batchId), ...tasks(h, b.batchId)].every((task) => task.historyOnly && task.videoJob?.stage === 'stopped'));
    console.log(`PASS ${order}: exact successor, credentials/checkpoints, restart, undo, no repeated POST, continued completion`);
  } finally { h.engine.dispose(); }
}

{
  const h = makeHarness();
  try {
    const { a, c } = await buildChain(h);
    const options = { projectId: h.holder.state.project.id, batchId: c.batchId };
    const before = h.holder.state.project;
    assert.equal(removeVideoBatchKeepingProvenance(before, options).project, before, 'an active selected batch remains undeletable');
    const active = tasks(h, c.batchId)[0];
    assert.equal(isVisibleGenerationTask({ ...active, historyOnly: true }), true, 'an imported history marker cannot hide an active task');
    const uncertain: VideoGenerationTask = { ...active, status: 'unknown', remoteTaskId: undefined,
      videoJob: { ...active.videoJob!, stage: 'submission-unknown', trackingStopped: true,
        preparation: { ...active.videoJob!.preparation!, phase: 'post-started' } } };
    const uncertainProject = { ...before, generationTasks: before.generationTasks.map((task) => task.id === uncertain.id ? uncertain : task) };
    assert.equal(removeVideoBatchKeepingProvenance(uncertainProject, options).project, uncertainProject, 'locally stopped unknown paid POST remains protected');
    assert.equal(isVisibleGenerationTask({ ...uncertain, historyOnly: true }), true, 'an uncertain remote request stays visible even with a history marker');
    const missingChildProject = { ...before, generationTasks: before.generationTasks.filter((task) => task.id !== tasks(h, a.batchId)[0].videoJob!.batchContinuation!.taskId) };
    assert.equal(inspectVideoBatchDeletion(missingChildProject, { ...options, batchId: a.batchId }).canDelete, false,
      'an unresolved or unmaterialized child claim remains protected');
    const source = tasks(h, a.batchId)[0];
    const child = tasks(h).find((task) => task.id === source.videoJob!.batchContinuation!.taskId)!;
    const duplicateChildProject = { ...before, generationTasks: [...before.generationTasks, { ...child }] };
    assert.equal(inspectVideoBatchDeletion(duplicateChildProject, { ...options, batchId: a.batchId }).canDelete, false,
      'ambiguous duplicated child identity is not an established continuation');
    const mismatchedChildProject = { ...before, generationTasks: before.generationTasks.map((task) => task.id === child.id
      ? { ...child, videoJob: { ...child.videoJob!, snapshot: { ...child.videoJob!.snapshot, continuedFrom: {
        ...child.videoJob!.snapshot.continuedFrom!, requestFingerprint: 'different-original-request',
      } } } } : task) };
    assert.equal(inspectVideoBatchDeletion(mismatchedChildProject, { ...options, batchId: a.batchId }).canDelete, false);
    const cycleProject = { ...before, generationTasks: before.generationTasks.map((task) => task.id === source.id
      ? { ...source, videoJob: { ...source.videoJob!, snapshot: { ...source.videoJob!.snapshot, continuedFrom: {
        version: 1 as const, planId: 'synthetic-cycle', taskId: active.id, batchId: c.batchId, requestFingerprint: active.requestFingerprint!,
      } } } } : task.id === active.id
        ? { ...active, videoJob: { ...active.videoJob!, batchContinuation: {
          version: 1 as const, planId: 'synthetic-cycle', taskId: source.id, batchId: a.batchId, revision: 1,
        } } } : task) };
    assert.equal(inspectVideoBatchDeletion(cycleProject, { ...options, batchId: a.batchId }).canDelete, false,
      'exact-looking edges that form a cycle remain blocked');
    console.log('PASS active/unknown visibility, unresolved submission and missing/duplicate/mismatched/cyclic child claims remain protected');
  } finally { h.engine.dispose(); }
}

{
  const h = makeHarness();
  const gate = deferred();
  try {
    const a = await h.engine.startBatch(input(h.holder.state.project.id));
    await waitFor(() => tasks(h, a.batchId)[0]?.status === 'failed', 'initialization fixture did not reach failure');
    const continuation = (await h.engine.resumeBatch(a.batchId)).continuation;
    assert.ok(continuation);
    h.holder.persistenceGate = { taskCount: 4, promise: gate.promise };
    const pending = h.engine.confirmContinueBatch(continuation.id);
    await waitFor(() => tasks(h).length === 4, 'continuation shells were not inserted before the held state save');
    removeBatch(h, a.batchId);
    h.holder.persistenceGate = undefined;
    gate.resolve();
    const b = await pending;
    await waitFor(() => tasks(h, b.batchId)[0]?.status === 'failed', 'history visibility change interrupted continuation initialization');
    assert.ok(tasks(h, a.batchId).every((task) => task.historyOnly));
    assert.ok(tasks(h, b.batchId).every((task) => h.holder.checkpoints.has(task.id)), 'each inserted child still receives its own durable checkpoint');
    assert.equal(h.holder.posts, 0, 'both synthetic preparation failures occur before any video submission');
    console.log('PASS source history removal during child initialization preserves the transaction signature and child checkpoints');
  } finally { gate.resolve(); h.engine.dispose(); }
}

console.log('Video batch history deletion engine regression passed with only synthetic local fixtures.');

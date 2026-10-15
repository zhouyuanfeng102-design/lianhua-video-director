import assert from 'node:assert/strict';
import { VideoGenerationEngine, type VideoGenerationEngineOptions } from '../src/videoGeneration';
import { findVideoBatchDuplicate } from '../src/videoBatch';
import { inspectVideoBatchDeletion, removeVideoBatchKeepingProvenance } from '../src/videoBatchDeletion';
import { isVisibleGenerationTask } from '../src/generationTasks';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { AppState, ReferenceAsset, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoBatchStartInput, VideoGenerationDesktop, VideoGenerationRuntime } from '../src/videoGenerationTypes';

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
    state: createInitialState(), uploadFailuresRemaining: 2, remoteComplete: false, submissionHttpStatus: 200,
    requests: [] as Array<Parameters<VideoGenerationDesktop['videoRequest']>[0]>,
    checkpoints: new Map<string, VideoGenerationTask>(), credentials: new Map<string, string>(),
    runtimes: new Map<string, VideoGenerationRuntime>(),
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
        if (holder.submissionHttpStatus !== 200) return { status: holder.submissionHttpStatus, body: '' };
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
    desktop, onRuntime: (taskId, runtime) => { holder.runtimes.set(taskId, runtime); }, pollIntervalMs: 60_000,
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
      holder.runtimes.clear();
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

{
  const h = makeHarness();
  try {
    h.holder.uploadFailuresRemaining = 0;
    h.holder.submissionHttpStatus = 524;
    const originalInput = input(h.holder.state.project.id);
    originalInput.items = originalInput.items.slice(0, 1);
    const batch = await h.engine.startBatch(originalInput);
    const taskId = batch.taskIds[0];
    assert.ok(taskId);
    await waitFor(() => tasks(h, batch.batchId)[0]?.status === 'unknown', '524 did not preserve its unknown paid submission');
    assert.equal(h.holder.posts, 1);
    assert.equal(tasks(h, batch.batchId)[0].videoJob?.preparation?.phase, 'post-started');
    assert.equal(inspectVideoBatchDeletion(h.holder.state.project, { projectId: h.holder.state.project.id, batchId: batch.batchId }).canDelete, false,
      'an unstopped 524 submission still requires an explicit local stop');

    await h.engine.cancel(taskId);
    await settle();
    const beforeRemoval = h.holder.state;
    const stopped = tasks(h, batch.batchId)[0];
    assert.equal(stopped.status, 'unknown', 'stopping observation does not certify remote failure');
    assert.equal(stopped.videoJob?.stage, 'stopped');
    assert.equal(stopped.videoJob?.trackingStopped, true);
    assert.equal(stopped.videoJob?.cancellationPending, false);
    assert.equal(stopped.videoJob?.cancellationConfirmed, false, '524 has no remote identity to cancel or confirm');
    const credentials = new Map(h.holder.credentials);
    const checkpoint = structuredClone(h.holder.checkpoints.get(taskId));
    const requestsBeforeRemoval = h.holder.requests.length;
    const cancellationsBeforeRemoval = h.holder.cancelledRequests.length;
    assert.ok(checkpoint?.videoJob?.trackingStopped);
    assert.ok(credentials.size > 0);

    const removeStopped = () => {
      const before = tasks(h, batch.batchId)[0];
      const result = removeVideoBatchKeepingProvenance(h.holder.state.project, {
        projectId: h.holder.state.project.id, batchId: batch.batchId,
        getRuntime: (id) => h.holder.runtimes.get(id),
      });
      assert.equal(result.canDelete, true, result.reason);
      assert.deepEqual(result.removedTaskIds, [taskId]);
      h.holder.state = { ...h.holder.state, project: result.project,
        projects: h.holder.state.projects.map((project) => project.id === result.project.id ? result.project : project) };
      const retained = tasks(h, batch.batchId)[0];
      assert.equal(retained.historyOnly, true, 'list removal retains the uncertain paid request identity');
      assert.equal(retained.id, before.id);
      assert.equal(retained.createdAt, before.createdAt);
      assert.equal(retained.updatedAt, before.updatedAt);
      assert.deepEqual(retained.videoJob, before.videoJob, 'cleanup never rewrites billing evidence or preparation checkpoints');
      assert.equal(h.holder.state.project.generationTasks.filter(isVisibleGenerationTask).some((task) => task.id === taskId), false,
        'the stopped batch disappears from the task list');
    };
    removeStopped();
    h.engine.reconcile(); await settle();
    assert.equal(h.holder.requests.length, requestsBeforeRemoval, 'cleanup does not query, submit or remotely cancel work');
    assert.equal(h.holder.cancelledRequests.length, cancellationsBeforeRemoval);
    assert.deepEqual(h.holder.credentials, credentials);
    assert.deepEqual(h.holder.checkpoints.get(taskId), checkpoint);
    assert.deepEqual(h.holder.deletedCheckpoints, []);

    h.restart(); await settle();
    assert.equal(tasks(h, batch.batchId)[0].historyOnly, true, 'production serialization preserves removed list visibility');
    assert.equal(isVisibleGenerationTask(tasks(h, batch.batchId)[0]), false);
    assert.equal(h.holder.posts, 1, 'reloading an uncertain stopped submission never POSTs again');
    assert.deepEqual(h.holder.credentials, credentials);
    assert.deepEqual(h.holder.deletedCheckpoints, []);
    assert.equal(findVideoBatchDuplicate(h.holder.state.project, stopped.requestFingerprint!), undefined,
      'a cleared stopped request no longer appears in the director as already queued');

    h.holder.state = beforeRemoval;
    h.engine.reconcile(); await settle();
    assert.equal(isVisibleGenerationTask(tasks(h, batch.batchId)[0]), true, 'undo restores the original visible recovery record');
    const duplicateBeforeCleanup = await h.engine.startBatch({ ...originalInput, force: true });
    assert.deepEqual(duplicateBeforeCleanup.taskIds, [], 'an uncertain record restored by undo must be cleared before starting a replacement');
    assert.equal(duplicateBeforeCleanup.skipped[0]?.reason, 'in-flight');
    assert.equal(duplicateBeforeCleanup.skipped[0]?.taskId, taskId);
    assert.equal(h.holder.posts, 1, 'undo and duplicate checking never replay the uncertain POST');
    await assert.rejects(h.engine.resume(taskId), /没有远端任务 ID|尚未找到原任务|不能安全恢复查询/u);
    assert.equal(h.holder.posts, 1, 'recovery after undo cannot replace the original unknown POST');
    assert.equal(tasks(h, batch.batchId)[0].videoJob?.trackingStopped, true);
    removeStopped();
    assert.equal(h.holder.posts, 1);
    assert.deepEqual(h.holder.credentials, credentials);
    assert.deepEqual(h.holder.deletedCheckpoints, []);
    const cleared = structuredClone(tasks(h, batch.batchId)[0]);
    h.holder.submissionHttpStatus = 200;
    const replacement = await h.engine.startBatch({ ...originalInput, force: true });
    assert.equal(replacement.taskIds.length, 1, 'a new explicit generation is allowed after clearing the stopped history');
    assert.notEqual(replacement.taskIds[0], taskId);
    assert.notEqual(replacement.batchId, batch.batchId);
    await waitFor(() => Boolean(tasks(h, replacement.batchId)[0]?.remoteTaskId), 'explicit replacement did not submit its new task');
    assert.equal(h.holder.posts, 2, 'only the explicit replacement adds one new paid POST');
    assert.deepEqual(tasks(h, batch.batchId)[0], cleared, 'a replacement never rewrites the archived original request');
    assert.equal(cleared.status, 'unknown');
    assert.equal(cleared.videoJob?.preparation?.phase, 'post-started');
    assert.deepEqual(h.holder.checkpoints.get(taskId), checkpoint, 'the original unknown submission journal is retained');
    for (const [scope, credential] of credentials) assert.equal(h.holder.credentials.get(scope), credential);
    const liveDuplicate = await h.engine.startBatch({ ...originalInput, force: true });
    assert.deepEqual(liveDuplicate.taskIds, [], 'force cannot duplicate the new active replacement');
    assert.equal(liveDuplicate.skipped[0]?.taskId, replacement.taskIds[0]);
    assert.equal(liveDuplicate.skipped[0]?.reason, 'in-flight');
    assert.equal(h.holder.posts, 2);
    assert.deepEqual(h.holder.deletedCheckpoints, []);
    console.log('PASS 524 cleanup/restart/undo never auto-POSTs; explicit replacement gets a new ID and live replacement still blocks duplicates');
  } finally { h.engine.dispose(); }
}

{
  const h = makeHarness();
  try {
    h.holder.uploadFailuresRemaining = 0;
    h.holder.submissionHttpStatus = 524;
    h.holder.state.settings.videoExecutionMode = 'concurrent';
    h.holder.state.settings.videoExecutionConcurrency = 3;
    const template = input(h.holder.state.project.id).items[0];
    const originalInput: VideoBatchStartInput = {
      projectId: h.holder.state.project.id, label: 'Three independent 524 submissions', concurrency: 3,
      items: [1, 2, 3].map((index) => ({
        ...structuredClone(template), itemKey: `cleared-524-item-${index}`,
        draft: { ...structuredClone(template.draft), name: `Cleared 524 segment ${index}`,
          prompt: `Synthetic independent landscape ${index}`, parameters: { seed: 100 + index },
          source: { ...template.draft.source!, segmentId: `cleared-524-segment-${index}`, segmentIndex: index },
        },
      })),
    };
    const original = await h.engine.startBatch(originalInput);
    assert.equal(original.taskIds.length, 3);
    await waitFor(() => tasks(h, original.batchId).every((task) => task.status === 'unknown'), 'the three independent submissions did not all reach HTTP 524');
    assert.equal(h.holder.posts, 3);
    await Promise.all(original.taskIds.map((taskId) => h.engine.cancel(taskId)));
    await settle();
    const credentials = new Map(h.holder.credentials);
    const checkpoints = new Map(original.taskIds.map((taskId) => [taskId, structuredClone(h.holder.checkpoints.get(taskId))]));
    const removed = removeVideoBatchKeepingProvenance(h.holder.state.project, {
      projectId: originalInput.projectId, batchId: original.batchId,
      getRuntime: (taskId) => h.holder.runtimes.get(taskId),
    });
    assert.equal(removed.canDelete, true, removed.reason);
    assert.deepEqual(removed.removedTaskIds.sort(), [...original.taskIds].sort());
    h.holder.state = { ...h.holder.state, project: removed.project,
      projects: h.holder.state.projects.map((project) => project.id === removed.project.id ? removed.project : project) };
    h.engine.reconcile(); await settle();
    h.restart(); await settle();
    const archived = structuredClone(tasks(h, original.batchId));
    assert.equal(archived.length, 3);
    assert.equal(h.holder.posts, 3, 'loading existing 2.3.2-style historyOnly records never creates new submissions');
    assert.equal(h.holder.state.project.generationTasks.filter(isVisibleGenerationTask).length, 0,
      'the three old stopped requests remain cleared from the task list');
    for (const old of archived) {
      assert.equal(old.historyOnly, true);
      assert.equal(old.status, 'unknown');
      assert.equal(old.videoJob?.preparation?.phase, 'post-started');
      assert.ok(old.requestFingerprint);
      assert.equal(findVideoBatchDuplicate(h.holder.state.project, old.requestFingerprint), undefined,
        'director preview immediately treats a pre-existing cleared request as available for manual generation');
      const active: VideoGenerationTask = { ...old, id: `active-${old.id}`, status: 'running', remoteTaskId: `remote-${old.id}`,
        videoJob: { ...old.videoJob!, stage: 'running', trackingStopped: false } };
      assert.equal(findVideoBatchDuplicate({ generationTasks: [...archived, active] }, old.requestFingerprint)?.taskId, active.id,
        'even an imported history marker cannot exempt a genuinely active task with the same fingerprint');
    }
    h.holder.submissionHttpStatus = 200;
    const replacement = await h.engine.startBatch(originalInput);
    assert.equal(replacement.taskIds.length, 3, 'normal manual generation needs no force flag after clearing the original batch');
    assert.deepEqual(replacement.skipped, []);
    assert.ok(replacement.taskIds.every((taskId) => !original.taskIds.includes(taskId)), 'all replacements receive new task identities');
    await waitFor(() => tasks(h, replacement.batchId).every((task) => Boolean(task.remoteTaskId)), 'the three explicit replacements did not submit');
    assert.equal(h.holder.posts, 6, 'exactly three new mock POSTs follow the explicit manual generation');
    assert.deepEqual(tasks(h, original.batchId), archived, 'manual retries preserve the old stopped unknown records byte for byte');
    for (const [taskId, checkpoint] of checkpoints) assert.deepEqual(h.holder.checkpoints.get(taskId), checkpoint);
    for (const [scope, credential] of credentials) assert.equal(h.holder.credentials.get(scope), credential);
    for (const live of tasks(h, replacement.batchId)) {
      assert.ok(live.requestFingerprint);
      assert.equal(findVideoBatchDuplicate(h.holder.state.project, live.requestFingerprint)?.taskId, live.id,
        'director preview recognizes the new live request instead of the archived unknown one');
    }
    const repeated = await h.engine.startBatch({ ...originalInput, force: true });
    assert.deepEqual(repeated.taskIds, [], 'force still cannot resubmit the three active replacements');
    assert.equal(repeated.skipped.length, 3);
    assert.ok(repeated.skipped.every((item) => item.reason === 'in-flight' && replacement.taskIds.includes(item.taskId!)));
    assert.equal(h.holder.posts, 6);
    assert.deepEqual(h.holder.deletedCheckpoints, []);
    console.log('PASS three archived 524 requests permit three explicit new tasks after reload, while new live tasks retain duplicate protection');
  } finally { h.engine.dispose(); }
}

console.log('Video batch history deletion engine regression passed with only synthetic local fixtures.');

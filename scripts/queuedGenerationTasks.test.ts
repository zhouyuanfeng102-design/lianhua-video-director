import assert from 'node:assert/strict';
import {
  GenerationTaskCancelledError,
  autofillGenerationStatusLabel,
  cancelQueuedGenerationTask,
  createAutofillGenerationTask,
  createImageGenerationTask,
  imageGenerationStatusLabel,
  isGenerationTaskCancelledError,
  isGenerationTaskRevoked,
  patchAutofillGenerationTask,
  patchImageGenerationTask,
  removeGenerationTask,
  revokeQueuedGenerationTask,
  settleAutofillGenerationTask,
  settleImageGenerationTask,
} from '../src/generationTasks';
import { enqueueImageBatchMembers, imageBatchTaskIsActive, isImageTaskActiveInWorkspace } from '../src/imageBatch';
import { enqueueImageTask } from '../src/imageTaskQueue';
import { appendRegeneratedImageResult } from '../src/imageRegeneration';
import { createStoryboardImageBatchLifecycle, runStoryboardImageBatch, type StoryboardImageRequest } from '../src/storyboardImages';
import { createInitialState, normalizeState } from '../src/storage';
import type { GenerationTask, ImageGenerationTask } from '../src/types';

const imageTask = (id: string, overrides: Partial<ImageGenerationTask> = {}): ImageGenerationTask => createImageGenerationTask({
  id, name: id, assetKind: 'character', imageVariant: 'five-view', prompt: '',
  width: 1536, height: 1024, backend: 'openai', model: 'mock-only', ...overrides,
}, 100, 'queued');

const autofillTask = createAutofillGenerationTask({
  id: 'queued-autofill', name: '资料补齐', assetKind: 'character', requestedFields: ['appearance'], model: 'mock-only',
}, 101, 'queued');

const queued = imageTask('queued-image');
const running = { ...imageTask('running-image'), status: 'running' as const };
const other = imageTask('untouched-image');
const tasks: GenerationTask[] = [queued, running, autofillTask, other];
const cancelled = cancelQueuedGenerationTask(tasks, queued.id, 200);
assert.equal(cancelled.cancelled, true);
assert.equal(cancelled.blocked, false);
assert.equal(cancelled.tasks[0].status, 'cancelled');
assert.equal(cancelled.tasks[0].updatedAt, 200);
assert.equal(cancelled.tasks[0].createdAt, 100);
assert.strictEqual(cancelled.tasks[1], running);
assert.strictEqual(cancelled.tasks[3], other);
assert.equal(queued.status, 'queued', 'cancelling never mutates the submitted snapshot');
assert.equal(imageGenerationStatusLabel('cancelled'), '已取消');
assert.equal(autofillGenerationStatusLabel('cancelled'), '已取消');
assert.equal(cancelQueuedGenerationTask(tasks, running.id).blocked, true, 'an executing request cannot be claimed as cancelled');
assert.equal(revokeQueuedGenerationTask('scope', running), false, 'an executing task cannot acquire a revocation tombstone');
assert.equal(cancelQueuedGenerationTask(tasks, 'missing').cancelled, false);
assert.equal(cancelQueuedGenerationTask(cancelled.tasks, queued.id).blocked, false, 'a repeated cancellation is idempotent');
assert.equal(removeGenerationTask(tasks, queued.id).removed, true, 'queued tasks support direct deletion');
assert.equal(removeGenerationTask(tasks, autofillTask.id).removed, true, 'legacy queued autofill tasks support direct deletion');
assert.equal(removeGenerationTask(tasks, running.id).blocked, true, 'running task recovery remains protected');
assert.equal(removeGenerationTask(cancelled.tasks, queued.id).removed, true, 'cancelled records can be deleted');

for (const patch of [{ status: 'running' as const }, { status: 'failed' as const, error: 'late worker' }, { prompt: 'late conversion' }]) {
  assert.deepEqual(patchImageGenerationTask(cancelled.tasks, queued.id, patch, 201), cancelled.tasks, 'late patches cannot alter cancellation');
}
assert.deepEqual(settleImageGenerationTask(cancelled.tasks, queued, { status: 'succeeded', resultAssetId: 'never-bind' }, 202), cancelled.tasks);

const cancelledAutofill = cancelQueuedGenerationTask(tasks, autofillTask.id, 210);
assert.equal(cancelledAutofill.cancelled, true);
assert.deepEqual(patchAutofillGenerationTask(cancelledAutofill.tasks, autofillTask.id, { status: 'succeeded', result: { appearance: 'late result' } }, 211), cancelledAutofill.tasks);
assert.deepEqual(settleAutofillGenerationTask(cancelledAutofill.tasks, autofillTask, { status: 'failed', error: 'late failure' }, 212), cancelledAutofill.tasks);

assert.equal(revokeQueuedGenerationTask('project-A', queued), true);
assert.equal(isGenerationTaskRevoked('project-A', queued), true);
assert.equal(isGenerationTaskRevoked('project-B', queued), false, 'matching imported task IDs in another project stay independent');
assert.equal(isGenerationTaskRevoked('project-A', { ...queued, createdAt: queued.createdAt + 1 }), false, 'new task instances remain independent');
assert.equal(isGenerationTaskRevoked('project-A', { ...autofillTask, id: queued.id, createdAt: queued.createdAt }), false, 'different task kinds do not collide');
assert.deepEqual(settleImageGenerationTask([], queued, { status: 'failed', error: 'late failure' }, 220, 'project-A'), [], 'directly deleted cancelled work never reappears');
assert.deepEqual(settleImageGenerationTask([queued], queued, { status: 'succeeded' }, 221, 'project-A'), [queued], 'undo snapshots do not authorize cancelled workers');
assert.equal(settleImageGenerationTask([], queued, { status: 'succeeded' }, 222, 'project-B').length, 1, 'ordinary undo recovery remains intact in a separate project');
assert.equal(settleImageGenerationTask([], other, { status: 'succeeded' }, 223, 'project-A').length, 1, 'ordinary undo recovery remains intact for unrelated tasks');
const replacementTask = { ...other, createdAt: other.createdAt + 1 };
assert.deepEqual(settleImageGenerationTask([replacementTask], other, { status: 'failed' }, 223, 'project-A'), [replacementTask], 'a late old instance cannot alter another task with a reused ID');
assert.equal(revokeQueuedGenerationTask('project-A', autofillTask), true);
assert.deepEqual(settleAutofillGenerationTask([], autofillTask, { status: 'succeeded', result: {} }, 224, 'project-A'), []);

const persisted = createInitialState();
persisted.project.generationTasks = [cancelled.tasks[0], cancelledAutofill.tasks[2]];
persisted.projects = [persisted.project];
const reloaded = normalizeState(JSON.parse(JSON.stringify(persisted)));
assert.deepEqual(reloaded.project.generationTasks.map((task) => task.status), ['cancelled', 'cancelled'], 'reload keeps both explicit cancellation statuses');
assert.deepEqual(reloaded.project.generationTasks.map((task) => task.updatedAt), [200, 210]);
assert.equal(reloaded.project.generationTasks.some((task) => Boolean(task.error)), false, 'cancelled does not become a misleading interruption failure');
const discardedRegeneration = { ...persisted.project, id: 'project-A', generationTasks: [] };
assert.strictEqual(appendRegeneratedImageResult(discardedRegeneration, queued, {
  id: 'late-asset', name: 'late generated result', type: 'reference', role: 'composition', tags: [], createdAt: 225, updatedAt: 225,
}), discardedRegeneration, 'late regeneration output cannot add an asset or resurrect a explicitly cancelled task');

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

// One paused FIFO member exposes real queued entries. No remote requests are used.
const state = createInitialState();
const projectId = state.project.id;
const batch = [
  imageTask('ordinary-queued'),
  imageTask('private-queued', { referenceScope: 'nsfw-private-profile', imageVariant: 'private-five-view' }),
  imageTask('regeneration-queued', { regenerationSourceTaskId: 'original', regenerationRootTaskId: 'original' }),
  imageTask('storyboard-queued', { assetKind: 'storyboard', imageVariant: 'storyboard-frame', batchId: 'storyboard-batch' }),
  imageTask('keep-queued'),
];
state.project.generationTasks = batch;
state.projects = [state.project];
const gate = deferred();
const blocker = enqueueImageTask(() => gate.promise);
const calls: string[] = [];
const work = enqueueImageBatchMembers(batch, (task) => imageBatchTaskIsActive(state, projectId, task, true), async (task) => {
  calls.push(`convert:${task.id}`);
  calls.push(`generate:${task.id}`);
});
for (const task of batch.slice(0, 4)) {
  revokeQueuedGenerationTask(projectId, task);
  state.project.generationTasks = task.id === 'private-queued'
    ? cancelQueuedGenerationTask(state.project.generationTasks, task.id).tasks
    : removeGenerationTask(state.project.generationTasks, task.id).tasks;
}
// Undo restores the original queued records, but not the authorization to run them.
state.project.generationTasks = batch;
assert.equal(isImageTaskActiveInWorkspace(state, batch[0].id), false);
assert.equal(imageBatchTaskIsActive(state, projectId, batch[0]), false);
assert.equal(imageBatchTaskIsActive(state, projectId, batch[4]), true);
assert.equal(imageBatchTaskIsActive(state, projectId, { ...batch[4], createdAt: batch[4].createdAt + 1 }), false, 'the queue cannot borrow a different task instance with the same ID');
gate.resolve();
await Promise.all([blocker, work]);
assert.deepEqual(calls, ['convert:keep-queued', 'generate:keep-queued'], 'no converter or image request for cancelled members; unrelated work continues');

const queueGate = deferred();
const queueBlocker = enqueueImageTask(() => queueGate.promise);
let canStart = true;
let skippedWorkerStarted = false;
const skippedWorker = enqueueImageTask(async () => { skippedWorkerStarted = true; }, { canStart: () => canStart });
const rejection = assert.rejects(skippedWorker, (error) => isGenerationTaskCancelledError(error));
let followingStarted = false;
const following = enqueueImageTask(async () => { followingStarted = true; });
canStart = false;
queueGate.resolve();
await Promise.all([queueBlocker, rejection, following]);
assert.equal(skippedWorkerStarted, false, 'queue guard runs after waiting, immediately before executing the worker');
assert.equal(followingStarted, true, 'cancelled worker never holds up another queued task');

const requests: StoryboardImageRequest[] = Array.from({ length: 4 }, (_, index) => ({
  purpose: 'storyboard-shot', name: `分镜${index + 1}`, storyboardId: 'board', shotId: `shot-${index + 1}`,
  shotIndex: index + 1, assetKind: 'storyboard', assetType: 'reference', assetRole: 'composition', referenceRole: 'composition',
  imageVariant: 'storyboard-frame', referenceAssetIds: [], primaryReferenceAssetIds: [],
  conversionSource: 'mock source', width: 1536, height: 1024,
}));
const storyboardCalls: number[] = [];
const storyboardResults = await runStoryboardImageBatch(requests, async (_request, index) => {
  storyboardCalls.push(index);
  if (index === 1) throw new GenerationTaskCancelledError();
  if (index === 2) throw new Error('mock provider error');
  return 'saved';
}, (_request, index) => index !== 0);
assert.deepEqual(storyboardCalls, [1, 2, 3]);
assert.deepEqual(storyboardResults.map((item) => item.status), ['cancelled', 'cancelled', 'failed', 'succeeded']);
assert.equal(storyboardResults[0].error, undefined, 'a cancelled member is not a generation failure');
assert.equal(storyboardResults[1].error, undefined, 'late lifecycle cancellation is not a provider failure');
assert.equal(storyboardResults[2].error, 'mock provider error');

const lifecycle = createStoryboardImageBatchLifecycle();
const cancelledLease = lifecycle.begin('board-cancelled')!;
const runningLease = lifecycle.begin('board-running')!;
const planningLease = lifecycle.begin('board-planning')!;
const regenerationLease = lifecycle.begin('regenerate-cancelled')!;
lifecycle.trackBatchSubmissions(cancelledLease, ['cancelled-1', 'deleted-2']);
lifecycle.trackBatchSubmissions(runningLease, ['completed-1', 'still-running']);
lifecycle.trackSubmission(regenerationLease, 'cancelled-regeneration');
lifecycle.releaseCancelledQueuedBatches((id) => id === 'still-running');
assert.equal(lifecycle.isActive(cancelledLease.key), false, 'fully cancelled batch releases its duplicate guard immediately');
assert.equal(lifecycle.isActive(regenerationLease.key), false, 'single regeneration uses the same release path');
assert.equal(lifecycle.canSubmit(cancelledLease), false);
assert.equal(lifecycle.canSubmit(regenerationLease), false);
assert.equal(lifecycle.canBind(cancelledLease), false);
assert.equal(lifecycle.canSubmit(runningLease), true, 'other running members keep their batch owned');
assert.equal(lifecycle.canSubmit(planningLease), true, 'untracked planning cannot be accidentally released');
const replacementLease = lifecycle.begin(cancelledLease.key)!;
assert.ok(replacementLease, 'the same storyboard can be queued again without waiting for an unrelated slow worker');
lifecycle.trackBatchSubmissions(replacementLease, ['replacement-running']);
lifecycle.finish(cancelledLease);
assert.equal(lifecycle.canSubmit(replacementLease), true, 'an old worker finally block cannot clear a replacement lease');
lifecycle.releaseCancelledQueuedBatches((id) => id === 'still-running' || id === 'replacement-running');
assert.equal(lifecycle.canSubmit(replacementLease), true);

const undoLease = lifecycle.begin('regeneration-undo')!;
lifecycle.trackSubmission(undoLease, 'undone-task');
lifecycle.revokeMissingSubmissions(() => false);
assert.equal(lifecycle.isActive(undoLease.key), true, 'ordinary undo retains the existing worker recovery ownership');
assert.equal(lifecycle.canSubmit(undoLease), false, 'ordinary undo still permanently revokes the old submission');

console.log('Queued generation cancellation checks passed: explicit terminal state, direct deletion, task/project isolation, undo-proof revocations, no converter/image calls for revoked FIFO members, unrelated continuation, restart persistence, and immediate cancelled-batch lease release.');

import assert from 'node:assert/strict';
import { inspectVideoBatchDeletion, removeVideoBatchKeepingProvenance } from '../src/videoBatchDeletion';
import { findProjectVideoTask, findReusableVideoTask, findVideoAssetSourceTask } from '../src/videoProvenance';
import { createInitialState, normalizeState } from '../src/storage';
import { isVideoGenerationTask, isVisibleGenerationTask } from '../src/generationTasks';
import { videoBatchContinuationPersistenceIssue } from '../src/videoBatchContinuation';
import type { GenerationTask, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { VideoGenerationRuntime } from '../src/videoGenerationTypes';

const base = createInitialState();
const projectId = base.project.id;
const options = { projectId, batchId: 'delete-batch' };
const task = (id: string, patch: Partial<VideoGenerationTask> = {}): VideoGenerationTask => ({
  id, kind: 'video', batchId: options.batchId, storyboardId: 'board-1', targetId: 'fixture', status: 'failed',
  requestBody: {}, createdAt: 1, updatedAt: 2,
  videoJob: { stage: 'failed', snapshot: { projectId, clientId: `${id}-client`,
    draft: { name: id, backend: 'api', prompt: 'Fixture original prompt', references: [], parameters: { seed: 42 } },
    connection: { backend: 'api' }, images: [],
  } }, ...patch,
});
const asset = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'video', mediaType: 'video', role: 'motion', tags: [], createdAt: 1, updatedAt: 2,
  fileName: `${id}.mp4`, relativePath: `generated/${id}.mp4`, checksum: `${id}-checksum`, ...patch,
});
const success = task('successful', { status: 'succeeded', remoteTaskId: 'remote-source', resultAssetId: 'saved-video' });
success.videoJob = { ...success.videoJob!, stage: 'succeeded', remoteGenerationEnded: true, generatedAt: 2 };
const failed = task('failed');
const stopped = task('stopped');
stopped.videoJob = { ...stopped.videoJob!, stage: 'stopped', trackingStopped: true, cancellationConfirmed: true };
const other = task('other-batch', { batchId: 'keep-batch', status: 'running', remoteTaskId: 'other-remote' });
other.videoJob = { ...other.videoJob!, stage: 'running' };
const standalone = task('standalone', { batchId: undefined });
const imageTask: GenerationTask = { id: 'image', kind: 'image', status: 'succeeded', createdAt: 1, updatedAt: 2,
  assetKind: 'character', imageVariant: 'portrait', backend: 'openai', model: 'fixture', name: 'Image', prompt: 'Image', width: 512, height: 512,
};
const project = { ...base.project,
  generationTasks: [success, other, failed, standalone, stopped, imageTask],
  assets: [asset('saved-video'), asset('unrelated-video'), asset('source-image', { type: 'reference', mediaType: 'image', role: 'composition' })],
};

{
  const before = JSON.stringify(project);
  const inspect = inspectVideoBatchDeletion(project, options);
  assert.equal(inspect.canDelete, true);
  assert.deepEqual(inspect.taskIds, ['successful', 'failed', 'stopped']);
  const result = removeVideoBatchKeepingProvenance(project, options);
  assert.deepEqual(result.removedTaskIds, inspect.taskIds);
  assert.deepEqual(result.project.generationTasks, [other, standalone, imageTask], 'all and only this batch video records disappear');
  assert.equal(JSON.stringify(project), before, 'the previous project is never mutated');
  assert.equal(result.project.assets.length, project.assets.length, 'videos and reference pictures remain in the library');
  assert.equal(result.project.assets[1], project.assets[1]);
  assert.equal(result.project.assets[2], project.assets[2]);
  const archived = result.project.assets[0];
  assert.equal(archived.relativePath, project.assets[0].relativePath);
  assert.equal(archived.checksum, project.assets[0].checksum);
  assert.deepEqual(archived.videoSourceTask, success);
  assert.notEqual(archived.videoSourceTask, success, 'provenance is an independent frozen snapshot');
  assert.equal(findProjectVideoTask(result.project, success.id), archived.videoSourceTask,
    'an active later batch can still find its completed source by task ID after deletion');
  assert.equal(findVideoAssetSourceTask(result.project, archived)?.id, success.id);
  assert.equal(findReusableVideoTask(result.project, success.id)?.videoJob?.snapshot.draft.parameters.seed, 42);
  const state = { ...base, project: result.project, projects: [result.project] };
  const reopened = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(reopened.project.generationTasks.filter(isVideoGenerationTask).some((entry) => entry.batchId === options.batchId), false);
  assert.equal(findProjectVideoTask(reopened.project, success.id)?.remoteTaskId, success.remoteTaskId,
    'save/load retains provenance without recreating queue records');
}

const unsafeCases: Array<{ label: string; value?: VideoGenerationTask; runtime?: VideoGenerationRuntime; activeLocalTaskId?: string }> = [
  { label: 'local preparation', value: { ...failed, status: 'submitting', videoJob: { ...failed.videoJob!, stage: 'preparing', preparation: { version: 1, phase: 'preparing', uploadedImages: [] } } } },
  { label: 'remote running', value: { ...failed, status: 'running', remoteTaskId: 'remote', videoJob: { ...failed.videoJob!, stage: 'running' } } },
  { label: 'locally stopped unresolved remote', value: { ...stopped, remoteTaskId: 'unresolved', videoJob: { ...stopped.videoJob!, cancellationConfirmed: false } } },
  { label: 'unknown paid POST', value: { ...stopped, status: 'unknown', videoJob: { ...stopped.videoJob!, cancellationConfirmed: false, preparation: { version: 1, phase: 'post-started', uploadedImages: [] } } } },
  { label: 'pending cancellation journal', value: { ...stopped, videoJob: { ...stopped.videoJob!, cancellationPending: true } } },
  { label: 'live downloading over stored success', value: success, runtime: { stage: 'downloading' } },
  { label: 'live running over stored failure', runtime: { stage: 'running' } },
  { label: 'live cancellation', runtime: { stage: 'failed', cancellationPending: true } },
  { label: 'live unknown over stored success', value: success, runtime: { stage: 'submission-unknown' } },
  ...(['preparing', 'queued', 'downloading'] as const).map((stage) => ({
    label: `stored ${stage} over stale stopped runtime`,
    value: { ...failed, videoJob: { ...failed.videoJob!, stage } },
    runtime: { stage: 'stopped' as const, trackingStopped: true },
  })),
  { label: 'live local worker', activeLocalTaskId: failed.id },
  { label: 'cloud result not downloaded', value: { ...success, resultAssetId: undefined, resultUrl: 'https://example.invalid/video.mp4' } },
  { label: 'download failed retains recovery', value: { ...failed, videoJob: { ...failed.videoJob!, downloadError: 'synthetic failure', remoteGenerationEnded: true } } },
  { label: 'pending result selection', value: { ...success, videoJob: { ...success.videoJob!, resultSelectionRequired: true } } },
  { label: 'foreign task owner', value: { ...failed, videoJob: { ...failed.videoJob!, snapshot: { ...failed.videoJob!.snapshot, projectId: 'foreign' } } } },
];
for (const item of unsafeCases) {
  const unsafe = item.value || failed;
  const mixed = { ...project, generationTasks: [task('safe-before'), unsafe, task('safe-after'), other] };
  const input = { ...options, activeLocalTaskId: item.activeLocalTaskId,
    getRuntime: (id: string) => id === unsafe.id ? item.runtime : undefined,
  };
  const result = removeVideoBatchKeepingProvenance(mixed, input);
  assert.equal(result.canDelete, false, item.label);
  assert.ok(result.blockedTaskIds.includes(unsafe.id), item.label);
  assert.equal(result.project, mixed, `${item.label}: preserve the entire batch, not just the unsafe row`);
  assert.deepEqual(result.removedTaskIds, []);
  assert.equal(mixed.assets[0].videoSourceTask, undefined, 'blocked deletion does not backfill or partially edit assets');
}

{
  let runtime: VideoGenerationRuntime = { stage: 'failed' };
  const isolated = { ...project, generationTasks: [failed] };
  const input = { ...options, getRuntime: () => runtime };
  assert.equal(inspectVideoBatchDeletion(isolated, input).canDelete, true);
  runtime = { stage: 'downloading' };
  const result = removeVideoBatchKeepingProvenance(isolated, input);
  assert.equal(result.project, isolated, 'commit re-reads live runtime after an earlier eligible render');
  assert.deepEqual(result.removedTaskIds, []);
}
{
  const foreign = { ...project, id: 'foreign-project' };
  assert.equal(removeVideoBatchKeepingProvenance(foreign, options).project, foreign);
  assert.equal(removeVideoBatchKeepingProvenance(project, { ...options, projectId: 'foreign-project' }).project, project);
  assert.deepEqual(removeVideoBatchKeepingProvenance(project, { ...options, batchId: 'missing' }).removedTaskIds, []);
  assert.equal(removeVideoBatchKeepingProvenance(project, { ...options, batchId: ' ' }).project, project);
  const empty = { ...project, generationTasks: [] };
  assert.equal(removeVideoBatchKeepingProvenance(empty, options).project, empty);
  assert.equal(inspectVideoBatchDeletion(empty, options).reason, undefined);
  const duplicated = { ...project, generationTasks: [failed, { ...failed, batchId: 'keep-batch' }] };
  assert.equal(removeVideoBatchKeepingProvenance(duplicated, options).project, duplicated, 'duplicate IDs cannot delete records belonging to another batch');
  const legacy = { ...project, generationTasks: [{ ...failed, kind: undefined, videoJob: undefined }] };
  assert.deepEqual(removeVideoBatchKeepingProvenance(legacy, options).removedTaskIds, [failed.id]);
}

// Continuation owns the original stopped row before any await/AI/child creation.
// Permanent lineage after a child is finished must not block deletion forever.
{
  const source = { ...stopped, requestFingerprint: 'source-fingerprint', videoJob: {
    ...stopped.videoJob!, batchContinuation: { version: 1 as const, planId: 'continuation', batchId: 'child-batch', taskId: 'child', revision: 1 },
  } };
  const child = task('child', { batchId: 'child-batch', requestFingerprint: 'child-fingerprint' });
  child.videoJob = { ...child.videoJob!, snapshot: { ...child.videoJob!.snapshot, continuedFrom: {
    version: 1, planId: 'continuation', batchId: source.batchId!, taskId: source.id, requestFingerprint: source.requestFingerprint,
  } } };
  const makeProject = (children: VideoGenerationTask[]) => ({ ...project, generationTasks: [source, ...children] });
  const missing = makeProject([]);
  assert.equal(removeVideoBatchKeepingProvenance(missing, options).project, missing, 'pre-creation claim must survive navigation away from the continuation UI');
  const activeChild = { ...child, status: 'running' as const, remoteTaskId: 'child-remote', videoJob: { ...child.videoJob!, stage: 'running' as const } };
  const historyRemoval = removeVideoBatchKeepingProvenance(makeProject([activeChild]), options);
  assert.equal(historyRemoval.canDelete, true, 'a live successor does not lock a terminal historical source');
  const retainedSource = historyRemoval.project.generationTasks.find((entry) => entry.id === source.id)!;
  assert.equal(isVisibleGenerationTask(retainedSource), false);
  assert.equal(findProjectVideoTask(historyRemoval.project, source.id)?.videoJob, source.videoJob, 'keep immutable lineage without changing execution');
  assert.equal(historyRemoval.project.generationTasks.find((entry) => entry.id === child.id), activeChild, 'the live successor is untouched');
  assert.equal(inspectVideoBatchDeletion(makeProject([child]), { ...options, getRuntime: (id) => id === child.id ? { stage: 'downloading' } : undefined }).canDelete, true,
    'descendant download remains independent of its historical source list entry');
  assert.deepEqual(removeVideoBatchKeepingProvenance(makeProject([child]), options).removedTaskIds, [source.id],
    'a precisely matched terminal child no longer needs its original claim row for active work');
  const completedChild = { ...child, status: 'succeeded' as const, resultAssetId: 'child-video', videoJob: { ...child.videoJob!, stage: 'succeeded' as const } };
  const archived = { ...makeProject([]), assets: [asset('child-video', { sourceVideoTaskId: child.id, videoSourceTask: completedChild })] };
  assert.equal(inspectVideoBatchDeletion(archived, options).canDelete, true, 'archived successful child provenance remains authoritative');
  const mismatched = { ...child, videoJob: { ...child.videoJob!, snapshot: { ...child.videoJob!.snapshot, continuedFrom: {
    ...child.videoJob!.snapshot.continuedFrom!, requestFingerprint: 'different-original',
  } } } };
  assert.equal(inspectVideoBatchDeletion(makeProject([mismatched]), options).canDelete, false);
  const waitingGrandchild = { ...child, videoJob: { ...child.videoJob!, batchContinuation: {
    version: 1 as const, planId: 'next-continuation', batchId: 'grandchild-batch', taskId: 'grandchild', revision: 1,
  } } };
  assert.equal(inspectVideoBatchDeletion(makeProject([waitingGrandchild]), options).canDelete, false, 'unfinished descendant claims remain recoverable');
  const released = { ...source, videoJob: { ...source.videoJob, batchContinuation: { ...source.videoJob.batchContinuation, released: true as const } } };
  assert.equal(inspectVideoBatchDeletion({ ...project, generationTasks: [released] }, options).canDelete, true, 'released pre-creation claims do not block a stopped row');

  const pair = makeProject([child]);
  const oldPair = JSON.stringify(pair);
  const removeChildFirst = removeVideoBatchKeepingProvenance(pair, { ...options, batchId: child.batchId! });
  assert.deepEqual(removeChildFirst.removedTaskIds, [child.id]);
  const parentAfterChild = removeChildFirst.project.generationTasks.find((entry) => entry.id === source.id) as VideoGenerationTask;
  assert.deepEqual(parentAfterChild.videoJob?.batchContinuation, { ...source.videoJob.batchContinuation, revision: 2, released: true },
    'deleting an unarchived terminal child releases exactly its parent claim atomically');
  assert.equal(parentAfterChild.status, source.status);
  assert.deepEqual(parentAfterChild.videoJob?.snapshot, source.videoJob.snapshot);
  assert.equal(videoBatchContinuationPersistenceIssue(parentAfterChild, projectId), undefined, 'released claim remains valid persisted protocol');
  assert.equal(JSON.stringify(pair), oldPair, 'undo can restore the original child and original unreleased claim together');
  assert.equal(inspectVideoBatchDeletion(pair, options).canDelete, true, 'the original undo snapshot remains independently valid');
  assert.deepEqual(removeVideoBatchKeepingProvenance(removeChildFirst.project, options).removedTaskIds, [source.id], 'child-first deletion does not permanently strand the parent');
  const removeParentFirst = removeVideoBatchKeepingProvenance(pair, options);
  assert.deepEqual(removeVideoBatchKeepingProvenance(removeParentFirst.project, { ...options, batchId: child.batchId! }).removedTaskIds, [child.id], 'parent-first deletion is also safe');
  const savedChildPair = { ...makeProject([completedChild]), assets: [asset('child-video')] };
  const removedSavedChild = removeVideoBatchKeepingProvenance(savedChildPair, { ...options, batchId: child.batchId! });
  assert.equal(removedSavedChild.project.generationTasks[0], source, 'an archived successful child retains the original claim without rewriting its parent');
  assert.equal(inspectVideoBatchDeletion(removedSavedChild.project, options).canDelete, true);
  const unrelatedParent = { ...source, id: 'unrelated-parent', batchId: 'other-parent-batch', requestFingerprint: 'different-original' };
  const withUnrelatedParent = { ...pair, generationTasks: [...pair.generationTasks, unrelatedParent] };
  const removedWithUnrelated = removeVideoBatchKeepingProvenance(withUnrelatedParent, { ...options, batchId: child.batchId! });
  assert.equal(removedWithUnrelated.project.generationTasks.find((entry) => entry.id === unrelatedParent.id), unrelatedParent,
    'a coincidental child ID never releases a nonmatching parent claim');
}

console.log(`Video batch deletion passed: atomic scoped removal, provenance/assets/save-load, ${unsafeCases.length} blocked states, fresh runtime recheck, continuation claims/descendants, empty batch, duplicate IDs and legacy records.`);

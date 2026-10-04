import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createVideoTaskCheckpointJournal, collectVideoFrozenAssets } = require('../electron/videoTaskCheckpoint.cjs');
const task = (phase = 'preparing') => ({
  id: 'video_task_fixed', kind: 'video', createdAt: 12, status: 'submitting', requestBody: {},
  videoJob: { stage: phase === 'preparing' ? 'preparing' : 'submitting', preparation: { version: 1, phase, uploadedImages: ['image.png'] },
    snapshot: { projectId: 'project-A', connection: { backend: 'api', api: { endpoint: 'https://video.test/tasks' } }, images: [] } },
});
const chainTask = (tailPhase = 'waiting', revision = 0, overrides = {}) => {
  const predecessor = {
    version: 1, predecessorTaskId: 'video_task_previous', predecessorItemKey: 'segment-1:zh',
    predecessorRequestFingerprint: 'request-previous', sequencePlanId: 'plan-1',
    predecessorSegmentId: 'segment-1', predecessorSegmentIndex: 1,
    segmentId: 'segment-2', segmentIndex: 2, referenceIndex: 0,
    referenceRole: 'first-frame', reservedFrameAssetId: 'tail-frame-2',
  };
  const source = { sequencePlanId: 'plan-1', segmentId: 'segment-2', segmentIndex: 2, language: 'zh' };
  const base = {
    id: 'video_task_second', kind: 'video', createdAt: 12, status: 'submitting', batchId: 'batch-1',
    batchItemKey: 'segment-2:zh', batchIndex: 2, batchTotal: 2, batchConcurrency: 1,
    requestFingerprint: 'request-second',
    sequencePlanId: 'plan-1', segmentId: 'segment-2', segmentIndex: 2,
    requestBody: {},
    videoJob: {
      stage: 'preparing',
      batchQueueState: 'ready',
      preparation: { version: 1, phase: 'preparing', uploadedImages: [null] },
      tailPreparation: {
        phase: tailPhase, revision,
        ...(tailPhase !== 'waiting' ? { sourceVideoAssetId: 'video-1', sourceRelativePath: 'video/segment-1.mp4', sourceChecksum: 'video-checksum' } : {}),
      },
      snapshot: {
        projectId: 'project-A', clientId: 'client-second', batchCompletionOrder: true,
        batchPredecessorTaskId: 'video_task_previous', previousTail: predecessor,
        draft: { name: 'segment-2', prompt: 'next prompt', backend: 'api', references: [{ assetId: 'tail-frame-2', role: 'first-frame' }], parameters: {}, source },
        connection: { backend: 'api', api: { endpoint: 'https://video.test/tasks' } },
        images: [{ assetId: 'tail-frame-2', role: 'first-frame', name: 'tail',
          ...(tailPhase === 'ready' ? { relativePath: 'frames/tail-frame-2.png', checksum: 'frame-checksum', freezeState: 'frozen' } : { freezeState: 'pending' }) }],
      },
    },
  };
  return { ...base, ...overrides, videoJob: { ...base.videoJob, ...(overrides.videoJob || {}) } };
};
const aiFrame = () => ({ fileName: '衔接候选.png', relativePath: 'frames/tail-frame-2.png', checksum: 'frame-checksum',
  sizeBytes: 4000, mediaType: 'image', mimeType: 'image/png', managed: true, missing: false,
  url: 'lianhua-asset://local/frames/tail-frame-2.png', timeSec: 9.2, frameIndex: 230, width: 1280, height: 720, role: 'custom-frame' });
const aiChainTask = (status, phase = 'extracting', revision = status === 'started' ? 2 : 3) => {
  const candidate = chainTask(phase, revision);
  candidate.videoJob.snapshot.previousTail.selectionMode = 'ai-assisted';
  if (status) candidate.videoJob.tailPreparation.selection = status === 'started' ? { status } : {
    status: 'completed', source: 'ai', selectedId: 'frame-4', reason: '不露脸的背影、半身与非人类物种都符合此段剧情；置信度低也只作说明。',
    warning: '较真实尾帧提前 0.7 秒，原片没有裁剪。', selectedTimeSec: 9.2, lastFrameTimeSec: 9.9, offsetFromEndSec: 0.7, candidateCount: 6,
    frame: aiFrame(),
  };
  return candidate;
};
function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-video-checkpoint-'));
  const journal = createVideoTaskCheckpointJournal({ directory, atomicWriteFile(file, text) { fs.writeFileSync(`${file}.tmp`, text); fs.renameSync(`${file}.tmp`, file); } });
  try { run(journal, directory); }
  finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('lianhua-video-checkpoint-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
test('journal survives restart and an older debounced project save cannot roll back POST boundary', () => fixture((journal, directory) => {
  assert.equal(journal.save(task()).persisted, true);
  journal.save(task('post-started'));
  journal.save(task());
  assert.equal(journal.get('video_task_fixed').videoJob.preparation.phase, 'post-started');
  const restored = createVideoTaskCheckpointJournal({ directory, atomicWriteFile: fs.writeFileSync });
  assert.equal(restored.get('video_task_fixed').videoJob.preparation.phase, 'post-started');
  journal.save(task('acknowledged'));
  assert.equal(journal.get('video_task_fixed').videoJob.preparation.phase, 'acknowledged');
}));
test('journal rejects task identity changes, malformed state and embedded secrets without leaking values', () => fixture((journal) => {
  journal.save(task());
  const changed = task(); changed.videoJob.snapshot.connection.api.endpoint = 'https://other.test/tasks';
  assert.throws(() => journal.save(changed), /身份或接口不一致/u);
  const secret = task(); secret.id = 'other-task'; secret.videoJob.snapshot.connection.api.apiKey = 'never-write-this-key';
  assert.throws(() => journal.save(secret), (error) => /密钥/u.test(error.message) && !error.message.includes('never-write-this-key'));
  assert.equal(journal.get('other-task'), null);
  assert.throws(() => journal.save({ id: 'invalid' }), /无效/u);
}));

test('remote generation terminal evidence is literal true and cannot be cleared by a late checkpoint', () => fixture((journal) => {
  const original = task('acknowledged'); original.remoteTaskId = 'remote-existing';
  journal.save(original);
  for (const value of [false, 'true', 1, {}, null]) {
    const malformed = structuredClone(original); malformed.videoJob.remoteGenerationEnded = value;
    assert.throws(() => journal.save(malformed), /远端结束记录无效/u);
  }
  const ended = structuredClone(original); ended.videoJob.remoteGenerationEnded = true;
  journal.save(ended);
  assert.equal(journal.get(ended.id).videoJob.remoteGenerationEnded, true);
  assert.throws(() => journal.save(original), /远端生成结束记录不能/u);
  assert.equal(journal.get(ended.id).videoJob.remoteGenerationEnded, true);
}));

test('continuation claims survive stale source writes and can only release before a new owner', () => fixture((journal) => {
  const source = chainTask('cancelled', 1);
  source.videoJob.batchQueueState = 'cancelled';
  journal.save(source);
  const claimed = structuredClone(source);
  claimed.videoJob.batchContinuation = { version: 1, planId: 'continue-1', batchId: 'continued-batch', taskId: 'continued-child', revision: 1 };
  journal.save(claimed);
  assert.throws(() => journal.save(source), /续跑认领/u);
  assert.equal(journal.get(source.id).videoJob.batchContinuation.taskId, 'continued-child');
  const stolen = structuredClone(claimed);
  stolen.videoJob.batchContinuation = { ...stolen.videoJob.batchContinuation, taskId: 'another-child', revision: 2 };
  assert.throws(() => journal.save(stolen), /认领/u);
  const released = structuredClone(claimed);
  released.videoJob.batchContinuation = { ...released.videoJob.batchContinuation, revision: 2, released: true };
  journal.save(released);
  assert.throws(() => journal.save(claimed), /认领/u);
  const retried = structuredClone(released);
  retried.videoJob.batchContinuation = { version: 1, planId: 'continue-2', batchId: 'retry-batch', taskId: 'retry-child', revision: 3 };
  journal.save(retried);
  assert.equal(journal.get(source.id).videoJob.batchContinuation.planId, 'continue-2');
  assert.equal(journal.get(source.id).videoJob.tailPreparation.phase, 'cancelled', 'claiming a replacement never revives the original cancelled task');
}));

test('continued task lineage is immutable even for a non-chain first suffix item', () => fixture((journal) => {
  const child = task();
  child.batchId = 'continued-batch'; child.requestFingerprint = 'child-request';
  child.videoJob.snapshot.clientId = 'continued-client';
  child.videoJob.snapshot.continuedFrom = { version: 1, planId: 'continue-1', batchId: 'original-batch', taskId: 'source-task', requestFingerprint: 'source-request' };
  journal.save(child);
  const erased = structuredClone(child); delete erased.videoJob.snapshot.continuedFrom;
  assert.throws(() => journal.save(erased), /续跑来源/u);
  const replaced = structuredClone(child); replaced.videoJob.snapshot.continuedFrom.taskId = 'unrelated-task';
  assert.throws(() => journal.save(replaced), /续跑来源/u);
  const self = structuredClone(child); self.id = 'self-child'; self.videoJob.snapshot.continuedFrom.taskId = self.id;
  assert.throws(() => journal.save(self), /续跑/u);
  const malformed = structuredClone(child); malformed.id = 'malformed'; malformed.videoJob.snapshot.continuedFrom = { ...malformed.videoJob.snapshot.continuedFrom, arbitraryTask: {} };
  assert.throws(() => journal.save(malformed), /续跑/u);
}));
test('corrupt or mismatched journal is not treated as absent permission to submit again', () => fixture((journal, directory) => {
  journal.save(task('post-started'));
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => journal.get('video_task_fixed'), /不会自动重新生成/u);
  fs.writeFileSync(file, JSON.stringify({ ...task(), id: 'different-task' }));
  assert.throws(() => journal.get('video_task_fixed'), /不会自动重新生成/u);
}));
test('delete targets only the hashed task file, not neighbouring task records', () => fixture((journal) => {
  journal.save(task()); journal.save({ ...task(), id: '../other-task' });
  assert.equal(journal.delete('video_task_fixed'), true);
  assert.equal(journal.delete('video_task_fixed'), false);
  assert.equal(journal.get('../other-task').id, '../other-task');
}));
test('project exports include frozen input files after deleting original image and task records', () => {
  const source = task('acknowledged');
  source.videoJob.snapshot.images = [{ assetId: 'deleted-image', relativePath: 'images/original.png', checksum: 'original-hash' }];
  const project = { id: 'project-A', generationTasks: [source], assets: [{ id: 'video-result', videoSourceTask: source }] };
  assert.equal(collectVideoFrozenAssets(project).length, 1, 'same file is deduplicated');
  project.generationTasks = [];
  assert.equal(collectVideoFrozenAssets(project)[0].relativePath, 'images/original.png');
  assert.equal(collectVideoFrozenAssets({ ...project, id: 'other-project' }).length, 0, 'never import another project through provenance');
});

test('tail dependency checkpoints accept valid monotonic waiting/extracting/ready progress', () => fixture((journal) => {
  for (const [phase, revision] of [['waiting', 0], ['extracting', 1], ['ready', 2]]) {
    const candidate = chainTask(phase, revision);
    if (phase === 'ready') candidate.videoJob.preparation.phase = 'preparing';
    assert.equal(journal.save(candidate).persisted, true, phase);
  }
  assert.equal(journal.get('video_task_second').videoJob.tailPreparation.phase, 'ready');
  assert.equal(journal.get('video_task_second').videoJob.tailPreparation.revision, 2);
}));

test('tail dependency definitions, predecessor order and reserved frame slot are immutable', () => fixture((journal) => {
  journal.save(chainTask('waiting', 0));
  for (const mutate of [
    (candidate) => { candidate.videoJob.snapshot.previousTail.predecessorTaskId = 'another-task'; },
    (candidate) => { candidate.videoJob.snapshot.previousTail.referenceIndex = 1; },
    (candidate) => { candidate.videoJob.snapshot.previousTail.reservedFrameAssetId = 'other-frame'; },
    (candidate) => { candidate.videoJob.snapshot.batchPredecessorTaskId = 'other-predecessor'; },
    (candidate) => { candidate.videoJob.snapshot.draft.references[0].assetId = 'other-frame'; },
    (candidate) => { candidate.requestFingerprint = 'other-fingerprint'; },
    (candidate) => { candidate.videoJob.snapshot.draft.name = 'another-name'; },
    (candidate) => { candidate.videoJob.snapshot.draft.prompt = 'another-prompt'; },
    (candidate) => { candidate.videoJob.snapshot.draft.source.language = 'en'; },
    (candidate) => { candidate.videoJob.snapshot.draft.parameters = { duration: 20 }; },
  ]) {
    const changed = structuredClone(chainTask('extracting', 1)); mutate(changed);
    assert.throws(() => journal.save(changed), /依赖定义|身份或接口不一致|无效/u);
  }
}));

test('tail checkpoints reject unknown versions, malformed phases, bad provenance and untrusted locators', () => fixture((journal) => {
  const cases = [
    (candidate) => { candidate.videoJob.snapshot.previousTail.version = 2; },
    (candidate) => { candidate.videoJob.tailPreparation.phase = 'ready-soon'; },
    (candidate) => { candidate.videoJob.tailPreparation.revision = -1; },
    (candidate) => { candidate.videoJob.snapshot.previousTail.segmentIndex = 4; },
    (candidate) => { candidate.videoJob.snapshot.previousTail.referenceRole = 'subject'; },
    (candidate) => { candidate.videoJob.snapshot.previousTail.predecessorSegmentId = 'segment-2'; },
    (candidate) => { candidate.videoJob.tailPreparation.sourceRelativePath = '../outside.png'; },
    (candidate) => { candidate.videoJob.tailPreparation.sourceChecksum = ''; },
    (candidate) => { candidate.videoJob.snapshot.images[0].freezeState = 'frozen'; },
    (candidate) => { candidate.videoJob.snapshot.previousTail.extra = 'must-reject'; },
    (candidate) => { candidate.videoJob.tailPreparation.extra = 'must-reject'; },
    (candidate) => { candidate.videoJob.snapshot.batchCompletionOrder = false; },
    (candidate) => { candidate.videoJob.snapshot.batchPredecessorTaskId = 'different-parent'; },
    (candidate) => { candidate.batchIndex = 1; },
    (candidate) => { candidate.batchTotal = 1; },
    (candidate) => { delete candidate.requestFingerprint; },
    (candidate) => { candidate.videoJob.snapshot.images[0].dataUrl = 'data:image/png;base64,dummy'; },
    (candidate) => { candidate.videoJob.snapshot.images[0].relativePath = 'frames/placeholder.png'; },
    (candidate) => { candidate.videoJob.snapshot.parentTask = { id: 'nested-parent' }; },
    (candidate) => { delete candidate.videoJob.snapshot.previousTail; },
  ];
  for (const mutate of cases) {
    const candidate = structuredClone(chainTask('waiting', 0)); mutate(candidate);
    assert.throws(() => journal.save(candidate), /无效|不受支持|依赖|停止自动/u);
  }
}));

test('tail revision cannot go backwards or replace a cancelled tombstone with stale same-phase work', () => fixture((journal) => {
  journal.save(chainTask('waiting', 0));
  journal.save(chainTask('extracting', 1));
  assert.throws(() => journal.save(chainTask('waiting', 0)), /修订号已过期/u, 'old progress must not claim it is a fresh durable POST authorization');
  assert.equal(journal.get('video_task_second').videoJob.tailPreparation.phase, 'extracting');
  const cancelled = chainTask('cancelled', 2, { status: 'failed', videoJob: { batchQueueState: 'cancelled', stage: 'stopped', preparation: { version: 1, phase: 'preparing', uploadedImages: [null] } } });
  journal.save(cancelled);
  const staleReady = chainTask('ready', 2);
  staleReady.videoJob.batchQueueState = 'ready';
  assert.throws(() => journal.save(staleReady), /已取消/u);
  const final = journal.get('video_task_second');
  assert.equal(final.videoJob.tailPreparation.phase, 'cancelled');
  assert.equal(final.videoJob.batchQueueState, 'cancelled');
}));

test('tail cancellation remains terminal after a restart and never revives a billable preparation', () => fixture((journal, directory) => {
  const cancelled = chainTask('cancelled', 4, { status: 'failed', videoJob: { batchQueueState: 'cancelled', stage: 'stopped', preparation: { version: 1, phase: 'preparing', uploadedImages: [null] } } });
  journal.save(cancelled);
  const restarted = createVideoTaskCheckpointJournal({ directory, atomicWriteFile: fs.writeFileSync });
  const restored = restarted.get(cancelled.id);
  assert.equal(restored.videoJob.tailPreparation.phase, 'cancelled');
  assert.equal(restored.videoJob.batchQueueState, 'cancelled');
  assert.equal(restored.remoteTaskId, undefined);
  assert.equal(restored.videoJob.preparation.phase, 'preparing');
}));

test('tail ready progress cannot be reopened or swapped to another frozen frame', () => fixture((journal) => {
  journal.save(chainTask('ready', 2));
  for (const mutate of [
    (candidate) => { candidate.videoJob.tailPreparation.phase = 'extracting'; },
    (candidate) => { candidate.videoJob.tailPreparation.revision = 3; candidate.videoJob.tailPreparation.phase = 'ready'; candidate.videoJob.snapshot.images[0].assetId = 'other-frame'; candidate.videoJob.snapshot.draft.references[0].assetId = 'other-frame'; },
    (candidate) => { candidate.videoJob.tailPreparation.revision = 3; candidate.videoJob.tailPreparation.sourceChecksum = 'other-video'; },
  ]) {
    const changed = structuredClone(chainTask('ready', 2)); mutate(changed);
    assert.throws(() => journal.save(changed), /不能回退|不能更换|依赖定义|依赖记录无效|冲突/u);
  }
}));

test('ready tail may normalize preview metadata without changing its immutable local pixels', () => fixture((journal) => {
  const ready = chainTask('ready', 2);
  ready.videoJob.snapshot.images[0].url = 'lianhua-asset://local/frames/tail-frame-2.png';
  journal.save(ready);
  const normalized = structuredClone(ready);
  delete normalized.videoJob.snapshot.images[0].url;
  normalized.videoJob.snapshot.images[0].name = 'normalized display name';
  normalized.videoJob.snapshot.images[0].fileName = 'download-safe-name.png';
  assert.equal(journal.save(normalized).persisted, true);
  assert.equal(journal.get(ready.id).videoJob.snapshot.images[0].checksum, 'frame-checksum');
}));

test('persist retry and cancellation preserve a ready frozen frame without authorizing an unresolved POST', () => fixture((journal) => {
  const ready = chainTask('ready', 2);
  journal.save(ready);
  const blocked = structuredClone(ready);
  blocked.videoJob.tailPreparation = { ...blocked.videoJob.tailPreparation, phase: 'blocked', revision: 3, errorCode: 'persist-failed', message: '主项目落盘失败，等待重试。' };
  assert.equal(journal.save(blocked).persisted, true);
  const invalidPost = structuredClone(blocked);
  invalidPost.videoJob.preparation.phase = 'post-started';
  assert.throws(() => journal.save(invalidPost), /依赖记录无效/u);
  const rebound = structuredClone(blocked);
  rebound.videoJob.tailPreparation.revision += 1;
  rebound.videoJob.snapshot.images[0].checksum = 'another-frame';
  assert.throws(() => journal.save(rebound), /真实尾帧不能/u);
  const retried = structuredClone(blocked);
  retried.videoJob.tailPreparation = { ...ready.videoJob.tailPreparation, revision: 4 };
  assert.equal(journal.save(retried).persisted, true);
  const cancelled = structuredClone(retried);
  cancelled.videoJob.tailPreparation = { ...retried.videoJob.tailPreparation, phase: 'cancelled', revision: 5 };
  cancelled.videoJob.batchQueueState = 'cancelled';
  cancelled.videoJob.stage = 'stopped';
  assert.equal(journal.save(cancelled).persisted, true);
  assert.equal(journal.get(ready.id).videoJob.snapshot.images[0].checksum, 'frame-checksum');
  const latePost = structuredClone(retried);
  latePost.videoJob.preparation.phase = 'post-started';
  assert.throws(() => journal.save(latePost), /已取消/u);
}));

test('new ready journal remains authoritative when an older project task still has an empty reserved slot', () => fixture((journal, directory) => {
  const oldMain = chainTask('waiting', 0);
  journal.save(oldMain);
  journal.save(chainTask('extracting', 1));
  journal.save(chainTask('ready', 2));
  const restarted = createVideoTaskCheckpointJournal({ directory, atomicWriteFile: fs.writeFileSync });
  const durable = restarted.get(oldMain.id);
  assert.deepEqual(durable.videoJob.snapshot.draft, oldMain.videoJob.snapshot.draft);
  assert.deepEqual(durable.videoJob.snapshot.previousTail, oldMain.videoJob.snapshot.previousTail);
  assert.equal(oldMain.videoJob.snapshot.images[0].relativePath, undefined);
  assert.equal(durable.videoJob.snapshot.images[0].relativePath, 'frames/tail-frame-2.png');
  assert.throws(() => restarted.save(oldMain), /修订号已过期/u);
  const post = structuredClone(durable);
  post.videoJob.preparation.phase = 'post-started';
  restarted.save(post);
  assert.throws(() => restarted.save(durable), /已越过提交边界/u);
  assert.equal(restarted.get(oldMain.id).videoJob.preparation.phase, 'post-started');
}));

test('ordered manual rows keep a cancellation tombstone even without a previous-tail slot', () => fixture((journal) => {
  const first = chainTask('waiting', 0);
  first.id = 'video_task_first'; first.batchIndex = 1; first.batchItemKey = 'segment-1:zh';
  delete first.videoJob.snapshot.previousTail;
  delete first.videoJob.snapshot.batchPredecessorTaskId;
  delete first.videoJob.tailPreparation;
  first.videoJob.snapshot.images = [];
  first.videoJob.snapshot.draft.references = [];
  const cancelled = structuredClone(first);
  cancelled.videoJob.batchQueueState = 'cancelled';
  cancelled.videoJob.stage = 'stopped';
  journal.save(cancelled);
  assert.throws(() => journal.save(first), /已取消/u);
  assert.equal(journal.get(first.id).videoJob.batchQueueState, 'cancelled');
}));

test('AI tail checkpoints survive started/result-before-binding/ready without semantic interception', () => fixture((journal, directory) => {
  const waiting = aiChainTask(undefined, 'waiting', 0);
  journal.save(waiting);
  journal.save(aiChainTask(undefined, 'extracting', 1));
  journal.save(aiChainTask('started'));
  const selected = aiChainTask('completed');
  journal.save(selected);
  const restored = createVideoTaskCheckpointJournal({ directory, atomicWriteFile: fs.writeFileSync }).get(selected.id);
  assert.equal(restored.videoJob.tailPreparation.phase, 'extracting');
  assert.equal(restored.videoJob.snapshot.images[0].freezeState, 'pending');
  assert.deepEqual(restored.videoJob.tailPreparation.selection, selected.videoJob.tailPreparation.selection);
  const ready = aiChainTask('completed', 'ready', 4);
  journal.save(ready);
  ready.videoJob.preparation.phase = 'post-started';
  journal.save(ready);
  assert.equal(journal.get(ready.id).videoJob.preparation.phase, 'post-started');
  assert.match(journal.get(ready.id).videoJob.tailPreparation.selection.reason, /非人类.*置信度低/u);
}));

test('AI started boundary cannot be cleared by same-revision, late or newer empty progress', () => fixture((journal) => {
  const started = aiChainTask('started'); journal.save(started);
  for (const [phase, revision] of [['extracting', 1], ['extracting', 2], ['extracting', 3], ['blocked', 4], ['cancelled', 5]]) {
    assert.throws(() => journal.save(aiChainTask(undefined, phase, revision)), /修订号|冲突|选帧进展/u);
    assert.deepEqual(journal.get(started.id).videoJob.tailPreparation.selection, { status: 'started' });
  }
  const cancelled = aiChainTask('started', 'cancelled', 6);
  cancelled.videoJob.batchQueueState = 'cancelled'; cancelled.videoJob.stage = 'stopped';
  journal.save(cancelled);
  assert.deepEqual(journal.get(started.id).videoJob.tailPreparation.selection, { status: 'started' });
  assert.throws(() => journal.save(aiChainTask('completed', 'extracting', 7)), /已取消/u);
}));

test('AI bounded retries persist every attempt and accept a provider-confirmed smaller token ceiling', () => fixture((journal, directory) => {
  const candidate = aiChainTask('started');
  Object.assign(candidate.videoJob.snapshot.previousTail, { requireAiSelection: true, aiMaxAttempts: 4 });
  Object.assign(candidate.videoJob.tailPreparation.selection, { run: 1, attempt: 1, maxAttempts: 4, maxTokens: 8192 });
  journal.save(candidate);
  for (const attempt of [2, 3, 4]) {
    candidate.videoJob.tailPreparation.revision += 1;
    Object.assign(candidate.videoJob.tailPreparation.selection, { attempt, maxTokens: attempt === 2 ? 4096 : 8192 });
    journal.save(candidate);
    const restored = createVideoTaskCheckpointJournal({ directory, atomicWriteFile: fs.writeFileSync });
    assert.equal(restored.get(candidate.id).videoJob.tailPreparation.selection.attempt, attempt);
  }
  const completed = aiChainTask('completed', 'extracting', candidate.videoJob.tailPreparation.revision + 1);
  completed.videoJob.snapshot.previousTail = structuredClone(candidate.videoJob.snapshot.previousTail);
  Object.assign(completed.videoJob.tailPreparation.selection, { run: 1, attempt: 4, maxAttempts: 4, maxTokens: 8192 });
  journal.save(completed);
  assert.equal(journal.get(candidate.id).videoJob.tailPreparation.selection.status, 'completed');
  assert.equal(journal.get(candidate.id).videoJob.tailPreparation.selection.attempt, 4);
}));

test('AI retry counters cannot disappear, move backwards, skip attempts or change a settled boundary', () => fixture((journal) => {
  const previous = aiChainTask('started');
  Object.assign(previous.videoJob.tailPreparation.selection, { run: 2, attempt: 2, maxAttempts: 4, maxTokens: 8192 });
  journal.save(previous);
  for (const update of [
    { run: undefined, attempt: undefined, maxAttempts: undefined, maxTokens: undefined },
    { run: 1 }, { attempt: 1 }, { attempt: 4 }, { run: 4, attempt: 1 },
    { run: 3, attempt: 2 }, { maxAttempts: 3 }, { maxTokens: 4096 },
  ]) {
    const incoming = structuredClone(previous); incoming.videoJob.tailPreparation.revision += 1;
    Object.assign(incoming.videoJob.tailPreparation.selection, update);
    assert.throws(() => journal.save(incoming), /尝试次数|尾帧依赖/u);
  }
  const completed = aiChainTask('completed', 'extracting', previous.videoJob.tailPreparation.revision + 1);
  Object.assign(completed.videoJob.tailPreparation.selection, { run: 2, attempt: 3, maxAttempts: 4, maxTokens: 8192 });
  assert.throws(() => journal.save(completed), /尝试次数/u, '完成结果必须对应已经保存的收费边界');
  const current = journal.get(previous.id);
  assert.deepEqual(current.videoJob.tailPreparation.selection, previous.videoJob.tailPreparation.selection);
}));

test('an explicit new AI run starts at attempt one without rewriting the frozen legacy budget', () => fixture((journal) => {
  const legacy = aiChainTask('started', 'blocked', 2);
  legacy.videoJob.snapshot.previousTail.requireAiSelection = true;
  journal.save(legacy);
  const next = structuredClone(legacy);
  Object.assign(next.videoJob.tailPreparation, { phase: 'extracting', revision: 3, selection: { status: 'started', run: 1, attempt: 1, maxAttempts: 4, maxTokens: 4096 } });
  journal.save(next);
  next.videoJob.tailPreparation.revision += 1; next.videoJob.tailPreparation.phase = 'blocked'; journal.save(next);
  next.videoJob.tailPreparation.revision += 1; next.videoJob.tailPreparation.phase = 'extracting';
  Object.assign(next.videoJob.tailPreparation.selection, { run: 2, attempt: 1, maxTokens: 8192 }); journal.save(next);
  assert.equal(journal.get(next.id).videoJob.snapshot.previousTail.aiMaxAttempts, undefined);
  assert.equal(journal.get(next.id).videoJob.tailPreparation.selection.run, 2);
  const changedPolicy = structuredClone(next); changedPolicy.videoJob.snapshot.previousTail.aiMaxAttempts = 4;
  assert.throws(() => journal.save(changedPolicy), /身份|定义/u, '不可为旧任务悄悄改写付费预算快照');
}));

test('AI retry policy and attempt metadata reject damaged counters but keep status-only history readable', () => fixture((journal) => {
  for (const update of [
    { run: 0 }, { run: 1.5 }, { attempt: 0 }, { attempt: 5 }, { maxAttempts: 0 }, { maxAttempts: 5 },
    { maxTokens: 0 }, { maxTokens: Number.MAX_SAFE_INTEGER + 1 }, { attempt: undefined }, { run: '1' },
  ]) {
    const candidate = aiChainTask('started');
    Object.assign(candidate.videoJob.tailPreparation.selection, { run: 1, attempt: 1, maxAttempts: 4, maxTokens: 4096 }, update);
    assert.throws(() => journal.save(candidate), /尾帧依赖/u);
  }
  for (const aiMaxAttempts of [0, 5, 1.5, '4', null]) {
    const candidate = aiChainTask('started'); candidate.videoJob.snapshot.previousTail.aiMaxAttempts = aiMaxAttempts;
    assert.throws(() => journal.save(candidate), /尾帧依赖/u);
  }
  const legacy = aiChainTask('started'); journal.save(legacy);
  assert.deepEqual(journal.get(legacy.id).videoJob.tailPreparation.selection, { status: 'started' });
}));

test('AI completed choice cannot regress, disappear or swap pixels before binding or after cancellation', () => fixture((journal) => {
  const completed = aiChainTask('completed'); journal.save(completed);
  for (const mutate of [
    (candidate) => { delete candidate.videoJob.tailPreparation.selection; },
    (candidate) => { candidate.videoJob.tailPreparation.selection = { status: 'started' }; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.frame.checksum = 'replacement'; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.frame.relativePath = 'frames/other.png'; candidate.videoJob.tailPreparation.selection.frame.url = 'lianhua-asset://local/frames/other.png'; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.selectedId = 'frame-5'; },
  ]) {
    const changed = aiChainTask('completed', 'extracting', 4); mutate(changed);
    assert.throws(() => journal.save(changed), /选帧进展/u);
  }
  journal.save(aiChainTask('completed', 'blocked', 5));
  journal.save(aiChainTask('completed', 'ready', 6));
  const cancelled = aiChainTask('completed', 'ready', 7);
  cancelled.videoJob.tailPreparation.phase = 'cancelled';
  cancelled.videoJob.batchQueueState = 'cancelled'; cancelled.videoJob.stage = 'stopped';
  journal.save(cancelled);
  assert.deepEqual(journal.get(completed.id).videoJob.tailPreparation.selection, completed.videoJob.tailPreparation.selection);
}));

test('AI fallback may complete without a billable start and preserve last-frame warning', () => fixture((journal) => {
  journal.save(aiChainTask(undefined, 'extracting', 1));
  const fallback = aiChainTask('completed');
  Object.assign(fallback.videoJob.tailPreparation.selection, { source: 'last-frame', selectedId: 'last',
    reason: '保留真实尾帧。', warning: '视觉 API 未启用，已回退尾帧继续。', selectedTimeSec: 9.9, offsetFromEndSec: 0 });
  Object.assign(fallback.videoJob.tailPreparation.selection.frame, { timeSec: 9.9, frameIndex: 249, role: 'last-frame' });
  journal.save(fallback);
  assert.equal(journal.get(fallback.id).videoJob.tailPreparation.selection.source, 'last-frame');
}));

test('AI selected-frame display name and encoded preview URL may normalize without changing its pixels', () => fixture((journal) => {
  const selected = aiChainTask('completed');
  Object.assign(selected.videoJob.tailPreparation.selection.frame, { relativePath: 'frames/中文 候选.png', url: 'lianhua-asset://local/frames/中文 候选.png' });
  journal.save(selected);
  const encoded = structuredClone(selected);
  encoded.videoJob.tailPreparation.selection.frame.url = 'lianhua-asset://local/frames/%E4%B8%AD%E6%96%87%20%E5%80%99%E9%80%89.png';
  encoded.videoJob.tailPreparation.selection.frame.fileName = '更清晰的显示名称.png';
  assert.equal(journal.save(encoded).persisted, true);
  const withoutPreview = structuredClone(encoded);
  delete withoutPreview.videoJob.tailPreparation.selection.frame.url;
  withoutPreview.videoJob.tailPreparation.revision += 1;
  assert.equal(journal.save(withoutPreview).persisted, true);
  assert.equal(journal.get(selected.id).videoJob.tailPreparation.selection.frame.relativePath, 'frames/中文 候选.png');
}));

test('AI selection persistence rejects only damaged protocol, untrusted files and embedded payloads', () => fixture((journal) => {
  for (const mutate of [
    (candidate) => { candidate.videoJob.snapshot.previousTail.selectionMode = 'unknown-mode'; },
    (candidate) => { delete candidate.videoJob.snapshot.previousTail.selectionMode; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.status = 'unknown'; },
    (candidate) => { delete candidate.videoJob.tailPreparation.selection.frame; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.candidateCount = 0; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.selectedTimeSec = Number.NaN; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.frame.relativePath = '../outside.png'; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.frame.url = 'https://untrusted.example/?api_key=secret'; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.frame.dataUrl = 'data:image/png;base64,c2VjcmV0'; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.reason = 'data:image/png;base64,c2VjcmV0'; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.apiKey = 'never-persist'; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.frame.missing = true; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.frame.checksumMismatch = true; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.frame.timeSec = 8.1; },
    (candidate) => { candidate.videoJob.tailPreparation.selection.selectedId = {}; },
  ]) {
    const candidate = aiChainTask('completed'); mutate(candidate);
    assert.throws(() => journal.save(candidate), /无效|密钥/u);
    assert.equal(journal.get(candidate.id), null);
  }
  const missingReadySelection = aiChainTask(undefined, 'ready', 4);
  assert.throws(() => journal.save(missingReadySelection), /无效/u);
  const wrongBoundFrame = aiChainTask('completed', 'ready', 4);
  wrongBoundFrame.videoJob.snapshot.images[0].checksum = 'other-checksum';
  assert.throws(() => journal.save(wrongBoundFrame), /无效/u);
}));

test('one-click strict AI marker persists and never permits an unreviewed fallback', () => fixture((journal) => {
  const selected = aiChainTask('completed'); selected.videoJob.snapshot.previousTail.requireAiSelection = true;
  journal.save(selected);
  assert.equal(journal.get(selected.id).videoJob.snapshot.previousTail.requireAiSelection, true);
  const fallback = aiChainTask('completed'); fallback.id = 'strict-fallback';
  fallback.videoJob.snapshot.previousTail.requireAiSelection = true;
  Object.assign(fallback.videoJob.tailPreparation.selection, { source: 'last-frame', selectedTimeSec: 9.9, offsetFromEndSec: 0 });
  Object.assign(fallback.videoJob.tailPreparation.selection.frame, { timeSec: 9.9, frameIndex: 249, role: 'last-frame' });
  assert.throws(() => journal.save(fallback), /无效/u); assert.equal(journal.get(fallback.id), null);
  for (const flag of [false, 'true']) {
    const invalid = aiChainTask('completed'); invalid.id = `invalid-${flag}`; invalid.videoJob.snapshot.previousTail.requireAiSelection = flag;
    assert.throws(() => journal.save(invalid), /无效/u);
  }
}));

test('exports include durable AI-selected pixels before binding, deduplicate provenance and isolate projects', () => {
  const selected = aiChainTask('completed');
  const project = { id: 'project-A', generationTasks: [selected], assets: [{ id: 'video-result', videoSourceTask: structuredClone(selected) }] };
  assert.deepEqual(collectVideoFrozenAssets(project).map(({ relativePath, checksum }) => ({ relativePath, checksum })),
    [{ relativePath: 'frames/tail-frame-2.png', checksum: 'frame-checksum' }]);
  project.generationTasks = [];
  assert.equal(collectVideoFrozenAssets(project).length, 1);
  assert.equal(collectVideoFrozenAssets({ ...project, id: 'project-B' }).length, 0);
  project.assets[0].videoSourceTask.videoJob.tailPreparation.selection.frame.relativePath = '../outside.png';
  assert.equal(collectVideoFrozenAssets(project).length, 0);
});

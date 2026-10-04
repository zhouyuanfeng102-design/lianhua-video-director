import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { defaultRunningHubVideoApi } from '../src/videoGenerationApi';
import type { VideoGenerationTask } from '../src/types';

const require = createRequire(import.meta.url);
const { createVideoTaskCheckpointJournal, validateVideoResultSelection } = require('../electron/videoTaskCheckpoint.cjs');
const base = createInitialState();
const task = (ids = ['video-a', 'video-b']): VideoGenerationTask => ({
  id: 'zip-result-task', kind: 'video', status: 'succeeded', targetId: 'runninghub', storyboardId: '',
  remoteTaskId: 'original-cloud-task', resultUrl: 'https://example.test/result.zip',
  requestBody: {}, createdAt: 1, updatedAt: 2,
  ...(ids.length === 1 ? { resultAssetId: ids[0] } : {}),
  videoJob: {
    stage: 'succeeded', resultAssetIds: ids, resultSelectionRequired: ids.length > 1,
    resultArchiveFileName: '云端视频.zip',
    preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] },
    snapshot: {
      projectId: base.project.id, clientId: 'zip-client',
      connection: { backend: 'api', api: { ...defaultRunningHubVideoApi, endpoint: 'https://example.test/run' } },
      draft: { name: 'ZIP test', prompt: 'ordinary landscape', backend: 'api', references: [], parameters: {} },
      images: [],
    },
  },
} as VideoGenerationTask);
const restore = (candidate: VideoGenerationTask): VideoGenerationTask => {
  const state = { ...base, project: { ...base.project, generationTasks: [candidate] }, projects: [] };
  const normalized = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  return normalized.project.generationTasks[0] as VideoGenerationTask;
};

for (const candidate of [task(), task(['single-video'])]) {
  const restored = restore(candidate);
  assert.deepEqual(restored.videoJob!.resultAssetIds, candidate.videoJob!.resultAssetIds);
  assert.equal(restored.videoJob!.resultSelectionRequired, candidate.videoJob!.resultSelectionRequired);
  assert.equal(restored.videoJob!.resultArchiveFileName, '云端视频.zip');
  assert.equal(restored.resultAssetId, candidate.resultAssetId);
  assert.equal(restored.remoteTaskId, 'original-cloud-task');
  assert.equal(restored.videoJob!.trackingStopped, undefined);
  validateVideoResultSelection(restored);
}
const selected = task();
selected.resultAssetId = 'video-b';
selected.videoJob!.resultSelectionRequired = false;
assert.equal(restore(selected).resultAssetId, 'video-b');
validateVideoResultSelection(restore(selected));

const legacy = task(['legacy-video']);
delete legacy.videoJob!.resultAssetIds;
delete legacy.videoJob!.resultSelectionRequired;
delete legacy.videoJob!.resultArchiveFileName;
assert.deepEqual(restore(legacy), legacy, 'old single-result task is unchanged');
validateVideoResultSelection(legacy);

const invalidCases: Array<(value: any) => void> = [
  (value) => { value.videoJob.resultAssetIds = []; },
  (value) => { value.videoJob.resultAssetIds = ['same', 'same']; },
  (value) => { value.videoJob.resultAssetIds = 'video-a'; },
  (value) => { value.videoJob.resultAssetIds = ['video-a', null]; },
  (value) => { value.videoJob.resultAssetIds = ['video-a', 'bad\u0000id']; },
  (value) => { value.videoJob.resultAssetIds = ['video-a', ' bad-id ']; },
  (value) => { value.videoJob.resultAssetIds = Array.from({ length: 129 }, (_, index) => `video-${index}`); },
  (value) => { value.videoJob.resultSelectionRequired = 'false'; },
  (value) => { value.videoJob.resultSelectionRequired = false; },
  (value) => { delete value.videoJob.resultSelectionRequired; },
  (value) => { value.resultAssetId = 'video-a'; },
  (value) => { value.resultAssetId = 'foreign'; value.videoJob.resultSelectionRequired = false; },
  (value) => { delete value.videoJob.resultAssetIds; },
  (value) => { value.videoJob.resultArchiveFileName = ''; },
  (value) => { value.videoJob.resultArchiveFileName = '../outside.zip'; },
  (value) => { value.videoJob.resultArchiveFileName = 'bad\u0000.zip'; },
];
for (const [index, mutate] of invalidCases.entries()) {
  const candidate = task();
  mutate(candidate);
  const rawIds = candidate.videoJob!.resultAssetIds;
  assert.throws(() => validateVideoResultSelection(candidate), /成片清单或选择记录无效/u, `invalid checkpoint ${index}`);
  const restored = restore(candidate);
  assert.equal(restored.videoJob!.resultSelectionRequired, true, `selection gate retained ${index}`);
  assert.equal(restored.videoJob!.trackingStopped, true, `tracking stopped ${index}`);
  assert.equal(restored.videoJob!.stage, 'stopped');
  assert.equal(restored.status, 'succeeded', 'cloud success is not relabelled remote failure');
  assert.deepEqual(restored.videoJob!.resultAssetIds, rawIds, 'raw list retained for recovery');
  assert.equal(restored.remoteTaskId, candidate.remoteTaskId, 'known remote identity retained');
  assert.match(restored.videoJob!.downloadError || '', /不会重新生成/u);
}
const inconsistentSingle = task(['one']);
inconsistentSingle.videoJob!.resultSelectionRequired = true;
assert.throws(() => validateVideoResultSelection(inconsistentSingle), /选择记录无效/u);
const foreign = task();
foreign.videoJob!.snapshot.projectId = 'another-project';
assert.equal(restore(foreign).videoJob!.trackingStopped, true, 'foreign project results cannot unlock local continuation');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-video-results-'));
try {
  const journal = createVideoTaskCheckpointJournal({ directory, atomicWriteFile: fs.writeFileSync });
  journal.save(task());
  assert.deepEqual(journal.get(task().id).videoJob.resultAssetIds, ['video-a', 'video-b']);
  const otherList = task(['video-a', 'replacement']);
  assert.throws(() => journal.save(otherList), /清单不能/u);
  assert.throws(() => journal.save(legacy), /清单不能/u, 'stale no-result journal cannot discard completed outputs');
  journal.save(selected);
  assert.equal(journal.get(task().id).resultAssetId, 'video-b');
  const restart = createVideoTaskCheckpointJournal({ directory, atomicWriteFile: fs.writeFileSync });
  assert.equal(restart.get(task().id).videoJob.resultSelectionRequired, false, 'explicit choice survives journal reload');
  assert.throws(() => restart.save(task()), /选择不能/u, 'late unselected callback cannot roll back the choice');
  const changedSelection = structuredClone(selected);
  changedSelection.resultAssetId = 'video-a';
  assert.throws(() => restart.save(changedSelection), /选择不能/u, 'late different selection cannot rebind a tail source');
  assert.equal(restart.get(task().id).resultAssetId, 'video-b');
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('lianhua-video-results-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('video result selection persistence: 24 cases passed');

import assert from 'node:assert/strict';
import { removeGenerationTask } from '../src/generationTasks';
import { mapVideoTaskResponse, nestedValue, normalizeVideoTaskStatus } from '../src/videoTasks';
import type { GenerationTask, VideoGenerationTask } from '../src/types';

const response = {
  data: {
    task: { id: 'job-42', state: 'processing' },
    output: { video: { url: 'https://cdn.example.test/job-42.mp4' } },
  },
};

assert.equal(nestedValue(response, 'data.task.id'), 'job-42');
assert.equal(nestedValue(response, 'data.missing.value'), undefined);
assert.equal(normalizeVideoTaskStatus('queued'), 'submitted');
assert.equal(normalizeVideoTaskStatus('IN_PROGRESS'), 'running');
assert.equal(normalizeVideoTaskStatus('completed'), 'succeeded');
assert.equal(normalizeVideoTaskStatus('cancelled'), 'failed');
assert.equal(normalizeVideoTaskStatus('vendor-specific'), 'unknown');

assert.deepEqual(mapVideoTaskResponse(response, {
  taskIdPath: 'data.task.id',
  statusPath: 'data.task.state',
  resultUrlPath: 'data.output.video.url',
}), {
  remoteTaskId: 'job-42',
  status: 'succeeded',
  resultUrl: 'https://cdn.example.test/job-42.mp4',
});

assert.deepEqual(mapVideoTaskResponse({ data: { id: 'job-43', status: 'processing' } }, {
  taskIdPath: 'data.id',
  statusPath: 'data.status',
  resultUrlPath: 'data.result.url',
}), {
  remoteTaskId: 'job-43',
  status: 'running',
  resultUrl: undefined,
});

assert.deepEqual(mapVideoTaskResponse({ data: {
  id: { nested: 'job-should-not-stringify' },
  status: 'queued',
  result: { url: ['https://cdn.example.test/not-a-scalar.mp4'] },
} }, {
  taskIdPath: 'data.id',
  statusPath: 'data.status',
  resultUrlPath: 'data.result.url',
}), {
  remoteTaskId: '',
  status: 'submitted',
  resultUrl: undefined,
});

assert.deepEqual(mapVideoTaskResponse({ data: {
  id: 0,
  status: 'failed',
  result: { url: 'https://cdn.example.test/partial.mp4' },
} }, {
  taskIdPath: 'data.id',
  statusPath: 'data.status',
  resultUrlPath: 'data.result.url',
}), {
  remoteTaskId: '0',
  status: 'failed',
  resultUrl: 'https://cdn.example.test/partial.mp4',
});

const submittingVideoTask: VideoGenerationTask = {
  id: 'local-video-submit',
  kind: 'video',
  storyboardId: 'board-1',
  targetId: 'video-model',
  status: 'submitting',
  requestBody: { prompt: 'video prompt' },
  createdAt: 100,
  updatedAt: 100,
};
const submittedVideoTask: VideoGenerationTask = {
  ...submittingVideoTask,
  id: 'remote-video-submit',
  status: 'submitted',
  remoteTaskId: 'remote-42',
};
const videoTaskList: GenerationTask[] = [submittingVideoTask, submittedVideoTask];
const blockedSubmittingRemoval = removeGenerationTask(videoTaskList, submittingVideoTask.id);
assert.equal(blockedSubmittingRemoval.blocked, true);
assert.equal(blockedSubmittingRemoval.removed, false);
assert.strictEqual(
  blockedSubmittingRemoval.tasks,
  videoTaskList,
  'a video submission with an in-flight local request must remain tracked until it settles',
);
const blockedBusyRemoteRemoval = removeGenerationTask(
  videoTaskList,
  submittedVideoTask.id,
  submittedVideoTask.id,
);
assert.equal(blockedBusyRemoteRemoval.blocked, true);
assert.equal(blockedBusyRemoteRemoval.removed, false);
assert.strictEqual(blockedBusyRemoteRemoval.tasks, videoTaskList);
const removableIdleRemoteTask = removeGenerationTask(videoTaskList, submittedVideoTask.id);
assert.equal(removableIdleRemoteTask.blocked, false);
assert.equal(removableIdleRemoteTask.removed, true);
assert.deepEqual(removableIdleRemoteTask.tasks, [submittingVideoTask]);

console.log('video task response mapping tests passed');

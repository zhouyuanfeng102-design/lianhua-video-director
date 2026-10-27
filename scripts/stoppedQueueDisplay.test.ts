import assert from 'node:assert/strict';
import { videoTaskDeletionBlocked } from '../src/videoTaskDeletionSafety';
import { videoTaskBatchStatus } from '../src/videoTaskBatchStatus';
import type { VideoGenerationTask } from '../src/types';
import type { VideoGenerationRuntime } from '../src/videoGenerationTypes';

const task = {
  id: 'stopped-queue', kind: 'video', status: 'failed', batchId: 'batch',
  videoJob: {
    stage: 'stopped', trackingStopped: true, batchQueueState: 'cancelled',
    message: '已停止此批次中尚未提交的视频；未影响已经提交到服务器的任务。',
    snapshot: { projectId: 'p', clientId: 'c', draft: { name: '第 2 段', prompt: 'x', references: [], parameters: {} }, connection: { backend: 'api' }, images: [] },
    preparation: { version: 1, phase: 'preparing' },
  },
} as VideoGenerationTask;
const staleQueued = { stage: 'queued', message: '本地排队中（同连接最多同时生成 3 个）' } as VideoGenerationRuntime;
assert.equal(videoTaskBatchStatus(task, staleQueued), 'stopped');
assert.equal(videoTaskDeletionBlocked(task, staleQueued), false);
console.log('stopped task ignores stale queued runtime');

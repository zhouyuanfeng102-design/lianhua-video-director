import assert from 'node:assert/strict';
import { videoTaskBatchStatus } from '../src/videoTaskBatchStatus';
import type { VideoGenerationTask } from '../src/types';
import type { VideoGenerationJob, VideoGenerationRuntime } from '../src/videoGenerationTypes';

const task = (status: VideoGenerationTask['status'], job?: Partial<VideoGenerationJob>, resultAssetId?: string): VideoGenerationTask => ({
  id: 'state-test', status, resultAssetId,
  ...(job ? { videoJob: job as VideoGenerationJob } : {}),
} as VideoGenerationTask);
assert.equal(videoTaskBatchStatus(task('succeeded', { stage: 'downloading' })), 'running');
assert.equal(videoTaskBatchStatus(task('succeeded', { stage: 'succeeded', downloadError: 'disk unavailable' })), 'failed');
assert.equal(videoTaskBatchStatus(task('succeeded', { stage: 'succeeded' })), 'running');
assert.equal(videoTaskBatchStatus(task('succeeded', { stage: 'succeeded' }, 'local-video')), 'succeeded');
assert.equal(videoTaskBatchStatus(task('succeeded')), 'succeeded', 'legacy completion display remains compatible');
assert.equal(videoTaskBatchStatus(task('succeeded', { stage: 'succeeded', resultSelectionRequired: true, resultAssetIds: ['a', 'b'] })), 'pending', 'a ZIP with multiple videos cannot count as a ready predecessor before selection');
for (const phase of ['waiting', 'blocked'] as const) {
  assert.equal(videoTaskBatchStatus(task('draft', { stage: 'preparing', batchQueueState: 'ready', tailPreparation: { phase, revision: 1 } })), 'pending');
}
assert.equal(videoTaskBatchStatus(task('draft', { stage: 'preparing', tailPreparation: { phase: 'extracting', revision: 2 } })), 'submitting');
assert.equal(videoTaskBatchStatus(task('draft', { stage: 'preparing', tailPreparation: { phase: 'cancelled', revision: 3 } })), 'stopped');
assert.equal(videoTaskBatchStatus(task('draft', { stage: 'preparing', batchQueueState: 'cancelled' })), 'stopped');
assert.equal(videoTaskBatchStatus(task('unknown', { stage: 'submission-unknown' })), 'unknown');
assert.equal(videoTaskBatchStatus(task('unknown', { stage: 'submission-unknown', tailPreparation: { phase: 'waiting', revision: 0 } })), 'unknown', 'unknown POST safety boundary must not look like an ordinary pending dependency');
assert.equal(videoTaskBatchStatus(task('submitted', { stage: 'queued' })), 'queued');
assert.equal(videoTaskBatchStatus(task('running', { stage: 'running' })), 'running');
assert.equal(videoTaskBatchStatus(task('succeeded', { stage: 'succeeded' }, 'saved'), { stage: 'downloading' } as VideoGenerationRuntime), 'running');
assert.equal(videoTaskBatchStatus(task('succeeded', { stage: 'succeeded' }, 'saved'), { stage: 'succeeded', downloadError: 'save failed' }), 'failed');
console.log('video task batch display: waiting, extracting, blocked and saved completion checks passed');

import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { videoReferenceByteLimit, videoImageDataSize } from '../src/videoReferenceCompression';
import type { VideoGenerationTask } from '../src/types';

const state = createInitialState();
const api = { ...state.settings.videoTaskApi, provider: 'generic' as const, model: 'returned-model', baseUrl: 'https://read-limit.invalid', endpoint: '', statusEndpointTemplate: '' };
const task = { kind: 'video', createdAt: 1, status: 'failed', error: 'HTTP 413: {"error":{"code":"IMAGES_TOO_LARGE","message":"参考图总大小超过 70 MiB，已拒绝生成"}}',
  videoJob: { snapshot: { connection: { backend: 'api', api } } } } as unknown as VideoGenerationTask;
assert.equal(videoReferenceByteLimit({ generationTasks: [task] }, api), 70 * 1024 * 1024);
assert.equal(videoReferenceByteLimit({ generationTasks: [task] }, { ...api, model: 'another-model' }), undefined);
assert.equal(videoReferenceByteLimit({ generationTasks: [task] }, { ...api, baseUrl: 'https://other-limit.invalid' }), undefined);
assert.equal(videoReferenceByteLimit({ generationTasks: [] }, api), undefined, 'unknown interfaces do not get a locally assumed byte limit');
assert.equal(videoReferenceByteLimit({ generationTasks: [{ ...task, error: task.error?.replace('70 MiB', '12 MB') }] }, api), 12_000_000);
assert.equal(videoImageDataSize('data:image/png;base64,YQ=='), 1);
assert.equal(videoImageDataSize('data:image/jpeg;base64,YWI='), 2);
assert.equal(videoImageDataSize('data:image/webp;base64,YWJj'), 3);
console.log('videoCompressionLimit: scoped service-returned sizes and decoded image byte counts passed');

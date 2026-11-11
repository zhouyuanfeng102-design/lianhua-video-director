import assert from 'node:assert/strict';
import { buildVideoApiBody, defaultMiniMaxH3VideoApi, parseVideoApiResult } from '../src/videoGenerationApi';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { VideoTaskApiConfig } from '../src/types';

const draft: VideoGenerationDraft = {
  origin: 'custom', promptMode: 'raw', name: '自由提示词', prompt: '保留这段中文对白：“别走。”',
  backend: 'api', references: [
    { assetId: 'first', role: 'first-frame' },
    { assetId: 'last', role: 'last-frame' },
  ], parameters: { model: 'wrong-model', prompt: 'wrong-prompt', content: [], duration: 7, resolution: '2K', ratio: '16:9' },
};

const h3 = buildVideoApiBody(defaultMiniMaxH3VideoApi, draft, ['https://assets.test/first.png', 'https://assets.test/last.png']);
assert.equal(h3.model, 'MiniMax-H3', 'selected H3 model remains authoritative over advanced JSON');
assert.equal(h3.duration, 7);
assert.equal(h3.resolution, '2K');
assert.equal(h3.ratio, 'adaptive', 'H3 image-to-video follows the frame image ratio');
assert.deepEqual(h3.content, [
  { type: 'text', text: draft.prompt },
  { type: 'image_url', image_url: { url: 'https://assets.test/first.png' }, role: 'first_frame' },
  { type: 'image_url', image_url: { url: 'https://assets.test/last.png' }, role: 'last_frame' },
]);

const referenceDraft: VideoGenerationDraft = {
  ...draft, references: [{ assetId: 'person', role: 'character' }], parameters: { duration: 5, resolution: '768P' },
  audioReferences: [{ assetId: 'voice', slotIndex: 0, bindingId: 'voice', target: { kind: 'voiceover' }, retainMode: 'reference' }],
  videoReferences: [{ assetId: 'motion', slotIndex: 0, bindingId: 'motion' }],
};
const referenceBody = buildVideoApiBody(defaultMiniMaxH3VideoApi, referenceDraft,
  ['https://assets.test/person.png'], ['https://assets.test/voice.wav'], ['https://assets.test/motion.mp4']);
assert.equal(referenceBody.ratio, 'adaptive');
assert.deepEqual((referenceBody.content as Array<Record<string, unknown>>).slice(1), [
  { type: 'image_url', image_url: { url: 'https://assets.test/person.png' }, role: 'reference_image' },
  { type: 'video_url', video_url: { url: 'https://assets.test/motion.mp4' }, role: 'reference_video' },
  { type: 'audio_url', audio_url: { url: 'https://assets.test/voice.wav' }, role: 'reference_audio' },
]);

const t2v = buildVideoApiBody(defaultMiniMaxH3VideoApi, { ...draft, references: [], parameters: {} }, []);
assert.equal(t2v.ratio, '16:9');
assert.equal(t2v.duration, 5);
assert.equal(t2v.resolution, '768P');

assert.deepEqual(parseVideoApiResult({ task_id: 'h3-task' }, defaultMiniMaxH3VideoApi), {
  remoteTaskId: 'h3-task', stage: 'queued', status: 'submitted', message: 'MiniMax H3 任务已提交',
});
assert.deepEqual(parseVideoApiResult({ task: { id: 'h3-task', status: 'running' } }, defaultMiniMaxH3VideoApi), {
  remoteTaskId: 'h3-task', stage: 'running', status: 'running', message: 'MiniMax H3 状态：running',
});
assert.deepEqual(parseVideoApiResult({ task: { id: 'h3-task', status: 'succeeded', content: { url: 'https://cdn.test/out.mp4' } } }, defaultMiniMaxH3VideoApi), {
  remoteTaskId: 'h3-task', stage: 'downloading', status: 'succeeded', resultUrl: 'https://cdn.test/out.mp4', message: 'MiniMax H3 状态：succeeded',
});
assert.equal(parseVideoApiResult({ task: { id: 'h3-task', status: 'failed' }, error: { message: 'provider error' } }, defaultMiniMaxH3VideoApi).message, 'provider error');

const generic: VideoTaskApiConfig = {
  enabled: true, endpoint: 'https://api.test/video', statusEndpointTemplate: 'https://api.test/task/{id}', apiKey: '',
  authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url',
  provider: 'generic', model: 'selected-model',
};
const parameters: VideoGenerationDraft = { ...draft, parameters: { model: 'wrong-model', prompt: 'wrong-prompt' } };
const genericBody = buildVideoApiBody(generic, parameters, []);
assert.equal(genericBody.model, 'selected-model');
assert.equal(genericBody.prompt, draft.prompt);
const noSelectedFrames = buildVideoApiBody(generic, { ...parameters, references: [], parameters: {
  images: ['old-template.png'], first_frame_image: 'old-first.png', last_frame_image: 'old-last.png',
} }, []);
assert.equal('images' in noSelectedFrames, false);
assert.equal('first_frame_image' in noSelectedFrames, false);
assert.equal('last_frame_image' in noSelectedFrames, false);

const templateBody = buildVideoApiBody({ ...generic, requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","frames":"{{images}}"}' }, parameters, ['image-data']);
assert.equal(templateBody.model, 'selected-model');
assert.equal(templateBody.prompt, draft.prompt);
assert.deepEqual(templateBody.frames, ['image-data']);

console.log('Custom video API checks passed');

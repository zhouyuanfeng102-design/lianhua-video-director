import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { defaultMiniMaxH3VideoApi, defaultRunningHubVideoApi } from '../src/videoGenerationApi';
import { buildOfficialH3SourceFingerprint, OFFICIAL_H3_TARGET_ID } from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { prepareVideoAudioDraft } from '../src/videoAudioReferences';
import { prepareVideoH3ReferenceDraft } from '../src/videoH3ReferenceBinding';
import { prepareVideoMotionDraft } from '../src/videoMotionReferences';
import { bindRunningHubVideoRequest } from '../src/runningHubVideo';
import { buildRhWebBody, knownMiniMaxH3WebFields } from '../src/runningHubWeb';
import type { Project, VideoTaskApiConfig, VideoGenerationTask } from '../src/types';
import type { Storyboard } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const prompt = '  custom prompt with <Picture 6> and authored spacing\n';
const customDraft: VideoGenerationDraft = {
  name: 'custom raw', prompt, backend: 'api', origin: 'custom', promptMode: 'raw',
  references: [], parameters: { idea: 'stale short idea' },
};

const h3 = prepareVideoH3ReferenceDraft({} as Project, customDraft, { backend: 'api' });
assert.equal(h3.draft, customDraft, 'H3 reference binding must not rewrite custom raw text');
assert.equal(h3.draft.prompt, prompt);

const audio = prepareVideoAudioDraft({} as Project, customDraft, undefined);
assert.equal(audio.prompt, prompt, 'project voice presets must not insert prompt text');
assert.deepEqual(audio.audioReferences, [], 'project audio presets must not be inherited');
const explicitAudio = { assetId: 'voice-1', slotIndex: 0, bindingId: 'minimax-h3-audio-1',
  target: { kind: 'voiceover' as const }, retainMode: 'reference' as const };
const selectedAudio = prepareVideoAudioDraft({} as Project, { ...customDraft, audioReferences: [explicitAudio], audioSelectionMode: 'override' }, undefined);
assert.equal(selectedAudio.prompt, prompt);
assert.deepEqual(selectedAudio.audioReferences, [explicitAudio], 'explicit reference audio remains in the request without adding prose');

const explicitVideo = { assetId: 'motion-1', slotIndex: 0, bindingId: 'template-video-1' };
const motion = prepareVideoMotionDraft({} as Project, { ...customDraft, videoReferences: [explicitVideo] }, {
  backend: 'api', api: { requestTemplate: '{"video":"{{videos}}"}' },
});
assert.equal(motion.prompt, prompt, 'selected motion references must not add prose in raw mode');
assert.deepEqual(motion.videoReferences, [explicitVideo], 'explicit motion media remains bound');

const webConfig = {
  provider: 'rh_web', rhWebPageUrl: 'https://www.runninghub.ai/zh-cn/ai-detail/2104753059472990209',
  rhWebAccountId: 'account', rhWebFields: knownMiniMaxH3WebFields(),
} as VideoTaskApiConfig;
const webBody = buildRhWebBody(webConfig, customDraft, []);
const webFields = webBody.fields as Array<{ key: string; value: unknown }>;
assert.equal(webBody.prompt, prompt);
assert.equal(webFields.find((field) => field.key === 'text:prompt')?.value, prompt,
  'RH web must bind the full authored prompt instead of stale parameters.idea');
assert.equal(webFields.find((field) => field.key === 'boolean:auto-prompt')?.value, false,
  'RH web prompt generation must be disabled for raw mode');

const imageNodes = ['438', '435', '437', '439', '431', '429'];
const nodeInfoList = [
  { nodeId: '456', fieldName: 'text', fieldValue: '' },
  { nodeId: '827', fieldName: 'value', fieldValue: 6 },
  ...imageNodes.map((nodeId) => ({ nodeId, fieldName: 'image', fieldValue: 'empty.png' })),
];
const mappedFields: NonNullable<VideoTaskApiConfig['runningHubMappedFields']> = [
  { nodeId: '456', fieldName: 'text', kind: 'prompt' },
  { nodeId: '827', fieldName: 'value', kind: 'image-count', imageCountMode: 'prefix', originalValue: 6 },
  ...imageNodes.map((nodeId, imageIndex) => ({ nodeId, fieldName: 'image', kind: 'image' as const, imageIndex })),
];
const cloud = bindRunningHubVideoRequest(JSON.stringify({ nodeInfoList }), mappedFields, { ...customDraft, parameters: {} }, [], {
  provider: 'runninghub', runningHubAppId: '2104753059472990209',
  endpoint: 'https://www.runninghub.ai/openapi/v2/run/ai-app/2104753059472990209',
});
assert.equal((cloud.nodeInfoList as Array<{ fieldValue: unknown }>)[0].fieldValue, prompt,
  'verified RH app must not wrap custom raw input or reject its authored picture reference');

{
  let state = createInitialState();
  state.settings.videoTaskApi = { ...defaultMiniMaxH3VideoApi, apiKey: 'test-key' };
  const requests: Array<{ method: string; body?: string }> = [];
  const desktop = {
    videoRequest: async (request: { method: string; body?: string }) => {
      requests.push(request);
      return { status: 200, body: JSON.stringify({ task_id: 'h3-raw-task', status: 'queued' }) };
    },
    setVideoTaskCredential: async () => ({ persisted: true }),
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state,
    setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 60_000 });
  const taskId = await engine.start({ ...customDraft, prompt, backend: 'api', apiProfileId: undefined });
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  const body = JSON.parse(requests[0].body || '{}') as { content?: Array<{ type: string; text?: string }> };
  assert.equal(body.content?.[0]?.text, prompt,
    'custom H3 raw prompt must submit without a storyboard and preserve authored whitespace');
  const task = state.project.generationTasks.find((entry) => entry.id === taskId);
  assert.equal(task?.videoJob?.snapshot.draft.origin, 'custom');
  assert.equal(task?.videoJob?.snapshot.draft.prompt, prompt);
  engine.dispose();
}

// H3 v2 director tasks keep the existing official-source comparison, reading
// its authored text from content[] instead of the legacy body.prompt field.
{
  let state = createInitialState();
  const officialPrompt = 'integrated_multimodal_description:\nA saved official H3 delivery.';
  const board = {
    id: 'official-h3-board', sceneId: 'official-h3-scene', workflow: 'text-to-video', inputMode: 'text',
    durationSec: 5, durationPreset: 'custom', shotMode: 'single', pace: 'normal', aspectRatio: '16:9', resolution: '768P',
    audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', shots: [], finalPrompt: 'canonical source',
    officialPromptZh: officialPrompt, targetModelId: OFFICIAL_H3_TARGET_ID,
    targetOutput: { targetId: OFFICIAL_H3_TARGET_ID, prompt: officialPrompt, parameters: {}, referenceManifest: [], warnings: [], generatedAt: 1 },
    createdAt: 1, updatedAt: 1,
  } as unknown as Storyboard;
  state.project = { ...state.project, storyboards: [board] };
  const context = officialH3ContextForStoryboard(state.project, board);
  board.officialPromptSource = buildOfficialH3SourceFingerprint(board, context);
  state.project = { ...state.project, storyboards: [board] };
  state.settings.videoTaskApi = { ...defaultMiniMaxH3VideoApi, apiKey: 'test-key' };
  const requests: Array<{ method: string; body?: string }> = [];
  const desktop = {
    videoRequest: async (request: { method: string; body?: string }) => {
      requests.push(request);
      return { status: 200, body: JSON.stringify({ task_id: 'official-h3-task', status: 'queued' }) };
    },
    setVideoTaskCredential: async () => ({ persisted: true }),
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state,
    setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 60_000 });
  await engine.start({ name: 'official H3 v2', prompt: officialPrompt, backend: 'api', source: {
    storyboardId: board.id, language: 'zh', promptFormat: 'h3',
  }, references: [], parameters: {} });
  assert.equal(requests.length, 1, 'current official H3 director draft passes the H3 v2 submit guard');
  const body = JSON.parse(requests[0].body || '{}') as { content?: Array<{ type: string; text?: string }> };
  assert.equal(body.content?.[0]?.text, officialPrompt);
  engine.dispose();
}

// A custom/raw RunningHub task imports every direct video URL returned by the
// same remote task; the adjacent ZIP output remains an alternate fallback.
{
  let state = createInitialState();
  const response = { status: 'SUCCESS', taskId: 'rh-custom-task', results: [
    { nodeId: 'clip-a', outputType: 'mp4', url: 'https://cdn.example.test/custom-a.mp4' },
    { nodeId: 'clip-b', outputType: 'video/mp4', url: 'https://cdn.example.test/custom-b.mp4' },
    { nodeId: 'archive', outputType: 'zip', url: 'https://cdn.example.test/custom-all.zip' },
  ] };
  const api = { ...defaultRunningHubVideoApi, runningHubAppId: '130', apiKey: 'test-key', runningHubOutputNodeIds: [] };
  state.settings.videoTaskApi = api;
  const { apiKey: _secret, ...safeApi } = api;
  const task = {
    id: 'rh-custom-task-local', kind: 'video', storyboardId: '', targetId: 'RunningHub custom', status: 'succeeded',
    remoteTaskId: 'rh-custom-task', resultUrl: response.results[0].url, response, requestBody: {}, createdAt: 1, updatedAt: 1,
    config: { enabled: true, backend: 'api', model: 'RunningHub AI 应用' },
    videoJob: { stage: 'succeeded', preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] },
      snapshot: { projectId: state.project.id, clientId: 'rh-custom-client',
        draft: { ...customDraft, name: 'custom outputs' }, images: [], connection: { backend: 'api', api: safeApi } } },
  } as unknown as VideoGenerationTask;
  state.project = { ...state.project, generationTasks: [task] };
  const downloads: string[] = [];
  const desktop = {
    videoRequest: async () => { throw new Error('saved successful results must not be requeried'); },
    getVideoTaskCredential: async () => 'test-key',
    saveVideoTaskCheckpoint: async () => ({ persisted: true }),
    downloadGeneratedMedia: async (request: { url: string }) => {
      downloads.push(request.url);
      const number = downloads.length;
      return { fileName: `custom-${number}.mp4`, relativePath: `video/custom-${number}.mp4`, checksum: `fixture-${number}`,
        sizeBytes: 100, managed: true, missing: false, mediaType: 'video', mimeType: 'video/mp4', url: `lianhua-media://custom-${number}` };
    },
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state,
    setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 60_000 });
  await engine.recoverResult(task.id);
  const completed = state.project.generationTasks[0] as VideoGenerationTask;
  assert.deepEqual(downloads, response.results.slice(0, 2).map((item) => item.url));
  assert.equal(state.project.assets.length, 2);
  assert.equal(completed.videoJob?.resultAssetIds?.length, 2);
  assert.equal(completed.videoJob?.resultSelectionRequired, true);
  assert.equal(completed.resultAssetId, undefined);
  engine.dispose();
}

// The H3 v2 query flow must finish the original task and save its original file.
for (const terminalStatus of ['succeeded', 'failed'] as const) {
  let state = createInitialState();
  state.settings.videoTaskApi = { ...defaultMiniMaxH3VideoApi, statusEndpointTemplate: '', apiKey: 'test-key' };
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  let downloads = 0;
  const desktop = {
    videoRequest: async (request: { method: string; url: string; body?: string }) => {
      requests.push(request);
      if (request.method === 'POST') return { status: 200, body: JSON.stringify({ task_id: 'h3-query-task' }) };
      assert.equal(request.url, 'https://api.minimax.io/v2/query/video_generation/h3-query-task');
      return { status: 200, body: JSON.stringify({ task: { id: 'h3-query-task', status: terminalStatus,
        ...(terminalStatus === 'succeeded' ? { content: { url: 'https://cdn.example.test/h3-result.mp4' } }
          : { error: { message: 'upstream test failure' } }) } }) };
    },
    setVideoTaskCredential: async () => ({ persisted: true }),
    getVideoTaskCredential: async () => 'test-key',
    downloadGeneratedMedia: async (request: { url: string; headers?: unknown }) => {
      assert.equal(request.url, 'https://cdn.example.test/h3-result.mp4');
      assert.equal(request.headers, undefined);
      downloads += 1;
      return { fileName: 'h3-result.mp4', relativePath: 'video/h3-result.mp4', checksum: 'fixture', sizeBytes: 1024,
        mediaType: 'video', managed: true, missing: false, url: 'lianhua-media://asset/h3-result.mp4' };
    },
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state,
    setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 });
  const taskId = await engine.start({ ...customDraft, parameters: {} });
  for (let count = 0; count < 200; count += 1) {
    const task = state.project.generationTasks.find((entry) => entry.id === taskId);
    if (terminalStatus === 'succeeded' ? Boolean(task?.resultAssetId) : task?.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const task = state.project.generationTasks.find((entry) => entry.id === taskId);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1, 'status queries must not resubmit video generation');
  assert.equal(task?.status, terminalStatus);
  assert.equal(downloads, terminalStatus === 'succeeded' ? 1 : 0);
  assert.ok(terminalStatus === 'succeeded' ? task?.resultAssetId : task?.videoJob?.remoteGenerationEnded);
  engine.dispose();
}

// Official H3 receives explicit audio/video media in its content array, not an RH upload.
{
  let state = createInitialState();
  state.settings.videoTaskApi = { ...defaultMiniMaxH3VideoApi, apiKey: 'test-key' };
  const wav = Buffer.alloc(48);
  wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
  const audioData = `data:audio/wav;base64,${wav.toString('base64')}`;
  const videoData = 'data:video/mp4;base64,AAAA';
  state.project.assets = [
    { id: 'voice-1', name: 'selected voice', fileName: 'selected.wav', type: 'audio', mediaType: 'audio',
      mimeType: 'audio/wav', role: 'audio', dataUrl: audioData, tags: [], createdAt: 1, updatedAt: 1 },
    { id: 'motion-1', name: 'selected motion', fileName: 'selected.mp4', type: 'video', mediaType: 'video',
      mimeType: 'video/mp4', role: 'motion', dataUrl: videoData, tags: [], createdAt: 1, updatedAt: 1 },
  ];
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const desktop = {
    videoRequest: async (request: { url: string; method: string; body?: string }) => {
      requests.push(request);
      return { status: 200, body: JSON.stringify({ task_id: 'h3-selected-media' }) };
    },
    setVideoTaskCredential: async () => ({ persisted: true }),
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state,
    setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 60_000 });
  await engine.start({ ...customDraft, parameters: {}, audioSelectionMode: 'override', audioReferences: [explicitAudio],
    videoReferences: [{ assetId: 'motion-1', slotIndex: 0, bindingId: 'minimax-h3-video-1' }] });
  assert.equal(requests.length, 1, 'H3 media must not use the RunningHub upload endpoint');
  const body = JSON.parse(requests[0].body || '{}');
  assert.deepEqual(body.content, [
    { type: 'text', text: prompt },
    { type: 'video_url', video_url: { url: videoData }, role: 'reference_video' },
    { type: 'audio_url', audio_url: { url: audioData }, role: 'reference_audio' },
  ]);
  engine.dispose();
}

// Partial remote outputs remain visible; failures are reported without
// discarding media already downloaded from the same task.
{
  let state = createInitialState();
  const response = { status: 'SUCCESS', taskId: 'rh-partial-task', results: [
    { nodeId: 'clip-a', outputType: 'mp4', url: 'https://cdn.example.test/partial-a.mp4' },
    { nodeId: 'clip-b', outputType: 'mp4', url: 'https://cdn.example.test/partial-b.mp4' },
  ] };
  const api = { ...defaultRunningHubVideoApi, runningHubAppId: '130', apiKey: 'test-key', runningHubOutputNodeIds: [] };
  state.settings.videoTaskApi = api;
  const { apiKey: _secret, ...safeApi } = api;
  const task = {
    id: 'rh-partial-task-local', kind: 'video', storyboardId: '', targetId: 'RunningHub custom', status: 'succeeded',
    remoteTaskId: 'rh-partial-task', resultUrl: response.results[0].url, response, requestBody: {}, createdAt: 1, updatedAt: 1,
    config: { enabled: true, backend: 'api', model: 'RunningHub AI 应用' },
    videoJob: { stage: 'succeeded', preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] },
      snapshot: { projectId: state.project.id, clientId: 'rh-partial-client',
        draft: { ...customDraft, name: 'partial custom outputs' }, images: [], connection: { backend: 'api', api: safeApi } } },
  } as unknown as VideoGenerationTask;
  state.project = { ...state.project, generationTasks: [task] };
  const desktop = {
    videoRequest: async () => { throw new Error('saved successful results must not be requeried'); },
    getVideoTaskCredential: async () => 'test-key',
    saveVideoTaskCheckpoint: async () => ({ persisted: true }),
    downloadGeneratedMedia: async (request: { url: string }) => {
      if (request.url.endsWith('partial-b.mp4')) throw new Error('fixture download failure');
      return { fileName: 'partial-a.mp4', relativePath: 'video/partial-a.mp4', checksum: 'fixture-a',
        sizeBytes: 100, managed: true, missing: false, mediaType: 'video', mimeType: 'video/mp4', url: 'lianhua-media://partial-a' };
    },
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state,
    setState: (updater) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 60_000 });
  await engine.recoverResult(task.id);
  const completed = state.project.generationTasks[0] as VideoGenerationTask;
  assert.equal(state.project.assets.length, 1);
  assert.equal(completed.videoJob?.resultAssetIds?.length, 1);
  assert.match(completed.videoJob?.message || '', /1 个输出无法读取/u);
  engine.dispose();
}

console.log('custom raw video prompt isolation ok');

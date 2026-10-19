import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInitialState, normalizeState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { compileRunningHubVideoApi, normalizeRunningHubVideoConfig } from '../src/runningHubVideo';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { bindComfyVideoWorkflow } from '../src/comfyuiVideo';
import { prepareVideoMotionDraft, stripVideoMotionPromptBinding, videoMotionCapability, videoMotionReferenceNumbers } from '../src/videoMotionReferences';
import { videoBatchReferenceFingerprint } from '../src/videoBatch';
import type { AppState, ReferenceAsset, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';

// Synthetic local bytes and mock transports only. No provider or model requests.
const require = createRequire(import.meta.url);
const { readManagedVideoDataUrl, storeVideoReferenceVideo } = require('../electron/videoMotionReference.cjs');
const { videoRequestOptions } = require('../electron/videoTransport.cjs');
const { collectVideoFrozenAssets } = require('../electron/videoTaskCheckpoint.cjs');
const tempRoot = mkdtempSync(path.join(tmpdir(), 'lianhua-motion-test-'));
const bytes = Buffer.from('synthetic-motion-source-bytes');
const dataUrl = `data:video/quicktime;base64,${bytes.toString('base64')}`;
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const workflow: RunningHubVideoWorkflow = {
  id: 'motion-flow', name: 'Explicit motion file mapping', runKind: 'workflow', remoteId: '1234567890123456789', createdAt: 1, updatedAt: 1,
  requestTemplate: JSON.stringify({ nodeInfoList: [
    { nodeId: '1', fieldName: 'prompt', fieldValue: 'original prompt' },
    { nodeId: '2', fieldName: 'video', fieldValue: 'None' },
    { nodeId: '3', fieldName: 'video', fieldValue: 'unselected-default.mov' },
    { nodeId: '4', fieldName: 'lora_name', fieldValue: 'original.safetensors' },
    { nodeId: '5', fieldName: 'steps', fieldValue: 16 },
  ] }),
  mapping: { prompt: [{ nodeId: '1', inputName: 'prompt' }], images: [], videos: [{ nodeId: '2', inputName: 'video' }, { nodeId: '3', inputName: 'video' }] },
};
const clip: ReferenceAsset = { id: 'motion-source', name: '动作参考', type: 'video', role: 'composition', mediaType: 'video', mimeType: 'video/quicktime',
  fileName: 'selected.mov', relativePath: 'video/selected.mov', durationSec: 3, tags: [], createdAt: 1, updatedAt: 1 };
const draft: VideoGenerationDraft = { name: '动作参考视频', backend: 'api', runningHubWorkflowId: workflow.id,
  prompt: 'The two characters exchange the authored actions at natural speed.', source: { promptFormat: 'ordinary', language: 'en' },
  references: [], audioSelectionMode: 'none', videoReferences: [{ assetId: clip.id, slotIndex: 0, bindingId: JSON.stringify(['2', 'video']) }], parameters: {} };

try {
  mkdirSync(path.join(tempRoot, 'video'));
  writeFileSync(path.join(tempRoot, 'video/selected.mov'), bytes);
  assert.equal(readManagedVideoDataUrl({ assetRoot: tempRoot, relativePath: clip.relativePath }).dataUrl, dataUrl);
  const saved = storeVideoReferenceVideo({ assetRoot: tempRoot, dataUrl, fileName: clip.fileName });
  assert.equal(readManagedVideoDataUrl({ assetRoot: tempRoot, relativePath: saved.relativePath, expectedChecksum: saved.checksum }).dataUrl, dataUrl);
  const multipart = videoRequestOptions({ method: 'POST', multipart: { files: [{ fieldName: 'file', fileName: clip.fileName, dataUrl }] } });
  assert.ok(multipart.body.includes(bytes));
  assert.match(multipart.body.toString(), /Content-Type: video\/quicktime/u);
  assert.match(multipart.body.toString(), /filename="selected.mov"/u);

  const state = { value: createInitialState() };
  state.value.settings.runningHubVideo = { enabled: true, baseUrl: 'https://motion-mock.invalid', apiKey: 'synthetic-key', workflows: [workflow], activeWorkflowId: workflow.id };
  state.value.project.assets = [clip]; state.value.projects = [state.value.project];
  const api = compileRunningHubVideoApi(state.value.settings.runningHubVideo);
  assert.equal(normalizeRunningHubVideoConfig(state.value.settings.runningHubVideo).workflows[0].mapping.videos?.length, 2);
  assert.equal(videoMotionCapability({ backend: 'api', api }).slotCount, 2);
  const rendered = prepareVideoMotionDraft(state.value.project, draft, { backend: 'api', api });
  assert.equal((rendered.prompt.match(/<Video 1>/gu) || []).length, 1);
  assert.equal(prepareVideoMotionDraft(state.value.project, rendered, { backend: 'api', api }).prompt, rendered.prompt);
  assert.equal(stripVideoMotionPromptBinding({ ...rendered, prompt: `${rendered.prompt}\nUser edit.` }), `${draft.prompt}\nUser edit.`);
  const unsupported = prepareVideoMotionDraft(state.value.project, rendered, { backend: 'api', api: { ...api, provider: 'generic', requestTemplate: undefined, runningHubMappedFields: undefined } });
  assert.equal(unsupported.prompt, draft.prompt); assert.deepEqual(unsupported.videoReferences, []);
  const body = buildVideoApiBody(api, rendered, [], [], ['openapi/selected.mov']);
  const nodes = body.nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>;
  assert.equal(nodes.find((node) => node.nodeId === '2')?.fieldValue, 'openapi/selected.mov');
  assert.equal(nodes.find((node) => node.nodeId === '3')?.fieldValue, 'unselected-default.mov');
  assert.equal(nodes.find((node) => node.nodeId === '4')?.fieldValue, 'original.safetensors');
  assert.equal(nodes.find((node) => node.nodeId === '5')?.fieldValue, 16);
  const generic: VideoTaskApiConfig = { enabled: true, provider: 'generic', apiKey: '', endpoint: 'https://motion-template.invalid/videos',
    requestTemplate: JSON.stringify({ prompt: '{{prompt}}', clips: '{{videos}}', selected: '{{video_2}}', metadata: '{{video_references}}' }) };
  const sparse = { ...draft, videoReferences: [{ ...draft.videoReferences![0], slotIndex: 1, bindingId: 'template-video-2' }] };
  const custom = buildVideoApiBody(generic, sparse, [], [], [dataUrl]);
  assert.deepEqual(custom.clips, [dataUrl]); assert.equal(custom.selected, dataUrl);
  assert.equal((custom.metadata as Array<{ slot_index: number }>)[0].slot_index, 1);
  const denseApi = { ...generic, requestTemplate: JSON.stringify({ prompt: '{{prompt}}', videos: '{{videos}}' }) };
  assert.deepEqual(videoMotionReferenceNumbers(sparse.videoReferences, { backend: 'api', api: denseApi }), [1]);
  const denseRendered = prepareVideoMotionDraft(state.value.project, sparse, { backend: 'api', api: denseApi });
  assert.match(denseRendered.prompt, /<Video 1>/u); assert.doesNotMatch(denseRendered.prompt, /<Video 2>/u);
  assert.deepEqual(videoMotionReferenceNumbers(sparse.videoReferences, { backend: 'api', api: generic }), [2]);
  const comfy = { workflowJson: JSON.stringify({ p: { class_type: 'Text', inputs: { text: 'original' } }, v: { class_type: 'VHS_LoadVideo', inputs: { video: 'old.mov' } }, s: { class_type: 'Sampler', inputs: { steps: 20 } } }),
    mapping: { prompt: [{ nodeId: 'p', inputName: 'text' }], images: [], videos: [{ nodeId: 'v', inputName: 'video' }] } };
  const bound = bindComfyVideoWorkflow(comfy, draft.prompt, [], {}, [], ['input/selected.mov'], draft.videoReferences);
  assert.equal(bound.v.inputs.video, 'input/selected.mov'); assert.equal(bound.s.inputs.steps, 20);
  assert.notEqual(videoBatchReferenceFingerprint(draft, [clip]), videoBatchReferenceFingerprint({ ...draft, videoReferences: [] }, [clip]));

  const requests: Parameters<VideoGenerationDesktop['videoRequest']>[0][] = [];
  const journal = new Map<string, VideoGenerationTask>();
  const credentials = new Map<string, string>();
  let downloads = 0;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      requests.push(structuredClone(request));
      if (request.url.endsWith('/media/upload/binary')) {
        assert.equal(request.multipart?.files[0].dataUrl, dataUrl);
        return response({ code: 0, data: { fileName: 'openapi/selected.mov' } });
      }
      if (request.url.includes('/run/')) {
        assert.equal(JSON.parse(request.body!).nodeInfoList.find((node: { nodeId: string }) => node.nodeId === '2').fieldValue, 'openapi/selected.mov');
        return response({ taskId: 'mock-complete', status: 'SUCCESS', results: [{ url: 'https://motion-mock.invalid/result.mp4', outputType: 'mp4' }] });
      }
      throw new Error(`Unexpected mock request: ${request.url}`);
    },
    downloadGeneratedMedia: async () => { downloads++; return { ...saved, fileName: 'result.mp4', relativePath: 'video/result.mp4', mimeType: 'video/mp4', url: 'lianhua-asset://local/video/result.mp4' }; },
    readManagedVideoDataUrl: async (payload) => readManagedVideoDataUrl({ assetRoot: tempRoot, ...payload }),
    storeVideoReferenceVideo: async (payload) => storeVideoReferenceVideo({ assetRoot: tempRoot, ...payload }),
    readManagedImageDataUrl: async () => { throw new Error('Video input must never use the image reader'); },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => { credentials.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId) => credentials.get(taskId) || null,
    saveVideoTaskCheckpoint: async (task) => { journal.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(journal.get(taskId) || null),
  };
  const engine = new VideoGenerationEngine({ getState: () => state.value, setState: (update: (state: AppState) => AppState) => { state.value = update(state.value); },
    desktop, onRuntime: () => {}, persistState: async () => {}, pollIntervalMs: 60_000 });
  try {
    const taskId = await engine.start(draft);
    for (let i = 0; i < 100 && downloads === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const task = state.value.project.generationTasks.find((item) => item.id === taskId) as VideoGenerationTask;
    assert.equal(requests.filter((request) => request.url.includes('/run/')).length, 1, task.error);
    assert.equal(requests.filter((request) => request.url.endsWith('/media/upload/binary')).length, 1);
    assert.equal(downloads, 1);
    assert.equal(task.videoJob!.snapshot.videos![0].relativePath, saved.relativePath);
    assert.equal(task.videoJob!.snapshot.videos![0].freezeState, 'frozen');
    assert.deepEqual(task.videoJob!.preparation?.uploadedVideos, ['openapi/selected.mov']);
    assert.ok(collectVideoFrozenAssets(state.value.project).some((asset: { relativePath: string }) => asset.relativePath === saved.relativePath));
    const restored = normalizeState(JSON.parse(JSON.stringify(state.value)));
    assert.deepEqual(restored.project.generationTasks.find((item) => item.id === taskId)?.videoJob?.snapshot.videos, task.videoJob!.snapshot.videos);
  } finally { engine.dispose(); }
  console.log('video motion references: request, bytes, frozen snapshot, download, and explicit mappings passed');
} finally {
  if (path.dirname(tempRoot) !== path.resolve(tmpdir()) || !path.basename(tempRoot).startsWith('lianhua-motion-test-')) throw new Error('Unexpected test directory');
  rmSync(tempRoot, { recursive: true, force: true });
}

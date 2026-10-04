import assert from 'node:assert/strict';
import {
  bindComfyVideoWorkflow, collectComfyVideoOutputs, importComfyVideoWorkflow, resolveComfyVideoOutputs,
  type ComfyVideoNodeMap,
} from '../src/comfyuiVideo';
import { createInitialState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { VideoGenerationTask } from '../src/types';
import type { ComfyVideoWorkflowPreset, GeneratedMediaDownloadRequest, VideoGenerationDesktop } from '../src/videoGenerationTypes';

const graph = (): ComfyVideoNodeMap => ({
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'original positive' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality' } },
  '3': { class_type: 'ConditioningSetTimestepRange', inputs: { conditioning: ['2', 0], start: 0, end: 1 } },
  '4': { class_type: 'KSampler', inputs: { positive: ['1', 0], negative: ['3', 0], seed: 123, steps: 20 } },
  '9': { class_type: 'VHS_VideoCombine', inputs: { images: ['4', 0], format: 'video/h264-mp4', frame_rate: 24 } },
  '10': { class_type: 'SaveAnimatedWEBP', inputs: { images: ['4', 0] } },
});
const presetFor = (nodes = graph()): ComfyVideoWorkflowPreset => ({
  id: 'isolated-comfy-mapping', name: '隔离条件图与视频输出', createdAt: 1, updatedAt: 1,
  ...importComfyVideoWorkflow(JSON.stringify(nodes)),
});
const promptBindings = (nodes: ComfyVideoNodeMap) => presetFor(nodes).mapping.prompt;
const positiveOnly = [{ nodeId: '1', inputName: 'text' }];

// Unlabelled negative text is protected through conditioning transforms. The
// importer changes only mapping, and applying that mapping preserves all edges.
{
  const nodes = graph(); const preset = presetFor(nodes);
  assert.deepEqual(preset.mapping.prompt, positiveOnly);
  assert.equal(preset.mapping.outputNodeId, '9', 'a later WebP preview is never the video output');
  const bound = bindComfyVideoWorkflow(preset, 'new positive full story', []);
  assert.equal(bound['1'].inputs.text, 'new positive full story');
  assert.equal(bound['2'].inputs.text, 'blurry, low quality');
  for (const nodeId of ['3', '4', '9', '10']) assert.deepEqual(bound[nodeId], nodes[nodeId]);
  assert.equal(preset.workflowJson, JSON.stringify(nodes));
}

// Merged negative branches, reroutes and even a malformed cycle terminate
// safely without turning either negative text into a positive prompt target.
{
  const nodes = graph();
  nodes['5'] = { class_type: 'CLIPTextEncode', inputs: { text: 'second negative' } };
  nodes['6'] = { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['3', 0], conditioning_2: ['5', 0] } };
  nodes['7'] = { class_type: 'Reroute', inputs: { input: ['6', 0], cycle: ['7', 0] } };
  nodes['4'].inputs.negative = ['7', 0];
  assert.deepEqual(promptBindings(nodes), positiveOnly);
}

// Many modern workflows derive an empty negative from the positive itself.
// ZeroOut is a semantic boundary, not proof that the original text is negative.
{
  const nodes = graph(); delete nodes['2'];
  nodes['3'] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['1', 0] }, _meta: { title: 'Negative conditioning' } };
  assert.deepEqual(promptBindings(nodes), positiveOnly);
  const bound = bindComfyVideoWorkflow(presetFor(nodes), 'new positive', []);
  assert.equal(bound['1'].inputs.text, 'new positive');
  assert.deepEqual(bound['3'].inputs.conditioning, ['1', 0]);
}

// A real shared positive/negative source is ambiguous and stays manual-only.
// Explicit user mapping remains authoritative; no local text semantics veto it.
{
  const nodes = graph(); delete nodes['2']; nodes['3'].inputs.conditioning = ['1', 0];
  const preset = presetFor(nodes);
  assert.deepEqual(preset.mapping.prompt, []);
  preset.mapping.prompt = positiveOnly;
  assert.equal(bindComfyVideoWorkflow(preset, 'explicitly selected prompt', [])['1'].inputs.text, 'explicitly selected prompt');
}

// Advanced ControlNet outputs 0/1 carry independent conditions, not a mixed
// prompt. A shared CLIP/model input must never poison both text branches.
{
  const nodes = graph();
  nodes['6'] = { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['1', 0], negative: ['3', 0] } };
  nodes['4'].inputs.positive = ['6', 0]; nodes['4'].inputs.negative = ['6', 1];
  nodes['1'].inputs.clip = ['8', 0]; nodes['2'].inputs.clip = ['8', 0];
  nodes['8'] = { class_type: 'CLIPLoader', inputs: { clip_name: 'model.safetensors' } };
  assert.deepEqual(promptBindings(nodes), positiveOnly);
}

// H3 prompt primitives must also be protected if reached by negative
// conditioning. The title fallback must not reintroduce an excluded source.
{
  const nodes = graph(); delete nodes['1']; delete nodes['2'];
  nodes['11'] = { class_type: 'PrimitiveStringMultiline', inputs: { value: 'negative text' }, _meta: { title: 'Input Text (Prompt)' } };
  nodes['12'] = { class_type: 'MiniMaxH3Condition', inputs: { prompt: ['11', 0] } };
  nodes['3'].inputs.conditioning = ['12', 0]; delete nodes['4'].inputs.positive;
  assert.deepEqual(promptBindings(nodes), []);
}

{
  const nodes = graph(); delete nodes['9'];
  assert.equal(presetFor(nodes).mapping.outputNodeId, undefined, 'WebP-only workflows do not claim a video node');
  nodes['9'] = { class_type: 'VHS_VideoCombine', inputs: { images: ['4', 0], format: 'image/gif' } };
  assert.equal(presetFor(nodes).mapping.outputNodeId, undefined, 'VHS image/GIF output is also a preview');
  nodes['9'].inputs.format = 'video/h264-mp4';
  nodes['11'] = { class_type: 'SaveVideo', inputs: { images: ['4', 0] } };
  assert.equal(presetFor(nodes).mapping.outputNodeId, undefined, 'equally plausible video nodes require an explicit choice');
}

const completed = (multiple = false) => ({ status: { completed: true, status_str: 'success' }, outputs: {
  '9': { gifs: [{ filename: 'finished.mp4', type: 'output' }, { filename: 'finished-audio.mp4', type: 'output' }] },
  '10': { images: [{ filename: 'preview.webp', type: 'output' }] },
  ...(multiple ? { '11': { videos: [{ filename: 'alternative.mp4', type: 'output' }] } } : {}),
} });
const legacy = presetFor(); legacy.mapping.outputNodeId = '10';
const base = 'https://isolated-comfy.invalid';
{
  const resolved = resolveComfyVideoOutputs(completed(), base, legacy);
  assert.equal(resolved.outputs.length, 2, 'multiple files at one video node are not multiple node choices');
  assert.equal(resolved.outputs[0].filename, 'finished-audio.mp4');
  assert.match(resolved.warning!, /唯一视频输出节点 9/u);
  assert.equal(legacy.mapping.outputNodeId, '10', 'recovery does not mutate the saved workflow or task snapshot');
  const ambiguous = resolveComfyVideoOutputs(completed(true), base, legacy);
  assert.equal(ambiguous.outputs.length, 0);
  assert.match(ambiguous.issue!, /多个视频输出节点/u);
  const explicit = { ...legacy, mapping: { ...legacy.mapping, outputNodeId: '11' } };
  assert.equal(resolveComfyVideoOutputs(completed(true), base, explicit).outputs[0].filename, 'alternative.mp4');
  assert.deepEqual(resolveComfyVideoOutputs(completed(), base, explicit).outputs, [], 'a missing explicit video output must not select a different one');
  assert.deepEqual(resolveComfyVideoOutputs(completed(), base, { ...legacy, workflowJson: 'bad old JSON' }).outputs, []);
  assert.equal(resolveComfyVideoOutputs(completed(true), base).outputs.length, 0, 'an unbound multi-output workflow is not resolved by object ordering');
  assert.deepEqual(collectComfyVideoOutputs({ outputs: { '10': { videos: [{ filename: 'preview.webp', format: 'video/webm' }] } } }, base), []);
}

// Exercise the actual engine poll -> download -> durable task path. All
// transport is injected; a resumed task performs GET only, never a new POST.
const pollFixture = async (workflow: ComfyVideoWorkflowPreset, entry: unknown, recoverLegacyFailure = false) => {
  let state = createInitialState();
  const task: VideoGenerationTask = {
    id: 'isolated-comfy-poll', kind: 'video', storyboardId: '', targetId: 'comfy-fixture',
    status: 'submitted', remoteTaskId: 'already-generated', createdAt: 1, updatedAt: 1, requestBody: {},
    videoJob: { stage: 'queued', snapshot: {
      projectId: state.project.id, clientId: 'isolated-comfy-client', images: [],
      draft: { name: '已生成测试视频', prompt: 'synthetic prompt', backend: 'comfyui', workflowId: workflow.id, references: [], parameters: {} },
      connection: { backend: 'comfyui', comfyui: { enabled: true, baseUrl: base }, workflow: structuredClone(workflow) },
    } },
  };
  if (recoverLegacyFailure) {
    task.status = 'failed'; task.response = structuredClone(entry); task.error = '旧版本误选预览节点';
    task.batchId = 'isolated-previous-chain'; task.batchIndex = 1; task.batchTotal = 1;
    task.videoJob!.stage = 'failed'; task.videoJob!.batchQueueState = 'done';
    task.videoJob!.preparation = { version: 1, phase: 'acknowledged', uploadedImages: [] };
    task.videoJob!.snapshot.batchCompletionOrder = true;
  }
  state.project.generationTasks = [task]; state.projects = [state.project];
  const requests: Parameters<VideoGenerationDesktop['videoRequest']>[0][] = [];
  const downloads: GeneratedMediaDownloadRequest[] = [];
  const notices: string[] = [];
  const checkpoints = new Map<string, VideoGenerationTask>();
  const desktop = {
    videoRequest: async (request: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => {
      requests.push(request);
      assert.equal(request.method, 'GET', 'querying a finished job cannot generate or charge again');
      assert.match(request.url, /\/history\/already-generated$/u);
      return { status: 200, body: JSON.stringify({ 'already-generated': entry }) };
    },
    getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (value: VideoGenerationTask) => { checkpoints.set(value.id, structuredClone(value)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId: string) => checkpoints.get(taskId) || null,
    downloadGeneratedMedia: async (request: GeneratedMediaDownloadRequest) => {
      downloads.push(request);
      return { fileName: 'saved.mp4', relativePath: 'video/saved.mp4', checksum: 'synthetic-checksum', sizeBytes: 1024,
        mediaType: 'video' as const, managed: true, missing: false, url: 'lianhua-asset://local/video/saved.mp4' };
    },
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); },
    desktop, onRuntime: () => {}, notify: (message) => notices.push(message), persistState: async () => {}, pollIntervalMs: 60_000 });
  try {
    if (recoverLegacyFailure) {
      await engine.resume(task.id);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = state.project.generationTasks[0] as VideoGenerationTask;
        if (current.resultAssetId && checkpoints.get(task.id)?.resultAssetId) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok((state.project.generationTasks[0] as VideoGenerationTask).resultAssetId, 'public resume must query and save the original completed video');
    } else await (engine as unknown as { poll: (taskId: string) => Promise<void> }).poll(task.id);
  }
  finally { engine.dispose(); }
  assert.equal(requests.length, 1);
  return { task: state.project.generationTasks[0] as VideoGenerationTask, assets: state.project.assets, downloads, notices, checkpoints };
};

{
  const result = await pollFixture(legacy, completed());
  assert.equal(result.task.status, 'succeeded'); assert.ok(result.task.resultAssetId);
  assert.equal(result.downloads.length, 1); assert.match(result.downloads[0].url, /filename=finished-audio\.mp4/u);
  assert.equal(result.notices.length, 1); assert.match(result.notices[0], /唯一视频输出节点 9/u);
  assert.match(result.task.videoJob!.message!, /原绑定节点 10/u);
  assert.match(JSON.stringify(result.task.response), /outputSelectionWarning/u);
  assert.match(result.checkpoints.get(result.task.id)!.videoJob!.message!, /原绑定节点 10/u);
  assert.equal(result.task.videoJob!.snapshot.connection.workflow!.mapping.outputNodeId, '10');
}
{
  const result = await pollFixture(presetFor(), completed());
  assert.equal(result.task.status, 'succeeded'); assert.equal(result.notices.length, 0);
}
{
  const result = await pollFixture(legacy, completed(), true);
  assert.equal(result.task.id, 'isolated-comfy-poll'); assert.equal(result.task.remoteTaskId, 'already-generated');
  assert.equal(result.task.status, 'succeeded'); assert.equal(result.task.videoJob!.stage, 'succeeded');
  assert.equal(result.downloads.length, 1); assert.match(result.downloads[0].url, /filename=finished-audio\.mp4/u);
  assert.equal(result.task.videoJob!.snapshot.connection.workflow!.mapping.outputNodeId, '10');
  assert.match(result.checkpoints.get(result.task.id)!.videoJob!.message!, /原绑定节点 10/u);
}
{
  const result = await pollFixture(legacy, completed(true));
  assert.equal(result.task.status, 'failed'); assert.equal(result.downloads.length, 0);
  assert.match(result.task.error!, /多个视频输出节点/u);
  assert.match(JSON.stringify(result.task.response), /alternative\.mp4/u, 'the original output metadata is retained for explicit choice');
}
{
  const result = await pollFixture(legacy, { status: { completed: true }, outputs: { '10': { images: [{ filename: 'preview.webp' }] } } });
  assert.equal(result.task.status, 'failed'); assert.equal(result.downloads.length, 0);
  assert.match(result.task.error!, /没有可播放视频/u);
}
{
  const explicit = { ...legacy, mapping: { ...legacy.mapping, outputNodeId: '11' } };
  const selected = await pollFixture(explicit, completed(true));
  assert.equal(selected.task.status, 'succeeded'); assert.match(selected.downloads[0].url, /filename=alternative\.mp4/u);
  assert.equal(selected.notices.length, 0);
  const missing = await pollFixture(explicit, completed());
  assert.equal(missing.task.status, 'failed'); assert.equal(missing.downloads.length, 0);
}

console.log('ComfyUI video graph/output regression passed: indirect negatives, ZeroOut, explicit bindings, preview recovery, ambiguous outputs and real GET-only engine polling.');

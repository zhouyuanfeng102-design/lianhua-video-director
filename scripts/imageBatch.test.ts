import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cloneImageBatchConfig, createImageBatchSeeds, enqueueImageBatchMembers, imageBatchMemberApi, imageBatchTaskIsActive, normalizeImageBatchCount } from '../src/imageBatch';
import { createImageGenerationTask } from '../src/generationTasks';
import { createInitialState, normalizeState } from '../src/storage';
import { requestImageModel } from '../src/services/llm';
import type { ImageApiConfig, ImageGenerationTask } from '../src/types';

assert.deepEqual([undefined, 0, -2, 1, 3, 4, 8, 99, Infinity, '4', 3.8].map(normalizeImageBatchCount), [1, 1, 1, 1, 3, 4, 8, 8, 1, 4, 3]);
assert.equal(new Set(createImageBatchSeeds(8, 2_147_483_644)).size, 8);
const workflow = {
  text: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
  latent: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  sampler: { class_type: 'KSampler', inputs: { positive: ['text', 0], latent_image: ['latent', 0], seed: 12 } },
  noise: { class_type: 'RandomNoise', inputs: { noise_seed: 12 } },
  linked: { class_type: 'KSamplerAdvanced', inputs: { noise_seed: ['seed-source', 0] } },
  unrelated: { class_type: 'CustomValue', inputs: { seed: 12 } },
  decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0] } },
  output: { class_type: 'SaveImage', inputs: { images: ['decode', 0] } },
};
const api: ImageApiConfig = {
  enabled: true, backend: 'comfyui', baseUrl: 'https://image.test', apiKey: 'test-only', model: '',
  workflowJson: JSON.stringify(workflow), activeComfyuiWorkflowId: 'preset',
  comfyuiWorkflows: [{ id: 'preset', name: '测试', workflowJson: JSON.stringify(workflow), createdAt: 1, updatedAt: 1 }],
};
const frozen = cloneImageBatchConfig(api);
const member = imageBatchMemberApi(frozen, 777);
assert.equal(JSON.parse(member.workflowJson!).sampler.inputs.seed, 777);
assert.equal(JSON.parse(member.comfyuiWorkflows![0].workflowJson).noise.inputs.noise_seed, 777);
assert.deepEqual(JSON.parse(member.workflowJson!).linked.inputs.noise_seed, ['seed-source', 0]);
assert.equal(JSON.parse(member.workflowJson!).unrelated.inputs.seed, 12);
assert.equal(JSON.parse(api.workflowJson!).sampler.inputs.seed, 12, 'stored fixed seed is not modified');
api.comfyuiWorkflows![0].name = 'later mutation';
assert.equal(frozen.comfyuiWorkflows![0].name, '测试', 'queued nested workflows are frozen');

let state = createInitialState();
state.project.generationTasks = [];
state.projects = [state.project];
const projectId = state.project.id;
const make = (batch: string, count: number, entity: string, part?: 'full-body' | 'breasts') => Array.from({ length: count }, (_, index) => createImageGenerationTask({
  id: `${batch}-${index}`, name: `${entity} ${index + 1}`, batchId: batch, batchCount: count, batchIndex: index,
  assetKind: 'character', imageVariant: part ? 'private-close-up' : 'full-body', sourceEntityId: entity,
  referenceScope: part ? 'nsfw-private-profile' : 'general', nsfwPrivatePart: part,
  seed: 10 + index, prompt: '', width: 1024, height: 1024, backend: 'comfyui', model: 'mock',
}, 1 + index, 'queued'));
const a = make('a', 3, '人物甲');
const b = make('b', 4, '人物乙', 'breasts');
const c = make('c', 3, '人物乙', 'full-body');
state.project.generationTasks = [...a, ...b, ...c];
const events: string[] = [];
const conversions: string[] = [];
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
let started!: () => void;
const firstStarted = new Promise<void>((resolve) => { started = resolve; });
let active = 0;
let peak = 0;
const queue = (tasks: ImageGenerationTask[]) => {
  let shared: Promise<string> | undefined;
  return enqueueImageBatchMembers(tasks, (task) => imageBatchTaskIsActive(state, projectId, task, true), async (task) => {
    task.status = 'running';
    active += 1;
    peak = Math.max(peak, active);
    shared ??= Promise.resolve().then(() => { conversions.push(task.batchId!); return `${task.sourceEntityId}:${task.nsfwPrivatePart || 'ordinary'}`; });
    task.prompt = await shared;
    if (task.id === 'a-0') { started(); await gate; }
    if (!imageBatchTaskIsActive(state, projectId, task)) { active -= 1; return; }
    events.push(task.id);
    // A failed image does not stop the rest of the current/next batch.
    task.status = task.id === 'a-1' ? 'failed' : 'succeeded';
    active -= 1;
  });
};
const pending = [queue(a), queue(b), queue(c)];
await firstStarted;
assert.equal(events.length, 0);
assert.equal(b.every((task) => task.status === 'queued'), true, 'another person submits without waiting for first result');
assert.equal(c.every((task) => task.status === 'queued'), true, 'another part submits without waiting for same person');
b[1].status = 'failed'; b[1].error = '已取消';
state.project.generationTasks = state.project.generationTasks.filter((task) => task.id !== 'b-2');
release();
await Promise.all(pending);
assert.deepEqual(events, ['a-0', 'a-1', 'a-2', 'b-0', 'b-3', 'c-0', 'c-1', 'c-2']);
assert.deepEqual(conversions, ['a', 'b', 'c'], 'one converter call per frozen batch');
assert.equal(peak, 1, 'multiple submissions never amplify GPU concurrency');
assert.equal(c[0].prompt, '人物乙:full-body');
assert.equal(b[0].prompt, '人物乙:breasts');
assert.equal(a[2].prompt, '人物甲:ordinary');
assert.equal(a[2].status, 'succeeded', 'the second member failure does not block the third');
assert.equal(imageBatchTaskIsActive(state, 'wrong-project', a[0]), false);
assert.equal(imageBatchTaskIsActive(state, projectId, { ...b[0], batchId: 'foreign' }), false);
const interrupted = make('restart', 4, '人物甲');
const restoredProject = { ...state.project, generationTasks: interrupted };
const restored = normalizeState({ ...state, project: restoredProject, projects: [restoredProject] });
assert.equal(restored.project.generationTasks.every((task) => task.status === 'failed'), true, 'restart cannot automatically charge queued images');
assert.equal(imageBatchTaskIsActive(restored, projectId, interrupted[0]), false);
const restoredTask = restored.project.generationTasks[0] as ImageGenerationTask;
assert.deepEqual([restoredTask.batchCount, restoredTask.batchIndex, restoredTask.seed], [4, 0, 10]);

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const originalWindow = globalThis.window;
const requests: Array<{ url: string; body?: string }> = [];
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
  request: async (request: { url: string; body?: string }) => {
    requests.push(request);
    if (request.url.includes('/history/')) return { status: 200, body: JSON.stringify({ 'mock-image': { status: { completed: true }, outputs: { output: { images: [{ filename: 'test.png' }] } } } }) };
    if (request.url.endsWith('/prompt')) return { status: 200, body: JSON.stringify({ prompt_id: 'mock-image' }) };
    if (request.url.includes('/ai/generate-image')) return { status: 200, body: png };
    return { status: 200, body: JSON.stringify(request.url.includes('/sdapi/') ? { images: [png] } : { data: [{ b64_json: png }] }) };
  }, downloadImage: async () => `data:image/png;base64,${png}`,
} } });
try {
  for (const backend of ['openai', 'sd_webui', 'novelai', 'comfyui'] as const) {
    const modelApi = imageBatchMemberApi({ ...frozen, backend, model: backend === 'novelai' ? 'nai-diffusion-4-5-full' : 'mock-model' }, 987);
    const before = requests.length;
    await requestImageModel(modelApi, { prompt: 'one adult character', width: 1024, height: 1024, seed: 987 });
    const posted = requests.slice(before).find((request) => request.body)!;
    const body = JSON.parse(posted.body!);
    if (backend === 'openai') assert.equal(body.seed, undefined, 'unsupported seed omitted');
    else if (backend === 'novelai') assert.equal(body.parameters.seed, 987);
    else if (backend === 'comfyui') assert.equal(body.prompt.sampler.inputs.seed, 987);
    else assert.equal(body.seed, 987);
  }
  const beforeCancelled = requests.length;
  await assert.rejects(requestImageModel({ ...frozen, backend: 'openai', model: 'mock-model' }, { prompt: 'never submitted' }, () => { throw new Error('cancelled at POST boundary'); }), /cancelled/u);
  assert.equal(requests.length, beforeCancelled, 'transport FIFO start check can prevent a late paid POST');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const workbench = source.slice(source.indexOf('function ImageWorkbenchView'), source.indexOf('function AssetsView'));
const submit = workbench.slice(workbench.indexOf('const createPromptAsset = async'), workbench.indexOf('const generateSelectedStoryboardImages = async'));
assert.doesNotMatch(submit, /setBusy\(/u, 'a queued workbench image cannot lock the whole form until completion');
assert.match(submit, /latestImageBatchIdRef\.current\[requestedGenerationMode\] === requestedBatchId/u);
assert.match(submit, /currentIdentity\.selectedEntityId === requestIdentity\.selectedEntityId/u);
assert.match(submit, /currentIdentity\.nsfwPrivatePart === requestIdentity\.nsfwPrivatePart/u);
assert.match(submit, /batchConvertedPrompt \?\?=/u, 'one shared AI conversion per batch');
assert.doesNotMatch(workbench, /aria-label="本批图片选择预览"/u, 'batch images are viewed through saved task results and assets');
assert.match(workbench, /generationCount: normalizeImageBatchCount/u);
console.log('Image multi-submit checks passed: independent person/part batches 3/4, single FIFO, cancellation/removal, failed member continuation, frozen config, distinct seeds and restart-safe task results.');

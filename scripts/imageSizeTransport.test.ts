import assert from 'node:assert/strict';
import { buildComfyUIWorkflow, getComfyImageSizeOverrideSupport } from '../src/comfyui';
import { createImageGenerationTask } from '../src/generationTasks';
import { buildImageRegenerationTask, executeImageRegeneration, resolveImageAssetRegenerationTask } from '../src/imageRegeneration';
import { requestImageModel, type ImageGenerationOptions } from '../src/services/llm';
import { createInitialState, normalizeState } from '../src/storage';
import type { ImageApiConfig, ImageGenerationTask, ReferenceAsset } from '../src/types';

const canvasWorkflow = (prompt = '__PROMPT__') => ({
  text: { class_type: 'CLIPTextEncode', inputs: { text: prompt } },
  canvas: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
  sampler: { class_type: 'KSampler', inputs: { positive: ['text', 0], latent_image: ['canvas', 0], seed: 12 } },
  decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0] } },
  output: { class_type: 'SaveImage', inputs: { images: ['decode', 0] } },
  referenceResize: { class_type: 'ImageScale', inputs: { width: 320, height: 240 } },
});
const chosen = { prompt: 'A scenic landscape.', negativePrompt: '', width: 2048, height: 3072, sizeOverride: true };
for (const prompt of ['__PROMPT__', 'original prompt']) {
  const workflow = canvasWorkflow(prompt);
  const original = JSON.stringify(workflow);
  assert.equal(getComfyImageSizeOverrideSupport(original).supported, true);
  const built = buildComfyUIWorkflow(original, chosen) as typeof workflow;
  assert.equal(built.canvas.inputs.width, 2048);
  assert.equal(built.canvas.inputs.height, 3072);
  assert.equal(built.referenceResize.inputs.width, 320, 'an explicit canvas choice must not rewrite a reference scaler');
  assert.equal(built.referenceResize.inputs.height, 240);
  assert.equal(JSON.stringify(workflow), original, 'must not mutate stored template');
}
const fixed = canvasWorkflow();
const legacyBuilt = buildComfyUIWorkflow(JSON.stringify(fixed), { ...chosen, sizeOverride: false }) as typeof fixed;
assert.equal(legacyBuilt.canvas.inputs.width, 512, 'legacy/default behavior is unchanged');
assert.equal(legacyBuilt.canvas.inputs.height, 768);
const custom = {
  ...canvasWorkflow(),
  canvas: { class_type: 'CustomCanvas', inputs: { output_width: '__WIDTH__', output_height: '{{height}}' } },
};
assert.equal(getComfyImageSizeOverrideSupport(JSON.stringify(custom)).supported, true, 'exact markers opt a custom node into dimensions');
const builtCustom = buildComfyUIWorkflow(JSON.stringify(custom), chosen) as typeof custom;
assert.equal(builtCustom.canvas.inputs.output_width, 2048);
assert.equal(builtCustom.canvas.inputs.output_height, 3072);
const linked = {
  ...canvasWorkflow(),
  canvas: { class_type: 'EmptyLatentImage', inputs: { width: ['width', 0], height: ['height', 0] } },
  width: { class_type: 'PrimitiveNode', inputs: { value: 512 } },
  height: { class_type: 'PrimitiveNode', inputs: { value: 768 } },
};
const disconnected = { ...canvasWorkflow(), sampler: { class_type: 'KSampler', inputs: { positive: ['text', 0] } } };
const promptOnly = {
  text: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__ size __WIDTH__ __HEIGHT__' } },
  output: { class_type: 'SaveImage', inputs: { images: ['text', 0] } },
};
const ambiguous = {
  ...canvasWorkflow(),
  otherCanvas: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024 } },
  otherSampler: { class_type: 'KSampler', inputs: { latent_image: ['otherCanvas', 0] } },
  otherOutput: { class_type: 'SaveImage', inputs: { images: ['otherSampler', 0] } },
};
for (const workflow of [linked, disconnected, promptOnly, ambiguous]) {
  assert.equal(getComfyImageSizeOverrideSupport(JSON.stringify(workflow)).supported, false);
  assert.throws(() => buildComfyUIWorkflow(JSON.stringify(workflow), chosen), /尺寸|画布|像素/u);
}
const legacyLinked = buildComfyUIWorkflow(JSON.stringify(linked), { ...chosen, sizeOverride: false }) as typeof linked;
assert.deepEqual(legacyLinked.canvas.inputs.width, ['width', 0], 'must never break graph links');
assert.equal(getComfyImageSizeOverrideSupport('{broken').supported, false);

type Request = { url: string; body?: string; multipart?: { fields: Array<{ name: string; value: string }> } };
const requests: Request[] = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const originalWindow = globalThis.window;
Object.defineProperty(globalThis, 'window', {
  configurable: true, writable: true,
  value: { lianhuaDesktop: {
    request: async (payload: Request) => {
      requests.push(payload);
      if (payload.url.includes('/history/')) return { status: 200, body: JSON.stringify({ 'test-job': { status: { completed: true }, outputs: { output: { images: [{ filename: '2k.png' }] } } } }) };
      if (payload.url.endsWith('/prompt')) return { status: 200, body: JSON.stringify({ prompt_id: 'test-job' }) };
      if (payload.url.includes('/ai/generate-image')) return { status: 200, body: png };
      return { status: 200, body: JSON.stringify(payload.url.includes('/sdapi/') ? { images: [png] } : { data: [{ b64_json: png }] }) };
    },
    downloadImage: async () => `data:image/png;base64,${png}`,
  } },
});
const config = (backend: ImageApiConfig['backend']): ImageApiConfig => ({ enabled: true, backend, baseUrl: 'https://image.example.test', apiKey: 'mock-only', model: backend === 'novelai' ? 'nai-diffusion-4-5-full' : 'configured-model' });
try {
  for (const backend of ['openai', 'sd_webui'] as const) {
    for (const references of [[], [`data:image/png;base64,${png}`]]) {
      await requestImageModel(config(backend), { ...chosen, referenceImages: references });
      const request = requests.at(-1)!;
      if (backend === 'openai' && references.length) {
        assert.equal(request.multipart?.fields.find((entry) => entry.name === 'size')?.value, '2048x3072', 'image edits multipart must carry selected pixels');
      } else {
        const body = JSON.parse(request.body || '{}');
        if (backend === 'openai') assert.equal(body.size, '2048x3072');
        else assert.deepEqual([body.width, body.height], [2048, 3072]);
        assert.equal(body.image_size, undefined, 'do not invent a different provider protocol');
      }
    }
  }
  await requestImageModel(config('novelai'), { ...chosen, width: 2048, height: 2048 });
  assert.deepEqual(
    [JSON.parse(requests.at(-1)!.body!).parameters.width, JSON.parse(requests.at(-1)!.body!).parameters.height],
    [2048, 2048], 'NovelAI gets the selected numeric size without a local 1024 downgrade',
  );
  await requestImageModel({ ...config('comfyui'), workflowJson: JSON.stringify(canvasWorkflow()) }, chosen);
  const submitted = JSON.parse(requests.find((request) => request.url.endsWith('/prompt'))!.body!);
  assert.deepEqual([submitted.prompt.canvas.inputs.width, submitted.prompt.canvas.inputs.height], [2048, 3072]);
  const beforeInvalid = requests.length;
  await assert.rejects(() => requestImageModel(config('openai'), { ...chosen, width: Number.NaN }), /像素无效/u);
  await assert.rejects(() => requestImageModel({ ...config('comfyui'), workflowJson: JSON.stringify(linked) }, { ...chosen, referenceImages: [`data:image/png;base64,${png}`] }), /尺寸|画布|像素/u);
  assert.equal(requests.length, beforeInvalid, 'unsupported sizes must fail before any image/reference upload request');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}

const task = createImageGenerationTask({ id: 'high-resolution-source', name: '风景', assetKind: 'location', imageVariant: 'landscape', prompt: 'saved landscape prompt', width: 3072, height: 2048, sizeOverride: true, backend: 'comfyui', model: 'saved-workflow' }, 10);
const initial = createInitialState();
const project = { ...initial.project, generationTasks: [{ ...task, status: 'succeeded' as const }] };
const loaded = normalizeState({ ...initial, project, projects: [project] });
const recovered = loaded.project.generationTasks.find((entry) => entry.id === task.id) as ImageGenerationTask;
assert.equal(recovered.sizeOverride, true);
assert.deepEqual([recovered.width, recovered.height], [3072, 2048]);
const child = buildImageRegenerationTask(recovered, loaded.project, { id: 'high-resolution-retry', timestamp: 20, backend: 'comfyui', model: 'saved-workflow', source: { conversionSource: 'A scenic lake with clouds and mountains.', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [] } });
assert.equal(child.sizeOverride, true);
const replayed: ImageGenerationOptions[] = [];
for (const savedPrompt of ['saved landscape prompt', '']) {
  await executeImageRegeneration({ ...child, prompt: savedPrompt, imagePromptFormat: 'natural-language' }, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => 'A scenic lake with mountains and warm sunlight, cinematic composition.',
    persistPrompt: () => undefined,
    generateImage: async (input) => { replayed.push(input); return input.prompt; },
  });
}
assert.equal(replayed.length, 2);
for (const input of replayed) assert.deepEqual([input.width, input.height, input.sizeOverride], [3072, 2048, true], 'saved/converted retries both preserve requested size semantics');

const downscaledAsset: ReferenceAsset = {
  id: 'downscaled-result', name: '请求2K但后端返回1K', type: 'location', role: 'scene', source: 'generated',
  prompt: 'A scenic landscape.', imageBackend: 'comfyui', imageVariant: 'landscape',
  width: 1024, height: 1024, imageRequestSize: { width: 2048, height: 2048, sizeOverride: true },
  tags: [], createdAt: 30, updatedAt: 30,
};
const noTaskProject = { ...initial.project, assets: [downscaledAsset], generationTasks: [] };
const assetRoundTrip = normalizeState({ ...initial, project: noTaskProject, projects: [noTaskProject] });
const restoredAsset = assetRoundTrip.project.assets.find((asset) => asset.id === downscaledAsset.id)!;
assert.deepEqual(restoredAsset.imageRequestSize, { width: 2048, height: 2048, sizeOverride: true }, 'asset request snapshots survive reload independently of actual pixels');
const synthetic = resolveImageAssetRegenerationTask(restoredAsset, assetRoundTrip.project, config('comfyui'))!;
assert.deepEqual([synthetic.width, synthetic.height, synthetic.sizeOverride], [2048, 2048, true], 'deleted task must not downgrade retry to the returned 1K metadata');
const regeneratedFromAsset = buildImageRegenerationTask(synthetic, assetRoundTrip.project, {
  id: 'restored-asset-retry', timestamp: 40, backend: 'comfyui', model: 'current-workflow',
  source: { conversionSource: '', converterSystemPrompt: '', referenceAssetIds: [], primaryReferenceAssetIds: [] },
});
await executeImageRegeneration(regeneratedFromAsset, {
  referenceImages: [], primaryReferenceImageCount: 0,
  convertPrompt: async () => { throw new Error('saved prompt should not be reconverted'); },
  persistPrompt: () => undefined,
  generateImage: async (input) => {
    assert.deepEqual([input.width, input.height, input.sizeOverride], [2048, 2048, true]);
    return input.prompt;
  },
});
for (const invalidSnapshot of [
  undefined, null, [], '2048x2048',
  { width: -2048, height: 2048, sizeOverride: true },
  { width: 2048.5, height: 2048, sizeOverride: true },
  { width: 2048, height: Number.NaN, sizeOverride: true },
  { width: Number.POSITIVE_INFINITY, height: 2048, sizeOverride: true },
  { width: 4097, height: 2048, sizeOverride: true },
  { width: Number.MAX_SAFE_INTEGER + 1, height: 2048, sizeOverride: true },
  { width: 2048, height: 2048, sizeOverride: 'true' },
  { width: '2048', height: 2048, sizeOverride: true },
]) {
  const legacy = resolveImageAssetRegenerationTask({ ...downscaledAsset, imageRequestSize: invalidSnapshot as ReferenceAsset['imageRequestSize'] }, noTaskProject, config('comfyui'))!;
  assert.deepEqual([legacy.width, legacy.height, legacy.sizeOverride], [1024, 1024, undefined], 'invalid/absent request metadata cannot hijack pixels or grant an override to a legacy asset');
}
const defaultSnapshot = resolveImageAssetRegenerationTask({ ...downscaledAsset, imageRequestSize: { width: 1536, height: 1024, sizeOverride: false } }, noTaskProject, config('comfyui'))!;
assert.deepEqual([defaultSnapshot.width, defaultSnapshot.height, defaultSnapshot.sizeOverride], [1536, 1024, false], 'explicitly frozen default must also survive task deletion');
console.log('Image size transport checks passed: API JSON/multipart, SD/NovelAI, conservative ComfyUI overrides, task persistence and retries.');

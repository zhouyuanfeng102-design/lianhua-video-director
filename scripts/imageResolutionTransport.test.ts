import assert from 'node:assert/strict';
import { buildComfyUIWorkflow, getComfyImageSizeOverrideSupport, importComfyUIApiWorkflow } from '../src/comfyui';
import { resolveImageResolution } from '../src/imageResolution';
import { requestImageModel } from '../src/services/llm';
import type { ImageApiConfig } from '../src/types';

type Request = {
  url: string; body?: string; headers: Record<string, string>;
  multipart?: { fields: Array<{ name: string; value: string }>; files: Array<{ name: string; dataUrl: string }> };
};
const requests: Request[] = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const reference = `data:image/png;base64,${png}`;
const originalWindow = globalThis.window;
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
  request: async (request: Request) => {
    requests.push(request);
    if (request.url.includes(':generateContent')) return { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [
      { text: 'A generated image.' }, { inlineData: { mimeType: 'image/png', data: png } },
    ] } }] }) };
    if (request.url.includes('/ai/generate-image')) return { status: 200, body: png };
    if (request.url.includes('/history/')) return { status: 200, body: JSON.stringify({ 'mock-job': { status: { completed: true }, outputs: { save: { images: [{ filename: 'native.png' }] } } } }) };
    if (request.url.endsWith('/prompt')) return { status: 200, body: JSON.stringify({ prompt_id: 'mock-job' }) };
    return { status: 200, body: JSON.stringify(request.url.includes('/sdapi/') ? { images: [png] } : { data: [{ b64_json: png }] }) };
  },
  downloadImage: async () => reference,
} } });
const config = (backend: ImageApiConfig['backend'], model = 'configured-model'): ImageApiConfig => ({
  enabled: true, backend, baseUrl: 'https://image.example.test', apiKey: 'mock-only', model,
  imageSupportedResolutions: ['1K', '2K', '4K'],
});
const planned = (api: ImageApiConfig, tier: '1K' | '2K' | '4K', aspect = '3:2') => {
  const result = resolveImageResolution({ tier, logicalAspectRatio: aspect, config: api });
  assert.equal(result.issue, '', result.issue);
  assert.ok(result.resolutionPlan);
  return { prompt: 'One person, one continuous composition.', width: result.width, height: result.height, sizeOverride: true, resolutionPlan: result.resolutionPlan! };
};
const json = (request = requests.at(-1)!) => JSON.parse(request.body || '{}');

try {
  const compatible = config('openai');
  await requestImageModel(compatible, { prompt: 'legacy request', width: 3072, height: 2048, sizeOverride: true });
  assert.equal(json().size, '3072x2048', 'requests without a plan retain saved historical pixel semantics');
  assert.equal(json().response_format, 'b64_json');

  const official = { ...config('openai', 'gpt-image-2'), imageProtocol: 'openai-images' as const };
  const officialPlan = planned(official, '4K', '16:9');
  await requestImageModel(official, officialPlan);
  assert.equal(json().size, '3840x2160');
  assert.equal(json().response_format, undefined, 'official GPT image requests omit the legacy response_format field');
  await requestImageModel(official, { ...officialPlan, referenceImages: [reference, reference], preserveReferenceImageOrder: true });
  assert.ok(requests.at(-1)!.url.endsWith('/images/edits'));
  assert.equal(requests.at(-1)!.multipart!.fields.find((field) => field.name === 'size')!.value, '3840x2160');
  assert.equal(requests.at(-1)!.multipart!.files.length, 2, 'explicit equal-pixel reference slots remain ordered');

  const alias = { ...config('openai', 'gemini-3-pro-image'), imageProtocol: 'openai-compatible' as const };
  await requestImageModel(alias, planned(alias, '2K'));
  assert.equal(json().size, '2528x1696', 'a model alias never switches the explicit wire protocol');
  assert.ok(requests.at(-1)!.url.endsWith('/images/generations'));

  const gemini = { ...config('openai', 'gemini-3-pro-image'), baseUrl: 'https://image.example.test/v1beta?source=mock', imageProtocol: 'gemini' as const };
  const geminiPlan = planned(gemini, '4K', '16:9');
  const generatedGemini = await requestImageModel(gemini, { ...geminiPlan, referenceImages: [reference, reference], preserveReferenceImageOrder: true });
  assert.equal(generatedGemini.dataUrl, reference);
  assert.equal(requests.at(-1)!.url, 'https://image.example.test/v1beta/models/gemini-3-pro-image:generateContent?source=mock');
  assert.equal(requests.at(-1)!.headers['x-goog-api-key'], 'mock-only');
  assert.equal(requests.at(-1)!.headers.Authorization, undefined);
  assert.deepEqual(json().generationConfig.imageConfig, { aspectRatio: '16:9', imageSize: '4K' });
  assert.equal(json().contents[0].parts.filter((part: any) => part.inlineData).length, 2);
  assert.equal(json().size, undefined);
  const fixedGemini = { ...gemini, model: 'gemini-2.5-flash-image' };
  await requestImageModel(fixedGemini, planned(fixedGemini, '1K', '1:1'));
  assert.deepEqual(json().generationConfig.imageConfig, { aspectRatio: '1:1' }, 'fixed-1K legacy Gemini does not receive an unsupported imageSize field');

  const xai = { ...config('openai', 'grok-imagine-image-2.0'), imageProtocol: 'xai' as const };
  const xaiPlan = planned(xai, '2K', '16:9');
  await requestImageModel(xai, xaiPlan);
  assert.equal(json().resolution, '2k');
  assert.equal(json().aspect_ratio, '16:9');
  assert.equal(json().size, undefined);
  await requestImageModel(xai, { ...xaiPlan, referenceImages: [reference] });
  assert.deepEqual(json().image, { type: 'image_url', url: reference });
  assert.equal(requests.at(-1)!.multipart, undefined, 'native xAI editing uses JSON, not OpenAI multipart');
  await requestImageModel(xai, { ...xaiPlan, referenceImages: [reference, reference], preserveReferenceImageOrder: true });
  assert.equal(json().images.length, 2);
  assert.equal(json().image, undefined);

  const sd = config('sd_webui');
  const sdPlan = planned(sd, '2K');
  await requestImageModel(sd, { ...sdPlan, referenceImages: [reference] });
  assert.deepEqual([json().width, json().height], [sdPlan.width, sdPlan.height]);
  assert.equal(json().enable_hr, undefined, 'resolution selection never inserts high-resolution upscaling');
  const nai = config('novelai', 'nai-diffusion-4-5-full');
  const naiPlan = planned(nai, '2K', '1:1');
  await requestImageModel(nai, naiPlan);
  assert.deepEqual([json().parameters.width, json().parameters.height], [2048, 2048]);

  const beforeInvalid = requests.length;
  let started = 0;
  await assert.rejects(() => requestImageModel(official, { ...officialPlan, width: 1024 }, () => { started += 1; }), /计划不一致/u);
  await assert.rejects(() => requestImageModel(xai, { ...xaiPlan, referenceImages: Array(6).fill(reference), preserveReferenceImageOrder: true }, () => { started += 1; }), /最多接收5张/u);
  await assert.rejects(() => requestImageModel(gemini, { ...geminiPlan, resolutionPlan: { ...geminiPlan.resolutionPlan, encoding: { kind: 'size', value: '1024x1024' } } }), /计划无效/u);
  assert.equal(requests.length, beforeInvalid, 'plan/reference validation occurs before uploads and generation requests');
  assert.equal(started, 0, 'invalid work never enters the execution stage');

  const advisoryXai = planned(xai, '4K', '16:9');
  await requestImageModel(xai, advisoryXai);
  assert.equal(json().resolution, '4k', 'model support is advisory; the selected tier reaches the provider');
  const autoGpt = planned(official, '4K', '3:2');
  assert.deepEqual([autoGpt.width, autoGpt.height, autoGpt.resolutionPlan.logicalAspectRatio], [3840, 2160, '16:9']);
  await requestImageModel(official, autoGpt);
  assert.equal(json().size, '3840x2160', 'GPT layout adaptation reaches the real transport');
  for (const api of [gemini, xai]) {
    const custom = resolveImageResolution({ tier: 'custom', logicalAspectRatio: '3:2', width: 3840, height: 2560, config: api });
    assert.equal(custom.issue, ''); assert.ok(custom.warning); assert.ok(custom.resolutionPlan);
    await requestImageModel(api, { prompt: 'A neutral display object.', width: custom.width, height: custom.height, sizeOverride: true, resolutionPlan: custom.resolutionPlan });
    const body = json();
    const nativePrompt = api.imageProtocol === 'gemini' ? body.contents[0].parts[0].text : body.prompt;
    assert.match(nativePrompt, /Requested output canvas: 3840 × 2560 pixels/u);
    assert.equal(api.imageProtocol === 'gemini' ? body.generationConfig.imageConfig.aspectRatio : body.aspect_ratio, '3:2');
    assert.equal(body.size, undefined, 'native custom asks through documented prompt/aspect fields, without invented pixel parameters');
  }
  const undeclaredSd = { ...sd, imageSupportedResolutions: ['1K'] as const } as unknown as ImageApiConfig;
  await requestImageModel(undeclaredSd, planned(undeclaredSd, '4K', '16:9'));
  assert.deepEqual([json().width, json().height], [4096, 2304], 'an undeclared local tier is still submitted as selected');

  const workflow = {
    text: { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: 'old positive', text_l: 'old positive', width: 768, height: 512, target_width: 768, target_height: 512 } },
    base: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 512, batch_size: 1 } },
    first: { class_type: 'KSampler', inputs: { positive: ['text', 0], latent_image: ['base', 0], seed: 77, steps: 8, cfg: 1, denoise: 1 } },
    latentUpscale: { class_type: 'LatentUpscale', inputs: { samples: ['first', 0], width: 1536, height: 1024 } },
    refineText: { class_type: 'CLIPTextEncodeSDXLRefiner', inputs: { text: 'refine', width: 1536, height: 1024 } },
    refine: { class_type: 'KSampler', inputs: { positive: ['refineText', 0], latent_image: ['latentUpscale', 0], denoise: 0.2 } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['refine', 0] } },
    finalScale: { class_type: 'ImageScale', inputs: { image: ['decode', 0], width: 1536, height: 1024 } },
    save: { class_type: 'SaveImage', inputs: { images: ['finalScale', 0] } },
    referenceResize: { class_type: 'ImageScale', inputs: { width: 320, height: 240 } },
  };
  const source = JSON.stringify(workflow);
  const imported = importComfyUIApiWorkflow(source);
  const importedNodes = JSON.parse(imported.workflowJson);
  assert.equal(importedNodes.base.inputs.width, '__WIDTH__');
  assert.equal(importedNodes.text.inputs.target_width, '__TARGET_WIDTH__');
  assert.equal(importedNodes.text.inputs.text_g, '__PROMPT__');
  assert.equal(importedNodes.latentUpscale.inputs.width, 1536);
  assert.equal(importedNodes.refineText.inputs.width, 1536);
  assert.equal(importedNodes.finalScale.inputs.width, 1536);
  assert.equal(importedNodes.referenceResize.inputs.width, 320);
  const input = { prompt: 'one person', negativePrompt: '', width: 3072, height: 2048, sizeOverride: true };
  const built: any = buildComfyUIWorkflow(imported.workflowJson, input);
  assert.deepEqual([built.base.inputs.width, built.base.inputs.height], [3072, 2048]);
  assert.deepEqual([built.text.inputs.target_width, built.text.inputs.target_height], [3072, 2048]);
  assert.deepEqual([built.latentUpscale.inputs.width, built.latentUpscale.inputs.height], [1536, 1024]);
  assert.equal(built.first.inputs.denoise, 1);
  assert.equal(built.first.inputs.seed, 77);
  assert.equal(JSON.stringify(workflow), source, 'stored workflows stay immutable');

  const explicit: any = structuredClone(workflow);
  explicit.finalScale.inputs.width = '__WIDTH__'; explicit.finalScale.inputs.height = '__HEIGHT__';
  const explicitImport = importComfyUIApiWorkflow(JSON.stringify(explicit));
  const explicitBuilt: any = buildComfyUIWorkflow(explicitImport.workflowJson, input);
  assert.deepEqual([explicitBuilt.base.inputs.width, explicitBuilt.base.inputs.height], [768, 512], 'a final output marker must not implicitly expand the base canvas');
  assert.deepEqual([explicitBuilt.finalScale.inputs.width, explicitBuilt.finalScale.inputs.height], [3072, 2048]);
  assert.equal(getComfyImageSizeOverrideSupport(explicitImport.workflowJson).supported, true);

  const oldBroad: any = structuredClone(workflow);
  for (const key of ['base', 'latentUpscale', 'finalScale', 'referenceResize']) {
    oldBroad[key].inputs.width = '__WIDTH__'; oldBroad[key].inputs.height = '__HEIGHT__';
  }
  assert.equal(getComfyImageSizeOverrideSupport(JSON.stringify(oldBroad)).supported, false);
  assert.throws(() => buildComfyUIWorkflow(JSON.stringify(oldBroad), input), /原始 API JSON/u, 'lost old stage dimensions are not guessed');

  const nativeWorkflow = {
    text: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
    base: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    first: { class_type: 'KSampler', inputs: { positive: ['text', 0], latent_image: ['base', 0], seed: 77, denoise: 1 } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['first', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0] } },
  };
  const comfy = { ...config('comfyui'), workflowJson: JSON.stringify(nativeWorkflow) };
  const comfyPlan = planned(comfy, '2K', '1:1');
  await requestImageModel(comfy, comfyPlan);
  const submitted = json([...requests].reverse().find((request) => request.url.endsWith('/prompt'))!);
  assert.deepEqual([submitted.prompt.base.inputs.width, submitted.prompt.base.inputs.height], [2048, 2048]);
  assert.equal(Object.keys(submitted.prompt).length, Object.keys(nativeWorkflow).length, 'native selection inserts neither upscalers nor extra sampling stages');
  assert.equal(submitted.prompt.first.inputs.denoise, 1);
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log('Native resolution transport checks passed: frozen plans, GPT/Gemini/xAI JSON/multipart, SD/NAI/ComfyUI and conservative workflow bindings; all requests mocked.');

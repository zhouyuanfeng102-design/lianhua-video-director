import assert from 'node:assert/strict';
import { requestImageModel } from '../src/services/llm';
import { assertDirectStoryboardImageApiSupport } from '../src/storyboardImageToImage';
import { bindComfyUIReferenceImagesWithResult } from '../src/comfyui';
import type { ImageApiConfig } from '../src/types';

interface HttpPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  multipart?: {
    fields: Array<{ name: string; value: string }>;
    files: Array<{ name: string; fileName: string; dataUrl: string }>;
  };
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const pngData = `data:image/png;base64,${png}`;
const webpData = 'data:image/webp;base64,UklGRgAAAABXRUJQ';
const base: ImageApiConfig = {
  enabled: true, backend: 'openai', baseUrl: 'https://images.example.invalid/v1/images/generations',
  apiKey: '', model: 'compatible-image-model',
};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let responder: (payload: HttpPayload) => Promise<{ status: number; body: string }>;
let calls: HttpPayload[] = [];
const resetResponder = (response?: (payload: HttpPayload) => Promise<{ status: number; body: string }>) => {
  calls = [];
  responder = response || (async () => ({ status: 200, body: JSON.stringify({ data: [{ b64_json: png }] }) }));
};
Object.defineProperty(globalThis, 'window', {
  configurable: true, writable: true,
  value: { lianhuaDesktop: { request: async (payload: HttpPayload) => { calls.push(payload); return responder(payload); } } },
});
globalThis.fetch = async () => { throw new Error('Transport regression tests must never reach the network.'); };

try {
  resetResponder();
  const options = {
    prompt: '当前镜头：阿莲沿青石路前行', width: 2048, height: 1152,
    referenceImages: [webpData, pngData], primaryReferenceImageCount: 2, preserveReferenceImageOrder: true,
  };
  const generated = await requestImageModel(base, options);
  assert.equal(generated.dataUrl, pngData);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://images.example.invalid/v1/images/edits');
  assert.equal(calls[0].body, undefined, 'real files use multipart, not JSON-only text prompts');
  assert.deepEqual(calls[0].multipart?.files, [
    { name: 'image[]', fileName: 'reference-1.webp', dataUrl: webpData },
    { name: 'image[]', fileName: 'reference-2.png', dataUrl: pngData },
  ]);
  assert.deepEqual(calls[0].multipart?.fields, [
    { name: 'model', value: base.model }, { name: 'prompt', value: options.prompt }, { name: 'size', value: '2048x1152' },
  ]);

  resetResponder();
  await requestImageModel(base, { ...options, referenceImages: [pngData, pngData] });
  assert.equal(calls[0].multipart?.files.length, 2, 'separately selected identical images still occupy two explicit input slots');
  resetResponder();
  await requestImageModel(base, { ...options, referenceImages: [pngData, pngData], preserveReferenceImageOrder: false });
  assert.equal(calls[0].multipart?.files.length, 1, 'legacy callers retain their existing pixel de-duplication behavior');

  resetResponder(async () => ({ status: 400, body: JSON.stringify({ error: { message: 'Image edits are not supported by this model.' } }) }));
  await assert.rejects(requestImageModel(base, options), /not supported/u);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((call) => call.url.endsWith('/images/edits')), 'failed edits must not retry through text-to-image');

  const sd: ImageApiConfig = { ...base, backend: 'sd_webui', baseUrl: 'https://sd.example.invalid/sdapi/v1/txt2img', model: '' };
  resetResponder(async () => ({ status: 200, body: JSON.stringify({ images: [png] }) }));
  assertDirectStoryboardImageApiSupport(sd, 1);
  await requestImageModel(sd, { ...options, referenceImages: [pngData], primaryReferenceImageCount: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sd.example.invalid/sdapi/v1/img2img');
  const sdBody = JSON.parse(calls[0].body || '{}');
  assert.deepEqual(sdBody.init_images, [pngData]);
  assert.deepEqual([sdBody.width, sdBody.height, sdBody.prompt], [2048, 1152, options.prompt]);
  assert.throws(() => assertDirectStoryboardImageApiSupport(sd, 2), /只支持一张/u);

  const novelai: ImageApiConfig = { ...base, backend: 'novelai', baseUrl: 'https://novelai.example.invalid', model: 'nai-diffusion-4-5-full' };
  resetResponder();
  assert.throws(() => assertDirectStoryboardImageApiSupport(novelai, 1), /不会退回文生图/u);
  await assert.rejects(requestImageModel(novelai, { ...options, referenceImages: [pngData] }), /参考图不会被静默忽略/u);
  assert.equal(calls.length, 0, 'unsupported NovelAI reference requests do not make a billable fallback call');

  const workflow = {
    text: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
    first: { class_type: 'LoadImage', inputs: { image: '__REFERENCE_IMAGE_1__' } },
    second: { class_type: 'LoadImage', inputs: { image: '__REFERENCE_IMAGE_2__' } },
    adapter: { class_type: 'IPAdapterAdvanced', inputs: { image: ['first', 0], image2: ['second', 0] } },
    sampler: { class_type: 'KSampler', inputs: { model: ['adapter', 0], positive: ['text', 0] } },
    output: { class_type: 'SaveImage', inputs: { images: ['sampler', 0] } },
  };
  const comfyRoot = 'https://comfy.example.invalid';
  const comfy: ImageApiConfig = { ...base, backend: 'comfyui', baseUrl: comfyRoot, model: '', workflowJson: JSON.stringify(workflow) };
  const uploadedNames: string[] = [];
  resetResponder(async (payload) => {
    if (payload.url === `${comfyRoot}/upload/image`) {
      const fileName = payload.multipart?.files[0].fileName;
      assert.ok(fileName, 'Comfy upload must carry a real image file');
      uploadedNames.push(fileName);
      return { status: 200, body: JSON.stringify({ name: fileName, subfolder: 'lianhua-references', type: 'input' }) };
    }
    if (payload.url === `${comfyRoot}/prompt`) return { status: 200, body: JSON.stringify({ prompt_id: 'test-current' }) };
    if (payload.url === `${comfyRoot}/history/test-current`) return { status: 200, body: JSON.stringify({
      'test-current': { status: { completed: true, status_str: 'success' }, outputs: {
        output: { images: [{ filename: 'generated.png', subfolder: '', type: 'output' }] },
      } },
    }) };
    throw new Error(`Unexpected mocked request: ${payload.url}`);
  });
  assertDirectStoryboardImageApiSupport(comfy, 2);
  const comfyResult = await requestImageModel(comfy, options);
  assert.equal(calls.filter((call) => call.url.endsWith('/upload/image')).length, 2);
  const uploads = calls.filter((call) => call.url.endsWith('/upload/image'));
  assert.deepEqual(uploads.map((call) => call.multipart?.files[0].dataUrl), [webpData, pngData]);
  const submitted = JSON.parse(calls.find((call) => call.url.endsWith('/prompt'))?.body || '{}').prompt;
  assert.equal(submitted.first.inputs.image, `lianhua-references/${uploads[0].multipart?.files[0].fileName}`);
  assert.equal(submitted.second.inputs.image, `lianhua-references/${uploads[1].multipart?.files[0].fileName}`);
  assert.equal(submitted.text.inputs.text, options.prompt);
  assert.match(comfyResult.url || '', /\/view\?filename=generated.png/u);

  // Same pixels produce the same content-addressed server filename. Distinct
  // asset slots must remain present through the *second* filename binding pass.
  calls = [];
  await requestImageModel(comfy, { ...options, referenceImages: [pngData, pngData] });
  assert.equal(calls.filter((call) => call.url.endsWith('/upload/image')).length, 2);
  const identicalSubmitted = JSON.parse(calls.find((call) => call.url.endsWith('/prompt'))?.body || '{}').prompt;
  assert.equal(identicalSubmitted.first.inputs.image, identicalSubmitted.second.inputs.image);
  assert.match(identicalSubmitted.first.inputs.image, /^lianhua-references\/lianhua-reference-/u);
  assert.throws(() => bindComfyUIReferenceImagesWithResult(workflow, ['same.png', 'same.png'], { primaryReferenceImageCount: 2 }),
    /主参考图数量与实际图片数量不一致/u, 'existing non-direct Comfy callers retain their former behavior');

  const incapable = { ...comfy, workflowJson: JSON.stringify({
    text: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
    output: { class_type: 'SaveImage', inputs: { images: ['text', 0] } },
  }) };
  calls = [];
  await assert.rejects(requestImageModel(incapable, options), /没有连接到输出/u);
  assert.equal(calls.length, 0, 'Comfy validates every required input before uploading or generating');

  // Browser transport also encodes actual bytes as file parts; a data URL in
  // plain prompt prose is insufficient. No HTTP request leaves this process.
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {} });
  let browserCalls = 0;
  globalThis.fetch = async (input, init) => {
    browserCalls += 1;
    assert.equal(String(input), 'https://images.example.invalid/v1/images/edits');
    assert.ok(init?.body instanceof FormData);
    const files = init.body.getAll('image[]');
    assert.equal(files.length, 2);
    for (const file of files) {
      assert.ok(file instanceof Blob);
      assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), png);
    }
    return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await requestImageModel(base, { ...options, referenceImages: [pngData, pngData] });
  assert.equal(browserCalls, 1);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}

console.log('Storyboard image-to-image transport passed: real OpenAI edits files, SD img2img, all Comfy slots, no NovelAI fallback, duplicate-pixel order preserved.');

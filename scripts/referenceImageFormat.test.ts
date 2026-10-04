import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { normalizeReferenceImageDataUrl, referenceImageFileName, referenceImageMimeType } from '../src/imageReferenceData';
import { requestImageModel, type ImageGenerationOptions } from '../src/services/llm';
import type { ImageApiConfig } from '../src/types';

const samples = JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8')) as Record<string, string>;
const { buildImageEditMultipart } = createRequire(import.meta.url)('../electron/imageReferenceTransport.cjs');
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const config: ImageApiConfig = { enabled: true, backend: 'openai', baseUrl: 'https://reference-format.invalid/v1', apiKey: 'mock-token', model: 'mock-image-model' };
type MultipartFile = { name: string; fileName: string; dataUrl: string };
type DesktopRequest = { url: string; body?: string; headers?: Record<string, string>; multipart?: { files: MultipartFile[]; fields: { name: string; value: string }[] } };
const bytes = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
const canonical = (format: string) => `data:image/${format};base64,${samples[format]}`;
const legacyAssets = [
  { id: 'old-png', fileName: 'incorrect.jpg', mimeType: 'image/jpeg', imageDataUrl: `data:image/jpeg;base64,${samples.png}` },
  { id: 'old-jpeg', fileName: 'incorrect.png', mimeType: 'image/png', imageDataUrl: `data:image/png;base64,${samples.jpeg}` },
  { id: 'old-webp', fileName: 'incorrect.jpg', mimeType: 'image/jpg', imageDataUrl: `data:image/jpg;base64,${samples.webp}` },
];
const legacySnapshot = structuredClone(legacyAssets);
const references = legacyAssets.map((asset) => asset.imageDataUrl);
const normalized = ['png', 'jpeg', 'webp'].map(canonical);
const options: ImageGenerationOptions = {
  prompt: 'A solid blue square on a plain background.', negativePrompt: 'compression artifacts',
  referenceImages: references, preserveReferenceImageOrder: true,
  width: 1536, height: 1024, sizeOverride: true, seed: 98765,
};
let requestCount = 0;
const installDesktop = (request: (value: DesktopRequest) => Promise<{ status: number; body: string }>) => {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: { request: async (value: DesktopRequest) => { requestCount += 1; return request(value); } } } });
};
globalThis.fetch = async () => { throw new Error('Live network forbidden in reference-format tests'); };
try {
  // MIME labels, extensions and supported aliases never supersede real bytes.
  for (const variant of ['png', 'jpeg', 'webp', 'webpLossless', 'webpExtended']) {
    const format = variant.startsWith('webp') ? 'webp' : variant;
    for (const label of ['image/png', 'image/jpeg', 'image/jpg', 'image/x-webp', 'application/octet-stream']) {
      const result = normalizeReferenceImageDataUrl(`data:${label};base64,${samples[variant]}`);
      assert.equal(referenceImageMimeType(result), `image/${format}`);
      assert.deepEqual(bytes(result), Buffer.from(samples[variant], 'base64'), 'normalization only changes the envelope');
      assert.equal(referenceImageFileName('old.incorrect.jpg', result), `old.incorrect.${format === 'jpeg' ? 'jpg' : format}`);
      assert.equal(normalizeReferenceImageDataUrl(result), result, 'canonical image data is stable');
    }
  }
  for (const invalid of ['', samples.png, 'https://fixture.invalid/image.png', 'data:image/png;base64,', 'data:image/png;base64,%%%%', 'data:image/png;base64,aGVsbG8=', 'data:image/gif;base64,R0lGODlh']) {
    assert.throws(() => normalizeReferenceImageDataUrl(invalid), /参考图片|Base64/u);
  }
  const oversized = `data:image/png;base64,${'A'.repeat(Math.ceil((32 * 1024 * 1024 + 3) / 3) * 4)}`;
  assert.throws(() => normalizeReferenceImageDataUrl(oversized), /32 MB/u);
  assert.equal(referenceImageMimeType('data:image/jpg;base64,abc'), undefined, 'only normalized MIME is reported');

  installDesktop(async (payload) => {
    assert.equal(payload.url, `${config.baseUrl}/images/edits`);
    assert.equal(payload.headers?.Authorization, 'Bearer mock-token');
    assert.deepEqual(payload.multipart?.files.map((file) => file.dataUrl), normalized);
    assert.deepEqual(payload.multipart?.files.map((file) => file.fileName), ['reference-1.png', 'reference-2.jpg', 'reference-3.webp']);
    assert.deepEqual(payload.multipart?.fields, [
      { name: 'model', value: config.model }, { name: 'prompt', value: options.prompt }, { name: 'size', value: '1536x1024' },
    ]);
    const encoded = buildImageEditMultipart(payload.multipart);
    const positions = normalized.map((dataUrl) => encoded.body.indexOf(bytes(dataUrl)));
    assert.ok(positions[0] >= 0 && positions[1] > positions[0] && positions[2] > positions[1], 'native multipart retains full image bytes in the original order');
    return { status: 200, body: JSON.stringify({ data: [{ b64_json: samples.png }] }) };
  });
  assert.equal((await requestImageModel(config, options)).dataUrl, canonical('png'));
  assert.deepEqual(legacyAssets, legacySnapshot, 'repair must not rewrite existing asset metadata or data');
  assert.deepEqual(options.referenceImages, references);

  installDesktop(async (payload) => {
    assert.equal(payload.url, 'https://reference-format.invalid/v1/sdapi/v1/img2img');
    const body = JSON.parse(payload.body || '{}');
    assert.deepEqual(body.init_images, normalized);
    assert.equal(body.prompt, options.prompt);
    assert.equal(body.negative_prompt, options.negativePrompt);
    assert.equal(body.width, options.width);
    assert.equal(body.height, options.height);
    assert.equal(body.seed, options.seed);
    return { status: 200, body: JSON.stringify({ images: [samples.png] }) };
  });
  await requestImageModel({ ...config, backend: 'sd_webui' }, options);

  // The browser transport must use canonical Blob types and matching filenames.
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: undefined });
  globalThis.fetch = async (input, init) => {
    requestCount += 1;
    assert.equal(String(input), `${config.baseUrl}/images/edits`);
    assert.ok(init?.body instanceof FormData);
    const fields = init.body as FormData;
    assert.equal(fields.get('prompt'), options.prompt);
    assert.equal(fields.get('size'), '1536x1024');
    const files = fields.getAll('image[]') as File[];
    assert.equal(files.length, 3);
    for (const [index, file] of files.entries()) {
      assert.equal(file.type, ['image/png', 'image/jpeg', 'image/webp'][index]);
      assert.equal(file.name, ['reference-1.png', 'reference-2.jpg', 'reference-3.webp'][index]);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes(normalized[index]));
    }
    return new Response(JSON.stringify({ data: [{ b64_json: samples.png }] }), { status: 200 });
  };
  await requestImageModel(config, options);
  globalThis.fetch = async () => { throw new Error('Live network forbidden in reference-format tests'); };

  // Explicit equal-pixel slots retain their count; ordinary callers retain
  // their existing exact-input deduplication behavior.
  for (const preserve of [true, false]) {
    installDesktop(async (payload) => {
      assert.equal(payload.multipart?.files.length, preserve ? 3 : 2);
      assert.deepEqual(payload.multipart?.files.map((file) => file.dataUrl), preserve ? [normalized[0], normalized[0], normalized[1]] : [normalized[0], normalized[1]]);
      return { status: 200, body: JSON.stringify({ data: [{ b64_json: samples.png }] }) };
    });
    await requestImageModel(config, { ...options, preserveReferenceImageOrder: preserve, referenceImages: [references[0], references[0], references[1]] });
  }

  const workflow = {
    text: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
    negative: { class_type: 'CLIPTextEncode', inputs: { text: '__NEGATIVE_PROMPT__' } },
    first: { class_type: 'LoadImage', inputs: { image: '__REFERENCE_IMAGE_1__' } },
    second: { class_type: 'LoadImage', inputs: { image: '__REFERENCE_IMAGE_2__' } },
    adapter: { class_type: 'IPAdapterAdvanced', inputs: { image: ['first', 0], image2: ['second', 0] } },
    sampler: { class_type: 'KSampler', inputs: { model: ['adapter', 0], positive: ['text', 0], negative: ['negative', 0] } },
    output: { class_type: 'SaveImage', inputs: { images: ['sampler', 0] } },
  };
  const uploads: MultipartFile[] = [];
  const comfyRoot = 'https://mock-comfy.invalid';
  installDesktop(async (payload) => {
    if (payload.url === `${comfyRoot}/upload/image`) {
      const file = payload.multipart!.files[0];
      uploads.push(file);
      assert.equal(referenceImageMimeType(file.dataUrl), uploads.length === 1 ? 'image/png' : 'image/jpeg');
      assert.match(file.fileName, uploads.length === 1 ? /\.png$/u : /\.jpg$/u);
      buildImageEditMultipart(payload.multipart);
      return { status: 200, body: JSON.stringify({ name: file.fileName, subfolder: 'lianhua-references', type: 'input' }) };
    }
    if (payload.url === `${comfyRoot}/prompt`) {
      const sent = JSON.parse(payload.body || '{}').prompt;
      assert.equal(sent.text.inputs.text, options.prompt);
      assert.equal(sent.negative.inputs.text, options.negativePrompt);
      assert.equal(sent.first.inputs.image, `lianhua-references/${uploads[0].fileName}`);
      assert.equal(sent.second.inputs.image, `lianhua-references/${uploads[1].fileName}`);
      return { status: 200, body: JSON.stringify({ prompt_id: 'format-fixture' }) };
    }
    assert.equal(payload.url, `${comfyRoot}/history/format-fixture`);
    return { status: 200, body: JSON.stringify({ 'format-fixture': { status: { completed: true, status_str: 'success' }, outputs: { output: { images: [{ filename: 'generated.png', subfolder: '', type: 'output' }] } } } }) };
  });
  await requestImageModel({ ...config, backend: 'comfyui', baseUrl: comfyRoot, workflowJson: JSON.stringify(workflow) }, {
    ...options, sizeOverride: false, referenceImages: references.slice(0, 2), primaryReferenceImageCount: 2,
  });
  assert.deepEqual(uploads.map((file) => file.dataUrl), normalized.slice(0, 2));
  assert.deepEqual(legacyAssets, legacySnapshot);

  let submittedInvalid = false;
  installDesktop(async () => { submittedInvalid = true; throw new Error('invalid image unexpectedly submitted'); });
  await assert.rejects(() => requestImageModel(config, { ...options, referenceImages: ['data:image/png;base64,aGVsbG8='] }), /参考图片/u);
  assert.equal(submittedInvalid, false, 'unknown bytes must fail before a billable request');
} finally {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log(`Reference image format tests passed (${requestCount} mock requests, zero real API calls): PNG/JPEG/WebP aliases, exact bytes/order/count, browser/native/SD/Comfy transports, unchanged old assets and invalid-input rejection.`);

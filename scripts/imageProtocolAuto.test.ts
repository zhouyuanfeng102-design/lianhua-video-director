import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureImageApiSnapshot, normalizeImageApiSnapshot, resolveImageApiForRegeneration } from '../src/imageApiSelection';
import { inspectImageProtocol, resolveImageProtocol, type ResolvedImageProtocol } from '../src/imageProtocol';
import { resolveImageResolution, resolveImageResolutionCapabilities } from '../src/imageResolution';
import { createImageGenerationTask } from '../src/generationTasks';
import { requestImageModel } from '../src/services/llm';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { ImageApiConfig, ImageApiExecutionSnapshot } from '../src/types';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const firstReference = `data:image/png;base64,${png}`;
const secondReference = 'data:image/webp;base64,UklGRgAAAABXRUJQ';
const references = [firstReference, secondReference, firstReference];
const model = '[Billing]gemini-3.1-flash-image-preview';
const api = (overrides: Partial<ImageApiConfig> = {}): ImageApiConfig => ({ enabled: true, backend: 'openai',
  baseUrl: 'https://relay.example.invalid/v1?fixture=1', apiKey: 'fixture-auto-secret', model, ...overrides });
let groups = 0;

for (const imageProtocol of [undefined, 'auto', 'openai-compatible'] as const) {
  const config = api({ imageProtocol });
  assert.equal(resolveImageProtocol(config), 'openai-chat');
  assert.equal(inspectImageProtocol(config).automatic, true);
  assert.equal(resolveImageResolutionCapabilities(config).protocol, 'openai-chat');
  assert.equal(config.model, model, 'inference does not rename a relay billing alias');
}
groups++;

const inferenceCases: Array<[Partial<ImageApiConfig>, ResolvedImageProtocol]> = [
  [{ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-flash-image-preview' }, 'gemini'],
  [{ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash-image' }, 'openai-compatible'],
  [{ baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2' }, 'openai-images'],
  [{ baseUrl: 'https://api.x.ai/v1', model: 'grok-imagine-image' }, 'xai'],
  [{ baseUrl: 'https://relay.example.invalid/v1/chat/completions?fixture=1', model: 'private-alias' }, 'openai-chat'],
  [{ baseUrl: 'https://relay.example.invalid/v1beta/models/private-model:generateContent?fixture=1', model: 'private-model' }, 'gemini'],
  [{ baseUrl: 'https://relay.example.invalid/v1beta/models', model: 'private-model' }, 'gemini'],
  [{ baseUrl: 'https://relay.example.invalid/v1beta', model: 'gemini-3.1-flash-image-preview' }, 'gemini'],
  [{ baseUrl: 'https://relay.example.invalid/v1/images/generations', model }, 'openai-compatible'],
  [{ baseUrl: 'https://relay.example.invalid/v1/images/edits', model }, 'openai-compatible'],
  [{ model: 'gpt-image-2.5-sunburst' }, 'openai-compatible'],
  [{ model: 'unknown-image-alias' }, 'openai-compatible'],
  [{ model: '[Billing]nano-banana-pro' }, 'openai-chat'],
  [{ baseUrl: 'https://generativelanguage.googleapis.com.relay.example.invalid/v1', model }, 'openai-chat'],
  [{ baseUrl: 'not-a-url', model: 'private-alias' }, 'openai-compatible'],
  [{ backend: 'sd_webui', imageProtocol: 'auto' }, 'openai-compatible'],
  [{ backend: 'comfyui', imageProtocol: 'gemini' }, 'openai-compatible'],
];
for (const [config, expected] of inferenceCases) assert.equal(resolveImageProtocol(api(config)), expected);
groups++;

for (const imageProtocol of ['openai-images', 'openai-chat', 'gemini', 'xai'] as const) {
  const config = api({ baseUrl: 'https://api.openai.com/v1', imageProtocol });
  assert.equal(resolveImageProtocol(config), imageProtocol);
  assert.equal(inspectImageProtocol(config).automatic, false);
}
assert.equal(resolveImageProtocol(api({ imageProtocol: 'openai-compatible-manual' })), 'openai-compatible');
assert.equal(resolveImageProtocol(api({ imageProtocol: 'auto', imageProtocolRuntime: 'openai-compatible' })), 'openai-compatible');
groups++;

type Request = { url: string; headers: Record<string, string>; body?: string;
  multipart?: { fields: Array<{ name: string; value: string }>; files: Array<{ dataUrl: string }> } };
const requests: Request[] = [];
let failed = false;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Live network forbidden in automatic image protocol tests'); };
Object.defineProperty(globalThis, 'window', { configurable: true, value: { lianhuaDesktop: {
  request: async (request: Request) => {
    requests.push(request);
    if (failed) return { status: 500, body: JSON.stringify({ error: { message: 'fixture provider failure' } }) };
    const body = /\/chat\/completions(?:\?|$)/u.test(request.url)
      ? { choices: [{ message: { content: firstReference } }] }
      : /:generateContent(?:\?|$)/u.test(request.url)
        ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] }
        : { data: [{ b64_json: png }] };
    return { status: 200, body: JSON.stringify(body) };
  },
} } });
const submit = async (config: ImageApiConfig, referenceImages: string[] = []): Promise<Request> => {
  const before = requests.length;
  const resolution = resolveImageResolution({ tier: '2K', logicalAspectRatio: '3:2', config });
  assert.equal(resolution.issue, '');
  const result = await requestImageModel(config, { prompt: 'Neutral characters facing each other.\nKeep the complete second line.',
    width: resolution.width, height: resolution.height, sizeOverride: true, resolutionPlan: resolution.resolutionPlan,
    referenceImages, preserveReferenceImageOrder: true });
  assert.equal(result.dataUrl, firstReference);
  assert.equal(requests.length, before + 1, 'one requested image sends exactly one generation request');
  return requests.at(-1)!;
};
try {
  const chatRequest = await submit(api({ imageProtocol: 'auto' }), references);
  assert.equal(chatRequest.url, 'https://relay.example.invalid/v1/chat/completions?fixture=1');
  assert.equal(chatRequest.headers.Authorization, 'Bearer fixture-auto-secret');
  assert.equal(chatRequest.headers['x-goog-api-key'], undefined);
  const chatBody = JSON.parse(chatRequest.body!);
  assert.equal(chatBody.model, model);
  assert.match(chatBody.messages[0].content[0].text, /Keep the complete second line\./u);
  assert.deepEqual(chatBody.messages[0].content.slice(1).map((part: any) => part.image_url.url), references);
  assert.deepEqual(chatBody.image_config, { aspect_ratio: '3:2', image_size: '2K' });
  assert.equal(chatRequest.multipart, undefined);
  groups++;

  const native = await submit(api({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.1-flash-image-preview', imageProtocol: 'auto' }), references);
  assert.equal(native.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent');
  assert.equal(native.headers['x-goog-api-key'], 'fixture-auto-secret');
  assert.equal(native.headers.Authorization, undefined);
  const nativeBody = JSON.parse(native.body!);
  assert.deepEqual(nativeBody.contents[0].parts.slice(1).map((part: any) => `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`), references);
  assert.deepEqual(nativeBody.generationConfig.imageConfig, { aspectRatio: '3:2', imageSize: '2K' });
  groups++;

  const official = await submit(api({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', imageProtocol: 'auto' }));
  assert.equal(official.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(JSON.parse(official.body!).response_format, undefined);
  assert.equal(JSON.parse(official.body!).model, 'gpt-image-2');
  const xai = await submit(api({ baseUrl: 'https://api.x.ai/v1', model: 'grok-imagine-image', imageProtocol: 'auto' }), references);
  assert.equal(xai.url, 'https://api.x.ai/v1/images/edits');
  assert.equal(xai.multipart, undefined);
  assert.equal(JSON.parse(xai.body!).resolution, '2k');
  assert.deepEqual(JSON.parse(xai.body!).images.map((item: any) => item.url), references);
  groups++;

  const defaultRequest = await submit(api({ model: 'gpt-image-2.5-sunburst' }), references);
  assert.equal(defaultRequest.url, 'https://relay.example.invalid/v1/images/edits?fixture=1');
  assert.deepEqual(defaultRequest.multipart?.files.map((part) => part.dataUrl), references);
  const manual = await submit(api({ imageProtocol: 'openai-compatible-manual' }));
  assert.equal(manual.url, 'https://relay.example.invalid/v1/images/generations?fixture=1');
  assert.equal(JSON.parse(manual.body!).response_format, 'b64_json');
  const explicitEndpoint = await submit(api({ baseUrl: 'https://relay.example.invalid/v1/images/generations?fixture=1', imageProtocol: 'auto' }));
  assert.equal(explicitEndpoint.url, 'https://relay.example.invalid/v1/images/generations?fixture=1');
  groups++;

  failed = true;
  const beforeFailure = requests.length;
  await assert.rejects(() => requestImageModel(api({ imageProtocol: 'auto' }), 'Neutral request'), /500/u);
  assert.equal(requests.length, beforeFailure + 1, 'provider failures do not probe or retry another protocol/model');
  assert.equal(JSON.parse(requests.at(-1)!.body!).model, model);
  failed = false;
  groups++;

  const initial = createInitialState();
  // Task capture normally receives an already-normalized configuration from
  // the workbench. Include its established defaults in this storage fixture.
  const config = normalizeState({ settings: { imageApi: api({ imageProtocol: 'auto' }), imageApiProfiles: [] } }).settings.imageApi;
  initial.settings.imageApi = config;
  initial.settings.imageApiProfiles = [{ ...config, id: 'auto-profile', name: 'Auto fixture', createdAt: 1, updatedAt: 1 }];
  initial.settings.activeImageApiProfileId = 'auto-profile';
  const snapshot = await captureImageApiSnapshot(config, 'auto-profile');
  assert.equal(snapshot.resolvedImageProtocol, 'openai-chat');
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-auto-secret|example\.invalid|apiKey|baseUrl/u);
  initial.project.generationTasks = [createImageGenerationTask({ id: 'auto-task', name: 'Auto fixture', assetKind: 'character',
    imageVariant: 'five-view', backend: 'openai', model, prompt: 'Neutral fixture', width: 2528, height: 1696,
    imageApiSnapshot: snapshot }, 1, 'completed')];
  initial.projects = [initial.project];
  initial.settings.imageApi = { ...config, imageProtocolRuntime: 'openai-compatible' };
  initial.settings.imageApiProfiles[0] = { ...initial.settings.imageApiProfiles[0], imageProtocolRuntime: 'openai-compatible' };
  const serialized = serializeStateForStorage(initial).serialized;
  assert.equal(serialized.includes('imageProtocolRuntime'), false);
  assert.equal(initial.settings.imageApi.imageProtocolRuntime, 'openai-compatible', 'serialization does not mutate the in-memory source');
  const restored = normalizeState(JSON.parse(serialized));
  assert.equal(restored.settings.imageApi.imageProtocol, 'auto');
  assert.equal(restored.settings.imageApiProfiles[0].imageProtocol, 'auto');
  assert.equal(restored.settings.imageApi.imageProtocolRuntime, undefined);
  assert.equal(restored.settings.imageApiProfiles[0].imageProtocolRuntime, undefined);
  assert.deepEqual(restored.project.generationTasks[0].imageApiSnapshot, snapshot);
  const directRestored = normalizeState(initial);
  assert.equal(directRestored.settings.imageApi.imageProtocolRuntime, undefined);
  assert.equal(directRestored.settings.imageApiProfiles[0].imageProtocolRuntime, undefined);
  assert.equal((await captureImageApiSnapshot(initial.settings.imageApi, null)).executionFingerprint,
    (await captureImageApiSnapshot(config, null)).executionFingerprint, 'runtime routing pin is not a persisted execution option');
  groups++;

  const newSettings = { ...restored.settings, imageApiProfiles: [{ ...restored.settings.imageApiProfiles[0],
    model: 'gpt-image-2.5-sunburst', apiKey: 'fixture-rotated-secret' }] };
  const retry = await resolveImageApiForRegeneration(newSettings, snapshot);
  assert.equal(retry.model, model, 'retry keeps the original model even after profile model selection changes');
  assert.equal(retry.apiKey, 'fixture-rotated-secret');
  assert.equal(resolveImageProtocol(retry), 'openai-chat');
  const frozenDifferentRoute: ImageApiExecutionSnapshot = { ...snapshot, resolvedImageProtocol: 'openai-compatible' };
  const pinned = await resolveImageApiForRegeneration(newSettings, frozenDifferentRoute);
  assert.equal(pinned.imageProtocolRuntime, 'openai-compatible');
  assert.equal(resolveImageProtocol(pinned), 'openai-compatible');
  assert.equal((await submit(pinned)).url, 'https://relay.example.invalid/v1/images/generations?fixture=1');
  groups++;

  for (const imageProtocol of [undefined, 'openai-compatible', 'openai-chat', 'gemini', 'xai', 'openai-images'] as const) {
    const historicalConfig = api({ imageProtocol });
    const captured = await captureImageApiSnapshot(historicalConfig, null);
    const { resolvedImageProtocol: _resolved, ...historical } = captured;
    const historicalSettings = { ...restored.settings, imageApi: historicalConfig };
    const expected = imageProtocol || 'openai-compatible';
    assert.equal(resolveImageProtocol(await resolveImageApiForRegeneration(historicalSettings, historical)), expected);
    assert.equal(resolveImageProtocol(await resolveImageApiForRegeneration(historicalSettings)), expected,
      'older tasks without a snapshot keep the original request protocol');
    if (!imageProtocol) assert.equal(historical.executionFingerprint,
      createHash('sha256').update('{"backend":"openai"}').digest('hex'), 'pre-auto execution fingerprint remains byte-compatible');
  }
  const legacyConfig = api();
  const { resolvedImageProtocol: _resolved, ...historical } = await captureImageApiSnapshot(legacyConfig, null);
  const legacyRetry = await resolveImageApiForRegeneration({ ...restored.settings, imageApi: legacyConfig }, historical);
  assert.equal((await submit(legacyRetry, references)).url, 'https://relay.example.invalid/v1/images/edits?fixture=1');
  groups++;

  await assert.rejects(() => resolveImageApiForRegeneration({ ...restored.settings,
    imageApiProfiles: [{ ...restored.settings.imageApiProfiles[0], imageProtocol: 'openai-chat' }] }, snapshot), /执行参数/u);
  assert.equal(normalizeImageApiSnapshot({ ...snapshot, resolvedImageProtocol: 'auto' })?.config.enabled, false);
  assert.equal(normalizeImageApiSnapshot({ ...snapshot, resolvedImageProtocol: 'malformed' })?.config.enabled, false);
  groups++;
  console.log(`Image protocol automatic routing: ${groups} targeted groups passed; one mocked request per submission, zero live requests.`);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}

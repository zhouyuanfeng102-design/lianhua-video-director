import assert from 'node:assert/strict';
import { captureImageApiSnapshot, resolveImageApiForRegeneration } from '../src/imageApiSelection';
import { readGeminiChatImageOutput, resolveGeminiChatImageEndpoint } from '../src/geminiChatImage';
import { resolveImageResolution } from '../src/imageResolution';
import { requestImageModel } from '../src/services/llm';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { formatUserFacingError } from '../src/userFacingError';
import type { ImageApiConfig } from '../src/types';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const pixels = `data:image/png;base64,${png}`;
const secondPixels = `data:image/webp;base64,UklGRgAAAABXRUJQ`;
const model = '[Billing]gemini-3.1-flash-image-preview';
const chat: ImageApiConfig = { enabled: true, backend: 'openai', model, baseUrl: 'https://relay.example.invalid/v1?source=test',
  apiKey: 'fixture-chat-secret', imageProtocol: 'openai-chat' };
const plan = resolveImageResolution({ tier: '2K', logicalAspectRatio: '3:2', config: chat });
assert.equal(plan.issue, '');
assert.deepEqual(plan.resolutionPlan?.encoding, { kind: 'tier', value: '2K' });
assert.equal(plan.resolutionPlan?.verified, false);
let groups = 1;
for (const [base, endpoint] of [
  ['https://relay.example.invalid', 'https://relay.example.invalid/v1/chat/completions'],
  ['https://relay.example.invalid/v1/', 'https://relay.example.invalid/v1/chat/completions'],
  ['https://relay.example.invalid/v1/chat/completions?source=test', 'https://relay.example.invalid/v1/chat/completions?source=test'],
  ['https://relay.example.invalid/v1/images/generations?source=test', 'https://relay.example.invalid/v1/chat/completions?source=test'],
  ['https://relay.example.invalid/v1beta/openai', 'https://relay.example.invalid/v1beta/openai/chat/completions'],
] as const) assert.equal(resolveGeminiChatImageEndpoint(base), endpoint);
groups++;
const message = (content: unknown) => ({ choices: [{ message: { content } }] });
for (const payload of [
  { choices: [{ message: { images: [{ type: 'image_url', image_url: { url: pixels } }] } }] },
  message([{ type: 'image_url', image_url: { url: pixels } }]),
  message(`Here is the image: ![generated](${pixels})`),
  message(pixels),
  message([{ type: 'text', text: `Generated: ${pixels}` }]),
  { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] },
]) assert.deepEqual(readGeminiChatImageOutput(payload), { dataUrl: pixels });
groups++;
assert.deepEqual(readGeminiChatImageOutput(message('![generated](https://cdn.example.invalid/generated.png?token=fixture&x=2)')),
  { url: 'https://cdn.example.invalid/generated.png?token=fixture&x=2' });
groups++;
for (const payload of [
  message('Only a text description, no image.'), message(png),
  message('[documentation](https://docs.example.invalid/image)'),
  { choices: [{ message: { content: null, reasoning_content: pixels } }] },
  message([{ type: 'reasoning', text: pixels }, { type: 'text', thought: true, text: pixels }]),
  { candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: 'image/png', data: png } }] } }] },
]) assert.equal(readGeminiChatImageOutput(payload), undefined);
groups++;
assert.throws(() => readGeminiChatImageOutput(message('data:image/png;base64,not-an-image')), /生成图片/u);
groups++;

type Request = { url: string; headers: Record<string, string>; body?: string; multipart?: unknown };
const requests: Request[] = [];
let response = { status: 200, body: JSON.stringify(message(pixels)) };
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Live network forbidden in chat image transport tests'); };
Object.defineProperty(globalThis, 'window', { configurable: true, value: { lianhuaDesktop: {
  request: async (request: Request) => { requests.push(request); return response; },
} } });
try {
  const fullPrompt = '保持原提示词完整，包括人物、动作和布局。\n第二行不可截断。';
  const result = await requestImageModel(chat, { prompt: fullPrompt, width: plan.width, height: plan.height,
    sizeOverride: true, resolutionPlan: plan.resolutionPlan, referenceImages: [pixels, secondPixels, pixels], preserveReferenceImageOrder: true });
  assert.equal(result.dataUrl, pixels);
  assert.equal(requests.length, 1);
  const submitted = requests[0];
  assert.equal(submitted.url, 'https://relay.example.invalid/v1/chat/completions?source=test');
  assert.equal(submitted.headers.Authorization, 'Bearer fixture-chat-secret');
  assert.equal(submitted.headers['x-goog-api-key'], undefined);
  assert.equal(submitted.multipart, undefined);
  const body = JSON.parse(submitted.body!);
  assert.equal(body.model, model);
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].content[0].text, fullPrompt);
  assert.deepEqual(body.messages[0].content.slice(1).map((part: any) => part.image_url.url), [pixels, secondPixels, pixels]);
  assert.deepEqual(body.image_config, { aspect_ratio: '3:2', image_size: '2K' });
  assert.equal(body.size, undefined);
  groups++;

  const custom = resolveImageResolution({ tier: 'custom', logicalAspectRatio: '3:2', width: 3840, height: 2560, config: chat });
  assert.equal(custom.issue, '');
  assert.match(custom.warning || '', /画面要求.*实际像素/u);
  await requestImageModel(chat, { prompt: fullPrompt, width: custom.width, height: custom.height, sizeOverride: true, resolutionPlan: custom.resolutionPlan });
  const customBody = JSON.parse(requests.at(-1)!.body!);
  assert.match(customBody.messages[0].content[0].text, /Requested output canvas: 3840 × 2560 pixels/u);
  assert.deepEqual(customBody.image_config, { aspect_ratio: '3:2' });
  assert.equal(customBody.size, undefined);
  groups++;

  const beforeFailure = requests.length;
  response = { status: 500, body: JSON.stringify({ error: { message: 'not supported model for image generation, only imagen models are supported (request id: 202610101314274212272528268d9d6L6bj00mM)' } }) };
  await assert.rejects(() => requestImageModel(chat, '保持提示词'), (error: unknown) => {
    const visible = formatUserFacingError(error);
    assert.match(visible, /当前图片接口不支持该香蕉模型/u);
    assert.match(visible, /聊天生图兼容/u);
    assert.match(visible, /HTTP 500/u);
    assert.ok(!visible.includes('未识别'));
    return true;
  });
  assert.equal(requests.length, beforeFailure + 1, 'HTTP failure must never fan out to another model or protocol');
  groups++;
  response = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'No image.', reasoning_content: pixels } }] }) };
  const beforeEmpty = requests.length;
  await assert.rejects(() => requestImageModel(chat, '保持提示词'), /没有返回可用图片/u);
  assert.equal(requests.length, beforeEmpty + 1);
  groups++;

  const compatible = { ...chat, imageProtocol: 'openai-compatible' as const };
  response = { status: 200, body: JSON.stringify({ data: [{ b64_json: png }] }) };
  await requestImageModel(compatible, '历史文生图');
  assert.equal(requests.at(-1)!.url, 'https://relay.example.invalid/v1/images/generations?source=test');
  assert.equal(JSON.parse(requests.at(-1)!.body!).model, model);
  await requestImageModel(compatible, { prompt: '历史图生图', referenceImages: [pixels] });
  assert.equal(requests.at(-1)!.url, 'https://relay.example.invalid/v1/images/edits?source=test');
  assert.ok(requests.at(-1)!.multipart);
  groups++;

  const initial = createInitialState();
  initial.settings.imageApi = chat;
  const restored = normalizeState(JSON.parse(serializeStateForStorage(initial).serialized));
  assert.equal(restored.settings.imageApi.imageProtocol, 'openai-chat');
  assert.equal(restored.settings.imageApi.model, model);
  const snapshot = await captureImageApiSnapshot(restored.settings.imageApi, null);
  const resolved = await resolveImageApiForRegeneration(restored.settings, snapshot);
  assert.equal(resolved.imageProtocol, 'openai-chat');
  assert.equal(resolved.model, model);
  groups++;
  const historicalSnapshot = await captureImageApiSnapshot({ ...restored.settings.imageApi, imageProtocol: 'openai-compatible' }, null);
  await assert.rejects(() => resolveImageApiForRegeneration(restored.settings, historicalSnapshot), /执行参数.*改变/u);
  assert.equal(snapshot.config.model, model);
  assert.equal(JSON.stringify(snapshot).includes('fixture-chat-secret'), false);
  groups++;
  console.log(`Gemini chat image: ${groups} targeted groups passed; mock requests only, no live generation.`);
} finally {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}

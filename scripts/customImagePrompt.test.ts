import assert from 'node:assert/strict';
import { buildComfyUIWorkflow } from '../src/comfyui';
import { captureCustomImageRule, requestCustomImagePrompt } from '../src/customImagePrompt';
import { BUILT_IN_IMAGE_PROMPT_RULE_SETS, type ImagePromptRuleSet } from '../src/imagePromptRules';
import { requestImageModel } from '../src/services/llm';
import { MAESTRO_PROTOCOL_MARKER } from '../src/maestroProtocol';
import { LIANHUA_NSFW_CREATIVE_GUIDANCE, LIANHUA_NSFW_FIXED_PREFIX } from '../src/nsfwPromptRules';
import { IMAGE_STORY_SPATIAL_STATE_RULE } from '../src/spatialContinuityRules';
import type { ImageApiConfig, TextApiConfig } from '../src/types';

const imageApi: ImageApiConfig = {
  enabled: true, backend: 'openai', baseUrl: 'https://images.example.invalid/v1',
  apiKey: 'fixture-image-key', model: 'gpt-image-1', imageProtocol: 'openai-images',
};
const textApi: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://text.example.invalid/v1',
  apiKey: 'fixture-text-key', model: 'fixture-converter', temperature: 0.2, maxTokens: 1000, vision: false,
};
const userRule: ImagePromptRuleSet = {
  id: 'user-custom-rule', name: '我的自定义规则', backend: 'comfyui', format: 'natural-language',
  description: '', systemPrompt: 'SELECTED_CUSTOM_RULE: 采用用户明确指定的笔触。',
  outputRules: 'SELECTED_OUTPUT_RULE: 保持简洁的自然语言。', negativePrompt: 'selected-negative',
  categoryPresetIds: [], defaultPresetByAssetKind: {}, enabled: true, version: '2.0', updatedAt: 1,
};
const frozen = captureCustomImageRule([userRule], userRule.id, imageApi);
assert.equal(frozen.ruleVersion, '2.0');
assert.equal(frozen.systemPrompt, userRule.systemPrompt);
assert.equal(frozen.negativePrompt, 'selected-negative');
userRule.systemPrompt = 'edited-after-submission';
assert.match(frozen.systemPrompt, /SELECTED_CUSTOM_RULE/u, 'the frozen rule must survive catalog edits');
assert.equal(captureCustomImageRule(BUILT_IN_IMAGE_PROMPT_RULE_SETS,
  BUILT_IN_IMAGE_PROMPT_RULE_SETS[0].id, imageApi).id, BUILT_IN_IMAGE_PROMPT_RULE_SETS[0].id);
assert.throws(() => captureCustomImageRule([userRule], 'deleted-rule', imageApi), /不存在/u);
assert.throws(() => captureCustomImageRule([{ ...userRule, enabled: false }], userRule.id, imageApi), /禁用/u);
assert.throws(() => captureCustomImageRule([userRule], userRule.id, { ...imageApi, backend: 'novelai' }), /不兼容/u);
assert.equal(captureCustomImageRule([{ ...userRule, format: 'nai-tags' }], userRule.id,
  { ...imageApi, backend: 'novelai' }).format, 'nai-tags');

const authored = ' \n画一把木椅，文字中的 | 不代表角色分段。__WIDTH__\n采用水彩。 \t';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const pixels = `data:image/png;base64,${png}`;
type Request = {
  url: string; body?: string;
  multipart?: { fields: Array<{ name: string; value: string }>; files: Array<{ name: string; dataUrl: string }> };
};
type Reply = { status: number; body: string; bodyEncoding?: 'base64'; contentType?: string };
const requests: Request[] = [];
let reply: Reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'A watercolor wooden chair.' } }] }) };
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Live network forbidden in custom image tests'); };
Object.defineProperty(globalThis, 'window', { configurable: true, value: { lianhuaDesktop: {
  request: async (request: Request) => { requests.push(request); return reply; },
} } });

try {
  assert.equal(await requestCustomImagePrompt(textApi, { userPrompt: authored, rule: frozen, width: 1024, height: 1024 }),
    'A watercolor wooden chair.');
  assert.equal(requests.length, 1);
  const convertedRequest = JSON.parse(requests[0].body!);
  assert.deepEqual(convertedRequest.messages.map((message: { role: string }) => message.role), ['system', 'user']);
  assert.equal(convertedRequest.messages[1].content, authored, 'conversion receives the complete authored input');
  assert.match(convertedRequest.messages[0].content, /SELECTED_CUSTOM_RULE[\s\S]*SELECTED_OUTPUT_RULE[\s\S]*1024 × 1024/u);
  assert.doesNotMatch(convertedRequest.messages[0].content, /morphology|bodyPlan|image_prompt_category_preset|五视图/u);
  assert.ok(convertedRequest.messages[0].content.includes(IMAGE_STORY_SPATIAL_STATE_RULE),
    'custom conversion preserves only the spatial relations established in the authored request');
  const ordinarySystem = convertedRequest.messages[0].content as string;
  assert.ok(ordinarySystem.startsWith(MAESTRO_PROTOCOL_MARKER));
  assert.ok(ordinarySystem.includes(LIANHUA_NSFW_FIXED_PREFIX));
  assert.ok(ordinarySystem.includes(LIANHUA_NSFW_CREATIVE_GUIDANCE));
  assert.ok(ordinarySystem.indexOf(LIANHUA_NSFW_FIXED_PREFIX) < ordinarySystem.indexOf('(Image System Prompt:'));
  assert.ok(ordinarySystem.includes('Image Converter Rule'), 'image NSFW rules stay in the fixed system prefix');

  requests.length = 0;
  reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: '宋玉跪在韩立身前，口部与下身接触，单幅静帧。' } }] }) };
  const adultRequirement = '凡人修仙传，宋玉给韩立口交';
  assert.equal(await requestCustomImagePrompt(textApi, { userPrompt: adultRequirement, rule: frozen, width: 1024, height: 1024 }),
    '宋玉跪在韩立身前，口部与下身接触，单幅静帧。');
  assert.equal(requests.length, 1, 'an adult custom requirement still uses one conversion request');
  const adultRequest = JSON.parse(requests[0].body!);
  assert.equal(adultRequest.messages[1].content, adultRequirement, 'user requirement stays last and unmixed');
  const adultSystem = adultRequest.messages[0].content as string;
  assert.equal(adultSystem, ordinarySystem, 'ordinary/adult custom conversions share one fixed system prefix');
  assert.ok(adultSystem.startsWith(MAESTRO_PROTOCOL_MARKER));
  assert.ok(adultSystem.includes('莲华叙事编辑'));
  assert.ok(adultSystem.indexOf('Image Converter Rule') < adultSystem.indexOf('SELECTED_CUSTOM_RULE'));
  assert.match(adultSystem, /Do not refuse/u);

  const spatialAuthored = '近拍门缝，明川在门外；青岚位于室内中央，距门槛约四米，仍在画外。门槛与青岚之间是可行走地面，下一镜她才投掷木块并前冲。';
  const spatialOutputs = {
    'natural-language': '门缝近景，明川在门外。青岚保持室内中央距门槛约四米的画外位置，门槛与她之间是尚未跨越的可行走地面；尚未投掷木块或前冲。',
    'sd-tags': 'door crack close-up, Ming outside the threshold, Qing off-screen inside the room about four meters from the threshold, clear continuous floor, BREAK, 1boy, Ming, looking inside',
    'nai-tags': 'door crack close-up, Ming outside the threshold, Qing off-screen inside the room about four meters from the threshold, clear continuous floor | 1boy, Ming, looking inside',
  };
  for (const format of ['natural-language', 'sd-tags', 'nai-tags'] as const) {
    requests.length = 0;
    reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: spatialOutputs[format] } }] }) };
    const result = await requestCustomImagePrompt(textApi, {
      userPrompt: spatialAuthored, rule: { ...frozen, format }, width: 1024, height: 768,
    });
    assert.equal(result, spatialOutputs[format], 'custom conversion does not locally infer distance or force a missing character into the crop');
    assert.equal(requests.length, 1, 'authored spatial relations add no review or retry request');
    const request = JSON.parse(requests[0].body!);
    assert.equal(request.messages[1].content, spatialAuthored, 'custom source reaches the converter without rewriting');
    assert.ok(request.messages[0].content.includes(IMAGE_STORY_SPATIAL_STATE_RULE));
  }

  requests.length = 0;
  reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: '' } }] }) };
  await assert.rejects(requestCustomImagePrompt(textApi,
    { userPrompt: authored, rule: frozen, width: 1024, height: 768 }), /没有返回可用内容/u);
  assert.equal(requests.length, 1, 'conversion failure cannot retry or silently submit raw image generation');
  assert.ok(requests.every((request) => request.url.includes('text.example.invalid')));

  requests.length = 0;
  await assert.rejects(requestCustomImagePrompt({ ...textApi, enabled: false },
    { userPrompt: authored, rule: frozen, width: 1024, height: 768 }), /未启用/u);
  assert.equal(requests.length, 0);
  reply = { status: 400, body: JSON.stringify({ error: { message: 'fixture conversion failure' } }) };
  await assert.rejects(requestCustomImagePrompt(textApi,
    { userPrompt: authored, rule: frozen, width: 1024, height: 768 }), /fixture conversion failure/u);
  assert.equal(requests.length, 1, 'HTTP failure is surfaced after one conversion request');

  requests.length = 0;
  reply = { status: 200, body: JSON.stringify({ data: [{ b64_json: png }] }) };
  await requestImageModel(imageApi, { prompt: authored, promptMode: 'verbatim', negativePrompt: 'must-not-leak',
    width: 1024, height: 768, referenceImages: [pixels, pixels], primaryReferenceImageCount: 2,
    preserveReferenceImageOrder: true });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/images\/edits$/u);
  assert.equal(requests[0].multipart?.fields.find((field) => field.name === 'prompt')?.value, authored);
  assert.equal(requests[0].multipart?.fields.find((field) => field.name === 'size')?.value, '1024x768');
  assert.deepEqual(requests[0].multipart?.files.map((file) => file.dataUrl), [pixels, pixels]);
  assert.ok(!JSON.stringify(requests[0]).includes('must-not-leak'));

  requests.length = 0;
  reply = { status: 200, body: png, bodyEncoding: 'base64', contentType: 'image/png' };
  await requestImageModel({ ...imageApi, backend: 'novelai', model: 'nai-diffusion-4-5-full' },
    { prompt: authored, promptMode: 'verbatim', negativePrompt: 'must-not-leak', width: 1024, height: 768 });
  const naiRequest = JSON.parse(requests[0].body!);
  assert.equal(naiRequest.input, authored);
  assert.deepEqual(naiRequest.parameters.v4_prompt.caption, { base_caption: authored, char_captions: [] });
  assert.equal(naiRequest.parameters.negative_prompt, '');
  assert.equal(naiRequest.parameters.qualityToggle, false, 'raw mode disables provider automatic quality tags');

  requests.length = 0;
  reply = { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] }) };
  await requestImageModel({ ...imageApi, imageProtocol: 'gemini', model: 'gemini-3.1-flash-image-preview' },
    { prompt: authored, promptMode: 'verbatim', negativePrompt: 'must-not-leak', width: 1024, height: 768, sizeOverride: true });
  const native = JSON.parse(requests[0].body!);
  assert.equal(native.contents.length, 1);
  assert.equal(native.contents[0].parts[0].text, `${authored}\nRequested output canvas: 1024 × 768 pixels. Use this canvas and aspect ratio when supported.`);
  assert.ok(!requests[0].body?.includes('must-not-leak'));

  const workflow = JSON.stringify({
    1: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: '__NEGATIVE_PROMPT__' } },
    3: { class_type: 'EmptyLatentImage', inputs: { width: '__WIDTH__', height: '__HEIGHT__' } },
  });
  const directWorkflow = buildComfyUIWorkflow(workflow,
    { prompt: authored, promptMode: 'verbatim', negativePrompt: 'must-not-leak', width: 1024, height: 768 }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(directWorkflow[1].inputs.text, authored);
  assert.equal(directWorkflow[2].inputs.text, '');
  assert.equal(directWorkflow[3].inputs.width, 1024);
  const composedWorkflow = JSON.stringify({ 1: { class_type: 'CLIPTextEncode', inputs: { text: 'chosen prefix {{prompt}}' } } });
  const composed = buildComfyUIWorkflow(composedWorkflow,
    { prompt: authored, promptMode: 'verbatim', negativePrompt: 'must-not-leak', width: 1024, height: 768 }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(composed[1].inputs.text, `chosen prefix ${authored}`, 'template expansion cannot rewrite tokens inside the authored prompt');
  const legacy = buildComfyUIWorkflow(composedWorkflow,
    { prompt: ' padded ', negativePrompt: 'legacy negative', width: 1024, height: 768 }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(legacy[1].inputs.text, 'chosen prefix padded\nNegative prompt: legacy negative');
  console.log('Custom image prompt: targeted rule capture, conversion failures and verbatim transports passed; mock requests only.');
} finally {
  globalThis.fetch = originalFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
}

import assert from 'node:assert/strict';
import {
  buildImagePromptConverterSystemPrompt,
  IMAGE_PROMPT_PROPORTION_CONTRACT,
  IMAGE_PROMPT_VISIBLE_CHARACTER_IDENTITY_CONTRACT,
  resolveImagePromptSelection,
} from '../src/imagePromptRules';
import { requestImagePromptConverter } from '../src/services/llm';
import { DIRECTED_ACTION_RELATION_RULE, IMAGE_STORY_SPATIAL_STATE_RULE, STORYBOARD_FRAME_VISIBILITY_RULE } from '../src/spatialContinuityRules';
import type { TextApiConfig } from '../src/types';

// Only synthetic source and stubbed text transport. No image API, user data,
// semantic keyword validator, or extra model-review round is involved.
const selection = resolveImagePromptSelection({ backend: 'openai', assetKind: 'storyboard' });
const legacyPreset = {
  ...selection,
  preset: { ...selection.preset, outputRules: '完整主体优先，五官清晰，正面展示。' },
};
for (const format of ['natural-language', 'sd-tags', 'nai-tags'] as const) {
  const system = buildImagePromptConverterSystemPrompt({
    ...legacyPreset, ruleSet: { ...legacyPreset.ruleSet, format },
  });
  assert.ok(system.includes(STORYBOARD_FRAME_VISIBILITY_RULE));
  assert.ok(system.includes(IMAGE_STORY_SPATIAL_STATE_RULE), 'each output format keeps world distance before camera crop and identity detail');
  assert.ok(system.indexOf(STORYBOARD_FRAME_VISIBILITY_RULE) < system.indexOf(IMAGE_PROMPT_VISIBLE_CHARACTER_IDENTITY_CONTRACT),
    'the event, world, adopted camera and visible extent are established before identity expansion');
  assert.equal(system.split(STORYBOARD_FRAME_VISIBILITY_RULE).length - 1, 1);
  assert.equal(system.split(IMAGE_STORY_SPATIAL_STATE_RULE).length - 1, 1,
    'nested world/visibility contracts are supplied once for every output format');
  assert.match(STORYBOARD_FRAME_VISIBILITY_RULE, /首帧取进入状态，尾帧取行动产生的退出状态/u);
  assert.match(STORYBOARD_FRAME_VISIBILITY_RULE, /先描述当前可见面[\s\S]*从角色资料选入相应可见外貌/u);
  assert.match(STORYBOARD_FRAME_VISIBILITY_RULE, /主观视点/u);
  assert.match(STORYBOARD_FRAME_VISIBILITY_RULE, /回头[\s\S]*头身不同向/u);
}
assert.doesNotMatch(IMAGE_PROMPT_PROPORTION_CONTRACT, /构图以完整主体和自然留白为先/u);
assert.match(IMAGE_PROMPT_PROPORTION_CONTRACT, /局部特写沿用局部取景/u);
assert.match(IMAGE_PROMPT_VISIBLE_CHARACTER_IDENTITY_CONTRACT, /可见身份以当前景别、朝向、遮挡和裁切为边界/u);
assert.match(DIRECTED_ACTION_RELATION_RULE, /分别保留身体姿态、头部转角、视线落点和动作对象/u);
const characterSystem = buildImagePromptConverterSystemPrompt(
  resolveImagePromptSelection({ backend: 'openai', assetKind: 'character', imageVariant: 'full-body' }), '', 'full-body',
);
assert.equal(characterSystem.includes(STORYBOARD_FRAME_VISIBILITY_RULE), false,
  'ordinary identity sheets retain their explicitly selected camera and full-body layout');
assert.match(characterSystem, /必须执行全身构图合同/u);

const fixtures = [
  {
    source: '首帧先近拍微开的门缝与门外明川，寝宫内青岚距门槛约四米，明川到门槛的距离没有给出。随后后拉才揭示青岚的侧肩，再下一镜她才冲向明川；本张保持第一镜起始时刻。',
    result: '门缝近景，明川仍站在门外向内注视。青岚保持寝宫内距门槛约四米的画外位置，两者之间的连续室内地面尚未被跨越；起始裁切没有她的侧肩。',
  },
  {
    source: '越肩观察同一走廊，青岚在近处，明川位于走廊另一端、尚未进入短剑可及范围。原文未给米数；青岚尚未开始向明川接近，双方之间的通道没有被堵住。',
    result: '同一走廊的越肩画面，青岚位于近处，明川仍在走廊另一端、短剑可及范围之外；两人之间的通道保持可行进，尚未发生接近。',
  },
  {
    source: '两名成年战士在门廊对峙。摄影机在青岚左侧后方，青岚身体侧向明川，眼睛看明川的持刀手；刀横握尚未出招。',
    result: '门廊侧后方中景，青岚呈自然侧背面，躯干侧向画面右侧的明川，侧脸可见的一只眼注视明川持刀的手，刀横握在腰侧。明川位于门廊另一端。',
  },
  {
    source: '本镜由双人中景下移，最后时刻只拍青岚踏稳的靴子；明川在前方画外。',
    result: '结束时刻的低位战靴特写，青岚的靴底压住潮湿石砖，仅小腿、靴子和地面入画；明川保持前方画外，头部不在取景内。',
  },
  {
    source: '青岚向前走，头部自然回望身后的明川，躯干仍保持前行方向。摄影机在青岚左侧。',
    result: '侧面中景，青岚保持前行的躯干方向，头部自然回转看向后方明川，颈部与肩部连接自然；未把两人的位置或行进方向互换。',
  },
  {
    source: '明川的主观镜头，摄影机就是明川眼睛所在位置。青岚朝明川说话，看向镜头位置。',
    result: '明川的主观视角，青岚面向明川所在的摄影机位置，自然直视镜头说话，明川本人保持画外。',
  },
];
const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://framing.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-not-a-credential', model: 'framing-test-model', temperature: 0, maxTokens: 4096, vision: false,
};
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
let current = 0;
let calls = 0;
let networkAttempts = 0;
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  lianhuaDesktop: { request: async (payload: { body?: string }) => {
    calls += 1;
    const body = JSON.parse(payload.body || '{}');
    const system = body.messages.find((message: { role: string }) => message.role === 'system').content as string;
    const user = body.messages.find((message: { role: string }) => message.role === 'user').content as string;
    assert.ok(system.includes(STORYBOARD_FRAME_VISIBILITY_RULE));
    assert.ok(system.includes(DIRECTED_ACTION_RELATION_RULE));
    assert.ok(user.includes(fixtures[current].source));
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: fixtures[current].result } }] }) };
  } },
} });
globalThis.fetch = async () => { networkAttempts += 1; throw new Error('Live network forbidden'); };
try {
  for (current = 0; current < fixtures.length; current += 1) {
    const before = calls;
    const fixture = fixtures[current];
    const output = await requestImagePromptConverter(config, 'storyboard', fixture.source, 'natural-language',
      buildImagePromptConverterSystemPrompt(legacyPreset));
    assert.equal(output, fixture.result, 'AI-authored gaze/crop stays intact without local rewriting or veto');
    assert.equal(calls - before, 1, 'valid conversion uses one existing request, with no added semantic review');
  }
  assert.equal(networkAttempts, 0);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log('Storyboard gaze/framing: world-state-first contracts, all output formats, off-screen entry distance, late reveal, side/back view, final close-up, natural head turn, POV, and single-call transport passed.');

import assert from 'node:assert/strict';
import { requestStoryExpansion, requestStoryPreparationWithReview } from '../src/services/llm';
import { frameNsfwTextRequest, LIANHUA_NSFW_CREATIVE_GUIDANCE, NSFW_PROSE_JOINED_MOTION_RULE } from '../src/nsfwPromptRules';
import {
  defaultStoryExpansionPresets,
  LEGACY_STORY_EXPANSION_GENERAL_V1_5_0,
  normalizeState,
} from '../src/storage';
import { legacyStoryPreparationV130 } from './fixtures/storyPreparationLegacyPresets';
import { fixtureParagraphs, fixturePlan, readStoryVisualData, type CapturedStoryRequest } from './storyVisualTestFixtures';
import type { TextApiConfig } from '../src/types';

const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://api.example.test/v1/chat/completions',
  apiKey: 'test-key', model: 'test-model', temperature: 0.2, maxTokens: 4096, vision: false,
};

const capture = (content: string): CapturedStoryRequest[] => {
  const requests: CapturedStoryRequest[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: { body?: string }) => {
      const request = JSON.parse(payload.body || '{}') as CapturedStoryRequest;
      requests.push(request);
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
    } },
  } });
  return requests;
};

const joined = (request: CapturedStoryRequest): string => request.messages.map((message) => message.content).join('\n');

assert.match(LIANHUA_NSFW_CREATIVE_GUIDANCE, /跟这串缓慢起伏连在一起/u);
assert.doesNotMatch(LIANHUA_NSFW_CREATIVE_GUIDANCE, /跟这一下对齐/u);
assert.match(NSFW_PROSE_JOINED_MOTION_RULE, /甲的手握住乙的肉棒/u);
assert.match(NSFW_PROSE_JOINED_MOTION_RULE, /两套句子不并列/u);
assert.match(NSFW_PROSE_JOINED_MOTION_RULE, /起伏时胸口和髋朝向对方，头留在这侧胸口上/u);
assert.match(NSFW_PROSE_JOINED_MOTION_RULE, /不是成人情节时不使用这句/u);
assert.match(NSFW_PROSE_JOINED_MOTION_RULE, /拳脚、摔倒、撞门/u);

const expandFramed = frameNsfwTextRequest({
  stage: 'story-preparation', systemLayers: ['任务'], userPrompt: '正文', finalInstruction: '协议',
});
const visualFramed = frameNsfwTextRequest({
  stage: 'story-visual-writing', systemLayers: ['任务'], userPrompt: '正文', finalInstruction: '协议',
});
const ordinaryFramed = frameNsfwTextRequest({
  stage: 'story-preparation', systemLayers: ['任务'], userPrompt: '林舟推门', finalInstruction: '协议',
});
assert.equal(expandFramed.systemLayers[0], ordinaryFramed.systemLayers[0]);
assert.ok(expandFramed.systemLayers[0].includes(NSFW_PROSE_JOINED_MOTION_RULE));
assert.ok(visualFramed.systemLayers[0].includes(NSFW_PROSE_JOINED_MOTION_RULE));
assert.equal(visualFramed.systemLayers[0].includes('NSFW 视频动作细化规则'), false);
const director = frameNsfwTextRequest({
  stage: 'director-look', systemLayers: ['任务'], userPrompt: '正文', finalInstruction: '协议',
});
assert.equal(director.systemLayers[0].includes('甲的手握住乙的肉棒'), false);

const adultSource = '两名成年恋人回房后脱去衣物，全裸相拥，原文明确进入。';
const expandRequests = capture('扩写后的正文。');
await requestStoryExpansion(config, adultSource);
const expandPrompt = joined(expandRequests[0]);
assert.match(expandPrompt, /甲的手握住乙的肉棒/u);
assert.match(expandPrompt, /不另写一套加快或抽送/u);
assert.match(expandPrompt, /踢、扔、躲、挡/u);
assert.equal(expandPrompt.includes('NSFW 视频动作细化规则'), false);
const ordinaryRequests = capture('扩写后的正文。');
await requestStoryExpansion(config, '林澜推开门。');
assert.equal(
  ordinaryRequests[0].messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
  expandRequests[0].messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
);

const visualRequests: CapturedStoryRequest[] = [];
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  lianhuaDesktop: { request: async (payload: { body?: string }) => {
    const request = JSON.parse(payload.body || '{}') as CapturedStoryRequest;
    visualRequests.push(request);
    const data = readStoryVisualData(request);
    const content = data.stage === 'understanding' ? fixturePlan(data) : fixtureParagraphs(data, '林澜推开门，李云走进房间。');
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  } },
} });
await requestStoryPreparationWithReview(config, '林澜推开门，李云走进房间。');
assert.equal(visualRequests.length, 2);
const understanding = joined(visualRequests[0]);
const writing = joined(visualRequests[1]);
assert.equal(readStoryVisualData(visualRequests[0]).stage, 'understanding');
assert.equal(readStoryVisualData(visualRequests[1]).stage, 'visualizing');
for (const prompt of [understanding, writing]) {
  assert.match(prompt, /甲的手握住乙的肉棒/u);
  assert.match(prompt, /踢不能改为扔/u);
  assert.match(prompt, /保留细致动作与打斗/u);
  assert.equal(prompt.includes('NSFW 视频动作细化规则'), false);
}
assert.match(understanding, /不把这一条记成多次撞击/u);
assert.match(understanding, /evidence 仍逐字摘录原文/u);
assert.match(writing, /不把这一段写成每一击的执行路径/u);

const current = defaultStoryExpansionPresets[0];
assert.equal(current.version, '1.5.1');
assert.match(current.systemPrompt, /不按打斗的发力、路径和每一击展开/u);
assert.match(current.systemPrompt, /不补成一下一下的抽送/u);
const upgraded = normalizeState({ storyExpansionPresets: [{ ...LEGACY_STORY_EXPANSION_GENERAL_V1_5_0, updatedAt: 42 }] });
assert.equal(upgraded.storyExpansionPresets[0].version, '1.5.1');
assert.equal(upgraded.storyExpansionPresets[0].systemPrompt, current.systemPrompt);
const edited = { ...LEGACY_STORY_EXPANSION_GENERAL_V1_5_0, systemPrompt: `${LEGACY_STORY_EXPANSION_GENERAL_V1_5_0.systemPrompt}\n用户自定。` };
assert.deepEqual(normalizeState({ storyExpansionPresets: [edited] }).storyExpansionPresets, [edited]);
const from130 = normalizeState({ storyExpansionPresets: [legacyStoryPreparationV130] });
assert.equal(from130.storyExpansionPresets[0].version, '1.5.1');
assert.equal(from130.storyExpansionPresets[0].systemPrompt, current.systemPrompt);

console.log('NSFW prose motion prompt rule checks passed');

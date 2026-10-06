import assert from 'node:assert/strict';
import { requestStoryPreparationWithReview } from '../src/services/llm';
import type { Character, TextApiConfig } from '../src/types';

const character: Character = {
  id: 'shalltear', name: '夏提雅', aliases: ['红铠人'], gender: '女', apparentAge: '成年',
  race: '吸血鬼', appearance: '白发红眼', outfit: '红铠', signatureProps: '枪形武器',
  personality: '冷静', motionHabits: '', anchor: '白发红铠', negativeContinuity: '', assetIds: [],
  nsfwProfile: { fullBody: 'PRIVATE_DOSSIER_MUST_STAY_LOCAL' },
};
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://causality.test.invalid/v1/chat/completions', apiKey: 'test',
  model: 'test', temperature: 0.2, maxTokens: 4096, vision: false };
const originalWindow = globalThis.window;
const source = '红铠人是夏提雅。背景信息：她用枪形武器将来袭兽人打上半空。\n'
  + '敌军仿佛撞上看不见的墙，接连飞了出去。侍从呆愣地说：“飞出去了……”';
const visual = '夏提雅挥动枪形武器迎击来袭兽人，前排兽人受击飞向半空。侍从目睹这一幕，呆愣地说：“飞出去了……”';
const messages: Array<{ role: string; content: string }> = [];
let requests = 0;
const before = JSON.stringify(character);
try {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: { body?: string }) => {
      requests += 1;
      messages.push(...JSON.parse(payload.body || '{}').messages);
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: visual } }] }) };
    } },
  } });
  const result = await requestStoryPreparationWithReview(config, source, undefined,
    { systemPrompt: '旧规则：每场必须有出场人物/剧情/对白/背景信息栏目。', outputRules: '旧规则：写到三倍长度。' },
    'optimize', 10, { characters: [character] });
  assert.equal(requests, 1, 'understanding and self-review use the existing single request');
  assert.equal(result.text, visual, 'the model result is delivered without local protagonist or action rewriting');
  const user = messages.find((message) => message.role === 'user')!.content;
  const data = JSON.parse(user.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u)![1]);
  assert.equal(data.sourceTextOrRequirement, source, 'the full source includes the visible attack in background prose');
  assert.deepEqual(data.characterContinuity[0].aliases, ['红铠人']);
  assert.equal(data.characterContinuity[0].id, 'shalltear');
  assert.equal(data.targetLength, undefined, 'expansion length does not limit conversion');
  assert.equal(data.existingDialogueLines, undefined, 'no local speaker extraction biases interpretation');
  const prompt = messages.map((message) => message.content).join('\n');
  for (const required of ['STORY_CAUSALITY_V1', '被动句', '背景信息', '比喻', '攻击来源确实不明',
    '不能自行变成真实力场', '原对白全文', '不强制出场人物/剧情/对白/背景信息', '当前模式：AI画面描述转化']) {
    assert.ok(prompt.includes(required), `the conversion request must express ${required}`);
  }
  assert.doesNotMatch(prompt, /PRIVATE_DOSSIER_MUST_STAY_LOCAL/u);
  assert.equal(JSON.stringify(character), before, 'saved identity records are not mutated by preparation');
  assert.ok(user.lastIndexOf('当前模式：AI画面描述转化') > user.indexOf('旧规则：写到三倍长度。'));
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log('story causality preparation transport checks passed (mocked model; not a live semantic quality evaluation)');

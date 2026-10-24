import assert from 'node:assert/strict';
import { requestStoryPreparation, requestStoryPreparationWithReview, requestStoryExpansion, requestStoryVisualParagraphRewrite } from '../src/services/llm';
import { STORY_VISUAL_ENGINE_VERSION } from '../src/storyVisualAction';
import { fixturePlan, fixtureParagraphs, readStoryVisualData, type CapturedStoryRequest, type StoryVisualRequestData } from './storyVisualTestFixtures';
import type { TextApiConfig } from '../src/types';
import { LIANHUA_NSFW_CREATIVE_GUIDANCE, LIANHUA_NSFW_FIXED_PREFIX, MOSE_JIANGHU_NSFW_DETAIL_RULES, MOSE_JIANGHU_NSFW_PROMPT_RULE } from '../src/nsfwPromptRules';

const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://api.example.test/v1/chat/completions',
  apiKey: 'test-key', model: 'test-model', temperature: 0.2, maxTokens: 4096, vision: false,
};
const originalWindow = globalThis.window;
let requests: CapturedStoryRequest[] = [];
const fake = (handler: (request: CapturedStoryRequest) => string): void => {
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: { body?: string }) => {
      const request = JSON.parse(payload.body || '{}') as CapturedStoryRequest;
      requests.push(request);
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: handler(request) } }] }) };
    } },
  } });
};
const visualFake = (body?: string, change?: (data: StoryVisualRequestData) => unknown): void => fake((request) => {
  const data = readStoryVisualData(request);
  return JSON.stringify(change?.(data) ?? (data.stage === 'understanding' ? fixturePlan(data) : fixtureParagraphs(data, body)));
});
let checks = 0;
try {
  const source = ' \n林澜推开门，李云从门口侧身走进房间。\n\n林澜说：“先等我。”\n  ';
  const body = '林澜推开门，门口留出通道。李云侧身通过门口，进入房间。\n\n林澜说：“先等我。”';
  visualFake(body);
  const stages: string[] = [];
  const reviewed = await requestStoryPreparationWithReview(config, source, undefined, undefined, 'optimize', 600, { onProgress: (stage) => stages.push(stage) });
  assert.equal(reviewed.text, body);
  assert.equal(reviewed.engineVersion, STORY_VISUAL_ENGINE_VERSION);
  assert.equal(reviewed.detailMode, 'detailed');
  assert.deepEqual(stages, ['understanding', 'understanding', 'visualizing', 'visualizing']);
  assert.equal(requests.length, 2, 'small full-source conversion has exactly two model stages');
  for (const request of requests) {
    const data = readStoryVisualData(request);
    assert.equal(data.sourceTextOrRequirement, source, 'both stages receive the complete original, including whitespace');
    assert.equal(data.mode, 'optimize');
    assert.ok(!('targetLength' in data), 'expansion target does not constrain conversion');
    assert.equal(request.response_format, undefined, 'third-party providers are not forced to accept response_format');
    assert.equal(request.thinking, undefined, 'facts are understood using the provider reasoning default');
  }
  assert.equal(reviewed.actionPlan?.events.length, 2);
  assert.equal(reviewed.paragraphs?.[0].text, body);
  checks += 1;

  fake((request) => readStoryVisualData(request).stage === 'understanding' ? JSON.stringify(fixturePlan(readStoryVisualData(request))) : '林澜缓缓推开门。');
  const fallback = await requestStoryPreparationWithReview(config, '林澜推开门。');
  assert.equal(fallback.text, '林澜缓缓推开门。');
  assert.equal(fallback.paragraphs?.length, 1);
  assert.deepEqual(fallback.warnings, []);
  assert.equal(requests.length, 2, 'readable body creates navigable display paragraphs without a check or repair');
  checks += 1;

  for (const understanding of ['林澜推门。', '{}', '{"summary":"林澜推门', JSON.stringify({ version: '1', events: [{ id: 'e1', sourceParagraphIds: ['p99'], evidence: '林澜推开门,', action: '推门' }, null] })]) {
    fake((request) => readStoryVisualData(request).stage === 'understanding' ? understanding : '林澜推开门，门口露出通道。');
    const result = await requestStoryPreparationWithReview(config, '林澜推开门。');
    assert.equal(result.text, '林澜推开门，门口露出通道。');
    assert.deepEqual(result.warnings, []);
    assert.equal(requests.length, 2, 'first-stage prose, wrappers, version and reference differences do not block the normal body stage');
    assert.ok((readStoryVisualData(requests[1]).actionPlan as { summary?: string })?.summary, 'first-stage understanding travels to the body as model context');
  }
  fake((request) => readStoryVisualData(request).stage === 'understanding' ? JSON.stringify(fixturePlan(readStoryVisualData(request))) : '');
  await assert.rejects(requestStoryPreparation(config, '林澜推开门。'), /空|JSON|没有返回/u);
  assert.equal(requests.length, 2);
  visualFake(undefined, (data) => data.stage === 'visualizing' ? { paragraphs: [] } : undefined);
  assert.equal(await requestStoryPreparation(config, '林澜推开门。'), '{"paragraphs":[]}');
  assert.equal(requests.length, 2, 'unknown/empty metadata wrappers remain the model output without a local format gate');
  fake(() => 'not called');
  await assert.rejects(requestStoryPreparation(config, ' \n '), /请先输入/u);
  assert.equal(requests.length, 0);
  checks += 1;

  visualFake('林澜说：“我马上回来。”');
  const changedDialogue = await requestStoryPreparationWithReview(config, '林澜说：“先等我。”');
  assert.equal(changedDialogue.text, '林澜说：“我马上回来。”');
  assert.deepEqual(changedDialogue.warnings, []);
  assert.equal(requests.length, 2, 'dialogue judgment stays with AI rules and does not launch a local check or repair');
  visualFake('林澜轻推门。');
  assert.deepEqual((await requestStoryPreparationWithReview(config, '林澜轻推门。')).warnings, [], 'simple already-visual actions are exempt from copy advice');
  checks += 1;

  fake((request) => readStoryVisualData(request).stage === 'understanding'
    ? JSON.stringify({ version: '1', events: [{ id: 'e1', sourceParagraphIds: ['unknown'], evidence: '林澜推开门,', action: '推门' }] })
    : JSON.stringify({ extra: '格式额外字段不阻断正文', paragraphs: [{ id: 'same', text: '林澜推开门。' }, { id: 'same', sourceParagraphIds: ['p99'], eventIds: ['e99'], text: '李云走进房间。' }, null] }));
  const unverified = await requestStoryPreparationWithReview(config, '林澜推开门。李云走进房间。');
  assert.equal(unverified.text, '林澜推开门。\n\n李云走进房间。');
  assert.deepEqual(unverified.warnings, []);
  assert.equal(unverified.actionPlan?.events[0].evidence, '林澜推开门,', 'model evidence remains an unverified model field, not locally repaired');
  assert.equal(new Set(unverified.paragraphs?.map((paragraph) => paragraph.id)).size, 2, 'duplicate model IDs get display IDs without rejecting text');
  assert.equal(requests.length, 2);
  assert.equal(readStoryVisualData(requests[1]).focusEvents?.[0].evidence, '林澜推开门,', 'unfamiliar refs and punctuation are not filtered out of the next stage');
  checks += 1;

  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: { request: async (payload: { body?: string }) => {
    const request = JSON.parse(payload.body || '{}') as CapturedStoryRequest; requests.push(request);
    const content = readStoryVisualData(request).stage === 'understanding' ? '林澜推门，李云随后进屋。' : '林澜推开门，李云走进房间。';
    return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content } }] }) };
  } } } });
  const partial = await requestStoryPreparationWithReview(config, '林澜推开门。李云走进房间。');
  assert.equal(partial.text, '林澜推开门，李云走进房间。');
  assert.deepEqual(partial.warnings, []);
  assert.equal(requests.length, 2, 'available text is returned without a local completeness rejection or extra request');
  checks += 1;

  for (const cancelledBefore of [true, false]) {
    const controller = new AbortController();
    if (cancelledBefore) controller.abort();
    fake((request) => { controller.abort(); return JSON.stringify(fixturePlan(readStoryVisualData(request))); });
    await assert.rejects(requestStoryPreparation(config, '林澜推开门。', controller.signal), { name: 'AbortError' });
    assert.equal(requests.length, cancelledBefore ? 0 : 1, 'cancellation between stages prevents the prose call');
  }
  checks += 1;

  const progressController = new AbortController();
  visualFake();
  await assert.rejects(requestStoryPreparationWithReview(config, '林澜推门。', progressController.signal,
    undefined, 'optimize', undefined, { onProgress: (stage) => { if (stage === 'visualizing') progressController.abort(); } }), { name: 'AbortError' });
  assert.equal(requests.length, 1, 'stale/cancelled progress between stages cannot launch the prose request');
  checks += 1;

  const expansion = '林澜站在木门前，稳住手中的灯，压下门把。门板向内移开后，他侧身穿过门口，将灯举向房间深处。';
  for (const legacy of [false, true]) {
    fake(() => expansion);
    const output = legacy ? await requestStoryExpansion(config, '林澜推开门。', undefined, undefined, 600)
      : await requestStoryPreparation(config, '林澜推开门。', undefined, undefined, 'expand', 600);
    assert.equal(output, expansion);
    assert.equal(requests.length, 1, 'expansion keeps its independent one-call behavior');
    const prompt = requests[0].messages.map((message) => message.content).join('\n');
    assert.match(prompt, /约 600 个中文字符/u);
    assert.match(prompt, /世界观.*实体尺度.*动作可行性.*因果结果/u);
    assert.doesNotMatch(prompt, /story_visual_data/u);
  }
  fake(() => 'not called');
  await assert.rejects(requestStoryExpansion(config, '林澜推门。', undefined, undefined, 0), /目标字数/u);
  assert.equal(requests.length, 0);
  fake(() => JSON.stringify({ expandedStory: expansion, metadata: { modelOwned: true } }));
  assert.equal(await requestStoryExpansion(config, '林澜推门。'), expansion, 'extra wrapper fields no longer reject readable expansion');
  assert.equal(requests.length, 1);
  checks += 1;

  for (const [expansionSource, expectedMode] of [
    ['林澜说：“等我。”不要新增对白。', 'preserve-existing-no-new'],
    ['林澜推门。不要对白。', 'forbidden'],
    ['林澜推门，对白可有可无。', 'optional'],
    ['林澜和李云交谈，要求增加对白。', 'required'],
  ]) {
    fake(() => expansion);
    await requestStoryExpansion(config, expansionSource);
    const user = requests[0].messages.find((message) => message.role === 'user')!.content;
    const data = JSON.parse(user.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u)![1]);
    assert.equal(data.dialogueMode, expectedMode);
    if (expectedMode === 'preserve-existing-no-new') assert.equal(data.existingDialogueLines[0].utterance, '等我。');
  }
  const expansionLongSource = '林澜沿着长廊往前走，李云跟在林澜身后。'.repeat(400);
  fake(() => expansion);
  await requestStoryExpansion(config, expansionLongSource);
  const longExpansionUser = requests[0].messages.find((message) => message.role === 'user')!.content;
  const longExpansionData = JSON.parse(longExpansionUser.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u)![1]);
  assert.equal(longExpansionData.sourceTextOrRequirement, expansionLongSource);
  const interval = longExpansionData.targetLength.match(/^(\d+)-(\d+)/u);
  assert.ok(Number(interval[1]) <= Number(interval[2]), 'default growth guidance remains a valid interval for long expansions');
  checks += 1;

  const factoryRules = { systemPrompt: `保持原剧情事实。\n\n${MOSE_JIANGHU_NSFW_DETAIL_RULES}` };
  fake(() => expansion);
  await requestStoryExpansion(config, '两名成年恋人在卧室脱去衣物，全裸相拥。', undefined, factoryRules);
  const privateExpansionSystem = requests[0].messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  const privateExpansionUser = requests[0].messages.find((message) => message.role === 'user')!.content;
  assert.equal(privateExpansionSystem.split(MOSE_JIANGHU_NSFW_DETAIL_RULES).length - 1, 0, 'the saved detail bundle is not repeated beside the stable prefix');
  assert.equal(privateExpansionSystem.split(MOSE_JIANGHU_NSFW_PROMPT_RULE).length - 1, 1);
  assert.ok(privateExpansionSystem.startsWith(LIANHUA_NSFW_FIXED_PREFIX));
  assert.ok(privateExpansionUser.includes(LIANHUA_NSFW_CREATIVE_GUIDANCE));
  assert.ok(privateExpansionUser.indexOf('</story_expansion_data>') < privateExpansionUser.indexOf(LIANHUA_NSFW_CREATIVE_GUIDANCE));
  assert.ok(privateExpansionUser.indexOf(LIANHUA_NSFW_CREATIVE_GUIDANCE) < privateExpansionUser.indexOf('<story_expansion_output_protocol>'));
  fake(() => expansion);
  await requestStoryExpansion(config, '林澜推开门。', undefined, factoryRules);
  const ordinaryExpansionSystem = requests[0].messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  const ordinaryExpansionUser = requests[0].messages.find((message) => message.role === 'user')!.content;
  assert.ok(ordinaryExpansionSystem.startsWith(LIANHUA_NSFW_FIXED_PREFIX));
  assert.ok(!requests[0].messages.some((message) => message.role === 'system' && message.content.includes(MOSE_JIANGHU_NSFW_DETAIL_RULES)));
  assert.equal(ordinaryExpansionUser.includes(LIANHUA_NSFW_CREATIVE_GUIDANCE), false);
  checks += 1;

  const cappedConfig = { ...config, provider: 'deepseek' as const, model: 'deepseek-test', maxTokens: 32768 };
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: { request: async (payload: { body?: string }) => {
    const request = JSON.parse(payload.body || '{}') as CapturedStoryRequest & { max_tokens: number }; requests.push(request);
    if (request.max_tokens > 8192) return { status: 400, body: JSON.stringify({ error: { message: 'Invalid max_tokens value: valid range is [1, 8192]' } }) };
    const data = readStoryVisualData(request);
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(data.stage === 'understanding' ? fixturePlan(data) : fixtureParagraphs(data)) } }] }) };
  } } } });
  await assert.rejects(requestStoryPreparationWithReview(cappedConfig, '林澜经过门口，继续沿长廊前行。'.repeat(300)), /max_tokens/u);
  assert.equal((requests[0] as CapturedStoryRequest & { max_tokens: number }).max_tokens, 32768);
  assert.equal(requests.length, 1, 'provider parameter errors propagate without a smaller-token fallback retry');
  assert.ok(requests.every((request) => request.thinking === undefined), 'DeepSeek understanding preserves reasoning defaults');
  assert.equal(cappedConfig.maxTokens, 32768, 'failure does not change saved API settings');
  requests = [];
  await assert.rejects(requestStoryExpansion(cappedConfig, '林澜推门。'), /max_tokens/u);
  assert.equal(requests.length, 1, 'the expansion button also never retries a rejected parameter');
  checks += 1;

  const preset = { systemPrompt: '必须扩写三倍，禁止动作阶段。保持冷静文风。', outputRules: '只输出正文，不要 JSON。' };
  visualFake('林澜推开门。');
  await requestStoryPreparation(config, '林澜推开门。', undefined, preset, 'optimize', undefined, { detailMode: 'faithful' });
  for (const request of requests) {
    assert.equal(readStoryVisualData(request).detailMode, 'faithful');
    const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    const user = request.messages.find((message) => message.role === 'user')!.content;
    assert.equal(system.includes(preset.systemPrompt), false);
    assert.equal(`${system}\n${user}`.includes(preset.outputRules), false);
    assert.ok(system.startsWith(LIANHUA_NSFW_FIXED_PREFIX));
    assert.match(system, /stagingAdditions/u);
  }
  checks += 1;

  const lengthy = Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 段，林澜与李云沿着走廊前行。${'两人经过门口后继续前行，所持物品和人物身份不变。'.repeat(85)}`).join('\n\n');
  visualFake();
  const batched = await requestStoryPreparationWithReview(config, lengthy);
  assert.ok(requests.length > 2, 'long inputs use bounded paragraph batches');
  assert.equal(batched.actionPlan?.sourceParagraphs.map((paragraph) => paragraph.text).join('\n\n'), lengthy);
  assert.ok(batched.paragraphs!.length > 1);
  assert.ok(new Set(batched.paragraphs!.map((paragraph) => paragraph.id)).size === batched.paragraphs!.length);
  for (const request of requests) {
    const data = readStoryVisualData(request);
    if (data.stage === 'visualizing') assert.ok(data.actionPlan && data.focusEvents, 'every prose batch carries the full narrative fact plan plus local action evidence');
  }
  checks += 1;

  const crossingEvidence = '甲挥拳击中乙。乙后退一步。';
  const crossingSource = '甲站在门口。'.repeat(217) + crossingEvidence + '众人继续旁观。'.repeat(100);
  const overlapRequests: StoryVisualRequestData[] = [];
  const overlapBodies = ['甲挥拳击中乙。', '乙后退一步，众人继续旁观。'];
  fake((request) => {
    const data = readStoryVisualData(request); overlapRequests.push(data);
    if (data.stage === 'understanding') return JSON.stringify({ version: 1, summary: '甲击中乙，乙随后后退。', events: [
      { id: 'e-contact', sourceParagraphIds: ['p1'], evidence: crossingEvidence, actor: '甲', target: '乙', action: '挥拳击中后乙后退', result: '乙后退一步', uncertainties: [] },
    ] });
    assert.deepEqual(data.focusEvents?.map((event) => event.id), data.batchIndex === 0 ? ['e-contact'] : [], 'an event without sourceStart stays on the first source chunk and is not replayed in later slices');
    const bodyIndex = overlapRequests.filter((item) => item.stage === 'visualizing').length - 1;
    return JSON.stringify({ paragraphs: [{ id: 'v1', sourceParagraphIds: ['p1'], eventIds: ['e-contact'], text: overlapBodies[bodyIndex], stagingAdditions: [] }] });
  });
  const overlapResult = await requestStoryPreparationWithReview(config, crossingSource);
  assert.equal(requests.length, 3, 'the facts fit one call and the visual body uses two source chunks');
  assert.equal(overlapResult.text, overlapBodies.join('\n\n'));
  const visualOverlapData = overlapRequests.filter((data) => data.stage === 'visualizing');
  const firstChunk = visualOverlapData[0].sourceParagraphs![0] as { text: string; sourceStart: number; sourceEnd: number };
  const secondChunk = visualOverlapData[1].sourceParagraphs![0] as { text: string; sourceStart: number; sourceEnd: number };
  assert.ok(!firstChunk.text.includes(crossingEvidence) && !secondChunk.text.includes(crossingEvidence), 'fixture must actually straddle the body cut');
  assert.equal(firstChunk.sourceEnd, secondChunk.sourceStart, 'offsets retain contiguous original source coverage');
  assert.equal(firstChunk.text + secondChunk.text, crossingSource);
  assert.equal((visualOverlapData[1].precedingVisualParagraphs as Array<{ text: string }>)[0].text, overlapBodies[0]);
  assert.ok(requests[1].messages.some((message) => message.content.includes('不重播前批完整攻击')));
  checks += 1;

  const localSource = '林澜推开门。\n\n李云走进房间。';
  visualFake();
  const pending = await requestStoryPreparationWithReview(config, localSource);
  fake((request) => {
    const data = readStoryVisualData(request);
    assert.equal(data.stage, 'rewriting');
    assert.equal(data.sourceTextOrRequirement, localSource);
    assert.ok(data.actionPlan && data.neighboringParagraphs);
    return JSON.stringify({ paragraph: { ...data.previousParagraph, text: '林澜压下门把，将门板向内推开，门口留出通道。' } });
  });
  const rewritten = await requestStoryVisualParagraphRewrite(config, localSource, pending, 'v1');
  assert.equal(requests.length, 1, 'local redo is one context-aware request');
  assert.equal(rewritten.paragraphs?.[1].text, pending.paragraphs?.[1].text, 'unselected paragraph remains exact');
  assert.ok(rewritten.text.startsWith('林澜压下门把'));
  fake((request) => JSON.stringify({ paragraph: { ...readStoryVisualData(request).previousParagraph, eventIds: [], text: '胡乱新增事件。' } }));
  const changedScope = await requestStoryVisualParagraphRewrite(config, localSource, pending, 'v1');
  assert.equal(changedScope.paragraphs?.[0].text, '胡乱新增事件。', 'readable model output is not blocked by a local metadata judgment');
  assert.deepEqual(changedScope.warnings, []);
  assert.equal(pending.text, localSource, 'a rewrite cannot mutate the previous result');
  fake((request) => {
    const data = readStoryVisualData(request);
    assert.equal(data.sourceTextOrRequirement, localSource);
    assert.equal(data.currentVisualStory, '林澜推门。\n\n李云进屋。');
    assert.ok(data.neighboringParagraphs);
    return '林澜推开门，门口露出通道。';
  });
  const plainRewrite = await requestStoryVisualParagraphRewrite(config, localSource, { text: '林澜推门。\n\n李云进屋。', warnings: [] }, 'paragraph-1');
  assert.equal(requests.length, 1, 'user-requested local rewrite works once without any fact/evidence metadata');
  assert.equal(plainRewrite.text, '林澜推开门，门口露出通道。\n\n李云进屋。');
  checks += 1;
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log(`${checks} focused two-stage story-preparation checks passed (mock transport, no live model calls)`);

import assert from 'node:assert/strict';
import { requestStoryPreparation, requestStoryPreparationWithReview, requestStoryExpansion, type StoryPreparationMode } from '../src/services/llm';
import {
  MOSE_JIANGHU_NSFW_DETAIL_RULES,
  MOSE_JIANGHU_NSFW_PROMPT_RULE,
} from '../src/nsfwPromptRules';
import type { TextApiConfig } from '../src/types';

const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://api.example.test/v1/chat/completions',
  apiKey: 'test-key', model: 'test-model', temperature: 0.2, maxTokens: 4096, vision: false,
};
type CapturedRequest = { messages: Array<{ role: string; content: string }> };
const originalWindow = globalThis.window;
let requests: CapturedRequest[] = [];
const fake = (response: string | (() => string)): void => {
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: { body?: string }) => {
      requests.push(JSON.parse(payload.body || '{}'));
      const content = typeof response === 'function' ? response() : response;
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
    } },
  } });
};
const sourceData = () => {
  const message = requests[0]?.messages.find((item) => item.role === 'user')?.content || '';
  const serialized = message.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u)?.[1];
  assert.ok(serialized);
  return JSON.parse(serialized) as Record<string, unknown> & {
    mode: StoryPreparationMode;
    sourceTextOrRequirement: string;
    targetLength: string;
  };
};
const assertFullSourceOptimizationRequest = (source: string): void => {
  const data = sourceData();
  assert.equal(data.mode, 'optimize');
  assert.equal(data.sourceTextOrRequirement, source);
  for (const key of ['existingDialogue', 'existingDialogueLines', 'sourceExcerpt', 'speaker', 'speakers', 'beats', 'scenes']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(data, key), `optimization must not send a local ${key} checklist`);
  }
  const strategy = JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'sourceTextOrRequirement')));
  assert.match(strategy, /ai-read-full-source/u);
  assert.doesNotMatch(strategy, /forbidden|preserve-existing-no-new|required|optional/u,
    'local extraction must not decide whether the AI is allowed to find dialogue in the original');
};
const scene = (plot: string, dialogue = '无', characters = '林澜'): string => [
  '【场景1：门口】',
  `出场人物：${characters}`,
  `剧情：${plot}`,
  `对白：${dialogue}`,
].join('\n');
let checks = 0;
try {
  for (const [source, response] of [
    ['林澜站在门口，林澜推开门，林澜进入房间。', scene('林澜推开门后进入房间。')],
    ['林澜轻推门。', scene('林澜轻推门。')],
    [scene('林澜推开门后进入房间。'), scene('林澜推开门后进入房间。')],
  ]) {
    fake(response);
    assert.equal(await requestStoryPreparation(config, source), response);
    assert.equal(requests.length, 1);
    assert.equal(sourceData().mode, 'optimize');
    checks += 1;
  }
  for (const unchangedOrPolished of ['林澜轻推门。', '林澜缓缓推门。']) {
    fake(unchangedOrPolished);
    const reviewed = await requestStoryPreparationWithReview(config, '林澜轻推门。');
    assert.equal(reviewed.text, unchangedOrPolished);
    assert.deepEqual(reviewed.warnings, [], 'runtime normalization does not grade prose structure');
    assert.equal(requests.length, 1, 'readable prose is offered for user review without an automatic structure repair');
  }
  checks += 1;

  const sourceWithOuterWhitespace = ' \n\n林澜说：“先等我。”\n  ';
  fake(scene('林澜在门口发言。', '林澜：“先等我。”'));
  await requestStoryPreparationWithReview(config, sourceWithOuterWhitespace);
  assertFullSourceOptimizationRequest(sourceWithOuterWhitespace);
  assert.equal(requests.length, 1, 'the complete source reaches AI directly, including the user’s paragraph boundaries');
  checks += 1;

  const longSource = '林澜沿着长廊往前走，李云跟在林澜身后。'.repeat(220);
  assert.ok(longSource.length > 3000);
  const longScene = scene(longSource, '无', '林澜、李云');
  fake(longScene);
  assert.equal(await requestStoryPreparation(config, longSource), longScene);
  assert.equal(requests.length, 1);
  assert.equal(sourceData().sourceTextOrRequirement, longSource, 'long input must reach the one API request without slicing');
  checks += 1;

  const dialogueSource = '林澜说：“先等我。”李云点头，等在门边。';
  const dialogueResult = scene('林澜发话，李云在门边点头等候。', '林澜：“先等我。”', '林澜、李云');
  fake(dialogueResult);
  assert.equal(await requestStoryPreparation(config, dialogueSource), dialogueResult);
  for (const bad of [
    '林澜：“等一下。”',
    '李云：“先等我。”',
    '他：“先等我。”',
  ]) {
    const response = scene('李云在门边等候。', bad, '林澜、李云');
    fake(response);
    const reviewed = await requestStoryPreparationWithReview(config, dialogueSource);
    assert.equal(reviewed.text, response);
    assert.deepEqual(reviewed.warnings, [], 'runtime must not locally grade dialogue identity or meaning');
    assert.equal(requests.length, 1, 'dialogue wording is left to AI without a local retry');
  }
  const extraDialogueScene = scene('林澜与李云进入房间。', '林澜：“先进去。”', '林澜、李云');
  fake(extraDialogueScene);
  const extraDialogueReview = await requestStoryPreparationWithReview(config, '林澜与李云进入房间，两人交谈。');
  assert.equal(extraDialogueReview.text, extraDialogueScene);
  assert.deepEqual(extraDialogueReview.warnings, [], 'runtime must not compare local dialogue counts');
  assert.equal(requests.length, 1);
  const reorderedScene = scene('林澜与李云交谈。', '李云：“知道了。”\n林澜：“先等我。”', '林澜、李云');
  fake(reorderedScene);
  const reorderedReview = await requestStoryPreparationWithReview(config, '林澜说：“先等我。”李云回答：“知道了。”');
  assert.equal(reorderedReview.text, reorderedScene);
  assert.deepEqual(reorderedReview.warnings, [], 'runtime must not rejudge dialogue order');
  assert.equal(requests.length, 1);
  const orderedDialogue = scene('林澜与李云交谈。', '李云：“知道了。”\n林澜：“先等我。”', '林澜、李云');
  fake(orderedDialogue);
  assert.equal(await requestStoryPreparation(config, '李云：知道了。\n林澜说：“先等我。”'), orderedDialogue,
    'quoted and speaker-colon utterances are compared in actual story order, not parser-group order');
  checks += 1;

  // A speaker is the person, not the adjoining action or delivery phrase.
  // These are novel-style attributions, not only the simple “姓名说：” form.
  for (const [source, speaker, utterance] of [
    ['我应道：“行，左边归你，右边归师傅。”', '我', '行，左边归你，右边归师傅。'],
    ['“行，左边归你，右边归师傅。”我应得干脆。', '我', '行，左边归你，右边归师傅。'],
    ['祈凌霜挑眉问：“还走这边吗？”', '祈凌霜', '还走这边吗？'],
    ['祈凌霜愣了一下才说：“先等等。”', '祈凌霜', '先等等。'],
    ['她忽然问：“还走这边吗？”', '她', '还走这边吗？'],
    ['“回来！”祈凌霜喊道。', '祈凌霜', '回来！'],
  ] as const) {
    const response = scene('人物依照原文发言。', `${speaker}：“${utterance}”`, speaker);
    fake(response);
    const reviewed = await requestStoryPreparationWithReview(config, source);
    assert.equal(reviewed.text, response, source);
    assert.deepEqual(reviewed.warnings, [], 'ordinary novel attributions should not create false alarms');
    assert.equal(requests.length, 1, 'a valid novel attribution must only use the requested API call');
    assertFullSourceOptimizationRequest(source);
    checks += 1;
  }

  for (const [source, outputDialogue] of [
    ['林澜说：“先等我”', '林澜：先等我'],
    ['林澜说：“先等我。”', '林澜（低声）：“先等我。”'],
    ['林澜说：“先等我。”', '林澜: "先等我。"'],
    ['林澜说：“先等我。”李云回答：“知道了。”', '林澜：先等我。李云：知道了。'],
    ['林澜说：“先等我。”李云回答：“知道了。”', '林澜：“先等我。”\n李云：“知道了。”'],
  ]) {
    const response = scene('林澜与李云依次发言。', outputDialogue, '林澜、李云');
    fake(response);
    const reviewed = await requestStoryPreparationWithReview(config, source);
    assert.equal(reviewed.text, response, outputDialogue);
    assert.deepEqual(reviewed.warnings, [], 'equivalent dialogue formatting is not suspicious');
    assert.equal(requests.length, 1, 'equivalent speaker/quote formatting is not a dialogue rewrite');
    checks += 1;
  }

  for (const [sourceUtterance, candidateUtterance] of [
    ['等等！先别走……', '等等!先别走...'],
    ['先等我。我马上回来。', '先等我。\n我马上回来。'],
    ['先等我。\n我马上回来。', '先等我。我马上回来。'],
  ]) {
    const source = `林澜说：“${sourceUtterance}”`;
    const response = scene('林澜发话。', `林澜：“${candidateUtterance}”`);
    fake(response);
    const reviewed = await requestStoryPreparationWithReview(config, source);
    assert.equal(reviewed.text, response, 'format-equivalent dialogue is returned without locally rewriting the model output');
    assert.deepEqual(reviewed.warnings, []);
    assert.equal(requests.length, 1, 'safe formatting differences must not trigger an API repair');
    checks += 1;
  }

  const longUtterance = '先确认门口没有人，再请李云沿原路回来，不要离开约定位置。'.repeat(12);
  assert.ok(longUtterance.length > 240);
  const longDialogueScene = scene('林澜交代等待安排。', `林澜：“${longUtterance}”`);
  fake(longDialogueScene);
  assert.equal(await requestStoryPreparation(config, `林澜说：“${longUtterance}”`), longDialogueScene);
  assertFullSourceOptimizationRequest(`林澜说：“${longUtterance}”`);
  assert.equal(requests.length, 1);
  checks += 1;

  const strictSource = '祈凌霜挑眉问：“下次出门，我还要走你左边。”叶清菱回答：“好，别走散了。”';
  const strictFirst = { utterance: '下次出门，我还要走你左边。', speaker: '祈凌霜' };
  const strictSecond = { utterance: '好，别走散了。', speaker: '叶清菱' };
  for (const [actualFirst, remainingDialogue] of [
    [{ ...strictFirst, utterance: '下次出门，我要走你左边。' }, '叶清菱：“好，别走散了。”'],
    [{ ...strictFirst, speaker: '叶清菱' }, '叶清菱：“好，别走散了。”'],
    [strictSecond, '祈凌霜：“下次出门，我还要走你左边。”'],
  ] as const) {
    const response = scene('两人交谈。', `${actualFirst.speaker}：“${actualFirst.utterance}”\n${remainingDialogue}`, '祈凌霜、叶清菱');
    fake(response);
    const reviewed = await requestStoryPreparationWithReview(config, strictSource);
    assert.equal(reviewed.text, response, 'even a changed line remains available for an explicit user decision');
    assert.equal(requests.length, 1, 'real word loss, wrong names or reordered speech must not trigger another model call');
    assert.deepEqual(reviewed.warnings, [], 'local source/response semantic comparison is disabled for every readable candidate');
    checks += 1;
  }
  for (const incompleteDialogue of ['祈凌霜：“下次出门，我还要走你左边。”', '无']) {
    const response = scene('两人交谈。', incompleteDialogue, '祈凌霜、叶清菱');
    fake(response);
    const reviewed = await requestStoryPreparationWithReview(config, strictSource);
    assert.equal(reviewed.text, response);
    assert.deepEqual(reviewed.warnings, [], 'local extraction must not infer a missing line');
    assert.equal(requests.length, 1, 'readable content is returned without a local semantic repair');
    checks += 1;
  }

  const unmodifiedDialogueScene = scene('两人交谈。', '祈凌霜：“下次出门，我还要走你左边。”\n叶清菱：“好，别走散了。”', '祈凌霜、叶清菱');
  const changedDialogueScene = unmodifiedDialogueScene.replace('我还要', '我要');
  fake(() => requests.length === 1 ? changedDialogueScene : unmodifiedDialogueScene);
  assert.equal(await requestStoryPreparation(config, strictSource), changedDialogueScene,
    'the compatibility wrapper also returns the first readable result instead of secretly requesting a replacement');
  assert.equal(requests.length, 1);
  checks += 1;

  for (const [sourceUtterance, changedUtterance] of [
    ["Don't move.", 'Dont move.'],
    ['保持20.5米距离。', '保持205米距离。'],
    ['温度是-5度。', '温度是5度。'],
    ['你准备好了？', '你准备好了！'],
  ]) {
    const response = scene('林澜发话。', `林澜：“${changedUtterance}”`);
    fake(response);
    const reviewed = await requestStoryPreparationWithReview(config, `林澜说：“${sourceUtterance}”`);
    assert.equal(reviewed.text, response);
    assert.deepEqual(reviewed.warnings, [], 'punctuation meaning is reviewed by AI rather than local string matching');
    assert.equal(requests.length, 1,
      'meaningful punctuation changes may need user review but do not turn a usable response into an error');
    checks += 1;
  }

  fake('');
  await assert.rejects(requestStoryPreparationWithReview(config, '林澜推开门。'), /空|未返回|没有/u);
  assert.equal(requests.length, 1, 'an empty model body still fails, without retrying');
  const videoFieldResponse = 'integrated_multimodal_description: [Shot 1] 林澜推门。';
  fake(videoFieldResponse);
  const videoFieldReview = await requestStoryPreparationWithReview(config, '林澜推开门。');
  assert.equal(videoFieldReview.text, videoFieldResponse);
  assert.deepEqual(videoFieldReview.warnings, [], 'readable field-like words must not trigger local content advice');
  assert.equal(requests.length, 1, 'a readable nonstandard field layout remains available for user review');
  const quotedH3 = '林澜说：“integrated_multimodal_description: [Shot 1] 开门。”';
  const quotedH3Scene = scene('林澜发话。', quotedH3);
  fake(quotedH3Scene);
  assert.equal(await requestStoryPreparation(config, quotedH3), quotedH3Scene, 'a literal H3 tag inside dialogue is not a storyboard header');
  fake('不应发起请求。');
  await assert.rejects(requestStoryPreparation(config, ' \n '), /请先输入/u);
  assert.equal(requests.length, 0);
  checks += 1;

  for (const key of ['optimizedStory', 'expandedStory']) {
    fake(JSON.stringify({ [key]: scene('林澜推开门。') }));
    assert.equal(await requestStoryPreparation(config, '林澜推开门。'), scene('林澜推开门。'));
  }
  fake(JSON.stringify({ optimizedStory: scene('林澜推开门。'), note: '多余字段' }));
  const extraJsonReview = await requestStoryPreparationWithReview(config, '林澜推开门。');
  assert.equal(extraJsonReview.text, scene('林澜推开门。'));
  assert.deepEqual(extraJsonReview.warnings, [], 'recognized transport envelopes are unwrapped without semantic advice');
  assert.equal(requests.length, 1, 'extra JSON metadata must not discard a readable optimizedStory field');
  checks += 1;

  const expansion = '林澜站在木门前，先稳住手中的灯，再用另一只手压下门把。门板缓缓向内移开，门后的阴影随灯光退到墙角。林澜确认门边没有阻挡，便侧身穿过门口，把灯举向房间深处，随后站稳脚步，回头确认木门仍留着能够通行的空隙。';
  fake(expansion);
  assert.equal(
    await requestStoryPreparation(config, '林澜推开门进入房间。', undefined, undefined, 'expand', 600),
    expansion,
  );
  assert.match(sourceData().targetLength, /约 600 个中文字符/u);
  const customExpansionPrompt = requests[0].messages
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n');
  assert.match(customExpansionPrompt, /允许自然浮动/u);
  assert.match(customExpansionPrompt, /不要求精确等于该数字/u);
  checks += 1;

  // Expansion must ask the model to reason about the source's world rules and
  // physical scale before adding detail. This is intentionally a prompt
  // contract test: no local keyword checker should judge or repair the prose.
  const giantBattleSource = '奥特曼与怪物在城市上空展开巨物战斗，双方以光线和重拳交锋，地面车辆只能远离战场。';
  fake('奥特曼跃起避开怪物的光线，反手以光束击中怪物胸口，冲击波掀起尘雾，远处车辆紧急驶离。');
  await requestStoryPreparation(config, giantBattleSource, undefined, undefined, 'expand', 600);
  const giantBattleExpansionPrompt = requests[0].messages
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n');
  assert.match(giantBattleExpansionPrompt, /世界观.*实体尺度.*动作可行性.*因果结果/u);
  assert.match(giantBattleExpansionPrompt, /巨物.*车窗.*灯柱/u);
  assert.match(giantBattleExpansionPrompt, /不能.*普通人的动作.*巨物/u);
  assert.match(giantBattleExpansionPrompt, /输出前.*逐段复核/u);
  assert.match(giantBattleExpansionPrompt, /宁可少写/u);
  checks += 1;

  // The scale/worldview contract belongs to expansion only; optimization keeps
  // its fact-preserving contract without silently inheriting expansion prose.
  fake(scene('奥特曼与怪物在城市上空交战。', '无', '奥特曼、怪物'));
  await requestStoryPreparation(config, giantBattleSource, undefined, undefined, 'optimize');
  const optimizePrompt = requests[0].messages
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n');
  assert.doesNotMatch(optimizePrompt, /STORY_EXPANSION_WORLD_LOGIC_RULE|巨物.*车窗.*灯柱/u,
    'expansion-only scale examples must not change optimization semantics');
  checks += 1;

  fake(scene('林澜推开门。'));
  await requestStoryPreparation(config, '林澜推开门。', undefined, undefined, 'optimize', 1200);
  const optimizeWithIgnoredTarget = sourceData();
  assert.equal(optimizeWithIgnoredTarget.mode, 'optimize');
  assert.equal(Object.prototype.hasOwnProperty.call(optimizeWithIgnoredTarget, 'targetLength'), false,
    'the custom expansion target must not leak into optimization data');
  const optimizeWithIgnoredTargetPrompt = requests[0].messages
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n');
  assert.doesNotMatch(optimizeWithIgnoredTargetPrompt, /约 1200 个中文字符|不要求精确等于该数字/u,
    'optimization must not receive an expansion-length contract');
  checks += 1;

  fake('不应发起请求。');
  await assert.rejects(
    requestStoryPreparation(config, '林澜推开门。', undefined, undefined, 'expand', 0),
    /目标字数必须/u,
  );
  assert.equal(requests.length, 0, 'an invalid custom expansion length is rejected before the API request');
  checks += 1;

  for (const legacy of [false, true]) {
    fake(expansion);
    const response = legacy
      ? await requestStoryExpansion(config, '林澜推开门进入房间。')
      : await requestStoryPreparation(config, '林澜推开门进入房间。', undefined, undefined, 'expand');
    assert.equal(response, expansion);
    assert.equal(sourceData().mode, 'expand');
    assert.equal(requests.length, 1);
  }
  fake('林澜推开门进入房间。');
  assert.equal(await requestStoryExpansion(config, '林澜推开门进入房间。'), '林澜推开门进入房间。', 'source similarity no longer rejects an AI expansion result');
  // A long expansion still reaches the API; its suggested interval must not
  // invert the old 6000-character upper bound. Result length is guidance to AI,
  // not a local rejection criterion.
  fake(expansion);
  assert.equal(await requestStoryExpansion(config, longSource.repeat(2)), expansion);
  assert.equal(requests.length, 1);
  assert.equal(sourceData().sourceTextOrRequirement, longSource.repeat(2));
  const lengths = sourceData().targetLength.match(/^(\d+)-(\d+)/u)!;
  assert.ok(Number(lengths[1]) <= Number(lengths[2]));
  checks += 1;

  const preset = { systemPrompt: '保留冷静文风。必须加长，必须扩写，不是改写。', outputRules: '必须加长到原文三倍。' };
  const presetBefore = JSON.stringify(preset);
  fake(scene('林澜推开门。'));
  assert.equal(await requestStoryPreparation(config, '林澜推开门。', undefined, preset), scene('林澜推开门。'));
  const system = requests[0].messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n');
  const user = requests[0].messages.find((item) => item.role === 'user')!.content;
  assert.ok(system.lastIndexOf('当前模式：AI画面描述转化（optimize）') > system.indexOf(preset.systemPrompt));
  assert.ok(user.lastIndexOf('当前模式：AI画面描述转化（optimize）') > user.indexOf(preset.outputRules));
  assert.match(system, /本模式目标优先于.*规则预设/u);
  assert.equal(JSON.stringify(preset), presetBefore);
  assert.match(system, /(?:通读|完整原文|全文)/u);
  assert.match(system, /(?:自然连贯|自然中文段落|不套固定栏目)/u);
  assert.match(system, /(?:完整原文|全文).*(?:理解|依据|判断)/u);
  assert.doesNotMatch(system, /existingDialogue(?:Lines)?|sourceExcerpt/u,
    'optimization rules must not tell the model to follow local dialogue extraction hints');
  checks += 1;

  const nsfwSource = '两名恋人在卧室脱去衣物，全裸相拥，原文明确进入性交动作。';
  const nsfwScene = scene(
    '两人脱去衣物后全裸相拥，保持原文已经写明的性交动作与连续身体反应。',
    '无',
    '两名恋人',
  );
  const factoryNsfwRules = {
    systemPrompt: `保持原剧情事实。\n\n${MOSE_JIANGHU_NSFW_DETAIL_RULES}`,
    outputRules: '',
  };
  fake(nsfwScene);
  assert.equal(
    await requestStoryPreparation(config, nsfwSource, undefined, factoryNsfwRules),
    nsfwScene,
  );
  const nsfwSystem = requests[0].messages
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n');
  assert.equal(
    nsfwSystem.split(MOSE_JIANGHU_NSFW_DETAIL_RULES).length - 1,
    1,
    'the verbatim 墨色江湖 rule must reach an NSFW story request exactly once',
  );
  assert.match(nsfwSystem, /slow-paced, extremely explicit sexual scene/u);
  assert.match(nsfwSystem, /肉棒、龟头、阴茎、小穴、阴蒂、乳头、蜜液、精液、穴口/u);
  assert.ok(nsfwSystem.includes(MOSE_JIANGHU_NSFW_PROMPT_RULE));
  assert.match(nsfwSystem, /形状、尺寸或比例、颜色、纹理、边缘、体毛、湿润与体液状态/u);

  fake(scene('林澜推开门。'));
  await requestStoryPreparation(config, '林澜推开门。', undefined, factoryNsfwRules);
  const sfwSystem = requests[0].messages
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n');
  assert.doesNotMatch(sfwSystem, /slow-paced, extremely explicit sexual scene/u);
  checks += 1;

  for (const cancelBefore of [true, false]) {
    const controller = new AbortController();
    if (cancelBefore) controller.abort();
    fake(() => { controller.abort(); return scene('林澜推开门。'); });
    await assert.rejects(requestStoryPreparation(config, '林澜推开门。', controller.signal), { name: 'AbortError' });
    assert.equal(requests.length, cancelBefore ? 0 : 1);
  }
  checks += 1;
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log(`${checks} focused story-preparation checks passed`);

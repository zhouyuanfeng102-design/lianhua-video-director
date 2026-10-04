import assert from 'node:assert/strict';
import { requestStoryExpansion, requestStoryPreparation, requestStoryPreparationWithReview } from '../src/services/llm';
import type { TextApiConfig } from '../src/types';

const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://api.example.test/v1/chat/completions',
  apiKey: 'test-key', model: 'test-model', temperature: 0.2, maxTokens: 4096, vision: false,
};
type CapturedRequest = { messages: Array<{ role: string; content: string }> };
const originalWindow = globalThis.window;
let requests: CapturedRequest[] = [];
const fakeResponse = (content: string): void => {
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: { body?: string }) => {
      requests.push(JSON.parse(payload.body || '{}'));
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
    } },
  } });
};
const scene = (plot: string, dialogue = '无', characters = '林澜', title = '门口'): string => [
  `【场景1：${title}】`,
  `出场人物：${characters}`,
  `剧情：${plot}`,
  `对白：${dialogue}`,
].join('\n');
const requestData = () => {
  const user = requests[0].messages.find((item) => item.role === 'user')?.content || '';
  const serialized = user.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u)?.[1];
  assert.ok(serialized);
  return JSON.parse(serialized) as Record<string, unknown> & { mode: string; sourceTextOrRequirement: string; targetLength: string };
};
const assertNoLocalOptimizationChecklist = (): void => {
  const data = requestData();
  for (const key of ['existingDialogue', 'existingDialogueLines', 'sourceExcerpt', 'speaker', 'speakers', 'beats', 'scenes']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(data, key), `the optimization request must not include a local ${key} checklist`);
  }
};

// A focused fixture modeled on the reported screen: literary narration,
// quantities/codes, an invisible military inference, and original dialogue.
const novel = [
  '枪炮声从06号防区方向碾过来，像一柄看不见的钝锯来回拉扯清泉市的夜幕。防线上的枪口焰此起彼伏，爆炸掀起的泥块和碎砖砸在废弃车顶上，发出零碎的闷响。风暴兵团的人声和异种尖啸混成一片，从远处听来像是整座城市正在地底深处呻吟。',
  '同一时间，原本赶往巨石城支援的死亡兵团接到掉头命令。车队在环线岔口猛地刹住，装甲卡车碾着满地瓦砾转了个弯，车头调向北二环线方向。车顶机枪手被惯性甩得侧过身子，用力拽住机枪座才没撞上挡板。三千名玩家分坐在几十辆武装卡车中，最值钱的便是价值200银币的LD系列步枪。',
  '联盟的生物研究所刚刚完成了判断。孢子云的浓度差与流动轨迹被拼接到同一张图上，每条变化都指向北二环线附近一个相对稳定的核心区域。那个区域被判定为“西娅”可能的潜伏位置。指挥部没有叫死亡兵团回援06号防区，也没有让他们按原计划继续去支援风暴兵团，而是直接改了任务：在地精兵团的支援下，对浪潮指挥部发起袭击。',
  '边缘划水握着对讲机，左手抓住车架，车身每次碾过坑洞都让他的肩膀重重撞在铁栏上。',
  '边缘划水：“……风暴兵团正在遭受浪潮的攻击，我们的泉水老兄被黏菌的子实体堵在了墙角！”',
].join('\n\n');
const preparedNovel = [
  '【场景1：清泉市06号防区·夜间】',
  '出场人物：风暴兵团、异种。',
  '剧情：06号防区持续传来枪炮声。防线上多处枪口焰闪动，爆炸掀起的泥块和碎砖落在废弃车顶上，发出闷响。风暴兵团的人声与异种尖啸交织。',
  '对白：无',
  '',
  '【场景2：环线岔口至北二环线方向·同一时间】',
  '出场人物：死亡兵团三千名玩家、车顶机枪手、边缘划水。',
  '剧情：死亡兵团车队接到掉头命令，在环线岔口急刹，装甲卡车碾过瓦砾转向北二环线。车顶机枪手被惯性甩向一侧，抓紧机枪座，避免撞上挡板。三千名玩家分坐在几十辆武装卡车中，携带LD系列步枪。边缘划水握着对讲机，左手抓住车架；车辆碾过坑洞时，他的肩膀撞在铁栏上，他随即向通讯频道报告。',
  '对白：',
  '边缘划水：“……风暴兵团正在遭受浪潮的攻击，我们的泉水老兄被黏菌的子实体堵在了墙角！”',
  '背景信息：死亡兵团原本赶往巨石城支援。LD系列步枪价值200银币。生物研究所根据孢子云的浓度差与流动轨迹，判断北二环线附近稳定的核心区域可能是“西娅”的潜伏位置。指挥部因此将任务改为在地精兵团支援下袭击浪潮指挥部。',
].join('\n');

let checks = 0;
try {
  fakeResponse(preparedNovel);
  assert.equal(await requestStoryPreparation(config, novel), preparedNovel);
  assert.equal(requests.length, 1);
  assert.equal(requestData().mode, 'optimize');
  assert.equal(requestData().sourceTextOrRequirement, novel);
  assertNoLocalOptimizationChecklist();
  const prompt = requests[0].messages.map((item) => item.content).join('\n');
  for (const required of ['视频化整理（optimize）', '原文', '说话人']) {
    assert.ok(prompt.includes(required), required);
  }
  assert.match(prompt, /(?:通读|完整原文|全文)/u);
  assert.match(prompt, /(?:推荐|建议).*(?:场景|组织|结构)/u);
  assert.match(prompt, /(?:完整原文|全文).*(?:理解|依据|判断)/u);
  assert.doesNotMatch(prompt, /existingDialogue(?:Lines)?|sourceExcerpt/u);
  checks += 1;

  for (const unchangedOrPolished of [novel, '06号防区传来密集的枪炮声，城市的夜色被一阵阵爆炸震动。']) {
    fakeResponse(unchangedOrPolished);
    const reviewed = await requestStoryPreparationWithReview(config, novel);
    assert.equal(reviewed.text, unchangedOrPolished);
    assert.deepEqual(reviewed.warnings, [], 'the runtime does not issue local prose-structure judgments');
    assert.equal(requests.length, 1, 'the user may review readable prose without the app discarding it or automatically repairing it');
  }
  checks += 1;

  fakeResponse(preparedNovel);
  assert.equal(await requestStoryPreparation(config, preparedNovel), preparedNovel,
    'an already video-ready scene draft needs no artificial growth or rewriting');
  assertNoLocalOptimizationChecklist();
  const small = scene('林澜推门。');
  fakeResponse(small);
  assert.equal(await requestStoryPreparation(config, '林澜站在门口，林澜推开门，门被林澜推开了。'), small);
  const longScene = scene('林澜沿着长廊前行，李云跟在林澜身后。'.repeat(200));
  assert.ok(longScene.length > 3000);
  fakeResponse(longScene);
  assert.equal(await requestStoryPreparation(config, longScene), longScene);
  assert.equal(requestData().sourceTextOrRequirement, longScene, 'no source slicing or character cap');
  checks += 1;

  const sourceDialogue = '林澜说：“不要翻译这句话。”\nAlex: "Hold position."\n李云：收到。';
  const dialogue = '林澜：“不要翻译这句话。”\nAlex: "Hold position."\n李云：收到。';
  const mixedLanguageScene = scene('林澜、Alex和李云依次发言。', dialogue, '林澜、Alex、李云');
  fakeResponse(mixedLanguageScene);
  assert.equal(await requestStoryPreparation(config, sourceDialogue), mixedLanguageScene);
  for (const badDialogue of [
    dialogue.replace('不要翻译这句话。', 'Do not translate this line.'),
    dialogue.replace('Hold position.', '保持位置。'),
    dialogue.replace('林澜：', '李云：'),
    'Alex: "Hold position."\n林澜：“不要翻译这句话。”\n李云：收到。',
    dialogue.replace('\n李云：收到。', ''),
    `${dialogue}\n李云：“出发。”`,
  ]) {
    const response = scene('三人在门口。', badDialogue, '林澜、Alex、李云');
    fakeResponse(response);
    const reviewed = await requestStoryPreparationWithReview(config, sourceDialogue);
    assert.equal(reviewed.text, response);
    assert.deepEqual(reviewed.warnings, [], 'dialogue semantics, language and ownership are reviewed by the AI');
    assert.equal(requests.length, 1, 'content differences must not trigger a local repair');
  }
  checks += 1;

  fakeResponse(scene('林澜与李云交谈。', '无', '林澜、李云'));
  assert.equal(await requestStoryPreparation(config, '林澜与李云交谈。'), scene('林澜与李云交谈。', '无', '林澜、李云'));
  const addedSpeech = scene('林澜与李云交谈。', '林澜：“跟我走。”', '林澜、李云');
  fakeResponse(addedSpeech);
  const addedSpeechReview = await requestStoryPreparationWithReview(config, '林澜与李云交谈。');
  assert.equal(addedSpeechReview.text, addedSpeech);
  assert.deepEqual(addedSpeechReview.warnings, [], 'local dialogue-count comparisons are disabled');
  assert.equal(requests.length, 1);
  checks += 1;

  for (const invalid of [
    '【场景1：门口】\n林澜推门。',
    '【场景1：门口】\n出场人物：林澜\n剧情：林澜推门。',
    '【场景1：门口】\n出场人物：林澜\n剧情：\n对白：无',
    '【场景1：门口】\n出场人物：林澜\n剧情：林澜推门。\n对白：',
    `${small}\n\n【场景2：屋内】\n出场人物：林澜\n对白：无`,
    '以下是整理结果：\n' + small,
    'integrated_multimodal_description: [Shot 1] At 00:00.000 林澜推门。',
  ]) {
    fakeResponse(invalid);
    const reviewed = await requestStoryPreparationWithReview(config, '林澜推门。');
    assert.equal(reviewed.text, invalid);
    assert.deepEqual(reviewed.warnings, [], 'readable optional scene formatting is not a local semantic gate');
    assert.equal(requests.length, 1, 'nonstandard scene fields remain readable review candidates');
  }
  checks += 1;

  const literalDialogue = '林澜：“integrated_multimodal_description: [Shot 1] 开门。”';
  const literalScene = scene('林澜查看相机镜头，屏幕显示00:03，随后读出屏幕文字。', literalDialogue);
  fakeResponse(literalScene);
  assert.equal(await requestStoryPreparation(config, `林澜查看相机镜头，屏幕显示00:03，随后读出屏幕文字。${literalDialogue}`), literalScene,
    'literal dialogue, camera props and clock text are not forbidden storyboard field structures');
  const metadata = `${small}\n背景信息：林澜的来历没有交代。`;
  fakeResponse(metadata);
  assert.equal(await requestStoryPreparation(config, '林澜推门。林澜的来历没有交代。'), metadata,
    'metadata with terminal punctuation must not be misread as a character utterance');
  const sourceWithMission = '边缘划水：“风暴兵团正在遭受浪潮的攻击。”车队的任务改为转向北二环线。';
  const sceneWithMission = scene('边缘划水报告战况。', '边缘划水：“风暴兵团正在遭受浪潮的攻击。”', '边缘划水', '车队')
    + '\n背景信息：任务：转向北二环线。';
  fakeResponse(sceneWithMission);
  assert.equal(await requestStoryPreparation(config, sourceWithMission), sceneWithMission,
    'mission labels in background information are not new character speech');
  fakeResponse(sceneWithMission);
  assert.equal(await requestStoryPreparation(config, sceneWithMission), sceneWithMission,
    'an already structured source also extracts speech only from dialogue fields');
  assertNoLocalOptimizationChecklist();
  checks += 1;

  const oldRules = { systemPrompt: '旧预设：必须扩写三倍，只输出连续自然段，禁止标题、字段名。', outputRules: '旧输出规则：不输出场景标题或字段。' };
  const rulesBefore = JSON.stringify(oldRules);
  fakeResponse(small);
  assert.equal(await requestStoryPreparation(config, '林澜推门。', undefined, oldRules), small);
  const system = requests[0].messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n');
  const user = requests[0].messages.find((item) => item.role === 'user')!.content;
  assert.ok(system.lastIndexOf('当前模式：视频化整理（optimize）') > system.indexOf(oldRules.systemPrompt));
  assert.ok(user.lastIndexOf('当前模式：视频化整理（optimize）') > user.indexOf(oldRules.outputRules));
  assert.match(system, /“禁止标题或字段”等(?:硬格式)?要求不适用/u);
  assert.equal(JSON.stringify(oldRules), rulesBefore);
  checks += 1;

  for (const key of ['optimizedStory', 'expandedStory']) {
    fakeResponse(JSON.stringify({ [key]: small }));
    assert.equal(await requestStoryPreparation(config, '林澜推门。'), small);
  }
  fakeResponse(JSON.stringify({ optimizedStory: '林澜推门。' }));
  const proseObjectReview = await requestStoryPreparationWithReview(config, '林澜推门。');
  assert.equal(proseObjectReview.text, '林澜推门。');
  assert.deepEqual(proseObjectReview.warnings, [], 'valid body envelopes are unwrapped without grading their prose');
  assert.equal(requests.length, 1);
  checks += 1;

  const expansion = '林澜站在木门前，先稳住手中的灯，再用另一只手压下门把。门板缓缓向内移开，门后的阴影随灯光退到墙角。林澜确认门边没有阻挡，便侧身穿过门口，把灯举向房间深处，随后站稳脚步，回头确认木门仍留着能够通行的空隙。';
  for (const legacy of [false, true]) {
    fakeResponse(expansion);
    const result = legacy
      ? await requestStoryExpansion(config, '林澜推开门进入房间。')
      : await requestStoryPreparation(config, '林澜推开门进入房间。', undefined, undefined, 'expand');
    assert.equal(result, expansion);
    assert.equal(requestData().mode, 'expand');
    const expansionPrompt = requests[0].messages.map((item) => item.content).join('\n');
    assert.match(expansionPrompt, /输出使用连续中文剧情自然段/u);
    assert.match(expansionPrompt, /只返回扩写后的完整剧情正文/u);
    assert.doesNotMatch(expansionPrompt, /当前模式：视频化整理|【场景1：|视频化重整/u);
  }
  fakeResponse('林澜推开门进入房间。');
  assert.equal(await requestStoryExpansion(config, '林澜推开门进入房间。'), '林澜推开门进入房间。', 'local lexical growth checks do not reject model output');
  checks += 1;
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log(`${checks} focused video-ready story checks passed`);

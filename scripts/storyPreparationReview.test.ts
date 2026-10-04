import assert from 'node:assert/strict';
import { normalizeStoryPreparationResult, reviewStoryOptimization, type StoryPreparationWarning } from '../src/storyPreparationReview';
import { requestStoryPreparation, requestStoryPreparationWithReview, requestStoryExpansion } from '../src/services/llm';
import type { TextApiConfig } from '../src/types';

const scene = (dialogue = '无', plot = '林澜站在门口发言。', characters = '林澜'): string => [
  '【场景1：门口】', `出场人物：${characters}`, `剧情：${plot}`, `对白：${dialogue}`,
].join('\n');
const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://review.example.test/v1/chat/completions',
  apiKey: 'mock-only', model: 'mock-review', temperature: 0.2, maxTokens: 4096, vision: false,
};
const originalWindow = globalThis.window;
type CapturedRequest = { messages: Array<{ role: string; content: string }> };
const requests: CapturedRequest[] = [];
const fake = (content: string | (() => string), status = 200): void => {
  requests.length = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: { body?: string }) => {
      requests.push(JSON.parse(payload.body || '{}') as CapturedRequest);
      const body = typeof content === 'function' ? content() : content;
      return status === 200
        ? { status, body: JSON.stringify({ choices: [{ message: { content: body } }] }) }
        : { status, body: JSON.stringify({ error: { message: body } }) };
    } },
  } });
};
const warningShape = (warnings: StoryPreparationWarning[]): void => {
  assert.equal(new Set(warnings.map((warning) => warning.id)).size, warnings.length);
  for (const warning of warnings) {
    assert.ok(typeof warning.id === 'string' && warning.id.length > 0);
    assert.ok(typeof warning.message === 'string' && warning.message.length > 0);
    assert.ok(['dialogue-text', 'dialogue-speaker', 'dialogue-count', 'structure', 'format', 'language'].includes(warning.kind));
    if (warning.index !== undefined) assert.ok(Number.isInteger(warning.index) && warning.index > 0);
  }
};

let checks = 0;
try {
  for (const [source, candidate] of [
    ['林澜说：“先等我。”', scene('林澜：“先等我。”')],
    ['林澜说：“等等！先别走……”', scene('林澜: "等等!先别走..."')],
    ['林澜说：“先等我。我马上回来。”', scene('林澜：“先等我。”\n林澜：“我马上回来。”')],
    ['林澜说：“先等我。”林澜接着说：“我马上回来。”', scene('林澜：“先等我。我马上回来。”')],
    ['林澜说：“先等我。”', scene('林澜（低声）：“先等我。”')],
    ['林澜说：“先等我”', scene('林澜：先等我')],
    ['林澜说：“先等我。\n我马上回来。”', scene('林澜：“先等我。我马上回来。”')],
  ]) {
    const reviewed = reviewStoryOptimization(source, candidate);
    assert.equal(reviewed.text, candidate, 'review preserves the actual model text without restoring source punctuation or rewriting prose');
    assert.deepEqual(reviewed.warnings, [], 'harmless formatting and ordinary same-speaker split/merge must not create needless warnings');
    assert.deepEqual(reviewStoryOptimization(source, candidate), reviewed, 'review must be deterministic');
    checks += 1;
  }

  const source = '林澜说：“先等我。我马上回来。”李云回答：“知道了。”';
  for (const [dialogue, kind] of [
    ['林澜：“别等我。我马上回来。”\n李云：“知道了。”', 'dialogue-text'],
    ['李云：“先等我。我马上回来。”\n李云：“知道了。”', 'dialogue-speaker'],
    ['林澜：“先等我。我马上回来。”', 'dialogue-count'],
    ['李云：“知道了。”\n林澜：“先等我。我马上回来。”', 'dialogue-text'],
  ] as const) {
    const candidate = scene(dialogue, '林澜与李云依次发言。', '林澜、李云');
    const reviewed = reviewStoryOptimization(source, candidate);
    assert.equal(reviewed.text, candidate);
    assert.ok(reviewed.warnings.some((warning) => warning.kind === kind), kind);
    warningShape(reviewed.warnings);
    fake(candidate);
    const remoteReviewed = await requestStoryPreparationWithReview(config, source);
    assert.deepEqual(remoteReviewed, { text: candidate, warnings: [] }, 'runtime uses technical normalization, not the retained legacy review helper');
    assert.deepEqual(normalizeStoryPreparationResult(candidate), remoteReviewed);
    assert.equal(requests.length, 1, 'content concerns do not cause a failed request or an automatic repair call');
    checks += 1;
  }

  for (const [novelSource, badLabel, utterance] of [
    ['叶清碧没有反对，只说：“莫要走散。”', '只', '莫要走散。'],
    ['叶清碧看向众人，语气平静却带着宠溺：“好了，别闹得太显眼。”', '语气平静却带着宠溺', '好了，别闹得太显眼。'],
    ['我低声道：“那今日便好好陪你们逛个尽兴。”', '低声道', '那今日便好好陪你们逛个尽兴。'],
  ]) {
    const candidate = scene(`${badLabel}：“${utterance}”`, '人物依照原文发言。', '叶清碧、我');
    const reviewed = reviewStoryOptimization(novelSource, candidate);
    assert.equal(reviewed.text, candidate, 'a suspect label must remain visible; review cannot silently guess and rewrite a person name');
    const warning = reviewed.warnings.find((item) => item.kind === 'dialogue-speaker' && item.actual?.speaker === badLabel);
    assert.ok(warning, `even an unknown source attribution must expose the suspicious raw speaker label ${badLabel}`);
    warningShape(reviewed.warnings);
    fake(candidate);
    const serviceReviewed = await requestStoryPreparationWithReview(config, novelSource);
    assert.deepEqual(serviceReviewed, { text: candidate, warnings: [] }, 'legacy speaker heuristics must not run in the model-response path');
    assert.equal(requests.length, 1);
    const user = requests[0].messages.find((message) => message.role === 'user')?.content || '';
    const serialized = user.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u)?.[1];
    assert.ok(serialized);
    const data = JSON.parse(serialized) as Record<string, unknown>;
    assert.equal(data.sourceTextOrRequirement, novelSource);
    assert.equal(data.mode, 'optimize');
    for (const key of ['existingDialogue', 'existingDialogueLines', 'sourceExcerpt', 'speaker', 'speakers', 'beats', 'scenes']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(data, key), `no pre-extracted ${key} may bias AI understanding of the complete source`);
    }
    checks += 1;
  }
  const smilingSource = '祈凌霜笑盈盈道：“难得一起出来，慢慢逛吧。”';
  const smilingResult = scene('祈凌霜：“难得一起出来，慢慢逛吧。”', '祈凌霜笑着发言。', '祈凌霜');
  assert.deepEqual(reviewStoryOptimization(smilingSource, smilingResult), { text: smilingResult, warnings: [] },
    'a genuine person plus delivery description should not become a new locked person name');
  checks += 1;

  for (const candidate of [
    '林澜推开门，走进房间。',
    '【场景1：门口】\n对白：无\n剧情：林澜推门。\n出场人物：林澜',
    '## 场景一：门口\n**人物：** 林澜\n**剧情：** 林澜推门。\n**对白：** 无',
    '以下是整理结果：\n' + scene('无', '林澜推门。'),
    '{"场景":[{"地点":"门口","内容":"林澜推门。"}]}',
    '{"optimizedStory":"林澜推门。',
  ]) {
    const reviewed = reviewStoryOptimization('林澜推门。', candidate);
    assert.equal(reviewed.text, candidate);
    assert.ok(reviewed.warnings.some((warning) => warning.kind === 'structure' || warning.kind === 'format'));
    assert.ok(reviewed.warnings.every((warning) => !warning.kind.startsWith('dialogue-')),
      `nonstandard scene labels and surrounding notes must not create fictional speakers: ${candidate}`);
    warningShape(reviewed.warnings);
    checks += 1;
  }
  const english = 'Lin opens the door and walks into the room.';
  const englishReview = reviewStoryOptimization('林澜推门。', english);
  assert.equal(englishReview.text, english);
  assert.ok(englishReview.warnings.some((warning) => warning.kind === 'language'));
  checks += 1;

  const plainScene = scene('无', '林澜推门。');
  for (const candidate of [
    JSON.stringify({ optimizedStory: plainScene }),
    JSON.stringify({ expandedStory: plainScene }),
    JSON.stringify(plainScene),
    `\uFEFF\r\n\`\`\`text\r\n${plainScene.replace(/\n/gu, '\r\n')}\r\n\`\`\``,
  ]) {
    assert.equal(reviewStoryOptimization('林澜推门。', candidate).text, plainScene,
      'complete transport wrappers may be removed safely without rewriting the readable body');
    checks += 1;
  }
  const withMetadata = reviewStoryOptimization('林澜推门。', JSON.stringify({ optimizedStory: plainScene, note: '额外说明' }));
  assert.equal(withMetadata.text, plainScene);
  assert.ok(withMetadata.warnings.some((warning) => warning.kind === 'format'));
  checks += 1;

  for (const unreadable of [
    '', ' \r\n ', '\u0000\u0000', '---\n???', '{}', '[]', 'null', 'true', '""',
    '{"optimizedStory":""}', '{"optimizedStory":null}', '{"object":{}}',
    '{"error":{"message":"upstream failure"}}', '{"error_message":"网络错误"}',
    '```text\n\n```',
  ]) {
    assert.throws(() => reviewStoryOptimization('林澜推门。', unreadable), /空|不可|未返回|未提供|没有返回|错误信息/u,
      'empty, unreadable or explicit error envelopes are not usable optimization results');
    fake(unreadable);
    await assert.rejects(requestStoryPreparationWithReview(config, '林澜推门。'), /空|不可|未返回|未提供|没有返回|错误信息/u);
    assert.equal(requests.length, 1, 'unreadable responses fail without a model repair loop');
    checks += 1;
  }

  for (const status of [401, 500]) {
    fake('mock upstream failure', status);
    await assert.rejects(requestStoryPreparationWithReview(config, '林澜推门。'), /HTTP|401|500|upstream/u);
    assert.equal(requests.length, 1, 'ordinary transport failures do not become readable review candidates or content retries');
    checks += 1;
  }
  for (const cancelBefore of [true, false]) {
    const controller = new AbortController();
    if (cancelBefore) controller.abort();
    fake(() => { controller.abort(); return '林澜推门。'; });
    await assert.rejects(requestStoryPreparationWithReview(config, '林澜推门。', controller.signal), { name: 'AbortError' });
    assert.equal(requests.length, cancelBefore ? 0 : 1, 'cancellation cannot launch a content repair request');
    checks += 1;
  }

  const expansion = '林澜站在木门前，先稳住手中的灯，再用另一只手压下门把。门板缓缓向内移开，门后的阴影随灯光退到墙角。林澜确认门边没有阻挡，便侧身穿过门口，把灯举向房间深处，随后站稳脚步，回头确认木门仍留着能够通行的空隙。';
  fake(expansion);
  assert.deepEqual(await requestStoryPreparationWithReview(config, '林澜推开门进入房间。', undefined, undefined, 'expand'),
    { text: expansion, warnings: [] }, 'expansion still uses its existing mode and rules');
  assert.equal(requests.length, 1);
  fake('林澜推开门进入房间。');
  assert.equal(await requestStoryExpansion(config, '林澜推开门进入房间。'), '林澜推开门进入房间。', 'expansion quality and source similarity are also AI-owned');
  assert.equal(requests.length, 1, 'an unchanged AI expansion must not cause a local repair');
  checks += 1;

  fake('林澜推门。');
  assert.equal(await requestStoryPreparation(config, '林澜推门。'), '林澜推门。',
    'the legacy wrapper retains the string API while returning readable nonstandard optimization');
  assert.equal(requests.length, 1);
  checks += 1;
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log(`${checks} story preparation review checks passed`);

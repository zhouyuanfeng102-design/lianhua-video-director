import assert from 'node:assert/strict';
import {
  buildImagePromptConverterSystemPrompt,
  resolveImagePromptSelection,
  stripImagePromptNarrativeContracts,
} from '../src/imagePromptRules';
import {
  DIRECTED_ACTION_RELATION_RULE, IMAGE_STORY_SPATIAL_STATE_RULE,
  LEGACY_DIRECTED_ACTION_RELATION_RULE_V2_5_6, LEGACY_STORYBOARD_SPATIAL_FRAME_RULE_V2_5_6,
  SPATIAL_COORDINATE_RULE, SPATIAL_CONTINUITY_REVIEW_RULE,
  STORYBOARD_FRAME_VISIBILITY_RULE, STORYBOARD_SPATIAL_FRAME_RULE,
} from '../src/spatialContinuityRules';
import { requestImagePromptConverter } from '../src/services/llm';
import type { TextApiConfig } from '../src/types';

const count = (text: string, part: string): number => text.split(part).length - 1;
const custom = '自定义风格：保留稀疏笔触与冷色雾光。';
const customRules = `${custom}\n${custom}`;
const selection = resolveImagePromptSelection({ backend: 'openai', assetKind: 'storyboard' });
const before = JSON.stringify(selection);
const rules = buildImagePromptConverterSystemPrompt(selection, customRules);
const shared = [SPATIAL_COORDINATE_RULE, DIRECTED_ACTION_RELATION_RULE,
  STORYBOARD_SPATIAL_FRAME_RULE,
  STORYBOARD_FRAME_VISIBILITY_RULE, IMAGE_STORY_SPATIAL_STATE_RULE];
for (const block of shared) assert.equal(count(rules, block), 1, 'selected rule and preset share one spatial contract');
assert.equal(count(rules, SPATIAL_CONTINUITY_REVIEW_RULE), 0,
  'a frozen-frame conversion uses its current-state contract, not video cross-shot review rules');
assert.equal(count(rules, custom), 2, 'repeated custom wording is not treated as first-party duplication');
assert.equal(JSON.stringify(selection), before, 'request composition does not migrate stored rules or presets');

const authoredRule = IMAGE_STORY_SPATIAL_STATE_RULE.replace('唯一时刻和动作阶段', '由用户指定的时刻');
assert.notEqual(authoredRule, IMAGE_STORY_SPATIAL_STATE_RULE, 'the custom contract fixture must actually change the original');
assert.equal(stripImagePromptNarrativeContracts(authoredRule, 'storyboard'), authoredRule,
  'an edited contract remains authored text rather than being removed by a fuzzy sentence matcher');
assert.equal(stripImagePromptNarrativeContracts(rules, 'character'), rules,
  'ordinary character and multi-person identity rules keep their existing scope');
const authoredLegacyRule = LEGACY_DIRECTED_ACTION_RELATION_RULE_V2_5_6.replace(
  '使用当前机位自然可见的正面、侧面或背面。', '由作者选择当前画面的人物可见面。',
);
assert.notEqual(authoredLegacyRule, LEGACY_DIRECTED_ACTION_RELATION_RULE_V2_5_6);
assert.equal(stripImagePromptNarrativeContracts(authoredLegacyRule, 'storyboard'), authoredLegacyRule,
  'an edited 2.5.6 direction block remains authored text');
for (const legacy of [LEGACY_DIRECTED_ACTION_RELATION_RULE_V2_5_6, LEGACY_STORYBOARD_SPATIAL_FRAME_RULE_V2_5_6]) {
  assert.equal(stripImagePromptNarrativeContracts(`${custom}\n${legacy}\n${custom}`, 'storyboard'), `${custom}\n\n${custom}`,
    'only the exact previous standalone or nested first-party block is removed');
  assert.equal(stripImagePromptNarrativeContracts(legacy, 'character'), legacy,
    'legacy compatibility normalization does not alter identity-sheet requests');
}

const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://composition.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-only', model: 'composition-fixture', temperature: 0, maxTokens: 4096, vision: false,
};
const source = '本张为尾帧。青岚站在石桥东端，明川在西端，两人相距三米；摄影机在青岚身后。结束时只拍青岚握剑的手，明川仍在前方画外。';
const expected = {
  'natural-language': '石桥东端的握剑手部特写，青岚握住剑柄，明川保持西端相距三米的前方画外位置；摄影机在青岚身后，仅手与剑柄入画。',
  'sd-tags': 'hand close-up, Qing gripping sword on east end of stone bridge, Ming three meters away at west end off-screen, camera behind Qing',
  'nai-tags': 'hand close-up, stone bridge, east end, Ming three meters away at west end off-screen | Qing, hand gripping sword, camera behind Qing',
};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let calls = 0;
let reply = '';
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  lianhuaDesktop: { request: async (payload: { body?: string }) => {
    calls += 1;
    const body = JSON.parse(payload.body || '{}');
    const system = body.messages.find((message: { role: string }) => message.role === 'system').content as string;
    const user = body.messages.find((message: { role: string }) => message.role === 'user').content as string;
    for (const block of shared) assert.equal(count(system, block), 1, 'final text request carries each shared contract once');
    assert.equal(count(system, SPATIAL_CONTINUITY_REVIEW_RULE), 0,
      'final still conversion does not inject video cross-shot review rules');
    assert.equal(count(system, LEGACY_DIRECTED_ACTION_RELATION_RULE_V2_5_6), 0,
      'saved 2.5.6 direction rules are replaced by the current runtime contract');
    assert.ok(system.includes(authoredLegacyRule), 'the user-edited old rule survives final request normalization');
    assert.equal(count(system, custom), 2);
    assert.ok(user.includes(source), 'concrete distance, target, camera and crop facts reach the converter');
    assert.doesNotMatch(system, /【莲华程序参考用途/u, 'attachment metadata is not a converter system rule');
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: reply } }] }) };
  } },
} });
globalThis.fetch = async () => { throw new Error('Live network forbidden'); };
try {
  for (const format of ['natural-language', 'sd-tags', 'nai-tags'] as const) {
    // A saved request may already contain nested blocks from an earlier
    // builder. Normalize only its runtime copy at the final text boundary.
    const frozenRules = [buildImagePromptConverterSystemPrompt({
      ...selection, ruleSet: { ...selection.ruleSet, format },
    }, customRules).replace(DIRECTED_ACTION_RELATION_RULE, LEGACY_DIRECTED_ACTION_RELATION_RULE_V2_5_6),
    LEGACY_STORYBOARD_SPATIAL_FRAME_RULE_V2_5_6, LEGACY_DIRECTED_ACTION_RELATION_RULE_V2_5_6,
    authoredLegacyRule, STORYBOARD_SPATIAL_FRAME_RULE, DIRECTED_ACTION_RELATION_RULE].join('\n');
    const frozenTask = { prompt: '已保存的画面正文', converterSystemPrompt: frozenRules, conversionSource: source };
    const frozenBefore = JSON.stringify(frozenTask);
    reply = expected[format];
    assert.equal(await requestImagePromptConverter(config, 'storyboard', source, format, frozenTask.converterSystemPrompt), reply,
      'the converter result remains authored prose or tags with no local rule suffix');
    assert.equal(JSON.stringify(frozenTask), frozenBefore, 'saved prompt, facts and converter snapshot remain untouched');
  }
  assert.equal(calls, 3, 'one conversion per valid prompt, with no new semantic review');
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}
console.log('Storyboard conversion composition: one shared contract, preserved custom/frozen text and facts, all formats, zero network passed.');

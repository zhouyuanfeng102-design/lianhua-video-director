import assert from 'node:assert/strict';
import { NOVEL_ACTION_SOURCE_RULE, NOVEL_ACTION_DELIVERY_RULE, NOVEL_ACTION_FRAME_RULE } from '../src/novelActionDirection';
import {
  VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE,
  VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE, VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE,
  withVideoActionChoreographyScope,
} from '../src/videoActionChoreographyRules';
import {
  VIDEO_ACTING_CAMERA_RULES, VIDEO_ACTING_CAMERA_PRESERVATION_RULES,
  VIDEO_ACTING_CAMERA_TRANSLATION_RULE, stripLegacyVideoActingCameraRules,
} from '../src/videoActingCameraRules';
import {
  PRE_NOVEL_VIDEO_ACTION_CHOREOGRAPHY_RULE, PRE_NOVEL_VIDEO_ACTING_CAMERA_RULES,
  PRE_NOVEL_STORYBOARD_SPATIAL_FRAME_RULE,
} from '../src/novelActionLegacyRequestRules';
import { buildImagePromptConverterSystemPrompt, resolveImagePromptSelection,
  stripImagePromptNarrativeContracts } from '../src/imagePromptRules';
import { STORYBOARD_SPATIAL_FRAME_RULE } from '../src/spatialContinuityRules';
import { requestImagePromptConverter } from '../src/services/llm';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import type { TextApiConfig, VideoTaskApiConfig } from '../src/types';

// Request/output transport tests, not a claim about a model's visual execution.
const count = (text: string, part: string) => text.split(part).length - 1;
const custom = '用户定稿：她只伸手又收回，绝不抓住；保留我的原句。';
const frozen = { rules: `${custom}\n${PRE_NOVEL_VIDEO_ACTION_CHOREOGRAPHY_RULE}`, content: custom };
const original = JSON.stringify(frozen);
for (const scope of ['planning', 'generation', 'existing', 'translation', 'format-only'] as const) {
  const request = withVideoActionChoreographyScope(frozen.rules, scope);
  assert.ok(request.includes(custom));
  assert.equal(request.includes(PRE_NOVEL_VIDEO_ACTION_CHOREOGRAPHY_RULE), false);
  const source = scope === 'planning' || scope === 'generation';
  assert.equal(count(request, NOVEL_ACTION_SOURCE_RULE), source ? 1 : 0);
  assert.equal(count(request, NOVEL_ACTION_DELIVERY_RULE), source ? 0 : 1);
  assert.equal(withVideoActionChoreographyScope(request, scope), request,
    'request normalization is idempotent and does not stack current rules');
}
assert.equal(JSON.stringify(frozen), original, 'saved rules and authored content remain untouched');
for (const rule of [VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE, VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE,
  VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE, VIDEO_ACTING_CAMERA_PRESERVATION_RULES, VIDEO_ACTING_CAMERA_TRANSLATION_RULE]) {
  assert.equal(rule.includes(NOVEL_ACTION_SOURCE_RULE), false, 'downstream cannot acquire source direction');
}
assert.ok(VIDEO_ACTION_CHOREOGRAPHY_RULE.includes(NOVEL_ACTION_SOURCE_RULE));
assert.equal(stripLegacyVideoActingCameraRules(`${custom}\n${PRE_NOVEL_VIDEO_ACTING_CAMERA_RULES}\n${VIDEO_ACTING_CAMERA_RULES}`),
  `${custom}\n\n${VIDEO_ACTING_CAMERA_RULES}`, 'complete prior camera bundle is recognized before shared fragments');

const handover = '甲递出信，乙接稳后甲松手；信由乙持有。';
const aborted = '甲伸手想拉住乙，却在碰到之前停住，然后收回手；乙继续离开，双方未接触。';
const translatedHandover = '甲 extends the letter. 乙 takes hold before 甲 releases it; 乙 now holds the same letter.';
const translatedAborted = '甲 reaches toward 乙 but stops before contact, then withdraws the hand. 乙 continues leaving; no contact occurs.';
const api: VideoTaskApiConfig = { enabled: true, provider: 'generic', endpoint: 'https://novel-action.mock.invalid/video',
  statusEndpointTemplate: 'https://novel-action.mock.invalid/tasks/{id}', apiKey: '', authHeader: 'Authorization',
  authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' };
const sources = [
  { format: undefined, prompt: `主体：甲与乙。\n动作：${handover}\n空间：书房桌边。\n镜头：侧面中景。\n光影：窗光。\n声音：安静。\n${aborted}` },
  { format: undefined, prompt: `integrated_multimodal_description: [Shot 1] ${handover}\n[Shot 2] At 00:05.000, ${aborted}\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A` },
  { format: 'seedance' as const, prompt: `视频规格：时长10秒，画幅16:9。\n连续时间轴：0秒至5秒，${handover}\n5秒至10秒，${aborted}\n全局约束：信在乙手中。` },
];
for (const fixture of sources) {
  let calls = 0;
  const expected = fixture.prompt.replace(handover, translatedHandover).replace(aborted, translatedAborted);
  const result = await translateVideoPromptToEnglish({
    promptFormat: fixture.format, sourcePrompt: fixture.prompt, clean: (value) => value.trim(),
    request: async (system, user) => {
      calls += 1;
      assert.equal(count(system, NOVEL_ACTION_DELIVERY_RULE), 1);
      assert.equal(system.includes(NOVEL_ACTION_SOURCE_RULE), false);
      assert.ok(user.includes(handover), 'the adopted handover reaches the existing translator');
      assert.ok(user.includes(aborted), 'the aborted contact is not normalized into success');
      return user.replace(handover, translatedHandover).replace(aborted, translatedAborted);
    },
  });
  assert.equal(calls, 1, 'ordinary, H3 and Seedance each keep one normal translation call');
  assert.equal(result, expected, 'rendering preserves process, object ownership and non-contact');
  const body = buildVideoApiBody(api, { name: '递信与收手', backend: 'api', prompt: result,
    references: [], parameters: {}, source: { promptFormat: fixture.format || 'ordinary', language: 'en' } }, []);
  assert.equal(body.prompt, expected, 'video API serializes adopted prose without another directing pass');
  assert.equal(fixture.prompt.includes(translatedHandover), false, 'translation does not overwrite its source');
}

const selection = resolveImagePromptSelection({ backend: 'openai', assetKind: 'storyboard' });
const imageRules = buildImagePromptConverterSystemPrompt(selection, `${custom}\n${PRE_NOVEL_STORYBOARD_SPATIAL_FRAME_RULE}`);
assert.equal(count(imageRules, NOVEL_ACTION_FRAME_RULE), 1);
assert.ok(imageRules.includes(custom));
assert.equal(stripImagePromptNarrativeContracts(`${custom}\n${PRE_NOVEL_STORYBOARD_SPATIAL_FRAME_RULE}`, 'storyboard'),
  `${custom}\n`, 'the saved old bundle is removed only from the request copy');
// The current contract intentionally keeps the former spatial paragraphs
// after its new action-phase prefix; their presence is not a stale duplicate.
assert.equal(count(imageRules, STORYBOARD_SPATIAL_FRAME_RULE), 1);
const beforeContact = '当前为首帧：甲刚朝乙抬手，手还未碰到乙；乙持有同一封信，甲空手。摄影机在两人侧面，乙的离开路径留在画内；之后甲才收回手。';
const still = '侧面中景：甲的手停在乙手臂外侧，二者未接触。乙持信站在离开路径起点，甲手中无信。';
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://novel-action.mock.invalid/v1/chat/completions', apiKey: 'synthetic', model: 'fixture',
  temperature: 0, maxTokens: 2048, vision: false };
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousFetch = globalThis.fetch;
let imageCalls = 0;
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  lianhuaDesktop: { request: async (payload: { body?: string }) => {
    imageCalls += 1;
    const body = JSON.parse(payload.body || '{}');
    const system = body.messages.find((item: { role: string }) => item.role === 'system').content as string;
    const user = body.messages.find((item: { role: string }) => item.role === 'user').content as string;
    assert.equal(count(system, NOVEL_ACTION_FRAME_RULE), 1);
    assert.ok(user.includes(beforeContact), 'selected phase and inherited object ownership reach image conversion');
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: still } }] }) };
  } },
} });
globalThis.fetch = async () => { throw new Error('Live network forbidden'); };
try {
  assert.equal(await requestImagePromptConverter(config, 'storyboard', beforeContact, 'natural-language', imageRules), still);
  assert.equal(imageCalls, 1, 'frame conversion gains no action reviewer, validation request or retry');
} finally {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  globalThis.fetch = previousFetch;
}
console.log('novelActionDelivery: general action requests, handover/aborted-action rendering, frame scope and exact legacy compatibility passed.');

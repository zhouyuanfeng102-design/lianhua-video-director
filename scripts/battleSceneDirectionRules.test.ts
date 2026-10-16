import assert from 'node:assert/strict';
import {
  VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CAUSALITY_RULE,
  VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE, VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE,
  VIDEO_ACTION_EVENT_REVIEW_RULE, VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE,
  LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V2_3_7, LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V2_3_7,
  withVideoActionChoreographyScope,
} from '../src/videoActionChoreographyRules';
import {
  VIDEO_ACTING_CAMERA_RULES, VIDEO_AI_SHOT_COVERAGE_RULE,
  VIDEO_ACTING_CAMERA_PRESERVATION_RULES, VIDEO_ACTING_CAMERA_TRANSLATION_RULE,
  LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_3_7, LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V2_3_7,
  stripLegacyVideoActingCameraRules,
} from '../src/videoActingCameraRules';
import {
  STORY_PACING_RULE, STORYBOARD_SPEECH_FIRST_PLANNING_RULE, STORYBOARD_SOURCE_PLANNING_AUTHORITY_RULE,
} from '../src/storyPacing';

// These are request-contract and compatibility checks, not model responses or
// video-quality measurements. They make no model, video, file migration calls.
const tests: Array<{ name: string; run: () => void }> = [];
const test = (name: string, run: () => void): void => { tests.push({ name, run }); };

test('new source writing shares one procedure while separating explicit facts from permitted continuous staging', () => {
  const core = (value: string): string => value.split('\n\n').slice(1, -1).join('\n\n');
  assert.equal(core(VIDEO_ACTION_CHOREOGRAPHY_RULE), core(VIDEO_ACTION_CAUSALITY_RULE),
    'ordinary/H3 and the independent writer must receive the same source procedure');
  for (const rule of [VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CAUSALITY_RULE]) {
    for (const requirement of [/事实锁与编排选择/u, /原文明示一次或三次就严格保留次数/u,
      /原文概述持续交战、每一下攻击或不断迎击时，可以编排/u,
      /不反写成原著事实/u, /未知的攻击者、能力或胜负继续保持未知/u,
      /持续交战/u, /压倒性持续清剿/u, /瞬杀/u, /追逐/u, /阵列推进/u,
      /不能为增加动作拉长成持续交战/u]) assert.match(rule, requirement);
    assert.doesNotMatch(rule, /同一次交战可补足必要的可见轨迹与身体行为，不能增加攻击次数/u,
      'the retired blanket prohibition must not suppress source-supported sustained attacks');
  }
});

test('group battles carry spatial layers, propagation and source-grounded effects instead of a crowd quota', () => {
  for (const requirement of [/前景交点、中景队列推进和远景既有军势/u,
    /梯队、补位/u, /攻势传播/u, /不删除原文参与者，也不设每镜人数上限/u,
    /不要求每个人同时执行精密独立接触/u, /不自行增加屏障、爆炸、新法术/u,
    /持续迎击也不能只拍一次挥击后长期站住/u]) assert.match(VIDEO_ACTION_CHOREOGRAPHY_RULE, requirement);
  for (const requirement of [/前景可读交点、中景队列\/梯队推进与远景既有军势规模/u,
    /不强制逐层各一镜/u, /真实在场人物可画外继续说完整原话/u]) {
    assert.match(VIDEO_AI_SHOT_COVERAGE_RULE, requirement);
  }
  assert.equal(VIDEO_ACTING_CAMERA_RULES.split(VIDEO_AI_SHOT_COVERAGE_RULE).length - 1, 1);
});

test('time budgets preserve natural full speech and action while permitting only real-source parallel delivery', () => {
  for (const rule of [STORY_PACING_RULE, STORYBOARD_SPEECH_FIRST_PLANNING_RULE]) {
    for (const requirement of [/自然发话速度/u, /必需的动作过程|必要动作/u, /结果辨认/u, /画外/u,
      /不新增旁白/u, /口部互斥/u, /durationAdjustmentPolicy/u, /现有reason说明具体冲突/u]) {
      assert.match(rule, requirement);
    }
    assert.match(rule, /不按固定字速|不按本地字数/u);
    assert.match(rule, /人数或镜数配额/u);
  }
  assert.match(STORYBOARD_SOURCE_PLANNING_AUTHORITY_RULE, /sourceScope=assigned-semantic-segment/u);
  assert.match(STORYBOARD_SPEECH_FIRST_PLANNING_RULE, /已确认总稿的分段切片、参考图更新和H3中英文格式转换不适用此授权/u);
});

test('the existing evidence review covers sustained crowds and natural speech without granting another call', () => {
  for (const requirement of [/原剧情与候选稿实际写出的动作证据/u,
    /概述持续攻击不误判成只许一次/u, /队列\/梯队/u, /完整原话是否能以自然速度说完/u,
    /固定合同仍无法容纳时在现有reason说明具体冲突/u, /不新增审核字段、事件表、推理链或独立模型调用/u]) {
    assert.match(VIDEO_ACTION_EVENT_REVIEW_RULE, requirement);
  }
  assert.match(VIDEO_ACTION_CHOREOGRAPHY_RULE, /不新增动作schema/u);
  assert.match(VIDEO_ACTION_CHOREOGRAPHY_RULE, /不增加独立调用、本地语义门禁/u);
});

test('previous live action blocks are stripped at every request scope while custom and confirmed prose stay intact', () => {
  const custom = '用户要求：保持既有结局与对白。引用“VIDEO_ACTION_CHOREOGRAPHY_V1”作为文字。';
  const saved = [custom, LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V2_3_7,
    LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V2_3_7, VIDEO_ACTION_CHOREOGRAPHY_RULE].join('\n\n');
  const before = saved;
  for (const scope of ['planning', 'generation', 'existing', 'format-only', 'translation'] as const) {
    const selected = scope === 'planning' || scope === 'generation' ? VIDEO_ACTION_CHOREOGRAPHY_RULE
      : scope === 'translation' ? VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE : VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE;
    const request = withVideoActionChoreographyScope(saved, scope);
    assert.equal(request.split(selected).length - 1, 1);
    assert.equal(request.split(selected).join('').trim(), custom);
    assert.equal(request.includes(LEGACY_VIDEO_ACTION_CHOREOGRAPHY_RULE_V2_3_7), false);
    assert.equal(request.includes(LEGACY_VIDEO_ACTION_CAUSALITY_RULE_V2_3_7), false);
  }
  const translated = withVideoActionChoreographyScope(saved, 'translation', 'seedance');
  assert.equal(translated.split(VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE).join('').trim(), custom);
  assert.equal(saved, before, 'request replacement must never migrate the saved preset');
});

test('previous complete camera bundles lose old coverage without removing current nested contracts', () => {
  const custom = '用户构图保持。';
  const saved = [custom, LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_3_7,
    LEGACY_VIDEO_AI_SHOT_COVERAGE_RULE_V2_3_7, VIDEO_ACTING_CAMERA_RULES].join('\n\n');
  const expected = [custom, '', '', VIDEO_ACTING_CAMERA_RULES].join('\n\n');
  assert.equal(stripLegacyVideoActingCameraRules(saved), expected);
  for (const rule of [VIDEO_AI_SHOT_COVERAGE_RULE, VIDEO_ACTING_CAMERA_RULES,
    VIDEO_ACTING_CAMERA_PRESERVATION_RULES, VIDEO_ACTING_CAMERA_TRANSLATION_RULE]) {
    assert.equal(stripLegacyVideoActingCameraRules(rule), rule);
  }
});

test('translation and preservation do not inherit source battle or camera replanning authority', () => {
  for (const rule of [VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE, VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE,
    VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE]) {
    assert.equal(rule.includes('原文明示一次或三次就严格保留次数'), false);
    assert.equal(rule.includes('压倒性持续清剿'), false);
    assert.equal(rule.includes(VIDEO_AI_SHOT_COVERAGE_RULE), false);
    assert.match(rule, /不重新导演|不是新动作导演|不重新编排动作/u);
  }
  assert.match(VIDEO_ACTING_CAMERA_PRESERVATION_RULES, /不授权主动选镜/u);
  assert.match(VIDEO_ACTING_CAMERA_TRANSLATION_RULE, /不另作镜数、机位、剧情或光影设计/u);
});

for (const { name, run } of tests) { run(); console.log(`PASS ${name}`); }
console.log(`battleSceneDirectionRules: ${tests.length} request-contract checks passed; no model or video calls.`);

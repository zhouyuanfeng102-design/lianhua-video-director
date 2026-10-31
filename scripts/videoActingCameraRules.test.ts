import assert from 'node:assert/strict';
import {
  SCENE_STAGING_GENERATION_RULE, SPATIAL_COORDINATE_RULE, SPATIAL_CONTINUITY_REVIEW_RULE,
  SPATIAL_TRANSLATION_RULE, STORYBOARD_FRAME_VISIBILITY_RULE, STORYBOARD_SPATIAL_FRAME_RULE,
  LEGACY_STORYBOARD_SPATIAL_FRAME_RULE_V1_8_1,
} from '../src/spatialContinuityRules';
import {
  HEAD_ON_CHEST_RULE, VIDEO_INTERACTION_RULES, VIDEO_INTERACTION_TRANSLATION_RULE,
} from '../src/videoInteractionRules';
import {
  VIDEO_ACTING_CAMERA_RULES, VIDEO_CONTINUOUS_SCENE_RULE, VIDEO_NATURAL_PERFORMANCE_RULE,
  VIDEO_WORLD_SPACE_CAMERA_RULE, VIDEO_AI_SHOT_COVERAGE_RULE, VIDEO_CAMERA_SELECTION_RULE,
  VIDEO_MOTIVATED_LIGHTING_RULE, VIDEO_ACTING_CAMERA_FIELD_RULE,
  VIDEO_ACTING_CAMERA_REVIEW_RULE, VIDEO_ACTING_CAMERA_TRANSLATION_RULE,
  VIDEO_ACTING_CAMERA_PRESERVATION_RULES, LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_5_1,
  LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_6_6, LEGACY_VIDEO_WORLD_SPACE_CAMERA_RULE_V2_6_6,
  LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_1_0, LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_0_1,
  LEGACY_VIDEO_ACTING_CAMERA_RULES_V1_8_1, stripLegacyVideoActingCameraRules,
} from '../src/videoActingCameraRules';
import { VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT,
  VIDEO_PROMPT_ENGLISH_AI_REVIEW_SYSTEM_PROMPT,
  VIDEO_PROMPT_ENGLISH_DOCUMENT_TRANSLATION_SYSTEM_PROMPT } from '../src/promptTranslation';

// These checks cover generation authority, ordering and request compatibility.
// They do not claim that a video model executes a pose or a spatial relation.
const rules = [SCENE_STAGING_GENERATION_RULE, VIDEO_CONTINUOUS_SCENE_RULE,
  SPATIAL_COORDINATE_RULE, SPATIAL_CONTINUITY_REVIEW_RULE, VIDEO_INTERACTION_RULES,
  VIDEO_NATURAL_PERFORMANCE_RULE, VIDEO_WORLD_SPACE_CAMERA_RULE,
  VIDEO_AI_SHOT_COVERAGE_RULE, VIDEO_CAMERA_SELECTION_RULE,
  VIDEO_MOTIVATED_LIGHTING_RULE, VIDEO_ACTING_CAMERA_FIELD_RULE];
assert.equal(VIDEO_ACTING_CAMERA_RULES, rules.join('\n\n'));
for (const rule of rules) assert.equal(VIDEO_ACTING_CAMERA_RULES.split(rule).length - 1, 1);
assert.equal(VIDEO_ACTING_CAMERA_RULES.includes(VIDEO_ACTING_CAMERA_REVIEW_RULE), false,
  'the source contract generates the adopted scene without a candidate-review instruction');
assert.equal(VIDEO_WORLD_SPACE_CAMERA_RULE.includes(VIDEO_INTERACTION_RULES), false,
  'camera projection no longer nests the same interaction contract');
assert.equal(VIDEO_WORLD_SPACE_CAMERA_RULE.includes(SPATIAL_COORDINATE_RULE), false);

for (const field of ['sceneId', 'worldRelations', 'bodyFacing', 'gazeTarget', 'actionTarget',
  'cameraTarget', 'motionPath', 'motionEndpoint', 'endState']) {
  assert.ok(SCENE_STAGING_GENERATION_RULE.includes(field), field);
}
assert.match(SCENE_STAGING_GENERATION_RULE, /原事件与世界关系 → 连续行动及末态 → 摄影观看任务 → 当前可见范围 → 可见身份/u);
assert.match(SCENE_STAGING_GENERATION_RULE, /动作方向和最终位置分别表达/u);
assert.match(SPATIAL_COORDINATE_RULE, /身体的前方不等于摄影机前景/u);
assert.match(SCENE_STAGING_GENERATION_RULE, /转身、回头或改换目标须由剧情事件/u);
assert.match(SCENE_STAGING_GENERATION_RULE, /主观视点、正脸、反打和环绕都可以/u);
assert.match(SCENE_STAGING_GENERATION_RULE, /头留在胸口朝向的这一侧，可以在肩线内看向当前对象，不能转到胸口的反面/u);
assert.match(SCENE_STAGING_GENERATION_RULE, /对话中人物停步偏头看向同伴时[\s\S]*不把它扩写成身体转身或掉头/u);
assert.match(SCENE_STAGING_GENERATION_RULE, /原文明确已转身面对同伴[\s\S]*重新面向路线前方、沿同一方向继续/u);
assert.match(VIDEO_WORLD_SPACE_CAMERA_RULE, /cameraTarget[\s\S]*bodyFacing、gazeTarget及actionTarget分开/u);
assert.match(VIDEO_WORLD_SPACE_CAMERA_RULE, /worldRelations、participants[\s\S]*具名人物实例[\s\S]*同一时刻唯一的画面位置与可见范围/u);
assert.match(VIDEO_WORLD_SPACE_CAMERA_RULE, /越肩的肩、后脑与背部属于该具名人物的同一个身体[\s\S]*不再另置一份在中景或背景/u);
assert.match(VIDEO_WORLD_SPACE_CAMERA_RULE, /换机位时从同一世界站位重新推导投影/u);
assert.match(VIDEO_WORLD_SPACE_CAMERA_RULE, /听者可以仅有肩背入画或处于画外[\s\S]*不得为了同框正脸把听者搬到说话者身后/u);
assert.match(VIDEO_WORLD_SPACE_CAMERA_RULE, /原剧情或用户明确成立的分身、镜像、倒影[\s\S]*按原意保留/u);
assert.match(VIDEO_NATURAL_PERFORMANCE_RULE, /机位和身份图不构成这个动作/u);
assert.match(VIDEO_NATURAL_PERFORMANCE_RULE, /完整身份不强制露脸/u);
assert.match(VIDEO_INTERACTION_RULES, new RegExp(HEAD_ON_CHEST_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
assert.match(VIDEO_INTERACTION_TRANSLATION_RULE, /head stays on the chest that faces them/u);
assert.match(HEAD_ON_CHEST_RULE, /胸口、腹部、髋和双膝指向同一方向/u);
assert.match(HEAD_ON_CHEST_RULE, /每人的眼睛落在对方的眼睛上/u);
assert.match(VIDEO_INTERACTION_TRANSLATION_RULE, /her chest, abdomen, pelvis and knees face the same direction, and her knees point toward him/u);
assert.match(VIDEO_INTERACTION_TRANSLATION_RULE, /her eyes are on his eyes, and his eyes are on her eyes/u);
assert.match(VIDEO_AI_SHOT_COVERAGE_RULE, /摄影机站在两人连线的侧面/u);
assert.match(HEAD_ON_CHEST_RULE, /she stays standing with straight knees/u);
assert.match(VIDEO_INTERACTION_TRANSLATION_RULE, /she does not crouch, squat, or kneel/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /俯、下移、往裙摆或地面看只动摄影机/u);
assert.match(HEAD_ON_CHEST_RULE, /She remains kneeling bent over\. Both knees remain on the platform, shins folded behind the hips along the platform/u);
assert.match(HEAD_ON_CHEST_RULE, /The camera tilts down with small amplitude at slow speed from her face toward her waist\. Her knees remain on the platform/u);
assert.match(VIDEO_INTERACTION_TRANSLATION_RULE, /She remains kneeling bent over\. Both knees remain on the platform/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The camera tilts down with small amplitude at slow speed from her face toward her waist\. Her knees remain on the platform/u);
assert.match(VIDEO_INTERACTION_TRANSLATION_RULE, /his chest and eyes face that person, not the lens/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /拍正面和嘴清楚可见不表示脸转向镜头/u);
assert.match(VIDEO_WORLD_SPACE_CAMERA_RULE, /身后写后脑和耳/u);
assert.match(STORYBOARD_FRAME_VISIBILITY_RULE, /身后的可见面是后脑和耳廓/u);
assert.match(VIDEO_NATURAL_PERFORMANCE_RULE, /说话者口型跟随自己的原话与停顿/u);
assert.match(STORYBOARD_FRAME_VISIBILITY_RULE, /先描述当前可见面[\s\S]*从角色资料选入相应可见外貌/u);

for (const rule of [VIDEO_ACTING_CAMERA_PRESERVATION_RULES, VIDEO_ACTING_CAMERA_TRANSLATION_RULE]) {
  assert.equal(rule.includes(SCENE_STAGING_GENERATION_RULE), false);
  assert.equal(rule.includes(VIDEO_CAMERA_SELECTION_RULE), false,
    'downstream transcription and translation do not acquire photography authority');
}
assert.equal(VIDEO_ACTING_CAMERA_TRANSLATION_RULE.split(SPATIAL_TRANSLATION_RULE).length - 1, 1);
assert.equal(VIDEO_ACTING_CAMERA_TRANSLATION_RULE.split(VIDEO_INTERACTION_TRANSLATION_RULE).length - 1, 1);
for (const system of [VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT,
  VIDEO_PROMPT_ENGLISH_AI_REVIEW_SYSTEM_PROMPT]) {
  assert.ok(system.includes(VIDEO_ACTING_CAMERA_TRANSLATION_RULE));
  assert.equal(system.includes(SCENE_STAGING_GENERATION_RULE), false);
  assert.match(system, /不在翻译阶段重新导演/u);
}
assert.ok(VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('让摄影机运动以camera为主语')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('不得把retreating')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('除非源稿明确表示人物本人倒退或折返'));
assert.ok(VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT
  .includes('reorients toward the path ahead and continues along the same route/uphill'));
assert.ok(VIDEO_PROMPT_ENGLISH_DOCUMENT_TRANSLATION_SYSTEM_PROMPT.includes('对输入中的每个slot都返回且只返回一项')
  && VIDEO_PROMPT_ENGLISH_DOCUMENT_TRANSLATION_SYSTEM_PROMPT.includes('不得省略任何slot id'));

const current = [VIDEO_ACTING_CAMERA_RULES, VIDEO_ACTING_CAMERA_TRANSLATION_RULE,
  VIDEO_ACTING_CAMERA_PRESERVATION_RULES, SCENE_STAGING_GENERATION_RULE,
  STORYBOARD_FRAME_VISIBILITY_RULE, STORYBOARD_SPATIAL_FRAME_RULE];
for (const rule of current) assert.equal(stripLegacyVideoActingCameraRules(rule), rule);
for (const old of [LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_6_6,
  LEGACY_VIDEO_WORLD_SPACE_CAMERA_RULE_V2_6_6, LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_5_1,
  LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_1_0, LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_0_1,
  LEGACY_VIDEO_ACTING_CAMERA_RULES_V1_8_1, LEGACY_STORYBOARD_SPATIAL_FRAME_RULE_V1_8_1]) {
  const custom = '用户自定义：保留当前剧情和摄影。';
  const frozen = custom + '\n' + old;
  const snapshot = frozen;
  const request = stripLegacyVideoActingCameraRules(frozen) + '\n' + VIDEO_ACTING_CAMERA_RULES;
  assert.equal(request.includes(old), false);
  assert.ok(request.includes(custom));
  assert.equal(request.split(SCENE_STAGING_GENERATION_RULE).length - 1, 1);
  assert.equal(request.split(VIDEO_WORLD_SPACE_CAMERA_RULE).length - 1, 1);
  assert.equal(frozen, snapshot, 'compatibility changes request copies rather than saved presets');
}
assert.equal(
  stripLegacyVideoActingCameraRules(LEGACY_VIDEO_ACTING_CAMERA_RULES_V2_6_6 + '\n' + VIDEO_ACTING_CAMERA_RULES),
  '\n' + VIDEO_ACTING_CAMERA_RULES,
  'a saved prior bundle is removed whole while the complete current bundle remains once',
);
console.log('videoActingCameraRules: scene authority, visibility, translation and legacy compatibility contracts ready.');

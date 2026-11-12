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
import { VIDEO_SPATIAL_CONTINUITY_RULE } from '../src/videoConversionRules';
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
assert.match(VIDEO_CAMERA_SELECTION_RULE, /She keeps stepping toward the destination\. Her chest and the foot she steps with face that destination\. The camera moves backward in front of her at her pace\. Her face stays toward the person ahead/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /They remain in one file along the path\. The leader remains ahead, his chest and stepping foot facing the destination\. The next person remains behind that leader, chest toward that leader's back\. A later side view or a view of a face changes only the camera\. The order along the path stays the same/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /She keeps stepping toward the destination\. Her chest and the foot she steps with face that destination/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /The order along the path stays the same/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /后面每一镜开头用同一句再写一次先后/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The other action uses his remaining hand, and that forearm runs from his other arm to that palm/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The sole of the stepping foot meets the floor and stays until the other foot passes/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her eyes remain the size in the reference and blink once\. Her upper and lower teeth remain inside her lips\. Her tongue remains inside her mouth/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The nearer body hides the part of the farther body it covers\. The farther chest does not show through her torso/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The reflection is the same person in the same clothes\. It is not a second body/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her hair remains tied as in the first frame/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her rabbit ears remain on her head\. The collar remains around the neck/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The reference supplies only this person\. The corridor remains the shot place/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Only the named people are in this shot\. No one else enters from a doorway or forms in the background/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /One lamp keeps this color and this direction\. Each person has one shadow away from that lamp/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /Only the named people are in this shot/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /The other action uses his remaining hand/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The thread remains from his palm to her wrist/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The camera pushes in with small amplitude at slow speed toward her shoulder and stops at a medium shot/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Xiao Wu remains on the stone platform, still in the frame\. Tang San remains where this shot already placed him, still in the frame/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /still in the frame/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The robe remains outside the arm and the torso\. The sleeve follows that arm/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /His beard remains outside the collar, from his chin to his chest/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The hem stays against her legs/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her soles meet the stone and she stops\. Her weight stays on her soles/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The Grand Elder remains a head taller than Xiao Wu/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her shoulders turn with her head until her chin stays in front of her shoulder\. Her chest stays with that turn/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The action stays at real-time speed/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /This shot has one camera move/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The camera holds this frame\. It stays at this distance/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The camera arcs around her with small amplitude at slow speed\. Her feet, hips and shoulders stay facing the path\. The doorway slides across the frame/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The letter is already in her hand\. She raises that hand/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /His palm meets the door\. The door swings open and stays open/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her rear foot skids, her knees fold, and her soles meet the stone\. She stops\. Dust rises after she stops\. Her hair settles after her body stops/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The camera pulls out with large amplitude at her walking speed\. Her whole body stays in the frame/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her thighs meet the seat\. She stays seated/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /His arms remain around her back, outside her torso/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The scar remains on her right cheek, below the outer corner of that eye/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /That hand stays beside her waist, palm toward the path\. Five fingers remain separated on that palm/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /One shot carries the change from the first frame to the last frame/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her eyes meet his eyes/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her eyes look toward Tang San, off to her right\. Her face stays three-quarters toward him/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Xiao Wu remains on screen-left, facing screen-right\. Tang San remains on screen-right, facing screen-left/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /In the reverse shot she faces the lens\. The table runs toward the lens\. The wall that was behind her stays behind her/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The ring remains on his right hand\. His glasses remain on his face/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The cup remains in her right hand at the start of this shot\. It stays in that hand until she sets it down/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /His hand turns the cover\. The wrist turns, the fingers lift, and the fingertips meet the cover\. The cover stays between his thumb and fingers/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /His elbow stays bent on the outside of that arm/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /This shot stays close on her hand and the cup/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The blade travels from his shoulder to that named surface and stops against it/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The hem follows her step and settles after the foot stops/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Steam rises from the cup and stays above the cup/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /She finishes the reach in the middle of the shot\. The last moment holds that pose/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her knees stay closer to the lens than her face\. Her face stays farther back in the frame/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /His brows stay drawn together\. His eyes stay on Tang San/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Exactly three people remain\. Xiao Wu remains on the platform\. The Grand Elder remains the one person leaning over her\. Tang San remains one body, standing away from the platform/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her other hand remains at the end of her other arm\. The Grand Elder's one hand stays on the platform beside her hip\. His remaining hand stays on her waist, and that forearm runs from his other arm to that palm/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /In this shot Xiao Wu lies on her back\. Her two feet stay on the platform/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /Exactly three people remain/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /Each person has two arms and two legs/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /The camera holds a medium view of her face, his torso, and Tang San\. The joined contact remains between their bodies inside that view/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /This shot follows one story beat: he lifts her waist, she arches, and she answers\. Her face stays in the frame/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /While this rock continues, her back stays arched, her toes stay curled, tears stay on her cheeks, and her chest rises with each breath/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Her head turns from side to side\. Tears stay across her cheeks/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /This shot names her and this reaction\. Her face, hair, and clothes stay as in the reference/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /The camera holds a medium view of her face, his torso, and Tang San/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /Her eyes meet his eyes/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /The cup remains in her right hand at the start of this shot/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /His beard remains outside the collar, from his chin to his chest/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /The action stays at real-time speed/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /His palm meets the door\. The door swings open and stays open/u);
assert.match(VIDEO_CAMERA_SELECTION_RULE, /Exactly two threads remain/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /Exactly two threads remain/u);
assert.match(VIDEO_SPATIAL_CONTINUITY_RULE, /The thread remains from his palm to her wrist/u);
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
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('She keeps stepping toward the destination')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('They remain in one file along the path')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('The thread remains from his palm to her wrist')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('The other action uses his remaining hand')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('It is not a second body')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('Her hair remains tied as in the first frame')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('One lamp keeps this color and this direction')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('stops at a medium shot')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('still in the frame')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('While he says these lines, his weight stays on one foot and his hand keeps a small motion until the last line ends')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('His beard remains outside the collar, from his chin to his chest')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('Her shoulders turn with her head until her chin stays in front of her shoulder. Her chest stays with that turn')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('The action stays at real-time speed')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('One shot carries the change from the first frame to the last frame')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('Her eyes meet his eyes')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('The cup remains in her right hand at the start of this shot. It stays in that hand until she sets it down')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('She finishes the reach in the middle of the shot. The last moment holds that pose')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('Exactly three people remain. Xiao Wu remains on the platform. The Grand Elder remains the one person leaning over her. Tang San remains one body, standing away from the platform')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes("Tang San says the name. The camera holds on Tang San's mouth for this line. His mouth opens. The Grand Elder's mouth stays closed. Xiao Wu's mouth stays closed")
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('The camera holds a medium view of her face, his torso, and Tang San. The joined contact remains between their bodies inside that view')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('While this rock continues, her back stays arched, her toes stay curled, tears stay on her cheeks, and her chest rises with each breath')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('Her mouth stays closed during his line. Her brows stay drawn, tears stay on her cheeks, and her chest keeps rising')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('The sign reads "OPEN"')
  && VIDEO_PROMPT_ENGLISH_AI_TRANSLATION_SYSTEM_PROMPT.includes('From 22.500s to 24.000s, he says: <d>[Chinese] 小舞……</d>\nHis mouth stays closed. His hand stays on her head')
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

import assert from 'node:assert/strict';
import { SPATIAL_COORDINATE_RULE, SPATIAL_CONTINUITY_REVIEW_RULE, SPATIAL_TRANSLATION_RULE } from '../src/spatialContinuityRules';
import * as ruleExports from '../src/videoActingCameraRules';
import {
  VIDEO_NATURAL_PERFORMANCE_RULE,
  VIDEO_WORLD_SPACE_CAMERA_RULE,
  VIDEO_AI_SHOT_COVERAGE_RULE,
  VIDEO_CAMERA_SELECTION_RULE,
  VIDEO_MOTIVATED_LIGHTING_RULE,
  VIDEO_ACTING_CAMERA_FIELD_RULE,
  VIDEO_ACTING_CAMERA_REVIEW_RULE,
  VIDEO_ACTING_CAMERA_TRANSLATION_RULE,
  VIDEO_ACTING_CAMERA_RULES,
} from '../src/videoActingCameraRules';

// Contract tests inspect only the instructions supplied to AI. They never
// decide whether an AI answer's emotion, shot count or background is valid.
const tests: Array<{ name: string; run: () => void }> = [];
const test = (name: string, run: () => void): void => { tests.push({ name, run }); };

test('the module exports only text rules and the shared bundle contains each directing rule once', () => {
  assert.equal(Object.keys(ruleExports).length, 9);
  assert.ok(Object.values(ruleExports).every((value) => typeof value === 'string' && value.length > 0));
  const rules = [
    VIDEO_NATURAL_PERFORMANCE_RULE, VIDEO_WORLD_SPACE_CAMERA_RULE,
    VIDEO_AI_SHOT_COVERAGE_RULE, VIDEO_CAMERA_SELECTION_RULE,
    VIDEO_MOTIVATED_LIGHTING_RULE, VIDEO_ACTING_CAMERA_FIELD_RULE,
    VIDEO_ACTING_CAMERA_REVIEW_RULE,
  ];
  assert.equal(VIDEO_ACTING_CAMERA_RULES, rules.join('\n\n'));
  for (const rule of rules) assert.equal(VIDEO_ACTING_CAMERA_RULES.split(rule).length - 1, 1);
  assert.equal(VIDEO_ACTING_CAMERA_RULES.includes(VIDEO_ACTING_CAMERA_TRANSLATION_RULE), false);
});

test('performance follows story stimuli and permits warranted strong emotion without mechanical quotas', () => {
  for (const requirement of [
    /原剧情、人物关系、已知性格和当前信息/u,
    /身份与面容稳定不等于表情冻结/u,
    /刺激后的理解、回应与自然回落/u,
    /不要求每镜凑齐一套微动作/u,
    /原文有强烈喜悦、恐惧、愤怒等就保留/u,
    /不能一律改成面无表情或微笑/u,
    /不指定固定眨眼频率、每秒表情次数/u,
  ]) assert.match(VIDEO_NATURAL_PERFORMANCE_RULE, requirement);
});

test('speaker and listener have separate timing and reactions without forcing visible faces or new actions', () => {
  for (const requirement of [
    /说话者的口型和语气跟随自己的原话及停顿/u,
    /倾听者依实际听到的信息/u,
    /不代说、不随别人的台词张口/u,
    /不把不说话写成紧咬嘴唇或全程木然/u,
    /表情不随切镜机械重置/u,
    /不强迫背影和远景展示不可见的面部细节/u,
    /不为表演新增剧情事件、改变原有情绪走向或添加影响因果的人物动作/u,
  ]) assert.match(VIDEO_NATURAL_PERFORMANCE_RULE, requirement);
});

test('identity-profile habits and expression anchors do not become fixed acting or premature story events', () => {
  for (const requirement of [
    /普通身份资料中的性格、动作习惯/u,
    /“笑容明亮”“被某事后神色如常”等静态或条件式表情锚点只是角色参考/u,
    /不是当镜必须执行的事件或全程固定表情/u,
    /不把整份档案逐镜复制成动作命令/u,
    /以当前段真实事件触发表演变化/u,
    /档案里的条件只有当前剧情实际触发才适用/u,
    /不把后段才发生的动作或后果提前/u,
    /不为丰富表情添加影响剧情的动作/u,
    /保留原有角色身份与用户明确设定/u,
    /不擅自改变年龄、衣着、外貌或已确认状态/u,
  ]) assert.match(VIDEO_NATURAL_PERFORMANCE_RULE, requirement);
});

test('world route, camera pose and actually visible background are distinct and legal frontal tracking is retained', () => {
  for (const requirement of [
    /世界空间记录起点、当前所在路段、目的地/u,
    /镜头空间记录摄影机相对人物的位置、朝向、运动轨迹/u,
    /行进路线和目的地不等于摄影机朝向/u,
    /正面跟拍可以是摄影机位于人物前方并向后退拍/u,
    /背景应来自人物身后、摄影机实际视野所及的路段/u,
    /不能仅因人物将到达某地就把该目的地凭空换成背后背景/u,
    /不把所有背景变化都判成错误/u,
    /摄影机换位不等于人物转身/u,
    /不为修复空间虚构掉头、瞬移、时间跳跃或新路线/u,
  ]) assert.match(VIDEO_WORLD_SPACE_CAMERA_RULE, requirement);
});

test('world-space direction carries named body sides, screen projection and scene continuity once', () => {
  for (const rule of [SPATIAL_COORDINATE_RULE, SPATIAL_CONTINUITY_REVIEW_RULE]) {
    assert.equal(VIDEO_WORLD_SPACE_CAMERA_RULE.split(rule).length - 1, 1);
    assert.equal(VIDEO_ACTING_CAMERA_RULES.split(rule).length - 1, 1);
    assert.equal(VIDEO_ACTING_CAMERA_TRANSLATION_RULE.includes(rule), false,
      'translation does not independently re-plan spatial staging');
  }
  for (const requirement of [
    /人物自身左右/u,
    /世界站位/u,
    /观众画面左右（screen-left\/screen-right）/u,
    /不能凭镜像画面互换人物、身体侧别或地标/u,
    /左右前方机位变化不必然越轴/u,
    /画外人物只保留空间关系/u,
    /不机械固定每个人永远在屏幕某侧/u,
  ]) assert.match(VIDEO_WORLD_SPACE_CAMERA_RULE, requirement);
});

test('AI selects shot coverage by information and space while confirmed conversion boundaries stay fixed', () => {
  for (const requirement of [
    /剧情信息、动作因果、对白回应、空间变化、情绪转折和可用时长/u,
    /不默认三镜、不为凑固定镜数机械等分/u,
    /用户指定镜数或允许范围内/u,
    /自动模式按需要决定镜数与镜长/u,
    /规划JSON已有reason（保存后对应shotCountReason）和每镜purpose\/transition/u,
    /不新增JSON属性/u,
    /一个连续镜头可以成立/u,
    /对白不自动等于正面面部近景/u,
    /保留既定镜数、顺序和切点/u,
    /不借自主导演之名重切整段或裁掉对白/u,
  ]) assert.match(VIDEO_AI_SHOT_COVERAGE_RULE, requirement);
});

test('selected camera terms are real inputs and unselected shots still get motivated AI choices', () => {
  for (const requirement of [
    /用户实际选择的cameraTerms及具体运镜要求是真实创作输入/u,
    /明确的必选或指定镜头要求按其范围遵守/u,
    /选择了多个效果不等于每镜同时叠加所有/u,
    /不能把用户选择全部丢掉/u,
    /未选择运镜时，仍由你按本镜信息目标自主选择/u,
    /不能回退为每镜固定同一种默认跟拍/u,
    /每镜在现有camera写出景别、必要的机位\/视角/u,
    /在purpose或camera用简短可执行语句落实选择理由/u,
    /不强制正脸覆盖/u,
  ]) assert.match(VIDEO_CAMERA_SELECTION_RULE, requirement);
});

test('lighting is scene-driven with world-source continuity rather than fixed camera-side or numeric presets', () => {
  for (const requirement of [
    /用户选择的lightingTerms及明确光影要求/u,
    /没有选择也要自主给出符合情境的具体光影/u,
    /保持世界中的主光源方位和时间连续/u,
    /不把每镜同一句“左侧光”当成光源连续/u,
    /原剧情需要阴影或强烈风格时照常保留/u,
    /不凭空新增灯具、天气或昼夜变化/u,
    /不强制固定色温数值或明暗比/u,
    /在已有lighting及镜内光影文字/u,
  ]) assert.match(VIDEO_MOTIVATED_LIGHTING_RULE, requirement);
});

test('decisions fit existing shot fields and H3 sections without a new report or schema', () => {
  for (const requirement of [
    /现有逐镜内容/u,
    /purpose、action、performance、direction、space、camera、lighting、transition、result/u,
    /保持既有数据结构/u,
    /H3稿将这些内容融入当前每个\[Shot N\]的现有段落/u,
    /保持既有H3顶层section名称、顺序、参考标签和输出格式/u,
    /时间切点保持已确认排程/u,
    /仅本次指令明确授权taskAuthority=current-segment-staging-replan时/u,
    /切点以同时交付的修正canonicalPrompt为准/u,
    /用户固定段长与exact镜数仍不变/u,
    /不新增表演审查、空间地图、运镜理由等H3顶层字段或附录/u,
    /不输出内部推理链/u,
  ]) assert.match(VIDEO_ACTING_CAMERA_FIELD_RULE, requirement);
});

test('AI self-review repairs the full prompt without local semantic gates or paid video reruns', () => {
  for (const requirement of [
    /同一AI对照当前段原文/u,
    /实际选择的运镜\/光影/u,
    /表演是否有触发依据和自然变化/u,
    /机位和视向是否确实能看到所写背景/u,
    /在当前阶段允许的字段和边界内修正/u,
    /保留本来合理的强烈表演、固定镜头、正面跟拍和背景变化/u,
    /复核修复后返回完整最终正文/u,
    /全部内容判断由AI完成/u,
    /不增加本地语义拦截、关键词否决或表情\/镜数配额/u,
    /不要求先生成视频或重新运行收费视频/u,
  ]) assert.match(VIDEO_ACTING_CAMERA_REVIEW_RULE, requirement);
});

test('translation preserves confirmed acting and camera-space distinctions without replanning', () => {
  assert.equal(VIDEO_ACTING_CAMERA_TRANSLATION_RULE.split(SPATIAL_TRANSLATION_RULE).length - 1, 1);
  assert.equal(VIDEO_ACTING_CAMERA_RULES.includes(SPATIAL_TRANSLATION_RULE), false);
  for (const requirement of [
    /已确认中文H3为唯一执行稿/u,
    /逐镜表演幅度、触发和回落/u,
    /说话与倾听归属、世界路线、人物朝向、机位视向、可见背景/u,
    /准确区分人物向目的地前进与摄影机向后退拍/u,
    /保留中文已经明确的强烈情绪或静止状态/u,
    /只修复翻译遗漏与歧义/u,
    /不另作镜数、机位、剧情或光影设计/u,
    /不改变H3 section、参考标签、\[Shot N\]和At切点/u,
  ]) assert.match(VIDEO_ACTING_CAMERA_TRANSLATION_RULE, requirement);
});

for (const { name, run } of tests) {
  run();
  console.log(`PASS ${name}`);
}
console.log(`videoActingCameraRules: ${tests.length} tests passed (text contracts only, no API or media calls).`);

import assert from 'node:assert/strict';
import { requestShotRecommendation } from '../src/services/llm';
import { buildShots, renderShotPrompt } from '../src/promptEngine';
import { composeDerivedLocalPrompt, convertStoryboardDraftToFinal } from '../src/appEffects';
import { generateSingleSegmentPrompt, type SingleSegmentPromptStage } from '../src/singleSegmentPrompt';
import { getH3PromptProtocolIssue, readH3PromptProtocol, repairH3PromptProtocolWithAi } from '../src/h3PromptProtocol';
import { hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import { VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE,
  VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE, VIDEO_ACTION_CAUSALITY_RULE,
  VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE, withVideoActionChoreographyScope } from '../src/videoActionChoreographyRules';
import { generateSeedanceBilingualOutput, getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import { regenerateSequenceReferencePrompt } from '../src/sequenceReferencePrompt';
import { resolveConfirmedMasterSliceSource } from '../src/confirmedMasterSliceSource';
import { masterPromptConfirmationFingerprint } from '../src/masterTimeline';
import { sliceMasterShotsForSegment } from '../src/sequencePlan';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { SemanticSegmentSourceContext } from '../src/semanticSequencePlan';
import { assertH3DescriptionLanguage } from './fixtures/h3LanguageContract';
import type { AiStoryboardShotPlan, Character, ConverterPreset, ReferenceAsset, Scene, Storyboard, StylePreset, TextApiConfig, VideoSegment, VideoSequencePlan } from '../src/types';

// All responses are deterministic transport fixtures. This test neither reads
// user projects nor generates videos, and cannot measure model motion quality.
type Scope = 'generation' | 'existing' | 'translation';
const rules = [VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE,
  VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE];
const assertScope = (system: string, scope: Scope): void => {
  const selected = rules[scope === 'generation' ? 0 : scope === 'existing' ? 1 : 2];
  for (const rule of rules) assert.equal(system.split(rule).length - 1, rule === selected ? 1 : 0,
    `request receives only the ${scope} action authority, once`);
};
const block = (user: string, tag: string): any => {
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `missing production data envelope ${tag}`);
  return JSON.parse(match[1]);
};
const clean = (value: string): string => value.trim();
const dialogue = '停下，先听我说。';
const storyParts = [
  `沈衡左脚踏入，右拳打向陆青肩侧；陆青抬左前臂挡开，身体向右侧移。沈衡收拳，说：“${dialogue}”`,
  '陆青跨步绕到沈衡左侧，再伸右手推向沈衡上臂；沈衡退半步卸力，二人保持清醒，没有人受伤或倒地。',
];
const story = storyParts.join('');
const plannedShots: AiStoryboardShotPlan[] = storyParts.map((sourceExcerpt, index) => ({
  startSec: index * 4, endSec: (index + 1) * 4, sourceExcerpt, subject: '沈衡与陆青',
  action: index === 0 ? '沈衡左脚踏入，右拳打向陆青肩侧→陆青左前臂挡开并右移→沈衡收拳后开口'
    : '陆青跨步绕至沈衡左侧→右手推沈衡上臂→沈衡退半步卸力并重新站稳',
  purpose: '呈现原文已发生的攻防', camera: '稳定侧向中全景，可见双方脚步与前臂', transition: '沿动作结果承接',
  lighting: '日光', sound: index === 0 ? '第0.8s短促格挡接触声' : '第1s脚步与衣料声',
  result: index === 0 ? '沈衡收拳，陆青站在其右前侧' : '沈衡退半步站稳，双方未受伤',
  space: '空旷庭院，沈衡在画面左侧，陆青在右侧', direction: '双方相向，按原文移动',
  performance: '完成攻防后保持平衡', dialogue: index === 0 ? `第2.5s–3.8s @沈衡：“${dialogue}”` : '无',
}));
const style: StylePreset = { id: 'action-test-style', name: '动作测试', category: 'test', visual: '写实',
  camera: '清晰动作', lighting: '日光', sound: '剧情内声音', updatedAt: 1 };
const converter: ConverterPreset = { id: 'action-test-converter', name: '用户自定义转换器', workflow: 'all', inputMode: 'all',
  scope: 'video', enabled: true, version: 'custom', systemPrompt: '保留用户选择的视角与全部原话。', outputRules: '输出完整普通六字段。', updatedAt: 1 };
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-test-key', model: 'synthetic-model', temperature: .2, maxTokens: 8192, vision: false };
const references: ReferenceAsset[] = [1, 2].map((index) => ({ id: `action-ref-${index}`, name: `人物参考${index}`,
  type: 'reference', role: 'character', mediaType: 'image', source: 'upload', dataUrl: 'data:image/png;base64,AA==',
  visualAnchor: index === 1 ? '沈衡穿灰色衣服' : '陆青穿蓝色衣服', tags: [], createdAt: 1, updatedAt: 1 }));
const makeBoard = (plan = { shots: plannedShots }, fullReference = false, shotMode: 'exact' | 'auto' = 'exact', content = story, durationSec = 8): Storyboard => {
  const assets = fullReference ? structuredClone(references) : [];
  const scene: Scene = { id: 'action-test-scene', title: '庭院', content, summary: '', characterIds: [], locationIds: [],
    propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 };
  const shots = buildShots({ scene, characters: [], locations: [], props: [], assets, workflow: 'action', durationSec,
    shotMode, shotCount: plan.shots.length, pace: 'tight', camera: style.camera, lighting: style.lighting,
    style, extra: '', aiPlan: plan });
  shots.forEach((shot) => { shot.prompt = renderShotPrompt(shot, durationSec, assets, shots); });
  const canonical = shots.map((shot) => shot.prompt).join('\n');
  return { id: 'action-test-board', sceneId: scene.id, sourceStoryContent: content, workflow: 'action', inputMode: fullReference ? 'text_reference' : 'text',
    durationSec, durationPreset: 'custom', shotMode, shotCount: shots.length, pace: 'tight', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    stylePresetId: style.id, ruleSetId: '', converterPresetId: converter.id, globalLock: '身份与服装保持，实际动作按剧情推进',
    shots, finalPrompt: canonical, createdAt: 1, updatedAt: 1,
    targetModelId: 'minimax-h3', targetOutput: { targetId: 'minimax-h3', prompt: '', parameters: { seed: 778899, steps: 20 }, referenceManifest: [], warnings: [], generatedAt: 1 },
    promptPlan: { canonicalPrompt: canonical, durationSec, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', workflow: 'action',
      inputMode: fullReference ? 'text_reference' : 'text', shotIds: shots.map((shot) => shot.id), referenceAssetIds: assets.map((asset) => asset.id),
      constraints: [], trace: { ruleSetId: '', converterId: converter.id } } };
};
const h3Body = (fullReference: boolean, english = false): string => {
  const subject = fullReference ? ['<Subject 1>', '<Subject 2>'] : ['沈衡', '陆青'];
  const body = english
    ? `[Shot 1] Cinematic medium-wide shot. ${subject[0]} steps in on his left foot and drives his right fist toward ${subject[1]}'s shoulder; ${subject[1]} deflects it with her left forearm and shifts right. ${subject[0]} retracts his fist, then (S1) says at 2.5 seconds: <d>[Chinese] ${dialogue}</d>\n[Shot 2] At 00:04.000, the camera cuts to a side view. ${subject[1]} steps around to ${subject[0]}'s left and pushes his upper arm with her right hand; ${subject[0]} takes half a step back, absorbs the push and regains his balance. Both remain uninjured.`
    : `[Shot 1] 写实中全景。${subject[0]}左脚踏入，右拳打向${subject[1]}肩侧；${subject[1]}抬左前臂挡开并向右侧移。${subject[0]}收拳后于第2.5s (S1)说：<d>[Chinese] ${dialogue}</d>\n[Shot 2] At 00:04.000, 镜头切到侧景。${subject[1]}跨步绕至${subject[0]}左侧，右手推其上臂；${subject[0]}退半步卸力并恢复平衡。双方未受伤。`;
  return [
    ...(fullReference ? [
      `subject_definitions: <Subject 1> ${english ? 'is 沈衡 in' : '是沈衡，来自'} <Picture 1>. <Subject 2> ${english ? 'is 陆青 in' : '是陆青，来自'} <Picture 2>.`,
      `summary: [reference generation] ${english ? '沈衡 and 陆青 complete the authored exchange.' : '沈衡与陆青完成原文攻防。'}`,
      'retention_analysis: <Subject 1> appears in [Shot 1], [Shot 2]: fully_preserved. <Subject 2> appears in [Shot 1], [Shot 2]: fully_preserved.',
    ] : []),
    `${fullReference ? 'detailed_description' : 'integrated_multimodal_description'}: ${body}`,
    `overall_soundscape: ${english ? 'Brief forearm contact, followed by the authored footsteps and fabric movement.' : '短促前臂接触声，随后是原定脚步及衣料声。'}`,
    'non_diegetic_music: N/A',
  ].join('\n\n');
};
const envelope = (h3Prompt: string, board?: Storyboard): string => JSON.stringify({ h3Prompt,
  identityBindings: { version: 1, characters: [] }, characterParticipation: { version: 1, characters: [] },
  ...(board ? { canonicalPrompt: board.finalPrompt, shotSourceIds: board.shots.map((shot) => [shot.id]), shotMetadata: board.shots.map(() => null) } : {}) });

// Two indirect interactions exercise separate roles: the object receiving the
// contact is not the person receiving its subsequent motion. Responses are
// authored fixtures, not an assertion that a video model follows the prompt.
const eventCases = [{
  actor: '绝死绝命', object: '精灵王尸体', target: '马雷', verb: '踢',
  parts: ['绝死绝命站在殿内，精灵王尸体静止在她脚前，马雷站在门口面向她。',
    '绝死绝命把精灵王尸体踢向马雷。', '马雷轻松侧身，尸体从他身旁飞过并撞上后方墙壁。',
    '绝死绝命收回踢出的腿站稳。', '马雷看向绝死绝命，保持冷静。', '两人仍在各自的位置，没有对白。'],
  actions: ['双方沿殿内至门口的同一轴线站立，尸体静止在绝死绝命脚前',
    '绝死绝命左脚支撑，右腿低位踢出，右战靴踢中精灵王尸体躯干；尸体接触后离地沿通道飞向马雷',
    '马雷在尸体逼近时侧身让开；尸体从他身旁按原方向掠过并撞上后方墙壁',
    '绝死绝命收右腿并在原处站稳', '马雷看向殿内的绝死绝命，保持冷静', '两人沿原世界位置静止等候'],
  english: ['Zesshi stands inside the hall; the Elf King corpse remains still at her feet. Mare faces her from the doorway.',
    'Zesshi braces on her left foot and swings her right leg low. Her right boot strikes the Elf King corpse at the torso; only after this contact does it lift off and travel along the corridor toward Mare.',
    'As the corpse approaches, Mare steps aside. It passes him along the established direction and hits the wall behind him.',
    'Zesshi retracts her right leg and regains balance in her original place.', 'Mare calmly looks toward Zesshi inside the hall.',
    'Both remain at their established world positions, without dialogue.'],
  result: '马雷侧身避开，尸体撞上后方墙壁；两人保持原世界位置',
}, {
  actor: '沈衡', object: '布袋', target: '陆青', verb: '抛',
  parts: ['沈衡在庭院台阶前手持布袋，陆青站在台阶右侧面向他。', '沈衡把布袋抛给陆青。',
    '陆青看见布袋靠近，伸手接住。', '沈衡收回手臂。', '陆青把接住的布袋抱在身前。', '两人站稳，没有其他动作和对白。'],
  actions: ['沈衡持袋站在台阶前，陆青站在台阶右侧，袋在沈衡手中',
    '沈衡双脚支撑，右手握住布袋随手臂向陆青摆动，松手后布袋沿低弧线飞向陆青',
    '陆青在布袋靠近时伸出双手，手掌接触袋体后屈肘缓冲，将袋接稳',
    '沈衡收回已松开的右手，仍站在台阶前', '陆青持袋抱在身前，不改变台阶右侧的位置', '两人保持站位与持袋状态'],
  english: ['Shen Heng holds the bag in front of the courtyard steps. Lu Qing faces him from the right side of the steps.',
    'Shen Heng braces on both feet. His right hand grips the bag as his arm swings toward Lu Qing; after he releases it, the bag follows a low arc toward her.',
    'Lu Qing extends both hands as the bag approaches. Her palms contact the bag, then her elbows flex to absorb its motion and secure it.',
    'Shen Heng retracts his released right hand while remaining in front of the steps.', 'Lu Qing holds the bag in front of her at the right side of the steps.',
    'Both keep their established positions and the bag remains held by Lu Qing, without dialogue.'],
  result: '陆青接住并抱稳布袋，双方站位保持',
}];
const eventTimes = [0, 6, 11, 16, 22, 29, 35];
const assertEventDirection = (system: string, translation = false): void => {
  for (const concept of [/直接受力对象/u, /最终具名目标/u, /支撑.*发力/u, /接触.*运动/u, /世界站位|世界关系/u]) {
    assert.match(system, concept, 'the existing writer receives explicit actor/object/target and causal motion direction');
  }
  assert.match(system, translation ? /不补中文未写/u : /摄影.*动作辨认/u,
    translation ? 'translation preserves the approved enactment instead of designing a new action' : 'camera framing must expose the enacted contact');
};

// Frozen pre-change complete first-party block as it may appear in a user preset.
const legacyGenerationRule = [
  'VIDEO_ACTION_CHOREOGRAPHY_V1：结合本段原剧情与用户导演要求判断动作场面的实际强度。连续攻防、追逐、摔投或高频位移必须在镜内实际发生，不把已发生的战斗弱化为站立对峙、摆架势、准备出手、眼神交锋或只有音效的反应特写；普通交谈、轻微动作与原文明确的静止、蓄势、停顿仍照原意保留，不为增强动感把所有剧情改成武打。',
  '同一事件的可摄影展开不是新增剧情：原文只概述双方激烈交战时，在本次获准规划或生成的范围内，可以明确该次交战必要的起手、移动、攻防轨迹、招架或闪避、接触反馈与动作承接。人物、攻击意图、具名对象、武器、能力、已成立的先后、强度、伤情与结局是事实锁；不能凭空增加胜负、致死、断肢、受伤、新招式能力、新人物、新武器或另一场战斗。已有具体招式与结果按原文拍出来，不因套用常规打法替换。',
  '双人攻防写成互相作用的连续过程：明确谁从什么位置向哪位具名对象及哪个可见目标发起，攻击沿什么方向前进，对方怎样挡开、避让、接住或承受，真实接触如何改变双方的姿势、距离、重心或运动方向，下一动作怎样从当前状态接续。在现有镜内用清楚先后及必要的本段动作时间窗落实连续交换，不用“激烈打斗”概述代替过程，也不把每一拳都新增成At切点。落空就写实际避让和落空，格挡不等于命中，不能把未中写成击倒。选择当前动作必要的支撑、躯干传力、阻力、随动和恢复，避免只有手臂摆动、滑步、瞬移、碰撞后双方僵住或每招重新摆回起手式；不要求每招凑齐固定阶段。',
  '多人近身战斗按实际时序交代可辨的主要攻防关系、参与者方位和其他人的同步状态；换目标、交替夹击或连锁受力时明确具名行动者与对象，不把所有人写成同时扑向同一点或用“众人混战”替代已经成立的动作。可在同镜连续转换观察重点，不设每镜人数上限，不删除原文参与者；被遮挡或画外的动作按既有空间交代，不能凭摄影需要改变攻击来源或结果。',
  '摄影让实际动作可见：按招式和场景选择能读清双方距离、运动轨迹与接触点的景别、机位和必要跟随，在适用镜头保留全身或关键肢体的可见范围；并非每镜都必须全身，也不禁止原文需要的特写。复杂身体交互不要无动机地同时叠加急推、环绕、摇晃和遮挡，不用快速切脸、镜头震动、火花、慢动作或拟音替代真实攻防。原文或用户明确要求的慢动作、特写及风格化运镜保留，按其范围落实。',
  '动作节奏与时长由当前事件因果决定，不按每秒动作数、固定动作阶段、字数或最低镜数安排。没有叙事作用的反复蓄势、站立和慢推不要填满动作段；有依据的观察、喘息、停顿和收束保留。只在本次明确授权的源头规划或未确认新稿排程内调整镜长和覆盖：固定durationSec不变，exact镜数不变，auto才可在授权范围改变镜数；同步canonicalPrompt与H3及相关时间字段。已确认切点、参考更新、衔接、翻译或纯格式修复不因本规则获得重新导演权限。完整原对白、原语言、具名声源和口部互斥动作保持，不靠抢话或删句腾出动作时间。',
  '物理与风格服从原剧情：写实战斗保留可见支撑、惯性与接触反馈；武侠、仙侠、动漫、超能力或非人角色按原文及已选风格表达已有的飞行、轻功、能量和身体结构，不将明确幻想能力强改成现实限制，也不凭“激烈”补出未设定能力。参考图只提供其实际身份、服装、场景或构图职责，不锁住静态姿势；动作参考仅使用本次真实提供且接口实际接收的素材，不虚构Video或Picture引用。',
  '在本次已有回答内部核对并修复动作遗漏：行动者、目标、进攻与回应、命中或落空、可见受力、位移、下一动作和结果是否沿同一事件推进；声音贴合真实动作，不靠声音冒充动作。保留本来准确的动作与剧情，不为了丰富而加招。规划使用现有action、space、direction、performance、camera、transition、result字段；普通转换继续现有六字段格式；H3只把内容融入对应[Shot N]的integrated_multimodal_description或detailed_description。保持既有三字段或full-reference六字段模式、字段名称顺序、Subject/Picture/Video/Audio标签、S声源、<d>与原对白；首镜无At、后镜At切点按本次合法排程，不新增combat_plan、action_sequence、negative_prompt、审核说明、规则正文或附录。不增加独立审核调用，不要求先运行视频，不用本地关键词拦截判断动作好坏。',
].join('\n\n');

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const converterBefore = structuredClone(converter);
let groups = 0;
try {
  globalThis.fetch = async () => { throw new Error('Unexpected real network in action transport test'); };
  // Execute actual planning transport and materialization before the production
  // canonical -> Chinese review/checkpoint -> English stages, in both modes.
  for (const fullReference of [false, true]) {
    const planningRequests: Array<{ system: string; user: string }> = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
      request: async (payload: { body?: string }) => {
        const messages = JSON.parse(payload.body!).messages;
        const system = messages.find((message: any) => message.role === 'system').content;
        const user = messages.find((message: any) => message.role === 'user').content;
        assertScope(system, 'generation');
        const data = block(user, planningRequests.length ? 'storyboard_ai_review_data' : 'storyboard_planning_data');
        assert.equal(data.sourceStory, story); assert.equal(data.durationSec, 8);
        assert.equal(data.requiredShotCount, fullReference ? undefined : 2);
        if (planningRequests.length) assert.deepEqual(JSON.parse(data.originalStoryboardResponse).shots, plannedShots);
        planningRequests.push({ system, user });
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reason: '按原文攻防安排', shots: plannedShots }) } }] }) };
      },
    } } });
    const plan = await requestShotRecommendation(config, { durationSec: 8, story, workflow: 'action', pace: 'tight',
      ...(fullReference ? {} : { requiredShotCount: 2 }) }, { reviewWithAi: true });
    assert.equal(planningRequests.length, 2, 'the pre-existing planning/review calls gain no extra stage');
    assert.deepEqual(plan.shots, plannedShots);
    const board = makeBoard(plan, fullReference, fullReference ? 'auto' : 'exact');
    const before = structuredClone(board);
    const context = { assets: fullReference ? references : [], characters: [] };
    const zh = h3Body(fullReference); const en = h3Body(fullReference, true);
    const stages: SingleSegmentPromptStage[] = [];
    let checkpoint: Storyboard | undefined;
    const result = await generateSingleSegmentPrompt({ board, context, converter, reviewWithAi: true, clean, now: () => 123,
      onQualifiedChinese: (value) => { checkpoint = structuredClone(value); assert.equal(value.officialPromptZh, zh); assert.equal(value.officialPromptEn, ''); },
      request: async (system, user, stage) => {
        stages.push(stage); assertScope(system, stage === 'translate' ? 'translation' : 'generation');
        if (stage === 'convert') {
          const data = block(user, 'video_conversion_data');
          assert.equal(data.sourceStoryContent, story);
          assert.deepEqual(data.shotEvidence.map((shot: any) => [shot.plannedAction, shot.plannedResult]), board.shots.map((shot) => [shot.action, shot.result]));
          assert.deepEqual(block(user, 'current_reference_data').currentReferences.map((ref: any) => ref.id), context.assets.map((asset) => asset.id));
          return board.finalPrompt;
        }
        assertH3DescriptionLanguage(system, stage === 'review' ? '中文' : '英文');
        if (stage === 'review') {
          const data = block(user, 'video_staging_review_data');
          assert.equal(data.sourceStoryContent, story); assert.equal(data.taskAuthority, 'current-segment-staging-replan');
          assert.equal(data.shotMode, board.shotMode);
          return envelope(zh, board);
        }
        assert.ok(checkpoint, 'Chinese must be saved before English starts');
        const sourcePrompt = user.includes('<review_data>') ? block(user, 'review_data').sourcePrompt
          : user.includes('<translation_identity_data>') ? block(user, 'translation_identity_data').sourcePrompt : user;
        assert.equal(sourcePrompt, zh, 'translation and its existing review use the same complete Chinese execution text');
        return envelope(en);
      } });
    assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate']);
    assert.equal(result.officialPromptZh, zh); assert.equal(result.officialPromptEn, en); assert.equal(result.officialPromptEnSource, zh);
    assert.equal(result.finalPrompt, board.finalPrompt); assert.ok(hasCurrentOfficialH3Prompt(result, context));
    assert.equal(result.durationSec, 8); assert.equal(result.shotMode, board.shotMode);
    assert.deepEqual(result.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.referenceAssetIds]), board.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.referenceAssetIds]));
    assert.equal(result.targetOutput?.parameters.seed, 778899);
    assert.deepEqual(readH3PromptProtocol(zh), readH3PromptProtocol(en));
    assert.equal(getH3PromptProtocolIssue(en, zh), undefined);
    assert.deepEqual(readH3PromptProtocol(zh)?.sections.length, fullReference ? 6 : 3);
    for (const body of [result.finalPrompt, zh, en]) assert.doesNotMatch(body, /VIDEO_ACTION_CHOREOGRAPHY|combat_plan|action_sequence|negative_prompt/u);
    assert.ok(en.includes(`(S1) says at 2.5 seconds: <d>[Chinese] ${dialogue}</d>`));
    assert.deepEqual(board, before, 'generation preserves the input snapshot');

    // Existing confirmed canonical master slices may be reviewed and translated,
    // but cannot inherit new choreography permission or rerun conversion.
    const existingBefore = structuredClone(result); const reuseStages: SingleSegmentPromptStage[] = [];
    let confirmedCandidate = '';
    const reused = await generateSingleSegmentPrompt({ board: result, context, converter, skipConversion: true, reviewWithAi: true, clean,
      request: async (system, user, stage) => {
        reuseStages.push(stage); assertScope(system, stage === 'translate' ? 'translation' : 'existing');
        assert.notEqual(stage, 'convert');
        if (stage === 'review') { const data = block(user, 'video_staging_review_data'); assert.equal(data.taskAuthority, 'preserve-confirmed-schedule'); confirmedCandidate = data.candidatePrompt; return envelope(confirmedCandidate); }
        return envelope(en);
      } });
    assert.deepEqual(reuseStages, ['review', 'translate', 'translate']);
    assert.equal(reused.finalPrompt, result.finalPrompt); assert.equal(reused.officialPromptZh, confirmedCandidate); assert.equal(reused.officialPromptEn, en);
    assert.deepEqual(reused.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]), result.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]));
    assert.deepEqual(result, existingBefore, 'reuse never mutates the saved input');
    const englishOnlyStages: SingleSegmentPromptStage[] = [];
    const englishOnly = await generateSingleSegmentPrompt({ board: result, context, converter, mode: 'translate-english', reviewWithAi: true, clean,
      request: async (system, user, stage) => { englishOnlyStages.push(stage); assertScope(system, 'translation');
        const data = user.includes('<review_data>') ? block(user, 'review_data') : block(user, 'translation_identity_data');
        assert.equal(data.sourcePrompt, zh); return envelope(en); } });
    assert.deepEqual(englishOnlyStages, ['translate', 'translate']);
    assert.equal(englishOnly.officialPromptZh, zh); assert.equal(englishOnly.finalPrompt, result.finalPrompt);
    assert.deepEqual(englishOnly.shots, result.shots); assert.deepEqual(result, existingBefore);
    groups += 2;
  }

  for (const event of eventCases) {
    const content = event.parts.join('');
    const eventPlan: AiStoryboardShotPlan[] = event.parts.map((sourceExcerpt, index) => ({
      ...plannedShots[0], sourceExcerpt, startSec: eventTimes[index], endSec: eventTimes[index + 1],
      subject: `${event.actor}与${event.target}`, action: event.actions[index], result: index === 2 ? event.result : event.actions[index],
      space: event.parts[0], direction: `${event.actor}通过${event.object}作用于${event.target}`,
      camera: '稳定侧向中全景，保留支撑脚、发力肢体、接触点与通向目标的路径', dialogue: '无',
      purpose: '呈现本段原剧情的同一间接受力事件', transition: '从上一镜物体轨迹与人物状态连续承接',
    }));
    const semantic: SemanticSegmentSourceContext = {
      kind: 'semantic-segment-source-v1', sourceStoryTitle: '间接受力动作', sourceContentHash: 'synthetic-event-source',
      segmentIndex: 1, segmentCount: 8, segmentDurationSec: 35, generationStoryContent: content,
      shotMode: 'exact', shotCount: 6, creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '看清动作接触与空间关系' },
      characterContinuity: [], segment: {
        title: '当前动作', content, summary: '同一间接受力事件', narrativePurpose: '动作因果清晰',
        entryState: event.parts[0], exitState: event.result, transitionHint: '动作结束后站位继承', boundaryReason: '事件阶段完整', continuityPack: event.result,
        semanticSource: { sourceEvidence: [{ text: content }], dialogues: [], events: [{ id: 'indirect-event', description: event.parts[1], phase: '施力与回应',
          causality: { actor: event.actor, target: event.target, action: `${event.verb}${event.object}向${event.target}`, result: event.result,
            evidence: `${event.parts[1]}${event.parts[2]}`, certainty: 'explicit' } }] },
      }, storyUnderstandingContext: { usage: 'understanding-only', sourceStoryContent: `${content}后续段另有相遇，不属于本段。`,
        characterIdentities: [{ name: event.actor }, { name: event.target }], instruction: '理解人物与因果，不扩展当前段事件。' },
    };
    const semanticBefore = structuredClone(semantic);
    const causality = semantic.segment.semanticSource.events[0].causality;
    let planningCalls = 0;
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
      request: async (payload: { body?: string }) => {
        const messages = JSON.parse(payload.body!).messages;
        const system = messages.find((message: any) => message.role === 'system').content;
        const user = messages.find((message: any) => message.role === 'user').content;
        assertScope(system, 'generation'); assertEventDirection(system);
        const data = block(user, planningCalls ? 'storyboard_ai_review_data' : 'storyboard_planning_data');
        assert.equal(data.sourceStory, content); assert.equal(data.durationSec, 35); assert.equal(data.requiredShotCount, 6);
        assert.deepEqual(data.sequenceSegmentContext.segment.semanticSource.events[0].causality, causality);
        planningCalls++;
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reason: '明确施力物和目标', shots: eventPlan }) } }] }) };
      },
    } } });
    const plan = await requestShotRecommendation(config, { durationSec: 35, story: content, workflow: 'action', pace: 'tight', requiredShotCount: 6,
      sequenceSegmentContext: semantic as unknown as Record<string, unknown> }, { reviewWithAi: true });
    assert.equal(planningCalls, 2); assert.deepEqual(plan.shots, eventPlan);
    const board = makeBoard(plan, false, 'exact', content, 35);
    Object.assign(board, { sequencePlanId: 'event-sequence', segmentId: 'event-segment', segmentIndex: 1, segmentCount: 8, globalStartSec: 0, globalEndSec: 35 });
    const confirmedCanonical = board.finalPrompt;
    // The source can disagree with an ambiguous draft: a location is not an
    // authored recipient. The actual writer receives both, with source scope.
    board.finalPrompt = board.finalPrompt.replace(`向${event.target}`, '向门口');
    const boardBefore = structuredClone(board);
    const h3 = (english = false): string => [
      `integrated_multimodal_description: ${(english ? event.english : event.actions).map((action, index) =>
        `[Shot ${index + 1}] ${index ? `At 00:${String(eventTimes[index]).padStart(2, '0')}.000, ` : ''}${action}`).join('\n')}`,
      `overall_soundscape: ${english ? 'Contact and the authored object motion, without dialogue.' : '接触与原定物体运动声音，无对白。'}`,
      'non_diegetic_music: N/A',
    ].join('\n\n');
    const zh = h3(); const en = h3(true);
    const eventStages: SingleSegmentPromptStage[] = [];
    const result = await generateSingleSegmentPrompt({ board, context: { assets: [], characters: [] }, converter, sequenceSegmentContext: semantic,
      reviewWithAi: true, clean, request: async (system, user, stage) => {
        eventStages.push(stage); assertScope(system, stage === 'translate' ? 'translation' : 'generation');
        assertEventDirection(system, stage === 'translate');
        if (stage === 'translate') {
          assert.doesNotMatch(user, /<semantic_segment_source_data>/u, 'translation cannot use source understanding to invent missing choreography');
          const data = block(user, user.includes('<review_data>') ? 'review_data' : 'translation_identity_data');
          assert.equal(data.sourcePrompt, zh); return envelope(en);
        }
        const source = block(user, 'semantic_segment_source_data').sequenceSegmentContext;
        assert.deepEqual(source.segment.semanticSource.events[0].causality, causality);
        assert.deepEqual(source.storyUnderstandingContext, semantic.storyUnderstandingContext);
        const data = block(user, stage === 'convert' ? 'video_conversion_data' : 'video_staging_review_data');
        assert.equal(data.sourceStoryContent, content);
        if (stage === 'convert') {
          assert.equal(data.shotEvidence.length, 6);
          assert.deepEqual(data.shotEvidence.map((shot: any) => [shot.globalStartSec, shot.globalEndSec]), eventPlan.map((shot) => [shot.startSec, shot.endSec]));
          assert.ok(system.includes(converter.systemPrompt)); return confirmedCanonical;
        }
        assert.equal(data.durationSec, 35);
        assert.equal(data.taskAuthority, 'current-segment-staging-replan'); assert.equal(data.shotMode, 'exact'); assert.equal(data.shotCount, 6);
        return envelope(zh, { ...board, finalPrompt: confirmedCanonical });
      } });
    assert.deepEqual(eventStages, ['convert', 'review', 'translate', 'translate'], 'action direction adds no model call');
    assert.equal(result.finalPrompt, confirmedCanonical); assert.equal(result.officialPromptZh, zh); assert.equal(result.officialPromptEn, en);
    assert.equal(result.durationSec, 35); assert.equal(result.shotCount, 6);
    assert.deepEqual(result.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]), board.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]));
    assert.deepEqual(readH3PromptProtocol(zh), readH3PromptProtocol(en));
    assert.deepEqual(board, boardBefore); assert.deepEqual(semantic, semanticBefore);

    const seedanceInput = { targetId: 'seedance-2.5', durationSec: 35, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      canonicalPrompt: result.finalPrompt, references: [], constraints: [],
      sourceEvidence: { sourceStoryContent: content, sequenceSegmentContext: semantic, shotMode: 'exact', shotCount: 6 } };
    const seedanceBefore = structuredClone(seedanceInput);
    const seedance = (english = false): string => [
      english ? 'Video specification: duration 35 seconds; aspect ratio 16:9; resolution 2K; stereo.' : '视频规格：时长35秒；16:9；2K；stereo。',
      english ? 'References and responsibilities: no external references.' : '参考素材与职责：没有外部参考素材。',
      english ? 'Subject continuity: keep the established identities and world positions.' : '主体连续性：保持已建立身份与世界站位。',
      english ? 'One-sentence summary: the authored object motion and response remain one causal interaction.' : `一句话概述：${event.actor}${event.verb}${event.object}向${event.target}，对方完成原定回应。`,
      `${english ? 'Continuous timeline (covering 0–35 seconds):' : '连续时间轴（覆盖0–35秒）：'}\n${(english ? event.english : event.actions).map((action, index) => `【${eventTimes[index]}s-${eventTimes[index + 1]}s】${action}`).join('\n')}`,
      english ? 'Global constraints: preserve the object contact, direction and established result.' : '全局约束：保持接触、方向与已有结果，不改时间轴。',
    ].join('\n\n');
    let seedanceCalls = 0; let checkpointed = false;
    const seedanceOutput = await generateSeedanceBilingualOutput({ input: seedanceInput,
      onChinese: (output) => { checkpointed = true; assert.equal(output.promptZh, seedance()); return true; }, onEnglish: () => true,
      request: async (system, user) => {
        seedanceCalls++;
        if (seedanceCalls === 1) {
          assert.ok(system.includes(VIDEO_ACTION_CAUSALITY_RULE)); assertEventDirection(system);
          const data = block(user, 'seedance_source_data');
          assert.deepEqual(data.sourceEvidence.sequenceSegmentContext.segment.semanticSource.events[0].causality, causality);
          assert.equal(data.sourceEvidence.sourceStoryContent, content); assert.equal(data.specification.durationSec, 35);
          return seedance();
        }
        assert.ok(checkpointed); assert.ok(system.includes(VIDEO_ACTION_SEEDANCE_TRANSLATION_RULE)); assertEventDirection(system, true);
        assert.ok(!system.includes(VIDEO_ACTION_CAUSALITY_RULE)); assert.ok(user.includes(seedance()));
        return seedance(true);
      } });
    assert.equal(seedanceCalls, 2, 'dedicated Seedance Chinese and English remain the two existing calls');
    assert.equal(seedanceOutput.promptZh, seedance()); assert.equal(seedanceOutput.promptEn, seedance(true));
    assert.deepEqual(seedanceInput, seedanceBefore); assert.deepEqual(semantic, semanticBefore);
    for (const delivered of [result.finalPrompt, zh, en, seedanceOutput.promptZh, seedanceOutput.promptEn!]) {
      assert.doesNotMatch(delivered, /VIDEO_ACTION_|combat_plan|action_sequence|negative_prompt/u);
    }
    groups += 2;
  }

  // A custom preset containing an embedded generation block must lose that
  // permission at an existing-update boundary without editing the preset.
  const embeddedConverter = { ...converter, systemPrompt: `${converter.systemPrompt}\n\n${legacyGenerationRule}\n\n${VIDEO_ACTION_CHOREOGRAPHY_RULE}` };
  const refreshBoard = makeBoard(); const refreshBefore = structuredClone(refreshBoard);
  let refreshCalls = 0;
  const refreshed = await convertStoryboardDraftToFinal({ draft: refreshBoard, converter: embeddedConverter,
    purpose: 'reference-refresh', clean, request: async (system, user) => {
      refreshCalls++; assertScope(system, 'existing'); assert.ok(system.includes(converter.systemPrompt));
      assert.ok(!system.includes(legacyGenerationRule), 'a complete embedded legacy rule cannot carry planning authority into preservation');
      assert.equal(block(user, 'video_conversion_data').sourceStoryContent, story); return refreshBoard.finalPrompt;
    } });
  assert.equal(refreshCalls, 1); assert.equal(refreshed.finalPrompt, refreshBoard.finalPrompt); assert.deepEqual(refreshBoard, refreshBefore);
  assert.ok(embeddedConverter.systemPrompt.includes(VIDEO_ACTION_CHOREOGRAPHY_RULE));
  assert.ok(embeddedConverter.systemPrompt.includes(legacyGenerationRule), 'scope isolation does not rewrite the saved custom converter');
  groups++;

  // Explicit regeneration is fresh action writing even when a proven master
  // supplies provenance. That evidence must still keep the confirmed schedule.
  {
    const master = makeBoard();
    master.id = 'action-master'; master.sequencePlanId = 'action-master-plan'; master.sourceContentHash = sourceContentHash(story);
    let sourceOffset = 0;
    master.shots.forEach((shot, index) => {
      shot.id = `action-master-shot-${index + 1}`; shot.sourceStart = sourceOffset;
      shot.sourceEnd = sourceOffset += storyParts[index].length; shot.sourceExcerpt = storyParts[index]; shot.sourceLocationStatus = 'located';
    });
    master.promptPlan = { ...master.promptPlan!, shotIds: master.shots.map((shot) => shot.id) };
    master.promptTrace = { modelRuleSetId: '', converterPresetId: converter.id, sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1,
      mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(master.finalPrompt) };
    const segment: VideoSegment = { id: 'action-master-segment', index: 1, title: '已确认第一段', globalStartSec: 0, globalEndSec: 4, durationSec: 4,
      content: storyParts[0], summary: '原定攻防', sourceSceneIds: [master.sceneId], sourceBeatIds: [], sourceShotIds: [master.shots[0].id],
      narrativePurpose: '本段事件', entryState: '', exitState: '', transitionHint: '连续动作', status: 'planned' };
    const plan: VideoSequencePlan = { id: master.sequencePlanId, title: '已确认总稿', sourceStoryTitle: '原剧情', sourceStoryContent: story,
      sourceContentHash: sourceContentHash(story), durationMode: 'fixed', requestedTotalDurationSec: 8, totalDurationSec: 8, segmentDurationSec: 4,
      segmentationMode: 'fixed', segmentationSource: 'ai', fitStatus: 'balanced', masterStoryboardId: master.id,
      planningStage: 'segmented', segments: [segment], createdAt: 1, updatedAt: 1 };
    plan.masterPromptConfirmedFingerprint = masterPromptConfirmationFingerprint(plan, master);
    const slice = sliceMasterShotsForSegment(master.shots, segment);
    const canonical = composeDerivedLocalPrompt(slice.shots, segment.entryState, segment.exitState);
    const board: Storyboard = { ...master, id: 'action-master-slice', segmentId: segment.id, segmentIndex: 1,
      globalStartSec: 0, globalEndSec: 4, durationSec: 4, shotCount: 1, shots: slice.shots, finalPrompt: canonical,
      promptPlan: { ...master.promptPlan!, canonicalPrompt: canonical, durationSec: 4, shotIds: slice.shots.map((shot) => shot.id) },
      promptTrace: { ...master.promptTrace!, convertedPromptFingerprint: sourceContentHash(canonical) } };
    const masterSource = { plan, masterBoard: master, segment };
    assert.ok(resolveConfirmedMasterSliceSource(board, masterSource), 'fixture must really qualify as a confirmed master slice');
    const before = structuredClone({ board, masterSource });
    const zh = `integrated_multimodal_description: [Shot 1] 沈衡左脚踏入，右拳打向陆青肩侧；陆青抬左前臂挡开并向右侧移。沈衡收拳后于第2.5s (S1)说：<d>[Chinese] ${dialogue}</d>\n\noverall_soundscape: 短促前臂接触和衣料声。\n\nnon_diegetic_music: N/A`;
    const en = `integrated_multimodal_description: [Shot 1] Shen Heng steps in on his left foot and drives his right fist toward Lu Qing's shoulder; Lu Qing deflects it with her left forearm and shifts right. Shen Heng retracts his fist, then (S1) says at 2.5 seconds: <d>[Chinese] ${dialogue}</d>\n\noverall_soundscape: Brief forearm contact and fabric movement.\n\nnon_diegetic_music: N/A`;
    const stages: SingleSegmentPromptStage[] = [];
    const result = await regenerateSequenceReferencePrompt({ mode: 'regenerate', board, segment, masterSource,
      context: { assets: [], characters: [] }, converter, reviewWithAi: true, clean,
      request: async (system, user, stage) => {
        stages.push(stage); assertScope(system, stage === 'translate' ? 'translation' : 'generation');
        if (stage === 'convert') { assertEventDirection(system); return canonical; }
        if (stage === 'review') {
          assertEventDirection(system); const data = block(user, 'video_staging_review_data');
          assert.equal(data.taskAuthority, 'preserve-confirmed-schedule'); assert.equal(data.durationSec, 4);
          assert.equal(data.shotMode, 'exact'); assert.equal(data.shotCount, 1);
          assert.deepEqual(data.shots.map((shot: any) => [shot.id, shot.startSec, shot.endSec]), [[board.shots[0].id, 0, 4]]);
          return envelope(zh);
        }
        return envelope(en);
      } });
    assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate']);
    assert.equal(result.finalPrompt, canonical); assert.equal(result.officialPromptZh, zh); assert.equal(result.officialPromptEn, en);
    assert.equal(result.durationSec, 4); assert.equal(result.shotCount, 1);
    assert.deepEqual(result.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]), [[board.shots[0].id, 0, 4]]);
    assert.deepEqual({ board, masterSource }, before, 'explicit action rewrite does not mutate the confirmed master, plan or saved slice');
    groups++;
  }

  // Ordinary dialogue and non-combat close interaction are accepted unchanged.
  // Private facts are only those actually selected by a shot, not a combat
  // trigger or authorization to display unselected dossiers.
  for (const { privateSelection, isStill } of [{ privateSelection: false, isStill: false }, { privateSelection: true, isStill: false }, { privateSelection: false, isStill: true }]) {
    const neutralStory = isStill ? '沈衡与陆青静止等候，保持原站姿，不做其他动作，也没有对白。'
      : '沈衡扶住陆青的手背，帮助她站稳，随后松手，说：“谢谢。”二人平静交谈，没有冲突。';
    const board = makeBoard({ shots: plannedShots.map((shot) => ({ ...shot, sourceExcerpt: neutralStory, subject: '沈衡与陆青',
      action: isStill ? '保持原站姿静止等候' : '扶住手背帮助站稳→松手→平静交谈', result: isStill ? '静止等候' : '双方站稳，手已松开',
      purpose: '呈现普通原文事件', performance: isStill ? '原站姿静止等候' : '平静交谈', direction: '面对对方',
      camera: '固定中景', sound: isStill ? '无' : '第1s手背接触的衣料轻响',
      dialogue: isStill ? '无' : '第2.5s @沈衡：“谢谢。”' })) }, false, 'exact', neutralStory);
    const actor: Character = { id: 'neutral-adult', name: '陆青', gender: '女', apparentAge: '成年', race: '人类', appearance: '蓝衣',
      outfit: '长袖外套', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [],
      nsfwProfile: { fullBody: '手背有浅色圆形胎记。' } };
    if (privateSelection) board.shots.forEach((shot) => { shot.visiblePrivatePartsByCharacter = { [actor.id]: ['full-body'] }; });
    const before = structuredClone(board); let calls = 0;
    const result = await convertStoryboardDraftToFinal({ draft: board, converter, characters: [actor], clean,
      request: async (system, user) => {
        calls++; assertScope(system, 'generation');
        assert.match(system, /交谈、观察、静止、蓄势、轻微动作与停顿仍保留/u);
        const data = block(user, 'video_conversion_data'); assert.equal(data.sourceStoryContent, neutralStory);
        for (const shot of data.shotEvidence) assert.equal(shot.selectedPrivateFacts.length, privateSelection ? 1 : 0);
        if (privateSelection) assert.equal(data.shotEvidence[0].selectedPrivateFacts[0].profile.fullBody, actor.nsfwProfile?.fullBody);
        return board.finalPrompt;
      } });
    assert.equal(calls, 1); assert.equal(result.finalPrompt, board.finalPrompt); assert.deepEqual(board, before);
    assert.doesNotMatch(result.finalPrompt, /激烈攻防|拳击|格挡|摔投/u);
    groups++;
  }

  // Existing protocol-repair calls retain content permission and format in both
  // H3 modes. A missing section is repaired once; no action-improvement call.
  for (const fullReference of [false, true]) {
    const expected = h3Body(fullReference); const damaged = expected.replace(/^non_diegetic_music: N\/A$/mu, '');
    let repairCalls = 0;
    const repaired = await repairH3PromptProtocolWithAi({ formatReferencePrompt: expected, candidatePrompt: damaged, language: '中文',
      sourceContext: { sourcePrompt: expected, sourceStoryContent: story }, request: async (system, user) => {
        repairCalls++; assertScope(system, 'existing'); assertH3DescriptionLanguage(system, '中文');
        const data = block(user, 'h3_format_repair_data'); assert.equal(data.sourceContext.sourcePrompt, expected);
        assert.equal(data.candidatePrompt, damaged.trim()); assert.deepEqual(data.requiredProtocol.references, readH3PromptProtocol(expected)?.references);
        return expected;
      } });
    assert.equal(repairCalls, 1); assert.equal(repaired, expected); assert.equal(getH3PromptProtocolIssue(repaired, expected), undefined);
    groups++;
  }
  // Malformed JSON uses the existing transport recovery, with preservation
  // authority even though the first review was allowed to direct a new draft.
  {
    const board = makeBoard(); const before = structuredClone(board); let reviews = 0;
    const stages: SingleSegmentPromptStage[] = [];
    const result = await generateSingleSegmentPrompt({ board, context: { assets: [], characters: [] }, converter, reviewWithAi: true, clean,
      request: async (system, user, stage) => {
        stages.push(stage);
        if (stage === 'convert') { assertScope(system, 'generation'); return board.finalPrompt; }
        if (stage === 'review') {
          reviews++; assertScope(system, reviews === 1 ? 'generation' : 'existing');
          if (reviews === 1) return '{unreadable JSON';
          const data = block(user, 'h3_staging_delivery_repair_data'); assert.equal(data.candidateDelivery, '{unreadable JSON');
          assert.equal(data.sourceStoryContent, story); return envelope(h3Body(false), board);
        }
        assertScope(system, 'translation'); return envelope(h3Body(false, true));
      } });
    assert.deepEqual(stages, ['convert', 'review', 'review', 'translate', 'translate']);
    assert.equal(result.officialPromptZh, h3Body(false)); assert.equal(result.officialPromptEn, h3Body(false, true));
    assert.equal(result.finalPrompt, board.finalPrompt); assert.deepEqual(board, before);
    groups++;
  }
  // Helper strips only complete owned blocks. Literal custom additions remain
  // untouched, even if they mention the same marker as on-screen subject text.
  const custom = '用户自定义：屏幕上显示 VIDEO_ACTION_CHOREOGRAPHY_V1；保留我的构图。';
  const mixed = [custom, ...rules, VIDEO_ACTION_CHOREOGRAPHY_RULE, legacyGenerationRule].join('\n\n');
  const translatedScope = withVideoActionChoreographyScope(mixed, 'translation');
  assertScope(translatedScope, 'translation'); assert.ok(translatedScope.includes(custom));
  assert.ok(!translatedScope.includes(legacyGenerationRule), 'legacy generation authority is removed from a translation-only request');
  // Frozen v2 fingerprint for these exact request facts. Merely observing
  // freshness cannot rewrite old derived text or trigger another model call.
  const cacheInput = { targetId: 'seedance-2.5', canonicalPrompt: '【0s-8s】沈衡将布袋抛给陆青，陆青接稳。',
    durationSec: 8, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', references: [] };
  const historicalSeedance = { promptZh: '历史中文成稿保留。', promptEn: 'Keep the historical English draft.', sourceFingerprint: '771823c0' };
  const historicalBefore = structuredClone(historicalSeedance); const cacheBefore = structuredClone(cacheInput);
  assert.notEqual(getOfficialSeedanceSourceFingerprint(cacheInput), historicalSeedance.sourceFingerprint,
    'new request-time action strategy marks the v2-derived prompt stale without changing source facts');
  assert.deepEqual(historicalSeedance, historicalBefore); assert.deepEqual(cacheInput, cacheBefore);
  groups++;
  assert.deepEqual(converter, converterBefore);
  console.log(`Video action choreography: ${groups} targeted groups passed (production request scopes, planning/materialization, exact/auto, 3/6-field H3, Chinese checkpoint/English, confirmed reuse, selected private facts and format repair; synthetic mocks only, no video-quality claim).`);
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
  globalThis.fetch = originalFetch;
}

import assert from 'node:assert/strict';
import {
  generateOfficialSeedancePrompt,
  generateSeedanceBilingualOutput,
  getOfficialSeedanceSourceFingerprint,
  isSeedanceOutputSaveRequestCurrent,
  translateSeedancePromptToEnglish,
} from '../src/seedancePrompt';
import type { Seedance25Output } from '../src/types';
import { createSeedanceTranslationResponse } from './seedanceTranslationTestUtils';
import { STORY_SCENE_EXPRESSION_PRESERVATION_RULE } from '../src/storySceneParticipationRules';
import { resolveSeedanceCharacterParticipation } from '../src/characterParticipation';

// All requests are local doubles. These cases verify the actual writer and
// checkpoint boundaries, without evaluating or submitting generated videos.
const dialogue = '左边交给我！';
const sourceStory = `林霜持枪迎击冲来的兽人，枪杆撞开前排兽人的手臂；兽人被击退两步。林霜喊：“${dialogue}”后绕到石柱左侧，里尤洛在柱后看见第二个兽人倒飞，林霜的后续迎击暂时在画外。`;
const responsibility = '人物身份、蓝色长袍、发型与枪形武器；仅作为外观参考，原剧情指定的近身连续迎击、撞击目标、位移结果和画外动作由分镜事实决定。';
const input = {
  targetId: 'seedance-2.5', durationSec: 30, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  canonicalPrompt: `【0s-7.5s】林霜持枪迎击兽人，枪杆撞开兽人手臂，兽人后退两步。\n【7.5s-15s】林霜喊：“${dialogue}”，沿石柱左侧绕行，里尤洛留在柱后。\n【15s-30s】里尤洛看见第二个兽人倒飞；林霜的后续迎击暂时在画外。`,
  references: [
    { id: 'lin-image', name: '林霜外观', mediaType: 'image', referenceRole: 'character', responsibility },
    { id: 'scene-image', name: '石柱空间', mediaType: 'image', referenceRole: 'scene', responsibility: '石柱、左右绕行区域和里尤洛的遮挡位置。' },
  ],
  subjectDefinitions: [{ name: '林霜', description: '持枪的蓝袍人物', motion: '枪杆近身迎击、接触后回防并绕柱左行', referenceAssetIds: ['lin-image'] },
    { name: '里尤洛', kind: 'character', description: '站在柱后的人物', motion: 'UNADOPTED_CHARACTER_HABIT' }],
  constraints: ['保持林霜的枪与蓝袍连续，石柱的左右空间不反转。'],
  sourceEvidence: { story: sourceStory, shotMode: 'exact', shotCount: 3, entryState: '兽人正向林霜逼近', exitState: '第二个兽人倒飞，里尤洛仍在柱后', motionReferenceSupported: false,
    creativeDirection: { cameraTerms: ['UNADOPTED_CAMERA_MENU'] },
    directorStyleSummary: 'UNADOPTED_DIRECTOR_SUMMARY', extraRequirement: 'UNADOPTED_CAMERA_HINT',
    sequenceSegmentContext: { creativeDirection: { cameraTerms: ['UNADOPTED_NESTED_CAMERA_MENU'] }, segment: { content: sourceStory } },
    sceneStaging: [{ version: 1, sceneId: 'training', participants: [{ id: 'lin', bodyFacing: '兽人', gazeTarget: '兽人', actionTarget: '兽人' }] }] },
};
const chinese = [
  '视频规格：时长 30 秒；画面比例 16:9；分辨率 2K；声音模式 stereo。',
  '参考素材与职责：\n@Image 1：林霜外观（人物与武器外观）；@Image 2：石柱空间（左右位置与遮挡）。',
  '主体连续性：\n林霜持续持枪穿蓝袍；里尤洛保持在石柱后，兽人是她迎击的目标。',
  '一句话概述：\n林霜以连续近身迎击压退兽人并绕柱左行，柱后的里尤洛目睹后续受击结果。',
  '连续时间轴（覆盖 0–30 秒）：',
  '【0s-7.5s】林霜持枪连续迎击冲来的兽人，其中枪杆撞开前排兽人的手臂，兽人受力后退两步；双方脚步与武器接触可见。',
  `【7.5s-15s】林霜喊：“${dialogue}”后回防绕到石柱左侧，里尤洛仍在柱后；摄影机随动作保持双方空间连续。`,
  '【15s-30s】里尤洛看见第二个兽人倒飞；林霜的后续迎击暂时在画外，结果仍由她的迎击造成。',
  '全局约束：\n保持蓝袍、武器和石柱左右关系；不添加对白。',
].join('\n\n');
const english = [
  'Video specification: duration 30 seconds; aspect ratio 16:9; resolution 2K; audio mode stereo.',
  'References and responsibilities:\n@Image 1: Lin Shuang (appearance and weapon); @Image 2: stone pillar (positions and occlusion).',
  'Subject continuity:\nLin Shuang keeps her spear and blue robe. Riyuro remains behind the pillar. The orcs are her targets.',
  'One-sentence summary:\nLin Shuang drives the orcs back through continuous close combat and circles left of the pillar while Riyuro observes the resulting impacts.',
  'Continuous timeline (covering 0–30 seconds):',
  '【0s-7.5s】Lin Shuang continuously meets the charging orcs with her spear. The shaft strikes a front orc\'s arm aside and the orc recoils two steps; footwork and weapon contact remain visible.',
  `【7.5s-15s】Lin Shuang shouts “${dialogue}”, returns to guard and circles left of the pillar while Riyuro remains behind it; the camera follows the physical action.`,
  '【15s-30s】Riyuro sees a second orc knocked into the air; Lin Shuang\'s subsequent strikes are temporarily off screen and still cause the visible result.',
  'Global constraints:\nKeep the blue robe, weapon and left/right pillar layout continuous. Add no dialogue.',
].join('\n\n');
const clone = structuredClone(input);

let writerRequests = 0;
const written = await generateOfficialSeedancePrompt({ input, request: async (system, user) => {
  writerRequests += 1;
  assert.match(system, /Seedance/u, 'the Chinese model request has a Seedance contract');
  assert.ok(system.includes(STORY_SCENE_EXPRESSION_PRESERVATION_RULE));
  assert.match(system, /连续|概括/u, 'the writer receives continuous-action expression guidance');
  assert.match(system, /少数|关键|记忆点/u, 'the writer is guided to select important contacts rather than enumerate every punch');
  assert.ok(user.includes('sceneStaging') && user.includes('bodyFacing'), 'adopted relations reach the existing writer call');
  for (const unused of ['UNADOPTED_CAMERA_MENU', 'UNADOPTED_DIRECTOR_SUMMARY', 'UNADOPTED_CAMERA_HINT', 'UNADOPTED_NESTED_CAMERA_MENU', 'UNADOPTED_CHARACTER_HABIT']) {
    assert.equal(user.includes(unused), false, 'unadopted camera preferences cannot re-direct the expression stage');
  }
  assert.ok(!/必须[^\n]*(?:\[Shot|<Subject|<Picture|integrated_multimodal_description)/u.test(system), 'the dedicated writer must not require H3 serialization');
  for (const fact of [sourceStory, input.canonicalPrompt, responsibility, '枪杆近身迎击、接触后回防并绕柱左行', 'lin-image', 'shotCount', '7.5']) {
    assert.ok(user.includes(fact) || user.includes(JSON.stringify(fact).slice(1, -1)), `the internal request keeps source evidence: ${fact}`);
  }
  return chinese;
} });
assert.equal(writerRequests, 1, 'one requested Chinese draft makes one model call without independent AI review');
assert.equal(written.promptZh, chinese);
assert.equal(written.prompt, chinese);
assert.equal(written.sourceFingerprint, getOfficialSeedanceSourceFingerprint(input));
assert.deepEqual(input, clone, 'Chinese generation never mutates confirmed planning, reference evidence or dialogue');
assert.match(written.promptZh, /一句话概述：[\s\S]*林霜以连续近身迎击/u, 'the final summary is a dedicated model-written overview');
assert.doesNotMatch(written.promptZh, /integrated_multimodal_description|\[Shot\s+\d+\]|<Subject|<Picture|<d>|STORY_CAUSALITY/u);
assert.ok(!written.promptZh.includes(responsibility), 'full reference evidence remains internal while the final responsibility is concise');

let saved: Seedance25Output | undefined;
let bilingualRequests = 0;
const failure = await generateSeedanceBilingualOutput({ input, request: async () => {
  bilingualRequests += 1;
  if (bilingualRequests === 1) return chinese;
  assert.equal(saved?.promptZh, chinese, 'qualified Chinese is durably handed to save before English starts');
  assert.equal(saved?.promptEn, undefined);
  throw new Error('mock English endpoint unavailable');
}, onChinese: (output) => { saved = structuredClone(output); return true; }, onEnglish: (output) => { saved = structuredClone(output); return true; } });
assert.equal(bilingualRequests, 2, 'generation asks for one Chinese and one English result');
assert.equal(failure.promptZh, chinese);
assert.equal(saved?.promptZh, chinese);
assert.equal(failure.promptEn, undefined);
assert.match(failure.englishError || '', /mock English endpoint unavailable/u);
assert.match(saved?.englishError || '', /mock English endpoint unavailable/u);

let retryRequests = 0;
const recovered = await translateSeedancePromptToEnglish({ sourcePrompt: saved!.promptZh,
  sourceCharacters: input.subjectDefinitions.map((character) => ({ id: character.name, name: character.name })),
  request: async (system, user, transport) => {
  retryRequests += 1;
  assert.match(system, /Seedance/u);
  assert.ok(!/必须[^\n]*(?:\[Shot|<Subject|<Picture)/u.test(system));
  assert.match(system, /起止值|小数秒/u, 'translation preserves the confirmed timing');
  assert.equal(JSON.parse(user).sourcePrompt, chinese, 'the complete approved source remains readable context');
  assert.doesNotMatch(user, /__LH_/u, 'dialogue and reference labels never become private placeholder tokens');
  assert.equal(transport?.sourceDocumentTranslation, true);
  return createSeedanceTranslationResponse(user);
} });
assert.equal(retryRequests, 1, 'English-only generation makes one request without automatic repair');
assert.match(recovered, /^Video specification:/u);
assert.ok(recovered.includes('林霜') && recovered.includes('里尤洛'), 'explicit identities are assembled from the source');
assert.equal(saved!.promptZh, chinese, 'English failure and retry keep the approved Chinese checkpoint untouched');
assert.ok(recovered.includes(`“${dialogue}”`) && recovered.includes('【7.5s-15s】'), 'delivery keeps original dialogue language and fractional time boundaries');

// An unreadable/missing translation cannot overwrite the Chinese checkpoint
// or launch another paid request. These are response decoding cases.
const invalidEnglish = [english, '{', '{"slots":[]}', '{"slots":[{"id":"unknown","text":"translated"}]}'];
for (const candidate of invalidEnglish) {
  let calls = 0;
  await assert.rejects(translateSeedancePromptToEnglish({ sourcePrompt: chinese, request: async (_system, user) => {
    calls += 1;
    assert.equal(JSON.parse(user).sourcePrompt, chinese);
    return candidate;
  } }), /Seedance 英文交付序列化失败/u);
  assert.equal(calls, 1, 'invalid delivery does not trigger another model request');
}

for (const finalDelivery of [
  new Error('mock English endpoint unavailable'), ...invalidEnglish,
]) {
  let calls = 0;
  let chineseCheckpoint: Seedance25Output | undefined;
  let englishWrites = 0;
  const result = await generateSeedanceBilingualOutput({ input, request: async (_system, user) => {
    calls += 1;
    if (calls === 1) return chinese;
    assert.equal(chineseCheckpoint?.promptZh, chinese);
    assert.equal(englishWrites, 0);
    assert.equal(JSON.parse(user).sourcePrompt, chinese);
    assert.equal(calls, 2, 'one Chinese request and one English request');
    if (finalDelivery instanceof Error) throw finalDelivery;
    return finalDelivery;
  }, onChinese: (output) => { chineseCheckpoint = structuredClone(output); return true; },
  onEnglish: (output) => { englishWrites += 1; chineseCheckpoint = structuredClone(output); return true; } });
  assert.equal(calls, 2, 'English failure starts no extra paid request');
  assert.equal(englishWrites, 1);
  assert.equal(result.promptZh, chinese);
  assert.equal(result.promptEn, undefined);
  assert.match(result.englishError || '', /mock English endpoint unavailable|Seedance 英文交付序列化失败/u);
  assert.equal(chineseCheckpoint?.promptZh, chinese, 'the approved Chinese checkpoint remains available after final English failure');
}

const allReferencesSource = chinese.replace('@Image 2：石柱空间（左右位置与遮挡）。',
  '@Image 2：石柱空间（左右位置与遮挡）。\n@Video 1：枪杆动作；@Audio 1：对白声线；@Clay Render 1：场地体积。');
let allReferenceCalls = 0;
const allReferencesEnglish = await translateSeedancePromptToEnglish({ sourcePrompt: allReferencesSource, request: async (_system, user) => {
  allReferenceCalls += 1;
  assert.equal(JSON.parse(user).sourcePrompt, allReferencesSource);
  return `\`\`\`json\n${createSeedanceTranslationResponse(user)}\n\`\`\``;
} });
assert.deepEqual(allReferencesEnglish.match(/@(?:Image|Video|Audio|Clay Render)\s+\d+/gu),
  ['@Image 1', '@Image 2', '@Video 1', '@Audio 1', '@Clay Render 1']);
assert.equal(allReferenceCalls, 1, 'JSON fences do not invoke H3 repair or an extra request');

// Natural-language timing can use equivalent seconds or timecode spelling.
// These are translations of the same cuts, not a reason for a paid repair.
for (const [sourceRange, renderedRange] of [
  ['第0秒到第7.5秒', '0s–7.5s'], ['00:00–00:07.5', '00:00–00:07.5'], ['0 sec to 7.5 sec', '0 sec to 7.5 sec'],
]) {
  let calls = 0;
  const result = await translateSeedancePromptToEnglish({ sourcePrompt: chinese.replace('0s-7.5s', sourceRange),
    request: async (_system, user) => { calls += 1; return createSeedanceTranslationResponse(user); } });
  assert.ok(result.includes(renderedRange), 'source time values are assembled outside translated prose');
  assert.equal(calls, 1, `equivalent timing ${sourceRange} needs no repair`);
}

let refusedCheckpointRequests = 0;
await assert.rejects(generateSeedanceBilingualOutput({ input, request: async () => { refusedCheckpointRequests += 1; return chinese; }, onChinese: () => false, onEnglish: () => { assert.fail('stale Chinese must not permit an English save'); } }), /旧|变化|失效|过期|取消|已切换|保存|current|stale/iu);
assert.equal(refusedCheckpointRequests, 1, 'a rejected Chinese checkpoint prevents an English request');

let current = true; let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
const obsolete = generateOfficialSeedancePrompt({ input, isCurrent: () => current, request: async () => { await gate; return chinese; } });
current = false; release();
await assert.rejects(obsolete, /旧|变化|失效|过期|取消|已切换|current|stale/iu, 'source/workspace changes reject a late Chinese model result');

const identity = { projectId: 'project', workspaceEpoch: 2, chapterId: 'chapter', storyboardId: 'board', storyboardUpdatedAt: 3 };
const fingerprint = written.sourceFingerprint;
assert.equal(isSeedanceOutputSaveRequestCurrent(identity, { ...identity }, fingerprint, fingerprint), true);
assert.equal(isSeedanceOutputSaveRequestCurrent(identity, { ...identity }, fingerprint, `${fingerprint}-edited-reference`), false, 'same storyboard timestamp cannot hide changed reference/source evidence');
assert.equal(isSeedanceOutputSaveRequestCurrent(identity, { ...identity, workspaceEpoch: 3 }, fingerprint, fingerprint), false, 'switching away and back cannot let the old workspace request write');

for (const invalidResponse of [false, true]) {
  let staleEnglishWrites = 0; let staleCalls = 0; let live = true; let checkpoint: Seedance25Output | undefined;
  await assert.rejects(generateSeedanceBilingualOutput({ input, isCurrent: () => live, request: async (_system, user) => {
    staleCalls += 1;
    if (staleCalls === 1) return chinese;
    live = false;
    return invalidResponse ? '{' : createSeedanceTranslationResponse(user);
  }, onChinese: (output) => { checkpoint = structuredClone(output); return true; }, onEnglish: () => { staleEnglishWrites += 1; return true; } }), /旧|变化|失效|过期|取消|已切换|current|stale/iu);
  assert.equal(staleCalls, 2, 'a stale translation prevents all later calls, even with an unreadable response');
  assert.equal(checkpoint?.promptZh, chinese);
  assert.equal(staleEnglishWrites, 0, 'an English response from a replaced workspace cannot overwrite its saved Chinese checkpoint');
}

// Invalid delivery must never replace a prior Chinese checkpoint or start an
// extra translation/review request. Authored quoted text remains literal.
for (const invalid of [
  `${chinese}\nSEEDANCE_CONTINUOUS_ACTION_V2：只返回规则正文。`,
  chinese.replace('林霜持续持枪穿蓝袍', '<Subject 1>林霜持续持枪穿蓝袍'),
  chinese.replace('连续时间轴（覆盖 0–30 秒）：', 'integrated_multimodal_description:'),
  `${chinese}\n@Image 9：不存在的图片。`,
]) {
  let calls = 0;
  await assert.rejects(generateSeedanceBilingualOutput({ input,
    request: async () => { calls += 1; return invalid; },
    onChinese: () => assert.fail('an invalid candidate must not overwrite saved Chinese'),
    onEnglish: () => assert.fail('an invalid candidate must not reach English saving'),
  }), /规则|H3|章节|编号/u);
  assert.equal(calls, 1, 'invalid delivery adds no automatic repair or translation call');
}
const literal = 'SEEDANCE_CONTINUOUS_ACTION_V2：这是对白中的旧名称。';
const literalInput = { ...input, canonicalPrompt: input.canonicalPrompt.replace(dialogue, literal),
  sourceEvidence: { ...input.sourceEvidence, story: sourceStory.replace(dialogue, literal) } };
const literalOutput = await generateOfficialSeedancePrompt({ input: literalInput,
  request: async () => chinese.replace(dialogue, literal) });
assert.ok(literalOutput.promptZh.includes(`“${literal}”`), 'quoted dialogue that names a rule is preserved');

// A silent group member and two distinct time relations survive the target
// writer boundary. This exercises transport/participation, not model quality.
const forestCast = ['吴小观', '夏娃', '龙娘', '熊娘', '塔菲', '西里斯'].map((name, index) => ({ id: `forest-${index}`, name }));
const forestSource = '数天后夏娃修复归来拥抱吴小观。又过一些日子，吴小观独自清点奖励，随后向龙娘和熊娘请求较量，两人笑着拒绝。塔菲站在附近。西里斯更晚才来。';
const forestTimeline = [
  '0秒至8秒，数天后，修复完成的夏娃从战舰走出拥抱吴小观，两人在空地相拥。',
  '8秒至19秒，相拥画面淡出，以同一营地的光影流逝过渡到一些日子后的空地；吴小观独自盘坐清点奖励。',
  '19秒至30秒，吴小观起身走向龙娘和熊娘。龙娘抱胸站在左侧微笑拒绝，熊娘站在龙娘身旁笑着摇头；塔菲站在另一侧静静看着吴小观。四人保持各自身份。',
].join('\n');
const forestPrompt = [
  '视频规格：总时长30秒，16:9画幅，2K分辨率，立体声。',
  '参考素材与职责：本次未提供图片。',
  '主体连续性：吴小观穿黑色便服；夏娃银白长发；龙娘穿黑色皮衣；熊娘棕色头发；塔菲保持已知身份。',
  '一句话概述：夏娃归来相拥，之后吴小观清点奖励，请求较量遭龙娘和熊娘拒绝。',
  `连续时间轴：\n${forestTimeline}`,
  '全局约束：保留两处时间定位及每个人的独立身份，无对白。',
].join('\n\n');
let forestCalls = 0;
const forestResult = await generateOfficialSeedancePrompt({
  input: { ...input, references: [], canonicalPrompt: forestTimeline,
    subjectDefinitions: forestCast.slice(0, 5).map(({ name }) => ({ name, kind: 'character' as const })),
    sourceEvidence: { sourceStoryContent: forestSource,
      sceneStaging: [{ version: 1, sceneId: 'forest', participants: forestCast.slice(0, 5),
        phases: [{ id: 'refusal', participantIds: ['forest-0', 'forest-2', 'forest-3', 'forest-4'],
          action: '吴小观请求较量，龙娘与熊娘笑着拒绝，塔菲旁观' }] }] } },
  request: async (system, user) => {
    forestCalls += 1;
    assert.ok(system.includes(STORY_SCENE_EXPRESSION_PRESERVATION_RULE));
    const source = JSON.parse(user.match(/<seedance_source_data>\s*([\s\S]*?)\s*<\/seedance_source_data>/u)![1]);
    assert.equal(source.canonicalPrompt, forestTimeline);
    assert.equal(source.sourceEvidence.sourceStoryContent, forestSource);
    assert.deepEqual(source.sourceEvidence.sceneStaging[0].phases[0].participantIds, ['forest-0', 'forest-2', 'forest-3', 'forest-4']);
    return forestPrompt;
  },
});
assert.equal(forestCalls, 1);
assert.equal(forestResult.promptZh, forestPrompt);
const forestParticipation = resolveSeedanceCharacterParticipation(forestResult.promptZh, forestCast);
assert.deepEqual(new Set(forestParticipation.characters.filter((entry) => entry.presence === 'visible').map((entry) => entry.name)),
  new Set(['吴小观', '夏娃', '龙娘', '熊娘', '塔菲']));
assert.ok(!forestParticipation.characters.some((entry) => entry.name === '西里斯'));

console.log('Seedance writer: single-request description translation, source-owned references/dialogue/timing, Chinese checkpoints, English-only failure, cancellation and invalid-delivery retention passed (mock text requests only).');

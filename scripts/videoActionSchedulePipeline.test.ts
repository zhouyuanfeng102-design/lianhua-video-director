import assert from 'node:assert/strict';
import { hasCurrentTextApiConversion } from '../src/appEffects';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';
import type { H3StagingShotMetadata } from '../src/h3StagingMetadata';
import { hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import { generateSingleSegmentPrompt, type SingleSegmentPromptStage } from '../src/singleSegmentPrompt';
import { sourceContentHash } from '../src/sourceIntegrity';
import { VIDEO_ACTION_EVENT_REVIEW_RULE } from '../src/videoActionChoreographyRules';
import type { Character, ConverterPreset, H3IdentityBindings, PromptCharacterParticipation, Storyboard } from '../src/types';

// Offline integration regression: only the model responses are synthetic. The
// production converter, H3 review, staging synchronization and translation run
// together. This verifies data flow, not a real model's choreography quality.
const characters: Character[] = [
  { id: 'zesshi', name: '绝死绝命', outfit: '黑白铠甲', appearance: '黑白长发' },
  { id: 'mare', name: '马雷', outfit: '白色斗篷', appearance: '金色短发' },
].map((person) => ({ ...person, gender: '女', apparentAge: '', race: '', signatureProps: '', personality: '',
  motionHabits: '', anchor: person.outfit, negativeContinuity: '', assetIds: [] }));
const context = { characters, assets: [] };
const converter: ConverterPreset = { id: 'action-converter', name: '动作排程测试', workflow: 'all', inputMode: 'all',
  scope: 'video', enabled: true, version: 'test', systemPrompt: '按本段剧情整理完整动作。', outputRules: '输出普通六字段。', updatedAt: 1 };
const zhIdentities = ['身份：绝死绝命，女性，黑白长发，黑白铠甲。', '身份：马雷，女性，金色短发，白色斗篷。'];
const enIdentities = ['Identity: 绝死绝命, a woman with long black-and-white hair and black-and-white armor.',
  'Identity: 马雷, a woman with short blond hair and a white cloak.'];
const bindings = (language: 'zh' | 'en', speaking: boolean): H3IdentityBindings => ({ version: 1,
  characters: characters.map((person, index) => ({ characterId: person.id, name: person.name,
    referenceAnchor: (language === 'zh' ? zhIdentities : enIdentities)[index],
    ...(speaking && person.id === 'mare' ? { speakerToken: '(S1)' } : {}),
  })),
});
interface ShotPlan { start: number; end: number; action: string; camera: string; dialogue?: string; sound?: string }
const canonical = (plans: ShotPlan[]): string => plans.map((shot) =>
  `【${shot.start}s-${shot.end}s】主体：@绝死绝命、@马雷 正在 [${shot.action}]；空间：房间与门廊；光影：门廊冷光；镜头：${shot.camera}；台词：${shot.dialogue || '无'}；音效：${shot.sound || '环境层-[无] 动作层-[脚步声] 情绪层-[无]'}`).join('\n');
const h3 = (language: 'zh' | 'en', shots: string[]): string => [
  `integrated_multimodal_description: [Shot 1] ${(language === 'zh' ? zhIdentities : enIdentities).join(' ')} ${shots[0]}`,
  ...shots.slice(1), 'overall_soundscape: N/A', 'non_diegetic_music: N/A',
].join('\n');
const metadata = (beatIds: string[], excerpt: string): H3StagingShotMetadata => ({
  sourceBeatIds: beatIds, sourceExcerpt: excerpt, sourceLocationStatus: 'unlocated',
  nsfwContinuity: null, visiblePrivatePartsByCharacter: {},
});
const readData = (user: string, tag: string) => {
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `missing ${tag} in the actual production request`);
  return JSON.parse(match[1]);
};

interface Scenario {
  id: string;
  source: string;
  original: ShotPlan[];
  corrected: ShotPlan[];
  groups: number[][];
  zh: string;
  en: string;
  speaking: boolean;
}

const runScenario = async (scenario: Scenario): Promise<Storyboard> => {
  const original = canonical(scenario.original);
  const corrected = canonical(scenario.corrected);
  const board: Storyboard = {
    id: scenario.id, sceneId: 'scene', sourceStoryContent: scenario.source,
    workflow: 'action', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'auto',
    recommendedShotCount: 4, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    stylePresetId: '', ruleSetId: '', converterPresetId: converter.id, globalLock: '', finalPrompt: original,
    officialPromptZh: '历史中文结果', officialPromptEn: 'Historical English result', createdAt: 1, updatedAt: 1,
    shots: scenario.original.map((shot, index) => ({
      id: `${scenario.id}-shot-${index + 1}`, index: index + 1, startSec: shot.start, endSec: shot.end,
      subject: '绝死绝命、马雷', action: shot.action, space: '房间与门廊', purpose: '当前事件',
      camera: shot.camera, lighting: '门廊冷光', dialogue: shot.dialogue || '无', sound: shot.sound || '旧声音',
      result: '旧候选末态', direction: '旧候选朝向', performance: '旧候选表演', transition: '旧候选承接',
      referenceAssetIds: [], locked: false, prompt: original.split('\n')[index], authoredBy: 'text-api',
      sourceBeatIds: [`beat-${index + 1}`], sourceExcerpt: scenario.source, sourceLocationStatus: 'unlocated',
    })),
    audioLedger: [{ id: 'old-impact', kind: 'foley', label: '旧排程碰撞', text: '碰撞声', startSec: 9.8, endSec: 9.9 }],
    promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(original), modelRuleSetId: '',
      converterPresetId: converter.id, sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1 },
    promptPlan: { canonicalPrompt: original, durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      workflow: 'action', inputMode: 'text', shotIds: scenario.original.map((_, index) => `${scenario.id}-shot-${index + 1}`),
      referenceAssetIds: [], constraints: [], trace: { ruleSetId: '', converterId: converter.id } },
  };
  const before = JSON.stringify(board);
  const zhBindings = bindings('zh', scenario.speaking);
  const enBindings = bindings('en', scenario.speaking);
  const participation: PromptCharacterParticipation = { version: 1, characters: characters.map((person) => ({
    characterId: person.id, name: person.name, presence: 'visible', shotIndex: 1,
    evidence: zhIdentities[characters.indexOf(person)],
  })) };
  const shotSourceIds = scenario.groups.map((indices) => indices.map((index) => board.shots[index].id));
  const shotMetadata = scenario.groups.map((indices) => metadata(indices.map((index) => `beat-${index + 1}`), scenario.source));
  const requests: Array<{ system: string; user: string; stage: SingleSegmentPromptStage }> = [];
  let checkpoint: Storyboard | undefined;
  let checkpointCalls = 0;
  let englishReviewCalls = 0;
  const result = await generateSingleSegmentPrompt({ board, context, converter, reviewWithAi: true, now: () => 100,
    clean: (text) => text,
    onQualifiedChinese: (value) => { checkpoint = value; checkpointCalls++; },
    onAiTranslationReview: () => { englishReviewCalls++; },
    request: async (system, user, stage) => {
      requests.push({ system, user, stage });
      if (stage === 'convert') return original;
      if (stage === 'review') return JSON.stringify({ canonicalPrompt: corrected, h3Prompt: scenario.zh,
        identityBindings: zhBindings, characterParticipation: participation, shotSourceIds, shotMetadata });
      return JSON.stringify({ h3Prompt: scenario.en, identityBindings: enBindings });
    },
  });

  assert.deepEqual(requests.map((request) => request.stage), ['convert', 'review', 'translate', 'translate'],
    'event review reuses the existing calls, with no extra model stage or semantic retry');
  const stagingReview = readData(requests[1].user, 'video_staging_review_data');
  const conversionData = readData(requests[0].user, 'video_conversion_data');
  assert.equal(conversionData.voiceFactScope, 'source-grounded-new-draft');
  assert.equal(stagingReview.voiceFactScope, 'source-grounded-new-draft');
  for (const data of [conversionData, stagingReview]) {
    assert.equal(data.characterIdentityFacts.find((person: { id: string }) => person.id === 'mare').gender, '女',
      'the model receives project identity even when the candidate carries a conflicting voice');
  }
  assert.equal(stagingReview.taskAuthority, 'current-segment-staging-replan');
  assert.equal(stagingReview.canonicalPrompt, original, 'the bad four-shot candidate is supplied as review evidence');
  assert.deepEqual(stagingReview.shots.map((shot: { startSec: number; endSec: number }) => [shot.startSec, shot.endSec]),
    scenario.original.map((shot) => [shot.start, shot.end]));
  assert.ok(requests[1].system.includes(VIDEO_ACTION_EVENT_REVIEW_RULE), 'existing Chinese review receives event evidence checks');

  const translation = readData(requests[2].user, 'translation_identity_data');
  assert.equal(translation.sourcePrompt, scenario.zh, 'English translates the corrected Chinese H3, not the old candidate');
  assert.deepEqual(translation.sourceIdentityBindings, zhBindings);
  const englishReview = readData(requests[3].user, 'review_data');
  assert.equal(englishReview.sourcePrompt, scenario.zh);
  assert.equal(englishReview.candidateEnglishPrompt, scenario.en);
  assert.equal(englishReview.stagingContext.canonicalPrompt, corrected);
  assert.deepEqual(englishReview.stagingContext.shots.map((shot: { startSec: number; endSec: number }) => [shot.startSec, shot.endSec]),
    scenario.corrected.map((shot) => [shot.start, shot.end]), 'English review receives the merged timeline');
  assert.deepEqual(englishReview.stagingContext.shots.map((shot: { prompt: string }) => shot.prompt), corrected.split('\n'));
  assert.deepEqual(englishReview.sourceIdentityBindings, zhBindings);
  assert.ok(requests.slice(2).every((request) => !request.system.includes(VIDEO_ACTION_EVENT_REVIEW_RULE)),
    'English preserves the corrected schedule instead of acquiring Chinese replanning authority');

  assert.equal(checkpointCalls, 1);
  assert.equal(englishReviewCalls, 1);
  assert.equal(checkpoint?.finalPrompt, corrected);
  assert.equal(checkpoint?.officialPromptZh, scenario.zh);
  assert.equal(checkpoint?.officialPromptEn, '');
  assert.deepEqual(checkpoint?.shots, result.shots, 'the persisted Chinese checkpoint already owns the corrected shots');
  assert.equal(result.finalPrompt, corrected);
  assert.equal(result.promptPlan?.canonicalPrompt, corrected);
  assert.deepEqual(result.promptPlan?.shotIds, result.shots.map((shot) => shot.id));
  assert.equal(result.durationSec, 15);
  assert.equal(result.targetOutput?.parameters.durationSec, 15);
  assert.equal(result.shotMode, 'auto');
  assert.equal(result.shotCount, undefined, 'AI count changes do not become an exact user preference');
  assert.equal(result.recommendedShotCount, scenario.corrected.length);
  assert.equal(result.officialPromptZh, scenario.zh);
  assert.equal(result.targetOutput?.prompt, scenario.zh);
  assert.equal(result.officialPromptEn, scenario.en);
  assert.equal(result.officialPromptEnSource, scenario.zh);
  assert.equal(result.englishPromptSource, corrected);
  assert.deepEqual(result.h3IdentityBindings, zhBindings);
  assert.deepEqual(result.h3IdentityBindingsEn, enBindings);
  assert.deepEqual(result.shots.map((shot) => shot.sourceBeatIds), shotMetadata.map((item) => item.sourceBeatIds));
  assert.deepEqual(result.shots.map((shot) => shot.prompt), corrected.split('\n'));
  assert.ok(result.shots.every((shot) => !shot.result && !shot.transition && !shot.direction && !shot.performance),
    'old action outcomes and pose fields cannot leak back into a corrected timeline');
  assert.equal(result.audioLedger, undefined, 'the old 9.8-second impact cache is not reused after retiming');
  assert.equal(result.officialPromptEnError || '', '');
  assert.deepEqual(result.h3DeliveryWarnings || [], []);
  assert.deepEqual(result.h3DeliveryWarningsEn || [], []);
  assert.equal(hasCurrentTextApiConversion(result), true);
  assert.equal(hasCurrentOfficialH3Prompt(result, context), true);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(result, context), true);
  assert.deepEqual(readH3PromptProtocol(result.officialPromptZh!), readH3PromptProtocol(result.officialPromptEn!));
  assert.equal(JSON.stringify(board), before, 'generation never mutates the historical input or saved result');
  return result;
};

const third = await runScenario({
  id: 'short-airborne-exchange', speaking: true,
  source: '马雷用木杖挡开绝死绝命的镰刀，借反作用力向后腾起进入门廊，说“突、突然就——”。绝死绝命立即追上，挥镰附带划过墙地，在同一次短促腾空中接连三次攻击，都被马雷挡住。两人落地，绝死绝命观察马雷毫无防备的腹部，提防陷阱。',
  original: [
    { start: 0, end: 3.5, action: '马雷第1秒倒飞；直到镜尾仍悬空', camera: '跟拍倒飞', dialogue: '马雷 第1–2.8秒：“突、突然就——”' },
    { start: 3.5, end: 7.5, action: '马雷继续悬空；绝死绝命起跳旋转，挥镰划墙', camera: '侧移并拉远' },
    { start: 7.5, end: 11.5, action: '马雷仍悬空；第0.3、1.3、2.3秒绝死绝命从右上向左下重复三次挥镰', camera: '每次碰撞推拉' },
    { start: 11.5, end: 15, action: '第0.3秒两人落地，绝死绝命观察马雷', camera: '对峙全景' },
  ],
  corrected: [
    { start: 0, end: 4, action: '第0.15秒马雷木杖挡住低扫镰刃；第0.45–2.2秒马雷借力短促后跃，绝死绝命立即追进，同次腾空中第1.0秒斜斩被挑偏、第1.35秒随余势反向回收再劈被架住、第1.8秒借偏转压进被封挡；镰刃随攻向马雷的路径擦过墙地；第2.2秒双方落地并恢复重心',
      camera: '斜侧中全景连续覆盖接触、追击和三次招架，正常播放速度', dialogue: '马雷 第0.65–2.45秒：“突、突然就——”',
      sound: '环境层-[无] 动作层-[第0.15、1.0、1.35、1.8秒兵器碰撞，第2.2秒落地] 情绪层-[无]' },
    { start: 4, end: 15, action: '双方脚掌已接地；绝死绝命保持面向马雷，顺势稳定镰刀，视线移向其未遮蔽的腹部并审视防守破绽；马雷仍持杖面向绝死绝命',
      camera: '保持同一行动轴线，观察两人的视线和持械关系' },
  ],
  groups: [[0, 1, 2], [3]],
  zh: h3('zh', [
    '斜侧中全景保持双方关系。马雷在本段0.15秒挡住低扫，0.45–2.2秒借力短促后跃；绝死绝命立即追上。在同一次腾空中，1.0秒斜斩被挑偏，1.35秒随余势反向回收再劈被架住，1.8秒借偏转压进被封挡。镰刃沿攻击路径擦过墙地。2.2秒双方落地恢复重心。马雷 (S1)在0.65–2.45秒说：<d>[Chinese] 突、突然就——</d>。动作以正常播放速度完成，兵器碰撞对应各次接触。',
    '[Shot 2] At 00:04.000 双方已经接地，绝死绝命保持面向马雷，稳定镰刀并观察马雷的腹部，审视其防守破绽。马雷持杖面对绝死绝命。机位保持同一行动轴线；4–15秒无对白。',
  ]),
  en: h3('en', [
    'An oblique medium-wide view preserves their relationship. 马雷 blocks the low sweep at clip time 0.15s and makes a brief recoil-driven backward leap from 0.45–2.2s; 绝死绝命 immediately pursues. During this single airborne exchange, the diagonal cut is deflected at 1.0s, a reverse recovery leads into the next blocked cut at 1.35s, and the redirected follow-through is stopped at 1.8s. The blade grazes the wall and floor along its attack path. Both land and regain balance at 2.2s. 马雷 (S1) says from 0.65–2.45s: <d>[Chinese] 突、突然就——</d> Normal playback speed; weapon sounds coincide with the contacts.',
    '[Shot 2] At 00:04.000 Both are already grounded. 绝死绝命 keeps facing 马雷, steadies the scythe and studies 马雷’s exposed abdomen for a defensive trap. 马雷 faces 绝死绝命 with the staff ready. The camera maintains the same action axis; no dialogue from 4–15s.',
  ]),
});
assert.equal(third.shots.length, 2);
assert.match(third.shots[0].action, /第0.45–2.2秒/u);
assert.match(third.shots[1].action, /双方脚掌已接地/u);
assert.doesNotMatch(third.officialPromptZh!, /仍悬空|继续悬空|11\.8/u);
console.log('PASS four-shot prolonged suspension becomes a synchronized two-shot Chinese/English delivery within 15s');

const first = await runScenario({
  id: 'forward-kick-axis', speaking: false,
  source: '绝死绝命看向门廊中的马雷，用右脚把身前的尸体踢向马雷。马雷侧身避开，尸体撞到其身后的墙。绝死绝命重新戒备。',
  original: [
    { start: 0, end: 4, action: '绝死绝命观察马雷', camera: '越肩后拉' },
    { start: 4, end: 7.5, action: '绝死绝命扭髋扫腿踢尸体向马雷', camera: '只拍脚部的低机位' },
    { start: 7.5, end: 11.5, action: '马雷躲开，尸体飞向后墙', camera: '切到门外跟尸体' },
    { start: 11.5, end: 15, action: '绝死绝命重新戒备', camera: '对峙全景' },
  ],
  corrected: [
    { start: 0, end: 4, action: '绝死绝命在房间内与门廊中的马雷相向，尸体在绝死绝命身前，视线锁住马雷', camera: '斜侧关系镜，交代人物与尸体在同一行动轴线' },
    { start: 4, end: 8, action: '绝死绝命头部视线、胸口与髋部保持朝向身前的马雷，左脚支撑，右脚向前踢中尸体腰侧；第0.5秒接触后尸体沿门廊飞向马雷，第0.9秒马雷侧闪，尸体从其身旁掠过，第1.2秒撞中马雷身后的墙',
      camera: '斜侧中全景连续呈现支撑脚、发力脚、尸体、具名目标马雷与闪避，不在接触处切镜' },
    { start: 8, end: 15, action: '绝死绝命右脚收回落地，继续面向马雷恢复戒备；马雷保持看向绝死绝命', camera: '沿同一行动轴线观察双方反应' },
  ],
  groups: [[0], [1, 2], [3]],
  zh: h3('zh', [
    '绝死绝命与门廊中的马雷相向，尸体在绝死绝命身前。斜侧关系镜展示两人的视线和行动轴线。',
    '[Shot 2] At 00:04.000 绝死绝命的头部视线、胸口与髋部朝向身前的马雷。左脚支撑，右脚向前踢中尸体腰侧；本段4.5秒接触，4.9秒马雷侧闪，5.2秒尸体从马雷身旁掠过后撞墙。斜侧中全景连续覆盖接触、飞行和回应。',
    '[Shot 3] At 00:08.000 绝死绝命右脚收回落地，保持面向马雷恢复戒备。马雷仍看向绝死绝命。机位沿同一行动轴线，0–15秒无对白。',
  ]),
  en: h3('en', [
    '绝死绝命 and 马雷 face one another across the doorway, with the corpse in front of 绝死绝命. An oblique relational view establishes their eyelines and action axis.',
    '[Shot 2] At 00:04.000 绝死绝命 keeps her gaze, chest and hips facing 马雷 in front of her. Her left foot supports her while her right foot kicks forward into the corpse’s waist; contact occurs at clip time 4.5s, 马雷 sidesteps at 4.9s, and the corpse passes beside 马雷 and hits the wall behind him at 5.2s. One oblique medium-wide view continuously covers contact, flight and response.',
    '[Shot 3] At 00:08.000 绝死绝命 retracts and plants her right foot, still facing 马雷 as she resumes her guard. 马雷 keeps looking toward 绝死绝命. The camera stays on the same action axis; no dialogue from 0–15s.',
  ]),
});
assert.equal(first.shots.length, 3);
assert.match(first.shots[1].action, /朝向身前的马雷.*左脚支撑，右脚向前踢/u);
assert.match(first.officialPromptEn!, /gaze, chest and hips facing 马雷.*right foot kicks forward/u);
assert.match(first.officialPromptEn!, /continuously covers contact, flight and response/u);
console.log('PASS forward kick, named target and continuous action axis reach English through the corrected three-shot schedule');
const voice = await runScenario({
  id: 'voice-source-identity', source: '少女马雷怯声问绝死绝命：“你是谁？”绝死绝命安静倾听。',
  original: [{ start: 0, end: 15, action: '马雷开口发问，绝死绝命倾听', camera: '双人中景',
    dialogue: '马雷 第1–3秒（低柔胆怯的少年音）：“你是谁？”' }],
  corrected: [{ start: 0, end: 15, action: '马雷开口发问，绝死绝命倾听', camera: '双人中景',
    dialogue: '马雷 第1–3秒（女性发声身份，怯声结巴）：“你是谁？”' }],
  groups: [[0]], speaking: true,
  zh: h3('zh', ['马雷 (S1)保持女性发声身份，在本段1–3秒怯声结巴地问：<d>[Chinese] 你是谁？</d>。绝死绝命倾听，不代说。']),
  en: h3('en', ['马雷 (S1) retains her female speaking identity and asks timidly with a stammer from clip time 1–3s: <d>[Chinese] 你是谁？</d> 绝死绝命 listens without speaking the line.']),
});
assert.match(voice.finalPrompt, /女性发声身份/u);
assert.match(voice.officialPromptEn!, /her female speaking identity/u);
assert.doesNotMatch(voice.officialPromptEn!, /boyish|\bhe\b|\bhis\b/iu);

console.log('Video source identity and action schedule pipeline: 3 offline integration cases passed; no project data or live API used');

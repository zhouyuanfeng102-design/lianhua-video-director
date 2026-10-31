import assert from 'node:assert/strict';
import { convertStoryboardDraftToFinal } from '../src/appEffects';
import {
  MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE,
  MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE,
  MOSE_JIANGHU_NSFW_VIDEO_SOUND_RULE,
  MOSE_JIANGHU_NSFW_VIDEO_ACTION_TRANSLATION_RULE,
} from '../src/nsfwPromptRules';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { generateOfficialSeedancePrompt } from '../src/seedancePrompt';
import type { SemanticSegmentSourceContext } from '../src/semanticSequencePlan';
import { requestShotRecommendation } from '../src/services/llm';
import { renderShotPrompt } from '../src/promptEngine';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import type { ConverterPreset, Storyboard, TextApiConfig, VideoShot } from '../src/types';

const clean = (value: string): string => value.trim();
const converter: ConverterPreset = {
  id: 'nsfw-video-action-converter',
  name: 'NSFW视频动作测试转换器',
  workflow: 'all',
  inputMode: 'all',
  scope: 'video',
  systemPrompt: '',
  outputRules: '',
  enabled: true,
  version: 'test',
  updatedAt: 1,
};

const shot = (action: string): VideoShot => ({
  id: 'shot-1',
  index: 1,
  startSec: 0,
  endSec: 5,
  subject: '林岚',
  action,
  purpose: '测试动作表达',
  space: '室内',
  direction: '面向镜头侧前方',
  performance: '自然表演',
  camera: '中景固定',
  transition: '无',
  lighting: '暖光',
  sound: '无',
  result: '动作结束',
  prompt: '',
  referenceAssetIds: [],
  locked: false,
});

const board = (sourceStoryContent: string, finalPrompt: string, action: string): Storyboard => ({
  id: 'board-nsfw-video-action',
  sceneId: 'scene',
  sourceStoryTitle: '测试',
  sourceStoryContent,
  workflow: 'drama',
  inputMode: 'text',
  durationSec: 5,
  durationPreset: 'custom',
  shotMode: 'exact',
  shotCount: 1,
  pace: 'standard',
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'none',
  stylePresetId: '',
  ruleSetId: '',
  converterPresetId: converter.id,
  globalLock: '',
  shots: [shot(action)],
  finalPrompt,
  createdAt: 1,
  updatedAt: 1,
});

const ordinaryPrompt = '【0s-5s】 主体：@林岚正在 [穿红裙走进室内]；空间：室内；光影：暖光；镜头：中景固定；台词：无；音效：环境层-[无] 动作层-[脚步声] 情绪层-[无配乐]';
const nsfwPrompt = '【0s-5s】 主体：@林岚正在 [全裸坐在床边，胸前和下体可见湿痕]；空间：卧室床边；光影：暖光；镜头：中景固定；台词：无；音效：环境层-[无] 动作层-[衣料轻响] 情绪层-[无配乐]';

let convertSystem = '';
const convertedBoard = await convertStoryboardDraftToFinal({
  draft: board('林岚全裸坐在床边，胸前和下体可见湿痕。', nsfwPrompt, '全裸坐在床边，胸前和下体可见湿痕'),
  converter,
  clean,
  request: async (system) => {
    convertSystem = system;
    return nsfwPrompt;
  },
});
assert.match(convertSystem, /NSFW 视频动作细化规则/u);
assert.match(convertSystem, /NSFW 视频声音细化规则/u);
assert.match(convertSystem, /动作阶段、人物反应、身体\/衣料\/环境材质/u);
assert.match(convertSystem, /接近与姿势建立写贴近呼吸/u);
assert.match(convertSystem, /克制、冷静、羞怯的人物/u);
assert.match(convertSystem, /不写成重击、格挡、拳脚冲撞、墙体震动、破裂声或战斗类拟声/u);
assert.match(convertSystem, /很轻的、贴在耳边的、没有房间敲击回响的湿滑黏连，停在压低喘息和台词下面/u);
assert.match(convertSystem, /音效句和 overall_soundscape 不用拍击、脆响、闷响、相撞、冲撞、撞击、重击/u);
assert.match(convertSystem, /同一个来回，由髋、腰或手持续带动/u);
assert.match(convertSystem, /髋和腰贴着对方做缓慢、小幅度、温柔的连续起伏，相接处一直贴着/u);
assert.match(convertSystem, /这串起伏从头到尾保持缓慢/u);
assert.match(convertSystem, /抽出大半、整根送回、退回大半、每一下、顶到底、顶入/u);
assert.match(convertSystem, /一上一下、加快、深而急、更急、加重、顶进去、顶得往前、一耸一耸/u);
assert.match(convertSystem, /短促进入声/u);
assert.match(convertSystem, /每个器官在每一句里都写明主人的姓名/u);
assert.match(convertSystem, /甲的手握住乙的肉棒/u);
assert.match(convertSystem, /人还留在里面/u);
assert.match(convertSystem, /不把连续来回写成一下猛插入再整个抽出/u);
assert.match(convertSystem, /闷闷声响/u);
assert.match(convertSystem, /喉咙里的闷哼是人声，可以保留/u);
assert.match(convertSystem, /拳脚、摔倒、撞门、手或物件拍桌、兵器相撞仍按那一下真实打击写/u);
assert.match(convertSystem, /抽送带动的桌面、床铺或地面晃动只留在画面里/u);
assert.match(convertSystem, /手、杯或其他物件单独打到桌面、门板、墙面或地板时，仍按那一下真实接触写成短促闷响或拍击/u);
assert.match(convertSystem, /私密身体对身体的接触不归入碰撞/u);
assert.equal(convertSystem.split(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE).length - 1, 1);
assert.equal(convertSystem.split(MOSE_JIANGHU_NSFW_VIDEO_SOUND_RULE).length - 1, 1);

let referenceRefreshSystem = '';
await convertStoryboardDraftToFinal({
  draft: convertedBoard,
  purpose: 'reference-refresh',
  converter,
  clean,
  request: async (system) => {
    referenceRefreshSystem = system;
    return nsfwPrompt;
  },
});
assert.equal(referenceRefreshSystem.includes(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE), false);
assert.equal(referenceRefreshSystem.includes(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE), true);

let ordinarySystem = '';
await convertStoryboardDraftToFinal({
  draft: board('林岚穿红裙走进室内。', ordinaryPrompt, '穿红裙走进室内'),
  converter,
  clean,
  request: async (system) => {
    ordinarySystem = system;
    return ordinaryPrompt;
  },
});
assert.equal(ordinarySystem.includes(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE), false);
assert.equal(ordinarySystem.includes(MOSE_JIANGHU_NSFW_VIDEO_SOUND_RULE), false);

let translationSystem = '';
const translationSource = '【0s-5s】 主体：@林岚正在 [全裸坐在床边，胸前和下体可见湿痕]；空间：卧室床边；光影：暖光；镜头：中景固定；台词：无；音效：环境层-[无] 动作层-[衣料轻响] 情绪层-[无配乐]';
await translateVideoPromptToEnglish({
  sourcePrompt: translationSource,
  request: async (system) => {
    translationSystem = system;
    return translationSource;
  },
  clean,
});
assert.equal(translationSystem.includes(MOSE_JIANGHU_NSFW_VIDEO_ACTION_TRANSLATION_RULE), true);
assert.match(translationSystem, /具体声音来源、人物反应、动作阶段、材质声/u);
assert.match(translationSystem, /不译成 slap, knock, thud, generic impact \/ collision \/ thud \/ striking \/ wall vibration \/ combat sound/u);
assert.match(translationSystem, /a very quiet close-to-the-ear wet adhesion with no room slap, sitting under the breath and dialogue/u);
assert.match(translationSystem, /hips and waist stay together in a small, slow, continuous rock and the contact stays joined/u);
assert.match(translationSystem, /抽出大半又整根送回、每一下顶到底或被撞得发颤时，翻译保持该动作/u);
assert.match(translationSystem, /翻译保持该动作，不在翻译阶段改成连续来回/u);
assert.match(translationSystem, /打斗、撞门、手拍桌面和兵器仍译成 impact、thud 或 metal clash/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE, /纯格式修复、参考更新和衔接修复保持已写动作原句和已写音效原句/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE, /抽出大半又整根送回、每一下顶到底/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE, /一上一下、加快、深而急、更急、加重、顶进去、顶得往前、一耸一耸/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE, /短促进入声/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE, /每个器官在每一句里都写明主人的姓名/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE, /回程仍留在里面/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE, /闷闷声响、深撞、撞击段/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE, /拍击、闷响、相撞、冲撞、撞击或脆响的句子改成很轻的、贴在耳边的、没有房间敲击回响的湿滑黏连/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE, /打斗、撞门、手拍桌面和兵器相撞保持撞击声/u);

const h3Prompt = [
  'integrated_multimodal_description:',
  '[Shot 1] 林岚坐在床边，保持本镜已经安排的动作。',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');
const h3Delivery = JSON.stringify({
  h3Prompt,
  identityBindings: { version: 1, characters: [] },
  characterParticipation: { version: 1, characters: [] },
});
const semanticNsfwContext: SemanticSegmentSourceContext = {
  kind: 'semantic-segment-source-v1',
  sourceStoryTitle: '测试',
  sourceContentHash: 'synthetic-semantic-source',
  segmentIndex: 1,
  segmentCount: 1,
  segmentDurationSec: 5,
  segment: {
    title: '当前片段',
    content: '林岚坐在床边继续当前互动。',
    summary: '继续当前互动',
    narrativePurpose: '推进当前事件',
    entryState: '两人已经靠近床边',
    exitState: '当前互动继续',
    transitionHint: '承接当前动作',
    boundaryReason: '当前事件窗口',
    continuityPack: '保持人物位置和动作阶段',
    semanticSource: {
      sourceEvidence: [{ text: '林岚全裸坐在床边，胸前和下体可见湿痕。' }],
      events: [],
      dialogues: [],
    },
  },
  generationStoryContent: '林岚坐在床边继续当前互动。',
  creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' },
  characterContinuity: [],
};
const plannerConfig: TextApiConfig = {
  enabled: true,
  provider: 'openai_compatible',
  baseUrl: 'https://nsfw-video-action.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-not-a-credential',
  model: 'synthetic-storyboard-planner',
  temperature: 0,
  maxTokens: 8192,
  vision: false,
};
const savedWindow = globalThis.window;
const savedFetch = globalThis.fetch;
let storyboardPlannerSystem = '';
let storyboardPlannerRequests = 0;
try {
  globalThis.fetch = async () => { throw new Error('This fixture cannot make live requests'); };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: { body?: string }) => {
      storyboardPlannerRequests += 1;
      const body = JSON.parse(payload.body || '{}') as { messages?: Array<{ role: string; content: string }> };
      storyboardPlannerSystem = body.messages?.filter(({ role }) => role === 'system')
        .map(({ content }) => content).join('\n') ?? '';
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        reason: '当前段完整排程',
        shots: [{
          startSec: 0,
          endSec: 5,
          sourceExcerpt: semanticNsfwContext.generationStoryContent,
          purpose: '推进当前事件',
          subject: '林岚',
          action: semanticNsfwContext.generationStoryContent,
          camera: '中景固定',
          transition: '连续动作',
          lighting: '暖光',
          sound: '无',
          result: '当前互动继续',
          space: '卧室床边',
          direction: '面向伴侣',
          performance: '延续当前状态',
          dialogue: '无',
        }],
      }) } }] }) };
    } },
  } });
  await requestShotRecommendation(plannerConfig, {
    story: semanticNsfwContext.generationStoryContent,
    durationSec: 5,
    workflow: 'drama',
    pace: 'standard',
    sequenceSegmentContext: semanticNsfwContext as unknown as Record<string, unknown>,
  });
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: savedWindow });
  globalThis.fetch = savedFetch;
}
assert.equal(storyboardPlannerRequests, 1);
assert.equal(storyboardPlannerSystem.includes(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE), true);
const translateDelivery = (user: string): string => {
  const data = JSON.parse(user) as { slots: Array<{ id: string; sourceText: string }> };
  return JSON.stringify({ slots: data.slots.map((slot) => ({
    id: slot.id,
    text: slot.sourceText.replace(/[\p{Script=Han}]+/gu, 'translated'),
  })) });
};
let h3ReviewSystem = '';
const h3Board = await generateSingleSegmentPrompt({
  board: board('林岚坐在床边继续当前互动。', ordinaryPrompt, '坐在床边继续当前互动'),
  context: { assets: [], characters: [] },
  converter,
  sequenceSegmentContext: semanticNsfwContext,
  reviewWithAi: true,
  clean,
  request: async (system, user, stage) => {
    if (stage === 'convert') return ordinaryPrompt;
    if (stage === 'review') {
      h3ReviewSystem = system;
      return h3Delivery;
    }
    return translateDelivery(user);
  },
});
assert.equal(h3ReviewSystem.includes(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE), true);
assert.equal(h3ReviewSystem.includes(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE), false);

let h3ReferenceRefreshSystem = '';
await generateSingleSegmentPrompt({
  board: h3Board,
  context: { assets: [], characters: [] },
  purpose: 'reference-refresh',
  skipConversion: true,
  sequenceSegmentContext: semanticNsfwContext,
  reviewWithAi: true,
  clean,
  request: async (system, user, stage) => {
    if (stage === 'review') {
      h3ReferenceRefreshSystem = system;
      return h3Delivery;
    }
    return translateDelivery(user);
  },
});
assert.equal(h3ReferenceRefreshSystem.includes(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE), false);
assert.equal(h3ReferenceRefreshSystem.includes(MOSE_JIANGHU_NSFW_VIDEO_ACTION_PRESERVATION_RULE), true);

let seedanceSystem = '';
await generateOfficialSeedancePrompt({
  input: {
    targetId: 'seedance-2.5',
    canonicalPrompt: nsfwPrompt,
    durationSec: 5,
    aspectRatio: '16:9',
    resolution: '1080p',
    audioMode: 'none',
    references: [],
    constraints: [],
    nsfwDetail: true,
    sourceEvidence: { sourceStoryContent: '林岚全裸坐在床边，胸前和下体可见湿痕。' },
  },
  request: async (system) => {
    seedanceSystem = system;
    return [
      '视频规格：时长 5 秒；画面比例 16:9；分辨率 1080p；声音模式 none。',
      '参考素材与职责：无参考素材。',
      '主体连续性：林岚保持当前镜头身份和状态。',
      '一句话概述：林岚坐在卧室床边。',
      '连续时间轴：0-5秒，林岚坐在床边保持当前动作。',
      '全局约束：保留当前镜头顺序和声音设置。',
    ].join('\n');
  },
});
assert.equal(seedanceSystem.includes(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE), true);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE, /精液从这名男性的龟头尿道口离开/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE, /连在他自己的腹股沟，从两腿之间向前/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE, /骨盆前面、两腿之间、会阴之前/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE, /胸口、腹部、髋和双膝指向同一方向/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE, /跪伏、趴跪、俯撑不套用这句同向/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE, /Both knees remain on the platform, shins folded behind the hips along the platform/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE, /The camera tilts down with small amplitude at slow speed from her face toward her waist\. Her knees remain on the platform/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_TRANSLATION_RULE, /her chest, abdomen, pelvis and knees face the same direction, and her knees point toward him/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_TRANSLATION_RULE, /不译成 chest, pelvis and knees face the same direction/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_TRANSLATION_RULE, /She remains kneeling bent over/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_TRANSLATION_RULE, /semen leaves the urethral opening at the glans/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_TRANSLATION_RULE, /his penis is attached at his groin and extends forward from between his thighs/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_TRANSLATION_RULE, /her vulva is on the front of her pelvis between her thighs, anterior to the perineum/u);
assert.match(MOSE_JIANGHU_NSFW_VIDEO_ACTION_TRANSLATION_RULE, /不从 the neck, jaw, mouth, nose, eyes, or fingers 离开/u);
assert.doesNotMatch(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE, /年龄门禁|未满|未成年/u);
assert.doesNotMatch(MOSE_JIANGHU_NSFW_VIDEO_SOUND_RULE, /年龄门禁|未满|未成年/u);

const intimateDraft = renderShotPrompt({
  ...shot('两人跨坐抽送，下腹反复撞在臀瓣上'),
  sound: '',
}, 5, []);
assert.match(intimateDraft, /动作层-\[贴近的皮肤贴合与湿滑摩擦声\]/u);
assert.doesNotMatch(intimateDraft, /接触碰撞声/u);
const doorDraft = renderShotPrompt({
  ...shot('旅人快跑后肩膀撞上木门'),
  sound: '',
}, 5, []);
assert.match(doorDraft, /动作层-\[很重的脚步声；接触碰撞声\]/u);
assert.doesNotMatch(doorDraft, /脚步声与接触碰撞声/u);
const walkDraft = renderShotPrompt({
  ...shot('小舞沿木走廊走向门口'),
  sound: '',
}, 5, []);
assert.match(walkDraft, /动作层-\[很轻的鞋底脚步声，停在对白下面\]/u);
assert.doesNotMatch(walkDraft, /接触碰撞声|pressing/u);

console.log('NSFW video action prompt rule injection checks passed');

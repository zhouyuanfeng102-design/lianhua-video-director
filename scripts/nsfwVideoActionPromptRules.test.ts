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
assert.match(translationSystem, /不译成 generic impact \/ collision \/ thud \/ striking \/ wall vibration \/ combat sound/u);

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
assert.doesNotMatch(MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE, /年龄门禁|未满|未成年/u);
assert.doesNotMatch(MOSE_JIANGHU_NSFW_VIDEO_SOUND_RULE, /年龄门禁|未满|未成年/u);

console.log('NSFW video action prompt rule injection checks passed');

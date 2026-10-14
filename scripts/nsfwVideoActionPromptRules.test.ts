import assert from 'node:assert/strict';
import { convertStoryboardDraftToFinal } from '../src/appEffects';
import {
  MOSE_JIANGHU_NSFW_VIDEO_ACTION_RULE,
  MOSE_JIANGHU_NSFW_VIDEO_SOUND_RULE,
  MOSE_JIANGHU_NSFW_VIDEO_ACTION_TRANSLATION_RULE,
} from '../src/nsfwPromptRules';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { generateOfficialSeedancePrompt } from '../src/seedancePrompt';
import type { ConverterPreset, Storyboard, VideoShot } from '../src/types';

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
await convertStoryboardDraftToFinal({
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

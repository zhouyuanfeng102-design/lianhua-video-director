import assert from 'node:assert/strict';
import * as sequencePlanModule from '../src/sequencePlan';
import {
  validateMasterTimelineSegmentGrid,
} from '../src/masterTimeline';
import {
  alignSequenceSegmentsToMasterShotBoundaries,
  assertAiSequenceSegmentShotCoverage,
  linkSegmentStoryboard,
  lockSequenceSegment,
  materializeAiSequenceSegments,
  mergeSequenceSegments,
  reorderSequenceSegment,
  restoreSequenceSegmentSourceContent,
  sequencePlanReviewFingerprint,
  sequencePlanSourceChanged,
  splitSequenceSegment,
  sliceMasterShotsForSegment,
  updateSequenceSegment,
  validateAndNormalizeSequencePlan,
} from '../src/sequencePlan';
import { masterPromptConfirmationFingerprint } from '../src/masterTimeline';
import { sourceContentHash } from '../src/sourceIntegrity';
import { validateStoryboardPrompt } from '../src/promptEngine';
import {
  buildLocalSequencePlan,
  extractStoryBeats,
  sequencePlanMasterDirectorSettingsIssue,
  sequencePlanMasterStoryboardIssue,
  validateSequencePlan,
} from '../src/storySegmentation';
import type { VideoSegment, VideoSequencePlan, VideoShot } from '../src/types';

const completeAiShotTrace = {
  modelRuleSetId: 'rule',
  converterPresetId: 'converter',
  sourceDocumentIds: [],
  referenceAssetIds: [],
  generatedAt: 1,
  mode: 'text-api' as const,
  shotRecommendationMode: 'text-api' as const,
  shotPlanMode: 'ai-complete' as const,
};

const segment = (
  index: number,
  overrides: Partial<VideoSegment> = {},
): VideoSegment => ({
  id: `segment-${index}`,
  index,
  title: `第${index}段`,
  globalStartSec: (index - 1) * 8,
  globalEndSec: index * 8,
  durationSec: 8,
  content: `剧情${index}上。剧情${index}下。`,
  summary: `摘要${index}`,
  sourceSceneIds: [`scene-${index}`],
  sourceBeatIds: [`beat-${index}-a`, `beat-${index}-b`],
  narrativePurpose: `目标${index}`,
  entryState: index === 1 ? '初始状态' : `交接${index - 1}`,
  exitState: `交接${index}`,
  transitionHint: `转场${index}`,
  storyboardId: `board-${index}`,
  status: 'ready',
  locked: false,
  ...overrides,
});

const makePlan = (): VideoSequencePlan => ({
  id: 'plan-1',
  title: '测试全片计划',
  sourceStoryTitle: '门后怪兽',
  sourceStoryContent: '完整原始剧情',
  durationMode: 'fixed',
  requestedTotalDurationSec: 24,
  totalDurationSec: 24,
  segmentDurationSec: 8,
  segmentationMode: 'fixed',
  fitStatus: 'balanced',
  estimateReason: '测试',
  segments: [segment(1), segment(2), segment(3)],
  createdAt: 100,
  updatedAt: 100,
});

const makeFourSegmentPlan = (durationSec = 8): VideoSequencePlan => ({
  ...makePlan(),
  requestedTotalDurationSec: durationSec * 4,
  totalDurationSec: durationSec * 4,
  segments: [1, 2, 3, 4].map((index) => segment(index, {
    durationSec,
    sourceBeatIds: [`beat-${index}-a`, `beat-${index}-b`],
  })),
});

const freezeDeep = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  }
  return value;
};

const original = freezeDeep(makePlan());
const originalSnapshot = JSON.stringify(original);

const realStory = [
  '第一盏灯亮起。',
  '第二扇门打开。',
  '第三阵风吹过。',
  '第四个脚步停下。',
  '第五面旗落下。',
  '第六道光熄灭。',
  '第七声钟响起。',
  '第八个人回头。',
].join('');
const realPlan = freezeDeep(buildLocalSequencePlan({
  title: '真实编辑计划',
  story: realStory,
  totalDurationSec: 16,
  segmentDurationSec: 8,
  segmentationMode: 'fixed',
  sourceSceneIds: ['scene-real'],
}));
const realPlanSnapshot = JSON.stringify(realPlan);
const realFourSegmentPlan = freezeDeep(buildLocalSequencePlan({
  title: '真实四段计划',
  story: realStory,
  totalDurationSec: 32,
  segmentDurationSec: 8,
  segmentationMode: 'fixed',
  sourceSceneIds: ['scene-real'],
}));
const realBeatsById = new Map(extractStoryBeats(realStory).map((beat) => [beat.id, beat.text]));

const aiMaterializerStory = '守门人推开舱门。追兵停下。守门人走进阴影。';
const aiMaterializerBeats = extractStoryBeats(aiMaterializerStory);
const aiMaterializerMasterShots: VideoShot[] = aiMaterializerBeats.map((beat, index) => ({
  id: `ai-master-${index + 1}`,
  index: index + 1,
  startSec: index * 5,
  endSec: (index + 1) * 5,
  purpose: `第${index + 1}镜目的`,
  subject: '守门人',
  action: beat.text,
  camera: '稳定中景',
  transition: '保持动作方向连续',
  lighting: '雨夜冷光',
  sound: '雨声与动作声同步',
  result: `第${index + 1}镜结果`,
  sourceBeatIds: [beat.id],
  sourceStart: beat.sourceStart,
  sourceEnd: beat.sourceEnd,
  referenceAssetIds: [],
  prompt: `【${index * 5}s-${(index + 1) * 5}s】 主体：@守门人；空间：舱门；光影：雨夜冷光；镜头：稳定中景；台词：无；音效：环境层-[雨声] 动作层-[脚步] 情绪层-[紧张]`,
  locked: false,
}));
const aiMaterializerBasePlan: VideoSequencePlan = {
  id: 'ai-materializer-plan',
  title: 'AI 分段物化测试',
  sourceStoryTitle: 'AI 分段物化测试',
  sourceStoryContent: aiMaterializerStory,
  sourceContentHash: undefined,
  durationMode: 'fixed',
  requestedTotalDurationSec: 15,
  totalDurationSec: 15,
  segmentDurationSec: 10,
  segmentationMode: 'natural',
  segmentationSource: 'ai',
  fitStatus: 'balanced',
  segments: [],
  planningStage: 'segmented',
  createdAt: 1,
  updatedAt: 1,
};

const aiMaterializerDraft = (sourceShotIds: string[], sourceBeatIds: string[], index: number) => ({
  sourceShotIds,
  sourceBeatIds,
  title: `AI 段 ${index}`,
  summary: `AI 摘要 ${index}`,
  narrativePurpose: `AI 目标 ${index}`,
  entryState: index === 1 ? '开场状态' : `承接第${index - 1}段出口`,
  exitState: `第${index}段出口`,
  transitionHint: '保持人物、空间、光线和声音连续',
  boundaryReason: '在完整动作结果后切段',
  continuityPack: '继承人物姿态、位置、道具、光线和声音',
});

const masterShots: VideoShot[] = [
  { id: 'master-shot-1', index: 1, startSec: 0, endSec: 4, purpose: '', subject: '主体A', action: '动作A', camera: '', transition: '', lighting: '', sound: '', result: '', referenceAssetIds: [], prompt: '【0s-4s】 主体：@主体A；空间：前景-门；中景-人物；背景-雨夜；光影：3200K暖光；镜头：缓慢推进；台词：无；音效：环境层-[雨声] 动作层-[脚步] 情绪层-[呼吸]', locked: false },
  { id: 'master-shot-2', index: 2, startSec: 4, endSec: 8, purpose: '', subject: '主体B', action: '动作B', camera: '', transition: '', lighting: '', sound: '', result: '', referenceAssetIds: [], prompt: '【4s-8s】 主体：@主体B；空间：前景-桌；中景-人物；背景-客栈；光影：5600K冷光；镜头：横向跟拍；台词：无；音效：环境层-[风声] 动作层-[衣摆] 情绪层-[紧张]', locked: false },
  { id: 'master-shot-3', index: 3, startSec: 8, endSec: 12, purpose: '', subject: '主体C', action: '动作C', camera: '', transition: '', lighting: '', sound: '', result: '', referenceAssetIds: [], prompt: '【8s-12s】 主体：@主体C；空间：前景-石阶；中景-人物；背景-月夜；光影：4400K中性光；镜头：拉远；台词：无；音效：环境层-[虫鸣] 动作层-[落叶] 情绪层-[释然]', locked: false },
];
const masterSlice = sliceMasterShotsForSegment(masterShots, {
  id: 'segment-master-slice',
  globalStartSec: 3,
  globalEndSec: 9,
  durationSec: 6,
});
assert.deepEqual(masterSlice.sourceShotIds, ['master-shot-1', 'master-shot-2', 'master-shot-3']);
assert.deepEqual(
  masterSlice.shots.map((shot) => [shot.startSec, shot.endSec, shot.index]),
  [[0, 1, 1], [1, 5, 2], [5, 6, 3]],
  'a segment prompt must be clipped from the master timeline and reset to local zero',
);
assert.ok(masterSlice.shots.every((shot) => shot.id.includes('segment-master-slice')));
assert.deepEqual(
  masterSlice.shots.map((shot) => shot.prompt),
  [
    '【0s-1s】 主体：@主体A；空间：前景-门；中景-人物；背景-雨夜；光影：3200K暖光；镜头：缓慢推进；台词：无；音效：环境层-[雨声] 动作层-[脚步] 情绪层-[呼吸]',
    '【1s-5s】 主体：@主体B；空间：前景-桌；中景-人物；背景-客栈；光影：5600K冷光；镜头：横向跟拍；台词：无；音效：环境层-[风声] 动作层-[衣摆] 情绪层-[紧张]',
    '【5s-6s】 主体：@主体C；空间：前景-石阶；中景-人物；背景-月夜；光影：4400K中性光；镜头：拉远；台词：无；音效：环境层-[虫鸣] 动作层-[落叶] 情绪层-[释然]',
  ],
  'a clipped master shot must retain its edited body while retiming only the leading timestamp',
);

const boundarySlice = sliceMasterShotsForSegment(masterShots, {
  id: 'segment-boundary',
  globalStartSec: 6,
  globalEndSec: 10,
  durationSec: 4,
});
assert.deepEqual(boundarySlice.sourceShotIds, ['master-shot-2', 'master-shot-3']);
assert.deepEqual(
  boundarySlice.shots.map((shot) => [shot.startSec, shot.endSec, shot.prompt]),
  [
    [0, 2, '【0s-2s】 主体：@主体B；空间：前景-桌；中景-人物；背景-客栈；光影：5600K冷光；镜头：横向跟拍；台词：无；音效：环境层-[风声] 动作层-[衣摆] 情绪层-[紧张]'],
    [2, 4, '【2s-4s】 主体：@主体C；空间：前景-石阶；中景-人物；背景-月夜；光影：4400K中性光；镜头：拉远；台词：无；音效：环境层-[虫鸣] 动作层-[落叶] 情绪层-[释然]'],
  ],
  'shots crossing segment boundaries must be clipped and retimed in both adjacent local timelines',
);

const absoluteSoundCueMasterShots: VideoShot[] = [
  {
    ...masterShots[0],
    id: 'absolute-sound-master-4',
    index: 4,
    startSec: 15,
    endSec: 19,
    sound: '环境层-[第15.3s远处溪流持续] 动作层-[第15.6s右脚落地] 情绪层-[无配乐]',
    prompt: '【15s-19s】 主体：@主体A；空间：前景-石桥 中景-人物 背景-溪谷；光影：3200K暖光；镜头：缓慢推进；台词：第2s @主体A："继续走。"；音效：环境层-[第15.3s远处溪流持续] 动作层-[第15.6s右脚落地] 情绪层-[无配乐]',
  },
  {
    ...masterShots[1],
    id: 'absolute-sound-master-5',
    index: 5,
    startSec: 19,
    endSec: 24,
    sound: '环境层-[远处溪流持续] 动作层-[第19.2s右脚落地，第20s叶片扫过袖口，第20.8s手掌抓紧桥面] 情绪层-[无配乐]',
    prompt: '【19s-24s】 主体：@主体B；空间：前景-桥面 中景-人物 背景-溪谷；光影：5600K冷光；镜头：横向跟拍；台词：第2s @主体B："第20秒不是这句台词的时间。"；音效：环境层-[远处溪流持续] 动作层-[第19.2s右脚落地，第20s叶片扫过袖口，第20.8s手掌抓紧桥面] 情绪层-[无配乐]',
  },
  {
    ...masterShots[2],
    id: 'absolute-sound-master-6',
    index: 6,
    startSec: 24,
    endSec: 30,
    sound: '环境层-[第25s起远处溪流持续] 动作层-[第24s双脚站定，第27s衣袍轻响] 情绪层-[无配乐]',
    prompt: '【24s-30s】 主体：@主体C；空间：前景-裂板 中景-人物 背景-溪谷；光影：4400K中性光；镜头：拉远；台词：无；音效：环境层-[第25s起远处溪流持续] 动作层-[第24s双脚站定，第27s衣袍轻响] 情绪层-[无配乐]',
  },
];
const absoluteSoundCueSlice = sliceMasterShotsForSegment(absoluteSoundCueMasterShots, {
  id: 'segment-absolute-sound-cues',
  globalStartSec: 15,
  globalEndSec: 30,
  durationSec: 15,
});
assert.deepEqual(
  absoluteSoundCueSlice.shots.map((shot) => [shot.startSec, shot.endSec, shot.sound]),
  [
    [0, 4, '环境层-[第0.3s远处溪流持续] 动作层-[第0.6s右脚落地] 情绪层-[无配乐]'],
    [4, 9, '环境层-[远处溪流持续] 动作层-[第0.2s右脚落地，第1s叶片扫过袖口，第1.8s手掌抓紧桥面] 情绪层-[无配乐]'],
    [9, 15, '环境层-[第1s起远处溪流持续] 动作层-[第0s双脚站定，第3s衣袍轻响] 情绪层-[无配乐]'],
  ],
  'legacy master sound metadata must convert obvious whole-film timestamps to per-shot relative cues',
);
assert.deepEqual(
  absoluteSoundCueSlice.shots.map((shot) => shot.prompt),
  [
    '【0s-4s】 主体：@主体A；空间：前景-石桥 中景-人物 背景-溪谷；光影：3200K暖光；镜头：缓慢推进；台词：第2s @主体A："继续走。"；音效：环境层-[第0.3s远处溪流持续] 动作层-[第0.6s右脚落地] 情绪层-[无配乐]',
    '【4s-9s】 主体：@主体B；空间：前景-桥面 中景-人物 背景-溪谷；光影：5600K冷光；镜头：横向跟拍；台词：第2s @主体B："第20秒不是这句台词的时间。"；音效：环境层-[远处溪流持续] 动作层-[第0.2s右脚落地，第1s叶片扫过袖口，第1.8s手掌抓紧桥面] 情绪层-[无配乐]',
    '【9s-15s】 主体：@主体C；空间：前景-裂板 中景-人物 背景-溪谷；光影：4400K中性光；镜头：拉远；台词：无；音效：环境层-[第1s起远处溪流持续] 动作层-[第0s双脚站定，第3s衣袍轻响] 情绪层-[无配乐]',
  ],
  'segment rebasing must repair only sound-field cues while preserving dialogue timing and quoted numbers',
);

const rendererAxisShots: VideoShot[] = [
  {
    ...masterShots[0],
    id: 'renderer-axis-master-19',
    index: 19,
    startSec: 60,
    endSec: 63,
    prompt: '【60s-63s】 主体：@守门人；空间：前景-门闩 中景-守门人 背景-城门；光影：4500K硬光；镜头：中景跟拍（轴线：主体运动方向与第18镜连续）；台词：第2s @守门人："第18镜留下的钥匙还在。"；音效：环境层-[风声] 动作层-[脚步] 情绪层-[紧张]',
  },
  {
    ...masterShots[1],
    id: 'renderer-axis-master-20',
    index: 20,
    startSec: 63,
    endSec: 66,
    prompt: '【63s-66s】 主体：@守门人；空间：前景-钥匙 中景-守门人 背景-城门；光影：4500K硬光；镜头：近景推进（轴线：主体运动方向与第19镜连续）；台词：第1s @守门人："按第19镜的计划关门。"；音效：环境层-[风声] 动作层-[关门声] 情绪层-[紧张]',
  },
];
const laterRendererAxisSlice = sliceMasterShotsForSegment(rendererAxisShots, {
  id: 'segment-renderer-axis-later',
  globalStartSec: 60,
  globalEndSec: 66,
  durationSec: 6,
});
assert.deepEqual(
  laterRendererAxisSlice.shots.map((shot) => [shot.index, shot.startSec, shot.endSec, shot.prompt]),
  [
    [1, 0, 3, '【0s-3s】 主体：@守门人；空间：前景-门闩 中景-守门人 背景-城门；光影：4500K硬光；镜头：中景跟拍（轴线：承接上一段末镜）；台词：第2s @守门人："第18镜留下的钥匙还在。"；音效：环境层-[风声] 动作层-[脚步] 情绪层-[紧张]'],
    [2, 3, 6, '【3s-6s】 主体：@守门人；空间：前景-钥匙 中景-守门人 背景-城门；光影：4500K硬光；镜头：近景推进（轴线：主体运动方向与上一镜连续）；台词：第1s @守门人："按第19镜的计划关门。"；音效：环境层-[风声] 动作层-[关门声] 情绪层-[紧张]'],
  ],
  'a later segment must rebase only renderer-owned axis references while preserving user shot numbers and dialogue cues',
);

const openingRendererAxisSlice = sliceMasterShotsForSegment([
  {
    ...masterShots[0],
    id: 'renderer-axis-master-1',
    index: 1,
    startSec: 0,
    endSec: 3,
    prompt: '【0s-3s】 主体：@守门人；空间：前景-门闩 中景-守门人 背景-城门；光影：4500K硬光；镜头：中景跟拍（轴线：主体运动方向与第1镜连续）；台词：第2s @守门人："第1镜从这里开始。"；音效：环境层-[风声] 动作层-[脚步] 情绪层-[紧张]',
  },
], {
  id: 'segment-renderer-axis-opening',
  globalStartSec: 0,
  globalEndSec: 3,
  durationSec: 3,
});
assert.equal(
  openingRendererAxisSlice.shots[0]?.prompt,
  '【0s-3s】 主体：@守门人；空间：前景-门闩 中景-守门人 背景-城门；光影：4500K硬光；镜头：中景跟拍（轴线：建立本镜轴线）；台词：第2s @守门人："第1镜从这里开始。"；音效：环境层-[风声] 动作层-[脚步] 情绪层-[紧张]',
  'the opening segment must establish its own axis without rewriting user-authored shot numbers',
);

const currentRendererAxisShots: VideoShot[] = [
  {
    ...masterShots[0],
    id: 'current-renderer-axis-master-1',
    index: 1,
    startSec: 0,
    endSec: 3,
    prompt: '【0s-3s】 主体：@守门人正在[记录“（轴线：建立当前主体运动方向）”这句原文]；空间：前景-门闩 中景-守门人 背景-城门；光影：4500K硬光；镜头：中景跟拍（轴线：建立当前主体运动方向）；台词：第2s @守门人："不要改掉（轴线：与前一镜保持主体运动方向连续）这句台词。"；音效：环境层-[风声] 动作层-[脚步] 情绪层-[紧张]',
  },
  {
    ...masterShots[1],
    id: 'current-renderer-axis-master-2',
    index: 2,
    startSec: 3,
    endSec: 6,
    prompt: '【3s-6s】 主体：@守门人正在[读出“（轴线：与前一镜保持主体运动方向连续）”这句原文]；空间：前景-钥匙 中景-守门人 背景-城门；光影：4500K硬光；镜头：近景推进（轴线：与前一镜保持主体运动方向连续）；台词：第1s @守门人："保留（轴线：建立当前主体运动方向）这句台词。"；音效：环境层-[风声] 动作层-[关门声] 情绪层-[紧张]',
  },
  {
    ...masterShots[2],
    id: 'current-renderer-axis-master-3',
    index: 3,
    startSec: 6,
    endSec: 9,
    prompt: '【6s-9s】 主体：@守门人；空间：前景-城门 中景-守门人 背景-街道；光影：4500K硬光；镜头：远景拉开（轴线：与前一镜保持主体运动方向连续）；台词：无；音效：环境层-[风声] 动作层-[门响] 情绪层-[平静]',
  },
];
const openingCurrentRendererAxisSlice = sliceMasterShotsForSegment(currentRendererAxisShots.slice(0, 2), {
  id: 'segment-current-renderer-axis-opening',
  globalStartSec: 0,
  globalEndSec: 6,
  durationSec: 6,
});
assert.deepEqual(
  openingCurrentRendererAxisSlice.shots.map((shot) => shot.prompt),
  [
    '【0s-3s】 主体：@守门人正在[记录“（轴线：建立当前主体运动方向）”这句原文]；空间：前景-门闩 中景-守门人 背景-城门；光影：4500K硬光；镜头：中景跟拍（轴线：建立本镜轴线）；台词：第2s @守门人："不要改掉（轴线：与前一镜保持主体运动方向连续）这句台词。"；音效：环境层-[风声] 动作层-[脚步] 情绪层-[紧张]',
    '【3s-6s】 主体：@守门人正在[读出“（轴线：与前一镜保持主体运动方向连续）”这句原文]；空间：前景-钥匙 中景-守门人 背景-城门；光影：4500K硬光；镜头：近景推进（轴线：与前一镜保持主体运动方向连续）；台词：第1s @守门人："保留（轴线：建立当前主体运动方向）这句台词。"；音效：环境层-[风声] 动作层-[关门声] 情绪层-[紧张]',
  ],
  'the opening segment must migrate only the current renderer axis annotation in the camera field',
);

const laterCurrentRendererAxisSlice = sliceMasterShotsForSegment(currentRendererAxisShots, {
  id: 'segment-current-renderer-axis-later',
  globalStartSec: 3,
  globalEndSec: 9,
  durationSec: 6,
});
assert.deepEqual(
  laterCurrentRendererAxisSlice.shots.map((shot) => shot.prompt),
  [
    '【0s-3s】 主体：@守门人正在[读出“（轴线：与前一镜保持主体运动方向连续）”这句原文]；空间：前景-钥匙 中景-守门人 背景-城门；光影：4500K硬光；镜头：近景推进（轴线：承接上一段末镜）；台词：第1s @守门人："保留（轴线：建立当前主体运动方向）这句台词。"；音效：环境层-[风声] 动作层-[关门声] 情绪层-[紧张]',
    '【3s-6s】 主体：@守门人；空间：前景-城门 中景-守门人 背景-街道；光影：4500K硬光；镜头：远景拉开（轴线：与前一镜保持主体运动方向连续）；台词：无；音效：环境层-[风声] 动作层-[门响] 情绪层-[平静]',
  ],
  'a later segment must turn only its first current renderer camera-axis annotation into a cross-segment handoff',
);

const precisionBoundaryShots: VideoShot[] = [
  {
    ...masterShots[0],
    id: 'precision-shot-1',
    startSec: 0,
    endSec: 9.516086,
    prompt: '【0s-9.516086s】 主体：@主体A；空间：前景-门；中景-人物；背景-雨夜；光影：3200K暖光；镜头：缓慢推进；台词：无；音效：环境层-[雨声] 动作层-[脚步] 情绪层-[呼吸]',
  },
  {
    ...masterShots[1],
    id: 'precision-shot-2',
    startSec: 9.516086,
    endSec: 18.57913,
    prompt: '【9.516086s-18.57913s】 主体：@主体B；空间：前景-桌；中景-人物；背景-客栈；光影：5600K冷光；镜头：横向跟拍；台词：无；音效：环境层-[风声] 动作层-[衣摆] 情绪层-[紧张]',
  },
];
const precisionBoundarySlice = sliceMasterShotsForSegment(precisionBoundaryShots, {
  id: 'segment-rounded-precision-boundary',
  globalStartSec: 0,
  globalEndSec: 9.52,
  durationSec: 9.52,
});
assert.deepEqual(
  precisionBoundarySlice.sourceShotIds,
  ['precision-shot-1'],
  'a high-precision shot starting just before a rounded segment boundary must not enter the prior segment as a zero-length fragment',
);
assert.deepEqual(
  precisionBoundarySlice.shots.map((shot) => [shot.startSec, shot.endSec]),
  [[0, 9.52]],
  'rounded segment slicing must discard zero-length fragments before retiming their canonical prompts',
);

const autoAlignDialogueBoundaries = (sequencePlanModule as any)
  .alignSequenceSegmentsToMasterShotBoundaries as undefined | ((
    plan: VideoSequencePlan,
    shots: readonly VideoShot[],
  ) => {
    plan: VideoSequencePlan;
    adjustedBoundaryCount: number;
    extendedSegments: Array<{ index: number; extensionSec: number }>;
  });
assert.equal(
  typeof autoAlignDialogueBoundaries,
  'function',
  'sequence planning must expose automatic master-shot boundary alignment',
);
const dialogueShotPrompt = '【0s-8s】 主体：@守门人（紧张）[朝向：门外] 正在 [抬手→关门→抵住房门]（阻止追兵进入）；空间：前景-门闩 中景-@守门人 背景-雨夜长街；光影：左侧3200K硬光塑造主体，明暗比4:1；镜头：近景稳定跟拍；台词：第0.5s @守门人："快关门，他们已经追上来了"；音效：环境层-[雨声] 动作层-[关门声] 情绪层-[急促呼吸]';
const dialogueBoundaryShots: VideoShot[] = [
  { ...masterShots[1], id: 'dialogue-master-2', startSec: 0, endSec: 8, action: '守门人大喊“快关门，他们已经追上来了”', prompt: dialogueShotPrompt },
  { ...masterShots[2], id: 'dialogue-master-3', startSec: 8, endSec: 10, prompt: masterShots[2].prompt.replace('【8s-12s】', '【8s-10s】') },
];
const dialogueBoundaryPlan: VideoSequencePlan = {
  ...makePlan(),
  requestedTotalDurationSec: 10,
  totalDurationSec: 10,
  segmentDurationSec: 6,
  segments: [
    segment(1, { globalStartSec: 0, globalEndSec: 6, durationSec: 6 }),
    segment(2, { globalStartSec: 6, globalEndSec: 10, durationSec: 4 }),
  ],
};
const dialogueBoundaryPlanSnapshot = JSON.stringify(dialogueBoundaryPlan);
const alignedDialogueBoundary = autoAlignDialogueBoundaries!(
  dialogueBoundaryPlan,
  dialogueBoundaryShots,
);
assert.equal(JSON.stringify(dialogueBoundaryPlan), dialogueBoundaryPlanSnapshot, 'automatic alignment must not mutate its input plan');
assert.deepEqual(
  alignedDialogueBoundary.plan.segments.map((item) => [item.globalStartSec, item.globalEndSec, item.durationSec]),
  [[0, 8, 8], [8, 10, 2]],
  'a boundary that cuts a master shot must move to the shot end and extend the preceding segment',
);
assert.equal(alignedDialogueBoundary.plan.totalDurationSec, 10);
assert.equal(
  alignedDialogueBoundary.plan.segmentDurationSec,
  6,
  'the user-selected segment duration remains a soft target after automatic extension',
);
assert.equal(alignedDialogueBoundary.adjustedBoundaryCount, 1);
assert.deepEqual(alignedDialogueBoundary.extendedSegments, [{ index: 1, extensionSec: 2 }]);
assert.deepEqual(
  alignedDialogueBoundary.plan.segments.map((item) => item.autoExtendedBySec),
  [2, undefined],
  'the automatically extended segment must retain an explicit user-facing adjustment',
);
assert.deepEqual(
  alignedDialogueBoundary.plan.segments.map((item) => item.sourceShotIds),
  [['dialogue-master-2'], ['dialogue-master-3']],
  'an aligned master shot must belong to exactly one segment',
);

const fifteenSecondBoundaryPlan: VideoSequencePlan = {
  ...makePlan(),
  requestedTotalDurationSec: 30,
  totalDurationSec: 30,
  segmentDurationSec: 15,
  segments: [
    segment(1, { globalStartSec: 0, globalEndSec: 15, durationSec: 15 }),
    segment(2, { globalStartSec: 15, globalEndSec: 30, durationSec: 15 }),
  ],
};
const fifteenSecondBoundaryShots: VideoShot[] = [
  [0, 8],
  [8, 16],
  [16, 23],
  [23, 30],
].map(([startSec, endSec], index) => ({
  ...masterShots[index % masterShots.length],
  id: `fifteen-second-shot-${index + 1}`,
  index: index + 1,
  startSec,
  endSec,
}));
const overlongMasterShot = {
  ...fifteenSecondBoundaryShots[0],
  id: 'overlong-master-shot-16s',
  startSec: 0,
  endSec: 16,
};
assert.throws(
  () => autoAlignDialogueBoundaries!(
    fifteenSecondBoundaryPlan,
    [
      overlongMasterShot,
      { ...fifteenSecondBoundaryShots[2], startSec: 16, endSec: 23 },
      { ...fifteenSecondBoundaryShots[3], startSec: 23, endSec: 30 },
    ],
  ),
  (error: unknown) => (
    error instanceof Error
    && error.message.includes('overlong-master-shot-16s')
    && error.message.includes('16')
    && error.message.includes('15')
    && /拆分.*镜头|镜头.*拆分/u.test(error.message)
  ),
  'one master shot beyond the 15-second model limit must stay explicitly diagnosable instead of silently widening the cap',
);

const fifteenSecondBoundarySnapshot = JSON.stringify(fifteenSecondBoundaryPlan);
const hardCappedAlignment = autoAlignDialogueBoundaries!(
  fifteenSecondBoundaryPlan,
  fifteenSecondBoundaryShots,
);
assert.equal(
  JSON.stringify(fifteenSecondBoundaryPlan),
  fifteenSecondBoundarySnapshot,
  'hard-cap alignment must not mutate the caller plan while inserting a legal split',
);
assert.equal(
  hardCappedAlignment.plan.segments.length,
  3,
  'two nominal 15-second segments must gain one segment when no two-way master-shot partition can stay within the model limit',
);
assert.deepEqual(
  hardCappedAlignment.plan.segments.map((item) => item.index),
  [1, 2, 3],
  'hard-cap expansion must renumber every split and unsplit segment by its final array position',
);
assert.ok(
  hardCappedAlignment.plan.segments.every((item) => item.durationSec <= 15),
  '15-second model configuration must never return an aligned segment above 15 seconds',
);
assert.ok(
  hardCappedAlignment.plan.segments
    .slice(0, -1)
    .every((item) => [8, 16, 23].includes(item.globalEndSec)),
  'automatic hard-cap splits must land only on complete authoritative master-shot boundaries',
);
assert.deepEqual(
  hardCappedAlignment.plan.segments.flatMap((item) => item.sourceShotIds || []),
  fifteenSecondBoundaryShots.map((shot) => shot.id),
  'hard-cap splitting must assign every master shot exactly once and in order',
);
assert.equal(
  hardCappedAlignment.plan.segments.map((item) => item.content).join(''),
  fifteenSecondBoundaryPlan.segments.map((item) => item.content).join(''),
  'automatic hard-cap splitting must not duplicate or drop source text',
);
assert.deepEqual(
  hardCappedAlignment.plan.segments.flatMap((item) => item.sourceBeatIds),
  fifteenSecondBoundaryPlan.segments.flatMap((item) => item.sourceBeatIds),
  'automatic hard-cap splitting must not duplicate or drop source beats',
);

type ReconcileSequenceProvenance = (
  plan: VideoSequencePlan,
  masterShots: ReadonlyArray<VideoShot & { sourceBeatIds?: string[] }>,
  beats: ReadonlyArray<{
    id: string;
    index: number;
    text: string;
    sourceStart?: number;
    sourceEnd?: number;
  }>,
  scenes: ReadonlyArray<{
    id: string;
    content: string;
    sourceStart?: number;
    sourceEnd?: number;
  }>,
  options?: { preserveAiMetadata?: boolean },
) => VideoSequencePlan;
const reconcileSequenceSegmentsToShotProvenance = (
  sequencePlanModule as unknown as {
    reconcileSequenceSegmentsToShotProvenance?: ReconcileSequenceProvenance;
  }
).reconcileSequenceSegmentsToShotProvenance;
assert.equal(
  typeof reconcileSequenceSegmentsToShotProvenance,
  'function',
  'aligned segments must expose one reconciliation step that makes segment text, beats and scenes follow the authoritative master shots',
);
const provenanceBeats = [
  { id: 'beat_1', index: 1, text: '炮火照亮街口。' },
  { id: 'beat_2', index: 2, text: '西娅转身冲向北侧防线。' },
  { id: 'beat_3', index: 3, text: '她向母巢发出呼唤。' },
  { id: 'beat_4', index: 4, text: '母亲答应派出增援。' },
];
const provenanceScenes = [
  { id: 'scene_battle', content: '炮火照亮街口。西娅转身冲向北侧防线。' },
  { id: 'scene_hive', content: '她向母巢发出呼唤。母亲答应派出增援。' },
];
const provenanceShots: Array<VideoShot & { sourceBeatIds: string[] }> = provenanceBeats.map((beat, index) => ({
  ...masterShots[Math.min(index, masterShots.length - 1)],
  id: `provenance-shot-${index + 1}`,
  index: index + 1,
  startSec: index * 2,
  endSec: (index + 1) * 2,
  action: beat.text,
  sourceBeatIds: [beat.id],
}));
const misalignedProvenancePlan: VideoSequencePlan = {
  ...makePlan(),
  sourceStoryContent: provenanceBeats.map((beat) => beat.text).join(''),
  requestedTotalDurationSec: 8,
  totalDurationSec: 8,
  segments: [
    segment(1, {
      globalStartSec: 0,
      globalEndSec: 4,
      durationSec: 4,
      sourceShotIds: ['provenance-shot-1', 'provenance-shot-2'],
      sourceBeatIds: ['beat_1', 'beat_2', 'beat_3'],
      sourceSceneIds: ['scene_battle', 'scene_hive'],
      content: '错误地多带了下一场剧情。',
      exitState: '错误的旧边界。',
    }),
    segment(2, {
      globalStartSec: 4,
      globalEndSec: 8,
      durationSec: 4,
      sourceShotIds: ['provenance-shot-3', 'provenance-shot-4'],
      sourceBeatIds: ['beat_4'],
      sourceSceneIds: ['scene_battle', 'scene_hive'],
      content: '错误地遗漏了呼唤。',
      entryState: '与上一段不一致的旧入口。',
    }),
  ],
};
const reconciledProvenancePlan = reconcileSequenceSegmentsToShotProvenance!(
  misalignedProvenancePlan,
  provenanceShots,
  provenanceBeats,
  provenanceScenes,
);
assert.deepEqual(
  reconciledProvenancePlan.segments.map((item) => item.sourceBeatIds),
  [['beat_1', 'beat_2'], ['beat_3', 'beat_4']],
  'segment beat ownership must be rebuilt from its authoritative source shots instead of retaining the pre-alignment allocation',
);
assert.deepEqual(
  reconciledProvenancePlan.segments.map((item) => item.content),
  ['炮火照亮街口。西娅转身冲向北侧防线。', '她向母巢发出呼唤。母亲答应派出增援。'],
  'segment source text must be rebuilt byte-for-byte from the beats owned by its master shots',
);
assert.deepEqual(
  reconciledProvenancePlan.segments.map((item) => item.sourceSceneIds),
  [['scene_battle'], ['scene_hive']],
  'each segment must bind only scenes overlapping its own source beats',
);
assert.equal(
  reconciledProvenancePlan.segments[1].entryState,
  reconciledProvenancePlan.segments[0].exitState,
  'reconciliation must rebuild the cross-segment hand-off after a shot boundary changes',
);
const aiOwnedBeatPlan = structuredClone(misalignedProvenancePlan);
aiOwnedBeatPlan.segmentationSource = 'ai';
aiOwnedBeatPlan.segments[0].summary = 'AI 明确决定第一段保留前三个节拍。';
aiOwnedBeatPlan.segments[0].content = 'AI 保留的完整语义段正文。';
aiOwnedBeatPlan.segments[0].exitState = 'AI 指定的出口状态。';
const reconciledAiOwnedBeatPlan = sequencePlanModule.reconcileSequenceSegmentsToShotProvenance(
  aiOwnedBeatPlan,
  provenanceShots,
  provenanceBeats,
  provenanceScenes,
  { preserveAiMetadata: true },
);
assert.deepEqual(
  reconciledAiOwnedBeatPlan.segments.map((item) => item.sourceBeatIds),
  [['beat_1', 'beat_2', 'beat_3'], ['beat_4']],
  'AI beat ownership must be preserved instead of being re-partitioned from master-shot candidates',
);
assert.equal(
  reconciledAiOwnedBeatPlan.segments[0].content,
  'AI 保留的完整语义段正文。',
  'AI-authored segment content must not be replaced by a locally reconstructed beat string',
);
assert.equal(
  reconciledAiOwnedBeatPlan.segments[0].summary,
  'AI 明确决定第一段保留前三个节拍。',
  'AI-authored descriptive metadata must survive provenance reconciliation',
);
assert.equal(
  reconciledAiOwnedBeatPlan.segments[0].exitState,
  'AI 指定的出口状态。',
  'AI-authored continuity state must not be replaced by a locally derived boundary state',
);
const dialogueBoundaryBeats = [
  { id: 'dialogue-boundary-beat-1', index: 1, text: '边缘划水举起对讲机。' },
  {
    id: 'dialogue-boundary-beat-2',
    index: 2,
    text: '边缘划水朝“北人”母巢大声吼道：“前进！！”',
  },
  { id: 'dialogue-boundary-beat-3', index: 3, text: '增援车队调转方向。' },
];
const dialogueBoundaryStory = dialogueBoundaryBeats.map((beat) => beat.text).join('');
const dialogueHandoffShots: Array<VideoShot & { sourceBeatIds: string[] }> =
  dialogueBoundaryBeats.map((beat, index) => ({
    ...provenanceShots[index],
    id: `dialogue-boundary-shot-${index + 1}`,
    index: index + 1,
    startSec: index * 2,
    endSec: (index + 1) * 2,
    subject: index < 2 ? '边缘划水' : '增援车队',
    action: beat.text,
    sourceBeatIds: [beat.id],
  }));
const dialogueHandoffPlan: VideoSequencePlan = {
  ...makePlan(),
  sourceStoryContent: dialogueBoundaryStory,
  requestedTotalDurationSec: 6,
  totalDurationSec: 6,
  segments: [
    segment(1, {
      globalStartSec: 0,
      globalEndSec: 4,
      durationSec: 4,
      sourceShotIds: ['dialogue-boundary-shot-1', 'dialogue-boundary-shot-2'],
      sourceBeatIds: ['dialogue-boundary-beat-1', 'dialogue-boundary-beat-2'],
    }),
    segment(2, {
      globalStartSec: 4,
      globalEndSec: 6,
      durationSec: 2,
      sourceShotIds: ['dialogue-boundary-shot-3'],
      sourceBeatIds: ['dialogue-boundary-beat-3'],
    }),
  ],
};
const reconciledDialogueBoundaryPlan = reconcileSequenceSegmentsToShotProvenance!(
  dialogueHandoffPlan,
  dialogueHandoffShots,
  dialogueBoundaryBeats,
  [{ id: 'dialogue-boundary-scene', content: dialogueBoundaryStory }],
);
assert.doesNotMatch(
  reconciledDialogueBoundaryPlan.segments[0].exitState,
  /前进！！/u,
  'a continuity hand-off must not repeat dialogue that already belongs to the final shot',
);
assert.match(
  reconciledDialogueBoundaryPlan.segments[0].exitState,
  /边缘划水/u,
  'removing dialogue from a hand-off must retain the speaking subject',
);
assert.match(
  reconciledDialogueBoundaryPlan.segments[0].exitState,
  /“北人”母巢/u,
  'quoted entity names must remain when only actual dialogue is removed',
);
assert.equal(
  reconciledDialogueBoundaryPlan.segments[1].entryState,
  reconciledDialogueBoundaryPlan.segments[0].exitState,
  'the next segment must inherit the cleaned hand-off exactly',
);
const overriddenProvenancePlan = structuredClone(misalignedProvenancePlan);
overriddenProvenancePlan.segments[0].content = '用户明确覆盖的第一段正文。';
overriddenProvenancePlan.segments[0].contentOverridden = true;
const reconciledOverriddenProvenancePlan = reconcileSequenceSegmentsToShotProvenance!(
  overriddenProvenancePlan,
  provenanceShots,
  provenanceBeats,
  provenanceScenes,
);
assert.equal(
  reconciledOverriddenProvenancePlan.segments[0].content,
  '用户明确覆盖的第一段正文。',
  'provenance reconciliation must preserve explicitly overridden segment text',
);
assert.deepEqual(
  reconciledOverriddenProvenancePlan.segments.map((item) => item.sourceBeatIds),
  [['beat_1', 'beat_2'], ['beat_3', 'beat_4']],
  'an overridden segment must still take authoritative beat ownership from its shots exactly once',
);
assert.deepEqual(
  reconciledOverriddenProvenancePlan.segments.map((item) => item.sourceSceneIds),
  [['scene_battle'], ['scene_hive']],
  'content override must not preserve stale scene provenance after shot-boundary alignment',
);
assert.equal(
  reconciledOverriddenProvenancePlan.segments[0].exitState,
  '第 1 段结束于：西娅转身冲向北侧防线。',
  'content override must not preserve an exit state from the old beat boundary',
);
assert.equal(
  reconciledOverriddenProvenancePlan.segments[1].entryState,
  reconciledOverriddenProvenancePlan.segments[0].exitState,
  'the segment after an override must inherit the rebuilt authoritative hand-off',
);
const repeatedSceneStory = '警灯亮起。风声掠过。警灯亮起。';
const repeatedSceneBeats = [
  { id: 'repeated-beat-1', index: 1, text: '警灯亮起。' },
  { id: 'repeated-beat-2', index: 2, text: '风声掠过。' },
  { id: 'repeated-beat-3', index: 3, text: '警灯亮起。' },
];
const repeatedSceneShots = repeatedSceneBeats.map((beat, index) => ({
  ...provenanceShots[index],
  id: `repeated-scene-shot-${index + 1}`,
  index: index + 1,
  startSec: index * 2,
  endSec: (index + 1) * 2,
  sourceBeatIds: [beat.id],
}));
const repeatedScenePlan: VideoSequencePlan = {
  ...makePlan(),
  sourceStoryContent: repeatedSceneStory,
  requestedTotalDurationSec: 6,
  totalDurationSec: 6,
  segmentDurationSec: 2,
  segments: repeatedSceneBeats.map((beat, index) => segment(index + 1, {
    globalStartSec: index * 2,
    globalEndSec: (index + 1) * 2,
    durationSec: 2,
    sourceShotIds: [repeatedSceneShots[index].id],
    sourceBeatIds: [beat.id],
    content: beat.text,
  })),
};
const firstRepeatedSceneEnd = '警灯亮起。'.length;
const middleSceneStart = firstRepeatedSceneEnd;
const middleSceneEnd = middleSceneStart + '风声掠过。'.length;
const repeatedScenesWithOffsets = [
  {
    id: 'scene-repeated-last',
    content: '警灯亮起。',
    sourceStart: middleSceneEnd,
    sourceEnd: repeatedSceneStory.length,
  },
  {
    id: 'scene-repeated-first',
    content: '警灯亮起。',
    sourceStart: 0,
    sourceEnd: firstRepeatedSceneEnd,
  },
  {
    id: 'scene-repeated-middle',
    content: '风声掠过。',
    sourceStart: middleSceneStart,
    sourceEnd: middleSceneEnd,
  },
];
const reconciledRepeatedScenePlan = reconcileSequenceSegmentsToShotProvenance!(
  repeatedScenePlan,
  repeatedSceneShots,
  repeatedSceneBeats,
  repeatedScenesWithOffsets,
);
assert.deepEqual(
  reconciledRepeatedScenePlan.segments.map((item) => item.sourceSceneIds),
  [['scene-repeated-first'], ['scene-repeated-middle'], ['scene-repeated-last']],
  'persisted source offsets must disambiguate identical scene text even when scene records are reordered',
);
assert.throws(
  () => reconcileSequenceSegmentsToShotProvenance!(
    repeatedScenePlan,
    repeatedSceneShots,
    repeatedSceneBeats,
    repeatedScenesWithOffsets.map((scene) => scene.id === 'scene-repeated-last'
      ? { ...scene, sourceStart: 1, sourceEnd: firstRepeatedSceneEnd + 1 }
      : scene),
  ),
  /场景 scene-repeated-last.*来源区间无效或与原文不一致/u,
  'an explicitly persisted invalid scene range must be rejected instead of falling back to the first repeated text match',
);
const persistedLastRepeatedBeat = [{
  id: 'persisted-last-repeated-beat',
  index: 3,
  text: '警灯亮起。',
  sourceStart: middleSceneEnd,
  sourceEnd: repeatedSceneStory.length,
}];
const persistedLastRepeatedShot = [{
  ...provenanceShots[0],
  id: 'persisted-last-repeated-shot',
  sourceBeatIds: ['persisted-last-repeated-beat'],
}];
const persistedLastRepeatedPlan: VideoSequencePlan = {
  ...makePlan(),
  sourceStoryContent: repeatedSceneStory,
  requestedTotalDurationSec: 2,
  totalDurationSec: 2,
  segmentDurationSec: 2,
  segments: [segment(1, {
    globalStartSec: 0,
    globalEndSec: 2,
    durationSec: 2,
    sourceShotIds: ['persisted-last-repeated-shot'],
    sourceBeatIds: ['persisted-last-repeated-beat'],
    content: '警灯亮起。',
  })],
};
const reconciledPersistedLastRepeatedPlan = reconcileSequenceSegmentsToShotProvenance!(
  persistedLastRepeatedPlan,
  persistedLastRepeatedShot,
  persistedLastRepeatedBeat,
  repeatedScenesWithOffsets,
);
assert.deepEqual(
  reconciledPersistedLastRepeatedPlan.segments[0].sourceSceneIds,
  ['scene-repeated-last'],
  'a persisted beat range must locate a later identical excerpt without falling back to the first indexOf match',
);
const strictOffsetStory = '甲推开门。乙走进房间。';
const strictOffsetBeats = extractStoryBeats(strictOffsetStory);
const strictOffsetShots: Array<VideoShot & { sourceBeatIds: string[] }> = [
  {
    ...provenanceShots[0],
    id: 'strict-offset-shot-wide',
    sourceBeatIds: ['beat_1', 'beat_2'],
    sourceStart: 0,
    sourceEnd: 11,
  },
  {
    ...provenanceShots[1],
    id: 'strict-offset-shot-shared',
    sourceBeatIds: ['beat_1'],
    sourceStart: 0,
    sourceEnd: 5,
  },
];
const strictOffsetPlan: VideoSequencePlan = {
  ...makePlan(),
  sourceStoryContent: strictOffsetStory,
  requestedTotalDurationSec: 4,
  totalDurationSec: 4,
  segmentDurationSec: 4,
  segments: [segment(1, {
    globalStartSec: 0,
    globalEndSec: 4,
    durationSec: 4,
    sourceShotIds: strictOffsetShots.map((shot) => shot.id),
    sourceBeatIds: strictOffsetBeats.map((beat) => beat.id),
    content: strictOffsetStory,
  })],
};
const reconciledStrictOffsetPlan = reconcileSequenceSegmentsToShotProvenance!(
  strictOffsetPlan,
  strictOffsetShots,
  strictOffsetBeats,
  [{ id: 'strict-offset-scene', content: strictOffsetStory, sourceStart: 0, sourceEnd: 11 }],
);
assert.equal(
  reconciledStrictOffsetPlan.segments[0].content,
  strictOffsetStory,
  'multiple shots may share a source beat when their declared IDs match the ranges they actually intersect',
);

const splitCoarseBeatStory = '甲推开门。';
const splitCoarseBeatBeats = extractStoryBeats(splitCoarseBeatStory);
const splitCoarseBeatShots: Array<VideoShot & { sourceBeatIds: string[] }> = [
  {
    ...provenanceShots[0],
    id: 'split-coarse-beat-shot-1',
    index: 1,
    startSec: 0,
    endSec: 2,
    sourceBeatIds: ['beat_1'],
    sourceStart: 0,
    sourceEnd: 2,
  },
  {
    ...provenanceShots[1],
    id: 'split-coarse-beat-shot-2',
    index: 2,
    startSec: 2,
    endSec: 4,
    sourceBeatIds: ['beat_1'],
    sourceStart: 2,
    sourceEnd: splitCoarseBeatStory.length,
  },
];
const splitCoarseBeatPlan: VideoSequencePlan = {
  ...makePlan(),
  sourceStoryContent: splitCoarseBeatStory,
  requestedTotalDurationSec: 4,
  totalDurationSec: 4,
  segmentDurationSec: 4,
  segmentationSource: 'ai',
  segments: [segment(1, {
    globalStartSec: 0,
    globalEndSec: 4,
    durationSec: 4,
    sourceShotIds: splitCoarseBeatShots.map((shot) => shot.id),
    sourceBeatIds: ['beat_1'],
    content: splitCoarseBeatStory,
  })],
};
assert.equal(
  reconcileSequenceSegmentsToShotProvenance!(
    splitCoarseBeatPlan,
    splitCoarseBeatShots,
    splitCoarseBeatBeats,
    [{ id: 'split-coarse-beat-scene', content: splitCoarseBeatStory, sourceStart: 0, sourceEnd: splitCoarseBeatStory.length }],
    { preserveAiMetadata: true },
  ).segments[0].content,
  splitCoarseBeatStory,
  'adjacent exact source-unit sub-ranges may jointly cover one coarser semantic beat',
);
assert.throws(
  () => reconcileSequenceSegmentsToShotProvenance!(
    splitCoarseBeatPlan,
    splitCoarseBeatShots.map((shot, index) => index === 1 ? { ...shot, sourceStart: 3 } : shot),
    splitCoarseBeatBeats,
    [{ id: 'split-coarse-beat-scene', content: splitCoarseBeatStory, sourceStart: 0, sourceEnd: splitCoarseBeatStory.length }],
    { preserveAiMetadata: true },
  ),
  /来源区间未完整覆盖剧情节拍 beat_1.*正文缺口/u,
  'loosening per-shot equality must not allow a non-whitespace gap in the source story',
);

const missingBeatCoverageShots = strictOffsetShots.map((shot, index) => ({
  ...shot,
  id: `missing-beat-coverage-shot-${index + 1}`,
  index: index + 1,
  startSec: index * 2,
  endSec: (index + 1) * 2,
  sourceBeatIds: ['beat_1'],
  sourceStart: 0,
  sourceEnd: 5,
}));
assert.throws(
  () => reconcileSequenceSegmentsToShotProvenance!(
    {
      ...strictOffsetPlan,
      segmentationSource: 'ai',
      segments: [{
        ...strictOffsetPlan.segments[0],
        sourceShotIds: missingBeatCoverageShots.map((shot) => shot.id),
      }],
    },
    missingBeatCoverageShots,
    strictOffsetBeats,
    [{ id: 'strict-offset-scene', content: strictOffsetStory, sourceStart: 0, sourceEnd: strictOffsetStory.length }],
    { preserveAiMetadata: true },
  ),
  /来源区间未覆盖剧情节拍 beat_2.*不一致/u,
  'AI consumer validation must reject a declared beat that no master-shot range covers',
);
const legacyShotsWithModernBeats = strictOffsetShots.map((shot) => {
  const { sourceStart: _sourceStart, sourceEnd: _sourceEnd, ...legacyShot } = shot;
  return legacyShot;
});
assert.equal(
  reconcileSequenceSegmentsToShotProvenance!(
    strictOffsetPlan,
    legacyShotsWithModernBeats,
    strictOffsetBeats,
    [{ id: 'strict-offset-scene', content: strictOffsetStory, sourceStart: 0, sourceEnd: 11 }],
  ).segments[0].content,
  strictOffsetStory,
  'a legacy master shot with neither offset must remain compatible with newly extracted beats that now carry offsets',
);

const strictOffsetRejectionDefects: string[] = [];
const expectStrictOffsetRejection = (
  label: string,
  shots: readonly (VideoShot & { sourceBeatIds?: string[] })[],
  beats: Parameters<ReconcileSequenceProvenance>[2],
  expectedMessage: RegExp,
): void => {
  try {
    reconcileSequenceSegmentsToShotProvenance!(
      strictOffsetPlan,
      shots,
      beats,
      [{ id: 'strict-offset-scene', content: strictOffsetStory, sourceStart: 0, sourceEnd: 11 }],
    );
    strictOffsetRejectionDefects.push(`${label}: unexpectedly accepted`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!expectedMessage.test(message)) strictOffsetRejectionDefects.push(`${label}: ${message}`);
  }
};
expectStrictOffsetRejection(
  'unknown beat',
  strictOffsetShots.map((shot, index) => index === 0
    ? { ...shot, sourceBeatIds: ['beat_1', 'missing-beat'] }
    : shot),
  strictOffsetBeats,
  /strict-offset-shot-wide.*未知剧情节拍.*missing-beat/u,
);
expectStrictOffsetRejection(
  'one-sided shot range',
  strictOffsetShots.map((shot, index) => index === 0
    ? { ...shot, sourceEnd: undefined }
    : shot),
  strictOffsetBeats,
  /strict-offset-shot-wide.*sourceStart.*sourceEnd.*成对/u,
);
expectStrictOffsetRejection(
  'invalid shot range',
  strictOffsetShots.map((shot, index) => index === 0
    ? { ...shot, sourceStart: 11, sourceEnd: 11 }
    : shot),
  strictOffsetBeats,
  /strict-offset-shot-wide.*来源区间.*无效/u,
);
expectStrictOffsetRejection(
  'mismatched shot range',
  strictOffsetShots.map((shot, index) => index === 0
    ? { ...shot, sourceEnd: 10 }
    : shot),
  strictOffsetBeats,
  /strict-offset-shot-wide.*来源区间.*剧情节拍.*不一致/u,
);
expectStrictOffsetRejection(
  'one-sided beat range',
  strictOffsetShots,
  strictOffsetBeats.map((beat, index) => index === 0
    ? { ...beat, sourceEnd: undefined }
    : beat),
  /剧情节拍 beat_1.*sourceStart.*sourceEnd.*成对/u,
);
expectStrictOffsetRejection(
  'invalid beat range',
  strictOffsetShots,
  strictOffsetBeats.map((beat, index) => index === 0
    ? { ...beat, sourceStart: 5, sourceEnd: 10 }
    : beat),
  /剧情节拍 beat_1.*来源区间.*(?:无效|原文不一致)/u,
);
const repeatedOffsetBeats = extractStoryBeats(repeatedSceneStory);
const repeatedOffsetShots = repeatedOffsetBeats.map((beat, index) => ({
  ...provenanceShots[index],
  id: `strict-repeated-offset-shot-${index + 1}`,
  sourceBeatIds: [beat.id],
  sourceStart: beat.sourceStart,
  sourceEnd: beat.sourceEnd,
}));
const repeatedOffsetPlan: VideoSequencePlan = {
  ...strictOffsetPlan,
  sourceStoryContent: repeatedSceneStory,
  requestedTotalDurationSec: 6,
  totalDurationSec: 6,
  segmentDurationSec: 6,
  segments: [segment(1, {
    globalStartSec: 0,
    globalEndSec: 6,
    durationSec: 6,
    sourceShotIds: repeatedOffsetShots.map((shot) => shot.id),
    sourceBeatIds: repeatedOffsetBeats.map((beat) => beat.id),
    content: repeatedSceneStory,
  })],
};
try {
  reconcileSequenceSegmentsToShotProvenance!(
    repeatedOffsetPlan,
    repeatedOffsetShots,
    repeatedOffsetBeats.map((beat, index) => index === 2
      ? { ...beat, sourceStart: 0, sourceEnd: 5 }
      : beat),
    repeatedScenesWithOffsets,
  );
  strictOffsetRejectionDefects.push('repeated beat wrong instance: unexpectedly accepted');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/剧情节拍 beat_3.*(?:顺序|重叠)/u.test(message)) {
    strictOffsetRejectionDefects.push(`repeated beat wrong instance: ${message}`);
  }
}
assert.deepEqual(
  strictOffsetRejectionDefects,
  [],
  'persisted shot and beat provenance must reject every malformed or mismatched source range explicitly',
);
const sharedBeatShots: Array<VideoShot & { sourceBeatIds: string[] }> = [
  {
    ...provenanceShots[0],
    id: 'shared-beat-shot-1',
    index: 1,
    startSec: 0,
    endSec: 4,
    sourceBeatIds: ['beat_1', 'beat_2'],
  },
  {
    ...provenanceShots[1],
    id: 'shared-beat-shot-2',
    index: 2,
    startSec: 4,
    endSec: 8,
    sourceBeatIds: ['beat_2'],
  },
];
const sharedBeatPlan: VideoSequencePlan = {
  ...makePlan(),
  sourceStoryContent: provenanceBeats.slice(0, 2).map((beat) => beat.text).join(''),
  requestedTotalDurationSec: 8,
  totalDurationSec: 8,
  segmentDurationSec: 4,
  segments: [
    segment(1, {
      globalStartSec: 0,
      globalEndSec: 4,
      durationSec: 4,
      sourceShotIds: ['shared-beat-shot-1'],
      sourceBeatIds: ['beat_1'],
      sourceSceneIds: ['scene_battle'],
      content: provenanceBeats[0].text,
    }),
    segment(2, {
      globalStartSec: 4,
      globalEndSec: 8,
      durationSec: 4,
      sourceShotIds: ['shared-beat-shot-2'],
      sourceBeatIds: ['beat_2'],
      sourceSceneIds: ['scene_battle'],
      content: provenanceBeats[1].text,
    }),
  ],
};
const reconciledSharedBeatPlan = reconcileSequenceSegmentsToShotProvenance!(
  sharedBeatPlan,
  sharedBeatShots,
  provenanceBeats.slice(0, 2),
  provenanceScenes.slice(0, 1),
);
assert.deepEqual(
  reconciledSharedBeatPlan.segments.map((item) => item.sourceBeatIds),
  [['beat_1'], ['beat_2']],
  'a beat shared by adjacent shots must be reserved for the later segment when that is the only ordered exact-cover partition',
);
assert.deepEqual(
  reconciledSharedBeatPlan.segments.map((item) => item.content),
  [provenanceBeats[0].text, provenanceBeats[1].text],
  'shared-shot provenance must still rebuild each source byte exactly once',
);

const overriddenSharedBeatPlan = structuredClone(sharedBeatPlan);
overriddenSharedBeatPlan.segments[0].content = '用户覆盖的共享节拍正文。';
overriddenSharedBeatPlan.segments[0].summary = '用户覆盖的共享节拍摘要。';
overriddenSharedBeatPlan.segments[0].contentOverridden = true;
const reconciledOverriddenSharedBeatPlan = reconcileSequenceSegmentsToShotProvenance!(
  overriddenSharedBeatPlan,
  sharedBeatShots,
  provenanceBeats.slice(0, 2),
  provenanceScenes.slice(0, 1),
);
assert.equal(
  reconciledOverriddenSharedBeatPlan.segments[0].content,
  '用户覆盖的共享节拍正文。',
  'content override must preserve only the user-authored source text',
);
assert.equal(
  reconciledOverriddenSharedBeatPlan.segments[0].summary,
  '用户覆盖的共享节拍摘要。',
  'content override must preserve the user-authored summary',
);
assert.deepEqual(
  reconciledOverriddenSharedBeatPlan.segments.map((item) => item.sourceBeatIds),
  [['beat_1'], ['beat_2']],
  'content override must not relax exact authoritative beat ownership',
);

const unresolvableSharedBeatShots = sharedBeatShots.map((shot, index) => ({
  ...shot,
  id: `unresolvable-shared-shot-${index + 1}`,
  sourceBeatIds: index === 0 ? ['beat_1', 'beat_2'] : ['beat_1'],
}));
const unresolvableSharedBeatPlan = {
  ...structuredClone(sharedBeatPlan),
  segments: sharedBeatPlan.segments.map((item, index) => ({
    ...item,
    sourceShotIds: [unresolvableSharedBeatShots[index].id],
  })),
};
assert.throws(
  () => reconcileSequenceSegmentsToShotProvenance!(
    unresolvableSharedBeatPlan,
    unresolvableSharedBeatShots,
    provenanceBeats.slice(0, 2),
    provenanceScenes.slice(0, 1),
  ),
  /无法按总镜头来源把剧情节拍按顺序唯一分配/u,
  'reconciliation must fail when shared beat candidates have no ordered exact-cover partition',
);

const fewerBeatsThanSegmentsPlan = {
  ...structuredClone(sharedBeatPlan),
  sourceStoryContent: provenanceBeats[0].text,
  segments: sharedBeatPlan.segments.map((item, index) => ({
    ...item,
    sourceShotIds: [`single-beat-shot-${index + 1}`],
    sourceBeatIds: ['beat_1'],
    content: provenanceBeats[0].text,
  })),
};
const fewerBeatsThanSegmentsShots = sharedBeatShots.map((shot, index) => ({
  ...shot,
  id: `single-beat-shot-${index + 1}`,
  sourceBeatIds: ['beat_1'],
}));
assert.throws(
  () => reconcileSequenceSegmentsToShotProvenance!(
    fewerBeatsThanSegmentsPlan,
    fewerBeatsThanSegmentsShots,
    provenanceBeats.slice(0, 1),
    provenanceScenes.slice(0, 1),
  ),
  /剧情节拍数量 1 少于视频段数量 2/u,
  'every non-empty segment requires one uniquely owned source beat',
);

const duplicateCrossSegmentShotPlan = structuredClone(sharedBeatPlan);
duplicateCrossSegmentShotPlan.segments[1].sourceShotIds = ['shared-beat-shot-1'];
assert.throws(
  () => reconcileSequenceSegmentsToShotProvenance!(
    duplicateCrossSegmentShotPlan,
    sharedBeatShots,
    provenanceBeats.slice(0, 2),
    provenanceScenes.slice(0, 1),
  ),
  /总镜头 shared-beat-shot-1 重复归属多个视频段/u,
  'one authoritative master shot cannot belong to two sequence segments',
);

const duplicateWithinSegmentShotPlan: VideoSequencePlan = {
  ...structuredClone(sharedBeatPlan),
  segments: [{
    ...sharedBeatPlan.segments[0],
    globalEndSec: 8,
    durationSec: 8,
    sourceShotIds: ['shared-beat-shot-1', 'shared-beat-shot-1'],
    sourceBeatIds: ['beat_1', 'beat_2'],
    content: provenanceBeats.slice(0, 2).map((beat) => beat.text).join(''),
  }],
};
const reconciledDuplicateWithinSegmentShotPlan = reconcileSequenceSegmentsToShotProvenance!(
  duplicateWithinSegmentShotPlan,
  sharedBeatShots,
  provenanceBeats.slice(0, 2),
  provenanceScenes.slice(0, 1),
);
assert.deepEqual(
  reconciledDuplicateWithinSegmentShotPlan.segments[0].sourceShotIds,
  ['shared-beat-shot-1'],
  'duplicate master-shot IDs inside one segment must be canonicalized once',
);

const emptyLegacyBeatPlan: VideoSequencePlan = {
  ...structuredClone(duplicateWithinSegmentShotPlan),
  segments: [{
    ...duplicateWithinSegmentShotPlan.segments[0],
    sourceShotIds: [],
    sourceBeatIds: [],
  }],
};
assert.throws(
  () => reconcileSequenceSegmentsToShotProvenance!(
    emptyLegacyBeatPlan,
    sharedBeatShots,
    provenanceBeats.slice(0, 2),
    provenanceScenes.slice(0, 1),
  ),
  /无法按总镜头来源把剧情节拍按顺序唯一分配/u,
  'an empty legacy beat allocation without shot provenance must fail instead of preserving stale content',
);
const alignedDialogueSlices = alignedDialogueBoundary.plan.segments.map((item) => (
  sliceMasterShotsForSegment(dialogueBoundaryShots, item)
));
const dialogueTimingErrors = alignedDialogueSlices.flatMap((slice, index) => {
  const durationSec = alignedDialogueBoundary.plan.segments[index].durationSec;
  const finalPrompt = slice.shots.map((shot) => shot.prompt).join('\n');
  return validateStoryboardPrompt({
    durationSec,
    workflow: 'drama',
    inputMode: 'text',
    shots: slice.shots,
    finalPrompt,
    ruleSetId: 'timeline_director_cn',
  }, []).errors.filter((error) => /台词预计需要|本镜只有/u.test(error));
});
assert.deepEqual(dialogueTimingErrors, [], 'aligned segment prompts must keep full dialogue windows instead of failing on clipped fragments');
const clippedBoundaryMasterBoard = {
  id: 'dialogue-boundary-master-board',
  sequencePlanId: dialogueBoundaryPlan.id,
  durationSec: 10,
  sourceStoryContent: dialogueBoundaryPlan.sourceStoryContent,
  finalPrompt: dialogueBoundaryShots.map((shot) => shot.prompt).join('\n'),
  promptTrace: completeAiShotTrace,
  shots: dialogueBoundaryShots,
};
const clippedBoundaryPlanForValidation: VideoSequencePlan = {
  ...dialogueBoundaryPlan,
  // Use a valid full-duration grid here so this assertion continues to test
  // the independent complete-master-shot boundary guard.
  segmentDurationSec: 10,
  masterStoryboardId: clippedBoundaryMasterBoard.id,
  segments: dialogueBoundaryPlan.segments.map((item, index) => ({
    ...item,
    sourceShotIds: index === 0 ? ['dialogue-master-2'] : ['dialogue-master-3'],
  })),
};
assert.ok(
  validateSequencePlan(
    clippedBoundaryPlanForValidation,
    { requireMasterStoryboard: true, storyboards: [clippedBoundaryMasterBoard] },
  ).some((error) => /分段边界.*总镜头|切进.*总镜头/u.test(error)),
  'master-linked validation must reject a segment boundary inside a complete master shot',
);
const realignedDialogueBoundary = autoAlignDialogueBoundaries!(
  alignedDialogueBoundary.plan,
  dialogueBoundaryShots,
);
assert.deepEqual(
  realignedDialogueBoundary.plan,
  alignedDialogueBoundary.plan,
  'master-shot alignment must be idempotent',
);
assert.equal(realignedDialogueBoundary.adjustedBoundaryCount, 0);
assert.deepEqual(realignedDialogueBoundary.extendedSegments, []);

const retryableBoundaryPlan: VideoSequencePlan = {
  ...dialogueBoundaryPlan,
  segments: dialogueBoundaryPlan.segments.map((item, index) => ({
    ...item,
    status: index === 0 ? 'failed' : 'ready',
    storyboardId: `old-board-${index + 1}`,
    failureReason: index === 0 ? '旧的台词时长失败' : undefined,
  })),
};
const repairedRetryableBoundary = autoAlignDialogueBoundaries!(
  retryableBoundaryPlan,
  dialogueBoundaryShots,
);
assert.deepEqual(
  repairedRetryableBoundary.plan.segments.map((item) => item.status),
  ['stale', 'stale'],
  'old generated segments whose ranges move must be queued for regeneration',
);
assert.deepEqual(
  repairedRetryableBoundary.plan.segments.map((item) => item.storyboardId),
  ['old-board-1', 'old-board-2'],
  'old generated boards remain inspectable while stale status prevents their reuse',
);
assert.deepEqual(
  repairedRetryableBoundary.plan.segments.map((item) => item.failureReason),
  [undefined, undefined],
  'automatic repair must clear obsolete dialogue-overflow failures',
);

const finalShotClippedPlan: VideoSequencePlan = {
  ...dialogueBoundaryPlan,
  requestedTotalDurationSec: 9,
  totalDurationSec: 9,
  segmentDurationSec: 8,
  segments: [
    segment(1, { globalStartSec: 0, globalEndSec: 8, durationSec: 8 }),
    segment(2, { globalStartSec: 8, globalEndSec: 9, durationSec: 1 }),
  ],
};
assert.throws(
  () => autoAlignDialogueBoundaries!(finalShotClippedPlan, dialogueBoundaryShots),
  /计划结束时间.*完整总镜头边界|切进.*总镜头/u,
  'automatic alignment must reject a plan ending inside the final authoritative shot',
);
const finalShotClippedMasterBoard = {
  id: 'final-shot-clipped-master-board',
  sequencePlanId: finalShotClippedPlan.id,
  durationSec: 10,
  sourceStoryContent: finalShotClippedPlan.sourceStoryContent,
  finalPrompt: dialogueBoundaryShots.map((shot) => shot.prompt).join('\n'),
  promptTrace: completeAiShotTrace,
  shots: dialogueBoundaryShots,
};
assert.match(
  sequencePlanMasterStoryboardIssue(
    { ...finalShotClippedPlan, masterStoryboardId: finalShotClippedMasterBoard.id },
    [finalShotClippedMasterBoard],
  ) || '',
  /计划结束时间.*完整总镜头边界|切进.*总镜头/u,
  'master preflight must reject a persisted plan whose end truncates an authoritative shot',
);
const completeShotPrefixPlan: VideoSequencePlan = {
  ...finalShotClippedPlan,
  requestedTotalDurationSec: 8,
  totalDurationSec: 8,
  segments: [segment(1, { globalStartSec: 0, globalEndSec: 8, durationSec: 8 })],
};
const completeShotPrefixBoard = {
  ...finalShotClippedMasterBoard,
  sequencePlanId: completeShotPrefixPlan.id,
  sourceStoryContent: completeShotPrefixPlan.sourceStoryContent,
};
assert.equal(
  sequencePlanMasterStoryboardIssue(
    { ...completeShotPrefixPlan, masterStoryboardId: completeShotPrefixBoard.id },
    [completeShotPrefixBoard],
  ),
  undefined,
  'a shorter master prefix remains safe when it ends exactly on a complete shot boundary',
);
assert.deepEqual(
  autoAlignDialogueBoundaries!(completeShotPrefixPlan, dialogueBoundaryShots)
    .plan.segments[0].sourceShotIds,
  ['dialogue-master-2'],
);

const linkOnlyRepairPlan: VideoSequencePlan = {
  ...alignedDialogueBoundary.plan,
  segments: alignedDialogueBoundary.plan.segments.map((item, index) => ({
    ...item,
    status: 'ready',
    storyboardId: `link-only-old-board-${index + 1}`,
    failureReason: '旧结果仍被错误标记为完成',
    sourceShotIds: index === 0 ? ['wrong-master-shot'] : item.sourceShotIds,
  })),
};
const linkOnlyReviewFingerprint = sequencePlanReviewFingerprint(linkOnlyRepairPlan);
const repairedLinkOnlyPlan = autoAlignDialogueBoundaries!(
  linkOnlyRepairPlan,
  dialogueBoundaryShots,
);
assert.equal(repairedLinkOnlyPlan.plan.segments[0].status, 'stale');
assert.equal(repairedLinkOnlyPlan.plan.segments[0].failureReason, undefined);
assert.equal(repairedLinkOnlyPlan.plan.segments[0].storyboardId, 'link-only-old-board-1');
assert.equal(repairedLinkOnlyPlan.plan.segments[1].status, 'ready');
assert.notEqual(
  sequencePlanReviewFingerprint(repairedLinkOnlyPlan.plan),
  linkOnlyReviewFingerprint,
  'authoritative shot ownership must participate in the reviewed plan identity',
);

const lockedBoundaryPlan: VideoSequencePlan = {
  ...dialogueBoundaryPlan,
  segments: dialogueBoundaryPlan.segments.map((item, index) => ({
    ...item,
    locked: index === 0,
  })),
};
assert.throws(
  () => autoAlignDialogueBoundaries!(lockedBoundaryPlan, dialogueBoundaryShots),
  /第 1 段.*锁定.*解锁/u,
  'automatic alignment must not silently invalidate a locked segment result',
);

const validMasterBoard = {
  id: 'master-board-real',
  sequencePlanId: realFourSegmentPlan.id,
  durationSec: 32,
  sourceStoryContent: realFourSegmentPlan.sourceStoryContent,
  finalPrompt: '全片总视频提示词',
  promptTrace: completeAiShotTrace,
  shots: [0, 8, 16, 24].map((startSec, index) => ({
    ...masterShots[0],
    id: `authoritative-shot-${index + 1}`,
    index: index + 1,
    startSec,
    endSec: startSec + 8,
    prompt: `第 ${index + 1} 镜真实提示词`,
  })),
};
assert.throws(
  () => validateMasterTimelineSegmentGrid(
    [
      { ...validMasterBoard.shots[0], startSec: 0, endSec: 10 },
      { ...validMasterBoard.shots[1], startSec: 10, endSec: 20 },
      { ...validMasterBoard.shots[2], startSec: 20, endSec: 30 },
    ],
    30,
    15,
  ),
  /15.*(?:边界|网格)|(?:边界|网格).*15/u,
  'sequence-plan validation must reuse the master timeline grid guard for a crossing master shot',
);
assert.equal(
  sequencePlanMasterStoryboardIssue(
    { ...realFourSegmentPlan, masterStoryboardId: validMasterBoard.id },
    [validMasterBoard],
  ),
  undefined,
  'a complete master timeline must unlock sequence generation',
);
assert.match(
  sequencePlanMasterStoryboardIssue(realFourSegmentPlan, []) || '',
  /总视频提示词缺失/u,
  'a plan without an authoritative master timeline must be blocked',
);
assert.deepEqual(
  validateSequencePlan(
    alignSequenceSegmentsToMasterShotBoundaries(
      { ...realFourSegmentPlan, masterStoryboardId: validMasterBoard.id },
      validMasterBoard.shots,
    ).plan,
    { requireMasterStoryboard: true, storyboards: [validMasterBoard] },
  ),
  [],
  'master timeline validation must pass for contiguous full-duration shots',
);
const duplicateMasterShotPlan = {
  ...structuredClone(realFourSegmentPlan),
  masterStoryboardId: validMasterBoard.id,
};
duplicateMasterShotPlan.segments[0].sourceShotIds = ['authoritative-shot-1', 'authoritative-shot-2'];
duplicateMasterShotPlan.segments[1].sourceShotIds = ['authoritative-shot-2'];
duplicateMasterShotPlan.segments[2].sourceShotIds = ['authoritative-shot-3'];
duplicateMasterShotPlan.segments[3].sourceShotIds = ['authoritative-shot-4'];
assert.ok(
  validateSequencePlan(
    duplicateMasterShotPlan,
    { requireMasterStoryboard: true, storyboards: [validMasterBoard] },
  ).some((error) => /总镜头.*重复归属|重复.*总镜头/u.test(error)),
  'master-linked validation must reject a shot assigned to adjacent segments twice',
);

const emptyDraftPlan: VideoSequencePlan = {
  ...structuredClone(realFourSegmentPlan),
  planningStage: 'master-draft',
  segments: [],
};
assert.deepEqual(
  validateSequencePlan(emptyDraftPlan),
  [],
  'a master draft is valid before video segments are created',
);
const legacyNonGridDraftErrors = validateSequencePlan({
  ...emptyDraftPlan,
  totalDurationSec: 28,
  requestedTotalDurationSec: 28,
  segmentDurationSec: 15,
});
assert.ok(
  legacyNonGridDraftErrors.some((error) => /28.*15.*整数倍|旧计划必须重新生成/u.test(error)),
  'an empty legacy 28/15 draft must be rejected at the confirm/segment boundary instead of silently migrating',
);
const crossingGridMasterBoard = {
  ...validMasterBoard,
  id: 'crossing-grid-master-board',
  durationSec: 30,
  shots: [
    { ...validMasterBoard.shots[0], startSec: 0, endSec: 16 },
    { ...validMasterBoard.shots[1], startSec: 16, endSec: 30 },
  ],
};
const crossingGridDraftErrors = validateSequencePlan(
  {
    ...emptyDraftPlan,
    totalDurationSec: 30,
    requestedTotalDurationSec: 30,
    segmentDurationSec: 15,
    masterStoryboardId: crossingGridMasterBoard.id,
  },
  { requireMasterStoryboard: true, storyboards: [crossingGridMasterBoard] },
);
assert.ok(
  crossingGridDraftErrors.some((error) => /15.*(?:边界|网格)|(?:边界|网格).*15/u.test(error)),
  'an empty master draft must validate its authoritative timeline against every fixed-grid boundary',
);
assert.deepEqual(
  validateSequencePlan(
    { ...emptyDraftPlan, masterStoryboardId: validMasterBoard.id },
    { requireMasterStoryboard: true, storyboards: [validMasterBoard] },
  ),
  [],
  'a master draft with a real master board passes required-master validation',
);
const draftWithoutRequiredMasterErrors = validateSequencePlan(
  emptyDraftPlan,
  { requireMasterStoryboard: true, storyboards: [] },
);
assert.ok(draftWithoutRequiredMasterErrors.some((error) => /总视频提示词缺失/u.test(error)));
assert.ok(!draftWithoutRequiredMasterErrors.some((error) => /至少需要一个视频段/u.test(error)));

const emptyConfirmedPlan: VideoSequencePlan = {
  ...emptyDraftPlan,
  planningStage: 'master-confirmed',
  masterStoryboardId: validMasterBoard.id,
  masterPromptConfirmedAt: 303,
};
emptyConfirmedPlan.masterPromptConfirmedFingerprint = masterPromptConfirmationFingerprint(
  emptyConfirmedPlan,
  validMasterBoard,
);
const emptyConfirmedErrors = validateSequencePlan(
  emptyConfirmedPlan,
  { requireMasterStoryboard: true, storyboards: [validMasterBoard] },
);
assert.deepEqual(emptyConfirmedErrors, []);
assert.ok(!emptyConfirmedErrors.some((error) => /至少需要一个视频段/u.test(error)));

const missingFingerprintErrors = validateSequencePlan({
  ...emptyConfirmedPlan,
  masterPromptConfirmedFingerprint: '   ',
});
assert.ok(missingFingerprintErrors.some((error) => /确认指纹/u.test(error)));
const invalidConfirmedAtErrors = validateSequencePlan({
  ...emptyConfirmedPlan,
  masterPromptConfirmedAt: 0,
});
assert.ok(invalidConfirmedAtErrors.some((error) => /确认时间/u.test(error)));

const staleConfirmedFingerprintErrors = validateSequencePlan(
  {
    ...emptyConfirmedPlan,
    masterPromptConfirmedFingerprint: 'legacy-fixed-fingerprint',
  },
  { storyboards: [validMasterBoard] },
);
assert.ok(
  staleConfirmedFingerprintErrors.some((error) => /确认状态失效|重新确认/u.test(error)),
  'a fixed or stale fingerprint must not validate a confirmed master prompt',
);

assert.equal(
  sequencePlanMasterDirectorSettingsIssue(
    { id: 'plan-director', masterPromptDirectorSettingsFingerprint: '' } as VideoSequencePlan,
    'director-fingerprint-a',
  ),
  '导演参数尚未确认，请先确认导演参数，再生成全片总提示词。',
  'a master prompt must not be treated as ready before director settings are explicitly confirmed',
);
assert.equal(
  sequencePlanMasterDirectorSettingsIssue(
    {
      id: 'plan-director',
      masterPromptDirectorSettingsFingerprint: 'director-fingerprint-a',
    } as VideoSequencePlan,
    'director-fingerprint-a',
  ),
  undefined,
  'a matching confirmed director snapshot must remain valid',
);
assert.equal(
  sequencePlanMasterDirectorSettingsIssue(
    {
      id: 'plan-director',
      masterPromptDirectorSettingsFingerprint: 'director-fingerprint-a',
    } as VideoSequencePlan,
    'director-fingerprint-b',
  ),
  '当前导演参数已变化，请重新生成全片总提示词。',
  'a changed director snapshot must invalidate the master prompt',
);

const ownerlessMasterBoard = { ...validMasterBoard, sequencePlanId: undefined };
const ownerlessConfirmedPlan: VideoSequencePlan = {
  ...emptyConfirmedPlan,
  masterPromptConfirmedFingerprint: masterPromptConfirmationFingerprint(
    emptyConfirmedPlan,
    ownerlessMasterBoard,
  ),
};
const ownerlessConfirmedErrors = validateSequencePlan(
  ownerlessConfirmedPlan,
  { storyboards: [ownerlessMasterBoard] },
);
assert.ok(
  ownerlessConfirmedErrors.some((error) => /归属|确认状态失效|重新确认/u.test(error)),
  'a confirmed master board must explicitly belong to its sequence plan',
);

const emptySegmentedErrors = validateSequencePlan({
  ...emptyDraftPlan,
  planningStage: 'segmented',
});
assert.ok(emptySegmentedErrors.some((error) => /至少需要一个视频段/u.test(error)));

const brokenLegacySegmentPlan = structuredClone(realPlan);
brokenLegacySegmentPlan.segments[0].content = '';
assert.ok(
  validateSequencePlan(brokenLegacySegmentPlan).some((error) => /第 1 段正文不能为空/u.test(error)),
  'a legacy plan with segments must retain the complete segmented validation',
);

const contradictoryDraftErrors = validateSequencePlan({
  ...structuredClone(realPlan),
  planningStage: 'master-draft',
});
assert.ok(
  contradictoryDraftErrors.some((error) => /阶段.*分段.*矛盾|分段.*阶段.*矛盾/u.test(error)),
  'an explicit master draft must report rather than discard its persisted segments',
);
const contradictoryConfirmedPlan: VideoSequencePlan = {
  ...structuredClone(realFourSegmentPlan),
  planningStage: 'master-confirmed',
  masterStoryboardId: validMasterBoard.id,
  masterPromptConfirmedAt: 304,
};
contradictoryConfirmedPlan.masterPromptConfirmedFingerprint = masterPromptConfirmationFingerprint(
  contradictoryConfirmedPlan,
  validMasterBoard,
);
const contradictoryConfirmedErrors = validateSequencePlan(
  contradictoryConfirmedPlan,
  { storyboards: [validMasterBoard] },
);
assert.ok(
  contradictoryConfirmedErrors.some((error) => /阶段.*分段.*矛盾|分段.*阶段.*矛盾/u.test(error)),
  'an explicit confirmed stage must report rather than discard its persisted segments',
);

const masterLinkedPlanInput = structuredClone(realFourSegmentPlan);
masterLinkedPlanInput.masterStoryboardId = ' master-board ';
masterLinkedPlanInput.segments.forEach((item, index) => {
  item.sourceShotIds = [`shot-${index + 1}-1`, ` shot-${index + 1}-2 `];
});
const masterLinkedPlan = validateAndNormalizeSequencePlan(masterLinkedPlanInput);
assert.equal(masterLinkedPlan.masterStoryboardId, 'master-board');
assert.deepEqual(
  masterLinkedPlan.segments.map((item) => item.sourceShotIds),
  [
    ['shot-1-1', 'shot-1-2'],
    ['shot-2-1', 'shot-2-2'],
    ['shot-3-1', 'shot-3-2'],
    ['shot-4-1', 'shot-4-2'],
  ],
);
assert.deepEqual(validateSequencePlan(masterLinkedPlan), []);
const invalidShotIdsPlan = structuredClone(masterLinkedPlanInput);
invalidShotIdsPlan.segments[0].sourceShotIds = ['shot-ok', 7 as unknown as string];
assert.throws(
  () => validateAndNormalizeSequencePlan(invalidShotIdsPlan),
  /sourceShotIds.*字符串数组/u,
);

assert.equal(realPlan.segments.length, 2);
assert.ok(realPlan.segments.every((item) => item.sourceBeatIds.length >= 2));
assert.deepEqual(validateSequencePlan(realPlan), []);

const realSplitSource = realPlan.segments[0];
const realSplit = splitSequenceSegment(realPlan, realSplitSource.id, {
  atSec: 7,
  newSegmentId: 'real-split-tail',
  firstSourceBeatIds: realSplitSource.sourceBeatIds.slice(0, 1),
  secondSourceBeatIds: realSplitSource.sourceBeatIds.slice(1),
});
realSplit.segments.slice(0, 2).forEach((item) => {
  assert.equal(
    item.content,
    item.sourceBeatIds.map((beatId) => realBeatsById.get(beatId)).join(''),
    'split content must be rebuilt at the exact source-beat boundary',
  );
});
assert.ok(
  validateSequencePlan(realSplit).some((error) => /固定分段时长网格/u.test(error)),
  'a beat-level split that creates 7- and 9-second segments must not validate under the fixed 8-second grid',
);

const contentEditedPlan = updateSequenceSegment(realPlan, realPlan.segments[0].id, {
  content: '用户明确覆盖的第一段正文。',
});
assert.equal(contentEditedPlan.segments[0].contentOverridden, true);
assert.deepEqual(
  validateSequencePlan(contentEditedPlan),
  [],
  'an explicit content override remains valid while preserving all source beats',
);

const restorablePlan = validateAndNormalizeSequencePlan({
  ...structuredClone(realFourSegmentPlan),
  segments: realFourSegmentPlan.segments.map((item) => ({ ...structuredClone(item), status: 'ready' })),
});
const restorableInput = structuredClone(restorablePlan);
restorableInput.segments[1].content = '用户覆盖的第二段正文。';
restorableInput.segments[1].contentOverridden = true;
const restorableInputSnapshot = JSON.stringify(restorableInput);
const restoredSourceContent = restoreSequenceSegmentSourceContent(
  restorableInput,
  restorableInput.segments[1].id,
);
assert.equal(
  restoredSourceContent.segments[1].content,
  restoredSourceContent.segments[1].sourceBeatIds.map((beatId) => realBeatsById.get(beatId)).join(''),
  'restoring must rebuild the exact text represented by the segment source beats',
);
assert.equal(restoredSourceContent.segments[1].contentOverridden, undefined);
assert.deepEqual(
  restoredSourceContent.segments.map((item) => item.status),
  ['ready', 'stale', 'stale', 'ready'],
  'restoring content invalidates the target and only its immediate continuity successor',
);
assert.deepEqual(validateSequencePlan(restoredSourceContent), []);
assert.equal(JSON.stringify(restorableInput), restorableInputSnapshot, 'restoring must not mutate the input plan');

const alreadyCanonical = restoreSequenceSegmentSourceContent(
  restorablePlan,
  restorablePlan.segments[1].id,
);
assert.deepEqual(
  alreadyCanonical.segments.map((item) => item.status),
  ['ready', 'ready', 'ready', 'ready'],
  'restoring an already canonical segment is a status-preserving no-op',
);

const overriddenLast = structuredClone(restorablePlan);
overriddenLast.segments[3].content = '用户覆盖的最后一段。';
overriddenLast.segments[3].contentOverridden = true;
const restoredLast = restoreSequenceSegmentSourceContent(overriddenLast, overriddenLast.segments[3].id);
assert.deepEqual(restoredLast.segments.map((item) => item.status), ['ready', 'ready', 'ready', 'stale']);

const unknownRestoreBeat = structuredClone(restorablePlan);
unknownRestoreBeat.segments[1].sourceBeatIds = ['beat_unknown_for_restore'];
assert.throws(
  () => restoreSequenceSegmentSourceContent(unknownRestoreBeat, unknownRestoreBeat.segments[1].id),
  /第 2 段.*未知剧情节拍.*beat_unknown_for_restore.*原剧情恢复正文/u,
);

const realReorderedPlan = reorderSequenceSegment(realPlan, realPlan.segments[0].id, 2);
assert.equal(realReorderedPlan.segmentOrderOverridden, true);
assert.deepEqual(
  validateSequencePlan(realReorderedPlan),
  [],
  'an explicit whole-segment reorder remains valid while preserving beat coverage',
);
const reorderedWithBrokenBeat = structuredClone(realReorderedPlan);
reorderedWithBrokenBeat.segments[0].sourceBeatIds.reverse();
assert.ok(
  validateSequencePlan(reorderedWithBrokenBeat).some((error) => /内部剧情节拍不连续/u.test(error)),
  'reorder metadata must not permit a reversed or discontinuous range inside one segment',
);

const firstBoardLinked = linkSegmentStoryboard(realPlan, realPlan.segments[0].id, 'shared-board');
assert.throws(
  () => linkSegmentStoryboard(firstBoardLinked, realPlan.segments[1].id, 'shared-board'),
  /shared-board.*第 1 段.*占用/u,
);

const inheritedPatch = Object.create({ summary: '原型链污染摘要' }) as Parameters<typeof updateSequenceSegment>[2];
const inheritedIgnored = updateSequenceSegment(realPlan, realPlan.segments[0].id, inheritedPatch);
assert.equal(inheritedIgnored.segments[0].summary, realPlan.segments[0].summary);
assert.equal(inheritedIgnored.segments[0].status, realPlan.segments[0].status);
const inheritedBoundaryPatch = Object.assign(
  Object.create({ entryState: '原型链污染交接状态' }),
  { summary: '合法自有摘要更新' },
) as Parameters<typeof updateSequenceSegment>[2];
const inheritedBoundaryIgnored = updateSequenceSegment(
  realPlan,
  realPlan.segments[1].id,
  inheritedBoundaryPatch,
);
assert.equal(
  inheritedBoundaryIgnored.segments[0].exitState,
  realPlan.segments[0].exitState,
  'an inherited entryState must not alter the preceding boundary',
);
assert.throws(
  () => updateSequenceSegment(
    realPlan,
    realPlan.segments[0].id,
    { summary: 123 } as unknown as Parameters<typeof updateSequenceSegment>[2],
  ),
  /summary.*字符串/u,
);
for (const invalidDuration of ['8', Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
  assert.throws(
    () => updateSequenceSegment(
      realPlan,
      realPlan.segments[0].id,
      { durationSec: invalidDuration } as unknown as Parameters<typeof updateSequenceSegment>[2],
    ),
    /durationSec.*大于 0.*有限数字/u,
  );
}
const roundedDurationNoop = updateSequenceSegment(realPlan, realPlan.segments[0].id, { durationSec: 8.004 });
assert.equal(roundedDurationNoop.segments[0].durationSec, 8);
assert.equal(
  roundedDurationNoop.segments[0].status,
  realPlan.segments[0].status,
  'a duration that rounds to the existing value must not mark continuity stale',
);

const malformedBeatArray = structuredClone(realPlan) as unknown as VideoSequencePlan;
(malformedBeatArray.segments[1] as unknown as { sourceBeatIds: unknown }).sourceBeatIds = null;
assert.throws(
  () => validateAndNormalizeSequencePlan(malformedBeatArray),
  /第 2 段.*sourceBeatIds.*字符串数组/u,
);
const malformedSceneArray = structuredClone(realPlan) as unknown as VideoSequencePlan;
(malformedSceneArray.segments[0] as unknown as { sourceSceneIds: unknown }).sourceSceneIds = 'scene-real';
assert.throws(
  () => validateAndNormalizeSequencePlan(malformedSceneArray),
  /第 1 段.*sourceSceneIds.*字符串数组/u,
);

const changed = updateSequenceSegment(original, 'segment-2', { summary: '新摘要' });
assert.equal(changed.segments[1].summary, '新摘要');
assert.equal(changed.segments[0].status, 'ready');
assert.deepEqual(changed.segments.slice(1).map((item) => item.status), ['stale', 'stale']);
assert.equal(changed.segments[1].storyboardId, 'board-2', 'stale boards remain inspectable');
assert.equal(JSON.stringify(original), originalSnapshot, 'editing must not mutate the input plan');
assert.notStrictEqual(changed, original);
assert.notStrictEqual(changed.segments, original.segments);
assert.notStrictEqual(changed.segments[0], original.segments[0]);
assert.throws(
  () => updateSequenceSegment(original, 'missing', { summary: '无效' }),
  /找不到.*missing/u,
);

const fourSegmentPlan = freezeDeep(makeFourSegmentPlan());
assert.throws(
  () => updateSequenceSegment(
    fourSegmentPlan,
    'segment-2',
    { sourceBeatIds: ['beat-2-a'] } as unknown as Parameters<typeof updateSequenceSegment>[2],
  ),
  /剧情节拍边界.*拆分或合并/u,
  'ordinary patches must not delete or introduce source beats',
);
assert.throws(
  () => updateSequenceSegment(
    fourSegmentPlan,
    'segment-2',
    { id: 'replacement-id' } as unknown as Parameters<typeof updateSequenceSegment>[2],
  ),
  /结构字段.*id/u,
  'identity and computed fields must only change through structural helpers',
);
const scopedUpdate = updateSequenceSegment(fourSegmentPlan, 'segment-2', { summary: '仅影响相邻连续性' });
assert.deepEqual(
  scopedUpdate.segments.map((item) => item.status),
  ['ready', 'stale', 'stale', 'ready'],
  'ordinary edits must not invalidate segments beyond the immediate next segment',
);

const durationChanged = updateSequenceSegment(original, 'segment-2', {
  durationSec: 6,
  exitState: '新的中段交接',
});
assert.deepEqual(
  durationChanged.segments.map((item) => [item.index, item.globalStartSec, item.globalEndSec]),
  [[1, 0, 8], [2, 8, 14], [3, 14, 22]],
);
assert.equal(durationChanged.totalDurationSec, 22);
assert.equal(
  durationChanged.requestedTotalDurationSec,
  22,
  'an explicit segment-duration edit must keep requested and computed totals aligned',
);
assert.equal(durationChanged.segments[2].entryState, '新的中段交接');

const locked = lockSequenceSegment(original, 'segment-2', true);
assert.equal(locked.segments[1].locked, true);
assert.equal(locked.segments[1].status, 'ready', 'locking alone does not invalidate a board');
const generatingPlan = structuredClone(original);
generatingPlan.segments[1].status = 'generating';
const lockedWhileGenerating = lockSequenceSegment(generatingPlan, 'segment-2', true);
assert.equal(
  lockedWhileGenerating.segments[1].status,
  'stale',
  'locking an in-flight segment must prevent a late generation commit from leaving it generating',
);
const explicitlyEditedLocked = updateSequenceSegment(locked, 'segment-2', { content: '用户主动修改锁定段' });
assert.equal(explicitlyEditedLocked.segments[1].locked, true);
assert.equal(explicitlyEditedLocked.segments[1].status, 'stale');
const unlocked = lockSequenceSegment(locked, 'segment-2', false);
assert.equal(unlocked.segments[1].locked, false);

const split = splitSequenceSegment(realPlan, realPlan.segments[0].id, {
  atSec: 3,
  handoffState: '拆分交接状态',
  newSegmentId: 'real-segment-1b',
});
assert.deepEqual(split.segments.map((item) => item.id), [realPlan.segments[0].id, 'real-segment-1b', realPlan.segments[1].id]);
assert.deepEqual(split.segments.map((item) => item.durationSec), [3, 5, 8]);
assert.deepEqual(split.segments.map((item) => item.index), [1, 2, 3]);
assert.deepEqual(split.segments.map((item) => item.globalStartSec), [0, 3, 8]);
assert.deepEqual(split.segments.map((item) => item.globalEndSec), [3, 8, 16]);
assert.equal(split.segments[0].exitState, '拆分交接状态');
assert.equal(split.segments[1].entryState, '拆分交接状态');
assert.equal(split.segments[1].storyboardId, undefined);
assert.deepEqual(split.segments.map((item) => item.status), ['stale', 'stale', 'stale']);
assert.equal(split.totalDurationSec, 16);
assert.equal(JSON.stringify(realPlan), realPlanSnapshot, 'splitting must not mutate the input plan');
assert.throws(() => splitSequenceSegment(realPlan, realPlan.segments[0].id, 0), /拆分时间/u);
assert.throws(
  () => splitSequenceSegment(realPlan, realPlan.segments[0].id, {
    firstSourceBeatIds: [realPlan.segments[0].sourceBeatIds[0]],
    secondSourceBeatIds: [realPlan.segments[0].sourceBeatIds[0]],
  }),
  /节拍.*恰好一次/u,
);

const scopedSplit = splitSequenceSegment(realFourSegmentPlan, realFourSegmentPlan.segments[1].id, {
  atSec: 4,
  newSegmentId: 'real-segment-2-split-scope',
});
assert.deepEqual(
  scopedSplit.segments.map((item) => item.status),
  ['planned', 'stale', 'stale', 'stale', 'planned'],
  'split invalidates both split results and only their immediate following segment',
);

const mergeable = validateAndNormalizeSequencePlan({
  ...makePlan(),
  segmentDurationSec: 8,
  segments: [
    segment(1, { durationSec: 4, globalEndSec: 4, sourceBeatIds: ['beat-a'] }),
    segment(2, {
      durationSec: 4,
      globalStartSec: 4,
      globalEndSec: 8,
      sourceBeatIds: ['beat-b'],
      locked: true,
    }),
    segment(3, {
      globalStartSec: 8,
      globalEndSec: 16,
      sourceBeatIds: ['beat-c'],
    }),
  ],
});
const merged = mergeSequenceSegments(mergeable, 'segment-1', 'segment-2');
assert.equal(merged.segments.length, 2);
assert.equal(merged.segments[0].durationSec, 8);
assert.deepEqual(merged.segments[0].sourceBeatIds, ['beat-a', 'beat-b']);
assert.equal(merged.segments[0].entryState, '初始状态');
assert.equal(merged.segments[0].exitState, '交接2');
assert.equal(merged.segments[0].storyboardId, undefined);
assert.equal(merged.segments[0].locked, true, 'a merge preserves protection from either locked source');
assert.deepEqual(merged.segments.map((item) => item.status), ['stale', 'stale']);
assert.equal(merged.totalDurationSec, 16);
assert.throws(
  () => mergeSequenceSegments(original, 'segment-1', 'segment-2'),
  /超过单段生成硬上限.*15/u,
  'a soft target must never let a manual merge exceed the 15-second model limit',
);
const hardLimitMergePlan = validateAndNormalizeSequencePlan({
  ...makePlan(),
  segments: [
    segment(1, { durationSec: 8, sourceBeatIds: ['beat-hard-a'] }),
    segment(2, { durationSec: 8, sourceBeatIds: ['beat-hard-b'] }),
    segment(3, { durationSec: 8, sourceBeatIds: ['beat-hard-c'] }),
  ],
});
assert.throws(
  () => mergeSequenceSegments(hardLimitMergePlan, 'segment-1', 'segment-2'),
  /超过单段生成硬上限.*15/u,
);
assert.throws(() => mergeSequenceSegments(original, 'segment-1', 'segment-3'), /相邻/u);

const fourShortSegments = validateAndNormalizeSequencePlan(makeFourSegmentPlan(4));
const scopedMerge = mergeSequenceSegments(fourShortSegments, 'segment-1', 'segment-2');
assert.deepEqual(
  scopedMerge.segments.map((item) => item.status),
  ['stale', 'stale', 'ready'],
  'merge invalidates the merged segment and only its immediate following segment',
);

const reordered = reorderSequenceSegment(original, 'segment-2', 1);
assert.deepEqual(reordered.segments.map((item) => item.id), ['segment-2', 'segment-1', 'segment-3']);
assert.deepEqual(reordered.segments.map((item) => item.index), [1, 2, 3]);
assert.deepEqual(reordered.segments.map((item) => item.globalStartSec), [0, 8, 16]);
assert.equal(reordered.segments[0].entryState, '初始状态');
assert.equal(reordered.segments[1].entryState, reordered.segments[0].exitState);
assert.equal(reordered.segments[2].entryState, reordered.segments[1].exitState);
assert.deepEqual(reordered.segments.map((item) => item.status), ['stale', 'stale', 'stale']);
assert.throws(() => reorderSequenceSegment(original, 'segment-2', 0), /目标序号/u);
const sameOrder = reorderSequenceSegment(original, 'segment-2', 2);
assert.deepEqual(sameOrder.segments.map((item) => item.status), ['ready', 'ready', 'ready']);

const linked = linkSegmentStoryboard(changed, 'segment-1', 'board-new');
assert.equal(linked.segments[0].storyboardId, 'board-new');
assert.equal(linked.segments[0].status, 'ready');
assert.equal(linked.segments[1].status, 'stale');
assert.throws(() => linkSegmentStoryboard(original, 'segment-1', '  '), /Storyboard ID/u);

const malformedTiming = makePlan();
malformedTiming.totalDurationSec = 999;
malformedTiming.segments[0].index = 9;
malformedTiming.segments[0].globalStartSec = 99;
malformedTiming.segments[0].globalEndSec = 199;
malformedTiming.segments[1].entryState = '不连续的旧值';
const normalized = validateAndNormalizeSequencePlan(malformedTiming);
assert.deepEqual(
  normalized.segments.map((item) => [item.index, item.globalStartSec, item.globalEndSec]),
  [[1, 0, 8], [2, 8, 16], [3, 16, 24]],
);
assert.equal(normalized.totalDurationSec, 24);
assert.equal(normalized.segments[1].entryState, normalized.segments[0].exitState);
assert.equal(malformedTiming.segments[0].index, 9, 'normalization must not mutate the source');
assert.throws(
  () => validateAndNormalizeSequencePlan({ ...makePlan(), segments: [] }),
  /至少包含一个视频段/u,
);
assert.throws(
  () => validateAndNormalizeSequencePlan({
    ...makePlan(),
    segments: [segment(1), segment(2, { id: 'segment-1' })],
  }),
  /重复的视频段 ID/u,
);
assert.throws(
  () => validateAndNormalizeSequencePlan({
    ...makePlan(),
    segments: [segment(1), segment(2, { sourceBeatIds: ['beat-1-a'] })],
  }),
  /重复的剧情节拍/u,
);
assert.throws(
  () => validateAndNormalizeSequencePlan({
    ...makePlan(),
    segments: [segment(1, { durationSec: 15.01 })],
  }),
  /超过单段生成硬上限.*15/u,
);

assert.equal(sequencePlanSourceChanged(original, '完整原始剧情'), false);
assert.equal(sequencePlanSourceChanged(original, '已修改的剧情'), true);
assert.equal(sequencePlanSourceChanged(original, {
  title: '门后怪兽',
  content: '完整原始剧情',
}), false);
assert.equal(sequencePlanSourceChanged(original, {
  title: '新标题',
  content: '完整原始剧情',
}), true);
assert.equal(sequencePlanSourceChanged(original, '门后怪兽', '完整原始剧情'), false);

const semanticShot = (
  id: string,
  index: number,
  startSec: number,
  endSec: number,
  action: string,
): VideoShot => ({
  id,
  index,
  startSec,
  endSec,
  purpose: '推进剧情',
  subject: '林岚',
  action,
  camera: '稳定跟拍',
  transition: '动作切换',
  lighting: '自然光',
  sound: '环境声',
  result: '动作结果可见',
  referenceAssetIds: [],
  prompt: `【${startSec}s-${endSec}s】 林岚${action}`,
  locked: false,
});

const semanticValidationPlan = (
  id: string,
  shotsBySegment: string[][],
): VideoSequencePlan => ({
  ...structuredClone(realPlan),
  id,
  planningStage: 'segmented',
  masterStoryboardId: `${id}-master`,
  segments: realPlan.segments.map((item, index) => ({
    ...structuredClone(item),
    sourceShotIds: shotsBySegment[index],
  })),
});

const withinSegmentPlan = semanticValidationPlan(
  'semantic-within-plan',
  [['semantic-within-1', 'semantic-within-2'], ['semantic-within-3']],
);
const withinSegmentErrors = validateSequencePlan(withinSegmentPlan, {
  requireMasterStoryboard: true,
  storyboards: [{
    id: withinSegmentPlan.masterStoryboardId!,
    sequencePlanId: withinSegmentPlan.id,
    durationSec: 16,
    sourceStoryContent: realStory,
    finalPrompt: '完整总提示词',
    promptTrace: completeAiShotTrace,
    shots: [
      semanticShot('semantic-within-1', 1, 0, 4, '林岚推开木门'),
      semanticShot('semantic-within-2', 2, 4, 8, '林岚伸手把门推开'),
      semanticShot('semantic-within-3', 3, 8, 16, '林岚走进房间'),
    ],
  }],
});
assert.equal(
  withinSegmentErrors.some((error) => /第 1 段.*语义重复/u.test(error)),
  false,
  'legacy and manual plans must not be rejected by local synonymous-action heuristics',
);

const distinctArrowTargetPlan = semanticValidationPlan(
  'semantic-distinct-arrow-target-plan',
  [['semantic-distinct-target-1', 'semantic-distinct-target-2'], ['semantic-distinct-target-3']],
);
const distinctArrowTargetErrors = validateSequencePlan(distinctArrowTargetPlan, {
  requireMasterStoryboard: true,
  storyboards: [{
    id: distinctArrowTargetPlan.masterStoryboardId!,
    sequencePlanId: distinctArrowTargetPlan.id,
    durationSec: 16,
    sourceStoryContent: realStory,
    finalPrompt: '完整总提示词',
    promptTrace: completeAiShotTrace,
    shots: [
      semanticShot('semantic-distinct-target-1', 1, 0, 4, '一部分涌向了那些住在墙壁里的人'),
      semanticShot(
        'semantic-distinct-target-2',
        2,
        4,
        8,
        '一部分涌向了→母巢→身边并没有留下太多保护它的力量',
      ),
      semanticShot('semantic-distinct-target-3', 3, 8, 16, '守卫关闭城门'),
    ],
  }],
});
assert.equal(
  distinctArrowTargetErrors.some((error) => /语义重复/u.test(error)),
  false,
  'segmentation validation must accept adjacent movement shots whose arrow-split targets are different',
);

const crossSegmentPlan = semanticValidationPlan(
  'semantic-cross-plan',
  [['semantic-cross-1'], ['semantic-cross-2']],
);
const crossSegmentErrors = validateSequencePlan(crossSegmentPlan, {
  requireMasterStoryboard: true,
  storyboards: [{
    id: crossSegmentPlan.masterStoryboardId!,
    sequencePlanId: crossSegmentPlan.id,
    durationSec: 16,
    sourceStoryContent: realStory,
    finalPrompt: '完整总提示词',
    promptTrace: completeAiShotTrace,
    shots: [
      semanticShot('semantic-cross-1', 1, 0, 8, '林岚推开木门'),
      semanticShot('semantic-cross-2', 2, 8, 16, '林岚伸手把门推开'),
    ],
  }],
});
assert.equal(
  crossSegmentErrors.some((error) => /第 1 段.*第 2 段.*跨段.*语义重复/u.test(error)),
  false,
  'cross-segment action meaning is AI-owned for legacy and manual plans as well',
);

const legalHandoffPlan = semanticValidationPlan(
  'semantic-handoff-plan',
  [['semantic-handoff-1'], ['semantic-handoff-2']],
);
legalHandoffPlan.segments[0].exitState = '林岚站在门内，右手仍扶着门。';
legalHandoffPlan.segments[1].entryState = legalHandoffPlan.segments[0].exitState;
const legalHandoffErrors = validateSequencePlan(legalHandoffPlan, {
  requireMasterStoryboard: true,
  storyboards: [{
    id: legalHandoffPlan.masterStoryboardId!,
    sequencePlanId: legalHandoffPlan.id,
    durationSec: 16,
    sourceStoryContent: realStory,
    finalPrompt: '完整总提示词',
    promptTrace: completeAiShotTrace,
    shots: [
      semanticShot('semantic-handoff-1', 1, 0, 8, '林岚推开木门'),
      semanticShot('semantic-handoff-2', 2, 8, 16, '林岚走进房间'),
    ],
  }],
});
assert.equal(
  legalHandoffErrors.some((error) => /语义重复/u.test(error)),
  false,
  'a repeated entry/exit continuity state is a legal handoff and must not be treated as a repeated shot action',
);

const materializedAiPlan = materializeAiSequenceSegments(
  aiMaterializerBasePlan,
  aiMaterializerMasterShots,
  [
    aiMaterializerDraft(['ai-master-1', 'ai-master-2'], ['beat_1', 'beat_2'], 1),
    aiMaterializerDraft(['ai-master-3'], ['beat_3'], 2),
  ],
  aiMaterializerBeats,
  [],
);
assert.deepEqual(
  materializedAiPlan.segments.map((item) => item.sourceShotIds),
  [['ai-master-1', 'ai-master-2'], ['ai-master-3']],
  'AI materialization must preserve the exact complete master-shot groups',
);
assert.deepEqual(
  materializedAiPlan.segments.map((item) => [item.globalStartSec, item.globalEndSec, item.durationSec]),
  [[0, 10, 10], [10, 15, 5]],
  'segment timing must be resolved from authoritative shot boundaries',
);
assert.deepEqual(
  materializedAiPlan.segments.map((item) => item.content),
  [aiMaterializerBeats[0].text + aiMaterializerBeats[1].text, aiMaterializerBeats[2].text],
);
assert.equal(materializedAiPlan.segmentationSource, 'ai');
assertAiSequenceSegmentShotCoverage(materializedAiPlan, aiMaterializerMasterShots);

const aiSharedBeatMasterShots = aiMaterializerMasterShots.map((shot, index) => (
  index === 1
    ? {
      ...shot,
      sourceBeatIds: [aiMaterializerBeats[0].id, aiMaterializerBeats[1].id],
      sourceStart: aiMaterializerBeats[0].sourceStart,
      sourceEnd: aiMaterializerBeats[1].sourceEnd,
    }
    : shot
));
const sharedBeatMaterializedPlan = materializeAiSequenceSegments(
  aiMaterializerBasePlan,
  aiSharedBeatMasterShots,
  [
    aiMaterializerDraft(['ai-master-1', 'ai-master-2'], ['beat_1', 'beat_2'], 1),
    aiMaterializerDraft(['ai-master-3'], ['beat_3'], 2),
  ],
  aiMaterializerBeats,
  [],
);
assert.deepEqual(
  sharedBeatMaterializedPlan.segments[0].sourceBeatIds,
  ['beat_1', 'beat_2'],
  'a beat may be referenced by multiple shots in one AI segment when the segment-level ownership is consistent',
);

const continuationStory = '守门人推开舱门。';
const continuationBeats = extractStoryBeats(continuationStory);
const continuationShots: VideoShot[] = [0, 1].map((index) => ({
  ...aiMaterializerMasterShots[index],
  id: `continuation-shot-${index + 1}`,
  startSec: index * 8,
  endSec: (index + 1) * 8,
  sourceBeatIds: ['beat_1'],
  sourceStart: 0,
  sourceEnd: continuationStory.length,
}));
const continuationBase: VideoSequencePlan = {
  ...aiMaterializerBasePlan,
  sourceStoryContent: continuationStory,
  sourceContentHash: sourceContentHash(continuationStory),
  totalDurationSec: 16,
  requestedTotalDurationSec: 16,
  segmentDurationSec: 8,
  masterStoryboardId: 'continuation-master',
};
const continuationDrafts = [
  aiMaterializerDraft(['continuation-shot-1'], ['beat_1'], 1),
  aiMaterializerDraft(['continuation-shot-2'], ['beat_1'], 2),
];
const continuationPlan = materializeAiSequenceSegments(
  continuationBase,
  continuationShots,
  continuationDrafts,
  continuationBeats,
);
assert.deepEqual(
  continuationPlan.segments.map((item) => [item.globalStartSec, item.globalEndSec, item.durationSec]),
  [[0, 8, 8], [8, 16, 8]],
  'one source beat may continue across two complete eight-second shots without changing their timing',
);
assert.deepEqual(
  continuationPlan.segments.map((item) => item.content),
  [continuationStory, continuationStory],
  'shared provenance must retain the original source reference text rather than deleting plot from either shot group',
);
const reconciledContinuation = sequencePlanModule.reconcileSequenceSegmentsToShotProvenance(
  continuationPlan,
  continuationShots,
  continuationBeats,
  [],
  { preserveAiMetadata: true },
);
assert.deepEqual(reconciledContinuation.segments, continuationPlan.segments);
assertAiSequenceSegmentShotCoverage(reconciledContinuation, continuationShots);
assert.deepEqual(
  validateAndNormalizeSequencePlan(reconciledContinuation).segments,
  reconciledContinuation.segments,
  'normalizing a persisted AI shot-backed plan must retain shared beat references',
);
assert.deepEqual(
  validateSequencePlan(reconciledContinuation, {
    requireMasterStoryboard: true,
    storyboards: [{
      id: 'continuation-master',
      sequencePlanId: continuationBase.id,
      sourceStoryContent: continuationStory,
      durationSec: 16,
      shots: continuationShots,
      finalPrompt: '完整的两个八秒镜头',
      promptTrace: completeAiShotTrace,
    }],
  }),
  [],
  'AI materialization, reconciliation and final master-backed validation must agree on a shared source beat',
);
assert.throws(
  () => validateAndNormalizeSequencePlan({ ...continuationPlan, segmentationSource: 'local' }),
  /重复的剧情节拍/u,
  'legacy plans must still own each source beat exactly once',
);
assert.throws(
  () => validateAndNormalizeSequencePlan({
    ...continuationPlan,
    segments: continuationPlan.segments.map((item) => ({ ...item, sourceShotIds: undefined })),
  }),
  /重复的剧情节拍/u,
  'the AI marker alone must not authorize overlapping beats without complete shot links',
);
assert.throws(
  () => validateAndNormalizeSequencePlan({
    ...continuationPlan,
    segments: continuationPlan.segments.map((item) => ({ ...item, sourceShotIds: ['continuation-shot-1'] })),
  }),
  /重复.*总镜头|总镜头.*重复|重复的剧情节拍/u,
  'normalization must not excuse duplicated shots as shared source references',
);
assert.throws(
  () => materializeAiSequenceSegments(
    continuationBase,
    continuationShots.map((shot, index) => index === 1 ? { ...shot, sourceBeatIds: [] } : shot),
    continuationDrafts,
    continuationBeats,
  ),
  /重复归属|来源/u,
  'every occurrence of a shared beat needs real shot provenance',
);
assert.throws(
  () => sequencePlanModule.reconcileSequenceSegmentsToShotProvenance(
    continuationPlan,
    continuationShots.map((shot, index) => index === 0
      ? { ...shot, sourceBeatIds: [], sourceStart: undefined, sourceEnd: undefined }
      : shot),
    continuationBeats,
    [],
    { preserveAiMetadata: true },
  ),
  /重复归属|来源/u,
  'later proven references cannot legitimize an earlier shared beat without shot provenance',
);
assert.throws(
  () => sequencePlanModule.reconcileSequenceSegmentsToShotProvenance(
    {
      ...continuationPlan,
      segments: continuationPlan.segments.map((item) => ({ ...item, sourceShotIds: ['continuation-shot-1'] })),
    },
    continuationShots,
    continuationBeats,
    [],
    { preserveAiMetadata: true },
  ),
  /总镜头.*重复|重复.*总镜头/u,
  'AI reconciliation must keep whole-shot ownership unique when beat references overlap',
);

const overlappingBeatShots = [
  { ...continuationShots[0], sourceBeatIds: ['beat_1', 'beat_2'], sourceStart: 0, sourceEnd: aiMaterializerBeats[1].sourceEnd },
  { ...continuationShots[1], sourceBeatIds: ['beat_2', 'beat_3'], sourceStart: aiMaterializerBeats[1].sourceStart, sourceEnd: aiMaterializerBeats[2].sourceEnd },
];
const overlappingBeatPlan = materializeAiSequenceSegments(
  { ...continuationBase, sourceStoryContent: aiMaterializerStory, sourceContentHash: sourceContentHash(aiMaterializerStory) },
  overlappingBeatShots,
  [
    aiMaterializerDraft(['continuation-shot-1'], ['beat_1', 'beat_2'], 1),
    aiMaterializerDraft(['continuation-shot-2'], ['beat_2', 'beat_3'], 2),
  ],
  aiMaterializerBeats,
);
assert.deepEqual(
  sequencePlanModule.reconcileSequenceSegmentsToShotProvenance(
    overlappingBeatPlan, overlappingBeatShots, aiMaterializerBeats, [], { preserveAiMetadata: true },
  ).segments.map((item) => item.sourceBeatIds),
  [['beat_1', 'beat_2'], ['beat_2', 'beat_3']],
  'a boundary beat may be the end of one shot group and the beginning of the next',
);

assert.throws(
  () => materializeAiSequenceSegments(
    aiMaterializerBasePlan,
    aiMaterializerMasterShots,
    [
      aiMaterializerDraft(['ai-master-1', 'ai-master-2'], ['beat_1'], 1),
      aiMaterializerDraft(['ai-master-3'], ['beat_3'], 2),
    ],
    aiMaterializerBeats,
  ),
  /sourceBeatIds 与所选总镜头的剧情来源不一致/u,
  'AI beat declarations must not silently diverge from the selected master-shot provenance',
);

assert.throws(
  () => materializeAiSequenceSegments(
    aiMaterializerBasePlan,
    aiMaterializerMasterShots,
    [
      aiMaterializerDraft(['ai-master-1', 'ai-master-1'], ['beat_1'], 1),
      aiMaterializerDraft(['ai-master-3'], ['beat_3'], 2),
    ],
    aiMaterializerBeats,
  ),
  /(?:重复归属总镜头|范围不连续|遗漏总镜头)/u,
  'duplicate/omitted master shots must fail instead of being repaired locally',
);

assert.throws(
  () => materializeAiSequenceSegments(
    aiMaterializerBasePlan,
    aiMaterializerMasterShots,
    [
      aiMaterializerDraft(['ai-master-1', 'ai-master-3'], ['beat_1', 'beat_3'], 1),
      aiMaterializerDraft(['ai-master-2'], ['beat_2'], 2),
    ],
    aiMaterializerBeats,
  ),
  /(?:范围不连续|没有从下一个连续总镜头开始)/u,
  'AI boundaries must remain contiguous in master-shot order',
);

console.log('sequence plan editing regression checks passed');
